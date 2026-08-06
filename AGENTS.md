# CLAUDE.md

本文件为 Claude Code(claude.ai/code)在本仓库中工作时提供指导。

## 这是什么

一个单用户自用、自托管的 `@cursor/sdk`(Cursor TypeScript SDK)网页对话前端,agent 只跑 **local 运行时**:agent 循环内联跑在这个 Node 进程里,直接读写所选文件夹磁盘上的文件——不开 sandbox、不接 cloud 运行时。可选 `AUTH_TOKEN` cookie 鉴权;默认绑 `127.0.0.1`。这是刻意收窄的 MVP 范围,不是遗漏(改动前想确认"为什么"可看 `plan/` 下对应方案与代码里的 `决策·` 注释)。

后端:Express,无构建步骤(`tsx` 直接跑 `src/*.ts`)。前端:`public/` 下手写的单页 HTML/CSS/JS——无打包器、无框架、无前端 npm 依赖(markdown / 语法高亮靠 CDN `<script>` 引入)。

同页还叠了工作区辅助能力(标题栏常驻 git 入口 / dirty 高亮、diff Overlay、commit+push、落后时 ff-only 拉取、文件浏览插入 `@路径`、assistant TTS、run 结束提示音)——都挂在现有 Express API + Overlay UI 上,不另开路由、不碰 agent 主循环协议。

## 关联项目

- **`claude-code-web-chat`**(姊妹项目)—— 用 Claude Code SDK(`@anthropic-ai/claude-agent-sdk`)独立重做的同类前端。**独立仓库、独立部署**,不在本仓库里做双 backend 兼容:两个 SDK 的会话模型不对称(Cursor 是 `Agent`→`Run` 一等对象,Claude Code 是 `Session`→`query` 内 turn,无对等 `Run`)。分工边界见 `docs/sdk-comparison-cursor-vs-claude-code.md`。

## 常用命令

- `npm run dev` —— 用 `tsx watch` 启动(`src/` 改动自动重启)
- `npm run start` —— 单次启动,不带 watch
- `npm run wecom -- --cwd <path>` —— 企微智能机器人桥接(独立进程,HTTP 调本服务);需 `WECOM_BOT_ID`/`WECOM_SECRET`,详见 `plan/20260801.wecom-bot-bridge.md` 与输出层的 `plan/20260806.wecom-markdown-output.md`。**同一个 bot 只允许一条长连接**:本机跑着 Supervisor 的 `cursor-wecom` 时,另起桥接或跑 `scripts/wecom-contract-check.mjs` 会互相顶掉 subscribe,须先 `supervisorctl stop cursor-wecom`
- `npm run typecheck` —— `tsc --noEmit`;这是仓库里唯一的自动化检查(没有测试套件,没有 lint 配置)
- `npm install` 后会跑 `postinstall: node scripts/patch-sdk.mjs`,对 `@cursor/sdk` 定点注入补丁——**不要跳过**,否则工具调用可能永久卡 RUNNING 或没有终态(见下「SDK 补丁」)
- 必须有 `CURSOR_API_KEY`——缺失时服务启动即退出。`npm run dev/start` 与 Supervisor command 都用 `node --env-file-if-exists=.env` 从仓库根 `.env` 加载;**不要**把密钥写进 Supervisor `environment` / 期望态定义。
- **部署信息在 `deploy/`**:`supervisor.ini` 是 Supervisor program 模板(自行改 `directory=` / 日志路径 / `PORT` 等),`install-supervisor.sh` 负责安装(只替换本机 node 路径,不注入密钥)。
- **本机 `config.json`**(仓库根目录,不进 git;模板见 `config.example.json`)管 `folders` 白名单,以及可选的 `llm` / `tts` / `models` / `fileBrowser`。新机器:复制 example 后按本机改;字段以 example 与 `src/config.ts` 为准,勿在此复述。
- **模型白名单/默认值**在 `config.json` 的 `models` 段(可省略;省略则展示账号全量目录)。账号下全量目录另见启动时缓存的 `models-catalog.json`(不进 git)。

## 排查 agent 会话状态

直接读 SQLite 文件排查 agent/run/事件,不要苦哈哈手动拼路径或猜表结构。脚本都在 `scripts/`:

- **`cursor_agents.py <workspace>`** -- 列出该 workspace 下所有 agent(id、名称、状态、创建/更新时间),一眼看出谁卡在 RUNNING。无需起服务、无需 flask,纯 `sqlite3` 读 `~/.cursor/projects/<sanitized>/sdk-agent-store/<md5>/index.db`。
  - `-a <agent_id>` -- 看该 agent 的所有 turn(run 状态、模型、耗时、token、回复预览)
  - `-a <agent_id> -t <turn>` -- 看某轮的详细统计(事件分布、工具调用次数、思考过程、回复内容)
- **`cursor_agent_viewer.py [--port 5000]`** -- Flask Web 版,按 workspace 分组浏览全部会话历史(需 `pip install flask`)。CLI 排查用上面那个就够,这个适合长时间翻阅历史。
- **`cursor_slow_tools.py <workspace>`**(参数看 `--help`)-- 把工具调用的 running/completed 事件配对,扫"慢调用"和"卡死不返回"。两个反直觉的结论建议先知道,不然看到 status=success 会被误导:shell 超时到点不是被杀进程,而是转后台继续跑完;工具调用"卡死"不是慢,是模型自己判断等不到结果后发起了重试,原始那次调用从此没有下文。

两条排查路径分流:agent **列表里**卡在 RUNNING 的孤儿进程 → `cursor_agents.py`(见上,对应 `决策·orphan-reconcile`);**某一轮内部**具体哪个工具调用慢、或卡死不返回 → `cursor_slow_tools.py`。若怀疑是 SDK 吞了 `toolCallCompleted`,再对照 `docs/cursor_sdk_patches.md`。

## SDK 补丁

本仓库用 `scripts/patch-sdk.mjs` 对 `@cursor/sdk@1.0.26` 定点注入补丁(stall 吞 completion、Shell cwd、team repos fail closed)。已知根因与升级判断:见 `docs/cursor_sdk_patches.md`。注入只改磁盘,须重启服务才生效。

## 架构

主对话是单进程(SDK / runHub / HTTP / 前端);企微桥接为**另一进程**,只经 HTTP 调本服务,不直连 SDK。其上还挂模型目录、短任务网关与若干工作区辅助模块:

1. **SDK 交互层**(`src/agentService.ts`)—— 唯一直接碰 `Agent.*` 的文件。维护一个内存里的 `Map<agentId, SDKAgent>` 句柄缓存(`send()`/`stream()` 依赖活的句柄;缓存未命中则退回 `Agent.resume()`,并对并发请求做了合并去重,避免同一个冷 agent 被并发 resume 两次)。缓存有数量上限 + 空闲 TTL(可用 `AGENT_CACHE_MAX` / `AGENT_CACHE_IDLE_TTL_MS` 覆盖),只淘汰非 busy 条目;另按 cwd 对 LocalExecutor 租约限龄(默认 45min,`AGENT_EXECUTOR_MAX_AGE_MS` 可覆盖),到期主动 `asyncDispose` 空闲句柄以免 accessToken 中毒(见 `决策·cwd-lease-age`)。本地 agent 的重命名/删除/撤销末轮/孤儿 run 回收也在这一层实现,直接操作 SDK 默认的 `SqliteLocalAgentStore`(`@cursor/sdk/sqlite`)——公开的 `Agent.archive/unarchive/delete` 静态方法是 cloud-only 的,本地场景没有对应的官方入口,只能这样绕。以后如果还需要 `Agent.*` 没暴露的本地能力,这是可参考的套路。
2. **run 直播中枢**(`src/runHub.ts`)—— run 的生命周期独立于任何一次 HTTP 请求,归这里托管:一个 run 只被消费一次(`run.stream()`),事件向所有订阅者扇出。**缓存本轮已广播事件,新接入方(含刷新重连)先补发用户文本(`attach`),再整段重放 backlog,然后接实时尾巴**(见 `决策·replay-backlog`;早期「只广播尾巴」的 `replay-tail-only` 已废弃)。订阅者随时可以接入/断开,断开不影响 run 本身继续跑完并持久化;终态后有短暂宽限期再销毁 LiveRun(`决策·terminal-grace`)。
3. **HTTP 层**(`src/server.ts`)—— 静态文件托管 + API + 可选鉴权中间件。保持薄,业务逻辑放进对应 service / 模块,不要堆在这层。
4. **前端单页**(`public/*.js`、`index.html`、`style.css`)—— 无构建步骤,原生 ES 模块。`app.js` 是唯一的组合根;其余按职责单向依赖(`state.js`/`dom.js`/`api.js` 是不 import 任何业务模块的叶子层),避免循环引用。大部分更新仍是整体重渲染 DOM,而不是增量 patch——这是故意的简化取舍,不是要修的 bug。
5. **模型目录**(`src/models.ts`)—— 经 `Cursor.models.list()` 拉账号全量目录,再按 `config.json` 的 `models.allowed` 过滤(可省略)。进程启动时先同步读 `models-catalog.json` 垫底,再后台刷新网络目录。
6. **短任务网关**(`src/llmProxy.ts` + 各调用方)—— OpenAI 兼容 `/chat/completions`,**不走 `@cursor/sdk` Agent**(避免脏写本地会话历史)。地址/key/model 来自 `config.json` 的 `llm` 段;缺配置时标题回退截断、commit 草稿不可用。调用方:标题 / TTS 口语化 / commit 草稿。失败/超时只影响各自功能,不拖垮主对话。
7. **工作区 git**(`src/gitStatus.ts` / `gitDiff.ts` / `gitCommit.ts` / `gitPull.ts`)—— 按 cwd 查 dirty、只读未提交 diff(打开 Overlay 时 fetch+sync)、一锤子 `add -A` → commit → push、以及落后时的 `pull --ff-only`。写路径不做 merge/rebase/force/改历史/自动 `--set-upstream`;commit 前有 behind 闸门;commit✓ push✗ 等分步结果明示、不静默 rollback。
8. **文件浏览**(`src/fileBrowser.ts`)—— 懒加载列目录 + 文本预览;路径经 realpath 默认禁锢在 cwd 内(`fileBrowser.allowParentTree` 可放开到父目录树);前端把 `@绝对路径` **纯文本**插入 composer,不碰 SDK 附件能力。
9. **TTS**(`src/ttsService.ts`)—— 按需且默认关闭:抽该 run 末条 assistant 正文 → llm 口语化 → TTS 流式 pcm → 原子落盘 `data/tts/<runId>.wav`。缓存键=`runId`;undo 末轮 / delete agent 必须同步删对应音频。
10. **结构化日志**(`src/logger.ts`)—— 全链路关键节点共用,排查时优先看这里而不是临时 `console.log`。
11. **企微桥接**(`src/wecom/`)—— 独立进程:长连接收单聊 → `POST /api/chat` + SSE → `aibot_respond_msg` 回推,**过程与正文分两种 msgtype**:过程是一条 `stream` 气泡原地刷新(3 秒一帧、只追加不改写、满页或近 10 分钟窗时换 `stream.id` 续),正文在 run 结束时作为 `markdown` 终稿(超 20480 字节按**字节**分片);指令 `new`/`stop`。分轨的原因是二者诉求相反:企微对 stream 是固定速率逐字动画(几千字的正文会滞后几十秒),而 markdown 无动画但不能原地刷新(高频进度会刷屏)。详见 `plan/20260806.wecom-markdown-output.md`。配了 `AUTH_TOKEN` 时自动带 Cookie。不改 agent 主循环。

### 改动前要了解的数据流

- **历史重建不是靠 `Agent.messages.list()`** 当主数据源——它的 `message` 字段是不透明、结构不稳定的 `unknown`,也不暴露 thinking/工具调用步骤。真正的数据源是 `Agent.listRuns()` + 逐 run 调 `run.conversation()`,返回的是结构化的判别联合(`ConversationStep`)。`messages.list()` 只在两种情况下用到:(a) 某个 run 不支持 `conversation()` 时的降级兜底;(b) 补回 `userMessage.text`——这个字段在 local 运行时下 `conversation()` 里必定缺失。**只展示 `status === "finished"` 的 run**:cancelled/error 等未正常结束的 run 从未提交新 checkpoint,`messages.list()` 里也没有对应 user 消息;若在按位置配对前不剔除,后面每一轮的用户文本都会错位一个位置(见 `history.ts` 的 `决策·cancelled-turn-drop`)。细节见 `src/history.ts`。
- **发消息是"发起即返回" + 统一 SSE 直播。** `POST /api/chat` 只负责建立 run、立即返回 `{agentId}`;run 交给 `runHub`。所有观看方(含发起方)统一走 `GET /api/agent/stream`(SSE)。接入时:补发用户文本 + **重放本轮已缓存事件** + 再接实时流。run **正常**结束后前端重拉 `/api/conversation`(带 `liveRun` 标记)补权威结果;cancelled/error 结束不能这样补(那种 run 在 history 里整轮都不出现),只能保留直播时已画出的内容。
- **浏览器断连 ≠ 取消 run。** 后端会继续消费 `run.stream()` 并持久化。真正中断走 `/api/agent/cancel` → `run.cancel()`。同理:**打开 Overlay(diff / 文件浏览 / commit 确认)只盖 UI,禁止 `detachStream`**(`决策·keep-stream`);diff 与文件浏览 Overlay 互斥。
- **进程异常退出会留下孤儿 running agent/run。** 启动时对每个 folder 扫 `SqliteLocalAgentStore`,把还标着 running/queued 的拨回终态(见 `决策·orphan-reconcile`)。
- **create/resume 必须显式 `settingSources: ["project","user"]`。** SDK 默认不传则解析为全 false,项目级 `AGENTS.md` / `.cursorrules` 与用户层 skills、`~/.cursor/mcp.json` 都不会加载(见 `决策·setting-sources`)。
- **撤销末轮是拨 checkpoint,不是界面隐藏。** `/api/agent/undo` 把 `latestCheckpoint` 拨回末轮 `startCheckpointRef`,删该 run 及其 events,清内存 agent 缓存,并删对应 TTS 缓存。只支持撤销链条末尾那一轮。
- **时间戳、模型、用量都挂在 run 上**,不是单条消息。SDK 只暴露 `run.createdAt` / `run.model` / `run.usage`。
- **每轮 send 都显式带 model。** local agent `resume` 后 `agent.model` 是 `undefined`;中途切模型以当次 `send(text, { model })` 为准。
- **cwd 白名单贯穿一切磁盘作用域 API。** agent 创建/列举、git status/diff/commit、文件 list/read 都只认 `config.json` 的 `folders`;文件路径还要 realpath 落在禁锢根内防逃逸(默认 cwd,见 `决策·fs-scope-tighten`)。这是"按文件夹浏览"产品形态的硬边界。
- **鉴权(可选)。** `AUTH_TOKEN` 用 cookie 承载(见 `决策·cookie-token`);SSE/音频/图片无法带自定义 header。企微桥读同一 token 带 Cookie。

### 同页能力与对应 plan(细节不在此复述)

| 能力 | 入口/模块 | 方案文档 |
|------|-----------|----------|
| 进行中 run 可中途接入直播 | `runHub` + `public/stream.js` | `plan/20260717.live-run-attach.md`(注意 replay 已翻盘为 backlog) |
| 未提交 diff Overlay | `gitDiff` + `public/gitDiff.js` | `plan/20260717.git-diff-overlay.md` |
| diff 上一锤子 commit+push | `gitCommit` + `commitMessageService` | `plan/20260718.git-commit-push.md` |
| 落后远程时 ff-only 拉取 | `gitPull` + diff sync 闸门 | `plan/20260719.git-pull-when-behind.md` |
| 文件浏览 + `@路径` 插入 | `fileBrowser` + `public/fileBrowser.js` | `plan/20260718.file-browser-overlay.md` |
| assistant 按需 TTS | `ttsService` + `public/ttsPlayer.js` | `plan/20260718.assistant-tts.md` |
| TTS / 发送快捷键等用户设置 | `public/userSettings.js` + `ttsPlayer` Wake Lock | `plan/20260718.tts-user-settings.md` |
| 企微智能机器人单聊桥接 | `src/wecom/`(独立进程) | `plan/20260801.wecom-bot-bridge.md` |
| 企微输出:stream 进度气泡 + markdown 终稿 | `progressBubble` + `replyChannel` + `transcript` | `plan/20260806.wecom-markdown-output.md`(输出层已翻盘 20260801 的四条决策) |
| 开源净化与发布 | — | `plan/20260803.open-source-release.md` |

截断上限、音色、UI 文案等易变数字以代码里 `决策·` 与对应 plan §5 为准,不要在本文件另存一份。

### 决策依据在哪找

非直觉的实现选择都以 `决策·<name>`(已定)或 `未决·<name>`(悬而未决)的行内注释标在对应代码处——改之前先 grep `src/` 与 `public/` 里的 `决策·`,不要假设某个设计是随手写的。更完整的决策表在 `plan/`(MVP 见 `plan/20260716.cursor-web-chat-mvp.md` §5;后续能力各有活 spec)。plan 正文可能滞后于代码翻盘(例如 live-run 的 replay 语义),**以代码旁 `决策·` 注释为最终真相**。

官方 SDK 文档以 Cursor 官网为准。`docs/cursor_sdk_patches.md` 记录本仓库对 SDK 的本地补丁。`docs/sdk_internals.md` 是切到 TS SDK 之前(Python SDK 时代)留下的,机制描述已过时,但磁盘 SQLite 布局(`index.db` 的 agents/runs/run_events、每个 agent 一个 `store.db` checkpoint)与现在 local 运行时仍是同一套,了解落盘结构时仍有参考价值。
