import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import type { ReplyChannel } from "./replyChannel.js";

// 决策·stream-rollover: 官方窗是自首帧起 10 分钟,留足余量后主动换气泡。
const ROLLOVER_AGE_MS = 8.5 * 60 * 1000;

/**
 * 过程用的那一条 stream 气泡(决策·stream-progress-markdown-final)。
 * 只负责传输与滚动换气泡;内容怎么渲染由 DigestBuffer 决定。
 */
export class ProgressBubble {
  private streamId = randomUUID();
  private firstFrameAt = 0;
  private lastSent = "";

  constructor(private readonly channel: ReplyChannel) {}

  /** 是否从未发出过帧——短轮次据此整条气泡都不发,只留终稿。 */
  get isPristine(): boolean {
    return this.firstFrameAt === 0;
  }

  /** 距首帧是否已接近官方 10 分钟窗。 */
  get isAging(): boolean {
    return this.firstFrameAt > 0 && Date.now() - this.firstFrameAt > ROLLOVER_AGE_MS;
  }

  update(content: string): void {
    if (!content || content === this.lastSent) return;
    const ok = this.channel.sendProgress({ streamId: this.streamId, content, finish: false });
    if (!ok) return;
    if (!this.firstFrameAt) this.firstFrameAt = Date.now();
    this.lastSent = content;
  }

  /** 定格当前气泡。未发过帧时什么都不做(不为了 finish 而新建一条气泡)。 */
  finish(content?: string): void {
    if (this.isPristine) return;
    this.channel.sendProgress({
      streamId: this.streamId,
      content: content || this.lastSent,
      finish: true,
    });
    this.lastSent = content || this.lastSent;
  }

  /** 换一条新气泡:调用方须先 finish 旧的。 */
  rollover(): void {
    log.info("企微进度气泡滚动换新", { ageMs: this.firstFrameAt ? Date.now() - this.firstFrameAt : 0 });
    this.streamId = randomUUID();
    this.firstFrameAt = 0;
    this.lastSent = "";
  }
}
