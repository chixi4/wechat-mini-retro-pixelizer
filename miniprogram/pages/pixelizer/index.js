const { getSortedPalettes, PALETTES } = require("../../utils/pixelizer/palettes");
const {
  hexToRgb,
  ensurePaletteFast,
  ditherNearest,
  ditherRandom,
  ditherErrorDiffusion,
  ditherBayer
} = require("../../utils/pixelizer/dither");
const { computeToneStats, applyDynamicToneMapping } = require("../../utils/pixelizer/tone");

function selectRect(page, selector) {
  return new Promise((resolve) => {
    wx.createSelectorQuery()
      .in(page)
      .select(selector)
      .boundingClientRect()
      .exec((res) => resolve(res && res[0] ? res[0] : null));
  });
}

function selectCanvas(page, selector) {
  return new Promise((resolve) => {
    wx.createSelectorQuery()
      .in(page)
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => resolve(res && res[0] ? res[0] : null));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function perfNow() {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}

const GRID_BORDER_PX = 2;
const CANVAS_2D_MAX_DIM = 1365;
const EXPORT_FILE_MAX_DIM = 4096;
const INTERACTION_CAP_CACHE_KEY = "pixelizer_interaction_cap_v2";
const INTERACTION_CAP_MAX_ENTRIES = 40;
const INTERACTION_CAP_DIM_BUCKET = 32;
const INTERACTION_CAP_COOLDOWN_MS = 120;
const INTERACTION_CAP_UNDER_RATIO = 0.9;
const INTERACTION_CAP_STABLE_FRAMES = 2;
const INTERACTION_CAP_GROWTH = 1.08;
const INTERACTION_CAP_RECOVER_RATIO = 0.85;
const INTERACTION_CAP_SLOW_WINDOW_MS = 2000;
const INTERACTION_SLOW_FRAMES = 3;
const CONTENT_CHECK_MAX_EDGE = 1024;
const CONTENT_CHECK_MIN_BYTES = 150 * 1024;
const CONTENT_CHECK_MAX_BYTES = 300 * 1024;
const CONTENT_CHECK_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    try {
      console.warn("webgl shader compile failed", gl.getShaderInfoLog(shader));
    } catch (e) {
      // ignore
    }
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebGLProgram(gl, vertexSource, fragmentSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    try {
      console.warn("webgl program link failed", gl.getProgramInfoLog(program));
    } catch (e) {
      // ignore
    }
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

class GLPreviewRenderer {
  constructor(canvasNode, dpr) {
    this._node = canvasNode;
    this._dpr = typeof dpr === "number" && isFinite(dpr) && dpr > 0 ? dpr : 1;

    this._gl = null;
    this._program = null;
    this._buffer = null;
    this._texture = null;

    this._loc = null;
    this._canvasW = 0;
    this._canvasH = 0;
    this._texW = 0;
    this._texH = 0;
    this._verts = new Float32Array(16);
  }

  init() {
    const node = this._node;
    if (!node || typeof node.getContext !== "function") return false;

    const gl =
      node.getContext("webgl", { alpha: true, antialias: false, preserveDrawingBuffer: false }) ||
      node.getContext("webgl");
    if (!gl) return false;

    const program = createWebGLProgram(
      gl,
      `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `,
      `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_texture;
      void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
      }
    `
    );
    if (!program) return false;

    const aPos = gl.getAttribLocation(program, "a_position");
    const aTex = gl.getAttribLocation(program, "a_texCoord");
    const uTex = gl.getUniformLocation(program, "u_texture");
    if (aPos < 0 || aTex < 0 || !uTex) {
      gl.deleteProgram(program);
      return false;
    }

    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!buffer || !texture) {
      if (buffer) gl.deleteBuffer(buffer);
      if (texture) gl.deleteTexture(texture);
      gl.deleteProgram(program);
      return false;
    }

    this._gl = gl;
    this._program = program;
    this._buffer = buffer;
    this._texture = texture;
    this._loc = { aPos, aTex, uTex };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.clearColor(0, 0, 0, 0);
    return true;
  }

  resize(cssW, cssH) {
    const node = this._node;
    const gl = this._gl;
    if (!node || !gl) return false;
    const safeW = Math.max(1, Math.floor(cssW || 1));
    const safeH = Math.max(1, Math.floor(cssH || 1));
    const dpr = this._dpr || 1;
    const pxW = Math.max(1, Math.round(safeW * dpr));
    const pxH = Math.max(1, Math.round(safeH * dpr));
    if (node.width !== pxW) node.width = pxW;
    if (node.height !== pxH) node.height = pxH;
    if (pxW !== this._canvasW || pxH !== this._canvasH) {
      this._canvasW = pxW;
      this._canvasH = pxH;
      gl.viewport(0, 0, pxW, pxH);
    }
    return true;
  }

  updateTexture(w, h, rgbaData) {
    const gl = this._gl;
    const texture = this._texture;
    if (!gl || !texture) return false;

    const texW = Math.max(1, Math.floor(w || 1));
    const texH = Math.max(1, Math.floor(h || 1));
    if (!rgbaData || rgbaData.length < texW * texH * 4) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

    if (texW !== this._texW || texH !== this._texH) {
      this._texW = texW;
      this._texH = texH;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgbaData);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, rgbaData);
    }

    return true;
  }

  draw() {
    const gl = this._gl;
    const program = this._program;
    const buffer = this._buffer;
    const texture = this._texture;
    const loc = this._loc;
    if (!gl || !program || !buffer || !texture || !loc) return false;
    if (!this._canvasW || !this._canvasH || !this._texW || !this._texH) return false;

    const canvasAspect = this._canvasW / this._canvasH;
    const imgAspect = this._texW / this._texH;
    let sx = 1;
    let sy = 1;
    if (imgAspect > canvasAspect) {
      sy = canvasAspect / imgAspect;
    } else {
      sx = imgAspect / canvasAspect;
    }

    const vertices = this._verts;
    vertices[0] = -sx;
    vertices[1] = -sy;
    vertices[2] = 0;
    vertices[3] = 0;
    vertices[4] = sx;
    vertices[5] = -sy;
    vertices[6] = 1;
    vertices[7] = 0;
    vertices[8] = -sx;
    vertices[9] = sy;
    vertices[10] = 0;
    vertices[11] = 1;
    vertices[12] = sx;
    vertices[13] = sy;
    vertices[14] = 1;
    vertices[15] = 1;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(loc.aTex);
    gl.vertexAttribPointer(loc.aTex, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc.uTex, 0);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  clear() {
    const gl = this._gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    const gl = this._gl;
    if (!gl) return;
    try {
      if (this._texture) gl.deleteTexture(this._texture);
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._program) gl.deleteProgram(this._program);
    } catch (e) {
      // ignore
    }
    this._texture = null;
    this._buffer = null;
    this._program = null;
    this._gl = null;
    this._loc = null;
  }
}

function getGridInnerRect(rect) {
  const safeRect = rect || {};
  const rawW = typeof safeRect.width === "number" ? safeRect.width : 0;
  const rawH = typeof safeRect.height === "number" ? safeRect.height : 0;
  const innerWidth = Math.max(0, rawW - GRID_BORDER_PX * 2);
  const innerHeight = Math.max(0, rawH - GRID_BORDER_PX * 2);
  const innerLeft = (typeof safeRect.left === "number" ? safeRect.left : 0) + GRID_BORDER_PX;
  const innerTop = (typeof safeRect.top === "number" ? safeRect.top : 0) + GRID_BORDER_PX;
  return { innerWidth, innerHeight, innerLeft, innerTop };
}

function isRotate90(orientation) {
  return (
    orientation === "left" ||
    orientation === "right" ||
    orientation === "left-mirrored" ||
    orientation === "right-mirrored"
  );
}

function getOrientedSize(img, info) {
  const rawW = (img && img.width) || (info && info.width) || 0;
  const rawH = (img && img.height) || (info && info.height) || 0;
  if (!rawW || !rawH) return { width: rawW, height: rawH };
  if (isRotate90(info && info.orientation)) {
    return { width: rawH, height: rawW };
  }
  return { width: rawW, height: rawH };
}

function drawImageWithOrientation(ctx, img, orientation, destW, destH) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, destW, destH);

  switch (orientation) {
    case "up":
    case undefined:
    case null:
      ctx.drawImage(img, 0, 0, destW, destH);
      break;
    case "up-mirrored":
      ctx.translate(destW, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, destW, destH);
      break;
    case "down":
      ctx.translate(destW, destH);
      ctx.rotate(Math.PI);
      ctx.drawImage(img, 0, 0, destW, destH);
      break;
    case "down-mirrored":
      ctx.translate(0, destH);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0, destW, destH);
      break;
    case "left":
      ctx.translate(0, destH);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(img, 0, 0, destH, destW);
      break;
    case "right":
      ctx.translate(destW, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0, destH, destW);
      break;
    case "left-mirrored":
      ctx.translate(destW, destH);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, destH, destW);
      break;
    case "right-mirrored":
      ctx.translate(destW, 0);
      ctx.rotate(Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, destH, destW);
      break;
    default:
      ctx.drawImage(img, 0, 0, destW, destH);
      break;
  }

  ctx.restore();
}

function scaleImageDataNearest(srcData, srcW, srcH, scale, destData) {
  const destW = srcW * scale;
  const srcRowStride = srcW * 4;
  const destRowStride = destW * 4;

  for (let y = 0; y < srcH; y += 1) {
    const srcRow = y * srcRowStride;
    const destRowBase = y * scale * destRowStride;
    for (let x = 0; x < srcW; x += 1) {
      const srcIdx = srcRow + x * 4;
      const r = srcData[srcIdx];
      const g = srcData[srcIdx + 1];
      const b = srcData[srcIdx + 2];
      const a = srcData[srcIdx + 3];
      const destX = x * scale * 4;
      for (let sy = 0; sy < scale; sy += 1) {
        let destIdx = destRowBase + sy * destRowStride + destX;
        for (let sx = 0; sx < scale; sx += 1) {
          destData[destIdx] = r;
          destData[destIdx + 1] = g;
          destData[destIdx + 2] = b;
          destData[destIdx + 3] = a;
          destIdx += 4;
        }
      }
    }
  }
}

Page({
  data: {
    themeClass: "theme-light",
    closeIconSrc: "/assets/icons/close-light.svg",
    headerVisible: true,
    hasImage: false,
    inputMode: "image",
    inputSwiperIndex: 0,
    cameraVisible: false,
    cameraState: "idle",
    cameraHint: "向左滑动进入相机模式",
    closeEnabled: false,
    closeShown: false,
    isIPad: false,
    safeTopPx: 0,
    safeBottomPx: 0,
    navPadLeftPx: 20,
    navPadRightPx: 20,

    targetWidth: 128,
    sliderThumbLeftPx: 0,
    sliderDragging: false,

    toneX: 0,
    toneY: 0,

    gridPoints: [],
    gridCursorX: 0,
    gridCursorY: 0,

    ditherAlgo: "atkinson",
    ditherAlgos: [
      { key: "atkinson", label: "Atkinson" },
      { key: "floyd-steinberg", label: "Floyd" },
      { key: "bayer-4x4", label: "Bayer 4x4" },
      { key: "bayer-8x8", label: "Bayer 8x8" },
      { key: "random", label: "随机噪点" },
      { key: "none", label: "无抖动" }
    ],

    paletteKey: "dreamscape8",
    paletteList: [],
    paletteScrollTop: 0,

    canDownload: false,
    fullscreenVisible: false,
    fullscreenActive: false,
    fullscreenClosing: false,
    fullscreenAnimating: false,
    fullscreenSrc: "",
    fullscreenScale: 1,
    fullscreenTranslateX: 0,
    fullscreenTranslateY: 0,
    fullscreenImageLeft: 0,
    fullscreenImageTop: 0,
    fullscreenImageW: 1,
    fullscreenImageH: 1,

    controlsScrollTop: 0,
    controlsPaddingTopPx: 15,
    previewTranslateYPx: 0,
    previewHeightPx: 0,
    layoutAnimEnabled: false,
    controlsShiftPx: 0,
    previewShiftPx: 0,

    mainCanvasCssW: 1,
    mainCanvasCssH: 1,
    useGLPreview: false,
    previewHoldVisible: false
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    this._sys = sys;
    this._dpr = sys.pixelRatio || 1;
    this._isMobile = (sys.windowWidth || 0) <= 768;
    this._isIOS = String(sys.platform || "").toLowerCase() === "ios";
    const model = String(sys.model || "");
    this._isIPad = !!(this._isIOS && model.toLowerCase().includes("ipad"));
    this._useGLPreview = !!this._isIOS;
    const perfSetting = wx.getStorageSync("pixelizer_perf");
    const perfConfig = perfSetting && typeof perfSetting === "object" ? perfSetting : null;
    this._perfEnabled =
      !!perfConfig || perfSetting === true || perfSetting === 1 || perfSetting === "1";
    this._perfLogMinMs =
      perfConfig && typeof perfConfig.minMs === "number" ? perfConfig.minMs : 16;
    this._perfLogEvery =
      perfConfig && typeof perfConfig.sample === "number" ? Math.max(1, perfConfig.sample) : 1;
    this._perfSampleCount = 0;
    this._safeTop = (() => {
      const safeAreaTop = sys && sys.safeArea && typeof sys.safeArea.top === "number" ? sys.safeArea.top : null;
      const statusBarHeight = sys && typeof sys.statusBarHeight === "number" ? sys.statusBarHeight : null;
      const raw = Math.max(0, safeAreaTop != null ? safeAreaTop : statusBarHeight != null ? statusBarHeight : 0);
      return Math.max(0, raw - 9);
    })();
    this._safeBottom = (() => {
      if (!this._isMobile) return 0;
      const minGap = 15;
      const safeInsets =
        sys && sys.safeAreaInsets && typeof sys.safeAreaInsets.bottom === "number" ? sys.safeAreaInsets.bottom : null;
      if (safeInsets != null) return Math.max(minGap, Math.max(0, safeInsets));

      const safeAreaBottom = sys && sys.safeArea && typeof sys.safeArea.bottom === "number" ? sys.safeArea.bottom : null;
      if (safeAreaBottom == null) return minGap;

      const candidates = [];
      if (sys && typeof sys.screenHeight === "number") candidates.push(sys.screenHeight - safeAreaBottom);
      if (sys && typeof sys.windowHeight === "number") candidates.push(sys.windowHeight - safeAreaBottom);

      const nonNeg = candidates.filter((v) => typeof v === "number" && isFinite(v) && v >= 0);
      const raw = nonNeg.length ? Math.min(...nonNeg) : 0;
      return Math.max(minGap, raw);
    })();

    const theme = this._resolveSystemTheme(sys);
    this._theme = theme;

    const paletteList = getSortedPalettes().map((p) => ({
      key: p.key,
      name: p.name,
      count: p.colors.length,
      colors: p.colors
    }));

    this._state = {
      imageToken: 0,
      originalImage: null,
      imageInfo: null,
      paletteKey: "dreamscape8",
      palette: hexToRgb(PALETTES.dreamscape8.colors),
      isSerpentine: true,
      toneX: 0,
      toneY: 0
    };
    ensurePaletteFast(this._state.palette);

    this._proc = {
      scaled: { token: 0, w: 0, h: 0, data: null },
      toneStats: { token: 0, w: 0, h: 0, stats: null },
      work: { w: 0, h: 0, imageData: null }
    };

    this._slider = {
      min: 32,
      max: 640,
      baseMax: 640,
      step: 4,
      dragging: false,
      rect: null,
      frameTimer: null,
      frameTimerType: null,
      pendingX: null,
      frameMs: this._isMobile ? 16 : 24
    };

    this._grid = {
      dragging: false,
      cursorX: 0,
      cursorY: 0,
      rect: null,
      lastWidth: 0,
      lastHeight: 0,
      points: [],
      pointsSynced: false,
      frameTimer: null,
      frameTimerType: null,
      pendingX: null,
      pendingY: null,
      pendingRect: null,
      frameMs: this._isMobile ? 16 : 24
    };

    this._mobile = {
      topEps: 3,
      gestureId: 0,
      touchStartY: null,
      pulledThisGesture: false,
      didScrollSinceLoad: false,
      lastScrollTop: 0,
      currentScrollTop: 0,
      armed: false,
      armedAtGesture: -1,
      activeToken: null
    };

    this._isProcessing = false;
    this._processRunning = false;
    this._processToken = 0;
    this._updatePending = false;
    this._processImmediate = false;
    this._pendingProcessOptions = null;
    this._refineTimer = null;
    this._refineToken = 0;
    this._worker = null;
    this._workerBaseKey = "";
    this._workerRenderJob = null;
    this._lastRenderKey = "";
    this._forceMainThreadToken = null;
    this._lockPreviewHeight = false;
    this._closeHintShown = false;
    this._awaitingPreviewExit = false;
    this._clearCloseHintTimer();
    this._closeHintTimer = null;
    this._imageLoadToken = 0;
    this._fullscreenCloseTimer = null;
    this._fullscreenAnimTimer = null;
    this._fullscreenBase = { scale: 1, x: 0, y: 0 };
    this._fullscreenUser = { scale: 1, x: 0, y: 0 };
    this._fullscreenPreviewRect = null;
    this._layoutAnimTimer = null;
    this._layoutCommitTimer = null;
    this._layoutCommitToken = 0;
    this._layoutOpening = false;
    this._layoutOpeningTargetPaddingTopPx = 0;
    this._layoutOpeningTargetPreviewTranslateYPx = 0;
    this._layoutAnimReadyTimer = null;
    this._layoutAnimAllowed = false;
    this._lastHasImage = false;
    this._previewScale = 1;
    this._previewScaleCap = null;
    this._interactionMode = null;
    this._sliderMaxWidth = null;
    this._sliderPerf = null;
    this._interactionCapWidth = null;
    this._interactionCapKey = "";
    this._interactionCapRequestedWidth = 0;
    this._interactionCapRequestedHeight = 0;
    this._interactionCapPerf = null;
    this._interactionCapLastUpdate = 0;
    this._interactionCapCache = Object.create(null);
    this._interactionCapCacheOrder = [];
    // Allow deeper downscaling for slow devices (iPad etc.)
    // Absolute minimum is enforced in _getInteractiveTargetWidth
    this._previewScaleMin = 0.1;
    this._previewScaleMax = 1;
    this._previewScaleLastUpdate = 0;
    this._previewScaleOverCount = 0;
    // Shorter cooldown for faster reaction
    this._previewScaleCooldownMs = 60;
    // Target 30fps (33ms) for smooth interaction
    this._previewTargetMsBase = 33;
    this._previewTargetMs = this._previewTargetMsBase;
    this._lastRenderMs = 0;
    this._lastInteractiveRenderMs = 0;
    this._lastInteractiveRenderAt = 0;
    this._interactionCapPeakWidth = 0;
    this._interactionCapStableCount = 0;
    this._downloadInProgress = false;
    this._contentCheckStatus = "idle";
    this._contentCheckToken = 0;
    this._contentCheckPromise = null;
    this._contentCheckSource = "";
    this._contentCheckError = "";
    this._paletteScrollInitialized = false;

    this._inputMode = "image";
    this._inputMemory = {
      image: null
    };

    this._camera = {
      token: 0,
      ctx: null,
      listener: null,
      lastFrameAt: 0,
      frameImageData: null,
      running: false
    };
    this._cameraFrameIntervalMs = 100;
    this._suppressInputSwiperChange = false;

    const safeTopPx = this._safeTop;
    const safeBottomPx = this._safeBottom;
    const previewHeightPx = this._isMobile ? Math.floor((sys.windowHeight || 0) * 0.4) : 0;
    const controlsPaddingTopPx = this._isMobile ? 15 + safeTopPx : 0;
    const navPad = this._calcNavPadding(sys);
    this.setData({
      themeClass: theme === "dark" ? "theme-dark" : "theme-light",
      closeIconSrc: theme === "dark" ? "/assets/icons/close-dark.svg" : "/assets/icons/close-light.svg",
      paletteList,
      safeTopPx,
      safeBottomPx,
      isIPad: this._isIPad,
      navPadLeftPx: navPad.left,
      navPadRightPx: navPad.right,
      previewHeightPx,
      controlsPaddingTopPx,
      useGLPreview: this._useGLPreview
    });

    if (wx.onThemeChange) {
      this._themeChangeHandler = (res) => {
        const nextTheme = this._resolveSystemTheme(res);
        this._applyTheme(nextTheme);
      };
      wx.onThemeChange(this._themeChangeHandler);
    }

    this._loadInteractionCapCache();
    this._initWorker();
  },

  async onReady() {
    await this._refreshRects();
    this._updateSliderUI();
    this._syncToneCursorToRect();
    this._updateLayout();
    await this._ensureCanvases();
    await this._centerPaletteInView();

    if (this._layoutAnimReadyTimer) clearTimeout(this._layoutAnimReadyTimer);
    this._layoutAnimReadyTimer = setTimeout(() => {
      this._layoutAnimReadyTimer = null;
      this._layoutAnimAllowed = true;
      this.setData({ layoutAnimEnabled: true });
    }, 120);

    if (wx.onWindowResize) {
      this._windowResizeHandler = async (res) => {
        const size = res && res.size ? res.size : res || {};
        const nextSys = { ...this._sys, ...size };
        this._sys = nextSys;
        const navPad = this._calcNavPadding(nextSys);
        this.setData({ navPadLeftPx: navPad.left, navPadRightPx: navPad.right });
        await sleep(50);
        await this._refreshRects();
        this._updateSliderUI();
        this._syncToneCursorToRect();

        if (this._isMobile && this.data.hasImage && this._state && this._state.originalImage) {
          const info = this._state.imageInfo || {};
          const oriented = getOrientedSize(this._state.originalImage, info);
          const aspect = oriented.width > 0 ? oriented.height / oriented.width : 1;
          const box = this._computeMobilePreviewBox(aspect);
          this._lockPreviewHeight = true;
          this.setData({ previewHeightPx: box.previewHeightPx }, () => this._updateLayout());
        } else {
          this._updateLayout();
        }

        await this._ensureCanvases();
        this._scheduleProcess();
      };
      wx.onWindowResize(this._windowResizeHandler);
    }
  },

  async _ensureCanvases() {
    if (this._canvas) return true;

    const needsGL = !!this.data.useGLPreview;
    const requests = [
      selectCanvas(this, "#mainCanvas"),
      selectCanvas(this, "#workCanvas"),
      selectCanvas(this, "#bufferCanvas"),
      selectCanvas(this, "#exportCanvas"),
      selectCanvas(this, "#cameraCanvas")
    ];
    if (needsGL) {
      requests.unshift(selectCanvas(this, "#mainGLCanvas"));
    }

    const res = await Promise.all(requests);
    const glCanvas = needsGL ? res[0] : null;
    const [main, work, buffer, exportC, cameraC] = needsGL ? res.slice(1) : res;

    if (!main || !work || !buffer || !exportC || !cameraC) return false;

    this._canvas = {
      main: { node: main.node, ctx: main.node.getContext("2d") },
      work: { node: work.node, ctx: work.node.getContext("2d") },
      buffer: { node: buffer.node, ctx: buffer.node.getContext("2d") },
      export: { node: exportC.node, ctx: exportC.node.getContext("2d") },
      camera: { node: cameraC.node, ctx: cameraC.node.getContext("2d") }
    };

    this._glPreview = null;
    if (needsGL && glCanvas && glCanvas.node) {
      const renderer = new GLPreviewRenderer(glCanvas.node, this._dpr || 1);
      if (renderer.init()) {
        this._glPreview = renderer;
      } else {
        console.warn("webgl preview init failed; fallback to 2d canvas preview");
        this._useGLPreview = false;
        this.setData({ useGLPreview: false });
      }
    }

    return true;
  },

  _initWorker() {
    if (this._worker) return true;
    if (!wx.createWorker) return false;

    try {
      const worker = wx.createWorker("workers/pixelizer/index.js");
      worker.onMessage((res) => this._onWorkerMessage(res));
      this._worker = worker;
      this._workerBaseKey = "";
      this._workerRenderJob = null;
      return true;
    } catch (e) {
      this._worker = null;
      this._workerBaseKey = "";
      this._workerRenderJob = null;
      return false;
    }
  },

  _disposeWorker() {
    if (!this._worker) return;
    try {
      this._worker.terminate();
    } catch (e) {
      // ignore
    }
    this._worker = null;
    this._workerBaseKey = "";

    if (this._workerRenderJob && typeof this._workerRenderJob.resolve === "function") {
      if (this._workerRenderJob.timer) {
        clearTimeout(this._workerRenderJob.timer);
      }
      try {
        this._workerRenderJob.resolve(null);
      } catch (e) {
        // ignore
      }
    }
    this._workerRenderJob = null;
  },

  _onWorkerMessage(res) {
    const data = res || {};
    if (data.type === "rendered") {
      const job = this._workerRenderJob;
      if (!job || data.token !== job.token) return;
      if (job.timer) clearTimeout(job.timer);
      this._workerRenderJob = null;
      job.resolve(data);
      return;
    }

    if (data.type === "workerLog") {
      const level = data.level || "info";
      const message = data.message || "";
      const detail = data.detail;
      if (typeof detail === "undefined") {
        console.log("[worker]", level, message);
      } else {
        console.log("[worker]", level, message, detail);
      }
      return;
    }

    if (data.type === "baseSet") {
      // no-op, mainly for debugging/health checks
      return;
    }
  },

  _postWorkerMessage(payload) {
    if (!this._worker) return false;
    try {
      const transfer = payload && payload.buffer instanceof ArrayBuffer ? [payload.buffer] : null;
      if (transfer && transfer.length) {
        this._worker.postMessage(payload, transfer);
      } else {
        this._worker.postMessage(payload);
      }
      return true;
    } catch (e) {
      this._disposeWorker();
      return false;
    }
  },

  _renderInWorker(processToken, payload) {
    if (!this._worker) return Promise.resolve(null);

    if (this._workerRenderJob) {
      // Only 1 render in-flight; coalesce by letting the current one finish.
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const timeoutMs = 8000;
      const timer = setTimeout(() => {
        const job = this._workerRenderJob;
        if (!job || job.token !== processToken) return;
        this._workerRenderJob = null;
        resolve(null);
        this._disposeWorker();
      }, timeoutMs);

      this._workerRenderJob = { token: processToken, resolve, timer };
      const ok = this._postWorkerMessage({ ...payload, type: "render", token: processToken });
      if (!ok) {
        clearTimeout(timer);
        this._workerRenderJob = null;
        resolve(null);
      }
    });
  },

  _getFullscreenTargetRect() {
    const sys = this._sys || {};
    const vw = typeof sys.windowWidth === "number" ? sys.windowWidth : 0;
    const vh = typeof sys.windowHeight === "number" ? sys.windowHeight : 0;

    const fallbackW = this._proc && this._proc.work && this._proc.work.w ? this._proc.work.w : 0;
    const fallbackH = this._proc && this._proc.work && this._proc.work.h ? this._proc.work.h : 0;

    if (!vw || !vh) {
      const width = fallbackW || 1;
      const height = fallbackH || 1;
      return { left: 0, top: 0, width, height };
    }

    const imgW =
      fallbackW ||
      (this._canvas && this._canvas.main && this._canvas.main.node ? this._canvas.main.node.width : 0);
    const imgH =
      fallbackH ||
      (this._canvas && this._canvas.main && this._canvas.main.node ? this._canvas.main.node.height : 0);

    if (!imgW || !imgH) return { left: 0, top: 0, width: vw, height: vh };

    const imgAspect = imgW / imgH;
    const viewAspect = vw / vh;
    let width;
    let height;
    if (imgAspect > viewAspect) {
      width = vw;
      height = vw / imgAspect;
    } else {
      height = vh;
      width = vh * imgAspect;
    }

    const left = (vw - width) / 2;
    const top = (vh - height) / 2;
    return { left, top, width, height };
  },

  _computeFullscreenInvertTransform(fromRect, targetRect) {
    const safeW = Math.max(1, targetRect.width || 1);
    const safeH = Math.max(1, targetRect.height || 1);
    const fromW = Math.max(1, (fromRect && fromRect.width) || 1);
    const fromH = Math.max(1, (fromRect && fromRect.height) || 1);
    const scaleX = fromW / safeW;
    const scaleY = fromH / safeH;
    let scale = scaleX;
    if (!isFinite(scale) || scale <= 0) scale = scaleY;
    if (!isFinite(scale) || scale <= 0) scale = 1;

    const translateX = ((fromRect && fromRect.left) || 0) - (targetRect.left || 0);
    const translateY = ((fromRect && fromRect.top) || 0) - (targetRect.top || 0);
    return { scale, translateX, translateY };
  },

  _getFullscreenTransformData() {
    const base = this._fullscreenBase || { scale: 1, x: 0, y: 0 };
    const user = this._fullscreenUser || { scale: 1, x: 0, y: 0 };
    const baseScale = isFinite(base.scale) && base.scale > 0 ? base.scale : 1;
    const userScale = isFinite(user.scale) && user.scale > 0 ? user.scale : 1;
    return {
      fullscreenScale: baseScale * userScale,
      fullscreenTranslateX: (base.x || 0) + (user.x || 0),
      fullscreenTranslateY: (base.y || 0) + (user.y || 0)
    };
  },

  _applyFullscreenTransform() {
    this.setData(this._getFullscreenTransformData());
  },

  _refreshPreviewSurface() {
    if (!this._canvas || !this._proc || !this._proc.work || !this._proc.work.imageData) return;
    const work = this._proc.work;
    const workW = work.w || 0;
    const workH = work.h || 0;
    if (!workW || !workH) return;

    if (this.data.useGLPreview && this._glPreview) {
      const cssW = this.data.mainCanvasCssW || 1;
      const cssH = this.data.mainCanvasCssH || 1;
      this._glPreview.resize(cssW, cssH);
      this._glPreview.updateTexture(workW, workH, work.imageData.data);
      this._glPreview.draw();
      return;
    }

    const mainW = Math.max(1, workW);
    const mainH = Math.max(1, workH);
    const mainNode = this._canvas.main.node;
    if (mainNode.width !== mainW) mainNode.width = mainW;
    if (mainNode.height !== mainH) mainNode.height = mainH;
    const mainCtx = this._canvas.main.ctx;
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.imageSmoothingEnabled = false;
    if (typeof mainCtx.imageSmoothingQuality === "string") {
      mainCtx.imageSmoothingQuality = "low";
    }
    mainCtx.clearRect(0, 0, mainW, mainH);
    mainCtx.drawImage(this._canvas.work.node, 0, 0, mainW, mainH);
  },

  _logPerf(perf) {
    if (!this._perfEnabled || !perf) return;
    this._perfSampleCount = (this._perfSampleCount || 0) + 1;
    const every = Math.max(1, this._perfLogEvery || 1);
    if (this._perfSampleCount % every !== 0) return;
    if (typeof this._perfLogMinMs === "number" && perf.total < this._perfLogMinMs) return;
    try {
      console.log("[perf] pixelizer " + JSON.stringify(perf));
    } catch (err) {
      console.log("[perf] pixelizer [unserializable]", err);
    }
  },

  onShow() {
    this._syncSystemTheme();
    if (!this._awaitingPreviewExit) return;
    this._awaitingPreviewExit = false;
    this._showCloseHint();
  },

  onUnload() {
    if (this._themeChangeHandler && wx.offThemeChange) {
      wx.offThemeChange(this._themeChangeHandler);
    }
    if (this._windowResizeHandler && wx.offWindowResize) {
      wx.offWindowResize(this._windowResizeHandler);
    }
    this._stopCameraFrames();
    if (this._interactionMode === "tone") {
      this._commitInteractionCapCache();
    }
    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
      this._fullscreenCloseTimer = null;
    }
    if (this._fullscreenAnimTimer) {
      clearTimeout(this._fullscreenAnimTimer);
      this._fullscreenAnimTimer = null;
    }
    if (this._layoutAnimTimer) {
      clearTimeout(this._layoutAnimTimer);
      this._layoutAnimTimer = null;
    }
    if (this._layoutCommitTimer) {
      clearTimeout(this._layoutCommitTimer);
      this._layoutCommitTimer = null;
    }
    if (this._layoutAnimReadyTimer) {
      clearTimeout(this._layoutAnimReadyTimer);
      this._layoutAnimReadyTimer = null;
    }
    this._disposeWorker();
    if (this._glPreview) {
      this._glPreview.dispose();
      this._glPreview = null;
    }
  },

  _resolveSystemTheme(sysLike) {
    if (sysLike && typeof sysLike.theme === "string") {
      return sysLike.theme === "dark" ? "dark" : "light";
    }
    let raw = null;
    try {
      raw = wx.getSystemInfoSync().theme;
    } catch (e) {
      raw = null;
    }
    if (typeof raw !== "string") raw = this._sys && this._sys.theme;
    return raw === "dark" ? "dark" : "light";
  },

  _calcNavPadding(sysLike) {
    const baseLeft = 16;
    const baseRight = 20;
    const sys = sysLike || {};
    const winW = typeof sys.windowWidth === "number" ? sys.windowWidth : 0;
    let rightPad = baseRight;
    if (winW && wx.getMenuButtonBoundingClientRect) {
      let rect = null;
      try {
        rect = wx.getMenuButtonBoundingClientRect();
      } catch (e) {
        rect = null;
      }
      if (rect && typeof rect.left === "number" && rect.left > 0 && rect.left < winW) {
        const rightInset = Math.max(0, Math.floor(winW - rect.left));
        rightPad = Math.max(baseRight, rightInset);
      }
    }
    return { left: baseLeft, right: rightPad };
  },

  _applyTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    if (next === this._theme) return;
    this._theme = next;
    this.setData({
      themeClass: next === "dark" ? "theme-dark" : "theme-light",
      closeIconSrc: next === "dark" ? "/assets/icons/close-dark.svg" : "/assets/icons/close-light.svg"
    });
  },

  _syncSystemTheme(sysLike) {
    this._applyTheme(this._resolveSystemTheme(sysLike));
  },

  _initGridPoints(w, h) {
    const step = 20;
    const safeW = Math.max(1, Math.floor(w));
    const safeH = Math.max(1, Math.floor(h));

    let cols = Math.ceil(safeW / step);
    if (cols % 2 === 0) cols += 1;

    let rows = Math.ceil(safeH / step);
    if (rows % 2 === 0) rows += 1;

    const totalW = (cols - 1) * step;
    const totalH = (rows - 1) * step;
    const offsetX = (safeW - totalW) / 2;
    const offsetY = (safeH - totalH) / 2;

    const points = [];
    let id = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        points.push({ id, x: offsetX + x * step, y: offsetY + y * step });
        id += 1;
      }
    }

    this._grid.points = points;
    this._grid.pointsSynced = false;
  },

  _syncGridData(options) {
    const update = {
      gridCursorX: this._grid.cursorX,
      gridCursorY: this._grid.cursorY
    };
    const needsPoints = options && options.pointsChanged;
    if (needsPoints) {
      update.gridPoints = this._grid.points;
      this._grid.pointsSynced = true;
    }
    this.setData(update);
  },

  _queueGridUpdate(clientX, clientY, rect) {
    this._grid.pendingX = clientX;
    this._grid.pendingY = clientY;
    this._grid.pendingRect = rect || this._grid.rect;

    if (this._grid.frameTimer) return;

    const delay = this._grid.frameMs || 16;
    if (typeof requestAnimationFrame === "function") {
      this._grid.frameTimerType = "raf";
      this._grid.frameTimer = requestAnimationFrame(() => {
        this._grid.frameTimer = null;
        this._grid.frameTimerType = null;
        const x = this._grid.pendingX;
        const y = this._grid.pendingY;
        const r = this._grid.pendingRect;
        this._grid.pendingX = null;
        this._grid.pendingY = null;
        this._grid.pendingRect = null;

        if (typeof x === "number" && typeof y === "number") {
          this._updateCursorFromClient(x, y, r);
        }
      });
    } else {
      this._grid.frameTimerType = "timeout";
      this._grid.frameTimer = setTimeout(() => {
        this._grid.frameTimer = null;
        this._grid.frameTimerType = null;
        const x = this._grid.pendingX;
        const y = this._grid.pendingY;
        const r = this._grid.pendingRect;
        this._grid.pendingX = null;
        this._grid.pendingY = null;
        this._grid.pendingRect = null;

        if (typeof x === "number" && typeof y === "number") {
          this._updateCursorFromClient(x, y, r);
        }
      }, delay);
    }
  },

  _flushGridUpdate() {
    if (!this._grid.frameTimer) return;

    if (this._grid.frameTimerType === "raf" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._grid.frameTimer);
    } else {
      clearTimeout(this._grid.frameTimer);
    }
    this._grid.frameTimer = null;
    this._grid.frameTimerType = null;

    const x = this._grid.pendingX;
    const y = this._grid.pendingY;
    const r = this._grid.pendingRect;
    this._grid.pendingX = null;
    this._grid.pendingY = null;
    this._grid.pendingRect = null;

    if (typeof x === "number" && typeof y === "number") {
      this._updateCursorFromClient(x, y, r);
    }
  },

  async _refreshRects() {
    const [headerRect, sliderRect, xyRect, canvasContainerRect] = await Promise.all([
      selectRect(this, "#headerRef"),
      selectRect(this, "#widthSliderContainer"),
      selectRect(this, "#xyPadContainer"),
      selectRect(this, "#canvasContainer")
    ]);

    this._headerRect = headerRect;
    this._slider.rect = sliderRect;
    this._grid.rect = xyRect;
    this._canvasContainerRect = canvasContainerRect;
  },

  async _centerPaletteInView(force) {
    if (this._paletteScrollInitialized && !force) return;
    const key = this.data.paletteKey;
    if (!key) return;

    await sleep(30);

    const listRect = await selectRect(this, "#paletteList");
    const itemRect = await selectRect(this, `#palette-${key}`);
    if (!listRect || !itemRect) return;

    const listHeight = listRect.height || 0;
    const itemHeight = itemRect.height || 0;
    if (!listHeight || !itemHeight) return;

    const offsetInView = itemRect.top - listRect.top;
    const targetTop = offsetInView - (listHeight - itemHeight) / 2;
    if (!isFinite(targetTop)) return;

    this._paletteScrollInitialized = true;
    this.setData({ paletteScrollTop: Math.max(0, Math.round(targetTop)) });
  },

  _updateLayout() {
    if (!this._isMobile) {
      this.setData({
        previewTranslateYPx: 0,
        controlsPaddingTopPx: 0,
        controlsShiftPx: 0,
        previewShiftPx: 0,
        layoutAnimEnabled: false
      });
      this._updateCloseVisibility();
      this._lastHasImage = !!this.data.hasImage;
      return;
    }

    const wasImage = !!this._lastHasImage;
    const hasImage = !!this.data.hasImage;
    const isImageTransition = hasImage !== wasImage;
    const isOpening = isImageTransition && hasImage;

    const headerHeightPx = this._headerRect ? this._headerRect.height || 0 : 0;
    const safeTopPx = this._safeTop || 0;

    let controlsPaddingTopPx = safeTopPx;
    let previewTranslateYPx = 0;

    if (this.data.hasImage) {
      const previewHeightPx =
        typeof this.data.previewHeightPx === "number" && this.data.previewHeightPx > 0
          ? this.data.previewHeightPx
          : Math.floor((this._sys.windowHeight || 0) * 0.4);

      const headerOffset = this.data.headerVisible ? headerHeightPx : 0;
      previewTranslateYPx = headerOffset;
      controlsPaddingTopPx = safeTopPx + previewHeightPx + headerOffset;
    } else {
      if (this.data.headerVisible) controlsPaddingTopPx = safeTopPx + headerHeightPx;
    }

    // If we are in the middle of the "open preview" transition, ignore redundant layout recalcs
    // until we commit the final padding (otherwise we'll start a competing FLIP animation).
    if (
      this._layoutOpening &&
      hasImage &&
      !isImageTransition &&
      controlsPaddingTopPx === this._layoutOpeningTargetPaddingTopPx &&
      previewTranslateYPx === this._layoutOpeningTargetPreviewTranslateYPx
    ) {
      this._updateCloseVisibility();
      this._lastHasImage = hasImage;
      return;
    }

    const prevControlsPadding =
      typeof this.data.controlsPaddingTopPx === "number" ? this.data.controlsPaddingTopPx : 0;
    const prevPreviewShift =
      typeof this.data.previewTranslateYPx === "number" ? this.data.previewTranslateYPx : 0;

    const needsUpdate = controlsPaddingTopPx !== prevControlsPadding || previewTranslateYPx !== prevPreviewShift;

    if (needsUpdate) {
      const deltaControls = prevControlsPadding - controlsPaddingTopPx;
      let deltaPreview = prevPreviewShift - previewTranslateYPx;
      if (isImageTransition) deltaPreview = deltaControls;
      const shouldAnimate = this._layoutAnimAllowed && (deltaControls !== 0 || deltaPreview !== 0);

      const scheduleRefresh = () => {
        const delayMs = this._isMobile && this.data.hasImage ? 360 : 0;
        if (this._layoutRefreshTimer) clearTimeout(this._layoutRefreshTimer);
        this._layoutRefreshTimer = setTimeout(async () => {
          await this._refreshRects();
          this._syncToneCursorToRect();
        }, delayMs);
      };

      if (this._layoutAnimTimer) {
        clearTimeout(this._layoutAnimTimer);
        this._layoutAnimTimer = null;
      }
      if (this._layoutCommitTimer) {
        clearTimeout(this._layoutCommitTimer);
        this._layoutCommitTimer = null;
      }
      this._layoutCommitToken = (this._layoutCommitToken || 0) + 1;
      this._layoutOpening = false;

      // Opening the mobile preview uses a different sequencing:
      // keep the old padding during the roll-down so we don't expose a big blank area.
      if (isOpening && this._layoutAnimAllowed && controlsPaddingTopPx !== prevControlsPadding) {
        const fromPadding = prevControlsPadding;
        const toPadding = controlsPaddingTopPx;
        const pushDelta = toPadding - fromPadding;
        const startPreviewShift = fromPadding - toPadding; // negative => preview starts "rolled up"
        const animMs = 350; // match WXSS transition duration

        const start = () => {
          this._layoutOpening = true;
          this._layoutOpeningTargetPaddingTopPx = toPadding;
          this._layoutOpeningTargetPreviewTranslateYPx = previewTranslateYPx;

          scheduleRefresh();
          if (!this._layoutAnimAllowed) {
            this._layoutOpening = false;
            this.setData({
              controlsPaddingTopPx: toPadding,
              previewTranslateYPx,
              controlsShiftPx: 0,
              previewShiftPx: 0,
              layoutAnimEnabled: false
            });
            return;
          }

          this.setData(
            {
              // Keep old padding while animating transforms.
              controlsPaddingTopPx: fromPadding,
              previewTranslateYPx,
              controlsShiftPx: 0,
              previewShiftPx: startPreviewShift,
              layoutAnimEnabled: false
            },
            () => {
              this._layoutAnimTimer = setTimeout(() => {
                this._layoutAnimTimer = null;
                if (!this._layoutAnimAllowed) {
                  this._layoutOpening = false;
                  this.setData({ controlsShiftPx: 0, previewShiftPx: 0 });
                  return;
                }

                // Animate: preview rolls down, controls content gets pushed down.
                this.setData({ controlsShiftPx: pushDelta, previewShiftPx: 0, layoutAnimEnabled: true });

                // Commit layout after the animation ends (no transition), then re-enable transitions.
                const commitToken = (this._layoutCommitToken = (this._layoutCommitToken || 0) + 1);
                if (this._layoutCommitTimer) clearTimeout(this._layoutCommitTimer);
                this._layoutCommitTimer = setTimeout(() => {
                  if (commitToken !== this._layoutCommitToken) return;
                  this._layoutCommitTimer = null;
                  this.setData(
                    {
                      controlsPaddingTopPx: toPadding,
                      previewTranslateYPx,
                      controlsShiftPx: 0,
                      previewShiftPx: 0,
                      layoutAnimEnabled: false
                    },
                    () => {
                      this._layoutOpening = false;
                      if (!this._layoutAnimAllowed) return;
                      setTimeout(() => this.setData({ layoutAnimEnabled: true }), 16);
                    }
                  );
                }, animMs + 20);
              }, 16);
            }
          );
        };

        start();
      } else if (shouldAnimate) {
        this.setData(
          {
            controlsPaddingTopPx,
            previewTranslateYPx,
            controlsShiftPx: deltaControls,
            previewShiftPx: deltaPreview,
            layoutAnimEnabled: false
          },
          () => {
            scheduleRefresh();
            this._layoutAnimTimer = setTimeout(() => {
              this._layoutAnimTimer = null;
              if (!this._layoutAnimAllowed) {
                this.setData({ controlsShiftPx: 0, previewShiftPx: 0 });
                return;
              }
              this.setData({ controlsShiftPx: 0, previewShiftPx: 0, layoutAnimEnabled: true });
            }, 16);
          }
        );
      } else {
        const next = {
          controlsPaddingTopPx,
          previewTranslateYPx,
          controlsShiftPx: 0,
          previewShiftPx: 0
        };
        const nextAnimEnabled = !!this._layoutAnimAllowed;
        if (nextAnimEnabled !== this.data.layoutAnimEnabled) next.layoutAnimEnabled = nextAnimEnabled;
        this.setData(next, scheduleRefresh);
      }
    }
    this._updateCloseVisibility();
    this._lastHasImage = hasImage;
  },

  _updateCloseVisibility() {
    const enabled = !!this.data.hasImage;
    const pagedLayout = this._isPagedLayout();
    const shown = enabled && (pagedLayout || this._closeHintShown);

    const next = {};
    if (enabled !== this.data.closeEnabled) next.closeEnabled = enabled;
    if (shown !== this.data.closeShown) next.closeShown = shown;
    if (Object.keys(next).length) this.setData(next);
  },


  _clearCloseHintTimer() {
    if (!this._closeHintTimer) return;
    clearTimeout(this._closeHintTimer);
    this._closeHintTimer = null;
  },

  _showCloseHint() {
    if (!this.data.hasImage) return;
    this._closeHintShown = true;
    this._updateCloseVisibility();

    if (this._isPagedLayout()) return;

    this._clearCloseHintTimer();
    this._closeHintTimer = setTimeout(() => {
      this._closeHintTimer = null;
      this._closeHintShown = false;
      this._updateCloseVisibility();
    }, 2000);
  },

  _isPagedLayout() {
    const width = this._sys && typeof this._sys.windowWidth === "number" ? this._sys.windowWidth : 0;
    if (!width) return !this._isMobile;
    return !!this._isIPad || width >= 768;
  },

  _syncToneCursorToRect() {
    const rect = this._grid.rect;
    if (!rect) return;

    const { innerWidth, innerHeight } = getGridInnerRect(rect);
    if (innerWidth <= 0 || innerHeight <= 0) return;

    const oldW = this._grid.lastWidth || innerWidth;
    const oldH = this._grid.lastHeight || innerHeight;
    const sizeChanged = oldW !== innerWidth || oldH !== innerHeight;

    if (this._grid.cursorX === 0 && this._grid.cursorY === 0) {
      this._grid.cursorX = innerWidth / 2;
      this._grid.cursorY = innerHeight / 2;
    } else if (oldW > 0 && oldH > 0 && sizeChanged) {
      this._grid.cursorX = (this._grid.cursorX / oldW) * innerWidth;
      this._grid.cursorY = (this._grid.cursorY / oldH) * innerHeight;
    }

    this._grid.lastWidth = innerWidth;
    this._grid.lastHeight = innerHeight;

    this._grid.cursorX = Math.max(0, Math.min(innerWidth, this._grid.cursorX));
    this._grid.cursorY = Math.max(0, Math.min(innerHeight, this._grid.cursorY));

    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._initGridPoints(innerWidth, innerHeight);
    }

    const needsPointsSync = pointsChanged || !this._grid.pointsSynced;
    this._syncGridData({ pointsChanged: needsPointsSync });
  },

  _updateSliderUI() {
    const rect = this._slider.rect;
    if (!rect) return;

    const { min, max } = this._slider;
    const percent = (this.data.targetWidth - min) / (max - min);
    const availW = rect.width || 0;
    const leftPos = percent * availW;
    const clampedPos = Math.max(0, Math.min(availW, leftPos));
    this.setData({ sliderThumbLeftPx: clampedPos });
  },

  _queueSliderUpdate(clientX) {
    this._slider.pendingX = clientX;
    if (this._slider.frameTimer) return;

    const delay = this._slider.frameMs || 16;
    if (typeof requestAnimationFrame === "function") {
      this._slider.frameTimerType = "raf";
      this._slider.frameTimer = requestAnimationFrame(() => {
        this._slider.frameTimer = null;
        this._slider.frameTimerType = null;
        const x = this._slider.pendingX;
        this._slider.pendingX = null;
        if (typeof x === "number") this._updateValueFromClientX(x);
      });
    } else {
      this._slider.frameTimerType = "timeout";
      this._slider.frameTimer = setTimeout(() => {
        this._slider.frameTimer = null;
        this._slider.frameTimerType = null;
        const x = this._slider.pendingX;
        this._slider.pendingX = null;
        if (typeof x === "number") this._updateValueFromClientX(x);
      }, delay);
    }
  },

  _flushSliderUpdate() {
    if (!this._slider.frameTimer) return;

    if (this._slider.frameTimerType === "raf" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._slider.frameTimer);
    } else {
      clearTimeout(this._slider.frameTimer);
    }
    this._slider.frameTimer = null;
    this._slider.frameTimerType = null;

    const x = this._slider.pendingX;
    this._slider.pendingX = null;
    if (typeof x === "number") this._updateValueFromClientX(x);
  },

  _updateValueFromClientX(clientX) {
    const rect = this._slider.rect;
    if (!rect) return;

    let x = clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));

    const percent = rect.width > 0 ? x / rect.width : 0;
    const { min, max, step } = this._slider;
    let val = min + percent * (max - min);
    val = Math.round(val / step) * step;
    val = Math.max(min, Math.min(max, val));

    if (val !== this.data.targetWidth) {
      const availW = rect.width || 0;
      const valuePercent = (val - min) / (max - min);
      const leftPos = valuePercent * availW;
      const clampedPos = Math.max(0, Math.min(availW, leftPos));
      this.setData({ targetWidth: val, sliderThumbLeftPx: clampedPos });
      this._scheduleProcess({ immediate: this.data.sliderDragging });
    }
  },

  async _updateCursorFromClient(clientX, clientY, rectOverride) {
    let rect = rectOverride || this._grid.rect;
    if (!rect) {
      rect = await selectRect(this, "#xyPadContainer");
      if (!rect) return;
    }

    const { innerWidth, innerHeight, innerLeft, innerTop } = getGridInnerRect(rect);
    if (innerWidth <= 0 || innerHeight <= 0) return;
    let x = clientX - innerLeft;
    let y = clientY - innerTop;
    x = Math.max(0, Math.min(innerWidth, x));
    y = Math.max(0, Math.min(innerHeight, y));
    this._grid.cursorX = x;
    this._grid.cursorY = y;
    this._grid.rect = rect;

    const sizeChanged = innerWidth !== this._grid.lastWidth || innerHeight !== this._grid.lastHeight;
    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._grid.lastWidth = innerWidth;
      this._grid.lastHeight = innerHeight;
      this._initGridPoints(innerWidth, innerHeight);
    }

    const nx = innerWidth > 0 ? x / innerWidth : 0.5;
    const ny = innerHeight > 0 ? y / innerHeight : 0.5;
    const toneX = nx * 2 - 1;
    const toneY = 1 - ny * 2;

    this._state.toneX = toneX;
    this._state.toneY = toneY;
    const needsPointsSync = pointsChanged || !this._grid.pointsSynced;
    const update = { gridCursorX: x, gridCursorY: y };
    if (needsPointsSync) {
      update.gridPoints = this._grid.points;
      this._grid.pointsSynced = true;
    }
    this.setData(update);

    this._scheduleProcess({ immediate: this._grid.dragging });
  },

  _scheduleProcess(options) {
    if (!this.data.hasImage || !this._state.palette || !this._canvas) return;

    const immediateRequested = !!(options && options.immediate);
    this._pendingProcessOptions = options || null;

    if (this._isProcessing) {
      if (this._processRunning) {
        // Continuous interactions should NEVER abort in-flight renders.
        // Aborting can't cancel worker compute, but it *will* drop frames and
        // make the preview look "stuck" while dragging (Android high-res case).
        if (!this._isInteracting()) {
          this._processToken += 1;
        }
        this._updatePending = true;
      }
      return;
    }

    if (!this._worker) {
      this._initWorker();
    }

    this._processToken += 1;
    const processToken = this._processToken;
    this._isProcessing = true;
    this._processRunning = false;
    this._updatePending = false;

    const finish = () => {
      this._processRunning = false;
      this._isProcessing = false;
      const nextOptions = this._pendingProcessOptions;
      const shouldUpdate = this._updatePending;
      this._updatePending = false;
      if (shouldUpdate) this._scheduleProcess(nextOptions);
    };

    const run = () => {
      const currentOptions = this._pendingProcessOptions || options || null;
      this._pendingProcessOptions = null;
      const onComplete = currentOptions && typeof currentOptions._resolve === "function"
        ? currentOptions._resolve
        : null;
      const immediate = !!(currentOptions && currentOptions.immediate);
      this._processImmediate = immediate;
      this._processRunning = true;
      this._updatePending = false;
      if (!this._worker) {
        this._initWorker();
      }
      let result;
      try {
        result = this._processImage(processToken, currentOptions);
      } catch (e) {
        console.error("processImage error", e);
        finish();
        return;
      }

      if (result && typeof result.then === "function") {
        result.then(() => {
          finish();
          if (onComplete) onComplete();
        }, (err) => {
          console.error("processImage async error", err);
          finish();
          if (onComplete) onComplete();
        });
      } else {
        finish();
        if (onComplete) onComplete();
      }
    };

    const scheduleFrame =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);

    if (immediateRequested) {
      setTimeout(run, 0);
      return;
    }

    scheduleFrame(() => setTimeout(run, 0));
  },

  _scheduleProcessAndWait(options) {
    return new Promise((resolve) => {
      const nextOptions = { ...(options || {}), _resolve: resolve };
      this._scheduleProcess(nextOptions);
    });
  },

  _computeMobilePreviewBox(aspect) {
    const previewPadding = 8; // 同 mobile .preview-area padding
    const previewBorder = 2; // mobile 预览区底边线

    const winW = this._sys && this._sys.windowWidth ? Math.max(1, Math.floor(this._sys.windowWidth)) : 375;
    const winH = this._sys && this._sys.windowHeight ? Math.max(1, Math.floor(this._sys.windowHeight)) : 667;
    const maxPreviewH = Math.max(1, Math.floor(winH * 0.4));

    let availW = Math.max(1, winW - previewPadding * 2);
    let availH = Math.max(1, maxPreviewH - previewPadding * 2 - previewBorder);

    const safeAspect = typeof aspect === "number" && isFinite(aspect) && aspect > 0 ? aspect : 1;

    let displayW = availW;
    let displayH = Math.round(displayW * safeAspect);
    if (displayH > availH) {
      displayH = availH;
      displayW = Math.round(displayH / safeAspect);
    }

    displayW = Math.max(1, Math.floor(displayW));
    displayH = Math.max(1, Math.floor(displayH));

    const previewHeightPx = Math.max(1, displayH + previewPadding * 2 + previewBorder);
    return { displayW, displayH, previewHeightPx };
  },

  _isInteracting() {
    return !!(this.data.sliderDragging || (this._grid && this._grid.dragging));
  },

  _cancelRefine() {
    this._refineToken = (this._refineToken || 0) + 1;
    if (this._refineTimer) {
      clearTimeout(this._refineTimer);
      this._refineTimer = null;
    }
    if (this._processRunning && !this._isInteracting()) {
      this._processToken += 1;
    }
  },

  _scheduleRefine() {
    if (!this.data.hasImage) return;
    this._cancelRefine();

    const token = this._refineToken;
    const delayMs = this._isMobile ? 150 : 100;

    const attempt = () => {
      if (token !== this._refineToken) return;
      if (this._isInteracting()) return;
      if (this._isProcessing) {
        this._refineTimer = setTimeout(attempt, 50);
        return;
      }
      this._refineTimer = null;
      this._scheduleProcess({ immediate: true, fullRes: true });
    };

    this._refineTimer = setTimeout(attempt, delayMs);
  },

  _resetContentCheck() {
    this._contentCheckToken = (this._contentCheckToken || 0) + 1;
    this._contentCheckPromise = null;
    this._contentCheckStatus = "idle";
    this._contentCheckSource = "";
    this._contentCheckError = "";
  },

  _getImageContentType(info, src) {
    const type = String((info && info.type) || "").toLowerCase();
    if (type === "png") return "image/png";
    if (type === "gif") return "image/gif";
    if (type === "webp") return "image/webp";
    if (type === "jpg" || type === "jpeg") return "image/jpeg";
    const lowerSrc = String(src || "").toLowerCase();
    if (lowerSrc.endsWith(".png")) return "image/png";
    if (lowerSrc.endsWith(".gif")) return "image/gif";
    if (lowerSrc.endsWith(".webp")) return "image/webp";
    if (lowerSrc.endsWith(".jpg") || lowerSrc.endsWith(".jpeg")) return "image/jpeg";
    return "image/jpeg";
  },

  _getFileInfoSize(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileInfo({
        filePath,
        success: resolve,
        fail: reject
      });
    }).then((res) => (res && typeof res.size === "number" ? res.size : 0));
  },

  async _createContentCheckFile(src, info, img) {
    if (!img || !this._canvas || !this._canvas.export) return null;
    if (!wx.canvasToTempFilePath) return null;

    const oriented = getOrientedSize(img, info);
    let targetW = oriented.width || 0;
    let targetH = oriented.height || 0;
    if (!targetW || !targetH) return null;

    const longEdge = Math.max(targetW, targetH);
    if (longEdge > CONTENT_CHECK_MAX_EDGE) {
      const scale = CONTENT_CHECK_MAX_EDGE / longEdge;
      targetW = Math.max(1, Math.round(targetW * scale));
      targetH = Math.max(1, Math.round(targetH * scale));
    }

    const exportCanvas = this._canvas.export;
    exportCanvas.node.width = targetW;
    exportCanvas.node.height = targetH;
    const exportCtx = exportCanvas.ctx;
    exportCtx.setTransform(1, 0, 0, 1, 0, 0);
    exportCtx.imageSmoothingEnabled = true;
    if (typeof exportCtx.imageSmoothingQuality === "string") {
      exportCtx.imageSmoothingQuality = "high";
    }
    exportCtx.clearRect(0, 0, targetW, targetH);
    drawImageWithOrientation(exportCtx, img, info && info.orientation, targetW, targetH);

    const targetMid = (CONTENT_CHECK_MIN_BYTES + CONTENT_CHECK_MAX_BYTES) / 2;
    let best = null;

    for (const quality of CONTENT_CHECK_QUALITY_STEPS) {
      let tempPath = "";
      try {
        const temp = await new Promise((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas: exportCanvas.node,
            fileType: "jpg",
            quality,
            success: resolve,
            fail: reject
          });
        });
        tempPath = temp && temp.tempFilePath ? temp.tempFilePath : "";
      } catch (e) {
        tempPath = "";
      }

      if (!tempPath) continue;

      let size = 0;
      try {
        size = await this._getFileInfoSize(tempPath);
      } catch (e) {
        size = 0;
      }

      if (!best || Math.abs(size - targetMid) < Math.abs(best.size - targetMid)) {
        best = { filePath: tempPath, size };
      }

      if (size >= CONTENT_CHECK_MIN_BYTES && size <= CONTENT_CHECK_MAX_BYTES) {
        return { filePath: tempPath, contentType: "image/jpeg", size };
      }
    }

    if (best) return { filePath: best.filePath, contentType: "image/jpeg", size: best.size };
    return null;
  },

  _notifyContentReject() {
    wx.showModal({
      title: "内容不合规",
      content: "图片包含违规内容，已禁止保存。",
      showCancel: false
    });
  },

  _notifyContentCheckError() {
    wx.showToast({ title: "内容安全检测失败", icon: "none" });
  },

  _startContentCheck(src, info, img) {
    if (!img && !src) return null;
    if (!wx.cloud || typeof wx.cloud.uploadFile !== "function") {
      this._contentCheckStatus = "unavailable";
      this._contentCheckError = "cloud unavailable";
      return null;
    }

    const token = (this._contentCheckToken = (this._contentCheckToken || 0) + 1);
    this._contentCheckStatus = "pending";
    this._contentCheckError = "";
    this._contentCheckSource = src || "camera";

    const promise = (async () => {
      try {
        const prepared = await this._createContentCheckFile(src, info, img);
        if (token !== this._contentCheckToken) return "stale";

        const filePath = prepared && prepared.filePath ? prepared.filePath : src;
        if (!filePath) throw new Error("missing filePath");
        const contentType =
          prepared && prepared.contentType ? prepared.contentType : this._getImageContentType(info, src);
        const extRaw = contentType.split("/")[1] || "jpg";
        const ext = extRaw === "jpeg" ? "jpg" : extRaw;
        const rand = Math.random().toString(16).slice(2, 10);
        const cloudPath = `content-check/${Date.now()}_${rand}.${ext}`;

        const upload = await wx.cloud.uploadFile({ cloudPath, filePath });
        if (token !== this._contentCheckToken) return "stale";
        const fileID = upload && upload.fileID ? upload.fileID : "";
        if (!fileID) throw new Error("upload failed");

        const res = await wx.cloud.callFunction({
          name: "contentSecurity",
          data: { action: "image", fileID, contentType }
        });
        const result = res && res.result ? res.result : {};
        const status = result.status || (result.ok ? "pass" : "error");

        if (token !== this._contentCheckToken) return status;
        this._contentCheckStatus = status;
        this._contentCheckError = result.errMsg || "";
        if (status === "reject") this._notifyContentReject();
        return status;
      } catch (err) {
        if (token === this._contentCheckToken) {
          this._contentCheckStatus = "error";
          this._contentCheckError = String(err && err.message ? err.message : err);
        }
        return "error";
      }
    })();

    this._contentCheckPromise = promise;
    return promise;
  },

  async _ensureContentCheckAllowed() {
    const status = this._contentCheckStatus || "idle";
    if (status === "pass") return true;

    if (status === "pending" && this._contentCheckPromise) {
      wx.showToast({ title: "正在内容安全检测", icon: "none" });
      const finalStatus = await this._contentCheckPromise;
      if (finalStatus === "pass") return true;
    }

    if (this._contentCheckStatus === "reject") {
      this._notifyContentReject();
      return false;
    }

    if (this._contentCheckStatus === "unavailable") {
      wx.showToast({ title: "内容安全未启用", icon: "none" });
      return false;
    }

    this._notifyContentCheckError();
    return false;
  },

  _getInteractiveTargetWidth(baseWidth, isInteracting) {
    if (!isInteracting) return baseWidth;
    const safeBase = Math.max(1, baseWidth || 1);
    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const minWidth = this._slider && this._slider.min ? this._slider.min : 1;

    // Absolute minimum pixel width for preview (prevents too-tiny previews)
    const ABSOLUTE_MIN_PX = 96;
    const absMinScale = ABSOLUTE_MIN_PX / safeBase;

    // Use configured min scale but respect absolute pixel floor
    const configMin = typeof this._previewScaleMin === "number" ? this._previewScaleMin : 0.1;
    const effectiveMinScale = Math.max(configMin, absMinScale);
    const maxScale = typeof this._previewScaleMax === "number" ? this._previewScaleMax : 1;

    let scale = typeof this._previewScale === "number" ? this._previewScale : 1;
    scale = Math.max(effectiveMinScale, Math.min(maxScale, scale));

    const scaled = Math.round((safeBase * scale) / step) * step;
    return Math.max(minWidth, Math.min(safeBase, scaled));
  },

  _updatePreviewScale(renderMs, baseWidth) {
    if (!renderMs || !isFinite(renderMs)) return;
    const budget = typeof this._previewTargetMs === "number" ? this._previewTargetMs : 33;
    if (!budget || !isFinite(budget)) return;

    const now = perfNow();
    const cooldown = typeof this._previewScaleCooldownMs === "number" ? this._previewScaleCooldownMs : 60;
    const lastUpdate = this._previewScaleLastUpdate || 0;

    // Allow immediate emergency drops even during cooldown
    const isSevereLag = renderMs > budget * 2;
    const isOver = renderMs > budget * 1.05;
    const prevOverCount = typeof this._previewScaleOverCount === "number" ? this._previewScaleOverCount : 0;
    this._previewScaleOverCount = isOver ? prevOverCount + 1 : 0;
    if (!isSevereLag && now - lastUpdate < cooldown) return;

    const current = typeof this._previewScale === "number" ? this._previewScale : 1;
    let next = current;

    const minScale = typeof this._previewScaleMin === "number" ? this._previewScaleMin : 0.1;
    let maxScale = typeof this._previewScaleMax === "number" ? this._previewScaleMax : 1;
    const cap = this._previewScaleCap;
    if (typeof cap === "number" && isFinite(cap) && cap > 0) {
      maxScale = Math.min(maxScale, cap);
    }
    if (maxScale < minScale) maxScale = minScale;

    const recoverRatio = this._interactionMode === "tone" ? INTERACTION_CAP_RECOVER_RATIO : 0.7;

    if (isSevereLag) {
      // Severe lag (>66ms): drop scale aggressively by 40%
      next = current * 0.6;
    } else if (isOver) {
      if (this._previewScaleOverCount < INTERACTION_SLOW_FRAMES) return;
      // Moderate lag: drop proportional to error
      const ratio = Math.sqrt(budget / renderMs);
      next = current * ratio;
    } else if (renderMs < budget * recoverRatio) {
      // Under budget: slowly recover (5% per step)
      next = current * 1.05;
    } else {
      // Within hysteresis zone: do nothing
      return;
    }

    next = Math.max(minScale, Math.min(maxScale, next));

    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const safeBase = Math.max(1, baseWidth || 1);
    const currentWidth = Math.round((safeBase * current) / step) * step;
    const nextWidth = Math.round((safeBase * next) / step) * step;
    if (currentWidth === nextWidth) return;

    this._previewScale = next;
    this._previewScaleLastUpdate = now;
  },

  _updateSliderMaxWidth(renderMs, targetWidth, requestedWidth) {
    if (!renderMs || !isFinite(renderMs)) return;
    if (this._interactionMode !== "slider") return;
    if (!this.data.sliderDragging) return;
    if (!this._sliderMaxWidth || !isFinite(this._sliderMaxWidth)) return;

    const budget = typeof this._previewTargetMs === "number" ? this._previewTargetMs : 100;
    if (!budget || !isFinite(budget)) return;

    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const minWidth = this._slider && this._slider.min ? this._slider.min : 1;
    const ABSOLUTE_MIN_PX = 96;
    const floorWidth = Math.max(minWidth, ABSOLUTE_MIN_PX);
    const safeWidth = this._getInteractionSafeWidth("slider");
    const sliderMax = this._slider && this._slider.max ? this._slider.max : safeWidth;
    const hardCap = Math.max(floorWidth, Math.min(safeWidth, sliderMax));

    let cap = this._sliderMaxWidth;
    if (!cap || !isFinite(cap)) cap = requestedWidth || targetWidth || floorWidth;
    cap = Math.max(floorWidth, Math.round(cap / step) * step);
    cap = Math.min(cap, hardCap);

    const perf = this._sliderPerf || { over: 0, under: 0, severe: 0 };
    const isSevere = renderMs >= budget * 2;
    const isOver = renderMs > budget;
    const isUnder = renderMs < budget * 0.8;

    perf.severe = isSevere ? perf.severe + 1 : 0;
    perf.over = isOver ? perf.over + 1 : 0;
    perf.under = isUnder ? perf.under + 1 : 0;

    let nextCap = cap;
    if (isOver) {
      const base = Math.max(floorWidth, targetWidth || cap);
      let ratio = Math.sqrt(budget / renderMs);
      const minRatio = perf.severe >= 2 ? 0.5 : 0.7;
      if (!isFinite(ratio) || ratio <= 0) ratio = minRatio;
      ratio = Math.max(minRatio, Math.min(1, ratio));
      nextCap = Math.min(cap, base * ratio);
      perf.under = 0;
    } else if (perf.under >= 2 && requestedWidth && requestedWidth > cap) {
      nextCap = Math.min(requestedWidth, cap * 1.05);
    }

    nextCap = Math.max(floorWidth, Math.round(nextCap / step) * step);
    if (nextCap < floorWidth) nextCap = floorWidth;
    nextCap = Math.min(nextCap, hardCap);

    if (nextCap !== cap) {
      this._sliderMaxWidth = nextCap;
    }
    this._sliderPerf = perf;
  },

  async _processImage(processToken, options) {
    const isAborted = () => typeof processToken === "number" && processToken !== this._processToken;
    const img = this._state.originalImage;
    const palette = this._state.palette;
    if (!img || !palette) return;
    const forceFullRes = !!(options && options.fullRes);

    const { ditherAlgo } = this.data;
    const requestedWidth = typeof this.data.targetWidth === "number" ? this.data.targetWidth : 1;
    const toneX = this._state.toneX;
    const toneY = this._state.toneY;

    const info = this._state.imageInfo || {};
    const oriented = getOrientedSize(img, info);
    const aspect = oriented.width > 0 ? oriented.height / oriented.width : 1;
    const isInteracting = this._isInteracting();

    const displayWidth = this.data.mainCanvasCssW || 1;
    const dpr = this._dpr || 2;
    const clampedDpr = Math.min(dpr, 2);
    const previewMaxWidth = displayWidth > 10
      ? Math.max(1, Math.ceil(displayWidth * clampedDpr))
      : requestedWidth;
    let effectiveRequestedWidth = isInteracting
      ? requestedWidth
      : Math.min(requestedWidth, previewMaxWidth);
    if (forceFullRes) {
      effectiveRequestedWidth = requestedWidth;
    }
    const isSliderDrag = !!(this.data.sliderDragging && this._interactionMode === "slider");
    if (isSliderDrag && this._sliderMaxWidth) {
      effectiveRequestedWidth = Math.min(effectiveRequestedWidth, this._sliderMaxWidth);
    }

    const targetWidth = this._getInteractiveTargetWidth(effectiveRequestedWidth, isInteracting);
    const targetHeight = Math.max(1, Math.round(targetWidth * aspect));
    const requestedHeight = Math.max(1, Math.round(requestedWidth * aspect));
    const previewScale = requestedWidth > 0 ? targetWidth / requestedWidth : 1;

    const perfEnabled = !!this._perfEnabled;
    const perf = perfEnabled
      ? {
          start: perfNow(),
          steps: {},
          meta: {
            targetWidth,
            targetHeight,
            requestedWidth,
            requestedHeight,
            previewScale,
            interactive: isInteracting,
            ditherAlgo,
            paletteKey: this.data.paletteKey,
            toneX,
            toneY
          }
        }
      : null;
    const perfMeasure = (label, fn) => {
      if (!perf) return fn();
      const t = perfNow();
      const result = fn();
      perf.steps[label] = +(perfNow() - t).toFixed(2);
      return result;
    };

    const renderKey = `${this._state.imageToken}:${targetWidth}x${targetHeight}:${ditherAlgo}:${this.data.paletteKey}:${toneX.toFixed(4)}:${toneY.toFixed(4)}`;
    if (renderKey === this._lastRenderKey) return;
    const renderStart = perfNow();

    const proc = this._proc;
    const buffer = this._canvas.buffer;

    const expectedLen = targetWidth * targetHeight * 4;
    if (
      proc.scaled.token !== this._state.imageToken ||
      proc.scaled.w !== targetWidth ||
      proc.scaled.h !== targetHeight ||
      !proc.scaled.data ||
      proc.scaled.data.length !== expectedLen
    ) {
      perfMeasure("scale+getImageData", () => {
        buffer.node.width = targetWidth;
        buffer.node.height = targetHeight;
        buffer.ctx.imageSmoothingEnabled = true;
        if (typeof buffer.ctx.imageSmoothingQuality === "string") {
          buffer.ctx.imageSmoothingQuality = isInteracting ? "low" : "high";
        }
        drawImageWithOrientation(buffer.ctx, img, info.orientation, targetWidth, targetHeight);

        const baseImageData = buffer.ctx.getImageData(0, 0, targetWidth, targetHeight);
        proc.scaled = {
          token: this._state.imageToken,
          w: targetWidth,
          h: targetHeight,
          data: baseImageData.data
        };
        proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
      });
    }

    if (isAborted()) return;

    const baseData = proc.scaled.data;

    if (!proc.work.imageData || proc.work.w !== targetWidth || proc.work.h !== targetHeight) {
      perfMeasure("initWorkImageData", () => {
        this._canvas.work.node.width = targetWidth;
        this._canvas.work.node.height = targetHeight;
        const workCtx = this._canvas.work.ctx;
        proc.work.imageData = workCtx.createImageData
          ? workCtx.createImageData(targetWidth, targetHeight)
          : workCtx.getImageData(0, 0, targetWidth, targetHeight);
        proc.work.w = targetWidth;
        proc.work.h = targetHeight;
      });
    }

    const workImageData = proc.work.imageData;
    const forceMainThread = this._forceMainThreadToken === this._state.imageToken;
    const worker = forceMainThread ? null : this._worker;
    const baseKey = `${this._state.imageToken}:${info.orientation || 1}:${targetWidth}x${targetHeight}`;
    if (perf) perf.meta.worker = !!worker;
    let workerFrameReady = false;
    const workerBusy = !!this._workerRenderJob;

    if (worker) {
      if (baseKey !== this._workerBaseKey) {
        let baseCopy;
        if (perf) {
          const copyStart = perfNow();
          baseCopy = new Uint8ClampedArray(baseData);
          perf.steps.workerBaseCopy = +(perfNow() - copyStart).toFixed(2);
        } else {
          baseCopy = new Uint8ClampedArray(baseData);
        }
        const postStart = perf ? perfNow() : 0;
        const ok = this._postWorkerMessage({
          type: "setBase",
          baseKey,
          w: targetWidth,
          h: targetHeight,
          buffer: baseCopy.buffer,
          perf: perfEnabled
        });
        if (perf) {
          perf.steps.workerBasePost = +(perfNow() - postStart).toFixed(2);
        }
        if (ok) {
          this._workerBaseKey = baseKey;
        } else {
          this._workerBaseKey = "";
        }
      }

      const workerRenderStart = perf ? perfNow() : 0;
      const rendered = await this._renderInWorker(processToken, {
        toneX,
        toneY,
        paletteKey: this.data.paletteKey,
        ditherAlgo,
        serpentine: this._state.isSerpentine,
        perf: perfEnabled
      });
      if (perf) {
        perf.steps.workerRender = +(perfNow() - workerRenderStart).toFixed(2);
        if (rendered && rendered.perf) {
          perf.worker = rendered.perf;
        }
      }

      if (isAborted()) return;

      if (!rendered && workerBusy) {
        this._updatePending = true;
        if (!this._pendingProcessOptions) {
          this._pendingProcessOptions = { immediate: true };
        }
        if (perf) {
          perf.meta.workerBusy = true;
          perf.total = +(perfNow() - perf.start).toFixed(2);
          this._logPerf(perf);
        }
        return;
      }

      if (rendered && rendered.ok && rendered.buffer) {
        try {
          if (rendered.w !== targetWidth || rendered.h !== targetHeight) {
            throw new Error(`worker dim mismatch (${rendered.w}x${rendered.h} != ${targetWidth}x${targetHeight})`);
          }
          const expected = targetWidth * targetHeight * 4;
          if (rendered.buffer.byteLength !== expected) {
            throw new Error(`worker buffer size mismatch (${rendered.buffer.byteLength} != ${expected})`);
          }
          if (perf) {
            const applyStart = perfNow();
            workImageData.data.set(new Uint8ClampedArray(rendered.buffer));
            perf.steps.workerApply = +(perfNow() - applyStart).toFixed(2);
          } else {
            workImageData.data.set(new Uint8ClampedArray(rendered.buffer));
          }
          workerFrameReady = true;
        } catch (e) {
          console.warn("worker render apply failed; fallback to main thread", e);
          this._disposeWorker();
        }
      } else if (rendered && rendered.ok === false) {
        console.warn("worker render error; fallback to main thread", rendered.error);
        this._disposeWorker();
      }

      if (isAborted()) return;

      if (workerFrameReady) {
        const container = this._canvasContainerRect;
        const containerW = container && container.width ? Math.max(1, Math.floor(container.width)) : 1000;
        const containerH = container && container.height ? Math.max(1, Math.floor(container.height)) : 600;

        const previewPadding = 8; // 同 mobile .preview-area padding
        const previewBorder = 2; // mobile 预览区底边线

        let availW = Math.max(1, containerW - 44);
        let availH = Math.max(1, containerH - 44);

        if (this._isMobile) {
          const winW =
            this._sys && this._sys.windowWidth ? Math.max(1, Math.floor(this._sys.windowWidth)) : containerW;
          const winH =
            this._sys && this._sys.windowHeight ? Math.max(1, Math.floor(this._sys.windowHeight)) : containerH;
          const maxPreviewH = Math.max(1, Math.floor(winH * 0.4));

          availW = Math.max(1, winW - previewPadding * 2);
          availH = Math.max(1, maxPreviewH - previewPadding * 2 - previewBorder);
        }

        // 预览尺寸只由容器与图片纵横比决定，避免拖动“像素尺寸”时预览大小跳变
        let displayW = availW;
        let displayH = Math.round(displayW * aspect);
        if (displayH > availH) {
          displayH = availH;
          displayW = Math.round(displayH / aspect);
        }
        displayW = Math.max(1, Math.floor(displayW));
        displayH = Math.max(1, Math.floor(displayH));

        const nextData = {};
        if (displayW !== this.data.mainCanvasCssW) nextData.mainCanvasCssW = displayW;
        if (displayH !== this.data.mainCanvasCssH) nextData.mainCanvasCssH = displayH;

        const hasNextData = Object.keys(nextData).length > 0;
        if (hasNextData) {
          const setDataStart = perf ? perfNow() : 0;
          await new Promise((resolve) => this.setData(nextData, resolve));
          if (perf) {
            perf.steps.setDataLayout = +(perfNow() - setDataStart).toFixed(2);
          }
        }

        if (isAborted()) return;

        if (perf) {
          const putStart = perfNow();
          this._canvas.work.ctx.putImageData(workImageData, 0, 0);
          perf.steps.putImageData = +(perfNow() - putStart).toFixed(2);
        } else {
          this._canvas.work.ctx.putImageData(workImageData, 0, 0);
        }

        const presentStart = perf ? perfNow() : 0;
        let presented = false;
        if (this.data.useGLPreview && this._glPreview) {
          presented =
            this._glPreview.resize(displayW, displayH) &&
            this._glPreview.updateTexture(targetWidth, targetHeight, workImageData.data) &&
            this._glPreview.draw();
        }
        if (!presented) {
          // Draw at native pixel size; CSS scaling keeps the preview consistent with fullscreen.
          const mainW = Math.max(1, targetWidth);
          const mainH = Math.max(1, targetHeight);
          const mainNode = this._canvas.main.node;
          if (mainNode.width !== mainW) mainNode.width = mainW;
          if (mainNode.height !== mainH) mainNode.height = mainH;
          const mainCtx = this._canvas.main.ctx;
          mainCtx.setTransform(1, 0, 0, 1, 0, 0);
          mainCtx.imageSmoothingEnabled = false;
          if (typeof mainCtx.imageSmoothingQuality === "string") {
            mainCtx.imageSmoothingQuality = "low";
          }
          mainCtx.clearRect(0, 0, mainW, mainH);
          mainCtx.drawImage(this._canvas.work.node, 0, 0, mainW, mainH);
        }
        if (perf) {
          perf.steps.present = +(perfNow() - presentStart).toFixed(2);
        }

        if (!this.data.canDownload) {
          this.setData({ canDownload: true });
        }

        if (this._forceMainThreadToken === this._state.imageToken) {
          this._forceMainThreadToken = null;
        }

        this._lastRenderKey = renderKey;
        const renderMs = perfNow() - renderStart;
        this._lastRenderMs = renderMs;
        if (perf && perf.meta) {
          perf.meta.renderMs = +renderMs.toFixed(2);
        }
        if (isInteracting) {
          this._lastInteractiveRenderMs = renderMs;
          this._lastInteractiveRenderAt = perfNow();
          if (this._interactionMode === "slider") {
            this._updateSliderMaxWidth(renderMs, targetWidth, requestedWidth);
          } else {
            this._updateInteractionCap(renderMs, targetWidth, requestedWidth);
            this._updatePreviewScale(renderMs, requestedWidth);
          }
        }
        if (perf) {
          perf.meta.worker = true;
          perf.total = +(perfNow() - perf.start).toFixed(2);
          this._logPerf(perf);
        }
        return;
      }
    }

    if (perf && worker) {
      perf.meta.worker = false;
      perf.meta.workerFallback = true;
    }

    if (perf) {
      const baseStart = perfNow();
      workImageData.data.set(baseData);
      perf.steps.baseCopy = +(perfNow() - baseStart).toFixed(2);
    } else {
      workImageData.data.set(baseData);
    }

    if (toneX !== 0 || toneY !== 0) {
      let toneStats = proc.toneStats.stats;
      if (
        !toneStats ||
        proc.toneStats.token !== this._state.imageToken ||
        proc.toneStats.w !== targetWidth ||
        proc.toneStats.h !== targetHeight
      ) {
        const statsStart = perf ? perfNow() : 0;
        toneStats = computeToneStats({ data: baseData, width: targetWidth, height: targetHeight });
        if (perf) {
          perf.steps.toneStats = +(perfNow() - statsStart).toFixed(2);
        }
        proc.toneStats = { token: this._state.imageToken, w: targetWidth, h: targetHeight, stats: toneStats };
      }
      const toneMapStart = perf ? perfNow() : 0;
      applyDynamicToneMapping(workImageData, toneX, toneY, toneStats, isAborted);
      if (perf) {
        perf.steps.toneMap = +(perfNow() - toneMapStart).toFixed(2);
      }
    }

    if (isAborted()) return;

    const ditherStart = perf ? perfNow() : 0;
    switch (ditherAlgo) {
      case "floyd-steinberg":
        ditherErrorDiffusion(workImageData, palette, "floyd", this._state.isSerpentine, isAborted);
        break;
      case "atkinson":
        ditherErrorDiffusion(workImageData, palette, "atkinson", this._state.isSerpentine, isAborted);
        break;
      case "bayer-4x4":
        ditherBayer(workImageData, palette, 4, isAborted);
        break;
      case "bayer-8x8":
        ditherBayer(workImageData, palette, 8, isAborted);
        break;
      case "random":
        ditherRandom(workImageData, palette, isAborted);
        break;
      default:
        ditherNearest(workImageData, palette, isAborted);
        break;
    }
    if (perf) {
      perf.steps.dither = +(perfNow() - ditherStart).toFixed(2);
    }

    if (isAborted()) return;

    const container = this._canvasContainerRect;
    const containerW = container && container.width ? Math.max(1, Math.floor(container.width)) : 1000;
    const containerH = container && container.height ? Math.max(1, Math.floor(container.height)) : 600;

    const previewPadding = 8; // 同 mobile .preview-area padding
    const previewBorder = 2; // mobile 预览区底边线

    let availW = Math.max(1, containerW - 44);
    let availH = Math.max(1, containerH - 44);

    if (this._isMobile) {
      const winW = this._sys && this._sys.windowWidth ? Math.max(1, Math.floor(this._sys.windowWidth)) : containerW;
      const winH = this._sys && this._sys.windowHeight ? Math.max(1, Math.floor(this._sys.windowHeight)) : containerH;
      const maxPreviewH = Math.max(1, Math.floor(winH * 0.4));

      availW = Math.max(1, winW - previewPadding * 2);
      availH = Math.max(1, maxPreviewH - previewPadding * 2 - previewBorder);
    }

    // 预览尺寸只由容器与图片纵横比决定，避免拖动“像素尺寸”时预览大小跳变
    let displayW = availW;
    let displayH = Math.round(displayW * aspect);
    if (displayH > availH) {
      displayH = availH;
      displayW = Math.round(displayH / aspect);
    }
    displayW = Math.max(1, Math.floor(displayW));
    displayH = Math.max(1, Math.floor(displayH));

    const nextData = {};
    if (displayW !== this.data.mainCanvasCssW) nextData.mainCanvasCssW = displayW;
    if (displayH !== this.data.mainCanvasCssH) nextData.mainCanvasCssH = displayH;

    const hasNextData = Object.keys(nextData).length > 0;
    if (hasNextData) {
      const setDataStart = perf ? perfNow() : 0;
      await new Promise((resolve) => this.setData(nextData, resolve));
      if (perf) {
        perf.steps.setDataLayout = +(perfNow() - setDataStart).toFixed(2);
      }
    }

    if (isAborted()) return;

    if (perf) {
      const putStart = perfNow();
      this._canvas.work.ctx.putImageData(workImageData, 0, 0);
      perf.steps.putImageData = +(perfNow() - putStart).toFixed(2);
    } else {
      this._canvas.work.ctx.putImageData(workImageData, 0, 0);
    }

    const presentStart = perf ? perfNow() : 0;
    let presented = false;
    if (this.data.useGLPreview && this._glPreview) {
      presented =
        this._glPreview.resize(displayW, displayH) &&
        this._glPreview.updateTexture(targetWidth, targetHeight, workImageData.data) &&
        this._glPreview.draw();
    }
    if (!presented) {
      // Draw at native pixel size; CSS scaling keeps the preview consistent with fullscreen.
      const mainW = Math.max(1, targetWidth);
      const mainH = Math.max(1, targetHeight);
      const mainNode = this._canvas.main.node;
      if (mainNode.width !== mainW) mainNode.width = mainW;
      if (mainNode.height !== mainH) mainNode.height = mainH;
      const mainCtx = this._canvas.main.ctx;
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.imageSmoothingEnabled = false;
      if (typeof mainCtx.imageSmoothingQuality === "string") {
        mainCtx.imageSmoothingQuality = "low";
      }
      mainCtx.clearRect(0, 0, mainW, mainH);
      mainCtx.drawImage(this._canvas.work.node, 0, 0, mainW, mainH);
    }
    if (perf) {
      perf.steps.present = +(perfNow() - presentStart).toFixed(2);
    }

    if (!this.data.canDownload) {
      this.setData({ canDownload: true });
    }

    if (this._forceMainThreadToken === this._state.imageToken) {
      this._forceMainThreadToken = null;
    }

    this._lastRenderKey = renderKey;
    const renderMs = perfNow() - renderStart;
    this._lastRenderMs = renderMs;
    if (perf && perf.meta) {
      perf.meta.renderMs = +renderMs.toFixed(2);
    }
    if (isInteracting) {
      this._lastInteractiveRenderMs = renderMs;
      this._lastInteractiveRenderAt = perfNow();
      if (this._interactionMode === "slider") {
        this._updateSliderMaxWidth(renderMs, targetWidth, requestedWidth);
      } else {
        this._updateInteractionCap(renderMs, targetWidth, requestedWidth);
        this._updatePreviewScale(renderMs, requestedWidth);
      }
    }
    if (perf) {
      perf.meta.worker = !!perf.meta.worker;
      perf.total = +(perfNow() - perf.start).toFixed(2);
      this._logPerf(perf);
    }
  },

  onInputSwiperChange(e) {
    if (this._suppressInputSwiperChange) return;
    const current = e && e.detail && typeof e.detail.current === "number" ? e.detail.current : 0;
    const nextIndex = current === 1 ? 1 : 0;
    const nextMode = nextIndex === 1 ? "camera" : "image";

    const apply = () => {
      if (nextMode === "camera") {
        this._enterCameraMode();
      } else {
        this._exitCameraMode();
      }
    };

    if (nextIndex === this.data.inputSwiperIndex && nextMode === this.data.inputMode) {
      apply();
      return;
    }

    this.setData({ inputSwiperIndex: nextIndex, inputMode: nextMode }, apply);
  },

  onRetryCamera() {
    if (this.data.inputMode !== "camera") return;
    this._enterCameraMode({ forceRestart: true });
  },

  onOpenCameraSetting() {
    if (!wx.openSetting) return;
    wx.openSetting({
      success: (res) => {
        const ok = !!(res && res.authSetting && res.authSetting["scope.camera"]);
        if (ok) {
          this._enterCameraMode({ forceRestart: true });
        }
      }
    });
  },

  onCameraError(e) {
    const msg = String((e && e.detail && e.detail.errMsg) || "");
    console.error("camera error", msg, e);
    this._stopCameraFrames();

    const lower = msg.toLowerCase();
    const denied = lower.includes("auth") || lower.includes("authorize") || lower.includes("permission") || lower.includes("deny");
    const nextState = denied ? "denied" : "error";
    const nextHint = denied ? "未获得相机权限\n请在设置中开启后重试" : "相机启动失败\n可尝试重试";
    this.setData({ cameraState: nextState, cameraHint: nextHint });
  },

  async _enterCameraMode(options) {
    const forceRestart = !!(options && options.forceRestart);
    this._inputMode = "camera";

    if (forceRestart) {
      this._stopCameraFrames();
    }

    const ready = await this._ensureCanvases();
    if (!ready) {
      this.setData({
        hasImage: true,
        canDownload: false,
        cameraVisible: false,
        cameraState: "error",
        cameraHint: "页面未就绪，请稍后重试"
      });
      this._updateLayout();
      return;
    }

    const savedImage = this._inputMemory && this._inputMemory.image ? this._inputMemory.image : null;
    if (savedImage && savedImage.src && this._contentCheckSource === savedImage.src) {
      savedImage.contentCheckStatus = this._contentCheckStatus;
      savedImage.contentCheckError = this._contentCheckError;
    }

    await new Promise((resolve) => {
      this.setData(
        {
          hasImage: true,
          canDownload: false,
          cameraVisible: true,
          cameraState: "starting",
          cameraHint: "正在启动相机…"
        },
        resolve
      );
    });
    this._updateLayout();

    await sleep(30);
    const started = await this._startCameraFrames();
    if (!started) return;
  },

  _exitCameraMode() {
    if (this._inputMode !== "camera" && this.data.inputMode !== "camera") {
      this._stopCameraFrames();
      return;
    }

    this._inputMode = "image";
    this._stopCameraFrames();

    const restore = this._inputMemory && this._inputMemory.image ? this._inputMemory.image : null;
    const hasRestore = !!(restore && restore.img);

    const next = {
      cameraVisible: false,
      cameraState: "idle",
      cameraHint: "向左滑动进入相机模式"
    };

    if (hasRestore) {
      const restoreSrc = restore.src || "";
      const sameSource =
        !!restoreSrc &&
        this._contentCheckSource === restoreSrc &&
        (this._contentCheckStatus === "pass" ||
          this._contentCheckStatus === "pending" ||
          this._contentCheckStatus === "reject");

      if (!sameSource) {
        if (restoreSrc && (restore.contentCheckStatus === "pass" || restore.contentCheckStatus === "reject")) {
          this._contentCheckStatus = restore.contentCheckStatus;
          this._contentCheckError = restore.contentCheckError || "";
          this._contentCheckSource = restoreSrc;
          this._contentCheckPromise = null;
        } else {
          this._resetContentCheck();
          this._startContentCheck(restoreSrc, restore.info, restore.img);
        }
      }

      this._state.imageToken += 1;
      this._state.originalImage = restore.img;
      this._state.imageInfo = restore.info;
      this._lastRenderKey = "";

      next.hasImage = true;
      next.canDownload = false;

      this.setData(next, () => {
        this._updateLayout();
        this._scheduleProcess({ immediate: true });
      });
      return;
    }

    this._resetContentCheck();
    this._state.imageToken += 1;
    this._state.originalImage = null;
    this._state.imageInfo = null;
    this._lastRenderKey = "";

    next.hasImage = false;
    next.canDownload = false;

    this.setData(next, () => this._updateLayout());
  },

  async _startCameraFrames() {
    this._stopCameraFrames();

    if (!wx.createCameraContext) {
      this.setData({ cameraState: "unsupported", cameraHint: "当前微信版本不支持相机组件" });
      return false;
    }

    const ctx = wx.createCameraContext();
    if (!ctx || typeof ctx.onCameraFrame !== "function") {
      this.setData({ cameraState: "unsupported", cameraHint: "当前基础库不支持实时相机帧" });
      return false;
    }

    const canvas = this._canvas && this._canvas.camera;
    if (
      !canvas ||
      !canvas.ctx ||
      typeof canvas.ctx.putImageData !== "function" ||
      typeof canvas.ctx.createImageData !== "function"
    ) {
      this.setData({ cameraState: "error", cameraHint: "画布未就绪，无法处理相机画面" });
      return false;
    }

    this._camera.token = (this._camera.token || 0) + 1;
    const token = this._camera.token;
    this._camera.ctx = ctx;
    this._camera.lastFrameAt = 0;
    this._camera.frameImageData = null;
    this._camera.running = true;

    try {
      const listener = ctx.onCameraFrame((frame) => this._onCameraFrame(token, frame));
      this._camera.listener = listener;
      if (!listener || typeof listener.start !== "function") {
        throw new Error("camera frame listener unavailable");
      }
      listener.start();
    } catch (err) {
      console.error("start camera frame error", err);
      this._stopCameraFrames();
      this.setData({ cameraState: "error", cameraHint: "相机启动失败\n可尝试重试" });
      return false;
    }

    return true;
  },

  _stopCameraFrames() {
    if (!this._camera) return;
    this._camera.token = (this._camera.token || 0) + 1;

    const listener = this._camera.listener;
    if (listener && typeof listener.stop === "function") {
      try {
        listener.stop();
      } catch (e) {
        // ignore
      }
    }

    this._camera.listener = null;
    this._camera.ctx = null;
    this._camera.running = false;
    this._camera.frameImageData = null;
  },

  _onCameraFrame(token, frame) {
    if (!this._camera || token !== this._camera.token) return;
    if (this.data.inputMode !== "camera") return;
    if (!frame || !frame.data || !frame.width || !frame.height) return;

    const now = perfNow();
    const lastAt = typeof this._camera.lastFrameAt === "number" ? this._camera.lastFrameAt : 0;
    const interval = typeof this._cameraFrameIntervalMs === "number" ? this._cameraFrameIntervalMs : 100;
    if (now - lastAt < interval) return;
    this._camera.lastFrameAt = now;

    const w = Math.max(1, Math.floor(frame.width));
    const h = Math.max(1, Math.floor(frame.height));
    const raw = frame.data;
    let view = null;
    if (raw instanceof ArrayBuffer) {
      view = new Uint8ClampedArray(raw);
    } else if (raw && raw.buffer instanceof ArrayBuffer) {
      const offset = typeof raw.byteOffset === "number" ? raw.byteOffset : 0;
      const length = typeof raw.byteLength === "number" ? raw.byteLength : raw.length;
      view = new Uint8ClampedArray(raw.buffer, offset, length);
    }
    if (!view) return;

    const canvas = this._canvas && this._canvas.camera;
    if (!canvas || !canvas.node || !canvas.ctx) return;

    if (canvas.node.width !== w) canvas.node.width = w;
    if (canvas.node.height !== h) canvas.node.height = h;

    const ctx = canvas.ctx;
    if (!ctx || typeof ctx.putImageData !== "function" || typeof ctx.createImageData !== "function") return;

    let imageData = this._camera.frameImageData;
    if (!imageData || imageData.width !== w || imageData.height !== h) {
      imageData = ctx.createImageData(w, h);
      this._camera.frameImageData = imageData;
    }

    try {
      if (view.length !== w * h * 4) return;
      imageData.data.set(view);
      ctx.putImageData(imageData, 0, 0);
    } catch (e) {
      return;
    }

    this._state.originalImage = canvas.node;
    this._state.imageInfo = { width: w, height: h, orientation: "up", type: "jpeg" };
    this._state.imageToken += 1;

    if (this.data.cameraState !== "running") {
      this.setData({ cameraState: "running", cameraHint: "" });
    }

    this._scheduleProcess({ immediate: true });
  },

  async onChooseImage() {
    console.log("onChooseImage 被调用");

    const resumeCameraAfter = this.data.inputMode === "camera";
    if (resumeCameraAfter) {
      this._stopCameraFrames();
      this.setData({ cameraVisible: false, cameraState: "idle", cameraHint: "向左滑动进入相机模式" });
    }

    try {
      const chooseRes = await new Promise((resolve, reject) => {
        const onSuccess = (res) => {
          console.log("选择图片成功", res);
          resolve(res);
        };
        const onFail = (err) => {
          console.error("选择图片失败", err);
          reject(err);
        };

        if (wx.chooseMedia) {
          wx.chooseMedia({
            count: 1,
            mediaType: ["image"],
            sizeType: ["original"],
            sourceType: ["album", "camera"],
            success: onSuccess,
            fail: onFail
          });
          return;
        }

        wx.chooseImage({
          count: 1,
          sizeType: ["original"],
          sourceType: ["album", "camera"],
          success: onSuccess,
          fail: onFail
        });
      });

      const src =
        (chooseRes.tempFiles && chooseRes.tempFiles[0] && chooseRes.tempFiles[0].tempFilePath) ||
        (chooseRes.tempFilePaths && chooseRes.tempFilePaths[0]);
      if (!src) {
        console.error("未获取到图片路径");
        return;
      }
      this._resetContentCheck();
      const loadToken = (this._imageLoadToken = (this._imageLoadToken || 0) + 1);

      const ready = await this._ensureCanvases();
      if (!ready) {
        wx.showToast({ title: "页面未就绪", icon: "none" });
        return;
      }

      console.log("图片路径:", src);

      const info = await new Promise((resolve, reject) => {
        wx.getImageInfo({
          src,
          success: (res) => {
            console.log("获取图片信息成功", res);
            resolve(res);
          },
          fail: (err) => {
            console.error("获取图片信息失败", err);
            reject(err);
          }
        });
      });
      if (loadToken !== this._imageLoadToken) return;

      console.log("准备加载图片到 canvas");

      const img = this._canvas.buffer.node.createImage();
      await new Promise((resolve, reject) => {
        img.onload = () => {
          console.log("图片加载成功");
          resolve();
        };
        img.onerror = (err) => {
          console.error("图片加载失败", err);
          reject(err);
        };
        img.src = src;
      });
      if (loadToken !== this._imageLoadToken) return;

      this._state.imageToken += 1;
      this._state.originalImage = img;
      this._state.imageInfo = info;
      this._forceMainThreadToken = this._state.imageToken;
      this._startContentCheck(src, info, img);

      this._inputMode = "image";
      this._inputMemory.image = {
        src,
        info,
        img,
        contentCheckStatus: this._contentCheckStatus,
        contentCheckError: this._contentCheckError
      };

      this._proc.scaled = { token: 0, w: 0, h: 0, data: null };
      this._proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
      this._proc.work = { w: 0, h: 0, imageData: null };
      this._lastRenderKey = "";
      this._previewScale = 1;
      this._previewScaleCap = null;
      this._previewScaleLastUpdate = 0;
      this._previewScaleOverCount = 0;
      this._interactionMode = null;
      this._sliderMaxWidth = null;
      this._sliderPerf = null;
      this._interactionCapWidth = null;
      this._interactionCapKey = "";
      this._interactionCapRequestedWidth = 0;
      this._interactionCapRequestedHeight = 0;
      this._interactionCapPerf = null;
      this._interactionCapLastUpdate = 0;
      this._previewTargetMs = this._previewTargetMsBase || 33;
      this._lastRenderMs = 0;
      this._lastInteractiveRenderMs = 0;
      this._lastInteractiveRenderAt = 0;
      this._interactionCapPeakWidth = 0;
      this._interactionCapStableCount = 0;

      const oriented = getOrientedSize(img, info);
      const aspect = oriented.width > 0 ? oriented.height / oriented.width : 1;
      if (this._slider) {
        const min = this._slider.min || 1;
        const step = this._slider.step || 1;
        let nextMax = this._slider.baseMax || this._slider.max || 640;
        const maxByDim = CANVAS_2D_MAX_DIM;
        const maxByHeight = aspect > 0 ? Math.floor(maxByDim / aspect) : maxByDim;
        nextMax = Math.min(nextMax, maxByDim, maxByHeight);
        nextMax = Math.floor(nextMax / step) * step;
        if (nextMax < min) nextMax = min;
        this._slider.max = nextMax;

        const current = this.data.targetWidth;
        if (typeof current === "number" && current > nextMax) {
          this.setData({ targetWidth: nextMax });
        }
      }

      const replacingImage = this.data.hasImage;
      let nextPreviewHeightPx = this.data.previewHeightPx;
      let nextMainCanvasCssW = this.data.mainCanvasCssW;
      let nextMainCanvasCssH = this.data.mainCanvasCssH;
      if (this._isMobile) {
        if (!replacingImage) {
          const box = this._computeMobilePreviewBox(aspect);
          nextPreviewHeightPx = box.previewHeightPx;
          nextMainCanvasCssW = box.displayW;
          nextMainCanvasCssH = box.displayH;
          this._lockPreviewHeight = true;
        } else {
          this._lockPreviewHeight = false;
        }
      } else {
        this._lockPreviewHeight = false;
      }

      const headerVisible = true;
      const openingLayout = {};
      if (this._isMobile && !replacingImage) {
        const headerHeightPx = this._headerRect ? this._headerRect.height || 0 : 0;
        const safeTopPx = this._safeTop || 0;
        const headerOffset = headerVisible ? headerHeightPx : 0;
        const toPaddingTopPx = safeTopPx + nextPreviewHeightPx + headerOffset;
        const fromPaddingTopPx =
          typeof this.data.controlsPaddingTopPx === "number" ? this.data.controlsPaddingTopPx : 0;
        const previewTranslateYPx = headerOffset;
        const previewShiftPx = fromPaddingTopPx - toPaddingTopPx; // start "rolled up"

        openingLayout.controlsPaddingTopPx = fromPaddingTopPx;
        openingLayout.previewTranslateYPx = previewTranslateYPx;
        openingLayout.controlsShiftPx = 0;
        openingLayout.previewShiftPx = previewShiftPx;
        openingLayout.layoutAnimEnabled = false;
      }

      console.log("设置图片状态");

      this._closeHintShown = false;
      this._awaitingPreviewExit = false;
      this._clearCloseHintTimer();
      this._updateCloseVisibility();

      this._suppressInputSwiperChange = true;
      this.setData(
        {
          hasImage: true,
          inputMode: "image",
          inputSwiperIndex: 0,
          cameraVisible: false,
          cameraState: "idle",
          cameraHint: "向左滑动进入相机模式",
          canDownload: false,
          previewHeightPx: nextPreviewHeightPx,
          mainCanvasCssW: nextMainCanvasCssW,
          mainCanvasCssH: nextMainCanvasCssH,
          headerVisible,
          fullscreenVisible: false,
          fullscreenActive: false,
          fullscreenClosing: false,
          fullscreenAnimating: false,
          fullscreenSrc: "",
          controlsScrollTop: 0,
          ...openingLayout
        },
        async () => {
          this._suppressInputSwiperChange = false;
          console.log("开始处理图片");
          this._updateLayout();
          await sleep(50);
          await this._refreshRects();
          this._updateSliderUI();
          await this.onResetTone({ skipProcess: true });

          if (this._initialProcessTimer) clearTimeout(this._initialProcessTimer);
          this._initialProcessTimer = setTimeout(() => {
            this._initialProcessTimer = null;
            this._scheduleProcess({ immediate: true });
          }, 0);
        }
      );
    } catch (e) {
      console.error("上传图片过程出错", e);
      if (String(e && e.errMsg).includes("cancel")) {
        console.log("用户取消选择图片");
        if (resumeCameraAfter) {
          this.setData({ cameraVisible: true, cameraState: "starting", cameraHint: "正在启动相机…" }, () => {
            this._startCameraFrames();
          });
        }
        return;
      }
      wx.showToast({ title: "选择图片失败: " + (e.errMsg || e.message || "未知错误"), icon: "none", duration: 3000 });
    }
  },

  onCloseImage() {
    if (!this.data.closeEnabled || !this.data.closeShown) return;
    if (this.data.inputMode === "camera") {
      this._stopCameraFrames();
      this._suppressInputSwiperChange = true;
      this.setData({ inputMode: "image", inputSwiperIndex: 0 }, () => {
        this._suppressInputSwiperChange = false;
        this._exitCameraMode();
      });
      return;
    }
    this._downloadInProgress = false;
    this._resetContentCheck();
    if (this._initialProcessTimer) {
      clearTimeout(this._initialProcessTimer);
      this._initialProcessTimer = null;
    }
    if (this._layoutRefreshTimer) {
      clearTimeout(this._layoutRefreshTimer);
      this._layoutRefreshTimer = null;
    }
    if (this._layoutAnimTimer) {
      clearTimeout(this._layoutAnimTimer);
      this._layoutAnimTimer = null;
    }
    if (this._layoutCommitTimer) {
      clearTimeout(this._layoutCommitTimer);
      this._layoutCommitTimer = null;
    }
    if (this._slider) {
      this._slider.max = this._slider.baseMax || this._slider.max;
      this._updateSliderUI();
    }
    this._layoutCommitToken = (this._layoutCommitToken || 0) + 1;
    this._layoutOpening = false;
    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
      this._fullscreenCloseTimer = null;
    }
    if (this._fullscreenAnimTimer) {
      clearTimeout(this._fullscreenAnimTimer);
      this._fullscreenAnimTimer = null;
    }
    this._fullscreenAnimToken = (this._fullscreenAnimToken || 0) + 1;
    this._lockPreviewHeight = false;

    this._processToken += 1;

    if (this._workerRenderJob && typeof this._workerRenderJob.resolve === "function") {
      if (this._workerRenderJob.timer) clearTimeout(this._workerRenderJob.timer);
      try {
        this._workerRenderJob.resolve(null);
      } catch (e) {
        // ignore
      }
      this._workerRenderJob = null;
    }
    this._workerBaseKey = "";

    this._state.imageToken += 1;
    this._state.originalImage = null;
    this._state.imageInfo = null;
    this._forceMainThreadToken = null;

    if (this._inputMemory) {
      this._inputMemory.image = null;
    }
    this._fullscreenBase = { scale: 1, x: 0, y: 0 };
    this._fullscreenUser = { scale: 1, x: 0, y: 0 };

    this._proc.scaled = { token: 0, w: 0, h: 0, data: null };
    this._proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
    this._proc.work = { w: 0, h: 0, imageData: null };
    this._previewScale = 1;
    this._previewScaleCap = null;
    this._previewScaleLastUpdate = 0;
    this._previewScaleOverCount = 0;
    this._interactionMode = null;
    this._sliderMaxWidth = null;
    this._sliderPerf = null;
    this._interactionCapWidth = null;
    this._interactionCapKey = "";
    this._interactionCapRequestedWidth = 0;
    this._interactionCapRequestedHeight = 0;
    this._interactionCapPerf = null;
    this._interactionCapLastUpdate = 0;
    this._previewTargetMs = this._previewTargetMsBase || 33;
    this._lastRenderMs = 0;
    this._lastInteractiveRenderMs = 0;
    this._lastInteractiveRenderAt = 0;
    this._interactionCapPeakWidth = 0;
    this._interactionCapStableCount = 0;

    this._closeHintShown = false;
    this._awaitingPreviewExit = false;
    if (this._canvas) {
      this._canvas.main.ctx.clearRect(0, 0, this._canvas.main.node.width, this._canvas.main.node.height);
      this._canvas.work.ctx.clearRect(0, 0, this._canvas.work.node.width, this._canvas.work.node.height);
      this._canvas.buffer.ctx.clearRect(0, 0, this._canvas.buffer.node.width, this._canvas.buffer.node.height);
      if (this._glPreview) {
        this._glPreview.clear();
      }
    }

    const headerVisible = this._isMobile ? true : this.data.headerVisible;
    this.setData({
      hasImage: false,
      inputMode: "image",
      inputSwiperIndex: 0,
      cameraVisible: false,
      cameraState: "idle",
      cameraHint: "向左滑动进入相机模式",
      canDownload: false,
      headerVisible,
      fullscreenVisible: false,
      fullscreenActive: false,
      fullscreenClosing: false,
      fullscreenAnimating: false,
      fullscreenSrc: "",
      fullscreenScale: 1,
      fullscreenTranslateX: 0,
      fullscreenTranslateY: 0
    });
    this._updateLayout();

    const currentScroll =
      this._mobile && typeof this._mobile.currentScrollTop === "number" ? this._mobile.currentScrollTop : 0;
    if (currentScroll > 1) {
      this.setData({ controlsScrollTop: 0 });
    }
  },

  onControlsScroll(e) {
    // Mobile 端标题栏常驻，不再跟随滚动隐藏/下拉显示
    if (!this._isMobile) return;
    const scrollTop = e && e.detail && typeof e.detail.scrollTop === "number" ? e.detail.scrollTop : null;
    if (scrollTop != null) this._mobile.currentScrollTop = scrollTop;
  },

  onControlsTouchStart(e) {
    // Mobile 端标题栏常驻，关闭“下拉拉出标题栏”逻辑
    if (!this._isMobile) return;
  },

  onControlsTouchMove(e) {
    // Mobile 端标题栏常驻，关闭“下拉拉出标题栏”逻辑
    if (!this._isMobile) return;
  },

  onControlsTouchEnd() {
    // Mobile 端标题栏常驻，关闭“下拉拉出标题栏”逻辑
    if (!this._isMobile) return;
  },


  _showHeader() {
    if (this.data.headerVisible) return;
    this.setData({ headerVisible: true }, () => this._updateLayout());
  },

  _hideHeader() {
    if (!this.data.headerVisible) return;
    this.setData({ headerVisible: false }, () => this._updateLayout());
  },

  _isLowPerfDevice() {
    const level = this._sys && typeof this._sys.benchmarkLevel === "number" ? this._sys.benchmarkLevel : null;
    if (typeof level === "number" && isFinite(level)) {
      return level <= 20;
    }
    return false;
  },

  _getInteractionSafeWidth(mode) {
    const SAFE_WIDTH = 640;
    if (mode === "slider") return SAFE_WIDTH;
    const lowPerfWidth = 192;
    const lastInteractiveMs =
      typeof this._lastInteractiveRenderMs === "number" ? this._lastInteractiveRenderMs : 0;
    const lastInteractiveAt =
      typeof this._lastInteractiveRenderAt === "number" ? this._lastInteractiveRenderAt : 0;
    const freshInteraction =
      lastInteractiveAt > 0 && perfNow() - lastInteractiveAt < INTERACTION_CAP_SLOW_WINDOW_MS;
    const slowRecent = freshInteraction && lastInteractiveMs >= 50;
    return this._isLowPerfDevice() || slowRecent ? lowPerfWidth : SAFE_WIDTH;
  },

  _getInteractionBaseSize() {
    const requestedWidth = typeof this.data.targetWidth === "number" ? this.data.targetWidth : 0;
    if (!requestedWidth || !isFinite(requestedWidth)) {
      return { requestedWidth: 0, requestedHeight: 0, aspect: 1 };
    }
    const img = this._state && this._state.originalImage;
    const info = (this._state && this._state.imageInfo) || {};
    const oriented = getOrientedSize(img, info);
    const aspect = oriented.width > 0 ? oriented.height / oriented.width : 1;
    const requestedHeight = Math.max(1, Math.round(requestedWidth * aspect));
    return { requestedWidth, requestedHeight, aspect };
  },

  _getInteractionCapKey(mode, baseWidth, baseHeight) {
    const safeMode = mode || "tone";
    const algo = this.data.ditherAlgo || "";
    const paletteKey = this.data.paletteKey || "";
    const serpentine = this._state && this._state.isSerpentine ? 1 : 0;
    const widthBucket = Math.max(1, Math.round((baseWidth || 1) / INTERACTION_CAP_DIM_BUCKET));
    const heightBucket = Math.max(1, Math.round((baseHeight || 1) / INTERACTION_CAP_DIM_BUCKET));
    return `${safeMode}:${algo}:${paletteKey}:${serpentine}:w${widthBucket}:h${heightBucket}`;
  },

  _loadInteractionCapCache() {
    let stored = null;
    try {
      stored = wx.getStorageSync(INTERACTION_CAP_CACHE_KEY);
    } catch (e) {
      stored = null;
    }

    const cache = Object.create(null);
    const order = [];
    const raw = stored && typeof stored === "object" ? stored : null;
    const rawCache = raw && raw.cache && typeof raw.cache === "object" ? raw.cache : raw;
    const rawOrder = raw && Array.isArray(raw.order) ? raw.order : null;

    if (rawCache && typeof rawCache === "object") {
      Object.keys(rawCache).forEach((key) => {
        const entry = rawCache[key];
        const width =
          typeof entry === "number"
            ? entry
            : entry && typeof entry.w === "number"
            ? entry.w
            : null;
        if (!width || !isFinite(width)) return;
        cache[key] = {
          w: Math.round(width),
          ts: entry && typeof entry.ts === "number" ? entry.ts : 0
        };
      });
    }

    if (rawOrder && rawOrder.length) {
      rawOrder.forEach((key) => {
        if (cache[key] && order.indexOf(key) === -1) {
          order.push(key);
        }
      });
    }

    if (!order.length) {
      Object.keys(cache).forEach((key) => order.push(key));
    }

    while (order.length > INTERACTION_CAP_MAX_ENTRIES) {
      const drop = order.shift();
      if (drop) delete cache[drop];
    }

    this._interactionCapCache = cache;
    this._interactionCapCacheOrder = order;
  },

  _persistInteractionCapCache() {
    const cache = this._interactionCapCache;
    if (!cache) return;
    const order = Array.isArray(this._interactionCapCacheOrder) ? [...this._interactionCapCacheOrder] : [];
    while (order.length > INTERACTION_CAP_MAX_ENTRIES) {
      const drop = order.shift();
      if (drop) delete cache[drop];
    }
    try {
      wx.setStorageSync(INTERACTION_CAP_CACHE_KEY, { v: 1, cache, order });
    } catch (e) {
      // ignore
    }
  },

  _touchInteractionCapKey(key) {
    if (!key) return;
    if (!this._interactionCapCacheOrder) this._interactionCapCacheOrder = [];
    const order = this._interactionCapCacheOrder;
    const idx = order.indexOf(key);
    if (idx >= 0) order.splice(idx, 1);
    order.push(key);
    while (order.length > INTERACTION_CAP_MAX_ENTRIES) {
      const drop = order.shift();
      if (drop && this._interactionCapCache) delete this._interactionCapCache[drop];
    }
  },

  _getInteractionCapFromCache(key) {
    if (!key || !this._interactionCapCache) return null;
    const entry = this._interactionCapCache[key];
    if (!entry) return null;
    const width = typeof entry === "number" ? entry : entry.w;
    if (!width || !isFinite(width)) return null;
    this._touchInteractionCapKey(key);
    return width;
  },

  _commitInteractionCapCache() {
    if (!this._interactionCapKey) return;

    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const minWidth = this._slider && this._slider.min ? this._slider.min : 1;
    const ABSOLUTE_MIN_PX = 96;
    const floorWidth = Math.max(minWidth, ABSOLUTE_MIN_PX);
    const maxWidth =
      typeof this._interactionCapRequestedWidth === "number" && this._interactionCapRequestedWidth > 0
        ? this._interactionCapRequestedWidth
        : this.data.targetWidth || floorWidth;

    const cache = this._interactionCapCache || Object.create(null);
    const prev = cache[this._interactionCapKey];
    let baseWidth = this._interactionCapPeakWidth;
    if (!baseWidth || !isFinite(baseWidth)) {
      if (prev && typeof prev.w === "number" && isFinite(prev.w)) {
        baseWidth = prev.w;
      } else {
        return;
      }
    }
    baseWidth = Math.max(floorWidth, Math.min(maxWidth, baseWidth));
    baseWidth = Math.round(baseWidth / step) * step;
    if (baseWidth < floorWidth) baseWidth = floorWidth;
    if (baseWidth > maxWidth) baseWidth = maxWidth;

    let nextWidth = baseWidth;
    if (prev && typeof prev.w === "number" && isFinite(prev.w)) {
      nextWidth = Math.round(prev.w * 0.7 + baseWidth * 0.3);
    }

    cache[this._interactionCapKey] = { w: nextWidth, ts: Date.now() };
    this._interactionCapCache = cache;
    this._touchInteractionCapKey(this._interactionCapKey);
    this._persistInteractionCapCache();
  },

  _initInteractionCap(mode) {
    const { requestedWidth, requestedHeight } = this._getInteractionBaseSize();
    if (!requestedWidth || !requestedHeight) return;

    const safeWidth = this._getInteractionSafeWidth(mode);
    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const minWidth = this._slider && this._slider.min ? this._slider.min : 1;
    const ABSOLUTE_MIN_PX = 96;
    const floorWidth = Math.max(minWidth, ABSOLUTE_MIN_PX);
    const maxWidth = Math.max(floorWidth, requestedWidth);

    const key = this._getInteractionCapKey(mode, requestedWidth, requestedHeight);
    const cachedWidth = this._getInteractionCapFromCache(key);
    let capWidth =
      typeof cachedWidth === "number" && isFinite(cachedWidth) ? cachedWidth : safeWidth;

    capWidth = Math.max(floorWidth, Math.min(maxWidth, capWidth));
    capWidth = Math.round(capWidth / step) * step;
    if (capWidth < floorWidth) capWidth = floorWidth;
    if (capWidth > maxWidth) capWidth = maxWidth;

    this._interactionCapWidth = capWidth;
    this._interactionCapKey = key;
    this._interactionCapRequestedWidth = requestedWidth;
    this._interactionCapRequestedHeight = requestedHeight;
    this._interactionCapPerf = { over: 0, under: 0, severe: 0 };
    this._interactionCapLastUpdate = 0;
    if (typeof cachedWidth === "number" && isFinite(cachedWidth)) {
      let peakWidth = Math.round(cachedWidth / step) * step;
      peakWidth = Math.max(floorWidth, Math.min(maxWidth, peakWidth));
      this._interactionCapPeakWidth = peakWidth;
    } else {
      this._interactionCapPeakWidth = 0;
    }
    this._interactionCapStableCount = 0;

    const configMin = typeof this._previewScaleMin === "number" ? this._previewScaleMin : 0.1;
    const absMinScale = requestedWidth > 0 ? ABSOLUTE_MIN_PX / requestedWidth : 0;
    const minScale = Math.max(configMin, absMinScale);
    const maxScale = typeof this._previewScaleMax === "number" ? this._previewScaleMax : 1;
    let capScale = requestedWidth > 0 ? capWidth / requestedWidth : 1;
    capScale = Math.max(minScale, Math.min(maxScale, capScale));

    this._previewScale = capScale;
    this._previewScaleCap = capScale;
  },

  _updateInteractionCap(renderMs, targetWidth, requestedWidth) {
    if (!renderMs || !isFinite(renderMs)) return;
    if (this._interactionMode !== "tone") return;
    if (!this._interactionCapWidth || !isFinite(this._interactionCapWidth)) return;

    const budget = typeof this._previewTargetMs === "number" ? this._previewTargetMs : 33;
    if (!budget || !isFinite(budget)) return;

    const step = this._slider && this._slider.step ? this._slider.step : 1;
    const minWidth = this._slider && this._slider.min ? this._slider.min : 1;
    const ABSOLUTE_MIN_PX = 96;
    const floorWidth = Math.max(minWidth, ABSOLUTE_MIN_PX);
    const safeRequestedWidth =
      typeof requestedWidth === "number" && isFinite(requestedWidth) && requestedWidth > 0
        ? requestedWidth
        : this._interactionCapRequestedWidth || this.data.targetWidth || floorWidth;

    const isStable = renderMs <= budget;
    if (isStable) {
      this._interactionCapStableCount = (this._interactionCapStableCount || 0) + 1;
    } else {
      this._interactionCapStableCount = 0;
    }
    if (isStable && this._interactionCapStableCount >= INTERACTION_CAP_STABLE_FRAMES && targetWidth) {
      let stableWidth = Math.round(targetWidth / step) * step;
      stableWidth = Math.max(floorWidth, Math.min(safeRequestedWidth, stableWidth));
      if (!this._interactionCapPeakWidth || stableWidth > this._interactionCapPeakWidth) {
        this._interactionCapPeakWidth = stableWidth;
      }
    }

    const now = perfNow();
    const lastUpdate = this._interactionCapLastUpdate || 0;
    const perf = this._interactionCapPerf || { over: 0, under: 0, severe: 0 };

    const isSevere = renderMs >= budget * 2;
    const isOver = renderMs > budget;
    const isUnder = renderMs < budget * INTERACTION_CAP_UNDER_RATIO;

    perf.severe = isSevere ? perf.severe + 1 : 0;
    perf.over = isOver ? perf.over + 1 : 0;
    perf.under = isUnder ? perf.under + 1 : 0;

    if (!isSevere && now - lastUpdate < INTERACTION_CAP_COOLDOWN_MS) {
      this._interactionCapPerf = perf;
      return;
    }

    let cap = this._interactionCapWidth;
    if (!cap || !isFinite(cap)) cap = safeRequestedWidth;
    const maxWidth = Math.max(floorWidth, safeRequestedWidth);

    const configMin = typeof this._previewScaleMin === "number" ? this._previewScaleMin : 0.1;
    const absMinScale = safeRequestedWidth > 0 ? ABSOLUTE_MIN_PX / safeRequestedWidth : 0;
    const minScale = Math.max(configMin, absMinScale);
    const capScale = safeRequestedWidth > 0 ? cap / safeRequestedWidth : 1;
    const currentScale = typeof this._previewScale === "number" ? this._previewScale : capScale;
    const nearCap = currentScale >= capScale * 0.98;
    const atFloorScale = currentScale <= minScale * 1.05;

    let nextCap = cap;
    const overEnough = perf.over >= INTERACTION_SLOW_FRAMES;
    const shouldReduce = isSevere || (isOver && overEnough);
    if (shouldReduce && (nearCap || atFloorScale || isSevere)) {
      let base = cap;
      if (atFloorScale && targetWidth) {
        base = targetWidth;
      }
      if (isSevere && targetWidth) {
        base = targetWidth;
      }
      base = Math.max(floorWidth, base);

      let ratio = Math.sqrt(budget / renderMs);
      const minRatio = perf.severe >= 2 ? 0.5 : 0.7;
      if (!isFinite(ratio) || ratio <= 0) ratio = minRatio;
      ratio = Math.max(minRatio, Math.min(1, ratio));
      nextCap = Math.min(cap, base * ratio);
      perf.under = 0;
    } else if (perf.under >= 2 && safeRequestedWidth > cap && nearCap) {
      nextCap = Math.min(safeRequestedWidth, cap * INTERACTION_CAP_GROWTH);
    }

    nextCap = Math.max(floorWidth, Math.round(nextCap / step) * step);
    if (nextCap < floorWidth) nextCap = floorWidth;
    if (nextCap > maxWidth) nextCap = maxWidth;

    if (nextCap !== cap) {
      this._interactionCapWidth = nextCap;
      const maxScale = typeof this._previewScaleMax === "number" ? this._previewScaleMax : 1;
      let nextScaleCap = safeRequestedWidth > 0 ? nextCap / safeRequestedWidth : 1;
      nextScaleCap = Math.max(minScale, Math.min(maxScale, nextScaleCap));
      this._previewScaleCap = nextScaleCap;
      if (this._previewScale > nextScaleCap) {
        this._previewScale = nextScaleCap;
      }
      this._interactionCapLastUpdate = now;
    }

    this._interactionCapPerf = perf;
  },

  _clearInteractionConstraints(force) {
    if (!force && this._isInteracting()) return;
    if (this._interactionMode === "tone") {
      this._commitInteractionCapCache();
    }
    this._previewScaleCap = null;
    this._previewTargetMs = this._previewTargetMsBase || 33;
    this._interactionMode = null;
    this._previewScaleOverCount = 0;
    this._sliderMaxWidth = null;
    this._sliderPerf = null;
    this._interactionCapWidth = null;
    this._interactionCapKey = "";
    this._interactionCapRequestedWidth = 0;
    this._interactionCapRequestedHeight = 0;
    this._interactionCapPerf = null;
    this._interactionCapLastUpdate = 0;
    this._interactionCapPeakWidth = 0;
    this._interactionCapStableCount = 0;
  },

  onSliderTap(e) {
    const t = e && e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null;
    if (!t) return;
    this._updateValueFromClientX(t.clientX);
  },

  _applyInteractionStartScale(mode) {
    if (mode === "slider") {
      const safeWidth = this._getInteractionSafeWidth(mode);
      this._previewScale = 1;
      this._previewScaleCap = null;
      this._previewTargetMs = 100;
      const sliderMax = this._slider && this._slider.max ? this._slider.max : safeWidth;
      const step = this._slider && this._slider.step ? this._slider.step : 1;
      const capped = Math.min(sliderMax, safeWidth);
      this._sliderMaxWidth = Math.max(step, Math.round(capped / step) * step);
      this._sliderPerf = { over: 0, under: 0, severe: 0 };
    } else {
      this._previewTargetMs = this._previewTargetMsBase || 33;
      this._sliderMaxWidth = null;
      this._sliderPerf = null;
      if (mode === "tone") {
        this._initInteractionCap(mode);
      } else {
        const safeWidth = this._getInteractionSafeWidth(mode);
        const currentW = this.data.targetWidth || 1000;
        const targetScale = currentW > safeWidth ? safeWidth / currentW : 1;
        const currentScale = typeof this._previewScale === "number" ? this._previewScale : 1;
        this._previewScale = Math.min(currentScale, targetScale);
        this._previewScaleCap = null;
      }
    }
    this._interactionMode = mode || null;
  },

  onSliderTouchStart(e) {
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;
    this._cancelRefine();
    this._applyInteractionStartScale("slider");
    this.setData({ sliderDragging: true });
    this._updateValueFromClientX(t.clientX);
  },

  onSliderTouchMove(e) {
    if (!this.data.sliderDragging) return;
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;
    this._queueSliderUpdate(t.clientX);
  },

  onSliderTouchEnd() {
    this._flushSliderUpdate();
    if (!this.data.sliderDragging) {
      this._clearInteractionConstraints(true);
      this._scheduleRefine();
      return;
    }
    this.setData({ sliderDragging: false }, () => {
      this._clearInteractionConstraints(true);
      this._scheduleRefine();
    });
  },

  async onXYTouchStart(e) {
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;

    this._cancelRefine();
    this._applyInteractionStartScale("tone");
    const rect = await selectRect(this, "#xyPadContainer");
    if (!rect) return;

    this._grid.dragging = true;
    this._grid.rect = rect;
    this._updateCursorFromClient(t.clientX, t.clientY, rect);
  },

  onXYTouchMove(e) {
    if (!this._grid.dragging) return;
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;
    this._queueGridUpdate(t.clientX, t.clientY, this._grid.rect);
  },

  onXYTouchEnd() {
    if (!this._grid.dragging) return;
    this._flushGridUpdate();
    this._grid.dragging = false;
    this._clearInteractionConstraints();
    this._scheduleRefine();
  },

  async onResetTone(options) {
    const skipProcess = options && options.skipProcess;
    const rect = await selectRect(this, "#xyPadContainer");
    if (!rect) return;
    const { innerWidth, innerHeight } = getGridInnerRect(rect);
    if (innerWidth <= 0 || innerHeight <= 0) return;

    this._state.toneX = 0;
    this._state.toneY = 0;

    this._grid.cursorX = innerWidth / 2;
    this._grid.cursorY = innerHeight / 2;
    this._grid.rect = rect;

    const sizeChanged = innerWidth !== this._grid.lastWidth || innerHeight !== this._grid.lastHeight;
    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._grid.lastWidth = innerWidth;
      this._grid.lastHeight = innerHeight;
      this._initGridPoints(innerWidth, innerHeight);
    }
    const needsPointsSync = pointsChanged || !this._grid.pointsSynced;
    const update = { gridCursorX: this._grid.cursorX, gridCursorY: this._grid.cursorY };
    if (needsPointsSync) {
      update.gridPoints = this._grid.points;
      this._grid.pointsSynced = true;
    }
    this.setData(
      update,
      () => {
        if (!skipProcess) this._scheduleProcess();
      }
    );
  },

  onSelectDither(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : null;
    if (!key || key === this.data.ditherAlgo) return;
    this.setData({ ditherAlgo: key }, () => this._scheduleProcess({ immediate: true }));
  },

  onSelectPalette(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : null;
    if (!key || key === this.data.paletteKey) return;
    const paletteEntry = PALETTES[key];
    if (!paletteEntry) return;

    this._state.paletteKey = key;
    this._state.palette = hexToRgb(paletteEntry.colors);
    ensurePaletteFast(this._state.palette);
    this.setData({ paletteKey: key }, () => this._scheduleProcess({ immediate: true }));
  },

  async onDownload() {
    if (!this.data.canDownload || !this._canvas) return;
    if (this._downloadInProgress) {
      wx.showToast({ title: "正在处理，请稍候", icon: "none" });
      return;
    }
    this._downloadInProgress = true;
    try {
    if (this.data.inputMode === "camera") {
      const img = this._state && this._state.originalImage;
      const info = (this._state && this._state.imageInfo) || {};
      if (!img) {
        wx.showToast({ title: "相机未就绪", icon: "none" });
        return;
      }
      this._resetContentCheck();
      this._startContentCheck("", info, img);
    }
    const allowDownload = await this._ensureContentCheckAllowed();
    if (!allowDownload) return;

    const requestedWidth = typeof this.data.targetWidth === "number" ? this.data.targetWidth : 0;
    const currentW = this._proc.work.w;
    if (!this._isInteracting() && requestedWidth > 0 && currentW !== requestedWidth) {
      this._clearInteractionConstraints(true);
      await this._scheduleProcessAndWait({ immediate: true, fullRes: true });
    }

    const w = this._proc.work.w;
    const h = this._proc.work.h;
    if (!w || !h) return;

      const minWidth = 4096;
    let outputScale = Math.ceil(minWidth / w);
    if (outputScale < 1) outputScale = 1;

    const maxOutputScale = Math.max(1, Math.floor(EXPORT_FILE_MAX_DIM / Math.max(w, h)));
    if (outputScale > maxOutputScale) outputScale = maxOutputScale;

    const maxCanvasScale = Math.max(1, Math.floor(CANVAS_2D_MAX_DIM / Math.max(w, h)));
    const drawScale = Math.max(1, Math.min(outputScale, maxCanvasScale));

    const canvasW = w * drawScale;
    const canvasH = h * drawScale;
    const exportW = w * outputScale;
    const exportH = h * outputScale;

    const exportCanvas = this._canvas.export;
    exportCanvas.node.width = canvasW;
    exportCanvas.node.height = canvasH;
    const exportCtx = exportCanvas.ctx;
    exportCtx.setTransform(1, 0, 0, 1, 0, 0);
    exportCtx.imageSmoothingEnabled = false;
    if (typeof exportCtx.imageSmoothingQuality === "string") {
      exportCtx.imageSmoothingQuality = "low";
    }
    exportCtx.clearRect(0, 0, canvasW, canvasH);

    const workImageData = this._proc.work.imageData;
    if (workImageData && workImageData.data && drawScale > 1 && exportCtx.createImageData) {
      const scaledData = exportCtx.createImageData(canvasW, canvasH);
      scaleImageDataNearest(workImageData.data, w, h, drawScale, scaledData.data);
      exportCtx.putImageData(scaledData, 0, 0);
    } else if (workImageData && workImageData.data && drawScale === 1) {
      exportCtx.putImageData(workImageData, 0, 0);
    } else {
      exportCtx.drawImage(this._canvas.work.node, 0, 0, canvasW, canvasH);
    }

    try {
      const tmp = await new Promise((resolve, reject) => {
        const options = {
          canvas: exportCanvas.node,
          fileType: "png",
          success: resolve,
          fail: reject
        };
        if (exportW !== canvasW || exportH !== canvasH) {
          options.destWidth = exportW;
          options.destHeight = exportH;
        }
        wx.canvasToTempFilePath(options);
      });

      const filePath = tmp.tempFilePath;
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject
        });
      });

      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (err) {
      const msg = String(err && err.errMsg);
      if (msg.includes("auth") || msg.includes("authorize") || msg.includes("deny")) {
        wx.showModal({
          title: "需要相册权限",
          content: "请在设置中允许保存到相册。",
          success: (res) => {
            if (res.confirm) wx.openSetting();
          }
        });
        return;
      }
      wx.showToast({ title: "保存失败", icon: "none" });
    }
    } finally {
      this._downloadInProgress = false;
    }
  },

  async onOpenFullscreen() {
    if (!this.data.hasImage || !this._canvas) return;
    if (!this.data.canDownload || !this._proc || !this._proc.work || !this._proc.work.w) {
      wx.showToast({ title: "正在渲染，请稍候", icon: "none" });
      return;
    }

    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
      this._fullscreenCloseTimer = null;
    }
    if (this._fullscreenAnimTimer) {
      clearTimeout(this._fullscreenAnimTimer);
      this._fullscreenAnimTimer = null;
    }
    this._fullscreenPendingOpen = null;
    this._clearCloseHintTimer();
    this._closeHintShown = false;
    this._updateCloseVisibility();

    const previewSelector = this.data.useGLPreview ? "#mainGLCanvas" : "#mainCanvas";
    const previewRect = await selectRect(this, previewSelector);
    const targetRect = this._getFullscreenTargetRect();
    const fromRect =
      previewRect && previewRect.width > 0 && previewRect.height > 0 ? previewRect : targetRect;
    const invert = this._computeFullscreenInvertTransform(fromRect, targetRect);

    this._fullscreenBase = { scale: invert.scale, x: invert.translateX, y: invert.translateY };
    this._fullscreenUser = { scale: 1, x: 0, y: 0 };

    const animToken = (this._fullscreenAnimToken = (this._fullscreenAnimToken || 0) + 1);
    const transformData = this._getFullscreenTransformData();

    this.setData({
      fullscreenVisible: true,
      fullscreenActive: false,
      fullscreenClosing: false,
      fullscreenAnimating: false,
      previewHoldVisible: false,
      fullscreenSrc: "",
      fullscreenImageLeft: targetRect.left,
      fullscreenImageTop: targetRect.top,
      fullscreenImageW: targetRect.width,
      fullscreenImageH: targetRect.height,
      ...transformData
    });

    this._fullscreenTouch = {
      startX: 0,
      startY: 0,
      startTime: 0,
      hasMoved: false,
      touchCount: 0,
      moveThreshold: 10
    };

    const startAnim = () => {
      if (this._fullscreenAnimToken !== animToken) return;
      if (!this.data.fullscreenVisible || this.data.fullscreenClosing) return;

      const holdPreview = !!this._isIPad;
      this.setData({ fullscreenActive: true, fullscreenAnimating: true, previewHoldVisible: holdPreview }, () => {
        if (this._fullscreenAnimToken !== animToken) return;
        if (holdPreview) {
          const releaseHold = () => {
            if (this._fullscreenAnimToken !== animToken) return;
            if (!this.data.fullscreenVisible || this.data.fullscreenClosing) return;
            if (this.data.previewHoldVisible) this.setData({ previewHoldVisible: false });
          };
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(releaseHold);
          } else {
            setTimeout(releaseHold, 16);
          }
        }
        const applyTransform = () => {
          if (this._fullscreenAnimToken !== animToken) return;
          this._fullscreenBase = { scale: 1, x: 0, y: 0 };
          this._applyFullscreenTransform();

          this._fullscreenAnimTimer = setTimeout(() => {
            if (this._fullscreenAnimToken !== animToken) return;
            this.setData({ fullscreenAnimating: false });
            this._fullscreenAnimTimer = null;
          }, 260);
        };

        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => requestAnimationFrame(applyTransform));
        } else {
          setTimeout(applyTransform, 32);
        }
      });
    };

    try {
      const tmp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: this._canvas.work.node,
          fileType: "png",
          success: resolve,
          fail: reject
        });
      });

      if (this._fullscreenAnimToken !== animToken) return;
      this._fullscreenPendingOpen = { token: animToken, startAnim };
      this.setData({ fullscreenSrc: tmp.tempFilePath });
    } catch {
      if (this._fullscreenAnimToken !== animToken) return;
      this._fullscreenPendingOpen = null;
      this.setData({
        fullscreenVisible: false,
        fullscreenActive: false,
        fullscreenClosing: false,
        fullscreenAnimating: false,
        previewHoldVisible: false,
        fullscreenSrc: ""
      });
      wx.showToast({ title: "预览失败", icon: "none" });
    }
  },

  onFullscreenImageLoad() {
    const pending = this._fullscreenPendingOpen;
    if (!pending) return;
    if (this._fullscreenAnimToken !== pending.token) {
      this._fullscreenPendingOpen = null;
      return;
    }
    this._fullscreenPendingOpen = null;
    if (!this.data.fullscreenVisible || this.data.fullscreenClosing) return;

    const fire = () => {
      if (this._fullscreenAnimToken !== pending.token) return;
      pending.startAnim();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(fire);
    } else {
      setTimeout(fire, 16);
    }
  },

  onFullscreenImageError() {
    const pending = this._fullscreenPendingOpen;
    if (pending) this._fullscreenPendingOpen = null;
    if (!this.data.fullscreenVisible || this.data.fullscreenClosing) return;

    this._fullscreenAnimToken = (this._fullscreenAnimToken || 0) + 1;
    this.setData({
      fullscreenVisible: false,
      fullscreenActive: false,
      fullscreenClosing: false,
      fullscreenAnimating: false,
      previewHoldVisible: false,
      fullscreenSrc: ""
    });
    wx.showToast({ title: "预览失败", icon: "none" });
  },

  onFullscreenTouchStart(e) {
    if (!this.data.fullscreenActive || this.data.fullscreenClosing) return;
    const touches = e.touches || [];
    this._fullscreenTouch.touchCount = touches.length;
    this._fullscreenTouch.hasMoved = touches.length !== 1;

    if (touches.length === 1) {
      this._fullscreenTouch.startX = touches[0].clientX;
      this._fullscreenTouch.startY = touches[0].clientY;
      this._fullscreenTouch.startTime = Date.now();
    }
  },

  onFullscreenTouchMove(e) {
    if (!this.data.fullscreenActive || this.data.fullscreenClosing) return;
    const touches = e.touches;
    if (!touches || !touches.length) return;

    if (touches.length === 1 && this._fullscreenTouch.touchCount === 1) {
      const deltaX = touches[0].clientX - this._fullscreenTouch.startX;
      const deltaY = touches[0].clientY - this._fullscreenTouch.startY;
      const threshold = this._fullscreenTouch.moveThreshold || 6;

      if (!this._fullscreenTouch.hasMoved && (Math.abs(deltaX) > threshold || Math.abs(deltaY) > threshold)) {
        this._fullscreenTouch.hasMoved = true;
      }

    }
  },

  onFullscreenTouchEnd(e) {
    if (!this.data.fullscreenActive || this.data.fullscreenClosing) return;
    const touches = e.touches;

    if (touches.length === 0) {
      const duration = Date.now() - this._fullscreenTouch.startTime;
      const wasTap = !this._fullscreenTouch.hasMoved && duration < 450 && this._fullscreenTouch.touchCount === 1;

      if (wasTap) {
        this.onCloseFullscreen();
      }

      this._fullscreenTouch.hasMoved = false;
      this._fullscreenTouch.touchCount = 0;
    }
  },

  onFullscreenTap() {
    if (!this.data.fullscreenActive || this.data.fullscreenClosing) return;
    const touch = this._fullscreenTouch;
    if (touch && touch.touchCount > 1) return;
    if (touch && touch.hasMoved) return;
    this.onCloseFullscreen();
  },

  async onCloseFullscreen() {
    if (!this.data.fullscreenVisible || this.data.fullscreenClosing) return;
    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
      this._fullscreenCloseTimer = null;
    }
    if (this._fullscreenAnimTimer) {
      clearTimeout(this._fullscreenAnimTimer);
      this._fullscreenAnimTimer = null;
    }
    this._fullscreenPendingOpen = null;
    const closeToken = (this._fullscreenAnimToken = (this._fullscreenAnimToken || 0) + 1);

    const previewSelector = this.data.useGLPreview ? "#mainGLCanvas" : "#mainCanvas";
    const previewRect = await selectRect(this, previewSelector);
    const targetRect = this._getFullscreenTargetRect();
    const fromRect =
      previewRect && previewRect.width > 0 && previewRect.height > 0 ? previewRect : targetRect;
    const invert = this._computeFullscreenInvertTransform(fromRect, targetRect);

    const user = this._fullscreenUser || { scale: 1, x: 0, y: 0 };
    const userScale = user.scale || 1;
    const userX = user.x || 0;
    const userY = user.y || 0;

    const baseScale = invert.scale / userScale;
    const baseX = invert.translateX - userX;
    const baseY = invert.translateY - userY;
    const nextBase = { scale: baseScale, x: baseX, y: baseY };

    this.setData(
      {
        fullscreenClosing: true,
        fullscreenActive: false,
        fullscreenAnimating: true,
        previewHoldVisible: false,
        fullscreenImageLeft: targetRect.left,
        fullscreenImageTop: targetRect.top,
        fullscreenImageW: targetRect.width,
        fullscreenImageH: targetRect.height,
        ...this._getFullscreenTransformData()
      },
      () => {
        if (this._fullscreenAnimToken !== closeToken) return;
        this._fullscreenAnimTimer = setTimeout(() => {
          if (this._fullscreenAnimToken !== closeToken) return;
          this._fullscreenAnimTimer = null;
          this._fullscreenBase = nextBase;
          this._applyFullscreenTransform();

          const duration = 260;
          this._fullscreenCloseTimer = setTimeout(() => {
            if (this._fullscreenAnimToken !== closeToken) return;
              this._fullscreenCloseTimer = null;
              this._fullscreenBase = { scale: 1, x: 0, y: 0 };
              this._fullscreenUser = { scale: 1, x: 0, y: 0 };
              this._refreshPreviewSurface();
              const finalizeClose = () => {
                this.setData(
                  {
                    fullscreenVisible: false,
                    fullscreenActive: false,
                    fullscreenClosing: false,
                    fullscreenAnimating: false,
                    previewHoldVisible: false,
                    fullscreenSrc: "",
                    fullscreenScale: 1,
                    fullscreenTranslateX: 0,
                    fullscreenTranslateY: 0
                  },
                  () => {
                    this._showCloseHint();
                  }
                );
              };

              if (this._isIPad) {
                this.setData({ previewHoldVisible: true }, () => {
                  const nextFrame = () => {
                    if (this._fullscreenAnimToken !== closeToken) return;
                    finalizeClose();
                  };
                  if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(nextFrame);
                  } else {
                    setTimeout(nextFrame, 16);
                  }
                });
                return;
              }

              finalizeClose();
          }, duration);
        }, 16);
      }
    );
  }
});
