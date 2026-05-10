import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModded, getAssetBackupDir, getPatchTempPath, getPatchWorkPath, preparePatchWork, replacePatchWork, restoreOriginal } from "./backup-manager.js";
import { patchBundle } from "./asset-patcher.js";
import { convertJsonToSkel } from "./spine-converter.js";
import { ensureSpineConverter } from "./tool-manager.js";
import type { ApplyPatchOptions, ApplyPatchResult, ModEntry, ModsIndex, PatchHistory, PatchPlanEntry, PatchProgress, PatchRunEntry, PatchStateChange } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const managerDataDir = path.resolve("manager-data");
const patchHistoryPath = path.join(managerDataDir, "patch-history.json");
const convertedRoot = path.join(managerDataDir, "converted");

export async function applyReadyPatches(
  plans: PatchPlanEntry[],
  modsIndex: ModsIndex,
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const readyPlans = plans.filter((plan) => plan.status === "ready" && plan.bundleId && plan.bundlePath);
  const history = await readPatchHistory();
  const entries: PatchRunEntry[] = [];
  const modByName = new Map(modsIndex.mods.map((mod) => [mod.modName, mod]));
  const plansByBundle = groupBy(readyPlans, (plan) => plan.bundleId ?? "");
  let progressCurrent = 0;
  const progressTotal = Math.max(readyPlans.length, 1);
  emitPatchProgress(onProgress, "starting", progressCurrent, progressTotal, "Starting patch operation.");

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan);
    let workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];

    for (const [index, plan] of bundlePlans.entries()) {
      const mod = modByName.get(plan.modName);
      const entryBase = createPatchRunEntry(plan, "ready");

      if (!mod) {
        bundleOk = false;
        bundleEntries.push({ ...entryBase, status: "failed", message: "Mod entry not found." });
        break;
      }

      try {
        emitPatchProgress(onProgress, "converting", progressCurrent, progressTotal, `Preparing skeleton file(s) for ${plan.modName}.`, plan);
        const patchFiles = await preparePatchFiles(mod, options, onProgress, plan, progressCurrent, progressTotal);
        const outputPath = getPatchTempPath(firstPlan.bundleId, index + 1);
        emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Patching backup B for ${plan.modName}.`, plan);
        const result = await patchBundle({
          pythonPath: options.pythonPath || "python3",
          scriptPath: path.resolve(__dirname, "../../python/patch_bundle.py"),
          input: workPath,
          output: outputPath,
          modName: plan.name,
          atlases: patchFiles.atlases,
          skels: patchFiles.skels,
          pngs: patchFiles.pngs,
          unityVersion: options.unityVersion,
          decryptKey: options.decryptKey,
          assetBackupDir: getAssetBackupDir(firstPlan.bundleId, plan.modName)
        });
        const parsed = result as { ok?: boolean; changed?: unknown[]; error?: string };
        if (!parsed.ok) {
          bundleOk = false;
          bundleEntries.push({ ...entryBase, status: "failed", message: parsed.error ?? "Patch script failed.", changed: parsed.changed });
          break;
        }

        workPath = await replacePatchWork(firstPlan.bundleId, outputPath);
        progressCurrent += 1;
        emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Finished patching ${plan.modName}.`, plan);
        bundleEntries.push({ ...entryBase, status: "patched", message: "Patched backup B incrementally.", changed: parsed.changed });
      } catch (error) {
        bundleOk = false;
        bundleEntries.push({
          ...entryBase,
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        break;
      }
    }

    if (bundleOk) {
      emitPatchProgress(onProgress, "copying", progressCurrent, progressTotal, `Copying patched backup B to game __data for ${firstPlan.bundleId}.`, firstPlan);
      await applyModded(firstPlan.bundlePath, firstPlan.bundleId);
      entries.push(...bundleEntries.map((entry) => ({ ...entry, status: "patched" as const, message: "Patched backup B copied to game __data." })));
    } else {
      entries.push(...bundleEntries);
      for (const plan of bundlePlans.slice(bundleEntries.length)) {
        entries.push({ ...createPatchRunEntry(plan, "skipped"), message: "Skipped because another patch for this __data failed." });
      }
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", progressCurrent, progressTotal, "Patch operation finished.");
  return { ok: entries.every((entry) => entry.status === "patched"), entries, history: nextHistory };
}

export async function applyPatchStateChanges(
  plans: PatchPlanEntry[],
  modsIndex: ModsIndex,
  changes: PatchStateChange[],
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const patchedModNames = getPatchedModNames(history);
  const changedModNames = new Set(changes.map((change) => change.modName));
  const plansForChangedMods = plans.filter((plan) => changedModNames.has(plan.modName));
  const toApply = changes
    .filter((change) => change.enabled && !patchedModNames.has(change.modName))
    .map((change) => change.modName);
  const toRestore = changes
    .filter((change) => !change.enabled && patchedModNames.has(change.modName))
    .map((change) => change.modName);
  const entries: PatchRunEntry[] = [];
  emitPatchProgress(onProgress, "starting", 0, Math.max(changes.length, 1), `Applying ${changes.length} staged change(s).`);

  if (toApply.length > 0) {
    const result = await applyReadyPatches(
      plansForChangedMods.filter((plan) => toApply.includes(plan.modName)),
      modsIndex,
      options,
      onProgress
    );
    entries.push(...result.entries);
  }

  if (toRestore.length > 0) {
    const result = await restoreModPatches(
      plansForChangedMods.filter((plan) => toRestore.includes(plan.modName)),
      toRestore,
      options,
      onProgress
    );
    entries.push(...result.entries);
  }

  const nextHistory = await readPatchHistory();
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", Math.max(changes.length, 1), Math.max(changes.length, 1), "Staged changes finished.");
  return { ok: entries.every((entry) => entry.status === "patched" || entry.status === "restored"), entries, history: nextHistory };
}

export async function dryRunPatchStateChanges(
  plans: PatchPlanEntry[],
  modsIndex: ModsIndex,
  changes: PatchStateChange[],
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const enabledModNames = new Set(changes.filter((change) => change.enabled).map((change) => change.modName));
  const planByModName = new Map(plans.map((plan) => [plan.modName, plan]));
  const entries: PatchRunEntry[] = [];
  const modsToConvert = modsIndex.mods.filter((item) => enabledModNames.has(item.modName));
  emitPatchProgress(onProgress, "starting", 0, Math.max(modsToConvert.length, 1), "Starting dry run conversion.");

  for (const [index, mod] of modsToConvert.entries()) {
    const plan = planByModName.get(mod.modName);
    const entryBase = plan
      ? createPatchRunEntry(plan, "ready")
      : {
          id: `${mod.modName}:dry-run`,
          modName: mod.modName,
          name: mod.name,
          bundleId: "",
          bundlePath: "",
          status: "ready" as const,
          updatedAt: new Date().toISOString()
        };

    if (mod.status !== "ready") {
      entries.push({ ...entryBase, status: "failed", message: `Mod is not ready: ${mod.status}` });
      continue;
    }

    try {
      emitPatchProgress(onProgress, "converting", index, Math.max(modsToConvert.length, 1), `Converting ${mod.modName}.`, plan);
      const patchFiles = await preparePatchFiles(mod, options, onProgress, plan, index, Math.max(modsToConvert.length, 1));
      entries.push({
        ...entryBase,
        status: "ready",
        message: `Dry run prepared ${patchFiles.skels.length} skel file(s).`,
        changed: patchFiles.skels
      });
    } catch (error) {
      entries.push({
        ...entryBase,
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", Math.max(modsToConvert.length, 1), Math.max(modsToConvert.length, 1), "Dry run finished.");
  return { ok: entries.every((entry) => entry.status === "ready"), entries, history };
}

export async function restoreModPatches(
  plans: PatchPlanEntry[],
  modNames: string[],
  options: Pick<ApplyPatchOptions, "pythonPath" | "unityVersion" | "decryptKey">,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const targetMods = new Set(modNames);
  const restorablePlans = plans.filter((plan) => targetMods.has(plan.modName) && plan.bundleId && plan.bundlePath);
  const plansByBundle = groupBy(restorablePlans, (plan) => plan.bundleId ?? "");
  const entries: PatchRunEntry[] = [];
  let progressCurrent = 0;
  const progressTotal = Math.max(restorablePlans.length, 1);
  emitPatchProgress(onProgress, "starting", progressCurrent, progressTotal, "Starting selected restore operation.");

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan);
    let workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];

    for (const [index, plan] of bundlePlans.entries()) {
      const entryBase = createPatchRunEntry(plan, "ready");

      try {
        const restoreFiles = await getRestorePatchFiles(plan);
        const outputPath = getPatchTempPath(firstPlan.bundleId, index + 1);
        emitPatchProgress(onProgress, "restoring", progressCurrent, progressTotal, `Restoring ${plan.modName} from per-asset backup.`, plan);
        const result = await patchBundle({
          pythonPath: options.pythonPath || "python3",
          scriptPath: path.resolve(__dirname, "../../python/patch_bundle.py"),
          input: workPath || getPatchWorkPath(firstPlan.bundleId),
          output: outputPath,
          modName: plan.name,
          atlases: restoreFiles.atlases,
          skels: restoreFiles.skels,
          pngs: restoreFiles.pngs,
          unityVersion: options.unityVersion,
          decryptKey: options.decryptKey
        });
        const parsed = result as { ok?: boolean; changed?: unknown[]; error?: string };
        if (!parsed.ok) {
          bundleOk = false;
          bundleEntries.push({ ...entryBase, status: "failed", message: parsed.error ?? "Restore patch failed.", changed: parsed.changed });
          break;
        }

        workPath = await replacePatchWork(firstPlan.bundleId, outputPath);
        progressCurrent += 1;
        emitPatchProgress(onProgress, "restoring", progressCurrent, progressTotal, `Finished restoring ${plan.modName}.`, plan);
        bundleEntries.push({ ...entryBase, status: "restored", message: "Restored this mod's assets in backup B.", changed: parsed.changed });
      } catch (error) {
        bundleOk = false;
        bundleEntries.push({
          ...entryBase,
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        break;
      }
    }

    if (bundleOk) {
      emitPatchProgress(onProgress, "copying", progressCurrent, progressTotal, `Copying restored backup B to game __data for ${firstPlan.bundleId}.`, firstPlan);
      await applyModded(firstPlan.bundlePath, firstPlan.bundleId);
      entries.push(...bundleEntries.map((entry) => ({ ...entry, status: "restored" as const, message: "Updated backup B copied to game __data." })));
    } else {
      entries.push(...bundleEntries);
      for (const plan of bundlePlans.slice(bundleEntries.length)) {
        entries.push({ ...createPatchRunEntry(plan, "skipped"), message: "Skipped because another restore for this __data failed." });
      }
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", progressCurrent, progressTotal, "Selected restore finished.");
  return { ok: entries.every((entry) => entry.status === "restored"), entries, history: nextHistory };
}

export async function restoreAllPatches(plans: PatchPlanEntry[]): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const byBundle = new Map<string, PatchPlanEntry>();
  for (const plan of plans) {
    if (plan.bundleId && plan.bundlePath && !byBundle.has(plan.bundleId)) {
      byBundle.set(plan.bundleId, plan);
    }
  }

  const entries: PatchRunEntry[] = [];
  for (const plan of byBundle.values()) {
    try {
      await restoreOriginal(plan.bundlePath ?? "", plan.bundleId ?? "");
      entries.push({ ...createPatchRunEntry(plan, "restored"), message: "Original backup A copied to game __data." });
    } catch (error) {
      entries.push({
        ...createPatchRunEntry(plan, "failed"),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  return { ok: entries.every((entry) => entry.status === "restored"), entries, history: nextHistory };
}

export async function readPatchHistory(): Promise<PatchHistory> {
  try {
    return JSON.parse(await fs.readFile(patchHistoryPath, "utf8")) as PatchHistory;
  } catch {
    return { updatedAt: new Date().toISOString(), entries: [] };
  }
}

async function preparePatchFiles(
  mod: ModEntry,
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void,
  plan?: PatchPlanEntry,
  progressCurrent = 0,
  progressTotal = 1
) {
  const skelDir = path.join(convertedRoot, sanitizePathPart(mod.modName));
  const skels = mod.files.skel.map((file) => file.path);
  const skelBaseNames = new Set(mod.files.skel.map((file) => file.baseName.toLowerCase()));
  const jsonsToConvert = mod.files.json.filter((file) => !skelBaseNames.has(file.baseName.toLowerCase()));

  if (jsonsToConvert.length > 0) {
    emitPatchProgress(onProgress, "converting", progressCurrent, progressTotal, "Ensuring SpineSkeletonDataConverter is available.", plan);
  }

  const converterPath = jsonsToConvert.length > 0
    ? await ensureSpineConverter(options.converterPath)
    : undefined;

  for (const json of jsonsToConvert) {
    if (!converterPath) {
      throw new Error("SpineSkeletonDataConverter is not available.");
    }
    emitPatchProgress(onProgress, "converting", progressCurrent, progressTotal, `Converting ${json.file} to skel.`, plan);
    skels.push(await convertJsonToSkel(json.path, skelDir, converterPath));
  }

  return {
    atlases: mod.files.atlas.map((file) => file.path),
    skels,
    pngs: mod.files.png.map((file) => file.path)
  };
}

async function getRestorePatchFiles(plan: PatchPlanEntry) {
  if (!plan.bundleId) {
    throw new Error("Patch plan has no bundle id.");
  }

  const backupDir = getAssetBackupDir(plan.bundleId, plan.modName);
  const atlases = (plan.targets.atlases ?? []).map((target) => path.join(backupDir, target.assetName));
  const skels = (plan.targets.skels ?? []).map((target) => path.join(backupDir, target.assetName));
  const pngs = (plan.targets.textures ?? []).map((target) => path.join(backupDir, `${target.assetName}.png`));
  const files = [...atlases, ...skels, ...pngs];

  for (const file of files) {
    await fs.access(file);
  }

  return { atlases, skels, pngs };
}

function getPatchedModNames(history: PatchHistory) {
  const patched = new Set<string>();

  for (const entry of history.entries) {
    if (entry.status === "patched") {
      patched.add(entry.modName);
    }
  }

  return patched;
}

function mergePatchHistory(history: PatchHistory, entries: PatchRunEntry[]): PatchHistory {
  const current = new Map(history.entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    current.set(entry.id, entry);
  }

  return {
    updatedAt: new Date().toISOString(),
    entries: [...current.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  };
}

function emitPatchProgress(
  onProgress: ((progress: PatchProgress) => void) | undefined,
  phase: PatchProgress["phase"],
  current: number,
  total: number,
  message: string,
  plan?: PatchPlanEntry
) {
  onProgress?.({
    phase,
    current,
    total,
    modName: plan?.modName,
    bundleId: plan?.bundleId,
    message
  });
}

async function writePatchHistory(history: PatchHistory) {
  await fs.mkdir(path.dirname(patchHistoryPath), { recursive: true });
  await fs.writeFile(patchHistoryPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

function createPatchRunEntry(plan: PatchPlanEntry, status: PatchRunEntry["status"]): PatchRunEntry {
  return {
    id: `${plan.modName}:${plan.bundleId ?? "none"}`,
    modName: plan.modName,
    name: plan.name,
    bundleId: plan.bundleId ?? "",
    bundlePath: plan.bundlePath ?? "",
    status,
    updatedAt: new Date().toISOString()
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function sanitizePathPart(value: string) {
  return value.replace(/[/:\\]/g, "_");
}
