// Image auto-alignment: multi-scale normalized cross-correlation over
// grayscale Sobel edge maps. Robust to slight crops, padding differences and
// minor resolution mismatches because each level is normalized independently
// and the overlap region is scored with proper NCC (mean/variance aware).
//
// The returned (dx, dy) is the translation to ADD to B so it lines up with A,
// expressed in the analysis-space pixels of A. The worker converts it to
// native pixels. Pure functions: runs in the worker and in Node tests.

function toGray(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    out[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

function downsample(gray, w, h, scale) {
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(dw * dh);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const srcY = Math.min(h - 1, Math.floor(y * sy));
    for (let x = 0; x < dw; x++) {
      const srcX = Math.min(w - 1, Math.floor(x * sx));
      out[y * dw + x] = gray[srcY * w + srcX];
    }
  }
  return { data: out, w: dw, h: dh };
}

function sobel(gray, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function normalize(arr) {
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / arr.length;
  const std = Math.sqrt(Math.max(0, sumSq / arr.length - mean * mean)) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - mean) / std;
  return out;
}

// Normalized cross-correlation for offset (ox, oy): A(x, y) ≈ B(x - ox, y - oy).
// A and B may have different dimensions; only the overlap is scored. Shifts
// that leave too little overlap are rejected so the search cannot cheat by
// comparing a handful of pixels.
function nccAt(a, wa, ha, b, wb, hb, ox, oy) {
  const x0 = Math.max(0, ox);
  const x1 = Math.min(wa, wb + ox);
  const y0 = Math.max(0, oy);
  const y1 = Math.min(ha, hb + oy);
  const n = (x1 - x0) * (y1 - y0);
  if (n < 16) return -Infinity;
  if (n < 0.3 * Math.min(wa * ha, wb * hb)) return -Infinity;

  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = y0; y < y1; y++) {
    let ia = y * wa + x0;
    let ib = (y - oy) * wb + (x0 - ox);
    for (let x = x0; x < x1; x++, ia++, ib++) {
      const va = a[ia];
      const vb = b[ib];
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const varA = saa - (sa * sa) / n;
  const varB = sbb - (sb * sb) / n;
  const covar = sab - (sa * sb) / n;
  const den = Math.sqrt(Math.max(1e-9, varA * varB));
  return covar / den;
}

function searchLevel(a, wa, ha, b, wb, hb, cx, cy, win) {
  let best = -Infinity;
  let bx = cx;
  let by = cy;
  for (let dy = -win; dy <= win; dy++) {
    for (let dx = -win; dx <= win; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const v = nccAt(a, wa, ha, b, wb, hb, x, y);
      if (v > best) {
        best = v;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx, y: by, score: best };
}

// Coarse-to-fine pyramid alignment. Returns the offset in the coordinate
// space of the input buffers (the worker scales it to native pixels).
export function computeAlignment(aRgba, aw, ah, bRgba, bw, bh) {
  const aGray = toGray(aRgba, aw, ah);
  const bGray = toGray(bRgba, bw, bh);
  const maxDim = Math.max(aw, ah, bw, bh);

  // Build scales from native (1) down toward a ~64px longest side, but skip
  // any level where the SHORT side collapses below ~8px: Sobel there is
  // meaningless (a 1–2px strip yields an all-zero field) so it would silently
  // fail on extreme aspect ratios (e.g. 512×5 panorama crops). Coarsest first.
  const scales = [];
  let s = 1;
  for (;;) {
    if (Math.min(aw, ah) * s >= 8 && Math.min(bw, bh) * s >= 8) scales.push(s);
    if (maxDim * s <= 64) break;
    s *= 0.5;
    if (s < 1 / 64) break;
  }
  if (!scales.length) scales.push(1); // tiny/degenerate input → native only
  scales.reverse();

  const levels = [];
  for (const scale of scales) {
    const aDs = downsample(aGray, aw, ah, scale);
    const bDs = downsample(bGray, bw, bh, scale);
    levels.push({
      scale,
      a: normalize(sobel(aDs.data, aDs.w, aDs.h)),
      b: normalize(sobel(bDs.data, bDs.w, bDs.h)),
      wa: aDs.w,
      ha: aDs.h,
      wb: bDs.w,
      hb: bDs.h,
    });
  }

  let ox = 0;
  let oy = 0;
  let score = 0;
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i];
    const cx = Math.round(ox * L.scale);
    const cy = Math.round(oy * L.scale);
    // Wide sweep at the coarsest level (clamped to the level, so a thin level
    // never searches far outside itself); progressively tighter afterwards.
    const win = i === 0
      ? Math.min(Math.max(6, Math.round(Math.min(L.wa, L.ha) * 0.5)), Math.max(L.wa, L.ha))
      : Math.max(2, 4 - Math.floor(i / 2));
    const r = searchLevel(L.a, L.wa, L.ha, L.b, L.wb, L.hb, cx, cy, win);
    ox = r.x / L.scale;
    oy = r.y / L.scale;
    score = r.score;
  }

  return { dx: Math.round(ox), dy: Math.round(oy), score };
}
