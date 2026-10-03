# SABIHA ERP — Client Requirements Update

This update preserves the existing Node.js + Express + SQLite + single-page frontend architecture.
No framework, database engine, route mounting model, or application directory structure was replaced.

## Implemented

### Inventory / Products
- `products.hsn_code` migration and product validation support.
- HSN entry in Add/Edit Product and HSN in product listing/printing/import template.
- Sales item HSN snapshot (`sales_items.hsn_code`) so printed invoices retain the HSN used at sale time.

### Purchase Orders / GST
- Purchase classification: `RAW_MATERIAL`, `FINISHED_PRODUCT`, `ASSET`.
- Ordered purchases do not enter stock until `POST /api/purchases/:id/receive`.
- Received raw-material purchases add stock to `raw_materials`.
- Received finished-product purchases add stock to `products`.
- Purchase GST percentage and GST amount are stored as Input GST.
- New GST period report exposes Input GST, Output GST, Balance GST, and rate-wise reconciliation.

### Sales / Salesperson
- `sales_invoices.salesperson_id` is always derived server-side from the logged-in user's `employee_id`.
- Invoice edits cannot overwrite salesperson attribution.
- Salesperson performance endpoint reports invoice count, sales amount, target, achievement percentage, and target balance.
- HSN is displayed on printed sales invoices.

### Incentive / Reward / Payroll
- Employee target fields: sales, production, bidding, recovery, overtime hours, job/task.
- Central Incentive & Reward Rules screen under Settings.
- Trigger evaluation for Sales, Production, Bidding, Payment Recovery, Overtime, and Job/Task completion.
- Immediate reward modal in the UI when a target unlocks an incentive.
- `employee_incentives` stores each unlocked reward.
- Payroll automatically pulls pending incentives for the payroll month, adds `incentive_amount` to gross/net calculation, and marks those rewards as paid against the payroll record.
- Payslip includes Incentives / Rewards as a separate line item.
- Job/Task allotment UI is included in Incentive & Reward Rules settings.

### Customer Loyalty
- Customer purchase target and reward configuration fields.
- Cumulative invoiced purchase amount is checked automatically.
- `reward_eligible` is refreshed after sales changes.
- Customer loyalty status is available through `/api/customer-loyalty/:customerId`.
- Sales invoice customer selection displays loyalty progress/eligibility.

## Main new/updated API endpoints

- `GET /api/reports/gst-summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/reports/salesperson-performance`
- `GET /api/customer-loyalty/:customerId`
- `POST /api/customer-loyalty/:customerId/refresh`
- Existing `POST /api/purchases/:id/receive` now performs the classified inventory receipt.
- Existing incentive endpoints are retained and extended through the same `/api` router.

## Database migration strategy

Migrations use the package's existing `ensureColumn()` pattern and SQLite-safe table migration already present for Purchase Orders. They are executed automatically when the application starts, so existing databases are upgraded without requiring a manual schema rebuild.

Added/extended fields include:
- `products.hsn_code`
- `sales_items.hsn_code`
- `sales_invoices.salesperson_id` (existing migration retained)
- employee target fields (existing migration retained)
- `payroll.incentive_amount`
- customer loyalty reward configuration fields
- supporting indexes for salesperson/GST/incentive tracking

## Verification

The following JavaScript files pass `node --check` syntax validation:
- `db.js`
- `routes/transactions.js`
- `routes/incentives.js`
- `routes/reports.js`
- `routes/importExport.js`
- `public/app.js`

`npm ci --ignore-scripts --no-audit --no-fund` could not complete in the build environment because the package-install process timed out; therefore a full dependency/runtime launch test was not claimed as successful.
