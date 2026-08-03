# `@cursor/sdk` 本地补丁记录

本仓库在 `npm install` 的 `postinstall` 里运行 `scripts/patch-sdk.mjs`，对 `@cursor/sdk@1.0.26` 的 `dist/esm` 与 `dist/cjs` 做**定点字符串注入**（不使用 `patch-package`，不在仓库里分发 SDK 构建产物全文）。

- **任一条锚点失配 → 非零退出**，让安装失败。静默跳过是这里最坏的失败模式（工具调用会永久卡 RUNNING，或 Shell cwd 错绑）。
- **幂等**：打过补丁后「未修补」锚点不再命中，脚本跳过已注入项。
- **只注入 patch 1 + patch 2**；不注入原 patch 3（team repos）。见下文。

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

## 未带走：原 patch 3（`getTeamRepos` fail closed）

1.0.26 上游已去掉 `fetchTeamRepos` 缓存 rejected promise 的连环挂法；`getTeamRepos` 拒绝时清缓存后再抛——**当次**调用仍可能 STOPPED，但同轮后续可重试。对本仓库单用户、无 team blocklist 场景可接受，故开源注入**不包含** patch 3，少一处易碎锚点。

相关上游讨论：[forum #165878](https://forum.cursor.com/t/cursor-sdk-getteamrepos-network-call-on-every-tool-run-causes-etimedout-stopped-tools-local-agent/165878)。

---

## 脚本维护备忘

- 锁定版本：`package.json` 的 `@cursor/sdk` 必须与 `scripts/patch-sdk.mjs` 内期望版本一致。
- 升级 SDK：先 `npm pack` 新版本，在未注入的 dist 上确认锚点仍在且唯一，再改脚本；用 `node --check` 检查改后 chunk 语法。
- 连续两次 `npm i` / 直接跑脚本应全部「已注入,跳过」。
