const clamp01 = (v) => Math.max(0, Math.min(1, v));

const smoothstep = (edge0, edge1, x) => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const LUMA_LUT = new Float32Array(256);
const SAT_LUT = new Float32Array(256);

function computeToneStats(imageData) {
  const data = imageData.data;
  const hist = new Uint32Array(256);

  const totalPixels = imageData.width * imageData.height;
  const targetSamples = 32768;
  const stepPixels = Math.max(1, Math.floor(totalPixels / targetSamples));
  const stepBytes = stepPixels * 4;

  let samples = 0;
  for (let i = 0; i < data.length; i += stepBytes) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const l = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    hist[l] += 1;
    samples += 1;
  }

  if (samples <= 0) {
    return { pivot: 0.5, p5: 0, p50: 128, p95: 255, range: 1.0 };
  }

  const pct = (q) => {
    const target = Math.min(samples, Math.max(1, Math.round(q * samples)));
    let cum = 0;
    for (let i = 0; i < 256; i++) {
      cum += hist[i];
      if (cum >= target) return i;
    }
    return 255;
  };

  const p5 = pct(0.05);
  const p50 = pct(0.5);
  const p95 = pct(0.95);

  const range = (p95 - p5) / 255.0;
  const pivot = clamp01(p50 / 255.0);

  return { pivot, p5, p50, p95, range };
}

function applyDynamicToneMapping(imageData, x, y, toneStats, shouldAbort) {
  const data = imageData.data;
  const len = data.length;
  const shouldCheckAbort = typeof shouldAbort === "function";
  let abortCounter = 0;

  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  const pivotRaw = toneStats && typeof toneStats.pivot === "number" ? toneStats.pivot : 0.5;
  const range = toneStats && typeof toneStats.range === "number" ? toneStats.range : 1.0;
  const p5Raw = toneStats && typeof toneStats.p5 === "number" ? toneStats.p5 : 0;
  const p95Raw = toneStats && typeof toneStats.p95 === "number" ? toneStats.p95 : 255;

  const strength = clamp01(Math.max(Math.abs(x), Math.abs(y)));
  const guard = 1 + Math.round(3 * strength);
  const eps = guard / 255.0;
  const lo = eps;
  const hi = 1.0 - eps;

  const logit = (v) => Math.log(v / (1 - v));
  const invLogit = (t) => 1 / (1 + Math.exp(-t));

  const pivot = clamp(pivotRaw, 0.05, 0.95);
  const pivotSafe = clamp(pivot, lo, hi);
  const lp = logit(pivotSafe);

  const contrastConfidence = smoothstep(0.18, 0.75, range);

  const targetGuard = guard + Math.round(5 * strength);
  const loT = clamp(targetGuard / 255.0, lo, 0.45);
  const hiT = clamp(1.0 - targetGuard / 255.0, 0.55, hi);
  const Llo = logit(loT);
  const Lhi = logit(hiT);

  const v5 = clamp(p5Raw / 255.0, lo, hi);
  const v95 = clamp(p95Raw / 255.0, lo, hi);
  const t5 = logit(v5);
  const t95 = logit(v95);
  const d5 = t5 - lp;
  const d95 = t95 - lp;

  let cMax = 8.0;
  if (d95 > 1e-6) cMax = Math.min(cMax, (Lhi - lp) / d95);
  if (d5 < -1e-6) cMax = Math.min(cMax, (Llo - lp) / d5);
  cMax = clamp(cMax, 1.0, 8.0);

  const xCurve = Math.sign(x) * Math.pow(Math.abs(x), 1.25);
  const xScale = 1.0 + (1.0 - contrastConfidence) * 0.3;
  const xEff = clamp(xCurve * xScale, -1.0, 1.0);
  const xSat = Math.tanh(xEff * 1.25) / Math.tanh(1.25);
  const contrastMax = 2.12;
  const cWanted = Math.pow(2, xSat * contrastMax);
  const c = Math.min(cWanted, cMax);

  const yCurve = Math.sign(y) * Math.pow(Math.abs(y), 1.6);
  const yScale = 1.0 + contrastConfidence * 0.5;
  const dirScaleRaw =
    y >= 0 ? 1.0 + (0.5 - pivotSafe) * 0.9 : 1.0 + (pivotSafe - 0.5) * 0.9;
  const dirScale = clamp(dirScaleRaw, 0.9, 1.25);
  const yEff = clamp(yCurve * yScale * dirScale, -1.0, 1.0);
  const ySat = Math.tanh(yEff * 1.15) / Math.tanh(1.15);

  const yRangeT = clamp01(x + 1.0);
  const yRangeScale = 0.62 + 0.38 * yRangeT;

  const bMax = (2.55 + 0.85 * contrastConfidence) * yRangeScale;
  const brightnessRangeScale = 0.7;
  const bBase = ySat * bMax * brightnessRangeScale;
  const yWeightPow = 1.05;

  const lumaLut = LUMA_LUT;

  for (let i = 0; i < 256; i++) {
    const v = clamp(i / 255.0, lo, hi);
    let t = (logit(v) - lp) * c + lp;

    if (bBase !== 0) {
      const vc = invLogit(t);
      const w = bBase > 0 ? Math.pow(1.0 - vc, yWeightPow) : Math.pow(vc, yWeightPow);
      t += bBase * w;
    }

    const out = clamp(invLogit(t), lo, hi);
    lumaLut[i] = out * 255.0;
  }

  const satLut = SAT_LUT;

  const edgeWidth = 0.3;
  const satEdgeStrength = 0.78;
  const minSat = 1.0 - satEdgeStrength * strength;
  const deltaK = 0.9 + 2.2 * strength;

  for (let i = 0; i < 256; i++) {
    const nl = lumaLut[i];
    const nl01 = nl / 255.0;
    const dEdge = Math.min(nl01, 1.0 - nl01);

    let t = dEdge / edgeWidth;
    t = clamp01(t);
    const edgeW = t * t * (3 - 2 * t);

    const satEdge = minSat + (1.0 - minSat) * edgeW;

    const dL = Math.abs(nl - i) / 255.0;
    const satDelta = Math.exp(-dL * deltaK);
    const satDeltaEdge = edgeW + (1.0 - edgeW) * satDelta;

    satLut[i] = clamp01(satEdge * satDeltaEdge);
  }

  const lower = guard;
  const upper = 255 - guard;

  const satLutRef = satLut;
  const lumaLutRef = lumaLut;
  const lowerRef = lower;
  const upperRef = upper;

  for (let idx = 0; idx < len; idx += 4) {
    if (shouldCheckAbort && (abortCounter++ & 2047) === 0 && shouldAbort()) return;
    const r0 = data[idx];
    const g0 = data[idx + 1];
    const b0 = data[idx + 2];

    const l = (77 * r0 + 150 * g0 + 29 * b0) >> 8;
    const nl = lumaLutRef[l];

    const dr = r0 - l;
    const dg = g0 - l;
    const db = b0 - l;

    let sat = 1.0;
    if (dr > 0) sat = Math.min(sat, (upperRef - nl) / dr);
    else if (dr < 0) sat = Math.min(sat, (lowerRef - nl) / dr);

    if (dg > 0) sat = Math.min(sat, (upperRef - nl) / dg);
    else if (dg < 0) sat = Math.min(sat, (lowerRef - nl) / dg);

    if (db > 0) sat = Math.min(sat, (upperRef - nl) / db);
    else if (db < 0) sat = Math.min(sat, (lowerRef - nl) / db);

    if (!(sat > 0)) sat = 0.0;
    else if (sat > 1.0) sat = 1.0;

    sat *= satLutRef[l];

    const rAdj = nl + dr * sat;
    const gAdj = nl + dg * sat;
    const bAdj = nl + db * sat;

    data[idx] = rAdj;
    data[idx + 1] = gAdj;
    data[idx + 2] = bAdj;
  }
}

module.exports = {
  clamp01,
  smoothstep,
  computeToneStats,
  applyDynamicToneMapping
};

