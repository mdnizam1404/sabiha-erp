# v5.1.1 — fix: start-up error  PgError: column "created_at" does not exist

**Cause:** the PostgreSQL server already had a database named `sabiha_platform` (from an earlier
version or experiment) containing a table with the same name as one of the new platform tables
(e.g. `company_requests`) but a different layout. `CREATE TABLE IF NOT EXISTS` skipped it, and the
next step (an index on `created_at`) failed.

**Fix (lib/platform.js):** at start-up every platform table is checked against the layout the code
needs. A table with a different layout is RENAMED (e.g. `company_requests_legacy_20260930...`, all its
data kept — nothing is deleted) and a correct table is created. Safe to start repeatedly. If a table
still cannot be prepared, the start-up window now names the table and tells you what to do.

Nothing needs to be cleaned up by hand. Existing companies and their data are not touched.

Verified: reproduced the exact error, fixed it; leftover tables with their own indexes; repeated
start-ups; upgrade from a v5.0.x platform database (existing companies kept, new tables added).
Full suites again: 66 platform, 31 UI, 75 regression — all passing.
