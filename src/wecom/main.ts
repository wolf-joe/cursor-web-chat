/**
 * 企业微信智能机器人桥接入口(独立进程)。
 * 方案: plan/20260801.wecom-bot-bridge.md
 *
 * 用法:
 *   npm run wecom -- --cwd /path/to/workspace
 * 环境变量: WECOM_BOT_ID / WECOM_SECRET / WECOM_CWD / WECOM_BASE_URL
 */
import os from "node:os";
import path from "node:path";
import { loadFolders } from "../config.js";
import { log } from "../logger.js";
import { ChatApiClient } from "./api.js";
import { WecomBridge } from "./bridge.js";
import { WecomWsClient } from "./ws.js";

interface CliConfig {
  cwd: string;
  baseUrl: string;
  botId: string;
  secret: string;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function printUsage(): void {
  console.log(`用法: npm run wecom -- --cwd <绝对路径> [选项]

必需:
  --cwd <path>          固定 workspace(须在 config.json folders 白名单内;支持 ~)
  WECOM_BOT_ID          企微智能机器人 BotID
  WECOM_SECRET          长连接 Secret

可选:
  --base-url <url>      主服务地址(默认 http://127.0.0.1:3000)
  WECOM_CWD / WECOM_BASE_URL  也可代替对应 CLI 参数

指令(单聊文本,整句匹配;可选前导 /):
  help|/?     显示指令说明
  new|/new    解绑当前会话(不删),下一条开新会话
  stop|/stop  中断进行中的 run
`);
}

function parseArgs(argv: string[]): CliConfig {
  let cwd = process.env.WECOM_CWD?.trim() || "";
  let baseUrl = process.env.WECOM_BASE_URL?.trim() || "http://127.0.0.1:3000";
  const botId = process.env.WECOM_BOT_ID?.trim() || "";
  const secret = process.env.WECOM_SECRET?.trim() || "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    if (a === "--cwd") {
      cwd = argv[++i] ?? "";
      continue;
    }
    if (a === "--base-url") {
      baseUrl = argv[++i] ?? baseUrl;
      continue;
    }
    throw new Error(`未知参数: ${a}`);
  }

  if (!cwd) throw new Error("缺少 --cwd 或 WECOM_CWD");

  // Supervisor 等不会展开 ~;path.resolve('~/x') 会相对 directory 拼出错误路径。
  cwd = path.resolve(expandHome(cwd));
  baseUrl = baseUrl.replace(/\/$/, "");

  // 决策·cwd-cli: 必须落在 folders 白名单。
  const folders = loadFolders();
  if (!folders.some((f) => f.cwd === cwd)) {
    throw new Error(
      `cwd 不在 config.json folders 白名单中: ${cwd}\n已配置: ${folders.map((f) => f.cwd).join(", ") || "(空)"}`,
    );
  }

  if (!botId) throw new Error("缺少环境变量 WECOM_BOT_ID");
  if (!secret) throw new Error("缺少环境变量 WECOM_SECRET");

  return { cwd, baseUrl, botId, secret };
}

function main(): void {
  let cfg: CliConfig;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }

  // 桥接不需要 CURSOR_API_KEY;只依赖主服务已启动。
  log.info("企微桥接启动", {
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    botIdPrefix: `${cfg.botId.slice(0, 6)}…`,
  });

  const ws = new WecomWsClient(cfg.botId, cfg.secret);
  const api = new ChatApiClient(cfg.baseUrl);
  const bridge = new WecomBridge({ cwd: cfg.cwd, baseUrl: cfg.baseUrl, ws, api });
  bridge.attach();
  // 断线不续刷旧 req_id;主服务 run 继续。
  ws.setDisconnectHandler(() => bridge.onWsDisconnected());
  ws.start();

  const shutdown = () => {
    log.info("企微桥接正在退出");
    ws.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
