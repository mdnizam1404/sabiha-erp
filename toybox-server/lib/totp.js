// ============================================================================
// lib/totp.js — RFC 6238 time-based one-time passwords (Google Authenticator,
// Microsoft Authenticator, Authy …). No external dependency.
// ============================================================================
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateSecret(bytes = 20) { return base32Encode(crypto.randomBytes(bytes)); }

function hotp(secretBuf, counter, digits = 6, algo = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
function totpAt(secret, timeMs = Date.now(), step = 30, digits = 6, algo = 'sha1') {
  return hotp(base32Decode(secret), Math.floor(timeMs / 1000 / step), digits, algo);
}
/** Accepts the current code and one step either side (clock drift). */
function verify(secret, code, { window = 1, timeMs = Date.now(), step = 30 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / step);
  let ok = false;
  for (let w = -window; w <= window; w++) {
    const expected = hotp(key, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) ok = true; // no early exit
  }
  return ok;
}
function otpauthUri(secret, account, issuer = 'SABIHA ERP Platform') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
module.exports = { generateSecret, base32Encode, base32Decode, hotp, totpAt, verify, otpauthUri };
