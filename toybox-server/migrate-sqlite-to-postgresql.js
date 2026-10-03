#!/usr/bin/env node
// ============================================================================
// migrate-sqlite-to-postgresql.js — copy an existing SABIHA ERP SQLite
// database (data/erp.sqlite from v11 or earlier) into PostgreSQL.
//
//   node migrate-sqlite-to-postgresql.js                 (asks before replacing)
//   node migrate-sqlite-to-postgresql.js --yes            (no question asked)
//   node migrate-sqlite-to-postgresql.js --sqlite "D:\old\erp.sqlite" --yes
//
// * The SQLite file is opened READ-ONLY and is never modified or deleted.
// * The PostgreSQL connection comes from .env (PGHOST, PGPORT, PGDATABASE,
//   PGUSER, PGPASSWORD or DATABASE_URL) — the same settings the app uses.
// * The application's tables are created automatically, then ALL rows in the
//   target database are replaced with the SQLite data (ids are preserved).
// * Needs the optional package "better-sqlite3":  npm install better-sqlite3
// ============================================================================
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- .env loader (same rules as server.js) ---------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  });
}

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const sqlitePath = path.resolve(opt('--sqlite', path.join(__dirname, 'data', 'erp.sqlite')));

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }

let Database;
try { Database = require('better-sqlite3'); } catch (e) {
  die('The package "better-sqlite3" is needed only for this one-time migration and is not installed.\nRun:  npm install better-sqlite3\n(On Windows this may need "Visual Studio Build Tools" — see POSTGRESQL_SETUP_v13.md, section "Migrating your old data".)');
}
if (!fs.existsSync(sqlitePath)) die(`SQLite file not found: ${sqlitePath}\nPass its location with:  --sqlite "C:\\path\\to\\erp.sqlite"`);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

// --- value conversion (SQLite is loosely typed, PostgreSQL is strict) ------
const INT_TYPES = new Set(['integer', 'bigint', 'smallint']);
const NUM_TYPES = new Set(['double precision', 'numeric', 'real']);
function convert(value, col) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (INT_TYPES.has(col.type)) {
    if (value === '') return null;
    const n = Number(value); return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (NUM_TYPES.has(col.type)) {
    if (value === '') return null;
    const n = Number(value); return Number.isFinite(n) ? n : null;
  }
  return String(value).replace(/\u0000/g, '');
}

(async () => {
  console.log('\nSABIHA ERP — SQLite → PostgreSQL migration');
  console.log('  Source (read-only): ' + sqlitePath);

  const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const srcTables = src.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);

  // Connecting (and creating the application's tables) happens when db.js loads
  const { db, DB_INFO } = require('./db');
  console.log(`  Target:             PostgreSQL ${DB_INFO.version} — ${DB_INFO.target}`);

  if (!flag('--yes')) {
    console.log('\n  WARNING: every row currently in the target PostgreSQL database will be REPLACED');
    console.log('  with the data from the SQLite file.');
    const a = (await ask('  Type YES to continue: ')).trim().toUpperCase();
    if (a !== 'YES') { console.log('\n  Cancelled — nothing was changed.'); process.exit(0); }
  }

  const order = db.tableOrder();
  const report = [];
  const log = (s) => { console.log(s); report.push(s); };

  db.exec(`TRUNCATE ${order.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  log('\n  Existing rows in PostgreSQL cleared. Copying tables…\n');

  const summary = [];
  for (const t of order) {
    if (!srcTables.includes(t)) { summary.push({ t, src: '-', pg: 0, note: 'not in SQLite file' }); continue; }
    const pgCols = db.columns(t);
    const srcCols = src.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    const cols = pgCols.filter((c) => srcCols.includes(c.name));
    if (!cols.length) { summary.push({ t, src: 0, pg: 0, note: 'no matching columns' }); continue; }
    const rows = src.prepare(`SELECT ${cols.map((c) => `"${c.name}"`).join(', ')} FROM "${t}"`).all();
    const converted = rows.map((r) => {
      const o = {};
      for (const c of cols) {
        let v = convert(r[c.name], c);
        if (v === null && !c.nullable) {
          if (c.hasDefault) continue;                                   // let the column default apply
          v = INT_TYPES.has(c.type) || NUM_TYPES.has(c.type) ? 0 : '';  // NOT NULL without default
        }
        o[c.name] = v;
      }
      return o;
    });

    let copied = 0; const failed = [];
    const CH = 500;
    for (let i = 0; i < converted.length; i += CH) {
      const chunk = converted.slice(i, i + CH);
      const keys = [...new Set(chunk.flatMap((r) => Object.keys(r)))];
      const list = keys.map((k) => `"${k}"`).join(', ');
      try {
        // bulk path: one statement per chunk
        db.transaction(() => {
          db.prepare(`INSERT INTO "${t}" (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::"${t}", ?::jsonb)`).run(JSON.stringify(chunk));
        })();
        copied += chunk.length;
      } catch (bulkErr) {
        // slow path: row by row so ONE bad row cannot block the rest
        for (const row of chunk) {
          const ks = Object.keys(row);
          try {
            db.transaction(() => {
              db.prepare(`INSERT INTO "${t}" (${ks.map((k) => `"${k}"`).join(', ')}) VALUES (${ks.map(() => '?').join(', ')})`).run(ks.map((k) => row[k]));
            })();
            copied++;
          } catch (rowErr) { failed.push({ id: row.id, error: rowErr.message }); }
        }
      }
    }
    summary.push({ t, src: rows.length, pg: copied, note: failed.length ? `${failed.length} row(s) skipped` : '' });
    failed.slice(0, 20).forEach((f) => report.push(`    ${t} id=${f.id}: ${f.error}`));
  }

  db.resetSequences();

  log('  Table                          SQLite rows   PostgreSQL rows');
  log('  -----------------------------  -----------   ---------------');
  let mismatch = 0;
  for (const s of summary) {
    const bad = s.src !== '-' && s.src !== s.pg;
    if (bad) mismatch++;
    log(`  ${s.t.padEnd(29)}  ${String(s.src).padStart(11)}   ${String(s.pg).padStart(15)}  ${bad ? '<-- CHECK' : ''} ${s.note}`);
  }
  const reportFile = path.join(__dirname, 'data', 'migration-report.txt');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, report.join('\n') + '\n');
  console.log(mismatch
    ? `\n  Finished with ${mismatch} table(s) that need attention. Details: ${reportFile}`
    : '\n  Migration complete — every row was copied. You can now start SABIHA ERP (start.bat / npm start).');
  console.log('  Your original SQLite file was not changed. Keep it as a backup.\n');
  src.close();
  db.close();
  process.exit(mismatch ? 2 : 0);
})().catch((e) => { console.error('\nMigration failed:', e.message); process.exit(1); });
