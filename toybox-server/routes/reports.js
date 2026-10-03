// ============================================================================
// routes/reports.js — dashboard, pipeline, ledgers, simplified accounts, audit
// ============================================================================
const express = require('express');
const { db, stockBalance, stockBalanceAsOf, avgPurchaseRate } = require('../db');
const { requireModule } = require('../auth');
const { bookValueAsOf, assetWithCategory, taxBlockNames, taxBlockSchedule, lastCompletedFy, todayStr, fyBounds } = require('./assets');
const { totalLoanOutstanding, loanInterestInPeriod, totalLoanCashFlow } = require('./loans');
const router = express.Router();

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthsBack(n) {
  const arr = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Sales & Purchase totals — Daily / Monthly / Yearly, used by the Sales and
// Purchase modules' header KPIs and by the Reports module.
// ---------------------------------------------------------------------------
router.get('/sales-purchase-summary', (req, res) => {
  const today = localDateStr(new Date());
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  const salesDaily = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n, COUNT(*) FILTER (WHERE doc_type='INVOICE') c FROM sales_net WHERE invoice_date = ?`).get(today);
  const salesMonthly = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n, COUNT(*) FILTER (WHERE doc_type='INVOICE') c FROM sales_net WHERE strftime('%Y-%m', invoice_date) = ?`).get(month);
  const salesYearly = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n, COUNT(*) FILTER (WHERE doc_type='INVOICE') c FROM sales_net WHERE strftime('%Y', invoice_date) = ?`).get(year);
  const purchDaily = db.prepare(`SELECT COALESCE(SUM(amount),0) n, COUNT(*) FILTER (WHERE doc_type='PURCHASE') c FROM purchases_net WHERE purchase_date = ?`).get(today);
  const purchMonthly = db.prepare(`SELECT COALESCE(SUM(amount),0) n, COUNT(*) FILTER (WHERE doc_type='PURCHASE') c FROM purchases_net WHERE strftime('%Y-%m', purchase_date) = ?`).get(month);
  const purchYearly = db.prepare(`SELECT COALESCE(SUM(amount),0) n, COUNT(*) FILTER (WHERE doc_type='PURCHASE') c FROM purchases_net WHERE strftime('%Y', purchase_date) = ?`).get(year);
  res.json({
    today, month, year,
    sales: { daily: salesDaily.n, dailyCount: salesDaily.c, monthly: salesMonthly.n, monthlyCount: salesMonthly.c, yearly: salesYearly.n, yearlyCount: salesYearly.c },
    purchase: { daily: purchDaily.n, dailyCount: purchDaily.c, monthly: purchMonthly.n, monthlyCount: purchMonthly.c, yearly: purchYearly.n, yearlyCount: purchYearly.c },
  });
});

// ---------------------------------------------------------------------------
// Customer's previous/outstanding balance — used when creating a new Sales
// Invoice or Receipt, so the previous balance due can be shown (and folded
// into the printed invoice) before this transaction is even saved. Pass
// exclude_invoice_id when editing an existing invoice, so that invoice's own
// amount/receipts don't count as part of its own "previous" balance.
// ---------------------------------------------------------------------------
router.get('/customer-balance/:id', requireModule('customersSales'), (req, res) => {
  const id = req.params.id;
  const exclude = req.query.exclude_invoice_id;
  let billedSql = `SELECT COALESCE(SUM(grand_total),0) v FROM sales_invoices WHERE customer_id = ?`;
  const billedParams = [id];
  if (exclude) { billedSql += ` AND id != ?`; billedParams.push(exclude); }
  const billedGross = Number(db.prepare(billedSql).get(...billedParams).v);
  let retSql = `SELECT COALESCE(SUM(grand_total),0) v, COALESCE(SUM(refund_amount),0) f FROM sales_returns WHERE customer_id = ? AND status = 'Accepted'`;
  const retParams = [id];
  if (exclude) { retSql += ` AND invoice_id != ?`; retParams.push(exclude); }
  const ret = db.prepare(retSql).get(...retParams);
  let receivedSql = `SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE customer_id = ?`;
  const receivedParams = [id];
  if (exclude) { receivedSql += ` AND (invoice_id IS NULL OR invoice_id != ?)`; receivedParams.push(exclude); }
  const received = Number(db.prepare(receivedSql).get(...receivedParams).v) - Number(ret.f);
  const billed = billedGross - Number(ret.v); // net of goods returned (credit notes)
  res.json({ billed, returned: Number(ret.v), received, balance: billed - received });
});

// ---------------------------------------------------------------------------
// Dashboard — KPIs + trend series
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const today = localDateStr(new Date());
  const totalEmployees = db.prepare(`SELECT COUNT(*) n FROM employees WHERE active = 1`).get().n;
  const todayProd = db.prepare(`SELECT COALESCE(SUM(produced_qty),0) n FROM production WHERE date = ?`).get(today).n;
  const yestProd = db.prepare(`SELECT COALESCE(SUM(produced_qty),0) n FROM production WHERE date = date(?, '-1 day')`).get(today).n;
  const products = db.prepare(`SELECT id FROM products WHERE active = 1`).all();
  const totalFinished = products.reduce((s, p) => s + stockBalance('PRODUCT', p.id), 0);
  const rawMats = db.prepare(`SELECT * FROM raw_materials WHERE active = 1`).all().map((m) => ({ ...m, stock: stockBalance('RAW', m.id) }));
  const lowStock = rawMats.filter((m) => m.stock < m.min_stock);
  const rawMaterialStock = rawMats.sort((a, b) => b.stock - a.stock).slice(0, 8).map((m) => ({ name: m.name, stock: m.stock, min_stock: m.min_stock, unit: m.unit }));
  const todaySales = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n, COUNT(*) FILTER (WHERE doc_type='INVOICE') c FROM sales_net WHERE invoice_date = ?`).get(today);
  const totalSales = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n FROM sales_net`).get().n;
  const totalReceived = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM receipts`).get().n) - Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) n FROM sales_returns WHERE status = 'Accepted'`).get().n);
  const receivables = totalSales - totalReceived;
  const pendingSalesOrders = db.prepare(`SELECT COUNT(*) n FROM sales_invoices WHERE status NOT IN ('Paid','Returned')`).get().n;
  const pendingPurchases = db.prepare(`SELECT COUNT(*) n FROM purchases`).get().n;
  const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const totalPayrollNet = db.prepare(`SELECT COALESCE(SUM(net),0) n FROM payroll WHERE pay_month = ?`).get(currentMonth).n;
  const totalPurchaseValue = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM purchases_net`).get().n;
  const pendingOutsourcing = db.prepare(`SELECT COUNT(*) n FROM outsourcing_jobs WHERE status != 'Completed'`).get().n;

  const months = monthsBack(6);
  const salesTrend = months.map((m) => db.prepare(`SELECT COALESCE(SUM(grand_total),0) n FROM sales_net WHERE strftime('%Y-%m', invoice_date) = ?`).get(m).n);
  const purchTrend = months.map((m) => db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM purchases_net WHERE strftime('%Y-%m', purchase_date) = ?`).get(m).n);
  const payrollTrend = months.map((m) => db.prepare(`SELECT COALESCE(SUM(net),0) n FROM payroll WHERE pay_month = ?`).get(m).n);
  const profitTrend = months.map((m, i) => salesTrend[i] - purchTrend[i] - payrollTrend[i]);
  const prodQtyTrend = months.map((m) => db.prepare(`SELECT COALESCE(SUM(produced_qty - defective_qty),0) n FROM production WHERE strftime('%Y-%m', date) = ?`).get(m).n);

  const topProducts = db.prepare(`
    SELECT p.name, p.unit,
      COALESCE(SUM(x.qty),0) qty, COALESCE(SUM(x.amount),0) revenue
    FROM products p JOIN (
      SELECT si.product_id, si.qty, si.amount FROM sales_items si JOIN sales_invoices inv ON inv.id = si.invoice_id
      UNION ALL
      SELECT ri.product_id, -ri.qty, -ri.amount FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id WHERE r.status = 'Accepted'
    ) x ON x.product_id = p.id
    GROUP BY p.id ORDER BY revenue DESC LIMIT 5`).all();

  const ninetyDaysAgo = localDateStr(new Date(Date.now() - 90 * 86400000));
  const prodMix = db.prepare(`
    SELECT p.name, COALESCE(SUM(pr.produced_qty - pr.defective_qty),0) qty
    FROM products p LEFT JOIN production pr ON pr.product_id = p.id AND pr.date >= ?
    WHERE p.active = 1 GROUP BY p.id ORDER BY qty DESC LIMIT 6`).all(ninetyDaysAgo);

  res.json({
    totalEmployees, todayProd, prodTrendPct: yestProd > 0 ? Math.round(((todayProd - yestProd) / yestProd) * 100) : 0,
    totalFinished, lowStockCount: lowStock.length, lowStockItems: lowStock.slice(0, 6), rawMaterialStock,
    todaySalesAmt: todaySales.n, todaySalesCount: todaySales.c, totalSales, totalReceived, receivables,
    pendingSalesOrders, pendingPurchases, totalPayrollNet, totalPurchaseValue, pendingOutsourcing,
    months, salesTrend, purchTrend, profitTrend, prodQtyTrend, prodMix, topProducts,
  });
});

// ---------------------------------------------------------------------------
// Production pipeline — qty currently at each internal stage + outsourced
// ---------------------------------------------------------------------------
router.get('/pipeline', (req, res) => {
  const stages = db.prepare(`SELECT name FROM pipeline_stages WHERE active = 1 ORDER BY sort_order ASC, id ASC`).all().map((r) => r.name);
  const result = stages.map((stage, i) => {
    const inhouse = db.prepare(`SELECT COALESCE(SUM(qty_in),0) i, COALESCE(SUM(qty_out),0) o FROM production_stages WHERE stage = ?`).get(stage);
    const outsourced = db.prepare(`SELECT COALESCE(SUM(qty_sent),0) s, COALESCE(SUM(qty_received),0) r FROM outsourcing_jobs WHERE stage = ?`).get(stage);
    const completedOutput = inhouse.o + outsourced.r;
    let sentToNextStage = 0;
    const nextStage = stages[i + 1];
    if (nextStage) {
      const nextIn = db.prepare(`SELECT COALESCE(SUM(qty_in),0) v FROM production_stages WHERE stage = ?`).get(nextStage).v;
      const nextSent = db.prepare(`SELECT COALESCE(SUM(qty_sent),0) v FROM outsourcing_jobs WHERE stage = ?`).get(nextStage).v;
      sentToNextStage = nextIn + nextSent;
    }
    return {
      stage,
      atStage: Math.max(0, (inhouse.i - inhouse.o) + (outsourced.s - outsourced.r)),
      inhouseProcessed: inhouse.o,
      outsourcedPending: Math.max(0, outsourced.s - outsourced.r),
      completedOutput,
      sentToNextStage: nextStage ? sentToNextStage : completedOutput, // Packing has no "next" — its output goes to finished goods
      pendingForNextStage: nextStage ? Math.max(0, completedOutput - sentToNextStage) : 0,
    };
  });
  const finishedGoods = db.prepare(`SELECT p.id, p.name, p.unit FROM products p WHERE p.active = 1`).all()
    .reduce((s, p) => s + stockBalance('PRODUCT', p.id), 0);
  res.json({ stages: result, finishedGoods });
});
router.get('/pipeline/stage/:stage/breakdown', (req, res) => {
  const stage = req.params.stage;
  const byPerson = db.prepare(`
    SELECT op.name person_name, COALESCE(SUM(j.qty_received),0) qty, COALESCE(SUM(j.amount),0) amount
    FROM outsourcing_jobs j JOIN outsourcing_persons op ON op.id = j.person_id
    WHERE j.stage = ? AND j.qty_received > 0 GROUP BY j.person_id, op.name ORDER BY qty DESC`).all(stage);
  const inhouse = db.prepare(`SELECT COALESCE(SUM(qty_out),0) v FROM production_stages WHERE stage = ?`).get(stage).v;
  res.json({ stage, byPerson, inhouseQty: inhouse });
});

// ---------------------------------------------------------------------------
// Ledgers — customer & supplier running account statements
// ---------------------------------------------------------------------------
router.get('/ledger/customer/:id', requireModule('customersSales'), (req, res) => {
  const id = req.params.id;
  const invoices = db.prepare(`SELECT invoice_date date, invoice_no ref, grand_total amt, 'Invoice' type FROM sales_invoices WHERE customer_id = ?`).all(id);
  const receipts = db.prepare(`SELECT date, receipt_no ref, amount amt, 'Receipt' type FROM receipts WHERE customer_id = ?`).all(id);
  const credits = db.prepare(`SELECT return_date date, return_no ref, grand_total amt, 'Credit Note (Return)' type FROM sales_returns WHERE customer_id = ? AND status = 'Accepted'`).all(id);
  const refunds = db.prepare(`SELECT return_date date, return_no || ' refund' ref, refund_amount amt, 'Refund Paid' type FROM sales_returns WHERE customer_id = ? AND status = 'Accepted' AND refund_amount > 0`).all(id);
  const entries = [...invoices.map((r) => ({ ...r, debit: r.amt, credit: 0 })), ...receipts.map((r) => ({ ...r, debit: 0, credit: r.amt })), ...credits.map((r) => ({ ...r, debit: 0, credit: r.amt })), ...refunds.map((r) => ({ ...r, debit: r.amt, credit: 0 }))]
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let bal = 0;
  const withBalance = entries.map((e) => { bal += e.debit - e.credit; return { ...e, balance: bal }; });
  res.json(withBalance);
});
router.get('/ledger/supplier/:id', (req, res) => {
  const id = req.params.id;
  const purchases = db.prepare(`SELECT purchase_date date, purchase_no ref, (amount + gst_amt) amt, 'Purchase' type FROM purchases WHERE supplier_id = ?`).all(id);
  const payments = db.prepare(`SELECT date, 'PAY-' || id ref, amount amt, 'Payment' type FROM supplier_payments WHERE supplier_id = ?`).all(id);
  const debitNotes = db.prepare(`SELECT return_date date, return_no ref, total amt, 'Debit Note (Return)' type FROM purchase_returns WHERE supplier_id = ? AND status = 'Accepted'`).all(id);
  const refundsIn = db.prepare(`SELECT return_date date, return_no || ' refund' ref, refund_amount amt, 'Refund Received' type FROM purchase_returns WHERE supplier_id = ? AND status = 'Accepted' AND refund_amount > 0`).all(id);
  const entries = [...purchases.map((r) => ({ ...r, debit: 0, credit: r.amt })), ...payments.map((r) => ({ ...r, debit: r.amt, credit: 0 })), ...debitNotes.map((r) => ({ ...r, debit: r.amt, credit: 0 })), ...refundsIn.map((r) => ({ ...r, debit: 0, credit: r.amt }))]
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let bal = 0;
  const withBalance = entries.map((e) => { bal += e.credit - e.debit; return { ...e, balance: bal }; });
  res.json(withBalance);
});

// ---------------------------------------------------------------------------
// Other operational reports
// ---------------------------------------------------------------------------
router.get('/customer-due', requireModule('customersSales'), (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COALESCE((SELECT SUM(grand_total) FROM sales_net WHERE customer_id = c.id),0) billed,
      COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.customer_id = c.id),0)
        - COALESCE((SELECT SUM(refund_amount) FROM sales_returns WHERE customer_id = c.id AND status = 'Accepted'),0) received
    FROM customers c WHERE c.active = 1 ORDER BY c.name`).all()
    .map((r) => ({ ...r, balance: r.billed - r.received }));
  res.json(rows);
});
router.get('/supplier-due', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COALESCE((SELECT SUM(amount + gst_amt) FROM purchases_net WHERE supplier_id = s.id),0) purchased,
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id = s.id),0)
        - COALESCE((SELECT SUM(refund_amount) FROM purchase_returns WHERE supplier_id = s.id AND status = 'Accepted'),0) paid
    FROM suppliers s WHERE s.active = 1 ORDER BY s.name`).all()
    .map((r) => ({ ...r, balance: r.purchased - r.paid }));
  res.json(rows);
});
router.get('/stock', (req, res) => {
  const products = db.prepare(`SELECT * FROM products WHERE active = 1`).all().map((p) => ({ ...p, stock: stockBalance('PRODUCT', p.id) }));
  const raw = db.prepare(`SELECT * FROM raw_materials WHERE active = 1`).all().map((m) => ({ ...m, stock: stockBalance('RAW', m.id) }));
  res.json({ products, raw });
});

router.get('/production-output/:employeeId', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const employee = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(req.params.employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const output = db.prepare(`
    SELECT COALESCE(SUM(produced_qty - defective_qty),0) v FROM production
    WHERE operator_id = ? AND strftime('%Y-%m', date) = ?`).get(req.params.employeeId, month).v;
  res.json({ employeeId: Number(req.params.employeeId), month, output, pieceRate: Number(employee.piece_rate || 0), suggestedBasic: output * Number(employee.piece_rate || 0) });
});
router.get('/employee-summary/:id', (req, res) => {
  const employee = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const attendance = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 60`).all(req.params.id);
  const production = db.prepare(`
    SELECT pr.*, p.name product_name, p.unit FROM production pr JOIN products p ON p.id = pr.product_id
    WHERE pr.operator_id = ? ORDER BY pr.date DESC LIMIT 60`).all(req.params.id);
  const advances = db.prepare(`SELECT * FROM advances WHERE employee_id = ? ORDER BY date DESC`).all(req.params.id);
  const payroll = db.prepare(`SELECT * FROM payroll WHERE employee_id = ? ORDER BY pay_month DESC`).all(req.params.id);
  const payments = db.prepare(`
    SELECT pp.*, pr.payroll_no, pr.pay_month FROM payroll_payments pp JOIN payroll pr ON pr.id = pp.payroll_id
    WHERE pp.employee_id = ? ORDER BY pp.date DESC`).all(req.params.id);
  // Production-based (piece-rate) performance — total good units produced
  // this calendar month vs. the employee's monthly target.
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const thisMonthOutput = db.prepare(`
    SELECT COALESCE(SUM(produced_qty - defective_qty),0) v FROM production WHERE operator_id = ? AND date >= ?`).get(req.params.id, monthStart).v;
  const target = Number(employee.monthly_target_qty || 0);
  const achievementPct = target > 0 ? Math.round((thisMonthOutput / target) * 100) : null;
  res.json({ employee, attendance, production, advances, payroll, payments, performance: { thisMonthOutput, target, achievementPct } });
});
router.get('/product-history/:id', (req, res) => {
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  // Production history — every batch of this product ever produced.
  const production = db.prepare(`
    SELECT date, batch_no, shift, produced_qty, defective_qty, (produced_qty - defective_qty) good_qty
    FROM production WHERE product_id = ? ORDER BY date DESC, id DESC`).all(req.params.id);
  // Sales history — every invoice line this product was sold on.
  const sales = db.prepare(`
    SELECT s.invoice_date date, s.invoice_no, c.name customer_name, si.qty, si.rate, si.amount
    FROM sales_items si JOIN sales_invoices s ON s.id = si.invoice_id JOIN customers c ON c.id = s.customer_id
    WHERE si.product_id = ? ORDER BY s.invoice_date DESC, si.id DESC`).all(req.params.id);
  // Purchase history — finished products bought directly through Purchase Orders.
  const purchases = db.prepare(`
    SELECT pu.*, s.name supplier_name FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
    WHERE pu.product_id = ? ORDER BY pu.purchase_date DESC, pu.id DESC`).all(req.params.id);
  const returns = db.prepare(`
    SELECT r.return_date date, r.return_no, c.name customer_name, ri.qty, ri.amount, ri.restock
    FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id JOIN customers c ON c.id = r.customer_id
    WHERE ri.product_id = ? AND r.status = 'Accepted' ORDER BY r.return_date DESC, ri.id DESC`).all(req.params.id);
  const totalProduced = production.reduce((s, p) => s + Number(p.good_qty || 0), 0);
  const totalReturned = returns.reduce((s, r) => s + Number(r.qty || 0), 0);
  const totalSold = sales.reduce((s, r) => s + Number(r.qty || 0), 0) - totalReturned; // net of customer returns
  const totalPurchased = purchases.reduce((s, r) => s + Number(r.qty || 0), 0);
  res.json({ product, production, sales, returns, totalReturned, purchases, totalProduced, totalSold, totalPurchased, currentStock: stockBalance('PRODUCT', product.id) });
});
router.get('/material-purchase-history/:id', (req, res) => {
  const material = db.prepare(`SELECT * FROM raw_materials WHERE id = ?`).get(req.params.id);
  if (!material) return res.status(404).json({ error: 'Material not found' });
  const purchases = db.prepare(`
    SELECT pu.*, s.name supplier_name FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
    WHERE pu.raw_material_id = ? ORDER BY pu.purchase_date DESC, pu.id DESC`).all(req.params.id);
  const totalQty = purchases.reduce((s, p) => s + Number(p.qty), 0);
  const totalAmount = purchases.reduce((s, p) => s + Number(p.amount), 0);
  const averageRate = totalQty > 0 ? totalAmount / totalQty : 0;
  res.json({ material, purchases, totalQty, totalAmount, averageRate, currentStock: stockBalance('RAW', material.id) });
});
router.get('/material-usage', (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`SELECT * FROM raw_materials WHERE active = 1 ORDER BY name`).all().map((m) => {
    let sql = `SELECT COALESCE(SUM(qty),0) v FROM stock_txn WHERE item_type='RAW' AND item_id=? AND direction='OUT'`;
    const params = [m.id];
    if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
    if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
    const used = db.prepare(sql).get(...params).v;
    let purSql = `SELECT COALESCE(SUM(qty),0) v FROM stock_txn WHERE item_type='RAW' AND item_id=? AND direction='IN'`;
    const purParams = [m.id];
    if (from) { purSql += ` AND txn_date >= ?`; purParams.push(from); }
    if (to) { purSql += ` AND txn_date <= ?`; purParams.push(to); }
    const purchased = db.prepare(purSql).get(...purParams).v;
    return { id: m.id, name: m.name, unit: m.unit, used, purchased, currentStock: stockBalance('RAW', m.id) };
  });
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Simplified accounts — Trial Balance, P&L, Balance Sheet, Cash & Bank, GST
// ---------------------------------------------------------------------------
function computeAccounts() {
  const totalSales = db.prepare(`SELECT COALESCE(SUM(subtotal),0) sub, COALESCE(SUM(gst_amt),0) gst, COALESCE(SUM(grand_total),0) tot FROM sales_net`).get();
  const customerRefundsPaid = Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) n FROM sales_returns WHERE status = 'Accepted'`).get().n);
  const supplierRefundsReceived = Number(db.prepare(`SELECT COALESCE(SUM(refund_amount),0) n FROM purchase_returns WHERE status = 'Accepted'`).get().n);
  const receiptsGross = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM receipts`).get().n);
  const totalReceived = receiptsGross - customerRefundsPaid; // customer money kept (refunds paid out are not income)
  const totalPurchases = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM purchases_net`).get().n;
  // Input GST — the tax paid on purchases, recoverable against Output GST
  // collected on sales, so it's tracked separately from the raw-material
  // expense line (COGS) rather than folded into it. What's actually owed to
  // suppliers, though, DOES include this tax, so the Accounts Payable
  // liability below adds it back on.
  const totalInputGst = db.prepare(`SELECT COALESCE(SUM(gst_amt),0) n FROM purchases_net`).get().n;
  const totalSupplierPaid = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM supplier_payments`).get().n) - supplierRefundsReceived; // net of refunds the suppliers gave back
  const totalPayroll = db.prepare(`SELECT COALESCE(SUM(net),0) n FROM payroll`).get().n;
  const totalOutsourcingPaid = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM outsourcing_payments`).get().n;
  const totalAdvances = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM advances WHERE adjusted = 0`).get().n;
  const totalExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM expenses`).get().n;

  // Fixed assets (net book value, Companies Act SLM, live as of today) and
  // the resulting deferred tax — see routes/assets.js for the full
  // Companies-Act-vs-Income-Tax-Act depreciation logic.
  const today = todayStr();
  const assetRows = db.prepare(`SELECT id FROM assets`).all();
  const totalFixedAssetsBookValue = assetRows.reduce((s, a) => s + bookValueAsOf(assetWithCategory(a.id), today).bookValue, 0);
  const deferredTaxFy = lastCompletedFy();
  const taxRateRow = db.prepare(`SELECT corporate_tax_rate_pct FROM company_settings WHERE id = 1`).get();
  const corpTaxRate = Number(taxRateRow?.corporate_tax_rate_pct || 25);
  const totalTaxWDV = taxBlockNames().reduce((s, name) => s + taxBlockSchedule(name, deferredTaxFy).closingWDV, 0);
  const assetTimingDiff = totalFixedAssetsBookValue - totalTaxWDV;
  const deferredTaxLiability = Math.max(0, assetTimingDiff) * corpTaxRate / 100;
  const deferredTaxAsset = Math.max(0, -assetTimingDiff) * corpTaxRate / 100;

  const cashIn = totalReceived;
  const cashOut = totalSupplierPaid + totalPayroll + totalOutsourcingPaid + totalAdvances + totalExpenses;
  const loanCash = totalLoanCashFlow();
  const cashBalance = (cashIn + loanCash.disbursed) - (cashOut + loanCash.repaid);

  const revenue = totalSales.sub;
  const expenses = totalPurchases + totalPayroll + totalOutsourcingPaid + totalExpenses;
  const netProfit = revenue - expenses;

  const loansOutstanding = totalLoanOutstanding();

  const trialBalance = [
    { head: 'Sales (Revenue)', debit: 0, credit: revenue },
    { head: 'Output GST Payable', debit: 0, credit: totalSales.gst },
    { head: 'Purchases (Raw Material)', debit: totalPurchases, credit: 0 },
    { head: 'Input GST Credit (recoverable)', debit: totalInputGst, credit: 0 },
    { head: 'Payroll Expense', debit: totalPayroll, credit: 0 },
    { head: 'Outsourcing / Jobwork Expense', debit: totalOutsourcingPaid, credit: 0 },
    { head: 'Overhead Expenses (Rent, Utilities, etc.)', debit: totalExpenses, credit: 0 },
    { head: 'Fixed Assets (Net Book Value)', debit: totalFixedAssetsBookValue, credit: 0 },
    { head: 'Accounts Receivable', debit: Math.max(0, totalSales.tot - totalReceived), credit: 0 },
    { head: 'Accounts Payable (Suppliers, incl. GST)', debit: 0, credit: Math.max(0, (totalPurchases + totalInputGst) - totalSupplierPaid) },
    { head: 'Loans Payable (Bank / Fintech)', debit: 0, credit: loansOutstanding },
    { head: 'Deferred Tax Liability', debit: 0, credit: deferredTaxLiability },
    { head: 'Deferred Tax Asset', debit: deferredTaxAsset, credit: 0 },
    { head: 'Cash & Bank', debit: Math.max(0, cashBalance), credit: 0 },
  ];

  const months = monthsBack(6);
  const plTrend = months.map((m) => {
    const rev = db.prepare(`SELECT COALESCE(SUM(subtotal),0) n FROM sales_net WHERE strftime('%Y-%m',invoice_date)=?`).get(m).n;
    const pur = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM purchases_net WHERE strftime('%Y-%m',purchase_date)=?`).get(m).n;
    const pay = db.prepare(`SELECT COALESCE(SUM(net),0) n FROM payroll WHERE pay_month=?`).get(m).n;
    const exp = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE strftime('%Y-%m',date)=?`).get(m).n;
    return { month: m, revenue: rev, expense: pur + pay + exp, profit: rev - pur - pay - exp };
  });

  // Month-wise Output GST (from sales) vs Input GST (from purchases) — the
  // detail view behind the Tax Summary report's headline balance.
  const gstMonths = monthsBack(6).map((m) => {
    const out = db.prepare(`SELECT COALESCE(SUM(gst_amt),0) n FROM sales_net WHERE strftime('%Y-%m',invoice_date)=?`).get(m).n;
    const inp = db.prepare(`SELECT COALESCE(SUM(gst_amt),0) n FROM purchases_net WHERE strftime('%Y-%m',purchase_date)=?`).get(m).n;
    return { month: m, outputGst: out, inputGst: inp, netPayable: out - inp };
  });

  return {
    trialBalance, revenue, expenses, netProfit, plTrend,
    balanceSheet: {
      assets: { cashAndBank: Math.max(0, cashBalance), receivables: Math.max(0, totalSales.tot - totalReceived), rawMaterialAtCost: totalPurchases, inputTaxCredit: totalInputGst, fixedAssetsNetBookValue: totalFixedAssetsBookValue, deferredTaxAsset },
      liabilities: { payables: Math.max(0, (totalPurchases + totalInputGst) - totalSupplierPaid), outstandingAdvances: totalAdvances, loansPayable: loansOutstanding, deferredTaxLiability },
    },
    deferredTax: { fy: deferredTaxFy, taxRate: corpTaxRate, totalFixedAssetsBookValue, totalTaxWDV, timingDifference: assetTimingDiff, deferredTaxLiability, deferredTaxAsset },
    gstSummary: { outputGst: totalSales.gst, inputGst: totalInputGst, netTaxPayable: totalSales.gst - totalInputGst, taxableSales: totalSales.sub, taxablePurchases: totalPurchases, gstMonths },
    cashBook: { cashIn: cashIn + loanCash.disbursed, cashOut: cashOut + loanCash.repaid, cashBalance, loanDisbursed: loanCash.disbursed, loanRepaid: loanCash.repaid },
  };
}
router.get('/accounts', (req, res) => {
  res.json(computeAccounts());
});

// ---------------------------------------------------------------------------
// Profit & Loss — Screener.in-style waterfall, manufacturing-specific
// (Raw Material Consumed, Employee Benefits, Outsourcing/Job Work, Other
// Overheads → Operating Profit/EBITDA → Other Income/Interest/Depreciation
// → PBT → Tax → PAT), with an optional comparison period.
// ---------------------------------------------------------------------------
function dayBefore(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}
function rawMaterialStockValueAsOf(asOf) {
  const materials = db.prepare(`SELECT id FROM raw_materials`).all();
  return materials.reduce((sum, m) => sum + stockBalanceAsOf('RAW', m.id, asOf) * avgPurchaseRate(m.id), 0);
}
function totalDepreciationAsOf(asOf) {
  const assets = db.prepare(`SELECT id, purchase_date FROM assets`).all();
  return assets.reduce((sum, a) => {
    if (a.purchase_date > asOf) return sum; // not yet acquired as of this date
    return sum + bookValueAsOf(assetWithCategory(a.id), asOf).accumulatedDep;
  }, 0);
}
function computePnl(from, to) {
  const sales = db.prepare(`SELECT COALESCE(SUM(subtotal),0) v FROM sales_net WHERE invoice_date BETWEEN ? AND ?`).get(from, to).v;

  // Raw Material Consumed = Opening stock value + Purchases in period − Closing stock value,
  // each raw material valued at its current average purchase rate — the standard formula for
  // "materials consumed" without needing a fully costed, transaction-by-transaction ledger.
  const openingRM = rawMaterialStockValueAsOf(dayBefore(from));
  const closingRM = rawMaterialStockValueAsOf(to);
  const purchasesInPeriod = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM purchases_net WHERE purchase_date BETWEEN ? AND ?`).get(from, to).v;
  const rawMaterialConsumed = Math.max(0, openingRM + purchasesInPeriod - closingRM);

  const grossProfit = sales - rawMaterialConsumed;

  const employeeBenefits = db.prepare(`SELECT COALESCE(SUM(gross),0) v FROM payroll WHERE (pay_month || '-01') BETWEEN ? AND ?`).get(from.slice(0, 7) + '-01', to.slice(0, 7) + '-01').v;
  const outsourcing = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM outsourcing_jobs WHERE date BETWEEN ? AND ?`).get(from, to).v;
  const otherOverheads = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE date BETWEEN ? AND ?`).get(from, to).v;

  const operatingProfit = grossProfit - employeeBenefits - outsourcing - otherOverheads;
  const opm = sales > 0 ? (operatingProfit / sales) * 100 : 0;

  const depreciation = Math.max(0, totalDepreciationAsOf(to) - totalDepreciationAsOf(dayBefore(from)));

  const settings = db.prepare(`SELECT other_income_override, interest_expense_override, corporate_tax_rate_pct FROM company_settings WHERE id = 1`).get() || {};
  const otherIncome = Number(settings.other_income_override || 0);
  // Interest / Finance Costs = manual override (e.g. bank charges not tied to a
  // tracked loan) + interest actually paid on Loans in this period, pulled
  // automatically from loan repayments so it never needs manual entry.
  const loanInterest = loanInterestInPeriod(from, to);
  const interest = Number(settings.interest_expense_override || 0) + loanInterest;
  const taxPct = Number(settings.corporate_tax_rate_pct || 25);

  const pbt = operatingProfit + otherIncome - interest - depreciation;
  const taxAmount = Math.max(0, pbt) * taxPct / 100;
  const pat = pbt - taxAmount;

  return {
    from, to, sales, rawMaterialConsumed, grossProfit, employeeBenefits, outsourcing, otherOverheads,
    operatingProfit, opm, otherIncome, interest, loanInterest, depreciation, pbt, taxPct, taxAmount, pat,
  };
}
function pctDelta(current, previous) {
  if (!previous) return current ? null : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}
router.get('/pnl', (req, res) => {
  const to = req.query.to || todayStr();
  const from = req.query.from || '2000-01-01';
  const current = computePnl(from, to);

  let compare = null;
  if (req.query.compare_from && req.query.compare_to) {
    const previous = computePnl(req.query.compare_from, req.query.compare_to);
    compare = { previous, delta: {} };
    ['sales', 'rawMaterialConsumed', 'grossProfit', 'employeeBenefits', 'outsourcing', 'otherOverheads', 'operatingProfit', 'opm', 'otherIncome', 'interest', 'depreciation', 'pbt', 'taxAmount', 'pat']
      .forEach((k) => { compare.delta[k] = pctDelta(current[k], previous[k]); });
  }

  // Last 6 months' PAT trend, for the bar chart — always calendar-month based
  // regardless of the selected report period, so the trend gives a stable
  // month-on-month view.
  const months = monthsBack(6);
  const monthlyTrend = months.map((m) => {
    const mFrom = `${m}-01`;
    const mToDate = new Date(`${m}-01T00:00:00`); mToDate.setMonth(mToDate.getMonth() + 1); mToDate.setDate(0);
    const mTo = localDateStr(mToDate);
    return { month: m, pat: computePnl(mFrom, mTo).pat };
  });

  // Expense breakdown for the pie chart — the full cost structure, not just
  // the free-text Expenses categories, so it actually reflects where money
  // goes in a manufacturing business.
  const expenseByCategory = db.prepare(`SELECT category, COALESCE(SUM(amount),0) v FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category ORDER BY v DESC`).all(from, to);
  const expenseBreakdown = [
    { label: 'Raw Material Consumed', value: current.rawMaterialConsumed },
    { label: 'Employee Benefits', value: current.employeeBenefits },
    { label: 'Outsourcing / Job Work', value: current.outsourcing },
    ...expenseByCategory.map((r) => ({ label: r.category, value: r.v })),
  ].filter((r) => r.value > 0);

  res.json({ current, compare, monthlyTrend, expenseBreakdown });
});

// Drill-down: the underlying transactions behind a P&L line item, for a
// given period — lets a line item be clicked to see what makes it up
// without leaving the report.
router.get('/pnl/drilldown/:type', (req, res) => {
  const { from, to } = req.query;
  const type = req.params.type;
  let headers = [], rows = [];
  if (type === 'sales') {
    const data = db.prepare(`SELECT s.invoice_no, s.invoice_date, c.name customer_name, s.subtotal FROM sales_net s JOIN customers c ON c.id = s.customer_id WHERE s.invoice_date BETWEEN ? AND ? ORDER BY s.invoice_date`).all(from, to); // returns appear as negative rows
    headers = ['Invoice No', 'Date', 'Customer', 'Sales Value (excl. GST)'];
    rows = data.map((r) => [r.invoice_no, r.invoice_date, r.customer_name, r.subtotal]);
  } else if (type === 'rawMaterialConsumed') {
    const data = db.prepare(`SELECT p.purchase_no, p.purchase_date, s.name supplier_name, r.name material_name, p.qty, p.rate, p.amount FROM purchases_net p JOIN suppliers s ON s.id = p.supplier_id JOIN raw_materials r ON r.id = p.raw_material_id WHERE p.purchase_date BETWEEN ? AND ? ORDER BY p.purchase_date`).all(from, to);
    headers = ['Purchase No', 'Date', 'Supplier', 'Material', 'Qty', 'Rate', 'Amount'];
    rows = data.map((r) => [r.purchase_no, r.purchase_date, r.supplier_name, r.material_name, r.qty, r.rate, r.amount]);
  } else if (type === 'employeeBenefits') {
    const data = db.prepare(`SELECT payroll_no, employee_id, pay_month, gross FROM payroll pr WHERE (pay_month || '-01') BETWEEN ? AND ? ORDER BY pay_month`).all(from.slice(0, 7) + '-01', to.slice(0, 7) + '-01');
    const empNames = Object.fromEntries(db.prepare(`SELECT id, name FROM employees`).all().map((e) => [e.id, e.name]));
    headers = ['Payroll No', 'Employee', 'Month', 'Gross'];
    rows = data.map((r) => [r.payroll_no, empNames[r.employee_id] || '', r.pay_month, r.gross]);
  } else if (type === 'outsourcing') {
    const data = db.prepare(`SELECT j.job_no, j.date, p.name person_name, j.stage, j.amount FROM outsourcing_jobs j JOIN outsourcing_persons p ON p.id = j.person_id WHERE j.date BETWEEN ? AND ? ORDER BY j.date`).all(from, to);
    headers = ['Job No', 'Date', 'Jobworker', 'Stage', 'Amount'];
    rows = data.map((r) => [r.job_no, r.date, r.person_name, r.stage, r.amount]);
  } else if (type === 'otherOverheads') {
    const data = db.prepare(`SELECT expense_no, date, category, description, amount FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to);
    headers = ['Expense No', 'Date', 'Category', 'Description', 'Amount'];
    rows = data.map((r) => [r.expense_no, r.date, r.category, r.description || '', r.amount]);
  } else if (type === 'depreciation') {
    const assets = db.prepare(`SELECT id, asset_no, name, purchase_date FROM assets`).all();
    headers = ['Asset No', 'Name', 'Purchase Date', 'Depreciation This Period'];
    rows = assets.map((a) => {
      if (a.purchase_date > to) return null;
      const before = bookValueAsOf(assetWithCategory(a.id), dayBefore(from)).accumulatedDep;
      const afterVal = bookValueAsOf(assetWithCategory(a.id), to).accumulatedDep;
      const dep = afterVal - before;
      return dep > 0.005 ? [a.asset_no, a.name, a.purchase_date, dep] : null;
    }).filter(Boolean);
  } else if (type === 'loanInterest') {
    const data = db.prepare(`
      SELECT lt.txn_no, lt.date, l.loan_no, l.lender_name, lt.amount, lt.principal_component, lt.interest_component
      FROM loan_transactions lt JOIN loans l ON l.id = lt.loan_id
      WHERE lt.txn_type = 'Repayment' AND lt.date BETWEEN ? AND ? ORDER BY lt.date`).all(from, to);
    headers = ['Txn No', 'Date', 'Loan No', 'Lender', 'Total Paid', 'Principal', 'Interest'];
    rows = data.map((r) => [r.txn_no, r.date, r.loan_no, r.lender_name, r.amount, r.principal_component, r.interest_component]);
  } else {
    return res.status(400).json({ error: 'Unknown drill-down type' });
  }
  res.json({ headers, rows });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
router.get('/audit-log', (req, res) => {
  res.json(db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 400`).all());
});

// GST period report — Input GST, Output GST and net balance for a selected
// date range, with rate-wise detail for reconciliation.
router.get('/gst-summary', (req, res) => {
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2999-12-31';
  const output = db.prepare(`SELECT COALESCE(SUM(subtotal),0) taxable, COALESCE(SUM(gst_amt),0) gst FROM sales_net WHERE invoice_date BETWEEN ? AND ?`).get(from,to);
  const input = db.prepare(`SELECT COALESCE(SUM(amount),0) taxable, COALESCE(SUM(gst_amt),0) gst FROM purchases_net WHERE purchase_date BETWEEN ? AND ?`).get(from,to);
  const outputByRate = db.prepare(`SELECT gst_pct rate, COUNT(*) FILTER (WHERE doc_type='INVOICE') invoices, COALESCE(SUM(subtotal),0) taxable, COALESCE(SUM(gst_amt),0) gst FROM sales_net WHERE invoice_date BETWEEN ? AND ? GROUP BY gst_pct ORDER BY gst_pct`).all(from,to);
  const inputByRate = db.prepare(`SELECT gst_pct rate, COUNT(*) FILTER (WHERE doc_type='PURCHASE') purchases, COALESCE(SUM(amount),0) taxable, COALESCE(SUM(gst_amt),0) gst FROM purchases_net WHERE purchase_date BETWEEN ? AND ? GROUP BY gst_pct ORDER BY gst_pct`).all(from,to);
  res.json({
    from,to, outputGst:Number(output.gst||0), inputGst:Number(input.gst||0),
    netTax:Number(output.gst||0)-Number(input.gst||0),
    taxableSales:Number(output.taxable||0), taxablePurchases:Number(input.taxable||0),
    outputByRate, inputByRate
  });
});

// Salesperson-wise performance — total invoices, total sales value, and
// target vs. achieved vs. balance remaining, driven by employees.sales_target.
// Only counts employees actually linked to a login (an employee with sales
// figures but no user account can't have attributed any invoices, so
// they're left out rather than shown with a confusing "0 invoices" row).
router.get('/salesperson-performance', (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2999-12-31';
  const employeeId = req.user?.employee_id || null;
  const isSalesperson = ['SALES','SALES_PERSON','SALESPERSON'].includes(String(req.user?.role || '').toUpperCase().replace(/[-\s]+/g,'_'));
  const scope = isSalesperson && employeeId ? ' AND e.id = ?' : '';
  const params = isSalesperson && employeeId ? [from, to, employeeId] : [from, to];
  const rows = db.prepare(`
    SELECT e.id employee_id, e.name, e.department, e.sales_target,
      COUNT(si.id) FILTER (WHERE si.doc_type='INVOICE') invoice_count, COALESCE(SUM(si.grand_total),0) total_sales
    FROM employees e
    LEFT JOIN sales_net si ON si.salesperson_id = e.id AND si.invoice_date BETWEEN ? AND ?
    WHERE e.id IN (SELECT employee_id FROM users WHERE employee_id IS NOT NULL)${scope}
    GROUP BY e.id ORDER BY total_sales DESC`).all(...params)
    .map((r) => ({ ...r, targetBalance: Math.max(0, r.sales_target - r.total_sales), targetAchievedPct: r.sales_target > 0 ? Math.min(999, (r.total_sales / r.sales_target) * 100) : null }));
  res.json(rows);
});

module.exports = router;
// computePnl is also used by the investor-presentation generator
// (routes/investorReport.js) — attached as a property on the router
// function itself so that file doesn't need its own copy of this logic.
router.computePnl = computePnl;
router.computeAccounts = computeAccounts;
