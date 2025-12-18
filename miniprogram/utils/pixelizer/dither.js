function hexToRgb(hexArr) {
  return hexArr.map((h) => {
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return { r, g, b };
  });
}

const PALETTE_CACHE_BITS = 6;
const PALETTE_CACHE_SHIFT = 8 - PALETTE_CACHE_BITS;
const PALETTE_CACHE_SIZE = 1 << (PALETTE_CACHE_BITS * 3);

let paletteFast = {
  palette: null,
  len: 0,
  r: null,
  g: null,
  b: null,
  table: null
};

function rebuildPaletteFast(palette) {
  const len = palette.length;
  const r = new Uint8Array(len);
  const g = new Uint8Array(len);
  const b = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const p = palette[i];
    r[i] = p.r;
    g[i] = p.g;
    b[i] = p.b;
  }

  const table = new Int16Array(PALETTE_CACHE_SIZE);
  table.fill(-1);

  return { palette, len, r, g, b, table };
}

function ensurePaletteFast(palette) {
  if (!paletteFast.table || paletteFast.palette !== palette) {
    paletteFast = rebuildPaletteFast(palette);
  }
  return paletteFast;
}

function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const rmean = (r1 + r2) >> 1;
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  return (((512 + rmean) * r * r) >> 8) + (4 * g * g) + (((767 - rmean) * b * b) >> 8);
}

function nearestPaletteIndex(r, g, b, pf) {
  const key =
    ((r >> PALETTE_CACHE_SHIFT) << (PALETTE_CACHE_BITS * 2)) |
    ((g >> PALETTE_CACHE_SHIFT) << PALETTE_CACHE_BITS) |
    (b >> PALETTE_CACHE_SHIFT);

  const cached = pf.table[key];
  if (cached >= 0) return cached;

  let best = 0;
  let bestDist = Infinity;
  const pr = pf.r;
  const pg = pf.g;
  const pb = pf.b;
  const n = pf.len;

  for (let i = 0; i < n; i++) {
    const dist = colorDistanceSq(r, g, b, pr[i], pg[i], pb[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }

  pf.table[key] = best;
  return best;
}

const ERROR_KERNELS = (() => {
  const floyd = [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16]
  ];
  const atkinson = [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8]
  ];
  const flipX = (k) => k.map(([dx, dy, f]) => [-dx, dy, f]);
  return {
    floyd: { fwd: floyd, rev: flipX(floyd) },
    atkinson: { fwd: atkinson, rev: flipX(atkinson) }
  };
})();

const BAYER_MAP4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];
const BAYER_MAP8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21]
];
const BAYER_STRENGTH = 30;
const BAYER_FACTOR4 = (() => {
  const t = new Float32Array(16);
  for (let i = 0; i < 16; i++) t[i] = (i / 16 - 0.5) * BAYER_STRENGTH;
  return t;
})();
const BAYER_FACTOR8 = (() => {
  const t = new Float32Array(64);
  for (let i = 0; i < 64; i++) t[i] = (i / 64 - 0.5) * BAYER_STRENGTH;
  return t;
})();

function ditherNearest(imgData, palette) {
  const pf = ensurePaletteFast(palette);
  const pr = pf.r;
  const pg = pf.g;
  const pb = pf.b;
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const idx = nearestPaletteIndex(d[i], d[i + 1], d[i + 2], pf);
    d[i] = pr[idx];
    d[i + 1] = pg[idx];
    d[i + 2] = pb[idx];
  }
}

function ditherRandom(imgData, palette) {
  const pf = ensurePaletteFast(palette);
  const pr = pf.r;
  const pg = pf.g;
  const pb = pf.b;
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const noise = ((Math.random() * 31) | 0) - 15;
    let r = d[i] + noise;
    let g = d[i + 1] + noise;
    let b = d[i + 2] + noise;

    if (r < 0) r = 0;
    else if (r > 255) r = 255;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (b < 0) b = 0;
    else if (b > 255) b = 255;

    const idx = nearestPaletteIndex(r, g, b, pf);
    d[i] = pr[idx];
    d[i + 1] = pg[idx];
    d[i + 2] = pb[idx];
  }
}

function ditherErrorDiffusion(imgData, palette, type, serpentine) {
  const pf = ensurePaletteFast(palette);
  const pr = pf.r;
  const pg = pf.g;
  const pb = pf.b;

  const w = imgData.width | 0;
  const h = imgData.height | 0;
  const d = imgData.data;
  const kernelPair = ERROR_KERNELS[type];
  const kernelFwd = kernelPair.fwd;
  const kernelRev = kernelPair.rev;

  for (let y = 0; y < h; y++) {
    const reverse = serpentine && ((y & 1) === 1);
    const kernel = reverse ? kernelRev : kernelFwd;

    let x = reverse ? w - 1 : 0;
    const endX = reverse ? -1 : w;
    const stepX = reverse ? -1 : 1;
    const rowOffset = (y * w) << 2;

    for (; x !== endX; x += stepX) {
      const i = rowOffset + (x << 2);
      const oldR = d[i];
      const oldG = d[i + 1];
      const oldB = d[i + 2];

      const idx = nearestPaletteIndex(oldR, oldG, oldB, pf);
      const newR = pr[idx];
      const newG = pg[idx];
      const newB = pb[idx];

      d[i] = newR;
      d[i + 1] = newG;
      d[i + 2] = newB;

      const errR = oldR - newR;
      const errG = oldG - newG;
      const errB = oldB - newB;

      for (let k = 0; k < kernel.length; k++) {
        const dx = kernel[k][0];
        const dy = kernel[k][1];
        const factor = kernel[k][2];

        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

        const ni = ((ny * w + nx) << 2);
        d[ni] = d[ni] + errR * factor;
        d[ni + 1] = d[ni + 1] + errG * factor;
        d[ni + 2] = d[ni + 2] + errB * factor;
      }
    }
  }
}

function ditherBayer(imgData, palette, mapSize) {
  const pf = ensurePaletteFast(palette);
  const pr = pf.r;
  const pg = pf.g;
  const pb = pf.b;

  const currentMap = mapSize === 8 ? BAYER_MAP8 : BAYER_MAP4;
  const factorTable = mapSize === 8 ? BAYER_FACTOR8 : BAYER_FACTOR4;
  const w = imgData.width | 0;
  const h = imgData.height | 0;
  const d = imgData.data;

  for (let y = 0; y < h; y++) {
    const mapRow = currentMap[y % mapSize];
    const rowOffset = (y * w) << 2;
    for (let x = 0; x < w; x++) {
      const i = rowOffset + (x << 2);
      const mapValue = mapRow[x % mapSize];
      const factor = factorTable[mapValue];

      let r = d[i] + factor;
      let g = d[i + 1] + factor;
      let b = d[i + 2] + factor;

      if (r < 0) r = 0;
      else if (r > 255) r = 255;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      if (b < 0) b = 0;
      else if (b > 255) b = 255;

      r = r | 0;
      g = g | 0;
      b = b | 0;

      const idx = nearestPaletteIndex(r, g, b, pf);
      d[i] = pr[idx];
      d[i + 1] = pg[idx];
      d[i + 2] = pb[idx];
    }
  }
}

module.exports = {
  hexToRgb,
  ensurePaletteFast,
  ditherNearest,
  ditherRandom,
  ditherErrorDiffusion,
  ditherBayer
};

