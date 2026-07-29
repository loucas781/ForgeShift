'use strict'
const CACHE = 'forgeshift-v7'
const STATIC = [
  '/css/main.css',
  '/js/shell.js',
  '/js/theme-assets.js',
  '/js/prefs.js',
  '/icons/app-icon-light-1024.png',
  '/icons/app-icon-dark-1024.png',
  '/favicon.ico',
  '/favicon.png',
  '/manifest-light.json',
  '/manifest-dark.json'
]

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()))
)

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
)

self.addEventListener('fetch', e => {
  // Always network for API calls and SSE
  if (e.request.url.includes('/api/')) return
  const reqUrl = new URL(e.request.url)

  // Network-first for all document navigations so live HTML always wins.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE).then(c => c.put(e.request, clone))
          }
          return res
        })
        .catch(() => caches.match(e.request))
    )
    return
  }

  // Network-first for same-origin app code/assets so updates roll out quickly.
  const sameOrigin = reqUrl.origin === self.location.origin
  const networkFirstAsset =
    sameOrigin &&
    e.request.method === 'GET' &&
    (
      reqUrl.pathname.endsWith('.html') ||
      reqUrl.pathname.endsWith('.js') ||
      reqUrl.pathname.endsWith('.css') ||
      reqUrl.pathname.endsWith('.json')
    )
  if (networkFirstAsset) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE).then(c => c.put(e.request, clone))
          }
          return res
        })
        .catch(() => caches.match(e.request))
    )
    return
  }
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, clone))
      }
      return res
    }))
  )
})
