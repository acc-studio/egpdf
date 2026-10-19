// UYAP document (.udf) reader. A UDF is a ZIP whose content.xml holds the
// whole document text in one CDATA block plus a layout tree (paragraphs,
// tables, header/footer, images, numbered lists) whose runs point into that
// text by startOffset/length, styled through named <styles>.
//
// We lay it out into a real PDF (pdf-lib + embedded Liberation fonts, which
// are metric-compatible with Times New Roman / Arial and cover Turkish), so
// everything else in egPDF — viewing, search, selection, markup, OCR-free
// text, printing, saving — works on it unchanged. The .udf itself is never
// written to: Save produces a PDF copy. sign.sgn (the e-signature) is not
// verified or shown.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// ---------------------------------------------------------------- zip

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

export function isUdf(bytes) {
  return bytes.length > 30 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    && !!zipEntries(bytes).find((e) => e.name === 'content.xml');
}

function zipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = [];
  for (let k = 0; k < count && u32(b, p) === 0x02014b50; k++) {
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
    out.push({
      name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)),
      method: u16(b, p + 10),
      size: u32(b, p + 20),
      local: u32(b, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readZipEntry(b, name) {
  const e = zipEntries(b).find((x) => x.name === name);
  if (!e) return null;
  const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
  const raw = b.subarray(start, start + e.size);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error(`unsupported zip compression (${e.method})`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- fonts

const FACES = {
  serif: ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSerif-BoldItalic.ttf'],
  sans: ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'],
  mono: ['LiberationMono-Regular.ttf', 'LiberationMono-Regular.ttf', 'LiberationMono-Regular.ttf', 'LiberationMono-Regular.ttf'],
};
function faceFile(family, bold, italic) {
  const f = String(family || '');
  const set = /courier|mono|consolas/i.test(f) ? FACES.mono
    : /times|serif|georgia|garamond|cambria|book/i.test(f) ? FACES.serif : FACES.sans;
  return set[(bold ? 1 : 0) + (italic ? 2 : 0)];
}

// ---------------------------------------------------------------- styles

const attrsOf = (el) => {
  const o = {};
  for (const a of el.attributes || []) o[a.name] = a.value;
  return o;
};
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const bool = (v) => v === 'true';
function color(v) {
  if (v == null || v === '') return rgb(0, 0, 0);
  const n = parseInt(v, 10) >>> 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---------------------------------------------------------------- converter

/**
 * udfToPdf(bytes, loadFont) → Uint8Array (PDF)
 * loadFont(fileName) → ArrayBuffer of one of the bundled Liberation TTFs.
 */
export async function udfToPdf(bytes, loadFont) {
  const xmlBytes = await readZipEntry(bytes, 'content.xml');
  if (!xmlBytes) throw new Error('not a UYAP document (no content.xml)');
  const xml = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(xmlBytes), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('damaged UYAP document');
  const root = xml.documentElement;
  const text = root.querySelector(':scope > content')?.textContent ?? '';

  const styles = {};
  for (const s of root.querySelectorAll(':scope > styles > style')) styles[s.getAttribute('name')] = attrsOf(s);
  const elementsEl = root.querySelector(':scope > elements');
  const baseStyle = { family: 'Times New Roman', size: '12', ...(styles['hvl-default'] || {}), ...(styles[elementsEl?.getAttribute('resolver')] || {}) };

  // page geometry (points). Java PageFormat: 1 = portrait, 0/2 = landscape.
  const pf = attrsOf(root.querySelector(':scope > properties > pageFormat') || { attributes: [] });
  let [pageW, pageH] = [595.28, 841.89];
  if (pf.paperOrientation && pf.paperOrientation !== '1') [pageW, pageH] = [pageH, pageW];
  const M = {
    left: num(pf.leftMargin, 70), right: num(pf.rightMargin, 70),
    top: num(pf.topMargin, 56), bottom: num(pf.bottomMargin, 56),
    headerOff: num(pf.headerFOffset, 20), footerOff: num(pf.footerFOffset, 20),
  };
  const contentW = pageW - M.left - M.right;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = new Map();
  async function font(family, bold, italic) {
    const file = faceFile(family, bold, italic);
    if (!fonts.has(file)) fonts.set(file, doc.embedFont(new Uint8Array(await loadFont(file)), { subset: true }));
    return fonts.get(file);
  }
  const imageCache = new Map();
  async function image(b64) {
    if (!imageCache.has(b64)) {
      imageCache.set(b64, (async () => {
        const bin = Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
        return bin[0] === 0x89 ? doc.embedPng(bin) : doc.embedJpg(bin);
      })().catch(() => null));
    }
    return imageCache.get(b64);
  }

  const listCounters = new Map();

  // ---- paragraph → lines --------------------------------------------------
  // A line is { items: [{kind, x, w, ...}], height, ascent }.
  async function layoutParagraph(pEl, width) {
    const pa = { ...baseStyle, ...(styles[pEl.getAttribute('resolver')] || {}), ...attrsOf(pEl) };
    const align = parseInt(pa.Alignment || '0', 10);
    const left = num(pa.LeftIndent), right = num(pa.RightIndent);
    const firstIndent = num(pa.FirstLineIndent);
    const hanging = num(pa.Hanging);
    const lineSpacing = num(pa.LineSpacing);
    const tabStops = String(pa.TabSet || '').split(',').map((t) => num(t.split(':')[0], NaN)).filter(Number.isFinite).sort((a, b) => a - b);

    // runs → tokens (words, spaces, tabs, images), each with its font
    const tokens = [];
    let firstSize = num(baseStyle.size, 12);
    let firstFont = null;
    for (const r of pEl.children) {
      const ra = { ...pa, ...(styles[r.getAttribute('resolver')] || {}), ...attrsOf(r) };
      const size = num(ra.size, 12);
      const f = await font(ra.family, bool(ra.bold), bool(ra.italic));
      if (!firstFont) { firstFont = f; firstSize = size; }
      const style = { font: f, size, color: color(ra.foreground), underline: bool(ra.underline) };
      if (r.tagName === 'image') {
        const img = ra.imageData ? await image(ra.imageData) : null;
        if (img) {
          let w = img.width, h = img.height;
          if (w > width) { h = h * width / w; w = width; }
          tokens.push({ kind: 'image', img, w, h, size: h / 1.15 });
        }
        continue;
      }
      const start = parseInt(ra.startOffset || '0', 10);
      const str = text.substr(start, parseInt(ra.length || '0', 10))
        .replace(/\r/g, '').replace(/\n/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
      for (const piece of str.match(/\t|[  ]+|[^\t  ]+/g) || []) {
        if (piece === '\t') tokens.push({ kind: 'tab', ...style, w: 0 });
        else if (/^[  ]+$/.test(piece)) tokens.push({ kind: 'space', ...style, str: piece, w: style.font.widthOfTextAtSize(piece, size) });
        else tokens.push({ kind: 'word', ...style, str: piece, w: style.font.widthOfTextAtSize(piece, size) });
      }
    }

    // numbered lists: "1. ", "a) ", "• " …
    if (pa.Numbered === 'true') {
      const key = `${pa.ListId || 0}:${pa.ListLevel || 1}`;
      const n = (listCounters.get(key) || 0) + 1;
      listCounters.set(key, n);
      const type = pa.NumberType || '';
      const label = /BULLET/.test(type) ? '•'
        : /LETTER/.test(type) ? String.fromCharCode(96 + ((n - 1) % 26) + 1)
        : /ROMAN/.test(type) ? roman(n) : String(n);
      const suffix = /PARENTHESIS/.test(type) ? ')' : /BULLET/.test(type) ? '' : '.';
      const f = firstFont || await font(baseStyle.family, false, false);
      const s = `${label}${suffix} `;
      tokens.unshift({ kind: 'word', font: f, size: firstSize, color: rgb(0, 0, 0), str: s, w: f.widthOfTextAtSize(s, firstSize), prefix: true });
    }

    const lines = [];
    let line = null;
    const newLine = () => {
      const indent = left + (lines.length === 0 ? firstIndent : hanging);
      line = { items: [], indent, avail: Math.max(20, width - indent - right), x: 0 };
      lines.push(line);
    };
    newLine();
    for (const t of tokens) {
      if (t.kind === 'tab') {
        const at = line.indent + line.x;
        const stop = tabStops.find((s) => s > at + 0.5) ?? (Math.floor(at / 36) + 1) * 36;
        const w = Math.max(0, stop - at);
        if (line.x + w > line.avail && line.items.length) { newLine(); continue; }
        line.items.push({ ...t, w, x: line.x });
        line.x += w;
        continue;
      }
      if (t.kind === 'space') {
        if (!line.items.length && lines.length > 1) continue; // no leading spaces after a wrap
        line.items.push({ ...t, x: line.x });
        line.x += t.w;
        continue;
      }
      if (line.x + t.w > line.avail && line.items.some((i) => i.kind !== 'space')) newLine();
      if (t.kind === 'word' && t.w > line.avail) {
        // a single word wider than the line: break it by characters
        let chunk = '';
        for (const ch of t.str) {
          const w = t.font.widthOfTextAtSize(chunk + ch, t.size);
          if (line.x + w > line.avail && chunk) {
            line.items.push({ ...t, str: chunk, w: t.font.widthOfTextAtSize(chunk, t.size), x: line.x });
            newLine();
            chunk = ch;
          } else chunk += ch;
        }
        const w = t.font.widthOfTextAtSize(chunk, t.size);
        line.items.push({ ...t, str: chunk, w, x: line.x });
        line.x += w;
        continue;
      }
      line.items.push({ ...t, x: line.x });
      line.x += t.w;
    }

    // vertical metrics + alignment
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      while (l.items.length && l.items[l.items.length - 1].kind === 'space') l.items.pop();
      const used = l.items.length ? l.items[l.items.length - 1].x + l.items[l.items.length - 1].w : 0;
      let maxSize = l.items.length ? 0 : firstSize;
      let imgH = 0;
      for (const it of l.items) {
        if (it.kind === 'image') imgH = Math.max(imgH, it.h);
        else maxSize = Math.max(maxSize, it.size);
      }
      l.ascent = Math.max(imgH, maxSize * 0.891);
      l.height = Math.max(imgH + maxSize * 0.25, maxSize * 1.15) * (1 + lineSpacing);
      const slack = l.avail - used;
      let shift = 0;
      if (align === 1) shift = slack / 2;
      else if (align === 2) shift = slack;
      else if (align === 3 && i < lines.length - 1 && slack > 0 && !l.items.some((t) => t.kind === 'tab')) {
        const spaces = l.items.filter((t) => t.kind === 'space');
        if (spaces.length) {
          const add = slack / spaces.length;
          let acc = 0;
          for (const it of l.items) {
            it.x += acc;
            if (it.kind === 'space') { it.w += add; acc += add; }
          }
        }
      }
      for (const it of l.items) it.x += l.indent + shift;
    }
    return { lines, above: num(pa.SpaceAbove), below: num(pa.SpaceBelow) };
  }

  // ---- blocks → measured boxes ---------------------------------------------
  async function layoutBlocks(parent, width) {
    const blocks = [];
    for (const el of parent.children) {
      if (el.tagName === 'paragraph') blocks.push({ kind: 'para', ...(await layoutParagraph(el, width)) });
      else if (el.tagName === 'table') blocks.push(await layoutTable(el, width));
    }
    return blocks;
  }

  async function layoutTable(tEl, width) {
    const cols = Math.max(1, parseInt(tEl.getAttribute('columnCount') || '0', 10)
      || Math.max(...[...tEl.querySelectorAll(':scope > row')].map((r) => r.querySelectorAll(':scope > cell').length), 1));
    const spans = String(tEl.getAttribute('columnSpans') || '').split(',').map((s) => num(s, NaN));
    const total = spans.length === cols && spans.every(Number.isFinite) ? spans.reduce((a, b) => a + b, 0) : 0;
    const colW = Array.from({ length: cols }, (_, i) => (total ? spans[i] / total : 1 / cols) * width);
    const bordered = (tEl.getAttribute('border') || 'borderNone') !== 'borderNone';
    const rows = [];
    for (const rEl of tEl.querySelectorAll(':scope > row')) {
      const cells = [];
      let x = 0;
      let h = num(rEl.getAttribute('height'));
      const cellEls = [...rEl.querySelectorAll(':scope > cell')];
      for (let c = 0; c < cellEls.length; c++) {
        const w = colW[Math.min(c, cols - 1)];
        const blocks = await layoutBlocks(cellEls[c], w - 4);
        const ch = blocksHeight(blocks) + 4;
        cells.push({ x, w, blocks });
        h = Math.max(h, ch);
        x += w;
      }
      rows.push({ cells, height: h });
    }
    return { kind: 'table', rows, bordered, width };
  }

  function blocksHeight(blocks) {
    let h = 0;
    for (const b of blocks) {
      if (b.kind === 'para') h += b.above + b.lines.reduce((s, l) => s + l.height, 0) + b.below;
      else h += b.rows.reduce((s, r) => s + r.height, 0);
    }
    return h;
  }

  // ---- drawing --------------------------------------------------------------
  function drawLine(page, l, x0, top) {
    const base = top - l.ascent;
    for (const it of l.items) {
      if (it.kind === 'image') {
        page.drawImage(it.img, { x: x0 + it.x, y: base, width: it.w, height: it.h });
      } else if (it.kind === 'word' || (it.kind === 'space' && it.underline)) {
        if (it.kind === 'word') page.drawText(it.str, { x: x0 + it.x, y: base, size: it.size, font: it.font, color: it.color });
        if (it.underline) {
          page.drawLine({ start: { x: x0 + it.x, y: base - it.size * 0.12 }, end: { x: x0 + it.x + it.w, y: base - it.size * 0.12 }, thickness: Math.max(0.5, it.size / 18), color: it.color });
        }
      }
    }
  }

  // draw blocks at a fixed spot (table cells, header, footer) — no paging
  function drawBlocksAt(page, blocks, x0, top) {
    let y = top;
    for (const b of blocks) {
      if (b.kind === 'para') {
        y -= b.above;
        for (const l of b.lines) { drawLine(page, l, x0, y); y -= l.height; }
        y -= b.below;
      } else {
        for (const r of b.rows) { drawRow(page, b, r, x0, y); y -= r.height; }
      }
    }
  }

  function drawRow(page, table, row, x0, top) {
    for (const c of row.cells) {
      drawBlocksAt(page, c.blocks, x0 + c.x + 2, top - 2);
      if (table.bordered) {
        page.drawRectangle({ x: x0 + c.x, y: top - row.height, width: c.w, height: row.height, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
      }
    }
  }

  // ---- header / footer --------------------------------------------------------
  const headerEl = elementsEl?.querySelector(':scope > header');
  const footerEl = elementsEl?.querySelector(':scope > footer');
  const header = headerEl ? await layoutBlocks(headerEl, contentW) : null;
  const footer = footerEl ? await layoutBlocks(footerEl, contentW) : null;
  const headerStart = num(headerEl?.getAttribute('startPage'), 1);
  const headerH = header ? blocksHeight(header) : 0;
  const footerH = footer ? blocksHeight(footer) : 0;
  const footerHasPageNo = !!footerEl?.getAttribute('pageNumber-spec');
  const footerReserve = footerH + (footerHasPageNo ? 14 : 0);

  // ---- body: flow onto pages ------------------------------------------------------
  const body = elementsEl ? await layoutBlocks(elementsEl, contentW) : [];
  const pages = [];
  let page = null;
  let y = 0;
  let bottomLimit = 0;
  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    pages.push(page);
    const n = pages.length;
    const top = header && n >= headerStart ? Math.max(M.top, M.headerOff + headerH + 6) : M.top;
    y = pageH - top;
    bottomLimit = footer ? Math.max(M.bottom, 20) + footerReserve + 6 : M.bottom;
  };
  newPage();
  for (const b of body) {
    if (b.kind === 'para') {
      y -= b.above;
      for (const l of b.lines) {
        if (y - l.height < bottomLimit && y < pageH - M.top - 1) newPage();
        drawLine(page, l, M.left, y);
        y -= l.height;
      }
      y -= b.below;
    } else {
      for (const r of b.rows) {
        if (y - r.height < bottomLimit && y < pageH - M.top - 1) newPage();
        drawRow(page, b, r, M.left, y);
        y -= r.height;
      }
    }
  }

  // headers / footers once the page count is known
  const pnFont = await font('Arial', false, false);
  pages.forEach((p, i) => {
    if (header && i + 1 >= headerStart) drawBlocksAt(p, header, M.left, pageH - M.headerOff);
    if (footer) {
      const fb = Math.max(M.bottom, 20);
      drawBlocksAt(p, footer, M.left, fb + footerReserve);
      if (footerHasPageNo) {
        const sep = footerEl.getAttribute('pageNumber-seperator') || '/';
        const s = `${i + 1} ${sep} ${pages.length}`;
        const size = num(footerEl.getAttribute('pageNumber-fontSize'), 10);
        p.drawText(s, { x: pageW - M.right - pnFont.widthOfTextAtSize(s, size), y: fb, size, font: pnFont, color: rgb(0.3, 0.3, 0.3) });
      }
    }
  });

  doc.setTitle(text.trim().split('\n')[0]?.slice(0, 120) || 'UYAP document');
  doc.setProducer('egPDF (from UYAP .udf)');
  return await doc.save();
}

function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}
