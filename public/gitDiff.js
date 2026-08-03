// 决策·overlay-shell / 决策·no-diff-lib-required / 决策·keep-stream:
// 同页近全宽 Overlay 展示未提交 diff;纯文本分色渲染 unified diff;
// 打开/关闭不调用 detachStream。
//
// 决策·one-shot-modal / 决策·close-on-full-success / 决策·partial-success:
// Overlay 顶栏「提交并推送」→ 确认 modal → 一锤子 commit+push;
// 全成功才关 Overlay 并刷新 dirty;部分成功留在 modal 展示分步结果。
//
// 决策·behind-ui / 决策·diverge-copy-keep-pull / 决策·fetch-fail-block /
// 决策·ff-only-pull / 决策·dirty-pull-ok:
// sync 控制提交可用性与「拉取」按钮;仅快进拉取;过程不 detachStream。
import {
  diffOverlay,
  diffOverlayBranch,
  diffOverlayCommit,
  diffOverlayPull,
  diffOverlayRefresh,
  diffOverlayClose,
  diffOverlayBanner,
  diffFileList,
  diffContent,
  commitModalOverlay,
  commitModalClose,
  commitModalCancel,
  commitModalSubmit,
  commitModalSummary,
  commitMessageInput,
  commitDraftHint,
  commitModalResult,
} from "./dom.js";
import { state } from "./state.js";
import { fetchGitDiff, fetchGitCommitMessage, postGitCommitPush, postGitPull } from "./api.js";
import { escapeHtml } from "./render.js";
import { closeFileBrowser, isFileBrowserOpen } from "./fileBrowser.js";
// 注意:不要静态 import gitStatus.js——那边已经 import 本模块的 openDiffOverlay,会成环。
// fileBrowser → gitDiff 仅动态 import(关 diff),本模块静态 import fileBrowser 关浏览,不成环。

let open = false;
let requestSeq = 0;
let openCwd = null;
let files = [];
let selectedPath = null;
let overlayBranch = null;
/** @type {null | { status: string, ahead: number | null, behind: number | null, error: string | null }} */
let overlaySync = null;
let loadingDiff = false;

let commitModalOpen = false;
let commitSubmitting = false;
let commitDraftSeq = 0;
let pullSubmitting = false;

function isOpen() {
  return open;
}

function setBanner(text, { error = false } = {}) {
  if (!text) {
    diffOverlayBanner.hidden = true;
    diffOverlayBanner.textContent = "";
    diffOverlayBanner.classList.remove("error");
    return;
  }
  diffOverlayBanner.hidden = false;
  diffOverlayBanner.textContent = text;
  diffOverlayBanner.classList.toggle("error", error);
}

/** 决策·behind-ui / diverge-copy-keep-pull / fetch-fail-block */
function syncAllowsCommit() {
  if (!overlaySync || overlaySync.status !== "ok") return false;
  return (overlaySync.behind ?? 0) === 0;
}

function syncWantsPull() {
  // 仅落后或分叉时显示拉取;fetch_failed / no_upstream 不显示。
  if (!overlaySync || overlaySync.status !== "ok") return false;
  return (overlaySync.behind ?? 0) > 0;
}

function bannerFromSync(sync, { truncated = false, fileCount = 0 } = {}) {
  const parts = [];
  let error = false;
  if (sync?.status === "fetch_failed") {
    parts.push(
      sync.error
        ? `无法同步远程，暂不能提交：${sync.error}`
        : "无法同步远程，暂不能提交",
    );
    error = true;
  } else if (sync?.status === "no_upstream") {
    parts.push(
      sync.error
        ? `当前分支没有上游，无法提交推送：${sync.error}`
        : "当前分支没有上游，无法提交推送",
    );
    error = true;
  } else if (sync?.status === "ok") {
    const ahead = sync.ahead ?? 0;
    const behind = sync.behind ?? 0;
    if (ahead > 0 && behind > 0) {
      // 决策·diverge-copy-keep-pull
      parts.push(
        `本地与远程已分叉（超前 ${ahead}、落后 ${behind}）。快进拉取无法解决分叉，点拉取会失败并提示原因`,
      );
      error = true;
    } else if (behind > 0) {
      // 决策·behind-ui: 干净与 dirty 共用入口,文案不假定一定要提交。
      parts.push(`本地落后远程 ${behind} 个提交，可先拉取对齐`);
    }
  }
  if (truncated) {
    parts.push(`改动文件过多，仅展示前 ${fileCount} 个`);
  }
  return { text: parts.join(" · "), error };
}

function updateActionButtons() {
  const busy = commitModalOpen || commitSubmitting || pullSubmitting || loadingDiff;
  const canCommit = open && files.length > 0 && !busy && syncAllowsCommit();
  diffOverlayCommit.disabled = !canCommit;

  const showPull = open && syncWantsPull();
  diffOverlayPull.hidden = !showPull;
  diffOverlayPull.disabled = !showPull || busy;
}

function labelClass(label, statuses) {
  if (label.includes("A") || statuses?.includes("untracked")) return "status-A";
  if (label.includes("D") && !label.includes("M")) return "status-D";
  return "";
}

function lineClass(line) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("copy ")) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function renderPatch(patch) {
  const lines = patch.split("\n");
  // 末尾空行不单独占一行视觉噪音
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `<pre class="diff-lines">${lines
    .map((line) => {
      const cls = lineClass(line);
      return `<span class="diff-line${cls ? ` ${cls}` : ""}">${escapeHtml(line) || " "}</span>`;
    })
    .join("")}</pre>`;
}

function renderSelected() {
  const file = files.find((f) => f.path === selectedPath);
  if (!file) {
    diffContent.innerHTML = '<div class="diff-content-empty">选择左侧文件查看改动</div>';
    return;
  }
  if (file.skipped) {
    diffContent.innerHTML = `<div class="diff-content-skipped">${escapeHtml(file.skipped.message || "已跳过")}</div>`;
    return;
  }
  if (!file.patch) {
    diffContent.innerHTML = '<div class="diff-content-empty">无文本改动</div>';
    return;
  }
  diffContent.innerHTML = renderPatch(file.patch);
}

function renderFileList() {
  if (!files.length) {
    diffFileList.innerHTML = '<div class="diff-list-empty">没有未提交改动</div>';
    diffContent.innerHTML = '<div class="diff-content-empty">工作区是干净的</div>';
    return;
  }
  diffFileList.innerHTML = files
    .map((f) => {
      const active = f.path === selectedPath ? " active" : "";
      const lcls = labelClass(f.label, f.statuses);
      const pathAttr = encodeURIComponent(f.path);
      return `<button type="button" class="diff-file-item${active}" data-path="${pathAttr}" title="${escapeHtml(f.path)}">
        <span class="diff-file-label ${lcls}">${escapeHtml(f.label)}</span>
        <span class="diff-file-path">${escapeHtml(f.path)}</span>
      </button>`;
    })
    .join("");
  renderSelected();
}

function selectFile(path) {
  selectedPath = path;
  for (const btn of diffFileList.querySelectorAll(".diff-file-item")) {
    const p = decodeURIComponent(btn.dataset.path || "");
    btn.classList.toggle("active", p === path);
  }
  renderSelected();
}

async function loadDiff(cwd) {
  const seq = ++requestSeq;
  loadingDiff = true;
  diffOverlayRefresh.disabled = true;
  updateActionButtons();
  diffFileList.innerHTML = '<div class="diff-list-empty">加载中…</div>';
  diffContent.innerHTML = "";
  // 决策·fetch-timeout 压测:打开时可能较慢,明示在 fetch。
  setBanner("同步远程中…");
  overlaySync = null;

  try {
    const data = await fetchGitDiff(cwd);
    // 过期请求:切换文件夹或关闭后回来的响应直接丢弃。
    if (seq !== requestSeq || !open || cwd !== openCwd) return;

    if (data.error) {
      files = [];
      selectedPath = null;
      overlayBranch = null;
      overlaySync = null;
      renderFileList();
      setBanner(data.error, { error: true });
      return;
    }
    if (!data.repo) {
      files = [];
      selectedPath = null;
      overlayBranch = null;
      overlaySync = null;
      renderFileList();
      setBanner("当前文件夹不是 git 仓库", { error: true });
      return;
    }

    overlayBranch = data.branch || null;
    overlaySync = data.sync ?? null;
    if (data.branch) {
      diffOverlayBranch.hidden = false;
      diffOverlayBranch.textContent = data.branch;
    } else {
      diffOverlayBranch.hidden = true;
      diffOverlayBranch.textContent = "";
    }

    files = Array.isArray(data.files) ? data.files : [];
    if (!files.some((f) => f.path === selectedPath)) {
      selectedPath = files[0]?.path ?? null;
    }

    const banner = bannerFromSync(overlaySync, {
      truncated: !!data.truncated,
      fileCount: files.length,
    });
    setBanner(banner.text, { error: banner.error });

    // 决策·empty-while-open: 打开后若已无 dirty,显示空态,不自动关闭。
    renderFileList();
  } catch (err) {
    if (seq !== requestSeq || !open || cwd !== openCwd) return;
    files = [];
    selectedPath = null;
    overlayBranch = null;
    overlaySync = null;
    renderFileList();
    setBanner(err instanceof Error ? err.message : String(err), { error: true });
  } finally {
    if (seq === requestSeq) {
      loadingDiff = false;
      diffOverlayRefresh.disabled = false;
      updateActionButtons();
    }
  }
}

export function openDiffOverlay(cwd = state.currentCwd) {
  if (!cwd) return;
  // 决策·overlay-mutex: 与文件浏览 Overlay 互斥。
  if (isFileBrowserOpen()) closeFileBrowser();
  open = true;
  openCwd = cwd;
  selectedPath = null;
  files = [];
  overlayBranch = null;
  overlaySync = null;
  // 决策·header-branch-only: 顶栏只展示分支名,不再写文件夹名。
  diffOverlayBranch.hidden = true;
  diffOverlayBranch.textContent = "";
  diffOverlayPull.hidden = true;
  diffOverlay.hidden = false;
  diffOverlay.classList.add("open");
  updateActionButtons();
  // 决策·keep-stream: 这里只盖 UI,绝不 detachStream。
  loadDiff(cwd);
}

export function closeDiffOverlay() {
  if (!open) return;
  if (commitModalOpen) closeCommitModal();
  open = false;
  openCwd = null;
  requestSeq += 1;
  files = [];
  selectedPath = null;
  overlayBranch = null;
  overlaySync = null;
  loadingDiff = false;
  pullSubmitting = false;
  diffOverlay.classList.remove("open");
  diffOverlay.hidden = true;
  diffOverlayPull.hidden = true;
  setBanner("");
  diffFileList.innerHTML = "";
  diffContent.innerHTML = "";
  updateActionButtons();
}

/** 切换会话/文件夹时调用:若 Overlay 开着则按新 cwd 重拉,避免串数据。 */
export function onCwdChangedForDiff(cwd) {
  if (!open) return;
  if (commitModalOpen) closeCommitModal();
  if (!cwd) {
    closeDiffOverlay();
    return;
  }
  openCwd = cwd;
  selectedPath = null;
  overlaySync = null;
  loadDiff(cwd);
}

function setDraftHint(text, { warn = false } = {}) {
  if (!text) {
    commitDraftHint.hidden = true;
    commitDraftHint.textContent = "";
    commitDraftHint.classList.remove("warn");
    return;
  }
  commitDraftHint.hidden = false;
  commitDraftHint.textContent = text;
  commitDraftHint.classList.toggle("warn", warn);
}

function setCommitResult(html, kind) {
  if (!html) {
    commitModalResult.hidden = true;
    commitModalResult.innerHTML = "";
    commitModalResult.className = "commit-modal-result";
    return;
  }
  commitModalResult.hidden = false;
  commitModalResult.className = `commit-modal-result ${kind || ""}`;
  commitModalResult.innerHTML = html;
}

function syncSubmitEnabled() {
  const hasMsg = commitMessageInput.value.trim().length > 0;
  commitModalSubmit.disabled = !hasMsg || commitSubmitting || commitMessageInput.disabled;
}

function stepClass(step) {
  if (!step) return "skip";
  if (step.ok) return "ok";
  if (step.error === "skipped") return "skip";
  return "fail";
}

function stepLabel(name, step) {
  const cls = stepClass(step);
  if (cls === "ok") return `<span class="step ok">${name} 成功</span>`;
  if (cls === "skip") return `<span class="step skip">${name} 未执行</span>`;
  return `<span class="step fail">${name} 失败：${escapeHtml(step?.error || "未知错误")}</span>`;
}

function renderCommitSteps(result) {
  const steps = result.steps || {};
  const lines = [
    stepLabel("暂存 (add -A)", steps.add),
    stepLabel("提交 (commit)", steps.commit),
    stepLabel("推送 (push)", steps.push),
  ];
  if (result.commitHash) {
    lines.push(`<span class="step ok">本地 commit ${escapeHtml(result.commitHash)}</span>`);
  }
  // 决策·partial-success: commit✓ push✗ 明确告诉用户本地已提交、未推送。
  if (steps.commit?.ok && steps.push && !steps.push.ok && steps.push.error !== "skipped") {
    lines.push(`<span class="step fail">本地已提交，推送失败（未自动 rollback）</span>`);
  }
  return lines.join("");
}

function closeCommitModal() {
  if (!commitModalOpen) return;
  // 提交进行中不允许关掉,避免用户以为取消了实际仍在跑。
  if (commitSubmitting) return;
  commitModalOpen = false;
  commitDraftSeq += 1;
  commitModalOverlay.classList.remove("open");
  commitMessageInput.value = "";
  commitMessageInput.disabled = false;
  setDraftHint("");
  setCommitResult("");
  syncSubmitEnabled();
  updateActionButtons();
}

async function openCommitModal() {
  if (!open || !openCwd || !files.length || commitModalOpen || commitSubmitting || pullSubmitting) return;
  if (!syncAllowsCommit()) return;
  // 决策·keep-stream: 打开确认层也不 detachStream。
  commitModalOpen = true;
  updateActionButtons();
  setCommitResult("");
  setDraftHint("正在生成 commit message…");
  commitMessageInput.value = "";
  commitMessageInput.disabled = true;
  commitMessageInput.placeholder = "生成中…";
  syncSubmitEnabled();

  const branchText = overlayBranch ? `分支 ${overlayBranch}` : "当前分支";
  commitModalSummary.textContent = `${branchText} · ${files.length} 个改动文件`;
  commitModalOverlay.classList.add("open");

  const seq = ++commitDraftSeq;
  const cwd = openCwd;
  try {
    const { ok, status, data } = await fetchGitCommitMessage(cwd);
    if (seq !== commitDraftSeq || !commitModalOpen) return;

    commitMessageInput.disabled = false;
    commitMessageInput.placeholder = "填写 commit message";

    if (!ok) {
      setDraftHint(data?.error || `生成失败 (${status})，请手填 message`, { warn: true });
      syncSubmitEnabled();
      commitMessageInput.focus();
      return;
    }
    if (!data.repo) {
      setDraftHint("当前文件夹不是 git 仓库", { warn: true });
      syncSubmitEnabled();
      return;
    }
    if (!data.dirty) {
      setDraftHint("工作区已干净，没有可提交改动", { warn: true });
      syncSubmitEnabled();
      return;
    }

    if (data.branch) {
      commitModalSummary.textContent = `分支 ${data.branch} · ${data.fileCount || files.length} 个改动文件`;
    }

    if (data.message) {
      commitMessageInput.value = data.message;
      setDraftHint(data.truncatedForLlm ? "草稿已生成（diff 已截断喂给模型，可按需修改）" : "草稿已生成，可直接改");
      // 决策·no-focus-on-draft: 生成成功不抢焦点——多数情况直接点提交,不必改 message。
      // 失败/空草稿才 focus,方便手填。
    } else {
      setDraftHint("未能自动生成 message，请手填", { warn: true });
      commitMessageInput.focus();
    }
    syncSubmitEnabled();
  } catch (err) {
    if (seq !== commitDraftSeq || !commitModalOpen) return;
    commitMessageInput.disabled = false;
    commitMessageInput.placeholder = "填写 commit message";
    setDraftHint(err instanceof Error ? err.message : String(err), { warn: true });
    syncSubmitEnabled();
    commitMessageInput.focus();
  }
}

async function submitCommitPush() {
  if (!commitModalOpen || commitSubmitting || !openCwd) return;
  const message = commitMessageInput.value.trim();
  if (!message) {
    syncSubmitEnabled();
    return;
  }

  commitSubmitting = true;
  commitMessageInput.disabled = true;
  commitModalSubmit.disabled = true;
  commitModalClose.disabled = true;
  commitModalCancel.disabled = true;
  setCommitResult("正在提交并推送…", "");
  // 决策·keep-stream: 提交流程绝不 detachStream。

  try {
    const { ok, status, data } = await postGitCommitPush(openCwd, message);
    if (status === 409) {
      setCommitResult(escapeHtml(data?.error || "该文件夹正在进行 git 写操作"), "error");
      return;
    }
    if (!ok && !data?.steps) {
      setCommitResult(escapeHtml(data?.error || `请求失败 (${status})`), "error");
      return;
    }

    const result = data;
    if (result.ok) {
      // 决策·close-on-full-success: 全成功才关 Overlay 并刷新 dirty。
      setCommitResult(renderCommitSteps(result), "ok");
      commitSubmitting = false;
      const cwdToRefresh = state.currentCwd;
      closeCommitModal();
      closeDiffOverlay();
      const { refreshGitDirty } = await import("./gitStatus.js");
      refreshGitDirty(cwdToRefresh);
      return;
    }

    const kind =
      result.steps?.commit?.ok && result.steps?.push && !result.steps.push.ok
        ? "partial"
        : "error";
    setCommitResult(renderCommitSteps(result), kind);
  } catch (err) {
    setCommitResult(escapeHtml(err instanceof Error ? err.message : String(err)), "error");
  } finally {
    commitSubmitting = false;
    commitMessageInput.disabled = false;
    commitModalClose.disabled = false;
    commitModalCancel.disabled = false;
    syncSubmitEnabled();
    updateActionButtons();
  }
}

async function submitPull() {
  if (!open || !openCwd || pullSubmitting || commitModalOpen || commitSubmitting || loadingDiff) return;
  if (!syncWantsPull()) return;
  // 决策·keep-stream / 决策·ff-only-pull / 决策·dirty-pull-ok
  pullSubmitting = true;
  updateActionButtons();
  diffOverlayRefresh.disabled = true;
  setBanner("正在快进拉取…");

  try {
    const { ok, status, data } = await postGitPull(openCwd);
    if (!open || openCwd === null) return;

    if (status === 409) {
      setBanner(data?.error || "该文件夹正在进行 git 写操作", { error: true });
      return;
    }
    if (!ok || !data?.ok) {
      setBanner(data?.error || `拉取失败 (${status})`, { error: true });
      return;
    }

    // 拉取成功:重拉 diff/sync + 刷新 dirty。
    const cwdToRefresh = state.currentCwd;
    const { refreshGitDirty } = await import("./gitStatus.js");
    refreshGitDirty(cwdToRefresh);
    await loadDiff(openCwd);
  } catch (err) {
    if (!open) return;
    setBanner(err instanceof Error ? err.message : String(err), { error: true });
  } finally {
    pullSubmitting = false;
    if (open) {
      diffOverlayRefresh.disabled = loadingDiff;
      updateActionButtons();
    }
  }
}

diffOverlayClose.addEventListener("click", closeDiffOverlay);
diffOverlay.addEventListener("click", (e) => {
  if (e.target === diffOverlay && !commitModalOpen) closeDiffOverlay();
});
diffOverlayRefresh.addEventListener("click", () => {
  if (openCwd && !pullSubmitting && !commitSubmitting) loadDiff(openCwd);
});
diffOverlayCommit.addEventListener("click", () => {
  openCommitModal();
});
diffOverlayPull.addEventListener("click", () => {
  submitPull();
});
diffFileList.addEventListener("click", (e) => {
  const btn = e.target.closest(".diff-file-item");
  if (!btn) return;
  selectFile(decodeURIComponent(btn.dataset.path || ""));
});

commitModalClose.addEventListener("click", closeCommitModal);
commitModalCancel.addEventListener("click", closeCommitModal);
commitModalOverlay.addEventListener("click", (e) => {
  if (e.target === commitModalOverlay) closeCommitModal();
});
commitModalSubmit.addEventListener("click", () => {
  submitCommitPush();
});
commitMessageInput.addEventListener("input", syncSubmitEnabled);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 确认层优先于 Overlay 关闭。
  if (commitModalOpen) {
    e.preventDefault();
    closeCommitModal();
    return;
  }
  if (open) {
    e.preventDefault();
    closeDiffOverlay();
  }
});

export { isOpen as isDiffOverlayOpen };
