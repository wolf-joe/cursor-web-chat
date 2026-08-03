# 从 Checkpoint 读取上下文占比

> **文档定位**：只读技术说明——如何从本地 agent checkpoint 取出「当前上下文窗口占用」(`used` / `max`)，供 UI 展示占比。  
> **实证日期**：2026-07-22 · SDK `@cursor/sdk@1.0.23` · workspace `cursor-web-chat`  
> **结论**：本地 checkpoint **有**窗口占用数据。每个带 checkpoint 的 run，其 root blob 几乎都带有 `ConversationTokenDetails`；用公开的 `SqliteLocalAgentStore.checkpoints.get` 即可读取，不必改 SDK、不必挂 Connect interceptor。

---

## 0. 一页纸

| 问题 | 答案 |
|------|------|
| 公开 API 有没有？ | **没有**。`Run.usage` / `TokenUsage` 是**计费合计**（可远超窗口），不是窗口占用。 |
| 数据在哪？ | 本地 SQLite checkpoint：**run 的 `latestCheckpointRef.rootBlobId`** 指向的那一包 bytes。 |
| 根 blob 是什么？ | protobuf `agent.v1.ConversationStateStructure`（SDK 内部 `loadLatest` 即对该 blob 做 `fromBinary`）。 |
| 字段？ | **field 5 = `token_details`** → `agent.v1.ConversationTokenDetails`：`used_tokens`(1) / `max_tokens`(2) / 可选 `breakdown`(3)。 |
| 怎么读？ | `SqliteLocalAgentStore.checkpoints.get({ agentId, blobId })`，只解析根消息 field 5；**不要** BFS 整棵 merkle。 |
| 占比怎么算？ | `used / max`（例如 `95032 / 256000 ≈ 37%`）。无 field 5 则隐藏。 |

---

## 1. 两类「token」不要混

| | `Run.usage`（公开） | `ConversationTokenDetails`（checkpoint） |
|--|---------------------|------------------------------------------|
| 含义 | 本轮（及累计计费口径）消耗 | **当前 prompt 占上下文窗口多少** |
| 典型量级 | 可到数十万～数百万 | `used < max`，`max` 常见 `256000` / `200000` |
| 落盘 | `index.db` → `runs.usage_json` | per-agent `store.db` → blobs，挂在 conversation state |
| SDK 暴露 | `run.usage` | **不暴露**；只能读 blob |

同 run 对照：`usage.totalTokens = 1_828_341`，同时 `used=107297 / max=256000`（~42%）。计费合计不能当上下文进度条。

---

## 2. Proto 形状（SDK 打包内 schema）

来源：`node_modules/@cursor/sdk/dist/esm/index.js` 内嵌 protobuf（按 `typeName` 可搜到完整 field list）。

```text
agent.v1.ConversationTokenDetails
  1  used_tokens                 uint32
  2  max_tokens                  uint32
  3  breakdown                   TokenUsageBreakdown?      // 分类明细，可选
  4  prompt_context_usage_tree   PromptContextUsageTree?   // 本机样本多为空

agent.v1.ConversationStateStructure
  1  root_prompt_messages_json   repeated bytes   // 落盘时常为 32B blob id
  8  turns                       repeated bytes   // 同上
  5  token_details               ConversationTokenDetails   ← 目标
  … 其它字段（todos / summary / mode / …）
```

补充：

- local 运行时打包 chunk（如 `357.js`）里搜不到 `tokenDetails`——只说明客户端展示路径不消费该字段，**不代表不落盘**。服务端写入的 conversation state 经 checkpoint 保存时整包进 root blob。
- `root_prompt_messages_json` / `turns` 在磁盘上多为 **32 字节 content-addressed 子 blob id**（merkle 边），与本仓库 `src/checkpointUserText.ts` 对 blob 布局的观察一致。读窗口占比时**无需、也不该**展开这些叶子。

---

## 3. 取数步骤

### 3.1 打开 store

```ts
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";

const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd });
```

`cwd` 须是工作区路径（本项目里即 `config.json` 的 `folders` 项）。磁盘落点等价于：

`~/.cursor/projects/<sanitized>/sdk-agent-store/<md5>/`（`index.db` + 各 agent 的 `store.db`）。

### 3.2 选定 blob id（按 run，不是按 agent）

历史每一轮要自己的占比，用 **该 run 结束时的 checkpoint**：

```ts
const rootBlobId = run.latestCheckpointRef?.rootBlobId;
if (!rootBlobId) {
  // 无 checkpoint：无窗口数据（例如 cancelled 且未推进时）
}
```

`agent.latestCheckpoint` 只代表**会话当前末态**，不能用来回填历史各 turn。

### 3.3 只读 root，解析 field 5

```ts
const data = await store.checkpoints.get({ agentId, blobId: rootBlobId });
// data: Uint8Array | null  —— ConversationStateStructure 二进制
```

解析要点（手写 protobuf 游标即可，与 `src/checkpointUserText.ts` 同套路；不必依赖未导出的 `@anysphere/proto` 路径）：

1. 沿 root 顶层字段扫描；
2. 遇到 **field = 5、wire = 2（length-delimited）**，取出子切片；
3. 在子切片里读 varint：**field 1 → used**，**field 2 → max**；
4. field 3/4 若存在可忽略（占比只需要 used/max）。

伪代码：

```ts
function extractContextUsage(root: Uint8Array): { used: number; max: number } | null {
  // walk top-level protobuf fields of ConversationStateStructure
  // when field===5 && wire===2:
  //   parse nested: field1 → used, field2 → max
  // return (used!=null && max!=null) ? { used, max } : null
}
```

**不要**对 child blob id 做 BFS，再启发式「猜」哪段 bytes 像 used/max：子 blob 是消息/turn 内容树，体积大、易误伤，且与 field 5 无关。

### 3.4 占比与展示

```ts
const ratio = used / max;            // 通常落在 0..1
const pct = Math.round(ratio * 100); // UI 文案用
```

拿不到 `used`/`max` 时不展示。

---

## 4. 本机实证摘要

探测方式：只解析 `run.latestCheckpointRef.rootBlobId` 的 field 5（workspace = 本仓库路径）。

| 样本 | 结果 |
|------|------|
| agent（有 latestCheckpoint） | 50/50 有 `token_details` |
| run（有 latestCheckpointRef） | 168/168 有 `used`+`max`（命中率 **1.0**） |
| `max` 分布 | 几乎全是 `256000`，偶发 `200000` |
| `breakdown` | 样本中普遍存在（field 3） |
| `prompt_context_usage_tree` | 样本中未见 |

样例：

```text
status=finished  model=grok-4.5  usageTotal=187448   used=95032  max=256000  (~37%)
status=finished  model=grok-4.5  usageTotal=1828341  used=107297 max=256000  (~42%)
```

---

## 5. 接到产品时的注意点

本文件只说明「数据怎么读」。若要把占比挂到每轮 UI，还需自行定持久化与生命周期，常见约束：

1. **按 `runId` 落一份可读快照**（或等价缓存）——本项目 run 正常结束后前端会 refetch `/api/conversation` 整段重绘；若只写进当次直播 SSE、不进历史响应，刷新后会丢。
2. **读取时机**：run 终态后再读该 run 的 `latestCheckpointRef`；进行中的 root 未必已带上最终 `token_details`。
3. **撤销末轮 / 删除 agent**：同步清掉该 `runId`（或该 agent 下各 run）的快照，避免脏数据。
4. **契约稳定性**：依赖未公开的 blob 布局与 proto field 号。SDK 大升级后应用同一规则抽检「root 是否仍有 field 5 + used/max」。手写游标即可，不必绑私有 proto 包路径。

---

## 6. 相关代码 / 文档

| 路径 | 关系 |
|------|------|
| `src/checkpointUserText.ts` | 同 store、同「root + 32B 子 blob id」布局；用于用户原文差分，**不含** `token_details` |
| `src/history.ts` | 历史组装；当前只带公开的 `run.usage` |
| `docs/sdk_internals.md` | `index.db` / per-agent `store.db` 磁盘布局 |
| SDK `AgentCheckpointStore.loadLatest` | 内部对 root 做 `ConversationStateStructure.fromBinary`；对外类型为 opaque `unknown` |
