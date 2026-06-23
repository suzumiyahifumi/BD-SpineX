import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildLoader } from "./build-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateEnsureScript = path.join(root, "private", "runtime-injection", "scripts", "ensure-loader.mjs");
const outDylib = path.join(root, "dist-native", "bd2loader", "libbd2loader.dylib");

if (existsSync(privateEnsureScript)) {
  await import(pathToFileURL(privateEnsureScript).href);
} else if (existsSync(outDylib)) {
  console.log("[ensure-loader] runtime loader ready.");
} else {
  await buildLoader();
}
