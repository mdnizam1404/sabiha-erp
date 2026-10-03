// ============================================================================
// lib/extras.js — company branding (login page), announcements, login history
// ============================================================================
const { one, all, run, PlatformError, audit } = require('./platformdb');
const mt = require('./multitenant');

// ---- branding ---------------------------------------------------------------------
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 300 * 1024;

function getBranding(companyId) {
  const b = one(`SELECT display_name, tagline, primary_color, logo_data_url, updated_at FROM company_branding WHERE company_id=$1`, [companyId]);
  return b || { display_name: null, tagline: null, primary_color: null, logo_data_url: null, updated_at: null };
}
function saveBranding(company, input, actor, ip) {
  const cur = getBranding(company.id);
  const display = input.display_name === undefined ? cur.display_name : (String(input.display_name || '').trim().slice(0, 80) || null);
  const tagline = input.tagline === undefined ? cur.tagline : (String(input.tagline || '').trim().slice(0, 140) || null);
  let color = input.primary_color === undefined ? cur.primary_color : (String(input.primary_color || '').trim() || null);
  if (color && !COLOR_RE.test(color)) throw new PlatformError('Colour must look like #2F5BEA.');
  let logo = cur.logo_data_url;
  if (input.logo_data_url !== undefined) {
    if (!input.logo_data_url) logo = null;
    else {
      const d = String(input.logo_data_url);
      if (!LOGO_RE.test(d)) throw new PlatformError('The logo must be a PNG, JPG or WEBP image.');
      if (Buffer.byteLength(d) > MAX_LOGO * 1.37) throw new PlatformError('The logo is too large. Use an image under 300 KB.');
      logo = d;
    }
  }
  run(`INSERT INTO company_branding(company_id,display_name,tagline,primary_color,logo_data_url,updated_at) VALUES($1,$2,$3,$4,$5,now())
       ON CONFLICT (company_id) DO UPDATE SET display_name=$2,tagline=$3,primary_color=$4,logo_data_url=$5,updated_at=now()`, [company.id, display, tagline, color, logo]);
  audit(actor, 'BRANDING_SAVED', company.company_code, { has_logo: !!logo, color }, ip);
  return getBranding(company.id);
}
/** What the public login page may see for a company (only active companies). */
function publicBranding(code) {
  const c = mt.getCompanyByCode(code);
  if (!c || c.status !== 'ACTIVE') return null;
  const b = getBranding(c.id);
  return { company_code: c.company_code, company_name: c.company_name, display_name: b.display_name || c.company_name, tagline: b.tagline, primary_color: b.primary_color, logo_data_url: b.logo_data_url };
}

// ---- announcements ----------------------------------------------------------------
const SEV = ['info', 'warning', 'danger'];
function listAnnouncements() { return all(`SELECT id,title,body,severity,starts_at,ends_at,active,created_by,created_at FROM announcements ORDER BY id DESC LIMIT 200`); }
function activeAnnouncements() {
  return all(`SELECT id,title,body,severity,starts_at,ends_at FROM announcements WHERE active AND starts_at <= now() AND (ends_at IS NULL OR ends_at >= now()) ORDER BY id DESC LIMIT 5`);
}
function validAnn(input) {
  const title = String(input.title || '').trim();
  if (title.length < 3 || title.length > 120) throw new PlatformError('Enter a title (3-120 characters).');
  const body = String(input.body || '').trim().slice(0, 1000);
  const severity = String(input.severity || 'info').toLowerCase();
  if (!SEV.includes(severity)) throw new PlatformError('Severity must be info, warning or danger.');
  const when = (v, label) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw new PlatformError(`${label} is not a valid date.`); return d.toISOString(); };
  const starts = when(input.starts_at, 'Start');
  const ends = when(input.ends_at, 'End');
  if (starts && ends && new Date(ends) <= new Date(starts)) throw new PlatformError('The end must be after the start.');
  return { title, body, severity, starts, ends };
}
function createAnnouncement(input, actor, ip) {
  const a = validAnn(input);
  const r = one(`INSERT INTO announcements(title,body,severity,starts_at,ends_at,created_by) VALUES($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6) RETURNING id`, [a.title, a.body, a.severity, a.starts, a.ends, actor]);
  audit(actor, 'ANNOUNCEMENT_CREATED', String(r.id), { title: a.title }, ip);
  return r;
}
function updateAnnouncement(id, input, actor, ip) {
  const cur = one(`SELECT * FROM announcements WHERE id=$1`, [Number(id) || 0]);
  if (!cur) throw new PlatformError('Announcement not found.', 404);
  const a = validAnn({ title: input.title ?? cur.title, body: input.body ?? cur.body, severity: input.severity ?? cur.severity, starts_at: input.starts_at === undefined ? cur.starts_at : input.starts_at, ends_at: input.ends_at === undefined ? cur.ends_at : input.ends_at });
  run(`UPDATE announcements SET title=$2,body=$3,severity=$4,starts_at=COALESCE($5::timestamptz,starts_at),ends_at=$6,active=$7 WHERE id=$1`, [cur.id, a.title, a.body, a.severity, a.starts, a.ends, input.active === undefined ? cur.active : !!input.active]);
  audit(actor, 'ANNOUNCEMENT_UPDATED', String(cur.id), {}, ip);
}
function deleteAnnouncement(id, actor, ip) { run(`DELETE FROM announcements WHERE id=$1`, [Number(id) || 0]); audit(actor, 'ANNOUNCEMENT_DELETED', String(id), {}, ip); }

// ---- login history -----------------------------------------------------------------
function recordLogin(companyCode, username, success, reason, ip, ua) {
  try { run(`INSERT INTO company_login_history(company_code,username,success,reason,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6)`, [String(companyCode || '').toUpperCase(), String(username || '').slice(0, 80), !!success, reason ? String(reason).slice(0, 200) : null, ip || null, String(ua || '').slice(0, 200)]); } catch (_) { /* never block a login */ }
}
function loginHistory(code, limit = 100) {
  return all(`SELECT id, username, success, reason, ip, user_agent, created_at FROM company_login_history WHERE company_code=$1 ORDER BY id DESC LIMIT $2`, [String(code || '').toUpperCase(), Math.min(Number(limit) || 100, 500)]);
}
function cleanup() {
  run(`DELETE FROM company_login_history WHERE created_at < now() - interval '180 days'`);
  run(`DELETE FROM email_log WHERE created_at < now() - interval '90 days'`);
  run(`DELETE FROM platform_audit_logs WHERE created_at < now() - interval '400 days'`);
}

module.exports = { getBranding, saveBranding, publicBranding, listAnnouncements, activeAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, recordLogin, loginHistory, cleanup };
