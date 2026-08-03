import type { LocalAgentStore } from "@cursor/sdk";

// 决策·user-text-from-blobs / 决策·blob-user-text-codec:
// cancelled/error 且 checkpoint 已推进时,conversation() 不带 user 原文。
// 主路径是 history 里对「已推进」轮用 messages.list 按位补;本模块是配不上时的
// 备选:读 latest 相对 start 的 checkpoint blob 差分。
// 编码坐实(案发 Pranks 轮):根 blob 是 merkle(重复 field1 = 32 字节子 blob id);
// 本轮新增叶子里会出现一份 JSON `{"role":"user","content":[{"type":"text","text":"..."}]}`,
// text 常包在 <user_query>…</user_query> 里(外层还有 <timestamp>)。
// 不依赖未导出的 @anysphere/proto 私有路径——只走公开的 store.checkpoints.get。

const USER_QUERY_RE = /<user_query>\r?\n?([\s\S]*?)\r?\n?<\/user_query>/i;

export function checkpointAdvanced(
  startRootBlobId: string | null | undefined,
  latestRootBlobId: string | null | undefined,
): boolean {
  // null ≠ 有值算推进;两边都空或同 id 算未推进。
  if (!latestRootBlobId) return false;
  return startRootBlobId !== latestRootBlobId;
}

export async function extractUserTextFromCheckpointDiff(
  store: LocalAgentStore,
  agentId: string,
  startRootBlobId: string | null | undefined,
  latestRootBlobId: string | null | undefined,
): Promise<string | undefined> {
  if (!latestRootBlobId) return undefined;
  try {
    const startSet = await collectReachableBlobIds(store, agentId, startRootBlobId);
    const latestSet = await collectReachableBlobIds(store, agentId, latestRootBlobId);
    const candidates: string[] = [];
    for (const blobId of latestSet) {
      if (startSet.has(blobId)) continue;
      const data = await store.checkpoints.get({ agentId, blobId });
      if (!data) continue;
      const text = tryExtractUserRoleJson(data) ?? tryExtractProtobufField1Text(data);
      if (text) candidates.push(text);
    }
    // 同一轮里若有多份(少见),取第一份——BFS 先遇到的更接近根上的 user 消息节点。
    return candidates[0];
  } catch {
    // 决策·blob-parse-degrade: 解析失败不拖垮整页历史,由调用方降级占位。
    return undefined;
  }
}

async function collectReachableBlobIds(
  store: LocalAgentStore,
  agentId: string,
  rootBlobId: string | null | undefined,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!rootBlobId) return out;
  const queue: string[] = [rootBlobId];
  while (queue.length) {
    const blobId = queue.pop()!;
    if (out.has(blobId)) continue;
    out.add(blobId);
    const data = await store.checkpoints.get({ agentId, blobId });
    if (!data) continue;
    for (const child of extractChildBlobIds(data)) {
      if (!out.has(child)) queue.push(child);
    }
  }
  return out;
}

/** 扫描 protobuf length-delimited 字段里长度为 32 的字节串,hex 后当作子 blob id。 */
function extractChildBlobIds(data: Uint8Array): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i < data.length) {
    const tagStart = i;
    const tag = readVarint(data, i);
    if (!tag) break;
    i = tag.next;
    const wireType = tag.value & 7;
    if (wireType === 2) {
      const len = readVarint(data, i);
      if (!len) break;
      i = len.next;
      if (len.value === 32 && i + 32 <= data.length) {
        ids.push(bytesToHex(data.subarray(i, i + 32)));
      }
      i += len.value;
    } else if (wireType === 0) {
      const skip = readVarint(data, i);
      if (!skip) break;
      i = skip.next;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      // 未知 wire type:避免死循环,从 tag 下一字节继续粗扫。
      i = tagStart + 1;
    }
  }
  return ids;
}

function tryExtractUserRoleJson(data: Uint8Array): string | undefined {
  const raw = tryDecodeUtf8(data);
  if (!raw || raw[0] !== "{") return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const role = (obj as { role?: unknown }).role;
  if (role !== "user") return undefined;
  const content = (obj as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: unknown }).type !== "text") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  if (!parts.length) return undefined;
  const joined = parts.join("\n");
  const m = USER_QUERY_RE.exec(joined);
  const text = (m ? m[1] : joined).trim();
  return text || undefined;
}

/**
 * 备选:部分叶子是 protobuf field1 = 纯用户原文(案发里有,但不一定挂在 merkle 边上)。
 * 仅当 field1 文本占 blob 大半、且不像工具 JSON / user_query 包装时采纳。
 */
function tryExtractProtobufField1Text(data: Uint8Array): string | undefined {
  if (data.length < 2 || data[0] !== 0x0a) return undefined;
  const len = readVarint(data, 1);
  if (!len || len.value <= 0 || len.next + len.value > data.length) return undefined;
  const textBytes = data.subarray(len.next, len.next + len.value);
  if (textBytes.length < data.length * 0.5) return undefined;
  const text = tryDecodeUtf8(textBytes);
  if (!text) return undefined;
  if (text.includes("<user_query>") || text.includes('"toolCallId"')) return undefined;
  const trimmed = text.trim();
  return trimmed || undefined;
}

function readVarint(
  data: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < data.length && shift <= 28) {
    const b = data[i++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function tryDecodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}
