import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppInfo, GameVersionInfo } from "../../../core/types";
import type { RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

// ===== Runtime-based BD-SpineX =====
// 沿用舊 UI/UX（勾選 → Apply Changes → log → 鎖定 + 版本徽章），
// 但核心改為「執行時掛載」：注入 loader + 把選取的 mod 掛載進遊戲讀取目錄。
// 舊的離線 __data Patch 版本保留在 git 歷史。

type LogEntry = { id: string; time: string; message: string; tone?: "ok" | "warn" | "err" };

const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "Runtime Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };
const MODSDIR_KEY = "bd-spinex:runtime-modsdir";

const TYPE_LABEL: Record<RuntimeMod["type"], string> = {
  standing: "Standing",
  dating: "Dating",
  skillcut: "Skillcut",
  other: "Other"
};

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo);
  const [gameVersionInfo, setGameVersionInfo] = useState<GameVersionInfo | null>(null);
  const [modsDir, setModsDir] = useState<string>("");
  const [library, setLibrary] = useState<RuntimeMod[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [desired, setDesired] = useState<Record<string, boolean>>({}); // folder -> mounted?
  const [logs, setLogs] = useState<LogEntry[]>(() => [createLogEntry("Ready.")]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const log = useCallback((message: string, tone?: LogEntry["tone"]) => pushLog(setLogs, message, tone), []);

  const refreshStatus = useCallback(async () => {
    const s = await window.bd2.runtimeStatus();
    setStatus(s);
    return s;
  }, []);

  const scanLibrary = useCallback(
    async (dir: string) => {
      if (!dir) {
        setLibrary([]);
        return;
      }
      const mods = await window.bd2.runtimeListLibrary(dir);
      setLibrary(mods);
      log(`Scanned ${mods.length} mod(s) in mods folder.`);
    },
    [log]
  );

  // 初始化
  useEffect(() => {
    void (async () => {
      try {
        setAppInfo(await window.bd2.getAppInfo());
      } catch { /* ignore */ }
      try {
        setGameVersionInfo(await window.bd2.detectGameVersion());
      } catch { /* ignore */ }
      const s = await refreshStatus();
      const saved = localStorage.getItem(MODSDIR_KEY) ?? "";
      if (saved) {
        setModsDir(saved);
        await scanLibrary(saved);
      }
      // 初始 desired = 目前已掛載
      const mountedFolders = new Set((s?.mountedMods ?? []).map((m) => m.folder));
      setDesired(Object.fromEntries([...mountedFolders].map((f) => [f, true])));
    })();
  }, [refreshStatus, scanLibrary]);

  const mountedFolders = useMemo(() => new Set((status?.mountedMods ?? []).map((m) => m.folder)), [status]);

  // desired state（預設：已掛載者為 true）
  const isDesired = useCallback(
    (folder: string) => desired[folder] ?? mountedFolders.has(folder),
    [desired, mountedFolders]
  );

  const visibleMods = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? library.filter((m) => m.folder.toLowerCase().includes(f) || m.key.toLowerCase().includes(f)) : library;
    return [...list].sort((a, b) => a.folder.localeCompare(b.folder));
  }, [library, filter]);

  // 待套用變更：desired != actual(mounted)
  const pendingChanges = useMemo(() => {
    const changes: { mod: RuntimeMod; action: "mount" | "unmount" }[] = [];
    for (const mod of library) {
      const want = isDesired(mod.folder);
      const have = mountedFolders.has(mod.folder);
      if (want && !have) changes.push({ mod, action: "mount" });
      else if (!want && have) changes.push({ mod, action: "unmount" });
    }
    // 已掛載但不在 library（庫資料夾換過）→ 也允許卸載
    for (const m of status?.mountedMods ?? []) {
      if (!library.some((l) => l.folder === m.folder) && !isDesired(m.folder)) {
        changes.push({ mod: m, action: "unmount" });
      }
    }
    return changes;
  }, [library, status, mountedFolders, isDesired]);

  const versionMismatch = isGameVersionMismatch(appInfo, gameVersionInfo);
  const versionLocked = versionMismatch;
  const appReady = Boolean(status?.appFound && status?.loaderAvailable);
  const controlsLocked = busy || versionLocked || !appReady;

  const selectDir = useCallback(async () => {
    const dir = await window.bd2.selectDirectory();
    if (!dir) return;
    setModsDir(dir);
    localStorage.setItem(MODSDIR_KEY, dir);
    await scanLibrary(dir);
  }, [scanLibrary]);

  const toggle = useCallback((folder: string, value: boolean) => {
    setDesired((prev) => ({ ...prev, [folder]: value }));
  }, []);

  const allChecked = visibleMods.length > 0 && visibleMods.every((m) => isDesired(m.folder));
  const toggleAll = useCallback(
    (value: boolean) => {
      setDesired((prev) => {
        const next = { ...prev };
        for (const m of visibleMods) next[m.folder] = value;
        return next;
      });
    },
    [visibleMods]
  );

  const runTask = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        log(`Error: ${String(e)}`, "err");
      } finally {
        setBusy(false);
        await refreshStatus();
      }
    },
    [log, refreshStatus]
  );

  const applyChanges = useCallback(() => {
    void runTask(async () => {
      // 1) 確保 loader 已注入
      if (!status?.injected) {
        log("Installing runtime loader…");
        const r = await window.bd2.runtimeInstall();
        log(r.message, r.ok ? "ok" : "err");
        if (!r.ok) return;
      }
      // 2) 套用掛載/卸載差異
      let mounted = 0;
      let unmounted = 0;
      for (const change of pendingChanges) {
        if (change.action === "mount") {
          const r = await window.bd2.runtimeMount(change.mod.path);
          log(r.message, r.ok ? "ok" : "err");
          if (r.ok) mounted++;
        } else {
          const r = await window.bd2.runtimeUnmount(change.mod.folder);
          log(r.message, r.ok ? "ok" : "warn");
          if (r.ok) unmounted++;
        }
      }
      log(`Applied: ${mounted} mounted, ${unmounted} unmounted. 重新啟動遊戲以套用。`, "ok");
    });
  }, [runTask, status, pendingChanges, log]);

  const restoreAll = useCallback(() => {
    void runTask(async () => {
      for (const m of status?.mountedMods ?? []) {
        const r = await window.bd2.runtimeUnmount(m.folder);
        log(r.message, r.ok ? "ok" : "warn");
      }
      const u = await window.bd2.runtimeUninstall();
      log(u.message, u.ok ? "ok" : "warn");
      setDesired({});
    });
  }, [runTask, status, log]);

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
              BD-SpineX 的版本需與 BrownDust II 遊戲版本相符（執行時 hook 綁定 IL2CPP 位址）。不符時掛載操作會鎖定，直到使用相符的版本。
            </HelpButton>
          </p>
          <p>BrownDust II Runtime Mod Loader | Mac PlayCover</p>
        </div>
        <div className="statusPill" title={status?.injected ? "Loader installed" : "Loader not installed"}>
          {status?.injected ? "✅ Runtime 已安裝" : "⚪ Runtime 未安裝"} · {status?.mountedMods.length ?? 0} mounted
        </div>
      </header>

      {versionLocked && (
        <section className="panel">
          <div className="errorPill">
            版本不符：管理器支援 {appInfo.supportedGameVersion}，偵測到遊戲 {gameVersionInfo?.version ?? "?"}。請使用相符的 BD-SpineX 版本。
          </div>
        </section>
      )}
      {!status?.appFound && (
        <section className="panel"><div className="errorPill">找不到 PlayCover 的 BrownDust II。</div></section>
      )}
      {status && !status.loaderAvailable && (
        <section className="panel"><div className="errorPill">找不到 loader（開發模式需先 build：cargo build --release）。</div></section>
      )}

      {/* 設定：只保留 Mods Folder */}
      <section className="panel settingsGrid">
        <PathField
          label="Mods Folder"
          helpTitle="Mods Folder"
          helpText="選擇含 mod 的資料夾。每個 mod 子資料夾需含 .atlas（及 .json/.skel/.png）。勾選後按 Apply Changes 掛載。"
          value={modsDir}
          onChange={(v) => setModsDir(v)}
          onBrowse={selectDir}
          invalid={!modsDir}
        />
      </section>

      {/* Mods 表格 */}
      <section className="panel tablePanel modsPanel">
        <div className="tableHeader">
          <div className="tableTitle">
            <h2>Mods</h2>
            <div className="tableHint">{visibleMods.length} shown / {library.length} scanned · {status?.mountedMods.length ?? 0} mounted</div>
          </div>
          <div className="tableHeaderActions">
            <input className="modFilterField" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button disabled={busy || !modsDir} onClick={() => void scanLibrary(modsDir)}>Rescan</button>
          </div>
        </div>

        <div className={`modsTableFrame ${busy ? "locked" : ""}`}>
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allChecked} disabled={controlsLocked || visibleMods.length === 0} onChange={(e) => toggleAll(e.target.checked)} />
                </th>
                <th>Folder</th>
                <th>Key</th>
                <th>Type</th>
                <th>Skeleton</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleMods.map((mod) => {
                const want = isDesired(mod.folder);
                const have = mountedFolders.has(mod.folder);
                const changed = want !== have;
                return (
                  <tr key={mod.path} className={changed ? "changed" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={want}
                        disabled={controlsLocked}
                        onChange={(e) => toggle(mod.folder, e.target.checked)}
                      />
                    </td>
                    <td className="folderCell">{mod.folder}</td>
                    <td><code>{mod.key}</code></td>
                    <td><span className={`categoryBadge ${mod.type}`}>{TYPE_LABEL[mod.type]}</span></td>
                    <td>{mod.skeleton}{mod.skeleton === "skel" ? " → json" : ""}</td>
                    <td>{have ? <span className="badge enabled">mounted</span> : <span className="badge">—</span>}</td>
                  </tr>
                );
              })}
              {visibleMods.length === 0 && (
                <tr><td colSpan={6} className="empty">{modsDir ? "沒有找到 mod。" : "請先選擇 Mods Folder。"}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="modsHeaderControls" style={{ display: "flex", gap: 8, padding: "10px 4px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            disabled={controlsLocked || pendingChanges.length === 0}
            onClick={applyChanges}
            title={versionLocked ? "Update BD-SpineX version" : pendingChanges.length === 0 ? "沒有待套用變更" : ""}
          >
            Apply Changes{pendingChanges.length ? ` (${pendingChanges.length})` : ""}
          </button>
          <button disabled={busy || !appReady} onClick={launchGame}>啟動遊戲</button>
          <button disabled={busy || (!status?.injected && (status?.mountedMods.length ?? 0) === 0)} onClick={restoreAll}>
            全部還原（卸載全部 + 移除注入）
          </button>
          {busy && <span className="hint">Action running…</span>}
          {versionLocked && <span className="hint">Update BD-SpineX version</span>}
        </div>
      </section>

      {/* Log */}
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

// ===== helpers / 小元件（沿用舊版外觀） =====
function pushLog(setLogs: Dispatch<SetStateAction<LogEntry[]>>, message: string, tone?: LogEntry["tone"]) {
  setLogs((current) => [createLogEntry(message, tone), ...current].slice(0, 200));
}
function createLogEntry(message: string, tone?: LogEntry["tone"]): LogEntry {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time: new Date().toLocaleTimeString(), message, tone };
}

function normalizeVersionForCompare(version?: string) {
  return version?.trim().replace(/^v/i, "").split(/[+-]/)[0];
}
function formatVersionBadge(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const managerVersion = `v${appInfo.version}`;
  const gameVersion = gameVersionInfo?.version;
  const supported = appInfo.supportedGameVersion || appInfo.version;
  return gameVersion && normalizeVersionForCompare(gameVersion) !== normalizeVersionForCompare(supported)
    ? `${managerVersion} [${gameVersion}]`
    : managerVersion;
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

function PathField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse?: () => void;
  invalid?: boolean;
  helpTitle?: string;
  helpText?: string;
}) {
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
    function onDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
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
