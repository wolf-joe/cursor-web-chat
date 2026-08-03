// 决策·independent-overlay / 决策·overlay-shell / 决策·lazy-tree /
// 决策·keep-stream / 决策·overlay-mutex / 决策·plain-at-path /
// 决策·insert-at-cursor / 决策·insert-spacing / 决策·close-on-insert /
// 决策·refresh-ux / 决策·browse-enabled / 决策·highlight-cdn /
// 决策·md-preview-msg-text / 决策·flat-results / 决策·search-on-enter /
// 决策·clear-restores-tree / 决策·empty-query-resets /
// 决策·esc-clears-search-first / 决策·header-search-ui:
// 独立近全宽 Overlay 懒加载浏览 cwd 文件树、只读预览,并把 ` @绝对路径 `
// 插进 composer 光标处后关闭 Overlay。顶栏回车按相对路径子串搜,左栏切扁列表;
// 清空/空白回树根。打开/关闭不 detachStream;与 diff Overlay 互斥;无刷新按钮——
// 关后再开即整树重拉。MD 预览复用 `.msg-text`。
import {
  browseFolderBtn,
  fileBrowserOverlay,
  fileBrowserFolder,
  fileBrowserSearch,
  fileBrowserClose,
  fileBrowserBanner,
  fileBrowserTree,
  fileBrowserPreview,
  fileBrowserInsertBtn,
  fileBrowserPreviewPath,
  composerInput,
} from "./dom.js";
import { state } from "./state.js";
import { fetchFsList, fetchFsRead, fetchFsSearch } from "./api.js";
import { escapeHtml, renderMarkdown } from "./render.js";
import { hydrateMermaid } from "./mermaidHydrate.js";
import { autoGrowComposer } from "./composer.js";

let open = false;
let requestSeq = 0;
let openCwd = null;
/** @type {string | null} */
let selectedPath = null;
/** 决策·flat-results: 左栏双态 tree | results */
let viewMode = "tree";

const TRUNCATE_BANNER = {
  hit_limit: "命中过多，仅展示前 100 项",
  node_limit: "扫描节点达上限，结果可能不完整",
  timeout: "搜索超时，结果可能不完整",
};

function isOpen() {
  return open;
}

function setBanner(text, { error = false } = {}) {
  if (!text) {
    fileBrowserBanner.hidden = true;
    fileBrowserBanner.textContent = "";
    fileBrowserBanner.classList.remove("error");
    return;
  }
  fileBrowserBanner.hidden = false;
  fileBrowserBanner.textContent = text;
  fileBrowserBanner.classList.toggle("error", error);
}

function updateInsertButton() {
  fileBrowserInsertBtn.disabled = !open || !selectedPath;
  fileBrowserPreviewPath.textContent = selectedPath || "";
  fileBrowserPreviewPath.title = selectedPath || "";
}

function renderPreviewEmpty(msg = "选择左侧文件预览") {
  fileBrowserPreview.innerHTML = `<div class="diff-content-empty">${escapeHtml(msg)}</div>`;
}

function renderPreviewSkipped(message) {
  fileBrowserPreview.innerHTML = `<div class="diff-content-skipped">${escapeHtml(message || "已跳过")}</div>`;
}

function renderPreviewContent(filePath, content, language) {
  const isMd = language === "markdown" || /\.(md|markdown)$/i.test(filePath);
  if (isMd) {
    // 决策·md-preview-msg-text: 与 AI 消息卡片共用 `.msg-text` 样式
    // (表格边框、列表缩进等),`.fb-md-preview` 只负责预览区 padding。
    fileBrowserPreview.innerHTML = `<div class="msg-text fb-md-preview">${renderMarkdown(content)}</div>`;
    void hydrateMermaid(fileBrowserPreview);
    return;
  }

  if (typeof hljs !== "undefined") {
    let html;
    try {
      if (language && hljs.getLanguage(language)) {
        html = hljs.highlight(content, { language }).value;
      } else {
        html = hljs.highlightAuto(content).value;
      }
    } catch {
      html = escapeHtml(content);
    }
    fileBrowserPreview.innerHTML = `<pre class="fb-code"><code class="hljs">${html}</code></pre>`;
    return;
  }

  fileBrowserPreview.innerHTML = `<pre class="fb-code"><code>${escapeHtml(content)}</code></pre>`;
}

/** 决策·symlink-mark: 软链接名后加 @,悬停展示 path → target */
function appendSymlinkMark(row, entry) {
  if (!entry.symlink) return;
  const mark = document.createElement("span");
  mark.className = "fb-symlink-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "@";
  row.appendChild(mark);
  if (entry.linkTarget) {
    row.title = `${entry.path} → ${entry.linkTarget}`;
  }
}

function makeTreeItem(entry) {
  const li = document.createElement("li");
  li.className = `fb-tree-item fb-${entry.type}`;
  li.dataset.path = entry.path;
  li.dataset.type = entry.type;

  const row = document.createElement("button");
  row.type = "button";
  row.className = "fb-tree-row";
  row.title = entry.path;

  if (entry.type === "dir") {
    const twisty = document.createElement("span");
    twisty.className = "fb-twisty";
    twisty.textContent = "▸";
    row.appendChild(twisty);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "fb-twisty-spacer";
    row.appendChild(spacer);
  }

  const name = document.createElement("span");
  name.className = "fb-tree-name";
  name.textContent = entry.name;
  row.appendChild(name);
  appendSymlinkMark(row, entry);

  li.appendChild(row);

  if (entry.type === "dir") {
    const children = document.createElement("ul");
    children.className = "fb-tree-children";
    children.hidden = true;
    li.appendChild(children);
  }

  return li;
}

/** 决策·flat-results: 扁列表行展示 relativePath,dataset 仍用绝对 path */
function makeResultItem(match) {
  const li = document.createElement("li");
  li.className = "fb-tree-item fb-file fb-search-hit";
  li.dataset.path = match.path;
  li.dataset.type = "file";

  const row = document.createElement("button");
  row.type = "button";
  row.className = "fb-tree-row";
  row.title = match.path;

  const spacer = document.createElement("span");
  spacer.className = "fb-twisty-spacer";
  row.appendChild(spacer);

  const name = document.createElement("span");
  name.className = "fb-tree-name";
  name.textContent = match.relativePath || match.name;
  row.appendChild(name);
  appendSymlinkMark(row, match);

  li.appendChild(row);
  return li;
}

async function loadDirInto(ul, dirPath, cwd) {
  const seq = ++requestSeq;
  const placeholder = document.createElement("li");
  placeholder.className = "fb-tree-status";
  placeholder.textContent = "加载中…";
  ul.appendChild(placeholder);

  try {
    const data = await fetchFsList(cwd, dirPath);
    if (seq !== requestSeq || !open || cwd !== openCwd) return;

    ul.innerHTML = "";
    if (data.error) {
      const errLi = document.createElement("li");
      errLi.className = "fb-tree-status error";
      errLi.textContent = data.error;
      ul.appendChild(errLi);
      return;
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "fb-tree-status";
      empty.textContent = "空目录";
      ul.appendChild(empty);
    } else {
      for (const entry of entries) {
        ul.appendChild(makeTreeItem(entry));
      }
    }

    if (data.truncated) {
      setBanner(`该目录条目过多，仅展示前 ${entries.length} 项`);
    }
  } catch (err) {
    if (seq !== requestSeq || !open || cwd !== openCwd) return;
    ul.innerHTML = "";
    const errLi = document.createElement("li");
    errLi.className = "fb-tree-status error";
    errLi.textContent = err instanceof Error ? err.message : String(err);
    ul.appendChild(errLi);
  }
}

/** 决策·clear-restores-tree: 恢复懒加载树根,不保留搜索前展开态 */
async function loadRoot(cwd) {
  viewMode = "tree";
  setBanner("");
  selectedPath = null;
  updateInsertButton();
  renderPreviewEmpty();
  fileBrowserTree.innerHTML = "";
  const rootUl = document.createElement("ul");
  rootUl.className = "fb-tree-root";
  fileBrowserTree.appendChild(rootUl);
  await loadDirInto(rootUl, cwd, cwd);
}

function renderSearchResults(matches, truncated, truncateReason) {
  viewMode = "results";
  selectedPath = null;
  updateInsertButton();
  renderPreviewEmpty();
  fileBrowserTree.innerHTML = "";

  const ul = document.createElement("ul");
  ul.className = "fb-search-results";
  fileBrowserTree.appendChild(ul);

  if (!matches.length) {
    const empty = document.createElement("li");
    empty.className = "fb-tree-status";
    empty.textContent = "无匹配文件";
    ul.appendChild(empty);
  } else {
    for (const match of matches) {
      ul.appendChild(makeResultItem(match));
    }
  }

  if (truncated) {
    setBanner(TRUNCATE_BANNER[truncateReason] || "结果已截断，可能不完整");
  } else {
    setBanner("");
  }
}

/** 决策·search-on-enter / 决策·empty-query-resets / 决策·flat-results */
async function runSearch() {
  if (!open || !openCwd) return;
  const q = (fileBrowserSearch.value || "").trim();
  // 决策·empty-query-resets: 空白不调 search API,直接回树
  if (!q) {
    await loadRoot(openCwd);
    return;
  }

  const seq = ++requestSeq;
  const cwd = openCwd;
  setBanner("");
  fileBrowserTree.innerHTML = "";
  const status = document.createElement("li");
  status.className = "fb-tree-status";
  status.textContent = "搜索中…";
  const ul = document.createElement("ul");
  ul.className = "fb-search-results";
  ul.appendChild(status);
  fileBrowserTree.appendChild(ul);
  viewMode = "results";
  selectedPath = null;
  updateInsertButton();
  renderPreviewEmpty();

  try {
    const data = await fetchFsSearch(cwd, q);
    if (seq !== requestSeq || !open || cwd !== openCwd) return;

    if (data.error) {
      fileBrowserTree.innerHTML = "";
      const errUl = document.createElement("ul");
      errUl.className = "fb-search-results";
      const errLi = document.createElement("li");
      errLi.className = "fb-tree-status error";
      errLi.textContent = data.error;
      errUl.appendChild(errLi);
      fileBrowserTree.appendChild(errUl);
      setBanner("");
      return;
    }

    const matches = Array.isArray(data.matches) ? data.matches : [];
    renderSearchResults(matches, Boolean(data.truncated), data.truncateReason);
  } catch (err) {
    if (seq !== requestSeq || !open || cwd !== openCwd) return;
    fileBrowserTree.innerHTML = "";
    const errUl = document.createElement("ul");
    errUl.className = "fb-search-results";
    const errLi = document.createElement("li");
    errLi.className = "fb-tree-status error";
    errLi.textContent = err instanceof Error ? err.message : String(err);
    errUl.appendChild(errLi);
    fileBrowserTree.appendChild(errUl);
  }
}

async function selectFile(filePath) {
  if (!open || !openCwd) return;
  selectedPath = filePath;
  updateInsertButton();

  for (const row of fileBrowserTree.querySelectorAll(".fb-tree-row")) {
    const li = row.closest(".fb-tree-item");
    row.classList.toggle("active", li?.dataset.path === filePath);
  }

  const seq = ++requestSeq;
  fileBrowserPreview.innerHTML = '<div class="diff-content-empty">加载中…</div>';

  try {
    const data = await fetchFsRead(openCwd, filePath);
    if (seq !== requestSeq || !open || openCwd !== state.currentCwd) return;
    // 用户可能在请求返回前又点了别的文件
    if (selectedPath !== filePath) return;

    if (data.error) {
      renderPreviewSkipped(data.error);
      return;
    }
    if (data.skipped) {
      renderPreviewSkipped(data.skipped.message || "已跳过");
      return;
    }
    if (data.content == null) {
      renderPreviewEmpty("无内容");
      return;
    }
    renderPreviewContent(filePath, data.content, data.language);
  } catch (err) {
    if (seq !== requestSeq || !open || selectedPath !== filePath) return;
    renderPreviewSkipped(err instanceof Error ? err.message : String(err));
  }
}

async function toggleDir(li) {
  if (!open || !openCwd || viewMode !== "tree") return;
  const children = li.querySelector(":scope > .fb-tree-children");
  const twisty = li.querySelector(":scope > .fb-tree-row > .fb-twisty");
  if (!children) return;

  const expanding = children.hidden;
  if (expanding) {
    children.hidden = false;
    if (twisty) twisty.textContent = "▾";
    li.classList.add("expanded");
    if (!li.dataset.loaded) {
      li.dataset.loaded = "1";
      children.innerHTML = "";
      await loadDirInto(children, li.dataset.path, openCwd);
    }
  } else {
    children.hidden = true;
    if (twisty) twisty.textContent = "▸";
    li.classList.remove("expanded");
  }
}

/** 决策·insert-spacing / 决策·insert-at-cursor / 决策·plain-at-path /
 *  决策·abs-path / 决策·close-on-insert */
function insertSelectedPath() {
  if (!selectedPath || composerInput.disabled) return;
  const ta = composerInput;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const snippet = ` @${selectedPath} `;
  ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(end);
  const pos = start + snippet.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
  autoGrowComposer();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  // 决策·close-on-insert: 路径已进 composer,继续留在 Overlay 无意义;
  // 还要插更多就再开浏览。不 detachStream。
  closeFileBrowser();
}

async function closeOtherOverlay() {
  // 决策·overlay-mutex: 动态 import 避免与 gitDiff.js 静态成环。
  const { closeDiffOverlay, isDiffOverlayOpen } = await import("./gitDiff.js");
  if (isDiffOverlayOpen()) closeDiffOverlay();
}

function clearSearchUi() {
  fileBrowserSearch.value = "";
}

export async function openFileBrowser(cwd = state.currentCwd) {
  if (!cwd) return;
  await closeOtherOverlay();
  open = true;
  openCwd = cwd;
  selectedPath = null;
  viewMode = "tree";
  clearSearchUi();
  fileBrowserFolder.textContent = state.currentFolderName || cwd;
  fileBrowserOverlay.hidden = false;
  fileBrowserOverlay.classList.add("open");
  updateInsertButton();
  // 决策·keep-stream: 只盖 UI,绝不 detachStream。
  // 决策·refresh-ux: 每次打开从根重新懒加载。
  await loadRoot(cwd);
  fileBrowserSearch.focus();
}

export function closeFileBrowser() {
  if (!open) return;
  open = false;
  openCwd = null;
  requestSeq += 1;
  selectedPath = null;
  viewMode = "tree";
  clearSearchUi();
  fileBrowserOverlay.classList.remove("open");
  fileBrowserOverlay.hidden = true;
  setBanner("");
  fileBrowserTree.innerHTML = "";
  renderPreviewEmpty();
  updateInsertButton();
}

/** 切换会话/文件夹时调用:若 Overlay 开着则按新 cwd 重拉,避免串数据。 */
export function onCwdChangedForBrowser(cwd) {
  if (!open) return;
  if (!cwd) {
    closeFileBrowser();
    return;
  }
  openCwd = cwd;
  selectedPath = null;
  viewMode = "tree";
  clearSearchUi();
  fileBrowserFolder.textContent = state.currentFolderName || cwd;
  loadRoot(cwd);
}

browseFolderBtn.addEventListener("click", () => {
  if (browseFolderBtn.disabled || !state.currentCwd) return;
  openFileBrowser(state.currentCwd);
});

fileBrowserClose.addEventListener("click", closeFileBrowser);
fileBrowserOverlay.addEventListener("click", (e) => {
  if (e.target === fileBrowserOverlay) closeFileBrowser();
});

fileBrowserTree.addEventListener("click", (e) => {
  const row = e.target.closest(".fb-tree-row");
  if (!row) return;
  const li = row.closest(".fb-tree-item");
  if (!li) return;
  if (li.dataset.type === "dir") {
    toggleDir(li);
  } else {
    selectFile(li.dataset.path);
  }
});

fileBrowserInsertBtn.addEventListener("click", insertSelectedPath);

fileBrowserSearch.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  runSearch();
});

// 决策·clear-restores-tree: 清空控件同效回树(含 type=search 的清除按钮)
fileBrowserSearch.addEventListener("input", () => {
  if (!open || !openCwd) return;
  if ((fileBrowserSearch.value || "").trim()) return;
  if (viewMode === "tree") return;
  loadRoot(openCwd);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!open) return;
  e.preventDefault();
  // 决策·esc-clears-search-first: 有查询内容或结果态先清空回树,否则关 Overlay
  const hasQuery = Boolean((fileBrowserSearch.value || "").trim());
  if (hasQuery || viewMode === "results") {
    clearSearchUi();
    if (openCwd) loadRoot(openCwd);
    return;
  }
  closeFileBrowser();
});

export { isOpen as isFileBrowserOpen };
