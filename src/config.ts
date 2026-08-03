import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 决策·config-split / 决策·llm-config-split / 决策·models-allowlist-optional:
// 本机 config.json 不进 git。folders 必填;llm / tts / models / fileBrowser 均可选。
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

export interface FolderConfig {
  name: string;
  cwd: string;
  // 决策·folder-pin: 侧边栏置顶标记;仅 true 生效。置顶项按 config 书写顺序排在
  // 列表前部,且不进入非置顶区(前端按此字段分区渲染,不做二次出现)。
  pinned?: boolean;
}

export interface ModelParamConfig {
  id: string;
  value: string;
}

export interface ModelSelectionConfig {
  id: string;
  params?: ModelParamConfig[];
}

export interface ModelsConfig {
  // 白名单——列出的 model id 会出现在前端选择器里。省略(或空数组)时展示账号全量目录。
  allowed?: string[];
  // 新会话/未显式选择时用的模型。省略则用账号目录第一个。
  default?: ModelSelectionConfig;
}

/** 决策·llm-config-split: baseUrl 非空才视为已配置;缺则短任务降级。 */
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

/** 决策·tts-opt-in: 默认关闭;enabled+baseUrl 都就绪才开放朗读。 */
export interface TtsConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
}

export interface FileBrowserConfig {
  // 决策·fs-scope-tighten: 默认 false=只允许 cwd 内;true=恢复父目录树(含兄弟目录)。
  allowParentTree?: boolean;
}

interface RawConfig {
  folders: FolderConfig[];
  llm?: Partial<LlmConfig> | null;
  tts?: Partial<TtsConfig> | null;
  models?: ModelsConfig | null;
  fileBrowser?: FileBrowserConfig | null;
}

/** 未在 config 写 model 时的内置默认(与历史 llm-proxy flash 一致)。 */
export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_TTS_MODEL = "mimo/mimo-v2.5-tts";
export const DEFAULT_TTS_VOICE = "冰糖";

function readConfig(): RawConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `缺少本机 config.json(${CONFIG_PATH})。从仓库根目录复制: cp config.example.json config.json 后按本机路径改 folders`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as RawConfig;
  if (!Array.isArray(parsed.folders)) {
    throw new Error(`config.json 缺少 folders 数组: ${CONFIG_PATH}`);
  }
  return parsed;
}

function writeConfig(config: RawConfig): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function loadFolders(): FolderConfig[] {
  // 决策·folder-pin: pinned===true 置顶并保留 config 书写顺序;其余按 name 字符序。
  // 两侧互斥——同一 folder 只会出现在置顶区或非置顶区之一。
  const folders = readConfig().folders.map((f) => {
    const folder: FolderConfig = { name: f.name, cwd: f.cwd };
    if (f.pinned === true) folder.pinned = true;
    return folder;
  });
  const pinned = folders.filter((f) => f.pinned);
  const rest = folders
    .filter((f) => !f.pinned)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...pinned, ...rest];
}

/**
 * 决策·models-allowlist-optional: 读 config.json 的 models 段。
 * allowed 省略或空 → 调用方展示全量目录;default 省略 → 调用方用目录首项。
 */
export function loadModelsConfig(): ModelsConfig {
  const raw = readConfig().models;
  if (!raw || typeof raw !== "object") return {};
  const out: ModelsConfig = {};
  if (Array.isArray(raw.allowed)) {
    out.allowed = raw.allowed.filter((id) => typeof id === "string" && id.trim());
  }
  if (raw.default && typeof raw.default === "object" && typeof raw.default.id === "string") {
    out.default = {
      id: raw.default.id,
      ...(Array.isArray(raw.default.params) ? { params: raw.default.params } : {}),
    };
  }
  return out;
}

// 决策·vision-allowlist: 已知不支持 vision 的模型;名单随本文件维护。
const NO_VISION_MODEL_IDS = new Set(["glm-5.2"]);

export function modelSupportsVision(modelId: string): boolean {
  return !NO_VISION_MODEL_IDS.has(modelId);
}

/**
 * 决策·llm-config-split: 仅当 baseUrl 非空时返回配置;否则 undefined(短任务降级)。
 * apiKey 可空(本机无鉴权网关);model 缺省用 DEFAULT_LLM_MODEL。
 */
export function loadLlmConfig(): { baseUrl: string; apiKey: string; model: string } | undefined {
  const raw = readConfig().llm;
  if (!raw || typeof raw !== "object") return undefined;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/$/, "") : "";
  if (!baseUrl) return undefined;
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const model =
    typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_LLM_MODEL;
  return { baseUrl, apiKey, model };
}

/**
 * 决策·tts-opt-in: enabled===true 且 baseUrl 非空才开放。
 * model/voice 有内置默认;apiKey 可空。
 */
export function loadTtsConfig():
  | { baseUrl: string; apiKey: string; model: string; voice: string }
  | undefined {
  const raw = readConfig().tts;
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.enabled !== true) return undefined;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/$/, "") : "";
  if (!baseUrl) return undefined;
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const model =
    typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_TTS_MODEL;
  const voice =
    typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : DEFAULT_TTS_VOICE;
  return { baseUrl, apiKey, model, voice };
}

export function isTtsEnabled(): boolean {
  return loadTtsConfig() !== undefined;
}

/** 决策·fs-scope-tighten: 默认 false。 */
export function loadFileBrowserAllowParentTree(): boolean {
  const raw = readConfig().fileBrowser;
  return raw?.allowParentTree === true;
}

// "~"、"~/xxx" 展开成运行本服务这台机器上的用户根目录——浏览器端不知道服务端
// 的 home 目录在哪,所以展开必须在这里做,不能挪到前端。
function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function addFolder(rawCwd: string, rawName?: string): FolderConfig {
  const trimmed = rawCwd.trim();
  if (!trimmed) throw new Error("文件夹路径不能为空");
  const cwd = path.resolve(expandHome(trimmed));

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`目录不存在: ${cwd}`);
  }

  const config = readConfig();
  if (config.folders.some((f) => f.cwd === cwd)) {
    throw new Error(`该文件夹已经添加过: ${cwd}`);
  }

  const name = rawName?.trim() || path.basename(cwd);
  const folder: FolderConfig = { name, cwd };
  config.folders.push(folder);
  writeConfig(config);
  return folder;
}
