import { log } from "../logger.js";
import type { WecomWsClient } from "./ws.js";

// 决策·stream-throttle: ≥2s 或内容变化够大才推;finish 必推。
const MIN_INTERVAL_MS = 2_000;
const MIN_CHARS_DELTA = 80;
// 决策·stream-deadline: 约 9 分钟强制 finish(官方窗 10 分钟)。
const DEADLINE_MS = 9 * 60 * 1000;

/**
 * 把 transcript 全文节流推到企微同一条 stream 气泡。
 * WS 断线后 markAbandoned——不再发帧(旧 req_id 无效)。
 */
export class StreamPusher {
  private lastSentContent = "";
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContent = "";
  private finished = false;
  private abandoned = false;
  private startedAt = 0;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private onDeadline: (() => void) | null = null;

  constructor(
    private readonly ws: WecomWsClient,
    private readonly reqId: string,
    private readonly streamId: string,
  ) {}

  get isFinished(): boolean {
    return this.finished || this.abandoned;
  }

  setDeadlineHandler(handler: () => void): void {
    this.onDeadline = handler;
  }

  /** 首次有内容可推时调用,启动 9 分钟截止钟。 */
  ensureStarted(): void {
    if (this.startedAt) return;
    this.startedAt = Date.now();
    this.deadlineTimer = setTimeout(() => {
      if (this.finished || this.abandoned) return;
      log.warn("企微流式接近 10 分钟窗,强制结束", { reqId: this.reqId });
      this.onDeadline?.();
    }, DEADLINE_MS);
  }

  update(content: string): void {
    if (this.finished || this.abandoned) return;
    this.ensureStarted();
    this.latestContent = content;
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    const delta = Math.abs(content.length - this.lastSentContent.length);
    const first = !this.lastSentAt;

    if (first || (elapsed >= MIN_INTERVAL_MS && delta >= MIN_CHARS_DELTA) || elapsed >= MIN_INTERVAL_MS * 2) {
      this.flush(false);
      return;
    }

    if (!this.timer) {
      const wait = Math.max(0, MIN_INTERVAL_MS - elapsed);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush(false);
      }, wait);
    }
  }

  finish(content: string): void {
    if (this.abandoned) return;
    this.latestContent = content;
    this.clearTimer();
    this.clearDeadline();
    this.flush(true);
    this.finished = true;
  }

  markAbandoned(): void {
    this.abandoned = true;
    this.clearTimer();
    this.clearDeadline();
  }

  private flush(finish: boolean): void {
    if (this.abandoned) return;
    const content = this.latestContent || "…";
    if (!finish && content === this.lastSentContent) return;
    const ok = this.ws.respondStream({
      reqId: this.reqId,
      streamId: this.streamId,
      content,
      finish,
    });
    if (ok) {
      this.lastSentContent = content;
      this.lastSentAt = Date.now();
    } else if (finish) {
      log.warn("企微 finish 推送失败", { reqId: this.reqId });
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }
}
