// 决策·side-store-by-runId: SDK conversation() 的 UserMessage 只有 text、回不了图;
// UI 缩略图只经 GET /api/user-images/:runId,键与 TTS 同为 runId。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_IMAGES_DIR = path.join(__dirname, "..", "data", "user-images");

// 决策·allowed-mime / 决策·max-one-image-10mb
export const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 决策·compress-before-send: 入站仍允许 10MB;send / 旁路落盘前压到 1MB,避免大图卡死 vision。
export const TARGET_SEND_IMAGE_BYTES = 1024 * 1024;

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

export type PreparedChatImage = {
  mimeType: string;
  buffer: Buffer;
  data: string;
};

/**
 * 校验后若已 ≤1MB 原样返回;否则转 JPEG 并缩小,直到 ≤ TARGET_SEND_IMAGE_BYTES。
 * 动图只取第一帧。失败抛 Error(文案可直接给 400)。
 */
export async function prepareChatImage(image: unknown): Promise<PreparedChatImage> {
  return compressForSend(validateChatImage(image));
}

async function compressForSend(img: PreparedChatImage): Promise<PreparedChatImage> {
  if (img.buffer.length <= TARGET_SEND_IMAGE_BYTES) return img;

  const decodeOpts = { animated: false, failOn: "none" as const, limitInputPixels: 40_000_000 };

  async function encode(maxEdge: number, quality: number): Promise<Buffer> {
    return sharp(img.buffer, decodeOpts)
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(img.buffer, decodeOpts).rotate().metadata();
  } catch (err) {
    throw new Error(`图片无法解码(${err instanceof Error ? err.message : String(err)})`);
  }
  const srcEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (srcEdge === 0) throw new Error("图片无法解码");

  let maxEdge = Math.min(srcEdge, 1920);
  let quality = 80;
  let out: Buffer;
  try {
    out = await encode(maxEdge, quality);
  } catch (err) {
    throw new Error(`图片压缩失败(${err instanceof Error ? err.message : String(err)})`);
  }

  while (out.length > TARGET_SEND_IMAGE_BYTES) {
    if (quality > 40) {
      quality -= 10;
    } else if (maxEdge > 640) {
      maxEdge = Math.max(640, Math.floor(maxEdge * 0.75));
      quality = 70;
    } else {
      throw new Error("图片压缩后仍超过 1MB");
    }
    out = await encode(maxEdge, quality);
  }

  log.info("上传图已压缩", {
    fromBytes: img.buffer.length,
    toBytes: out.length,
    fromMime: img.mimeType,
    maxEdge,
    quality,
  });
  return { mimeType: "image/jpeg", buffer: out, data: out.toString("base64") };
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
