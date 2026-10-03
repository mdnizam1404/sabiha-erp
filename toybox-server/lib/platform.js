// ============================================================================
// lib/platform.js — the PLATFORM OWNER layer (super admin)
//
// Sits above every company: the owner/developer of the package uses it to
//   * create companies directly or approve company account requests,
//   * give every company a plan (trial / basic / …) with expiry and limits,
//   * monitor every company centrally (users, activity, sales, storage, plan),
//   * back companies up, restore them, archive them,
//   * suspend / re-activate a company, reset a company admin's password,
//   * manage the platform team (owner / support), two-step sign-in, IP allow-list.
//
// Super-admin accounts live in the PLATFORM database (never inside a company
// database) and use a separate token scope ('platform') that the company API
// refuses — and company tokens are refused here.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mt = require('./multitenant');
const totp = require('./totp');
const { one, all, run, PlatformError, audit, encrypt, decrypt, sha, EMAIL_RE, getSetting, setSetting, SECRET } = require('./platformdb');
const sub = require('./subscription');
const mailer = require('./mailer');
const backup = require('./backup');
const extras = require('./extras');
const billing = require('./billing');

const { getCompanyByCode, getTenantConnection, provisionCompany } = mt;
const rootDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

let overviewCache = null; // 30-second cache of the central monitoring payload
const bust = () => { overviewCache = null; };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function checkPasswordStrength(pw, label = 'Password') {
  const s = String(pw || '');
  if (s.length < 8) throw new PlatformError(`${label} must be at least 8 characters.`);
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw new PlatformError(`${label} must contain at least one letter and one number.`);
  if (s.length > 200) throw new PlatformError(`${label} is too long.`);
}
function normCode(code) { return String(code || '').trim().toUpperCase(); }
function checkCode(code) {
  if (!/^[A-Z0-9][A-Z0-9_-]{2,30}$/.test(code)) throw new PlatformError('Company ID must be 3-31 characters: letters A-Z, numbers, _ or -');
}
function suggestCode(name) {
  const base = String(name || 'COMPANY').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'COMPANY';
  let code = base.length >= 3 ? base : (base + 'CO').slice(0, 10);
  let n = 1; let candidate = code;
  while (getCompanyByCode(candidate)) { n += 1; candidate = `${code}${n}`; }
  return candidate;
}

// ---------------------------------------------------------------------------
// Super-admin accounts
// ---------------------------------------------------------------------------
function bootstrapSuperAdmin() {
  if (one(`SELECT id FROM platform_admins LIMIT 1`)) return null;
  const username = String(process.env.SUPERADMIN_USERNAME || 'SUPERADMIN').trim();
  let password = String(process.env.SUPERADMIN_PASSWORD || '');
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12) + '7a';
  else checkPasswordStrength(password, 'SUPERADMIN_PASSWORD');
  run(`INSERT INTO platform_admins(username,password_hash,full_name,must_change_password,role) VALUES($1,$2,'Platform Owner',$3,'OWNER')`, [username, bcrypt.hashSync(password, 10), generated]);
  audit('system', 'SUPERADMIN_CREATED', username, { generated_password: generated });
  const info = { username, password: generated ? password : null, generated };
  if (generated) {
    try {
      const dir = path.join(rootDir, 'data'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SUPERADMIN_FIRST_PASSWORD.txt'), `SABIHA ERP — Platform Owner (Super Admin) first login\n\nUser ID : ${username}\nPassword: ${password}\n\nOpen  /platform.html  and sign in. You will be asked to change this password immediately.\nDelete this file afterwards.\n`);
    } catch (_) { /* console output below is enough */ }
    console.log('\n  ============================================================');
    console.log('   PLATFORM OWNER (SUPER ADMIN) ACCOUNT CREATED');
    console.log(`     Page     : /platform.html`);
    console.log(`     User ID  : ${username}`);
    console.log(`     Password : ${password}    (change it at first login)`);
    console.log('     Also saved in data/SUPERADMIN_FIRST_PASSWORD.txt');
    console.log('  ============================================================\n');
  }
  return info;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const normRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const usedCodes = new Map(); // adminId:code -> expiry — a 6-digit code works once

/** Accepts a 6-digit authenticator code OR one of the 8 one-time recovery codes. */
function checkSecondFactor(admin, code) {
  const raw = String(code || '').trim();
  const secret = decrypt(admin.totp_secret);
  if (/^\d{3}\s?\d{3}$/.test(raw) && secret) {
    const k = `${admin.id}:${raw.replace(/\s/g, '')}`;
    for (const [key, exp] of usedCodes) if (exp < Date.now()) usedCodes.delete(key);
    if (usedCodes.has(k)) return false;
    if (totp.verify(secret, raw)) { usedCodes.set(k, Date.now() + 120000); return true; }
    return false;
  }
  const n = normRecovery(raw);
  if (n.length === 8) {
    const hashes = Array.isArray(admin.recovery_codes) ? admin.recovery_codes : [];
    const h = sha(n);
    if (hashes.includes(h)) {
      run(`UPDATE platform_admins SET recovery_codes=$2 WHERE id=$1`, [admin.id, JSON.stringify(hashes.filter((x) => x !== h))]);
      return true;
    }
  }
  return false;
}

function superAdminLogin(username, password, ip, code) {
  const uname = String(username || '').trim();
  if (!uname || !password) throw new PlatformError('Enter your User ID and password.', 400);
  const key = uname.toLowerCase();
  const att = one(`SELECT attempts, locked_until FROM platform_login_attempts WHERE username=$1`, [key]);
  if (att && att.locked_until && new Date(att.locked_until) > new Date()) {
    throw new PlatformError(`Too many wrong attempts. This account is locked until ${new Date(att.locked_until).toLocaleTimeString()}.`, 429, { locked: true });
  }
  const admin = one(`SELECT * FROM platform_admins WHERE lower(username)=$1`, [key]);
  const pwOk = bcrypt.compareSync(String(password), admin ? admin.password_hash : DUMMY_HASH) && admin && admin.active;
  const fail = (what) => {
    const n = (att ? att.attempts : 0) + 1;
    const lock = n >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
    run(`INSERT INTO platform_login_attempts(username,attempts,locked_until,last_attempt_at) VALUES($1,$2,$3,now())
         ON CONFLICT (username) DO UPDATE SET attempts=$2, locked_until=$3, last_attempt_at=now()`, [key, lock ? 0 : n, lock]);
    audit(uname, 'LOGIN_FAILED', uname, { attempt: n, reason: what }, ip);
    throw new PlatformError(lock ? `Too many wrong attempts. Locked for ${LOCK_MINUTES} minutes.` : (what === 'code' ? `That verification code is not correct. ${MAX_ATTEMPTS - n} attempt(s) left before a temporary lock.` : `Wrong User ID or password. ${MAX_ATTEMPTS - n} attempt(s) left before a temporary lock.`), 401, { locked: !!lock });
  };
  if (!pwOk) fail('password');
  if (admin.totp_enabled) {
    if (!code) return { two_factor_required: true };  // password was right — now ask for the code
    if (!checkSecondFactor(admin, code)) fail('code');
  }
  run(`DELETE FROM platform_login_attempts WHERE username=$1`, [key]);
  run(`UPDATE platform_admins SET last_login_at=now() WHERE id=$1`, [admin.id]);
  audit(admin.username, 'LOGIN', admin.username, { two_step: !!admin.totp_enabled }, ip);
  const token = jwt.sign({ scope: 'platform', id: admin.id, username: admin.username, full_name: admin.full_name, jti: crypto.randomUUID() }, SECRET, { expiresIn: '8h' });
  return { token, admin: publicAdmin(admin) };
}
function publicAdmin(a) {
  return { id: a.id, username: a.username, full_name: a.full_name, email: a.email, role: a.role || 'OWNER', totp_enabled: !!a.totp_enabled, must_change_password: !!a.must_change_password };
}

function changeSuperAdminPassword(adminId, current, next, ip) {
  const admin = one(`SELECT * FROM platform_admins WHERE id=$1 AND active`, [adminId]);
  if (!admin) throw new PlatformError('Account not found.', 404);
  if (!bcrypt.compareSync(String(current || ''), admin.password_hash)) throw new PlatformError('Current password is incorrect.', 400);
  checkPasswordStrength(next, 'New password');
  if (String(next) === String(current)) throw new PlatformError('The new password must be different from the current one.');
  run(`UPDATE platform_admins SET password_hash=$2, must_change_password=false WHERE id=$1`, [adminId, bcrypt.hashSync(String(next), 10)]);
  audit(admin.username, 'PASSWORD_CHANGED', admin.username, {}, ip);
}

// ---------------------------------------------------------------------------
// IP allow-list for the console
// ---------------------------------------------------------------------------
function normIp(ip) { return String(ip || '').trim().replace(/^::ffff:/i, ''); }
function ipv4ToInt(s) { const p = s.split('.').map(Number); return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0 : null; }
function entryMatches(entry, ip) {
  if (entry.includes('/')) {
    const [base, bitsS] = entry.split('/'); const bits = Number(bitsS);
    const a = ipv4ToInt(base); const b = ipv4ToInt(ip);
    if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  return entry.toLowerCase() === ip.toLowerCase();
}
function validEntry(e) {
  if (e.includes('/')) { const [b, bits] = e.split('/'); return ipv4ToInt(b) !== null && Number(bits) >= 0 && Number(bits) <= 32 && /^\d+$/.test(bits); }
  return ipv4ToInt(e) !== null || /^[0-9a-fA-F:]+$/.test(e) && e.includes(':');
}
const allowList = () => (getSetting('security', {}).ip_allowlist || []);
function ipAllowed(ip, list = allowList()) {
  if (process.env.PLATFORM_IP_ALLOWLIST_DISABLE === '1') return true;
  if (!list.length) return true;
  const n = normIp(ip);
  return list.some((e) => entryMatches(e, n));
}
function ipGuard(req, res, next) {
  if (ipAllowed(req.ip)) return next();
  audit('unknown', 'CONSOLE_IP_BLOCKED', normIp(req.ip), {}, req.ip);
  return res.status(403).json({ error: 'The platform console is not available from this network address.', ip_blocked: true });
}
function getSecurity(reqIp) { return { ip_allowlist: allowList(), your_ip: normIp(reqIp), override_active: process.env.PLATFORM_IP_ALLOWLIST_DISABLE === '1' }; }
function saveSecurity(input, reqIp, actor, ip) {
  const list = [...new Set((Array.isArray(input.ip_allowlist) ? input.ip_allowlist : String(input.ip_allowlist || '').split(/[\s,;]+/)).map((s) => normIp(s)).filter(Boolean))];
  for (const e of list) if (!validEntry(e)) throw new PlatformError(`"${e}" is not a valid IP address or IPv4 range (example: 203.0.113.5 or 203.0.113.0/24).`);
  if (list.length > 50) throw new PlatformError('At most 50 entries.');
  if (list.length && !ipAllowed(reqIp, list)) throw new PlatformError(`Your current address (${normIp(reqIp)}) is not in this list. Add it first, otherwise you would lock yourself out.`, 409);
  setSetting('security', { ...getSetting('security', {}), ip_allowlist: list });
  audit(actor, 'IP_ALLOWLIST_SAVED', null, { entries: list.length }, ip);
  return getSecurity(reqIp);
}

// ---------------------------------------------------------------------------
// Express middleware: platform JWT (scope 'platform') OR the automation key
// ---------------------------------------------------------------------------
function requirePlatformAuth(req, res, next) {
  const key = String(process.env.PLATFORM_ADMIN_KEY || '').trim();
  const supplied = String(req.headers['x-platform-key'] || '').trim();
  if (key && supplied) {
    const a = Buffer.from(key); const b = Buffer.from(supplied);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { req.platformAdmin = { username: 'api-key', viaKey: true, role: 'OWNER' }; return next(); }
    return res.status(401).json({ error: 'Platform administration authentication required.' });
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Platform administration authentication required.' });
  let decoded;
  try { decoded = jwt.verify(h.slice(7), SECRET); } catch (_) { return res.status(401).json({ error: 'Session expired — please sign in again.' }); }
  if (decoded.scope !== 'platform') return res.status(401).json({ error: 'Platform administration authentication required.' });
  const admin = one(`SELECT * FROM platform_admins WHERE id=$1`, [decoded.id]);
  if (!admin || !admin.active) return res.status(401).json({ error: 'This platform account is no longer active.' });
  req.platformAdmin = { id: admin.id, username: admin.username, full_name: admin.full_name, role: admin.role || 'OWNER', totp_enabled: !!admin.totp_enabled, must_change_password: !!admin.must_change_password };
  const allowedWhileForced = /^\/(me|me\/change-password)$/;
  if (admin.must_change_password && !allowedWhileForced.test(req.path)) return res.status(403).json({ error: 'You must change your password before continuing.', must_change_password: true });
  next();
}
/** SUPPORT accounts can look but not change (except their own password / two-step). */
function requireOwnerForChanges(req, res, next) {
  if (req.platformAdmin.role !== 'SUPPORT') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (/^\/me\/(change-password|2fa\/)/.test(req.path)) return next();
  return res.status(403).json({ error: 'Your account has view-only access. Ask the platform owner to make this change.' });
}
function requireOwner(req, res, next) {
  if (req.platformAdmin.role === 'SUPPORT') return res.status(403).json({ error: 'Only a platform owner can see this.' });
  next();
}

// ---------------------------------------------------------------------------
// Two-step verification and team accounts
// ---------------------------------------------------------------------------
function twoFactorSetup(adminId) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1 AND active`, [adminId]);
  if (!a) throw new PlatformError('Account not found.', 404);
  if (a.totp_enabled) throw new PlatformError('Two-step verification is already on. Turn it off first to set it up again.', 409);
  const secret = totp.generateSecret();
  run(`UPDATE platform_admins SET totp_secret=$2, totp_enabled=false WHERE id=$1`, [adminId, encrypt(secret)]);
  return { secret, otpauth: totp.otpauthUri(secret, a.username) };
}
function twoFactorEnable(adminId, code, ip) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1 AND active`, [adminId]);
  const secret = a && decrypt(a.totp_secret);
  if (!secret) throw new PlatformError('Start the setup first.', 409);
  if (a.totp_enabled) throw new PlatformError('Two-step verification is already on.', 409);
  if (!totp.verify(secret, code)) throw new PlatformError('That code is not correct. Check the time on your phone and try again.');
  const plain = Array.from({ length: 8 }, () => { const r = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8); return `${r.slice(0, 4)}-${r.slice(4)}`; });
  run(`UPDATE platform_admins SET totp_enabled=true, recovery_codes=$2 WHERE id=$1`, [adminId, JSON.stringify(plain.map((c) => sha(normRecovery(c))))]);
  audit(a.username, 'TWO_STEP_ENABLED', a.username, {}, ip);
  return { recovery_codes: plain };
}
function twoFactorDisable(adminId, password, code, ip) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1 AND active`, [adminId]);
  if (!a) throw new PlatformError('Account not found.', 404);
  if (!a.totp_enabled) throw new PlatformError('Two-step verification is not on.', 409);
  if (!bcrypt.compareSync(String(password || ''), a.password_hash)) throw new PlatformError('Password is incorrect.', 400);
  if (!checkSecondFactor(a, String(code || ''))) throw new PlatformError('That verification code is not correct.', 400);
  run(`UPDATE platform_admins SET totp_enabled=false, totp_secret=NULL, recovery_codes='[]'::jsonb WHERE id=$1`, [adminId]);
  audit(a.username, 'TWO_STEP_DISABLED', a.username, {}, ip);
}
/** An owner clears another member's two-step sign-in (lost phone). */
function twoFactorReset(id, actor, ip) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1`, [Number(id) || 0]);
  if (!a) throw new PlatformError('Team member not found.', 404);
  run(`UPDATE platform_admins SET totp_enabled=false, totp_secret=NULL, recovery_codes='[]'::jsonb WHERE id=$1`, [a.id]);
  audit(actor, 'TWO_STEP_RESET', a.username, {}, ip);
}

const listTeam = () => all(`SELECT id, username, full_name, email, role, active, totp_enabled, must_change_password, created_at, last_login_at FROM platform_admins ORDER BY id`);
function createTeamMember(input, actor, ip) {
  const username = String(input.username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new PlatformError('User ID must be 3-40 characters: letters, numbers, . _ -');
  const role = String(input.role || 'SUPPORT').toUpperCase();
  if (!['OWNER', 'SUPPORT'].includes(role)) throw new PlatformError('Role must be OWNER or SUPPORT.');
  const email = String(input.email || '').trim() || null;
  if (email && !EMAIL_RE.test(email)) throw new PlatformError('Enter a valid email address.');
  checkPasswordStrength(input.password, 'Temporary password');
  if (one(`SELECT 1 FROM platform_admins WHERE lower(username)=lower($1)`, [username])) throw new PlatformError('That User ID is already in use.', 409);
  const r = one(`INSERT INTO platform_admins(username,password_hash,full_name,email,role,must_change_password) VALUES($1,$2,$3,$4,$5,true) RETURNING id`, [username, bcrypt.hashSync(String(input.password), 10), String(input.full_name || username).trim().slice(0, 80), email, role]);
  audit(actor, 'TEAM_MEMBER_CREATED', username, { role }, ip);
  return r;
}
function updateTeamMember(id, input, actorId, actor, ip) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1`, [Number(id) || 0]);
  if (!a) throw new PlatformError('Team member not found.', 404);
  const role = input.role === undefined ? a.role : String(input.role).toUpperCase();
  if (!['OWNER', 'SUPPORT'].includes(role)) throw new PlatformError('Role must be OWNER or SUPPORT.');
  const active = input.active === undefined ? a.active : !!input.active;
  if (a.id === actorId && (!active || role !== 'OWNER')) throw new PlatformError('You cannot deactivate or demote your own account.', 409);
  if ((a.role === 'OWNER' && a.active) && (!active || role !== 'OWNER') && Number(one(`SELECT COUNT(*) AS n FROM platform_admins WHERE role='OWNER' AND active`).n) <= 1) throw new PlatformError('There must always be at least one active owner.', 409);
  run(`UPDATE platform_admins SET role=$2, active=$3 WHERE id=$1`, [a.id, role, active]);
  if (!active) run(`DELETE FROM platform_login_attempts WHERE username=$1`, [a.username.toLowerCase()]);
  audit(actor, 'TEAM_MEMBER_UPDATED', a.username, { role, active }, ip);
}
function resetTeamPassword(id, newPassword, actor, ip) {
  const a = one(`SELECT * FROM platform_admins WHERE id=$1`, [Number(id) || 0]);
  if (!a) throw new PlatformError('Team member not found.', 404);
  checkPasswordStrength(newPassword, 'New password');
  run(`UPDATE platform_admins SET password_hash=$2, must_change_password=true, active=true WHERE id=$1`, [a.id, bcrypt.hashSync(String(newPassword), 10)]);
  run(`DELETE FROM platform_login_attempts WHERE username=$1`, [a.username.toLowerCase()]);
  audit(actor, 'TEAM_PASSWORD_RESET', a.username, {}, ip);
}

// ---------------------------------------------------------------------------
// Company account requests (submitted from the public login page)
// ---------------------------------------------------------------------------
function createCompanyRequest(input, ip) {
  const company_name = String(input.company_name || '').trim();
  const contact_name = String(input.contact_name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim() || null;
  const city = String(input.city || '').trim() || null;
  const notes = String(input.notes || '').trim().slice(0, 1000) || null;
  const admin_username = String(input.admin_username || '').trim();
  const requested_code = normCode(input.requested_code) || null;
  if (company_name.length < 2 || company_name.length > 120) throw new PlatformError('Enter your company name (2-120 characters).');
  if (contact_name.length < 2 || contact_name.length > 80) throw new PlatformError('Enter the contact person\'s name.');
  if (!EMAIL_RE.test(email)) throw new PlatformError('Enter a valid email address.');
  if (phone && !/^[0-9+()\-\s]{6,20}$/.test(phone)) throw new PlatformError('Enter a valid phone number.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(admin_username)) throw new PlatformError('Admin User ID must be 3-40 characters: letters, numbers, . _ -');
  checkPasswordStrength(input.admin_password, 'Password');
  if (requested_code) {
    checkCode(requested_code);
    if (getCompanyByCode(requested_code)) throw new PlatformError('That Company ID is already taken. Please choose another.');
    if (one(`SELECT 1 FROM company_requests WHERE status='PENDING' AND requested_code=$1`, [requested_code])) throw new PlatformError('Another request for that Company ID is already waiting for approval. Please choose another.');
  }
  if (one(`SELECT 1 FROM company_requests WHERE status='PENDING' AND lower(email)=$1`, [email])) throw new PlatformError('A request from this email address is already waiting for approval.');
  const reference = 'REQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  run(`INSERT INTO company_requests(reference,company_name,requested_code,contact_name,email,phone,city,notes,admin_username,admin_password_hash,request_ip)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [reference, company_name, requested_code, contact_name, email, phone, city, notes, admin_username, bcrypt.hashSync(String(input.admin_password), 10), ip || null]);
  audit(email, 'COMPANY_REQUEST_CREATED', reference, { company_name, requested_code }, ip);
  mailer.sendTemplate('requestReceived', email, { company_name, reference });
  return { reference };
}

function requestStatus(reference) {
  const r = one(`SELECT reference, company_name, status, assigned_code, review_note, created_at, reviewed_at FROM company_requests WHERE reference=$1`, [String(reference || '').trim().toUpperCase()]);
  if (!r) throw new PlatformError('No request found with that reference number.', 404);
  return { ...r, assigned_code: r.status === 'APPROVED' ? r.assigned_code : null };
}

function listRequests(status) {
  const where = status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? `WHERE status='${status}'` : '';
  return all(`SELECT id, reference, company_name, requested_code, contact_name, email, phone, city, notes, admin_username, status, review_note, assigned_code, created_at, reviewed_at, reviewed_by
              FROM company_requests ${where} ORDER BY (status='PENDING') DESC, created_at DESC LIMIT 500`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function approveRequest(id, { company_code, note, plan_code, days } = {}, actor, ip, origin) {
  if (!UUID_RE.test(String(id))) throw new PlatformError('Request not found.', 404);
  const r = one(`SELECT * FROM company_requests WHERE id=$1`, [id]);
  if (!r) throw new PlatformError('Request not found.', 404);
  if (r.status !== 'PENDING') throw new PlatformError(`This request was already ${r.status.toLowerCase()}.`, 409);
  if (plan_code && !sub.getPlan(plan_code)) throw new PlatformError('Choose a valid plan.');
  const code = normCode(company_code) || r.requested_code || suggestCode(r.company_name);
  checkCode(code);
  const existing = getCompanyByCode(code);
  if (existing && existing.status === 'FAILED') run(`DELETE FROM companies WHERE id=$1`, [existing.id]); // retry of an earlier failed setup
  else if (existing) throw new PlatformError(`Company ID ${code} is already in use. Choose a different Company ID.`, 409);
  const company = provisionCompany({ companyCode: code, companyName: r.company_name, adminUsername: r.admin_username, adminPasswordHash: r.admin_password_hash });
  // every approved company starts on a plan (the trial plan unless the owner picked another)
  const subscription = sub.startSubscription(company, { plan_code, days, contact_email: r.email, actor });
  const plan = subscription ? sub.getPlan(subscription.plan_code) : null;
  run(`UPDATE company_requests SET status='APPROVED', assigned_code=$2, review_note=$3, reviewed_at=now(), reviewed_by=$4 WHERE id=$1`, [id, company.company_code, String(note || '').slice(0, 500) || null, actor]);
  audit(actor, 'COMPANY_REQUEST_APPROVED', r.reference, { company_code: company.company_code, plan: plan && plan.code }, ip);
  bust();
  mailer.sendTemplate('requestApproved', r.email, {
    company_name: company.company_name, company_code: company.company_code, admin_username: r.admin_username,
    trial_text: subscription ? `Your ${plan.name} ${plan.is_trial ? 'trial' : 'plan'} runs until ${sub.fmtD(subscription.expires_on)}.` : '',
    url: mailer.baseUrl(origin) });
  return { company_code: company.company_code, company_name: company.company_name, plan: plan ? plan.name : null, expires_on: subscription ? subscription.expires_on : null };
}

function rejectRequest(id, note, actor, ip) {
  if (!UUID_RE.test(String(id))) throw new PlatformError('Request not found.', 404);
  const r = one(`SELECT * FROM company_requests WHERE id=$1`, [id]);
  if (!r) throw new PlatformError('Request not found.', 404);
  if (r.status !== 'PENDING') throw new PlatformError(`This request was already ${r.status.toLowerCase()}.`, 409);
  run(`UPDATE company_requests SET status='REJECTED', review_note=$2, reviewed_at=now(), reviewed_by=$3 WHERE id=$1`, [id, String(note || '').slice(0, 500) || null, actor]);
  audit(actor, 'COMPANY_REQUEST_REJECTED', r.reference, { note }, ip);
  mailer.sendTemplate('requestRejected', r.email, { company_name: r.company_name, note: String(note || '') });
}

// ---------------------------------------------------------------------------
// Direct company management
// ---------------------------------------------------------------------------
function createCompanyDirect(input, actor, ip) {
  const code = normCode(input.company_code || input.companyCode);
  const name = String(input.company_name || input.companyName || '').trim();
  const adminUsername = String(input.admin_username || input.adminUsername || 'ADMIN').trim();
  const adminPassword = String(input.admin_password || input.adminPassword || '');
  checkCode(code);
  if (name.length < 2) throw new PlatformError('Enter the company name.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(adminUsername)) throw new PlatformError('Admin User ID must be 3-40 characters: letters, numbers, . _ -');
  checkPasswordStrength(adminPassword, 'Admin password');
  const contact = String(input.contact_email || '').trim();
  if (contact && !EMAIL_RE.test(contact)) throw new PlatformError('Enter a valid contact email.');
  const planCode = String(input.plan_code || '').toUpperCase();
  if (planCode && !sub.getPlan(planCode)) throw new PlatformError('Choose a valid plan.');
  const existing = getCompanyByCode(code);
  if (existing && existing.status === 'FAILED') run(`DELETE FROM companies WHERE id=$1`, [existing.id]);
  else if (existing) throw new PlatformError('That Company ID already exists.', 409);
  // the owner knows this password, so the company admin must replace it at first sign-in
  const c = provisionCompany({ companyCode: code, companyName: name, adminUsername, adminPassword, branchName: input.branch_name || input.branchName || 'Head Office', forcePasswordChange: true });
  // a plan is optional for API callers (no plan = unlimited "legacy" company); the console always sends one
  if (planCode) sub.startSubscription(c, { plan_code: planCode, days: input.days, months: input.months, no_expiry: !!input.no_expiry, contact_email: contact || null, actor });
  audit(actor, 'COMPANY_CREATED', c.company_code, { company_name: c.company_name, plan: planCode || null }, ip);
  bust();
  return c;
}

function setStatus(code, status, actor, ip) {
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw new PlatformError('Status must be ACTIVE or SUSPENDED.');
  const c = getCompanyByCode(code);
  if (!c) throw new PlatformError('Company not found.', 404);
  if (!['ACTIVE', 'SUSPENDED'].includes(c.status)) throw new PlatformError(`A company that is ${c.status} cannot be changed here.`, 409);
  run(`UPDATE companies SET status=$2, suspended_at = CASE WHEN $2='SUSPENDED' THEN now() ELSE NULL END WHERE company_code=$1`, [c.company_code, status]);
  audit(actor, status === 'SUSPENDED' ? 'COMPANY_SUSPENDED' : 'COMPANY_ACTIVATED', c.company_code, {}, ip);
  bust();
  return getCompanyByCode(c.company_code);
}

function resetCompanyAdminPassword(code, { username, new_password }, actor, ip) {
  const c = getCompanyByCode(code);
  if (!c || c.status !== 'ACTIVE') throw new PlatformError('Company not found or not active.', 404);
  checkPasswordStrength(new_password, 'New password');
  const p = getTenantConnection(c);
  const user = username
    ? p.query(`SELECT id, username FROM users WHERE lower(username)=lower($1) AND role='ADMIN'`, [String(username).trim()], false).rows[0]
    : p.query(`SELECT id, username FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1`, [], false).rows[0];
  if (!user) throw new PlatformError('No company admin account with that User ID was found.', 404);
  // the owner knows this password, so the admin must choose their own at next sign-in
  p.query(`UPDATE users SET password_hash=$2, status='Approved', active=1, reset_requested=0, must_change_password=1 WHERE id=$1`, [user.id, bcrypt.hashSync(String(new_password), 10)], false);
  p.query(`DELETE FROM login_attempts WHERE lower(username)=lower($1)`, [user.username], false);
  audit(actor, 'COMPANY_ADMIN_PASSWORD_RESET', c.company_code, { admin_username: user.username }, ip);
  return { admin_username: user.username };
}

/** Archive = take a full copy, then retire the company. Nothing is deleted; it can be brought back. */
function archiveCompany(code, actor, ip) {
  const c = getCompanyByCode(code);
  if (!c) throw new PlatformError('Company not found.', 404);
  if (!['ACTIVE', 'SUSPENDED'].includes(c.status)) throw new PlatformError(`A company that is ${c.status} cannot be archived.`, 409);
  const b = backup.backupCompany({ ...c, status: 'ACTIVE' }, { kind: 'ARCHIVE', actor, note: 'Automatic full copy when the company was archived' });
  run(`UPDATE companies SET status='ARCHIVED', suspended_at=now() WHERE company_code=$1`, [c.company_code]);
  sub.invalidate(c.id); bust();
  audit(actor, 'COMPANY_ARCHIVED', c.company_code, { backup: b.file_name }, ip);
  return { backup: b };
}
function unarchiveCompany(code, actor, ip) {
  const c = getCompanyByCode(code);
  if (!c || c.status !== 'ARCHIVED') throw new PlatformError('That company is not archived.', 404);
  run(`UPDATE companies SET status='ACTIVE', suspended_at=NULL WHERE company_code=$1`, [c.company_code]);
  bust();
  audit(actor, 'COMPANY_UNARCHIVED', c.company_code, {}, ip);
}
/** Create a NEW company whose data is a copy of a backup (users, settings, everything). */
function restoreBackupAsNew(backupId, { company_code, company_name }, actor, ip) {
  const { row, dump } = backup.readDump(backupId);
  const code = normCode(company_code);
  checkCode(code);
  const name = String(company_name || '').trim();
  if (name.length < 2) throw new PlatformError('Enter the new company name.');
  if (getCompanyByCode(code)) throw new PlatformError('That Company ID already exists.', 409);
  const c = provisionCompany({ companyCode: code, companyName: name, adminUsername: 'ADMIN', adminPassword: crypto.randomBytes(9).toString('hex') + 'a1' });
  mt.withCompany(c, () => require('../db').db.restoreAll(dump));
  getTenantConnection(c).query(`UPDATE company_settings SET company_name=$1 WHERE id=1`, [name], false);
  const src = sub.getSubscription(row.company_id);
  if (src) sub.setSubscription(c, { plan_code: src.plan_code, expires_on: src.expires_on, grace_days: src.grace_days, limit_action: src.limit_action, contact_email: src.contact_email, overrides: src.overrides }, actor, ip);
  audit(actor, 'COMPANY_RESTORED_AS_NEW', c.company_code, { from_backup: row.file_name, source: row.company_code }, ip);
  bust();
  return c;
}

// ---------------------------------------------------------------------------
// Central monitoring
// ---------------------------------------------------------------------------
const nowUtcText = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);

function tenantStats(company) {
  const p = getTenantConnection(company);
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  return p.query(`SELECT
      (SELECT COUNT(*) FROM users) AS users_total,
      (SELECT COUNT(*) FROM users WHERE status='Approved' AND active=1) AS users_active,
      (SELECT COUNT(*) FROM users WHERE status='Pending') AS users_pending,
      (SELECT MAX(last_login_at) FROM users) AS last_login,
      (SELECT COUNT(*) FROM users WHERE last_login_at >= $1) AS logins_7d,
      (SELECT COUNT(*) FROM employees) AS employees,
      (SELECT COUNT(*) FROM customers) AS customers,
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM sales_invoices) AS invoices,
      (SELECT COALESCE(SUM(grand_total),0) FROM sales_net WHERE invoice_date >= $2) AS sales_this_month,
      (SELECT COALESCE(SUM(grand_total),0) FROM sales_net) AS sales_total,
      (SELECT MAX(created_at) FROM audit_logs) AS last_activity`, [nowUtcText(-7), monthStart], false).rows[0];
}

function overview({ refresh = false } = {}) {
  if (!refresh && overviewCache && Date.now() - overviewCache.at < 30000) return overviewCache.data;
  const sizes = Object.fromEntries(all(`SELECT datname, pg_database_size(datname) AS bytes FROM pg_database`).map((r) => [r.datname, Number(r.bytes)]));
  let mrr = 0;
  const companies = all(`SELECT id, company_code, company_name, database_name, status, created_at, activated_at, suspended_at, provisioning_error FROM companies ORDER BY company_name`).map((c) => {
    const row = { ...c, db_size_bytes: sizes[c.database_name] ?? null, stats: null, error: null, plan: null };
    const snap = sub.snapshot(c, { withUsage: false });
    row.plan = { code: snap.plan_code, name: snap.plan_name, state: snap.state, days_left: snap.days_left, expires_on: snap.expires_on, is_trial: snap.is_trial, legacy: snap.legacy };
    if (c.status === 'ACTIVE') {
      try { row.stats = tenantStats(c); } catch (e) { row.error = e.message; }
      const p = sub.getPlan(snap.plan_code);
      if (p && !p.is_trial && ['ACTIVE', 'EXPIRING', 'GRACE'].includes(snap.state)) mrr += p.price_monthly;
    }
    return row;
  });
  const sum = (f) => companies.reduce((t, c) => t + (c.stats ? Number(c.stats[f] || 0) : 0), 0);
  const req = one(`SELECT COUNT(*) FILTER (WHERE status='PENDING') AS pending, COUNT(*) AS total FROM company_requests`);
  const grow = Object.fromEntries(all(`SELECT to_char(created_at, 'YYYY-MM') AS m, COUNT(*) AS n FROM companies GROUP BY 1`).map((r) => [r.m, Number(r.n)]));
  const growth = []; let mo = sub.todayStr().slice(0, 7) + '-01';
  for (let i = 0; i < 12; i++) { growth.unshift({ month: mo.slice(0, 7), companies: grow[mo.slice(0, 7)] || 0 }); mo = sub.addMonths(mo, -1); }
  const active = companies.filter((c) => c.status === 'ACTIVE');
  const data = {
    generated_at: new Date().toISOString(),
    totals: {
      companies: companies.length, active: active.length,
      suspended: companies.filter((c) => c.status === 'SUSPENDED').length,
      archived: companies.filter((c) => c.status === 'ARCHIVED').length,
      failed: companies.filter((c) => c.status === 'FAILED').length,
      trials: active.filter((c) => c.plan.is_trial).length,
      expiring: active.filter((c) => ['EXPIRING', 'GRACE'].includes(c.plan.state)).length,
      read_only: active.filter((c) => c.plan.state === 'READONLY').length,
      pending_company_requests: Number(req.pending || 0),
      pending_plan_requests: require('./planRequests').pendingCount(),
      users: sum('users_total'), users_pending_approval: sum('users_pending'),
      invoices: sum('invoices'), sales_this_month: sum('sales_this_month'),
      db_size_bytes: companies.reduce((t, c) => t + (c.db_size_bytes || 0), 0),
      backup_size_bytes: backup.diskUsage(),
      monthly_recurring_revenue: mrr,
    },
    billing: billing.summary(), growth, revenue: billing.revenueSeries(12), companies,
  };
  overviewCache = { at: Date.now(), data };
  return data;
}

function companyDetail(code, viewer) {
  const c = getCompanyByCode(code);
  if (!c) throw new PlatformError('Company not found.', 404);
  const detail = {
    company: { id: c.id, company_code: c.company_code, company_name: c.company_name, database_name: c.database_name, status: c.status, created_at: c.created_at, activated_at: c.activated_at, suspended_at: c.suspended_at },
    subscription: null, subscription_row: null, branding: extras.getBranding(c.id), backups: backup.listBackups(c.company_code),
    logins: extras.loginHistory(c.company_code, 50), billing: billing.list({ company_code: c.company_code }).slice(0, 20),
    stats: null, users: [], recent_activity: [], error: null,
  };
  const sr = sub.getSubscription(c.id);
  detail.subscription_row = sr ? { plan_code: sr.plan_code, starts_on: sr.starts_on, expires_on: sr.expires_on, grace_days: sr.grace_days, limit_action: sr.limit_action, contact_email: sr.contact_email, notes: sr.notes, overrides: sr.overrides || {} } : null;
  if (viewer) audit(viewer, 'COMPANY_VIEWED', c.company_code, {});   // support access always leaves a trail
  if (c.status !== 'ACTIVE') { detail.subscription = sub.snapshot(c, { withUsage: false }); return detail; }
  try {
    const p = getTenantConnection(c);
    detail.subscription = sub.snapshot(c);
    detail.stats = tenantStats(c);
    detail.users = p.query(`SELECT id, username, full_name, role, status, active, email, phone, created_at, last_login_at FROM users ORDER BY id`, [], false).rows;
    detail.recent_activity = p.query(`SELECT username, action, entity, left(COALESCE(details,''),300) AS details, created_at FROM audit_logs ORDER BY id DESC LIMIT 100`, [], false).rows;
  } catch (e) { detail.error = e.message; }
  return detail;
}

function platformAudit(limit = 200) {
  return all(`SELECT id, actor, action, target, details, ip, created_at FROM platform_audit_logs ORDER BY id DESC LIMIT $1`, [Math.min(Number(limit) || 200, 1000)]);
}

// Public list used by the login page's company selector
function publicCompanies() {
  if (String(process.env.PUBLIC_COMPANY_LIST || 'true').toLowerCase() === 'false') return [];
  return all(`SELECT company_code, company_name FROM companies WHERE status='ACTIVE' ORDER BY company_name`);
}
function publicCompany(code) {
  return extras.publicBranding(code);   // { company_code, company_name, display_name, tagline, primary_color, logo_data_url }
}

const bootstrapInfo = bootstrapSuperAdmin();

module.exports = {
  PlatformError, bootstrapInfo, superAdminLogin, changeSuperAdminPassword, requirePlatformAuth, requireOwnerForChanges, requireOwner, ipGuard, ipAllowed, getSecurity, saveSecurity, publicAdmin,
  twoFactorSetup, twoFactorEnable, twoFactorDisable, twoFactorReset, listTeam, createTeamMember, updateTeamMember, resetTeamPassword,
  createCompanyRequest, requestStatus, listRequests, approveRequest, rejectRequest,
  createCompanyDirect, setStatus, archiveCompany, unarchiveCompany, restoreBackupAsNew, resetCompanyAdminPassword, overview, companyDetail, platformAudit,
  publicCompanies, publicCompany, checkPasswordStrength, audit, one, run, all, bust,
};
