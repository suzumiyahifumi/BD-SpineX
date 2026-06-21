import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanMods } from "../../core/mod-indexer.js";
import { createPatchPlan } from "../../core/patch-plan.js";
import { applyPatchStateChanges, applyReadyPatches, checkPatchDataForMods, copyPatchBackupsForMods, dryRunPatchStateChanges, ensureOriginalBackupsForMods, readPatchHistory, readPreviousPatchedMods, restoreAllPatches } from "../../core/patch-runner.js";
import { readSharedIndex, scanShared } from "../../core/shared-indexer.js";
import { detectGameVersion } from "../../core/game-version.js";
import { isPackagedRuntime, managerDataDir, managerDataRootDir, resourcePath, supportedGameVersion } from "../../core/runtime-paths.js";
import { checkRuntimeMigration, getStatus as runtimeGetStatus, installLoader as runtimeInstallLoader, launchGame as runtimeLaunchGame, listLibraryMods as runtimeListLibraryMods, migrateLegacyRuntimeMods, mountMod as runtimeMountMod, previewSpineBundle as runtimePreviewSpineBundle, setRuntimeModsEnabled, uninstallLoader as runtimeUninstallLoader, unmountMod as runtimeUnmountMod, unpatchLegacyRuntimeMods } from "../../core/runtime-loader.js";
import type { AppInfo, ApplyPatchOptions, ApplyPatchResult, ModsIndex, PatchPlanEntry, PatchStateChange, SharedScanOptions } from "../../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appDisplayName = "BD-SpineX";
const appSubtitle = "Mod Manager";
const isDev = !app.isPackaged;
let stopSharedScanRequested = false;

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: `${appDisplayName} - ${appSubtitle}`,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev
    }
  });

  setupProductionWindowGuards(window);

  if (isDev) {
    await window.loadURL("http://127.0.0.1:5173");
  } else {
    await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

function setupProductionWindowGuards(window: BrowserWindow) {
  if (isDev) {
    return;
  }

  Menu.setApplicationMenu(null);

  window.webContents.on("devtools-opened", () => {
    window.webContents.closeDevTools();
  });

  window.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const isDevToolsShortcut =
      key === "f12" ||
      (input.meta && input.alt && key === "i") ||
      (input.control && input.shift && key === "i") ||
      (input.control && input.shift && key === "j") ||
      (input.control && input.shift && key === "c");

    if (isDevToolsShortcut) {
      event.preventDefault();
    }
  });
}

ipcMain.handle("dialog:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("app:default-paths", async () => ({
  modsDir: defaultModsDir(),
  sharedDir: "",
  dotnetPath: defaultBackendPath()
}));
ipcMain.handle("app:read-settings", async () => readSavedSettings());
ipcMain.handle("app:write-settings", async (_event, settings: unknown) => {
  await writeSavedSettings(settings);
  return true;
});
ipcMain.handle("app:open-detected-shared-folder", async () => openDetectedSharedFolder());
ipcMain.handle("app:open-records-folder", async () => openRecordsFolder());
ipcMain.handle("app:info", async (): Promise<AppInfo> => ({
  name: appDisplayName,
  subtitle: appSubtitle,
  version: app.getVersion(),
  supportedGameVersion: supportedGameVersion(),
  development: isDev
}));
ipcMain.handle("game:detect-version", async (_event, args?: { sharedDir?: string }) => detectGameVersion(args?.sharedDir));

ipcMain.handle("mods:scan", async (_event, modsDir: string) => scanMods(modsDir));
ipcMain.handle("shared:scan", async (event, args: { sharedDir: string; options?: SharedScanOptions }) => {
  stopSharedScanRequested = false;
  return scanShared(args.sharedDir, args.options, (progress) => {
    event.sender.send("shared:scan-progress", progress);
  }, () => stopSharedScanRequested);
});
ipcMain.handle("shared:read-index", async (_event, sharedDir?: string) => readSharedIndex(sharedDir));
ipcMain.handle("shared:stop-scan", async () => {
  stopSharedScanRequested = true;
  return true;
});
ipcMain.handle("patch-plan:create", async (_event, args) => createPatchPlan(args.sharedIndex, args.modsIndex));
ipcMain.handle("patch:apply-ready", async (_event, args: { plans: PatchPlanEntry[]; modsIndex: unknown; options: ApplyPatchOptions }) => {
  const result = await applyReadyPatches(args.plans, args.modsIndex as ModsIndex, args.options);
  notifyPatchFinished("Apply Complete", summarizePatchResult(result));
  return result;
});
ipcMain.handle("patch:apply-state-changes", async (event, args: { plans: PatchPlanEntry[]; modsIndex: unknown; changes: PatchStateChange[]; options: ApplyPatchOptions }) => {
  const result = await applyPatchStateChanges(args.plans, args.modsIndex as ModsIndex, args.changes, args.options, (progress) => {
    event.sender.send("patch:progress", progress);
  });
  notifyPatchFinished("Changes Complete", summarizePatchResult(result));
  return result;
});
ipcMain.handle("patch:dry-run-state-changes", async (event, args: { plans: PatchPlanEntry[]; modsIndex: unknown; changes: PatchStateChange[]; options: ApplyPatchOptions }) =>
  dryRunPatchStateChanges(args.plans, args.modsIndex as ModsIndex, args.changes, args.options, (progress) => {
    event.sender.send("patch:progress", progress);
  })
);
ipcMain.handle("patch:restore-all", async (_event, args: { plans: PatchPlanEntry[] }) => {
  const result = await restoreAllPatches(args.plans);
  notifyPatchFinished("Restore Complete", summarizePatchResult(result));
  return result;
});
ipcMain.handle("patch:copy-backups-for-mods", async (_event, args: { plans: PatchPlanEntry[]; modNames: string[]; source: "original" | "patched" }) => {
  const result = await copyPatchBackupsForMods(args.plans, args.modNames, args.source);
  notifyPatchFinished("Mod Power Complete", summarizePatchResult(result));
  return result;
});
ipcMain.handle("patch:check-data-for-mods", async (_event, args: { plans: PatchPlanEntry[]; modNames: string[] }) =>
  checkPatchDataForMods(args.plans, args.modNames)
);
ipcMain.handle("patch:ensure-original-backups-for-mods", async (event, args: { plans: PatchPlanEntry[]; modsIndex: unknown; modNames: string[]; options: ApplyPatchOptions }) =>
  ensureOriginalBackupsForMods(args.plans, args.modsIndex as ModsIndex, args.modNames, args.options, (progress) => {
    event.sender.send("patch:progress", progress);
  })
);
ipcMain.handle("patch:history", async () => readPatchHistory());
ipcMain.handle("patch:previous-patched-mods", async () => readPreviousPatchedMods());

// --- Runtime (BepInEx-for-PlayCover) ---
ipcMain.handle("runtime:status", async () => runtimeGetStatus());
ipcMain.handle("runtime:migration-check", async () => checkRuntimeMigration());
ipcMain.handle("runtime:unpatch-legacy", async () => unpatchLegacyRuntimeMods());
ipcMain.handle("runtime:migrate-legacy", async (_event, args: { modsDir: string }) => migrateLegacyRuntimeMods(args.modsDir));
ipcMain.handle("runtime:install", async () => runtimeInstallLoader());
ipcMain.handle("runtime:uninstall", async () => runtimeUninstallLoader());
ipcMain.handle("runtime:set-enabled", async (_event, enabled: boolean) => setRuntimeModsEnabled(enabled));
ipcMain.handle("runtime:list-library", async (_event, dir: string) => runtimeListLibraryMods(dir));
ipcMain.handle("runtime:preview-spine", async (_event, args: { srcDir: string; key: string }) => runtimePreviewSpineBundle(args.srcDir, args.key));
ipcMain.handle("runtime:mount", async (_event, args: { srcDir: string; folder?: string } | string) =>
  typeof args === "string" ? runtimeMountMod(args) : runtimeMountMod(args.srcDir, args.folder)
);
ipcMain.handle("runtime:unmount", async (_event, folder: string) => runtimeUnmountMod(folder));
ipcMain.handle("runtime:launch", async () => runtimeLaunchGame());

function summarizePatchResult(result: ApplyPatchResult) {
  const changedLines = [
    summarizeEntriesByStatus(result, "patched", "Applied"),
    summarizeEntriesByStatus(result, "restored", "Restored")
  ].filter(Boolean);
  const issueLines = [
    summarizeEntriesByStatus(result, "failed", "Failed"),
    summarizeEntriesByStatus(result, "skipped", "Skipped")
  ].filter(Boolean);
  const lines = [...changedLines, ...issueLines];

  return lines.join("\n") || "No module changes";
}

function summarizeEntriesByStatus(result: ApplyPatchResult, status: ApplyPatchResult["entries"][number]["status"], label: string) {
  const modNames = uniqueModNames(result.entries
    .filter((entry) => entry.status === status)
    .map((entry) => entry.modName));

  return modNames.length > 0 ? `${label}: ${formatModNameList(modNames)}` : "";
}

function uniqueModNames(modNames: string[]) {
  return [...new Set(modNames.filter(Boolean))];
}

function formatModNameList(modNames: string[]) {
  const visibleLimit = 3;
  const visibleNames = modNames.slice(0, visibleLimit).join(", ");
  const remainingCount = modNames.length - visibleLimit;

  return remainingCount > 0 ? `${visibleNames} and ${remainingCount} more` : visibleNames;
}

function notifyPatchFinished(title: string, body: string) {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({
    title: `${appDisplayName} - ${title}`,
    body
  }).show();
}

function defaultModsDir() {
  return isPackagedRuntime()
    ? path.join(app.getPath("documents"), "BD-SpineX Mods")
    : path.resolve("mods");
}

function defaultBackendPath() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-patcher", "UabeaPatchPrototype")
    : path.resolve("manager-data/tools/dotnet/dotnet");
}

async function detectSharedFolder() {
  for (const candidate of await sharedFolderCandidates()) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function openDetectedSharedFolder() {
  const sharedFolder = await detectSharedFolder();
  if (!sharedFolder) {
    return null;
  }

  await shell.openPath(sharedFolder);
  return sharedFolder;
}

async function openRecordsFolder() {
  const recordsFolder = managerDataDir();
  await fs.mkdir(recordsFolder, { recursive: true });
  const error = await shell.openPath(recordsFolder);
  if (error) {
    throw new Error(error);
  }
  return recordsFolder;
}

async function sharedFolderCandidates() {
  const containersDir = path.join(os.homedir(), "Library", "Containers");
  const knownCandidates = [
    path.join(containersDir, "com.neowizgames.game.browndust2ios", "Data", "Library", "UnityCache", "Shared")
  ];

  try {
    const entries = await fs.readdir(containersDir, { withFileTypes: true });
    const guessedCandidates = entries
      .filter((entry) => entry.isDirectory() && /browndust|brown.?dust|neowiz/i.test(entry.name))
      .map((entry) => path.join(containersDir, entry.name, "Data", "Library", "UnityCache", "Shared"));

    return [...new Set([...knownCandidates, ...guessedCandidates])];
  } catch {
    return knownCandidates;
  }
}

async function isDirectory(filePath: string) {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function settingsPath() {
  return path.join(managerDataRootDir(), "settings.json");
}

async function readSavedSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function writeSavedSettings(settings: unknown) {
  const filePath = settingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
