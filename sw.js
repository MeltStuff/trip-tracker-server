// Trip 2026 — Service Worker
// Handles: (1) offline caching of the app shell, (2) receiving push
// notifications from the backend, (3) opening the app when a notification
// is tapped.

const CACHE_NAME = 'trip2026-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/site.webmanifest',
  '/icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];

// ---- Install: pre-cache the app shell ----
// Cache each file individually and tolerate failures, so one missing/404
// asset doesn't break the whole install (which would leave the service
// worker stuck and never activated).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('SW: skipping uncacheable asset', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// ---- Activate: clean up old caches ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ---- Fetch: cache-first for the app shell, network-first for everything
// else (falling back to cache when offline) ----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          // Stash a copy of successful same-origin responses for offline use
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached); // offline: fall back to whatever we have cached

      // Cache-first for instant loads, but still refresh in the background
      return cached || fetchPromise;
    })
  );
});

// ---- Push: show a notification when the backend sends one ----
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Trip 2026', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Trip 2026';
  const options = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.tag || 'trip2026-reminder',
    data: { url: data.url || '/', eventId: data.eventId || null },
    vibrate: [100, 50, 100]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---- Notification click: focus an open tab or open a new one ----
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
