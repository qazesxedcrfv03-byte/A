/* sw.js — Service Worker for PWA installability + safe static asset caching.
   Scope: project root (matches the SPA). Does NOT cache or intercept:
     - localStorage / biometric descriptors / face evidence images / student data
     - backend API requests (127.0.0.1:3030 evidence storage, 127.0.0.1:3031 attendance)
     - external CDN resources (face-api models from jsdelivr)
     - server-side scripts (attendance-service.js, storage-service.js, healthcheck.js)
   Only caches non-sensitive static shell assets: HTML, CSS, JS, manifest, icons.
   Cache-first for shell assets, network-first for everything else (including APIs).
   SECURITY: app.js contains runtime config but no biometric/personal data — it is
   safe to cache as static code. Sensitive runtime data (face descriptors, student
   records, attendance) lives in localStorage, never in the SW cache.
*/
const SW_VERSION = 'v1';
const CACHE_NAME = 'can-attendance-' + SW_VERSION;
const SKIP_CACHE = '/__skip_cache';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/style.css',
  '/app.js',
  '/scan.js',
  '/register.js',
  '/chatbot.js',
  '/class-model.js',
  '/keywords.js',
  '/leave.js',
  '/roster.js',
  '/perf-monitor.js',
  '/evidence.js',
  '/calibrate.js',
  '/can.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  '/icons/favicon.ico',
];

// Requests that must NEVER be served from cache (sensitive or dynamic).
function shouldBypassCache(url) {
  const u = String(url || '');
  if (!u || !u.startsWith('http')) return true;
  // Block non-HTTP schemes (blob, data, chrome-extension, etc.)
  if (u.startsWith('blob:') || u.startsWith('data:')) return true;
  // Backend API endpoints (local evidence storage + attendance service)
  if (u.includes('127.0.0.1:3030') || u.includes('127.0.0.1:3031') ||
      u.includes('localhost:3030') || u.includes('localhost:3031')) return true;
  try {
    if (/\/api\//.test(new URL(u, self.location).pathname)) return true;
  } catch (e) { return true; }
  // External CDNs (face-api models) — must always fetch from network
  try {
    if (u.startsWith('https://') && new URL(u).hostname !== self.location.hostname) return true;
  } catch (e) { return true; }
  // Explicitly excluded paths
  if (u.includes(SKIP_CACHE)) return true;
  return false;
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // Fault-tolerant: cache each asset individually so a single failure
            // (404, offline) does not prevent the SW from activating. Old version
            // stays live only if the whole install is rejected, not on per-asset errors.
            Promise.all(
                STATIC_ASSETS.map((asset) =>
                    cache.add(asset).catch((err) => {
                        console.warn('[SW] Failed to cache:', asset, err);
                    })
                )
            )
        )
    );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control immediately
      self.clients.claim(),
      // Remove old caches
      caches.keys().then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
            return null;
          })
        )
      ),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Always bypass cache for sensitive/dynamic/API requests
  if (shouldBypassCache(request.url)) {
    return; // Let the browser handle normally (network)
  }
  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Cache-first for pre-cached static shell assets — stale-while-update
  if (STATIC_ASSETS.some((asset) => url.pathname === asset || (asset === '/' && url.pathname === '/'))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request).then((resp) => {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, resp.clone()));
          }
          return resp;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Network-first for everything else (e.g. dynamic pages, fallback to index for SPA)
  event.respondWith(
    fetch(request).catch(() => caches.match('/index.html'))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
