// ============================================================================
// routes/platform.js — /api/platform/*
//
//   PUBLIC (login page)                   PLATFORM OWNER / SUPPORT (token or key)
//   POST /auth/login                      GET  /me, POST /me/change-password, /me/2fa/*
//   GET  /public/companies                GET  /monitor        central overview
//   GET  /public/companies/:code          GET/POST /companies, GET /companies/:code
//        (name + branding)                PATCH /companies/:code/status, POST …/archive|unarchive
//   POST /public/company-requests         PUT  /companies/:code/subscription, POST …/renew
//   GET  /public/company-requests/:ref    PUT  /companies/:code/branding
//                                         POST /companies/:code/backups, GET /backups, …
//                                         GET/POST/DELETE /plans, /billing, /announcements
//                                         /team, /security, /settings/*
//                                         GET /requests, POST /requests/:id/approve|reject, GET /audit
// Support accounts are read-only; every company view is written to the audit log.
// ============================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const P = require('../lib/platform');
const sub = require('../lib/subscription');
const mailer = require('../lib/mailer');
const backup = require('../lib/backup');
const extras = require('../lib/extras');
const billing = require('../lib/billing');
const { listCompanies, getCompanyByCode } = require('../lib/multitenant');
const { getSetting, setSetting, PlatformError, audit } = require('../lib/platformdb');

const router = express.Router();
const limiter = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof PlatformError) return res.status(e.status).json({ error: e.message, ...(e.locked ? { locked: true } : {}) });
    console.error('[platform]', e);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  }
};
const actor = (req) => req.platformAdmin?.username || 'unknown';
const origin = (req) => `${req.protocol}://${req.get('host')}`;
const company = (req) => { const c = getCompanyByCode(req.params.code); if (!c) throw new PlatformError('Company not found.', 404); return c; };

// ---------------------------- public ---------------------------------------
router.post('/auth/login', P.ipGuard, limiter(15 * 60 * 1000, 20, 'Too many sign-in attempts from this device. Please wait a few minutes.'), handle((req, res) => {
  res.json(P.superAdminLogin(req.body?.username, req.body?.password, req.ip, req.body?.code));
}));

router.get('/public/companies', handle((req, res) => res.json({ companies: P.publicCompanies() })));
router.get('/public/companies/:code', limiter(60 * 1000, 40, 'Too many lookups. Please wait a moment.'), handle((req, res) => {
  const c = P.publicCompany(req.params.code);
  if (!c) return res.status(404).json({ error: 'No active company was found with that Company ID.' });
  res.json(c);
}));
router.post('/public/company-requests', limiter(60 * 60 * 1000, Number(process.env.COMPANY_REQUEST_LIMIT_PER_HOUR) || 10, 'Too many company requests from this device. Please try again later.'), handle((req, res) => {
  const r = P.createCompanyRequest(req.body || {}, req.ip);
  res.status(201).json({ ok: true, reference: r.reference, message: 'Your company request was submitted. Keep this reference number — you can check its status on the login page.' });
}));
router.get('/public/company-requests/:reference', limiter(60 * 1000, 30, 'Too many lookups. Please wait a moment.'), handle((req, res) => res.json(P.requestStatus(req.params.reference))));

// ---------------------------- platform team -----------------------------------
router.use(P.ipGuard, P.requirePlatformAuth, P.requireOwnerForChanges);

router.get('/me', handle((req, res) => res.json({ admin: req.platformAdmin })));
router.post('/me/change-password', handle((req, res) => {
  if (!req.platformAdmin.id) return res.status(400).json({ error: 'Not available for API-key access.' });
  P.changeSuperAdminPassword(req.platformAdmin.id, req.body?.current_password, req.body?.new_password, req.ip);
  res.json({ ok: true, message: 'Password changed.' });
}));
const needAccount = (req) => { if (!req.platformAdmin.id) throw new PlatformError('Not available for API-key access.', 400); };
router.post('/me/2fa/setup', handle(async (req, res) => { needAccount(req); const r = P.twoFactorSetup(req.platformAdmin.id); let qr = null; try { qr = await require('qrcode').toDataURL(r.otpauth, { margin: 1, width: 220 }); } catch (_) { /* the typed key still works */ } res.json({ ...r, qr }); }));
router.post('/me/2fa/enable', handle((req, res) => { needAccount(req); res.json(P.twoFactorEnable(req.platformAdmin.id, req.body?.code, req.ip)); }));
router.post('/me/2fa/disable', handle((req, res) => { needAccount(req); P.twoFactorDisable(req.platformAdmin.id, req.body?.password, req.body?.code, req.ip); res.json({ ok: true }); }));

router.get('/monitor', handle((req, res) => res.json(P.overview({ refresh: req.query.refresh === '1' }))));

// ---------------------------- companies ---------------------------------------
router.get('/companies', handle((req, res) => res.json({ companies: listCompanies() })));
router.post('/companies', handle((req, res) => {
  const c = P.createCompanyDirect(req.body || {}, actor(req), req.ip);
  res.status(201).json({ company: { id: c.id, company_code: c.company_code, company_name: c.company_name, database_name: c.database_name, status: c.status } });
}));
router.get('/companies/:code', handle((req, res) => res.json(P.companyDetail(req.params.code, actor(req)))));
router.patch('/companies/:code/status', handle((req, res) => {
  const c = P.setStatus(req.params.code, String(req.body?.status || '').toUpperCase(), actor(req), req.ip);
  res.json({ company: { company_code: c.company_code, status: c.status } });
}));
router.post('/companies/:code/reset-admin-password', handle((req, res) => {
  const r = P.resetCompanyAdminPassword(req.params.code, { username: req.body?.username, new_password: req.body?.new_password }, actor(req), req.ip);
  res.json({ ok: true, admin_username: r.admin_username, message: `Password reset for ${r.admin_username}. They must choose a new one at next sign-in.` });
}));
router.post('/companies/:code/archive', handle((req, res) => res.json({ ok: true, ...P.archiveCompany(req.params.code, actor(req), req.ip) })));
router.post('/companies/:code/unarchive', handle((req, res) => { P.unarchiveCompany(req.params.code, actor(req), req.ip); res.json({ ok: true }); }));

// subscription
router.put('/companies/:code/subscription', handle((req, res) => {
  const s = sub.setSubscription(company(req), req.body || {}, actor(req), req.ip); P.bust(); res.json({ ok: true, subscription: s });
}));
router.post('/companies/:code/renew', handle((req, res) => {
  const s = sub.renew(company(req), { months: req.body?.months, days: req.body?.days, plan_code: req.body?.plan_code }, actor(req), req.ip); P.bust(); res.json({ ok: true, subscription: s });
}));
router.post('/companies/:code/start-plan', handle((req, res) => {
  const c = company(req);
  if (sub.getSubscription(c.id)) throw new PlatformError('This company already has a plan.', 409);
  const r = sub.startSubscription(c, { plan_code: req.body?.plan_code, days: req.body?.days, months: req.body?.months, no_expiry: !!req.body?.no_expiry, contact_email: req.body?.contact_email, actor: actor(req) });
  P.bust(); res.json({ ok: true, subscription: sub.snapshot(c, { withUsage: false }), started: !!r });
}));
router.put('/companies/:code/branding', handle((req, res) => { res.json({ ok: true, branding: extras.saveBranding(company(req), req.body || {}, actor(req), req.ip) }); }));

// backups
router.post('/companies/:code/backups', handle((req, res) => {
  const c = company(req);
  if (c.status !== 'ACTIVE') throw new PlatformError('Only an active company can be backed up.', 409);
  const b = backup.backupCompany(c, { kind: 'MANUAL', actor: actor(req), note: String(req.body?.note || '').slice(0, 200) || null });
  backup.prune(c.company_code); audit(actor(req), 'BACKUP_CREATED', c.company_code, { file: b.file_name }, req.ip);
  res.status(201).json({ ok: true, backup: b });
}));
router.get('/backups', handle((req, res) => res.json({ backups: backup.listAll(req.query.limit), settings: backup.getSettings(), disk_bytes: backup.diskUsage() })));
router.get('/backups/:id/download', P.requireOwner, handle((req, res) => {
  const f = backup.downloadInfo(req.params.id);
  audit(actor(req), 'BACKUP_DOWNLOADED', f.name, {}, req.ip);
  res.download(f.path, f.name);
}));
router.post('/backups/:id/restore', handle((req, res) => res.json({ ok: true, ...backup.restoreBackup(req.params.id, actor(req), req.ip) })));
router.post('/backups/:id/restore-as-new', handle((req, res) => {
  const c = P.restoreBackupAsNew(req.params.id, { company_code: req.body?.company_code, company_name: req.body?.company_name }, actor(req), req.ip);
  res.status(201).json({ ok: true, company_code: c.company_code });
}));
router.delete('/backups/:id', handle((req, res) => { backup.deleteBackup(req.params.id, actor(req), req.ip); res.json({ ok: true }); }));
router.put('/backup-settings', handle((req, res) => res.json({ ok: true, settings: backup.saveSettings(req.body || {}, actor(req), req.ip) })));
router.post('/backups/run-all', handle(async (req, res) => { const r = await backup.runNightly(actor(req)); res.json({ ok: true, ...r }); }));

// ---------------------------- plans / billing / announcements -------------------
router.get('/plans', handle((req, res) => res.json({ plans: sub.listPlans(), modules: sub.GATED_MODULES.map(([key, label]) => ({ key, label })), defaults: { grace_days: (getSetting('subscription', {}).grace_days ?? 7), limit_action: getSetting('subscription', {}).limit_action || 'WARN' } })));
router.post('/plans', handle((req, res) => res.json({ ok: true, plan: sub.savePlan(req.body || {}, actor(req), req.ip) })));
router.delete('/plans/:code', handle((req, res) => { sub.deletePlan(req.params.code, actor(req), req.ip); res.json({ ok: true }); }));

router.get('/billing', handle((req, res) => res.json({ records: billing.list({ company_code: req.query.company, status: req.query.status }), summary: billing.summary(), revenue: billing.revenueSeries(12) })));
router.post('/billing', handle((req, res) => res.status(201).json({ ok: true, record: billing.create(req.body || {}, actor(req), req.ip) })));
router.post('/billing/:id/pay', handle((req, res) => { const r = billing.markPaid(req.params.id, req.body || {}, actor(req), req.ip); P.bust(); res.json({ ok: true, ...r }); }));
router.post('/billing/:id/void', handle((req, res) => { billing.voidRecord(req.params.id, actor(req), req.ip); res.json({ ok: true }); }));

router.get('/announcements', handle((req, res) => res.json({ announcements: extras.listAnnouncements() })));
router.post('/announcements', handle((req, res) => res.status(201).json({ ok: true, ...extras.createAnnouncement(req.body || {}, actor(req), req.ip) })));
router.put('/announcements/:id', handle((req, res) => { extras.updateAnnouncement(req.params.id, req.body || {}, actor(req), req.ip); res.json({ ok: true }); }));
router.delete('/announcements/:id', handle((req, res) => { extras.deleteAnnouncement(req.params.id, actor(req), req.ip); res.json({ ok: true }); }));

// ---------------------------- team / security / settings (owner only) -------------
router.get('/team', P.requireOwner, handle((req, res) => res.json({ team: P.listTeam() })));
router.post('/team', P.requireOwner, handle((req, res) => res.status(201).json({ ok: true, ...P.createTeamMember(req.body || {}, actor(req), req.ip) })));
router.put('/team/:id', P.requireOwner, handle((req, res) => { P.updateTeamMember(req.params.id, req.body || {}, req.platformAdmin.id, actor(req), req.ip); res.json({ ok: true }); }));
router.post('/team/:id/reset-password', P.requireOwner, handle((req, res) => { P.resetTeamPassword(req.params.id, req.body?.new_password, actor(req), req.ip); res.json({ ok: true }); }));
router.post('/team/:id/reset-2fa', P.requireOwner, handle((req, res) => { P.twoFactorReset(req.params.id, actor(req), req.ip); res.json({ ok: true }); }));

router.get('/security', P.requireOwner, handle((req, res) => res.json(P.getSecurity(req.ip))));
router.put('/security', P.requireOwner, handle((req, res) => res.json({ ok: true, ...P.saveSecurity(req.body || {}, req.ip, actor(req), req.ip) })));

router.get('/settings/mail', P.requireOwner, handle((req, res) => res.json({ mail: mailer.publicConfig(), log: mailer.recentLog(50) })));
router.put('/settings/mail', P.requireOwner, handle((req, res) => { mailer.saveConfig(req.body || {}, actor(req), req.ip); res.json({ ok: true, mail: mailer.publicConfig() }); }));
router.post('/settings/mail/test', P.requireOwner, handle(async (req, res) => { await mailer.sendTest(req.body?.to); res.json({ ok: true, message: 'Test email sent.' }); }));
router.get('/settings/general', handle((req, res) => res.json({ payment: getSetting('payment', {}), contact: getSetting('contact', {}), subscription: { grace_days: getSetting('subscription', {}).grace_days ?? 7, limit_action: getSetting('subscription', {}).limit_action || 'WARN' } })));
router.put('/settings/general', P.requireOwner, handle((req, res) => {
  const c = req.body?.contact || {}; const s = req.body?.subscription || {};
  const grace = Math.floor(Number(s.grace_days ?? 7));
  if (!(grace >= 0 && grace <= 365)) throw new PlatformError('Default grace period must be 0-365 days.');
  const email = String(c.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PlatformError('Enter a valid support email.');
  setSetting('payment', { instructions: String((req.body?.payment || {}).instructions || '').trim().slice(0, 600) });
  setSetting('contact', { name: String(c.name || '').trim().slice(0, 80), email, phone: String(c.phone || '').trim().slice(0, 30) });
  setSetting('subscription', { grace_days: grace, limit_action: String(s.limit_action).toUpperCase() === 'BLOCK' ? 'BLOCK' : 'WARN' });
  audit(actor(req), 'PLATFORM_SETTINGS_SAVED', null, {}, req.ip);
  res.json({ ok: true });
}));

// ---------------------------- plan requests (companies asking to buy / renew) ----
const PR = require('../lib/planRequests');
router.get('/plan-requests', handle((req, res) => res.json({ requests: PR.list(String(req.query.status || '').toUpperCase() || null), months: PR.MONTHS })));
router.post('/plan-requests/:id/approve', handle((req, res) => { const r = PR.approve(req.params.id, req.body || {}, actor(req), req.ip); P.bust(); res.json({ ok: true, ...r }); }));
router.post('/plan-requests/:id/reject', handle((req, res) => { PR.reject(req.params.id, req.body?.note, actor(req), req.ip); res.json({ ok: true }); }));

// ---------------------------- requests / audit -----------------------------------
router.get('/requests', handle((req, res) => res.json({ requests: P.listRequests(String(req.query.status || '').toUpperCase()) })));
router.post('/requests/:id/approve', handle((req, res) => res.json({ ok: true, ...P.approveRequest(req.params.id, { company_code: req.body?.company_code, note: req.body?.note, plan_code: req.body?.plan_code, days: req.body?.days }, actor(req), req.ip, origin(req)) })));
router.post('/requests/:id/reject', handle((req, res) => { P.rejectRequest(req.params.id, req.body?.note, actor(req), req.ip); res.json({ ok: true }); }));

router.get('/audit', handle((req, res) => res.json({ logs: P.platformAudit(req.query.limit) })));

module.exports = router;
