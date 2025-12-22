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

function isRotate90(orientation) {
  return (
    orientation === "left" ||
    orientation === "right" ||
    orientation === "left-mirrored" ||
    orientation === "right-mirrored"
  );
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
    closeEnabled: false,
    closeShown: false,
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

    canDownload: false,
    fullscreenVisible: false,
    fullscreenSrc: "",
    fullscreenScale: 1,
    fullscreenTranslateX: 0,
    fullscreenTranslateY: 0,

    controlsScrollTop: 0,
    controlsPaddingTopPx: 15,
    previewTranslateYPx: 0,
    previewHeightPx: 0,

    mainCanvasCssW: 1,
    mainCanvasCssH: 1
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    this._sys = sys;
    this._dpr = sys.pixelRatio || 1;
    this._isMobile = (sys.windowWidth || 0) <= 768;
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
    this._lastRenderKey = "";
    this._lockPreviewHeight = false;
    this._closeHintShown = false;
    this._awaitingPreviewExit = false;
    this._clearCloseHintTimer();
    this._closeHintTimer = null;
    this._imageLoadToken = 0;

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
      navPadLeftPx: navPad.left,
      navPadRightPx: navPad.right,
      previewHeightPx,
      controlsPaddingTopPx
    });

    if (wx.onThemeChange) {
      this._themeChangeHandler = (res) => {
        const nextTheme = this._resolveSystemTheme(res);
        this._applyTheme(nextTheme);
      };
      wx.onThemeChange(this._themeChangeHandler);
    }
  },

  async onReady() {
    await this._refreshRects();
    this._updateSliderUI();
    this._syncToneCursorToRect();
    this._updateLayout();
    await this._ensureCanvases();

    wx.onWindowResize(async (res) => {
      this._sys = { ...this._sys, ...res };
      const navPad = this._calcNavPadding(this._sys);
      this.setData({ navPadLeftPx: navPad.left, navPadRightPx: navPad.right });
      await sleep(50);
      await this._refreshRects();
      this._updateSliderUI();
      this._syncToneCursorToRect();

      if (this._isMobile && this.data.hasImage && this._state && this._state.originalImage) {
        const info = this._state.imageInfo || {};
        const orientedW = isRotate90(info.orientation) ? info.height : info.width;
        const orientedH = isRotate90(info.orientation) ? info.width : info.height;
        const aspect = orientedW > 0 ? orientedH / orientedW : this._state.originalImage.height / this._state.originalImage.width;
        const box = this._computeMobilePreviewBox(aspect);
        this._lockPreviewHeight = true;
        this.setData({ previewHeightPx: box.previewHeightPx }, () => this._updateLayout());
      } else {
        this._updateLayout();
      }

      await this._ensureCanvases();
      this._scheduleProcess();
    });
  },

  async _ensureCanvases() {
    if (this._canvas) return true;

    const [main, work, buffer, exportC] = await Promise.all([
      selectCanvas(this, "#mainCanvas"),
      selectCanvas(this, "#workCanvas"),
      selectCanvas(this, "#bufferCanvas"),
      selectCanvas(this, "#exportCanvas")
    ]);

    if (!main || !work || !buffer || !exportC) return false;

    this._canvas = {
      main: { node: main.node, ctx: main.node.getContext("2d") },
      work: { node: work.node, ctx: work.node.getContext("2d") },
      buffer: { node: buffer.node, ctx: buffer.node.getContext("2d") },
      export: { node: exportC.node, ctx: exportC.node.getContext("2d") }
    };

    return true;
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
    let cols = Math.ceil(w / step);
    if (cols % 2 === 0) cols += 1;

    let rows = Math.ceil(h / step);
    if (rows % 2 === 0) rows += 1;

    const totalW = (cols - 1) * step;
    const totalH = (rows - 1) * step;
    const offsetX = (w - totalW) / 2;
    const offsetY = (h - totalH) / 2;

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

  _updateLayout() {
    if (!this._isMobile) {
      this.setData({ previewTranslateYPx: 0, controlsPaddingTopPx: 0 });
      this._updateCloseVisibility();
      return;
    }

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

    this.setData({ controlsPaddingTopPx, previewTranslateYPx }, async () => {
      const delayMs = this._isMobile && this.data.hasImage ? 360 : 0;
      if (this._layoutRefreshTimer) clearTimeout(this._layoutRefreshTimer);
      this._layoutRefreshTimer = setTimeout(async () => {
        await this._refreshRects();
        this._syncToneCursorToRect();
      }, delayMs);
    });
    this._updateCloseVisibility();
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
    return width > 768;
  },

  _syncToneCursorToRect() {
    const rect = this._grid.rect;
    if (!rect) return;

    const w = rect.width || 0;
    const h = rect.height || 0;
    if (w <= 0 || h <= 0) return;

    const oldW = this._grid.lastWidth || w;
    const oldH = this._grid.lastHeight || h;
    const sizeChanged = oldW !== w || oldH !== h;

    if (this._grid.cursorX === 0 && this._grid.cursorY === 0) {
      this._grid.cursorX = w / 2;
      this._grid.cursorY = h / 2;
    } else if (oldW > 0 && oldH > 0 && sizeChanged) {
      this._grid.cursorX = (this._grid.cursorX / oldW) * w;
      this._grid.cursorY = (this._grid.cursorY / oldH) * h;
    }

    this._grid.lastWidth = w;
    this._grid.lastHeight = h;

    this._grid.cursorX = Math.max(0, Math.min(w, this._grid.cursorX));
    this._grid.cursorY = Math.max(0, Math.min(h, this._grid.cursorY));

    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._initGridPoints(w, h);
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
      this._scheduleProcess();
    }
  },

  async _updateCursorFromClient(clientX, clientY, rectOverride) {
    let rect = rectOverride || this._grid.rect;
    if (!rect) {
      rect = await selectRect(this, "#xyPadContainer");
      if (!rect) return;
    }

    let x = clientX - rect.left;
    let y = clientY - rect.top;
    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));
    this._grid.cursorX = x;
    this._grid.cursorY = y;
    this._grid.rect = rect;

    const sizeChanged = rect.width !== this._grid.lastWidth || rect.height !== this._grid.lastHeight;
    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._grid.lastWidth = rect.width;
      this._grid.lastHeight = rect.height;
      this._initGridPoints(rect.width, rect.height);
    }

    const nx = rect.width > 0 ? x / rect.width : 0.5;
    const ny = rect.height > 0 ? y / rect.height : 0.5;
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

    this._scheduleProcess();
  },

  _scheduleProcess() {
    if (!this.data.hasImage || !this._state.palette || !this._canvas) return;

    if (this._isProcessing) {
      if (this._processRunning) {
        this._processToken += 1;
        this._updatePending = true;
      }
      return;
    }

    this._processToken += 1;
    const processToken = this._processToken;
    this._isProcessing = true;
    this._processRunning = false;
    this._updatePending = false;

    const scheduleFrame =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);

    scheduleFrame(() => {
      setTimeout(() => {
        this._processRunning = true;
        this._updatePending = false;
        try {
          this._processImage(processToken);
        } finally {
          this._processRunning = false;
          this._isProcessing = false;
          if (this._updatePending) this._scheduleProcess();
        }
      }, 0);
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

  _processImage(processToken) {
    const isAborted = () => typeof processToken === "number" && processToken !== this._processToken;
    const img = this._state.originalImage;
    const palette = this._state.palette;
    if (!img || !palette) return;

    const { targetWidth, ditherAlgo } = this.data;
    const toneX = this._state.toneX;
    const toneY = this._state.toneY;

    const info = this._state.imageInfo || {};
    const orientedW = isRotate90(info.orientation) ? info.height : info.width;
    const orientedH = isRotate90(info.orientation) ? info.width : info.height;
    const aspect = orientedW > 0 ? orientedH / orientedW : img.height / img.width;
    const targetHeight = Math.max(1, Math.round(targetWidth * aspect));

    const renderKey = `${this._state.imageToken}:${targetWidth}x${targetHeight}:${ditherAlgo}:${this.data.paletteKey}:${toneX.toFixed(4)}:${toneY.toFixed(4)}`;
    if (renderKey === this._lastRenderKey) return;
    this._lastRenderKey = renderKey;

    const proc = this._proc;
    const buffer = this._canvas.buffer;

    if (
      proc.scaled.token !== this._state.imageToken ||
      proc.scaled.w !== targetWidth ||
      proc.scaled.h !== targetHeight ||
      !proc.scaled.data
    ) {
      buffer.node.width = targetWidth;
      buffer.node.height = targetHeight;
      buffer.ctx.imageSmoothingEnabled = true;
      if (typeof buffer.ctx.imageSmoothingQuality === "string") {
        buffer.ctx.imageSmoothingQuality = "high";
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
    }

    if (isAborted()) return;

    const baseData = proc.scaled.data;

    if (!proc.work.imageData || proc.work.w !== targetWidth || proc.work.h !== targetHeight) {
      this._canvas.work.node.width = targetWidth;
      this._canvas.work.node.height = targetHeight;
      proc.work.imageData = this._canvas.work.ctx.getImageData(0, 0, targetWidth, targetHeight);
      proc.work.w = targetWidth;
      proc.work.h = targetHeight;
    }

    const workImageData = proc.work.imageData;
    workImageData.data.set(baseData);

    if (toneX !== 0 || toneY !== 0) {
      let toneStats = proc.toneStats.stats;
      if (
        !toneStats ||
        proc.toneStats.token !== this._state.imageToken ||
        proc.toneStats.w !== targetWidth ||
        proc.toneStats.h !== targetHeight
      ) {
        toneStats = computeToneStats({ data: baseData, width: targetWidth, height: targetHeight });
        proc.toneStats = { token: this._state.imageToken, w: targetWidth, h: targetHeight, stats: toneStats };
      }
      applyDynamicToneMapping(workImageData, toneX, toneY, toneStats);
    }

    if (isAborted()) return;

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

    if (isAborted()) return;

    this._canvas.work.ctx.putImageData(workImageData, 0, 0);

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
    if (!this.data.canDownload) nextData.canDownload = true;

    const hasNextData = Object.keys(nextData).length > 0;
    if (hasNextData) {
      this.setData(nextData);
    }

    // Draw at native pixel size; CSS scaling keeps the preview crisp like fullscreen.
    const mainW = Math.max(1, targetWidth);
    const mainH = Math.max(1, targetHeight);
    this._canvas.main.node.width = mainW;
    this._canvas.main.node.height = mainH;
    const mainCtx = this._canvas.main.ctx;
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.imageSmoothingEnabled = false;
    if (typeof mainCtx.imageSmoothingQuality === "string") {
      mainCtx.imageSmoothingQuality = "low";
    }
    mainCtx.clearRect(0, 0, mainW, mainH);
    mainCtx.drawImage(this._canvas.work.node, 0, 0, mainW, mainH);
  },

  async onChooseImage() {
    console.log("onChooseImage 被调用");

    try {
      const chooseRes = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 1,
          sizeType: ["original"],
          sourceType: ["album", "camera"],
          success: (res) => {
            console.log("选择图片成功", res);
            resolve(res);
          },
          fail: (err) => {
            console.error("选择图片失败", err);
            reject(err);
          }
        });
      });

      const src = chooseRes.tempFilePaths && chooseRes.tempFilePaths[0];
      if (!src) {
        console.error("未获取到图片路径");
        return;
      }
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

      this._proc.scaled = { token: 0, w: 0, h: 0, data: null };
      this._proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
      this._proc.work = { w: 0, h: 0, imageData: null };
      this._lastRenderKey = "";

      const orientedW = isRotate90(info.orientation) ? info.height : info.width;
      const orientedH = isRotate90(info.orientation) ? info.width : info.height;
      const aspect = orientedW > 0 ? orientedH / orientedW : img.height / img.width;

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
      const headerHeightPx = this._headerRect ? this._headerRect.height || 0 : 0;
      const safeTopPx = this._safeTop || 0;
      const headerOffset = headerVisible ? headerHeightPx : 0;
      const controlsPaddingTopPx = this._isMobile ? safeTopPx + nextPreviewHeightPx + headerOffset : 0;
      const previewTranslateYPx = this._isMobile ? headerOffset : 0;

      console.log("设置图片状态");

      this._closeHintShown = false;
      this._awaitingPreviewExit = false;
      this._clearCloseHintTimer();
      this._updateCloseVisibility();

      this.setData(
        {
          hasImage: true,
          canDownload: false,
          previewHeightPx: nextPreviewHeightPx,
          mainCanvasCssW: nextMainCanvasCssW,
          mainCanvasCssH: nextMainCanvasCssH,
          headerVisible,
          controlsPaddingTopPx,
          previewTranslateYPx,
          fullscreenVisible: false,
          fullscreenSrc: "",
          controlsScrollTop: 0
        },
        async () => {
          console.log("开始处理图片");
          await sleep(50);
          await this._refreshRects();
          await this.onResetTone({ skipProcess: true });
          this._updateLayout();

          const delayMs = this._isMobile && !replacingImage ? 360 : 0;
          if (this._initialProcessTimer) clearTimeout(this._initialProcessTimer);
          this._initialProcessTimer = setTimeout(() => {
            this._initialProcessTimer = null;
            this._scheduleProcess();
          }, delayMs);
        }
      );
    } catch (e) {
      console.error("上传图片过程出错", e);
      if (String(e && e.errMsg).includes("cancel")) {
        console.log("用户取消选择图片");
        return;
      }
      wx.showToast({ title: "选择图片失败: " + (e.errMsg || e.message || "未知错误"), icon: "none", duration: 3000 });
    }
  },

  onCloseImage() {
    if (this._initialProcessTimer) {
      clearTimeout(this._initialProcessTimer);
      this._initialProcessTimer = null;
    }
    if (this._layoutRefreshTimer) {
      clearTimeout(this._layoutRefreshTimer);
      this._layoutRefreshTimer = null;
    }
    this._lockPreviewHeight = false;

    this._state.imageToken += 1;
    this._state.originalImage = null;
    this._state.imageInfo = null;

    this._proc.scaled = { token: 0, w: 0, h: 0, data: null };
    this._proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
    this._proc.work = { w: 0, h: 0, imageData: null };

    this._closeHintShown = false;
    this._awaitingPreviewExit = false;
    if (this._canvas) {
      this._canvas.main.ctx.clearRect(0, 0, this._canvas.main.node.width, this._canvas.main.node.height);
      this._canvas.work.ctx.clearRect(0, 0, this._canvas.work.node.width, this._canvas.work.node.height);
      this._canvas.buffer.ctx.clearRect(0, 0, this._canvas.buffer.node.width, this._canvas.buffer.node.height);
    }

    const headerVisible = this._isMobile ? true : this.data.headerVisible;
    this.setData({
      hasImage: false,
      canDownload: false,
      headerVisible,
      fullscreenVisible: false,
      fullscreenSrc: ""
    });
    this._updateLayout();

    const scrollReset = () => this.setData({ controlsScrollTop: 0 });
    this.setData({ controlsScrollTop: 1 }, scrollReset);
  },

  onControlsScroll(e) {
    // Mobile 端标题栏常驻，不再跟随滚动隐藏/下拉显示
    if (!this._isMobile) return;
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

  onSliderTap(e) {
    const t = e && e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null;
    if (!t) return;
    this._updateValueFromClientX(t.clientX);
  },

  onSliderTouchStart(e) {
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;
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
    if (!this.data.sliderDragging) return;
    this._flushSliderUpdate();
    this.setData({ sliderDragging: false });
  },

  async onXYTouchStart(e) {
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;

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
    this._grid.dragging = false;
    this._flushGridUpdate();
  },

  async onResetTone(options) {
    const skipProcess = options && options.skipProcess;
    const rect = await selectRect(this, "#xyPadContainer");
    if (!rect) return;

    this._state.toneX = 0;
    this._state.toneY = 0;

    this._grid.cursorX = rect.width / 2;
    this._grid.cursorY = rect.height / 2;
    this._grid.rect = rect;

    const sizeChanged = rect.width !== this._grid.lastWidth || rect.height !== this._grid.lastHeight;
    const pointsChanged = sizeChanged || !this._grid.points || this._grid.points.length === 0;
    if (pointsChanged) {
      this._grid.lastWidth = rect.width;
      this._grid.lastHeight = rect.height;
      this._initGridPoints(rect.width, rect.height);
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
    this.setData({ ditherAlgo: key }, () => this._scheduleProcess());
  },

  onSelectPalette(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : null;
    if (!key || key === this.data.paletteKey) return;
    const paletteEntry = PALETTES[key];
    if (!paletteEntry) return;

    this._state.paletteKey = key;
    this._state.palette = hexToRgb(paletteEntry.colors);
    ensurePaletteFast(this._state.palette);
    this.setData({ paletteKey: key }, () => this._scheduleProcess());
  },

  async onDownload() {
    if (!this.data.canDownload || !this._canvas) return;

    const w = this._proc.work.w;
    const h = this._proc.work.h;
    if (!w || !h) return;

    const minWidth = 2000;
    let scale = Math.ceil(minWidth / w);
    if (scale < 1) scale = 1;

    const MAX_EXPORT_DIM = 4096;
    const maxScale = Math.max(1, Math.floor(MAX_EXPORT_DIM / Math.max(w, h)));
    if (scale > maxScale) scale = maxScale;

    const exportW = w * scale;
    const exportH = h * scale;

    const exportCanvas = this._canvas.export;
    exportCanvas.node.width = exportW;
    exportCanvas.node.height = exportH;
    const exportCtx = exportCanvas.ctx;
    exportCtx.setTransform(1, 0, 0, 1, 0, 0);
    exportCtx.imageSmoothingEnabled = false;
    if (typeof exportCtx.imageSmoothingQuality === "string") {
      exportCtx.imageSmoothingQuality = "low";
    }
    exportCtx.clearRect(0, 0, exportW, exportH);

    const workImageData = this._proc.work.imageData;
    if (workImageData && workImageData.data && scale > 1 && exportCtx.createImageData) {
      const scaledData = exportCtx.createImageData(exportW, exportH);
      scaleImageDataNearest(workImageData.data, w, h, scale, scaledData.data);
      exportCtx.putImageData(scaledData, 0, 0);
    } else if (workImageData && workImageData.data && scale === 1) {
      exportCtx.putImageData(workImageData, 0, 0);
    } else {
      exportCtx.drawImage(this._canvas.work.node, 0, 0, exportW, exportH);
    }

    try {
      const tmp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: exportCanvas.node,
          fileType: "png",
          success: resolve,
          fail: reject
        });
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
  },

  async onOpenFullscreen() {
    if (!this.data.hasImage || !this._canvas) return;

    this.setData({
      fullscreenVisible: true,
      fullscreenSrc: "",
      fullscreenScale: 1,
      fullscreenTranslateX: 0,
      fullscreenTranslateY: 0
    });

    this._fullscreenTouch = {
      lastDistance: 0,
      lastCenter: { x: 0, y: 0 },
      initialScale: 1,
      startY: 0,
      startTime: 0,
      hasMoved: false,
      touchCount: 0
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

      this.setData({ fullscreenSrc: tmp.tempFilePath });
    } catch {
      this.setData({ fullscreenVisible: false, fullscreenSrc: "" });
      wx.showToast({ title: "预览失败", icon: "none" });
    }
  },

  onFullscreenTouchStart(e) {
    const touches = e.touches;
    this._fullscreenTouch.touchCount = touches.length;
    this._fullscreenTouch.hasMoved = false;

    if (touches.length === 1) {
      this._fullscreenTouch.startY = touches[0].clientY;
      this._fullscreenTouch.startTime = Date.now();
    } else if (touches.length === 2) {
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      this._fullscreenTouch.lastDistance = Math.sqrt(dx * dx + dy * dy);
      this._fullscreenTouch.lastCenter = {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
      };
      this._fullscreenTouch.initialScale = this.data.fullscreenScale;
    }
  },

  onFullscreenTouchMove(e) {
    const touches = e.touches;
    this._fullscreenTouch.hasMoved = true;

    if (touches.length === 2) {
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (this._fullscreenTouch.lastDistance > 0) {
        const scale = (distance / this._fullscreenTouch.lastDistance) * this._fullscreenTouch.initialScale;
        const clampedScale = Math.max(1, Math.min(5, scale));

        this.setData({
          fullscreenScale: clampedScale
        });
      }
    } else if (touches.length === 1 && this._fullscreenTouch.touchCount === 1) {
      const deltaY = touches[0].clientY - this._fullscreenTouch.startY;

      if (deltaY > 100 && this.data.fullscreenScale === 1) {
        this.onCloseFullscreen();
      }
    }
  },

  onFullscreenTouchEnd(e) {
    const touches = e.touches;

    if (touches.length < 2) {
      this._fullscreenTouch.lastDistance = 0;
    }

    if (touches.length === 0) {
      const duration = Date.now() - this._fullscreenTouch.startTime;
      const wasTap = !this._fullscreenTouch.hasMoved && duration < 300 && this._fullscreenTouch.touchCount === 1;

      if (wasTap) {
        this.onCloseFullscreen();
      }

      this._fullscreenTouch.hasMoved = false;
      this._fullscreenTouch.touchCount = 0;
    }
  },

  onCloseFullscreen() {
    if (!this.data.fullscreenVisible) return;
    this.setData({
      fullscreenVisible: false,
      fullscreenSrc: "",
      fullscreenScale: 1,
      fullscreenTranslateX: 0,
      fullscreenTranslateY: 0
    }, () => {
      this._showCloseHint();
    });
  }
});
