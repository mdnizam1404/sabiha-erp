# SABIHA ERP — Release 5.3.0 (Offline apps: desktop + mobile)

Adds a **desktop app** (Windows, macOS) for office users and a **mobile app** (Android, iPhone/iPad) for
salespeople. Both keep working with **no internet** and **synchronise automatically** with the main server
when the connection returns. The server stays the single source of truth (your live Hostinger VPS).

## SABIHA Sales — mobile app for salespeople (`apps/mobile`)
* Downloads customers (with what they owe), products, rates, GST and stock to the phone.
* With no signal: make invoices, **add new customers**, **collect payments** (cash/UPI/cheque), see
  today's totals and customer balances — all saved on the phone first.
* When signal appears (app opened, network back, every minute while open) everything is sent **in the order it was made**
  — a new shop, then its invoice, then the payment against that invoice — and the server assigns the
  official invoice and receipt numbers. Sent twice by accident? The server recognises it; no duplicates.
* Shows each item as *Waiting to sync / Synced / Not accepted (with the reason)*; rejected items can be retried or discarded.
* Warns when a sale is above stock or over the customer's credit limit; stock and balances on the phone include
  what is still waiting to sync.
* If the company plan expired into read-only, the app says so and keeps the work safe until renewal.

## SABIHA ERP Desktop — office app (`apps/desktop`)
* The same full application as the website, in a Windows / macOS window.
* Every page you open and the main lists (customers, products, sales, receipts, employees, suppliers, raw
  materials, production, purchases, stock, expenses, dashboard) are saved on the computer — **read them offline**.
* **Save offline**: sales, receipts, customers, suppliers, expenses, attendance, production entries,
  purchases, stock and product/employee changes are queued and sent automatically in order.
  Settings, users, passwords, backups and sign-in need internet and say so.
* A status badge (bottom-left) shows *Offline · n waiting* and opens the **Sync Center** (retry / discard rejected items).
* Screens come from your server, so updating the server updates every desktop app.

## Server changes
* `GET /api/sync/master` — one-call download of customers, products, stock and settings (skips if unchanged).
* `/api/sync/push` now also accepts **CUSTOMER** and **RECEIPT**; invoices/receipts can refer to a customer or invoice
  created offline in the same batch (`customer_client_id`, `invoice_client_id`).
* **Idempotency keys** (`X-Idempotency-Key`) make every offline replay safe against double-saving.
* CORS allows the mobile app's local origins; the office web app also works as an installable offline PWA.

## Know the limits (read this)
* **First sign-in needs internet.** After that, everything above works offline. If a sign-in session expires while
  offline, nothing is lost: sign in again when online and the waiting items are sent.
* **Same record changed on two devices:** office changes are sent as saved, last one wins; sales invoices and
  receipts never conflict (they are new records). The server numbers invoices, so a number is final only after sync.
* **Stock/balances shown offline are as of the last sync**, plus the phone's own unsent sales. Two salespeople can
  both sell the last item offline; the server accepts both (stock may show negative) and you see it in reports.
* **Offline desktop covers day-to-day entries**, not everything: you cannot create a user, change settings, run
  payroll approval or restore a backup without internet. An action that depends on a record created offline an hour
  earlier (e.g. edit a customer that is still waiting to sync) should wait until it has synced.
* iPhone apps cannot sync while fully closed (an iOS rule); they sync as soon as the app is opened.
* Saved data lives on the device in the app's own storage. Use a screen lock / disk encryption on laptops and phones.
