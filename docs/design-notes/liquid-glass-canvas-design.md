# Liquid Glass Canvas/WebGL 方案設計稿

> 目的：把 Kube 文章中的 CSS/SVG liquid glass 思路延伸成一套可在 WebKit/Safari 也能有高品質視覺效果、並能即時反應頁面變化的 Canvas/WebGL 方案。  
> 建議使用者：前端工程師、設計工程師、準備交給 Codex / GitHub Copilot / AI coding agent 實作的人。  
> 日期：2026-06-19  
> 語言：TypeScript + WebGL2 + CSS fallback

---

## 1. 背景與問題定義

參考文章：Kube 的 **Liquid Glass in the Browser: Refraction with CSS and SVG**。該文章用 SVG displacement map、`feDisplacementMap`、specular highlight 與 `backdrop-filter: url(#filter)` 做出非常接近 Apple Liquid Glass 的折射效果。

問題是：這條 CSS/SVG 路線主要在 Chromium 類瀏覽器可用，因為 Safari/WebKit 目前無法穩定把 SVG filter URL 用在 `backdrop-filter` 上，尤其是需要 `feDisplacementMap` 的情境。

因此，若目標是 WebKit/Safari 也有接近同等級的液態玻璃效果，不能只依賴：

```css
backdrop-filter: url(#liquidGlassFilter);
-webkit-backdrop-filter: url(#liquidGlassFilter);
```

需要改成：

1. DOM 負責排版、文字、互動、accessibility。
2. Canvas/WebGL 負責折射、模糊、色散、邊緣高光。
3. 背景由 app state / canvas renderer / video / image / chart source 同步畫進 texture。
4. WebKit/Safari 走同一套 shader，不依賴 SVG `backdrop-filter`。

---

## 2. 研究結論摘要

### 2.1 Kube CSS/SVG 方案的核心

Kube 文章的關鍵做法：

- 用 refraction model 計算像素偏移。
- 把偏移轉成 displacement map。
- 使用 SVG `feDisplacementMap` 讓 R/G channel 分別代表 X/Y displacement。
- 用 `backdrop-filter: url(#filter)` 把 displacement 套到玻璃元素背後的像素。
- 疊加 specular highlight / rim light，讓邊緣像真玻璃。

概念上可以寫成：

```svg
<filter id="liquidGlassFilter">
  <feImage href="/displacement-map.png" result="map" />
  <feDisplacementMap
    in="SourceGraphic"
    in2="map"
    scale="24"
    xChannelSelector="R"
    yChannelSelector="G"
  />
</filter>
```

```css
.glass-panel {
  backdrop-filter: url(#liquidGlassFilter);
}
```

### 2.2 跨瀏覽器限制

截至本設計稿撰寫時，基本 `backdrop-filter: blur()` 已經可以在多數主流瀏覽器使用，但「SVG filter URL + backdrop-filter + displacement」不是同一件事。

重點：

- `backdrop-filter` 的職責是對元素後方像素套用濾鏡。
- `filter: url(#filter)` 通常只處理元素自己的 rendering output。
- `backdrop-filter: url(#svgFilter)` 在 Safari/WebKit 上仍有相容性問題。
- WebKit Bugzilla issue `245510` 仍記錄 `backdrop-filter: url(#some-svg-filter)` 搭配 `feDisplacementMap` 不工作的問題。
- 單純加 `-webkit-` 前綴不足以解決 `url(#filter)` displacement 的問題。

### 2.3 為什麼 Canvas/WebGL 是合理替代

Liquid Glass 的視覺本質是：

```txt
對背景 texture 做 per-pixel displaced sampling
+ 局部 blur
+ chromatic aberration
+ rounded-rect mask
+ rim/specular highlight
```

這正是 fragment shader 擅長的事。WebGL2 讓 `<canvas>` 有 OpenGL ES 3.0 類型的 rendering context，因此可以用 GPU 對背景 texture 做即時折射。

---

## 3. 重要限制：一般網頁不能任意讀取 DOM 背後像素

這是整個設計的最重要取捨。

瀏覽器沒有提供一個安全、無授權、可每幀讀取「目前頁面任意 DOM 實際渲染結果」的 API。CSS `backdrop-filter` 是瀏覽器內部管線可以做的事情，但 JavaScript/Canvas 不能直接拿到同一份 backdrop buffer。

因此，如果要 Canvas/WebGL 及時反應頁面變化，有三種策略：

| 策略 | 即時性 | 準確度 | 適合程度 | 說明 |
|---|---:|---:|---:|---|
| App state 同步重畫背景 texture | 高 | 高 | 最推薦 | UI 背景由資料/state 產生，DOM 與 Canvas 共用同一份 state。 |
| 背景本身改成 Canvas/WebGL source | 高 | 高 | 最推薦 | hero、particles、chart、video、animated gradient 都適合。 |
| html2canvas 類工具 snapshot DOM | 中低 | 中低 | fallback | 不是真正 screenshot，CSS/iframe/cross-origin/media 可能失真。 |
| getDisplayMedia 擷取畫面 | 高 | 高 | 不適合一般 UI | 會要求使用者授權，不應用在普通網頁特效。 |

結論：正式產品應該把「可被折射的背景」設計成 renderer 可控的 source，而不是試圖從 DOM 偷讀像素。

---

## 4. 推薦架構

```txt
App State / Page Events
        │
        ├── DOM Layer
        │     ├── 真正文字
        │     ├── 按鈕 / 表單 / focus / accessibility
        │     └── glass card 的內容與 layout
        │
        ├── Backdrop Pipeline
        │     ├── GradientSource
        │     ├── ImageSource
        │     ├── VideoSource
        │     ├── CanvasSource
        │     ├── ChartSource
        │     └── Optional DOMSnapshotSource
        │
        └── WebGL LiquidGlass Compositor
              ├── background texture
              ├── glass rect registry
              ├── displacement shader
              ├── rounded rect mask
              ├── blur / chromatic aberration
              └── transparent fullscreen canvas overlay
```

### Layering

```html
<body>
  <main id="page">
    <!-- 普通頁面內容。可以包含背景 DOM，但真正被折射的背景要同步到 canvas source。 -->
  </main>

  <canvas id="liquid-glass-canvas" aria-hidden="true"></canvas>

  <section class="glass-card" data-liquid-glass>
    <h2>Liquid Glass</h2>
    <p>這裡仍然是 DOM，不是 canvas 文字。</p>
    <button>Action</button>
  </section>
</body>
```

```css
#page {
  position: relative;
  z-index: 0;
  min-height: 200vh;
}

#liquid-glass-canvas {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100svh;
  z-index: 10;
  pointer-events: none;
}

[data-liquid-glass] {
  position: relative;
  z-index: 20;
  border-radius: var(--glass-radius, 28px);
  background: transparent;
  overflow: hidden;

  /* DOM 只保留非折射材質；真正折射由 WebGL canvas 畫。 */
  box-shadow:
    0 24px 70px rgb(0 0 0 / 0.24),
    inset 0 0 0 1px rgb(255 255 255 / 0.45),
    inset 0 1px 2px rgb(255 255 255 / 0.7),
    inset 0 -1px 2px rgb(0 0 0 / 0.18);
}
```

---

## 5. 渲染管線

每一幀的流程：

```txt
requestAnimationFrame(time)
  1. 檢查 viewport / DPR / scroll 是否變化
  2. 更新每個 glass element 的 getBoundingClientRect()
  3. 若 backdrop dirty：
       a. 清空 hidden backdrop canvas
       b. 依序呼叫 BackdropSource.draw(ctx, viewport)
       c. upload hidden canvas to WebGL texture
  4. 清空 fullscreen transparent WebGL canvas
  5. 對每個可見 glass rect draw 一個 quad
  6. fragment shader：
       a. rounded-rect mask
       b. 依照 local position 產生 refraction offset
       c. sample background texture
       d. 9-tap blur
       e. chromatic aberration
       f. rim/specular highlight
       g. 輸出 RGBA
```

---

## 6. TypeScript API 設計

### 6.1 Public API 草案

```ts
const liquid = createLiquidGlass({
  canvas: '#liquid-glass-canvas',
  dprCap: 2,
  animateBackdrop: false,
  sources: [
    new GradientSource({ /* ... */ }),
    new ImageSource('/hero-bg.jpg'),
    new ParticleSource(particleStore),
  ],
});

liquid.attach('[data-liquid-glass]', {
  radius: 28,
  refract: 1.0,
  blur: 8,
  opacity: 0.97,
  chromatic: 1.6,
});

liquid.start();

// App state / data / theme 改變時呼叫：
liquid.invalidateBackdrop();

// SPA route unmount 時呼叫：
liquid.destroy();
```

### 6.2 型別草案

```ts
export interface LiquidGlassOptions {
  canvas: string | HTMLCanvasElement;
  dprCap?: number;
  animateBackdrop?: boolean;
  sources?: BackdropSource[];
  fallbackClassName?: string;
}

export interface GlassOptions {
  radius?: number;
  refract?: number;
  blur?: number;
  opacity?: number;
  chromatic?: number;
  tint?: number;
  highlight?: number;
}

export interface ViewportState {
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  time: number;
}

export interface BackdropSource {
  readonly animate?: boolean;
  load?(): Promise<void> | void;
  update?(state: ViewportState): void;
  draw(ctx: CanvasRenderingContext2D, state: ViewportState): void;
  destroy?(): void;
}

export interface LiquidGlassController {
  attach(target: string | Element | Element[], options?: GlassOptions): () => void;
  invalidateBackdrop(): void;
  invalidateLayout(): void;
  start(): void;
  stop(): void;
  destroy(): void;
}
```

---

## 7. 建議檔案結構

```txt
src/liquid-glass/
  index.ts
  createLiquidGlass.ts
  LiquidGlassRenderer.ts
  GlassRegistry.ts
  BackdropPipeline.ts
  sources/
    GradientSource.ts
    ImageSource.ts
    VideoSource.ts
    CanvasSource.ts
    FunctionSource.ts
    DOMSnapshotSource.ts      # optional, lazy import html2canvas
  webgl/
    createProgram.ts
    createTexture.ts
    shaders.ts
    types.ts
  css/
    liquid-glass.css
  utils/
    resolveCanvas.ts
    rafLoop.ts
    dpr.ts
    featureDetect.ts
examples/
  vanilla/
    index.html
    main.ts
  react/
    LiquidGlassProvider.tsx
    useLiquidGlass.ts
```

---

## 8. 核心 Renderer 骨架

下面是可交給 Codex 擴充的 TypeScript 骨架。此版本保留必要設計，不一定是最終完整實作。

```ts
export class LiquidGlassRenderer implements LiquidGlassController {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly registry = new GlassRegistry();
  private readonly pipeline: BackdropPipeline;

  private backdropCanvas: HTMLCanvasElement;
  private backdropCtx: CanvasRenderingContext2D;
  private texture: WebGLTexture | null = null;
  private program: WebGLProgram | null = null;

  private dpr = 1;
  private dprCap: number;
  private running = false;
  private dirtyBackdrop = true;
  private dirtyLayout = true;
  private animateBackdrop = false;

  constructor(options: LiquidGlassOptions) {
    this.canvas = resolveCanvas(options.canvas);
    this.dprCap = options.dprCap ?? 2;
    this.animateBackdrop = options.animateBackdrop ?? false;
    this.pipeline = new BackdropPipeline(options.sources ?? []);

    this.backdropCanvas = document.createElement('canvas');
    const ctx = this.backdropCanvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Cannot create 2D backdrop context.');
    this.backdropCtx = ctx;

    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });

    if (!this.gl) {
      this.canvas.classList.add('liquid-glass--no-webgl');
      return;
    }

    this.initWebGL();
    this.bindEvents();
    this.resize();
  }

  attach(target: string | Element | Element[], options: GlassOptions = {}) {
    const elements = resolveElements(target);
    const disposers = elements.map((el) => {
      this.registry.add(el, options);
      const ro = new ResizeObserver(() => this.invalidateLayout());
      ro.observe(el);
      this.invalidateLayout();
      return () => {
        ro.disconnect();
        this.registry.remove(el);
        this.invalidateLayout();
      };
    });

    return () => disposers.forEach((dispose) => dispose());
  }

  invalidateBackdrop() {
    this.dirtyBackdrop = true;
  }

  invalidateLayout() {
    this.dirtyLayout = true;
  }

  start() {
    if (this.running || !this.gl) return;
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
  }

  destroy() {
    this.stop();
    this.registry.destroy();
    this.pipeline.destroy();
    // TODO: delete WebGL resources.
  }

  private frame = (time: number) => {
    if (!this.running) return;
    this.render(time);
    requestAnimationFrame(this.frame);
  };

  private render(time: number) {
    const gl = this.gl;
    if (!gl || !this.program || !this.texture) return;

    if (this.dirtyLayout) {
      this.registry.updateRects();
      this.dirtyLayout = false;
    }

    if (this.dirtyBackdrop || this.animateBackdrop || this.pipeline.hasAnimatedSource()) {
      this.updateBackdrop(time);
      this.dirtyBackdrop = false;
    }

    this.drawGlasses(time);
  }

  private updateBackdrop(time: number) {
    const state = this.getViewportState(time);
    const ctx = this.backdropCtx;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    this.pipeline.draw(ctx, state);
    ctx.restore();

    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.backdropCanvas,
    );
  }

  private drawGlasses(time: number) {
    // TODO: bind program, uniforms, texture, quad buffer, loop visible rects.
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const width = Math.round(window.innerWidth * this.dpr);
    const height = Math.round(window.innerHeight * this.dpr);

    this.canvas.width = width;
    this.canvas.height = height;
    this.backdropCanvas.width = width;
    this.backdropCanvas.height = height;

    this.gl?.viewport(0, 0, width, height);

    this.invalidateLayout();
    this.invalidateBackdrop();
  }

  private bindEvents() {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener(
      'scroll',
      () => {
        this.invalidateLayout();
        this.invalidateBackdrop();
      },
      { passive: true },
    );
  }

  private getViewportState(time: number): ViewportState {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: this.dpr,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      time,
    };
  }

  private initWebGL() {
    // TODO: create shader program, quad buffer, texture, uniforms.
  }
}
```

---

## 9. Shader 原型

### 9.1 Vertex shader

```ts
export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aLocal;

uniform vec2 uResolution;
uniform vec4 uRect;

out vec2 vLocal;
out vec2 vScreenUv;

void main() {
  vec2 px = uRect.xy + aLocal * uRect.zw;

  vec2 clip = vec2(
    px.x / uResolution.x * 2.0 - 1.0,
    1.0 - px.y / uResolution.y * 2.0
  );

  gl_Position = vec4(clip, 0.0, 1.0);
  vLocal = aLocal;
  vScreenUv = px / uResolution;
}
`;
```

### 9.2 Fragment shader

```ts
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2 uResolution;
uniform vec4 uRect;
uniform float uRadius;
uniform float uTime;
uniform float uRefract;
uniform float uBlurPx;
uniform float uOpacity;
uniform float uChromatic;
uniform float uTint;
uniform float uHighlight;

in vec2 vLocal;
in vec2 vScreenUv;

out vec4 outColor;

float sdRoundRect(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + vec2(radius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

vec4 sampleBackdrop(vec2 uv) {
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  return texture(uBackdrop, uv);
}

vec4 blurBackdrop(vec2 uv, float blurPx) {
  vec2 o = vec2(blurPx) / uResolution;
  vec4 c = vec4(0.0);

  c += sampleBackdrop(uv) * 0.28;

  c += sampleBackdrop(uv + vec2( o.x, 0.0)) * 0.10;
  c += sampleBackdrop(uv + vec2(-o.x, 0.0)) * 0.10;
  c += sampleBackdrop(uv + vec2(0.0,  o.y)) * 0.10;
  c += sampleBackdrop(uv + vec2(0.0, -o.y)) * 0.10;

  c += sampleBackdrop(uv + vec2( o.x,  o.y) * 0.75) * 0.08;
  c += sampleBackdrop(uv + vec2(-o.x,  o.y) * 0.75) * 0.08;
  c += sampleBackdrop(uv + vec2( o.x, -o.y) * 0.75) * 0.08;
  c += sampleBackdrop(uv + vec2(-o.x, -o.y) * 0.75) * 0.08;

  return c;
}

void main() {
  vec2 size = uRect.zw;
  vec2 pPx = (vLocal - 0.5) * size;

  float dist = sdRoundRect(pPx, size * 0.5, uRadius);
  float outerAlpha = 1.0 - smoothstep(0.0, 1.5, dist);
  if (outerAlpha <= 0.0) discard;

  float inside = max(-dist, 0.0);
  float edge = 1.0 - smoothstep(0.0, 42.0, inside);

  vec2 p = vLocal * 2.0 - 1.0;
  float len = length(p);

  // Center lens: 中央透鏡感。
  vec2 centerLens = p * (1.0 - len * 0.32) * 9.0;

  // Edge normal: 邊緣與圓角折射最強。
  vec2 edgeNormal = normalize(p + vec2(0.0001)) * edge * 34.0;

  // Micro ripple: 輕微流動，建議用低強度，避免廉價水波感。
  vec2 ripple = vec2(
    sin(p.y * 18.0 + uTime * 0.0011),
    cos(p.x * 16.0 - uTime * 0.0009)
  ) * 2.2;

  vec2 offsetPx = (centerLens + edgeNormal + ripple) * uRefract;
  vec2 dir = normalize(offsetPx + vec2(0.0001));
  vec2 uv = vScreenUv + offsetPx / uResolution;

  vec4 base = blurBackdrop(uv, uBlurPx);

  // Chromatic aberration: 邊緣色散。
  float ca = edge * uChromatic;
  float r = sampleBackdrop(uv + dir * ca / uResolution).r;
  float g = base.g;
  float b = sampleBackdrop(uv - dir * ca / uResolution).b;

  vec3 color = vec3(r, g, b);

  // Glass tint and luminance lift.
  color = mix(color, vec3(1.0), uTint);
  color *= 1.08;

  // Specular / rim light.
  float topShine = smoothstep(1.0, -0.2, p.y) *
                   smoothstep(1.1, -0.1, abs(p.x)) *
                   0.12;
  float rim = edge * 0.22;

  color += vec3(topShine + rim) * uHighlight;

  outColor = vec4(color, outerAlpha * uOpacity);
}
`;
```

### 9.3 可調參數建議

| Uniform | 建議範圍 | 說明 |
|---|---:|---|
| `uRefract` | `0.4–1.4` | 整體折射強度。太大會像果凍。 |
| `uBlurPx` | `4–12` | 玻璃下方模糊程度。移動裝置可降低。 |
| `uChromatic` | `0.5–2.5` | 色散。只應在邊緣明顯。 |
| `uTint` | `0.05–0.16` | 白色/亮色 tint。 |
| `uHighlight` | `0.6–1.4` | rim/specular highlight 強度。 |
| `uRadius` | DOM border-radius * DPR | 必須與 CSS radius 對齊。 |

---

## 10. BackdropSource 設計

### 10.1 GradientSource

```ts
export class GradientSource implements BackdropSource {
  constructor(
    private readonly stops: Array<{ offset: number; color: string }>,
  ) {}

  draw(ctx: CanvasRenderingContext2D, state: ViewportState) {
    const gradient = ctx.createLinearGradient(0, 0, state.width, state.height);
    for (const stop of this.stops) {
      gradient.addColorStop(stop.offset, stop.color);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, state.width, state.height);
  }
}
```

### 10.2 ImageSource

```ts
export class ImageSource implements BackdropSource {
  private image = new Image();
  private loaded = false;

  constructor(private readonly src: string) {
    this.image.crossOrigin = 'anonymous';
  }

  async load() {
    await new Promise<void>((resolve, reject) => {
      this.image.onload = () => {
        this.loaded = true;
        resolve();
      };
      this.image.onerror = () => reject(new Error(`Cannot load image: ${this.src}`));
      this.image.src = this.src;
    });
  }

  draw(ctx: CanvasRenderingContext2D, state: ViewportState) {
    if (!this.loaded) return;
    // TODO: implement object-fit: cover.
    ctx.drawImage(this.image, 0, 0, state.width, state.height);
  }
}
```

### 10.3 FunctionSource

最適合和 app state / React / Vue / Svelte 整合。

```ts
export class FunctionSource implements BackdropSource {
  constructor(
    private readonly drawFn: (ctx: CanvasRenderingContext2D, state: ViewportState) => void,
    public readonly animate = false,
  ) {}

  draw(ctx: CanvasRenderingContext2D, state: ViewportState) {
    this.drawFn(ctx, state);
  }
}
```

使用：

```ts
const source = new FunctionSource((ctx, state) => {
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, state.width, state.height);

  // 根據 app state 畫 cards / chart / particle / hero visual。
  for (const item of store.items) {
    ctx.fillStyle = item.color;
    ctx.fillRect(item.x, item.y - state.scrollY, item.width, item.height);
  }
});
```

---

## 11. 即時反應頁面變化的策略

### 11.1 State-driven invalidation

最佳實作：DOM 與 Canvas backdrop 共用同一份資料。

```ts
store.subscribe(() => {
  liquid.invalidateBackdrop();
});
```

React：

```tsx
useEffect(() => {
  liquid.invalidateBackdrop();
}, [items, theme, heroImage, chartData]);
```

Vue：

```ts
watch([items, theme, chartData], () => {
  liquid.invalidateBackdrop();
}, { deep: true });
```

### 11.2 Layout-driven invalidation

```ts
const resizeObserver = new ResizeObserver(() => {
  liquid.invalidateLayout();
});

for (const el of document.querySelectorAll('[data-liquid-glass]')) {
  resizeObserver.observe(el);
}
```

### 11.3 DOM mutation fallback

`MutationObserver` 只能告訴你 DOM 變了，不會給你像素。若搭配 `DOMSnapshotSource`，可以用它觸發節流 snapshot。

```ts
const observer = new MutationObserver(() => {
  domSnapshotSource.scheduleSnapshot();
});

observer.observe(document.querySelector('#page')!, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});
```

### 11.4 html2canvas fallback 注意事項

只建議作為 fallback：

```ts
export class DOMSnapshotSource implements BackdropSource {
  private snapshot: HTMLCanvasElement | null = null;
  private pending = false;
  private lastSnapshotTime = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly minIntervalMs = 160,
  ) {}

  async scheduleSnapshot() {
    const now = performance.now();
    if (this.pending || now - this.lastSnapshotTime < this.minIntervalMs) return;

    this.pending = true;
    this.lastSnapshotTime = now;

    try {
      const { default: html2canvas } = await import('html2canvas');
      this.snapshot = await html2canvas(this.target, {
        backgroundColor: null,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        useCORS: true,
      });
    } finally {
      this.pending = false;
    }
  }

  draw(ctx: CanvasRenderingContext2D, state: ViewportState) {
    if (!this.snapshot) return;
    ctx.drawImage(this.snapshot, 0, 0, state.width, state.height);
  }
}
```

注意：不要每幀跑 html2canvas。建議節流到 `120–250ms` 以上，而且只在 demo / fallback 使用。

---

## 12. WebKit/Safari fallback 策略

建議分三層：

```txt
Tier 1: WebGL2 liquid glass
  - Safari / Chrome / Firefox 都走同一套 canvas shader。
  - 最推薦的正式方案。

Tier 2: CSS duplicated-background + filter:url(#svgFilter)
  - 背景是固定 image/gradient 時可用。
  - 不能處理任意 DOM。

Tier 3: CSS frosted glass
  - 使用 blur/saturate/brightness + rim/inset shadow。
  - 當 WebGL 不可用或使用者 prefers-reduced-motion 時使用。
```

CSS fallback：

```css
.liquid-glass--fallback [data-liquid-glass],
.liquid-glass--no-webgl [data-liquid-glass] {
  background:
    linear-gradient(
      135deg,
      rgb(255 255 255 / 0.32),
      rgb(255 255 255 / 0.08)
    );

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
}

.liquid-glass--fallback [data-liquid-glass]::before,
.liquid-glass--no-webgl [data-liquid-glass]::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background:
    radial-gradient(
      100% 80% at 20% 0%,
      rgb(255 255 255 / 0.62),
      transparent 42%
    ),
    linear-gradient(
      135deg,
      rgb(255 255 255 / 0.36),
      transparent 44%,
      rgb(255 255 255 / 0.12)
    );
  mix-blend-mode: screen;
}
```

---

## 13. 效能預算

| 項目 | 建議 |
|---|---|
| DPR | desktop cap `2`; mobile cap `1.5` 或 `2`。 |
| 同畫面 glass 數量 | 大面積玻璃少於 10 個。 |
| blur | 先用 9-tap shader blur；要更高品質再做 mipmap / dual Kawase blur。 |
| backdrop update | 靜態背景只 dirty update；動畫背景才每幀 update。 |
| DOM snapshot | 僅 fallback，節流 `120–250ms`。 |
| scroll | scroll 時更新 rect 與 backdrop offset，不要重建 renderer。 |
| visibility | `rect` 不在 viewport 內就 skip draw。 |
| hover | hover 只更新 uniform，不重畫 backdrop。 |
| prefers-reduced-motion | 停用 ripple 或降低 time-based movement。 |

---

## 14. Accessibility / UX 注意事項

1. Canvas 必須 `aria-hidden="true"`。
2. 真正可互動內容保留在 DOM，不要把文字和按鈕畫進 canvas。
3. `pointer-events: none` 避免 canvas 阻擋點擊。
4. `prefers-reduced-motion: reduce` 時關閉 ripple。
5. 保持足夠文字對比；玻璃下方背景太複雜時要加 content scrim。
6. 玻璃元素內的 focus ring 不要被 canvas 覆蓋；z-index 要讓 DOM content 在 canvas 上方。

---

## 15. 測試矩陣

### Browser

- Safari 最新穩定版 macOS
- Safari iOS / iPadOS
- Chrome 最新穩定版
- Edge 最新穩定版
- Firefox 最新穩定版

### Device

- M-series MacBook
- Intel Mac / older integrated GPU
- iPhone Safari
- iPad Safari
- Android Chrome
- Windows laptop with integrated GPU

### Scenario

- 背景靜態圖片
- 背景 animated gradient
- 背景 video
- 背景 chart / dashboard data update
- 長頁 scroll
- glass element resize
- route transition
- dark/light theme switch
- prefers-reduced-motion
- WebGL context lost / restored

---

## 16. Codex 實作里程碑

### Milestone 1：Vanilla MVP

目標：跑出第一個 WebGL liquid glass card。

任務：

1. 建立 `src/liquid-glass` 模組。
2. 實作 `createProgram`, `createTexture`, `createQuadBuffer`。
3. 實作上述 vertex/fragment shader。
4. 實作 fullscreen canvas overlay。
5. 實作 `FunctionSource` 畫 animated gradient / circles。
6. 實作 `attach('[data-liquid-glass]')`。
7. 在 `examples/vanilla` 建立 demo。

驗收：

- 卡片位置正確。
- 圓角 mask 正確。
- 背景有折射、blur、rim highlight。
- scroll/resize 後卡片位置仍正確。

### Milestone 2：BackdropPipeline

任務：

1. 實作 `GradientSource`。
2. 實作 `ImageSource` with object-fit cover。
3. 實作 `VideoSource`。
4. 實作 source loading 與 error handling。
5. 加上 `pipeline.hasAnimatedSource()`。

驗收：

- 靜態 source 不每幀重傳 texture。
- video source 可每幀更新。
- source load fail 不 crash。

### Milestone 3：Performance pass

任務：

1. 加 viewport culling。
2. 加 DPR cap。
3. 加 `prefers-reduced-motion`。
4. 加 `document.visibilityState` 暫停。
5. 加 WebGL resource cleanup。
6. 加 context lost / restored handling。

驗收：

- Safari 上 scroll 不明顯掉幀。
- hidden tab 不繼續 render。
- destroy 後沒有 observer / event listener leak。

### Milestone 4：Framework adapters

任務：

1. React `LiquidGlassProvider`。
2. React `useLiquidGlass(ref, options)`。
3. Vue composable `useLiquidGlass()`。
4. 文件化 state-driven invalidation。

驗收：

- React/Vue route 切換不 leak。
- app state 更新能觸發 backdrop redraw。

### Milestone 5：Optional DOMSnapshotSource

任務：

1. lazy import `html2canvas`。
2. MutationObserver + throttled snapshot。
3. 標記成 experimental fallback。
4. 清楚警告不保證 pixel-perfect。

驗收：

- DOM 變更後 120–250ms 內反應。
- 複雜 DOM 失真時 fallback 不 crash。

---

## 17. 建議給 Codex 的第一段 prompt

可以直接把以下 prompt 交給 Codex：

```txt
請根據 `liquid-glass-canvas-design.md` 實作一個 TypeScript LiquidGlass WebGL2 library。

請先完成 Milestone 1：Vanilla MVP。

需求：
1. 建立 `src/liquid-glass` 模組。
2. 實作 `createLiquidGlass(options)`，回傳 controller。
3. 使用 fullscreen fixed canvas overlay，pointer-events none。
4. 使用 hidden 2D canvas 畫 backdrop source，再 upload 到 WebGL texture。
5. 使用文件中的 vertex shader / fragment shader。
6. 支援 `attach('[data-liquid-glass]', options)`。
7. 支援 scroll/resize/ResizeObserver。
8. 加入 CSS fallback class，但 Milestone 1 可先不做完整 fallback。
9. 在 `examples/vanilla/index.html` 做一個 demo：animated gradient 背景 + 兩張玻璃卡片。
10. 程式碼要有型別、錯誤處理、destroy cleanup。

請不要使用 `backdrop-filter: url(#svgFilter)` 作為主要效果，因為 Safari/WebKit 不可靠。主要效果必須由 WebGL shader 產生。
```

---

## 18. 風險與決策記錄

### Decision 1：不直接擷取任意 DOM

理由：瀏覽器沒有提供無授權、可每幀讀取任意 DOM 實際渲染結果的 API。直接依賴 DOM snapshot 會有準確度、效能與安全限制。

### Decision 2：把背景改成 source pipeline

理由：只要背景由 app state / canvas / image / video / chart source 組成，就可以穩定重建 backdrop texture，並讓玻璃即時折射。

### Decision 3：Canvas overlay 只畫玻璃材質，不畫內容

理由：保留 DOM accessibility、selection、focus、input、SEO 與 pointer interaction。

### Decision 4：WebGL2 優先，CSS fallback 保底

理由：WebGL2 shader 最接近真折射；CSS fallback 在低階裝置、WebGL 不可用、或 reduced motion 下保證可用性。

---

## 19. 參考來源

- Kube: Liquid Glass in the Browser: Refraction with CSS and SVG  
  https://kube.io/blog/liquid-glass-css-svg/

- WebKit Bugzilla 245510: `backdrop-filter: url(#some-svg-filter)` does not work with SVG filters like `feDisplacementMap`  
  https://bugs.webkit.org/show_bug.cgi?id=245510

- MDN: `backdrop-filter` CSS property  
  https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter

- MDN: WebGL2RenderingContext  
  https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext

- MDN: ResizeObserver  
  https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver

- MDN: OffscreenCanvas  
  https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas

- MDN: MediaDevices.getDisplayMedia  
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

- html2canvas documentation  
  https://html2canvas.hertzen.com/documentation.html

---

## 20. 最終建議

正式實作時，請把這個效果視為一個 **WebGL compositor**，不是 CSS trick。

最穩定的產品路線是：

```txt
DOM content remains real DOM
+ Backdrop is generated from controlled sources
+ WebGL shader handles refraction
+ CSS frosted glass fallback protects compatibility
```

這樣可以避開 WebKit/Safari 對 SVG `backdrop-filter` 的限制，同時保留足夠接近 Liquid Glass 的視覺品質與互動即時性。
