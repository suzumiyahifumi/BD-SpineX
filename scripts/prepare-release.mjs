import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameVersion = readGameVersion();

await updatePackageVersions(gameVersion);
await assertRequiredReleaseInputs();
await assertNoPrivatePaths();

console.log(`Prepared BD-SpineX release ${gameVersion}.`);

function readGameVersion() {
  const argVersion = process.argv.find((arg) => arg.startsWith("--game-version="))?.split("=")[1];
  const version = argVersion ?? process.env.BD_SPINEX_GAME_VERSION;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Set BD_SPINEX_GAME_VERSION=major.minor.patch or pass --game-version=major.minor.patch.");
  }

  return version;
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
}

async function assertRequiredReleaseInputs() {
  const requiredFiles = [
    "manager-data/shared-index.json",
    "manager-data/shared-file-index.json",
    "manager-data/tools/SpineSkeletonDataConverter",
    "dist-native/uabea-patcher/UabeaPatchPrototype",
    "dist-native/uabea-cli/uabea_cli",
    "dist-native/unitypy-backend/unitypy_patch_bundle",
    "dist-native/unitypy-backend/unitypy_scan_bundle"
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

async function assertNoPrivatePaths() {
  const scanRoots = [
    "app",
    "core",
    "experiments/uabea-patcher",
    "experiments/rust-uabea-cli/src",
    "manager-data/shared-index.json",
    "manager-data/shared-file-index.json",
    "package.json"
  ];
  const privatePatterns = [
    "/Users/",
    "/Volumes/",
    "suzumiyahifumi",
    root
  ];
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
