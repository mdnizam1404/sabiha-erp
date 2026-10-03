// ============================================================================
// lib/backup.js — per-company backups run by the platform owner
//
//   * "Backup now" per company, scheduled nightly backups with retention
//   * restore into the SAME company (a safety copy is taken first) or into a
//     NEW company
//   * a full copy is taken automatically before a company is archived
//
// A backup is the company's complete logical dump (db.dumpAll), gzip-compressed,
// stored under data/company-backups/<COMPANY_ID>/. It contains the company's
// users and settings, so treat the folder like the database itself.
// ============================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mt = require('./multitenant');
const { one, all, run, PlatformError, audit, getSetting, setSetting } = require('./platformdb');

const rootDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DIR = path.join(rootDir, 'data', 'company-backups');
fs.mkdirSync(DIR, { recursive: true });

const DEFAULTS = { nightly_enabled: true, hour: 2, keep_nightly: 14, keep_manual: 20 };
function getSettings() {
  const s = { ...DEFAULTS, ...getSetting('backup', {}) };
  s.hour = Math.min(23, Math.max(0, Math.floor(Number(s.hour)) || 0));
  s.keep_nightly = Math.max(1, Math.floor(Number(s.keep_nightly)) || 14);
  s.keep_manual = Math.max(1, Math.floor(Number(s.keep_manual)) || 20);
  return s;
}
function saveSettings(input, actor, ip) {
  const n = (v, lo, hi, label) => { const x = Math.floor(Number(v)); if (!(x >= lo && x <= hi)) throw new PlatformError(`${label} must be between ${lo} and ${hi}.`); return x; };
  const s = { nightly_enabled: !!input.nightly_enabled, hour: n(input.hour, 0, 23, 'Backup hour'), keep_nightly: n(input.keep_nightly, 1, 365, 'Nightly backups to keep'), keep_manual: n(input.keep_manual, 1, 365, 'Manual backups to keep') };
  setSetting('backup', s); audit(actor, 'BACKUP_SETTINGS_SAVED', null, s, ip);
  return s;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const safeCode = (c) => String(c).replace(/[^A-Za-z0-9_-]/g, '_');
const pub = (r) => r && ({ id: r.id, company_code: r.company_code, kind: r.kind, file_name: r.file_name, size_bytes: Number(r.size_bytes), table_count: r.table_count, row_count: Number(r.row_count), note: r.note, created_by: r.created_by, created_at: r.created_at });

/** Take a backup of one company. `company.status` must be ACTIVE (archive passes a forced-ACTIVE copy). */
function backupCompany(company, { kind = 'MANUAL', actor = 'system', note = null } = {}) {
  const dump = mt.withCompany(company, () => require('../db').db.dumpAll());
  const tables = Object.keys(dump.tables || {});
  const rows = tables.reduce((t, k) => t + (Array.isArray(dump.tables[k]) ? dump.tables[k].length : 0), 0);
  dump.platform_company = { company_code: company.company_code, company_name: company.company_name };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)), { level: 6 });
  const folder = path.join(DIR, safeCode(company.company_code));
  fs.mkdirSync(folder, { recursive: true });
  const file = `${safeCode(company.company_code)}_${stamp()}_${kind}.json.gz`;
  fs.writeFileSync(path.join(folder, file), gz);
  const r = one(`INSERT INTO company_backups(company_id,company_code,kind,file_name,size_bytes,table_count,row_count,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [company.id, company.company_code, kind, file, gz.length, tables.length, rows, note, actor]);
  return pub(r);
}

function filePath(row) {
  const p = path.join(DIR, safeCode(row.company_code), path.basename(row.file_name));
  if (!p.startsWith(DIR)) throw new PlatformError('Invalid backup path.', 400);
  return p;
}
function getRow(id) {
  const r = one(`SELECT * FROM company_backups WHERE id=$1`, [Number(id) || 0]);
  if (!r) throw new PlatformError('Backup not found.', 404);
  return r;
}
function readDump(id) {
  const row = getRow(id);
  const p = filePath(row);
  if (!fs.existsSync(p)) throw new PlatformError('The backup file is missing from the server (data/company-backups).', 410);
  let dump;
  try { dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
  catch (_) { throw new PlatformError('The backup file is damaged and cannot be read.', 422); }
  return { row, dump };
}
function downloadInfo(id) { const row = getRow(id); const p = filePath(row); if (!fs.existsSync(p)) throw new PlatformError('The backup file is missing from the server.', 410); return { path: p, name: row.file_name }; }

function listBackups(code) { return all(`SELECT * FROM company_backups WHERE company_code=$1 ORDER BY id DESC LIMIT 200`, [String(code || '').toUpperCase()]).map(pub); }
function listAll(limit = 200) {
  return all(`SELECT * FROM company_backups ORDER BY id DESC LIMIT $1`, [Math.min(Number(limit) || 200, 1000)]).map(pub);
}
function deleteBackup(id, actor, ip) {
  const row = getRow(id);
  try { fs.unlinkSync(filePath(row)); } catch (_) { /* already gone */ }
  run(`DELETE FROM company_backups WHERE id=$1`, [row.id]);
  audit(actor, 'BACKUP_DELETED', row.company_code, { file: row.file_name }, ip);
}

/** Restore a backup INTO THE SAME company. A safety copy of the current data is taken first. */
function restoreBackup(id, actor, ip) {
  const { row, dump } = readDump(id);
  const company = mt.getCompanyByCode(row.company_code);
  if (!company || company.status !== 'ACTIVE') throw new PlatformError('The company must be active to restore into it.', 409);
  const safety = backupCompany(company, { kind: 'PRE_RESTORE', actor, note: `Automatic copy before restoring backup #${row.id}` });
  const counts = mt.withCompany(company, () => require('../db').db.restoreAll(dump));
  try { require('./subscription').invalidate(company.id); } catch (_) { /* cache only */ }
  audit(actor, 'BACKUP_RESTORED', company.company_code, { backup: row.file_name, safety_copy: safety.file_name }, ip);
  return { restored: row.file_name, safety_copy: safety.file_name, tables: Object.keys(counts).length };
}

function prune(companyCode) {
  const s = getSettings();
  const groups = [['NIGHTLY', s.keep_nightly], ['MANUAL', s.keep_manual], ['PRE_RESTORE', 5]];
  let removed = 0;
  const codes = companyCode ? [companyCode] : all(`SELECT DISTINCT company_code FROM company_backups`).map((r) => r.company_code);
  for (const code of codes) for (const [kind, keep] of groups) {
    const old = all(`SELECT * FROM company_backups WHERE company_code=$1 AND kind=$2 ORDER BY id DESC OFFSET $3`, [code, kind, keep]);
    for (const r of old) { try { fs.unlinkSync(filePath(r)); } catch (_) { /* already gone */ } run(`DELETE FROM company_backups WHERE id=$1`, [r.id]); removed++; }
  }
  return removed;
}

/** Nightly job: one backup per active company, one at a time, yielding between companies. */
async function runNightly(actor = 'scheduler') {
  const res = { ok: 0, failed: [] };
  for (const c of mt.listCompanies().filter((x) => x.status === 'ACTIVE')) {
    try { backupCompany(mt.getCompanyByCode(c.company_code), { kind: 'NIGHTLY', actor }); res.ok++; }
    catch (e) { res.failed.push({ company: c.company_code, error: e.message }); console.error(`[backup] ${c.company_code}:`, e.message); }
    await new Promise((r) => setImmediate(r));
  }
  res.pruned = prune();
  audit(actor, 'NIGHTLY_BACKUP_RUN', null, { ok: res.ok, failed: res.failed.length, pruned: res.pruned });
  return res;
}
function diskUsage() { return Number((one(`SELECT COALESCE(SUM(size_bytes),0) AS n FROM company_backups`) || {}).n || 0); }

module.exports = { DIR, getSettings, saveSettings, backupCompany, readDump, downloadInfo, listBackups, listAll, deleteBackup, restoreBackup, prune, runNightly, diskUsage };
