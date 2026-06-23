# Tauri 版 Liquid Glass：本地突破方案、決策文件與 Codex 實作交接

> 版本：2026-06-19  
> 目標讀者：接手本地專案的 Codex / 工程實作代理 / 之後的人類 reviewer  
> 相關前置文件：`liquid-glass-canvas-design.md`  
> 本文件重點：在 Tauri 環境中，評估如何突破一般 WebKit 瀏覽器對 `backdrop-filter: url(#svgFilter)` 的限制，並設計可實作的 native snapshot + WebGL overlay 架構。

---

## 0. TL;DR

一般網站環境裡，我們無法安全、無權限、即時取得「任意 DOM 背後已經被瀏覽器 compositor 繪製完成的像素」，因此 WebKit/Safari 上無法用同一套 CSS/SVG 路徑重現 Kube 文章的 Chrome-only 液態玻璃折射。

Tauri 改變了這件事的邊界，因為它允許 Rust/native layer 取得平台 WebView handle，並呼叫平台 snapshot API。最佳突破路線不是等待 WebKit 支援 `backdrop-filter: url(#svgFilter)`，而是：

```txt
主 WebView 實際渲染 DOM
        ↓
Rust native plugin 擷取 WebView 已渲染畫面
        ↓
前端 overlay canvas / WebGL 將 snapshot 作為 texture
        ↓
shader 做 refraction / blur / chromatic aberration / rim highlight
```

建議最終策略：

| 平台 | 第一選擇 | 第二選擇 | 備註 |
|---|---|---|---|
| Windows / WebView2 | Chromium CSS/SVG path 或 snapshot + WebGL | CSS frosted fallback | WebView2 基於 Edge/Chromium，可先 feature-probe |
| Android / Android WebView | feature-probe 後決定 CSS path | snapshot + WebGL 或 fallback | WebView provider 版本依裝置而變 |
| macOS / WKWebView | native snapshot + WebGL overlay | native Apple Liquid Glass overlay | 不建議等 `-webkit-backdrop-filter: url(#filter)` |
| iOS / WKWebView | native snapshot + WebGL overlay 或 SwiftUI glassEffect overlay | CSS frosted fallback | Tauri mobile plugin 可接 Swift |
| Linux / WebKitGTK | WebKitGTK snapshot + WebGL overlay | CSS frosted fallback | overlay window 與透明度需逐 compositor 測試 |

第一版 PoC 建議只做：

1. macOS / Tauri / WKWebView snapshot。
2. 同一 WebView 內放 overlay canvas，capture 前暫時隱藏 overlay，避免遞迴截圖。
3. snapshot 先用 PNG bytes 回傳，前端 `createImageBitmap` 上傳 WebGL texture。
4. 玻璃 rect 只抓 union 區域，不抓整個 viewport。
5. 用 15–30 fps dirty scheduler，不追求每幀 snapshot。
6. 驗證成功後再拆成 transparent overlay window，並用 pointer passthrough。

---

## 1. 背景問題

Kube 的 Liquid Glass CSS/SVG 方案核心是：

```css
.glass {
  backdrop-filter: url(#liquidGlassFilter);
}
```

其中 SVG filter 會用 `feDisplacementMap` 對 backdrop pixels 做位移，產生「背後畫面被玻璃折射」的視覺。問題是這條路主要依賴 Chromium 對 SVG filter 作為 `backdrop-filter` 的支援。Kube 原文也明確標示後段真實 UI component demo 是 Chrome-only，原因就是只有 Chrome 支援把 SVG filters 當作 `backdrop-filter` 使用。

WebKit Bugzilla 245510 仍追蹤 `backdrop-filter: url(#some-svg-filter)` 在 Safari/WebKit 不工作的問題，reproduction 明確是 `feDisplacementMap` 在 Chromium 有效果、Safari 無效果。因此在 WebKit 上加 `-webkit-` prefix 不會根本解決。

在純 Web 版本中，我們設計了兩個 fallback：

1. **複製背景 + `filter: url(#svgFilter)`**：可折射被我們複製的背景圖、漸層、影片或 canvas source。
2. **WebGL canvas renderer**：背景由 app state / canvas / video / renderer 同步畫成 texture，shader 做折射。

Tauri 可以進一步突破，因為 native side 可以呼叫平台 WebView snapshot API，取得 WebView 實際渲染後的畫面。這是一般網站做不到的能力。

---

## 2. Tauri 的關鍵平台事實

以下資訊應視為本地決策前的基礎事實。

### 2.1 Tauri 各平台使用的 WebView

Tauri v2 官方文件說明：

- Windows 使用 WebView2，底層是 Microsoft Edge / Chromium。
- Android 使用 system Android WebView，也是 Chromium 系，但實際版本取決於裝置當前 WebView provider。
- macOS 使用 WebKit / WKWebView。
- iOS 使用 WebKit / WKWebView。
- Linux 使用 WebKitGTK / webkit2gtk。

因此「Tauri app」不是一個瀏覽器引擎，而是多平台系統 WebView 的組合。Liquid Glass 的實作策略必須平台分支。

### 2.2 Tauri 可以取得平台 WebView handle

Tauri `WebviewWindow::with_webview` 可以提供平台特定 WebView handle，closure 在 main thread 執行。官方文件也提醒：`webview2-com`、`webkit2gtk`、`objc2_web_kit` 等底層 crate 可能在 Tauri minor release 更新，因此使用 `with_webview` 時建議至少 pin 到 minor version。

這對我們很重要，因為 snapshot API 都是平台 API：

```txt
macOS / iOS:
  WKWebView.takeSnapshot(...)

Windows:
  CoreWebView2.CapturePreviewAsync(...)

Linux:
  webkit_web_view_get_snapshot(...)
```

### 2.3 Tauri 支援 window / webview / native plugin 能力

Tauri JS API 可建立或操作 windows 與 webviews。官方 webview API 支援建立有 label 的 Webview，並指定 logical position/size。Window API 支援 `setIgnoreCursorEvents(true)`，可讓透明 overlay window 不攔截滑鼠事件。Window API 也有 `setEffects(...)` 支援系統視窗效果，但那些更適合 app shell / sidebar / titlebar，不是任意 DOM card 的 liquid refraction。

Tauri plugin system 也支援 mobile native code：Android/Kotlin 或 Java、iOS/Swift。這代表 Apple 平台若想嘗試 SwiftUI / UIKit Liquid Glass，也可以走 native plugin path。

---

## 3. 在 Tauri 上能突破什麼、不能突破什麼

### 3.1 能突破

Tauri 可以讓我們做到：

- 讀取目前 app 內 WebView 的實際畫面快照。
- 用 native API 把 snapshot 回傳給前端或 native renderer。
- 在 overlay canvas / WebGL 中把 snapshot 當成 texture 做 shader refraction。
- 使用透明 overlay window 或第二 WebView 避免玻璃 overlay 被 capture 進去。
- 逐平台使用不同能力：Windows 走 Chromium CSS，macOS/iOS/Linux 走 snapshot bridge。
- 在 Apple 平台嘗試 native Liquid Glass / SwiftUI `glassEffect` 方案，用於 toolbar/sidebar/floating controls。

### 3.2 不能直接突破

Tauri 也不是萬能：

- 它不會讓 WebKit 自動支援 `backdrop-filter: url(#svgFilter)`。
- 它不能保證 WebView snapshot 是 60 fps、低延遲、無黑塊、無缺圖。
- 它不一定能零拷貝取得 WebView 的 GPU texture。
- snapshot API 可能無法正確捕捉硬體加速 video/WebGL/canvas layer，這需要逐平台實測。
- transparent overlay window 在 Linux compositor / Wayland / X11 上可能有平台差異。
- 如果依賴 private WebKit SPI，會增加 App Store 與 OS 更新風險，應避免。

---

## 4. 候選方案總覽

### 4.1 方案 A：Native Snapshot Bridge + WebGL Overlay

這是主推方案。

```txt
Main WebView
  └── App DOM / UI / scroll / animation

Rust native bridge
  ├── collect glass rects
  ├── call platform snapshot API
  ├── crop / encode / return bytes
  └── throttle capture requests

Overlay Renderer
  ├── fixed transparent canvas
  ├── WebGL shader
  ├── snapshot texture
  └── glass rect registry
```

優點：

- 可以折射任意 DOM 的實際渲染結果，而不是 html2canvas 的重建近似。
- 不依賴 WebKit CSS/SVG backdrop filter 支援。
- 第一版仍可沿用前一份文件的 WebGL shader renderer。
- 跨平台可逐步擴充。

缺點：

- snapshot 有延遲，不一定能 60 fps。
- 有 IPC / encode / decode / texture upload 成本。
- 需要避免 overlay recursive capture。
- platform bridge 實作與型別處理較複雜。

建議用途：

- 主要 DOM 背景會變化，希望玻璃即時反映。
- macOS / Linux / iOS 這些 WebKit 平台。
- 需要比 CSS blur fallback 更接近真實折射。

### 4.2 方案 B：Separate Transparent Overlay Window / WebView

這是方案 A 的產品化形態。

```txt
App Window
  ├── WebView: main-content
  │     └── 真正 UI
  │
  └── WebView 或 Transparent Window: liquid-overlay
        └── pointer-events none / cursor passthrough
        └── WebGL canvas
```

優點：

- snapshot 只擷取 main-content，不會把玻璃 overlay 自己拍進去。
- overlay 可以獨立調度、隱藏、重建。
- 若做成 window，可用 `setIgnoreCursorEvents(true)` 讓事件穿透。

缺點：

- 多 window / 多 webview z-order 要逐平台測。
- Linux 上透明 window 和 compositor 支援會比較麻煩。
- 需要同步 position、size、DPR、fullscreen、resize、scale factor。

建議：

- 第一階段不要直接做，先用 same-WebView + hide-before-capture 驗證。
- 第二階段產品化再拆 overlay window。

### 4.3 方案 C：Native WGPU Compositor

把 WebGL overlay 改成 Rust/native renderer：

```txt
WebView snapshot
        ↓
Rust image buffer / native texture
        ↓
wgpu / Metal / D3D12 / Vulkan
        ↓
transparent overlay window
```

優點：

- 效能上限高。
- shader 與 blur pipeline 可完全掌控。
- 可以走 native image buffer / GPU path，減少 JS decode 成本。
- 長期跨平台一致性好。

缺點：

- 工程量大。
- overlay window 與 input routing 更複雜。
- WebView snapshot 仍可能是瓶頸。
- 需要 Rust GPU / wgpu 經驗。

建議：

- 不作為第一版。
- 等 snapshot bridge + WebGL 驗證成功後，再評估是否需要。

### 4.4 方案 D：Apple Native Liquid Glass Overlay

Apple 平台可以研究 SwiftUI `glassEffect(_:in:)` 或 AppKit/UIKit material。適合：

- macOS / iOS-first app。
- toolbar、sidebar、titlebar、floating controls。
- 想貼近 Apple 系統 Liquid Glass。

不適合：

- 大量任意 DOM card 都要折射。
- 要求所有平台完全一致。
- 要完全客製 shader。
- 不想碰 native view hierarchy / z-order / hit testing。

建議：

- 作為 Apple 平台的視覺增強。
- 不取代 snapshot + shader 主路線。
- 可先做小範圍 native toolbar PoC。

### 4.5 方案 E：Tauri Window Effects

Tauri `setEffects(...)` 可以做 Mica/Acrylic/macOS material 這類 app shell 視窗效果。適合：

- window background。
- titlebar / sidebar / app frame。
- 彌補整體質感。

不適合：

- 讓 DOM card 擁有 displacement-map refraction。
- 對頁面中任意區域做局部折射。
- 作為 Kube liquid glass 的替代。

建議：

```txt
Window shell:
  Tauri window effects

Content cards:
  snapshot + WebGL shader

Apple controls:
  optional native Liquid Glass
```

---

## 5. 決策矩陣

| 指標 | CSS SVG backdrop-filter | html2canvas fallback | Native snapshot + WebGL | Native WGPU | Apple native glass |
|---|---:|---:|---:|---:|---:|
| WebKit 可用性 | 低 | 中 | 高 | 高 | 高，限 Apple |
| 任意 DOM 反應 | 高，若支援 | 中低 | 高 | 高 | 中 |
| 即時性 | 高 | 低中 | 中高 | 中高 | 高 |
| 視覺真實度 | 高 | 中 | 高 | 高 | 高，風格受系統控制 |
| 實作成本 | 低 | 低中 | 中高 | 高 | 中高 |
| 跨平台一致 | 低 | 中 | 高 | 高 | 低 |
| App Store 風險 | 低 | 低 | 低，若只用 public API | 低中 | 低，若只用 public API |
| 第一版建議 | Windows only | fallback only | 主線 | 第二階段 | optional PoC |

推薦決策：

```txt
Stage 1:
  Native snapshot + WebGL overlay

Stage 2:
  Separate transparent overlay window

Stage 3:
  WGPU 或 Apple native glass 視需求加碼
```

---

## 6. 推薦架構

### 6.1 整體架構圖

```txt
┌─────────────────────────────────────────────────────┐
│ Tauri App Window                                    │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ Main WebView: "main"                          │  │
│  │                                               │  │
│  │  App DOM / React / Vue / Svelte               │  │
│  │  glass DOM elements: [data-liquid-glass]      │  │
│  │                                               │  │
│  │  LiquidGlassClient                            │  │
│  │   ├── collect rects                           │  │
│  │   ├── schedule capture                        │  │
│  │   ├── invoke("capture_backdrop")              │  │
│  │   └── update WebGL texture                    │  │
│  │                                               │  │
│  │  Overlay Canvas                               │  │
│  │   ├── WebGL2                                  │  │
│  │   └── shader liquid glass                     │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘
                     │
                     │ Tauri invoke
                     ▼
┌─────────────────────────────────────────────────────┐
│ Rust / src-tauri                                    │
│                                                     │
│  capture_backdrop command                           │
│   ├── resolve WebviewWindow by label                │
│   ├── with_webview(...) on main thread              │
│   ├── platform capture                              │
│   │    ├── macOS/iOS: WKWebView.takeSnapshot        │
│   │    ├── Windows: CoreWebView2.CapturePreview     │
│   │    └── Linux: WebKitGTK get_snapshot            │
│   ├── crop / encode / return bytes                  │
│   └── metrics / error handling                      │
└─────────────────────────────────────────────────────┘
```

### 6.2 檔案結構建議

```txt
src/
  liquid-glass/
    index.ts
    platform.ts
    feature-probe.ts
    registry.ts
    geometry.ts
    scheduler.ts
    renderer-webgl.ts
    shaders.ts
    tauri-capture-client.ts
    fallback-css.ts

src-tauri/
  src/
    lib.rs
    commands/
      mod.rs
      capture_backdrop.rs
    liquid/
      mod.rs
      types.rs
      metrics.rs
      platform/
        mod.rs
        macos_snapshot.rs
        ios_snapshot.rs
        windows_snapshot.rs
        linux_snapshot.rs
        unsupported.rs
```

### 6.3 前端責任

前端負責：

- 追蹤 `[data-liquid-glass]` 元素。
- 收集 `getBoundingClientRect()`。
- 計算 union capture rect。
- 管理 dirty flag / scheduler。
- 呼叫 Tauri command。
- 解碼回傳影像。
- 上傳 WebGL texture。
- 根據 glass rect 繪製 shader quad。
- 根據平台選擇 fallback。

### 6.4 Rust/native 責任

Rust/native 負責：

- 找到指定 webview label。
- 在 main thread 取得平台 handle。
- 呼叫 public snapshot API。
- 必要時 crop / scale / encode。
- 回傳 bytes / metadata。
- 限流、取消過期 request、記錄 latency。
- 提供平台能力 probing。

---

## 7. TypeScript API 草案

### 7.1 核心 types

```ts
export type LiquidPlatform =
  | "windows"
  | "macos"
  | "linux"
  | "ios"
  | "android"
  | "unknown";

export type LiquidStrategy =
  | { kind: "chromium-css" }
  | { kind: "native-snapshot-webgl" }
  | { kind: "native-apple-glass" }
  | { kind: "css-frosted-fallback" };

export type GlassRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  blurPx: number;
  refract: number;
  opacity: number;
  chromaticPx: number;
};

export type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CaptureMode =
  | "viewport"
  | "union"
  | "rects";

export type CaptureBackdropRequest = {
  webviewLabel: string;
  epoch: number;
  dpr: number;
  viewportWidth: number;
  viewportHeight: number;
  captureMode: CaptureMode;
  captureRect: CaptureRect;
  glassRects: GlassRect[];
  overlayMode: "same-webview" | "separate-overlay-window" | "separate-overlay-webview";
  outputFormat: "png" | "rgba8";
};

export type CaptureBackdropResponse = {
  epoch: number;
  width: number;
  height: number;
  dpr: number;
  rect: CaptureRect;
  format: "png" | "rgba8";
  bytes: Uint8Array;
  metrics?: {
    nativeCaptureMs?: number;
    encodeMs?: number;
    totalMs?: number;
  };
};
```

### 7.2 Public client API

```ts
export type LiquidGlassOptions = {
  webviewLabel?: string;
  selector?: string;
  maxDpr?: number;
  maxCaptureFps?: number;
  overlayMode?: "same-webview" | "separate-overlay-window";
  strategy?: LiquidStrategy | "auto";
  debug?: boolean;
};

export type AttachGlassOptions = {
  radius?: number;
  blurPx?: number;
  refract?: number;
  opacity?: number;
  chromaticPx?: number;
};

export interface LiquidGlassController {
  attach(target: Element | string, options?: AttachGlassOptions): () => void;
  start(): void;
  stop(): void;
  markDirty(reason?: string): void;
  setStrategy(strategy: LiquidStrategy): void;
  destroy(): void;
}

export function createLiquidGlass(options?: LiquidGlassOptions): LiquidGlassController;
```

### 7.3 使用範例

```ts
import { createLiquidGlass } from "./liquid-glass";

const liquid = createLiquidGlass({
  webviewLabel: "main",
  selector: "[data-liquid-glass]",
  maxDpr: 2,
  maxCaptureFps: 30,
  overlayMode: "same-webview",
  strategy: "auto",
  debug: true,
});

liquid.start();

document.querySelectorAll("[data-liquid-glass]").forEach((el) => {
  liquid.attach(el, {
    radius: 28,
    blurPx: 8,
    refract: 1.0,
    opacity: 0.96,
    chromaticPx: 1.6,
  });
});
```

---

## 8. 策略偵測

### 8.1 決策流程

```ts
export async function detectLiquidStrategy(): Promise<LiquidStrategy> {
  const platform = await getTauriPlatform();

  if (platform === "windows") {
    const cssWorks = await probeSvgBackdropFilterActualRendering();
    if (cssWorks) return { kind: "chromium-css" };

    return { kind: "native-snapshot-webgl" };
  }

  if (platform === "android") {
    const cssWorks = await probeSvgBackdropFilterActualRendering();
    if (cssWorks) return { kind: "chromium-css" };

    return { kind: "css-frosted-fallback" };
  }

  if (platform === "macos") {
    const canUseNativeGlass = await probeAppleNativeGlassAvailability();
    if (canUseNativeGlass && shouldUseNativeAppleGlassForThisSurface()) {
      return { kind: "native-apple-glass" };
    }

    return { kind: "native-snapshot-webgl" };
  }

  if (platform === "ios") {
    return { kind: "native-snapshot-webgl" };
  }

  if (platform === "linux") {
    return { kind: "native-snapshot-webgl" };
  }

  return { kind: "css-frosted-fallback" };
}
```

### 8.2 不要只用 `CSS.supports`

避免只做：

```ts
CSS.supports("backdrop-filter", "url(#filter)");
```

因為 Safari/WebKit 可能能 parse 語法，但實際不做 SVG displacement backdrop rendering。應做 actual rendering probe：

```ts
async function probeSvgBackdropFilterActualRendering(): Promise<boolean> {
  /*
    建議 PoC：
    1. 建立一個 offscreen 測試區域，背景為高對比條紋。
    2. 放一個小 glass element，套 backdrop-filter: url(#probeDisplacement)。
    3. 使用 canvas / snapshot / visual comparison 檢查像素是否真的被位移。
    4. 若在一般 browser 無法 read pixels，就在 Tauri 中用 native snapshot 做 probe。
  */
  return false;
}
```

---

## 9. Geometry：只 capture 必要區域

不要每次抓整個 viewport。先抓所有可見 glass rect，計算 union rect，並根據 blur/refract 擴張 margin。

```ts
export function computeCaptureUnion(
  rects: GlassRect[],
  viewport: { width: number; height: number },
): CaptureRect | null {
  if (rects.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.x + r.width < 0 || r.y + r.height < 0) continue;
    if (r.x > viewport.width || r.y > viewport.height) continue;

    const margin = Math.max(
      r.blurPx * 3,
      r.refract * 48,
      r.chromaticPx * 4,
      64,
    );

    left = Math.min(left, r.x - margin);
    top = Math.min(top, r.y - margin);
    right = Math.max(right, r.x + r.width + margin);
    bottom = Math.max(bottom, r.y + r.height + margin);
  }

  if (!Number.isFinite(left)) return null;

  left = Math.max(0, Math.floor(left));
  top = Math.max(0, Math.floor(top));
  right = Math.min(viewport.width, Math.ceil(right));
  bottom = Math.min(viewport.height, Math.ceil(bottom));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}
```

WebGL shader 要知道 capture rect 不是整個 viewport，因此 sampling UV 應用：

```glsl
vec2 captureUv = (screenPx - uCaptureRect.xy) / uCaptureRect.zw;
```

而不是直接 `screenPx / viewportSize`。

---

## 10. Scheduler：即時但不要暴力

### 10.1 Dirty sources

前端應標記 dirty，而不是每個事件立刻 snapshot：

```ts
const scheduler = new BackdropScheduler({
  maxFpsIdle: 10,
  maxFpsScrolling: 30,
  maxFpsAnimating: 30,
});

const root = document.querySelector("#app")!;

new MutationObserver(() => scheduler.markDirty("mutation")).observe(root, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});

new ResizeObserver(() => scheduler.markDirty("resize")).observe(document.documentElement);

window.addEventListener("scroll", () => scheduler.markDirty("scroll"), {
  passive: true,
});

document.addEventListener("transitionrun", () => scheduler.markDirty("transitionrun"));
document.addEventListener("transitionend", () => scheduler.markDirty("transitionend"));
document.addEventListener("animationstart", () => scheduler.markDirty("animationstart"));
document.addEventListener("animationend", () => scheduler.markDirty("animationend"));
```

### 10.2 Scheduler skeleton

```ts
export class BackdropScheduler {
  private dirty = false;
  private capturing = false;
  private lastCapture = 0;
  private minIntervalMs = 1000 / 30;
  private stopped = true;

  constructor(
    private readonly captureAndUpdate: () => Promise<void>,
    private readonly options: {
      maxFpsIdle: number;
      maxFpsScrolling: number;
      maxFpsAnimating: number;
    },
  ) {}

  markDirty(reason?: string) {
    this.dirty = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;

    const tick = async () => {
      if (this.stopped) return;

      const now = performance.now();

      if (
        this.dirty &&
        !this.capturing &&
        now - this.lastCapture >= this.minIntervalMs
      ) {
        this.capturing = true;
        this.dirty = false;
        this.lastCapture = now;

        try {
          await this.captureAndUpdate();
        } catch (error) {
          console.warn("[liquid-glass] capture failed", error);
        } finally {
          this.capturing = false;
        }
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  stop() {
    this.stopped = true;
  }
}
```

### 10.3 建議 capture rate

| 情境 | 建議 |
|---|---:|
| 靜態 DOM | dirty only |
| hover / small interaction | 15 fps |
| scroll 中 | 15–30 fps |
| 頁面中有動畫背景 | 30 fps，必要時降 DPR |
| 低階機器 / battery mode | 10–15 fps |
| overlay invisible / no glass visible | 0 fps |

---

## 11. Rust command schema

### 11.1 `types.rs`

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlassRect {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    pub blur_px: f64,
    pub refract: f64,
    pub opacity: f64,
    pub chromatic_px: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    Viewport,
    Union,
    Rects,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum OutputFormat {
    Png,
    Rgba8,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBackdropRequest {
    pub webview_label: String,
    pub epoch: f64,
    pub dpr: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub capture_mode: CaptureMode,
    pub capture_rect: CaptureRect,
    pub glass_rects: Vec<GlassRect>,
    pub output_format: OutputFormat,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetrics {
    pub native_capture_ms: Option<f64>,
    pub encode_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBackdropResponse {
    pub epoch: f64,
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
    pub rect: CaptureRect,
    pub format: String,
    pub bytes: Vec<u8>,
    pub metrics: Option<CaptureMetrics>,
}
```

### 11.2 `capture_backdrop.rs`

```rust
use tauri::{AppHandle, Manager};

use crate::liquid::types::{
    CaptureBackdropRequest,
    CaptureBackdropResponse,
};

#[tauri::command]
pub async fn capture_backdrop(
    app: AppHandle,
    request: CaptureBackdropRequest,
) -> Result<CaptureBackdropResponse, String> {
    let started = std::time::Instant::now();

    let webview = app
        .get_webview_window(&request.webview_label)
        .ok_or_else(|| format!("webview not found: {}", request.webview_label))?;

    #[cfg(target_os = "macos")]
    {
        return crate::liquid::platform::macos_snapshot::capture(webview, request, started).await;
    }

    #[cfg(target_os = "ios")]
    {
        return crate::liquid::platform::ios_snapshot::capture(webview, request, started).await;
    }

    #[cfg(windows)]
    {
        return crate::liquid::platform::windows_snapshot::capture(webview, request, started).await;
    }

    #[cfg(target_os = "linux")]
    {
        return crate::liquid::platform::linux_snapshot::capture(webview, request, started).await;
    }

    #[allow(unreachable_code)]
    Err("capture_backdrop is unsupported on this platform".into())
}
```

### 11.3 `lib.rs`

```rust
mod liquid;

use liquid::commands::capture_backdrop;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            capture_backdrop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 12. 平台 snapshot 實作方向

以下程式碼是 PoC skeleton，不應直接視為可編譯最終碼。Codex 本地實作時必須依目前專案的 Tauri/Wry/objc2/webview2/webkit2gtk 版本調整。

### 12.1 macOS / iOS：WKWebView.takeSnapshot

Apple `WKWebView.takeSnapshot(with:completionHandler:)` 可非同步產生 WebView contents 的 platform-native image。`WKSnapshotConfiguration` 可指定要 capture 的 rect 與 snapshot width。

設計重點：

- 用 `with_webview` 取得 `objc2_web_kit::WKWebView`。
- 在 main thread 呼叫 snapshot。
- 使用 `WKSnapshotConfiguration.rect` 抓 union rect。
- `snapshotWidth` 可根據 DPR 設定。
- 將 `NSImage` / `UIImage` 編碼為 PNG。
- 回傳 PNG bytes。

Pseudo flow：

```rust
pub async fn capture(
    webview_window: tauri::WebviewWindow,
    request: CaptureBackdropRequest,
    started: std::time::Instant,
) -> Result<CaptureBackdropResponse, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    webview_window
        .with_webview(move |platform_webview| {
            #[cfg(target_os = "macos")]
            unsafe {
                /*
                  1. Cast platform_webview.inner() to WKWebView.
                  2. Create WKSnapshotConfiguration.
                  3. Set rect = request.capture_rect in view coordinates.
                  4. Set snapshotWidth = request.capture_rect.width * request.dpr.
                  5. call takeSnapshotWithConfiguration completionHandler.
                  6. Convert NSImage to PNG bytes.
                  7. tx.send(response).
                */
            }
        })
        .map_err(|e| e.to_string())?;

    rx.await.map_err(|_| "snapshot channel closed".to_string())?
}
```

風險：

- snapshot 可能不包含硬體加速 video/WebGL layer。
- capture rect 必須在 WKWebView bounds 內。
- 需要確保 overlay 不被 capture。
- 需要確認 coordinate system：CSS pixels、logical points、physical pixels、DPR 的換算。
- iOS background / offscreen / hidden state snapshot 行為需實測。

### 12.2 Windows：WebView2 CapturePreviewAsync

Microsoft WebView2 `CoreWebView2.CapturePreviewAsync` 會擷取 WebView 正在顯示的畫面並寫入 stream。官方文件也註明：在第一個 `ContentLoading` event 前呼叫會失敗或抓到舊頁面。

設計重點：

- Windows 可以先用 Chromium CSS path；snapshot path 可作為一致性 fallback。
- `CapturePreviewAsync` 通常偏向抓 viewport preview。
- 若 API 不支援 rect capture，先抓 viewport，再 native crop union rect。
- 先用 PNG output，後續再優化 raw buffer。
- 確保 webview ready 狀態。

Pseudo flow：

```rust
pub async fn capture(
    webview_window: tauri::WebviewWindow,
    request: CaptureBackdropRequest,
    started: std::time::Instant,
) -> Result<CaptureBackdropResponse, String> {
    /*
      1. with_webview -> webview.controller() / CoreWebView2.
      2. CapturePreviewAsync(PNG, stream).
      3. Await completion.
      4. Decode/crop if necessary.
      5. Return bytes.
    */
    Err("todo: windows CapturePreviewAsync bridge".into())
}
```

風險：

- COM async callback wiring。
- CapturePreviewAsync readiness。
- DPI scaling and browser zoom.
- Crop coordinate mismatch。
- 如果 Windows 已能使用 CSS path，可降低此路線優先度。

### 12.3 Linux：WebKitGTK snapshot

WebKitGTK 有 `webkit_web_view_get_snapshot` / newer async `get_snapshot` API，能取得 WebView snapshot。Tauri Linux 使用 WebKitGTK，因此理論上可以走這條路。

設計重點：

- 用 `with_webview` 取得 `webkit2gtk::WebView`。
- 呼叫 snapshot API。
- 得到 cairo surface 後 crop/encode。
- Linux compositor 與透明 overlay window 要額外測。

Pseudo flow：

```rust
pub async fn capture(
    webview_window: tauri::WebviewWindow,
    request: CaptureBackdropRequest,
    started: std::time::Instant,
) -> Result<CaptureBackdropResponse, String> {
    /*
      1. with_webview -> webkit2gtk::WebView.
      2. get visible snapshot / selected region.
      3. cairo surface -> PNG bytes.
      4. Return response.
    */
    Err("todo: linux WebKitGTK snapshot bridge".into())
}
```

風險：

- WebKitGTK version 差異。
- GTK main thread / glib main context。
- cairo surface format conversion。
- Wayland/X11 transparent window 行為差異。
- Hardware-accelerated content capture fidelity。

---

## 13. Overlay 模式

### 13.1 Same WebView + hide-before-capture

第一版最容易驗證：

```txt
Main WebView:
  DOM + overlay canvas 同層
```

capture 前：

```ts
async function captureWithSameWebviewOverlayHidden() {
  overlayCanvas.style.visibility = "hidden";

  await nextAnimationFrame();

  try {
    return await invokeCapture();
  } finally {
    overlayCanvas.style.visibility = "visible";
  }
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
```

優點：

- 實作最少。
- 適合先測 snapshot 是否成功。
- 不需要多 window / z-order。

缺點：

- 可能閃爍，需小心。
- capture hide/restore timing 可能造成 race。
- 如果 capture API afterScreenUpdates 行為不同，可能拍到 overlay 或拍不到更新。
- 不適合長期產品化。

### 13.2 Separate overlay window

產品化建議：

```ts
import { Window } from "@tauri-apps/api/window";

const overlay = new Window("liquid-overlay", {
  transparent: true,
  decorations: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  focusable: false,
});

await overlay.setIgnoreCursorEvents(true);
```

優點：

- 避免 recursive capture。
- 可讓事件穿透。
- overlay renderer 可獨立重啟。

缺點：

- 多視窗同步位置與大小。
- macOS fullscreen / Spaces / stage manager 需測。
- Windows always-on-top 與 focusable 行為需測。
- Linux support 不穩定風險較高。

### 13.3 Separate WebView in same Window

Tauri JS webview API 可在 Window 裡建立多個 Webview，指定位置與大小。這介於 same-WebView 與 overlay window 之間。

優點：

- 不一定需要 OS-level window。
- 可用 label 分別管理 main 和 overlay。
- 理論上 capture main webview 時不含 overlay webview。

缺點：

- webview z-order / transparency / hit testing 平台差異需要測。
- 可能比 separate window 更不好 debug。

建議：

- 作為第二階段候選之一，與 separate window 比較。
- 優先確認是否能精準 capture main-content webview。

---

## 14. WebGL renderer 接口調整

前一份設計的 WebGL renderer 可沿用，但要加入 capture rect 支援。

### 14.1 Texture update

```ts
export type BackdropTextureUpdate = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  dpr: number;
  captureRect: CaptureRect;
  epoch: number;
};

renderer.updateBackdropTexture({
  bitmap,
  width: response.width,
  height: response.height,
  dpr: response.dpr,
  captureRect: response.rect,
  epoch: response.epoch,
});
```

### 14.2 Shader uniforms

```glsl
uniform sampler2D uBackdrop;
uniform vec2 uViewportSizePx;
uniform vec4 uCaptureRectPx; // x, y, w, h
uniform vec4 uGlassRectPx;   // x, y, w, h
uniform float uRadiusPx;
uniform float uBlurPx;
uniform float uRefract;
uniform float uChromaticPx;
uniform float uOpacity;
```

### 14.3 Sampling

```glsl
vec2 screenPx = uGlassRectPx.xy + vLocal * uGlassRectPx.zw;

vec2 offsetPx = computeLiquidOffset(...);

vec2 samplePx = screenPx + offsetPx;

vec2 uv = (samplePx - uCaptureRectPx.xy) / uCaptureRectPx.zw;

vec4 backdrop = texture(uBackdrop, clamp(uv, vec2(0.001), vec2(0.999)));
```

---

## 15. IPC / bytes / encoding 選擇

### 15.1 第一版：PNG bytes

Pros:

- 最容易跨平台。
- WebView snapshot APIs 常能產生 PNG/JPEG。
- 前端可用 `Blob + createImageBitmap` 解碼。

Cons:

- encode/decode 成本高。
- 大圖 latency 可能明顯。
- snapshot 頻率受限。

前端：

```ts
const response = await invoke<CaptureBackdropResponse>("capture_backdrop", { request });

const blob = new Blob([response.bytes], { type: "image/png" });
const bitmap = await createImageBitmap(blob);

renderer.updateBackdropTexture({
  bitmap,
  width: response.width,
  height: response.height,
  dpr: response.dpr,
  captureRect: response.rect,
  epoch: response.epoch,
});

bitmap.close();
```

### 15.2 第二版：raw RGBA8 / BGRA8

Pros:

- 避免 PNG encode/decode。
- 低延遲。

Cons:

- IPC data volume 大。
- 需要統一 row stride / premultiplied alpha / color space。
- 前端上傳 WebGL texture 要處理 `Uint8Array`。

### 15.3 第三版：temp file / custom protocol

Pros:

- 避免超大 bytes 直接走 invoke payload。
- 可做 cache / ETag / epoch。

Cons:

- 多 file lifecycle 管理。
- 仍需 decode。

### 15.4 第四版：shared memory / native texture

Pros:

- 效能最佳。

Cons:

- 工程量最大。
- 平台差異大。
- 不適合第一版。

---

## 16. Performance budget

### 16.1 初始目標

| 指標 | 目標 |
|---|---:|
| glass 數量 | 同畫面 1–5 個 |
| union capture size | 儘量 < 1000×1000 logical px |
| DPR | cap at 2，低階裝置 cap at 1.5 |
| capture fps | 15–30 fps |
| p50 capture total latency | < 40ms |
| p95 capture total latency | < 100ms |
| WebGL draw | < 4ms/frame |
| memory spike | 避免多張 full viewport PNG 同時存在 |

### 16.2 降級策略

| 問題 | 降級 |
|---|---|
| capture latency 過高 | 降 FPS |
| encode/decode 過高 | 降 DPR |
| scroll 卡頓 | scroll 中只更新位置，不更新 snapshot 或降到 15fps |
| glass 太多 | 只 draw visible glass；合併 capture rect |
| overlay recursive | 改 separate overlay |
| snapshot 不含 video/WebGL | 對該區域使用 controlled renderer 或 fallback |
| Linux 透明 overlay 不穩 | same-WebView mode 或 CSS fallback |

---

## 17. Accessibility / UX 注意事項

Liquid Glass 容易造成可讀性問題。實作應加入：

- `prefers-reduced-transparency` 或 app setting：關閉折射，改 frosted fallback。
- `prefers-reduced-motion`：關閉 ripple / hover distortion。
- 高對比模式：提高 panel tint / border / text contrast。
- 不要在大量正文背後使用強 refraction。
- glass card 內文字仍用 DOM，不要畫進 canvas，避免影響選取、焦點、accessibility tree。
- overlay canvas `aria-hidden="true"`，並 `pointer-events: none`。

CSS fallback：

```css
.liquid-glass-fallback {
  background:
    linear-gradient(135deg, rgb(255 255 255 / 0.30), rgb(255 255 255 / 0.08));

  -webkit-backdrop-filter:
    blur(22px)
    saturate(1.8)
    brightness(1.08)
    contrast(1.04);

  backdrop-filter:
    blur(22px)
    saturate(1.8)
    brightness(1.08)
    contrast(1.04);

  box-shadow:
    0 24px 70px rgb(0 0 0 / 0.22),
    inset 0 0 0 1px rgb(255 255 255 / 0.45),
    inset 0 1px 2px rgb(255 255 255 / 0.70),
    inset 0 -1px 2px rgb(0 0 0 / 0.18);
}

@media (prefers-reduced-motion: reduce) {
  .liquid-glass-canvas {
    display: none;
  }
}

@media (prefers-contrast: more) {
  .liquid-glass-fallback {
    background: rgb(255 255 255 / 0.72);
  }
}
```

---

## 18. 風險清單

| 風險 | 嚴重度 | 可能性 | 對策 |
|---|---:|---:|---|
| WKWebView snapshot latency 太高 | 高 | 中 | union rect、降 DPR、降 FPS、raw RGBA |
| snapshot 拍到 overlay 自己 | 高 | 高，same-WebView | hide-before-capture；第二階段 separate overlay |
| snapshot 不含 video/WebGL | 中高 | 中 | 測；對該內容改 controlled renderer；fallback |
| Windows CSS path 行為與 Chrome 不同 | 中 | 中 | actual rendering probe；snapshot fallback |
| Linux 透明 overlay 不穩 | 高 | 中高 | same-WebView fallback；平台關閉 |
| DPI / coordinate mismatch | 高 | 高 | 建立 visual debug grid；統一 px/point |
| IPC bytes 過大 | 中高 | 中 | PNG first；raw later；crop union |
| App Store private API 風險 | 高 | 低，若守 public API | 禁用 private WebKit SPI |
| Tauri minor release 更新底層 crate | 中 | 中 | pin minor version；隔離 platform module |
| Accessibility / contrast 下降 | 高 | 中 | reduce transparency / contrast fallback |

---

## 19. 本地驗證計畫

### 19.1 PoC 1：macOS same-WebView snapshot

目標：

- 按鈕觸發 native capture。
- 回傳 PNG。
- 在頁面顯示 capture 結果。
- 確認截圖是 main DOM，且 coordinates 正確。

Acceptance criteria：

- `capture_backdrop` 在 macOS 成功。
- union rect 能抓出正確位置。
- 輸出圖像尺寸與 DPR 對齊。
- 無 crash / no panic。
- failure path 可回 CSS fallback。

### 19.2 PoC 2：WebGL texture update

目標：

- 用 capture PNG 更新 WebGL texture。
- 玻璃 card shader 使用 capture texture sample。
- scroll / DOM mutation 會 mark dirty 並更新。

Acceptance criteria：

- glass rect 位置與 DOM card 對齊。
- 背景被折射，而不是整張圖錯位。
- capture 更新後 1–3 frames 內可見。
- overlay 不阻擋 DOM buttons。

### 19.3 PoC 3：防止 recursive capture

目標：

- same-WebView 下 capture 前隱藏 overlay。
- 測試 overlay 是否被拍進去。

Acceptance criteria：

- snapshot 中沒有上一幀 glass canvas。
- 隱藏 overlay 不造成肉眼閃爍。
- 若閃爍，改 requestAnimationFrame timing 或進入 separate overlay PoC。

### 19.4 PoC 4：transparent overlay window

目標：

- 建立透明 overlay window。
- overlay follows main window position/size。
- `setIgnoreCursorEvents(true)` 讓滑鼠穿透。

Acceptance criteria：

- main DOM 可點擊、hover、focus。
- overlay 不進入 snapshot。
- resize / scaleFactor / fullscreen 正常。
- 至少 macOS + Windows 測過。

### 19.5 PoC 5：Windows / Linux

Windows：

- 先測 CSS SVG backdrop-filter actual rendering probe。
- 若成功，保留 CSS path。
- 若失敗或需一致性，做 WebView2 CapturePreviewAsync bridge。

Linux：

- 測 WebKitGTK snapshot API。
- 測透明 overlay。
- 若不穩，保留 CSS fallback。

---

## 20. Debug tooling

建議第一版加 debug overlay：

```ts
type LiquidDebugState = {
  showCaptureRect: boolean;
  showGlassRects: boolean;
  showTexturePreview: boolean;
  showMetrics: boolean;
};
```

顯示：

- capture rect border。
- 每個 glass rect border。
- texture preview 小窗。
- latency：nativeCaptureMs、encodeMs、decodeMs、uploadMs、drawMs。
- dropped captures。
- active strategy。

Debug UI example：

```txt
Liquid Glass Debug
  Strategy: native-snapshot-webgl
  Platform: macOS / WKWebView
  DPR: 2
  Capture rect: x=120 y=88 w=720 h=420
  Native: 14.2ms
  Encode: 6.8ms
  Decode: 4.3ms
  Upload: 1.1ms
  Total: 32.7ms
  FPS: 24
```

---

## 21. Codex 實作任務拆解

### Task 1：建立 frontend module skeleton

建立：

```txt
src/liquid-glass/
  index.ts
  platform.ts
  feature-probe.ts
  registry.ts
  geometry.ts
  scheduler.ts
  renderer-webgl.ts
  shaders.ts
  tauri-capture-client.ts
  fallback-css.ts
```

完成：

- `createLiquidGlass(...)`
- `attach(...)`
- rect registry
- union capture rect
- dirty scheduler
- no-op fallback

### Task 2：把前一份 WebGL renderer 改成 captureRect-aware

完成：

- `updateBackdropTexture(...)`
- `uCaptureRectPx` uniform
- texture sampling with capture rect
- visible glass culling
- debug rect rendering

### Task 3：建立 Rust command skeleton

建立：

```txt
src-tauri/src/liquid/
  mod.rs
  types.rs
  commands.rs
  platform/mod.rs
  platform/unsupported.rs
```

完成：

- serde request/response types
- `capture_backdrop` command
- unsupported platform error
- invoke handler registration

### Task 4：macOS WKWebView snapshot PoC

完成：

- `platform/macos_snapshot.rs`
- 使用 `with_webview`
- 呼叫 public WKWebView snapshot API
- PNG encode
- 回傳 response
- error handling

### Task 5：前端 invoke + texture upload

完成：

- `tauri-capture-client.ts`
- `invoke("capture_backdrop")`
- Blob / createImageBitmap
- discard stale epoch
- metrics logging

### Task 6：overlay recursive prevention

完成：

- same-WebView hide-before-capture
- one frame wait
- fallback if capture still contains overlay
- debug flag

### Task 7：transparent overlay window PoC

完成：

- 建立 overlay window 或 overlay webview。
- 同步 window position / size / scaleFactor。
- `setIgnoreCursorEvents(true)`。
- 測試 pointer passthrough。

### Task 8：Windows CSS actual probe

完成：

- actual rendering probe。
- 若成功，用 CSS path。
- 若失敗，走 snapshot-webgl。
- 將結果記錄到 debug UI。

### Task 9：performance gates

完成：

- maxDpr option。
- maxCaptureFps option。
- capture rect max size。
- automatic downgrade。
- metrics overlay。

### Task 10：fallback and accessibility

完成：

- CSS frosted fallback。
- prefers-reduced-motion。
- prefers-contrast。
- user setting `liquidGlass: off | subtle | full`。

---

## 22. Codex 本地開工 prompt

可以直接把以下 prompt 丟給 Codex：

```txt
你正在接手一個 Tauri v2 專案，要實作跨 WebKit/Chromium 的 Liquid Glass 效果。請先閱讀本文件與 `liquid-glass-canvas-design.md`，然後在本地專案做第一階段 PoC。

目標：
1. 建立 `src/liquid-glass` 前端模組。
2. 建立 `src-tauri/src/liquid` Rust command skeleton。
3. 在 macOS 先完成 `capture_backdrop`，用 Tauri `with_webview` 取得 WKWebView，呼叫 public WKWebView snapshot API，把 union rect 輸出成 PNG bytes。
4. 前端用 Tauri invoke 接收 PNG，createImageBitmap 後上傳 WebGL texture。
5. WebGL shader 根據 `uCaptureRectPx` 和 glass rect 做 refraction。
6. same-WebView 第一版可以在 capture 前暫時隱藏 overlay canvas，避免 recursive capture。
7. 必須加 CSS frosted fallback，任何平台 API 失敗都不能讓 UI 壞掉。
8. 加 debug overlay：顯示策略、capture rect、latency、DPR、fallback reason。

限制：
- 不要用 private WebKit API。
- 不要每幀強制 full viewport snapshot。
- 第一版只追求 macOS PoC 成功，不要同時做 WGPU。
- 不要把文字內容畫進 canvas；玻璃內容仍保持 DOM。
- 不要只靠 `CSS.supports("backdrop-filter", "url(#x)")` 判斷支援；需要 actual rendering probe 或平台策略。
- Tauri 版本請 pin 到 minor version，因為 `with_webview` 涉及平台 binding crates。

完成後請提供：
- 修改檔案列表。
- 如何啟動測試。
- 已知限制。
- macOS snapshot latency 測量。
- 下一步建議。
```

---

## 23. Open questions for local decision

以下需要 Codex 在本地專案確認：

1. 目前 Tauri 版本、Wry 版本與底層 binding crate 版本？
2. 專案是 desktop-only 還是包含 iOS/Android？
3. 是否需要 App Store / Mac App Store 發佈？
4. 玻璃效果主要出現在哪些 UI：cards、sidebar、toolbar、modal、floating nav？
5. 同一畫面最多幾個 glass 元素？
6. 背景是否包含 video / WebGL / canvas / iframe？
7. 是否有高頻 scroll / animation 場景？
8. Linux 是否為一等支援平台？
9. 是否可接受 Windows 與 macOS 視覺策略不同？
10. 是否需要 native Apple Liquid Glass，還是自訂 shader 風格優先？

---

## 24. 參考來源

1. Kube: “Liquid Glass in the Browser: Refraction with CSS and SVG”  
   https://kube.io/blog/liquid-glass-css-svg

2. WebKit Bugzilla 245510: `backdrop-filter: url(#some-svg-filter)` with SVG filter issue  
   https://bugs.webkit.org/show_bug.cgi?id=245510

3. Tauri v2 Webview Versions  
   https://v2.tauri.app/reference/webview-versions/

4. Tauri `WebviewWindow::with_webview` docs  
   https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.with_webview

5. Tauri JS Webview API  
   https://v2.tauri.app/reference/javascript/api/namespacewebview/

6. Tauri JS Window API: `setIgnoreCursorEvents`, `setEffects`, window effects config  
   https://v2.tauri.app/reference/javascript/api/namespacewindow/

7. Tauri Plugin Development / mobile native Kotlin-Swift support  
   https://v2.tauri.app/develop/plugins/

8. Apple Developer: `WKWebView.takeSnapshot(with:completionHandler:)`  
   https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot%28with%3Acompletionhandler%3A%29

9. Apple Developer: `WKSnapshotConfiguration`  
   https://developer.apple.com/documentation/webkit/wksnapshotconfiguration

10. Microsoft Learn: `CoreWebView2.CapturePreviewAsync`  
    https://learn.microsoft.com/dotnet/api/microsoft.web.webview2.core.corewebview2.capturepreviewasync

11. WebKitGTK Reference: `WebKitWebView` / snapshot APIs  
    https://webkitgtk.org/reference/webkit2gtk/2.7.1/WebKitWebView.html

12. Apple Developer: SwiftUI Liquid Glass custom views / `glassEffect`  
    https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views

13. Apple Human Interface Guidelines: Materials / Liquid Glass  
    https://developer.apple.com/design/human-interface-guidelines/materials

14. WebKit Bugzilla 198107: WKWebView snapshot may not capture accelerated HTML5 video / WebGL correctly  
    https://bugs.webkit.org/show_bug.cgi?id=198107

---

## 25. 最終建議

我建議 Codex 按下面順序落地：

```txt
1. 前端 WebGL renderer 保留，加入 captureRect-aware texture sampling。
2. Rust 先做 command skeleton。
3. macOS 先做 WKWebView snapshot PoC。
4. same-WebView + hide-before-capture 驗證畫面正確。
5. 加 dirty scheduler、union capture rect、debug metrics。
6. 再拆 separate transparent overlay window。
7. Windows 保留 CSS path，但做 actual rendering probe。
8. Linux 與 iOS 後續逐平台補 snapshot bridge。
9. 若 WebGL/JS decode 成本太高，再評估 raw RGBA 或 WGPU。
10. Apple native Liquid Glass 僅作為 toolbar/sidebar/floating controls 的 optional enhancement。
```

此路線的核心思想是：**在 WebKit 上不要強迫 CSS 做它目前不做的事；利用 Tauri native bridge 取得實際 WebView 畫面，再用我們自己的 GPU shader 控制折射。**
