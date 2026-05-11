import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanMods } from "../../core/mod-indexer.js";
import { createPatchPlan } from "../../core/patch-plan.js";
import { applyPatchStateChanges, applyReadyPatches, checkPatchDataForMods, copyPatchBackupsForMods, dryRunPatchStateChanges, readPatchHistory, restoreAllPatches } from "../../core/patch-runner.js";
import { readSharedIndex, scanShared } from "../../core/shared-indexer.js";
import type { ApplyPatchOptions, ModsIndex, PatchPlanEntry, PatchStateChange, SharedScanOptions } from "../../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
let stopSharedScanRequested = false;

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "BD2 Spine Mod Manager",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await window.loadURL("http://127.0.0.1:5173");
  } else {
    await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

ipcMain.handle("dialog:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("app:default-paths", async () => ({
  modsDir: path.resolve("mods"),
  sharedDir: "",
  dotnetPath: path.resolve("manager-data/tools/dotnet/dotnet")
}));

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
  notifyPatchFinished("Patch Complete", summarizePatchResult(result));
  return result;
});
ipcMain.handle("patch:apply-state-changes", async (event, args: { plans: PatchPlanEntry[]; modsIndex: unknown; changes: PatchStateChange[]; options: ApplyPatchOptions }) => {
  const result = await applyPatchStateChanges(args.plans, args.modsIndex as ModsIndex, args.changes, args.options, (progress) => {
    event.sender.send("patch:progress", progress);
  });
  notifyPatchFinished("Patch Complete", summarizePatchResult(result));
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
ipcMain.handle("patch:history", async () => readPatchHistory());

function summarizePatchResult(result: Awaited<ReturnType<typeof applyReadyPatches>>) {
  const patched = result.entries.filter((entry) => entry.status === "patched").length;
  const restored = result.entries.filter((entry) => entry.status === "restored").length;
  const failed = result.entries.filter((entry) => entry.status === "failed").length;
  const skipped = result.entries.filter((entry) => entry.status === "skipped").length;

  return [
    patched ? `${patched} patched` : "",
    restored ? `${restored} restored` : "",
    failed ? `${failed} failed` : "",
    skipped ? `${skipped} skipped` : ""
  ].filter(Boolean).join(", ") || "No changes applied.";
}

function notifyPatchFinished(title: string, body: string) {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({
    title: `BD2 Spine Mod Manager - ${title}`,
    body
  }).show();
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
