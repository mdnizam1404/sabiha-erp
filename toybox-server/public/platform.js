// ============================================================================
// platform.js — Platform Owner console (v5.2)
// Talks only to /api/platform/*; uses its own token (never the company app's).
// ============================================================================
const API = '/api/platform';
const TK = 'sabiha_platform_token';
let TOKEN = localStorage.getItem(TK) || '';
let ME = null;
let TAB = 'dashboard';
let MON = null, REQS = [], PLANS = [], PLAN_DEFAULTS = {}, GATED = [];
let reqFilter = 'PENDING', billFilter = '';
let timer = null;
const IS_SUPPORT = () => ME && ME.role === 'SUPPORT';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtBytes = (b) => { if (b == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = Number(b); while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const parseD = (d) => new Date(String(d).includes('T') || String(d).endsWith('Z') || /[+-]\d\d$/.test(String(d)) ? d : String(d).replace(' ', 'T') + 'Z');
const fmtDT = (d) => { if (!d) return '—'; const x = parseD(d); return isNaN(x) ? esc(d) : x.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtDay = (s) => { if (!s) return '—'; const x = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(x) ? esc(s) : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const ago = (d) => { if (!d) return 'never'; const x = parseD(d); const s = (Date.now() - x) / 1000; if (isNaN(s)) return '—'; if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; };
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(window.__t); window.__t = setTimeout(() => t.classList.remove('show'), 3600); }
const field = (label, inner, note) => `<div class="form-field"><label>${label}</label>${inner}${note ? `<div class="muted" style="font-size:11.5px;margin-top:3px;">${note}</div>` : ''}</div>`;
const val = (id) => $(id) ? $(id).value.trim() : '';
const chk = (id) => $(id) ? $(id).checked : false;

async function api(path, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) };
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') { signOut(true); throw new Error(data.error || 'Session expired'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; throw e; }
  return data;
}
const send = (m) => (p, b) => api(p, { method: m, body: JSON.stringify(b || {}) });
const post = send('POST'), put = send('PUT'), del = (p) => api(p, { method: 'DELETE' });

// ---------------------------------------------------------------- auth ------
function showLogin() { $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden'); clearInterval(timer); $('lgStep1').classList.remove('hidden'); $('lgStep2').classList.add('hidden'); }
function signOut(silent) { TOKEN = ''; ME = null; localStorage.removeItem(TK); showLogin(); if (!silent) toast('Signed out'); }
async function doLogin() {
  $('lgErr').textContent = ''; $('lgBtn').disabled = true;
  try {
    const body = { username: $('lgUser').value.trim(), password: $('lgPass').value };
    if (!$('lgStep2').classList.contains('hidden')) body.code = $('lgCode').value.trim();
    const r = await post('/auth/login', body);
    if (r.two_factor_required) { $('lgStep1').classList.add('hidden'); $('lgStep2').classList.remove('hidden'); $('lgCode').value = ''; $('lgCode').focus(); $('lgBtn').textContent = 'Verify & Sign In'; }
    else { TOKEN = r.token; localStorage.setItem(TK, TOKEN); ME = r.admin; $('lgPass').value = ''; $('lgCode').value = ''; $('lgBtn').textContent = 'Sign In'; await boot(); }
  } catch (e) { $('lgErr').textContent = e.message; if (e.data && e.data.locked) showLogin(); }
  $('lgBtn').disabled = false;
}
async function boot() {
  try { ME = (await api('/me')).admin; } catch (e) { if (e.data && e.data.must_change_password) { ME = { username: '', must_change_password: true }; } else { showLogin(); return; } }
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('whoami').textContent = ME.username ? `Signed in as ${ME.full_name || ME.username} · ${ME.role === 'SUPPORT' ? 'Support (view only)' : 'Owner'}` : '';
  if (ME.must_change_password) { openPasswordModal(true); return; }
  try { const p = await api('/plans'); PLANS = p.plans; GATED = p.modules; PLAN_DEFAULTS = p.defaults; } catch (_) { /* tabs load it again */ }
  await go('dashboard');
  clearInterval(timer);
  timer = setInterval(() => { if (TAB === 'dashboard' && !$('mBg').classList.contains('show')) loadMonitor(false).catch(() => {}); }, 60000);
}

// ---------------------------------------------------------------- tabs ------
function tabList() {
  const t = [['dashboard', 'Dashboard'], ['requests', 'Company Requests'], ['planreq', 'Plan Requests'], ['companies', 'Companies'], ['create', 'Create Company'], ['plans', 'Plans'], ['billing', 'Billing'], ['backups', 'Backups'], ['announce', 'Announcements']];
  if (!IS_SUPPORT()) t.push(['team', 'Team & Security'], ['settings', 'Settings']);
  t.push(['audit', 'Activity Log']);
  return t;
}
function paintTabs() {
  const pend = MON ? MON.totals.pending_company_requests : 0; const pendPlan = MON ? (MON.totals.pending_plan_requests || 0) : 0;
  $('tabs').innerHTML = tabList().map(([k, l]) => `<div class="pf-tab ${TAB === k ? 'active' : ''}" data-tab="${k}">${l}${k === 'requests' && pend ? `<span class="badge badge-amber">${pend}</span>` : ''}${k === 'planreq' && pendPlan ? `<span class="badge badge-amber">${pendPlan}</span>` : ''}</div>`).join('');
}
async function go(tab) {
  TAB = tab; paintTabs();
  $('view').innerHTML = '<div class="panel">Loading…</div>';
  try {
    if (tab === 'dashboard') await loadMonitor(true);
    else if (tab === 'requests') await loadRequests();
    else if (tab === 'planreq') await renderPlanRequests();
    else if (tab === 'companies') { await loadMonitor(true); }
    else if (tab === 'create') { await ensurePlans(); renderCreate(); }
    else if (tab === 'plans') await renderPlans();
    else if (tab === 'billing') await renderBilling();
    else if (tab === 'backups') await renderBackups();
    else if (tab === 'announce') await renderAnnouncements();
    else if (tab === 'team') await renderTeam();
    else if (tab === 'settings') await renderSettings();
    else if (tab === 'audit') await renderAudit();
    paintTabs();
  } catch (e) { $('view').innerHTML = `<div class="panel" style="color:var(--coral)">${esc(e.message)}</div>`; }
}
async function ensurePlans() { if (!PLANS.length) { const p = await api('/plans'); PLANS = p.plans; GATED = p.modules; PLAN_DEFAULTS = p.defaults; } }
async function loadMonitor(force) {
  MON = await api('/monitor' + (force ? '?refresh=1' : ''));
  if (TAB === 'dashboard') renderDashboard(); else if (TAB === 'companies') renderCompanies();
  paintTabs();
}

// ------------------------------------------------------------ badges --------
function statusBadge(s) {
  const cls = { ACTIVE: 'badge-green', SUSPENDED: 'badge-amber', FAILED: 'badge-red', PENDING: 'badge-amber', APPROVED: 'badge-green', REJECTED: 'badge-red', PROVISIONING: 'badge-blue', ARCHIVED: 'badge-violet', PAID: 'badge-green', DUE: 'badge-blue', OVERDUE: 'badge-red', VOID: 'badge-violet' }[s] || 'badge-blue';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function planBadge(p) {
  if (!p || p.legacy) return '<span class="badge badge-violet">No plan</span>';
  const st = { ACTIVE: ['badge-green', ''], EXPIRING: ['badge-amber', ` · ${p.days_left}d left`], GRACE: ['badge-red', ' · grace'], READONLY: ['badge-red', ' · read-only'] }[p.state] || ['badge-blue', ''];
  return `<span class="badge ${st[0]}">${esc(p.name)}${p.is_trial ? ' (trial)' : ''}${st[1]}</span>${p.expires_on ? `<br><small>${p.state === 'ACTIVE' || p.state === 'EXPIRING' ? 'until' : 'expired'} ${fmtDay(p.expires_on)}</small>` : '<br><small>no expiry</small>'}`;
}
const bars = (rows, k, cls) => { const max = Math.max(1, ...rows.map((r) => r[k])); return `<div class="pf-bars ${cls || ''}">${rows.map((r) => `<div title="${esc(r.month)}: ${k === 'revenue' ? inr(r[k]) : r[k]}"><i style="height:${Math.max(2, Math.round(r[k] / max * 80))}px"></i>${esc(r.month.slice(5))}</div>`).join('')}</div>`; };

// ------------------------------------------------------------ dashboard -----
function renderDashboard() {
  const t = MON.totals, b = MON.billing || {};
  const cards = [
    ['Companies', t.companies, `${t.active} active · ${t.suspended} suspended${t.archived ? ' · ' + t.archived + ' archived' : ''}${t.failed ? ' · ' + t.failed + ' failed' : ''}`],
    ['Pending requests', t.pending_company_requests, 'waiting for your approval'],
    ['On trial', t.trials, `${t.expiring} expiring soon · ${t.read_only} read-only`],
    ['Monthly recurring', inr(t.monthly_recurring_revenue), 'from paid plans in good standing'],
    ['Received this month', inr(b.paid_this_month), `${inr(b.overdue)} overdue · ${inr(b.due)} due`],
    ['Users (all companies)', t.users, `${t.users_pending_approval} awaiting company-admin approval`],
    ['Sales this month', inr(t.sales_this_month), `${t.invoices} invoices in total`],
    ['Storage', fmtBytes(t.db_size_bytes), `databases · backups ${fmtBytes(t.backup_size_bytes)}`],
  ];
  const rows = MON.companies.map((c) => {
    const s = c.stats || {};
    return `<tr>
      <td><b>${esc(c.company_name)}</b><br><small class="mono">${esc(c.company_code)}</small></td>
      <td>${statusBadge(c.status)}${c.error ? `<br><small style="color:var(--coral)" title="${esc(c.error)}">data unavailable</small>` : ''}</td>
      <td>${planBadge(c.plan)}</td>
      <td>${c.stats ? `${s.users_active} <small>/ ${s.users_total}</small>${s.users_pending ? ` <span class="badge badge-amber" title="Waiting for that company's admin">${s.users_pending} pending</span>` : ''}` : '—'}</td>
      <td>${c.stats ? s.invoices : '—'}</td><td>${c.stats ? inr(s.sales_this_month) : '—'}</td>
      <td>${c.stats ? `${ago(s.last_login)}<br><small>${s.logins_7d} user(s) in 7 days</small>` : '—'}</td>
      <td>${fmtBytes(c.db_size_bytes)}</td>
      <td><div class="pf-actions"><button class="btn btn-sm btn-outline" data-act="detail" data-code="${esc(c.company_code)}">View</button></div></td></tr>`;
  }).join('');
  $('view').innerHTML = `
    <div class="pf-cards">${cards.map(([l, n, f]) => `<div class="pf-card"><div class="l">${esc(l)}</div><div class="n">${esc(n)}</div><div class="muted" style="font-size:11.5px;margin-top:4px;">${esc(f)}</div></div>`).join('')}</div>
    <div class="pf-grid2" style="margin-bottom:14px;">
      <div class="panel"><h3 style="margin:0 0 4px;">New companies per month</h3>${bars(MON.growth, 'companies')}</div>
      <div class="panel"><h3 style="margin:0 0 4px;">Revenue received per month</h3>${bars(MON.revenue, 'revenue', 'green')}</div>
    </div>
    <div class="panel" style="padding:0;"><div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;"><h3 style="margin:0;">Every company at a glance</h3><small class="muted">Updated ${fmtDT(MON.generated_at)} · refreshes every minute</small></div>
      <div class="tbl-scroll"><table><thead><tr><th>Company</th><th>Status</th><th>Plan</th><th>Users (active / total)</th><th>Invoices</th><th>Sales (month)</th><th>Last login</th><th>Storage</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:24px;">No companies yet</td></tr>'}</tbody></table></div></div>`;
}

// ------------------------------------------------------------- companies ----
function renderCompanies() {
  const ro = IS_SUPPORT();
  const rows = MON.companies.map((c) => `<tr>
    <td><b>${esc(c.company_name)}</b><br><small class="mono">${esc(c.company_code)}</small></td><td>${statusBadge(c.status)}</td><td>${planBadge(c.plan)}</td>
    <td>${fmtDT(c.created_at)}</td>
    <td><div class="pf-actions">
      <button class="btn btn-sm btn-outline" data-act="detail" data-code="${esc(c.company_code)}">Details</button>
      ${!ro && c.status === 'ACTIVE' ? `<button class="btn btn-sm btn-primary" data-act="renew" data-code="${esc(c.company_code)}">Renew</button><button class="btn btn-sm btn-outline" data-act="backup" data-code="${esc(c.company_code)}">Backup now</button><button class="btn btn-sm btn-outline" data-act="resetpw" data-code="${esc(c.company_code)}">Reset admin password</button><button class="btn btn-sm btn-danger" data-act="suspend" data-code="${esc(c.company_code)}">Suspend</button>` : ''}
      ${!ro && c.status === 'SUSPENDED' ? `<button class="btn btn-sm btn-primary" data-act="activate" data-code="${esc(c.company_code)}">Re-activate</button>` : ''}
      ${!ro && ['ACTIVE', 'SUSPENDED'].includes(c.status) ? `<button class="btn btn-sm btn-outline" data-act="archive" data-code="${esc(c.company_code)}">Archive</button>` : ''}
      ${!ro && c.status === 'ARCHIVED' ? `<button class="btn btn-sm btn-primary" data-act="unarchive" data-code="${esc(c.company_code)}">Bring back</button>` : ''}
    </div></td></tr>${c.status === 'FAILED' ? `<tr><td colspan="5" style="color:var(--coral);font-size:12px;">Setup failed: ${esc(c.provisioning_error || '')}</td></tr>` : ''}`).join('');
  $('view').innerHTML = `<div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Company</th><th>Status</th><th>Plan</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
async function companyAction(act, code) {
  try {
    const q = encodeURIComponent(code);
    if (act === 'suspend') { if (!confirm(`Suspend ${code}? Nobody in that company can sign in until you re-activate it. Their data is kept.\n\n(For an expired plan use the plan expiry instead — it switches to read-only automatically and never locks people out.)`)) return; await api(`/companies/${q}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED' }) }); toast(code + ' suspended'); }
    else if (act === 'activate') { await api(`/companies/${q}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }) }); toast(code + ' re-activated'); }
    else if (act === 'resetpw') { openResetPassword(code); return; }
    else if (act === 'detail') { await openDetail(code); return; }
    else if (act === 'renew') { await openRenew(code); return; }
    else if (act === 'backup') { toast('Backing up…'); const r = await post(`/companies/${q}/backups`, {}); toast(`Backup saved (${fmtBytes(r.backup.size_bytes)})`); }
    else if (act === 'archive') { if (!confirm(`Archive ${code}?\n\nA full backup is taken first, then the company is retired: nobody can sign in. Nothing is deleted and you can bring it back any time.`)) return; await post(`/companies/${q}/archive`, {}); toast(code + ' archived (full copy saved)'); }
    else if (act === 'unarchive') { await post(`/companies/${q}/unarchive`, {}); toast(code + ' is back'); }
    await loadMonitor(true);
  } catch (e) { toast(e.message); }
}
function closeModal() { $('mBg').classList.remove('show'); $('mBox').classList.remove('narrow'); }
function openModal(html, narrow) { $('mBox').classList.toggle('narrow', !!narrow); $('mBox').innerHTML = html; $('mBg').classList.add('show'); }
const modalHead = (title, extra) => `<h3><span>${title}</span><span>${extra || ''}<button class="btn btn-sm btn-outline" data-act="closeModal">Close</button></span></h3>`;
const planOptions = (sel, trialToo = true) => PLANS.filter((p) => p.active && (trialToo || !p.is_trial) || p.code === sel).map((p) => `<option value="${esc(p.code)}" ${p.code === sel ? 'selected' : ''}>${esc(p.name)}${p.is_trial ? ` (trial, ${p.trial_days} days)` : p.price_monthly ? ` — ${inr(p.price_monthly)}/month` : ''}</option>`).join('');
const meter = (used, lim) => { if (lim == null) return '<small>unlimited</small>'; const pct = Math.min(100, Math.round(used / lim * 100)); return `<small>${used} of ${lim}</small><div class="pf-meter ${used > lim ? 'over' : used >= lim ? 'warn' : ''}"><b style="width:${pct}%"></b></div>`; };

// ---------------------------------------------------------- company detail --
async function openDetail(code, section) {
  await ensurePlans();
  const d = await api('/companies/' + encodeURIComponent(code));
  const c = d.company, s = d.stats, sn = d.subscription, sr = d.subscription_row, ro = IS_SUPPORT();
  const users = (d.users || []).map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td><td>${esc(u.role)}</td><td>${statusBadge(String(u.status || 'Pending').toUpperCase() === 'APPROVED' ? (Number(u.active) ? 'ACTIVE' : 'SUSPENDED') : String(u.status || 'PENDING').toUpperCase())}</td><td>${ago(u.last_login_at)}</td></tr>`).join('');
  const acts = (d.recent_activity || []).map((a) => `<tr><td><small>${fmtDT(a.created_at)}</small></td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td>${esc(a.entity || '')}</td></tr>`).join('');
  const logins = (d.logins || []).map((l) => `<tr><td><small>${fmtDT(l.created_at)}</small></td><td>${esc(l.username)}</td><td>${l.success ? '<span class="badge badge-green">OK</span>' : `<span class="badge badge-red" title="${esc(l.reason || '')}">Failed</span>`}</td><td class="mono">${esc(l.ip || '')}</td><td><small>${esc((l.user_agent || '').slice(0, 60))}</small></td></tr>`).join('');
  const bks = (d.backups || []).map((b) => `<tr><td><small>${fmtDT(b.created_at)}</small></td><td><span class="badge badge-blue">${esc(b.kind)}</span></td><td>${fmtBytes(b.size_bytes)}</td><td>${b.row_count.toLocaleString()}</td>
    <td><div class="pf-actions">${ro ? '' : `<button class="btn btn-sm btn-outline" data-act="bk-restore" data-id="${b.id}" data-code="${esc(c.company_code)}">Restore here</button><button class="btn btn-sm btn-outline" data-act="bk-new" data-id="${b.id}" data-code="${esc(c.company_code)}">Restore as new company</button><button class="btn btn-sm btn-outline" data-act="bk-dl" data-id="${b.id}">Download</button><button class="btn btn-sm btn-danger" data-act="bk-del" data-id="${b.id}" data-code="${esc(c.company_code)}">Delete</button>`}</div></td></tr>`).join('');
  const bill = (d.billing || []).map((b) => `<tr><td>${fmtDay(b.issued_on)}</td><td>${esc(b.description)}</td><td>${inr(b.amount)}</td><td>${statusBadge(b.status)}</td></tr>`).join('');
  const usage = sn && sn.usage;
  const limits = sn ? sn.limits : {};
  const ov = (sr && sr.overrides) || {};
  const modsOn = (sn && sn.modules) || null;
  const baseUrl = location.origin + '/c/' + c.company_code;
  const planBlock = !sn ? '' : (sn.legacy ? `<div class="pf-sec"><h4>Plan</h4><p class="pf-note">This company has no plan (it predates v5.2) — it is unlimited and never expires.</p>${ro || c.status !== 'ACTIVE' ? '' : `<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;"><div class="form-field" style="margin:0;"><label>Start a plan</label><select id="spPlan">${planOptions('BASIC')}</select></div><div class="form-field" style="margin:0;"><label>Months</label><input id="spMonths" type="number" min="1" value="12" style="width:90px"></div><button class="btn btn-primary" data-act="startplan" data-code="${esc(c.company_code)}">Start plan</button></div>`}</div>` : `
    <div class="pf-sec"><h4>Plan &amp; expiry ${planBadge({ name: sn.plan_name, state: sn.state, days_left: sn.days_left, expires_on: sn.expires_on, is_trial: sn.is_trial })}</h4>
      ${sn.notice ? `<div class="auth-err" style="margin:0 0 10px;">${esc(sn.notice.text)}</div>` : ''}
      <div class="pf-grid3">
        ${field('Plan', `<select id="sbPlan" ${ro ? 'disabled' : ''}>${planOptions(sn.plan_code)}</select>`)}
        ${field('Expiry date', `<input id="sbExp" type="date" value="${esc((sr && sr.expires_on) || '')}" ${ro ? 'disabled' : ''}>`, 'Empty = never expires')}
        ${field('Grace period (days)', `<input id="sbGrace" type="number" min="0" max="365" value="${sr ? sr.grace_days : 7}" ${ro ? 'disabled' : ''}>`, 'Full access continues; then read-only')}
        ${field('When a limit is reached', `<select id="sbAct" ${ro ? 'disabled' : ''}><option value="WARN" ${sr && sr.limit_action === 'WARN' ? 'selected' : ''}>Show a warning only</option><option value="BLOCK" ${sr && sr.limit_action === 'BLOCK' ? 'selected' : ''}>Block new entries</option></select>`)}
        ${field('Billing contact email', `<input id="sbMail" value="${esc((sr && sr.contact_email) || '')}" ${ro ? 'disabled' : ''}>`, 'Expiry reminders go here')}
        ${field('Notes (private)', `<input id="sbNotes" value="${esc((sr && sr.notes) || '')}" ${ro ? 'disabled' : ''}>`)}
      </div>
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">Custom limits &amp; modules for this company only</summary>
        <p class="pf-note" style="margin-top:6px;">Leave a box empty to use the plan's value. Tick modules to override the plan's module list.</p>
        <div class="pf-grid3">${[['max_users', 'Users'], ['max_branches', 'Branches'], ['max_invoices_month', 'Invoices / month'], ['max_storage_mb', 'Storage (MB)']].map(([k, l]) => field(l, `<input id="ov_${k}" type="number" min="0" value="${ov[k] ?? ''}" placeholder="plan: ${limits[k] == null ? 'unlimited' : ''}" ${ro ? 'disabled' : ''}>`)).join('')}</div>
        <label class="pf-chk" style="margin:10px 0 4px;"><input type="checkbox" id="ov_modules_on" ${Array.isArray(ov.modules) ? 'checked' : ''} ${ro ? 'disabled' : ''}> Use a custom module list for this company</label>
        <div class="pf-grid3">${GATED.map((m) => `<label class="pf-chk"><input type="checkbox" class="ov_mod" value="${m.key}" ${(Array.isArray(ov.modules) ? ov.modules : (modsOn || GATED.map((x) => x.key))).includes(m.key) ? 'checked' : ''} ${ro ? 'disabled' : ''}> ${esc(m.label)}</label>`).join('')}</div>
      </details>
      ${usage ? `<div class="pf-grid3" style="margin-top:12px;">
        <div>Users${meter(usage.users, limits.max_users)}</div><div>Branches${meter(usage.branches, limits.max_branches)}</div><div>Invoices this month${meter(usage.invoices_month, limits.max_invoices_month)}</div><div>Storage (MB)${meter(usage.storage_mb, limits.max_storage_mb)}</div></div>` : ''}
      ${ro ? '' : `<div class="pf-actions" style="margin-top:12px;justify-content:flex-start;"><button class="btn btn-primary" data-act="savesub" data-code="${esc(c.company_code)}">Save plan</button><button class="btn btn-outline" data-act="renew" data-code="${esc(c.company_code)}">Renew…</button></div>`}
    </div>`);
  const brand = d.branding || {};
  openModal(`${modalHead(`${esc(c.company_name)} <small class="mono muted">${esc(c.company_code)}</small> ${statusBadge(c.status)}`)}
    ${d.error ? `<div class="auth-err">${esc(d.error)}</div>` : ''}
    ${s ? `<div class="pf-cards" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr));">${[['Users', s.users_total], ['Awaiting approval', s.users_pending], ['Employees', s.employees], ['Customers', s.customers], ['Products', s.products], ['Invoices', s.invoices], ['Sales this month', inr(s.sales_this_month)], ['Sales (all time)', inr(s.sales_total)]].map(([l, n]) => `<div class="pf-card"><div class="l">${l}</div><div class="n" style="font-size:18px;">${esc(n)}</div></div>`).join('')}</div>` : ''}
    ${planBlock}
    <div class="pf-sec"><h4>Login page branding</h4>
      <p class="pf-note" style="margin-bottom:8px;">Shown on the sign-in page once the Company ID is typed. Direct link: <span class="mono">${esc(baseUrl)}</span> <a href="#" data-act="copylink" data-link="${esc(baseUrl)}">copy</a></p>
      <div class="pf-grid3">
        ${field('Display name', `<input id="brName" value="${esc(brand.display_name || '')}" placeholder="${esc(c.company_name)}" ${ro ? 'disabled' : ''}>`)}
        ${field('Tagline', `<input id="brTag" value="${esc(brand.tagline || '')}" ${ro ? 'disabled' : ''}>`)}
        ${field('Colour', `<input id="brCol" type="color" value="${esc(brand.primary_color || '#2F5BEA')}" ${ro ? 'disabled' : ''}>`)}
        ${field('Logo (PNG/JPG, under 300 KB)', `<input id="brLogo" type="file" accept="image/png,image/jpeg,image/webp" ${ro ? 'disabled' : ''}>`)}
      </div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:8px;">${brand.logo_data_url ? `<img id="brPrev" src="${esc(brand.logo_data_url)}" style="height:46px;border-radius:8px;border:1px solid var(--line);">` : '<span class="muted" style="font-size:12px;">No logo uploaded</span>'}
        ${ro ? '' : `<button class="btn btn-primary btn-sm" data-act="savebrand" data-code="${esc(c.company_code)}">Save branding</button>${brand.logo_data_url ? `<button class="btn btn-outline btn-sm" data-act="rmlogo" data-code="${esc(c.company_code)}">Remove logo</button>` : ''}`}</div>
    </div>
    <div class="pf-sec"><h4>Backups ${ro || c.status !== 'ACTIVE' ? '' : `<button class="btn btn-sm btn-primary" data-act="backup-d" data-code="${esc(c.company_code)}" style="margin-left:8px;">Backup now</button>`}</h4>
      <div class="tbl-scroll"><table><thead><tr><th>When</th><th>Type</th><th>Size</th><th>Rows</th><th></th></tr></thead><tbody>${bks || '<tr><td colspan="5">No backups yet</td></tr>'}</tbody></table></div></div>
    <div class="pf-grid2">
      <div><h4 style="margin-bottom:6px;">Users</h4><div class="tbl-scroll" style="max-height:260px;overflow:auto;"><table><thead><tr><th>User ID</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead><tbody>${users || '<tr><td colspan="5">No users</td></tr>'}</tbody></table></div></div>
      <div><h4 style="margin-bottom:6px;">Sign-in history</h4><div class="tbl-scroll" style="max-height:260px;overflow:auto;"><table><thead><tr><th>When</th><th>User</th><th></th><th>IP</th><th>Device</th></tr></thead><tbody>${logins || '<tr><td colspan="5">No sign-ins recorded yet</td></tr>'}</tbody></table></div></div>
    </div>
    <div class="pf-grid2" style="margin-top:14px;">
      <div><h4 style="margin-bottom:6px;">Recent activity inside the company</h4><div class="tbl-scroll" style="max-height:240px;overflow:auto;"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>On</th></tr></thead><tbody>${acts || '<tr><td colspan="4">Nothing recorded</td></tr>'}</tbody></table></div></div>
      <div><h4 style="margin-bottom:6px;">Billing</h4><div class="tbl-scroll" style="max-height:240px;overflow:auto;"><table><thead><tr><th>Issued</th><th>For</th><th>Amount</th><th>Status</th></tr></thead><tbody>${bill || '<tr><td colspan="4">No billing records</td></tr>'}</tbody></table></div></div>
    </div>
    <p class="muted" style="font-size:11.5px;margin-top:10px;">Database: <span class="mono">${esc(c.database_name)}</span> · Created ${fmtDT(c.created_at)}. Viewing a company is recorded in the activity log. There is deliberately no "sign in as this company" button.</p>`);
}
async function saveSub(code) {
  const body = { plan_code: val('sbPlan'), expires_on: val('sbExp') || null, grace_days: val('sbGrace'), limit_action: val('sbAct'), contact_email: val('sbMail'), notes: val('sbNotes') };
  const o = {};
  ['max_users', 'max_branches', 'max_invoices_month', 'max_storage_mb'].forEach((k) => { if (val('ov_' + k) !== '') o[k] = val('ov_' + k); });
  if (chk('ov_modules_on')) o.modules = [...document.querySelectorAll('.ov_mod:checked')].map((x) => x.value);
  body.overrides = o;
  try { await put(`/companies/${encodeURIComponent(code)}/subscription`, body); toast('Plan saved'); MON = null; await openDetail(code); } catch (e) { toast(e.message); }
}
async function saveBrand(code, removeLogo) {
  try {
    const body = { display_name: val('brName'), tagline: val('brTag'), primary_color: val('brCol') };
    if (removeLogo) body.logo_data_url = '';
    const f = $('brLogo') && $('brLogo').files[0];
    if (f) {
      if (f.size > 300 * 1024) throw new Error('The logo is larger than 300 KB. Use a smaller image.');
      body.logo_data_url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('Could not read the image.')); r.readAsDataURL(f); });
    }
    await put(`/companies/${encodeURIComponent(code)}/branding`, body); toast('Branding saved'); await openDetail(code);
  } catch (e) { toast(e.message); }
}
async function startPlan(code) {
  try { await post(`/companies/${encodeURIComponent(code)}/start-plan`, { plan_code: val('spPlan'), months: val('spMonths') }); toast('Plan started'); MON = null; await openDetail(code); } catch (e) { toast(e.message); }
}
async function downloadBackup(id) {
  try {
    const res = await fetch(`${API}/backups/${id}/download`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const cd = res.headers.get('content-disposition') || ''; const name = (cd.match(/filename="?([^";]+)"?/) || [])[1] || `backup-${id}.json.gz`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message); }
}
function openRestoreNew(id, code) {
  openModal(`${modalHead('Restore as a new company')}
    <p class="pf-note">Creates a brand-new company containing a copy of this backup (all users, settings and data). The original company is not touched. Sign-in passwords are the same as in the backup.</p>
    ${field('New Company ID', '<input id="rnCode" style="text-transform:uppercase;" placeholder="e.g. LOTUS2">')}${field('New company name', '<input id="rnName">')}
    <div id="rnErr" class="auth-err"></div><button class="btn btn-primary" data-act="bk-new-go" data-id="${id}" data-code="${esc(code)}">Create company from backup</button>`, true);
}
function openRenew(code) {
  const c = MON && MON.companies.find((x) => x.company_code === code);
  openModal(`${modalHead('Renew — ' + esc(code))}
    <p class="pf-note">Extends from the later of today and the current expiry date. Current: ${c && c.plan ? `${esc(c.plan.name)}, ${c.plan.expires_on ? 'expires ' + fmtDay(c.plan.expires_on) : 'no expiry'}` : '—'}.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">${[[1, '+1 month'], [3, '+3 months'], [6, '+6 months'], [12, '+1 year']].map(([m, l]) => `<button class="btn btn-primary" data-act="renew-go" data-code="${esc(code)}" data-m="${m}">${l}</button>`).join('')}</div>
    ${field('Or a custom number of days', '<input id="rnDays" type="number" min="1" style="max-width:140px">')}${field('Switch plan while renewing (optional)', `<select id="rnPlan"><option value="">Keep current plan</option>${planOptions('')}</select>`)}
    <div id="rnErr" class="auth-err"></div><button class="btn btn-outline" data-act="renew-go" data-code="${esc(code)}" data-m="0">Extend by those days</button>`, true);
}
async function doRenew(code, m) {
  try { await post(`/companies/${encodeURIComponent(code)}/renew`, { months: Number(m) || undefined, days: val('rnDays') || undefined, plan_code: val('rnPlan') || undefined }); closeModal(); toast('Renewed'); MON = null; await go(TAB); } catch (e) { if ($('rnErr')) $('rnErr').textContent = e.message; else toast(e.message); }
}

function openResetPassword(code) {
  openModal(`${modalHead('Reset admin password — ' + esc(code))}
    <p class="pf-note">Sets a new password for that company's administrator and clears any login lock. They must choose their own password at next sign-in. Tell them the temporary one securely.</p>
    ${field('Temporary password (8+ characters, letters &amp; numbers)', '<input id="rpPass" type="password" autocomplete="new-password">')}
    <div id="rpErr" class="auth-err"></div><button class="btn btn-primary" id="rpGo" data-code="${esc(code)}">Reset Password</button>`, true);
}
async function doResetPassword(code) {
  $('rpErr').textContent = '';
  try { const r = await post(`/companies/${encodeURIComponent(code)}/reset-admin-password`, { new_password: $('rpPass').value }); closeModal(); toast(r.message); } catch (e) { $('rpErr').textContent = e.message; }
}

// ---------------------------------------------------------------- requests --
async function loadRequests() {
  await ensurePlans();
  const r = await api('/requests' + (reqFilter ? '?status=' + reqFilter : ''));
  REQS = r.requests;
  if (!MON) { try { MON = await api('/monitor'); } catch (_) { /* badge only */ } }
  renderRequests();
}
function renderRequests() {
  const ro = IS_SUPPORT();
  const filters = ['PENDING', 'APPROVED', 'REJECTED', ''].map((f) => `<button class="btn btn-sm ${reqFilter === f ? 'btn-primary' : 'btn-outline'}" data-filter="${f}">${f ? f[0] + f.slice(1).toLowerCase() : 'All'}</button>`).join(' ');
  const rows = REQS.map((r) => `<tr>
    <td><b>${esc(r.company_name)}</b><br><small class="mono">${esc(r.reference)}</small></td>
    <td>${esc(r.contact_name)}<br><small>${esc(r.email)}${r.phone ? ' · ' + esc(r.phone) : ''}${r.city ? ' · ' + esc(r.city) : ''}</small>${r.notes ? `<br><small>“${esc(r.notes)}”</small>` : ''}</td>
    <td>${r.requested_code ? `<span class="mono">${esc(r.requested_code)}</span>` : '<small>(none — will be suggested)</small>'}<br><small>admin: ${esc(r.admin_username)}</small></td>
    <td>${statusBadge(r.status)}<br><small>${fmtDT(r.created_at)}</small>${r.status !== 'PENDING' ? `<br><small>${r.assigned_code ? 'ID: ' + esc(r.assigned_code) : ''}${r.review_note ? ' — ' + esc(r.review_note) : ''}</small>` : ''}</td>
    <td>${r.status === 'PENDING' && !ro ? `<div class="pf-actions"><button class="btn btn-sm btn-primary" data-act="approve" data-id="${esc(r.id)}">Approve…</button><button class="btn btn-sm btn-danger" data-act="reject" data-id="${esc(r.id)}">Reject…</button></div>` : ''}</td></tr>`).join('');
  $('view').innerHTML = `<div style="margin-bottom:12px;display:flex;gap:6px;flex-wrap:wrap;">${filters}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Company</th><th>Contact</th><th>Requested ID</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:24px;">No requests</td></tr>'}</tbody></table></div></div>`;
}
function openApprove(id) {
  const r = REQS.find((x) => x.id === id);
  const trial = PLANS.find((p) => p.is_trial && p.active);
  openModal(`${modalHead('Approve — ' + esc(r.company_name))}
    <p class="pf-note">Creates the company's own private database and admin login (${esc(r.admin_username)}) with the password the applicant chose. An approval email is sent to ${esc(r.email)} if platform email is on. The Company ID cannot be changed later.</p>
    ${field('Company ID', `<input id="apCode" value="${esc(r.requested_code || '')}" placeholder="Leave empty to auto-suggest" style="text-transform:uppercase;">`)}
    ${field('Plan', `<select id="apPlan">${planOptions(trial ? trial.code : '')}</select>`, trial ? `Default: ${esc(trial.name)} (${trial.trial_days} days) so they can try before paying.` : '')}
    ${field('Days (optional — overrides the trial length)', '<input id="apDays" type="number" min="1" style="max-width:140px">')}
    ${field('Note to applicant (optional)', '<input id="apNote" placeholder="Shown when they check their request status">')}
    <div id="apErr" class="auth-err"></div><button class="btn btn-primary" id="apGo" data-id="${esc(id)}">Approve &amp; Create Company</button>`, true);
}
async function doApprove(id) {
  $('apErr').textContent = ''; $('apGo').disabled = true; $('apGo').textContent = 'Creating company…';
  try { const r = await post(`/requests/${encodeURIComponent(id)}/approve`, { company_code: val('apCode'), note: val('apNote'), plan_code: val('apPlan'), days: val('apDays') || undefined }); closeModal(); toast(`Approved — Company ID ${r.company_code}${r.plan ? ' on ' + r.plan : ''}${r.expires_on ? ' until ' + fmtDay(r.expires_on) : ''}`); MON = null; await loadRequests(); await loadMonitor(false).catch(() => {}); }
  catch (e) { $('apErr').textContent = e.message; $('apGo').disabled = false; $('apGo').textContent = 'Approve & Create Company'; }
}
function openReject(id) {
  const r = REQS.find((x) => x.id === id);
  openModal(`${modalHead('Reject — ' + esc(r.company_name))}${field('Reason (shown to the applicant and in the email)', '<input id="rjNote" placeholder="e.g. Could not verify the business">')}<button class="btn btn-danger" id="rjGo" data-id="${esc(id)}">Reject Request</button>`, true);
}
async function doReject(id) { try { await post(`/requests/${encodeURIComponent(id)}/reject`, { note: val('rjNote') }); closeModal(); toast('Request rejected'); MON = null; await loadRequests(); } catch (e) { toast(e.message); } }

// ------------------------------------------------------------ create company -
function renderCreate() {
  const trial = PLANS.find((p) => p.is_trial && p.active);
  $('view').innerHTML = `<div class="panel" style="max-width:640px;"><h3>Create a company</h3>
    <p class="pf-note">Creates a company with its own private database and an administrator login. The admin must replace the password you set here at first sign-in.</p>
    ${IS_SUPPORT() ? '<div class="auth-err">Your account is view-only.</div>' : ''}
    ${field('Company Name *', '<input id="ccName">')}
    ${field('Company ID * <span style="font-weight:400;">(3-31 letters / numbers / _ / -; used at sign-in)</span>', '<input id="ccCode" style="text-transform:uppercase;">')}
    ${field('Admin User ID *', '<input id="ccUser" value="ADMIN" autocomplete="off">')}
    ${field('Temporary admin password * <span style="font-weight:400;">(8+ characters, letters &amp; numbers)</span>', '<input id="ccPass" type="text" autocomplete="off">')}
    ${field('Head-office branch name', '<input id="ccBranch" value="Head Office">')}
    ${field('Contact email (for expiry reminders)', '<input id="ccMail" type="email">')}
    <div class="pf-sec" style="margin-top:12px;"><h4>Plan</h4>
      ${field('Plan', `<select id="ccPlan" onchange="syncCreateDuration()">${planOptions(trial ? trial.code : '')}</select>`)}
      <div id="ccDur" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;"></div></div>
    <div id="ccErr" class="auth-err"></div>
    <button class="btn btn-primary" id="ccGo" ${IS_SUPPORT() ? 'disabled' : ''}>Create Company</button></div>`;
  syncCreateDuration();
}
function syncCreateDuration() {
  const p = PLANS.find((x) => x.code === val('ccPlan')); const el = $('ccDur'); if (!el) return;
  el.innerHTML = p && p.is_trial
    ? `${field('Trial length (days)', `<input id="ccDays" type="number" min="1" value="${p.trial_days}" style="width:120px">`)}<label class="pf-chk" style="margin-bottom:12px;"><input type="checkbox" id="ccNoExp"> No expiry</label>`
    : `${field('Paid for (months)', '<input id="ccMonths" type="number" min="1" value="12" style="width:120px">')}<label class="pf-chk" style="margin-bottom:12px;"><input type="checkbox" id="ccNoExp"> No expiry</label>`;
}
async function doCreate() {
  $('ccErr').textContent = ''; $('ccGo').disabled = true; $('ccGo').textContent = 'Creating…';
  try {
    const sentUser = val('ccUser'); const sentPass = $('ccPass').value; const p = PLANS.find((x) => x.code === val('ccPlan'));
    const r = await post('/companies', { company_name: val('ccName'), company_code: val('ccCode'), admin_username: sentUser, admin_password: sentPass, branch_name: val('ccBranch'), contact_email: val('ccMail'), plan_code: val('ccPlan'), no_expiry: chk('ccNoExp'), days: p && p.is_trial ? val('ccDays') : undefined, months: p && !p.is_trial ? val('ccMonths') : undefined });
    toast(`Company ${r.company.company_code} created`);
    $('view').innerHTML = `<div class="panel" style="max-width:600px;"><h3 style="color:var(--green);">✓ Company created</h3><p>Give these sign-in details to the company:</p>
      <table><tr><td>Company ID</td><td class="mono"><b>${esc(r.company.company_code)}</b></td></tr><tr><td>Admin User ID</td><td class="mono"><b>${esc(sentUser)}</b></td></tr><tr><td>Temporary password</td><td class="mono"><b>${esc(sentPass)}</b></td></tr><tr><td>Sign-in link</td><td class="mono">${esc(location.origin)}/c/${esc(r.company.company_code)}</td></tr></table>
      <p class="pf-note" style="margin-top:10px;">They will be asked to choose their own password at first sign-in. This password is not shown again.</p>
      <button class="btn btn-primary" data-tab="companies">View companies</button> <button class="btn btn-outline" data-tab="create">Create another</button></div>`;
    MON = null;
  } catch (e) { if ($('ccErr')) { $('ccErr').textContent = e.message; $('ccGo').disabled = false; $('ccGo').textContent = 'Create Company'; } else toast(e.message); }
}

// -------------------------------------------------------------------- plans --
async function renderPlans() {
  const p = await api('/plans'); PLANS = p.plans; GATED = p.modules; PLAN_DEFAULTS = p.defaults;
  const ro = IS_SUPPORT();
  const lim = (v) => v == null ? '∞' : v;
  const rows = PLANS.map((x) => `<tr><td><b>${esc(x.name)}</b><br><small class="mono">${esc(x.code)}</small> ${x.active ? '' : '<span class="badge badge-violet">inactive</span>'}${x.is_trial ? ` <span class="badge badge-blue">${x.trial_days}-day trial</span>` : ''}</td>
    <td>${x.price_monthly ? inr(x.price_monthly) + '/mo' : 'free'}</td><td>${lim(x.max_users)}</td><td>${lim(x.max_branches)}</td><td>${lim(x.max_invoices_month)}</td><td>${x.max_storage_mb == null ? '∞' : x.max_storage_mb + ' MB'}</td>
    <td><small>${x.modules ? x.modules.length + ' of ' + GATED.length + ' modules' : 'all modules'}</small></td>
    <td>${ro ? '' : `<div class="pf-actions"><button class="btn btn-sm btn-outline" data-act="editplan" data-code="${esc(x.code)}">Edit</button><button class="btn btn-sm btn-danger" data-act="delplan" data-code="${esc(x.code)}">Delete</button></div>`}</td></tr>`).join('');
  $('view').innerHTML = `<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;"><p class="pf-note" style="margin:0;">Plans set the limits and the modules each company gets. Empty = unlimited / all modules. Defaults: ${PLAN_DEFAULTS.grace_days} days grace, limits ${PLAN_DEFAULTS.limit_action === 'BLOCK' ? 'block new entries' : 'only warn'} (change in Settings).</p>${ro ? '' : '<button class="btn btn-primary" data-act="editplan" data-code="">+ New plan</button>'}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Plan</th><th>Price</th><th>Users</th><th>Branches</th><th>Invoices / month</th><th>Storage</th><th>Modules</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function openPlan(code) {
  const x = PLANS.find((p) => p.code === code) || { code: '', name: '', sort_order: PLANS.length + 1, price_monthly: 0, trial_days: null, max_users: null, max_branches: null, max_invoices_month: null, max_storage_mb: null, modules: null, active: true };
  const on = x.modules || GATED.map((m) => m.key);
  openModal(`${modalHead(code ? 'Edit plan — ' + esc(x.name) : 'New plan')}
    <div class="pf-grid3">
      ${field('Code', `<input id="plCode" value="${esc(x.code)}" ${code ? 'disabled' : ''} style="text-transform:uppercase;" placeholder="e.g. GOLD">`)}
      ${field('Name', `<input id="plName" value="${esc(x.name)}">`)}
      ${field('Order', `<input id="plSort" type="number" value="${x.sort_order}">`)}
      ${field('Price per month (₹)', `<input id="plPrice" type="number" min="0" value="${x.price_monthly}">`)}
      ${field('Trial days', `<input id="plTrial" type="number" min="1" value="${x.trial_days ?? ''}">`, 'Fill in only for a trial plan')}
      ${field('Max users', `<input id="plUsers" type="number" min="0" value="${x.max_users ?? ''}" placeholder="unlimited">`)}
      ${field('Max branches', `<input id="plBr" type="number" min="0" value="${x.max_branches ?? ''}" placeholder="unlimited">`)}
      ${field('Invoices per month', `<input id="plInv" type="number" min="0" value="${x.max_invoices_month ?? ''}" placeholder="unlimited">`)}
      ${field('Storage (MB)', `<input id="plSt" type="number" min="0" value="${x.max_storage_mb ?? ''}" placeholder="unlimited">`)}
    </div>
    <div class="pf-sec" style="margin-top:10px;"><h4>Modules included</h4><label class="pf-chk" style="margin-bottom:6px;"><input type="checkbox" id="plAllMods" ${x.modules ? '' : 'checked'}> All modules (ignore the list)</label>
      <div class="pf-grid3">${GATED.map((m) => `<label class="pf-chk"><input type="checkbox" class="pl_mod" value="${m.key}" ${on.includes(m.key) ? 'checked' : ''}> ${esc(m.label)}</label>`).join('')}</div>
      <p class="pf-note" style="margin:8px 0 0;">Dashboard, Users &amp; Roles, Settings and Audit &amp; Backup are always available.</p></div>
    <label class="pf-chk"><input type="checkbox" id="plActive" ${x.active ? 'checked' : ''}> Plan is active (can be given to new companies)</label>
    <div id="plErr" class="auth-err"></div><button class="btn btn-primary" data-act="saveplan" data-code="${esc(code)}">Save plan</button>`);
}
async function savePlan(code) {
  try {
    await post('/plans', { code: code || val('plCode'), name: val('plName'), sort_order: val('plSort'), price_monthly: val('plPrice'), trial_days: val('plTrial'), max_users: val('plUsers'), max_branches: val('plBr'), max_invoices_month: val('plInv'), max_storage_mb: val('plSt'), active: chk('plActive'), modules: chk('plAllMods') ? null : [...document.querySelectorAll('.pl_mod:checked')].map((x) => x.value) });
    closeModal(); toast('Plan saved'); await renderPlans();
  } catch (e) { $('plErr').textContent = e.message; }
}

// ------------------------------------------------------------------ billing -
async function renderBilling() {
  await ensurePlans();
  const r = await api('/billing' + (billFilter ? '?status=' + billFilter : '')); const s = r.summary; const ro = IS_SUPPORT();
  const filters = ['', 'DUE', 'OVERDUE', 'PAID', 'VOID'].map((f) => `<button class="btn btn-sm ${billFilter === f ? 'btn-primary' : 'btn-outline'}" data-bfilter="${f}">${f ? f[0] + f.slice(1).toLowerCase() : 'All'}</button>`).join(' ');
  const rows = r.records.map((b) => `<tr><td>${fmtDay(b.issued_on)}</td><td><b>${esc(b.company_code)}</b></td><td>${esc(b.description)}${b.period_label ? `<br><small>${esc(b.period_label)}</small>` : ''}</td><td>${inr(b.amount)}</td><td>${fmtDay(b.due_on)}</td><td>${statusBadge(b.status)}${b.paid_on ? `<br><small>${fmtDay(b.paid_on)}${b.method ? ' · ' + esc(b.method) : ''}${b.reference ? ' · ' + esc(b.reference) : ''}</small>` : ''}</td>
    <td>${ro ? '' : `<div class="pf-actions">${['DUE', 'OVERDUE'].includes(b.status) ? `<button class="btn btn-sm btn-primary" data-act="paybill" data-id="${b.id}">Mark paid…</button><button class="btn btn-sm btn-danger" data-act="voidbill" data-id="${b.id}">Cancel</button>` : ''}</div>`}</td></tr>`).join('');
  $('view').innerHTML = `<div class="pf-cards">${[['Received this month', inr(s.paid_this_month), ''], ['Received in total', inr(s.paid_total), ''], ['Due (not late yet)', inr(s.due), `${s.due_count} record(s)`], ['Overdue', inr(s.overdue), `${s.overdue_count} record(s)`]].map(([l, n, f]) => `<div class="pf-card"><div class="l">${l}</div><div class="n">${n}</div><div class="muted" style="font-size:11.5px;">${f}</div></div>`).join('')}</div>
    <div class="panel" style="margin-bottom:14px;"><h3 style="margin:0 0 4px;">Revenue received per month</h3>${bars(r.revenue, 'revenue', 'green')}</div>
    <div style="margin-bottom:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><div style="display:flex;gap:6px;flex-wrap:wrap;">${filters}</div>${ro ? '' : '<button class="btn btn-primary" data-act="newbill">+ New billing record</button>'}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Issued</th><th>Company</th><th>For</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:24px;">No billing records</td></tr>'}</tbody></table></div></div>`;
}
function openNewBill() {
  const opts = (MON ? MON.companies : []).filter((c) => c.status === 'ACTIVE' || c.status === 'SUSPENDED').map((c) => `<option value="${esc(c.company_code)}">${esc(c.company_name)} (${esc(c.company_code)})</option>`).join('');
  const go = async () => { if (!MON) MON = await api('/monitor'); };
  go().then(() => {
    const o = MON.companies.map((c) => `<option value="${esc(c.company_code)}">${esc(c.company_name)} (${esc(c.company_code)})</option>`).join('');
    openModal(`${modalHead('New billing record')}
      ${field('Company', `<select id="bcCo">${o || opts}</select>`)}${field('Plan (optional)', `<select id="bcPlan"><option value="">—</option>${planOptions('')}</select>`)}
      ${field('Description', '<input id="bcDesc" placeholder="e.g. Standard plan — 12 months">')}${field('Amount (₹)', '<input id="bcAmt" type="number" min="0">')}
      <div style="display:flex;gap:10px;">${field('Issue date', `<input id="bcIss" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}${field('Due date', '<input id="bcDue" type="date">')}</div>
      <div id="bcErr" class="auth-err"></div><button class="btn btn-primary" data-act="savebill">Save</button>`, true);
  });
}
async function saveBill() { try { await post('/billing', { company_code: val('bcCo'), plan_code: val('bcPlan'), description: val('bcDesc'), amount: val('bcAmt'), issued_on: val('bcIss'), due_on: val('bcDue') }); closeModal(); toast('Billing record saved'); await renderBilling(); } catch (e) { $('bcErr').textContent = e.message; } }
function openPay(id) {
  openModal(`${modalHead('Record payment')}
    ${field('Payment date', `<input id="pyDate" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}${field('Method', '<input id="pyMethod" placeholder="UPI / Bank transfer / Cash">')}${field('Reference', '<input id="pyRef" placeholder="Transaction ID (optional)">')}
    ${field('Also extend the company\'s plan by (months)', '<input id="pyMonths" type="number" min="0" value="0" style="max-width:120px">', 'Use 0 to only record the payment.')}
    <div id="pyErr" class="auth-err"></div><button class="btn btn-primary" data-act="paygo" data-id="${id}">Mark as paid</button>`, true);
}
async function doPay(id) { try { const r = await post(`/billing/${id}/pay`, { paid_on: val('pyDate'), method: val('pyMethod'), reference: val('pyRef'), renew_months: val('pyMonths') }); closeModal(); toast(r.subscription ? 'Paid — plan extended' : 'Payment recorded'); await renderBilling(); } catch (e) { $('pyErr').textContent = e.message; } }

// ----------------------------------------------------------------- backups --
async function renderBackups() {
  const r = await api('/backups'); const s = r.settings; const ro = IS_SUPPORT();
  if (!MON) { try { MON = await api('/monitor'); } catch (_) { /* optional */ } }
  const rows = r.backups.map((b) => `<tr><td><small>${fmtDT(b.created_at)}</small></td><td><b>${esc(b.company_code)}</b></td><td><span class="badge badge-blue">${esc(b.kind)}</span></td><td>${fmtBytes(b.size_bytes)}</td><td>${b.row_count.toLocaleString()}</td><td><small>${esc(b.created_by || '')}${b.note ? ' — ' + esc(b.note) : ''}</small></td>
    <td>${ro ? '' : `<div class="pf-actions"><button class="btn btn-sm btn-outline" data-act="bk-restore" data-id="${b.id}" data-code="${esc(b.company_code)}">Restore here</button><button class="btn btn-sm btn-outline" data-act="bk-new" data-id="${b.id}" data-code="${esc(b.company_code)}">As new company</button><button class="btn btn-sm btn-outline" data-act="bk-dl" data-id="${b.id}">Download</button><button class="btn btn-sm btn-danger" data-act="bk-del" data-id="${b.id}" data-code="">Delete</button></div>`}</td></tr>`).join('');
  $('view').innerHTML = `<div class="pf-sec"><h4>Nightly backups</h4>
    <div class="pf-grid3">
      <label class="pf-chk" style="margin-top:22px;"><input type="checkbox" id="bkOn" ${s.nightly_enabled ? 'checked' : ''} ${ro ? 'disabled' : ''}> Back up every company each night</label>
      ${field('At (hour, server time)', `<input id="bkHour" type="number" min="0" max="23" value="${s.hour}" ${ro ? 'disabled' : ''}>`)}
      ${field('Keep nightly backups', `<input id="bkN" type="number" min="1" value="${s.keep_nightly}" ${ro ? 'disabled' : ''}>`, 'per company')}
      ${field('Keep manual backups', `<input id="bkM" type="number" min="1" value="${s.keep_manual}" ${ro ? 'disabled' : ''}>`, 'per company')}
    </div>
    <p class="pf-note" style="margin:6px 0 10px;">Backups are compressed files in <span class="mono">data/company-backups/</span> on the server (${fmtBytes(r.disk_bytes)} used). Copy that folder to another machine or cloud drive regularly — a backup on the same disk does not protect against losing the server.</p>
    ${ro ? '' : '<button class="btn btn-primary" data-act="savebk">Save settings</button> <button class="btn btn-outline" data-act="runall">Back up all companies now</button>'}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>When</th><th>Company</th><th>Type</th><th>Size</th><th>Rows</th><th>By</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:24px;">No backups yet</td></tr>'}</tbody></table></div></div>`;
}

// ------------------------------------------------------------ announcements -
let ANNS = [];
async function renderAnnouncements() {
  ANNS = (await api('/announcements')).announcements; const ro = IS_SUPPORT();
  const sev = { info: 'badge-blue', warning: 'badge-amber', danger: 'badge-red' };
  const rows = ANNS.map((a) => { const live = a.active && parseD(a.starts_at) <= new Date() && (!a.ends_at || parseD(a.ends_at) >= new Date());
    return `<tr><td><b>${esc(a.title)}</b><br><small>${esc(a.body || '')}</small></td><td><span class="badge ${sev[a.severity]}">${esc(a.severity)}</span></td><td><small>${fmtDT(a.starts_at)}<br>${a.ends_at ? 'to ' + fmtDT(a.ends_at) : 'until removed'}</small></td><td>${live ? '<span class="badge badge-green">Showing</span>' : '<span class="badge badge-violet">Not showing</span>'}</td>
    <td>${ro ? '' : `<div class="pf-actions"><button class="btn btn-sm btn-outline" data-act="editann" data-id="${a.id}">Edit</button><button class="btn btn-sm btn-outline" data-act="toggleann" data-id="${a.id}">${a.active ? 'Hide' : 'Show'}</button><button class="btn btn-sm btn-danger" data-act="delann" data-id="${a.id}">Delete</button></div>`}</td></tr>`; }).join('');
  $('view').innerHTML = `<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;"><p class="pf-note" style="margin:0;">An announcement appears as a banner at the top of every company's app (maintenance notices, new features). People can hide it for their session.</p>${ro ? '' : '<button class="btn btn-primary" data-act="editann" data-id="">+ New announcement</button>'}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Message</th><th>Level</th><th>When</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:24px;">No announcements</td></tr>'}</tbody></table></div></div>`;
}
const toLocalInput = (d) => { if (!d) return ''; const x = parseD(d); if (isNaN(x)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
function openAnn(id) {
  const a = ANNS.find((x) => String(x.id) === String(id)) || { title: '', body: '', severity: 'info', starts_at: null, ends_at: null };
  openModal(`${modalHead(id ? 'Edit announcement' : 'New announcement')}
    ${field('Title', `<input id="anTitle" value="${esc(a.title)}" maxlength="120">`)}${field('Details (optional)', `<input id="anBody" value="${esc(a.body)}" maxlength="1000">`)}
    ${field('Level', `<select id="anSev">${['info', 'warning', 'danger'].map((s) => `<option ${a.severity === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
    <div style="display:flex;gap:10px;">${field('Show from (optional)', `<input id="anFrom" type="datetime-local" value="${toLocalInput(a.starts_at)}">`)}${field('Show until (optional)', `<input id="anTo" type="datetime-local" value="${toLocalInput(a.ends_at)}">`)}</div>
    <div id="anErr" class="auth-err"></div><button class="btn btn-primary" data-act="saveann" data-id="${esc(id || '')}">Publish</button>`, true);
}
async function saveAnn(id) {
  const body = { title: val('anTitle'), body: val('anBody'), severity: val('anSev'), starts_at: val('anFrom') ? new Date(val('anFrom')).toISOString() : null, ends_at: val('anTo') ? new Date(val('anTo')).toISOString() : null };
  try { if (id) await put('/announcements/' + id, body); else await post('/announcements', body); closeModal(); toast('Saved'); await renderAnnouncements(); } catch (e) { $('anErr').textContent = e.message; }
}

// ---------------------------------------------------------- team & security --
async function renderTeam() {
  const [t, sec] = await Promise.all([api('/team'), api('/security')]);
  const rows = t.team.map((m) => `<tr><td><b>${esc(m.username)}</b><br><small>${esc(m.full_name || '')}${m.email ? ' · ' + esc(m.email) : ''}</small></td><td>${m.role === 'OWNER' ? '<span class="badge badge-blue">Owner</span>' : '<span class="badge badge-violet">Support (view only)</span>'}</td><td>${m.active ? statusBadge('ACTIVE') : statusBadge('SUSPENDED')}</td><td>${m.totp_enabled ? '<span class="badge badge-green">Two-step on</span>' : '<span class="badge badge-amber">Two-step off</span>'}</td><td>${ago(m.last_login_at)}</td>
    <td><div class="pf-actions">${m.id === ME.id ? '<small>(you)</small>' : `<button class="btn btn-sm btn-outline" data-act="tm-role" data-id="${m.id}" data-role="${m.role === 'OWNER' ? 'SUPPORT' : 'OWNER'}">Make ${m.role === 'OWNER' ? 'Support' : 'Owner'}</button><button class="btn btn-sm btn-outline" data-act="tm-active" data-id="${m.id}" data-active="${m.active ? '0' : '1'}">${m.active ? 'Deactivate' : 'Activate'}</button>`}<button class="btn btn-sm btn-outline" data-act="tm-pw" data-id="${m.id}">Reset password</button>${m.totp_enabled && m.id !== ME.id ? `<button class="btn btn-sm btn-outline" data-act="tm-2fa" data-id="${m.id}">Reset two-step</button>` : ''}</div></td></tr>`).join('');
  $('view').innerHTML = `<div class="pf-sec"><h4>Platform team</h4><p class="pf-note">Owners can change anything. Support accounts can look at companies, backups and billing but cannot change or delete anything; every company they open is recorded in the activity log.</p>
    <div class="tbl-scroll"><table><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Two-step</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div style="margin-top:10px;"><button class="btn btn-primary" data-act="newteam">+ Add team member</button></div></div>
    <div class="pf-sec"><h4>Console IP allow-list</h4><p class="pf-note">Only these addresses can open the console and its API (the public sign-in pages for companies are not affected). Leave empty to allow everywhere. One per line; ranges like 203.0.113.0/24 work. <b>Your current address: <span class="mono">${esc(sec.your_ip)}</span></b>${sec.override_active ? '<br><b style="color:var(--coral);">The server has PLATFORM_IP_ALLOWLIST_DISABLE=1, so the list is currently ignored.</b>' : ''}</p>
      <textarea id="ipList" class="pf-ta" placeholder="e.g. 203.0.113.5">${esc((sec.ip_allowlist || []).join('\n'))}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary" data-act="saveip">Save allow-list</button><button class="btn btn-outline" data-act="addmyip">Add my address</button></div>
      <p class="pf-note" style="margin-top:8px;">Locked out by mistake? On the server set <span class="mono">PLATFORM_IP_ALLOWLIST_DISABLE=1</span> in .env and restart.</p></div>`;
}
function openNewTeam() {
  openModal(`${modalHead('Add team member')}${field('User ID', '<input id="tmUser" autocomplete="off">')}${field('Full name', '<input id="tmName">')}${field('Email (optional)', '<input id="tmMail" type="email">')}
    ${field('Role', '<select id="tmRole"><option value="SUPPORT">Support — view only</option><option value="OWNER">Owner — full access</option></select>')}${field('Temporary password (8+, letters &amp; numbers)', '<input id="tmPass" type="text" autocomplete="off">')}
    <div id="tmErr" class="auth-err"></div><button class="btn btn-primary" data-act="saveteam">Create account</button><p class="pf-note" style="margin-top:8px;">They must choose their own password at first sign-in.</p>`, true);
}
async function teamPrompt(title, label, id, kind) {
  openModal(`${modalHead(title)}${field(label, '<input id="tpPass" type="text" autocomplete="off">')}<div id="tpErr" class="auth-err"></div><button class="btn btn-primary" data-act="tp-go" data-id="${id}">Reset</button>`, true);
}

// -------------------------------------------------------------- my security --
async function openSecurity() {
  const me = (await api('/me')).admin; ME = { ...ME, ...me };
  if (!ME.id) { toast('Not available for API-key access.'); return; }
  if (me.totp_enabled) {
    openModal(`${modalHead('My security')}<div class="pf-sec"><h4>Two-step verification <span class="badge badge-green">On</span></h4><p class="pf-note">Sign-in asks for a 6-digit code from your authenticator app after the password. To turn it off, confirm with your password and a current code (or a recovery code).</p>
      ${field('Password', '<input id="tfPass" type="password">')}${field('Code', '<input id="tfCode" inputmode="numeric">')}<div id="tfErr" class="auth-err"></div><button class="btn btn-danger" data-act="tf-off">Turn off two-step verification</button></div>`, true);
  } else {
    openModal(`${modalHead('My security')}<div class="pf-sec"><h4>Two-step verification <span class="badge badge-amber">Off</span></h4><p class="pf-note">${ME.role === 'OWNER' ? 'This account controls every company, so turning this on is strongly recommended. ' : ''}You will need an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).</p><button class="btn btn-primary" data-act="tf-start">Set up two-step verification</button></div>`, true);
  }
}
async function tfStart() {
  try {
    const r = await post('/me/2fa/setup', {});
    openModal(`${modalHead('Set up two-step verification')}<ol style="padding-left:18px;font-size:13px;line-height:1.7;"><li>Open your authenticator app and add an account by scanning this code (or typing the key).</li><li>Enter the 6-digit code it shows.</li></ol>
      <div class="pf-qr">${r.qr ? `<img src="${esc(r.qr)}" width="200" height="200" alt="QR code">` : ''}<div><div class="muted" style="font-size:12px;">Key (if you cannot scan)</div><div class="mono" style="font-size:14px;word-break:break-all;max-width:260px;">${esc(r.secret)}</div></div></div>
      ${field('6-digit code', '<input id="tfCode" inputmode="numeric" autocomplete="one-time-code">')}<div id="tfErr" class="auth-err"></div><button class="btn btn-primary" data-act="tf-on">Turn on</button>`, true);
  } catch (e) { toast(e.message); }
}
async function tfOn() {
  try { const r = await post('/me/2fa/enable', { code: val('tfCode') }); ME.totp_enabled = true;
    openModal(`${modalHead('Two-step verification is on')}<p class="pf-note"><b>Save these recovery codes now</b> — each works once if you lose your phone. They are not shown again.</p><div class="pf-codes">${r.recovery_codes.map((c) => `<div>${esc(c)}</div>`).join('')}</div><button class="btn btn-primary" data-act="closeModal">I have saved them</button>`, true);
  } catch (e) { $('tfErr').textContent = e.message; }
}
async function tfOff() { try { await post('/me/2fa/disable', { password: $('tfPass').value, code: val('tfCode') }); ME.totp_enabled = false; closeModal(); toast('Two-step verification turned off'); } catch (e) { $('tfErr').textContent = e.message; } }

// ----------------------------------------------------------------- settings --
async function renderSettings() {
  const [m, g] = await Promise.all([api('/settings/mail'), api('/settings/general')]); const c = m.mail;
  const log = m.log.map((l) => `<tr><td><small>${fmtDT(l.created_at)}</small></td><td>${esc(l.to_email || '')}</td><td>${esc(l.template || '')}</td><td>${l.status === 'SENT' ? '<span class="badge badge-green">Sent</span>' : `<span class="badge badge-red" title="${esc(l.error || '')}">Failed</span>`}${l.error ? `<br><small>${esc(l.error.slice(0, 80))}</small>` : ''}</td></tr>`).join('');
  $('view').innerHTML = `
    <div class="pf-sec"><h4>Platform email</h4><p class="pf-note">One mail account for the whole platform: request received / approved / rejected, "your account is approved" for company users, and plan-expiry reminders (15, 7 and 1 day before, then on expiry and when read-only starts). Companies keep their own email settings for their own invoices.</p>
      <label class="pf-chk" style="margin-bottom:10px;"><input type="checkbox" id="mlOn" ${c.enabled ? 'checked' : ''}> Send platform emails</label>
      <div class="pf-grid3">${field('SMTP host', `<input id="mlHost" value="${esc(c.host)}" placeholder="smtp.gmail.com">`)}${field('Port', `<input id="mlPort" type="number" value="${c.port}">`)}
        <label class="pf-chk" style="margin-top:24px;"><input type="checkbox" id="mlSecure" ${c.secure ? 'checked' : ''}> Secure (SSL, usually port 465)</label>
        ${field('SMTP user', `<input id="mlUser" value="${esc(c.user)}" autocomplete="off">`)}${field('SMTP password', `<input id="mlPass" type="password" autocomplete="new-password" placeholder="${c.password_set ? '•••••••• (unchanged)' : ''}">`)}
        ${field('"From" address', `<input id="mlFrom" value="${esc((c.from || '').replace(/[<>"]/g, ''))}" placeholder="SABIHA ERP noreply@yourdomain.com">`)}
        ${field('Name shown in emails', `<input id="mlBrand" value="${esc(c.brand)}">`)}${field('Website address for "Sign in" buttons', `<input id="mlUrl" value="${esc(c.app_url)}" placeholder="https://erp.yourdomain.com">`)}</div>
      <div id="mlErr" class="auth-err"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;"><button class="btn btn-primary" data-act="savemail">Save email settings</button>${field('Send a test to', '<input id="mlTo" type="email" style="min-width:230px">').replace('class="form-field"', 'class="form-field" style="margin:0;"')}<button class="btn btn-outline" data-act="testmail">Send test</button></div></div>
    <div class="pf-sec"><h4>Defaults &amp; support contact</h4>
      <div class="pf-grid3">${field('Default grace period after expiry (days)', `<input id="gnGrace" type="number" min="0" max="365" value="${g.subscription.grace_days}">`, 'Applied to new companies')}
        ${field('When a plan limit is reached (new companies)', `<select id="gnAct"><option value="WARN" ${g.subscription.limit_action === 'WARN' ? 'selected' : ''}>Show a warning only</option><option value="BLOCK" ${g.subscription.limit_action === 'BLOCK' ? 'selected' : ''}>Block new entries</option></select>`)}
        ${field('How companies should pay (shown on their Plan & Billing page)', `<textarea id="gnPay" class="pf-ta" placeholder="e.g. UPI: yourname@bank&#10;Bank: A/c 1234, IFSC …">${esc((g.payment || {}).instructions || '')}</textarea>`)}${field('Support contact name', `<input id="gnName" value="${esc((g.contact || {}).name || '')}">`)}${field('Support email', `<input id="gnMail" value="${esc((g.contact || {}).email || '')}">`)}${field('Support phone', `<input id="gnPhone" value="${esc((g.contact || {}).phone || '')}">`)}</div>
      <p class="pf-note" style="margin:8px 0;">The contact details are shown to companies in their expiry banners and emails.</p><button class="btn btn-primary" data-act="savegen">Save</button></div>
    <div class="pf-sec"><h4>Recent emails</h4><div class="tbl-scroll" style="max-height:260px;overflow:auto;"><table><thead><tr><th>When</th><th>To</th><th>Type</th><th>Result</th></tr></thead><tbody>${log || '<tr><td colspan="4">No emails sent yet</td></tr>'}</tbody></table></div></div>`;
}
async function saveMail() { try { await put('/settings/mail', { enabled: chk('mlOn'), host: val('mlHost'), port: val('mlPort'), secure: chk('mlSecure'), user: val('mlUser'), pass: $('mlPass').value, from: val('mlFrom'), brand: val('mlBrand'), app_url: val('mlUrl') }); toast('Email settings saved'); await renderSettings(); } catch (e) { $('mlErr').textContent = e.message; } }
async function testMail() { try { toast('Sending…'); await post('/settings/mail/test', { to: val('mlTo') }); toast('Test email sent — check the inbox'); await renderSettings(); } catch (e) { $('mlErr').textContent = e.message; } }
async function saveGeneral() { try { await put('/settings/general', { payment: { instructions: $('gnPay') ? $('gnPay').value : '' }, contact: { name: val('gnName'), email: val('gnMail'), phone: val('gnPhone') }, subscription: { grace_days: val('gnGrace'), limit_action: val('gnAct') } }); toast('Saved'); } catch (e) { toast(e.message); } }

// ------------------------------------------------------- plan requests -----
let PREQS = [], preqFilter = 'PENDING';
async function renderPlanRequests() {
  await ensurePlans();
  PREQS = (await api('/plan-requests' + (preqFilter ? '?status=' + preqFilter : ''))).requests; const ro = IS_SUPPORT();
  if (!MON) { try { MON = await api('/monitor'); } catch (_) { /* badge only */ } }
  const filters = ['PENDING', 'APPROVED', 'REJECTED', ''].map((f) => `<button class="btn btn-sm ${preqFilter === f ? 'btn-primary' : 'btn-outline'}" data-act="preqfilter" data-f="${f}">${f ? f[0] + f.slice(1).toLowerCase() : 'All'}</button>`).join(' ');
  const rows = PREQS.map((r) => { const p = PLANS.find((x) => x.code === r.plan_code); return `<tr><td><b>${esc(r.company_name || r.company_code)}</b><br><small class="mono">${esc(r.company_code)}</small></td>
    <td>${r.kind === 'RENEW' ? 'Renew' : r.kind === 'UPGRADE' ? 'Change to' : 'Buy'} <b>${esc(p ? p.name : r.plan_code)}</b><br><small>${r.months} month(s)${p ? ' · about ' + inr(p.price_monthly * r.months) : ''}</small></td>
    <td><small>${esc(r.requested_by || '')}${r.contact_email ? '<br>' + esc(r.contact_email) : ''}</small>${r.note ? `<br><small>“${esc(r.note)}”</small>` : ''}</td><td>${statusBadge(r.status)}<br><small>${fmtDT(r.created_at)}</small>${r.review_note ? `<br><small>${esc(r.review_note)}</small>` : ''}</td>
    <td>${r.status === 'PENDING' && !ro ? `<div class="pf-actions"><button class="btn btn-sm btn-primary" data-act="preq-ok" data-id="${r.id}">Approve…</button><button class="btn btn-sm btn-danger" data-act="preq-no" data-id="${r.id}">Reject…</button></div>` : ''}</td></tr>`; }).join('');
  $('view').innerHTML = `<p class="pf-note">Companies ask to buy, renew or change their plan from their <b>Plan &amp; Billing</b> page. Confirm the payment first, then approve — the plan and expiry date update automatically and a billing record is created.</p><div style="margin-bottom:12px;display:flex;gap:6px;flex-wrap:wrap;">${filters}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table><thead><tr><th>Company</th><th>Request</th><th>From</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:24px;">No plan requests</td></tr>'}</tbody></table></div></div>`;
}
function openPlanReqApprove(id) {
  const r = PREQS.find((x) => String(x.id) === String(id)); const p = PLANS.find((x) => x.code === r.plan_code);
  openModal(`${modalHead('Approve — ' + esc(r.company_name || r.company_code))}
    <p class="pf-note">Applies the plan now. ${r.kind === 'PURCHASE' ? 'A trial turns into this paid plan starting today.' : 'Renewals extend from the current expiry date (or today if it already expired).'}</p>
    ${field('Plan', `<select id="paPlan" onchange="paintPaAmount()">${planOptions(r.plan_code, false)}</select>`)}${field('Months', `<input id="paMonths" type="number" min="1" max="120" value="${r.months}" oninput="paintPaAmount()" style="max-width:120px">`)}
    ${field('Amount received / to bill (₹)', `<input id="paAmt" type="number" min="0" value="${p ? p.price_monthly * r.months : 0}" style="max-width:180px">`)}
    <label class="pf-chk" style="margin-bottom:10px;"><input type="checkbox" id="paBill" checked> Create a billing record for this amount</label>${field('Note to the company (optional)', '<input id="paNote">')}
    <div id="paErr" class="auth-err"></div><button class="btn btn-primary" data-act="preq-ok-go" data-id="${r.id}">Approve &amp; apply plan</button>`, true);
}
function paintPaAmount() { const p = PLANS.find((x) => x.code === val('paPlan')); if (p && $('paAmt')) $('paAmt').value = p.price_monthly * (Number(val('paMonths')) || 0); }

// ------------------------------------------------------------------ audit ---
async function renderAudit() {
  const r = await api('/audit?limit=300');
  const rows = r.logs.map((l) => `<tr><td><small>${fmtDT(l.created_at)}</small></td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td class="mono">${esc(l.target || '')}</td><td><small>${esc(l.ip || '')}</small></td></tr>`).join('');
  $('view').innerHTML = `<div class="panel" style="padding:0;"><div style="padding:14px 16px;"><h3 style="margin:0;">Platform activity log</h3><small class="muted">Sign-ins, approvals, plan changes, backups, restores, company views and password resets performed at platform level.</small></div><div class="tbl-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Nothing yet</td></tr>'}</tbody></table></div></div>`;
}

// --------------------------------------------------------- change password --
function openPasswordModal(forced) {
  openModal(`<h3><span>${forced ? 'Set a new password to continue' : 'Change password'}</span>${forced ? '' : '<button class="btn btn-sm btn-outline" data-act="closeModal">Close</button>'}</h3>
    ${forced ? '<p class="pf-note">You signed in with a temporary password. Choose your own before using the console.</p>' : ''}
    ${field('Current password', '<input id="pwCur" type="password" autocomplete="current-password">')}${field('New password (8+ characters, letters &amp; numbers)', '<input id="pwNew" type="password" autocomplete="new-password">')}
    <div id="pwErr" class="auth-err"></div><button class="btn btn-primary" id="pwGo">Change Password</button>`, true);
}
async function doChangePassword() { $('pwErr').textContent = ''; try { await post('/me/change-password', { current_password: $('pwCur').value, new_password: $('pwNew').value }); closeModal(); toast('Password changed'); ME.must_change_password = false; await boot(); } catch (e) { $('pwErr').textContent = e.message; } }

// ------------------------------------------------------------- event wiring -
const ACT = {
  closeModal, approve: (t) => openApprove(t.dataset.id), reject: (t) => openReject(t.dataset.id),
  editplan: (t) => openPlan(t.dataset.code), saveplan: (t) => savePlan(t.dataset.code),
  delplan: async (t) => { if (!confirm('Delete this plan?')) return; try { await del('/plans/' + encodeURIComponent(t.dataset.code)); toast('Plan deleted'); renderPlans(); } catch (e) { toast(e.message); } },
  savesub: (t) => saveSub(t.dataset.code), savebrand: (t) => saveBrand(t.dataset.code, false), rmlogo: (t) => saveBrand(t.dataset.code, true), startplan: (t) => startPlan(t.dataset.code),
  copylink: (t, ev) => { ev.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(t.dataset.link); toast('Link copied'); },
  'backup-d': async (t) => { try { toast('Backing up…'); await post(`/companies/${encodeURIComponent(t.dataset.code)}/backups`, {}); toast('Backup saved'); await openDetail(t.dataset.code); } catch (e) { toast(e.message); } },
  'bk-restore': async (t) => { if (!confirm('Replace ALL current data of this company with this backup?\n\nA safety copy of the current data is taken first.')) return; try { toast('Restoring…'); const r = await post(`/backups/${t.dataset.id}/restore`, {}); toast('Restored. Safety copy: ' + r.safety_copy); MON = null; if (TAB === 'backups') renderBackups(); else if (t.dataset.code) openDetail(t.dataset.code); } catch (e) { toast(e.message); } },
  'bk-new': (t) => openRestoreNew(t.dataset.id, t.dataset.code),
  'bk-new-go': async (t) => { try { toast('Creating…'); const r = await post(`/backups/${t.dataset.id}/restore-as-new`, { company_code: val('rnCode'), company_name: val('rnName') }); closeModal(); MON = null; toast('New company ' + r.company_code + ' created from backup'); go('companies'); } catch (e) { if ($('rnErr')) $('rnErr').textContent = e.message; else toast(e.message); } },
  'bk-dl': (t) => downloadBackup(t.dataset.id),
  'bk-del': async (t) => { if (!confirm('Delete this backup file permanently?')) return; try { await del('/backups/' + t.dataset.id); toast('Deleted'); if (t.dataset.code) openDetail(t.dataset.code); else renderBackups(); } catch (e) { toast(e.message); } },
  savebk: async () => { try { await put('/backup-settings', { nightly_enabled: chk('bkOn'), hour: val('bkHour'), keep_nightly: val('bkN'), keep_manual: val('bkM') }); toast('Backup settings saved'); } catch (e) { toast(e.message); } },
  runall: async () => { try { toast('Backing up all companies…'); const r = await post('/backups/run-all', {}); toast(`${r.ok} backed up${r.failed.length ? ', ' + r.failed.length + ' failed' : ''}`); renderBackups(); } catch (e) { toast(e.message); } },
  newbill: openNewBill, savebill: saveBill, paybill: (t) => openPay(t.dataset.id), paygo: (t) => doPay(t.dataset.id),
  voidbill: async (t) => { if (!confirm('Cancel this billing record?')) return; try { await post(`/billing/${t.dataset.id}/void`, {}); renderBilling(); } catch (e) { toast(e.message); } },
  editann: (t) => openAnn(t.dataset.id), saveann: (t) => saveAnn(t.dataset.id),
  toggleann: async (t) => { const a = ANNS.find((x) => String(x.id) === t.dataset.id); try { await put('/announcements/' + a.id, { active: !a.active }); renderAnnouncements(); } catch (e) { toast(e.message); } },
  delann: async (t) => { if (!confirm('Delete this announcement?')) return; try { await del('/announcements/' + t.dataset.id); renderAnnouncements(); } catch (e) { toast(e.message); } },
  newteam: openNewTeam,
  saveteam: async () => { try { await post('/team', { username: val('tmUser'), full_name: val('tmName'), email: val('tmMail'), role: val('tmRole'), password: $('tmPass').value }); closeModal(); toast('Account created'); renderTeam(); } catch (e) { $('tmErr').textContent = e.message; } },
  'tm-role': async (t) => { try { await put('/team/' + t.dataset.id, { role: t.dataset.role }); renderTeam(); } catch (e) { toast(e.message); } },
  'tm-active': async (t) => { try { await put('/team/' + t.dataset.id, { active: t.dataset.active === '1' }); renderTeam(); } catch (e) { toast(e.message); } },
  'tm-pw': (t) => teamPrompt('Reset password', 'Temporary password (8+, letters & numbers)', t.dataset.id),
  'tp-go': async (t) => { try { await post(`/team/${t.dataset.id}/reset-password`, { new_password: $('tpPass').value }); closeModal(); toast('Password reset — they must change it at next sign-in'); } catch (e) { $('tpErr').textContent = e.message; } },
  'tm-2fa': async (t) => { if (!confirm('Turn off two-step sign-in for this person (for example, they lost their phone)?')) return; try { await post(`/team/${t.dataset.id}/reset-2fa`, {}); toast('Two-step reset'); renderTeam(); } catch (e) { toast(e.message); } },
  saveip: async () => { try { await put('/security', { ip_allowlist: $('ipList').value }); toast('Allow-list saved'); renderTeam(); } catch (e) { toast(e.message); } },
  addmyip: async () => { try { const s = await api('/security'); const cur = $('ipList').value.split(/[\s,;]+/).filter(Boolean); if (!cur.includes(s.your_ip)) cur.push(s.your_ip); $('ipList').value = cur.join('\n'); } catch (e) { toast(e.message); } },
  'tf-start': tfStart, 'tf-on': tfOn, 'tf-off': tfOff,
  savemail: saveMail, testmail: testMail, savegen: saveGeneral,
  'renew-go': (t) => doRenew(t.dataset.code, t.dataset.m),
  preqfilter: (t) => { preqFilter = t.dataset.f; renderPlanRequests(); },
  'preq-ok': (t) => openPlanReqApprove(t.dataset.id),
  'preq-ok-go': async (t) => { try { await post(`/plan-requests/${t.dataset.id}/approve`, { plan_code: val('paPlan'), months: val('paMonths'), amount: val('paAmt'), issue_invoice: chk('paBill'), note: val('paNote') }); closeModal(); toast('Approved — plan applied'); MON = null; await renderPlanRequests(); loadMonitor(false).catch(() => {}); } catch (e) { $('paErr').textContent = e.message; } },
  'preq-no': (t) => openModal(`${modalHead('Reject plan request')}${field('Reason (shown to the company)', '<input id="prNote">')}<button class="btn btn-danger" data-act="preq-no-go" data-id="${t.dataset.id}">Reject</button>`, true),
  'preq-no-go': async (t) => { try { await post(`/plan-requests/${t.dataset.id}/reject`, { note: val('prNote') }); closeModal(); toast('Request rejected'); MON = null; renderPlanRequests(); } catch (e) { toast(e.message); } },
};
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-tab],[data-act],[data-filter],[data-bfilter],#lgBtn,#ccGo,#rpGo,#apGo,#rjGo,#pwGo,#btnRefresh,#btnPw,#btnSec,#btnOut');
  if (!t) return;
  if (t.id === 'lgBtn') return void doLogin();
  if (t.id === 'btnRefresh') return void (TAB === 'dashboard' ? loadMonitor(true) : go(TAB));
  if (t.id === 'btnPw') return void openPasswordModal(false);
  if (t.id === 'btnSec') return void openSecurity();
  if (t.id === 'btnOut') return void signOut();
  if (t.id === 'ccGo') return void doCreate();
  if (t.id === 'rpGo') return void doResetPassword(t.dataset.code);
  if (t.id === 'apGo') return void doApprove(t.dataset.id);
  if (t.id === 'rjGo') return void doReject(t.dataset.id);
  if (t.id === 'pwGo') return void doChangePassword();
  if (t.dataset.tab) return void go(t.dataset.tab);
  if (t.hasAttribute('data-filter')) { reqFilter = t.dataset.filter; return void loadRequests(); }
  if (t.hasAttribute('data-bfilter')) { billFilter = t.dataset.bfilter; return void renderBilling(); }
  const act = t.dataset.act;
  if (ACT[act]) return void ACT[act](t, ev);
  if (['detail', 'suspend', 'activate', 'resetpw', 'renew', 'backup', 'archive', 'unarchive'].includes(act)) return void companyAction(act, t.dataset.code);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('loginView').classList.contains('hidden')) doLogin(); if (e.key === 'Escape' && !ME?.must_change_password) closeModal(); });
$('mBg').addEventListener('click', (e) => { if (e.target === $('mBg') && !ME?.must_change_password) closeModal(); });

if (TOKEN) boot(); else showLogin();
