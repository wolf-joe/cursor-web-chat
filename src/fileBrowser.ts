// 决策·cwd-allowlist / 决策·path-confine / 决策·hide-dot / 决策·lazy-tree /
// 决策·truncation / 决策·list-cap / 决策·abs-path / 决策·preview-langs /
// 决策·sync-walk / 决策·match-relpath / 决策·files-only / 决策·depth-semantics /
// 决策·search-caps / 决策·skip-bad-nodes / 决策·symlink-mark / 决策·fs-scope-tighten:
// 只读列目录 / 读文本预览 / 相对路径子串搜索。cwd 须经 server 白名单;目标路径
// realpath 后默认必须落在 cwd 内;config.fileBrowser.allowParentTree=true 时放宽到
// cwd 的父目录树(含兄弟包,便于 monorepo 外链)。不返回点开头项;单目录最多 500 条;
// 预览硬上限:超过 2000 行或超过 200KB 都不回正文,只标 skipped。对外路径一律绝对路径。
// 软链接: type 为解析后真实类型,另带 symlink/linkTarget 供前端名后加 @。
import fs from "node:fs/promises";
import path from "node:path";
import { loadFileBrowserAllowParentTree } from "./config.js";

const MAX_CONTENT_LINES = 2000;
/** 预览体积上限:超过则不读入、不展示。 */
const MAX_PREVIEW_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 500;

/** 决策·search-caps */
const MAX_SEARCH_HITS = 100;
const MAX_SEARCH_NODES = 50_000;
/** 决策·depth-semantics: 从 cwd 起最多再下钻 12 层(够覆盖 pkg/.../resources/*.go 一类路径) */
const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_MS = 5000;

export type FsSkipReason = "binary" | "too_large" | "error";

export interface FsSkipped {
  reason: FsSkipReason;
  message: string;
}

export interface FsListEntry {
  name: string;
  /** 绝对路径 */
  path: string;
  type: "file" | "dir";
  /** 决策·symlink-mark: 条目本身是否为软链接(type 仍是解析后的真实类型) */
  symlink: boolean;
  /** symlink 时为 realpath 目标,供悬停展示 */
  linkTarget?: string;
}

export interface FsListResult {
  /** 被列出的目录绝对路径 */
  path: string;
  entries: FsListEntry[];
  truncated: boolean;
}

export interface FsReadResult {
  /** 绝对路径 */
  path: string;
  content: string | null;
  /** highlight.js 语言名,未知扩展为 null */
  language: string | null;
  skipped: FsSkipped | null;
  truncated: boolean;
}

/** 决策·search-caps: 全局停止原因(深度只限制下行,不单独作为全局 stop) */
export type FsSearchTruncateReason = "hit_limit" | "node_limit" | "timeout";

export interface FsSearchMatch {
  name: string;
  /** 绝对路径 */
  path: string;
  /** 相对 cwd 的路径,供列表展示与子串匹配 */
  relativePath: string;
  /** 决策·symlink-mark */
  symlink: boolean;
  linkTarget?: string;
}

export interface FsSearchResult {
  matches: FsSearchMatch[];
  truncated: boolean;
  truncateReason?: FsSearchTruncateReason;
}

const SKIP_MESSAGES = {
  binary: "二进制或图片文件，不展示内容",
  too_many_lines: `超过 ${MAX_CONTENT_LINES} 行，不展示内容`,
  too_large_bytes: `超过 ${Math.round(MAX_PREVIEW_BYTES / 1024)}KB，不展示内容`,
  error: "无法读取文件",
} as const;

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".bmp",
  ".avif",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".sql": "sql",
  ".toml": "ini",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".txt": "plaintext",
};

export class PathConfineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathConfineError";
  }
}

/**
 * 决策·path-confine / 决策·fs-scope-tighten:
 * 默认禁锢根为 cwd 自身;allowParentTree 时为 dirname(cwd)(含兄弟目录与指向它们的 symlink)。
 */
function fsConfineRoot(cwdReal: string): string {
  if (loadFileBrowserAllowParentTree()) {
    return path.dirname(cwdReal);
  }
  return cwdReal;
}

function isUnderRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

async function resolveWithinCwd(cwd: string, targetPath?: string): Promise<string> {
  let cwdReal: string;
  try {
    cwdReal = await fs.realpath(cwd);
  } catch {
    throw new PathConfineError("cwd 不存在或无法访问");
  }

  const candidate = targetPath
    ? path.isAbsolute(targetPath)
      ? targetPath
      : path.join(cwdReal, targetPath)
    : cwdReal;

  let resolved: string;
  try {
    resolved = await fs.realpath(candidate);
  } catch {
    throw new PathConfineError("路径不存在或无法访问");
  }

  const root = fsConfineRoot(cwdReal);
  if (!isUnderRoot(root, resolved)) {
    throw new PathConfineError("路径超出工作区范围");
  }
  return resolved;
}

function languageFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return sample.includes(0);
}

/** 决策·lazy-tree / 决策·hide-dot / 决策·list-cap / 决策·abs-path */
export async function listDirectory(cwd: string, dirPath?: string): Promise<FsListResult> {
  const abs = await resolveWithinCwd(cwd, dirPath);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) {
    throw new PathConfineError("目标不是目录");
  }

  const names = await fs.readdir(abs);
  const visible = names.filter((n) => !n.startsWith("."));
  visible.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const truncated = visible.length > MAX_LIST_ENTRIES;
  const slice = truncated ? visible.slice(0, MAX_LIST_ENTRIES) : visible;

  const cwdReal = await fs.realpath(cwd);
  const root = fsConfineRoot(cwdReal);
  const entries: FsListEntry[] = [];
  for (const name of slice) {
    const child = path.join(abs, name);
    let type: "file" | "dir" = "file";
    let symlink = false;
    let linkTarget: string | undefined;
    try {
      const cst = await fs.lstat(child);
      if (cst.isDirectory()) {
        type = "dir";
      } else if (cst.isSymbolicLink()) {
        // 决策·path-confine: 跟 symlink 判断真实类型;逃出禁锢根的不暴露。
        // 决策·symlink-mark: 暴露 symlink 标志与目标,前端名后加 @。
        try {
          const real = await fs.realpath(child);
          if (!isUnderRoot(root, real)) {
            continue;
          }
          const rst = await fs.stat(real);
          type = rst.isDirectory() ? "dir" : "file";
          symlink = true;
          linkTarget = real;
        } catch {
          continue;
        }
      } else if (!cst.isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    entries.push({ name, path: child, type, symlink, linkTarget });
  }

  // 目录在前,再按名字。
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { path: abs, entries, truncated };
}

/** 决策·truncation / 决策·preview-langs / 决策·abs-path */
export async function readTextFile(cwd: string, filePath: string): Promise<FsReadResult> {
  const abs = await resolveWithinCwd(cwd, filePath);
  const base: FsReadResult = {
    path: abs,
    content: null,
    language: languageFor(abs),
    skipped: null,
    truncated: false,
  };

  const ext = path.extname(abs).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return {
      ...base,
      skipped: { reason: "binary", message: SKIP_MESSAGES.binary },
    };
  }

  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return {
      ...base,
      skipped: { reason: "error", message: SKIP_MESSAGES.error },
    };
  }
  if (!st.isFile()) {
    return {
      ...base,
      skipped: { reason: "error", message: "目标不是普通文件" },
    };
  }
  // 决策·truncation: 先按体积拦,避免把超大文件读进内存再数行。
  if (st.size > MAX_PREVIEW_BYTES) {
    return {
      ...base,
      skipped: { reason: "too_large", message: SKIP_MESSAGES.too_large_bytes },
    };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return {
      ...base,
      skipped: { reason: "error", message: SKIP_MESSAGES.error },
    };
  }

  if (looksBinary(buf)) {
    return {
      ...base,
      skipped: { reason: "binary", message: SKIP_MESSAGES.binary },
    };
  }

  const text = buf.toString("utf8");
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  if (lineCount > MAX_CONTENT_LINES) {
    return {
      ...base,
      skipped: { reason: "too_large", message: SKIP_MESSAGES.too_many_lines },
    };
  }

  return {
    ...base,
    content: text,
    skipped: null,
    truncated: false,
  };
}

/**
 * 决策·sync-walk / 决策·match-relpath / 决策·files-only / 决策·depth-semantics /
 * 决策·search-caps / 决策·skip-bad-nodes / 决策·hide-dot / 决策·abs-path:
 * 在 cwd 内同步 BFS walk,对相对路径做大小写不敏感子串匹配;只收集普通文件;
 * 坏节点跳过继续;命中/节点/墙钟任一触顶即停。
 */
export async function searchFiles(cwd: string, query: string): Promise<FsSearchResult> {
  const q = query.trim().toLowerCase();
  if (!q) {
    throw new PathConfineError("缺少搜索关键字");
  }

  const cwdReal = await resolveWithinCwd(cwd);
  const root = fsConfineRoot(cwdReal);
  const started = Date.now();
  const matches: FsSearchMatch[] = [];
  let nodes = 0;
  let truncated = false;
  let truncateReason: FsSearchTruncateReason | undefined;

  type QueueItem = { abs: string; depth: number };
  const queue: QueueItem[] = [{ abs: cwdReal, depth: 0 }];

  const stopForCaps = (): boolean => {
    if (matches.length >= MAX_SEARCH_HITS) {
      truncated = true;
      truncateReason = "hit_limit";
      return true;
    }
    if (nodes >= MAX_SEARCH_NODES) {
      truncated = true;
      truncateReason = "node_limit";
      return true;
    }
    if (Date.now() - started > MAX_SEARCH_MS) {
      truncated = true;
      truncateReason = "timeout";
      return true;
    }
    return false;
  };

  while (queue.length > 0) {
    if (stopForCaps()) break;

    const { abs, depth } = queue.shift()!;
    // 访问该目录计一次节点(根 cwd 与入队子目录均在此计,避免与子项双重计数)
    nodes += 1;
    if (stopForCaps()) break;

    let names: string[];
    try {
      names = await fs.readdir(abs);
    } catch {
      // 决策·skip-bad-nodes
      continue;
    }

    const visible = names.filter((n) => !n.startsWith("."));
    for (const name of visible) {
      if (stopForCaps()) break;

      const child = path.join(abs, name);
      let type: "file" | "dir";
      let symlink = false;
      let linkTarget: string | undefined;
      try {
        const cst = await fs.lstat(child);
        if (cst.isDirectory()) {
          type = "dir";
        } else if (cst.isSymbolicLink()) {
          try {
            const real = await fs.realpath(child);
            // 决策·path-confine: 允许指向禁锢根内的外链(allowParentTree 时含兄弟包)
            if (!isUnderRoot(root, real)) {
              continue;
            }
            const rst = await fs.stat(real);
            type = rst.isDirectory() ? "dir" : "file";
            symlink = true;
            linkTarget = real;
          } catch {
            continue;
          }
        } else if (cst.isFile()) {
          type = "file";
        } else {
          continue;
        }
      } catch {
        continue;
      }

      if (type === "file") {
        nodes += 1;
        if (stopForCaps()) break;
        const relativePath = path.relative(cwdReal, child);
        // 决策·match-relpath / 决策·files-only / 决策·symlink-mark
        if (relativePath.toLowerCase().includes(q)) {
          matches.push({ name, path: child, relativePath, symlink, linkTarget });
          if (stopForCaps()) break;
        }
      } else if (depth + 1 <= MAX_SEARCH_DEPTH) {
        // 决策·depth-semantics: 子目录深度 ≤ MAX_SEARCH_DEPTH 才入队;超出不进入也不计数
        queue.push({ abs: child, depth: depth + 1 });
      }
    }

    if (truncated) break;
  }

  const result: FsSearchResult = { matches, truncated };
  if (truncateReason) result.truncateReason = truncateReason;
  return result;
}
