import type { LocalAgentStore } from "@cursor/sdk";

// 决策·source-checkpoint / 决策·ConversationTokenDetails-shape:
// ConversationStateStructure field 5 = token_details →
//   used_tokens(1) / max_tokens(2)。只扫 root 顶层 field 5，禁止 BFS 整棵 merkle。
// 决策·parse-degrade: 解析失败返回 null，不拖垮 history / done。
// 决策·no-usage-fallback: 禁止用计费 TokenUsage 冒充窗口占用。

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

/** 从 ConversationStateStructure root bytes 解析 used/max；缺 field 5 或不全则 null。 */
export function extractContextUsageFromRoot(root: Uint8Array): ContextUsage | null {
  try {
    let i = 0;
    while (i < root.length) {
      const tagStart = i;
      const tag = readVarint(root, i);
      if (!tag) return null;
      i = tag.next;
      const field = tag.value >>> 3;
      const wire = tag.value & 7;
      if (wire === 2) {
        const len = readVarint(root, i);
        if (!len) return null;
        i = len.next;
        if (i + len.value > root.length) return null;
        if (field === 5) {
          return parseTokenDetails(root.subarray(i, i + len.value));
        }
        i += len.value;
      } else if (wire === 0) {
        const skip = readVarint(root, i);
        if (!skip) return null;
        i = skip.next;
      } else if (wire === 5) {
        i += 4;
      } else if (wire === 1) {
        i += 8;
      } else {
        i = tagStart + 1;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 决策·store-reuse / 决策·per-run-checkpoint:
 * 经现有 LocalAgentStore 读该 run 的 end checkpoint root；无 blobId / get 失败 / 解析失败 → null。
 */
export async function readContextUsageFromCheckpoint(
  store: LocalAgentStore,
  agentId: string,
  rootBlobId: string | null | undefined,
): Promise<ContextUsage | null> {
  if (!rootBlobId) return null;
  try {
    const data = await store.checkpoints.get({ agentId, blobId: rootBlobId });
    if (!data) return null;
    return extractContextUsageFromRoot(data);
  } catch {
    return null;
  }
}

function parseTokenDetails(data: Uint8Array): ContextUsage | null {
  let used: number | undefined;
  let max: number | undefined;
  let i = 0;
  while (i < data.length) {
    const tagStart = i;
    const tag = readVarint(data, i);
    if (!tag) break;
    i = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const v = readVarint(data, i);
      if (!v) break;
      i = v.next;
      if (field === 1) used = v.value;
      else if (field === 2) max = v.value;
    } else if (wire === 2) {
      const len = readVarint(data, i);
      if (!len) break;
      i = len.next + len.value;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      i = tagStart + 1;
    }
  }
  if (used == null || max == null) return null;
  return { usedTokens: used, maxTokens: max };
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
