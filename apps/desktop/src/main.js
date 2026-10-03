// ============================================================================
// SABIHA ERP — desktop app (Windows / macOS) for office users.
// Shows the same application as the website, but:
//   * keeps a copy of the screens and the data you opened on this computer,
//   * keeps working with no internet, queueing what you save,
//   * syncs automatically with the main server when the connection returns.
// The window talks to a built-in bridge (src/proxy.js) through a private
// sabiha:// address, so the saved data keeps one stable home on this PC.
// ============================================================================
const { app, BrowserWindow, protocol, session, ipcMain, Menu, shell, dialog } = require('electron');
const PARTITION = 'persist:sabiha';
const path = require('path');
const fs = require('fs');
const { createProxy } = require('./proxy');

protocol.registerSchemesAsPrivileged([{ scheme: 'sabiha', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) { app.quit(); }

const userData = app.getPath('userData');
const cfgFile = path.join(userData, 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) { return {}; } };
const writeCfg = (c) => { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(c)); };
const seedDir = app.isPackaged ? path.join(process.resourcesPath, 'seed') : path.join(__dirname, '..', 'seed');
let win = null, proxy = null;

function normalizeUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const url = new URL(s);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use the secure address (https://…) of your server.');
  return url.origin;
}
function startProxy(serverUrl) { proxy = createProxy({ upstream: serverUrl, cacheDir: path.join(userData, 'web-cache'), seedDir: fs.existsSync(seedDir) ? seedDir : null }); }

function createWindow() {
  win = new BrowserWindow({ width: 1366, height: 860, minWidth: 1000, minHeight: 640, title: 'SABIHA ERP', backgroundColor: '#0B1330', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('sabiha://') && !url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  load();
  if (process.env.SABIHA_SELFTEST) selfTest(); // used by the automated checks; never set on a user's computer
}
async function selfTest() {
  const wc = win.webContents; const log = (...a) => console.log('[selftest]', ...a);
  wc.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) log('console-error:', msg.slice(0, 160)); });
  wc.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  const js = (code) => wc.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(code)) return true; } catch (_) { /* page not ready */ } await wait(300); } return false; };
  try {
    log('url', wc.getURL(), 'login form:', await waitFor("!!document.getElementById('loginBtn')"));
    log('desktop flag:', await js('window.SABIHA_DESKTOP === true'));
    await js("document.getElementById('loginCompany').value='DEFAULT';document.getElementById('loginUser').value='ADMIN';document.getElementById('loginPass').value='admin';document.getElementById('loginBtn').click()");
    log('signed in:', await waitFor("getComputedStyle(document.getElementById('content')).display!=='none' && !!ME"));
    await wait(5000);
    log('cached customers:', await js("OFF.getCache('/customers').then(c=>c?c.data.length:0)"));
    log('proxy offline switch next');
    proxy.setForcedOffline && proxy.setForcedOffline(true);
    await js("OFF.ping()"); await wait(500);
    log('offline read:', JSON.stringify(await js("api('/customers').then(d=>({n:d.length,stale:OFF.stale})).catch(e=>({err:e.message}))")));
    log('offline write:', JSON.stringify(await js("api('/customers',{method:'POST',body:JSON.stringify({name:'Desktop Offline Co',phone:'123'})}).catch(e=>({err:e.message}))")));
    log('pending:', await js('OFF.pending'));
    proxy.setForcedOffline && proxy.setForcedOffline(false);
    await js("OFF.ping().then(()=>OFF.sync())"); await wait(3000);
    log('pending after reconnect:', await js('OFF.pending'), 'failed:', await js('OFF.failed'));
  } catch (e) { log('error', e.message); }
  log('done'); setTimeout(() => app.quit(), 500);
}
function load() {
  const cfg = readCfg();
  if (!cfg.serverUrl) return win.loadFile(path.join(__dirname, 'setup.html'));
  win.loadURL('sabiha://app/');
}
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() }, { label: 'Change server address…', click: () => win && win.loadFile(path.join(__dirname, 'setup.html')) }, { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'About', click: () => dialog.showMessageBox({ title: 'SABIHA ERP Desktop', message: `SABIHA ERP Desktop ${app.getVersion()}`, detail: `Server: ${readCfg().serverUrl || '(not set)'}\nWorks offline and syncs automatically.` }) }] },
  ]));
}

ipcMain.handle('server:get', () => readCfg().serverUrl || '');
ipcMain.handle('server:test', async (_e, url) => {
  try {
    const origin = normalizeUrl(url);
    const r = await fetch(origin + '/api/version', { signal: AbortSignal.timeout(12000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.version) return { ok: false, error: 'That address does not look like a SABIHA ERP server.' };
    return { ok: true, url: origin, version: j.version };
  } catch (e) { return { ok: false, error: e.message === 'Enter the server address.' || /secure address/.test(e.message) ? e.message : 'Cannot reach that address. Check the spelling and your internet connection.' }; }
});
ipcMain.handle('server:save', (_e, url) => {
  const origin = normalizeUrl(url); const cfg = readCfg();
  if (cfg.serverUrl && cfg.serverUrl !== origin && proxy) proxy.clearCache();
  writeCfg({ ...cfg, serverUrl: origin }); startProxy(origin); if (win) setTimeout(load, 700);
  return true;
});

app.whenReady().then(() => {
  const cfg = readCfg(); if (cfg.serverUrl) startProxy(cfg.serverUrl);
  // the window uses its own persistent storage area, so the sabiha:// handler must be registered on that same session
  session.fromPartition(PARTITION).protocol.handle('sabiha', (request) => proxy ? proxy.handle(request) : new Response('Server not set', { status: 503 }));
  menu(); createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
