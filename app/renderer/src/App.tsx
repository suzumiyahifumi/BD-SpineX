import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppInfo, GameVersionInfo, LegacyRuntimeMigrationCheck } from "../../../core/types";
import type { RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

// Runtime-based BD-SpineX. The interaction model follows the original offline patch UI.
// Stage 3 of the liquid-glass redesign: the top toolbar is replaced by a left glass
// rail with routed views (Library / Roster / Profiles / Preview / Stats / Settings).
// All runtime logic and window.bd2 calls are unchanged.

type LogEntry = { id: string; time: string; message: string; tone?: "ok" | "warn" | "err" };
type ModSortKey = "folder" | "name" | "category" | "status";
type ModSort = { key: ModSortKey; direction: "asc" | "desc" };
type ModCategory = "char" | "dating" | "cutscene" | "other";
type PendingTone = "added" | "removed" | "conflict";
type RuntimeChange = { folder: string; key: string; enabled: boolean; implicit?: boolean; conflict?: boolean };
type AuthorRule = { id: string; name: string; color: string; keywords: string[]; custom?: boolean };
type DetectedAuthor = { id: string; name: string; color: string };

type ViewKey = "library" | "roster" | "profiles" | "preview" | "stats" | "logs" | "settings";
type NavItem = { key: ViewKey; label: string; icon: string; group: "collection" | "tools" | "system" };

const NAV_ITEMS: NavItem[] = [
  { key: "library", label: "Library", icon: "📚", group: "collection" },
  { key: "roster", label: "Roster", icon: "🎭", group: "collection" },
  { key: "profiles", label: "Profiles", icon: "💼", group: "collection" },
  { key: "preview", label: "Preview", icon: "👁️", group: "tools" },
  { key: "stats", label: "Stats", icon: "📊", group: "tools" },
  { key: "logs", label: "Logs", icon: "🧾", group: "tools" },
  { key: "settings", label: "Settings", icon: "⚙️", group: "system" }
];
const NAV_GROUPS: { id: NavItem["group"]; label: string }[] = [
  { id: "collection", label: "收藏" },
  { id: "tools", label: "工具" },
  { id: "system", label: "系統" }
];

const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "Runtime Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };
const MODSDIR_KEY = "bd-spinex:runtime-modsdir";
const MIGRATION_DISMISSED_KEY = "bd-spinex:legacy-runtime-migration-dismissed";
const MODVIEW_KEY = "bd-spinex:mod-view";
const CARTSKIN_KEY = "bd-spinex:cart-skin";
const AUTHOR_RULES_KEY = "bd-spinex:author-rules";
type ModView = "grid" | "list";
type CartSkin = "realistic" | "arcade";

const AUTHOR_COLORS = [
  "#d98a22",
  "#5f8fb9",
  "#8c6bb1",
  "#4f9c7a",
  "#bf5f57",
  "#b49a45",
  "#6f88c7",
  "#c46d9b",
  "#5f9fa8",
  "#9a7551",
  "#7c8a59",
  "#a7664b",
  "#6d78a8",
  "#9298a6"
];

const DEFAULT_AUTHOR_RULES: AuthorRule[] = [
  makeAuthorRule("anextra", "AnExtra", AUTHOR_COLORS[0]),
  makeAuthorRule("hardcracker", "HardCracker", AUTHOR_COLORS[1]),
  makeAuthorRule("hcoel", "H.Coel", AUTHOR_COLORS[2]),
  makeAuthorRule("linr", "linr熊", AUTHOR_COLORS[3]),
  makeAuthorRule("mr_miagi", "Mr. Miagi", AUTHOR_COLORS[4]),
  makeAuthorRule("mr_phaps", "Mr. Phaps", AUTHOR_COLORS[5]),
  makeAuthorRule("na0h", "Na0h", AUTHOR_COLORS[6]),
  makeAuthorRule("nimloth", "Nimloth", AUTHOR_COLORS[7]),
  makeAuthorRule("qi", "Qi齊", AUTHOR_COLORS[8]),
  makeAuthorRule("sloth", "Sloth", AUTHOR_COLORS[9]),
  makeAuthorRule("synae", "Synae", AUTHOR_COLORS[10]),
  makeAuthorRule("yuk11sh1d4", "Yuk11sh1d4", AUTHOR_COLORS[11]),
  makeAuthorRule("tazmanyakk", "Tazmanyakk", AUTHOR_COLORS[12]),
  makeAuthorRule("xian", "XiAn", AUTHOR_COLORS[13])
];

function typeToCategory(type: RuntimeMod["type"]): ModCategory {
  return type === "skillcut" ? "cutscene" : type === "dating" ? "dating" : type === "standing" ? "char" : "other";
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo);
  const [gameVersionInfo, setGameVersionInfo] = useState<GameVersionInfo | null>(null);
  const [view, setView] = useState<ViewKey>("library");
  const [modsDir, setModsDir] = useState<string>("");
  const [library, setLibrary] = useState<RuntimeMod[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [desired, setDesired] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogEntry[]>(() => [createLogEntry("Ready.")]);
  const [busy, setBusy] = useState(false);
  const [modFilter, setModFilter] = useState("");
  const [modSort, setModSort] = useState<ModSort>({ key: "folder", direction: "asc" });
  const [modView, setModView] = useState<ModView>(() => (localStorage.getItem(MODVIEW_KEY) === "list" ? "list" : "grid"));
  const [cartSkin, setCartSkin] = useState<CartSkin>(() => (localStorage.getItem(CARTSKIN_KEY) === "arcade" ? "arcade" : "realistic"));
  const [authorRules, setAuthorRules] = useState<AuthorRule[]>(readAuthorRules);
  const [newAuthorName, setNewAuthorName] = useState("");
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
  function updateModView(next: ModView) {
    setModView(next);
    localStorage.setItem(MODVIEW_KEY, next);
  }
  function updateCartSkin(next: CartSkin) {
    setCartSkin(next);
    localStorage.setItem(CARTSKIN_KEY, next);
  }
  function updateAuthorColor(id: string, color: string) {
    setAuthorRules((cur) => {
      const next = cur.map((rule) => rule.id === id ? { ...rule, color } : rule);
      persistAuthorRules(next);
      return next;
    });
  }
  function addAuthorRule() {
    const name = newAuthorName.trim();
    if (!name) return;
    setAuthorRules((cur) => {
      const id = normalizeAuthorId(name) || `author_${cur.length + 1}`;
      if (cur.some((rule) => rule.id === id || normalizeForMatch(rule.name) === normalizeForMatch(name))) return cur;
      const next = [...cur, makeAuthorRule(id, name, AUTHOR_COLORS[cur.length % AUTHOR_COLORS.length], true)];
      persistAuthorRules(next);
      return next;
    });
    setNewAuthorName("");
  }
  function removeAuthorRule(id: string) {
    setAuthorRules((cur) => {
      const next = cur.filter((rule) => rule.id !== id || !rule.custom);
      persistAuthorRules(next);
      return next;
    });
  }
  function resetAuthorRules() {
    setAuthorRules(DEFAULT_AUTHOR_RULES);
    persistAuthorRules(DEFAULT_AUTHOR_RULES);
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

  // ===== view fragments =====
  const activeNav = NAV_ITEMS.find((n) => n.key === view) ?? NAV_ITEMS[0];

  const globalBanners = (
    <div className="bannerStack">
      {versionLocked && (
        <div className="errorPill">Version mismatch: this manager supports {appInfo.supportedGameVersion}, but the detected game version is {gameVersionInfo?.version ?? "unknown"}. Use the matching BD-SpineX release.</div>
      )}
      {status && !status.appFound && (<div className="errorPill">Could not find BrownDust II in PlayCover.</div>)}
      {status && !status.loaderAvailable && (<div className="errorPill">Runtime loader is missing. In development mode, run npm run tauri:prepare first.</div>)}
      {gameRunning && (
        <div className="warningPill">BrownDust II is running. Close the game before installing or removing Runtime Injection.</div>
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
    </div>
  );

  const pendingDiffDock = pendingChanges.length > 0 ? (
    <aside className={`pendingDiffDock ${hasConflict ? "has-conflict" : ""}`} role="status" aria-live="polite" aria-label="Pending changes">
      <div className="pendingDiffHead">
        <span>Pending Changes</span>
        <strong>{pendingChanges.length}</strong>
      </div>
      <div className="pendingDiffList">
        {pendingChanges.map((c) => (
          <div key={c.folder} className={`pendingDiffItem ${formatPendingToneClass(tones[c.folder])}`} title={c.folder}>
            <span className="pendingDiffColor" aria-hidden="true" />
            <span className="pendingDiffName">{formatFolderName(c.folder)}</span>
          </div>
        ))}
      </div>
    </aside>
  ) : null;

  const logView = (
    <section className="panel logPanel logPage">
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
  );

  const libraryView = (
    <>
      <section className="scanGrid libraryFlow">
        <div className="panel tablePanel modsPanel cartridgePanel">
          <div className="modsHeader cartridgeToolbar">
            <div className="cartridgeToolbarIntro">
              <div className="panelTitle titleWithHelp">
                <span>Cartridges</span>
                <HelpButton title="Mod cartridges">
                  Each mod is a game cartridge. Click a cartridge to stage it for mounting, or click a mounted one to stage removal. Lit gold contact pins mean it is mounted; a green/red/purple frame means staged add / staged removal / same-key conflict. Switch to List for a dense sortable table.
                </HelpButton>
              </div>
              <div className="tableHint">{visibleMods.length} shown / {library.length} scanned</div>
            </div>
            <div className="cartridgeToolbarModes">
              <div className="modViewToggle segmentedControl" role="tablist" aria-label="Mod view">
                <button className={modView === "grid" ? "active" : ""} onClick={() => updateModView("grid")} type="button" aria-pressed={modView === "grid"}>
                  <span>Cartridges</span>
                </button>
                <button className={modView === "list" ? "active" : ""} onClick={() => updateModView("list")} type="button" aria-pressed={modView === "list"}>
                  <span>List</span>
                </button>
              </div>
              {modView === "grid" && (
                <div className="cartSkinToggle segmentedControl" role="tablist" aria-label="Cartridge style">
                  <button className={cartSkin === "realistic" ? "active" : ""} onClick={() => updateCartSkin("realistic")} type="button" aria-pressed={cartSkin === "realistic"}>
                    <span>Collector</span>
                  </button>
                  <button className={cartSkin === "arcade" ? "active" : ""} onClick={() => updateCartSkin("arcade")} type="button" aria-pressed={cartSkin === "arcade"}>
                    <span>Arcade</span>
                  </button>
                </div>
              )}
            </div>
            <div className="modsHeaderControls cartridgeToolbarActions">
              <label className="modFilterField">
                <span>Filter</span>
                <input value={modFilter} onChange={(e) => setModFilter(e.target.value)} placeholder="Search folder, key, category, status" />
              </label>
              <button disabled={modsLocked || selectableVisibleMods.length === 0} onClick={toggleVisible} title={allVisibleModsSelected ? "Clear all visible" : "Select all visible"} type="button">
                {allVisibleModsSelected ? "Clear All" : "Select All"}
              </button>
              <button disabled={busy || !modsDir} onClick={refreshModsFolder} title="Scan the selected Mods Folder again" type="button">
                Refresh Mods
              </button>
              <button disabled={busy || modsLocked || !hasChanges} onClick={resetChanges} title="Reset staged changes before applying" type="button">
                Reset Changes
              </button>
            </div>
          </div>

          <div className={`modsTableFrame ${modView === "grid" ? "is-grid" : "is-list"} ${modsLocked ? "locked" : ""}`}>
            {modView === "grid" ? (
              <div className={`cartShelf ${cartSkin === "realistic" ? "cartShelf--collector" : ""}`}>
                {library.length === 0 ? (
                  <div className="cartEmpty">{modsDir ? "No mods found." : "Choose a Mods Folder in Settings to load your cartridges."}</div>
                ) : visibleMods.length === 0 ? (
                  <div className="cartEmpty">No mods match this filter.</div>
                ) : visibleMods.map((mod) => {
                  const CartComp = cartSkin === "realistic" ? CartridgeRealistic : Cartridge;
                  return (
                    <CartComp
                      key={mod.path}
                      mod={mod}
                      have={mountedFolders.has(mod.folder)}
                      selected={isDesired(mod.folder)}
                      tone={tones[mod.folder]}
                      locked={modsLocked}
                      onToggle={() => updateDesired(mod.folder, !isDesired(mod.folder))}
                      authorRules={authorRules}
                    />
                  );
                })}
              </div>
            ) : (
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
                  <tr><td colSpan={5} className="empty">{modsDir ? "No mods found." : "Choose a Mods Folder in Settings to load your cartridges."}</td></tr>
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
            )}
            {modsLocked && (
              <div className="modsLockOverlay" aria-hidden="true">
                <span>{formatModsLockReason(versionLocked, appReady, injectionMissing, missingModsDir, modsActionLocked)}</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );

  const settingsView = (
    <>
      <section className="panel settingsGrid">
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
        <PathField
          label="Mods Folder"
          helpTitle="Mods Folder"
          helpText="Choose the folder containing your mods. The Library view reads cartridges from here."
          value={modsDir}
          onChange={(v) => setModsDir(v)}
          onBrowse={selectDir}
          invalid={missingModsDir}
        />
      </section>

      <section className="panel authorSettingsPanel">
        <div className="authorSettingsHead">
          <div className="panelTitle titleWithHelp">
            <span>Author Labels</span>
            <HelpButton title="Author Labels">
              Cartridge author stickers are detected from the mod path, folder, or key. Default names come from BD2ModManager's author index; add aliases here when your local folder names use a different author keyword.
            </HelpButton>
          </div>
          <button type="button" onClick={resetAuthorRules}>Reset Authors</button>
        </div>
        <form className="authorAddRow" onSubmit={(e) => { e.preventDefault(); addAuthorRule(); }}>
          <input value={newAuthorName} onChange={(e) => setNewAuthorName(e.target.value)} placeholder="Add author name" />
          <button type="submit" disabled={!newAuthorName.trim()}>Add Author</button>
        </form>
        <div className="authorRuleGrid">
          {authorRules.map((rule) => (
            <div className="authorRuleRow" key={rule.id}>
              <span className="authorRuleSwatch" style={{ "--author-color": rule.color } as CSSProperties} aria-hidden="true" />
              <span className="authorRuleName" title={rule.keywords.join(", ")}>{rule.name}</span>
              <input type="color" value={rule.color} onChange={(e) => updateAuthorColor(rule.id, e.target.value)} aria-label={`Color for ${rule.name}`} />
              {rule.custom ? (
                <button type="button" className="authorRuleRemove" onClick={() => removeAuthorRule(rule.id)} title={`Remove ${rule.name}`}>×</button>
              ) : (
                <span className="authorRuleLock" title="Default author">Default</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="panel settingsGrid">
        <div className="field">
          <span className="fieldLabel"><span>App</span></span>
          <div className="backendStatus">
            <span>{appInfo.name} · {appInfo.subtitle}</span>
            <strong>v{appInfo.version}</strong>
          </div>
        </div>
        <div className="field">
          <span className="fieldLabel"><span>Game</span></span>
          <div className="backendStatus">
            <span>Detected BrownDust II</span>
            <strong>{gameVersionInfo?.version ?? "unknown"}</strong>
          </div>
        </div>
        <div className="field">
          <span className="fieldLabel"><span>Runtime</span></span>
          <div className="backendStatus">
            <span>{status?.injected ? "Injected" : "Not injected"} · {mountedMods.length} mounted</span>
            <strong>{status?.loaderAvailable ? "loader ready" : "loader missing"}</strong>
          </div>
        </div>
      </section>
    </>
  );

  const placeholderView = (key: ViewKey) => {
    const copy: Record<string, { icon: string; title: string; body: string }> = {
      roster: { icon: "🎭", title: "角色名冊 Roster", body: "把模組依角色聚合的牆面：每位角色顯示卡匣數量，點開可查看哪些作者為其製作模組（Discover），支援多 ID 角色與前 NPC。" },
      profiles: { icon: "💼", title: "卡匣盒 Profiles", body: "建立多組掛載組合，一鍵切換並同步進遊戲，並可匯入舊版 profile。底部的卡匣播放器會顯示目前載入的組合。" },
      preview: { icon: "👁️", title: "預覽 Preview", body: "內建 Spine 動畫檢視器，套用前先看模組的實際動作與外觀。" },
      stats: { icon: "📊", title: "統計 Stats", body: "模組總數、作者數、分類分布與最近活動的儀表板。" }
    };
    const c = copy[key];
    return (
      <section className="panel comingSoon">
        <div className="csIcon">{c.icon}</div>
        <h2>{c.title}</h2>
        <p>{c.body}</p>
        <span className="csTag">✦ 規劃中 · 設計書第 6 階段</span>
      </section>
    );
  };

  const dockFillPct = library.length > 0 ? Math.round((mountedMods.length / library.length) * 100) : 0;
  const dockSpinning = modsEnabled && mountedMods.length > 0;
  const applyDisabled = modsLocked || pendingChanges.length === 0 || hasConflict;
  const launchDisabled = busy || !appReady;

  const playerDock = (
    <div className={`dock ${modsEnabled ? "" : "is-off"}`} role="region" aria-label="Cartridge player">
      <div className="dockNow">
        <div className={`dockCover ${dockSpinning ? "spinning" : ""}`} aria-hidden="true" />
        <div className="dockMeta">
          <div className="dockEyebrow">Now Loading</div>
          <div className="dockTitle">
            {pendingChanges.length > 0
              ? `${pendingChanges.length} change${pendingChanges.length > 1 ? "s" : ""} staged`
              : mountedMods.length > 0
                ? `${mountedMods.length} cartridge${mountedMods.length > 1 ? "s" : ""} loaded`
                : "No cartridges loaded"}
          </div>
          <div className="dockSub">
            <span>{mountedMods.length} mounted</span>
            {hasConflict && <span className="conflict"> · conflict</span>}
            {!modsEnabled && <span className="off"> · mods off</span>}
            {gameRunning && <span className="warn"> · game running</span>}
          </div>
        </div>
      </div>

      <div className="dockTrack">
        <div className="dockBar"><div className="dockFill" style={{ width: `${dockFillPct}%` }} /></div>
        <div className="dockTimes"><span>{mountedMods.length} mounted</span><span>of {library.length} scanned</span></div>
      </div>

      <div className="dockControls">
        <button
          type="button"
          className={`dockBtn ${modsEnabled ? "on" : ""}`}
          disabled={busy}
          onClick={toggleModPower}
          title={modsEnabled ? "Mod Power: on — click to turn all mods off" : "Mod Power: off — click to restore mods"}
          aria-pressed={modsEnabled}
        >
          ⏻
        </button>
        <button
          type="button"
          className="dockBtn"
          disabled={busy || mountedMods.length === 0}
          onClick={restoreAll}
          title={mountedMods.length === 0 ? "No mounted mods to remove" : "Restore All — unmount every mounted cartridge"}
        >
          ↩
        </button>
        <span className="dockDivider" aria-hidden="true" />
        <button
          type="button"
          className="dockBtn apply"
          disabled={applyDisabled}
          onClick={applyChanges}
          title={versionLocked ? "Update BD-SpineX version" : hasConflict ? "Resolve same-key conflicts first" : pendingChanges.length === 0 ? "No staged changes" : "Apply staged changes"}
        >
          ▶ Apply{pendingChanges.length ? ` (${pendingChanges.length})` : ""}
        </button>
        <button
          type="button"
          className="dockBtn launch"
          disabled={launchDisabled}
          onClick={launchGame}
          title={appReady ? "Launch BrownDust II" : "PlayCover BrownDust II not ready"}
          aria-label="Launch game"
        >
          🚀
        </button>
      </div>
    </div>
  );

  return (
    <div className="appShell">
      <nav className="appRail">
        <div className="railBrand">
          <span className="railLogo">B</span>
          <div>
            <div className="railName">{appInfo.name}</div>
            <div className="railSub">{appInfo.subtitle}</div>
          </div>
        </div>

        <div className="railNav">
          {NAV_GROUPS.map((group) => (
            <div key={group.id}>
              <div className="railGroup">{group.label}</div>
              {NAV_ITEMS.filter((item) => item.group === group.id).map((item) => {
                const badge = item.key === "library" && pendingChanges.length > 0 ? pendingChanges.length : undefined;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`railItem ${view === item.key ? "active" : ""}`}
                    onClick={() => setView(item.key)}
                    aria-current={view === item.key ? "page" : undefined}
                  >
                    <span className="railIco" aria-hidden="true">{item.icon}</span>
                    <span className="railLabel">{item.label}</span>
                    {badge ? <span className="railBadge">{badge}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="railFoot">
          <div className="railStatus">
            <span className={`statusDot ${status?.injected ? "ok" : ""}`} aria-hidden="true" />
            <div>
              <div className="railStatusMain">{status?.injected ? "Runtime installed" : "Not installed"}</div>
              <div className="railStatusSub">{mountedMods.length} mounted{gameRunning ? " · running" : ""}</div>
            </div>
          </div>
          <span className={`railVersion ${versionLocked ? "locked" : ""}`} title={formatVersionTitle(appInfo, gameVersionInfo)}>
            {formatVersionBadge(appInfo, gameVersionInfo)}
          </span>
        </div>
      </nav>

      <main className="appMain">
        <div className="viewHead">
          <div>
            <h1>{activeNav.label}</h1>
            <div className="viewSub">BrownDust II Runtime Mod Loader · Mac PlayCover</div>
          </div>
          <div className="spacer" />
          <span className="statusPill" title={status?.injected ? "Loader installed" : "Loader not installed"}>
            {status?.injected ? "Runtime installed" : "Not installed"} · {mountedMods.length} mounted{gameRunning ? " · game running" : ""}
          </span>
        </div>

        {globalBanners}

        {view === "library" && libraryView}
        {view === "logs" && logView}
        {view === "settings" && settingsView}
        {view !== "library" && view !== "logs" && view !== "settings" && placeholderView(view)}

        {playerDock}
        {pendingDiffDock}
      </main>
    </div>
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

function makeAuthorRule(id: string, name: string, color: string, custom = false): AuthorRule {
  return {
    id,
    name,
    color,
    keywords: buildAuthorKeywords(id, name),
    custom
  };
}

function buildAuthorKeywords(id: string, name: string, extra: string[] = []) {
  const source = [
    id,
    name,
    id.replace(/[_-]+/g, " "),
    name.replace(/[._-]+/g, " "),
    compactForMatch(id),
    compactForMatch(name),
    ...extra
  ];
  return Array.from(new Set(source.map((value) => value.trim()).filter(Boolean)));
}

function normalizeAuthorId(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function normalizeForMatch(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function compactForMatch(value: string) {
  return normalizeForMatch(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function readAuthorRules(): AuthorRule[] {
  try {
    const raw = localStorage.getItem(AUTHOR_RULES_KEY);
    if (!raw) return DEFAULT_AUTHOR_RULES;
    const stored = JSON.parse(raw) as AuthorRule[];
    if (!Array.isArray(stored)) return DEFAULT_AUTHOR_RULES;

    const byId = new Map(stored.filter((rule) => rule && typeof rule.id === "string").map((rule) => [rule.id, rule]));
    const merged = DEFAULT_AUTHOR_RULES.map((base) => sanitizeAuthorRule({ ...base, ...byId.get(base.id), custom: false }, base));
    for (const rule of stored) {
      if (rule?.custom && !DEFAULT_AUTHOR_RULES.some((base) => base.id === rule.id)) {
        merged.push(sanitizeAuthorRule(rule));
      }
    }
    return merged;
  } catch {
    return DEFAULT_AUTHOR_RULES;
  }
}

function sanitizeAuthorRule(rule: Partial<AuthorRule>, fallback?: AuthorRule): AuthorRule {
  const name = (rule.name || fallback?.name || "Unknown").trim();
  const id = normalizeAuthorId(rule.id || fallback?.id || name) || "unknown";
  const color = /^#[0-9a-f]{6}$/i.test(rule.color || "") ? rule.color as string : fallback?.color || "#8d97aa";
  const keywords = buildAuthorKeywords(id, name, [...(fallback?.keywords ?? []), ...(Array.isArray(rule.keywords) ? rule.keywords : [])]);
  return { id, name, color, keywords, custom: Boolean(rule.custom) };
}

function persistAuthorRules(rules: AuthorRule[]) {
  localStorage.setItem(AUTHOR_RULES_KEY, JSON.stringify(rules));
}

function detectModAuthor(mod: RuntimeMod, authorRules: AuthorRule[]): DetectedAuthor {
  const meta = mod as RuntimeMod & { author?: string };
  if (meta.author) {
    const exact = authorRules.find((rule) => normalizeForMatch(rule.name) === normalizeForMatch(meta.author || "") || rule.id === normalizeAuthorId(meta.author || ""));
    return exact ? { id: exact.id, name: exact.name, color: exact.color } : { id: normalizeAuthorId(meta.author), name: meta.author, color: "#8d97aa" };
  }

  const target = `${mod.path} ${mod.folder} ${mod.key}`;
  const haystack = normalizeForMatch(target);
  const compactHaystack = compactForMatch(target);
  for (const rule of authorRules) {
    for (const keyword of rule.keywords) {
      if (matchesAuthorKeyword(haystack, compactHaystack, keyword)) {
        return { id: rule.id, name: rule.name, color: rule.color };
      }
    }
  }
  return { id: "unknown", name: "Unknown", color: "#8d97aa" };
}

function matchesAuthorKeyword(haystack: string, compactHaystack: string, keyword: string) {
  const normalized = normalizeForMatch(keyword);
  const compact = compactForMatch(keyword);
  if (!normalized && !compact) return false;
  if (/^[a-z0-9]{1,2}$/.test(compact)) {
    return haystack.split(/[^\p{L}\p{N}]+/u).includes(compact);
  }
  return (normalized && haystack.includes(normalized)) || (compact.length >= 3 && compactHaystack.includes(compact));
}

function categoryTypeIconPath(category: ModCategory) {
  const icon = category === "char" ? "standing" : category === "dating" ? "dating" : category === "cutscene" ? "cutscene" : "npc";
  return `/bd2modmanager-icons/${icon}.png`;
}

function categoryTypeLabel(category: ModCategory) {
  return category === "char" ? "Standing" : category === "dating" ? "Dating" : category === "cutscene" ? "Cutscene" : "NPC";
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

function Cartridge(props: {
  mod: RuntimeMod;
  have: boolean;
  selected: boolean;
  tone?: PendingTone;
  locked: boolean;
  onToggle: () => void;
  authorRules?: AuthorRule[];
}) {
  const { mod, have, selected, tone, locked, onToggle } = props;
  const category = typeToCategory(mod.type);
  const folderName = formatFolderName(mod.folder);
  const stateClass =
    tone === "conflict" ? "is-conflict" :
    tone === "added" ? "is-add" :
    tone === "removed" ? "is-remove" :
    have ? "is-mounted" : "";
  const status =
    tone === "conflict" ? "conflict · same key" :
    tone === "added" ? "staged · mount" :
    tone === "removed" ? "staged · unmount" :
    have ? "mounted" : "available";
  const title = `${folderName}\n${mod.key} · ${category}\n${have ? "mounted" : "available"}${mod.skeleton === "skel" ? "\nBinary .skel (converted to .json on mount when possible)" : ""}`;
  return (
    <button
      type="button"
      className={`cart cat-${category} ${stateClass} ${selected ? "is-selected" : ""}`}
      disabled={locked}
      onClick={onToggle}
      aria-pressed={selected}
      title={title}
    >
      <span className="cartCheck" aria-hidden="true">✓</span>
      <span className="cartLabel">
        <span className="cartArt" aria-hidden="true" />
        <span className="cartCap">{mod.key}</span>
      </span>
      <span className="cartBody">
        <span className="cartText">
          <span className="cartTitle">{folderName}</span>
          <span className="cartStatus">{status}</span>
        </span>
        <span className="cartCatDot" aria-hidden="true" />
      </span>
      <span className="cartPins" aria-hidden="true">
        <i /><i /><i /><i /><i /><i /><i /><i />
      </span>
    </button>
  );
}

// Skeuomorphic collector cartridge: type-colored handheld-game plastic with a
// printed mod label, top-left issue badge, optional wrapper/warning overlays,
// molded ridges, and a shallow bottom groove.
function CartridgeRealistic(props: {
  mod: RuntimeMod;
  have: boolean;
  selected: boolean;
  tone?: PendingTone;
  locked: boolean;
  onToggle: () => void;
  authorRules?: AuthorRule[];
}) {
  const { mod, have, selected, tone, locked, onToggle, authorRules = DEFAULT_AUTHOR_RULES } = props;
  const meta = mod as RuntimeMod & { author?: string; cover?: string };
  const category = typeToCategory(mod.type);
  const folderName = formatFolderName(mod.folder);
  const hasIssue = tone === "conflict" || mod.skeleton === "unknown";
  const mountBlocked = !have && mod.skeleton === "unknown";
  const stateClass =
    hasIssue ? "is-warning" :
    tone === "added" ? "is-add" :
    tone === "removed" ? "is-remove" :
    have ? "is-mounted" : "";
  const skinClass = `${hasIssue ? "is-problem" : ""} ${!have ? "is-wrapped" : ""}`;
  const pack = categoryPack(category);
  const typeIcon = categoryTypeIconPath(category);
  const typeLabel = categoryTypeLabel(category);
  const detectedAuthor = detectModAuthor(mod, authorRules);
  const showAuthorSticker = detectedAuthor.id !== "unknown";
  const authorStyle = { "--author-color": detectedAuthor.color } as CSSProperties;
  const displayTitle = cartridgeHeadline(folderName, mod.key);
  const runtimeLabel =
    tone === "conflict" ? "CONFLICT" :
    mod.skeleton === "unknown" ? "CHECK FILES" :
    tone === "added" ? "STAGED MOUNT" :
    tone === "removed" ? "STAGED UNMOUNT" :
    have ? "MOUNTED" : "AVAILABLE";
  const title = `${folderName}\n${mod.key} · ${category}\nAuthor: ${detectedAuthor.name}\n${have ? "mounted" : "available"}${mod.skeleton === "skel" ? "\nBinary .skel (converted to .json on mount when possible)" : ""}${mod.skeleton === "unknown" ? "\nMissing .json or .skel skeleton file" : ""}`;
  const coverStyle = meta.cover ? ({ "--rcart-cover": `url("${meta.cover}")` } as CSSProperties) : undefined;
  const podTone = tone === "removed" ? "minus" : have ? "check" : "plus";
  const podMark = podTone === "minus" ? "-" : podTone === "check" ? "✓" : "+";
  return (
    <button
      type="button"
      className={`rcart cat-${category} ${stateClass} ${skinClass} ${selected ? "is-on" : ""}`}
      disabled={locked || mountBlocked}
      onClick={onToggle}
      aria-pressed={selected}
      title={title}
    >
      <span className="rcartShell">
        <span className="rcartRidges" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
        <span className={`rcartNo rcartTypeBadge is-${category}`} aria-hidden="true" title={typeLabel}>
          <img src={typeIcon} alt="" draggable={false} />
        </span>
        <span className="rcartLabel">
          <span className="rcartArt" style={coverStyle} aria-hidden="true" />
          <span className="rcartAged" aria-hidden="true" />
          <span className="rcartGloss" aria-hidden="true" />
          <span className="rcartHead">
            <span className="rcartPack">{pack}</span>
            <span className="rcartCode">{mod.key}</span>
          </span>
          <span className="rcartTitle2">{displayTitle}</span>
          <span className="rcartCredits" aria-hidden="true">
            <span>ASSET {mod.key}</span>
            <span>{`MOD BY ${detectedAuthor.name.toUpperCase()}`}</span>
            <span>RUNTIME {runtimeLabel}</span>
          </span>
        </span>
        {showAuthorSticker ? (
          <span className="rcartAuthorSticker" style={authorStyle} aria-hidden="true">
            <span className="rcartAuthorLabel">Author</span>
            <strong><span className="rcartAuthorName">{detectedAuthor.name}</span></strong>
          </span>
        ) : null}
        <span className="rcartPlastic" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="rcartWarningSticker" aria-hidden="true">
          <svg className="rcartWarningIcon" viewBox="0 0 64 58" focusable="false">
            <path className="rcartWarningTriangle" d="M32 5 L59 52 H5 Z" />
            <path className="rcartWarningBang" d="M32 20 L32 36" />
            <circle className="rcartWarningDot" cx="32" cy="44" r="3" />
          </svg>
        </span>
        <span className="rcartBottomGroove" aria-hidden="true" />
      </span>
      <span className={`rcartPod is-${podTone} ${selected ? "on" : ""}`} aria-hidden="true"><span className="rcartPodMark">{podMark}</span></span>
      <span className="rcartNamePlate" aria-hidden="true">
        <span className="rcartNameKind">{pack}</span>
        <strong>{displayTitle}</strong>
      </span>
    </button>
  );
}

function categoryPack(category: ModCategory) {
  return category === "char" ? "CHARACTER PACK" : category === "dating" ? "DATING PACK" : category === "cutscene" ? "CUTSCENE PACK" : "NPC PACK";
}

function cartridgeHeadline(folderName: string, fallback: string) {
  const cleaned = folderName
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:rc|v)\s*\d+[a-z0-9.-]*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).split(" ").slice(0, 4).join(" ");
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
