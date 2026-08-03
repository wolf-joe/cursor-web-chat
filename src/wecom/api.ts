import { AUTH_COOKIE_NAME, getAuthToken } from "../auth.js";
import { log } from "../logger.js";

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

export class ChatApiClient {
  constructor(private readonly baseUrl: string) {}

  /** 决策·wecom-auth-cookie: 与主服务读同一 AUTH_TOKEN;未配置则不带 Cookie。 */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const token = getAuthToken();
    if (token) {
      headers.Cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`;
    }
    return headers;
  }

  async sendChat(cwd: string, text: string, agentId?: string): Promise<{ agentId: string }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      // 决策·model-default: 不传 model,由主服务落 models.default。
      body: JSON.stringify({ cwd, text, ...(agentId ? { agentId } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as { agentId?: string; error?: string };
    if (!res.ok) {
      throw new ChatApiError(data.error || `chat 失败 HTTP ${res.status}`, res.status, data);
    }
    if (!data.agentId) {
      throw new ChatApiError("chat 响应缺少 agentId", res.status, data);
    }
    return { agentId: data.agentId };
  }

  async cancel(agentId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/agent/cancel`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ agentId }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new ChatApiError(data.error || `cancel 失败 HTTP ${res.status}`, res.status, data);
    }
  }

  /**
   * 订阅 SSE。返回取消函数。回调里抛错不影响读取循环。
   * 决策·http-drive: 与网页共用 runHub 扇出。
   */
  subscribeStream(
    agentId: string,
    onEvent: (event: Record<string, unknown>) => void,
  ): { done: Promise<void>; abort: () => void } {
    const ac = new AbortController();
    const url = `${this.baseUrl}/api/agent/stream?agentId=${encodeURIComponent(agentId)}`;

    const done = (async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        throw err;
      }
      if (!res.ok || !res.body) {
        throw new ChatApiError(`stream 失败 HTTP ${res.status}`, res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done: eof, value } = await reader.read();
          if (eof) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE 事件以空行分隔。
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of raw.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                onEvent(JSON.parse(payload) as Record<string, unknown>);
              } catch (err) {
                log.warn("SSE 事件 JSON 解析失败", {
                  error: err instanceof Error ? err.message : String(err),
                  payloadPreview: payload.slice(0, 120),
                });
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();

    return {
      done,
      abort: () => ac.abort(),
    };
  }
}
