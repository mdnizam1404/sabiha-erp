// ============================================================================
// offline.js — offline mode for the office app (desktop app, browser, PWA)
//
//  * Every page you open is remembered on this computer, so it can be shown
//    again with no internet ("last known data").
//  * Changes you save while offline (sales, receipts, customers, expenses,
//    attendance, production, purchases, stock …) go into a queue on this
//    computer and are sent to the main server automatically, in order, as soon
//    as the connection is back. Each one carries a unique key, so a retry can
//    never create it twice.
//  * Things that must be decided by the server (users, settings, backups,
//    sign-in …) are not queued — the app says they need internet.
//  * If the server refuses a queued change (e.g. the customer was deleted),
//    it stays in the Sync Center with the reason, so nothing disappears quietly.
// Data lives in this browser/app's local database (IndexedDB) on this device.
// ============================================================================
(function () {
  'use strict';
  const DB_NAME = 'sabiha_offline', VER = 1;
  const QUEUE_OK = [/^\/sales(\/|$)/, /^\/receipts(\/|$)/, /^\/customers(\/|$)/, /^\/suppliers(\/|$)/, /^\/expenses(\/|$)/, /^\/attendance(\/|$)/, /^\/production(\/|$)/, /^\/purchases(\/|$)/, /^\/stock(\/|$)/, /^\/products(\/|$)/, /^\/raw-materials(\/|$)/, /^\/employees(\/|$)/, /^\/outsourcing(\/|$)/];
  const NEVER_CACHE = [/^\/auth\//, /^\/platform\//, /^\/backup/, /\/pdf(\/|$|\?)/, /\/export/, /^\/sync\//];
  const PREFETCH = ['/me', '/settings', '/customers', '/products', '/sales', '/receipts', '/employees', '/suppliers', '/raw-materials', '/production', '/purchases', '/stock', '/expenses', '/reports/dashboard'];
  const LABELS = [[/^\/sales/, 'Sales invoice'], [/^\/receipts/, 'Payment received'], [/^\/customers/, 'Customer'], [/^\/suppliers/, 'Supplier'], [/^\/expenses/, 'Expense'], [/^\/attendance/, 'Attendance'], [/^\/production/, 'Production entry'], [/^\/purchases/, 'Purchase'], [/^\/stock/, 'Stock'], [/^\/products/, 'Product'], [/^\/raw-materials/, 'Raw material'], [/^\/employees/, 'Employee'], [/^\/outsourcing/, 'Outsourcing']];
  const VERB = { POST: 'New', PUT: 'Change', PATCH: 'Change', DELETE: 'Delete' };

  let dbp = null;
  const open = () => dbp || (dbp = new Promise((ok, no) => {
    if (!window.indexedDB) return no(new Error('no indexedDB'));
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('cache', { keyPath: 'key' }); const q = d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }); q.createIndex('scope', 'scope'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((ok, no) => { const t = d.transaction(store, mode); const s = t.objectStore(store); let out; Promise.resolve(fn(s)).then((v) => { out = v; }); t.oncomplete = () => ok(out); t.onerror = () => no(t.error); t.onabort = () => no(t.error); }); };
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

  const OFF = {
    state: 'online', stale: false, pending: 0, failed: 0, syncing: false, paused: null,
    scope() { try { const p = JSON.parse(atob(String(window.TOKEN || localStorage.getItem('sabiha_token') || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return `${p.company_code}:${p.id}`; } catch (_) { return null; } },
    cacheable: (p) => !NEVER_CACHE.some((r) => r.test(p)),
    canQueue: (p) => QUEUE_OK.some((r) => r.test(p.split('?')[0])),
    label(method, path) { const l = LABELS.find(([r]) => r.test(path.split('?')[0])); return `${VERB[method] || method} · ${l ? l[1] : path}`; },
    newKey() { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); },

    async putCache(path, data) { const s = this.scope(); if (!s || !this.cacheable(path)) return; try { await tx('cache', 'readwrite', (st) => req(st.put({ key: `${s}|${path}`, at: Date.now(), data }))); } catch (_) { /* cache is best-effort */ } },
    async getCache(path) { const s = this.scope(); if (!s) return null; try { return await tx('cache', 'readonly', (st) => req(st.get(`${s}|${path}`))); } catch (_) { return null; } },
    async clearCache() { try { await tx('cache', 'readwrite', (st) => req(st.clear())); } catch (_) { /* ignore */ } },

    async enqueue(method, path, body) {
      const s = this.scope(); if (!s) throw new Error('Please sign in first.');
      const item = { scope: s, key: this.newKey(), method, path, body: body || null, label: this.label(method, path), created_at: new Date().toISOString(), attempts: 0, status: 'pending', error: null };
      await tx('queue', 'readwrite', (st) => req(st.add(item)));
      await this.refreshCounts(); return item;
    },
    async list() { const s = this.scope(); if (!s) return []; try { const all = await tx('queue', 'readonly', (st) => req(st.getAll())); return all.filter((x) => x.scope === s).sort((a, b) => a.id - b.id); } catch (_) { return []; } },
    async update(item) { await tx('queue', 'readwrite', (st) => req(st.put(item))); },
    async remove(id) { await tx('queue', 'readwrite', (st) => req(st.delete(id))); await this.refreshCounts(); },
    async refreshCounts() { const l = await this.list(); this.pending = l.filter((x) => x.status === 'pending').length; this.failed = l.filter((x) => x.status === 'failed').length; paint(); },

    setOnline(on) { const was = this.state; this.state = on ? 'online' : 'offline'; if (on) this.stale = false; paint(); if (on && was === 'offline') this.sync(); },
    isNetFail(err, res) { return err instanceof TypeError || (res && (res.headers.get('x-offline-proxy') || [502, 503, 504].includes(res.status))); },

    // Replay the queue in order. Stops at the first network problem; keeps refused items for the user to review.
    async sync() {
      if (this.syncing) return { sent: 0 }; const token = window.TOKEN || localStorage.getItem('sabiha_token'); if (!token || !this.scope()) return { sent: 0 };
      this.syncing = true; this.paused = null; paint(); let sent = 0;
      try {
        for (const it of await this.list()) {
          if (it.status !== 'pending') continue;
          let res, data = {};
          try {
            res = await fetch('/api' + it.path, { method: it.method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Idempotency-Key': it.key }, body: it.body ? JSON.stringify(it.body) : undefined });
            data = await res.json().catch(() => ({}));
          } catch (e) { this.state = 'offline'; break; }
          if (this.isNetFail(null, res)) { this.state = 'offline'; break; }
          this.state = 'online';
          if (res.ok) { await this.remove(it.id); sent++; continue; }
          if (res.status === 401) { this.paused = 'Please sign in again to finish syncing.'; break; }
          if (res.status === 403 && data.read_only) { this.paused = data.error; break; }
          if (res.status === 403 && data.must_change_password) { this.paused = 'Change your password to continue syncing.'; break; }
          if (res.status === 429 || res.status >= 500) { it.attempts++; if (it.attempts >= 6) { it.status = 'failed'; it.error = data.error || `Server error (${res.status})`; } await this.update(it); if (it.status === 'pending') break; continue; }
          it.status = 'failed'; it.error = data.error || `Rejected (${res.status})`; await this.update(it);
        }
      } finally { this.syncing = false; await this.refreshCounts(); }
      if (sent) { toast(`${sent} offline change${sent > 1 ? 's' : ''} synced with the main server`); window.dispatchEvent(new CustomEvent('offline-synced', { detail: { sent } })); this.prefetch(); }
      return { sent };
    },
    async prefetch() {
      const token = window.TOKEN || localStorage.getItem('sabiha_token'); if (!token || this.state === 'offline') return;
      for (const p of PREFETCH) { try { const r = await fetch('/api' + p, { headers: { Authorization: 'Bearer ' + token } }); if (r.ok) await this.putCache(p, await r.json()); else if (this.isNetFail(null, r)) break; } catch (_) { break; } }
    },
    async ping() { try { const r = await fetch('/api/version', { cache: 'no-store' }); const ok = r.ok && !r.headers.get('x-offline-proxy'); this.setOnline(ok); return ok; } catch (_) { this.setOnline(false); return false; } },
    async onLogout() { await this.clearCache(); },
    async lastUpdated(path) { const c = await this.getCache(path); return c ? c.at : null; },
  };

  // ---------------------------------------------------------------- UI --------
  let pill, panel;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(m) { if (typeof window.showToast === 'function') window.showToast(m); }
  function paint() {
    if (!pill) { pill = document.createElement('div'); pill.id = 'offlinePill'; pill.setAttribute('role', 'status'); pill.onclick = openPanel; document.body.appendChild(pill); }
    const offline = OFF.state === 'offline', n = OFF.pending, f = OFF.failed;
    let txt, cls;
    if (f) { txt = `⚠ ${f} change${f > 1 ? 's' : ''} need attention`; cls = 'bad'; }
    else if (OFF.paused) { txt = '⚠ Sign in again to sync'; cls = 'bad'; }
    else if (offline) { txt = `Offline — working from saved data${n ? ` · ${n} waiting to sync` : ''}`; cls = 'off'; }
    else if (OFF.syncing) { txt = 'Syncing…'; cls = 'sync'; }
    else if (n) { txt = `${n} change${n > 1 ? 's' : ''} waiting to sync`; cls = 'sync'; }
    else { pill.style.display = 'none'; return; }
    pill.style.display = ''; pill.className = cls; pill.textContent = txt;
  }
  async function openPanel() {
    const items = await OFF.list(); if (!panel) { panel = document.createElement('div'); panel.id = 'offlinePanel'; document.body.appendChild(panel); }
    const when = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    panel.innerHTML = `<div class="op-box"><div class="op-head"><b>Sync Center</b><button id="opClose">✕</button></div>
      <p class="op-sub">${OFF.state === 'offline' ? 'You are offline. Everything you save is kept on this computer and sent automatically when the connection returns.' : 'Connected to the main server.'}${OFF.paused ? `<br><b style="color:#b3261e">${esc(OFF.paused)}</b>` : ''}</p>
      <div class="op-list">${items.length ? items.map((i) => `<div class="op-item ${i.status}"><div><b>${esc(i.label)}</b><br><small>${when(i.created_at)}${i.status === 'failed' ? ' · <span class="bad">Not accepted</span>' : ' · waiting'}</small>${i.error ? `<div class="op-err">${esc(i.error)}</div>` : ''}</div>
        <div>${i.status === 'failed' ? `<button data-retry="${i.id}">Retry</button> ` : ''}<button data-drop="${i.id}">Discard</button></div></div>`).join('') : '<div class="op-empty">Nothing waiting — everything is synced.</div>'}</div>
      <div class="op-foot"><button id="opSync" class="primary">Sync now</button></div></div>`;
    panel.style.display = 'flex';
    panel.onclick = async (e) => {
      if (e.target === panel || e.target.id === 'opClose') { panel.style.display = 'none'; return; }
      if (e.target.id === 'opSync') { await OFF.ping(); await OFF.sync(); return openPanel(); }
      const r = e.target.dataset.retry, d = e.target.dataset.drop;
      if (r) { const it = items.find((x) => x.id == r); it.status = 'pending'; it.error = null; it.attempts = 0; await OFF.update(it); await OFF.refreshCounts(); await OFF.sync(); openPanel(); }
      if (d && confirm('Discard this saved change? It will NOT be sent to the server.')) { await OFF.remove(Number(d)); openPanel(); }
    };
  }
  const css = document.createElement('style');
  css.textContent = `#offlinePill{position:fixed;left:14px;bottom:14px;z-index:2500;padding:8px 14px;border-radius:999px;font:600 12.5px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);color:#fff}
  #offlinePill.off{background:#7a4a00}#offlinePill.sync{background:#2f5bea}#offlinePill.bad{background:#b3261e}
  #offlinePanel{position:fixed;inset:0;background:rgba(8,14,34,.55);display:none;align-items:center;justify-content:center;z-index:2600;padding:14px;font-family:system-ui,sans-serif}
  .op-box{background:#fff;color:#1b2333;border-radius:14px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;padding:18px}
  .op-head{display:flex;justify-content:space-between;align-items:center;font-size:17px}.op-head button{border:0;background:none;font-size:18px;cursor:pointer}
  .op-sub{font-size:13px;color:#566;margin:8px 0}.op-list{overflow:auto;flex:1;border-top:1px solid #e3e7ee}
  .op-item{display:flex;justify-content:space-between;gap:10px;padding:10px 2px;border-bottom:1px solid #eef1f6;font-size:13px}.op-item small{color:#667}.op-item .bad{color:#b3261e;font-weight:600}
  .op-err{margin-top:4px;color:#b3261e;font-size:12.5px}.op-empty{padding:26px;text-align:center;color:#667}
  .op-foot{padding-top:12px;text-align:right}.op-box button{border:1px solid #cfd6e4;background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}.op-box button.primary{background:#2f5bea;color:#fff;border-color:#2f5bea}`;
  document.head.appendChild(css);

  window.OFF = OFF;
  window.addEventListener('online', () => OFF.ping());
  window.addEventListener('offline', () => OFF.setOnline(false));
  setInterval(() => { if (OFF.state === 'offline' || OFF.pending) OFF.ping().then((ok) => ok && OFF.sync()); }, 20000);
  document.addEventListener('DOMContentLoaded', () => { OFF.refreshCounts(); if (OFF.scope()) { OFF.ping().then((ok) => { if (ok) { OFF.sync().then(() => OFF.prefetch()); } }); } });

  // Browser/PWA only: keep the app screens themselves available offline (the desktop app does this on its own).
  if (!window.SABIHA_DESKTOP && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
