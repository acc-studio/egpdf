// Dictionary-backed OCR spelling repair. Two bundled frequency lists
// (vendor/dict — English from SymSpell, Turkish from FrequencyWords) are
// loaded lazily through the native bridge, so the same corrector runs on
// desktop and web. A token is only ever replaced by a word that differs
// purely by known glyph confusions, so a fix can never change what the page
// visually says.

// Character pairs OCR routinely confuses (both directions). A candidate word
// is considered only when it differs from the OCR output purely by these —
// "reguested" → "requested" (g↔q) qualifies, "regulated" does not.
export const CONFUSION_PAIRS = [
  ['g', 'q'], ['l', 'i'], ['c', 'e'], ['h', 'b'], ['f', 't'], ['v', 'y'],
  ['u', 'v'], ['a', 'o'], ['n', 'r'],
  // Turkish diacritics dropped or hallucinated by the engine
  ['i', 'ı'], ['l', 'ı'], ['s', 'ş'], ['c', 'ç'], ['g', 'ğ'], ['u', 'ü'], ['o', 'ö'],
  // German umlauts and eszett
  ['a', 'ä'], ['ss', 'ß'], ['b', 'ß'],
  // Arabic: same letter skeleton, dots/hamza misread (ب ت ث ن, ج ح خ, …)
  ['ب', 'ت'], ['ب', 'ث'], ['ب', 'ن'], ['ت', 'ث'], ['ت', 'ن'], ['ث', 'ن'],
  ['ج', 'ح'], ['ح', 'خ'], ['ج', 'خ'], ['د', 'ذ'], ['ر', 'ز'], ['س', 'ش'],
  ['ص', 'ض'], ['ط', 'ظ'], ['ع', 'غ'], ['ف', 'ق'], ['ه', 'ة'], ['ي', 'ى'],
  ['و', 'ؤ'], ['ي', 'ئ'], ['ا', 'أ'], ['ا', 'إ'], ['ا', 'آ'],
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

// ---- bundled dictionaries ---------------------------------------------------

// Corpus frequencies differ per word list, so the thresholds are deliberately
// coarse: a dictionary word at/above SOLID_FREQ is never touched; a
// replacement must be at least MIN_TARGET common AND BOOST times more common
// than the original (subtitle corpora contain typos in their tail — e.g.
// "davaci" appears with a tiny count next to the real "davacı").
const SOLID_FREQ = 100;
const MIN_TARGET = 100;
const BOOST = 30;

const LANGS = ['en', 'tr', 'de', 'ar'];
const dicts = { en: null, tr: null, de: null, ar: null }; // Map(word → corpus count)
let loadPromise = null;

// Idempotent; call (and await) before recognition so dictFixCore below can
// stay synchronous. A missing list degrades silently — the corrector then
// leaves those words to the OS-spellchecker fallback.
export function ensureDictLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      for (const lang of LANGS) {
        try {
          const text = await window.native.dictText(lang);
          const map = new Map();
          for (const line of text.split('\n')) {
            const sp = line.indexOf(' ');
            if (sp > 0) map.set(line.slice(0, sp), +line.slice(sp + 1));
          }
          if (map.size) dicts[lang] = map;
        } catch { /* bridge or asset missing */ }
      }
    })();
  }
  return loadPromise;
}

// Lowercase both ways: the Turkish dotted/dotless i pair needs the tr locale
// ('İ'→'i', 'I'→'ı'), everything else the default one.
function lowerForms(word) {
  return [...new Set([word.toLowerCase(), word.toLocaleLowerCase('tr-TR')])];
}

function bestEntry(word) {
  let best = null;
  for (const lang of LANGS) {
    const freq = dicts[lang]?.get(word);
    if (freq && (!best || freq > best.freq)) best = { word, freq, lang };
  }
  return best;
}

// True when the (case-insensitive) word is a solidly-attested dictionary
// word — used by the engine-alternatives rescorer in ocrbox.js.
export function isDictWord(word) {
  for (const f of lowerForms(word)) {
    const e = bestEntry(f);
    if (e && e.freq >= SOLID_FREQ) return true;
  }
  return false;
}

// All strings one confusion substitution away from `word`.
function oneEdit(word) {
  const out = new Set();
  for (const [x, y] of CONFUSION_PAIRS) {
    for (const [from, to] of [[x, y], [y, x]]) {
      let i = word.indexOf(from);
      while (i !== -1) {
        out.add(word.slice(0, i) + to + word.slice(i + from.length));
        i = word.indexOf(from, i + 1);
      }
    }
  }
  return out;
}

function pickBest(candidates) {
  let best = null;
  for (const c of candidates) {
    const e = bestEntry(c);
    if (e && (!best || e.freq > best.freq)) best = e;
  }
  return best;
}

function restoreCase(orig, fixed, lang) {
  const locale = lang === 'tr' ? 'tr-TR' : undefined;
  if (orig === orig.toLocaleUpperCase(locale)) return fixed.toLocaleUpperCase(locale);
  if (/^\p{Lu}/u.test(orig)) return fixed.charAt(0).toLocaleUpperCase(locale) + fixed.slice(1);
  return fixed;
}

// Repair one letters-only token core against the bundled dictionaries.
// Returns the (possibly unchanged) core when the dictionaries had an opinion,
// or null when they know nothing about it — the caller may then fall back to
// the OS spellchecker.
export function dictFixCore(core) {
  if (!dicts.en && !dicts.tr) return null;
  const forms = lowerForms(core);
  let ownFreq = 0;
  for (const f of forms) {
    const e = bestEntry(f);
    if (e) ownFreq = Math.max(ownFreq, e.freq);
  }
  if (ownFreq >= SOLID_FREQ) return core;

  const one = new Set(forms.flatMap((f) => [...oneEdit(f)]));
  let best = pickBest(one);
  if (!best) {
    const two = new Set();
    for (const c of one) for (const v of oneEdit(c)) two.add(v);
    forms.forEach((f) => two.delete(f)); // two edits can cancel out
    best = pickBest(two);
  }
  if (best && best.freq >= Math.max(MIN_TARGET, BOOST * ownFreq)) {
    return restoreCase(core, best.word, best.lang);
  }
  // A weak dictionary word with no clearly better variant is still a word —
  // claim it so the OS fallback can't rewrite it either.
  return ownFreq > 0 ? core : null;
}
