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

function describeMismatch(index, expected, got, w) {
  const px = (index / 4) | 0;
  return {
    index,
    expected,
    got,
    x: px % w,
    y: (px / w) | 0,
    channel: index % 4
  };
}

function summarizeSelfTest(result) {
  if (!result) return "ok=0 reason=missing";
  const simd = result.isSimd | 0;
  if (result.ok) return `ok=1 simd=${simd}`;
  const fail = Array.isArray(result.cases) ? result.cases.find((c) => !c.ok) : null;
  if (!fail) {
    const reason = result.reason || "unknown";
    return `ok=0 simd=${simd} reason=${reason}`;
  }
  const reason = fail.reason || result.reason || "unknown";
  const name = fail.name || result.failedCase || "unknown";
  const m = fail.mismatch;
  if (m) {
    return `ok=0 simd=${simd} case=${name} reason=${reason} idx=${m.index} exp=${m.expected} got=${m.got} x=${m.x} y=${m.y} ch=${m.channel}`;
  }
  return `ok=0 simd=${simd} case=${name} reason=${reason}`;
}

function runWasmSelfTestDetailed(exports, memory) {
  const result = {
    ok: false,
    reason: "",
    cases: [],
    isSimd: 0
  };

  try {
    if (!exports || !memory) {
      result.reason = "missing exports/memory";
      return result;
    }

    if (typeof exports.is_simd === "function") {
      result.isSimd = exports.is_simd() | 0;
    }

    const w = 32;
    const h = 24;
    const serpentine = true;
    const palette = hexToRgb(PALETTES.dreamscape8.colors);
    const base = makeSelfTestBase(w, h);
    const baseView = new Uint8Array(base.buffer, base.byteOffset, base.byteLength);
    const toneStats = computeToneStats({ data: base, width: w, height: h });

    const jsExpected = (type, toneX, toneY) => {
      const out = new Uint8ClampedArray(base);
      const imgData = { data: out, width: w, height: h };
      if (toneX !== 0 || toneY !== 0) {
        applyDynamicToneMapping(imgData, toneX, toneY, toneStats);
      }
      ditherErrorDiffusion(imgData, palette, type, serpentine);
      return out;
    };

    const palBytes = new Uint8Array(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      palBytes[i * 3] = p.r & 255;
      palBytes[i * 3 + 1] = p.g & 255;
      palBytes[i * 3 + 2] = p.b & 255;
    }

    let ptr = exports.alloc(palBytes.length) >>> 0;
    if (!ptr && palBytes.length) {
      result.reason = "alloc palette failed";
      return result;
    }
    new Uint8Array(memory.buffer, ptr, palBytes.length).set(palBytes);
    const palOk = (exports.set_palette(ptr, palette.length) | 0) === 1;
    exports.dealloc(ptr, palBytes.length);
    if (!palOk) {
      result.reason = "set_palette failed";
      return result;
    }

    ptr = exports.alloc(baseView.length) >>> 0;
    if (!ptr) {
      result.reason = "alloc base failed";
      return result;
    }
    new Uint8Array(memory.buffer, ptr, baseView.length).set(baseView);
    const baseOk = (exports.set_base(ptr, baseView.length, w, h) | 0) === 1;
    exports.dealloc(ptr, baseView.length);
    if (!baseOk) {
      result.reason = "set_base failed";
      return result;
    }

    const cases = [
      { name: "tone-off-atk", toneX: 0, toneY: 0, type: "atkinson", code: 1 },
      { name: "tone-off-floyd", toneX: 0, toneY: 0, type: "floyd", code: 2 },
      { name: "tone-on-atk", toneX: -0.33, toneY: 0.41, type: "atkinson", code: 1 },
      { name: "tone-on-floyd", toneX: -0.33, toneY: 0.41, type: "floyd", code: 2 }
    ];

    let firstFail = null;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const expected = jsExpected(c.type, c.toneX, c.toneY);
      const outPtr = exports.render(c.toneX, c.toneY, c.code, serpentine ? 1 : 0, 0) >>> 0;
      const entry = { name: c.name, ok: false };

      if (!outPtr) {
        entry.reason = "render returned 0";
      } else {
        const outLen = exports.work_len() >>> 0;
        if (outLen !== expected.length) {
          entry.reason = "length mismatch";
          entry.meta = { outLen, expected: expected.length };
        } else {
          const got = new Uint8Array(memory.buffer, outPtr, outLen);
          let mismatch = null;
          for (let j = 0; j < outLen; j++) {
            if (got[j] !== expected[j]) {
              mismatch = describeMismatch(j, expected[j], got[j], w);
              break;
            }
          }
          if (mismatch) {
            entry.reason = "byte mismatch";
            entry.mismatch = mismatch;
          } else {
            entry.ok = true;
          }
        }
      }

      result.cases.push(entry);
      if (!entry.ok && !firstFail) {
        firstFail = entry;
      }
    }

    result.ok = !firstFail;
    if (firstFail) {
      result.reason = firstFail.reason || "self-test failed";
      result.failedCase = firstFail.name;
    }
    return result;
  } catch (e) {
    result.reason = e && e.message ? e.message : String(e);
    return result;
  }
}

async function ensureWasm() {
  if (wasm.status === "ready") return wasm.exports;
  if (wasm.status === "failed") return null;
  if (wasm.status === "loading") return wasm.promise;

  if (!hasWXWebAssembly()) {
    wasm.status = "failed";
    wasm.lastError = "WXWebAssembly unavailable";
    postWorkerLog("warn", "WXWebAssembly unavailable");
    return null;
  }

  wasm.status = "loading";
  wasm.promise = (async () => {
    const imports = {}; // 安卓旧版本不传 imports 可能 crash

    let result;
    let simdTest = null;
    try {
      result = await WXWebAssembly.instantiate(WASM_PATH_SIMD, imports);
      const ex = result && result.instance && result.instance.exports ? result.instance.exports : null;
      simdTest = runWasmSelfTestDetailed(ex, ex && ex.memory ? ex.memory : null);
      if (!simdTest.ok) {
        wasm.lastError = `simd self-test failed: ${simdTest.reason}`;
        const summary = summarizeSelfTest(simdTest);
        console.log("[wasm] simd self-test failed", summary);
        postWorkerLog("warn", "wasm simd self-test failed", summary);
        throw new Error("wasm simd self-test failed");
      }
      postWorkerLog("info", "wasm simd self-test ok", summarizeSelfTest(simdTest));
      wasm.isSimd = true;
    } catch (e) {
      if (!simdTest) {
        const msg = e && e.message ? e.message : String(e);
        wasm.lastError = `simd instantiate failed: ${msg}`;
        console.log("[wasm] simd instantiate failed", msg);
        postWorkerLog("warn", "wasm simd instantiate failed", { message: msg });
      }
      result = await WXWebAssembly.instantiate(WASM_PATH_BASE, imports);
      wasm.isSimd = false;
      if (simdTest && !simdTest.ok) {
        const baseEx = result && result.instance && result.instance.exports ? result.instance.exports : null;
        const baseTest = runWasmSelfTestDetailed(baseEx, baseEx && baseEx.memory ? baseEx.memory : null);
        const baseSummary = summarizeSelfTest(baseTest);
        console.log("[wasm] base self-test after simd failure", baseSummary);
        postWorkerLog("info", "wasm base self-test after simd failure", baseSummary);
      }
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

function postWorkerLog(level, message, detail) {
  try {
    worker.postMessage({ type: "workerLog", level, message, detail });
  } catch (e) {
    // ignore logging failures
  }
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
