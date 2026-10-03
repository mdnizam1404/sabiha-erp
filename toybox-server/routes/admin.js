// ============================================================================
// routes/admin.js — auth, users & role approval, company settings, backup, PDF
// ============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { db, DATA_DIR, BACKUP_DIR, MODULE_KEYS, audit, checkLoginLock, recordFailedLogin, clearLoginAttempts } = require('../db');
const { SECRET, requireRole, requireModule } = require('../auth');
const { sendPdf: sendWhatsAppPdf, isConfigured: isWhatsAppConfigured, config: whatsappConfig, testConnection: testWhatsAppConnection } = require('../lib/whatsapp');
const { cfg: smsConfig, isConfigured: isSmsConfigured, normalizePhone: normalizeSmsPhone, sendOtp: sendSmsOtp, sendTest: sendSmsTest, writeEnv: writeSmsEnv } = require('../lib/sms');
const { validateBody, z } = require('../lib/validate');
const { getCompanyByCode, defaultCompanyCode, withCompany } = require('../lib/multitenant');
const sub = require('../lib/subscription');
const mailer = require('../lib/mailer');
const extras = require('../lib/extras');
const { loginSchema, userCreateSchema, userStatusSchema, userEmployeeSchema, userRoleSchema, passwordResetSchema } = require('../lib/schemas');

const router = express.Router();
const publicRouter = express.Router();

function tenantLoginContext(req, res, next) {
  const code = String(req.body?.company_code || defaultCompanyCode).trim().toUpperCase();
  const company = getCompanyByCode(code);
  if (!company) return res.status(404).json({ error: `Company code ${code} was not found.` });
  if (company.status !== 'ACTIVE') return res.status(403).json({ error: `Company ${code} is currently ${company.status.toLowerCase()}.` });
  return withCompany(company, () => { req.company = company; next(); });
}
// Registration must name a company explicitly — never fall back to the default one.
function registrationContext(req, res, next) {
  const code = String(req.body?.company_code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Please select your company first.' });
  req.body.company_code = code;
  return tenantLoginContext(req, res, next);
}
function markLogin(userId) {
  try { db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString().replace('T', ' ').slice(0, 19), userId); } catch (_) { /* monitoring only */ }
}
function validRoleNames() { return db.prepare('SELECT name FROM roles').all().map((r) => r.name); }
function hashLoginOtp(code) {
  return require('crypto').createHash('sha256').update(String(code) + SECRET).digest('hex');
}
function generateLoginOtp() { return String(require('crypto').randomInt(100000, 1000000)); }
function userPhoneForOtp(user) {
  const own = normalizeSmsPhone(user.phone);
  if (own) return own;
  if (user.employee_id) {
    const e = db.prepare('SELECT phone FROM employees WHERE id = ?').get(user.employee_id);
    return normalizeSmsPhone(e && e.phone);
  }
  return '';
}
function otpChallengePayload(challenge) {
  return { challenge_id: challenge.id, otp_expires_at: challenge.expires_at, resend_after_seconds: Math.max(0, smsConfig().resendSeconds - Math.floor((Date.now() - new Date(challenge.last_sent_at).getTime()) / 1000)) };
}
function getPermissionsForRole(role, snap) {
  let perms;
  if (role === 'ADMIN') { perms = {}; MODULE_KEYS.forEach((k) => { perms[k] = true; }); }
  else {
    const rows = db.prepare(`SELECT module_key, allowed FROM role_permissions WHERE role_name = ?`).all(role);
    perms = {};
    MODULE_KEYS.forEach((k) => { perms[k] = false; });
    rows.forEach((r) => { perms[r.module_key] = !!r.allowed; });
  }
  return sub.maskPermissions(snap, perms); // modules the company's plan does not include are hidden for everyone
}
// Modules this person would normally see but the plan does not include — the menu shows them locked, with the reason on click.
function planLockedFor(role, snap) { return sub.lockedModules(snap, getPermissionsForRole(role)); }
// Records every company sign-in (who, when, from where) in the platform database for the owner's console.
function loginAudit(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => {
    try {
      const code = req.company && req.company.company_code;
      if (code && body) {
        const ua = req.headers['user-agent'];
        if (body.token && body.user) extras.recordLogin(code, body.user.username, true, null, req.ip, ua);
        else if (!body.otp_required && res.statusCode >= 400 && body.error) extras.recordLogin(code, String(req.body?.username || '').trim(), false, body.error, req.ip, ua);
      }
    } catch (_) { /* history must never break a login */ }
    return orig(body);
  };
  next();
}

// (Platform provisioning / super-admin API now lives in routes/platform.js)

publicRouter.get('/version', (req, res) => {
  const pkg = require('../package.json');
  res.json({ version: pkg.version, name: pkg.name });
});
function fmtLockUntil(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function normalizeLoginRole(role) {
  const raw = String(role || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (raw === 'SALES_PERSON' || raw === 'SALESPERSON' || raw === 'SALES_EXECUTIVE') return 'SALES';
  if (raw === 'ACCOUNTS' || raw === 'ACCOUNT') return 'ACCOUNTANT';
  if (raw === 'ADMINISTRATOR') return 'ADMIN';
  if (raw === 'MANAGEMENT') return 'MANAGER';
  return raw || 'STAFF';
}

publicRouter.post('/auth/login', validateBody(loginSchema), tenantLoginContext, loginAudit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const companyCode = String(req.company?.company_code || defaultCompanyCode).toUpperCase();
  const password = String(req.body.password || '');
  if (!username && !password) return res.status(400).json({ error: 'Please enter your User ID and password.' });
  if (!username) return res.status(400).json({ error: 'Please enter your User ID.' });
  if (!password) return res.status(400).json({ error: 'Please enter your password.' });

  // Login identifiers are case-insensitive and whitespace-tolerant. Legacy
  // databases may also contain NULL active values, so NULL is treated as
  // active for backward compatibility unless Admin explicitly deactivated
  // the account.
  const lock = checkLoginLock(username);
  if (lock.locked) {
    return res.status(403).json({
      error: `This account is locked due to too many failed attempts. Please try again after ${fmtLockUntil(lock.lockedUntil)}.`,
      locked: true, lockedUntil: lock.lockedUntil,
    });
  }

  const user = db.prepare(`SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1`).get(username);
  if (!user) {
    const result = recordFailedLogin(username);
    if (result.locked) {
      return res.status(403).json({
        error: `Too many failed attempts (${result.attempt} of ${result.maxAttempts}). This account is now locked for 24 hours. Please try again after ${fmtLockUntil(result.lockedUntil)}.`,
        locked: true, lockedUntil: result.lockedUntil, attempt: result.attempt, maxAttempts: result.maxAttempts,
      });
    }
    const remaining = result.maxAttempts - result.attempt;
    return res.status(401).json({
      error: `Wrong User ID. No account was found for this User ID. Attempt ${result.attempt} of ${result.maxAttempts}; ${remaining} attempt${remaining === 1 ? '' : 's'} left before temporary lockout.`,
      locked: false, attempt: result.attempt, maxAttempts: result.maxAttempts,
    });
  }

  const passwordOk = !!user.password_hash && bcrypt.compareSync(password, user.password_hash);
  if (!passwordOk) {
    const result = recordFailedLogin(username);
    if (result.locked) {
      return res.status(403).json({
        error: `Wrong password. Too many failed attempts (${result.attempt} of ${result.maxAttempts}). This account is now locked for 24 hours. Please try again after ${fmtLockUntil(result.lockedUntil)}.`,
        locked: true, lockedUntil: result.lockedUntil, attempt: result.attempt, maxAttempts: result.maxAttempts,
      });
    }
    const remaining = result.maxAttempts - result.attempt;
    return res.status(401).json({
      error: `Wrong password for this User ID. Attempt ${result.attempt} of ${result.maxAttempts}; ${remaining} attempt${remaining === 1 ? '' : 's'} left before temporary lockout.`,
      locked: false, attempt: result.attempt, maxAttempts: result.maxAttempts,
    });
  }

  clearLoginAttempts(username);
  const status = String(user.status || 'Approved').trim().toLowerCase();
  const active = user.active === null || user.active === undefined ? 1 : Number(user.active);
  if (active !== 1) {
    return res.status(403).json({ error: 'Your account is inactive. Please ask the Administrator to activate/approve your User ID.' });
  }
  if (status !== 'approved') {
    if (status === 'pending') return res.status(403).json({ error: 'Your User ID is pending Administrator approval. Please ask the Administrator to approve it before signing in.' });
    if (status === 'rejected') return res.status(403).json({ error: 'Your User ID was rejected by the Administrator. Please contact the Administrator.' });
    return res.status(403).json({ error: `Your User ID is ${status}. Please ask the Administrator to approve it before signing in.` });
  }

  const role = normalizeLoginRole(user.role);
  const sms = smsConfig();
  if (sms.enabled) {
    if (!isSmsConfigured()) return res.status(503).json({ error: 'SMS OTP login is enabled, but the SMS Gateway is not configured. Please ask the Administrator to configure it in Settings → SMS Gateway.' });
    const phone = userPhoneForOtp(user);
    if (!phone) return res.status(400).json({ error: 'No valid mobile number is registered for this User ID. Ask the Administrator to add the mobile number to the linked Employee or User record.' });
    const existing = db.prepare('SELECT * FROM login_otp_challenges WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    if (existing && Date.now() - new Date(existing.last_sent_at).getTime() < sms.resendSeconds * 1000) {
      return res.status(429).json({ error: `Please wait ${Math.ceil((sms.resendSeconds * 1000 - (Date.now() - new Date(existing.last_sent_at).getTime())) / 1000)} seconds before requesting another OTP.`, otp_required: true, ...otpChallengePayload(existing) });
    }
    const code = generateLoginOtp();
    const challengeId = require('crypto').randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + sms.otpExpiryMinutes * 60 * 1000).toISOString();
    try {
      await sendSmsOtp({ phone, code });
    } catch (e) {
      return res.status(502).json({ error: `SMS OTP could not be sent: ${e.message}` });
    }
    db.prepare('DELETE FROM login_otp_challenges WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO login_otp_challenges (id,user_id,username,phone,otp_hash,expires_at,attempts,last_sent_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(challengeId, user.id, user.username, phone, hashLoginOtp(code), expiresAt, new Date().toISOString());
    return res.json({ otp_required: true, ...otpChallengePayload({ id: challengeId, expires_at: expiresAt, last_sent_at: new Date().toISOString() }), masked_phone: phone.replace(/^(\d{2})\d+(\d{2})$/, '$1******$2'), message: `A login OTP was sent by SMS to your registered mobile number. It expires in ${sms.otpExpiryMinutes} minutes.` });
  }
  markLogin(user.id);
  const token = jwt.sign({ id: user.id, username: user.username, role, full_name: user.full_name, employee_id: user.employee_id || null, company_id: req.company.id, company_code: companyCode, branch_id: user.branch_id || null, jti: require('crypto').randomUUID() }, SECRET, { expiresIn: '12h' });
  res.json({ token, company: { id: req.company.id, company_code: companyCode, company_name: req.company.company_name }, user: { id: user.id, username: user.username, role, full_name: user.full_name, employee_id: user.employee_id || null, branch_id: user.branch_id || null, must_change_password: Number(user.must_change_password) === 1, permissions: getPermissionsForRole(role, sub.snapshot(req.company, { withUsage: false })), plan_locked: planLockedFor(role, sub.snapshot(req.company, { withUsage: false })) } });
});

publicRouter.post('/auth/login/resend-otp', tenantLoginContext, async (req, res) => {
  const id = String(req.body.challenge_id || '').trim();
  const ch = db.prepare('SELECT c.*, u.status, u.active, u.phone AS user_phone, u.employee_id FROM login_otp_challenges c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(id);
  if (!ch) return res.status(400).json({ error: 'This OTP session has expired. Please sign in again.' });
  const sms = smsConfig();
  const wait = sms.resendSeconds * 1000 - (Date.now() - new Date(ch.last_sent_at).getTime());
  if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another OTP.` });
  if (!isSmsConfigured()) return res.status(503).json({ error: 'SMS Gateway is not configured.' });
  const phone = userPhoneForOtp({ phone: ch.user_phone, employee_id: ch.employee_id });
  if (!phone) return res.status(400).json({ error: 'No valid registered mobile number was found.' });
  const code = generateLoginOtp();
  const expiresAt = new Date(Date.now() + sms.otpExpiryMinutes * 60 * 1000).toISOString();
  try { await sendSmsOtp({ phone, code }); } catch (e) { return res.status(502).json({ error: `SMS OTP could not be sent: ${e.message}` }); }
  db.prepare('UPDATE login_otp_challenges SET otp_hash=?, expires_at=?, attempts=0, last_sent_at=? WHERE id=?').run(hashLoginOtp(code), expiresAt, new Date().toISOString(), id);
  const updated = db.prepare('SELECT id,expires_at,last_sent_at FROM login_otp_challenges WHERE id=?').get(id);
  res.json({ ok: true, ...otpChallengePayload(updated), masked_phone: phone.replace(/^(\d{2})\d+(\d{2})$/, '$1******$2'), message: 'A new login OTP was sent by SMS.' });
});

publicRouter.post('/auth/login/verify-otp', tenantLoginContext, loginAudit, (req, res) => {
  const id = String(req.body.challenge_id || '').trim();
  const code = String(req.body.code || '').trim();
  const ch = db.prepare('SELECT c.*, u.username, u.full_name, u.role, u.employee_id, u.status, u.active, u.must_change_password FROM login_otp_challenges c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(id);
  if (!ch) return res.status(400).json({ error: 'This OTP session has expired. Please sign in again.' });
  if (new Date(ch.expires_at) < new Date()) { db.prepare('DELETE FROM login_otp_challenges WHERE id=?').run(id); return res.status(400).json({ error: 'That OTP has expired. Please sign in again and request a new OTP.' }); }
  if (ch.attempts >= 5) { db.prepare('DELETE FROM login_otp_challenges WHERE id=?').run(id); return res.status(429).json({ error: 'Too many incorrect OTP attempts. Please sign in again to request a new OTP.' }); }
  if (!/^\d{6}$/.test(code) || hashLoginOtp(code) !== ch.otp_hash) {
    db.prepare('UPDATE login_otp_challenges SET attempts=attempts+1 WHERE id=?').run(id);
    const left = Math.max(0, 4 - ch.attempts);
    return res.status(401).json({ error: `Incorrect OTP. ${left} attempt${left===1?'':'s'} left.` });
  }
  if (Number(ch.active || 0) !== 1 || String(ch.status || 'Approved').toLowerCase() !== 'approved') { db.prepare('DELETE FROM login_otp_challenges WHERE id=?').run(id); return res.status(403).json({ error: 'This account is not approved or active.' }); }
  const role = normalizeLoginRole(ch.role);
  db.prepare('UPDATE login_otp_challenges SET verified_at=? WHERE id=?').run(new Date().toISOString(), id);
  db.prepare('DELETE FROM login_otp_challenges WHERE id=?').run(id);
  markLogin(ch.user_id);
  const token = jwt.sign({ id: ch.user_id, username: ch.username, role, full_name: ch.full_name, employee_id: ch.employee_id || null, company_id: req.company.id, company_code: req.company.company_code, branch_id: ch.branch_id || null, jti: require('crypto').randomUUID() }, SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: ch.user_id, username: ch.username, role, full_name: ch.full_name, employee_id: ch.employee_id || null, must_change_password: Number(ch.must_change_password) === 1, permissions: getPermissionsForRole(role, sub.snapshot(req.company, { withUsage: false })) } });
});

publicRouter.post('/auth/forgot-password', registrationContext, (req, res) => {
  const { username } = req.body;
  const user = db.prepare(`SELECT id FROM users WHERE username = ? AND active = 1`).get(username);
  if (user) db.prepare(`UPDATE users SET reset_requested = 1 WHERE id = ?`).run(user.id);
  // Same message either way — this app has no email/SMS sender, so a
  // password reset is completed by an Administrator inside Users & Roles,
  // not by an automatic email link.
  res.json({ ok: true, message: 'If that User ID exists, an administrator has been notified and can reset your password from Users & Roles.' });
});

// ---------------------------------------------------------------------------
// Self-registration — email/phone must be verified with an OTP code before
// the account is created (still goes to Pending admin approval after that).
// Two steps: /register/start (send OTP) → /register/verify (create account).
// ---------------------------------------------------------------------------
const nodemailer = require('nodemailer');
function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
async function sendOtpEmail(to, code) {
  const s = db.prepare(`SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, company_name FROM company_settings WHERE id = 1`).get();
  if (!s.smtp_host || !s.smtp_user) return { sent: false, reason: 'not_configured' };
  try {
    const transporter = nodemailer.createTransport({ host: s.smtp_host, port: s.smtp_port || 587, secure: !!s.smtp_secure, auth: { user: s.smtp_user, pass: s.smtp_pass } });
    await transporter.sendMail({
      from: s.smtp_from || s.smtp_user, to,
      subject: `Your verification code — ${s.company_name || 'SABIHA ERP'}`,
      text: `Your verification code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
publicRouter.post('/auth/register/start', registrationContext, async (req, res) => {
  const { username, password, full_name, role, email, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (!validRoleNames().includes(role) || role === 'ADMIN') return res.status(400).json({ error: 'Please choose a valid role (Manager, Sales, or Accountant)' });
  if (!email && !phone) return res.status(400).json({ error: 'Enter an email address or phone number to verify' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`).get(username)) return res.status(400).json({ error: 'That User ID is already taken (User IDs are case-insensitive).' });

  const channel = email ? 'email' : 'phone';
  const target = email || phone;
  const code = genOtp();
  const token = require('crypto').randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM pending_registrations WHERE username = ?`).run(username); // clear any stale prior attempt
  db.prepare(`
    INSERT INTO pending_registrations (token, username, password_hash, full_name, role, email, phone, channel, otp_code, otp_expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(token, username, bcrypt.hashSync(password, 10), full_name || username, role, email || null, phone || null, channel, code, expiresAt);

  if (channel === 'email') {
    const result = await sendOtpEmail(email, code);
    if (result.sent) return res.json({ ok: true, token, channel, message: `A 6-digit code was sent to ${email}. Enter it below to continue.` });
    // No SMTP configured (or sending failed) — don't block registration on an
    // offline/standalone install with no mail server set up; show the code
    // directly instead so the OTP step still means something.
    return res.json({ ok: true, token, channel, devCode: code, message: `Email sending isn't configured yet, so here's your verification code directly: ${code}` });
  }
  // Phone/SMS: no SMS gateway is integrated (that needs a paid provider like
  // MSG91/Twilio configured with real credentials this app doesn't have) —
  // show the code directly so phone-only signup still works end to end.
  res.json({ ok: true, token, channel, devCode: code, message: `SMS sending isn't set up, so here's your verification code directly: ${code}` });
});
publicRouter.post('/auth/register/resend', registrationContext, async (req, res) => {
  const { token } = req.body;
  const pending = db.prepare(`SELECT * FROM pending_registrations WHERE token = ?`).get(token);
  if (!pending) return res.status(400).json({ error: 'That registration has expired. Please start again.' });
  const code = genOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`UPDATE pending_registrations SET otp_code = ?, otp_expires_at = ?, attempts = 0 WHERE token = ?`).run(code, expiresAt, token);
  if (pending.channel === 'email') {
    const result = await sendOtpEmail(pending.email, code);
    if (result.sent) return res.json({ ok: true, message: `A new code was sent to ${pending.email}.` });
    return res.json({ ok: true, devCode: code, message: `Here's your new verification code: ${code}` });
  }
  res.json({ ok: true, devCode: code, message: `Here's your new verification code: ${code}` });
});
publicRouter.post('/auth/register/verify', registrationContext, (req, res) => {
  const { token, code } = req.body;
  const pending = db.prepare(`SELECT * FROM pending_registrations WHERE token = ?`).get(token);
  if (!pending) return res.status(400).json({ error: 'That registration has expired. Please start again.' });
  if (pending.attempts >= 5) return res.status(400).json({ error: 'Too many incorrect attempts. Please start registration again.' });
  if (new Date(pending.otp_expires_at) < new Date()) return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
  if (String(code).trim() !== pending.otp_code) {
    db.prepare(`UPDATE pending_registrations SET attempts = attempts + 1 WHERE token = ?`).run(token);
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }
  try {
    db.prepare(`INSERT INTO users (username, password_hash, full_name, role, status, email, phone) VALUES (?,?,?,?, 'Pending', ?, ?)`)
      .run(pending.username, pending.password_hash, pending.full_name, pending.role, pending.email, pending.phone);
  } catch (e) {
    return res.status(400).json({ error: 'That username is already taken' });
  }
  db.prepare(`DELETE FROM pending_registrations WHERE token = ?`).run(token);
  res.json({ ok: true, message: 'Verified! Your account was created and now needs an administrator to approve it before you can sign in.' });
});

router.get('/me', (req, res) => {
  const snap = req.subscription || sub.snapshot(req.company, { withUsage: false });
  const out = { ...req.user, permissions: getPermissionsForRole(req.user.role, snap), plan_locked: planLockedFor(req.user.role, snap) };
  if (req.user.role === 'ADMIN') out.pending_users = Number(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE LOWER(COALESCE(status,'pending')) = 'pending'`).get().n || 0);
  const isAdmin = req.user.role === 'ADMIN';
  const full = isAdmin ? sub.snapshot(req.company) : snap;            // usage figures only for the company admin
  out.subscription = {
    legacy: full.legacy, plan_name: full.plan_name, is_trial: full.is_trial, state: full.state, days_left: full.days_left, expires_on: full.expires_on,
    read_only: full.read_only, limits: isAdmin ? full.limits : undefined, usage: isAdmin ? full.usage : undefined,
    notice: isAdmin || full.read_only ? full.notice : null, warnings: isAdmin ? full.warnings : [],
  };
  try { out.announcements = extras.activeAnnouncements(); } catch (_) { out.announcements = []; }
  const me = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.user.id);
  out.must_change_password = !!(me && Number(me.must_change_password) === 1);
  res.json(out);
});

// Sign-in password change for the logged-in user (also how a platform-issued password is replaced).
router.post('/auth/change-password', (req, res) => {
  const current = String(req.body?.current_password || '');
  const next = String(req.body?.new_password || '');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !bcrypt.compareSync(current, u.password_hash || '')) return res.status(400).json({ error: 'Your current password is not correct.' });
  if (next.length < 8 || next.length > 200 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return res.status(400).json({ error: 'The new password must be at least 8 characters and contain a letter and a number.' });
  if (next === current) return res.status(400).json({ error: 'The new password must be different from the current one.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, reset_requested = 0 WHERE id = ?').run(bcrypt.hashSync(next, 10), u.id);
  clearLoginAttempts(u.username);
  audit(req, 'UPDATE', 'users', u.id, { action: 'password_changed_by_user' });
  res.json({ ok: true, message: 'Password changed.' });
});

// Branches (head office, factory, depot …). Limited by the company's plan.
router.get('/branches', (req, res) => res.json(db.prepare('SELECT id, branch_code, branch_name, branch_type, address, phone, gst_no, active FROM branches ORDER BY id').all()));
router.post('/branches', requireRole('ADMIN'), sub.checkLimit('branches'), (req, res) => {
  const code = String(req.body?.branch_code || '').trim().toUpperCase();
  const name = String(req.body?.branch_name || '').trim();
  const type = String(req.body?.branch_type || 'BRANCH').toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return res.status(400).json({ error: 'Branch code must be 2-20 letters, numbers, _ or -.' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter the branch name.' });
  if (!['HEAD_OFFICE', 'FACTORY', 'BRANCH', 'WAREHOUSE', 'DEPOT'].includes(type)) return res.status(400).json({ error: 'Invalid branch type.' });
  if (db.prepare('SELECT id FROM branches WHERE branch_code = ?').get(code)) return res.status(400).json({ error: 'That branch code already exists.' });
  const info = db.prepare('INSERT INTO branches (branch_code, branch_name, branch_type, address, phone, gst_no) VALUES (?,?,?,?,?,?)').run(code, name, type, req.body?.address || null, req.body?.phone || null, req.body?.gst_no || null);
  audit(req, 'CREATE', 'branches', info.lastInsertRowid, { code, name });
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.put('/branches/:id', requireRole('ADMIN'), (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Branch not found.' });
  const name = String(req.body?.branch_name ?? b.branch_name).trim();
  if (name.length < 2) return res.status(400).json({ error: 'Enter the branch name.' });
  const active = req.body?.active === undefined ? b.active : (req.body.active ? 1 : 0);
  db.prepare('UPDATE branches SET branch_name = ?, address = ?, phone = ?, gst_no = ?, active = ? WHERE id = ?').run(name, req.body?.address ?? b.address, req.body?.phone ?? b.phone, req.body?.gst_no ?? b.gst_no, active, b.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin password gate — required before any Edit or Delete action anywhere
// in the app. Checks the given password against any active, approved ADMIN
// account (not necessarily the currently logged-in user), since the whole
// point is Admin authorization for a potentially non-admin user's action.
// ---------------------------------------------------------------------------
router.post('/auth/verify-admin-password', validateBody(z.object({ password: z.string().min(1).max(500) }).passthrough()), (req, res) => {
  const { password } = req.body;
  const admins = db.prepare(`SELECT * FROM users WHERE role = 'ADMIN' AND status = 'Approved' AND active = 1`).all();
  const ok = admins.some((a) => bcrypt.compareSync(password || '', a.password_hash));
  if (!ok) return res.status(401).json({ error: 'Incorrect admin password. Please try again.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Users & Roles (ADMIN only) — approve, change role, activate/deactivate
// ---------------------------------------------------------------------------
router.get('/users', requireRole('ADMIN'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, u.status, u.active, u.reset_requested, u.created_at, u.employee_id, u.phone, u.email, u.last_login_at, e.name employee_name
    FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.id DESC`).all());
});
router.post('/users', requireRole('ADMIN'), sub.checkLimit('users'), validateBody(userCreateSchema), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const full_name = String(req.body.full_name || username).trim();
  const role = String(req.body.role || '').trim().toUpperCase();
  const employee_id = req.body.employee_id || null;
  const phone = String(req.body.phone || '').trim() || null;
  if (!username) return res.status(400).json({ error: 'Please enter a User ID.' });
  if (!validRoleNames().includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`).get(username)) {
    return res.status(400).json({ error: 'That User ID is already taken (User IDs are case-insensitive).' });
  }
  try {
    const info = db.prepare(`INSERT INTO users (username, password_hash, full_name, role, status, active, employee_id, phone) VALUES (?,?,?,?, 'Approved', 1, ?, ?)`)
      .run(username, bcrypt.hashSync(password || 'changeme', 10), full_name, role, employee_id, phone);
    audit(req, 'CREATE', 'users', info.lastInsertRowid, { username, role, employee_id });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'That username is already taken' });
  }
});
// Links (or unlinks, with employee_id: null) this login to an Employee
// record — required for sales/incentive attribution to know who this user
// is on the shop floor, not just what role they log in with.
router.put('/users/:id/employee', requireRole('ADMIN'), validateBody(userEmployeeSchema), (req, res) => {
  db.prepare(`UPDATE users SET employee_id = ? WHERE id = ?`).run(req.body.employee_id || null, req.params.id);
  audit(req, 'UPDATE', 'users', req.params.id, { employee_id: req.body.employee_id });
  res.json({ ok: true });
});
router.put('/users/:id/phone', requireRole('ADMIN'), (req, res) => {
  const phone = String(req.body.phone || '').trim() || null;
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.params.id);
  audit(req, 'UPDATE', 'users', req.params.id, { phone: phone ? '(updated)' : '(cleared)' });
  res.json({ ok: true });
});
router.put('/users/:id/role', requireRole('ADMIN'), validateBody(userRoleSchema), (req, res) => {
  if (!validRoleNames().includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(req.body.role, req.params.id);
  audit(req, 'UPDATE', 'users', req.params.id, { role: req.body.role });
  res.json({ ok: true });
});
router.put('/users/:id/status', requireRole('ADMIN'), validateBody(userStatusSchema), (req, res, next) => (req.body.status === 'Approved' ? sub.checkLimit('users')(req, res, next) : next()), (req, res) => {
  const status = ['Approved','Pending','Rejected'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Invalid user status' });
  const before = db.prepare(`SELECT status, username, full_name, email FROM users WHERE id = ?`).get(req.params.id);
  db.prepare(`UPDATE users SET status = ?, active = CASE WHEN ? = 'Approved' THEN 1 ELSE active END WHERE id = ?`).run(status, status, req.params.id);
  if (status === 'Approved') {
    // Make sure the approved user's role has a permission row for every module
    // (existing Administrator choices are kept; missing rows default to off,
    // except built-in SALES which gets its standard modules).
    const u = db.prepare(`SELECT role FROM users WHERE id = ?`).get(req.params.id);
    if (u) {
      const r = normalizeLoginRole(u.role);
      if (r !== u.role) db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(r, req.params.id);
      const salesDefaults = ['dashboard', 'customersSales', 'reminders', 'outsourcing'];
      const ins = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_name, module_key, allowed) VALUES (?,?,?)`);
      MODULE_KEYS.forEach((k) => ins.run(r, k, r === 'SALES' && salesDefaults.includes(k) ? 1 : 0));
    }
  }
  audit(req, 'UPDATE', 'users', req.params.id, { status: req.body.status });
  if (status === 'Approved' && before && String(before.status || '').toLowerCase() !== 'approved' && before.email) {
    mailer.sendTemplate('userApproved', before.email, { username: before.username, full_name: before.full_name, company_name: req.company.company_name, company_code: req.company.company_code, url: mailer.baseUrl(`${req.protocol}://${req.get('host')}`) });
  }
  res.json({ ok: true });
});
router.put('/users/:id/reset-password', requireRole('ADMIN'), validateBody(passwordResetSchema), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Please choose a password at least 4 characters long' });
  db.prepare(`UPDATE users SET password_hash = ?, reset_requested = 0 WHERE id = ?`).run(bcrypt.hashSync(password, 10), req.params.id);
  audit(req, 'UPDATE', 'users', req.params.id, { action: 'password_reset' });
  res.json({ ok: true });
});
router.delete('/users/:id', requireRole('ADMIN'), (req, res) => {
  db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'users', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Roles & Permissions (ADMIN only) — create custom roles, control which
// modules each role can see and use. ADMIN itself always has full access,
// enforced in code (not just by table data), so an admin can never lock
// themselves out by misconfiguring permissions.
// ---------------------------------------------------------------------------
router.get('/roles', requireRole('ADMIN'), (req, res) => {
  const roles = db.prepare(`SELECT * FROM roles ORDER BY is_system DESC, name ASC`).all();
  const withCounts = roles.map((r) => ({
    ...r,
    userCount: db.prepare(`SELECT COUNT(*) n FROM users WHERE role = ? AND active = 1`).get(r.name).n,
    permissions: getPermissionsForRole(r.name),
  }));
  res.json({ roles: withCounts, moduleKeys: MODULE_KEYS });
});
router.post('/roles', requireRole('ADMIN'), (req, res) => {
  const name = (req.body.name || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!name) return res.status(400).json({ error: 'Please enter a role name' });
  try {
    db.prepare(`INSERT INTO roles (name, is_system) VALUES (?, 0)`).run(name);
    const insPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_name, module_key, allowed) VALUES (?,?,0)`);
    MODULE_KEYS.forEach((k) => insPerm.run(name, k));
    audit(req, 'CREATE', 'roles', null, { name });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(400).json({ error: 'A role with that name already exists' });
  }
});
router.delete('/roles/:name', requireRole('ADMIN'), (req, res) => {
  const name = req.params.name;
  const role = db.prepare(`SELECT * FROM roles WHERE name = ?`).get(name);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'Built-in roles (ADMIN, MANAGER, SALES, ACCOUNTANT) cannot be deleted' });
  const inUse = db.prepare(`SELECT COUNT(*) n FROM users WHERE role = ? AND active = 1`).get(name).n;
  if (inUse > 0) return res.status(400).json({ error: `${inUse} active user(s) still have this role — reassign them first` });
  db.prepare(`DELETE FROM role_permissions WHERE role_name = ?`).run(name);
  db.prepare(`DELETE FROM roles WHERE name = ?`).run(name);
  audit(req, 'DELETE', 'roles', null, { name });
  res.json({ ok: true });
});
router.put('/roles/:name/permissions', requireRole('ADMIN'), (req, res) => {
  const name = req.params.name;
  if (name === 'ADMIN') return res.status(400).json({ error: "ADMIN always has full access and can't be restricted" });
  const role = db.prepare(`SELECT * FROM roles WHERE name = ?`).get(name);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const perms = req.body.permissions || {};
  const upsert = db.prepare(`INSERT INTO role_permissions (role_name, module_key, allowed) VALUES (?,?,?)
    ON CONFLICT(role_name, module_key) DO UPDATE SET allowed = excluded.allowed`);
  MODULE_KEYS.forEach((k) => upsert.run(name, k, perms[k] ? 1 : 0));
  audit(req, 'UPDATE', 'roles', null, { name, permissions: perms });
  res.json({ ok: true, permissions: getPermissionsForRole(name) });
});

// ---------------------------------------------------------------------------
// Company settings — profile, logo (base64), theme default, return policy
// ---------------------------------------------------------------------------
publicRouter.get('/settings', (req, res) => {
  res.json(db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get());
});
router.put('/settings', requireRole('ADMIN', 'MANAGER'), (req, res) => {
  const b = req.body;
  const current = db.prepare(`SELECT * FROM company_settings WHERE id=1`).get() || {};
  const val = (key, fallback='') => b[key] !== undefined ? b[key] : (current[key] ?? fallback);
  // Bank/UPI fields use COALESCE so saving from the Company tab (which
  // doesn't send them) never wipes out what was entered on the Payments
  // tab, and vice versa — each tab only overwrites the fields it actually
  // sent, matching how logo_data_url and upi_qr_data_url already worked.
  const orNull = (v) => (v === undefined ? null : v);
  db.prepare(`
    UPDATE company_settings SET company_name=?, address=?, phone=?, email=?, gst_no=?, financial_year_start=?,
      invoice_prefix=?, default_payment_terms=?, logo_data_url=COALESCE(?, logo_data_url), theme_default=?, return_policy=?, corporate_tax_rate_pct=?,
      bank_name=COALESCE(?, bank_name), bank_account_no=COALESCE(?, bank_account_no), bank_ifsc=COALESCE(?, bank_ifsc),
      bank_branch=COALESCE(?, bank_branch), upi_id=COALESCE(?, upi_id), upi_qr_data_url=COALESCE(?, upi_qr_data_url),
      vision_statement=COALESCE(?, vision_statement),
      loyalty_reward_type=?, loyalty_reward_value=?
    WHERE id = 1`).run(val('company_name'), val('address'), val('phone'), val('email'), val('gst_no'), val('financial_year_start'),
    val('invoice_prefix','INV-') || 'INV-', Number(val('default_payment_terms',30)) || 30, b.logo_data_url || null, val('theme_default','light') || 'light', val('return_policy'),
    Number(val('corporate_tax_rate_pct',25)) || 25,
    orNull(b.bank_name), orNull(b.bank_account_no), orNull(b.bank_ifsc), orNull(b.bank_branch), orNull(b.upi_id), b.upi_qr_data_url || null,
    b.vision_statement !== undefined ? b.vision_statement : null,
    b.loyalty_reward_type === undefined ? (current.loyalty_reward_type || 'PERCENT') : (b.loyalty_reward_type === 'FIXED' ? 'FIXED' : 'PERCENT'),
    b.loyalty_reward_value === undefined ? Number(current.loyalty_reward_value || 0) : Math.max(0, Number(b.loyalty_reward_value) || 0));
  audit(req, 'UPDATE', 'company_settings', 1, { ...b, logo_data_url: b.logo_data_url ? '(updated)' : undefined, upi_qr_data_url: b.upi_qr_data_url ? '(updated)' : undefined });
  res.json(db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get());
});
// Removes the UPI QR image without touching anything else in Settings.
router.delete('/settings/upi-qr', requireRole('ADMIN', 'MANAGER'), (req, res) => {
  db.prepare(`UPDATE company_settings SET upi_qr_data_url = NULL WHERE id = 1`).run();
  res.json({ ok: true });
});
// Outgoing-email (SMTP) settings, used only to send registration OTP codes.
// Kept separate from the main settings form since it's a technical,
// admin-only detail most people will never touch.
router.get('/settings/smtp', requireRole('ADMIN'), (req, res) => {
  const s = db.prepare(`SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_from FROM company_settings WHERE id = 1`).get();
  res.json({ ...s, smtp_configured: !!(s.smtp_host && s.smtp_user) });
});
router.put('/settings/smtp', requireRole('ADMIN'), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE company_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=COALESCE(?, smtp_pass), smtp_from=? WHERE id = 1`)
    .run(b.smtp_host || '', Number(b.smtp_port) || 587, b.smtp_secure ? 1 : 0, b.smtp_user || '', b.smtp_pass || null, b.smtp_from || b.smtp_user || '');
  audit(req, 'UPDATE', 'company_settings', 1, { ...b, smtp_pass: b.smtp_pass ? '(updated)' : undefined });
  res.json({ ok: true });
});
// SMS Gateway settings for login OTP. Credentials are kept in .env rather
// than SQLite so database backups do not contain the SMS API key.
router.get('/settings/sms', requireRole('ADMIN'), (req, res) => {
  const c = smsConfig();
  res.json({ provider: c.provider, api_url: c.apiUrl, template_id: c.templateId, sender_id: c.senderId, country_code: c.countryCode, variable_name: c.variableName, enabled: c.enabled, otp_expiry_minutes: c.otpExpiryMinutes, resend_seconds: c.resendSeconds, configured: isSmsConfigured(), auth_key_configured: c.authKeyConfigured, auth_key_masked: c.authKey ? `${c.authKey.slice(0,4)}••••••${c.authKey.slice(-3)}` : '' });
});
router.put('/settings/sms', requireRole('ADMIN'), (req, res) => {
  const provider = String(req.body.provider || 'MSG91').trim().toUpperCase();
  const apiUrl = String(req.body.api_url || 'https://control.msg91.com/api/v5/flow').trim();
  const authKey = String(req.body.auth_key || '').trim();
  const templateId = String(req.body.template_id || '').trim();
  const senderId = String(req.body.sender_id || '').trim();
  const countryCode = String(req.body.country_code || '91').replace(/\D/g, '');
  const variableName = String(req.body.variable_name || 'VAR1').trim() || 'VAR1';
  const enabled = req.body.enabled ? '1' : '0';
  const expiry = Math.max(1, Math.min(15, Number(req.body.otp_expiry_minutes) || 5));
  const resend = Math.max(20, Math.min(300, Number(req.body.resend_seconds) || 30));
  if (provider !== 'MSG91') return res.status(400).json({ error: 'This build currently supports MSG91 for SMS OTP.' });
  if (!apiUrl) return res.status(400).json({ error: 'SMS API URL is required.' });
  if (!templateId) return res.status(400).json({ error: 'MSG91 Template ID is required.' });
  if (!/^\d{1,4}$/.test(countryCode)) return res.status(400).json({ error: 'Country code must contain 1–4 digits.' });
  if (!authKey && !smsConfig().authKey) return res.status(400).json({ error: 'MSG91 Auth Key is required.' });
  try {
    const values = { SMS_PROVIDER: provider, SMS_API_URL: apiUrl, SMS_TEMPLATE_ID: templateId, SMS_SENDER_ID: senderId, SMS_COUNTRY_CODE: countryCode, SMS_VARIABLE_NAME: variableName, SMS_OTP_ENABLED: enabled, SMS_OTP_EXPIRY_MINUTES: expiry, SMS_OTP_RESEND_SECONDS: resend };
    if (authKey) values.SMS_AUTH_KEY = authKey;
    writeSmsEnv(values);
  } catch (e) { return res.status(500).json({ error: e.message }); }
  audit(req, 'UPDATE', 'sms_settings', 1, { provider, api_url: apiUrl, template_id: templateId, sender_id: senderId, country_code: countryCode, variable_name: variableName, enabled: enabled === '1', auth_key: authKey ? '(updated)' : '(unchanged)' });
  res.json({ ok: true, configured: isSmsConfigured(), enabled: smsConfig().enabled });
});
router.post('/settings/sms/test', requireRole('ADMIN'), async (req, res) => {
  const phone = normalizeSmsPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid test mobile number, including country code if needed.' });
  if (!isSmsConfigured()) return res.status(400).json({ error: 'Save a complete MSG91 configuration first.' });
  try { await sendSmsTest({ phone }); res.json({ ok: true, message: `Test SMS submitted to ${phone}.` }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// WhatsApp Business Cloud API settings. Credentials are kept in .env rather
// than SQLite so database backups do not contain the permanent API token.
router.get('/settings/whatsapp', requireRole('ADMIN'), (req, res) => {
  const c = whatsappConfig();
  res.json({
    configured: isWhatsAppConfigured(),
    phone_number_id: c.phoneNumberId,
    graph_version: c.graphVersion,
    access_token_configured: !!c.accessToken,
    access_token_masked: c.accessToken ? `${c.accessToken.slice(0, 6)}••••••${c.accessToken.slice(-4)}` : ''
  });
});
router.post('/settings/whatsapp/test', requireRole('ADMIN'), async (req, res) => {
  try {
    const data = await testWhatsAppConnection();
    res.json({ ok: true, message: 'WhatsApp Business Cloud API connection successful.', data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
router.put('/settings/whatsapp', requireRole('ADMIN'), (req, res) => {
  const phoneNumberId = String(req.body.phone_number_id || '').trim();
  const graphVersion = String(req.body.graph_version || 'v23.0').trim();
  const accessToken = String(req.body.access_token || '').trim();
  if (!phoneNumberId) return res.status(400).json({ error: 'WhatsApp Phone Number ID is required.' });
  if (!/^v\d+\.\d+$/.test(graphVersion)) return res.status(400).json({ error: 'Graph API version must look like v23.0.' });
  if (!accessToken && !process.env.WHATSAPP_ACCESS_TOKEN) return res.status(400).json({ error: 'WhatsApp Access Token is required.' });
  const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const envFile = path.join(appDir, '.env');
  let lines = [];
  try { lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : []; } catch (e) { return res.status(500).json({ error: 'Could not read .env: ' + e.message }); }
  const setEnv = (key, value) => {
    const line = `${key}=${String(value || '').replace(/\r?\n/g, '')}`;
    const i = lines.findIndex((x) => new RegExp(`^\s*${key}\s*=`).test(x));
    if (i >= 0) lines[i] = line; else lines.push(line);
    process.env[key] = String(value || '');
  };
  setEnv('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId);
  setEnv('WHATSAPP_GRAPH_API_VERSION', graphVersion);
  if (accessToken) setEnv('WHATSAPP_ACCESS_TOKEN', accessToken);
  try { fs.writeFileSync(envFile, lines.filter((x, i, a) => i < a.length).join('\n')); } catch (e) { return res.status(500).json({ error: 'Could not save .env: ' + e.message }); }
  audit(req, 'UPDATE', 'whatsapp_settings', 1, { phone_number_id: phoneNumberId, graph_version: graphVersion, access_token: accessToken ? '(updated)' : '(unchanged)' });
  res.json({ ok: true, configured: isWhatsAppConfigured(), phone_number_id: phoneNumberId, graph_version: graphVersion });
});

// Small, separate endpoint for the two P&L-only inputs (Other Income /
// Interest & Finance Costs) — entered directly on the P&L report itself,
// since this app has no dedicated ledger to source them from automatically.
router.put('/settings/pnl-overrides', requireRole('ADMIN', 'MANAGER'), (req, res) => {
  const { other_income_override, interest_expense_override } = req.body;
  db.prepare(`UPDATE company_settings SET other_income_override=?, interest_expense_override=? WHERE id = 1`)
    .run(Number(other_income_override) || 0, Number(interest_expense_override) || 0);
  audit(req, 'UPDATE', 'company_settings', 1, req.body);
  res.json(db.prepare(`SELECT other_income_override, interest_expense_override FROM company_settings WHERE id = 1`).get());
});

// ---------------------------------------------------------------------------
// Job Work & Pipeline Stages — the configurable stage list that Production,
// Outsourcing, and the Pipeline view all share, with a default ₹/unit rate
// used to pre-fill new outsourcing jobs for that stage.
// ---------------------------------------------------------------------------
router.get('/pipeline-stages', (req, res) => {
  res.json(db.prepare(`SELECT * FROM pipeline_stages WHERE active = 1 ORDER BY sort_order ASC, id ASC`).all());
});
router.post('/pipeline-stages', requireRole('ADMIN'), (req, res) => {
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),-1) v FROM pipeline_stages`).get().v;
  const info = db.prepare(`INSERT INTO pipeline_stages (name, sort_order, default_rate) VALUES (?,?,?)`)
    .run(req.body.name, maxOrder + 1, Number(req.body.default_rate) || 0);
  audit(req, 'CREATE', 'pipeline_stages', info.lastInsertRowid, req.body);
  res.json(db.prepare(`SELECT * FROM pipeline_stages WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/pipeline-stages/:id', requireRole('ADMIN'), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE pipeline_stages SET name=?, default_rate=? WHERE id=?`).run(b.name, Number(b.default_rate) || 0, req.params.id);
  audit(req, 'UPDATE', 'pipeline_stages', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM pipeline_stages WHERE id = ?`).get(req.params.id));
});
router.put('/pipeline-stages/:id/move', requireRole('ADMIN'), (req, res) => {
  // direction: 'up' | 'down' — swap sort_order with the adjacent stage
  const stages = db.prepare(`SELECT * FROM pipeline_stages WHERE active = 1 ORDER BY sort_order ASC, id ASC`).all();
  const idx = stages.findIndex((s) => s.id == req.params.id);
  const swapIdx = req.body.direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= stages.length) return res.status(400).json({ error: 'Cannot move further in that direction' });
  const a = stages[idx], bRow = stages[swapIdx];
  db.prepare(`UPDATE pipeline_stages SET sort_order = ? WHERE id = ?`).run(bRow.sort_order, a.id);
  db.prepare(`UPDATE pipeline_stages SET sort_order = ? WHERE id = ?`).run(a.sort_order, bRow.id);
  audit(req, 'UPDATE', 'pipeline_stages', req.params.id, { moved: req.body.direction });
  res.json({ ok: true });
});
router.delete('/pipeline-stages/:id', requireRole('ADMIN'), (req, res) => {
  const inUse = db.prepare(`SELECT name FROM pipeline_stages WHERE id = ?`).get(req.params.id);
  if (inUse) {
    const usedByJobs = db.prepare(`SELECT COUNT(*) n FROM outsourcing_jobs WHERE stage = ?`).get(inUse.name).n;
    const usedByMoves = db.prepare(`SELECT COUNT(*) n FROM production_stages WHERE stage = ?`).get(inUse.name).n;
    if (usedByJobs > 0 || usedByMoves > 0) return res.status(400).json({ error: 'This stage has existing jobwork or stage-movement history and cannot be deleted — deactivate is not available for stages already in use.' });
  }
  db.prepare(`DELETE FROM pipeline_stages WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'pipeline_stages', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Backup — download a timestamped, complete logical backup of the live
// PostgreSQL database (every table, as JSON). For large production databases
// you should ALSO schedule pg_dump (see POSTGRESQL_SETUP_v13.md).
// ---------------------------------------------------------------------------
router.get('/backup', requireRole('ADMIN'), (req, res) => {
  try {
    const dump = db.dumpAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `sabiha-erp-backup-${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify(dump));
    audit(req, 'BACKUP', 'database', null, { file: path.basename(dest) });
    res.download(dest, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Backup file could not be sent: ' + err.message });
    });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Restore — upload a previously downloaded backup (.json). A safety copy of
// the CURRENT data is written to the backups folder first, then everything is
// replaced inside ONE database transaction: either the whole restore succeeds
// or nothing changes. No server restart is needed.
// ---------------------------------------------------------------------------
router.post('/restore', requireRole('ADMIN'), (req, res) => {
  try {
    const raw = String(req.body.file_base64 || '');
    if (!raw) return res.status(400).json({ error: 'No file received. Please choose a .json backup file and try again.' });
    const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
    const buf = Buffer.from(base64 || '', 'base64');
    if (buf.length < 16) return res.status(400).json({ error: 'That file is too small to be a real SABIHA ERP backup.' });
    if (buf.subarray(0, 16).toString('utf8').startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'That is an old SQLite (.sqlite) backup. This version uses PostgreSQL — import old SQLite data with:  node migrate-sqlite-to-postgresql.js --yes  (see POSTGRESQL_SETUP_v13.md).' });
    }
    let dump;
    try { dump = JSON.parse(buf.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'That file does not look like a valid SABIHA ERP backup (.json). Make sure you selected the file downloaded from "Download Backup".' }); }
    if (!dump || dump.app !== 'SABIHA-ERP' || !dump.tables) return res.status(400).json({ error: 'That file is not a SABIHA ERP backup.' });
    // Safety copy of what is there right now, before anything is replaced
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safety = path.join(BACKUP_DIR, `pre-restore-${stamp}.json`);
    fs.writeFileSync(safety, JSON.stringify(db.dumpAll()));
    const counts = db.restoreAll(dump);
    audit(req, 'RESTORE', 'database', null, { size: buf.length, safety_copy: path.basename(safety) });
    res.json({ ok: true, restarting: false, message: `Backup restored. A safety copy of the previous data was saved as ${path.basename(safety)}. Reloading…`, rows: counts });
  } catch (e) {
    res.status(400).json({ error: 'Restore failed (no changes were made): ' + e.message });
  }
});

// Convert a PDFKit document into a Buffer so the same server-generated PDF
// can be downloaded in the browser or uploaded directly to WhatsApp Cloud API.
function pdfDocumentToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

async function buildInvoicePdfBuffer(id) {
  const inv = db.prepare(`
    SELECT si.*, c.name customer_name, c.address customer_address, c.phone customer_phone
    FROM sales_invoices si JOIN customers c ON c.id = si.customer_id WHERE si.id = ?`).get(id);
  if (!inv) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
  const items = db.prepare(`SELECT sit.*, p.name product_name, p.unit FROM sales_items sit JOIN products p ON p.id = sit.product_id WHERE sit.invoice_id = ?`).all(inv.id);
  const company = db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get();
  const doc = new PDFDocument({ margin: 40 });
  const done = pdfDocumentToBuffer(doc);
  const logoBuf = loadLogoBuffer(company.logo_data_url);
  const textLeft = logoBuf ? 100 : 40;
  if (logoBuf) { try { doc.image(logoBuf, 40, 40, { width: 50, height: 50 }); } catch (e) {} }
  doc.fontSize(18).text(company.company_name, textLeft, 40, { continued: false });
  doc.fontSize(9).fillColor('#666').text(company.address, textLeft);
  doc.text(`Phone: ${company.phone}  |  Email: ${company.email}  |  GSTIN: ${company.gst_no}`, textLeft);
  doc.y = Math.max(doc.y, 100); doc.x = 40; doc.moveDown();
  doc.fillColor('#000').fontSize(14).text(`INVOICE ${inv.invoice_no}`, { align: 'right' });
  doc.fontSize(9).fillColor('#666').text(`Date: ${inv.invoice_date}   Due: ${inv.due_date}`, { align: 'right' });
  doc.moveDown(); doc.fillColor('#000').fontSize(11).text('Bill To:');
  doc.fontSize(10).text(inv.customer_name); doc.fontSize(9).fillColor('#666').text(inv.customer_address || ''); doc.moveDown();
  const top = doc.y; doc.fontSize(9).fillColor('#000');
  doc.text('Product', 40, top, { width: 180 }); doc.text('Qty', 220, top, { width: 60 }); doc.text('Rate', 280, top, { width: 70 }); doc.text('Disc%', 350, top, { width: 50 }); doc.text('Amount', 410, top, { width: 100, align: 'right' });
  doc.moveTo(40, top + 15).lineTo(510, top + 15).stroke();
  let y = top + 22; items.forEach((it) => { doc.text(it.product_name, 40, y, { width: 180 }); doc.text(String(it.qty) + ' ' + it.unit, 220, y, { width: 60 }); doc.text(Number(it.rate).toFixed(2), 280, y, { width: 70 }); doc.text(String(it.discount_pct || 0), 350, y, { width: 50 }); doc.text(Number(it.amount).toFixed(2), 410, y, { width: 100, align: 'right' }); y += 18; });
  y += 10; doc.moveTo(300, y).lineTo(510, y).stroke(); y += 8;
  const RETH = require('./returns').helpers;
  const returnedOnThis = RETH.invoiceReturned(inv.id);
  const received = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE invoice_id = ?`).get(inv.id).v) - RETH.invoiceRefunded(inv.id);
  const originalSubTotal = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);
  const loyaltyDiscount = Math.max(0, Number(inv.loyalty_discount_amount || 0));
  const taxableSubTotal = Math.max(0, originalSubTotal - loyaltyDiscount);
  const thisInvoiceBalance = Math.max(inv.grand_total - returnedOnThis - received, 0);
  const prevBal = require('./returns').helpers.customerBalanceExcluding(inv.customer_id, inv.id);
  const prevBalance = prevBal;
  const totalDueAsOnDate = Math.max(thisInvoiceBalance + prevBalance, 0);
  doc.text('Sub Total', 300, y, { width: 110 }); doc.text(originalSubTotal.toFixed(2), 410, y, { width: 100, align: 'right' }); y += 16;
  if (loyaltyDiscount > 0) { doc.fillColor('#16804A').text('Incentive / Loyalty Amount', 300, y, { width: 110 }); doc.text('- Rs. ' + loyaltyDiscount.toFixed(2), 410, y, { width: 100, align: 'right' }); y += 16; }
  doc.fillColor('#000').text('Taxable Amount', 300, y, { width: 110 }); doc.text(taxableSubTotal.toFixed(2), 410, y, { width: 100, align: 'right' }); y += 16;
  doc.text(`GST (${inv.gst_pct}%)`, 300, y, { width: 110 }); doc.text(Number(inv.gst_amt).toFixed(2), 410, y, { width: 100, align: 'right' }); y += 16;
  doc.fontSize(12).text('Grand Total', 300, y, { width: 110 }); doc.text('Rs. ' + Number(inv.grand_total).toFixed(2), 410, y, { width: 100, align: 'right' }); y += 20;
  if (returnedOnThis > 0) { doc.fontSize(9).fillColor('#B3261E').text('Less: Goods Returned (Credit Note)', 300, y, { width: 110 }); doc.text('- Rs. ' + returnedOnThis.toFixed(2), 410, y, { width: 100, align: 'right' }); doc.fillColor('#000'); y += 16; }
  doc.fontSize(9).text('Balance Due (this invoice)', 300, y, { width: 110 }); doc.text('Rs. ' + thisInvoiceBalance.toFixed(2), 410, y, { width: 100, align: 'right' }); y += 14;
  doc.text('Previous Balance Due', 300, y, { width: 110 }); doc.text('Rs. ' + prevBalance.toFixed(2), 410, y, { width: 100, align: 'right' }); y += 14;
  doc.moveTo(300, y).lineTo(510, y).stroke(); y += 6;
  doc.fontSize(11).fillColor('#000').text('Total Balance Due (as on date)', 300, y, { width: 110 }); doc.text('Rs. ' + totalDueAsOnDate.toFixed(2), 410, y, { width: 100, align: 'right' });
  const payY = top + 22 + items.length * 18 + 10; await drawPaymentDetails(doc, company, 40, payY, totalDueAsOnDate);
  doc.moveDown(3); doc.fontSize(8).fillColor('#999').text('This is a system-generated invoice. Return & exchange policy applies as per company terms.', 40, doc.y, { width: 470 });
  doc.end();
  return { buffer: await done, invoice: inv };
}

// ---------------------------------------------------------------------------
// Invoice PDF
// ---------------------------------------------------------------------------
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const { buffer, invoice } = await buildInvoicePdfBuffer(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no}.pdf"`);
    res.end(buffer);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});


// ---------------------------------------------------------------------------
// Payment details for the on-screen (browser print) invoice view — the PDF
// route above draws these directly with pdfkit, but the browser-print path
// renders plain HTML, so it needs the bank details and a ready-made UPI QR
// image (as a data URL) instead. Same balance-as-on-date calculation as the
// PDF, so the QR always encodes the same amount either way.
router.get('/invoices/:id/payment-details', async (req, res) => {
  const inv = db.prepare(`SELECT * FROM sales_invoices WHERE id = ?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const company = db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get();
  const RETH = require('./returns').helpers;
  const received = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE invoice_id = ?`).get(inv.id).v) - RETH.invoiceRefunded(inv.id);
  const thisInvoiceBalance = Math.max(inv.grand_total - RETH.invoiceReturned(inv.id) - received, 0);
  const prevBalance = RETH.customerBalanceExcluding(inv.customer_id, inv.id);
  const totalDueAsOnDate = Math.max(thisInvoiceBalance + prevBalance, 0);

  const hasBank = !!(company.bank_name || company.bank_account_no);
  const hasUpi = !!(company.upi_id || company.upi_qr_data_url);
  // A dynamically-generated QR is preferred when there's a UPI ID to build
  // one from — it can pre-fill the exact amount due, which a static
  // uploaded image can't. But it must only be generated when upi_id is
  // actually present: generating one from an empty ID silently produces a
  // QR code that scans fine but encodes a broken payment link, which is
  // worse than just falling back to whatever image was uploaded.
  let qrDataUrl = null;
  if (company.upi_id) {
    try {
      const upiLink = `upi://pay?pa=${encodeURIComponent(company.upi_id)}&pn=${encodeURIComponent(company.company_name || 'Merchant')}&am=${totalDueAsOnDate > 0 ? totalDueAsOnDate.toFixed(2) : ''}&cu=INR`;
      qrDataUrl = await QRCode.toDataURL(upiLink, { margin: 1, width: 300 });
    } catch (e) { /* QR generation is a nice-to-have — never break the invoice over it */ }
  }
  res.json({
    hasBank, hasUpi,
    bank_name: company.bank_name || '', bank_account_no: company.bank_account_no || '', bank_ifsc: company.bank_ifsc || '', bank_branch: company.bank_branch || '',
    upi_id: company.upi_id || '', qrDataUrl: qrDataUrl || company.upi_qr_data_url || null,
  });
});

// Draws the Bank Transfer details and/or a UPI QR code (with the invoice's
// outstanding balance pre-filled into the UPI deep link) at the given
// position — used on both the invoice PDF and, in future, other PDFs that
// need to show how to pay. Silently draws nothing for anything not
// configured in Company Settings, so an invoice never shows a broken box.
async function drawPaymentDetails(doc, company, x, y, amount) {
  const hasBank = company.bank_name || company.bank_account_no;
  // BUG FIX: this used to require company.upi_id before drawing anything
  // UPI-related, and always generated a QR from that ID — it never once
  // considered company.upi_qr_data_url (an image uploaded directly in
  // Company Settings), so an uploaded QR never appeared on the PDF at all,
  // even alone with no UPI ID entered. Now it's "show UPI section if
  // either an ID or an uploaded image exists", and the QR image itself
  // prefers a freshly-generated one (which usefully encodes the current
  // amount due) but falls back to the uploaded image when there's no ID
  // to generate one from.
  const hasUpi = !!(company.upi_id || company.upi_qr_data_url);
  if (!hasBank && !hasUpi) return;
  let by = y;
  doc.fontSize(9).fillColor('#000').text('Payment Details', x, by, { width: 240 }); by += 14;
  doc.fontSize(8).fillColor('#444');
  if (hasBank) {
    if (company.bank_name) { doc.text(`Bank: ${company.bank_name}`, x, by, { width: 240 }); by += 12; }
    if (company.bank_account_no) { doc.text(`A/c No: ${company.bank_account_no}`, x, by, { width: 240 }); by += 12; }
    if (company.bank_ifsc) { doc.text(`IFSC: ${company.bank_ifsc}`, x, by, { width: 240 }); by += 12; }
    if (company.bank_branch) { doc.text(`Branch: ${company.bank_branch}`, x, by, { width: 240 }); by += 12; }
  }
  if (hasUpi) {
    by += 4;
    if (company.upi_id) { doc.text(`UPI: ${company.upi_id}`, x, by, { width: 240 }); by += 12; }
    try {
      let qrDataUrl = null;
      if (company.upi_id) {
        const upiLink = `upi://pay?pa=${encodeURIComponent(company.upi_id)}&pn=${encodeURIComponent(company.company_name || 'Merchant')}&am=${amount > 0 ? amount.toFixed(2) : ''}&cu=INR`;
        qrDataUrl = await QRCode.toDataURL(upiLink, { margin: 1, width: 300 });
      } else if (company.upi_qr_data_url) {
        qrDataUrl = company.upi_qr_data_url;
      }
      if (qrDataUrl) {
        const qrBuf = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        doc.image(qrBuf, x, by, { width: 80, height: 80 });
        doc.fontSize(7).fillColor('#888').text('Scan to pay via UPI', x, by + 82, { width: 90, align: 'center' });
      }
    } catch (e) { /* QR generation is a nice-to-have — never break the invoice over it */ }
  }
}

async function buildPayslipPdfBuffer(id) {
  const p = db.prepare(`
    SELECT pr.*, e.name employee_name, e.phone employee_phone, e.designation, e.department
    FROM payroll pr JOIN employees e ON e.id = pr.employee_id WHERE pr.id = ?`).get(id);
  if (!p) throw Object.assign(new Error('Payroll record not found'), { statusCode: 404 });
  const company = db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get();
  const doc = new PDFDocument({ margin: 40 });
  const done = pdfDocumentToBuffer(doc);
  const logoBuf = loadLogoBuffer(company.logo_data_url);
  const textLeft = logoBuf ? 100 : 40;
  if (logoBuf) { try { doc.image(logoBuf, 40, 40, { width: 50, height: 50 }); } catch (e) {} }
  doc.fontSize(18).text(company.company_name, textLeft, 40, { continued: false });
  doc.fontSize(9).fillColor('#666').text(company.address, textLeft); doc.text(`Phone: ${company.phone}  |  Email: ${company.email}`, textLeft);
  doc.y = Math.max(doc.y, 100); doc.x = 40; doc.moveDown();
  doc.fillColor('#000').fontSize(14).text(`PAYSLIP — ${p.pay_month}`, { align: 'right' }); doc.fontSize(9).fillColor('#666').text(`Payroll No: ${p.payroll_no}`, { align: 'right' }); doc.moveDown();
  doc.fillColor('#000').fontSize(11).text('Employee:'); doc.fontSize(10).text(p.employee_name); doc.fontSize(9).fillColor('#666').text(`${p.designation || ''}${p.designation && p.department ? ' — ' : ''}${p.department || ''}`); doc.moveDown();
  const top = doc.y; doc.fontSize(9).fillColor('#000'); doc.text('Component', 40, top, { width: 300 }); doc.text('Amount (₹)', 340, top, { width: 130, align: 'right' }); doc.moveTo(40, top + 14).lineTo(470, top + 14).stroke();
  let y = top + 20; const line = (label, val) => { doc.text(label, 40, y, { width: 300 }); doc.text(Number(val || 0).toFixed(2), 340, y, { width: 130, align: 'right' }); y += 16; };
  line('Basic', p.basic); line('HRA', p.hra); line('Conveyance', p.conveyance); line('Other Allowances', p.other_allow); line('PF Deduction', -p.pf); line('ESI Deduction', -p.esi); line('Advance Deduction', -p.advance_deduction); line('Other Deduction', -p.other_deduction);
  y += 6; doc.moveTo(300, y).lineTo(470, y).stroke(); y += 8;
  doc.fontSize(12).text('Net Salary', 300, y, { width: 110 }); doc.text('Rs. ' + Number(p.net).toFixed(2), 410, y, { width: 100, align: 'right' }); y += 20;
  doc.fontSize(9).text('Paid', 300, y, { width: 110 }); doc.text('Rs. ' + Number(p.paid_amount || 0).toFixed(2), 410, y, { width: 100, align: 'right' }); y += 14;
  doc.fontSize(11).fillColor('#000').text('Balance', 300, y, { width: 110 }); doc.text('Rs. ' + (Number(p.net) - Number(p.paid_amount || 0)).toFixed(2), 410, y, { width: 100, align: 'right' });
  doc.moveDown(3); doc.fontSize(8).fillColor('#999').text('This is a system-generated payslip.', 40, doc.y, { width: 470 });
  doc.end();
  return { buffer: await done, payslip: p };
}

// ---------------------------------------------------------------------------
// Payslip PDF — used for download and for the WhatsApp send option in Payroll
// ---------------------------------------------------------------------------
router.get('/payslips/:id/pdf', async (req, res) => {
  try {
    const { buffer, payslip } = await buildPayslipPdfBuffer(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${payslip.payroll_no}.pdf"`);
    res.end(buffer);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});


// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API — real PDF attachments
// ---------------------------------------------------------------------------
router.post('/whatsapp/send-invoice/:id', requireModule('customersSales'), async (req, res) => {
  try {
    const { buffer, invoice } = await buildInvoicePdfBuffer(req.params.id);
    if (!invoice.customer_phone) return res.status(400).json({ error: 'No phone number on file for this customer.' });
    const message = `Dear ${invoice.customer_name}, please find your invoice ${invoice.invoice_no} from ${db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get()?.company_name || 'SABIHA ERP'}. Invoice total: ₹${Number(invoice.grand_total).toFixed(2)}. Thank you for your business.`;
    const result = await sendWhatsAppPdf({ to: invoice.customer_phone, pdfBuffer: buffer, filename: `${invoice.invoice_no}.pdf`, caption: message });
    audit(req, 'SEND', 'whatsapp_invoice', invoice.id, { invoice_no: invoice.invoice_no, customer_id: invoice.customer_id, message_id: result?.messages?.[0]?.id || null });
    res.json({ ok: true, message: 'Invoice PDF sent successfully on WhatsApp.', message_id: result?.messages?.[0]?.id || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/whatsapp/send-payslip/:id', requireModule('employeesPayroll'), async (req, res) => {
  try {
    const { buffer, payslip } = await buildPayslipPdfBuffer(req.params.id);
    if (!payslip.employee_phone) return res.status(400).json({ error: 'No phone number on file for this employee.' });
    const message = `Dear ${payslip.employee_name}, please find your payslip for ${payslip.pay_month} from ${db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get()?.company_name || 'SABIHA ERP'}. Net salary: ₹${Number(payslip.net).toFixed(2)}.`;
    const result = await sendWhatsAppPdf({ to: payslip.employee_phone, pdfBuffer: buffer, filename: `${payslip.payroll_no}.pdf`, caption: message });
    audit(req, 'SEND', 'whatsapp_payslip', payslip.id, { payroll_no: payslip.payroll_no, employee_id: payslip.employee_id, message_id: result?.messages?.[0]?.id || null });
    res.json({ ok: true, message: 'Payslip PDF sent successfully on WhatsApp.', message_id: result?.messages?.[0]?.id || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Generic document PDF — used for vouchers, statements, and reminder
// attachments (Purchase/Payment/Receipt/Advance vouchers, customer
// statements, reorder requests, etc.) so anything printable can also be
// downloaded as a PDF to attach to a WhatsApp or email message.
// ---------------------------------------------------------------------------
function loadLogoBuffer(logoDataUrl) {
  if (!logoDataUrl) return null;
  try {
    if (logoDataUrl.startsWith('data:')) {
      const base64 = logoDataUrl.split(',')[1];
      return Buffer.from(base64, 'base64');
    }
    // relative static path, e.g. /assets/sabiha-logo.jpg
    const filePath = path.join(__dirname, '..', 'public', logoDataUrl.replace(/^\//, ''));
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  } catch (e) { /* fall through to no logo */ }
  return null;
}
router.post('/documents/pdf', (req, res) => {
  const { title, headers = [], rows = [], footNote = '' } = req.body;
  const company = db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(title || 'document').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  const logoBuf = loadLogoBuffer(company.logo_data_url);
  const textLeft = logoBuf ? 100 : 40;
  if (logoBuf) { try { doc.image(logoBuf, 40, 40, { width: 50, height: 50 }); } catch (e) {} }
  doc.fontSize(16).fillColor('#000').text(company.company_name || 'SABIHA ERP', textLeft, 40);
  doc.fontSize(9).fillColor('#666').text(company.address || '', textLeft);
  doc.y = Math.max(doc.y, 100); doc.x = 40;
  doc.moveDown();
  doc.fillColor('#000').fontSize(13).text(title || 'Document');
  doc.fontSize(8).fillColor('#999').text('Generated: ' + new Date().toLocaleString('en-IN'));
  doc.moveDown();

  const colWidth = 470 / Math.max(headers.length, 1);
  const top = doc.y;
  doc.fontSize(9).fillColor('#000');
  headers.forEach((h, i) => doc.text(String(h), 40 + i * colWidth, top, { width: colWidth }));
  doc.moveTo(40, top + 15).lineTo(510, top + 15).stroke();
  let y = top + 22;
  rows.forEach((row) => {
    row.forEach((cell, i) => doc.text(String(cell ?? ''), 40 + i * colWidth, y, { width: colWidth }));
    y += 18;
    if (y > 740) { doc.addPage(); y = 40; }
  });
  if (footNote) { doc.moveDown(2); doc.fontSize(9).fillColor('#666').text(footNote, 40, doc.y, { width: 470 }); }
  doc.fontSize(8).fillColor('#999').text((company.company_name || 'SABIHA ERP') + ' — generated electronically.', 40, 780, { width: 470 });
  doc.end();
});

module.exports = { router, publicRouter };
