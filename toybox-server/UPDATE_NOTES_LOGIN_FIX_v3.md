# SABIHA ERP — User Login Fix v3

## User login issue fixed

### Backend
- User IDs are now case-insensitive and trimmed.
- Legacy `active = NULL` records are treated as active for backward compatibility.
- Approved users are allowed to log in when active.
- Pending, rejected, and inactive accounts now return explicit messages.
- Legacy role names such as `SALES PERSON`, `SALESPERSON`, `ACCOUNTS`, `ADMINISTRATOR`, and `MANAGEMENT` are normalized for the session.
- Employee ID is included in the login session token/user response.
- Failed-login lock tracking is now case-insensitive.
- Admin-created User IDs are checked case-insensitively for duplicates.
- Admin approval explicitly activates the account (`active = 1`).

### Frontend
- Login now shows an error popup for every login failure instead of silently returning to the login screen.
- Exact examples:
  - `Wrong User ID. No account was found for this User ID.`
  - `Wrong password for this User ID.`
  - `Your User ID is pending Administrator approval.`
  - `Your account is inactive.`
- The login error is also displayed below the password field.
- If `/me` fails immediately after a successful login, the error is now returned to the login screen instead of being silently swallowed.
- Sign In button displays `Signing in...` while the request is in progress.
- Enter key works from the User ID and Password fields.
- Error-popup text is HTML-escaped.

### Users & Roles
- Employee Link and Role columns are corrected in the user-management table.
- An approved but inactive account now shows `Approved — Inactive` and an `Activate` button.

## Validation
- `node --check routes/admin.js` — PASS
- `node --check public/app.js` — PASS
- `node --check db.js` — PASS

A full Express/SQLite runtime test could not be completed in the build sandbox because npm registry access/dependency installation is unavailable there. The package remains unchanged architecturally.

## Login Permission Fix v4
- Login response now includes the normalized role and module permissions immediately after successful credential/approval validation.
- The frontend no longer treats a post-authentication `/me` permission mismatch as a failed login when a valid login session has already been issued.
- Role guards normalize legacy role names (e.g. SALES PERSON/SALESPERSON/SALES EXECUTIVE -> SALES; ADMINISTRATOR -> ADMIN; MANAGEMENT -> MANAGER) before checking permissions.
- Permission-denied API responses now identify the authenticated role and required role(s), making diagnosis explicit instead of returning only a generic message.
- Existing architecture and JWT/session model are unchanged.
