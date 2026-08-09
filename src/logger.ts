/** 轻量结构化日志:统一时间戳前缀,错误带 stack,便于 Supervisor 日志排查。 */

function timestamp(): string {
  return new Date().toISOString();
}

function formatContext(ctx?: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) return "";
  return ` ${JSON.stringify(ctx)}`;
}

export function previewText(text: string, maxLen = 2000): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

export const log = {
  info(message: string, ctx?: Record<string, unknown>): void {
    console.log(`[${timestamp()}] ${message}${formatContext(ctx)}`);
  },

  warn(message: string, ctx?: Record<string, unknown>): void {
    console.warn(`[${timestamp()}] ${message}${formatContext(ctx)}`);
  },

  error(message: string, err?: unknown, ctx?: Record<string, unknown>): void {
    const parts: Record<string, unknown> = { ...ctx };
    if (err instanceof Error) {
      parts.error = err.message;
      if (err.name !== "Error") parts.errorName = err.name;
      if (err.stack) parts.stack = err.stack;
      // CursorSdkError 等常带 code/requestId/cause;只取一层 cause 文案,避免整棵树刷爆日志。
      const extra = err as Error & {
        code?: unknown;
        requestId?: unknown;
        cause?: unknown;
      };
      if (extra.code != null && parts.errorCode == null) parts.errorCode = extra.code;
      if (typeof extra.requestId === "string" && parts.requestId == null) {
        parts.requestId = extra.requestId;
      }
      if (extra.cause !== undefined && parts.cause == null) {
        parts.cause =
          extra.cause instanceof Error
            ? extra.cause.message
            : String(extra.cause);
      }
    } else if (err !== undefined) {
      parts.error = String(err);
    }
    console.error(`[${timestamp()}] ${message}${formatContext(parts)}`);
  },
};
