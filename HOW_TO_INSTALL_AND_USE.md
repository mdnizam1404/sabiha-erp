# SABIHA ERP — how to install and use (step by step)

There are two ways to run the package. Choose **A** to try it on one computer, **B** for the real business.

## A. Try it on one Windows / Mac computer (about 15 minutes)
1. **Install Node.js 20** from https://nodejs.org (click the big "LTS" button, next, next, finish).
2. **Install PostgreSQL 16** from https://www.postgresql.org/download — during setup note the password you give for the
   user `postgres`. Keep the default port 5432.
3. Unzip `SABIHA_ERP_MultiCompany_Final_v5_5_0.zip`. Open the folder `wa/toybox-server`.
4. Copy the file `.env.example` and name the copy `.env`. Open `.env` in Notepad and set:
   `PGPASSWORD=` *(the PostgreSQL password from step 2)*, `JWT_SECRET=` *(any long random text, 30+ characters)*,
   `SUPERADMIN_PASSWORD=` *(a strong password of your choice — letters and numbers)*. Save.
5. Open a terminal in that folder (Windows: click the address bar of the folder, type `cmd`, press Enter) and run:
   `npm install` then `npm start`.
6. Open **http://localhost:3000** in your browser — the company sign-in page. The first company is `DEFAULT`,
   user `ADMIN`, password `admin` (you are asked to change it).
7. Open **http://localhost:3000/platform.html** for the **Platform Owner console** (user `SUPERADMIN`, the password from step 4).

## B. The real business server (Hostinger VPS, so every user and app can connect)
Follow **`toybox-server/HOSTING_VPS.md`** exactly. You need a **Hostinger VPS** (not shared hosting), a domain name,
and HTTPS. After this, everyone uses `https://erp.yourcompany.com`.

## First hour as the platform owner
1. Open `/platform.html` → **My Security** → turn on two-step verification.
2. **Settings**: support contact, how companies should pay, platform email.
3. **Plans**: set prices, limits and modules of Trial / Basic / Standard / Premium.
4. **Create Company** (or let businesses apply from the sign-in page and approve them under *Company Requests*).
5. Give the company its **Company ID, admin User ID and temporary password**. They choose their own password at first sign-in.

## Everyday use (company admin and staff)
* **Sell:** Customers & Sales → *Sales Invoices* → New. **Collect money:** *Receipts*.
* **Customer returned goods:** Customers & Sales → *Customer Returns* → New (or the ↩ button on the invoice). A manager
  presses **Accept** — stock, customer balance and reports update by themselves.
* **Goods sent back to a supplier:** Purchases → *Returns to Supplier* → New (or ↩ on the purchase) → **Accept**.
* **Plan, validity, buying or renewing:** menu **Plan & Billing** (company admin).
* **Backups:** the owner console makes a nightly backup of every company automatically (Backups tab).
* **Apps:** install the Windows / Mac desktop app for the office and the Android / iPhone app for salespeople —
  see `apps/BUILD_APPS.md` and `apps/BUILD_APPS_STEP_BY_STEP.md`.
