// 决策·message-via-gateway / 决策·message-truncation:
// commit message 用本机 llm-proxy flash 一次性生成,不走 @cursor/sdk Agent
// (避免脏写会话历史,与 titleService 同因)。喂给 LLM 的 diff 必须服务端截断。
//
// 决策·message-truncation 上限(实施回写):
// - 最多 40 个文件进入 prompt
// - 每个文件 patch 最多 200 行
// - 总字符上限 24000;超出后截断并标注
// - 二进制 / too_large / error 的文件只写一行跳过说明,不塞正文
import { getGitDiff } from "./gitDiff.js";
// commit message 只读本地 diff,不触发 Overlay 的 sync fetch。
// 决策·llm-config-split: 缺 llm 配置时返回 message:null,不阻塞手填提交。
import {
  getLlmConfig,
  isLlmConfigured,
  llmProxyHeaders,
} from "./llmProxy.js";
import { log, previewText } from "./logger.js";

const TIMEOUT_MS = 15_000;
const MAX_FILES_IN_PROMPT = 40;
const MAX_LINES_PER_FILE = 200;
const MAX_TOTAL_CHARS = 24_000;
// 决策·message-short-plain: 自动草稿要短、纯文本——中文一句、禁止 Markdown
// (反引号/加粗等)。长度真源是 MAX_COMMIT_MESSAGE_LENGTH,sanitize 截断兜底。
// 决策·message-no-char-count: 不要写「最多 N 个字」——开思考时模型会逐字点数
// (中英混排时更甚),空转几百 reasoning tokens。
// 决策·message-fewshot-in-system: 示例只写在 system 里教风格与长短;做成
// user/assistant 多轮会被当成对话续写。示例宜短,当作目标长度;上限 70 兜底。
const MAX_COMMIT_MESSAGE_LENGTH = 70;
const SYSTEM_PROMPT =
  "你是 git commit message 生成器。根据未提交的 diff 写一条中文 commit message。" +
  "要求:必须用中文(可保留必要的专有名词/文件名);" +
  "一句短句即可,概括「做了什么、为何改」,不要只堆几个单词;" +
  "不要数字数、不要为凑长度反复改写;" +
  "纯文本,禁止 Markdown(不要反引号、加粗、标题、列表、链接);" +
  "不要空行,不要引号包裹,不要 Conventional Commits 前缀(如 feat:/fix:);" +
  "直接输出 message 本身,不要任何其他说明。" +
  "示例:diff 把超时从 8 秒调到 15 秒→「将标题生成超时调到 15 秒」;" +
  "diff 删除 workspace 机制改为订阅文件驱动→「移除 workspace，改由订阅文件驱动下载」;" +
  "diff 新增设置页切换服务地址→「新增设置页以切换服务地址」;" +
  "diff 修空指针并补注释→「修复空指针并补充相关注释」。";

/** 取首行、去掉常见 Markdown 记号、压空白,再按上限截断。 */
function sanitizeCommitMessage(raw: string): string {
  const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/[`*_#>~\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMMIT_MESSAGE_LENGTH);
}

export interface CommitMessageDraft {
  message: string | null;
  branch: string | null;
  fileCount: number;
  truncatedForLlm: boolean;
  /** 工作区是否有可提交改动;干净时 message 为 null */
  dirty: boolean;
  repo: boolean;
}

function buildDiffPromptText(files: Awaited<ReturnType<typeof getGitDiff>>["files"]): {
  text: string;
  truncatedForLlm: boolean;
} {
  const selected = files.slice(0, MAX_FILES_IN_PROMPT);
  let truncatedForLlm = files.length > MAX_FILES_IN_PROMPT;
  const parts: string[] = [];

  for (const f of selected) {
    if (f.skipped) {
      parts.push(`--- ${f.path} (${f.label}) [${f.skipped.reason}: ${f.skipped.message}]`);
      continue;
    }
    if (!f.patch) {
      parts.push(`--- ${f.path} (${f.label}) [no text patch]`);
      continue;
    }
    let patch = f.patch;
    const lines = patch.split("\n");
    if (lines.length > MAX_LINES_PER_FILE) {
      patch = lines.slice(0, MAX_LINES_PER_FILE).join("\n") + `\n… (截断,原 ${lines.length} 行)`;
      truncatedForLlm = true;
    }
    parts.push(`--- ${f.path} (${f.label})\n${patch}`);
  }

  let text = parts.join("\n\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS) + "\n… (总长度截断)";
    truncatedForLlm = true;
  }
  return { text, truncatedForLlm };
}

async function callLlm(diffText: string): Promise<string | null> {
  if (!isLlmConfigured()) {
    log.info("commit message 跳过(llm 未配置)");
    return null;
  }
  const cfg = getLlmConfig()!;
  const model = cfg.model;
  // 决策·side-task-success-one / 决策·log-density: 成功只打一条汇总;开始不打。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: llmProxyHeaders(),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: diffText },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.error("commit message 生成失败: llm 网关非 200", undefined, {
        status: res.status,
        model,
        diffPreview: previewText(diffText),
      });
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      log.warn("commit message 生成返回空内容", { model });
      return null;
    }
    const message = sanitizeCommitMessage(raw);
    log.info("commit message 已生成", { resp: raw, model });
    return message || null;
  } catch (err) {
    log.error("commit message 生成失败", err, { model });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 失败返回 message:null,调用方可手填;不向上抛。 */
export async function generateCommitMessage(cwd: string): Promise<CommitMessageDraft> {
  const diff = await getGitDiff(cwd, { sync: false });
  if (!diff.repo) {
    return {
      message: null,
      branch: null,
      fileCount: 0,
      truncatedForLlm: false,
      dirty: false,
      repo: false,
    };
  }
  if (!diff.files.length) {
    return {
      message: null,
      branch: diff.branch,
      fileCount: 0,
      truncatedForLlm: false,
      dirty: false,
      repo: true,
    };
  }

  const { text, truncatedForLlm } = buildDiffPromptText(diff.files);
  const message = text.trim() ? await callLlm(text) : null;
  return {
    message,
    branch: diff.branch,
    fileCount: diff.files.length,
    truncatedForLlm: truncatedForLlm || diff.truncated,
    dirty: true,
    repo: true,
  };
}
