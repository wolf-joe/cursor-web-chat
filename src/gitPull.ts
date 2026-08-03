// 决策·ff-only-pull / 决策·dirty-pull-ok / 决策·no-dangerous-git-extend /
// 决策·shared-busy-lock / 决策·pull-response-shape / 决策·pull-cli-failure-fixtures:
// 仅 `git pull --ff-only`;与 commit-push 共用写锁;业务失败 200+ok:false。
// 不做 merge/rebase/force/reset/stash;脏工作区允许尝试,失败把 stderr 摘要回传。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireGitWriteLock,
  releaseGitWriteLock,
  GitWriteBusyError,
} from "./gitWriteLock.js";

export { GitWriteBusyError };

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const ERR_SUMMARY_MAX = 400;

export interface GitPullResult {
  ok: boolean;
  branch: string | null;
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

async function isRepo(cwd: string): Promise<boolean> {
  const run = await gitRun(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return run.code === 0 && run.stdout.trim() === "true";
}

async function currentBranch(cwd: string): Promise<string | null> {
  const run = await gitRun(cwd, ["branch", "--show-current"]);
  if (run.code !== 0) return null;
  return run.stdout.trim() || null;
}

/**
 * 快进拉取。
 * @throws GitWriteBusyError 同一 cwd 已有写操作在进行
 */
export async function pullFfOnly(cwd: string): Promise<GitPullResult> {
  acquireGitWriteLock(cwd);
  try {
    if (!(await isRepo(cwd))) {
      return { ok: false, branch: null, error: "不是 git 仓库" };
    }

    const branch = await currentBranch(cwd);
    // 决策·ff-only-pull: 固定 --ff-only,不接受客户端任意 args。
    const pullRun = await gitRun(cwd, ["pull", "--ff-only"]);
    if (pullRun.code !== 0) {
      return { ok: false, branch, error: summarizeError(pullRun) };
    }
    return { ok: true, branch, error: null };
  } finally {
    releaseGitWriteLock(cwd);
  }
}
