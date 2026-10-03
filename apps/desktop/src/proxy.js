// ============================================================================
// proxy.js — the "bridge" between the desktop window and the main server.
//
//   /api/…   → forwarded to the server. If the server cannot be reached the
//              window gets a clear "offline" answer (the app then uses its
//              saved data and queues changes — see public/offline.js).
//   screens  → (HTML, JS, CSS, images) loaded from the server when online and
//              kept on disk; with no internet they come from that copy, or from
//              the copy bundled in the installer on the very first start.
//
// Pure Node (global fetch), so it can be tested without Electron.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const DROP_REQ = new Set(['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding', 'cookie']);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'strict-transport-security', 'content-security-policy']);

function createProxy({ upstream, cacheDir, seedDir, apiTimeoutMs = 30000, staticTimeoutMs = 4000, fetchImpl = fetch }) {
  const base = String(upstream || '').replace(/\/+$/, '');
  let forcedOffline = false; // test switch: pretend the internet is gone
  fs.mkdirSync(cacheDir, { recursive: true });
  const keyOf = (pq) => crypto.createHash('sha1').update(base + pq).digest('hex');
  const offlineJson = () => new Response(JSON.stringify({ error: 'The main server cannot be reached.', offline: true }), { status: 503, headers: { 'content-type': 'application/json', 'x-offline-proxy': '1' } });
  const offlinePage = () => new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>No internet connection</h2><p>This computer cannot reach the main server and the app has not been opened on it before. Connect to the internet once; after that the app also works offline.</p><button onclick="location.reload()">Try again</button>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'x-offline-proxy': '1' } });

  async function forward(request, pq) {
    const headers = {};
    request.headers.forEach((v, k) => { if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v; });
    const init = { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(apiTimeoutMs) };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = Buffer.from(await request.arrayBuffer());
    let r;
    if (forcedOffline) return offlineJson();
    try { r = await fetchImpl(base + pq, init); } catch (_) { return offlineJson(); }
    const out = {}; r.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) out[k] = v; });
    if (r.status >= 300 && r.status < 400) return offlineJson(); // an API never redirects; usually a captive portal / wrong address
    return new Response(r.status === 204 ? null : Buffer.from(await r.arrayBuffer()), { status: r.status, headers: out });
  }

  function readCache(pq) {
    try { const k = keyOf(pq); const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, k + '.json'), 'utf8')); return { meta, body: fs.readFileSync(path.join(cacheDir, k + '.bin')) }; } catch (_) { return null; }
  }
  function writeCache(pq, contentType, body) {
    try { const k = keyOf(pq); fs.writeFileSync(path.join(cacheDir, k + '.bin'), body); fs.writeFileSync(path.join(cacheDir, k + '.json'), JSON.stringify({ pq, contentType, at: Date.now() })); } catch (_) { /* cache is best-effort */ }
  }
  function readSeed(pathname) {
    if (!seedDir) return null;
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const p = path.resolve(seedDir, rel);
    if (!p.startsWith(path.resolve(seedDir) + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return { contentType: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', body: fs.readFileSync(p) };
  }
  const ok = (contentType, body, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': contentType, ...extra } });

  async function staticGet(request, pq, pathname) {
    const cached = readCache(pq);
    const timeout = cached || readSeed(pathname) ? staticTimeoutMs : 15000;  // already have a copy → don't make the user wait
    try {
      const r = await fetchImpl(base + pq, { signal: AbortSignal.timeout(timeout), redirect: 'follow', headers: { accept: request.headers.get('accept') || '*/*' } });
      if (r.ok) {
        const body = Buffer.from(await r.arrayBuffer()); const ct = r.headers.get('content-type') || MIME[path.extname(pathname).toLowerCase()] || 'application/octet-stream';
        writeCache(pq, ct, body); return ok(ct, body);
      }
      if (r.status === 404) return new Response('Not found', { status: 404 });
    } catch (_) { /* offline → fall through to the saved copy */ }
    if (cached) return ok(cached.meta.contentType, cached.body, { 'x-from-cache': '1' });
    const seed = readSeed(pathname);
    if (seed) return ok(seed.contentType, seed.body, { 'x-from-seed': '1' });
    return pathname === '/' || pathname.endsWith('.html') ? offlinePage() : new Response('Offline', { status: 503, headers: { 'x-offline-proxy': '1' } });
  }

  async function handle(request) {
    const url = new URL(request.url); const pq = url.pathname + url.search;
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return forward(request, pq);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return staticGet(request, pq, url.pathname);
  }
  function clearCache() { try { for (const f of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, f)); } catch (_) { /* ignore */ } }
  return { handle, clearCache, upstream: base, setForcedOffline: (v) => { forcedOffline = !!v; } };
}
module.exports = { createProxy };
