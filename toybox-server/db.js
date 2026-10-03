// ============================================================================
// db.js — PostgreSQL connection, schema, seed data, and shared database helpers
//
// v13: the application now runs on PostgreSQL. The routes still use the
// familiar synchronous  db.prepare(sql).get/all/run(...)  and  db.transaction()
// API — lib/pgsync.js provides that on top of the async "pg" driver (worker
// thread + blocking wait) and lib/sqlcompat.js translates the few
// SQLite-specific constructs. See UPDATE_NOTES_POSTGRESQL_v13.md.
// ============================================================================
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { createSyncPg, pgConfigFromEnv, describeConfig } = require('./lib/pgsync');
const compat = require('./lib/sqlcompat');

// When bundled into a standalone .exe with `pkg`, __dirname points inside a
// read-only virtual snapshot — so anything written to disk (backups) lives in
// the folder the real .exe sits in instead.
const ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
const pgCfg = pgConfigFromEnv();
const pg = createSyncPg(pgCfg);
const dbContext = new AsyncLocalStorage();
function activePg() { return dbContext.getStore()?.pg || pg; }
function activeDbName() { return dbContext.getStore()?.database || pgCfg.client.database; }
const DB_INFO = { engine: 'PostgreSQL', version: '', target: describeConfig(pgCfg) };
try {
  DB_INFO.version = pg.connect();
} catch (e) {
  console.error('\n================ DATABASE CONNECTION FAILED ================');
  console.error(e.message);
  console.error('\nSABIHA ERP v13 stores its data in PostgreSQL. Edit the .env file next to');
  console.error('server.js (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD) and start again.');
  console.error('See POSTGRESQL_SETUP_v13.md for step-by-step instructions.');
  console.error('=============================================================\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// better-sqlite3-compatible wrapper
// ---------------------------------------------------------------------------
let txDepth = 0;
const idTablesByDb = new Map();   // per company database: tables that have an integer "id" column
const stmtCache = new Map();

function invalidateMeta() { idTablesByDb.delete(activeDbName()); }
function tableHasId(table) {
  const key = activeDbName();
  let set = idTablesByDb.get(key);
  if (!set) {
    const r = activePg().query(`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id' AND data_type = 'integer'`, [], false);
    set = new Set(r.rows.map((x) => x.table_name));
    idTablesByDb.set(key, set);
  }
  return set.has(table);
}

function bindArgs(args) { return args.length === 1 && Array.isArray(args[0]) ? args[0] : args; }
function coerceParam(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

class Statement {
  constructor(sql) {
    this.sql = sql;
    const t = compat.translateQuery(sql);
    this.text = t.text;
    this.ignore = t.ignore;
    this.kind = compat.statementKind(sql);
    this.table = this.kind === 'INSERT' ? compat.insertTable(sql) : null;
  }
  _run(text, args) {
    return activePg().query(text, bindArgs(args).map(coerceParam), txDepth > 0);
  }
  all(...args) { return this._run(this.text, args).rows; }
  get(...args) { return this._run(this.text, args).rows[0]; }
  run(...args) {
    let text = this.text;
    if (this.kind === 'INSERT') {
      if (this.ignore && !/\bON\s+CONFLICT\b/i.test(text)) text += ' ON CONFLICT DO NOTHING';
      if (this.table && tableHasId(this.table) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';
    }
    const r = this._run(text, args);
    const first = r.rows && r.rows[0];
    return { changes: r.rowCount || 0, lastInsertRowid: first && first.id !== undefined ? first.id : 0 };
  }
}

const db = {
  prepare(sql) {
    let s = stmtCache.get(sql);
    if (!s) { s = new Statement(sql); if (stmtCache.size < 2000) stmtCache.set(sql, s); }
    return s;
  },
  // Runs DDL / multi-statement scripts. CREATE TABLEs are dependency-sorted.
  exec(sql) {
    if (/\b(CREATE|ALTER|DROP)\b/i.test(sql)) {
      for (const stmt of compat.translateDDL(sql)) activePg().exec(stmt);
      invalidateMeta();
    } else {
      activePg().exec(sql);
    }
  },
  // SQLite tuning pragmas have no meaning on PostgreSQL.
  pragma() { return []; },
  transaction(fn) {
    return (...args) => {
      const outer = txDepth === 0;
      const sp = 'sp_tx_' + txDepth;
      if (outer) activePg().query('BEGIN', [], false); else activePg().query('SAVEPOINT ' + sp, [], false);
      txDepth++;
      try {
        const result = fn(...args);
        txDepth--;
        if (outer) activePg().query('COMMIT', [], false); else activePg().query('RELEASE SAVEPOINT ' + sp, [], false);
        return result;
      } catch (e) {
        txDepth = Math.max(0, txDepth - 1);
        try {
          if (outer) activePg().query('ROLLBACK', [], false);
          else { activePg().query('ROLLBACK TO SAVEPOINT ' + sp, [], false); activePg().query('RELEASE SAVEPOINT ' + sp, [], false); }
        } catch (e2) { /* connection already gone */ }
        throw e;
      }
    };
  },
  close() { pg.close(); },

  // ---- helpers used by backup / restore / migration ------------------------
  /** All application tables, parents before children (foreign-key order). */
  tableOrder() {
    const names = activePg().query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`, [], false).rows.map((r) => r.table_name);
    const fks = activePg().query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
                          FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace`, [], false).rows;
    const deps = new Map(names.map((n) => [n, new Set()]));
    for (const f of fks) {
      const child = String(f.child).replace(/"/g, ''); const parent = String(f.parent).replace(/"/g, '');
      if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
    }
    const ordered = []; const done = new Set(); let remaining = names.slice();
    while (remaining.length) {
      const ready = remaining.filter((n) => [...deps.get(n)].every((p) => done.has(p)));
      const batch = ready.length ? ready : [remaining[0]];
      batch.forEach((n) => { ordered.push(n); done.add(n); });
      remaining = remaining.filter((n) => !batch.includes(n));
    }
    return ordered;
  },
  /** Column metadata for a table: [{ name, type, nullable, hasDefault }] */
  columns(table) {
    return activePg().query(`SELECT column_name AS name, data_type AS type, (is_nullable = 'YES') AS nullable, (column_default IS NOT NULL OR is_identity = 'YES') AS "hasDefault"
                     FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table], false).rows;
  },
  /** Re-sync every integer "id" sequence with MAX(id) — needed after bulk loads with explicit ids. */
  resetSequences() {
    for (const t of this.tableOrder()) {
      if (!tableHasId(t)) continue;
      activePg().query(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST(COALESCE(MAX(id), 0), 1), COALESCE(MAX(id), 0) >= 1) FROM "${t}"`, [], false);
    }
  },
  /** Full logical backup as a plain object (JSON-serialisable). */
  dumpAll() {
    const tables = {};
    for (const t of this.tableOrder()) {
      tables[t] = activePg().query(`SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS j FROM "${t}" x`, [], false).rows[0].j;
    }
    return { app: 'SABIHA-ERP', format: 'pg-json-v1', created_at: new Date().toISOString(), source: DB_INFO.version ? `PostgreSQL ${DB_INFO.version}` : 'PostgreSQL', tables };
  },
  /** Replace ALL data with the contents of a dumpAll() object — atomically. */
  restoreAll(dump) {
    if (!dump || dump.app !== 'SABIHA-ERP' || !dump.tables || typeof dump.tables !== 'object') throw new Error('That file is not a SABIHA ERP backup.');
    const order = this.tableOrder();
    const run = this.transaction(() => {
      activePg().query(`TRUNCATE ${order.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`, [], false);
      for (const t of order) {
        const rows = dump.tables[t];
        if (!Array.isArray(rows) || !rows.length) continue;
        const tableCols = this.columns(t).map((c) => c.name);
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => tableCols.includes(k));
        if (!keys.length) continue;
        const list = keys.map((k) => `"${k}"`).join(', ');
        activePg().query(`INSERT INTO "${t}" (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb)`, [JSON.stringify(rows)], false);
      }
    });
    run();
    this.resetSequences();
    return Object.fromEntries(order.map((t) => [t, Array.isArray(dump.tables[t]) ? dump.tables[t].length : 0]));
  },
};

// SQL helper functions (strftime/date/round emulation) — safe to re-run
try {
  for (const f of compat.COMPAT_FUNCTIONS_SQL) pg.exec(f);
} catch (e) {
  console.error('\n[DATABASE] Could not install helper functions in PostgreSQL:', e.message);
  console.error('The PostgreSQL user must be allowed to create functions in the "public" schema of this database.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'STAFF', -- ADMIN, MANAGER, SALES, ACCOUNTANT
  status TEXT NOT NULL DEFAULT 'Approved', -- Pending, Approved, Rejected
  active INTEGER DEFAULT 1,
  -- Links this login to an Employee record — required for a sale to be
  -- auto-attributed to a salesperson, and for that employee's own
  -- incentive/target achievements to be evaluated against their logins.
  employee_id INTEGER REFERENCES employees(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL,
  department TEXT, designation TEXT, join_date TEXT,
  phone TEXT, email TEXT, address TEXT,
  status TEXT DEFAULT 'Active', -- Active | On Leave
  salary_type TEXT DEFAULT 'Monthly', -- Monthly | On Production
  -- Per-employee monthly targets, each optionally driving an Incentive Rule
  -- (see incentive_rules below) — 0 means "no target set" for that trigger.
  sales_target REAL DEFAULT 0, production_target REAL DEFAULT 0, bid_target REAL DEFAULT 0,
  recovery_target REAL DEFAULT 0, overtime_target_hours REAL DEFAULT 0, job_target INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL,
  contact_person TEXT, phone TEXT, email TEXT, address TEXT, gst_no TEXT,
  credit_limit REAL DEFAULT 0, payment_terms_days INTEGER DEFAULT 30,
  -- Cumulative purchase milestone for loyalty/rebate eligibility — checked
  -- live against actual invoiced totals (see customerLoyaltyStatus() in
  -- routes/loyalty.js) rather than stored, so it's never stale.
  purchase_target REAL DEFAULT 0, reward_eligible INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL,
  contact_person TEXT, phone TEXT, email TEXT, address TEXT, gst_no TEXT,
  supplies TEXT, active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT,
  unit TEXT DEFAULT 'Pcs', sale_rate REAL DEFAULT 0, gst_rate REAL DEFAULT 18, hsn_code TEXT,
  min_stock REAL DEFAULT 0, opening_stock REAL DEFAULT 0, active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS raw_materials (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, unit TEXT DEFAULT 'Kg', hsn_code TEXT,
  rate REAL DEFAULT 0, min_stock REAL DEFAULT 0, opening_stock REAL DEFAULT 0, active INTEGER DEFAULT 1
);

-- Combo packs / bundles (a "Set", "Dozen", "Box of 12", mixed colours/sizes,
-- etc.) — the bundle itself is just a sellable wrapper around existing
-- products, so it carries no stock of its own. Selling one deducts each
-- component's stock by qty_per_bundle × qty sold (see stockOutForSale in
-- db.js), and there's nothing to add back to the bundle "product" itself.
CREATE TABLE IF NOT EXISTS product_bundles (
  id INTEGER PRIMARY KEY,
  bundle_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id),
  qty_per_bundle REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bom (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  qty_per_unit REAL NOT NULL DEFAULT 0,
  -- Which pipeline stage (Molding/Cutting/Finishing/Sticker/Packing, etc.)
  -- this raw material is actually consumed at. NULL means "consumed at
  -- final assembly" (Production entry) — the original/legacy behaviour,
  -- kept as the default so existing BOMs keep working unchanged.
  stage TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS production_stages (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  stage TEXT NOT NULL, -- Molding | Cutting | Finishing | Sticker | Packing
  qty_in REAL DEFAULT 0, qty_out REAL DEFAULT 0, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminders_log (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, channel TEXT NOT NULL, -- WhatsApp | Email | SMS
  target_type TEXT, target_id INTEGER, target_name TEXT, subject TEXT, message TEXT,
  status TEXT DEFAULT 'Queued', ref_type TEXT, ref_id INTEGER, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_id INTEGER REFERENCES purchases(id), amount REAL NOT NULL, mode TEXT DEFAULT 'Cash',
  reference_no TEXT, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Unified stock ledger — every IN/OUT movement for products & raw materials
CREATE TABLE IF NOT EXISTS stock_txn (
  id INTEGER PRIMARY KEY, txn_date TEXT NOT NULL, item_type TEXT NOT NULL, -- PRODUCT | RAW
  item_id INTEGER NOT NULL, qty REAL NOT NULL, direction TEXT NOT NULL,     -- IN | OUT
  ref_type TEXT, ref_id INTEGER, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production (
  id INTEGER PRIMARY KEY, batch_no TEXT, date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id), shift TEXT,
  planned_qty REAL DEFAULT 0, produced_qty REAL DEFAULT 0, defective_qty REAL DEFAULT 0,
  operator_id INTEGER REFERENCES employees(id), remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id INTEGER PRIMARY KEY, invoice_no TEXT UNIQUE NOT NULL, invoice_date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id), due_date TEXT,
  discount_pct REAL DEFAULT 0, gst_pct REAL DEFAULT 18, gst_type TEXT DEFAULT 'CGST_SGST', -- CGST_SGST | IGST
  subtotal REAL DEFAULT 0, gst_amt REAL DEFAULT 0, grand_total REAL DEFAULT 0,
  -- Set server-side only, from the logged-in user's linked employee record
  -- (users.employee_id) — never taken from the request body, so a
  -- salesperson can't attribute a sale to someone else. NULL if the person
  -- creating the invoice isn't linked to an employee record.
  salesperson_id INTEGER REFERENCES employees(id),
  status TEXT DEFAULT 'Unpaid', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL, rate REAL NOT NULL, discount_pct REAL DEFAULT 0, amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, purchase_no TEXT UNIQUE NOT NULL, purchase_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  item_type TEXT NOT NULL DEFAULT 'RAW_MATERIAL', -- RAW_MATERIAL | FINISHED_PRODUCT | ASSET
  raw_material_id INTEGER REFERENCES raw_materials(id), -- set when item_type = RAW_MATERIAL
  product_id INTEGER REFERENCES products(id), -- set when item_type = FINISHED_PRODUCT
  qty REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL, -- amount is the taxable value (excl. GST) — kept as-is so existing P&L/COGS calculations, which should exclude recoverable input tax, are unaffected
  gst_pct REAL NOT NULL DEFAULT 0, gst_amt REAL NOT NULL DEFAULT 0, -- Input GST — recoverable, tracked separately from the expense; see computeAccounts() and the Tax Summary report
  -- A purchase order raised as 'Ordered' does NOT move stock yet — only once
  -- marked 'Received' (see POST /purchases/:id/receive) does it route into
  -- raw_materials or products stock, based on item_type. Existing simple
  -- purchases default straight to 'Received' so the old one-step flow
  -- (create = stock arrives immediately) keeps working unchanged.
  status TEXT NOT NULL DEFAULT 'Received', -- Ordered | Received
  invoice_no TEXT, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id), invoice_id INTEGER REFERENCES sales_invoices(id),
  amount REAL NOT NULL, mode TEXT DEFAULT 'Cash', reference_no TEXT, remarks TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY, work_date TEXT NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id),
  in_time TEXT, out_time TEXT, working_hours REAL DEFAULT 0, overtime_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'Present', remarks TEXT, UNIQUE(work_date, employee_id)
);

CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), date TEXT NOT NULL,
  amount REAL NOT NULL, reason TEXT, adjusted INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY, payroll_no TEXT UNIQUE NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id),
  pay_month TEXT NOT NULL, basic REAL DEFAULT 0, hra REAL DEFAULT 0, conveyance REAL DEFAULT 0,
  other_allow REAL DEFAULT 0, advance_deduction REAL DEFAULT 0, pf REAL DEFAULT 0, esi REAL DEFAULT 0,
  other_deduction REAL DEFAULT 0, gross REAL DEFAULT 0, net REAL DEFAULT 0, paid_amount REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stage_settings (
  stage TEXT PRIMARY KEY, default_rate REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payroll_payments (
  id INTEGER PRIMARY KEY, payroll_id INTEGER NOT NULL REFERENCES payroll(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id), date TEXT NOT NULL, amount REAL NOT NULL,
  mode TEXT DEFAULT 'Cash', remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort_order INTEGER DEFAULT 0,
  default_rate REAL DEFAULT 0, active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, expense_no TEXT UNIQUE NOT NULL, date TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT, amount REAL NOT NULL, mode TEXT DEFAULT 'Cash', reference_no TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- User-managed expense categories — editable list (Settings → Expenses can
-- add more any time), seeded once with a sensible starting set below.
CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_persons (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT,
  stage TEXT DEFAULT 'Molding', default_rate REAL DEFAULT 0, active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS outsourcing_jobs (
  id INTEGER PRIMARY KEY, job_no TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES outsourcing_persons(id), product_id INTEGER REFERENCES products(id),
  stage TEXT, qty_sent REAL DEFAULT 0, qty_received REAL DEFAULT 0, rate REAL DEFAULT 0,
  amount REAL DEFAULT 0, status TEXT DEFAULT 'Pending', remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outsourcing_payments (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES outsourcing_persons(id),
  job_id INTEGER REFERENCES outsourcing_jobs(id), amount REAL NOT NULL, mode TEXT DEFAULT 'Cash',
  reference_no TEXT, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT, entity TEXT,
  entity_id INTEGER, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, is_system INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id INTEGER PRIMARY KEY, role_name TEXT NOT NULL, module_key TEXT NOT NULL, allowed INTEGER DEFAULT 0,
  UNIQUE(role_name, module_key)
);

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), company_name TEXT, address TEXT, phone TEXT, email TEXT,
  gst_no TEXT, financial_year_start TEXT, currency TEXT DEFAULT 'INR',
  invoice_prefix TEXT DEFAULT 'INV-', default_payment_terms INTEGER DEFAULT 30,
  logo_data_url TEXT, theme_default TEXT DEFAULT 'light', return_policy TEXT,
  corporate_tax_rate_pct REAL DEFAULT 25
);

-- ---------------------------------------------------------------------------
-- Fixed Assets & Depreciation
--
-- Two independent depreciation views are kept, because Indian law genuinely
-- requires two different numbers for the same asset:
--   1. Companies Act 2013, Schedule II — straight-line, per INDIVIDUAL asset,
--      over its useful life, pro-rated by days in use. This drives the
--      books/financial statements (net book value).
--   2. Income Tax Act 1961, Section 32 — written-down value, computed per
--      BLOCK of assets (assets of the same class & rate pooled together,
--      not tracked individually), with the 180-day rule for additions.
--      This drives the tax WDV.
-- The difference between the two is a timing difference — it reverses over
-- the asset's life, and is recognised as Deferred Tax (see routes/assets.js
-- for the calculation). Useful lives, residual %, and tax rates are all
-- editable per category, since Schedule II has many sub-categories and tax
-- rates are amended by Finance Acts from time to time — this module does
-- not hardcode a single "correct" answer for every asset type; it computes
-- correctly FROM whatever classification the business (with their CA's
-- guidance) sets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_categories (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  companies_act_useful_life_years REAL NOT NULL DEFAULT 10,
  residual_value_pct REAL NOT NULL DEFAULT 5,
  income_tax_block TEXT NOT NULL,
  income_tax_rate_pct REAL NOT NULL DEFAULT 15,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, asset_no TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES asset_categories(id),
  purchase_date TEXT NOT NULL, original_cost REAL NOT NULL,
  useful_life_years REAL, -- overrides the category default when set
  residual_value_pct REAL, -- overrides the category default when set
  location TEXT, remarks TEXT,
  status TEXT DEFAULT 'Active', -- Active | Disposed
  disposal_date TEXT, disposal_value REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Lightweight migrations — add columns for people upgrading an existing database
function ensureColumn(table, column, ddl) {
  // PostgreSQL supports IF NOT EXISTS natively; db.exec() translates the column DDL.
  db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
}
ensureColumn('employees', 'status', "status TEXT DEFAULT 'Active'");
ensureColumn('employees', 'salary_type', "salary_type TEXT DEFAULT 'Monthly'");
ensureColumn('sales_invoices', 'gst_type', "gst_type TEXT DEFAULT 'CGST_SGST'");
ensureColumn('payroll', 'paid_amount', 'paid_amount REAL DEFAULT 0');
ensureColumn('company_settings', 'logo_data_url', 'logo_data_url TEXT');
ensureColumn('products', 'overhead_per_unit', 'overhead_per_unit REAL DEFAULT 0');
ensureColumn('outsourcing_payments', 'auto_calculated', 'auto_calculated INTEGER DEFAULT 0');
ensureColumn('users', 'reset_requested', 'reset_requested INTEGER DEFAULT 0');
ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
ensureColumn('advances', 'source_payroll_id', 'source_payroll_id INTEGER REFERENCES payroll(id)');
ensureColumn('employees', 'monthly_target_qty', 'monthly_target_qty REAL DEFAULT 0');
ensureColumn('employees', 'piece_rate', 'piece_rate REAL DEFAULT 0');
ensureColumn('company_settings', 'corporate_tax_rate_pct', 'corporate_tax_rate_pct REAL DEFAULT 25');
// Manual overrides for P&L lines this app has no dedicated ledger for —
// entered once on the P&L report itself and applied to whichever period is
// being viewed (there's no separate "other income"/"interest" transaction
// module, so this is the simplest honest way to include them).
ensureColumn('company_settings', 'other_income_override', 'other_income_override REAL DEFAULT 0');
ensureColumn('company_settings', 'interest_expense_override', 'interest_expense_override REAL DEFAULT 0');
ensureColumn('bom', 'stage', 'stage TEXT DEFAULT NULL');
// Book depreciation method — Straight Line (SLM) or Written Down Value
// (WDV). A category-level default, overridable per individual asset,
// following the same pattern already used for useful_life_years and
// residual_value_pct.
ensureColumn('asset_categories', 'depreciation_method', "depreciation_method TEXT DEFAULT 'SLM'");
ensureColumn('assets', 'depreciation_method', 'depreciation_method TEXT DEFAULT NULL');
// Bank & UPI details — shown on the printed/PDF sales invoice as payment
// instructions for the customer.
ensureColumn('company_settings', 'bank_name', 'bank_name TEXT');
ensureColumn('company_settings', 'bank_account_no', 'bank_account_no TEXT');
ensureColumn('company_settings', 'bank_ifsc', 'bank_ifsc TEXT');
ensureColumn('company_settings', 'bank_branch', 'bank_branch TEXT');
ensureColumn('company_settings', 'upi_id', 'upi_id TEXT');
ensureColumn('company_settings', 'upi_qr_data_url', 'upi_qr_data_url TEXT');
// How many days of audit log history to keep — a scheduled cleanup (see
// server.js) deletes anything older than this on a timer, so the log
// doesn't grow forever. Defaults to 3 days as requested; editable in
// Company Settings if a longer trail is ever needed for compliance.
ensureColumn('company_settings', 'audit_log_retention_days', 'audit_log_retention_days INTEGER DEFAULT 3');
// Free-text vision/growth statement — written once in Company Settings,
// reused as the closing slide of the investor presentation each time it's
// generated, rather than something typed fresh on every export.
ensureColumn('company_settings', 'vision_statement', 'vision_statement TEXT');
// Migration for installs where purchases already existed before GST tracking was added.
ensureColumn('purchases', 'gst_pct', 'gst_pct REAL NOT NULL DEFAULT 0');
ensureColumn('purchases', 'gst_amt', 'gst_amt REAL NOT NULL DEFAULT 0');
// Outgoing-email (SMTP) settings — used to send registration OTP codes.
// Left blank, the app falls back to showing the code on-screen so it still
// works fully offline with no mail server configured.
ensureColumn('company_settings', 'smtp_host', 'smtp_host TEXT');
ensureColumn('company_settings', 'smtp_port', 'smtp_port INTEGER DEFAULT 587');
ensureColumn('company_settings', 'smtp_secure', 'smtp_secure INTEGER DEFAULT 0');
ensureColumn('company_settings', 'smtp_user', 'smtp_user TEXT');
ensureColumn('company_settings', 'smtp_pass', 'smtp_pass TEXT');
ensureColumn('company_settings', 'smtp_from', 'smtp_from TEXT');
// Barcode — defaults to the SKU but editable/regeneratable independently,
// used for both printed labels and barcode-scan sales entry.
ensureColumn('products', 'barcode', 'barcode TEXT');
// Product images/attributes (size, weight, colour) — shown in the product
// form and product list so a listing isn't just a name and a price.
ensureColumn('products', 'image_data_url', 'image_data_url TEXT');
ensureColumn('products', 'size', 'size TEXT');
ensureColumn('products', 'weight', 'weight TEXT');
ensureColumn('products', 'color', 'color TEXT');
// Combo packs — see the product_bundles table above.
ensureColumn('products', 'is_bundle', 'is_bundle INTEGER DEFAULT 0');
ensureColumn('products', 'bundle_label', 'bundle_label TEXT'); // e.g. "Box of 12", "Dozen", "Set of 3"
ensureColumn('users', 'email', 'email TEXT');
ensureColumn('users', 'phone', 'phone TEXT');

db.exec(`
-- ---------------------------------------------------------------------------
-- Loans — working-capital / term loans taken from a bank or fintech lender.
-- A loan's outstanding balance is derived from its transactions rather than
-- stored directly, so it can never drift out of sync:
--   outstanding = SUM(Disbursement.amount) + SUM(Adjustment.amount) - SUM(Repayment.principal_component)
-- Each transaction also feeds the financial reports automatically:
--   Disbursement -> cash IN (Cash/Bank Book), increases the liability
--   Repayment    -> cash OUT for the full amount; its interest_component
--                   flows into "Interest / Finance Costs" on the P&L, and
--                   its principal_component reduces the liability
--   Adjustment   -> no cash movement, just a manual correction to the
--                   liability (e.g. a penalty added, or a waiver)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY, loan_no TEXT UNIQUE NOT NULL, lender_name TEXT NOT NULL,
  loan_type TEXT DEFAULT 'Bank', purpose TEXT DEFAULT 'Working Capital',
  principal_amount REAL NOT NULL DEFAULT 0, interest_rate_pct REAL DEFAULT 0,
  start_date TEXT NOT NULL, tenure_months INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Active', remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loan_transactions (
  id INTEGER PRIMARY KEY, txn_no TEXT UNIQUE NOT NULL, loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  date TEXT NOT NULL, txn_type TEXT NOT NULL, -- 'Disbursement' | 'Repayment' | 'Adjustment'
  amount REAL NOT NULL DEFAULT 0, principal_component REAL DEFAULT 0, interest_component REAL DEFAULT 0,
  mode TEXT DEFAULT 'Bank Transfer', reference_no TEXT, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Future Orders — expected/pipeline business not yet invoiced (a verbal
-- commitment, a quotation sent, a seasonal order expected next month).
-- Deliberately lightweight (no line items) since its purpose is pipeline
-- visibility and feeding the investor-presentation's "Future Orders" slide,
-- not a full quotation/sales-order workflow.
CREATE TABLE IF NOT EXISTS future_orders (
  id INTEGER PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id),
  customer_name_freetext TEXT, -- used when the customer isn't in Customers yet (a prospect)
  salesperson TEXT, -- who's working this order — enables the salesperson-wise conversion report
  expected_date TEXT NOT NULL, expected_value REAL NOT NULL DEFAULT 0,
  probability_pct REAL DEFAULT 100, -- how likely this order is to actually happen, e.g. 50% for a tentative enquiry
  status TEXT DEFAULT 'Open', -- Open | Completed | Lost | Converted (became a real invoice)
  converted_invoice_id INTEGER REFERENCES sales_invoices(id), -- set automatically once Completed is turned into a real invoice
  notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Incentive & Reward system — a central, configurable set of rules (one per
-- trigger type: Sales, Production, Bidding, Payment Recovery, Overtime,
-- Job/Task) evaluated against each employee's own target fields (see
-- employees.*_target above). A crossed threshold creates one
-- employee_incentives row for that employee+rule+period — the ledger entry
-- that both drives the "you just earned a reward" popup and later gets
-- pulled into that employee's payslip. See routes/incentives.js.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS future_order_items (
  id INTEGER PRIMARY KEY, future_order_id INTEGER NOT NULL REFERENCES future_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS incentive_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- SALES | PRODUCTION | BIDDING | RECOVERY | OVERTIME | JOB_TASK
  reward_type TEXT NOT NULL DEFAULT 'FIXED', -- FIXED (flat ₹) | PERCENT (% of the achieved value, e.g. % of sales)
  reward_value REAL NOT NULL DEFAULT 0,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row per employee, per rule, per period (period = 'YYYY-MM') — the
-- UNIQUE constraint is what stops the same achievement being awarded twice
-- if the triggering action (e.g. another sale) fires again in the same month.
CREATE TABLE IF NOT EXISTS employee_incentives (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  rule_id INTEGER NOT NULL REFERENCES incentive_rules(id), trigger_type TEXT NOT NULL,
  period TEXT NOT NULL, achieved_value REAL NOT NULL, target_value REAL NOT NULL,
  reward_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Paid (Paid once pulled into a payslip)
  payroll_id INTEGER, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(employee_id, rule_id, period)
);

-- Job/Task Allotment — the one trigger type with no existing tracking
-- elsewhere in the app, so a minimal assignment list backs it.
CREATE TABLE IF NOT EXISTS employee_tasks (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  title TEXT NOT NULL, assigned_date TEXT NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Assigned', -- Assigned | Completed
  completed_date TEXT, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL, password_hash TEXT NOT NULL, full_name TEXT, role TEXT NOT NULL,
  email TEXT, phone TEXT, channel TEXT NOT NULL, -- 'email' | 'phone' — which one the OTP was sent to
  otp_code TEXT NOT NULL, otp_expires_at TEXT NOT NULL, attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Login lockout — tracked by the User ID as typed (not by IP), so 5 wrong
-- attempts in a row locks that User ID out for 24 hours, regardless of
-- which computer the attempts came from. Keyed independently of the users
-- table so a lockout also applies to a mistyped/unknown User ID (this
-- prevents an attacker from learning which User IDs exist by noticing that
-- only real accounts ever lock).
CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT
);
CREATE TABLE IF NOT EXISTS login_otp_challenges (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL, phone TEXT NOT NULL, otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL, verified_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
db.prepare(`UPDATE company_settings SET logo_data_url = ? WHERE id = 1 AND (logo_data_url IS NULL OR logo_data_url = '')`).run('/assets/sabiha-logo.jpg');
// Migration for installs where future_orders already existed before these
// two columns were added.
ensureColumn('future_orders', 'salesperson', 'salesperson TEXT');
ensureColumn('future_orders', 'converted_invoice_id', 'converted_invoice_id INTEGER REFERENCES sales_invoices(id)');
// Status set was renamed (Confirmed -> Completed) partway through — carry
// forward any rows saved under the old name.
try { db.prepare(`UPDATE future_orders SET status = 'Completed' WHERE status = 'Confirmed'`).run(); } catch (e) {}

// ---------------------------------------------------------------------------
// Migrations for installs created before this round of features — each is
// a no-op once already applied, so re-running on every boot is safe.
// ---------------------------------------------------------------------------
ensureColumn('products', 'hsn_code', 'hsn_code TEXT');
ensureColumn('raw_materials', 'hsn_code', 'hsn_code TEXT');
ensureColumn('sales_invoices', 'salesperson_id', 'salesperson_id INTEGER REFERENCES employees(id)');
ensureColumn('users', 'employee_id', 'employee_id INTEGER REFERENCES employees(id)');
ensureColumn('employees', 'sales_target', 'sales_target REAL DEFAULT 0');
ensureColumn('employees', 'production_target', 'production_target REAL DEFAULT 0');
ensureColumn('employees', 'bid_target', 'bid_target REAL DEFAULT 0');
ensureColumn('employees', 'recovery_target', 'recovery_target REAL DEFAULT 0');
ensureColumn('employees', 'overtime_target_hours', 'overtime_target_hours REAL DEFAULT 0');
ensureColumn('employees', 'job_target', 'job_target INTEGER DEFAULT 0');
ensureColumn('customers', 'purchase_target', 'purchase_target REAL DEFAULT 0');
ensureColumn('customers', 'reward_eligible', 'reward_eligible INTEGER DEFAULT 0');
// Needed so the Payment Recovery and Bidding incentive triggers can tell
// which employee to credit — both auto-derived from the logged-in user,
// the same tamper-safe pattern as sales_invoices.salesperson_id.
ensureColumn('receipts', 'collected_by', 'collected_by INTEGER REFERENCES employees(id)');
ensureColumn('future_orders', 'salesperson_employee_id', 'salesperson_employee_id INTEGER REFERENCES employees(id)');
ensureColumn('payroll', 'incentive_amount', 'incentive_amount REAL DEFAULT 0');
ensureColumn('customers', 'purchase_reward_type', "purchase_reward_type TEXT DEFAULT 'PERCENT'");
ensureColumn('customers', 'purchase_reward_value', 'purchase_reward_value REAL DEFAULT 0');
ensureColumn('customers', 'loyalty_earned_amount', 'loyalty_earned_amount REAL DEFAULT 0');
ensureColumn('customers', 'loyalty_reward_pending', 'loyalty_reward_pending INTEGER DEFAULT 0');
ensureColumn('customers', 'loyalty_reward_redeemed_at', 'loyalty_reward_redeemed_at TEXT');
ensureColumn('sales_invoices', 'loyalty_discount_amount', 'loyalty_discount_amount REAL DEFAULT 0');
ensureColumn('sales_invoices', 'loyalty_reward_type', "loyalty_reward_type TEXT");
ensureColumn('sales_invoices', 'loyalty_reward_value', 'loyalty_reward_value REAL DEFAULT 0');
// Central customer-loyalty reward configuration. Customer purchase targets remain per-customer,
// but the reward percentage/fixed amount is controlled centrally from Company/HR Settings.
ensureColumn('company_settings', 'loyalty_reward_type', "loyalty_reward_type TEXT DEFAULT 'PERCENT'");
ensureColumn('company_settings', 'loyalty_reward_value', 'loyalty_reward_value REAL DEFAULT 0');
// Source marks the payment created from the Purchase form so editing that form
// can adjust its initial payment without disturbing later manual payments.
ensureColumn('supplier_payments', 'source', "source TEXT DEFAULT 'MANUAL'");
ensureColumn('sales_items', 'hsn_code', 'hsn_code TEXT');

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sales_invoices_salesperson_date ON sales_invoices(salesperson_id, invoice_date);
    CREATE INDEX IF NOT EXISTS idx_sales_items_invoice ON sales_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_date_gst ON purchases(purchase_date, gst_pct);
    CREATE INDEX IF NOT EXISTS idx_receipts_collected_by_date ON receipts(collected_by, date);
    CREATE INDEX IF NOT EXISTS idx_production_operator_date ON production(operator_id, date);
    CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance(employee_id, work_date);
  `);
} catch (e) { console.warn('[index migration]', e.message); }

// ---------------------------------------------------------------------------
// Seed — first-run demo admin, company profile, and sample masters
// ---------------------------------------------------------------------------
// Module keys used for role-based access — these mirror the top-level nav
// sections in the frontend (public/app.js navConfig / TAB_GROUPS).
const MODULE_KEYS = [
  'dashboard', 'employeesPayroll', 'inventory', 'purchasesModule', 'productionModule',
  'customersSales', 'outsourcing', 'accountingReports', 'expenses', 'assets', 'loans', 'reminders', 'auditBackup', 'users', 'settings',
];

function seed(options = {}) {
  const includeSampleData = options.includeSampleData !== false;
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (userCount === 0) {
    db.prepare(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)`
    ).run('ADMIN', bcrypt.hashSync('admin', 10), 'System Administrator', 'ADMIN');
  }
  const stageCount = db.prepare('SELECT COUNT(*) n FROM pipeline_stages').get().n;
  if (stageCount === 0) {
    const insStage = db.prepare(`INSERT INTO pipeline_stages (name, sort_order, default_rate) VALUES (?,?,?)`);
    ['Molding', 'Cutting', 'Finishing', 'Sticker', 'Packing'].forEach((name, i) => insStage.run(name, i, 0));
  }

  const roleCount = db.prepare('SELECT COUNT(*) n FROM roles').get().n;
  if (roleCount === 0) {
    const insRole = db.prepare(`INSERT INTO roles (name, is_system) VALUES (?, 1)`);
    insRole.run('ADMIN'); insRole.run('MANAGER'); insRole.run('SALES'); insRole.run('ACCOUNTANT');
    const insPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_name, module_key, allowed) VALUES (?,?,?)`);
    // ADMIN always has full access regardless of this table (enforced in code),
    // but we still seed rows here so the Roles screen shows it fully checked.
    const defaults = {
      ADMIN: MODULE_KEYS,
      MANAGER: MODULE_KEYS.filter((k) => k !== 'users'),
      SALES: ['dashboard', 'customersSales', 'reminders', 'outsourcing'],
      ACCOUNTANT: ['dashboard', 'accountingReports', 'expenses', 'assets', 'purchasesModule', 'customersSales', 'employeesPayroll', 'reminders'],
    };
    for (const [role, keys] of Object.entries(defaults)) {
      for (const key of MODULE_KEYS) insPerm.run(role, key, keys.includes(key) ? 1 : 0);
    }
  }
  // If a new module key was added after roles already existed on this
  // install, give ADMIN/MANAGER/ACCOUNTANT sensible default access to it
  // (everyone else — SALES and any custom roles — stays off until an admin
  // explicitly turns it on in Roles & Permissions).
  const existingRoles = db.prepare(`SELECT name FROM roles`).all().map((r) => r.name);
  // Built-in SALES role defaults: repair only missing permission rows so an
  // approved SALES user can access the Customers & Sales module. Explicit
  // Administrator choices are preserved.
  const salesDefaultPerms = ['customersSales', 'dashboard', 'reminders', 'outsourcing'];
  const autoOnRoles = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];
  const insPermSafe = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_name, module_key, allowed) VALUES (?,?,?)`);
  if (existingRoles.includes('SALES')) {
    for (const key of salesDefaultPerms) insPermSafe.run('SALES', key, 1);
  }
  for (const role of existingRoles) {
    for (const key of MODULE_KEYS) insPermSafe.run(role, key, autoOnRoles.includes(role) ? 1 : 0);
  }

  if (!db.prepare('SELECT id FROM company_settings WHERE id = 1').get()) {
    db.prepare(
      `INSERT INTO company_settings (id, company_name, address, phone, email, gst_no, financial_year_start, currency, invoice_prefix, default_payment_terms, theme_default, return_policy, logo_data_url)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      process.env.COMPANY_NAME || 'SABIHA ERP', 'Industrial Area, New Delhi - 110001', '011-45678900',
      'info@sabihaerp.com', '07ABCDE1234F1Z5', new Date().getFullYear() + '-04-01', 'INR', 'INV-', 30, 'light',
      'Goods once dispatched are accepted for return only within 7 days for manufacturing defects, subject to inspection. Custom or bulk orders are non-returnable unless otherwise agreed in writing.',
      '/assets/sabiha-logo.jpg'
    );
  }

  const assetCatCount = db.prepare('SELECT COUNT(*) n FROM asset_categories').get().n;
  if (assetCatCount === 0) {
    // Sensible starting points only — Schedule II has many sub-categories
    // (e.g. specific plant used in specific industries can have a shorter
    // life) and Income Tax rates are amended by Finance Acts from time to
    // time. Confirm classification and current rates with your CA; these
    // are meant to be reviewed and adjusted per category, not treated as
    // a fixed authority.
    const insCat = db.prepare(`INSERT INTO asset_categories (name, companies_act_useful_life_years, residual_value_pct, income_tax_block, income_tax_rate_pct) VALUES (?,?,?,?,?)`);
    insCat.run('Plant & Machinery (General)', 15, 5, 'Plant & Machinery', 15);
    insCat.run('Moulds & Dies', 3, 5, 'Plant & Machinery (Moulds)', 15);
    insCat.run('Computers & Data Processing Units', 3, 5, 'Computers', 40);
    insCat.run('Furniture & Fittings', 10, 5, 'Furniture & Fittings', 10);
    insCat.run('Office Equipment', 5, 5, 'Plant & Machinery', 15);
    insCat.run('Motor Vehicles', 8, 5, 'Motor Vehicles', 15);
    insCat.run('Building (RCC Frame)', 60, 5, 'Building (Non-Residential)', 10);
  }

  const empCount = db.prepare('SELECT COUNT(*) n FROM employees').get().n;
  if (includeSampleData && empCount === 0) {
    const insEmp = db.prepare(`INSERT INTO employees (code,name,department,designation,join_date,phone,email,address,status,salary_type) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insEmp.run('EMP-001', 'Rohit Sharma', 'Production', 'Operator', '2025-04-01', '9876543210', 'rohit@toybox.com', '123 Industrial Area, New Delhi', 'Active', 'Monthly');
    insEmp.run('EMP-002', 'Anita Verma', 'Packing', 'Supervisor', '2024-11-15', '9812345678', 'anita@toybox.com', '45 MG Road, New Delhi', 'Active', 'Monthly');
    insEmp.run('EMP-003', 'Suresh Kumar', 'Molding', 'Machine Operator', '2023-06-20', '9900112233', 'suresh@toybox.com', '12 Sector 5, Noida', 'Active', 'On Production');

    const insCust = db.prepare(`INSERT INTO customers (code,name,contact_person,phone,email,address,credit_limit,payment_terms_days) VALUES (?,?,?,?,?,?,?,?)`);
    insCust.run('CUST-001', 'Rahul Traders', 'Rahul Mehta', '9123456780', 'rahul@traders.com', 'New Delhi Toys Market', 150000, 30);
    insCust.run('CUST-002', 'Sharma Stores', 'Vikas Sharma', '9123456781', 'vikas@sharmastores.com', 'Karol Bagh, Delhi', 100000, 15);
    insCust.run('CUST-003', 'Kidz World', 'Meena Kapoor', '9123456782', 'meena@kidzworld.com', 'Sadar Bazar, Delhi', 120000, 30);

    const insSup = db.prepare(`INSERT INTO suppliers (code,name,contact_person,phone,email,address,supplies) VALUES (?,?,?,?,?,?,?)`);
    insSup.run('SUP-001', 'Plastic Granules Co.', 'Manoj Gupta', '9988776655', 'manoj@plasticgranules.com', 'Faridabad', 'PP / ABS Raw Material');
    insSup.run('SUP-002', 'Color Masterbatch Ltd', 'Deepak Rao', '9988776656', 'deepak@masterbatch.com', 'Ghaziabad', 'Color Masterbatch');

    const insRaw = db.prepare(`INSERT INTO raw_materials (code,name,unit,rate,min_stock,opening_stock) VALUES (?,?,?,?,?,?)`);
    const rm1 = insRaw.run('RM-001', 'ABS Raw Material (White)', 'Kg', 145, 100, 45);
    insRaw.run('RM-002', 'Color Masterbatch (Red)', 'Kg', 320, 10, 2);
    const rm3 = insRaw.run('RM-003', 'PP Raw Material', 'Kg', 110, 80, 35);

    const insProd = db.prepare(`INSERT INTO products (sku,name,category,unit,sale_rate,gst_rate,min_stock,opening_stock) VALUES (?,?,?,?,?,?,?,?)`);
    const p1 = insProd.run('PRD-001', 'Toy Car', 'Vehicles', 'Pcs', 120, 18, 50, 0);
    insProd.run('PRD-002', 'Baby Doll', 'Doll Set', 'Pcs', 180, 18, 40, 0);
    const p3 = insProd.run('PRD-003', 'Building Blocks', 'Blocks', 'Pcs', 150, 18, 60, 0);

    db.prepare(`INSERT INTO bom (product_id, raw_material_id, qty_per_unit) VALUES (?,?,?)`).run(p1.lastInsertRowid, rm1.lastInsertRowid, 0.08);
    db.prepare(`INSERT INTO bom (product_id, raw_material_id, qty_per_unit) VALUES (?,?,?)`).run(p3.lastInsertRowid, rm3.lastInsertRowid, 0.05);

    db.prepare(`INSERT INTO outsourcing_persons (name,phone,email,stage,default_rate) VALUES (?,?,?,?,?)`)
      .run('Vinod Molding Works', '9871112233', 'vinod@jobwork.com', 'Molding', 5);
  }

  const expCatCount = db.prepare('SELECT COUNT(*) n FROM expense_categories').get().n;
  if (expCatCount === 0) {
    const insExpCat = db.prepare(`INSERT INTO expense_categories (name, sort_order) VALUES (?,?)`);
    ['Rent', 'Warehouse', 'Electricity Bill', 'Water Bill', 'Food / Staff Welfare', 'Travelling', 'Repairs & Maintenance', 'Office Supplies', 'Other']
      .forEach((name, i) => insExpCat.run(name, i));
  }
}
seed({ includeSampleData: !process.env.SABIHA_SCHEMA_ONLY });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function nextNo(prefix, table, col) {
  const row = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
  const n = row ? parseInt(String(row.v).replace(/\D/g, ''), 10) || 0 : 0;
  return prefix + String(n + 1).padStart(5, '0');
}

// Used instead of a plain addStockTxn('OUT', ...) for a sale line item —
// if the product being sold is a combo pack/bundle, this expands into a
// stock movement for each of its component products (qty × qty_per_bundle)
// instead of moving stock for the bundle "product" itself, which carries
// no stock of its own. A non-bundle product behaves exactly as before.
function stockOutForSale(date, productId, qty, refId, refNo) {
  const bundle = db.prepare(`SELECT component_product_id, qty_per_bundle FROM product_bundles WHERE bundle_product_id = ?`).all(productId);
  if (bundle.length) {
    for (const c of bundle) {
      addStockTxn(date, 'PRODUCT', c.component_product_id, Number(qty) * Number(c.qty_per_bundle), 'OUT', 'SALE', refId, refNo);
    }
  } else {
    addStockTxn(date, 'PRODUCT', productId, Number(qty), 'OUT', 'SALE', refId, refNo);
  }
}

function stockBalance(itemType, itemId) {
  const moved = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN qty ELSE -qty END),0) q FROM stock_txn WHERE item_type=? AND item_id=?`
  ).get(itemType, itemId).q;
  const table = itemType === 'PRODUCT' ? 'products' : 'raw_materials';
  const opening = db.prepare(`SELECT opening_stock v FROM ${table} WHERE id=?`).get(itemId)?.v || 0;
  return Number(opening) + Number(moved);
}
// Same as stockBalance, but "as of" a given date (inclusive) — used by the
// P&L report to value opening/closing raw-material stock for a period,
// rather than only ever being able to see today's live balance.
function stockBalanceAsOf(itemType, itemId, asOfDate) {
  const moved = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN qty ELSE -qty END),0) q FROM stock_txn WHERE item_type=? AND item_id=? AND txn_date <= ?`
  ).get(itemType, itemId, asOfDate).q;
  const table = itemType === 'PRODUCT' ? 'products' : 'raw_materials';
  const opening = db.prepare(`SELECT opening_stock v FROM ${table} WHERE id=?`).get(itemId)?.v || 0;
  return Number(opening) + Number(moved);
}

// Average purchase rate — weighted average of every purchase ever recorded
// for this raw material (total amount ÷ total qty), rather than just the
// rate of the most recent purchase. This is what BOM / cost-of-production
// and the raw-material inventory list now show as "Rate", so a one-off
// expensive or cheap purchase doesn't swing the finished-goods costing.
// Falls back to the material's manually-set rate when it has never been
// purchased yet (e.g. a brand-new raw material with only an opening stock).
function avgPurchaseRate(rawMaterialId) {
  const row = db.prepare(`SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(amount),0) a FROM purchases WHERE raw_material_id = ?`).get(rawMaterialId);
  if (row.q > 0) return row.a / row.q;
  const rm = db.prepare(`SELECT rate FROM raw_materials WHERE id = ?`).get(rawMaterialId);
  return rm ? Number(rm.rate) || 0 : 0;
}

function addStockTxn(date, itemType, itemId, qty, direction, refType, refId, notes) {
  db.prepare(
    `INSERT INTO stock_txn (txn_date,item_type,item_id,qty,direction,ref_type,ref_id,notes) VALUES (?,?,?,?,?,?,?,?)`
  ).run(date, itemType, itemId, qty, direction, refType, refId, notes || '');
}

function audit(req, action, entity, entityId, details) {
  db.prepare(`INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)`)
    .run(req.user?.id || null, req.user?.username || 'system', action, entity, entityId || null,
      typeof details === 'string' ? details : JSON.stringify(details || {}));
}

// Deletes audit log rows older than the configured retention window
// (company_settings.audit_log_retention_days, default 3). Called on a
// timer from server.js — not on every request — so this stays cheap.
function cleanupAuditLogs() {
  const days = Number(db.prepare(`SELECT audit_log_retention_days FROM company_settings WHERE id = 1`).get()?.audit_log_retention_days) || 3;
  const info = db.prepare(`DELETE FROM audit_logs WHERE created_at < to_char(timezone('UTC', now()) - (?::int * interval '1 day'), 'YYYY-MM-DD HH24:MI:SS')`).run(days);
  return { deleted: info.changes, retentionDays: days };
}

// ---------------------------------------------------------------------------
// Login lockout — 5 wrong User ID / password attempts locks that User ID
// out for 24 hours. See the login_attempts table comment above for why
// this is keyed by the typed username rather than by user id or IP.
// ---------------------------------------------------------------------------
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_HOURS = 24;

// Returns { locked: false } or { locked: true, lockedUntil: ISOString } — and
// transparently clears an expired lock so the next check starts fresh.
function checkLoginLock(username) {
  const key = (username || '').trim().toLowerCase();
  if (!key) return { locked: false };
  const row = db.prepare(`SELECT * FROM login_attempts WHERE username = ?`).get(key);
  if (!row || !row.locked_until) return { locked: false };
  if (new Date(row.locked_until) > new Date()) return { locked: true, lockedUntil: row.locked_until };
  // Lock has expired — reset so this User ID gets a clean slate of 5 attempts.
  db.prepare(`UPDATE login_attempts SET failed_count = 0, locked_until = NULL WHERE username = ?`).run(key);
  return { locked: false };
}

// Records one wrong User ID / password attempt. Returns either
// { locked: false, attempt, maxAttempts } or, on the attempt that trips the
// limit, { locked: true, lockedUntil, attempt, maxAttempts }.
function recordFailedLogin(username) {
  const key = (username || '').trim().toLowerCase();
  if (!key) return { locked: false, attempt: 1, maxAttempts: MAX_LOGIN_ATTEMPTS };
  const existing = db.prepare(`SELECT failed_count FROM login_attempts WHERE username = ?`).get(key);
  const nextCount = (existing?.failed_count || 0) + 1;
  if (nextCount >= MAX_LOGIN_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_HOURS * 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO login_attempts (username, failed_count, locked_until) VALUES (?,?,?)
      ON CONFLICT(username) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until`)
      .run(key, nextCount, lockedUntil);
    return { locked: true, lockedUntil, attempt: nextCount, maxAttempts: MAX_LOGIN_ATTEMPTS };
  }
  db.prepare(`INSERT INTO login_attempts (username, failed_count, locked_until) VALUES (?,?,NULL)
    ON CONFLICT(username) DO UPDATE SET failed_count = excluded.failed_count, locked_until = NULL`)
    .run(key, nextCount);
  return { locked: false, attempt: nextCount, maxAttempts: MAX_LOGIN_ATTEMPTS };
}

// Called on a successful login — wipes the slate clean for that User ID.
function clearLoginAttempts(username) {
  const key = (username || '').trim().toLowerCase();
  if (!key) return;
  db.prepare(`DELETE FROM login_attempts WHERE username = ?`).run(key);
}


function runWithTenant(tenantPg, database, fn) {
  return dbContext.run({ pg: tenantPg, database }, fn);
}
function currentDatabaseName() { return activeDbName(); }
module.exports = {
  db, DATA_DIR, BACKUP_DIR, MODULE_KEYS, runWithTenant, currentDatabaseName, nextNo, stockBalance, stockBalanceAsOf, addStockTxn, stockOutForSale, avgPurchaseRate, audit,
  checkLoginLock, recordFailedLogin, clearLoginAttempts, cleanupAuditLogs, DB_INFO,
};
