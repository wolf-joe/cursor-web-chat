// 决策·sync-in-diff / 决策·sync-states / 决策·sync-response-shape / 决策·fetch-timeout /
// 决策·guard-refetch / 决策·pull-cli-failure-fixtures:
// Overlay 打开/刷新与 commit 闸门共用:先 fetch,再读 HEAD...@{upstream} ahead/behind。
// fetch 失败 → fetch_failed;无上游 → no_upstream;分叉不另开 status,由 ahead&&behind 推导。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// 决策·fetch-timeout: 与 gitCommit 写路径同级 60s。
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const ERR_SUMMARY_MAX = 400;

export type GitSyncStatus = "ok" | "no_upstream" | "fetch_failed";

export interface GitSyncInfo {
  status: GitSyncStatus;
  ahead: number | null;
  behind: number | null;
  error: string | null;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function gitRun(cwd: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    if (err && typeof err === "object") {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof e.code === "number" ? e.code : 1;
      return {
        code,
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : "",
      };
    }
    return { code: 1, stdout: "", stderr: String(err) };
  }
}

function summarizeError(run: GitRun): string {
  const raw = (run.stderr || run.stdout || `git 退出码 ${run.code}`).trim();
  const oneLine = raw.replace(/\s+/g, " ");
  if (oneLine.length <= ERR_SUMMARY_MAX) return oneLine;
  return oneLine.slice(0, ERR_SUMMARY_MAX) + "…";
}

/**
 * fetch 远程并读取相对上游的 ahead/behind。
 * 副作用:更新 remote-tracking refs(不改工作区 / HEAD)。
 */
export async function fetchRemoteSync(cwd: string): Promise<GitSyncInfo> {
  const fetchRun = await gitRun(cwd, ["fetch"]);
  if (fetchRun.code !== 0) {
    return {
      status: "fetch_failed",
      ahead: null,
      behind: null,
      error: summarizeError(fetchRun),
    };
  }

  // 无上游时 rev-parse @{upstream} 非零;文案常含 no upstream configured。
  const upstream = await gitRun(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstream.code !== 0) {
    return {
      status: "no_upstream",
      ahead: null,
      behind: null,
      error: summarizeError(upstream) || "no upstream configured",
    };
  }

  // `git rev-list --left-right --count HEAD...@{upstream}` → "<ahead>\t<behind>"
  const counts = await gitRun(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{upstream}",
  ]);
  if (counts.code !== 0) {
    return {
      status: "fetch_failed",
      ahead: null,
      behind: null,
      error: summarizeError(counts),
    };
  }

  const m = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) {
    return {
      status: "fetch_failed",
      ahead: null,
      behind: null,
      error: `无法解析 ahead/behind: ${counts.stdout.trim() || "(空)"}`,
    };
  }

  return {
    status: "ok",
    ahead: Number(m[1]),
    behind: Number(m[2]),
    error: null,
  };
}
