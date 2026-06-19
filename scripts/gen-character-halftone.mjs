import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IDS = ["000201", "067702", "000101"];
const DEFAULT_INPUT_DIR = "app/renderer/public/characters/standing";
const DEFAULT_OUTPUT_DIR = "app/renderer/public/characters/halftone/standing";
const PREVIEW_HEIGHT = 1280;
const PREVIEW_MIN_WIDTH = 820;
const MODE_PRESETS = {
  classic: { density: 0.82, maxDots: 5200 },
  sparse: { density: 0.5, maxDots: 1700 },
  layered: { density: 0.94, maxDots: 6400 }
};
const DEFAULT_DUOTONE_PROFILE = "posterGhost";
const DUOTONE_PROFILES = {
  posterGhost: {
    label: "Poster Ghost",
    file: "poster-ghost",
    style: "source-duotone-poster-ghost-v1",
    alphaScale: 0.6,
    defaultInk: 2
  },
  detailInk: {
    label: "Detail Ink",
    file: "detail-ink",
    style: "source-duotone-detail-ink-v1",
    alphaScale: 0.82,
    defaultInk: 0.9
  },
  backdropTrace: {
    label: "Backdrop Trace",
    file: "backdrop-trace",
    style: "source-duotone-backdrop-trace-v1",
    alphaScale: 0.46,
    defaultInk: 2
  }
};
const DUOTONE_PROFILE_KEYS = Object.keys(DUOTONE_PROFILES);
const LINE_ART_PRESETS = new Set(["contour", "duotone", ...DUOTONE_PROFILE_KEYS]);

const INK = {
  bg: [14, 13, 12, 255],
  grid: [237, 224, 196, 18],
  paper: [237, 224, 196, 255],
  red: [226, 64, 42, 236],
  redDeep: [158, 35, 23, 236],
  amber: [232, 162, 44, 225]
};

const options = parseArgs(process.argv.slice(2));
await fs.mkdir(options.outputDir, { recursive: true });

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  inputDir: relativeFromRoot(options.inputDir),
  outputDir: relativeFromRoot(options.outputDir),
  settings: {
    mode: options.mode,
    grid: options.grid,
    density: options.density,
    edgeWeight: options.edgeWeight,
    maxDots: options.maxDots,
    contourAlphaThreshold: options.contourAlphaThreshold,
    lineArt: options.lineArt
  },
  characters: []
};

for (const id of options.ids) {
  const inputPath = path.join(options.inputDir, `${id}.png`);
  const image = PNG.sync.read(await fs.readFile(inputPath));
  const crop = findTrimBounds(image, options.alphaThreshold);
  const result = createHalftone(image, crop, { ...options, seed: hashString(id) });
  const dataName = `${id}.json`;
  const previewName = `${id}.preview.png`;
  const lineArtName = `${id}.lineart.png`;
  const lineArtVariantNames = {
    contour: `${id}.contour.lineart.png`,
    duotone: `${id}.duotone.lineart.png`,
    ...Object.fromEntries(DUOTONE_PROFILE_KEYS.map((key) => [
      key,
      `${id}.${DUOTONE_PROFILES[key].file}.lineart.png`
    ]))
  };
  const dataPath = path.join(options.outputDir, dataName);
  const previewPath = path.join(options.outputDir, previewName);
  const lineArtPath = path.join(options.outputDir, lineArtName);
  const lineArtVariants = createLineArtVariants(image, crop);
  const lineArt = lineArtVariants[options.lineArt];
  result.lineArt = lineArt;
  const dotFormat = options.mode === "layered"
    ? ["x", "y", "size", "alpha", "tone", "kind"]
    : ["x", "y", "size", "alpha", "tone"];
  const dots = result.dots.map((dot) => {
    const row = [
      round(dot.x, 5),
      round(dot.y, 5),
      round(dot.size, 3),
      round(dot.alpha, 3),
      dot.tone
    ];
    return options.mode === "layered" ? [...row, dot.kind ?? 0] : row;
  });

  await fs.writeFile(dataPath, `${JSON.stringify({
    version: 1,
    id,
    mode: options.mode,
    source: relativeFromRoot(inputPath),
    sourceSize: [image.width, image.height],
    crop: [crop.x, crop.y, crop.width, crop.height],
    aspect: round(crop.width / crop.height, 5),
    grid: options.grid,
    palette: {
      red: "#E2402A",
      redDeep: "#9E2317",
      amber: "#E8A22C"
    },
    dotFormat,
    tones: ["red", "redDeep", "amber"],
    ...(options.mode === "layered" ? { kinds: ["fill", "contour", "highlight"] } : {}),
    lineArt: {
      image: lineArtName,
      size: [lineArt.png.width, lineArt.png.height],
      inkPixels: lineArt.inkPixels,
      style: lineArt.style,
      preset: options.lineArt
    },
    lineArtVariants: Object.fromEntries(Object.entries(lineArtVariants).map(([key, variant]) => [
      key,
      {
        image: lineArtVariantNames[key],
        size: [variant.png.width, variant.png.height],
        inkPixels: variant.inkPixels,
        style: variant.style,
        preset: key
      }
    ])),
    lineArtProfiles: Object.fromEntries(DUOTONE_PROFILE_KEYS.map((key) => [
      key,
      {
        label: DUOTONE_PROFILES[key].label,
        defaultInk: DUOTONE_PROFILES[key].defaultInk,
        style: DUOTONE_PROFILES[key].style
      }
    ])),
    dots
  })}\n`);

  await fs.writeFile(lineArtPath, PNG.sync.write(lineArt.png));
  await Promise.all(Object.entries(lineArtVariants).map(([key, variant]) => (
    fs.writeFile(path.join(options.outputDir, lineArtVariantNames[key]), PNG.sync.write(variant.png))
  )));
  await fs.writeFile(previewPath, PNG.sync.write(drawPreview(result, crop, id)));
  manifest.characters.push({
    id,
    dots: result.dots.length,
    lineArt: relativeFromRoot(lineArtPath),
    inkPixels: lineArt.inkPixels,
    lineArtPreset: options.lineArt,
    lineArtVariants: Object.fromEntries(Object.entries(lineArtVariantNames).map(([key, fileName]) => [
      key,
      relativeFromRoot(path.join(options.outputDir, fileName))
    ])),
    aspect: round(crop.width / crop.height, 5),
    data: relativeFromRoot(dataPath),
    preview: relativeFromRoot(previewPath)
  });

  console.log(`${id}: ${result.dots.length} dots, ${options.lineArt} ${lineArt.inkPixels} ink pixels -> ${relativeFromRoot(dataPath)}`);
}

await fs.writeFile(path.join(options.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

function parseArgs(args) {
  const parsed = {
    inputDir: path.join(ROOT, DEFAULT_INPUT_DIR),
    outputDir: path.join(ROOT, DEFAULT_OUTPUT_DIR),
    ids: DEFAULT_IDS,
    mode: "classic",
    lineArt: DEFAULT_DUOTONE_PROFILE,
    grid: 3,
    density: undefined,
    edgeWeight: 1.25,
    maxDots: undefined,
    alphaThreshold: 12,
    contourAlphaThreshold: 0.18
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === "--ids") {
      parsed.ids = readValue().split(",").map((id) => id.trim()).filter(Boolean);
    } else if (arg === "--mode") {
      const mode = readValue();
      if (!MODE_PRESETS[mode]) {
        throw new Error(`Invalid mode: ${mode}. Use "classic", "sparse", or "layered".`);
      }
      parsed.mode = mode;
    } else if (arg === "--line-art") {
      const lineArt = readValue();
      if (!LINE_ART_PRESETS.has(lineArt)) {
        throw new Error(`Invalid line art preset: ${lineArt}. Use "contour", "duotone", or one of: ${DUOTONE_PROFILE_KEYS.join(", ")}.`);
      }
      parsed.lineArt = lineArt;
    } else if (arg === "--input") {
      parsed.inputDir = path.resolve(ROOT, readValue());
    } else if (arg === "--out") {
      parsed.outputDir = path.resolve(ROOT, readValue());
    } else if (arg === "--grid") {
      parsed.grid = Math.max(1, Number(readValue()) || parsed.grid);
    } else if (arg === "--density") {
      parsed.density = clamp(Number(readValue()) || MODE_PRESETS[parsed.mode].density, 0.15, 1.25);
    } else if (arg === "--edge-weight") {
      parsed.edgeWeight = clamp(Number(readValue()) || parsed.edgeWeight, 0, 3);
    } else if (arg === "--max-dots") {
      parsed.maxDots = Math.max(0, Number(readValue()) || 0);
    } else if (arg === "--alpha-threshold") {
      parsed.alphaThreshold = clamp(Number(readValue()) || parsed.alphaThreshold, 0, 255);
    } else if (arg === "--contour-alpha-threshold") {
      parsed.contourAlphaThreshold = clamp(Number(readValue()) || parsed.contourAlphaThreshold, 0.04, 0.6);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  parsed.density ??= MODE_PRESETS[parsed.mode].density;
  parsed.maxDots ??= MODE_PRESETS[parsed.mode].maxDots;
  return parsed;
}

function createHalftone(image, crop, settings) {
  if (settings.mode === "layered") {
    return createLayeredHalftone(image, crop, settings);
  }
  if (settings.mode === "sparse") {
    return createSparseHalftone(image, crop, settings);
  }
  return createClassicHalftone(image, crop, settings);
}

function createClassicHalftone(image, crop, settings) {
  const dots = [];
  const step = settings.grid;
  let index = 0;

  for (let y = crop.y; y < crop.y + crop.height; y += step) {
    for (let x = crop.x; x < crop.x + crop.width; x += step) {
      const cell = sampleCell(image, x, y, step);
      if (cell.alpha < 0.1) {
        index += 1;
        continue;
      }

      const edge = sampleEdge(image, x, y, step) * settings.edgeWeight;
      const detail = cell.alpha * cell.darkness;
      const silhouette = cell.alpha * 0.54;
      const score = clamp(silhouette + detail * 0.5 + edge * 0.32, 0, 1.35);
      const keepChance = clamp((0.16 + score * 0.66 + edge * 0.16) * settings.density, 0.04, 0.96);
      const random = seededRandom(settings.seed, index);

      if (random > keepChance) {
        index += 1;
        continue;
      }

      const jitterX = (seededRandom(settings.seed + 11, index) - 0.5) * step * 0.18;
      const jitterY = (seededRandom(settings.seed + 23, index) - 0.5) * step * 0.18;
      const normalizedX = clamp((x + step * 0.5 + jitterX - crop.x) / crop.width, 0, 1);
      const normalizedY = clamp((y + step * 0.5 + jitterY - crop.y) / crop.height, 0, 1);
      const size = clamp(0.46 + score * 0.96 + seededRandom(settings.seed + 37, index) * 0.18, 0.42, 1.48);
      const alpha = clamp(0.22 + score * 0.7 + edge * 0.25, 0.16, 0.92);
      const toneRandom = seededRandom(settings.seed + 53, index);
      const tone =
        cell.darkness > 0.58 && toneRandom > 0.32 ? 1 :
        cell.darkness < 0.18 && cell.alpha > 0.56 && toneRandom > 0.92 ? 2 :
        edge > 0.46 && toneRandom > 0.68 ? 1 :
        0;

      dots.push({
        x: normalizedX,
        y: normalizedY,
        size,
        alpha,
        tone,
        score
      });
      index += 1;
    }
  }

  if (settings.maxDots > 0 && dots.length > settings.maxDots) {
    dots.sort((a, b) => {
      const byScore = b.score - a.score;
      return Math.abs(byScore) > 0.02 ? byScore : a.y - b.y || a.x - b.x;
    });
    dots.length = settings.maxDots;
  }

  dots.sort((a, b) => a.y - b.y || a.x - b.x);
  return { dots };
}

function createSparseHalftone(image, crop, settings) {
  const dots = [];
  const step = settings.grid;
  let index = 0;

  for (let y = crop.y; y < crop.y + crop.height; y += step) {
    for (let x = crop.x; x < crop.x + crop.width; x += step) {
      const cell = sampleCell(image, x, y, step);
      if (cell.alpha < 0.1) {
        index += 1;
        continue;
      }

      const nx = clamp((x + step * 0.5 - crop.x) / crop.width, 0, 1);
      const ny = clamp((y + step * 0.5 - crop.y) / crop.height, 0, 1);
      const faceBias = faceFeatureBias(nx, ny);
      const edge = sampleEdge(image, x, y, step) * settings.edgeWeight;
      const detail = cell.alpha * cell.darkness;
      const silhouette = cell.alpha * 0.32;
      const feature = faceBias * (edge * 0.62 + detail * 0.58 + cell.darkness * 0.28);
      const score = clamp(silhouette + detail * 0.44 + edge * 0.34 + feature, 0, 1.55);
      const lowerBodyPenalty = ny > 0.58 && cell.darkness < 0.42 ? 0.72 : 1;
      const keepChance = clamp((0.055 + score * 0.46 + faceBias * 0.2) * settings.density * lowerBodyPenalty, 0.035, 0.88);
      const random = seededRandom(settings.seed, index);

      if (random > keepChance) {
        index += 1;
        continue;
      }

      const jitterScale = faceBias > 0.5 ? 0.1 : 0.2;
      const jitterX = (seededRandom(settings.seed + 11, index) - 0.5) * step * jitterScale;
      const jitterY = (seededRandom(settings.seed + 23, index) - 0.5) * step * jitterScale;
      const normalizedX = clamp((x + step * 0.5 + jitterX - crop.x) / crop.width, 0, 1);
      const normalizedY = clamp((y + step * 0.5 + jitterY - crop.y) / crop.height, 0, 1);
      const size = clamp(0.5 + score * 0.94 + faceBias * 0.18 + seededRandom(settings.seed + 37, index) * 0.14, 0.42, 1.5);
      const alpha = clamp(0.2 + score * 0.56 + edge * 0.2 + faceBias * 0.12, 0.16, 0.9);
      const toneRandom = seededRandom(settings.seed + 53, index);
      const tone =
        cell.darkness > 0.58 && toneRandom > 0.28 ? 1 :
        cell.darkness < 0.18 && cell.alpha > 0.56 && toneRandom > 0.94 ? 2 :
        edge > 0.5 && toneRandom > 0.7 ? 1 :
        0;

      dots.push({
        x: normalizedX,
        y: normalizedY,
        size,
        alpha,
        tone,
        score: score + faceBias * 0.7 + edge * 0.35
      });
      index += 1;
    }
  }

  if (settings.maxDots > 0 && dots.length > settings.maxDots) {
    dots.sort((a, b) => {
      const byScore = b.score - a.score;
      return Math.abs(byScore) > 0.02 ? byScore : a.y - b.y || a.x - b.x;
    });
    dots.length = settings.maxDots;
  }

  dots.sort((a, b) => a.y - b.y || a.x - b.x);
  return { dots };
}

function createLayeredHalftone(image, crop, settings) {
  const dots = [];
  const step = settings.grid;
  let index = 0;

  for (let y = crop.y; y < crop.y + crop.height; y += step) {
    for (let x = crop.x; x < crop.x + crop.width; x += step) {
      const cell = sampleCell(image, x, y, step);
      if (cell.alpha < 0.1) {
        index += 1;
        continue;
      }

      const edge = sampleEdge(image, x, y, step);
      const alphaEdge = sampleAlphaEdge(image, x, y, step);
      const contourScore = clamp((alphaEdge * 0.86 + edge * 0.42) * settings.edgeWeight, 0, 1.45);
      const detail = cell.alpha * cell.darkness;
      const silhouette = cell.alpha * 0.62;
      const score = clamp(silhouette + detail * 0.36 + edge * 0.18 + contourScore * 0.18, 0, 1.35);
      const isContour = cell.alpha > 0.12 && contourScore > settings.contourAlphaThreshold;
      const stableFill = cell.alpha > 0.54;
      const keepChance = isContour
        ? clamp(0.78 + contourScore * 0.22, 0.78, 0.995)
        : clamp((0.28 + cell.alpha * 0.48 + detail * 0.22 + edge * 0.12) * settings.density + (stableFill ? 0.12 : 0), 0.18, 0.96);
      const random = seededRandom(settings.seed, index);

      if (random > keepChance) {
        index += 1;
        continue;
      }

      const highlight = !isContour && cell.darkness < 0.18 && cell.alpha > 0.56 && seededRandom(settings.seed + 59, index) > 0.9;
      const kind = highlight ? 2 : isContour ? 1 : 0;
      const jitterScale = kind === 1 ? 0.1 : kind === 2 ? 0.14 : 0.06;
      const jitterX = (seededRandom(settings.seed + 11, index) - 0.5) * step * jitterScale;
      const jitterY = (seededRandom(settings.seed + 23, index) - 0.5) * step * jitterScale;
      const normalizedX = clamp((x + step * 0.5 + jitterX - crop.x) / crop.width, 0, 1);
      const normalizedY = clamp((y + step * 0.5 + jitterY - crop.y) / crop.height, 0, 1);
      const size =
        kind === 1
          ? clamp(0.88 + contourScore * 0.68 + seededRandom(settings.seed + 37, index) * 0.1, 0.82, 1.72)
          : kind === 2
            ? clamp(0.68 + score * 0.42, 0.62, 1.18)
            : clamp(0.42 + score * 0.48 + seededRandom(settings.seed + 37, index) * 0.08, 0.38, 1.08);
      const alpha =
        kind === 1
          ? clamp(0.62 + contourScore * 0.26 + cell.alpha * 0.16, 0.58, 0.98)
          : kind === 2
            ? clamp(0.45 + cell.alpha * 0.28, 0.42, 0.78)
            : clamp(0.20 + cell.alpha * 0.34 + detail * 0.18, 0.18, 0.68);
      const toneRandom = seededRandom(settings.seed + 53, index);
      const tone =
        kind === 2 ? 2 :
        kind === 1 && toneRandom > 0.74 ? 1 :
        cell.darkness > 0.58 && toneRandom > 0.42 ? 1 :
        0;

      dots.push({
        x: normalizedX,
        y: normalizedY,
        size,
        alpha,
        tone,
        kind,
        score: score + (kind === 1 ? contourScore * 1.3 + 0.65 : kind === 2 ? 0.15 : 0)
      });
      index += 1;
    }
  }

  if (settings.maxDots > 0 && dots.length > settings.maxDots) {
    dots.sort((a, b) => {
      const byScore = b.score - a.score;
      return Math.abs(byScore) > 0.02 ? byScore : a.y - b.y || a.x - b.x;
    });
    dots.length = settings.maxDots;
  }

  dots.sort((a, b) => a.kind - b.kind || a.y - b.y || a.x - b.x);
  return { dots };
}

function sampleCell(image, startX, startY, size) {
  let alphaTotal = 0;
  let lumaTotal = 0;
  let count = 0;
  for (let y = startY; y < Math.min(image.height, startY + size); y += 1) {
    for (let x = startX; x < Math.min(image.width, startX + size); x += 1) {
      const pixel = readPixel(image, x, y);
      const alpha = pixel[3] / 255;
      if (alpha <= 0.01) continue;
      alphaTotal += alpha;
      lumaTotal += luma(pixel) * alpha;
      count += 1;
    }
  }

  if (!count || alphaTotal <= 0) {
    return { alpha: 0, darkness: 0 };
  }

  const alpha = alphaTotal / (size * size);
  const luminance = lumaTotal / alphaTotal;
  return {
    alpha: clamp(alpha, 0, 1),
    darkness: clamp(1 - luminance / 255, 0, 1)
  };
}

function sampleEdge(image, x, y, step) {
  const cx = Math.round(x + step * 0.5);
  const cy = Math.round(y + step * 0.5);
  const left = maskValue(image, cx - step, cy);
  const right = maskValue(image, cx + step, cy);
  const up = maskValue(image, cx, cy - step);
  const down = maskValue(image, cx, cy + step);
  return clamp((Math.abs(right - left) + Math.abs(down - up)) * 0.65, 0, 1);
}

function sampleAlphaEdge(image, x, y, step) {
  const cx = Math.round(x + step * 0.5);
  const cy = Math.round(y + step * 0.5);
  const center = alphaValue(image, cx, cy);
  const offsets = [
    [-step, 0],
    [step, 0],
    [0, -step],
    [0, step],
    [-step, -step],
    [step, -step],
    [-step, step],
    [step, step]
  ];
  let min = center;
  let max = center;
  let outside = 0;
  for (const [dx, dy] of offsets) {
    const value = alphaValue(image, cx + dx, cy + dy);
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (value < 0.1) outside += 1;
  }
  const boundaryBonus = center > 0.18 && outside > 0 ? Math.min(0.38, outside * 0.055) : 0;
  return clamp(max - min + boundaryBonus, 0, 1);
}

function alphaValue(image, x, y) {
  const px = clamp(Math.round(x), 0, image.width - 1);
  const py = clamp(Math.round(y), 0, image.height - 1);
  return image.data[(py * image.width + px) * 4 + 3] / 255;
}

function createLineArtVariants(image, crop) {
  const posterGhost = createSourceDuotoneArt(image, crop, DUOTONE_PROFILES.posterGhost, "posterGhost");
  const backdropTrace = createSourceDuotoneArt(image, crop, DUOTONE_PROFILES.backdropTrace, "backdropTrace");
  return {
    contour: createMangaLineArt(image, crop),
    duotone: posterGhost,
    posterGhost,
    detailInk: createSourceDuotoneArt(image, crop, DUOTONE_PROFILES.detailInk, "detailInk"),
    backdropTrace
  };
}

function createSourceDuotoneArt(image, crop, profile, profileKey) {
  const scale = 6;
  const png = new PNG({ width: crop.width * scale, height: crop.height * scale });
  const background = estimateBackgroundColor(image, crop);
  let inkPixels = 0;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const sx = crop.x + (x + 0.5) / scale;
      const sy = crop.y + (y + 0.5) / scale;
      const pixel = sampleBilinear(image, sx, sy);
      const alpha = pixel[3] / 255;
      const foreground = foregroundValueFromPixel(pixel, background);
      if (alpha < 0.04 || foreground < 0.08) continue;

      const luminance = luma(pixel) / 255;
      const contrast = Math.abs(luminance - 0.5) * 2;
      const color = duotoneColor(luminance, saturation(pixel), profileKey);
      const duotoneAlpha = foreground * profile.alphaScale * duotoneAlphaCurve(luminance, contrast, profileKey);
      if (duotoneAlpha < 0.018) continue;
      inkPixels += blendLineArtPixel(png, x, y, color, duotoneAlpha);
    }
  }

  return { png, inkPixels, style: profile.style };
}

function createMangaLineArt(image, crop) {
  const scale = 6;
  const png = new PNG({ width: crop.width * scale, height: crop.height * scale });
  let inkPixels = 0;
  const background = estimateBackgroundColor(image, crop);
  const foregroundField = createScalarField(crop, (sx, sy) => foregroundValue(image, background, sx, sy));
  const lumaField = createScalarField(crop, (sx, sy) => {
    const pixel = readClampedPixel(image, sx, sy);
    return foregroundValue(image, background, sx, sy) < 0.13 ? -1 : luma(pixel) / 255;
  });
  const chromaField = createScalarField(crop, (sx, sy) => {
    const pixel = readClampedPixel(image, sx, sy);
    return foregroundValue(image, background, sx, sy) < 0.13 ? -1 : saturation(pixel);
  });

  inkPixels += traceContours(png, image, crop, foregroundField, scale, {
    thresholds: [0.14, 0.36],
    layer: "outer",
    width: 0.22,
    alpha: 0.58,
    minSignal: 0,
    background
  });
  inkPixels += traceContours(png, image, crop, lumaField, scale, {
    thresholds: [0.16, 0.28, 0.4, 0.52, 0.64, 0.76],
    layer: "tone",
    width: 0.15,
    alpha: 0.34,
    minSignal: 0.085,
    background
  });
  inkPixels += traceContours(png, image, crop, chromaField, scale, {
    thresholds: [0.18, 0.32, 0.48, 0.64],
    layer: "chroma",
    width: 0.12,
    alpha: 0.22,
    minSignal: 0.12,
    background
  });

  return { png, inkPixels, style: "manga-contour-trace-v1" };
}

function createScalarField(crop, sampler) {
  const values = new Float32Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      values[y * crop.width + x] = sampler(crop.x + x, crop.y + y);
    }
  }
  return { width: crop.width, height: crop.height, values };
}

function traceContours(png, image, crop, field, scale, options) {
  let written = 0;

  for (const threshold of options.thresholds) {
    for (let y = 0; y < field.height - 1; y += 1) {
      for (let x = 0; x < field.width - 1; x += 1) {
        if (!shouldTraceContourCell(image, crop, x, y, options.minSignal, options.layer, options.background)) continue;

        const tl = field.values[y * field.width + x];
        const tr = field.values[y * field.width + x + 1];
        const br = field.values[(y + 1) * field.width + x + 1];
        const bl = field.values[(y + 1) * field.width + x];
        const points = [];

        addContourPoint(points, threshold, tl, tr, x, y, x + 1, y);
        addContourPoint(points, threshold, tr, br, x + 1, y, x + 1, y + 1);
        addContourPoint(points, threshold, br, bl, x + 1, y + 1, x, y + 1);
        addContourPoint(points, threshold, bl, tl, x, y + 1, x, y);

        if (points.length === 2) {
          written += drawContourSegment(png, points[0], points[1], scale, image, crop, x, y, options, threshold);
        } else if (points.length === 4) {
          written += drawContourSegment(png, points[0], points[1], scale, image, crop, x, y, options, threshold);
          written += drawContourSegment(png, points[2], points[3], scale, image, crop, x, y, options, threshold);
        }
      }
    }
  }

  return written;
}

function addContourPoint(points, threshold, a, b, ax, ay, bx, by) {
  if (a < 0 || b < 0 || (a < threshold && b < threshold) || (a >= threshold && b >= threshold)) return;
  const t = clamp((threshold - a) / (b - a || 1), 0, 1);
  points.push({
    x: lerp(ax, bx, t),
    y: lerp(ay, by, t)
  });
}

function shouldTraceContourCell(image, crop, x, y, minSignal, layer, background) {
  const sx = crop.x + x + 0.5;
  const sy = crop.y + y + 0.5;
  const pixel = readClampedPixel(image, sx, sy);
  if (pixel[3] < 18 || foregroundValue(image, background, sx, sy) < 0.13) return false;
  if (layer === "outer") return true;
  const nx = crop.width <= 1 ? 0.5 : x / (crop.width - 1);
  const ny = crop.height <= 1 ? 0.5 : y / (crop.height - 1);
  const gx = mangaEdgeValue(image, sx + 1, sy) - mangaEdgeValue(image, sx - 1, sy);
  const gy = mangaEdgeValue(image, sx, sy + 1) - mangaEdgeValue(image, sx, sy - 1);
  const signal =
    localColorEdge(image, sx, sy) * 0.74 +
    localLumaRange(image, sx, sy) * 0.72 +
    Math.hypot(gx, gy) * 0.3 +
    faceFeatureBias(nx, ny) * 0.08;
  return signal >= minSignal;
}

function drawContourSegment(png, a, b, scale, image, crop, cellX, cellY, options, threshold) {
  const pixel = readClampedPixel(image, crop.x + cellX + 0.5, crop.y + cellY + 0.5);
  const color = contourInkColor(pixel, options.layer, threshold);
  const alpha = options.alpha * contourAlphaBoost(pixel, options.layer, threshold);
  const width = options.width * scale;
  const x1 = a.x * scale;
  const y1 = a.y * scale;
  const x2 = b.x * scale;
  const y2 = b.y * scale;
  const margin = width + 1.2;
  const left = Math.floor(Math.min(x1, x2) - margin);
  const right = Math.ceil(Math.max(x1, x2) + margin);
  const top = Math.floor(Math.min(y1, y2) - margin);
  const bottom = Math.ceil(Math.max(y1, y2) + margin);
  const segmentLengthSq = Math.max(0.0001, (x2 - x1) ** 2 + (y2 - y1) ** 2);
  let written = 0;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = clamp(((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / segmentLengthSq, 0, 1);
      const nearestX = x1 + (x2 - x1) * t;
      const nearestY = y1 + (y2 - y1) * t;
      const distance = Math.hypot(px - nearestX, py - nearestY);
      const coverage = clamp((width * 0.5 + 0.62 - distance) / 0.62, 0, 1);
      if (coverage <= 0) continue;
      written += blendLineArtPixel(png, x, y, color, alpha * coverage);
    }
  }

  return written;
}

function contourInkColor(pixel, layer, threshold) {
  const luminance = luma(pixel) / 255;
  if (layer === "outer") return INK.red;
  if (luminance > 0.72 && threshold > 0.56) return INK.paper;
  if (luminance > 0.44 || layer === "chroma") return INK.amber;
  return INK.redDeep;
}

function contourAlphaBoost(pixel, layer, threshold) {
  if (layer === "outer") return 1;
  const luminance = luma(pixel) / 255;
  return clamp(0.72 + Math.abs(luminance - threshold) * 0.54, 0.62, 1.05);
}

function estimateBackgroundColor(image, crop) {
  const samples = [];

  for (let x = crop.x; x < crop.x + crop.width; x += 6) {
    for (const y of [crop.y, crop.y + crop.height - 1]) {
      const pixel = readClampedPixel(image, x, y);
      if (pixel[3] > 20) samples.push(pixel);
    }
  }

  for (let y = crop.y; y < crop.y + crop.height; y += 6) {
    for (const x of [crop.x, crop.x + crop.width - 1]) {
      const pixel = readClampedPixel(image, x, y);
      if (pixel[3] > 20) samples.push(pixel);
    }
  }

  if (!samples.length) return [0, 0, 0, 0];
  return [
    median(samples.map((pixel) => pixel[0])),
    median(samples.map((pixel) => pixel[1])),
    median(samples.map((pixel) => pixel[2])),
    median(samples.map((pixel) => pixel[3]))
  ];
}

function foregroundValue(image, background, x, y) {
  const pixel = readClampedPixel(image, x, y);
  return foregroundValueFromPixel(pixel, background);
}

function foregroundValueFromPixel(pixel, background) {
  const alpha = pixel[3] / 255;
  if (alpha < 0.04) return 0;
  if (background[3] < 32) return alpha;
  const distance = rgbDistance(pixel, background);
  return clamp((distance - 0.095) / 0.2, 0, 1) * alpha;
}

function rgbDistance(a, b) {
  return (
    Math.abs(a[0] - b[0]) +
    Math.abs(a[1] - b[1]) +
    Math.abs(a[2] - b[2])
  ) / 765;
}

function duotoneAlphaCurve(luminance, contrast, profileKey) {
  if (profileKey === "detailInk") {
    const flatFillPenalty = contrast < 0.18 && luminance > 0.46 ? 0.56 : 1;
    const highlightPenalty = luminance > 0.72 ? 0.68 : 1;
    return clamp(0.05 + contrast * 0.34 + (1 - luminance) * 0.36, 0.04, 0.76) * flatFillPenalty * highlightPenalty;
  }

  if (profileKey === "backdropTrace") {
    return clamp(0.08 + contrast * 0.1 + (1 - luminance) * 0.18, 0.045, 0.38);
  }

  return clamp(0.13 + contrast * 0.18 + (1 - luminance) * 0.32, 0.1, 0.66);
}

function duotoneColor(luminance, chroma, profileKey) {
  const value = clamp(luminance + chroma * 0.035, 0, 1);
  if (profileKey === "detailInk") {
    if (value > 0.97) {
      return mixColor(INK.amber, INK.paper, clamp((value - 0.97) / 0.03, 0, 1) * 0.28);
    }
    if (value > 0.82) {
      return mixColor(INK.red, INK.amber, clamp((value - 0.82) / 0.15, 0, 1) * (0.35 + chroma * 0.08));
    }
    if (value > 0.42) {
      return mixColor(INK.redDeep, INK.red, 0.18 + clamp((value - 0.42) / 0.4, 0, 1) * 0.72);
    }
    return mixColor(INK.redDeep, INK.red, clamp(value / 0.42, 0, 1) * 0.2);
  }

  if (profileKey === "backdropTrace") {
    if (value > 0.97) {
      return mixColor(INK.amber, INK.paper, clamp((value - 0.97) / 0.03, 0, 1) * 0.2);
    }
    if (value > 0.74) {
      return mixColor(INK.red, INK.amber, clamp((value - 0.74) / 0.23, 0, 1) * 0.48);
    }
    if (value > 0.28) {
      return mixColor(INK.redDeep, INK.red, 0.48 + clamp((value - 0.28) / 0.46, 0, 1) * 0.52);
    }
    return mixColor(INK.redDeep, INK.red, clamp(value / 0.28, 0, 1) * 0.18);
  }

  if (value > 0.95) {
    return mixColor(INK.amber, INK.paper, clamp((value - 0.95) / 0.05, 0, 1) * 0.45);
  }
  if (value > 0.75) {
    return mixColor(INK.red, INK.amber, clamp((value - 0.75) / 0.2, 0, 1) * (0.52 + chroma * 0.1));
  }
  if (value > 0.35) {
    return mixColor(INK.redDeep, INK.red, 0.42 + clamp((value - 0.35) / 0.4, 0, 1) * 0.58);
  }
  return mixColor(INK.redDeep, INK.red, clamp(value / 0.35, 0, 1) * 0.28);
}

function mixColor(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    Math.round(lerp(a[3] ?? 255, b[3] ?? 255, t))
  ];
}

function blendLineArtPixel(png, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
  const offset = (y * png.width + x) * 4;
  const sourceAlpha = clamp(alpha, 0, 1);
  if (sourceAlpha <= 0.01) return 0;

  const destinationAlpha = png.data[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return 0;

  const wasEmpty = png.data[offset + 3] < 8;
  png.data[offset] = Math.round((color[0] * sourceAlpha + png.data[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  png.data[offset + 1] = Math.round((color[1] * sourceAlpha + png.data[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  png.data[offset + 2] = Math.round((color[2] * sourceAlpha + png.data[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  png.data[offset + 3] = Math.round(clamp(outputAlpha, 0, 0.96) * 255);
  return wasEmpty && png.data[offset + 3] >= 8 ? 1 : 0;
}

function mangaEdgeValue(image, x, y) {
  const pixel = readClampedPixel(image, x, y);
  const alpha = pixel[3] / 255;
  if (alpha < 0.02) return 0;
  const darkness = 1 - luma(pixel) / 255;
  return alpha * (0.3 + darkness * 0.38 + saturation(pixel) * 0.2 + luma(pixel) / 255 * 0.12);
}

function localColorEdge(image, x, y) {
  const center = readClampedPixel(image, x, y);
  const right = colorDistance(center, readClampedPixel(image, x + 1, y));
  const left = colorDistance(center, readClampedPixel(image, x - 1, y));
  const down = colorDistance(center, readClampedPixel(image, x, y + 1));
  const up = colorDistance(center, readClampedPixel(image, x, y - 1));
  return clamp((right + left + down + up) * 0.5, 0, 1);
}

function localLumaRange(image, x, y) {
  let min = 1;
  let max = 0;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const pixel = readClampedPixel(image, x + ox, y + oy);
      const alpha = pixel[3] / 255;
      if (alpha < 0.04) continue;
      const value = luma(pixel) / 255;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return max >= min ? max - min : 0;
}

function neighborAlphaMax(image, x, y) {
  let max = 0;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      max = Math.max(max, alphaValue(image, x + ox, y + oy));
    }
  }
  return max;
}

function colorDistance(a, b) {
  const alphaA = a[3] / 255;
  const alphaB = b[3] / 255;
  const alphaWeight = Math.min(alphaA, alphaB);
  const channelDistance = (
    Math.abs(a[0] - b[0]) +
    Math.abs(a[1] - b[1]) +
    Math.abs(a[2] - b[2])
  ) / 765;
  return channelDistance * alphaWeight + Math.abs(alphaA - alphaB) * 0.42;
}

function saturation(pixel) {
  const max = Math.max(pixel[0], pixel[1], pixel[2]);
  const min = Math.min(pixel[0], pixel[1], pixel[2]);
  return max <= 0 ? 0 : (max - min) / max;
}

function localAlphaRange(image, x, y, step) {
  const values = [
    alphaValue(image, x, y),
    alphaValue(image, x - step, y),
    alphaValue(image, x + step, y),
    alphaValue(image, x, y - step),
    alphaValue(image, x, y + step),
    alphaValue(image, x - step, y - step),
    alphaValue(image, x + step, y - step),
    alphaValue(image, x - step, y + step),
    alphaValue(image, x + step, y + step)
  ];
  return Math.max(...values) - Math.min(...values);
}

function faceFeatureBias(x, y) {
  return clamp(bell(x, 0.5, 0.26) * bell(y, 0.34, 0.23), 0, 1);
}

function bell(value, center, radius) {
  const distance = Math.abs(value - center) / radius;
  return distance >= 1 ? 0 : 1 - distance * distance;
}

function maskValue(image, x, y) {
  const pixel = readPixel(image, clamp(Math.round(x), 0, image.width - 1), clamp(Math.round(y), 0, image.height - 1));
  return (pixel[3] / 255) * (0.42 + (1 - luma(pixel) / 255) * 0.58);
}

function readPixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ];
}

function sampleBilinear(image, x, y) {
  const x0 = clamp(Math.floor(x), 0, image.width - 1);
  const y0 = clamp(Math.floor(y), 0, image.height - 1);
  const x1 = clamp(x0 + 1, 0, image.width - 1);
  const y1 = clamp(y0 + 1, 0, image.height - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const p00 = readPixel(image, x0, y0);
  const p10 = readPixel(image, x1, y0);
  const p01 = readPixel(image, x0, y1);
  const p11 = readPixel(image, x1, y1);

  return [0, 1, 2, 3].map((channel) => Math.round(lerp(
    lerp(p00[channel], p10[channel], tx),
    lerp(p01[channel], p11[channel], tx),
    ty
  )));
}

function readClampedPixel(image, x, y) {
  return readPixel(
    image,
    clamp(Math.round(x), 0, image.width - 1),
    clamp(Math.round(y), 0, image.height - 1)
  );
}

function findTrimBounds(image, alphaThreshold) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > alphaThreshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }

  const pad = 5;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(image.width - 1, maxX + pad);
  maxY = Math.min(image.height - 1, maxY + pad);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function drawPreview(result, crop, id) {
  const aspect = crop.width / crop.height;
  const width = Math.max(PREVIEW_MIN_WIDTH, Math.round(PREVIEW_HEIGHT * aspect));
  const png = new PNG({ width, height: PREVIEW_HEIGHT });
  fill(png, INK.bg);
  drawGrid(png);

  const shapeHeight = PREVIEW_HEIGHT * 0.86;
  const shapeWidth = shapeHeight * aspect;
  const left = (width - shapeWidth) / 2;
  const top = (PREVIEW_HEIGHT - shapeHeight) / 2;
  const baseDot = Math.max(2, (shapeHeight / crop.height) * 2.8);

  for (const dot of result.dots) {
    const color = dot.tone === 2 ? INK.amber : dot.tone === 1 ? INK.redDeep : INK.red;
    const px = left + dot.x * shapeWidth;
    const py = top + dot.y * shapeHeight;
    const size = baseDot * dot.size;
    const shadowAlpha = dot.kind === 1 ? 132 : 100;
    if (dot.tone !== 1) {
      rect(png, px + size * 0.32, py + size * 0.32, size, size, [158, 35, 23, Math.round(shadowAlpha * dot.alpha)]);
    }
    rect(png, px, py, size, size, withAlpha(color, color[3] * dot.alpha));
    if (dot.kind === 1 && size > 5) {
      rect(png, px + 1, py + 1, Math.max(1, size - 2), 1, [237, 224, 196, Math.round(34 * dot.alpha)]);
    }
  }

  drawLineArtPreview(png, result.lineArt.png, left, top, shapeWidth, shapeHeight);
  drawLabel(png, id, result.dots.length);
  return png;
}

function drawLineArtPreview(png, lineArt, left, top, width, height) {
  const cellWidth = Math.max(1, width / lineArt.width * 1.14);
  const cellHeight = Math.max(1, height / lineArt.height * 1.14);

  for (let y = 0; y < lineArt.height; y += 1) {
    for (let x = 0; x < lineArt.width; x += 1) {
      const offset = (y * lineArt.width + x) * 4;
      const alpha = lineArt.data[offset + 3];
      if (alpha < 6) continue;
      rect(
        png,
        left + (x / lineArt.width) * width,
        top + (y / lineArt.height) * height,
        cellWidth,
        cellHeight,
        [
          lineArt.data[offset],
          lineArt.data[offset + 1],
          lineArt.data[offset + 2],
          Math.round(alpha * 0.88)
        ]
      );
    }
  }
}

function fill(png, color) {
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      writePixel(png, x, y, color);
    }
  }
}

function drawGrid(png) {
  for (let y = 0; y < png.height; y += 40) {
    rect(png, 0, y, png.width, 1, INK.grid);
  }
  for (let x = 0; x < png.width; x += 40) {
    rect(png, x, 0, 1, png.height, INK.grid);
  }
}

function drawLabel(png, id, count) {
  const stripHeight = 48;
  rect(png, 0, png.height - stripHeight, png.width, stripHeight, [226, 64, 42, 210]);
  const blocks = `${id} ${count} DOTS`.split("");
  let x = 20;
  const y = png.height - 35;
  for (const char of blocks) {
    if (char === " ") {
      x += 18;
      continue;
    }
    rect(png, x, y, 10, 22, INK.paper);
    x += 16;
  }
}

function rect(png, x, y, width, height, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(png.width, Math.ceil(x + width));
  const bottom = Math.min(png.height, Math.ceil(y + height));

  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      blendPixel(png, px, py, color);
    }
  }
}

function blendPixel(png, x, y, color) {
  const offset = (y * png.width + x) * 4;
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  png.data[offset] = Math.round(color[0] * alpha + png.data[offset] * inverse);
  png.data[offset + 1] = Math.round(color[1] * alpha + png.data[offset + 1] * inverse);
  png.data[offset + 2] = Math.round(color[2] * alpha + png.data[offset + 2] * inverse);
  png.data[offset + 3] = 255;
}

function writePixel(png, x, y, color) {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = color[3];
}

function withAlpha(color, alpha) {
  return [color[0], color[1], color[2], clamp(Math.round(alpha), 0, 255)];
}

function luma(pixel) {
  return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722;
}

function seededRandom(seed, index) {
  let value = (seed + index * 0x9e3779b1) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return ((value >>> 0) % 100000) / 100000;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function relativeFromRoot(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
