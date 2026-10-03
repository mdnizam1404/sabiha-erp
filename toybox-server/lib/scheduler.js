// ============================================================================
// lib/scheduler.js — background jobs (started once from server.js)
//   every 10 min : is it time for the nightly backups? / are reminders due?
//   nightly      : one backup per company at the configured hour, then pruning
//   daily        : plan-expiry reminder emails (15 / 7 / 1 days, expired, read-only)
//   daily        : housekeeping (old login history, email log)
// Each job records the day it last ran in platform_settings so a restart never
// repeats it and a missed day is caught up on the next tick.
// ============================================================================
const mt = require('./multitenant');
const sub = require('./subscription');
const backup = require('./backup');
const mailer = require('./mailer');
const extras = require('./extras');
const { getSetting, setSetting, all, audit } = require('./platformdb');

let running = false;
const state = () => getSetting('scheduler_state', {});
const mark = (k) => setSetting('scheduler_state', { ...state(), [k]: sub.todayStr() });

function adminEmail(company) {
  try {
    const r = mt.getTenantConnection(company).query(`SELECT email FROM users WHERE role='ADMIN' AND status='Approved' AND active=1 AND email IS NOT NULL AND email <> '' ORDER BY id LIMIT 1`, [], false).rows[0];
    return r && r.email;
  } catch (_) { return null; }
}

async function sendReminders() {
  let sent = 0;
  for (const c of mt.listCompanies().filter((x) => x.status === 'ACTIVE')) {
    const row = sub.getSubscription(c.id);
    const r = sub.nextReminder(row);
    if (!r) continue;
    const company = mt.getCompanyByCode(c.company_code);
    const snap = sub.snapshot(company, { withUsage: false });
    const to = row.contact_email || adminEmail(company);
    if (to && mailer.getConfig().enabled) {
      const ct = snap.contact || {};
      const res = await mailer.deliver('expiryReminder', to, {
        kind: r.key, days_left: r.days_left, grace_days: row.grace_days, company_name: company.company_name, company_code: company.company_code,
        plan_name: snap.plan_name, is_trial: snap.is_trial, expires_on_fmt: sub.fmtD(row.expires_on), contact: [ct.name, ct.email, ct.phone].filter(Boolean).join(' · '), url: mailer.baseUrl(''),
      });
      if (res.sent) { sent++; sub.markReminder(company.id, r); }
    } else sub.markReminder(company.id, r); // nobody to email — don't retry daily forever
    await new Promise((x) => setImmediate(x));
  }
  return sent;
}

async function tick() {
  if (running) return; running = true;
  try {
    const s = state(); const today = sub.todayStr(); const hour = new Date().getHours();
    const b = backup.getSettings();
    if (b.nightly_enabled && s.nightly_backup !== today && hour >= b.hour) {
      mark('nightly_backup');
      const r = await backup.runNightly('scheduler');
      console.log(`[scheduler] nightly backups: ${r.ok} ok, ${r.failed.length} failed, ${r.pruned} old removed`);
    }
    if (state().reminders !== today && hour >= 8) {
      mark('reminders');
      const n = await sendReminders();
      if (n) { console.log(`[scheduler] ${n} expiry reminder email(s) sent`); audit('scheduler', 'EXPIRY_REMINDERS_SENT', null, { count: n }); }
    }
    if (state().housekeeping !== today) { mark('housekeeping'); extras.cleanup(); }
  } catch (e) { console.error('[scheduler]', e); }
  finally { running = false; }
}
function start() {
  setTimeout(() => tick(), 30 * 1000);            // shortly after start-up
  setInterval(() => tick(), 10 * 60 * 1000).unref();
}
module.exports = { start, tick, sendReminders };
