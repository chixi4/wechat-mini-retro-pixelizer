const { PALETTES } = require("./palettes");
const {
  hexToRgb,
  ditherNearest,
  ditherRandom,
  ditherErrorDiffusion,
  ditherBayer
} = require("./dither");
const { computeToneStats, applyDynamicToneMapping } = require("./tone");

const WASM_PATH_BASE = "wasm/pixelizer.wasm";
const WASM_PATH_SIMD = "wasm/pixelizer_simd.wasm";

const wasm = {
  status: "idle", // idle | loading | ready | failed
  promise: null,
  exports: null,
  memory: null,
  isSimd: false,
  baseKey: "",
  paletteKey: "",
  lastError: ""
};

function hasWXWebAssembly() {
  return typeof WXWebAssembly !== "undefined" && WXWebAssembly && typeof WXWebAssembly.instantiate === "function";
}

function makeSelfTestBase(w, h) {
  const len = Math.max(0, (w | 0) * (h | 0) * 4);
  const out = new Uint8ClampedArray(len);
  let rng = 0x12345678;
  for (let i = 0; i < len; i += 4) {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    out[i] = rng & 255;
    out[i + 1] = (rng >>> 8) & 255;
    out[i + 2] = (rng >>> 16) & 255;
    out[i + 3] = 255;
  }
  return out;
}

function runWasmSelfTest(exports, memory) {
  try {
    if (!exports || !memory) return false;

    const w = 32;
    const h = 24;
    const toneX = -0.33;
    const toneY = 0.41;
    const serpentine = true;

    const palette = hexToRgb(PALETTES.dreamscape8.colors);
    const base = makeSelfTestBase(w, h);

    const jsExpected = (type) => {
      const out = new Uint8ClampedArray(base);
      const imgData = { data: out, width: w, height: h };
      const stats = computeToneStats({ data: base, width: w, height: h });
      applyDynamicToneMapping(imgData, toneX, toneY, stats);
      ditherErrorDiffusion(imgData, palette, type, serpentine);
      return out;
    };

    const expectedAtk = jsExpected("atkinson");
    const expectedFloyd = jsExpected("floyd");

    const palBytes = new Uint8Array(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      palBytes[i * 3] = p.r & 255;
      palBytes[i * 3 + 1] = p.g & 255;
      palBytes[i * 3 + 2] = p.b & 255;
    }

    let ptr = exports.alloc(palBytes.length) >>> 0;
    new Uint8Array(memory.buffer, ptr, palBytes.length).set(palBytes);
    exports.set_palette(ptr, palette.length);
    exports.dealloc(ptr, palBytes.length);

    ptr = exports.alloc(base.length) >>> 0;
    new Uint8Array(memory.buffer, ptr, base.length).set(new Uint8Array(base.buffer));
    exports.set_base(ptr, base.length, w, h);
    exports.dealloc(ptr, base.length);

    const verify = (algoCode, expected) => {
      const outPtr = exports.render(toneX, toneY, algoCode, serpentine ? 1 : 0, 0) >>> 0;
      if (!outPtr) return false;
      const outLen = exports.work_len() >>> 0;
      if (outLen !== expected.length) return false;
      const got = new Uint8Array(memory.buffer, outPtr, outLen);
      for (let i = 0; i < outLen; i++) {
        if (got[i] !== expected[i]) return false;
      }
      return true;
    };

    // atkinson = 1, floyd = 2 (same mapping as worker)
    if (!verify(1, expectedAtk)) return false;
    if (!verify(2, expectedFloyd)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function ensureWasm() {
  if (wasm.status === "ready") return wasm.exports;
  if (wasm.status === "failed") return null;
  if (wasm.status === "loading") return wasm.promise;

  if (!hasWXWebAssembly()) {
    wasm.status = "failed";
    wasm.lastError = "WXWebAssembly unavailable";
    return null;
  }

  wasm.status = "loading";
  wasm.promise = (async () => {
    const imports = {}; // 安卓旧版本不传 imports 可能 crash

    let result;
    try {
      result = await WXWebAssembly.instantiate(WASM_PATH_SIMD, imports);
      const ex = result && result.instance && result.instance.exports ? result.instance.exports : null;
      if (!runWasmSelfTest(ex, ex && ex.memory ? ex.memory : null)) {
        throw new Error("wasm simd self-test failed");
      }
      wasm.isSimd = true;
    } catch (e) {
      result = await WXWebAssembly.instantiate(WASM_PATH_BASE, imports);
      wasm.isSimd = false;
    }

    const exports = result && result.instance && result.instance.exports ? result.instance.exports : null;
    if (
      !exports ||
      typeof exports.alloc !== "function" ||
      typeof exports.dealloc !== "function" ||
      typeof exports.set_base !== "function" ||
      typeof exports.set_palette !== "function" ||
      typeof exports.render !== "function" ||
      typeof exports.work_len !== "function" ||
      !exports.memory
    ) {
      throw new Error("invalid wasm exports");
    }

    wasm.exports = exports;
    wasm.memory = exports.memory;
    wasm.status = "ready";
    return exports;
  })().catch((e) => {
    wasm.status = "failed";
    wasm.lastError = e && e.message ? e.message : String(e);
    return null;
  });

  return wasm.promise;
}

function wasmDitherCode(ditherAlgo) {
  switch (ditherAlgo) {
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

function wasmSetPalette(paletteKey, palette) {
  const ex = wasm.exports;
  if (!ex || !wasm.memory) return false;

  const len = (palette && palette.length) | 0;
  const bytesLen = Math.max(0, len * 3);

  const ptr = ex.alloc(bytesLen) >>> 0;
  if (!ptr && bytesLen) return false;

  const mem = new Uint8Array(wasm.memory.buffer);
  let o = ptr;
  for (let i = 0; i < len; i++) {
    const p = palette[i] || { r: 0, g: 0, b: 0 };
    mem[o++] = p.r & 255;
    mem[o++] = p.g & 255;
    mem[o++] = p.b & 255;
  }

  const ok = (ex.set_palette(ptr, len) | 0) === 1;
  ex.dealloc(ptr, bytesLen);
  if (ok) wasm.paletteKey = paletteKey || "";
  return ok;
}

function wasmSetBase(baseKey, w, h, baseData) {
  const ex = wasm.exports;
  if (!ex || !wasm.memory || !baseData) return false;

  const len = baseData.length | 0;
  if (!len) return false;

  const ptr = ex.alloc(len) >>> 0;
  if (!ptr) return false;

  new Uint8Array(wasm.memory.buffer, ptr, len).set(baseData);
  const ok = (ex.set_base(ptr, len, w, h) | 0) === 1;
  ex.dealloc(ptr, len);
  if (ok) wasm.baseKey = baseKey || "";
  return ok;
}

function wasmRenderInto(outData, toneX, toneY, ditherAlgo, serpentine, seed) {
  const ex = wasm.exports;
  if (!ex || !wasm.memory || !outData) return false;

  const algo = wasmDitherCode(ditherAlgo);
  const ptr = ex.render(toneX, toneY, algo, serpentine ? 1 : 0, seed >>> 0) >>> 0;
  if (!ptr) return false;

  const len = ex.work_len() >>> 0;
  if (!len || len !== (outData.length | 0)) return false;

  const src = new Uint8Array(wasm.memory.buffer, ptr, len);
  new Uint8Array(outData.buffer, outData.byteOffset, outData.byteLength).set(src);
  return true;
}

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

function perfNow() {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}

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

let messageQueue = Promise.resolve();
worker.onMessage((msg) => {
  messageQueue = messageQueue.then(() => handleMessage(msg)).catch(() => {
    // keep worker alive even if a render throws
  });
});

async function handleMessage(msg) {
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

    // 预热 wasm（不阻塞 setBase 响应）
    wasm.baseKey = "";
    ensureWasm();

    worker.postMessage({ type: "baseSet", ok: true, baseKey: state.baseKey, w, h });
    return;
  }

  if (type === "render") {
    const token = data.token;
    const perfEnabled = !!data.perf;
    const perf = perfEnabled ? { start: perfNow(), steps: {} } : null;
    const perfMeasure = (label, fn) => {
      if (!perf) return fn();
      const t = perfNow();
      const result = fn();
      perf.steps[label] = +(perfNow() - t).toFixed(2);
      return result;
    };
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

    const seed = (data.seed >>> 0) || ((Date.now() ^ ((w & 65535) << 16) ^ (h & 65535)) >>> 0);

    let workData = ensureWorkBuffer(w, h);

    let usedWasm = false;
    const ex = await ensureWasm();
    if (ex) {
      try {
        if (paletteKey !== wasm.paletteKey) {
          perfMeasure("wasmSetPalette", () => {
            if (!wasmSetPalette(paletteKey, palette)) {
              throw new Error("wasm set_palette failed");
            }
          });
        }

        const baseKey = state.baseKey || "";
        if (baseKey !== wasm.baseKey) {
          perfMeasure("wasmSetBase", () => {
            if (!wasmSetBase(baseKey, w, h, baseData)) {
              throw new Error("wasm set_base failed");
            }
          });
        }

        perfMeasure("wasmRender", () => {
          if (!wasmRenderInto(workData, toneX, toneY, ditherAlgo, serpentine, seed)) {
            throw new Error("wasm render failed");
          }
        });

        usedWasm = true;
      } catch (e) {
        wasm.status = "failed";
        wasm.lastError = e && e.message ? e.message : String(e);
      }
    }

    if (!usedWasm) {
      perfMeasure("baseCopy", () => {
        workData.set(baseData);
      });

      const imgData = { data: workData, width: w, height: h };

      if (toneX !== 0 || toneY !== 0) {
        if (!state.toneStats) {
          perfMeasure("toneStats", () => {
            state.toneStats = computeToneStats({ data: baseData, width: w, height: h });
          });
        }
        perfMeasure("toneMap", () => {
          applyDynamicToneMapping(imgData, toneX, toneY, state.toneStats);
        });
      }

      const ditherStart = perf ? perfNow() : 0;
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
      if (perf) {
        perf.steps.dither = +(perfNow() - ditherStart).toFixed(2);
      }
    }

    if (perf) {
      perf.total = +(perfNow() - perf.start).toFixed(2);
      perf.meta = { w, h, ditherAlgo, toneX, toneY, wasm: usedWasm ? (wasm.isSimd ? "simd" : "base") : "off" };
      if (!usedWasm && wasm.lastError) perf.meta.wasmError = wasm.lastError;
    }

    const payload = { type: "rendered", ok: true, token, w, h, buffer: workData.buffer };
    if (perf) payload.perf = perf;
    worker.postMessage(payload);
  }
}
