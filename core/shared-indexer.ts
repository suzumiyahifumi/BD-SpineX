import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { isPackagedRuntime, resourcePath, seedManagerDataDir, managerDataDir } from "./runtime-paths.js";
import type { SharedBundle, SharedFileEntry, SharedFileIndex, SharedIndex, SharedScanOptions, SharedScanProgress } from "./types.js";

export async function scanShared(
  sharedDir: string,
  options: SharedScanOptions = {},
  onProgress?: (progress: SharedScanProgress) => void,
  shouldStop?: () => boolean
): Promise<SharedIndex> {
  onProgress?.({ phase: "discovering", current: 0, total: 0 });
  const cachedFileIndex = options.forceRescan ? undefined : await readExistingSharedFileIndex(sharedDir);
  const candidates = cachedFileIndex
    ? candidatesFromFileIndex(cachedFileIndex, sharedDir)
    : await findSharedBundleCandidates(sharedDir);

  if (!cachedFileIndex) {
    const fileIndex = createSharedFileIndex(sharedDir, candidates);
    await writeJson(sharedFileIndexPath(), fileIndex);
  }

  const targetNames = normalizeTargetNames(options.targetNames ?? []);
  const knownIndex = options.forceRescan
    ? { bundles: [] }
    : mergeSharedIndexes(await readExistingSharedIndex(), { bundles: [] });
  let foundTargets = findFoundTargetNames(knownIndex, targetNames);
  const scannedBundleIds = new Set(knownIndex.bundles.map((bundle) => bundle.bundleId));
  const scanCandidates = candidates.filter((candidate) => !scannedBundleIds.has(candidate.bundleId));

  onProgress?.({
    phase: "found",
    current: 0,
    total: scanCandidates.length,
    discoveredTotal: candidates.length,
    targetTotal: targetNames.length,
    targetFound: foundTargets.size
  });

  if (targetNames.length > 0 && foundTargets.size === targetNames.length) {
    await writeSharedIndex(knownIndex);
    onProgress?.({
      phase: "done",
      current: 0,
      total: 0,
      discoveredTotal: candidates.length,
      targetTotal: targetNames.length,
      targetFound: foundTargets.size
    });
    return hydrateSharedIndex(knownIndex, sharedDir);
  }

  const bundles: SharedBundle[] = [];
  const batchSize = typeof options.scanLimit === "number" && options.scanLimit > 0
    ? options.scanLimit
    : scanCandidates.length;
  let scannedThisRun = 0;

  for (let cursor = 0; cursor < scanCandidates.length; cursor += batchSize) {
    const batch = scanCandidates.slice(cursor, cursor + batchSize);

    for (const candidate of batch) {
      if (shouldStop?.()) {
        const stoppedIndex = mergeSharedIndexes(knownIndex, { bundles });
        await writeSharedIndex(stoppedIndex);
        onProgress?.({
          phase: "stopped",
          current: scannedThisRun,
          total: scanCandidates.length,
          discoveredTotal: candidates.length,
          targetTotal: targetNames.length,
          targetFound: foundTargets.size
        });
        return hydrateSharedIndex(stoppedIndex, sharedDir);
      }

    const bundle: SharedBundle = {
      bundleId: candidate.bundleId,
      dataPath: candidate.dataPath,
      infoPath: candidate.infoPath,
      hasInfo: Boolean(candidate.infoPath),
      sizeBytes: candidate.sizeBytes,
      assets: []
    };

    onProgress?.({
      phase: "scanning",
      current: scannedThisRun + 1,
      total: scanCandidates.length,
      discoveredTotal: candidates.length,
      targetTotal: targetNames.length,
      targetFound: foundTargets.size,
      bundleId: candidate.bundleId,
      sizeBytes: candidate.sizeBytes
    });

    try {
      bundle.assets = await scanBundleAssets(candidate.dataPath, options);
    } catch (error) {
      bundle.scanError = error instanceof Error ? error.message : String(error);
    }

    bundles.push(bundle);
    scannedThisRun += 1;
    const currentIndex = mergeSharedIndexes(knownIndex, { bundles });
    foundTargets = findFoundTargetNames(currentIndex, targetNames);
    await writeSharedIndex(currentIndex);

    onProgress?.({
      phase: "scanned",
      current: scannedThisRun,
      total: scanCandidates.length,
      discoveredTotal: candidates.length,
      targetTotal: targetNames.length,
      targetFound: foundTargets.size,
      bundleId: candidate.bundleId,
      sizeBytes: candidate.sizeBytes,
      assetCount: bundle.assets.length,
      error: bundle.scanError
    });

      if (targetNames.length > 0 && foundTargets.size === targetNames.length) {
        const sharedIndex = mergeSharedIndexes(knownIndex, { bundles });
        await writeSharedIndex(sharedIndex);
        onProgress?.({
          phase: "done",
          current: scannedThisRun,
          total: scanCandidates.length,
          discoveredTotal: candidates.length,
          targetTotal: targetNames.length,
          targetFound: foundTargets.size
        });
        return hydrateSharedIndex(sharedIndex, sharedDir);
      }
    }
  }

  const sharedIndex = mergeSharedIndexes(knownIndex, { bundles });
  await writeSharedIndex(sharedIndex);
  onProgress?.({
    phase: "done",
    current: scannedThisRun,
    total: scanCandidates.length,
    discoveredTotal: candidates.length,
    targetTotal: targetNames.length,
    targetFound: foundTargets.size
  });
  return hydrateSharedIndex(sharedIndex, sharedDir);
}

type SharedBundleCandidate = {
  bundleId: string;
  dataPath: string;
  infoPath?: string;
  sizeBytes: number;
  modifiedAt: string;
};

async function findSharedBundleCandidates(sharedDir: string): Promise<SharedBundleCandidate[]> {
  const directCandidates = await findTwoLevelHashCandidates(sharedDir);
  if (directCandidates.length > 0) {
    return sortCandidatesBySize(directCandidates);
  }

  return sortCandidatesBySize(await findRecursiveCandidates(sharedDir));
}

async function findTwoLevelHashCandidates(sharedDir: string): Promise<SharedBundleCandidate[]> {
  const candidates: SharedBundleCandidate[] = [];
  const firstLevel = await fs.readdir(sharedDir, { withFileTypes: true });

  for (const hash1Entry of firstLevel) {
    if (!hash1Entry.isDirectory()) {
      continue;
    }

    const hash1Path = path.join(sharedDir, hash1Entry.name);
    const secondLevel = await fs.readdir(hash1Path, { withFileTypes: true });

    for (const hash2Entry of secondLevel) {
      if (!hash2Entry.isDirectory()) {
        continue;
      }

      const hash2Path = path.join(hash1Path, hash2Entry.name);
      const dataPath = path.join(hash2Path, "__data");
      if (!await fileExists(dataPath)) {
        continue;
      }
      const stat = await fs.stat(dataPath);

      candidates.push({
        bundleId: `${hash1Entry.name}/${hash2Entry.name}`,
        dataPath,
        infoPath: await optionalInfoPath(hash2Path),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }

  return candidates;
}

async function findRecursiveCandidates(root: string): Promise<SharedBundleCandidate[]> {
  const found: SharedBundleCandidate[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const current = path.join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...await findRecursiveCandidates(current));
      continue;
    }

    if (entry.isFile() && entry.name === "__data") {
      const bundleDir = path.dirname(current);
      const hash2 = path.basename(bundleDir);
      const hash1 = path.basename(path.dirname(bundleDir));
      const stat = await fs.stat(current);
      found.push({
        bundleId: `${hash1}/${hash2}`,
        dataPath: current,
        infoPath: await optionalInfoPath(bundleDir),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }

  return found;
}

function sortCandidatesBySize(candidates: SharedBundleCandidate[]) {
  return [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function createSharedFileIndex(sharedDir: string, candidates: SharedBundleCandidate[]): SharedFileIndex {
  return {
    generatedAt: new Date().toISOString(),
    sharedRootKey: sharedDirCacheKey(sharedDir),
    files: candidates.map((candidate) => ({
      bundleId: candidate.bundleId,
      sizeBytes: candidate.sizeBytes,
      modifiedAt: candidate.modifiedAt,
      hasInfo: Boolean(candidate.infoPath)
    }))
  };
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeSharedIndex(index: SharedIndex) {
  await writeJson(sharedIndexPath(), toPortableSharedIndex(index));
}

export async function readSharedIndex(sharedDir?: string): Promise<SharedIndex> {
  for (const indexPath of sharedIndexReadPaths()) {
    try {
      const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as SharedIndex;
      if (!sharedDir?.trim()) {
        return toPortableSharedIndex(index);
      }

      return hydrateSharedIndex(index, sharedDir);
    } catch {
      continue;
    }
  }

  return { bundles: [] };
}

async function readExistingSharedIndex(): Promise<SharedIndex> {
  return readSharedIndex();
}

async function readExistingSharedFileIndex(sharedDir: string): Promise<SharedFileIndex | undefined> {
  for (const indexPath of sharedFileIndexReadPaths()) {
    try {
      const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as SharedFileIndex;
      if ("sharedRootKey" in index) {
        if (index.sharedRootKey === sharedDirCacheKey(sharedDir)) {
          return index;
        }
        continue;
      }

      const legacyIndex = index as SharedFileIndex & { sharedDir?: string };
      if (legacyIndex.sharedDir && path.resolve(legacyIndex.sharedDir) === path.resolve(sharedDir)) {
        return {
            generatedAt: legacyIndex.generatedAt,
            sharedRootKey: sharedDirCacheKey(sharedDir),
            files: legacyIndex.files.map((file) => {
              const legacyFile = file as SharedFileEntry & { infoPath?: string };
              return {
                bundleId: file.bundleId,
                sizeBytes: file.sizeBytes,
                modifiedAt: file.modifiedAt,
                hasInfo: Boolean(legacyFile.infoPath)
              };
            })
          };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function candidatesFromFileIndex(index: SharedFileIndex, sharedDir?: string): SharedBundleCandidate[] {
  return sortCandidatesBySize(index.files.flatMap((file) => {
    if (!safeBundleIdParts(file.bundleId)) {
      return [];
    }

    return [{
      bundleId: file.bundleId,
      dataPath: dataPathForBundleId(sharedDir ?? "", file.bundleId),
      infoPath: file.hasInfo ? infoPathForBundleId(sharedDir ?? "", file.bundleId) : undefined,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt
    }];
  }));
}

function mergeSharedIndexes(...indexes: SharedIndex[]): SharedIndex {
  const bundles = new Map<string, SharedBundle>();

  for (const index of indexes) {
    for (const bundle of index.bundles) {
      bundles.set(bundle.bundleId, bundle);
    }
  }

  return withAssetNameIndex({ bundles: [...bundles.values()] });
}

function toPortableSharedIndex(index: SharedIndex): SharedIndex {
  return withAssetNameIndex({
    bundles: index.bundles.map((bundle) => ({
      bundleId: bundle.bundleId,
      hasInfo: bundle.hasInfo ?? Boolean(bundle.infoPath),
      sizeBytes: bundle.sizeBytes,
      assets: bundle.assets,
      scanError: bundle.scanError
    }))
  });
}

function hydrateSharedIndex(index: SharedIndex, sharedDir: string): SharedIndex {
  return withAssetNameIndex({
    bundles: index.bundles.flatMap((bundle) => {
      if (!safeBundleIdParts(bundle.bundleId)) {
        return [];
      }

      const dataPath = bundle.dataPath && isPathInside(bundle.dataPath, sharedDir)
        ? bundle.dataPath
        : dataPathForBundleId(sharedDir, bundle.bundleId);
      const hasInfo = bundle.hasInfo ?? Boolean(bundle.infoPath);

      return [{
        ...bundle,
        dataPath,
        infoPath: hasInfo
          ? bundle.infoPath && isPathInside(bundle.infoPath, sharedDir)
            ? bundle.infoPath
            : infoPathForBundleId(sharedDir, bundle.bundleId)
          : undefined,
        hasInfo
      }];
    })
  });
}

function withAssetNameIndex(index: SharedIndex): SharedIndex {
  return {
    ...index,
    assetsByName: buildAssetNameIndex(index.bundles)
  };
}

function buildAssetNameIndex(bundles: SharedBundle[]) {
  const byName: NonNullable<SharedIndex["assetsByName"]> = {};

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

function assetNameIndexKeys(assetName: string, type: string) {
  const normalized = assetName.toLowerCase();
  const keys = new Set([normalized]);
  if (type === "Texture2D" && !normalized.endsWith(".png")) {
    keys.add(`${normalized}.png`);
  }

  return [...keys];
}

function sortAssetNameIndex(index: NonNullable<SharedIndex["assetsByName"]>) {
  const sorted: NonNullable<SharedIndex["assetsByName"]> = {};
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

function dataPathForBundleId(sharedDir: string, bundleId: string) {
  return path.join(sharedDir, ...requireSafeBundleIdParts(bundleId), "__data");
}

function infoPathForBundleId(sharedDir: string, bundleId: string) {
  return path.join(sharedDir, ...requireSafeBundleIdParts(bundleId), "__info");
}

function requireSafeBundleIdParts(bundleId: string) {
  const parts = safeBundleIdParts(bundleId);
  if (!parts) {
    throw new Error(`Invalid Shared bundleId: ${bundleId}`);
  }

  return parts;
}

function safeBundleIdParts(bundleId: string) {
  const parts = bundleId.split("/");
  return parts.length === 2 && parts.every((part) => /^[a-f0-9]{32}$/i.test(part)) ? parts : undefined;
}

function isPathInside(filePath: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sharedDirCacheKey(sharedDir: string) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(sharedDir))
    .digest("hex");
}

function normalizeTargetNames(targetNames: string[]) {
  return [...new Set(targetNames.map((name) => name.trim().toLowerCase()).filter(Boolean))];
}

function findFoundTargetNames(sharedIndex: SharedIndex, targetNames: string[]) {
  const found = new Set<string>();

  for (const assetName of Object.keys(sharedIndex.assetsByName ?? {})) {
    for (const targetName of targetNames) {
      if (!found.has(targetName) && assetName.includes(targetName)) {
        found.add(targetName);
      }
    }
  }

  if (found.size === targetNames.length) {
    return found;
  }

  for (const bundle of sharedIndex.bundles) {
    for (const asset of bundle.assets) {
      const assetName = asset.name.toLowerCase();

      for (const targetName of targetNames) {
        if (found.has(targetName) || !assetName.includes(targetName)) {
          continue;
        }

        if (isSpineCandidateAsset(assetName, asset.type)) {
          found.add(targetName);
        }
      }
    }
  }

  return found;
}

function isSpineCandidateAsset(assetName: string, type: string) {
  return (type === "TextAsset" && (assetName.includes("skel") || assetName.includes("atlas"))) ||
    type === "Texture2D";
}

async function optionalInfoPath(bundleDir: string) {
  const infoPath = path.join(bundleDir, "__info");
  return await fileExists(infoPath) ? infoPath : undefined;
}

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function scanBundleAssets(dataPath: string, options: SharedScanOptions) {
  if (options.scanBackend === "rust-native") {
    return scanBundleAssetsWithRustNative(dataPath);
  }

  if (options.scanBackend === "unitypy") {
    return scanBundleAssetsWithUnityPy(dataPath, options);
  }

  return scanBundleAssetsWithUabea(dataPath, options);
}

async function scanBundleAssetsWithUnityPy(dataPath: string, options: SharedScanOptions) {
  const executablePath = unityPyScanExecutablePath();
  const command = executablePath ?? options.pythonPath?.trim() ?? defaultPythonPath();
  const args = executablePath ? [] : [defaultUnityPyScanScriptPath()];
  args.push(
    "--input", dataPath
  );

  if (options.unityVersion?.trim()) {
    args.push("--unity-version", options.unityVersion.trim());
  }

  if (options.decryptKey?.trim()) {
    args.push("--decrypt-key", options.decryptKey.trim());
  }

  const stdout = await run(command, args);
  let result: { ok: boolean; assets?: SharedBundle["assets"]; error?: string };

  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(stdout.trim() || "UnityPy scanner did not return JSON");
  }

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to scan Unity AssetBundle with UnityPy scanner");
  }

  return result.assets ?? [];
}

async function scanBundleAssetsWithRustNative(dataPath: string) {
  const command = rustCliCommand();
  const args = rustCliBaseArgs([
    "--rust-backend", "native",
    "--mode", "scan",
    "--input", dataPath
  ]);
  const stdout = await run(command, args);
  let result: { ok: boolean; assets?: SharedBundle["assets"]; error?: string };

  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(stdout.trim() || "Rust native scanner did not return JSON");
  }

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to scan Unity AssetBundle with Rust native scanner");
  }

  return result.assets ?? [];
}

async function scanBundleAssetsWithUabea(dataPath: string, options: SharedScanOptions) {
  const command = uabeaCommand();
  const projectPath = options.uabeaScannerProjectPath?.trim() || defaultUabeaProjectPath();
  const directUabea = usesDirectUabeaExecutable();
  const backendArgs = [
    "--mode", "scan",
    "--input", dataPath
  ];
  const args = uabeaBaseArgs(directUabea
    ? backendArgs
    : [
        ...backendArgs,
        "--dotnet-path", options.dotnetPath?.trim() || defaultDotnetPath(),
        "--uabea-project", projectPath
      ]);
  const stdout = await run(command, args);
  let result: { ok: boolean; assets?: SharedBundle["assets"]; error?: string };

  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(stdout.trim() || "UABEA scanner did not return JSON");
  }

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to scan Unity AssetBundle with UABEA scanner");
  }

  return result.assets ?? [];
}

function defaultDotnetPath() {
  return path.resolve("manager-data/tools/dotnet/dotnet");
}

function defaultPythonPath() {
  const venvPython = path.resolve(".venv/bin/python");
  return existsSync(venvPython) ? venvPython : "python3";
}

function defaultUnityPyScanScriptPath() {
  return resourcePath("python", "scan_bundle.py");
}

function unityPyScanExecutablePath() {
  const executablePath = isPackagedRuntime()
    ? resourcePath("backend", "unitypy", "unitypy_scan_bundle")
    : path.resolve("dist-native/unitypy-backend/unitypy_scan_bundle");

  return existsSync(executablePath) ? executablePath : undefined;
}

function defaultUabeaProjectPath() {
  return isPackagedRuntime()
    ? path.join(process.resourcesPath, "backend", "uabea-patcher", "UabeaPatchPrototype")
    : path.resolve("experiments/uabea-patcher/UabeaPatchPrototype.csproj");
}

function rustCliCommand() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-cli", "uabea_cli")
    : "cargo";
}

function uabeaCommand() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-patcher", "UabeaPatchPrototype")
    : devUabeaExecutablePath() ?? "cargo";
}

function uabeaBaseArgs(args: string[]) {
  if (usesDirectUabeaExecutable()) {
    return args;
  }

  return rustCliBaseArgs(args);
}

function usesDirectUabeaExecutable() {
  return isPackagedRuntime() || Boolean(devUabeaExecutablePath());
}

function devUabeaExecutablePath() {
  const executablePath = path.resolve("dist-native/uabea-patcher/UabeaPatchPrototype");
  return existsSync(executablePath) ? executablePath : undefined;
}

function rustCliBaseArgs(args: string[]) {
  if (isPackagedRuntime()) {
    return args;
  }

  return [
    "run",
    "--manifest-path", path.resolve("experiments/rust-uabea-cli/Cargo.toml"),
    "--quiet",
    "--",
    ...args
  ];
}

function sharedIndexPath() {
  return path.join(managerDataDir(), "shared-index.json");
}

function sharedFileIndexPath() {
  return path.join(managerDataDir(), "shared-file-index.json");
}

function seedSharedIndexPath() {
  return path.join(seedManagerDataDir(), "shared-index.json");
}

function seedSharedFileIndexPath() {
  return path.join(seedManagerDataDir(), "shared-file-index.json");
}

function sharedIndexReadPaths() {
  return uniquePaths([sharedIndexPath(), seedSharedIndexPath()]);
}

function sharedFileIndexReadPaths() {
  return uniquePaths([sharedFileIndexPath(), seedSharedFileIndexPath()]);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths)];
}

function run(command: string, args: string[]): Promise<string> {
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
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
}
