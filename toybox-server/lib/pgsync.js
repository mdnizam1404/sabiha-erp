// ============================================================================
// lib/pgsync.js — synchronous PostgreSQL access for the main thread.
//
// The PostgreSQL driver is asynchronous, but this application's routes were
// written against better-sqlite3's synchronous API (hundreds of call sites,
// including multi-step transactions). A worker thread owns the real
// connection; this module sends it a request and blocks on a shared-memory
// flag until the answer is ready. Behaviour matches SQLite: one connection,
// statements run strictly in order, no interleaving between requests.
// ============================================================================
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const CALL_TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS || 120000);

/** Build node-postgres client settings from environment variables. */
function pgConfigFromEnv(env = process.env) {
  const client = {};
  const url = env.DATABASE_URL || env.POSTGRES_URL || '';
  if (url) {
    client.connectionString = url;
  } else {
    client.host = env.PGHOST || 'localhost';
    client.port = Number(env.PGPORT || 5432);
    client.user = env.PGUSER || 'postgres';
    client.password = env.PGPASSWORD !== undefined ? String(env.PGPASSWORD) : '';
    client.database = env.PGDATABASE || 'sabiha_erp';
  }
  const ssl = String(env.PGSSL || '').toLowerCase();
  if (ssl === 'true' || ssl === '1' || ssl === 'require') client.ssl = { rejectUnauthorized: String(env.PGSSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() === 'true' };
  client.max = 1;
  client.connectionTimeoutMillis = Number(env.PG_CONNECT_TIMEOUT_MS || 10000);
  // Database name for auto-create — derived from the URL if one was used
  if (client.connectionString && !client.database) {
    try { client.database = decodeURIComponent(new URL(client.connectionString).pathname.replace(/^\//, '')) || 'sabiha_erp'; } catch (e) { client.database = 'sabiha_erp'; }
  }
  const autoCreate = String(env.PG_AUTO_CREATE_DB || 'true').toLowerCase() !== 'false';
  return { client, autoCreate };
}

function describeConfig(cfg) {
  const c = cfg.client;
  if (c.connectionString) {
    try { const u = new URL(c.connectionString); return `${u.hostname}:${u.port || 5432} / database "${c.database}" / user "${decodeURIComponent(u.username)}"`; } catch (e) { return 'DATABASE_URL'; }
  }
  return `${c.host}:${c.port} / database "${c.database}" / user "${c.user}"`;
}

function friendlyConnectError(err, cfg) {
  const where = describeConfig(cfg);
  const lines = [`Could not connect to PostgreSQL (${where}).`];
  const code = err && err.code;
  if (code === 'ECONNREFUSED') lines.push('PostgreSQL is not running on that host/port. Start the PostgreSQL service (Windows: Services → postgresql-x64-NN → Start) and check PGHOST / PGPORT in .env.');
  else if (code === '28P01' || code === '28000') lines.push('Login was rejected. Check PGUSER and PGPASSWORD (or DATABASE_URL) in the .env file.');
  else if (code === '3D000') lines.push('The database does not exist and could not be created automatically. Create it in pgAdmin (or run: createdb sabiha_erp) and check PGDATABASE in .env.');
  else if (code === 'ENOTFOUND') lines.push('The PostgreSQL host name could not be resolved. Check PGHOST in .env.');
  else if (code === '42501') lines.push('The PostgreSQL user does not have permission to create the database. Ask an administrator to create it, or use a user with CREATEDB.');
  else lines.push(err && err.message ? err.message : String(err));
  const e = new Error(lines.join('\n'));
  e.pgConnectError = true;
  e.cause = err;
  return e;
}

class PgError extends Error {
  constructor(p) {
    super(p.message);
    this.name = 'PgError';
    Object.assign(this, { pgCode: p.code, detail: p.detail, table: p.table, column: p.column, constraint: p.constraint, hint: p.hint });
  }
}

/**
 * Map PostgreSQL errors onto the SQLite-style messages the routes already
 * present to users ("UNIQUE constraint failed: customers.code", ...).
 */
function normalizeError(p) {
  const err = new PgError(p);
  if (p.code === '23505') {
    let col = p.column;
    if (!col && p.detail) { const m = /Key \(([^)]+)\)/.exec(p.detail); if (m) col = m[1].split(',')[0].trim(); }
    err.message = `UNIQUE constraint failed: ${p.table || 'table'}.${col || 'column'}`;
    err.code = 'SQLITE_CONSTRAINT_UNIQUE';
  } else if (p.code === '23503') {
    err.message = 'FOREIGN KEY constraint failed';
    err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
  } else if (p.code === '23502') {
    err.message = `NOT NULL constraint failed: ${p.table || 'table'}.${p.column || 'column'}`;
    err.code = 'SQLITE_CONSTRAINT_NOTNULL';
  } else if (p.code === '23514') {
    err.message = `CHECK constraint failed: ${p.constraint || p.table || ''}`;
    err.code = 'SQLITE_CONSTRAINT_CHECK';
  } else if (p.code) {
    err.code = p.code;
  }
  return err;
}

function createSyncPg(cfg = pgConfigFromEnv()) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(path.join(__dirname, 'pg-worker.js'), {
    workerData: { port: port2, sab, config: cfg },
    transferList: [port2],
  });
  worker.unref(); // never keep the process alive on its own
  port1.unref();
  let workerDied = null;
  worker.on('error', (e) => { workerDied = e; console.error('[postgres worker]', e); });

  function call(msg) {
    if (workerDied) throw new Error('Database worker stopped: ' + workerDied.message);
    Atomics.store(flag, 0, 0);
    port1.postMessage(msg);
    const r = Atomics.wait(flag, 0, 0, CALL_TIMEOUT_MS);
    if (r === 'timed-out') throw new Error(`Database did not answer within ${Math.round(CALL_TIMEOUT_MS / 1000)}s`);
    const got = receiveMessageOnPort(port1);
    if (!got) throw new Error('Database worker returned no reply');
    return got.message;
  }

  return {
    config: cfg,
    connect() {
      const r = call({ op: 'connect' });
      if (!r.ok) throw friendlyConnectError(r.error, cfg);
      return r.version;
    },
    query(text, params, inTx) {
      const r = call({ op: 'query', text, params, inTx });
      if (!r.ok) throw normalizeError(r.error);
      return r;
    },
    exec(text) {
      const r = call({ op: 'exec', text });
      if (!r.ok) throw normalizeError(r.error);
      return r;
    },
    close() { try { call({ op: 'close' }); } catch (e) { /* ignore */ } worker.terminate(); },
  };
}

module.exports = { createSyncPg, pgConfigFromEnv, describeConfig, normalizeError };
