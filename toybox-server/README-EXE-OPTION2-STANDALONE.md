# NOT AVAILABLE IN v13

The single-file .exe options described in this file were built for the SQLite version.
v13 runs on PostgreSQL through a background worker thread that the `pkg` packager cannot run.
Use `start.bat`, or run it as a Windows service (see POSTGRESQL_SETUP_v13.md → "Running permanently").

---
(Original v11 text kept below for reference)

# Option 2 — Full: Standalone .exe (bundles Node.js itself)

**What this gives you:** a `SABIHA-ERP.exe` that works on any Windows PC
**without installing Node.js there at all**. You copy one folder, double-click
one file, done. This is the "real" standalone .exe experience.

**Trade-off:** it's more powerful but more fragile to build, because
SABIHA ERP uses a native database engine (`better-sqlite3`) that isn't
plain JavaScript — bundling native code into an .exe is the single trickiest
part of this whole approach. I've already made the code changes needed to
support it (see "What I changed" below), but you should build and test it
yourself before relying on it, since I can't run a Windows .exe from here to
verify it.

## Steps (on your Windows PC — the one with internet & Node.js already set up)

1. Make sure you've already run `install.bat` once in this folder (so
   `node_modules` exists).

2. Double-click **`build-exe.bat`**. It will:
   - Install a packaging tool called `pkg` (one-time, needs internet)
   - Bundle Node.js + your app + the database engine into one `.exe`
   - Put the result in a new `dist` folder

3. When it finishes, you'll have:
   ```
   dist\
     SABIHA-ERP.exe
     data\        (empty for now — fills up once you start using it)
     backups\
   ```

4. **Test it now, on this same PC first:** double-click
   `dist\SABIHA-ERP.exe`, open http://localhost:3000, log in, add a test
   customer, close it, reopen it, and check the test customer is still
   there. That confirms the database is writing correctly next to the exe.

5. Once confirmed, copy the **entire `dist` folder** (not just the .exe —
   it needs to sit next to its own `data` folder) to any other Windows PC.
   No Node.js install needed there. Double-click `SABIHA-ERP.exe` and go.

## What I changed to make this work

By default, a file bundled into a `pkg` executable lives inside a read-only
virtual filesystem — great for your app's code and the `public/` folder
(those are read-only anyway), but **your live database can't be written
there**. I updated `db.js` and `server.js` so that when running as a built
`.exe` (detected automatically), the `data/`, `backups/`, and `.env` files
are created next to the real `.exe` file on disk instead — exactly the
`dist` folder layout above. You don't need to configure anything for this;
it's automatic.

## If the build fails

The most likely failure point is `better-sqlite3`'s native file not being
found or not matching the target Node version. If `build-exe.bat` errors
out:

- Confirm this file exists first:
  `node_modules\better-sqlite3\build\Release\better_sqlite3.node`
  If it's missing, delete the `node_modules` folder and run `install.bat`
  again before retrying.
- Try the actively-maintained fork instead, which fixes several native-module
  bugs the original `pkg` project (now archived) never got:
  ```
  npm uninstall pkg
  npm install --save-dev @yao-pkg/pkg
  npx @yao-pkg/pkg . --targets node18-win-x64 --output dist\SABIHA-ERP.exe
  ```
- As a fallback that always works: use **Option 1**
  (`README-EXE-OPTION1-SIMPLE.md`) instead — it has none of this risk,
  at the cost of still needing Node.js installed on each PC.

## Updating the app later

If I send you an updated `app.js`, `server.js`, etc. later, you'll need to
run `build-exe.bat` again to get a new `.exe` with those changes — the old
`.exe` won't update itself. Your data stays safe either way, since it lives
in `dist\data`, separate from the exe file itself.
