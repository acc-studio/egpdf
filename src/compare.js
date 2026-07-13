// Text-based comparison of two documents: extracts words (tagged with their
// page), runs a word-level Myers diff, and groups changes into hunks.

async function extractWords(pdf, cache) {
  if (cache.words) return cache.words;
  const words = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const text = tc.items.map((i) => i.str).join(' ');
    for (const w of text.split(/\s+/)) {
      if (w) words.push({ w, page: n });
    }
  }
  cache.words = words;
  return words;
}

// Myers O(ND) diff over word arrays. Returns list of ops {type:'eq'|'del'|'ins', a, b, len}
// or null if the documents differ too much to diff cheaply (memory for the
// backtrack trace grows with D², so D is capped).
function diffWords(A, B, maxD = 2000) {
  // trim common prefix/suffix
  let start = 0;
  const aLen = A.length, bLen = B.length;
  while (start < aLen && start < bLen && A[start].w === B[start].w) start++;
  let endA = aLen, endB = bLen;
  while (endA > start && endB > start && A[endA - 1].w === B[endB - 1].w) { endA--; endB--; }

  const N = endA - start, M = endB - start;
  const ops = [];
  if (start) ops.push({ type: 'eq', a: 0, b: 0, len: start });

  if (N === 0 && M === 0) {
    if (endA < aLen) ops.push({ type: 'eq', a: endA, b: endB, len: aLen - endA });
    return ops;
  }

  const a = A.slice(start, endA).map((x) => x.w);
  const b = B.slice(start, endB).map((x) => x.w);
  const max = Math.min(N + M, maxD);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];
  let found = false, D = 0;
  outer:
  for (D = 0; D <= max; D++) {
    trace.push(v.slice());
    for (let k = -D; k <= D; k += 2) {
      let x;
      if (k === -D || (k !== D && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { found = true; break outer; }
    }
  }
  if (!found) return null; // too different

  // backtrack
  const script = []; // 1 = del from a, 2 = ins from b, 0 = eq
  let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push(0); x--; y--; }
    if (d > 0) {
      if (x === prevX) { script.push(2); y--; } else { script.push(1); x--; }
    }
  }
  while (x > 0 && y > 0) { script.push(0); x--; y--; }
  while (x > 0) { script.push(1); x--; }
  while (y > 0) { script.push(2); y--; }
  script.reverse();

  // convert to ops with absolute indices
  let ai = start, bi = start;
  for (const s of script) {
    const last = ops[ops.length - 1];
    if (s === 0) {
      if (last && last.type === 'eq' && last.a + last.len === ai) last.len++;
      else ops.push({ type: 'eq', a: ai, b: bi, len: 1 });
      ai++; bi++;
    } else if (s === 1) {
      if (last && last.type === 'del' && last.a + last.len === ai) last.len++;
      else ops.push({ type: 'del', a: ai, b: bi, len: 1 });
      ai++;
    } else {
      if (last && last.type === 'ins' && last.b + last.len === bi) last.len++;
      else ops.push({ type: 'ins', a: ai, b: bi, len: 1 });
      bi++;
    }
  }
  if (endA < aLen) {
    const last = ops[ops.length - 1];
    if (last && last.type === 'eq' && last.a + last.len === endA) last.len += aLen - endA;
    else ops.push({ type: 'eq', a: endA, b: endB, len: aLen - endA });
  }
  return ops;
}

const CTX = 4;
const joinW = (arr, from, len) => arr.slice(from, from + len).map((x) => x.w).join(' ');

/**
 * Compare two loaded pdf.js documents.
 * Returns { identical, tooDifferent, hunks: [{pageA, pageB, ctxBefore, del, ins, ctxAfter}] }
 */
export async function compareDocs(pdfA, pdfB, cacheA = {}, cacheB = {}) {
  const A = await extractWords(pdfA, cacheA);
  const B = await extractWords(pdfB, cacheB);
  const ops = diffWords(A, B);
  if (ops === null) return { identical: false, tooDifferent: true, hunks: [] };

  const hunks = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'eq') continue;
    // merge adjacent del+ins (or ins+del) into one replace hunk
    let del = null, ins = null;
    if (ops[i].type === 'del') { del = ops[i]; if (ops[i + 1]?.type === 'ins') ins = ops[++i]; }
    else { ins = ops[i]; if (ops[i + 1]?.type === 'del') del = ops[++i]; }

    const aPos = del ? del.a : ins.a;
    const bPos = ins ? ins.b : del.b;
    hunks.push({
      pageA: A[Math.min(aPos, A.length - 1)]?.page ?? 1,
      pageB: B[Math.min(bPos, B.length - 1)]?.page ?? 1,
      ctxBefore: joinW(A, Math.max(0, aPos - CTX), Math.min(CTX, aPos)),
      del: del ? joinW(A, del.a, del.len) : '',
      ins: ins ? joinW(B, ins.b, ins.len) : '',
      ctxAfter: del
        ? joinW(A, del.a + del.len, CTX)
        : joinW(B, ins.b + ins.len, CTX),
    });
  }
  return { identical: hunks.length === 0, tooDifferent: false, hunks };
}
