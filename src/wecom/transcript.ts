// 决策·transcript-one-bubble: 思考/工具/回复同一条企微 stream 全文。
// 决策·transcript-truncate: 超长优先保【回复】。

const ARGS_MAX_CHARS = 500;
// 未决·stream-content-limit: 官方未写死 stream 上限;先按 markdown 20480 留余量。
const CONTENT_MAX_BYTES = 18_000;

type Block =
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: string }
  | { type: "reply"; text: string };

export class TranscriptBuilder {
  private blocks: Block[] = [];
  private seenToolIds = new Set<string>();
  private footer = "";

  reset(): void {
    this.blocks = [];
    this.seenToolIds.clear();
    this.footer = "";
  }

  setFooter(text: string): void {
    this.footer = text;
  }

  applyEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "thinking") {
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return;
      const last = this.blocks[this.blocks.length - 1];
      if (last?.type === "thinking") last.text += text;
      else this.blocks.push({ type: "thinking", text });
      return;
    }

    if (type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string };
        // 工具过程只吃 tool_call 事件,避免与 assistant 内 tool_use 重复。
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          const last = this.blocks[this.blocks.length - 1];
          if (last?.type === "reply") last.text += b.text;
          else this.blocks.push({ type: "reply", text: b.text });
        }
      }
      return;
    }

    if (type === "tool_call") {
      const callId = typeof event.call_id === "string" ? event.call_id : "";
      if (!callId || this.seenToolIds.has(callId)) return;
      // 决策·transcript-one-bubble: 只要首次出现的 name+args,忽略后续 status/result。
      const name = typeof event.name === "string" ? event.name : "tool";
      if (event.args === undefined && event.status === "completed") return;
      this.seenToolIds.add(callId);
      this.blocks.push({
        type: "tool",
        name,
        args: truncateArgs(stringifyArgs(event.args)),
      });
    }
  }

  render(): string {
    const parts: string[] = [];
    for (const block of this.blocks) {
      if (block.type === "thinking") {
        if (!block.text.trim()) continue;
        parts.push(`【思考】\n${block.text.trimEnd()}`);
      } else if (block.type === "tool") {
        parts.push(`【工具】${block.name}\nargs: ${block.args}`);
      } else if (block.type === "reply") {
        if (!block.text.trim()) continue;
        parts.push(`【回复】\n${block.text.trimEnd()}`);
      }
    }
    let body = parts.join("\n\n");
    if (this.footer) {
      body = body ? `${body}\n\n${this.footer}` : this.footer;
    }
    if (!body) body = "…";
    return truncatePreferReply(body, CONTENT_MAX_BYTES);
  }
}

function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function truncateArgs(s: string): string {
  if (s.length <= ARGS_MAX_CHARS) return s;
  return `${s.slice(0, ARGS_MAX_CHARS)}…`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncatePreferReply(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const notice = "\n\n…(内容过长已截断,完整过程请在网页端查看)";
  const budget = maxBytes - byteLength(notice);
  if (budget <= 0) return text.slice(0, 100);

  const replyIdx = text.lastIndexOf("【回复】");
  if (replyIdx >= 0) {
    const replyPart = text.slice(replyIdx);
    if (byteLength(replyPart) <= budget) {
      // 前面塞得下多少思考/工具就留多少。
      const headBudget = budget - byteLength(replyPart);
      let head = text.slice(0, replyIdx);
      while (head && byteLength(head) > headBudget) {
        head = head.slice(Math.floor(head.length / 4));
      }
      return `${head.trimStart()}${head ? "\n\n" : ""}${replyPart}${notice}`;
    }
    // 回复本身过长:只留回复尾部。
    let reply = replyPart;
    while (byteLength(reply) > budget) {
      reply = `【回复】\n…${reply.slice(reply.length - Math.floor(reply.length * 0.75))}`;
    }
    return `${reply}${notice}`;
  }

  let cut = text;
  while (byteLength(cut) > budget) {
    cut = cut.slice(0, Math.floor(cut.length * 0.8));
  }
  return `${cut}${notice}`;
}
