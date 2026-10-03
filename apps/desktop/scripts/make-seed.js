// Copies the web app screens into ./seed so the installer already contains them
// (the very first start works even before the server has been reached).
const fs = require('fs'), path = require('path');
const src = path.resolve(__dirname, '..', '..', '..', 'toybox-server', 'public');
const dst = path.resolve(__dirname, '..', 'seed');
if (!fs.existsSync(src)) { console.error('Cannot find the web app folder at', src); process.exit(1); }
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, filter: (p) => !/platform\.(html|js)$/.test(p) });
console.log('Seed copied:', dst);
