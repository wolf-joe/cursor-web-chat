/* 决策·pwa-sw-passthrough: 仅为满足 Chrome 可安装条件注册 fetch handler;
 * 不做离线缓存——对话依赖 SSE / 实时 API,缓存易脏且无收益。 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
