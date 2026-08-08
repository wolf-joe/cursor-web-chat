// 决策·cookie-token: 鉴权用 cookie 承载 token——SSE / TTS 音频 / 用户图片 / fs raw
// 四类浏览器原生加载无法带自定义 Authorization header;cookie 是唯一能同时覆盖的载体。
// 不引 cookie-parser,手写解析十几行即可。
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const AUTH_COOKIE_NAME = "cwc_auth";
/** 决策·cookie-token: 显式 Max-Age,避免 session cookie 导致 PWA 冷启动反复登入。 */
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 天

export function getAuthToken(): string | undefined {
  const raw = process.env.AUTH_TOKEN?.trim();
  return raw || undefined;
}

/** https 部署可设 AUTH_COOKIE_SECURE=1;默认不标 Secure,否则 http 局域网根本写不进 cookie。 */
function cookieSecure(): boolean {
  const v = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // 长度不同时仍做一次比较,避免纯长度短路泄露;结果必然 false。
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  return timingSafeEqualStr(candidate, expected);
}

export function isAuthenticated(req: Request): boolean {
  const expected = getAuthToken();
  if (!expected) return true;
  const cookies = parseCookies(req.headers.cookie);
  return tokenMatches(cookies[AUTH_COOKIE_NAME], expected);
}

export function buildAuthCookie(token: string): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearAuthCookie(): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** 未配 AUTH_TOKEN 时整段中间件放行;已配则只白名单登录页与验证接口。 */
export function createAuthMiddleware() {
  const expected = getAuthToken();
  if (!expected) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const allowExact = new Set(["/login.html", "/api/auth/login", "/api/auth/logout"]);

  return (req: Request, res: Response, next: NextFunction) => {
    const pathOnly = (req.path || "/").split("?")[0];
    if (allowExact.has(pathOnly)) {
      next();
      return;
    }
    if (isAuthenticated(req)) {
      next();
      return;
    }

    const wantsHtml =
      req.method === "GET" &&
      (pathOnly === "/" ||
        pathOnly === "/index.html" ||
        (req.headers.accept ?? "").includes("text/html"));

    if (wantsHtml) {
      res.redirect(302, "/login.html");
      return;
    }
    res.status(401).json({ error: "未登录或 token 无效" });
  };
}
