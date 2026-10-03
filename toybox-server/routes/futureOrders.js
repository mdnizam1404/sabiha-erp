// ============================================================================
// routes/futureOrders.js — lightweight pipeline of expected-but-not-yet-
// invoiced business. See the future_orders table comment in db.js.
// ============================================================================
const express = require('express');
const { db, nextNo, audit } = require('../db');
const { evaluateIncentive } = require('./incentives');
const { validateBody, z } = require('../lib/validate');
const { requireModule } = require('../auth');
const { futureOrderSchema, id } = require('../lib/schemas');
const router = express.Router();

router.get('/future-orders', requireModule('customersSales'), (req, res) => {
  const rows = db.prepare(`
    SELECT fo.*, c.name customer_name, si.invoice_no converted_invoice_no, e.name salesperson_employee_name
    FROM future_orders fo
    LEFT JOIN customers c ON c.id = fo.customer_id
    LEFT JOIN sales_invoices si ON si.id = fo.converted_invoice_id
    LEFT JOIN employees e ON e.id = fo.salesperson_employee_id
    ORDER BY fo.expected_date`).all()
    .map((r) => ({ ...r, customer_name: r.customer_name || r.customer_name_freetext || '(unnamed prospect)',
      items: db.prepare(`SELECT foi.*, p.name product_name, p.unit FROM future_order_items foi JOIN products p ON p.id=foi.product_id WHERE foi.future_order_id=? ORDER BY foi.id`).all(r.id) }));
  res.json(rows);
});

router.post('/future-orders', validateBody(futureOrderSchema), requireModule('customersSales'), (req, res) => {
  const b = req.body;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!b.expected_date || !items.length) return res.status(400).json({ error: 'Expected date and at least one product line are required' });
  const employee = db.prepare(`SELECT employee_id FROM users WHERE id = ?`).get(req.user.id);
  const employeeRow = employee?.employee_id ? db.prepare(`SELECT id,name FROM employees WHERE id=?`).get(employee.employee_id) : null;
  const normalized = items.map((it) => {
    const p = db.prepare(`SELECT id,name,sale_rate FROM products WHERE id=? AND active=1`).get(Number(it.product_id));
    if (!p) throw new Error('One selected product is invalid');
    const qty = Number(it.qty || 0); if (!(qty > 0)) throw new Error(`Quantity for ${p.name} must be greater than zero`);
    const rate = Number(p.sale_rate || 0);
    return { product_id:p.id, qty, rate, amount:qty*rate };
  });
  const expectedValue = normalized.reduce((sum,it)=>sum+it.amount,0);
  const order_no = nextNo('FO-', 'future_orders', 'order_no');
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO future_orders (order_no,customer_id,customer_name_freetext,salesperson,salesperson_employee_id,expected_date,expected_value,probability_pct,status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(order_no, b.customer_id || null, b.customer_id ? null : (b.customer_name_freetext || null), employeeRow?.name || null, employeeRow?.id || null,
      b.expected_date, expectedValue, Number(b.probability_pct ?? 100), b.status === 'Lost' ? 'Lost' : 'Open', b.notes || null);
    for (const it of normalized) db.prepare(`INSERT INTO future_order_items (future_order_id,product_id,qty,rate,amount) VALUES (?,?,?,?,?)`).run(info.lastInsertRowid,it.product_id,it.qty,it.rate,it.amount);
    audit(req, 'CREATE', 'future_orders', info.lastInsertRowid, { ...b, expected_value: expectedValue, salesperson_employee_id: employeeRow?.id || null });
    return info.lastInsertRowid;
  })();
  res.json(db.prepare(`SELECT * FROM future_orders WHERE id = ?`).get(tx));
});

router.put('/future-orders/:id', validateBody(futureOrderSchema), requireModule('customersSales'), (req, res) => {
  const b = req.body;
  const existing = db.prepare(`SELECT * FROM future_orders WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Future order not found' });
  if (existing.status === 'Converted') return res.status(400).json({ error: 'This order is already converted to a sales invoice.' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one product line is required' });
  const normalized = items.map((it) => {
    const p = db.prepare(`SELECT id,name,sale_rate FROM products WHERE id=? AND active=1`).get(Number(it.product_id));
    if (!p) throw new Error('One selected product is invalid');
    const qty = Number(it.qty || 0); if (!(qty > 0)) throw new Error(`Quantity for ${p.name} must be greater than zero`);
    const rate = Number(p.sale_rate || 0); return {product_id:p.id,qty,rate,amount:qty*rate};
  });
  const expectedValue = normalized.reduce((sum,it)=>sum+it.amount,0);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE future_orders SET customer_id=?, customer_name_freetext=?, expected_date=?, expected_value=?, probability_pct=?, status=?, notes=? WHERE id=?`)
      .run(b.customer_id || null, b.customer_id ? null : (b.customer_name_freetext || null), b.expected_date, expectedValue, Number(b.probability_pct ?? 100), ['Open','Completed','Lost'].includes(b.status) ? b.status : existing.status, b.notes || null, req.params.id);
    db.prepare(`DELETE FROM future_order_items WHERE future_order_id=?`).run(req.params.id);
    for (const it of normalized) db.prepare(`INSERT INTO future_order_items (future_order_id,product_id,qty,rate,amount) VALUES (?,?,?,?,?)`).run(req.params.id,it.product_id,it.qty,it.rate,it.amount);
    audit(req, 'UPDATE', 'future_orders', req.params.id, { ...b, expected_value: expectedValue });
  });
  tx();
  res.json(db.prepare(`SELECT * FROM future_orders WHERE id = ?`).get(req.params.id));
});

router.post('/future-orders/:id/status', validateBody(z.object({ status: z.enum(['Open','Completed','Lost']) }).passthrough()), requireModule('customersSales'), (req, res) => {
  const status = String(req.body.status || '');
  if (!['Open','Completed','Lost'].includes(status)) return res.status(400).json({ error: 'Status must be Open, Completed or Lost' });
  const order = db.prepare(`SELECT * FROM future_orders WHERE id=?`).get(req.params.id);
  if (!order) return res.status(404).json({ error:'Future order not found' });
  if (order.status === 'Converted') return res.status(400).json({ error:'Converted orders cannot be changed' });
  db.prepare(`UPDATE future_orders SET status=? WHERE id=?`).run(status, req.params.id);
  audit(req,'UPDATE','future_orders',req.params.id,{status});
  res.json(db.prepare(`SELECT * FROM future_orders WHERE id=?`).get(req.params.id));
});

// Called once the sales invoice triggered by marking an order "Completed"
// has actually been saved — links the two records and flips the future
// order to its terminal "Converted" state. See saveInvoice() /
// convertFutureOrderToSale() in app.js for the flow that calls this.
router.post('/future-orders/:id/convert', validateBody(z.object({ invoice_id: id }).passthrough()), (req, res) => {
  const invoiceId = Number(req.body.invoice_id);
  const order = db.prepare(`SELECT * FROM future_orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Future order not found' });
  const invoice = db.prepare(`SELECT id FROM sales_invoices WHERE id = ?`).get(invoiceId);
  if (!invoice) return res.status(400).json({ error: 'That invoice could not be found' });
  if (order.status !== 'Completed') return res.status(400).json({ error: 'Only a Completed future order can be converted to an invoice' });
  let unlocked = [];
  const tx = db.transaction(() => {
    db.prepare(`UPDATE future_orders SET status = 'Converted', converted_invoice_id = ? WHERE id = ?`).run(invoiceId, req.params.id);
    audit(req, 'UPDATE', 'future_orders', req.params.id, { status: 'Converted', converted_invoice_id: invoiceId });
    if (order.salesperson_employee_id) unlocked = evaluateIncentive(req, order.salesperson_employee_id, 'BIDDING', order.expected_date);
  });
  tx();
  res.json({ ...db.prepare(`SELECT * FROM future_orders WHERE id = ?`).get(req.params.id), unlockedIncentives: unlocked });
});

router.delete('/future-orders/:id', (req, res) => {
  db.prepare(`DELETE FROM future_orders WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'future_orders', req.params.id, {});
  res.json({ ok: true });
});

// Feeds the "Future Orders" business report — overall funnel counts/value
// by status, plus a salesperson-wise breakdown showing each person's win
// rate (Converted ÷ (Converted + Lost), Open/Completed still pending).
router.get('/future-orders/summary', (req, res) => {
  const all = db.prepare(`SELECT * FROM future_orders`).all();
  const byStatus = {};
  ['Open', 'Completed', 'Lost', 'Converted'].forEach((s) => { byStatus[s] = { count: 0, value: 0 }; });
  all.forEach((o) => { byStatus[o.status] = byStatus[o.status] || { count: 0, value: 0 }; byStatus[o.status].count += 1; byStatus[o.status].value += o.expected_value; });

  const bySalesperson = {};
  all.forEach((o) => {
    const name = o.salesperson || '(unassigned)';
    bySalesperson[name] = bySalesperson[name] || { total: 0, open: 0, completed: 0, lost: 0, converted: 0, convertedValue: 0 };
    bySalesperson[name].total += 1;
    if (o.status === 'Open') bySalesperson[name].open += 1;
    else if (o.status === 'Completed') bySalesperson[name].completed += 1;
    else if (o.status === 'Lost') bySalesperson[name].lost += 1;
    else if (o.status === 'Converted') { bySalesperson[name].converted += 1; bySalesperson[name].convertedValue += o.expected_value; }
  });
  const salespersonRows = Object.entries(bySalesperson).map(([name, s]) => ({
    salesperson: name, ...s,
    winRatePct: (s.converted + s.lost) > 0 ? (s.converted / (s.converted + s.lost)) * 100 : null,
  }));
  res.json({ byStatus, salespersonRows });
});

module.exports = { router };
