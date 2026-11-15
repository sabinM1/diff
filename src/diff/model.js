// Builds the flat display row list from the worker's diff output.
// Runs on the main thread (cheap array walking) so folds can expand and
// collapse without re-running the diff.
import { OP_EQ, OP_DEL, OP_INS } from './core.js';

// Row heights in px — kept in sync with the diff styles.
export const ROW_H = 20;
export const HUNK_H = 26;
export const FOLD_H = 28;

const FOLD_MIN = 8;   // equal runs longer than this fold away their middle
const CONTEXT = 3;    // equal lines kept around each fold

// ty codes for row sides: 0 ctx, 1 add, 2 del, 3 gap
export const TY_CTX = 0;
export const TY_ADD = 1;
export const TY_DEL = 2;
export const TY_GAP = 3;

export function rowHeight(row) {
  if (row.t === 'hunk') return HUNK_H;
  if (row.t === 'fold') return FOLD_H;
  return ROW_H;
}

function hunkLabel(aLines, bLines, ai, bi, aLen, bLen) {
  // git-style: 1-based counts; zero-length side anchors on the previous line
  const as = aLen > 0 ? ai + 1 : ai;
  const bs = bLen > 0 ? bi + 1 : bi;
  let ctx = '';
  if (ai > 0 && ai <= aLines.length) ctx = aLines[ai - 1];
  if (!ctx && bi > 0 && bi <= bLines.length) ctx = bLines[bi - 1];
  ctx = ctx.trim().slice(0, 60);
  return `@@ -${as},${aLen} +${bs},${bLen} @@ ${ctx}`;
}

function eqRun(rows, aLines, bLines, ai, bi, len, opts, expandSet, key) {
  // emits an equal run, folding its middle when hide-unchanged is on
  const fold = opts.hideUnchanged && len > FOLD_MIN && !expandSet.has(key);
  if (!fold) {
    for (let k = 0; k < len; k++) {
      rows.push({
        t: 'ctx',
        aNo: ai + k + 1,
        bNo: bi + k + 1,
        at: aLines[ai + k],
        bt: bLines[bi + k],
      });
    }
    return;
  }
  if (len > CONTEXT * 2) {
    // head
    for (let k = 0; k < CONTEXT; k++) {
      rows.push({ t: 'ctx', aNo: ai + k + 1, bNo: bi + k + 1, at: aLines[ai + k], bt: bLines[bi + k] });
    }
    rows.push({ t: 'fold', key, count: len - CONTEXT * 2, ai, bi, len });
    // tail
    for (let k = len - CONTEXT; k < len; k++) {
      rows.push({ t: 'ctx', aNo: ai + k + 1, bNo: bi + k + 1, at: aLines[ai + k], bt: bLines[bi + k] });
    }
  } else {
    for (let k = 0; k < len; k++) {
      rows.push({ t: 'ctx', aNo: ai + k + 1, bNo: bi + k + 1, at: aLines[ai + k], bt: bLines[bi + k] });
    }
  }
}

// opts: { layout: 'split'|'unified', hideUnchanged: bool, marksA, marksB }
export function buildRows(model, opts, expandSet = new Set()) {
  const { ops, aLines, bLines } = model;
  const rows = [];
  let ai = 0, bi = 0;

  const emitHunks = true;
  for (let i = 0; i < ops.length; i += 2) {
    const code = ops[i], count = ops[i + 1];
    if (code === OP_EQ) {
      eqRun(rows, aLines, bLines, ai, bi, count, opts, expandSet, `${ai}:${bi}`);
      ai += count; bi += count;
      continue;
    }
    // group consecutive non-eq runs into one hunk
    let dStart = ai, dLen = 0, iStart = bi, iLen = 0;
    let j = i;
    while (j < ops.length && ops[j] !== OP_EQ) {
      const c = ops[j], ct = ops[j + 1];
      if (c === OP_DEL) dLen += ct;
      else iLen += ct;
      j += 2;
    }
    if (emitHunks) {
      rows.push({ t: 'hunk', label: hunkLabel(aLines, bLines, ai, bi, dLen, iLen) });
    }
    const dEnd = dStart + dLen;
    const iEnd = iStart + iLen;
    if (opts.layout === 'split') {
      const pairs = Math.min(dLen, iLen);
      for (let k = 0; k < pairs; k++) {
        const aIdx = dStart + k, bIdx = iStart + k;
        rows.push({
          t: 'pair',
          l: { no: aIdx + 1, ty: TY_DEL, text: aLines[aIdx], marks: opts.marksA?.get(aIdx) },
          r: { no: bIdx + 1, ty: TY_ADD, text: bLines[bIdx], marks: opts.marksB?.get(bIdx) },
        });
      }
      for (let k = dStart + pairs; k < dEnd; k++) {
        rows.push({
          t: 'pair',
          l: { no: k + 1, ty: TY_DEL, text: aLines[k], marks: opts.marksA?.get(k) },
          r: { no: 0, ty: TY_GAP, text: '', marks: null },
        });
      }
      for (let k = iStart + pairs; k < iEnd; k++) {
        rows.push({
          t: 'pair',
          l: { no: 0, ty: TY_GAP, text: '', marks: null },
          r: { no: k + 1, ty: TY_ADD, text: bLines[k], marks: opts.marksB?.get(k) },
        });
      }
    } else {
      for (let k = dStart; k < dEnd; k++) {
        rows.push({
          t: 'del',
          aNo: k + 1, bNo: 0, ty: TY_DEL,
          text: aLines[k], marks: opts.marksA?.get(k),
        });
      }
      for (let k = iStart; k < iEnd; k++) {
        rows.push({
          t: 'add',
          aNo: 0, bNo: k + 1, ty: TY_ADD,
          text: bLines[k], marks: opts.marksB?.get(k),
        });
      }
    }
    ai = dEnd;
    bi = iEnd;
    i = j - 2;
  }
  return rows;
}

export function totalHeight(rows) {
  let h = 0;
  for (const r of rows) h += rowHeight(r);
  return h;
}

/**
 * Generate a unified diff patch from the diff model.
 * @param {Object} model - The diff model with ops, aLines, bLines
 * @param {string} aName - Name of the original file (a)
 * @param {string} bName - Name of the changed file (b)
 * @returns {string} Unified diff format patch
 */
// Unified diff (patch) generator. Produces standard `--- / +++ / @@` output
// with merged hunks so nearby changes share one hunk and context never
// overlaps between hunks (a patch that `patch`/`git apply` accepts).
export function generateUnifiedDiff(model, aName = 'a/file', bName = 'b/file') {
  const { ops, aLines, bLines } = model;
  const CTX = 3;

  // Flatten ops into segments carrying absolute A/B line positions.
  const segs = [];
  let ai = 0, bi = 0;
  for (let i = 0; i < ops.length; i += 2) {
    const code = ops[i], n = ops[i + 1];
    if (code === OP_EQ) { segs.push({ t: 'eq', a: ai, b: bi, n }); ai += n; bi += n; }
    else if (code === OP_DEL) { segs.push({ t: 'del', a: ai, b: bi, n }); ai += n; }
    else { segs.push({ t: 'ins', a: ai, b: bi, n }); bi += n; }
  }

  const changes = [];
  for (let i = 0; i < segs.length; i++) if (segs[i].t !== 'eq') changes.push(i);
  if (!changes.length) return '';

  // Group change segments into hunks: adjacent changes merge when the equal
  // run between them is short enough that their context would overlap.
  const groups = [];
  let cur = [changes[0]];
  for (let k = 1; k < changes.length; k++) {
    const prev = changes[k - 1], next = changes[k];
    let eqLines = 0;
    for (let i = prev + 1; i < next; i++) if (segs[i].t === 'eq') eqLines += segs[i].n;
    if (eqLines <= CTX * 2) cur.push(next);
    else { groups.push(cur); cur = [next]; }
  }
  groups.push(cur);

  const out = [`--- a/${aName}`, `+++ b/${bName}`];

  for (const group of groups) {
    const c0 = group[0];
    const cLast = group[group.length - 1];
    const firstChange = segs[c0];
    const lastChange = segs[cLast];

    // Context available before the first change / after the last change.
    const prevSeg = c0 > 0 && segs[c0 - 1].t === 'eq' ? segs[c0 - 1] : null;
    const nextSeg = cLast + 1 < segs.length && segs[cLast + 1].t === 'eq' ? segs[cLast + 1] : null;
    const before = prevSeg ? Math.min(CTX, prevSeg.n) : 0;
    const after = nextSeg ? Math.min(CTX, nextSeg.n) : 0;

    const aStart = firstChange.a - before;
    const bStart = firstChange.b - before;
    // Position just after the last change on each side.
    const aAfterChange = lastChange.a + (lastChange.t === 'del' ? lastChange.n : 0);
    const bAfterChange = lastChange.b + (lastChange.t === 'ins' ? lastChange.n : 0);
    const aLen = aAfterChange - aStart + after;
    const bLen = bAfterChange - bStart + after;

    // Header context label (git-style trailing text).
    let ctxLabel = '';
    if (aStart > 0 && aStart <= aLines.length) ctxLabel = aLines[aStart - 1];
    else if (bStart > 0 && bStart <= bLines.length) ctxLabel = bLines[bStart - 1];
    ctxLabel = ctxLabel.trim().slice(0, 60);

    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@${ctxLabel ? ' ' + ctxLabel : ''}`);

    // Leading context.
    for (let k = aStart; k < firstChange.a; k++) out.push(` ${aLines[k]}`);

    // Changes and any equal runs between them (emitted fully as context).
    for (let si = c0; si <= cLast; si++) {
      const s = segs[si];
      if (s.t === 'eq') {
        for (let k = s.a; k < s.a + s.n; k++) out.push(` ${aLines[k]}`);
      } else if (s.t === 'del') {
        for (let k = s.a; k < s.a + s.n; k++) out.push(`-${aLines[k]}`);
      } else {
        for (let k = s.b; k < s.b + s.n; k++) out.push(`+${bLines[k]}`);
      }
    }

    // Trailing context.
    for (let k = aAfterChange; k < aAfterChange + after; k++) out.push(` ${aLines[k]}`);
  }

  return out.join('\n') + '\n';
}
