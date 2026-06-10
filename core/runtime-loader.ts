// Runtime（BepInEx-for-PlayCover）loader 管理：注入/還原 + mod 掛載 + 啟動。
// 對應 Phase 5 GUI。僅 macOS / PlayCover BrownDust II。
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { addLoadDylib, hasLoadDylib } from "./macho-inject.js";
import { isPackagedRuntime, resourcePath } from "./runtime-paths.js";

const exec = promisify(execFile);

const BUNDLE_ID = "com.neowizgames.game.browndust2ios";
const LOADER_DYLIB = "libbd2loader.dylib";
const LOADER_LOAD_NAME = `@executable_path/Frameworks/${LOADER_DYLIB}`;

export interface RuntimeMod {
  folder: string; // 掛載目錄/庫中的資料夾名
  key: string; // 資產基底名（char003604 / illust_dating11 / cutscene_charXXXXXX）
  type: "standing" | "dating" | "skillcut" | "other";
  skeleton: "json" | "skel" | "unknown";
  path: string;
}

export interface RuntimeStatus {
  appFound: boolean;
  appPath: string;
  injected: boolean;
  loaderAvailable: boolean;
  loaderPath: string;
  mountDir: string;
  mountedMods: RuntimeMod[];
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
function entitlementsCachePath() {
  return path.join(appBundlePath(), "..", `${BUNDLE_ID}.app.BAK-mainbin`, "bd2.entitlements.plist");
}

/** loader dylib 來源：packaged → resources/backend；dev → 編譯輸出。 */
export function loaderSourcePath() {
  if (isPackagedRuntime()) {
    return resourcePath("backend", "bd2loader", LOADER_DYLIB);
  }
  return path.resolve("bepinex-playcover/loader/target/aarch64-apple-darwin/release", LOADER_DYLIB);
}

function classifyKey(key: string): RuntimeMod["type"] {
  if (key.startsWith("cutscene_char")) return "skillcut";
  if (key.startsWith("illust_dating")) return "dating";
  if (/^char\d+$/.test(key)) return "standing";
  return "other";
}

/** 掃一個目錄底下的 mod 子資料夾（以 .atlas 的 stem 當 key）。 */
async function scanModDir(root: string): Promise<RuntimeMod[]> {
  const out: RuntimeMod[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    const atlas = files.find((f) => f.endsWith(".atlas") && !f.startsWith("._"));
    if (!atlas) continue;
    const key = atlas.slice(0, -".atlas".length);
    const skeleton: RuntimeMod["skeleton"] = files.includes(`${key}.json`)
      ? "json"
      : files.includes(`${key}.skel`)
        ? "skel"
        : "unknown";
    out.push({ folder: e.name, key, type: classifyKey(key), skeleton, path: dir });
  }
  return out;
}

export async function getStatus(): Promise<RuntimeStatus> {
  const appPath = appBundlePath();
  const appFound = fs.existsSync(mainBinaryPath());
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
  const mountedMods = await scanModDir(md);
  return { appFound, appPath, injected, loaderAvailable, loaderPath, mountDir: md, mountedMods };
}

export async function listLibraryMods(dir: string): Promise<RuntimeMod[]> {
  return scanModDir(dir);
}

/** 安裝注入：備份原檔 → 複製/簽 dylib → 加 LC_LOAD_DYLIB → 保留 entitlements 重簽主程式。 */
export async function installLoader(): Promise<{ ok: boolean; message: string }> {
  const bin = mainBinaryPath();
  if (!fs.existsSync(bin)) return { ok: false, message: "找不到 BrownDustII（PlayCover 未安裝？）" };
  const src = loaderSourcePath();
  if (!fs.existsSync(src)) return { ok: false, message: `找不到 loader dylib：${src}` };

  // 1) 備份原始主程式 + entitlements（僅首次）
  const bak = backupBinaryPath();
  await fsp.mkdir(path.dirname(bak), { recursive: true });
  if (!fs.existsSync(bak)) {
    await fsp.copyFile(bin, bak);
  }
  const ent = entitlementsCachePath();
  if (!fs.existsSync(ent)) {
    const { stdout } = await exec("codesign", ["-d", "--entitlements", "-", "--xml", bak]);
    await fsp.writeFile(ent, stdout);
  }

  // 2) 複製 dylib 進 Frameworks、設 id、adhoc 簽
  const dst = path.join(frameworksDir(), LOADER_DYLIB);
  await fsp.copyFile(src, dst);
  await exec("install_name_tool", ["-id", LOADER_LOAD_NAME, dst]);
  await exec("codesign", ["-f", "-s", "-", dst]);

  // 3) 加 LC_LOAD_DYLIB（從乾淨的備份開始，避免重複疊加）
  await fsp.copyFile(bak, bin);
  const r = addLoadDylib(bin, LOADER_LOAD_NAME);
  if (!r.ok) return { ok: false, message: `注入失敗：${r.reason}` };

  // 4) 保留 entitlements 重簽主程式
  await exec("codesign", ["-f", "-s", "-", "--entitlements", ent, bin]);
  await exec("codesign", ["-v", bin]);
  return { ok: true, message: "已安裝 Runtime loader（下次啟動遊戲生效）" };
}

/** 還原：用備份覆蓋主程式（移除注入）。 */
export async function uninstallLoader(): Promise<{ ok: boolean; message: string }> {
  const bin = mainBinaryPath();
  const bak = backupBinaryPath();
  if (!fs.existsSync(bak)) return { ok: false, message: "找不到備份，無法還原" };
  await fsp.copyFile(bak, bin);
  return { ok: true, message: "已移除 Runtime loader（還原原始主程式）" };
}

export async function mountMod(srcDir: string): Promise<{ ok: boolean; message: string }> {
  if (!fs.existsSync(srcDir)) return { ok: false, message: "來源資料夾不存在" };
  const dest = path.join(mountDir(), path.basename(srcDir));
  await fsp.mkdir(mountDir(), { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(srcDir, dest, { recursive: true, filter: (s) => !path.basename(s).startsWith("._") });
  return { ok: true, message: `已掛載 ${path.basename(srcDir)}` };
}

export async function unmountMod(folder: string): Promise<{ ok: boolean; message: string }> {
  const dest = path.join(mountDir(), folder);
  await fsp.rm(dest, { recursive: true, force: true });
  return { ok: true, message: `已卸載 ${folder}` };
}

export async function launchGame(): Promise<{ ok: boolean; message: string }> {
  const appPath = appBundlePath();
  if (!fs.existsSync(appPath)) return { ok: false, message: "找不到遊戲 app" };
  await exec("open", [appPath]);
  return { ok: true, message: "已啟動遊戲" };
}
