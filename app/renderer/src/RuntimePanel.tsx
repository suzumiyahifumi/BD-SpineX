import { useCallback, useEffect, useState } from "react";
import type { RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

const TYPE_LABEL: Record<RuntimeMod["type"], string> = {
  standing: "Standing",
  dating: "Dating",
  skillcut: "Skillcut",
  other: "Other"
};

export function RuntimePanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [libraryDir, setLibraryDir] = useState<string>("");
  const [library, setLibrary] = useState<RuntimeMod[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");

  const refreshStatus = useCallback(async () => {
    const s = await window.bd2.runtimeStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  const run = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
      setBusy(true);
      setMessage(`${label}…`);
      try {
        const r = await fn();
        setMessage(r.message);
      } catch (e) {
        setMessage(`${label} 失敗：${String(e)}`);
      } finally {
        setBusy(false);
        await refreshStatus();
      }
    },
    [refreshStatus]
  );

  const pickLibrary = useCallback(async () => {
    const dir = await window.bd2.selectDirectory();
    if (!dir) return;
    setLibraryDir(dir);
    setBusy(true);
    try {
      setLibrary(await window.bd2.runtimeListLibrary(dir));
    } finally {
      setBusy(false);
    }
  }, []);

  const mountedKeys = new Set((status?.mountedMods ?? []).map((m) => m.key));

  return (
    <section className="panel">
      <div className="tableHeader" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <div className="tableTitle">
          <h2>🧩 Runtime Mods (BepInEx) — Beta {open ? "▾" : "▸"}</h2>
        </div>
        <div className="tableHint">
          {status?.injected ? "已安裝注入" : "未安裝"} · {status?.mountedMods.length ?? 0} 已掛載
        </div>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 4px" }}>
          <p style={{ opacity: 0.8, fontSize: 13 }}>
            執行時掛載 Spine mod，不需 Patch <code>__data</code>。安裝注入後，啟動遊戲即會套用「已掛載」的 mod。
            （目前 JSON mod 全可；二進位 <code>.skel</code> 約會仍實驗中。）
          </p>

          {!status?.appFound && <div className="errorPill">找不到 PlayCover 的 BrownDust II app。</div>}
          {!status?.loaderAvailable && (
            <div className="errorPill">找不到 loader dylib（dev 需先 build：cargo build --release）。</div>
          )}

          {/* 注入控制 */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button disabled={busy || !status?.appFound || !status?.loaderAvailable} onClick={() => run("安裝注入", () => window.bd2.runtimeInstall())}>
              安裝 Runtime 注入
            </button>
            <button disabled={busy || !status?.injected} onClick={() => run("移除注入", () => window.bd2.runtimeUninstall())}>
              移除注入
            </button>
            <button disabled={busy || !status?.appFound} onClick={() => run("啟動遊戲", () => window.bd2.runtimeLaunch())}>
              啟動遊戲
            </button>
            <span className="statusPill">{status?.injected ? "✅ 已注入" : "⚪ 未注入"}</span>
          </div>

          {/* 已掛載 */}
          <div>
            <div className="tableHint" style={{ marginBottom: 4 }}>已掛載的 mod（遊戲會讀取）：{status?.mountDir}</div>
            {(status?.mountedMods.length ?? 0) === 0 ? (
              <div style={{ opacity: 0.6, fontSize: 13 }}>（尚未掛載）</div>
            ) : (
              <table>
                <thead>
                  <tr><th>資料夾</th><th>Key</th><th>類型</th><th>骨架</th><th></th></tr>
                </thead>
                <tbody>
                  {status!.mountedMods.map((m) => (
                    <tr key={m.folder}>
                      <td>{m.folder}</td>
                      <td><code>{m.key}</code></td>
                      <td>{TYPE_LABEL[m.type]}</td>
                      <td>{m.skeleton}</td>
                      <td>
                        <button disabled={busy} onClick={() => run("卸載", () => window.bd2.runtimeUnmount(m.folder))}>卸載</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Mod 庫 */}
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <button disabled={busy} onClick={pickLibrary}>選擇 Mod 庫資料夾</button>
              <span className="tableHint">{libraryDir || "（未選）"}</span>
            </div>
            {library.length > 0 && (
              <table>
                <thead>
                  <tr><th>資料夾</th><th>Key</th><th>類型</th><th>骨架</th><th></th></tr>
                </thead>
                <tbody>
                  {library.map((m) => {
                    const isMounted = mountedKeys.has(m.key);
                    return (
                      <tr key={m.path}>
                        <td>{m.folder}</td>
                        <td><code>{m.key}</code></td>
                        <td>{TYPE_LABEL[m.type]}</td>
                        <td>{m.skeleton}</td>
                        <td>
                          <button disabled={busy || isMounted} onClick={() => run("掛載", () => window.bd2.runtimeMount(m.path))}>
                            {isMounted ? "已掛載" : "掛載"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {message && <div className="tableHint">{message}</div>}
        </div>
      )}
    </section>
  );
}
