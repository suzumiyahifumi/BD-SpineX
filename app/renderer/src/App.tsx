import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppInfo, ApplyPatchOptions, BundleAsset, GameVersionInfo, ModsIndex, PatchBackend, PatchHistory, PatchPlanEntry, PatchProgress, PatchStateChange, PreviousPatchedMods, SharedIndex, SharedScanBackend, SharedScanProgress } from "../../../core/types";

type Settings = {
  settingsVersion: number;
  sharedDir: string;
  modsDir: string;
  converterPath: string;
  scanBackend: SharedScanBackend;
  patchBackend: PatchBackend;
  dotnetPath: string;
  unityVersion: string;
  decryptKey: string;
  scanLimit: string;
};

type SharedAssetCategory = "all" | "char" | "cutscene_char" | "illust_dating" | "other";
type ModCategory = "char" | "cutscene" | "dating" | "other";
type ModSortKey = "folder" | "name" | "category" | "status";
type SortDirection = "asc" | "desc";

type ModSort = {
  key: ModSortKey;
  direction: SortDirection;
};

type PendingChangeTone = "added" | "removed" | "repair";

type PendingChangeRow = PatchStateChange & {
  implicit?: boolean;
};

type LogAccentTone = "action" | "module" | "bundle" | "error";

type LogAccent = {
  text: string;
  tone: LogAccentTone;
};

type LogEntry = {
  id: string;
  time: string;
  message: string;
  accents?: LogAccent[];
};

type LogInput = string | {
  message: string;
  accents?: LogAccent[];
};

type ModPowerState = {
  enabled: boolean;
  restoreModNames: string[];
};

type PatchStatusBundleGroup = {
  bundleId: string;
  bundlePath: string;
  status: string;
  updatedAt: string;
  patchedModCount: number;
  entries: PatchHistory["entries"];
};

type PatchBackendFit = {
  modName: string;
  bundleId: string;
  backend: PatchBackend;
  reason: string;
};

type VersionUpdatePrompt = PreviousPatchedMods & {
  phase: "prompt" | "checking" | "applying";
  message: string;
  detail?: string;
};

const emptySettings: Settings = {
  settingsVersion: 3,
  sharedDir: "",
  modsDir: "",
  converterPath: "",
  scanBackend: "uabea",
  patchBackend: "auto",
  dotnetPath: "manager-data/tools/dotnet/dotnet",
  unityVersion: "2021.3.33f1",
  decryptKey: "",
  scanLimit: "10"
};
const settingsStorageKey = "bd-spinex:settings";
const legacySettingsStorageKey = "bd2-spine-mod-manager:settings";
const modPowerStorageKey = "bd-spinex:mod-power";
const legacyModPowerStorageKey = "bd2-spine-mod-manager:mod-power";
const defaultModPowerState: ModPowerState = { enabled: true, restoreModNames: [] };
const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo);
  const [gameVersionInfo, setGameVersionInfo] = useState<GameVersionInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [modsIndex, setModsIndex] = useState<ModsIndex>({ mods: [] });
  const [sharedIndex, setSharedIndex] = useState<SharedIndex>({ bundles: [] });
  const [plans, setPlans] = useState<PatchPlanEntry[]>([]);
  const [patchHistory, setPatchHistory] = useState<PatchHistory>({ updatedAt: "", entries: [] });
  const [desiredPatchStates, setDesiredPatchStates] = useState<Record<string, boolean>>({});
  const [repairPatchStates, setRepairPatchStates] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogEntry[]>(() => [createLogEntry("Ready.")]);
  const [busy, setBusy] = useState(false);
  const [modsActionLocked, setModsActionLocked] = useState(false);
  const [sharedProgress, setSharedProgress] = useState<SharedScanProgress | null>(null);
  const [patchProgress, setPatchProgress] = useState<PatchProgress | null>(null);
  const [sharedAssetCategory, setSharedAssetCategory] = useState<SharedAssetCategory>("all");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [sharedScanActive, setSharedScanActive] = useState(false);
  const [showSharedCandidates, setShowSharedCandidates] = useState(false);
  const [modPower, setModPower] = useState<ModPowerState>(() => loadModPowerState());
  const [modFilter, setModFilter] = useState("");
  const [modSort, setModSort] = useState<ModSort>({ key: "folder", direction: "asc" });
  const [previousHistoryPrompt, setPreviousHistoryPrompt] = useState<VersionUpdatePrompt | null>(null);
  const [previousHistoryChecked, setPreviousHistoryChecked] = useState(false);
  const [collapsedPatchBundles, setCollapsedPatchBundles] = useState<Record<string, boolean>>({});

  const readyTargetCount = useMemo(() => plans.filter((plan) => plan.status === "ready").length, [plans]);
  const readyModCount = useMemo(() => countReadyMods(plans), [plans]);
  const plansByModName = useMemo(() => new Map(plans.map((plan) => [plan.modName, plan])), [plans]);
  const allPlansByModName = useMemo(() => groupPatchPlansByModName(plans), [plans]);
  const patchHistoryByModName = useMemo(() => groupPatchHistoryByModName(patchHistory), [patchHistory]);
  const patchStatusGroups = useMemo(() => getPatchStatusBundleGroups(patchHistory), [patchHistory]);
  const actualPatchStates = useMemo(() => getActualPatchStates(modsIndex, patchHistory), [modsIndex, patchHistory]);
  const patchStateChanges = useMemo(() => getPatchStateChanges(modsIndex, actualPatchStates, desiredPatchStates), [modsIndex, actualPatchStates, desiredPatchStates]);
  const pendingChangeRows = useMemo(() => getPendingChangeRows(patchStateChanges, repairPatchStates, actualPatchStates, allPlansByModName), [patchStateChanges, repairPatchStates, actualPatchStates, allPlansByModName]);
  const effectivePatchStateChanges = useMemo(() => pendingChangeRows.map(({ modName, enabled, repair }) => ({ modName, enabled, repair })), [pendingChangeRows]);
  const pendingChangeTones = useMemo(() => getPendingChangeTones(pendingChangeRows, allPlansByModName), [pendingChangeRows, allPlansByModName]);
  const hasRepairPatchChanges = useMemo(() => Object.values(repairPatchStates).some(Boolean), [repairPatchStates]);
  const activeModNames = useMemo(() => Object.entries(actualPatchStates).filter(([, enabled]) => enabled).map(([modName]) => modName), [actualPatchStates]);
  const restorablePowerModNames = useMemo(() => modPower.restoreModNames.filter((modName) => modsIndex.mods.some((mod) => mod.modName === modName)), [modPower.restoreModNames, modsIndex.mods]);
  const visibleMods = useMemo(() => filterAndSortMods(modsIndex.mods, modFilter, modSort, plansByModName, patchHistoryByModName), [modsIndex.mods, modFilter, modSort, plansByModName, patchHistoryByModName]);
  const selectableVisibleMods = useMemo(() => visibleMods.filter((mod) => mod.status === "ready" || actualPatchStates[mod.modName]), [visibleMods, actualPatchStates]);
  const allVisibleModsSelected = useMemo(() =>
    selectableVisibleMods.length > 0 && selectableVisibleMods.every((mod) => getDesiredPatchState(mod.modName, actualPatchStates, desiredPatchStates)),
  [selectableVisibleMods, actualPatchStates, desiredPatchStates]);
  const modTargetNames = useMemo(() => getModTargetNames(modsIndex), [modsIndex]);
  const missingSharedDir = !settings.sharedDir.trim();
  const missingModsDir = !settings.modsDir.trim();
  const settingsLocked = missingSharedDir || missingModsDir;
  const versionLocked = isGameVersionMismatch(appInfo, gameVersionInfo);
  const previousHistoryLocked = Boolean(previousHistoryPrompt);
  const modsLocked = modsActionLocked || !modPower.enabled || versionLocked || settingsLocked || previousHistoryLocked;
  const togglePatchStatusBundle = (bundleId: string) => {
    setCollapsedPatchBundles((current) => ({ ...current, [bundleId]: !current[bundleId] }));
  };
  const sharedAssets = useMemo(() => {
    return sharedIndex.bundles.flatMap((bundle) =>
      bundle.assets.map((asset) => ({
        ...asset,
        category: classifySharedAsset(asset.name),
        bundleId: bundle.bundleId,
        dataPath: bundle.dataPath
      }))
    );
  }, [sharedIndex]);
  const relatedSharedAssets = useMemo(() => filterSharedAssetsByTargets(sharedAssets, modTargetNames), [sharedAssets, modTargetNames]);
  const sharedAssetGroups = useMemo(() => summarizeSharedAssets(relatedSharedAssets), [relatedSharedAssets]);
  const filteredSharedAssets = useMemo(() => {
    if (sharedAssetCategory === "all") {
      return relatedSharedAssets;
    }

    return relatedSharedAssets.filter((asset) => asset.category === sharedAssetCategory);
  }, [relatedSharedAssets, sharedAssetCategory]);
  const sharedErrors = useMemo(() =>
    sharedIndex.bundles.filter((bundle) => bundle.scanError),
  [sharedIndex]);
  const sharedErrorGroups = useMemo(() => groupSharedErrors(sharedErrors), [sharedErrors]);

  useEffect(() => {
    void window.bd2.getAppInfo().then(setAppInfo).catch(() => undefined);
    void window.bd2.readPatchHistory().then(setPatchHistory).catch(() => undefined);
    void loadSavedSettings().then((loadedSettings) => {
      setSettings(loadedSettings);
      setSettingsLoaded(true);
      void refreshGameVersion(loadedSettings.sharedDir);
      window.setTimeout(() => void runTask(async () => {
        await scanModsWorkflow(loadedSettings);
      }), 50);
    });
    const unsubscribeShared = window.bd2.onSharedScanProgress((progress) => {
      setSharedProgress(progress);
      setSharedScanActive(!["done", "stopped"].includes(progress.phase));
      if (progress.phase === "found") {
        const discovered = progress.discoveredTotal ?? progress.total;
        const scanScope = progress.targetTotal ? `${progress.total} largest bundle(s)` : `${progress.total} bundle(s)`;
        pushLog(setLogs, `Indexed ${discovered} Shared bundle(s). Scanning ${scanScope}.`);
      }

      if (progress.phase === "scanned") {
        if (!progress.error && !progress.assetCount) {
          return;
        }

        const detail = progress.error
          ? `${progress.bundleId}: scan error`
          : `${progress.bundleId}: ${progress.assetCount ?? 0} candidate asset(s)`;
        pushLog(setLogs, `Shared ${progress.current}/${progress.total} ${detail}`);
      }
    });
    const unsubscribePatch = window.bd2.onPatchProgress((progress) => {
      setPatchProgress(progress);
      pushLog(setLogs, formatPatchProgressLog(progress));
    });

    return () => {
      unsubscribeShared();
      unsubscribePatch();
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    void window.bd2.writeSettings(settings).catch(() => undefined);
  }, [settings, settingsLoaded]);

  useEffect(() => {
    window.localStorage.setItem(modPowerStorageKey, JSON.stringify(modPower));
  }, [modPower]);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    void refreshGameVersion(settings.sharedDir);
  }, [settings.sharedDir, settingsLoaded]);

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function log(input: LogInput) {
    pushLog(setLogs, input);
  }

  async function refreshGameVersion(sharedDir?: string) {
    const info = await window.bd2.detectGameVersion(sharedDir).catch(() => null);
    if (info) {
      setGameVersionInfo(info);
    }
  }

  async function selectDirectory(key: "sharedDir" | "modsDir") {
    const selected = await window.bd2.selectDirectory();
    if (selected) {
      updateSetting(key, selected);
      log(`Selected ${key}: ${selected}`);
    }
  }

  async function openDetectedSharedFolderFromPlayCover() {
    const opened = await window.bd2.openDetectedSharedFolder().catch(() => null);
    if (!opened) {
      log("Could not auto-detect the BrownDust II PlayCover Shared folder.");
      return;
    }

    log(`Opened detected Shared Folder: ${opened}`);
  }

  async function openRecordsFolder() {
    try {
      const opened = await window.bd2.openRecordsFolder();
      log(`Opened records folder: ${opened}`);
    } catch (error) {
      log(`Failed to open records folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runTask(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runActionTask(task: () => Promise<void>) {
    setModsActionLocked(true);
    await runTask(task);
    setModsActionLocked(false);
  }

  async function toggleModPower() {
    if (modPower.enabled) {
      await turnOffAllMods();
    } else {
      await turnOnSavedMods();
    }
  }

  async function turnOffAllMods() {
    const restoreModNames = activeModNames;

    if (restoreModNames.length > 0) {
      const result = await window.bd2.copyPatchBackupsForMods(plans, restoreModNames, "original");
      setPatchHistory(result.history);
      setDesiredPatchStates(getActualPatchStates(modsIndex, result.history));
      setRepairPatchStates({});
      const restored = result.entries.filter((entry) => entry.status === "restored").length;
      const failed = result.entries.filter((entry) => entry.status === "failed").length;
      log(`Mod power off: copied backup A for ${restored} mod(s), ${failed} failed. Saved ${restoreModNames.length} enabled mod(s) for quick restore.`);
      if (!result.ok) {
        return;
      }
    } else {
      setDesiredPatchStates({});
      setRepairPatchStates({});
      log("Mod power off: no active mod was found. Mod controls are now locked.");
    }

    setModPower({ enabled: false, restoreModNames });
  }

  async function turnOnSavedMods() {
    const restoreSet = new Set(restorablePowerModNames);
    const modNames = modsIndex.mods
      .filter((mod) => restoreSet.has(mod.modName) && !actualPatchStates[mod.modName])
      .map((mod) => mod.modName);

    if (modNames.length > 0) {
      const result = await window.bd2.copyPatchBackupsForMods(plans, modNames, "patched");
      setPatchHistory(result.history);
      setDesiredPatchStates(getActualPatchStates(modsIndex, result.history));
      setRepairPatchStates({});
      const patched = result.entries.filter((entry) => entry.status === "patched").length;
      const failed = result.entries.filter((entry) => entry.status === "failed").length;
      log(`Mod power on: copied backup B for ${patched} mod(s), ${failed} failed. Restored saved mod state.`);
      if (!result.ok) {
        return;
      }
    } else {
      setDesiredPatchStates({});
      setRepairPatchStates({});
      log("Mod power on: no saved mod needed patching.");
    }

    setModPower({ enabled: true, restoreModNames: [] });
  }

  async function checkActivePatchData() {
    const result = await window.bd2.checkPatchDataForMods(plans, activeModNames);
    const ok = result.entries.filter((entry) => entry.status === "ok").length;
    const noBackup = result.entries.filter((entry) => entry.status === "no_backup").length;
    const changed = result.entries.filter((entry) => entry.status === "changed").length;
    const missing = result.entries.filter((entry) => entry.status === "missing").length;
    const bundleCount = new Set(result.entries.map((entry) => entry.bundleId).filter(Boolean)).size;

    log(`Active __data check: ${ok} ok, ${noBackup} no backup yet, ${changed} changed, ${missing} missing across ${bundleCount} __data bundle(s).`);
    for (const entry of result.entries.filter((item) => item.status === "changed" || item.status === "missing").slice(0, 8)) {
      log(`${entry.modName} ${entry.bundleId}: ${entry.message}`);
    }
  }

  function checkPatchBackendFit() {
    const targetModNames = new Set(
      effectivePatchStateChanges
        .filter((change) => change.enabled && (!actualPatchStates[change.modName] || change.repair))
        .map((change) => change.modName)
    );
    const targetPlans = plans.filter((plan) => targetModNames.has(plan.modName));
    const readyPlans = targetPlans.filter((plan) => plan.status === "ready");
    const blockedPlans = targetPlans.filter((plan) => plan.status !== "ready");

    if (!targetPlans.length) {
      log("Backend fit check: no new patch changes are staged.");
      return;
    }

    const fits = readyPlans.map((plan) => getPatchBackendFit(plan, Boolean(repairPatchStates[plan.modName])));
    const counts = countBackendFits(fits);
    log(`Backend fit check: ${fits.length} ready target(s), ${blockedPlans.length} blocked target(s). Recommended: ${formatBackendFitCounts(counts)}.`);

    for (const fit of fits.slice(0, 12)) {
      log(`${fit.modName} ${fit.bundleId}: ${formatPatchBackend(fit.backend)} - ${fit.reason}`);
    }

    for (const plan of blockedPlans.slice(0, 6)) {
      log(`${plan.modName} ${plan.bundleId ?? "unknown __data"}: cannot recommend backend because plan status is ${plan.status}.`);
    }
  }

  async function checkPreviousPatchedMods(index: ModsIndex, currentHistory: PatchHistory) {
    if (previousHistoryChecked) {
      return;
    }

    setPreviousHistoryChecked(true);
    if (hasCurrentVersionPatchActivity(currentHistory)) {
      return;
    }

    const previous = await window.bd2.readPreviousPatchedMods().catch(() => ({ modNames: [], sourceVersions: [] }));
    const availableModNames = new Set(index.mods.map((mod) => mod.modName));
    const matchedModNames = previous.modNames.filter((modName) => availableModNames.has(modName));
    if (matchedModNames.length === 0) {
      return;
    }

    const clearedModPowerOff = !modPower.enabled;
    if (clearedModPowerOff) {
      setModPower({ enabled: true, restoreModNames: [] });
    }

    setPreviousHistoryPrompt({
      modNames: matchedModNames,
      sourceVersions: previous.sourceVersions,
      phase: "prompt",
      message: clearedModPowerOff
        ? "Mod Power Off has been cleared. Detected version update. Run patch check?"
        : "Detected version update. Run patch check?",
      detail: `${matchedModNames.length} previously patched mod(s) can be checked against this game version.`
    });
    log(clearedModPowerOff
      ? `Mod Power Off cleared without file changes. Detected version update: ${matchedModNames.length} previously patched mod(s) selected for patch check.`
      : `Detected version update: ${matchedModNames.length} previously patched mod(s) selected for patch check.`);
  }

  async function inheritPreviousPatchedMods() {
    const prompt = previousHistoryPrompt;
    if (!prompt) {
      return;
    }

    setBusy(true);
    setModsActionLocked(true);
    try {
      setPreviousHistoryPrompt({
        ...prompt,
        phase: "checking",
        message: "Checking previously patched mods against the current game version...",
        detail: "Scanning Mods and Shared files before any patch is applied."
      });
      log("Version update check: scanning Mods and preparing current-version targets.");
      const currentModsIndex = settings.modsDir
        ? await window.bd2.scanMods(settings.modsDir)
        : modsIndex;
      setModsIndex(currentModsIndex);

      const targetNames = getModTargetNames(currentModsIndex);
      if (!targetNames.length) {
        throw new Error("No mod target names found. Scan Mods before inheriting previous installations.");
      }

      setPreviousHistoryPrompt((current) => current ? {
        ...current,
        message: "Loading bundled game index...",
        detail: "BD-SpineX is resolving current-version bundle ids from the packaged index first."
      } : current);
      log("Version update check: loading bundled current-version Shared index.");
      let index = await window.bd2.readSharedIndex(settings.sharedDir);
      let planIndex = await window.bd2.createPatchPlan(index, currentModsIndex);

      const promptModNames = prompt.modNames.filter((modName) => currentModsIndex.mods.some((mod) => mod.modName === modName));
      if (promptModNames.length === 0) {
        throw new Error("No previous patched mods are available in the current Mods Folder.");
      }

      const bundledPlansByModName = new Map(planIndex.plans.map((plan) => [plan.modName, plan]));
      const bundledReadyModNames = promptModNames.filter((modName) => bundledPlansByModName.get(modName)?.status === "ready");
      if (bundledReadyModNames.length === 0 || bundledReadyModNames.length < promptModNames.length) {
        const missingCount = promptModNames.length - bundledReadyModNames.length;
        log(`Version update check: bundled index resolved ${bundledReadyModNames.length}/${promptModNames.length} previous mod(s); scanning Shared for ${missingCount} unresolved mod(s).`);
        setPreviousHistoryPrompt((current) => current ? {
          ...current,
          message: "Scanning current game Shared files...",
          detail: "The packaged index did not resolve every previously patched mod, so BD-SpineX is falling back to a targeted scan."
        } : current);
        setSharedIndex({ bundles: [] });
        setPlans([]);
        setSharedProgress({ phase: "discovering", current: 0, total: 0 });
        index = await window.bd2.scanShared(settings.sharedDir, {
          scanBackend: settings.scanBackend,
          dotnetPath: settings.dotnetPath,
          unityVersion: settings.unityVersion,
          decryptKey: settings.decryptKey,
          forceRescan: false,
          targetNames
        });
        planIndex = await window.bd2.createPatchPlan(index, currentModsIndex);
      }
      setSharedIndex(index);

      setPlans(planIndex.plans);
      const modNames = promptModNames;

      const plansByModName = new Map(planIndex.plans.map((plan) => [plan.modName, plan]));
      const readyModNames = modNames.filter((modName) => plansByModName.get(modName)?.status === "ready");
      const unavailableModNames = modNames.filter((modName) => !readyModNames.includes(modName));
      if (unavailableModNames.length > 0) {
        log(`Version update check: ${unavailableModNames.length} mod(s) are not ready in the new index.`);
        for (const modName of unavailableModNames.slice(0, 8)) {
          const plan = plansByModName.get(modName);
          log(`${modName}: ${plan?.status ?? "missing patch plan"}`);
        }
      }

      if (readyModNames.length === 0) {
        log("Version update check stopped: no previously patched mods are ready for this game version.");
        return;
      }

      const currentHistory = await window.bd2.readPatchHistory();
      setPatchHistory(currentHistory);
      setDesiredPatchStates({
        ...getActualPatchStates(currentModsIndex, currentHistory),
        ...Object.fromEntries(readyModNames.map((modName) => [modName, true]))
      });

      setPreviousHistoryPrompt((current) => current ? {
        ...current,
        message: "Checking clean __data backups...",
        detail: "If this game version has no backup A yet, the current clean __data is saved before patching."
      } : current);
      const backupCheck = await window.bd2.ensureOriginalBackupsForMods(planIndex.plans, currentModsIndex, readyModNames, {
        ...createApplyPatchOptions(settings)
      });
      const ok = backupCheck.entries.filter((entry) => entry.status === "ok").length;
      const changed = backupCheck.entries.filter((entry) => entry.status === "changed").length;
      const missing = backupCheck.entries.filter((entry) => entry.status === "missing").length;
      const noBackup = backupCheck.entries.filter((entry) => entry.status === "no_backup").length;
      const checkedBundles = new Set(backupCheck.entries.map((entry) => entry.bundleId).filter(Boolean)).size;
      log(`Version update check: ${ok} clean backup check(s), ${changed} changed, ${missing} missing, ${noBackup} still without backup across ${checkedBundles} __data bundle(s).`);

      const invalidData = backupCheck.entries.filter((entry) => entry.status === "changed" || entry.status === "missing" || entry.status === "no_backup");
      if (invalidData.length > 0) {
        for (const entry of invalidData.slice(0, 8)) {
          log(`${entry.modName} ${entry.bundleId}: ${entry.message}`);
        }
        log("Version update check stopped before patching because clean backup A could not be guaranteed.");
        return;
      }

      setPreviousHistoryPrompt((current) => current ? {
        ...current,
        phase: "applying",
        message: "Reinstalling previously patched mods...",
        detail: "Clean backup A is ready. BD-SpineX is now applying the original update flow."
      } : current);
      const changes = readyModNames.map((modName) => ({ modName, enabled: true }));
      const result = await window.bd2.applyPatchStateChanges(planIndex.plans, currentModsIndex, changes, {
        ...createApplyPatchOptions(settings),
        migrationSourceVersions: prompt.sourceVersions
      });
      setPatchHistory(result.history);
      setDesiredPatchStates(getActualPatchStates(currentModsIndex, result.history));
      setRepairPatchStates({});
      const patched = result.entries.filter((entry) => entry.status === "patched").length;
      const failed = result.entries.filter((entry) => entry.status === "failed").length;
      const skipped = result.entries.filter((entry) => entry.status === "skipped").length;
      log(`Version update reinstall finished: ${patched} patched, ${failed} failed, ${skipped} skipped.`);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviousHistoryPrompt(null);
      setModsActionLocked(false);
      setBusy(false);
    }
  }

  async function scanModsWorkflow(activeSettings: Settings) {
    if (!activeSettings.modsDir) {
      return;
    }

    const [index, history] = await Promise.all([
      window.bd2.scanMods(activeSettings.modsDir),
      window.bd2.readPatchHistory()
    ]);
    setModsIndex(index);
    setPatchHistory(history);
    const actualStates = getActualPatchStates(index, history);
    setDesiredPatchStates(actualStates);
    setRepairPatchStates({});
    log(`Scanned Mods: ${index.mods.length} mod folder(s), ${index.mods.filter((mod) => mod.status === "ready").length} ready.`);
    await checkPreviousPatchedMods(index, history);

    if (!activeSettings.sharedDir) {
      setSharedIndex({ bundles: [] });
      setPlans([]);
      log("Shared Folder is empty. Scan Mods completed without Shared candidates or patch plan.");
      return;
    }

    const targetNames = getModTargetNames(index);
    if (!targetNames.length) {
      setSharedIndex({ bundles: [] });
      setPlans([]);
      log("No mod target names found. Skipped Shared scan and patch plan.");
      return;
    }

    const cachedSharedIndex = await window.bd2.readSharedIndex(activeSettings.sharedDir);
    setSharedIndex(cachedSharedIndex);

    const planIndex = await window.bd2.createPatchPlan(cachedSharedIndex, index);
    setPlans(planIndex.plans);
    log(`${formatPatchPlanSummary(planIndex.plans)} from cached Shared index. No Shared scan was started.`);
  }

  async function scanSharedForModsOnly(activeSettings: Settings) {
    if (!activeSettings.sharedDir) {
      return;
    }

    setSharedIndex({ bundles: [] });
    setPlans([]);
    setSharedProgress({ phase: "discovering", current: 0, total: 0 });
    const currentModsIndex = activeSettings.modsDir
      ? await window.bd2.scanMods(activeSettings.modsDir)
      : modsIndex;
    if (activeSettings.modsDir) {
      setModsIndex(currentModsIndex);
      log(`Scanned Mods first: ${currentModsIndex.mods.length} mod folder(s), including nested folders, ${currentModsIndex.mods.filter((mod) => mod.status === "ready").length} ready.`);
    }
    const index = await window.bd2.scanShared(activeSettings.sharedDir, {
      scanBackend: activeSettings.scanBackend,
      dotnetPath: activeSettings.dotnetPath,
      unityVersion: activeSettings.unityVersion,
      decryptKey: activeSettings.decryptKey,
      scanLimit: parseScanLimit(activeSettings.scanLimit),
      targetNames: getModTargetNames(currentModsIndex)
    });
    setSharedIndex(index);
    const assetCount = index.bundles.reduce((sum, bundle) => sum + bundle.assets.length, 0);
    const errorCount = index.bundles.filter((bundle) => bundle.scanError).length;
    log(`Scanned Shared: ${index.bundles.length} bundle(s), ${assetCount} candidate asset(s), ${errorCount} scan error(s).`);
    for (const bundle of index.bundles.filter((item) => item.scanError).slice(0, 5)) {
      log(`${bundle.bundleId}: ${bundle.scanError}`);
    }
  }

  function updateDesiredPatchState(modName: string, enabled: boolean) {
    if (!enabled) {
      setRepairPatchStates((current) => {
        const next = { ...current };
        delete next[modName];
        return next;
      });
    }

    setDesiredPatchStates((current) => ({
      ...current,
      [modName]: enabled
    }));
  }

  function resetPatchStateChanges() {
    setDesiredPatchStates({});
    setRepairPatchStates({});
    log("Reset staged module changes.");
  }

  function toggleVisiblePatchStates() {
    const enabled = !allVisibleModsSelected;
    const nextStates = Object.fromEntries(
      selectableVisibleMods
        .map((mod) => [mod.modName, enabled])
    );

    if (Object.keys(nextStates).length === 0) {
      return;
    }

    setDesiredPatchStates((current) => ({
      ...current,
      ...nextStates
    }));
    if (!enabled) {
      setRepairPatchStates((current) => {
        const next = { ...current };
        for (const mod of selectableVisibleMods) {
          delete next[mod.modName];
        }
        return next;
      });
    }
  }

  function toggleRepairPatchState(modName: string) {
    setRepairPatchStates((current) => ({
      ...current,
      [modName]: !current[modName]
    }));
  }

  function updateModSort(key: ModSortKey) {
    setModSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>{appInfo.name}</h1>
          <p className="appSubtitle">
            <span>{appInfo.subtitle}</span>
            <span className="versionBadge" title={formatVersionTitle(appInfo, gameVersionInfo)}>
              {formatVersionBadge(appInfo, gameVersionInfo)}
            </span>
            <HelpButton title="Version lock">
              BD-SpineX expects the manager version to match the BrownDust II game version. If they differ, mod operations are locked until a matching release is used.
            </HelpButton>
          </p>
          <p>BrownDust II Mod Management/Installation | Mac PlayCover Version</p>
        </div>
        <div className="statusPill" title={`${readyTargetCount} __data target(s) ready`}>
          {readyModCount} mod(s) ready
        </div>
      </header>

      <section className="panel settingsGrid">
        <PathField
          label="Shared Folder"
          helpTitle="Shared Folder"
          helpContent={
            <div className="helpContentStack">
              <span>Select BrownDust II's UnityCache Shared folder from the PlayCover app data. BD-SpineX reads game __data bundles here and writes patched bundles back after Apply Changes.</span>
              <span>Manual path: PlayCover app data / BrownDust II container / Data / Library / UnityCache / Shared.</span>
              <button
                className="helpLinkButton"
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openDetectedSharedFolderFromPlayCover();
                }}
              >
                Open detected Shared Folder
              </button>
            </div>
          }
          value={settings.sharedDir}
          onChange={(value) => updateSetting("sharedDir", value)}
          onBrowse={() => selectDirectory("sharedDir")}
          invalid={missingSharedDir}
        />
        <PathField
          label="Mods Folder"
          helpTitle="Mods Folder"
          helpText="Select the folder that contains your mods. Nested folders are supported, so you can group mods by source or author."
          value={settings.modsDir}
          onChange={(value) => updateSetting("modsDir", value)}
          onBrowse={() => selectDirectory("modsDir")}
          invalid={missingModsDir}
        />
        <SelectField
          label="Patch Backend"
          helpTitle="Patch Backend"
          helpText="Auto Backend checks each staged mod before patching and chooses the safest backend for that target. UABEA Safe uses the C# AssetsTools path with conservative texture rules and post-write verification. Force ASTC Mode uses UABEA with the ASTC helper for every patch run. Original UABEA keeps the classic AssetsTools path. UnityPy is available for troubleshooting."
          value={settings.patchBackend}
          onChange={(value) => updateSetting("patchBackend", value as PatchBackend)}
          options={[
            { value: "auto-backend", label: "Auto Backend" },
            { value: "uabea-safe", label: "UABEA Safe" },
            { value: "auto", label: "Force ASTC Mode" },
            { value: "uabea", label: "Original UABEA" },
            { value: "unitypy", label: "UnityPy" }
          ]}
        />
        <div className="settingsActions">
          <button className="advancedToggle" type="button" onClick={() => void openRecordsFolder()}>
            Open Records Folder
          </button>
          <button className="advancedToggle" type="button" onClick={() => setShowAdvancedSettings((current) => !current)}>
            {showAdvancedSettings ? "+ Hide Advanced Settings" : "+ Advanced Settings"}
          </button>
        </div>
        {showAdvancedSettings && (
          <div className="advancedSettingsGrid">
            <SelectField
              label="Shared Scan Backend"
              helpTitle="Shared Scan Backend"
              helpText="Choose how Shared bundles are scanned. UABEA is the stable option; Rust native is experimental parser support."
              value={settings.scanBackend}
              onChange={(value) => updateSetting("scanBackend", value as SharedScanBackend)}
              options={[
                { value: "uabea", label: "UABEA / AssetsTools.NET" },
                { value: "unitypy", label: "UnityPy" }
              ]}
            />
            <PathField
              label="Unity Fallback Version"
              helpTitle="Unity Fallback Version"
              helpText="Used only when a bundle does not expose enough Unity version metadata for the backend. The default should normally be left unchanged."
              value={settings.unityVersion}
              onChange={(value) => updateSetting("unityVersion", value)}
            />
            <PathField
              label="AssetBundle Decrypt Key"
              helpTitle="AssetBundle Decrypt Key"
              helpText="Optional key for encrypted AssetBundles. Leave this empty unless a specific game update requires one."
              value={settings.decryptKey}
              onChange={(value) => updateSetting("decryptKey", value)}
              type="password"
            />
            <PathField
              label="Scan Limit"
              helpTitle="Scan Limit"
              helpText="Limits targeted Shared scans to the largest candidate bundles for faster checks. Use Scan Entire Shared when rebuilding the full index."
              value={settings.scanLimit}
              onChange={(value) => updateSetting("scanLimit", value)}
            />
          </div>
        )}
      </section>

      <section className="toolbar">
        <div className="actionWithHelp">
          <button disabled={busy || !settings.modsDir} onClick={() => runTask(async () => {
            await scanModsWorkflow(settings);
          })}>
            Scan Mods
          </button>
          <HelpButton title="Scan Mods">
            Reads the Mods Folder, detects valid mod files, loads the current patch history, and builds a patch plan from the cached Shared index when available.
          </HelpButton>
        </div>
        <button disabled={!busy && !sharedScanActive} onClick={async () => {
          await window.bd2.stopSharedScan();
          log("Stop requested. Current bundle will finish before scanning stops.");
        }}>
          Stop Scan
        </button>
        <button className="advancedToggle" type="button" onClick={() => setShowAdvancedTools((current) => !current)}>
          {showAdvancedTools ? "+ Hide Advanced Tools" : "+ Advanced Tools"}
        </button>
        {showAdvancedTools && (
          <div className="advancedToolbar">
            <button disabled={busy || !settings.sharedDir} onClick={() => runTask(async () => {
              await scanSharedForModsOnly(settings);
            })}>
              Scan Shared for Mods
            </button>
            <HelpButton title="Scan Shared for Mods">
              Scans only Shared bundles likely to contain assets used by the currently detected mods. This is faster than scanning the entire Shared folder.
            </HelpButton>
            <button disabled={busy || !settings.sharedDir} onClick={() => runTask(async () => {
              setSharedIndex({ bundles: [] });
              setPlans([]);
              setSharedAssetCategory("all");
              setSharedProgress({ phase: "discovering", current: 0, total: 0 });
              const index = await window.bd2.scanShared(settings.sharedDir, {
                scanBackend: settings.scanBackend,
                dotnetPath: settings.dotnetPath,
                unityVersion: settings.unityVersion,
                decryptKey: settings.decryptKey,
                forceRescan: true
              });
              setSharedIndex(index);
              const assetCount = index.bundles.reduce((sum, bundle) => sum + bundle.assets.length, 0);
              const errorCount = index.bundles.filter((bundle) => bundle.scanError).length;
              log(`Fully scanned Shared: ${index.bundles.length} bundle(s), ${assetCount} candidate asset(s), ${errorCount} scan error(s).`);
              for (const bundle of index.bundles.filter((item) => item.scanError).slice(0, 5)) {
                log(`${bundle.bundleId}: ${bundle.scanError}`);
              }
            })}>
              Scan Entire Shared
            </button>
            <button disabled={busy || !modsIndex.mods.length || !sharedIndex.bundles.length} onClick={() => runTask(async () => {
              const planIndex = await window.bd2.createPatchPlan(sharedIndex, modsIndex);
              setPlans(planIndex.plans);
              log(formatPatchPlanSummary(planIndex.plans));
            })}>
              Generate Patch Plan
            </button>
          </div>
        )}
      </section>

      {sharedProgress && (
        <section className={`panel progressPanel ${isSharedScanComplete(sharedProgress) ? "complete" : ""}`}>
          <div className="progressHeader">
            <div>
              <div className="panelTitle">Shared Scan Progress</div>
              <div className="progressText">{formatSharedProgress(sharedProgress)}</div>
            </div>
            <div className="progressCounter">{formatSharedProgressCounter(sharedProgress)}</div>
          </div>
          <progress
            value={getSharedProgressValue(sharedProgress)}
            max={getSharedProgressMax(sharedProgress)}
          />
        </section>
      )}

      {patchProgress && (
        <section className={`panel progressPanel ${isPatchProgressComplete(patchProgress) ? "complete" : ""}`}>
          <div className="progressHeader">
            <div>
              <div className="panelTitle">Patch Progress</div>
              <div className="progressText">{formatPatchProgress(patchProgress)}</div>
            </div>
            <div className="progressCounter">{formatPatchProgressCounter(patchProgress)}</div>
          </div>
          <progress value={getPatchProgressValue(patchProgress)} max={getPatchProgressMax(patchProgress)} />
        </section>
      )}

      <section className="scanGrid">
        <div className="panel tablePanel modsPanel">
          <div className="modsHeader">
            <div>
              <div className="panelTitle titleWithHelp">
                <span>Mods</span>
                <HelpButton title="Mods table">
                  Check a mod to stage it for installation. Uncheck an active mod to stage restore. Sorting, filtering, and scrolling remain available while operations are locked.
                </HelpButton>
              </div>
              <div className="tableHint">{visibleMods.length} shown / {modsIndex.mods.length} scanned</div>
            </div>
            <div className="modsHeaderControls">
              <button
                disabled={busy || modsLocked || (!patchStateChanges.length && !hasRepairPatchChanges)}
                onClick={resetPatchStateChanges}
                title="Restore checkbox state before Apply Changes"
                type="button"
              >
                Reset Changes
              </button>
              <label className="modFilterField">
                <span>Filter</span>
                <input
                  value={modFilter}
                  onChange={(event) => setModFilter(event.target.value)}
                  placeholder="Search folder, name, category, status"
                />
              </label>
            </div>
          </div>
          <div className={`modsTableFrame ${modsLocked ? "locked" : ""}`}>
            <table>
            <colgroup>
              <col className="patchCol" />
              <col className="repairCol" />
              <col className="folderCol" />
              <col className="nameCol" />
              <col className="categoryCol" />
              <col className="statusCol" />
            </colgroup>
            <thead>
              <tr>
                <th className="patchColumn">
                  <div className="patchBulkControls" aria-label="Bulk patch selection">
                    <button
                      disabled={modsLocked || selectableVisibleMods.length === 0}
                      onClick={toggleVisiblePatchStates}
                      title={allVisibleModsSelected ? "Clear all visible mods" : "Select all visible mods"}
                      type="button"
                    >
                      {allVisibleModsSelected ? "×" : "✓"}
                    </button>
                  </div>
                </th>
                <th>Repair</th>
                <th>{renderModSortButton("Folder", "folder", modSort, updateModSort)}</th>
                <th>{renderModSortButton("Name", "name", modSort, updateModSort)}</th>
                <th>{renderModSortButton("Category", "category", modSort, updateModSort)}</th>
                <th>{renderModSortButton("Status", "status", modSort, updateModSort)}</th>
              </tr>
            </thead>
            <tbody>
              {modsIndex.mods.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">Scan Mods to inspect detected file names.</td>
                </tr>
              ) : visibleMods.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">No mods match this filter.</td>
                </tr>
              ) : visibleMods.map((mod) => {
                const pendingTone = pendingChangeTones[mod.modName];
                const repairEnabled = Boolean(repairPatchStates[mod.modName]);
                const displayStatus = getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName));
                const repairAvailable = (actualPatchStates[mod.modName] || displayStatus === "changed" || displayStatus === "failed") && hasReadyPatchPlan(allPlansByModName.get(mod.modName));
                const repairDisabled = modsLocked || !repairAvailable;
                return (
                  <tr key={mod.dir} className={pendingTone ? `pendingPatchChange ${formatPendingChangeToneClass(pendingTone)}` : ""}>
                    <td className="patchColumn">
                      <input
                        aria-label={`Patch ${mod.modName}`}
                        checked={getDesiredPatchState(mod.modName, actualPatchStates, desiredPatchStates)}
                        disabled={modsLocked || (mod.status !== "ready" && !actualPatchStates[mod.modName])}
                        type="checkbox"
                        onChange={(event) => updateDesiredPatchState(mod.modName, event.target.checked)}
                      />
                    </td>
                    <td className="repairColumn">
                      <button
                        aria-pressed={repairEnabled}
                        className={repairEnabled ? "repairButton active" : "repairButton"}
                        disabled={repairDisabled}
                        title={repairAvailable
                          ? repairEnabled ? "Remove from repair mode" : "Stage repair mode"
                          : "Repair mode is available only for patched or changed mods"}
                        type="button"
                        onClick={() => toggleRepairPatchState(mod.modName)}
                      >
                        Fix
                      </button>
                    </td>
                    <td className="folderCell" title={mod.modName}>{formatModFolderName(mod.modName)}</td>
                    <td title={mod.name}>{mod.name}</td>
                  <td>
                    <span className={`categoryBadge ${classifyMod(mod)}`}>{formatModCategory(classifyMod(mod))}</span>
                  </td>
                    <td title={formatModPatchStatusTitle(plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))}>
                      <span className={`badge ${getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))}`}>
                        {formatPatchStatusLabel(getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName)))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
            {modsLocked && (
              <div className="modsLockOverlay" aria-hidden="true">
                <span>{formatModsLockMessage({ modsActionLocked, modPowerEnabled: modPower.enabled, versionLocked, missingSharedDir, missingModsDir, previousHistoryLocked, previousHistoryMessage: previousHistoryPrompt?.message })}</span>
              </div>
            )}
          </div>
        </div>

        <div className={`panel tablePanel sharedPanel ${showSharedCandidates ? "expanded" : "collapsed"}`}>
          <div className="tableHeader">
            <div>
              <div className="panelTitle titleWithHelp">
                <span>Shared Candidates</span>
                <HelpButton title="Shared Candidates">
                  Shows game assets found in Shared bundles that match your mod target names. These candidates are used to generate patch plans.
                </HelpButton>
              </div>
              <div className="tableHint">{filteredSharedAssets.length} shown / {relatedSharedAssets.length} related / {sharedAssets.length} indexed</div>
            </div>
            <div className="tableHeaderActions">
              {showSharedCandidates && (
                <div className="segmentedControl" aria-label="Shared asset category">
                  {sharedAssetGroups.map((group) => (
                    <button
                      key={group.category}
                      className={sharedAssetCategory === group.category ? "active" : ""}
                      type="button"
                      onClick={() => setSharedAssetCategory(group.category)}
                    >
                      {group.label} <span>{group.count}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                className="advancedToggle"
                aria-expanded={showSharedCandidates}
                type="button"
                onClick={() => setShowSharedCandidates((current) => !current)}
              >
                {showSharedCandidates ? "+ Collapse" : "+ Expand"}
              </button>
            </div>
          </div>

          {showSharedCandidates && (
            <>
              <div className="assetSummaryGrid">
                {sharedAssetGroups.filter((group) => group.category !== "all").map((group) => (
                  <div className="assetSummaryItem" key={group.category}>
                    <div className="assetSummaryLabel">{group.label}</div>
                    <div className="assetSummaryCount">{group.count}</div>
                    <div className="assetSummaryMeta">{group.uniqueBaseCount} base name(s)</div>
                  </div>
                ))}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Bundle</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSharedAssets.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty">Scan Mods and Shared to list matching candidate assets.</td>
                    </tr>
                  ) : filteredSharedAssets.map((asset) => (
                    <tr key={`${asset.bundleId}:${asset.pathId}`}>
                      <td title={asset.name}>{asset.name}</td>
                      <td>{formatSharedAssetCategory(asset.category)}</td>
                      <td>{asset.type}</td>
                      <td title={asset.dataPath}>{asset.bundleId}</td>
                      <td>{formatAssetSize(asset)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>

      {sharedErrors.length > 0 && (
        <section className="panel tablePanel errorPanel">
          <div className="panelTitle">Shared Scan Error Summary</div>
          <div className="summaryGrid">
            {sharedErrorGroups.map((group) => (
              <div className="summaryItem" key={group.message}>
                <div className="summaryCount">{group.count}</div>
                <div className="summaryText" title={group.message}>{group.message}</div>
              </div>
            ))}
          </div>
          <div className="panelTitle subTitle">First {Math.min(sharedErrors.length, 50)} Error Details</div>
          <table>
            <thead>
              <tr>
                <th>Bundle</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {sharedErrors.slice(0, 50).map((bundle) => (
                <tr key={bundle.bundleId}>
                  <td title={bundle.dataPath}>{bundle.bundleId}</td>
                  <td title={bundle.scanError}>{bundle.scanError}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="contentGrid">
        <div className="panel tablePanel">
          <div className="panelTitle titleWithHelp">
            <span>Pending Changes</span>
            <HelpButton title="Pending Changes">
              This table shows what will change when Apply Changes is pressed. Nothing is written to the game until you apply.
            </HelpButton>
          </div>
          <table>
            <thead>
              <tr>
                <th>Mod</th>
                <th>Mode</th>
                <th>Current</th>
                <th>Desired</th>
              </tr>
            </thead>
            <tbody>
              {pendingChangeRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">Change a module checkbox or stage repair mode to patch changes.</td>
                </tr>
              ) : pendingChangeRows.map((change) => (
                <tr key={change.modName} className={`pendingPatchChange ${formatPendingChangeToneClass(pendingChangeTones[change.modName])}`}>
                  <td>{change.modName}{change.implicit ? " (auto)" : ""}</td>
                  <td>{change.repair ? "Repair" : "Patch"}</td>
                  <td>{formatPatchBoolean(actualPatchStates[change.modName])}</td>
                  <td>{formatPatchBoolean(change.enabled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="panel sidePanel">
          <div className="panelTitle titleWithHelp">
            <span>Actions</span>
            <HelpButton title="Actions">
              Actions write or verify game __data files. BD-SpineX locks mod checkboxes while an action is running to keep staged changes consistent.
            </HelpButton>
          </div>
          <div className={`modPowerPanel ${modPower.enabled ? "enabled" : "disabled"}`}>
            <div>
              <div className="modPowerLabel titleWithHelp">
                <span>Mod Power</span>
                <HelpButton title="Mod Power">
                  Turn Off All restores currently active mods and remembers them. Restore Saved applies that remembered set again.
                </HelpButton>
              </div>
              <div className="modPowerState">
                {modPower.enabled
                  ? `${activeModNames.length} active mod(s)`
                  : `${restorablePowerModNames.length} saved mod(s)`}
              </div>
            </div>
            <button
              disabled={busy || versionLocked || settingsLocked || (modPower.enabled && activeModNames.length > 0 && !plans.length)}
              onClick={() => runActionTask(toggleModPower)}
              type="button"
            >
              {modPower.enabled ? "Turn Off All" : "Restore Saved"}
            </button>
          </div>
          {versionLocked && (
            <p className="hint warning">Update BD-SpineX version.</p>
          )}
          {settingsLocked && (
            <p className="hint warning">{formatMissingSettingsMessage({ missingSharedDir, missingModsDir })}.</p>
          )}
          {previousHistoryPrompt && !versionLocked && !settingsLocked && (
            <div className="inheritHistoryPanel">
              <div>
                <div className="inheritHistoryTitle">{previousHistoryPrompt.message}</div>
                <div className="inheritHistoryText">
                  {previousHistoryPrompt.detail ?? `${previousHistoryPrompt.modNames.length} previously patched mod(s) were selected from old history.`}
                </div>
              </div>
              {previousHistoryPrompt.phase === "prompt" && (
                <div className="inheritHistoryActions">
                  <button disabled={busy} type="button" onClick={inheritPreviousPatchedMods}>Run Patch Check</button>
                </div>
              )}
            </div>
          )}
          {!modPower.enabled && (
            <p className="hint">Mod power is off. Module controls are locked until saved mods are restored.</p>
          )}
          <div className="backendStatus" title="Backend used by Apply Changes">
            <span>Patch Backend</span>
            <strong>{formatPatchBackend(settings.patchBackend)}</strong>
          </div>
          <button disabled={busy || versionLocked || settingsLocked || !modPower.enabled || !effectivePatchStateChanges.length || !plans.length} onClick={checkPatchBackendFit}>
            Check Backend Fit
          </button>
          <button disabled={busy || versionLocked || settingsLocked || !modPower.enabled || !activeModNames.length || !plans.length} onClick={() => runActionTask(checkActivePatchData)}>
            Check Active __data
          </button>
          <button disabled={busy || versionLocked || settingsLocked || !modPower.enabled || !effectivePatchStateChanges.length || !plans.length} onClick={() => runActionTask(async () => {
            const result = await window.bd2.applyPatchStateChanges(plans, modsIndex, effectivePatchStateChanges, {
              ...createApplyPatchOptions(settings)
            });
            setPatchHistory(result.history);
            setDesiredPatchStates(getActualPatchStates(modsIndex, result.history));
            setRepairPatchStates({});
            const patched = result.entries.filter((entry) => entry.status === "patched").length;
            const restored = result.entries.filter((entry) => entry.status === "restored").length;
            const failed = result.entries.filter((entry) => entry.status === "failed").length;
            const skipped = result.entries.filter((entry) => entry.status === "skipped").length;
            const changed = result.entries.filter((entry) => entry.status === "changed").length;
            log(`Apply changes finished: ${patched} patched, ${restored} restored, ${failed} failed, ${skipped} skipped, ${changed} changed.`);
            for (const entry of result.entries.filter((item) => item.status === "failed" || item.status === "skipped" || item.status === "changed").slice(0, 8)) {
              log(`${entry.modName} ${entry.bundleId}: ${entry.message ?? entry.status}`);
            }
          })}>
            Apply Changes
          </button>
          <HelpButton title="Apply Changes">
            Applies staged install/restore changes. BD-SpineX updates backup B first, stores per-asset backups, then copies the patched bundle back to the game only after the bundle succeeds.
          </HelpButton>
        </aside>
      </section>

      <section className="panel tablePanel historyPanel">
        <div className="panelTitle">Patch Status</div>
        <div className="historyTableFrame">
          <table>
            <thead>
              <tr>
                <th>__data / Mod</th>
                <th>Status</th>
                <th>Mods</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {patchStatusGroups.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">No patch operations recorded yet.</td>
                </tr>
              ) : patchStatusGroups.flatMap((group) => {
                const collapsed = Boolean(collapsedPatchBundles[group.bundleId]);
                return [
                  <tr key={group.bundleId} className="historyBundleRow">
                    <td title={group.bundlePath}>
                      <button
                        type="button"
                        className="historyTreeToggle"
                        aria-expanded={!collapsed}
                        onClick={() => togglePatchStatusBundle(group.bundleId)}
                      >
                        <span className="treeMarker">{collapsed ? "▸" : "▾"}</span>
                        <span>{group.bundleId}</span>
                      </button>
                    </td>
                    <td><span className={`badge ${group.status}`}>{formatPatchStatusLabel(group.status)}</span></td>
                    <td>{group.patchedModCount} patched / {group.entries.length} total</td>
                    <td>{formatDateTime(group.updatedAt)}</td>
                  </tr>,
                  ...(collapsed ? [] : group.entries.map((entry) => (
                    <tr key={`${group.bundleId}:${entry.id}`} className="historyModRow">
                      <td title={entry.message}>
                        <div className="historyTreeCell child">
                          <span className="treeBranch">└</span>
                          <span>{entry.modName}</span>
                        </div>
                      </td>
                      <td><span className={`badge ${entry.status}`}>{formatPatchStatusLabel(entry.status)}</span></td>
                      <td>{entry.name}</td>
                      <td>{formatDateTime(entry.updatedAt)}</td>
                    </tr>
                  )))
                ];
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel logPanel">
        <div className="panelTitle">Log</div>
        <div className="logStream" role="log" aria-live="polite">
          {logs.map((entry) => (
            <div key={entry.id} className="logLine">
              <span className="logTime">{entry.time}</span>
              <span className="logMessage">{renderLogMessage(entry)}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function formatVersionBadge(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const managerVersion = `v${appInfo.version}`;
  const gameVersion = gameVersionInfo?.version;
  const supportedGameVersion = appInfo.supportedGameVersion || appInfo.version;

  return gameVersion && normalizeVersionForCompare(gameVersion) !== normalizeVersionForCompare(supportedGameVersion)
    ? `${managerVersion} [${gameVersion}]`
    : managerVersion;
}

function formatVersionTitle(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const gameVersion = gameVersionInfo?.version;
  const supportedGameVersion = appInfo.supportedGameVersion || appInfo.version;
  const source = gameVersionInfo?.sourcePath ? `\nSource: ${gameVersionInfo.sourcePath}` : "";
  const managerLine = `Manager version: ${appInfo.version}`;
  const supportLine = supportedGameVersion !== appInfo.version ? `\nSupported game version: ${supportedGameVersion}` : "";

  return gameVersion && normalizeVersionForCompare(gameVersion) !== normalizeVersionForCompare(supportedGameVersion)
    ? `${managerLine}${supportLine}\nGame version: ${gameVersion}${source}`
    : `${managerLine}${supportLine}${gameVersion ? `\nGame version: ${gameVersion}${source}` : ""}`;
}

function isGameVersionMismatch(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  if (appInfo.development) {
    return false;
  }

  const gameVersion = normalizeVersionForCompare(gameVersionInfo?.version);
  const supportedGameVersion = normalizeVersionForCompare(appInfo.supportedGameVersion || appInfo.version);
  return Boolean(gameVersion && supportedGameVersion && gameVersion !== supportedGameVersion);
}

function normalizeVersionForCompare(version?: string) {
  return version?.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

function formatModsLockMessage(lock: {
  modsActionLocked: boolean;
  modPowerEnabled: boolean;
  versionLocked: boolean;
  missingSharedDir: boolean;
  missingModsDir: boolean;
  previousHistoryLocked: boolean;
  previousHistoryMessage?: string;
}) {
  if (lock.versionLocked) {
    return "Update BD-SpineX version";
  }

  const missingSettingsMessage = formatMissingSettingsMessage(lock);
  if (missingSettingsMessage) {
    return missingSettingsMessage;
  }

  if (lock.previousHistoryLocked) {
    return lock.previousHistoryMessage ?? "Detected version update. Run patch check?";
  }

  if (lock.modsActionLocked) {
    return "Action running";
  }

  return lock.modPowerEnabled ? "Locked" : "Mod Power off";
}

function formatMissingSettingsMessage(settings: { missingSharedDir: boolean; missingModsDir: boolean }) {
  if (settings.missingSharedDir && settings.missingModsDir) {
    return "Set Shared Folder and Mods Folder";
  }

  if (settings.missingSharedDir) {
    return "Set Shared Folder";
  }

  if (settings.missingModsDir) {
    return "Set Mods Folder";
  }

  return "";
}

function groupSharedErrors(errors: SharedIndex["bundles"]) {
  const groups = new Map<string, number>();

  for (const bundle of errors) {
    const message = compactError(bundle.scanError ?? "Unknown error");
    groups.set(message, (groups.get(message) ?? 0) + 1);
  }

  return [...groups.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function renderModSortButton(label: string, key: ModSortKey, sort: ModSort, onSort: (key: ModSortKey) => void) {
  const active = sort.key === key;
  const direction = active ? sort.direction : undefined;
  return (
    <button
      className={`sortButton ${active ? "active" : ""}`}
      type="button"
      onClick={() => onSort(key)}
    >
      <span>{label}</span>
      <span aria-hidden="true">{direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}</span>
    </button>
  );
}

function filterAndSortMods(
  mods: ModsIndex["mods"],
  filter: string,
  sort: ModSort,
  plansByModName: Map<string, PatchPlanEntry>,
  patchHistoryByModName: Map<string, PatchHistory["entries"]>
) {
  const normalizedFilter = filter.trim().toLowerCase();
  const filtered = normalizedFilter
    ? mods.filter((mod) => getModSearchText(mod, plansByModName, patchHistoryByModName).includes(normalizedFilter))
    : mods;

  return [...filtered].sort((a, b) => {
    const valueA = getModSortValue(a, sort.key, plansByModName, patchHistoryByModName);
    const valueB = getModSortValue(b, sort.key, plansByModName, patchHistoryByModName);
    const comparison = valueA.localeCompare(valueB, undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? comparison : -comparison;
  });
}

function getModSearchText(mod: ModsIndex["mods"][number], plansByModName: Map<string, PatchPlanEntry>, patchHistoryByModName: Map<string, PatchHistory["entries"]>) {
  return [
    mod.modName,
    mod.name,
    formatModCategory(classifyMod(mod)),
    getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))
  ].join(" ").toLowerCase();
}

function formatModFolderName(modName: string) {
  return modName.split(/[\\/]/).filter(Boolean).at(-1) ?? modName;
}

function getModSortValue(
  mod: ModsIndex["mods"][number],
  key: ModSortKey,
  plansByModName: Map<string, PatchPlanEntry>,
  patchHistoryByModName: Map<string, PatchHistory["entries"]>
) {
  if (key === "name") {
    return mod.name;
  }

  if (key === "category") {
    return formatModCategory(classifyMod(mod));
  }

  if (key === "status") {
    return getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName));
  }

  return mod.modName;
}

function countReadyMods(plans: PatchPlanEntry[]) {
  return new Set(plans.filter((plan) => plan.status === "ready").map((plan) => plan.modName)).size;
}

function formatPatchPlanSummary(plans: PatchPlanEntry[]) {
  const readyTargets = plans.filter((plan) => plan.status === "ready").length;
  return `Generated patch plan: ${countReadyMods(plans)} ready mod(s), ${readyTargets} ready __data target(s), ${plans.length} plan item(s).`;
}

function getPatchBackendFit(plan: PatchPlanEntry, repair = false): PatchBackendFit {
  if (repair) {
    return {
      modName: plan.modName,
      bundleId: plan.bundleId ?? "unknown __data",
      backend: "unitypy",
      reason: "Repair mode forces the safe UnityPy backend regardless of the selected backend."
    };
  }

  const textures = plan.targets.textures ?? [];
  const astcTextures = textures.filter(isAstcTextureTarget);

  if (astcTextures.length > 0) {
    return {
      modName: plan.modName,
      bundleId: plan.bundleId ?? "unknown __data",
      backend: "uabea-safe",
      reason: `${astcTextures.length} ASTC Texture2D target(s) detected. UABEA Safe keeps the iOS texture format and verifies the written bundle.`
    };
  }

  if (textures.length > 0) {
    return {
      modName: plan.modName,
      bundleId: plan.bundleId ?? "unknown __data",
      backend: "uabea-safe",
      reason: `${textures.length} Texture2D target(s) detected. UABEA Safe uses conservative C# texture patching before falling back to manual troubleshooting.`
    };
  }

  return {
    modName: plan.modName,
    bundleId: plan.bundleId ?? "unknown __data",
    backend: "uabea",
    reason: "TextAsset-only patch. Original UABEA is the fastest suitable backend."
  };
}

function isAstcTextureTarget(target: NonNullable<PatchPlanEntry["targets"]["textures"]>[number]) {
  return target.textureFormatName?.toLowerCase().includes("astc") ?? false;
}

function countBackendFits(fits: PatchBackendFit[]) {
  return fits.reduce<Record<string, number>>((counts, fit) => ({
    ...counts,
    [fit.backend]: (counts[fit.backend] ?? 0) + 1
  }), {});
}

function formatBackendFitCounts(counts: Record<string, number>) {
  const parts = Object.entries(counts).map(([backend, count]) => `${formatPatchBackend(backend as PatchBackend)} ${count}`);
  return parts.length ? parts.join(", ") : "none";
}

async function loadSavedSettings(): Promise<Settings> {
  const defaults = await window.bd2.getDefaultPaths().catch(() => ({ modsDir: "mods", sharedDir: "", dotnetPath: "manager-data/tools/dotnet/dotnet" }));
  const fallback: Settings = {
    ...emptySettings,
    modsDir: defaults.modsDir,
    sharedDir: defaults.sharedDir,
    dotnetPath: defaults.dotnetPath
  };

  try {
    const stored = await readStoredSettings();
    if (!stored) {
      return fallback;
    }

    return normalizeManagedToolSettings({
      ...fallback,
      ...migrateStoredSettings(stored)
    }, fallback);
  } catch {
    return fallback;
  }
}

async function readStoredSettings(): Promise<Partial<Settings> | null> {
  const persisted = await window.bd2.readSettings().catch(() => null);
  if (isStoredSettings(persisted)) {
    return persisted;
  }

  const browserStored = window.localStorage.getItem(settingsStorageKey) ?? window.localStorage.getItem(legacySettingsStorageKey);
  if (!browserStored) {
    return null;
  }

  const parsed = JSON.parse(browserStored) as unknown;
  return isStoredSettings(parsed) ? parsed : null;
}

function isStoredSettings(value: unknown): value is Partial<Settings> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeManagedToolSettings(settings: Settings, fallback: Settings): Settings {
  return {
    ...settings,
    patchBackend: normalizeSelectablePatchBackend(settings.patchBackend),
    scanBackend: normalizeSelectableScanBackend(settings.scanBackend),
    dotnetPath: fallback.dotnetPath
  };
}

function migrateStoredSettings(stored: Partial<Settings>): Partial<Settings> {
  if (stored.settingsVersion === emptySettings.settingsVersion) {
    return stored;
  }

  return {
    ...stored,
    settingsVersion: emptySettings.settingsVersion,
    patchBackend: "auto"
  };
}

function normalizeSelectablePatchBackend(backend: PatchBackend): PatchBackend {
  return backend === "uabea" || backend === "uabea-safe" || backend === "unitypy" || backend === "auto" || backend === "auto-backend" ? backend : "auto";
}

function normalizeSelectableScanBackend(backend: SharedScanBackend): SharedScanBackend {
  return backend === "unitypy" ? "unitypy" : "uabea";
}

function loadModPowerState(): ModPowerState {
  try {
    const stored = window.localStorage.getItem(modPowerStorageKey) ?? window.localStorage.getItem(legacyModPowerStorageKey);
    if (!stored) {
      return defaultModPowerState;
    }

    const parsed = JSON.parse(stored) as Partial<ModPowerState>;
    return {
      enabled: parsed.enabled ?? true,
      restoreModNames: Array.isArray(parsed.restoreModNames)
        ? parsed.restoreModNames.filter((name): name is string => typeof name === "string")
        : []
    };
  } catch {
    return defaultModPowerState;
  }
}

function createApplyPatchOptions(settings: Settings): ApplyPatchOptions {
  return {
    patchBackend: settings.patchBackend,
    dotnetPath: settings.dotnetPath,
    converterPath: settings.converterPath,
    unityVersion: settings.unityVersion,
    decryptKey: settings.decryptKey
  };
}

function getModTargetNames(modsIndex: ModsIndex) {
  const names = new Set<string>();

  for (const mod of modsIndex.mods) {
    names.add(mod.name);
    for (const file of mod.files?.json ?? []) {
      names.add(file.baseName);
    }
    for (const file of mod.files?.skel ?? []) {
      names.add(file.baseName);
    }
    for (const file of mod.files?.atlas ?? []) {
      names.add(file.baseName);
    }
    for (const file of mod.files?.png ?? []) {
      names.add(file.baseName);
    }
  }

  return [...names].filter(Boolean);
}

function filterSharedAssetsByTargets<T extends BundleAsset & { name: string }>(assets: T[], targetNames: string[]) {
  const targets = new Set(targetNames.map((name) => name.toLowerCase()));
  if (!targets.size) {
    return [];
  }

  return assets.filter((asset) => targets.has(getSharedAssetBaseName(asset.name).toLowerCase()));
}

function groupPatchHistoryByModName(history: PatchHistory) {
  const groups = new Map<string, PatchHistory["entries"]>();

  for (const entry of history.entries) {
    groups.set(entry.modName, [...(groups.get(entry.modName) ?? []), entry]);
  }

  return groups;
}

function groupPatchPlansByModName(plans: PatchPlanEntry[]) {
  const groups = new Map<string, PatchPlanEntry[]>();

  for (const plan of plans) {
    groups.set(plan.modName, [...(groups.get(plan.modName) ?? []), plan]);
  }

  return groups;
}

function getPatchStatusBundleGroups(history: PatchHistory): PatchStatusBundleGroup[] {
  const groups = new Map<string, PatchHistory["entries"]>();

  for (const entry of history.entries) {
    if (!entry.bundleId) {
      continue;
    }

    groups.set(entry.bundleId, [...(groups.get(entry.bundleId) ?? []), entry]);
  }

  return [...groups.entries()]
    .filter(([, entries]) => entries.some((entry) => entry.status === "patched"))
    .map(([bundleId, entries]) => {
      const latestEntries = getLatestHistoryEntriesById(entries).sort((a, b) =>
        a.modName.localeCompare(b.modName) || b.updatedAt.localeCompare(a.updatedAt)
      );
      const newestEntry = [...latestEntries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

      return {
        bundleId,
        bundlePath: newestEntry?.bundlePath ?? "",
        status: getHistoryDisplayStatus(entries) ?? "ready",
        updatedAt: newestEntry?.updatedAt ?? "",
        patchedModCount: latestEntries.filter((entry) => entry.status === "patched").length,
        entries: latestEntries
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.bundleId.localeCompare(b.bundleId));
}

function getActualPatchStates(modsIndex: ModsIndex, history: PatchHistory) {
  const historyByModName = groupPatchHistoryByModName(history);
  const states: Record<string, boolean> = {};

  for (const mod of modsIndex.mods) {
    states[mod.modName] = getHistoryDisplayStatus(historyByModName.get(mod.modName)) === "patched";
  }

  return states;
}

function hasCurrentVersionPatchActivity(history: PatchHistory) {
  const activityStatuses = new Set(["patched", "restored", "failed", "changed"]);
  return history.entries.some((entry) => activityStatuses.has(entry.status));
}

function getDesiredPatchState(modName: string, actualStates: Record<string, boolean>, desiredStates: Record<string, boolean>) {
  return desiredStates[modName] ?? actualStates[modName] ?? false;
}

function isPatchStateDirty(modName: string, actualStates: Record<string, boolean>, desiredStates: Record<string, boolean>) {
  return getDesiredPatchState(modName, actualStates, desiredStates) !== (actualStates[modName] ?? false);
}

function getPatchStateChanges(modsIndex: ModsIndex, actualStates: Record<string, boolean>, desiredStates: Record<string, boolean>): PatchStateChange[] {
  return modsIndex.mods
    .filter((mod) => isPatchStateDirty(mod.modName, actualStates, desiredStates))
    .map((mod) => ({
      modName: mod.modName,
      enabled: getDesiredPatchState(mod.modName, actualStates, desiredStates)
    }));
}

function getPendingChangeRows(
  changes: PatchStateChange[],
  repairStates: Record<string, boolean>,
  actualStates: Record<string, boolean>,
  plansByModName: Map<string, PatchPlanEntry[]>
): PendingChangeRow[] {
  const repairModNames = new Set(Object.entries(repairStates).filter(([, enabled]) => enabled).map(([modName]) => modName));
  const rows: PendingChangeRow[] = changes.map((change) =>
    repairModNames.has(change.modName)
      ? { ...change, enabled: true, repair: true }
      : change
  );
  const rowModNames = new Set(rows.map((change) => change.modName));

  for (const modName of repairModNames) {
    if (!rowModNames.has(modName) && hasReadyPatchPlan(plansByModName.get(modName))) {
      rows.push({ modName, enabled: true, repair: true });
      rowModNames.add(modName);
    }
  }

  const addedTargetKeys = new Set(
    rows
      .filter((change) => change.enabled)
      .flatMap((change) => {
        return getPlanAssetKeysForMod(plansByModName, change.modName);
      })
  );

  if (!addedTargetKeys.size) {
    return rows;
  }

  for (const [modName, enabled] of Object.entries(actualStates)) {
    if (!enabled || rowModNames.has(modName)) {
      continue;
    }

    const plan = plansByModName.get(modName);
    if (!plan?.length) {
      continue;
    }

    if (getPlanAssetKeysForMod(plansByModName, modName).some((key) => addedTargetKeys.has(key))) {
      rows.push({ modName, enabled: false, implicit: true });
      rowModNames.add(modName);
    }
  }

  return rows;
}

function getPendingChangeTones(changes: PendingChangeRow[], plansByModName: Map<string, PatchPlanEntry[]>): Record<string, PendingChangeTone> {
  const addChanges = changes.filter((change) => change.enabled);
  const removeChanges = changes.filter((change) => !change.enabled);
  const tones: Record<string, PendingChangeTone> = {};

  for (const repairChange of changes.filter((change) => change.repair)) {
    tones[repairChange.modName] = "repair";
  }

  for (const addChange of addChanges) {
    tones[addChange.modName] = tones[addChange.modName] ?? "added";
  }

  for (const removeChange of removeChanges) {
    tones[removeChange.modName] = tones[removeChange.modName] ?? "removed";
  }

  for (const addChange of addChanges) {
    const addKeys = new Set(getPlanAssetKeysForMod(plansByModName, addChange.modName));
    if (!addKeys.size) {
      continue;
    }

    for (const removeChange of removeChanges) {
      const removeKeys = getPlanAssetKeysForMod(plansByModName, removeChange.modName);
      if (!removeKeys.length) {
        continue;
      }

      if (removeKeys.some((key) => addKeys.has(key))) {
        tones[addChange.modName] = tones[addChange.modName] ?? "added";
        tones[removeChange.modName] = tones[removeChange.modName] ?? "removed";
      }
    }
  }

  return tones;
}

function hasReadyPatchPlan(plans?: PatchPlanEntry[]) {
  return plans?.some((plan) => plan.status === "ready") ?? false;
}

function getPlanAssetKeysForMod(plansByModName: Map<string, PatchPlanEntry[]>, modName: string) {
  return [...new Set((plansByModName.get(modName) ?? []).flatMap(getPlanAssetKeys))];
}

function getPlanAssetKeys(plan: PatchPlanEntry) {
  const bundleId = plan.bundleId ?? "";
  return getPlanAssetNames(plan).map((assetName) => `${bundleId}:${assetName.toLowerCase()}`);
}

function getPlanAssetNames(plan: PatchPlanEntry) {
  const assetNames = new Set<string>();
  const rawTargets: Array<{ assetName: string } | undefined> = [
    plan.targets.atlas,
    plan.targets.skel,
    plan.targets.texture,
    ...(plan.targets.atlases ?? []),
    ...(plan.targets.skels ?? []),
    ...(plan.targets.textures ?? [])
  ];

  for (const target of rawTargets) {
    if (target) {
      assetNames.add(target.assetName);
    }
  }

  return [...assetNames].filter(Boolean);
}

function formatPendingChangeToneClass(tone?: PendingChangeTone) {
  if (tone === "added") {
    return "pendingPatchAdd";
  }

  if (tone === "removed") {
    return "pendingPatchRemove";
  }

  if (tone === "repair") {
    return "pendingPatchRepair";
  }

  return "";
}

function formatModFilesCell(files: Array<{ file: string }> | undefined, fallback?: string) {
  if (!files?.length) {
    return fallback ?? "-";
  }

  if (files.length === 1) {
    return files[0].file;
  }

  return `${files.length} files`;
}

function formatModFilesTitle(files: Array<{ file: string; path?: string }> | undefined, fallback?: string) {
  if (!files?.length) {
    return fallback ?? "";
  }

  return files.map((file) => file.path ?? file.file).join("\n");
}

function formatSkeletonFilesCell(mod: { files?: { skel?: Array<{ file: string }>; json?: Array<{ file: string }> }; skelFile?: string; jsonFile?: string }) {
  const files = [...(mod.files?.skel ?? []), ...(mod.files?.json ?? [])];
  return formatModFilesCell(files, mod.skelFile ?? mod.jsonFile);
}

function formatSkeletonFilesTitle(mod: { files?: { skel?: Array<{ file: string; path?: string }>; json?: Array<{ file: string; path?: string }> }; skelPath?: string; jsonPath?: string }) {
  const files = [...(mod.files?.skel ?? []), ...(mod.files?.json ?? [])];
  return formatModFilesTitle(files, mod.skelPath ?? mod.jsonPath);
}

function formatPatchTargetCount(targets?: Array<{ assetName: string }>, legacyTarget?: { assetName: string }) {
  const count = targets?.length ?? (legacyTarget ? 1 : 0);
  return count ? String(count) : "0";
}

function formatPatchTargets(targets?: Array<{ assetName: string }>, legacyTarget?: { assetName: string }) {
  const names = targets?.length ? targets.map((target) => target.assetName) : legacyTarget ? [legacyTarget.assetName] : [];
  return names.length ? names.join("\n") : "No matching asset";
}

function formatPatchBoolean(value?: boolean) {
  return value ? "patched" : "not patched";
}

function formatMissingTargets(plan: PatchPlanEntry) {
  if (!plan.missingTargets?.length) {
    return plan.status;
  }

  return plan.missingTargets
    .map((target) => `${target.sourceFile} -> ${target.assetName}`)
    .join("\n");
}

function getModDisplayStatus(fileStatus: string, plan?: PatchPlanEntry, historyEntries?: PatchHistory["entries"]) {
  const historyStatus = getHistoryDisplayStatus(historyEntries);
  if (historyStatus === "changed" || historyStatus === "failed" || historyStatus === "patched") {
    return historyStatus;
  }

  return plan?.status ?? historyStatus ?? fileStatus;
}

function formatModPatchStatusTitle(plan?: PatchPlanEntry, historyEntries?: PatchHistory["entries"]) {
  if (plan) {
    return formatMissingTargets(plan);
  }

  if (historyEntries?.length) {
    return historyEntries
      .slice(0, 6)
      .map((entry) => `${entry.bundleId}: ${entry.status}${entry.message ? ` - ${entry.message}` : ""}`)
      .join("\n");
  }

  return "File completeness status. Generate a patch plan to verify Shared __data targets.";
}

function getHistoryDisplayStatus(historyEntries?: PatchHistory["entries"]) {
  if (!historyEntries?.length) {
    return undefined;
  }

  const latestEntries = getLatestHistoryEntriesById(historyEntries);

  if (latestEntries.some((entry) => entry.status === "changed")) {
    return "changed";
  }

  if (latestEntries.some((entry) => entry.status === "failed")) {
    return "failed";
  }

  if (latestEntries.some((entry) => entry.status === "patched")) {
    return "patched";
  }

  if (latestEntries.every((entry) => entry.status === "restored")) {
    return "restored";
  }

  if (latestEntries.some((entry) => entry.status === "skipped")) {
    return "skipped";
  }

  return latestEntries[0].status;
}

function getLatestHistoryEntriesById(historyEntries: PatchHistory["entries"]) {
  const latestById = new Map<string, PatchHistory["entries"][number]>();
  const sortedEntries = [...historyEntries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const entry of sortedEntries) {
    if (!latestById.has(entry.id)) {
      latestById.set(entry.id, entry);
    }
  }

  return [...latestById.values()];
}

function formatPatchStatusLabel(status: string) {
  const labels: Record<string, string> = {
    changed: "changed",
    patched: "Patched",
    ready: "Ready"
  };

  return labels[status] ?? status;
}

function classifyMod(mod: ModsIndex["mods"][number]): ModCategory {
  const normalized = [
    mod.modName,
    mod.name,
    ...mod.files.json.map((file) => file.baseName),
    ...mod.files.skel.map((file) => file.baseName),
    ...mod.files.atlas.map((file) => file.baseName),
    ...mod.files.png.map((file) => file.baseName)
  ].join(" ").toLowerCase();

  if (/\bcutscene[_-]?char|\bcutscene/.test(normalized)) {
    return "cutscene";
  }

  if (/\billust[_-]?dating|\bdating/.test(normalized)) {
    return "dating";
  }

  if (/\bchar\d+|\bchar[_-]/.test(normalized)) {
    return "char";
  }

  return "other";
}

function formatModCategory(category: ModCategory) {
  return category;
}

function summarizeSharedAssets(assets: Array<BundleAsset & { category: SharedAssetCategory }>) {
  const categories: Array<{ category: SharedAssetCategory; label: string }> = [
    { category: "all", label: "All" },
    { category: "char", label: "charXXXX" },
    { category: "cutscene_char", label: "cutscene_char" },
    { category: "illust_dating", label: "illust_dating" },
    { category: "other", label: "Other" }
  ];

  return categories.map(({ category, label }) => {
    const categoryAssets = category === "all"
      ? assets
      : assets.filter((asset) => asset.category === category);

    return {
      category,
      label,
      count: categoryAssets.length,
      uniqueBaseCount: new Set(categoryAssets.map((asset) => getSharedAssetBaseName(asset.name))).size
    };
  });
}

function classifySharedAsset(name: string): Exclude<SharedAssetCategory, "all"> {
  const normalized = name.toLowerCase();

  if (/^cutscene_char\d+/.test(normalized)) {
    return "cutscene_char";
  }

  if (/^char\d+/.test(normalized)) {
    return "char";
  }

  if (/^illust_dating/.test(normalized)) {
    return "illust_dating";
  }

  return "other";
}

function formatSharedAssetCategory(category: SharedAssetCategory) {
  if (category === "char") {
    return "charXXXX";
  }

  if (category === "all") {
    return "all";
  }

  return category;
}

function getSharedAssetBaseName(name: string) {
  return name.replace(/\.(atlas|skel)$/i, "");
}

function compactError(error: string) {
  return error
    .replace(/\s+/g, " ")
    .replace(/^Error:\s*/, "")
    .slice(0, 180);
}

function pushLog(setLogs: Dispatch<SetStateAction<LogEntry[]>>, input: LogInput) {
  setLogs((current) => [createLogEntry(input), ...current].slice(0, 200));
}

function createLogEntry(input: LogInput): LogEntry {
  const payload = typeof input === "string" ? { message: input } : input;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: new Date().toLocaleTimeString(),
    message: payload.message,
    accents: payload.accents?.filter((accent) => accent.text.trim())
  };
}

function renderLogMessage(entry: LogEntry) {
  if (!entry.accents?.length) {
    return entry.message;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  const accents = [...entry.accents].sort((a, b) => b.text.length - a.text.length);

  while (cursor < entry.message.length) {
    const match = findNextLogAccent(entry.message, accents, cursor);
    if (!match) {
      nodes.push(entry.message.slice(cursor));
      break;
    }

    if (match.index > cursor) {
      nodes.push(entry.message.slice(cursor, match.index));
    }

    nodes.push(
      <span key={`${match.index}-${match.accent.text}`} className={`logAccent ${match.accent.tone}`}>
        {entry.message.slice(match.index, match.index + match.accent.text.length)}
      </span>
    );
    cursor = match.index + match.accent.text.length;
  }

  return nodes;
}

function findNextLogAccent(message: string, accents: LogAccent[], cursor: number) {
  let next: { accent: LogAccent; index: number } | undefined;

  for (const accent of accents) {
    const index = message.indexOf(accent.text, cursor);
    if (index === -1) {
      continue;
    }

    if (!next || index < next.index || (index === next.index && accent.text.length > next.accent.text.length)) {
      next = { accent, index };
    }
  }

  return next;
}

function formatSharedProgress(progress: SharedScanProgress) {
  if (progress.phase === "discovering") {
    return "Finding Shared/hash1/hash2/__data files...";
  }

  if (progress.phase === "found") {
    const discovered = progress.discoveredTotal ?? progress.total;
    const targetText = progress.targetTotal
      ? ` Targets found ${progress.targetFound ?? 0}/${progress.targetTotal}.`
      : "";
    return `Indexed ${discovered} bundle(s). ${progress.total} unscanned bundle(s) remain.${targetText}`;
  }

  if (progress.phase === "scanning") {
    const targetText = progress.targetTotal
      ? ` Targets ${progress.targetFound ?? 0}/${progress.targetTotal}.`
      : "";
    return `Scanning ${progress.bundleId ?? "bundle"} (${formatBytes(progress.sizeBytes)}).${targetText}`;
  }

  if (progress.phase === "scanned") {
    if (progress.error) {
      return `${progress.bundleId ?? "Bundle"} failed: ${progress.error}`;
    }

    const targetText = progress.targetTotal
      ? ` Targets ${progress.targetFound ?? 0}/${progress.targetTotal}.`
      : "";
    return `${progress.bundleId ?? "Bundle"} scanned, ${progress.assetCount ?? 0} candidate asset(s), ${formatBytes(progress.sizeBytes)}.${targetText}`;
  }

  if (progress.phase === "stopped") {
    const targetText = progress.targetTotal
      ? ` Targets ${progress.targetFound ?? 0}/${progress.targetTotal}.`
      : "";
    return `Stopped after scanning ${progress.current} bundle(s).${targetText}`;
  }

  const discovered = progress.discoveredTotal ?? progress.total;
  const targetText = progress.targetTotal
    ? ` Targets ${progress.targetFound ?? 0}/${progress.targetTotal}.`
    : "";
  return `Done scanning ${progress.current} bundle(s), ${progress.total} unscanned candidate(s) considered from ${discovered} indexed bundle(s).${targetText}`;
}

function isSharedScanComplete(progress: SharedScanProgress) {
  return progress.phase === "done";
}

function getSharedProgressValue(progress: SharedScanProgress) {
  if (isSharedScanComplete(progress)) {
    return 1;
  }

  return progress.total ? progress.current : undefined;
}

function getSharedProgressMax(progress: SharedScanProgress) {
  if (isSharedScanComplete(progress)) {
    return 1;
  }

  return progress.total || undefined;
}

function formatSharedProgressCounter(progress: SharedScanProgress) {
  if (isSharedScanComplete(progress)) {
    return "Complete";
  }

  return progress.total ? `${progress.current}/${progress.total}` : "...";
}

function isPatchProgressComplete(progress: PatchProgress) {
  return progress.phase === "done";
}

function getPatchProgressValue(progress: PatchProgress) {
  if (progress.phase === "done") {
    return 1;
  }

  return progress.total ? progress.current : undefined;
}

function getPatchProgressMax(progress: PatchProgress) {
  if (progress.phase === "done") {
    return 1;
  }

  return progress.total || undefined;
}

function formatPatchProgressCounter(progress: PatchProgress) {
  if (progress.phase === "done") {
    return "Complete";
  }

  if (progress.phase === "failed") {
    return "Failed";
  }

  return progress.total ? `${progress.current}/${progress.total}` : "...";
}

function formatPatchProgress(progress: PatchProgress) {
  const target = [progress.modName, progress.bundleId].filter(Boolean).join(" / ");
  const backend = progress.backend ? `${formatPatchBackend(progress.backend)}: ` : "";
  return target ? `${backend}${progress.message} (${target})` : `${backend}${progress.message}`;
}

function formatPatchProgressLog(progress: PatchProgress): LogInput {
  const action = formatPatchAction(progress.phase);
  const backend = progress.backend ? ` via ${formatPatchBackend(progress.backend)}` : "";
  const module = progress.modName ? ` module ${progress.modName}` : "";
  const bundle = progress.bundleId ? ` bundle ${progress.bundleId}` : "";
  const timing = progress.timing ? ` [${progress.timing.name}: ${formatDuration(progress.timing.ms)}]` : "";
  const accents: LogAccent[] = [{ text: action, tone: "action" }];

  if (progress.modName) {
    accents.push({ text: progress.modName, tone: "module" });
  }

  if (progress.bundleId) {
    accents.push({ text: progress.bundleId, tone: "bundle" });
  }

  if (progress.phase === "failed") {
    accents.push({ text: progress.message, tone: "error" });
  }

  return {
    message: `Patch ${progress.current}/${progress.total}: ${action}${module}${bundle}${backend}. ${progress.message}${timing}`,
    accents
  };
}

function formatPatchAction(phase: PatchProgress["phase"]) {
  const labels: Record<PatchProgress["phase"], string> = {
    starting: "Starting",
    converting: "Converting",
    preparing_backup: "Preparing backup",
    patching: "Patching",
    copying: "Copying to game",
    restoring: "Restoring",
    done: "Finished",
    failed: "Failed"
  };

  return labels[phase];
}

function formatPatchBackend(backend: PatchBackend) {
  if (backend === "auto-backend") {
    return "Auto Backend";
  }

  if (backend === "auto") {
    return "Force ASTC";
  }

  if (backend === "rust-native") {
    return "Rust";
  }

  if (backend === "unitypy") {
    return "UnityPy";
  }

  if (backend === "uabea-astc") {
    return "UABEA ASTC";
  }

  if (backend === "uabea-safe") {
    return "UABEA Safe";
  }

  return "UABEA";
}

function formatDuration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function parseScanLimit(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatBytes(value?: number) {
  if (!value) {
    return "unknown size";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatAssetSize(asset: BundleAsset) {
  if (asset.type !== "Texture2D") {
    return "-";
  }

  if (!asset.width || !asset.height) {
    return "unknown";
  }

  return `${asset.width}x${asset.height}`;
}

function formatDateTime(value: string) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function PathField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse?: () => void;
  type?: "text" | "password";
  invalid?: boolean;
  helpTitle?: string;
  helpText?: string;
  helpContent?: ReactNode;
}) {
  const helpContent = props.helpContent ?? props.helpText;

  return (
    <label className={`field ${props.invalid ? "invalid" : ""}`}>
      <span className="fieldLabel">
        <span>{props.label}</span>
        {props.helpTitle && helpContent && (
          <HelpButton title={props.helpTitle}>{helpContent}</HelpButton>
        )}
      </span>
      <div className="pathRow">
        <input type={props.type ?? "text"} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
        {props.onBrowse && <button type="button" onClick={props.onBrowse}>Browse</button>}
      </div>
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  helpTitle?: string;
  helpText?: string;
}) {
  return (
    <label className="field">
      <span className="fieldLabel">
        <span>{props.label}</span>
        {props.helpTitle && props.helpText && (
          <HelpButton title={props.helpTitle}>{props.helpText}</HelpButton>
        )}
      </span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function HelpButton(props: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState({ left: 0, placement: "below" as "below" | "above" });
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popupRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function updatePopupPosition() {
      const root = rootRef.current;
      const popup = popupRef.current;
      if (!root || !popup) {
        return;
      }

      const margin = 16;
      const rootRect = root.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const desiredViewportLeft = rootRect.left + rootRect.width / 2 - popupRect.width / 2;
      const maxViewportLeft = Math.max(margin, window.innerWidth - popupRect.width - margin);
      const clampedViewportLeft = Math.min(Math.max(desiredViewportLeft, margin), maxViewportLeft);
      const hasBelowSpace = rootRect.bottom + 8 + popupRect.height <= window.innerHeight - margin;
      const hasAboveSpace = rootRect.top - 8 - popupRect.height >= margin;

      setPopupPosition({
        left: clampedViewportLeft - rootRect.left,
        placement: !hasBelowSpace && hasAboveSpace ? "above" : "below"
      });
    }

    updatePopupPosition();
    window.addEventListener("resize", updatePopupPosition);
    window.addEventListener("scroll", updatePopupPosition, true);

    return () => {
      window.removeEventListener("resize", updatePopupPosition);
      window.removeEventListener("scroll", updatePopupPosition, true);
    };
  }, [open]);

  return (
    <span className="helpRoot" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label={`About ${props.title}`}
        className="helpButton"
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        ?
      </button>
      {open && (
        <span
          className={`helpPopup ${popupPosition.placement === "above" ? "above" : "below"}`}
          ref={popupRef}
          role="dialog"
          aria-label={props.title}
          style={{ left: `${popupPosition.left}px` }}
        >
          <span className="helpPopupTitle">{props.title}</span>
          <div className="helpPopupText">{props.children}</div>
          <button
            aria-label="Close help"
            className="helpCloseButton"
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }}
          >
            Close
          </button>
        </span>
      )}
    </span>
  );
}
