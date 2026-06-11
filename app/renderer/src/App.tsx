import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppInfo, GameVersionInfo, LegacyRuntimeMigrationCheck } from "../../../core/types";
import type { RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

// Runtime-based BD-SpineX. The interaction model follows the original offline patch UI.

type LogEntry = { id: string; time: string; message: string; tone?: "ok" | "warn" | "err" };
type ModSortKey = "folder" | "name" | "category" | "status";
type ModSort = { key: ModSortKey; direction: "asc" | "desc" };
type ModCategory = "char" | "dating" | "cutscene" | "other";
type PendingTone = "added" | "removed" | "conflict";
type RuntimeChange = { folder: string; key: string; enabled: boolean; implicit?: boolean; conflict?: boolean };

const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "Runtime Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };
const MODSDIR_KEY = "bd-spinex:runtime-modsdir";
const MIGRATION_DISMISSED_KEY = "bd-spinex:legacy-runtime-migration-dismissed";

function typeToCategory(type: RuntimeMod["type"]): ModCategory {
  return type === "skillcut" ? "cutscene" : type === "dating" ? "dating" : type === "standing" ? "char" : "other";
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo);
  const [gameVersionInfo, setGameVersionInfo] = useState<GameVersionInfo | null>(null);
  const [modsDir, setModsDir] = useState<string>("");
  const [library, setLibrary] = useState<RuntimeMod[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [desired, setDesired] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogEntry[]>(() => [createLogEntry("Ready.")]);
  const [busy, setBusy] = useState(false);
  const [modFilter, setModFilter] = useState("");
  const [modSort, setModSort] = useState<ModSort>({ key: "folder", direction: "asc" });
  const [migrationCheck, setMigrationCheck] = useState<LegacyRuntimeMigrationCheck | null>(null);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationDismissed, setMigrationDismissed] = useState(false);

  const log = useCallback((message: string, tone?: LogEntry["tone"]) => pushLog(setLogs, message, tone), []);

  const refreshStatus = useCallback(async () => {
    const s = await window.bd2.runtimeStatus();
    setStatus(s);
    return s;
  }, []);

  const scanLibrary = useCallback(
    async (dir: string) => {
      if (!dir) { setLibrary([]); return; }
      const mods = await window.bd2.runtimeListLibrary(dir);
      setLibrary(mods);
      log(`Scanned ${mods.length} mod(s).`);
    },
    [log]
  );

  useEffect(() => {
    void (async () => {
      try { setAppInfo(await window.bd2.getAppInfo()); } catch { /* ignore */ }
      try { setGameVersionInfo(await window.bd2.detectGameVersion()); } catch { /* ignore */ }
      try {
        const migration = await window.bd2.runtimeMigrationCheck();
        const signature = migrationSignature(migration);
        const dismissed = localStorage.getItem(MIGRATION_DISMISSED_KEY);
        setMigrationCheck(migration.needed && dismissed !== signature ? migration : null);
      } catch { /* ignore */ }
      await refreshStatus();
      const saved = localStorage.getItem(MODSDIR_KEY) ?? "";
      if (saved) { setModsDir(saved); await scanLibrary(saved); }
    })();
  }, [refreshStatus, scanLibrary]);

  const mountedMods = useMemo(() => status?.mountedMods ?? [], [status]);
  const mountedFolders = useMemo(() => new Set(mountedMods.map((m) => m.folder)), [mountedMods]);
  const isDesired = useCallback((folder: string) => desired[folder] ?? mountedFolders.has(folder), [desired, mountedFolders]);
  const modsEnabled = status?.modsEnabled ?? true;

  const visibleMods = useMemo(() => filterAndSortMods(library, modFilter, modSort, mountedFolders), [library, modFilter, modSort, mountedFolders]);

  const pendingChanges = useMemo(
    () => getRuntimePendingRows(library, mountedMods, isDesired),
    [library, mountedMods, isDesired]
  );
  const tones = useMemo(() => {
    const t: Record<string, PendingTone> = {};
    for (const c of pendingChanges) t[c.folder] = c.conflict ? "conflict" : c.enabled ? "added" : "removed";
    return t;
  }, [pendingChanges]);
  const hasConflict = useMemo(() => pendingChanges.some((c) => c.conflict), [pendingChanges]);

  const versionLocked = isGameVersionMismatch(appInfo, gameVersionInfo);
  const appReady = Boolean(status?.appFound && status?.loaderAvailable);
  const injectionMissing = Boolean(status && appReady && !status.injected);
  const gameRunning = Boolean(status?.gameRunning);
  const injectionActionLocked = busy || gameRunning;
  const missingModsDir = !modsDir;
  const modsActionLocked = busy;
  const modsLocked = busy || versionLocked || !appReady || injectionMissing || missingModsDir;
  const showMigrationPanel = Boolean(migrationCheck?.needed && !migrationDismissed);

  const selectableVisibleMods = visibleMods;
  const allVisibleModsSelected = selectableVisibleMods.length > 0 && selectableVisibleMods.every((m) => isDesired(m.folder));
  const hasChanges = pendingChanges.some((c) => !c.implicit);

  const selectDir = useCallback(async () => {
    const dir = await window.bd2.selectDirectory();
    if (!dir) return;
    setModsDir(dir);
    localStorage.setItem(MODSDIR_KEY, dir);
    await scanLibrary(dir);
  }, [scanLibrary]);

  function updateDesired(folder: string, enabled: boolean) {
    setDesired((cur) => ({ ...cur, [folder]: enabled }));
  }
  function toggleVisible() {
    const enabled = !allVisibleModsSelected;
    setDesired((cur) => {
      const next = { ...cur };
      for (const m of selectableVisibleMods) next[m.folder] = enabled;
      return next;
    });
  }
  function resetChanges() {
    setDesired({});
    log("Reset staged changes.");
  }
  function refreshModsFolder() {
    void runTask(async () => {
      if (!modsDir) {
        log("Choose a Mods Folder before refreshing.", "warn");
        return;
      }
      await scanLibrary(modsDir);
    });
  }
  function updateModSort(key: ModSortKey) {
    setModSort((cur) => ({ key, direction: cur.key === key && cur.direction === "asc" ? "desc" : "asc" }));
  }

  const runTask = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try { await fn(); }
      catch (e) { log(`Error: ${String(e)}`, "err"); }
      finally { setBusy(false); await refreshStatus(); }
    },
    [log, refreshStatus]
  );

  const installLoader = useCallback(() => {
    if (!window.confirm("Install Runtime Injection into the BrownDust II executable? Close the game before continuing.")) return;
    void runTask(async () => {
      const r = await window.bd2.runtimeInstall();
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, log]);

  const uninstallLoader = useCallback(() => {
    if (!window.confirm("Remove Runtime Injection and restore the original BrownDust II executable? Close the game before continuing.")) return;
    void runTask(async () => {
      const r = await window.bd2.runtimeUninstall();
      log(r.message, r.ok ? "ok" : "warn");
    });
  }, [runTask, log]);

  const toggleModPower = useCallback(() => {
    void runTask(async () => {
      const r = await window.bd2.runtimeSetEnabled(!modsEnabled);
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, modsEnabled, log]);

  const applyChanges = useCallback(() => {
    void runTask(async () => {
      if (pendingChanges.length === 0 || hasConflict) return;
      const byFolder = new Map(library.map((m) => [m.folder, m]));
      let mounted = 0, unmounted = 0;
      for (const c of pendingChanges.filter((c) => !c.enabled)) {
        const r = await window.bd2.runtimeUnmount(c.folder);
        log(`${r.message}${c.implicit ? " (auto)" : ""}`, r.ok ? "ok" : "warn");
        if (r.ok) unmounted++;
      }
      for (const c of pendingChanges.filter((c) => c.enabled)) {
        const mod = byFolder.get(c.folder);
        if (!mod) continue;
        const r = await window.bd2.runtimeMount(mod.path, mod.folder);
        log(r.message, r.ok ? "ok" : "err");
        if (r.ok) mounted++;
      }
      setDesired({});
      log(`Applied: ${mounted} mounted, ${unmounted} unmounted. Restart the game to apply changes.`, "ok");
      if (mounted > 0 && !status?.injected) {
        log("Runtime Injection is not installed yet. Mounted mods will not take effect until injection is installed.", "warn");
      }
    });
  }, [runTask, pendingChanges, hasConflict, status, library, log]);

  const restoreAll = useCallback(() => {
    if (!window.confirm(`Unmount all ${mountedMods.length} mounted mod(s)? Runtime Injection will stay installed.`)) return;
    if (!window.confirm("This removes all mounted runtime mod files from the game container. Your source Mods Folder will not be changed. Continue?")) return;
    void runTask(async () => {
      for (const m of mountedMods) {
        const r = await window.bd2.runtimeUnmount(m.folder);
        log(r.message, r.ok ? "ok" : "warn");
      }
      const p = await window.bd2.runtimeSetEnabled(true);
      log(p.message, p.ok ? "ok" : "warn");
      setDesired({});
    });
  }, [runTask, mountedMods, log]);

  const launchGame = useCallback(() => {
    void runTask(async () => {
      const r = await window.bd2.runtimeLaunch();
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, log]);

  function logMigrationResult(r: Awaited<ReturnType<typeof window.bd2.runtimeMigrateLegacy>>) {
    log(r.message, r.ok ? "ok" : "err");
    if (r.restoredBundles.length) log(`Restored clean __data for ${r.restoredBundles.length} bundle(s).`, "ok");
    if (r.mountedMods.length) log(`Mounted migrated mod(s): ${r.mountedMods.slice(0, 6).join(", ")}${r.mountedMods.length > 6 ? " ..." : ""}`, "ok");
    if (r.missingMods.length) log(`Missing source mod folder(s): ${r.missingMods.join(", ")}`, "warn");
    for (const err of r.errors.slice(0, 6)) log(err, "err");
  }

  function finishMigrationChoice() {
    setMigrationCheck(null);
    setMigrationDismissed(true);
  }

  const chooseNoMigration = useCallback(() => {
    window.alert("No changes will be made. You can keep using BD-SpineX. If you want clean __data files later, reinstall BrownDust II in PlayCover.");
    if (migrationCheck) {
      localStorage.setItem(MIGRATION_DISMISSED_KEY, migrationSignature(migrationCheck));
    }
    finishMigrationChoice();
  }, [migrationCheck]);

  const runLegacyUnpatch = useCallback(() => {
    void (async () => {
      if (!window.confirm("Restore clean __data from legacy backups and remove old patch index/history data? Runtime Injection and runtime mods will not be installed.")) return;
      setMigrationRunning(true);
      setBusy(true);
      try {
        const r = await window.bd2.runtimeUnpatchLegacy();
        logMigrationResult(r);
        if (r.ok) finishMigrationChoice();
        await refreshStatus();
      } catch (e) {
        log(`Unpatch error: ${String(e)}`, "err");
      } finally {
        setMigrationRunning(false);
        setBusy(false);
      }
    })();
  }, [log, refreshStatus]);

  const runLegacyMigration = useCallback(() => {
    void (async () => {
      if (!modsDir) {
        log("Choose a Mods Folder before migrating legacy patches.", "warn");
        return;
      }
      if (!window.confirm("BD-SpineX found legacy __data patches. It will restore clean __data, install Runtime Injection, mount the previously patched mods, then remove old patch index/history data. Continue?")) {
        return;
      }
      setMigrationRunning(true);
      setBusy(true);
      try {
        const r = await window.bd2.runtimeMigrateLegacy(modsDir);
        logMigrationResult(r);
        if (r.ok) finishMigrationChoice();
        await refreshStatus();
        if (modsDir) await scanLibrary(modsDir);
      } catch (e) {
        log(`Migration error: ${String(e)}`, "err");
      } finally {
        setMigrationRunning(false);
        setBusy(false);
      }
    })();
  }, [modsDir, log, refreshStatus, scanLibrary]);

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
              BD-SpineX must match the BrownDust II game version because runtime hooks are bound to IL2CPP addresses. Mod operations are locked when versions differ.
            </HelpButton>
          </p>
          <p>BrownDust II Runtime Mod Loader | Mac PlayCover</p>
        </div>
        <div className="statusPill" title={status?.injected ? "Loader installed" : "Loader not installed"}>
          {status?.injected ? "Runtime installed" : "Not installed"} · {mountedMods.length} mounted{gameRunning ? " · game running" : ""}
        </div>
      </header>

      {versionLocked && (
        <section className="panel"><div className="errorPill">Version mismatch: this manager supports {appInfo.supportedGameVersion}, but the detected game version is {gameVersionInfo?.version ?? "unknown"}. Use the matching BD-SpineX release.</div></section>
      )}
      {status && !status.appFound && (<section className="panel"><div className="errorPill">Could not find BrownDust II in PlayCover.</div></section>)}
      {status && !status.loaderAvailable && (<section className="panel"><div className="errorPill">Runtime loader is missing. In development mode, run npm run build:loader first.</div></section>)}
      {gameRunning && (
        <section className="panel">
          <div className="warningPill">BrownDust II is running. Close the game before installing or removing Runtime Injection.</div>
        </section>
      )}
      {showMigrationPanel && migrationCheck && (
        <section className="panel migrationPanel">
          <div>
            <div className="inheritHistoryTitle">Legacy Patch Migration</div>
            <div className="inheritHistoryText">
              BD-SpineX found legacy Patch __data records from {migrationCheck.sourceVersions.join(", ")}. Choose how much cleanup to perform now. You can continue using the app with any option.
            </div>
            <div className="inheritHistoryText">
              {migrationCheck.modNames.length} previously patched mod(s) detected. Do Nothing keeps files as-is; Unpatch Only restores clean __data and removes old patch records; Migrate also installs Runtime Injection and mounts matching mods from your Mods Folder.
            </div>
          </div>
          <div className="migrationActions">
            <button disabled={busy || migrationRunning} onClick={chooseNoMigration} type="button">
              Do Nothing
            </button>
            <button disabled={busy || migrationRunning || gameRunning} onClick={runLegacyUnpatch} type="button">
              Unpatch Only
            </button>
            <button disabled={busy || migrationRunning || !modsDir || gameRunning} onClick={runLegacyMigration} type="button">
              Migrate
            </button>
          </div>
        </section>
      )}
      <section className="panel settingsGrid">
        <PathField
          label="Mods Folder"
          helpTitle="Mods Folder"
          helpText="Choose the folder containing your mods. Check a mod to mount it, or uncheck a mounted mod to unmount it. If a newly selected mod shares a key with an already mounted one, the old mount is automatically staged for removal."
          value={modsDir}
          onChange={(v) => setModsDir(v)}
          onBrowse={selectDir}
          invalid={missingModsDir}
        />
        <div className="field">
          <span className="fieldLabel">
            <span>Runtime Injection (BepInEx)</span>
            <HelpButton title="Runtime Injection">
              Installs the loader into the game executable after backing up and re-signing it. Close BrownDust II before installing or removing injection. Mounted mods take effect the next time the game starts. Removing injection restores the original executable but keeps mounted mod files in place. Reinstall injection after a game update.
            </HelpButton>
          </span>
          <div className="pathRow">
            <span className={`badge injectionBadge ${status?.injected ? "injected" : "notInjected"}`} style={{ alignSelf: "center" }}>
              {status?.injected ? "Injected" : "Not injected"}
            </span>
            <button
              type="button"
              disabled={injectionActionLocked || !appReady || Boolean(status?.injected)}
              onClick={installLoader}
              title={gameRunning ? "Close BrownDust II before changing injection" : ""}
            >
              Install Injection
            </button>
            <button
              type="button"
              disabled={injectionActionLocked || !status?.injected}
              onClick={uninstallLoader}
              title={gameRunning ? "Close BrownDust II before changing injection" : ""}
            >
              Remove Injection
            </button>
          </div>
        </div>
      </section>

      <section className="scanGrid">
        <div className="panel tablePanel modsPanel">
          <div className="modsHeader">
            <div>
              <div className="panelTitle titleWithHelp">
                <span>Mods</span>
                <HelpButton title="Mods table">
                  Check a mod to stage it for mounting. Uncheck a mounted mod to stage removal. Sorting, filtering, and scrolling remain available while actions are locked.
                </HelpButton>
              </div>
              <div className="tableHint">{visibleMods.length} shown / {library.length} scanned</div>
            </div>
            <div className="modsHeaderControls">
              <button disabled={busy || !modsDir} onClick={refreshModsFolder} title="Scan the selected Mods Folder again" type="button">
                Refresh Mods
              </button>
              <button disabled={busy || modsLocked || !hasChanges} onClick={resetChanges} title="Reset staged changes before applying" type="button">
                Reset Changes
              </button>
              <label className="modFilterField">
                <span>Filter</span>
                <input value={modFilter} onChange={(e) => setModFilter(e.target.value)} placeholder="Search folder, key, category, status" />
              </label>
            </div>
          </div>

          <div className={`modsTableFrame ${modsLocked ? "locked" : ""}`}>
            <table>
              <colgroup>
                <col className="patchCol" />
                <col className="folderCol" />
                <col className="nameCol" />
                <col className="categoryCol" />
                <col className="statusCol" />
              </colgroup>
              <thead>
                <tr>
                  <th className="patchColumn">
                    <div className="patchBulkControls" aria-label="Bulk selection">
                      <button disabled={modsLocked || selectableVisibleMods.length === 0} onClick={toggleVisible} title={allVisibleModsSelected ? "Clear all visible" : "Select all visible"} type="button">
                        {allVisibleModsSelected ? "×" : "✓"}
                      </button>
                    </div>
                  </th>
                  <th>{renderModSortButton("Folder", "folder", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Key", "name", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Category", "category", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Status", "status", modSort, updateModSort)}</th>
                </tr>
              </thead>
              <tbody>
                {library.length === 0 ? (
                  <tr><td colSpan={5} className="empty">{modsDir ? "No mods found." : "Choose a Mods Folder first."}</td></tr>
                ) : visibleMods.length === 0 ? (
                  <tr><td colSpan={5} className="empty">No mods match this filter.</td></tr>
                ) : visibleMods.map((mod) => {
                  const tone = tones[mod.folder];
                  const have = mountedFolders.has(mod.folder);
                  const category = typeToCategory(mod.type);
                  const folderName = formatFolderName(mod.folder);
                  return (
                    <tr key={mod.path} className={tone ? `pendingPatchChange ${formatPendingToneClass(tone)}` : ""}>
                      <td className="patchColumn">
                        <input
                          aria-label={`Mount ${mod.folder}`}
                          type="checkbox"
                          checked={isDesired(mod.folder)}
                          disabled={modsLocked}
                          onChange={(e) => updateDesired(mod.folder, e.target.checked)}
                        />
                      </td>
                      <td className="folderCell" title={mod.folder}>{folderName}</td>
                      <td title={mod.key}><code>{mod.key}</code></td>
                      <td><span className={`categoryBadge ${category}`}>{category}</span></td>
                      <td title={mod.skeleton === "skel" ? "Binary .skel file. BD-SpineX converts it to .json while mounting when possible." : ""}>
                        <span className={`badge ${have ? "patched" : "ready"}`}>{have ? "mounted" : "available"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {modsLocked && (
              <div className="modsLockOverlay" aria-hidden="true">
                <span>{formatModsLockReason(versionLocked, appReady, injectionMissing, missingModsDir, modsActionLocked)}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="contentGrid">
        <div className="panel tablePanel">
          <div className="panelTitle titleWithHelp">
            <span>Pending Changes</span>
            <HelpButton title="Pending Changes">
              This table shows what will change when Apply Changes is pressed. Rows marked (auto) are removals staged because they share the same asset key as a newly selected mod. Nothing is changed before you apply.
            </HelpButton>
          </div>
          <table>
            <thead>
              <tr><th>Mod</th><th>Mode</th><th>Current</th><th>Desired</th></tr>
            </thead>
            <tbody>
              {pendingChanges.length === 0 ? (
                <tr><td colSpan={4} className="empty">Check a mod or uncheck a mounted mod to stage changes.</td></tr>
              ) : pendingChanges.map((c) => (
                <tr key={c.folder} className={`pendingPatchChange ${formatPendingToneClass(tones[c.folder])}`}>
                  <td title={c.folder}>{formatFolderName(c.folder)}{c.implicit ? " (auto)" : ""}</td>
                  <td>Mount</td>
                  <td>{formatBool(mountedFolders.has(c.folder))}</td>
                  <td>{formatBool(c.enabled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="panel sidePanel">
          <div className="panelTitle titleWithHelp">
            <span>Actions</span>
            <HelpButton title="Actions">
              Apply Changes mounts or unmounts the staged mods. Restore All removes every mounted mod from the game container but does not remove Runtime Injection.
            </HelpButton>
          </div>
          <div className={`modPowerPanel ${modsEnabled ? "enabled" : "disabled"}`}>
            <div>
              <div className="modPowerLabel titleWithHelp">
                <span>Mod Power</span>
                <HelpButton title="Mod Power">
                  Turns all runtime mods on or off without moving mounted mod folders. The loader reads this switch when the game starts, so restart the game after changing it.
                </HelpButton>
              </div>
              <div className="modPowerState">
                {modsEnabled
                  ? `${mountedMods.length} mounted mod(s) ready`
                  : `${mountedMods.length} mounted mod(s) kept, currently off`}
              </div>
            </div>
            <button disabled={busy} onClick={toggleModPower} type="button">
              {modsEnabled ? "Turn Off Mods" : "Restore Mods"}
            </button>
          </div>
          <div className="actionButtons">
            <button
              disabled={modsLocked || pendingChanges.length === 0 || hasConflict}
              onClick={applyChanges}
              title={versionLocked ? "Update BD-SpineX version" : hasConflict ? "Resolve same-key conflicts first" : pendingChanges.length === 0 ? "No staged changes" : ""}
            >
              Apply Changes{pendingChanges.length ? ` (${pendingChanges.length})` : ""}
            </button>
            <button disabled={busy || !appReady} onClick={launchGame}>Launch Game</button>
            <button disabled={busy || mountedMods.length === 0} onClick={restoreAll} title={mountedMods.length === 0 ? "No mounted mods to remove" : "Unmount every mounted runtime mod"}>
              Restore All
            </button>
            {hasConflict && <p className="hint warning">Multiple mods with the same key are selected. Keep only one purple row per key before applying.</p>}
            {busy && <p className="hint">Action running...</p>}
            {versionLocked && <p className="hint">Update BD-SpineX version</p>}
          </div>
        </aside>
      </section>

      <section className="panel logPanel">
        <h2>Log</h2>
        <div className="logStream" role="log" aria-live="polite">
          {logs.map((entry) => (
            <div key={entry.id} className="logLine">
              <span className="logTime">{entry.time}</span>
              <span className={`logMessage ${entry.tone ? `logAccent ${entry.tone}` : ""}`}>{entry.message}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

// ===== logic helpers =====
function getRuntimePendingRows(library: RuntimeMod[], mountedMods: RuntimeMod[], isDesired: (folder: string) => boolean): RuntimeChange[] {
  const mountedFolders = new Set(mountedMods.map((m) => m.folder));
  const rows: RuntimeChange[] = [];
  const seen = new Set<string>();
  // 明確變更：library 中 desired != mounted
  for (const mod of library) {
    const want = isDesired(mod.folder);
    const have = mountedFolders.has(mod.folder);
    if (want !== have) { rows.push({ folder: mod.folder, key: mod.key, enabled: want }); seen.add(mod.folder); }
  }
  // 同 key 自動移除：被掛載中、且 key 與「要新增掛載」的某項相同 → 自動加入移除
  const addedKeys = new Set(rows.filter((r) => r.enabled).map((r) => r.key));
  if (addedKeys.size) {
    for (const m of mountedMods) {
      if (seen.has(m.folder)) continue;
      if (isDesired(m.folder) === false) continue; // 使用者已主動取消的會在上面處理
      if (addedKeys.has(m.key)) { rows.push({ folder: m.folder, key: m.key, enabled: false, implicit: true }); seen.add(m.folder); }
    }
  }
  // 衝突：同時勾選多個「相同 key 且未掛載」的 mod → 無法判斷掛哪個 → 標記衝突（紫底、無法 Apply）
  const enabledByKey = new Map<string, RuntimeChange[]>();
  for (const r of rows) {
    if (!r.enabled) continue;
    const list = enabledByKey.get(r.key) ?? [];
    list.push(r);
    enabledByKey.set(r.key, list);
  }
  for (const list of enabledByKey.values()) {
    if (list.length >= 2) for (const r of list) r.conflict = true;
  }
  return rows;
}

function filterAndSortMods(mods: RuntimeMod[], filter: string, sort: ModSort, mountedFolders: Set<string>) {
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? mods.filter((m) => `${m.folder} ${m.key} ${typeToCategory(m.type)} ${mountedFolders.has(m.folder) ? "mounted" : "available"}`.toLowerCase().includes(f))
    : mods;
  return [...filtered].sort((a, b) => {
    const va = sortValue(a, sort.key, mountedFolders);
    const vb = sortValue(b, sort.key, mountedFolders);
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? cmp : -cmp;
  });
}
function sortValue(mod: RuntimeMod, key: ModSortKey, mountedFolders: Set<string>) {
  if (key === "name") return mod.key;
  if (key === "category") return typeToCategory(mod.type);
  if (key === "status") return mountedFolders.has(mod.folder) ? "mounted" : "available";
  return mod.folder;
}

function pushLog(setLogs: Dispatch<SetStateAction<LogEntry[]>>, message: string, tone?: LogEntry["tone"]) {
  setLogs((cur) => [createLogEntry(message, tone), ...cur].slice(0, 200));
}
function createLogEntry(message: string, tone?: LogEntry["tone"]): LogEntry {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time, message, tone };
}
function formatBool(v: boolean) { return v ? "On" : "Off"; }
function formatFolderName(folder: string) {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? folder;
}
function formatModsLockReason(versionLocked: boolean, appReady: boolean, injectionMissing: boolean, missingModsDir: boolean, modsActionLocked: boolean) {
  if (versionLocked) return "Update BD-SpineX version";
  if (!appReady) return "PlayCover BrownDust II / loader not found";
  if (injectionMissing) return "Install Runtime Injection";
  if (missingModsDir) return "Select a Mods Folder";
  if (modsActionLocked) return "Action running";
  return "Mods are locked";
}
function formatPendingToneClass(tone?: PendingTone) {
  return tone === "conflict" ? "pendingPatchConflict" : tone === "added" ? "pendingPatchAdd" : tone === "removed" ? "pendingPatchRemove" : "";
}

function normalizeVersionForCompare(version?: string) {
  return version?.trim().replace(/^v/i, "").split(/[+-]/)[0];
}
function formatVersionBadge(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const managerVersion = `v${appInfo.version}`;
  const gameVersion = gameVersionInfo?.version;
  const supported = appInfo.supportedGameVersion || appInfo.version;
  return gameVersion && normalizeVersionForCompare(gameVersion) !== normalizeVersionForCompare(supported) ? `${managerVersion} [${gameVersion}]` : managerVersion;
}
function formatVersionTitle(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const gameVersion = gameVersionInfo?.version;
  const supported = appInfo.supportedGameVersion || appInfo.version;
  return `Manager: ${appInfo.version}${supported !== appInfo.version ? `\nSupported game: ${supported}` : ""}${gameVersion ? `\nGame: ${gameVersion}` : ""}`;
}
function isGameVersionMismatch(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  if (appInfo.development) return false;
  const g = normalizeVersionForCompare(gameVersionInfo?.version);
  const s = normalizeVersionForCompare(appInfo.supportedGameVersion || appInfo.version);
  return Boolean(g && s && g !== s);
}

function migrationSignature(migration: LegacyRuntimeMigrationCheck) {
  return JSON.stringify({
    sourceVersions: migration.sourceVersions,
    modNames: migration.modNames
  });
}

function renderModSortButton(label: string, key: ModSortKey, sort: ModSort, onSort: (key: ModSortKey) => void) {
  const active = sort.key === key;
  const direction = active ? sort.direction : undefined;
  return (
    <button className={`sortButton ${active ? "active" : ""}`} type="button" onClick={() => onSort(key)}>
      <span>{label}</span>
      <span aria-hidden="true">{direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}</span>
    </button>
  );
}

function PathField(props: { label: string; value: string; onChange: (v: string) => void; onBrowse?: () => void; invalid?: boolean; helpTitle?: string; helpText?: string }) {
  return (
    <label className={`field ${props.invalid ? "invalid" : ""}`}>
      <span className="fieldLabel">
        <span>{props.label}</span>
        {props.helpTitle && props.helpText && <HelpButton title={props.helpTitle}>{props.helpText}</HelpButton>}
      </span>
      <div className="pathRow">
        <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        {props.onBrowse && <button type="button" onClick={props.onBrowse}>Browse</button>}
      </div>
    </label>
  );
}

function HelpButton(props: { title: string; children: ReactNode }) {
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
        type="button"
        className="helpButton"
        aria-expanded={open}
        aria-label={`About ${props.title}`}
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
