import fs from "node:fs/promises";
import path from "node:path";
import type { ModEntry, ModsIndex } from "./types.js";

const spineNamePattern = /(?:cutscene_)?char\d+/i;

export async function scanMods(modsDir: string): Promise<ModsIndex> {
  const entries = await fs.readdir(modsDir, { withFileTypes: true });
  const mods: ModEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(modsDir, entry.name);
    const files = await fs.readdir(dir);
    const baseName = detectModName(files, entry.name);
    const modFiles = collectModFiles(dir, files);
    const json = findFileForBase(files, baseName, ".json");
    const skel = findFileForBase(files, baseName, ".skel");
    const atlas = findFileForBase(files, baseName, ".atlas");
    const png = findFileForBase(files, baseName, ".png");

    mods.push({
      modName: entry.name,
      name: baseName,
      dir,
      jsonPath: json ? path.join(dir, json) : undefined,
      skelPath: skel ? path.join(dir, skel) : undefined,
      atlasPath: atlas ? path.join(dir, atlas) : undefined,
      pngPath: png ? path.join(dir, png) : undefined,
      jsonFile: json,
      skelFile: skel,
      atlasFile: atlas,
      pngFile: png,
      files: modFiles,
      status: getModStatus(modFiles.json.length > 0 || modFiles.skel.length > 0, modFiles.atlas.length > 0, modFiles.png.length > 0)
    });
  }

  return { mods };
}

function getModStatus(hasSkeleton: boolean, hasAtlas: boolean, hasPng: boolean): ModEntry["status"] {
  if (!hasSkeleton) {
    return "missing_skeleton";
  }

  if (!hasAtlas) {
    return "missing_atlas";
  }

  if (!hasPng) {
    return "missing_png";
  }

  return "ready";
}

function collectModFiles(dir: string, files: string[]) {
  return {
    json: collectFilesByExtension(dir, files, ".json"),
    skel: collectFilesByExtension(dir, files, ".skel"),
    atlas: collectFilesByExtension(dir, files, ".atlas"),
    png: collectFilesByExtension(dir, files, ".png")
  };
}

function collectFilesByExtension(dir: string, files: string[], extension: string) {
  return files
    .filter((file) => path.extname(file).toLowerCase() === extension)
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      file,
      path: path.join(dir, file),
      baseName: path.basename(file, path.extname(file))
    }));
}

function detectModName(files: string[], fallback: string) {
  const stems = files
    .filter((file) => [".json", ".skel", ".atlas", ".png"].includes(path.extname(file).toLowerCase()))
    .map((file) => path.basename(file, path.extname(file)));

  const skeletonStem = files
    .filter((file) => [".skel", ".json"].includes(path.extname(file).toLowerCase()))
    .map((file) => path.basename(file, path.extname(file)))
    .find((stem) => spineNamePattern.test(stem));

  if (skeletonStem) {
    return normalizeSpineName(skeletonStem);
  }

  const grouped = new Map<string, number>();
  for (const stem of stems) {
    const name = normalizeSpineName(stem);
    grouped.set(name, (grouped.get(name) ?? 0) + 1);
  }

  const best = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? normalizeSpineName(fallback);
}

function findFileForBase(files: string[], baseName: string, extension: string) {
  const lowerBase = baseName.toLowerCase();
  const lowerExtension = extension.toLowerCase();

  return files.find((file) =>
    path.extname(file).toLowerCase() === lowerExtension &&
    path.basename(file, path.extname(file)).toLowerCase() === lowerBase
  ) ?? files.find((file) =>
    path.extname(file).toLowerCase() === lowerExtension &&
    normalizeSpineName(path.basename(file, path.extname(file))).toLowerCase() === lowerBase
  );
}

function normalizeSpineName(value: string) {
  return value.match(spineNamePattern)?.[0] ?? value;
}
