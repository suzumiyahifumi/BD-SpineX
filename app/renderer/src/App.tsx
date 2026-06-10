import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppInfo, GameVersionInfo } from "../../../core/types";
import type { RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

// ===== Runtime-based BD-SpineX（沿用舊離線 Patch 版的 UI/UX，核心改為執行時掛載） =====

type LogEntry = { id: string; time: string; message: string; tone?: "ok" | "warn" | "err" };
type ModSortKey = "folder" | "name" | "category" | "status";
type ModSort = { key: ModSortKey; direction: "asc" | "desc" };
type ModCategory = "char" | "dating" | "cutscene" | "other";
type PendingTone = "added" | "removed" | "conflict";
type RuntimeChange = { folder: string; key: string; enabled: boolean; implicit?: boolean; conflict?: boolean };

const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "Runtime Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };
const MODSDIR_KEY = "bd-spinex:runtime-modsdir";

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
      await refreshStatus();
      const saved = localStorage.getItem(MODSDIR_KEY) ?? "";
      if (saved) { setModsDir(saved); await scanLibrary(saved); }
    })();
  }, [refreshStatus, scanLibrary]);

  const mountedMods = useMemo(() => status?.mountedMods ?? [], [status]);
  const mountedFolders = useMemo(() => new Set(mountedMods.map((m) => m.folder)), [mountedMods]);
  const isDesired = useCallback((folder: string) => desired[folder] ?? mountedFolders.has(folder), [desired, mountedFolders]);

  const visibleMods = useMemo(() => filterAndSortMods(library, modFilter, modSort, mountedFolders), [library, modFilter, modSort, mountedFolders]);

  // 待套用變更（含同 key 自動移除）
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
  const missingModsDir = !modsDir;
  const modsActionLocked = busy;
  const modsLocked = busy || versionLocked || !appReady;

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
    void runTask(async () => {
      const r = await window.bd2.runtimeInstall();
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, log]);

  const uninstallLoader = useCallback(() => {
    void runTask(async () => {
      const r = await window.bd2.runtimeUninstall();
      log(r.message, r.ok ? "ok" : "warn");
    });
  }, [runTask, log]);

  const applyChanges = useCallback(() => {
    void runTask(async () => {
      if (pendingChanges.length === 0 || hasConflict) return;
      const byFolder = new Map(library.map((m) => [m.folder, m]));
      let mounted = 0, unmounted = 0;
      // 先卸載（含 auto），再掛載，避免同 key 衝突
      for (const c of pendingChanges.filter((c) => !c.enabled)) {
        const r = await window.bd2.runtimeUnmount(c.folder);
        log(`${r.message}${c.implicit ? " (auto)" : ""}`, r.ok ? "ok" : "warn");
        if (r.ok) unmounted++;
      }
      for (const c of pendingChanges.filter((c) => c.enabled)) {
        const mod = byFolder.get(c.folder);
        if (!mod) continue;
        const r = await window.bd2.runtimeMount(mod.path);
        log(r.message, r.ok ? "ok" : "err");
        if (r.ok) mounted++;
      }
      setDesired({});
      log(`Applied: ${mounted} mounted, ${unmounted} unmounted. 重新啟動遊戲以套用。`, "ok");
      if (mounted > 0 && !status?.injected) {
        log("提醒：尚未啟用 Runtime 注入，掛載的 mod 不會生效。請在設定區開啟注入。", "warn");
      }
    });
  }, [runTask, pendingChanges, hasConflict, status, library, log]);

  const restoreAll = useCallback(() => {
    void runTask(async () => {
      for (const m of mountedMods) {
        const r = await window.bd2.runtimeUnmount(m.folder);
        log(r.message, r.ok ? "ok" : "warn");
      }
      const u = await window.bd2.runtimeUninstall();
      log(u.message, u.ok ? "ok" : "warn");
      setDesired({});
    });
  }, [runTask, mountedMods, log]);

  const launchGame = useCallback(() => {
    void runTask(async () => {
      const r = await window.bd2.runtimeLaunch();
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, log]);

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
              BD-SpineX 的版本需與 BrownDust II 遊戲版本相符（執行時 hook 綁定 IL2CPP 位址）。不符時掛載操作會鎖定。
            </HelpButton>
          </p>
          <p>BrownDust II Runtime Mod Loader | Mac PlayCover</p>
        </div>
        <div className="statusPill" title={status?.injected ? "Loader installed" : "Loader not installed"}>
          {status?.injected ? "✅ Runtime 已安裝" : "⚪ 未安裝"} · {mountedMods.length} mounted
        </div>
      </header>

      {versionLocked && (
        <section className="panel"><div className="errorPill">版本不符：管理器支援 {appInfo.supportedGameVersion}，偵測到遊戲 {gameVersionInfo?.version ?? "?"}。請使用相符的 BD-SpineX 版本。</div></section>
      )}
      {status && !status.appFound && (<section className="panel"><div className="errorPill">找不到 PlayCover 的 BrownDust II。</div></section>)}
      {status && !status.loaderAvailable && (<section className="panel"><div className="errorPill">找不到 loader（開發模式需先 build：cargo build --release）。</div></section>)}

      <section className="panel settingsGrid">
        <PathField
          label="Mods Folder"
          helpTitle="Mods Folder"
          helpText="選擇含 mod 的資料夾。勾選後按 Apply Changes 掛載；取消勾選已掛載的 mod 則卸載。勾選與已掛載的同 key mod 衝突時，會自動把舊的加入移除計劃。"
          value={modsDir}
          onChange={(v) => setModsDir(v)}
          onBrowse={selectDir}
          invalid={missingModsDir}
        />
        <div className="field">
          <span className="fieldLabel">
            <span>Runtime 注入 (BepInEx)</span>
            <HelpButton title="Runtime 注入">
              注入會把 loader 加進遊戲主程式（備份原檔 + 重簽），啟動遊戲後才會載入並套用掛載的 mod。移除注入會還原原始主程式（已掛載的 mod 檔仍保留，重新注入即恢復）。遊戲更新後需重新注入。
            </HelpButton>
          </span>
          <div className="pathRow">
            <span className={`badge ${status?.injected ? "patched" : ""}`} style={{ alignSelf: "center" }}>
              {status?.injected ? "已注入" : "未注入"}
            </span>
            <button type="button" disabled={busy || !appReady || Boolean(status?.injected)} onClick={installLoader}>安裝注入</button>
            <button type="button" disabled={busy || !status?.injected} onClick={uninstallLoader}>移除注入</button>
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
                  勾選 mod 以掛載、取消勾選已掛載的以卸載。排序、篩選、捲動在操作鎖定時仍可使用。
                </HelpButton>
              </div>
              <div className="tableHint">{visibleMods.length} shown / {library.length} scanned</div>
            </div>
            <div className="modsHeaderControls">
              <button disabled={busy || modsLocked || !hasChanges} onClick={resetChanges} title="還原 Apply 前的勾選狀態" type="button">
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
                  <tr><td colSpan={5} className="empty">{modsDir ? "沒有找到 mod。" : "請先選擇 Mods Folder。"}</td></tr>
                ) : visibleMods.length === 0 ? (
                  <tr><td colSpan={5} className="empty">No mods match this filter.</td></tr>
                ) : visibleMods.map((mod) => {
                  const tone = tones[mod.folder];
                  const have = mountedFolders.has(mod.folder);
                  const category = typeToCategory(mod.type);
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
                      <td className="folderCell" title={mod.folder}>{mod.folder}</td>
                      <td title={mod.key}><code>{mod.key}</code></td>
                      <td><span className={`categoryBadge ${category}`}>{category}</span></td>
                      <td title={mod.skeleton === "skel" ? "二進位 skel（掛載時自動轉 json）" : ""}>
                        <span className={`badge ${have ? "patched" : "ready"}`}>{have ? "mounted" : "available"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {modsLocked && (
              <div className="modsLockOverlay" aria-hidden="true">
                <span>{versionLocked ? "Update BD-SpineX version" : !appReady ? "PlayCover BrownDust II / loader not found" : missingModsDir ? "Select a Mods Folder" : modsActionLocked ? "Action running" : ""}</span>
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
              此表顯示按下 Apply Changes 後會發生的變更。標 (auto) 的列是因為與你勾選的 mod 共用相同資產（key），系統自動把舊的加入移除。Apply 前不會更動遊戲。
            </HelpButton>
          </div>
          <table>
            <thead>
              <tr><th>Mod</th><th>Mode</th><th>Current</th><th>Desired</th></tr>
            </thead>
            <tbody>
              {pendingChanges.length === 0 ? (
                <tr><td colSpan={4} className="empty">勾選 mod 或取消已掛載的 mod 以建立變更。</td></tr>
              ) : pendingChanges.map((c) => (
                <tr key={c.folder} className={`pendingPatchChange ${formatPendingToneClass(tones[c.folder])}`}>
                  <td>{c.folder}{c.implicit ? " (auto)" : ""}</td>
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
              Apply Changes 會確保 loader 已注入，再套用掛載/卸載差異。操作期間會鎖定勾選以保持一致。
            </HelpButton>
          </div>
          <div className="actionButtons" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              disabled={modsLocked || pendingChanges.length === 0 || hasConflict}
              onClick={applyChanges}
              title={versionLocked ? "Update BD-SpineX version" : hasConflict ? "有同 key 衝突，請先解決" : pendingChanges.length === 0 ? "沒有待套用變更" : ""}
            >
              Apply Changes{pendingChanges.length ? ` (${pendingChanges.length})` : ""}
            </button>
            <button disabled={busy || !appReady} onClick={launchGame}>啟動遊戲</button>
            <button disabled={busy || (!status?.injected && mountedMods.length === 0)} onClick={restoreAll}>
              全部還原（卸載全部 + 移除注入）
            </button>
            {hasConflict && <p className="hint">⚠️ 有多個相同 key 的 mod 同時勾選（紫色列），請只保留一個才能 Apply。</p>}
            {busy && <p className="hint">Action running…</p>}
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
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time: new Date().toLocaleTimeString(), message, tone };
}
function formatBool(v: boolean) { return v ? "On" : "Off"; }
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
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  return (
    <span className="helpRoot" ref={rootRef}>
      <button type="button" className="helpButton" onClick={() => setOpen((v) => !v)} aria-label={`Help: ${props.title}`}>?</button>
      {open && (
        <span className="helpPopup below">
          <span className="helpPopupTitle">{props.title}</span>
          <span className="helpPopupText">{props.children}</span>
        </span>
      )}
    </span>
  );
}
