import { log } from "../logger.js";
import type { WecomWsClient } from "./ws.js";

// 外部契约·rate-limit: 每会话 30 条/分钟、1000 条/小时,回复与主动推送合并计算。
const MINUTE_LIMIT = 30;
const HOUR_LIMIT = 1000;
// 决策·digest-budget: 给终稿与指令回复留出的额度,进度气泡不许吃掉。
const MINUTE_RESERVE = 6;
const HOUR_RESERVE = 30;

const RETRY_INTERVAL_MS = 2_000;
const RETRY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * 频控是**按会话**算的,不是按轮次——所以账本必须比 ReplyChannel 活得久,
 * 否则同一分钟内连开两轮会各自从 0 开始数,合起来超限。
 * 决策·single-user-dm 下只有一个会话,进程级单例即够。
 */
class RateLedger {
  private sentAt: number[] = [];

  record(): void {
    this.sentAt.push(Date.now());
  }

  private prune(now: number): void {
    const cutoff = now - 3_600_000;
    if (this.sentAt.length && this.sentAt[0] < cutoff) {
      this.sentAt = this.sentAt.filter((t) => t >= cutoff);
    }
  }

  usage(): { minute: number; hour: number } {
    const now = Date.now();
    this.prune(now);
    const minuteFrom = now - 60_000;
    let minute = 0;
    for (let i = this.sentAt.length - 1; i >= 0; i--) {
      if (this.sentAt[i] < minuteFrom) break;
      minute++;
    }
    return { minute, hour: this.sentAt.length };
  }
}

const ledger = new RateLedger();

/**
 * 一轮对话的企微输出通道(决策·reply-channel)。同一个 req_id 上的两种 msgtype
 * 都从这里出去,好让频控账本只有一处。两级优先级:进度可丢弃、终稿不可丢弃。
 */
export class ReplyChannel {
  private queue: { content: string; queuedAt: number }[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ws: WecomWsClient,
    private readonly reqId: string,
  ) {}

  /**
   * 决策·digest-budget: 小时预算的水位决定进度间隔倍数。
   * 未决·backoff-ladder: 水位与倍数取保守默认,实跑后再调。
   */
  get intervalMultiplier(): number {
    const { hour } = ledger.usage();
    if (hour >= HOUR_LIMIT * 0.85) return 10;
    if (hour >= HOUR_LIMIT * 0.7) return 4;
    return 1;
  }

  /**
   * 进度帧(stream)。预算紧张时直接丢弃、不排队——过程信息过期即无价值。
   * finish 帧不受预算门槛:丢了那条气泡会一直挂着"生成中"直到 10 分钟自动结束。
   */
  sendProgress(opts: { streamId: string; content: string; finish: boolean }): boolean {
    if (!opts.finish) {
      const { minute, hour } = ledger.usage();
      if (minute >= MINUTE_LIMIT - MINUTE_RESERVE || hour >= HOUR_LIMIT - HOUR_RESERVE) {
        log.warn("企微进度帧因预算不足丢弃", { reqId: this.reqId, minute, hour });
        return false;
      }
    }
    const ok = this.ws.respondStream({ reqId: this.reqId, ...opts });
    if (ok) ledger.record();
    return ok;
  }

  /** 终稿/指令回复:发不出去就排队,等 WS 重连后补发。 */
  sendCritical(content: string): void {
    if (this.rawSend(content)) return;
    this.queue.push({ content, queuedAt: Date.now() });
    log.warn("企微关键消息暂存待重发", { reqId: this.reqId, queued: this.queue.length });
    this.ensureRetry();
  }

  dispose(): void {
    if (this.queue.length) return;
    this.clearRetry();
  }

  private rawSend(content: string): boolean {
    const ok = this.ws.respondMarkdown({ reqId: this.reqId, content });
    if (ok) ledger.record();
    return ok;
  }

  private ensureRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => this.drain(), RETRY_INTERVAL_MS);
  }

  private drain(): void {
    const now = Date.now();
    const expired = this.queue.filter((m) => now - m.queuedAt > RETRY_MAX_AGE_MS);
    if (expired.length) {
      this.queue = this.queue.filter((m) => now - m.queuedAt <= RETRY_MAX_AGE_MS);
      log.error("企微关键消息超过重试时限被丢弃", undefined, {
        reqId: this.reqId,
        dropped: expired.length,
      });
    }
    while (this.queue.length) {
      if (!this.ws.ready) return;
      const next = this.queue[0];
      if (!this.rawSend(next.content)) return;
      this.queue.shift();
      log.info("企微关键消息补发成功", { reqId: this.reqId, remaining: this.queue.length });
    }
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
