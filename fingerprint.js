'use strict';

// Card fingerprints, for recognising a card from its image.
//
// The same code runs in the browser (window.Fingerprint) and in Node, where
// GitHub Actions computes the fingerprint of every official image once a
// week (tests/index-build.mjs), so both sides compute exactly the same thing.
//
// A fingerprint is computed on the card alone, resized to CARD_W×CARD_H:
// - a 64-bit perceptual hash (DCT of the 32×32 grey image): the shapes;
// - an 8×11 grid of average colours, normalised per channel so that a darker
//   or yellower photo still matches: the colours.
// Recognition = the official card with the smallest distance.

(function (root) {
  const CARD_W = 128;
  const CARD_H = 176;
  const CARD_RATIO = 63 / 88; // a card is 63 × 88 mm
  const GRID_W = 8;
  const GRID_H = 11;
  const GRID_LEN = GRID_W * GRID_H * 3;
  const RECORD = 8 + GRID_LEN; // bytes per card in the index file
  const QUANT = 32; // colour grid stored as int8 = round(value × QUANT)

  // Area-average resize of an RGB(A) pixel array: every source pixel counts,
  // which keeps tiny grids stable whatever the photo's size.
  function boxResize(src, w, h, W, H, channels = 3) {
    const out = new Float32Array(W * H * 3);
    const sx = w / W;
    const sy = h / H;
    for (let Y = 0; Y < H; Y++) {
      const y0 = Y * sy;
      const y1 = y0 + sy;
      for (let X = 0; X < W; X++) {
        const x0 = X * sx;
        const x1 = x0 + sx;
        let r = 0;
        let g = 0;
        let b = 0;
        let area = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const fy = Math.min(y + 1, y1) - Math.max(y, y0);
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const f = fy * (Math.min(x + 1, x1) - Math.max(x, x0));
            const i = (y * w + x) * channels;
            r += src[i] * f;
            g += src[i + 1] * f;
            b += src[i + 2] * f;
            area += f;
          }
        }
        const o = (Y * W + X) * 3;
        out[o] = r / area;
        out[o + 1] = g / area;
        out[o + 2] = b / area;
      }
    }
    return out;
  }

  const N = 32;
  const COS = new Float64Array(8 * N);
  for (let k = 0; k < 8; k++) for (let n = 0; n < N; n++) COS[k * N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));

  // 64-bit perceptual hash, as two 32-bit halves.
  function phash(card, channels) {
    const rgb = boxResize(card, CARD_W, CARD_H, N, N, channels);
    const g = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    // Separable DCT, low 8×8 frequencies only.
    const rows = new Float64Array(N * 8);
    for (let y = 0; y < N; y++) {
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let x = 0; x < N; x++) s += g[y * N + x] * COS[v * N + x];
        rows[y * 8 + v] = s;
      }
    }
    const coef = new Float64Array(64);
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let y = 0; y < N; y++) s += rows[y * 8 + v] * COS[u * N + y];
        coef[u * 8 + v] = s;
      }
    }
    const median = [...coef.slice(1)].sort((a, b) => a - b)[31];
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 32; i++) hi = ((hi << 1) | (coef[i] > median ? 1 : 0)) >>> 0;
    for (let i = 32; i < 64; i++) lo = ((lo << 1) | (coef[i] > median ? 1 : 0)) >>> 0;
    return [hi, lo];
  }

  function colorGrid(card, channels) {
    const rgb = boxResize(card, CARD_W, CARD_H, GRID_W, GRID_H, channels);
    const n = GRID_W * GRID_H;
    const out = new Float32Array(n * 3);
    for (let c = 0; c < 3; c++) {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += rgb[i * 3 + c];
      mean /= n;
      let sd = 0;
      for (let i = 0; i < n; i++) sd += (rgb[i * 3 + c] - mean) ** 2;
      sd = Math.sqrt(sd / n) || 1;
      for (let i = 0; i < n; i++) out[i * 3 + c] = (rgb[i * 3 + c] - mean) / sd;
    }
    return out;
  }

  // card: the card's pixels at CARD_W×CARD_H (RGB, or RGBA with channels = 4).
  function fingerprint(card, channels = 3) {
    const [hi, lo] = phash(card, channels);
    const grid = new Int8Array(GRID_LEN);
    const g = colorGrid(card, channels);
    for (let i = 0; i < GRID_LEN; i++) grid[i] = Math.max(-127, Math.min(127, Math.round(g[i] * QUANT)));
    return { hi, lo, grid };
  }

  function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  // 0 = identical. Tuned on real photos (holo glare, sleeves, busy backgrounds):
  // the colour grid separates cards best, the shape hash helps a little.
  function distance(a, b) {
    const ham = popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
    let d = 0;
    for (let i = 0; i < GRID_LEN; i++) d += (a.grid[i] - b.grid[i]) ** 2;
    return (0.5 * ham) / 32 + Math.sqrt(d / GRID_LEN) / QUANT / 1.4;
  }

  // Index file: one record per card, RECORD bytes (hash hi, hash lo as
  // big-endian uint32, then the int8 grid), in the order of the ids list.
  function encodeIndex(fps) {
    const buf = new Uint8Array(fps.length * RECORD);
    const view = new DataView(buf.buffer);
    fps.forEach((fp, k) => {
      view.setUint32(k * RECORD, fp.hi);
      view.setUint32(k * RECORD + 4, fp.lo);
      buf.set(new Uint8Array(fp.grid.buffer, fp.grid.byteOffset, GRID_LEN), k * RECORD + 8);
    });
    return buf;
  }

  function decodeIndex(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    for (let o = 0; o + RECORD <= buf.length; o += RECORD) {
      out.push({ hi: view.getUint32(o), lo: view.getUint32(o + 4), grid: new Int8Array(buf.buffer, buf.byteOffset + o + 8, GRID_LEN) });
    }
    return out;
  }

  // The `count` closest cards, best first: [{ i, d }].
  function closest(index, fp, count = 20) {
    const best = [];
    for (let i = 0; i < index.length; i++) {
      const d = distance(fp, index[i]);
      if (best.length < count || d < best[best.length - 1].d) {
        best.push({ i, d });
        best.sort((a, b) => a.d - b.d);
        if (best.length > count) best.pop();
      }
    }
    return best;
  }

  // Finds the card in a photo with a busy background (playmat, easel,
  // sleeve): the upright rectangle with card proportions whose four sides
  // follow the strongest straight edges. rgb: the photo at w×h, about 160 px
  // wide. Returns { x, y, w, h, score } in those pixels.
  function findCard(rgb, w, h, channels = 3) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgb[i * channels] + 0.587 * rgb[i * channels + 1] + 0.114 * rgb[i * channels + 2];
    // Prefix sums of horizontal edges along rows, vertical edges along columns.
    const hRow = new Float32Array((w + 1) * h);
    const vCol = new Float32Array(w * (h + 1));
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const dy = Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]);
        const dx = Math.abs(g[y * w + x + 1] - g[y * w + x - 1]);
        // An edge only counts where it is mostly in that direction.
        hRow[y * (w + 1) + x + 1] = dy > dx ? dy : 0;
        vCol[(y + 1) * w + x] = dx > dy ? dx : 0;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 1; x <= w; x++) hRow[y * (w + 1) + x] += hRow[y * (w + 1) + x - 1];
    for (let x = 0; x < w; x++) for (let y = 1; y <= h; y++) vCol[y * w + x] += vCol[(y - 1) * w + x];
    const rowSum = (y, x0, x1) => hRow[y * (w + 1) + x1] - hRow[y * (w + 1) + x0];
    const colSum = (x, y0, y1) => vCol[y1 * w + x] - vCol[y0 * w + x];
    // A slightly tilted card moves its edge by a row or two: take the best nearby line.
    const side = (sum, a, b, c, max) => {
      let m = 0;
      for (let k = -2; k <= 2; k++) m = Math.max(m, sum(Math.min(Math.max(a + k, 0), max), b, c));
      return m / (c - b);
    };
    let best = { score: -1, x: 0, y: 0, w, h };
    for (let ch = Math.round(h * 0.35); ch <= h - 2; ch++) {
      const cw = Math.round(ch * CARD_RATIO);
      if (cw >= w - 2) break;
      for (let y = 1; y + ch < h - 1; y++) {
        for (let x = 1; x + cw < w - 1; x++) {
          const top = side(rowSum, y, x, x + cw, h - 1);
          const bottom = side(rowSum, y + ch, x, x + cw, h - 1);
          const left = side(colSum, x, y, y + ch, w - 1);
          const right = side(colSum, x + cw, y, y + ch, w - 1);
          // All four sides must be there: the weakest one counts most.
          const score = Math.min(top, bottom, left, right) + (0.25 * (top + bottom + left + right)) / 4;
          if (score > best.score) best = { score, x, y, w: cw, h: ch };
        }
      }
    }
    return best;
  }

  // Tilts tried when looking for the card, in degrees.
  const TILTS = [0, -3, 3, -6, 6];

  const api = { CARD_W, CARD_H, CARD_RATIO, RECORD, TILTS, boxResize, fingerprint, distance, encodeIndex, decodeIndex, closest, findCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fingerprint = api;
})(typeof window !== 'undefined' ? window : globalThis);
