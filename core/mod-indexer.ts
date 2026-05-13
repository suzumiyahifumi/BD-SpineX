import fs from "node:fs/promises";
import path from "node:path";
import type { ModEntry, ModsIndex } from "./types.js";

const spineNamePattern = /(?:cutscene_)?char\d+/i;
const supportedModExtensions = new Set([".json", ".skel", ".atlas", ".png"]);

type ModDirectory = {
  dir: string;
  relativePath: string;
  files: string[];
};

export async function scanMods(modsDir: string): Promise<ModsIndex> {
  const modDirs = await findModDirectories(modsDir);
  const mods: ModEntry[] = [];

  for (const modDir of modDirs) {
    const dir = modDir.dir;
    const files = modDir.files;
    const baseName = detectModName(files, path.basename(modDir.relativePath));
    const modFiles = collectModFiles(dir, files);
    const json = findFileForBase(files, baseName, ".json");
    const skel = findFileForBase(files, baseName, ".skel");
    const atlas = findFileForBase(files, baseName, ".atlas");
    const png = findFileForBase(files, baseName, ".png");

    mods.push({
      modName: modDir.relativePath,
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

async function findModDirectories(modsDir: string): Promise<ModDirectory[]> {
  const entries = await fs.readdir(modsDir, { withFileTypes: true });
  const modDirs: ModDirectory[] = [];

  for (const entry of sortDirEntries(entries)) {
    if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) {
      continue;
    }

    modDirs.push(...await findModDirectoriesIn(path.join(modsDir, entry.name), entry.name));
  }

  return modDirs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function findModDirectoriesIn(dir: string, relativePath: string): Promise<ModDirectory[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = sortDirEntries(entries)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const nestedDirs = sortDirEntries(entries)
    .filter((entry) => entry.isDirectory() && !shouldSkipDirectory(entry.name));
  const modDirs: ModDirectory[] = hasModAssetFiles(files)
    ? [{ dir, relativePath, files }]
    : [];

  for (const entry of nestedDirs) {
    modDirs.push(...await findModDirectoriesIn(path.join(dir, entry.name), path.join(relativePath, entry.name)));
  }

  return modDirs;
}

function sortDirEntries<T extends { name: string }>(entries: T[]) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function shouldSkipDirectory(name: string) {
  return name.startsWith(".") || name === "__MACOSX";
}

function hasModAssetFiles(files: string[]) {
  return files.some((file) => supportedModExtensions.has(path.extname(file).toLowerCase()));
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
    .filter((file) => supportedModExtensions.has(path.extname(file).toLowerCase()))
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
