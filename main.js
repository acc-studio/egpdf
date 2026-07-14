const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { homedir } = require('os');

// System font directories per platform. We embed the matching TTF (subset) on
// save so the PDF looks identical everywhere. Only plain .ttf files are usable
// — .ttc collections (Helvetica, Times, etc. on macOS) can't be embedded
// directly by pdf-lib, so they're skipped automatically by the availability
// probe below. The dropdown only ever shows fonts actually installed on the
// host, so the list differs per OS.
const FONT_FAMILIES = [
  { name: 'Arial', file: 'arial.ttf', linux: 'LiberationSans-Regular.ttf' },
  { name: 'Calibri', file: 'calibri.ttf' },
  { name: 'Comic Sans MS', file: 'comic.ttf', linux: 'ComicNeue-Regular.ttf' },
  { name: 'Consolas', file: 'consola.ttf', linux: 'DejaVuSansMono.ttf' },
  { name: 'Courier New', file: 'cour.ttf', linux: 'LiberationMono-Regular.ttf' },
  { name: 'Georgia', file: 'georgia.ttf', linux: 'LiberationSerif-Regular.ttf' },
  { name: 'Impact', file: 'impact.ttf' },
  { name: 'Segoe UI', file: 'segoeui.ttf' },
  { name: 'Tahoma', file: 'tahoma.ttf' },
  { name: 'Times New Roman', file: 'times.ttf', linux: 'LiberationSerif-Regular.ttf' },
  { name: 'Trebuchet MS', file: 'trebuc.ttf' },
  { name: 'Verdana', file: 'verdana.ttf', linux: 'DejaVuSans.ttf' },
];

const PLATFORM_DIRS = {
  win32: ['C:\\Windows\\Fonts\\'],
  darwin: [
    '/System/Library/Fonts/Supplemental/',
    '/System/Library/Fonts/',
    '/Library/Fonts/',
  ],
  linux: [
    '/usr/share/fonts/truetype/',
    '/usr/share/fonts/',
    '/usr/local/share/fonts/',
    `${homedir()}/.fonts/`,
  ],
};

function fontFileName(family) {
  if (process.platform === 'linux' && family.linux) return family.linux;
  return family.file;
}

function searchDirs() {
  return PLATFORM_DIRS[process.platform] || PLATFORM_DIRS.linux;
}

// Absolute path of an installed font for a family, or null if absent.
function resolveFontPath(name) {
  const family = FONT_FAMILIES.find((x) => x.name === name);
  const file = family ? fontFileName(family) : 'arial.ttf';
  for (const dir of searchDirs()) {
    const p = dir + file;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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

// Fonts: resolve the host's installed faces so the renderer can show only what
// is actually available and embed the right file on save.
ipcMain.handle('font:families', () => {
  const found = FONT_FAMILIES
    .map((f) => ({ name: f.name, path: resolveFontPath(f.name) }))
    .filter((f) => f.path);
  return found.length ? found : [{ name: 'Arial', path: null }];
});
ipcMain.handle('font:path', (_e, name) => resolveFontPath(name || 'Arial'));

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
