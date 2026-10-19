// Card fingerprints for recognition by image (prototype, tested in bench.mjs).
// Pure functions on RGB pixel arrays so the same code can run in the browser.
//
// A fingerprint has two parts, computed on the card alone (no background):
// - a 64-bit perceptual hash (DCT of the 32×32 grey image), robust to light
//   and slight blur;
// - a 4×6 grid of average colours, which separates cards whose shapes match.

export const FP_W = 32;
export const FP_H = 32;
export const GRID_W = 4;
export const GRID_H = 6;

const COS_TABLE = new Float64Array(8 * FP_W);
for (let k = 0; k < 8; k++) for (let n = 0; n < FP_W; n++) COS_TABLE[k * FP_W + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * FP_W));

// rgb: Uint8Array of w*h*3, already resized to FP_W×FP_H (stretching the card).
export function phash(rgb) {
  const N = FP_W;
  const g = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  const cos = COS_TABLE;
  // Separable DCT: rows first, then columns, low 8×8 frequencies only.
  const rowsT = new Float64Array(N * 8);
  for (let y = 0; y < N; y++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += g[y * N + x] * cos[v * N + x];
      rowsT[y * 8 + v] = s;
    }
  }
  const coef = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rowsT[y * 8 + v] * cos[u * N + y];
      coef.push(s);
    }
  }
  const ac = coef.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  let bits = 0n;
  for (let i = 0; i < 64; i++) bits = (bits << 1n) | (coef[i] > median ? 1n : 0n);
  return bits;
}

// rgb: GRID_W×GRID_H pixels (the card shrunk to the grid). Normalised per
// channel so that a darker or yellower photo still matches.
export function colorGrid(rgb, n = GRID_W * GRID_H) {
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

export function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// 0 = identical. Hash and colour weigh about the same.
export function distance(fa, fb) {
  let d = 0;
  for (let i = 0; i < fa.grid.length; i++) d += (fa.grid[i] - fb.grid[i]) ** 2;
  return hamming(fa.hash, fb.hash) / 32 + Math.sqrt(d / fa.grid.length) / 1.4;
}

// Finds the card in a photo: the large region that differs from the colour
// of the photo's border. rgb is the full photo, w×h. Returns a box.
export function findCard(rgb, w, h) {
  const border = [];
  const push = (x, y) => { const i = (y * w + x) * 3; border.push([rgb[i], rgb[i + 1], rgb[i + 2]]); };
  for (let x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const spread = Math.max(18, ...[0, 1, 2].map((c) => {
    const v = border.map((p) => Math.abs(p[c] - med[c])).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.9)] * 1.5;
  }));
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const d = Math.max(Math.abs(rgb[i] - med[0]), Math.abs(rgb[i + 1] - med[1]), Math.abs(rgb[i + 2] - med[2]));
      if (d > spread) { rows[y]++; cols[x]++; }
    }
  }
  const span = (arr, len, other) => {
    const min = other * 0.25;
    let a = 0;
    while (a < len && arr[a] < min) a++;
    let b = len - 1;
    while (b > a && arr[b] < min) b--;
    return [a, b];
  };
  const [y0, y1] = span(rows, h, w);
  const [x0, x1] = span(cols, w, h);
  if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.2) return { x: 0, y: 0, w, h }; // nothing found: whole photo
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Card proportions (63 × 88 mm).
export const CARD_RATIO = 63 / 88;

// Finds the card in a busy photo (playmat, easel, sleeve): the upright
// rectangle with card proportions whose four sides follow the strongest
// straight edges. rgb is the photo at w×h (about 200 px wide is enough).
export function findCardByEdges(rgb, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
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
  // A side is strong when the edge is there all along it, so take the weakest
  // of the four sides' averages (a single strong side is not a card).
  const side = (fn, a, b, c) => Math.max(fn(a, b, c), fn(a - 1, b, c), fn(a + 1, b, c)) / (c - b);
  let best = { score: -1, x: 0, y: 0, w, h };
  for (let ch = Math.round(h * 0.35); ch <= h - 2; ch += 1) {
    const cw = Math.round(ch * CARD_RATIO);
    if (cw >= w - 2) break;
    for (let y = 1; y + ch < h - 1; y += 1) {
      for (let x = 1; x + cw < w - 1; x += 1) {
        const top = side(rowSum, y, x, x + cw);
        const bottom = side(rowSum, y + ch, x, x + cw);
        const left = side(colSum, x, y, y + ch);
        const right = side(colSum, x + cw, y, y + ch);
        const score = Math.min(top, bottom, left, right) + 0.25 * (top + bottom + left + right) / 4;
        if (score > best.score) best = { score, x, y, w: cw, h: ch };
      }
    }
  }
  return best;
}
