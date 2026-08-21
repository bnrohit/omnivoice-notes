const CACHE = 'omnivoice-v2-beta1';
const ASSETS = ['/', '/index.html', '/styles.css', '/app-shell.js', '/app-recording.js', '/app-library.js', '/app-utils.js', '/app-bootstrap.js', '/manifest.webmanifest', '/icons/icon.svg', '/live-capture-worklet.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => {
    const network = fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached || caches.match('/index.html'));
    return cached || network;
  }));
});
self.addEventListener('sync', event => {
  if (event.tag === 'omnivoice-sync') {
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => clients.forEach(c => c.postMessage({ type: 'BACKGROUND_SYNC' }))));
  }
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title = 'OmniVoice reminder', body = '' } = event.data;
    event.waitUntil(self.registration.showNotification(title, { body, icon: '/icons/icon.svg', badge: '/icons/icon.svg' }));
  }
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list[0]?.focus() || clients.openWindow('/')));
});
