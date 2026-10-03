// ============================================================================
// lib/mailer.js — platform-level email (one SMTP setting for the whole platform)
//
// Used for: company request received / approved / rejected, "your account is
// approved" for company users, and plan-expiry reminders. Each company can
// still keep its own SMTP for its own invoices (Settings → Email); this one is
// the platform owner's mail identity.
//
// Sending never blocks a request and never throws: failures are written to the
// email_log table (shown in the console) and the feature carries on.
// ============================================================================
const nodemailer = require('nodemailer');
const { run, all, getSetting, setSetting, encrypt, decrypt, PlatformError, EMAIL_RE, audit } = require('./platformdb');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getConfig() {
  const c = getSetting('mail', {});
  return { enabled: !!c.enabled, host: c.host || '', port: Number(c.port) || 587, secure: !!c.secure, user: c.user || '', pass: decrypt(c.pass_enc) || '', from: c.from || '', app_url: c.app_url || '', brand: c.brand || 'SABIHA ERP' };
}
/** Safe view for the console: the password is never sent back. */
function publicConfig() {
  const c = getConfig();
  return { enabled: c.enabled, host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from, app_url: c.app_url, brand: c.brand, password_set: !!c.pass };
}
function saveConfig(input, actor, ip) {
  const cur = getSetting('mail', {});
  const host = String(input.host || '').trim();
  const port = Number(input.port) || 587;
  const from = String(input.from || '').trim();
  const user = String(input.user || '').trim();
  if (input.enabled && (!host || !user)) throw new PlatformError('Enter the SMTP host and user before turning platform emails on.');
  // The server strips < and > from every request body, so "Name <a@b.c>" arrives as "Name a@b.c": split it and rebuild the header.
  let fromHeader = '';
  if (from) {
    const m = from.match(/^(.*?)\s*<?([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>?$/);
    if (!m) throw new PlatformError('"From" must contain an email address, e.g. SABIHA ERP noreply@yourdomain.com');
    const nm = m[1].replace(/["\r\n]/g, '').trim();
    fromHeader = nm ? `"${nm}" <${m[2]}>` : m[2];
  }
  const appUrl = String(input.app_url || '').trim().replace(/\/+$/, '');
  if (appUrl && !/^https?:\/\/[^\s]+$/.test(appUrl)) throw new PlatformError('Website address must start with http:// or https://');
  const next = {
    enabled: !!input.enabled, host, port, secure: !!input.secure, user, from: fromHeader, app_url: appUrl,
    brand: String(input.brand || 'SABIHA ERP').trim().slice(0, 60) || 'SABIHA ERP',
    pass_enc: input.pass ? encrypt(String(input.pass)) : cur.pass_enc || null, // blank = keep the stored password
  };
  setSetting('mail', next);
  audit(actor, 'MAIL_SETTINGS_SAVED', host, { enabled: next.enabled }, ip);
}
function transporter(c) {
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
}
const log = (to, template, subject, status, error) => { try { run(`INSERT INTO email_log(to_email,template,subject,status,error) VALUES($1,$2,$3,$4,$5)`, [to, template, subject, status, error ? String(error).slice(0, 500) : null]); } catch (_) { /* log only */ } };

function baseUrl(origin) { const c = getConfig(); return c.app_url || String(origin || '').replace(/\/+$/, '') || ''; }

// ---- templates -------------------------------------------------------------------
const wrap = (brand, title, bodyHtml) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e3e7ee;border-radius:12px;overflow:hidden">
<div style="background:#182A5C;color:#fff;padding:16px 22px;font-size:17px;font-weight:600">${esc(brand)}</div>
<div style="padding:22px;color:#1b2333;font-size:14.5px;line-height:1.55"><h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${bodyHtml}</div>
<div style="padding:12px 22px;background:#f5f7fb;color:#6b7590;font-size:12px">This is an automatic message from ${esc(brand)}. Please do not reply to it.</div></div>`;
const btn = (url, label) => url ? `<p style="margin:18px 0"><a href="${esc(url)}" style="background:#2F5BEA;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(label)}</a></p>` : '';

const TEMPLATES = {
  requestReceived: (v, b) => ({ subject: `We received your request — ${v.company_name}`, title: 'Request received',
    html: `<p>Thank you for registering <b>${esc(v.company_name)}</b>.</p><p>Your reference number is <b>${esc(v.reference)}</b>. We will review your request and email you as soon as a decision is made. You can also check the status on the sign-in page using this reference.</p>` }),
  requestApproved: (v, b) => ({ subject: `Your company is approved — ${v.company_name}`, title: 'Your company is ready',
    html: `<p>Good news — <b>${esc(v.company_name)}</b> has been approved.</p>
      <table style="border-collapse:collapse;margin:10px 0"><tr><td style="padding:4px 14px 4px 0;color:#6b7590">Company ID</td><td><b>${esc(v.company_code)}</b></td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#6b7590">Admin User ID</td><td><b>${esc(v.admin_username)}</b></td></tr></table>
      <p>Sign in with the admin User ID and the password you chose when you applied.</p>${v.trial_text ? `<p>${esc(v.trial_text)}</p>` : ''}${btn(v.url, 'Sign in')}` }),
  requestRejected: (v, b) => ({ subject: `About your request — ${v.company_name}`, title: 'Request not approved',
    html: `<p>We could not approve the request for <b>${esc(v.company_name)}</b> at this time.</p>${v.note ? `<p><b>Reason:</b> ${esc(v.note)}</p>` : ''}<p>If you think this is a mistake, please contact us and mention your reference number.</p>` }),
  userApproved: (v, b) => ({ subject: `Your account is approved — ${v.company_name}`, title: 'Your account is approved',
    html: `<p>Hello ${esc(v.full_name || v.username)},</p><p>Your User ID <b>${esc(v.username)}</b> for <b>${esc(v.company_name)}</b> has been approved. You can sign in now.</p><p>Company ID: <b>${esc(v.company_code)}</b></p>${btn(v.url, 'Sign in')}` }),
  expiryReminder: (v, b) => {
    const s = { d15: `expires in ${v.days_left} days`, d7: `expires in ${v.days_left} days`, d1: v.days_left === 0 ? 'expires today' : 'expires tomorrow', expired: `expired on ${v.expires_on_fmt}`, readonly: `expired on ${v.expires_on_fmt}` }[v.kind];
    const tail = v.kind === 'readonly'
      ? 'The grace period is over, so the account is now read-only: you can still sign in, view and export everything, but cannot add new entries. Nothing has been deleted.'
      : v.kind === 'expired' ? `You have a grace period of ${v.grace_days} days during which everything keeps working. After that the account becomes read-only (view and export only). Nothing is ever deleted.`
        : 'Please renew before then so your team is not interrupted.';
    return { subject: `${v.company_name}: your ${v.is_trial ? 'trial' : v.plan_name + ' plan'} ${s}`, title: `Your ${v.is_trial ? 'trial' : v.plan_name + ' plan'} ${s}`,
      html: `<p>Company: <b>${esc(v.company_name)}</b> (${esc(v.company_code)})<br>Plan: <b>${esc(v.plan_name)}</b><br>${v.expires_on_fmt ? `Expiry date: <b>${esc(v.expires_on_fmt)}</b>` : ''}</p><p>${esc(tail)}</p>${v.contact ? `<p>To renew, contact ${esc(v.contact)}.</p>` : ''}${btn(v.url, 'Open the app')}` };
  },
  planRequest: (v, b) => ({ subject: `Plan request — ${v.company_name} (${v.company_code})`, title: 'New plan request',
    html: `<p><b>${esc(v.company_name)}</b> (${esc(v.company_code)}) asked to ${v.kind === 'RENEW' ? 'renew' : v.kind === 'UPGRADE' ? 'change to' : 'buy'} the <b>${esc(v.plan_name)}</b> plan for <b>${esc(v.months)} month(s)</b> (about Rs. ${esc(v.price)}).</p>${v.note ? `<p>Note: ${esc(v.note)}</p>` : ''}<p>Requested by ${esc(v.requested_by || '')}. Open the Platform console → Plan Requests to approve or reject.</p>` }),
  planDecision: (v, b) => v.approved
    ? ({ subject: `Your plan is active — ${v.company_name}`, title: 'Plan approved', html: `<p>Your request for the <b>${esc(v.plan_name)}</b> plan (${esc(v.months)} month${v.months > 1 ? 's' : ''}) for <b>${esc(v.company_name)}</b> was approved.</p><p>It is valid until <b>${esc(v.expires)}</b>.${v.amount ? ` Amount: Rs. ${esc(v.amount)}.` : ''}</p>${v.note ? `<p>${esc(v.note)}</p>` : ''}<p>Thank you.</p>` })
    : ({ subject: `About your plan request — ${v.company_name}`, title: 'Plan request not approved', html: `<p>Your request for the <b>${esc(v.plan_name)}</b> plan for <b>${esc(v.company_name)}</b> could not be approved.</p>${v.note ? `<p><b>Reason:</b> ${esc(v.note)}</p>` : ''}<p>Please contact us if you have questions.</p>` }),
  test: (v, b) => ({ subject: `Test email from ${b}`, title: 'Email is working', html: '<p>This is a test message. Your platform email settings are correct.</p>' }),
};

async function deliver(template, to, vars) {
  const c = getConfig();
  if (!c.enabled) return { sent: false, reason: 'Platform email is turned off.' };
  if (!c.host || !c.user) return { sent: false, reason: 'Platform email is not configured.' };
  if (!EMAIL_RE.test(String(to || ''))) return { sent: false, reason: 'No valid recipient address.' };
  const t = TEMPLATES[template];
  if (!t) return { sent: false, reason: 'Unknown template.' };
  const m = t(vars || {}, c.brand);
  try {
    await transporter(c).sendMail({ from: c.from || c.user, to, subject: m.subject, html: wrap(c.brand, m.title, m.html), text: m.title });
    log(to, template, m.subject, 'SENT');
    return { sent: true };
  } catch (e) {
    log(to, template, m.subject, 'FAILED', e.message);
    return { sent: false, reason: e.message };
  }
}
/** Fire-and-forget. Safe to call anywhere; never throws, never waits. */
function sendTemplate(template, to, vars) {
  if (!getConfig().enabled) return;
  deliver(template, to, vars).catch(() => {});
}
async function sendTest(to) {
  if (!EMAIL_RE.test(String(to || ''))) throw new PlatformError('Enter a valid email address to send the test to.');
  const c = getConfig();
  if (!c.host || !c.user) throw new PlatformError('Save the SMTP host and user first.');
  const m = TEMPLATES.test({}, c.brand);
  try {
    await transporter(c).sendMail({ from: c.from || c.user, to, subject: m.subject, html: wrap(c.brand, m.title, m.html), text: m.title });
    log(to, 'test', m.subject, 'SENT');
  } catch (e) { log(to, 'test', m.subject, 'FAILED', e.message); throw new PlatformError(`The test email could not be sent: ${e.message}`, 502); }
}
const recentLog = (limit = 100) => all(`SELECT id, to_email, template, subject, status, error, created_at FROM email_log ORDER BY id DESC LIMIT $1`, [Math.min(Number(limit) || 100, 500)]);

module.exports = { getConfig, publicConfig, saveConfig, sendTemplate, deliver, sendTest, baseUrl, recentLog };
