// ============================================================================
// routes/crud.js — generic list/get/create/update/soft-delete for master tables
// ============================================================================
const { db, audit, nextNo } = require('../db');
const { requireModule } = require('../auth');

/**
 * Mounts standard REST routes for a simple master table.
 * opts: { table, path, order, codePrefix, codeField }
 *   codePrefix: e.g. 'EMP-', 'CUST-', 'SUP-', 'RM-' — when set, a blank/
 *     missing `codeField` (default 'code') on create is auto-filled with
 *     the next number in that sequence, the same way invoice and purchase
 *     numbers already are, so nobody has to invent an ID by hand or leave
 *     one blank.
 */
function mountMasterCrud(router, opts) {
  const { table, path: routePath, order = 'id DESC', codePrefix, codeField = 'code', permission } = opts;
  const guard = permission ? requireModule(permission) : null;

  router.get(`/${routePath}`, ...(guard ? [guard] : []), (req, res) => {
    let rows = db.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY ${order}`).all();
    if (table === 'suppliers') {
      rows = rows.map((r) => {
        const bought = Number(db.prepare(`SELECT COALESCE(SUM(amount + gst_amt),0) v FROM purchases WHERE supplier_id = ?`).get(r.id).v || 0);
        const returned = Number(db.prepare(`SELECT COALESCE(SUM(total),0) v FROM purchase_returns WHERE supplier_id = ? AND status = 'Accepted'`).get(r.id).v || 0);
        const refunds = Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM purchase_returns WHERE supplier_id = ? AND status = 'Accepted'`).get(r.id).v || 0);
        const paidGross = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE supplier_id = ?`).get(r.id).v || 0);
        const purchased = bought - returned; const paid = paidGross - refunds; // net of goods sent back / money refunded by the supplier
        return { ...r, purchased, returned, paid, balance: purchased - paid };
      });
    }
    res.json(rows);
  });

  router.get(`/${routePath}/:id`, ...(guard ? [guard] : []), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post(`/${routePath}`, ...(guard ? [guard] : []), (req, res) => {
    try {
      const body = { ...req.body };
      delete body.id;
      if (codePrefix && !String(body[codeField] || '').trim()) {
        body[codeField] = nextNo(codePrefix, table, codeField);
      }
      const cols = Object.keys(body);
      const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      const info = stmt.run(...cols.map((c) => body[c]));
      audit(req, 'CREATE', table, info.lastInsertRowid, body);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put(`/${routePath}/:id`, ...(guard ? [guard] : []), (req, res) => {
    try {
      const body = { ...req.body };
      delete body.id;
      // An edit that clears an existing code back to blank still gets one
      // assigned, rather than leaving the record without an ID.
      if (codePrefix && codeField in body && !String(body[codeField] || '').trim()) {
        body[codeField] = nextNo(codePrefix, table, codeField);
      }
      const cols = Object.keys(body);
      if (!cols.length) return res.status(400).json({ error: 'No fields to update' });
      const stmt = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`);
      stmt.run(...cols.map((c) => body[c]), req.params.id);
      audit(req, 'UPDATE', table, req.params.id, body);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete(`/${routePath}/:id`, ...(guard ? [guard] : []), (req, res) => {
    db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(req.params.id);
    audit(req, 'DELETE', table, req.params.id, {});
    res.json({ ok: true });
  });
}

module.exports = { mountMasterCrud };
