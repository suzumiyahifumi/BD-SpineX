import { app } from "electron";
import path from "node:path";

export function isPackagedRuntime() {
  return app.isPackaged;
}

export function managerDataDir() {
  return path.join(managerDataRootDir(), "versions", managerDataVersion());
}

export function managerDataRootDir() {
  return isPackagedRuntime()
    ? path.join(app.getPath("userData"), "manager-data")
    : path.resolve("manager-data");
}

export function managerDataVersion() {
  return sanitizePathPart(app.getVersion());
}

export function seedManagerDataDir() {
  return isPackagedRuntime()
    ? path.join(process.resourcesPath, "manager-data")
    : path.resolve("manager-data");
}

export function resourcePath(...parts: string[]) {
  return isPackagedRuntime()
    ? path.join(process.resourcesPath, ...parts)
    : path.resolve(...parts);
}

function sanitizePathPart(value: string) {
  return value.replace(/[/:\\]/g, "_");
}
