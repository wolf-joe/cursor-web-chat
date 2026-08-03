// 决策·shared-busy-lock / 决策·busy-lock:
// pull 与 commit-push 共用按 cwd 的内存互斥;第二路立即失败,不排队。
const busyCwds = new Set<string>();

export class GitWriteBusyError extends Error {
  constructor(cwd: string) {
    super(`该文件夹正在进行 git 写操作: ${cwd}`);
    this.name = "GitWriteBusyError";
  }
}

/** 旧名别名;pull/commit 共用同一锁错误。 */
export { GitWriteBusyError as GitCommitBusyError };

export function acquireGitWriteLock(cwd: string): void {
  if (busyCwds.has(cwd)) {
    throw new GitWriteBusyError(cwd);
  }
  busyCwds.add(cwd);
}

export function releaseGitWriteLock(cwd: string): void {
  busyCwds.delete(cwd);
}
