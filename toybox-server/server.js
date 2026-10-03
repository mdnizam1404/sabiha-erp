// ============================================================================
// server.js — SABIHA ERP main application entry point
// ============================================================================

// --- crash safety net -------------------------------------------------------
// Two different situations call for two different responses, both handled
// by a single uncaughtException listener below (registered once, so there's
// no ambiguity about which one "wins"):
//  1. Packaged .exe, double-clicked by one person: if something goes wrong
//     at STARTUP, the .exe's own console window would otherwise flash an
//     unreadable error and vanish the instant Node exits (nothing launched
//     this console, so Windows closes it immediately). So: show the error
//     clearly, wait for the person to press Enter, then exit.
//  2. Already running and serving requests (the normal case for both the
//     .exe and `npm start`): a single unexpected error in one request
//     (or a stray unhandled promise rejection) shouldn't take the whole
//     app down for everyone else — especially not if that error was
//     deliberately triggered by a flood of bad requests. Log it loudly and
//     keep serving. (Note this is a safety net, not a replacement for the
//     gold-standard answer to "don't go down under load": running behind a
//     process manager — pm2, systemd, or a Windows service wrapper — that
//     auto-restarts the app if it ever does exit unexpectedly.)
// ---------------------------------------------------------------------------
let serverIsUp = false;
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED PROMISE REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  if (!serverIsUp && process.pkg) {
    console.error('\n[FATAL ERROR] SABIHA ERP could not start:\n');
    console.error(err && err.stack ? err.stack : err);
    console.error('\nIf this mentions "node_modules" or "pg", make sure the');
    console.error('whole "dist" folder was copied to this PC, not just the .exe file.');
    console.error('\nPress Enter to close this window...');
    try { require('fs').readSync(0, Buffer.alloc(1), 0, 1, null); } catch (e) {}
    process.exit(1);
  }
  console.error('[UNCAUGHT EXCEPTION] — the app is continuing to run, but please report this:', err);
});

// --- tiny built-in .env loader (no extra dependency needed) ---------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Same reasoning as db.js: inside a pkg-built .exe, __dirname is a read-only
// virtual snapshot, so config that needs to be written (a fresh .env) must
// live next to the real executable on disk instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const envPath = path.join(APP_DIR, '.env');
const isFirstRun = !fs.existsSync(envPath);
if (isFirstRun) {
  // First run on a fresh install — create .env automatically with a random
  // secret so the app works out of the box with just `npm install && npm start`
  // (or, for the standalone .exe, just by double-clicking it).
  const examplePath = path.join(__dirname, '.env.example');
  let template = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : 'PORT=3000\nJWT_SECRET=CHANGE_THIS_TO_A_LONG_RANDOM_SECRET\nCOMPANY_NAME=SABIHA ERP\n';
  const randomSecret = crypto.randomBytes(32).toString('hex');
  const randomPlatformKey = crypto.randomBytes(32).toString('hex');
  template = template.replace(/JWT_SECRET=.*/, `JWT_SECRET=${randomSecret}`);
  template = template.replace(/PLATFORM_ADMIN_KEY=.*/, `PLATFORM_ADMIN_KEY=${randomPlatformKey}`);
  fs.writeFileSync(envPath, template);
  console.log('First run detected — created .env with a secure random JWT secret.');
}
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  });
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { requireAuth, planGate } = require('./auth');
const { cleanupAuditLogs } = require('./db');
const { mountMasterCrud } = require('./routes/crud');
const transactionsRouter = require('./routes/transactions');
const reportsRouter = require('./routes/reports');
const { router: assetsRouter } = require('./routes/assets');
const { router: loansRouter } = require('./routes/loans');
const { router: importExportRouter } = require('./routes/importExport');
const { router: futureOrdersRouter } = require('./routes/futureOrders');
const { router: investorReportRouter } = require('./routes/investorReport');
const { router: incentivesRouter } = require('./routes/incentives');
const { router: adminRouter, publicRouter: adminPublicRouter } = require('./routes/admin');
const syncRouter = require('./routes/sync');
const platformRouter = require('./routes/platform');
const platformLib = require('./lib/platform');
const scheduler = require('./lib/scheduler');

const app = express();
// Needed so rate limiting and audit logs see the real visitor IP instead of
// a reverse proxy's IP — only when actually deployed behind one (see
// TRUST_PROXY in .env.example). Left off by default for a direct install.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Security headers. CSP is scoped to this app's actual needs rather than
// left fully open: only same-origin scripts/styles/fonts, plus the couple
// of things the UI legitimately relies on (data: URIs for the generated
// UPI QR code and an uploaded company logo). Inline event handlers
// (onclick="...") are used throughout the existing UI, which requires
// 'unsafe-inline' for script-src — removing that would mean rewriting
// every onclick in the app to addEventListener, which is a much larger
// follow-up refactor, not a config change. The main defense against
// injected scripts here is the input sanitization below (stored data can
// never contain a "<" to form a tag in the first place); CSP is
// defense-in-depth on top of that, not the only layer.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // Helmet's default CSP separately blocks inline event-handler
      // attributes (onclick="...") via script-src-attr, even when
      // script-src itself allows 'unsafe-inline' — this app's UI is built
      // almost entirely on onclick="...", so without this override every
      // button and link in the app would silently stop working.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(compression());

// CORS — same-origin only by default (the frontend is served by this same
// app, so no cross-origin calls are needed out of the box). Only opens up
// to other origins if ALLOWED_ORIGINS is explicitly set, e.g. because the
// frontend is hosted separately.
// The Android / iOS app (Capacitor) calls the API from these fixed local origins, so they are always allowed.
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost'];
const allowedOrigins = [...APP_ORIGINS, ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, origin ? true : false);
    cb(null, false); // not allowed: no CORS headers are sent (the browser blocks it); no server error
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Idempotency-Key'],
  exposedHeaders: ['X-Plan-Warning', 'X-Idempotent-Replay'],
}));

// Rate limiting — caps how many requests a single IP can make in a 15-
// minute window, so a traffic flood (accidental or a deliberate DoS
// attempt) gets a fast, cheap 429 response instead of piling up work that
// could slow the app down for everyone else. A separate, much stricter
// limiter sits in front of /auth/login specifically — this is IP-based and
// works alongside (not instead of) the per-User-ID 5-attempts/24-hour
// lockout already in place: that one blocks a specific account regardless
// of IP, this one blocks a flood of attempts regardless of which account
// they're aimed at.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests from this device — please wait a few minutes and try again.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts from this device — please wait a few minutes and try again.' },
});

// Sanitize every incoming JSON request body — strips "<" and ">" from all
// string fields (recursively, including inside arrays) before anything
// touches the database. Since no user-facing field in this app is meant to
// contain HTML, this means a malicious value like `<script>...</script>`
// typed into, say, a customer name can never be stored as an actual tag —
// closing off stored-XSS at the point data comes in, rather than relying
// on every one of the hundreds of places the app later renders that data
// back out to remember to escape it correctly. The characters are removed
// outright (not converted to &lt;/&gt; entities) because this app also
// pours the same stored strings straight into form <input> .value when
// editing a record — entities would render correctly via innerHTML but
// show up as literal "&lt;" text in an input box, which would look broken.
function sanitizeValue(v) {
  if (typeof v === 'string') return v.replace(/[<>]/g, '');
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = sanitizeValue(v[k]); return v; }
  return v;
}
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') sanitizeValue(req.body);
  next();
}

app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '40mb' })); // covers base64 logo uploads and database restores without leaving the door open to unbounded request bodies
app.use(sanitizeBody);
app.use(express.static(path.join(__dirname, 'public')));

const api = express.Router();
api.use(apiLimiter);

// Public routes (no auth required) — login, self-registration, company profile for the login screen
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_LIMIT_PER_HOUR) || 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-up attempts from this device — please try again later.' },
});
api.use('/auth/login', loginLimiter);
api.use('/auth/register', registerLimiter);
// Platform owner (super admin) API + public company-request endpoints — separate from company logins
api.use('/platform', platformRouter);
api.use('/', adminPublicRouter);

// Everything below requires a valid, approved login
api.use(requireAuth);
api.use(require('./lib/idempotency').idempotency); // safe replay of writes made while offline
api.use(planGate); // modules the company's plan does not include

// Offline/mobile synchronization endpoints. These execute inside the authenticated
// tenant AsyncLocalStorage context, so every query is company-isolated.
api.use('/', syncRouter);

// Simple master data — generic CRUD
mountMasterCrud(api, { table: 'employees', path: 'employees', order: 'name', codePrefix: 'EMP-' });
mountMasterCrud(api, { table: 'customers', path: 'customers', order: 'name', codePrefix: 'CUST-', permission: 'customersSales' });
mountMasterCrud(api, { table: 'suppliers', path: 'suppliers', order: 'name', codePrefix: 'SUP-' });
mountMasterCrud(api, { table: 'raw_materials', path: 'raw-materials', order: 'name', codePrefix: 'RM-' });

// Business-logic-heavy modules (production, sales, purchases, payroll, etc.)
api.use('/', require('./routes/plan')); // My Plan page + plan purchase / renewal requests
api.use('/', transactionsRouter);

// Customer returns (credit notes) and supplier returns (debit notes)
api.use('/', require('./routes/returns'));

// Fixed assets, depreciation, and deferred tax
api.use('/', assetsRouter);

// Loans — disbursements, repayments, adjustments
api.use('/', loansRouter);

// Data import/export — Excel templates + bulk import for master data & transactions
api.use('/', importExportRouter);

// Future Orders — expected/pipeline business, feeds the investor presentation
api.use('/', futureOrdersRouter);

// One-click investor/shareholder presentation (.pptx)
api.use('/', investorReportRouter);

// Incentive & Reward engine — rules, ledger, job/task allotment
api.use('/', incentivesRouter);

// Reports, dashboard, ledgers, accounts, audit log
api.use('/reports', reportsRouter);

// Protected admin routes (me, users, settings write, backup, invoice PDF)
api.use('/', adminRouter);

app.use('/api', api);
// Any /api/* path not matched by a route above — respond with JSON, not the
// SPA's index.html (which is what the catch-all below would otherwise send
// for a typo'd or unknown API endpoint).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// SPA fallback — everything else serves the frontend shell
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler — never leak stack traces to the client
app.use((err, req, res, next) => {
  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({ error: 'This record is linked to other records (for example receipts, payments or stock entries) and cannot be deleted or changed this way. Remove or reassign the linked records first.' });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'That value already exists — it must be unique. (' + err.message.replace('UNIQUE constraint failed: ', '') + ')' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  serverIsUp = true;
  console.log(`\n  🧸  SABIHA ERP running at http://localhost:${PORT}`);
  console.log(`  First-run login → username: ADMIN   password: admin\n`);

  // --- desktop shortcut + auto-open (packaged .exe only) -------------------
  // A double-clicked .exe should behave like a normal desktop app: land on
  // the Desktop with an icon, and open straight to the app in a browser,
  // without the person needing to know what "localhost:3000" means.
  if (process.pkg) {
    createDesktopShortcutIfMissing();
    // Every run: open the app itself, so double-clicking the exe is enough.
    openInBrowser(`http://localhost:${PORT}`);
    // First run only: also reveal the data folder once, so the person knows
    // where their database lives (useful for backups) without it popping
    // up and getting in the way on every subsequent launch.
    if (isFirstRun) openFolder(path.join(APP_DIR, 'data'));
  }

  scheduler.start(); // nightly backups, expiry reminder emails, housekeeping

  // Audit log retention — delete anything older than the configured window
  // (default 3 days) once at startup, then on an hourly timer, so the log
  // never grows unbounded. Cheap enough to run this often; audit_logs is a
  // small table by design once this is in place.
  try { cleanupAuditLogs(); } catch (e) { console.error('[audit log cleanup]', e); }
  setInterval(() => {
    try { cleanupAuditLogs(); } catch (e) { console.error('[audit log cleanup]', e); }
  }, 60 * 60 * 1000);
});
// Connection-level timeouts — mitigate "slow-loris" style attacks, where a
// connection deliberately trickles data in very slowly to tie up server
// resources. Node's own defaults here are generous enough to be exploitable;
// these tighten them to values still comfortable for real traffic (large
// backup/restore uploads included) but no longer comfortable for a
// deliberately-slow connection.
server.headersTimeout = 30 * 1000;   // time allowed to finish sending request headers
server.requestTimeout = 5 * 60 * 1000; // time allowed to finish sending the whole request (generous, for large restores)
server.keepAliveTimeout = 65 * 1000; // idle keep-alive connections are closed after this

function openInBrowser(url) {
  try { require('child_process').exec(`start "" "${url}"`); } catch (e) { /* non-fatal */ }
}
function openFolder(folderPath) {
  try { require('child_process').exec(`explorer "${folderPath}"`); } catch (e) { /* non-fatal */ }
}
// Creates a "SABIHA ERP" shortcut on the Windows Desktop pointing at this
// .exe, the first time it's missing. Batch files can't create .lnk files
// directly, so this generates a tiny VBScript (the standard, dependency-free
// way to do this on Windows) and runs it once via the built-in `cscript`.
//
// Two things that commonly break a naive version of this, both handled here:
//  1. Many Windows PCs today have their Desktop folder redirected by OneDrive
//     ("Known Folder Move"), so it is NOT simply "<home>\Desktop". Rather
//     than guess, the VBScript asks Windows itself via
//     WshShell.SpecialFolders("Desktop"), which always resolves correctly.
//  2. A double-clicked .exe can run with a stripped-down PATH, so `cscript`
//     may not be found by name alone — this calls it by its full path in
//     the Windows system folder instead of relying on PATH.
function createDesktopShortcutIfMissing() {
  try {
    const os = require('os');
    const { execFileSync } = require('child_process');
    const exePath = process.execPath;
    const exeDir = path.dirname(exePath);
    const vbs = [
      'Set oWS = WScript.CreateObject("WScript.Shell")',
      'sDesktop = oWS.SpecialFolders("Desktop")',
      'sLinkFile = sDesktop & "\\SABIHA ERP.lnk"',
      'If Not CreateObject("Scripting.FileSystemObject").FileExists(sLinkFile) Then',
      '  Set oLink = oWS.CreateShortcut(sLinkFile)',
      `  oLink.TargetPath = "${exePath.replace(/"/g, '""')}"`,
      `  oLink.WorkingDirectory = "${exeDir.replace(/"/g, '""')}"`,
      `  oLink.IconLocation = "${exePath.replace(/"/g, '""')}"`,
      '  oLink.Description = "SABIHA ERP - Toy Manufacturing Suite"',
      '  oLink.Save',
      '  WScript.Echo "created"',
      'Else',
      '  WScript.Echo "already-exists"',
      'End If',
    ].join('\r\n');
    const vbsPath = path.join(os.tmpdir(), `sabiha-shortcut-${Date.now()}.vbs`);
    fs.writeFileSync(vbsPath, vbs);
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const cscriptPath = path.join(systemRoot, 'System32', 'cscript.exe');
    const cscriptCmd = fs.existsSync(cscriptPath) ? cscriptPath : 'cscript'; // fall back to PATH if the usual location is unexpectedly different
    const output = execFileSync(cscriptCmd, ['//nologo', vbsPath], { encoding: 'utf8' });
    fs.unlinkSync(vbsPath);
    if (output.includes('created')) console.log('  Created a "SABIHA ERP" shortcut on the Desktop.');
  } catch (e) {
    // Never let shortcut creation stop the server from running. Some
    // antivirus/security software blocks a freshly-built, unsigned .exe from
    // launching helper scripts like this — that's fine, there's a manual
    // fallback for exactly this case (see the notes below).
    console.log('  (Could not create a Desktop shortcut automatically.)');
    console.log('  -> In the same folder as this .exe, double-click "Create Desktop Shortcut.bat" to add it manually.');
  }
}
