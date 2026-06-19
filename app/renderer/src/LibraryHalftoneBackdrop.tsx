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
  chaosX?: number;
  chaosY?: number;
  tx?: number;
  ty?: number;
  targetAlpha?: number;
  targetSize?: number;
  seed: number;
};
type Transition = {
  start: number;
  duration: number;
};

const LIBRARY_HALFTONE_IDS = ["000201", "067702", "000101"];
const LIBRARY_HALFTONE_START_INDEX = 1;
const LIBRARY_HALFTONE_DIR = publicAssetPath("characters/halftone/standing");
const DOT_STRENGTH = 0.35;
const LINE_STRENGTH = 2;
const LINE_WIDTH = 1;
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
    let current = LIBRARY_HALFTONE_START_INDEX;
    let nextAt = 0;
    let shapes: HalftoneShape[] = [];
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

      if (shapes.length) {
        particles = mapShapeToCanvas(shapes[current], width, height).map((target, index) => ({
          ...target,
          seed: hash(index, current + 7)
        }));
        transition = null;
        draw(performance.now());
      }
    };

    const stopAnimation = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const beginTransition = (nextIndex: number) => {
      if (!shapes[nextIndex]) return;
      const targets = mapShapeToCanvas(shapes[nextIndex], width, height);
      const count = Math.max(particles.length, targets.length);
      const nextParticles: Particle[] = [];

      for (let index = 0; index < count; index += 1) {
        const particle = particles[index] ?? createDormantParticle(index, nextIndex, width, height);
        const target = targets[index % targets.length];
        const chaos = chaosPoint(index, nextIndex, width, height);
        nextParticles.push({
          ...particle,
          fromX: particle.x,
          fromY: particle.y,
          fromAlpha: particle.alpha,
          fromSize: particle.size,
          chaosX: chaos.x,
          chaosY: chaos.y,
          tx: target.x,
          ty: target.y,
          targetAlpha: index < targets.length ? target.alpha : 0,
          targetSize: index < targets.length ? target.size : 0,
          tone: index < targets.length ? target.tone : particle.tone,
          seed: particle.seed || hash(index, nextIndex + 7)
        });
      }

      current = nextIndex;
      particles = nextParticles;
      transition = { start: performance.now(), duration: 3600 };
      nextAt = performance.now() + 8800;
    };

    const tick = (now: number) => {
      if (cancelled) return;
      frame = 0;
      if (transition) updateParticles(now);
      draw(now);

      if (!transition && shapes.length && now > nextAt) {
        beginTransition((current + 1) % shapes.length);
      }

      if (!cancelled) frame = window.requestAnimationFrame(tick);
    };

    const updateParticles = (now: number) => {
      if (!transition) return;
      const t = clamp((now - transition.start) / transition.duration, 0, 1);
      const split = 0.48;

      for (const particle of particles) {
        const fromX = particle.fromX ?? particle.x;
        const fromY = particle.fromY ?? particle.y;
        const fromAlpha = particle.fromAlpha ?? particle.alpha;
        const fromSize = particle.fromSize ?? particle.size;
        const chaosX = particle.chaosX ?? particle.x;
        const chaosY = particle.chaosY ?? particle.y;
        const tx = particle.tx ?? particle.x;
        const ty = particle.ty ?? particle.y;
        const targetAlpha = particle.targetAlpha ?? particle.alpha;
        const targetSize = particle.targetSize ?? particle.size;

        if (t < split) {
          const q = easeInOutCubic(t / split);
          particle.x = lerp(fromX, chaosX, q);
          particle.y = lerp(fromY, chaosY, q);
          particle.size = lerp(fromSize, Math.max(fromSize, targetSize) * 0.72, q);
          particle.alpha = lerp(fromAlpha, Math.max(0.12, (fromAlpha || targetAlpha) * 0.52), q);
        } else {
          const q = easeOutExpo((t - split) / (1 - split));
          particle.x = lerp(chaosX, tx, q);
          particle.y = lerp(chaosY, ty, q);
          particle.size = lerp(Math.max(fromSize, targetSize) * 0.72, targetSize, q);
          particle.alpha = lerp(Math.max(0.12, (fromAlpha || targetAlpha) * 0.52), targetAlpha, q);
        }
      }

      if (t >= 1) {
        transition = null;
        particles = particles.filter((particle) => particle.targetAlpha === undefined || particle.targetAlpha > 0.01);
      }
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      drawParticles(ctx, particles, now);
      if (!transition) drawLineArt(ctx, shapes[current], width, height);
    };

    void loadHalftoneShapes().then((loadedShapes) => {
      if (cancelled) return;
      shapes = loadedShapes;
      current = Math.min(LIBRARY_HALFTONE_START_INDEX, shapes.length - 1);
      resize();
      nextAt = performance.now() + 7800;
      if (!frame) frame = window.requestAnimationFrame(tick);
    }).catch(() => {
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

async function loadHalftoneShapes() {
  return Promise.all(LIBRARY_HALFTONE_IDS.map(async (id) => {
    const response = await fetch(`${LIBRARY_HALFTONE_DIR}/${id}.json`);
    if (!response.ok) throw new Error(`Failed to load halftone data for ${id}`);
    const data = await response.json() as HalftoneData;
    const lineArt = data.lineArtVariants?.posterGhost ?? data.lineArt;
    if (!lineArt?.image) throw new Error(`Missing line art for ${id}`);
    const lineArtImage = await loadImage(`${LIBRARY_HALFTONE_DIR}/${lineArt.image}`);
    return { ...data, lineArtImage };
  }));
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

function drawLineArt(ctx: CanvasRenderingContext2D, shape: HalftoneShape | undefined, width: number, height: number) {
  if (!shape?.lineArtImage) return;
  const layout = shapeLayout(shape, width, height);
  const opacity = clamp(LINE_STRENGTH * 0.82, 0, 1);
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

function chaosPoint(index: number, nextIndex: number, width: number, height: number) {
  const a = seeded(index, nextIndex + 17);
  const b = seeded(index, nextIndex + 29);
  const edgeBias = seeded(index, nextIndex + 41);
  const margin = Math.max(70, Math.min(width, height) * 0.12);

  if (edgeBias < 0.7) {
    const side = Math.floor(a * 4);
    if (side === 0) return { x: lerp(-margin, width + margin, b), y: -margin * seeded(index, nextIndex + 53) };
    if (side === 1) return { x: width + margin * seeded(index, nextIndex + 61), y: lerp(-margin, height + margin, b) };
    if (side === 2) return { x: lerp(-margin, width + margin, b), y: height + margin * seeded(index, nextIndex + 67) };
    return { x: -margin * seeded(index, nextIndex + 71), y: lerp(-margin, height + margin, b) };
  }

  return {
    x: lerp(-margin, width + margin, a),
    y: lerp(-margin, height + margin, b)
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

function easeOutExpo(t: number) {
  return t === 1 ? 1 : 1 - (2 ** (-10 * t));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
