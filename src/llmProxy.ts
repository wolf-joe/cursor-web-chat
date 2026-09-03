// 短任务网关(OpenAI 兼容 /chat/completions)。title / commit / TTS 口语化共用。
// 决策·llm-config-split: 地址与 key 来自 config.json 的 llm 段;缺配置时调用方降级。
import { loadLlmConfig } from "./config.js";

export function getLlmConfig():
  | { baseUrl: string; apiKey: string; model: string }
  | undefined {
  return loadLlmConfig();
}

export function isLlmConfigured(): boolean {
  return getLlmConfig() !== undefined;
}

// 决策·llm-app-name: 经兼容网关的用量统计靠请求头 X-App-Name 聚合来源。
export const LLM_APP_NAME = "cursor-web-chat";

// 决策·short-task-no-thinking: 标题/commit/TTS 口语化一律关思考。qwen 默认开着,
// 大 diff 会先空转 reasoning 撞本地超时;口语化开着会先吐完 reasoning 再出首句。
// 当前 llm 段是百炼 qwen,用 enable_thinking;若改回 deepseek/ 需换成
// thinking: { type: "disabled" }。
export const LLM_SHORT_TASK_NO_THINKING = {
  enable_thinking: false,
};

/** 短任务请求头:Content-Type + 应用标识 + 可选 Bearer。 */
export function llmProxyHeaders(extra?: Record<string, string>): Record<string, string> {
  const cfg = getLlmConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-App-Name": LLM_APP_NAME,
    ...extra,
  };
  if (cfg?.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}
