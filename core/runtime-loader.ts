// Runtime（BepInEx-for-PlayCover）loader 管理：注入/還原 + mod 掛載 + 啟動。
// 對應 Phase 5 GUI。僅 macOS / PlayCover BrownDust II。
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectGameVersion } from "./game-version.js";
import { addLoadDylib, hasLoadDylib } from "./macho-inject.js";
import { checkLegacyRuntimeMigration, cleanupLegacyRuntimeMigrationRecords, legacyOriginalBackupPath, readLegacyActivePatchEntries } from "./patch-runner.js";
import { isPackagedRuntime, resourcePath, supportedGameVersion } from "./runtime-paths.js";
import type { LegacyRuntimeMigrationCheck, LegacyRuntimeMigrationResult } from "./types.js";

const exec = promisify(execFile);

const BUNDLE_ID = "com.neowizgames.game.browndust2ios";
const LOADER_DYLIB = "libbd2loader.dylib";
const LOADER_LOAD_NAME = `@executable_path/Frameworks/${LOADER_DYLIB}`;
const DISABLED_MARKER = ".bdspinex-disabled";

export interface RuntimeMod {
  folder: string; // library/mount root-relative folder name
  key: string; // 資產基底名（char003604 / illust_dating11 / cutscene_charXXXXXX）
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
function frameworksDir() {
  return path.join(appBundlePath(), "Frameworks");
}
function backupBinaryPath() {
  return path.join(appBundlePath(), "..", `${BUNDLE_ID}.app.BAK-mainbin`, "BrownDustII");
}
export function mountDir() {
  return path.join(home(), "Library/Containers", BUNDLE_ID, "Data", "bd2mods");
}
function disabledMarkerPath() {
  return path.join(mountDir(), DISABLED_MARKER);
}
function entitlementsCachePath() {
  return path.join(appBundlePath(), "..", `${BUNDLE_ID}.app.BAK-mainbin`, "bd2.entitlements.plist");
}

function normalizeVersionForCompare(version?: string) {
  return version?.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

function injectionVersionMismatchMessage(detectedVersion: string, supportedVersion: string) {
  return `Runtime Injection is locked: this BD-SpineX app supports BrownDust II ${supportedVersion}, but the detected game version is ${detectedVersion}. Update BD-SpineX to the matching app version.`;
}

async function validateRuntimeInjectionGameVersion() {
  const supported = supportedGameVersion();
  const detected = (await detectGameVersion(appBundlePath())).version;
  const detectedComparable = normalizeVersionForCompare(detected);
  const supportedComparable = normalizeVersionForCompare(supported);
  if (detected && detectedComparable && supportedComparable && detectedComparable !== supportedComparable) {
    return { ok: false as const, message: injectionVersionMismatchMessage(detected, supported) };
  }
  return { ok: true as const };
}

/** loader dylib 來源：packaged → resources/backend；dev → 編譯輸出。 */
export function loaderSourcePath() {
  if (isPackagedRuntime()) {
    return resourcePath("backend", "bd2loader", LOADER_DYLIB);
  }
  return path.resolve("native/bd2loader/target/aarch64-apple-darwin/release", LOADER_DYLIB);
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

function classifyKey(key: string): RuntimeMod["type"] {
  if (key.startsWith("cutscene_char")) return "skillcut";
  if (key.startsWith("illust_dating")) return "dating";
  if (/^char\d+$/.test(key)) return "standing";
  return "other";
}

function sortDirEntries<T extends { name: string }>(entries: T[]) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function shouldSkipDirectory(name: string) {
  return name.startsWith(".") || name === "__MACOSX";
}

function safeRelativeFolder(folder: string) {
  const normalized = path.normalize(folder).replace(/\\/g, "/");
  if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  return normalized;
}

function safeMountPath(folder: string) {
  const relative = safeRelativeFolder(folder);
  return relative ? path.join(mountDir(), relative) : null;
}

/** Recursively scan mod folders under a root directory. The .atlas stem is the runtime key. */
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
    let files: string[];
    try {
      files = sortDirEntries(entries).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      files = [];
    }
    const atlas = files.find((f) => f.endsWith(".atlas") && !f.startsWith("._"));
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

  for (const e of sortDirEntries(entries)) {
    if (!e.isDirectory() || shouldSkipDirectory(e.name)) continue;
    await scanModDirIn(root, relativePath ? path.join(relativePath, e.name) : e.name, out);
  }
}

export async function getStatus(): Promise<RuntimeStatus> {
  const appPath = appBundlePath();
  const appFound = fs.existsSync(mainBinaryPath());
  const gameRunning = await isGameRunning();
  const loaderPath = loaderSourcePath();
  const loaderAvailable = fs.existsSync(loaderPath);
  let injected = false;
  if (appFound) {
    try {
      injected = hasLoadDylib(mainBinaryPath(), LOADER_LOAD_NAME);
    } catch {
      injected = false;
    }
  }
  const md = mountDir();
  await fsp.mkdir(md, { recursive: true }).catch(() => {});
  const modsEnabled = !fs.existsSync(disabledMarkerPath());
  const mountedMods = await scanModDir(md);
  return { appFound, appPath, gameRunning, injected, loaderAvailable, loaderPath, mountDir: md, modsEnabled, mountedMods };
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
  const atlasText = await fsp.readFile(atlasPath, "utf8").catch((error: unknown) => {
    throw new Error(`Preview atlas not found: ${atlasName} (${String(error)})`);
  });

  const jsonPath = path.join(root, `${key}.json`);
  const skelPath = path.join(root, `${key}.skel`);
  const hasJson = fs.existsSync(jsonPath);
  const hasSkel = fs.existsSync(skelPath);
  if (!hasJson && !hasSkel) {
    throw new Error(`Preview skeleton not found: ${key}.json / ${key}.skel`);
  }
  const skeletonType: PreviewSpineBundle["skeletonType"] = hasJson ? "json" : "skel";
  const skeletonName = `${key}.${skeletonType}`;
  const skeletonPath = skeletonType === "json" ? jsonPath : skelPath;

  let pageNames = atlasPageNames(atlasText);
  if (pageNames.length === 0) {
    const files = await fsp.readdir(root).catch(() => []);
    pageNames = files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith("._")).sort((a, b) => a.localeCompare(b));
  }

  const images: PreviewSpineImage[] = [];
  const used = new Set<string>();
  for (const pageName of pageNames) {
    const resolved = resolvePreviewAsset(root, pageName) ?? path.join(root, path.basename(pageName));
    const imagePath = fs.existsSync(resolved) ? resolved : path.join(root, path.basename(pageName));
    if (used.has(pageName) || !fs.existsSync(imagePath)) continue;
    used.add(pageName);
    const data = await fsp.readFile(imagePath);
    images.push({
      name: pageName,
      mime: previewImageMime(pageName),
      data: data.toString("base64")
    });
  }

  if (images.length === 0) {
    throw new Error("Preview atlas did not resolve any texture pages.");
  }

  const skeletonData = await fsp.readFile(skeletonPath);
  return {
    key,
    skeletonName,
    skeletonType,
    skeletonData: skeletonData.toString("base64"),
    atlasName,
    atlasText,
    images
  };
}

export async function checkRuntimeMigration(): Promise<LegacyRuntimeMigrationCheck> {
  return checkLegacyRuntimeMigration();
}

function createMigrationResult(): LegacyRuntimeMigrationResult {
  return {
    ok: false,
    status: "idle",
    message: "",
    restoredBundles: [],
    mountedMods: [],
    missingMods: [],
    removedPaths: [],
    errors: []
  };
}

async function restoreLegacyCleanData(result: LegacyRuntimeMigrationResult) {
  const entries = await readLegacyActivePatchEntries();
  const modNames = [...new Set(entries.map((entry) => entry.modName))].sort((a, b) => a.localeCompare(b));
  const sourceVersions = [...new Set(entries.map((entry) => entry.sourceVersion))].sort((a, b) => a.localeCompare(b));
  if (entries.length === 0) {
    result.ok = true;
    result.status = "done";
    result.message = "No legacy patched mods were found.";
    return { entries, modNames, sourceVersions };
  }

  result.status = "restoring";
  const restoredBundleKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry.bundleId || !entry.bundlePath) continue;
    const key = `${entry.sourceVersion}:${entry.bundleId}:${entry.bundlePath}`;
    if (restoredBundleKeys.has(key)) continue;
    const backup = legacyOriginalBackupPath(entry.sourceVersion, entry.bundleId);
    if (!fs.existsSync(backup)) {
      result.errors.push(`Missing clean backup for ${entry.bundleId} (${entry.sourceVersion}).`);
      continue;
    }
    if (!fs.existsSync(entry.bundlePath)) {
      result.errors.push(`Game __data file is missing for ${entry.bundleId}.`);
      continue;
    }
    await fsp.copyFile(backup, entry.bundlePath);
    restoredBundleKeys.add(key);
    result.restoredBundles.push(entry.bundleId);
  }

  return { entries, modNames, sourceVersions };
}

export async function unpatchLegacyRuntimeMods(): Promise<LegacyRuntimeMigrationResult> {
  const result = createMigrationResult();

  if (await isGameRunning()) {
    return { ...result, status: "failed", message: "Close BrownDust II before unpatching legacy __data.", errors: ["Game is running."] };
  }

  const { entries, sourceVersions } = await restoreLegacyCleanData(result);
  if (entries.length === 0) return result;
  if (result.errors.length > 0) {
    result.status = "failed";
    result.message = `Unpatch stopped with ${result.errors.length} issue(s). Legacy records were kept for recovery.`;
    return result;
  }

  result.status = "cleaning";
  result.removedPaths = await cleanupLegacyRuntimeMigrationRecords(sourceVersions);
  result.ok = result.errors.length === 0;
  result.status = result.ok ? "done" : "failed";
  result.message = result.ok
    ? `Restored clean __data for ${result.restoredBundles.length} bundle(s).`
    : `Unpatch finished with ${result.errors.length} issue(s).`;
  return result;
}

export async function migrateLegacyRuntimeMods(modsDir: string): Promise<LegacyRuntimeMigrationResult> {
  const result = createMigrationResult();

  if (!modsDir) {
    return { ...result, status: "failed", message: "Choose a Mods Folder before migrating legacy patches.", errors: ["Mods Folder is empty."] };
  }
  if (await isGameRunning()) {
    return { ...result, status: "failed", message: "Close BrownDust II before migrating legacy patches.", errors: ["Game is running."] };
  }

  const { entries, modNames, sourceVersions } = await restoreLegacyCleanData(result);
  if (entries.length === 0) return result;
  if (result.errors.length > 0) {
    result.status = "failed";
    result.message = `Migration stopped with ${result.errors.length} restore issue(s). Legacy records were kept for recovery.`;
    return result;
  }

  result.status = "injecting";
  const install = await installLoader();
  if (!install.ok) {
    return { ...result, status: "failed", message: install.message, errors: [...result.errors, install.message] };
  }
  await setRuntimeModsEnabled(true);

  result.status = "mounting";
  const library = await listLibraryMods(modsDir);
  const byFolder = new Map(library.map((mod) => [mod.folder, mod]));
  const byBaseFolder = new Map<string, RuntimeMod>();
  for (const mod of library) {
    byBaseFolder.set(path.basename(mod.folder), mod);
  }
  for (const modName of modNames) {
    const mod = byFolder.get(modName) ?? byBaseFolder.get(path.basename(modName));
    if (!mod) {
      result.missingMods.push(modName);
      continue;
    }
    const mounted = await mountMod(mod.path, mod.folder);
    if (mounted.ok) {
      result.mountedMods.push(mod.folder);
    } else {
      result.errors.push(`${modName}: ${mounted.message}`);
    }
  }

  result.status = "cleaning";
  result.removedPaths = await cleanupLegacyRuntimeMigrationRecords(sourceVersions);
  result.ok = result.errors.length === 0;
  result.status = result.ok ? "done" : "failed";
  result.message = result.ok
    ? `Migrated ${result.mountedMods.length} mod(s) to Runtime Injection.`
    : `Migration finished with ${result.errors.length} issue(s).`;
  return result;
}

export async function setRuntimeModsEnabled(enabled: boolean): Promise<{ ok: boolean; message: string }> {
  await fsp.mkdir(mountDir(), { recursive: true });
  if (enabled) {
    await fsp.rm(disabledMarkerPath(), { force: true });
    return { ok: true, message: "Mod Power restored. Restart the game to load mounted mods." };
  }
  await fsp.writeFile(disabledMarkerPath(), "BD-SpineX runtime mods disabled\n", "utf8");
  return { ok: true, message: "Mod Power turned off. Restart the game to run without mounted mods." };
}

/** 安裝注入：備份原檔 → 複製/簽 dylib → 加 LC_LOAD_DYLIB → 保留 entitlements 重簽主程式。 */
export async function installLoader(): Promise<{ ok: boolean; message: string }> {
  const bin = mainBinaryPath();
  if (!fs.existsSync(bin)) return { ok: false, message: "Could not find BrownDustII. Is the PlayCover app installed?" };
  const versionCheck = await validateRuntimeInjectionGameVersion();
  if (!versionCheck.ok) return versionCheck;
  if (await isGameRunning()) return { ok: false, message: "Close BrownDust II before installing Runtime Injection." };
  const src = loaderSourcePath();
  if (!fs.existsSync(src)) return { ok: false, message: `Runtime loader dylib was not found: ${src}` };

  // 1) 取得「乾淨基底」與備份。遊戲更新後主程式會是全新未注入版，
  //    此時必須用「新主程式」刷新備份與 entitlements，避免用舊版備份覆蓋新主程式。
  const bak = backupBinaryPath();
  const ent = entitlementsCachePath();
  await fsp.mkdir(path.dirname(bak), { recursive: true });
  const alreadyInjected = hasLoadDylib(bin, LOADER_LOAD_NAME);
  if (!alreadyInjected) {
    // 全新/更新後的乾淨主程式 → 刷新備份與 entitlements
    await fsp.copyFile(bin, bak);
    const { stdout } = await exec("codesign", ["-d", "--entitlements", "-", "--xml", bin]);
    await fsp.writeFile(ent, stdout);
  } else {
    // 已注入 → 從（同版本）備份還原乾淨基底再重做
    if (!fs.existsSync(bak)) return { ok: false, message: "Injection is installed, but the clean backup is missing. Reinstall the game in PlayCover before trying again." };
    await fsp.copyFile(bak, bin);
    if (!fs.existsSync(ent)) {
      const { stdout } = await exec("codesign", ["-d", "--entitlements", "-", "--xml", bin]);
      await fsp.writeFile(ent, stdout);
    }
  }

  // 2) 複製 dylib 進 Frameworks、adhoc 簽。
  //    install_name 已在編譯時烤入（@executable_path/Frameworks/libbd2loader.dylib），
  //    故不需 install_name_tool（Xcode CLT），release 使用者免裝額外依賴。
  const dst = path.join(frameworksDir(), LOADER_DYLIB);
  await fsp.copyFile(src, dst);
  await exec("codesign", ["-f", "-s", "-", dst]);

  // 3) 加 LC_LOAD_DYLIB（bin 此時為乾淨基底）
  const r = addLoadDylib(bin, LOADER_LOAD_NAME);
  if (!r.ok) return { ok: false, message: `Injection failed: ${r.reason}` };

  // 4) 保留 entitlements 重簽主程式
  await exec("codesign", ["-f", "-s", "-", "--entitlements", ent, bin]);
  await exec("codesign", ["-v", bin]);
  return { ok: true, message: "Runtime loader installed. It will take effect the next time the game starts." };
}

/** 還原：用備份覆蓋主程式（移除注入）。只在目前已注入時動作，避免用舊備份覆蓋全新主程式。 */
export async function uninstallLoader(): Promise<{ ok: boolean; message: string }> {
  const bin = mainBinaryPath();
  const bak = backupBinaryPath();
  if (!fs.existsSync(bin)) return { ok: false, message: "Could not find BrownDustII." };
  if (await isGameRunning()) return { ok: false, message: "Close BrownDust II before removing Runtime Injection." };
  if (!hasLoadDylib(bin, LOADER_LOAD_NAME)) {
    return { ok: true, message: "Injection is not installed. Nothing to restore." };
  }
  if (!fs.existsSync(bak)) return { ok: false, message: "Clean backup is missing. Cannot restore the original executable." };
  await fsp.copyFile(bak, bin);
  return { ok: true, message: "Runtime loader removed. Original executable restored." };
}

/** Spine 轉換工具路徑（packaged → resources/tools；dev → manager-data）。 */
function converterPath() {
  return isPackagedRuntime()
    ? resourcePath("tools", "SpineSkeletonDataConverter")
    : path.resolve("manager-data/tools/SpineSkeletonDataConverter");
}

/** 能 hardlink 就 hardlink（同 volume、不複製資料）；跨 volume 失敗則退回複製。 */
async function linkOrCopyFile(src: string, dst: string) {
  try {
    await fsp.link(src, dst);
  } catch {
    await fsp.copyFile(src, dst);
  }
}

/**
 * 掛載一個 mod 到遊戲讀取目錄。
 * - 檔案優先 hardlink（省空間），跨 volume 退回複製。
 * - 若 mod 只有二進位 .skel（無 .json），自動轉成 .json（loader 的 json 路線最穩定，
 *   可避開二進位 .skel 在約會場景的問題）。
 */
export async function mountMod(srcDir: string, folderName?: string): Promise<{ ok: boolean; message: string }> {
  if (!fs.existsSync(srcDir)) return { ok: false, message: "Source folder does not exist." };
  const folder = safeRelativeFolder(folderName ?? path.basename(srcDir));
  if (!folder) return { ok: false, message: "Invalid mod folder name." };
  const dest = safeMountPath(folder);
  if (!dest) return { ok: false, message: "Invalid mod folder name." };
  await fsp.mkdir(mountDir(), { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });

  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  let linked = 0;
  let copied = 0;
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith("._")) continue;
    const src = path.join(srcDir, e.name);
    const dst = path.join(dest, e.name);
    const before = copied;
    try {
      await fsp.link(src, dst);
      linked++;
    } catch {
      await fsp.copyFile(src, dst);
      copied = before + 1;
    }
  }

  // 找 atlas 取得 key，若只有 .skel 則轉 .json
  const files = await fsp.readdir(dest);
  const atlas = files.find((f) => f.endsWith(".atlas") && !f.startsWith("._"));
  let convertedNote = "";
  if (atlas) {
    const key = atlas.slice(0, -".atlas".length);
    const hasJson = files.includes(`${key}.json`);
    const skel = path.join(dest, `${key}.skel`);
    if (!hasJson && fs.existsSync(skel)) {
      try {
        await exec(converterPath(), [skel, path.join(dest, `${key}.json`)]);
        convertedNote = " (.skel was converted to .json)";
      } catch (err) {
        convertedNote = ` (.skel to .json conversion failed; mounting the binary skeleton: ${String(err).slice(0, 80)})`;
      }
    }
  }

  return { ok: true, message: `Mounted ${folder} (hardlink ${linked} / copied ${copied})${convertedNote}` };
}

export async function unmountMod(folder: string): Promise<{ ok: boolean; message: string }> {
  const dest = safeMountPath(folder);
  if (!dest) return { ok: false, message: "Invalid mod folder name." };
  await fsp.rm(dest, { recursive: true, force: true });
  return { ok: true, message: `Unmounted ${folder}` };
}

export async function launchGame(): Promise<{ ok: boolean; message: string }> {
  const appPath = appBundlePath();
  if (!fs.existsSync(appPath)) return { ok: false, message: "Could not find the game app." };
  await exec("open", [appPath]);
  return { ok: true, message: "Game launched." };
}
