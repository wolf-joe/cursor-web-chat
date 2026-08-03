// 决策·title-git-always: 标题栏常驻 git 按钮(仅非仓库隐藏);
// dirty 用数字后缀 + 橙色强调,干净为中性色。点击打开 Diff Overlay
// (干净但落后也可进 Overlay 拉齐)。status 仍不 fetch(〈决策·sync-in-diff〉)。
import { gitDirtyBtn } from "./dom.js";
import { state } from "./state.js";
import { fetchGitStatus } from "./api.js";
import { openDiffOverlay } from "./gitDiff.js";

// 并发/过期请求序号:切换文件夹时旧请求回来后不能覆盖新 cwd 的状态。
let requestSeq = 0;

export function clearGitDirty() {
  gitDirtyBtn.className = "git-btn";
  gitDirtyBtn.textContent = "git";
  gitDirtyBtn.removeAttribute("title");
  gitDirtyBtn.setAttribute("aria-label", "打开 git Overlay");
  gitDirtyBtn.hidden = true;
}

function totalChanges(counts) {
  if (!counts) return 0;
  return counts.staged + counts.unstaged + counts.untracked;
}

function buildTitle(data, dirty) {
  const parts = [];
  if (data.branch) parts.push(`分支 ${data.branch}`);
  if (dirty) {
    parts.push("有未提交改动");
    const c = data.counts;
    if (c) {
      const bits = [];
      if (c.staged) bits.push(`${c.staged} 已暂存`);
      if (c.unstaged) bits.push(`${c.unstaged} 未暂存`);
      if (c.untracked) bits.push(`${c.untracked} 未跟踪`);
      if (bits.length) parts.push(bits.join(" · "));
    }
  } else {
    parts.push("工作区干净");
  }
  parts.push("点击打开 git Overlay");
  return parts.join(" · ");
}

export async function refreshGitDirty(cwd = state.currentCwd) {
  const seq = ++requestSeq;
  if (!cwd) {
    clearGitDirty();
    return;
  }
  try {
    const data = await fetchGitStatus(cwd);
    if (seq !== requestSeq || cwd !== state.currentCwd) return;
    if (data.error || !data.repo) {
      clearGitDirty();
      return;
    }
    const dirty = !!data.dirty;
    const n = totalChanges(data.counts);
    gitDirtyBtn.className = dirty ? "git-btn dirty" : "git-btn clean";
    gitDirtyBtn.textContent = dirty && n > 0 ? `git ${n}` : "git";
    gitDirtyBtn.title = buildTitle(data, dirty);
    gitDirtyBtn.setAttribute(
      "aria-label",
      dirty && n > 0 ? `打开 git Overlay，${n} 个未提交改动` : "打开 git Overlay",
    );
    gitDirtyBtn.hidden = false;
  } catch {
    if (seq === requestSeq) clearGitDirty();
  }
}

gitDirtyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.currentCwd) return;
  openDiffOverlay(state.currentCwd);
});
