# v5.1.0 — Platform Owner (super admin), company requests, company sign-up

New
* Super-admin console (`/platform.html`): create companies, approve/reject company requests, central monitoring of every company (users, activity, sales, storage, last login), suspend / re-activate, reset company admin password, platform audit log, change password. First-run password is generated and must be changed; `reset-superadmin-password.js` for recovery; 5-attempt / 15-minute lockout.
* Login page: **Register Company** (request + reference number + status tracking) and **Create Account** now asks for the **Company ID** (searchable list + name confirmation).
* Users chosen a company are created ONLY in that company; its admin sees them under Users & Roles → "Awaiting your approval", assigns the role and approves. Menu badge + notice at sign-in.
* `users.last_login_at` (added automatically to every company database).

Security
* Platform tokens are refused by the company API; company tokens are refused by the platform API.
* Registration / forgot-password / OTP steps now require an explicit company (they previously used the default one).
* Rate limits on company requests and user sign-ups.

Includes v5.0.1: syncRouter start-up fix and per-company database routing fix.

Tested (PostgreSQL 16): 66 platform/registration/isolation checks, 31 browser-level UI checks (real page scripts in jsdom), 75-check business regression — all passing.
