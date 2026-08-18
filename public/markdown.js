// 决策·ascii-autolink: GFM 裸 URL 只吃 RFC 3986 ASCII（含百分号编码）；
// 汉字/全角标点留在链接外。显式 [text](url) 与 <url> 仍走 marked 原规则。
// email 裸链接返回 false，回退 marked 原 tokenizer。
// 本模块是叶子：不得 import render.js（决策·md-no-cycle）。

let markedAutolinkPatched = false;

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

patchMarkedAutolink();

export function renderMarkdown(text) {
  patchMarkedAutolink();
  if (typeof marked !== "undefined") return marked.parse(text ?? "");
  // marked 从 CDN 加载失败时的兜底:没有 HTML 块级结构,换行符靠 <br> 保留,
  // 不再依赖容器级 white-space: pre-wrap(那个属性对 marked 输出反而有害,见 style.css)。
  return escapeHtml(text).replace(/\n/g, "<br>");
}
