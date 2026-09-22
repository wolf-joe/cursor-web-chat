import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Cursor, type SDKModel } from "@cursor/sdk";
import { loadModelsConfig, modelSupportsVision, type ModelSelectionConfig } from "./config.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 账号下全量模型目录(含每个模型的 id/parameters/variants)落一份盘,除了供人工查阅
// (调整 config.json 的 models.allowed 时翻这个文件找 id),启动时也读它垫底,
// 见下面 决策·startup-cache。不提交进 git(见 .gitignore)。
const CATALOG_CACHE_PATH = path.join(__dirname, "..", "models-catalog.json");

// 决策·catalog-swr: Cursor.models.list() 可达数秒,不能绑在每次 /api/models 上。
// 有垫底就立刻返回;超过 TTL 才在后台再拉一次,成功后原地升级内存和磁盘。
// 失败保留旧缓存。有缓存时失败后短冷却再试,避免目录接口持续失败时每个页面打开都打穿。
const CATALOG_TTL_MS = 30 * 60 * 1000;
const CATALOG_RETRY_COOLDOWN_MS = 60 * 1000;

// 决策·startup-cache: 进程启动先同步读盘垫一份上次成功的目录,网络落地前的请求
// 直接吃这份(哪怕略旧)。只有从没成功抓过且无缓存文件时才阻塞等网络。
let catalogFetchedAt = 0;
let lastFetchStartedAt = 0;
let inFlight: Promise<SDKModel[]> | undefined;
let latestModels: SDKModel[] | undefined = readCachedCatalogSync();

function readCachedCatalogSync(): SDKModel[] | undefined {
  try {
    const models = JSON.parse(readFileSync(CATALOG_CACHE_PATH, "utf-8"));
    if (!Array.isArray(models)) return undefined;
    catalogFetchedAt = statSync(CATALOG_CACHE_PATH).mtimeMs;
    return models;
  } catch {
    return undefined;
  }
}

function catalogIsStale(): boolean {
  return Date.now() - catalogFetchedAt >= CATALOG_TTL_MS;
}

function fetchAllModels(): Promise<SDKModel[]> {
  if (!inFlight) {
    lastFetchStartedAt = Date.now();
    inFlight = Cursor.models.list()
      .then((models) => {
        latestModels = models;
        catalogFetchedAt = Date.now();
        writeFile(CATALOG_CACHE_PATH, `${JSON.stringify(models, null, 2)}\n`, "utf-8").catch((err) => {
          log.error("写 models-catalog.json 失败(不影响正常功能)", err);
        });
        return models;
      })
      .catch((err) => {
        log.error("拉取模型目录失败", err);
        throw err;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

function revalidateCatalogIfStale(): void {
  if (latestModels && !catalogIsStale()) return;
  if (inFlight) return;
  if (latestModels && Date.now() - lastFetchStartedAt < CATALOG_RETRY_COOLDOWN_MS) return;
  fetchAllModels().catch(() => {});
}

// 启动即按 SWR 判断要不要打网络,不等第一个 /api/models。
revalidateCatalogIfStale();

export type AllowedModel = SDKModel & {
  // 决策·vision-allowlist: 前后端共用,前端据此启停加号/粘贴。
  supportsVision: boolean;
};

export interface AllowedModelsResult {
  // 有 allowed 时是置顶「常用」;省略或空白名单时是账号全量(保持 list 顺序)。
  models: AllowedModel[];
  // 决策·models-pin-and-more: 目录里不在 allowed 中的其余模型;无白名单时为空。
  more: AllowedModel[];
  default: ModelSelectionConfig;
}

function withVision(m: SDKModel): AllowedModel {
  return { ...m, supportsVision: modelSupportsVision(m.id) };
}

export async function listAllowedModels(): Promise<AllowedModelsResult> {
  revalidateCatalogIfStale();
  const { allowed, default: defaultModel } = loadModelsConfig();
  const all = latestModels ?? (await fetchAllModels());
  const byId = new Map(all.map((m) => [m.id, m]));

  // 决策·models-allowlist-optional: 省略或空白名单 → 账号全量、不分「更多」。
  const useAllowlist = Array.isArray(allowed) && allowed.length > 0;
  let models: AllowedModel[];
  let more: AllowedModel[];
  if (useAllowlist) {
    const pinnedIds = new Set(allowed);
    models = allowed
      .map((id) => {
        const m = byId.get(id);
        return m ? withVision(m) : undefined;
      })
      .filter((m): m is AllowedModel => m !== undefined);
    more = all.filter((m) => !pinnedIds.has(m.id)).map(withVision);
  } else {
    models = all.map(withVision);
    more = [];
  }

  // default 省略 → 用「常用」首项;若 default.id 在账号目录中则用之(可落在「更多」)。
  let resolvedDefault: ModelSelectionConfig;
  if (defaultModel?.id && byId.has(defaultModel.id)) {
    resolvedDefault = defaultModel;
  } else if (models[0]) {
    resolvedDefault = { id: models[0].id };
  } else {
    resolvedDefault = defaultModel ?? { id: all[0]?.id ?? "unknown" };
  }

  return { models, more, default: resolvedDefault };
}
