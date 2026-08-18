import {
  chatLogEl,
  agentStatusEl,
  composerInput,
  composerImageBtn,
  sendBtn,
  modelSelectEl,
  modelParamsBtn,
  browseFolderBtn,
  headerMenuBtn,
  headerRenameEl,
  headerUndoEl,
  headerDeleteEl,
} from "./dom.js";
import { state } from "./state.js";
import { appendTtsControls, stopTtsPlayback } from "./ttsPlayer.js";
import { summarizeTool, renderToolDetail, isCreatePlanTool } from "./toolFormat.js";
import { hydrateMermaid } from "./mermaidHydrate.js";
import { renderMarkdown } from "./markdown.js";

export { renderMarkdown };

// 直播期间不再贴底跟滚。唯一的自动滚动是新 assistant 正文气泡出现时贴底一次
// (appendMessageBubble(..., "force"))。scrollChatToBottom 另留给打开历史/
// 发出用户消息/等待指示这类整页跳转。
// Streaming 正常结束后的 refetch 不贴底(见 renderHistory 的 scroll:"preserve")。
export function scrollChatToBottom({ force = false } = {}) {
  if (force) chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// kind: null(未建立 agent,不展示) | "active"(在内存缓存中,续聊无需 resume) | "cold"(需先 Agent.resume())
export function setAgentStatus(kind) {
  if (!kind) {
    agentStatusEl.className = "agent-status";
    agentStatusEl.title = "";
    return;
  }
  agentStatusEl.className = `agent-status show ${kind}`;
  agentStatusEl.title = kind === "active" ? "活跃 · 内存中,续聊无需重新连接" : "冷启动,发消息时需先恢复 agent";
}

// 决策·vision-allowlist: 与 /api/models 的 supportsVision 对齐。
export function currentModelSupportsVision() {
  const id = state.selectedModel?.id;
  if (!id) return false;
  return Boolean(state.models.find((m) => m.id === id)?.supportsVision);
}

// 决策·entry-paste-and-plus: 加号随 cwd / streaming / vision 启停(不碰 pending 图,清图在 composer)。
export function updateComposerImageBtn() {
  const canAttach =
    !state.streaming && state.currentCwd !== null && currentModelSupportsVision();
  composerImageBtn.disabled = !canAttach;
}

export function setComposerEnabled(enabled) {
  // 决策·draft-while-streaming: 回复中仍可打字预备下一轮;只禁发送(按钮变「停止」),
  // 不禁输入框。无 cwd 时整栏仍禁用。
  composerInput.disabled = state.currentCwd === null;
  // 流式进行中 sendBtn 不禁用——复用成"停止"按钮,只有在 state.currentAgentId
  // 还没就绪(新会话第一条消息,拿到 agentId 之前)时才没法停。
  sendBtn.disabled = enabled ? state.currentCwd === null : !state.currentAgentId;
  sendBtn.textContent = enabled ? "发送" : "停止";
  sendBtn.classList.toggle("stop", !enabled);
  // 流式进行中不让切模型——run 已经用发送时那次的 model 建立了,中途改选择器
  // 不会影响正在跑的这次,只会造成"看起来选了但没生效"的误导。
  modelSelectEl.disabled = !enabled;
  modelParamsBtn.disabled = !enabled;
  // 决策·browse-enabled: 只认 cwd——streaming 中也可开浏览/插 @路径(预备下一轮;
  // 真正发出仍被 sendMessage 的 streaming 闸拦住)。
  browseFolderBtn.disabled = state.currentCwd === null;
  updateComposerImageBtn();
}

// 重命名/撤销/删除依赖已落地的 agentId;新建会话尚未发首条时禁用。
// 必须在 composer 把 agentId 写进 state 后也调一次——否则一直停在「新建→直接聊」
// 路径上时菜单项会一直灰着(startNewConversation / openConversation 才会刷)。
export function updateHeaderMenuState() {
  headerMenuBtn.disabled = state.currentCwd === null;
  const hasAgent = state.currentAgentId !== null;
  headerRenameEl.classList.toggle("disabled", !hasAgent);
  headerUndoEl.classList.toggle("disabled", !hasAgent);
  headerDeleteEl.classList.toggle("disabled", !hasAgent);
}

export function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// SDK 只在 run(一次"用户提问→AI应答"往返)粒度上带时间戳,AI 回复没有独立于
// run 的时间,标在 AI 卡片上会显得像是它的应答时刻,其实只是这轮往返的起点,
// 因此时间只标在用户消息卡片上。日期部分始终展示(只在跨年时才加年份),
// 不因为"是今天"就只显示时:分——历史记录是跨天看的,只有时分会分不清是哪天。
export function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const datePart =
    d.getFullYear() === now.getFullYear()
      ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// scrollMode: "none"(默认,不滚) | "force"(强制贴底,给用户消息/历史加载用)
// opts.imageUrl: 用户气泡缩略图(直播 attach 显式给出;历史用旁路 URL + onerror 降级)。
export function appendMessageBubble(role, text, timestamp, container = chatLogEl, scrollMode = "none", opts = {}) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  // 决策·undo-confirm-copy: 用户气泡保留原文——撤销确认框要展示可复制文本,
  // markdown 渲染后的 DOM textContent 会丢格式/结构,不能当原文源。
  if (role === "user") el.dataset.rawText = text ?? "";
  const timeHtml =
    role === "user" && timestamp ? `<span class="msg-time">${escapeHtml(formatTime(timestamp))}</span>` : "";
  el.innerHTML = `<div class="msg-header"><span class="msg-role">${role}</span>${timeHtml}</div><div class="msg-text">${renderMarkdown(text)}</div>`;
  const textEl = el.querySelector(".msg-text");
  if (role === "user" && opts.imageUrl) {
    const img = document.createElement("img");
    img.className = "msg-user-image";
    img.alt = "用户上传的图片";
    img.loading = "lazy";
    img.src = opts.imageUrl;
    // 决策·persist-best-effort / 无旁路文件时静默降级(历史轮次多数无图会 404)。
    img.onerror = () => img.remove();
    el.insertBefore(img, textEl);
  }
  container.appendChild(el);
  // 决策·mermaid-after-dom: 历史/定稿气泡在入树后再画图；直播增量见 stream.js。
  void hydrateMermaid(textEl);
  if (scrollMode === "force") scrollChatToBottom({ force: true });
  return el;
}

/** 决策·meta-compact: token 数用 k/m 缩写(256000→256k, 1549619→1.55m)。 */
function formatCompactCount(n) {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const trim = (s) => s.replace(/\.?0+$/, "");
  if (abs >= 1_000_000) return `${trim((n / 1_000_000).toFixed(2))}m`;
  if (abs >= 1_000) return `${trim((n / 1_000).toFixed(2))}k`;
  return String(Math.round(n));
}

/**
 * 决策·usage-total-dedupe: SDK `totalTokens = in+out+cacheRead+cacheWrite`,
 * 但 `inputTokens` 已含 cache 命中,直接展示会把 cache 算两遍。
 * 行内总量用 in+out(缺字段时退回 total−cache)。
 */
function displayTotalTokens(usage) {
  if (usage.inputTokens != null && usage.outputTokens != null) {
    return usage.inputTokens + usage.outputTokens;
  }
  if (usage.totalTokens == null) return null;
  return Math.max(
    0,
    usage.totalTokens - (usage.cacheReadTokens || 0) - (usage.cacheWriteTokens || 0),
  );
}

/** 决策·meta-usage-tip: 细项(in/out/cache±)不进主文案,只放悬停 tip;0 的 cache 省略。 */
function formatUsageTip(usage) {
  const parts = [];
  if (usage.inputTokens != null) parts.push(`in ${formatCompactCount(usage.inputTokens)}`);
  if (usage.outputTokens != null) parts.push(`out ${formatCompactCount(usage.outputTokens)}`);
  if (usage.cacheReadTokens) parts.push(`cache ${formatCompactCount(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens) parts.push(`cache+ ${formatCompactCount(usage.cacheWriteTokens)}`);
  return parts.join(" · ");
}

// 挂在 run 上、不挂在单条消息上(§Run.model/usage,粒度是"一次提问+完整应答"),
// 所以只贴在这一轮最后一条 assistant 消息底部,而不是每条消息都重复展示。
// 决策·meta-copy / 决策·no-usage-fallback: contextUsage 是窗口占用 used/max,
// 与计费 usage 并存;缺一则整段不画 context 段。
export function appendRunMeta(el, model, usage, contextUsage) {
  if (!el) return;
  const parts = [];
  if (model?.id) parts.push(model.id);
  const total = usage ? displayTotalTokens(usage) : null;
  if (total != null) parts.push(`${formatCompactCount(total)} tks`);
  if (
    contextUsage != null &&
    typeof contextUsage.usedTokens === "number" &&
    typeof contextUsage.maxTokens === "number"
  ) {
    parts.push(
      `${formatCompactCount(contextUsage.usedTokens)} / ${formatCompactCount(contextUsage.maxTokens)}`,
    );
  }
  if (!parts.length) return;
  const meta = document.createElement("div");
  meta.className = "msg-run-meta";
  meta.textContent = parts.join(" · ");
  const tip = usage ? formatUsageTip(usage) : "";
  if (tip) {
    meta.dataset.usageTip = tip;
    meta.setAttribute("tabindex", "0");
  }
  el.appendChild(meta);
}

// 决策·thinking-collapse: 默认折叠；条上只写「思考」；直播增量走 appendThinkingDelta，不自动撑开。
export function appendThinkingBlock(text = "", container = chatLogEl) {
  const el = document.createElement("div");
  el.className = "block-thinking";
  el.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-label">思考</span>
      <span class="thinking-toggle">展开</span>
    </div>
    <div class="thinking-detail"></div>
  `;
  const body = el.querySelector(".thinking-detail");
  body.textContent = text ?? "";
  const header = el.querySelector(".thinking-header");
  const toggle = el.querySelector(".thinking-toggle");
  // 决策·keep-group-collapse: 单条 click 不冒泡，避免误触整包。
  header.onclick = (e) => {
    e.stopPropagation();
    body.classList.toggle("open");
    toggle.textContent = body.classList.contains("open") ? "折叠" : "展开";
  };
  container.appendChild(el);
  return el;
}

/** 直播思考增量：写入折叠体，保持条合着。 */
export function appendThinkingDelta(el, text) {
  const body = el.querySelector(".thinking-detail");
  if (!body) return;
  body.textContent = (body.textContent || "") + (text ?? "");
}

// 决策·createplan-as-assistant: createPlan 常是本轮主产出(甚至唯一应答),
// 不再走 .block-tool 折叠卡——渲染成类 assistant 气泡,可挂 run meta;
// 角色旁加 CreatePlan 标记。畸形 args 退回 JSON,不白屏。
function createPlanBodyHtml(args) {
  if (args && typeof args === "object" && typeof args.plan === "string") {
    return renderMarkdown(args.plan);
  }
  if (args == null) return "";
  return `<pre class="msg-plan-fallback">${escapeHtml(safeStringify(args))}</pre>`;
}

function createPlanStatusHtml(status) {
  if (status === "running") return `<span class="msg-plan-status running">生成中…</span>`;
  if (status === "error") return `<span class="msg-plan-status error">error</span>`;
  return "";
}

export function appendCreatePlanBubble({ args, status }, container = chatLogEl) {
  const el = document.createElement("div");
  el.className = "msg assistant msg-createplan";
  // 决策·createplan-no-tts: TTS 只抽 assistantMessage 正文,计划气泡挂控件会空读。
  el.dataset.createPlan = "1";
  el._createPlanState = { args, status };
  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-role">assistant</span>
      <span class="msg-plan-badge">CreatePlan</span>
      ${createPlanStatusHtml(status)}
    </div>
    <div class="msg-text">${createPlanBodyHtml(args)}</div>
  `;
  const textEl = el.querySelector(".msg-text");
  container.appendChild(el);
  void hydrateMermaid(textEl);
  return el;
}

export function updateCreatePlanBubbleEl(el, { args, status }) {
  const prev = el._createPlanState || {};
  const next = {
    args: args !== undefined ? args : prev.args,
    status: status != null ? status : prev.status,
  };
  el._createPlanState = next;
  const header = el.querySelector(".msg-header");
  if (header) {
    header.innerHTML = `
      <span class="msg-role">assistant</span>
      <span class="msg-plan-badge">CreatePlan</span>
      ${createPlanStatusHtml(next.status)}
    `;
  }
  const textEl = el.querySelector(".msg-text");
  if (textEl) {
    textEl.innerHTML = createPlanBodyHtml(next.args);
    void hydrateMermaid(textEl);
  }
}

// 工具调用:摘要/详情由 toolFormat 产出；DOM 只负责装配与开合（决策·tool-format-module）。
export function appendToolBlock({ name, status, args, result }, container = chatLogEl) {
  const el = document.createElement("div");
  el.className = "block-tool";
  el._toolState = { name, args, result };
  el.innerHTML = `
    <div class="tool-header">
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-preview">${escapeHtml(summarizeTool(name, args, result))}</span>
      <span class="tool-status ${status}">${escapeHtml(status)}</span>
      <span class="tool-toggle">展开</span>
    </div>
    <div class="tool-detail">
      ${renderToolDetail(name, args, result)}
    </div>
  `;
  const header = el.querySelector(".tool-header");
  const detail = el.querySelector(".tool-detail");
  const toggle = el.querySelector(".tool-toggle");
  // 决策·keep-group-collapse: 单条 click 不冒泡。
  header.onclick = (e) => {
    e.stopPropagation();
    detail.classList.toggle("open");
    toggle.textContent = detail.classList.contains("open") ? "折叠" : "展开";
  };
  container.appendChild(el);
  void hydrateMermaid(detail);
  return el;
}

// 原地更新(直播 running → completed)。决策·detail-open-state: 重渲详情时保留开合。
export function updateToolBlockEl(el, { name, status, args, result }) {
  const prev = el._toolState || {};
  const next = {
    name: name ?? prev.name ?? "tool",
    args: args !== undefined ? args : prev.args,
    result: result !== undefined ? result : prev.result,
  };
  el._toolState = next;

  const statusEl = el.querySelector(".tool-status");
  if (status != null) {
    statusEl.textContent = status;
    statusEl.className = `tool-status ${status}`;
  }
  el.querySelector(".tool-name").textContent = next.name;
  el.querySelector(".tool-preview").textContent = summarizeTool(next.name, next.args, next.result);

  const detail = el.querySelector(".tool-detail");
  const wasOpen = detail.classList.contains("open");
  detail.innerHTML = renderToolDetail(next.name, next.args, next.result);
  detail.classList.toggle("open", wasOpen);
  const toggle = el.querySelector(".tool-toggle");
  if (toggle) toggle.textContent = wasOpen ? "折叠" : "展开";
  void hydrateMermaid(detail);
}

export function appendStatusLine(text) {
  const el = document.createElement("div");
  el.className = "status-line";
  el.textContent = text;
  chatLogEl.appendChild(el);
  return el;
}

// 决策·honest-cancelled-ui / 决策·forget-via-undo: 已推进的非 finished 轮必须
// 标状态,并写明停止≠遗忘、忘掉请用撤销。
export function appendTurnStatusBanner(status) {
  const el = document.createElement("div");
  el.className = `turn-status-banner ${status === "error" ? "error" : "cancelled"}`;
  const label = status === "error" ? "本轮出错" : "已取消";
  el.textContent = `${label} · AI 续聊可能仍记得；忘掉请用撤销`;
  chatLogEl.appendChild(el);
  return el;
}

export function appendErrorBanner(text) {
  const el = document.createElement("div");
  el.className = "error-banner";
  el.textContent = text;
  chatLogEl.appendChild(el);
  return el;
}

// 发消息后到能看到实际输出之间(冷启动 resume 时能有几秒)界面完全没反馈,
// 只有 composer 变灰不够明显——插一个带 spinner 的占位行,接入直播后摘掉。
let pendingIndicatorEl = null;

export function showPendingIndicator() {
  pendingIndicatorEl = document.createElement("div");
  pendingIndicatorEl.className = "status-line pending-indicator";
  pendingIndicatorEl.innerHTML = `<span class="spinner"></span>AI 正在响应…`;
  chatLogEl.appendChild(pendingIndicatorEl);
  scrollChatToBottom({ force: true });
}

export function clearPendingIndicator() {
  if (pendingIndicatorEl) {
    pendingIndicatorEl.remove();
    pendingIndicatorEl = null;
  }
}

// 一轮往返(用户消息之后)通常是 thinking/工具调用/多段回复交织,真正想看的
// 往往只有最后一条——其余的默认折叠,点开才展开,减少历史记录的视觉噪音。
export function buildCollapsedGroupEl(count) {
  const el = document.createElement("div");
  el.className = "block-group";
  el.innerHTML = `
    <div class="group-header">
      <span class="group-arrow">&#9654;</span>
      <span class="group-label">中间过程 · ${count} 项</span>
    </div>
    <div class="group-detail"></div>
  `;
  const header = el.querySelector(".group-header");
  const arrow = el.querySelector(".group-arrow");
  const detail = el.querySelector(".group-detail");
  header.onclick = () => {
    detail.classList.toggle("open");
    arrow.classList.toggle("open");
  };
  return { el, detail };
}

export function renderConversationStep(step, container = chatLogEl) {
  if (step.type === "assistantMessage") {
    return appendMessageBubble("assistant", step.message.text, undefined, container);
  } else if (step.type === "thinkingMessage") {
    return appendThinkingBlock(step.message.text, container);
  } else if (step.type === "toolCall") {
    // step.message: { type: "shell"|..., args, result } —— result 是 unknown,防御式展示。
    // result.status 是 "success"|"error"(SDK discriminated union);之前这里写死成
    // "completed",导致 result.status === "error" 的调用在历史记录里也被涂成绿色,
    // 看不出曾经失败过。result 缺失(理论上 conversation() 只收纳已终结的调用,不应
    // 发生)时兜底按 completed 展示,不因为防御性判断反而更显眼地报错。
    const name = step.message?.type ?? "tool";
    const resultStatus = step.message?.result?.status;
    const status = resultStatus === "error" ? "error" : "completed";
    // 决策·createplan-as-assistant: 计划走气泡,不进工具卡。
    if (isCreatePlanTool(name)) {
      return appendCreatePlanBubble(
        { args: step.message?.args, status },
        container,
      );
    }
    return appendToolBlock(
      { name, status, args: step.message?.args, result: step.message?.result },
      container,
    );
  }
}

// 返回这批 steps 里最后一条可挂 meta 的气泡(assistant 正文或 createPlan;
// 可能不是 steps 末项,比如收尾是普通工具调用),供调用方挂模型/用量。
export function appendStepsWithCollapse(steps) {
  let lastAssistantEl;
  const track = (step, el) => {
    if (step.type === "assistantMessage") lastAssistantEl = el;
    // 决策·createplan-as-assistant: createPlan 作为末条主产出时也要挂 meta。
    else if (step.type === "toolCall" && isCreatePlanTool(step.message?.type)) {
      lastAssistantEl = el;
    }
  };
  if (steps.length <= 1) {
    for (const step of steps) track(step, renderConversationStep(step));
    return lastAssistantEl;
  }
  const middle = steps.slice(0, -1);
  const last = steps[steps.length - 1];
  const { el, detail } = buildCollapsedGroupEl(middle.length);
  for (const step of middle) track(step, renderConversationStep(step, detail));
  chatLogEl.appendChild(el);
  track(last, renderConversationStep(last));
  return lastAssistantEl;
}

export function renderShellTurn(turn) {
  if (turn.shellCommand) {
    appendToolBlock({ name: "shell", status: "completed", args: turn.shellCommand, result: turn.shellOutput });
  }
}

// messages.list() 的原始载荷是 protobuf-es 的 oneof 包装:
// message.turn = { case: "agentConversationTurn", value: { userMessage, steps } }
// (JSON.stringify 会把它序列化成 { agentConversationTurn: {...} } 这种更好看的形式,
// 但直接访问 JS 对象拿到的是 { case, value } 这层,两者不是一回事,取值时要认 case/value。)
export function renderFallbackMessage(m) {
  const turn = m.message?.turn;
  if (turn?.case !== "agentConversationTurn") {
    appendMessageBubble(m.type === "user" ? "user" : "assistant", safeStringify(m.message));
    return;
  }
  const value = turn.value ?? {};
  if (value.userMessage?.text) appendMessageBubble("user", value.userMessage.text);
  for (const step of value.steps ?? []) {
    const s = step.message;
    if (s?.case === "thinkingMessage") appendThinkingBlock(s.value?.text ?? "");
    else if (s?.case === "assistantMessage") appendMessageBubble("assistant", s.value?.text ?? "");
    else if (s?.case === "toolCall") appendToolBlock({ name: "tool", status: "completed", args: s.value, result: undefined });
  }
}

// scroll: "bottom"(默认,打开会话贴底) | "preserve"(Streaming 结束后 refetch,
// 保持用户当前阅读位置,不贴底)
export function renderHistory(data, { scroll = "bottom" } = {}) {
  stopTtsPlayback();
  const preservedTop = scroll === "preserve" ? chatLogEl.scrollTop : 0;
  chatLogEl.innerHTML = "";
  if (data.mode === "fallback") {
    for (const m of data.messages) renderFallbackMessage(m);
    if (!data.messages.length) chatLogEl.innerHTML = '<div class="empty">暂无历史消息</div>';
    if (scroll === "bottom") scrollChatToBottom({ force: true });
    else if (scroll === "preserve") chatLogEl.scrollTop = preservedTop;
    return;
  }

  let hasContent = false;
  for (const run of data.runs) {
    let lastAssistantEl;
    for (const turn of run.turns) {
      if (turn.type === "agentConversationTurn") {
        const t = turn.turn;
        if (t.userMessage?.text) {
          // 决策·side-store-by-runId / 决策·conversation-no-images: 缩略图不来自 SDK,
          // 只信 history 附带的旁路 URL(无则不画)。
          appendMessageBubble("user", t.userMessage.text, run.createdAt, chatLogEl, "none", {
            imageUrl: run.userImageUrl,
          });
          hasContent = true;
        }
        if ((t.steps ?? []).length) {
          const el = appendStepsWithCollapse(t.steps);
          if (el) lastAssistantEl = el;
          hasContent = true;
        }
      } else if (turn.type === "shellConversationTurn") {
        renderShellTurn(turn.turn);
        hasContent = true;
      }
    }
    if (run.status === "cancelled" || run.status === "error") {
      appendTurnStatusBanner(run.status);
      hasContent = true;
    } else {
      appendRunMeta(lastAssistantEl, run.model, run.usage, run.contextUsage);
      // 决策·createplan-no-tts: 计划气泡无 assistantMessage 正文可抽,不挂朗读。
      if (state.ttsEnabled && lastAssistantEl && !lastAssistantEl.dataset.createPlan) {
        appendTtsControls(lastAssistantEl, run.runId);
      }
    }
  }
  if (!hasContent) chatLogEl.innerHTML = '<div class="empty">暂无历史消息</div>';
  if (scroll === "bottom") scrollChatToBottom({ force: true });
  else if (scroll === "preserve") chatLogEl.scrollTop = preservedTop;
}

export { stopTtsPlayback };
