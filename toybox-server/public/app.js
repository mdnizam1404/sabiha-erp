// ============================================================================
// SABIHA ERP — frontend application logic
// ============================================================================
const API = '/api';
let TOKEN = localStorage.getItem('sabiha_token') || '';
let ME = null;
let COMPANY = null;
let CACHE = {}; // simple in-memory cache per list endpoint, refreshed on demand

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
// POST/PUT calls that are NOT "the user saved a record" — no save-confirmation
// popup for these; each already has its own appropriate feedback, and a
// "Your data has been saved" popup here would be actively confusing.
const SAVE_POPUP_EXCLUDED_PATHS = ['/auth/login', '/auth/login/resend-otp', '/auth/login/verify-otp', '/auth/verify-admin-password', '/auth/register', '/auth/register/start', '/auth/register/verify', '/auth/register/resend', '/auth/forgot-password', '/reminders', '/restore'];
let pendingSavePopup = false;
function isSaveEndpoint(path, method) {
  if (method !== 'POST' && method !== 'PUT') return false;
  if (path.includes('/pdf') || path.includes('/move')) return false;
  if (/\/users\/\d+\/(role|status)$/.test(path)) return false; // inline dropdown toggles on the Users page, not a form save
  return !SAVE_POPUP_EXCLUDED_PATHS.some((p) => path === p || path.startsWith(p + '?'));
}
async function api(path, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) };
  const method = String(opts.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET';
  const canQueue = isWrite && window.OFF && OFF.canQueue(path);
  const qkey = canQueue ? OFF.newKey() : null;
  if (qkey) opts.headers['X-Idempotency-Key'] = qkey;
  let res, data;
  try {
    res = await fetch(API + path, opts);
    if (window.OFF && OFF.isNetFail(null, res)) throw new TypeError('offline');
    data = await res.json().catch(() => ({}));
    if (window.OFF) OFF.setOnline(true);
  } catch (netErr) {
    if (!(window.OFF && OFF.isNetFail(netErr, null))) throw netErr;
    OFF.setOnline(false);
    if (path.startsWith('/auth/')) throw new Error('No internet connection. You need to be online to sign in.');
    if (!isWrite) {
      const c = await OFF.getCache(path);
      if (c) { OFF.stale = true; return c.data; }
      throw new Error('You are offline and this screen has not been opened on this computer before. Connect once to load it.');
    }
    if (canQueue) {
      let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { /* not JSON */ }
      const item = await OFF.enqueue(method, path, body);
      showToast('Saved on this computer — it will sync automatically when you are online');
      return { queued: true, offline: true, queue_key: item.key };
    }
    throw new Error('This action needs an internet connection.');
  }
  // The login request itself can also return 401 (wrong User ID/password) —
  // that must NOT be treated as "session expired" (there is no session yet),
  // otherwise the real "wrong credentials" message from the backend never
  // reaches the login screen and gets replaced by the generic expiry text.
  if (res.status === 401 && path !== '/auth/login') { doLogout(true); throw new Error('Session expired — please log in again'); }
  if (!res.ok) { if (data.plan_module || data.read_only || data.plan_limit) showPlanPopup(data); const err = new Error(data.error || 'Request failed'); err.data = data; throw err; }
  if (!isWrite && window.OFF) OFF.putCache(path, data);
  if (isSaveEndpoint(path, opts.method)) pendingSavePopup = true;
  const pw = res.headers.get('X-Plan-Warning');
  if (pw) { try { setTimeout(() => showToast(decodeURIComponent(pw)), 400); } catch (_) { /* header is informational */ } }
  return data;
}
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtDate = (d) => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const todayISO = () => new Date().toISOString().slice(0, 10);
let suppressNextToast = false;
function showUnlockedIncentives(unlocked) {
  if (!unlocked || !unlocked.length) return;
  const total = unlocked.reduce((s,r)=>s+Number(r.reward_amount||0),0);
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3 style="color:var(--green);">🎉 Target Achieved!</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:14px; margin-bottom:12px;">Congratulations <b>${unlocked[0].employee_name||'Employee'}</b> — a new incentive/reward has been unlocked.</p>
      ${unlocked.map(r=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:7px;"><span><b>${r.rule_name}</b><br><small>${r.trigger_type} · ${r.period} · ${Number(r.achieved_value).toLocaleString('en-IN')} / ${Number(r.target_value).toLocaleString('en-IN')}</small></span><strong style="color:var(--green);">${inr(r.reward_amount)}</strong></div>`).join('')}
      <div style="text-align:right;font-weight:700;margin-top:10px;">Total unlocked: ${inr(total)}</div>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="closeModal()">Continue</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function showToast(msg) {
  if (suppressNextToast) { suppressNextToast = false; return; }
  if (window.__planMsg && msg === window.__planMsg && Date.now() - window.__planMsgAt < 5000) return; // the plan pop-up already told the user
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(window.__t); window.__t = setTimeout(() => t.classList.remove('show'), 2400);
}
// Shown automatically right after any Add/Edit save succeeds (see closeModal
// below, and the inline-save functions that call this directly since they
// don't use a modal at all) — a deliberate, must-acknowledge confirmation
// rather than a passing toast, since the person asked to be sure their data
// was saved before moving on.
function showSavedPopup() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Saved</h3></div>
    <div class="modal-body"><p style="font-size:14.5px;">Your data has been saved.</p></div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="closeModal()">Continue</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
// Consumes the pending-save flag exactly once, wherever a save flow ends —
// whether that's closing a modal, or an inline (no-modal) save on a page
// like Settings. Consuming it here (rather than leaving it set until some
// later unrelated modal happens to close) is what prevents the popup from
// firing at the wrong time.
function triggerSavedPopupIfPending() {
  if (pendingSavePopup) {
    pendingSavePopup = false;
    suppressNextToast = true; // the caller's own showToast('X saved') right after this would be redundant
    showSavedPopup();
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  document.getElementById('themeToggle').textContent = mode === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('sabiha_theme', mode);
}
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

// ---------------------------------------------------------------------------
// Branding (logo + name) — applied once company settings are loaded
// ---------------------------------------------------------------------------
function applyBranding() {
  if (!COMPANY) return;
  // The login page's logo and "SABIHA ERP" name are the package developer's
  // own branding — set once in index.html and never touched here, so an
  // admin uploading their own company logo in Settings can't change it.
  // Only the in-app sidebar (after login) reflects the customer's own
  // company name and logo, since that's what Settings actually controls.
  document.getElementById('brandName').textContent = COMPANY.company_name || 'SABIHA ERP';
  if (COMPANY.logo_data_url) {
    document.getElementById('brandMark').innerHTML = `<img src="${COMPANY.logo_data_url}">`;
  }
}

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------
function switchAuthTab(which) {
  document.getElementById('tabLoginBtn').classList.toggle('active', which === 'login');
  document.getElementById('tabRegisterBtn').classList.toggle('active', which === 'register');
  document.getElementById('tabCompanyBtn').classList.toggle('active', which === 'company');
  document.getElementById('loginPane').classList.toggle('hidden', which !== 'login');
  document.getElementById('registerPane').classList.toggle('hidden', which !== 'register');
  document.getElementById('registerCompanyPane').classList.toggle('hidden', which !== 'company');
  document.getElementById('registerOtpPane').classList.add('hidden');
  document.getElementById('forgotPane').classList.add('hidden');
  // carry the company already typed on Sign In into Create Account
  if (which === 'register') {
    const rc = document.getElementById('regCompany'); const lc = (document.getElementById('loginCompany')?.value || '').trim().toUpperCase();
    if (rc && !rc.value && lc && lc !== 'DEFAULT') { rc.value = lc; lookupCompany('regCompany', 'regCompanyName'); }
  }
}
// ---- Company selector (public list of active companies) --------------------
async function loadPublicCompanies() {
  try {
    const r = await api('/platform/public/companies');
    document.getElementById('companyList').innerHTML = (r.companies || []).map((c) => `<option value="${escapeAuthText(c.company_code)}">${escapeAuthText(c.company_name)}</option>`).join('');
  } catch (e) { /* selector is optional — users can still type the Company ID */ }
}
let __lookupTimer = null;
function lookupCompanySoon(inputId, labelId) { clearTimeout(__lookupTimer); __lookupTimer = setTimeout(() => lookupCompany(inputId, labelId), 350); }
async function lookupCompany(inputId, labelId) {
  const el = document.getElementById(inputId); const out = document.getElementById(labelId);
  if (!el || !out) return null;
  const code = el.value.trim().toUpperCase();
  if (!code) { out.textContent = ''; return null; }
  try {
    const c = await api('/platform/public/companies/' + encodeURIComponent(code));
    out.style.color = 'var(--green)'; out.textContent = '✓ ' + c.company_name; el.value = c.company_code;
    if (inputId === 'loginCompany') applyLoginBranding(c);
    return c;
  } catch (e) { out.style.color = 'var(--coral)'; out.textContent = 'No active company found with that ID'; if (inputId === 'loginCompany') applyLoginBranding(null); return null; }
}
// The sign-in page switches to the company's own logo, name and colour once its Company ID is known.
function applyLoginBranding(c) {
  const mark = document.getElementById('authMark'); const name = document.getElementById('authBrandName');
  const wrap = document.getElementById('authLogoWrap'); const tag = document.getElementById('loginTagline');
  const side = document.querySelector('.auth-side'); const card = document.querySelector('.auth-card');
  if (!c) {
    mark.innerHTML = '<img src="/assets/sabiha-logo.jpg" alt="SABIHA ERP">'; name.textContent = 'SABIHA ERP'; wrap.classList.remove('auth-brand-custom');
    tag.style.display = 'none'; if (card) card.style.removeProperty('--brand'); if (side) side.style.removeProperty('background'); document.title = 'SABIHA ERP — Manufacturing Suite';
    document.querySelectorAll('#authScreen .btn-primary').forEach((b) => b.style.removeProperty('background'));
    return;
  }
  name.textContent = c.display_name || c.company_name;
  document.title = (c.display_name || c.company_name) + ' — Sign in';
  if (c.logo_data_url) { mark.innerHTML = `<img src="${c.logo_data_url}" alt="">`; wrap.classList.add('auth-brand-custom'); }
  else { mark.innerHTML = '<img src="/assets/sabiha-logo.jpg" alt="SABIHA ERP">'; wrap.classList.remove('auth-brand-custom'); }
  tag.textContent = c.tagline || ''; tag.style.display = c.tagline ? '' : 'none';
  const col = /^#[0-9a-fA-F]{6}$/.test(c.primary_color || '') ? c.primary_color : null;
  if (side) side.style.background = col ? `linear-gradient(160deg, ${col}, #0B1330)` : '';
  document.querySelectorAll('#authScreen .btn-primary').forEach((b) => { if (col) b.style.background = col; else b.style.removeProperty('background'); });
}
// Optional link  /c/LOTUS  opens the sign-in page already branded for that company.
function companyFromPath() { const m = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{3,31})\/?$/); return m ? m[1].toUpperCase() : null; }
document.addEventListener('DOMContentLoaded', async () => {
  const code = companyFromPath(); if (!code) return;
  const el = document.getElementById('loginCompany'); if (!el) return;
  el.value = code;
  const u = document.getElementById('loginUser'); const pw = document.getElementById('loginPass'); const hint = document.getElementById('demoHint');
  if (u) u.value = ''; if (pw) pw.value = ''; if (hint) hint.style.display = 'none';
  const lbl = document.getElementById('loginCompanyName'); await lookupCompany('loginCompany', lbl ? 'loginCompanyName' : 'loginCompanyNameTmp');
});
document.addEventListener('DOMContentLoaded', loadPublicCompanies);
let loginOtpChallengeId = null;
async function doLogin() {
  const errEl = document.getElementById('loginErr'); errEl.textContent = '';
  closeAuthErrPopup();
  const company_code = (document.getElementById('loginCompany')?.value || 'DEFAULT').trim().toUpperCase();
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in...'; }
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ company_code, username, password }) });
    if (data.otp_required) {
      loginOtpChallengeId = data.challenge_id;
      document.getElementById('loginOtpTarget').textContent = data.message || `A 6-digit OTP was sent by SMS to ${data.masked_phone || 'your registered mobile number'}.`;
      document.getElementById('loginOtpCode').value = '';
      document.getElementById('loginOtpErr').textContent = '';
      document.getElementById('loginOtpPane').classList.remove('hidden');
      document.getElementById('loginOtpCode').focus();
      if (loginBtn) loginBtn.classList.add('hidden');
      return;
    }
    await finishLogin(data);
  } catch (e) {
    errEl.textContent = e.message || 'Sign in failed. Please try again.';
    const locked = !!(e.data && e.data.locked);
    showWrongLoginPopup(e.message || 'Sign in failed. Please check your User ID and password.', locked);
  } finally {
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In'; }
  }
}
async function finishLogin(data) {
  TOKEN = data.token; ME = data.user;
  localStorage.setItem('sabiha_token', TOKEN);
  await boot(true);
}
async function verifyLoginOtp() {
  const err = document.getElementById('loginOtpErr'); const btn = document.getElementById('loginOtpBtn');
  err.textContent = '';
  const code = document.getElementById('loginOtpCode').value.trim();
  if (!loginOtpChallengeId) { err.textContent = 'Please start sign in again.'; return; }
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit OTP sent to your mobile.'; return; }
  btn.disabled = true; btn.textContent = 'Verifying...';
  try { await finishLogin(await api('/auth/login/verify-otp', { method:'POST', body:JSON.stringify({ challenge_id:loginOtpChallengeId, code, company_code:(document.getElementById('loginCompany')?.value||'DEFAULT').trim().toUpperCase() }) })); }
  catch(e) { err.textContent = e.message || 'OTP verification failed.'; }
  finally { btn.disabled = false; btn.textContent = 'Verify OTP & Sign In'; }
}
async function resendLoginOtp() {
  const err = document.getElementById('loginOtpErr'); err.textContent = '';
  if (!loginOtpChallengeId) { err.textContent = 'Please start sign in again.'; return; }
  try { const r = await api('/auth/login/resend-otp', {method:'POST',body:JSON.stringify({challenge_id:loginOtpChallengeId, company_code:(document.getElementById('loginCompany')?.value||'DEFAULT').trim().toUpperCase()})}); if (r.challenge_id) loginOtpChallengeId=r.challenge_id; document.getElementById('loginOtpTarget').textContent = r.message || 'A new OTP was sent by SMS.'; showToast('New OTP sent'); }
  catch(e) { err.textContent = e.message || 'Could not resend OTP.'; }
}
function cancelLoginOtp() {
  loginOtpChallengeId = null;
  document.getElementById('loginOtpPane').classList.add('hidden');
  document.getElementById('loginOtpCode').value = '';
  document.getElementById('loginOtpErr').textContent = '';
  document.getElementById('loginBtn').classList.remove('hidden');
}
function escapeAuthText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
}
function showWrongLoginPopup(message, locked) {
  const safeMessage = escapeAuthText(message || 'Wrong User ID or password. Please check both fields and try again.');
  document.getElementById('authErrBox').innerHTML = `
    <div class="modal-head"><h3 style="${locked ? 'color:var(--coral);' : ''}">${locked ? '🔒 Account Locked' : 'Sign In Failed'}</h3><button class="modal-close" onclick="closeAuthErrPopup()">×</button></div>
    <div class="modal-body"><p>${safeMessage}</p></div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="closeAuthErrPopup()">OK</button></div>`;
  document.getElementById('authErrBg').classList.add('show');
}
function closeAuthErrPopup() { document.getElementById('authErrBg').classList.remove('show'); }
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter') && document.getElementById('authScreen') && !document.getElementById('authScreen').classList.contains('hidden') && !document.getElementById('loginPane').classList.contains('hidden')) { const active = document.activeElement; if (active && (active.id === 'loginUser' || active.id === 'loginPass')) { e.preventDefault(); doLogin(); } } });
let regToken = null;
let regCompanyCode = '';
async function doRegisterStart() {
  const errEl = document.getElementById('regErr'); const okEl = document.getElementById('regOk');
  errEl.textContent = ''; okEl.textContent = '';
  try {
    const company = await lookupCompany('regCompany', 'regCompanyName');
    if (!company) throw new Error('Please select your company (enter a valid Company ID) first.');
    regCompanyCode = company.company_code;
    const body = {
      company_code: regCompanyCode,
      full_name: document.getElementById('regName').value, username: document.getElementById('regUser').value, password: document.getElementById('regPass').value,
      role: document.getElementById('regRole').value, email: document.getElementById('regEmail').value.trim(), phone: document.getElementById('regPhone').value.trim(),
    };
    const data = await api('/auth/register/start', { method: 'POST', body: JSON.stringify(body) });
    regToken = data.token;
    document.getElementById('registerPane').classList.add('hidden');
    document.getElementById('registerOtpPane').classList.remove('hidden');
    document.getElementById('regOtpTarget').textContent = data.message;
    document.getElementById('regOtpCode').value = '';
    document.getElementById('regOtpErr').textContent = '';
    document.getElementById('regOtpOk').textContent = data.devCode ? '' : '';
    if (data.devCode) document.getElementById('regOtpCode').value = data.devCode; // offline fallback — no mail/SMS gateway configured, code shown directly
  } catch (e) { errEl.textContent = e.message; }
}
async function doRegisterVerify() {
  const errEl = document.getElementById('regOtpErr'); const okEl = document.getElementById('regOtpOk');
  errEl.textContent = ''; okEl.textContent = '';
  try {
    const data = await api('/auth/register/verify', { method: 'POST', body: JSON.stringify({ company_code: regCompanyCode, token: regToken, code: document.getElementById('regOtpCode').value.trim() }) });
    okEl.textContent = data.message + ' Your Company ID is ' + regCompanyCode + '.';
    document.getElementById('loginCompany').value = regCompanyCode;
    setTimeout(() => { switchAuthTab('login'); }, 3500);
  } catch (e) { errEl.textContent = e.message; }
}
async function doRegisterResend() {
  const errEl = document.getElementById('regOtpErr'); const okEl = document.getElementById('regOtpOk');
  errEl.textContent = '';
  try {
    const data = await api('/auth/register/resend', { method: 'POST', body: JSON.stringify({ company_code: regCompanyCode, token: regToken }) });
    okEl.textContent = data.message;
    if (data.devCode) document.getElementById('regOtpCode').value = data.devCode;
  } catch (e) { errEl.textContent = e.message; }
}
function backToRegisterForm() {
  document.getElementById('registerOtpPane').classList.add('hidden');
  document.getElementById('registerPane').classList.remove('hidden');
}
async function doCompanyRequest() {
  const errEl = document.getElementById('crErr'); const okEl = document.getElementById('crOk');
  errEl.textContent = ''; okEl.textContent = '';
  const v = (id) => document.getElementById(id).value.trim();
  try {
    if (document.getElementById('crPass').value !== document.getElementById('crPass2').value) throw new Error('The two passwords do not match.');
    const data = await api('/platform/public/company-requests', { method: 'POST', body: JSON.stringify({
      company_name: v('crName'), requested_code: v('crCode'), contact_name: v('crContact'), email: v('crEmail'), phone: v('crPhone'), city: v('crCity'),
      admin_username: v('crUser'), admin_password: document.getElementById('crPass').value, notes: v('crNotes') }) });
    okEl.innerHTML = `✓ Request submitted. Your reference number is <b>${data.reference}</b> — keep it. The platform owner will review your request; check the status below any time.`;
    document.getElementById('crTrackRef').value = data.reference;
    ['crPass', 'crPass2'].forEach((id) => { document.getElementById(id).value = ''; });
  } catch (e) { errEl.textContent = e.message; }
}
async function checkCompanyRequest() {
  const out = document.getElementById('crTrackOut');
  const ref = document.getElementById('crTrackRef').value.trim().toUpperCase();
  if (!ref) { out.textContent = 'Enter your reference number.'; return; }
  try {
    const r = await api('/platform/public/company-requests/' + encodeURIComponent(ref));
    const name = escapeAuthText(r.company_name);
    if (r.status === 'APPROVED') { out.style.color = 'var(--green)'; out.innerHTML = `✓ <b>Approved</b> — ${name}. Your Company ID is <b>${escapeAuthText(r.assigned_code)}</b>. Sign in with the admin User ID and password you chose.`; }
    else if (r.status === 'REJECTED') { out.style.color = 'var(--coral)'; out.innerHTML = `✗ <b>Not approved</b> — ${name}.${r.review_note ? ' Reason: ' + escapeAuthText(r.review_note) : ''}`; }
    else { out.style.color = 'var(--amber)'; out.innerHTML = `⏳ <b>Waiting for approval</b> — ${name}. Submitted ${new Date(r.created_at).toLocaleString()}.`; }
  } catch (e) { out.style.color = 'var(--coral)'; out.textContent = e.message; }
}
function openForgotPassword() {
  document.getElementById('loginPane').classList.add('hidden');
  document.getElementById('registerPane').classList.add('hidden');
  document.getElementById('forgotPane').classList.remove('hidden');
  document.getElementById('forgotMsg').textContent = '';
  document.getElementById('forgotUser').value = document.getElementById('loginUser').value || '';
}
function closeForgotPassword() {
  document.getElementById('forgotPane').classList.add('hidden');
  document.getElementById('loginPane').classList.remove('hidden');
}
async function submitForgotPassword() {
  const msgEl = document.getElementById('forgotMsg');
  try {
    const data = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ company_code: (document.getElementById('loginCompany')?.value || '').trim().toUpperCase(), username: document.getElementById('forgotUser').value }) });
    msgEl.style.color = 'var(--green)'; msgEl.textContent = data.message;
  } catch (e) { msgEl.style.color = 'var(--coral)'; msgEl.textContent = e.message; }
}
function doLogout(silent) {
  if (!silent && window.OFF) OFF.onLogout(); // a manual sign-out removes the saved offline copy of the data from this computer (unsent changes are kept)
  TOKEN = ''; ME = null; localStorage.removeItem('sabiha_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  if (!silent) showToast('Logged out');
}
function toggleUserMenu() { document.getElementById('userMenu').classList.toggle('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.user-chip')) document.getElementById('userMenu')?.classList.add('hidden'); });
function toggleNotifPanel() { document.getElementById('notifPanel').classList.toggle('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.notif-bell')) document.getElementById('notifPanel')?.classList.add('hidden'); });

// ---------------------------------------------------------------------------
// Notifications — low stock (raw material & finished goods), overdue
// invoices, and loans due soon, pulled together into the bell dropdown.
// While the app is open, a new alert since the last check also fires a
// desktop Notification (if the browser permission was granted) — this is
// an in-app / browser-notification system, not offline push: it only
// fires while a tab is open, since that's what this app can do without a
// push-notification service in front of it.
// ---------------------------------------------------------------------------
let __notifSeenKeys = new Set();
async function fetchNotifications() {
  const alerts = [];
  try {
    const stock = await api('/reports/stock');
    (stock.raw || []).filter((m) => m.stock < m.min_stock).forEach((m) => alerts.push({
      key: `rawlow-${m.id}`, kind: 'stock', severity: 'warn',
      text: `Low stock: ${m.name} — only ${m.stock} ${m.unit} left (min ${m.min_stock})`, goTo: 'inventory',
    }));
    (stock.products || []).filter((p) => p.stock < p.min_stock).forEach((p) => alerts.push({
      key: `prodlow-${p.id}`, kind: 'stock', severity: 'warn',
      text: `Low stock: ${p.name} — only ${p.stock} ${p.unit} left (min ${p.min_stock})`, goTo: 'inventory',
    }));
  } catch (e) { /* non-critical */ }
  try {
    const sales = await api('/sales');
    const today = todayISO();
    sales.filter((s) => s.balance > 0 && s.due_date && s.due_date < today).slice(0, 20).forEach((s) => alerts.push({
      key: `inv-${s.id}`, kind: 'invoice', severity: 'danger',
      text: `Overdue: ${s.invoice_no} — ${s.customer_name} owes ${inr(s.balance)} (due ${fmtDate(s.due_date)})`, goTo: 'customersSales',
    }));
  } catch (e) { /* non-critical */ }
  try {
    const loansDue = await api('/loans-due');
    loansDue.forEach((l) => alerts.push({
      key: `loan-${l.id}`, kind: 'loan', severity: l.overdue ? 'danger' : 'warn',
      text: `${l.overdue ? 'Overdue' : 'Due soon'}: ${l.loan_no} — ${l.lender_name}, ${inr(l.outstanding)} outstanding (due ${fmtDate(l.due_date)})`, goTo: 'loans',
    }));
  } catch (e) { /* non-critical */ }
  return alerts;
}
async function refreshNotifications(announceNew) {
  if (!ME) return;
  const alerts = await fetchNotifications();
  const badge = document.getElementById('notifBadge');
  const panel = document.getElementById('notifPanel');
  if (!badge || !panel) return;
  if (alerts.length) { badge.textContent = alerts.length > 9 ? '9+' : alerts.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  panel.innerHTML = `<div class="notif-panel-head"><span>Notifications</span></div>` +
    (alerts.length ? alerts.map((a) => `
      <div class="notif-item" onclick="closeModal(); goTo('${a.goTo}'); document.getElementById('notifPanel').classList.add('hidden');">
        <span class="n-dot" style="background:${a.severity==='danger'?'var(--coral)':'#E0A62B'};"></span><span>${a.text}</span>
      </div>`).join('') : '<div class="notif-empty">You\'re all caught up 🎉</div>');
  if (announceNew && 'Notification' in window && Notification.permission === 'granted') {
    const newOnes = alerts.filter((a) => !__notifSeenKeys.has(a.key));
    newOnes.slice(0, 3).forEach((a) => new Notification(COMPANY?.company_name || 'SABIHA ERP', { body: a.text }));
  }
  __notifSeenKeys = new Set(alerts.map((a) => a.key));
}
function startNotificationPolling() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  refreshNotifications(false);
  clearInterval(window.__notifTimer);
  window.__notifTimer = setInterval(() => refreshNotifications(true), 5 * 60 * 1000); // every 5 minutes
}

// ---------------------------------------------------------------------------
// Boot — loads company profile publicly, then (if token) the app shell
// ---------------------------------------------------------------------------
async function loadCompanyPublic() {
  try { COMPANY = await api('/settings'); applyBranding(); } catch (e) { /* ignore on auth screen */ }
  try {
    const v = await api('/version');
    document.querySelectorAll('.sabiha-version').forEach((el) => { el.textContent = `SABIHA ERP v${v.version}`; });
  } catch (e) { /* non-critical */ }
}
async function boot(fromLogin = false) {
  closeAuthErrPopup();
  const sessionUser = ME;
  try {
    // After a successful login the login response already contains the
    // authenticated user and role permissions. Refresh /me when possible,
    // but do not throw the user back to the sign-in screen if an older/custom
    // deployment has a permission mismatch on /me. Authentication has
    // already succeeded at this point.
    ME = await api('/me');
  } catch (e) {
    if (!fromLogin || !sessionUser) {
      doLogout(true);
      if (fromLogin) throw e;
      return;
    }
    ME = sessionUser;
  }
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('avatarInit').textContent = (ME.full_name || ME.username).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('userChipName').textContent = ME.full_name || ME.username;
  document.getElementById('userChipRole').textContent = ME.role;
  COMPANY = await api('/settings'); applyBranding();
  renderPlanBanners();
  if (ME.must_change_password) { openForcedPasswordChange(); return; }
  if (window.OFF) OFF.ping().then((ok) => { if (ok) OFF.sync().then(() => OFF.prefetch()); }); // keep a fresh offline copy of the main lists
  if (ME.role === 'ADMIN' && ME.pending_users > 0) setTimeout(() => showToast(`${ME.pending_users} user account request(s) waiting for your approval — open Users & Roles`), 900);
  try { const stages = await api('/pipeline-stages'); STAGES = stages.map((s) => s.name); CACHE.pipelineStages = stages; } catch (e) { /* fall back to defaults */ }
  buildNavForRole();
  renderNav();
  tickClock(); setInterval(tickClock, 1000);
  startNotificationPolling();
  checkLoanDuePopup();
  goTo('dashboard');
}
// ---- v5.2: plan / expiry banners, platform announcements, forced password change ----
function renderPlanBanners() {
  const host = document.getElementById('planBanners'); if (!host) return;
  const dismissed = JSON.parse(sessionStorage.getItem('dismissed_banners') || '[]');
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = [];
  const sb = ME && ME.subscription;
  if (sb && sb.notice) rows.push({ key: 'plan-' + sb.notice.code + '-' + sb.days_left, level: sb.notice.level, html: `<b>${sb.read_only ? 'Read-only mode.' : 'Plan notice.'}</b> ${esc(sb.notice.text)}`, sticky: sb.read_only });
  ((sb && sb.warnings) || []).forEach((w) => rows.push({ key: 'lim-' + w.code, level: w.level, html: esc(w.text) }));
  ((ME && ME.announcements) || []).forEach((a) => rows.push({ key: 'ann-' + a.id, level: a.severity || 'info', ann: true, html: `<b>${esc(a.title)}</b>${a.body ? ' — ' + esc(a.body) : ''}` }));
  host.innerHTML = rows.filter((r) => r.sticky || !dismissed.includes(r.key)).map((r) =>
    `<div class="plan-banner ${r.level}${r.ann ? ' ann' : ''}"><div>${r.html}</div>${r.sticky ? '' : `<span class="pb-x" title="Hide for this session" onclick="dismissBanner('${r.key}')">×</span>`}</div>`).join('');
}
function dismissBanner(key) {
  const d = JSON.parse(sessionStorage.getItem('dismissed_banners') || '[]'); d.push(key);
  sessionStorage.setItem('dismissed_banners', JSON.stringify(d)); renderPlanBanners();
}
function openForcedPasswordChange() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Choose your own password</h3></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">You signed in with a password that was set for you. Please choose a new one before continuing (at least 8 characters, with a letter and a number).</p>
      <div class="form-grid">
        <div class="form-field full"><label>Current password</label><input type="password" id="fp_cur" autocomplete="current-password"></div>
        <div class="form-field full"><label>New password</label><input type="password" id="fp_new" autocomplete="new-password"></div>
        <div class="form-field full"><label>Repeat new password</label><input type="password" id="fp_new2" autocomplete="new-password" onkeydown="if(event.key==='Enter')submitForcedPassword()"></div>
      </div><div id="fp_err" class="auth-err"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="doLogout()">Sign out</button><button class="btn btn-primary" onclick="submitForcedPassword()">Change password</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function submitForcedPassword() {
  const err = document.getElementById('fp_err'); err.textContent = '';
  const a = document.getElementById('fp_cur').value; const b = document.getElementById('fp_new').value; const c = document.getElementById('fp_new2').value;
  if (b !== c) { err.textContent = 'The two new passwords do not match.'; return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: a, new_password: b }) });
    document.getElementById('modalBg').classList.remove('show');
    ME.must_change_password = false; showToast('Password changed');
    await boot(true);
  } catch (e) { err.textContent = e.message; }
}
// Pop-up warning for loans coming due (or overdue) — shown once per day per
// login, not on every page navigation, so it's a heads-up rather than a
// nag. Uses the same /loans-due list (due within 15 days, or already
// overdue) that feeds the notification bell — this just additionally
// interrupts with a modal, since a bell icon is easy to miss for something
// as consequential as a loan EMI.
async function checkLoanDuePopup() {
  const todayKey = `loan_due_popup_shown_${todayISO()}`;
  if (localStorage.getItem(todayKey)) return;
  let due = [];
  try { due = await api('/loans-due'); } catch (e) { return; }
  if (!due.length) return;
  localStorage.setItem(todayKey, '1');
  const overdue = due.filter((l) => l.overdue);
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3 style="color:var(--coral);">⏰ Loan EMI ${overdue.length ? 'Overdue' : 'Due Soon'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px; color:var(--muted); margin-bottom:10px;">${due.length} loan${due.length===1?'':'s'} need${due.length===1?'s':''} attention:</p>
      ${due.map((l) => `
        <div style="padding:10px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <div><b>${l.loan_no}</b> — ${l.lender_name}<br><span style="font-size:12px; color:${l.overdue?'var(--coral)':'var(--amber)'};">${l.overdue?'Overdue since':'Due'} ${fmtDate(l.due_date)}</span></div>
          <div style="text-align:right; font-weight:700;">${inr(l.outstanding)}</div>
        </div>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Remind Me Later</button><button class="btn btn-primary" onclick="closeModal(); goTo('loans');">Go to Loans</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
window.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('sabiha_theme') || 'light');
  await loadCompanyPublic();
  if (TOKEN) boot(); 
});
// Mouse-wheel increases/decreases the value of any focused number input — matches spreadsheet-style data entry.
document.addEventListener('wheel', (e) => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'number') {
    e.preventDefault();
    const step = Number(el.step) || 1;
    const cur = Number(el.value) || 0;
    el.value = e.deltaY < 0 ? cur + step : cur - step;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, { passive: false });
function tickClock() {
  const now = new Date();
  document.getElementById('clockTime').textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const ICONS = {
  qrCode:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01"/></svg>',
  barcode:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14M7 5v14M10 5v14M13 5v14M15 5v14M18 5v14M21 5v14"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  box:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  layers:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  calendar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  wallet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>',
  cart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  factory:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20V10l5 4v-4l5 4v-4l5 4V4l-5 4V4l-5 4V4l-5 4v12"/></svg>',
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  receipt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h16v20l-3-2-3 2-3-2-3 2-3-2-1 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  db:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  book:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  gitBranch:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  print:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  dollar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><polyline points="4 4 12 13 20 4"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  list:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
};
function ic(name) { return ICONS[name] || ''; }

// ---------------------------------------------------------------------------
// Consolidated module tab-groups — one sidebar item opens a tabbed page
// ---------------------------------------------------------------------------
const TAB_GROUPS = {
  employeesPayroll: [
    { key: 'employees', label: 'Employees', icon: 'users' },
    { key: 'attendance', label: 'Attendance', icon: 'calendar' },
    { key: 'advances', label: 'Salary Advances', icon: 'dollar' },
    { key: 'payroll', label: 'Payroll', icon: 'wallet' },
  ],
  inventory: [
    { key: 'rawMaterials', label: 'Raw Materials', icon: 'layers' },
    { key: 'products', label: 'Finished Goods', icon: 'box' },
    { key: 'bom', label: 'BOM', icon: 'gitBranch' },
    { key: 'lowStock', label: 'Low Stock', icon: 'bell' },
    { key: 'materialUsage', label: 'Used During Period', icon: 'chart' },
  ],
  purchasesModule: [
    { key: 'purchases', label: 'Purchase Orders', icon: 'cart' },
    { key: 'suppliers', label: 'Suppliers', icon: 'truck' },
    { key: 'supplierPayments', label: 'Supplier Payments', icon: 'archive' },
    { key: 'purchaseReturns', label: 'Returns to Supplier', icon: 'back' },
  ],
  productionModule: [
    { key: 'production', label: 'Production Entries', icon: 'factory' },
    { key: 'pipeline', label: 'Pipeline', icon: 'gitBranch' },
  ],
  customersSales: [
    { key: 'customers', label: 'Customers', icon: 'user' },
    { key: 'sales', label: 'Sales / Billing', icon: 'receipt' },
    { key: 'receipts', label: 'Receipts', icon: 'archive' },
    { key: 'salesReturns', label: 'Customer Returns', icon: 'back' },
    { key: 'customerStatement', label: 'Customer Statement', icon: 'book' },
    { key: 'futureOrders', label: 'Future Orders', icon: 'gitBranch' },
  ],
  accountingReports: [
    { key: 'ledger', label: 'Ledger', icon: 'book' },
    { key: 'trialBalance', label: 'Trial Balance', icon: 'list' },
    { key: 'profitLoss', label: 'Profit & Loss', icon: 'chart' },
    { key: 'balanceSheet', label: 'Balance Sheet', icon: 'chart' },
    { key: 'cashBook', label: 'Cash / Bank Book', icon: 'wallet' },
    { key: 'taxSummary', label: 'Tax Summary', icon: 'dollar' },
    { key: 'reports', label: 'Business Reports', icon: 'chart' },
  ],
};
const PARENT_FIRST_CHILD = { employeesPayroll: 'employees', inventory: 'rawMaterials', purchasesModule: 'purchases', productionModule: 'production', customersSales: 'customers', accountingReports: 'ledger', auditBackup: 'auditLog' };
const NAV_CHILD_MAP = { auditBackup: ['auditLog', 'backup'] };
function findGroupFor(key) { for (const [g, items] of Object.entries(TAB_GROUPS)) { if (items.some((i) => i.key === key)) return { group: g, items }; } return null; }
function bannerIcon(key) {
  const grp = findGroupFor(key);
  if (grp) { const item = grp.items.find((i) => i.key === key); if (item) return item.icon; }
  const standalone = { dashboard: 'home', outsourcing: 'share', reminders: 'bell', users: 'shield', settings: 'settings', expenses: 'wallet', assets: 'factory', loans: 'dollar' };
  return standalone[key] || 'box';
}

// ---------------------------------------------------------------------------
// Navigation (filtered by role)
// ---------------------------------------------------------------------------
const PAGE_META = {
  dashboard:['Dashboard','Overview of your manufacturing operations', '#3B6EF6,#7C6FE0'],
  employees:['Employees','Employees & Payroll — manage staff, attendance, overtime, salary advances and payroll', '#3B6EF6,#0E9C99'],
  customers:['Customers','Manage customer accounts & credit terms', '#0E9C99,#28A97A'],
  suppliers:['Suppliers','Manage raw material suppliers', '#EF9F2E,#E15A5A'],
  products:['Products','Finished toy catalog — linked to raw material requirements (BOM)', '#7C6FE0,#3B6EF6'],
  rawMaterials:['Raw Materials','Track raw material stock levels', '#E15A5A,#EF9F2E'],
  attendance:['Attendance','Employees & Payroll — daily attendance & overtime log', '#3B6EF6,#0E9C99'],
  advances:['Salary Advances','Employees & Payroll — auto-deducted from the next payroll run', '#EF9F2E,#E15A5A'],
  payroll:['Payroll','Employees & Payroll — monthly salary processing', '#28A97A,#0E9C99'],
  purchases:['Purchases','Raw material purchase orders', '#EF9F2E,#E15A5A'],
  supplierPayments:['Supplier Payments','Payments made against raw material purchases', '#E15A5A,#EF9F2E'],
  production:['Production','Final production batch entries (adds finished stock)', '#7C6FE0,#28A97A'],
  pipeline:['Production Pipeline','Live quantity at each internal stage — Molding to Packing', '#3B6EF6,#7C6FE0'],
  outsourcing:['Outsourcing','Jobwork — Persons, Jobs & Payments', '#7C6FE0,#E15A5A'],
  sales:['Sales / Invoices','Customer sales & billing', '#3B6EF6,#28A97A'],
  receipts:['Customer Receipts','Payments collected from customers', '#0E9C99,#3B6EF6'],
  reminders:['Reminders','Queued & sent WhatsApp / Email / SMS reminders', '#28A97A,#0E9C99'],
  ledger:['Ledger','Running account statement for any customer or supplier', '#182238,#3B6EF6'],
  bom:['Bill of Materials','Raw materials required per unit of each finished product', '#7C6FE0,#3B6EF6'],
  lowStock:['Low Stock','Raw materials and finished goods below their minimum level', '#E15A5A,#EF9F2E'],
  materialUsage:['Used During Period','Raw material consumption from production, for any date range', '#0E9C99,#3B6EF6'],
  salesReturns:['Customer Returns','Goods returned by customers — accepting one updates stock, the customer balance and every report', '#E15A5A,#EF9F2E'],
  purchaseReturns:['Returns to Supplier','Goods sent back to suppliers — accepting one updates stock, the supplier balance and every report', '#E15A5A,#7C6FE0'],
  myPlan:['Plan & Billing','Your current plan, validity, usage, and how to buy or renew', '#182238,#3B6EF6'],
  customerStatement:['Customer Statement','Running debit/credit statement for a chosen customer', '#0E9C99,#182238'],
  futureOrders:['Future Orders','Expected/pipeline business not yet invoiced — feeds the investor presentation', '#7C6FE0,#182238'],
  trialBalance:['Trial Balance','Simplified debit/credit summary across the business', '#EF9F2E,#7C6FE0'],
  profitLoss:['Profit & Loss','Revenue vs expenses, with a monthly trend', '#28A97A,#0E9C99'],
  balanceSheet:['Balance Sheet','Assets vs liabilities, simplified', '#182238,#3B6EF6'],
  cashBook:['Cash / Bank Book','Cash in vs cash out, and the closing balance', '#0E9C99,#28A97A'],
  taxSummary:['Tax Summary','Output GST collected on sales', '#EF9F2E,#E15A5A'],
  expenses:['Expenses','Rent, utilities, travel and other overhead not tied to a purchase or payroll', '#E15A5A,#EF9F2E'],
  assets:['Fixed Assets','Asset register, Companies Act depreciation, Income Tax WDV, and deferred tax', '#7C6FE0,#3B6EF6'],
  loans:['Loans','Bank / fintech working-capital loans — disbursements, repayments & outstanding balance', '#0E9C99,#3B6EF6'],
  accounts:['Accounts','Trial Balance, P&L, Balance Sheet, Cash Book & GST', '#EF9F2E,#7C6FE0'],
  reports:['Business Reports','Sales, Purchase, Production, Stock, Customer, Supplier, Financial & Payroll reports', '#3B6EF6,#0E9C99'],
  auditLog:['Audit Log','Every create, update and delete across the system', '#182238,#6E7791'],
  users:['Users & Roles','Approve accounts and manage role-based access', '#7C6FE0,#3B6EF6'],
  settings:['Company Settings','Profile, branding, theme & policies', '#0E9C99,#28A97A'],
  backup:['Backup & Data','Download a full backup of your live database', '#3B6EF6,#182238'],
};
function bannerGradient(key) { const g = (PAGE_META[key] || [])[2] || '#3B6EF6,#7C6FE0'; const [a, b] = g.split(','); return `linear-gradient(120deg, ${a}, ${b})`; }

function navConfig() {
  const items = [
    { key: 'dashboard', label: 'Dashboard', icon: 'home', color: '#3B6EF6' },
    { key: 'employeesPayroll', label: 'Employees & Payroll', icon: 'users', color: '#3B6EF6' },
    { key: 'inventory', label: 'Inventory & BOM', icon: 'layers', color: '#EF9F2E' },
    { key: 'purchasesModule', label: 'Purchases', icon: 'cart', color: '#EF9F2E' },
    { key: 'productionModule', label: 'Production', icon: 'factory', color: '#7C6FE0' },
    { key: 'customersSales', label: 'Customers & Sales', icon: 'receipt', color: '#0E9C99' },
    { key: 'outsourcing', label: 'Outsourcing', icon: 'share', color: '#7C6FE0' },
    { key: 'accountingReports', label: 'Accounting & Reports', icon: 'chart', color: '#28A97A' },
    { key: 'assets', label: 'Fixed Assets', icon: 'factory', color: '#7C6FE0' },
    { key: 'loans', label: 'Loans', icon: 'dollar', color: '#0E9C99' },
    { key: 'expenses', label: 'Expenses', icon: 'wallet', color: '#E15A5A' },
    { key: 'reminders', label: 'SMS / WhatsApp', icon: 'bell', color: '#28A97A' },
    { key: 'auditBackup', label: 'Audit & Backup', icon: 'clock', color: '#182238' },
    { key: 'users', label: 'Users & Roles', icon: 'shield', color: '#7C6FE0' },
    { key: 'settings', label: 'Settings', icon: 'settings', color: '#0E9C99' },
    { key: 'myPlan', label: 'Plan & Billing', icon: 'dollar', color: '#2F5BEA', adminOnly: true },
  ];
  const perms = (ME && ME.permissions) || {};
  const lockedKeys = ((ME && ME.plan_locked) || []).map((m) => m.key);
  // modules the plan does not include stay visible with a lock, so a click can explain the real reason
  const allowed = ME && ME.role === 'ADMIN' ? items : items.filter((it) => !it.adminOnly && (perms[it.key] || lockedKeys.includes(it.key)));
  allowed.forEach((it) => { it.locked = lockedKeys.includes(it.key); });
  return [{ group: null, items: allowed }];
}
let NAV = navConfig();
function buildNavForRole() { NAV = navConfig(); }
function canAccess(key) { if (key === 'myPlan') return !!ME && ME.role === 'ADMIN'; return ME && (ME.role === 'ADMIN' || (ME.permissions && ME.permissions[key])); }

let currentPage = 'dashboard';
let pageHistory = [];
function renderNav() {
  const host = document.getElementById('navHost');
  host.innerHTML = NAV.map((sec) => `
    <div class="navgroup">
      ${sec.group ? `<div class="navgroup-title">${sec.group}</div>` : ''}
      ${sec.items.map((it) => {
        const isActive = currentPage === it.key || (TAB_GROUPS[it.key] && TAB_GROUPS[it.key].some((ch) => ch.key === currentPage)) || (NAV_CHILD_MAP[it.key] && NAV_CHILD_MAP[it.key].includes(currentPage));
        return `<div class="navitem ${isActive ? 'active' : ''} ${it.locked ? 'locked' : ''}" onclick="goTo('${it.key}')">
        <span class="navicon" style="background:${it.locked ? '#9AA3B8' : it.color}">${ic(it.icon)}</span><span>${it.label}</span>${it.locked ? '<span class="navlock" title="Not in your plan">🔒</span>' : ''}${it.key === 'users' && ME && ME.pending_users > 0 ? `<span class="badge badge-amber" style="margin-left:auto;" title="Users waiting for your approval">${ME.pending_users}</span>` : ''}</div>`;
      }).join('')}
    </div>`).join('');
}
function goTo(key, skipHistory) {
  if (PARENT_FIRST_CHILD[key]) key = PARENT_FIRST_CHILD[key];
  const topLevelKey = findGroupFor(key)?.group || key;
  const lockedMod = ME && (ME.plan_locked || []).find((m) => m.key === topLevelKey);
  if (lockedMod) { showPlanPopup({ kind: 'module', module_label: lockedMod.label }); return; }   // plan does not include it: say exactly why
  if (ME && !canAccess(topLevelKey)) { showToast("You don't have access to that section"); return; }
  if (!skipHistory && currentPage !== key) pageHistory.push(currentPage);
  currentPage = key;
  renderNav();
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('userMenu').classList.add('hidden');
  renderPage();
}
function goBack() { const prev = pageHistory.pop(); goTo(prev || 'dashboard', true); }
function setHeaderBanner(key, actionsHtml) {
  const meta = PAGE_META[key] || [key, '', '#3B6EF6,#7C6FE0'];
  document.getElementById('pageTitle').textContent = meta[0];
  document.getElementById('pageSub').textContent = meta[1];
  const grp = findGroupFor(key);
  const tabsHtml = grp ? `<div class="tabs">${grp.items.map((it) => `<div class="tab ${it.key === key ? 'active' : ''}" onclick="goTo('${it.key}')">${ic(it.icon)} ${it.label}</div>`).join('')}</div>` : '';
  return `<div class="module-banner" style="background:${bannerGradient(key)}">
    <div><h2>${ic(bannerIcon(key))} ${meta[0]}</h2><p>${meta[1]}</p></div>
    <div class="banner-actions">${actionsHtml || ''}</div>
  </div>${tabsHtml}`;
}

// ---------------------------------------------------------------------------
// Page router
// ---------------------------------------------------------------------------
let charts = {};
function renderPage() {
  Object.values(charts).forEach((c) => c && c.destroy && c.destroy());
  charts = {};
  const c = document.getElementById('content');
  c.innerHTML = `<div class="panel">Loading…</div>`;
  const renderers = {
    dashboard: renderDashboard, employees: () => renderModule('employees'), customers: () => renderModule('customers'),
    suppliers: () => renderModule('suppliers'), rawMaterials: () => renderModule('rawMaterials'),
    products: renderProducts, attendance: renderAttendance, advances: renderAdvances, payroll: renderPayroll,
    purchases: renderPurchases, supplierPayments: renderSupplierPayments, production: renderProduction,
    pipeline: renderPipeline, outsourcing: renderOutsourcing, sales: renderSales, receipts: renderReceipts,
    reminders: renderReminders, ledger: renderLedger, accounts: () => renderAccounts('trialBalance'), reports: renderReports, expenses: renderExpenses, assets: renderAssets, loans: renderLoans,
    auditLog: renderAuditLog, users: renderUsers, settings: renderSettings, backup: () => { auditBackupTab = 'backup'; return renderAuditLog(); },
    bom: renderBOM, lowStock: renderLowStock, customerStatement: renderCustomerStatement, futureOrders: renderFutureOrders, materialUsage: renderMaterialUsage,
    trialBalance: () => renderAccounts('trialBalance'), profitLoss: () => renderAccounts('profitLoss'),
    balanceSheet: () => renderAccounts('balanceSheet'), cashBook: () => renderAccounts('cashBook'),
    taxSummary: () => renderAccounts('taxSummary'),
    salesReturns: renderSalesReturns, purchaseReturns: renderPurchaseReturns, myPlan: renderMyPlan,
  };
  (renderers[currentPage] || renderDashboard)().then(() => {
    const host = document.getElementById('backBtnHost');
    host.innerHTML = currentPage === 'dashboard' ? '' : `<button class="btn btn-outline btn-sm" onclick="goBack()">${ic('back')} Back</button>`;
  }).catch?.((e) => {
    c.innerHTML = `<div class="panel">Error: ${e.message}</div>`;
    document.getElementById('backBtnHost').innerHTML = currentPage === 'dashboard' ? '' : `<button class="btn btn-outline btn-sm" onclick="goBack()">${ic('back')} Back</button>`;
  });
}

function statCard(icon, color, label, val, foot, trend, onClick) {
  const trendHtml = trend != null ? `<span class="trend ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}%</span>` : '';
  return `<div class="stat-card" onclick="${onClick || ''}">
    <div class="stat-top"><div style="display:flex; align-items:center; gap:11px;"><div class="stat-icon" style="background:${color};">${ic(icon)}</div><div class="stat-label">${label}</div></div>${trendHtml}</div>
    <div class="stat-num">${val}</div>
    <div class="stat-foot">${foot}</div>
  </div>`;
}

async function renderDashboard() {
  const c = document.getElementById('content');
  const d = await api('/reports/dashboard');
  const pipe = await api('/reports/pipeline');
  c.innerHTML = setHeaderBanner('dashboard') + `
    <div class="grid-stats">
      ${statCard('users','#3B6EF6','Total Employees', d.totalEmployees, 'Active workforce', null, "goTo('employees')")}
      ${statCard('factory','#28A97A',"Today's Production", d.todayProd + ' Pcs', 'Across all batches', d.prodTrendPct, "goTo('production')")}
      ${statCard('box','#EF9F2E','Finished Stock', d.totalFinished.toLocaleString('en-IN') + ' Pcs', 'Ready to dispatch', null, "goTo('products')")}
      ${statCard('receipt','#E15A5A',"Today's Sales", inr(d.todaySalesAmt), d.todaySalesCount + ' invoice(s)', null, "goTo('sales')")}
      ${statCard('wallet','#7C6FE0','Total Receivables', inr(d.receivables), 'Across all customers', null, "goToCustomerDues()")}
    </div>
    <div class="grid-stats">
      ${statCard('layers','#E15A5A','Raw Material Alerts', d.lowStockCount + ' Items', 'Below minimum stock', null, "goTo('rawMaterials')")}
      ${statCard('cart','#EF9F2E','Pending Purchases', d.pendingPurchases, 'Purchase orders', null, "goTo('purchases')")}
      ${statCard('share','#7C6FE0','Pending Outsourcing', d.pendingOutsourcing, 'Jobs not completed', null, "goTo('outsourcing')")}
      ${statCard('wallet','#28A97A','Payroll (This Month)', inr(d.totalPayrollNet), 'Net payable', null, "goTo('payroll')")}
      ${statCard('bell','#0E9C99','Reminders', 'Send now', 'Overdue invoices & low stock', null, "goTo('reminders')")}
    </div>

    <div class="panel" style="margin-bottom:14px;">
      <h3>Production Pipeline <span class="link" onclick="goTo('pipeline')">Full view →</span></h3>
      <div class="pipeline">
        ${pipe.stages.map((s, i) => `
          <div class="pipe-stage" onclick="goTo('pipeline')">
            <div class="icon" style="background:${['#3B6EF6','#EF9F2E','#7C6FE0','#E15A5A','#28A97A'][i]}">${ic('factory')}</div>
            <div class="qty">${s.atStage.toFixed(0)}</div>
            <div class="lbl">${s.stage}</div>
          </div>`).join('')}
        <div class="pipe-stage" onclick="goTo('products')" style="border:2px solid #28A97A;">
          <div class="icon" style="background:#28A97A;">${ic('box')}</div>
          <div class="qty">${pipe.finishedGoods.toFixed(0)}</div>
          <div class="lbl">Finished Goods</div>
        </div>
      </div>
    </div>

    <div class="row2">
      <div class="panel"><h3>Sales vs Purchases (6 Months)</h3><div class="chart-wrap"><canvas id="chSP"></canvas></div></div>
      <div class="panel"><h3>Production Mix (90 Days)</h3><div class="chart-wrap"><canvas id="chMix"></canvas></div></div>
    </div>

    <div class="row2">
      <div class="panel"><h3>Sales Trend (6 Months)</h3><div class="chart-wrap"><canvas id="chSalesTrend"></canvas></div></div>
      <div class="panel"><h3>Top Selling Products</h3>
        <div class="tbl-scroll"><table><thead><tr><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr></thead><tbody>
        ${d.topProducts.length ? d.topProducts.map((p, i) => `<tr class="clickable" onclick="goTo('sales')"><td><span class="badge badge-blue" style="margin-right:6px;">#${i+1}</span>${p.name}</td><td>${p.qty} ${p.unit}</td><td>${inr(p.revenue)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="3">No sales recorded yet</td></tr>'}
        </tbody></table></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px;">
      <h3>Sales, Profit & Production — Monthly</h3>
      <div class="chart-wrap" style="height:280px;"><canvas id="chMonthly"></canvas></div>
    </div>

    <div class="row2">
      <div class="panel">
        <h3>Low Stock Alert <span class="link" onclick="goTo('inventory')">View all →</span></h3>
        <div class="tbl-scroll"><table><thead><tr><th>Item</th><th>Current</th><th>Min</th></tr></thead><tbody>
        ${d.lowStockItems.length ? d.lowStockItems.map((m) => `<tr class="clickable" onclick="goTo('inventory')"><td>${m.name}</td><td style="color:#E15A5A; font-weight:700;">${m.stock}</td><td>${m.min_stock}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="3">All raw materials sufficiently stocked</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel"><h3>Raw Material Stock <span class="link" onclick="goTo('inventory')">View all →</span></h3><div class="chart-wrap"><canvas id="chRawStock"></canvas></div></div>
    </div>
  `;
  const monthLabels = d.months.map((m) => new Date(m + '-01').toLocaleDateString('en-US', { month: 'short' }));
  charts.salesTrend = new Chart(document.getElementById('chSalesTrend'), {
    type: 'line', data: { labels: monthLabels, datasets: [
      { label: 'Sales (₹)', data: d.salesTrend, borderColor: '#3B6EF6', backgroundColor: 'rgba(59,110,246,.12)', tension: .35, fill: true },
    ]},
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: '#EEF1F8' } }, x: { grid: { display: false } } } },
  });
  charts.monthly = new Chart(document.getElementById('chMonthly'), {
    type: 'bar', data: { labels: monthLabels, datasets: [
      { label: 'Sales (₹)', data: d.salesTrend, backgroundColor: '#3B6EF6', borderRadius: 5, maxBarThickness: 22 },
      { label: 'Profit (₹)', data: d.profitTrend, backgroundColor: '#28A97A', borderRadius: 5, maxBarThickness: 22 },
      { label: 'Production Qty', data: d.prodQtyTrend, backgroundColor: '#EF9F2E', borderRadius: 5, maxBarThickness: 22, yAxisID: 'y1' },
    ]},
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { y: { beginAtZero: true, grid: { color: '#EEF1F8' }, title: { display: true, text: '₹', font: { size: 10 } } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, title: { display: true, text: 'Qty', font: { size: 10 } } },
        x: { grid: { display: false } } } },
  });
  charts.sp = new Chart(document.getElementById('chSP'), {
    type: 'bar', data: { labels: d.months.map((m) => new Date(m + '-01').toLocaleDateString('en-US', { month: 'short' })), datasets: [
      { label: 'Sales (₹)', data: d.salesTrend, backgroundColor: '#3B6EF6', borderRadius: 5, maxBarThickness: 26 },
      { label: 'Purchases (₹)', data: d.purchTrend, backgroundColor: '#0E9C99', borderRadius: 5, maxBarThickness: 26 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }, scales: { y: { beginAtZero: true, grid: { color: '#EEF1F8' } }, x: { grid: { display: false } } } },
  });
  const mixLabels = d.prodMix.map((p) => p.name); const mixVals = d.prodMix.map((p) => p.qty);
  charts.mix = new Chart(document.getElementById('chMix'), {
    type: 'doughnut', data: { labels: mixLabels.length ? mixLabels : ['No data'], datasets: [{ data: mixVals.length ? mixVals : [1], backgroundColor: ['#3B6EF6','#0E9C99','#EF9F2E','#E15A5A','#7C6FE0','#28A97A'] }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } } },
  });
  charts.rawStock = new Chart(document.getElementById('chRawStock'), {
    type: 'bar', data: { labels: d.rawMaterialStock.map((m) => m.name), datasets: [
      { label: 'Current Stock', data: d.rawMaterialStock.map((m) => m.stock), backgroundColor: d.rawMaterialStock.map((m) => m.stock < m.min_stock ? '#E15A5A' : '#0E9C99'), borderRadius: 5, maxBarThickness: 26 },
      { label: 'Min Level', data: d.rawMaterialStock.map((m) => m.min_stock), type: 'line', borderColor: '#EF9F2E', borderDash: [5,4], pointRadius: 0, borderWidth: 2 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { y: { beginAtZero: true, grid: { color: '#EEF1F8' } }, x: { grid: { display: false }, ticks: { maxRotation: 30, minRotation: 0, font: { size: 10 } } } } },
  });
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const UNITS = ['Kg','Gram','Litre','Ml','Pcs','Nos','Box','Roll','Bag','Inch','Meter','Set'];
const DEPARTMENTS = ['Production','Molding','Cutting','Finishing','Sticker','Packing','Accounts','Sales','Admin'];
let STAGES = ['Molding','Cutting','Finishing','Sticker','Packing'];

// ---------------------------------------------------------------------------
// Generic CRUD module engine — for simple master tables
// ---------------------------------------------------------------------------
const MODULES = {
  employees: {
    endpoint: '/employees', label: 'Employee', addLabel: 'Add Employee',
    rowClick: (row) => openEmployeeDetail(row.id),
    columns: [ {key:'code',label:'Emp Code'}, {key:'name',label:'Name'}, {key:'department',label:'Department'}, {key:'designation',label:'Designation'}, {key:'join_date',label:'Date of Join',fmt:fmtDate}, {key:'phone',label:'Phone'},
      {key:'salary_type',label:'Salary Type', render:r=>`<span class="badge badge-blue">${r.salary_type||'Monthly'}</span>`},
      {key:'status',label:'Status', render:r=>`<span class="badge ${r.status==='On Leave'?'badge-amber':'badge-green'}">${r.status||'Active'}</span>`} ],
    fields: [
      {key:'code', label:'Employee Code', type:'text', placeholder:'EMP-004'},
      {key:'name', label:'Full Name', type:'text', required:true},
      {key:'department', label:'Department', type:'select', options:DEPARTMENTS},
      {key:'designation', label:'Designation', type:'text'},
      {key:'join_date', label:'Date of Join', type:'date'},
      {key:'phone', label:'Phone', type:'text'},
      {key:'email', label:'Email', type:'text'},
      {key:'status', label:'Status', type:'select', options:['Active','On Leave']},
      {key:'salary_type', label:'Salary Type', type:'select', options:['Monthly','On Production']},
      {key:'piece_rate', label:'Piece Rate (₹ per unit) — used if Salary Type is "On Production"', type:'number'},
      {key:'monthly_target_qty', label:'Monthly Production Target (legacy production KPI)', type:'number'},
      {key:'sales_target', label:'Monthly Sales Target (₹)', type:'number'},
      {key:'production_target', label:'Monthly Production Target (units)', type:'number'},
      {key:'bid_target', label:'Monthly Successful Bid Target', type:'number'},
      {key:'recovery_target', label:'Monthly Customer Recovery Target (₹)', type:'number'},
      {key:'overtime_target_hours', label:'Monthly Overtime Target (hours)', type:'number'},
      {key:'job_target', label:'Monthly Job / Task Completion Target', type:'number'},
      {key:'address', label:'Address', type:'textarea', full:true},
    ],
  },
  customers: {
    endpoint: '/customers', listEndpoint: '/reports/customer-due', label: 'Customer', addLabel: 'Add Customer',
    columns: [ {key:'code',label:'Cust Code'}, {key:'name',label:'Name'}, {key:'contact_person',label:'Contact Person'}, {key:'phone',label:'Phone'}, {key:'credit_limit',label:'Credit Limit',fmt:inr}, {key:'payment_terms_days',label:'Terms', render:r=>r.payment_terms_days+' Days'},
      {key:'balance', label:'Balance Due', render:(row)=> row.balance > 0 ? `<b style="color:#E15A5A;">${inr(row.balance)}</b>` : `<span style="color:#28A97A;">${inr(row.balance)}</span>`} ],
    rowClick: (row) => { window.__ledgerPreset = { type: 'customer', id: row.id }; goTo('ledger'); },
    fields: [
      {key:'code', label:'Customer Code', type:'text', placeholder:'CUST-004'},
      {key:'name', label:'Customer Name', type:'text', required:true},
      {key:'contact_person', label:'Contact Person', type:'text'},
      {key:'phone', label:'Phone', type:'text'},
      {key:'email', label:'Email', type:'text'},
      {key:'gst_no', label:'GST No', type:'text'},
      {key:'credit_limit', label:'Credit Limit (₹)', type:'number'},
      {key:'payment_terms_days', label:'Payment Terms (Days)', type:'number'},
      {key:'purchase_target', label:'Loyalty Purchase Target (₹)', type:'number'},
      {key:'address', label:'Address', type:'textarea', full:true},
    ],
  },
  suppliers: {
    endpoint: '/suppliers', listEndpoint: '/reports/supplier-due', label: 'Supplier', addLabel: 'Add Supplier',
    columns: [ {key:'code',label:'Sup Code'}, {key:'name',label:'Name'}, {key:'contact_person',label:'Contact'}, {key:'phone',label:'Phone'}, {key:'supplies',label:'Supplies'},
      {key:'balance', label:'Balance Due', render:(row)=> row.balance > 0 ? `<b style="color:#E15A5A;">${inr(row.balance)}</b>` : `<span style="color:#28A97A;">${inr(row.balance)}</span>`} ],
    rowClick: (row) => { window.__ledgerPreset = { type: 'supplier', id: row.id }; goTo('ledger'); },
    fields: [
      {key:'code', label:'Supplier Code', type:'text', placeholder:'SUP-003'},
      {key:'name', label:'Supplier Name', type:'text', required:true},
      {key:'contact_person', label:'Contact Person', type:'text'},
      {key:'phone', label:'Phone', type:'text'},
      {key:'email', label:'Email', type:'text'},
      {key:'gst_no', label:'GST No', type:'text'},
      {key:'supplies', label:'Material Supplied', type:'text'},
      {key:'address', label:'Address', type:'textarea', full:true},
    ],
  },
  rawMaterials: {
    endpoint: '/raw-materials', listEndpoint: '/stock/raw-materials', label: 'Raw Material', addLabel: 'Add Raw Material',
    rowClick: (row) => openRawMaterialDetail(row.id),
    columns: [
      {key:'code',label:'Code'}, {key:'name',label:'Name'}, {key:'unit',label:'Unit'},
      {key:'stock', label:'Current Stock', render:(row)=>{
        const pct = row.min_stock ? Math.min(100,(row.stock/row.min_stock)*100) : 100;
        const color = row.stock < row.min_stock ? '#E15A5A' : (pct<130?'#EF9F2E':'#28A97A');
        return `<span style="color:${color}; font-weight:700;">${row.stock}</span><span class="stock-bar"><div style="width:${Math.min(100,pct)}%; background:${color};"></div></span>`;
      }},
      {key:'min_stock', label:'Min Level'}, {key:'rate', label:'Avg. Purchase Rate', render:(row)=>inr(row.avg_rate ?? row.rate)},
    ],
    fields: [
      {key:'code', label:'Material Code', type:'text', placeholder:'RM-004'},
      {key:'name', label:'Material Name', type:'text', required:true},
      {key:'unit', label:'Unit', type:'select', options:UNITS},
      {key:'opening_stock', label:'Opening Stock (starting balance only — purchases & usage adjust it automatically after)', type:'number'},
      {key:'min_stock', label:'Minimum Stock Level', type:'number'},
      {key:'rate', label:'Opening/Manual Rate per Unit (₹) — used only until purchases exist; after that the Average Purchase Rate is used everywhere', type:'number'},
    ],
  },
};

let editingId = null, editingEndpoint = null;
let searchQuery = '';

async function openEmployeeDetail(id) {
  const d = await api(`/reports/employee-summary/${id}`);
  const e = d.employee; const perf = d.performance;
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:760px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${e.name} <span class="badge badge-blue" style="margin-left:6px;">${e.department||''}</span></h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${e.status||'Active'}</div><div class="l">Status</div></div>
        <div class="kpi"><div class="n">${e.salary_type||'Monthly'}</div><div class="l">Salary Type</div></div>
        ${e.salary_type === 'On Production' ? `
          <div class="kpi"><div class="n">${perf.thisMonthOutput}</div><div class="l">This Month's Output</div></div>
          <div class="kpi"><div class="n">${perf.target || '—'}</div><div class="l">Monthly Target</div></div>
          <div class="kpi"><div class="n" style="color:${perf.achievementPct===null?'inherit':(perf.achievementPct>=100?'var(--green)':'var(--amber)')}">${perf.achievementPct===null?'No target set':perf.achievementPct+'%'}</div><div class="l">Target Achievement</div></div>
        ` : ''}
      </div>
      <div class="tabs">
        <div class="tab active" data-emp-tab="attendance" onclick="switchEmpDetailTab(this,'attendance')">Attendance</div>
        <div class="tab" data-emp-tab="production" onclick="switchEmpDetailTab(this,'production')">Production</div>
        <div class="tab" data-emp-tab="advances" onclick="switchEmpDetailTab(this,'advances')">Advances</div>
        <div class="tab" data-emp-tab="pay" onclick="switchEmpDetailTab(this,'pay')">Pay History</div>
      </div>
      <div id="empDetailBody" style="max-height:340px; overflow-y:auto;"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  window.__empDetailData = d;
  paintEmpDetailTab('attendance');
  document.getElementById('modalBg').classList.add('show');
}
function switchEmpDetailTab(el, tab) {
  document.querySelectorAll('[data-emp-tab]').forEach((t) => t.classList.toggle('active', t === el));
  paintEmpDetailTab(tab);
}
function paintEmpDetailTab(tab) {
  const d = window.__empDetailData; const host = document.getElementById('empDetailBody');
  if (tab === 'attendance') {
    host.innerHTML = `<table><thead><tr><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>OT</th><th>Status</th></tr></thead>
      <tbody>${d.attendance.length ? d.attendance.map((a) => `<tr><td>${fmtDate(a.work_date)}</td><td>${a.in_time||'—'}</td><td>${a.out_time||'—'}</td><td>${Number(a.working_hours).toFixed(2)}</td><td>${Number(a.overtime_hours).toFixed(2)}</td><td><span class="badge ${a.status==='Present'?'badge-green':(a.status==='Half Day'?'badge-amber':'badge-red')}">${a.status}</span></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No attendance recorded.</td></tr>'}</tbody></table>`;
  } else if (tab === 'production') {
    host.innerHTML = `<table><thead><tr><th>Date</th><th>Batch</th><th>Product</th><th>Produced</th><th>Defective</th><th>Good Qty</th></tr></thead>
      <tbody>${d.production.length ? d.production.map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${p.batch_no||''}</td><td>${p.product_name}</td><td>${p.produced_qty}</td><td>${p.defective_qty}</td><td><b>${p.produced_qty-p.defective_qty}</b> ${p.unit}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No production logged for this employee.</td></tr>'}</tbody></table>`;
  } else if (tab === 'advances') {
    host.innerHTML = `<table><thead><tr><th>Date</th><th>Amount</th><th>Reason</th><th>Status</th></tr></thead>
      <tbody>${d.advances.length ? d.advances.map((a) => `<tr><td>${fmtDate(a.date)}</td><td>${inr(a.amount)}</td><td>${a.reason||''}</td><td><span class="badge ${a.adjusted?'badge-green':'badge-amber'}">${a.adjusted?'Adjusted':'Outstanding'}</span></td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">No advances given.</td></tr>'}</tbody></table>`;
  } else {
    host.innerHTML = `<label style="font-size:12px; font-weight:600; color:var(--muted);">Payments (date by date)</label>
      <table style="margin-bottom:14px;"><thead><tr><th>Date</th><th>Payroll No</th><th>Month</th><th>Amount</th><th>Mode</th></tr></thead>
      <tbody>${d.payments.length ? d.payments.map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${p.payroll_no}</td><td>${p.pay_month}</td><td>${inr(p.amount)}</td><td>${p.mode}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="5">No payments made yet.</td></tr>'}</tbody></table>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Payroll Records</label>
      <table><thead><tr><th>Month</th><th>Net Salary</th><th>Paid</th><th>Balance</th></tr></thead>
      <tbody>${d.payroll.length ? d.payroll.map((p) => `<tr><td>${p.pay_month}</td><td>${inr(p.net)}</td><td>${inr(p.paid_amount)}</td><td>${inr(p.net-p.paid_amount)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">No payroll processed yet.</td></tr>'}</tbody></table>`;
  }
}
async function renderModule(key, target, showBanner) {
  target = target || 'content'; showBanner = showBanner !== false;
  const cfg = MODULES[key];
  const c = document.getElementById(target);
  searchQuery = '';
  const rows = await api(cfg.listEndpoint || cfg.endpoint);
  CACHE[key] = rows;
  c.innerHTML = (showBanner ? setHeaderBanner(key, '') : '') + `
    <div class="tbl-toolbar">
      <input type="text" placeholder="Search ${cfg.label.toLowerCase()}s..." oninput="onModuleSearch('${key}', this.value)">
      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline" onclick="printModuleList('${key}')">${ic('print')} Print List</button>
        <button class="btn btn-outline" onclick="openModuleForm('${key}')">${ic('plus')} ${cfg.addLabel}</button>
      </div>
    </div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="modTableWrap"></div></div>
  `;
  paintModuleTable(key);
}
function printModuleList(key) {
  const cfg = MODULES[key];
  const rows = (CACHE[key] || []).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  const headers = cfg.columns.map((c) => c.label);
  const dataRows = rows.map((row) => cfg.columns.map((c) => {
    const raw = c.render ? c.render(row) : (c.fmt ? c.fmt(row[c.key]) : (row[c.key] ?? ''));
    return String(raw).replace(/<[^>]*>/g, '');
  }));
  printGenericReport(cfg.label + ' List', headers, dataRows);
}
function onModuleSearch(key, val) { searchQuery = val.toLowerCase(); paintModuleTable(key); }
function paintModuleTable(key) {
  const cfg = MODULES[key];
  const rows = (CACHE[key] || []).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  document.getElementById('modTableWrap').innerHTML = `
    <table><thead><tr>${cfg.columns.map((c) => `<th>${c.label}</th>`).join('')}<th style="text-align:right;">Actions</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map((row) => `
        <tr class="${cfg.rowClick ? 'clickable' : ''}" ${cfg.rowClick ? `onclick="MODULES.${key}.rowClick(${JSON.stringify(row).replace(/"/g, '&quot;')})"` : ''}>
          ${cfg.columns.map((c) => `<td>${c.render ? c.render(row) : (c.fmt ? c.fmt(row[c.key]) : (row[c.key] ?? ''))}</td>`).join('')}
          <td onclick="event.stopPropagation()"><div class="row-actions" style="justify-content:flex-end;">
            <button class="icon-btn" onclick="openModuleForm('${key}',${row.id})">${ic('edit')}</button>
            <button class="icon-btn del" onclick="deleteModuleRow('${key}',${row.id})">${ic('trash')}</button>
          </div></td>
        </tr>`).join('') : `<tr class="empty-row"><td colspan="${cfg.columns.length + 1}">No records yet — click "${cfg.addLabel}" to create one.</td></tr>`}
    </tbody></table>`;
}
function fieldInput(f, val) {
  const v = val == null ? '' : val;
  if (f.type === 'select') return `<select id="fld_${f.key}">${f.options.map((o) => `<option value="${o}" ${String(o) === String(v) ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  if (f.type === 'textarea') return `<textarea id="fld_${f.key}" rows="2">${v}</textarea>`;
  return `<input type="${f.type}" id="fld_${f.key}" value="${v}" ${f.placeholder ? `placeholder="${f.placeholder}"` : ''}>`;
}
function openModuleForm(key, id) {
  const cfg = MODULES[key];
  editingId = id || null; editingEndpoint = cfg.endpoint;
  const row = id ? (CACHE[key] || []).find((r) => r.id === id) : {};
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} ${cfg.label}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">${cfg.fields.map((f) => `<div class="form-field ${f.full ? 'full' : ''}"><label>${f.label}</label>${fieldInput(f, row[f.key])}</div>`).join('')}</div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveModuleForm('${key}')">Save ${cfg.label}</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function closeModal() {
  document.getElementById('modalBg').classList.remove('show');
  editingId = null;
  triggerSavedPopupIfPending();
}

// ---------------------------------------------------------------------------
// Admin Password Gate — every Edit and Delete action anywhere in the app
// requires the Admin password before it runs. Implemented as a single global
// click interceptor (rather than touching every call site individually) so
// it reliably covers every module, including ones added later.
//
// Convention used across this app: every "edit existing record" button calls
// an inline onclick like `openXxxForm(id)` / `openXxxDetail(id)` with the
// record's id as the first argument (the same function called with NO id
// means "add new", which is left alone); every delete button is
// `class="icon-btn del"`. Both conventions are used consistently everywhere,
// so this single listener reliably gates the whole app.
// ---------------------------------------------------------------------------
function isEditTriggerOnclick(onclickStr) {
  if (!onclickStr) return false;
  const s = onclickStr.trim();
  // e.g. openProductForm(12)  /  openBomForm(4, 10, 2, 'Packing')  /  openAssetDetail(3)
  // NOT matched: openProductForm()  (that's "Add New", not an edit)
  if (/^open[A-Za-z]*(Form|Detail)\(\s*[^)\s]/.test(s)) return true;
  if (/^moveStage\(/.test(s)) return true; // reordering pipeline stages also edits data
  return false;
}
window.__adminAuthCallback = null;
document.addEventListener('click', function (e) {
  const el = e.target.closest('button, a');
  if (!el || el.dataset.adminGateBypass === '1') return;
  const onclickAttr = el.getAttribute('onclick');
  if (!onclickAttr) return;
  if (el.closest('#authScreen')) return; // login/registration screen is unaffected
  const isDelete = el.classList.contains('icon-btn') && el.classList.contains('del');
  const isEdit = el.classList.contains('icon-btn') && !isDelete && isEditTriggerOnclick(onclickAttr);
  if (!isDelete && !isEdit) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  requireAdminPassword(() => {
    el.dataset.adminGateBypass = '1';
    el.click();
    delete el.dataset.adminGateBypass;
  });
}, true);
function requireAdminPassword(onVerified) {
  window.__adminAuthCallback = onVerified;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Admin Authorization Required</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px; color:var(--muted); margin-bottom:10px;">Editing or deleting data requires Admin authorization. Please enter the Admin password to continue.</p>
      <div class="form-field full"><label>Admin Password</label><input type="password" id="fld_admin_auth_password" onkeydown="if(event.key==='Enter'){event.preventDefault(); confirmAdminPassword();}"></div>
      <div id="adminAuthErr" style="color:var(--coral); font-size:12.5px; margin-top:6px;"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="confirmAdminPassword()">Confirm</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  setTimeout(() => document.getElementById('fld_admin_auth_password')?.focus(), 50);
}
async function confirmAdminPassword() {
  const pass = document.getElementById('fld_admin_auth_password').value;
  const errEl = document.getElementById('adminAuthErr');
  try {
    await api('/auth/verify-admin-password', { method: 'POST', body: JSON.stringify({ password: pass }) });
    const cb = window.__adminAuthCallback; window.__adminAuthCallback = null;
    closeModal();
    if (cb) cb();
  } catch (e) { errEl.textContent = e.message || 'Incorrect admin password.'; }
}
async function saveModuleForm(key) {
  const cfg = MODULES[key];
  const data = {};
  for (const f of cfg.fields) { const el = document.getElementById('fld_' + f.key); let v = el.value; if (f.type === 'number') v = v === '' ? 0 : Number(v); data[f.key] = v; }
  try {
    if (editingId) await api(`${cfg.endpoint}/${editingId}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api(cfg.endpoint, { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(`${cfg.label} saved`); renderModule(key);
  } catch (e) { showToast(e.message); }
}
async function deleteModuleRow(key, id) {
  if (!confirm('Delete this record?')) return;
  try { await api(`${MODULES[key].endpoint}/${id}`, { method: 'DELETE' }); showToast('Record deleted'); renderModule(key); }
  catch (e) { showToast(e.message); }
}

// ---------------------------------------------------------------------------
// Products — with inline Bill of Materials (raw materials required per unit)
// ---------------------------------------------------------------------------
let productBomDraft = [];
async function renderProducts(target, showBanner) {
  target = target || 'content'; showBanner = showBanner !== false;
  const c = document.getElementById(target);
  searchQuery = '';
  const rows = await api('/products');
  CACHE.products = rows;
  c.innerHTML = (showBanner ? setHeaderBanner('products', '') : '') + `
    <div class="tbl-toolbar"><input type="text" placeholder="Search products..." oninput="searchQuery=this.value.toLowerCase(); paintProductsTable();">
    <div style="display:flex; gap:8px;">
      <button class="btn btn-outline" onclick="printProductsList()">${ic('print')} Print List</button>
      <button class="btn btn-outline" onclick="openProductForm()">${ic('plus')} Add Product</button>
    </div></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="prodTableWrap"></div></div>`;
  paintProductsTable();
}
function printProductsList() {
  const rows = (CACHE.products || []).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  const dataRows = rows.map((p) => [p.sku||'—', p.name, p.category||'', p.hsn_code||'', p.unit, inr(p.sale_rate), `${productProfitPct(p).toFixed(1)}%`, `${p.stock} ${p.unit}`, p.bom.length ? p.bom.map((b) => `${b.material_name} × ${b.qty_per_unit}${b.material_unit}`).join(', ') : 'Not linked']);
  printGenericReport('Finished Goods List', ['SKU','Name','Category','HSN','Unit','Sale Rate','Profit %','Stock','BOM'], dataRows);
}
function paintProductsTable() {
  const rows = (CACHE.products || []).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  document.getElementById('prodTableWrap').innerHTML = `
    <table><thead><tr><th></th><th>SKU</th><th>Name</th><th>Category</th><th>HSN</th><th>Unit</th><th>Sale Rate</th><th>Cost of Production</th><th>Profit %</th><th>Stock</th><th>BOM</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody>${rows.length ? rows.map((p) => `
      <tr>
        <td>${p.image_data_url ? `<img src="${p.image_data_url}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--paper);display:flex;align-items:center;justify-content:center;font-size:16px;">${ic('image') || '📦'}</div>`}</td>
        <td>${p.sku || '—'}</td><td><b style="cursor:pointer; text-decoration:underline dotted; color:var(--blue);" onclick="event.stopPropagation(); openProductHistoryDetail(${p.id})" title="Click for production & sales history">${p.name}</b>${p.is_bundle ? `<br><span class="badge badge-violet" style="margin-top:2px;">${p.bundle_label || 'Combo Pack'}</span>` : ''}${p.size||p.weight||p.color ? `<div style="font-size:11px; color:var(--muted); margin-top:2px;">${[p.size,p.weight,p.color].filter(Boolean).join(' · ')}</div>` : ''}</td><td>${p.category || ''}</td><td>${p.hsn_code || '—'}</td><td>${p.unit}</td><td>${inr(p.sale_rate)}</td>
        <td><b style="cursor:pointer; text-decoration:underline dotted; color:var(--blue);" onclick="event.stopPropagation(); openCostOfProductionDetail(${p.id})" title="Click for a detailed breakdown">${inr(p.cost_of_production)}</b></td>
        <td>${profitPctBadge(p)}</td>
        <td>${p.is_bundle ? `<span title="Limited by whichever component is scarcest">${p.stock} sets possible</span>` : `${p.stock} ${p.unit}`}</td>
        <td>${p.is_bundle ? (p.bundle_components||[]).map((c) => `<span class="badge badge-violet" style="margin-right:3px;">${c.component_name} × ${c.qty_per_bundle}</span>`).join('') : (p.bom.length ? p.bom.map((b) => `<span class="badge badge-blue" style="margin-right:3px;">${b.material_name} × ${b.qty_per_unit}${b.material_unit}</span>`).join('') : '<span class="badge badge-amber">Not linked</span>')}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Print Barcode" onclick="printBarcodeLabels([${p.id}])">${ic('barcode')}</button>
          <button class="icon-btn" onclick="openProductForm(${p.id})">${ic('edit')}</button>
          <button class="icon-btn del" onclick="deleteProduct(${p.id})">${ic('trash')}</button>
        </div></td>
      </tr>`).join('') : '<tr class="empty-row"><td colspan="12">No products yet.</td></tr>'}</tbody></table>`;
}
// Profit % on cost of production — (Sale Rate − Cost) ÷ Cost × 100. Shown as
// a badge so a glance at the Finished Goods list tells you which products
// are healthy vs. thin-margin vs. actually selling below cost.
function productProfitPct(p) {
  const cost = Number(p.cost_of_production || 0);
  const sale = Number(p.sale_rate || 0);
  if (cost <= 0) return sale > 0 ? 100 : 0;
  return ((sale - cost) / cost) * 100;
}
function profitPctBadge(p) {
  const pct = productProfitPct(p);
  const cls = pct > 20 ? 'badge-green' : (pct >= 0 ? 'badge-amber' : 'badge-red');
  return `<span class="badge ${cls}" title="Profit % on Cost of Production">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
}
async function openCostOfProductionDetail(id) {
  const p = (CACHE.products || []).find((x) => x.id === id);
  if (!p) return;
  const stageRows = p.cost_breakdown.stages || [];
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Cost of Production — ${p.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${inr(p.cost_breakdown.materialCost)}</div><div class="l">Raw Material Cost</div></div>
        <div class="kpi"><div class="n">${inr(p.cost_breakdown.processingCost)}</div><div class="l">Processing (Jobwork)</div></div>
        <div class="kpi"><div class="n">${inr(p.cost_breakdown.overhead)}</div><div class="l">Other Overhead</div></div>
        <div class="kpi"><div class="n" style="color:var(--blue);">${inr(p.cost_of_production)}</div><div class="l">Total Cost of Production</div></div>
      </div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Raw Materials (per unit)</label>
      <table style="margin-bottom:14px;"><thead><tr><th>Material</th><th>Qty</th><th>Rate (Avg.)</th><th>Consumed At Stage</th><th style="text-align:right;">Cost</th></tr></thead>
        <tbody>${p.bom.length ? p.bom.map((b) => `<tr><td>${b.material_name}</td><td>${b.qty_per_unit} ${b.material_unit}</td><td>${inr(b.avg_rate)}</td><td>${b.stage ? `<span class="badge badge-violet">${b.stage}</span>` : '<span class="badge badge-blue">Final Production</span>'}</td><td style="text-align:right;">${inr(b.qty_per_unit*b.avg_rate)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="5">No raw materials linked.</td></tr>'}</tbody></table>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Processing Stages (average jobwork rate)</label>
      <table><thead><tr><th>Stage</th><th style="text-align:right;">Rate per Unit</th></tr></thead>
        <tbody>${stageRows.length ? stageRows.map((s) => `<tr><td>${s.stage}</td><td style="text-align:right;">${inr(s.avg_rate)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="2">No completed outsourcing jobs yet for this product.</td></tr>'}</tbody></table>
      <p style="color:var(--muted); font-size:12px; margin-top:10px;">Manage this in <a href="#" onclick="closeModal(); goTo('bom'); return false;">Inventory &amp; BOM → BOM</a>.</p>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
let pendingProductImageDataUrl = null;
let bundleDraftComponents = [];
function onProductImageSelected(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingProductImageDataUrl = reader.result;
    document.getElementById('productImgPreview').innerHTML = `<img src="${pendingProductImageDataUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}
function removeProductImage() {
  pendingProductImageDataUrl = null;
  document.getElementById('productImgPreview').innerHTML = ic('image') || '📦';
}
async function openProductForm(id) {
  editingId = id || null;
  const row = id ? (CACHE.products || []).find((p) => p.id === id) : { unit: 'Pcs', gst_rate: 18 };
  pendingProductImageDataUrl = row.image_data_url || null;
  bundleDraftComponents = (row.bundle_components || []).map((c) => ({ component_product_id: c.component_product_id, qty_per_bundle: c.qty_per_bundle }));
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:620px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Product</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div style="display:flex; gap:14px; align-items:flex-start; margin-bottom:14px;">
        <div id="productImgPreview" style="width:80px; height:80px; border-radius:10px; overflow:hidden; background:var(--paper); display:flex; align-items:center; justify-content:center; border:1px solid var(--line); flex-shrink:0; font-size:28px;">${pendingProductImageDataUrl ? `<img src="${pendingProductImageDataUrl}" style="width:100%;height:100%;object-fit:cover;">` : (ic('image') || '📦')}</div>
        <div>
          <input type="file" id="productImageFile" accept="image/*" style="display:none;" onchange="onProductImageSelected(event)">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('productImageFile').click()">Upload Photo</button>
          ${pendingProductImageDataUrl ? `<button class="btn btn-outline btn-sm" onclick="removeProductImage()">Remove</button>` : ''}
          <p style="font-size:11px; color:var(--muted); margin-top:6px;">Shown in the product list and on printed catalogues/quotes.</p>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-field"><label>SKU</label><input id="fld_sku" value="${row.sku || ''}" placeholder="Leave blank to auto-generate"></div>
        <div class="form-field"><label>Barcode</label><input id="fld_barcode" value="${row.barcode || ''}" placeholder="Leave blank to use SKU"></div>
        <div class="form-field"><label>Product Name</label><input id="fld_name" value="${row.name || ''}"></div>
        <div class="form-field"><label>Category</label><input id="fld_category" value="${row.category || ''}"></div>
        <div class="form-field"><label>HSN Code</label><input id="fld_hsn_code" value="${row.hsn_code || ''}" placeholder="e.g. 9503"></div>
        <div class="form-field"><label>Unit</label><select id="fld_unit">${UNITS.map((u) => `<option ${u === row.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="form-field"><label>Sale Rate (₹)</label><input type="number" id="fld_sale_rate" value="${row.sale_rate ?? 0}"></div>
        <div class="form-field"><label>GST %</label><input type="number" id="fld_gst_rate" value="${row.gst_rate ?? 18}"></div>
        <div class="form-field"><label>Minimum Stock</label><input type="number" id="fld_min_stock" value="${row.min_stock ?? 0}"></div>
        <div class="form-field" id="openingStockField"><label>Opening Stock</label><input type="number" id="fld_opening_stock" value="${row.opening_stock ?? 0}"></div>
        <div class="form-field"><label>Size</label><input id="fld_size" value="${row.size || ''}" placeholder="e.g. Large, 24cm"></div>
        <div class="form-field"><label>Weight</label><input id="fld_weight" value="${row.weight || ''}" placeholder="e.g. 250g"></div>
        <div class="form-field"><label>Colour</label><input id="fld_color" value="${row.color || ''}" placeholder="e.g. Red, Mixed"></div>
      </div>
      <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">
        <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
          <input type="checkbox" id="fld_is_bundle" ${row.is_bundle ? 'checked' : ''} onchange="toggleBundleSection()"> This is a combo pack / bundle (a Set, Dozen, Box, mixed colours, etc.)
        </label>
        <div id="bundleSection" style="display:${row.is_bundle ? '' : 'none'}; margin-top:12px;">
          <div class="form-field" style="margin-bottom:10px;"><label>Bundle Label</label><input id="fld_bundle_label" value="${row.bundle_label || ''}" placeholder="e.g. Set of 3, Dozen, Box of 12"></div>
          <p style="font-size:11.5px; color:var(--muted); margin-bottom:8px;">A bundle has no stock of its own — selling one automatically deducts the right quantity from each component below.</p>
          <div id="bundleComponentsWrap"></div>
          <button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="addBundleComponentRow()">${ic('plus')} Add Component</button>
        </div>
      </div>
      ${id ? `<div class="template-box" style="margin-top:12px;">
        <b>Current Cost of Production: ${inr(row.cost_of_production)}</b><br>
        <span style="color:var(--muted); font-size:12px;">Manage raw materials, processing cost, and overhead for this figure in <a href="#" onclick="closeModal(); goTo('bom'); return false;">Inventory & BOM → BOM</a>.</span>
      </div>` : `<p style="color:var(--muted); font-size:12px; margin-top:10px;">After saving, link raw materials and set overhead for this product in Inventory &amp; BOM → BOM.</p>`}
    </div>
    <div class="modal-foot">
      ${id ? `<button class="btn btn-outline" onclick="printBarcodeLabels([${id}])">${ic('barcode')} Print Barcode</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveProduct(${id || 'null'})">Save Product</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  paintBundleComponents();
  toggleBundleSection();
}
function toggleBundleSection() {
  const isBundle = document.getElementById('fld_is_bundle').checked;
  document.getElementById('bundleSection').style.display = isBundle ? '' : 'none';
  // A bundle carries no stock of its own — the Opening Stock field is
  // meaningless (and would double-count against its components), so it's
  // hidden rather than left sitting there implying it does something.
  document.getElementById('openingStockField').style.display = isBundle ? 'none' : '';
}
function paintBundleComponents() {
  const products = (CACHE.products || []).filter((p) => !p.is_bundle && p.id !== editingId); // a bundle can't contain itself or another bundle
  document.getElementById('bundleComponentsWrap').innerHTML = bundleDraftComponents.length ? bundleDraftComponents.map((c, i) => `
    <div style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">
      <select style="flex:1;" onchange="bundleDraftComponents[${i}].component_product_id=Number(this.value)">
        ${products.map((p) => `<option value="${p.id}" ${p.id===c.component_product_id?'selected':''}>${p.name}</option>`).join('')}
      </select>
      <input type="number" style="width:80px;" value="${c.qty_per_bundle}" min="0.01" step="0.01" placeholder="Qty" onchange="bundleDraftComponents[${i}].qty_per_bundle=Number(this.value)||1">
      <button class="icon-btn del" onclick="removeBundleComponentRow(${i})">${ic('trash')}</button>
    </div>`).join('') : '<p style="color:var(--muted); font-size:12px;">No components added yet.</p>';
}
function addBundleComponentRow() {
  const products = (CACHE.products || []).filter((p) => !p.is_bundle && p.id !== editingId);
  if (!products.length) { showToast('No non-bundle products available to add as a component'); return; }
  bundleDraftComponents.push({ component_product_id: products[0].id, qty_per_bundle: 1 });
  paintBundleComponents();
}
function removeBundleComponentRow(i) { bundleDraftComponents.splice(i, 1); paintBundleComponents(); }
async function saveProduct(id) {
  const isBundle = document.getElementById('fld_is_bundle').checked;
  if (isBundle && !bundleDraftComponents.length) { showToast('Add at least one component to this bundle, or uncheck "combo pack / bundle"'); return; }
  const data = {
    sku: document.getElementById('fld_sku').value, name: document.getElementById('fld_name').value, barcode: document.getElementById('fld_barcode').value,
    category: document.getElementById('fld_category').value, hsn_code: document.getElementById('fld_hsn_code').value.trim(), unit: document.getElementById('fld_unit').value,
    sale_rate: Number(document.getElementById('fld_sale_rate').value) || 0, gst_rate: Number(document.getElementById('fld_gst_rate').value) || 0,
    min_stock: Number(document.getElementById('fld_min_stock').value) || 0, opening_stock: Number(document.getElementById('fld_opening_stock').value) || 0,
    image_data_url: pendingProductImageDataUrl, size: document.getElementById('fld_size').value, weight: document.getElementById('fld_weight').value, color: document.getElementById('fld_color').value,
    is_bundle: isBundle, bundle_label: document.getElementById('fld_bundle_label')?.value || '', bundle_components: isBundle ? bundleDraftComponents : [],
  };
  try {
    if (id) await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/products', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast('Product saved'); renderProducts();
  } catch (e) { showToast(e.message); }
}
// ---------------------------------------------------------------------------
// Barcode labels — generated and printed entirely client-side (JsBarcode,
// vendored locally in public/vendor/ so this keeps working with no internet
// access), using each product's barcode field (falling back to SKU).
// ---------------------------------------------------------------------------
function printBarcodeLabels(ids) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Print Barcode Labels</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:12.5px; color:var(--muted); margin-bottom:10px;">Prints a sheet of scannable labels — one barcode per label, sized for standard sticker sheets.</p>
      <div class="form-field"><label>Copies per product</label><input type="number" id="barcodeCopies" value="1" min="1"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="doPrintBarcodeLabels(${JSON.stringify(ids)})">${ic('print')} Print</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function doPrintBarcodeLabels(ids) {
  const copies = Math.max(1, Number(document.getElementById('barcodeCopies').value) || 1);
  const products = (CACHE.products || []).filter((p) => ids.includes(p.id));
  if (!products.length) { showToast('No products to print'); return; }
  const missingCode = products.filter((p) => !(p.barcode || p.sku || '').trim());
  if (missingCode.length === products.length) { showErrorPopup('No Barcode Set', 'None of the selected products have a barcode or SKU. Add one in the product form first.'); return; }
  closeModal();
  let labels = '';
  products.forEach((p) => {
    const code = (p.barcode || p.sku || '').trim();
    if (!code) return;
    for (let i = 0; i < copies; i++) {
      labels += `<div class="barcode-label">
        <div class="barcode-label-name">${p.name}</div>
        <svg class="barcode-svg" data-code="${code.replace(/"/g, '&quot;')}"></svg>
        <div class="barcode-label-price">${inr(p.sale_rate)}</div>
      </div>`;
    }
  });
  document.getElementById('printArea').innerHTML = `<div class="barcode-label-sheet">${labels}</div>`;
  document.querySelectorAll('#printArea .barcode-svg').forEach((svg) => {
    try { JsBarcode(svg, svg.dataset.code, { format: 'CODE128', width: 1.6, height: 42, fontSize: 12, margin: 4 }); }
    catch (e) { svg.outerHTML = `<div style="font-size:10px; color:red;">Invalid barcode: ${svg.dataset.code}</div>`; }
  });
  setTimeout(() => window.print(), 100); // let the SVG barcodes render before the print dialog opens
}
async function deleteProduct(id) {
  if (!confirm('Delete this product?')) return;
  try { await api(`/products/${id}`, { method: 'DELETE' }); showToast('Product deleted'); renderProducts(); } catch (e) { showToast(e.message); }
}

// ---------------------------------------------------------------------------
// Production (final assembly — adds finished-goods stock)
// ---------------------------------------------------------------------------
async function renderProduction() {
  const c = document.getElementById('content');
  const [rows, products, employees] = await Promise.all([api('/production'), api('/products'), api('/employees')]);
  CACHE.production = rows; CACHE.products = products; CACHE.employees = employees;
  c.innerHTML = setHeaderBanner('production', `<button class="btn btn-outline" onclick="openProductionForm()">${ic('plus')} Add Production Entry</button>`) + `
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Date</th><th>Batch</th><th>Product</th><th>Shift</th><th>Planned</th><th>Produced</th><th>Defective</th><th>Good Qty</th><th>Operator</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `
        <tr><td>${fmtDate(r.date)}</td><td>${r.batch_no || ''}</td><td>${r.product_name}</td><td>${r.shift}</td><td>${r.planned_qty}</td><td>${r.produced_qty}</td><td>${r.defective_qty}</td>
        <td><b>${r.produced_qty - r.defective_qty}</b></td><td>${r.operator_name || '—'}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openProductionForm(${r.id})">${ic('edit')}</button>
          <button class="icon-btn" title="Print" onclick="printProduction(${r.id})">${ic('print')}</button>
          <button class="icon-btn del" onclick="deleteProduction(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="10">No production entries yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function openProductionForm(id, lock) {
  editingId = id || null;
  const products = CACHE.products || []; const employees = CACHE.employees || [];
  const row = id ? (CACHE.production || []).find((r) => r.id === id)
    : { date: todayISO(), product_id: (lock && lock.productId) || products[0]?.id, shift: 'Morning', planned_qty: (lock && lock.qty) || 0, produced_qty: (lock && lock.qty) || 0, defective_qty: 0, operator_id: employees[0]?.id };
  const locked = !!lock;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Production Entry</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      ${locked ? `<p style="font-size:12.5px; background:var(--paper); border-radius:8px; padding:8px 12px; margin-bottom:10px;">This qty just came out of the last pipeline stage — Product and Produced Qty are locked. Fill in the batch, shift, defective qty and operator to shift it into Finished Goods stock.</p>` : ''}
      <div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Batch No</label><input id="fld_batch_no" placeholder="BATCH-032" value="${row.batch_no||''}"></div>
      <div class="form-field"><label>Product</label><select id="fld_product_id" ${locked?'disabled':''}>${products.map((p) => `<option value="${p.id}" ${p.id===row.product_id?'selected':''}>${p.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Shift</label><select id="fld_shift">${['Morning','Evening','Night'].map((s) => `<option ${s===row.shift?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Planned Qty</label><input type="number" id="fld_planned_qty" value="${row.planned_qty||0}" ${locked?'disabled':''}></div>
      <div class="form-field"><label>Produced Qty${locked?' (from last stage)':''}</label><input type="number" id="fld_produced_qty" value="${row.produced_qty||0}" ${locked?'disabled':''} oninput="paintProductionGoodQtyPreview()"></div>
      <div class="form-field"><label>Defective Qty</label><input type="number" id="fld_defective_qty" value="${row.defective_qty||0}" oninput="paintProductionGoodQtyPreview()"></div>
      <div class="form-field"><label>Good Qty (auto)</label><input id="fld_good_qty_preview" value="${(row.produced_qty||0)-(row.defective_qty||0)}" disabled></div>
      <div class="form-field"><label>Operator</label><select id="fld_operator_id">${employees.map((e) => `<option value="${e.id}" ${e.id===row.operator_id?'selected':''}>${e.name}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveProduction(${id||'null'})">Save Entry</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
// Good Qty (= Produced − Defective) shown live as a read-only preview —
// the actual "good qty" the Production save logic adds to Finished Goods.
function paintProductionGoodQtyPreview() {
  const produced = Number(fld('produced_qty') || 0); const defective = Number(fld('defective_qty') || 0);
  const el = document.getElementById('fld_good_qty_preview'); if (el) el.value = Math.max(produced - defective, 0);
}
async function saveProduction(id) {
  const data = { date: fld('date'), batch_no: fld('batch_no'), product_id: Number(fld('product_id')), shift: fld('shift'),
    planned_qty: Number(fld('planned_qty')), produced_qty: Number(fld('produced_qty')), defective_qty: Number(fld('defective_qty')),
    operator_id: Number(fld('operator_id')), remarks: fld('remarks') };
  try {
    let saved;
    if (id) saved = await api(`/production/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/production', { method: 'POST', body: JSON.stringify(data) });
    const rewards = saved.unlockedIncentives || [];
    if (rewards.length) pendingSavePopup = false;
    closeModal(); showToast(id ? 'Production entry updated' : 'Production entry added — finished stock updated');
    if (rewards.length) showUnlockedIncentives(rewards);
    renderProduction();
  } catch (e) { showToast(e.message); }
}
function printProduction(id) {
  const r = (CACHE.production || []).find((x) => x.id === id); if (!r) return;
  printGenericReport('Production Slip — Batch ' + (r.batch_no||r.id), ['Date','Product','Shift','Planned','Produced','Defective','Good Qty','Operator'],
    [[fmtDate(r.date), r.product_name, r.shift, r.planned_qty, r.produced_qty, r.defective_qty, r.produced_qty-r.defective_qty, r.operator_name||'—']], r.remarks||'');
}
async function deleteProduction(id) { if (!confirm('Delete this entry? Finished stock will be reversed.')) return; try { await api(`/production/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderProduction(); } catch (e) { showToast(e.message); } }
function fld(key) { return document.getElementById('fld_' + key)?.value; }

// ---------------------------------------------------------------------------
// Production Pipeline — internal stage tracking (Molding → Packing)
// ---------------------------------------------------------------------------
async function openStageBreakdown(stage) {
  const d = await api(`/reports/pipeline/stage/${encodeURIComponent(stage)}/breakdown`);
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${stage} — Completed By</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <table><thead><tr><th>Jobworker</th><th>Qty Completed</th><th>Amount</th></tr></thead>
        <tbody>${d.byPerson.length ? d.byPerson.map((p) => `<tr><td>${p.person_name}</td><td><b>${p.qty}</b></td><td>${inr(p.amount)}</td></tr>`).join('') : ''}
        ${d.inhouseQty > 0 ? `<tr><td><b>In-house (own staff)</b></td><td><b>${d.inhouseQty}</b></td><td>—</td></tr>` : ''}
        ${!d.byPerson.length && d.inhouseQty <= 0 ? '<tr class="empty-row"><td colspan="3">No work completed at this stage yet.</td></tr>' : ''}</tbody>
      </table>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function renderPipeline() {
  const c = document.getElementById('content');
  const [pipe, stageRows, products] = await Promise.all([api('/reports/pipeline'), api('/production-stages'), api('/products')]);
  CACHE.products = products; CACHE.stageRows = stageRows;
  c.innerHTML = setHeaderBanner('pipeline', `<button class="btn btn-outline" onclick="openStageForm()">${ic('plus')} Log Stage Movement</button>`) + `
    <div class="pipeline" style="margin-bottom:18px;">
      ${pipe.stages.map((s, i) => `<div class="pipe-stage" style="cursor:pointer;" onclick="openStageBreakdown('${s.stage}')" title="Click to see who completed this work">
        <div class="icon" style="background:${['#3B6EF6','#EF9F2E','#7C6FE0','#E15A5A','#28A97A'][i]}">${ic('factory')}</div>
        <div class="qty">${s.atStage.toFixed(0)}</div><div class="lbl">${s.stage}</div>
        <div style="font-size:10.5px; color:var(--muted); margin-top:4px;">${s.outsourcedPending>0?s.outsourcedPending.toFixed(0)+' with jobworker':'in-house'}</div>
        <div style="font-size:10px; color:var(--muted); margin-top:3px; border-top:1px dashed var(--line); padding-top:3px;">Out: ${s.completedOutput.toFixed(0)} — Sent ${s.sentToNextStage.toFixed(0)} / Pending ${s.pendingForNextStage.toFixed(0)}</div>
      </div>`).join('')}
      <div class="pipe-stage" style="border:2px solid #28A97A;"><div class="icon" style="background:#28A97A;">${ic('box')}</div><div class="qty">${pipe.finishedGoods.toFixed(0)}</div><div class="lbl">Finished Goods</div></div>
    </div>
    <div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="printPipelineLog()">${ic('print')} Print Log</button></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Date</th><th>Product</th><th>Stage</th><th>Qty In</th><th>Qty Out</th><th>Remarks</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${stageRows.length ? stageRows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${r.product_name}</td><td><span class="badge badge-blue">${r.stage}</span></td><td>${r.qty_in}</td><td>${r.qty_out}</td><td>${r.remarks || ''}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openStageForm(${r.id})">${ic('edit')}</button>
          <button class="icon-btn del" onclick="deleteStage(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="7">No stage movements logged yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function openStageForm(id) {
  editingId = id || null;
  const products = CACHE.products || [];
  const row = id ? (CACHE.stageRows || []).find((r) => r.id === id) : { date: todayISO(), product_id: products[0]?.id, stage: STAGES[0] };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Log'} Stage Movement</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Product</label><select id="fld_product_id">${products.map((p) => `<option value="${p.id}" ${p.id===row.product_id?'selected':''}>${p.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Stage</label><select id="fld_stage">${STAGES.map((s) => `<option ${s===row.stage?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Qty Moved In</label><input type="number" id="fld_qty_in" value="${row.qty_in||0}"></div>
      <div class="form-field"><label>Qty Moved Out (to next stage)</label><input type="number" id="fld_qty_out" value="${row.qty_out||0}"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveStage(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveStage(id) {
  const data = { date: fld('date'), product_id: Number(fld('product_id')), stage: fld('stage'), qty_in: Number(fld('qty_in')), qty_out: Number(fld('qty_out')), remarks: fld('remarks') };
  try {
    let saved;
    if (id) saved = await api(`/production-stages/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/production-stages', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Stage movement updated' : 'Stage movement logged'); renderPipeline();
    if (saved.stageCompleted) showStageCompletedPopup(saved.productId, saved.productName, saved.shiftedQty);
  } catch (e) { alert(e.message); }
}
// Shown when a product finishes the LAST pipeline stage (in-house or
// outsourced). Rather than silently pushing stock into Finished Goods, this
// hands off to a proper Production Entry — batch no, shift, defective qty,
// good qty and operator — exactly like a normal in-house production run.
function showStageCompletedPopup(productId, productName, qty) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${ic('bell')} Stage Pipeline Complete</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p>The product completed its all stage and it will be shifted to the Finished Good in Inventory.</p>
      <p style="color:var(--muted); font-size:12.5px; margin-top:8px;"><b>${qty}</b> unit(s) of <b>${productName}</b> came out of the last stage. Complete the production entry below to shift it into Finished Goods stock.</p>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="openProductionEntryFromStage(${productId}, '${String(productName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${qty})">Continue to Production Entry</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
// Opens the Production Entry form pre-filled from a just-completed pipeline
// run: Product and Produced Qty are locked (they came straight from the
// pipeline's last stage) — the user only fills in Batch No, Shift,
// Defective Qty and Operator. Saving it is what actually adds the qty to
// Finished Goods stock (via the normal Production save logic).
async function openProductionEntryFromStage(productId, productName, qty) {
  if (!CACHE.products) CACHE.products = await api('/products');
  if (!CACHE.employees) CACHE.employees = await api('/employees');
  openProductionForm(null, { productId, qty });
}
async function deleteStage(id) { if (!confirm('Delete this entry?')) return; try { await api(`/production-stages/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderPipeline(); } catch (e) { showToast(e.message); } }
function printPipelineLog() {
  const rows = CACHE.stageRows || [];
  printGenericReport('Production Pipeline Log', ['Date','Product','Stage','Qty In','Qty Out','Remarks'],
    rows.map((r) => [fmtDate(r.date), r.product_name, r.stage, r.qty_in, r.qty_out, r.remarks||'']));
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Sales/Purchase Daily · Monthly · Yearly totals — shared KPI strip used on
// the Sales page, the Purchases page, and the Reports module.
// ---------------------------------------------------------------------------
async function salesPurchaseKpiHtml(which) {
  let s;
  try { s = await api('/reports/sales-purchase-summary'); } catch (e) { return ''; }
  const d = which === 'purchase' ? s.purchase : s.sales;
  const label = which === 'purchase' ? 'Purchase' : 'Sales';
  return `<div class="kpi-strip" style="margin-bottom:14px;">
    <div class="kpi"><div class="n">${inr(d.daily)}</div><div class="l">Today's ${label} (${d.dailyCount})</div></div>
    <div class="kpi"><div class="n">${inr(d.monthly)}</div><div class="l">This Month's ${label} (${d.monthlyCount})</div></div>
    <div class="kpi"><div class="n">${inr(d.yearly)}</div><div class="l">This Year's ${label} (${d.yearlyCount})</div></div>
  </div>`;
}
async function renderPurchases() {
  const [rows, suppliers, rawMaterials, products] = await Promise.all([api('/purchases'), api('/suppliers'), api('/raw-materials'), api('/products')]);
  CACHE.purchases = rows; CACHE.suppliers = suppliers; CACHE.rawMaterials = rawMaterials; CACHE.products = products;
  document.getElementById('content').innerHTML = setHeaderBanner('purchases', `<button class="btn btn-outline" onclick="openPurchaseForm()">${ic('plus')} New Purchase</button>`) + `
    <div id="purchKpiWrap"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>PO No</th><th>Date</th><th>Supplier</th><th>Type</th><th>Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Total Payable</th><th>Paid</th><th>Balance</th><th>Invoice No</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td><b>${r.purchase_no}</b></td><td>${fmtDate(r.purchase_date)}</td><td>${r.supplier_name}</td><td>${r.item_type||'RAW_MATERIAL'}</td><td>${r.material_name}</td><td>${r.hsn_code||'—'}</td><td>${r.qty} ${r.unit}</td><td>${inr(r.rate)}</td><td>${inr(r.amount)}</td><td>${r.gst_pct||0}% <span style="color:var(--muted);">(${inr(r.gst_amt||0)})</span></td><td>${inr(r.payable ?? (Number(r.amount||0)+Number(r.gst_amt||0)))}</td><td style="color:var(--green);">${inr(r.paid||0)}</td><td style="font-weight:700;color:${(r.balance||0)>0?'var(--coral)':'var(--green)'};">${inr(r.balance||0)}</td><td>${r.invoice_no || ''}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          ${r.status==='Ordered' ? `<button class="btn btn-sm btn-primary" onclick="receivePurchase(${r.id})">Receive</button>` : `<span class="badge badge-green">Received</span>`}
           <button class="icon-btn" title="Edit" onclick="openPurchaseForm(${r.id})">${ic('edit')}</button>
          ${r.status==='Received' && r.item_type!=='ASSET' ? `<button class="icon-btn" title="Return goods to supplier" onclick="openPurchaseReturnFor(${r.id})" style="color:#E15A5A;">${ic('back')}</button>` : ''}
          <button class="icon-btn" title="Print" onclick="printPurchase(${r.id})">${ic('print')}</button>
          <button class="icon-btn del" onclick="deletePurchase(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="15">No purchases yet.</td></tr>'}</tbody>
    </table></div></div>`;
  document.getElementById('purchKpiWrap').innerHTML = await salesPurchaseKpiHtml('purchase');
}
function openPurchaseForm(id) {
  editingId = id || null;
  const suppliers = CACHE.suppliers || [], mats = CACHE.rawMaterials || [], products = CACHE.products || [];
  const row = id ? (CACHE.purchases || []).find((r) => r.id === id) : { purchase_date: todayISO(), supplier_id: suppliers[0]?.id, item_type:'RAW_MATERIAL', raw_material_id: mats[0]?.id, product_id: products[0]?.id, qty: 0, rate: 0, gst_pct: 18, status:'Ordered' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'New'} Purchase Order</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_purchase_date" value="${row.purchase_date}"></div>
      <div class="form-field"><label>Supplier</label><select id="fld_supplier_id" onchange="paintPurchaseSupplierBalance()">${suppliers.map((s) => `<option value="${s.id}" ${s.id==row.supplier_id?'selected':''}>${s.name} — Balance ${inr(s.balance||0)}</option>`).join('')}</select><div id="purchaseSupplierBalance" style="font-size:11px;color:var(--muted);margin-top:4px;"></div></div>
      <div class="form-field"><label>Item Classification</label><select id="fld_item_type" onchange="togglePurchaseItemFields()">
        ${['RAW_MATERIAL','FINISHED_PRODUCT','ASSET'].map((t)=>`<option value="${t}" ${t===(row.item_type||'RAW_MATERIAL')?'selected':''}>${t.replace('_',' ')}</option>`).join('')}
      </select></div>
      <div class="form-field" id="purchaseRawField"><label>Raw Material</label><select id="fld_raw_material_id">${mats.map((m) => `<option value="${m.id}" ${m.id==row.raw_material_id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="form-field" id="purchaseProductField"><label>Finished Product</label><select id="fld_product_id">${products.map((p) => `<option value="${p.id}" ${p.id==row.product_id?'selected':''}>${p.name} — ${p.hsn_code||'No HSN'}</option>`).join('')}</select></div>
      <div class="form-field"><label>Quantity</label><input type="number" id="fld_qty" value="${row.qty||0}" oninput="paintPurchaseTaxPreview()"></div>
      <div class="form-field"><label>Rate per Unit (₹, excl. GST)</label><input type="number" id="fld_rate" value="${row.rate||0}" oninput="paintPurchaseTaxPreview()"></div>
      <div class="form-field"><label>GST % (Input GST)</label><input type="number" id="fld_gst_pct" value="${row.gst_pct ?? 18}" min="0" max="100" oninput="paintPurchaseTaxPreview()"></div>
      <div class="form-field"><label>Amount Paid Now (₹)</label><input type="number" id="fld_paid_amount" value="${row.paid||0}" min="0" oninput="paintPurchaseTaxPreview()"><div style="font-size:11px;color:var(--muted);margin-top:4px;">Paid amount is linked to this purchase and reflected in Supplier Balance.</div></div>
      <div class="form-field"><label>Payment Mode</label><select id="fld_paid_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m)=>`<option ${m===(row.paid_mode||'Cash')?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>PO Status</label><select id="fld_purchase_status"><option value="Ordered" ${row.status==='Ordered'?'selected':''}>Ordered</option><option value="Received" ${row.status==='Received'?'selected':''}>Received</option></select></div>
      <div class="form-field"><label>Invoice No</label><input id="fld_invoice_no" value="${row.invoice_no||''}"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div>
    <div id="purchaseTaxPreview" style="margin-top:10px; font-size:12.5px; color:var(--muted);"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePurchase(${id||'null'})">Save Purchase Order</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  togglePurchaseItemFields(); paintPurchaseTaxPreview(); paintPurchaseSupplierBalance();
}
function togglePurchaseItemFields() {
  const t = document.getElementById('fld_item_type')?.value || 'RAW_MATERIAL';
  const raw = document.getElementById('purchaseRawField'), prod = document.getElementById('purchaseProductField');
  if (raw) raw.style.display = t==='RAW_MATERIAL' ? '' : 'none';
  if (prod) prod.style.display = t==='FINISHED_PRODUCT' ? '' : 'none';
}
function paintPurchaseTaxPreview() {
  const qty = Number(document.getElementById('fld_qty')?.value) || 0;
  const rate = Number(document.getElementById('fld_rate')?.value) || 0;
  const gstPct = Number(document.getElementById('fld_gst_pct')?.value) || 0;
  const amount = qty * rate;
  const gstAmt = amount * gstPct / 100;
  const payable = amount + gstAmt;
  const paid = Math.min(Math.max(Number(document.getElementById('fld_paid_amount')?.value)||0,0), payable);
  const preview = document.getElementById('purchaseTaxPreview');
  if (preview) preview.innerHTML = `Taxable Value: <b>${inr(amount)}</b> &nbsp;+&nbsp; Input GST: <b>${inr(gstAmt)}</b> &nbsp;=&nbsp; Total Payable: <b style="color:var(--ink);">${inr(payable)}</b><br><span style="color:var(--green);">Amount Paid: <b>${inr(paid)}</b></span> &nbsp; <span style="color:${payable-paid>0?'var(--coral)':'var(--green)'};font-weight:700;">Balance: ${inr(Math.max(0,payable-paid))}</span>`;
  paintPurchaseSupplierBalance();
}
function paintPurchaseSupplierBalance() {
  const supId = Number(document.getElementById('fld_supplier_id')?.value);
  const s = (CACHE.suppliers || []).find((x) => x.id === supId);
  const el = document.getElementById('purchaseSupplierBalance');
  if (el && s) el.innerHTML = `Current supplier balance: <b style="color:${Number(s.balance||0)>0?'var(--coral)':'var(--green)'};">${inr(s.balance||0)}</b>`;
}

async function savePurchase(id) {
  const type = fld('item_type');
  const data = { purchase_date: fld('purchase_date'), supplier_id: Number(fld('supplier_id')), item_type:type,
    raw_material_id: type==='RAW_MATERIAL' ? Number(fld('raw_material_id')) : null,
    product_id: type==='FINISHED_PRODUCT' ? Number(fld('product_id')) : null,
    qty: Number(fld('qty')), rate: Number(fld('rate')), gst_pct: Number(fld('gst_pct')) || 0,
    paid_amount: Number(fld('paid_amount')) || 0, paid_mode: fld('paid_mode') || 'Cash',
    status: fld('purchase_status'), invoice_no: fld('invoice_no'), remarks: fld('remarks') };
  try {
    if (id) await api(`/purchases/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/purchases', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Purchase order updated' : 'Purchase order saved'); renderPurchases();
  } catch (e) { showToast(e.message); }
}
async function receivePurchase(id) {
  try { await api(`/purchases/${id}/receive`, {method:'POST', body:'{}'}); showToast('Purchase received — inventory updated'); renderPurchases(); }
  catch(e){ showToast(e.message); }
}
async function deletePurchase(id) { if (!confirm('Delete this purchase? Stock will be reversed.')) return; try { await api(`/purchases/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderPurchases(); } catch (e) { showToast(e.message); } }
function printPurchase(id) {
  const r = (CACHE.purchases || []).find((x) => x.id === id); if (!r) return;
  printGenericReport('Purchase Voucher — ' + r.purchase_no, ['Date','Supplier','Type','Item','HSN','Qty','Rate','Taxable Amount','GST %','GST Amt','Invoice No'],
    [[fmtDate(r.purchase_date), r.supplier_name, r.item_type||'', r.material_name, r.hsn_code||'', `${r.qty} ${r.unit}`, inr(r.rate), inr(r.amount), `${r.gst_pct||0}%`, inr(r.gst_amt||0), r.invoice_no||'']], r.remarks || '');
}

// ---------------------------------------------------------------------------
// Supplier Payments
// ---------------------------------------------------------------------------
async function renderSupplierPayments() {
  const [rows, suppliers, purchases] = await Promise.all([api('/supplier-payments'), api('/suppliers'), api('/purchases')]);
  CACHE.supplierPayments = rows; CACHE.suppliers = suppliers; CACHE.purchases = purchases;
  document.getElementById('content').innerHTML = setHeaderBanner('supplierPayments', `<button class="btn btn-outline" onclick="openSupplierPaymentForm()">${ic('plus')} Add Payment</button>`) + `
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Date</th><th>Supplier</th><th>Against Purchase</th><th>Amount</th><th>Mode</th><th>Reference</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${r.supplier_name}</td><td>${(CACHE.purchases||[]).find((p)=>p.id===r.purchase_id)?.purchase_no||'General'}</td><td>${inr(r.amount)}</td><td>${r.mode}</td><td>${r.reference_no || ''}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openSupplierPaymentForm(${r.id})">${ic('edit')}</button>
          <button class="icon-btn" title="Print" onclick="printSupplierPayment(${r.id})">${ic('print')}</button>
          <button class="icon-btn del" onclick="deleteSupplierPayment(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="7">No payments recorded yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function openSupplierPaymentForm(id) {
  editingId = id || null;
  const suppliers = CACHE.suppliers || [];
  const row = id ? (CACHE.supplierPayments || []).find((r) => r.id === id) : { date: todayISO(), supplier_id: suppliers[0]?.id, amount: 0, mode: 'Cash' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Supplier Payment</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Supplier</label><select id="fld_supplier_id" onchange="onSupplierPaymentSupplierChange()">${suppliers.map((s) => `<option value="${s.id}" ${s.id===row.supplier_id?'selected':''}>${s.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Against Purchase</label><select id="fld_purchase_id" onchange="onSupplierPaymentPurchaseChange()"></select></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_amount" value="${row.amount||0}"></div>
      <div class="form-field"><label>Mode</label><select id="fld_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option ${m===row.mode?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>Reference No</label><input id="fld_reference_no" value="${row.reference_no||''}"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveSupplierPayment(${id||'null'})">Save</button></div>`;
  onSupplierPaymentSupplierChange(row.purchase_id);
  document.getElementById('modalBg').classList.add('show');
}
function onSupplierPaymentSupplierChange(currentPurchaseId) {
  const supId = Number(fld('supplier_id'));
  const purchases = (CACHE.purchases || []).filter((p) => p.supplier_id === supId && (p.balance > 0 || p.id === currentPurchaseId));
  document.getElementById('fld_purchase_id').innerHTML = `<option value="">(General / On Account)</option>` + purchases.map((p) => `<option value="${p.id}" ${p.id===currentPurchaseId?'selected':''}>${p.purchase_no} — Balance ${inr(p.balance)}</option>`).join('');
}
function onSupplierPaymentPurchaseChange() {
  const pid = fld('purchase_id');
  if (!pid) return;
  const p = (CACHE.purchases || []).find((x) => x.id === Number(pid));
  if (p) document.getElementById('fld_amount').value = p.balance;
}
async function saveSupplierPayment(id) {
  const data = { date: fld('date'), supplier_id: Number(fld('supplier_id')), purchase_id: fld('purchase_id') ? Number(fld('purchase_id')) : null, amount: Number(fld('amount')), mode: fld('mode'), reference_no: fld('reference_no'), remarks: fld('remarks') };
  try {
    if (id) await api(`/supplier-payments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/supplier-payments', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Payment updated' : 'Payment recorded'); renderSupplierPayments();
  } catch (e) { showToast(e.message); }
}
async function deleteSupplierPayment(id) { if (!confirm('Delete this payment?')) return; try { await api(`/supplier-payments/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderSupplierPayments(); } catch (e) { showToast(e.message); } }
function printSupplierPayment(id) {
  const r = (CACHE.supplierPayments || []).find((x) => x.id === id); if (!r) return;
  const p = (CACHE.purchases || []).find((x) => x.id === r.purchase_id);
  printGenericReport('Payment Voucher', ['Date','Supplier','Against Purchase','Amount','Mode','Reference No'],
    [[fmtDate(r.date), r.supplier_name, p?.purchase_no||'General', inr(r.amount), r.mode, r.reference_no||'']], r.remarks || '');
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
async function renderAttendance() {
  const [rows, employees] = await Promise.all([api('/attendance'), api('/employees')]);
  CACHE.attendance = rows; CACHE.employees = employees;
  document.getElementById('content').innerHTML = setHeaderBanner('attendance', `<button class="btn btn-outline" onclick="printAttendanceList()">${ic('print')} Print Register</button> <button class="btn btn-outline" onclick="openBulkAttendanceForm()">${ic('users')} Mark All</button> <button class="btn btn-outline" onclick="openAttendanceForm()">${ic('plus')} Mark Attendance</button>`) + `
    <div class="tbl-toolbar">
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:12px; color:var(--muted);">From <input type="date" id="attFrom" onchange="paintAttendanceTable()" style="margin-left:4px;"></label>
        <label style="font-size:12px; color:var(--muted);">To <input type="date" id="attTo" onchange="paintAttendanceTable()" style="margin-left:4px;"></label>
        <select id="attEmployee" onchange="paintAttendanceTable()"><option value="">All Employees</option>${employees.map((e) => `<option value="${e.id}">${e.name}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('attFrom').value=''; document.getElementById('attTo').value=''; document.getElementById('attEmployee').value=''; paintAttendanceTable();">Clear</button>
      </div>
    </div>
    <div id="attKpiWrap"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="attTableWrap"></div></div>`;
  paintAttendanceTable();
}
function paintAttendanceTable() {
  const from = document.getElementById('attFrom')?.value || '';
  const to = document.getElementById('attTo')?.value || '';
  const empId = document.getElementById('attEmployee')?.value || '';
  const rows = (CACHE.attendance || []).filter((r) =>
    (!from || r.work_date >= from) && (!to || r.work_date <= to) && (!empId || r.employee_id === Number(empId)));
  const totalOt = rows.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
  const totalWorking = rows.reduce((s, r) => s + Number(r.working_hours || 0), 0);
  document.getElementById('attKpiWrap').innerHTML = `<div class="kpi-strip" style="margin-bottom:14px;">
    <div class="kpi"><div class="n">${totalWorking.toFixed(2)}</div><div class="l">Total Working Hours</div></div>
    <div class="kpi"><div class="n" style="color:var(--amber);">${totalOt.toFixed(2)}</div><div class="l">Total Overtime (OT) Hours${empId ? '' : ' — all employees'}</div></div>
    <div class="kpi"><div class="n">${rows.length}</div><div class="l">Attendance Records</div></div>
  </div>`;
  document.getElementById('attTableWrap').innerHTML = `<table>
      <thead><tr><th>Date</th><th>Employee</th><th>In</th><th>Out</th><th>Working Hrs</th><th>OT Hrs</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.work_date)}</td><td>${r.employee_name}</td><td>${r.in_time||'—'}</td><td>${r.out_time||'—'}</td><td>${Number(r.working_hours).toFixed(2)}</td><td>${Number(r.overtime_hours).toFixed(2)}</td>
        <td><span class="badge ${r.status==='Present'?'badge-green':(r.status==='Half Day'?'badge-amber':'badge-red')}">${r.status}</span></td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openAttendanceForm(${r.id})">${ic('edit')}</button>
          <button class="icon-btn del" onclick="deleteAttendance(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="8">No attendance marked yet.</td></tr>'}</tbody>
    </table>`;
}
function openAttendanceForm(id) {
  editingId = id || null;
  const employees = CACHE.employees || [];
  const row = id ? (CACHE.attendance || []).find((r) => r.id === id) : { employee_id: employees[0]?.id, work_date: todayISO(), in_time: '09:00', out_time: '17:30', status: 'Present' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Mark'} Attendance</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Employee</label><select id="fld_employee_id">${employees.map((e) => `<option value="${e.id}" ${e.id===row.employee_id?'selected':''}>${e.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Date</label><input type="date" id="fld_work_date" value="${row.work_date}"></div>
      <div class="form-field"><label>In Time</label><input id="fld_in_time" placeholder="09:00" value="${row.in_time||''}"></div>
      <div class="form-field"><label>Out Time</label><input id="fld_out_time" placeholder="17:30" value="${row.out_time||''}"></div>
      <div class="form-field"><label>Status</label><select id="fld_status">${['Present','Absent','Half Day','On Leave'].map((s) => `<option ${s===row.status?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveAttendance(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveAttendance(id) {
  const data = { employee_id: Number(fld('employee_id')), work_date: fld('work_date'), in_time: fld('in_time'), out_time: fld('out_time'), status: fld('status'), remarks: fld('remarks') };
  try {
    let saved;
    if (id) saved = await api(`/attendance/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/attendance', { method: 'POST', body: JSON.stringify(data) });
    const rewards = saved.unlockedIncentives || [];
    if (rewards.length) pendingSavePopup = false;
    closeModal(); showToast(id ? 'Attendance updated' : 'Attendance saved');
    if (rewards.length) showUnlockedIncentives(rewards);
    renderAttendance();
  } catch (e) { showToast(e.message); }
}
async function deleteAttendance(id) { if (!confirm('Delete this record?')) return; try { await api(`/attendance/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderAttendance(); } catch (e) { showToast(e.message); } }
function openBulkAttendanceForm() {
  const employees = CACHE.employees || [];
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:560px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Mark Attendance — All Employees</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-field"><label>Date</label><input type="date" id="fld_bulk_date" value="${todayISO()}"></div>
        <div class="form-field"><label>Status</label><select id="fld_bulk_status">${['Present','Absent','Half Day','On Leave'].map((s) => `<option>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label>In Time</label><input id="fld_bulk_in" value="09:00"></div>
        <div class="form-field"><label>Out Time</label><input id="fld_bulk_out" value="17:30"></div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin:12px 0 6px;">
        <label style="font-size:12px; font-weight:600; color:var(--muted);">Employees</label>
        <label style="font-size:12.5px; display:flex; align-items:center; gap:6px;"><input type="checkbox" id="bulkSelectAll" checked onchange="toggleAllBulkAttendance(this.checked)"> Select All</label>
      </div>
      <div class="tbl-scroll" style="max-height:260px; border:1px solid var(--line); border-radius:10px; padding:4px 10px;">
        ${employees.map((e) => `<label style="display:flex; align-items:center; gap:8px; padding:7px 2px; border-bottom:1px dashed var(--line);"><input type="checkbox" class="bulk-att-emp" value="${e.id}" checked> ${e.name} <span style="color:var(--muted); font-size:11.5px;">(${e.department||''})</span></label>`).join('') || '<div style="padding:12px; color:var(--muted);">No employees found.</div>'}
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveBulkAttendance()">Mark Selected</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function toggleAllBulkAttendance(checked) { document.querySelectorAll('.bulk-att-emp').forEach((cb) => { cb.checked = checked; }); }
async function saveBulkAttendance() {
  const employee_ids = Array.from(document.querySelectorAll('.bulk-att-emp:checked')).map((cb) => Number(cb.value));
  if (!employee_ids.length) { showToast('Select at least one employee'); return; }
  const data = { work_date: fld('bulk_date'), employee_ids, status: fld('bulk_status'), in_time: fld('bulk_in'), out_time: fld('bulk_out') };
  try {
    const res = await api('/attendance/bulk', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(`Marked ${res.marked} employee(s)`); renderAttendance();
    if (res.unlockedIncentives?.length) showUnlockedIncentives(res.unlockedIncentives);
  } catch (e) { showToast(e.message); }
}
function printAttendanceList() {
  const rows = CACHE.attendance || [];
  printGenericReport('Attendance Register', ['Date','Employee','In','Out','Working Hrs','OT Hrs','Status'],
    rows.map((r) => [fmtDate(r.work_date), r.employee_name, r.in_time||'—', r.out_time||'—', Number(r.working_hours).toFixed(2), Number(r.overtime_hours).toFixed(2), r.status]));
}

// ---------------------------------------------------------------------------
// Employee Advances — salary advances, deducted from a future payroll run
// ---------------------------------------------------------------------------
async function renderAdvances() {
  const [rows, employees] = await Promise.all([api('/advances'), api('/employees')]);
  CACHE.employees = employees; CACHE.advances = rows;
  document.getElementById('content').innerHTML = setHeaderBanner('advances', `<button class="btn btn-outline" onclick="openAdvanceForm()">${ic('plus')} Give Advance</button>`) + `
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Date</th><th>Employee</th><th>Amount</th><th>Reason</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${r.employee_name}</td><td>${inr(r.amount)}</td><td>${r.reason||''}</td>
        <td><span class="badge ${r.adjusted ? 'badge-green' : 'badge-amber'}">${r.adjusted ? 'Adjusted in Payroll' : 'Outstanding'}</span></td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          ${r.adjusted ? '' : `<button class="icon-btn" title="Edit" onclick="openAdvanceForm(${r.id})">${ic('edit')}</button>`}
          <button class="icon-btn" title="Print" onclick="printAdvance(${r.id})">${ic('print')}</button>
          <button class="icon-btn del" onclick="deleteAdvance(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No advances given yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function openAdvanceForm(id) {
  editingId = id || null;
  const employees = CACHE.employees || [];
  const row = id ? (CACHE.advances || []).find((r) => r.id === id) : { employee_id: employees[0]?.id, date: todayISO(), amount: 0 };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Give'} Salary Advance</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Employee</label><select id="fld_employee_id">${employees.map((e) => `<option value="${e.id}" ${e.id===row.employee_id?'selected':''}>${e.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_amount" value="${row.amount||0}"></div>
      <div class="form-field full"><label>Reason</label><input id="fld_reason" placeholder="e.g. Medical, Festival, Personal" value="${row.reason||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveAdvance(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveAdvance(id) {
  const data = { employee_id: Number(fld('employee_id')), date: fld('date'), amount: Number(fld('amount')), reason: fld('reason') };
  try {
    if (id) await api(`/advances/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/advances', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Advance updated' : 'Advance recorded'); renderAdvances();
  } catch (e) { showToast(e.message); }
}
async function deleteAdvance(id) { if (!confirm('Delete this advance?')) return; try { await api(`/advances/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderAdvances(); } catch (e) { showToast(e.message); } }
function printAdvance(id) {
  const r = (CACHE.advances || []).find((x) => x.id === id); if (!r) return;
  printGenericReport('Salary Advance Voucher', ['Date','Employee','Amount','Reason','Status'],
    [[fmtDate(r.date), r.employee_name, inr(r.amount), r.reason||'', r.adjusted?'Adjusted in Payroll':'Outstanding']]);
}

// ---------------------------------------------------------------------------
// Payroll — auto gross/net, optional advance deduction
// ---------------------------------------------------------------------------
async function renderPayroll() {
  const [rows, employees, advances] = await Promise.all([api('/payroll'), api('/employees'), api('/advances')]);
  CACHE.employees = employees; CACHE.advances = advances; CACHE.payroll = rows;
  document.getElementById('content').innerHTML = setHeaderBanner('payroll', `<button class="btn btn-outline" onclick="openPayrollForm()">${ic('plus')} Process Salary</button>`) + `
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Payroll No</th><th>Employee</th><th>Month</th><th>Gross</th><th>Incentive</th><th>Net Salary</th><th>Paid</th><th>Balance</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td>${r.payroll_no}</td><td>${r.employee_name}</td><td>${r.pay_month}</td><td>${inr(r.gross)}</td><td style="color:var(--green);font-weight:600;">${inr(r.incentive_amount||0)}</td><td><b>${inr(r.net)}</b></td>
        <td style="color:var(--green);">${inr(r.paid_amount)}</td>
        <td style="font-weight:700; color:${r.balance>0?'var(--coral)':'var(--green)'};">${inr(r.balance)}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          ${r.balance > 0 ? `<button class="btn btn-sm btn-primary" onclick="openPayrollPayForm(${r.id})">Pay</button>` : `<span class="badge badge-green">Fully Paid</span>`}
          <button class="icon-btn" title="Print Payslip" onclick="printPayslip(${r.id})">${ic('print')}</button>
          <button class="icon-btn" title="Download Payslip PDF" onclick="downloadPayslipPdf(${r.id})">${ic('download')}</button>
          <button class="icon-btn" title="Send Payslip PDF via WhatsApp" style="color:#25D366;" onclick="sendPayslipWhatsApp(${r.id})">${ic('bell')}</button>
          <button class="icon-btn del" onclick="deletePayroll(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="9">No payroll processed yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
async function downloadPayslipPdf(id) {
  const row = (CACHE.payroll || []).find((r) => r.id === id);
  try { await downloadPdfBlob(`/payslips/${id}/pdf`, `${row?.payroll_no || 'payslip'}.pdf`); }
  catch (e) { showToast('Could not generate PDF'); }
}
// Sends the payslip over WhatsApp with the PDF attached: since wa.me links
// can't attach files (a browser/OS restriction), the PDF is downloaded first
// so it's ready to attach, then the employee's WhatsApp chat opens
// pre-filled with a message about the payslip.
async function sendPayslipWhatsApp(id) {
  const row = (CACHE.payroll || []).find((r) => r.id === id);
  if (!row) return;
  if (!row.employee_phone) { showToast('No phone number on file for this employee'); return; }
  try {
    const result = await api(`/whatsapp/send-payslip/${id}`, { method: 'POST' });
    showToast(result.message || 'Payslip PDF sent on WhatsApp');
    try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel: 'WhatsApp', target_type: 'employee', target_id: row.employee_id, target_name: row.employee_name, message: `Payslip ${row.payroll_no} sent with PDF attachment`, status: 'Sent', ref_type: 'PAYSLIP', ref_id: row.id }) }); } catch (e) {}
  } catch (e) { showToast(e.message || 'Could not send payslip PDF on WhatsApp'); }
}
async function openPayrollPayForm(id) {
  const row = (CACHE.payroll || []).find((r) => r.id === id);
  const history = await api(`/payroll/${id}/payments`);
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Pay Salary — ${row.employee_name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field full"><label>Balance Due</label><input value="${inr(row.balance)}" disabled></div>
      <div class="form-field"><label>Payment Date</label><input type="date" id="fld_pay_date" value="${todayISO()}"></div>
      <div class="form-field"><label>Amount to Pay (₹)</label><input type="number" id="fld_pay_amount" value="${Math.max(row.balance,0)}"></div>
      <div class="form-field"><label>Mode</label><select id="fld_pay_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option>${m}</option>`).join('')}</select></div>
    </div>
    <p style="font-size:11.5px; color:var(--muted); margin-top:4px;">Paying more than the balance due automatically records the extra as a Salary Advance, ready to be deducted from next month's payroll.</p>
    ${history.length ? `<div style="margin-top:14px;"><label style="font-size:12px; font-weight:600; color:var(--muted);">Payment History</label>
      <table style="width:100%; font-size:12.5px; margin-top:4px;"><thead><tr><th style="text-align:left;">Date</th><th style="text-align:left;">Mode</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${history.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${h.mode}</td><td style="text-align:right;">${inr(h.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePayrollPayment(${id})">Record Payment</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function savePayrollPayment(id) {
  const amount = Number(fld('pay_amount')); const mode = fld('pay_mode'); const date = fld('pay_date');
  try { await api(`/payroll/${id}/pay`, { method: 'POST', body: JSON.stringify({ amount, mode, date }) }); closeModal(); showToast('Payment recorded'); renderPayroll(); } catch (e) { showToast(e.message); }
}
function printPayslip(id) {
  const row = (CACHE.payroll || []).find((r) => r.id === id);
  const co = COMPANY || {};
  document.getElementById('printArea').innerHTML = `
    <div class="inv-print-head">
      <div style="display:flex; gap:14px; align-items:center;">
        ${co.logo_data_url ? `<img src="${co.logo_data_url}" style="width:56px; height:56px; object-fit:cover; border-radius:8px;">` : ''}
        <div><h2>${co.company_name||'SABIHA ERP'}</h2><div class="muted">${co.address||''}</div></div>
      </div>
      <div style="text-align:right;"><h2>PAYSLIP</h2><div class="muted">${row.payroll_no} — ${row.pay_month}</div></div>
    </div>
    <div><b>Employee:</b> ${row.employee_name}</div>
    <table class="inv-print-table"><thead><tr><th>Component</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>
        <tr><td>Basic</td><td style="text-align:right;">${inr(row.basic)}</td></tr>
        <tr><td>HRA</td><td style="text-align:right;">${inr(row.hra)}</td></tr>
        <tr><td>Conveyance</td><td style="text-align:right;">${inr(row.conveyance)}</td></tr>
        <tr><td>Other Allowances</td><td style="text-align:right;">${inr(row.other_allow)}</td></tr><tr><td>Incentives / Rewards</td><td style="text-align:right;">${inr(row.incentive_amount||0)}</td></tr>
        <tr><td>PF Deduction</td><td style="text-align:right;">-${inr(row.pf)}</td></tr>
        <tr><td>ESI Deduction</td><td style="text-align:right;">-${inr(row.esi)}</td></tr>
        <tr><td>Advance Deduction</td><td style="text-align:right;">-${inr(row.advance_deduction)}</td></tr>
        <tr><td>Other Deduction</td><td style="text-align:right;">-${inr(row.other_deduction)}</td></tr>
      </tbody></table>
    <div class="inv-print-totals">
      <div class="grand"><span>Net Salary</span><span>${inr(row.net)}</span></div>
      <div><span>Paid</span><span>${inr(row.paid_amount)}</span></div>
      <div style="font-weight:700;"><span>Balance</span><span>${inr(row.net - row.paid_amount)}</span></div>
    </div>`;
  window.print();
}
function openPayrollForm() {
  const employees = CACHE.employees || [];
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Process Salary</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Employee</label><select id="fld_employee_id" onchange="onPayrollEmployeeChange()">${employees.map((e) => `<option value="${e.id}" data-salary-type="${e.salary_type||'Monthly'}">${e.name}${e.salary_type==='On Production'?' (On Production)':''}</option>`).join('')}</select></div>
      <div class="form-field"><label>Pay Month</label><input type="month" id="fld_pay_month" value="${todayISO().slice(0,7)}" onchange="onPayrollEmployeeChange()"></div>
      <div class="form-field"><label>Basic (₹)</label><input type="number" id="fld_basic" value="15000" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>HRA (₹)</label><input type="number" id="fld_hra" value="3000" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>Conveyance (₹)</label><input type="number" id="fld_conveyance" value="1000" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>Other Allowances (₹)</label><input type="number" id="fld_other_allow" value="0" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>PF (₹)</label><input type="number" id="fld_pf" value="1800" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>ESI (₹)</label><input type="number" id="fld_esi" value="500" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>Other Deduction (₹)</label><input type="number" id="fld_other_deduction" value="0" oninput="paintPayrollTotals()"></div>
      <div class="form-field"><label>Adjust Outstanding Advance</label><select id="fld_advance_id" onchange="paintPayrollTotals()"></select></div>
    </div>
    <div id="pieceRateHint"></div>
    <div class="totals-box" id="payrollTotals"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePayroll()">Save Payroll</button></div>`;
  onPayrollEmployeeChange();
  document.getElementById('modalBg').classList.add('show');
}
async function onPayrollEmployeeChange() {
  const empId = Number(fld('employee_id'));
  const open = (CACHE.advances || []).filter((a) => a.employee_id === empId && !a.adjusted);
  document.getElementById('fld_advance_id').innerHTML = `<option value="">None</option>` + open.map((a) => `<option value="${a.id}" data-amt="${a.amount}">${fmtDate(a.date)} — ${inr(a.amount)} (${a.reason||'Advance'})</option>`).join('');
  const empOption = document.querySelector(`#fld_employee_id option[value="${empId}"]`);
  const hintEl = document.getElementById('pieceRateHint');
  if (empOption?.dataset.salaryType === 'On Production') {
    const month = fld('pay_month');
    try {
      const out = await api(`/reports/production-output/${empId}?month=${month}`);
      hintEl.innerHTML = `<div class="template-box" style="margin-top:2px;">This employee is paid <b>On Production</b>. In ${month}, they produced <b>${out.output} units</b> at ${inr(out.pieceRate)}/unit = <b>${inr(out.suggestedBasic)}</b>. <button type="button" class="btn btn-outline btn-sm" style="margin-left:6px;" onclick="document.getElementById('fld_basic').value=${out.suggestedBasic}; paintPayrollTotals();">Use this as Basic</button></div>`;
    } catch (e) { hintEl.innerHTML = ''; }
  } else {
    hintEl.innerHTML = '';
  }
  paintPayrollTotals();
}
function paintPayrollTotals() {
  const basic = Number(fld('basic'))||0, hra = Number(fld('hra'))||0, conv = Number(fld('conveyance'))||0, other = Number(fld('other_allow'))||0;
  const pf = Number(fld('pf'))||0, esi = Number(fld('esi'))||0, otherDed = Number(fld('other_deduction'))||0;
  const advSel = document.getElementById('fld_advance_id'); const advAmt = advSel && advSel.selectedOptions[0] ? Number(advSel.selectedOptions[0].dataset.amt || 0) : 0;
  const gross = basic + hra + conv + other;
  const net = gross - pf - esi - otherDed - advAmt;
  document.getElementById('payrollTotals').innerHTML = `<div><span>Base Gross</span><span>${inr(gross)}</span></div><div><span>Pending Incentives / Rewards</span><span id="pendingIncentivePreview">Checking…</span></div><div><span>Total Deductions</span><span>${inr(pf+esi+otherDed+advAmt)}</span></div><div class="grand"><span>Net Salary before incentives</span><span>${inr(net)}</span></div>`;
  loadPayrollIncentivePreview();
}
async function loadPayrollIncentivePreview() {
  const empId = Number(document.getElementById('fld_employee_id')?.value);
  const month = document.getElementById('fld_pay_month')?.value;
  const el = document.getElementById('pendingIncentivePreview');
  if (!el || !empId || !month) return;
  try {
    const rows = await api(`/employee-incentives?employee_id=${empId}`);
    const amount = rows.filter(r=>r.period===month && r.status==='Pending').reduce((s,r)=>s+Number(r.reward_amount||0),0);
    el.textContent = inr(amount);
  } catch(e) { el.textContent = '—'; }
}
async function savePayroll() {
  const advSel = document.getElementById('fld_advance_id');
  const data = {
    employee_id: Number(fld('employee_id')), pay_month: fld('pay_month'), basic: Number(fld('basic')), hra: Number(fld('hra')),
    conveyance: Number(fld('conveyance')), other_allow: Number(fld('other_allow')), pf: Number(fld('pf')), esi: Number(fld('esi')),
    other_deduction: Number(fld('other_deduction')), advance_id: advSel.value ? Number(advSel.value) : null,
    advance_deduction: advSel.value ? Number(advSel.selectedOptions[0].dataset.amt || 0) : 0,
  };
  try { await api('/payroll', { method: 'POST', body: JSON.stringify(data) }); closeModal(); showToast('Payroll processed'); renderPayroll(); } catch (e) { showToast(e.message); }
}
async function deletePayroll(id) { if (!confirm('Delete this payroll record?')) return; try { await api(`/payroll/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderPayroll(); } catch (e) { showToast(e.message); } }

// ---------------------------------------------------------------------------
// Outsourcing — Persons / Jobs / Payments tabs
// ---------------------------------------------------------------------------
let outsourcingTab = 'jobs';
async function renderOutsourcing() {
  const [persons, jobs, payments, products] = await Promise.all([api('/outsourcing/persons-summary'), api('/outsourcing/jobs'), api('/outsourcing/payments'), api('/products')]);
  CACHE.outPersons = persons; CACHE.outJobs = jobs; CACHE.outPayments = payments; CACHE.products = products;
  document.getElementById('content').innerHTML = setHeaderBanner('outsourcing') + `
    <div class="tabs">
      <div class="tab ${outsourcingTab==='persons'?'active':''}" onclick="switchOutsourcingTab('persons')">Persons</div>
      <div class="tab ${outsourcingTab==='jobs'?'active':''}" onclick="switchOutsourcingTab('jobs')">Jobs</div>
      <div class="tab ${outsourcingTab==='payments'?'active':''}" onclick="switchOutsourcingTab('payments')">Payments</div>
    </div>
    <div id="outsourcingBody"></div>`;
  paintOutsourcingTab();
}
function switchOutsourcingTab(t) { outsourcingTab = t; renderOutsourcing(); }
async function reloadPersonsSummary() {
  const from = document.getElementById('outPersonsFrom')?.value; const to = document.getElementById('outPersonsTo')?.value;
  const q = (from || to) ? `?${from ? 'from=' + from : ''}${from && to ? '&' : ''}${to ? 'to=' + to : ''}` : '';
  CACHE.outPersons = await api('/outsourcing/persons-summary' + q);
  paintPersonsTable();
}
function paintPersonsTable() {
  const persons = (CACHE.outPersons || []).filter((p) => !outPersonsSearch || p.name.toLowerCase().includes(outPersonsSearch));
  document.getElementById('outPersonsWrap').innerHTML = `
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Stage</th><th>Default Rate (₹/pc)</th><th>Qty Done (period)</th><th>Amount Done (period)</th><th>Amount Paid (all-time)</th><th>Balance Due (all-time)</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${persons.length ? persons.map((p) => `<tr><td><b style="cursor:pointer; text-decoration:underline dotted; color:var(--blue);" onclick="openPersonDetail(${p.id})">${p.name}</b></td><td>${p.phone||''}</td><td><span class="badge badge-blue">${p.stage}</span></td><td>${inr(p.default_rate)}</td><td>${p.qtyDone}</td><td>${inr(p.amountDone)}</td><td>${inr(p.paid)}</td>
          <td>${p.balance > 0 ? `<b style="color:#E15A5A;">${inr(p.balance)}</b>` : `<span style="color:#28A97A;">${inr(p.balance)}</span>`}</td>
          <td><div class="row-actions" style="justify-content:flex-end;">
            <button class="icon-btn" title="Edit" onclick="openPersonForm(${p.id})">${ic('edit')}</button>
            <button class="icon-btn del" onclick="deletePerson(${p.id})">${ic('trash')}</button>
          </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="9">No jobworkers match.</td></tr>'}</tbody>
      </table></div></div>`;
}
let outPersonsSearch = '';
async function openPersonDetail(id) {
  const d = await api(`/outsourcing/persons/${id}/detail`);
  const p = d.person; const t = d.totals;
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:760px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${p.name} <span class="badge badge-blue" style="margin-left:6px;">${p.stage}</span></h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${t.totalQty}</div><div class="l">Total Qty Done (all-time)</div></div>
        <div class="kpi"><div class="n">${inr(t.totalAmount)}</div><div class="l">Total Amount of Jobs</div></div>
        <div class="kpi"><div class="n">${inr(t.totalPaid)}</div><div class="l">Total Paid</div></div>
        <div class="kpi"><div class="n" style="color:${t.balance>0?'var(--coral)':'var(--green)'}">${inr(t.balance)}</div><div class="l">Balance Due</div></div>
      </div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Jobs</label>
      <table style="margin-bottom:14px;"><thead><tr><th>Date</th><th>Job No</th><th>Product</th><th>Stage</th><th>Sent</th><th>Received</th><th>Rate</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${d.jobs.length ? d.jobs.map((j) => `<tr><td>${fmtDate(j.date)}</td><td>${j.job_no}</td><td>${j.product_name||'—'}</td><td>${j.stage}</td><td>${j.qty_sent}</td><td>${j.qty_received}</td><td>${inr(j.rate)}</td><td>${inr(j.amount)}</td><td><span class="badge ${j.status==='Completed'?'badge-green':'badge-amber'}">${j.status}</span></td></tr>`).join('') : '<tr class="empty-row"><td colspan="9">No jobs yet.</td></tr>'}</tbody></table>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Payments</label>
      <table><thead><tr><th>Date</th><th>Amount</th><th>Mode</th><th>Reference</th></tr></thead>
        <tbody>${d.payments.length ? d.payments.map((pay) => `<tr><td>${fmtDate(pay.date)}</td><td>${inr(pay.amount)}</td><td>${pay.mode}</td><td>${pay.reference_no||''}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">No payments yet.</td></tr>'}</tbody></table>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function paintOutsourcingTab() {
  const host = document.getElementById('outsourcingBody');
  if (outsourcingTab === 'persons') {
    host.innerHTML = `<div class="tbl-toolbar">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input type="text" placeholder="Search jobworkers..." oninput="outPersonsSearch=this.value.toLowerCase(); paintPersonsTable();" style="min-width:180px;">
          <label style="font-size:12px; color:var(--muted);">From <input type="date" id="outPersonsFrom" onchange="reloadPersonsSummary()" style="margin-left:4px;"></label>
          <label style="font-size:12px; color:var(--muted);">To <input type="date" id="outPersonsTo" value="${todayISO()}" onchange="reloadPersonsSummary()" style="margin-left:4px;"></label>
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('outPersonsFrom').value=''; document.getElementById('outPersonsTo').value='${todayISO()}'; reloadPersonsSummary();">Clear</button>
        </div>
        <button class="btn btn-outline" onclick="openPersonForm()">${ic('plus')} Add Jobworker</button></div>
      <div id="outPersonsWrap"></div>`;
    paintPersonsTable();
  } else if (outsourcingTab === 'jobs') {
    const jobs = CACHE.outJobs || [];
    host.innerHTML = `<div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="openJobForm()">${ic('plus')} New Job</button></div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
        <thead><tr><th>Job No</th><th>Date</th><th>Jobworker</th><th>Stage</th><th>Product</th><th>Sent</th><th>Received</th><th>Amount</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${jobs.length ? jobs.map((j) => `<tr><td>${j.job_no}</td><td>${fmtDate(j.date)}</td><td>${j.person_name}</td><td><span class="badge badge-violet">${j.stage}</span></td><td>${j.product_name||'—'}</td><td>${j.qty_sent}</td><td>${j.qty_received}</td><td>${inr(j.amount)}</td>
          <td><span class="badge ${j.status==='Completed'?'badge-green':'badge-amber'}">${j.status}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;">
            <button class="icon-btn" title="Edit" onclick="openJobForm(${j.id})">${ic('edit')}</button>
            <button class="icon-btn" title="Print Job Card" onclick="printJob(${j.id})">${ic('print')}</button>
            <button class="icon-btn del" onclick="deleteJob(${j.id})">${ic('trash')}</button>
          </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="10">No jobwork entries yet.</td></tr>'}</tbody>
      </table></div></div>`;
  } else {
    const payments = CACHE.outPayments || [];
    host.innerHTML = `<div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="openOutPaymentForm()">${ic('plus')} Add Payment</button></div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
        <thead><tr><th>Date</th><th>Jobworker</th><th>Amount</th><th>Mode</th><th>Reference</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${payments.length ? payments.map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${p.person_name}</td><td>${inr(p.amount)}</td><td>${p.mode}</td><td>${p.reference_no||''}</td>
          <td><div class="row-actions" style="justify-content:flex-end;">
            <button class="icon-btn" title="Edit" onclick="openOutPaymentForm(${p.id})">${ic('edit')}</button>
            <button class="icon-btn" title="Print" onclick="printOutPayment(${p.id})">${ic('print')}</button>
            <button class="icon-btn del" onclick="deleteOutPayment(${p.id})">${ic('trash')}</button>
          </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No payments recorded yet.</td></tr>'}</tbody>
      </table></div></div>`;
  }
}
function openPersonForm(id) {
  editingId = id || null;
  const row = id ? (CACHE.outPersons || []).find((p) => p.id === id) : {};
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id?'Edit':'Add'} Jobworker</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Name</label><input id="fld_name" value="${row.name||''}"></div>
      <div class="form-field"><label>Phone</label><input id="fld_phone" value="${row.phone||''}"></div>
      <div class="form-field"><label>Email</label><input id="fld_email" value="${row.email||''}"></div>
      <div class="form-field"><label>Default Stage</label><select id="fld_stage">${STAGES.map((s) => `<option ${s===row.stage?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Default Rate (₹/pc)</label><input type="number" id="fld_default_rate" value="${row.default_rate||0}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePerson(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function savePerson(id) {
  const data = { name: fld('name'), phone: fld('phone'), email: fld('email'), stage: fld('stage'), default_rate: Number(fld('default_rate')) };
  try {
    if (id) await api(`/outsourcing/persons/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/outsourcing/persons', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Jobworker updated' : 'Jobworker added'); renderOutsourcing();
  } catch (e) { showToast(e.message); }
}
async function deletePerson(id) { if (!confirm('Delete this jobworker?')) return; try { await api(`/outsourcing/persons/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderOutsourcing(); } catch (e) { showToast(e.message); } }
function printJob(id) {
  const j = (CACHE.outJobs || []).find((x) => x.id === id); if (!j) return;
  printGenericReport('Job Card — ' + j.job_no, ['Date','Jobworker','Stage','Product','Qty Sent','Qty Received','Rate','Amount','Status'],
    [[fmtDate(j.date), j.person_name, j.stage, j.product_name||'—', j.qty_sent, j.qty_received, inr(j.rate), inr(j.amount), j.status]], j.remarks||'');
}
function openJobForm(id) {
  editingId = id || null;
  const persons = CACHE.outPersons || []; const products = CACHE.products || [];
  const row = id ? (CACHE.outJobs || []).find((j) => j.id === id) : { date: todayISO(), stage: 'Molding', status: 'Pending' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id?'Edit':'New'} Jobwork Entry</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Jobworker</label><select id="fld_person_id" onchange="onJobPersonChange()">${persons.map((p) => `<option value="${p.id}" ${p.id===row.person_id?'selected':''}>${p.name} (default ${inr(p.default_rate)}/pc)</option>`).join('')}</select></div>
      <div class="form-field"><label>Stage</label><select id="fld_stage" onchange="onJobStageChange()">${STAGES.map((s) => `<option ${s===row.stage?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Product</label><select id="fld_product_id">${products.map((p) => `<option value="${p.id}" ${p.id===row.product_id?'selected':''}>${p.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Qty Sent</label><input type="number" id="fld_qty_sent" value="${row.qty_sent||0}"></div>
      <div class="form-field"><label>Qty Received</label><input type="number" id="fld_qty_received" value="${row.qty_received||0}"></div>
      <div class="form-field"><label>Rate per Pc (₹)</label><input type="number" id="fld_rate" value="${row.rate ?? (id ? 0 : ((persons[0]?.default_rate > 0) ? persons[0].default_rate : stageDefaultRate(row.stage)))}"></div>
      <div class="form-field"><label>Status</label><select id="fld_status">${['Pending','In Progress','Completed'].map((s) => `<option ${s===row.status?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveJob(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function stageDefaultRate(stageName) {
  const s = (CACHE.pipelineStages || []).find((x) => x.name === stageName);
  return s ? s.default_rate : 0;
}
function onJobStageChange() {
  if (editingId) return; // don't overwrite a rate the user already set while editing
  const person = (CACHE.outPersons || []).find((p) => p.id === Number(fld('person_id')));
  document.getElementById('fld_rate').value = (person && person.default_rate > 0) ? person.default_rate : stageDefaultRate(fld('stage'));
}
function onJobPersonChange() {
  if (editingId) return; // don't overwrite a rate the user already set while editing
  const person = (CACHE.outPersons || []).find((p) => p.id === Number(fld('person_id')));
  document.getElementById('fld_rate').value = (person && person.default_rate > 0) ? person.default_rate : stageDefaultRate(fld('stage'));
  // Jobworkers are usually tied to one stage — switch the stage to match theirs, if set.
  if (person?.stage) { const stageSel = document.getElementById('fld_stage'); if (stageSel) stageSel.value = person.stage; }
}
async function saveJob(id) {
  const data = { date: fld('date'), person_id: Number(fld('person_id')), stage: fld('stage'), product_id: Number(fld('product_id')), qty_sent: Number(fld('qty_sent')), qty_received: Number(fld('qty_received')), rate: Number(fld('rate')), status: fld('status'), remarks: fld('remarks') };
  try {
    let saved;
    if (id) saved = await api(`/outsourcing/jobs/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/outsourcing/jobs', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast('Job saved'); renderOutsourcing();
    if (saved.stageCompleted) showStageCompletedPopup(saved.productId, saved.productName, saved.shiftedQty);
  } catch (e) { alert(e.message); }
}
async function deleteJob(id) { if (!confirm('Delete this job entry?')) return; try { await api(`/outsourcing/jobs/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderOutsourcing(); } catch (e) { showToast(e.message); } }
function openOutPaymentForm(id) {
  editingId = id || null;
  const persons = CACHE.outPersons || [];
  const row = id ? (CACHE.outPayments || []).find((p) => p.id === id) : { date: todayISO(), person_id: persons[0]?.id, amount: 0, mode: 'Cash' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id?'Edit':'Add'} Jobwork Payment</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Jobworker</label><select id="fld_person_id" onchange="onOutPaymentPersonChange()">${persons.map((p) => `<option value="${p.id}" ${p.id===row.person_id?'selected':''}>${p.name}${p.balance > 0 ? ' — Balance ' + inr(p.balance) : ''}</option>`).join('')}</select></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_amount" value="${row.amount||0}"></div>
      <div class="form-field"><label>Mode</label><select id="fld_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option ${m===row.mode?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Reference No</label><input id="fld_reference_no" value="${row.reference_no||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveOutPayment(${id||'null'})">Save</button></div>`;
  if (!id) onOutPaymentPersonChange();
  document.getElementById('modalBg').classList.add('show');
}
function onOutPaymentPersonChange() {
  const pid = Number(fld('person_id'));
  const p = (CACHE.outPersons || []).find((x) => x.id === pid);
  if (p) document.getElementById('fld_amount').value = Math.max(p.balance, 0);
}
async function saveOutPayment(id) {
  const data = { date: fld('date'), person_id: Number(fld('person_id')), amount: Number(fld('amount')), mode: fld('mode'), reference_no: fld('reference_no') };
  try {
    if (id) await api(`/outsourcing/payments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/outsourcing/payments', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Payment updated' : 'Payment recorded'); renderOutsourcing();
  } catch (e) { showToast(e.message); }
}
async function deleteOutPayment(id) { if (!confirm('Delete this payment?')) return; try { await api(`/outsourcing/payments/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderOutsourcing(); } catch (e) { showToast(e.message); } }
function printOutPayment(id) {
  const p = (CACHE.outPayments || []).find((x) => x.id === id); if (!p) return;
  printGenericReport('Jobwork Payment Voucher', ['Date','Jobworker','Amount','Mode','Reference No'],
    [[fmtDate(p.date), p.person_name, inr(p.amount), p.mode, p.reference_no||'']]);
}

// ---------------------------------------------------------------------------
// Sales / Invoices — multi-item billing, GST (IGST/CGST+SGST), paid-now,
// edit, printable invoice with logo, WhatsApp/Email send
// ---------------------------------------------------------------------------
let invoiceDraftItems = [];
let editingInvoiceId = null;
let invoicePrevBalance = 0;
let invoiceLoyaltyPreview = null;
async function renderSales() {
  searchQuery = '';
  const [rows, customers, products] = await Promise.all([api('/sales'), api('/customers'), api('/products')]);
  CACHE.sales = rows; CACHE.customers = customers; CACHE.products = products;
  const performance = await api('/reports/salesperson-performance');
  CACHE.salespersonPerformance = performance;
  document.getElementById('content').innerHTML = setHeaderBanner('sales', `<button class="btn btn-outline" onclick="openBarcodeSale()">${ic('barcode')} Barcode Sale</button> <button class="btn btn-outline" onclick="openInvoiceForm()">${ic('plus')} New Sales Invoice</button>`) + `
    <div id="salesKpiWrap"></div>
    <div class="panel" style="margin-top:12px;"><h3>Salesperson Performance</h3><div class="tbl-scroll"><table>
      <thead><tr><th>Salesperson</th><th>Invoices</th><th>Total Sales</th><th>Target</th><th>Achieved</th><th>Target Balance</th></tr></thead>
      <tbody>${performance.length ? performance.map(r=>`<tr><td>${r.name}</td><td>${r.invoice_count}</td><td>${inr(r.total_sales)}</td><td>${r.sales_target>0?inr(r.sales_target):'—'}</td><td>${r.targetAchievedPct==null?'—':r.targetAchievedPct.toFixed(1)+'%'}</td><td>${r.sales_target>0?inr(r.targetBalance):'—'}</td></tr>`).join(''):'<tr class="empty-row"><td colspan="6">No linked salesperson records.</td></tr>'}</tbody>
    </table></div></div>
    <div class="tbl-toolbar"><input type="text" placeholder="Search invoices..." oninput="searchQuery=this.value.toLowerCase(); paintSalesTable();"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="salesTableWrap"></div></div>`;
  paintSalesTable();
  document.getElementById('salesKpiWrap').innerHTML = await salesPurchaseKpiHtml('sales');
}
// ---------------------------------------------------------------------------
// Barcode Sale — a fast, POS-style checkout: scan or type a barcode, it
// looks the product up and adds it to a running cart, repeat, then complete
// the sale as a normal invoice (reuses the same POST /sales the manual
// invoice form uses, so GST, stock deduction, and everything else behaves
// identically either way).
// ---------------------------------------------------------------------------
let barcodeCart = [];
async function openBarcodeSale() {
  const customers = CACHE.customers && CACHE.customers.length ? CACHE.customers : await api('/customers');
  CACHE.customers = customers;
  barcodeCart = [];
  document.getElementById('content').innerHTML = setHeaderBanner('sales', `<button class="btn btn-outline" onclick="renderSales()">${ic('back')} Back to Sales</button>`) + `
    <div class="panel">
      <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:14px;">
        <div class="form-field" style="min-width:220px;"><label>Customer</label><select id="bcCustomer" onchange="onBarcodeCustomerChange()">${customers.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="form-field" style="flex:1; min-width:280px;">
          <label>Scan or Type Barcode / SKU</label>
          <input id="bcInput" placeholder="Scan barcode here, or type it and press Enter" onkeydown="if(event.key==='Enter'||event.keyCode===13){event.preventDefault(); barcodeScanEnter();}">
        </div>
        <button class="btn btn-primary" style="height:38px;" onclick="barcodeScanEnter()">${ic('plus')} Add</button>
        <button class="btn btn-outline" style="height:38px;" onclick="openCameraScanner(addByScannedCode, {continuous:true})">📷 Scan with Camera</button>
        <div class="form-field" style="width:90px;"><label>Invoice Date</label><input type="date" id="bcInvoiceDate" value="${todayISO()}"></div>
        <div class="form-field" style="width:90px;"><label>Due Date</label><input type="date" id="bcDueDate" value="${todayISO()}"></div>
        <div class="form-field" style="width:150px;"><label>Tax Type</label><select id="bcGstType" onchange="paintBarcodeCart()">
          <option value="CGST_SGST">CGST + SGST</option><option value="IGST">IGST</option>
        </select></div>
        <div class="form-field" style="width:100px;"><label>GST %</label><input type="number" id="bcGstPct" value="18" onchange="paintBarcodeCart()"></div>
      </div>
      <div id="bcMsg" style="min-height:26px; font-size:12.5px; margin-bottom:8px; padding:4px 8px; border-radius:6px; transition:background .2s;"></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Product</th><th>Barcode/SKU</th><th>Qty</th><th>Rate</th><th>Disc %</th><th>Amount</th><th></th></tr></thead>
        <tbody id="bcCartBody"></tbody>
      </table></div>
      <div style="display:flex; justify-content:flex-end; gap:24px; align-items:flex-start; margin-top:14px; flex-wrap:wrap;">
        <div class="form-grid" style="flex:1; min-width:260px;">
          <div class="form-field"><label>Paid Now (₹)</label><input type="number" id="bcPaidNow" value="0" oninput="paintBarcodeCart()"></div>
          <div class="form-field"><label>Paid Via</label><select id="bcPaidMode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option>${m}</option>`).join('')}</select></div>
        </div>
        <div class="totals-box" id="bcTotals" style="width:280px;"></div>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
        <button class="btn btn-outline" onclick="renderSales()">Cancel</button>
        <button class="btn btn-primary" onclick="completeBarcodeSale(false)">Complete Sale</button>
        <button class="btn btn-primary" style="background:var(--green);" onclick="completeBarcodeSale(true)">${ic('print')} Complete &amp; Print</button>
      </div>
    </div>`;
  paintBarcodeCart();
  setTimeout(() => document.getElementById('bcInput')?.focus(), 50);
}
async function onBarcodeCustomerChange() {
  const custId = Number(document.getElementById('bcCustomer')?.value || 0);
  try { invoiceLoyaltyPreview = custId ? await api(`/customer-loyalty/${custId}`) : null; } catch (e) { invoiceLoyaltyPreview = null; }
  paintBarcodeCart();
}
function flashBarcodeMsg(text, ok) {
  const msgEl = document.getElementById('bcMsg');
  msgEl.style.color = ok ? 'var(--green)' : 'var(--coral)';
  msgEl.style.background = ok ? 'rgba(40,169,122,.12)' : 'rgba(225,90,90,.12)';
  msgEl.style.fontWeight = ok ? '400' : '700';
  msgEl.textContent = text;
  if (!ok) showToast(text); // a scan miss is easy to miss in the small text alone — surface it as a toast too
  clearTimeout(window.__bcMsgTimer);
  window.__bcMsgTimer = setTimeout(() => { msgEl.style.background = 'transparent'; }, 2500);
}
async function barcodeScanEnter() {
  const input = document.getElementById('bcInput');
  const code = input.value.trim();
  input.value = '';
  if (!code) { input.focus(); return; }
  await addByScannedCode(code);
  input.focus();
}
// Shared by both scan paths — the hardware scanner (which types into
// #bcInput) and the phone-camera scanner below — so a code found either
// way is added to the cart identically.
async function addByScannedCode(code) {
  try {
    const p = await api(`/products/barcode/${encodeURIComponent(code)}`);
    const existing = barcodeCart.find((c) => c.product_id === p.id);
    if (existing) existing.qty += 1;
    else barcodeCart.push({ product_id: p.id, name: p.name, code: p.barcode || p.sku || code, unit: p.unit, rate: p.sale_rate, discount_pct: 0, qty: 1 });
    flashBarcodeMsg(`Added: ${p.name} (stock: ${p.stock} ${p.unit})`, true);
    paintBarcodeCart();
  } catch (e) {
    flashBarcodeMsg(e.message, false);
  }
}
function updateBarcodeCartQty(idx, qty) { barcodeCart[idx].qty = Math.max(1, Number(qty) || 1); paintBarcodeCart(); }
function updateBarcodeCartRate(idx, rate) { barcodeCart[idx].rate = Math.max(0, Number(rate) || 0); paintBarcodeCart(); }
function updateBarcodeCartDiscount(idx, pct) { barcodeCart[idx].discount_pct = Math.min(100, Math.max(0, Number(pct) || 0)); paintBarcodeCart(); }
function removeBarcodeCartLine(idx) { barcodeCart.splice(idx, 1); paintBarcodeCart(); }

// ---------------------------------------------------------------------------
// Camera barcode scanning — for salespeople on a phone with no hardware
// scanner. Uses html5-qrcode (vendored locally in public/vendor/, same
// pattern as JsBarcode — no CDN, works under this app's CSP and offline).
// Reads both 1D barcodes (EAN/Code128/UPC, what a product's own barcode
// usually is) and QR codes, in case a business's SKUs are QR-encoded.
// ---------------------------------------------------------------------------
let __cameraScanner = null;
function openCameraScanner(onCode, opts = {}) {
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:480px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>📷 Scan Barcode</h3><button class="modal-close" onclick="closeCameraScanner()">×</button></div>
    <div class="modal-body">
      <div id="cameraScanRegion" style="width:100%; min-height:280px; background:#000; border-radius:10px; overflow:hidden;"></div>
      <p id="cameraScanMsg" style="text-align:center; font-size:12.5px; color:var(--muted); margin-top:10px;">Point the camera at a barcode or QR code.</p>
      ${opts.continuous ? '<label style="display:flex; align-items:center; gap:6px; font-size:12.5px; justify-content:center;"><input type="checkbox" id="cameraScanContinuous" checked> Keep scanning after each item (for adding several in a row)</label>' : ''}
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeCameraScanner()">Cancel</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  if (typeof Html5Qrcode === 'undefined') {
    document.getElementById('cameraScanMsg').innerHTML = '<span style="color:var(--coral);">Camera scanning library failed to load. Try the barcode/SKU text field instead.</span>';
    return;
  }
  __cameraScanner = new Html5Qrcode('cameraScanRegion');
  const config = { fps: 10, qrbox: { width: 250, height: 150 } };
  __cameraScanner.start(
    { facingMode: 'environment' }, // rear camera — the one actually useful for scanning something in front of you
    config,
    async (decodedText) => {
      const msgEl = document.getElementById('cameraScanMsg');
      if (msgEl) { msgEl.textContent = `Scanned: ${decodedText}`; msgEl.style.color = 'var(--green)'; }
      const keepGoing = opts.continuous && document.getElementById('cameraScanContinuous')?.checked;
      if (!keepGoing) { await closeCameraScanner(); }
      await onCode(decodedText);
    },
    () => { /* fires continuously while no code is in frame — not an error, so intentionally silent */ }
  ).catch((err) => {
    const msgEl = document.getElementById('cameraScanMsg');
    if (msgEl) {
      msgEl.style.color = 'var(--coral)';
      msgEl.textContent = /permission|NotAllowed/i.test(String(err))
        ? 'Camera access was denied. Allow camera access for this site in your browser/phone settings, then try again.'
        : 'Could not start the camera — your device may not have one, or it\'s in use by another app.';
    }
  });
}
// Always stop the camera stream on close — leaving it running is both a
// battery drain and a privacy concern on someone's personal phone.
async function closeCameraScanner() {
  if (__cameraScanner) {
    try { await __cameraScanner.stop(); __cameraScanner.clear(); } catch (e) { /* already stopped */ }
    __cameraScanner = null;
  }
  closeModal();
}
function paintBarcodeCart() {
  document.getElementById('bcCartBody').innerHTML = barcodeCart.length ? barcodeCart.map((c, i) => `
    <tr><td>${c.name}</td><td>${c.code}</td>
      <td><input type="number" value="${c.qty}" min="1" style="width:65px;" onchange="updateBarcodeCartQty(${i}, this.value)"></td>
      <td><input type="number" value="${c.rate}" min="0" style="width:80px;" onchange="updateBarcodeCartRate(${i}, this.value)"></td>
      <td><input type="number" value="${c.discount_pct}" min="0" max="100" style="width:65px;" onchange="updateBarcodeCartDiscount(${i}, this.value)"></td>
      <td>${inr(c.qty * c.rate * (1 - (c.discount_pct||0)/100))}</td>
      <td><button class="icon-btn del" onclick="removeBarcodeCartLine(${i})">${ic('trash')}</button></td>
    </tr>`).join('') : '<tr class="empty-row"><td colspan="7">Scan a barcode, or type it above and click Add.</td></tr>';
  const sub = barcodeCart.reduce((s, c) => s + c.qty * c.rate * (1 - (c.discount_pct||0)/100), 0);
  const gstPct = Number(document.getElementById('bcGstPct')?.value || 18);
  const gstType = document.getElementById('bcGstType')?.value || 'CGST_SGST';
  const loyaltyDiscount = invoiceLoyaltyPreview?.eligible ? (invoiceLoyaltyPreview.reward_type==='FIXED' ? Math.min(Number(invoiceLoyaltyPreview.reward_value||0), sub) : Math.min(sub, sub*Number(invoiceLoyaltyPreview.reward_value||0)/100)) : 0;
  const taxableAfterLoyalty = Math.max(0, sub - loyaltyDiscount);
  const gstAmt = taxableAfterLoyalty * gstPct / 100;
  const grand = taxableAfterLoyalty + gstAmt;
  const paidNow = Number(document.getElementById('bcPaidNow')?.value || 0);
  const gstLines = gstType === 'IGST'
    ? `<div><span>IGST (${gstPct}%)</span><span>${inr(gstAmt)}</span></div>`
    : `<div><span>CGST (${(gstPct/2).toFixed(2)}%)</span><span>${inr(gstAmt/2)}</span></div><div><span>SGST (${(gstPct/2).toFixed(2)}%)</span><span>${inr(gstAmt/2)}</span></div>`;
  document.getElementById('bcTotals').innerHTML = `
    <div><span>Sub Total</span><span>${inr(sub)}</span></div>
    ${loyaltyDiscount>0?`<div style="color:var(--green);font-weight:700;"><span>Incentive / Loyalty Amount</span><span>- ${inr(loyaltyDiscount)}</span></div>`:''}
    <div><span>Taxable Amount</span><span>${inr(taxableAfterLoyalty)}</span></div>${gstLines}
    <div class="grand"><span>Grand Total</span><span>${inr(grand)}</span></div>
    <div style="color:var(--green);"><span>Paid Now</span><span>${inr(paidNow)}</span></div>
    <div style="font-weight:700;"><span>Balance</span><span>${inr(Math.max(0, grand - paidNow))}</span></div>`;
}
async function completeBarcodeSale(andPrint) {
  if (!barcodeCart.length) { flashBarcodeMsg('Cart is empty — scan a barcode first, or type the code and click Add', false); document.getElementById('bcInput')?.focus(); return; }
  const data = {
    customer_id: Number(document.getElementById('bcCustomer').value),
    invoice_date: document.getElementById('bcInvoiceDate').value || todayISO(), due_date: document.getElementById('bcDueDate').value || todayISO(),
    gst_pct: Number(document.getElementById('bcGstPct').value) || 18, gst_type: document.getElementById('bcGstType').value || 'CGST_SGST',
    items: barcodeCart.map((c) => ({ product_id: c.product_id, qty: c.qty, rate: c.rate, discount_pct: c.discount_pct || 0 })),
    paid_now: Number(document.getElementById('bcPaidNow').value) || 0, paid_mode: document.getElementById('bcPaidMode').value,
  };
  try {
    const saved = await api('/sales', { method: 'POST', body: JSON.stringify(data) });
    const rewards = saved.unlockedIncentives || [];
    if (rewards.length) pendingSavePopup = false;
    triggerSavedPopupIfPending(); 
    if (rewards.length) showUnlockedIncentives(rewards); // this is a full-page flow, not a modal, so the usual closeModal() never runs to consume this
    showToast('Sale completed — stock updated');
    const productIds = data.items.map((it) => it.product_id);
    barcodeCart = [];
    if (andPrint) printInvoice(saved.id);
    await renderSales();
    await checkLowStockAfterSale(productIds);
  } catch (e) { showErrorPopup('Sale Failed', e.message); }
}
function paintSalesTable() {
  const rows = (CACHE.sales || []).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  document.getElementById('salesTableWrap').innerHTML = `
    <table><thead><tr><th>Invoice No</th><th>Date</th><th>Customer</th><th>Salesperson</th><th>Due Date</th><th>Tax Type</th><th>Total</th><th>Received</th><th>Balance</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody>${rows.length ? rows.map((inv) => {
      const badge = inv.status==='Paid'?'badge-green':(inv.status==='Partial'?'badge-amber':(inv.status==='Returned'?'badge-violet':'badge-red'));
      return `<tr><td><b>${inv.invoice_no}</b></td><td>${fmtDate(inv.invoice_date)}</td><td>${inv.customer_name}</td><td>${fmtDate(inv.due_date)}</td>
        <td><span class="badge badge-blue">${inv.gst_type==='IGST'?'IGST':'CGST+SGST'}</span></td>
        <td>${inr(inv.grand_total)}${inv.returned > 0 ? `<br><small style="color:#B3261E;">− ${inr(inv.returned)} returned</small>` : ''}</td><td>${inr(inv.received)}</td><td>${inr(inv.balance)}</td><td><span class="badge ${badge}">${inv.status}</span></td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openInvoiceForm(${inv.id})">${ic('edit')}</button>
          <button class="icon-btn" title="Customer return against this invoice" onclick="openSalesReturnFor(${inv.id})" style="color:#E15A5A;">${ic('back')}</button>
          <button class="icon-btn" title="Print" onclick="printInvoice(${inv.id})">${ic('print')}</button>
          <button class="icon-btn" title="Download PDF" onclick="downloadInvoicePdf(${inv.id},'${inv.invoice_no}')">${ic('download')}</button>
          <button class="icon-btn" title="Send Invoice PDF via WhatsApp" onclick="sendInvoice(${inv.id},'WhatsApp')" style="color:#25D366;">${ic('bell')}</button>
          <button class="icon-btn" title="Email" onclick="sendInvoice(${inv.id},'Email')" style="color:var(--blue);">${ic('mail')}</button>
          <button class="icon-btn del" onclick="deleteInvoice(${inv.id})">${ic('trash')}</button>
        </div></td></tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="10">No invoices yet — click "New Sales Invoice" to create one.</td></tr>'}</tbody></table>`;
}
async function openInvoiceForm(id) {
  editingInvoiceId = id || null;
  const customers = CACHE.customers || []; const products = CACHE.products || [];
  let header = { customer_id: customers[0]?.id, invoice_date: todayISO(), due_date: todayISO(), gst_pct: 18, gst_type: 'CGST_SGST', paid_now: 0, paid_mode: 'Cash' };
  if (id) {
    const inv = await api(`/sales/${id}`);
    header = { customer_id: inv.customer_id, invoice_date: inv.invoice_date, due_date: inv.due_date, gst_pct: inv.gst_pct, gst_type: inv.gst_type || 'CGST_SGST', paid_now: 0, paid_mode: 'Cash', received: inv.received, grand_total: inv.grand_total };
    invoiceDraftItems = inv.items.map((it) => ({ product_id: it.product_id, qty: it.qty, rate: it.rate, discount_pct: it.discount_pct }));
  } else {
    invoiceDraftItems = [{ product_id: products[0]?.id, qty: 1, rate: products[0]?.sale_rate || 0, discount_pct: 0 }];
  }
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:740px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'New'} Sales Invoice</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-field"><label>Customer</label><select id="fld_customer_id" onchange="onInvoiceCustomerChange()">${customers.map((c) => `<option value="${c.id}" ${c.id===header.customer_id?'selected':''}>${c.name}</option>`).join('')}</select></div>
        <div class="form-field"><label>Invoice Date</label><input type="date" id="fld_invoice_date" value="${header.invoice_date}"></div>
        <div class="form-field"><label>Due Date</label><input type="date" id="fld_due_date" value="${header.due_date}"></div>
        <div class="form-field"><label>Tax Type</label><select id="fld_gst_type" onchange="paintInvoiceTotals()">
          <option value="CGST_SGST" ${header.gst_type==='CGST_SGST'?'selected':''}>CGST + SGST (Intra-state)</option>
          <option value="IGST" ${header.gst_type==='IGST'?'selected':''}>IGST (Inter-state)</option>
        </select></div>
        <div class="form-field"><label>GST %</label><input type="number" id="fld_gst_pct" value="${header.gst_pct}" oninput="paintInvoiceTotals()"></div>
      </div>
      <div id="invPrevBalanceNote" style="font-size:12px; color:var(--muted); margin-top:2px;"></div>
      <label style="font-size:12px; font-weight:600; color:var(--muted); display:block; margin-top:6px;">Invoice Items</label>
      <div class="line-items"><table><thead><tr><th style="width:30%;">Product</th><th>Qty</th><th>Rate</th><th>Disc %</th><th>Amount</th><th></th></tr></thead><tbody id="lineItemsBody"></tbody></table></div>
      <div style="display:flex; justify-content:flex-end; margin-top:8px;">
        <button class="btn btn-outline btn-sm" id="addLineBtn" onclick="addInvoiceLine()">${ic('plus')} Add Line</button>
      </div>
      <div class="form-grid" style="margin-top:14px;">
        <div class="form-field"><label>Paid Now (₹)</label><input type="number" id="fld_paid_now" value="${header.paid_now}" oninput="paintInvoiceTotals()"></div>
        <div class="form-field"><label>Paid Via</label><select id="fld_paid_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option>${m}</option>`).join('')}</select></div>
      </div>
      ${id ? `<p style="font-size:12px; color:var(--muted); margin-top:2px;">Already received on this invoice: ${inr(header.received||0)}. "Paid Now" here records an additional payment.</p>` : ''}
      <div class="totals-box" id="invTotals" style="width:280px;"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveInvoice(false)">Save Invoice</button>
      <button class="btn btn-primary" style="background:var(--green);" onclick="saveInvoice(true)">${ic('print')} Save & Generate</button>
    </div>`;
  paintInvoiceLines();
  document.getElementById('modalBg').classList.add('show');
  onInvoiceCustomerChange();
}
// Fetches the customer's outstanding balance from all OTHER invoices (i.e.
// "previous balance due", excluding this invoice itself when editing) —
// shown while creating/editing an invoice and folded into the printed copy.
async function onInvoiceCustomerChange() {
  const custId = Number(fld('customer_id'));
  if (!custId) { invoicePrevBalance = 0; paintInvoiceTotals(); return; }
  try {
    const q = editingInvoiceId ? `?exclude_invoice_id=${editingInvoiceId}` : '';
    const data = await api(`/reports/customer-balance/${custId}${q}`);
    invoicePrevBalance = data.balance || 0;
  } catch (e) { invoicePrevBalance = 0; }
  const note = document.getElementById('invPrevBalanceNote');
  // Loyalty/incentive information is intentionally not shown in the
  // customer/invoice header area. If the customer is eligible, the reward
  // is silently calculated and displayed only once in the final invoice
  // totals as "Incentive / Loyalty Amount".
  try { invoiceLoyaltyPreview = await api(`/customer-loyalty/${custId}`); } catch (e) { invoiceLoyaltyPreview = null; }
  if (note) note.innerHTML = invoicePrevBalance > 0
    ? `Previous Balance Due (before this invoice): <b style="color:var(--coral);">${inr(invoicePrevBalance)}</b>`
    : (invoicePrevBalance < 0 ? `Customer has a credit balance of ${inr(-invoicePrevBalance)} from previous transactions.` : 'No previous balance due for this customer.');
  paintInvoiceTotals();
}
// Full rebuild — only used when a line is added, removed, or its product changes.
function paintInvoiceLines(focusLastProduct) {
  const products = CACHE.products || [];
  document.getElementById('lineItemsBody').innerHTML = invoiceDraftItems.map((it, i) => `
    <tr>
      <td><select id="invProd_${i}" onchange="updateInvLine(${i},'product_id',this.value)">${products.map((p) => `<option value="${p.id}" ${p.id===it.product_id?'selected':''}>${p.name}</option>`).join('')}</select></td>
      <td><input type="number" id="invQty_${i}" value="${it.qty}" oninput="updateInvLineNumber(${i},'qty',this.value)"></td>
      <td><input type="number" id="invRate_${i}" value="${it.rate}" oninput="updateInvLineNumber(${i},'rate',this.value)"></td>
      <td><input type="number" id="invDisc_${i}" value="${it.discount_pct}" oninput="updateInvLineNumber(${i},'discount_pct',this.value)"></td>
      <td id="invAmt_${i}" style="padding:4px 8px; font-weight:600;">${inr(it.qty*it.rate*(1-(it.discount_pct||0)/100))}</td>
      <td><button class="icon-btn del" tabindex="-1" style="width:24px;height:24px;" onclick="removeInvoiceLine(${i})" title="Remove line (not part of the Tab order, so it can't be triggered by accident while typing)">${ic('trash')}</button></td>
    </tr>`).join('');
  paintInvoiceTotals();
  // After adding a new line, jump focus straight to its Product field so
  // Tab alone — no mouse — carries you: pick product, Tab to Qty, Tab to
  // Rate, Tab to Disc%, Tab (skipping the delete icon, which is
  // deliberately taken out of the Tab order above) straight to "Add Line"
  // again to keep going, or on to Paid Now once the invoice is complete.
  if (focusLastProduct) {
    const last = invoiceDraftItems.length - 1;
    document.getElementById(`invProd_${last}`)?.focus();
  }
}
// Lightweight update — used while typing qty/rate/discount, so focus & Tab order never break.
function updateInvLineNumber(i, key, val) {
  invoiceDraftItems[i][key] = Number(val) || 0;
  const it = invoiceDraftItems[i];
  const cell = document.getElementById(`invAmt_${i}`);
  if (cell) cell.textContent = inr(it.qty * it.rate * (1 - (it.discount_pct || 0) / 100));
  paintInvoiceTotals();
}
function updateInvLine(i, key, val) {
  if (key === 'product_id') {
    invoiceDraftItems[i].product_id = Number(val);
    const p = (CACHE.products || []).find((x) => x.id === Number(val));
    if (p) invoiceDraftItems[i].rate = p.sale_rate;
    paintInvoiceLines();
  }
}
function removeInvoiceLine(i) { invoiceDraftItems.splice(i, 1); paintInvoiceLines(); }
function addInvoiceLine() { const products = CACHE.products || []; invoiceDraftItems.push({ product_id: products[0]?.id, qty: 1, rate: products[0]?.sale_rate || 0, discount_pct: 0 }); paintInvoiceLines(true); }
function paintInvoiceTotals() {
  const gst = Number(document.getElementById('fld_gst_pct')?.value || 0);
  const gstType = document.getElementById('fld_gst_type')?.value || 'CGST_SGST';
  const paidNow = Number(document.getElementById('fld_paid_now')?.value || 0);
  let sub = 0; invoiceDraftItems.forEach((it) => sub += it.qty*it.rate*(1-(it.discount_pct||0)/100));
  const loyaltyDiscount = invoiceLoyaltyPreview?.eligible ? (invoiceLoyaltyPreview.reward_type==='FIXED' ? Math.min(Number(invoiceLoyaltyPreview.reward_value||0), sub) : Math.min(sub, sub*Number(invoiceLoyaltyPreview.reward_value||0)/100)) : 0;
  const taxableAfterLoyalty = Math.max(0, sub - loyaltyDiscount);
  const gstAmt = taxableAfterLoyalty*gst/100;
  const grand = taxableAfterLoyalty + gstAmt;
  const gstLines = gstType === 'IGST'
    ? `<div><span>IGST (${gst}%)</span><span>${inr(gstAmt)}</span></div>`
    : `<div><span>CGST (${(gst/2).toFixed(2)}%)</span><span>${inr(gstAmt/2)}</span></div><div><span>SGST (${(gst/2).toFixed(2)}%)</span><span>${inr(gstAmt/2)}</span></div>`;
  const thisInvoiceBalance = Math.max(grand - paidNow, 0);
  const totalDueAsOnDate = Math.max(thisInvoiceBalance + (invoicePrevBalance || 0), 0);
  document.getElementById('invTotals').innerHTML = `<div><span>Sub Total</span><span>${inr(sub)}</span></div>
    ${loyaltyDiscount>0 ? `<div style="color:var(--green); font-weight:700;"><span>Incentive / Loyalty Amount</span><span>- ${inr(loyaltyDiscount)}</span></div>` : ''}
    <div><span>Taxable Amount</span><span>${inr(taxableAfterLoyalty)}</span></div>${gstLines}
    <div class="grand"><span>Grand Total</span><span>${inr(grand)}</span></div>
    <div style="color:var(--green);"><span>Paid Now</span><span>${inr(paidNow)}</span></div>
    <div style="font-weight:700; color:${thisInvoiceBalance>0?'var(--coral)':'var(--green)'};"><span>Balance (this invoice)</span><span>${inr(thisInvoiceBalance)}</span></div>
    <div><span>Previous Balance Due</span><span>${inr(invoicePrevBalance||0)}</span></div>
    <div style="font-weight:700; border-top:1px dashed var(--line); padding-top:6px; margin-top:4px;"><span>Total Balance Due (as on date)</span><span>${inr(totalDueAsOnDate)}</span></div>`;
}
async function saveInvoice(andPrint) {
  const data = {
    customer_id: Number(fld('customer_id')), invoice_date: fld('invoice_date'), due_date: fld('due_date'),
    gst_pct: Number(fld('gst_pct')), gst_type: fld('gst_type'), items: invoiceDraftItems,
    paid_now: Number(fld('paid_now') || 0), paid_mode: fld('paid_mode'),
  };
  try {
    let saved;
    if (editingInvoiceId) saved = await api(`/sales/${editingInvoiceId}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/sales', { method: 'POST', body: JSON.stringify(data) });
    const rewards = saved.unlockedIncentives || [];
    if (rewards.length) pendingSavePopup = false;
    closeModal(); showToast(editingInvoiceId ? 'Invoice updated' : 'Invoice saved — stock updated');
    // If this invoice was created via "Create Invoice" on a Completed future
    // order, finish that conversion now that a real invoice actually exists —
    // linking the two and flipping the order to "Converted".
    if (pendingFutureOrderConversion && !editingInvoiceId) {
      const foId = pendingFutureOrderConversion;
      pendingFutureOrderConversion = null;
      try {
        const converted = await api(`/future-orders/${foId}/convert`, { method: 'POST', body: JSON.stringify({ invoice_id: saved.id }) });
        if (converted.unlockedIncentives?.length) rewards.push(...converted.unlockedIncentives);
        showToast('Future order converted — linked to ' + saved.invoice_no);
      } catch (e) { showToast('Invoice saved, but could not link it back to the future order: ' + e.message); }
    }
    await renderSales();
    if (rewards.length) showUnlockedIncentives(rewards);
    if (andPrint) printInvoice(saved.id);
    await checkLowStockAfterSale(data.items.map((it) => it.product_id));
  } catch (e) { showToast(e.message); }
}
async function checkLowStockAfterSale(productIds) {
  try {
    const stock = await api('/stock/products');
    const low = stock.filter((p) => productIds.includes(p.id) && p.stock < p.min_stock);
    if (!low.length) return;
    document.getElementById('modalBox').innerHTML = `
      <div class="modal-head"><h3 style="color:var(--coral);">${ic('bell')} Low Stock Alert</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <p style="margin-bottom:12px;">This sale has brought the following product(s) below their minimum stock level:</p>
        <div class="tbl-scroll"><table>
          <thead><tr><th>Product</th><th>Current Stock</th><th>Min Level</th></tr></thead>
          <tbody>${low.map((p) => `<tr><td>${p.name}</td><td style="color:var(--coral); font-weight:700;">${p.stock} ${p.unit}</td><td>${p.min_stock} ${p.unit}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Dismiss</button><button class="btn btn-primary" onclick="closeModal(); goTo('reminders');">Send Reorder Reminder</button></div>`;
    document.getElementById('modalBg').classList.add('show');
  } catch (e) { /* non-critical — skip silently if stock check fails */ }
}
async function deleteInvoice(id) { if (!confirm('Delete this invoice? Stock will be reversed.')) return; try { await api(`/sales/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderSales(); } catch (e) { showToast(e.message); } }
async function printInvoice(id) {
  const inv = await api(`/sales/${id}`);
  const co = COMPANY || {};
  const gstLines = inv.gst_type === 'IGST'
    ? `<div><span>IGST (${inv.gst_pct}%)</span><span>${inr(inv.gst_amt)}</span></div>`
    : `<div><span>CGST (${(inv.gst_pct/2).toFixed(2)}%)</span><span>${inr(inv.gst_amt/2)}</span></div><div><span>SGST (${(inv.gst_pct/2).toFixed(2)}%)</span><span>${inr(inv.gst_amt/2)}</span></div>`;
  let prevBalance = 0;
  try { prevBalance = (await api(`/reports/customer-balance/${inv.customer_id}?exclude_invoice_id=${inv.id}`)).balance || 0; } catch (e) {}
  const totalDueAsOnDate = Math.max(inv.balance + prevBalance, 0);
  let pay = null;
  try { pay = await api(`/invoices/${id}/payment-details`); } catch (e) {}
  // BUG FIX: this used to gate the whole UPI block — including the QR
  // image — behind `pay.hasUpi` (which only reflects whether a UPI ID was
  // typed in). That meant a QR code image uploaded directly in Company
  // Settings, with no UPI ID text entered, never showed on the printed
  // invoice at all, even though the backend was correctly returning it as
  // `pay.qrDataUrl`. The image now renders whenever qrDataUrl exists; the
  // "UPI: <id>" text line still only shows if an ID was actually entered.
  const hasAnyUpi = !!(pay && (pay.hasUpi || pay.qrDataUrl));
  const paymentHtml = pay && (pay.hasBank || hasAnyUpi) ? `
    <div style="font-size:11px; color:#444; max-width:260px;">
      <b style="color:#000; font-size:12px; display:block; margin-bottom:4px;">Payment Details</b>
      ${pay.hasBank ? `${pay.bank_name ? `Bank: ${pay.bank_name}<br>` : ''}${pay.bank_account_no ? `A/c No: ${pay.bank_account_no}<br>` : ''}${pay.bank_ifsc ? `IFSC: ${pay.bank_ifsc}<br>` : ''}${pay.bank_branch ? `Branch: ${pay.bank_branch}<br>` : ''}` : ''}
      ${hasAnyUpi ? `${pay.upi_id ? `UPI: ${pay.upi_id}<br>` : ''}${pay.qrDataUrl ? `<img src="${pay.qrDataUrl}" style="width:80px; height:80px; margin-top:4px;"><br><span style="font-size:9.5px; color:#888;">Scan to pay via UPI</span>` : ''}` : ''}
    </div>` : '<div></div>';
  document.getElementById('printArea').innerHTML = `
    <div class="inv-print-head">
      <div style="display:flex; gap:14px; align-items:center;">
        ${co.logo_data_url ? `<img src="${co.logo_data_url}" style="width:56px; height:56px; object-fit:cover; border-radius:8px;">` : ''}
        <div><h2>${co.company_name||'SABIHA ERP'}</h2><div class="muted">${co.address||''}</div><div class="muted">Phone: ${co.phone||''} | Email: ${co.email||''} | GSTIN: ${co.gst_no||''}</div></div>
      </div>
      <div style="text-align:right;"><h2>INVOICE</h2><div class="muted">${inv.invoice_no}</div><div class="muted">Date: ${fmtDate(inv.invoice_date)}<br>Due: ${fmtDate(inv.due_date)}</div></div>
    </div>
    <div><b>Bill To:</b><br>${inv.customer_name}<br><span class="muted">${inv.customer_address||''}</span></div>
    <table class="inv-print-table"><thead><tr><th>Product</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Disc%</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${inv.items.map((it) => `<tr><td>${it.product_name}</td><td>${it.hsn_code||'—'}</td><td>${it.qty} ${it.unit}</td><td>${inr(it.rate)}</td><td>${it.discount_pct||0}</td><td style="text-align:right;">${inr(it.amount)}</td></tr>`).join('')}</tbody></table>
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-top:12px; gap:20px;">
      ${paymentHtml}
      <div class="inv-print-totals"><div><span>Sub Total</span><span>${inr(inv.subtotal)}</span></div>${gstLines}
        <div class="grand"><span>Grand Total</span><span>${inr(inv.grand_total)}</span></div>
        <div><span>Received</span><span>${inr(inv.received)}</span></div>
        <div style="font-weight:700;"><span>Balance Due (this invoice)</span><span>${inr(inv.balance)}</span></div>
        <div><span>Previous Balance Due</span><span>${inr(prevBalance)}</span></div>
        <div style="font-weight:700; border-top:1px dashed #ccc; padding-top:4px;"><span>Total Balance Due (as on date)</span><span>${inr(totalDueAsOnDate)}</span></div></div>
    </div>
    <p style="margin-top:24px; font-size:11px; color:#6E7791;">${co.return_policy||''}</p>
    <p style="margin-top:6px; font-size:10.5px; color:#9AA6C0;">${co.company_name||'SABIHA ERP'} — this invoice was generated electronically.</p>`;
  window.print();
}
async function sendInvoice(id, channel) {
  const inv = await api(`/sales/${id}`);
  const co = COMPANY || {};
  const message = `Dear ${inv.customer_name}, your invoice ${inv.invoice_no} dated ${fmtDate(inv.invoice_date)} for ${inr(inv.grand_total)} (balance due: ${inr(inv.balance)}) from ${co.company_name||'SABIHA ERP'} is ready. Thank you for your business.`;
  if (channel === 'WhatsApp') {
    if (!inv.customer_phone) { showToast('No phone number on file for this customer'); return; }
    try {
      const result = await api(`/whatsapp/send-invoice/${id}`, { method: 'POST' });
      showToast(result.message || 'Invoice PDF sent on WhatsApp');
      try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel: 'WhatsApp', target_type: 'invoice', target_id: id, target_name: inv.customer_name, message: `Invoice ${inv.invoice_no} sent with PDF attachment`, status: 'Sent', ref_type: 'SALE', ref_id: id }) }); } catch (e) {}
    } catch (e) { showToast(e.message || 'Could not send invoice PDF on WhatsApp'); }
    return;
  }
  if (!inv.customer_email) { showToast('No email on file for this customer'); return; }
  window.location.href = `mailto:${inv.customer_email}?subject=${encodeURIComponent('Invoice ' + inv.invoice_no + ' — ' + (co.company_name||'SABIHA ERP'))}&body=${encodeURIComponent(message)}`;
  try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel, target_type: 'invoice', target_id: id, target_name: inv.customer_name, message, status: 'Sent', ref_type: 'SALE', ref_id: id }) }); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Customer Receipts
// ---------------------------------------------------------------------------
async function renderReceipts() {
  const [rows, customers, sales] = await Promise.all([api('/receipts'), api('/customers'), api('/sales')]);
  CACHE.receipts = rows; CACHE.customers = customers; CACHE.sales = sales;
  document.getElementById('content').innerHTML = setHeaderBanner('receipts', `<button class="btn btn-outline" onclick="openReceiptForm()">${ic('plus')} Add Receipt</button>`) + `
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Receipt No</th><th>Date</th><th>Customer</th><th>Invoice</th><th>Amount</th><th>Mode</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td>${r.receipt_no}</td><td>${fmtDate(r.date)}</td><td>${r.customer_name}</td><td>${(CACHE.sales||[]).find((s)=>s.id===r.invoice_id)?.invoice_no||'—'}</td><td>${inr(r.amount)}</td><td>${r.mode}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" title="Edit" onclick="openReceiptForm(${r.id})">${ic('edit')}</button>
          <button class="icon-btn" title="Print" onclick="printReceipt(${r.id})">${ic('print')}</button>
          <button class="icon-btn" title="Download PDF" onclick="downloadReceiptPdf(${r.id})">${ic('download')}</button>
          <button class="icon-btn" title="WhatsApp" onclick="sendReceipt(${r.id},'WhatsApp')" style="color:#25D366;">${ic('bell')}</button>
          <button class="icon-btn" title="Email" onclick="sendReceipt(${r.id},'Email')" style="color:var(--blue);">${ic('mail')}</button>
          <button class="icon-btn del" onclick="deleteReceipt(${r.id})">${ic('trash')}</button>
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="7">No receipts recorded yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function openReceiptForm(id) {
  editingId = id || null;
  const customers = CACHE.customers || []; const sales = CACHE.sales || [];
  const row = id ? (CACHE.receipts || []).find((r) => r.id === id) : { date: todayISO(), customer_id: customers[0]?.id, amount: 0, mode: 'Cash' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Receipt</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Customer</label><select id="fld_customer_id" onchange="onReceiptCustomerChange()">${customers.map((c) => `<option value="${c.id}" ${c.id===row.customer_id?'selected':''}>${c.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Against Invoice</label><select id="fld_invoice_id"></select></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_amount" value="${row.amount||0}"></div>
      <div class="form-field"><label>Mode</label><select id="fld_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option ${m===row.mode?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>Reference No</label><input id="fld_reference_no" value="${row.reference_no||''}"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div>
    <div id="rcptPrevBalanceNote" style="font-size:12px; color:var(--muted); margin-top:4px;"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveReceipt(${id||'null'})">Save</button></div>`;
  onReceiptCustomerChange(row.invoice_id);
  document.getElementById('modalBg').classList.add('show');
}
async function onReceiptCustomerChange(currentInvoiceId) {
  const custId = Number(fld('customer_id'));
  let invs = (CACHE.sales || []).filter((s) => s.customer_id === custId && (s.balance > 0 || s.id === currentInvoiceId));
  document.getElementById('fld_invoice_id').innerHTML = `<option value="">(General / On Account)</option>` + invs.map((s) => `<option value="${s.id}" ${s.id===currentInvoiceId?'selected':''}>${s.invoice_no} — Balance ${inr(s.balance)}</option>`).join('');
  const note = document.getElementById('rcptPrevBalanceNote');
  if (!note || !custId) return;
  try {
    const data = await api(`/reports/customer-balance/${custId}`);
    note.innerHTML = `Total Previous Balance Due for this customer: <b style="color:${data.balance>0?'var(--coral)':'var(--green)'};">${inr(data.balance)}</b>`;
  } catch (e) { note.innerHTML = ''; }
}
async function saveReceipt(id) {
  const data = { date: fld('date'), customer_id: Number(fld('customer_id')), invoice_id: fld('invoice_id') ? Number(fld('invoice_id')) : null, amount: Number(fld('amount')), mode: fld('mode'), reference_no: fld('reference_no'), remarks: fld('remarks') };
  try {
    let saved;
    if (id) saved = await api(`/receipts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else saved = await api('/receipts', { method: 'POST', body: JSON.stringify(data) });
    const rewards = saved.unlockedIncentives || [];
    if (rewards.length) pendingSavePopup = false;
    closeModal(); showToast(id ? 'Receipt updated' : 'Receipt saved');
    if (rewards.length) showUnlockedIncentives(rewards);
    renderReceipts();
  } catch (e) { showToast(e.message); }
}
function printReceipt(id) {
  const r = (CACHE.receipts || []).find((x) => x.id === id); if (!r) return;
  const inv = (CACHE.sales || []).find((s) => s.id === r.invoice_id);
  printGenericReport('Receipt Voucher — ' + r.receipt_no, ['Date','Customer','Against Invoice','Amount','Mode','Reference No'],
    [[fmtDate(r.date), r.customer_name, inv?.invoice_no||'General', inr(r.amount), r.mode, r.reference_no||'']], r.remarks||'');
}
async function sendReceipt(id, channel) {
  const r = (CACHE.receipts || []).find((x) => x.id === id); if (!r) return;
  const cust = (CACHE.customers || []).find((c) => c.id === r.customer_id);
  const inv = (CACHE.sales || []).find((s) => s.id === r.invoice_id);
  const co = COMPANY || {};
  const message = `Dear ${r.customer_name}, we confirm receipt of ${inr(r.amount)} via ${r.mode}${inv ? ' against invoice ' + inv.invoice_no : ''} from ${co.company_name||'SABIHA ERP'}. Thank you.`;
  if (channel === 'WhatsApp') {
    if (!cust?.phone) { showToast('No phone number on file for this customer'); return; }
    window.open(`https://wa.me/${waNumber(cust.phone)}?text=${encodeURIComponent(message)}`, '_blank');
  } else {
    if (!cust?.email) { showToast('No email on file for this customer'); return; }
    window.location.href = `mailto:${cust.email}?subject=${encodeURIComponent('Payment Receipt ' + r.receipt_no + ' — ' + (co.company_name||'SABIHA ERP'))}&body=${encodeURIComponent(message)}`;
  }
  try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel, target_type: 'receipt', target_id: id, target_name: r.customer_name, message, status: 'Sent' }) }); } catch (e) {}
}
async function downloadReceiptPdf(id) {
  const r = (CACHE.receipts || []).find((x) => x.id === id); if (!r) return;
  const inv = (CACHE.sales || []).find((s) => s.id === r.invoice_id);
  try {
    await downloadDocumentPdf('Receipt Voucher — ' + r.receipt_no, ['Date','Customer','Against Invoice','Amount','Mode','Reference No'],
      [[fmtDate(r.date), r.customer_name, inv?.invoice_no||'General', inr(r.amount), r.mode, r.reference_no||'']], r.remarks||'');
  } catch (e) { showToast('Could not generate PDF'); }
}
async function deleteReceipt(id) { if (!confirm('Delete this receipt?')) return; try { await api(`/receipts/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderReceipts(); } catch (e) { showToast(e.message); } }

// ---------------------------------------------------------------------------
// Reminders — overdue invoices & low stock, with WhatsApp / Email / SMS log
// ---------------------------------------------------------------------------
function waNumber(phone) { const digits = String(phone||'').replace(/\D/g,''); return digits.length===10 ? '91'+digits : digits; }
// Downloads a PDF blob from the API and saves it via the browser — used so a
// relevant PDF is ready to attach before opening WhatsApp/Email, since
// neither wa.me links nor mailto: links can attach files programmatically
// (that's a browser/OS security restriction, not something we can bypass).
async function downloadPdfBlob(path, filename) {
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!res.ok) throw new Error('Could not generate PDF');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
async function downloadInvoicePdf(id, invoiceNo) {
  await downloadPdfBlob(`/invoices/${id}/pdf`, `${invoiceNo || 'invoice'}.pdf`);
}
async function downloadDocumentPdf(title, headers, rows, footNote) {
  const res = await fetch(API + '/documents/pdf', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ title, headers, rows, footNote }),
  });
  if (!res.ok) throw new Error('Could not generate PDF');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = title.replace(/[^a-z0-9]+/gi, '-') + '.pdf'; a.click();
  URL.revokeObjectURL(url);
}
// ---------------------------------------------------------------------------
// Fixed Assets — register, Companies Act (SLM) depreciation, Income Tax
// (WDV, per block) depreciation, and the resulting Deferred Tax.
// ---------------------------------------------------------------------------
let assetsTab = 'register';
let assetAsOfDate = '';
async function renderAssets() {
  const [assetData, categories] = await Promise.all([api('/assets' + (assetAsOfDate ? `?as_of=${assetAsOfDate}` : '')), api('/asset-categories')]);
  CACHE.assets = assetData.rows; CACHE.assetTotals = assetData; CACHE.assetCategories = categories;
  if (!assetAsOfDate) assetAsOfDate = assetData.asOf;
  document.getElementById('content').innerHTML = setHeaderBanner('assets') + `
    <div class="tabs">
      <div class="tab ${assetsTab==='register'?'active':''}" onclick="switchAssetsTab('register')">Asset Register</div>
      <div class="tab ${assetsTab==='categories'?'active':''}" onclick="switchAssetsTab('categories')">Categories</div>
      <div class="tab ${assetsTab==='taxWdv'?'active':''}" onclick="switchAssetsTab('taxWdv')">Tax WDV (Income Tax)</div>
      <div class="tab ${assetsTab==='deferredTax'?'active':''}" onclick="switchAssetsTab('deferredTax')">Deferred Tax</div>
    </div>
    <div id="assetsBody"></div>`;
  paintAssetsTab();
}
async function onAssetAsOfChange() {
  assetAsOfDate = document.getElementById('assetAsOfDate').value || todayISO();
  const assetData = await api('/assets?as_of=' + assetAsOfDate);
  CACHE.assets = assetData.rows; CACHE.assetTotals = assetData;
  paintAssetsTab();
}
function switchAssetsTab(t) { assetsTab = t; renderAssets(); }
function paintAssetsTab() {
  const host = document.getElementById('assetsBody');
  if (assetsTab === 'register') {
    const rows = CACHE.assets || [];
    const totals = CACHE.assetTotals || {};
    host.innerHTML = `
      <div class="tbl-toolbar">
        <label style="font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px;">Total Asset Value as on
          <input type="date" id="assetAsOfDate" value="${assetAsOfDate || todayISO()}" onchange="onAssetAsOfChange()">
        </label>
        <button class="btn btn-outline" onclick="openAssetForm()">${ic('plus')} Add Asset</button>
      </div>
      <div class="kpi-strip" style="margin-bottom:14px;">
        <div class="kpi"><div class="n">${inr(totals.totalOriginalCost||0)}</div><div class="l">Total Original Cost (all assets)</div></div>
        <div class="kpi"><div class="n" style="color:var(--blue);">${inr(totals.totalBookValueAsOf||0)}</div><div class="l">Total Book Value as on ${fmtDate(totals.asOf||assetAsOfDate)}</div></div>
      </div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
        <thead><tr><th>Asset No</th><th>Name</th><th>Category</th><th>Purchase Date</th><th>Original Cost</th><th>Method</th><th>Book Value (Books)</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${rows.length ? rows.map((a) => `<tr>
          <td>${a.asset_no}</td>
          <td><b style="cursor:pointer; text-decoration:underline dotted; color:var(--blue);" onclick="openAssetDetail(${a.id})">${a.name}</b></td>
          <td>${a.category_name}</td><td>${fmtDate(a.purchase_date)}</td><td>${inr(a.original_cost)}</td>
          <td><span class="badge ${a.depMethod==='WDV'?'badge-violet':'badge-blue'}">${a.depMethod||'SLM'}</span></td>
          <td><b>${inr(a.bookValue)}</b>${a.fullyDepreciated?' <span class="badge badge-amber">Fully Depreciated</span>':''}</td>
          <td><span class="badge ${a.status==='Disposed'?'badge-red':'badge-green'}">${a.status}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;">
            <button class="icon-btn" title="Edit" onclick="openAssetForm(${a.id})">${ic('edit')}</button>
            ${a.status==='Active' ? `<button class="icon-btn" title="Dispose" onclick="openDisposeForm(${a.id})">${ic('archive')}</button>` : ''}
            <button class="icon-btn del" onclick="deleteAsset(${a.id})">${ic('trash')}</button>
          </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="9">No fixed assets recorded yet.</td></tr>'}</tbody>
      </table></div></div>`;
  } else if (assetsTab === 'categories') {
    const cats = CACHE.assetCategories || [];
    host.innerHTML = `<p style="color:var(--muted); font-size:12.5px; margin-bottom:12px;">Schedule II has many sub-categories, and Income Tax rates are amended by Finance Acts from time to time — confirm classification and current rates with your CA. These are starting points, fully editable.</p>
      <div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="openCategoryForm()">${ic('plus')} Add Category</button></div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
        <thead><tr><th>Category</th><th>Useful Life (Companies Act)</th><th>Residual %</th><th>Income Tax Block</th><th>Tax Rate %</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${cats.length ? cats.map((c) => `<tr><td>${c.name}</td><td>${c.companies_act_useful_life_years} yrs</td><td>${c.residual_value_pct}%</td><td>${c.income_tax_block}</td><td>${c.income_tax_rate_pct}%</td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" onclick="openCategoryForm(${c.id})">${ic('edit')}</button><button class="icon-btn del" onclick="deleteAssetCategory(${c.id})">${ic('trash')}</button></div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No categories yet.</td></tr>'}</tbody>
      </table></div></div>`;
  } else if (assetsTab === 'taxWdv') {
    paintTaxWdvTab();
  } else {
    paintDeferredTaxTab();
  }
}

// --- Asset Register: add/edit/dispose/delete ---
function openAssetForm(id) {
  editingId = id || null;
  const cats = CACHE.assetCategories || [];
  const row = id ? (CACHE.assets || []).find((a) => a.id === id) : { purchase_date: todayISO(), category_id: cats[0]?.id, original_cost: 0 };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Fixed Asset</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field full"><label>Asset Name</label><input id="fld_name" value="${row.name||''}" placeholder="e.g. Injection Molding Machine #2"></div>
      <div class="form-field"><label>Category</label><select id="fld_category_id">${cats.map((c) => `<option value="${c.id}" ${c.id===row.category_id?'selected':''}>${c.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Purchase Date</label><input type="date" id="fld_purchase_date" value="${row.purchase_date}"></div>
      <div class="form-field"><label>Original Cost (₹)</label><input type="number" id="fld_original_cost" value="${row.original_cost||0}"></div>
      <div class="form-field"><label>Useful Life Override (years)</label><input type="number" id="fld_useful_life_years" value="${row.useful_life_years??''}" placeholder="Leave blank to use category default"></div>
      <div class="form-field"><label>Residual % Override</label><input type="number" id="fld_residual_value_pct" value="${row.residual_value_pct??''}" placeholder="Leave blank to use category default"></div>
      <div class="form-field"><label>Book Depreciation Method Override</label><select id="fld_depreciation_method">
        <option value="" ${!row.depreciation_method?'selected':''}>Use category default</option>
        <option value="SLM" ${row.depreciation_method==='SLM'?'selected':''}>Straight Line (SLM)</option>
        <option value="WDV" ${row.depreciation_method==='WDV'?'selected':''}>Written Down Value (WDV)</option>
      </select></div>
      <div class="form-field"><label>Location</label><input id="fld_location" value="${row.location||''}"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${row.remarks||''}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveAsset(${id||'null'})">Save Asset</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveAsset(id) {
  const data = {
    name: fld('name'), category_id: Number(fld('category_id')), purchase_date: fld('purchase_date'), original_cost: Number(fld('original_cost')),
    useful_life_years: fld('useful_life_years'), residual_value_pct: fld('residual_value_pct'), depreciation_method: fld('depreciation_method'), location: fld('location'), remarks: fld('remarks'),
  };
  try {
    if (id) await api(`/assets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/assets', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Asset updated' : 'Asset added'); renderAssets();
  } catch (e) { showToast(e.message); }
}
async function deleteAsset(id) { if (!confirm('Delete this asset record? This cannot be undone.')) return; try { await api(`/assets/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderAssets(); } catch (e) { showToast(e.message); } }
function openDisposeForm(id) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Dispose Asset</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Disposal Date</label><input type="date" id="fld_disposal_date" value="${todayISO()}"></div>
      <div class="form-field"><label>Disposal / Sale Value (₹)</label><input type="number" id="fld_disposal_value" value="0"></div>
    </div>
    <p style="font-size:11.5px; color:var(--muted); margin-top:8px;">Any gain or loss on sale (including short-term capital gains treatment if the tax block is affected) should be reviewed with your CA — this only records the disposal for depreciation purposes.</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveDispose(${id})">Confirm Disposal</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveDispose(id) {
  try {
    await api(`/assets/${id}/dispose`, { method: 'POST', body: JSON.stringify({ disposal_date: fld('disposal_date'), disposal_value: Number(fld('disposal_value')) }) });
    closeModal(); showToast('Asset disposed'); renderAssets();
  } catch (e) { showToast(e.message); }
}
async function openAssetDetail(id) {
  const d = await api(`/assets/${id}`);
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:680px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${d.name} — Depreciation Schedule (Books)</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${inr(d.cost)}</div><div class="l">Original Cost</div></div>
        <div class="kpi"><div class="n">${d.usefulLife} yrs</div><div class="l">Useful Life</div></div>
        <div class="kpi"><div class="n">${inr(d.residualValue)}</div><div class="l">Residual Value</div></div>
        <div class="kpi"><div class="n" style="color:var(--blue);">${inr(d.bookValue)}</div><div class="l">Current Book Value</div></div>
      </div>
      <p style="color:var(--muted); font-size:12px; margin-bottom:8px;">
        <span class="badge ${d.method==='WDV'?'badge-violet':'badge-blue'}">${d.method==='WDV'?'Written Down Value (WDV)':'Straight Line (SLM)'}</span>
        ${d.method==='WDV' ? ' — a fixed % of the reducing book value each year' : ' — Companies Act Schedule II, pro-rated by days in use'}, this drives the balance sheet figure.
      </p>
      <table><thead><tr><th>Financial Year</th><th>Opening Value</th><th>Depreciation</th><th style="text-align:right;">Closing Value</th></tr></thead>
        <tbody>${d.schedule.map((r) => `<tr><td>FY ${r.fy}</td><td>${inr(r.openingValue)}</td><td>${inr(r.depreciation)}</td><td style="text-align:right;">${inr(r.closingValue)}</td></tr>`).join('')}</tbody></table>
      <p style="color:var(--muted); font-size:12px; margin-top:12px;">Tax WDV for this asset's category is tracked at the block level, not per-asset — see the <a href="#" onclick="closeModal(); switchAssetsTab('taxWdv'); return false;">Tax WDV tab</a>.</p>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}

// --- Categories ---
function openCategoryForm(id) {
  editingId = id || null;
  const row = id ? (CACHE.assetCategories || []).find((c) => c.id === id) : { companies_act_useful_life_years: 10, residual_value_pct: 5, income_tax_rate_pct: 15, depreciation_method: 'SLM' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Asset Category</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field full"><label>Category Name</label><input id="fld_name" value="${row.name||''}"></div>
      <div class="form-field"><label>Useful Life — Companies Act (years)</label><input type="number" id="fld_companies_act_useful_life_years" value="${row.companies_act_useful_life_years}"></div>
      <div class="form-field"><label>Residual Value %</label><input type="number" id="fld_residual_value_pct" value="${row.residual_value_pct}"></div>
      <div class="form-field"><label>Book Depreciation Method</label><select id="fld_depreciation_method">
        <option value="SLM" ${(row.depreciation_method||'SLM')==='SLM'?'selected':''}>Straight Line (SLM)</option>
        <option value="WDV" ${row.depreciation_method==='WDV'?'selected':''}>Written Down Value (WDV)</option>
      </select></div>
      <div class="form-field"><label>Income Tax Block</label><input id="fld_income_tax_block" value="${row.income_tax_block||''}" placeholder="e.g. Plant & Machinery"></div>
      <div class="form-field"><label>Income Tax Rate (WDV) %</label><input type="number" id="fld_income_tax_rate_pct" value="${row.income_tax_rate_pct}"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveAssetCategory(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveAssetCategory(id) {
  const data = { name: fld('name'), companies_act_useful_life_years: Number(fld('companies_act_useful_life_years')), residual_value_pct: Number(fld('residual_value_pct')), depreciation_method: fld('depreciation_method'), income_tax_block: fld('income_tax_block'), income_tax_rate_pct: Number(fld('income_tax_rate_pct')) };
  try {
    if (id) await api(`/asset-categories/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/asset-categories', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast('Category saved'); renderAssets();
  } catch (e) { showToast(e.message); }
}
async function deleteAssetCategory(id) { if (!confirm('Delete this category?')) return; try { await api(`/asset-categories/${id}`, { method: 'DELETE' }); showToast('Deleted'); renderAssets(); } catch (e) { showToast(e.message); } }

// --- Tax WDV tab ---
async function paintTaxWdvTab() {
  const host = document.getElementById('assetsBody');
  host.innerHTML = `<div id="taxWdvWrap">Loading…</div>`;
  const data = await api('/tax-blocks');
  CACHE.taxBlocks = data;
  const totalClosingWDV = data.blocks.reduce((s, b) => s + Number(b.closingWDV || 0), 0);
  document.getElementById('taxWdvWrap').innerHTML = `
    <p style="color:var(--muted); font-size:12.5px; margin-bottom:12px;">Income Tax depreciation is computed per <b>block</b> of assets (pooled by rate), not per individual asset, and only becomes final at financial year-end. Showing figures as of FY ${data.uptoFy}.</p>
    ${data.blocks.length ? `<div class="kpi-strip" style="margin-bottom:14px;">
      <div class="kpi"><div class="n" style="color:var(--blue);">${inr(totalClosingWDV)}</div><div class="l">Total Closing WDV — all blocks (FY ${data.uptoFy})</div></div>
    </div>` : ''}
    ${data.blocks.length ? data.blocks.map((b) => `
      <div class="panel" style="margin-bottom:14px;">
        <h3>${b.name} <span style="font-weight:400; color:var(--muted); font-size:12.5px;">(${b.rate}% WDV, ${b.assetCount} asset(s))</span></h3>
        <div class="tbl-scroll" style="margin-top:8px;"><table>
          <thead><tr><th>FY</th><th>Opening WDV</th><th>Additions (≥180 days)</th><th>Additions (&lt;180 days)</th><th>Deletions</th><th>Depreciation</th><th style="text-align:right;">Closing WDV</th></tr></thead>
          <tbody>${b.rows.map((r) => `<tr><td>${r.fy}</td><td>${inr(r.openingWDV)}</td><td>${inr(r.additionsFull)}</td><td>${inr(r.additionsHalf)}</td><td>${inr(r.deletions)}</td><td>${inr(r.depreciation)}</td><td style="text-align:right;"><b>${inr(r.closingWDV)}</b></td></tr>`).join('')}
          <tr style="font-weight:700; border-top:2px solid #000;"><td colspan="6">Closing WDV — ${b.name}</td><td style="text-align:right;">${inr(b.closingWDV)}</td></tr></tbody>
        </table></div>
      </div>`).join('') : '<div class="panel">No assets linked to a tax block yet — add assets in the Asset Register.</div>'}`;
}

// --- Deferred Tax tab ---
async function paintDeferredTaxTab() {
  const host = document.getElementById('assetsBody');
  host.innerHTML = `<div id="deferredTaxWrap">Loading…</div>`;
  const d = await api('/deferred-tax');
  document.getElementById('deferredTaxWrap').innerHTML = `
    <p style="color:var(--muted); font-size:12.5px; margin-bottom:12px;">Deferred tax as of the last completed financial year (FY ${d.fy}, year-end ${fmtDate(d.asOf)}) — comparing Companies Act book value against Income Tax WDV at the same date, at your configured corporate tax rate of ${d.taxRate}%. Change the tax rate in Company Settings.</p>
    <div class="kpi-strip">
      <div class="kpi"><div class="n">${inr(d.totalBookValue)}</div><div class="l">Total Book Value (Companies Act)</div></div>
      <div class="kpi"><div class="n">${inr(d.totalTaxWDV)}</div><div class="l">Total Tax WDV (Income Tax)</div></div>
      <div class="kpi"><div class="n" style="color:${d.timingDifference>=0?'var(--coral)':'var(--green)'};">${inr(Math.abs(d.timingDifference))} ${d.timingDifference>=0?'(Book higher)':'(Tax higher)'}</div><div class="l">Timing Difference</div></div>
    </div>
    <div class="panel" style="max-width:460px;">
      ${d.deferredTaxLiability > 0 ? `<div style="display:flex; justify-content:space-between; padding:8px 0;"><span><b>Deferred Tax Liability</b><br><span style="font-size:11.5px; color:var(--muted);">Book value exceeds tax WDV — tax depreciation was claimed faster, so more tax is payable in future years than book profit alone suggests.</span></span><span style="font-weight:700; color:var(--coral); white-space:nowrap;">${inr(d.deferredTaxLiability)}</span></div>` : ''}
      ${d.deferredTaxAsset > 0 ? `<div style="display:flex; justify-content:space-between; padding:8px 0;"><span><b>Deferred Tax Asset</b><br><span style="font-size:11.5px; color:var(--muted);">Tax WDV exceeds book value — less tax depreciation has been claimed so far than the books show, so less tax is payable in future years.</span></span><span style="font-weight:700; color:var(--green); white-space:nowrap;">${inr(d.deferredTaxAsset)}</span></div>` : ''}
      ${d.deferredTaxLiability === 0 && d.deferredTaxAsset === 0 ? '<p style="color:var(--muted); font-size:12.5px;">No timing difference — book and tax depreciation currently match.</p>' : ''}
    </div>
    <p style="color:var(--muted); font-size:11.5px; margin-top:10px;">This is a management-accounting estimate to support your books, not a substitute for your CA's statutory computation — capital gains on disposals, additional depreciation, and other provisions aren't modelled here.</p>`;
}

// ---------------------------------------------------------------------------
// Loans — working-capital / term loans from a Bank or fintech lender.
// Disbursements, repayments (split into principal + interest) and manual
// adjustments; outstanding balance and interest flow into the Balance
// Sheet, Cash/Bank Book and P&L automatically (see routes/loans.js).
// ---------------------------------------------------------------------------
async function renderLoans() {
  document.getElementById('content').innerHTML = setHeaderBanner('loans', `<button class="btn btn-outline" onclick="openLoanForm()">${ic('plus')} Add Loan</button>`) + `
    <div id="loansKpiWrap"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="loansTableWrap"></div></div>`;
  await reloadLoans();
}
async function reloadLoans() {
  const loans = await api('/loans');
  CACHE.loans = loans;
  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);
  const totalDisbursed = loans.reduce((s, l) => s + l.disbursed, 0);
  const totalInterestPaid = loans.reduce((s, l) => s + l.interestPaid, 0);
  document.getElementById('loansKpiWrap').innerHTML = `
    <div class="kpi-strip">
      <div class="kpi"><div class="n">${inr(totalDisbursed)}</div><div class="l">Total Disbursed (all loans)</div></div>
      <div class="kpi"><div class="n" style="color:var(--coral);">${inr(totalOutstanding)}</div><div class="l">Total Outstanding</div></div>
      <div class="kpi"><div class="n">${inr(totalInterestPaid)}</div><div class="l">Total Interest Paid</div></div>
    </div>`;
  document.getElementById('loansTableWrap').innerHTML = `
    <table><thead><tr><th>Loan No</th><th>Lender</th><th>Type</th><th>Purpose</th><th>Principal</th><th>Rate</th><th>Start Date</th><th>Next Due</th><th>Outstanding</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody>${loans.length ? loans.map((l) => {
      const nextDue = loanNextDueDate(l);
      const overdue = nextDue && l.outstanding > 0 && nextDue < todayISO();
      return `<tr>
      <td><b class="link" onclick="openLoanDetail(${l.id})">${l.loan_no}</b></td><td>${l.lender_name}</td><td>${l.loan_type}</td><td>${l.purpose}</td>
      <td>${inr(l.principal_amount)}</td><td>${l.interest_rate_pct}%</td><td>${fmtDate(l.start_date)}</td>
      <td>${nextDue ? `<span style="${overdue?'color:var(--coral); font-weight:700;':''}">${fmtDate(nextDue)}${overdue?' (overdue)':''}</span>` : '—'}</td>
      <td style="font-weight:700; color:${l.outstanding>0?'var(--coral)':'var(--green)'};">${inr(l.outstanding)}</td>
      <td><span class="badge ${l.status==='Active'?'badge-amber':'badge-green'}">${l.status}</span></td>
      <td style="text-align:right;"><div class="row-actions" style="justify-content:flex-end;">
        ${l.outstanding > 0 ? `<button class="btn btn-sm btn-outline" onclick="quickRepayLoan(${l.id})">${ic('dollar')} Repay</button>` : ''}
        <button class="icon-btn" title="View / Add Transaction" onclick="openLoanDetail(${l.id})">${ic('eye') || ic('book')}</button>
      </div></td>
    </tr>`;}).join('') : '<tr class="empty-row"><td colspan="11">No loans recorded yet — click "Add Loan" to record one.</td></tr>'}</tbody></table>`;
}
// start_date + tenure_months, in local YYYY-MM-DD — the same "when is this
// loan due" calculation the backend uses for the /loans-due alert list,
// duplicated here (cheaply) so every loan can show its due date in this
// table, not just the ones within 15 days of it.
function loanNextDueDate(l) {
  if (!l.tenure_months) return null;
  const d = new Date(l.start_date);
  d.setMonth(d.getMonth() + Number(l.tenure_months));
  return d.toISOString().slice(0, 10);
}
// One-click repayment straight from the loan list — opens the same
// transaction form used inside the loan detail view (pre-set to
// "Repayment"), without a detour through the detail screen first.
async function quickRepayLoan(loanId) {
  const loan = await api(`/loans/${loanId}`);
  CACHE.currentLoan = loan;
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox"></div>`;
  document.getElementById('modalBg').classList.add('show');
  openLoanTxnForm(loanId);
}
function openLoanForm() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Add Loan</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Lender Name</label><input id="fld_lender_name" placeholder="e.g. HDFC Bank, Lendingkart"></div>
      <div class="form-field"><label>Lender Type</label><select id="fld_loan_type"><option>Bank</option><option>Fintech</option><option>Other</option></select></div>
      <div class="form-field"><label>Purpose</label><input id="fld_purpose" value="Working Capital"></div>
      <div class="form-field"><label>Principal Amount (₹)</label><input type="number" id="fld_principal_amount" value="0"></div>
      <div class="form-field"><label>Interest Rate (% p.a.)</label><input type="number" id="fld_interest_rate_pct" value="0"></div>
      <div class="form-field"><label>Start / Disbursement Date</label><input type="date" id="fld_start_date" value="${todayISO()}"></div>
      <div class="form-field"><label>Tenure (months)</label><input type="number" id="fld_tenure_months" value="12"></div>
      <div class="form-field"><label>Disbursement Received Via</label><select id="fld_disbursement_mode">${['Bank Transfer','Cash','Cheque','UPI'].map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks"></div>
    </div><p style="font-size:12px; color:var(--muted); margin-top:8px;">The principal amount is recorded as an initial disbursement — it shows as cash in immediately and as an outstanding liability.</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveLoan()">Save Loan</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveLoan() {
  const data = {
    lender_name: fld('lender_name'), loan_type: fld('loan_type'), purpose: fld('purpose'),
    principal_amount: Number(fld('principal_amount')) || 0, interest_rate_pct: Number(fld('interest_rate_pct')) || 0,
    start_date: fld('start_date'), tenure_months: Number(fld('tenure_months')) || 0,
    disbursement_mode: fld('disbursement_mode'), remarks: fld('remarks'),
  };
  if (!data.lender_name) { showToast('Enter the lender name'); return; }
  try {
    await api('/loans', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast('Loan saved'); renderLoans();
  } catch (e) { showToast(e.message); }
}
async function openLoanDetail(id) {
  const loan = await api(`/loans/${id}`);
  CACHE.currentLoan = loan;
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:760px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${loan.loan_no} — ${loan.lender_name} <span class="badge ${loan.status==='Active'?'badge-amber':'badge-green'}" style="margin-left:6px;">${loan.status}</span></h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip" style="margin-bottom:14px;">
        <div class="kpi"><div class="n">${inr(loan.disbursed)}</div><div class="l">Total Disbursed</div></div>
        <div class="kpi"><div class="n" style="color:var(--coral);">${inr(loan.outstanding)}</div><div class="l">Outstanding</div></div>
        <div class="kpi"><div class="n">${inr(loan.interestPaid)}</div><div class="l">Interest Paid</div></div>
      </div>
      <p style="font-size:12.5px; color:var(--muted); margin-bottom:10px;">${loan.loan_type} loan · ${loan.purpose} · ${loan.interest_rate_pct}% p.a. · Started ${fmtDate(loan.start_date)}${loan.tenure_months ? ` · ${loan.tenure_months} month tenure` : ''}${loan.remarks ? ` · ${loan.remarks}` : ''}</p>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <label style="font-size:12px; font-weight:600; color:var(--muted);">Transactions</label>
        <button class="btn btn-outline btn-sm" onclick="openLoanTxnForm(${loan.id})">${ic('plus')} Add Transaction</button>
      </div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Principal</th><th>Interest</th><th>Mode</th><th>Remarks</th><th></th></tr></thead>
        <tbody>${loan.transactions.map((t) => `<tr>
          <td>${fmtDate(t.date)}</td><td><span class="badge ${t.txn_type==='Disbursement'?'badge-blue':(t.txn_type==='Repayment'?'badge-green':'badge-amber')}">${t.txn_type}</span></td>
          <td>${inr(t.amount)}</td><td>${inr(t.principal_component)}</td><td>${inr(t.interest_component)}</td><td>${t.mode}</td><td>${t.remarks || ''}</td>
          <td>${t.remarks === 'Initial disbursement' ? '' : `<button class="icon-btn del" onclick="deleteLoanTxn(${t.id}, ${loan.id})">${ic('trash')}</button>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button><button class="btn btn-outline" onclick="openLoanEditForm(${loan.id})">Edit Loan</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function openLoanEditForm(id) {
  const loan = CACHE.currentLoan;
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Edit Loan — ${loan.loan_no}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Lender Name</label><input id="fld_lender_name" value="${loan.lender_name}"></div>
      <div class="form-field"><label>Lender Type</label><select id="fld_loan_type">${['Bank','Fintech','Other'].map((t) => `<option ${t===loan.loan_type?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="form-field"><label>Purpose</label><input id="fld_purpose" value="${loan.purpose}"></div>
      <div class="form-field"><label>Interest Rate (% p.a.)</label><input type="number" id="fld_interest_rate_pct" value="${loan.interest_rate_pct}"></div>
      <div class="form-field"><label>Tenure (months)</label><input type="number" id="fld_tenure_months" value="${loan.tenure_months}"></div>
      <div class="form-field"><label>Status</label><select id="fld_status">${['Active','Closed'].map((s) => `<option ${s===loan.status?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_remarks" value="${loan.remarks||''}"></div>
    </div><p style="font-size:12px; color:var(--muted); margin-top:8px;">Principal amount can't be edited here — add a "Disbursement" transaction for a top-up, or an "Adjustment" to correct the balance.</p></div>
    <div class="modal-foot">
      <button class="btn btn-outline del" onclick="deleteLoan(${loan.id})">${ic('trash')} Delete Loan</button>
      <span style="flex:1;"></span>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="updateLoan(${loan.id})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function updateLoan(id) {
  const data = { lender_name: fld('lender_name'), loan_type: fld('loan_type'), purpose: fld('purpose'), interest_rate_pct: Number(fld('interest_rate_pct')) || 0, tenure_months: Number(fld('tenure_months')) || 0, status: fld('status'), remarks: fld('remarks') };
  try { await api(`/loans/${id}`, { method: 'PUT', body: JSON.stringify(data) }); closeModal(); showToast('Loan updated'); renderLoans(); } catch (e) { showToast(e.message); }
}
async function deleteLoan(id) {
  if (!confirm('Delete this loan and all its transactions? This cannot be undone.')) return;
  try { await api(`/loans/${id}`, { method: 'DELETE' }); closeModal(); showToast('Loan deleted'); renderLoans(); } catch (e) { showToast(e.message); }
}
function openLoanTxnForm(loanId) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Add Loan Transaction</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Type</label><select id="fld_txn_type" onchange="toggleLoanTxnFields()">
        <option value="Repayment">Repayment</option><option value="Disbursement">Additional Disbursement</option><option value="Adjustment">Adjustment</option>
      </select></div>
      <div class="form-field"><label>Date</label><input type="date" id="fld_txn_date" value="${todayISO()}"></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_txn_amount" value="0" oninput="toggleLoanTxnFields()"></div>
      <div class="form-field" id="fld_interest_wrap"><label>— of which Interest (₹) <span class="link" onclick="suggestLoanInterest()" style="font-size:11px;">suggest →</span></label><input type="number" id="fld_txn_interest" value="0" oninput="toggleLoanTxnFields()"></div>
      <div class="form-field"><label>Mode</label><select id="fld_txn_mode">${['Bank Transfer','Cash','Cheque','UPI'].map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>Reference No.</label><input id="fld_txn_reference"></div>
      <div class="form-field full"><label>Remarks</label><input id="fld_txn_remarks"></div>
    </div>
    <p id="loanTxnHint" style="font-size:12px; color:var(--muted); margin-top:8px;"></p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveLoanTxn(${loanId})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  toggleLoanTxnFields();
}
function toggleLoanTxnFields() {
  const type = document.getElementById('fld_txn_type')?.value;
  const wrap = document.getElementById('fld_interest_wrap');
  const hint = document.getElementById('loanTxnHint');
  if (!wrap || !hint) return;
  wrap.style.display = type === 'Repayment' ? '' : 'none';
  if (type === 'Repayment') {
    const amt = Number(document.getElementById('fld_txn_amount')?.value) || 0;
    const interest = Number(document.getElementById('fld_txn_interest')?.value) || 0;
    hint.textContent = `Principal component: ${inr(Math.max(0, amt - interest))} — this reduces the outstanding balance; the interest portion flows into Interest / Finance Costs on the P&L.`;
  } else if (type === 'Disbursement') {
    hint.textContent = 'Adds to cash in and increases the outstanding balance — e.g. a top-up on the same loan.';
  } else {
    hint.textContent = 'No cash movement — only adjusts the outstanding balance (positive to increase, negative to decrease/waive).';
  }
}
// Estimates a fair interest amount for a repayment using simple interest —
// outstanding balance × annual rate × (days since the loan's last
// transaction ÷ 365) — and drops it into the interest field as a starting
// point the person can still adjust; it's a suggestion, not the bank's
// official figure, since it doesn't know about compounding or fee timing.
function suggestLoanInterest() {
  const loan = CACHE.currentLoan;
  if (!loan) return;
  const lastTxnDate = (loan.transactions || []).reduce((max, t) => (t.date > max ? t.date : max), loan.start_date);
  const days = Math.max(0, Math.round((new Date(fld('txn_date') || todayISO()) - new Date(lastTxnDate)) / 86400000));
  const suggested = Math.round(loan.outstanding * (loan.interest_rate_pct / 100) * (days / 365));
  document.getElementById('fld_txn_interest').value = suggested;
  toggleLoanTxnFields();
  showToast(`Suggested ${inr(suggested)} interest for ${days} day${days===1?'':'s'} since the last transaction — adjust if your lender calculates differently.`);
}
async function saveLoanTxn(loanId) {
  const data = {
    txn_type: fld('txn_type'), date: fld('txn_date'), amount: Number(fld('txn_amount')) || 0,
    interest_component: Number(fld('txn_interest')) || 0, mode: fld('txn_mode'), reference_no: fld('txn_reference'), remarks: fld('txn_remarks'),
  };
  try {
    await api(`/loans/${loanId}/transactions`, { method: 'POST', body: JSON.stringify(data) });
    showToast('Transaction saved'); await openLoanDetail(loanId);
  } catch (e) { showToast(e.message); }
}
async function deleteLoanTxn(txnId, loanId) {
  if (!confirm('Delete this transaction?')) return;
  try { await api(`/loans/transactions/${txnId}`, { method: 'DELETE' }); showToast('Deleted'); await openLoanDetail(loanId); } catch (e) { showToast(e.message); }
}

async function renderExpenses() {
  const categories = await api('/expenses/categories');
  CACHE.expenseCategories = categories;
  document.getElementById('content').innerHTML = setHeaderBanner('expenses', `<button class="btn btn-outline" onclick="printExpenses()">${ic('print')} Print</button> <button class="btn btn-outline" onclick="openExpenseCategoryForm()">${ic('plus')} Add Category</button> <button class="btn btn-outline" onclick="openExpenseForm()">${ic('plus')} Add Expense</button>`) + `
    <div class="tbl-toolbar">
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:12px; color:var(--muted);">From <input type="date" id="expFrom" onchange="reloadExpenses()" style="margin-left:4px;"></label>
        <label style="font-size:12px; color:var(--muted);">To <input type="date" id="expTo" value="${todayISO()}" onchange="reloadExpenses()" style="margin-left:4px;"></label>
        <select id="expCategory" onchange="reloadExpenses()"><option value="">All Categories</option>${categories.map((c) => `<option>${c}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('expFrom').value=''; document.getElementById('expTo').value='${todayISO()}'; document.getElementById('expCategory').value=''; reloadExpenses();">Clear</button>
      </div>
    </div>
    <div id="expKpiWrap"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="expWrap"></div></div>`;
  reloadExpenses();
}
function openExpenseCategoryForm() {
  const categories = CACHE.expenseCategories || [];
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Expense Categories</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-field full"><label>New Category Name</label><input id="fld_new_expense_category" placeholder="e.g. Fuel &amp; Transport"></div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Existing Categories</label>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">${categories.map((c) => `<span class="badge badge-blue" style="padding:6px 10px;">${c}</span>`).join('')}</div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="saveExpenseCategory()">Add Category</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveExpenseCategory() {
  const name = document.getElementById('fld_new_expense_category').value.trim();
  if (!name) { showToast('Enter a category name'); return; }
  try {
    await api('/expenses/categories', { method: 'POST', body: JSON.stringify({ name }) });
    CACHE.expenseCategories = await api('/expenses/categories');
    closeModal(); showToast('Category added'); renderExpenses();
  } catch (e) { showToast(e.message); }
}
async function reloadExpenses() {
  const from = document.getElementById('expFrom').value; const to = document.getElementById('expTo').value; const category = document.getElementById('expCategory').value;
  const params = [];
  if (from) params.push('from=' + from);
  if (to) params.push('to=' + to);
  if (category) params.push('category=' + encodeURIComponent(category));
  const rows = await api('/expenses' + (params.length ? '?' + params.join('&') : ''));
  CACHE.expenses = rows;
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const byCategory = {};
  rows.forEach((r) => { byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.amount); });
  document.getElementById('expKpiWrap').innerHTML = `<div class="kpi-strip">
    <div class="kpi"><div class="n">${inr(total)}</div><div class="l">Total (this view)</div></div>
    ${Object.entries(byCategory).sort((a,b) => b[1]-a[1]).slice(0,4).map(([cat,amt]) => `<div class="kpi"><div class="n">${inr(amt)}</div><div class="l">${cat}</div></div>`).join('')}
  </div>`;
  document.getElementById('expWrap').innerHTML = `<table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Mode</th><th>Reference</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td><span class="badge badge-blue">${r.category}</span></td><td>${r.description||''}</td><td>${inr(r.amount)}</td><td>${r.mode}</td><td>${r.reference_no||''}</td>
      <td><div class="row-actions" style="justify-content:flex-end;">
        <button class="icon-btn" title="Edit" onclick="openExpenseForm(${r.id})">${ic('edit')}</button>
        <button class="icon-btn del" onclick="deleteExpense(${r.id})">${ic('trash')}</button>
      </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="7">No expenses recorded for this period.</td></tr>'}</tbody></table>`;
}
function openExpenseForm(id) {
  editingId = id || null;
  const categories = CACHE.expenseCategories || [];
  const row = id ? (CACHE.expenses || []).find((r) => r.id === id) : { date: todayISO(), category: categories[0], amount: 0, mode: 'Cash' };
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Expense</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="fld_date" value="${row.date}"></div>
      <div class="form-field"><label>Category</label><select id="fld_category">${categories.map((c) => `<option ${c===row.category?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="fld_amount" value="${row.amount||0}"></div>
      <div class="form-field"><label>Mode</label><select id="fld_mode">${['Cash','Bank Transfer','Cheque','UPI'].map((m) => `<option ${m===row.mode?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>Reference No</label><input id="fld_reference_no" value="${row.reference_no||''}"></div>
      <div class="form-field full"><label>Description</label><input id="fld_description" value="${row.description||''}" placeholder="e.g. September warehouse rent"></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveExpense(${id||'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveExpense(id) {
  const data = { date: fld('date'), category: fld('category'), amount: Number(fld('amount')), mode: fld('mode'), reference_no: fld('reference_no'), description: fld('description') };
  try {
    if (id) await api(`/expenses/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/expenses', { method: 'POST', body: JSON.stringify(data) });
    closeModal(); showToast(id ? 'Expense updated' : 'Expense recorded'); reloadExpenses();
  } catch (e) { showToast(e.message); }
}
async function deleteExpense(id) { if (!confirm('Delete this expense?')) return; try { await api(`/expenses/${id}`, { method: 'DELETE' }); showToast('Deleted'); reloadExpenses(); } catch (e) { showToast(e.message); } }
function printExpenses() {
  const rows = CACHE.expenses || [];
  const totalAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  printGenericReport('Expenses', ['Date','Category','Description','Amount','Mode','Reference'],
    rows.map((r) => [fmtDate(r.date), r.category, r.description||'', inr(r.amount), r.mode, r.reference_no||'']),
    null, ['TOTAL', '', '', inr(totalAmount), '', '']);
}
async function renderReminders() {
  const [dueRows, stockRows, log] = await Promise.all([api('/reports/customer-due'), api('/reports/stock'), api('/reminders')]);
  const overdue = dueRows.filter((r) => r.balance > 0);
  const lowStock = stockRows.raw.filter((m) => m.stock < m.min_stock);
  document.getElementById('content').innerHTML = setHeaderBanner('reminders') + `
    <div class="template-box">
      <label>Message template (used for both invoice & stock reminders — edit freely before sending)</label>
      <textarea id="reminderTemplate">Dear {{name}}, this is a reminder regarding {{detail}}. Please arrange at the earliest. Thank you — ${COMPANY?.company_name||'SABIHA ERP'}.</textarea>
    </div>
    <h3 style="margin-bottom:10px;">Payment Reminders — Overdue / Outstanding (${overdue.length})</h3>
    <div id="reminderCustomers">${overdue.length ? overdue.map((r) => reminderCardHtml('customer', r.id, r.name, `an outstanding balance of ${inr(r.balance)}`, findCustomerContact(r.id))).join('') : '<div class="panel">No outstanding customer balances 🎉</div>'}</div>
    <h3 style="margin:22px 0 10px;">Stock Reorder Reminders (${lowStock.length})</h3>
    <div id="reminderStock">${lowStock.length ? lowStock.map((m) => reminderCardHtml('material', m.id, m.name, `low stock — only ${m.stock} ${m.unit} left (min ${m.min_stock})`, null)).join('') : '<div class="panel">All raw materials sufficiently stocked 🎉</div>'}</div>
    <h3 style="margin:22px 0 10px;">Reminder Log</h3>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Date</th><th>Channel</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
      <tbody>${log.length ? log.map((l) => `<tr><td>${fmtDate(l.date)}</td><td><span class="badge ${l.channel==='WhatsApp'?'badge-green':(l.channel==='Email'?'badge-blue':'badge-violet')}">${l.channel}</span></td><td>${l.target_name}</td><td style="white-space:normal; max-width:320px;">${l.message}</td><td><span class="badge badge-blue">${l.status}</span></td></tr>`).join('') : '<tr class="empty-row"><td colspan="5">No reminders sent yet.</td></tr>'}</tbody>
    </table></div></div>`;
}
function findCustomerContact(id) { const c = (CACHE.customers||[]).find((x)=>x.id===id); return c ? { phone: c.phone, email: c.email } : null; }
function reminderCardHtml(type, id, name, detail, contact) {
  return `<div class="reminder-card">
    <div class="reminder-info"><div class="reminder-badge" style="background:${type==='customer'?'var(--coral)':'var(--amber)'}">${ic(type==='customer'?'wallet':'layers')}</div>
      <div><b>${name}</b><div style="font-size:12px; color:var(--muted);">${detail}</div></div></div>
    <div class="reminder-actions">
      <button class="btn btn-outline btn-sm" onclick="downloadReminderPdf('${type}',${id},'${escapeAttr(name)}')">${ic('download')} PDF</button>
      <button class="btn btn-wa btn-sm" onclick="sendReminder('${type}',${id},'${escapeAttr(name)}','${escapeAttr(detail)}','WhatsApp')">WhatsApp</button>
      <button class="btn btn-mail btn-sm" onclick="sendReminder('${type}',${id},'${escapeAttr(name)}','${escapeAttr(detail)}','Email')">Email</button>
      <button class="btn btn-sms btn-sm" onclick="sendReminder('${type}',${id},'${escapeAttr(name)}','${escapeAttr(detail)}','SMS')">SMS</button>
    </div></div>`;
}
function escapeAttr(s) { return String(s).replace(/'/g, "\\'"); }
async function sendReminder(type, id, name, detail, channel) {
  const template = document.getElementById('reminderTemplate').value;
  const message = template.replace('{{name}}', name).replace('{{detail}}', detail);
  let contact = null;
  if (type === 'customer') contact = findCustomerContact(id);
  if (channel === 'WhatsApp') {
    if (!contact?.phone) { showToast('No phone number on file'); return; }
    window.open(`https://wa.me/${waNumber(contact.phone)}?text=${encodeURIComponent(message)}`, '_blank');
  } else if (channel === 'Email') {
    if (!contact?.email) { showToast('No email on file'); return; }
    window.location.href = `mailto:${contact.email}?subject=${encodeURIComponent('Reminder from ' + (COMPANY?.company_name||'SABIHA ERP'))}&body=${encodeURIComponent(message)}`;
  } else {
    showToast('SMS gateway not configured — logged as queued. Connect a provider (e.g. Twilio, MSG91) to send automatically.');
  }
  try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel, target_type: type, target_id: id, target_name: name, message, status: channel === 'SMS' ? 'Queued' : 'Sent' }) }); renderReminders(); } catch (e) {}
}
async function downloadReminderPdf(type, id, name) {
  try {
    if (type === 'customer') {
      const rows = await api(`/reports/ledger/customer/${id}`);
      await downloadDocumentPdf(`Statement — ${name}`, ['Date','Type','Reference','Debit','Credit','Balance'],
        rows.map((r) => [fmtDate(r.date), r.type, r.ref, r.debit ? inr(r.debit) : '', r.credit ? inr(r.credit) : '', inr(r.balance)]));
    } else {
      const stock = await api('/reports/stock');
      const mat = stock.raw.find((m) => m.id === id);
      if (mat) await downloadDocumentPdf(`Reorder Request — ${mat.name}`, ['Material','Current Stock','Min Level','Unit'],
        [[mat.name, mat.stock, mat.min_stock, mat.unit]], 'Please arrange to supply the above material at the earliest.');
    }
  } catch (e) { showToast('Could not generate PDF'); }
}

function printGenericReport(title, headers, rows, footNote, totalsRow) {
  const co = COMPANY || {};
  document.getElementById('printArea').innerHTML = `
    <div class="inv-print-head">
      <div style="display:flex; gap:14px; align-items:center;">
        ${co.logo_data_url ? `<img src="${co.logo_data_url}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">` : ''}
        <div><h2>${co.company_name || 'SABIHA ERP'}</h2><div class="muted">${co.address || ''}</div></div>
      </div>
      <div style="text-align:right;"><h2>${title}</h2><div class="muted">Generated: ${new Date().toLocaleString('en-IN')}</div></div>
    </div>
    <table class="inv-print-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}
      ${totalsRow ? `<tr style="font-weight:700; border-top:2px solid #000;">${totalsRow.map((c) => `<td>${c==null?'':c}</td>`).join('')}</tr>` : ''}</tbody></table>
    ${footNote ? `<p style="margin-top:16px; font-size:11px; color:#6E7791;">${footNote}</p>` : ''}
    <p style="margin-top:6px; font-size:10.5px; color:#9AA6C0;">${co.company_name || 'SABIHA ERP'} — generated electronically.</p>`;
  window.print();
}

// ---------------------------------------------------------------------------
// Bill of Materials — standalone tab (also editable inline when creating a product)
// ---------------------------------------------------------------------------
async function renderBOM() {
  const products = await api('/products');
  CACHE.products = products;
  const materials = await api('/raw-materials');
  CACHE.rawMaterials = materials;
  document.getElementById('content').innerHTML = setHeaderBanner('bom', `<button class="btn btn-outline" onclick="printBomList()">${ic('print')} Print</button>`) + `
    <p style="color:var(--muted); font-size:12.5px; margin-bottom:14px;">Cost of Production for each finished product is calculated here — the raw materials it needs, the processing cost pulled automatically from Outsourcing jobwork rates, and any other overhead you add. Finished Goods just displays this figure.</p>
    <div id="bomProductList"></div>`;
  paintBomProductList();
}
function paintBomProductList() {
  const products = CACHE.products || [];
  document.getElementById('bomProductList').innerHTML = products.map((p) => bomProductCardHtml(p)).join('');
}
function bomProductCardHtml(p) {
  const stageRows = p.cost_breakdown.stages || [];
  return `<div class="panel" style="margin-bottom:14px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">${p.name} <span style="font-weight:400; color:var(--muted); font-size:12.5px;">(${p.unit}, Sale Rate ${inr(p.sale_rate)})</span></h3></div>
      <button class="btn btn-outline btn-sm" onclick="openBomForm(null,null,${p.id})">${ic('plus')} Add Raw Material</button>
    </div>
    <div class="tbl-scroll" style="margin-top:10px;"><table>
      <thead><tr><th>Raw Material</th><th>Qty per Unit</th><th>Material Rate (Avg.)</th><th>Consumed At Stage</th><th>Line Cost</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${p.bom.length ? p.bom.map((b) => `<tr><td>${b.material_name}</td><td>${b.qty_per_unit} ${b.material_unit}</td><td>${inr(b.avg_rate)}</td><td>${b.stage ? `<span class="badge badge-violet">${b.stage}</span>` : '<span class="badge badge-blue">Final Production</span>'}</td><td>${inr(b.qty_per_unit*b.avg_rate)}</td>
        <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" onclick="openBomForm(${b.id},${b.qty_per_unit},${p.id},'${b.stage||''}')">${ic('edit')}</button><button class="icon-btn del" onclick="deleteBom(${b.id})">${ic('trash')}</button></div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No raw materials linked yet — click "Add Raw Material".</td></tr>'}</tbody>
    </table></div>
    ${stageRows.length ? `<div style="margin-top:10px; font-size:12px; color:var(--muted);">Processing cost (from Outsourcing jobwork): ${stageRows.map((s) => `${s.stage} ${inr(s.avg_rate)}/unit`).join(' + ')} = <b>${inr(p.cost_breakdown.processingCost)}</b></div>` : ''}
    <div class="form-grid" style="margin-top:12px; max-width:420px;">
      <div class="form-field"><label>Other Overhead per Unit (₹) — transport, electricity, etc. not already captured via jobwork</label>
        <input type="number" id="overhead_${p.id}" value="${p.overhead_per_unit||0}" onchange="saveBomOverhead(${p.id})"></div>
    </div>
    <div class="template-box" style="margin-top:12px;">
      <b>Cost of Production: ${inr(p.cost_of_production)}</b><br>
      <span style="color:var(--muted); font-size:12px;">Material ${inr(p.cost_breakdown.materialCost)} + Processing ${inr(p.cost_breakdown.processingCost)} + Overhead ${inr(p.cost_breakdown.overhead)}</span>
    </div>
  </div>`;
}
async function saveBomOverhead(productId) {
  const overhead_per_unit = Number(document.getElementById(`overhead_${productId}`).value) || 0;
  try {
    await api(`/products/${productId}/overhead`, { method: 'PUT', body: JSON.stringify({ overhead_per_unit }) });
    triggerSavedPopupIfPending();
    showToast('Overhead updated');
    CACHE.products = await api('/products');
    paintBomProductList();
  } catch (e) { showToast(e.message); }
}
function printBomList() {
  const products = CACHE.products || [];
  const rows = [];
  products.forEach((p) => {
    p.bom.forEach((b) => rows.push([p.name, b.material_name, `${b.qty_per_unit} ${b.material_unit}`, inr(b.qty_per_unit*b.avg_rate)]));
    rows.push([p.name, '— Cost of Production —', '', inr(p.cost_of_production)]);
  });
  printGenericReport('Bill of Materials & Cost of Production', ['Product', 'Raw Material', 'Qty per Unit', 'Cost'], rows);
}
function openBomForm(id, qty, productId, stage) {
  const materials = CACHE.rawMaterials || [];
  const products = CACHE.products || [];
  editingId = id || null;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} Raw Material${id ? '' : ' to ' + (products.find((p) => p.id === productId)?.name || '')}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Raw Material</label><select id="fld_raw_material_id">${materials.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Qty per Unit</label><input type="number" id="fld_qty_per_unit" value="${qty || 0}"></div>
      <div class="form-field full"><label>Consumed At Stage</label><select id="fld_stage">
        <option value="">— At Final Production (default) —</option>
        ${STAGES.map((s) => `<option value="${s}" ${s===stage?'selected':''}>${s}</option>`).join('')}
      </select></div>
    </div>
    <p style="font-size:11.5px; color:var(--muted); margin-top:6px;">If a stage is chosen, this raw material is consumed automatically when the product passes through and completes that stage (Production Pipeline / Outsourcing), instead of at final assembly.</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveBom(${id || 'null'},${productId || 'null'})">Save</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveBom(id, productId) {
  try {
    const stage = fld('stage') || null;
    if (id) await api(`/bom/${id}`, { method: 'PUT', body: JSON.stringify({ qty_per_unit: Number(fld('qty_per_unit')), stage }) });
    else await api('/bom', { method: 'POST', body: JSON.stringify({ product_id: productId, raw_material_id: Number(fld('raw_material_id')), qty_per_unit: Number(fld('qty_per_unit')), stage }) });
    closeModal(); showToast('BOM saved');
    CACHE.products = await api('/products');
    paintBomProductList();
  } catch (e) { showToast(e.message); }
}
async function deleteBom(id) {
  if (!confirm('Delete this BOM entry?')) return;
  try { await api(`/bom/${id}`, { method: 'DELETE' }); showToast('Deleted'); CACHE.products = await api('/products'); paintBomProductList(); } catch (e) { showToast(e.message); }
}

// ---------------------------------------------------------------------------
// Low Stock — raw materials & finished goods below their minimum level
// ---------------------------------------------------------------------------
// Product click-through: full production + sales history, date-wise —
// lets you see at a glance how much of a product was made vs sold and when.
async function openProductHistoryDetail(id) {
  const data = await api(`/reports/product-history/${id}`);
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:760px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${data.product.name} — Production, Purchase &amp; Sales History</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${data.currentStock} ${data.product.unit}</div><div class="l">Current Stock</div></div>
        <div class="kpi"><div class="n">${data.totalProduced} ${data.product.unit}</div><div class="l">Total Produced (Good Qty)</div></div>
        <div class="kpi"><div class="n">${data.totalSold} ${data.product.unit}</div><div class="l">Total Sold</div></div><div class="kpi"><div class="n">${data.totalPurchased||0} ${data.product.unit}</div><div class="l">Total Purchased</div></div>
      </div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Production History</label>
      <div class="tbl-scroll" style="margin-bottom:16px;"><table><thead><tr><th>Date</th><th>Batch No</th><th>Shift</th><th>Produced Qty</th><th>Defective Qty</th><th>Good Qty</th></tr></thead>
        <tbody>${data.production.length ? data.production.map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${p.batch_no||''}</td><td>${p.shift||''}</td><td>${p.produced_qty}</td><td>${p.defective_qty}</td><td><b>${p.good_qty}</b></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No production recorded for this product yet.</td></tr>'}</tbody>
      </table></div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Purchase History</label>
      <div class="tbl-scroll" style="margin-bottom:16px;"><table><thead><tr><th>Date</th><th>PO No</th><th>Supplier</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${data.purchases.length ? data.purchases.map((p) => `<tr><td>${fmtDate(p.purchase_date)}</td><td>${p.purchase_no}</td><td>${p.supplier_name}</td><td>${p.qty} ${data.product.unit}</td><td>${inr(p.rate)}</td><td>${inr(p.amount)}</td><td>${inr(p.gst_amt||0)}</td><td>${inr(Number(p.amount||0)+Number(p.gst_amt||0))}</td><td>${p.status||''}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="8">No purchases recorded for this finished product yet.</td></tr>'}</tbody>
      </table></div>
      <label style="font-size:12px; font-weight:600; color:var(--muted);">Sales History</label>
      <div class="tbl-scroll"><table><thead><tr><th>Date</th><th>Invoice No</th><th>Customer</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
        <tbody>${data.sales.length ? data.sales.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${s.invoice_no}</td><td>${s.customer_name}</td><td>${s.qty}</td><td>${inr(s.rate)}</td><td>${inr(s.amount)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No sales recorded for this product yet.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function openRawMaterialDetail(id) {
  const data = await api(`/reports/material-purchase-history/${id}`);
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:680px;"></div>`;
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${data.material.name} — Purchase History</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${data.currentStock} ${data.material.unit}</div><div class="l">Current Stock</div></div>
        <div class="kpi"><div class="n">${inr(data.averageRate)}</div><div class="l">Average Purchase Price</div></div>
        <div class="kpi"><div class="n">${inr(data.material.rate)}</div><div class="l">Latest Purchase Rate</div></div>
        <div class="kpi"><div class="n">${data.totalQty} ${data.material.unit}</div><div class="l">Total Purchased (all time)</div></div>
      </div>
      <div class="tbl-scroll"><table><thead><tr><th>Date</th><th>Supplier</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Invoice No</th></tr></thead>
        <tbody>${data.purchases.length ? data.purchases.map((p) => `<tr><td>${fmtDate(p.purchase_date)}</td><td>${p.supplier_name}</td><td>${p.qty} ${data.material.unit}</td><td>${inr(p.rate)}</td><td>${inr(p.amount)}</td><td>${p.invoice_no||''}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No purchases recorded for this material yet.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function renderMaterialUsage() {
  document.getElementById('content').innerHTML = setHeaderBanner('materialUsage', `<button class="btn btn-outline" onclick="printMaterialUsage()">${ic('print')} Print</button>`) + `
    <div class="tbl-toolbar">
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:12px; color:var(--muted);">From <input type="date" id="usageFrom" onchange="paintMaterialUsage()" style="margin-left:4px;"></label>
        <label style="font-size:12px; color:var(--muted);">To <input type="date" id="usageTo" value="${todayISO()}" onchange="paintMaterialUsage()" style="margin-left:4px;"></label>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('usageFrom').value=''; document.getElementById('usageTo').value='${todayISO()}'; paintMaterialUsage();">Clear</button>
      </div>
    </div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="usageWrap"></div></div>`;
  paintMaterialUsage();
}
async function paintMaterialUsage() {
  const from = document.getElementById('usageFrom').value; const to = document.getElementById('usageTo').value;
  const rows = await api(`/reports/material-usage${from || to ? `?${from ? 'from=' + from : ''}${from && to ? '&' : ''}${to ? 'to=' + to : ''}` : ''}`);
  CACHE.materialUsage = rows;
  document.getElementById('usageWrap').innerHTML = `<table><thead><tr><th>Raw Material</th><th>Used (Consumed in Production)</th><th>Purchased</th><th>Current Stock</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr><td>${r.name}</td><td><b>${r.used} ${r.unit}</b></td><td>${r.purchased} ${r.unit}</td><td>${r.currentStock} ${r.unit}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">No raw materials found.</td></tr>'}</tbody></table>`;
}
function printMaterialUsage() {
  const from = document.getElementById('usageFrom').value; const to = document.getElementById('usageTo').value;
  const period = from || to ? ` (${from ? fmtDate(from) : 'Start'} to ${to ? fmtDate(to) : 'Today'})` : '';
  const rows = CACHE.materialUsage || [];
  printGenericReport(`Raw Material Usage${period}`, ['Raw Material', 'Used', 'Purchased', 'Current Stock'],
    rows.map((r) => [r.name, `${r.used} ${r.unit}`, `${r.purchased} ${r.unit}`, `${r.currentStock} ${r.unit}`]));
}
async function renderLowStock() {
  const stock = await api('/reports/stock');
  const lowRaw = stock.raw.filter((m) => m.stock < m.min_stock);
  const lowProd = stock.products.filter((p) => p.stock < p.min_stock);
  document.getElementById('content').innerHTML = setHeaderBanner('lowStock', `<button class="btn btn-outline" onclick="printLowStock()">${ic('print')} Print</button> <button class="btn btn-outline" onclick="goTo('reminders')">${ic('bell')} Send Reorder Reminders</button>`) + `
    <h3 style="margin-bottom:10px;">Raw Materials (${lowRaw.length})</h3>
    <div class="panel" style="padding:0; margin-bottom:18px;"><div class="tbl-scroll"><table>
      <thead><tr><th>Raw Material</th><th>Stock</th><th>Min Level</th><th>Unit</th></tr></thead>
      <tbody>${lowRaw.length ? lowRaw.map((m) => `<tr><td>${m.name}</td><td style="color:var(--coral); font-weight:700;">${m.stock}</td><td>${m.min_stock}</td><td>${m.unit}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">All raw materials sufficiently stocked 🎉</td></tr>'}</tbody>
    </table></div></div>
    <h3 style="margin-bottom:10px;">Finished Goods (${lowProd.length})</h3>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Finished Product</th><th>Stock</th><th>Min Level</th><th>Unit</th></tr></thead>
      <tbody>${lowProd.length ? lowProd.map((p) => `<tr><td>${p.name}</td><td style="color:var(--coral); font-weight:700;">${p.stock}</td><td>${p.min_stock}</td><td>${p.unit}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">All finished goods sufficiently stocked 🎉</td></tr>'}</tbody>
    </table></div></div>`;
  CACHE.lowRaw = lowRaw; CACHE.lowProd = lowProd;
}
function printLowStock() {
  const rows = [...(CACHE.lowRaw||[]).map((m) => ['Raw Material', m.name, m.stock, m.min_stock, m.unit]), ...(CACHE.lowProd||[]).map((p) => ['Finished Good', p.name, p.stock, p.min_stock, p.unit])];
  printGenericReport('Low Stock Alert', ['Type','Item','Stock','Min Level','Unit'], rows);
}

// ---------------------------------------------------------------------------
// Customer Statement — ledger locked to a single customer, printable
// ---------------------------------------------------------------------------
async function renderCustomerStatement() {
  const customers = await api('/customers');
  CACHE.customers = customers;
  document.getElementById('content').innerHTML = setHeaderBanner('customerStatement', `
      <button class="btn btn-outline" onclick="printCustomerStatement()">${ic('print')} Print</button>
      <button class="btn btn-outline" onclick="downloadCustomerStatementPdf()">${ic('download')} Download PDF</button>
      <button class="btn btn-outline" style="color:#25D366;" onclick="sendCustomerStatementWhatsApp()">${ic('bell')} Send via WhatsApp</button>
    `) + `
    <div class="tbl-toolbar">
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <select id="custStmtEntity" onchange="paintCustomerStatement()">${customers.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <label style="font-size:12px; color:var(--muted);">From <input type="date" id="custStmtFrom" onchange="paintCustomerStatement()" style="margin-left:4px;"></label>
        <label style="font-size:12px; color:var(--muted);">To <input type="date" id="custStmtTo" value="${todayISO()}" onchange="paintCustomerStatement()" style="margin-left:4px;"></label>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('custStmtFrom').value=''; document.getElementById('custStmtTo').value='${todayISO()}'; paintCustomerStatement();">Clear</button>
      </div>
    </div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="custStmtWrap"></div></div>`;
  paintCustomerStatement();
}
async function paintCustomerStatement() {
  const id = document.getElementById('custStmtEntity').value;
  if (!id) return;
  const allRows = await api(`/reports/ledger/customer/${id}`);
  const from = document.getElementById('custStmtFrom').value;
  const to = document.getElementById('custStmtTo').value;
  const before = allRows.filter((r) => from && r.date < from);
  const openingBalance = before.length ? before[before.length - 1].balance : 0;
  const rows = allRows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  CACHE.custStmtRows = rows; CACHE.custStmtOpening = openingBalance;
  document.getElementById('custStmtWrap').innerHTML = `<table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
    <tbody>${from ? `<tr style="background:var(--paper);"><td colspan="5"><b>Opening Balance (as of ${fmtDate(from)})</b></td><td><b>${inr(openingBalance)}</b></td></tr>` : ''}
    ${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td><span class="badge badge-blue">${r.type}</span></td><td>${r.ref}</td><td>${r.debit ? inr(r.debit) : ''}</td><td>${r.credit ? inr(r.credit) : ''}</td><td><b>${inr(r.balance)}</b></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No transactions in this period.</td></tr>'}</tbody></table>`;
}
function printCustomerStatement() {
  const sel = document.getElementById('custStmtEntity');
  const name = sel.selectedOptions[0]?.textContent || '';
  const from = document.getElementById('custStmtFrom').value; const to = document.getElementById('custStmtTo').value;
  const rows = CACHE.custStmtRows || [];
  const dataRows = [];
  if (from) dataRows.push(['Opening Balance (as of ' + fmtDate(from) + ')', '', '', '', '', inr(CACHE.custStmtOpening || 0)]);
  rows.forEach((r) => dataRows.push([fmtDate(r.date), r.type, r.ref, r.debit ? inr(r.debit) : '', r.credit ? inr(r.credit) : '', inr(r.balance)]));
  const period = from || to ? ` (${from ? fmtDate(from) : 'Start'} to ${to ? fmtDate(to) : 'Today'})` : '';
  printGenericReport(`Customer Statement — ${name}${period}`, ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Balance'], dataRows);
}
function customerStatementDataRows() {
  const sel = document.getElementById('custStmtEntity');
  const name = sel.selectedOptions[0]?.textContent || '';
  const from = document.getElementById('custStmtFrom').value; const to = document.getElementById('custStmtTo').value;
  const rows = CACHE.custStmtRows || [];
  const dataRows = [];
  if (from) dataRows.push(['Opening Balance (as of ' + fmtDate(from) + ')', '', '', '', '', inr(CACHE.custStmtOpening || 0)]);
  rows.forEach((r) => dataRows.push([fmtDate(r.date), r.type, r.ref, r.debit ? inr(r.debit) : '', r.credit ? inr(r.credit) : '', inr(r.balance)]));
  const period = from || to ? ` (${from ? fmtDate(from) : 'Start'} to ${to ? fmtDate(to) : 'Today'})` : '';
  return { name, dataRows, title: `Customer Statement — ${name}${period}` };
}
async function downloadCustomerStatementPdf() {
  const { title, dataRows } = customerStatementDataRows();
  try { await downloadDocumentPdf(title, ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Balance'], dataRows); }
  catch (e) { showToast('Could not generate PDF'); }
}
// Sends the customer statement over WhatsApp — since wa.me links can't
// attach files (a browser/OS restriction, not something we can bypass), the
// PDF is downloaded first so it's ready to attach manually in WhatsApp, then
// the WhatsApp chat opens pre-filled with a message about the statement.
async function sendCustomerStatementWhatsApp() {
  const id = document.getElementById('custStmtEntity').value;
  const cust = (CACHE.customers || []).find((c) => c.id === Number(id));
  if (!cust) return;
  if (!cust.phone) { showToast('No phone number on file for this customer'); return; }
  const { title, dataRows } = customerStatementDataRows();
  try { await downloadDocumentPdf(title, ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Balance'], dataRows); }
  catch (e) { showToast('Could not generate PDF'); return; }
  const balance = dataRows.length ? dataRows[dataRows.length - 1][5] : inr(0);
  const co = COMPANY || {};
  const message = `Dear ${cust.name}, please find attached your account statement from ${co.company_name||'SABIHA ERP'}. Current balance due: ${balance}. The statement PDF has just been downloaded to your device — please attach it here. Thank you.`;
  showToast('Statement PDF downloaded — attach it in the WhatsApp chat that opens');
  window.open(`https://wa.me/${waNumber(cust.phone)}?text=${encodeURIComponent(message)}`, '_blank');
  try { await api('/reminders', { method: 'POST', body: JSON.stringify({ date: todayISO(), channel: 'WhatsApp', target_type: 'customer', target_id: cust.id, target_name: cust.name, message, status: 'Sent', ref_type: 'CUSTOMER_STATEMENT', ref_id: cust.id }) }); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Future Orders — expected/pipeline business not yet invoiced. Deliberately
// lightweight (no line items) — see the future_orders table comment in
// db.js. Feeds the "Future Order Pipeline" slide of the investor
// presentation automatically.
// ---------------------------------------------------------------------------
async function renderFutureOrders() {
  const customers = CACHE.customers && CACHE.customers.length ? CACHE.customers : await api('/customers');
  CACHE.customers = customers;
  document.getElementById('content').innerHTML = setHeaderBanner('futureOrders', `<button class="btn btn-outline" onclick="openFutureOrderForm()">${ic('plus')} Add Future Order</button>`) + `
    <div id="futureOrdersKpiWrap"></div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="futureOrdersTableWrap"></div></div>
    <div class="panel" style="margin-top:14px;"><h3 style="margin-bottom:10px;">Salesperson-wise Bid Confirmation</h3><div class="tbl-scroll" id="futureOrdersSalespersonWrap"></div></div>`;
  await reloadFutureOrders();
}
async function reloadFutureOrders() {
  const [orders, summary] = await Promise.all([api('/future-orders'), api('/future-orders/summary')]);
  const pending = orders.filter((o) => o.status === 'Open' || o.status === 'Completed');
  const weighted = pending.reduce((s, o) => s + o.expected_value * (o.probability_pct || 100) / 100, 0);
  document.getElementById('futureOrdersKpiWrap').innerHTML = `<div class="kpi-strip">
    <div class="kpi"><div class="n">${pending.length}</div><div class="l">Open / Completed Orders</div></div>
    <div class="kpi"><div class="n">${inr(pending.reduce((s,o)=>s+o.expected_value,0))}</div><div class="l">Total Expected Value</div></div>
    <div class="kpi"><div class="n" style="color:var(--green);">${inr(weighted)}</div><div class="l">Probability-Weighted Value</div></div>
    <div class="kpi"><div class="n" style="color:var(--blue);">${summary.byStatus.Converted?.count||0}</div><div class="l">Converted to Sales (${inr(summary.byStatus.Converted?.value||0)})</div></div>
    <div class="kpi"><div class="n" style="color:var(--coral);">${summary.byStatus.Lost?.count||0}</div><div class="l">Lost (${inr(summary.byStatus.Lost?.value||0)})</div></div></div>`;
  document.getElementById('futureOrdersTableWrap').innerHTML = `<table><thead><tr><th>Order No</th><th>Customer / Prospect</th><th>Product(s)</th><th>Qty</th><th>Salesperson</th><th>Expected Date</th><th>Amount</th><th>Probability</th><th>Status</th><th>Actions</th></tr></thead><tbody>${orders.length ? orders.map(o=>{
    const products=(o.items||[]).map(i=>`${i.product_name} × ${i.qty}`).join('<br>');
    const qty=(o.items||[]).reduce((n,i)=>n+Number(i.qty||0),0);
    const action=o.status==='Open' ? `<button class="btn btn-sm btn-primary" onclick="setFutureOrderStatus(${o.id},'Completed')">✓ Complete</button> <button class="btn btn-sm btn-outline" onclick="setFutureOrderStatus(${o.id},'Lost')">✕ Lost</button>` : o.status==='Completed' ? `<button class="btn btn-sm btn-primary" onclick="convertFutureOrderToSale(${o.id})">${ic('receipt')||ic('plus')} Create Invoice</button> <button class="btn btn-sm btn-outline" onclick="setFutureOrderStatus(${o.id},'Lost')">Mark Lost</button>` : o.status==='Lost' ? `<button class="btn btn-sm btn-outline" onclick="setFutureOrderStatus(${o.id},'Open')">Reopen</button>` : '';
    return `<tr><td><b>${o.order_no}</b></td><td>${o.customer_name}</td><td>${products||'—'}</td><td>${qty||'—'}</td><td>${o.salesperson_employee_name||o.salesperson||'—'}</td><td>${fmtDate(o.expected_date)}</td><td>${inr(o.expected_value)}</td><td>${o.probability_pct}%</td><td><span class="badge ${o.status==='Completed'?'badge-green':o.status==='Lost'?'badge-red':o.status==='Converted'?'badge-blue':'badge-amber'}">${o.status}</span>${o.status==='Converted'&&o.converted_invoice_no?`<div style="font-size:10.5px;color:var(--muted);">→ ${o.converted_invoice_no}</div>`:''}</td><td><div class="row-actions" style="justify-content:flex-end;gap:4px;">${action}<button class="icon-btn" onclick="openFutureOrderForm(${o.id})">${ic('edit')}</button><button class="icon-btn del" onclick="deleteFutureOrder(${o.id})">${ic('trash')}</button></div></td></tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="10">No future orders recorded yet.</td></tr>'}</tbody></table>`;
  const spWrap=document.getElementById('futureOrdersSalespersonWrap');
  if(spWrap) spWrap.innerHTML=`<table><thead><tr><th>Salesperson</th><th>Total Bids</th><th>Open</th><th>Completed</th><th>Converted</th><th>Lost</th><th>Win Rate</th><th>Converted Value</th></tr></thead><tbody>${summary.salespersonRows.length?summary.salespersonRows.map(s=>`<tr><td>${s.salesperson}</td><td>${s.total}</td><td>${s.open}</td><td>${s.completed}</td><td style="color:var(--green);font-weight:600;">${s.converted}</td><td style="color:var(--coral);">${s.lost}</td><td>${s.winRatePct===null?'—':s.winRatePct.toFixed(0)+'%'}</td><td>${inr(s.convertedValue)}</td></tr>`).join(''):'<tr class="empty-row"><td colspan="8">No bids recorded yet.</td></tr>'}</tbody></table>`;
}
async function openFutureOrderForm(id) {
  const orders=id?await api('/future-orders'):[]; const row=id?orders.find(o=>o.id===id):{}; const locked=row.status==='Converted';
  const products=CACHE.products&&CACHE.products.length?CACHE.products:await api('/products'); CACHE.products=products;
  window.__futureOrderItems=(row.items||[]).map(i=>({product_id:i.product_id,qty:i.qty}));
  if(!window.__futureOrderItems.length) window.__futureOrderItems=[{product_id:products[0]?.id,qty:1}];
  document.getElementById('modalBox').innerHTML=`<div class="modal-head"><h3>${id?'Edit':'Add'} Future Order</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
    <div class="form-grid"><div class="form-field"><label>Existing Customer</label><select id="fld_customer_id" ${locked?'disabled':''}><option value="">— Prospect —</option>${(CACHE.customers||[]).map(c=>`<option value="${c.id}" ${c.id===row.customer_id?'selected':''}>${c.name}</option>`).join('')}</select></div>
    <div class="form-field"><label>Prospect Name</label><input id="fld_customer_name_freetext" value="${row.customer_name_freetext||''}" ${locked?'disabled':''}></div>
    <div class="form-field"><label>Salesperson (from login)</label><input value="${ME?.full_name||ME?.username||''}" readonly style="background:var(--paper);font-weight:600;"></div>
    <div class="form-field"><label>Expected Date</label><input type="date" id="fld_expected_date" value="${row.expected_date||todayISO()}" ${locked?'disabled':''}></div>
    <div class="form-field"><label>Probability (%)</label><input type="number" id="fld_probability_pct" value="${row.probability_pct??100}" min="0" max="100" ${locked?'disabled':''}></div>
    <div class="form-field full"><label>Notes</label><input id="fld_notes" value="${row.notes||''}" ${locked?'disabled':''}></div></div>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin:8px 0 5px;">Products in this Order</label>
    <div class="line-items"><table><thead><tr><th>Product</th><th>Qty</th><th>Rate</th><th>Amount</th><th></th></tr></thead><tbody id="futureOrderLines"></tbody></table></div>
    ${locked?'':`<button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="addFutureOrderLine()">${ic('plus')} Add Product</button>`}
    <div id="futureOrderTotal" class="totals-box" style="width:320px;margin-left:auto;margin-top:12px;"></div>
  </div><div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button>${locked?'':`<button class="btn btn-primary" onclick="saveFutureOrder(${id||'null'})">Save Future Order</button>`}</div>`;
  paintFutureOrderLines(); document.getElementById('modalBg').classList.add('show');
}
function paintFutureOrderLines(){
  const products=CACHE.products||[]; const rows=window.__futureOrderItems||[];
  const body=document.getElementById('futureOrderLines'); if(!body)return;
  body.innerHTML=rows.map((it,i)=>{const p=products.find(x=>x.id===Number(it.product_id));const rate=Number(p?.sale_rate||0);return `<tr><td><select onchange="updateFutureOrderLine(${i},this.value)">${products.map(x=>`<option value="${x.id}" ${x.id===Number(it.product_id)?'selected':''}>${x.name}</option>`).join('')}</select></td><td><input type="number" min="0.01" value="${it.qty}" oninput="updateFutureOrderQty(${i},this.value)"></td><td>${inr(rate)}</td><td id="foAmt_${i}">${inr(rate*Number(it.qty||0))}</td><td><button class="icon-btn del" onclick="removeFutureOrderLine(${i})">${ic('trash')}</button></td></tr>`}).join('');
  const total=rows.reduce((sum,it)=>{const p=products.find(x=>x.id===Number(it.product_id));return sum+Number(p?.sale_rate||0)*Number(it.qty||0)},0);
  const el=document.getElementById('futureOrderTotal'); if(el)el.innerHTML=`<div><span>Total Expected Amount</span><strong>${inr(total)}</strong></div><div style="font-size:11px;color:var(--muted);">Amount is automatically calculated from Product Sale Rate × Quantity.</div>`;
}
function addFutureOrderLine(){const p=(CACHE.products||[])[0];if(!p)return;window.__futureOrderItems.push({product_id:p.id,qty:1});paintFutureOrderLines();}
function removeFutureOrderLine(i){if(window.__futureOrderItems.length<=1){showToast('At least one product is required');return;}window.__futureOrderItems.splice(i,1);paintFutureOrderLines();}
function updateFutureOrderLine(i,v){window.__futureOrderItems[i].product_id=Number(v);paintFutureOrderLines();}
function updateFutureOrderQty(i,v){window.__futureOrderItems[i].qty=Math.max(0,Number(v)||0);paintFutureOrderLines();}
async function saveFutureOrder(id){
  const items=(window.__futureOrderItems||[]).map(i=>({product_id:Number(i.product_id),qty:Number(i.qty)}));
  const data={customer_id:fld('customer_id')?Number(fld('customer_id')):null,customer_name_freetext:fld('customer_name_freetext'),expected_date:fld('expected_date'),probability_pct:Number(fld('probability_pct'))||0,notes:fld('notes'),items};
  if(!data.customer_id&&!data.customer_name_freetext){showToast('Pick an existing customer or type a prospect name');return;}
  if(items.some(i=>!(i.qty>0))){showToast('Every product must have a quantity greater than zero');return;}
  try{let saved;if(id)saved=await api(`/future-orders/${id}`,{method:'PUT',body:JSON.stringify(data)});else saved=await api('/future-orders',{method:'POST',body:JSON.stringify(data)});closeModal();showToast(id?'Future order updated':'Future order saved');await reloadFutureOrders();}catch(e){showToast(e.message);}
}
async function setFutureOrderStatus(id,status){try{await api(`/future-orders/${id}/status`,{method:'POST',body:JSON.stringify({status})});showToast(status==='Completed'?'Order marked Complete — you can now create the invoice.':status==='Lost'?'Order marked Lost':'Order reopened');reloadFutureOrders();}catch(e){showToast(e.message);}}
async function deleteFutureOrder(id){if(!confirm('Delete this future order?'))return;try{await api(`/future-orders/${id}`,{method:'DELETE'});showToast('Deleted');reloadFutureOrders();}catch(e){showToast(e.message);}}
let pendingFutureOrderConversion=null;
async function convertFutureOrderToSale(futureOrderId){
  const orders=await api('/future-orders'); const order=orders.find(o=>o.id===futureOrderId); if(!order)return;
  if(order.status!=='Completed'){showToast('Only a Completed order can be converted to a sales invoice');return;}
  if(!order.customer_id){showToast("This prospect isn't in Customers yet — add them as a customer first, then reopen this order.");return;}
  pendingFutureOrderConversion=futureOrderId; window.__futureInvoicePrefill=(order.items||[]).map(i=>({product_id:i.product_id,qty:i.qty,rate:i.rate,discount_pct:0}));
  showToast(`Preparing invoice for ${order.customer_name}`); await openInvoiceForm();
  document.getElementById('fld_customer_id').value=order.customer_id; invoiceDraftItems=window.__futureInvoicePrefill; paintInvoiceLines(); onInvoiceCustomerChange();
}

// ---------------------------------------------------------------------------
// Ledger — running account statement for any customer or supplier
// ---------------------------------------------------------------------------
async function renderLedger() {
  const [customers, suppliers] = await Promise.all([api('/customers'), api('/suppliers')]);
  CACHE.customers = customers; CACHE.suppliers = suppliers;
  const preset = window.__ledgerPreset; window.__ledgerPreset = null;
  const type = preset?.type || 'customer';
  document.getElementById('content').innerHTML = setHeaderBanner('ledger', `<button class="btn btn-outline" onclick="printLedger()">${ic('print')} Print</button>`) + `
    <div class="tbl-toolbar">
      <div style="display:flex; gap:10px;">
        <select id="ledgerType" onchange="onLedgerTypeChange()"><option value="customer" ${type==='customer'?'selected':''}>Customer</option><option value="supplier" ${type==='supplier'?'selected':''}>Supplier</option></select>
        <select id="ledgerEntity" onchange="paintLedger()"></select>
      </div>
    </div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll" id="ledgerWrap"></div></div>`;
  onLedgerTypeChange(preset?.id);
}
function onLedgerTypeChange(presetId) {
  const type = document.getElementById('ledgerType').value;
  const list = type === 'customer' ? (CACHE.customers||[]) : (CACHE.suppliers||[]);
  document.getElementById('ledgerEntity').innerHTML = list.map((x) => `<option value="${x.id}" ${x.id===presetId?'selected':''}>${x.name}</option>`).join('');
  paintLedger();
}
async function paintLedger() {
  const type = document.getElementById('ledgerType').value;
  const id = document.getElementById('ledgerEntity').value;
  if (!id) { document.getElementById('ledgerWrap').innerHTML = '<div style="padding:24px; color:var(--muted);">No records to show.</div>'; return; }
  const rows = await api(`/reports/ledger/${type}/${id}`);
  CACHE.ledgerRows = rows;
  document.getElementById('ledgerWrap').innerHTML = `<table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td><span class="badge badge-blue">${r.type}</span></td><td>${r.ref}</td><td>${r.debit?inr(r.debit):''}</td><td>${r.credit?inr(r.credit):''}</td><td><b>${inr(r.balance)}</b></td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No transactions yet.</td></tr>'}</tbody></table>`;
}
function printLedger() {
  const type = document.getElementById('ledgerType').value;
  const name = document.getElementById('ledgerEntity').selectedOptions[0]?.textContent || '';
  const rows = CACHE.ledgerRows || [];
  printGenericReport(`${type === 'customer' ? 'Customer' : 'Supplier'} Ledger — ${name}`, ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Balance'],
    rows.map((r) => [fmtDate(r.date), r.type, r.ref, r.debit ? inr(r.debit) : '', r.credit ? inr(r.credit) : '', inr(r.balance)]));
}

// ---------------------------------------------------------------------------
// Accounts — Trial Balance, P&L, Balance Sheet, Cash Book, GST (tabbed)
// ---------------------------------------------------------------------------
async function renderAccounts(section) {
  section = section || 'trialBalance';
  const a = await api('/reports/accounts');
  CACHE.accountsData = a;
  const c = document.getElementById('content');
  let body = '';
  if (section === 'trialBalance') {
    body = `<div class="panel"><h3>Trial Balance (Simplified)</h3><div class="tbl-scroll"><table>
        <thead><tr><th>Head</th><th>Debit</th><th>Credit</th></tr></thead>
        <tbody>${a.trialBalance.map((r) => `<tr><td>${r.head}</td><td>${r.debit?inr(r.debit):''}</td><td>${r.credit?inr(r.credit):''}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  } else if (section === 'profitLoss') {
    body = `
      <div class="kpi-strip">
        <div class="kpi"><div class="n">${inr(a.revenue)}</div><div class="l">Revenue (Taxable Sales)</div></div>
        <div class="kpi"><div class="n">${inr(a.expenses)}</div><div class="l">Total Expenses</div></div>
        <div class="kpi"><div class="n" style="color:${a.netProfit>=0?'var(--green)':'var(--coral)'}">${inr(a.netProfit)}</div><div class="l">Net Profit</div></div>
      </div>
      <div class="tbl-toolbar">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <label style="font-size:12px; color:var(--muted); font-weight:600;">Period</label>
          <select id="plPeriod" onchange="paintPLTrend()"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
          <label style="font-size:12px; color:var(--muted); font-weight:600;">Year</label>
          <input type="number" id="plYear" value="${new Date().getFullYear()}" style="width:100px;" oninput="paintPLTrend()">
        </div>
      </div>
      <div class="panel"><h3>Profit & Loss Trend</h3><div class="chart-wrap"><canvas id="chPL"></canvas></div></div>`;
  } else if (section === 'balanceSheet') {
    body = `<div class="panel" style="max-width:560px;"><h3>Balance Sheet (Simplified)</h3>
      <div style="font-size:13px;"><b>Assets</b>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Cash & Bank</span><span>${inr(a.balanceSheet.assets.cashAndBank)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Accounts Receivable</span><span>${inr(a.balanceSheet.assets.receivables)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Raw Material (at cost)</span><span>${inr(a.balanceSheet.assets.rawMaterialAtCost)}</span></div>
        ${a.balanceSheet.assets.inputTaxCredit > 0 ? `<div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Input GST Credit (recoverable) <span class="link" onclick="closeModal(); goTo('taxSummary');" style="font-size:11px;">details →</span></span><span>${inr(a.balanceSheet.assets.inputTaxCredit)}</span></div>` : ''}
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Fixed Assets (Net Book Value) <span class="link" onclick="closeModal(); goTo('assets');" style="font-size:11px;">view →</span></span><span>${inr(a.balanceSheet.assets.fixedAssetsNetBookValue)}</span></div>
        ${a.balanceSheet.assets.deferredTaxAsset > 0 ? `<div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Deferred Tax Asset</span><span>${inr(a.balanceSheet.assets.deferredTaxAsset)}</span></div>` : ''}
        <b style="display:block; margin-top:14px;">Liabilities</b>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Accounts Payable</span><span>${inr(a.balanceSheet.liabilities.payables)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Outstanding Advances</span><span>${inr(a.balanceSheet.liabilities.outstandingAdvances)}</span></div>
        ${a.balanceSheet.liabilities.loansPayable > 0 ? `<div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Loans Payable (Bank / Fintech) <span class="link" onclick="closeModal(); goTo('loans');" style="font-size:11px;">view →</span></span><span>${inr(a.balanceSheet.liabilities.loansPayable)}</span></div>` : ''}
        ${a.balanceSheet.liabilities.deferredTaxLiability > 0 ? `<div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Deferred Tax Liability <span class="link" onclick="closeModal(); goTo('assets'); setTimeout(()=>switchAssetsTab('deferredTax'),50);" style="font-size:11px;">details →</span></span><span>${inr(a.balanceSheet.liabilities.deferredTaxLiability)}</span></div>` : ''}
      </div></div>`;
  } else if (section === 'cashBook') {
    body = `<div class="panel" style="max-width:560px;"><h3>Cash & Bank Book</h3>
      <div style="font-size:13px;">
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Total Cash In (Receipts${a.cashBook.loanDisbursed ? ' + Loans Taken' : ''})</span><span style="color:var(--green);">${inr(a.cashBook.cashIn)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Total Cash Out (Purchases, Payroll, Jobwork, Advances${a.cashBook.loanRepaid ? ', Loan Repayments' : ''})</span><span style="color:var(--coral);">${inr(a.cashBook.cashOut)}</span></div>
        <div class="grand" style="display:flex; justify-content:space-between; padding-top:10px; border-top:1px solid var(--line); font-weight:700;"><span>Closing Balance</span><span>${inr(a.cashBook.cashBalance)}</span></div>
      </div></div>`;
  } else if (section === 'taxSummary') {
    body = `<div class="panel" style="max-width:900px;"><h3>GST / Tax Summary</h3>
      <div class="tbl-toolbar"><label>From</label><input type="date" id="gstFrom" value="${new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10)}"><label>To</label><input type="date" id="gstTo" value="${todayISO()}"><button class="btn btn-primary" onclick="loadGstPeriodReport()">Refresh GST Report</button></div>
      <div id="gstPeriodReport"></div>
      <div style="font-size:13px;">
        <b style="display:block; margin-top:6px;">All-time Summary</b>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Taxable Sales</span><span>${inr(a.gstSummary.taxableSales)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Output GST Collected</span><span style="color:var(--coral); font-weight:600;">${inr(a.gstSummary.outputGst)}</span></div>
        <b style="display:block; margin-top:14px;">Input Tax (on Purchases)</b>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Taxable Purchases</span><span>${inr(a.gstSummary.taxablePurchases)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:6px 0;"><span>Input GST Paid (recoverable) <span class="link" onclick="closeModal(); goTo('purchases');" style="font-size:11px;">view purchases →</span></span><span style="color:var(--green); font-weight:600;">${inr(a.gstSummary.inputGst)}</span></div>
        <div class="grand" style="display:flex; justify-content:space-between; padding-top:10px; margin-top:10px; border-top:1px solid var(--line); font-weight:700;">
          <span>Net Tax ${a.gstSummary.netTaxPayable >= 0 ? 'Payable' : 'Receivable (credit carried forward)'}</span>
          <span style="color:${a.gstSummary.netTaxPayable >= 0 ? 'var(--coral)' : 'var(--green)'};">${inr(Math.abs(a.gstSummary.netTaxPayable))}</span>
        </div>
      </div>
      <b style="display:block; margin-top:18px; margin-bottom:8px;">Last 6 Months</b>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Month</th><th>Output GST</th><th>Input GST</th><th>Net Payable</th></tr></thead>
        <tbody>${a.gstSummary.gstMonths.map((m) => `<tr><td>${m.month}</td><td>${inr(m.outputGst)}</td><td>${inr(m.inputGst)}</td><td style="color:${m.netPayable>=0?'var(--coral)':'var(--green)'};">${inr(m.netPayable)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  }
  const printBtn = `<button class="btn btn-outline" onclick="printAccountsSection('${section}')">${ic('print')} Print</button>`;
  c.innerHTML = setHeaderBanner(section, printBtn) + body +
    `<p style="color:var(--muted); font-size:12px; margin-top:14px;">These figures are computed automatically from your entered sales, purchases, payroll and payments — a simplified single-GST-rate view rather than full double-entry state-wise accounting.</p>`;
  if (section === 'profitLoss') paintPLTrend(); if (section === 'taxSummary') loadGstPeriodReport();
}
async function loadGstPeriodReport() {
  const from=document.getElementById('gstFrom')?.value, to=document.getElementById('gstTo')?.value;
  if(!from||!to)return;
  try{
    const g=await api(`/reports/gst-summary?from=${from}&to=${to}`);
    const el=document.getElementById('gstPeriodReport');
    if(el) el.innerHTML=`<div class="kpi-strip"><div class="kpi"><div class="n">${inr(g.inputGst)}</div><div class="l">Input GST</div></div><div class="kpi"><div class="n">${inr(g.outputGst)}</div><div class="l">Output GST</div></div><div class="kpi"><div class="n" style="color:${g.netTax>=0?'var(--coral)':'var(--green)'}">${inr(Math.abs(g.netTax))}</div><div class="l">${g.netTax>=0?'Balance GST Payable':'Balance GST Credit'}</div></div></div>
      <div class="tbl-scroll"><table><thead><tr><th>GST Rate</th><th>Output Taxable</th><th>Output GST</th><th>Input Taxable</th><th>Input GST</th></tr></thead><tbody>
      ${Array.from(new Set([...g.outputByRate.map(x=>x.rate),...g.inputByRate.map(x=>x.rate)])).sort((a,b)=>a-b).map(rate=>{const o=g.outputByRate.find(x=>x.rate===rate)||{},i=g.inputByRate.find(x=>x.rate===rate)||{};return `<tr><td>${rate}%</td><td>${inr(o.taxable||0)}</td><td>${inr(o.gst||0)}</td><td>${inr(i.taxable||0)}</td><td>${inr(i.gst||0)}</td></tr>`}).join('')}</tbody></table></div>`;
  }catch(e){showToast(e.message);}
}
function paintPLTrend() {
  const a = CACHE.accountsData; if (!a) return;
  const period = document.getElementById('plPeriod')?.value || 'monthly';
  let labels, revenue, expense;
  if (period === 'yearly') {
    const byYear = {};
    a.plTrend.forEach((p) => { const y = p.month.slice(0,4); byYear[y] = byYear[y] || { revenue: 0, expense: 0 }; byYear[y].revenue += p.revenue; byYear[y].expense += p.expense; });
    labels = Object.keys(byYear); revenue = labels.map((y) => byYear[y].revenue); expense = labels.map((y) => byYear[y].expense);
  } else {
    labels = a.plTrend.map((p) => new Date(p.month+'-01').toLocaleDateString('en-US',{month:'short', year:'2-digit'}));
    revenue = a.plTrend.map((p) => p.revenue); expense = a.plTrend.map((p) => p.expense);
  }
  if (charts.pl) charts.pl.destroy();
  charts.pl = new Chart(document.getElementById('chPL'), {
    type: 'line', data: { labels, datasets: [
      { label: 'Revenue', data: revenue, borderColor: '#3B6EF6', backgroundColor: 'rgba(59,110,246,.1)', tension:.35, fill:true },
      { label: 'Expense', data: expense, borderColor: '#E15A5A', backgroundColor: 'rgba(225,90,90,.08)', tension:.35, fill:true },
    ]},
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}}}, scales:{y:{beginAtZero:true}} },
  });
}
function printAccountsSection(section) {
  const a = CACHE.accountsData; if (!a) return;
  if (section === 'trialBalance') {
    printGenericReport('Trial Balance', ['Head','Debit','Credit'], a.trialBalance.map((r) => [r.head, r.debit?inr(r.debit):'', r.credit?inr(r.credit):'']));
  } else if (section === 'profitLoss') {
    printGenericReport('Profit & Loss', ['Revenue', 'Expenses', 'Net Profit'], [[inr(a.revenue), inr(a.expenses), inr(a.netProfit)]]);
  } else if (section === 'balanceSheet') {
    printGenericReport('Balance Sheet', ['Head','Amount'], [
      ['Cash & Bank (Asset)', inr(a.balanceSheet.assets.cashAndBank)], ['Accounts Receivable (Asset)', inr(a.balanceSheet.assets.receivables)],
      ['Raw Material at Cost (Asset)', inr(a.balanceSheet.assets.rawMaterialAtCost)], ['Input GST Credit (Asset)', inr(a.balanceSheet.assets.inputTaxCredit)],
      ['Accounts Payable (Liability)', inr(a.balanceSheet.liabilities.payables)],
      ['Outstanding Advances (Liability)', inr(a.balanceSheet.liabilities.outstandingAdvances)],
      ['Loans Payable (Liability)', inr(a.balanceSheet.liabilities.loansPayable)] ]);
  } else if (section === 'cashBook') {
    printGenericReport('Cash & Bank Book', ['Head','Amount'], [['Cash In', inr(a.cashBook.cashIn)], ['Cash Out', inr(a.cashBook.cashOut)], ['Closing Balance', inr(a.cashBook.cashBalance)]]);
  } else if (section === 'taxSummary') {
    printGenericReport('GST / Tax Summary', ['Head','Amount'], [
      ['Taxable Sales', inr(a.gstSummary.taxableSales)], ['Output GST Collected', inr(a.gstSummary.outputGst)],
      ['Taxable Purchases', inr(a.gstSummary.taxablePurchases)], ['Input GST Paid (recoverable)', inr(a.gstSummary.inputGst)],
      [a.gstSummary.netTaxPayable >= 0 ? 'Net Tax Payable' : 'Net Tax Receivable', inr(Math.abs(a.gstSummary.netTaxPayable))] ]);
  }
}

// ---------------------------------------------------------------------------
// Reports Center
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Business Reports — Sales, Purchase, Production, Stock, Customer, Supplier,
// Financial, Payroll — each generates a real table and is printable
// ---------------------------------------------------------------------------
const REPORT_CATS = [
  { key: 'sales', label: 'Sales Report', icon: 'receipt' },
  { key: 'purchase', label: 'Purchase Report', icon: 'cart' },
  { key: 'production', label: 'Production Report', icon: 'factory' },
  { key: 'stock', label: 'Stock Report', icon: 'layers' },
  { key: 'customer', label: 'Customer Report', icon: 'user' },
  { key: 'supplier', label: 'Supplier Report', icon: 'truck' },
  { key: 'financial', label: 'Financial Report', icon: 'chart' },
  { key: 'payroll', label: 'Payroll Report', icon: 'wallet' },
];
let activeReportCat = null;
let reportFrom = ''; let reportTo = '';
function goToCustomerDues() { activeReportCat = 'customer'; goTo('reports'); }
async function renderReports() {
  document.getElementById('content').innerHTML = setHeaderBanner('reports') + `
    <div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <h3 style="margin:0;">Report Categories</h3>
        <button class="btn btn-primary btn-sm" id="investorPptxBtn" onclick="downloadInvestorPresentation()">${ic('presentation') || ic('print')} Generate Investor Presentation</button>
      </div>
      <div class="pill-list" id="reportCatPills" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;"></div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:12px; padding-top:12px; border-top:1px dashed var(--line);">
        <label style="font-size:12px; color:var(--muted);">From <input type="date" id="reportFrom" value="${reportFrom}" onchange="reportFrom=this.value; if(activeReportCat) openBusinessReport(activeReportCat);" style="margin-left:4px;"></label>
        <label style="font-size:12px; color:var(--muted);">To <input type="date" id="reportTo" value="${reportTo}" onchange="reportTo=this.value; if(activeReportCat) openBusinessReport(activeReportCat);" style="margin-left:4px;"></label>
        <button class="btn btn-outline btn-sm" onclick="reportFrom=''; reportTo=''; document.getElementById('reportFrom').value=''; document.getElementById('reportTo').value=''; if(activeReportCat) openBusinessReport(activeReportCat);">Clear</button>
        <span style="font-size:11.5px; color:var(--muted);">Applies to Sales, Purchase, Production &amp; Payroll reports (date-based). Stock, Customer, Supplier &amp; Financial reports are all-time summaries.</span>
      </div>
    </div>
    <div id="businessReportBody" style="margin-top:16px;"></div>`;
  paintReportCategoryPills();
  if (activeReportCat) openBusinessReport(activeReportCat);
}
// One-click investor/shareholder-style .pptx: business overview,
// monthly/quarterly/yearly comparisons, sales & production reports,
// balance sheet, future order pipeline, and the growth vision statement
// set in Company Settings. Restricted server-side to Admin/Manager since
// it surfaces the full financial picture in one file.
async function downloadInvestorPresentation() {
  const btn = document.getElementById('investorPptxBtn');
  const originalText = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Generating…';
  try {
    const res = await fetch(`${API}/investor-presentation`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Could not generate the presentation'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `Investor-Presentation-${todayISO()}.pptx`; a.click();
    URL.revokeObjectURL(url);
    showToast('Presentation downloaded');
  } catch (e) { showErrorPopup('Presentation Generation Failed', e.message); }
  btn.disabled = false; btn.innerHTML = originalText;
}
// Kept in its own function so the active-category highlight can be
// refreshed whenever the selection changes, not just on the initial
// page load — otherwise switching reports would leave the OLD pill
// looking selected.
function paintReportCategoryPills() {
  const el = document.getElementById('reportCatPills');
  if (!el) return;
  el.innerHTML = REPORT_CATS.map((r) => {
    const active = activeReportCat === r.key;
    return `<span class="badge badge-blue" style="padding:9px 16px; font-size:12.8px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; ${active ? 'outline:2px solid var(--blue); outline-offset:2px; font-weight:700; box-shadow:0 0 0 1px var(--blue);' : ''}" onclick="openBusinessReport('${r.key}')">${ic(r.icon)} ${r.label}</span>`;
  }).join('');
}
async function openBusinessReport(key) {
  activeReportCat = key;
  paintReportCategoryPills();
  if (key === 'financial') { renderPnlReport(); return; }
  const host = document.getElementById('businessReportBody');
  host.innerHTML = `<div class="panel">Loading…</div>`;
  const cat = REPORT_CATS.find((r) => r.key === key);
  let headers = [], rows = [], title = cat.label;
  let payrollTotals = null;
  let totalsRow = null;
  const inRange = (dateStr) => (!reportFrom || dateStr >= reportFrom) && (!reportTo || dateStr <= reportTo);
  if (key === 'sales') {
    const data = (await api('/sales')).filter((s) => inRange(s.invoice_date));
    headers = ['Invoice No', 'Date', 'Customer', 'Total', 'Received', 'Balance', 'Status'];
    rows = data.map((s) => [s.invoice_no, fmtDate(s.invoice_date), s.customer_name, inr(s.grand_total), inr(s.received), inr(s.balance), s.status]);
    totalsRow = ['TOTAL', '', '', inr(data.reduce((a,s) => a+Number(s.grand_total||0),0)), inr(data.reduce((a,s) => a+Number(s.received||0),0)), inr(data.reduce((a,s) => a+Number(s.balance||0),0)), ''];
  } else if (key === 'purchase') {
    const data = (await api('/purchases')).filter((p) => inRange(p.purchase_date));
    headers = ['Purchase No', 'Date', 'Supplier', 'Material', 'Qty', 'Rate', 'Amount'];
    rows = data.map((p) => [p.purchase_no, fmtDate(p.purchase_date), p.supplier_name, p.material_name, p.qty, inr(p.rate), inr(p.amount)]);
    totalsRow = ['TOTAL', '', '', '', data.reduce((a,p) => a+Number(p.qty||0),0), '', inr(data.reduce((a,p) => a+Number(p.amount||0),0))];
  } else if (key === 'production') {
    const data = (await api('/production')).filter((r) => inRange(r.date));
    headers = ['Date', 'Batch', 'Product', 'Shift', 'Planned', 'Produced', 'Defective', 'Good Qty'];
    rows = data.map((r) => [fmtDate(r.date), r.batch_no || '', r.product_name, r.shift, r.planned_qty, r.produced_qty, r.defective_qty, r.produced_qty - r.defective_qty]);
  } else if (key === 'stock') {
    const data = await api('/reports/stock');
    headers = ['Item', 'Type', 'Stock', 'Min Level', 'Unit'];
    rows = [...data.raw.map((m) => [m.name, 'Raw Material', m.stock, m.min_stock, m.unit]), ...data.products.map((p) => [p.name, 'Finished Good', p.stock, p.min_stock, p.unit])];
  } else if (key === 'customer') {
    const data = await api('/reports/customer-due');
    headers = ['Customer', 'Billed', 'Received', 'Balance'];
    rows = data.map((r) => [r.name, inr(r.billed), inr(r.received), inr(r.balance)]);
  } else if (key === 'supplier') {
    const [suppliers, purchases, payments] = await Promise.all([api('/suppliers'), api('/purchases'), api('/supplier-payments')]);
    headers = ['Supplier', 'Total Purchases', 'Total Paid', 'Balance'];
    rows = suppliers.map((s) => {
      const billed = purchases.filter((p) => p.supplier_id === s.id).reduce((sum, p) => sum + p.amount, 0);
      const paid = payments.filter((p) => p.supplier_id === s.id).reduce((sum, p) => sum + p.amount, 0);
      return [s.name, inr(billed), inr(paid), inr(billed - paid)];
    });
  } else if (key === 'payroll') {
    const data = (await api('/payroll')).filter((p) => (!reportFrom || p.pay_month + '-01' >= reportFrom) && (!reportTo || p.pay_month + '-01' <= reportTo));
    headers = ['Payroll No', 'Employee', 'Month', 'Gross', 'Deductions', 'Net Salary', 'Amount Paid', 'Balance'];
    rows = data.map((p) => [p.payroll_no, p.employee_name, p.pay_month, inr(p.gross), inr(p.gross - p.net), inr(p.net), inr(p.paid_amount||0), inr(Math.max(p.net - (p.paid_amount||0), 0))]);
    payrollTotals = { paid: data.reduce((s,p) => s + Number(p.paid_amount||0), 0), balance: data.reduce((s,p) => s + Math.max(p.net - (p.paid_amount||0), 0), 0), net: data.reduce((s,p) => s + Number(p.net||0), 0) };
    totalsRow = ['TOTAL', '', '', inr(data.reduce((a,p) => a+Number(p.gross||0),0)), inr(data.reduce((a,p) => a+Number(p.gross-p.net||0),0)), inr(payrollTotals.net), inr(payrollTotals.paid), inr(payrollTotals.balance)];
  }
  const period = (reportFrom || reportTo) ? ` (${reportFrom ? fmtDate(reportFrom) : 'Start'} to ${reportTo ? fmtDate(reportTo) : 'Today'})` : '';
  title = cat.label + (['sales','purchase','production','payroll'].includes(key) ? period : '');
  CACHE.businessReport = { title, headers, rows, totalsRow };
  const kpiHtml = (key === 'sales' || key === 'purchase') ? await salesPurchaseKpiHtml(key)
    : (key === 'payroll' && payrollTotals) ? `<div class="kpi-strip" style="margin-bottom:14px;">
        <div class="kpi"><div class="n">${inr(payrollTotals.net)}</div><div class="l">Total Net Salary</div></div>
        <div class="kpi"><div class="n" style="color:var(--green);">${inr(payrollTotals.paid)}</div><div class="l">Total Amount Paid</div></div>
        <div class="kpi"><div class="n" style="color:var(--coral);">${inr(payrollTotals.balance)}</div><div class="l">Total Balance Due</div></div>
      </div>` : '';
  host.innerHTML = `
    ${kpiHtml}
    <div class="panel" style="padding:0;">
      <div class="tbl-toolbar" style="padding:16px 16px 0;"><h3 style="margin:0;">${title}</h3><div style="display:flex; gap:8px;"><button class="btn btn-outline" onclick="exportBusinessReportToExcel()">${ic('download')} Export to Excel</button><button class="btn btn-outline" onclick="printBusinessReport()">${ic('print')} Print</button></div></div>
      <div class="tbl-scroll" style="padding:0 0 16px;"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') : `<tr class="empty-row"><td colspan="${headers.length}">No data for this report${['sales','purchase','production','payroll'].includes(key)?' in the selected period':''}.</td></tr>`}</tbody></table></div>
    </div>`;
}
// ---------------------------------------------------------------------------
// Profit & Loss — Screener.in-style waterfall with period comparison,
// drill-down, and inline SVG charts. Charts are hand-drawn SVG rather than
// a charting library so the app keeps working fully offline (no CDN
// dependency), matching this project's standalone/offline design goal.
// ---------------------------------------------------------------------------
let pnlFrom = '', pnlTo = '', pnlCompareFrom = '', pnlCompareTo = '', pnlCompareEnabled = false, pnlPreset = 'month';
function fyBoundsForDate(d) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY = Apr 1 – Mar 31 (India)
  return { start: `${y}-04-01`, end: `${y + 1}-03-31` };
}
function pnlSetPreset(preset) {
  pnlPreset = preset;
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (preset === 'month') { pnlFrom = iso(new Date(today.getFullYear(), today.getMonth(), 1)); pnlTo = iso(today); }
  else if (preset === 'quarter') { const qm = Math.floor(today.getMonth() / 3) * 3; pnlFrom = iso(new Date(today.getFullYear(), qm, 1)); pnlTo = iso(today); }
  else if (preset === 'ytd') { pnlFrom = fyBoundsForDate(today).start; pnlTo = iso(today); }
  else if (preset === 'fy') { const fy = fyBoundsForDate(today); pnlFrom = fy.start; pnlTo = fy.end; }
  pnlCompareFrom = ''; pnlCompareTo = '';
  if (pnlCompareEnabled) pnlDefaultComparePeriod();
  renderPnlReport();
}
function pnlDefaultComparePeriod() {
  const from = new Date(pnlFrom), to = new Date(pnlTo);
  const lengthDays = Math.round((to - from) / 86400000) + 1;
  const cTo = new Date(from); cTo.setDate(cTo.getDate() - 1);
  const cFrom = new Date(cTo); cFrom.setDate(cFrom.getDate() - lengthDays + 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  pnlCompareFrom = iso(cFrom); pnlCompareTo = iso(cTo);
}
function pnlToggleCompare() {
  pnlCompareEnabled = !pnlCompareEnabled;
  if (pnlCompareEnabled && !pnlCompareFrom) pnlDefaultComparePeriod();
  renderPnlReport();
}
async function renderPnlReport() {
  if (!pnlFrom) { pnlSetPreset('month'); return; }
  const host = document.getElementById('businessReportBody');
  host.innerHTML = `<div class="panel">Loading…</div>`;
  let url = `/reports/pnl?from=${pnlFrom}&to=${pnlTo}`;
  if (pnlCompareEnabled && pnlCompareFrom && pnlCompareTo) url += `&compare_from=${pnlCompareFrom}&compare_to=${pnlCompareTo}`;
  const data = await api(url);
  CACHE.pnl = data;
  host.innerHTML = pnlHtml(data);
}
function pnlLineRow(label, key, current, compareDelta, sales, opts = {}) {
  const val = current[key];
  const pctOfSales = sales ? (val / sales * 100) : 0;
  // NOTE: the onclick attribute below is HTML-double-quoted, so the label
  // must be escaped for single-quote JS use, not JSON.stringify'd — JSON.
  // stringify wraps it in double quotes, which would terminate the onclick
  // attribute early and silently break the click handler.
  const escLabel = String(label).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const drilldownAttr = opts.drilldown ? `onclick="pnlDrilldown('${opts.drilldown}', '${escLabel}')" class="pnl-drill" style="cursor:pointer; text-decoration:underline dotted; color:var(--blue);"` : '';
  let deltaCell = '';
  if (compareDelta !== undefined) {
    const d = compareDelta;
    const color = d == null ? 'var(--muted)' : (opts.expense ? (d > 0 ? 'var(--coral)' : 'var(--green)') : (d >= 0 ? 'var(--green)' : 'var(--coral)'));
    deltaCell = `<td style="text-align:right; color:${color}; font-size:12px;">${d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'}</td>`;
  }
  return `<tr style="${opts.bold ? 'font-weight:700; border-top:1px solid var(--line);' : ''} ${opts.indent ? 'color:var(--muted); font-size:13px;' : ''}">
    <td ${drilldownAttr} style="${opts.indent ? 'padding-left:22px;' : ''}">${opts.indent ? '– ' : ''}${label}</td>
    <td style="text-align:right;">${opts.isPct ? val.toFixed(1) + '%' : inr(val)}</td>
    ${opts.isPct ? '<td></td>' : `<td style="text-align:right; color:var(--muted); font-size:12px;">${pctOfSales.toFixed(1)}%</td>`}
    ${deltaCell}
  </tr>`;
}
function svgBarChart(data, opts = {}) {
  const width = opts.width || 540, height = opts.height || 170;
  const pad = { top: 14, right: 10, bottom: 24, left: 10 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const maxPos = Math.max(0, ...data.map((d) => d.value));
  const maxNeg = Math.min(0, ...data.map((d) => d.value));
  const range = (maxPos - maxNeg) || 1;
  const zeroY = pad.top + h * (maxPos / range);
  const gap = w / data.length;
  const barW = Math.min(36, gap * 0.55);
  let bars = '';
  data.forEach((d, i) => {
    const x = pad.left + i * gap + (gap - barW) / 2;
    const barH = Math.max(Math.abs(d.value) / range * h, d.value !== 0 ? 2 : 0);
    const y = d.value >= 0 ? zeroY - barH : zeroY;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${d.value >= 0 ? '#4C6FFF' : '#E15A5A'}"><title>${d.label}: ${inr(d.value)}</title></rect>`;
    bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" font-size="9.5" text-anchor="middle" fill="var(--muted)">${d.label}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%; height:${height}px;">
    <line x1="${pad.left}" y1="${zeroY.toFixed(1)}" x2="${width - pad.right}" y2="${zeroY.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    ${bars}
  </svg>`;
}
const PNL_PIE_COLORS = ['#4C6FFF', '#E15A5A', '#EF9F2E', '#28A97A', '#8B5CF6', '#EC4899', '#14B8A6', '#F59E0B', '#6366F1', '#84CC16'];
function svgPieChart(data, opts = {}) {
  const size = opts.size || 160;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  let angle = -90, paths = '';
  data.forEach((d, i) => {
    const sweep = (d.value / total) * 360;
    const a1 = angle * Math.PI / 180, a2 = (angle + sweep) * Math.PI / 180;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const largeArc = sweep > 180 ? 1 : 0;
    const color = PNL_PIE_COLORS[i % PNL_PIE_COLORS.length];
    paths += (data.length === 1) ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"><title>${d.label}: 100%</title></circle>`
      : `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}"><title>${d.label}: ${Math.round(d.value / total * 100)}%</title></path>`;
    angle += sweep;
  });
  const legend = data.map((d, i) => `<div style="display:flex; align-items:center; gap:6px; font-size:11.5px; margin-bottom:4px;"><span style="width:10px; height:10px; border-radius:2px; background:${PNL_PIE_COLORS[i % PNL_PIE_COLORS.length]}; display:inline-block; flex-shrink:0;"></span><span style="flex:1;">${d.label}</span><b>${Math.round(d.value / total * 100)}%</b></div>`).join('');
  return `<div style="display:flex; gap:18px; align-items:center; flex-wrap:wrap;">
    <svg viewBox="0 0 ${size} ${size}" style="width:${size}px; height:${size}px; flex-shrink:0;">${paths}</svg>
    <div style="flex:1; min-width:160px;">${legend}</div>
  </div>`;
}
function pnlHtml(data) {
  const c = data.current;
  const cmp = data.compare;
  const delta = (key) => cmp ? cmp.delta[key] : undefined;
  const presetBtn = (key, label) => `<button class="btn ${pnlPreset === key ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="pnlSetPreset('${key}')">${label}</button>`;
  return `
    <div class="panel">
      <div class="tbl-toolbar" style="flex-wrap:wrap; gap:10px;">
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${presetBtn('month', 'This Month')}${presetBtn('quarter', 'This Quarter')}${presetBtn('ytd', 'YTD')}${presetBtn('fy', 'Full Financial Year')}
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <label style="font-size:12px; color:var(--muted);">From <input type="date" value="${pnlFrom}" onchange="pnlPreset='custom'; pnlFrom=this.value; renderPnlReport();" style="margin-left:4px;"></label>
          <label style="font-size:12px; color:var(--muted);">To <input type="date" value="${pnlTo}" onchange="pnlPreset='custom'; pnlTo=this.value; renderPnlReport();" style="margin-left:4px;"></label>
          <label style="font-size:12.5px; display:flex; align-items:center; gap:5px; cursor:pointer;"><input type="checkbox" ${pnlCompareEnabled ? 'checked' : ''} onchange="pnlToggleCompare()"> Compare with previous period</label>
        </div>
      </div>
      ${pnlCompareEnabled ? `<div style="display:flex; gap:8px; align-items:center; padding:0 16px 12px; font-size:12px; color:var(--muted);">Comparing to
        <input type="date" value="${pnlCompareFrom}" onchange="pnlCompareFrom=this.value; renderPnlReport();">
        to <input type="date" value="${pnlCompareTo}" onchange="pnlCompareTo=this.value; renderPnlReport();">
      </div>` : ''}
    </div>

    <div style="display:grid; grid-template-columns:1.3fr 1fr; gap:14px; margin-top:14px;" class="pnl-charts-grid">
      <div class="panel"><h3 style="margin-bottom:8px;">Net Profit Trend (last 6 months)</h3>${svgBarChart(data.monthlyTrend.map((m) => ({ label: m.month.slice(2), value: m.pat })))}</div>
      <div class="panel"><h3 style="margin-bottom:8px;">Expense Breakdown</h3>${data.expenseBreakdown.length ? svgPieChart(data.expenseBreakdown) : '<p style="color:var(--muted); font-size:13px;">No expenses in this period.</p>'}</div>
    </div>

    <div class="panel" style="margin-top:14px; padding:0;">
      <div class="tbl-toolbar" style="padding:16px 16px 0;">
        <h3 style="margin:0;">Profit &amp; Loss Statement <span style="font-weight:400; color:var(--muted); font-size:12.5px;">(${fmtDate(pnlFrom)} to ${fmtDate(pnlTo)})</span></h3>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline" onclick="exportPnlToExcel()">${ic('download')} Export to Excel</button>
          <button class="btn btn-outline" onclick="downloadPnlPdf()">${ic('download')} Download PDF</button>
          <button class="btn btn-outline" onclick="printPnlReport()">${ic('print')} Print</button>
        </div>
      </div>
      <p style="padding:0 16px; font-size:11.5px; color:var(--muted);">Underlined line items are clickable — they open the underlying transactions. "% of Sales" is each line's vertical share of Sales Revenue.</p>
      <div class="tbl-scroll" style="padding:0 0 16px;">
        <table>
          <thead><tr><th>Line Item</th><th style="text-align:right;">Amount</th><th style="text-align:right;">% of Sales</th>${cmp ? '<th style="text-align:right;">Δ% vs Previous</th>' : ''}</tr></thead>
          <tbody>
            ${pnlLineRow('Sales / Operating Revenue', 'sales', c, delta('sales'), c.sales, { bold: true, drilldown: 'sales' })}
            ${pnlLineRow('Raw Material Consumed', 'rawMaterialConsumed', c, delta('rawMaterialConsumed'), c.sales, { indent: true, expense: true, drilldown: 'rawMaterialConsumed' })}
            ${pnlLineRow('Gross Profit', 'grossProfit', c, delta('grossProfit'), c.sales, { bold: true })}
            ${pnlLineRow('Employee Benefit Expenses', 'employeeBenefits', c, delta('employeeBenefits'), c.sales, { indent: true, expense: true, drilldown: 'employeeBenefits' })}
            ${pnlLineRow('Outsourcing / Job Work Charges', 'outsourcing', c, delta('outsourcing'), c.sales, { indent: true, expense: true, drilldown: 'outsourcing' })}
            ${pnlLineRow('Other Manufacturing & Admin Overheads', 'otherOverheads', c, delta('otherOverheads'), c.sales, { indent: true, expense: true, drilldown: 'otherOverheads' })}
            ${pnlLineRow('Operating Profit (EBITDA)', 'operatingProfit', c, delta('operatingProfit'), c.sales, { bold: true })}
            ${pnlLineRow('OPM % (Operating Profit / Sales)', 'opm', c, delta('opm'), c.sales, { isPct: true })}
            <tr><td colspan="${cmp ? 4 : 3}" style="padding-top:10px;"></td></tr>
            ${pnlOtherIncomeInterestRow(c, !!cmp)}
            ${pnlLineRow('Depreciation & Amortization', 'depreciation', c, delta('depreciation'), c.sales, { indent: true, expense: true, drilldown: 'depreciation' })}
            ${pnlLineRow('Profit Before Tax (PBT)', 'pbt', c, delta('pbt'), c.sales, { bold: true })}
            ${pnlLineRow(`Tax (${c.taxPct}%)`, 'taxAmount', c, delta('taxAmount'), c.sales, { indent: true, expense: true })}
            ${pnlLineRow('Net Profit (PAT)', 'pat', c, delta('pat'), c.sales, { bold: true })}
          </tbody>
        </table>
      </div>
    </div>`;
}
// Other Income has no dedicated ledger in this app, so it's entered directly
// here and saved against company settings. Interest / Finance Costs is
// split into two parts: loan interest is pulled in automatically from the
// Loans module (read-only here — add/edit it via Loans), and a manual
// override covers anything not tied to a tracked loan (e.g. bank charges).
function pnlOtherIncomeInterestRow(c, hasCompare) {
  return `<tr>
      <td>Other Income</td>
      <td style="text-align:right;"><input type="number" id="pnlOtherIncome" value="${c.otherIncome}" style="width:110px; text-align:right;" onchange="savePnlOverrides()"></td>
      <td></td>${hasCompare ? '<td></td>' : ''}
    </tr>
    <tr>
      <td>Interest / Finance Costs <span style="color:var(--muted); font-size:11px;">(total)</span></td>
      <td style="text-align:right; font-weight:600;">${inr(c.interest)}</td>
      <td></td>${hasCompare ? '<td></td>' : ''}
    </tr>
    <tr style="color:var(--muted); font-size:12px;">
      <td style="padding-left:22px; cursor:pointer; text-decoration:underline dotted; color:var(--blue);" onclick="pnlDrilldown('loanInterest', 'Loan Interest')">– Loan Interest <span class="link" onclick="event.stopPropagation(); goTo('loans')" style="font-size:11px;">(manage in Loans →)</span></td>
      <td style="text-align:right;">${inr(c.loanInterest || 0)}</td>
      <td></td>${hasCompare ? '<td></td>' : ''}
    </tr>
    <tr style="color:var(--muted); font-size:12px;">
      <td style="padding-left:22px;">– Other Finance Costs (manual)</td>
      <td style="text-align:right;"><input type="number" id="pnlInterest" value="${(c.interest||0) - (c.loanInterest||0)}" style="width:110px; text-align:right;" onchange="savePnlOverrides()"></td>
      <td></td>${hasCompare ? '<td></td>' : ''}
    </tr>`;
}
async function savePnlOverrides() {
  const other_income_override = Number(document.getElementById('pnlOtherIncome').value) || 0;
  const interest_expense_override = Number(document.getElementById('pnlInterest').value) || 0;
  try {
    await api('/settings/pnl-overrides', { method: 'PUT', body: JSON.stringify({ other_income_override, interest_expense_override }) });
    renderPnlReport();
  } catch (e) { showToast(e.message); }
}
async function pnlDrilldown(type, label) {
  const data = await api(`/reports/pnl/drilldown/${type}?from=${pnlFrom}&to=${pnlTo}`);
  document.getElementById('modalBox').outerHTML = `<div class="modal" id="modalBox" style="max-width:760px;"></div>`;
  const amtCols = data.headers.map((h, i) => typeof data.rows[0]?.[i] === 'number' && /amount|rate|value|gross|qty/i.test(h) ? i : -1).filter((i) => i >= 0);
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${label} — Transactions</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:12px; color:var(--muted); margin-bottom:8px;">${fmtDate(pnlFrom)} to ${fmtDate(pnlTo)}</p>
      <div class="tbl-scroll"><table><thead><tr>${data.headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${data.rows.length ? data.rows.map((r) => `<tr>${r.map((v, i) => `<td>${typeof v === 'number' && /amount|rate|value|gross/i.test(data.headers[i]) ? inr(v) : v}</td>`).join('')}</tr>`).join('') : `<tr class="empty-row"><td colspan="${data.headers.length}">No transactions in this period.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
function pnlExportRows() {
  const c = CACHE.pnl.current;
  return [
    ['Sales / Operating Revenue', inr(c.sales)],
    ['Raw Material Consumed', inr(c.rawMaterialConsumed)],
    ['Gross Profit', inr(c.grossProfit)],
    ['Employee Benefit Expenses', inr(c.employeeBenefits)],
    ['Outsourcing / Job Work Charges', inr(c.outsourcing)],
    ['Other Manufacturing & Admin Overheads', inr(c.otherOverheads)],
    ['Operating Profit (EBITDA)', inr(c.operatingProfit)],
    ['OPM %', c.opm.toFixed(1) + '%'],
    ['Other Income', inr(c.otherIncome)],
    ['Interest / Finance Costs', inr(c.interest)],
    ['Depreciation & Amortization', inr(c.depreciation)],
    ['Profit Before Tax (PBT)', inr(c.pbt)],
    [`Tax (${c.taxPct}%)`, inr(c.taxAmount)],
    ['Net Profit (PAT)', inr(c.pat)],
  ];
}
function exportPnlToExcel() {
  if (!CACHE.pnl) return;
  downloadCsv(`Profit-and-Loss-${pnlFrom}-to-${pnlTo}.csv`, ['Line Item', 'Amount'], pnlExportRows());
}
async function downloadPnlPdf() {
  if (!CACHE.pnl) return;
  try { await downloadDocumentPdf(`Profit & Loss Statement (${fmtDate(pnlFrom)} to ${fmtDate(pnlTo)})`, ['Line Item', 'Amount'], pnlExportRows()); }
  catch (e) { showErrorPopup('Download Failed', e.message); }
}
function printPnlReport() {
  if (!CACHE.pnl) return;
  printGenericReport(`Profit & Loss Statement (${fmtDate(pnlFrom)} to ${fmtDate(pnlTo)})`, ['Line Item', 'Amount'], pnlExportRows());
}
function printBusinessReport() {
  const r = CACHE.businessReport; if (!r) return;
  printGenericReport(r.title, r.headers, r.rows, null, r.totalsRow);
}
// Exports the currently-loaded report table as a .csv file — opens directly
// in Excel for offline reconciliation, with no extra dependency needed to
// produce a real .xlsx file.
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')].concat(rows.map((r) => r.map(csvEscape).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function exportBusinessReportToExcel() {
  const r = CACHE.businessReport; if (!r) return;
  const rows = r.totalsRow ? [...r.rows, r.totalsRow] : r.rows;
  downloadCsv(`${r.title.replace(/[^\w -]/g, '')}.csv`, r.headers, rows);
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------
let auditBackupTab = 'audit';
async function renderAuditLog() {
  document.getElementById('content').innerHTML = setHeaderBanner('auditLog') + `
    <div class="tabs">
      <div class="tab ${auditBackupTab==='audit'?'active':''}" onclick="switchAuditBackupTab('audit')">${ic('list')} Audit Log</div>
      <div class="tab ${auditBackupTab==='backup'?'active':''}" onclick="switchAuditBackupTab('backup')">${ic('db')} Backup & Restore</div>
    </div>
    <div id="auditBackupBody"></div>`;
  paintAuditBackupTab();
}
function switchAuditBackupTab(t) { auditBackupTab = t; paintAuditBackupTab(); }
async function paintAuditBackupTab() {
  const host = document.getElementById('auditBackupBody');
  if (auditBackupTab === 'audit') {
    const rows = await api('/reports/audit-log');
    CACHE.audit = rows; searchQuery = '';
    host.innerHTML = `<div class="tbl-toolbar"><input type="text" placeholder="Search log..." oninput="searchQuery=this.value.toLowerCase(); paintAuditTable();"></div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll" id="auditWrap"></div></div>`;
    paintAuditTable();
  } else {
    host.innerHTML = `
      <div class="panel" style="max-width:560px; margin-bottom:14px;">
        <h3>${ic('db')} Download Backup</h3>
        <p style="color:var(--muted); font-size:13px; margin-bottom:16px;">Download a full timestamped backup of your live PostgreSQL database (a .json file). Keep it somewhere safe — it contains everything: masters, transactions, and history.</p>
        <button class="btn btn-primary btn-xs" onclick="downloadBackup()">${ic('db')} Download Backup</button>
      </div>
      <div class="panel" style="max-width:560px;">
        <h3>${ic('upload')} Restore from Backup</h3>
        <p style="color:var(--muted); font-size:13px; margin-bottom:16px;">Upload a previously downloaded .json backup file. A safety copy of your current data is saved first, then everything is replaced in one all-or-nothing step — no restart is needed.</p>
        <input type="file" id="restoreFile" accept=".json,application/json">
        <div style="margin-top:12px;"><button class="btn btn-outline btn-xs" onclick="uploadRestore()">${ic('upload')} Upload & Restore</button></div>
      </div>`;
  }
}
function paintAuditTable() {
  const rows = (CACHE.audit||[]).filter((r) => !searchQuery || JSON.stringify(r).toLowerCase().includes(searchQuery));
  document.getElementById('auditWrap').innerHTML = `<table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>ID</th><th>Details</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString('en-IN')}</td><td>${r.username}</td><td><span class="badge ${r.action==='CREATE'?'badge-green':(r.action==='DELETE'?'badge-red':'badge-blue')}">${r.action}</span></td><td>${r.entity}</td><td>${r.entity_id||''}</td><td style="max-width:320px; white-space:normal; font-size:11.5px; color:var(--muted);">${(r.details||'').slice(0,160)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="6">No activity logged yet.</td></tr>'}</tbody>`;
}
async function uploadRestore() {
  const file = document.getElementById('restoreFile').files[0];
  if (!file) { showErrorPopup('No File Selected', 'Please choose a .json backup file first, then click "Upload &amp; Restore".'); return; }
  if (!/\.json$/i.test(file.name)) { showErrorPopup('Wrong File Type', 'That doesn\'t look like a .json backup file. Please select the file that was downloaded using "Download Backup".'); return; }
  const reader = new FileReader();
  reader.onerror = () => showErrorPopup('Restore Failed', 'Could not read that file from your computer. Please try again.');
  reader.onload = async () => {
    try {
      const res = await api('/restore', { method: 'POST', body: JSON.stringify({ file_base64: reader.result }) });
      if (res.restarting) {
        showRestoringOverlay();
      } else {
        showToast(res.message || 'Backup restored — reloading…');
        setTimeout(() => location.reload(), 1800);
      }
    } catch (e) { showErrorPopup('Restore Failed', e.message); }
  };
  reader.readAsDataURL(file);
}
// The server restarts itself to apply a restore (see routes/admin.js). This
// shows a full-screen "please wait" message, then polls until the server
// answers again and reloads the page automatically — the person never has
// to know a restart happened at all, or do anything themselves.
function showRestoringOverlay() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Restoring Your Data…</h3></div>
    <div class="modal-body">
      <p style="font-size:14px;">Your backup was verified and the app is restarting to apply it. This usually takes a few seconds — please don't close this window.</p>
      <p id="restoreStatusMsg" style="font-size:12.5px; color:var(--muted); margin-top:10px;">Waiting for the app to come back online…</p>
    </div>`;
  document.getElementById('modalBg').classList.add('show');
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(API + '/me', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (res.ok || res.status === 401) { // 401 is fine here too — it just means the server is back up and answering
        clearInterval(poll);
        document.getElementById('restoreStatusMsg').textContent = 'Done — reloading…';
        setTimeout(() => window.location.reload(), 500);
      }
    } catch (e) {
      // still restarting — server not reachable yet, keep waiting
      if (attempts > 40) { // ~40s with no response
        clearInterval(poll);
        document.getElementById('restoreStatusMsg').innerHTML = 'This is taking longer than expected. If nothing happens, please close this window and reopen SABIHA ERP yourself.';
      }
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// Users & Roles (ADMIN only) — approve accounts, change roles
// ---------------------------------------------------------------------------
let usersTab = 'users';
async function renderUsers() {
  document.getElementById('content').innerHTML = setHeaderBanner('users') + `
    <div class="tabs">
      <div class="tab ${usersTab==='users'?'active':''}" onclick="switchUsersTab('users')">${ic('users')} Users</div>
      <div class="tab ${usersTab==='roles'?'active':''}" onclick="switchUsersTab('roles')">${ic('shield')} Roles & Permissions</div>
    </div>
    <div id="usersBody"></div>`;
  await paintUsersTab();
}
function switchUsersTab(t) { usersTab = t; renderUsers(); }
async function paintUsersTab() {
  const host = document.getElementById('usersBody');
  if (usersTab === 'users') {
    const [rows, roleData, employees] = await Promise.all([api('/users'), api('/roles'), api('/employees')]);
    CACHE.users = rows; CACHE.roles = roleData.roles; CACHE.employees = employees;
    const pendingUsers = rows.filter((u) => String(u.status || 'Pending').toLowerCase() === 'pending');
    const pendingPanel = pendingUsers.length ? `
      <div class="panel" style="border-left:4px solid var(--amber);margin-bottom:14px;">
        <h3>⏳ Awaiting your approval <span class="badge badge-amber">${pendingUsers.length}</span></h3>
        <div class="muted" style="margin-bottom:10px;font-size:12.5px;">These people asked for an account in your company. Choose their role, then approve — or reject the request.</div>
        <div class="tbl-scroll"><table><thead><tr><th>Name</th><th>User ID</th><th>Email</th><th>Phone</th><th>Requested</th><th>Role to assign</th><th style="text-align:right;">Decision</th></tr></thead><tbody>
        ${pendingUsers.map((u) => `<tr><td>${u.full_name || ''}</td><td>${u.username}</td><td>${u.email || ''}</td><td>${u.phone || ''}</td><td>${fmtDate(u.created_at)}</td>
          <td><select id="pendRole_${u.id}">${(CACHE.roles || []).filter((r) => r.name !== 'ADMIN').map((r) => `<option ${r.name === u.role ? 'selected' : ''}>${r.name}</option>`).join('')}</select></td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="btn btn-sm btn-primary" onclick="approvePendingUser(${u.id})">Approve</button><button class="btn btn-sm btn-danger" onclick="rejectPendingUser(${u.id})">Reject</button></div></td></tr>`).join('')}
        </tbody></table></div>
      </div>` : '';
    host.innerHTML = pendingPanel + `<div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="openUserForm()">${ic('plus')} Add User</button></div>
      <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Username</th><th>Full Name</th><th>Mobile for OTP</th><th>Employee Link</th><th>Role</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.map((u) => { const active = Number(u.active ?? 1) === 1; const status = String(u.status || 'Pending'); const approved = status.toLowerCase() === 'approved'; return `<tr><td>${u.username}${u.reset_requested ? ' <span class="badge badge-amber" title="This user asked for a password reset">Reset requested</span>' : ''}</td><td>${u.full_name||''}</td>
        <td><div style="display:flex;gap:4px;align-items:center;"><input value="${u.phone||''}" placeholder="9876543210" style="width:125px;" onchange="changeUserPhone(${u.id},this.value)"><button class="btn btn-xs btn-outline" onclick="changeUserPhone(${u.id},this.previousElementSibling.value)">Save</button></div></td>
        <td><select onchange="changeUserEmployee(${u.id},this.value)"><option value="">(Not linked)</option>${(CACHE.employees||[]).map(e=>`<option value="${e.id}" ${Number(e.id)===Number(u.employee_id)?'selected':''}>${e.name}</option>`).join('')}</select></td>
        <td><select onchange="changeUserRole(${u.id},this.value)" ${u.role==='ADMIN'?'disabled':''}>${(CACHE.roles||[]).map((r) => `<option ${r.name===u.role?'selected':''}>${r.name}</option>`).join('')}</select></td>
        <td><span class="badge ${approved && active?'badge-green':(status.toLowerCase()==='pending'?'badge-amber':'badge-red')}">${approved && !active ? 'Approved — Inactive' : status}</span></td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          ${!approved ? `<button class="btn btn-sm btn-primary" onclick="setUserStatus(${u.id},'Approved')">Approve</button>` : ''}
          ${approved && !active ? `<button class="btn btn-sm btn-primary" onclick="setUserStatus(${u.id},'Approved')">Activate</button>` : ''}
          ${status.toLowerCase()!=='rejected' && u.role!=='ADMIN' ? `<button class="btn btn-sm btn-danger" onclick="setUserStatus(${u.id},'Rejected')">Reject</button>` : ''}
          <button class="btn btn-sm btn-outline" onclick="openResetPasswordForm(${u.id},'${u.username}')">Reset Password</button>
          ${u.role!=='ADMIN' && active ? `<button class="icon-btn del" title="Deactivate user" onclick="deleteUser(${u.id})">${ic('trash')}</button>` : ''}
        </div></td></tr>`; }).join('')}</tbody>
    </table></div></div>`;
  } else {
    const data = await api('/roles');
    CACHE.roles = data.roles; CACHE.moduleKeys = data.moduleKeys;
    host.innerHTML = `<div class="tbl-toolbar"><span></span><button class="btn btn-outline" onclick="openRoleForm()">${ic('plus')} Add Role</button></div>
      <div id="rolesCards"></div>`;
    document.getElementById('rolesCards').innerHTML = data.roles.map((r) => `
      <div class="panel" style="margin-bottom:14px;">
        <h3>${r.name} ${r.is_system ? '<span class="badge badge-blue">Built-in</span>' : '<span class="badge badge-amber">Custom</span>'} <span style="font-weight:400; color:var(--muted); font-size:12px;">— ${r.userCount} user(s)</span>
          ${!r.is_system && r.userCount === 0 ? `<button class="icon-btn del" style="float:right;" onclick="deleteRole('${r.name}')">${ic('trash')}</button>` : ''}
        </h3>
        ${r.name === 'ADMIN' ? `<p style="color:var(--muted); font-size:12.5px;">ADMIN always has full access to every module — this can't be restricted.</p>` : `
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px,1fr)); gap:8px;">
          ${MODULE_LABELS.filter(m => data.moduleKeys.includes(m.key)).map((m) => `
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; padding:6px 10px; border:1px solid var(--line); border-radius:8px; cursor:pointer;">
              <input type="checkbox" data-role="${r.name}" data-key="${m.key}" ${r.permissions[m.key] ? 'checked' : ''}> ${m.label}
            </label>`).join('')}
        </div>
        <div style="margin-top:12px;"><button class="btn btn-primary btn-sm" onclick="saveRolePermissions('${r.name}')">Save Permissions</button></div>`}
      </div>`).join('');
  }
}
function openRoleForm() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Add Role</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field full"><label>Role Name</label><input id="fld_role_name" placeholder="e.g. WAREHOUSE, SUPERVISOR"></div>
    </div><p style="font-size:12px; color:var(--muted); margin-top:8px;">New roles start with no access — check the modules it should see after creating it.</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveRole()">Create Role</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveRole() {
  try { await api('/roles', { method: 'POST', body: JSON.stringify({ name: fld('role_name') }) }); closeModal(); showToast('Role created'); renderUsers(); } catch (e) { showToast(e.message); }
}
async function deleteRole(name) {
  if (!confirm(`Delete the role "${name}"?`)) return;
  try { await api(`/roles/${name}`, { method: 'DELETE' }); showToast('Role deleted'); renderUsers(); } catch (e) { showToast(e.message); }
}
async function saveRolePermissions(name) {
  const checkboxes = document.querySelectorAll(`input[data-role="${name}"]`);
  const permissions = {};
  checkboxes.forEach((cb) => { permissions[cb.dataset.key] = cb.checked; });
  try {
    await api(`/roles/${name}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) });
    triggerSavedPopupIfPending();
    showToast(`Permissions saved for ${name}`);
    if (ME && ME.role === name) { const me = await api('/me'); ME = me; buildNavForRole(); renderNav(); }
  } catch (e) { showToast(e.message); }
}
const MODULE_LABELS = [
  { key: 'dashboard', label: 'Dashboard' }, { key: 'employeesPayroll', label: 'Employees & Payroll' },
  { key: 'inventory', label: 'Inventory & BOM' }, { key: 'purchasesModule', label: 'Purchases' },
  { key: 'productionModule', label: 'Production' }, { key: 'customersSales', label: 'Customers & Sales' },
  { key: 'outsourcing', label: 'Outsourcing' }, { key: 'accountingReports', label: 'Accounting & Reports' },
  { key: 'assets', label: 'Fixed Assets' }, { key: 'loans', label: 'Loans' }, { key: 'expenses', label: 'Expenses' },
  { key: 'reminders', label: 'SMS / WhatsApp' }, { key: 'auditBackup', label: 'Audit & Backup' },
  { key: 'users', label: 'Users & Roles' }, { key: 'settings', label: 'Settings' },
];
function openResetPasswordForm(id, username) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Reset Password — ${username}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field full"><label>New Password</label><input type="text" id="fld_new_password" placeholder="At least 4 characters"></div>
    </div><p style="font-size:12px; color:var(--muted); margin-top:8px;">Share this new password with ${username} directly — there's no automatic email or SMS.</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveResetPassword(${id})">Set New Password</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveResetPassword(id) {
  const password = fld('new_password');
  try { await api(`/users/${id}/reset-password`, { method: 'PUT', body: JSON.stringify({ password }) }); closeModal(); showToast('Password reset'); renderUsers(); } catch (e) { showToast(e.message); }
}
function openUserForm() {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>Add User</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Full Name</label><input id="fld_full_name"></div>
      <div class="form-field"><label>Username</label><input id="fld_username"></div>
      <div class="form-field"><label>Password</label><input type="password" id="fld_password" placeholder="Temporary password"></div>
      <div class="form-field"><label>Role</label><select id="fld_role">${(CACHE.roles||[{name:'MANAGER'},{name:'SALES'},{name:'ACCOUNTANT'},{name:'ADMIN'}]).map((r) => `<option>${r.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Mobile Number (for SMS OTP)</label><input id="fld_phone" placeholder="9876543210"></div>
      <div class="form-field full"><label>Link to Employee (required for salesperson/incentive attribution)</label><select id="fld_employee_id"><option value="">(Not linked)</option>${(CACHE.employees||[]).map((e)=>`<option value="${e.id}">${e.name}</option>`).join('')}</select></div>
    </div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveUser()">Create User</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function saveUser() {
  const data = { full_name: fld('full_name'), username: fld('username'), password: fld('password'), role: fld('role'), phone: fld('phone'), employee_id: fld('employee_id') ? Number(fld('employee_id')) : null };
  try { await api('/users', { method: 'POST', body: JSON.stringify(data) }); closeModal(); showToast('User created'); renderUsers(); } catch (e) { showToast(e.message); }
}
async function changeUserPhone(id, phone) { try { await api(`/users/${id}/phone`, { method:'PUT', body:JSON.stringify({phone}) }); showToast('User mobile number updated'); } catch(e) { showToast(e.message); } }
async function changeUserEmployee(id, employee_id) { try { await api(`/users/${id}/employee`, { method:'PUT', body:JSON.stringify({employee_id: employee_id ? Number(employee_id) : null}) }); showToast('Employee link updated'); } catch(e) { showToast(e.message); renderUsers(); } }
async function changeUserRole(id, role) { try { await api(`/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }); showToast('Role updated'); } catch (e) { showToast(e.message); renderUsers(); } }
async function refreshPendingBadge() { try { const m = await api('/me'); if (ME) { ME.pending_users = m.pending_users || 0; renderNav(); } } catch (e) { /* cosmetic */ } }
async function approvePendingUser(id) {
  const role = document.getElementById('pendRole_' + id)?.value;
  try {
    if (role) await api(`/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
    await api(`/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'Approved' }) });
    showToast('User approved with role ' + (role || '')); renderUsers(); refreshPendingBadge();
  } catch (e) { showToast(e.message); }
}
async function rejectPendingUser(id) {
  if (!confirm('Reject this account request?')) return;
  try { await api(`/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'Rejected' }) }); showToast('Request rejected'); renderUsers(); refreshPendingBadge(); }
  catch (e) { showToast(e.message); }
}
async function setUserStatus(id, status) { try { await api(`/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }); showToast('Status updated'); renderUsers(); } catch (e) { showToast(e.message); } }
async function deleteUser(id) { if (!confirm('Deactivate this user?')) return; try { await api(`/users/${id}`, { method: 'DELETE' }); showToast('User deactivated'); renderUsers(); } catch (e) { showToast(e.message); } }

// ---------------------------------------------------------------------------
// Company Settings — profile, logo upload, theme, return policy
// ---------------------------------------------------------------------------
let settingsTab = 'company';
async function renderSettings() {
  document.getElementById('content').innerHTML = setHeaderBanner('settings') + `
    <div class="tabs">
      <div class="tab ${settingsTab==='company'?'active':''}" onclick="switchSettingsTab('company')">${ic('settings')} Company Settings</div>
      <div class="tab ${settingsTab==='payments'?'active':''}" onclick="switchSettingsTab('payments')">${ic('wallet')} Bank, UPI &amp; Email</div>
      <div class="tab ${settingsTab==='sms'?'active':''}" onclick="switchSettingsTab('sms')">📱 SMS Gateway</div>
      <div class="tab ${settingsTab==='stages'?'active':''}" onclick="switchSettingsTab('stages')">${ic('gitBranch')} Job Work &amp; Pipeline Stages</div>
      <div class="tab ${settingsTab==='incentives'?'active':''}" onclick="switchSettingsTab('incentives')">🏆 Incentive &amp; Reward Rules</div>
      <div class="tab ${settingsTab==='importExport'?'active':''}" onclick="switchSettingsTab('importExport')">${ic('upload') || ic('download') || ic('backup')} Data Import / Export</div>
    </div>
    <div id="settingsBody"></div>`;
  paintSettingsTab();
}
function switchSettingsTab(t) { settingsTab = t; renderSettings(); }
async function paintSettingsTab() {
  const host = document.getElementById('settingsBody');
  if (settingsTab === 'company') {
    const co = await api('/settings');
    COMPANY = co;
    host.innerHTML = `
    <div class="panel" style="max-width:680px;">
      <h3>Branding</h3>
      <div class="form-grid">
        <div class="form-field full">
          <label>Company Logo (shown in the app sidebar and on your printed documents — the sign-in page keeps the SABIHA ERP package logo)</label>
          <div style="display:flex; align-items:center; gap:14px;">
            <div id="logoPreview" style="width:64px; height:64px; border-radius:12px; overflow:hidden; background:var(--paper); display:flex; align-items:center; justify-content:center; border:1px solid var(--line);">${co.logo_data_url ? `<img src="${co.logo_data_url}" style="width:100%;height:100%;object-fit:cover;">` : '🏭'}</div>
            <input type="file" id="fld_logo_file" accept="image/*" onchange="onLogoSelected(event)">
          </div>
        </div>
        <div class="form-field"><label>Company Name</label><input id="fld_company_name" value="${co.company_name||''}"></div>
        <div class="form-field"><label>GST No</label><input id="fld_gst_no" value="${co.gst_no||''}"></div>
        <div class="form-field full"><label>Address</label><input id="fld_address" value="${co.address||''}"></div>
        <div class="form-field"><label>Phone</label><input id="fld_phone" value="${co.phone||''}"></div>
        <div class="form-field"><label>Email</label><input id="fld_email" value="${co.email||''}"></div>
        <div class="form-field"><label>Invoice Prefix</label><input id="fld_invoice_prefix" value="${co.invoice_prefix||'INV-'}"></div>
        <div class="form-field"><label>Default Payment Terms (Days)</label><input type="number" id="fld_default_payment_terms" value="${co.default_payment_terms||30}"></div>
        <div class="form-field"><label>Corporate Tax Rate % (for Deferred Tax on Fixed Assets)</label><input type="number" id="fld_corporate_tax_rate_pct" value="${co.corporate_tax_rate_pct??25}"></div>
        <div class="form-field"><label>Financial Year Start</label><input type="date" id="fld_financial_year_start" value="${co.financial_year_start||''}"></div>
        <div class="form-field full"><label>Return & Exchange Policy (shown on printed invoices)</label><textarea id="fld_return_policy" rows="3">${co.return_policy||''}</textarea></div>
        <div class="form-field full"><label>Growth Vision &amp; Future Planning <span style="font-weight:400; color:var(--muted);">(shown on the last slide of the one-click investor presentation)</span></label><textarea id="fld_vision_statement" rows="4" placeholder="e.g. Our goal over the next 3 years is to...">${co.vision_statement||''}</textarea></div>
      </div>
      <div style="margin-top:8px;"><button class="btn btn-primary" onclick="saveSettings()">Save Settings</button></div>
    </div>`;
  } else if (settingsTab === 'payments') {
    const co = await api('/settings');
    COMPANY = co;
    const smtp = await api('/settings/smtp');
    host.innerHTML = `
    <div class="panel" style="max-width:680px;">
      <h3>Bank Account Details</h3>
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:10px;">Shown on printed and downloaded sales invoices, under "Payment Details", so customers know where to send a bank transfer.</p>
      <div class="form-grid">
        <div class="form-field"><label>Bank Name</label><input id="fld_bank_name" value="${co.bank_name||''}" placeholder="e.g. HDFC Bank"></div>
        <div class="form-field"><label>Account Number</label><input id="fld_bank_account_no" value="${co.bank_account_no||''}"></div>
        <div class="form-field"><label>IFSC Code</label><input id="fld_bank_ifsc" value="${co.bank_ifsc||''}"></div>
        <div class="form-field"><label>Branch</label><input id="fld_bank_branch" value="${co.bank_branch||''}"></div>
      </div>
      <div style="margin-top:8px;"><button class="btn btn-primary" onclick="saveBankDetails()">Save Bank Details</button></div>
    </div>
    <div class="panel" style="max-width:680px; margin-top:14px;">
      <h3>UPI</h3>
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:10px;">Enter your UPI ID and a scannable QR code is generated automatically on every invoice, pre-filled with that invoice's exact balance due — the customer just scans and pays. You can also upload your own static UPI QR image (from GPay/PhonePe/Paytm) as a fallback shown on the invoice alongside the UPI ID.</p>
      <div class="form-grid">
        <div class="form-field"><label>UPI ID (VPA)</label><input id="fld_upi_id" value="${co.upi_id||''}" placeholder="yourbusiness@okhdfcbank"></div>
        <div class="form-field">
          <label>Static UPI QR Image (optional)</label>
          <div style="display:flex; align-items:center; gap:14px;">
            <div id="upiQrPreview" style="width:64px; height:64px; border-radius:8px; overflow:hidden; background:var(--paper); display:flex; align-items:center; justify-content:center; border:1px solid var(--line);">${co.upi_qr_data_url ? `<img src="${co.upi_qr_data_url}" style="width:100%;height:100%;object-fit:contain;">` : ic('qrCode')}</div>
            <input type="file" id="fld_upi_qr_file" accept="image/*" onchange="onUpiQrSelected(event)">
            ${co.upi_qr_data_url ? `<button class="btn btn-outline btn-sm" onclick="removeUpiQr()">Remove</button>` : ''}
          </div>
        </div>
      </div>
      <div style="margin-top:8px;"><button class="btn btn-primary" onclick="saveUpiDetails()">Save UPI Details</button></div>
    </div>
    <div class="panel" style="max-width:680px; margin-top:14px;">
      <h3>Outgoing Email (for OTP &amp; notifications)</h3>
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:10px;">Used to send the verification code when a new user registers. If left blank, the verification code is shown directly on screen instead — registration still works without this configured.</p>
      <div class="form-grid">
        <div class="form-field"><label>SMTP Host</label><input id="fld_smtp_host" value="${smtp.smtp_host||''}" placeholder="smtp.gmail.com"></div>
        <div class="form-field"><label>SMTP Port</label><input type="number" id="fld_smtp_port" value="${smtp.smtp_port||587}"></div>
        <div class="form-field"><label>Username</label><input id="fld_smtp_user" value="${smtp.smtp_user||''}" placeholder="you@yourbusiness.com"></div>
        <div class="form-field"><label>Password</label><input type="password" id="fld_smtp_pass" placeholder="${smtp.smtp_configured ? '•••••••• (unchanged)' : ''}"></div>
        <div class="form-field"><label>"From" Address</label><input id="fld_smtp_from" value="${smtp.smtp_from||''}" placeholder="Defaults to Username"></div>
        <div class="form-field" style="display:flex; align-items:center;"><label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fld_smtp_secure" ${smtp.smtp_secure?'checked':''}> Use SSL/TLS (usually port 465)</label></div>
      </div>
      <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
        <button class="btn btn-primary" onclick="saveSmtpSettings()">Save Email Settings</button>
        <span style="font-size:12px; color:${smtp.smtp_configured?'var(--green)':'var(--muted)'};">${smtp.smtp_configured?'✓ Configured':'Not configured — codes shown on screen'}</span>
      </div>
    </div>
    <div class="panel" style="max-width:680px; margin-top:14px;">
      <h3>WhatsApp Business Cloud API — PDF Attachments</h3>
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:10px;">This is required for SABIHA ERP to send the actual Invoice/Payslip PDF as a WhatsApp document. The normal <code>wa.me</code> link can send text only and cannot attach a local PDF automatically. Configure your Meta WhatsApp Business Cloud API credentials below.</p>
      <div id="whatsappSettingsBox">Loading WhatsApp settings...</div>
    </div>`;
    paintWhatsAppSettings();
  } else if (settingsTab === 'sms') {
    const sms = await api('/settings/sms');
    host.innerHTML = `
    <div class="panel" style="max-width:760px;">
      <h3>SMS Gateway — Login OTP</h3>
      <p style="color:var(--muted);font-size:12.5px;margin-bottom:12px;">Configure the SMS provider used to send the 6-digit login OTP. This build uses the MSG91 Flow API. The API key is stored in the server <code>.env</code> file, not in database backups.</p>
      <div class="form-grid">
        <div class="form-field"><label>Provider</label><select id="fld_sms_provider"><option value="MSG91" ${sms.provider==='MSG91'?'selected':''}>MSG91</option></select></div>
        <div class="form-field"><label>Country Code</label><input id="fld_sms_country_code" value="${sms.country_code||'91'}" placeholder="91"></div>
        <div class="form-field full"><label>SMS API URL</label><input id="fld_sms_api_url" value="${sms.api_url||'https://control.msg91.com/api/v5/flow'}"></div>
        <div class="form-field"><label>MSG91 Auth Key</label><input type="password" id="fld_sms_auth_key" placeholder="${sms.auth_key_configured?'•••••••• (unchanged)':''}"></div>
        <div class="form-field"><label>Template ID</label><input id="fld_sms_template_id" value="${sms.template_id||''}" placeholder="MSG91 Flow template ID"></div>
        <div class="form-field"><label>Sender ID</label><input id="fld_sms_sender_id" value="${sms.sender_id||''}" placeholder="Optional"></div>
        <div class="form-field"><label>OTP Variable Name</label><input id="fld_sms_variable_name" value="${sms.variable_name||'VAR1'}" placeholder="VAR1"></div>
        <div class="form-field"><label>OTP Expiry (minutes)</label><input type="number" min="1" max="15" id="fld_sms_expiry" value="${sms.otp_expiry_minutes||5}"></div>
        <div class="form-field"><label>Resend Wait (seconds)</label><input type="number" min="20" max="300" id="fld_sms_resend" value="${sms.resend_seconds||30}"></div>
        <div class="form-field full"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="fld_sms_enabled" ${sms.enabled?'checked':''}> Require SMS OTP after correct password for every login</label></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="saveSmsSettings()">Save SMS Gateway Settings</button>
        <input id="fld_sms_test_phone" placeholder="Test mobile e.g. 9876543210" style="max-width:210px;">
        <button class="btn btn-outline" onclick="testSmsSettings()" ${sms.configured?'':'disabled'}>Send Test SMS</button>
        <span style="font-size:12px;color:${sms.configured?'var(--green)':'var(--muted)'};">${sms.configured?'✓ Gateway configured':'Not configured'}</span>
      </div>
      <div class="template-box" style="margin-top:14px;">
        <b>MSG91 template</b>
        <p style="color:var(--muted);font-size:12px;margin:6px 0 0;">Create/approve an SMS template in MSG91 with one variable matching the variable name above (default <code>VAR1</code>). SABIHA ERP passes the generated 6-digit OTP as that variable. MSG91's Flow API uses a template ID and authenticated JSON request for delivery.</p>
      </div>
    </div>`;
  } else if (settingsTab === 'stages') {
    const stages = await api('/pipeline-stages');
    CACHE.pipelineStages = stages; STAGES = stages.map((s) => s.name);
    host.innerHTML = `
    <div class="panel" style="max-width:680px;">
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:12px;">These are the stages a product moves through — used in Outsourcing (Job Work), and the Production Pipeline. Reorder with the arrows to match your real workflow. The default rate pre-fills the Rate field when creating a new outsourcing job for that stage.</p>
      <table><thead><tr><th></th><th>Stage Name</th><th>Default Rate (₹/unit)</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${stages.map((s, i) => `<tr>
          <td><div style="display:flex; flex-direction:column;">
            <button class="icon-btn" style="width:22px;height:18px;" ${i===0?'disabled':''} onclick="moveStage(${s.id},'up')">▲</button>
            <button class="icon-btn" style="width:22px;height:18px;" ${i===stages.length-1?'disabled':''} onclick="moveStage(${s.id},'down')">▼</button>
          </div></td>
          <td><input value="${s.name}" id="stageName_${s.id}" style="width:160px;"></td>
          <td><input type="number" value="${s.default_rate}" id="stageRate_${s.id}" style="width:110px;"></td>
          <td><div class="row-actions" style="justify-content:flex-end;">
            <button class="btn btn-sm btn-outline" onclick="saveStageConfig(${s.id})">Save</button>
            <button class="icon-btn del" onclick="deleteStageConfig(${s.id})">${ic('trash')}</button>
          </div></td>
        </tr>`).join('')}</tbody></table>
      <div style="display:flex; gap:10px; margin-top:14px; align-items:flex-end;">
        <div class="form-field"><label>New Stage Name</label><input id="newStageName" placeholder="e.g. Quality Check"></div>
        <div class="form-field"><label>Default Rate (₹/unit)</label><input type="number" id="newStageRate" value="0"></div>
        <button class="btn btn-primary" onclick="addStageConfig()">${ic('plus')} Add Stage</button>
      </div>
    </div>`;
  } else if (settingsTab === 'incentives') {
    const [rules, progress, tasks, taskEmployees, settings] = await Promise.all([api('/incentive-rules'), api('/incentive-progress'), api('/employee-tasks'), api('/employees'), api('/settings')]);
    const triggers = ['SALES','PRODUCTION','BIDDING','RECOVERY','OVERTIME','JOB_TASK'];
    host.innerHTML = `
      <div class="panel" style="max-width:900px;">
        <h3>Incentive &amp; Reward Rules</h3>
        <p style="color:var(--muted);font-size:12.5px;margin:6px 0 14px;">Configure one or more reward rules. Targets are taken from each employee's target fields. Rewards are unlocked once the monthly target is reached and are automatically included in the next payroll for that month.</p>
        <div class="template-box" style="margin-bottom:14px;"><b>Central Customer Loyalty Reward</b><p style="color:var(--muted);font-size:12px;margin:5px 0 10px;">Customer purchase thresholds remain configured per customer. The reward itself is controlled centrally here and applies to every eligible customer.</p><div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;"><div class="form-field"><label>Reward Type</label><select id="loyaltyRewardType"><option value="PERCENT">Percentage</option><option value="FIXED">Fixed Amount</option></select></div><div class="form-field"><label>Reward Value</label><input type="number" id="loyaltyRewardValue" min="0" step="0.01"></div><button class="btn btn-primary" onclick="saveCentralLoyalty()">Save Loyalty Setting</button></div></div>
        <div class="tbl-scroll"><table><thead><tr><th>Rule</th><th>Trigger</th><th>Reward Type</th><th>Value</th><th>Active</th><th></th></tr></thead>
        <tbody>${rules.map(r=>`<tr><td><input id="ir_name_${r.id}" value="${r.name}"></td><td><select id="ir_trigger_${r.id}">${triggers.map(t=>`<option ${t===r.trigger_type?'selected':''}>${t}</option>`).join('')}</select></td><td><select id="ir_type_${r.id}"><option ${r.reward_type==='FIXED'?'selected':''}>FIXED</option><option ${r.reward_type==='PERCENT'?'selected':''}>PERCENT</option></select></td><td><input type="number" id="ir_value_${r.id}" value="${r.reward_value}" style="width:90px;"></td><td><input type="checkbox" id="ir_active_${r.id}" ${r.active?'checked':''}></td><td><button class="btn btn-sm btn-outline" onclick="saveIncentiveRule(${r.id})">Save</button> <button class="icon-btn del" onclick="deleteIncentiveRule(${r.id})">${ic('trash')}</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">No rules yet.</td></tr>'}</tbody></table></div>
        <div class="template-box" style="margin-top:14px;">
          <b>Add Rule</b><div class="form-grid" style="margin-top:8px;">
            <div class="form-field"><label>Name</label><input id="newIrName" placeholder="e.g. Monthly Sales Achievement"></div>
            <div class="form-field"><label>Trigger</label><select id="newIrTrigger">${triggers.map(t=>`<option>${t}</option>`).join('')}</select></div>
            <div class="form-field"><label>Reward Type</label><select id="newIrType"><option>FIXED</option><option>PERCENT</option></select></div>
            <div class="form-field"><label>Reward Value</label><input type="number" id="newIrValue" value="0"></div>
          </div>
          <button class="btn btn-primary" onclick="addIncentiveRule()">Add Rule</button>
        </div>
      </div>
      <div class="panel" style="margin-top:14px;"><h3>Current Target Progress — ${progress.period}</h3><div class="tbl-scroll"><table><thead><tr><th>Employee</th><th>Trigger</th><th>Achieved</th><th>Target</th><th>Progress</th></tr></thead><tbody>${progress.rows.map(r=>`<tr><td>${r.employee_name}</td><td>${r.trigger_type}</td><td>${Number(r.achieved).toLocaleString('en-IN')}</td><td>${Number(r.target).toLocaleString('en-IN')}</td><td>${r.pct.toFixed(1)}%</td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">No employee targets configured.</td></tr>'}</tbody></table></div></div>
      <div class="panel" style="margin-top:14px;"><h3>Job / Task Allotment</h3>
        <div class="form-grid">
          <div class="form-field"><label>Employee</label><select id="newTaskEmployee">${taskEmployees.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}</select></div>
          <div class="form-field"><label>Task Title</label><input id="newTaskTitle" placeholder="e.g. Complete packing batch"></div>
          <div class="form-field"><label>Assigned Date</label><input type="date" id="newTaskDate" value="${todayISO()}"></div>
          <div class="form-field"><label>Due Date</label><input type="date" id="newTaskDue"></div>
        </div>
        <button class="btn btn-primary" onclick="addEmployeeTask()">Assign Task</button>
        <div class="tbl-scroll" style="margin-top:12px;"><table><thead><tr><th>Employee</th><th>Task</th><th>Assigned</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${tasks.map(t=>`<tr><td>${t.employee_name}</td><td>${t.title}</td><td>${fmtDate(t.assigned_date)}</td><td>${fmtDate(t.due_date)}</td><td>${t.status}</td><td>${t.status!=='Completed'?`<button class="btn btn-sm btn-outline" onclick="completeEmployeeTask(${t.id})">Complete</button>`:''}</td></tr>`).join('')||'<tr class="empty-row"><td colspan="6">No tasks assigned.</td></tr>'}</tbody></table></div>
      </div>`;
    const lrt = document.getElementById('loyaltyRewardType'); const lrv = document.getElementById('loyaltyRewardValue');
    if (lrt) lrt.value = settings.loyalty_reward_type || 'PERCENT';
    if (lrv) lrv.value = settings.loyalty_reward_value ?? 0;
  } else if (settingsTab === 'importExport') {
    const entities = await api('/import/entities');
    host.innerHTML = `
    <div class="panel" style="max-width:820px;">
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:14px;">Migrating from another system? For each type of data below: download the template, fill it in (without changing the column order), then upload it back here — the rows are added straight into that module, exactly as if entered by hand. Re-uploading the same file is safe: master data (Customers, Suppliers, etc.) skips any name that already exists rather than duplicating it.</p>
      <div id="importExportCards" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:8px;">
        ${entities.map((e) => `
        <div class="panel" style="margin:0; padding:8px;">
          <b style="display:block; margin-bottom:6px; font-size:12px;">${e.label}</b>
          <div style="display:flex; gap:5px;">
            <button class="btn btn-outline btn-xs" style="flex:1;" onclick="downloadImportTemplate('${e.key}','${e.label}')">${ic('download') || ic('print')} Template</button>
            <button class="btn btn-primary btn-xs" style="flex:1;" onclick="document.getElementById('importFile_${e.key}').click()">${ic('upload') || ic('plus')} Import</button>
          </div>
          <input type="file" id="importFile_${e.key}" accept=".xlsx,.xls" style="display:none;" onchange="onImportFileSelected('${e.key}')">
          <div id="importResult_${e.key}" style="font-size:10.5px; margin-top:6px;"></div>
        </div>`).join('')}
      </div>
    </div>`;
  }
}
async function saveCentralLoyalty() {
  const data = { loyalty_reward_type: document.getElementById('loyaltyRewardType').value, loyalty_reward_value: Number(document.getElementById('loyaltyRewardValue').value)||0 };
  try { COMPANY = await api('/settings', {method:'PUT', body:JSON.stringify(data)}); showToast('Central loyalty reward setting saved'); paintSettingsTab(); } catch(e) { showToast(e.message); }
}
async function addIncentiveRule() {
  const data={name:document.getElementById('newIrName').value.trim(),trigger_type:document.getElementById('newIrTrigger').value,reward_type:document.getElementById('newIrType').value,reward_value:Number(document.getElementById('newIrValue').value)||0};
  try{await api('/incentive-rules',{method:'POST',body:JSON.stringify(data)});showToast('Incentive rule added');paintSettingsTab();}catch(e){showToast(e.message);}
}
async function saveIncentiveRule(id) {
  const data={name:document.getElementById(`ir_name_${id}`).value.trim(),trigger_type:document.getElementById(`ir_trigger_${id}`).value,reward_type:document.getElementById(`ir_type_${id}`).value,reward_value:Number(document.getElementById(`ir_value_${id}`).value)||0,active:document.getElementById(`ir_active_${id}`).checked};
  try{await api(`/incentive-rules/${id}`,{method:'PUT',body:JSON.stringify(data)});showToast('Incentive rule updated');paintSettingsTab();}catch(e){showToast(e.message);}
}
async function deleteIncentiveRule(id){if(!confirm('Delete this incentive rule?'))return;try{await api(`/incentive-rules/${id}`,{method:'DELETE'});showToast('Rule deleted');paintSettingsTab();}catch(e){showToast(e.message);}}
async function addEmployeeTask() {
  const data={employee_id:Number(document.getElementById('newTaskEmployee').value),title:document.getElementById('newTaskTitle').value.trim(),assigned_date:document.getElementById('newTaskDate').value,due_date:document.getElementById('newTaskDue').value||null};
  if(!data.employee_id||!data.title){showToast('Employee and task title are required');return;}
  try{await api('/employee-tasks',{method:'POST',body:JSON.stringify(data)});showToast('Task assigned');paintSettingsTab();}catch(e){showToast(e.message);}
}
async function completeEmployeeTask(id) {
  try{const r=await api(`/employee-tasks/${id}/complete`,{method:'PUT',body:JSON.stringify({completed_date:todayISO()})});showToast('Task completed');if(r.unlocked?.length)showUnlockedIncentives(r.unlocked);paintSettingsTab();}catch(e){showToast(e.message);}
}
async function addStageConfig() {
  const name = document.getElementById('newStageName').value.trim();
  if (!name) { showToast('Enter a stage name'); return; }
  try {
    await api('/pipeline-stages', { method: 'POST', body: JSON.stringify({ name, default_rate: Number(document.getElementById('newStageRate').value) || 0 }) });
    triggerSavedPopupIfPending();
    showToast('Stage added'); paintSettingsTab();
  } catch (e) { showToast(e.message); }
}
async function saveStageConfig(id) {
  const name = document.getElementById(`stageName_${id}`).value.trim();
  const default_rate = Number(document.getElementById(`stageRate_${id}`).value) || 0;
  try { await api(`/pipeline-stages/${id}`, { method: 'PUT', body: JSON.stringify({ name, default_rate }) }); triggerSavedPopupIfPending(); showToast('Stage updated'); paintSettingsTab(); } catch (e) { showToast(e.message); }
}
async function moveStage(id, direction) {
  try { await api(`/pipeline-stages/${id}/move`, { method: 'PUT', body: JSON.stringify({ direction }) }); paintSettingsTab(); } catch (e) { showToast(e.message); }
}
async function deleteStageConfig(id) {
  if (!confirm('Delete this stage?')) return;
  try { await api(`/pipeline-stages/${id}`, { method: 'DELETE' }); showToast('Stage deleted'); paintSettingsTab(); } catch (e) { showToast(e.message); }
}
let pendingLogoDataUrl = null;
let pendingUpiQrDataUrl = null;
function onUpiQrSelected(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingUpiQrDataUrl = reader.result; document.getElementById('upiQrPreview').innerHTML = `<img src="${pendingUpiQrDataUrl}" style="width:100%;height:100%;object-fit:contain;">`; };
  reader.readAsDataURL(file);
}
async function removeUpiQr() {
  try { await api('/settings/upi-qr', { method: 'DELETE' }); showToast('UPI QR image removed'); paintSettingsTab(); } catch (e) { showToast(e.message); }
}
// Bank/UPI saves fetch the current full settings first and merge in just
// the changed fields, so required fields the backend expects on every
// write (company_name, address, ...) are always present.
async function saveBankDetails() {
  try {
    const current = await api('/settings');
    const data = { ...current, bank_name: fld('bank_name'), bank_account_no: fld('bank_account_no'), bank_ifsc: fld('bank_ifsc'), bank_branch: fld('bank_branch') };
    COMPANY = await api('/settings', { method: 'PUT', body: JSON.stringify(data) });
    triggerSavedPopupIfPending(); showToast('Bank details saved');
  } catch (e) { showToast(e.message); }
}
async function saveUpiDetails() {
  try {
    const current = await api('/settings');
    const data = { ...current, upi_id: fld('upi_id'), upi_qr_data_url: pendingUpiQrDataUrl };
    COMPANY = await api('/settings', { method: 'PUT', body: JSON.stringify(data) });
    pendingUpiQrDataUrl = null;
    triggerSavedPopupIfPending(); showToast('UPI details saved');
  } catch (e) { showToast(e.message); }
}
async function paintWhatsAppSettings() {
  const box = document.getElementById('whatsappSettingsBox');
  if (!box) return;
  try {
    const w = await api('/settings/whatsapp');
    box.innerHTML = `
      <div class="form-grid">
        <div class="form-field"><label>WhatsApp Phone Number ID</label><input id="fld_wa_phone_number_id" value="${w.phone_number_id||''}" placeholder="Meta Phone Number ID"></div>
        <div class="form-field"><label>Graph API Version</label><input id="fld_wa_graph_version" value="${w.graph_version||'v23.0'}" placeholder="v23.0"></div>
        <div class="form-field full"><label>Permanent/System User Access Token</label><input type="password" id="fld_wa_access_token" placeholder="${w.access_token_configured ? '•••••••• (unchanged — leave blank)' : 'Paste Meta WhatsApp Cloud API access token'}"></div>
      </div>
      <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
        <button class="btn btn-primary" onclick="saveWhatsAppSettings()">Save WhatsApp API Settings</button>
        ${w.configured ? '<button class="btn btn-outline" onclick="testWhatsAppSettings()">Test Connection</button>' : ''}
        <span style="font-size:12px; color:${w.configured?'var(--green)':'var(--muted)'};">${w.configured?'✓ Configured — PDF attachments enabled':'Not configured — PDF buttons will show a configuration error'}</span>
      </div>
      <div style="margin-top:10px; padding:10px; border-radius:8px; background:var(--paper); font-size:12px; color:var(--muted);">The access token is stored in the server's <code>.env</code> file, not in the database. The PDF is generated by SABIHA ERP, uploaded securely to Meta, and sent as a WhatsApp document.
      </div>`;
  } catch (e) { box.innerHTML = `<div class="error-banner">${String(e.message || 'Could not load WhatsApp settings').replace(/[<>]/g, '')}</div>`; }
}
async function testWhatsAppSettings() {
  try { const r = await api('/settings/whatsapp/test', { method: 'POST' }); showToast(r.message || 'WhatsApp connection successful'); }
  catch (e) { showToast(e.message || 'WhatsApp connection failed'); }
}

async function saveWhatsAppSettings() {
  const data = { phone_number_id: fld('wa_phone_number_id'), graph_version: fld('wa_graph_version') || 'v23.0' };
  const token = fld('wa_access_token');
  if (token) data.access_token = token;
  try {
    await api('/settings/whatsapp', { method: 'PUT', body: JSON.stringify(data) });
    showToast('WhatsApp Business API settings saved');
    paintWhatsAppSettings();
  } catch (e) { showToast(e.message); }
}

async function saveSmsSettings() {
  const data = { provider: fld('sms_provider') || 'MSG91', api_url: fld('sms_api_url'), template_id: fld('sms_template_id'), sender_id: fld('sms_sender_id'), country_code: fld('sms_country_code') || '91', variable_name: fld('sms_variable_name') || 'VAR1', otp_expiry_minutes: Number(fld('sms_expiry')) || 5, resend_seconds: Number(fld('sms_resend')) || 30, enabled: document.getElementById('fld_sms_enabled').checked };
  const key = fld('sms_auth_key'); if (key) data.auth_key = key;
  try { await api('/settings/sms', {method:'PUT', body:JSON.stringify(data)}); showToast('SMS Gateway settings saved'); paintSettingsTab(); } catch(e) { showToast(e.message); }
}
async function testSmsSettings() {
  const phone = fld('sms_test_phone');
  if (!phone) { showToast('Enter a test mobile number first'); return; }
  try { const r = await api('/settings/sms/test', {method:'POST',body:JSON.stringify({phone})}); showToast(r.message || 'Test SMS submitted'); } catch(e) { showToast(e.message); }
}

async function saveSmtpSettings() {
  const data = {
    smtp_host: fld('smtp_host'), smtp_port: Number(fld('smtp_port')) || 587, smtp_secure: document.getElementById('fld_smtp_secure').checked,
    smtp_user: fld('smtp_user'), smtp_from: fld('smtp_from'),
  };
  const pass = fld('smtp_pass');
  if (pass) data.smtp_pass = pass; // leave the stored password untouched if the field was left blank
  try { await api('/settings/smtp', { method: 'PUT', body: JSON.stringify(data) }); triggerSavedPopupIfPending(); showToast('Email settings saved'); paintSettingsTab(); } catch (e) { showToast(e.message); }
}
function onLogoSelected(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingLogoDataUrl = reader.result; document.getElementById('logoPreview').innerHTML = `<img src="${pendingLogoDataUrl}" style="width:100%;height:100%;object-fit:cover;">`; };
  reader.readAsDataURL(file);
}
async function saveSettings() {
  const data = {
    company_name: fld('company_name'), gst_no: fld('gst_no'), address: fld('address'), phone: fld('phone'), email: fld('email'),
    invoice_prefix: fld('invoice_prefix'), default_payment_terms: Number(fld('default_payment_terms')), financial_year_start: fld('financial_year_start'),
    return_policy: fld('return_policy'), theme_default: document.documentElement.getAttribute('data-theme'), logo_data_url: pendingLogoDataUrl,
    corporate_tax_rate_pct: Number(fld('corporate_tax_rate_pct')) || 25, vision_statement: fld('vision_statement'),
  };
  try { COMPANY = await api('/settings', { method: 'PUT', body: JSON.stringify(data) }); applyBranding(); pendingLogoDataUrl = null; triggerSavedPopupIfPending(); showToast('Settings saved'); } catch (e) { showToast(e.message); }
}

// ---------------------------------------------------------------------------
// Backup & Data
// ---------------------------------------------------------------------------
// Shown for consequential errors (backup/restore) where a passing toast
// isn't enough — the person explicitly needs to see and acknowledge what
// went wrong, not just glimpse it for 2 seconds.
function showErrorPopup(title, message) {
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><p style="font-size:14px; color:var(--coral);">${message}</p></div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="closeModal()">OK</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function downloadBackup() {
  try {
    const res = await fetch(API + '/backup', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Backup failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `sabiha-erp-backup-${todayISO()}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded');
  } catch (e) { showErrorPopup('Backup Failed', e.message); }
}

// ---------------------------------------------------------------------------
// Data Import / Export (Settings → Data Import / Export)
// ---------------------------------------------------------------------------
async function downloadImportTemplate(entityKey, label) {
  try {
    const res = await fetch(`${API}/import/template/${entityKey}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Could not generate template'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${entityKey}-import-template.xlsx`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { showErrorPopup('Template Download Failed', e.message); }
}
function onImportFileSelected(entityKey) {
  const input = document.getElementById(`importFile_${entityKey}`);
  const file = input.files[0];
  if (!file) return;
  const resultEl = document.getElementById(`importResult_${entityKey}`);
  resultEl.innerHTML = `<span style="color:var(--muted);">Importing "${file.name}"…</span>`;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const result = await api(`/import/${entityKey}`, { method: 'POST', body: JSON.stringify({ file_base64: reader.result }) });
      renderImportResult(entityKey, result);
      // Whatever module this data belongs to may already be cached (product
      // lists, customer dropdowns, etc.) — clear it so the newly-imported
      // rows show up immediately the next time that module is opened,
      // instead of the person seeing a stale list until they reload the app.
      CACHE.customers = null; CACHE.suppliers = null; CACHE.products = null; CACHE.rawMaterials = null; CACHE.employees = null;
      CACHE.purchases = null; CACHE.sales = null;
    } catch (e) {
      resultEl.innerHTML = `<span style="color:var(--coral);">${e.message}</span>`;
    }
    input.value = ''; // allow re-selecting the same file name after fixing it
  };
  reader.readAsDataURL(file);
}
function renderImportResult(entityKey, result) {
  const resultEl = document.getElementById(`importResult_${entityKey}`);
  const parts = [];
  if (result.created) parts.push(`<span style="color:var(--green);">${result.created} added</span>`);
  if (result.skipped) parts.push(`<span style="color:var(--muted);">${result.skipped} skipped (already existed)</span>`);
  if (!result.created && !result.skipped && !result.errors.length) parts.push('Nothing to import.');
  let html = parts.join(' · ');
  if (result.errors.length) {
    html += `<details style="margin-top:6px;"><summary style="color:var(--coral); cursor:pointer;">${result.errors.length} row${result.errors.length===1?'':'s'} had a problem</summary>
      <ul style="margin:6px 0 0 16px; padding:0; color:var(--coral);">${result.errors.slice(0, 20).map((e) => `<li>${e}</li>`).join('')}</ul>
      ${result.errors.length > 20 ? `<div style="color:var(--muted);">…and ${result.errors.length - 20} more</div>` : ''}
    </details>`;
  }
  resultEl.innerHTML = html;
  showToast(`Import finished — ${result.created} added${result.skipped ? `, ${result.skipped} skipped` : ''}${result.errors.length ? `, ${result.errors.length} had problems` : ''}`);
}
