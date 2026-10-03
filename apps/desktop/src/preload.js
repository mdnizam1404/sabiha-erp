const { contextBridge, ipcRenderer } = require('electron');
// offline.js checks this flag: the desktop app handles screen caching itself.
contextBridge.exposeInMainWorld('SABIHA_DESKTOP', true);
contextBridge.exposeInMainWorld('sabihaDesktop', {
  getServer: () => ipcRenderer.invoke('server:get'),
  testServer: (url) => ipcRenderer.invoke('server:test', url),
  saveServer: (url) => ipcRenderer.invoke('server:save', url),
});
