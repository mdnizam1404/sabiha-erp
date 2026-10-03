// ============================================================================
// SABIHA ERP — SMS OTP gateway helper
// Supports MSG91 Flow API for transactional/OTP SMS.
// Credentials live in .env, not SQLite backups.
// ============================================================================
const fs = require('fs');
const path = require('path');

function appDir() { return process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..'); }
function envPath() { return path.join(appDir(), '.env'); }
function cfg() {
  return {
    provider: String(process.env.SMS_PROVIDER || 'MSG91').trim().toUpperCase(),
    apiUrl: String(process.env.SMS_API_URL || 'https://control.msg91.com/api/v5/flow').trim(),
    authKey: String(process.env.SMS_AUTH_KEY || '').trim(),
    templateId: String(process.env.SMS_TEMPLATE_ID || '').trim(),
    senderId: String(process.env.SMS_SENDER_ID || '').trim(),
    countryCode: String(process.env.SMS_COUNTRY_CODE || '91').replace(/\D/g, '') || '91',
    variableName: String(process.env.SMS_VARIABLE_NAME || 'VAR1').trim() || 'VAR1',
    enabled: String(process.env.SMS_OTP_ENABLED || '0').trim() === '1',
    otpExpiryMinutes: Math.max(1, Math.min(15, Number(process.env.SMS_OTP_EXPIRY_MINUTES || 5))),
    resendSeconds: Math.max(20, Math.min(300, Number(process.env.SMS_OTP_RESEND_SECONDS || 30))),
    authKeyConfigured: !!String(process.env.SMS_AUTH_KEY || '').trim(),
  };
}
function isConfigured() {
  const c = cfg();
  return c.provider === 'MSG91' && !!c.apiUrl && !!c.authKey && !!c.templateId;
}
function normalizePhone(phone) {
  let raw = String(phone || '').trim().replace(/[\s().-]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) raw = raw.slice(1);
  if (raw.startsWith('00')) raw = raw.slice(2);
  if (/^\d{10}$/.test(raw)) raw = cfg().countryCode + raw;
  return /^\d{10,15}$/.test(raw) ? raw : '';
}
function writeEnv(values) {
  const file = envPath();
  let lines = [];
  try { lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []; }
  catch (e) { throw new Error('Could not read .env: ' + e.message); }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${String(value ?? '').replace(/\r?\n/g, '')}`;
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const i = lines.findIndex(x => re.test(x));
    if (i >= 0) lines[i] = line; else lines.push(line);
    process.env[key] = String(value ?? '');
  }
  try { fs.writeFileSync(file, lines.join('\n')); }
  catch (e) { throw new Error('Could not save .env: ' + e.message); }
}
async function sendOtp({ phone, code }) {
  const c = cfg();
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const mobile = normalizePhone(phone);
  if (!mobile) return { sent: false, reason: 'invalid_phone' };
  if (c.provider !== 'MSG91') return { sent: false, reason: 'unsupported_provider' };
  const recipient = { mobiles: mobile };
  recipient[c.variableName] = String(code);
  const payload = {
    template_id: c.templateId,
    short_url: '0',
    recipients: [recipient],
  };
  const response = await fetch(c.apiUrl, {
    method: 'POST',
    headers: { accept: 'application/json', authkey: c.authKey, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!response.ok || (data.type && String(data.type).toLowerCase() === 'error')) {
    const msg = data.message || data.error || data.errors || `SMS gateway returned HTTP ${response.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return { sent: true, provider: 'MSG91', response: data, mobile };
}
async function sendTest({ phone }) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return sendOtp({ phone, code });
}
module.exports = { cfg, isConfigured, normalizePhone, sendOtp, sendTest, writeEnv };
