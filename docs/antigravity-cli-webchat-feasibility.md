# Antigravity CLI（agy）用于 Web Chat 的可行性调研

> 调研日期：2026-07-18 · 本机 `agy 1.1.3`（`~/.local/bin/agy`）  
> 目的：评估能否用 **stdout + 本地 session 文件** 做类似 cursor-web-chat 的会话管理与流式聊天。  
> 结论：**可以做姊妹项目外壳**；不要塞进本仓库的 `@cursor/sdk` 层（与 Claude Code 姊妹仓同一分工原则）。

---

## 1. 一句话结论

| 能力 | 是否够用 | 集成面 |
|------|----------|--------|
| 发消息 + 流式直播 | ✅ | `agy --print` + `--output-format stream-json` |
| 多轮续聊 | ✅ | `--conversation <uuid>` / `-c` |
| 会话列表 / 历史回放 | ✅ | 读本地 DB + `transcript*.jsonl` |
| Cancel | ⚠️ 可 hack | kill 进程（脏落盘 + 工具子进程可能逃逸） |
| Undo | ❌ 不宜第一期 | 无公开 API；改 DB 是 protobuf，脆 |
| 与本仓库双 backend 归一 | ❌ | 独立仓库，复制 UI 外壳即可 |

---

## 2. CLI 入口（已验证）

```bash
# 新会话 / 单轮（非交互）
agy --print "..." --dangerously-skip-permissions \
  --output-format stream-json --print-timeout 5m

# 续指定会话
agy --print "..." --conversation=<uuid> --dangerously-skip-permissions \
  --output-format stream-json

# 续「当前 cwd 最近一次」会话
agy --print "..." -c --dangerously-skip-permissions --output-format json
```

要点：

- `--print` / `--prompt` / `-p`：非交互跑一轮并退出（Web 包装主路径）。
- `--prompt-interactive` / `-i`：交互 TUI，不适合服务端（本机 `run_agy.sh` 在用）。
- `--continue` / `-c`：按 **cwd** 查 `cache/last_conversations.json`。
- `--conversation`：按 UUID 续聊；ID 错误时日志写 ignore，不硬失败。
- `--dangerously-skip-permissions`：无头自动批准工具；Web 几乎必需。
- `--model` / `--add-dir` / `--mode accept-edits|plan`：可用。
- **`--output-format` 不在 `--help` 里**，但实测支持 `text` | `json` | `stream-json`（隐藏契约，升级有风险）。

`agy agentapi …` 需要 `ANTIGRAVITY_LS_ADDRESS`（依赖本机 Language Server），**不要当主集成面**。

---

## 3. Stdout 契约

### 3.1 `text`（默认）

只打最终回复纯文本。适合脚本；不适合直播 UI。

### 3.2 `json`

进程结束时一行 JSON，例如：

```json
{
  "conversation_id": "...",
  "status": "SUCCESS",
  "response": "...",
  "duration_seconds": 3.1,
  "num_turns": 1,
  "usage": { "input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "total_tokens": 0 }
}
```

### 3.3 `stream-json`（推荐直播）

NDJSON，事件类型：

| event | 作用 |
|-------|------|
| `init` | 给出 `conversation_id`、cwd、工具列表、`permission_mode` |
| `step_update` | 步骤推进：`user_input` / `agent_response`（`text_delta`）/ `tool`（`tool_name`+`tool_info`）/ `checkpoint` / `system_message` |
| `result` | 终态：`SUCCESS` / `ERROR` + 完整 `response` + usage |

工具步骤示例字段：`tool_info.parameters`、完成后的 `tool_info.output`。  
中途 SIGTERM 时，有时仍会吐出 `result.status=ERROR`。

---

## 4. 本地 Session 布局

根目录：`~/.gemini/antigravity-cli/`（IDE 版在 `~/.gemini/antigravity/`，用 `app_data_dir` 区分）。

```
antigravity-cli/
├── conversations/<uuid>.db          # 权威轨迹（SQLite + protobuf blob）
├── conversation_summaries.db        # 列表摘要
├── cache/last_conversations.json    # cwd → 最近 conversation_id
├── cache/conversation_metadata.json # 摘要缓存
├── history.jsonl                    # 输入历史（偏 TUI）
└── brain/<uuid>/.system_generated/logs/
    ├── transcript.jsonl             # 可读 JSONL（可截断）
    └── transcript_full.jsonl        # 未截断，1:1 对齐
```

**历史重建**：优先读 `transcript*.jsonl`（`USER_INPUT` / `PLANNER_RESPONSE` / 工具类型等）。  
**不要**把 `.db` 的 protobuf 当主解析目标。  
列表：读 `conversation_summaries.db`（含 `preview`、`step_count`、`workspace_uris`、时间）。

官方内嵌说明：`transcript.jsonl` 与 `transcript_full.jsonl` 行一一对应；大字段只在 full 里完整。

---

## 5. 对照 cursor-web-chat 的映射

| 本项目 | AGY Web 包装建议 |
|--------|------------------|
| `POST /api/chat` → 立即返回 + `runHub` | spawn `agy --print … stream-json`，解析 stdout 扇出 |
| `GET /api/agent/stream` SSE | 同一套 NDJSON → SSE/WebSocket |
| `GET /api/conversation` | 读 `transcript*.jsonl`（+ summaries） |
| `GET /api/agents` | 读 `conversation_summaries.db`，按 workspace 过滤 |
| `/api/agent/cancel` | `kill` / `killpg` 子进程（见 §6） |
| `/api/agent/undo` | **第一期不做** |
| in-process SDK 句柄缓存 | 无；每轮冷启动子进程（秒级开销已实测） |

建议架构（姊妹仓，勿双 backend）：

```
浏览器 ──HTTP/SSE──► Express
                       ├─ spawn agy --print (stream-json)
                       ├─ 扇出 step_update / result
                       └─ 只读 ~/.gemini/antigravity-cli 做列表/历史
```

---

## 6. Cancel / Undo / 孤儿进程（实测）

### 6.1 Cancel ≈ kill

- 输出中途杀 `agy`：**能停直播**；同 UUID **往往仍可 `--conversation` 续上**。
- 落盘会脏：transcript/DB 可留 `RUNNING` 等未收尾步骤；续聊时状态可能被拨走（非干净 cancelled）。
- **只杀 `agy` 不够**：正在跑的 `run_command`（bash/sleep）常逃到 PID 1 继续跑。

建议：spawn 时 `start_new_session` / 独立 pgid → Cancel 时 `killpg`；并尽量回收工具子进程（pgid 不可靠时要记 pid / 扫残留）。

### 6.2 Undo ≈ 改文件

- 只改 UI / 只改 transcript：**模型上下文不变**（续聊吃 `.db`）。
- 改 `conversations/<id>.db`：protobuf + summaries/brain 需一致 → **脆，不宜第一期**。
- 替代：不做 Undo，或「开新会话 / 带摘要重说」。

### 6.3 孤儿与进程组

- **Web → agy**：进程组 / systemd `KillMode=control-group` 有效，父死可带走 agy。
- **agy → 工具孙进程**：可能 `setsid`，**杀 agy 的 pgid 带不走**。

### 6.4 单轮正常结束时，工具子进程还在吗？

| 情况 | agy 退出后 |
|------|------------|
| 普通前台工具跑完再回复 | **不在**（先 DONE 再退出） |
| 模型 `setsid`/`nohup`/`disown` 挂后台 | **还在**（ppid=1） |
| 仅 `cmd &` 未脱离 | 常随工具 shell 收掉，不可靠 |

单轮 `--print` 常见路径是第一种；泄漏主要来自「中途 kill」和「显式脱离后台」。

---

## 7. 风险与第一期建议

**风险**

1. `--output-format` 隐藏，升级可能变。
2. 每轮子进程冷启动，延迟高于 Cursor in-process SDK。
3. 无正规 cancel/undo；硬杀有脏状态与逃逸工具进程。
4. OAuth 在 `~/.gemini`；服务进程须同用户凭据。
5. 同 conversation 并行多进程未验证 → 建议单会话串行。

**第一期建议做**

- 列表（summaries）+ 历史（transcript）+ 发消息（stream-json）+ 续聊（`--conversation`）
- Cancel = killpg + 尽力收工具进程
- `--dangerously-skip-permissions` + workspace 白名单（对齐本项目 cwd allowlist 思路）

**第一期不做**

- Undo、rename/delete 的「官方级」实现
- 依赖 `agentapi` / Language Server
- 与本仓库双 SDK 归一

---

## 8. 本机验证摘录

```bash
# 纯文本
agy --print "Reply with exactly: OK" --dangerously-skip-permissions
# → OK

# 流式 + 续聊（同 conversation_id，num_turns 递增）
agy --print "Say hi" --output-format stream-json --dangerously-skip-permissions
agy --print "What did I say?" --conversation=<id> --output-format stream-json \
  --dangerously-skip-permissions
```

会话文件在 `~/.gemini/antigravity-cli/`；`cache/last_conversations.json` 在 `--print` 后会写入当前 cwd 的最新 ID。
