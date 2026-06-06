import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectGameVersion } from "../dist/core/game-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = path.join(root, "manager-data", "settings.json");

const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
const sharedDir = cliValue("shared-dir") ?? settings.sharedDir;
if (!sharedDir?.trim()) {
  throw new Error("Missing Shared folder. Set manager-data/settings.json or pass --shared-dir=/path/to/Shared.");
}

const versionInfo = await detectGameVersion(sharedDir);
const gameVersion = cliValue("game-version") ?? versionInfo.version;
if (!gameVersion?.trim()) {
  throw new Error("Could not detect game version. Pass --game-version=major.minor.patch.");
}

const normalizedGameVersion = supportedGameVersion(gameVersion);
const outputDir = path.join(root, "manager-data", "versions", sanitizePathPart(supportedGameVersion(gameVersion)));
await fs.mkdir(outputDir, { recursive: true });

console.log(`Scanning Shared for BrownDust II ${gameVersion}`);
console.log(`Shared: ${sharedDir}`);
console.log(`Output: ${path.relative(root, outputDir)}`);

const candidates = sortCandidatesBySize(await findSharedBundleCandidates(sharedDir));
console.log(`Hashing ${candidates.length} bundle candidate(s).`);
for (const [index, candidate] of candidates.entries()) {
  candidate.sha256 = await hashFile(candidate.dataPath);
  if ((index + 1) % 100 === 0 || index + 1 === candidates.length) {
    console.log(`Hashed ${index + 1}/${candidates.length}`);
  }
}
await writeJson(path.join(outputDir, "shared-file-index.json"), createSharedFileIndex(sharedDir, candidates));
console.log(`Found ${candidates.length} bundle candidate(s).`);

const bundles = [];
for (const [index, candidate] of candidates.entries()) {
  const bundle = {
    bundleId: candidate.bundleId,
    hasInfo: candidate.hasInfo,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    assets: []
  };

  try {
    bundle.assets = await scanBundleAssetsWithUabea(candidate.dataPath);
  } catch (error) {
    bundle.scanError = error instanceof Error ? error.message : String(error);
  }

  bundles.push(bundle);
  await writeJson(path.join(outputDir, "shared-index.json"), withAssetNameIndex(createSharedIndex(bundles)));

  const detail = bundle.scanError
    ? `${bundle.bundleId}: error`
    : `${bundle.bundleId}: ${bundle.assets.length} asset(s)`;
  console.log(`Scanned ${index + 1}/${candidates.length} ${detail}`);
}

const sharedIndex = withAssetNameIndex(createSharedIndex(bundles));
await writeJson(path.join(outputDir, "shared-index.json"), sharedIndex);

const assetCount = bundles.reduce((sum, bundle) => sum + bundle.assets.length, 0);
const errorCount = bundles.filter((bundle) => bundle.scanError).length;
console.log(`Indexed ${bundles.length} bundle(s), ${assetCount} candidate asset(s), ${errorCount} scan error(s).`);

function cliValue(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
}

function supportedGameVersion(version) {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

function sanitizePathPart(value) {
  return value.replace(/[/:\\]/g, "_");
}

async function findSharedBundleCandidates(rootDir) {
  const directCandidates = await findTwoLevelHashCandidates(rootDir);
  if (directCandidates.length > 0) {
    return directCandidates;
  }

  return findRecursiveCandidates(rootDir);
}

async function findTwoLevelHashCandidates(rootDir) {
  const candidates = [];
  const firstLevel = await fs.readdir(rootDir, { withFileTypes: true });
  for (const hash1Entry of firstLevel) {
    if (!hash1Entry.isDirectory()) {
      continue;
    }

    const hash1Path = path.join(rootDir, hash1Entry.name);
    const secondLevel = await fs.readdir(hash1Path, { withFileTypes: true }).catch(() => []);
    for (const hash2Entry of secondLevel) {
      if (!hash2Entry.isDirectory()) {
        continue;
      }

      const bundleDir = path.join(hash1Path, hash2Entry.name);
      const dataPath = path.join(bundleDir, "__data");
      if (!existsSync(dataPath)) {
        continue;
      }

      candidates.push(await candidateFromDataPath(rootDir, dataPath));
    }
  }

  return candidates;
}

async function findRecursiveCandidates(rootDir) {
  const candidates = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (entry.name === "__data") {
        candidates.push(await candidateFromDataPath(rootDir, entryPath));
      }
    }
  }

  return candidates;
}

async function candidateFromDataPath(rootDir, dataPath) {
  const bundleDir = path.dirname(dataPath);
  const relativeDir = path.relative(rootDir, bundleDir);
  const stat = await fs.stat(dataPath);
  return {
    bundleId: relativeDir.split(path.sep).join("/"),
    dataPath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    hasInfo: existsSync(path.join(bundleDir, "__info"))
  };
}

function sortCandidatesBySize(candidates) {
  return [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function createSharedFileIndex(rootDir, candidates) {
  return {
    indexVersion: 2,
    gameVersion: normalizedGameVersion,
    generatedAt: new Date().toISOString(),
    sharedRootKey: crypto.createHash("sha256").update(path.resolve(rootDir)).digest("hex"),
    files: candidates.map((candidate) => ({
      bundleId: candidate.bundleId,
      sizeBytes: candidate.sizeBytes,
      modifiedAt: candidate.modifiedAt,
      sha256: candidate.sha256,
      hasInfo: candidate.hasInfo
    }))
  };
}

function createSharedIndex(bundles) {
  return {
    indexVersion: 2,
    gameVersion: normalizedGameVersion,
    generatedAt: new Date().toISOString(),
    bundles
  };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function scanBundleAssetsWithUabea(dataPath) {
  const command = uabeaCommand();
  const args = uabeaArgs(["--mode", "scan", "--input", dataPath]);
  const stdout = await run(command, args);
  const result = JSON.parse(stdout);
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to scan Unity AssetBundle with UABEA scanner");
  }

  return result.assets ?? [];
}

function uabeaCommand() {
  const executablePath = path.join(root, "dist-native", "uabea-patcher", "UabeaPatchPrototype");
  return existsSync(executablePath) ? executablePath : "cargo";
}

function uabeaArgs(args) {
  if (uabeaCommand() !== "cargo") {
    return args;
  }

  return [
    "run",
    "--manifest-path", path.join(root, "experiments", "rust-uabea-cli", "Cargo.toml"),
    "--quiet",
    "--",
    ...args
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

function withAssetNameIndex(index) {
  return {
    ...index,
    assetsByName: buildAssetNameIndex(index.bundles)
  };
}

function buildAssetNameIndex(bundles) {
  const byName = {};
  for (const bundle of bundles) {
    for (const asset of bundle.assets) {
      const entry = {
        bundleId: bundle.bundleId,
        assetName: asset.name,
        type: asset.type,
        pathId: asset.pathId,
        width: asset.width,
        height: asset.height,
        textureFormat: asset.textureFormat,
        textureFormatName: asset.textureFormatName,
        streamDataSize: asset.streamDataSize,
        streamDataPath: asset.streamDataPath,
        imageDataSize: asset.imageDataSize
      };

      for (const key of assetNameIndexKeys(asset.name, asset.type)) {
        byName[key] = byName[key] ?? [];
        if (!byName[key].some((current) =>
          current.bundleId === entry.bundleId &&
          current.pathId === entry.pathId &&
          current.type === entry.type
        )) {
          byName[key].push(entry);
        }
      }
    }
  }

  return sortAssetNameIndex(byName);
}

function assetNameIndexKeys(assetName, type) {
  const normalized = assetName.toLowerCase();
  const keys = new Set([normalized]);
  if (type === "Texture2D" && !normalized.endsWith(".png")) {
    keys.add(`${normalized}.png`);
  }

  return [...keys];
}

function sortAssetNameIndex(index) {
  const sorted = {};
  for (const key of Object.keys(index).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = [...index[key]].sort((a, b) =>
      a.bundleId.localeCompare(b.bundleId) ||
      a.type.localeCompare(b.type) ||
      a.assetName.localeCompare(b.assetName) ||
      a.pathId - b.pathId
    );
  }

  return sorted;
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
