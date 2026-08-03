import { readFileSync } from "node:fs";
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

// 决策·startup-cache: Cursor.models.list() 冷启动要打外部网络,耗时可达数秒;
// 若每次都等它返回,前端刚打开页面时模型选择器要空等好几秒。这里进程启动时先同步读盘
// 垫一份上次成功的目录做初始值,再在后台发起真正的网络请求——网络请求落地前的请求
// 直接吃这份垫底缓存(哪怕是上一次跑的、可能略微过期),网络请求一旦成功就原地升级为
// 最新值,后续请求都拿新的。只有进程重启后从没成功抓过一次(缓存文件也不存在)时才会
// 阻塞等网络,不会一直归旧值。
let latestModels: SDKModel[] | undefined = readCachedCatalogSync();

function readCachedCatalogSync(): SDKModel[] | undefined {
  try {
    return JSON.parse(readFileSync(CATALOG_CACHE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

// 账号下的模型目录几乎不变,进程生命周期内缓存一份即可,不用每次请求都打网络。
// 失败时把缓存清掉,让下一次请求重试,而不是把一次网络抖动缓存成永久失败。
let modelsPromise: Promise<SDKModel[]> | undefined;

function fetchAllModels(): Promise<SDKModel[]> {
  if (!modelsPromise) {
    modelsPromise = Cursor.models.list()
      .then((models) => {
        latestModels = models;
        writeFile(CATALOG_CACHE_PATH, `${JSON.stringify(models, null, 2)}\n`, "utf-8").catch((err) => {
          log.error("写 models-catalog.json 失败(不影响正常功能)", err);
        });
        return models;
      })
      .catch((err) => {
        log.error("拉取模型目录失败", err);
        modelsPromise = undefined;
        throw err;
      });
  }
  return modelsPromise;
}

// 进程启动就把网络请求发出去,不等第一个 /api/models 请求才触发——这样它跟前端
// 冷启动那次请求并行跑,尽量缩短"垫底缓存"生效的窗口。失败无需在此处理,
// listAllowedModels() 里没有垫底缓存可用时会自己等这个 promise 并把错误抛给调用方。
fetchAllModels().catch(() => {});

export type AllowedModel = SDKModel & {
  // 决策·vision-allowlist: 前后端共用,前端据此启停加号/粘贴。
  supportsVision: boolean;
};

export interface AllowedModelsResult {
  models: AllowedModel[];
  default: ModelSelectionConfig;
}

export async function listAllowedModels(): Promise<AllowedModelsResult> {
  const { allowed, default: defaultModel } = loadModelsConfig();
  const all = latestModels ?? (await fetchAllModels());
  const byId = new Map(all.map((m) => [m.id, m]));

  // 决策·models-allowlist-optional: 省略或空白名单 → 账号全量目录(保持 list 顺序)。
  const useAllowlist = Array.isArray(allowed) && allowed.length > 0;
  const models: AllowedModel[] = useAllowlist
    ? allowed
        .map((id) => {
          const m = byId.get(id);
          if (!m) return undefined;
          return { ...m, supportsVision: modelSupportsVision(id) };
        })
        .filter((m) => m !== undefined)
    : all.map((m) => ({ ...m, supportsVision: modelSupportsVision(m.id) }));

  // default 省略 → 用过滤后目录首项;若白名单命中了 default.id 则用之。
  let resolvedDefault: ModelSelectionConfig;
  if (defaultModel?.id && byId.has(defaultModel.id)) {
    // 白名单模式下 default 也须在结果里(或至少在账号目录里);展示层用 id 即可。
    resolvedDefault = defaultModel;
  } else if (models[0]) {
    resolvedDefault = { id: models[0].id };
  } else {
    resolvedDefault = defaultModel ?? { id: all[0]?.id ?? "unknown" };
  }

  return { models, default: resolvedDefault };
}
