const CACHE_NAME = 'stock-monitor-v2'; // 버전 올릴 때마다 이 값을 바꾸면 이전 캐시가 자동 폐기됨
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // http/https가 아닌 요청(예: 다른 브라우저 확장프로그램이 만드는 chrome-extension:// 요청)은
  // Cache API가 지원하지 않으므로 건드리지 않고 브라우저 기본 동작에 맡김
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // 주가/실적 데이터는 항상 최신이어야 하므로 캐시하지 않고 네트워크로만 요청
  if (url.pathname.includes('/chart') || url.pathname.includes('/earnings')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // 앱 셸(HTML/CSS/JS)은 네트워크 우선 - 최신 배포본을 항상 먼저 시도하고,
  // 오프라인일 때만 캐시된 이전 버전으로 대체 (개발 중 자주 바뀌는 파일에 적합)
  event.respondWith(
    fetch(request)
      .then((networkRes) => {
        const resClone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, resClone));
        return networkRes;
      })
      .catch(() => caches.match(request))
  );
});
