// ============================================================================
// reset-admin-password.js — emergency recovery when NO admin can log in
//
// Usage (run from this folder, on the server itself):
//   node reset-admin-password.js NewPassword123
//
// This talks directly to the PostgreSQL database configured in .env — it does
// not need the server to be running. Use this only if every admin account is
// locked out and there's no one left to use the in-app "Reset Password" button.
// ============================================================================
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Read .env (same rules as server.js) so PGHOST/PGDATABASE/... are picked up
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  });
}

const newPassword = process.argv[2];
if (!newPassword || newPassword.length < 4) {
  console.log('Usage: node reset-admin-password.js <new-password>');
  console.log('The new password must be at least 4 characters.');
  process.exit(1);
}

const { db } = require('./db');

const admin = db.prepare(`SELECT id, username FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1`).get();
if (!admin) {
  console.log('No ADMIN account was found in the database.');
  db.close();
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
db.prepare(`UPDATE users SET password_hash = ?, status = 'Approved', active = 1, reset_requested = 0 WHERE id = ?`).run(hash, admin.id);
db.prepare(`DELETE FROM login_attempts WHERE username = ?`).run(String(admin.username).toLowerCase());

console.log(`Password for admin account "${admin.username}" has been reset (and any login lockout cleared).`);
console.log('You can now log in with that username and the new password.');
db.close();
process.exit(0);
