# Platform Owner Guide — v5.2

Open **/platform.html** and sign in with the Super Admin account (first password
is printed once in the start-up window and saved in `data/SUPERADMIN_FIRST_PASSWORD.txt`).

## First 10 minutes
1. **My Security** → turn on two-step verification and save the 8 recovery codes.
2. **Settings** → support contact (shown to companies in expiry banners), default
   grace period (7 days) and what happens at a plan limit (warn / block).
3. **Settings → Platform email** → SMTP details, *Send test*. Without this,
   applicants must check status on the login page and no reminders are emailed.
4. **Plans** → adjust prices, limits and modules of Trial / Basic / Standard / Premium.
5. **Backups** → check the nightly time and retention; plan to copy
   `data/company-backups/` to another machine regularly.

## Daily work
| Task | Where |
|---|---|
| Approve a company request (starts a 14-day trial) | Company Requests → Approve… |
| Create a company by hand | Create Company (admin must change the password at first sign-in) |
| Renew / change plan / expiry | Companies → Renew, or Details → Plan & expiry |
| Reset a company admin's password | Companies → Reset admin password |
| Backup, restore, restore as a new company | Companies → Backup now, Details → Backups, or the Backups tab |
| Branding and the `/c/CODE` login link | Companies → Details → Login page branding |
| Message every company | Announcements |
| Record what a company pays | Billing → New billing record → Mark paid (optionally extends the plan) |
| See who signed in and when | Companies → Details → Sign-in history |

## What happens when a plan runs out
`15 / 7 / 1 days before` → banner for the company admin (and an email) →
**expiry day** → grace period (default 7 days, everything works) →
**read-only** (sign in, view, export; nothing can be added or changed).
Nothing is deleted or suspended. Renewing restores full access immediately.
Use **Suspend** only for real problems; use **Archive** to retire a company
(a full backup is taken first and you can bring it back).

## Team accounts
*Owner* can change everything. *Support* is view-only; each company a support
user opens is recorded in the Activity Log. Lost phone? An owner can use
Team & Security → **Reset two-step** for that person. If the only owner is
locked out, run `node reset-superadmin-password.js` on the server.

## Safety net
* Locked yourself out with the IP allow-list? Add `PLATFORM_IP_ALLOWLIST_DISABLE=1`
  to `.env`, restart, fix the list, remove the line.
* `JWT_SECRET` also protects the stored SMTP password and two-step secrets —
  do not change it after setting them up (you would have to re-enter them).
