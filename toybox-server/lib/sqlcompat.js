// ============================================================================
// lib/sqlcompat.js — translates the app's SQLite-flavoured SQL to PostgreSQL
//
// The application was written against better-sqlite3. Rather than rewriting
// ~570 queries by hand (and risking new bugs in each), db.js runs every
// statement through this module. It is deliberately conservative: it only
// rewrites constructs that genuinely differ, and it never touches text inside
// string literals, quoted identifiers or comments.
// ============================================================================

// Split SQL into [{ type: 'code' | 'str' | 'ident' | 'comment', text }] so that
// rewrites only ever apply to real code.
function tokenize(sql) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'code', text: buf }); buf = ''; } };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      flush();
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j++;
      out.push({ type: 'comment', text: sql.slice(i, j) });
      i = j;
    } else if (c === '/' && n === '*') {
      flush();
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? sql.length : j + 2;
      out.push({ type: 'comment', text: sql.slice(i, j) });
      i = j;
    } else if (c === "'") {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      out.push({ type: 'str', text: sql.slice(i, j) });
      i = j;
    } else if (c === '"') {
      flush();
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      j = Math.min(j + 1, sql.length);
      out.push({ type: 'ident', text: sql.slice(i, j) });
      i = j;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}

function mapCode(sql, fn) {
  return tokenize(sql).map((t) => (t.type === 'code' ? fn(t.text) : t.text)).join('');
}

// Words that legitimately follow AS but are types, not aliases.
const TYPE_WORDS = new Set(['INTEGER', 'INT', 'REAL', 'TEXT', 'NUMERIC', 'DOUBLE', 'BIGINT', 'DATE', 'VARCHAR', 'BOOLEAN', 'TIMESTAMP', 'FLOAT', 'DECIMAL', 'SMALLINT']);

/**
 * Translate a single DML/SELECT statement (with `?` placeholders).
 * Returns { text, ignore } where `ignore` marks INSERT OR IGNORE.
 */
function translateQuery(sql) {
  let ignore = false;
  let n = 0;
  const text = mapCode(sql, (code) => {
    let s = code;
    if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(s)) { ignore = true; s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO'); }
    if (/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i.test(s)) throw new Error('INSERT OR REPLACE is not supported by the PostgreSQL layer — use INSERT ... ON CONFLICT DO UPDATE');
    s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
    s = s.replace(/\bstrftime\s*\(/gi, 'sqlite_strftime(');
    s = s.replace(/\bdate\s*\(/gi, 'sqlite_date(');
    s = s.replace(/\bdatetime\s*\(/gi, 'sqlite_datetime(');
    s = s.replace(/\bLIKE\b/g, 'ILIKE'); // SQLite LIKE is case-insensitive; PostgreSQL's is not
    s = s.replace(/\bAS\s+REAL\b/gi, 'AS DOUBLE PRECISION');
    // PostgreSQL folds unquoted aliases to lower case; SQLite preserved them.
    // Quote camelCase aliases so result keys keep the exact case the UI expects.
    s = s.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g, (m, id) => {
      if (TYPE_WORDS.has(id.toUpperCase())) return m;
      return /[a-z]/.test(id) && /[A-Z]/.test(id) ? `AS "${id}"` : m;
    });
    // Implicit aliases too:  SUM(x) principalPaid  ->  SUM(x) "principalPaid"
    s = s.replace(/\)\s+([a-z][a-z0-9_]*[A-Z][A-Za-z0-9_]*)(?=\s*(?:,|$|\bFROM\b))/g, (m, id) => `) "${id}"`);
    s = s.replace(/\?/g, () => `$${++n}`);
    return s;
  });
  return { text: text.trim().replace(/;\s*$/, ''), ignore, paramCount: n };
}

function statementKind(sql) {
  const m = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRUNCATE|SET)\b/i.exec(sql);
  return m ? m[1].toUpperCase() : 'OTHER';
}

function insertTable(sql) {
  const m = /^\s*INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
function splitStatements(sql) {
  const stmts = [];
  let cur = '';
  for (const t of tokenize(sql)) {
    if (t.type === 'comment') continue;
    if (t.type !== 'code') { cur += t.text; continue; }
    const parts = t.text.split(';');
    parts.forEach((p, idx) => {
      cur += p;
      if (idx < parts.length - 1) { if (cur.trim()) stmts.push(cur.trim()); cur = ''; }
    });
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

const TS_DEFAULT = "(to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'))";

function translateDDLStatement(stmt) {
  return mapCode(stmt, (s) => {
    s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\b(?!\s+CHECK)(?!\s+GENERATED)/gi, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    s = s.replace(/\bREAL\b/g, 'DOUBLE PRECISION');
    s = s.replace(/\bDEFAULT\s+\(\s*datetime\s*\(\s*'now'\s*\)\s*\)/gi, 'DEFAULT ' + TS_DEFAULT);
    s = s.replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/gi, 'DEFAULT ' + TS_DEFAULT);
    return s;
  });
}

/**
 * Translate a block of DDL into an ordered list of PostgreSQL statements.
 * CREATE TABLE statements are topologically sorted by their REFERENCES so
 * forward references (which SQLite tolerates and PostgreSQL does not) work.
 */
function translateDDL(block) {
  const stmts = splitStatements(block).map(translateDDLStatement);
  const tables = [];
  const rest = [];
  for (const s of stmts) {
    const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(s);
    if (m) {
      const refs = new Set();
      mapCode(s, (code) => { code.replace(/\bREFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi, (mm, r) => { refs.add(r.toLowerCase()); return mm; }); return code; });
      refs.delete(m[1].toLowerCase());
      tables.push({ name: m[1].toLowerCase(), sql: s, refs });
    } else {
      rest.push(s);
    }
  }
  const names = new Set(tables.map((t) => t.name));
  const ordered = [];
  const done = new Set();
  let remaining = tables.slice();
  while (remaining.length) {
    const ready = remaining.filter((t) => [...t.refs].every((r) => done.has(r) || !names.has(r)));
    const batch = ready.length ? ready : [remaining[0]]; // cycle: break it deterministically
    for (const t of batch) { ordered.push(t.sql); done.add(t.name); }
    remaining = remaining.filter((t) => !batch.includes(t));
  }
  return [...ordered, ...rest];
}

// Column definition fragment used by ALTER TABLE ... ADD COLUMN
function translateColumnDDL(ddl) {
  return translateDDLStatement(ddl);
}

// ---------------------------------------------------------------------------
// Compatibility functions installed into the PostgreSQL database
// ---------------------------------------------------------------------------
const COMPAT_FUNCTIONS_SQL = [
  `CREATE OR REPLACE FUNCTION sqlite_strftime(fmt text, val text) RETURNS text
   LANGUAGE plpgsql IMMUTABLE AS $$
   DECLARE ts timestamp; out text;
   BEGIN
     IF val IS NULL OR val = '' THEN RETURN NULL; END IF;
     IF fmt = '%Y-%m' THEN RETURN substr(val, 1, 7); END IF;
     IF fmt = '%Y' THEN RETURN substr(val, 1, 4); END IF;
     IF fmt = '%Y-%m-%d' THEN RETURN substr(val, 1, 10); END IF;
     IF fmt = '%m' THEN RETURN substr(val, 6, 2); END IF;
     IF fmt = '%d' THEN RETURN substr(val, 9, 2); END IF;
     BEGIN
       ts := val::timestamp;
     EXCEPTION WHEN others THEN RETURN NULL;
     END;
     out := fmt;
     out := replace(out, '%Y', to_char(ts, 'YYYY'));
     out := replace(out, '%m', to_char(ts, 'MM'));
     out := replace(out, '%d', to_char(ts, 'DD'));
     out := replace(out, '%H', to_char(ts, 'HH24'));
     out := replace(out, '%M', to_char(ts, 'MI'));
     out := replace(out, '%S', to_char(ts, 'SS'));
     RETURN out;
   END $$`,
  // date(x) / date(x, '-1 day') / date('now') on TEXT dates, returning TEXT
  `CREATE OR REPLACE FUNCTION sqlite_date(val text) RETURNS text
   LANGUAGE plpgsql STABLE AS $$
   BEGIN
     IF val IS NULL THEN RETURN NULL; END IF;
     IF lower(val) = 'now' THEN RETURN to_char(timezone('UTC', now()), 'YYYY-MM-DD'); END IF;
     RETURN to_char(val::date, 'YYYY-MM-DD');
   EXCEPTION WHEN others THEN RETURN NULL;
   END $$`,
  `CREATE OR REPLACE FUNCTION sqlite_date(val text, modifier text) RETURNS text
   LANGUAGE plpgsql STABLE AS $$
   DECLARE d date; n int;
   BEGIN
     IF val IS NULL THEN RETURN NULL; END IF;
     IF lower(val) = 'now' THEN d := (timezone('UTC', now()))::date; ELSE d := val::date; END IF;
     IF modifier ~* 'start of month' THEN d := date_trunc('month', d)::date; RETURN to_char(d, 'YYYY-MM-DD'); END IF;
     n := NULLIF(regexp_replace(modifier, '[^-+0-9]', '', 'g'), '')::int;
     IF modifier ~* 'month' THEN d := (d + (n || ' months')::interval)::date;
     ELSIF modifier ~* 'year' THEN d := (d + (n || ' years')::interval)::date;
     ELSE d := d + COALESCE(n, 0);
     END IF;
     RETURN to_char(d, 'YYYY-MM-DD');
   EXCEPTION WHEN others THEN RETURN NULL;
   END $$`,
  `CREATE OR REPLACE FUNCTION sqlite_datetime(val text) RETURNS text
   LANGUAGE plpgsql STABLE AS $$
   BEGIN
     IF lower(val) = 'now' THEN RETURN to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'); END IF;
     RETURN to_char(val::timestamp, 'YYYY-MM-DD HH24:MI:SS');
   EXCEPTION WHEN others THEN RETURN NULL;
   END $$`,
  `CREATE OR REPLACE FUNCTION sqlite_datetime(val text, modifier text) RETURNS text
   LANGUAGE plpgsql STABLE AS $$
   DECLARE ts timestamp; n int;
   BEGIN
     IF lower(val) = 'now' THEN ts := timezone('UTC', now()); ELSE ts := val::timestamp; END IF;
     n := NULLIF(regexp_replace(modifier, '[^-+0-9]', '', 'g'), '')::int;
     IF modifier ~* 'hour' THEN ts := ts + (COALESCE(n,0) || ' hours')::interval;
     ELSIF modifier ~* 'minute' THEN ts := ts + (COALESCE(n,0) || ' minutes')::interval;
     ELSIF modifier ~* 'month' THEN ts := ts + (COALESCE(n,0) || ' months')::interval;
     ELSE ts := ts + (COALESCE(n,0) || ' days')::interval;
     END IF;
     RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
   EXCEPTION WHEN others THEN RETURN NULL;
   END $$`,
  // SQLite allows round(real, digits); PostgreSQL only has round(numeric, int)
  `CREATE OR REPLACE FUNCTION round(double precision, integer) RETURNS double precision
   LANGUAGE sql IMMUTABLE AS $$ SELECT round($1::numeric, $2)::double precision $$`,
];

module.exports = {
  tokenize, mapCode, translateQuery, statementKind, insertTable,
  splitStatements, translateDDL, translateColumnDDL, COMPAT_FUNCTIONS_SQL,
};
