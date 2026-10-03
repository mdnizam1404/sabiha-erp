// ============================================================================
// routes/incentives.js — the Incentive & Reward engine.
//
// A rule (incentive_rules) says "for trigger X, reward ₹Y (flat or % of the
// achieved value) once the target is hit". evaluateIncentive() is the one
// function every trigger point in the app calls after a relevant save
// (a sale, a production entry, a receipt, a converted bid, overtime logged,
// a completed task) — it checks that employee's progress this month against
// their own target field on `employees`, and if crossed for the first time
// this period, writes one employee_incentives row (the UNIQUE constraint on
// employee+rule+period stops it ever double-awarding) and returns it so the
// caller can surface the "you just earned a reward" popup in its response.
// ============================================================================
const express = require('express');
const { db, audit } = require('../db');
const { requireRole } = require('../auth');
const router = express.Router();
const { validateBody, z } = require('../lib/validate');
const { incentiveRuleSchema, taskSchema, date } = require('../lib/schemas');

const TRIGGER_TYPES = ['SALES', 'PRODUCTION', 'BIDDING', 'RECOVERY', 'OVERTIME', 'JOB_TASK'];

function currentPeriod(dateStr) {
  return (dateStr || new Date().toISOString().slice(0, 10)).slice(0, 7); // 'YYYY-MM'
}

// Returns { achieved, target } for one employee/trigger/period — the single
// place that knows how to read each department's progress, so every
// trigger point below and the Incentives dashboard stay consistent.
function achievementFor(employeeId, triggerType, period) {
  const emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(employeeId);
  if (!emp) return null;
  let achieved = 0, target = 0;
  if (triggerType === 'SALES') {
    achieved = db.prepare(`SELECT COALESCE(SUM(grand_total),0) v FROM sales_net WHERE salesperson_id = ? AND strftime('%Y-%m',invoice_date) = ?`).get(employeeId, period).v;
    target = emp.sales_target;
  } else if (triggerType === 'PRODUCTION') {
    achieved = db.prepare(`SELECT COALESCE(SUM(produced_qty),0) v FROM production WHERE operator_id = ? AND strftime('%Y-%m',date) = ?`).get(employeeId, period).v;
    target = emp.production_target;
  } else if (triggerType === 'BIDDING') {
    achieved = db.prepare(`SELECT COUNT(*) v FROM future_orders WHERE salesperson_employee_id = ? AND status = 'Converted' AND strftime('%Y-%m',expected_date) = ?`).get(employeeId, period).v;
    target = emp.bid_target;
  } else if (triggerType === 'RECOVERY') {
    achieved = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE collected_by = ? AND strftime('%Y-%m',date) = ?`).get(employeeId, period).v;
    target = emp.recovery_target;
  } else if (triggerType === 'OVERTIME') {
    achieved = db.prepare(`SELECT COALESCE(SUM(overtime_hours),0) v FROM attendance WHERE employee_id = ? AND strftime('%Y-%m',work_date) = ?`).get(employeeId, period).v;
    target = emp.overtime_target_hours;
  } else if (triggerType === 'JOB_TASK') {
    achieved = db.prepare(`SELECT COUNT(*) v FROM employee_tasks WHERE employee_id = ? AND status = 'Completed' AND strftime('%Y-%m',completed_date) = ?`).get(employeeId, period).v;
    target = emp.job_target;
  }
  return { achieved, target };
}

// Call this right after any action that could cross a target — it's cheap
// (a handful of indexed-ish lookups) and safe to call even when nothing
// unlocks: it just returns an empty array. Always call within the same
// db.transaction() as the action that might trigger it, so an award is
// never recorded for a save that itself gets rolled back.
function evaluateIncentive(req, employeeId, triggerType, periodDateStr) {
  if (!employeeId) return [];
  const period = currentPeriod(periodDateStr);
  const { achieved, target } = achievementFor(employeeId, triggerType, period) || {};
  if (!target || target <= 0 || achieved < target) return [];
  const rules = db.prepare(`SELECT * FROM incentive_rules WHERE trigger_type = ? AND active = 1`).all(triggerType);
  const unlocked = [];
  for (const rule of rules) {
    const already = db.prepare(`SELECT id FROM employee_incentives WHERE employee_id = ? AND rule_id = ? AND period = ?`).get(employeeId, rule.id, period);
    if (already) continue;
    const rewardAmount = rule.reward_type === 'PERCENT' ? achieved * rule.reward_value / 100 : rule.reward_value;
    const info = db.prepare(`
      INSERT INTO employee_incentives (employee_id, rule_id, trigger_type, period, achieved_value, target_value, reward_amount, status)
      VALUES (?,?,?,?,?,?,?, 'Pending')`).run(employeeId, rule.id, triggerType, period, achieved, target, rewardAmount);
    // If payroll for this employee/period already exists, immediately append the
    // newly earned reward to that payroll instead of waiting for a second payroll run.
    const existingPayroll = db.prepare(`SELECT * FROM payroll WHERE employee_id=? AND pay_month=? ORDER BY id DESC LIMIT 1`).get(employeeId, period);
    if (existingPayroll) {
      const newGross = Number(existingPayroll.gross || 0) + rewardAmount;
      const newNet = Number(existingPayroll.net || 0) + rewardAmount;
      const newIncentive = Number(existingPayroll.incentive_amount || 0) + rewardAmount;
      db.prepare(`UPDATE payroll SET incentive_amount=?, gross=?, net=? WHERE id=?`).run(newIncentive, newGross, newNet, existingPayroll.id);
      db.prepare(`UPDATE employee_incentives SET status='Paid', payroll_id=? WHERE id=?`).run(existingPayroll.id, info.lastInsertRowid);
    }
    audit(req, 'CREATE', 'employee_incentives', info.lastInsertRowid, { employeeId, trigger: triggerType, period, achieved, target, rewardAmount, payrollAdjusted: !!existingPayroll });
    const emp = db.prepare(`SELECT name FROM employees WHERE id = ?`).get(employeeId);
    unlocked.push({ id: info.lastInsertRowid, employee_id: employeeId, employee_name: emp.name, rule_name: rule.name, trigger_type: triggerType, period, achieved_value: achieved, target_value: target, reward_amount: rewardAmount });
  }
  return unlocked;
}


// ---------------------------------------------------------------------------
// Customer Loyalty / Rebate — cumulative invoiced purchases against the
// customer's configured threshold. Eligibility is derived from actual sales.
// ---------------------------------------------------------------------------
function getCustomerLoyalty(customerId) {
  const c = db.prepare(`SELECT id,name,purchase_target,reward_eligible,loyalty_earned_amount,loyalty_reward_pending,loyalty_reward_redeemed_at FROM customers WHERE id = ?`).get(customerId);
  if (!c) return null;
  const company = db.prepare(`SELECT loyalty_reward_type, loyalty_reward_value FROM company_settings WHERE id=1`).get() || {};
  const cumulative = Number(db.prepare(`SELECT COALESCE(SUM(grand_total),0) v FROM sales_net WHERE customer_id = ?`).get(customerId).v || 0);
  const target = Number(c.purchase_target || 0);
  const thresholdReached = target > 0 && cumulative >= target;
  const pending = thresholdReached && !c.loyalty_reward_redeemed_at;
  const eligible = pending;
  return {
    ...c, cumulative_purchase: cumulative, target,
    remaining: Math.max(0, target - cumulative), eligible, thresholdReached, pending,
    reward_type: company.loyalty_reward_type === 'FIXED' ? 'FIXED' : 'PERCENT',
    reward_value: Number(company.loyalty_reward_value || 0)
  };
}
function refreshCustomerLoyalty(customerId) {
  const s = getCustomerLoyalty(customerId);
  if (!s) return null;
  db.prepare(`UPDATE customers SET reward_eligible=?, loyalty_reward_pending=? WHERE id=?`).run(s.eligible ? 1 : 0, s.eligible ? 1 : 0, customerId);
  return s;
}

// ---------------------------------------------------------------------------
// Incentive Rules — the central configuration screen (Company/HR Settings →
// Incentive & Reward Rules)
// ---------------------------------------------------------------------------
router.get('/incentive-rules', (req, res) => {
  res.json(db.prepare(`SELECT * FROM incentive_rules ORDER BY trigger_type, id`).all());
});
router.post('/incentive-rules', requireRole('ADMIN', 'MANAGER'), validateBody(incentiveRuleSchema), (req, res) => {
  const b = req.body;
  if (!TRIGGER_TYPES.includes(b.trigger_type)) return res.status(400).json({ error: 'Invalid trigger type' });
  if (!b.name || !(Number(b.reward_value) > 0)) return res.status(400).json({ error: 'Name and a positive reward value are required' });
  const info = db.prepare(`INSERT INTO incentive_rules (name, trigger_type, reward_type, reward_value, active) VALUES (?,?,?,?,?)`)
    .run(b.name, b.trigger_type, b.reward_type === 'PERCENT' ? 'PERCENT' : 'FIXED', Number(b.reward_value), b.active === false ? 0 : 1);
  audit(req, 'CREATE', 'incentive_rules', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM incentive_rules WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/incentive-rules/:id', requireRole('ADMIN', 'MANAGER'), validateBody(incentiveRuleSchema), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE incentive_rules SET name=?, trigger_type=?, reward_type=?, reward_value=?, active=? WHERE id=?`)
    .run(b.name, b.trigger_type, b.reward_type === 'PERCENT' ? 'PERCENT' : 'FIXED', Number(b.reward_value), b.active === false ? 0 : 1, req.params.id);
  audit(req, 'UPDATE', 'incentive_rules', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM incentive_rules WHERE id = ?`).get(req.params.id));
});
router.delete('/incentive-rules/:id', requireRole('ADMIN', 'MANAGER'), (req, res) => {
  db.prepare(`DELETE FROM incentive_rules WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'incentive_rules', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Employee Incentives ledger + live progress dashboard
// ---------------------------------------------------------------------------
router.get('/employee-incentives', (req, res) => {
  let q = `SELECT ei.*, e.name employee_name, ir.name rule_name FROM employee_incentives ei
    JOIN employees e ON e.id = ei.employee_id JOIN incentive_rules ir ON ir.id = ei.rule_id`;
  const params = [];
  if (req.query.employee_id) { q += ` WHERE ei.employee_id = ?`; params.push(req.query.employee_id); }
  q += ` ORDER BY ei.created_at DESC`;
  res.json(db.prepare(q).all(...params));
});
// Live progress for every active employee against every trigger they have a
// target set for, this month — the "how close is everyone" dashboard.
router.get('/incentive-progress', (req, res) => {
  const period = req.query.period || currentPeriod();
  const employees = db.prepare(`SELECT * FROM employees WHERE active = 1`).all();
  const rows = [];
  for (const emp of employees) {
    for (const trigger of TRIGGER_TYPES) {
      const { achieved, target } = achievementFor(emp.id, trigger, period) || {};
      if (!target || target <= 0) continue; // no target set for this trigger — nothing to show
      rows.push({ employee_id: emp.id, employee_name: emp.name, trigger_type: trigger, achieved, target, pct: Math.min(999, (achieved / target) * 100) });
    }
  }
  res.json({ period, rows });
});
// Manually re-run evaluation for one employee/trigger — useful for the
// Incentives settings screen ("check now") and for backfilling after a
// rule is first created.
router.post('/incentive-progress/:employeeId/:triggerType/evaluate', requireRole('ADMIN', 'MANAGER'), validateBody(z.object({ date: date.optional() }).passthrough()), (req, res) => {
  if (!TRIGGER_TYPES.includes(req.params.triggerType)) return res.status(400).json({ error: 'Invalid trigger type' });
  const unlocked = evaluateIncentive(req, Number(req.params.employeeId), req.params.triggerType, req.body.date);
  res.json({ unlocked });
});

// ---------------------------------------------------------------------------
// Job / Task Allotment — the one trigger with no existing tracking
// elsewhere, so a minimal assignment list lives here.
// ---------------------------------------------------------------------------
router.get('/employee-tasks', (req, res) => {
  let q = `SELECT t.*, e.name employee_name FROM employee_tasks t JOIN employees e ON e.id = t.employee_id`;
  const params = [];
  if (req.query.employee_id) { q += ` WHERE t.employee_id = ?`; params.push(req.query.employee_id); }
  q += ` ORDER BY t.assigned_date DESC, t.id DESC`;
  res.json(db.prepare(q).all(...params));
});
router.post('/employee-tasks', validateBody(taskSchema), (req, res) => {
  const b = req.body;
  if (!b.employee_id || !b.title || !b.assigned_date) return res.status(400).json({ error: 'Employee, title, and assigned date are required' });
  const info = db.prepare(`INSERT INTO employee_tasks (employee_id, title, assigned_date, due_date, status, remarks) VALUES (?,?,?,?, 'Assigned', ?)`)
    .run(b.employee_id, b.title, b.assigned_date, b.due_date || null, b.remarks || null);
  audit(req, 'CREATE', 'employee_tasks', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM employee_tasks WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/employee-tasks/:id/complete', validateBody(z.object({ completed_date: date.optional() }).passthrough()), (req, res) => {
  const task = db.prepare(`SELECT * FROM employee_tasks WHERE id = ?`).get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const completedDate = req.body.completed_date || new Date().toISOString().slice(0, 10);
  let unlocked = [];
  const tx = db.transaction(() => {
    db.prepare(`UPDATE employee_tasks SET status = 'Completed', completed_date = ? WHERE id = ?`).run(completedDate, req.params.id);
    audit(req, 'UPDATE', 'employee_tasks', req.params.id, { status: 'Completed', completed_date: completedDate });
    unlocked = evaluateIncentive(req, task.employee_id, 'JOB_TASK', completedDate);
  });
  tx();
  res.json({ task: db.prepare(`SELECT * FROM employee_tasks WHERE id = ?`).get(req.params.id), unlocked });
});
router.delete('/employee-tasks/:id', (req, res) => {
  db.prepare(`DELETE FROM employee_tasks WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'employee_tasks', req.params.id, {});
  res.json({ ok: true });
});

router.get('/customer-loyalty/:customerId', (req, res) => {
  const status = refreshCustomerLoyalty(Number(req.params.customerId));
  if (!status) return res.status(404).json({ error: 'Customer not found' });
  res.json(status);
});
router.post('/customer-loyalty/:customerId/refresh', requireRole('ADMIN', 'MANAGER'), (req, res) => {
  const status = refreshCustomerLoyalty(Number(req.params.customerId));
  if (!status) return res.status(404).json({ error: 'Customer not found' });
  res.json(status);
});

module.exports = { router, evaluateIncentive, achievementFor, TRIGGER_TYPES, currentPeriod, refreshCustomerLoyalty, getCustomerLoyalty };
