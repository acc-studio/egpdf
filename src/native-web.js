// Browser implementation of the window.native bridge (in the desktop app,
// preload.js provides the Electron one). Everything runs client-side: files
// through the File System Access API (with a download fallback for browsers
// without it), fonts from bundled open-licensed TTFs, and OCR through
// tesseract.js in a Web Worker using the same tur+eng models the desktop app
// ships. No document data ever leaves the machine.
import { createWorker, OEM, PSM } from 'tesseract.js';

// Bundled faces (Liberation: metric-compatible replacements for Arial /
// Times New Roman / Courier New, SIL OFL licensed — see fonts/LICENSE-*).
const FONTS = [
  { name: 'Liberation Sans', file: 'LiberationSans-Regular.ttf' },
  { name: 'Liberation Serif', file: 'LiberationSerif-Regular.ttf' },
  { name: 'Liberation Mono', file: 'LiberationMono-Regular.ttf' },
  // Arabic glyphs for the invisible OCR text layer (Liberation has none)
  { name: 'Noto Sans Arabic', file: 'NotoSansArabic-Regular.ttf' },
];
// Desktop family names that map cleanly onto a bundled face (the OCR layer
// and saved docs ask for 'Arial').
const FONT_ALIASES = {
  Arial: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  Georgia: 'Liberation Serif',
  'Courier New': 'Liberation Mono',
  Consolas: 'Liberation Mono',
};

function fontFile(name) {
  const resolved = FONT_ALIASES[name] || name;
  const f = FONTS.find((x) => x.name === resolved) || FONTS[0];
  return 'fonts/' + f.file;
}

// ---- opened-file registry ---------------------------------------------------
// The renderer passes opaque "paths" around; here they're keys into this map.
// Shaped like paths (egweb/<n>/<name>) so `path.split(/[\\/]/).pop()` in the
// renderer still yields the display name.
const entries = new Map();
let entrySeq = 1;
function register(entry) {
  const id = `egweb/${entrySeq++}/${entry.name}`;
  entries.set(id, entry);
  return id;
}

const hasFsAccess = typeof window.showOpenFilePicker === 'function';

// <input type=file> fallback for browsers without the File System Access API.
function pickViaInput({ multiple = false, accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

const PDF_TYPES = [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }];

// ---- OCR (tesseract.js in a Web Worker, models served as static assets) -----
let ocrWorkerPromise = null;
let lastPsm = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(['tur', 'eng', 'ara', 'deu'], OEM.LSTM_ONLY, {
      workerPath: '/tess/worker.min.js',
      corePath: '/tess/core',
      langPath: '/tessdata',
      gzip: false,
      cacheMethod: 'none',
      workerBlobURL: false,
    });
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

// Same flattening as the desktop main process (main.js ocr:recognize) — keep
// the two in sync: words carry paragraph/line ids plus the line's baseline
// and height for the text-layer placement.
function flattenBlocks(data) {
  const words = [];
  let paraN = 0, lineN = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      paraN++;
      for (const line of para.lines) {
        lineN++;
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
}

// ------------------------------------------------------------------------------

export function createNativeWeb() {
  return {
    async openPdfDialog() {
      if (hasFsAccess) {
        try {
          const handles = await window.showOpenFilePicker({ multiple: true, types: PDF_TYPES });
          return handles.map((h) => register({ name: h.name, fsHandle: h }));
        } catch { return []; } // cancelled
      }
      const files = await pickViaInput({ multiple: true, accept: '.pdf,application/pdf' });
      return files.map((f) => register({ name: f.name, file: f }));
    },

    async savePdfDialog(defaultName) {
      if (hasFsAccess) {
        try {
          const h = await window.showSaveFilePicker({
            suggestedName: defaultName || 'document.pdf', types: PDF_TYPES,
          });
          return register({ name: h.name, fsHandle: h });
        } catch { return null; } // cancelled
      }
      return register({ name: defaultName || 'document.pdf', download: true });
    },

    async readFile(p) {
      const e = entries.get(p);
      if (e) {
        const f = e.fsHandle ? await e.fsHandle.getFile() : e.file;
        return await f.arrayBuffer();
      }
      // bundled assets (font files) are read over same-origin fetch
      const res = await fetch(p);
      if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
      return await res.arrayBuffer();
    },

    async writeFile(p, data) {
      const e = entries.get(p);
      if (e?.fsHandle) {
        const w = await e.fsHandle.createWritable();
        await w.write(data);
        await w.close();
        return true;
      }
      // no writable handle — hand the bytes to the browser as a download
      const name = e?.name || String(p).split(/[\\/]/).pop() || 'document.pdf';
      const blob = new Blob([data], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return true;
    },

    async pickImage() {
      const files = await pickViaInput({ accept: 'image/png,image/jpeg' });
      const f = files[0];
      if (!f) return null;
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      return {
        name: f.name,
        mime: f.type === 'image/png' ? 'image/png' : 'image/jpeg',
        data: String(dataUrl).split(',')[1],
      };
    },

    setTitle(t) { document.title = t || 'egPDF'; },
    // Dropped files are read directly from the File object; without a
    // writable handle there is no save-back path, so no pseudo-path either —
    // Save then goes through the save dialog.
    pathForFile() { return null; },
    onOpenPaths() { /* no OS file-association channel in the browser */ },
    async existsMany() { return []; },

    async fontFamilies() {
      return FONTS.map((f) => ({ name: f.name, path: 'fonts/' + f.file }));
    },
    async fontPath(name) { return fontFile(name); },

    async ocrRecognize(png, mode) {
      const worker = await getOcrWorker();
      // full pages get real layout analysis, user boxes are one block
      const psm = mode === 'area' ? PSM.SINGLE_BLOCK : PSM.AUTO;
      if (psm !== lastPsm) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        lastPsm = psm;
      }
      const blob = new Blob([png], { type: 'image/png' });
      const { data } = await worker.recognize(blob, {}, { blocks: true });
      return flattenBlocks(data);
    },

    // Bundled OCR-repair word lists, served as static assets.
    async dictText(lang) {
      const res = await fetch(`dict/${lang}.txt`);
      return res.ok ? await res.text() : '';
    },

    // No OS spellchecker in the browser — the bundled dictionaries above
    // carry the spellfix stage instead.
    spellSuggest() { return null; },

    async listPrinters() {
      return [{ name: 'browser', displayName: 'Browser print dialog', isDefault: true }];
    },
    async printNow(opts) {
      // The print stylesheet shows only #print-container; orientation is the
      // one setting the page can still control.
      const style = document.createElement('style');
      style.textContent = `@page { size: ${opts?.landscape ? 'landscape' : 'portrait'}; margin: 0; }`;
      document.head.appendChild(style);
      try {
        window.print();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) };
      } finally {
        style.remove();
      }
    },

    // Web build has no installed version and no self-updater — the About
    // dialog shows "Web version" and hides its update controls.
    async getVersion() { return null; },
    openExternal(url) { if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener'); },
    update: null,

    async getTestConfig() { return null; },
    async testCapture() { return false; },
    async testQuit() {},
  };
}
