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

Page({
  data: {
    themeClass: "theme-light",
    closeIconSrc: "/assets/icons/close-light.svg",
    headerVisible: true,
    hasImage: false,
    closeVisible: false,
    safeTopPx: 0,

    targetWidth: 128,
    sliderThumbLeftPx: 0,
    sliderDragging: false,

    toneX: 0,
    toneY: 0,
    xyCursorLeftPx: 0,
    xyCursorTopPx: 0,

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

    const stored = wx.getStorageSync("pixelizer_theme");
    const theme = stored === "dark" ? "dark" : "light";
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
      rect: null
    };

    this._grid = {
      dragging: false,
      cursorX: 0,
      cursorY: 0,
      rect: null,
      lastWidth: 0,
      lastHeight: 0
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
    this._updatePending = false;
    this._lastRenderKey = "";
    this._lockPreviewHeight = false;

    const safeTopPx = this._safeTop;
    const previewHeightPx = this._isMobile ? Math.floor((sys.windowHeight || 0) * 0.4) : 0;
    const controlsPaddingTopPx = this._isMobile ? 15 + safeTopPx : 0;
    this.setData({
      themeClass: theme === "dark" ? "theme-dark" : "theme-light",
      closeIconSrc: theme === "dark" ? "/assets/icons/close-dark.svg" : "/assets/icons/close-light.svg",
      paletteList,
      safeTopPx,
      previewHeightPx,
      controlsPaddingTopPx
    });
  },

  async onReady() {
    await this._refreshRects();
    this._updateSliderUI();
    this._syncToneCursorToRect();
    this._updateLayout();
    await this._ensureCanvases();

    wx.onWindowResize(async (res) => {
      this._sys = { ...this._sys, ...res };
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
    const visible = this.data.hasImage;
    if (visible !== this.data.closeVisible) this.setData({ closeVisible: visible });
  },

  _syncToneCursorToRect() {
    const rect = this._grid.rect;
    if (!rect) return;

    const w = rect.width || 0;
    const h = rect.height || 0;
    if (w <= 0 || h <= 0) return;

    const oldW = this._grid.lastWidth || w;
    const oldH = this._grid.lastHeight || h;

    if (this._grid.cursorX === 0 && this._grid.cursorY === 0) {
      this._grid.cursorX = w / 2;
      this._grid.cursorY = h / 2;
    } else if (oldW > 0 && oldH > 0 && (oldW !== w || oldH !== h)) {
      this._grid.cursorX = (this._grid.cursorX / oldW) * w;
      this._grid.cursorY = (this._grid.cursorY / oldH) * h;
    }

    this._grid.lastWidth = w;
    this._grid.lastHeight = h;

    this._grid.cursorX = Math.max(0, Math.min(w, this._grid.cursorX));
    this._grid.cursorY = Math.max(0, Math.min(h, this._grid.cursorY));

    this.setData({ xyCursorLeftPx: this._grid.cursorX, xyCursorTopPx: this._grid.cursorY });
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
      this.setData({ targetWidth: val });
      this._updateSliderUI();
      this._scheduleProcess();
    }
  },

  async _updateCursorFromClient(clientX, clientY) {
    // 实时获取rect，避免滚动后位置不准
    const rect = await selectRect(this, "#xyPadContainer");
    if (!rect) return;

    let x = clientX - rect.left;
    let y = clientY - rect.top;
    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));
    this._grid.cursorX = x;
    this._grid.cursorY = y;

    const nx = rect.width > 0 ? x / rect.width : 0.5;
    const ny = rect.height > 0 ? y / rect.height : 0.5;
    const toneX = nx * 2 - 1;
    const toneY = 1 - ny * 2;

    this._state.toneX = toneX;
    this._state.toneY = toneY;
    this.setData({ toneX, toneY, xyCursorLeftPx: x, xyCursorTopPx: y });

    this._scheduleProcess();
  },

  _scheduleProcess() {
    if (!this.data.hasImage || !this._state.palette || !this._canvas) return;

    if (this._isProcessing) {
      this._updatePending = true;
      return;
    }

    this._isProcessing = true;
    this._updatePending = false;

    setTimeout(() => {
      try {
        this._processImage();
      } finally {
        this._isProcessing = false;
        if (this._updatePending) this._scheduleProcess();
      }
    }, 0);
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

  _processImage() {
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

    switch (ditherAlgo) {
      case "floyd-steinberg":
        ditherErrorDiffusion(workImageData, palette, "floyd", this._state.isSerpentine);
        break;
      case "atkinson":
        ditherErrorDiffusion(workImageData, palette, "atkinson", this._state.isSerpentine);
        break;
      case "bayer-4x4":
        ditherBayer(workImageData, palette, 4);
        break;
      case "bayer-8x8":
        ditherBayer(workImageData, palette, 8);
        break;
      case "random":
        ditherRandom(workImageData, palette);
        break;
      default:
        ditherNearest(workImageData, palette);
        break;
    }

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

    const nextData = { mainCanvasCssW: displayW, mainCanvasCssH: displayH, canDownload: true };
    let needsLayoutUpdate = false;
    if (this._isMobile && !this._lockPreviewHeight) {
      const nextPreviewHeightPx = Math.max(1, displayH + previewPadding * 2 + previewBorder);
      if (Math.abs(nextPreviewHeightPx - this.data.previewHeightPx) > 1) {
        nextData.previewHeightPx = nextPreviewHeightPx;
        needsLayoutUpdate = true;
      }
    }

    this.setData(nextData, () => {
      if (needsLayoutUpdate) this._updateLayout();
    });

    const dpr = this._dpr;
    this._canvas.main.node.width = Math.max(1, Math.floor(displayW * dpr));
    this._canvas.main.node.height = Math.max(1, Math.floor(displayH * dpr));
    const mainCtx = this._canvas.main.ctx;
    mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mainCtx.imageSmoothingEnabled = false;
    mainCtx.clearRect(0, 0, displayW, displayH);
    mainCtx.drawImage(this._canvas.work.node, 0, 0, displayW, displayH);
  },

  onToggleTheme() {
    const next = this.data.themeClass === "theme-dark" ? "light" : "dark";
    wx.setStorageSync("pixelizer_theme", next);
    this.setData({
      themeClass: next === "dark" ? "theme-dark" : "theme-light",
      closeIconSrc: next === "dark" ? "/assets/icons/close-dark.svg" : "/assets/icons/close-light.svg"
    });
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

      this._state.imageToken += 1;
      this._state.originalImage = img;
      this._state.imageInfo = info;

      this._proc.scaled = { token: 0, w: 0, h: 0, data: null };
      this._proc.toneStats = { token: 0, w: 0, h: 0, stats: null };
      this._proc.work = { w: 0, h: 0, imageData: null };

      const orientedW = isRotate90(info.orientation) ? info.height : info.width;
      const orientedH = isRotate90(info.orientation) ? info.width : info.height;
      const aspect = orientedW > 0 ? orientedH / orientedW : img.height / img.width;

      let nextPreviewHeightPx = this.data.previewHeightPx;
      let nextMainCanvasCssW = this.data.mainCanvasCssW;
      let nextMainCanvasCssH = this.data.mainCanvasCssH;
      if (this._isMobile) {
        const box = this._computeMobilePreviewBox(aspect);
        nextPreviewHeightPx = box.previewHeightPx;
        nextMainCanvasCssW = box.displayW;
        nextMainCanvasCssH = box.displayH;
        this._lockPreviewHeight = true;
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

          const delayMs = this._isMobile ? 360 : 0;
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

    if (this._canvas) {
      this._canvas.main.ctx.clearRect(0, 0, this._canvas.main.node.width, this._canvas.main.node.height);
      this._canvas.work.ctx.clearRect(0, 0, this._canvas.work.node.width, this._canvas.work.node.height);
      this._canvas.buffer.ctx.clearRect(0, 0, this._canvas.buffer.node.width, this._canvas.buffer.node.height);
    }

    const headerVisible = this._isMobile ? true : this.data.headerVisible;
    this.setData({ hasImage: false, canDownload: false, headerVisible, fullscreenVisible: false, fullscreenSrc: "" });
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
    this._updateValueFromClientX(t.clientX);
  },

  onSliderTouchEnd() {
    if (!this.data.sliderDragging) return;
    this.setData({ sliderDragging: false });
  },

  async onXYTouchStart(e) {
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;

    this._grid.dragging = true;
    await this._updateCursorFromClient(t.clientX, t.clientY);
  },

  async onXYTouchMove(e) {
    if (!this._grid.dragging) return;
    const t = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!t) return;
    await this._updateCursorFromClient(t.clientX, t.clientY);
  },

  onXYTouchEnd() {
    if (!this._grid.dragging) return;
    this._grid.dragging = false;
  },

  async onResetTone(options) {
    const skipProcess = options && options.skipProcess;
    const rect = await selectRect(this, "#xyPadContainer");
    if (!rect) return;

    this._state.toneX = 0;
    this._state.toneY = 0;

    this._grid.cursorX = rect.width / 2;
    this._grid.cursorY = rect.height / 2;
    this.setData(
      { toneX: 0, toneY: 0, xyCursorLeftPx: this._grid.cursorX, xyCursorTopPx: this._grid.cursorY },
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
    exportCanvas.ctx.setTransform(1, 0, 0, 1, 0, 0);
    exportCanvas.ctx.imageSmoothingEnabled = false;
    exportCanvas.ctx.clearRect(0, 0, exportW, exportH);
    exportCanvas.ctx.drawImage(this._canvas.work.node, 0, 0, exportW, exportH);

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
    try {
      const tmp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: this._canvas.main.node,
          fileType: "png",
          success: resolve,
          fail: reject
        });
      });

      wx.previewImage({
        current: tmp.tempFilePath,
        urls: [tmp.tempFilePath]
      });
    } catch {
      wx.showToast({ title: "预览失败", icon: "none" });
    }
  },

  onCloseFullscreen() {
    this.setData({ fullscreenVisible: false, fullscreenSrc: "" });
  }
});
