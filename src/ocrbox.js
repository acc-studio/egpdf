// Area OCR: recognize a user-drawn rectangle and hand back plain text (no
// text layer is written). Works on scanned pages and on pages that already
// have a text layer, because it always reads from the rendered pixels.
// Includes a conservative cleanup pass that fixes the obvious OCR mistakes:
// ligatures, words glued together, punctuation with the space missing, and
// end-of-line hyphenation.

import { dictFixCore, ensureDictLoaded, isConfusionVariant, isDictWord } from './spellfix.js';

// re-exported for callers (ocr.js, autotest.js) that treat this module as the
// cleanup façade
export { ensureDictLoaded, isConfusionVariant };

const MIN_CONFIDENCE = 30;

// ---- cleanup ---------------------------------------------------------------

const LIGATURES = { 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st' };

// Word-shaped things we must never split: URLs, e-mails, file paths, and
// anything with digits (case numbers like "2026/713-K", "iPhone13"…).
const NO_TOUCH = /[0-9@\\/_]|:\/\/|www\./;

// Per-word fixes, safe enough to apply to the invisible OCR text layer too.
export function cleanOcrWord(text) {
  let t = text.replace(/­/g, ''); // soft hyphens
  t = t.replace(/[ﬁﬂﬀﬃﬄﬅﬆ]/g, (c) => LIGATURES[c]);
  if (NO_TOUCH.test(t)) return t;
  // "kelimeBaşka" → "kelime Başka": a lowercase→uppercase seam inside a word
  // is almost always two words the OCR merged. Require ≥2 letters on both
  // sides so "aB" fragments and initials stay untouched.
  t = t.replace(/(\p{Ll}{2,})(\p{Lu}\p{L}+)/gu, '$1 $2');
  // "Ancak,davacı" → "Ancak, davacı": sentence punctuation glued to the next
  // word. ≥2 letters before the mark keeps abbreviations like "T.C." intact.
  t = t.replace(/(\p{L}{2,}[.,;:!?،؛؟])(\p{L}{2,})/gu, '$1 $2');
  return t.split(' ').map(spellFixToken).join(' ');
}

// ---- engine-alternatives rescoring -------------------------------------------

// Tesseract reports alternative readings per word. When its top pick isn't a
// dictionary word but a nearly-as-confident alternative is, take the
// alternative — it's another reading of the same pixels, so it can't say
// anything the page doesn't show.
const coreOf = (t) => (/^\P{L}*(\p{L}{3,})\P{L}*$/u.exec(t) || [])[1];

export function pickWordText(w) {
  if (!w.choices || w.choices.length < 2) return w.text;
  const topCore = coreOf(w.text);
  if (!topCore || isDictWord(topCore)) return w.text;
  for (const c of w.choices) {
    if (c.text === w.text || c.confidence < w.confidence - 15) continue;
    const core = coreOf(c.text);
    if (core && isDictWord(core)) return c.text;
  }
  return w.text;
}

// ---- dictionary-backed glyph-confusion repair -------------------------------

// Bundled tr+en frequency dictionaries first (deterministic, works on web);
// when they have no opinion, the OS spellchecker (desktop only) is asked. In
// both paths a fix is accepted only when it's a pure glyph-confusion variant
// of what the OCR produced, so a fix can never turn the word into something
// the page doesn't visually show.
function spellFixToken(token) {
  const m = /^(\P{L}*)(\p{L}{3,})(\P{L}*)$/u.exec(token);
  if (!m) return token;
  const [, pre, core, post] = m;
  const dictFix = dictFixCore(core);
  if (dictFix !== null) return pre + dictFix + post;
  const suggest = typeof window !== 'undefined' && window.native?.spellSuggest;
  if (!suggest) return token;
  const suggestions = suggest(core);
  if (!suggestions) return token;
  for (const s of suggestions.slice(0, 5)) {
    if (isConfusionVariant(core, s)) return pre + s + post;
  }
  return token;
}

// Lines inside a Tesseract paragraph are visual wrapping, not semantic
// breaks — join them with spaces (handling end-of-line hyphenation) so the
// copied text flows like the sentences it came from. Paragraphs stay
// separated by a blank line.
function joinParagraphLines(lineTexts) {
  let out = '';
  for (const line of lineTexts) {
    if (!out) { out = line; continue; }
    if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out;
}

// Assemble recognized words into text, preserving the paragraph structure
// Tesseract found, then run flow-level fixes.
export function assembleOcrText(words) {
  const paras = new Map();
  for (const w of words) {
    if (w.confidence < MIN_CONFIDENCE) continue;
    if (!paras.has(w.para)) paras.set(w.para, new Map());
    const lines = paras.get(w.para);
    if (!lines.has(w.line)) lines.set(w.line, []);
    lines.get(w.line).push(cleanOcrWord(pickWordText(w)));
  }
  const text = [...paras.values()]
    .map((lines) => joinParagraphLines([...lines.values()].map((ws) => ws.join(' '))))
    .join('\n\n');
  return cleanOcrFlow(text);
}

// Fixes that need to see across line breaks.
export function cleanOcrFlow(text) {
  let t = text;
  // End-of-line hyphenation: "kelime-\nler devamı" → "kelimeler\ndevamı".
  // Only when the continuation starts lowercase — a dash before a capital is
  // usually a real dash.
  t = t.replace(/(\p{L})-\n(\p{Ll}\S*)[ \t]*/gu, '$1$2\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// ---- image preprocessing -----------------------------------------------------

// Grayscale + percentile contrast stretch before recognition. Digital renders
// (already black-on-white) map ~identically through the LUT; faded, yellowed,
// or low-contrast scans gain the separation Tesseract's binarizer needs.
export function preprocessForOcr(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
    d[i] = g; // stash gray in the red channel
    hist[g]++;
  }
  // stretch between the 1st and 99th percentile
  const cut = (w * h) / 100;
  let lo = 0, hi = 255;
  for (let v = 0, a = 0; v < 256; v++) { a += hist[v]; if (a >= cut) { lo = v; break; } }
  for (let v = 255, a = 0; v >= 0; v--) { a += hist[v]; if (a >= cut) { hi = v; break; } }
  if (hi - lo < 32) return; // near-uniform image (blank margin) — leave it
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = lut[d[i]];
  }
  ctx.putImageData(img, 0, 0);
}

// ---- region rendering + recognition ----------------------------------------

// Render just the selected rectangle. Tesseract wants roughly 300 dpi, and
// small clips of fine print need more — so upscale small boxes to ~1600 px on
// the long side, and cap huge ones at 4000 px.
async function renderRegionImage(pdf, pageNum, rect) {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const [ax, ay] = base.convertToViewportPoint(rect.x, rect.y);
  const [bx, by] = base.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
  const left = Math.min(ax, bx), top = Math.min(ay, by);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  const maxDim = Math.max(w, h, 1);
  const scale = Math.min(4000 / maxDim, Math.max(300 / 72, 1600 / maxDim));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.floor(w * scale));
  canvas.height = Math.max(8, Math.floor(h * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const viewport = page.getViewport({ scale, offsetX: -left * scale, offsetY: -top * scale });
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  preprocessForOcr(ctx, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// rect is in PDF user space ({x, y, w, h}, origin bottom-left). Returns the
// recognized, cleaned-up text ('' when nothing was found).
export async function ocrArea(pdf, pageNum, rect) {
  const dictReady = ensureDictLoaded(); // overlaps with render + recognition
  const png = await renderRegionImage(pdf, pageNum, rect);
  const words = await window.native.ocrRecognize(png, 'area');
  await dictReady;
  return assembleOcrText(words);
}
