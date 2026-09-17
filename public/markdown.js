// 决策·ascii-autolink: GFM 裸 URL 只吃 RFC 3986 ASCII（含百分号编码）；
// 汉字/全角标点留在链接外。显式 [text](url) 与 <url> 仍走 marked 原规则。
// email 裸链接返回 false，回退 marked 原 tokenizer。
// 本模块是叶子：不得 import render.js（决策·md-no-cycle）。

let markedAutolinkPatched = false;
let markedMathPatched = false;

// RFC 3986 unreserved / reserved / pct-encoded；不含非 ASCII。
const ASCII_BARE_URL =
  /^((?:ftp|https?):\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i;

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function patchMarkedAutolink() {
  if (markedAutolinkPatched || typeof marked === "undefined") return;
  markedAutolinkPatched = true;
  marked.use({
    tokenizer: {
      url(src) {
        if (!/^(?:ftp|https?):\/\/|^www\./i.test(src)) return false;
        const cap = ASCII_BARE_URL.exec(src);
        // 已是 http(s)/ftp/www 前缀但没有 ASCII 体：不要回退到会吞汉字的原规则。
        if (!cap) return undefined;

        let raw = cap[0];
        const backpedal = this.rules?.inline?._backpedal;
        if (backpedal && typeof backpedal.exec === "function") {
          let prev;
          do {
            prev = raw;
            raw = backpedal.exec(raw)?.[0] ?? "";
          } while (prev !== raw);
        }
        if (!raw) return undefined;

        const href = cap[1].toLowerCase() === "www." ? `http://${raw}` : raw;
        const text = escapeHtml(raw);
        return {
          type: "link",
          raw,
          text,
          href,
          tokens: [{ type: "text", raw: text, text }],
        };
      },
    },
  });
}

function mathSpan(text, display) {
  const mode = display ? "1" : "0";
  return `<span class="math-tex" data-display="${mode}">${escapeHtml(text)}</span>`;
}

function takeDisplayDollar(src) {
  if (!src.startsWith("$$")) return null;
  const end = src.indexOf("$$", 2);
  if (end < 0) return null;
  const text = src.slice(2, end).trim();
  if (!text) return null;
  let raw = src.slice(0, end + 2);
  if (src[raw.length] === "\n") raw += "\n";
  return { raw, text };
}

function takeParenMath(src) {
  if (!src.startsWith("\\(")) return null;
  const end = src.indexOf("\\)", 2);
  if (end < 0) return null;
  const text = src.slice(2, end).trim();
  if (!text) return null;
  return { raw: src.slice(0, end + 2), text };
}

// 决策·math-dollar: 开闭 `$` 两侧都不能贴空白，避免 `$5 and $10` 被吞成一段公式。
function takeInlineDollar(src) {
  if (src[0] !== "$" || src[1] === "$") return null;
  if (src.length < 3 || /\s/.test(src[1])) return null;
  let i = 1;
  while (i < src.length) {
    if (src[i] === "\n") return null;
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (src[i] === "$") {
      if (/\s/.test(src[i - 1])) return null;
      const text = src.slice(1, i);
      if (!text) return null;
      return { raw: src.slice(0, i + 1), text };
    }
    i += 1;
  }
  return null;
}

function mathToken(display, raw, text) {
  return { type: display ? "mathDisplay" : "mathInline", raw, text, display };
}

// 决策·math-protect: 公式 tokenizer 先于 emphasis/escape，避免 `_` `*` `\(` 被 Markdown 吃掉。
function patchMarkedMath() {
  if (markedMathPatched || typeof marked === "undefined") return;
  markedMathPatched = true;
  marked.use({
    extensions: [
      {
        name: "mathDisplay",
        level: "block",
        start(src) {
          return src.startsWith("$$") ? 0 : undefined;
        },
        tokenizer(src) {
          const cap = takeDisplayDollar(src);
          if (!cap) return false;
          return mathToken(true, cap.raw, cap.text);
        },
        renderer(token) {
          return mathSpan(token.text, true);
        },
      },
      {
        name: "mathDisplayInline",
        level: "inline",
        start(src) {
          const i = src.indexOf("$$");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const cap = takeDisplayDollar(src);
          if (!cap) return false;
          return { type: "mathDisplayInline", raw: cap.raw.replace(/\n$/, ""), text: cap.text, display: true };
        },
        renderer(token) {
          return mathSpan(token.text, true);
        },
      },
      {
        name: "mathParen",
        level: "inline",
        start(src) {
          const i = src.indexOf("\\(");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const cap = takeParenMath(src);
          if (!cap) return false;
          return { type: "mathParen", raw: cap.raw, text: cap.text, display: false };
        },
        renderer(token) {
          return mathSpan(token.text, false);
        },
      },
      {
        name: "mathInline",
        level: "inline",
        start(src) {
          const i = src.indexOf("$");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const cap = takeInlineDollar(src);
          if (!cap) return false;
          return mathToken(false, cap.raw, cap.text);
        },
        renderer(token) {
          return mathSpan(token.text, false);
        },
      },
    ],
  });
}

patchMarkedAutolink();
patchMarkedMath();

export function renderMarkdown(text) {
  patchMarkedAutolink();
  patchMarkedMath();
  if (typeof marked !== "undefined") return marked.parse(text ?? "");
  // marked 从 CDN 加载失败时的兜底:没有 HTML 块级结构,换行符靠 <br> 保留,
  // 不再依赖容器级 white-space: pre-wrap(那个属性对 marked 输出反而有害,见 style.css)。
  return escapeHtml(text).replace(/\n/g, "<br>");
}
