// OCR: renders scanned pages to images, recognizes them with Tesseract (in
// the main process — the engine and tur+eng models ship inside the app, fully
// offline), and bakes the words back into the PDF as an invisible text layer.
// The result is searchable/selectable here and in any other viewer.
import { PDFDocument, degrees } from 'pdf-lib';
import { loadPdf } from './viewer.js';
import { makeFontLoader } from './save.js';

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
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), viewport };
}

// Map a word's pixel bbox to a PDF-space placement. Both baseline endpoints
// go through the viewport transform, so page /Rotate is handled generically:
// the invisible text runs along whatever direction the viewer displays as
// horizontal, keeping selection and search-highlight boxes aligned.
function placeWord(viewport, w) {
  const { x0, y0, x1, y1 } = w.bbox;
  const baseY = y1 - 0.15 * (y1 - y0); // approximate baseline above bbox bottom
  const [sx, sy] = viewport.convertToPdfPoint(x0, baseY);
  const [ex, ey] = viewport.convertToPdfPoint(x1, baseY);
  const angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
  const size = ((y1 - y0) / viewport.scale) * 0.9;
  return { x: sx, y: sy, angle, size };
}

// Structural-op runner: recognize the given pages and return the document
// with an invisible text layer baked in. `stats.words` reports the total for
// the caller's status message.
export async function ocrRun(bytes, pageNums, onProgress, stats = {}) {
  const src = new Uint8Array(bytes);
  const pdf = await loadPdf(src.slice()); // pdf.js may take ownership of its copy
  const recognized = [];
  try {
    let i = 0;
    for (const n of pageNums) {
      onProgress?.(++i, pageNums.length, n);
      const { png, viewport } = await renderPageImage(pdf, n);
      const words = await window.native.ocrRecognize(png);
      recognized.push({ n, viewport, words });
    }
  } finally {
    pdf.destroy();
  }

  const doc = await PDFDocument.load(src, { ignoreEncryption: true });
  const font = await makeFontLoader(doc)('Arial');
  let total = 0;
  for (const { n, viewport, words } of recognized) {
    const page = doc.getPage(n - 1);
    for (const w of words) {
      if (w.confidence < MIN_CONFIDENCE) continue;
      const { x, y, angle, size } = placeWord(viewport, w);
      try {
        page.drawText(w.text, { x, y, size, font, opacity: 0, rotate: degrees(angle) });
        total++;
      } catch { /* glyphs the fallback font can't encode — skip the word */ }
    }
  }
  stats.words = total;
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, map: (p) => p };
}
