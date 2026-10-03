# SABIHA ERP v13 — PostgreSQL setup guide

From v13 the application runs on **PostgreSQL** (the old SQLite file is no longer used at runtime).
All screens, reports, invoices, payroll, incentives, SMS OTP and role-based access work exactly as before.

---
## 1. Install PostgreSQL (once)

**Windows**
1. Download the installer from https://www.postgresql.org/download/windows/ (version 14 or newer; 16 recommended).
2. Accept the defaults. When asked, choose a password for the `postgres` user — **write it down**.
3. Keep port `5432` unless you have a reason to change it.

**Linux (Ubuntu/Debian):** `sudo apt install postgresql` then `sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'yourpassword';"`

## 2. Install and configure SABIHA ERP

1. Install Node.js 18+ (https://nodejs.org, "LTS").
2. Run `install.bat` (Windows) / `./install.sh` (Linux) — installs the dependencies.
3. Run `start.bat` once. It creates a file called **`.env`**, then stops with a message if it cannot reach PostgreSQL.
4. Open `.env` in Notepad and set:
   ```
   PGHOST=localhost
   PGPORT=5432
   PGDATABASE=sabiha_erp
   PGUSER=postgres
   PGPASSWORD=the-password-you-chose
   ```
   (Or a single line: `DATABASE_URL=postgresql://postgres:password@localhost:5432/sabiha_erp`)
5. Run `start.bat` again. **The database and all tables are created automatically.**
   First login: user `ADMIN`, password `admin` — change it immediately (Users → Reset Password).

If something is wrong, the start-up window tells you exactly what (PostgreSQL not running, wrong password, ...).

## 3. Migrating your old data (SQLite → PostgreSQL)

Only needed if you already use v11/v12 and want to keep your data.

1. Copy your old `erp.sqlite` file into the `data` folder (it is in the old app's `data` folder).
2. Make sure `.env` is configured (step 2.4) and PostgreSQL is running.
3. Double-click **`migrate-sqlite-to-postgresql.bat`** (or run `node migrate-sqlite-to-postgresql.js`) and type `YES`.
4. The tool prints a table with the row count of every table in SQLite and PostgreSQL — they must match.
5. Start the app with `start.bat`.

Notes
* Your SQLite file is opened **read-only** and is never changed — keep it as a backup.
* The tool **replaces** everything in the target PostgreSQL database, so run it on a new/empty database.
* The migration helper needs the package `better-sqlite3` (installed automatically by the .bat file). On Windows this
  can require "Visual Studio Build Tools"; if `npm install better-sqlite3` fails, install those tools
  (https://visualstudio.microsoft.com/visual-cpp-build-tools/, "Desktop development with C++") or run the migration on any
  computer that has them, then move the PostgreSQL data with `pg_dump`/`pg_restore`.
* Fields that were saved as blank text in numeric columns (e.g. an empty "Credit Limit") become empty (NULL) — they behave as 0.

## 4. Backups

* **In the app:** Audit & Backup → *Download Backup* gives a complete `.json` backup; *Restore from Backup* replaces all data in one
  all-or-nothing step (a safety copy of the current data is saved to the `backups` folder first). No restart needed.
* **Recommended for production, in addition:** schedule PostgreSQL's own tool, e.g. daily
  `pg_dump -U postgres -F c -f D:\backups\sabiha_%date%.dump sabiha_erp`
  (Windows Task Scheduler) and restore with `pg_restore -U postgres -d sabiha_erp --clean file.dump`.
* Old `.sqlite` backups cannot be uploaded to the Restore screen — import them with the migration tool (section 3).

## 5. Running permanently (instead of the old .exe)

The single-file `.exe` is not available in v13. To have SABIHA ERP start with the computer:
```
npm install -g pm2 pm2-windows-startup
pm2 start server.js --name sabiha-erp
pm2 save
pm2-startup install
```
(Linux: `pm2 startup`.) Make sure the PostgreSQL service is set to start automatically (it is by default).

## 6. Configuration reference (.env)

| Setting | Meaning | Default |
|---|---|---|
| `PGHOST` / `PGPORT` | Where PostgreSQL runs | `localhost` / `5432` |
| `PGDATABASE` | Database name (auto-created) | `sabiha_erp` |
| `PGUSER` / `PGPASSWORD` | Login | `postgres` / *(empty)* |
| `DATABASE_URL` | One-line alternative to the five above | — |
| `PGSSL` | `true` for cloud PostgreSQL that requires SSL | `false` |
| `PG_AUTO_CREATE_DB` | Create the database automatically if missing | `true` |
| `PG_QUERY_TIMEOUT_MS` | Give up on a single query after this long | `120000` |

## 7. Troubleshooting

| Message | Fix |
|---|---|
| `ECONNREFUSED` / "PostgreSQL is not running" | Start the *postgresql-x64-NN* service (Windows → Services), check `PGPORT` |
| "Login was rejected" | Wrong `PGUSER` / `PGPASSWORD` in `.env` |
| "permission to create the database" | Create the database yourself in pgAdmin (`sabiha_erp`) or use a user with CREATEDB |
| "Could not install helper functions" | The user must own the database (or have CREATE on schema public) |
| Forgot the ADMIN password | `node reset-admin-password.js NewPassword` |

## 8. How it works (for developers)

The routes still use the synchronous `db.prepare(sql).get/all/run()` and `db.transaction()` API. `lib/pgsync.js` runs the
`pg` driver in a worker thread and blocks on a shared-memory flag for each reply, so behaviour (one connection, strictly
ordered statements, atomic transactions) matches the previous SQLite layer. `lib/sqlcompat.js` translates the few
SQLite-specific constructs (`?` placeholders, `INSERT OR IGNORE`, `strftime`, `date(x,'-1 day')`, `LIKE` case-insensitivity,
`AUTOINCREMENT`-style ids, camelCase column aliases, forward-referenced tables). Errors keep their familiar text
(`UNIQUE constraint failed: customers.code`). If you write new SQL: PostgreSQL requires every non-aggregated selected column
to appear in `GROUP BY` (or group by the table's primary key).
