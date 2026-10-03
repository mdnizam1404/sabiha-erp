# SABIHA ERP — Zod Validation

Zod is already a runtime dependency and is now used as the server-side validation boundary for critical write APIs.

Validated areas:
- Authentication and admin user management
- Products (HSN-compatible existing schema) and purchase orders
- Future orders and product line items
- Sales invoices and line items
- Customer receipts / recovery
- Production entries
- Incentive rules and employee tasks
- Payroll creation and payroll payments

The middleware parses/coerces safe numeric form values, rejects invalid enums/ranges/required fields, and returns HTTP 400 with field-level messages. Existing extra payload fields are preserved with `.passthrough()` to avoid changing the existing frontend/database architecture.

Install dependencies with `npm ci`, then run `npm run validate` to verify the Zod modules load.
