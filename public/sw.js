/* Only public app assets are cached. IP responses and rendered visitor pages stay live. */
const CACHE_NAME = 'ipinfo-assets-__ASSET_VERSION__';
const ASSETS = ['/offline.html', '/brand/ipinfo.svg', '/favicon.ico', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ipinfo-assets-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Never substitute an offline HTML page for an API endpoint opened in a tab.
    if (url.pathname !== '/') return;
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match('/offline.html')) || Response.error();
    }));
    return;
  }

  if (!ASSETS.includes(url.pathname) || url.search) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match(request)) || fetch(request)));
});
