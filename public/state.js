// 全局可变状态 + 浏览器端持久化。最底层的叶子模块之一——不
// import 任何业务模块,避免循环引用(见 决策·es-module-refactor)。
// 会话书签走 URL query(决策·url-shape / 决策·replace-only);用户设置桌面仍用 localStorage。
// 决策·app-level-user-settings: 包装器内 persist 整包进壳,切 origin 后 load 认壳;壳空则各站各过各的。

// 决策·two-toggles / 决策·storage-key / 决策·send-key: 用户级设置。
const USER_SETTINGS_KEY = "cursor-web-chat:userSettings";
const SEND_KEYS = new Set(["enter", "ctrlEnter"]);

// 决策·send-key-default: 粗指针/无悬停视为触控端——裸 Enter 留给换行(靠点发送);
// 桌面默认 Enter 发送。未显式选过 sendKey 时每次按设备算,不抢写 localStorage。
export function defaultSendKey() {
  const touchLike =
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(hover: none)").matches;
  return touchLike ? "ctrlEnter" : "enter";
}

const DEFAULT_USER_SETTINGS = {
  autoTts: false,
  keepAwakeWhileTts: true,
  // sendKey 故意不写死进常量默认值——见 决策·send-key-default。
};

/** 用户是否在设置里点过发送快捷键;未点过则 persist 时不落盘 sendKey。 */
let sendKeyExplicit = false;

function readNativeUserSettingsRaw() {
  try {
    if (typeof window.CwcNative?.getUserSettings !== "function") return null;
    const raw = window.CwcNative.getUserSettings();
    if (typeof raw !== "string" || !raw.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

function applyParsedUserSettings(parsed) {
  sendKeyExplicit = SEND_KEYS.has(parsed.sendKey);
  return {
    autoTts: typeof parsed.autoTts === "boolean" ? parsed.autoTts : DEFAULT_USER_SETTINGS.autoTts,
    keepAwakeWhileTts:
      typeof parsed.keepAwakeWhileTts === "boolean"
        ? parsed.keepAwakeWhileTts
        : DEFAULT_USER_SETTINGS.keepAwakeWhileTts,
    sendKey: sendKeyExplicit ? parsed.sendKey : defaultSendKey(),
  };
}

function loadUserSettingsFromRaw(raw) {
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid userSettings");
  }
  return applyParsedUserSettings(parsed);
}

function loadUserSettings() {
  // 壳非空且可解析则以壳为准,只镜像进本站 localStorage,禁止在此 set 回壳(否则打开即升全局)。
  const nativeRaw = readNativeUserSettingsRaw();
  if (nativeRaw) {
    try {
      const settings = loadUserSettingsFromRaw(nativeRaw);
      try {
        localStorage.setItem(USER_SETTINGS_KEY, nativeRaw);
      } catch {
        /* quota / private mode */
      }
      return settings;
    } catch {
      /* 坏 JSON 当本站 localStorage,且不覆盖壳 */
    }
  }
  try {
    const raw = localStorage.getItem(USER_SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_USER_SETTINGS, sendKey: defaultSendKey() };
    }
    return loadUserSettingsFromRaw(raw);
  } catch {
    return { ...DEFAULT_USER_SETTINGS, sendKey: defaultSendKey() };
  }
}

export const state = {
  folders: [],
  currentCwd: null,
  currentFolderName: null,
  currentAgentId: null, // null = 新建会话(尚未发送第一条消息)
  // 决策·name-memory-only: 与 currentAgentId 同步的展示标题;不进 URL。
  // 不在侧边栏已加载页时先显示 agentId,翻到含该会话的页再校正。
  currentAgentName: null,
  streaming: false,
  models: [], // config.models.allowed 过滤后的模型目录(可省略白名单=全量),每项含 parameters/variants
  // 决策·model-session-scoped: 来自 config.models.default;/api/models 加载后填入。
  // 切会话时 selectedModel 拨回这份,不跨会话、不进 localStorage。
  defaultModel: null, // { id, params? }
  selectedModel: null, // { id, params? } —— 当前会发给 /api/chat 的模型选择
  // 决策·tts-opt-in: 来自 /api/models 的 ttsEnabled;关闭时不渲染朗读控件。
  ttsEnabled: false,
  userSettings: loadUserSettings(),
};

// 决策·drop-lastSession / 决策·model-session-scoped: 旧全局书签与跨会话模型
// 记忆已弃用;清掉以免排障时误读。
const LEGACY_SESSION_STORAGE_KEY = "cursor-web-chat:lastSession";
const LEGACY_MODEL_STORAGE_KEY = "cursor-web-chat:selectedModel";
try {
  localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
} catch {
  /* ignore quota / private mode */
}

export function persistUserSettings() {
  const { sendKey, ...rest } = state.userSettings;
  const payload = sendKeyExplicit ? { ...rest, sendKey } : { ...rest };
  const raw = JSON.stringify(payload);
  localStorage.setItem(USER_SETTINGS_KEY, raw);
  // 决策·app-level-user-settings: 仅设置动作(本函数)写壳;失败静默,本站 localStorage 已生效。
  try {
    if (typeof window.CwcNative?.setUserSettings === "function") {
      window.CwcNative.setUserSettings(raw);
    }
  } catch {
    /* ignore */
  }
}

export function updateUserSettings(patch) {
  if (SEND_KEYS.has(patch.sendKey)) sendKeyExplicit = true;
  state.userSettings = { ...state.userSettings, ...patch };
  persistUserSettings();
}

/**
 * 决策·url-shape: 从地址栏读 { cwd, agentId };无 cwd 则 null。
 * agent 缺省时 agentId 为 null(表示该 cwd 下新建未发消息)。
 */
export function loadSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const cwd = params.get("cwd");
  if (!cwd) return null;
  const agent = params.get("agent");
  return { cwd, agentId: agent || null };
}

/**
 * 决策·replace-only / 决策·url-shape: 把 state 当前 cwd/agent 同步到 query。
 * 无 cwd 时清掉 cwd/agent;有 cwd 无 agent 时只保留 cwd(新建态)。
 */
export function syncSessionUrl() {
  const url = new URL(window.location.href);
  if (!state.currentCwd) {
    url.searchParams.delete("cwd");
    url.searchParams.delete("agent");
  } else {
    url.searchParams.set("cwd", state.currentCwd);
    if (state.currentAgentId) url.searchParams.set("agent", state.currentAgentId);
    else url.searchParams.delete("agent");
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) history.replaceState(null, "", next);
}
