# Cursor Web Chat

单用户、自托管的 [@cursor/sdk](https://www.npmjs.com/package/@cursor/sdk) 网页对话前端。Agent 只跑 **local 运行时**：循环内联在本 Node 进程里，直接读写所选文件夹磁盘上的文件。

> **非官方项目**。与 Cursor / Anysphere 无关；项目名中的 Cursor 仅作指明性使用。

## 安全声明（必读）

**唯一的安全边界是「谁能访问这个网页」。**

`config.json` 的 folders 白名单与文件浏览的 realpath 禁锢，约束的是「在哪开会话 / UI 能浏览什么」，**不是沙箱**。Agent 跑在 LocalExecutor 里可以执行任意 shell，可触达整个文件系统与全部凭据。

默认监听 `127.0.0.1`。若把 `HOST` 改成 `0.0.0.0` 或其它非本机地址，请务必配置 `AUTH_TOKEN`；否则启动会打醒目告警。

## 快速开始

要求：Node.js ≥ 22.13、本机有 [Cursor API Key](https://cursor.com/dashboard)。

```bash
git clone https://github.com/wolf-joe/cursor-web-chat.git
cd cursor-web-chat
cp config.example.json config.json   # 改 folders 为本机绝对路径
cp .env.example .env                 # 填 CURSOR_API_KEY
npm install                          # 会自动对 @cursor/sdk@1.0.26 注入必要补丁
npm start                            # http://127.0.0.1:3000
```

验收：新建会话 → 发一轮会调用工具的对话 → 工具调用收敛到终态（不卡在 RUNNING）。

### 可选：访问令牌

在 `.env` 设 `AUTH_TOKEN=...` 后，未登录访问会跳到登录页；登录后 cookie 覆盖 SSE / TTS 音频 / 用户图片三类浏览器原生加载。https 部署可另设 `AUTH_COOKIE_SECURE=1`。

### 可选：短任务网关（标题 / commit 草稿 / TTS）

`config.json` 的 `llm` 段提供 OpenAI 兼容的 `/chat/completions`。**省略 `llm.baseUrl` 时**：标题回退为用户首句截断，commit 草稿不可用但不阻塞提交。

`tts` 段**默认关闭**。开启需 `enabled: true` 且配置 `baseUrl`；口语化仍依赖 `llm` 段。当前合成请求使用非标准 `audio` 字段（见 `src/ttsService.ts`），换网关可能需自行适配。

### 可选：企微智能机器人桥接

独立进程，只经 HTTP 调本服务：

```bash
# .env 中配置 WECOM_BOT_ID / WECOM_SECRET；与主服务共用 AUTH_TOKEN（若有）
npm run wecom -- --cwd /path/to/workspace
```

详见 `plan/20260801.wecom-bot-bridge.md`。

## 配置摘要

| 来源 | 内容 |
|------|------|
| `.env` | `CURSOR_API_KEY`（必填）、`HOST`/`PORT`、`AUTH_TOKEN`、`WECOM_*` |
| `config.json` | `folders`（必填）、可选 `llm` / `tts` / `models` / `fileBrowser` |

- **models**：`allowed` 省略或空 → 选择器展示账号全量目录；`default` 省略 → 用目录首项。
- **fileBrowser.allowParentTree**：默认 `false`（只允许 cwd 内）；`true` 时恢复「父目录树含兄弟目录」行为（monorepo 外链）。

完整字段见 `config.example.json`。

## 本机迁移清单（从旧私有部署升级）

若你之前跑的是未开源版本：

1. `npm install` 会升到 `@cursor/sdk@1.0.26`，并只注入 stall completion + Shell cwd 两处补丁（不再带 team repos 那条）。
2. 把旧的 `llmFlashModel` 迁到 `llm: { baseUrl, apiKey, model }`；缺 `baseUrl` 时标题/草稿会降级。
3. 增加 `tts` 段并设 `enabled: true`，否则朗读按钮消失。
4. 把原先硬编码的模型白名单写入 `models`；省略则变为账号全量目录。
5. 若依赖「浏览兄弟目录」，设 `fileBrowser.allowParentTree: true`。
6. 若配置了 `AUTH_TOKEN`，企微桥会自动带同一 token 的 Cookie；未配则与从前一致。
7. 默认监听改为 `127.0.0.1`；若仍需 `0.0.0.0`，显式设 `HOST` 并配置 `AUTH_TOKEN`。

## 架构一览

- **后端**：Express + `tsx`，无构建步骤（`src/*.ts`）。
- **前端**：`public/` 下手写单页，无打包器、无前端 npm 依赖。
- **SDK**：仅 `src/agentService.ts` 直接碰 `Agent.*`；run 生命周期由 `runHub` 托管，经 SSE 直播。
- **补丁**：`postinstall` 运行 `scripts/patch-sdk.mjs`，对 SDK 构建产物做定点注入。失配会让 `npm install` 失败（避免静默装上却卡死）。说明见 `docs/cursor_sdk_patches.md`。

更细的设计取舍见 `AGENTS.md` 与 `plan/`。

## 常用命令

```bash
npm run dev        # tsx watch
npm run start      # 单次启动
npm run typecheck  # tsc --noEmit
npm run wecom -- --cwd <path>
```

Supervisor 部署模板在 `deploy/`（自行改 `directory=` / 日志路径；密钥只放仓库根 `.env`）。

## License

[MIT](./LICENSE)
