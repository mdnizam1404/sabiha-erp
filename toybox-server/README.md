# SABIHA ERP — Manufacturing Suite (Multi-Company PostgreSQL Build)

> **Multi-company build:** each company has its own PostgreSQL database. Read **MULTI_TENANT_INSTALL.md** first, then **POSTGRESQL_SETUP_v13.md** for PostgreSQL installation.

A real, installable Node.js + PostgreSQL ERP for a manufacturing business —
production, stock, sales, payroll, outsourcing, and accounts, with role-based
logins and a live PostgreSQL database (v13 — see POSTGRESQL_SETUP_v13.md). Runs on
your own PC or server — no internet connection needed once installed, no monthly
fees, no cloud account.

Package created by **SABIHA IT SOLUTION PVT. LTD.** For support: sabihaitsolution@gmail.com

## Installing on your own Windows PC (recommended, no typing required)

> **Want a `.exe` you can double-click?** See
> `README-EXE-OPTION1-SIMPLE.md` (quick, still needs Node.js installed) or
> `README-EXE-OPTION2-STANDALONE.md` (a fully standalone `.exe` — bundles
> Node.js itself, nothing to install on the target PC). The steps below
> already get you a working double-click launcher (`start.bat`) without
> either of those — the two guides are for when you specifically want a
> `.exe` file instead.

> **Getting a future update?** See `PATCHING.md` — small updates apply in
> place with `apply-patch.bat`, without reinstalling anything or touching
> your data.

1. **Install Node.js** (one-time, only if you don't already have it): go to
   https://nodejs.org, download the **LTS** version, and run the installer
   with default options.
2. **Unzip** this package somewhere permanent, e.g. `C:\SabihaERP`.
3. **Double-click `install.bat`** inside the folder. It downloads everything
   the app needs — this needs internet access and only has to run once.
4. **Double-click `start.bat`** any time you want to run SABIHA ERP. It
   starts the server and opens your browser automatically. Leave that black
   window open while you work — closing it stops the program.
5. Sign in with **Company Code + ADMIN / admin** (default company code is `DEFAULT`), then go to **Users & Roles** to create
   your own admin account and **Company Settings** to add your logo and
   details.

That's it — everything (your data included) lives in this one folder, on
this one PC. To back it up, just copy the whole folder, or use the built-in
**Backup & Restore** page inside the app.

On Mac or Linux, use `./install.sh` and `./start.sh` in a terminal instead
of the `.bat` files (run `chmod +x install.sh start.sh` once first if needed).

## Quick start (command line, any OS)

```bash
npm install
npm start
```

A `.env` file with a secure random login secret is created automatically on
first run — no manual editing needed. Then open **http://localhost:3000**.

First-run login: **DEFAULT / ADMIN / admin** — change this password by creating a new
admin user and deactivating the demo one, once you're set up.

## Multi-company / SaaS features

- Separate PostgreSQL database for every company — no shared transaction tables between companies.
- Company Code + User ID + Password login with tenant-bound JWTs.
- Automatic company database provisioning with `provision-company.js`.
- Branch/factory records and tenant-scoped device registration.
- Offline synchronization API for mobile clients, including idempotent offline sales invoice upload.
- Device revocation and server-side sync inbox/outbox.

See **MULTI_TENANT_INSTALL.md** for provisioning and production deployment.

## What's included


- **Dashboard** — every card is clickable and jumps straight to that module;
  live trend chips, a production pipeline widget (Molding → Cutting →
  Finishing → Sticker → Packing → Finished Goods), sales-vs-purchase and
  production-mix charts.
- **Masters** — Employees, Customers, Suppliers, Raw Materials, Products
  (with an embedded Bill of Materials — link each product to the exact raw
  materials and quantity it consumes per unit, right when you create it).
- **Transactions** — Attendance, Employee Advances (auto-deducted from the
  next payroll run for that employee), Payroll, Purchases, Supplier
  Payments, Production, Production Pipeline (stage-by-stage quantity
  tracking), Outsourcing (Persons / Jobs / Payments tabs), Sales Invoices
  (multi-line, GST, printable), Customer Receipts.
- **Reminders** — overdue invoices and low-stock materials, each with a
  working **WhatsApp** (wa.me) and **Email** (mailto) button that opens
  your own WhatsApp Web / email client with the message pre-filled, plus a
  queued/sent log.
- **Ledger** — a running debit/credit statement for any customer or
  supplier.
- **Accounts** — Trial Balance, Profit & Loss (with a 6-month trend chart),
  Balance Sheet, Cash & Bank Book, and a GST summary — all computed live
  from what you've entered.
- **Audit Log** — every create, update, and delete across the system, who
  did it, and when.
- **Users & Roles** — Admin, Manager, Sales, Accountant. New accounts
  self-register into a *Pending* state and need an admin's approval before
  they can sign in. Admins can change anyone's role or deactivate them.
- **Company Settings** — name, address, GST, logo upload (stored as an
  image directly in the database — no separate file server needed), invoice
  numbering, and a return & exchange policy that prints on every invoice.
- **Dark / light theme** toggle, saved per browser.
- **Backup** — one click downloads a timestamped full backup (.json) of the live PostgreSQL
  database file.

## Honest limitations — please read

- **SMS reminders are not actually sent.** There's no built-in SMS gateway
  (that requires a paid provider like Twilio or MSG91 and per-message
  cost). Clicking "SMS" logs it as *Queued* in the Reminders log so you can
  see what would have gone out — wire up a provider's API in
  `routes/transactions.js` (`/reminders` route) if you want it to actually
  send.
- **WhatsApp/Email reminders open your own apps** — WhatsApp Web and your
  default mail client — rather than sending silently from the server. This
  needs no paid API and works immediately, but it does mean a person has
  to be sitting at the browser to click "send."
- **PDFs can't be auto-attached to WhatsApp or Email.** Browsers and
  WhatsApp Web/mailto links don't allow a webpage to attach a file to a
  message for security reasons — no app can bypass this from the browser.
  Instead, clicking WhatsApp/Email on an invoice, receipt, or reminder
  automatically downloads the relevant PDF first, then opens the message
  — you just need one extra tap to attach the file that's already sitting
  in your Downloads folder.
- **Accounts module is simplified**, not full double-entry bookkeeping —
  no chart of accounts, no CGST/SGST state-wise split, no ledger postings
  per transaction. It's accurate for a straightforward single-GST-rate toy
  manufacturing business, but a chartered accountant preparing statutory
  filings will want a proper accounting package alongside this.
- **No email/SMS notifications on approval** — when an admin approves a
  pending user, that user currently has to be told to try logging in again;
  there's no automatic notification.
- Runs as a single Node process against a PostgreSQL database. That's fine
  for one company on one machine or a small local network, but if you need
  multiple concurrent locations writing heavily at once, plan to move to a
  networked database (Postgres/MySQL) down the line — the schema in `db.js`
  is plain SQL and would port over without much trouble.

## Project structure

```
server.js              App entry point, route wiring
db.js                  PostgreSQL schema, seed data, shared helpers
lib/pgsync.js          synchronous PostgreSQL bridge (worker thread)
lib/sqlcompat.js       SQLite→PostgreSQL SQL translation
auth.js                JWT auth middleware, role guards
routes/crud.js          Generic CRUD for simple master tables
routes/transactions.js  Production, purchases, sales, payroll, outsourcing, etc.
routes/reports.js       Dashboard, pipeline, ledgers, accounts, audit log
routes/admin.js         Auth, users & roles, settings, backup, invoice PDF
public/                 Frontend (vanilla HTML/CSS/JS + Chart.js)
(database)             PostgreSQL — configured in .env (PGHOST/PGDATABASE/...)
backups/                Downloaded backups land here too
```
