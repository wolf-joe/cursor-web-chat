import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { log } from "../logger.js";

const WS_URL = "wss://openws.work.weixin.qq.com";
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export type WecomFrame = {
  cmd?: string;
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
  errcode?: number;
  errmsg?: string;
};

export type WecomMsgCallback = {
  reqId: string;
  msgid: string;
  chattype?: string;
  msgtype?: string;
  userid?: string;
  text?: string;
  raw: WecomFrame;
};

type MsgHandler = (msg: WecomMsgCallback) => void | Promise<void>;

/**
 * 决策·wecom-ws-client: 不用 Node 内置/undici WebSocket——对本企微入口握手常报
 * generic "non-101",且 error 后可能不触发 close、事件循环空转退出。改用 `ws` 包
 * (与裸 TLS Upgrade 行为一致,实测可 101)。
 */
export class WecomWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private subscribed = false;
  private onMessage: MsgHandler | null = null;
  // 决策·ws-generation: 重连后旧连接上的迟到回调/定时器不得再发帧。
  private generation = 0;
  private pendingSubscribeReqId: string | null = null;
  /** 本代连接是否已安排重连,避免 error+close 双触发重复排程。 */
  private reconnectScheduledForGen = -1;

  constructor(
    private readonly botId: string,
    private readonly secret: string,
  ) {}

  setMessageHandler(handler: MsgHandler): void {
    this.onMessage = handler;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.clearReconnectTimer();
    this.generation += 1;
    this.tearDownSocket();
    this.subscribed = false;
  }

  /** 当前长连接是否可用(已 subscribe)。 */
  get ready(): boolean {
    return this.subscribed && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 决策·stream-progress-markdown-final: 过程用 stream 气泡,同 stream.id 全量替换。
   * 自首帧起 10 分钟内必须 finish,超时企微自动结束该气泡(决策·stream-rollover 靠换
   * stream.id 续窗)。
   */
  respondStream(opts: {
    reqId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): boolean {
    return this.send({
      cmd: "aibot_respond_msg",
      headers: { req_id: opts.reqId },
      body: {
        msgtype: "stream",
        stream: { id: opts.streamId, finish: opts.finish, content: opts.content },
      },
    });
  }

  /**
   * 正文终稿。同一 req_id 可连发多条(实测),每条是独立气泡。
   * content 超 20480 字节会被服务端整条拒收(errcode 40058),分片责任在调用方。
   */
  respondMarkdown(opts: { reqId: string; content: string }): boolean {
    return this.send({
      cmd: "aibot_respond_msg",
      headers: { req_id: opts.reqId },
      body: {
        msgtype: "markdown",
        markdown: { content: opts.content },
      },
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.generation += 1;
    const gen = this.generation;
    this.subscribed = false;
    this.clearPing();
    this.clearReconnectTimer();
    this.tearDownSocket();

    log.info("企微长连接:正在连接", { url: WS_URL });
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this.generation || this.ws !== ws) return;
      log.info("企微长连接:握手成功,发送 subscribe");
      const reqId = randomUUID();
      this.pendingSubscribeReqId = reqId;
      this.send({
        cmd: "aibot_subscribe",
        headers: { req_id: reqId },
        body: { bot_id: this.botId, secret: this.secret },
      });
    });

    ws.on("message", (data) => {
      if (gen !== this.generation || this.ws !== ws) return;
      void this.handleRawMessage(data.toString());
    });

    ws.on("close", (code, reasonBuf) => {
      if (gen !== this.generation) return;
      const reason = reasonBuf?.toString() || undefined;
      this.subscribed = false;
      this.clearPing();
      if (this.ws === ws) this.ws = null;
      log.warn("企微长连接:已断开", { code, reason });
      // 决策·reqid-across-reconnect: 断线不需要放弃本轮,重连后旧 req_id 仍可回复,
      // 未送出的关键消息由 ReplyChannel 的重试队列补发。
      this.scheduleReconnect(gen);
    });

    ws.on("error", (err) => {
      // `ws` 会在 error 后仍发 close;这里先打清原因。若 close 迟迟不来也排重连。
      if (gen !== this.generation) return;
      log.warn("企微长连接:WebSocket error", {
        message: err.message,
        code: (err as NodeJS.ErrnoException).code,
        cause:
          err.cause instanceof Error
            ? err.cause.message
            : err.cause != null
              ? String(err.cause)
              : undefined,
      });
    });
  }

  private scheduleReconnect(gen: number): void {
    if (this.stopped) return;
    if (this.reconnectScheduledForGen === gen) return;
    this.reconnectScheduledForGen = gen;

    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    log.info("企微长连接:准备重连", { delayMs: delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private tearDownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners();
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    } catch {
      /* ignore */
    }
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let frame: WecomFrame;
    try {
      frame = JSON.parse(raw) as WecomFrame;
    } catch {
      log.warn("企微帧非 JSON", { preview: raw.slice(0, 120) });
      return;
    }

    const cmd = frame.cmd;
    const errcode = frame.errcode;
    const reqId = frame.headers?.req_id;

    if (errcode !== undefined && errcode !== 0) {
      log.error("企微帧错误", undefined, {
        cmd,
        errcode,
        errmsg: frame.errmsg,
        reqId,
      });
      if (reqId && reqId === this.pendingSubscribeReqId) {
        this.pendingSubscribeReqId = null;
      }
      return;
    }

    // subscribe 成功回包通常无 cmd、带 errcode:0。
    if (
      this.pendingSubscribeReqId &&
      reqId === this.pendingSubscribeReqId &&
      (errcode === 0 || errcode === undefined)
    ) {
      this.pendingSubscribeReqId = null;
      this.subscribed = true;
      this.reconnectAttempt = 0;
      this.startPing();
      log.info("企微长连接:subscribe 成功");
      return;
    }

    if (!cmd) {
      // ping / respond 等的 ACK,忽略。
      return;
    }

    if (cmd === "aibot_msg_callback") {
      const body = frame.body ?? {};
      const textObj = body.text as { content?: string } | undefined;
      const from = body.from as { userid?: string } | undefined;
      const msg: WecomMsgCallback = {
        reqId: frame.headers?.req_id || randomUUID(),
        msgid: typeof body.msgid === "string" ? body.msgid : randomUUID(),
        chattype: typeof body.chattype === "string" ? body.chattype : undefined,
        msgtype: typeof body.msgtype === "string" ? body.msgtype : undefined,
        userid: from?.userid,
        text: typeof textObj?.content === "string" ? textObj.content : undefined,
        raw: frame,
      };
      try {
        await this.onMessage?.(msg);
      } catch (err) {
        log.error("处理企微消息回调失败", err, { msgid: msg.msgid });
      }
      return;
    }

    if (cmd === "aibot_event_callback") {
      const event = (frame.body?.event as { eventtype?: string } | undefined)?.eventtype;
      if (event === "disconnected_event") {
        log.warn("企微推送 disconnected_event(连接将被踢掉)");
      }
      // 决策·welcome: MVP 不回欢迎语。
      return;
    }

    if (cmd && cmd !== "pong") {
      log.info("企微其它帧", { cmd, errcode });
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      // 外部契约·heartbeat: 30s ping。
      this.send({ cmd: "ping", headers: { req_id: randomUUID() } });
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(frame: WecomFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn("企微发送失败:连接未就绪", { cmd: frame.cmd });
      return false;
    }
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.error("企微发送异常", err, { cmd: frame.cmd });
      return false;
    }
  }
}
