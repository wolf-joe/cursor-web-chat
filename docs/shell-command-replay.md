# Shell 工具同一命令被执行两次

2026-11-06。Cursor Agent 的一次 Shell 工具调用，在宿主机上跑出了两个内容相同的审查会话。
工具最终没有返回输出，只报中断。

## 现象

Agent 只发了一次 Shell 工具调用，执行一条只读审查脚本。
该脚本会向远端新开一个审查会话，默认等待上限 10 分钟。
远端先后出现两个审查会话，提示词与审查说明逐字相同。

工具返回：

`Shell command was interrupted before it completed. It may still be running.`

Shell 工具的 `block_until_ms` 设为 600000（10 分钟），与脚本自身的等待上限相同。

## 根因结论

这不是本地 Shell 会话重启，也不是前端 SSE 重连重放。
真实原因是：**第 1 个脚本进程在跑满约 8 分 53 秒正常完成并回传大段输出时，通往 Cursor 云端的长连接发生传输层断流，触发 `@cursor/sdk` 自动从工具执行前的 checkpoint 发起 `resumeAction` 重连。**
云端恢复时见该调用仍在 `pending_tool_calls` 中未结案，便换用新的 `execId` 重新派发了同一个 `toolCallId`；而本地 SDK 的去重缓存只认 `execId`、不认 `toolCallId`，导致同一命令被完整执行了第二次。

### 1. 会话 A 与 B 并未重叠运行（为什么目录锁没拦住？）

会话 A 库文件的 `mtime`（`10:49:54`）是事后排查读取 SQLite 时触发的更新，并非会话 A 仍在写入。
直接解码会话 A 最后一步（第 113 步，产出 1.4 万字审查报告）的 protobuf 时间戳，并核对远端服务日志与本地目录锁文件，可确认：

- 会话 A 在 `10:48:52.253` 已写完第 113 步，远端服务在 `10:48:52.261` 记录阻塞请求正常返回（`status: OK`）。
- 第 1 个脚本进程在 `10:48:53.7` 左右已将完整报告写入 `stdout`、释放 `flock` 目录锁并以 `exit 0` 正常退出。
- 4 秒后（`10:48:58.022`）第 2 个脚本进程启动时，前一个进程早已退出释锁，因此顺利拿到同一把目录锁并建立了会话 B。

### 2. 时间线（2026-11-06，UTC+8）

| 时间 | 事件与证据来源 |
|---|---|
| `10:39:52` | 用户发起本轮请求，模型在 `10:39:55` 发出唯一一次 Shell 工具调用。 |
| `10:40:00.567` | 云端先将含 `pending_tool_calls` 的 checkpoint 落盘到本地 `store.db`。 |
| `10:40:00.769` | 云端第 1 次下发 `toolCallStarted`（`run_events` seq=17）与执行请求；本地启动第 1 个脚本进程并建立远端会话 A。 |
| `10:40:00` – `10:48:53` | 脚本阻塞等待远端审查完成，期间无输出；本地 SDK 定时发送心跳，未触发本地 stall 检测。 |
| `10:48:52.261` | 远端会话 A 完成全部 113 步，阻塞调用返回 `status: OK`。 |
| `约 10:48:53.7` | 第 1 个脚本写出报告、释放 `flock` 锁并正常退出。本地 SDK 将 `stdout` 与 `exit` 写回云端流时发生传输断开，云端未收到结果也未推进 checkpoint。 |
| `约 10:48:55` | `@cursor/sdk` 将断流归类为可重试传输错误，退避约 1 秒后携带 `10:40:00.567` 的旧 checkpoint 自动发送 `resumeAction`。 |
| `10:48:57.287` | 云端根据旧 checkpoint 的 `pending_tool_calls`，对同一 `toolCallId` 重新下发 `toolCallStarted`（`run_events` seq=18）与带新 `execId` 的执行请求。 |
| `10:48:58.022` | 本地 SDK 再次拉起脚本进程，获取目录锁并建立远端会话 B。 |
| `10:49:38.157` | 用户在前端点击取消，本轮变为 `CANCELLED`，第 2 个脚本进程被 `SIGTERM` 终止，会话 B 停在第 18 步。 |
| `10:50:09.640` | 用户发起下一轮追问时，云端为上一轮悬空的 `pending_tool_calls` 自动补齐合成报错：`Error: Shell command was interrupted before it completed. It may still be running.` |

### 3. 本地 SDK 为什么没有幂等去重？

`@cursor/sdk`（`dist/esm/357.js`）在流式 Shell 执行器（`s.wv`）外层包了一层 `lru-cache` 与可重放流多播器 `rs`：

- 原本的设计是：同一执行请求若被重复调用，命中缓存时直接 `fork()` 重放已缓存的流事件（若首次已完成则直接回放 `stdout` 与 `exit`），不再起新进程。
- **问题出在缓存键选错了字段**：代码用每次派发生成的 `ExecServerMessage.exec_id`（`o.execId`）作缓存键，而非工具调用自身的 `ShellArgs.toolCallId`（`n.toolCallId`）。
- 当连接断开并经 `resumeAction` 从旧 checkpoint 恢复时，云端对同一 `toolCallId` 重新生成的 `execId` 是新的，导致本地 LRU 未命中，直接穿透到底层启动了第 2 个进程。
- 扫描本机各工作区的 `index.db`，共有十余次长耗时 Shell 调用出现过「同一 `run_id` + 同一 `call_id` 先后记录两条 `running` 事件」的同类重放。

### 4. 其它现象与修复方向

- **为什么这次调用在 `terminals/` 目录下没有记录，而其它几次同类调用有？**
  本地 SDK 仅在两种情况下写 `terminals/<shellId>.txt`：
  - 显式后台运行（`block_until_ms: 0`），走 `backgroundShellManager.spawn()`；
  - 前台等待达到 `block_until_ms` 上限后转入后台，走 `backgroundShellManager.adopt()`。
  此前留有记录的调用是因为使用了较短的 `block_until_ms`（如 30 秒），超时转后台后才落盘文件；本次 `block_until_ms` 设为 600000（10 分钟），两次执行分别在 533 秒完成和 585 秒被取消，均未触发转后台阈值。
- **修复**：`scripts/patch-sdk.mjs` 的 patch 5 把 `s.wv`（`shellStream`）与 `ns` 的 LRU 缓存键改为 `toolCallId` + args 哈希（无 `toolCallId` 时仍用 `execId`）。
  无论在执行中途还是完成回传瞬间发生 `resumeAction` 重放，本地都直接 `fork()` 复用第一次的进程流与输出，不再重复建进程。细节见 `docs/cursor_sdk_patches.md` 的 patch 5。
