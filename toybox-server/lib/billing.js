// ============================================================================
// lib/billing.js — simple billing records per company (what you charge them)
//
// Not a payment gateway: the owner records an invoice (amount, due date) and
// later marks it paid. Status shown = PAID, VOID, DUE (unpaid, not yet late) or
// OVERDUE (unpaid and past its due date). Recording a payment can renew the
// company's subscription in the same step.
// ============================================================================
const { one, all, run, PlatformError, audit, DATE_RE } = require('./platformdb');
const sub = require('./subscription');
const mt = require('./multitenant');

const row = (r) => r && ({
  id: r.id, company_code: r.company_code, plan_code: r.plan_code, description: r.description, amount: Number(r.amount),
  issued_on: r.issued_on, due_on: r.due_on, paid_on: r.paid_on, stored_status: r.status,
  status: r.status === 'PENDING' ? (r.due_on && r.due_on < sub.todayStr() ? 'OVERDUE' : 'DUE') : r.status,
  method: r.method, reference: r.reference, period_label: r.period_label, created_by: r.created_by, created_at: r.created_at,
});
const d = (v, label, required) => {
  if (v === undefined || v === null || v === '') { if (required) throw new PlatformError(`${label} is required.`); return null; }
  if (!DATE_RE.test(String(v)) || !sub.isDate(v)) throw new PlatformError(`${label} must be a date (YYYY-MM-DD).`);
  return String(v).slice(0, 10);
};

function create(input, actor, ip) {
  const code = String(input.company_code || '').trim().toUpperCase();
  const company = mt.getCompanyByCode(code);
  if (!company) throw new PlatformError('Choose a company.', 404);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw new PlatformError('Enter the amount (0 or more).');
  const plan = input.plan_code ? sub.getPlan(input.plan_code) : null;
  if (input.plan_code && !plan) throw new PlatformError('Choose a valid plan.');
  const issued = d(input.issued_on, 'Issue date') || sub.todayStr();
  const due = d(input.due_on, 'Due date') || sub.addDays(issued, 7);
  const r = one(`INSERT INTO billing_records(company_code,plan_code,description,amount,issued_on,due_on,period_label,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [company.company_code, plan ? plan.code : null, String(input.description || '').trim().slice(0, 200) || (plan ? `${plan.name} plan` : 'Subscription'), amount, issued, due, String(input.period_label || '').trim().slice(0, 60) || null, actor]);
  audit(actor, 'BILLING_CREATED', company.company_code, { id: r.id, amount }, ip);
  return row(r);
}
/** Mark paid; optionally extend the subscription by `renew_months` in the same step. */
function markPaid(id, input, actor, ip) {
  const cur = one(`SELECT * FROM billing_records WHERE id=$1`, [Number(id) || 0]);
  if (!cur) throw new PlatformError('Billing record not found.', 404);
  if (cur.status === 'VOID') throw new PlatformError('A cancelled record cannot be paid.', 409);
  const paid = d(input.paid_on, 'Payment date') || sub.todayStr();
  run(`UPDATE billing_records SET status='PAID', paid_on=$2, method=$3, reference=$4 WHERE id=$1`, [cur.id, paid, String(input.method || '').trim().slice(0, 40) || null, String(input.reference || '').trim().slice(0, 80) || null]);
  let renewed = null;
  const months = Number(input.renew_months) || 0;
  if (months > 0) {
    const company = mt.getCompanyByCode(cur.company_code);
    if (company) renewed = sub.renew(company, { months, plan_code: cur.plan_code || undefined }, actor, ip);
  }
  audit(actor, 'BILLING_PAID', cur.company_code, { id: cur.id, amount: Number(cur.amount), renewed_months: months || 0 }, ip);
  return { record: row(one(`SELECT * FROM billing_records WHERE id=$1`, [cur.id])), subscription: renewed };
}
function voidRecord(id, actor, ip) {
  const cur = one(`SELECT * FROM billing_records WHERE id=$1`, [Number(id) || 0]);
  if (!cur) throw new PlatformError('Billing record not found.', 404);
  if (cur.status === 'PAID') throw new PlatformError('A paid record cannot be cancelled.', 409);
  run(`UPDATE billing_records SET status='VOID' WHERE id=$1`, [cur.id]);
  audit(actor, 'BILLING_VOIDED', cur.company_code, { id: cur.id }, ip);
}
function list({ company_code, status } = {}) {
  const rows = all(`SELECT * FROM billing_records ${company_code ? 'WHERE company_code=$1' : ''} ORDER BY issued_on DESC, id DESC LIMIT 500`, company_code ? [String(company_code).toUpperCase()] : []).map(row);
  return status ? rows.filter((r) => r.status === String(status).toUpperCase()) : rows;
}
function summary() {
  const month = sub.todayStr().slice(0, 7);
  const rows = all(`SELECT * FROM billing_records WHERE status <> 'VOID'`).map(row);
  const sum = (f) => rows.filter(f).reduce((t, r) => t + r.amount, 0);
  return {
    paid_this_month: sum((r) => r.status === 'PAID' && String(r.paid_on).slice(0, 7) === month),
    paid_total: sum((r) => r.status === 'PAID'),
    due: sum((r) => r.status === 'DUE'), overdue: sum((r) => r.status === 'OVERDUE'),
    overdue_count: rows.filter((r) => r.status === 'OVERDUE').length, due_count: rows.filter((r) => r.status === 'DUE').length,
  };
}
/** Revenue actually received per month for the last n months (oldest first). */
function revenueSeries(n = 12) {
  const paid = all(`SELECT paid_on, amount FROM billing_records WHERE status='PAID' AND paid_on IS NOT NULL`);
  const by = {}; paid.forEach((p) => { const m = String(p.paid_on).slice(0, 7); by[m] = (by[m] || 0) + Number(p.amount); });
  const out = []; let mo = sub.todayStr().slice(0, 7) + '-01';
  for (let i = 0; i < n; i++) { out.unshift({ month: mo.slice(0, 7), revenue: by[mo.slice(0, 7)] || 0 }); mo = sub.addMonths(mo, -1); }
  return out;
}

module.exports = { create, markPaid, voidRecord, list, summary, revenueSeries };
