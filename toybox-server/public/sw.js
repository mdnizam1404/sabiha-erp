// Keeps the app screens (HTML/JS/CSS/images) available with no internet. Data is handled by offline.js.
const V = 'sabiha-shell-v5.5.0';
const SHELL = ['/', '/index.html', '/app.js', '/offline.js', '/returns.js', '/plan.js', '/premium.js', '/style.css', '/fonts/fonts.css', '/fonts/inter-latin-400-normal.woff2', '/fonts/inter-latin-600-normal.woff2', '/fonts/poppins-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/platform')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
