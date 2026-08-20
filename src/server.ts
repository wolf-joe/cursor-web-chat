import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "@cursor/sdk";
import {
  buildAuthCookie,
  clearAuthCookie,
  createAuthMiddleware,
  getAuthToken,
  tokenMatches,
} from "./auth.js";
import { loadFolders, addFolder, modelSupportsVision } from "./config.js";
import {
  listFolderAgents,
  countFolderAgents,
  sendMessage,
  isAgentCached,
  AgentBusyLocallyError,
  renameAgent,
  deleteAgent,
  AgentDeleteBusyError,
  cancelRun,
  AgentCancelNotRunningError,
  reconcileOrphanedAgents,
  undoLastTurn,
  AgentUndoBusyError,
  AgentUndoNoTurnsError,
} from "./agentService.js";
import { getConversationHistory } from "./history.js";
import { listAllowedModels } from "./models.js";
import { generateTitle } from "./titleService.js";
import { getGitStatus } from "./gitStatus.js";
import { getGitDiff } from "./gitDiff.js";
import { generateCommitMessage } from "./commitMessageService.js";
import { commitAndPush, GitCommitBusyError } from "./gitCommit.js";
import { pullFfOnly } from "./gitPull.js";
import { GitWriteBusyError } from "./gitWriteLock.js";
import { listDirectory, readTextFile, resolveImageRaw, searchFiles, PathConfineError, FsRawRejectError } from "./fileBrowser.js";
import {
  deleteTtsCache,
  deleteTtsCaches,
  hasTtsCache,
  isTtsEnabled,
  streamTts,
  ttsCachePath,
} from "./ttsService.js";
import {
  deleteUserImage,
  deleteUserImages,
  findUserImage,
  isSafeRunId,
  prepareChatImage,
  writeUserImage,
} from "./userImageStore.js";
import * as runHub from "./runHub.js";
import { log } from "./logger.js";

/** 决策·cwd-allowlist: git / fs 读 API 共用白名单校验。 */
function assertAllowedCwd(cwd: string | undefined): string | null {
  if (!cwd) return "缺少 cwd 参数";
  if (!loadFolders().some((f) => f.cwd === cwd)) {
    return "cwd 不在已添加的文件夹列表中";
  }
  return null;
}

// 侧边栏每个文件夹默认只拉最近 N 个会话,其余靠"加载更多"分页拉取。
const AGENT_PAGE_SIZE = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.CURSOR_API_KEY) {
  console.error(
    "缺少 CURSOR_API_KEY:请在仓库根 .env 配置,或 export CURSOR_API_KEY=... 后再启动。",
  );
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  log.error("未处理的 Promise 拒绝", reason);
});

process.on("uncaughtException", (err) => {
  log.error("未捕获的异常", err);
});

const app = express();
// 决策·json-body-limit: 覆盖 10MB 图 base64(~13.3MB)+余量;默认 ~100KB 会莫名失败。
app.use(express.json({ limit: "16mb" }));
// 决策·cookie-token: 配了 AUTH_TOKEN 时保护全部路径,仅白名单登录页与验证接口。
app.use(createAuthMiddleware());

const publicDir = path.join(__dirname, "..", "public");
// 决策·page-title-server-hostname: 标签页用跑服务的节点 hostname,不是浏览器
// location.host——反代 / 本机端口转发时两者常不一致。每次读盘替换占位符
// (单用户 MVP,IO 可忽略),避免改 public/index.html 后仍吐启动时缓存。
function renderIndexHtml(): string {
  return fs
    .readFileSync(path.join(publicDir, "index.html"), "utf8")
    .replaceAll("__SERVER_HOSTNAME__", os.hostname());
}
app.get(["/", "/index.html"], (_req, res) => {
  res.type("html").send(renderIndexHtml());
});
app.use(express.static(publicDir));

// 决策·cookie-token: 登录写入 HttpOnly cookie;比较用 timingSafeEqual。
app.post("/api/auth/login", (req, res) => {
  const expected = getAuthToken();
  if (!expected) {
    res.status(400).json({ error: "未配置 AUTH_TOKEN,无需登录" });
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!tokenMatches(token, expected)) {
    res.status(401).json({ error: "token 无效" });
    return;
  }
  res.setHeader("Set-Cookie", buildAuthCookie(token));
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearAuthCookie());
  res.json({ ok: true });
});

app.get("/api/folders", async (_req, res) => {
  const folders = loadFolders();
  const result = await Promise.all(
    folders.map(async (folder) => {
      const [{ items, nextCursor }, agentCount] = await Promise.all([
        listFolderAgents(folder.cwd, { limit: AGENT_PAGE_SIZE }),
        countFolderAgents(folder.cwd),
      ]);
      const agents = items.map((agent) => ({ ...agent, cached: isAgentCached(agent.agentId) }));
      return { ...folder, agents, nextCursor, agentCount };
    }),
  );
  res.json({ folders: result });
});

app.post("/api/folders", async (req, res) => {
  const { cwd, name } = req.body as { cwd?: string; name?: string };
  if (!cwd) {
    res.status(400).json({ error: "缺少 cwd 参数" });
    return;
  }
  try {
    const folder = addFolder(cwd, name);
    log.info("添加文件夹", { cwd, name: folder.name });
    res.json({ folder });
  } catch (err) {
    log.error("添加文件夹失败", err, { cwd, name });
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/agents", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const cursor = req.query.cursor as string | undefined;
  if (!cwd) {
    res.status(400).json({ error: "缺少 cwd 参数" });
    return;
  }
  const { items, nextCursor } = await listFolderAgents(cwd, { limit: AGENT_PAGE_SIZE, cursor });
  const agents = items.map((agent) => ({ ...agent, cached: isAgentCached(agent.agentId) }));
  res.json({ agents, nextCursor });
});

app.post("/api/agent/rename", async (req, res) => {
  const { cwd, agentId, name } = req.body as { cwd?: string; agentId?: string; name?: string };
  if (!cwd || !agentId || !name) {
    res.status(400).json({ error: "缺少 cwd、agentId 或 name" });
    return;
  }
  try {
    await renameAgent(cwd, agentId, name);
    log.info("重命名会话", { cwd, agentId, name });
    res.json({ ok: true });
  } catch (err) {
    log.error("重命名会话失败", err, { cwd, agentId, name });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/agent/delete", async (req, res) => {
  const { cwd, agentId } = req.body as { cwd?: string; agentId?: string };
  if (!cwd || !agentId) {
    res.status(400).json({ error: "缺少 cwd 或 agentId" });
    return;
  }
  try {
    const { runIds } = await deleteAgent(cwd, agentId);
    // 决策·delete-agent-tts: SQLite 删完后再清音频,避免库已无 run 但 wav 残留。
    await deleteTtsCaches(runIds);
    // 决策·cleanup-with-tts: 同钩子清旁路用户图。
    await deleteUserImages(runIds);
    log.info("删除会话", { cwd, agentId, ttsCleared: runIds.length });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AgentDeleteBusyError) {
      log.warn("删除会话被拒绝:run 进行中", { cwd, agentId });
      res.status(409).json({ error: err.message });
      return;
    }
    log.error("删除会话失败", err, { cwd, agentId });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/agent/undo", async (req, res) => {
  const { cwd, agentId } = req.body as { cwd?: string; agentId?: string };
  if (!cwd || !agentId) {
    res.status(400).json({ error: "缺少 cwd 或 agentId" });
    return;
  }
  try {
    const { runId } = await undoLastTurn(cwd, agentId);
    // 决策·undo-deletes-tts
    await deleteTtsCache(runId);
    // 决策·cleanup-with-tts
    await deleteUserImage(runId);
    log.info("撤销末轮", { cwd, agentId, runId });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AgentUndoBusyError) {
      log.warn("撤销末轮被拒绝:run 进行中", { cwd, agentId });
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof AgentUndoNoTurnsError) {
      log.warn("撤销末轮被拒绝:无可撤销轮次", { cwd, agentId });
      res.status(400).json({ error: err.message });
      return;
    }
    log.error("撤销末轮失败", err, { cwd, agentId });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/conversation", async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  const cwd = req.query.cwd as string | undefined;
  if (!agentId || !cwd) {
    res.status(400).json({ error: "缺少 agentId 或 cwd 参数" });
    return;
  }
  try {
    const history = await getConversationHistory(agentId, cwd);
    const liveRun = runHub.hasLiveRun(agentId);
    // 决策·log-density: 打开会话只打一条里程碑,不拆「进入 / 加载完成」。
    log.info("会话已加载", {
      cwd,
      agentId,
      mode: history.mode,
      runCount: history.mode === "conversation" ? history.runs.length : history.messages.length,
      liveRun,
    });
    res.json({ ...history, liveRun });
  } catch (err) {
    log.error("加载会话历史失败", err, { cwd, agentId });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·unified-sse-path: 发起方和旁观者都走这一个端点接入 hub 的广播——单一渲染
// 路径。决策·sse-close-on-terminal: 没有 live run(已结束太久或从未开始过)时,
// 直接回一个终止信号,前端据此 EventSource.close() 并转去拉 /api/conversation,
// 不依赖 EventSource 的默认无限重连。
app.get("/api/agent/stream", (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  if (!agentId) {
    res.status(400).json({ error: "缺少 agentId 参数" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const clearHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const unsubscribe = runHub.subscribe(agentId, (event) => {
    send(event);
    if (event.type === "done") {
      clearHeartbeat();
      res.end();
    }
  });

  if (!unsubscribe) {
    send({ type: "done", status: "unknown" });
    res.end();
    return;
  }

  // 决策·sse-comment-heartbeat: 无业务事件时定期写 SSE 注释,避免网关/NAT 空闲掐线;
  // EventSource 与原生解析都忽略 ":" 行。锁屏 OkHttp 长订同一条流也靠这一行。
  // 接入瞬间若已终态,subscribe 会同步送 done 并 end,此时不再开心跳。
  if (!res.writableEnded) {
    heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearHeartbeat();
        return;
      }
      try {
        res.write(": ping\n\n");
      } catch {
        clearHeartbeat();
      }
    }, 15_000);
  }

  req.on("close", () => {
    clearHeartbeat();
    unsubscribe();
  });
});

app.post("/api/agent/cancel", async (req, res) => {
  const { agentId } = req.body as { agentId?: string };
  if (!agentId) {
    res.status(400).json({ error: "缺少 agentId" });
    return;
  }
  try {
    await cancelRun(agentId);
    log.info("取消 run 请求成功", { agentId });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AgentCancelNotRunningError) {
      log.warn("取消 run 请求被拒绝", { agentId });
      res.status(409).json({ error: err.message });
      return;
    }
    log.error("取消 run 请求失败", err, { agentId });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const result = await listAllowedModels();
    // 决策·tts-opt-in: 前端据此决定是否渲染朗读按钮 / TTS 设置项。
    res.json({ ...result, ttsEnabled: isTtsEnabled() });
  } catch (err) {
    log.error("获取模型列表失败", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/git-status", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  try {
    const status = await getGitStatus(cwd!);
    res.json(status);
  } catch (err) {
    log.error("获取 git 状态失败", err, { cwd });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·cwd-allowlist / 决策·cwd-scoped: 与 /api/git-status 同源白名单校验;
// 独立 /api/git-diff,避免把 patch 塞进标题栏轮询的 status 接口。
app.get("/api/git-diff", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  try {
    const diff = await getGitDiff(cwd!);
    res.json(diff);
  } catch (err) {
    log.error("获取 git diff 失败", err, { cwd });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·api-split / 决策·message-via-gateway: 单独生成草稿,失败可手填,不必重跑 git。
app.post("/api/git-commit-message", async (req, res) => {
  const { cwd } = req.body as { cwd?: string };
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  try {
    const draft = await generateCommitMessage(cwd!);
    res.json(draft);
  } catch (err) {
    log.error("生成 commit message 失败", err, { cwd });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·cwd-allowlist / 决策·path-confine / 决策·lazy-tree:
// 懒加载列目录;子路径须落在 cwd 内;不展示点开头项。
app.get("/api/fs/list", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const dirPath = req.query.path as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  try {
    const result = await listDirectory(cwd!, dirPath);
    res.json(result);
  } catch (err) {
    if (err instanceof PathConfineError) {
      res.status(403).json({ error: err.message });
      return;
    }
    log.error("列目录失败", err, { cwd, path: dirPath });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·truncation / 决策·path-confine / 决策·preview-langs / 决策·image-preview-a-plus:
// 只读文本预览或位图元信息;超限/二进制标 skipped;合格图片给 kind+url,字节走 /api/fs/raw。
app.get("/api/fs/read", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const filePath = req.query.path as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  if (!filePath) {
    res.status(400).json({ error: "缺少 path 参数" });
    return;
  }
  try {
    const result = await readTextFile(cwd!, filePath);
    res.json(result);
  } catch (err) {
    if (err instanceof PathConfineError) {
      res.status(403).json({ error: err.message });
      return;
    }
    log.error("读文件失败", err, { cwd, path: filePath });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·image-preview-secure-raw / 决策·image-preview-exts / 决策·image-preview-max-bytes:
// 位图字节出口;禁锢+扩展名白名单+5MB;供 <img> 同源加载(cookie 鉴权)。
app.get("/api/fs/raw", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const filePath = req.query.path as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  if (!filePath) {
    res.status(400).json({ error: "缺少 path 参数" });
    return;
  }
  try {
    const { absPath, mimeType } = await resolveImageRaw(cwd!, filePath);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, no-cache");
    res.sendFile(absPath);
  } catch (err) {
    if (err instanceof PathConfineError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FsRawRejectError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    log.error("读图片失败", err, { cwd, path: filePath });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·search-api / 决策·sync-walk / 决策·match-relpath / 决策·search-caps /
// 决策·path-confine / 决策·cwd-allowlist:
// cwd 内相对路径子串搜索;空白 q 由前端不调,误调 400;逃逸 403。
app.get("/api/fs/search", async (req, res) => {
  const cwd = req.query.cwd as string | undefined;
  const q = req.query.q as string | undefined;
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  if (typeof q !== "string" || !q.trim()) {
    res.status(400).json({ error: "缺少 q 参数" });
    return;
  }
  try {
    const result = await searchFiles(cwd!, q);
    res.json(result);
  } catch (err) {
    if (err instanceof PathConfineError) {
      res.status(403).json({ error: err.message });
      return;
    }
    log.error("文件搜索失败", err, { cwd, q });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·write-path-scope / 决策·partial-success / 决策·no-dangerous-git:
// 一锤子 add→commit→push;返回分步结果,不 rollback;不接受任意 git args。
app.post("/api/git-commit-push", async (req, res) => {
  const { cwd, message } = req.body as { cwd?: string; message?: string };
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "commit message 不能为空" });
    return;
  }
  try {
    const result = await commitAndPush(cwd!, message);
    // 业务上的部分成功仍用 200 + ok:false,方便前端分态展示;锁冲突用 409。
    res.json(result);
  } catch (err) {
    if (err instanceof GitWriteBusyError || err instanceof GitCommitBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    log.error("git commit/push 失败", err, { cwd });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 决策·ff-only-pull / 决策·pull-response-shape / 决策·shared-busy-lock:
// 仅 pull --ff-only;与 commit-push 共用写锁;业务失败 200+ok:false。
app.post("/api/git-pull", async (req, res) => {
  const { cwd } = req.body as { cwd?: string };
  const deny = assertAllowedCwd(cwd);
  if (deny) {
    res.status(deny.startsWith("缺少") ? 400 : 403).json({ error: deny });
    return;
  }
  try {
    const result = await pullFfOnly(cwd!);
    res.json(result);
  } catch (err) {
    if (err instanceof GitWriteBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    log.error("git pull 失败", err, { cwd });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  const { cwd, agentId, text, model, image } = req.body as {
    cwd?: string;
    agentId?: string;
    text?: string;
    model?: ModelSelection;
    // 决策·json-base64 / 决策·max-one-image-10mb: 单张 { mimeType, data },不走 multipart。
    image?: { mimeType?: string; data?: string };
  };

  // 决策·text-required-with-image: 有图也必须非空 text(标题/语义);禁止仅图。
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (!cwd || !trimmedText) {
    res.status(400).json({ error: "缺少 cwd 或 text" });
    return;
  }

  // 前端理应总是带上用户在模型选择器里选的 model;缺省只兜底给没传的调用方
  // (比如直接 curl / 企微桥),不是 UI 的正常路径。
  const resolvedModel = model ?? (await listAllowedModels()).default;
  if (!resolvedModel?.id) {
    res.status(500).json({ error: "无可用模型" });
    return;
  }

  let validatedImage: Awaited<ReturnType<typeof prepareChatImage>> | undefined;
  if (image !== undefined && image !== null) {
    // 决策·vision-allowlist
    if (!modelSupportsVision(resolvedModel.id)) {
      res.status(400).json({ error: `模型 ${resolvedModel.id} 不支持图片` });
      return;
    }
    try {
      // 决策·compress-before-send: 校验 10MB 后、send 前压到 1MB。
      validatedImage = await prepareChatImage(image);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  // 请求没带 agentId 才是真正的"新建会话"(sendMessage 内部据此决定 createAgent
  // 还是续聊现有 agent,见 agentService.ts)——只有这种情况才需要生成标题。
  const isNewAgent = !agentId;

  // 决策·log-density / 决策·send-milestone-agentService: 请求入口与「交给 runHub」
  // 不再打 info;成功里程碑只在 agentService.sendMessage 打一条。
  let handle;
  try {
    handle = await sendMessage(
      agentId,
      cwd,
      trimmedText,
      resolvedModel,
      validatedImage
        ? [{ data: validatedImage.data, mimeType: validatedImage.mimeType }]
        : undefined,
    );
  } catch (err) {
    if (err instanceof AgentBusyLocallyError) {
      log.warn("聊天请求被拒绝:agent 忙", { cwd, agentId });
      res.status(409).json({ error: err.message });
      return;
    }
    log.error("聊天请求失败", err, { cwd, agentId, model: resolvedModel });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const { agent, run } = handle;

  // 决策·persist-best-effort + 决策·side-store-by-runId: run.id 已知后写盘;
  // 写盘完成后再 startRun,避免重连抢在落盘前。失败只打日志、attach 无 imageUrl。
  let imageUrl: string | undefined;
  if (validatedImage) {
    imageUrl = (await writeUserImage(run.id, validatedImage.mimeType, validatedImage.buffer)) ?? undefined;
  }

  // 决策·hub-owns-lifecycle + unified-sse-path: 这个请求只负责"发起",不再消费
  // run.stream()——run 的生命周期交给 runHub 独立托管,前端(含发起方自己)另开
  // GET /api/agent/stream 接入观看。
  runHub.startRun(agent.agentId, run, trimmedText, cwd, imageUrl);

  // 决策·title-generation: 和 run 完全解耦的并行流程,不阻塞这次响应;标题就绪后
  // 经 runHub 广播给所有正在观看这个 agent 的订阅者(见 runHub.broadcastTitle)。
  if (isNewAgent) {
    generateTitle(trimmedText)
      .then(async (title) => {
        if (!title) return;
        await renameAgent(cwd, agent.agentId, title);
        runHub.broadcastTitle(agent.agentId, title);
      })
      .catch((err) => {
        log.error("标题生成/写回失败(不影响会话)", err, { cwd, agentId: agent.agentId });
      });
  }

  res.json({ agentId: agent.agentId });
});

// 决策·api-shape: 未缓存时 POST SSE 推 pcm16;已缓存时前端应走 GET wav。
  // 决策·tts-sse-close: 不能用 req.on("close")——POST 在 express.json 读完 body
  // 后就会触发 req close,若此时 end 响应,后续 status/audio/done 全部被丢掉,
  // 流水线仍在后台跑完(日志里能看到「缓存已写入」),前端却一直卡在 loading。
  // 客户端断开应听 res "close"。
app.post("/api/tts/stream", async (req, res) => {
  if (!isTtsEnabled()) {
    res.status(503).json({ error: "TTS 未启用(见 config.json tts 段)" });
    return;
  }
  const { cwd, agentId, runId } = req.body as {
    cwd?: string;
    agentId?: string;
    runId?: string;
  };
  if (!cwd || !agentId || !runId) {
    res.status(400).json({ error: "缺少 cwd、agentId 或 runId" });
    return;
  }
  if (!loadFolders().some((f) => f.cwd === cwd)) {
    res.status(403).json({ error: "cwd 不在已添加的文件夹列表中" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { promise, unsubscribe } = streamTts(cwd, agentId, runId, (event) => {
    if (res.writableEnded) return;
    send(event);
    if (event.type === "done" || event.type === "error") res.end();
  });

  res.on("close", unsubscribe);

  try {
    await promise;
  } catch (err) {
    if (!res.writableEnded) {
      send({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      res.end();
    }
  }
});

app.get("/api/tts/:runId", async (req, res) => {
  const runId = req.params.runId;
  if (!runId || runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    res.status(400).json({ error: "无效 runId" });
    return;
  }
  if (!hasTtsCache(runId)) {
    res.status(404).json({ error: "音频尚未生成" });
    return;
  }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(ttsCachePath(runId));
});

// 决策·side-store-by-runId: 旁路用户图;UI 只经此 GET,不解析 SDK 历史图。
app.get("/api/user-images/:runId", async (req, res) => {
  const runId = req.params.runId;
  if (!isSafeRunId(runId)) {
    res.status(400).json({ error: "无效 runId" });
    return;
  }
  const found = findUserImage(runId);
  if (!found) {
    res.status(404).json({ error: "图片不存在" });
    return;
  }
  res.setHeader("Content-Type", found.mimeType);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(found.filePath);
});

// 每个 folder 各自的 SQLite store 都扫一遍,把上次异常退出遗留的孤儿 agent/run
// 拨回终态(见 agentService.ts 的 决策·orphan-reconcile)。单个 folder 扫失败不该
// 拖累其余 folder / 整个服务启动,只记日志。
async function reconcileAllFolders(): Promise<void> {
  for (const folder of loadFolders()) {
    try {
      const fixed = await reconcileOrphanedAgents(folder.cwd);
      if (fixed > 0) {
        log.info("启动时自动回收孤儿 run", { folder: folder.name, cwd: folder.cwd, fixed });
      }
    } catch (err) {
      log.error("孤儿 run 回收失败(不影响服务启动)", err, { folder: folder.name, cwd: folder.cwd });
    }
  }
}

// 决策·listen-host: 默认绑 127.0.0.1;HOST 显式放开。非本机回环且无 token 时醒目告警。
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = (process.env.HOST?.trim() || "127.0.0.1");

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

reconcileAllFolders().finally(() => {
  if (!isLoopbackHost(HOST) && !getAuthToken()) {
    const banner = [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      `  警告: 正在监听 ${HOST}:${PORT} 且未配置 AUTH_TOKEN。`,
      "  本服务默认零鉴权;folders 白名单不是沙箱——能打开网页的人",
      "  即可让 agent 执行任意 shell、触达本机文件与凭据。",
      "  请设置 AUTH_TOKEN,或改回 HOST=127.0.0.1。",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n");
    console.error(banner);
    log.error("危险监听配置: 非本机回环且无 AUTH_TOKEN", undefined, { host: HOST, port: PORT });
  }
  app.listen(PORT, HOST, () => {
    log.info("服务已启动", { host: HOST, port: PORT, url: `http://${HOST}:${PORT}` });
  });
});
