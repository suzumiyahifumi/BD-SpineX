import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDir = path.join(root, "dist/renderer/characters/halftone/standing");
const targetDir = path.resolve(root, process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? defaultDir);
const dryRun = process.argv.includes("--dry-run");

const keepAsset = (name) => (
  name === "manifest.json" ||
  /^\d+\.json$/.test(name) ||
  /^\d+\.pure-tone\.lineart\.png$/.test(name)
);

const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") {
    console.warn(`Halftone dist directory not found: ${path.relative(root, targetDir)}`);
    return [];
  }
  throw error;
});

let kept = 0;
let removed = 0;
let removedBytes = 0;
let rewritten = 0;

for (const entry of entries) {
  if (!entry.isFile()) continue;
  if (keepAsset(entry.name)) {
    kept += 1;
    continue;
  }

  const filePath = path.join(targetDir, entry.name);
  const stat = await fs.stat(filePath);
  removed += 1;
  removedBytes += stat.size;
  if (!dryRun) {
    await fs.rm(filePath, { force: true });
  }
}

for (const entry of entries) {
  if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;

  const id = entry.name.slice(0, -".json".length);
  const filePath = path.join(targetDir, entry.name);
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  const pureToneImage = data.lineArtVariants?.pureTone?.image ?? `${id}.pure-tone.lineart.png`;
  const pureTonePath = path.join(targetDir, pureToneImage);

  try {
    const stat = await fs.stat(pureTonePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Missing pureTone backdrop image for ${id}: ${pureToneImage}`);
  }

  const pureToneMeta = {
    ...(data.lineArtVariants?.pureTone ?? {}),
    image: pureToneImage,
    preset: "pureTone"
  };

  data.lineArt = pureToneMeta;
  data.lineArtVariants = { pureTone: pureToneMeta };
  rewritten += 1;

  if (!dryRun) {
    await fs.writeFile(filePath, `${JSON.stringify(data)}\n`, "utf8");
  }
}

if (!dryRun) {
  for (const entry of await fs.readdir(targetDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("._")) continue;
    const filePath = path.join(targetDir, entry.name);
    const stat = await fs.stat(filePath);
    removed += 1;
    removedBytes += stat.size;
    await fs.rm(filePath, { force: true });
  }
}

const removedMiB = (removedBytes / 1024 / 1024).toFixed(1);
const mode = dryRun ? "would prune" : "pruned";
console.log(
  `Halftone dist ${mode}: kept ${kept}, removed ${removed} dev-only assets (${removedMiB} MiB), rewrote ${rewritten} JSON files to pureTone.`
);
