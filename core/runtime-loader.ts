import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LegacyRuntimeMigrationCheck, LegacyRuntimeMigrationResult } from "./types.js";

const exec = promisify(execFile);

const BUNDLE_ID = "com.neowizgames.game.browndust2ios";
const DISABLED_RUNTIME_MESSAGE =
  "Runtime Injection is kept in the private runtime-injection workspace for release builds.";

export interface RuntimeMod {
  folder: string;
  key: string;
  type: "standing" | "dating" | "skillcut" | "other";
  skeleton: "json" | "skel" | "unknown";
  path: string;
}

export interface RuntimeStatus {
  appFound: boolean;
  appPath: string;
  gameRunning: boolean;
  injected: boolean;
  loaderAvailable: boolean;
  loaderPath: string;
  mountDir: string;
  modsEnabled: boolean;
  mountedMods: RuntimeMod[];
}

export interface PreviewSpineImage {
  name: string;
  mime: string;
  data: string;
}

export interface PreviewSpineBundle {
  key: string;
  skeletonName: string;
  skeletonType: "json" | "skel";
  skeletonData: string;
  atlasName: string;
  atlasText: string;
  images: PreviewSpineImage[];
}

function home() {
  return os.homedir();
}

export function appBundlePath() {
  return path.join(home(), "Library/Containers/io.playcover.PlayCover/Applications", `${BUNDLE_ID}.app`);
}

function mainBinaryPath() {
  return path.join(appBundlePath(), "BrownDustII");
}

export function mountDir() {
  return path.join(home(), "Library/Containers", BUNDLE_ID, "Data", "bd2mods");
}

async function isGameRunning() {
  if (process.platform !== "darwin") return false;
  try {
    await exec("pgrep", ["-x", "BrownDustII"]);
    return true;
  } catch {
    try {
      await exec("pgrep", ["-f", appBundlePath()]);
      return true;
    } catch {
      return false;
    }
  }
}

function keyHasAssetId(key: string, prefix: string) {
  const rest = key.trim().toLowerCase().replace(/^_+/, "").startsWith(prefix)
    ? key.trim().toLowerCase().slice(prefix.length)
    : null;
  return Boolean(rest?.replace(/^[_\-. ]+/, "").match(/^\d/));
}

function classifyKey(key: string): RuntimeMod["type"] {
  if (keyHasAssetId(key, "cutscene_char")) return "skillcut";
  if (keyHasAssetId(key, "illust_dating")) return "dating";
  if (keyHasAssetId(key, "char")) return "standing";
  return "other";
}

function sortDirEntries<T extends { name: string }>(entries: T[]) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function shouldSkipDirectory(name: string) {
  return name.startsWith(".") || name === "__MACOSX";
}

async function scanModDir(root: string): Promise<RuntimeMod[]> {
  const out: RuntimeMod[] = [];
  await scanModDirIn(root, "", out);
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

async function scanModDirIn(root: string, relativePath: string, out: RuntimeMod[]) {
  const dir = relativePath ? path.join(root, relativePath) : root;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (relativePath) {
    const files = sortDirEntries(entries).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const atlas = files.find((file) => file.endsWith(".atlas") && !file.startsWith("._"));
    if (atlas) {
      const key = atlas.slice(0, -".atlas".length);
      const skeleton: RuntimeMod["skeleton"] = files.includes(`${key}.json`)
        ? "json"
        : files.includes(`${key}.skel`)
          ? "skel"
          : "unknown";
      out.push({ folder: relativePath, key, type: classifyKey(key), skeleton, path: dir });
    }
  }

  for (const entry of sortDirEntries(entries)) {
    if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
    await scanModDirIn(root, relativePath ? path.join(relativePath, entry.name) : entry.name, out);
  }
}

export async function getStatus(): Promise<RuntimeStatus> {
  const appPath = appBundlePath();
  const md = mountDir();
  await fsp.mkdir(md, { recursive: true }).catch(() => {});
  return {
    appFound: fs.existsSync(mainBinaryPath()),
    appPath,
    gameRunning: await isGameRunning(),
    injected: false,
    loaderAvailable: false,
    loaderPath: "private/runtime-injection",
    mountDir: md,
    modsEnabled: true,
    mountedMods: await scanModDir(md)
  };
}

export async function listLibraryMods(dir: string): Promise<RuntimeMod[]> {
  return scanModDir(dir);
}

function validatePreviewKey(key: string) {
  return key.length > 0 && !key.includes("/") && !key.includes("\\") && key !== "." && key !== ".." && !key.includes("..");
}

function resolvePreviewAsset(root: string, assetName: string) {
  const normalized = path.normalize(assetName);
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }
  return path.join(root, normalized);
}

function previewImageMime(name: string) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function atlasPageNames(atlasText: string) {
  const pages: string[] = [];
  for (const rawLine of atlasText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (!line || line.startsWith("#")) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(lower)) continue;
    if (!pages.includes(line)) pages.push(line);
  }
  return pages;
}

export async function previewSpineBundle(srcDir: string, key: string): Promise<PreviewSpineBundle> {
  if (!validatePreviewKey(key)) {
    throw new Error("Invalid Spine preview key.");
  }
  const root = path.resolve(srcDir);
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error("Preview source folder does not exist.");
  }

  const atlasName = `${key}.atlas`;
  const atlasPath = path.join(root, atlasName);
  const atlasText = await fsp.readFile(atlasPath, "utf8").catch((error) => {
    throw new Error(`Preview atlas not found: ${atlasName} (${error instanceof Error ? error.message : String(error)})`);
  });

  const jsonPath = path.join(root, `${key}.json`);
  const skelPath = path.join(root, `${key}.skel`);
  const hasJson = fs.existsSync(jsonPath);
  const hasSkel = fs.existsSync(skelPath);
  if (!hasJson && !hasSkel) {
    throw new Error(`Preview skeleton not found: ${key}.json / ${key}.skel`);
  }
  const skeletonPath = hasJson ? jsonPath : skelPath;
  const skeletonType: PreviewSpineBundle["skeletonType"] = hasJson ? "json" : "skel";

  let pageNames = atlasPageNames(atlasText);
  if (pageNames.length === 0) {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    pageNames = sortDirEntries(entries)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("._") && /\.(png|jpe?g|webp)$/i.test(name));
  }

  const images: PreviewSpineImage[] = [];
  const used = new Set<string>();
  for (const pageName of pageNames) {
    if (used.has(pageName)) continue;
    used.add(pageName);
    const resolved = resolvePreviewAsset(root, pageName);
    const imagePath = resolved && fs.existsSync(resolved) ? resolved : path.join(root, path.basename(pageName));
    if (!fs.existsSync(imagePath)) continue;
    const data = (await fsp.readFile(imagePath)).toString("base64");
    images.push({ name: pageName, mime: previewImageMime(pageName), data });
  }

  if (images.length === 0) {
    throw new Error("Preview atlas did not resolve any texture pages.");
  }

  return {
    key,
    skeletonName: path.basename(skeletonPath),
    skeletonType,
    skeletonData: (await fsp.readFile(skeletonPath)).toString("base64"),
    atlasName,
    atlasText,
    images
  };
}

export async function checkRuntimeMigration(): Promise<LegacyRuntimeMigrationCheck> {
  return { needed: false, modNames: [], sourceVersions: [], historyPaths: [] };
}

export async function unpatchLegacyRuntimeMods(): Promise<LegacyRuntimeMigrationResult> {
  return disabledMigrationResult();
}

export async function migrateLegacyRuntimeMods(_modsDir: string): Promise<LegacyRuntimeMigrationResult> {
  return disabledMigrationResult();
}

export async function setRuntimeModsEnabled(_enabled: boolean): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

export async function installLoader(): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

export async function uninstallLoader(): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

export async function mountMod(_srcDir: string, _folderName?: string): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

export async function unmountMod(_folder: string): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

export async function launchGame(): Promise<{ ok: boolean; message: string }> {
  return disabledAction();
}

function disabledAction() {
  return { ok: false, message: DISABLED_RUNTIME_MESSAGE };
}

function disabledMigrationResult(): LegacyRuntimeMigrationResult {
  return {
    ok: false,
    status: "failed",
    message: DISABLED_RUNTIME_MESSAGE,
    restoredBundles: [],
    mountedMods: [],
    missingMods: [],
    removedPaths: [],
    errors: [DISABLED_RUNTIME_MESSAGE]
  };
}
