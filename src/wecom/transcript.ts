// 企微侧两个渲染器:窗口摘要(过程,可丢可截)与终稿(正文,只许分片不许截)。
// 决策·all-markdown / 决策·digest-window-cap / 决策·final-chunk / 决策·no-strikethrough。

// 外部契约·markdown-limit: 20480 字节是服务端硬上限,超限整条拒收(errcode 40058),
// 不是截断——所以分片一律按字节算,按字符算会被中文的 3 字节/字骗过去。
const MARKDOWN_MAX_BYTES = 20_480;
/** 分多片时首行 `(i/n)` 与空行的预留。 */
const CHUNK_HEADER_BYTES = 24;

// 决策·stream-rollover: 单条进度气泡的体积上限;到顶就翻页换气泡。
const DIGEST_MAX_BYTES = 3_000;
const DIGEST_MAX_LINES = 40;
const TOOL_TARGET_MAX_CHARS = 80;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** 按字节裁剪,不切断多字节字符。 */
function sliceByBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = byteLength(ch);
    if (used + w > maxBytes) break;
    out += ch;
    used += w;
  }
  return out;
}

function oneLine(s: string, max = TOOL_TARGET_MAX_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 工具行只保留「工具名 + 关键目标」(决策·tool-format-compact)。
 * 字段名与网页端 `public/toolFormat.js` 取的是同一套 SDK 参数。
 */
function toolTarget(name: string, args: unknown, cwd?: string): string {
  const short = (p: string) => {
    if (!cwd) return oneLine(p);
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return oneLine(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  };
  if (typeof args === "string") return oneLine(args);
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const n = name.toLowerCase();
  if (n === "shell" && typeof a.command === "string") return oneLine(a.command);
  if (typeof a.pattern === "string") {
    const target = typeof a.path === "string" ? short(a.path) : "";
    return target ? `${oneLine(a.pattern, 40)} · ${target}` : oneLine(a.pattern);
  }
  if (typeof a.globPattern === "string") return oneLine(a.globPattern);
  if (typeof a.path === "string") return short(a.path);
  if (typeof a.url === "string") return oneLine(a.url);
  if (typeof a.search_term === "string") return oneLine(a.search_term);
  if (typeof a.description === "string") return oneLine(a.description);
  if (typeof a.plan === "string") {
    const firstLine = a.plan.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
    return oneLine(firstLine ?? "计划");
  }
  try {
    return oneLine(JSON.stringify(a));
  } catch {
    return "";
  }
}

function formatElapsed(msec: number): string {
  const total = Math.max(0, Math.round(msec / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * 本轮过程的活动行,按发生顺序累积,永不回删(决策·progress-append-only:
 * 企微对「内容被整体改写」时的动画行为没人验证过,追加是唯一已知安全的形态)。
 *
 * 每行自带发生时刻,因为耗时不能放在一个会被反复重写的表头里——那就不是追加了。
 *
 * 气泡满页时由调用方 advancePage() 翻页,已翻过去的行不再出现在后续渲染里,
 * 于是「一条气泡」的体积有界,而步骤本身不丢(决策·stream-rollover)。
 */
export class DigestBuffer {
  private lines: string[] = [];
  private pageStart = 0;
  private lastWasThinking = false;
  private readonly seenToolIds = new Set<string>();

  constructor(
    private readonly startedAt: number,
    private readonly cwd?: string,
  ) {}

  private push(text: string): void {
    this.lines.push(`- ${formatElapsed(Date.now() - this.startedAt)} ${text}`);
  }

  /** 首窗还什么都没发生时的占位行;它也是一行,后续活动追加在它后面。 */
  noteWaiting(): void {
    if (this.lines.length) return;
    this.push("收到,处理中…");
  }

  applyEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "thinking") {
      // thinking 是逐 token 增量,连续的一串只算一行(决策·thinking-one-line)。
      if (this.lastWasThinking) return;
      if (typeof event.text !== "string" || !event.text.trim()) return;
      this.lastWasThinking = true;
      this.push("思考中…");
      return;
    }
    if (type !== "tool_call") return;
    this.lastWasThinking = false;

    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (!callId || this.seenToolIds.has(callId)) return;
    if (event.args === undefined && event.status === "completed") return;
    this.seenToolIds.add(callId);

    const name = typeof event.name === "string" ? event.name : "tool";
    const target = toolTarget(name, event.args, this.cwd);
    this.push(target ? `\`${name}\` ${target}` : `\`${name}\``);
  }

  /** 当前页是否已超行数上限,该翻页了。 */
  get pageFull(): boolean {
    return this.lines.length - this.pageStart > DIGEST_MAX_LINES;
  }

  /** 渲染当前页;返回 null 表示这一页还没有内容。 */
  renderPage(): string | null {
    const page = this.lines.slice(this.pageStart, this.pageStart + DIGEST_MAX_LINES);
    if (!page.length) return null;
    const head = this.pageStart > 0 ? "**进度(续)**" : "**进度**";
    let body = `${head}\n\n${page.join("\n")}`;
    if (byteLength(body) > DIGEST_MAX_BYTES) {
      body = `${sliceByBytes(body, DIGEST_MAX_BYTES - 16)}\n…`;
    }
    return body;
  }

  advancePage(): void {
    this.pageStart = Math.min(this.lines.length, this.pageStart + DIGEST_MAX_LINES);
  }
}

/** 累积本轮 assistant 正文;工具与思考一律不进终稿。 */
export class ReplyAccumulator {
  private segments: string[] = [];
  private lastWasText = false;

  /** 调用方须把非 assistant 事件也传进来,用来打断连续文本(见 bridge 决策·reply-interrupt)。 */
  applyEvent(event: Record<string, unknown>): void {
    if (event.type !== "assistant") {
      this.lastWasText = false;
      return;
    }
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string };
      if (b.type !== "text" || typeof b.text !== "string" || !b.text) continue;
      // assistant 文本是增量,同一段回复会拆成多个事件,连续的必须并回一段。
      if (this.lastWasText && this.segments.length) {
        this.segments[this.segments.length - 1] += b.text;
      } else {
        this.segments.push(b.text);
      }
      this.lastWasText = true;
    }
  }

  get isEmpty(): boolean {
    return !this.segments.some((s) => s.trim());
  }

  render(footer?: string): string {
    const body = this.segments
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!body) return footer ? footer : "(本轮没有文本回复)";
    return footer ? `${body}\n\n${footer}` : body;
  }
}

function fenceOpen(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) open = !open;
  }
  return open;
}

/** 把文本拆成不超过 limit 字节的块,优先在空行、其次换行、最后按字符切。 */
function packByBytes(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;

  while (byteLength(rest) > limit) {
    const head = sliceByBytes(rest, limit);
    // 段落边界若落得太早(代码块内部往往整片没有空行),宁可退到换行边界:
    // 否则会切出一片只有几个字的气泡,白占一条频控额度。
    let cut = head.lastIndexOf("\n\n");
    if (cut < head.length * 0.5) {
      const nl = head.lastIndexOf("\n");
      if (nl > cut) cut = nl;
    }
    if (cut <= 0) cut = head.length;
    const piece = rest.slice(0, cut).replace(/\s+$/, "");
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/**
 * 终稿分片(决策·final-chunk)。围栏跨片时前片补 ``` 闭合、后片重开,
 * 否则前片剩余内容会整段被当代码、后片完全不成形。
 */
export function chunkMarkdown(text: string, maxBytes = MARKDOWN_MAX_BYTES): string[] {
  if (byteLength(text) <= maxBytes) return [text];

  const raw = packByBytes(text, maxBytes - CHUNK_HEADER_BYTES);
  const fixed: string[] = [];
  let carryFence = false;
  for (const piece of raw) {
    let body = carryFence ? `\`\`\`\n${piece}` : piece;
    carryFence = fenceOpen(body);
    if (carryFence) body += "\n```";
    fixed.push(body);
  }

  const n = fixed.length;
  return fixed.map((body, i) => `(${i + 1}/${n})\n\n${body}`);
}
