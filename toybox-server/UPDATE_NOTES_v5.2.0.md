# SABIHA ERP — Release 5.2.0 (Platform Owner features)

This release adds the commercial and safety features a platform owner needs
once several companies depend on the system. It is an upgrade of 5.1.1: existing
companies keep working exactly as before (they are treated as **"No plan —
unlimited, never expires"** until you give them a plan).

## 1. Subscription plans, expiry and limits
* Four starter plans — **Trial, Basic, Standard, Premium** — each with limits on
  users, branches, invoices per month and storage, and a list of modules.
  Edit, add or retire plans in **Platform console → Plans**.
* Every company has a plan and an **expiry date**. Companies approved from a
  request start on the **Trial plan (14 days)** automatically; you can pick
  another plan or length while approving.
* **15 / 7 / 1-day banners** for the company admin before expiry.
* **7-day grace period** (configurable) after expiry — everything keeps working.
* Then **read-only mode**: people can still sign in, view and export their data,
  but cannot add or change anything. Nothing is ever deleted or suspended
  because a plan expired.
* **One-click renewal** (+1 / 3 / 6 / 12 months or custom days), also available
  when you record a payment.
* **Limits warn first**: when a company reaches a limit it sees a message; you
  decide per company (or as default) whether new entries are then blocked.
* **Module access by plan**: Loans, Outsourcing, SMS/WhatsApp, Fixed Assets etc.
  are hidden in the menu *and* refused by the API when the plan does not include
  them. Per-company overrides of limits and modules are available.

## 2. Emails from the platform (one SMTP setting)
Request received / approved / rejected, "your account is approved" to company
users, and expiry reminders (15, 7, 1 day, on expiry, when read-only starts).
Configure once in **Settings → Platform email** and use *Send test*.
Failures never block a request and are listed under *Recent emails*.

## 3. Per-company backups
* **Backup now** per company, **nightly backups** for all companies (hour is
  configurable) with retention (default 14 nightly / 20 manual).
* **Restore into the same company** (a safety copy is taken first) or **restore
  as a new company** from any backup.
* Download a backup file; support accounts cannot.
* Files live in `data/company-backups/<COMPANY_ID>/` — copy this folder to
  another machine or cloud drive regularly.

## 4. Branding on the login page
Logo, display name, tagline and colour per company. After a user types the
Company ID, the sign-in page switches to that company's look. Optional direct
link: `https://your-site/c/LOTUS`.

## 5. Security
* **Two-step verification** (authenticator app + 8 one-time recovery codes) for
  platform accounts. A code can be used only once.
* **IP allow-list** for the console (refuses a list that would lock *you* out;
  emergency override `PLATFORM_IP_ALLOWLIST_DISABLE=1`).
* **Sign-in history per company** (who, when, IP, device, failures).
* **Forced password change**: a company admin created by you, or reset by you,
  must choose their own password at first sign-in (people who chose their own
  password when applying are not asked again).
* **Team roles**: *Owner* (full) and *Support* (view only; every company they
  open is written to the activity log). There is deliberately **no "log in as a
  company user"** button.

## 6. Later-stage features, now included
* **Announcements** — a banner in every company's app (maintenance, news).
* **Billing records** — invoices and payments per company with Due / Overdue /
  Paid status, revenue chart and monthly recurring revenue on the dashboard.
* **Growth and usage charts** on the dashboard; users, invoices, sales, last
  login and storage for every company.
* **Archive** a company (a full backup is taken first; nobody can sign in; it
  can be brought back) instead of deleting.
* Branches can now be added/edited by the company admin (limited by the plan).

Not included: sub-domains per company (depends on your hosting), and automatic
payment collection.

## Upgrade
1. Stop the server, copy the new files over the old ones (or use the patch zip).
2. `npm install` (adds nothing new if you already ran 5.1.1; `qrcode` and
   `nodemailer` were already dependencies).
3. Start the server. New platform tables are created automatically; existing
   companies become "No plan (unlimited)" until you assign a plan.
4. Open `/platform.html` → **Settings**: set the support contact, platform
   email and (recommended) turn on **My Security → two-step verification**.
