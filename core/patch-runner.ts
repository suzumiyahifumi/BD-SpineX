import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModded, getAssetBackupDir, getPatchTempPath, getPatchWorkPath, preparePatchWork, replacePatchWork, restoreOriginal } from "./backup-manager.js";
import { patchBundleBatch, type PatchBundleJob } from "./asset-patcher.js";
import { convertJsonToSkel } from "./spine-converter.js";
import { ensureSpineConverter } from "./tool-manager.js";
import type { ApplyPatchOptions, ApplyPatchResult, ModEntry, ModsIndex, PatchBackend, PatchHistory, PatchPlanEntry, PatchProgress, PatchRunEntry, PatchStateChange } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const managerDataDir = path.resolve("manager-data");
const patchHistoryPath = path.join(managerDataDir, "patch-history.json");
const convertedRoot = path.join(managerDataDir, "converted");

type PreparedPatchFiles = {
  atlases: string[];
  skels: string[];
  pngs: string[];
};

type PatchBackendResult = {
  ok?: boolean;
  changed?: unknown[];
  error?: string;
  timings?: unknown;
};

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
  const patchFilesByModName = new Map<string, PreparedPatchFiles>();
  const patchBackend = normalizePatchBackend(options.patchBackend);
  let progressCurrent = 0;
  const progressTotal = Math.max(readyPlans.length, 1);
  emitPatchProgress(onProgress, "starting", progressCurrent, progressTotal, `Starting patch operation using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
    const workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];
    const jobs: PatchBundleJob[] = [];

    for (const plan of bundlePlans) {
      const mod = modByName.get(plan.modName);
      const entryBase = createPatchRunEntry(plan, "ready");

      if (!mod) {
        bundleOk = false;
        bundleEntries.push({ ...entryBase, status: "failed", message: "Mod entry not found." });
        break;
      }

      try {
        emitPatchProgress(onProgress, "converting", progressCurrent, progressTotal, `Preparing skeleton file(s) for ${plan.modName}.`, plan, patchBackend);
        const patchFiles = await preparePatchFilesCached(mod, patchFilesByModName, options, onProgress, plan, progressCurrent, progressTotal);
        jobs.push({
          modName: plan.modName,
          atlases: patchFiles.atlases,
          skels: patchFiles.skels,
          pngs: patchFiles.pngs,
          assetBackupDir: getAssetBackupDir(firstPlan.bundleId, plan.modName)
        });
        bundleEntries.push(entryBase);
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
      const outputPath = getPatchTempPath(firstPlan.bundleId, 1);
      try {
        emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Patching backup B with ${formatPatchBackend(patchBackend)} for ${bundlePlans.length} mod(s) in ${firstPlan.bundleId}.`, firstPlan, patchBackend);
        const result = await patchBundleBatch({
          pythonPath: options.pythonPath || "python3",
          scriptPath: path.resolve(__dirname, "../../python/patch_bundle.py"),
          input: workPath,
          output: outputPath,
          jobs,
          manifestPath: await writePatchJobManifest(firstPlan.bundleId, jobs),
          patchBackend,
          dotnetPath: options.dotnetPath,
          uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
          unityVersion: options.unityVersion,
          decryptKey: options.decryptKey
        });
        const parsed = result as PatchBackendResult;
        emitPatchTimings(onProgress, patchBackend, parsed.timings, progressCurrent, progressTotal, "patching", firstPlan);
        if (!parsed.ok) {
          bundleOk = false;
          entries.push(...bundleEntries.map((entry) => ({
            ...entry,
            status: "failed" as const,
            message: parsed.error ?? "Patch script failed.",
            changed: changedForMod(parsed.changed, entry.modName)
          })));
        } else {
          await replacePatchWork(firstPlan.bundleId, outputPath);
          progressCurrent += bundlePlans.length;
          emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Finished patching ${bundlePlans.length} mod(s) in ${firstPlan.bundleId}.`, firstPlan, patchBackend);
          bundleEntries.splice(0, bundleEntries.length, ...bundleEntries.map((entry) => ({
            ...entry,
            status: "patched" as const,
            message: "Patched backup B in one bundle pass.",
            changed: changedForMod(parsed.changed, entry.modName)
          })));
        }
      } catch (error) {
        bundleOk = false;
        entries.push(...bundleEntries.map((entry) => ({
          ...entry,
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error)
        })));
      }
    }

    if (bundleOk) {
      emitPatchProgress(onProgress, "copying", progressCurrent, progressTotal, `Copying patched backup B to game __data for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
      await applyModded(firstPlan.bundlePath, firstPlan.bundleId);
      entries.push(...bundleEntries.map((entry) => ({ ...entry, status: "patched" as const, message: "Patched backup B copied to game __data." })));
    } else if (!entries.some((entry) => bundleEntries.some((bundleEntry) => bundleEntry.id === entry.id))) {
      entries.push(...bundleEntries.map((entry) =>
        entry.status === "ready"
          ? { ...entry, status: "skipped" as const, message: "Skipped because another patch for this __data failed." }
          : entry
      ));
      for (const plan of bundlePlans.slice(bundleEntries.length)) {
        entries.push({ ...createPatchRunEntry(plan, "skipped"), message: "Skipped because another patch for this __data failed." });
      }
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", progressCurrent, progressTotal, `Patch operation finished using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);
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
  const patchBackend = normalizePatchBackend(options.patchBackend);
  emitPatchProgress(onProgress, "starting", 0, Math.max(changes.length, 1), `Applying ${changes.length} staged change(s) using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);

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
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", Math.max(changes.length, 1), Math.max(changes.length, 1), `Staged changes finished using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);
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
  options: Pick<ApplyPatchOptions, "pythonPath" | "patchBackend" | "dotnetPath" | "uabeaPatcherProjectPath" | "unityVersion" | "decryptKey">,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const targetMods = new Set(modNames);
  const restorablePlans = plans.filter((plan) => targetMods.has(plan.modName) && plan.bundleId && plan.bundlePath);
  const plansByBundle = groupBy(restorablePlans, (plan) => plan.bundleId ?? "");
  const entries: PatchRunEntry[] = [];
  const patchBackend = normalizePatchBackend(options.patchBackend);
  let progressCurrent = 0;
  const progressTotal = Math.max(restorablePlans.length, 1);
  emitPatchProgress(onProgress, "starting", progressCurrent, progressTotal, `Starting selected restore operation using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
    const workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];
    const jobs: PatchBundleJob[] = [];

    for (const plan of bundlePlans) {
      const entryBase = createPatchRunEntry(plan, "ready");

      try {
        const restoreFiles = await getRestorePatchFiles(plan);
        jobs.push({
          modName: plan.modName,
          atlases: restoreFiles.atlases,
          skels: restoreFiles.skels,
          pngs: restoreFiles.pngs
        });
        bundleEntries.push(entryBase);
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
      const outputPath = getPatchTempPath(firstPlan.bundleId, 1);
      try {
        emitPatchProgress(onProgress, "restoring", progressCurrent, progressTotal, `Restoring with ${formatPatchBackend(patchBackend)} for ${bundlePlans.length} mod(s) in ${firstPlan.bundleId}.`, firstPlan, patchBackend);
        const result = await patchBundleBatch({
          pythonPath: options.pythonPath || "python3",
          scriptPath: path.resolve(__dirname, "../../python/patch_bundle.py"),
          input: workPath || getPatchWorkPath(firstPlan.bundleId),
          output: outputPath,
          jobs,
          manifestPath: await writePatchJobManifest(firstPlan.bundleId, jobs),
          patchBackend,
          dotnetPath: options.dotnetPath,
          uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
          unityVersion: options.unityVersion,
          decryptKey: options.decryptKey
        });
        const parsed = result as PatchBackendResult;
        emitPatchTimings(onProgress, patchBackend, parsed.timings, progressCurrent, progressTotal, "restoring", firstPlan);
        if (!parsed.ok) {
          bundleOk = false;
          entries.push(...bundleEntries.map((entry) => ({
            ...entry,
            status: "failed" as const,
            message: parsed.error ?? "Restore patch failed.",
            changed: changedForMod(parsed.changed, entry.modName)
          })));
        } else {
          await replacePatchWork(firstPlan.bundleId, outputPath);
          progressCurrent += bundlePlans.length;
          emitPatchProgress(onProgress, "restoring", progressCurrent, progressTotal, `Finished restoring ${bundlePlans.length} mod(s) in ${firstPlan.bundleId}.`, firstPlan, patchBackend);
          bundleEntries.splice(0, bundleEntries.length, ...bundleEntries.map((entry) => ({
            ...entry,
            status: "restored" as const,
            message: "Restored this mod's assets in one bundle pass.",
            changed: changedForMod(parsed.changed, entry.modName)
          })));
        }
      } catch (error) {
        bundleOk = false;
        entries.push(...bundleEntries.map((entry) => ({
          ...entry,
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error)
        })));
      }
    }

    if (bundleOk) {
      emitPatchProgress(onProgress, "copying", progressCurrent, progressTotal, `Copying restored backup B to game __data for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
      await applyModded(firstPlan.bundlePath, firstPlan.bundleId);
      entries.push(...bundleEntries.map((entry) => ({ ...entry, status: "restored" as const, message: "Updated backup B copied to game __data." })));
    } else if (!entries.some((entry) => bundleEntries.some((bundleEntry) => bundleEntry.id === entry.id))) {
      entries.push(...bundleEntries.map((entry) =>
        entry.status === "ready"
          ? { ...entry, status: "skipped" as const, message: "Skipped because another restore for this __data failed." }
          : entry
      ));
      for (const plan of bundlePlans.slice(bundleEntries.length)) {
        entries.push({ ...createPatchRunEntry(plan, "skipped"), message: "Skipped because another restore for this __data failed." });
      }
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "failed") ? "failed" : "done", progressCurrent, progressTotal, `Selected restore finished using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);
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

async function preparePatchFilesCached(
  mod: ModEntry,
  cache: Map<string, PreparedPatchFiles>,
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void,
  plan?: PatchPlanEntry,
  progressCurrent = 0,
  progressTotal = 1
) {
  const cached = cache.get(mod.modName);
  if (cached) {
    return cached;
  }

  const prepared = await preparePatchFiles(mod, options, onProgress, plan, progressCurrent, progressTotal);
  cache.set(mod.modName, prepared);
  return prepared;
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

async function writePatchJobManifest(bundleId: string, jobs: PatchBundleJob[]) {
  const manifestPath = path.join(path.dirname(getPatchWorkPath(bundleId)), "__data.patch-jobs.json");
  await fs.writeFile(manifestPath, `${JSON.stringify({ jobs }, null, 2)}\n`, "utf8");
  return manifestPath;
}

function changedForMod(changed: unknown[] | undefined, modName: string) {
  if (!Array.isArray(changed)) {
    return changed;
  }

  return changed.filter((item) =>
    typeof item === "object" &&
    item !== null &&
    "modName" in item &&
    (item as { modName?: unknown }).modName === modName
  );
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
  plan?: PatchPlanEntry,
  backend?: PatchBackend,
  timing?: PatchProgress["timing"]
) {
  onProgress?.({
    phase,
    current,
    total,
    modName: plan?.modName,
    bundleId: plan?.bundleId,
    backend,
    timing,
    message
  });
}

function emitPatchTimings(
  onProgress: ((progress: PatchProgress) => void) | undefined,
  backend: PatchBackend,
  timings: unknown,
  current: number,
  total: number,
  phase: PatchProgress["phase"],
  plan?: PatchPlanEntry
) {
  if (!Array.isArray(timings)) {
    return;
  }

  for (const timing of timings) {
    if (!isPatchTimingEntry(timing)) {
      continue;
    }
    emitPatchProgress(
      onProgress,
      phase,
      current,
      total,
      `${formatPatchBackend(backend)} ${timing.name}: ${formatMs(timing.ms)}.`,
      plan,
      backend,
      timing
    );
  }
}

function isPatchTimingEntry(value: unknown): value is NonNullable<PatchProgress["timing"]> {
  return typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "ms" in value &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { ms?: unknown }).ms === "number";
}

function normalizePatchBackend(backend: ApplyPatchOptions["patchBackend"]): PatchBackend {
  return backend === "uabea" ? "uabea" : "unitypy";
}

function formatPatchBackend(backend: PatchBackend) {
  return backend === "uabea" ? "UABEA / AssetsTools.NET" : "UnityPy";
}

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
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
