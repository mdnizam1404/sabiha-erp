// ============================================================================
// routes/loans.js — Working-capital / term loans taken from a Bank or
// fintech lender: disbursements, repayments (principal + interest split),
// and manual adjustments. See the schema comment in db.js for how the
// outstanding balance is derived and how this feeds the financial reports.
// ============================================================================
const express = require('express');
const { db, nextNo, audit } = require('../db');
const router = express.Router();

// A loan's outstanding balance and running totals, computed live from its
// transactions rather than stored, so it can never drift out of sync.
function loanTotals(loanId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN txn_type='Disbursement' THEN amount ELSE 0 END),0) disbursed,
      COALESCE(SUM(CASE WHEN txn_type='Repayment' THEN principal_component ELSE 0 END),0) "principalPaid",
      COALESCE(SUM(CASE WHEN txn_type='Repayment' THEN interest_component ELSE 0 END),0) "interestPaid",
      COALESCE(SUM(CASE WHEN txn_type='Repayment' THEN amount ELSE 0 END),0) "totalRepaid",
      COALESCE(SUM(CASE WHEN txn_type='Adjustment' THEN amount ELSE 0 END),0) adjustments
    FROM loan_transactions WHERE loan_id = ?`).get(loanId);
  const outstanding = row.disbursed + row.adjustments - row.principalPaid;
  return { ...row, outstanding };
}

// Used by reports.js — total outstanding across all loans (a liability for
// the Balance Sheet / Trial Balance), and interest paid within a date range
// (an automatic "Interest / Finance Costs" figure for the P&L).
function totalLoanOutstanding() {
  const loans = db.prepare(`SELECT id FROM loans`).all();
  return loans.reduce((s, l) => s + loanTotals(l.id).outstanding, 0);
}
function loanInterestInPeriod(from, to) {
  return db.prepare(`SELECT COALESCE(SUM(interest_component),0) v FROM loan_transactions WHERE txn_type='Repayment' AND date BETWEEN ? AND ?`).get(from, to).v;
}
function loanCashFlowInPeriod(from, to) {
  const disbursed = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM loan_transactions WHERE txn_type='Disbursement' AND date BETWEEN ? AND ?`).get(from, to).v;
  const repaid = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM loan_transactions WHERE txn_type='Repayment' AND date BETWEEN ? AND ?`).get(from, to).v;
  return { disbursed, repaid };
}
// All loan cash movements to date — used by the Cash / Bank Book.
function totalLoanCashFlow() {
  const disbursed = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM loan_transactions WHERE txn_type='Disbursement'`).get().v;
  const repaid = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM loan_transactions WHERE txn_type='Repayment'`).get().v;
  return { disbursed, repaid };
}

router.get('/loans', (req, res) => {
  const loans = db.prepare(`SELECT * FROM loans ORDER BY start_date DESC, id DESC`).all();
  res.json(loans.map((l) => ({ ...l, ...loanTotals(l.id) })));
});

router.get('/loans/:id', (req, res) => {
  const loan = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const txns = db.prepare(`SELECT * FROM loan_transactions WHERE loan_id = ? ORDER BY date, id`).all(req.params.id);
  res.json({ ...loan, ...loanTotals(loan.id), transactions: txns });
});

// Creating a loan records its disbursement as the first transaction, so the
// outstanding balance and cash-in are correct from the moment it's saved.
router.post('/loans', (req, res) => {
  const b = req.body;
  if (!b.lender_name || !b.start_date) return res.status(400).json({ error: 'Lender name and start date are required' });
  const tx = db.transaction(() => {
    const loan_no = nextNo('LOAN-', 'loans', 'loan_no');
    const info = db.prepare(`
      INSERT INTO loans (loan_no, lender_name, loan_type, purpose, principal_amount, interest_rate_pct, start_date, tenure_months, status, remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      loan_no, b.lender_name, b.loan_type || 'Bank', b.purpose || 'Working Capital',
      Number(b.principal_amount) || 0, Number(b.interest_rate_pct) || 0, b.start_date,
      Number(b.tenure_months) || 0, 'Active', b.remarks || null);
    const loanId = info.lastInsertRowid;
    if (Number(b.principal_amount) > 0) {
      const txn_no = nextNo('LNTXN-', 'loan_transactions', 'txn_no');
      db.prepare(`INSERT INTO loan_transactions (txn_no, loan_id, date, txn_type, amount, mode, reference_no, remarks) VALUES (?,?,?,?,?,?,?,?)`)
        .run(txn_no, loanId, b.start_date, 'Disbursement', Number(b.principal_amount), b.disbursement_mode || 'Bank Transfer', b.disbursement_reference || null, 'Initial disbursement');
    }
    audit(req, 'CREATE', 'loans', loanId, b);
    return loanId;
  });
  const loanId = tx();
  const loan = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(loanId);
  res.json({ ...loan, ...loanTotals(loanId) });
});

router.put('/loans/:id', (req, res) => {
  const b = req.body;
  const exists = db.prepare(`SELECT id FROM loans WHERE id = ?`).get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Loan not found' });
  db.prepare(`
    UPDATE loans SET lender_name=?, loan_type=?, purpose=?, interest_rate_pct=?, tenure_months=?, status=?, remarks=? WHERE id=?`)
    .run(b.lender_name, b.loan_type || 'Bank', b.purpose || 'Working Capital', Number(b.interest_rate_pct) || 0,
      Number(b.tenure_months) || 0, b.status || 'Active', b.remarks || null, req.params.id);
  audit(req, 'UPDATE', 'loans', req.params.id, b);
  const loan = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(req.params.id);
  res.json({ ...loan, ...loanTotals(loan.id) });
});

router.delete('/loans/:id', (req, res) => {
  db.prepare(`DELETE FROM loans WHERE id = ?`).run(req.params.id); // ON DELETE CASCADE removes its transactions too
  audit(req, 'DELETE', 'loans', req.params.id, {});
  res.json({ ok: true });
});

// Add a transaction against a loan — a further Disbursement (e.g. a top-up),
// a Repayment (split into principal + interest so both the liability and
// the P&L are correct), or a manual Adjustment (e.g. a penalty or waiver,
// no cash movement).
router.post('/loans/:id/transactions', (req, res) => {
  const b = req.body;
  const loan = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['Disbursement', 'Repayment', 'Adjustment'].includes(b.txn_type)) return res.status(400).json({ error: 'Invalid transaction type' });
  if (!b.date || !(Number(b.amount) > 0 || b.txn_type === 'Adjustment')) return res.status(400).json({ error: 'Date and a valid amount are required' });
  const amount = Number(b.amount) || 0;
  let principal_component = 0, interest_component = 0;
  if (b.txn_type === 'Repayment') {
    interest_component = Math.max(0, Number(b.interest_component) || 0);
    principal_component = Math.max(0, amount - interest_component);
  } else if (b.txn_type === 'Disbursement') {
    principal_component = amount;
  } else { // Adjustment — amount itself can be positive (increase liability) or negative (decrease/waiver)
    principal_component = 0;
  }
  const txn_no = nextNo('LNTXN-', 'loan_transactions', 'txn_no');
  const info = db.prepare(`
    INSERT INTO loan_transactions (txn_no, loan_id, date, txn_type, amount, principal_component, interest_component, mode, reference_no, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    txn_no, loan.id, b.date, b.txn_type, amount, principal_component, interest_component,
    b.mode || 'Bank Transfer', b.reference_no || null, b.remarks || null);
  audit(req, 'CREATE', 'loan_transactions', info.lastInsertRowid, b);
  // A loan whose balance has been fully repaid is marked Closed automatically.
  const totals = loanTotals(loan.id);
  if (totals.outstanding <= 0.5 && loan.status === 'Active') {
    db.prepare(`UPDATE loans SET status = 'Closed' WHERE id = ?`).run(loan.id);
  } else if (totals.outstanding > 0.5 && loan.status === 'Closed') {
    db.prepare(`UPDATE loans SET status = 'Active' WHERE id = ?`).run(loan.id);
  }
  const updated = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(loan.id);
  res.json({ ...updated, ...loanTotals(loan.id) });
});

router.delete('/loans/transactions/:txnId', (req, res) => {
  const txn = db.prepare(`SELECT * FROM loan_transactions WHERE id = ?`).get(req.params.txnId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txn.remarks === 'Initial disbursement') return res.status(400).json({ error: "The initial disbursement can't be deleted — edit or delete the loan itself instead." });
  db.prepare(`DELETE FROM loan_transactions WHERE id = ?`).run(req.params.txnId);
  audit(req, 'DELETE', 'loan_transactions', req.params.txnId, {});
  const totals = loanTotals(txn.loan_id);
  if (totals.outstanding > 0.5) db.prepare(`UPDATE loans SET status = 'Active' WHERE id = ? AND status = 'Closed'`).run(txn.loan_id);
  res.json({ ok: true });
});

// Loans due for repayment soon / overdue — used by the low-stock-style alert
// on the dashboard and the notification system. "Due" here means a loan
// whose tenure has elapsed (start_date + tenure_months) or is within the
// next 15 days, and still has an outstanding balance.
router.get('/loans-due', (req, res) => {
  const loans = db.prepare(`SELECT * FROM loans WHERE status = 'Active'`).all();
  const today = new Date();
  const in15 = new Date(today.getTime() + 15 * 86400000);
  const due = loans.map((l) => {
    const totals = loanTotals(l.id);
    if (totals.outstanding <= 0.5 || !l.tenure_months) return null;
    const dueDate = new Date(l.start_date);
    dueDate.setMonth(dueDate.getMonth() + Number(l.tenure_months));
    if (dueDate > in15) return null;
    return { id: l.id, loan_no: l.loan_no, lender_name: l.lender_name, outstanding: totals.outstanding, due_date: dueDate.toISOString().slice(0, 10), overdue: dueDate < today };
  }).filter(Boolean);
  res.json(due);
});

module.exports = { router, loanTotals, totalLoanOutstanding, loanInterestInPeriod, loanCashFlowInPeriod, totalLoanCashFlow };
