import { randomUUID } from "node:crypto";
import { log, previewText } from "../logger.js";
import { ChatApiClient, ChatApiError } from "./api.js";
import { clearBinding, loadBinding, saveBinding } from "./binding.js";
import { StreamPusher } from "./streamPusher.js";
import { TranscriptBuilder } from "./transcript.js";
import type { WecomMsgCallback, WecomWsClient } from "./ws.js";

const MSGID_TTL_MS = 10 * 60 * 1000;

const HELP_TEXT = `可用指令(整句发送,可加 / 前缀):
• help — 显示本说明
• new — 解绑当前会话(不删除),下一条消息开新会话
• stop — 中断进行中的回复

其它文字会发给当前工作区的 AI。回复进行中时普通消息会被拒绝。
会话列表/撤销请在网页端操作。`;

export interface BridgeOptions {
  cwd: string;
  baseUrl: string;
  ws: WecomWsClient;
  api: ChatApiClient;
}

/**
 * 企微消息 → 指令 / HTTP agent / 流式回推。
 * 决策·commands-mvp / 决策·http-drive / 决策·single-user-dm。
 */
export class WecomBridge {
  private readonly seenMsgids = new Map<string, number>();
  /** 本桥接视角的「进行中」agent(与主服务 busy 对齐意图;以 409 为准)。 */
  private activeAgentId: string | undefined;
  private activeStreamAbort: (() => void) | undefined;
  private activePusher: StreamPusher | undefined;

  constructor(private readonly opts: BridgeOptions) {}

  attach(): void {
    this.opts.ws.setMessageHandler((msg) => this.onMessage(msg));
  }

  /** WS 重连时调用:放弃当前企微气泡推送,不 cancel 主服务 run。 */
  onWsDisconnected(): void {
    this.activePusher?.markAbandoned();
    this.activePusher = undefined;
    // SSE 可继续读完以保持桥接侧 active 状态正确;不 abort。
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
      this.quickStream(msg.reqId, "暂不支持此类消息,请发送文字。可用指令: help / new / stop");
      return;
    }

    const text = (msg.text ?? "").trim();
    if (!text) {
      this.quickStream(msg.reqId, "收到空消息。");
      return;
    }

    // 决策·commands-mvp: 整句匹配;允许可选前导 / (用户习惯发 /new)。
    const cmd = text.toLowerCase().replace(/^\//, "");
    if (cmd === "help" || cmd === "?") {
      this.quickStream(msg.reqId, HELP_TEXT);
      return;
    }
    if (cmd === "new") {
      await this.handleNew(msg.reqId);
      return;
    }
    if (cmd === "stop") {
      await this.handleStop(msg.reqId);
      return;
    }

    if (this.activeAgentId) {
      this.quickStream(msg.reqId, "当前仍有回复在进行中。可发送 stop 中断,或等待结束后再发。");
      return;
    }

    await this.handleChat(msg.reqId, text);
  }

  private async handleNew(reqId: string): Promise<void> {
    // 决策·commands-mvp: new 只解绑,不 cancel。
    clearBinding();
    this.quickStream(
      reqId,
      this.activeAgentId
        ? "已解绑当前会话,下一条消息将开新会话。进行中的回复仍在继续,可用 stop 中断。"
        : "已解绑当前会话,下一条消息将开新会话。",
    );
  }

  private async handleStop(reqId: string): Promise<void> {
    const agentId = this.activeAgentId ?? loadBinding(this.opts.cwd);
    if (!agentId) {
      this.quickStream(reqId, "当前没有进行中的回复可中断。");
      return;
    }
    try {
      await this.opts.api.cancel(agentId);
      this.quickStream(reqId, "已发送中断请求。");
    } catch (err) {
      const status = err instanceof ChatApiError ? err.status : 0;
      if (status === 409) {
        this.quickStream(reqId, "当前没有进行中的回复可中断。");
        return;
      }
      log.error("stop/cancel 失败", err, { agentId });
      this.quickStream(
        reqId,
        `中断失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleChat(reqId: string, text: string): Promise<void> {
    const bound = loadBinding(this.opts.cwd);
    const streamId = randomUUID();
    const pusher = new StreamPusher(this.opts.ws, reqId, streamId);
    const transcript = new TranscriptBuilder();

    pusher.setDeadlineHandler(() => {
      transcript.setFooter("…(耗时接近企微流式上限,已提前结束推送;任务仍可能在网页端继续)");
      pusher.finish(transcript.render());
    });

    // 立刻占位,满足「尽快回包」体验,并占住 stream 窗。
    pusher.update("正在处理…");

    let agentId: string;
    try {
      const result = await this.opts.api.sendChat(this.opts.cwd, text, bound);
      agentId = result.agentId;
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 409) {
        pusher.finish("当前会话正忙(可能网页端在跑)。请稍后再试,或发送 stop。");
        return;
      }
      log.error("chat 请求失败", err, { cwd: this.opts.cwd, text: previewText(text) });
      pusher.finish(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    saveBinding(this.opts.cwd, agentId);
    this.activeAgentId = agentId;
    this.activePusher = pusher;

    const { done, abort } = this.opts.api.subscribeStream(agentId, (event) => {
      if (pusher.isFinished) return;
      const type = event.type;
      if (type === "done") {
        const status = typeof event.status === "string" ? event.status : "unknown";
        if (status === "cancelled") {
          transcript.setFooter("\n[已取消]");
        } else if (status === "error") {
          const errText =
            typeof event.error === "string" && event.error
              ? event.error
              : "运行出错";
          transcript.setFooter(`\n[错误] ${errText}`);
        }
        pusher.finish(transcript.render());
        return;
      }
      if (type === "assistant" || type === "thinking" || type === "tool_call") {
        transcript.applyEvent(event);
        pusher.update(transcript.render());
      }
    });

    this.activeStreamAbort = abort;

    try {
      await done;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      log.error("SSE 订阅失败", err, { agentId });
      if (!pusher.isFinished) {
        transcript.setFooter(`\n[直播中断] ${err instanceof Error ? err.message : String(err)}`);
        pusher.finish(transcript.render());
      }
    } finally {
      if (this.activeAgentId === agentId) this.activeAgentId = undefined;
      if (this.activePusher === pusher) this.activePusher = undefined;
      if (this.activeStreamAbort === abort) this.activeStreamAbort = undefined;
      // 若 SSE 无 done 就结束,仍尽量 finish。
      if (!pusher.isFinished) {
        pusher.finish(transcript.render());
      }
    }
  }

  private quickStream(reqId: string, content: string): void {
    const pusher = new StreamPusher(this.opts.ws, reqId, randomUUID());
    pusher.finish(content);
  }

  private gcMsgids(): void {
    const now = Date.now();
    for (const [id, at] of this.seenMsgids) {
      if (now - at > MSGID_TTL_MS) this.seenMsgids.delete(id);
    }
  }
}
