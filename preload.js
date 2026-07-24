const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

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
  ocrRecognize: (png, mode) => ipcRenderer.invoke('ocr:recognize', png, mode),
  dictText: (lang) => ipcRenderer.invoke('dict:text', lang),
  // OS spellchecker probe: null when the word is fine (or no dictionary is
  // loaded), otherwise the suggestion list. Synchronous and fully local.
  spellSuggest: (word) => {
    try {
      if (!webFrame.isWordMisspelled(word)) return null;
      return webFrame.getWordSuggestions(word);
    } catch { return null; }
  },
  listPrinters: () => ipcRenderer.invoke('print:list'),
  printNow: (opts) => ipcRenderer.invoke('print:go', opts),
  getVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  // Self-update. The only network access in the app: it talks to GitHub for a
  // version number and (on request) the installer — never document data.
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (info) => ipcRenderer.invoke('update:download', info),
    install: (filePath) => ipcRenderer.invoke('update:install', filePath),
    getAutoCheck: () => ipcRenderer.invoke('update:get-autocheck'),
    setAutoCheck: (v) => ipcRenderer.invoke('update:set-autocheck', v),
    onProgress: (cb) => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),
    onAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  },
  getTestConfig: () => ipcRenderer.invoke('test:config'),
  testCapture: (out) => ipcRenderer.invoke('test:capture', out),
  testQuit: () => ipcRenderer.invoke('test:quit'),
});
