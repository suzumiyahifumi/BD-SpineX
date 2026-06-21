import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, GameVersionInfo, LegacyRuntimeMigrationCheck } from "../../../core/types";
import type { PreviewSpineBundle, RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";

type ActionResult = { ok: boolean; message: string };

const noopUnsubscribe = () => {};

export const bd2Api = {
  getDefaultPaths: () => invoke<{ modsDir: string; sharedDir: string; dotnetPath: string }>("get_default_paths"),
  readSettings: async () => null as unknown,
  writeSettings: async (_settings: unknown) => true,
  openDetectedSharedFolder: async () => null as string | null,
  openRecordsFolder: async () => "",
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  detectGameVersion: (_sharedDir?: string) => invoke<GameVersionInfo>("detect_game_version"),
  selectDirectory: () => invoke<string | null>("select_directory"),

  scanMods: async () => ({ mods: [] }),
  scanShared: async () => ({ bundles: [] }),
  readSharedIndex: async () => ({ bundles: [] }),
  stopSharedScan: async () => true,
  onSharedScanProgress: () => noopUnsubscribe,
  createPatchPlan: async () => ({ plans: [] }),
  applyReadyPatches: async () => ({ entries: [] }),
  applyPatchStateChanges: async () => ({ entries: [] }),
  dryRunPatchStateChanges: async () => ({ entries: [] }),
  onPatchProgress: () => noopUnsubscribe,
  restoreAllPatches: async () => ({ entries: [] }),
  copyPatchBackupsForMods: async () => ({ entries: [] }),
  checkPatchDataForMods: async () => ({ ok: true, entries: [] }),
  ensureOriginalBackupsForMods: async () => ({ ok: true, entries: [] }),
  readPatchHistory: async () => ({ updatedAt: new Date().toISOString(), entries: [] }),
  readPreviousPatchedMods: async () => ({ modNames: [], sourceVersions: [] }),

  runtimeStatus: () => invoke<RuntimeStatus>("runtime_status"),
  runtimeMigrationCheck: () => invoke<LegacyRuntimeMigrationCheck>("runtime_migration_check"),
  runtimeUnpatchLegacy: async () => ({
    ok: true,
    status: "done",
    message: "Legacy patch migration is not included in the Tauri runtime-only build.",
    restoredBundles: [],
    mountedMods: [],
    missingMods: [],
    removedPaths: [],
    errors: []
  }),
  runtimeMigrateLegacy: async (_modsDir: string) => ({
    ok: true,
    status: "done",
    message: "Legacy patch migration is not included in the Tauri runtime-only build.",
    restoredBundles: [],
    mountedMods: [],
    missingMods: [],
    removedPaths: [],
    errors: []
  }),
  runtimeInstall: () => invoke<ActionResult>("runtime_install"),
  runtimeUninstall: () => invoke<ActionResult>("runtime_uninstall"),
  runtimeSetEnabled: (enabled: boolean) => invoke<ActionResult>("runtime_set_enabled", { enabled }),
  runtimeListLibrary: (dir: string) => invoke<RuntimeMod[]>("runtime_list_library", { dir }),
  runtimePreviewSpine: (srcDir: string, key: string) => invoke<PreviewSpineBundle>("runtime_preview_spine", { srcDir, key }),
  runtimeMount: (srcDir: string, folder?: string) => invoke<ActionResult>("runtime_mount", { srcDir, folder }),
  runtimeUnmount: (folder: string) => invoke<ActionResult>("runtime_unmount", { folder }),
  runtimeLaunch: () => invoke<ActionResult>("runtime_launch"),
  startWindowDrag: () => invoke<void>("start_window_drag")
};

export type Bd2Api = typeof bd2Api;
