import { useEffect, useRef } from "react";

type HalftoneDot = [number, number, number, number, number, number?];
type LineArtMeta = { image: string };
type LibraryBackdropMode = "classic" | "posterGhost" | "duotone" | "pureTone";
type ParticleDensityPreset = "full" | "sparse";
type BackdropCharacterPhase = "ready" | "transition" | "settled";
export type LibraryBackdropCharacterDetail = {
  duration?: number;
  fromId?: string;
  id: string;
  phase: BackdropCharacterPhase;
};
type HalftoneData = {
  id: string;
  aspect: number;
  dots: HalftoneDot[];
  lineArt?: LineArtMeta;
  lineArtVariants?: Record<string, LineArtMeta>;
};

export const LIBRARY_BACKDROP_CHARACTER_EVENT = "bd-spinex:library-backdrop-character";
type HalftoneManifest = {
  characters?: Array<{ id?: string }>;
};
type HalftoneShape = HalftoneData & {
  duotoneImage: HTMLImageElement;
  lineArtImage: HTMLImageElement;
  pureToneImage: HTMLImageElement;
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
type LibraryBackdropConsoleApi = {
  getParticlesEnabled: () => boolean;
  getParticleCount: () => number;
  getMode: () => LibraryBackdropMode;
  getSettings: () => LibraryBackdropSettings;
  modes: readonly LibraryBackdropMode[];
  particleModes: readonly ParticleDensityPreset[];
  resetSettings: () => LibraryBackdropSettings;
  setInk: (value: number, target?: string) => LibraryBackdropSettings;
  setMode: (mode: string) => LibraryBackdropMode;
  setParticleDensity: (value: number) => LibraryBackdropSettings;
  setParticleMode: (mode: string) => LibraryBackdropSettings;
  setParticlesEnabled: (enabled: boolean) => LibraryBackdropSettings;
  setSettings: (settings: Partial<LibraryBackdropSettings>) => LibraryBackdropSettings;
  toggleParticles: () => LibraryBackdropSettings;
};
type LibraryBackdropSettings = {
  classicInk: number;
  dotStrength: number;
  duotoneInk: number;
  lineWidth: number;
  particleDensity: number;
  particlesEnabled: boolean;
  posterGhostInk: number;
  pureToneInk: number;
};

declare global {
  interface Window {
    bdLibraryBackdrop?: LibraryBackdropConsoleApi;
  }
}

const LIBRARY_HALFTONE_FALLBACK_IDS = ["000201", "067702", "000101"];
const LIBRARY_HALFTONE_DIR = publicAssetPath("characters/halftone/standing");
const LIBRARY_HALFTONE_MANIFEST = `${LIBRARY_HALFTONE_DIR}/manifest.json`;
const LIBRARY_BACKDROP_MODE_STORAGE_KEY = "bd-spinex.libraryBackdrop.mode";
const LIBRARY_BACKDROP_SETTINGS_STORAGE_KEY = "bd-spinex.libraryBackdrop.settings";
const LIBRARY_BACKDROP_MODES = ["classic", "posterGhost", "duotone", "pureTone"] as const satisfies readonly LibraryBackdropMode[];
const PARTICLE_DENSITY_PRESETS = ["full", "sparse"] as const satisfies readonly ParticleDensityPreset[];
const SPARSE_PARTICLE_DENSITY = 0.35;
const DEFAULT_BACKDROP_MODE: LibraryBackdropMode = "pureTone";
const DEFAULT_BACKDROP_SETTINGS: LibraryBackdropSettings = {
  classicInk: 2,
  dotStrength: 0.5,
  duotoneInk: 0.66,
  lineWidth: 1,
  particleDensity: 1,
  particlesEnabled: true,
  posterGhostInk: 0.72,
  pureToneInk: 0.3
};
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
    let renderMode = readStoredBackdropMode();
    let renderSettings = readStoredBackdropSettings();
    const shapeCache = new Map<string, HalftoneShape>();
    let particles: Particle[] = [];
    let transition: Transition | null = null;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    canvas.dataset.backdropMode = renderMode;

    const setRenderMode = (mode: string) => {
      renderMode = normalizeBackdropMode(mode, renderMode);
      canvas.dataset.backdropMode = renderMode;
      storeBackdropMode(renderMode);
      draw(performance.now());
      console.info(`[BD-SpineX] Library backdrop mode: ${renderMode}`);
      return renderMode;
    };

    const setRenderSettings = (settings: Partial<LibraryBackdropSettings>) => {
      const previousParticleDensity = renderSettings.particleDensity;
      renderSettings = normalizeBackdropSettings(settings, renderSettings);
      storeBackdropSettings(renderSettings);
      const now = performance.now();
      if (
        currentShape &&
        !transition &&
        width > 0 &&
        height > 0 &&
        Math.abs(renderSettings.particleDensity - previousParticleDensity) > 0.001
      ) {
        particles = createParticlesForShape(currentShape, currentIndex, width, height, renderSettings.particleDensity);
      }
      draw(now);
      console.info("[BD-SpineX] Library backdrop settings:", renderSettings);
      return { ...renderSettings };
    };

    const setInk = (value: number, target?: string) => {
      const targetMode = normalizeBackdropMode(target ?? renderMode, renderMode);
      return setRenderSettings({ [inkSettingKeyForMode(targetMode)]: value });
    };

    const setParticleMode = (mode: string) => (
      setRenderSettings({ particleDensity: particleDensityForMode(mode, renderSettings.particleDensity) })
    );

    const consoleApi: LibraryBackdropConsoleApi = {
      getParticleCount: () => particles.length,
      getParticlesEnabled: () => renderSettings.particlesEnabled,
      getMode: () => renderMode,
      getSettings: () => ({ ...renderSettings }),
      modes: LIBRARY_BACKDROP_MODES,
      particleModes: PARTICLE_DENSITY_PRESETS,
      resetSettings: () => setRenderSettings(DEFAULT_BACKDROP_SETTINGS),
      setInk,
      setMode: setRenderMode,
      setParticleDensity: (value: number) => setRenderSettings({ particleDensity: value }),
      setParticleMode,
      setParticlesEnabled: (enabled: boolean) => setRenderSettings({ particlesEnabled: enabled }),
      setSettings: setRenderSettings,
      toggleParticles: () => setRenderSettings({ particlesEnabled: !renderSettings.particlesEnabled })
    };
    window.bdLibraryBackdrop = consoleApi;
    console.info("[BD-SpineX] Library backdrop controls:", {
      modes: LIBRARY_BACKDROP_MODES,
      particleModes: PARTICLE_DENSITY_PRESETS,
      setParticleDensity: "bdLibraryBackdrop.setParticleDensity(0.08 ... 1)",
      setParticleMode: "bdLibraryBackdrop.setParticleMode('full' | 'sparse')",
      setInk: "bdLibraryBackdrop.setInk(value, optionalMode)",
      setMode: "bdLibraryBackdrop.setMode('classic' | 'posterGhost' | 'duotone' | 'pureTone')",
      setParticlesEnabled: "bdLibraryBackdrop.setParticlesEnabled(true | false)",
      setSettings: "bdLibraryBackdrop.setSettings({ particlesEnabled, particleDensity, classicInk, dotStrength, lineWidth, posterGhostInk, duotoneInk, pureToneInk })"
    });

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
        particles = createParticlesForShape(currentShape, currentIndex, width, height, renderSettings.particleDensity);
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
        const targets = mapShapeToCanvas(nextShape, width, height, renderSettings.particleDensity);
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
        emitBackdropCharacter(nextShape, { duration: TRANSITION_DURATION, fromId: currentShape.id, phase: "transition" });
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
        emitBackdropCharacter(currentShape, { phase: "settled" });
        transition = null;
        lineVisibleSince = renderMode === "classic" ? now : now - LINE_FADE_IN_DURATION;
        particles = width > 0 && height > 0
          ? createParticlesForShape(currentShape, currentIndex, width, height, renderSettings.particleDensity)
          : particles.filter((particle) => particle.targetAlpha === undefined || particle.targetAlpha > 0.01);
      }
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);

      if (renderMode === "classic") {
        if (renderSettings.particlesEnabled) {
          drawParticles(ctx, particles, now, renderSettings.dotStrength);
        }

        if (transition) {
          const fadeOut = 1 - easeInOutCubic(clamp((now - transition.start) / LINE_FADE_OUT_DURATION, 0, 1));
          drawLineArt(ctx, transition.fromShape, width, height, fadeOut, renderSettings.classicInk, renderSettings.lineWidth);
        } else {
          const fadeIn = easeInOutCubic(clamp((now - lineVisibleSince) / LINE_FADE_IN_DURATION, 0, 1));
          drawLineArt(ctx, currentShape, width, height, fadeIn, renderSettings.classicInk, renderSettings.lineWidth);
        }

        return;
      }

      drawStillBackdrop(ctx, renderMode, renderSettings, transition, currentShape, width, height, now, lineVisibleSince);
      if (renderSettings.particlesEnabled) {
        drawParticles(ctx, particles, now, renderSettings.dotStrength);
      }
    };

    void (async () => {
      ids = await loadHalftoneIds();
      if (cancelled) return;
      currentIndex = pickRandomIndex(ids);
      currentShape = await loadHalftoneShape(ids[currentIndex], shapeCache);
      if (cancelled) return;
      emitBackdropCharacter(currentShape, { phase: "ready" });
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
      if (window.bdLibraryBackdrop === consoleApi) {
        delete window.bdLibraryBackdrop;
      }
    };
  }, []);

  return <canvas className="libraryHalftoneBackdrop" ref={canvasRef} aria-hidden="true" />;
}

function emitBackdropCharacter(
  shape: HalftoneShape | null | undefined,
  detail: Omit<LibraryBackdropCharacterDetail, "id">
) {
  if (!shape?.id) return;
  window.dispatchEvent(new CustomEvent<LibraryBackdropCharacterDetail>(LIBRARY_BACKDROP_CHARACTER_EVENT, {
    detail: { ...detail, id: shape.id }
  }));
}

function publicAssetPath(path: string) {
  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

function readStoredBackdropMode(): LibraryBackdropMode {
  try {
    return normalizeBackdropMode(window.localStorage.getItem(LIBRARY_BACKDROP_MODE_STORAGE_KEY), DEFAULT_BACKDROP_MODE);
  } catch {
    return DEFAULT_BACKDROP_MODE;
  }
}

function storeBackdropMode(mode: LibraryBackdropMode) {
  try {
    window.localStorage.setItem(LIBRARY_BACKDROP_MODE_STORAGE_KEY, mode);
  } catch {
    // Optional console control should not affect the background.
  }
}

function normalizeBackdropMode(value: unknown, fallback: LibraryBackdropMode): LibraryBackdropMode {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  if (key === "classic" || key === "halftone" || key === "particles") return "classic";
  if (key === "posterghost" || key === "poster-ghost" || key === "poster" || key === "ghost") return "posterGhost";
  if (key === "duotone" || key === "standard" || key === "normal" || key === "flat") return "duotone";
  if (key === "puretone" || key === "pure-tone" || key === "pure" || key === "tone" || key === "monotone") return "pureTone";
  return fallback;
}

function inkSettingKeyForMode(mode: LibraryBackdropMode): keyof LibraryBackdropSettings {
  if (mode === "classic") return "classicInk";
  if (mode === "posterGhost") return "posterGhostInk";
  if (mode === "pureTone") return "pureToneInk";
  return "duotoneInk";
}

function particleDensityForMode(value: unknown, fallback: number) {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  if (key === "sparse" || key === "low" || key === "light" || key === "few") return SPARSE_PARTICLE_DENSITY;
  if (key === "full" || key === "normal" || key === "dense") return 1;
  return fallback;
}

function readStoredBackdropSettings(): LibraryBackdropSettings {
  try {
    const stored = window.localStorage.getItem(LIBRARY_BACKDROP_SETTINGS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_BACKDROP_SETTINGS };
    return normalizeBackdropSettings(JSON.parse(stored), DEFAULT_BACKDROP_SETTINGS);
  } catch {
    return { ...DEFAULT_BACKDROP_SETTINGS };
  }
}

function storeBackdropSettings(settings: LibraryBackdropSettings) {
  try {
    window.localStorage.setItem(LIBRARY_BACKDROP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Optional console control should not affect the background.
  }
}

function normalizeBackdropSettings(value: unknown, fallback: LibraryBackdropSettings): LibraryBackdropSettings {
  const input = value && typeof value === "object" ? value as Partial<LibraryBackdropSettings> : {};
  return {
    classicInk: finiteNumber(input.classicInk, fallback.classicInk, 0, 3),
    dotStrength: finiteNumber(input.dotStrength, fallback.dotStrength, 0, 1.2),
    duotoneInk: finiteNumber(input.duotoneInk, fallback.duotoneInk, 0, 1.5),
    lineWidth: finiteNumber(input.lineWidth, fallback.lineWidth, 0.25, 3),
    particleDensity: finiteNumber(input.particleDensity, fallback.particleDensity, 0.08, 1),
    particlesEnabled: booleanValue(input.particlesEnabled, fallback.particlesEnabled),
    posterGhostInk: finiteNumber(input.posterGhostInk, fallback.posterGhostInk, 0, 1.5),
    pureToneInk: finiteNumber(input.pureToneInk, fallback.pureToneInk, 0, 1.5)
  };
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(key)) return true;
    if (["0", "false", "no", "off"].includes(key)) return false;
  }
  return fallback;
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
  const lineArt = data.lineArtVariants?.posterGhost ?? data.lineArtVariants?.duotone ?? data.lineArt;
  const duotone = data.lineArtVariants?.duotone ?? lineArt;
  const pureTone = data.lineArtVariants?.pureTone ?? duotone;
  if (!lineArt?.image) throw new Error(`Missing line art for ${id}`);
  if (!duotone?.image) throw new Error(`Missing duotone art for ${id}`);
  if (!pureTone?.image) throw new Error(`Missing pure tone art for ${id}`);
  const lineArtImage = await loadImage(`${LIBRARY_HALFTONE_DIR}/${lineArt.image}`);
  const duotoneImage = duotone.image === lineArt.image
    ? lineArtImage
    : await loadImage(`${LIBRARY_HALFTONE_DIR}/${duotone.image}`);
  const pureToneImage = pureTone.image === lineArt.image
    ? lineArtImage
    : pureTone.image === duotone.image
      ? duotoneImage
      : await loadImage(`${LIBRARY_HALFTONE_DIR}/${pureTone.image}`);
  const shape = { ...data, duotoneImage, lineArtImage, pureToneImage };
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

function createParticlesForShape(shape: HalftoneShape, index: number, width: number, height: number, particleDensity: number): Particle[] {
  return mapShapeToCanvas(shape, width, height, particleDensity).map((target, particleIndex) => ({
    ...target,
    seed: hash(particleIndex, index + 7)
  }));
}

function mapShapeToCanvas(shape: HalftoneShape, width: number, height: number, particleDensity: number): ParticleTarget[] {
  const layout = shapeLayout(shape, width, height);
  return selectParticleDots(shape, particleDensity).map((dot) => ({
    x: layout.left + dot[0] * layout.shapeWidth,
    y: layout.top + dot[1] * layout.shapeHeight,
    size: layout.baseSize * dot[2],
    alpha: dot[3],
    tone: dot[4]
  }));
}

function selectParticleDots(shape: HalftoneShape, particleDensity: number) {
  const density = clamp(particleDensity, 0.08, 1);
  if (density >= 0.995 || shape.dots.length <= 1) return shape.dots;

  const keepCount = Math.max(1, Math.round(shape.dots.length * density));
  return shape.dots
    .map((dot, index) => ({
      dot,
      index,
      score: particleDotImportance(dot, index, shape.id)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, keepCount)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.dot);
}

function particleDotImportance(dot: HalftoneDot, index: number, shapeId: string) {
  const idSeed = Number.parseInt(shapeId, 10) || 0;
  const alpha = clamp(dot[3] ?? 0, 0, 1);
  const size = clamp((dot[2] ?? 1) / 2.4, 0, 1);
  const toneBoost = dot[4] === 2 ? 0.06 : dot[4] === 1 ? 0.03 : 0;
  return alpha * 0.68 + size * 0.2 + toneBoost + seeded(index, idSeed + 31) * 0.18;
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

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[], now: number, dotStrength: number) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const particle of particles) {
    const particleAlpha = particle.alpha * dotStrength;
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

function drawLineArt(
  ctx: CanvasRenderingContext2D,
  shape: HalftoneShape | null | undefined,
  width: number,
  height: number,
  visibility: number,
  ink: number,
  lineWidth: number
) {
  if (!shape?.lineArtImage || visibility <= 0) return;
  const layout = shapeLayout(shape, width, height);
  const opacity = clamp(ink * 0.82 * visibility, 0, 1);
  const spread = Math.max(0, lineWidth - 0.76) * Math.max(1, layout.baseSize * 0.18);
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

function drawStillBackdrop(
  ctx: CanvasRenderingContext2D,
  mode: LibraryBackdropMode,
  settings: LibraryBackdropSettings,
  transition: Transition | null,
  currentShape: HalftoneShape | null,
  width: number,
  height: number,
  now: number,
  lineVisibleSince: number
) {
  if (transition) {
    const t = clamp((now - transition.start) / transition.duration, 0, 1);
    const fadeOut = 1 - easeInOutCubic(clamp(t / 0.42, 0, 1));
    const fadeIn = easeInOutCubic(clamp((t - 0.18) / 0.82, 0, 1));
    drawStillBackdropImage(ctx, mode, settings, transition.fromShape, width, height, fadeOut);
    drawStillBackdropImage(ctx, mode, settings, transition.nextShape, width, height, fadeIn);
    return;
  }

  const fadeIn = easeInOutCubic(clamp((now - lineVisibleSince) / LINE_FADE_IN_DURATION, 0, 1));
  drawStillBackdropImage(ctx, mode, settings, currentShape, width, height, fadeIn);
}

function drawStillBackdropImage(
  ctx: CanvasRenderingContext2D,
  mode: LibraryBackdropMode,
  settings: LibraryBackdropSettings,
  shape: HalftoneShape | null | undefined,
  width: number,
  height: number,
  visibility: number
) {
  if (mode === "duotone") {
    drawStandardDuotoneImage(ctx, shape, width, height, visibility, settings.duotoneInk);
    return;
  }
  if (mode === "pureTone") {
    drawPureToneImage(ctx, shape, width, height, visibility, settings.pureToneInk);
    return;
  }

  drawPosterGhostImage(ctx, shape, width, height, visibility, settings.posterGhostInk);
}

function drawPosterGhostImage(
  ctx: CanvasRenderingContext2D,
  shape: HalftoneShape | null | undefined,
  width: number,
  height: number,
  visibility: number,
  ink: number
) {
  if (!shape?.lineArtImage || visibility <= 0) return;
  const layout = shapeLayout(shape, width, height);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = ink * clamp(visibility, 0, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = "saturate(1.06) contrast(1.04)";
  ctx.drawImage(shape.lineArtImage, layout.left, layout.top, layout.shapeWidth, layout.shapeHeight);
  ctx.restore();
}

function drawStandardDuotoneImage(
  ctx: CanvasRenderingContext2D,
  shape: HalftoneShape | null | undefined,
  width: number,
  height: number,
  visibility: number,
  ink: number
) {
  if (!shape?.duotoneImage || visibility <= 0) {
    drawPosterGhostImage(ctx, shape, width, height, visibility, ink);
    return;
  }

  const layout = shapeLayout(shape, width, height);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = ink * clamp(visibility, 0, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = "saturate(1.03) contrast(1.06)";
  ctx.drawImage(shape.duotoneImage, layout.left, layout.top, layout.shapeWidth, layout.shapeHeight);
  ctx.restore();
}

function drawPureToneImage(
  ctx: CanvasRenderingContext2D,
  shape: HalftoneShape | null | undefined,
  width: number,
  height: number,
  visibility: number,
  ink: number
) {
  if (!shape?.pureToneImage || visibility <= 0) {
    drawStandardDuotoneImage(ctx, shape, width, height, visibility, ink);
    return;
  }

  const layout = shapeLayout(shape, width, height);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = ink * clamp(visibility, 0, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(shape.pureToneImage, layout.left, layout.top, layout.shapeWidth, layout.shapeHeight);
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
