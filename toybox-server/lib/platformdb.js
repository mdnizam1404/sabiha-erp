// ============================================================================
// lib/platformdb.js — platform database helpers shared by every platform module
//   * query helpers (one / all / run), PlatformError, audit log
//   * encryption for stored secrets (SMTP password, 2-step secrets)
//   * the platform table definitions + self-healing schema
//   * key/value platform settings
// Dates that are compared by the code (expiry, due dates…) are stored as TEXT
// 'YYYY-MM-DD' so there is never a time-zone surprise.
// ============================================================================
const crypto = require('crypto');
const mt = require('./multitenant');

const { platform } = mt;
const SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

const one = (sql, params = []) => platform.query(sql, params, false).rows[0];
const all = (sql, params = []) => platform.query(sql, params, false).rows;
const run = (sql, params = []) => platform.query(sql, params, false);

class PlatformError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
function audit(actor, action, target, details, ip) {
  try { run(`INSERT INTO platform_audit_logs(actor,action,target,details,ip) VALUES($1,$2,$3,$4,$5)`, [actor || 'system', action, target || null, JSON.stringify(details || {}), ip || null]); } catch (_) { /* never block on audit */ }
}

// ---- secrets at rest ------------------------------------------------------
const KEY = crypto.createHash('sha256').update('platform-secrets:' + SECRET).digest();
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  if (!blob || !String(blob).startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return null; } // JWT_SECRET changed — the stored secret is unreadable
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- validation helpers ---------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- tables ----------------------------------------------------------------
// cols  : columns the code relies on. A table that exists WITHOUT one of them is
//         renamed aside (data kept) and recreated — unless the missing column is
//         listed in `alter`, in which case it is simply added in place.
// alter : columns added in later releases (safe ALTER … ADD COLUMN IF NOT EXISTS).
const PLATFORM_TABLES = [
  { name: 'platform_admins',
    cols: ['id', 'username', 'password_hash', 'full_name', 'email', 'active', 'must_change_password', 'created_at', 'last_login_at'],
    alter: [`role TEXT NOT NULL DEFAULT 'OWNER'`, `totp_secret TEXT`, `totp_enabled BOOLEAN NOT NULL DEFAULT false`, `recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb`],
    ddl: `CREATE TABLE platform_admins (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, full_name TEXT, email TEXT,
      active BOOLEAN NOT NULL DEFAULT true, must_change_password BOOLEAN NOT NULL DEFAULT false,
      role TEXT NOT NULL DEFAULT 'OWNER', totp_secret TEXT, totp_enabled BOOLEAN NOT NULL DEFAULT false, recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login_at TIMESTAMPTZ)` },
  { name: 'platform_login_attempts',
    cols: ['username', 'attempts', 'locked_until', 'last_attempt_at'],
    ddl: `CREATE TABLE platform_login_attempts (username TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'company_requests',
    cols: ['id', 'reference', 'company_name', 'requested_code', 'contact_name', 'email', 'phone', 'city', 'notes', 'admin_username', 'admin_password_hash', 'status', 'review_note', 'assigned_code', 'request_ip', 'created_at', 'reviewed_at', 'reviewed_by'],
    ddl: `CREATE TABLE company_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL, requested_code TEXT,
      contact_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, city TEXT, notes TEXT, admin_username TEXT NOT NULL, admin_password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')), review_note TEXT, assigned_code TEXT, request_ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT)`,
    after: [`CREATE INDEX IF NOT EXISTS idx_company_requests_status ON company_requests(status, created_at DESC)`] },
  { name: 'platform_audit_logs',
    cols: ['id', 'actor', 'action', 'target', 'details', 'ip', 'created_at'],
    ddl: `CREATE TABLE platform_audit_logs (id BIGSERIAL PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT, details JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` },

  // ---- v5.2 ---------------------------------------------------------------
  { name: 'platform_settings', cols: ['key', 'value', 'updated_at'],
    ddl: `CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'plans', cols: ['code', 'name', 'sort_order', 'price_monthly', 'trial_days', 'max_users', 'max_branches', 'max_invoices_month', 'max_storage_mb', 'modules', 'active'],
    ddl: `CREATE TABLE plans (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, price_monthly NUMERIC(12,2) NOT NULL DEFAULT 0,
      trial_days INTEGER, max_users INTEGER, max_branches INTEGER, max_invoices_month INTEGER, max_storage_mb INTEGER,
      modules JSONB, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'company_subscriptions', cols: ['company_id', 'plan_code', 'starts_on', 'expires_on', 'grace_days', 'limit_action', 'contact_email', 'notes', 'overrides', 'reminders', 'updated_at'],
    ddl: `CREATE TABLE company_subscriptions (
      company_id UUID PRIMARY KEY, plan_code TEXT NOT NULL, starts_on TEXT NOT NULL, expires_on TEXT, grace_days INTEGER NOT NULL DEFAULT 7,
      limit_action TEXT NOT NULL DEFAULT 'WARN', contact_email TEXT, notes TEXT, overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
      reminders JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'company_backups', cols: ['id', 'company_id', 'company_code', 'kind', 'file_name', 'size_bytes', 'table_count', 'row_count', 'note', 'created_by', 'created_at'],
    ddl: `CREATE TABLE company_backups (
      id SERIAL PRIMARY KEY, company_id UUID NOT NULL, company_code TEXT NOT NULL, kind TEXT NOT NULL, file_name TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0, table_count INTEGER NOT NULL DEFAULT 0, row_count BIGINT NOT NULL DEFAULT 0, note TEXT, created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    after: [`CREATE INDEX IF NOT EXISTS idx_company_backups_code ON company_backups(company_code, created_at DESC)`] },
  { name: 'announcements', cols: ['id', 'title', 'body', 'severity', 'starts_at', 'ends_at', 'active', 'created_by', 'created_at'],
    ddl: `CREATE TABLE announcements (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','danger')),
      starts_at TIMESTAMPTZ NOT NULL DEFAULT now(), ends_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'billing_records', cols: ['id', 'company_code', 'plan_code', 'description', 'amount', 'issued_on', 'due_on', 'paid_on', 'status', 'method', 'reference', 'period_label', 'created_by', 'created_at'],
    ddl: `CREATE TABLE billing_records (
      id SERIAL PRIMARY KEY, company_code TEXT NOT NULL, plan_code TEXT, description TEXT NOT NULL DEFAULT '', amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      issued_on TEXT NOT NULL, due_on TEXT, paid_on TEXT, status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','VOID')),
      method TEXT, reference TEXT, period_label TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    after: [`CREATE INDEX IF NOT EXISTS idx_billing_company ON billing_records(company_code, issued_on DESC)`] },
  { name: 'company_login_history', cols: ['id', 'company_code', 'username', 'success', 'reason', 'ip', 'user_agent', 'created_at'],
    ddl: `CREATE TABLE company_login_history (
      id BIGSERIAL PRIMARY KEY, company_code TEXT NOT NULL, username TEXT, success BOOLEAN NOT NULL, reason TEXT, ip TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    after: [`CREATE INDEX IF NOT EXISTS idx_login_hist_company ON company_login_history(company_code, created_at DESC)`] },
  { name: 'company_branding', cols: ['company_id', 'display_name', 'tagline', 'primary_color', 'logo_data_url', 'updated_at'],
    ddl: `CREATE TABLE company_branding (company_id UUID PRIMARY KEY, display_name TEXT, tagline TEXT, primary_color TEXT, logo_data_url TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
  { name: 'plan_requests', cols: ['id', 'company_code', 'company_name', 'kind', 'plan_code', 'months', 'note', 'status', 'requested_by', 'contact_email', 'created_at', 'reviewed_at', 'reviewed_by', 'review_note'],
    ddl: `CREATE TABLE plan_requests (
      id SERIAL PRIMARY KEY, company_code TEXT NOT NULL, company_name TEXT, kind TEXT NOT NULL CHECK (kind IN ('PURCHASE','RENEW','UPGRADE')), plan_code TEXT NOT NULL,
      months INTEGER NOT NULL DEFAULT 12, note TEXT, status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      requested_by TEXT, contact_email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT, review_note TEXT)`,
    after: [`CREATE INDEX IF NOT EXISTS idx_plan_requests_status ON plan_requests(status, created_at DESC)`] },
  { name: 'email_log', cols: ['id', 'to_email', 'template', 'subject', 'status', 'error', 'created_at'],
    ddl: `CREATE TABLE email_log (id BIGSERIAL PRIMARY KEY, to_email TEXT, template TEXT, subject TEXT, status TEXT NOT NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
];

function ensurePlatformSchema() {
  // companies.status gained ARCHIVED in v5.2 — widen the CHECK constraint on existing installs
  try {
    platform.exec(`ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_status_check`);
    platform.exec(`ALTER TABLE companies ADD CONSTRAINT companies_status_check CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','FAILED','ARCHIVED'))`);
  } catch (e) { console.warn('[platform] could not widen companies.status check:', e.message); }

  for (const t of PLATFORM_TABLES) {
    try {
      const have = all(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [t.name]).map((r) => r.column_name);
      if (have.length) {
        const missing = t.cols.filter((c) => !have.includes(c));
        if (missing.length) {
          const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
          const legacy = `${t.name}_legacy_${stamp}`;
          for (const ix of all(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname NOT LIKE '%_pkey'`, [t.name])) {
            platform.exec(`ALTER INDEX "${ix.indexname}" RENAME TO "${ix.indexname}_legacy_${stamp}"`);
          }
          platform.exec(`ALTER TABLE ${t.name} RENAME TO ${legacy}`);
          console.warn(`[platform] Existing table "${t.name}" had a different layout (missing: ${missing.join(', ')}). It was renamed to "${legacy}" (data kept) and a new one was created.`);
        }
      }
      platform.exec(t.ddl.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
      for (const col of t.alter || []) platform.exec(`ALTER TABLE ${t.name} ADD COLUMN IF NOT EXISTS ${col}`);
      for (const stmt of t.after || []) platform.exec(stmt);
    } catch (e) {
      console.error(`\n[DATABASE] Could not prepare the platform table "${t.name}" in database "${mt.platformName}": ${e.message}`);
      console.error('Fix or drop that table in PostgreSQL (or set PLATFORM_DATABASE in .env to a new, empty database name) and start again.\n');
      process.exit(1);
    }
  }
}
ensurePlatformSchema();

// ---- key/value settings -----------------------------------------------------
function getSetting(key, fallback = {}) {
  const r = one(`SELECT value FROM platform_settings WHERE key=$1`, [key]);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  run(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, JSON.stringify(value)]);
}

module.exports = { platform, one, all, run, PlatformError, audit, encrypt, decrypt, sha, EMAIL_RE, DATE_RE, getSetting, setSetting, SECRET };
