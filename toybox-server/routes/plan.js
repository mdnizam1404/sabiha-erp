// ============================================================================
// routes/plan.js — the company admin's "My Plan" page
//   GET  /api/subscription          current plan, validity, usage, modules, plans on offer, billing history
//   POST /api/subscription/request  ask the platform owner to buy / renew / upgrade a plan
// Works even when the plan has expired (read-only mode) so the admin can always renew.
// ============================================================================
const express = require('express');
const { requireRole } = require('../auth');
const sub = require('../lib/subscription');
const billing = require('../lib/billing');
const PR = require('../lib/planRequests');
const { getSetting, PlatformError } = require('../lib/platformdb');
const { db } = require('../db');

const router = express.Router();
const handle = (fn) => (req, res) => { try { fn(req, res); } catch (e) { if (e instanceof PlatformError) return res.status(e.status).json({ error: e.message }); console.error('[plan]', e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); } };

router.get('/subscription', requireRole('ADMIN'), handle((req, res) => {
  const company = req.company;
  const snap = sub.snapshot(company);
  const row = sub.getSubscription(company.id);
  const included = Array.isArray(snap.modules) ? snap.modules : null;
  const plans = sub.listPlans().filter((p) => p.active && !p.is_trial).map((p) => ({
    code: p.code, name: p.name, price_monthly: p.price_monthly, max_users: p.max_users, max_branches: p.max_branches, max_invoices_month: p.max_invoices_month, max_storage_mb: p.max_storage_mb,
    modules: p.modules || sub.GATED_KEYS, current: p.code === snap.plan_code,
  }));
  res.json({
    subscription: { ...snap, starts_on: row ? row.starts_on : null, plan_price_monthly: ((sub.getPlan(snap.plan_code) || {}).price_monthly) || 0 },
    modules: sub.GATED_MODULES.map(([key, label]) => ({ key, label, included: !included || included.includes(key) })),
    plans, months: PR.MONTHS,
    billing: billing.list({ company_code: company.company_code }).slice(0, 15),
    requests: PR.forCompany(company.company_code),
    contact: snap.contact, payment_instructions: (getSetting('payment', {}) || {}).instructions || '',
    admin_email: (db.prepare(`SELECT email FROM users WHERE id = ?`).get(req.user.id) || {}).email || null,
  });
}));

router.post('/subscription/request', requireRole('ADMIN'), handle((req, res) => {
  const email = String(req.body?.contact_email || '').trim();
  const r = PR.create(req.company, { plan_code: req.body?.plan_code, months: req.body?.months, note: req.body?.note }, req.user.username, email);
  res.status(201).json({ ok: true, request: r, message: 'Your request was sent to the platform owner. You will get the plan as soon as it is approved.' });
}));

module.exports = router;
