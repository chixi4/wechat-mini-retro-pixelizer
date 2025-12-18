# 《八比特复古.html》转微信小程序实现文档（高一致性：功能一致 + 手感尽量一致）

目标：把当前仓库内的 `八比特复古.html`（Retro Pixelizer Pro）迁移为微信小程序原生页面，功能与输出结果一致，UI 在小程序端尽最大可能做到视觉/交互一致。

> 先说明一个客观边界：小程序的渲染（WXML/WXSS）、字体、布局引擎、Canvas 实现与浏览器并非 100% 等价，因此“所有设备上像素级 UI 完全一致”在工程上不可承诺。但**图像算法输出**（像素值）与**同一设备/同一字号下的布局**可以做到高度一致；若你对 UI 也要求绝对一致，文末提供 `web-view` 兜底方案。

---

## 1. 原 HTML 功能拆解（对照迁移目标）

`八比特复古.html` 由三大块组成：

1) **UI 结构**
- 顶部 Header：标题 + 主题切换按钮（`#themeToggle`）
- 左侧 Controls：
  - 上传图片（点击/拖拽，`#uploadArea`、`#fileInput`）
  - 像素宽度自定义滑块（`#widthSliderContainer`、`#widthSliderThumb`、`#widthDisplay`）
  - 影调 XY Pad（`#xyPadContainer` + `#xyGridCanvas`）
  - 抖动算法选择（`#ditherGrid`）
  - 调色板列表（`#paletteList`，JS 动态生成）
  - 下载按钮（`#downloadBtn`）
- 右侧 Preview：
  - 关闭按钮（`#closeImageBtn`，SVG “X”）
  - 主预览画布（`#mainCanvas`，点击进入全屏预览）
- 全屏预览 Modal（`#fullscreenModal` + `#fullscreenImage`）

2) **核心图像管线（Canvas + 像素处理）**
- 读入图片 -> 缩放到 `targetWidth x targetHeight`
- 影调动态映射 `applyDynamicToneMapping()`
- 抖动/量化：Atkinson / Floyd / Bayer 4x4 / Bayer 8x8 / Random / None
- 输出像素画布 `state.lastOutput`（真实分辨率）并绘制到显示画布（放大显示）

3) **状态/交互**
- 主题：用 `localStorage` 保存 `pixelizer_theme`
- 手机端滚动逻辑：控制区滚动触发 header 显隐（浏览器版）
- 关闭图片时清理缓存与画布
- 下载：用 `toDataURL` 导出 PNG（按最小宽度 2000 进行整数倍放大导出）

迁移到小程序后，需要把上述每一项在小程序能力内找到等价实现。

---

## 2. 小程序侧“尽量一致”的验收标准（v2 修订，避免不成立的承诺）

为了避免“完美”理解偏差，按严格程度分层验收：

### A. 功能一致（必须达成）
- 上传/关闭、像素宽度滑块（`32..640 step=4`）、影调 XY Pad（`HIT_RADIUS=44`）、抖动算法、调色板、主题切换、导出、全屏预览：行为与原 HTML 一致
- 竖屏模式下那段“控制区滚动 + 下拉手势 + Header/预览区/叉号联动”的状态机与动画联动一致（见第 13 节）
- 导出策略一致：`minWidth=2000`，整数倍放大导出，关闭平滑

### B. 严格像素一致（同端严格，带前提）
导出 PNG 做像素 diff，逐点 RGBA 完全一致；只在以下前提下作为硬验收：
- 不使用 `random` 抖动；或启用固定种子随机（见第 14.2 节）
- 同一设备/同一基础库/同一 JS 引擎（或至少同一 Canvas 与图片解码实现）
- 缩放步骤采用同一确定性策略（见第 14.1 节：严格缩放 vs 快速缩放）

### C. 跨设备高度一致（现实验收）
跨设备/跨基础库允许极小差异（常见来源：浮点数学、图片重采样内核、图片解码/色彩管理差异）：
- 建议口径：`max(|ΔR|,|ΔG|,|ΔB|) <= 1` 的像素占比 ≥ 99.99%（阈值可调整）
- 默认把 `random` 算法排除在“像素一致性”验收之外（除非固定种子）

如果你真的要求 C（跨设备也要“像素级完全一致”），建议直接使用 `web-view` 承载该 HTML（见第 10 节）。

---

## 3. 项目初始化与目录规划（建议方案）

当前目录只有 `project.config.json` 和 `八比特复古.html`。建议把小程序工程补齐，并把算法拆成模块，便于验证“输出一致”。

推荐结构（示例）：

```
miniprogram/
  app.json
  app.js
  app.wxss
  pages/pixelizer/
    index.wxml
    index.wxss
    index.js
    index.json
  utils/pixelizer/
    palettes.js
    core.js
    tone.js
    dither.js
    export.js
  assets/icons/
    close.svg
```

同时建议在 `project.config.json` 增加：
- `miniprogramRoot`: `"miniprogram/"`

（否则 DevTools 可能找不到 `app.json`。）

---

## 4. 页面结构从 HTML -> WXML 的映射

### 4.1 顶层容器
HTML：`<div class="page" id="pageContainer"> ...`

WXML：用根 `<view class="page {{themeClass}}"> ...`

注意：
- 小程序没有 `body/html`；全局样式写在 `app.wxss`，页面局部写在 `pages/pixelizer/index.wxss`
- 原 CSS 里大量使用 `:root` 和 `var(--xxx)`，WXSS 不建议依赖 CSS 变量（兼容性不可控），建议改为**主题 class 覆盖法**（见第 5 节）

### 4.2 Header
HTML：
- `#headerRef`：标题 + `#themeToggle`

WXML：
- `<view class="header {{headerVisible ? 'visible' : ''}}">`
- 主题按钮建议用自定义 `<view>` 模拟（不要用原生 `<button>` 的默认样式），避免平台差异

### 4.3 Controls（左侧控制栏）
HTML：`<aside class="controls"> ...`，内部存在滚动条与分区 panel

WXML：
- 使用 `<scroll-view scroll-y class="controls" bindscroll="onControlsScroll"> ...`
- 每个 panel 用 `<view class="panel">`，标题 `<view class="panel-title">`

替代能力：
- 拖拽上传：小程序无浏览器拖拽，直接移除；保留“点击上传”
- `input type=file`：用 `wx.chooseImage()` / `wx.chooseMedia()`

### 4.4 预览区 Preview
HTML：右侧 `<canvas id="mainCanvas">` + 关闭按钮 + “无图提示”伪元素 `.canvas-container::after`

WXML：
- `<view class="preview-area">`
- `<view class="canvas-container">`
  - 关闭按钮 `<view class="close-btn" bindtap="onCloseImage">`
  - 主画布 `<canvas type="2d" id="mainCanvas" class="main-canvas" bindtap="onOpenFullscreen">`
  - “无图提示”用真实节点实现：`<view wx:if="{{!hasImage}}" class="empty-hint">点击左侧上传图片</view>`

### 4.5 全屏预览
HTML：`#fullscreenModal` + `#fullscreenImage`

小程序等价有两种：
1) **完全复刻 modal**（样式一致）：`<view class="fullscreen-modal" wx:if="{{fullscreenVisible}}" catchtap="onCloseFullscreen"> <image ... /> </view>`
2) **系统预览**（手势更好，UI 不完全一致）：`wx.previewImage({ urls: [tempFilePath] })`

若目标是 UI 最像原版，选 1；若目标是更顺手，选 2。

---

## 5. 样式（CSS -> WXSS）迁移策略（保证“最像”且可维护）

原 CSS 关键点：
- CSS 变量：`--bg/--fg/--border/...`，并通过 `[data-theme="dark"]` 覆盖
- `display: grid`、`gap`、`min()`、滚动条伪元素、`vh`/`calc()`、`::after` 提示等

### 5.1 主题变量的等价实现（推荐：主题 class 覆盖）
小程序中用 `themeClass = 'theme-light' | 'theme-dark'`，根节点带上 class：

```wxml
<view class="page {{themeClass}}">
```

然后在 WXSS 中写两套变量“展开后的样式”：
- `.theme-light .header { background: #fff; color:#000; }`
- `.theme-dark  .header { background: #111; color:#eee; }`

这样不依赖 `var()`，也不依赖 `data-theme` 属性选择器兼容性。

主题存储：
- HTML：`localStorage.getItem('pixelizer_theme')`
- 小程序：`wx.getStorageSync('pixelizer_theme') / wx.setStorageSync(...)`

#### 5.1.1 WXSS 示例（建议直接从这里起步）
下面给一份“能落地、便于对齐原 HTML 风格”的最小 WXSS 骨架（按需补全到 panel / button / canvas 等）：

```wxss
.page {
  height: 100vh;
  overflow: hidden;
  font-family: "Courier New", ui-monospace, SFMono-Regular, monospace;
  font-size: 13px;
  line-height: 1.5;
}

.page.theme-light {
  background: #ffffff;
  color: #000000;
}
.page.theme-dark {
  background: #111111;
  color: #eeeeee;
}

.header {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 2px solid currentColor;
}

.theme-btn {
  border: 1px solid currentColor;
  padding: 6px 10px;
}

.main {
  height: 100%;
  display: flex;
  flex-direction: row;
}

.controls {
  width: 340px; /* 大屏参考值；移动端用 @media 覆盖 */
  height: 100%;
}

.preview-area {
  flex: 1;
  height: 100%;
}

/* 竖屏小屏：页面不滚动，只让 controls 滚动；预览区 fixed（高度/位移建议用 JS 下注入 style） */
@media (max-width: 768px) {
  .main { flex-direction: column; }
  .controls { width: 100%; }
  .header {
    position: fixed;
    top: 0; left: 0; right: 0;
    transform: translateY(-100%);
    transition: transform 300ms ease-out;
    z-index: 200;
  }
  .header.visible { transform: translateY(0); }
  .preview-area {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 100;
  }
}
```

#### 5.1.2 Grid -> Flex 的转换规则（写代码时按这个翻译）
- 原 `.main` 的 `grid-template-columns: 340px 1fr` -> 小程序：`.main{display:flex}` + `.controls{flex:0 0 340px}` + `.preview-area{flex:1}`
- 原 `gap` -> 用相邻元素 `margin-right/margin-bottom` 替代（避免依赖 `gap` 支持）
- 原“无图提示”的 `::after` -> 改成真实节点 `empty-hint`，用 `wx:if` 控制显隐

### 5.2 Grid / gap 的替换
WXSS 对 CSS Grid、gap 的支持不稳定，建议全部改为 flex + margin：
- `.main { display:flex; }`
- 控制栏和预览区：用 `flex-direction: row`（大屏）或 column（小屏）
- `gap: 24px` 替换为子元素 `margin-right/margin-bottom`

### 5.3 `::after`、滚动条伪元素的替换
- `.canvas-container::after`：用真实 `<view class="empty-hint">` 节点
- `::-webkit-scrollbar`：小程序不需要/不支持，忽略

### 5.4 `vh` / `calc()` 的替换（想“尽量一致”建议用 JS 计算）
HTML 的移动端布局大量依赖：
- `40vh/35vh`
- `--mobile-header-h` + `calc()`

小程序要做到一致，建议：
- `onReady` 里用 `wx.getSystemInfoSync()` 得到 `windowHeight`
- `createSelectorQuery()` 测量 header 高度
- 用 `data` 下发 `previewHeightPx`、`controlsPaddingTopPx`，在 WXML 上用 `style="{{...}}"`

这样可复刻 HTML 的“header 显隐时，预览区与控制区 padding/transform 跟随变化”的效果。

---

## 6. 图片输入：FileReader/Image -> wx.chooseImage + canvas.createImage

HTML 流程：
- `FileReader.readAsDataURL()` -> `new Image()` -> `img.onload`

小程序建议流程：
1) 选择图片：
- `wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album','camera'] })`
2) 拿到 `tempFilePath`
3) 在 2D Canvas 上创建图片对象：
- `const img = canvasNode.createImage(); img.src = tempFilePath; await onload`

注意点（为了输出一致）：
- **不要**用 `<image>` 渲染后再截图来处理，会引入缩放/色彩差异
- 直接使用 Canvas 的 Image 对象绘制，再 `getImageData`，与浏览器路径最接近

### 6.1 选图链路差异（iOS/Android/机型差异）与建议
- `wx.chooseImage({ sizeType:['original'] })` 在部分机型/路径仍可能返回被压缩图片：建议同时评估 `wx.chooseMedia({ mediaType:['image'], sizeType:['original'] })`
- 建议对用户/测试开一个“严格模式”开关：严格模式下先用 `wx.getImageInfo` 校验分辨率与方向，并在 UI 提示“图片可能被压缩/带方向信息”
- 你在意“输出尽量像”的情况下：宁可在读入阶段统一口径（尺寸/方向），不要在后处理中补救

### 6.2 输入尺寸上限建议（防崩溃/防内存爆）
小程序端做 `getImageData` 时，内存压力来自：`w*h*4` 的 RGBA 数组（且往往会有多份拷贝）。
- 建议默认限制：`MAX_INPUT_SIDE = 4096`，`MAX_INPUT_PIXELS = 8_000_000`（约 32MB 的单份 RGBA；低端机可再收紧）
- 触发超限时的策略：先按比例缩小再进入管线（缩小发生在“绘制到 bufferCanvas”阶段）

（具体实现写法见第 16 节。）

---

## 7. Canvas 迁移：浏览器 Canvas -> 小程序 Canvas 2D（关键）

### 7.1 必须使用 `type="2d"` 的 Canvas
WXML：
```wxml
<canvas type="2d" id="mainCanvas" class="main-canvas"></canvas>
<canvas type="2d" id="xyGridCanvas" class="xy-grid"></canvas>
```

JS 初始化（核心要点）：
- `createSelectorQuery().select('#mainCanvas').fields({ node:true, size:true })`
- 获取 `node` 后：`const ctx = node.getContext('2d')`
- 按 DPR 设置真实像素尺寸：
  - `node.width  = size.width  * dpr`
  - `node.height = size.height * dpr`
  - `ctx.scale(dpr, dpr)`

这一步决定了你能否做到：
- 预览清晰
- XY Grid 的 hit test/绘制坐标一致
- 输出像素不被二次缩放污染

### 7.4 DPR 适配与 px/rpx 坐标统一（解决“安卓各厂商 DPR 差异”）
结论先说：**各厂商 DPR 不需要“抹平”**，你只要始终使用系统返回的 `pixelRatio` 来设置 canvas 像素尺寸，并把交互阈值统一到“px 坐标系”，手感就能一致。

> 说明：这段属于“能不能像”的关键实现细节，所以放在 `7.1` 后面（尽管编号是 7.4）。

推荐写法（2D canvas node）：
```js
function init2dCanvas(id, cb) {
  const sys = wx.getSystemInfoSync();
  const dpr = Number(sys.pixelRatio) || 1;

  wx.createSelectorQuery()
    .select(id)
    .fields({ node: true, size: true })
    .exec((res) => {
      const node = res && res[0] && res[0].node;
      const size = res && res[0];
      if (!node) throw new Error('Canvas node not found');

      const w = size.width;
      const h = size.height;
      node.width = Math.round(w * dpr);
      node.height = Math.round(h * dpr);

      const ctx = node.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset + scale

      cb({ node, ctx, cssWidth: w, cssHeight: h, dpr });
    });
}
```

px/rpx 换算（只用于把 UI 尺寸/命中阈值统一成 px；命中计算一律用 px）：
```js
const sys = wx.getSystemInfoSync();
const rpxToPx = (rpx) => (Number(rpx) * sys.windowWidth) / 750;
```

selectorQuery 性能建议（避免“到处测量导致掉帧”）：
- 能一次 `exec` 拿到的（header/mainCanvas/xyCanvas 的 rect/size），就不要分多次调用
- 除非窗口尺寸变化，否则把 rect/size 缓存在页面对象里复用

批量测量示例（同一次 exec）：
```js
wx.createSelectorQuery()
  .select('#headerRef').boundingClientRect()
  .select('#mainCanvas').fields({ node: true, size: true })
  .select('#xyGridCanvas').fields({ node: true, size: true })
  .exec((res) => {
    const headerRect = res[0];
    const main = res[1];
    const grid = res[2];
    // cache them
  });
```

### 7.5 旧基础库兜底：`canvas-id` + `wx.canvasGetImageData/PutImageData`
如果拿不到 2D canvas node（`fields({node:true})` 不返回 node），兜底链路是：
- 绘制：`const ctx = wx.createCanvasContext('mainCanvas', this)`
- 像素读写：`wx.canvasGetImageData({ canvasId, x,y,width,height, success })` / `wx.canvasPutImageData(...)`

兜底链路的注意点：
- 全是异步回调，且更慢；要把“处理节流/防抖”做得更激进
- 旧链路下更容易卡顿：建议默认降低 `targetWidth` 上限（例如 320 或 256）

### 7.2 复刻 HTML 的“显示放大但像素结果不变”
HTML：
- 真正结果在 `pixelCanvas`（`targetWidth x targetHeight`）
- 显示画布 `mainCanvas` 用整数 `displayScale` 放大绘制，并关闭平滑

小程序保持同样结构：
- `pixelCanvas`：用 `wx.createOffscreenCanvas({type:'2d', width, height})`（若不可用，则用隐藏 canvas 代替）
- `displayCanvas`：页面上的 `#mainCanvas`，只负责展示
- 设置 `displayCtx.imageSmoothingEnabled = false`

### 7.3 影调/抖动算法迁移原则：**算法代码原样搬**
为保证输出一致：
- `applyDynamicToneMapping()`、`computeToneStats()`、`dither*()`、`nearestPaletteIndex()` 等函数保持字节级一致（只改外部 I/O）
- 保持所有常量（如 `PALETTE_CACHE_BITS`、`BAYER_STRENGTH`）不变
- 保持 `Uint8ClampedArray`、`ImageData` 的使用方式不变

建议把原 HTML `<script>` 中“纯算法部分”拆到 `utils/pixelizer/*.js`，页面仅负责：
- 读图
- 触发处理
- 把结果绘制/导出

---

## 8. 控件迁移细节（滑块 / XY Pad / 列表）

### 8.1 像素宽度滑块（custom slider）
HTML 自己实现滑块是为了“防误触”和 UI 一致。

小程序等价实现有两种：
1) **完全复刻**（推荐用于“尽量一致”）
- 用 `<view class="custom-slider" catchtouchstart ... catchtouchmove ...>` + `<view class="slider-thumb">`
- 在触摸事件中用 `touches[0].clientX`，结合容器 `boundingClientRect` 计算百分比
- 复刻原逻辑：`min=32, max=640, step=4`

2) 使用原生 `<slider>`（更省事，但 UI 很难完全一致）

### 8.2 影调 XY Pad（十字准星阵列）
HTML 用一个 canvas 画网格点与准星，并在拖动时更新 `toneX/toneY`。

小程序复刻要点：
- XY Pad 用 `#xyGridCanvas` 的 2D context 绘制（同样设置 DPR）
- 事件改成：
  - `bindtouchstart="onGridStart"`
  - `bindtouchmove="onGridMove"`（建议 `catchtouchmove` 防止滚动穿透）
  - `bindtouchend="onGridEnd"`
- hit test 与原版一致：保留 `HIT_RADIUS = 44`（单位按 CSS px；如果你用 rpx，需要换算回 px）
- `cursorX/cursorY` 与容器宽高一致（同样用 selectorQuery 测量）

### 8.3 调色板列表与算法按钮
HTML 用 DOM 动态创建按钮；小程序用数据驱动渲染：
- `palettes = [{ key, name, colors, count }]`（按 `colors.length` 排序）
- `ditherAlgos = [{key:'atkinson', label:'Atkinson'}, ...]`

点击：
- `bindtap="onSelectPalette" data-key="{{item.key}}"`
- `bindtap="onSelectAlgo" data-algo="{{item.key}}"`

选中态：
- 用 class 切换：`class="btn-toggle {{ditherAlgo===item.key?'active':''}}"`

---

## 9. 导出/保存：toDataURL -> canvasToTempFilePath + saveImageToPhotosAlbum

HTML 导出策略：
- 强制最小宽度 `minWidth=2000`
- `scale = ceil(minWidth / w)`，导出画布按整数倍放大并关闭平滑

小程序等价：
1) 在 export canvas 上按同样策略 `drawImage(lastOutput, 0,0, w*scale, h*scale)` 且 `imageSmoothingEnabled=false`
2) 导出临时文件：
- 新版 2D：`wx.canvasToTempFilePath({ canvas: exportCanvasNode, fileType:'png' })`
  - 兜底：`wx.canvasToTempFilePath({ canvasId: 'exportCanvas', fileType:'png' })`
3) 保存到相册：
- `wx.saveImageToPhotosAlbum({ filePath })`
- 需要处理权限：`scope.writePhotosAlbum`

提示：
- 保存权限被拒后要引导 `wx.openSetting()`
- iOS/Android 权限提示文案不同，建议封装 `ensureAlbumPermission()`
- 全屏预览不要每次点击都 `canvasToTempFilePath`：建议在每次处理完成后防抖生成一次临时文件并缓存（见第 17 节）

### 9.1 Canvas 尺寸限制与导出 scale 限幅（必须做，避免黑屏/失败）
小程序对 canvas 最大尺寸存在限制（常见安全值是 `4096px`，不同机型/基础库可能更低/更高）。如果原图纵横比极端，按 `minWidth=2000` 放大后可能让导出高度超限。

建议：在计算 `scale` 时加入 “max canvas side” 限幅（示例）：
```js
const MAX_CANVAS_SIDE = 4096; // 保守值：以不炸为主
const desiredScale = Math.ceil(minWidth / w);
const maxScaleW = Math.floor(MAX_CANVAS_SIDE / w);
const maxScaleH = Math.floor(MAX_CANVAS_SIDE / h);
const maxScale = Math.max(1, Math.min(maxScaleW, maxScaleH));
const scale = Math.max(1, Math.min(desiredScale, maxScale));
```

当 `scale < desiredScale` 时的处理建议（二选一）：
1) 保持 `scale`（保证导出成功），同时把实际导出宽度提示给用户（例如“已按设备限制导出到 1536px 宽”）
2) 降低 `minWidth`（把 `minWidth` 改成 `w * maxScale`），保证逻辑自洽

---

## 10. “真的要 100% UI 一致”的兜底：web-view 方案（可选）

如果你明确要求 UI 也要像素级一致（跨设备也一样），原生迁移会被平台差异卡死；此时建议：
- 小程序只做壳页面 + `web-view`
- 把 `八比特复古.html` 部署到 HTTPS 域名（并在小程序后台配置业务域名）
- 小程序页面用：
  - `<web-view src="https://your.domain/pixelizer.html"></web-view>`

优点：
- 浏览器渲染与原 HTML 完全一致
缺点：
- 需要域名备案与配置
- 与小程序能力交互需要 `postMessage` 桥接

---

## 11. 输出一致性验证（强烈建议做）

为了证明“同端严格一致 / 跨端高度一致”，建议做一个固定用例集：
1) 准备 3~5 张测试图（包含：人像、风景、纯色渐变、噪点图）
2) 固定 10 组参数（宽度、影调、算法、调色板）
3) HTML 导出一份 PNG 作为基准
4) 小程序导出同名 PNG
5) 用像素 diff 验证一致性（建议给出“严格/容差”两种口径）

### 11.1 推荐的可落地 diff 方案（不依赖第三方库）
最稳的做法是做一个“开发态 diff 页面/脚本”，在小程序内直接：
- 把“基准 PNG”（来自 HTML 导出）和“小程序导出 PNG”都绘制到 canvas
- `getImageData` 后逐像素统计：
  - `maxDelta = max(|ΔR|,|ΔG|,|ΔB|)`
  - `maxDelta<=1` 的像素占比

验收建议（可按你要求收紧）：
- 同端严格：`maxDelta==0` 占比 100%（random 关闭或固定 seed，且缩放策略一致）
- 跨端高度一致：`maxDelta<=1` 占比 ≥ 99.99%

### 11.2 如可使用 Node 工具（更省事，但需要安装依赖）
你也可以用 `pixelmatch`（像素 diff）+ `pngjs`（读写 png）做一键对比（示例思路）：
- `npm i pixelmatch pngjs`
- 写脚本读取两张 png -> `pixelmatch` -> 输出 diff 图与统计

（是否能安装依赖取决于你的环境与网络策略。）

### 11.3 测试图选择标准（避免“测了也白测”）
建议至少覆盖：
- **高对比硬边**（像素化与抖动最敏感）
- **平滑渐变**（Bayer/误差扩散最容易出差异）
- **高饱和色块**（调色板最近邻容易出边界差）
- **人像肤色**（tone mapping 的主观敏感区）
- **带 EXIF 方向的拍照图**（检验 orientation 校正）

如果出现差异，优先排查：
- Canvas DPR/scale 是否一致
- `imageSmoothingEnabled` 是否在所有绘制点都关闭/开启正确
- 小程序端是否走了“先渲染 <image> 再截图”的路径（会改变像素）
- 是否发生了颜色空间/alpha 预乘差异（本项目基本都是 opaque，可忽略）

---

## 12. 实施顺序（推荐里程碑）

1) 先把算法模块从 HTML 原样移植到 `utils/pixelizer/`，在小程序端跑通“输入->输出 PNG”
2) 做输出一致性验证（第 11 节），确保算法层完全一致
3) 再做 UI 复刻（样式、布局、主题、滑块、XY Pad）
4) 最后做移动端滚动/显隐的细节（header/closeBtn 行为）

---

## 13. 竖屏模式滚动与 UI 联动（重点：按 `setupMobileScrollLogic()` 等价复刻）

你在 `八比特复古.html` 的竖屏实现是一个“固定布局 + 单滚动源 + 状态机”的组合，迁移时要按行为逐条对齐。

### 13.1 布局对齐（HTML 的关键点）
- 页面本身固定不滚动：`.page` fixed + `height:100vh` + `overflow:hidden`
- 唯一可滚动区域：`.controls`（并设置 `overscroll-behavior-y: none`）
- 有图时：`.preview-area` fixed 顶部，`height:40vh`
- Header 默认隐藏在屏幕外（`translateY(-100%)`），`.visible` 后滑入
- Header 显示时：通过 `--mobile-header-h` 同步推动 preview 下移、并把 controls 的 `padding-top` 增加同等高度，避免“漏缝”
- close 叉号在手机端默认隐藏，只有 header `.visible` 且有图时才显示

### 13.2 小程序等价方案（推荐）
- 外层页面不滚动，只有一个 `<scroll-view class="controls" scroll-y>` 负责滚动
- 预览区用 fixed（或 absolute）布局，并把联动量用 px 数据化，不依赖 CSS 变量联动：
  - `headerHeightPx`：header 实测高度（px）
  - `previewHeightPx`：建议 `Math.floor(windowHeight * 0.40)`（对齐 40vh）
  - `previewTranslateYPx = headerVisible ? headerHeightPx : 0`
  - `controlsPaddingTopPx = base + (hasImage ? previewHeightPx : 0) + (headerVisible ? headerHeightPx : 0)`

### 13.3 状态机对齐（HTML 的行为规则）
关键变量与阈值：
- `TOP_EPS = 3`：到顶容差
- `dy >= 15`：认定为“下拉”
- `didScrollSinceLoad`：上传后是否向下滚动过（`scrollTop>5`）
- `armed / armedAtGesture / gestureId`：两段式防误触门槛（避免一到顶就误显示 header）
- 隐藏：向下滚动且 `scrollTop>100` 时隐藏 header（防闪）
- 关键修正：如果用户通过“向上滚动+惯性”滑回顶部且 header 隐藏，把这次视作第一次动作（`armed=true`），下一次下拉即可直接显示

### 13.4 小程序伪代码（建议按这个翻译）
```js
const TOP_EPS = 3;
const PULL_DY_MIN = 15;

let activeImageKey = null;
let armed = false;
let didScrollSinceLoad = false;
let lastScrollTop = 0;
let touchStartY = null;
let pulledThisGesture = false;
let gestureId = 0;
let armedAtGesture = -1;

function syncImageSession(currentImageKey) {
  if (currentImageKey === activeImageKey) return;
  activeImageKey = currentImageKey;
  armed = false;
  armedAtGesture = -1;
  didScrollSinceLoad = false;
  lastScrollTop = 0;
  hideHeader();
}

function onControlsScroll(scrollTop, currentImageKey) {
  if (!currentImageKey) return;
  syncImageSession(currentImageKey);

  const scrollingUp = scrollTop < lastScrollTop;
  lastScrollTop = scrollTop;
  if (scrollTop > 5) didScrollSinceLoad = true;

  if (didScrollSinceLoad && scrollingUp && scrollTop <= TOP_EPS && !isHeaderVisible()) {
    armed = true;
    armedAtGesture = gestureId;
  }

  if (!scrollingUp && scrollTop > 100 && isHeaderVisible()) hideHeader();
}

function onControlsTouchStart(clientY, currentImageKey) {
  if (!currentImageKey) return;
  gestureId += 1;
  touchStartY = clientY;
  pulledThisGesture = false;
}

function onControlsTouchMove(clientY, scrollTop, currentImageKey) {
  if (!currentImageKey) return;
  syncImageSession(currentImageKey);
  if (touchStartY == null) return;
  if (isHeaderVisible()) return;
  if (scrollTop > TOP_EPS) return;

  const dy = clientY - touchStartY;
  if (dy < PULL_DY_MIN) return;
  if (pulledThisGesture) return;
  pulledThisGesture = true;

  if (!didScrollSinceLoad) {
    showHeader();
    armed = false;
    armedAtGesture = -1;
    return;
  }

  if (!armed) {
    armed = true;
    armedAtGesture = gestureId;
    return;
  }

  if (armedAtGesture === gestureId) return;

  showHeader();
  armed = false;
  armedAtGesture = -1;
}

function onControlsTouchEnd() {
  touchStartY = null;
  pulledThisGesture = false;
}
```

### 13.5 性能注意（否则会掉帧）
- 不要在每个 `scroll/touchmove` 都 `setData`：只在状态切换或联动量变化时更新
- header 高度测量只在 `showHeader()` 前做一次（或节流），避免频繁 selectorQuery

### 13.6 你在意的“滑动手感”如何尽量做到像
要“像”，关键不是变量少，而是下面几件事必须对齐：
1) **单滚动源**：竖屏下只让 controls 滚动（不要 page 滚动、不要多 `scroll-view` 抢手势）。
2) **同一坐标系**：`scrollTop`、`TOP_EPS`、`dy>=15` 全都按 px 来理解与计算；避免 rpx 直接参与阈值与命中。
3) **同一门槛**：保留 `didScrollSinceLoad + armed + gestureId` 的两段式门槛（这是你 HTML 里用于“防误触/防闪”的体验设计）。
4) **同一动画节奏**：header/preview/controls 的联动位移要同时开始、同一时长、同一 easing（建议对齐 HTML：`0.3s ease-out`），否则主观上就会“不同步/不跟手/漏缝”。
5) **同一更新时机**：在 `showHeader()` 里先测量 headerHeight，再一次性更新 `headerVisible` 与联动量，避免先动后算导致抖动。

### 13.7 为什么会有“两次下拉才显示 header”（这是原实现特性）
审阅提到“两次下拉不直观”，但你 HTML 的真实实现就是两段式：
- 目的：避免用户只是回到顶端、或轻微下拉时就误触把 header 拉出来；同时配合 `scrollTop>100` 才隐藏，减少闪烁。
- 如果你要**复刻原体验**：必须保留这套门槛（`armed/gestureId/didScrollSinceLoad`）。
- 如果你更想**更直观**（允许与 HTML 略有差别）：可以改成“单次下拉 + 更大阈值”，例如 `dy>=30` 直接显示，同时保留 `scrollTop>100` 的隐藏防闪规则。

### 13.8 手感调参表（建议真机调到“像”）
- `TOP_EPS`：2~6（越大越容易认为“在顶端”）
- `PULL_DY_MIN`：12~30（越大越不误触，但更费力）
- `HIDE_SCROLLTOP`：80~140（越大越不容易隐藏，越不闪；但会显得“黏”）
- 动画：先从 `300ms ease-out` 开始对齐，再微调 240~360ms

### 13.9 简化模式（更直观，但会偏离原 HTML 的“两段式”体验）
如果你最终决定在小程序端不复刻“两段式 armed”，可以用“更直观”的规则：
- **下拉显示**：controls 顶部（`scrollTop<=TOP_EPS`）下拉 `dy>=PULL_DY_SHOW` 直接显示 header
- **滚动隐藏**：controls 向下滚动 `scrollTop>=HIDE_SCROLLTOP` 隐藏 header（防闪仍保留阈值）

参考实现（逻辑更短，但不保证与 HTML 手感完全一致）：
```js
const TOP_EPS = 3;
const PULL_DY_SHOW = 30;     // 简化模式建议更大阈值，减少误触
const HIDE_SCROLLTOP = 100;  // 仍建议保留防闪阈值

let lastScrollTop = 0;
let touchStartY = null;
let pulled = false;

function onControlsScroll(scrollTop) {
  const scrollingUp = scrollTop < lastScrollTop;
  lastScrollTop = scrollTop;
  if (!scrollingUp && scrollTop >= HIDE_SCROLLTOP) hideHeader();
}

function onControlsTouchStart(clientY) {
  touchStartY = clientY;
  pulled = false;
}

function onControlsTouchMove(clientY, scrollTop) {
  if (isHeaderVisible()) return;
  if (scrollTop > TOP_EPS) return;
  const dy = clientY - touchStartY;
  if (dy < PULL_DY_SHOW) return;
  if (pulled) return;
  pulled = true;
  showHeader();
}

function onControlsTouchEnd() {
  touchStartY = null;
  pulled = false;
}
```

---

## 14. 严格一致性的关键风险与对策（random / 缩放 / 浮点）

### 14.1 缩放一致性（决定“全管线是否一致”）
HTML 缩放阶段使用 `drawImage` 且设置了 `imageSmoothingQuality='high'`；小程序侧不保证支持该属性，且重采样内核可能不同。

建议提供两种模式：
- `fastScale`：直接 `drawImage(img, 0,0,targetW,targetH)`（性能更好，但跨端不保证一致）
- `strictScale`：先获取原图像素，再用 JS 实现确定性缩放（固定点 bilinear/box），使缩放结果可控（更慢，但更接近“严格一致”目标）

### 14.2 random 的确定性（可选）
默认：`random` 不纳入严格像素一致性验收。

如需可复现：用固定种子 PRNG 替换 `Math.random()`：
```js
function makeXorshift32(seed) {
  let x = (seed >>> 0) || 0x12345678;
  return function next() {
    x ^= (x << 13) >>> 0;
    x ^= (x >>> 17) >>> 0;
    x ^= (x << 5) >>> 0;
    return (x >>> 0) / 4294967296;
  };
}
```
seed 来源必须在项目里写死规则（例如固定 seed 用于对齐测试；或 seed = hash(图片内容) ^ 参数组合）。

### 14.3 浮点数学容差（tone mapping）
`applyDynamicToneMapping()` 使用大量 `log/exp/pow`，跨引擎可能出现边界舍入差异：
- 同端严格 diff 可作为硬验收
- 跨端建议采用第 2.3 节的容差验收

---

## 15. 基础库能力矩阵（补齐版本/兜底思路）

以能力探测为准；版本号只作为参考（需你在目标机型上验证）。

| 功能 | 参考最低基础库 | 推荐路径 | 兜底路径 |
|---|---:|---|---|
| `<canvas type="2d">` | ~2.9.0 | 2D canvas node | `canvas-id` |
| OffscreenCanvas | ~2.16.1 | `wx.createOffscreenCanvas` | 隐藏 canvas 节点 |
| `canvasToTempFilePath({canvas})` | ~2.9.0 | 传 `canvas` node | 传 `canvasId` |

---

## 16. 图片输入一致性（压缩/EXIF/方向）

### 16.1 压缩/尺寸差异：必须“先检测再处理”
- 选图后先跑一遍 `wx.getImageInfo({ src })`（拿 `width/height/type/orientation`），并在 UI 里展示真实分辨率，避免用户误以为是原图
- 同时评估：
  - `wx.chooseImage({ sizeType:['original'] })`
  - `wx.chooseMedia({ mediaType:['image'], sizeType:['original'] })`
- 如果你要“尽量像”：建议提供“严格模式”开关，在严格模式里遇到疑似压缩（分辨率异常偏小）时提示用户重新选择

### 16.2 EXIF orientation：给出可直接用的处理函数
原则：把 orientation 统一到“up”，再进入后续缩放/影调/抖动管线；否则“同一张拍照图”在不同端可能方向不同，输出自然不可能一致。

WeChat `wx.getImageInfo` 常见 `orientation` 字符串（不同基础库可能略有差异）：  
`up/down/left/right/up-mirrored/down-mirrored/left-mirrored/right-mirrored`

在“绘制到 bufferCanvas（目标尺寸）”时做方向修正（示例）：
```js
function isSwapWH(orientation) {
  return orientation === 'left' || orientation === 'right' ||
         orientation === 'left-mirrored' || orientation === 'right-mirrored';
}

function drawImageWithOrientation(ctx, img, orientation, w, h) {
  ctx.save();
  // 注意：ctx 在 init 时已经 setTransform(dpr,0,0,dpr,0,0)，这里按 CSS px 坐标系写
  switch (orientation) {
    case 'up':
    default:
      ctx.drawImage(img, 0, 0, w, h);
      break;
    case 'down':
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
      ctx.drawImage(img, 0, 0, w, h);
      break;
    case 'right': // 90° CW
      ctx.translate(w, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0, h, w);
      break;
    case 'left': // 90° CCW
      ctx.translate(0, h);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(img, 0, 0, h, w);
      break;
    case 'up-mirrored':
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, w, h);
      break;
    case 'down-mirrored':
      ctx.translate(0, h);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0, w, h);
      break;
    case 'right-mirrored': // mirror + 90° CW
      ctx.translate(w, 0);
      ctx.rotate(Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, h, w);
      break;
    case 'left-mirrored': // mirror + 90° CCW
      ctx.translate(0, h);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, h, w);
      break;
  }
  ctx.restore();
}
```

尺寸计算（用于正确的纵横比与后续 `targetHeight`）：
```js
function getOrientedSize(w, h, orientation) {
  return isSwapWH(orientation) ? { w: h, h: w } : { w, h };
}
```

### 16.3 图片尺寸上限 + 内存策略（低端机必须有）
建议你把“输入尺寸限制”与“处理尺寸限制”分开：
- 输入图片（解码后的原始尺寸）建议限制：`MAX_INPUT_SIDE = 4096`
- 输入像素总量建议限制：`MAX_INPUT_PIXELS = 8_000_000`（约 32MB/份 RGBA；低端机可收紧到 6_000_000）

超限策略：在“画到 bufferCanvas”时先做一次按比例降采样，再进入算法管线（不是拒绝用户）。

另外，为了避免 GC 抖动与内存峰值：
- 复用 `Uint8ClampedArray` / `ImageData`（你 HTML 里已经做了 `proc.work` 复用，这个思想要保留）
- 关闭图片时把 bufferCanvas 的 `width/height` 设回 0（释放图形内存），并清空对大数组的引用（你 HTML 的 closeImage 已经做了）

### 16.4 性能：tone mapping/抖动可选 worker（有则上，无则节流）
小程序支持 `wx.createWorker`（worker 不能操作 canvas，但可以处理像素数组），你可以把：
- `applyDynamicToneMapping`
- `dither*`
放到 worker 里做，主线程只负责 `getImageData/putImageData` 与 UI。

一个“可落地的最小骨架”（你只需要把算法函数引入 worker 文件即可）：

主线程（page 层）：
```js
const canUseWorker = typeof wx.createWorker === 'function';
const worker = canUseWorker ? wx.createWorker('workers/pixelizer.js') : null;
let jobSeq = 0;

function runPixelJobInWorker(imageData, params) {
  if (!worker) return Promise.reject(new Error('worker not available'));
  const id = ++jobSeq;
  const payload = {
    id,
    width: imageData.width,
    height: imageData.height,
    buffer: imageData.data.buffer,
    params,
  };

  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (!msg || msg.id !== id) return;
      worker.offMessage(onMsg);
      if (msg.error) return reject(new Error(msg.error));
      const out = new Uint8ClampedArray(msg.buffer);
      resolve(new ImageData(out, msg.width, msg.height));
    };
    worker.onMessage(onMsg);
    worker.postMessage(payload);
  });
}
```

worker（`miniprogram/workers/pixelizer.js` 示例骨架）：
```js
// 在 worker 里引入你的算法模块（tone/dither/nearest/palette）
// const { applyDynamicToneMapping, ditherNearest, ... } = require('../utils/pixelizer/...');

worker.onMessage((msg) => {
  try {
    const data = new Uint8ClampedArray(msg.buffer);
    // 在这里对 data 做 tone + dither（就地修改）
    // applyDynamicToneMapping({ data, width: msg.width, height: msg.height }, ...)
    // dither...( { data, width, height }, palette )
    worker.postMessage({ id: msg.id, width: msg.width, height: msg.height, buffer: data.buffer });
  } catch (e) {
    worker.postMessage({ id: msg.id, error: String(e && e.message || e) });
  }
});
```

注意：
- worker 的消息传递是否支持“零拷贝转移”取决于基础库实现；如果发现拷贝开销太大，优先回退到主线程节流方案。
- worker 只建议用于“拖动频繁触发”的场景（滑块/XY Pad），点按切换算法/调色板通常不需要。

如果不做 worker：至少要保留 HTML 的 `isProcessing + updatePending` 节流模式，并在滑块/XY Pad 拖动中降低触发频率（例如 16ms~33ms 合并一次）。

---

## 17. 全屏预览性能（避免每次点击都导出）

低端机上每次点击全屏都 `canvasToTempFilePath` 会卡顿；建议：
- 每次 `processImage` 完成后防抖生成一次 `previewTempFilePath` 并缓存
- 全屏预览直接使用缓存（modal `<image>` 或 `wx.previewImage`）

---

## 18. DOM/浏览器 API -> 小程序 API 对照表（合并补充）

- `document.getElementById(...)` / `querySelector(...)`
  - UI 渲染：改为 WXML 数据驱动（`this.setData` + `wx:if/wx:for`）
  - DOM 测量/拿 canvas node：`wx.createSelectorQuery().select('#id').fields({ node:true, size:true, rect:true })`
- `element.classList.add/remove/toggle`
  - 改为：`this.setData({ someFlag: true/false })`，WXML 用 `class="{{someFlag ? 'xxx' : ''}}"`
- `addEventListener('click')`
  - 改为：WXML `bindtap="handler"`
- `addEventListener('touchstart/touchmove/touchend')`
  - 改为：WXML `bindtouchstart` / `catchtouchmove` / `bindtouchend`
  - 需要阻止滚动穿透：用 `catchtouchmove`
- `localStorage.getItem/setItem`
  - 改为：`wx.getStorageSync / wx.setStorageSync`
- `window.innerWidth/innerHeight`
  - 改为：`wx.getSystemInfoSync().windowWidth/windowHeight`
- `window.addEventListener('resize')`
  - 优先：在 `onReady/onShow` 和关键交互后重新测量
  - 需要实时监听时：尝试 `wx.onWindowResize`
- `requestAnimationFrame`
  - 可保留（部分环境可用），但建议封装为 `scheduleProcess()` 并用 `setTimeout(fn, 0)` 节流兜底
- `<input type="file">` + `FileReader`
  - 改为：`wx.chooseImage()` / `wx.chooseMedia()`
- `new Image()`
  - 改为：`canvasNode.createImage()`（2D Canvas node）
- `canvas.toDataURL()` + `<a download>`
  - 改为：`wx.canvasToTempFilePath()` + `wx.saveImageToPhotosAlbum()`

---

## 19. 页面骨架（合并补充，照抄可落地）

### 19.1 `pages/pixelizer/index.wxml`（骨架）
```xml
<view class="page {{themeClass}}">
  <view class="header {{headerVisible ? 'visible' : ''}}" id="headerRef">
    <view class="title">Retro Pixelizer Pro</view>
    <view class="theme-btn" bindtap="onToggleTheme">◐</view>
  </view>

  <view class="main {{hasImage ? 'has-image' : ''}}" id="mainContainer">
    <scroll-view class="controls" scroll-y
                 bindscroll="onControlsScroll"
                 catchtouchstart="onControlsTouchStart"
                 catchtouchmove="onControlsTouchMove"
                 bindtouchend="onControlsTouchEnd">
      <!-- 这里按原 HTML panel 顺序放：上传、滑块、XY Pad、算法、调色板、导出 -->
    </scroll-view>

    <view class="preview-area">
      <view class="canvas-container">
        <view class="close-btn {{closeVisible ? 'visible' : ''}}" bindtap="onCloseImage">
          <image src="/assets/icons/close.svg" mode="aspectFit"></image>
        </view>
        <canvas type="2d" id="mainCanvas" class="main-canvas" bindtap="onOpenFullscreen"></canvas>
        <view wx:if="{{!hasImage}}" class="empty-hint">点击左侧上传图片</view>
      </view>
    </view>
  </view>

  <view wx:if="{{fullscreenVisible}}" class="fullscreen-modal" catchtap="onCloseFullscreen">
    <image class="fullscreen-image" src="{{fullscreenSrc}}" mode="widthFix"></image>
  </view>
</view>
```

### 19.2 `pages/pixelizer/index.js`（骨架）
```js
Page({
  data: {
    themeClass: 'theme-light',
    headerVisible: true,
    closeVisible: false,
    hasImage: false,

    fullscreenVisible: false,
    fullscreenSrc: '',

    targetWidth: 128,
    ditherAlgo: 'atkinson',
    paletteKey: 'dreamscape8',
    toneX: 0,
    toneY: 0,

    // 竖屏联动量（px）
    headerHeightPx: 0,
    previewHeightPx: 0,
    controlsPaddingTopPx: 0,
    previewTranslateYPx: 0,
  },

  async onReady() {
    // initTheme -> initLayoutMetrics -> initCanvasNodes -> initPalettes -> drawGrid
  },
});
```

---

## 20. 迁移时最容易踩坑（合并补充 + v2 新增）

1) Canvas 没按 DPR 设置真实像素：预览模糊、坐标误差、导出差异
2) 平滑开关时机错误：放大绘制前必须 `imageSmoothingEnabled=false`
3) rpx/px 混用导致 hit test 失真：XY Pad 的 `HIT_RADIUS=44` 建议在 px 坐标体系下使用
4) 内联 SVG 不可用：把 SVG 抽成文件用 `<image>` 引用
5) 伪元素提示不可控：`.canvas-container::after` 建议改成真实节点
6) 相册权限没处理：被拒后要引导 `wx.openSetting()`
7) nested scroll 翻车：尽量避免 `scroll-view` 嵌套
8) 选图仍可能压缩 + EXIF 方向未统一：会导致全管线输出不一致
9) 全屏预览每次导出导致卡顿：缓存 `previewTempFilePath`
10) canvas 尺寸超限（常见安全值 `4096px`）：导出/极端纵横比容易失败，必须做 scale 限幅（见 9.1）
11) 低端机内存不足：必须有输入尺寸上限与复用策略（见 16.3）
12) 包大小：调色板/测试数据/基准图放主包可能超限，建议拆分或放分包（见 21 节）

---

## 21. 工程化落地建议（复用算法、包大小、可维护性）

### 21.1 从 HTML 平滑复用算法代码到 `utils/`
目标是“尽量不改算法逻辑”，只改 I/O：
1) 把 HTML `<script>` 里所有“纯函数/纯算法”拆出来（tone/dither/palette/nearest 等），放进 `utils/pixelizer/` 模块
2) 把所有 DOM 访问（`document.*`）留在 page 层；`utils` 里只收 `ImageData`/typed array 与参数
3) 保持常量与分支一致（特别是随机、阈值、步进、误差扩散核）
4) 做一组“固定输入+固定参数”的回归用例（哪怕只是手工跑），避免迁移时不小心改动算法

### 21.2 包大小与资源策略（避免主包超限）
常见限制（以官方为准）：主包体积有上限，资源/测试图片放多了很容易超。
- 调色板数据建议单独做成 `utils/pixelizer/palettes.js`（移除空格/注释、按需裁剪）
- 测试用基准 PNG 不建议打进主包：可放分包（`subpackages/`）或仅在开发态存在

### 21.3 兼容性开关（把“不确定性”工程化）
建议做成显式开关，避免你后期难排查：
- `renderMode`: `2d-node` / `canvas-id-fallback`
- `scaleMode`: `fastScale` / `strictScale`
- `randomMode`: `mathRandom` / `seededRandom`
- `perfMode`: `mainThread` / `worker`（可用则启用）
