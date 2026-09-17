// 决策·katex-lazy: 仅在 DOM 里出现公式占位时才拉 KaTeX CSS/JS，避免常驻字体包。
// 决策·katex-after-dom: 与 mermaid 相同——直播增量只 parse；定稿/历史/预览/createPlan
// 入树后再 hydrate。半截 `$` 强渲染会闪烁。

const KATEX_VER = "0.16.22";
const KATEX_CSS = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VER}/dist/katex.min.css`;
const KATEX_JS = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VER}/dist/katex.min.js`;

let loadPromise = null;

// LLM 常把标识符写进 `\text{foo_bar}`；KaTeX 在 text 命令里仍把 `_` 当 subscript。
// 决策·math-text-underscore: 只补尚未转义的 `_`。模型已经写成 `\_` 时再 replace
// 会变成 `\\_`，KaTeX 解析失败并以红色源码显示（throwOnError:false）。
function escapeTextModeUnderscores(tex) {
  return tex.replace(
    /\\(?:text(?:tt|it|bf|sf|rm)?|mathrm|mathit|mathbf|mathsf)\{([^{}]*)\}/g,
    (m, inner) =>
      `${m.slice(0, m.indexOf("{"))}{${inner.replace(/\\_|_/g, (tok) => (tok === "_" ? "\\_" : tok))}}`,
  );
}

function loadKatex() {
  if (typeof katex !== "undefined") return Promise.resolve(katex);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[data-katex-cdn]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = KATEX_CSS;
      link.dataset.katexCdn = "1";
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = KATEX_JS;
    s.async = true;
    s.onload = () => {
      if (typeof katex === "undefined") {
        reject(new Error("katex global missing after CDN load"));
        return;
      }
      resolve(katex);
    };
    s.onerror = () => reject(new Error("katex CDN load failed"));
    document.head.appendChild(s);
  }).catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

/**
 * 把 root 内 `.math-tex` 交给 KaTeX。失败时保留转义后的源码。
 * 可对同一 root 重复调用（已渲染节点带 data-katex-done）。
 */
export async function hydrateMath(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const nodes = [...root.querySelectorAll(".math-tex")].filter((el) => !el.dataset.katexDone);
  if (!nodes.length) return;

  let api;
  try {
    api = await loadKatex();
  } catch {
    return;
  }
  if (!root.isConnected) return;

  for (const el of nodes) {
    if (!root.isConnected || !el.isConnected) return;
    const tex = escapeTextModeUnderscores(el.textContent ?? "");
    if (!tex.trim()) continue;
    const displayMode = el.dataset.display === "1";
    try {
      api.render(tex, el, { displayMode, throwOnError: false, trust: false });
      el.dataset.katexDone = "1";
    } catch {
      el.classList.add("math-fallback");
      el.dataset.katexDone = "1";
    }
  }
}
