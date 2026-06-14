import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLoader } from "./build-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderDir = path.join(root, "native", "bd2loader");
const outDylib = path.join(root, "dist-native", "bd2loader", "libbd2loader.dylib");

async function newestMtimeMs(entryPath) {
  let stat;
  try {
    stat = await fs.stat(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let newest = stat.mtimeMs;
  const entries = await fs.readdir(entryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "target" || entry.name.startsWith("._")) {
      continue;
    }
    newest = Math.max(newest, await newestMtimeMs(path.join(entryPath, entry.name)));
  }
  return newest;
}

async function shouldBuildLoader() {
  if (!existsSync(outDylib)) {
    return true;
  }

  const [outputStat, inputMtime] = await Promise.all([
    fs.stat(outDylib),
    newestMtimeMs(loaderDir)
  ]);
  return outputStat.mtimeMs < inputMtime;
}

if (await shouldBuildLoader()) {
  console.log("[ensure-loader] runtime loader is missing or stale; building...");
  await buildLoader();
} else {
  console.log("[ensure-loader] runtime loader ready.");
}
