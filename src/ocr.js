// OCR: renders scanned pages to images, recognizes them with Tesseract (in
// the main process — the engine and tur+eng models ship inside the app, fully
// offline), and bakes the words back into the PDF as an invisible text layer.
// The result is searchable/selectable here and in any other viewer.
import { PDFDocument, PDFNumber, PDFOperator, PDFOperatorNames, degrees } from 'pdf-lib';
import { loadPdf } from './viewer.js';
import { makeFontLoader } from './save.js';
import { cleanOcrWord, ensureDictLoaded, pickWordText, preprocessForOcr } from './ocrbox.js';

const MIN_CONFIDENCE = 35;

export async function pageHasText(pdf, n) {
  const page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.some((i) => i.str.trim());
}

// Pages with no extractable text are OCR candidates.
export async function scannedPages(pdf) {
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (!(await pageHasText(pdf, n))) out.push(n);
  }
  return out;
}

// Render a page at ~300 dpi (capped) for recognition quality.
async function renderPageImage(pdf, n) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(300 / 72, 4000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  preprocessForOcr(ctx, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), viewport };
}

// Map a pixel span (a word's bbox, or a whole line's) to a PDF-space
// placement. Both baseline endpoints go through the viewport transform, so
// page /Rotate is handled generically: the invisible text runs along whatever
// direction the viewer displays as horizontal.
//
// The font size comes from the line height and the y position from the
// line's actual baseline, interpolated at the span's x — Tesseract reports
// baselines as a segment across the line, which also follows skewed scans.
function placeSpan(viewport, x0, x1, top, bot, baseline, lineH) {
  const bl = baseline;
  const baseYAt = (bl && bl.x1 > bl.x0)
    ? (x) => bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0)
    : () => bot - 0.15 * (bot - top);
  const [sx, sy] = viewport.convertToPdfPoint(x0, baseYAt(x0));
  const [ex, ey] = viewport.convertToPdfPoint(x1, baseYAt(x1));
  const angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
  const size = ((lineH || bot - top) / viewport.scale) * 0.9;
  const width = Math.hypot(ex - sx, ey - sy); // span width in PDF points
  return { x: sx, y: sy, angle, size, width };
}

function placeWord(viewport, w) {
  return placeSpan(viewport, w.bbox.x0, w.bbox.x1, w.bbox.y0, w.bbox.y1, w.baseline, w.lineH);
}

function placeLine(viewport, arr) {
  const first = arr[0];
  const last = arr[arr.length - 1];
  const top = Math.min(...arr.map((w) => w.bbox.y0));
  const bot = Math.max(...arr.map((w) => w.bbox.y1));
  return placeSpan(viewport, first.bbox.x0, last.bbox.x1, top, bot, first.baseline, first.lineH);
}

const setHScale = (percent) =>
  PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(percent)]);

// Structural-op runner: recognize the given pages and return the document
// with an invisible text layer baked in. `stats.words` reports the total for
// the caller's status message.
export async function ocrRun(bytes, pageNums, onProgress, stats = {}) {
  const dictReady = ensureDictLoaded(); // cleanOcrWord consults it below
  const src = new Uint8Array(bytes);
  const pdf = await loadPdf(src.slice()); // pdf.js may take ownership of its copy
  const recognized = [];
  try {
    let i = 0;
    for (const n of pageNums) {
      onProgress?.(++i, pageNums.length, n);
      const { png, viewport } = await renderPageImage(pdf, n);
      const words = await window.native.ocrRecognize(png, 'page');
      recognized.push({ n, viewport, words });
    }
  } finally {
    pdf.destroy();
  }

  await dictReady;
  const doc = await PDFDocument.load(src, { ignoreEncryption: true });

  // The text layer needs a font with glyphs for whatever the page contains —
  // Arabic in particular isn't covered by Arial's stand-ins on Linux/web, so
  // fall through the available families per word. Fonts load (and embed)
  // lazily: a Latin-only document never touches the later families.
  const loadFont = makeFontLoader(doc);
  const famNames = ['Arial'];
  try {
    for (const f of await window.native.fontFamilies()) {
      if (!famNames.includes(f.name)) famNames.push(f.name);
    }
  } catch { /* keep just Arial */ }
  const fontInfos = [];
  const pickFont = async (text) => {
    for (let i = 0; i < famNames.length; i++) {
      if (i === fontInfos.length) {
        const font = await loadFont(famNames[i]);
        fontInfos.push({ font, chars: new Set(font.getCharacterSet()) });
      }
      const fi = fontInfos[i];
      if ([...text].every((ch) => fi.chars.has(ch.codePointAt(0)))) return fi.font;
    }
    return null;
  };
  let total = 0;
  for (const { n, viewport, words } of recognized) {
    const page = doc.getPage(n - 1);
    let drew = false;

    // One drawText per recognized LINE, words joined with real spaces. Drawn
    // word-by-word, every word is its own text item with its own rotation and
    // scaling — pdf.js can't reassemble that into lines, and copied text
    // comes out with a break (or nothing) between every word. Per-line runs
    // extract exactly like a digitally-created PDF. The Tz width-match keeps
    // the line's start and end pinned to the printed line.
    const lines = [];
    let cur = null;
    let curKey = null;
    for (const w of words) {
      if (w.confidence < MIN_CONFIDENCE) continue;
      const key = `${w.para}:${w.line}`;
      if (key !== curKey) { cur = []; lines.push(cur); curKey = key; }
      cur.push(w);
    }
    for (const arr of lines) {
      // pickWordText prefers a dictionary-backed engine alternative;
      // cleanOcrWord fixes merged words, ligatures, and glyph confusions.
      const lineText = arr.map((w) => cleanOcrWord(pickWordText(w))).join(' ');
      const lineFont = await pickFont(lineText);
      if (lineFont) {
        try {
          const { x, y, angle, size, width } = placeLine(viewport, arr);
          const natural = lineFont.widthOfTextAtSize(lineText, size);
          const tz = natural > 0 ? Math.max(30, Math.min(300, (width / natural) * 100)) : 100;
          page.pushOperators(setHScale(tz));
          page.drawText(lineText, { x, y, size, font: lineFont, opacity: 0, rotate: degrees(angle) });
          drew = true;
          total += arr.length;
          continue;
        } catch { /* fall through to word-by-word */ }
      }
      // Fallback for lines no single font can cover (mixed scripts): draw
      // per word so at least the coverable words become searchable.
      for (const w of arr) {
        try {
          const text = cleanOcrWord(pickWordText(w));
          const font = await pickFont(text);
          if (!font) continue; // no available font covers these glyphs
          const { x, y, angle, size, width } = placeWord(viewport, w);
          const natural = font.widthOfTextAtSize(text, size);
          const tz = natural > 0 ? Math.max(30, Math.min(300, (width / natural) * 100)) : 100;
          page.pushOperators(setHScale(tz));
          page.drawText(text, { x, y, size, font, opacity: 0, rotate: degrees(angle) });
          drew = true;
          total++;
        } catch { /* glyphs the fallback font can't encode — skip the word */ }
      }
    }
    if (drew) page.pushOperators(setHScale(100)); // don't leak Tz to later content
  }
  stats.words = total;
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, map: (p) => p };
}
