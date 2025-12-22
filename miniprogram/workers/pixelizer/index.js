const { PALETTES } = require("../../utils/pixelizer/palettes");
const {
  hexToRgb,
  ditherNearest,
  ditherRandom,
  ditherErrorDiffusion,
  ditherBayer
} = require("../../utils/pixelizer/dither");
const { computeToneStats, applyDynamicToneMapping } = require("../../utils/pixelizer/tone");

const state = {
  baseKey: "",
  baseW: 0,
  baseH: 0,
  baseData: null,
  toneStats: null,

  workW: 0,
  workH: 0,
  workData: null,

  paletteKey: "",
  palette: null
};

function clamp01(v) {
  if (!(v > 0)) return 0;
  if (v > 1) return 1;
  return v;
}

function ensureWorkBuffer(w, h) {
  const needLen = Math.max(0, (w | 0) * (h | 0) * 4);
  if (!state.workData || state.workW !== w || state.workH !== h || state.workData.length !== needLen) {
    state.workW = w;
    state.workH = h;
    state.workData = new Uint8ClampedArray(needLen);
  }
  return state.workData;
}

function ensurePalette(paletteKey) {
  if (paletteKey && paletteKey === state.paletteKey && state.palette) return state.palette;

  const entry = paletteKey && PALETTES[paletteKey] ? PALETTES[paletteKey] : PALETTES.dreamscape8;
  state.paletteKey = paletteKey && PALETTES[paletteKey] ? paletteKey : "dreamscape8";
  state.palette = hexToRgb(entry.colors);
  return state.palette;
}

function postError(type, token, message) {
  worker.postMessage({ type, token, ok: false, error: message });
}

worker.onMessage((msg) => {
  const data = msg || {};
  const type = data.type;

  if (type === "setBase") {
    const w = Math.max(1, data.w | 0);
    const h = Math.max(1, data.h | 0);
    const buf = data.buffer;
    const key = typeof data.baseKey === "string" ? data.baseKey : "";

    if (!buf || typeof buf.byteLength !== "number") {
      postError("baseSet", null, "invalid base buffer");
      return;
    }

    const expected = w * h * 4;
    if (buf.byteLength !== expected) {
      postError("baseSet", null, `base buffer size mismatch (${buf.byteLength} != ${expected})`);
      return;
    }

    state.baseKey = key;
    state.baseW = w;
    state.baseH = h;
    state.baseData = new Uint8ClampedArray(buf);
    state.toneStats = null;
    ensureWorkBuffer(w, h);

    worker.postMessage({ type: "baseSet", ok: true, baseKey: state.baseKey, w, h });
    return;
  }

  if (type === "render") {
    const token = data.token;
    const w = state.baseW | 0;
    const h = state.baseH | 0;
    const baseData = state.baseData;

    if (!baseData || !w || !h) {
      postError("rendered", token, "base not ready");
      return;
    }

    const toneX = clamp01(Math.abs(data.toneX || 0)) * Math.sign(data.toneX || 0);
    const toneY = clamp01(Math.abs(data.toneY || 0)) * Math.sign(data.toneY || 0);
    const ditherAlgo = typeof data.ditherAlgo === "string" ? data.ditherAlgo : "atkinson";
    const serpentine = !!data.serpentine;

    const paletteKey = typeof data.paletteKey === "string" ? data.paletteKey : "dreamscape8";
    const palette = ensurePalette(paletteKey);

    const workData = ensureWorkBuffer(w, h);
    workData.set(baseData);

    const imgData = { data: workData, width: w, height: h };

    if (toneX !== 0 || toneY !== 0) {
      if (!state.toneStats) {
        state.toneStats = computeToneStats({ data: baseData, width: w, height: h });
      }
      applyDynamicToneMapping(imgData, toneX, toneY, state.toneStats);
    }

    switch (ditherAlgo) {
      case "floyd-steinberg":
        ditherErrorDiffusion(imgData, palette, "floyd", serpentine);
        break;
      case "atkinson":
        ditherErrorDiffusion(imgData, palette, "atkinson", serpentine);
        break;
      case "bayer-4x4":
        ditherBayer(imgData, palette, 4);
        break;
      case "bayer-8x8":
        ditherBayer(imgData, palette, 8);
        break;
      case "random":
        ditherRandom(imgData, palette);
        break;
      default:
        ditherNearest(imgData, palette);
        break;
    }

    worker.postMessage({
      type: "rendered",
      ok: true,
      token,
      w,
      h,
      buffer: workData.buffer
    });
  }
});

