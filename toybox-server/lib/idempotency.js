// ============================================================================
// lib/idempotency.js — makes offline replays safe.
// A desktop/browser client that was offline queues a write and sends it later
// with the header  X-Idempotency-Key. If the connection drops after the server
// already saved it, the client retries with the SAME key; this returns the
// first result instead of creating a second invoice / payment.
// Only successful (2xx) responses are remembered, for 14 days.
// ============================================================================
const { db } = require('../db');

function idempotency(req, res, next) {
  const key = String(req.headers['x-idempotency-key'] || '').trim();
  if (!key || !/^[A-Za-z0-9_-]{16,80}$/.test(key) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const scoped = `${req.user.id}:${key}`;
  try {
    const hit = db.prepare(`SELECT status, response FROM idempotency_keys WHERE key = ?`).get(scoped);
    if (hit) {
      res.setHeader('X-Idempotent-Replay', '1');
      let body; try { body = JSON.parse(hit.response); } catch (_) { body = { ok: true }; }
      return res.status(hit.status).json(body);
    }
  } catch (_) { return next(); }
  const orig = res.json.bind(res);
  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        db.prepare(`INSERT INTO idempotency_keys(key,user_id,method,path,status,response) VALUES(?,?,?,?,?,?) ON CONFLICT (key) DO NOTHING`)
          .run(scoped, req.user.id, req.method, String(req.path).slice(0, 200), res.statusCode, JSON.stringify(body).slice(0, 200000));
      }
      if (Math.random() < 0.01) cleanup();
    } catch (_) { /* never break the request because of bookkeeping */ }
    return orig(body);
  };
  next();
}
function cleanup() { try { db.prepare(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '14 days'`).run(); } catch (_) { /* ignore */ } }
module.exports = { idempotency, cleanup };
