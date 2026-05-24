// Kill-switch Service Worker
// 旧カード一覧UI用のSWを安全に廃止するため、自己登録解除して全キャッシュを破棄する
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (_) {}
    try {
      await self.registration.unregister();
    } catch (_) {}
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
  })());
});

self.addEventListener('fetch', (e) => {
  // パススルー（キャッシュは使わない）
  e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
});
