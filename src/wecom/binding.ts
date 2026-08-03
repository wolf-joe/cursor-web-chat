import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 决策·binding-file: 当前企微会话指针落盘;new 清空。data/ 已在 .gitignore。
const BINDING_DIR = path.join(__dirname, "..", "..", "data", "wecom");
const BINDING_PATH = path.join(BINDING_DIR, "binding.json");

export interface WecomBinding {
  cwd: string;
  agentId: string;
  updatedAt: string;
}

export function loadBinding(cwd: string): string | undefined {
  if (!existsSync(BINDING_PATH)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(BINDING_PATH, "utf-8")) as Partial<WecomBinding>;
    if (raw.cwd !== cwd || typeof raw.agentId !== "string" || !raw.agentId) {
      return undefined;
    }
    return raw.agentId;
  } catch (err) {
    log.warn("读取 wecom binding 失败,视为无绑定", {
      path: BINDING_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export function saveBinding(cwd: string, agentId: string): void {
  mkdirSync(BINDING_DIR, { recursive: true });
  const payload: WecomBinding = {
    cwd,
    agentId,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(BINDING_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function clearBinding(): void {
  if (!existsSync(BINDING_PATH)) return;
  // 写空对象比 unlink 更稳——避免并发读到 ENOENT 时误判路径问题。
  writeFileSync(BINDING_PATH, "{}\n", "utf-8");
}
