import {
  PDFDocument, PDFTextField, StandardFonts, rgb, BlendMode,
  PDFName, PDFHexString, PDFArray, degrees,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { pdfjsLib } from './viewer.js';

// Per-family font loader: embeds the matching system TTF (subset) so text
// edits keep their chosen face and non-ASCII text (ğ, ş, İ, …) survives.
// The path is resolved in the main process (host filesystem) and bridged in;
// falls back to Helvetica if a face is missing.
function makeFontLoader(doc) {
  const cache = new Map();
  let fontkitRegistered = false;
  return async (family) => {
    const key = family || 'Arial';
    if (cache.has(key)) return cache.get(key);
    let font = null;
    const candidates = [...new Set(
      [await window.native.fontPath(key), await window.native.fontPath('Arial')].filter(Boolean),
    )];
    for (const p of candidates) {
      try {
        const buf = await window.native.readFile(p);
        if (!fontkitRegistered) { doc.registerFontkit(fontkit); fontkitRegistered = true; }
        font = await doc.embedFont(new Uint8Array(buf), { subset: true });
        break;
      } catch { /* try next */ }
    }
    if (!font) font = await doc.embedFont(StandardFonts.Helvetica);
    cache.set(key, font);
    return font;
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Render the page (including filled form values) to a PNG with the redaction
// boxes painted in — the raster replaces the page, so redacted content is
// genuinely removed from the file, not just covered.
async function rasterizeRedactedPage(pdf, pageNum, redactions) {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(300 / 72, 5000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let printStorage = null;
  try { printStorage = pdf.annotationStorage.print; } catch {}
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print',
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
    printAnnotationStorage: printStorage,
  }).promise;

  ctx.fillStyle = '#000';
  for (const r of redactions) {
    const [ax, ay] = viewport.convertToViewportPoint(r.x, r.y);
    const [bx, by] = viewport.convertToViewportPoint(r.x + r.w, r.y + r.h);
    ctx.fillRect(Math.min(ax, bx) - 0.5, Math.min(ay, by) - 0.5,
      Math.abs(bx - ax) + 1, Math.abs(by - ay) + 1);
  }

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), width: base.width, height: base.height, viewport: base };
}

// Remove form fields whose widgets sit on the page being replaced, so the
// AcroForm doesn't point at dangling annotations.
function removeFieldsOnPage(doc, page) {
  let form;
  try { form = doc.getForm(); } catch { return; }
  const ref = page.ref;
  for (const field of [...form.getFields()]) {
    try {
      const widgets = field.acroField.getWidgets();
      if (widgets.some((w) => w.P() === ref)) form.removeField(field);
    } catch { /* leave field in place */ }
  }
}

// Append a real /Text (sticky-note) annotation so comments show up in any
// PDF viewer, not just ours.
function addNoteAnnotation(doc, page, x, yTop, text) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x, yTop - 20, x + 20, yTop],
    Contents: PDFHexString.fromText(text),
    T: PDFHexString.fromText('egPDF'),
    Name: 'Comment',
    Open: false,
    F: 4,
    C: [1, 0.84, 0.2],
    M: PDFHexString.fromText(new Date().toISOString()),
  });
  const ref = doc.context.register(annot);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
}

// Multiline fields with an "auto" (0) font size get rendered at whatever fits
// the box — regenerate their appearance at a fixed readable size.
function fixAutoSizedMultilineFields(doc, font) {
  let form;
  try { form = doc.getForm(); } catch { return; }
  for (const f of form.getFields()) {
    try {
      if (f instanceof PDFTextField && f.isMultiline()) {
        const da = f.acroField.getDefaultAppearance() || '';
        const m = /(\d+(?:\.\d+)?)\s+Tf/.exec(da);
        const size = m ? parseFloat(m[1]) : 0;
        if (size === 0 || size > 24) {
          f.setFontSize(11);
          f.updateAppearances(font);
        }
      }
    } catch { /* leave appearance as-is */ }
  }
}

// ---- structural page operations ---------------------------------------------
// Each returns { bytes, map } where map(oldPageNum) → newPageNum | null,
// used to remap pending overlay edits.

export async function reorderPages(bytes, from, to) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  const out = await doc.save({ updateFieldAppearances: false });
  return {
    bytes: out,
    map: (p) => {
      const i = p - 1;
      if (i === from) return to + 1;
      if (from < to && i > from && i <= to) return p - 1;
      if (to < from && i >= to && i < from) return p + 1;
      return p;
    },
  };
}

export async function rotatePage(bytes, index) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(index);
  const cur = page.getRotation().angle || 0;
  page.setRotation(degrees(((cur + 90) % 360 + 360) % 360));
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, map: (p) => p };
}

export async function deletePage(bytes, index) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (doc.getPageCount() <= 1) throw new Error('Cannot delete the only page');
  removeFieldsOnPage(doc, doc.getPage(index));
  doc.removePage(index);
  const out = await doc.save({ updateFieldAppearances: false });
  return {
    bytes: out,
    map: (p) => {
      const i = p - 1;
      if (i === index) return null;
      return i > index ? p - 1 : p;
    },
  };
}

/**
 * Produce the final PDF bytes for a tab: form values (via pdf.js), then
 * redactions (page rasterization), then whiteout/text/image edits (pdf-lib).
 */
export async function buildSavedPdf(tab) {
  let baseBytes;
  if (tab.formsDirty) {
    baseBytes = await tab.pdf.saveDocument();
  } else {
    baseBytes = tab.origBytes;
  }
  if (!tab.edits.length && !tab.formsDirty) return new Uint8Array(baseBytes);

  const doc = await PDFDocument.load(baseBytes, { ignoreEncryption: true });
  const getFont = makeFontLoader(doc);
  if (tab.formsDirty) fixAutoSizedMultilineFields(doc, await getFont('Arial'));
  if (!tab.edits.length) return await doc.save({ updateFieldAppearances: false });

  const byPage = new Map();
  for (const e of tab.edits) {
    if (!byPage.has(e.page)) byPage.set(e.page, []);
    byPage.get(e.page).push(e);
  }

  for (const [pageNum, pageEdits] of byPage) {
    const redactions = pageEdits.filter((e) => e.kind === 'redact');
    let page = doc.getPage(pageNum - 1);
    let raster = null;

    if (redactions.length) {
      raster = await rasterizeRedactedPage(tab.pdf, pageNum, redactions);
      removeFieldsOnPage(doc, page);
      doc.removePage(pageNum - 1);
      page = doc.insertPage(pageNum - 1, [raster.width, raster.height]);
      const png = await doc.embedPng(raster.png);
      page.drawImage(png, { x: 0, y: 0, width: raster.width, height: raster.height });
    }

    // On a rasterized page the original coordinate system (rotation/crop) is
    // gone — remap edit coords through the base viewport onto the new page.
    const remapPoint = (x, y) => {
      if (!raster) return [x, y];
      const [vx, vy] = raster.viewport.convertToViewportPoint(x, y);
      return [vx, raster.height - vy];
    };
    const remapRect = (r) => {
      if (!raster) return r;
      const [ax, ay] = remapPoint(r.x, r.y);
      const [bx, by] = remapPoint(r.x + r.w, r.y + r.h);
      return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    };

    for (const e of pageEdits) {
      if (e.kind === 'whiteout') {
        const r = remapRect(e);
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1) });
      } else if (e.kind === 'highlight') {
        const r = remapRect(e);
        page.drawRectangle({
          x: r.x, y: r.y, width: r.w, height: r.h,
          color: rgb(1, 0.84, 0.2), opacity: 0.35, blendMode: BlendMode.Multiply,
        });
      } else if (e.kind === 'note') {
        const [x, yTop] = remapPoint(e.x, e.yTop);
        addNoteAnnotation(doc, page, x, yTop, e.text);
      } else if (e.kind === 'text') {
        const [x, yTop] = remapPoint(e.x, e.yTop);
        page.drawText(e.text, {
          x,
          y: yTop - e.size * 0.92,
          size: e.size,
          font: await getFont(e.font),
          color: rgb(0.07, 0.07, 0.07),
          lineHeight: e.size * 1.15,
        });
      } else if (e.kind === 'image') {
        const bytes = b64ToBytes(e.data);
        const img = e.mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [x, yTop] = remapPoint(e.x, e.yTop);
        page.drawImage(img, { x, y: yTop - e.h, width: e.w, height: e.h });
      }
    }
  }

  // pdf.js already wrote appearance streams for form values; regenerating
  // them would re-encode with WinAnsi and break non-ASCII text.
  return await doc.save({ updateFieldAppearances: false });
}
