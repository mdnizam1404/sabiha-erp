// ============================================================================
// lib/planRequests.js — a company admin asks to buy / renew / upgrade a plan;
// the platform owner approves it (which applies the plan and can issue the
// billing record in the same step) or rejects it with a reason.
// There is no payment gateway: the company pays the owner (bank / UPI / cash)
// and the owner confirms here.
// ============================================================================
const { one, all, run, PlatformError, audit, EMAIL_RE } = require('./platformdb');
const mt = require('./multitenant');
const sub = require('./subscription');
const billing = require('./billing');
const mailer = require('./mailer');
const { getSetting } = require('./platformdb');

const MONTHS = [1, 3, 6, 12, 24];

function create(company, { plan_code, months, note }, requestedBy, contactEmail) {
  const plan = sub.getPlan(plan_code);
  if (!plan || !plan.active) throw new PlatformError('Choose one of the available plans.');
  if (plan.is_trial) throw new PlatformError('The trial plan cannot be purchased. Choose a paid plan.');
  const m = Number(months); if (!MONTHS.includes(m)) throw new PlatformError('Choose 1, 3, 6, 12 or 24 months.');
  if (one(`SELECT 1 FROM plan_requests WHERE company_code=$1 AND status='PENDING'`, [company.company_code])) throw new PlatformError('You already have a request waiting for the platform owner. Please wait for it to be approved, or contact support.', 409);
  const cur = sub.getSubscription(company.id); const curPlan = cur ? sub.getPlan(cur.plan_code) : null;
  const kind = !curPlan || curPlan.is_trial ? 'PURCHASE' : curPlan.code === plan.code ? 'RENEW' : 'UPGRADE';
  const email = contactEmail && EMAIL_RE.test(contactEmail) ? contactEmail : (cur && cur.contact_email) || null;
  const r = one(`INSERT INTO plan_requests(company_code,company_name,kind,plan_code,months,note,requested_by,contact_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [company.company_code, company.company_name, kind, plan.code, m, String(note || '').trim().slice(0, 500) || null, requestedBy, email]);
  audit(`company:${company.company_code}`, 'PLAN_REQUEST_CREATED', company.company_code, { kind, plan: plan.code, months: m });
  const to = (getSetting('contact', {}) || {}).email;
  if (to) mailer.sendTemplate('planRequest', to, { company_name: company.company_name, company_code: company.company_code, kind, plan_name: plan.name, months: m, price: plan.price_monthly * m, note: r.note, requested_by: requestedBy });
  return r;
}
const forCompany = (code, limit = 8) => all(`SELECT id, kind, plan_code, months, note, status, created_at, reviewed_at, review_note FROM plan_requests WHERE company_code=$1 ORDER BY id DESC LIMIT $2`, [code, limit]);
const list = (status) => all(`SELECT * FROM plan_requests ${status ? 'WHERE status=$1' : ''} ORDER BY (status='PENDING') DESC, id DESC LIMIT 300`, status ? [status] : []);
const pendingCount = () => Number((one(`SELECT COUNT(*) n FROM plan_requests WHERE status='PENDING'`) || {}).n || 0);

function approve(id, { plan_code, months, amount, issue_invoice, note } = {}, actor, ip) {
  const r = one(`SELECT * FROM plan_requests WHERE id=$1`, [Number(id) || 0]);
  if (!r) throw new PlatformError('Request not found.', 404);
  if (r.status !== 'PENDING') throw new PlatformError(`This request was already ${r.status.toLowerCase()}.`, 409);
  const company = mt.getCompanyByCode(r.company_code);
  if (!company || !['ACTIVE', 'SUSPENDED'].includes(company.status)) throw new PlatformError('That company is not active any more.', 409);
  const plan = sub.getPlan(plan_code || r.plan_code); if (!plan) throw new PlatformError('Choose a valid plan.');
  const m = Number(months || r.months); if (!(m > 0 && m <= 120)) throw new PlatformError('Enter the number of months.');
  const cur = sub.getSubscription(company.id); const curPlan = cur ? sub.getPlan(cur.plan_code) : null;
  let snap;
  if (!cur) snap = (sub.startSubscription(company, { plan_code: plan.code, months: m, contact_email: r.contact_email, actor }), sub.snapshot(company, { withUsage: false }));
  else if (!curPlan || curPlan.is_trial) snap = sub.setSubscription(company, { plan_code: plan.code, expires_on: sub.addMonths(sub.todayStr(), m) }, actor, ip); // a trial turns into a paid plan starting today
  else snap = sub.renew(company, { months: m, plan_code: plan.code }, actor, ip);
  let bill = null; const amt = amount === undefined || amount === '' ? plan.price_monthly * m : Number(amount);
  if (issue_invoice !== false && amt > 0) bill = billing.create({ company_code: company.company_code, plan_code: plan.code, amount: amt, description: `${plan.name} plan — ${m} month${m > 1 ? 's' : ''}`, period_label: `${m} month${m > 1 ? 's' : ''}` }, actor, ip);
  run(`UPDATE plan_requests SET status='APPROVED', reviewed_at=now(), reviewed_by=$2, review_note=$3, plan_code=$4, months=$5 WHERE id=$1`, [r.id, actor, String(note || '').slice(0, 500) || null, plan.code, m]);
  audit(actor, 'PLAN_REQUEST_APPROVED', company.company_code, { plan: plan.code, months: m, amount: amt }, ip);
  if (r.contact_email) mailer.sendTemplate('planDecision', r.contact_email, { company_name: company.company_name, approved: true, plan_name: plan.name, months: m, expires: sub.fmtD(snap.expires_on), amount: amt, note: note || '' });
  return { snapshot: snap, billing: bill };
}
function reject(id, note, actor, ip) {
  const r = one(`SELECT * FROM plan_requests WHERE id=$1`, [Number(id) || 0]);
  if (!r) throw new PlatformError('Request not found.', 404);
  if (r.status !== 'PENDING') throw new PlatformError(`This request was already ${r.status.toLowerCase()}.`, 409);
  run(`UPDATE plan_requests SET status='REJECTED', reviewed_at=now(), reviewed_by=$2, review_note=$3 WHERE id=$1`, [r.id, actor, String(note || '').slice(0, 500) || null]);
  audit(actor, 'PLAN_REQUEST_REJECTED', r.company_code, { note }, ip);
  if (r.contact_email) mailer.sendTemplate('planDecision', r.contact_email, { company_name: r.company_name, approved: false, plan_name: (sub.getPlan(r.plan_code) || {}).name || r.plan_code, months: r.months, note: note || '' });
}
module.exports = { create, forCompany, list, pendingCount, approve, reject, MONTHS };
