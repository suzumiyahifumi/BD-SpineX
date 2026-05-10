import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { BundleAsset, ModsIndex, PatchHistory, PatchPlanEntry, PatchProgress, PatchStateChange, SharedIndex, SharedScanProgress } from "../../../core/types";

type Settings = {
  sharedDir: string;
  modsDir: string;
  converterPath: string;
  pythonPath: string;
  unityVersion: string;
  decryptKey: string;
  scanLimit: string;
};

type SharedAssetCategory = "all" | "char" | "cutscene_char" | "illust_dating" | "other";

const emptySettings: Settings = {
  sharedDir: "",
  modsDir: "",
  converterPath: "",
  pythonPath: ".venv/bin/python",
  unityVersion: "2021.3.33f1",
  decryptKey: "",
  scanLimit: "10"
};
const settingsStorageKey = "bd2-spine-mod-manager:settings";

export function App() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [modsIndex, setModsIndex] = useState<ModsIndex>({ mods: [] });
  const [sharedIndex, setSharedIndex] = useState<SharedIndex>({ bundles: [] });
  const [plans, setPlans] = useState<PatchPlanEntry[]>([]);
  const [patchHistory, setPatchHistory] = useState<PatchHistory>({ updatedAt: "", entries: [] });
  const [desiredPatchStates, setDesiredPatchStates] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<string[]>(["Ready."]);
  const [busy, setBusy] = useState(false);
  const [sharedProgress, setSharedProgress] = useState<SharedScanProgress | null>(null);
  const [patchProgress, setPatchProgress] = useState<PatchProgress | null>(null);
  const [sharedAssetCategory, setSharedAssetCategory] = useState<SharedAssetCategory>("all");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);

  const readyCount = useMemo(() => plans.filter((plan) => plan.status === "ready").length, [plans]);
  const plansByModName = useMemo(() => new Map(plans.map((plan) => [plan.modName, plan])), [plans]);
  const patchHistoryByModName = useMemo(() => groupPatchHistoryByModName(patchHistory), [patchHistory]);
  const actualPatchStates = useMemo(() => getActualPatchStates(modsIndex, patchHistory), [modsIndex, patchHistory]);
  const patchStateChanges = useMemo(() => getPatchStateChanges(modsIndex, actualPatchStates, desiredPatchStates), [modsIndex, actualPatchStates, desiredPatchStates]);
  const modTargetNames = useMemo(() => getModTargetNames(modsIndex), [modsIndex]);
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
    void window.bd2.readPatchHistory().then(setPatchHistory).catch(() => undefined);
    void loadSavedSettings().then((loadedSettings) => {
      setSettings(loadedSettings);
      setSettingsLoaded(true);
      void runTask(async () => {
        await scanModsWorkflow(loadedSettings);
      });
    });
    const unsubscribeShared = window.bd2.onSharedScanProgress((progress) => {
      setSharedProgress(progress);
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
      pushLog(setLogs, `Patch ${progress.current}/${progress.total} ${progress.message}`);
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
  }, [settings, settingsLoaded]);

  function updateSetting(key: keyof Settings, value: string) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function log(message: string) {
    setLogs((current) => [`${new Date().toLocaleTimeString()} ${message}`, ...current].slice(0, 200));
  }

  async function selectDirectory(key: "sharedDir" | "modsDir") {
    const selected = await window.bd2.selectDirectory();
    if (selected) {
      updateSetting(key, selected);
      log(`Selected ${key}: ${selected}`);
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
    setDesiredPatchStates(getActualPatchStates(index, history));
    log(`Scanned Mods: ${index.mods.length} mod folder(s), ${index.mods.filter((mod) => mod.status === "ready").length} ready.`);

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

    setSharedIndex({ bundles: [] });
    setPlans([]);
    setSharedProgress({ phase: "discovering", current: 0, total: 0 });
    const nextSharedIndex = await window.bd2.scanShared(activeSettings.sharedDir, {
      pythonPath: activeSettings.pythonPath,
      unityVersion: activeSettings.unityVersion,
      decryptKey: activeSettings.decryptKey,
      scanLimit: parseScanLimit(activeSettings.scanLimit),
      targetNames
    });
    setSharedIndex(nextSharedIndex);
    const assetCount = nextSharedIndex.bundles.reduce((sum, bundle) => sum + bundle.assets.length, 0);
    const errorCount = nextSharedIndex.bundles.filter((bundle) => bundle.scanError).length;
    log(`Scanned Shared for Mods: ${nextSharedIndex.bundles.length} bundle(s), ${assetCount} candidate asset(s), ${errorCount} scan error(s).`);
    for (const bundle of nextSharedIndex.bundles.filter((item) => item.scanError).slice(0, 5)) {
      log(`${bundle.bundleId}: ${bundle.scanError}`);
    }

    const planIndex = await window.bd2.createPatchPlan(nextSharedIndex, index);
    setPlans(planIndex.plans);
    log(`Generated patch plan: ${planIndex.plans.length} item(s).`);
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
      log(`Scanned Mods first: ${currentModsIndex.mods.length} mod folder(s), ${currentModsIndex.mods.filter((mod) => mod.status === "ready").length} ready.`);
    }
    const index = await window.bd2.scanShared(activeSettings.sharedDir, {
      pythonPath: activeSettings.pythonPath,
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
    setDesiredPatchStates((current) => ({
      ...current,
      [modName]: enabled
    }));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>BD2 Spine Mod Manager</h1>
          <p>Brown Dust 2 / PlayCover Spine module workflow</p>
        </div>
        <div className="statusPill">{readyCount} ready</div>
      </header>

      <section className="panel settingsGrid">
        <PathField
          label="Shared Folder"
          value={settings.sharedDir}
          onChange={(value) => updateSetting("sharedDir", value)}
          onBrowse={() => selectDirectory("sharedDir")}
        />
        <PathField
          label="Mods Folder"
          value={settings.modsDir}
          onChange={(value) => updateSetting("modsDir", value)}
          onBrowse={() => selectDirectory("modsDir")}
        />
        <div className="settingsActions">
          <button type="button" onClick={() => setShowAdvancedSettings((current) => !current)}>
            {showAdvancedSettings ? "Hide Advanced Settings" : "Advanced Settings"}
          </button>
        </div>
        {showAdvancedSettings && (
          <div className="advancedSettingsGrid">
            <PathField
              label="SpineSkeletonDataConverter Override"
              value={settings.converterPath}
              onChange={(value) => updateSetting("converterPath", value)}
            />
            <PathField
              label="Python"
              value={settings.pythonPath}
              onChange={(value) => updateSetting("pythonPath", value)}
            />
            <PathField
              label="Unity Fallback Version"
              value={settings.unityVersion}
              onChange={(value) => updateSetting("unityVersion", value)}
            />
            <PathField
              label="AssetBundle Decrypt Key"
              value={settings.decryptKey}
              onChange={(value) => updateSetting("decryptKey", value)}
              type="password"
            />
            <PathField
              label="Scan Limit"
              value={settings.scanLimit}
              onChange={(value) => updateSetting("scanLimit", value)}
            />
          </div>
        )}
      </section>

      <section className="toolbar">
        <button disabled={busy || !settings.modsDir} onClick={() => runTask(async () => {
          await scanModsWorkflow(settings);
        })}>
          Scan Mods
        </button>
        <button disabled={!busy} onClick={async () => {
          await window.bd2.stopSharedScan();
          log("Stop requested. Current bundle will finish before scanning stops.");
        }}>
          Stop Scan
        </button>
        <button type="button" onClick={() => setShowAdvancedTools((current) => !current)}>
          {showAdvancedTools ? "Hide Advanced Tools" : "Advanced Tools"}
        </button>
        {showAdvancedTools && (
          <div className="advancedToolbar">
            <button disabled={busy || !settings.sharedDir} onClick={() => runTask(async () => {
              await scanSharedForModsOnly(settings);
            })}>
              Scan Shared for Mods
            </button>
            <button disabled={busy || !settings.sharedDir} onClick={() => runTask(async () => {
              setSharedIndex({ bundles: [] });
              setPlans([]);
              setSharedAssetCategory("all");
              setSharedProgress({ phase: "discovering", current: 0, total: 0 });
              const index = await window.bd2.scanShared(settings.sharedDir, {
                pythonPath: settings.pythonPath,
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
              log(`Generated patch plan: ${planIndex.plans.length} item(s).`);
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
        <div className="panel tablePanel">
          <div className="panelTitle">Mods</div>
          <table>
            <thead>
              <tr>
                <th>Patch</th>
                <th>Folder</th>
                <th>Name</th>
                <th>Skeleton</th>
                <th>Atlas</th>
                <th>PNG</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {modsIndex.mods.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">Scan Mods to inspect detected file names.</td>
                </tr>
              ) : modsIndex.mods.map((mod) => (
                <tr key={mod.dir} className={isPatchStateDirty(mod.modName, actualPatchStates, desiredPatchStates) ? "pendingPatchChange" : ""}>
                  <td>
                    <input
                      aria-label={`Patch ${mod.modName}`}
                      checked={getDesiredPatchState(mod.modName, actualPatchStates, desiredPatchStates)}
                      disabled={mod.status !== "ready" && !actualPatchStates[mod.modName]}
                      type="checkbox"
                      onChange={(event) => updateDesiredPatchState(mod.modName, event.target.checked)}
                    />
                  </td>
                  <td title={mod.dir}>{mod.modName}</td>
                  <td>{mod.name}</td>
                  <td title={formatSkeletonFilesTitle(mod)}>{formatSkeletonFilesCell(mod)}</td>
                  <td title={formatModFilesTitle(mod.files?.atlas, mod.atlasPath)}>{formatModFilesCell(mod.files?.atlas, mod.atlasFile)}</td>
                  <td title={formatModFilesTitle(mod.files?.png, mod.pngPath)}>{formatModFilesCell(mod.files?.png, mod.pngFile)}</td>
                  <td title={formatModPatchStatusTitle(plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))}>
                    <span className={`badge ${getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))}`}>
                      {getModDisplayStatus(mod.status, plansByModName.get(mod.modName), patchHistoryByModName.get(mod.modName))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel tablePanel sharedPanel">
          <div className="tableHeader">
            <div>
              <div className="panelTitle">Shared Candidates</div>
              <div className="tableHint">{filteredSharedAssets.length} shown / {relatedSharedAssets.length} related / {sharedAssets.length} indexed</div>
            </div>
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
          </div>
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
          <div className="panelTitle">Pending Changes</div>
          <table>
            <thead>
              <tr>
                <th>Mod</th>
                <th>Current</th>
                <th>Desired</th>
              </tr>
            </thead>
            <tbody>
              {patchStateChanges.length === 0 ? (
                <tr>
                  <td colSpan={3} className="empty">Change a module checkbox to stage patch changes.</td>
                </tr>
              ) : patchStateChanges.map((change) => (
                <tr key={change.modName} className="pendingPatchChange">
                  <td>{change.modName}</td>
                  <td>{formatPatchBoolean(actualPatchStates[change.modName])}</td>
                  <td>{formatPatchBoolean(change.enabled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="panel sidePanel">
          <div className="panelTitle">Actions</div>
          <button disabled={busy || !patchStateChanges.length || !plans.length} onClick={() => runTask(async () => {
            const result = await window.bd2.dryRunPatchStateChanges(plans, modsIndex, patchStateChanges, {
              pythonPath: settings.pythonPath,
              converterPath: settings.converterPath,
              unityVersion: settings.unityVersion,
              decryptKey: settings.decryptKey
            });
            const converted = result.entries.filter((entry) => entry.status === "ready").length;
            const failed = result.entries.filter((entry) => entry.status === "failed").length;
            const restoreOnly = patchStateChanges.filter((change) => !change.enabled).length;
            log(`Dry run finished: ${converted} mod(s) prepared skeleton files, ${restoreOnly} restore-only change(s), ${failed} failed.`);
            for (const entry of result.entries.filter((item) => item.status === "failed").slice(0, 8)) {
              log(`${entry.modName}: ${entry.message ?? "dry run failed"}`);
            }
          })}>
            Dry Run
          </button>
          <button disabled>Apply Selected Mod</button>
          <button disabled={busy || !patchStateChanges.length || !plans.length} onClick={() => runTask(async () => {
            const result = await window.bd2.applyPatchStateChanges(plans, modsIndex, patchStateChanges, {
              pythonPath: settings.pythonPath,
              converterPath: settings.converterPath,
              unityVersion: settings.unityVersion,
              decryptKey: settings.decryptKey
            });
            setPatchHistory(result.history);
            setDesiredPatchStates(getActualPatchStates(modsIndex, result.history));
            const patched = result.entries.filter((entry) => entry.status === "patched").length;
            const restored = result.entries.filter((entry) => entry.status === "restored").length;
            const failed = result.entries.filter((entry) => entry.status === "failed").length;
            const skipped = result.entries.filter((entry) => entry.status === "skipped").length;
            log(`Apply changes finished: ${patched} patched, ${restored} restored, ${failed} failed, ${skipped} skipped.`);
            for (const entry of result.entries.filter((item) => item.status === "failed" || item.status === "skipped").slice(0, 8)) {
              log(`${entry.modName} ${entry.bundleId}: ${entry.message ?? entry.status}`);
            }
          })}>
            Apply Changes
          </button>
          <button disabled>Restore Selected</button>
          <button disabled={busy || !plans.some((plan) => plan.bundleId)} onClick={() => runTask(async () => {
            const result = await window.bd2.restoreAllPatches(plans);
            setPatchHistory(result.history);
            setDesiredPatchStates(getActualPatchStates(modsIndex, result.history));
            const restored = result.entries.filter((entry) => entry.status === "restored").length;
            const failed = result.entries.filter((entry) => entry.status === "failed").length;
            log(`Restore all finished: ${restored} restored, ${failed} failed.`);
            for (const entry of result.entries.filter((item) => item.status === "failed").slice(0, 8)) {
              log(`${entry.bundleId}: ${entry.message ?? "restore failed"}`);
            }
          })}>
            Restore All
          </button>
          <p className="hint">Apply updates backup B incrementally, stores per-asset pre-patch backups, then copies B over game __data after the full bundle succeeds. Restore All copies backup A back to the game folder.</p>
        </aside>
      </section>

      <section className="panel tablePanel historyPanel">
        <div className="panelTitle">Patch Status</div>
        <table>
          <thead>
            <tr>
              <th>Mod</th>
              <th>Bundle</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {patchHistory.entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">No patch operations recorded yet.</td>
              </tr>
            ) : patchHistory.entries.slice(0, 12).map((entry) => (
              <tr key={entry.id}>
                <td title={entry.message}>{entry.modName}</td>
                <td title={entry.bundlePath}>{entry.bundleId}</td>
                <td><span className={`badge ${entry.status}`}>{entry.status}</span></td>
                <td>{formatDateTime(entry.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel logPanel">
        <div className="panelTitle">Log</div>
        <pre>{logs.join("\n")}</pre>
      </section>
    </main>
  );
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

async function loadSavedSettings(): Promise<Settings> {
  const defaults = await window.bd2.getDefaultPaths().catch(() => ({ modsDir: "mods", sharedDir: "" }));
  const fallback: Settings = {
    ...emptySettings,
    modsDir: defaults.modsDir,
    sharedDir: defaults.sharedDir
  };

  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) {
      return fallback;
    }

    return {
      ...fallback,
      ...JSON.parse(stored)
    };
  } catch {
    return fallback;
  }
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

function getActualPatchStates(modsIndex: ModsIndex, history: PatchHistory) {
  const historyByModName = groupPatchHistoryByModName(history);
  const states: Record<string, boolean> = {};

  for (const mod of modsIndex.mods) {
    states[mod.modName] = getHistoryDisplayStatus(historyByModName.get(mod.modName)) === "patched";
  }

  return states;
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
  return plan?.status ?? getHistoryDisplayStatus(historyEntries) ?? fileStatus;
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

  if (historyEntries.some((entry) => entry.status === "failed")) {
    return "failed";
  }

  if (historyEntries.some((entry) => entry.status === "patched")) {
    return "patched";
  }

  if (historyEntries.every((entry) => entry.status === "restored")) {
    return "restored";
  }

  if (historyEntries.some((entry) => entry.status === "skipped")) {
    return "skipped";
  }

  return historyEntries[0].status;
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

function pushLog(setLogs: Dispatch<SetStateAction<string[]>>, message: string) {
  setLogs((current) => [`${new Date().toLocaleTimeString()} ${message}`, ...current].slice(0, 200));
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
  return target ? `${progress.message} (${target})` : progress.message;
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
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="pathRow">
        <input type={props.type ?? "text"} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
        {props.onBrowse && <button type="button" onClick={props.onBrowse}>Browse</button>}
      </div>
    </label>
  );
}
