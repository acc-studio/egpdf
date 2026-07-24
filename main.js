const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { homedir } = require('os');

// ---- self-update ------------------------------------------------------------
// The *only* network access in egPDF, and it touches nothing but GitHub: it
// reads the latest release's version and, when the user asks, downloads the
// installer. No document data is ever sent. Auto-check runs at startup unless
// disabled in the About dialog.
const UPDATE_REPO = 'acc-studio/egpdf';
const UPDATE_UA = 'egPDF-updater';
const UPDATE_ASSET = { win32: 'egPDF-Setup.exe', darwin: 'egPDF.dmg', linux: 'egPDF.AppImage' };

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  try { fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2)); } catch { /* non-fatal */ }
  return merged;
}
function autoCheckEnabled() { return readSettings().autoUpdateCheck !== false; }

// GET following GitHub's redirects, returning the whole body as a Buffer.
function httpsGetBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UPDATE_UA, ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetBuffer(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Is `remote` a newer semver than `local`? (numeric major.minor.patch only)
function isNewerVersion(remote, local) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(remote), b = parse(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  const body = await httpsGetBuffer(
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
    { Accept: 'application/vnd.github+json' });
  const rel = JSON.parse(body.toString('utf8'));
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const wantName = UPDATE_ASSET[process.platform];
  const asset = (rel.assets || []).find((a) => a.name === wantName);
  return {
    available: !!version && isNewerVersion(version, app.getVersion()),
    version,
    htmlUrl: rel.html_url || null,
    assetName: asset ? asset.name : null,
    downloadUrl: asset ? asset.browser_download_url : null,
  };
}

function downloadUpdate(info, onProgress) {
  return new Promise((resolve, reject) => {
    if (!info || !info.downloadUrl) {
      return reject(new Error('no installer for this platform in the latest release'));
    }
    const dest = path.join(app.getPath('temp'), info.assetName || `egPDF-update-${info.version}`);
    const get = (url) => {
      https.get(url, { headers: { 'User-Agent': UPDATE_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0, lastPct = -1;
        const file = fs.createWriteStream(dest);
        res.on('data', (d) => {
          got += d.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== lastPct) { lastPct = pct; try { onProgress(pct); } catch {} }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      }).on('error', reject);
    };
    get(info.downloadUrl);
  });
}

// Hand the downloaded installer to the OS and quit so no files stay locked.
// Windows NSIS (oneClick) reinstalls in place and relaunches egPDF; mac/linux
// open the disk image / AppImage for the user to finish.
function installUpdate(filePath) {
  if (process.platform === 'win32') {
    const { spawn } = require('child_process');
    spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    shell.openPath(filePath);
  }
  setTimeout(() => app.quit(), 500);
  return true;
}

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
    const direct = dir + file;
    if (fs.existsSync(direct)) return direct;
    // Debian/Ubuntu package their bundled TTFs one directory deeper, e.g.
    // /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf.
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(dir, entry.name, file);
        if (fs.existsSync(nested)) return nested;
      }
    } catch { /* dir doesn't exist or isn't listable */ }
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

  // The OCR cleanup pass consults the OS spellchecker (via webFrame in the
  // renderer) to fix glyph confusions like "reguested" → "requested". On
  // Windows this is the native spellchecker — enable whatever of our two OCR
  // languages the OS actually has. On macOS language choice is automatic and
  // this API throws; degrade silently (the cleanup then skips spell fixes).
  try {
    const ses = mainWindow.webContents.session;
    const avail = ses.availableSpellCheckerLanguages || [];
    const langs = ['en-US', 'en-GB', 'en', 'tr', 'tr-TR', 'de', 'de-DE', 'ar', 'ar-SA']
      .filter((l) => avail.includes(l));
    if (langs.length) ses.setSpellCheckerLanguages(langs);
  } catch { /* native spellchecker manages its own languages */ }

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

    // Look for a newer release in the background (skipped during self-tests and
    // when the user has turned auto-check off). Failures are silent — offline
    // or an unreachable GitHub simply means no banner appears.
    if (!TEST_MODE && autoCheckEnabled()) {
      setTimeout(async () => {
        try {
          const info = await checkForUpdate();
          if (info.available && mainWindow) mainWindow.webContents.send('update:available', info);
        } catch { /* offline / GitHub unreachable */ }
      }, 2500);
    }

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

// Bundled OCR-repair word lists (vendor/dict, unpacked from the asar like the
// OCR models). The renderer parses them; empty string = list unavailable.
ipcMain.handle('dict:text', (_e, lang) => {
  if (!['en', 'tr', 'de', 'ar'].includes(lang)) return '';
  const p = path.join(__dirname, 'vendor', 'dict', `${lang}.txt`)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
});

// OCR (Tesseract, fully local). The engine and the tur+eng language models
// ship inside the app — nothing is ever fetched from the network. Runs in the
// main process (Node worker_threads) so the renderer stays responsive; the
// worker is created lazily on first use and reused across pages.
let ocrWorkerPromise = null;

function ocrLangDir() {
  // vendor/ is unpacked from the asar so the OCR worker thread can read the
  // model files with plain fs.
  return path.join(__dirname, 'vendor', 'tessdata')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker, OEM } = require('tesseract.js');
      // The bundled models are tessdata_best_int (integerized best): the
      // float tessdata_best models abort the wasm core with "missing
      // function: DotProductSSE" — only integer LSTM models are supported.
      return createWorker(['tur', 'eng', 'ara', 'deu'], OEM.LSTM_ONLY, {
        langPath: ocrLangDir(),
        gzip: false,
        cacheMethod: 'none',
      });
    })();
    // A failed init shouldn't poison every later attempt.
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

// Page-segmentation mode: full pages get real layout analysis (AUTO),
// user-drawn boxes are a single block of text.
let ocrPsm = null;
async function setOcrPsm(worker, mode) {
  const { PSM } = require('tesseract.js');
  const psm = mode === 'area' ? PSM.SINGLE_BLOCK : PSM.AUTO;
  if (psm !== ocrPsm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    ocrPsm = psm;
  }
}

ipcMain.handle('ocr:recognize', async (_e, pngData, mode) => {
  const worker = await getOcrWorker();
  await setOcrPsm(worker, mode);
  const { data } = await worker.recognize(Buffer.from(pngData), {}, { blocks: true });
  const words = [];
  let paraN = 0, lineN = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      paraN++;
      for (const line of para.lines) {
        lineN++;
        // Line geometry travels with each word: the baseline and line height
        // give the renderer a stable font size and true baseline per line,
        // instead of guessing from each word's own bbox.
        const bl = line.baseline;
        const baseline = bl ? { x0: bl.x0, y0: bl.y0, x1: bl.x1, y1: bl.y1 } : null;
        const lineH = line.bbox ? line.bbox.y1 - line.bbox.y0 : null;
        for (const w of line.words) {
          if (w.text.trim()) {
            words.push({
              text: w.text, confidence: w.confidence, bbox: w.bbox,
              para: paraN, line: lineN, baseline, lineH,
              // alternative readings, for the dictionary rescorer
              choices: (w.choices || []).map((c) => ({ text: c.text, confidence: c.confidence })),
            });
          }
        }
      }
    }
  }
  return words;
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('shell:open-external', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:get-autocheck', () => autoCheckEnabled());
ipcMain.handle('update:set-autocheck', (_e, v) => { writeSettings({ autoUpdateCheck: !!v }); return true; });
ipcMain.handle('update:download', (e, info) =>
  downloadUpdate(info, (pct) => e.sender.send('update:progress', pct)));
ipcMain.handle('update:install', (_e, filePath) => installUpdate(filePath));

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
