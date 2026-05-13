import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dotnet = path.join(root, "manager-data", "tools", "dotnet", "dotnet");
const uabeaProject = path.join(root, "experiments", "uabea-patcher", "UabeaPatchPrototype.csproj");
const rustManifest = path.join(root, "experiments", "rust-uabea-cli", "Cargo.toml");
const outputRoot = path.join(root, "dist-native");
const uabeaOutput = path.join(outputRoot, "uabea-patcher");
const rustOutput = path.join(outputRoot, "uabea-cli");
const rid = process.arch === "arm64" ? "osx-arm64" : "osx-x64";

await fs.mkdir(uabeaOutput, { recursive: true });
await fs.mkdir(rustOutput, { recursive: true });

await run(dotnet, [
  "publish",
  uabeaProject,
  "-c", "Release",
  "-r", rid,
  "--self-contained", "true",
  "-p:PublishSingleFile=true",
  "-p:IncludeNativeLibrariesForSelfExtract=true",
  "-o", uabeaOutput
]);
await removeDebugSymbols(uabeaOutput);

await run("cargo", [
  "build",
  "--release",
  "--manifest-path", rustManifest
]);

const builtRustCli = path.join(root, "experiments", "rust-uabea-cli", "target", "release", "uabea_cli");
const packagedRustCli = path.join(rustOutput, "uabea_cli");
await fs.copyFile(builtRustCli, packagedRustCli);
await chmodExecutable(path.join(uabeaOutput, "UabeaPatchPrototype"));
await chmodExecutable(packagedRustCli);

async function chmodExecutable(filePath) {
  await fs.chmod(filePath, 0o755);
}

async function removeDebugSymbols(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeDebugSymbols(current);
      continue;
    }

    if (entry.name.toLowerCase().endsWith(".pdb")) {
      await fs.rm(current, { force: true });
    }
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
