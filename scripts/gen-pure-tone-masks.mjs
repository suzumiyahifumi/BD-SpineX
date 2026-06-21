import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultHalftoneDir = path.join(root, "app/renderer/public/characters/halftone/standing");
const MASK_STYLE = "source-pure-tone-mask-v1";
const MASK_PROFILE = {
  label: "Pure Tone Mask",
  style: MASK_STYLE,
  defaultInk: 0.58
};

const options = parseArgs(process.argv.slice(2));
const halftoneDir = path.resolve(root, options.halftoneDir);
const jsonFiles = await resolveJsonFiles(halftoneDir, options.ids);

let generated = 0;
let skipped = 0;

for (const jsonFile of jsonFiles) {
  const jsonPath = path.join(halftoneDir, jsonFile);
  const data = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const id = data.id ?? jsonFile.slice(0, -".json".length);
  const sourcePath = data.source
    ? path.resolve(root, data.source)
    : path.join(root, "app/renderer/public/characters/standing", `${id}.png`);
  const crop = Array.isArray(data.crop)
    ? { x: data.crop[0], y: data.crop[1], width: data.crop[2], height: data.crop[3] }
    : null;

  if (!crop || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
    skipped += 1;
    console.warn(`${id}: skipped, missing crop metadata`);
    continue;
  }

  const source = PNG.sync.read(await fs.readFile(sourcePath));
  const mask = createPureToneMask(source, crop);
  const maskName = `${id}.pure-tone-mask.lineart.png`;
  const maskPath = path.join(halftoneDir, maskName);

  if (!options.dryRun) {
    await fs.writeFile(maskPath, PNG.sync.write(mask.png));
    data.lineArtVariants = {
      ...(data.lineArtVariants ?? {}),
      pureToneMask: {
        image: maskName,
        size: [mask.png.width, mask.png.height],
        inkPixels: mask.inkPixels,
        style: MASK_STYLE,
        preset: "pureToneMask"
      }
    };
    data.lineArtProfiles = {
      ...(data.lineArtProfiles ?? {}),
      pureToneMask: MASK_PROFILE
    };
    await fs.writeFile(jsonPath, `${JSON.stringify(data)}\n`, "utf8");
  }

  generated += 1;
  console.log(`${id}: pureToneMask ${mask.inkPixels} ink pixels -> ${path.relative(root, maskPath)}`);
}

console.log(`${options.dryRun ? "Would generate" : "Generated"} ${generated} pure tone masks${skipped ? `, skipped ${skipped}` : ""}.`);

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    halftoneDir: defaultHalftoneDir,
    ids: undefined
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

    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--halftone-dir" || arg === "--output-dir") {
      parsed.halftoneDir = readValue();
    } else if (arg === "--ids") {
      parsed.ids = readValue().split(",").map((id) => id.trim()).filter(Boolean);
    } else if (/^\d+$/.test(arg)) {
      parsed.ids = [...(parsed.ids ?? []), arg];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function resolveJsonFiles(halftoneDir, ids) {
  if (ids?.length) {
    return ids.map((id) => `${id}.json`);
  }

  const entries = await fs.readdir(halftoneDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function createPureToneMask(image, crop) {
  const scale = 6;
  const png = new PNG({ width: crop.width * scale, height: crop.height * scale });
  let inkPixels = 0;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const sx = crop.x + (x + 0.5) / scale;
      const sy = crop.y + (y + 0.5) / scale;
      const pixel = sampleBilinear(image, sx, sy);
      const alpha = pixel[3] / 255;
      if (alpha <= 0.004) continue;

      const gray = Math.round(luma(pixel));
      const offset = (y * png.width + x) * 4;
      png.data[offset] = gray;
      png.data[offset + 1] = gray;
      png.data[offset + 2] = gray;
      png.data[offset + 3] = Math.round(clamp(alpha, 0, 1) * 255);
      if (png.data[offset + 3] >= 8) inkPixels += 1;
    }
  }

  return { png, inkPixels };
}

function sampleBilinear(image, x, y) {
  const x0 = clamp(Math.floor(x), 0, image.width - 1);
  const y0 = clamp(Math.floor(y), 0, image.height - 1);
  const x1 = clamp(x0 + 1, 0, image.width - 1);
  const y1 = clamp(y0 + 1, 0, image.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = samplePixel(image, x0, y0);
  const b = samplePixel(image, x1, y0);
  const c = samplePixel(image, x0, y1);
  const d = samplePixel(image, x1, y1);
  return [0, 1, 2, 3].map((channel) => (
    mix(mix(a[channel], b[channel], tx), mix(c[channel], d[channel], tx), ty)
  ));
}

function samplePixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ];
}

function luma(pixel) {
  return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
