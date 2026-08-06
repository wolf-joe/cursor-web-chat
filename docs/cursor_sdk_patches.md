# `@cursor/sdk` 本地补丁记录

本仓库在 `npm install` 的 `postinstall` 里运行 `scripts/patch-sdk.mjs`，对 `@cursor/sdk@1.0.26` 的 `dist/esm` 与 `dist/cjs` 做**定点字符串注入**（不使用 `patch-package`，不在仓库里分发 SDK 构建产物全文）。

- **任一条锚点失配 → 非零退出**，让安装失败。静默跳过是这里最坏的失败模式（工具调用会永久卡 RUNNING、Shell cwd 错绑、或工具调用无终态）。
- **幂等**：打过补丁后「未修补」锚点不再命中，脚本跳过已注入项。
- **注入 patch 1 + patch 2 + patch 3**，共 8 条（esm/cjs 各 4 条）。patch 3 曾在开源时被砍掉，2026-08-06 翻盘重新带上，原因见下文。

官方 SDK 文档：[Cursor TypeScript SDK](https://cursor.com/docs)（以官网为准；本仓库不再镜像全文）。

---

## patch 1: stale `toolCallCompleted` 被静默丢弃 → run 卡在 RUNNING

- **对应版本**：`@cursor/sdk@1.0.26`（1.0.23 起同构，1.0.26 仍未修）
- **锚点串**：`nal.await_stall.stale_completion_dropped`
- **改动文件**：`dist/esm/357.js`、`dist/cjs/223.js`

### 现象

本地 runtime 下，工具调用可能永久停在 `running`，整轮卡在 `RUNNING`——无超时、无面向调用方的错误。可用 `scripts/cursor_slow_tools.py` 按时间戳发现。

### 根因

连接 stall 检测器（阈值约 30s）重试时抬高 `attemptGen`。负责按 generation 过滤的包装在「generation 不匹配」时对 `toolCallCompleted` **只打 warn 不转发**，旧 generation 的 completion 被吞掉；该调用从此没有任何事件能推进到终态。

### 修法

generation 不匹配且消息为 `toolCallCompleted` 时：**仍 `sendUpdate` 转发**，并保留 warn。其它 stale 消息行为不变。

### 升级后如何判断还要不要

1. 在新版本 `dist/esm/*.js` 里搜 `stale_completion_dropped`。
2. 若字符串消失 / 逻辑已转发 completed → 可从 `scripts/patch-sdk.mjs` 去掉 patch 1。
3. 若还在：按新版本压缩标识符重写脚本锚点（不可照抄旧版上下文），并确认失配仍非零退出。

---

## patch 2: Shell sticky cwd / `processWorkingDirectory` 与 `local.cwd` 对齐

- **对应版本**：`@cursor/sdk@1.0.26`（仍未修）
- **锚点**：`processWorkingDirectory:process.cwd()`；以及 `terminalExecutor??createDefaultTerminalExecutor(...)` 算完单工作区路径 `c` 后未 `.clone(c)` 的那段
- **改动文件**：同上 esm/cjs chunk

### 现象

单进程托管多 folders 时，Grep/读写走 LocalExecutor 的 `workingDirectory`（= `local.cwd`）正确，但 Shell 的 sticky cwd 与模型侧 `processWorkingDirectory` 绑在 `process.cwd()`（服务目录），导致 Shell/`pwd`/模型自述工作目录错。

### 修法

1. `processWorkingDirectory` → `workspacePaths[0] ?? process.cwd()`（chunk 内对应形参名以实测为准，1.0.26 esm 为 `t`）。
2. 在算出单工作区路径后，对 default terminal executor 调用 `.clone(c)`（`c` 为非空字符串时）。

### 升级后如何判断还要不要

1. grep `processWorkingDirectory:process.cwd()` 与 `terminalExecutor??` + `createDefaultTerminalExecutor`。
2. 若官方已接到 `workspacePaths[0]`（或等价）且已 clone → 可去掉 patch 2。
3. 否则按新 chunk 标识符更新 `scripts/patch-sdk.mjs`。

### 部署注意

注入后须**重启**跑服务的进程，清掉进程内已缓存的旧 LocalExecutor 租约。AI / agent 会话禁止自行重启 Supervisor，以免杀掉自身。

---

## patch 3: `getTeamRepos` fail closed → 工具调用拿不到结果

- **对应版本**：`@cursor/sdk@1.0.26`（1.0.23 的位点已不同，见「版本漂移」）
- **锚点串**：`const t=this.teamReposPromise;return t.catch(...)` 里的 rejection 分支
- **改动文件**：`dist/esm/357.js`、`dist/cjs/223.js`（与 patch 1/2 同 chunk）

### 现象

每次走 ignore 检查的工具调用（Grep/Glob 的 `runFilesMode` 等）都会调 dashboard 的 `getTeamReposOrEmptyIfNotInTeam`。这个网络调用抖一下（`ConnectError [canceled] http/2 stream closed`、`ETIMEDOUT` 等），异常就沿 `checkRepoBlocked` → `isPostRipgrepBlocked` → `runFilesMode` → `execute` 一路抛出，**没有任何一层把它转成工具错误结果**，最终落到进程的 `unhandledRejection`（本仓库只是打日志）。那次工具调用没有终态事件，模型只能干等到自己放弃后重试，表现为"AI 调用工具拿不到结果"。日志特征是 `未处理的 Promise 拒绝` + 上述 `checkRepoBlocked` 栈。

### 修法

rejection 分支只清缓存、**不再 rethrow**，让 promise resolve 成 `undefined`（fail open）。三个消费点都已把空值当"没有 team repos"处理：`checkRepoBlocked`（`!r||!r.repos` → 不阻断）、`getRepoBlockExcludeGlobs`（→ `[]`）、以及启动期 warmup 的 `Promise.all`（结果未使用）。

对本仓库单用户、无 team blocklist 的场景，fail open 没有实际损失；fail closed 的代价却是整次工具调用消失。上游把 TTL 内缓存 rejected promise 的连环挂法修掉了（拒绝时清缓存），但**当次仍 fail closed**，所以这条补丁仍然必要。

相关上游讨论：[forum #165878](https://forum.cursor.com/t/cursor-sdk-getteamrepos-network-call-on-every-tool-run-causes-etimedout-stopped-tools-local-agent/165878)。

### 版本漂移（升级时别照抄）

- 1.0.23：`fetchTeamRepos()` 独立方法 + `teamReposPromise` 缓存，**不清** rejected promise → 一次抖动后 TTL（5min）内所有相关工具调用全挂。
- 1.0.26：`fetchTeamRepos` 已删，逻辑内联进 `getTeamRepos()`，rejection 时 `this.teamReposPromise=void 0` 后 rethrow。

### 升级后如何判断还要不要

1. 搜 `teamReposPromise`，看 rejection 分支是否仍 rethrow。
2. 若上游已改成 fail open（返回空 repos）→ 可去掉 patch 3。
3. 若还 rethrow：按新 chunk 标识符重写锚点。注意这半段锚点里不含 TTL 变量名，esm/cjs 同形，别顺手把变量名写进去。

---

## 脚本维护备忘

- 锁定版本：`package.json` 的 `@cursor/sdk` 必须与 `scripts/patch-sdk.mjs` 内期望版本一致。
- 升级 SDK：先 `npm pack` 新版本，在未注入的 dist 上确认锚点仍在且唯一，再改脚本；用 `node --check`（cjs）与 `vm.SourceTextModule`（esm，`--check` 会按 CJS 解析）检查改后 chunk 语法。
- **改锚点前先确认自己读的是哪个版本的文件**：`node_modules` 里那份可能滞后于 lock。2026-08-06 排查这条 patch 时就踩了：lock 是 1.0.26，`node_modules` 还是 7 月装的 1.0.23（带老 patch-package 的手工修改态），照它写出来的锚点在真 1.0.26 上根本不存在。安全做法是拿 `npm pack <版本>` 解出来的干净包做锚点。
- 连续两次 `npm i` / 直接跑脚本应全部「已注入,跳过」。
- **注入只改磁盘，不改已在跑的进程**：跑完脚本必须重启服务（Supervisor）才生效。AI / agent 会话禁止自行重启。
