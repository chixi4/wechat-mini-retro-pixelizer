#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { PALETTES } = require(path.join(__dirname, "..", "miniprogram", "utils", "pixelizer", "palettes"));
const {
  hexToRgb,
  ditherNearest,
  ditherRandom,
  ditherErrorDiffusion,
  ditherBayer
} = require(path.join(__dirname, "..", "miniprogram", "utils", "pixelizer", "dither"));
const {
  clamp01: toneClamp01,
  smoothstep,
  computeToneStats,
  applyDynamicToneMapping: applyDynamicToneMappingMini
} = require(path.join(__dirname, "..", "miniprogram", "utils", "pixelizer", "tone"));

// Matches the newer HTML variant (v4.x) where tone LUTs are allocated per call
// (instead of reusing global buffers like `miniprogram/utils/pixelizer/tone.js` does).
function applyDynamicToneMappingHtml(imageData, x, y, toneStats, shouldAbort) {
  const data = imageData.data;
  const len = data.length;
  const shouldCheckAbort = typeof shouldAbort === "function";
  let abortCounter = 0;

  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  const pivotRaw = toneStats && typeof toneStats.pivot === "number" ? toneStats.pivot : 0.5;
  const range = toneStats && typeof toneStats.range === "number" ? toneStats.range : 1.0;
  const p5Raw = toneStats && typeof toneStats.p5 === "number" ? toneStats.p5 : 0;
  const p95Raw = toneStats && typeof toneStats.p95 === "number" ? toneStats.p95 : 255;

  const strength = toneClamp01(Math.max(Math.abs(x), Math.abs(y)));
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
  const dirScaleRaw = y >= 0 ? 1.0 + (0.5 - pivotSafe) * 0.9 : 1.0 + (pivotSafe - 0.5) * 0.9;
  const dirScale = clamp(dirScaleRaw, 0.9, 1.25);
  const yEff = clamp(yCurve * yScale * dirScale, -1.0, 1.0);
  const ySat = Math.tanh(yEff * 1.15) / Math.tanh(1.15);

  const yRangeT = toneClamp01(x + 1.0);
  const yRangeScale = 0.62 + 0.38 * yRangeT;

  const bMax = (2.55 + 0.85 * contrastConfidence) * yRangeScale;
  const brightnessRangeScale = 0.7;
  const bBase = ySat * bMax * brightnessRangeScale;
  const yWeightPow = 1.05;

  const lumaLut = new Float32Array(256);

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

  const satLut = new Float32Array(256);

  const edgeWidth = 0.3;
  const satEdgeStrength = 0.78;
  const minSat = 1.0 - satEdgeStrength * strength;
  const deltaK = 0.9 + 2.2 * strength;

  for (let i = 0; i < 256; i++) {
    const nl = lumaLut[i];
    const nl01 = nl / 255.0;
    const dEdge = Math.min(nl01, 1.0 - nl01);

    let t = dEdge / edgeWidth;
    t = toneClamp01(t);
    const edgeW = t * t * (3 - 2 * t);

    const satEdge = minSat + (1.0 - minSat) * edgeW;

    const dL = Math.abs(nl - i) / 255.0;
    const satDelta = Math.exp(-dL * deltaK);
    const satDeltaEdge = edgeW + (1.0 - edgeW) * satDelta;

    satLut[i] = toneClamp01(satEdge * satDeltaEdge);
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

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

function clamp01(v) {
  if (!(v > 0)) return 0;
  if (v > 1) return 1;
  return v;
}

function clampSigned01(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  return clamp01(Math.abs(x)) * Math.sign(x);
}

function parseKeyValueArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq >= 0) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      out[key] = value === "" ? true : value;
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function splitList(v) {
  if (v == null || v === false) return [];
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseRes(s) {
  const m = String(s)
    .trim()
    .match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!m) return null;
  const w = Math.max(1, parseInt(m[1], 10) | 0);
  const h = Math.max(1, parseInt(m[2], 10) | 0);
  return { w, h, key: `${w}x${h}` };
}

function formatMs(ms, width = 8) {
  const v = Number.isFinite(ms) ? ms.toFixed(2) : "NaN";
  return v.toString().padStart(width, " ");
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = Math.floor(clamped * (sorted.length - 1));
  return sorted[idx];
}

function summarizeSamples(samplesMs) {
  const n = samplesMs.length;
  if (!n) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samplesMs[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const avg = sum / n;
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const fps = avg > 0 ? 1000 / avg : 0;
  return { n, avg, min, max, p50, p95, fps };
}

function xorshift32(seed) {
  let x = seed >>> 0;
  x ^= (x << 13) >>> 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

function fillRgbaDeterministic(dst, w, h, seed) {
  let rng = seed >>> 0;
  const safeW = Math.max(1, w | 0);
  const safeH = Math.max(1, h | 0);
  let i = 0;
  for (let y = 0; y < safeH; y++) {
    const gy = (y * 255) / Math.max(1, safeH - 1);
    for (let x = 0; x < safeW; x++) {
      rng = xorshift32(rng);
      const gx = (x * 255) / Math.max(1, safeW - 1);
      const n0 = rng & 255;
      const n1 = (rng >>> 8) & 255;
      const n2 = (rng >>> 16) & 255;

      dst[i] = (gx + n0 * 0.35) | 0;
      dst[i + 1] = (gy + n1 * 0.35) | 0;
      dst[i + 2] = (((gx + gy) * 0.5) + n2 * 0.35) | 0;
      dst[i + 3] = 255;
      i += 4;
    }
  }
  return rng >>> 0;
}

// Same nearest-neighbor scaler used in `miniprogram/workers/pixelizer/index.js`.
function scaleRgbaNearest(src, srcW, srcH, destW, destH, dest) {
  if (!src || !dest || !srcW || !srcH || !destW || !destH) return;
  if (srcW === destW && srcH === destH) {
    dest.set(src);
    return;
  }

  const safeSrcW = Math.max(1, srcW | 0);
  const safeSrcH = Math.max(1, srcH | 0);
  const safeDestW = Math.max(1, destW | 0);
  const safeDestH = Math.max(1, destH | 0);

  const xStep = ((safeSrcW << 16) / safeDestW) | 0;
  const yStep = ((safeSrcH << 16) / safeDestH) | 0;

  let yPos = 0;
  let di = 0;
  for (let y = 0; y < safeDestH; y += 1) {
    let sy = yPos >> 16;
    if (sy >= safeSrcH) sy = safeSrcH - 1;
    const srcRow = sy * safeSrcW * 4;
    let xPos = 0;
    for (let x = 0; x < safeDestW; x += 1) {
      let sx = xPos >> 16;
      if (sx >= safeSrcW) sx = safeSrcW - 1;
      const si = srcRow + (sx << 2);
      dest[di] = src[si];
      dest[di + 1] = src[si + 1];
      dest[di + 2] = src[si + 2];
      dest[di + 3] = src[si + 3];
      di += 4;
      xPos += xStep;
    }
    yPos += yStep;
  }
}

function pickPalette(key) {
  const entry = key && PALETTES[key] ? PALETTES[key] : PALETTES.dreamscape8;
  return hexToRgb(entry.colors);
}

function normalizeAlgoName(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  if (n === "floyd" || n === "floyd-steinberg" || n === "fs") return "floyd-steinberg";
  if (n === "atk" || n === "atkinson") return "atkinson";
  if (n === "b4" || n === "bayer4" || n === "bayer-4x4") return "bayer-4x4";
  if (n === "b8" || n === "bayer8" || n === "bayer-8x8") return "bayer-8x8";
  if (n === "rand" || n === "random") return "random";
  if (n === "none" || n === "nearest") return "nearest";
  return n;
}

function wasmDitherCode(ditherAlgo) {
  switch (normalizeAlgoName(ditherAlgo)) {
    case "atkinson":
      return 1;
    case "floyd-steinberg":
      return 2;
    case "bayer-4x4":
      return 3;
    case "bayer-8x8":
      return 4;
    case "random":
      return 5;
    default:
      return 0;
  }
}

function validateWasmExports(ex) {
  if (!ex) return false;
  return (
    ex.memory &&
    typeof ex.alloc === "function" &&
    typeof ex.dealloc === "function" &&
    typeof ex.set_base === "function" &&
    typeof ex.set_palette === "function" &&
    typeof ex.render === "function" &&
    typeof ex.work_len === "function"
  );
}

async function tryLoadWasm(wasmPath) {
  const abs = path.resolve(wasmPath);
  const bytes = fs.readFileSync(abs);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance && instance.exports ? instance.exports : null;
  if (!validateWasmExports(ex)) {
    throw new Error("invalid wasm exports");
  }
  return ex;
}

async function loadBestWasm() {
  const simdPath = path.join(__dirname, "..", "miniprogram", "wasm", "pixelizer_simd.wasm");
  const basePath = path.join(__dirname, "..", "miniprogram", "wasm", "pixelizer.wasm");
  try {
    const ex = await tryLoadWasm(simdPath);
    const isSimd = typeof ex.is_simd === "function" ? (ex.is_simd() | 0) : 0;
    return { ex, mode: isSimd ? "simd" : "base", path: simdPath };
  } catch (e) {
    const ex = await tryLoadWasm(basePath);
    return { ex, mode: "base", path: basePath, error: e && e.message ? e.message : String(e) };
  }
}

function wasmSetPalette(ex, paletteRgb) {
  const len = (paletteRgb && paletteRgb.length) | 0;
  const bytesLen = Math.max(0, len * 3);
  const ptr = ex.alloc(bytesLen) >>> 0;
  if (!ptr && bytesLen) return false;

  const mem = new Uint8Array(ex.memory.buffer);
  let o = ptr;
  for (let i = 0; i < len; i++) {
    const p = paletteRgb[i] || { r: 0, g: 0, b: 0 };
    mem[o++] = p.r & 255;
    mem[o++] = p.g & 255;
    mem[o++] = p.b & 255;
  }

  const ok = (ex.set_palette(ptr, len) | 0) === 1;
  ex.dealloc(ptr, bytesLen);
  return ok;
}

function wasmSetBase(ex, w, h, baseData) {
  const len = baseData.length | 0;
  if (!len) return false;
  const ptr = ex.alloc(len) >>> 0;
  if (!ptr) return false;
  new Uint8Array(ex.memory.buffer, ptr, len).set(baseData);
  const ok = (ex.set_base(ptr, len, w, h) | 0) === 1;
  ex.dealloc(ptr, len);
  return ok;
}

function wasmRenderInto(ex, outData, toneX, toneY, ditherAlgo, serpentine, seed) {
  const algo = wasmDitherCode(ditherAlgo);
  const ptr = ex.render(toneX, toneY, algo, serpentine ? 1 : 0, seed >>> 0) >>> 0;
  if (!ptr) return false;
  const len = ex.work_len() >>> 0;
  if (!len || len !== (outData.length | 0)) return false;
  const src = new Uint8Array(ex.memory.buffer, ptr, len);
  new Uint8Array(outData.buffer, outData.byteOffset, outData.byteLength).set(src);
  return true;
}

function benchCaseJs(cfg) {
  const {
    srcW,
    srcH,
    outW,
    outH,
    frames,
    warmup,
    vary,
    toneX,
    toneY,
    toneStatsMode,
    toneImpl,
    ditherAlgo,
    serpentine,
    paletteRgb,
    breakdown
  } = cfg;

  const src = new Uint8ClampedArray(srcW * srcH * 4);
  const base = new Uint8ClampedArray(outW * outH * 4);
  const work = new Uint8ClampedArray(outW * outH * 4);

  let seed = 0x12345678;
  seed = fillRgbaDeterministic(src, srcW, srcH, seed);

  let sharedToneStats = null;
  if (toneStatsMode === "once" && (toneX !== 0 || toneY !== 0)) {
    scaleRgbaNearest(src, srcW, srcH, outW, outH, base);
    sharedToneStats = computeToneStats({ data: base, width: outW, height: outH });
  }

  const timesTotal = [];
  const timesScale = breakdown ? [] : null;
  const timesCopy = breakdown ? [] : null;
  const timesToneStats = breakdown ? [] : null;
  const timesToneMap = breakdown ? [] : null;
  const timesDither = breakdown ? [] : null;

  let checksum = 0;

  const renderOne = (recordTimings) => {
    const record = breakdown && recordTimings;
    if (vary) {
      seed = fillRgbaDeterministic(src, srcW, srcH, seed);
    }

    let t0;
    let t1;

    t0 = record ? nowNs() : 0n;
    scaleRgbaNearest(src, srcW, srcH, outW, outH, base);
    if (record) {
      t1 = nowNs();
      timesScale.push(nsToMs(t1 - t0));
    }

    t0 = record ? nowNs() : 0n;
    work.set(base);
    if (record) {
      t1 = nowNs();
      timesCopy.push(nsToMs(t1 - t0));
    }

    const imgData = { data: work, width: outW, height: outH };

    if (toneX !== 0 || toneY !== 0) {
      let stats = sharedToneStats;
      if (!stats || toneStatsMode === "per-frame") {
        t0 = record ? nowNs() : 0n;
        stats = computeToneStats({ data: base, width: outW, height: outH });
        if (record) {
          t1 = nowNs();
          timesToneStats.push(nsToMs(t1 - t0));
        }
      } else if (record) {
        timesToneStats.push(0);
      }

      t0 = record ? nowNs() : 0n;
      const applyTone = toneImpl === "html" ? applyDynamicToneMappingHtml : applyDynamicToneMappingMini;
      applyTone(imgData, toneX, toneY, stats);
      if (record) {
        t1 = nowNs();
        timesToneMap.push(nsToMs(t1 - t0));
      }
    } else if (record) {
      timesToneStats.push(0);
      timesToneMap.push(0);
    }

    t0 = record ? nowNs() : 0n;
    switch (normalizeAlgoName(ditherAlgo)) {
      case "floyd-steinberg":
        ditherErrorDiffusion(imgData, paletteRgb, "floyd", serpentine);
        break;
      case "atkinson":
        ditherErrorDiffusion(imgData, paletteRgb, "atkinson", serpentine);
        break;
      case "bayer-4x4":
        ditherBayer(imgData, paletteRgb, 4);
        break;
      case "bayer-8x8":
        ditherBayer(imgData, paletteRgb, 8);
        break;
      case "random":
        ditherRandom(imgData, paletteRgb);
        break;
      default:
        ditherNearest(imgData, paletteRgb);
        break;
    }
    if (record) {
      t1 = nowNs();
      timesDither.push(nsToMs(t1 - t0));
    }

    checksum ^= work[(seed >>> 0) % work.length] | 0;
  };

  for (let i = 0; i < warmup; i++) renderOne(false);

  for (let i = 0; i < frames; i++) {
    const start = nowNs();
    renderOne(true);
    const end = nowNs();
    timesTotal.push(nsToMs(end - start));
  }

  return {
    engine: "js",
    total: summarizeSamples(timesTotal),
    breakdown: breakdown
      ? {
          scale: summarizeSamples(timesScale),
          copy: summarizeSamples(timesCopy),
          toneStats: summarizeSamples(timesToneStats),
          toneMap: summarizeSamples(timesToneMap),
          dither: summarizeSamples(timesDither)
        }
      : null,
    checksum
  };
}

function benchCaseWasm(cfg) {
  const {
    wasm,
    srcW,
    srcH,
    outW,
    outH,
    frames,
    warmup,
    vary,
    toneX,
    toneY,
    ditherAlgo,
    serpentine,
    paletteRgb,
    breakdown
  } = cfg;

  const ex = wasm && wasm.ex;
  if (!ex) {
    throw new Error("wasm not loaded");
  }

  const src = new Uint8ClampedArray(srcW * srcH * 4);
  const base = new Uint8ClampedArray(outW * outH * 4);
  const out = new Uint8ClampedArray(outW * outH * 4);

  let seed = 0x12345678;
  seed = fillRgbaDeterministic(src, srcW, srcH, seed);

  if (!wasmSetPalette(ex, paletteRgb)) {
    throw new Error("wasm set_palette failed");
  }

  const timesTotal = [];
  const timesScale = breakdown ? [] : null;
  const timesSetBase = breakdown ? [] : null;
  const timesRender = breakdown ? [] : null;

  let checksum = 0;

  const renderOne = (recordTimings) => {
    const record = breakdown && recordTimings;
    if (vary) {
      seed = fillRgbaDeterministic(src, srcW, srcH, seed);
    }

    let t0;
    let t1;

    t0 = record ? nowNs() : 0n;
    scaleRgbaNearest(src, srcW, srcH, outW, outH, base);
    if (record) {
      t1 = nowNs();
      timesScale.push(nsToMs(t1 - t0));
    }

    t0 = record ? nowNs() : 0n;
    if (!wasmSetBase(ex, outW, outH, base)) {
      throw new Error("wasm set_base failed");
    }
    if (record) {
      t1 = nowNs();
      timesSetBase.push(nsToMs(t1 - t0));
    }

    t0 = record ? nowNs() : 0n;
    if (!wasmRenderInto(ex, out, toneX, toneY, ditherAlgo, serpentine, seed)) {
      throw new Error("wasm render failed");
    }
    if (record) {
      t1 = nowNs();
      timesRender.push(nsToMs(t1 - t0));
    }

    checksum ^= out[(seed >>> 0) % out.length] | 0;
  };

  for (let i = 0; i < warmup; i++) renderOne(false);

  for (let i = 0; i < frames; i++) {
    const start = nowNs();
    renderOne(true);
    const end = nowNs();
    timesTotal.push(nsToMs(end - start));
  }

  return {
    engine: `wasm:${wasm.mode}`,
    total: summarizeSamples(timesTotal),
    breakdown: breakdown
      ? {
          scale: summarizeSamples(timesScale),
          setBase: summarizeSamples(timesSetBase),
          render: summarizeSamples(timesRender)
        }
      : null,
    checksum
  };
}

function printHelp() {
  const lines = [
    "Pixelizer benchmark (runs the worker-like pipeline across resolutions/options).",
    "",
    "Usage:",
    "  node tools/bench-pixelizer.js [--engine=js|wasm|both] [--preset=quick|full]",
    "    [--src=640x480] [--out=320x240,640x480] [--algo=atkinson,floyd-steinberg,...]",
    "    [--palette=dreamscape8,aap-64] [--tone=off|on|both] [--tone-x=-0.33 --tone-y=0.41]",
    "    [--serpentine=1] [--frames=60] [--warmup=10] [--vary=1] [--tone-stats=per-frame|once] [--tone-impl=mini|html]",
    "    [--breakdown=1]",
    "",
    "Examples (recommended to run on the Pi itself):",
    "  # Simulate camera 640x480 -> process 320x240, full pipeline, get fps",
    "  node tools/bench-pixelizer.js --engine=wasm --src=640x480 --out=320x240 --algo=atkinson --tone=on --frames=120",
    "",
    "  # Still-image style (toneStats once), worst-case larger output",
    "  node tools/bench-pixelizer.js --engine=wasm --out=640x480 --algo=floyd-steinberg --tone=on --tone-stats=once --frames=60",
    "",
    "Notes:",
    "  - Default is tuned for 'camera-like' use (toneStats per frame, nearest-neighbor scale).",
    "  - Run this ON the target device (Pi Zero 2 W) to get meaningful fps numbers."
  ];
  console.log(lines.join("\n"));
}

function truthy(v, def = false) {
  if (v === true) return true;
  if (v === false || v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function buildCases(opts) {
  const preset = String(opts.preset || "quick").trim().toLowerCase();
  const outResListRaw = splitList(opts.out || opts.res);
  const srcRes = parseRes(opts.src || "");
  const serpentine = truthy(opts.serpentine, true);

  const engines = (() => {
    const v = String(opts.engine || "both").trim().toLowerCase();
    if (v === "js") return ["js"];
    if (v === "wasm") return ["wasm"];
    return ["js", "wasm"];
  })();

  const frames = Math.max(1, (opts.frames != null ? parseInt(String(opts.frames), 10) : 60) | 0);
  const warmup = Math.max(0, (opts.warmup != null ? parseInt(String(opts.warmup), 10) : 10) | 0);
  const vary = truthy(opts.vary, true);
  const breakdown = truthy(opts.breakdown, false);

  const toneMode = String(opts.tone || (preset === "full" ? "both" : "on"))
    .trim()
    .toLowerCase();
  const toneXOn = clampSigned01(opts["tone-x"] != null ? opts["tone-x"] : -0.33);
  const toneYOn = clampSigned01(opts["tone-y"] != null ? opts["tone-y"] : 0.41);
  const toneStatsMode = String(opts["tone-stats"] || "per-frame").trim().toLowerCase() === "once"
    ? "once"
    : "per-frame";
  const toneImpl = (() => {
    const raw = String(opts["tone-impl"] || "mini").trim().toLowerCase();
    return raw === "html" ? "html" : "mini";
  })();

  const toneList = (() => {
    if (toneMode === "off") return [{ toneX: 0, toneY: 0, label: "off" }];
    if (toneMode === "on") return [{ toneX: toneXOn, toneY: toneYOn, label: "on" }];
    return [
      { toneX: 0, toneY: 0, label: "off" },
      { toneX: toneXOn, toneY: toneYOn, label: "on" }
    ];
  })();

  const algoList = (() => {
    const fromUser = splitList(opts.algo).map(normalizeAlgoName);
    if (fromUser.length) return fromUser;
    if (preset === "full") {
      return ["nearest", "bayer-4x4", "bayer-8x8", "atkinson", "floyd-steinberg", "random"];
    }
    return ["atkinson", "floyd-steinberg", "bayer-4x4", "nearest"];
  })();

  const paletteKeys = (() => {
    const fromUser = splitList(opts.palette);
    if (fromUser.length) return fromUser;
    if (preset === "full") return ["dreamscape8", "aap-64"];
    return ["dreamscape8"];
  })();

  const outResList = (() => {
    const parsed = outResListRaw.map(parseRes).filter(Boolean);
    if (parsed.length) return parsed;
    if (preset === "full") {
      return [parseRes("160x120"), parseRes("320x240"), parseRes("480x270"), parseRes("640x360"), parseRes("640x480"), parseRes("960x540")].filter(Boolean);
    }
    return [parseRes("320x240"), parseRes("640x480")].filter(Boolean);
  })();

  const cases = [];
  for (const outRes of outResList) {
    const src = srcRes || outRes;
    for (const paletteKey of paletteKeys) {
      const paletteRgb = pickPalette(paletteKey);
      for (const algo of algoList) {
        for (const tone of toneList) {
          for (const eng of engines) {
            cases.push({
              engine: eng,
              srcW: src.w,
              srcH: src.h,
              outW: outRes.w,
              outH: outRes.h,
              outKey: outRes.key,
              srcKey: src.key,
              paletteKey,
              paletteRgb,
              ditherAlgo: algo,
              serpentine,
              toneX: tone.toneX,
              toneY: tone.toneY,
              toneLabel: tone.label,
              toneStatsMode,
              toneImpl,
              frames,
              warmup,
              vary,
              breakdown
            });
          }
        }
      }
    }
  }
  return cases;
}

function printTableHeader(showBreakdown) {
  const baseCols = [
    "engine".padEnd(10),
    "src".padEnd(9),
    "out".padEnd(9),
    "algo".padEnd(14),
    "palette".padEnd(12),
    "tone".padEnd(4),
    "avg_ms".padStart(8),
    "p95_ms".padStart(8),
    "fps".padStart(7)
  ];
  if (!showBreakdown) {
    console.log(baseCols.join("  "));
    return;
  }
  const extra = [
    "scale".padStart(8),
    "stage2".padStart(8),
    "stage3".padStart(8)
  ];
  console.log(baseCols.concat(extra).join("  "));
}

function printResultRow(cfg, result) {
  const t = result.total;
  const cols = [
    String(result.engine).padEnd(10),
    String(cfg.srcKey).padEnd(9),
    String(cfg.outKey).padEnd(9),
    String(cfg.ditherAlgo).padEnd(14),
    String(cfg.paletteKey).padEnd(12),
    String(cfg.toneLabel).padEnd(4),
    formatMs(t.avg, 8),
    formatMs(t.p95, 8),
    (t.fps ? t.fps.toFixed(1) : "0.0").toString().padStart(7, " ")
  ];

  if (!cfg.breakdown || !result.breakdown) {
    console.log(cols.join("  "));
    return;
  }

  const b = result.breakdown;
  if (result.engine.startsWith("wasm")) {
    cols.push(formatMs(b.scale.avg, 8), formatMs(b.setBase.avg, 8), formatMs(b.render.avg, 8));
  } else {
    const stage2 = (b.copy.avg || 0) + (b.toneStats.avg || 0) + (b.toneMap.avg || 0);
    cols.push(formatMs(b.scale.avg, 8), formatMs(stage2, 8), formatMs(b.dither.avg, 8));
  }
  console.log(cols.join("  "));
}

async function main() {
  const args = parseKeyValueArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const cases = buildCases(args);
  if (!cases.length) {
    console.error("No cases to run (check --out/--algo/--palette args).");
    process.exitCode = 2;
    return;
  }

  const needWasm = cases.some((c) => c.engine === "wasm");
  let wasm = null;
  if (needWasm) {
    wasm = await loadBestWasm();
    if (wasm && wasm.error) {
      console.warn(`[warn] wasm simd load failed, fell back to base: ${wasm.error}`);
    }
  }

  printTableHeader(cases.some((c) => c.breakdown));

  for (const cfg of cases) {
    try {
      const result =
        cfg.engine === "wasm"
          ? benchCaseWasm({ ...cfg, wasm })
          : benchCaseJs(cfg);
      printResultRow(cfg, result);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.log(
        [
          String(cfg.engine).padEnd(10),
          String(cfg.srcKey).padEnd(9),
          String(cfg.outKey).padEnd(9),
          String(cfg.ditherAlgo).padEnd(14),
          String(cfg.paletteKey).padEnd(12),
          String(cfg.toneLabel).padEnd(4),
          "  ERROR: " + msg
        ].join("  ")
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
