import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateRuntimeRoot = path.join(root, "private", "runtime-injection");
const currentPackageVersion = await readCurrentPackageVersion();
const gameVersion = readGameVersion(currentPackageVersion);
const releaseVersion = readReleaseVersion(gameVersion, currentPackageVersion);

await updatePackageVersions(releaseVersion);
await assertRequiredReleaseInputs();
await assertVersionedIndexes();
await assertNoPrivatePaths();

console.log(`Prepared BD-SpineX release ${releaseVersion} for BrownDust II ${gameVersion}.`);

function readGameVersion(currentVersion) {
  const argVersion = process.argv.find((arg) => arg.startsWith("--game-version="))?.split("=")[1];
  const version = argVersion ?? process.env.BD_SPINEX_GAME_VERSION ?? supportedGameVersion(currentVersion);
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Set package.json version, BD_SPINEX_GAME_VERSION=major.minor.patch[-suffix], or pass --game-version=major.minor.patch[-suffix].");
  }

  return supportedGameVersion(version);
}

function readReleaseVersion(gameVersion, currentVersion) {
  const argVersion = process.argv.find((arg) => arg.startsWith("--release-version="))?.split("=")[1];
  const version = argVersion ?? process.env.BD_SPINEX_RELEASE_VERSION ?? currentVersion ?? gameVersion;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Set BD_SPINEX_RELEASE_VERSION=major.minor.patch[-suffix] or pass --release-version=major.minor.patch[-suffix].");
  }

  if (supportedGameVersion(version) !== gameVersion) {
    throw new Error(`Release version ${version} must target game version ${gameVersion}.`);
  }

  return version;
}

function supportedGameVersion(version) {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

async function updatePackageVersions(version) {
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  packageJson.version = version;
  await writeJson(packagePath, packageJson);

  const lockPath = path.join(root, "package-lock.json");
  const lockJson = JSON.parse(await fs.readFile(lockPath, "utf8"));
  lockJson.version = version;
  if (lockJson.packages?.[""]) {
    lockJson.packages[""].version = version;
  }
  await writeJson(lockPath, lockJson);

  const tauriConfigPath = path.join(root, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(await fs.readFile(tauriConfigPath, "utf8"));
  tauriConfig.version = version;
  await writeJson(tauriConfigPath, tauriConfig);

  await updateTomlPackageVersion(path.join(root, "src-tauri/Cargo.toml"), version);
  await updateCargoLockPackageVersion(path.join(root, "src-tauri/Cargo.lock"), "bd-spinex-tauri", version);
}

async function readCurrentPackageVersion() {
  const packageJson = await readJson(path.join(root, "package.json"));
  return typeof packageJson.version === "string" ? packageJson.version : "";
}

async function assertRequiredReleaseInputs() {
  await assertPrivateRuntimeWorkspace();

  const requiredFiles = [
    `manager-data/versions/${gameVersion}/shared-index.json`,
    `manager-data/versions/${gameVersion}/shared-file-index.json`,
    "manager-data/tools/SpineSkeletonDataConverter",
    "dist-native/uabea-patcher/UabeaPatchPrototype",
    "dist-native/uabea-cli/uabea_cli",
    "dist-native/unitypy-backend/unitypy_patch_bundle",
    "dist-native/unitypy-backend/unitypy_scan_bundle",
    "dist-native/unitypy-backend/astc_encode",
    "dist-native/bd2loader/libbd2loader.dylib"
  ];

  for (const relativePath of requiredFiles) {
    const filePath = path.join(root, relativePath);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error(`${relativePath} is not a file.`);
      }
    } catch {
      throw new Error(`Missing release input: ${relativePath}`);
    }
  }
}

async function assertPrivateRuntimeWorkspace() {
  const requiredPrivateFiles = [
    "core/runtime-loader.ts",
    "core/macho-inject.ts",
    "scripts/build-loader.mjs",
    "src-tauri/lib.rs",
    "native/bd2loader/Cargo.toml"
  ];

  for (const relativePath of requiredPrivateFiles) {
    const filePath = path.join(privateRuntimeRoot, relativePath);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error(`${relativePath} is not a file.`);
      }
    } catch {
      throw new Error(`Missing private Runtime Injection input: private/runtime-injection/${relativePath}`);
    }
  }
}

async function assertVersionedIndexes() {
  const sharedIndex = await readJson(path.join(root, `manager-data/versions/${gameVersion}/shared-index.json`));
  const fileIndex = await readJson(path.join(root, `manager-data/versions/${gameVersion}/shared-file-index.json`));
  const bundles = Array.isArray(sharedIndex.bundles) ? sharedIndex.bundles : [];
  const files = Array.isArray(fileIndex.files) ? fileIndex.files : [];

  if (sharedIndex.gameVersion !== gameVersion || fileIndex.gameVersion !== gameVersion) {
    throw new Error(`Versioned indexes must include gameVersion ${gameVersion}.`);
  }

  if (sharedIndex.indexVersion < 2 || fileIndex.indexVersion < 2) {
    throw new Error("Versioned indexes must use indexVersion 2 or newer.");
  }

  const missingBundleSha = bundles.filter((bundle) => !isSha256(bundle.sha256)).length;
  const missingFileSha = files.filter((file) => !isSha256(file.sha256)).length;
  if (missingBundleSha > 0 || missingFileSha > 0) {
    throw new Error(`Versioned indexes must include SHA-256 for every __data (${missingBundleSha} shared-index missing, ${missingFileSha} file-index missing).`);
  }
}

async function assertNoPrivatePaths() {
  const scanRoots = [
    "app",
    "core",
    "private/runtime-injection/core",
    "private/runtime-injection/src-tauri",
    "private/runtime-injection/native/bd2loader",
    "experiments/uabea-patcher",
    "experiments/rust-uabea-cli/src",
    "dist-native/bd2loader/libbd2loader.dylib",
    `manager-data/versions/${gameVersion}/shared-index.json`,
    `manager-data/versions/${gameVersion}/shared-file-index.json`,
    "package.json"
  ];
  const privatePatterns = [
    "/Users/",
    "/Volumes/",
    root
  ].filter(Boolean);
  const leaks = [];

  for (const relativePath of scanRoots) {
    await scanPath(path.join(root, relativePath), privatePatterns, leaks);
  }

  if (leaks.length > 0) {
    throw new Error(`Private path found in release inputs:\n${leaks.join("\n")}`);
  }
}

async function scanPath(filePath, privatePatterns, leaks) {
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "target" || entry.name === "bin" || entry.name === "obj") {
        continue;
      }
      await scanPath(path.join(filePath, entry.name), privatePatterns, leaks);
    }
    return;
  }

  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  for (const pattern of privatePatterns) {
    if (text.includes(pattern)) {
      leaks.push(path.relative(root, filePath));
      break;
    }
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function updateTomlPackageVersion(filePath, version) {
  const text = await fs.readFile(filePath, "utf8");
  const pattern = /^version = "[^"]+"/m;
  if (!pattern.test(text)) {
    throw new Error(`Could not update package version in ${path.relative(root, filePath)}.`);
  }
  const next = text.replace(pattern, `version = "${version}"`);
  await fs.writeFile(filePath, next, "utf8");
}

async function updateCargoLockPackageVersion(filePath, packageName, version) {
  const text = await fs.readFile(filePath, "utf8");
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")[^"]+(")`);
  if (!pattern.test(text)) {
    throw new Error(`Could not update ${packageName} version in ${path.relative(root, filePath)}.`);
  }
  const next = text.replace(pattern, `$1${version}$2`);
  await fs.writeFile(filePath, next, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
