// 决策·title-via-gateway: 新会话标题不走 @cursor/sdk Agent——避免脏写会话历史。
// 决策·llm-config-split: 缺 llm 配置时回退为用户首句截断,不尝试连网关。
import {
  getLlmConfig,
  isLlmConfigured,
  llmProxyHeaders,
} from "./llmProxy.js";
import { log, previewText } from "./logger.js";

const TIMEOUT_MS = 8000;
const MAX_TITLE_LENGTH = 40;

// 决策·title-fewshot-in-system: 示例只写在 system 里教格式;做成 user/assistant
// 多轮会被当成对话续写(自我介绍/给步骤)。覆盖打招呼、问身份、查数据、长口述。
// 决策·title-no-char-count: 不要写「不超过 N 个字」——开思考时模型会逐字母数英文,
// 空转上千 reasoning tokens 撞本地超时。长度由 MAX_TITLE_LENGTH 截断兜底。
const SYSTEM_PROMPT =
  "你是对话标题生成器。根据用户的第一条消息生成一个简洁的会话标题。" +
  "短标题即可,中英混合时整词保留,不要数字数、不要为凑长度反复改写。" +
  "不要标点符号,不要引号包裹,直接输出标题本身,不要任何其他说明。" +
  "不要回答用户的问题,不要自我介绍,不要给操作步骤;即使用户在问你是谁或描述故障,也只概括成标题。" +
  "示例:用户说「你好」→「打招呼」;" +
  "用户说「你是什么模型」→「询问模型身份」;" +
  "用户说「帮我查本月支出」→「查询本月支出」;" +
  "用户说一段很长的口述报错→概括成短标题,不要解答。";

function fallbackTitle(userText: string): string {
  const oneLine = userText.replace(/\s+/g, " ").trim();
  return oneLine.slice(0, MAX_TITLE_LENGTH) || "新会话";
}

// 失败(网络错误、超时、网关非 200、返回内容为空)一律返回 null,调用方兜底保留默认标题,
// 不向上抛——标题生成不是对话流程的必要环节。缺配置时返回截断首句(非 null)。
export async function generateTitle(userText: string): Promise<string | null> {
  if (!isLlmConfigured()) {
    const title = fallbackTitle(userText);
    log.info("会话标题已回退(llm 未配置)", { title });
    return title;
  }
  const cfg = getLlmConfig()!;
  const model = cfg.model;
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
          { role: "user", content: userText.slice(0, 2000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.error("标题生成失败(不影响会话): llm 网关非 200", undefined, {
        status: res.status,
        model,
        textPreview: previewText(userText),
      });
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const title = data.choices?.[0]?.message?.content?.trim();
    if (title) {
      const clipped = title.slice(0, MAX_TITLE_LENGTH);
      log.info("会话标题已生成", { title: clipped, model });
      return clipped;
    }
    log.warn("标题生成返回空内容(不影响会话)", { model });
    return null;
  } catch (err) {
    log.error("标题生成失败(不影响会话)", err, { model });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
