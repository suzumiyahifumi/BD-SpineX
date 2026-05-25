import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { applyModded, backupOriginal, getAssetBackupDir, getOriginalBackupPath, getPatchTempPath, getPatchWorkPath, preparePatchWork, replaceOriginalBackup, replacePatchWork, restoreOriginal } from "./backup-manager.js";
import { patchBundleBatch, type PatchBundleJob } from "./asset-patcher.js";
import { managerDataDir, managerDataRootDir, managerDataVersion } from "./runtime-paths.js";
import { convertJsonToSkel } from "./spine-converter.js";
import { ensureSpineConverter } from "./tool-manager.js";
import type { ApplyPatchOptions, ApplyPatchResult, ModEntry, ModsIndex, PatchBackend, PatchDataCheckEntry, PatchDataCheckResult, PatchHistory, PatchPlanEntry, PatchProgress, PatchRunEntry, PatchStateChange, PreviousPatchedMods } from "./types.js";

type PreparedPatchFiles = {
  atlases: string[];
  skels: string[];
  pngs: string[];
  insertPngs?: string[];
  removePngs?: string[];
};

type PatchBackendResult = {
  ok?: boolean;
  changed?: unknown[];
  error?: string;
  backend?: PatchBackend;
  timings?: unknown;
};

type CleanPatchFiles = {
  atlases: string[];
  skels: string[];
  pngs: string[];
};

type PreparedPatchJob = {
  plan: PatchPlanEntry;
  job: PatchBundleJob;
  entry: PatchRunEntry;
  backend: PatchBackend;
  repair: boolean;
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
  const repairModNames = new Set(options.repairModNames ?? []);
  let progressCurrent = 0;
  const progressTotal = Math.max(readyPlans.length, 1);
  emitPatchProgress(onProgress, "starting", progressCurrent, progressTotal, `Starting patch operation using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    const dataCheck = await checkPatchDataForBundle(bundlePlans);
    const invalidDataChecks = dataCheck.filter((entry) =>
      entry.status === "missing" ||
      (entry.status === "changed" && !repairModNames.has(entry.modName))
    );
    if (invalidDataChecks.length > 0) {
      entries.push(...invalidDataChecks.map((entry) => createChangedPatchRunEntry(entry)));
      progressCurrent += invalidDataChecks.length;
      emitPatchProgress(onProgress, "failed", progressCurrent, progressTotal, `Changed: skipped ${invalidDataChecks.length} mod(s) in ${firstPlan.bundleId}. Re-scan Shared and generate a new patch plan.`, firstPlan, patchBackend);
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
    const workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];
    const preparedJobs: PreparedPatchJob[] = [];

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
        const planPatchFiles = filterPatchFilesForPlan(patchFiles, plan);
        const job = {
          modName: plan.modName,
          atlases: planPatchFiles.atlases,
          skels: planPatchFiles.skels,
          pngs: planPatchFiles.pngs,
          insertPngs: planPatchFiles.insertPngs,
          textureTargets: plan.targets.textures,
          assetBackupDir: getAssetBackupDir(firstPlan.bundleId, plan.modName)
        };
        preparedJobs.push({
          plan,
          job,
          entry: entryBase,
          backend: resolvePatchBackendForPlan(patchBackend, plan, job, repairModNames),
          repair: repairModNames.has(plan.modName)
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
      const patchGroups = groupPreparedPatchJobs(preparedJobs, patchBackend);
      let inputPath = workPath;
      for (const [groupIndex, group] of patchGroups.entries()) {
        const outputPath = getPatchTempPath(firstPlan.bundleId, groupIndex + 1);
        const groupEntries = group.items.map((item) => item.entry);
        try {
          emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Patching backup B with ${formatPatchBackend(group.backend)} for ${group.items.length} mod(s) in ${firstPlan.bundleId}.`, firstPlan, group.backend);
          const groupJobs = group.items.map((item) => item.job);
          const result = await patchBundleBatch({
            input: inputPath,
            output: outputPath,
            jobs: groupJobs,
            manifestPath: await writePatchJobManifest(firstPlan.bundleId, groupJobs),
            patchBackend: group.backend,
            pythonPath: options.pythonPath,
            dotnetPath: options.dotnetPath,
            uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
            unityVersion: options.unityVersion,
            decryptKey: options.decryptKey
          });
          const parsed = result as PatchBackendResult;
          const resolvedBackend = parsed.backend ?? group.backend;
          emitPatchTimings(onProgress, resolvedBackend, parsed.timings, progressCurrent, progressTotal, "patching", firstPlan);
          if (!parsed.ok) {
            bundleOk = false;
            entries.push(...groupEntries.map((entry) => ({
              ...entry,
              status: "failed" as const,
              message: parsed.error ?? "Patch script failed.",
              changed: changedForMod(parsed.changed, entry.modName)
            })));
            pushSkippedPatchEntries(entries, bundleEntries);
            break;
          }

          await replacePatchWork(firstPlan.bundleId, outputPath);
          inputPath = getPatchWorkPath(firstPlan.bundleId);
          progressCurrent += group.items.length;
          emitPatchProgress(onProgress, "patching", progressCurrent, progressTotal, `Finished patching ${group.items.length} mod(s) in ${firstPlan.bundleId} using ${formatPatchBackend(resolvedBackend)}.`, firstPlan, resolvedBackend);
          replaceBundleEntries(bundleEntries, groupEntries.map((entry) => ({
            ...entry,
            status: "patched" as const,
            message: patchBackend === "auto-backend"
              ? `Patched backup B using auto-selected ${formatPatchBackend(resolvedBackend)} backend.`
              : group.items.some((item) => item.repair)
                ? `Repair mode re-patched backup B using ${formatPatchBackend(resolvedBackend)} backend.`
              : "Patched backup B in one bundle pass.",
            changed: changedForMod(parsed.changed, entry.modName)
          })));
        } catch (error) {
          bundleOk = false;
          entries.push(...groupEntries.map((entry) => ({
            ...entry,
            status: "failed" as const,
            message: error instanceof Error ? error.message : String(error)
          })));
          pushSkippedPatchEntries(entries, bundleEntries);
          break;
        }
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

function groupPreparedPatchJobs(preparedJobs: PreparedPatchJob[], selectedBackend: PatchBackend) {
  if (selectedBackend !== "auto-backend" && preparedJobs.every((item) => item.backend === selectedBackend)) {
    return [{ backend: selectedBackend, items: preparedJobs }];
  }

  const groups = new Map<PatchBackend, PreparedPatchJob[]>();
  for (const item of preparedJobs) {
    groups.set(item.backend, [...(groups.get(item.backend) ?? []), item]);
  }

  const preferredOrder: PatchBackend[] = ["uabea", "uabea-safe", "auto", "unitypy"];
  return [...groups.entries()]
    .sort(([a], [b]) => preferredOrder.indexOf(a) - preferredOrder.indexOf(b))
    .map(([backend, items]) => ({ backend, items }));
}

function resolvePatchBackendForPlan(selectedBackend: PatchBackend, plan: PatchPlanEntry, job: PatchBundleJob, repairModNames: Set<string>): PatchBackend {
  if (repairModNames.has(plan.modName)) {
    return (job.insertPngs?.length ?? 0) > 0 ? "uabea" : "unitypy";
  }

  if ((job.insertPngs?.length ?? 0) > 0) {
    return selectedBackend === "unitypy" ? "uabea" : selectedBackend;
  }

  if (selectedBackend !== "auto-backend") {
    return selectedBackend;
  }

  const textures = plan.targets.textures ?? [];
  if (textures.some((target) => target.textureFormatName?.toLowerCase().includes("astc"))) {
    return "uabea-safe";
  }

  if (textures.length > 0) {
    return "uabea-safe";
  }

  return "uabea";
}

function replaceBundleEntries(bundleEntries: PatchRunEntry[], nextEntries: PatchRunEntry[]) {
  for (const nextEntry of nextEntries) {
    const index = bundleEntries.findIndex((entry) => entry.id === nextEntry.id);
    if (index >= 0) {
      bundleEntries[index] = nextEntry;
    }
  }
}

function pushSkippedPatchEntries(entries: PatchRunEntry[], bundleEntries: PatchRunEntry[]) {
  const recordedIds = new Set(entries.map((entry) => entry.id));
  entries.push(...bundleEntries
    .filter((entry) => !recordedIds.has(entry.id))
    .map((entry) => ({ ...entry, status: "skipped" as const, message: "Skipped because another patch for this __data failed." })));
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
  const repairModNames = changes
    .filter((change) => change.repair && change.enabled)
    .map((change) => change.modName);
  const repairModNameSet = new Set(repairModNames);
  const toApply = changes
    .filter((change) => change.enabled && (!patchedModNames.has(change.modName) || change.repair))
    .map((change) => change.modName);
  const toRestore = changes
    .filter((change) => !change.repair && !change.enabled && patchedModNames.has(change.modName))
    .map((change) => change.modName);
  const entries: PatchRunEntry[] = [];
  const patchBackend = normalizePatchBackend(options.patchBackend);
  emitPatchProgress(onProgress, "starting", 0, Math.max(changes.length, 1), `Applying ${changes.length} staged change(s) using ${formatPatchBackend(patchBackend)} backend.`, undefined, patchBackend);

  if (toApply.length > 0) {
    const result = await applyReadyPatches(
      plansForChangedMods.filter((plan) => toApply.includes(plan.modName)),
      modsIndex,
      repairModNames.length > 0 ? { ...options, repairModNames } : options,
      onProgress
    );
    entries.push(...result.entries);
  }

  const patchedApplyModNames = new Set(entries.filter((entry) => entry.status === "patched" && !repairModNameSet.has(entry.modName)).map((entry) => entry.modName));
  const replacementRestoreModNames = getReplacementRestoreModNames(plansForChangedMods, toRestore, patchedApplyModNames);
  const directRestoreModNames = toRestore.filter((modName) => !replacementRestoreModNames.has(modName));

  if (directRestoreModNames.length > 0) {
  const result = await restoreModPatches(
      plansForChangedMods.filter((plan) => directRestoreModNames.includes(plan.modName)),
      modsIndex,
      directRestoreModNames,
      options,
      onProgress
    );
    entries.push(...result.entries);
  }

  if (replacementRestoreModNames.size > 0) {
    const replacementEntries = plansForChangedMods
      .filter((plan) => replacementRestoreModNames.has(plan.modName))
      .map((plan) => ({
        ...createPatchRunEntry(plan, "restored" as const),
        message: "Marked restored because another staged mod overwrote the same __data asset name."
      }));
    entries.push(...replacementEntries);
    const latestHistory = await readPatchHistory();
    await writePatchHistory(mergePatchHistory(latestHistory, replacementEntries));
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
  modsIndex: ModsIndex,
  modNames: string[],
  options: Pick<ApplyPatchOptions, "patchBackend" | "pythonPath" | "dotnetPath" | "uabeaPatcherProjectPath" | "unityVersion" | "decryptKey">,
  onProgress?: (progress: PatchProgress) => void
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const targetMods = new Set(modNames);
  const modByName = new Map(modsIndex.mods.map((mod) => [mod.modName, mod]));
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

    const dataCheck = await checkPatchDataForBundle(bundlePlans);
    const invalidDataChecks = dataCheck.filter((entry) => entry.status === "missing" || entry.status === "changed");
    if (invalidDataChecks.length > 0) {
      entries.push(...invalidDataChecks.map((entry) => createChangedPatchRunEntry(entry)));
      progressCurrent += invalidDataChecks.length;
      emitPatchProgress(onProgress, "failed", progressCurrent, progressTotal, `Changed: skipped ${invalidDataChecks.length} restore change(s) in ${firstPlan.bundleId}. Re-scan Shared and generate a new patch plan.`, firstPlan, patchBackend);
      continue;
    }

    emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Preparing backup B for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
    const workPath = await preparePatchWork(firstPlan.bundlePath, firstPlan.bundleId);
    let bundleOk = true;
    const bundleEntries: PatchRunEntry[] = [];
    const jobs: PatchBundleJob[] = [];

    for (const plan of bundlePlans) {
      const entryBase = createPatchRunEntry(plan, "ready");
      const mod = modByName.get(plan.modName);

      try {
        const restoreFiles = await getRestorePatchFiles(plan, mod);
        jobs.push({
          modName: plan.modName,
          atlases: restoreFiles.atlases,
          skels: restoreFiles.skels,
          pngs: restoreFiles.pngs,
          removePngs: restoreFiles.removePngs,
          textureTargets: plan.targets.textures
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
        const restoreBackend = jobs.some((job) => (job.removePngs?.length ?? 0) > 0) && patchBackend === "unitypy"
          ? "uabea"
          : patchBackend;
        const result = await patchBundleBatch({
                              input: workPath || getPatchWorkPath(firstPlan.bundleId),
          output: outputPath,
          jobs,
          manifestPath: await writePatchJobManifest(firstPlan.bundleId, jobs),
          patchBackend: restoreBackend,
          pythonPath: options.pythonPath,
          dotnetPath: options.dotnetPath,
          uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
          unityVersion: options.unityVersion,
          decryptKey: options.decryptKey
        });
        const parsed = result as PatchBackendResult;
        const resolvedBackend = parsed.backend ?? restoreBackend;
        emitPatchTimings(onProgress, resolvedBackend, parsed.timings, progressCurrent, progressTotal, "restoring", firstPlan);
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
          emitPatchProgress(onProgress, "restoring", progressCurrent, progressTotal, `Finished restoring ${bundlePlans.length} mod(s) in ${firstPlan.bundleId} using ${formatPatchBackend(resolvedBackend)}.`, firstPlan, resolvedBackend);
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
  const byBundle = new Map<string, PatchPlanEntry[]>();
  for (const plan of plans) {
    if (plan.bundleId && plan.bundlePath) {
      byBundle.set(plan.bundleId, [...(byBundle.get(plan.bundleId) ?? []), plan]);
    }
  }

  const entries: PatchRunEntry[] = [];
  for (const bundlePlans of byBundle.values()) {
    const firstPlan = bundlePlans[0];
    const dataCheck = await checkPatchDataForBundle(bundlePlans);
    const invalidDataCheck = dataCheck.find((entry) => entry.status === "missing" || entry.status === "changed");
    if (invalidDataCheck) {
      entries.push(createChangedPatchRunEntry(invalidDataCheck));
      continue;
    }

    try {
      await restoreOriginal(firstPlan.bundlePath ?? "", firstPlan.bundleId ?? "");
      entries.push(...createRestoreAllEntriesForBundle(bundlePlans, history));
    } catch (error) {
      entries.push(...bundlePlans.map((plan) => ({
        ...createPatchRunEntry(plan, "failed"),
        message: error instanceof Error ? error.message : String(error)
      })));
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  return { ok: entries.every((entry) => entry.status === "restored"), entries, history: nextHistory };
}

export async function checkPatchDataForMods(plans: PatchPlanEntry[], modNames: string[]): Promise<PatchDataCheckResult> {
  const targetMods = new Set(modNames);
  const targetPlans = plans.filter((plan) => targetMods.has(plan.modName) && plan.bundleId && plan.bundlePath);
  const entries: PatchDataCheckEntry[] = [];
  for (const bundlePlans of groupBy(targetPlans, (plan) => plan.bundleId ?? "").values()) {
    entries.push(...await checkPatchDataForBundle(bundlePlans));
  }
  return {
    ok: entries.every((entry) => entry.status === "ok" || entry.status === "no_backup"),
    entries
  };
}

export async function ensureOriginalBackupsForMods(
  plans: PatchPlanEntry[],
  modsIndex: ModsIndex,
  modNames: string[],
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void
): Promise<PatchDataCheckResult> {
  const targetMods = new Set(modNames);
  const targetPlans = plans.filter((plan) => targetMods.has(plan.modName) && plan.bundleId && plan.bundlePath);
  const entries: PatchDataCheckEntry[] = [];
  const patchBackend = normalizePatchBackend(options.patchBackend);
  let progressCurrent = 0;
  const progressTotal = Math.max(groupBy(targetPlans, (plan) => plan.bundleId ?? "").size, 1);
  emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, "Checking clean backup A for version update.", undefined, patchBackend);

  for (const bundlePlans of groupBy(targetPlans, (plan) => plan.bundleId ?? "").values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    const before = await checkPatchDataForBundle(bundlePlans);
    const noBackupYet = before.every((entry) => entry.status === "no_backup");
    if (!noBackupYet) {
      entries.push(...before);
      progressCurrent += 1;
      continue;
    }

    try {
      emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Verifying clean target assets for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
      const result = await createCleanOriginalBackupFromPreviousAssets(bundlePlans, modsIndex, options, patchBackend, onProgress, progressCurrent, progressTotal);
      entries.push(...bundlePlans.map((plan) => ({
        modName: plan.modName,
        name: plan.name,
        bundleId: plan.bundleId ?? "",
        bundlePath: plan.bundlePath ?? "",
        status: "ok" as const,
        message: result.repaired
          ? `Created backup A from a repaired clean temporary __data (${result.repairedAssets} restored asset(s)).`
          : "Created backup A after target assets matched previous clean backups."
      })));
    } catch (error) {
      entries.push(...bundlePlans.map((plan) => ({
        modName: plan.modName,
        name: plan.name,
        bundleId: plan.bundleId ?? "",
        bundlePath: plan.bundlePath ?? "",
        status: "changed" as const,
        message: error instanceof Error ? error.message : String(error)
      })));
    }

    progressCurrent += 1;
  }

  emitPatchProgress(onProgress, entries.some((entry) => entry.status === "changed" || entry.status === "missing") ? "failed" : "done", progressCurrent, progressTotal, "Clean backup A check finished.", undefined, patchBackend);
  return {
    ok: entries.every((entry) => entry.status === "ok"),
    entries
  };
}

export async function copyPatchBackupsForMods(
  plans: PatchPlanEntry[],
  modNames: string[],
  source: "original" | "patched"
): Promise<ApplyPatchResult> {
  const history = await readPatchHistory();
  const targetMods = new Set(modNames);
  const targetPlans = plans.filter((plan) => targetMods.has(plan.modName) && plan.bundleId && plan.bundlePath);
  const plansByBundle = groupBy(targetPlans, (plan) => plan.bundleId ?? "");
  const entries: PatchRunEntry[] = [];

  for (const bundlePlans of plansByBundle.values()) {
    const firstPlan = bundlePlans[0];
    if (!firstPlan.bundleId || !firstPlan.bundlePath) {
      continue;
    }

    const dataCheck = await checkPatchDataForBundle(bundlePlans);
    const invalidDataChecks = dataCheck.filter((entry) => entry.status === "missing" || entry.status === "changed");
    if (invalidDataChecks.length > 0) {
      entries.push(...invalidDataChecks.map((entry) => createChangedPatchRunEntry(entry)));
      continue;
    }

    try {
      if (source === "original") {
        await restoreOriginal(firstPlan.bundlePath, firstPlan.bundleId);
        entries.push(...bundlePlans.map((plan) => ({
          ...createPatchRunEntry(plan, "restored"),
          message: "Original backup A copied to game __data by Mod Power."
        })));
      } else {
        await applyModded(firstPlan.bundlePath, firstPlan.bundleId);
        entries.push(...bundlePlans.map((plan) => ({
          ...createPatchRunEntry(plan, "patched"),
          message: "Modded backup B copied to game __data by Mod Power."
        })));
      }
    } catch (error) {
      entries.push(...bundlePlans.map((plan) => ({
        ...createPatchRunEntry(plan, "failed"),
        message: error instanceof Error ? error.message : String(error)
      })));
    }
  }

  const nextHistory = mergePatchHistory(history, entries);
  await writePatchHistory(nextHistory);
  return {
    ok: entries.length > 0 && entries.every((entry) => entry.status === (source === "original" ? "restored" : "patched")),
    entries,
    history: nextHistory
  };
}

async function createCleanOriginalBackupFromPreviousAssets(
  bundlePlans: PatchPlanEntry[],
  modsIndex: ModsIndex,
  options: ApplyPatchOptions,
  patchBackend: PatchBackend,
  onProgress: ((progress: PatchProgress) => void) | undefined,
  progressCurrent: number,
  progressTotal: number
) {
  const firstPlan = bundlePlans[0];
  if (!firstPlan.bundleId || !firstPlan.bundlePath) {
    throw new Error("Patch plan has no __data path. Re-scan Shared before running the version update check.");
  }

  if (firstPlan.bundleSha256) {
    const currentHash = await hashFile(firstPlan.bundlePath);
    if (currentHash === firstPlan.bundleSha256) {
      await backupOriginal(firstPlan.bundlePath, firstPlan.bundleId);
      return { repaired: false, repairedAssets: 0 };
    }
  }

  const modByName = new Map(modsIndex.mods.map((mod) => [mod.modName, mod]));
  const cleanJobs: PatchBundleJob[] = [];
  const cleanSourcesByAsset = new Map<string, string>();
  const modSourcesByAsset = new Map<string, string>();

  for (const plan of bundlePlans) {
    const mod = modByName.get(plan.modName);
    if (!mod) {
      throw new Error(`Mod entry not found for ${plan.modName}.`);
    }

    const cleanFiles = await getPreviousCleanPatchFiles(plan);
    if (cleanFiles.atlases.length === 0 && cleanFiles.skels.length === 0 && cleanFiles.pngs.length === 0) {
      throw new Error(`No previous clean asset backup found for ${plan.modName}. A clean backup A cannot be guaranteed.`);
    }

    const modFiles = await preparePatchFilesCached(mod, new Map(), options, onProgress, plan, progressCurrent, progressTotal);
    const planModFiles = filterPatchFilesForPlan(modFiles, plan);
    registerPatchFileSources(cleanSourcesByAsset, cleanFiles);
    registerPatchFileSources(modSourcesByAsset, planModFiles);
    cleanJobs.push({
      modName: plan.modName,
      atlases: cleanFiles.atlases,
      skels: cleanFiles.skels,
      pngs: cleanFiles.pngs,
      insertPngs: [],
      textureTargets: plan.targets.textures,
      assetBackupDir: ""
    });
  }

  const labDir = await fs.mkdtemp(path.join(os.tmpdir(), "bd-spinex-upgrade-"));
  const inspectInput = path.join(labDir, "__data.inspect.input");
  const inspectOutput = path.join(labDir, "__data.inspect.output");
  const inspectAssetDir = path.join(labDir, "current-assets");
  const inspectManifest = path.join(labDir, "__data.inspect-jobs.json");
  await fs.copyFile(firstPlan.bundlePath, inspectInput);
  await fs.writeFile(inspectManifest, `${JSON.stringify({ jobs: cleanJobs.map((job) => ({ ...job, assetBackupDir: inspectAssetDir })) }, null, 2)}\n`, "utf8");

  emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Extracting current target assets for ${firstPlan.bundleId}.`, firstPlan, patchBackend);
  const inspectResult = await patchBundleBatch({
    input: inspectInput,
    output: inspectOutput,
    jobs: cleanJobs.map((job) => ({ ...job, assetBackupDir: inspectAssetDir })),
    manifestPath: inspectManifest,
    patchBackend,
    pythonPath: options.pythonPath,
    dotnetPath: options.dotnetPath,
    uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
    unityVersion: options.unityVersion,
    decryptKey: options.decryptKey
  }) as PatchBackendResult;

  if (!inspectResult.ok) {
    throw new Error(inspectResult.error ?? "Failed to inspect current __data target assets.");
  }

  const dirtyAssets = await findDirtyAssets(inspectAssetDir, cleanSourcesByAsset, modSourcesByAsset);
  const unknownAssets = dirtyAssets.filter((asset) => asset.reason === "unknown");
  if (unknownAssets.length > 0) {
    throw new Error(`Current __data has ${unknownAssets.length} target asset(s) that differ from both the mod file and previous clean backup. A clean backup A cannot be guaranteed.`);
  }

  const patchedAssets = dirtyAssets.filter((asset) => asset.reason === "matches_mod");
  if (patchedAssets.length === 0) {
    await backupOriginal(firstPlan.bundlePath, firstPlan.bundleId);
    return { repaired: false, repairedAssets: 0 };
  }

  const repairJobs = createRepairJobs(cleanJobs, new Set(patchedAssets.map((asset) => asset.file)));
  const repairInput = path.join(labDir, "__data.repair.input");
  const repairOutput = path.join(labDir, "__data.repair.output");
  const repairManifest = path.join(labDir, "__data.repair-jobs.json");
  await fs.copyFile(firstPlan.bundlePath, repairInput);
  await fs.writeFile(repairManifest, `${JSON.stringify({ jobs: repairJobs }, null, 2)}\n`, "utf8");

  emitPatchProgress(onProgress, "preparing_backup", progressCurrent, progressTotal, `Repairing ${patchedAssets.length} patched target asset(s) before creating backup A.`, firstPlan, patchBackend);
  const repairResult = await patchBundleBatch({
    input: repairInput,
    output: repairOutput,
    jobs: repairJobs,
    manifestPath: repairManifest,
    patchBackend,
    pythonPath: options.pythonPath,
    dotnetPath: options.dotnetPath,
    uabeaPatcherProjectPath: options.uabeaPatcherProjectPath,
    unityVersion: options.unityVersion,
    decryptKey: options.decryptKey
  }) as PatchBackendResult;

  if (!repairResult.ok) {
    throw new Error(repairResult.error ?? "Failed to repair patched target assets before creating backup A.");
  }

  await replaceOriginalBackup(firstPlan.bundleId, repairOutput);
  return { repaired: true, repairedAssets: patchedAssets.length };
}

export async function readPatchHistory(): Promise<PatchHistory> {
  try {
    return JSON.parse(await fs.readFile(patchHistoryPath(), "utf8")) as PatchHistory;
  } catch {
    return { updatedAt: new Date().toISOString(), entries: [] };
  }
}

export async function readPreviousPatchedMods(): Promise<PreviousPatchedMods> {
  const currentHistoryPath = path.resolve(patchHistoryPath());
  const histories = await findPreviousPatchHistoryPaths(currentHistoryPath);
  const modNames = new Set<string>();
  const sourceVersions = new Set<string>();

  for (const historyPath of histories) {
    const history = await readHistoryFile(historyPath);
    if (!history) {
      continue;
    }

    const sourceVersion = versionFromHistoryPath(historyPath);
    if (sourceVersion) {
      sourceVersions.add(sourceVersion);
    }

    for (const modName of getActivePatchedModNames(history)) {
      modNames.add(modName);
    }
  }

  return {
    modNames: [...modNames].sort((a, b) => a.localeCompare(b)),
    sourceVersions: [...sourceVersions].sort((a, b) => a.localeCompare(b))
  };
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

async function getPreviousCleanPatchFiles(plan: PatchPlanEntry): Promise<CleanPatchFiles> {
  return {
    atlases: (await Promise.all((plan.targets.atlases ?? []).map((target) =>
      findPreviousAssetBackup(plan.modName, target.assetName)
    ))).filter((file): file is string => Boolean(file)),
    skels: (await Promise.all((plan.targets.skels ?? []).map((target) =>
      findPreviousAssetBackup(plan.modName, target.assetName)
    ))).filter((file): file is string => Boolean(file)),
    pngs: (await Promise.all((plan.targets.textures ?? []).map((target) =>
      findPreviousAssetBackup(plan.modName, `${target.assetName}.png`)
    ))).filter((file): file is string => Boolean(file))
  };
}

async function findPreviousAssetBackup(modName: string, fileName: string): Promise<string | undefined> {
  const roots = [managerDataRootDir()];
  const versionsRoot = path.join(managerDataRootDir(), "versions");
  const stack = [...roots, versionsRoot];
  const marker = `${path.sep}asset-backups${path.sep}${sanitizePathPart(modName)}${path.sep}${fileName}`;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entryPath.includes(`${path.sep}versions${path.sep}${managerDataVersion()}${path.sep}`)) {
          continue;
        }
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && entryPath.endsWith(marker)) {
        return entryPath;
      }
    }
  }

  return undefined;
}

function registerPatchFileSources(target: Map<string, string>, files: CleanPatchFiles | PreparedPatchFiles) {
  for (const filePath of [...files.atlases, ...files.skels, ...files.pngs]) {
    target.set(path.basename(filePath).toLowerCase(), filePath);
  }
}

async function findDirtyAssets(
  assetDir: string,
  cleanSourcesByAsset: Map<string, string>,
  modSourcesByAsset: Map<string, string>
) {
  const dirtyAssets: Array<{ file: string; reason: "matches_mod" | "unknown" }> = [];
  const entries = await fs.readdir(assetDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const file = entry.name;
    const key = file.toLowerCase();
    const currentPath = path.join(assetDir, file);
    const cleanPath = cleanSourcesByAsset.get(key);
    if (!cleanPath) {
      continue;
    }

    const currentHash = await hashFile(currentPath);
    if (currentHash === await hashFile(cleanPath)) {
      continue;
    }

    const modPath = modSourcesByAsset.get(key);
    if (modPath && currentHash === await hashFile(modPath)) {
      dirtyAssets.push({ file, reason: "matches_mod" });
      continue;
    }

    if (path.extname(file).toLowerCase() === ".png") {
      continue;
    }

    dirtyAssets.push({ file, reason: "unknown" });
  }

  return dirtyAssets;
}

function createRepairJobs(cleanJobs: PatchBundleJob[], dirtyFiles: Set<string>): PatchBundleJob[] {
  return cleanJobs.map((job) => ({
    ...job,
    atlases: job.atlases.filter((file) => dirtyFiles.has(path.basename(file))),
    skels: job.skels.filter((file) => dirtyFiles.has(path.basename(file))),
    pngs: job.pngs.filter((file) => dirtyFiles.has(path.basename(file))),
    insertPngs: [],
    assetBackupDir: undefined
  })).filter((job) => job.atlases.length > 0 || job.skels.length > 0 || job.pngs.length > 0);
}

async function preparePatchFiles(
  mod: ModEntry,
  options: ApplyPatchOptions,
  onProgress?: (progress: PatchProgress) => void,
  plan?: PatchPlanEntry,
  progressCurrent = 0,
  progressTotal = 1
) {
  const skelDir = path.join(convertedRoot(), sanitizePathPart(mod.modName));
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

function filterPatchFilesForPlan(files: PreparedPatchFiles, plan: PatchPlanEntry): PreparedPatchFiles {
  const atlasNames = getTargetNames(plan.targets.atlas, plan.targets.atlases);
  const skelNames = getTargetNames(plan.targets.skel, plan.targets.skels);
  const textureNames = getTargetNames(plan.targets.texture, plan.targets.textures);
  const atlases = files.atlases.filter((file) => atlasNames.has(path.basename(file).toLowerCase()));
  const pngsByBaseName = new Map(files.pngs.map((file) => [path.basename(file, path.extname(file)).toLowerCase(), file]));
  const insertTextureNames = getAtlasPageTextureNames(atlases).filter((name) =>
    !textureNames.has(name) && pngsByBaseName.has(name)
  );

  return {
    atlases,
    skels: files.skels.filter((file) => skelNames.has(path.basename(file).toLowerCase())),
    pngs: files.pngs.filter((file) => textureNames.has(path.basename(file, path.extname(file)).toLowerCase())),
    insertPngs: insertTextureNames.map((name) => pngsByBaseName.get(name)).filter((file): file is string => Boolean(file))
  };
}

function getTargetNames(
  legacyTarget: PatchPlanEntry["targets"]["atlas"],
  targets: PatchPlanEntry["targets"]["atlases"]
) {
  const names = new Set<string>();

  for (const target of [legacyTarget, ...(targets ?? [])]) {
    if (target?.assetName) {
      names.add(target.assetName.toLowerCase());
    }
  }

  return names;
}

function getAtlasPageTextureNames(atlases: string[]) {
  const names = new Set<string>();

  for (const atlas of atlases) {
    for (const line of readAtlasTextSync(atlas).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || line !== trimmed || trimmed.includes(":") || !trimmed.toLowerCase().endsWith(".png")) {
        continue;
      }

      names.add(path.basename(trimmed, path.extname(trimmed)).toLowerCase());
    }
  }

  return [...names];
}

function readAtlasTextSync(filePath: string) {
  return fsSync.readFileSync(filePath, "utf8");
}

async function getRestorePatchFiles(plan: PatchPlanEntry, mod?: ModEntry) {
  if (!plan.bundleId) {
    throw new Error("Patch plan has no bundle id.");
  }

  const backupDir = getAssetBackupDir(plan.bundleId, plan.modName);
  const atlases = (plan.targets.atlases ?? []).map((target) => path.join(backupDir, target.assetName));
  const skels = (plan.targets.skels ?? []).map((target) => path.join(backupDir, target.assetName));
  const pngs = (plan.targets.textures ?? []).map((target) => path.join(backupDir, `${target.assetName}.png`));
  const removePngs = mod ? getRestoreRemovePngs(mod, atlases) : [];
  const files = [...atlases, ...skels, ...pngs];

  for (const file of files) {
    await fs.access(file);
  }

  return { atlases, skels, pngs, removePngs };
}

function getRestoreRemovePngs(mod: ModEntry, restoreAtlases: string[]) {
  const restorePages = new Set(getAtlasPageTextureNames(restoreAtlases));
  if (!restorePages.size) {
    return [];
  }

  const modAtlasNames = new Set(mod.files.atlas.map((file) => path.basename(file.path).toLowerCase()));
  const modAtlases = restoreAtlases
    .filter((atlas) => modAtlasNames.has(path.basename(atlas).toLowerCase()))
    .map((atlas) => mod.files.atlas.find((file) => path.basename(file.path).toLowerCase() === path.basename(atlas).toLowerCase())?.path)
    .filter((file): file is string => Boolean(file));
  const modPages = getAtlasPageTextureNames(modAtlases);
  const pngsByBaseName = new Map(mod.files.png.map((file) => [file.baseName.toLowerCase(), file.path]));

  return modPages
    .filter((name) => !restorePages.has(name))
    .map((name) => pngsByBaseName.get(name))
    .filter((file): file is string => Boolean(file));
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

function getReplacementRestoreModNames(plans: PatchPlanEntry[], restoreModNames: string[], patchedApplyModNames: Set<string>) {
  const restoreSet = new Set(restoreModNames);
  const patchedApplyTargetKeys = new Set(
    plans
      .filter((plan) => patchedApplyModNames.has(plan.modName))
      .flatMap(getPatchPlanAssetKeys)
  );
  const replacementRestoreModNames = new Set<string>();

  if (!patchedApplyTargetKeys.size) {
    return replacementRestoreModNames;
  }

  for (const plan of plans) {
    if (!restoreSet.has(plan.modName)) {
      continue;
    }

    if (getPatchPlanAssetKeys(plan).some((key) => patchedApplyTargetKeys.has(key))) {
      replacementRestoreModNames.add(plan.modName);
    }
  }

  return replacementRestoreModNames;
}

function getPatchPlanAssetKeys(plan: PatchPlanEntry) {
  const bundleId = plan.bundleId ?? "";
  return getPatchPlanAssetNames(plan).map((assetName) => `${bundleId}:${assetName.toLowerCase()}`);
}

function getPatchPlanAssetNames(plan: PatchPlanEntry) {
  const targets = [
    plan.targets.atlas,
    plan.targets.skel,
    plan.targets.texture,
    ...(plan.targets.atlases ?? []),
    ...(plan.targets.skels ?? []),
    ...(plan.targets.textures ?? [])
  ].filter((target): target is NonNullable<typeof target> => Boolean(target));

  return [...new Set(targets.map((target) => target.assetName).filter(Boolean))];
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

function createRestoreAllEntriesForBundle(plans: PatchPlanEntry[], history: PatchHistory): PatchRunEntry[] {
  const firstPlan = plans[0];
  const bundleId = firstPlan.bundleId ?? "";
  const updatedAt = new Date().toISOString();
  const message = "Original backup A copied to game __data.";
  const entries = new Map<string, PatchRunEntry>();

  for (const plan of plans) {
    const entry = createPatchRunEntry(plan, "restored");
    entries.set(entry.id, { ...entry, updatedAt, message });
  }

  for (const entry of history.entries) {
    if (entry.bundleId !== bundleId || entries.has(entry.id)) {
      continue;
    }

    entries.set(entry.id, {
      ...entry,
      status: "restored",
      updatedAt,
      message
    });
  }

  return [...entries.values()];
}

async function checkPatchDataForBundle(plans: PatchPlanEntry[]): Promise<PatchDataCheckEntry[]> {
  const firstPlan = plans[0];
  if (!firstPlan.bundleId || !firstPlan.bundlePath) {
    return plans.map((plan) => ({
      modName: plan.modName,
      name: plan.name,
      bundleId: plan.bundleId ?? "",
      bundlePath: plan.bundlePath ?? "",
      status: "missing",
      message: "Changed: patch plan has no __data path. Re-scan Shared and generate a new patch plan."
    }));
  }

  const status = await checkPatchDataState(firstPlan.bundlePath, firstPlan.bundleId, firstPlan.bundleSha256);
  return plans.map((plan) => ({
    modName: plan.modName,
    name: plan.name,
    bundleId: plan.bundleId ?? "",
    bundlePath: plan.bundlePath ?? "",
    ...status
  }));
}

async function checkPatchDataState(bundlePath: string, bundleId: string, expectedCleanSha256?: string): Promise<Pick<PatchDataCheckEntry, "status" | "message">> {
  if (!await fileExists(bundlePath)) {
    return {
      status: "missing",
      message: `Changed: __data is missing for ${bundleId}. Re-scan Shared and generate a new patch plan.`
    };
  }

  const originalPath = getOriginalBackupPath(bundleId);
  const patchedPath = getPatchWorkPath(bundleId);
  const hasOriginal = await fileExists(originalPath);
  const hasPatched = await fileExists(patchedPath);

  if (!hasOriginal && !hasPatched) {
    return {
      status: "no_backup",
      message: "No existing A/B backup yet. Current __data can be used to create backup A."
    };
  }

  const currentHash = await hashFile(bundlePath);
  if (expectedCleanSha256 && currentHash === expectedCleanSha256) {
    await replaceOriginalBackup(bundleId, bundlePath);
    await fs.copyFile(bundlePath, patchedPath);
    return {
      status: "ok",
      message: "Current __data matches the versioned clean SHA-256. Refreshed backup A/B."
    };
  }

  const matchesOriginal = hasOriginal && currentHash === await hashFile(originalPath);
  const matchesPatched = hasPatched && currentHash === await hashFile(patchedPath);

  if (matchesOriginal || matchesPatched) {
    return {
      status: "ok",
      message: matchesPatched
        ? "Current __data matches backup B."
        : "Current __data matches backup A."
    };
  }

  return {
    status: "changed",
    message: `Changed: current __data differs from known A/B backups for ${bundleId}. Re-scan Shared and generate a new patch plan before patching.`
  };
}

function createChangedPatchRunEntry(entry: PatchDataCheckEntry): PatchRunEntry {
  return {
    id: `${entry.modName}:${entry.bundleId || "none"}`,
    modName: entry.modName,
    name: entry.name,
    bundleId: entry.bundleId,
    bundlePath: entry.bundlePath,
    status: "changed",
    updatedAt: new Date().toISOString(),
    message: entry.message
  };
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
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
  return backend === "rust-native" || backend === "unitypy" || backend === "auto" || backend === "auto-backend" || backend === "uabea-astc" || backend === "uabea-safe" ? backend : "uabea";
}

function formatPatchBackend(backend: PatchBackend) {
  if (backend === "auto-backend") {
    return "Auto backend";
  }

  if (backend === "auto") {
    return "Force ASTC Mode";
  }

  if (backend === "rust-native") {
    return "Rust native";
  }

  if (backend === "unitypy") {
    return "UnityPy";
  }

  if (backend === "uabea-astc") {
    return "UABEA / AssetsTools.NET ASTC";
  }

  if (backend === "uabea-safe") {
    return "UABEA Safe";
  }

  return "UABEA / AssetsTools.NET";
}

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

async function writePatchHistory(history: PatchHistory) {
  const historyPath = patchHistoryPath();
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

async function findPreviousPatchHistoryPaths(currentHistoryPath: string) {
  const root = managerDataRootDir();
  const histories = new Set<string>();
  const legacyPath = path.join(root, "patch-history.json");

  if (path.resolve(legacyPath) !== currentHistoryPath && await fileExists(legacyPath)) {
    histories.add(legacyPath);
  }

  const versionsRoot = path.join(root, "versions");
  try {
    const entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === managerDataVersion()) {
        continue;
      }

      const historyPath = path.join(versionsRoot, entry.name, "patch-history.json");
      if (path.resolve(historyPath) !== currentHistoryPath && await fileExists(historyPath)) {
        histories.add(historyPath);
      }
    }
  } catch {
    // No previous versioned histories yet.
  }

  return [...histories];
}

async function readHistoryFile(historyPath: string): Promise<PatchHistory | undefined> {
  try {
    return JSON.parse(await fs.readFile(historyPath, "utf8")) as PatchHistory;
  } catch {
    return undefined;
  }
}

function versionFromHistoryPath(historyPath: string) {
  const parts = path.resolve(historyPath).split(path.sep);
  const versionsIndex = parts.lastIndexOf("versions");
  return versionsIndex >= 0 ? parts[versionsIndex + 1] : "legacy";
}

function getActivePatchedModNames(history: PatchHistory) {
  const byModName = new Map<string, PatchRunEntry[]>();
  for (const entry of history.entries) {
    byModName.set(entry.modName, [...(byModName.get(entry.modName) ?? []), entry]);
  }

  return [...byModName.entries()]
    .filter(([, entries]) => getLatestEntriesById(entries).some((entry) => entry.status === "patched"))
    .map(([modName]) => modName);
}

function getLatestEntriesById(entries: PatchRunEntry[]) {
  const latestById = new Map<string, PatchRunEntry>();
  const sortedEntries = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const entry of sortedEntries) {
    if (!latestById.has(entry.id)) {
      latestById.set(entry.id, entry);
    }
  }

  return [...latestById.values()];
}

function patchHistoryPath() {
  return path.join(managerDataDir(), "patch-history.json");
}

function convertedRoot() {
  return path.join(managerDataDir(), "converted");
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
