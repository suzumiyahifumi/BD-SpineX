import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanMods } from "../dist/core/mod-indexer.js";
import { createPatchPlan } from "../dist/core/patch-plan.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modName = cliValue("mod") ?? "Palette Date yuk11sh1d4 RC2";
const gameVersion = cliValue("game-version") ?? "2.26.12";
const bundleLimit = Number(cliValue("bundle-limit") ?? "1");
const oldManagerDataDirs = [
  cliValue("old-manager-data-dir"),
  path.join(root, "manager-data"),
  path.join(root, "manager-data", "versions")
].filter(Boolean);
const settings = JSON.parse(await fs.readFile(path.join(root, "manager-data", "settings.json"), "utf8"));
const modsIndex = await scanMods(settings.modsDir);
const sharedIndex = JSON.parse(await fs.readFile(path.join(root, "manager-data", "versions", gameVersion, "shared-index.json"), "utf8"));
sharedIndex.bundles = sharedIndex.bundles.map((bundle) => ({
  ...bundle,
  dataPath: bundle.dataPath ?? path.join(settings.sharedDir, ...bundle.bundleId.split("/"), "__data")
}));
const planIndex = createPatchPlan(sharedIndex, modsIndex);
const mod = modsIndex.mods.find((entry) => entry.modName === modName);
if (!mod) {
  throw new Error(`Mod not found: ${modName}`);
}

const plans = planIndex.plans
  .filter((plan) => plan.modName === modName && plan.status === "ready" && plan.bundlePath && plan.bundleId)
  .slice(0, bundleLimit);
if (plans.length === 0) {
  throw new Error(`No ready patch plan found for ${modName} in ${gameVersion}.`);
}

const labDir = await fs.mkdtemp(path.join(os.tmpdir(), "bd-spinex-upgrade-lab-"));
const oldAssetBackups = await findOldAssetBackups(modName);
const results = [];

for (const [index, plan] of plans.entries()) {
  const workDir = path.join(labDir, `bundle-${index + 1}`);
  const input = path.join(workDir, "__data.input");
  const output = path.join(workDir, "__data.output");
  const assetBackupDir = path.join(workDir, "current-assets");
  const manifestPath = path.join(workDir, "__data.patch-jobs.json");
  await fs.mkdir(workDir, { recursive: true });
  await fs.copyFile(plan.bundlePath, input);

  await writeJson(manifestPath, {
    jobs: [{
      modName,
      atlases: mod.files.atlas.map((file) => file.path),
      skels: mod.files.skel.map((file) => file.path),
      pngs: mod.files.png.map((file) => file.path),
      insertPngs: [],
      textureTargets: plan.targets.textures,
      assetBackupDir
    }]
  });

  const patchResult = await runUabea(input, output, manifestPath);
  const assetRows = await compareExtractedAssets(assetBackupDir, mod, oldAssetBackups);
  results.push({
    bundleId: plan.bundleId,
    bundlePath: plan.bundlePath,
    currentBundleSha256: await hashFile(plan.bundlePath),
    tempPatchedSha256: existsSync(output) ? await hashFile(output) : null,
    patchBackendOk: patchResult.ok,
    patchError: patchResult.error,
    extractedAssets: assetRows
  });
}

console.log(JSON.stringify({
  modName,
  gameVersion,
  labDir,
  resultSummary: summarize(results),
  results
}, null, 2));

function cliValue(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runUabea(input, output, manifestPath) {
  const command = path.join(root, "dist-native", "uabea-patcher", "UabeaPatchPrototype");
  if (!existsSync(command)) {
    throw new Error("Missing dist-native/uabea-patcher/UabeaPatchPrototype. Run npm run build:backends first.");
  }

  const args = [
    "--input", input,
    "--output", output,
    "--job-manifest", manifestPath,
    "--compression", "lz4"
  ];
  const astcEncoder = path.join(root, "dist-native", "unitypy-backend", "astc_encode");
  if (existsSync(astcEncoder)) {
    args.push("--astc-encoder", astcEncoder);
  }

  const stdout = await run(command, args);
  return JSON.parse(stdout);
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

async function compareExtractedAssets(assetBackupDir, mod, oldAssetBackups) {
  const files = await listFiles(assetBackupDir);
  const modSources = new Map([
    ...mod.files.atlas.map((file) => [file.file, file.path]),
    ...mod.files.skel.map((file) => [file.file, file.path]),
    ...mod.files.png.map((file) => [file.file, file.path])
  ]);

  const rows = [];
  for (const filePath of files) {
    const file = path.basename(filePath);
    const currentHash = await hashFile(filePath);
    const modSource = modSources.get(file);
    const oldMatches = [];
    for (const oldPath of oldAssetBackups.get(file) ?? []) {
      if (currentHash === await hashFile(oldPath)) {
        oldMatches.push(path.relative(root, oldPath));
      }
    }

    rows.push({
      file,
      currentExtractedSha256: currentHash,
      matchesModFile: modSource ? currentHash === await hashFile(modSource) : false,
      matchesOldCleanAssetBackup: oldMatches.length > 0,
      oldCleanMatches: oldMatches.slice(0, 5)
    });
  }

  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

async function findOldAssetBackups(targetModName) {
  const result = new Map();
  for (const baseDir of oldManagerDataDirs) {
    for (const filePath of await listFiles(baseDir)) {
      if (!filePath.includes(`${path.sep}asset-backups${path.sep}${targetModName}${path.sep}`)) {
        continue;
      }

      const file = path.basename(filePath);
      const paths = result.get(file) ?? [];
      paths.push(filePath);
      result.set(file, paths);
    }
  }
  return result;
}

async function listFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
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

function summarize(results) {
  const assets = results.flatMap((result) => result.extractedAssets);
  return {
    bundlesChecked: results.length,
    assetsChecked: assets.length,
    assetsMatchingModFile: assets.filter((asset) => asset.matchesModFile).length,
    assetsMatchingOldCleanBackup: assets.filter((asset) => asset.matchesOldCleanAssetBackup).length,
    unknownAssets: assets.filter((asset) => !asset.matchesModFile && !asset.matchesOldCleanAssetBackup).length
  };
}
