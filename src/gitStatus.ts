// 决策·git-status-porcelain: 用 `git status --porcelain` 判断 cwd 是否有未提交改动。
// 不走 @cursor/sdk(local 运行时没有 run.git),也不扫侧边栏全部文件夹——只按需查
// 当前打开的 cwd,避免拖慢 /api/folders。非 git 目录 / git 不可用一律当成非 dirty。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;

export interface GitStatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitStatus {
  repo: boolean;
  dirty: boolean;
  branch: string | null;
  counts: GitStatusCounts | null;
}

const NOT_A_REPO: GitStatus = {
  repo: false,
  dirty: false,
  branch: null,
  counts: null,
};

async function gitStdout(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // 避免把 git 的 stderr 噪音当成异常堆栈刷屏;非零退出靠 catch 处理。
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return null;
  }
}

function parsePorcelainCounts(porcelain: string): GitStatusCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("??") || line.startsWith("!")) {
      untracked += 1;
      continue;
    }
    // porcelain v1: 前两列是 index/worktree 状态码,空格表示该侧无变更。
    const x = line[0];
    const y = line[1];
    if (x && x !== " " && x !== "?") staged += 1;
    if (y && y !== " " && y !== "?") unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const inside = await gitStdout(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return NOT_A_REPO;

  const [branchOut, porcelainOut] = await Promise.all([
    gitStdout(cwd, ["branch", "--show-current"]),
    gitStdout(cwd, ["status", "--porcelain"]),
  ]);

  // status 命令失败时保守地当成非 dirty,避免误报干扰标题栏。
  if (porcelainOut === null) {
    return {
      repo: true,
      dirty: false,
      branch: branchOut?.trim() || null,
      counts: { staged: 0, unstaged: 0, untracked: 0 },
    };
  }

  const counts = parsePorcelainCounts(porcelainOut);
  const dirty = counts.staged + counts.unstaged + counts.untracked > 0;
  return {
    repo: true,
    dirty,
    branch: branchOut?.trim() || null,
    counts,
  };
}
