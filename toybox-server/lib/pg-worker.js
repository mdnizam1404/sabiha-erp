// ============================================================================
// lib/pg-worker.js — runs inside a worker thread; owns the ONE PostgreSQL
// connection used by the app. The main thread talks to it through
// lib/pgsync.js, which blocks (Atomics.wait) until each reply arrives — this
// is what lets the existing synchronous db.prepare(...).get()/.all()/.run()
// code keep working unchanged on top of PostgreSQL.
// ============================================================================
const { workerData } = require('worker_threads');
const { Client, types } = require('pg');

const { port, sab, config } = workerData;
const flag = new Int32Array(sab);

// Keep results shaped like SQLite's: numbers as JS numbers, dates as plain text
types.setTypeParser(20, (v) => Number(v));        // bigint  (COUNT, SUM of ints)
types.setTypeParser(1700, (v) => parseFloat(v));  // numeric (AVG etc.)
types.setTypeParser(1082, (v) => v);              // date
types.setTypeParser(1114, (v) => v);              // timestamp
types.setTypeParser(1184, (v) => v);              // timestamptz

let client = null;
let connecting = null;

function clientConfig(database) {
  const c = { ...config.client };
  if (database) c.database = database;
  return c;
}

async function openClient() {
  const c = new Client(clientConfig());
  c.on('error', (e) => { console.error('[postgres] connection error:', e.message); if (client === c) client = null; });
  await c.connect();
  await c.query("SET TIME ZONE 'UTC'");
  return c;
}

async function createDatabaseIfMissing() {
  const dbName = config.client.database;
  const admin = new Client(clientConfig('postgres'));
  await admin.connect();
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!r.rowCount) await admin.query(`CREATE DATABASE "${String(dbName).replace(/"/g, '""')}"`);
  } finally { await admin.end(); }
}

async function ensureClient() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      try {
        client = await openClient();
      } catch (e) {
        if (e && e.code === '3D000' && config.autoCreate) { await createDatabaseIfMissing(); client = await openClient(); }
        else throw e;
      }
      return client;
    } finally { connecting = null; }
  })();
  return connecting;
}

function errPayload(e) {
  return {
    message: e.message, code: e.code, detail: e.detail, table: e.table, column: e.column,
    constraint: e.constraint, hint: e.hint, position: e.position, errno: e.errno, syscall: e.syscall,
  };
}

// Statement-level savepoints inside a transaction: SQLite lets a transaction
// carry on after one statement fails (the app relies on this while importing
// rows one at a time); PostgreSQL would otherwise abort the whole transaction.
async function runQuery(c, text, params, inTx) {
  const attempt = async (p) => {
    if (!inTx) return c.query(text, p);
    await c.query('SAVEPOINT sp_stmt');
    try {
      const r = await c.query(text, p);
      await c.query('RELEASE SAVEPOINT sp_stmt');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK TO SAVEPOINT sp_stmt'); await c.query('RELEASE SAVEPOINT sp_stmt'); } catch (e2) { /* connection lost */ }
      throw e;
    }
  };
  try {
    return await attempt(params);
  } catch (e) {
    // SQLite happily stores '' in a numeric column; PostgreSQL rejects it.
    // Retry once, treating blank strings as NULL (then 0 if the column is NOT NULL).
    if (e.code === '22P02' && params && params.some((v) => v === '')) {
      try { return await attempt(params.map((v) => (v === '' ? null : v))); }
      catch (e2) {
        if (e2.code === '23502') return attempt(params.map((v) => (v === '' ? 0 : v)));
        throw e2;
      }
    }
    throw e;
  }
}

async function handle(msg) {
  try {
    if (msg.op === 'connect') { const c = await ensureClient(); const v = await c.query('SHOW server_version'); return { ok: true, version: v.rows[0].server_version }; }
    const c = await ensureClient();
    if (msg.op === 'query') {
      const r = await runQuery(c, msg.text, (msg.params || []).map((v) => (v === undefined ? null : v)), !!msg.inTx);
      return { ok: true, rows: r.rows || [], rowCount: r.rowCount };
    }
    if (msg.op === 'exec') { // multi-statement / no parameters — simple query protocol
      await c.query(msg.text);
      return { ok: true, rows: [], rowCount: 0 };
    }
    if (msg.op === 'close') { if (client) { await client.end(); client = null; } return { ok: true }; }
    return { ok: false, error: { message: 'Unknown database operation: ' + msg.op } };
  } catch (e) {
    return { ok: false, error: errPayload(e) };
  }
}

port.on('message', async (msg) => {
  const res = await handle(msg);
  port.postMessage(res);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
