/**
 * 企微 markdown 输出契约验证(一次性诊断脚本,不属于生产链路)。
 * 方案: plan/20260806.wecom-markdown-output.md 任务#0
 *
 * 用法(需先停掉 cursor-wecom,同 bot 只允许一条长连接):
 *   supervisorctl stop cursor-wecom
 *   node --env-file-if-exists=.env scripts/wecom-contract-check.mjs
 *   然后在企微单聊里给机器人发任意一条文字
 *
 * 验证:
 *   1 同一 req_id 能否连发多条 markdown
 *   2 markdown 是否有逐字动画(肉眼观察)
 *   3 markdown 方言渲染(肉眼观察)
 *   4 背靠背连发的到达与顺序
 *   5 20480 字节上限与超限错误码
 *   6 WS 重连后旧 req_id 是否仍可回复
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const WS_URL = "wss://openws.work.weixin.qq.com";
const BOT_ID = process.env.WECOM_BOT_ID?.trim();
const SECRET = process.env.WECOM_SECRET?.trim();
const OUT_DIR = path.resolve("data/wecom/contract-check");

if (!BOT_ID || !SECRET) {
  console.error("缺少 WECOM_BOT_ID / WECOM_SECRET");
  process.exit(1);
}

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, " ");
const logLines = [];
function say(line) {
  const s = `[${ms()}ms] ${line}`;
  console.log(s);
  logLines.push(s);
}

/** 每条待发消息的观测结果;ACK 只回 req_id,所以按发送顺序配对。 */
const steps = [];
let ackCursor = 0;

let ws = null;
let subscribeReqId = null;
let onSubscribed = null;
let callbackReqId = null;
let started = false;

function connect(label) {
  return new Promise((resolve, reject) => {
    say(`连接中 (${label})`);
    const sock = new WebSocket(WS_URL);
    ws = sock;
    onSubscribed = resolve;

    sock.on("open", () => {
      subscribeReqId = randomUUID();
      send({
        cmd: "aibot_subscribe",
        headers: { req_id: subscribeReqId },
        body: { bot_id: BOT_ID, secret: SECRET },
      });
    });

    sock.on("message", (data) => handleFrame(data.toString()));
    sock.on("error", (err) => say(`WS error: ${err.message}`));
    sock.on("close", (code) => say(`WS closed code=${code}`));
    setTimeout(() => reject(new Error("subscribe 超时")), 15_000);
  });
}

function send(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    say(`发送失败:连接未就绪 (${frame.cmd})`);
    return false;
  }
  ws.send(JSON.stringify(frame));
  return true;
}

function sendMarkdown(content) {
  return send({
    cmd: "aibot_respond_msg",
    headers: { req_id: callbackReqId },
    body: { msgtype: "markdown", markdown: { content } },
  });
}

function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    say(`非 JSON 帧: ${raw.slice(0, 120)}`);
    return;
  }
  const { cmd, errcode, errmsg } = frame;
  const reqId = frame.headers?.req_id;

  if (reqId && reqId === subscribeReqId && (errcode === 0 || errcode === undefined) && !cmd) {
    say("subscribe 成功");
    subscribeReqId = null;
    onSubscribed?.();
    onSubscribed = null;
    return;
  }

  if (cmd === "aibot_msg_callback") {
    if (started) {
      say("已在验证中,忽略新消息");
      return;
    }
    started = true;
    callbackReqId = reqId;
    const body = frame.body ?? {};
    say(`收到消息回调 msgtype=${body.msgtype} text=${JSON.stringify(body.text?.content ?? "")}`);
    dumpFixture(frame);
    void runSequence();
    return;
  }

  if (!cmd) {
    // respond 的 ACK:按发送顺序配对。
    const step = steps[ackCursor++];
    const tag = step ? step.name : `未配对#${ackCursor}`;
    say(`ACK ${tag} errcode=${errcode ?? 0} errmsg=${errmsg ?? "ok"}`);
    if (step) {
      step.errcode = errcode ?? 0;
      step.errmsg = errmsg ?? "ok";
    }
    return;
  }

  say(`其它帧 cmd=${cmd} errcode=${errcode ?? "-"} errmsg=${errmsg ?? "-"}`);
}

function dumpFixture(frame) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const masked = JSON.parse(JSON.stringify(frame));
  if (masked.body?.from?.userid) masked.body.from.userid = "<MASKED_USERID>";
  if (masked.body?.chatid) masked.body.chatid = "<MASKED_CHATID>";
  if (masked.body?.aibotid) masked.body.aibotid = "<MASKED_AIBOTID>";
  // response_url 带 response_code,是回调模式下的一次性回复凭证。
  if (masked.body?.response_url) masked.body.response_url = "<MASKED_RESPONSE_URL>";
  if (masked.headers?.req_id) masked.headers.req_id = "<MASKED_REQID>";
  const file = path.join(OUT_DIR, "msg-callback.json");
  fs.writeFileSync(file, JSON.stringify(masked, null, 2));
  say(`回调帧已脱敏存档: ${file}`);
}

const DIALECT_SAMPLE = `# 一级标题
## 二级标题
**加粗** *斜体* ~~删除线~~ \`行内代码\`

- 无序列表 1
- 无序列表 2
  - 嵌套 2.1

1. 有序列表 1
2. 有序列表 2

> 一级引用
>> 二级引用

[链接](https://work.weixin.qq.com)

---

\`\`\`ts
// 独立代码块:能否渲染为块
const x: number = 1;
\`\`\`

| 列 A | 列 B |
| :--- | ---: |
| 值 1 | 值 2 |`;

const LONG_PARAGRAPH = `#3 动画观察:这一整段应当瞬间完整出现,如果看到逐字打印说明 markdown 也走打字机。${"这是用于观察渲染速度的填充文字。".repeat(60)}`;

function padTo(bytes, header) {
  const filler = "填充";
  let s = header;
  while (Buffer.byteLength(s + filler, "utf8") <= bytes) s += filler;
  return s;
}

async function sleep(msec) {
  await new Promise((r) => setTimeout(r, msec));
}

async function step(name, note, fn) {
  const rec = { name, note, sentAt: Date.now() - t0 };
  steps.push(rec);
  say(`发送 ${name} — ${note}`);
  rec.sent = fn();
}

async function runSequence() {
  try {
    await step("#1", "首条 markdown", () => sendMarkdown("**#1 首条 markdown**\n\n如果这条到了,说明 respond_msg 能发 markdown。"));
    await sleep(2500);

    await step("#2", "方言样本", () => sendMarkdown(DIALECT_SAMPLE));
    await sleep(2500);

    await step("#3", `长段落 ${Buffer.byteLength(LONG_PARAGRAPH)} 字节`, () => sendMarkdown(LONG_PARAGRAPH));
    await sleep(2500);

    await step("#4a", "背靠背第一条", () => sendMarkdown("#4a 背靠背第一条(应先到)"));
    await sleep(150);
    await step("#4b", "背靠背第二条", () => sendMarkdown("#4b 背靠背第二条(应后到)"));
    await sleep(2500);

    const near = padTo(20470, "#5 贴近上限 20470 字节:\n");
    await step("#5", `${Buffer.byteLength(near)} 字节(上限内)`, () => sendMarkdown(near));
    await sleep(2500);

    const over = padTo(20600, "#6 故意超限 20600 字节:\n");
    await step("#6", `${Buffer.byteLength(over)} 字节(预期失败,取错误码)`, () => sendMarkdown(over));
    await sleep(2500);

    say("强制断开连接,测试重连后旧 req_id 是否仍可回复");
    ws.removeAllListeners("close");
    ws.terminate();
    await sleep(1000);
    await connect("重连");
    await sleep(500);
    await step("#7", "重连后用旧 req_id 发送", () => sendMarkdown("#7 重连后使用旧 req_id 发送(若到达则 req_id 跨重连有效)"));
    await sleep(3000);

    summarize();
  } catch (err) {
    say(`序列异常: ${err?.message ?? err}`);
    summarize();
  }
}

function summarize() {
  say("—— 汇总(errcode 为空表示未收到 ACK)——");
  for (const s of steps) {
    say(`${s.name} ${s.note} → sent=${s.sent} errcode=${s.errcode ?? "无ACK"} ${s.errmsg ?? ""}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "run.log");
  fs.writeFileSync(file, `${logLines.join("\n")}\n`);
  say(`日志已写入 ${file}`);
  say("请在企微里核对:哪些气泡真的出现了、顺序如何、有无逐字动画、方言渲染成什么样");
  setTimeout(() => process.exit(0), 500);
}

await connect("首次");
say("已就绪。请在企微单聊里给机器人发一条文字(例如 ping)");
setTimeout(() => {
  if (!started) {
    say("5 分钟内没有收到消息回调,退出");
    process.exit(2);
  }
}, 5 * 60 * 1000);
