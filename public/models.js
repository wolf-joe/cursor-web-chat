import {
  modelSelectEl,
  modelParamsBtn,
  modelParamsSummaryEl,
  modelParamsModalOverlay,
  modelParamsModalBody,
  modelParamsModalClose,
} from "./dom.js";
import { state } from "./state.js";
import { fetchModels } from "./api.js";
import { escapeHtml } from "./render.js";
import { syncPendingImageWithModel } from "./composer.js";

// 决策·model-session-scoped: 拷一份再赋给 selected,避免改 params 时写穿 defaultModel。
function copyModelSelection(sel) {
  if (!sel) return null;
  return {
    id: sel.id,
    ...(sel.params ? { params: sel.params.map((p) => ({ ...p })) } : {}),
  };
}

export async function loadModels() {
  const data = await fetchModels();
  state.models = data.models ?? [];
  state.defaultModel = data.default ?? null;
  state.selectedModel = copyModelSelection(state.defaultModel);
  state.ttsEnabled = data.ttsEnabled === true;

  renderModelBar();
  syncPendingImageWithModel();
  // 动态 import 避免与 userSettings 循环依赖。
  import("./userSettings.js").then((m) => m.syncTtsSettingsVisibility?.());
}

/** 决策·model-session-scoped: 切会话时拨回代码默认,同一会话内的手动选择保留。 */
export function resetModelToDefault() {
  state.selectedModel = copyModelSelection(state.defaultModel);
  renderModelBar();
  closeModelParamsModal();
  syncPendingImageWithModel();
}

function findModelParamDefault(model, paramId) {
  const defaultVariant = model?.variants?.find((v) => v.isDefault);
  return defaultVariant?.params.find((p) => p.id === paramId)?.value;
}

export function renderModelBar() {
  modelSelectEl.innerHTML = state.models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.displayName)}</option>`)
    .join("");
  modelSelectEl.value = state.selectedModel?.id ?? "";
  renderModelParams();
}

// 取某个参数当前生效的取值:优先用户已经选过的,否则落到该模型默认 variant
// 里这个参数的值,再否则(没有默认 variant,如刚切换到新模型)拿第一个候选值——
// 和 SDK 不传 params 时的行为对齐,保证摘要文字和"实际会发出去的值"永远一致。
function currentParamValue(model, paramDef) {
  return (
    state.selectedModel.params?.find((x) => x.id === paramDef.id)?.value ??
    findModelParamDefault(model, paramDef.id) ??
    paramDef.values[0]?.value
  );
}

// 布尔类值(true/false)常常没有 displayName(比如 thinking 参数),裸值展示
// 不直观,这里给这一种常见形状兜底翻译成"开/关",其余取值照抄原始 displayName。
function paramValueLabel(value) {
  if (value.displayName) return value.displayName;
  if (value.value === "true") return "开";
  if (value.value === "false") return "关";
  return value.value;
}

// 齿轮后面只跟一个极短的提示,不是完整参数列表(那种铺开的写法在手机上太占地方,
// 完整说明和调节都在点齿轮弹出的弹窗里)。规则是两个具体 id 的特判,不是通用逻辑:
// fast 是"开/关"型,只有开着才值得提一句;effort 是档位型,只要模型支持就把当前
// 档位亮出来(不管是不是最高档)。其余参数(thinking/context 等)不在这里出现。
function modelParamsShortLabel(model) {
  const params = model?.parameters ?? [];
  const parts = [];

  const fastParam = params.find((p) => p.id === "fast");
  if (fastParam && currentParamValue(model, fastParam) === "true") parts.push("fast");

  const effortParam = params.find((p) => p.id === "effort");
  if (effortParam) parts.push(currentParamValue(model, effortParam));

  return parts.join("+");
}

// 输入框上方放「模型下拉 + 齿轮 + 极短提示」,不铺开完整参数——手机上一排选项会
// 把发消息区挤没了。参数的完整说明和调节都放进点齿轮才弹出的弹窗里。
function renderModelParams() {
  const model = state.models.find((m) => m.id === state.selectedModel?.id);
  const params = model?.parameters ?? [];
  modelParamsBtn.classList.toggle("show", params.length > 0);
  modelParamsSummaryEl.textContent = modelParamsShortLabel(model);
}

function openModelParamsModal() {
  const model = state.models.find((m) => m.id === state.selectedModel?.id);
  const params = model?.parameters ?? [];
  if (!params.length) return;
  renderModelParamsModalBody(model, params);
  modelParamsModalOverlay.classList.add("open");
}

function closeModelParamsModal() {
  modelParamsModalOverlay.classList.remove("open");
}

function renderModelParamsModalBody(model, params) {
  modelParamsModalBody.innerHTML = params
    .map((p) => {
      const current = currentParamValue(model, p);
      const options = p.values
        .map(
          (v) =>
            `<button type="button" class="param-option${v.value === current ? " selected" : ""}" data-param-id="${escapeHtml(p.id)}" data-value="${escapeHtml(v.value)}">${escapeHtml(paramValueLabel(v))}</button>`,
        )
        .join("");
      return `<div class="param-group"><div class="param-group-label">${escapeHtml(p.displayName ?? p.id)}</div><div class="param-options">${options}</div></div>`;
    })
    .join("");

  for (const btn of modelParamsModalBody.querySelectorAll(".param-option")) {
    btn.addEventListener("click", () => {
      const paramId = btn.dataset.paramId;
      const params = (state.selectedModel.params ?? []).filter((p) => p.id !== paramId);
      params.push({ id: paramId, value: btn.dataset.value });
      state.selectedModel = { ...state.selectedModel, params };
      renderModelParams();
      renderModelParamsModalBody(model, model.parameters);
    });
  }
}

modelParamsBtn.addEventListener("click", openModelParamsModal);
modelParamsModalClose.addEventListener("click", closeModelParamsModal);
modelParamsModalOverlay.addEventListener("click", (e) => {
  if (e.target === modelParamsModalOverlay) closeModelParamsModal();
});

modelSelectEl.addEventListener("change", () => {
  const model = state.models.find((m) => m.id === modelSelectEl.value);
  if (!model) return;
  // 切模型时参数重置为该模型自己的默认 variant,而不是继续沿用上一个模型的
  // 参数取值(不同模型的参数 id/取值集合互不兼容,沿用没有意义)。
  const defaultVariant = model.variants?.find((v) => v.isDefault);
  const params = defaultVariant?.params ? [...defaultVariant.params] : [];
  if (model.parameters?.some((p) => p.id === "fast")) {
    const fastIdx = params.findIndex((p) => p.id === "fast");
    if (fastIdx >= 0) params[fastIdx] = { id: "fast", value: "false" };
    else params.push({ id: "fast", value: "false" });
  }
  state.selectedModel = { id: model.id, params };
  renderModelParams();
  closeModelParamsModal();
  // 决策·vision-allowlist: 切到非 vision(如 glm-5.2)时清空已选图。
  syncPendingImageWithModel();
});
