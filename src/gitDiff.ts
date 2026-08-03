// 决策·truncation: 只读查看当前 cwd 未提交改动 (staged + unstaged + untracked),
// 服务端强制截断——最多 100 个文件;二进制、超过 2000 行、或单文件 patch 超过
// 100KB 的内容不返回正文,只标 skipped 原因。写路径(commit+push)见 gitCommit.ts /
// 〈决策·write-path-scope〉。
//
// 决策·sync-in-diff / 决策·sync-response-shape / 决策·fetch-fail-block:
// GET /api/git-diff 内嵌 fetch + ahead/behind(sync);fetch 失败仍尽量返回本地 files。
//
// 外部契约(本机 git CLI,已用临时 dirty 仓库验证):
// - `git status --porcelain` —— 跟踪文件的 XY 状态;未跟踪目录只给 `?? dir/`,
//   故未跟踪文件改走 `git ls-files --others --exclude-standard`
// - `git diff -- PATH` / `git diff --cached -- PATH` —— 有差异时 exit 1 仍带 stdout
// - `git diff --no-index -- /dev/null PATH` —— 未跟踪文件的「新文件」unified diff,
//   有差异时 exit 1
// - `git diff --numstat` / `--cached --numstat` / `--numstat --no-index` —— 二进制为
//   `-	-	path`;行数用 added+deleted 估算
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchRemoteSync, type GitSyncInfo } from "./gitSync.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_FILES = 100;
const MAX_CONTENT_LINES = 2000;
/** 单文件 patch 体积上限:超过则不回正文(对齐文件树预览的字节闸,阈值更紧)。 */
const MAX_PATCH_BYTES = 100 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;

export type GitDiffSkipReason = "binary" | "too_large" | "error";

export interface GitDiffSkipped {
  reason: GitDiffSkipReason;
  message: string;
}

export interface GitDiffFile {
  path: string;
  /** porcelain 风格短标签,如 M / A / D / ? / MM */
  label: string;
  statuses: Array<"staged" | "unstaged" | "untracked">;
  patch: string | null;
  skipped: GitDiffSkipped | null;
}

export interface GitDiffResult {
  repo: boolean;
  branch: string | null;
  /** 是否因超过 MAX_FILES 而截断列表 */
  truncated: boolean;
  files: GitDiffFile[];
  /** 决策·sync-response-shape: 非仓库为 null;否则含 fetch 后的 sync */
  sync: GitSyncInfo | null;
}

const NOT_A_REPO: GitDiffResult = {
  repo: false,
  branch: null,
  truncated: false,
  files: [],
  sync: null,
};

export type { GitSyncInfo };

interface GitExecResult {
  stdout: string;
  code: number;
}

async function gitExec(cwd: string, args: string[]): Promise<GitExecResult | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    return { stdout, code: 0 };
  } catch (err: unknown) {
    // git diff 在有差异时返回 1,stdout 仍可用;其它非零视为失败。
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === 1 &&
      "stdout" in err &&
      typeof (err as { stdout?: unknown }).stdout === "string"
    ) {
      return { stdout: (err as { stdout: string }).stdout, code: 1 };
    }
    return null;
  }
}

async function gitStdout(cwd: string, args: string[]): Promise<string | null> {
  const result = await gitExec(cwd, args);
  return result ? result.stdout : null;
}

function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  // porcelain 对特殊字符路径会 C 风格双引号转义(非 JSON)。
  return raw.slice(1, -1).replace(/\\([abtnvfr"\\]|[0-7]{1,3})/g, (_, esc: string) => {
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    const map: Record<string, string> = {
      a: "\x07",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    return map[esc] ?? esc;
  });
}

interface ParsedEntry {
  path: string;
  x: string;
  y: string;
  untracked: boolean;
}

function parsePorcelainTracked(porcelain: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("??") || line.startsWith("!")) continue;

    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let rest = line.slice(3);

    // rename/copy: `R  old -> new` / `C  old -> new`
    const arrow = " -> ";
    const arrowIdx = rest.indexOf(arrow);
    if ((x === "R" || x === "C" || y === "R" || y === "C") && arrowIdx !== -1) {
      rest = rest.slice(arrowIdx + arrow.length);
    }

    const path = unquotePath(rest.trim());
    if (!path) continue;
    entries.push({ path, x, y, untracked: false });
  }
  return entries;
}

function buildLabel(entry: ParsedEntry): string {
  // 未跟踪等同「新增」,列表用 A 与已暂存的新文件一致,不用 porcelain 的 ?。
  if (entry.untracked) return "A";
  const x = entry.x === " " ? "" : entry.x;
  const y = entry.y === " " ? "" : entry.y;
  if (x && y) return `${x}${y}`;
  return x || y || "M";
}

function buildStatuses(entry: ParsedEntry): Array<"staged" | "unstaged" | "untracked"> {
  if (entry.untracked) return ["untracked"];
  const statuses: Array<"staged" | "unstaged" | "untracked"> = [];
  if (entry.x !== " " && entry.x !== "?") statuses.push("staged");
  if (entry.y !== " " && entry.y !== "?") statuses.push("unstaged");
  return statuses;
}

interface NumstatInfo {
  binary: boolean;
  lines: number;
}

function parseNumstatLine(line: string): NumstatInfo | null {
  if (!line) return null;
  // `12	3	path` 或 `-	-	path` 或 `1	0	/dev/null => path`
  const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (!m) return null;
  const [, added, deleted] = m;
  if (added === "-" || deleted === "-") {
    return { binary: true, lines: 0 };
  }
  return { binary: false, lines: Number(added) + Number(deleted) };
}

async function numstatFor(
  cwd: string,
  path: string,
  kind: "staged" | "unstaged" | "untracked",
): Promise<NumstatInfo | null> {
  let args: string[];
  if (kind === "staged") {
    args = ["diff", "--cached", "--numstat", "--", path];
  } else if (kind === "unstaged") {
    args = ["diff", "--numstat", "--", path];
  } else {
    args = ["diff", "--numstat", "--no-index", "--", "/dev/null", path];
  }
  const out = await gitStdout(cwd, args);
  if (out === null) return null;
  const first = out.split("\n").find((l) => l.trim());
  return first ? parseNumstatLine(first) : { binary: false, lines: 0 };
}

async function patchFor(
  cwd: string,
  path: string,
  kind: "staged" | "unstaged" | "untracked",
): Promise<string | null> {
  let args: string[];
  if (kind === "staged") {
    args = ["diff", "--cached", "--", path];
  } else if (kind === "unstaged") {
    args = ["diff", "--", path];
  } else {
    args = ["diff", "--no-index", "--", "/dev/null", path];
  }
  const result = await gitExec(cwd, args);
  return result ? result.stdout : null;
}

const SKIP_MESSAGES = {
  binary: "二进制文件，不展示内容",
  too_many_lines: `超过 ${MAX_CONTENT_LINES} 行，不展示内容`,
  too_large_bytes: `超过 ${Math.round(MAX_PATCH_BYTES / 1024)}KB，不展示内容`,
  error: "无法读取 diff",
} as const;

function patchLooksBinary(patch: string): boolean {
  // 只看 git 自己的 meta 行,不要扫 +/- 正文——否则源码里出现
  // "Binary files " / "GIT binary patch" 字样会被误判(本文件自己就踩过)。
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") || line.startsWith("-")) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      return true;
    }
  }
  return false;
}

async function buildFileDiff(cwd: string, entry: ParsedEntry): Promise<GitDiffFile> {
  const statuses = buildStatuses(entry);
  const label = buildLabel(entry);
  const base: GitDiffFile = {
    path: entry.path,
    label,
    statuses,
    patch: null,
    skipped: null,
  };

  // 先按各侧 numstat 判断二进制 / 行数,避免把超大 patch 读进内存。
  let totalLines = 0;
  for (const kind of statuses) {
    const info = await numstatFor(cwd, entry.path, kind);
    if (info === null) {
      return {
        ...base,
        skipped: { reason: "error", message: SKIP_MESSAGES.error },
      };
    }
    if (info.binary) {
      return {
        ...base,
        skipped: { reason: "binary", message: SKIP_MESSAGES.binary },
      };
    }
    totalLines += info.lines;
  }

  if (totalLines > MAX_CONTENT_LINES) {
    return {
      ...base,
      skipped: { reason: "too_large", message: SKIP_MESSAGES.too_many_lines },
    };
  }

  const parts: string[] = [];
  for (const kind of statuses) {
    const patch = await patchFor(cwd, entry.path, kind);
    if (patch === null) {
      return {
        ...base,
        skipped: { reason: "error", message: SKIP_MESSAGES.error },
      };
    }
    if (patchLooksBinary(patch)) {
      return {
        ...base,
        skipped: { reason: "binary", message: SKIP_MESSAGES.binary },
      };
    }
    if (patch.trim()) parts.push(patch.replace(/\n$/, ""));
  }

  const combined = parts.join("\n");
  const lineCount = combined ? combined.split("\n").length : 0;
  if (lineCount > MAX_CONTENT_LINES) {
    return {
      ...base,
      skipped: { reason: "too_large", message: SKIP_MESSAGES.too_many_lines },
    };
  }
  // 决策·truncation: 行数过关后仍可能因长行撑爆体积;按 UTF-8 字节拦。
  if (combined && Buffer.byteLength(combined, "utf8") > MAX_PATCH_BYTES) {
    return {
      ...base,
      skipped: { reason: "too_large", message: SKIP_MESSAGES.too_large_bytes },
    };
  }

  return { ...base, patch: combined || null };
}

export interface GetGitDiffOptions {
  /**
   * 是否 fetch 并填充 sync。HTTP `/api/git-diff` 为 true;
   * commit message 等内部复用可传 false,避免多余网络。
   */
  sync?: boolean;
}

export async function getGitDiff(
  cwd: string,
  opts: GetGitDiffOptions = {},
): Promise<GitDiffResult> {
  const wantSync = opts.sync !== false;
  const inside = await gitStdout(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return NOT_A_REPO;

  // 决策·sync-in-diff: 与本地 diff 并行——fetch 不依赖 porcelain。
  const syncPromise: Promise<GitSyncInfo | null> = wantSync
    ? fetchRemoteSync(cwd)
    : Promise.resolve(null);

  const [branchOut, porcelainOut, untrackedOut, sync] = await Promise.all([
    gitStdout(cwd, ["branch", "--show-current"]),
    gitStdout(cwd, ["status", "--porcelain"]),
    gitStdout(cwd, ["ls-files", "--others", "--exclude-standard"]),
    syncPromise,
  ]);

  if (porcelainOut === null) {
    return {
      repo: true,
      branch: branchOut?.trim() || null,
      truncated: false,
      files: [],
      sync,
    };
  }

  const tracked = parsePorcelainTracked(porcelainOut);
  const byPath = new Map<string, ParsedEntry>();
  for (const e of tracked) byPath.set(e.path, e);

  if (untrackedOut) {
    for (const line of untrackedOut.split("\n")) {
      if (!line) continue;
      const path = unquotePath(line);
      if (!path || byPath.has(path)) continue;
      byPath.set(path, { path, x: "?", y: "?", untracked: true });
    }
  }

  const all = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const truncated = all.length > MAX_FILES;
  const selected = all.slice(0, MAX_FILES);

  const files: GitDiffFile[] = [];
  for (const entry of selected) {
    files.push(await buildFileDiff(cwd, entry));
  }

  return {
    repo: true,
    branch: branchOut?.trim() || null,
    truncated,
    files,
    sync,
  };
}
