# SABIHA ERP v13 — PostgreSQL conversion (app version 4.0.0)

## What changed
* **The whole application now runs on PostgreSQL** (v12 only added a one-off data-copy tool; the app itself still used SQLite).
* New: `lib/pgsync.js`, `lib/pg-worker.js`, `lib/sqlcompat.js`; `db.js` rewritten for PostgreSQL (44 tables, 41 foreign keys, same schema, same seed data).
* New dependency `pg`. `better-sqlite3` is now **optional** (only the one-time migration tool uses it).
* `migrate-sqlite-to-postgresql.js` rewritten: copies a real SQLite file straight into the running schema (ids preserved, sequences re-synced, row counts compared).
* Backup / Restore now use a full **.json** logical backup and an atomic restore (no server restart needed). Old `.sqlite` backups: import with the migration tool.
* `reset-admin-password.js` now works against PostgreSQL.
* Duplicate / linked-record errors now return a clear message instead of "Something went wrong".
* Includes everything from v12.1: the SALES role access fix (import/export guard scoped to `/import`, live role/approval re-check on every request, approval creates missing permission rows).

## Fixed for PostgreSQL strictness
* 4 report queries selected a name without grouping by it (SQLite tolerated it, PostgreSQL does not) — investor report (top products / customers / produced products) and pipeline stage breakdown.
* Loan totals used camelCase result names (`principalPaid`, `interestPaid`, `totalRepaid`) that PostgreSQL would lower-case, breaking outstanding balance and the balance sheet — aliases are now preserved.

## Removed
* Single-file `.exe` build (`build-exe.bat`): the packager cannot run the PostgreSQL worker thread. Use `start.bat` or pm2 (see POSTGRESQL_SETUP_v13.md §5).

## How this was tested
* Fresh install on PostgreSQL 16: schema + seed created, restart is idempotent.
* All 81 read endpoints exercised; ~75 write/edit/delete flows (purchases incl. purchase orders, production, sales & receipts, payroll, advances, outsourcing, loans, assets, future orders, incentives, users/roles) including transaction rollback and per-row error handling.
* Backup → change data → restore round trip; inserts after restore (sequences) verified.
* **Parity test:** data created in the original SQLite v11 app was migrated to PostgreSQL (all 44 tables, row counts identical), then 76 read endpoints were compared response-by-response between the SQLite app and the PostgreSQL app: all identical except fields the UI left blank (empty text in SQLite → empty/NULL in PostgreSQL).

## Known limits
* Very large restores/backups are held in memory (fine for normal ERP sizes; for big databases use `pg_dump`).
* Queries are executed one at a time through a single connection (same as the SQLite version) — suited to a company-sized user base, not thousands of concurrent users.
