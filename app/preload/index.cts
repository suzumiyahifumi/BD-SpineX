import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo, ApplyPatchOptions, ApplyPatchResult, GameVersionInfo, ModsIndex, PatchDataCheckResult, PatchHistory, PatchPlanEntry, PatchPlanIndex, PatchProgress, PatchStateChange, PreviousPatchedMods, SharedIndex, SharedScanOptions, SharedScanProgress } from "../../core/types.js";
import type { RuntimeMod, RuntimeStatus } from "../../core/runtime-loader.js";

const api = {
  getDefaultPaths: () => ipcRenderer.invoke("app:default-paths") as Promise<{ modsDir: string; sharedDir: string; dotnetPath: string }>,
  readSettings: () => ipcRenderer.invoke("app:read-settings") as Promise<unknown>,
  writeSettings: (settings: unknown) => ipcRenderer.invoke("app:write-settings", settings) as Promise<boolean>,
  openDetectedSharedFolder: () => ipcRenderer.invoke("app:open-detected-shared-folder") as Promise<string | null>,
  openRecordsFolder: () => ipcRenderer.invoke("app:open-records-folder") as Promise<string>,
  getAppInfo: () => ipcRenderer.invoke("app:info") as Promise<AppInfo>,
  detectGameVersion: (sharedDir?: string) => ipcRenderer.invoke("game:detect-version", { sharedDir }) as Promise<GameVersionInfo>,
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory") as Promise<string | null>,
  scanMods: (modsDir: string) => ipcRenderer.invoke("mods:scan", modsDir) as Promise<ModsIndex>,
  scanShared: (sharedDir: string, options?: SharedScanOptions) =>
    ipcRenderer.invoke("shared:scan", { sharedDir, options }) as Promise<SharedIndex>,
  readSharedIndex: (sharedDir?: string) => ipcRenderer.invoke("shared:read-index", sharedDir) as Promise<SharedIndex>,
  stopSharedScan: () => ipcRenderer.invoke("shared:stop-scan") as Promise<boolean>,
  onSharedScanProgress: (callback: (progress: SharedScanProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SharedScanProgress) => callback(progress);
    ipcRenderer.on("shared:scan-progress", listener);
    return () => {
      ipcRenderer.removeListener("shared:scan-progress", listener);
    };
  },
  createPatchPlan: (sharedIndex: SharedIndex, modsIndex: ModsIndex) =>
    ipcRenderer.invoke("patch-plan:create", { sharedIndex, modsIndex }) as Promise<PatchPlanIndex>,
  applyReadyPatches: (plans: PatchPlanEntry[], modsIndex: ModsIndex, options: ApplyPatchOptions) =>
    ipcRenderer.invoke("patch:apply-ready", { plans, modsIndex, options }) as Promise<ApplyPatchResult>,
  applyPatchStateChanges: (plans: PatchPlanEntry[], modsIndex: ModsIndex, changes: PatchStateChange[], options: ApplyPatchOptions) =>
    ipcRenderer.invoke("patch:apply-state-changes", { plans, modsIndex, changes, options }) as Promise<ApplyPatchResult>,
  dryRunPatchStateChanges: (plans: PatchPlanEntry[], modsIndex: ModsIndex, changes: PatchStateChange[], options: ApplyPatchOptions) =>
    ipcRenderer.invoke("patch:dry-run-state-changes", { plans, modsIndex, changes, options }) as Promise<ApplyPatchResult>,
  onPatchProgress: (callback: (progress: PatchProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: PatchProgress) => callback(progress);
    ipcRenderer.on("patch:progress", listener);
    return () => {
      ipcRenderer.removeListener("patch:progress", listener);
    };
  },
  restoreAllPatches: (plans: PatchPlanEntry[]) =>
    ipcRenderer.invoke("patch:restore-all", { plans }) as Promise<ApplyPatchResult>,
  copyPatchBackupsForMods: (plans: PatchPlanEntry[], modNames: string[], source: "original" | "patched") =>
    ipcRenderer.invoke("patch:copy-backups-for-mods", { plans, modNames, source }) as Promise<ApplyPatchResult>,
  checkPatchDataForMods: (plans: PatchPlanEntry[], modNames: string[]) =>
    ipcRenderer.invoke("patch:check-data-for-mods", { plans, modNames }) as Promise<PatchDataCheckResult>,
  ensureOriginalBackupsForMods: (plans: PatchPlanEntry[], modsIndex: ModsIndex, modNames: string[], options: ApplyPatchOptions) =>
    ipcRenderer.invoke("patch:ensure-original-backups-for-mods", { plans, modsIndex, modNames, options }) as Promise<PatchDataCheckResult>,
  readPatchHistory: () => ipcRenderer.invoke("patch:history") as Promise<PatchHistory>,
  readPreviousPatchedMods: () => ipcRenderer.invoke("patch:previous-patched-mods") as Promise<PreviousPatchedMods>,
  // --- Runtime (BepInEx-for-PlayCover) ---
  runtimeStatus: () => ipcRenderer.invoke("runtime:status") as Promise<RuntimeStatus>,
  runtimeInstall: () => ipcRenderer.invoke("runtime:install") as Promise<{ ok: boolean; message: string }>,
  runtimeUninstall: () => ipcRenderer.invoke("runtime:uninstall") as Promise<{ ok: boolean; message: string }>,
  runtimeListLibrary: (dir: string) => ipcRenderer.invoke("runtime:list-library", dir) as Promise<RuntimeMod[]>,
  runtimeMount: (srcDir: string) => ipcRenderer.invoke("runtime:mount", srcDir) as Promise<{ ok: boolean; message: string }>,
  runtimeUnmount: (folder: string) => ipcRenderer.invoke("runtime:unmount", folder) as Promise<{ ok: boolean; message: string }>,
  runtimeLaunch: () => ipcRenderer.invoke("runtime:launch") as Promise<{ ok: boolean; message: string }>
};

contextBridge.exposeInMainWorld("bd2", api);

export type Bd2Api = typeof api;
