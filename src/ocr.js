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

// Map a word's pixel bbox to a PDF-space placement. Both baseline endpoints
// go through the viewport transform, so page /Rotate is handled generically:
// the invisible text runs along whatever direction the viewer displays as
// horizontal, keeping selection and search-highlight boxes aligned.
//
// The font size comes from the line height (uniform across the line, so
// selection boxes don't jump word to word) and the y position from the line's
// actual baseline, interpolated at the word's x — Tesseract reports baselines
// as a segment across the line, which also follows slightly skewed scans.
function placeWord(viewport, w) {
  const { x0, y0, x1, y1 } = w.bbox;
  const bl = w.baseline;
  const baseYAt = (bl && bl.x1 > bl.x0)
    ? (x) => bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0)
    : () => y1 - 0.15 * (y1 - y0);
  const [sx, sy] = viewport.convertToPdfPoint(x0, baseYAt(x0));
  const [ex, ey] = viewport.convertToPdfPoint(x1, baseYAt(x1));
  const angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
  const size = ((w.lineH || y1 - y0) / viewport.scale) * 0.9;
  const width = Math.hypot(ex - sx, ey - sy); // word width in PDF points
  return { x: sx, y: sy, angle, size, width };
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
    for (const w of words) {
      if (w.confidence < MIN_CONFIDENCE) continue;
      const { x, y, angle, size, width } = placeWord(viewport, w);
      try {
        // pickWordText prefers a dictionary-backed engine alternative;
        // cleanOcrWord fixes merged words, ligatures, and glyph confusions;
        // the corrected text is drawn at the original bbox.
        const text = cleanOcrWord(pickWordText(w));
        const font = await pickFont(text);
        if (!font) continue; // no available font covers these glyphs
        // Horizontally scale the word (Tz) so its text-metric width equals
        // the printed word's width — selection and search-highlight boxes
        // then end exactly where the visible word ends.
        const natural = font.widthOfTextAtSize(text, size);
        const tz = natural > 0 ? Math.max(30, Math.min(300, (width / natural) * 100)) : 100;
        page.pushOperators(setHScale(tz));
        page.drawText(text, { x, y, size, font, opacity: 0, rotate: degrees(angle) });
        drew = true;
        total++;
      } catch { /* glyphs the fallback font can't encode — skip the word */ }
    }
    if (drew) page.pushOperators(setHScale(100)); // don't leak Tz to later content
  }
  stats.words = total;
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, map: (p) => p };
}
