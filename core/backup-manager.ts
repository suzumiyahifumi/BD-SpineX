import fs from "node:fs/promises";
import path from "node:path";
import { managerDataDir } from "./runtime-paths.js";

export async function backupOriginal(bundlePath: string, bundleId: string): Promise<void> {
  const dir = getBackupDir(bundleId);
  const original = path.join(dir, "__data.original");
  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(original);
  } catch {
    await fs.copyFile(bundlePath, original);
  }
}

export async function replaceOriginalBackup(bundleId: string, sourcePath: string): Promise<void> {
  const dir = getBackupDir(bundleId);
  const original = path.join(dir, "__data.original");
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(sourcePath, original);
}

export async function preparePatchWork(bundlePath: string, bundleId: string): Promise<string> {
  await backupOriginal(bundlePath, bundleId);
  const dir = getBackupDir(bundleId);
  const original = path.join(dir, "__data.original");
  const patched = path.join(dir, "__data.patched");
  try {
    await fs.access(patched);
  } catch {
    await fs.copyFile(original, patched);
  }
  return patched;
}

export async function replacePatchWork(bundleId: string, nextWorkPath: string): Promise<string> {
  const patched = path.join(getBackupDir(bundleId), "__data.patched");
  await fs.rename(nextWorkPath, patched);
  return patched;
}

export async function applyModded(bundlePath: string, bundleId: string): Promise<void> {
  await fs.copyFile(path.join(getBackupDir(bundleId), "__data.patched"), bundlePath);
}

export async function restoreOriginal(bundlePath: string, bundleId: string): Promise<void> {
  await fs.copyFile(path.join(getBackupDir(bundleId), "__data.original"), bundlePath);
}

export function getPatchWorkPath(bundleId: string) {
  return path.join(getBackupDir(bundleId), "__data.patched");
}

export function getOriginalBackupPath(bundleId: string) {
  return path.join(getBackupDir(bundleId), "__data.original");
}

export function getPatchTempPath(bundleId: string, step: number) {
  return path.join(getBackupDir(bundleId), `__data.patched.${step}.tmp`);
}

export function getAssetBackupDir(bundleId: string, modName: string) {
  return path.join(getBackupDir(bundleId), "asset-backups", sanitizePathPart(modName));
}

export async function hasBackup(bundleId: string): Promise<boolean> {
  try {
    await fs.access(path.join(getBackupDir(bundleId), "__data.original"));
    return true;
  } catch {
    return false;
  }
}

function getBackupDir(bundleId: string) {
  return path.join(managerDataDir(), "backups", bundleId);
}

function sanitizePathPart(value: string) {
  return value.replace(/[/:\\]/g, "_");
}
