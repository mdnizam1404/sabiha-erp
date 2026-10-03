# NOT AVAILABLE IN v13

The single-file .exe options described in this file were built for the SQLite version.
v13 runs on PostgreSQL through a background worker thread that the `pkg` packager cannot run.
Use `start.bat`, or run it as a Windows service (see POSTGRESQL_SETUP_v13.md → "Running permanently").

---
(Original v11 text kept below for reference)

# Option 1 — Simple: Wrap start.bat into an .exe icon

**What this gives you:** a `SABIHA-ERP.exe` you (or anyone) can double-click.
Node.js must still be installed on the PC first (same as before) — this
option just replaces the black `start.bat` icon with a proper program icon.
It's the fastest and most reliable of the two options.

**What this does NOT do:** it does not remove the need for Node.js, and it
does not bundle the app into one file — it's a thin wrapper around
`start.bat`, so keep it in the same folder as `server.js`, `package.json`,
etc.

## Steps (about 2 minutes, on your Windows PC)

1. Download the free tool **Bat To Exe Converter** by Islam Adel:
   https://bat-to-exe-converter-x64.software.informer.com/
   (a well-known, widely used free tool — no coding involved, just a
   GUI). Install and open it.

2. In the tool:
   - **Batch file field:** click Browse and select `start.bat` from this
     folder.
   - **Save as:** choose a location — you can save the output as
     `SABIHA-ERP.exe` **directly inside this same `toybox-server` folder**,
     right next to `start.bat`. This matters — the exe just launches
     `start.bat`, which needs `server.js` and `node_modules` next to it.
   - **Icon (optional):** if you have a `.ico` file for your SABIHA ERP
     logo, set it here so the exe shows your branding instead of a generic
     icon. (You can convert your logo JPG to `.ico` for free at
     https://convertio.co/jpg-ico/ if you'd like one.)
   - Under **Options**, tick **"Invisible application"** = *No* (leave the
     console window visible — that's how you'll see server logs and know
     it's running; SABIHA ERP relies on that window staying open).

3. Click **Compile**. You now have `SABIHA-ERP.exe` in this folder.

4. Double-click it — it runs `npm start` behind the scenes and opens your
   browser to http://localhost:3000, exactly like `start.bat` did.

## Distributing this to another PC

Copy the **entire `toybox-server` folder** (not just the exe) to the other
PC. That PC still needs Node.js installed once (run `install.bat` there
first). Then `SABIHA-ERP.exe` works the same way.

If you'd rather the other PC not need Node.js at all, see **Option 2**
(`README-EXE-OPTION2-STANDALONE.md`) instead.
