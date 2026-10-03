// ============================================================================
// lib/subscription.js — plans, expiry, grace period, read-only mode, limits
//
//   state = ACTIVE     more than 15 days left, or no expiry date
//           EXPIRING   15 days or fewer left (banner at 15 / 7 / 1 days)
//           GRACE      expired, still inside the grace period (full access)
//           READONLY   grace period over: view + export only, nothing new
//   Nothing is ever deleted or suspended because a plan expired.
//
// A company WITHOUT a subscription row is a "legacy" company: unlimited and
// never expiring. Every company created or approved from v5.2 gets a plan.
// ============================================================================
const { platform, one, all, run, PlatformError, audit, getSetting } = require('./platformdb');
const mt = require('./multitenant');

// Modules a plan can switch on/off. The rest (dashboard, users, settings,
// audit & backup) are always available so a company can never lock itself out.
const GATED_MODULES = [
  ['employeesPayroll', 'Employees & Payroll'], ['inventory', 'Inventory & BOM'], ['purchasesModule', 'Purchases'],
  ['productionModule', 'Production'], ['customersSales', 'Customers & Sales'], ['outsourcing', 'Outsourcing'],
  ['accountingReports', 'Accounting & Reports'], ['expenses', 'Expenses'], ['assets', 'Fixed Assets'],
  ['loans', 'Loans'], ['reminders', 'SMS / WhatsApp'],
];
const GATED_KEYS = GATED_MODULES.map((m) => m[0]);
const LABELS = Object.fromEntries(GATED_MODULES);
const LIMIT_FIELDS = ['max_users', 'max_branches', 'max_invoices_month', 'max_storage_mb'];
const LIMIT_LABELS = { max_users: 'users', max_branches: 'branches', max_invoices_month: 'invoices this month', max_storage_mb: 'storage (MB)' };

// ---- dates (text YYYY-MM-DD, server-local "today") --------------------------
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function toUtc(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); }
function fromUtc(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(s, n) { return fromUtc(toUtc(s) + n * 86400000); }
function addMonths(s, n) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const first = Date.UTC(y, m - 1 + n, 1);
  const last = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 0)).getUTCDate();
  const dt = new Date(first); dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}
function diffDays(a, b) { return Math.round((toUtc(a) - toUtc(b)) / 86400000); } // a - b
function fmtD(s) { if (!s) return '—'; return new Date(toUtc(s)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(toUtc(s));

// ---- plans ---------------------------------------------------------------------
const planRow = (r) => r && ({
  code: r.code, name: r.name, sort_order: r.sort_order, price_monthly: Number(r.price_monthly), trial_days: r.trial_days,
  max_users: r.max_users, max_branches: r.max_branches, max_invoices_month: r.max_invoices_month, max_storage_mb: r.max_storage_mb,
  modules: r.modules, active: r.active, is_trial: r.trial_days != null,
});
function seedPlans() {
  if (Number(one(`SELECT COUNT(*) AS n FROM plans`).n) > 0) return;
  const core = ['employeesPayroll', 'inventory', 'purchasesModule', 'productionModule', 'customersSales', 'accountingReports', 'expenses', 'assets'];
  const std = [...core, 'outsourcing', 'loans'];
  const ins = (code, name, sort, price, trial, u, b, i, st, mods) => run(
    `INSERT INTO plans(code,name,sort_order,price_monthly,trial_days,max_users,max_branches,max_invoices_month,max_storage_mb,modules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [code, name, sort, price, trial, u, b, i, st, mods ? JSON.stringify(mods) : null]);
  ins('TRIAL', 'Trial', 1, 0, 14, 3, 1, 100, 200, core);
  ins('BASIC', 'Basic', 2, 999, null, 5, 1, 300, 500, core);
  ins('STANDARD', 'Standard', 3, 2499, null, 15, 3, 2000, 2048, std);
  ins('PREMIUM', 'Premium', 4, 4999, null, null, null, null, null, null);
}
seedPlans();
const listPlans = () => all(`SELECT * FROM plans ORDER BY sort_order, code`).map(planRow);
const getPlan = (code) => planRow(one(`SELECT * FROM plans WHERE code=$1`, [String(code || '').toUpperCase()]));

function savePlan(input, actor, ip) {
  const code = String(input.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new PlatformError('Plan code must be 2-20 letters, numbers, _ or -');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 40) throw new PlatformError('Enter a plan name.');
  const num = (v, label, allowNull = true) => {
    if (v === '' || v === null || v === undefined) { if (allowNull) return null; throw new PlatformError(`${label} is required.`); }
    const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new PlatformError(`${label} must be a positive number (or empty for unlimited).`);
    return Math.floor(n);
  };
  const price = Number(input.price_monthly || 0);
  if (!Number.isFinite(price) || price < 0) throw new PlatformError('Price must be 0 or more.');
  let modules = null;
  if (Array.isArray(input.modules)) modules = input.modules.filter((m) => GATED_KEYS.includes(m));
  const trial = input.trial_days === '' || input.trial_days === null || input.trial_days === undefined ? null : num(input.trial_days, 'Trial days');
  const vals = [code, name, num(input.sort_order, 'Order') ?? 99, price, trial, num(input.max_users, 'Users'), num(input.max_branches, 'Branches'), num(input.max_invoices_month, 'Invoices per month'), num(input.max_storage_mb, 'Storage'), modules ? JSON.stringify(modules) : null, input.active === undefined ? true : !!input.active];
  run(`INSERT INTO plans(code,name,sort_order,price_monthly,trial_days,max_users,max_branches,max_invoices_month,max_storage_mb,modules,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (code) DO UPDATE SET name=$2,sort_order=$3,price_monthly=$4,trial_days=$5,max_users=$6,max_branches=$7,max_invoices_month=$8,max_storage_mb=$9,modules=$10,active=$11`, vals);
  cache.clear();
  audit(actor, 'PLAN_SAVED', code, { name }, ip);
  return getPlan(code);
}
function deletePlan(code, actor, ip) {
  const c = String(code || '').toUpperCase();
  const used = Number(one(`SELECT COUNT(*) AS n FROM company_subscriptions WHERE plan_code=$1`, [c]).n);
  if (used) throw new PlatformError(`${used} company(ies) are on this plan. Move them to another plan first, or just mark the plan inactive.`, 409);
  run(`DELETE FROM plans WHERE code=$1`, [c]); audit(actor, 'PLAN_DELETED', c, {}, ip);
}

// ---- subscription rows ---------------------------------------------------------
const cache = new Map(); // company_id -> { at, row }
const usageCache = new Map();
function invalidate(companyId) { cache.delete(companyId); usageCache.delete(companyId); }
function getSubscription(companyId) {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < 15000) return hit.row;
  const row = one(`SELECT * FROM company_subscriptions WHERE company_id=$1`, [companyId]) || null;
  cache.set(companyId, { at: Date.now(), row });
  return row;
}
function upsertSubscription(companyId, f) {
  run(`INSERT INTO company_subscriptions(company_id,plan_code,starts_on,expires_on,grace_days,limit_action,contact_email,notes,overrides,reminders,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (company_id) DO UPDATE SET plan_code=$2,starts_on=$3,expires_on=$4,grace_days=$5,limit_action=$6,contact_email=$7,notes=$8,overrides=$9,reminders=$10,updated_at=now()`,
    [companyId, f.plan_code, f.starts_on, f.expires_on, f.grace_days, f.limit_action, f.contact_email, f.notes, JSON.stringify(f.overrides || {}), JSON.stringify(f.reminders || {})]);
  invalidate(companyId);
}
function defaultGrace() { const n = Number(getSetting('subscription', {}).grace_days); return Number.isFinite(n) && n >= 0 ? n : 7; }
function defaultLimitAction() { return getSetting('subscription', {}).limit_action === 'BLOCK' ? 'BLOCK' : 'WARN'; }

/** Begin a subscription for a new company (trial unless another plan is chosen). Returns the row or null. */
function startSubscription(company, { plan_code, days, months, no_expiry, contact_email, actor } = {}) {
  let plan = plan_code ? getPlan(plan_code) : null;
  if (plan_code && !plan) throw new PlatformError('Choose a valid plan.');
  if (!plan) plan = all(`SELECT * FROM plans WHERE trial_days IS NOT NULL AND active ORDER BY sort_order LIMIT 1`).map(planRow)[0] || null;
  if (!plan) return null;
  const today = todayStr();
  let expires = null;
  const d = days === '' || days === undefined || days === null ? null : Number(days);
  const m = months === '' || months === undefined || months === null ? null : Number(months);
  if (no_expiry) expires = null;
  else if (d && d > 0) expires = addDays(today, Math.min(Math.floor(d), 3650));
  else if (m && m > 0) expires = addMonths(today, Math.min(Math.floor(m), 120));
  else if (plan.trial_days) expires = addDays(today, plan.trial_days);
  else expires = addMonths(today, 12);
  upsertSubscription(company.id, { plan_code: plan.code, starts_on: today, expires_on: expires, grace_days: defaultGrace(), limit_action: defaultLimitAction(), contact_email: contact_email || null, notes: null, overrides: {}, reminders: {} });
  audit(actor, 'SUBSCRIPTION_STARTED', company.company_code, { plan: plan.code, expires_on: expires });
  return getSubscription(company.id);
}

const OVERRIDE_KEYS = [...LIMIT_FIELDS, 'modules'];
/** Edit the subscription of a company (plan, expiry, grace, limit action, overrides). */
function setSubscription(company, input, actor, ip) {
  const cur = getSubscription(company.id);
  const plan_code = String(input.plan_code || (cur && cur.plan_code) || '').toUpperCase();
  if (!getPlan(plan_code)) throw new PlatformError('Choose a valid plan.');
  let expires_on = cur ? cur.expires_on : null;
  if (input.expires_on !== undefined) {
    if (input.expires_on === null || input.expires_on === '') expires_on = null;
    else if (!isDate(input.expires_on)) throw new PlatformError('Enter the expiry date as YYYY-MM-DD.');
    else expires_on = String(input.expires_on).slice(0, 10);
  }
  let grace = cur ? cur.grace_days : defaultGrace();
  if (input.grace_days !== undefined && input.grace_days !== '') { grace = Math.floor(Number(input.grace_days)); if (!(grace >= 0 && grace <= 365)) throw new PlatformError('Grace period must be 0-365 days.'); }
  let action = cur ? cur.limit_action : defaultLimitAction();
  if (input.limit_action !== undefined) { action = String(input.limit_action).toUpperCase(); if (!['WARN', 'BLOCK'].includes(action)) throw new PlatformError('Limit action must be WARN or BLOCK.'); }
  let overrides = (cur && cur.overrides) || {};
  if (input.overrides !== undefined) {
    overrides = {};
    const src = input.overrides || {};
    for (const k of LIMIT_FIELDS) if (src[k] !== undefined && src[k] !== null && src[k] !== '') { const n = Number(src[k]); if (!Number.isFinite(n) || n < 0) throw new PlatformError(`Override for ${LIMIT_LABELS[k]} must be a positive number.`); overrides[k] = Math.floor(n); }
    if (Array.isArray(src.modules)) overrides.modules = src.modules.filter((m) => GATED_KEYS.includes(m));
  }
  const contact = input.contact_email === undefined ? (cur && cur.contact_email) : (String(input.contact_email || '').trim() || null);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new PlatformError('Enter a valid contact email.');
  const notes = input.notes === undefined ? (cur && cur.notes) : (String(input.notes || '').slice(0, 1000) || null);
  const expiryChanged = !cur || cur.expires_on !== expires_on;
  upsertSubscription(company.id, { plan_code, starts_on: cur ? cur.starts_on : todayStr(), expires_on, grace_days: grace, limit_action: action, contact_email: contact, notes, overrides, reminders: expiryChanged ? {} : (cur && cur.reminders) || {} });
  audit(actor, 'SUBSCRIPTION_UPDATED', company.company_code, { plan_code, expires_on, grace_days: grace, limit_action: action }, ip);
  return snapshot(company, { withUsage: false });
}

/** One-click renewal: extends from the later of today and the current expiry. */
function renew(company, { months, days, plan_code } = {}, actor, ip) {
  const cur = getSubscription(company.id);
  if (!cur) throw new PlatformError('This company has no plan yet. Assign a plan first.', 409);
  const plan = getPlan(plan_code || cur.plan_code);
  if (!plan) throw new PlatformError('Choose a valid plan.');
  const m = Number(months) || 0; const d = Number(days) || 0;
  if (!(m > 0 || d > 0)) throw new PlatformError('Choose how long to extend (months or days).');
  const today = todayStr();
  const base = cur.expires_on && cur.expires_on > today ? cur.expires_on : today;
  let next = base;
  if (m > 0) next = addMonths(next, Math.min(Math.floor(m), 120));
  if (d > 0) next = addDays(next, Math.min(Math.floor(d), 3650));
  upsertSubscription(company.id, { ...cur, plan_code: plan.code, expires_on: next, overrides: cur.overrides, reminders: {} });
  audit(actor, 'SUBSCRIPTION_RENEWED', company.company_code, { plan: plan.code, from: cur.expires_on, to: next }, ip);
  return snapshot(company, { withUsage: false });
}

// ---- usage + snapshot ----------------------------------------------------------
function usageFor(company) {
  const hit = usageCache.get(company.id);
  if (hit && Date.now() - hit.at < 20000) return hit.u;
  const p = mt.getTenantConnection(company);
  const monthStart = todayStr().slice(0, 8) + '01';
  const r = p.query(`SELECT
      (SELECT COUNT(*) FROM users WHERE COALESCE(active,1)=1 AND LOWER(COALESCE(status,'approved'))='approved') AS users,
      (SELECT COUNT(*) FROM branches WHERE active=1) AS branches,
      (SELECT COUNT(*) FROM sales_invoices WHERE invoice_date >= $1) AS invoices_month`, [monthStart], false).rows[0];
  const size = one(`SELECT pg_database_size($1) AS b`, [company.database_name]);
  const u = { users: Number(r.users), branches: Number(r.branches), invoices_month: Number(r.invoices_month), storage_mb: Math.round((Number(size && size.b) || 0) / 1048576 * 10) / 10 };
  usageCache.set(company.id, { at: Date.now(), u });
  return u;
}

function stateOf(expires_on, grace) {
  if (!expires_on) return { state: 'ACTIVE', days_left: null, grace_ends_on: null };
  const left = diffDays(expires_on, todayStr());
  const graceEnds = addDays(expires_on, grace);
  let state = 'ACTIVE';
  if (left < 0) state = -left <= grace ? 'GRACE' : 'READONLY';
  else if (left <= 15) state = 'EXPIRING';
  return { state, days_left: left, grace_ends_on: graceEnds };
}

function contactInfo() { const c = getSetting('contact', {}); return { name: c.name || '', email: c.email || '', phone: c.phone || '' }; }
function contactText() { const c = contactInfo(); const bits = [c.email, c.phone].filter(Boolean); return bits.length ? ` Contact ${c.name || 'us'} at ${bits.join(' / ')}.` : ' Please contact the platform owner.'; }

function snapshot(company, { withUsage = true } = {}) {
  const row = getSubscription(company.id);
  if (!row) return { legacy: true, plan_code: null, plan_name: 'No plan (unlimited)', is_trial: false, state: 'ACTIVE', days_left: null, expires_on: null, starts_on: null, grace_days: 0, grace_ends_on: null, read_only: false, limit_action: 'WARN', limits: {}, usage: null, modules: null, warnings: [], notice: null, contact: contactInfo() };
  const plan = getPlan(row.plan_code) || { code: row.plan_code, name: row.plan_code, is_trial: false };
  const ov = row.overrides || {};
  const limits = {};
  for (const k of LIMIT_FIELDS) limits[k] = ov[k] !== undefined ? ov[k] : (plan[k] ?? null);
  const modules = Array.isArray(ov.modules) ? ov.modules : (Array.isArray(plan.modules) ? plan.modules : null);
  const st = stateOf(row.expires_on, row.grace_days);
  const snap = {
    legacy: false, plan_code: plan.code, plan_name: plan.name, is_trial: !!plan.is_trial, state: st.state, days_left: st.days_left,
    expires_on: row.expires_on, starts_on: row.starts_on, grace_days: row.grace_days, grace_ends_on: st.grace_ends_on,
    read_only: st.state === 'READONLY', limit_action: row.limit_action, limits, usage: null, modules, warnings: [], notice: null, contact: contactInfo(),
  };
  snap.notice = noticeFor(snap);
  if (withUsage) {
    try {
      snap.usage = usageFor(company);
      const map = [['max_users', 'users'], ['max_branches', 'branches'], ['max_invoices_month', 'invoices_month'], ['max_storage_mb', 'storage_mb']];
      for (const [lk, uk] of map) {
        const lim = limits[lk]; if (lim == null) continue;
        const used = snap.usage[uk];
        if (used >= lim) snap.warnings.push({ level: used > lim || row.limit_action === 'BLOCK' ? 'danger' : 'warning', code: lk, text: `${used > lim ? 'Over' : 'At'} your plan limit for ${LIMIT_LABELS[lk]}: ${used} of ${lim} used.${row.limit_action === 'BLOCK' ? ' New entries of this kind are blocked until you upgrade.' : ' Please upgrade your plan.'}` });
      }
    } catch (_) { /* usage is informational */ }
  }
  return snap;
}

function noticeFor(s) {
  if (s.legacy) return null;
  const what = s.is_trial ? 'trial' : `${s.plan_name} plan`;
  if (s.state === 'EXPIRING') {
    const d = s.days_left;
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days (${fmtD(s.expires_on)})`;
    return { level: d <= 1 ? 'danger' : d <= 7 ? 'warning' : 'info', code: 'EXPIRING', text: `Your ${what} ${s.is_trial ? 'ends' : 'expires'} ${when}.${contactText()}` };
  }
  if (s.state === 'GRACE') {
    const left = s.grace_days + s.days_left;
    return { level: 'danger', code: 'GRACE', text: `Your ${what} expired on ${fmtD(s.expires_on)}. You have ${left} day${left === 1 ? '' : 's'} left before the account becomes read-only.${contactText()}` };
  }
  if (s.state === 'READONLY') return { level: 'danger', code: 'READONLY', text: `Your ${what} expired on ${fmtD(s.expires_on)}. The account is read-only: you can sign in, view and export your data, but cannot add or change entries.${contactText()}` };
  return null;
}

// ---- enforcement helpers used by auth.js / routes ----------------------------------
const ALWAYS_ON = ['dashboard', 'users', 'settings', 'auditBackup'];
function moduleAllowed(snap, key) {
  if (!snap || snap.legacy || !snap.modules || !GATED_KEYS.includes(key)) return true;
  return snap.modules.includes(key);
}
/** Modules the user could normally open but this company's plan does not include (shown with a lock, with the reason on click). */
function lockedModules(snap, rawPerms) {
  if (!snap || snap.legacy || !Array.isArray(snap.modules)) return [];
  return GATED_MODULES.filter(([k]) => !snap.modules.includes(k) && (!rawPerms || rawPerms[k])).map(([key, label]) => ({ key, label }));
}
/** Hide modules the plan does not include from a permissions object. */
function maskPermissions(snap, perms) {
  if (!snap || snap.legacy || !snap.modules) return perms;
  const out = { ...perms };
  for (const k of GATED_KEYS) if (!snap.modules.includes(k)) out[k] = false;
  return out;
}
/** Requests a read-only company may still make (export, PDF, password change, reads done by POST). */
const READONLY_ALLOWED = /^\/(me|auth\/change-password|auth\/verify-admin-password|subscription)(\/|$)|\/(pdf|export|download)(\/|$|\?)|^\/reports(\/|$)/;
function readOnlyBlocks(snap, req) {
  if (!snap || !snap.read_only) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  return !READONLY_ALLOWED.test(req.path);
}
function readOnlyError(snap) {
  return { error: `This account is read-only because the plan expired on ${fmtD(snap.expires_on)}. You can view and export your data, but cannot add or change entries.${contactText()}`, read_only: true, subscription_state: snap.state };
}
function moduleError(snap, key) {
  return { error: `${LABELS[key] || key} is not included in your ${snap.plan_name} plan.${contactText()}`, plan_module: true, module_key: key, module_label: LABELS[key] || key };
}

/** Express middleware: block (or just flag) creating more users / branches / invoices than the plan allows. */
function checkLimit(kind) {
  const spec = { users: [['max_users', 'users', 'users']], branches: [['max_branches', 'branches', 'branches']], invoices: [['max_invoices_month', 'invoices_month', 'invoices this month'], ['max_storage_mb', 'storage_mb', 'storage (MB)']] }[kind];
  return (req, res, next) => {
    try {
      const company = req.company; if (!company) return next();
      const snap = snapshot(company);
      if (snap.legacy || !snap.usage) return next();
      for (const [lk, uk, label] of spec) {
        const lim = snap.limits[lk]; if (lim == null) continue;
        const used = snap.usage[uk];
        if (used >= lim) {
          const msg = `Your ${snap.plan_name} plan allows ${lim} ${label} and ${used} ${used === 1 ? 'is' : 'are'} already used.${contactText()}`;
          if (snap.limit_action === 'BLOCK') return res.status(403).json({ error: msg, plan_limit: true, limit: lk });
          res.setHeader('X-Plan-Warning', encodeURIComponent(msg));
        }
      }
      res.on('finish', () => { if (res.statusCode < 400) usageCache.delete(company.id); });
    } catch (e) { console.error('[subscription] limit check failed:', e.message); }
    next();
  };
}

// ---- scheduler support ---------------------------------------------------------------
const THRESHOLDS = ['d15', 'd7', 'd1', 'expired', 'readonly'];
/** Which reminder (if any) is due for a subscription right now. Marks all earlier ones as sent. */
function nextReminder(row) {
  if (!row || !row.expires_on) return null;
  const left = diffDays(row.expires_on, todayStr());
  const active = [];
  if (left <= 15 && left >= 0) active.push('d15');
  if (left <= 7 && left >= 0) active.push('d7');
  if (left <= 1 && left >= 0) active.push('d1');
  if (left < 0) active.push('expired');
  if (left < 0 && -left > row.grace_days) active.push('readonly');
  const rem = row.reminders && row.reminders.for === row.expires_on ? row.reminders : { for: row.expires_on, sent: [] };
  const due = active.filter((k) => !rem.sent.includes(k));
  if (!due.length) return null;
  return { key: due[due.length - 1], mark: [...rem.sent, ...due], for: row.expires_on, days_left: left };
}
function markReminder(companyId, r) {
  run(`UPDATE company_subscriptions SET reminders=$2 WHERE company_id=$1`, [companyId, JSON.stringify({ for: r.for, sent: r.mark })]);
  invalidate(companyId);
}

module.exports = {
  GATED_MODULES, GATED_KEYS, LIMIT_FIELDS, LIMIT_LABELS, ALWAYS_ON,
  todayStr, addDays, addMonths, diffDays, fmtD, isDate,
  listPlans, getPlan, savePlan, deletePlan,
  getSubscription, startSubscription, setSubscription, renew, snapshot, invalidate,
  moduleAllowed, lockedModules, maskPermissions, readOnlyBlocks, readOnlyError, moduleError, checkLimit, contactText,
  nextReminder, markReminder, THRESHOLDS, stateOf,
};
