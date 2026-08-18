// 决策·tool-format-module / 决策·four-tools / 决策·glob-format / 决策·summary-shape /
// 决策·cwd-in-summarize / 决策·beautify-depth / 决策·edit-shape / 决策·truncate /
// 决策·createplan-shape / 决策·md-no-cycle:
// 工具折叠条人话摘要 + 展开详情 HTML。纯函数模块，不碰 DOM 装配。
// args/result 视为 unknown，每类分支防御式取值，失败退回 JSON。
// createPlan 主路径已改走 render.js 计划气泡（决策·createplan-as-assistant）；
// 此处 createPlan 分支仅兜底（若仍误入 .block-tool）。
// 不得 import render.js（循环依赖）；markdown 走 markdown.js（决策·ascii-autolink）；
// glob：args.globPattern + 可选 targetDirectory；
// result.value.files / totalFiles。

import { state } from "./state.js";
import { renderMarkdown } from "./markdown.js";

/** 展开区长文本字符上限；超出截断并标注（滚动另由 CSS max-height 管）。 */
const TEXT_CHAR_LIMIT = 12000;
/** 折叠条里 shell command 的字符兜底（真正截断仍靠 CSS ellipsis）。 */
const SUMMARY_CMD_MAX = 120;

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeName(name) {
  return String(name ?? "tool").toLowerCase();
}

/**
 * 从 cwd 猜家目录：/home/user 或 /…/home/user（决策·cwd-in-summarize）。
 * 浏览器没有 process.env.HOME，只能从当前工作区路径推导。
 */
function guessHomeFromCwd(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  if (parts[0] === "home" && parts.length >= 2) return "/" + parts.slice(0, 2).join("/");
  const hi = parts.indexOf("home");
  if (hi >= 0 && parts.length > hi + 1) return "/" + parts.slice(0, hi + 2).join("/");
  return null;
}

/**
 * 路径缩短（决策·cwd-in-summarize）：
 * 1) 在 cwd 下 → 相对路径；
 * 2) 否则在家目录下 → ~/…（避免 skill 等 cwd 外文件只剩 SKILL.md）；
 * 3) 再否则保留末 3 段（前缀 …/），短路径原样。
 */
export function shortPath(path) {
  if (path == null || path === "") return "";
  const p = String(path).replace(/\\/g, "/");
  const cwd = state.currentCwd ? String(state.currentCwd).replace(/\\/g, "/") : null;
  if (cwd) {
    if (p === cwd) return ".";
    const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
    if (p.startsWith(prefix)) return p.slice(prefix.length) || ".";
    const home = guessHomeFromCwd(cwd);
    if (home) {
      if (p === home) return "~";
      const hp = home.endsWith("/") ? home : home + "/";
      if (p.startsWith(hp)) return "~/" + p.slice(hp.length);
    }
  }
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return (p.startsWith("/") ? "/" : "") + parts.join("/");
  return "…/" + parts.slice(-3).join("/");
}

function oneLine(s, max = SUMMARY_CMD_MAX) {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function truncateText(text, limit = TEXT_CHAR_LIMIT) {
  const s = String(text ?? "");
  if (s.length <= limit) return { text: s, truncated: false };
  return {
    text: s.slice(0, limit) + "\n…(已截断)",
    truncated: true,
  };
}

function successValue(result) {
  if (!result || typeof result !== "object") return null;
  if (result.status === "success" && result.value != null) return result.value;
  return null;
}

function section(label, innerHtml) {
  return `<div class="tool-section-label">${escapeHtml(label)}</div>${innerHtml}`;
}

function preBlock(text, extraClass = "") {
  const { text: body } = truncateText(text);
  const cls = extraClass ? `tool-pre ${extraClass}` : "tool-pre";
  return `<pre class="${cls}">${escapeHtml(body)}</pre>`;
}

function jsonFallback(args, result) {
  let html = "";
  if (args !== undefined) html += section("Args", `<div class="tool-json">${escapeHtml(safeStringify(args))}</div>`);
  if (result !== undefined) html += section("Result", `<div class="tool-json">${escapeHtml(safeStringify(result))}</div>`);
  return html;
}

function shellCommand(args) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && typeof args.command === "string") return args.command;
  return null;
}

function summarizeShell(args) {
  const cmd = shellCommand(args);
  if (cmd == null) return null;
  // 条上 tool-name 已是 shell，preview 只放 command（合起来即 决策·summary-shape 的 shell · cmd）
  return oneLine(cmd);
}

function summarizeRead(args) {
  if (!args || typeof args !== "object" || typeof args.path !== "string") return null;
  return shortPath(args.path);
}

function summarizeGrep(args) {
  if (!args || typeof args !== "object" || typeof args.pattern !== "string") return null;
  const target = args.path ? shortPath(args.path) : args.glob ? String(args.glob) : "";
  return target ? `${oneLine(args.pattern, 60)} · ${target}` : oneLine(args.pattern, 80);
}

function summarizeEdit(args, result) {
  if (!args || typeof args !== "object" || typeof args.path !== "string") return null;
  let s = shortPath(args.path);
  const v = successValue(result);
  if (v) {
    const add = v.linesAdded;
    const rem = v.linesRemoved;
    const bits = [];
    if (typeof add === "number") bits.push(`+${add}`);
    if (typeof rem === "number") bits.push(`-${rem}`);
    if (bits.length) s += ` ${bits.join("/")}`;
  }
  return s;
}

/** glob：pattern · [短目录] · [N]（决策·glob-format / summary-shape）。 */
function summarizeGlob(args, result) {
  if (!args || typeof args !== "object" || typeof args.globPattern !== "string") return null;
  const bits = [oneLine(args.globPattern, 80)];
  if (typeof args.targetDirectory === "string" && args.targetDirectory) {
    bits.push(shortPath(args.targetDirectory));
  }
  const v = successValue(result);
  if (v && typeof v.totalFiles === "number") bits.push(String(v.totalFiles));
  return bits.join(" · ");
}

/** createPlan：折叠条取 plan 首行截断（决策·createplan-md）。 */
function summarizeCreatePlan(args) {
  if (!args || typeof args !== "object" || typeof args.plan !== "string") return null;
  const firstLine =
    args.plan
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l) ?? "";
  return oneLine(firstLine || "计划", 120);
}

function renderCreatePlanDetail(args, result) {
  if (!args || typeof args !== "object" || typeof args.plan !== "string") {
    return jsonFallback(args, result);
  }
  // 决策·createplan-md: 详情即 plan 正文 markdown；成功 result 常为空，不单独展示。
  return `<div class="msg-text tool-plan-md">${renderMarkdown(args.plan)}</div>`;
}

/** 是否 createPlan（决策·createplan-as-assistant 由 render/stream 走气泡）。 */
export function isCreatePlanTool(name) {
  return normalizeName(name) === "createplan";
}

/** 人话折叠条摘要。未知/畸形退回 JSON 一行（决策·summary-shape / four-tools）。 */
export function summarizeTool(name, args, result) {
  try {
    const n = normalizeName(name);
    let s = null;
    if (n === "shell") s = summarizeShell(args);
    else if (n === "read") s = summarizeRead(args);
    else if (n === "grep") s = summarizeGrep(args);
    else if (n === "edit") s = summarizeEdit(args, result);
    else if (n === "glob") s = summarizeGlob(args, result);
    else if (n === "createplan") s = summarizeCreatePlan(args);
    if (s != null) return s;
  } catch {
    /* fall through */
  }
  if (args === undefined) return "";
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    return oneLine(String(raw).replace(/\s+/g, " ").trim(), 160);
  } catch {
    return oneLine(String(args), 160);
  }
}

function renderShellDetail(args, result) {
  const cmd = shellCommand(args);
  const v = successValue(result);
  // shellConversationTurn 等兜底：result 可能是裸字符串
  if (!v && (typeof result === "string" || result == null)) {
    let html = "";
    if (cmd != null) html += section("Command", preBlock(cmd));
    if (typeof result === "string") html += section("Output", preBlock(result));
    else if (args !== undefined && cmd == null) return jsonFallback(args, result);
    return html || jsonFallback(args, result);
  }
  if (!v) {
    if (result?.status === "error") return jsonFallback(args, result);
    return jsonFallback(args, result);
  }
  let html = "";
  if (cmd != null) html += section("Command", preBlock(cmd));
  html += section("exitCode", `<div class="tool-meta">${escapeHtml(String(v.exitCode ?? ""))}</div>`);
  if (v.stdout) html += section("stdout", preBlock(v.stdout));
  if (v.stderr) html += section("stderr", preBlock(v.stderr, "tool-pre-stderr"));
  if (!v.stdout && !v.stderr) html += section("Output", preBlock("(empty)"));
  return html;
}

function renderReadDetail(args, result) {
  const v = successValue(result);
  if (!v || typeof v.content !== "string") {
    if (result?.status === "error") return jsonFallback(args, result);
    return jsonFallback(args, result);
  }
  let html = "";
  if (args?.path) html += section("Path", `<div class="tool-meta">${escapeHtml(shortPath(args.path))}</div>`);
  const meta = [];
  if (typeof v.totalLines === "number") meta.push(`${v.totalLines} lines`);
  if (typeof v.fileSize === "number") meta.push(`${v.fileSize} B`);
  if (meta.length) html += section("Meta", `<div class="tool-meta">${escapeHtml(meta.join(" · "))}</div>`);
  html += section("Content", preBlock(v.content));
  return html;
}

function formatGrepMatches(workspaceResults) {
  const lines = [];
  if (!workspaceResults || typeof workspaceResults !== "object") return null;
  for (const out of Object.values(workspaceResults)) {
    if (!out || typeof out !== "object") continue;
    if (out.type === "content" && Array.isArray(out.output?.matches)) {
      for (const m of out.output.matches) {
        const file = shortPath(m.file ?? "");
        const ln = m.lineNumber != null ? `:${m.lineNumber}` : "";
        lines.push(`${file}${ln}: ${m.line ?? ""}`);
      }
    } else if (out.type === "files" && Array.isArray(out.output?.files)) {
      for (const f of out.output.files) lines.push(shortPath(f));
    } else if (out.type === "count" && Array.isArray(out.output?.counts)) {
      for (const c of out.output.counts) lines.push(`${shortPath(c.file ?? "")}: ${c.count ?? 0}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

function renderGrepDetail(args, result) {
  const v = successValue(result);
  if (!v) {
    if (result?.status === "error") return jsonFallback(args, result);
    return jsonFallback(args, result);
  }
  const body = formatGrepMatches(v.workspaceResults);
  if (body == null) return jsonFallback(args, result);
  let html = "";
  if (args?.pattern) html += section("Pattern", `<div class="tool-meta">${escapeHtml(args.pattern)}</div>`);
  html += section("Matches", preBlock(body));
  return html;
}

function diffLineClass(line) {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function renderDiffHtml(diffString) {
  const { text } = truncateText(diffString);
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `<pre class="tool-diff diff-lines">${lines
    .map((line) => {
      const cls = diffLineClass(line);
      return `<span class="diff-line${cls ? ` ${cls}` : ""}">${escapeHtml(line) || " "}</span>`;
    })
    .join("")}</pre>`;
}

function renderEditDetail(args, result) {
  const v = successValue(result);
  if (!v) {
    if (result?.status === "error") return jsonFallback(args, result);
    // running：还没有 diff，只展示 path
    if (args?.path) {
      return section("Path", `<div class="tool-meta">${escapeHtml(shortPath(args.path))}</div>`);
    }
    return jsonFallback(args, result);
  }
  let html = "";
  if (args?.path) html += section("Path", `<div class="tool-meta">${escapeHtml(shortPath(args.path))}</div>`);
  const bits = [];
  if (typeof v.linesAdded === "number") bits.push(`+${v.linesAdded}`);
  if (typeof v.linesRemoved === "number") bits.push(`-${v.linesRemoved}`);
  if (bits.length) html += section("Stats", `<div class="tool-meta">${escapeHtml(bits.join(" / "))}</div>`);
  if (typeof v.diffString === "string" && v.diffString) {
    html += section("Diff", renderDiffHtml(v.diffString));
  } else if (!html) {
    return jsonFallback(args, result);
  }
  return html;
}

function renderGlobDetail(args, result) {
  if (!args || typeof args !== "object" || typeof args.globPattern !== "string") {
    return jsonFallback(args, result);
  }
  let html = "";
  html += section("Pattern", `<div class="tool-meta">${escapeHtml(args.globPattern)}</div>`);
  if (typeof args.targetDirectory === "string" && args.targetDirectory) {
    html += section("Directory", `<div class="tool-meta">${escapeHtml(shortPath(args.targetDirectory))}</div>`);
  }
  const v = successValue(result);
  if (!v) {
    if (result?.status === "error") return html + jsonFallback(undefined, result);
    return html; // running：只有 args
  }
  if (!Array.isArray(v.files)) return jsonFallback(args, result);
  const meta = [];
  if (typeof v.totalFiles === "number") meta.push(`${v.totalFiles} files`);
  if (v.clientTruncated || v.ripgrepTruncated) meta.push("truncated");
  if (meta.length) html += section("Meta", `<div class="tool-meta">${escapeHtml(meta.join(" · "))}</div>`);
  const body =
    v.files.length === 0 ? "(empty)" : v.files.map((f) => shortPath(f)).join("\n");
  html += section("Files", preBlock(body));
  return html;
}

/** 展开区 HTML。已知工具美化，其余/失败走 JSON（决策·beautify-depth / four-tools / glob-format / createplan-md）。 */
export function renderToolDetail(name, args, result) {
  try {
    const n = normalizeName(name);
    if (n === "shell") return renderShellDetail(args, result);
    if (n === "read") return renderReadDetail(args, result);
    if (n === "grep") return renderGrepDetail(args, result);
    if (n === "edit") return renderEditDetail(args, result);
    if (n === "glob") return renderGlobDetail(args, result);
    if (n === "createplan") return renderCreatePlanDetail(args, result);
  } catch {
    /* fall through */
  }
  return jsonFallback(args, result);
}
