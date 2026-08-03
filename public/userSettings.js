// 决策·two-toggles / 决策·send-key / 决策·menu-requires-cwd: 用户设置 modal。
// 开关即时写入 localStorage;入口挂 header ⋮,仅有 cwd 时可开菜单。
// 决策·tts-opt-in: TTS 未启用时隐藏相关设置项。
import {
  headerTtsSettingsEl,
  ttsSettingsModalOverlay,
  ttsSettingsModalClose,
  ttsAutoToggle,
  ttsKeepAwakeToggle,
  sendKeyEnter,
  sendKeyCtrlEnter,
} from "./dom.js";
import { state, updateUserSettings } from "./state.js";
import { closeAllDropdowns } from "./sidebar.js";
import { syncWakeLock } from "./ttsPlayer.js";

const ttsSettingsFieldset = document.getElementById("ttsSettingsFieldset");

function syncToggleUi() {
  ttsAutoToggle.checked = state.userSettings.autoTts;
  ttsKeepAwakeToggle.checked = state.userSettings.keepAwakeWhileTts;
  const sendKey = state.userSettings.sendKey;
  sendKeyEnter.checked = sendKey === "enter";
  sendKeyCtrlEnter.checked = sendKey === "ctrlEnter";
}

/** 决策·tts-opt-in: 由 loadModels 在拿到 ttsEnabled 后调用。 */
export function syncTtsSettingsVisibility() {
  if (ttsSettingsFieldset) {
    ttsSettingsFieldset.hidden = !state.ttsEnabled;
  }
}

export function openTtsSettingsModal() {
  syncToggleUi();
  syncTtsSettingsVisibility();
  ttsSettingsModalOverlay.classList.add("open");
}

export function closeTtsSettingsModal() {
  ttsSettingsModalOverlay.classList.remove("open");
}

headerTtsSettingsEl.addEventListener("click", () => {
  closeAllDropdowns();
  if (state.currentCwd === null) return;
  openTtsSettingsModal();
});

ttsSettingsModalClose.addEventListener("click", closeTtsSettingsModal);
ttsSettingsModalOverlay.addEventListener("click", (e) => {
  if (e.target === ttsSettingsModalOverlay) closeTtsSettingsModal();
});

ttsAutoToggle.addEventListener("change", () => {
  updateUserSettings({ autoTts: ttsAutoToggle.checked });
});

ttsKeepAwakeToggle.addEventListener("change", () => {
  updateUserSettings({ keepAwakeWhileTts: ttsKeepAwakeToggle.checked });
  // 关掉时常亮立即释放;开着且正在播则立刻申请。
  syncWakeLock();
});

function onSendKeyChange(value) {
  updateUserSettings({ sendKey: value });
}

sendKeyEnter.addEventListener("change", () => {
  if (sendKeyEnter.checked) onSendKeyChange("enter");
});
sendKeyCtrlEnter.addEventListener("change", () => {
  if (sendKeyCtrlEnter.checked) onSendKeyChange("ctrlEnter");
});
