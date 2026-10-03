// Multi-company PostgreSQL tenancy for SABIHA ERP v13.
// One platform database stores company registry; every company gets its own
// PostgreSQL database. Existing ERP routes keep using db.prepare(...).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createSyncPg, pgConfigFromEnv, describeConfig } = require('./pgsync');
const { runWithTenant } = require('../db');

const baseCfg = pgConfigFromEnv();
const platformName = String(process.env.PLATFORM_DATABASE || 'sabiha_platform').trim();
const defaultCompanyCode = String(process.env.DEFAULT_COMPANY_CODE || 'DEFAULT').trim().toUpperCase();
const defaultCompanyName = String(process.env.DEFAULT_COMPANY_NAME || process.env.COMPANY_NAME || 'SABIHA ERP').trim();
const rootDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const tenantCache = new Map();
const MAX_TENANT_CONNECTIONS = Math.max(10, Number(process.env.MAX_TENANT_CONNECTIONS || 50));

function dbNameForCode(code) {
  const safe = String(code || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'company';
  return `sabiha_${safe}_${crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 8)}`;
}

function cfgForDatabase(database, autoCreate = true) {
  const c = { ...baseCfg.client };
  // DATABASE_URL can be used for the platform only when it points at the same
  // database; for tenant DBs we need to replace the database path.
  if (c.connectionString) {
    try {
      const u = new URL(c.connectionString);
      u.pathname = '/' + encodeURIComponent(database);
      c.connectionString = u.toString();
    } catch (_) { delete c.connectionString; c.database = database; }
  } else c.database = database;
  return { client: c, autoCreate };
}

const platform = createSyncPg(cfgForDatabase(platformName, true));
platform.connect();
platform.exec(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
platform.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_code TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  database_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PROVISIONING' CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','FAILED','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  provisioning_error TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
`);

function platformOne(sql, params = []) { return platform.query(sql, params, false).rows[0]; }
function platformAll(sql, params = []) { return platform.query(sql, params, false).rows; }

function ensureTenantSchemaExtras(pg) {
  try { pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TEXT`); } catch (_) { /* users table not created yet */ }
  try { pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* users table not created yet */ }
  pg.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id BIGSERIAL PRIMARY KEY,
  branch_code TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  branch_type TEXT NOT NULL DEFAULT 'HEAD_OFFICE' CHECK (branch_type IN ('HEAD_OFFICE','FACTORY','BRANCH','WAREHOUSE','DEPOT')),
  address TEXT, phone TEXT, gst_no TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE stock_txn ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE production ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS client_uuid UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_invoices_client_uuid ON sales_invoices(client_uuid) WHERE client_uuid IS NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS client_uuid UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_client_uuid ON customers(client_uuid) WHERE client_uuid IS NOT NULL;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS client_uuid UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_receipts_client_uuid ON receipts(client_uuid) WHERE client_uuid IS NOT NULL;

-- ---- v5.4: customer returns (credit notes) and supplier returns (debit notes) ----
CREATE TABLE IF NOT EXISTS sales_returns (
  id SERIAL PRIMARY KEY, return_no TEXT UNIQUE NOT NULL, return_date TEXT NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
  reason TEXT, remarks TEXT, gst_pct DOUBLE PRECISION NOT NULL DEFAULT 0, gst_type TEXT DEFAULT 'CGST_SGST',
  subtotal DOUBLE PRECISION NOT NULL DEFAULT 0, gst_amt DOUBLE PRECISION NOT NULL DEFAULT 0, grand_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  refund_amount DOUBLE PRECISION NOT NULL DEFAULT 0, refund_mode TEXT, refund_reference TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Accepted','Rejected')),
  created_by INTEGER, created_by_name TEXT, created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  decided_by INTEGER, decided_by_name TEXT, decided_at TEXT, decision_note TEXT, branch_id BIGINT
);
CREATE TABLE IF NOT EXISTS sales_return_items (
  id SERIAL PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty DOUBLE PRECISION NOT NULL, rate DOUBLE PRECISION NOT NULL,
  discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0, amount DOUBLE PRECISION NOT NULL DEFAULT 0, restock INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS purchase_returns (
  id SERIAL PRIMARY KEY, return_no TEXT UNIQUE NOT NULL, return_date TEXT NOT NULL,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id), supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  item_type TEXT, raw_material_id INTEGER, product_id INTEGER,
  qty DOUBLE PRECISION NOT NULL, rate DOUBLE PRECISION NOT NULL, amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_pct DOUBLE PRECISION NOT NULL DEFAULT 0, gst_amt DOUBLE PRECISION NOT NULL DEFAULT 0, total DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT, remarks TEXT, refund_amount DOUBLE PRECISION NOT NULL DEFAULT 0, refund_mode TEXT, refund_reference TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Accepted','Rejected')),
  created_by INTEGER, created_by_name TEXT, created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  decided_by INTEGER, decided_by_name TEXT, decided_at TEXT, decision_note TEXT, branch_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice ON sales_returns(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);
-- "Net" views: invoices/purchases minus ACCEPTED returns. Every sales / purchase / GST / profit report reads these,
-- so a return is reflected everywhere automatically. (Views are not part of backups; they are rebuilt on start.)
CREATE OR REPLACE VIEW sales_net AS
  SELECT id, invoice_no, invoice_date, customer_id, salesperson_id, subtotal, gst_amt, grand_total, gst_pct, 'INVOICE'::text AS doc_type FROM sales_invoices
  UNION ALL
  SELECT r.id, r.return_no, r.return_date, r.customer_id, si.salesperson_id, -r.subtotal, -r.gst_amt, -r.grand_total, r.gst_pct, 'RETURN'::text
    FROM sales_returns r LEFT JOIN sales_invoices si ON si.id = r.invoice_id WHERE r.status = 'Accepted';
CREATE OR REPLACE VIEW purchases_net AS
  SELECT id, purchase_no, purchase_date, supplier_id, item_type, raw_material_id, product_id, qty, rate, amount, gst_pct, gst_amt, 'PURCHASE'::text AS doc_type FROM purchases
  UNION ALL
  SELECT id, return_no, return_date, supplier_id, item_type, raw_material_id, product_id, -qty, rate, -amount, gst_pct, -gst_amt, 'RETURN'::text
    FROM purchase_returns WHERE status = 'Accepted';
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, user_id INTEGER, method TEXT, path TEXT, status INTEGER NOT NULL, response TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_devices (
  device_id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), employee_id INTEGER REFERENCES employees(id),
  branch_id BIGINT REFERENCES branches(id), device_name TEXT, platform TEXT, app_version TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ, last_sync_at TIMESTAMPTZ,
  last_sync_sequence BIGINT NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_inbox (
  event_id UUID PRIMARY KEY, device_id UUID NOT NULL REFERENCES sync_devices(device_id), user_id INTEGER NOT NULL REFERENCES users(id),
  employee_id INTEGER REFERENCES employees(id), branch_id BIGINT REFERENCES branches(id), entity_type TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE')), entity_client_id UUID,
  client_created_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','REJECTED','CONFLICT')),
  error_code TEXT, error_message TEXT, payload JSONB NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS sync_outbox_sequence;
CREATE TABLE IF NOT EXISTS sync_outbox (
  sequence_no BIGINT PRIMARY KEY DEFAULT nextval('sync_outbox_sequence'), entity_type TEXT NOT NULL,
  entity_id BIGINT, entity_client_id UUID, operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE')),
  branch_id BIGINT REFERENCES branches(id), changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);
  const branch = pg.query(`SELECT id FROM branches ORDER BY id LIMIT 1`, [], false).rows[0];
  if (!branch) pg.query(`INSERT INTO branches (branch_code, branch_name, branch_type) VALUES ('HQ','Head Office','HEAD_OFFICE')`, [], false);
  pg.query(`INSERT INTO schema_version(version) VALUES (1) ON CONFLICT(version) DO NOTHING`, [], false);
}

function initializeTenantDatabase(database) {
  const env = { ...process.env, PGDATABASE: database, DATABASE_URL: '', PG_AUTO_CREATE_DB: 'true' };
  const result = spawnSync(process.execPath, ['-e', "process.env.SABIHA_SCHEMA_ONLY='1'; require('./db');"], {
    cwd: rootDir, env, encoding: 'utf8', timeout: 180000,
  });
  if (result.status !== 0) throw new Error(`Tenant schema initialization failed for ${database}: ${result.stderr || result.stdout || 'unknown error'}`);
  const p = createSyncPg(cfgForDatabase(database, false));
  p.connect();
  ensureTenantSchemaExtras(p);
  return p;
}

function getCompanyByCode(code) {
  return platformOne(`SELECT * FROM companies WHERE company_code = $1`, [String(code || '').trim().toUpperCase()]);
}
function getCompanyById(id) { return platformOne(`SELECT * FROM companies WHERE id = $1`, [id]); }

function getTenantConnection(company) {
  if (!company || company.status !== 'ACTIVE') throw new Error('Company is not active');
  let entry = tenantCache.get(company.database_name);
  if (!entry) {
    const p = createSyncPg(cfgForDatabase(company.database_name, false));
    p.connect();
    ensureTenantSchemaExtras(p);
    entry = { pg: p, lastUsed: Date.now() };
    tenantCache.set(company.database_name, entry);
  }
  entry.lastUsed = Date.now();
  if (tenantCache.size > MAX_TENANT_CONNECTIONS) {
    const victims = [...tenantCache.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
    while (tenantCache.size > MAX_TENANT_CONNECTIONS && victims.length) { const [name,v] = victims.shift(); if (name !== company.database_name) { try { v.pg.close(); } catch (_) {} tenantCache.delete(name); } }
  }
  return entry.pg;
}

function withCompany(company, fn) {
  const p = getTenantConnection(company);
  return runWithTenant(p, company.database_name, fn);
}

function provisionCompany({ companyCode, companyName, adminUsername = 'ADMIN', adminPassword = 'admin', adminPasswordHash = null, branchName = 'Head Office', forcePasswordChange = false }) {
  const code = String(companyCode || '').trim().toUpperCase();
  const name = String(companyName || '').trim();
  const username = String(adminUsername || '').trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,30}$/.test(code)) throw new Error('companyCode must be 3-31 characters: A-Z, 0-9, _ or -');
  if (!name) throw new Error('companyName is required');
  if (!username) throw new Error('adminUsername is required');
  if (getCompanyByCode(code)) throw new Error('Company code already exists');
  const database = dbNameForCode(code);
  platform.query(`INSERT INTO companies(company_code,company_name,database_name,status) VALUES($1,$2,$3,'PROVISIONING')`, [code,name,database], false);
  try {
    const p = initializeTenantDatabase(database);
    const bcrypt = require('bcryptjs');
    p.query(`UPDATE company_settings SET company_name=$1 WHERE id=1`, [name], false);
    p.query(`INSERT INTO branches(branch_code,branch_name,branch_type) VALUES($1,$2,'HEAD_OFFICE') ON CONFLICT(branch_code) DO NOTHING`, ['HQ', branchName], false);
    const branch = p.query(`SELECT id FROM branches WHERE branch_code='HQ'`, [], false).rows[0];
    p.query(`UPDATE users SET branch_id=$1 WHERE username=$2`, [branch.id, 'ADMIN'], false);
    p.query(`UPDATE employees SET branch_id=$1 WHERE branch_id IS NULL`, [branch.id], false);
    p.query(`UPDATE users SET username=$1,password_hash=$2,full_name='System Administrator',role='ADMIN',status='Approved',active=1,branch_id=$3,must_change_password=$4 WHERE id=(SELECT id FROM users ORDER BY id LIMIT 1)`, [username,adminPasswordHash || bcrypt.hashSync(adminPassword,10),branch.id,forcePasswordChange ? 1 : 0], false);
    platform.query(`UPDATE companies SET status='ACTIVE',activated_at=now(),provisioning_error=NULL WHERE company_code=$1`, [code], false);
    p.close();
    return getCompanyByCode(code);
  } catch (e) {
    platform.query(`UPDATE companies SET status='FAILED',provisioning_error=$2 WHERE company_code=$1`, [code,String(e.message).slice(0,4000)], false);
    throw e;
  }
}

function ensureDefaultCompany() {
  let c = getCompanyByCode(defaultCompanyCode);
  if (c) return c;
  const dbName = baseCfg.client.database;
  if (!dbName || dbName === platformName) throw new Error(`PGDATABASE must be the default ERP tenant database (not ${platformName})`);
  platform.query(`INSERT INTO companies(company_code,company_name,database_name,status,activated_at) VALUES($1,$2,$3,'ACTIVE',now())`, [defaultCompanyCode,defaultCompanyName,dbName], false);
  const p = createSyncPg(cfgForDatabase(dbName, true)); p.connect(); ensureTenantSchemaExtras(p); p.close();
  return getCompanyByCode(defaultCompanyCode);
}

function listCompanies() { return platformAll(`SELECT id,company_code,company_name,database_name,status,created_at,activated_at,suspended_at FROM companies ORDER BY company_name`); }
function setCompanyStatus(code,status) { const c=getCompanyByCode(code); if(!c) throw new Error('Company not found'); platform.query(`UPDATE companies SET status=$2 WHERE company_code=$1`,[code,status],false); return getCompanyByCode(code); }

ensureDefaultCompany();

module.exports = { platform, platformName, ensureTenantSchemaExtras, defaultCompanyCode, getCompanyByCode, getCompanyById, getTenantConnection, withCompany, provisionCompany, listCompanies, setCompanyStatus, dbNameForCode, describeConfig };
