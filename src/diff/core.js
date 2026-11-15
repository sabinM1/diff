// Diffbench diff engine — pure functions, no DOM, runs in the Web Worker
// and in Node for tests.
//
// Strategy:
//   1. common prefix/suffix trim          — O(min(N,M)) on the hot path
//   2. patience anchoring on unique lines — makes real-world diffs near-linear
//   3. linear-space Myers (middle snake)  — minimal diff, O(N+D) memory
//   4. wholesale fallback under a step budget — bounded runtime, valid output
//
// ops are emitted as a flat array of [code, count] pairs:
//   code 0 = equal, 1 = deleted from A, 2 = inserted into B.

export const OP_EQ = 0;
export const OP_DEL = 1;
export const OP_INS = 2;

// Above this many inner-loop steps we stop searching for a minimal diff and
// emit the remaining range as delete+insert. Typical inputs never get near
// it; it only caps pathological all-different inputs.
const STEP_BUDGET = 40_000_000;
const PATIENCE_DEPTH_CAP = 64;

function makeCtx() {
  return { budget: STEP_BUDGET, depth: 0, vf: null, vb: null };
}

// ---------------------------------------------------------------- Myers ----

// Generic divide-and-conquer Myers over two sequences accessed by index.
// seqA is addressed as a[a0 + x], seqB as b[b0 + y]; `eq(ax, bx)` compares
// absolute positions. Emits flat ops into `out`. Trims emit their equal
// runs, and every exit path accounts for the trimmed suffix, so the op
// stream always covers both sequences completely.
function diffRange(a, a0, a1, b, b0, b1, eq, out, ctx) {
  ctx.rd = (ctx.rd ?? 0) + 1;
  if (ctx.rd > 2048) {
    // safety net, unreachable for real inputs
    const n = a1 - a0, m = b1 - b0;
    if (n) pushRun(out, OP_DEL, n);
    if (m) pushRun(out, OP_INS, m);
    ctx.rd--;
    return;
  }
  let pre = 0;
  while (a0 < a1 && b0 < b1 && eq(a0, b0)) { a0++; b0++; pre++; }
  if (pre) pushRun(out, OP_EQ, pre);
  let suf = 0;
  while (a1 > a0 && b1 > b0 && eq(a1 - 1, b1 - 1)) { a1--; b1--; suf++; }
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) { ctx.rd--; return; }
  if (m === 0) { pushRun(out, OP_DEL, n); pushRun(out, OP_EQ, suf); ctx.rd--; return; }
  if (n === 0) { pushRun(out, OP_INS, m); pushRun(out, OP_EQ, suf); ctx.rd--; return; }

  ctx.depth++;
  const snake = ctx.depth < 48 ? middleSnake(a, a0, a1, b, b0, b1, eq, ctx) : null;
  ctx.depth--;
  if (!snake) {
    // budget exhausted (or depth cap): valid, non-minimal wholesale diff
    pushRun(out, OP_DEL, n);
    pushRun(out, OP_INS, m);
    pushRun(out, OP_EQ, suf);
    ctx.rd--;
    return;
  }
  // A middle snake that touches the very start or end of BOTH ranges
  // would recurse into an identical subproblem; resolve one line pair
  // greedily instead (eq(a0,b0) is false here, so this is safe).
  if ((snake.sx === a1 && snake.sy === b1) || (snake.ex === a0 && snake.ey === b0)) {
    pushRun(out, OP_DEL, 1);
    ctx.budget -= n + m;
    diffRange(a, a0 + 1, a1, b, b0, b1, eq, out, ctx);
    pushRun(out, OP_EQ, suf);
    ctx.rd--;
    return;
  }
  diffRange(a, a0, snake.sx, b, b0, snake.sy, eq, out, ctx);
  if (snake.ex > snake.sx) pushRun(out, OP_EQ, snake.ex - snake.sx);
  diffRange(a, snake.ex, a1, b, snake.ey, b1, eq, out, ctx);
  pushRun(out, OP_EQ, suf);
  ctx.rd--;
}

function pushRun(out, code, count) {
  if (count <= 0) return; // zero-length runs break group/pair consumers
  const last = out.length - 2;
  if (last >= 0 && out[last] === code) out[last + 1] += count;
  else { out.push(code, count); }
}

// Finds the middle snake with the linear-space algorithm (Myers 1986).
// The backward search is literally the forward search over reversed access
// order, which keeps the tricky index bookkeeping in one place.
function middleSnake(a, a0, a1, b, b0, b1, eq, ctx) {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = n + m;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const off = max;
  if (!ctx.vf || ctx.vf.length < 2 * max + 4) {
    ctx.vf = new Int32Array(2 * max + 4);
    ctx.vb = new Int32Array(2 * max + 4);
  }
  const vf = ctx.vf;
  const vb = ctx.vb;
  // backward pass runs in reversed coordinates: reversed diagonal kr
  // corresponds to forward diagonal delta - kr. Both passes store at
  // index + off so the index range is always inside the shared buffer.
  const offB = off;
  vf[1 + off] = 0;
  vb[1 + offB] = 0;

  const eqB = (x, y) => eq(a1 - 1 - x, b1 - 1 - y);
  const dMax = Math.ceil(max / 2);

  for (let d = 0; d <= dMax; d++) {
    // forward step on diagonals [-d, d]
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && vf[k - 1 + off] < vf[k + 1 + off])) x = vf[k + 1 + off];
      else x = vf[k - 1 + off] + 1;
      let y = x - k;
      const sx = x, sy = y;
      while (x < n && y < m && eq(a0 + x, b0 + y)) { x++; y++; if (--ctx.budget < 0) return null; }
      vf[k + off] = x;
      if (odd) {
        const kr = delta - k;
        if (Math.abs(kr) <= d - 1) {
          const xb = n - vb[kr + offB];
          if (x >= xb) return { sx: a0 + sx, sy: b0 + sy, ex: a0 + x, ey: b0 + y };
        }
      }
    }
    // backward step on reversed diagonals [-d, d]
    for (let kr = -d; kr <= d; kr += 2) {
      let x;
      if (kr === -d || (kr !== d && vb[kr - 1 + offB] < vb[kr + 1 + offB])) x = vb[kr + 1 + offB];
      else x = vb[kr - 1 + offB] + 1;
      let y = x - kr;
      const sxr = x, syr = y;
      while (x < n && y < m && eqB(x, y)) { x++; y++; if (--ctx.budget < 0) return null; }
      vb[kr + offB] = x;
      if (!odd) {
        const k = delta - kr;
        if (Math.abs(k) <= d) {
          const xf = vf[k + off];
          if (xf >= n - x) {
            // reversed snake (sxr,syr)->(x,y) maps to forward (n-x, m-y)->(n-sxr, m-syr)
            return {
              sx: a0 + (n - x),
              sy: b0 + (m - y),
              ex: a0 + (n - sxr),
              ey: b0 + (m - syr),
            };
          }
        }
      }
    }
    ctx.budget -= 4 * d + 2;
    if (ctx.budget < 0) return null;
  }
  return null;
}

// ------------------------------------------------------------ patience ----

// Anchor on lines that appear exactly once in BOTH remaining ranges, keep
// the longest chain whose positions increase on both sides, recurse between
// anchors. This is what makes diffs of real files near-linear.
function patienceRange(a, a0, a1, b, b0, b1, eq, out, ctx) {
  diffTrim(a, a0, a1, b, b0, b1, eq, out, ctx, patienceRange);
}

function diffTrim(a, a0, a1, b, b0, b1, eq, out, ctx, rec) {
  let pre = 0;
  while (a0 < a1 && b0 < b1 && eq(a0, b0)) { a0++; b0++; pre++; }
  if (pre) pushRun(out, OP_EQ, pre);
  let suf = 0;
  while (a1 > a0 && b1 > b0 && eq(a1 - 1, b1 - 1)) { a1--; b1--; suf++; }
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return;
  if (m === 0) { pushRun(out, OP_DEL, n); pushRun(out, OP_EQ, suf); return; }
  if (n === 0) { pushRun(out, OP_INS, m); pushRun(out, OP_EQ, suf); return; }

  // count occurrences inside the current ranges only
  const countA = new Map();
  for (let i = a0; i < a1; i++) {
    const v = a[i];
    countA.set(v, (countA.get(v) ?? 0) + 1);
  }
  const posB = new Map();
  for (let j = b0; j < b1; j++) {
    const v = b[j];
    const arr = posB.get(v);
    if (arr) arr.push(j);
    else posB.set(v, [j]);
  }
  const cand = [];
  for (let i = a0; i < a1; i++) {
    if (countA.get(a[i]) !== 1) continue;
    const bp = posB.get(a[i]);
    if (bp && bp.length === 1) cand.push([i, bp[0]]);
  }
  if (cand.length === 0 || ctx.depth >= PATIENCE_DEPTH_CAP) {
    diffRange(a, a0, a1, b, b0, b1, eq, out, ctx);
    pushRun(out, OP_EQ, suf);
    return;
  }

  // longest strictly-increasing chain over b positions (patience LIS)
  const tails = [];      // b index at the end of each pile
  const tailIdx = [];    // candidate index for each pile
  const prev = new Int32Array(cand.length).fill(-1);
  for (let c = 0; c < cand.length; c++) {
    const y = cand[c][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < y) lo = mid + 1; else hi = mid;
    }
    if (lo === tails.length) { tails.push(y); tailIdx.push(c); }
    else { tails[lo] = y; tailIdx[lo] = c; }
    prev[c] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  // walk back the winning chain
  const chain = [];
  for (let c = tailIdx[tailIdx.length - 1]; c !== -1; c = prev[c]) chain.push(cand[c]);
  chain.reverse();

  ctx.depth++;
  let pa = a0, pb = b0;
  for (const [ia, ib] of chain) {
    rec(a, pa, ia, b, pb, ib, eq, out, ctx);
    pushRun(out, OP_EQ, 1);
    pa = ia + 1;
    pb = ib + 1;
  }
  rec(a, pa, a1, b, pb, b1, eq, out, ctx);
  ctx.depth--;
  pushRun(out, OP_EQ, suf);
}

// ------------------------------------------------------------- top level --

// Splits text into lines, tolerating \r\n and a missing final newline.
// The trailing "" of a text ending with \n is dropped, but we keep the flag
// so both sides compare structurally.
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }
  return lines;
}

function normLine(line, ignoreWs) {
  return ignoreWs ? line.replace(/[ \t\f\v]+/g, ' ').trim() : line;
}

// Maps each line to a small int so comparisons are === on numbers.
function intern(lines, ignoreWs, pool) {
  const ints = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const key = normLine(lines[i], ignoreWs);
    let id = pool.get(key);
    if (id === undefined) { id = pool.size; pool.set(key, id); }
    ints[i] = id;
  }
  return ints;
}

// Full line diff. Returns ops + per-line word/char marks for changed pairs.
// opts: { ignoreWs, precision: 'smart' | 'word' | 'char' }
export function diffLines(aText, bText, opts = {}) {
  const ignoreWs = !!opts.ignoreWs;
  const precision = opts.precision ?? 'smart';
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  const pool = new Map();
  const aInt = intern(aLines, ignoreWs, pool);
  const bInt = intern(bLines, ignoreWs, pool);
  const ops = [];
  const ctx = makeCtx();
  patienceRange(aInt, 0, aInt.length, bInt, 0, bInt.length,
    (x, y) => aInt[x] === bInt[y], ops, ctx);

  // stats
  let added = 0, removed = 0, hunks = 0;
  let inHunk = false;
  let maxLen = 0;
  for (let i = 0; i < ops.length; i += 2) {
    const code = ops[i], count = ops[i + 1];
    if (code === OP_INS) added += count;
    else if (code === OP_DEL) removed += count;
    if (code !== OP_EQ) {
      if (!inHunk) { hunks++; inHunk = true; }
    } else inHunk = false;
  }
  // Longest line width, computed in the same pass; the worker needs it for
  // the virtualized width budget without a second O(N) scan.
  for (let i = 0; i < aLines.length; i++) { const l = aLines[i].length; if (l > maxLen) maxLen = l; }
  for (let i = 0; i < bLines.length; i++) { const l = bLines[i].length; if (l > maxLen) maxLen = l; }

  // word/char marks for paired changed lines
  const marksA = new Map();
  const marksB = new Map();
  if (precision !== 'off' && (added + removed) > 0 && (added + removed) < 200_000) {
    let ai = 0, bi = 0;
    for (let i = 0; i < ops.length; i += 2) {
      const code = ops[i], count = ops[i + 1];
      if (code === OP_EQ) { ai += count; bi += count; continue; }
      // collect the del run and ins run of this group
      let dStart = -1, dLen = 0, iStart = -1, iLen = 0;
      let j = i;
      while (j < ops.length) {
        const c = ops[j], ct = ops[j + 1];
        if (c === OP_EQ) break;
        if (c === OP_DEL) { if (dStart < 0) dStart = ai; dLen += ct; ai += ct; }
        else { if (iStart < 0) iStart = bi; iLen += ct; bi += ct; }
        j += 2;
      }
      const pairCount = Math.min(dLen, iLen);
      for (let p = 0; p < pairCount; p++) {
        const la = aLines[dStart + p];
        const lb = bLines[iStart + p];
        if (normLine(la, ignoreWs) === normLine(lb, ignoreWs)) continue;
        let marks;
        if (precision === 'char') marks = charMarks(la, lb);
        else marks = wordMarks(la, lb, precision === 'smart');
        if (marks.a.length) marksA.set(dStart + p, marks.a);
        if (marks.b.length) marksB.set(iStart + p, marks.b);
      }
      i = j - 2;
    }
  }

  return { ops, aLines, bLines, marksA, marksB, stats: { added, removed, hunks, maxLen } };
}

// ------------------------------------------------------- word/char marks --

const WORD_RE = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]+/g;

function tokens(line) {
  const out = [];
  for (const m of line.matchAll(WORD_RE)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// Marks for one changed line pair. `smart` refines replaced word pairs with
// a common-affix char pass, `word` stops at word granularity.
function wordMarks(la, lb, smart) {
  const ta = tokens(la);
  const tb = tokens(lb);
  const ea = ta.map(t => la.slice(t[0], t[1]));
  const eb = tb.map(t => lb.slice(t[0], t[1]));
  const ops = [];
  const ctx = makeCtx();
  ctx.budget = 50_000;
  // word lists are short; the plain Myers path beats patience here
  diffRange(ea, 0, ea.length, eb, 0, eb.length, (x, y) => ea[x] === eb[y], ops, ctx);

  const ra = [], rb = [];
  let ia = 0, ib = 0;
  for (let i = 0; i < ops.length; i += 2) {
    const code = ops[i], count = ops[i + 1];
    if (code === OP_EQ) { ia += count; ib += count; continue; }
    let dS = -1, dN = 0, iS = -1, iN = 0, j = i;
    while (j < ops.length) {
      const c = ops[j], ct = ops[j + 1];
      if (c === OP_EQ) break;
      if (c === OP_DEL) { if (dS < 0) dS = ia; dN += ct; ia += ct; }
      else { if (iS < 0) iS = ib; iN += ct; ib += ct; }
      j += 2;
    }
    const pairs = Math.min(dN, iN);
    for (let p = 0; p < pairs && smart; p++) {
      // refine: replaced token pair → mark only the changed middle part
      const [s0, e0] = ta[dS + p];
      const [s1, e1] = tb[iS + p];
      const wa = la.slice(s0, e0);
      const wb = lb.slice(s1, e1);
      let pre = 0;
      const maxPre = Math.min(wa.length, wb.length);
      while (pre < maxPre && wa[pre] === wb[pre]) pre++;
      let suf = 0;
      while (suf < Math.min(wa.length, wb.length) - pre && wa[wa.length - 1 - suf] === wb[wb.length - 1 - suf]) suf++;
      if (pre + suf < wa.length) ra.push([s0 + pre, e0 - suf]);
      if (pre + suf < wb.length) rb.push([s1 + pre, e1 - suf]);
    }
    if (!smart) {
      for (let p = 0; p < dN; p++) ra.push(ta[dS + p]);
      for (let p = 0; p < iN; p++) rb.push(tb[iS + p]);
    }
    for (let p = pairs; p < dN; p++) ra.push(ta[dS + p]);
    for (let p = pairs; p < iN; p++) rb.push(tb[iS + p]);
    i = j - 2;
  }
  return { a: mergeRanges(ra), b: mergeRanges(rb) };
}

// Whole-line char granularity.
function charMarks(la, lb) {
  const ra = [], rb = [];
  const ctx = makeCtx();
  ctx.budget = 250_000;
  const ops = [];
  diffRange(la, 0, la.length, lb, 0, lb.length,
    (x, y) => la.charCodeAt(x) === lb.charCodeAt(y), ops, ctx);
  let ia = 0, ib = 0;
  for (let i = 0; i < ops.length; i += 2) {
    const code = ops[i], count = ops[i + 1];
    if (code === OP_EQ) { ia += count; ib += count; continue; }
    let j = i, dS = -1, dN = 0, iS = -1, iN = 0;
    while (j < ops.length) {
      const c = ops[j], ct = ops[j + 1];
      if (c === OP_EQ) break;
      if (c === OP_DEL) { if (dS < 0) dS = ia; dN += ct; ia += ct; }
      else { if (iS < 0) iS = ib; iN += ct; ib += ct; }
      j += 2;
    }
    if (dN) ra.push([dS, dS + dN]);
    if (iN) rb.push([iS, iS + iN]);
    i = j - 2;
  }
  return { a: mergeRanges(ra), b: mergeRanges(rb) };
}

// Marks are flat [start, end, start, end, ...] arrays — that is what the
// renderer and the worker boundary both consume.
function mergeRanges(ranges) {
  if (!ranges.length) return [];
  ranges.sort((x, y) => x[0] - y[0]);
  const out = [];
  let cur = ranges[0].slice();
  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i];
    if (r[0] <= cur[1]) cur[1] = Math.max(cur[1], r[1]);
    else { out.push(cur[0], cur[1]); cur = r.slice(); }
  }
  out.push(cur[0], cur[1]);
  return out;
}
