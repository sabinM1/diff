// Single worker module handling both pipelines. Two instances are spawned
// (one for text, one for images) so a long image alignment search never
// delays keystroke diffing. See workers/client.js for the main-thread side.
import { diffLines } from '../diff/core.js';
import { computeAlignment } from '../image/align.js';
import { phashFromRGBA } from '../image/phash.js';

const encoder = new TextEncoder();

function bitmapToRGBA(bitmap, maxDim) {
  const s = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  return bitmapToRGBAAt(bitmap, s);
}

// Draw a bitmap at an explicit scale so two images can share one analysis
// space (and therefore one offset scale).
function bitmapToRGBAAt(bitmap, scale) {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function handleText(id, msg) {
  const r = diffLines(msg.aText, msg.bText, {
    ignoreWs: msg.ignoreWs,
    precision: msg.precision,
  });
  // Longest line width comes from diffLines so we don't scan every line again.
  const ml = r.stats.maxLen ?? 1;
  // Encoding a multi-hundred-MB string just for a byte count is wasteful;
  // fall back to the code-unit length above the large-file threshold.
  const byteLen = (s) => (s.length > 8 * 1024 * 1024 ? s.length : encoder.encode(s).length);
  postMessage({
    id,
    ok: true,
    payload: {
      ops: r.ops,
      aLines: r.aLines,
      bLines: r.bLines,
      marksA: r.marksA,
      marksB: r.marksB,
      stats: {
        added: r.stats.added,
        removed: r.stats.removed,
        hunks: r.stats.hunks,
        aBytes: byteLen(msg.aText),
        bBytes: byteLen(msg.bText),
        aCount: r.aLines.length,
        bCount: r.bLines.length,
        maxLen: ml,
      },
    },
  });
}

function handleAlign(id, msg) {
  // Both images use the SAME scale so the recovered offset maps back to
  // native pixels with a single factor, even when dimensions differ.
  const k = Math.min(1, 512 / Math.max(msg.a.width, msg.a.height, msg.b.width, msg.b.height));
  const a = bitmapToRGBAAt(msg.a, k);
  const b = bitmapToRGBAAt(msg.b, k);
  const r = computeAlignment(a.data, a.w, a.h, b.data, b.w, b.h);
  postMessage({
    id,
    ok: true,
    payload: { dx: Math.round(r.dx / k), dy: Math.round(r.dy / k), score: r.score },
  });
}

function handlePhash(id, msg) {
  const { data, w, h } = bitmapToRGBA(msg.bitmap, 256);
  postMessage({ id, ok: true, payload: { hash: phashFromRGBA(data, w, h) } });
}

function handlePixDiff(id, msg) {
  const n = msg.aW * msg.aH;
  const map = new Uint8Array(n);
  const a = msg.aData;
  const b = msg.bData;
  for (let i = 0, p = 0; p < n; p++, i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const da = Math.abs(a[i + 3] - b[i + 3]);
    map[p] = Math.max(dr, dg, db, da);
  }
  postMessage({ id, ok: true, payload: { map } }, [map.buffer]);
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'text': return handleText(msg.id, msg);
      case 'align': return handleAlign(msg.id, msg);
      case 'phash': return handlePhash(msg.id, msg);
      case 'pixdiff': return handlePixDiff(msg.id, msg);
      default: postMessage({ id: msg.id, ok: false, error: 'unknown message type' });
    }
  } catch (err) {
    postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
