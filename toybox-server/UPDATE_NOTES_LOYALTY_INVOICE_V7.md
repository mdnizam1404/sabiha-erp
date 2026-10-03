# SABIHA ERP — Sales Invoice Loyalty/Incentive Presentation Update v7

## Requested change
Customer loyalty/incentive value is now applied silently to the sale calculation and is shown only once in the final invoice totals as:

**Incentive / Loyalty Amount**

## Sales invoice behavior
- The customer/invoice header no longer displays the loyalty reward amount or reward eligibility details.
- The invoice totals show the original **Sub Total** from item amounts.
- If a loyalty/incentive reward is available, it is deducted immediately below Sub Total as **Incentive / Loyalty Amount**.
- **Taxable Amount** is the subtotal after the deduction.
- GST is calculated on the reduced taxable amount.
- Grand Total is calculated from the reduced taxable amount plus GST.
- The reward is still redeemed server-side only after the invoice is successfully created.

## Printed invoice / PDF
The same presentation is used in browser printing and generated PDF:

Sub Total
- Incentive / Loyalty Amount
= Taxable Amount
+ GST
= Grand Total

No separate loyalty/reward information is printed elsewhere on the invoice.

## Barcode sale
Barcode sales use the same loyalty calculation and bottom-line presentation. Customer loyalty is refreshed when the barcode-sale customer changes.

## Architecture
No architecture change. Existing Node/Express/SQLite routes, schema and frontend structure are preserved.
