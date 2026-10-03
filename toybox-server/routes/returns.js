// ============================================================================
// routes/returns.js — customer returns (credit notes) and supplier returns (debit notes)
//
// A return is first recorded as PENDING. When an authorised person ACCEPTS it,
// everything is updated in one all-or-nothing step:
//   Customer return : stock goes back IN (unless the goods are marked damaged),
//                     the customer's balance is reduced (or a refund is recorded),
//                     the invoice status, sales, GST (output) and profit reports,
//                     top-products and customer ledger all follow automatically.
//   Supplier return : stock goes OUT, the supplier's balance is reduced (or the
//                     refund received is recorded), purchases, Input GST,
//                     raw-material average rate and the supplier ledger follow.
// Reports read the views sales_net / purchases_net (invoices minus accepted
// returns), so nothing is double-counted and nothing needs manual correction.
// ============================================================================
const express = require('express');
const { db, nextNo, stockBalance, addStockTxn, audit } = require('../db');
const { requireModule, requireRole } = require('../auth');

const router = express.Router();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
class Bad extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { if (e instanceof Bad) return res.status(e.status).json({ error: e.message }); console.error('[returns]', e); res.status(500).json({ error: 'Could not save the return. Please try again.' }); } };
const date = (v, label) => { const s = String(v || today()).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Bad(`${label} must be a valid date.`); return s; };
const text = (v, n) => String(v || '').trim().slice(0, n);
const MODES = ['Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Card'];
// the row id is looked up by its unique number, so it never depends on the driver's "last insert id" cache
const idOf = (table, no) => Number(db.prepare(`SELECT id FROM ${table} WHERE return_no = ?`).get(no).id);
const canDecide = requireRole('ADMIN', 'MANAGER', 'ACCOUNTANT');
const mayDecide = (req) => ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(String(req.user.role || '').toUpperCase());

// ---------------------------------------------------------------------------
// shared maths — also used by invoices, receipts, statements and reports
// ---------------------------------------------------------------------------
/** Accepted returns total (incl. GST) for an invoice. */
const invoiceReturned = (invoiceId) => Number(db.prepare(`SELECT COALESCE(SUM(grand_total),0) v FROM sales_returns WHERE invoice_id = ? AND status = 'Accepted'`).get(invoiceId).v) || 0;
const invoiceRefunded = (invoiceId) => Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM sales_returns WHERE invoice_id = ? AND status = 'Accepted'`).get(invoiceId).v) || 0;
/** Invoice status after receipts AND returns: Unpaid / Partial / Paid / Returned. */
function computeInvoiceStatus(invoiceId) {
  const inv = db.prepare(`SELECT grand_total FROM sales_invoices WHERE id = ?`).get(invoiceId);
  if (!inv) return 'Unpaid';
  const net = Number(inv.grand_total) - invoiceReturned(invoiceId);
  const received = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE invoice_id = ?`).get(invoiceId).v) - invoiceRefunded(invoiceId);
  if (net <= 0.005) return 'Returned';
  if (received >= net - 0.005) return 'Paid';
  return received > 0.005 ? 'Partial' : 'Unpaid';
}
/** Money actually paid on this invoice / purchase that can still be handed back (refund can never exceed it). */
const invoiceRefundable = (invoiceId, excludeReturnId) => Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE invoice_id = ?`).get(invoiceId).v) - Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM sales_returns WHERE invoice_id = ? AND status = 'Accepted' ${excludeReturnId ? 'AND id <> ?' : ''}`).get(...[invoiceId, ...(excludeReturnId ? [excludeReturnId] : [])]).v);
const purchaseRefundable = (purchaseId, excludeReturnId) => Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE purchase_id = ?`).get(purchaseId).v) - Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM purchase_returns WHERE purchase_id = ? AND status = 'Accepted' ${excludeReturnId ? 'AND id <> ?' : ''}`).get(...[purchaseId, ...(excludeReturnId ? [excludeReturnId] : [])]).v);
const refreshInvoiceStatus = (invoiceId) => { if (invoiceId) db.prepare(`UPDATE sales_invoices SET status = ? WHERE id = ?`).run(computeInvoiceStatus(invoiceId), invoiceId); };
const purchaseReturned = (purchaseId) => Number(db.prepare(`SELECT COALESCE(SUM(total),0) v FROM purchase_returns WHERE purchase_id = ? AND status = 'Accepted'`).get(purchaseId).v) || 0;
const purchaseRefunded = (purchaseId) => Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM purchase_returns WHERE purchase_id = ? AND status = 'Accepted'`).get(purchaseId).v) || 0;
const customerRefunds = (customerId) => Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM sales_returns WHERE customer_id = ? AND status = 'Accepted'`).get(customerId).v) || 0;
const supplierRefunds = (supplierId) => Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) v FROM purchase_returns WHERE supplier_id = ? AND status = 'Accepted'`).get(supplierId).v) || 0;

// ---------------------------------------------------------------------------
// Customer returns
// ---------------------------------------------------------------------------
function invoiceLines(invoiceId, excludeReturnId) {
  const inv = db.prepare(`SELECT id, invoice_no, invoice_date, customer_id, gst_pct, gst_type, subtotal, grand_total FROM sales_invoices WHERE id = ?`).get(invoiceId);
  if (!inv) throw new Bad('Invoice not found.', 404);
  const lines = db.prepare(`SELECT si.product_id, p.name product_name, p.unit, SUM(si.qty) qty, SUM(si.amount) amount FROM sales_items si JOIN products p ON p.id = si.product_id WHERE si.invoice_id = ? GROUP BY si.product_id, p.name, p.unit ORDER BY MIN(si.id)`).all(invoiceId);
  const itemsTotal = lines.reduce((t, l) => t + Number(l.amount), 0);
  const factor = itemsTotal > 0 ? Number(inv.subtotal) / itemsTotal : 1; // invoice-level (loyalty) discount applies proportionally to every line
  const used = (statuses) => Object.fromEntries(db.prepare(`SELECT ri.product_id, SUM(ri.qty) q FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id WHERE r.invoice_id = ? AND r.status IN (${statuses}) ${excludeReturnId ? 'AND r.id <> ?' : ''} GROUP BY ri.product_id`).all(...[invoiceId, ...(excludeReturnId ? [excludeReturnId] : [])]).map((x) => [x.product_id, Number(x.q)]));
  const accepted = used(`'Accepted'`); const pending = used(`'Pending'`);
  return { inv, factor, lines: lines.map((l) => ({ product_id: l.product_id, product_name: l.product_name, unit: l.unit, sold_qty: Number(l.qty), unit_net: Number(l.qty) ? Number(l.amount) / Number(l.qty) : 0, returned_qty: r3(accepted[l.product_id] || 0), pending_qty: r3(pending[l.product_id] || 0), available_qty: r3(Number(l.qty) - (accepted[l.product_id] || 0) - (pending[l.product_id] || 0)), accepted_only_available: r3(Number(l.qty) - (accepted[l.product_id] || 0)) })) };
}
const salesReturnRow = (id) => db.prepare(`SELECT r.*, c.name customer_name, i.invoice_no FROM sales_returns r JOIN customers c ON c.id = r.customer_id JOIN sales_invoices i ON i.id = r.invoice_id WHERE r.id = ?`).get(id);
const salesReturnItems = (id) => db.prepare(`SELECT ri.*, p.name product_name, p.unit FROM sales_return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ? ORDER BY ri.id`).all(id);

router.get('/sales-returns', requireModule('customersSales'), wrap((req, res) => {
  const where = []; const args = [];
  if (req.query.status) { where.push('r.status = ?'); args.push(String(req.query.status)); }
  if (req.query.invoice_id) { where.push('r.invoice_id = ?'); args.push(Number(req.query.invoice_id)); }
  if (req.query.customer_id) { where.push('r.customer_id = ?'); args.push(Number(req.query.customer_id)); }
  const rows = db.prepare(`SELECT r.*, c.name customer_name, i.invoice_no, (SELECT COUNT(*) FROM sales_return_items x WHERE x.return_id = r.id) item_count
    FROM sales_returns r JOIN customers c ON c.id = r.customer_id JOIN sales_invoices i ON i.id = r.invoice_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.return_date DESC, r.id DESC`).all(...args);
  res.json(rows);
}));
router.get('/sales-returns/for-invoice/:invoiceId', requireModule('customersSales'), wrap((req, res) => {
  const d = invoiceLines(Number(req.params.invoiceId));
  const customer = db.prepare(`SELECT id, name FROM customers WHERE id = ?`).get(d.inv.customer_id);
  res.json({ invoice: { ...d.inv, customer_name: customer && customer.name, subtotal: Number(d.inv.subtotal), grand_total: Number(d.inv.grand_total) }, factor: d.factor, lines: d.lines });
}));
router.get('/sales-returns/:id', requireModule('customersSales'), wrap((req, res) => {
  const r = salesReturnRow(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  res.json({ ...r, items: salesReturnItems(r.id) });
}));

function applySalesReturn(req, id, { note, refund } = {}) {
  const r = db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(id);
  if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Pending') throw new Bad(`This return was already ${r.status.toLowerCase()}.`, 409);
  const d = invoiceLines(r.invoice_id, r.id);
  const items = db.prepare(`SELECT * FROM sales_return_items WHERE return_id = ?`).all(r.id);
  for (const it of items) { // others may have been accepted since this was raised
    const l = d.lines.find((x) => x.product_id === it.product_id);
    if (!l || Number(it.qty) > l.accepted_only_available + 1e-9) throw new Bad(`Cannot accept: only ${l ? l.accepted_only_available : 0} of ${l ? l.product_name : 'this item'} can still be returned on ${d.inv.invoice_no}.`);
  }
  let refundAmount = Number(r.refund_amount) || 0; let mode = r.refund_mode; let ref = r.refund_reference;
  if (refund) { refundAmount = r2(refund.amount); mode = refund.mode || mode; ref = refund.reference || ref; }
  if (refundAmount < 0 || refundAmount > Number(r.grand_total) + 0.005) throw new Bad('The refund cannot be more than the return value.');
  if (refundAmount > 0 && !MODES.includes(mode || 'Cash')) throw new Bad('Choose a valid refund mode.');
  if (refundAmount > invoiceRefundable(r.invoice_id, r.id) + 0.005) throw new Bad(`You can only refund money the customer actually paid on ${d.inv.invoice_no} — ₹${r2(Math.max(0, invoiceRefundable(r.invoice_id, r.id)))} so far.`);
  for (const it of items) { // goods back on the shelf (a combo pack returns each of its parts)
    if (!Number(it.restock)) continue;
    const bundle = db.prepare(`SELECT component_product_id, qty_per_bundle FROM product_bundles WHERE bundle_product_id = ?`).all(it.product_id);
    if (bundle.length) for (const c of bundle) addStockTxn(r.return_date, 'PRODUCT', c.component_product_id, Number(it.qty) * Number(c.qty_per_bundle), 'IN', 'SALE_RETURN', r.id, r.return_no);
    else addStockTxn(r.return_date, 'PRODUCT', it.product_id, Number(it.qty), 'IN', 'SALE_RETURN', r.id, r.return_no);
  }
  db.prepare(`UPDATE sales_returns SET status='Accepted', decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'), decision_note=?, refund_amount=?, refund_mode=?, refund_reference=? WHERE id=?`)
    .run(req.user.id, req.user.username, text(note, 300) || null, refundAmount, refundAmount > 0 ? (mode || 'Cash') : null, refundAmount > 0 ? text(ref, 80) : null, r.id);
  refreshInvoiceStatus(r.invoice_id);
  audit(req, 'UPDATE', 'sales_returns', r.id, { action: 'ACCEPTED', return_no: r.return_no, total: r.grand_total, refund: refundAmount });
  return db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(r.id);
}

router.post('/sales-returns', requireModule('customersSales'), wrap((req, res) => {
  const b = req.body || {};
  const invoiceId = Number(b.invoice_id); if (!invoiceId) throw new Bad('Choose the invoice the goods are being returned against.');
  const returnDate = date(b.return_date, 'Return date');
  if (!Array.isArray(b.items) || !b.items.length) throw new Bad('Enter the quantity being returned for at least one product.');
  const reason = text(b.reason, 200); if (reason.length < 3) throw new Bad('Please give the reason for the return.');
  const refundAmount = r2(b.refund_amount || 0); if (refundAmount < 0) throw new Bad('Refund cannot be negative.');
  if (refundAmount > 0 && !MODES.includes(b.refund_mode || 'Cash')) throw new Bad('Choose a valid refund mode.');
  const out = db.transaction(() => {
    const d = invoiceLines(invoiceId);
    if (returnDate < String(d.inv.invoice_date).slice(0, 10)) throw new Bad('The return date cannot be before the invoice date.');
    const picked = new Map();
    for (const it of b.items) {
      const qty = r3(it.qty); if (!(qty > 0)) continue;
      const l = d.lines.find((x) => x.product_id === Number(it.product_id)); if (!l) throw new Bad('One of the products is not on that invoice.');
      const total = r3((picked.get(l.product_id) || { qty: 0 }).qty + qty);
      if (total > l.available_qty + 1e-9) throw new Bad(`Only ${l.available_qty} ${l.unit || ''} of ${l.product_name} can still be returned on ${d.inv.invoice_no} (sold ${l.sold_qty}, already returned or pending ${r3(l.returned_qty + l.pending_qty)}).`);
      picked.set(l.product_id, { qty: total, restock: it.restock === false || it.restock === 0 || it.condition === 'Damaged' ? 0 : 1, line: l });
    }
    if (!picked.size) throw new Bad('Enter the quantity being returned for at least one product.');
    let taxable = 0; const rows = [];
    for (const [pid, p] of picked) { const amount = r2(p.qty * p.line.unit_net); taxable += amount; rows.push({ pid, qty: p.qty, rate: p.line.unit_net, amount, restock: p.restock }); }
    taxable = r2(taxable * d.factor);
    const gst = r2(taxable * Number(d.inv.gst_pct) / 100); const grand = r2(taxable + gst);
    if (refundAmount > grand + 0.005) throw new Bad('The refund cannot be more than the return value.');
    if (refundAmount > invoiceRefundable(invoiceId) + 0.005) throw new Bad(`You can only refund money the customer actually paid on ${d.inv.invoice_no} — ₹${r2(Math.max(0, invoiceRefundable(invoiceId)))} so far. For anything else, leave the refund at 0 (credit note).`);
    const no = nextNo('CRN-', 'sales_returns', 'return_no');
    const info = db.prepare(`INSERT INTO sales_returns (return_no,return_date,invoice_id,customer_id,reason,remarks,gst_pct,gst_type,subtotal,gst_amt,grand_total,refund_amount,refund_mode,refund_reference,created_by,created_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(no, returnDate, invoiceId, d.inv.customer_id, reason, text(b.remarks, 300) || null, Number(d.inv.gst_pct), d.inv.gst_type, taxable, gst, grand, refundAmount, refundAmount > 0 ? (b.refund_mode || 'Cash') : null, refundAmount > 0 ? text(b.refund_reference, 80) : null, req.user.id, req.user.username);
    const newId = idOf('sales_returns', no);
    for (const x of rows) db.prepare(`INSERT INTO sales_return_items (return_id,product_id,qty,rate,discount_pct,amount,restock) VALUES (?,?,?,?,?,?,?)`).run(newId, x.pid, x.qty, x.rate, 0, x.amount, x.restock);
    audit(req, 'CREATE', 'sales_returns', newId, { return_no: no, invoice: d.inv.invoice_no, total: grand });
    let row = db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(newId);
    if (b.accept_now && mayDecide(req)) row = applySalesReturn(req, row.id, {});
    return row;
  })();
  res.status(201).json({ ...out, items: salesReturnItems(out.id) });
}));
router.post('/sales-returns/:id/accept', requireModule('customersSales'), canDecide, wrap((req, res) => {
  const refund = req.body && req.body.refund_amount !== undefined && req.body.refund_amount !== '' ? { amount: req.body.refund_amount, mode: req.body.refund_mode, reference: req.body.refund_reference } : null;
  const row = db.transaction(() => applySalesReturn(req, Number(req.params.id), { note: req.body && req.body.note, refund }))();
  res.json(row);
}));
router.post('/sales-returns/:id/reject', requireModule('customersSales'), canDecide, wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Pending') throw new Bad(`This return was already ${r.status.toLowerCase()}.`, 409);
  const note = text(req.body && req.body.note, 300); if (note.length < 3) throw new Bad('Please give the reason for rejecting the return.');
  db.prepare(`UPDATE sales_returns SET status='Rejected', decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'), decision_note=? WHERE id=?`).run(req.user.id, req.user.username, note, r.id);
  audit(req, 'UPDATE', 'sales_returns', r.id, { action: 'REJECTED', note });
  res.json({ ok: true });
}));
/** Undo an ACCEPTED return (admin only): takes the goods back out of stock and puts the balance back. */
router.post('/sales-returns/:id/reverse', requireModule('customersSales'), requireRole('ADMIN'), wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Accepted') throw new Bad('Only an accepted return can be reversed.', 409);
  const note = text(req.body && req.body.note, 300); if (note.length < 3) throw new Bad('Please give the reason for reversing this return.');
  db.transaction(() => {
    db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'SALE_RETURN' AND ref_id = ?`).run(r.id);
    db.prepare(`UPDATE sales_returns SET status='Rejected', decision_note=?, decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS') WHERE id=?`).run(`Reversed: ${note}`, req.user.id, req.user.username, r.id);
    refreshInvoiceStatus(r.invoice_id);
    audit(req, 'UPDATE', 'sales_returns', r.id, { action: 'REVERSED', note });
  })();
  res.json({ ok: true });
}));
router.delete('/sales-returns/:id', requireModule('customersSales'), wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM sales_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status === 'Accepted') throw new Bad('An accepted return has updated stock and accounts. Ask an admin to reverse it instead of deleting it.', 409);
  if (r.status === 'Pending' && !mayDecide(req) && r.created_by !== req.user.id) throw new Bad('Only the person who raised this return, or a manager, can delete it.', 403);
  db.prepare(`DELETE FROM sales_returns WHERE id = ?`).run(r.id); audit(req, 'DELETE', 'sales_returns', r.id, { return_no: r.return_no });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Supplier returns
// ---------------------------------------------------------------------------
function purchaseInfo(purchaseId, excludeReturnId) {
  const p = db.prepare(`SELECT pu.*, s.name supplier_name, COALESCE(rm.name, pr.name) item_name, COALESCE(rm.unit, pr.unit) unit FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN raw_materials rm ON rm.id = pu.raw_material_id LEFT JOIN products pr ON pr.id = pu.product_id WHERE pu.id = ?`).get(purchaseId);
  if (!p) throw new Bad('Purchase not found.', 404);
  const x = (st) => Number(db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM purchase_returns WHERE purchase_id = ? AND status = ? ${excludeReturnId ? 'AND id <> ?' : ''}`).get(...[purchaseId, st, ...(excludeReturnId ? [excludeReturnId] : [])]).q) || 0;
  const accepted = x('Accepted'); const pending = x('Pending');
  const stockType = p.item_type === 'RAW_MATERIAL' ? 'RAW' : p.item_type === 'FINISHED_PRODUCT' ? 'PRODUCT' : null;
  const itemId = p.item_type === 'RAW_MATERIAL' ? p.raw_material_id : p.product_id;
  return { p, accepted, pending, available: r3(Number(p.qty) - accepted - pending), accepted_only_available: r3(Number(p.qty) - accepted), stockType, itemId, stock_on_hand: stockType && itemId ? r3(stockBalance(stockType, itemId)) : null };
}
const purchaseReturnRow = (id) => db.prepare(`SELECT r.*, s.name supplier_name, pu.purchase_no, COALESCE(rm.name, pr.name) item_name, COALESCE(rm.unit, pr.unit) unit FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN purchases pu ON pu.id = r.purchase_id LEFT JOIN raw_materials rm ON rm.id = r.raw_material_id LEFT JOIN products pr ON pr.id = r.product_id WHERE r.id = ?`).get(id);

router.get('/purchase-returns', requireModule('purchasesModule'), wrap((req, res) => {
  const where = []; const args = [];
  if (req.query.status) { where.push('r.status = ?'); args.push(String(req.query.status)); }
  if (req.query.purchase_id) { where.push('r.purchase_id = ?'); args.push(Number(req.query.purchase_id)); }
  if (req.query.supplier_id) { where.push('r.supplier_id = ?'); args.push(Number(req.query.supplier_id)); }
  res.json(db.prepare(`SELECT r.*, s.name supplier_name, pu.purchase_no, COALESCE(rm.name, pr.name) item_name, COALESCE(rm.unit, pr.unit) unit FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN purchases pu ON pu.id = r.purchase_id LEFT JOIN raw_materials rm ON rm.id = r.raw_material_id LEFT JOIN products pr ON pr.id = r.product_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.return_date DESC, r.id DESC`).all(...args));
}));
router.get('/purchase-returns/for-purchase/:purchaseId', requireModule('purchasesModule'), wrap((req, res) => {
  const i = purchaseInfo(Number(req.params.purchaseId));
  res.json({ purchase: { id: i.p.id, purchase_no: i.p.purchase_no, purchase_date: i.p.purchase_date, status: i.p.status, item_type: i.p.item_type, supplier_id: i.p.supplier_id, supplier_name: i.p.supplier_name, item_name: i.p.item_name, unit: i.p.unit, qty: Number(i.p.qty), rate: Number(i.p.rate), gst_pct: Number(i.p.gst_pct) }, returned_qty: r3(i.accepted), pending_qty: r3(i.pending), available_qty: i.available, stock_on_hand: i.stock_on_hand });
}));
router.get('/purchase-returns/:id', requireModule('purchasesModule'), wrap((req, res) => { const r = purchaseReturnRow(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404); res.json(r); }));

function applyPurchaseReturn(req, id, { note, refund } = {}) {
  const r = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(id);
  if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Pending') throw new Bad(`This return was already ${r.status.toLowerCase()}.`, 409);
  const i = purchaseInfo(r.purchase_id, r.id);
  if (Number(r.qty) > i.accepted_only_available + 1e-9) throw new Bad(`Cannot accept: only ${i.accepted_only_available} of ${i.p.item_name} can still be returned on ${i.p.purchase_no}.`);
  if (i.stockType && i.stock_on_hand < Number(r.qty) - 1e-9) throw new Bad(`Cannot send back ${r.qty} ${i.p.unit || ''} of ${i.p.item_name}: only ${i.stock_on_hand} is in stock (the rest has already been used or sold).`);
  let refundAmount = Number(r.refund_amount) || 0; let mode = r.refund_mode; let ref = r.refund_reference;
  if (refund) { refundAmount = r2(refund.amount); mode = refund.mode || mode; ref = refund.reference || ref; }
  if (refundAmount < 0 || refundAmount > Number(r.total) + 0.005) throw new Bad('The refund received cannot be more than the return value.');
  if (refundAmount > 0 && !MODES.includes(mode || 'Cash')) throw new Bad('Choose a valid refund mode.');
  if (refundAmount > purchaseRefundable(r.purchase_id, r.id) + 0.005) throw new Bad(`You can only record a refund up to what you actually paid the supplier on ${i.p.purchase_no} — ₹${r2(Math.max(0, purchaseRefundable(r.purchase_id, r.id)))} so far.`);
  if (i.stockType) addStockTxn(r.return_date, i.stockType, i.itemId, Number(r.qty), 'OUT', 'PURCHASE_RETURN', r.id, r.return_no);
  db.prepare(`UPDATE purchase_returns SET status='Accepted', decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'), decision_note=?, refund_amount=?, refund_mode=?, refund_reference=? WHERE id=?`)
    .run(req.user.id, req.user.username, text(note, 300) || null, refundAmount, refundAmount > 0 ? (mode || 'Cash') : null, refundAmount > 0 ? text(ref, 80) : null, r.id);
  audit(req, 'UPDATE', 'purchase_returns', r.id, { action: 'ACCEPTED', return_no: r.return_no, total: r.total, refund: refundAmount });
  return db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(r.id);
}
router.post('/purchase-returns', requireModule('purchasesModule'), wrap((req, res) => {
  const b = req.body || {};
  const purchaseId = Number(b.purchase_id); if (!purchaseId) throw new Bad('Choose the purchase the goods are being returned against.');
  const returnDate = date(b.return_date, 'Return date'); const qty = r3(b.qty);
  if (!(qty > 0)) throw new Bad('Enter the quantity being returned.');
  const reason = text(b.reason, 200); if (reason.length < 3) throw new Bad('Please give the reason for the return.');
  const refundAmount = r2(b.refund_amount || 0); if (refundAmount < 0) throw new Bad('Refund cannot be negative.');
  if (refundAmount > 0 && !MODES.includes(b.refund_mode || 'Cash')) throw new Bad('Choose a valid refund mode.');
  const out = db.transaction(() => {
    const i = purchaseInfo(purchaseId);
    if (i.p.item_type === 'ASSET') throw new Bad('A fixed-asset purchase cannot be returned here. Remove or adjust the asset in Fixed Assets.');
    if (i.p.status !== 'Received') throw new Bad('This purchase order has not been received yet, so there is nothing to return. Cancel the order instead.');
    if (returnDate < String(i.p.purchase_date).slice(0, 10)) throw new Bad('The return date cannot be before the purchase date.');
    if (qty > i.available + 1e-9) throw new Bad(`Only ${i.available} ${i.p.unit || ''} of ${i.p.item_name} can still be returned on ${i.p.purchase_no} (bought ${Number(i.p.qty)}, already returned or pending ${r3(i.accepted + i.pending)}).`);
    const amount = r2(qty * Number(i.p.rate)); const gst = r2(amount * Number(i.p.gst_pct) / 100); const total = r2(amount + gst);
    if (refundAmount > total + 0.005) throw new Bad('The refund received cannot be more than the return value.');
    if (refundAmount > purchaseRefundable(purchaseId) + 0.005) throw new Bad(`You can only record a refund up to what you actually paid the supplier on ${i.p.purchase_no} — ₹${r2(Math.max(0, purchaseRefundable(purchaseId)))} so far. For anything else, leave the refund at 0 (debit note).`);
    const no = nextNo('DBN-', 'purchase_returns', 'return_no');
    const info = db.prepare(`INSERT INTO purchase_returns (return_no,return_date,purchase_id,supplier_id,item_type,raw_material_id,product_id,qty,rate,amount,gst_pct,gst_amt,total,reason,remarks,refund_amount,refund_mode,refund_reference,created_by,created_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(no, returnDate, purchaseId, i.p.supplier_id, i.p.item_type, i.p.raw_material_id || null, i.p.product_id || null, qty, Number(i.p.rate), amount, Number(i.p.gst_pct), gst, total, reason, text(b.remarks, 300) || null, refundAmount, refundAmount > 0 ? (b.refund_mode || 'Cash') : null, refundAmount > 0 ? text(b.refund_reference, 80) : null, req.user.id, req.user.username);
    const newId = idOf('purchase_returns', no);
    audit(req, 'CREATE', 'purchase_returns', newId, { return_no: no, purchase: i.p.purchase_no, total });
    let row = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(newId);
    if (b.accept_now && mayDecide(req)) row = applyPurchaseReturn(req, row.id, {});
    return row;
  })();
  res.status(201).json(purchaseReturnRow(out.id));
}));
router.post('/purchase-returns/:id/accept', requireModule('purchasesModule'), canDecide, wrap((req, res) => {
  const refund = req.body && req.body.refund_amount !== undefined && req.body.refund_amount !== '' ? { amount: req.body.refund_amount, mode: req.body.refund_mode, reference: req.body.refund_reference } : null;
  res.json(db.transaction(() => applyPurchaseReturn(req, Number(req.params.id), { note: req.body && req.body.note, refund }))());
}));
router.post('/purchase-returns/:id/reject', requireModule('purchasesModule'), canDecide, wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Pending') throw new Bad(`This return was already ${r.status.toLowerCase()}.`, 409);
  const note = text(req.body && req.body.note, 300); if (note.length < 3) throw new Bad('Please give the reason for rejecting the return.');
  db.prepare(`UPDATE purchase_returns SET status='Rejected', decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'), decision_note=? WHERE id=?`).run(req.user.id, req.user.username, note, r.id);
  audit(req, 'UPDATE', 'purchase_returns', r.id, { action: 'REJECTED', note }); res.json({ ok: true });
}));
router.post('/purchase-returns/:id/reverse', requireModule('purchasesModule'), requireRole('ADMIN'), wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status !== 'Accepted') throw new Bad('Only an accepted return can be reversed.', 409);
  const note = text(req.body && req.body.note, 300); if (note.length < 3) throw new Bad('Please give the reason for reversing this return.');
  db.transaction(() => {
    db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'PURCHASE_RETURN' AND ref_id = ?`).run(r.id);
    db.prepare(`UPDATE purchase_returns SET status='Rejected', decision_note=?, decided_by=?, decided_by_name=?, decided_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS') WHERE id=?`).run(`Reversed: ${note}`, req.user.id, req.user.username, r.id);
    audit(req, 'UPDATE', 'purchase_returns', r.id, { action: 'REVERSED', note });
  })();
  res.json({ ok: true });
}));
router.delete('/purchase-returns/:id', requireModule('purchasesModule'), wrap((req, res) => {
  const r = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(Number(req.params.id)); if (!r) throw new Bad('Return not found.', 404);
  if (r.status === 'Accepted') throw new Bad('An accepted return has updated stock and accounts. Ask an admin to reverse it instead of deleting it.', 409);
  if (r.status === 'Pending' && !mayDecide(req) && r.created_by !== req.user.id) throw new Bad('Only the person who raised this return, or a manager, can delete it.', 403);
  db.prepare(`DELETE FROM purchase_returns WHERE id = ?`).run(r.id); audit(req, 'DELETE', 'purchase_returns', r.id, { return_no: r.return_no }); res.json({ ok: true });
}));

module.exports = router;
/** What the customer owed before this invoice: other invoices minus their returns, minus money received (net of refunds). */
function customerBalanceExcluding(customerId, invoiceId) {
  const billed = Number(db.prepare(`SELECT COALESCE(SUM(grand_total),0) v FROM sales_invoices WHERE customer_id = ? AND id != ?`).get(customerId, invoiceId).v);
  const ret = db.prepare(`SELECT COALESCE(SUM(grand_total),0) v, COALESCE(SUM(refund_amount),0) f FROM sales_returns WHERE customer_id = ? AND status = 'Accepted' AND invoice_id != ?`).get(customerId, invoiceId);
  const received = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE customer_id = ? AND (invoice_id IS NULL OR invoice_id != ?)`).get(customerId, invoiceId).v) - Number(ret.f);
  return billed - Number(ret.v) - received;
}
module.exports.helpers = { customerBalanceExcluding, computeInvoiceStatus, refreshInvoiceStatus, invoiceReturned, invoiceRefunded, purchaseReturned, purchaseRefunded, customerRefunds, supplierRefunds };
