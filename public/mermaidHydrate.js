// 决策·mermaid-lazy: 仅在页面出现 ```mermaid 时才拉 CDN，避免常驻 ~3.5MB。
// 决策·mermaid-after-dom: 直播增量只出代码块；气泡定稿 / 历史 / 文件预览 / createPlan
// 写入 DOM 后再 hydrate——不完整 fence 或反复 innerHTML 时强渲染会闪烁/报错。

const MERMAID_CDN =
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";

let loadPromise = null;
let seq = 0;

function loadMermaid() {
  if (typeof mermaid !== "undefined") return Promise.resolve(mermaid);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MERMAID_CDN;
    s.async = true;
    s.onload = () => {
      try {
        // 决策·mermaid-strict: 禁止点击/交互脚本；浅色 UI 用 neutral。
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
        });
        resolve(mermaid);
      } catch (err) {
        reject(err);
      }
    };
    s.onerror = () => reject(new Error("mermaid CDN load failed"));
    document.head.appendChild(s);
  }).catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

function isMermaidCode(code) {
  return [...code.classList].some((c) => c.toLowerCase() === "language-mermaid");
}

/**
 * 把 root 内 `pre > code.language-mermaid` 换成 SVG 图。
 * 失败或库未加载时保留原代码块。可对同一 root 重复调用（已替换的节点不会再匹配）。
 */
export async function hydrateMermaid(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const codes = [...root.querySelectorAll("pre > code")].filter(isMermaidCode);
  if (!codes.length) return;

  let api;
  try {
    api = await loadMermaid();
  } catch {
    return;
  }
  if (!root.isConnected) return;

  for (const code of codes) {
    if (!root.isConnected) return;
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE") continue;
    if (pre.classList.contains("mermaid-fallback")) continue;
    const source = (code.textContent ?? "").trim();
    if (!source) continue;

    const id = `mmd-${++seq}-${Date.now().toString(36)}`;
    try {
      const { svg } = await api.render(id, source);
      if (!root.isConnected || !pre.isConnected) return;
      const wrap = document.createElement("div");
      wrap.className = "mermaid-diagram";
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch {
      // 语法错误等：保留代码块；清掉 mermaid 可能挂在 body 上的临时节点。
      pre.classList.add("mermaid-fallback");
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
}
