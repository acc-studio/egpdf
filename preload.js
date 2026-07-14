const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdfs'),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  savePdfDialog: (defaultName) => ipcRenderer.invoke('dialog:save-pdf', defaultName),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('file:write', p, data),
  setTitle: (t) => ipcRenderer.invoke('window:set-title', t),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onOpenPaths: (cb) => ipcRenderer.on('open-paths', (_e, paths) => cb(paths)),
  existsMany: (paths) => ipcRenderer.invoke('fs:exists-many', paths),
  fontFamilies: () => ipcRenderer.invoke('font:families'),
  fontPath: (name) => ipcRenderer.invoke('font:path', name),
  listPrinters: () => ipcRenderer.invoke('print:list'),
  printNow: (opts) => ipcRenderer.invoke('print:go', opts),
  getTestConfig: () => ipcRenderer.invoke('test:config'),
  testCapture: (out) => ipcRenderer.invoke('test:capture', out),
  testQuit: () => ipcRenderer.invoke('test:quit'),
});
