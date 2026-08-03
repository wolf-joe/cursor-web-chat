import {
  chatLogEl,
  chatTitleFolderTextEl,
  chatTitleAgentEl,
  headerMenuBtn,
  headerDropdown,
  headerNewConversationEl,
  headerRenameEl,
  headerUndoEl,
  headerRefreshEl,
  headerDeleteEl,
} from "./dom.js";
import { state, syncSessionUrl, loadSessionFromUrl } from "./state.js";
import { fetchConversation } from "./api.js";
import {
  setAgentStatus,
  setComposerEnabled,
  updateHeaderMenuState,
  renderHistory,
} from "./render.js";
import {
  loadFolders,
  closeSidebar,
  highlightActiveAgent,
  closeAllDropdowns,
  currentFolder,
  currentAgentInfo,
  renameAgentPrompt,
  undoLastTurnConfirm,
  deleteAgentConfirm,
  setSessionHooks,
  expandFolder,
} from "./sidebar.js";
import { loadModels, resetModelToDefault } from "./models.js";
import { detachStream, attachToStream } from "./stream.js";
import { refreshGitDirty, clearGitDirty } from "./gitStatus.js";
import { onCwdChangedForDiff } from "./gitDiff.js";
import { onCwdChangedForBrowser } from "./fileBrowser.js";
// composer.js / userSettings.js 没有需要在这里调用的导出——它们在模块加载时
// 就地绑定事件监听,这里只需要触发一次求值。
import "./composer.js";
import "./userSettings.js";

function resetChatView() {
  detachStream();
}

function startNewConversation(folder) {
  // 决策·model-session-scoped: 离开当前会话(含已有 agent → 新建)时拨回默认。
  const switchingAway = state.currentAgentId !== null || state.currentCwd !== folder.cwd;
  resetChatView();
  if (switchingAway) resetModelToDefault();
  state.currentCwd = folder.cwd;
  state.currentFolderName = folder.name;
  state.currentAgentId = null;
  state.currentAgentName = null;
  expandFolder(folder.cwd);
  highlightActiveAgent(null);
  chatTitleFolderTextEl.textContent = folder.name;
  chatTitleAgentEl.textContent = "新建会话";
  chatLogEl.innerHTML = '<div class="empty">发送第一条消息开始新会话</div>';
  setAgentStatus(null);
  updateHeaderMenuState();
  closeSidebar();
  syncSessionUrl();
  // currentCwd 刚更新完才能启用 composer——resetChatView 里做不到这一点(那时
  // currentCwd 还是切换前的旧值,刷新页面后就是 null,composer 会一直灰着)。
  setComposerEnabled(true);
  refreshGitDirty(folder.cwd);
  onCwdChangedForDiff(folder.cwd);
  onCwdChangedForBrowser(folder.cwd);
}

async function openConversation(folder, agentInfo) {
  // 决策·model-session-scoped: 仅切到其他会话时拨回默认;同会话再点/undo 重拉保留手选。
  const switchingAway =
    state.currentAgentId !== agentInfo.agentId || state.currentCwd !== folder.cwd;
  resetChatView();
  if (switchingAway) resetModelToDefault();
  state.currentCwd = folder.cwd;
  state.currentFolderName = folder.name;
  state.currentAgentId = agentInfo.agentId;
  state.currentAgentName = agentInfo.name || agentInfo.agentId;
  expandFolder(folder.cwd);
  highlightActiveAgent(agentInfo.agentId);
  chatTitleFolderTextEl.textContent = folder.name;
  chatTitleAgentEl.textContent = state.currentAgentName;
  chatLogEl.innerHTML = '<div class="loading">加载历史…</div>';
  setAgentStatus(agentInfo.cached ? "active" : "cold");
  updateHeaderMenuState();
  closeSidebar();
  syncSessionUrl();
  setComposerEnabled(true);
  refreshGitDirty(folder.cwd);
  onCwdChangedForDiff(folder.cwd);
  onCwdChangedForBrowser(folder.cwd);

  let data;
  try {
    data = await fetchConversation(agentInfo.agentId, folder.cwd);
  } catch {
    data = { error: "加载失败" };
  }
  // 决策·url-degrade: agent 失效或打开失败 → 该 cwd 新建(URL 仅留 cwd)。
  // 若用户已切走则不要抢回新建态。
  if (data.error) {
    if (state.currentAgentId === agentInfo.agentId && state.currentCwd === folder.cwd) {
      startNewConversation(folder);
    }
    return;
  }
  if (state.currentAgentId !== agentInfo.agentId || state.currentCwd !== folder.cwd) return;
  renderHistory(data);
  // 决策·unified-sse-path: 打开时若这个 agent 正有 run 在跑(liveRun,见
  // src/server.ts /api/conversation),直接接入直播尾巴,而不是等用户手动刷新
  // 才发现"其实还在生成"。
  if (data.liveRun) attachToStream(agentInfo.agentId, folder.cwd);
}

setSessionHooks({ startNewConversation, openConversation });

/** 决策·url-shape / 决策·url-degrade / 决策·default-first-folder:
 * 启动只读地址栏;有 cwd 则恢复;非法 cwd 落到默认文件夹;无参首页自动选列表第一项进入新建。
 * 「第一项」= API 已排好的顺序(置顶区 config 书写首位;无置顶则 name 字符序首位)。 */
function restoreFromUrl() {
  const saved = loadSessionFromUrl();
  if (!saved) {
    const folder = state.folders[0];
    if (folder) startNewConversation(folder);
    return;
  }
  const folder = state.folders.find((f) => f.cwd === saved.cwd);
  if (!folder) {
    const fallback = state.folders[0];
    if (fallback) startNewConversation(fallback);
    else syncSessionUrl();
    return;
  }
  if (!saved.agentId) {
    startNewConversation(folder);
    return;
  }
  // 侧边栏分页加载:会话可能不在第一页——最小 agentInfo 直接打开。
  // 决策·name-memory-only: name 优先列表权威值;不在已加载页则先用 agentId。
  const agentInfo = folder.agents.find((a) => a.agentId === saved.agentId) ?? {
    agentId: saved.agentId,
    name: saved.agentId,
    cached: false,
  };
  openConversation(folder, agentInfo);
}

headerMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  headerDropdown.classList.toggle("open");
});
headerNewConversationEl.addEventListener("click", () => {
  closeAllDropdowns();
  if (state.currentCwd === null) return;
  startNewConversation(currentFolder());
});
headerRenameEl.addEventListener("click", () => {
  closeAllDropdowns();
  if (!state.currentAgentId) return;
  renameAgentPrompt(currentFolder(), currentAgentInfo());
});
headerUndoEl.addEventListener("click", () => {
  closeAllDropdowns();
  if (!state.currentAgentId) return;
  undoLastTurnConfirm(currentFolder(), currentAgentInfo());
});
// 决策·header-refresh: PWA standalone 无浏览器刷新钮;整页 reload,URL 里 cwd/agent 会经
// restoreFromUrl 把当前会话/新建态拉回来。
headerRefreshEl.addEventListener("click", () => {
  closeAllDropdowns();
  location.reload();
});
headerDeleteEl.addEventListener("click", () => {
  closeAllDropdowns();
  if (!state.currentAgentId) return;
  deleteAgentConfirm(currentFolder(), currentAgentInfo());
});

loadModels();
loadFolders().then(restoreFromUrl);

// 决策·pwa-scroll-restore: Android PWA reload 偶发恢复文档滚动偏移,底部被裁;
// 关掉自动恢复并钉回顶部(与 style 里 fixed .app 互补)。
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

// 决策·pwa-sw-register: 注册透传 SW,使 HTTPS 下可「安装应用」进独立任务。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 人在 IDE/终端改完文件切回浏览器时补一次,避免标记长期过时。
window.addEventListener("focus", () => {
  if (state.currentCwd) refreshGitDirty(state.currentCwd);
});

// 模块加载时若还没选文件夹,确保标记是隐藏的(index.html 里已 hidden)。
clearGitDirty();
