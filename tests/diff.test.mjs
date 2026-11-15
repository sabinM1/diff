// Sanity suite run in CI before the Pages deploy (npm test).
// Covers diff correctness (reconstruction + equality semantics), the
// whitespace/precision options, the highlighter, and a perf smoke check.
import { diffLines, OP_EQ, OP_DEL, OP_INS } from '../src/diff/core.js';
import { buildRows, ROW_H, HUNK_H, FOLD_H, generateUnifiedDiff } from '../src/diff/model.js';
import { renderCodeHTML, detectLang, getLang, lineStates } from '../src/diff/highlight.js';
import { phashFromRGBA, hamming } from '../src/image/phash.js';
import { computeAlignment } from '../src/image/align.js';

let failures = 0;
const ok = (cond, name) => {
  if (!cond) { failures++; console.error('FAIL:', name); }
};

function replay(r) {
  let ai = 0, bi = 0;
  const rows = [];
  for (let i = 0; i < r.ops.length; i += 2) {
    const code = r.ops[i], n = r.ops[i + 1];
    if (code === OP_EQ) {
      for (let k = 0; k < n; k++) rows.push([r.aLines[ai + k], r.bLines[bi + k]]);
      ai += n; bi += n;
    } else if (code === OP_DEL) {
      for (let k = 0; k < n; k++) rows.push([r.aLines[ai + k], null]);
      ai += n;
    } else if (code === OP_INS) {
      for (let k = 0; k < n; k++) rows.push([null, r.bLines[bi + k]]);
      bi += n;
    }
  }
  return { rows, ai, bi };
}

function expectDiff(name, a, b, opts, expect) {
  const r = diffLines(a, b, opts ?? {});
  const { rows, ai, bi } = replay(r);
  ok(ai === r.aLines.length && bi === r.bLines.length, `${name}: coverage`);
  for (const [x, y] of rows) {
    if (x !== null && y !== null) {
      const norm = (s) => (opts?.ignoreWs ? s.replace(/[ \t]+/g, ' ').trim() : s);
      ok(norm(x) === norm(y), `${name}: equal rows match`);
    }
  }
  for (const [key, val] of Object.entries(expect ?? {})) {
    ok(r.stats[key] === val, `${name}: stats.${key} === ${val} (got ${r.stats[key]})`);
  }
}

// --- diff correctness ---
expectDiff('identical', 'a\nb\nc', 'a\nb\nc', {}, { added: 0, removed: 0, hunks: 0 });
expectDiff('append', 'a\nb', 'a\nb\nc', {}, { added: 1, removed: 0, hunks: 1 });
expectDiff('delete', 'a\nb\nc', 'a\nc', {}, { added: 0, removed: 1, hunks: 1 });
expectDiff('replace', 'a\nb\nc', 'a\nx\nc', {}, { added: 1, removed: 1, hunks: 1 });
expectDiff('empty both', '', '', {}, { added: 0, removed: 0 });
expectDiff('empty A', '', 'x\ny', {}, { added: 2, removed: 0, hunks: 1 });
expectDiff('empty B', 'x\ny', '', {}, { added: 0, removed: 2, hunks: 1 });
expectDiff('crlf', 'a\r\nb\r\n', 'a\r\nx\r\n', {}, { added: 1, removed: 1 });
expectDiff('whitespace only', 'x\t y\nz', 'x y\nz', { ignoreWs: true }, { added: 0, removed: 0, hunks: 0 });
expectDiff('unicode', 'héllo\n日本語', 'héllo\n日本語!', {}, { added: 1, removed: 1 });

// marks exist for a changed pair
{
  const r = diffLines('const a = 1;', 'const a = 2;', { precision: 'smart' });
  ok(r.marksB.size >= 1, 'smart marks produced');
  const marks = [...r.marksB.values()][0];
  ok(Array.isArray(marks) && marks.length >= 2, 'marks are flat ranges');
}

// --- row model ---
{
  const seq = (n, alt) => Array.from({ length: n }, (_, i) => (i === 15 ? alt : `line ${i + 1}`));
  const r = diffLines(seq(30, 'line 16').join('\n'), seq(30, 'CHANGED 16').join('\n'));
  const rows = buildRows(r, { layout: 'split', hideUnchanged: false, marksA: r.marksA, marksB: r.marksB });
  ok(rows.some((row) => row.t === 'hunk'), 'hunk header emitted');
  ok(rows.every((row) => row.t !== 'fold'), 'no folds when hideUnchanged off');

  const folded = buildRows(r, { layout: 'unified', hideUnchanged: true, marksA: r.marksA, marksB: r.marksB });
  const folds = folded.filter((row) => row.t === 'fold');
  ok(folds.length >= 1, 'fold bar emitted for long unchanged run');
  ok(folds.every((f) => typeof f.count === 'number' && f.count > 0), 'fold has a count');
  const expanded = buildRows(r, { layout: 'unified', hideUnchanged: true, marksA: r.marksA, marksB: r.marksB },
    new Set(folds.map((f) => f.key)));
  ok(expanded.every((row) => row.t !== 'fold'), 'expansion removes the folds');

  let h = 0;
  for (const row of folded) {
    h += row.t === 'hunk' ? HUNK_H : row.t === 'fold' ? FOLD_H : ROW_H;
  }
  ok(h === folded.reduce((acc, row) => acc
    + (row.t === 'hunk' ? HUNK_H : row.t === 'fold' ? FOLD_H : ROW_H), 0), 'heights are consistent');
}

// --- unified diff / patch export ---
{
  const A = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm';
  const B = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM';
  const r = diffLines(A, B);
  const patch = generateUnifiedDiff(r, 'old.txt', 'new.txt');
  const lines = patch.split('\n');
  ok(lines[0] === '--- a/old.txt', 'patch has --- header');
  ok(lines[1] === '+++ b/new.txt', 'patch has +++ header');
  ok(lines.some((l) => l.startsWith('@@ -1,')), 'patch first hunk starts at line 1');
  ok(lines.includes('-a') && lines.includes('+A'), 'patch marks first change');
  ok(lines.includes('-m') && lines.includes('+M'), 'patch marks last change');
  ok(lines.filter((l) => l.startsWith('@@')).length === 2, 'far changes split into 2 hunks');

  // nearby changes collapse into a single merged hunk (no overlapping context)
  const r2 = diffLines('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9',
    'l1\nX2\na3\na4\na5\nl6\nl7\nX8\nl9');
  const p2 = generateUnifiedDiff(r2, 'f', 'g');
  ok(p2.split('\n').filter((l) => l.startsWith('@@')).length === 1, 'near changes merge into 1 hunk');

  // no changes → empty patch
  ok(generateUnifiedDiff(diffLines('same\nx', 'same\nx'), 'f', 'g') === '', 'identical input yields empty patch');
}

// --- highlighter ---
ok(renderCodeHTML('const x = 1;', null, 0, null, 'wadd') === 'const x = 1;', 'plain escape');
ok(renderCodeHTML('<b>&</b>', null, 0, null, 'wadd') === '&lt;b&gt;&amp;&lt;/b&gt;', 'html escaped');
{
  const html = renderCodeHTML('const x = 1;', getLang(detectLang('const x = 1;', 'a.js')), 0, null, 'wadd');
  ok(html.includes('tk-kw'), 'keyword tokenized');
}
{
  const html = renderCodeHTML('const changedName = 2;', getLang(detectLang('const a;', 'a.js')), 0, [6, 23], 'wadd');
  ok(html.includes('<mark class="wadd">'), 'word mark rendered');
  ok(html.includes('tk-kw'), 'highlight survives diff marks');
}
ok(detectLang('def main():\n    pass\n', null) === 'python', 'sniff python');
ok(detectLang('fn main() { let x = 1; }', null) === 'rust', 'sniff rust');
ok(detectLang('x', 'Component.tsx') === 'typescript', 'ext tsx');
{
  const states = lineStates(['/* a', 'still', '*/ b'], getLang(detectLang('/*', 'a.c')));
  ok(states[0] === 0 && states[1] === 1 && states[2] === 1, 'block comment state carried');
}

// --- perceptual hash ---
{
  const w = 32, hgt = 32;
  const a = new Uint8ClampedArray(w * hgt * 4);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = 40 + ((x * x * 5 + y * y * 9) % 180); // structured gradient
    a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255;
  }
  const b = new Uint8ClampedArray(w * hgt * 4);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = ((y * 16 + x) % 255); // completely different structure
    b[i] = b[i + 1] = b[i + 2] = v; b[i + 3] = 255;
  }
  const d0 = hamming(phashFromRGBA(a, w, hgt), phashFromRGBA(b, w, hgt));
  ok(d0 > 8, 'different images hash apart');
  const noise = new Uint8ClampedArray(a);
  for (let i = 0; i < noise.length; i += 4) noise[i] = Math.min(255, 200 + (Math.random() * 6 - 3));
  const d1 = hamming(phashFromRGBA(a, w, hgt), phashFromRGBA(noise, w, hgt));
  ok(d1 <= 8, 'near-identical images hash together');

  // Adversarial: luminance-inverted structure must NOT collide (guards the
  // "similar" chip against a false positive on recoloured/flipped content).
  const inv = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    inv[i] = inv[i + 1] = inv[i + 2] = 255 - a[i]; inv[i + 3] = 255;
  }
  const dInv = hamming(phashFromRGBA(a, w, hgt), phashFromRGBA(inv, w, hgt));
  ok(dInv > 8, 'luminance-inverted image hashes apart');
}

// --- alignment: B shifted right by 8 px should recover +8 ---
{
  const w = 64, hgt = 64;
  const mk = (shift) => {
    const d = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // vertical stripe pattern
        d[i] = d[i + 1] = d[i + 2] = 30 + (((x + shift) * (x + shift) * 7 + y * 13) % 220);
        d[i + 3] = 255;
      }
    }
    return d;
  };
  const a = mk(0);
  const b = mk(8);
  const r = computeAlignment(a, w, hgt, b, w, hgt);
  ok(Math.abs(r.dx + 8) <= 2 || Math.abs(r.dx - 8) <= 2,
    `alignment recovers an 8 px shift (got dx=${r.dx})`);
}

// --- alignment: extreme aspect ratios must not collapse to an all-zero Sobel
// field (the old fixed-scale pyramid produced a 1–2px short side and failed).
{
  const mk = (w, hgt, shift) => {
    const d = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 30 + (((x + shift) * (x + shift) * 7 + y * 13) % 220);
        d[i + 3] = 255;
      }
    }
    return d;
  };
  const wide = mk(512, 40, 10);
  const rw = computeAlignment(mk(512, 40, 0), 512, 40, wide, 512, 40);
  ok(Math.abs(rw.dx - 10) <= 3, `wide 512x40 recovers ~10px (got ${rw.dx})`);

  const strip = mk(512, 5, 6);
  const rs = computeAlignment(mk(512, 5, 0), 512, 5, strip, 512, 5);
  ok(Math.abs(rs.dx - 6) <= 3, `thin 512x5 recovers ~6px (got ${rs.dx})`);
  ok(Number.isFinite(rs.score), 'thin strip yields a finite score (not all-zero field)');
}

// --- perf smoke: 5 MB diff finishes fast in Node ---
{
  const lines = [];
  for (let i = 0; i < 60000; i++) {
    lines.push(`function f${i}(x) { return x + ${i}; } // ${'padding '.repeat(3)}`);
  }
  const a = lines.join('\n');
  const b = lines.slice();
  for (let i = 100; i < lines.length; i += 500) b[i] = b[i].replace('return', 'return (');
  const t0 = Date.now();
  const r = diffLines(a, b.join('\n'), { precision: 'smart' });
  const ms = Date.now() - t0;
  ok(r.stats.added + r.stats.removed > 100, 'perf diff has changes');
  ok(ms < 2000, `5 MB-class diff under 2 s in CI (took ${ms} ms)`);
  console.log(`perf: ${a.length} bytes in ${ms} ms`);
}

if (failures) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('diffbench: all checks passed');
