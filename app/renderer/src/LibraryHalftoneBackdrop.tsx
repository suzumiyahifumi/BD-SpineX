import { useEffect, useRef } from "react";

type HalftoneDot = [number, number, number, number, number, number?];
type LineArtMeta = { image: string };
type HalftoneData = {
  id: string;
  aspect: number;
  dots: HalftoneDot[];
  lineArt?: LineArtMeta;
  lineArtVariants?: Record<string, LineArtMeta>;
};
type HalftoneManifest = {
  characters?: Array<{ id?: string }>;
};
type HalftoneShape = HalftoneData & {
  lineArtImage: HTMLImageElement;
};
type ParticleTarget = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  tone: number;
};
type Particle = ParticleTarget & {
  fromX?: number;
  fromY?: number;
  fromAlpha?: number;
  fromSize?: number;
  scatterX?: number;
  scatterY?: number;
  tx?: number;
  ty?: number;
  targetAlpha?: number;
  targetSize?: number;
  seed: number;
};
type Transition = {
  start: number;
  duration: number;
  fromShape: HalftoneShape;
  nextShape: HalftoneShape;
  nextIndex: number;
};

const LIBRARY_HALFTONE_FALLBACK_IDS = ["000201", "067702", "000101"];
const LIBRARY_HALFTONE_DIR = publicAssetPath("characters/halftone/standing");
const LIBRARY_HALFTONE_MANIFEST = `${LIBRARY_HALFTONE_DIR}/manifest.json`;
const DOT_STRENGTH = 0.35;
const LINE_STRENGTH = 2;
const LINE_WIDTH = 1;
const TRANSITION_DURATION = 4200;
const SETTLED_HOLD_DURATION = 16000;
const INITIAL_HOLD_DURATION = 14000;
const LINE_FADE_IN_DURATION = 3200;
const LINE_FADE_OUT_DURATION = 520;
const DOT_COLORS = {
  red: [226, 64, 42],
  redDeep: [158, 35, 23],
  amber: [232, 162, 44],
  paper: [237, 224, 196]
};

export function LibraryHalftoneBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let frame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let ids = LIBRARY_HALFTONE_FALLBACK_IDS;
    let currentIndex = 0;
    let currentShape: HalftoneShape | null = null;
    let nextAt = 0;
    let lineVisibleSince = 0;
    let loadingTransition = false;
    const shapeCache = new Map<string, HalftoneShape>();
    let particles: Particle[] = [];
    let transition: Transition | null = null;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (currentShape) {
        particles = mapShapeToCanvas(currentShape, width, height).map((target, index) => ({
          ...target,
          seed: hash(index, currentIndex + 7)
        }));
        transition = null;
        lineVisibleSince = performance.now() - LINE_FADE_IN_DURATION;
        draw(performance.now());
      }
    };

    const stopAnimation = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const beginTransition = async (nextIndex: number) => {
      if (!ids[nextIndex] || !currentShape || loadingTransition) return;
      loadingTransition = true;

      try {
        const nextShape = await loadHalftoneShape(ids[nextIndex], shapeCache);
        if (cancelled || !currentShape) return;
        const targets = mapShapeToCanvas(nextShape, width, height);
        const count = Math.max(particles.length, targets.length);
        const nextParticles: Particle[] = [];

        for (let index = 0; index < count; index += 1) {
          const particle = particles[index] ?? createDormantParticle(index, nextIndex, width, height);
          const target = targets[index % targets.length];
          const scatter = scatterPoint(index, particle, width, height);
          nextParticles.push({
            ...particle,
            fromX: particle.x,
            fromY: particle.y,
            fromAlpha: particle.alpha,
            fromSize: particle.size,
            scatterX: scatter.x,
            scatterY: scatter.y,
            tx: target.x,
            ty: target.y,
            targetAlpha: index < targets.length ? target.alpha : 0,
            targetSize: index < targets.length ? target.size : 0,
            tone: index < targets.length ? target.tone : particle.tone,
            seed: particle.seed || hash(index, nextIndex + 7)
          });
        }

        particles = nextParticles;
        const start = performance.now();
        transition = { start, duration: TRANSITION_DURATION, fromShape: currentShape, nextShape, nextIndex };
        nextAt = start + TRANSITION_DURATION + SETTLED_HOLD_DURATION;
      } catch {
        nextAt = performance.now() + SETTLED_HOLD_DURATION;
      } finally {
        loadingTransition = false;
      }
    };

    const tick = (now: number) => {
      if (cancelled) return;
      frame = 0;
      if (transition) updateParticles(now);
      draw(now);

      if (!transition && ids.length && now > nextAt && !loadingTransition) {
        void beginTransition(pickRandomIndex(ids, currentIndex));
      }

      if (!cancelled) frame = window.requestAnimationFrame(tick);
    };

    const updateParticles = (now: number) => {
      if (!transition) return;
      const t = clamp((now - transition.start) / transition.duration, 0, 1);
      const scatterEnd = 0.46;

      for (const particle of particles) {
        const fromX = particle.fromX ?? particle.x;
        const fromY = particle.fromY ?? particle.y;
        const fromAlpha = particle.fromAlpha ?? particle.alpha;
        const fromSize = particle.fromSize ?? particle.size;
        const scatterX = particle.scatterX ?? particle.x;
        const scatterY = particle.scatterY ?? particle.y;
        const tx = particle.tx ?? particle.x;
        const ty = particle.ty ?? particle.y;
        const targetAlpha = particle.targetAlpha ?? particle.alpha;
        const targetSize = particle.targetSize ?? particle.size;
        const phase = (particle.seed % 6283) / 1000;

        if (t < scatterEnd) {
          const q = easeOutCubic(t / scatterEnd);
          const drift = Math.sin(now * 0.01 + phase) * 12 * q;
          particle.x = lerp(fromX, scatterX, q) + drift;
          particle.y = lerp(fromY, scatterY, q) + Math.cos(now * 0.008 + phase) * 9 * q;
          particle.size = lerp(fromSize, Math.max(fromSize, targetSize) * 0.82, q);
          particle.alpha = lerp(fromAlpha, Math.max(0.14, (fromAlpha || targetAlpha) * 0.54), q);
        } else {
          const q = easeOutExpo((t - scatterEnd) / (1 - scatterEnd));
          const settle = Math.sin((1 - q) * Math.PI) * (1 - q);
          particle.x = lerp(scatterX, tx, q) + Math.sin(phase + q * Math.PI) * 22 * settle;
          particle.y = lerp(scatterY, ty, q) + Math.cos(phase + q * Math.PI) * 16 * settle;
          particle.size = lerp(Math.max(fromSize, targetSize) * 0.82, targetSize, q);
          particle.alpha = lerp(Math.max(0.14, targetAlpha * 0.48), targetAlpha, q);
        }
      }

      if (t >= 1) {
        currentIndex = transition.nextIndex;
        currentShape = transition.nextShape;
        transition = null;
        lineVisibleSince = now;
        particles = particles.filter((particle) => particle.targetAlpha === undefined || particle.targetAlpha > 0.01);
      }
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      drawParticles(ctx, particles, now);

      if (transition) {
        const fadeOut = 1 - easeInOutCubic(clamp((now - transition.start) / LINE_FADE_OUT_DURATION, 0, 1));
        drawLineArt(ctx, transition.fromShape, width, height, fadeOut);
      } else {
        const fadeIn = easeInOutCubic(clamp((now - lineVisibleSince) / LINE_FADE_IN_DURATION, 0, 1));
        drawLineArt(ctx, currentShape, width, height, fadeIn);
      }
    };

    void (async () => {
      ids = await loadHalftoneIds();
      if (cancelled) return;
      currentIndex = pickRandomIndex(ids);
      currentShape = await loadHalftoneShape(ids[currentIndex], shapeCache);
      if (cancelled) return;
      resize();
      lineVisibleSince = performance.now() - LINE_FADE_IN_DURATION;
      nextAt = performance.now() + INITIAL_HOLD_DURATION;
      if (!frame) frame = window.requestAnimationFrame(tick);
    })().catch(() => {
      // Keep Library usable if optional background assets fail to load.
    });

    window.addEventListener("resize", resize, { passive: true });

    return () => {
      cancelled = true;
      stopAnimation();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas className="libraryHalftoneBackdrop" ref={canvasRef} aria-hidden="true" />;
}

function publicAssetPath(path: string) {
  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

async function loadHalftoneIds() {
  try {
    const response = await fetch(LIBRARY_HALFTONE_MANIFEST);
    if (!response.ok) throw new Error("Missing halftone manifest");
    const manifest = await response.json() as HalftoneManifest;
    const ids = manifest.characters?.map((character) => character.id).filter(Boolean) as string[] | undefined;
    return ids?.length ? ids : LIBRARY_HALFTONE_FALLBACK_IDS;
  } catch {
    return LIBRARY_HALFTONE_FALLBACK_IDS;
  }
}

function pickRandomIndex(ids: string[], exceptIndex = -1) {
  if (ids.length <= 1) return 0;

  let nextIndex = Math.floor(Math.random() * ids.length);
  while (nextIndex === exceptIndex) {
    nextIndex = Math.floor(Math.random() * ids.length);
  }
  return nextIndex;
}

async function loadHalftoneShape(id: string, cache: Map<string, HalftoneShape>) {
  const cached = cache.get(id);
  if (cached) return cached;

  const response = await fetch(`${LIBRARY_HALFTONE_DIR}/${id}.json`);
  if (!response.ok) throw new Error(`Failed to load halftone data for ${id}`);
  const data = await response.json() as HalftoneData;
  const lineArt = data.lineArtVariants?.posterGhost ?? data.lineArt;
  if (!lineArt?.image) throw new Error(`Missing line art for ${id}`);
  const lineArtImage = await loadImage(`${LIBRARY_HALFTONE_DIR}/${lineArt.image}`);
  const shape = { ...data, lineArtImage };
  cache.set(id, shape);
  return shape;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${src}`));
    image.src = src;
  });
}

function mapShapeToCanvas(shape: HalftoneShape, width: number, height: number): ParticleTarget[] {
  const layout = shapeLayout(shape, width, height);
  return shape.dots.map((dot) => ({
    x: layout.left + dot[0] * layout.shapeWidth,
    y: layout.top + dot[1] * layout.shapeHeight,
    size: layout.baseSize * dot[2],
    alpha: dot[3],
    tone: dot[4]
  }));
}

function shapeLayout(shape: HalftoneShape, width: number, height: number) {
  const aspect = shape.aspect || 1;
  const isCompact = width < 760;
  let shapeHeight = isCompact
    ? Math.max(height * 1.04, (width * 1.18) / aspect)
    : Math.max(height * 1.16, (width * 0.74) / aspect);
  shapeHeight = Math.min(shapeHeight, height * (isCompact ? 1.22 : 1.58));
  const shapeWidth = shapeHeight * aspect;
  const centerX = width * (isCompact ? 0.56 : 0.68);
  const centerY = height * (isCompact ? 0.62 : 0.58);
  const left = centerX - shapeWidth * 0.5;
  const top = centerY - shapeHeight * 0.5;
  const baseSize = clamp(shapeHeight / 132, 2.6, 9.5);
  return { left, top, shapeWidth, shapeHeight, baseSize };
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[], now: number) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const particle of particles) {
    const particleAlpha = particle.alpha * DOT_STRENGTH;
    if (particleAlpha <= 0.01 || particle.size <= 0.1) continue;

    const pulse = 1 + Math.sin(now * 0.0024 + particle.seed) * 0.025;
    const size = particle.size * pulse;
    const x = Math.round(particle.x - size * 0.5);
    const y = Math.round(particle.y - size * 0.5);
    const color = particle.tone === 2 ? DOT_COLORS.amber : particle.tone === 1 ? DOT_COLORS.redDeep : DOT_COLORS.red;

    if (particle.tone !== 1) {
      fillRect(ctx, x + size * 0.34, y + size * 0.34, size, size, DOT_COLORS.redDeep, particleAlpha * 0.34);
    }
    fillRect(ctx, x, y, size, size, color, particleAlpha);

    if (size > 7) {
      fillRect(ctx, x + 1, y + 1, Math.max(1, size - 2), 1, DOT_COLORS.paper, particleAlpha * 0.05);
      fillRect(ctx, x + 1, y + Math.max(1, size - 2), Math.max(1, size - 2), 1, DOT_COLORS.redDeep, particleAlpha * 0.11);
    }
  }
  ctx.restore();
}

function drawLineArt(ctx: CanvasRenderingContext2D, shape: HalftoneShape | null | undefined, width: number, height: number, visibility: number) {
  if (!shape?.lineArtImage || visibility <= 0) return;
  const layout = shapeLayout(shape, width, height);
  const opacity = clamp(LINE_STRENGTH * 0.82 * visibility, 0, 1);
  const spread = Math.max(0, LINE_WIDTH - 0.76) * Math.max(1, layout.baseSize * 0.18);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;

  if (spread > 0.18) {
    const offsets = [
      [-spread, 0],
      [spread, 0],
      [0, -spread],
      [0, spread]
    ];
    ctx.globalAlpha = opacity * 0.18;
    for (const [offsetX, offsetY] of offsets) {
      ctx.drawImage(shape.lineArtImage, layout.left + offsetX, layout.top + offsetY, layout.shapeWidth, layout.shapeHeight);
    }
  }

  ctx.globalAlpha = opacity;
  ctx.drawImage(shape.lineArtImage, layout.left, layout.top, layout.shapeWidth, layout.shapeHeight);
  ctx.restore();
}

function fillRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: number[], alpha: number) {
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
  ctx.fillRect(x, y, width, height);
}

function createDormantParticle(index: number, nextIndex: number, width: number, height: number): Particle {
  const edge = randomEdgePoint(hash(index, nextIndex + 3), width, height);
  return {
    x: edge.x,
    y: edge.y,
    alpha: 0,
    size: 0,
    tone: 0,
    seed: hash(index, nextIndex + 7)
  };
}

function scatterPoint(index: number, particle: Particle, width: number, height: number) {
  const centerX = width * (width < 760 ? 0.54 : 0.62);
  const centerY = height * 0.54;
  const dx = particle.x - centerX;
  const dy = particle.y - centerY;
  const length = Math.hypot(dx, dy) || 1;
  const scatterDistance = lerp(96, 280, seeded(index, 11)) * (width < 760 ? 0.7 : 1);
  const randomX = lerp(-140, 160, seeded(index, 17)) * (width < 760 ? 0.62 : 1);
  const randomY = lerp(-120, 130, seeded(index, 23)) * (height < 720 ? 0.72 : 1);
  const margin = Math.max(90, Math.min(width, height) * 0.14);

  return {
    x: clamp(particle.x + (dx / length) * scatterDistance + randomX, -margin, width + margin),
    y: clamp(particle.y + (dy / length) * scatterDistance + randomY, -margin, height + margin)
  };
}

function randomEdgePoint(seed: number, width: number, height: number) {
  const a = seeded(seed, 1);
  const b = seeded(seed, 2);
  const side = Math.floor(a * 4);
  const margin = Math.max(80, Math.min(width, height) * 0.14);
  if (side === 0) return { x: width * b, y: -margin };
  if (side === 1) return { x: width + margin, y: height * b };
  if (side === 2) return { x: width * b, y: height + margin };
  return { x: -margin, y: height * b };
}

function seeded(a: number, b: number) {
  return (hash(a, b) % 100000) / 100000;
}

function hash(a: number, b: number) {
  let value = (Math.imul((a + 0x9e3779b9) >>> 0, 2654435761) ^ Math.imul((b + 0x85ebca6b) >>> 0, 2246822519)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 2246822507) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 3266489909) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function easeOutCubic(t: number) {
  return 1 - ((1 - t) ** 3);
}

function easeOutExpo(t: number) {
  return t === 1 ? 1 : 1 - (2 ** (-10 * t));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
