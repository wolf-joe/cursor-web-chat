import {
  folderListEl,
  sidebarEl,
  sidebarBackdropEl,
  menuToggleEl,
  chatTitleAgentEl,
  chatLogEl,
  addFolderBtn,
  addFolderForm,
  addFolderPathInput,
  addFolderNameInput,
  addFolderSubmitBtn,
  addFolderCancelBtn,
  addFolderErrorEl,
  undoModalOverlay,
  undoModalClose,
  undoModalCancel,
  undoModalConfirm,
  undoUserTextInput,
} from "./dom.js";
import { state } from "./state.js";
import {
  fetchFolders,
  createFolder,
  fetchAgentsPage,
  renameAgentApi,
  deleteAgentApi,
  undoLastTurnApi,
} from "./api.js";
import { escapeHtml } from "./render.js";

// 侧边栏对"删除/撤销正好命中当前打开会话"这两种场景需要联动主视图切换,但
// sidebar.js 不直接 import app.js(决策·es-module-refactor,避免循环引用)——
// 由 app.js 启动时通过 setSessionHooks 注入。
let sessionHooks = { startNewConversation: () => {}, openConversation: async () => {} };
export function setSessionHooks(hooks) {
  sessionHooks = hooks;
}

export function closeSidebar() {
  sidebarEl.classList.remove("open");
  sidebarBackdropEl.classList.remove("show");
}

export function toggleSidebar() {
  sidebarEl.classList.toggle("open");
  sidebarBackdropEl.classList.toggle("show");
}

menuToggleEl.addEventListener("click", toggleSidebar);
sidebarBackdropEl.addEventListener("click", closeSidebar);

export async function loadFolders() {
  const data = await fetchFolders();
  state.folders = data.folders;
  renderFolders();
}

// 手风琴态:同一时间最多展开一个文件夹,记在模块内(不进 state.js——纯 UI 展开状态,
// 与会话数据无关)。整体重渲染沿用 CLAUDE.md §4 里说的既有简化取舍,不做局部 DOM patch。
let expandedFolderCwd = undefined; // undefined = 还没手动展开过,首次渲染按当前会话所在文件夹展开

// 供 app.js 在切换会话时(新建/打开、含刷新页面后 restoreSession 的路径)同步展开态——
// 这些路径不一定经过 header 点击,不然手风琴状态会和实际打开的会话对不上。
// 已经是目标文件夹时不重渲,避免"点同文件夹内某个会话"这种高频路径也整体重建 DOM。
export function expandFolder(cwd) {
  if (expandedFolderCwd === cwd) return;
  expandedFolderCwd = cwd;
  renderFolders();
}

// ── 添加文件夹 ──

function toggleAddFolderForm(show) {
  addFolderForm.classList.toggle("open", show);
  addFolderErrorEl.textContent = "";
  if (show) {
    addFolderPathInput.value = "~/git/";
    addFolderNameInput.value = "";
    addFolderPathInput.focus();
    addFolderPathInput.setSelectionRange(addFolderPathInput.value.length, addFolderPathInput.value.length);
  }
}

addFolderBtn.addEventListener("click", () => toggleAddFolderForm(!addFolderForm.classList.contains("open")));
addFolderCancelBtn.addEventListener("click", () => toggleAddFolderForm(false));

async function submitAddFolder() {
  const cwd = addFolderPathInput.value.trim();
  if (!cwd) {
    addFolderErrorEl.textContent = "请输入文件夹路径";
    return;
  }
  const name = addFolderNameInput.value.trim();

  addFolderSubmitBtn.disabled = true;
  try {
    const { ok, data } = await createFolder(cwd, name || undefined);
    if (!ok) {
      addFolderErrorEl.textContent = data.error || "添加失败";
      return;
    }
    toggleAddFolderForm(false);
    await loadFolders();
  } finally {
    addFolderSubmitBtn.disabled = false;
  }
}

addFolderSubmitBtn.addEventListener("click", submitAddFolder);
for (const input of [addFolderPathInput, addFolderNameInput]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddFolder();
  });
}

export function renderFolders() {
  if (expandedFolderCwd === undefined) expandedFolderCwd = state.currentCwd ?? state.folders[0]?.cwd ?? null;

  // 决策·folder-pin: 置顶区与非置顶区互斥渲染;分隔线仅在两侧都非空时出现。
  const pinned = state.folders.filter((f) => f.pinned);
  const rest = state.folders.filter((f) => !f.pinned);

  folderListEl.innerHTML = "";
  for (const folder of pinned) {
    folderListEl.appendChild(buildFolderGroup(folder));
  }
  if (pinned.length > 0 && rest.length > 0) {
    const divider = document.createElement("div");
    divider.className = "folder-pin-divider";
    divider.setAttribute("aria-hidden", "true");
    folderListEl.appendChild(divider);
  }
  for (const folder of rest) {
    folderListEl.appendChild(buildFolderGroup(folder));
  }
  // 决策·highlight-after-render: 整体重渲会丢掉 .active(加载更多 / 手风琴 /
  // 标题刷新都走这里);按 currentAgentId 重点——不在已加载页时安静跳过,翻到再亮。
  highlightActiveAgent(state.currentAgentId);
}

function folderHasCachedAgent(folder) {
  return folder.agents?.some((a) => a.cached) === true;
}

function buildFolderGroup(folder) {
  const isOpen = folder.cwd === expandedFolderCwd;
  // 与会话圆点同一套「活跃」语义:文件夹下任一会话在内存缓存中时,把数量 badge 点绿,
  // 收起态也能一眼看出哪个文件夹里有热会话。
  const hasActive = folderHasCachedAgent(folder);

  const group = document.createElement("div");
  group.className = `folder-group${folder.pinned ? " pinned" : ""}`;
  group.dataset.cwd = folder.cwd;

  const header = document.createElement("div");
  header.className = "folder-header";
  header.innerHTML = `
    <span class="arrow${isOpen ? " open" : ""}">&#9654;</span>
    <span class="folder-name" title="${escapeHtml(folder.cwd)}">${escapeHtml(folder.name)}</span>
    <span class="badge${hasActive ? " active" : ""}" title="${hasActive ? "有活跃会话 · 内存中" : ""}">${formatAgentCount(folder.agentCount)}</span>
    <button class="folder-add-btn" title="新建会话">+</button>
  `;

  const agentsEl = document.createElement("div");
  agentsEl.className = `folder-agents${isOpen ? " open" : ""}`;

  // 会话列表按后端分页顺序(updatedAt desc)展示,不再客户端重排。
  for (const agent of folder.agents) {
    agentsEl.appendChild(buildAgentItemRow(folder, agent));
  }

  if (folder.nextCursor) {
    const loadMoreItem = document.createElement("div");
    loadMoreItem.className = "load-more-item";
    loadMoreItem.textContent = "加载更多";
    loadMoreItem.onclick = () => loadMoreAgents(folder);
    agentsEl.appendChild(loadMoreItem);
  }

  // 手风琴:点开的这个如果已经展开就收起,否则展开它、同时收起其余所有——
  // 靠整体重渲染实现,而不是手动摘掉别的 folder-group 的 open class。
  header.onclick = () => {
    expandedFolderCwd = isOpen ? null : folder.cwd;
    renderFolders();
  };
  header.querySelector(".folder-add-btn").onclick = (e) => {
    e.stopPropagation();
    sessionHooks.startNewConversation(folder);
  };

  group.appendChild(header);
  group.appendChild(agentsEl);
  return group;
}

function buildAgentItemRow(folder, agent) {
  const row = document.createElement("div");
  row.className = "agent-item-row";
  row.dataset.agentId = agent.agentId;

  const item = document.createElement("div");
  item.className = "agent-item";
  item.title = agent.summary || agent.name;
  item.onclick = () => sessionHooks.openConversation(folder, agent);

  // 与顶部 chat-header 的 agentStatus 圆点同一套含义: 绿色 = agent 句柄在内存缓存中
  // (续聊无需 resume),灰色 = 冷启动。见 render.js 的 setAgentStatus()。
  const dot = document.createElement("span");
  dot.className = `agent-item-dot ${agent.cached ? "active" : "cold"}`;
  dot.title = agent.cached ? "活跃 · 内存中,续聊无需重新连接" : "冷启动,发消息时需先恢复 agent";
  item.appendChild(dot);
  item.appendChild(document.createTextNode(agent.name || agent.agentId));

  const menuBtn = document.createElement("button");
  menuBtn.className = "agent-menu-btn";
  menuBtn.title = "更多操作";
  menuBtn.innerHTML = "&#8942;";

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  menu.innerHTML = `
    <div class="dropdown-item" data-action="rename">重命名</div>
    <div class="dropdown-item danger" data-action="delete">删除</div>
  `;
  menu.querySelector('[data-action="rename"]').onclick = (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    renameAgentPrompt(folder, agent);
  };
  menu.querySelector('[data-action="delete"]').onclick = (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    deleteAgentConfirm(folder, agent);
  };

  menuBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains("open");
    closeAllDropdowns();
    if (!isOpen) menu.classList.add("open");
  };

  row.appendChild(item);
  row.appendChild(menuBtn);
  row.appendChild(menu);
  return row;
}

export function highlightActiveAgent(agentId) {
  document.querySelectorAll(".agent-item-row").forEach((el) => {
    el.classList.toggle("active", el.dataset.agentId === agentId);
  });
}

// 只在流式过程中把已渲染的这一行圆点点绿,不调用 renderFolders() 整体重渲染——
// 后者会把所有文件夹的展开状态重置为 open,若在同一会话里频繁触发会把用户手动
// 收起的文件夹重新展开。真正的数据(folder.agents[].cached)靠 loadFolders() 兜底刷新。
export function markAgentCachedInSidebar(agentId) {
  const folder = currentFolder();
  const agentInfo = folder?.agents?.find((a) => a.agentId === agentId);
  if (agentInfo) agentInfo.cached = true;

  document.querySelectorAll(".agent-item-row").forEach((row) => {
    if (row.dataset.agentId !== agentId) return;
    const dot = row.querySelector(".agent-item-dot");
    if (!dot) return;
    dot.classList.add("active");
    dot.classList.remove("cold");
    dot.title = "活跃 · 内存中,续聊无需重新连接";
  });

  // 同步点绿所属文件夹的数量 badge(收起态也能看见)。
  const cwd = folder?.cwd;
  if (!cwd) return;
  document.querySelectorAll(".folder-group").forEach((group) => {
    if (group.dataset.cwd !== cwd) return;
    const badge = group.querySelector(".folder-header .badge");
    if (!badge) return;
    badge.classList.add("active");
    badge.title = "有活跃会话 · 内存中";
  });
}

export function closeAllDropdowns() {
  document.querySelectorAll(".dropdown-menu.open").forEach((el) => el.classList.remove("open"));
}
document.addEventListener("click", closeAllDropdowns);

async function loadMoreAgents(folder) {
  const data = await fetchAgentsPage(folder.cwd, folder.nextCursor);
  if (data.error) {
    alert(data.error);
    return;
  }
  folder.agents = [...folder.agents, ...data.agents];
  folder.nextCursor = data.nextCursor;
  // 翻到当前会话所在页时,用列表权威 name 校正标题栏(决策·name-memory-only)。
  if (state.currentAgentId && folder.cwd === state.currentCwd) {
    const appeared = data.agents.find((a) => a.agentId === state.currentAgentId);
    if (appeared?.name && appeared.name !== state.currentAgentName) {
      state.currentAgentName = appeared.name;
      chatTitleAgentEl.textContent = appeared.name;
    }
  }
  renderFolders();
}

// ── 会话重命名 / 撤销 / 删除 ──

export async function renameAgentPrompt(folder, agentInfo) {
  const input = window.prompt("重命名会话", agentInfo.name || "");
  if (input === null) return;
  const name = input.trim();
  if (!name || name === agentInfo.name) return;

  const { ok, data } = await renameAgentApi(folder.cwd, agentInfo.agentId, name);
  if (!ok) {
    alert(data.error || "重命名失败");
    return;
  }
  agentInfo.name = name;
  if (state.currentAgentId === agentInfo.agentId) {
    state.currentAgentName = name;
    chatTitleAgentEl.textContent = name;
  }
  renderFolders();
}

// 决策·undo-last-turn: 只撤销链条末尾那一轮,后端 undoLastTurn 也只认"当前最后
// 一轮"(不接受指定 runId)——撤销后直接重新拉一次 /api/conversation 整体重渲染,
// 而不是手动摘掉最后一对气泡,省得跟"到底哪几个 DOM 节点属于最后一轮"这件事对齐。
// 决策·undo-confirm-copy: 不用 window.confirm——弹 modal 展示上一轮用户原文,
// 方便复制后再点确认;原文取自用户气泡 data-raw-text(见 render.appendMessageBubble)。
let undoPending = null; // { folder, agentInfo } | null
let undoSubmitting = false;

function getLastUserMessageText() {
  const nodes = chatLogEl.querySelectorAll(".msg.user");
  const last = nodes[nodes.length - 1];
  return last?.dataset.rawText ?? "";
}

function closeUndoModal() {
  if (undoSubmitting) return;
  undoPending = null;
  undoModalOverlay.classList.remove("open");
  undoUserTextInput.value = "";
}

function openUndoModal(folder, agentInfo) {
  undoPending = { folder, agentInfo };
  undoUserTextInput.value = getLastUserMessageText();
  undoModalOverlay.classList.add("open");
  // 打开即全选,方便 Cmd/Ctrl+C 复制。
  requestAnimationFrame(() => {
    undoUserTextInput.focus();
    undoUserTextInput.select();
  });
}

async function submitUndo() {
  if (!undoPending || undoSubmitting) return;
  const { folder, agentInfo } = undoPending;
  undoSubmitting = true;
  undoModalConfirm.disabled = true;
  undoModalCancel.disabled = true;
  undoModalClose.disabled = true;
  try {
    const { ok, data } = await undoLastTurnApi(folder.cwd, agentInfo.agentId);
    if (!ok) {
      alert(data.error || "撤销失败");
      return;
    }
    undoPending = null;
    undoModalOverlay.classList.remove("open");
    undoUserTextInput.value = "";
    if (state.currentAgentId === agentInfo.agentId) await sessionHooks.openConversation(folder, agentInfo);
  } finally {
    undoSubmitting = false;
    undoModalConfirm.disabled = false;
    undoModalCancel.disabled = false;
    undoModalClose.disabled = false;
  }
}

export function undoLastTurnConfirm(folder, agentInfo) {
  if (undoModalOverlay.classList.contains("open") || undoSubmitting) return;
  openUndoModal(folder, agentInfo);
}

undoModalClose.addEventListener("click", closeUndoModal);
undoModalCancel.addEventListener("click", closeUndoModal);
undoModalOverlay.addEventListener("click", (e) => {
  if (e.target === undoModalOverlay) closeUndoModal();
});
undoModalConfirm.addEventListener("click", () => {
  submitUndo();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!undoModalOverlay.classList.contains("open")) return;
  e.preventDefault();
  closeUndoModal();
});

export async function deleteAgentConfirm(folder, agentInfo) {
  const label = agentInfo.name || agentInfo.agentId;
  if (!window.confirm(`确定删除会话「${label}」吗?此操作不可撤销。`)) return;

  const { ok, data } = await deleteAgentApi(folder.cwd, agentInfo.agentId);
  if (!ok) {
    alert(data.error || "删除失败");
    return;
  }
  if (folder.agents) folder.agents = folder.agents.filter((a) => a.agentId !== agentInfo.agentId);
  if (typeof folder.agentCount === "number" && folder.agentCount > 0) folder.agentCount -= 1;
  if (state.currentAgentId === agentInfo.agentId) sessionHooks.startNewConversation(folder);
  renderFolders();
}

/** 决策·agent-count-cap: 侧边栏只关心量级,≥100 压成 99+,避免 badge 被三位数撑开。 */
function formatAgentCount(n) {
  const count = typeof n === "number" && n > 0 ? n : 0;
  return count > 99 ? "99+" : String(count);
}

// 当前会话所在的 folder 对象(chat-header 下拉菜单要用,复用 state.folders 里
// 那份引用,而不是重新拼一个游离对象,这样改名/删除后 renderFolders() 才能同步)。
export function currentFolder() {
  return (
    state.folders.find((f) => f.cwd === state.currentCwd) ?? { cwd: state.currentCwd, name: state.currentFolderName }
  );
}

export function currentAgentInfo() {
  const folder = currentFolder();
  return (
    folder.agents?.find((a) => a.agentId === state.currentAgentId) ?? {
      agentId: state.currentAgentId,
      name: state.currentAgentName || chatTitleAgentEl.textContent,
    }
  );
}
