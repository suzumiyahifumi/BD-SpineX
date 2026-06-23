import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateBuildScript = path.join(root, "private", "runtime-injection", "scripts", "build-loader.mjs");

export async function buildLoader(options = {}) {
  if (existsSync(privateBuildScript)) {
    const privateModule = await import(pathToFileURL(privateBuildScript).href);
    return privateModule.buildLoader(options);
  }

  const message = "Private Runtime Injection source is not present; skipping loader build.";
  if (options.required || process.env.BD_SPINEX_REQUIRE_PRIVATE_RUNTIME === "1") {
    throw new Error(`${message} Expected ${path.relative(root, privateBuildScript)}.`);
  }
  console.warn(`[build-loader] ${message}`);
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLoader().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
