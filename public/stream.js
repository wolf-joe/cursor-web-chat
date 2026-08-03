import { chatLogEl, chatTitleAgentEl } from "./dom.js";
import { state } from "./state.js";
import { agentStreamUrl, fetchConversation } from "./api.js";
import {
  appendMessageBubble,
  appendRunMeta,
  appendToolBlock,
  updateToolBlockEl,
  appendThinkingBlock,
  appendThinkingDelta,
  appendStatusLine,
  appendErrorBanner,
  buildCollapsedGroupEl,
  renderHistory,
  renderMarkdown,
  setComposerEnabled,
  showPendingIndicator,
  clearPendingIndicator,
} from "./render.js";
import { hydrateMermaid } from "./mermaidHydrate.js";
import { loadFolders, currentFolder, renderFolders } from "./sidebar.js";
import { refreshGitDirty } from "./gitStatus.js";
import { playDoneChime } from "./sound.js";
import { playTts } from "./ttsPlayer.js";

// call_id -> DOM element,直播期间用于原地更新 tool_call 的 running/completed。
let liveToolBlocks = new Map();

// 实测坐实(非文档假设): run.stream() 的 "assistant" 事件里 message.content 的
// text block 并非每次都是完整文本,同一段回复可能拆成多个事件(如 "p" + "ong2")。
// 因此流式渲染要把连续的 assistant 文本事件累积进同一个气泡,遇到非文本事件才断开,
// 否则界面会碎成一堆几个字的小气泡。thinking 事件同理。
let currentAssistantAccumulator = null; // { textEl, rawText } | null
let currentThinkingAccumulator = null; // { el } | null

// 本轮 run 里新建的顶层气泡/块(thinking、工具调用、assistant 文本气泡),
// run 结束时用来把"除最后一个外"的都收进折叠区(见 collapseCurrentTurnMiddle)。
let currentTurnUnits = [];

// 本轮 run 里最后一次创建的 assistant 气泡,"done" 事件到达时在它底部挂上
// 这一轮的模型/用量。
let lastAssistantBubbleEl = null;

let currentEventSource = null;
// 决策·attach-user-text: 一次 attachToStream() 调用只渲染一次用户气泡——EventSource
// 因网络抖动自动重连时会重新收到 "attach" 事件,这个标记防止用户气泡被渲染两遍。
let userBubbleRendered = false;

function resetStreamState() {
  liveToolBlocks = new Map();
  currentAssistantAccumulator = null;
  currentThinkingAccumulator = null;
  currentTurnUnits = [];
  lastAssistantBubbleEl = null;
  userBubbleRendered = false;
}

// 断开对当前 run 直播的观看,不影响服务端 run 本身的生命周期——它由 runHub
// 独立托管(见 src/runHub.ts 决策·hub-owns-lifecycle),后端会继续把它跑完并持久化。
export function detachStream() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  resetStreamState();
  state.streaming = false;
}

function appendAssistantTextDelta(text) {
  if (!currentAssistantAccumulator) {
    breakThinkingAccumulator();
    // 决策·assistant-scroll-once: 每个新 assistant 正文气泡出现时贴底一次,
    // 后续增量不再跟滚。thinking/工具等不走这条路径。
    const el = appendMessageBubble("assistant", "", undefined, chatLogEl, "force");
    currentAssistantAccumulator = { textEl: el.querySelector(".msg-text"), rawText: "" };
    currentTurnUnits.push(el);
    lastAssistantBubbleEl = el;
  }
  currentAssistantAccumulator.rawText += text;
  // 决策·mermaid-after-dom: 增量阶段只 parse markdown，不 hydrate——否则每次
  // innerHTML 都会拆掉半成品 SVG，且不完整 fence 会反复报错。
  currentAssistantAccumulator.textEl.innerHTML = renderMarkdown(currentAssistantAccumulator.rawText);
}

function breakAssistantAccumulator() {
  if (currentAssistantAccumulator?.textEl) {
    void hydrateMermaid(currentAssistantAccumulator.textEl);
  }
  currentAssistantAccumulator = null;
}

function appendThinkingTextDelta(text) {
  if (!currentThinkingAccumulator) {
    breakAssistantAccumulator();
    // 决策·thinking-collapse: 与历史共用 appendThinkingBlock；直播中条保持合着。
    const el = appendThinkingBlock("", chatLogEl);
    currentThinkingAccumulator = { el };
    currentTurnUnits.push(el);
  }
  appendThinkingDelta(currentThinkingAccumulator.el, text);
}

function breakThinkingAccumulator() {
  currentThinkingAccumulator = null;
}

function updateToolBlock(callId, { name, status, args, result }) {
  const el = liveToolBlocks.get(callId);
  if (!el) {
    const created = appendToolBlock({ name, status, args, result });
    liveToolBlocks.set(callId, created);
    currentTurnUnits.push(created);
    return;
  }
  updateToolBlockEl(el, { name, status, args, result });
}

// 直播过程中不知道"最后一步"是谁,所以先照常逐条显示;等这一轮 run 结束
// (done 事件)后,再回头把除最后一个单元外的都塞进折叠区,和历史记录展示一致。
function collapseCurrentTurnMiddle() {
  if (currentTurnUnits.length > 1) {
    const middle = currentTurnUnits.slice(0, -1);
    const { el, detail } = buildCollapsedGroupEl(middle.length);
    chatLogEl.insertBefore(el, middle[0]);
    for (const unit of middle) detail.appendChild(unit);
  }
  currentTurnUnits = [];
}

async function refetchConversation(agentId, cwd) {
  const data = await fetchConversation(agentId, cwd);
  // 决策·refetch-fail-skip: 失败或无 runId 则跳过自动播,不重试。
  if (data.error) return;
  // Streaming 结束只换权威历史,不贴底——用户可能正在回看上方内容。
  renderHistory(data, { scroll: "preserve" });
  // 决策·auto-after-refetch / 决策·just-finished-only: 必须在 renderHistory
  // 之后触发(开头会 stopTtsPlayback);仅正常结束的 finished 轮自动朗读。
  if (!state.ttsEnabled || !state.userSettings.autoTts) return;
  if (state.currentAgentId !== agentId || state.currentCwd !== cwd) return;
  const lastRun = data.runs?.[data.runs.length - 1];
  if (!lastRun?.runId) return;
  if (lastRun.status && lastRun.status !== "finished") return;
  void playTts(lastRun.runId);
}

function handleStreamEvent(event, { agentId, cwd }) {
  clearPendingIndicator();
  switch (event.type) {
    // 决策·attach-user-text: 接入(含 EventSource 因网络抖动自动重连)时补发的
    // 用户文本,只在这次 attach 会话里第一次收到时渲染,避免重连后重复。
    case "attach":
      if (!userBubbleRendered) {
        if (chatLogEl.querySelector(".empty, .loading")) chatLogEl.innerHTML = "";
        // 决策·attach-image-url: 旁路 URL 可选;无图字段则纯文字气泡。
        appendMessageBubble("user", event.userText, Date.now(), chatLogEl, "force", {
          imageUrl: event.imageUrl,
        });
        userBubbleRendered = true;
      }
      break;
    case "title": {
      // 新会话首条消息生成的标题(见 server.ts /api/chat + runHub.broadcastTitle)——
      // 后端已经 renameAgent 落盘,这里只是让当前打开的这个会话立刻看到新标题。
      const folder = currentFolder();
      const agentInfo = folder.agents?.find((a) => a.agentId === event.agentId);
      if (agentInfo) agentInfo.name = event.title;
      if (state.currentAgentId === event.agentId) {
        state.currentAgentName = event.title;
        chatTitleAgentEl.textContent = event.title;
      }
      renderFolders();
      break;
    }
    case "assistant":
      breakThinkingAccumulator();
      for (const block of event.message?.content ?? []) {
        if (block.type === "text") appendAssistantTextDelta(block.text);
        else if (block.type === "tool_use") {
          breakAssistantAccumulator();
          breakThinkingAccumulator();
          currentTurnUnits.push(appendToolBlock({ name: block.name, status: "running", args: block.input }));
        }
      }
      break;
    case "thinking":
      appendThinkingTextDelta(event.text ?? "");
      break;
    case "tool_call":
      breakAssistantAccumulator();
      breakThinkingAccumulator();
      updateToolBlock(event.call_id, {
        name: event.name,
        status: event.status,
        args: event.args,
        result: event.result,
      });
      break;
    case "status":
      appendStatusLine(`[status] ${event.status}${event.message ? " · " + event.message : ""}`);
      break;
    case "task":
      if (event.text) appendStatusLine(`[task] ${event.text}`);
      break;
    case "done": {
      breakAssistantAccumulator();
      breakThinkingAccumulator();
      collapseCurrentTurnMiddle();
      appendRunMeta(lastAssistantBubbleEl, event.model, event.usage, event.contextUsage);
      lastAssistantBubbleEl = null;
      // 决策·done-error-message: 优先用 done.error(来自 run.error);缺了才泛化兜底。
      const errorText =
        event.status === "error" ? event.error || "运行出错" : null;
      if (errorText) {
        appendErrorBanner(errorText);
      } else if (event.status === "cancelled") {
        appendStatusLine("[已取消]");
      }
      // 决策·done-chime: 正常结束/出错时提示一声;用户主动取消不响。
      if (event.status === "finished" || event.status === "error" || event.status === "unknown") {
        playDoneChime();
      }
      // 决策·honest-cancelled-ui: finished / unknown / cancelled / error 都 refetch,
      // 与重开会话一致(已推进的取消轮会带状态标与撤销引导;未推进的仍不出现)。
      // 直播里先画的 [已取消] 会被权威历史替换,这是刻意的。
      // 决策·keep-error-banner: 未推进的 error 轮历史里整轮不出现,refetch 会把
      // 刚画的错误条冲掉(鉴权失败等早停尤其如此);完成后把文案补回聊天区底部。
      const shouldRefetch =
        event.status === "finished" ||
        event.status === "unknown" ||
        event.status === "cancelled" ||
        event.status === "error";
      detachStream();
      setComposerEnabled(true);
      loadFolders();
      // agent 最常改磁盘文件的时机:run 结束后刷新当前 cwd 的 dirty 标记。
      refreshGitDirty(cwd);
      if (shouldRefetch) {
        void refetchConversation(agentId, cwd).then(() => {
          if (
            errorText &&
            state.currentAgentId === agentId &&
            state.currentCwd === cwd
          ) {
            appendErrorBanner(errorText);
          }
        });
      }
      break;
    }
    // "user" / "system" / "usage" / "request": MVP 不渲染
    default:
      break;
  }
}

// 决策·unified-sse-path: 发起方和旁观者走同一个入口接入——发起方发完消息后、
// 旁观者中途打开一个 liveRun 会话时,都调这个函数。agentId/cwd 从调用处闭包
// 传入而不是读全局 state,避免"用户已经切到别的会话"之后这次 attach 的收尾
// 逻辑(如 done 后的 refetch)还操作着错误的会话。
export function attachToStream(agentId, cwd) {
  detachStream();
  state.streaming = true;
  setComposerEnabled(false);
  showPendingIndicator();

  const es = new EventSource(agentStreamUrl(agentId));
  currentEventSource = es;
  es.onmessage = (e) => handleStreamEvent(JSON.parse(e.data), { agentId, cwd });
}
