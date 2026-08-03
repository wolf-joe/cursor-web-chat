// 决策·add-all / 决策·no-dangerous-git / 决策·no-auto-upstream / 决策·partial-success:
// 固定序列 git add -A → git commit -m → git push(当前分支,无 --set-upstream / force)。
// 每步记录 ok + 错误摘要;commit 失败则不 push;commit✓ push✗ 不 rollback。
//
// 决策·shared-busy-lock: 按 cwd 内存互斥(与 pull 共用 gitWriteLock)。
// 决策·commit-behind-guard / 决策·guard-refetch: add 前再 fetch,拒绝 behind /
// fetch_failed / no_upstream,避免先落 commit 再被非快进 push 拒绝。
//
// 〈未决·git-cli-failure-fixtures〉已验证(临时仓库):
// - 无 remote: exit 128, stderr 含 "No configured push destination"
// - 有 remote 无 upstream: exit 128, stderr 含 "has no upstream branch"
// - push rejected(非快进): exit 1, stderr 含 "[rejected]" / "failed to push some refs"
// - nothing to commit: exit 1, stderr/stdout 含 "nothing to commit"
// 摘要策略:优先 stderr,否则 stdout;压成单行,最长 400 字符。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchRemoteSync } from "./gitSync.js";
import {
  acquireGitWriteLock,
  releaseGitWriteLock,
  GitWriteBusyError,
  GitCommitBusyError,
} from "./gitWriteLock.js";

export { GitWriteBusyError, GitCommitBusyError };

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const ERR_SUMMARY_MAX = 400;

export interface GitStepResult {
  ok: boolean;
  error: string | null;
}

export interface GitCommitPushResult {
  /** 仅当 add、commit、push 全部成功时为 true */
  ok: boolean;
  branch: string | null;
  commitHash: string | null;
  steps: {
    add: GitStepResult;
    commit: GitStepResult;
    push: GitStepResult;
  };
}

const SKIPPED: GitStepResult = { ok: false, error: "skipped" };

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
        killed?: boolean;
        signal?: string;
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

function stepOk(): GitStepResult {
  return { ok: true, error: null };
}

function stepFail(run: GitRun): GitStepResult {
  return { ok: false, error: summarizeError(run) };
}

function guardFail(message: string): GitCommitPushResult {
  return {
    ok: false,
    branch: null,
    commitHash: null,
    steps: {
      add: { ok: false, error: message },
      commit: SKIPPED,
      push: SKIPPED,
    },
  };
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

async function isDirty(cwd: string): Promise<boolean> {
  const run = await gitRun(cwd, ["status", "--porcelain"]);
  if (run.code !== 0) return false;
  return run.stdout.trim().length > 0;
}

/**
 * 决策·commit-behind-guard / 决策·guard-refetch:
 * add 前再 fetch;behind / fetch_failed / no_upstream 直接拒绝,不落 commit。
 */
async function assertSyncAllowsCommit(
  cwd: string,
  branch: string | null,
): Promise<GitCommitPushResult | null> {
  const sync = await fetchRemoteSync(cwd);
  if (sync.status === "fetch_failed") {
    return {
      ...guardFail(
        sync.error
          ? `无法确认是否与远程同步，暂不能提交：${sync.error}`
          : "无法确认是否与远程同步，暂不能提交",
      ),
      branch,
    };
  }
  if (sync.status === "no_upstream") {
    return {
      ...guardFail(
        sync.error
          ? `当前分支没有上游，无法推送：${sync.error}`
          : "当前分支没有上游，无法推送",
      ),
      branch,
    };
  }
  if ((sync.behind ?? 0) > 0) {
    const ahead = sync.ahead ?? 0;
    const behind = sync.behind ?? 0;
    const msg =
      ahead > 0
        ? `本地与远程已分叉（超前 ${ahead}、落后 ${behind}），请先处理后再提交`
        : `本地落后远程 ${behind} 个提交，请先拉取再提交`;
    return { ...guardFail(msg), branch };
  }
  return null;
}

/**
 * 一锤子 add → commit → push。
 * @throws GitWriteBusyError 同一 cwd 已有写操作在进行
 */
export async function commitAndPush(
  cwd: string,
  message: string,
): Promise<GitCommitPushResult> {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      ok: false,
      branch: null,
      commitHash: null,
      steps: {
        add: SKIPPED,
        commit: { ok: false, error: "commit message 不能为空" },
        push: SKIPPED,
      },
    };
  }

  acquireGitWriteLock(cwd);

  try {
    if (!(await isRepo(cwd))) {
      return {
        ok: false,
        branch: null,
        commitHash: null,
        steps: {
          add: { ok: false, error: "不是 git 仓库" },
          commit: SKIPPED,
          push: SKIPPED,
        },
      };
    }

    const branch = await currentBranch(cwd);

    if (!(await isDirty(cwd))) {
      return {
        ok: false,
        branch,
        commitHash: null,
        steps: {
          add: SKIPPED,
          commit: { ok: false, error: "没有可提交的改动" },
          push: SKIPPED,
        },
      };
    }

    const blocked = await assertSyncAllowsCommit(cwd, branch);
    if (blocked) return blocked;

    // 决策·add-all: 固定 add -A,含未跟踪与删除。
    const addRun = await gitRun(cwd, ["add", "-A"]);
    if (addRun.code !== 0) {
      return {
        ok: false,
        branch,
        commitHash: null,
        steps: { add: stepFail(addRun), commit: SKIPPED, push: SKIPPED },
      };
    }

    // 决策·no-dangerous-git: 只用 -m,不接受客户端任意 args。
    const commitRun = await gitRun(cwd, ["commit", "-m", trimmed]);
    if (commitRun.code !== 0) {
      return {
        ok: false,
        branch,
        commitHash: null,
        steps: {
          add: stepOk(),
          commit: stepFail(commitRun),
          push: SKIPPED,
        },
      };
    }

    const hashRun = await gitRun(cwd, ["rev-parse", "--short", "HEAD"]);
    const commitHash =
      hashRun.code === 0 && hashRun.stdout.trim() ? hashRun.stdout.trim() : null;

    // 决策·no-auto-upstream: 纯 `git push`,无 -u / --force。
    const pushRun = await gitRun(cwd, ["push"]);
    if (pushRun.code !== 0) {
      return {
        ok: false,
        branch,
        commitHash,
        steps: {
          add: stepOk(),
          commit: stepOk(),
          push: stepFail(pushRun),
        },
      };
    }

    return {
      ok: true,
      branch,
      commitHash,
      steps: { add: stepOk(), commit: stepOk(), push: stepOk() },
    };
  } finally {
    releaseGitWriteLock(cwd);
  }
}
