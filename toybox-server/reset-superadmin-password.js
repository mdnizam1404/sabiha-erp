// ============================================================================
// reset-superadmin-password.js — recover the Platform Owner (super admin) login
//
//   node reset-superadmin-password.js NewPassword123 [USERNAME]
//
// Run on the server itself. Sets a new password (min 8 chars, letters + numbers),
// unlocks the account and re-activates it. USERNAME defaults to the first
// super admin.
// ============================================================================
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  });
}
const [, , newPassword, username] = process.argv;
if (!newPassword) { console.log('Usage: node reset-superadmin-password.js <new-password> [username]'); process.exit(1); }
const P = require('./lib/platform');
try { P.checkPasswordStrength(newPassword, 'Password'); } catch (e) { console.log(e.message); process.exit(1); }
const admin = username
  ? P.one(`SELECT id, username FROM platform_admins WHERE lower(username)=lower($1)`, [username])
  : P.one(`SELECT id, username FROM platform_admins ORDER BY id LIMIT 1`);
if (!admin) { console.log('No super admin account found.'); process.exit(1); }
P.run(`UPDATE platform_admins SET password_hash=$2, active=true, must_change_password=false WHERE id=$1`, [admin.id, bcrypt.hashSync(newPassword, 10)]);
P.run(`DELETE FROM platform_login_attempts WHERE lower(username)=lower($1)`, [admin.username]);
P.audit('cli', 'SUPERADMIN_PASSWORD_RESET', admin.username, {});
console.log(`Password reset for super admin "${admin.username}". Sign in at /platform.html.`);
process.exit(0);
