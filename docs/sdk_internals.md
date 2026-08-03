# Cursor Python SDK 源码探索发现

> 本文记录从 SDK 源码（`cursor_sdk` Python 包 + vendored Node.js bridge）中确认的实现细节，
> 补充官方文档未覆盖的部分。

## 包信息

- **安装路径**: `venv/lib/python3.12/site-packages/cursor_sdk/`
- **Bridge 二进制**: `venv/bin/cursor-sdk-bridge`（实际是 Node.js 脚本，源码在 `cursor_sdk/_vendor/bridge/`）
- **Python 依赖的 Node.js 运行时**: bridge 进程，由 SDK 自动启动和管理

## LocalAgentOptions 完整字段

来源: `cursor_sdk/types.py:586`

```python
@dataclass(frozen=True)
class LocalAgentOptions:
    cwd: Sequence[str | os.PathLike[str]] | str | os.PathLike[str] | None = None
    setting_sources: Sequence[SettingSource | str] | None = None
    sandbox_options: SandboxOptions | Mapping[str, Any] | None = None
    store: LocalAgentStoreConfig | Mapping[str, Any] | None = None
    auto_review: bool | None = None
    custom_tools: Mapping[str, CustomTool | Mapping[str, Any]] | None = None
```

### SandboxOptions

来源: `cursor_sdk/types.py:520`

```python
@dataclass(frozen=True)
class SandboxOptions:
    enabled: bool | None = None
```

目前只有 `enabled` 一个字段。

### LocalAgentStoreConfig

来源: `cursor_sdk/types.py:528`

```python
@dataclass(frozen=True)
class LocalAgentStoreConfig:
    type: str           # "sqlite"(默认) / "jsonl" / "custom"
    root_dir: str | None = None  # 仅 jsonl 类型时必填
```

## 存储机制

### 三种 store 类型

| type | 存储引擎 | 谁管理 | 说明 |
|------|---------|--------|------|
| `"sqlite"` | SQLite | bridge (Node.js) 内部 | **默认值**，不传 store 即用此模式 |
| `"jsonl"` | JSONL 文件 | bridge (Node.js) 内部 | 需指定 `root_dir` |
| `"custom"` | 完全自定义 | Python 宿主进程 | 需实现 `LocalAgentStoreHandler` 接口，通过 loopback RPC 被 bridge 调用 |

来源: `cursor_sdk/_store_callback.py` 中的 `local_store_bridge_argv()` 和 `needs_store_callback_server()`

### 默认存储路径

当 `store=None`（即默认 sqlite 模式）时，bridge 自动计算 stateRoot:

**路径公式**:
```
~/.cursor/projects/{sanitized-workspace-name}/sdk-agent-store/{md5(workspace-path)}/
```

- `{sanitized-workspace-name}`: workspace 绝对路径中 `/` 替换为 `-`（如 `/path/to/my-project` → `path-to-my-project`）
- `{md5(workspace-path)}`: workspace 绝对路径的 MD5 哈希（32 字符十六进制）

来源: bridge 的 `server.js:138` 中 `defaultStateRootForWorkspace()`

### 存储目录结构

```
~/.cursor/projects/{workspace-name}/sdk-agent-store/{md5-hash}/
├── index.db                          # 主库
│   ├── agents 表                      # agent 元数据 (agent_id, name, status, created_at)
│   ├── runs 表                        # 每次对话运行记录 (run_id, agent_id, status, model, usage_json, result, ...)
│   └── run_events 表                  # 运行事件流 (run_id, seq, offset, event_type, payload_json)
├── index.db-wal                      # SQLite WAL 模式日志
├── index.db-shm                      # SQLite 共享内存文件
└── agents/
    └── agent-{sha256(agentId)}/      # 每个 agent 一个目录
        ├── store.db                  # agent 的 checkpoint blobs
        ├── store.db-wal
        └── store.db-shm
```

### index.db 表结构

#### agents 表

| 字段 | 说明 |
|------|------|
| `agent_id` | `agent-<uuid>` 格式 |
| `name` | 显示名称 |
| `status` | `IDLE` / `RUNNING` 等 |
| `created_at` | ISO 8601 时间戳 |

#### runs 表

| 字段 | 说明 |
|------|------|
| `run_id` | 运行 ID |
| `request_id` | 请求 ID |
| `agent_id` | 关联的 agent |
| `turn_number` | 轮次编号 |
| `status` | `running` / `finished` / `error` / `cancelled` / `expired` |
| `model` | 使用的模型 ID |
| `model_params_json` | 模型参数 |
| `usage_json` | token 使用量 |
| `result` | 最终文本结果 |
| `created_at` / `started_at` / `finished_at` | 生命周期时间戳 |

#### run_events 表

| 字段 | 说明 |
|------|------|
| `run_id` | 关联的运行 |
| `seq` | 事件序号（按此排序回放流） |
| `offset` | 事件偏移量 |
| `event_type` | 事件类型 |
| `payload_json` | 事件载荷（消息内容、工具调用等） |
| `payload_ref` | 大载荷的外部引用 |

### store.db 表结构（per-agent）

| 表 | 说明 |
|------|------|
| `blobs` | checkpoint 二进制数据 |
| `meta` | agent 元信息 |

## Custom Store（自定义存储）

来源: `cursor_sdk/_local_store.py`

当 `store.type = "custom"` 时，需要实现 `LocalAgentStoreHandler` 协议，包含四个子存储:

```python
class LocalAgentStoreHandler(Protocol):
    @property
    def agents(self) -> StoreAgentsHandler: ...        # get/create/update/delete/list
    @property
    def runs(self) -> StoreRunsHandler: ...             # get/create/update/delete/list
    @property
    def run_events(self) -> StoreRunEventsHandler: ...  # append/list/delete
    @property
    def checkpoints(self) -> StoreCheckpointsHandler: ... # get/create/update/delete/list
```

工作原理:
1. Python SDK 在本地启动一个 `StoreCallbackServer`（loopback HTTP 服务）
2. 将 endpoint URL 和 auth token 通过 `--store-callback-url` / `--store-callback-auth-token` 传给 bridge
3. bridge 通过 Connect/JSON RPC 将所有 store 操作转发给 Python 宿主
4. 子存储方法可以是同步或异步（异步方法需要 `AsyncClient` 的事件循环）

## Bridge 生命周期

来源: `cursor_sdk/_bridge.py`

### 默认客户端

当使用 `Agent.create()` 等顶层方法时，SDK 会自动启动模块级默认客户端:

```python
# _client.py:78
_DEFAULT_BRIDGE = Bridge.launch(workspace=os.getcwd())
```

默认以 `os.getcwd()` 为 workspace，不传 `state_root`（由 bridge 自行计算默认路径）。

### 显式客户端

```python
with CursorClient.launch_bridge(workspace=".", state_root="/custom/path") as client:
    ...
```

显式传入 `state_root` 可覆盖默认存储路径。

### Bridge 启动参数

`Bridge.launch()` 接受的参数（`_bridge.py:128`）:

| 参数 | 对应 argv | 说明 |
|------|----------|------|
| `workspace` | `--workspace` | 工作区路径 |
| `state_root` | `--state-root` | 存储根目录 |
| `host` | `--host` | 监听地址 |
| `port` | `--port` | 监听端口 |
| `local` | `--local-store` (JSON) | 本地存储配置 |
| `store_handler` | `--store-callback-url` + `--store-callback-auth-token` | 自定义存储回调 |

## 调试技巧

### 查看 SDK 日志

```bash
CURSOR_SDK_LOG=debug python script.py
```

### 查看 bridge 帮助

```bash
cursor-sdk-bridge --help
```

### 直接查询存储数据库

```bash
# 查看所有 agent
sqlite3 ~/.cursor/projects/{workspace-name}/sdk-agent-store/{hash}/index.db \
  "SELECT agent_id, name, status, created_at FROM agents;"

# 查看运行记录
sqlite3 ~/.cursor/projects/{workspace-name}/sdk-agent-store/{hash}/index.db \
  "SELECT run_id, agent_id, status, model, created_at FROM runs;"
```

### 恢复已有会话

```python
from cursor_sdk import Agent

agent = Agent.resume("agent-<id>")
run = agent.send("继续上次的话题")
print(run.text())
```
