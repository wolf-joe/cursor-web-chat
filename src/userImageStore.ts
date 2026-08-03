// 决策·side-store-by-runId: SDK conversation() 的 UserMessage 只有 text、回不了图;
// UI 缩略图只经 GET /api/user-images/:runId,键与 TTS 同为 runId。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_IMAGES_DIR = path.join(__dirname, "..", "data", "user-images");

// 决策·allowed-mime / 决策·max-one-image-5mb
export const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type ChatImageInput = {
  mimeType: string;
  data: string; // raw base64, 无 data: 前缀
};

export function isSafeRunId(runId: string): boolean {
  return Boolean(runId) && !runId.includes("..") && !runId.includes("/") && !runId.includes("\\");
}

export function userImageUrl(runId: string): string {
  return `/api/user-images/${encodeURIComponent(runId)}`;
}

export async function ensureUserImagesDir(): Promise<void> {
  await fsp.mkdir(USER_IMAGES_DIR, { recursive: true });
}

function pathFor(runId: string, ext: string): string {
  return path.join(USER_IMAGES_DIR, `${runId}.${ext}`);
}

/** 按 runId 找旁路文件(扩展名由 mime 映射);不存在返回 null。 */
export function findUserImage(runId: string): { filePath: string; mimeType: string } | null {
  if (!isSafeRunId(runId)) return null;
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    const filePath = pathFor(runId, ext);
    try {
      if (fs.statSync(filePath).isFile()) return { filePath, mimeType: mime };
    } catch {
      // continue
    }
  }
  return null;
}

export function hasUserImage(runId: string): boolean {
  return findUserImage(runId) !== null;
}

/**
 * 校验 chat body 里的单张图。通过返回解码后的 Buffer;失败抛 Error(文案可直接给 400)。
 */
export function validateChatImage(image: unknown): { mimeType: string; buffer: Buffer; data: string } {
  if (image == null || typeof image !== "object") {
    throw new Error("图片格式无效");
  }
  const { mimeType, data } = image as { mimeType?: unknown; data?: unknown };
  if (typeof mimeType !== "string" || !ALLOWED_IMAGE_MIMES.has(mimeType)) {
    throw new Error("不支持的图片类型(仅 png/jpeg/webp/gif)");
  }
  if (typeof data !== "string" || !data) {
    throw new Error("缺少图片数据");
  }
  // 允许带 data URL 前缀,落盘/送 SDK 时用裸 base64。
  const raw = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    throw new Error("图片 base64 无效");
  }
  if (buffer.length === 0) throw new Error("图片数据为空");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大(上限 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB)`);
  }
  return { mimeType, buffer, data: raw };
}

/**
 * 决策·persist-best-effort: 写盘失败只打日志、返回 null(不回滚 run);成功返回 imageUrl。
 */
export async function writeUserImage(runId: string, mimeType: string, buffer: Buffer): Promise<string | null> {
  if (!isSafeRunId(runId)) {
    log.warn("旁路图片写盘跳过:无效 runId", { runId });
    return null;
  }
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    log.warn("旁路图片写盘跳过:未知 mime", { runId, mimeType });
    return null;
  }
  const file = pathFor(runId, ext);
  const tmp = `${file}.tmp`;
  try {
    await ensureUserImagesDir();
    // 同 runId 换扩展名时先清旧文件,避免 find 命中旧 mime。
    await deleteUserImage(runId);
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, file);
    return userImageUrl(runId);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    log.error("旁路图片写盘失败(不影响本轮对话)", err, { runId, mimeType, bytes: buffer.length });
    return null;
  }
}

export async function deleteUserImage(runId: string): Promise<void> {
  if (!isSafeRunId(runId)) return;
  for (const ext of Object.keys(EXT_TO_MIME)) {
    const file = pathFor(runId, ext);
    const tmp = `${file}.tmp`;
    await fsp.unlink(file).catch(() => undefined);
    await fsp.unlink(tmp).catch(() => undefined);
  }
}

export async function deleteUserImages(runIds: string[]): Promise<void> {
  await Promise.all(runIds.map((id) => deleteUserImage(id)));
}
