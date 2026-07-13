const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let pendingPaths = [];

function collectPdfArgs(argv) {
  return argv.filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
}

// Hidden self-test mode (--autotest=<dir> / --autoshot=<png>). Skips the
// single-instance lock so tests run even while a normal egPDF is open.
const TEST_MODE = process.argv.some((a) => a.startsWith('--auto'));

if (!TEST_MODE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      const paths = collectPdfArgs(argv);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        if (paths.length) mainWindow.webContents.send('open-paths', paths);
      }
    });
  }
}

function createWindow() {
  // Packaged builds get the icon from the exe resource; this covers dev runs.
  const devIcon = path.join(__dirname, 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 700,
    minHeight: 480,
    backgroundColor: '#f4f4f5',
    autoHideMenuBar: true,
    ...(fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep rendering callbacks alive when the window is occluded — page
      // renders are driven by rAF/IntersectionObserver.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile('index.html');

  // External links in PDFs open in the default browser, never in-app.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const paths = pendingPaths.length ? pendingPaths : collectPdfArgs(process.argv.slice(1));
    if (paths.length) mainWindow.webContents.send('open-paths', paths);
    pendingPaths = [];

    // Hidden test hook: --autoshot=<out.png> [--open=<file.pdf>] renders and captures.
    const shotArg = process.argv.find((a) => a.startsWith('--autoshot='));
    if (shotArg) {
      const out = shotArg.split('=')[1];
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
        } catch (e) {
          console.error('autoshot failed', e);
        }
        app.quit();
      }, 4000);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// macOS-style file open (harmless on Windows)
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (mainWindow) mainWindow.webContents.send('open-paths', [p]);
  else pendingPaths.push(p);
});

ipcMain.handle('dialog:open-pdfs', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:pick-image', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Insert image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  return {
    name: path.basename(p),
    mime: ext === '.png' ? 'image/png' : 'image/jpeg',
    data: buf.toString('base64'),
  };
});

ipcMain.handle('dialog:save-pdf', async (_e, defaultName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF',
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('file:read', async (_e, filePath) => {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('file:write', async (_e, filePath, data) => {
  fs.writeFileSync(filePath, Buffer.from(data));
  return true;
});

ipcMain.handle('window:set-title', (_e, title) => {
  if (mainWindow) mainWindow.setTitle(title);
});

ipcMain.handle('fs:exists-many', (_e, paths) =>
  (Array.isArray(paths) ? paths : []).filter((p) => {
    try { return typeof p === 'string' && fs.existsSync(p); } catch { return false; }
  }));

ipcMain.handle('print:list', async () => {
  try { return await mainWindow.webContents.getPrintersAsync(); } catch { return []; }
});

ipcMain.handle('print:go', (_e, opts) => new Promise((resolve) => {
  try {
    mainWindow.webContents.print(
      { silent: true, printBackground: true, ...opts },
      (ok, reason) => resolve({ ok, reason }),
    );
  } catch (err) {
    resolve({ ok: false, reason: String(err.message || err) });
  }
}));

// Hidden self-test hooks, active only when launched with --autotest/--autoshot.
ipcMain.handle('test:config', () => {
  const a = process.argv.find((x) => x.startsWith('--autotest='));
  return a ? a.split('=')[1] : null;
});
if (TEST_MODE) {
  ipcMain.handle('test:capture', async (_e, out) => {
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    return true;
  });
  ipcMain.handle('test:quit', () => app.quit());
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, _level, msg, line, src) =>
      console.log(`[renderer] ${msg} (${src}:${line})`));
  });
}
