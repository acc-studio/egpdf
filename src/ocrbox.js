// Area OCR: recognize a user-drawn rectangle and hand back plain text (no
// text layer is written). Works on scanned pages and on pages that already
// have a text layer, because it always reads from the rendered pixels.
// Includes a conservative cleanup pass that fixes the obvious OCR mistakes:
// ligatures, words glued together, punctuation with the space missing, and
// end-of-line hyphenation.

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
  t = t.replace(/(\p{L}{2,}[.,;:!?])(\p{L}{2,})/gu, '$1 $2');
  return t.split(' ').map(spellFixToken).join(' ');
}

// ---- dictionary-backed glyph-confusion repair -------------------------------

// Character pairs OCR routinely confuses (both directions). A dictionary
// suggestion is accepted only when it differs from the OCR output purely by
// these — "reguested" → "requested" (g↔q) is taken, but a suggestion that
// changes the word in any other way is rejected, so the fix can never turn
// the word into something the page doesn't visually show.
const CONFUSION_PAIRS = [
  ['g', 'q'], ['l', 'i'], ['c', 'e'], ['h', 'b'], ['f', 't'], ['v', 'y'],
  ['u', 'v'], ['a', 'o'], ['n', 'r'],
  // Turkish diacritics dropped or hallucinated by the engine
  ['i', 'ı'], ['l', 'ı'], ['s', 'ş'], ['c', 'ç'], ['g', 'ğ'], ['u', 'ü'], ['o', 'ö'],
  // multi-character confusions
  ['rn', 'm'], ['vv', 'w'], ['cl', 'd'], ['ii', 'ü'],
];
const MAX_CONFUSION_EDITS = 2;

// True when `a` can be turned into `b` with at most MAX_CONFUSION_EDITS
// substitutions from CONFUSION_PAIRS, everything else matching exactly
// (case-insensitive).
export function isConfusionVariant(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return false;
  const memo = new Map();
  const walk = (i, j, edits) => {
    if (edits > MAX_CONFUSION_EDITS) return false;
    if (i === a.length || j === b.length) return i === a.length && j === b.length;
    const key = (i * (b.length + 1) + j) * (MAX_CONFUSION_EDITS + 1) + edits;
    if (memo.has(key)) return memo.get(key);
    let ok = a[i] === b[j] && walk(i + 1, j + 1, edits);
    for (const [x, y] of CONFUSION_PAIRS) {
      if (ok) break;
      if (a.startsWith(x, i) && b.startsWith(y, j)) ok = walk(i + x.length, j + y.length, edits + 1);
      if (!ok && a.startsWith(y, i) && b.startsWith(x, j)) ok = walk(i + y.length, j + x.length, edits + 1);
    }
    memo.set(key, ok);
    return ok;
  };
  return walk(0, 0, 0);
}

// Ask the OS spellchecker (fully local, no-op when no dictionary is loaded)
// about a token; adopt a suggestion only when it's a pure glyph-confusion
// variant of what the OCR produced.
function spellFixToken(token) {
  const suggest = typeof window !== 'undefined' && window.native?.spellSuggest;
  if (!suggest) return token;
  const m = /^(\P{L}*)(\p{L}{3,})(\P{L}*)$/u.exec(token);
  if (!m) return token;
  const [, pre, core, post] = m;
  const suggestions = suggest(core);
  if (!suggestions) return token;
  for (const s of suggestions.slice(0, 5)) {
    if (isConfusionVariant(core, s)) return pre + s + post;
  }
  return token;
}

// Assemble recognized words into text, preserving the paragraph/line
// structure Tesseract found, then run flow-level fixes.
export function assembleOcrText(words) {
  const paras = new Map();
  for (const w of words) {
    if (w.confidence < MIN_CONFIDENCE) continue;
    if (!paras.has(w.para)) paras.set(w.para, new Map());
    const lines = paras.get(w.para);
    if (!lines.has(w.line)) lines.set(w.line, []);
    lines.get(w.line).push(cleanOcrWord(w.text));
  }
  const text = [...paras.values()]
    .map((lines) => [...lines.values()].map((ws) => ws.join(' ')).join('\n'))
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
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// rect is in PDF user space ({x, y, w, h}, origin bottom-left). Returns the
// recognized, cleaned-up text ('' when nothing was found).
export async function ocrArea(pdf, pageNum, rect) {
  const png = await renderRegionImage(pdf, pageNum, rect);
  const words = await window.native.ocrRecognize(png);
  return assembleOcrText(words);
}
