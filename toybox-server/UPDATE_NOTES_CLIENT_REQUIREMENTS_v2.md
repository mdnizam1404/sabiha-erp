# SABIHA ERP — Client Requirements Update v2

This update preserves the existing Node.js + Express + SQLite + single-page frontend architecture.

## Changes

1. Purchase Form
   - Added Amount Paid Now and Payment Mode.
   - Initial payment is stored as a linked supplier payment with source `PURCHASE_FORM`.
   - Purchase payable = taxable amount + GST.
   - Purchase list, supplier balance, supplier ledger and supplier due report now include GST in the supplier payable.
   - Purchase form automatically shows supplier current balance and purchase balance.
   - Manual later supplier payments remain separate and are protected from accidental overwrite.

2. Finished Product Inventory History
   - Clicking a finished-product name now shows Production History, Purchase History and Sales History.
   - Purchase quantity, supplier, taxable amount, GST and total are shown.

3. Central Customer Loyalty Reward
   - Added `company_settings.loyalty_reward_type` and `company_settings.loyalty_reward_value`.
   - Reward percentage/fixed amount is centrally configured in Settings -> Incentive & Reward Rules.
   - Customer purchase target remains configurable per customer.
   - Customer loyalty calculation now uses the central reward setting.
   - The settings API supports safe partial updates without wiping unrelated company settings.

4. Incentive Engine
   - Sales, Production, Recovery, Overtime and Job/Task response payloads expose unlocked incentives.
   - Bulk overtime attendance now evaluates incentives for every selected employee.
   - Bidding conversion rewards are surfaced together with any Sales reward unlocked by the linked invoice.
   - If payroll for the employee/month already exists, a newly unlocked incentive is immediately appended to payroll.
   - Otherwise pending incentives are picked up automatically when payroll is generated.

5. Login / Approval
   - Login now trims User ID and treats User IDs case-insensitively.
   - Approved status is checked case-insensitively.
   - Admin approval reactivates a previously deactivated user.
   - User administration now allows direct linking of a login to an Employee record, required for salesperson and employee incentive attribution.

## Compatibility

- No replacement framework or database engine was introduced.
- Existing tables are extended with additive `ensureColumn` migrations.
- Existing customer reward columns remain for backward compatibility but central company settings are now authoritative for reward calculation.

## Validation performed

- All JavaScript files in the package pass `node --check` syntax validation.
- Live npm dependency installation could not be completed in the sandbox because DNS/network access to registry.npmjs.org is unavailable (`EAI_AGAIN`). Therefore a full live Express/SQLite runtime test is not claimed here.
