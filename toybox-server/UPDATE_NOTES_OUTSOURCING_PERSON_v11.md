# SABIHA ERP — Outsourcing Person / Jobworker Fix v11

## Fixed
The **Outsourcing → Persons → Add Jobworker** operation has been repaired.

### What was wrong
The package was mounting `outsourcing/persons` through the generic master CRUD before the business-logic router. That generic `/:id` route also intercepted the more specific `/outsourcing/persons/:id/detail` URL, and the person form had no dedicated validated module endpoint.

### Changes
- Added dedicated Outsourcing Jobworker endpoints:
  - `GET /api/outsourcing/persons`
  - `GET /api/outsourcing/persons/:id`
  - `POST /api/outsourcing/persons`
  - `PUT /api/outsourcing/persons/:id`
  - `DELETE /api/outsourcing/persons/:id`
  - existing `GET /api/outsourcing/persons/:id/detail` now reaches the correct detail handler
- Added Zod validation for Jobworker name, phone, email, stage and default rate.
- Add Jobworker now returns a proper `201 Created` record.
- Edit Jobworker and soft-delete continue to preserve existing jobs/payments.
- Outsourcing Person API now checks the `Outsourcing` module permission.
- Existing database schema and overall package architecture remain unchanged.
- Existing frontend Persons form (`Add Jobworker`, Edit, Delete, detail view) is retained.

## Validation
JavaScript syntax checks passed for the modified server, transaction route and schema files.

A live SMS/WhatsApp or external-service test is not involved in this change.
