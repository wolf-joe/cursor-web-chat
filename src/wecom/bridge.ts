import { log, previewText } from "../logger.js";
import { ChatApiClient, ChatApiError } from "./api.js";
import { clearBinding, loadBinding, saveBinding } from "./binding.js";
import { ProgressBubble } from "./progressBubble.js";
import { ReplyChannel } from "./replyChannel.js";
import { chunkMarkdown, DigestBuffer, ReplyAccumulator } from "./transcript.js";
import type { WecomMsgCallback, WecomWsClient } from "./ws.js";

const MSGID_TTL_MS = 10 * 60 * 1000;
// 决策·progress-throttle: 3 秒刷一次同一条气泡。调小无益(动画由客户端定速),
// 且每帧计 1 条频控。实际间隔再乘以频控水位倍数。
const REFRESH_INTERVAL_MS = 3_000;

const HELP_TEXT = `**可用指令**(整句发送,可加 / 前缀)

- \`help\` — 显示本说明
- \`new\` — 解绑当前会话(不删除),下一条消息开新会话
- \`stop\` — 中断进行中的回复

其它文字会发给当前工作区的 AI。回复进行中时普通消息会被拒绝。
会话列表/撤销请在网页端操作。`;

export interface BridgeOptions {
  cwd: string;
  baseUrl: string;
  ws: WecomWsClient;
  api: ChatApiClient;
}

/**
 * 企微消息 → 指令 / HTTP agent / markdown 回推。
 * 决策·commands-mvp / 决策·http-drive / 决策·single-user-dm / 决策·all-markdown。
 */
export class WecomBridge {
  private readonly seenMsgids = new Map<string, number>();
  /** 本桥接视角的「进行中」agent(与主服务 busy 对齐意图;以 409 为准)。 */
  private activeAgentId: string | undefined;
  private activeStreamAbort: (() => void) | undefined;

  constructor(private readonly opts: BridgeOptions) {}

  attach(): void {
    this.opts.ws.setMessageHandler((msg) => this.onMessage(msg));
  }

  private async onMessage(msg: WecomMsgCallback): Promise<void> {
    this.gcMsgids();
    if (this.seenMsgids.has(msg.msgid)) {
      log.info("企微消息排重跳过", { msgid: msg.msgid });
      return;
    }
    this.seenMsgids.set(msg.msgid, Date.now());

    // 决策·single-user-dm: 只处理单聊。
    if (msg.chattype && msg.chattype !== "single") {
      log.info("忽略非单聊", { chattype: msg.chattype, msgid: msg.msgid });
      return;
    }

    // 决策·ignore-non-text
    if (msg.msgtype && msg.msgtype !== "text") {
      this.quickReply(msg.reqId, "暂不支持此类消息,请发送文字。可用指令: `help` / `new` / `stop`");
      return;
    }

    const text = (msg.text ?? "").trim();
    if (!text) {
      this.quickReply(msg.reqId, "收到空消息。");
      return;
    }

    // 决策·commands-mvp: 整句匹配;允许可选前导 / (用户习惯发 /new)。
    const cmd = text.toLowerCase().replace(/^\//, "");
    if (cmd === "help" || cmd === "?") {
      this.quickReply(msg.reqId, HELP_TEXT);
      return;
    }
    if (cmd === "new") {
      this.handleNew(msg.reqId);
      return;
    }
    if (cmd === "stop") {
      await this.handleStop(msg.reqId);
      return;
    }

    if (this.activeAgentId) {
      this.quickReply(msg.reqId, "当前仍有回复在进行中。可发送 `stop` 中断,或等待结束后再发。");
      return;
    }

    await this.handleChat(msg.reqId, text);
  }

  private handleNew(reqId: string): void {
    // 决策·commands-mvp: new 只解绑,不 cancel。
    clearBinding();
    this.quickReply(
      reqId,
      this.activeAgentId
        ? "已解绑当前会话,下一条消息将开新会话。进行中的回复仍在继续,可用 `stop` 中断。"
        : "已解绑当前会话,下一条消息将开新会话。",
    );
  }

  private async handleStop(reqId: string): Promise<void> {
    const agentId = this.activeAgentId ?? loadBinding(this.opts.cwd);
    if (!agentId) {
      this.quickReply(reqId, "当前没有进行中的回复可中断。");
      return;
    }
    try {
      await this.opts.api.cancel(agentId);
      this.quickReply(reqId, "已发送中断请求。");
    } catch (err) {
      const status = err instanceof ChatApiError ? err.status : 0;
      if (status === 409) {
        this.quickReply(reqId, "当前没有进行中的回复可中断。");
        return;
      }
      log.error("stop/cancel 失败", err, { agentId });
      this.quickReply(reqId, `中断失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleChat(reqId: string, text: string): Promise<void> {
    const bound = loadBinding(this.opts.cwd);
    const channel = new ReplyChannel(this.opts.ws, reqId);
    const bubble = new ProgressBubble(channel);
    const digest = new DigestBuffer(Date.now(), this.opts.cwd);
    const reply = new ReplyAccumulator();

    let agentId: string;
    try {
      const result = await this.opts.api.sendChat(this.opts.cwd, text, bound);
      agentId = result.agentId;
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 409) {
        channel.sendCritical("当前会话正忙(可能网页端在跑)。请稍后再试,或发送 `stop`。");
        return;
      }
      log.error("chat 请求失败", err, { cwd: this.opts.cwd, text: previewText(text) });
      channel.sendCritical(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    saveBinding(this.opts.cwd, agentId);
    this.activeAgentId = agentId;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(onTick, REFRESH_INTERVAL_MS * channel.intervalMultiplier);
    };
    const onTick = () => {
      // 决策·stream-rollover: 满页或接近 10 分钟窗就定格旧气泡、翻页、开新气泡。
      if (!bubble.isPristine && (bubble.isAging || digest.pageFull)) {
        bubble.finish(digest.renderPage() ?? undefined);
        digest.advancePage();
        bubble.rollover();
      }
      digest.noteWaiting();
      const body = digest.renderPage();
      if (body) bubble.update(body);
      schedule();
    };
    schedule();

    const stopRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    let finished = false;
    // 决策·final-last: 终稿必须是本轮最后一条——先停刷新、定格进度气泡,再发正文。
    const sendFinal = (footer?: string) => {
      if (finished) return;
      finished = true;
      stopRefresh();
      bubble.finish(digest.renderPage() ?? undefined);
      const chunks = chunkMarkdown(reply.render(footer));
      if (chunks.length > 1) {
        log.info("企微终稿分片", { agentId, chunks: chunks.length });
      }
      // 决策·send-order: 背靠背连发即可保序,不必等前一片 ACK。
      for (const chunk of chunks) channel.sendCritical(chunk);
      channel.dispose();
    };

    const { done, abort } = this.opts.api.subscribeStream(agentId, (event) => {
      if (finished) return;
      const type = event.type;
      if (type === "done") {
        const status = typeof event.status === "string" ? event.status : "unknown";
        if (status === "cancelled") {
          sendFinal("**[已取消]**");
        } else if (status === "error") {
          const errText =
            typeof event.error === "string" && event.error ? event.error : "运行出错";
          sendFinal(`**[错误]** ${errText}`);
        } else {
          sendFinal();
        }
        return;
      }
      if (type === "assistant") reply.applyEvent(event);
      if (type === "thinking" || type === "tool_call") digest.applyEvent(event);
    });

    this.activeStreamAbort = abort;

    try {
      await done;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      log.error("SSE 订阅失败", err, { agentId });
      sendFinal(`**[直播中断]** ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      stopRefresh();
      if (this.activeAgentId === agentId) this.activeAgentId = undefined;
      if (this.activeStreamAbort === abort) this.activeStreamAbort = undefined;
      // SSE 没给 done 就结束时(如主服务重启),仍要把已收到的正文发出去。
      sendFinal();
    }
  }

  private quickReply(reqId: string, content: string): void {
    const channel = new ReplyChannel(this.opts.ws, reqId);
    channel.sendCritical(content);
    channel.dispose();
  }

  private gcMsgids(): void {
    const now = Date.now();
    for (const [id, at] of this.seenMsgids) {
      if (now - at > MSGID_TTL_MS) this.seenMsgids.delete(id);
    }
  }
}
