// 决策·scheme-a-stream-sentences / 决策·stream-sse-pcm / 决策·cache-by-runId:
// 按需 TTS——流式口语化按换行分句，句到齐即串行送合成 pcm16，按 runId 落盘为 wav。
// 与 titleService 同模式:不走 @cursor/sdk Agent,失败不影响主对话。
// 决策·tts-opt-in: 配置段默认关闭;口语化走 llm 段,合成走 tts 段。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAgentRuns } from "./agentService.js";
import { isTtsEnabled, loadTtsConfig } from "./config.js";
import {
  getLlmConfig,
  isLlmConfigured,
  llmProxyHeaders,
  LLM_APP_NAME,
  LLM_SHORT_TASK_NO_THINKING,
} from "./llmProxy.js";
import { log, previewText } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_DIR = path.join(__dirname, "..", "data", "tts");

// 决策·text-truncate: 抽文后截断再口语化,控制成本与合成时长。
const TEXT_MAX_CHARS = 6000;
const SAMPLE_RATE = 24000;
// 决策·sentence-silence: 非空句之间插入 250ms 零 pcm；首句前、末句后不插。
const SENTENCE_SILENCE_MS = 250;
// 决策·long-line-warn: 单行 trim 后超过此长度打 Warning，不截断、不二次切分。
const LONG_LINE_WARN_CHARS = 200;

// 决策·rewrite-prompt-lines: 一行一句、换行分隔；直接出口语文稿。
const REWRITE_SYSTEM_PROMPT =
  "你是口语化改写助手。把用户给出的 AI 助手回复改写成适合朗读的口语文稿。" +
  "要求：去掉 Markdown 标记、代码块、链接 URL、表格线等排版符号；" +
  "代码或命令用简短口头说明代替（如「一段某某代码」「执行某某命令」），不要逐字符读出；" +
  "保留关键结论与要点，语气自然顺畅；" +
  "必须一行一句、用换行分隔，不要把多句挤在同一行；" +
  "直接输出口语文稿正文，不要前言后语，不要编号或列表符号。";

const TTS_STYLE_PROMPT = "用自然、清晰的中文女声朗读，语速适中。";

// 决策·roman-letter-split: 部分 TTS 引擎会把仅含 I/V/X/L/C/D/M 的独立 token 读成罗马数字
// （如 ID→四百九十九）。送合成前在字母间插空格；排除表跳过本意为英文词的串。
const ROMAN_LETTER_TOKEN_RE = /\b[IVXLCDMivxlcdm]{2,}\b/g;

export { isTtsEnabled };

function ttsAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-App-Name": LLM_APP_NAME,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}
const ROMAN_LETTER_WORD_ALLOWLIST = new Set([
  "mix",
  "mild",
  "civil",
  "civic",
  "lid",
  "did",
  "dim",
  "mid",
  "mic",
  "vim",
  "mil",
  "lim",
  "ill",
  "dill",
  "mill",
]);

/** 将罗马数字字母串拆成「字母 + 空格」，避免 TTS 按罗马数字读数。 */
export function splitRomanLetterTokens(text: string): string {
  return text.replace(ROMAN_LETTER_TOKEN_RE, (token) => {
    if (ROMAN_LETTER_WORD_ALLOWLIST.has(token.toLowerCase())) return token;
    return token.split("").join(" ");
  });
}

export type TtsSseEvent =
  | { type: "status"; phase: "rewriting" }
  | { type: "status"; phase: "synthesizing"; sampleRate: number }
  | { type: "audio"; data: string }
  | { type: "done"; cached: boolean; runId: string }
  | { type: "error"; message: string };

export class TtsRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} 不存在或无可朗读的 assistant 正文`);
    this.name = "TtsRunNotFoundError";
  }
}

type InflightEntry = {
  listeners: Set<(event: TtsSseEvent) => void>;
  promise: Promise<void>;
};

// 决策·single-flight: 同 runId 同时只跑一条生成流水线,多路订阅共享事件。
const inflight = new Map<string, InflightEntry>();

/** 句间静音 pcm（懒生成一次）。 */
let silencePcmCache: Buffer | null = null;

function silencePcm(): Buffer {
  if (!silencePcmCache) {
    const samples = Math.round((SAMPLE_RATE * SENTENCE_SILENCE_MS) / 1000);
    silencePcmCache = Buffer.alloc(samples * 2); // pcm16le mono
  }
  return silencePcmCache;
}

export function ttsCachePath(runId: string): string {
  return path.join(TTS_DIR, `${runId}.wav`);
}

export function hasTtsCache(runId: string): boolean {
  try {
    return fs.statSync(ttsCachePath(runId)).isFile();
  } catch {
    return false;
  }
}

export async function ensureTtsDir(): Promise<void> {
  await fsp.mkdir(TTS_DIR, { recursive: true });
}

export async function deleteTtsCache(runId: string): Promise<void> {
  const file = ttsCachePath(runId);
  const tmp = `${file}.tmp`;
  await fsp.unlink(file).catch(() => undefined);
  await fsp.unlink(tmp).catch(() => undefined);
}

export async function deleteTtsCaches(runIds: string[]): Promise<void> {
  await Promise.all(runIds.map((id) => deleteTtsCache(id)));
}

/** 抽该 run 最后一条 assistantMessage 正文（不含 thinking/工具）。 */
export async function extractLastAssistantText(
  cwd: string,
  agentId: string,
  runId: string,
): Promise<string> {
  const runs = await listAgentRuns(agentId, cwd);
  const run = runs.find((r) => r.id === runId);
  if (!run || run.status !== "finished" || !run.supports("conversation")) {
    throw new TtsRunNotFoundError(runId);
  }
  const turns = await run.conversation();
  let lastText = "";
  for (const turn of turns) {
    if (turn.type !== "agentConversationTurn") continue;
    for (const step of turn.turn.steps ?? []) {
      if (step.type === "assistantMessage" && step.message?.text) {
        lastText = step.message.text;
      }
    }
  }
  if (!lastText.trim()) throw new TtsRunNotFoundError(runId);
  return lastText;
}

function truncateText(text: string): string {
  if (text.length <= TEXT_MAX_CHARS) return text;
  return text.slice(0, TEXT_MAX_CHARS);
}

/** pcm16le mono → wav Buffer */
export function pcm16ToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function* iterSseJsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

/**
 * 决策·external-rewrite-stream / 决策·newline-only-split / 决策·skip-blank-lines:
 * 流式口语化，只按 `\n` 切非空行入队；忽略 reasoning_content，只吃 delta.content。
 * 关思考见 llmProxy 决策·short-task-no-thinking。
 */
async function* streamRewriteSentences(
  text: string,
  runId: string,
): AsyncGenerator<string> {
  if (!isLlmConfigured()) {
    throw new Error("TTS 口语化需要 config.json 的 llm 段(baseUrl)");
  }
  const cfg = getLlmConfig()!;
  const model = cfg.model;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: llmProxyHeaders(),
    body: JSON.stringify({
      model,
      stream: true,
      ...LLM_SHORT_TASK_NO_THINKING,
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        { role: "user", content: truncateText(text) },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`口语化失败: llm 网关 HTTP ${res.status}`);
  }

  let lineBuf = "";
  let yielded = 0;
  // 决策·external-rewrite-stream: 用 res.body.getReader() 逐块消费 SSE，
  // 不是等整包再 parse——首行一到齐就 yield，下游可立刻开 TTS。
  // 决策·log-density: 过程里程碑(首 content / 首句)不打 info;长行仍 warn。
  for await (const raw of iterSseJsonLines(res.body)) {
    const chunk = raw as {
      choices?: { delta?: { content?: string | null } }[];
    };
    const piece = chunk.choices?.[0]?.delta?.content;
    if (typeof piece !== "string" || !piece) continue;
    lineBuf += piece;
    // 决策·newline-only-split: 只按换行切，不做标点二次切分。
    while (true) {
      const nl = lineBuf.indexOf("\n");
      if (nl < 0) break;
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      // 决策·skip-blank-lines: 空行不调 TTS。
      if (!line) continue;
      if (line.length > LONG_LINE_WARN_CHARS) {
        log.warn("TTS 口语化单行过长", {
          runId,
          lineLen: line.length,
          linePreview: previewText(line),
        });
      }
      yielded += 1;
      yield line;
    }
  }
  const tail = lineBuf.trim();
  if (tail) {
    if (tail.length > LONG_LINE_WARN_CHARS) {
      log.warn("TTS 口语化单行过长", {
        runId,
        lineLen: tail.length,
        linePreview: previewText(tail),
      });
    }
    yielded += 1;
    yield tail;
  }
  if (!yielded) throw new Error("口语化返回空内容");
}

async function synthesizeStreaming(
  spokenText: string,
  onPcm: (chunk: Buffer) => void,
): Promise<Buffer> {
  const tts = loadTtsConfig();
  if (!tts) throw new Error("TTS 未启用或未配置 baseUrl");
  // 决策·roman-letter-split: 必须在写入 assistant content 之前处理。
  const textForTts = splitRomanLetterTokens(spokenText);
  const res = await fetch(`${tts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: ttsAuthHeaders(tts.apiKey),
    body: JSON.stringify({
      model: tts.model,
      messages: [
        { role: "user", content: TTS_STYLE_PROMPT },
        { role: "assistant", content: textForTts },
      ],
      // 非标准 audio 字段——换网关大概率需自行适配(见 README)。
      audio: { format: "pcm16", voice: tts.voice },
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `TTS 失败: llm-proxy HTTP ${res.status}${errText ? ` · ${errText.slice(0, 200)}` : ""}`,
    );
  }

  const chunks: Buffer[] = [];
  for await (const raw of iterSseJsonLines(res.body)) {
    const chunk = raw as {
      choices?: { delta?: { audio?: { data?: string } } }[];
    };
    const b64 = chunk.choices?.[0]?.delta?.audio?.data;
    if (!b64) continue;
    const pcm = Buffer.from(b64, "base64");
    if (!pcm.length) continue;
    chunks.push(pcm);
    onPcm(pcm);
  }
  if (!chunks.length) throw new Error("TTS 未返回任何音频数据");
  return Buffer.concat(chunks);
}

/**
 * 生产者-消费者队列：改写与当前句 TTS 可重叠（决策·scheme-a-stream-sentences）。
 * TTS worker 严格串行；任一句失败整 run 失败（决策·fail-fast-run）。
 */
class SentenceQueue {
  private items: string[] = [];
  private closed = false;
  private error: Error | null = null;
  private waiters: Array<() => void> = [];

  push(sentence: string): void {
    this.items.push(sentence);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  fail(err: Error): void {
    this.error = err;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
  }

  async shift(): Promise<string | null> {
    while (this.items.length === 0 && !this.closed) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    if (this.error) throw this.error;
    if (this.items.length === 0) return null;
    return this.items.shift()!;
  }
}

async function runPipeline(
  cwd: string,
  agentId: string,
  runId: string,
  emit: (event: TtsSseEvent) => void,
): Promise<void> {
  await ensureTtsDir();
  const outPath = ttsCachePath(runId);
  const tmpPath = `${outPath}.tmp`;

  if (hasTtsCache(runId)) {
    emit({ type: "done", cached: true, runId });
    return;
  }

  emit({ type: "status", phase: "rewriting" });
  const sourceText = await extractLastAssistantText(cwd, agentId, runId);
  // 决策·side-task-success-one / 决策·log-density: 开始与每句合成不打;
  // 成功落盘后一条汇总(含 durationMs / sentenceCount / bytes)。
  const t0 = Date.now();

  const queue = new SentenceQueue();
  const producer = (async () => {
    try {
      for await (const sentence of streamRewriteSentences(sourceText, runId)) {
        queue.push(sentence);
      }
      queue.close();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  const pcmParts: Buffer[] = [];
  let sentenceCount = 0;
  let synthesizingEmitted = false;

  try {
    await fsp.unlink(tmpPath).catch(() => undefined);

    while (true) {
      const sentence = await queue.shift();
      if (sentence === null) break;

      if (!synthesizingEmitted) {
        emit({ type: "status", phase: "synthesizing", sampleRate: SAMPLE_RATE });
        synthesizingEmitted = true;
      }

      // 决策·sentence-silence: 非空句之间插静音；首句前不插。
      if (sentenceCount > 0) {
        const sil = silencePcm();
        pcmParts.push(sil);
        emit({ type: "audio", data: sil.toString("base64") });
      }

      const pcm = await synthesizeStreaming(sentence, (chunk) => {
        emit({ type: "audio", data: chunk.toString("base64") });
      });
      pcmParts.push(pcm);
      sentenceCount += 1;
    }

    // 等 producer 收尾，把改写侧错误浮上来（若 consumer 已因 fail 抛出则不会到这）。
    await producer;

    if (!sentenceCount) throw new Error("口语化返回空内容");

    // 决策·atomic-cache-write: 先写完整 wav 到 tmp,成功后再 rename。
    const wav = pcm16ToWav(Buffer.concat(pcmParts));
    await fsp.writeFile(tmpPath, wav);
    await fsp.rename(tmpPath, outPath);
    log.info("TTS 已生成", {
      runId,
      sentenceCount,
      bytes: wav.length,
      durationMs: Date.now() - t0,
      textLen: sourceText.length,
    });
    emit({ type: "done", cached: true, runId });
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    // 确保 producer 不会成为未处理 rejection。
    await producer.catch(() => undefined);
    throw err;
  }
}

/**
 * 订阅或启动同 runId 的生成流水线。客户端断开只移除监听,不取消生成
 * （便于单飞共享与落盘完成）。
 */
export function streamTts(
  cwd: string,
  agentId: string,
  runId: string,
  onEvent: (event: TtsSseEvent) => void,
): { promise: Promise<void>; unsubscribe: () => void } {
  if (hasTtsCache(runId)) {
    onEvent({ type: "done", cached: true, runId });
    return { promise: Promise.resolve(), unsubscribe: () => undefined };
  }

  let entry = inflight.get(runId);
  if (!entry) {
    const listeners = new Set<(event: TtsSseEvent) => void>();
    const emit = (event: TtsSseEvent) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 单个订阅者异常不影响其余
        }
      }
    };
    const promise = runPipeline(cwd, agentId, runId, emit)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("TTS 生成失败", err, { cwd, agentId, runId });
        emit({ type: "error", message });
      })
      .finally(() => {
        inflight.delete(runId);
      });
    entry = { listeners, promise };
    inflight.set(runId, entry);
  }

  entry.listeners.add(onEvent);
  const unsubscribe = () => {
    entry?.listeners.delete(onEvent);
  };
  return { promise: entry.promise, unsubscribe };
}
