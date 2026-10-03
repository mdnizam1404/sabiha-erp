# v5.0.1 — startup crash and multi-company data isolation

## 1. Startup crash: "ReferenceError: syncRouter is not defined"
`server.js` mounted `syncRouter` (offline/mobile sync API) but never imported it.
Fix: added `const syncRouter = require('./routes/sync');` in server.js.

## 2. Every company was reading/writing the DEFAULT company's database (critical)
Fixing #1 exposed this. `db.js` had tenant-aware routing (`activePg()`), but the query
runner, transactions, DDL, backup/restore and table-metadata code still used the fixed
default connection. A second company could log in, but all its data went to the
default company's database, and its own database stayed empty.
Fix (db.js): all query execution now goes through `activePg()`, and the
"tables with an id column" cache is kept per company database.

## Verified
* Second company provisioned (`provision-company.js`), logs in with its own password, sees its own
  empty data; a customer created in one company is invisible in the other.
* Regression on PostgreSQL 16: 75 checks (write/edit/delete flows, reports, backup/restore, role access,
  sync device registration/status): 75 passed, 0 failed.
