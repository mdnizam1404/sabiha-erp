# SABIHA ERP — Release 5.4.0 (Returns, plan pop-ups, Plan & Billing)

## 1. Customer returns (credit notes) — Customers & Sales → **Customer Returns**
* Raise a return from the ↩ button on any invoice, or **New Customer Return**. Pick the products and quantities
  (the screen shows sold / already returned / still returnable), the reason, and whether the goods are **Good (back to
  stock)** or **Damaged (not restocked)**. Optionally record money refunded to the customer.
* A return is **Pending** until a Manager, Accountant or Admin **accepts** it (they can also tick "Accept immediately").
  A pending or rejected return changes nothing.
* **When accepted, automatically:** stock goes back in (combo packs return each part) · the customer's balance falls
  (or a refund is recorded) · the invoice shows the returned amount and status (Partial / Paid / **Returned**) ·
  Sales, GST output, Profit & Loss, Balance Sheet, Cash Book, dashboard, top products, salesperson sales and
  targets/incentives, customer ledger/statement, due lists, invoice PDF and the mobile app's balances all use the
  **net** figures. A credit note can be printed.
* Safeguards: you cannot return more than was sold (pending returns reserve quantity), a refund cannot exceed the money
  actually paid on that invoice, an invoice with returns cannot be edited or deleted, an accepted return can only be
  **reversed by an Admin** (stock and balances go back), everything is in the audit log.

## 2. Returns to supplier (debit notes) — Purchases → **Returns to Supplier**
* ↩ button on a received purchase, or **New Return to Supplier**: quantity, reason, optional refund received.
* **When accepted:** stock goes out (refused if that stock has already been used or sold) · the supplier's balance and
  the purchase's payable fall · purchases, **Input GST**, P&L, raw-material cost, supplier ledger and due lists use net
  figures. Supplier payments are checked against the net balance. A debit note can be printed.

## 3. Clear pop-ups when a plan blocks something
* Modules your plan does not include stay in the menu with a 🔒. Clicking one explains exactly why
  ("**Loans is not part of your plan** — your Trial plan does not include it…") instead of silently hiding it.
* When a plan has **expired** (read-only after the grace period) any attempt to add or change data shows
  "**Your plan has expired — read-only mode**", the expiry date, and what to do. Plan **limits** (users, branches,
  invoices, storage) show "Plan limit reached" with the numbers.
* Company admins get a **Renew / Plan & Billing** button inside the pop-up; other users are told to ask their admin.

## 4. Plan & Billing page for the company admin (menu → Plan & Billing)
Current plan, start/expiry date, days left, grace period, price · usage meters against the limits · which modules are
included · plans on offer with a **Buy / Renew** request (plan + months + total price + payment instructions) ·
request status (waiting / approved / rejected with the reason) · billing history. Works even when the plan is expired.
The platform owner sees these under **Plan Requests** (with a badge), confirms payment, and **Approve** applies the plan,
extends the validity (a trial becomes a paid plan starting today) and creates the billing record. Payment details
shown to companies are set in **Settings → How companies should pay**.

## Know the limits
* Returns need an internet connection (they are checked by the server); the mobile app does not raise returns yet.
* Payment is handled outside the software (bank / UPI / cash); the owner confirms and approves. There is no online gateway.
* Old data is unchanged; returns start from the day you install this version.
