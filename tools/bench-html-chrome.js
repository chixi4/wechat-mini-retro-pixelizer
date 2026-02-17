#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

function patchHtmlForBench(html) {
  const pattern = /return\s*\{\s*init\s*\}\s*;/;
  if (!pattern.test(html)) {
    throw new Error("failed to patch HTML: could not find `return { init };`");
  }

  // Expose a minimal internal API for benchmarking without changing runtime behavior.
  const injectedReturn = `return {
    init,
    __bench: {
      state,
      proc,
      loadPalette,
      processImage,
      forceRescale: () => {
        try {
          proc.scaled.image = null;
          proc.scaled.data = null;
        } catch {}
      },
      clearToneStatsCache: () => {
        try {
          toneStatsCache = { image: null, w: 0, h: 0, stats: null };
        } catch {}
      }
    }
  };`;

  return html.replace(pattern, injectedReturn);
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
  const s = String(v).trim();
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function truthy(v, def = false) {
  if (v === true) return true;
  if (v === false || v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.json();
}

async function waitForDevtools(port, timeoutMs) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(80);
    }
  }
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr || "unknown");
  throw new Error(`DevTools endpoint not ready: ${msg}`);
}

class CDPClient {
  constructor(wsUrl) {
    this._ws = new WebSocket(wsUrl);
    this._nextId = 1;
    this._pending = new Map();
    this._events = new Map();
    this._open = new Promise((resolve, reject) => {
      this._ws.addEventListener("open", () => resolve());
      this._ws.addEventListener("error", (e) => reject(e));
    });

    this._ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id) {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        if (msg.error) {
          const em = msg.error && msg.error.message ? msg.error.message : JSON.stringify(msg.error);
          p.reject(new Error(em));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        const handlers = this._events.get(msg.method);
        if (handlers) {
          for (const h of handlers) {
            try {
              h(msg.params);
            } catch {
              // ignore
            }
          }
        }
      }
    });
  }

  async ready() {
    await this._open;
  }

  on(method, handler) {
    if (!this._events.has(method)) this._events.set(method, new Set());
    this._events.get(method).add(handler);
    return () => {
      const set = this._events.get(method);
      if (set) set.delete(handler);
    };
  }

  async send(method, params = {}) {
    await this._open;
    const id = this._nextId++;
    const payload = { id, method, params };
    const p = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    this._ws.send(JSON.stringify(payload));
    return await p;
  }

  async close() {
    try {
      this._ws.close();
    } catch {
      // ignore
    }
  }
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

function printHelp() {
  console.log(
    [
      "Bench a local HTML pixelizer in headless Chrome via DevTools Protocol.",
      "",
      "Usage:",
      "  node tools/bench-html-chrome.js --html=PATH [--mode=still|camera-like]",
      "    [--src=640x480] [--tw=160,320,640] [--algo=atkinson,floyd-steinberg,...]",
      "    [--palette=dreamscape8,aap-64] [--tone=off|on|both] [--frames=20] [--warmup=5]",
      "",
      "Notes:",
      "  - mode=still: reuses cached scaled pixels (typical uploaded-image adjustments).",
      "  - mode=camera-like: forces re-scale + toneStats per frame (closer to live preview cost)."
    ].join("\n")
  );
}

async function main() {
  const args = parseKeyValueArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const htmlPath = args.html ? String(args.html) : "";
  if (!htmlPath) {
    console.error("Missing --html=PATH");
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(htmlPath)) {
    console.error(`HTML not found: ${htmlPath}`);
    process.exitCode = 2;
    return;
  }

  const chromePath =
    args.chrome ||
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
  if (!fs.existsSync(chromePath)) {
    console.error(`Chrome not found: ${chromePath}`);
    process.exitCode = 2;
    return;
  }

  const mode = String(args.mode || "camera-like").trim().toLowerCase();
  const frames = Math.max(1, (args.frames != null ? parseInt(String(args.frames), 10) : 20) | 0);
  const warmup = Math.max(0, (args.warmup != null ? parseInt(String(args.warmup), 10) : 5) | 0);

  const twList = splitList(args.tw || args.width || args.targetWidth);
  const targetWidths = (twList.length ? twList : ["160", "320", "640"]).map((x) =>
    Math.max(8, parseInt(String(x), 10) | 0)
  );

  const algoList = splitList(args.algo);
  const algos = algoList.length
    ? algoList
    : ["nearest", "bayer-4x4", "bayer-8x8", "atkinson", "floyd-steinberg", "random"];

  const paletteList = splitList(args.palette);
  const palettes = paletteList.length ? paletteList : ["dreamscape8", "aap-64"];

  const toneMode = String(args.tone || "both").trim().toLowerCase();
  const toneXOn = args["tone-x"] != null ? Number(args["tone-x"]) : -0.33;
  const toneYOn = args["tone-y"] != null ? Number(args["tone-y"]) : 0.41;
  const toneCases =
    toneMode === "off"
      ? [{ label: "off", x: 0, y: 0 }]
      : toneMode === "on"
        ? [{ label: "on", x: toneXOn, y: toneYOn }]
        : [
            { label: "off", x: 0, y: 0 },
            { label: "on", x: toneXOn, y: toneYOn }
          ];

  const src = String(args.src || "640x480")
    .trim()
    .match(/^(\d+)\s*[xX]\s*(\d+)$/);
  const srcW = src ? Math.max(1, parseInt(src[1], 10) | 0) : 640;
  const srcH = src ? Math.max(1, parseInt(src[2], 10) | 0) : 480;

  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-html-chrome-"));
  const patchedHtmlPath = path.join(userDataDir, "bench.html");
  const originalHtml = fs.readFileSync(htmlPath, "utf8");
  const patchedHtml = patchHtmlForBench(originalHtml);
  fs.writeFileSync(patchedHtmlPath, patchedHtml, "utf8");
  const fileUrl = pathToFileURL(path.resolve(patchedHtmlPath)).toString();

  const chromeArgs = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ];

  const chrome = spawn(chromePath, chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let chromeExited = false;
  chrome.on("exit", () => {
    chromeExited = true;
  });

  try {
    await waitForDevtools(port, 8000);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const target = Array.isArray(targets)
      ? targets.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl)
      : null;
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error("failed to find DevTools page target");
    }

    const cdp = new CDPClient(target.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const loadDone = new Promise((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
    });
    await cdp.send("Page.navigate", { url: fileUrl });
    await loadDone;

    // Run the benchmark in the page context.
    const config = {
      mode,
      frames,
      warmup,
      srcW,
      srcH,
      targetWidths,
      algos,
      palettes,
      toneCases
    };

    const expression = `(async () => {
      const cfg = ${JSON.stringify(config)};
      const mode = cfg.mode;

      const xorshift32 = (seed) => {
        let x = seed >>> 0;
        x ^= (x << 13) >>> 0;
        x ^= x >>> 17;
        x ^= (x << 5) >>> 0;
        return x >>> 0;
      };

      const fillDeterministic = (data, w, h, seed) => {
        let rng = seed >>> 0;
        let i = 0;
        for (let y = 0; y < h; y++) {
          const gy = (y * 255) / Math.max(1, h - 1);
          for (let x = 0; x < w; x++) {
            rng = xorshift32(rng);
            const gx = (x * 255) / Math.max(1, w - 1);
            const n0 = rng & 255;
            const n1 = (rng >>> 8) & 255;
            const n2 = (rng >>> 16) & 255;
            data[i] = (gx + n0 * 0.35) | 0;
            data[i + 1] = (gy + n1 * 0.35) | 0;
            data[i + 2] = (((gx + gy) * 0.5) + n2 * 0.35) | 0;
            data[i + 3] = 255;
            i += 4;
          }
        }
        return rng >>> 0;
      };

      const createTestImage = async (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const imgData = ctx.createImageData(w, h);
        fillDeterministic(imgData.data, w, h, 0x12345678);
        ctx.putImageData(imgData, 0, 0);
        const img = new Image();
        img.src = c.toDataURL('image/png');
        if (img.decode) await img.decode();
        else await new Promise((res, rej) => { img.onload = () => res(); img.onerror = (e) => rej(e); });
        return img;
      };

      const percentile = (sorted, p) => {
        if (!sorted.length) return NaN;
        const clamped = Math.max(0, Math.min(1, p));
        const idx = Math.floor(clamped * (sorted.length - 1));
        return sorted[idx];
      };
      const summarize = (samples) => {
        const n = samples.length;
        if (!n) return null;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < n; i++) {
          const v = samples[i];
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const avg = sum / n;
        const sorted = samples.slice().sort((a,b) => a - b);
        const p50 = percentile(sorted, 0.5);
        const p95 = percentile(sorted, 0.95);
        const fps = avg > 0 ? 1000 / avg : 0;
        return { n, avg, min, max, p50, p95, fps };
      };

      // Ensure page is initialized enough.
      if (typeof App === 'undefined' || !App || !App.__bench) {
        throw new Error('App.__bench not found (HTML patch failed?)');
      }
      const bench = App.__bench;
      if (typeof bench.processImage !== 'function') throw new Error('bench.processImage() missing');
      if (typeof bench.loadPalette !== 'function') throw new Error('bench.loadPalette() missing');

      bench.state.sourceMode = 'image';
      bench.state.originalImage = await createTestImage(cfg.srcW, cfg.srcH);

      const results = [];

      const runOne = (tw, algo, pal, tone) => {
        bench.loadPalette(pal);
        bench.state.ditherAlgo = algo;
        bench.state.targetWidth = tw;
        bench.state.toneX = tone.x;
        bench.state.toneY = tone.y;

        const prepPerFrame = () => {
          if (mode === 'camera-like') {
            // Force the expensive path: scale+getImageData + toneStats recompute.
            if (typeof bench.forceRescale === 'function') bench.forceRescale();
            if (typeof bench.clearToneStatsCache === 'function') bench.clearToneStatsCache();
          }
        };

        for (let i = 0; i < cfg.warmup; i++) {
          prepPerFrame();
          bench.processImage();
        }

        const samples = [];
        for (let i = 0; i < cfg.frames; i++) {
          prepPerFrame();
          const t0 = performance.now();
          bench.processImage();
          const t1 = performance.now();
          samples.push(t1 - t0);
        }
        const sum = summarize(samples);
        const outW = bench.proc && bench.proc.work && bench.proc.work.w ? bench.proc.work.w : tw;
        const outH = bench.proc && bench.proc.work && bench.proc.work.h ? bench.proc.work.h : 0;
        results.push({
          mode,
          src: cfg.srcW + 'x' + cfg.srcH,
          out: outW + 'x' + outH,
          tw,
          algo,
          palette: pal,
          tone: tone.label,
          avgMs: sum.avg,
          p95Ms: sum.p95,
          fps: sum.fps
        });
      };

      for (const tw of cfg.targetWidths) {
        for (const pal of cfg.palettes) {
          for (const algo of cfg.algos) {
            for (const tone of cfg.toneCases) {
              runOne(tw, algo, pal, tone);
            }
          }
        }
      }

      return results;
    })()`;

    const evalResult = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (evalResult && evalResult.exceptionDetails) {
      const details = evalResult.exceptionDetails;
      const desc =
        details.exception && details.exception.description
          ? details.exception.description
          : details.text
            ? details.text
            : "unknown";
      throw new Error(`page evaluate failed: ${desc}`);
    }
    const results = evalResult && evalResult.result ? evalResult.result.value : null;
    if (!Array.isArray(results)) {
      throw new Error("unexpected benchmark result");
    }

    // Print a stable table.
    console.log(
      [
        "mode".padEnd(11),
        "src".padEnd(9),
        "out".padEnd(9),
        "algo".padEnd(14),
        "palette".padEnd(18),
        "tone".padEnd(4),
        "avg_ms".padStart(8),
        "p95_ms".padStart(8),
        "fps".padStart(7)
      ].join("  ")
    );

    for (const r of results) {
      console.log(
        [
          String(r.mode).padEnd(11),
          String(r.src).padEnd(9),
          String(r.out).padEnd(9),
          String(r.algo).padEnd(14),
          String(r.palette).padEnd(18),
          String(r.tone).padEnd(4),
          formatMs(r.avgMs, 8),
          formatMs(r.p95Ms, 8),
          (r.fps ? r.fps.toFixed(1) : "0.0").toString().padStart(7, " ")
        ].join("  ")
      );
    }

    await cdp.close();
  } finally {
    if (!chromeExited) {
      try {
        chrome.kill();
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
