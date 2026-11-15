// 64-bit perceptual hash (DCT-based, pHash-style) over an RGBA buffer.
// Pure math — worker adapts from an ImageBitmap, Node tests feed synthetic data.

export const PHASH_BITS = 64;

// Box-average downscale to 32×32 grayscale, then 2D DCT-II (separable),
// median-threshold the top-left 8×8 (DC excluded) → 64 bits as [hi, lo].
export function phashFromRGBA(data, w, h) {
  const N = 32;
  const g = new Float64Array(N * N);
  // integral box sampling
  for (let y = 0; y < N; y++) {
    const y0 = Math.floor(y * h / N), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / N));
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor(x * w / N), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / N));
      let sum = 0, cnt = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          cnt++;
        }
      }
      g[y * N + x] = cnt ? sum / cnt : 0;
    }
  }
  // separable DCT-II
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let i = 0; i < N; i++) s += g[i * N + x] * Math.cos((2 * i + 1) * u * Math.PI / (2 * N));
      tmp[u * N + x] = s;
    }
  }
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += tmp[x * N + u] * Math.cos((2 * x + 1) * v * Math.PI / (2 * N));
      out[v * N + u] = s;
    }
  }
  // 8×8 low-frequency block, exclude DC at (0,0)
  const vals = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (u === 0 && v === 0) continue;
      vals.push(out[v * N + u]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;
  let hi = 0, lo = 0;
  for (let i = 0; i < 63; i++) {
    const bit = vals[i] > med ? 1 : 0;
    if (i < 32) hi = (hi << 1) | bit;
    else lo = (lo << 1) | bit;
  }
  return [hi >>> 0, lo >>> 0];
}

export function hamming(h1, h2) {
  let d = 0;
  for (let p = 0; p < 2; p++) {
    let x = (h1[p] ^ h2[p]) >>> 0;
    while (x) { x &= x - 1; d++; }
  }
  return d;
}
