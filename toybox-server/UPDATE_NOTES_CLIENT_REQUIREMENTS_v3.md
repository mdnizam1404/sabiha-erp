SABIHA ERP Client Requirements Update v3

1. Future Orders now support product line items, quantity, automatic amount from current product sale rate, and salesperson auto-derived from the logged-in employee.
2. Open orders can be explicitly marked Completed or Lost. Completed orders can then be converted to a sales invoice; conversion pre-fills the order products and quantities.
3. Finished Product history title now explicitly covers Production, Purchase and Sales history, with purchase status shown.
4. Central Loyalty reward settings remain in Company/HR Settings. Once a customer crosses their purchase target, the central reward becomes pending and is automatically applied to the next new sales invoice server-side, then marked redeemed so it is not repeatedly applied.
5. Salesperson Performance is restricted to the logged-in salesperson when the role is SALES_PERSON; administrators/managers continue to see the broader performance view.
6. All changes preserve the existing Node/Express/SQLite architecture and use additive migrations.
