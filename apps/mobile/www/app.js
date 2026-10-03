// ============================================================================
// SABIHA Sales — offline-first sales app (Android / iOS via Capacitor, or any browser)
//
//  * Customers, products, rates and stock are downloaded to this phone.
//  * Invoices, payments and new customers are saved on the phone FIRST, so the
//    app works in a market with no signal.
//  * Whenever a connection appears (app opened, signal back, every minute while
//    open) the phone sends everything to the main server, in order, then
//    refreshes the customer / product data. Every item carries a unique ID, so
//    a retry can never create a duplicate.
//  * The server decides the official invoice number; until then the invoice
//    shows as "Waiting to sync".
// ============================================================================
(function () {
  'use strict';
  const $app = document.getElementById('app');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtDT = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  let toastT; const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { t.style.display = 'none'; }, 3200); };

  // ------------------------------------------------------------ local database
  const DB = 'sabiha_sales', STORES = { kv: 'k', customers: 'key', products: 'id', outbox: 'id', invoices: 'client_uuid', receipts: 'client_uuid' };
  let dbp;
  const open = () => dbp || (dbp = new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const [n, k] of Object.entries(STORES)) r.result.createObjectStore(n, n === 'outbox' ? { keyPath: k, autoIncrement: true } : { keyPath: k }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const run = async (store, mode, fn) => { const d = await open(); return new Promise((ok, no) => { const t = d.transaction(store, mode); let out; const rq = fn(t.objectStore(store)); if (rq && 'onsuccess' in rq) rq.onsuccess = () => { out = rq.result; }; t.oncomplete = () => ok(out); t.onerror = () => no(t.error); t.onabort = () => no(t.error); }); };
  const kvGet = async (k) => { const r = await run('kv', 'readonly', (s) => s.get(k)); return r ? r.v : undefined; };
  const kvSet = (k, v) => run('kv', 'readwrite', (s) => s.put({ k, v }));
  const all = (s) => run(s, 'readonly', (st) => st.getAll());
  const put = (s, v) => run(s, 'readwrite', (st) => st.put(v));
  const del = (s, k) => run(s, 'readwrite', (st) => st.delete(k));
  const clear = (s) => run(s, 'readwrite', (st) => st.clear());

  // ------------------------------------------------------------------- state
  const S = { server: '', token: '', user: null, company: null, deviceId: '', masterVersion: '', lastSync: null, lastMasterAt: null, customers: [], products: [], outbox: [], invoices: [], receipts: [], subscription: null, online: true, syncing: false, needLogin: false, paused: null, tab: 'home', view: null };

  async function loadState() {
    S.server = (await kvGet('server')) || (window.APP_CONFIG && window.APP_CONFIG.defaultServer) || '';
    S.token = (await kvGet('token')) || ''; S.user = (await kvGet('user')) || null; S.company = (await kvGet('company')) || null;
    S.deviceId = (await kvGet('deviceId')) || ''; S.masterVersion = (await kvGet('masterVersion')) || ''; S.lastSync = (await kvGet('lastSync')) || null; S.subscription = (await kvGet('subscription')) || null;
    await refreshLocal();
  }
  async function refreshLocal() {
    S.customers = (await all('customers')).sort((a, b) => a.name.localeCompare(b.name));
    S.products = (await all('products')).sort((a, b) => a.name.localeCompare(b.name));
    S.outbox = (await all('outbox')).sort((a, b) => a.id - b.id);
    S.invoices = (await all('invoices')).sort((a, b) => b.created_at.localeCompare(a.created_at));
    S.receipts = (await all('receipts')).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const pending = () => S.outbox.filter((e) => e.status === 'pending').length;
  const rejected = () => S.outbox.filter((e) => e.status === 'rejected').length;
  // stock shown = last downloaded stock minus what this phone already sold but has not yet synced
  const stockOf = (p) => r2((Number(p.stock) || 0) - S.invoices.filter((i) => i.status === 'pending').reduce((t, i) => t + i.items.filter((l) => l.product_id === p.id).reduce((a, l) => a + l.qty, 0), 0));
  // what the customer owes = server balance + unsynced invoices − unsynced receipts
  const owesOf = (c) => r2((Number(c.outstanding) || 0) + S.invoices.filter((i) => i.status === 'pending' && sameCust(i, c)).reduce((t, i) => t + i.grand_total, 0) - S.receipts.filter((r) => r.status === 'pending' && sameCust(r, c)).reduce((t, r) => t + r.amount, 0));
  const sameCust = (x, c) => (x.customer_id && x.customer_id === c.id) || (x.customer_client_id && x.customer_client_id === c.client_uuid);

  // ------------------------------------------------------------------ network
  async function http(method, path, body, extra = {}) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), extra.timeout || 25000);
    try {
      const r = await fetch(S.server + '/api' + path, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}), ...(S.deviceId ? { 'X-Device-Id': S.deviceId } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json().catch(() => ({}));
      if (r.status === 502 || r.status === 503 || r.status === 504) { const e = new Error('Server unavailable'); e.net = true; throw e; }
      S.online = true; return { status: r.status, ok: r.ok, data: d };
    } catch (e) { if (e.net || e.name === 'AbortError' || e instanceof TypeError) { S.online = false; const n = new Error('No connection'); n.net = true; throw n; } throw e; } finally { clearTimeout(to); }
  }

  // --------------------------------------------------------------------- sync
  async function syncNow(manual) {
    if (S.syncing || !S.token || !S.server) return;
    S.syncing = true; S.paused = null; paintStatus();
    try {
      await ensureDevice();
      // 1) send what was saved on this phone, in the order it was saved
      let sentAny = false;
      for (;;) {
        await refreshLocal(); const batch = S.outbox.filter((e) => e.status === 'pending').slice(0, 40); if (!batch.length) break;
        const res = await http('POST', '/sync/push', { events: batch.map((e) => ({ event_id: e.event_id, entity_type: e.entity_type, operation: 'CREATE', entity_client_id: e.entity_client_id, client_created_at: e.created_at, payload: e.payload })) });
        if (res.status === 401) { S.needLogin = true; S.paused = 'Sign in again to finish syncing. Nothing is lost.'; break; }
        if (res.status === 403) { S.paused = res.data.error || 'The server refused the sync.'; break; }
        if (!res.ok) { S.paused = res.data.error || 'Sync failed — will retry.'; break; }
        for (const r of res.data.results || []) await applyResult(r);
        sentAny = true;
        if (batch.length < 40) break;
      }
      // 2) refresh customers / products / stock
      if (!S.paused) await pullMaster();
      S.lastSync = new Date().toISOString(); await kvSet('lastSync', S.lastSync);
      if (manual) toast(S.paused ? S.paused : pending() ? 'Some items are still waiting' : 'Everything is synced ✓');
    } catch (e) { if (!e.net) { console.error(e); if (manual) toast('Sync problem: ' + e.message); } else if (manual) toast('No connection — your work is saved on this phone'); }
    finally { S.syncing = false; await refreshLocal(); paintStatus(); render(); }
  }
  async function applyResult(r) {
    const ev = S.outbox.find((e) => e.event_id === r.event_id); if (!ev) return;
    if (r.status === 'applied' || r.status === 'duplicate') {
      if (ev.entity_type === 'SALES_INVOICE') { const i = S.invoices.find((x) => x.client_uuid === ev.entity_client_id); if (i) { i.status = 'synced'; i.invoice_no = r.invoice_no; i.server_id = r.entity_id; i.error = null; await put('invoices', i); } }
      if (ev.entity_type === 'RECEIPT') { const x = S.receipts.find((y) => y.client_uuid === ev.entity_client_id); if (x) { x.status = 'synced'; x.receipt_no = r.receipt_no; x.error = null; await put('receipts', x); } }
      if (ev.entity_type === 'CUSTOMER') { const c = S.customers.find((y) => y.client_uuid === ev.entity_client_id); if (c) { c.id = r.entity_id; c.code = r.code; c.pending = false; await put('customers', c); } }
      await del('outbox', ev.id);
    } else {
      ev.status = 'rejected'; ev.error = r.error || 'Rejected by the server'; await put('outbox', ev);
      if (ev.entity_type === 'SALES_INVOICE') { const i = S.invoices.find((x) => x.client_uuid === ev.entity_client_id); if (i) { i.status = 'rejected'; i.error = ev.error; await put('invoices', i); } }
      if (ev.entity_type === 'RECEIPT') { const x = S.receipts.find((y) => y.client_uuid === ev.entity_client_id); if (x) { x.status = 'rejected'; x.error = ev.error; await put('receipts', x); } }
    }
    await refreshLocal();
  }
  async function pullMaster() {
    const res = await http('GET', '/sync/master' + (S.masterVersion ? '?version=' + encodeURIComponent(S.masterVersion) : ''));
    if (res.status === 401) { S.needLogin = true; S.paused = 'Sign in again to finish syncing. Nothing is lost.'; return; }
    if (!res.ok) { S.paused = res.data.error || null; return; }
    const m = res.data; S.subscription = m.subscription || null; await kvSet('subscription', S.subscription);
    if (m.subscription && m.subscription.read_only) S.paused = m.subscription.notice || 'The company account is read-only, so new items cannot be sent.';
    if (m.unchanged) { S.lastMasterAt = new Date().toISOString(); return; }
    const keepPending = (await all('customers')).filter((c) => c.pending);
    await clear('customers'); await clear('products');
    for (const c of m.customers) await put('customers', { ...c, key: 'c' + c.id, pending: false });
    for (const c of keepPending) if (!m.customers.some((x) => x.client_uuid === c.client_uuid)) await put('customers', c);
    for (const p of m.products) await put('products', p);
    S.masterVersion = m.version; await kvSet('masterVersion', m.version); await kvSet('company', m.company); S.company = m.company; S.lastMasterAt = m.generated_at;
  }
  async function ensureDevice() {
    if (!S.deviceId) { S.deviceId = uuid(); await kvSet('deviceId', S.deviceId); }
    if (await kvGet('deviceRegistered') === S.user?.id + '@' + S.server) return;
    const r = await http('POST', '/sync/register-device', { device_id: S.deviceId, device_name: (navigator.userAgent.match(/\(([^)]+)\)/) || [, 'Phone'])[1].slice(0, 60), platform: /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'web', app_version: '5.5.0' });
    if (r.ok) await kvSet('deviceRegistered', S.user?.id + '@' + S.server); else throw new Error(r.data.error || 'Could not register this phone');
  }
  async function queue(entity_type, entity_client_id, payload) { await put('outbox', { event_id: uuid(), entity_type, entity_client_id, payload, status: 'pending', created_at: new Date().toISOString(), error: null }); await refreshLocal(); setTimeout(() => syncNow(false), 300); }

  // ------------------------------------------------------------------ account
  async function login(f) {
    const server = f.server.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(server)) throw new Error('Enter the server address starting with https://');
    S.server = server; await kvSet('server', server);
    const body = { company_code: f.company.trim().toUpperCase(), username: f.user.trim(), password: f.pass };
    const r = await http('POST', '/auth/login', body);
    if (r.status === 200 && r.data.otp_required) return { otp: r.data, body };
    if (!r.ok) throw new Error(r.data.error || 'Sign in failed');
    return finishLogin(r.data, body.company_code);
  }
  async function finishLogin(d, company) {
    if (pending() && S.user && d.user && S.user.id !== d.user.id) throw new Error('This phone still has unsent items from another user. Ask that user to sign in and sync first.');
    S.token = d.token; S.user = d.user; S.needLogin = false; S.paused = null;
    await kvSet('token', S.token); await kvSet('user', S.user); await kvSet('companyCode', company);
    if (d.user && d.user.must_change_password) return { mustChange: true };
    return { ok: true };
  }
  async function logout() {
    if (pending() && !confirm(`${pending()} item(s) are not synced yet. If you sign out they stay on this phone and are sent after you sign in again. Sign out?`)) return;
    S.token = ''; S.needLogin = false; await kvSet('token', ''); render();
  }

  // ------------------------------------------------------------------- views
  function paintStatus() { const p = document.getElementById('pill'); if (p) { const [t, c] = statusText(); p.textContent = t; p.className = 'pill ' + c; } }
  function statusText() {
    if (rejected()) return [`⚠ ${rejected()} need attention`, 'bad'];
    if (S.needLogin) return ['Sign in to sync', 'bad'];
    if (S.syncing) return ['Syncing…', 'sync'];
    if (S.paused) return ['⚠ Sync paused', 'bad'];
    if (!S.online) return [`Offline${pending() ? ' · ' + pending() + ' waiting' : ''}`, 'off'];
    if (pending()) return [`${pending()} waiting`, 'sync'];
    return ['Synced ✓', ''];
  }
  const top = (title, back) => `<div class="top">${back ? '<button data-act="back">‹</button>' : ''}<h1>${esc(title)}</h1><span id="pill" class="pill ${statusText()[1]}" data-act="goto" data-tab="sync">${esc(statusText()[0])}</span></div>`;
  const nav = () => `<div class="nav">${[['home', '🏠', 'Home'], ['sale', '🧾', 'Sale'], ['customers', '👥', 'Customers'], ['invoices', '📄', 'Invoices'], ['sync', '🔄', 'Sync']].map(([k, i, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="goto" data-tab="${k}"><span>${i}</span>${l}</button>`).join('')}</div>`;

  function render() {
    if (!S.token) return renderLogin();
    S.view = S.view || null;
    const v = { home: vHome, sale: vSale, customers: vCustomers, invoices: vInvoices, sync: vSync, collect: vCollect, customer: vCustomer, settings: vSettings, invoice: vInvoice }[S.tab] || vHome;
    $app.innerHTML = v(); bindAfterRender();
  }
  function renderLogin(msg, otp) {
    $app.innerHTML = `<div class="login"><h1>SABIHA Sales</h1><p class="mut">Sign in once while you have internet. After that the app works with no network.</p>
      ${otp ? `<div class="card"><b>Enter the SMS code</b><p class="mut">${esc(otp.data.message || '')}</p><input id="lo_code" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button class="btn" data-act="verifyotp">Verify</button></div>` : `
      <label>Server address</label><input id="lg_server" value="${esc(S.server)}" placeholder="https://erp.yourcompany.com" autocapitalize="off" autocorrect="off">
      <label>Company ID</label><input id="lg_company" value="${esc((S.company && S.company.code) || '')}" autocapitalize="characters" placeholder="e.g. LOTUS">
      <label>User ID</label><input id="lg_user" value="${esc(S.user ? S.user.username : '')}" autocapitalize="off" autocorrect="off">
      <label>Password</label><input id="lg_pass" type="password">
      <button class="btn" data-act="login">Sign in</button>`}
      <div class="err" id="lg_err">${esc(msg || '')}</div>${pending() ? `<div class="warn">${pending()} item(s) saved on this phone are waiting to be sent. They will sync after you sign in.</div>` : ''}</div>`;
    S.otp = otp || null; bindAfterRender();
  }
  function vHome() {
    const mine = S.invoices.filter((i) => i.date === today()); const total = mine.reduce((t, i) => t + i.grand_total, 0);
    const coll = S.receipts.filter((r) => r.date === today()).reduce((t, r) => t + r.amount, 0);
    return `${top('Hello, ' + (S.user.full_name || S.user.username).split(' ')[0])}<div class="main">
      ${S.subscription && S.subscription.read_only ? `<div class="warn" style="margin-bottom:12px">${esc(S.subscription.notice || 'Account is read-only: new items cannot be sent.')}</div>` : ''}
      ${S.paused ? `<div class="warn" style="margin-bottom:12px">${esc(S.paused)}</div>` : ''}
      <div class="card"><div class="mut">Today (this phone)</div><div class="big">${inr(total)}</div><div class="mut">${mine.length} invoice(s) · ${inr(coll)} collected</div></div>
      <div class="grid"><div class="tile primary" data-act="goto" data-tab="sale"><span>🧾</span>New Sale</div><div class="tile" data-act="goto" data-tab="collect"><span>💰</span>Collect Payment</div>
      <div class="tile" data-act="goto" data-tab="customers"><span>👥</span>Customers</div><div class="tile" data-act="goto" data-tab="invoices"><span>📄</span>My Invoices</div></div>
      <div class="card" style="margin-top:12px"><div class="mut">Data on this phone</div><div>${S.customers.length} customers · ${S.products.length} products</div><div class="mut">Last synced: ${S.lastSync ? fmtDT(S.lastSync) : 'never'}</div></div></div>${nav()}`;
  }
  // --- new sale
  let draft = null;
  const newDraft = (cust) => ({ client_uuid: uuid(), customer: cust || null, items: [], discount_pct: 0, gst_pct: null, date: today() });
  const draftTotals = (d) => { const sub = r2(d.items.reduce((t, l) => t + l.qty * l.rate * (1 - (l.discount_pct || 0) / 100), 0)); const after = sub * (1 - (d.discount_pct || 0) / 100); const gstPct = d.gst_pct == null ? defaultGst(d) : d.gst_pct; const gst = r2(after * gstPct / 100); return { sub, after: r2(after), gstPct, gst, grand: r2(after + gst) }; };
  const defaultGst = (d) => d.items.length ? Math.max(...d.items.map((l) => l.gst_rate || 0)) : 0;
  function vSale() {
    if (!draft) draft = newDraft(); const t = draftTotals(draft); const c = draft.customer;
    const over = c && c.credit_limit > 0 && owesOf(c) + t.grand > c.credit_limit;
    return `${top('New Sale')}<div class="main">
      <div class="card"><div class="mut">Customer</div>${c ? `<div class="row" style="border:0"><div class="l"><b>${esc(c.name)}</b><span class="mut">Owes ${inr(owesOf(c))}${c.pending ? ' · new, not synced' : ''}</span></div><button class="btn sm sec" data-act="pickcust">Change</button></div>` : '<button class="btn sec" data-act="pickcust">Choose customer</button>'}
        ${over ? `<div class="warn">This sale takes ${esc(c.name)} over the credit limit of ${inr(c.credit_limit)}.</div>` : ''}</div>
      <div class="card"><div class="mut" style="display:flex;justify-content:space-between">Items <span>${draft.items.length}</span></div>
        ${draft.items.map((l, i) => `<div class="line"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(l.name)}</b><button class="btn sm sec" data-act="rmline" data-i="${i}">✕</button></div>
          <div style="display:flex;gap:8px;margin-top:6px"><div style="flex:1"><label style="margin-top:0">Qty</label><input class="qty" style="width:100%" inputmode="decimal" data-line="${i}" data-f="qty" value="${l.qty}"></div><div style="flex:1"><label style="margin-top:0">Rate</label><input style="width:100%;padding:8px" inputmode="decimal" data-line="${i}" data-f="rate" value="${l.rate}"></div><div style="flex:1"><label style="margin-top:0">Disc %</label><input style="width:100%;padding:8px" inputmode="decimal" data-line="${i}" data-f="discount_pct" value="${l.discount_pct || 0}"></div></div>
          <div class="mut" style="margin-top:4px">Stock ${l.stock_now} · line ${inr(l.qty * l.rate * (1 - (l.discount_pct || 0) / 100))}${l.qty > l.stock_now ? ' <span style="color:var(--amber)">· more than stock</span>' : ''}</div></div>`).join('')}
        <button class="btn sec" data-act="addprod">＋ Add product</button></div>
      <div class="card"><div class="tot"><span>Subtotal</span><span>${inr(t.sub)}</span></div>
        <div class="tot"><span>Discount %</span><input style="width:90px;padding:6px;text-align:right" inputmode="decimal" id="sd_disc" value="${draft.discount_pct || 0}"></div>
        <div class="tot"><span>GST %</span><input style="width:90px;padding:6px;text-align:right" inputmode="decimal" id="sd_gst" value="${t.gstPct}"></div>
        <div class="tot"><span>GST amount</span><span>${inr(t.gst)}</span></div><div class="tot g"><span>Total</span><span>${inr(t.grand)}</span></div></div>
      <div class="err" id="sale_err"></div><button class="btn" data-act="savesale">Save invoice</button>${draft.items.length || draft.customer ? '<button class="btn sec" data-act="cancelsale">Cancel this sale</button>' : ''}</div>${nav()}`;
  }
  function pickSheet(kind, filter = '') {
    const list = kind === 'cust' ? S.customers.filter((c) => (c.name + ' ' + (c.phone || '') + ' ' + (c.code || '')).toLowerCase().includes(filter.toLowerCase())) : S.products.filter((p) => (p.name + ' ' + (p.sku || '')).toLowerCase().includes(filter.toLowerCase()));
    const html = `<div class="sheet" data-act="closesheet"><div><div class="search"><input id="sh_q" placeholder="Search…" value="${esc(filter)}" autofocus></div>
      ${kind === 'cust' ? '<button class="btn sec" data-act="newcust" style="margin:0 0 6px">＋ New customer</button>' : ''}
      ${list.slice(0, 80).map((x) => kind === 'cust' ? `<div class="row" data-act="choosecust" data-k="${esc(x.key)}"><div class="l"><b>${esc(x.name)}</b><span class="mut">${esc(x.phone || '')}</span></div><span class="mut">${inr(owesOf(x))}</span></div>`
        : `<div class="row" data-act="chooseprod" data-id="${x.id}"><div class="l"><b>${esc(x.name)}</b><span class="mut">${esc(x.sku || '')} · stock ${stockOf(x)}</span></div><b>${inr(x.sale_rate)}</b></div>`).join('') || '<div class="mut" style="padding:20px;text-align:center">Nothing found</div>'}</div></div>`;
    let host = document.getElementById('sheetHost'); if (!host) { host = document.createElement('div'); host.id = 'sheetHost'; document.body.appendChild(host); }
    host.innerHTML = html; host.dataset.kind = kind; const q = document.getElementById('sh_q'); q.focus(); q.setSelectionRange(filter.length, filter.length);
  }
  const closeSheet = () => { const h = document.getElementById('sheetHost'); if (h) h.innerHTML = ''; };
  function newCustSheet() {
    const host = document.getElementById('sheetHost');
    host.innerHTML = `<div class="sheet" data-act="closesheet"><div><b>New customer</b><p class="mut">Saved on this phone now; added to the company after sync.</p>
      <label>Name *</label><input id="nc_name"><label>Phone</label><input id="nc_phone" inputmode="tel"><label>Address / area</label><input id="nc_addr"><label>GST No (optional)</label><input id="nc_gst" autocapitalize="characters">
      <div class="err" id="nc_err"></div><button class="btn" data-act="savecust">Save customer</button></div></div>`;
  }
  async function saveCust() {
    const name = document.getElementById('nc_name').value.trim(); if (name.length < 2) { document.getElementById('nc_err').textContent = 'Enter the customer name.'; return null; }
    const u = uuid(); const c = { key: 'u' + u, id: null, client_uuid: u, code: null, name, phone: document.getElementById('nc_phone').value.trim(), address: document.getElementById('nc_addr').value.trim(), gst_no: document.getElementById('nc_gst').value.trim(), credit_limit: 0, outstanding: 0, payment_terms_days: 30, pending: true };
    await put('customers', c); await queue('CUSTOMER', u, { client_uuid: u, name: c.name, phone: c.phone, address: c.address, gst_no: c.gst_no }); return c;
  }
  async function saveSale() {
    const d = draft, err = document.getElementById('sale_err'); err.textContent = '';
    if (!d.customer) { err.textContent = 'Choose a customer first.'; return; }
    if (!d.items.length) { err.textContent = 'Add at least one product.'; return; }
    if (d.items.some((l) => !(l.qty > 0) || l.rate < 0)) { err.textContent = 'Check the quantity and rate of every item.'; return; }
    const t = draftTotals(d); const c = d.customer;
    const inv = { client_uuid: d.client_uuid, status: 'pending', created_at: new Date().toISOString(), date: d.date, customer_id: c.id, customer_client_id: c.client_uuid, customer_name: c.name, items: d.items.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct || 0 })), discount_pct: d.discount_pct || 0, gst_pct: t.gstPct, subtotal: t.after, gst_amt: t.gst, grand_total: t.grand, invoice_no: null };
    await put('invoices', inv);
    await queue('SALES_INVOICE', inv.client_uuid, { client_uuid: inv.client_uuid, customer_id: c.id || undefined, customer_client_id: c.client_uuid || undefined, invoice_date: inv.date, discount_pct: inv.discount_pct, gst_pct: inv.gst_pct, gst_type: 'CGST_SGST', items: inv.items.map((l) => ({ product_id: l.product_id, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct })) });
    draft = null; S.tab = 'invoice'; S.view = inv.client_uuid; toast(S.online ? 'Invoice saved' : 'Saved on this phone — will sync when online'); render();
  }
  // --- collect payment
  let rdraft = null;
  function vCollect() {
    if (!rdraft) rdraft = { customer: null, amount: '', mode: 'Cash', ref: '', invoice: '' };
    const c = rdraft.customer; const invs = c ? S.invoices.filter((i) => i.status !== 'rejected' && sameCust(i, c)) : [];
    return `${top('Collect Payment', true)}<div class="main"><div class="card"><div class="mut">Customer</div>${c ? `<div class="row" style="border:0"><div class="l"><b>${esc(c.name)}</b><span class="mut">Owes ${inr(owesOf(c))}</span></div><button class="btn sm sec" data-act="pickcust">Change</button></div>` : '<button class="btn sec" data-act="pickcust">Choose customer</button>'}</div>
      <div class="card"><label style="margin-top:0">Amount received</label><input id="rc_amt" inputmode="decimal" value="${esc(rdraft.amount)}">
        <label>Mode</label><select id="rc_mode">${['Cash', 'UPI', 'Cheque', 'Bank Transfer', 'Card'].map((m) => `<option ${rdraft.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <label>Reference (UPI / cheque no.)</label><input id="rc_ref" value="${esc(rdraft.ref)}">
        ${invs.length ? `<label>Against invoice (optional)</label><select id="rc_inv"><option value="">— On account —</option>${invs.map((i) => `<option value="${i.client_uuid}" ${rdraft.invoice === i.client_uuid ? 'selected' : ''}>${esc(i.invoice_no || 'Waiting to sync')} · ${inr(i.grand_total)}</option>`).join('')}</select>` : ''}</div>
      <div class="err" id="rc_err"></div><button class="btn" data-act="saverc">Save payment</button></div>${nav()}`;
  }
  async function saveReceipt() {
    const err = document.getElementById('rc_err'); const c = rdraft.customer; const amt = Number(document.getElementById('rc_amt').value);
    if (!c) { err.textContent = 'Choose a customer.'; return; } if (!(amt > 0)) { err.textContent = 'Enter the amount received.'; return; }
    const invUuid = (document.getElementById('rc_inv') || {}).value || ''; const inv = invUuid ? S.invoices.find((i) => i.client_uuid === invUuid) : null;
    const rc = { client_uuid: uuid(), status: 'pending', created_at: new Date().toISOString(), date: today(), customer_id: c.id, customer_client_id: c.client_uuid, customer_name: c.name, amount: amt, mode: document.getElementById('rc_mode').value, reference_no: document.getElementById('rc_ref').value.trim(), receipt_no: null };
    await put('receipts', rc);
    await queue('RECEIPT', rc.client_uuid, { client_uuid: rc.client_uuid, customer_id: c.id || undefined, customer_client_id: c.client_uuid || undefined, invoice_id: inv && inv.server_id || undefined, invoice_client_id: inv ? inv.client_uuid : undefined, amount: amt, mode: rc.mode, reference_no: rc.reference_no, date: rc.date });
    rdraft = null; S.tab = 'home'; toast(S.online ? 'Payment saved' : 'Saved on this phone — will sync when online'); render();
  }
  // --- lists
  function vCustomers() {
    return `${top('Customers')}<div class="main"><input id="cu_q" placeholder="Search customers…" value="${esc(S.q || '')}"><div class="card" style="margin-top:10px">${(S.customers.filter((c) => (c.name + (c.phone || '')).toLowerCase().includes((S.q || '').toLowerCase())).slice(0, 100).map((c) => `<div class="row" data-act="opencust" data-k="${esc(c.key)}"><div class="l"><b>${esc(c.name)}</b><span class="mut">${esc(c.phone || '')}${c.pending ? ' · not synced' : ''}</span></div><span class="${owesOf(c) > 0 ? '' : 'mut'}">${inr(owesOf(c))}</span></div>`).join('')) || '<div class="mut">No customers</div>'}</div><button class="btn" data-act="newcust2">＋ New customer</button></div>${nav()}`;
  }
  function vCustomer() {
    const c = S.customers.find((x) => x.key === S.view); if (!c) return vCustomers();
    const invs = S.invoices.filter((i) => sameCust(i, c));
    return `${top(c.name, true)}<div class="main"><div class="card"><div class="mut">Outstanding</div><div class="big">${inr(owesOf(c))}</div><div class="mut">${esc(c.address || '')}${c.credit_limit ? ' · limit ' + inr(c.credit_limit) : ''}</div>${c.phone ? `<a class="btn sec" style="text-decoration:none;text-align:center" href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a>` : ''}</div>
      <div class="grid"><button class="btn" data-act="salefor" data-k="${esc(c.key)}">New sale</button><button class="btn sec" data-act="collectfor" data-k="${esc(c.key)}">Collect</button></div>
      <div class="card" style="margin-top:12px"><b>Invoices made on this phone</b>${invs.map((i) => invRow(i)).join('') || '<div class="mut">None yet</div>'}</div></div>${nav()}`;
  }
  const invBadge = (i) => i.status === 'synced' ? '<span class="badge ok">Synced</span>' : i.status === 'rejected' ? '<span class="badge bad">Not accepted</span>' : '<span class="badge wait">Waiting to sync</span>';
  const invRow = (i) => `<div class="row" data-act="openinv" data-u="${i.client_uuid}"><div class="l"><b>${esc(i.invoice_no || 'New invoice')} · ${esc(i.customer_name)}</b><span class="mut">${esc(i.date)}</span></div><div style="text-align:right"><b>${inr(i.grand_total)}</b><br>${invBadge(i)}</div></div>`;
  function vInvoices() {
    return `${top('My Invoices')}<div class="main"><div class="card">${S.invoices.map(invRow).join('') || '<div class="mut">No invoices made on this phone yet</div>'}</div>${S.receipts.length ? `<div class="card"><b>Payments collected</b>${S.receipts.slice(0, 30).map((r) => `<div class="row"><div class="l"><b>${esc(r.customer_name)}</b><span class="mut">${esc(r.date)} · ${esc(r.mode)}${r.receipt_no ? ' · ' + esc(r.receipt_no) : ''}</span></div><div style="text-align:right"><b>${inr(r.amount)}</b><br><span class="badge ${r.status === 'synced' ? 'ok' : r.status === 'rejected' ? 'bad' : 'wait'}">${r.status === 'synced' ? 'Synced' : r.status === 'rejected' ? 'Not accepted' : 'Waiting'}</span></div></div>`).join('')}</div>` : ''}</div>${nav()}`;
  }
  function vInvoice() {
    const i = S.invoices.find((x) => x.client_uuid === S.view); if (!i) return vInvoices();
    return `${top(i.invoice_no || 'Invoice', true)}<div class="main"><div class="card"><div style="display:flex;justify-content:space-between"><b>${esc(i.customer_name)}</b>${invBadge(i)}</div><div class="mut">${esc(i.date)}${i.invoice_no ? '' : ' · official number is given after sync'}</div>
      ${i.items.map((l) => `<div class="row"><div class="l"><b>${esc(l.name)}</b><span class="mut">${l.qty} × ${inr(l.rate)}${l.discount_pct ? ' − ' + l.discount_pct + '%' : ''}</span></div><b>${inr(l.qty * l.rate * (1 - (l.discount_pct || 0) / 100))}</b></div>`).join('')}
      <div class="tot"><span>GST ${i.gst_pct}%</span><span>${inr(i.gst_amt)}</span></div><div class="tot g"><span>Total</span><span>${inr(i.grand_total)}</span></div>${i.error ? `<div class="err">${esc(i.error)}</div>` : ''}</div>
      <button class="btn" data-act="shareinv" data-u="${i.client_uuid}">Share</button><button class="btn sec" data-act="collectinv" data-u="${i.client_uuid}">Collect payment for this</button></div>${nav()}`;
  }
  function vSync() {
    const [t] = statusText();
    return `${top('Sync')}<div class="main"><div class="card"><div class="big">${esc(t)}</div><div class="mut">Last synced: ${S.lastSync ? fmtDT(S.lastSync) : 'never'}</div>${S.paused ? `<div class="warn">${esc(S.paused)}</div>` : ''}
      <button class="btn" data-act="syncnow" ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing…' : 'Sync now'}</button>${S.needLogin ? '<button class="btn sec" data-act="relogin">Sign in again</button>' : ''}</div>
      <div class="card"><b>Waiting to be sent (${S.outbox.length})</b>${S.outbox.map((e) => `<div class="row"><div class="l"><b>${esc({ SALES_INVOICE: 'Invoice', RECEIPT: 'Payment', CUSTOMER: 'New customer' }[e.entity_type] || e.entity_type)} · ${esc((e.payload.name || '') || '')}</b><span class="mut">${fmtDT(e.created_at)}</span>${e.error ? `<div class="err">${esc(e.error)}</div>` : ''}</div><div>${e.status === 'rejected' ? `<button class="btn sm sec" data-act="retryev" data-id="${e.id}">Retry</button> <button class="btn sm red" data-act="dropev" data-id="${e.id}">Discard</button>` : '<span class="badge wait">Waiting</span>'}</div></div>`).join('') || '<div class="mut">Nothing waiting — all synced.</div>'}</div>
      <div class="card"><div class="mut">Account</div><div>${esc(S.user.full_name || S.user.username)} · ${esc(S.company ? (S.company.name || '') : '')}</div><div class="mut" style="word-break:break-all">${esc(S.server)}</div><button class="btn sec" data-act="logout">Sign out</button></div></div>${nav()}`;
  }
  const vSettings = vSync;

  // --------------------------------------------------------------- interaction
  function bindAfterRender() {
    const q = document.getElementById('cu_q'); if (q) q.oninput = () => { S.q = q.value; const pos = q.selectionStart; render(); const n = document.getElementById('cu_q'); n.focus(); n.setSelectionRange(pos, pos); };
    for (const el of document.querySelectorAll('[data-line]')) el.onchange = () => { const l = draft.items[+el.dataset.line]; l[el.dataset.f] = Number(el.value) || 0; render(); };
    const dd = document.getElementById('sd_disc'); if (dd) dd.onchange = () => { draft.discount_pct = Number(dd.value) || 0; render(); };
    const dg = document.getElementById('sd_gst'); if (dg) dg.onchange = () => { draft.gst_pct = Number(dg.value) || 0; render(); };
    const ra = document.getElementById('rc_amt'); if (ra) { ra.oninput = () => { rdraft.amount = ra.value; }; document.getElementById('rc_mode').onchange = (e) => { rdraft.mode = e.target.value; }; document.getElementById('rc_ref').oninput = (e) => { rdraft.ref = e.target.value; }; const ri = document.getElementById('rc_inv'); if (ri) ri.onchange = (e) => { rdraft.invoice = e.target.value; }; }
  }
  document.addEventListener('input', (e) => { if (e.target.id === 'sh_q') { const kind = document.getElementById('sheetHost').dataset.kind; pickSheet(kind, e.target.value); } });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]'); if (!t) return; const a = t.dataset.act;
    if (a === 'closesheet') { if (e.target === t) closeSheet(); return; }
    try {
      if (a === 'goto') { S.tab = t.dataset.tab; S.view = null; if (S.tab === 'sale' && !draft) draft = newDraft(); render(); }
      else if (a === 'back') { S.tab = S.tab === 'invoice' ? 'invoices' : S.tab === 'customer' ? 'customers' : 'home'; S.view = null; render(); }
      else if (a === 'login') { const err = document.getElementById('lg_err'); err.textContent = ''; t.disabled = true; try { const r = await login({ server: lg_server.value, company: lg_company.value, user: lg_user.value, pass: lg_pass.value }); if (r.otp) return renderLogin('', { data: r.otp, body: r.body }); await afterLogin(r); } catch (ex) { err.textContent = ex.message; } t.disabled = false; }
      else if (a === 'verifyotp') { const r = await http('POST', '/auth/login/verify-otp', { company_code: S.otp.body.company_code, challenge_id: S.otp.data.challenge_id, code: document.getElementById('lo_code').value.trim() }); if (!r.ok) { document.getElementById('lg_err').textContent = r.data.error || 'Wrong code'; return; } await afterLogin(await finishLogin(r.data, S.otp.body.company_code)); }
      else if (a === 'relogin') { S.token = ''; await kvSet('token', ''); render(); }
      else if (a === 'logout') await logout();
      else if (a === 'syncnow') syncNow(true);
      else if (a === 'pickcust') pickSheet('cust');
      else if (a === 'addprod') pickSheet('prod');
      else if (a === 'choosecust') { const c = S.customers.find((x) => x.key === t.dataset.k); closeSheet(); if (S.tab === 'collect') rdraft.customer = c; else draft.customer = c; render(); }
      else if (a === 'chooseprod') { const p = S.products.find((x) => x.id === +t.dataset.id); closeSheet(); const ex = draft.items.find((l) => l.product_id === p.id); if (ex) ex.qty += 1; else draft.items.push({ product_id: p.id, name: p.name, qty: 1, rate: p.sale_rate, discount_pct: 0, gst_rate: p.gst_rate, stock_now: stockOf(p) }); render(); }
      else if (a === 'newcust') newCustSheet();
      else if (a === 'newcust2') { pickSheet('cust'); newCustSheet(); }
      else if (a === 'savecust') { const c = await saveCust(); if (c) { closeSheet(); if (S.tab === 'collect') rdraft.customer = c; else if (S.tab === 'sale') draft.customer = c; toast('Customer saved'); render(); } }
      else if (a === 'rmline') { draft.items.splice(+t.dataset.i, 1); render(); }
      else if (a === 'savesale') await saveSale();
      else if (a === 'cancelsale') { if (confirm('Discard this sale?')) { draft = null; render(); } }
      else if (a === 'saverc') await saveReceipt();
      else if (a === 'opencust') { S.tab = 'customer'; S.view = t.dataset.k; render(); }
      else if (a === 'salefor') { draft = newDraft(S.customers.find((x) => x.key === t.dataset.k)); S.tab = 'sale'; render(); }
      else if (a === 'collectfor') { rdraft = { customer: S.customers.find((x) => x.key === t.dataset.k), amount: '', mode: 'Cash', ref: '', invoice: '' }; S.tab = 'collect'; render(); }
      else if (a === 'openinv') { S.tab = 'invoice'; S.view = t.dataset.u; render(); }
      else if (a === 'collectinv') { const i = S.invoices.find((x) => x.client_uuid === t.dataset.u); rdraft = { customer: S.customers.find((x) => sameCust(i, x)), amount: String(i.grand_total), mode: 'Cash', ref: '', invoice: i.client_uuid }; S.tab = 'collect'; render(); }
      else if (a === 'shareinv') { const i = S.invoices.find((x) => x.client_uuid === t.dataset.u); const txt = `${S.company ? S.company.name : 'Invoice'}\n${i.invoice_no || 'Invoice (number after sync)'} · ${i.date}\n${i.customer_name}\n` + i.items.map((l) => `${l.name}  ${l.qty} x ${l.rate}`).join('\n') + `\nGST ${i.gst_pct}%: ${i.gst_amt}\nTotal: ${i.grand_total}`; if (navigator.share) navigator.share({ text: txt }).catch(() => {}); else { navigator.clipboard && navigator.clipboard.writeText(txt); toast('Copied'); } }
      else if (a === 'retryev') { const ev = S.outbox.find((x) => x.id === +t.dataset.id); ev.status = 'pending'; ev.error = null; await put('outbox', ev); if (ev.entity_type === 'SALES_INVOICE') { const i = S.invoices.find((x) => x.client_uuid === ev.entity_client_id); if (i) { i.status = 'pending'; i.error = null; await put('invoices', i); } } if (ev.entity_type === 'RECEIPT') { const r = S.receipts.find((x) => x.client_uuid === ev.entity_client_id); if (r) { r.status = 'pending'; r.error = null; await put('receipts', r); } } await refreshLocal(); syncNow(true); }
      else if (a === 'dropev') { if (!confirm('Discard this item? It will NOT be sent to the server.')) return; const ev = S.outbox.find((x) => x.id === +t.dataset.id); await del('outbox', ev.id); if (ev.entity_type === 'SALES_INVOICE') await del('invoices', ev.entity_client_id); if (ev.entity_type === 'RECEIPT') await del('receipts', ev.entity_client_id); await refreshLocal(); render(); }
    } catch (ex) { if (ex.net) toast('No connection'); else { console.error(ex); toast(ex.message || 'Something went wrong'); } }
  });
  async function afterLogin(r) {
    if (r.mustChange) return renderChangePassword();
    S.tab = 'home'; render(); syncNow(false);
  }
  function renderChangePassword(msg) {
    $app.innerHTML = `<div class="login"><h1>Choose a new password</h1><p class="mut">Your password was set for you. Choose your own to continue (8+ characters, with a letter and a number).</p><label>Current password</label><input id="cp_cur" type="password"><label>New password</label><input id="cp_new" type="password"><div class="err" id="cp_err">${esc(msg || '')}</div><button class="btn" id="cp_go">Change password</button></div>`;
    document.getElementById('cp_go').onclick = async () => { try { const r = await http('POST', '/auth/change-password', { current_password: cp_cur.value, new_password: cp_new.value }); if (!r.ok) return renderChangePassword(r.data.error); S.user.must_change_password = false; await kvSet('user', S.user); toast('Password changed'); afterLogin({ ok: true }); } catch (ex) { renderChangePassword(ex.net ? 'No connection.' : ex.message); } };
  }

  // ------------------------------------------------------------ auto triggers
  const trigger = () => { if (S.token && !S.needLogin) syncNow(false); };
  window.addEventListener('online', trigger);
  window.addEventListener('offline', () => { S.online = false; paintStatus(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trigger(); });
  setInterval(() => { if (!document.hidden && S.token && !S.needLogin && (pending() || !S.online || Date.now() - new Date(S.lastSync || 0) > 5 * 60000)) syncNow(false); }, 60000);
  try { const N = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network; if (N) { N.addListener('networkStatusChange', (s) => { S.online = s.connected; paintStatus(); if (s.connected) trigger(); }); } const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App; if (A) A.addListener('resume', trigger); } catch (_) { /* browser */ }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async () => { await loadState(); render(); if (S.token) setTimeout(trigger, 500); })();
})();
