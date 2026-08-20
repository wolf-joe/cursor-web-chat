import {
  composerInput,
  composerImageBtn,
  composerImageInput,
  composerImagePreview,
  composerImageThumb,
  composerImageClear,
  sendBtn,
  chatTitleAgentEl,
} from "./dom.js";
import { state, syncSessionUrl } from "./state.js";
import { postChat, cancelRunApi } from "./api.js";
import {
  appendErrorBanner,
  setAgentStatus,
  setComposerEnabled,
  updateHeaderMenuState,
  currentModelSupportsVision,
  updateComposerImageBtn,
} from "./render.js";
import { highlightActiveAgent, markAgentCachedInSidebar } from "./sidebar.js";
import { attachToStream } from "./stream.js";
import { unlockAudio } from "./sound.js";

// 决策·allowed-mime / 决策·max-one-image-10mb(与后端 userImageStore 对齐)
const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** @type {{ mimeType: string, data: string, previewUrl: string } | null} */
let pendingImage = null;

export function clearPendingImage() {
  if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
  pendingImage = null;
  composerImageThumb.removeAttribute("src");
  composerImagePreview.hidden = true;
  composerImageInput.value = "";
}

/** 切到非 vision 模型时清空已选图并刷新加号(决策·vision-allowlist)。 */
export function syncPendingImageWithModel() {
  if (!currentModelSupportsVision() && pendingImage) clearPendingImage();
  updateComposerImageBtn();
}

function setPendingImage({ mimeType, data, file }) {
  if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
  const previewUrl = URL.createObjectURL(file);
  pendingImage = { mimeType, data, previewUrl };
  composerImageThumb.src = previewUrl;
  composerImagePreview.hidden = false;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 选图/粘贴共用校验;失败抛 Error。 */
async function acceptImageFile(file) {
  if (!file || !file.type) throw new Error("无法识别的图片文件");
  if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
    throw new Error("不支持的图片类型(仅 png/jpeg/webp/gif)");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大(上限 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB)`);
  }
  if (!currentModelSupportsVision()) {
    throw new Error("当前模型不支持图片");
  }
  const data = await readFileAsBase64(file);
  setPendingImage({ mimeType: file.type, data, file });
}

export async function sendMessage() {
  const text = composerInput.value.trim();
  // 决策·text-required-with-image: 有图也必须有字。
  if (!text || state.streaming || !state.currentCwd) return;
  if (pendingImage && !currentModelSupportsVision()) {
    appendErrorBanner("当前模型不支持图片");
    return;
  }

  // 决策·done-chime: 发送是用户手势,在此解锁 AudioContext,run 结束播提示音才不被拦。
  unlockAudio();

  const imagePayload = pendingImage
    ? { mimeType: pendingImage.mimeType, data: pendingImage.data }
    : undefined;

  composerInput.value = "";
  clearPendingImage();
  autoGrowComposer();
  state.streaming = true;
  setComposerEnabled(false);

  let attached = false;
  try {
    const { status, ok, data } = await postChat({
      cwd: state.currentCwd,
      agentId: state.currentAgentId ?? undefined,
      text,
      model: state.selectedModel,
      image: imagePayload,
    });

    if (status === 409) {
      appendErrorBanner(data.error || "该会话有 run 正在进行,请稍后再试");
      return;
    }
    if (!ok) {
      appendErrorBanner(data.error || `请求失败: ${status}`);
      return;
    }

    // 新会话第一条消息:agentId 直到这里才落地——对应旧协议里的 "meta" 事件,
    // 只是现在由 POST /api/chat 的响应直接携带,不必再等一轮流事件。
    if (!state.currentAgentId) {
      state.currentAgentId = data.agentId;
      state.currentAgentName = data.agentId;
      highlightActiveAgent(data.agentId);
      chatTitleAgentEl.textContent = data.agentId;
      syncSessionUrl();
      updateHeaderMenuState();
    }
    setAgentStatus("active");
    markAgentCachedInSidebar(data.agentId);

    attached = true;
    attachToStream(data.agentId, state.currentCwd);
    // 决策·native-watch-own-send: 只把本机发出的这一轮交给壳的 RunSession;
    // 打开别人已经在跑的 liveRun 只订页面 SSE,不拉前台服务、不弹结束通知。
    if (typeof window.CwcNative !== "undefined" && window.CwcNative.watchRun) {
      window.CwcNative.watchRun(data.agentId);
    }
  } catch (err) {
    appendErrorBanner(err instanceof Error ? err.message : String(err));
  } finally {
    // attachToStream() 接管之后,state.streaming/composer 的收尾交给 stream.js
    // 的 "done" 处理(决策·unified-sse-path:停止按钮状态由 attach 生命周期驱动)——
    // 这里只处理"压根没接上直播"的失败路径。
    if (!attached) {
      state.streaming = false;
      setComposerEnabled(true);
    }
  }
}

// 之前中断误发消息只能靠 kill 掉后端进程,会在本地 SQLite 里留下永远卡在 running
// 状态的孤儿 agent/run(见 src/agentService.ts 的 决策·orphan-reconcile)。这里调
// 真正的服务端 run.cancel(),让 run 走完 cancelled 终态、正常落盘,不留孤儿。
// 不在这里手动收尾——run.cancel() 后 runHub 会广播出 status: "cancelled" 的 done
// 事件,stream.js 的 handleStreamEvent 收到后会自然 detachStream()。
export async function cancelCurrentRun() {
  if (!state.streaming || !state.currentAgentId) return;
  sendBtn.disabled = true;
  try {
    const { ok, data } = await cancelRunApi(state.currentAgentId);
    if (!ok) {
      appendErrorBanner(data.error || "停止失败");
      sendBtn.disabled = false;
    }
  } catch (err) {
    appendErrorBanner(err instanceof Error ? err.message : String(err));
    sendBtn.disabled = false;
  }
}

// textarea 高度随内容自增:先塌回 auto——对 <textarea> 这种可替换元素,"auto" 撑开的
// 是 rows 属性对应的固有高度(这里是 1 行),不是内容高度,所以不能直接拿 offsetHeight
// 当结果用(试过,结果是完全长不高,输入再多也卡在 1 行)。真正反映内容高度的是这一步
// 的 scrollHeight。
//
// 但 scrollHeight 不含 border(全局 box-sizing: border-box,这个 textarea 又有 1px
// border),直接拿它赋给 height 会让可用内容区少了上下各 1px,导致内容明明没到
// max-height 也会冒出一丝纵向内部滚动——所以还要把 border 宽度加回去,一次性量出来
// 缓存住(border 不会随内容变化)。真正的封顶交给 CSS 的 max-height。
let composerBorderHeight;
export function autoGrowComposer() {
  if (composerBorderHeight === undefined) {
    const cs = getComputedStyle(composerInput);
    composerBorderHeight = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  }
  composerInput.style.height = "auto";
  composerInput.style.height = `${composerInput.scrollHeight + composerBorderHeight}px`;
}

sendBtn.addEventListener("click", () => {
  if (state.streaming) {
    cancelCurrentRun();
  } else {
    sendMessage();
  }
});
composerInput.addEventListener("input", autoGrowComposer);

// 决策·entry-paste-and-plus: 加号选图。
composerImageBtn.addEventListener("click", () => {
  if (composerImageBtn.disabled) return;
  composerImageInput.click();
});
composerImageInput.addEventListener("change", async () => {
  const file = composerImageInput.files?.[0];
  if (!file) return;
  try {
    await acceptImageFile(file);
  } catch (err) {
    appendErrorBanner(err instanceof Error ? err.message : String(err));
    composerImageInput.value = "";
  }
});
composerImageClear.addEventListener("click", () => clearPendingImage());

// 决策·entry-paste-and-plus: 剪贴板粘贴图片(一轮最多一张,后贴覆盖)。
composerInput.addEventListener("paste", async (e) => {
  if (state.streaming || !currentModelSupportsVision()) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  let imageFile = null;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      imageFile = item.getAsFile();
      break;
    }
  }
  if (!imageFile) return;
  e.preventDefault();
  try {
    await acceptImageFile(imageFile);
  } catch (err) {
    appendErrorBanner(err instanceof Error ? err.message : String(err));
  }
});

// 决策·send-key: Enter vs Ctrl/⌘+Enter;默认见 state.defaultSendKey。
// Ctrl/⌘+Enter 在两种模式下都能发送;IME 组字中不拦截。
// 决策·draft-while-streaming: 回复中不拦截 Enter——否则 sendKey=enter 时
// preventDefault 会把换行也吞掉,草稿写不成多行。发送仍由 sendMessage 闸住。
composerInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  if (state.streaming) return;

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    sendMessage();
    return;
  }

  if (state.userSettings.sendKey === "enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
