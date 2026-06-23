import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLoader } from "./build-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dotnet = path.join(root, "manager-data", "tools", "dotnet", "dotnet");
const uabeaProject = path.join(root, "experiments", "uabea-patcher", "UabeaPatchPrototype.csproj");
const rustManifest = path.join(root, "experiments", "rust-uabea-cli", "Cargo.toml");
const python = path.join(root, ".venv", "bin", "python");
const outputRoot = path.join(root, "dist-native");
const uabeaOutput = path.join(outputRoot, "uabea-patcher");
const rustOutput = path.join(outputRoot, "uabea-cli");
const unityPyOutput = path.join(outputRoot, "unitypy-backend");
const pyinstallerWork = path.join(outputRoot, ".pyinstaller-work");
const pyinstallerSpecs = path.join(outputRoot, ".pyinstaller-specs");
const pyinstallerConfig = path.join(outputRoot, ".pyinstaller-config");
const rid = process.arch === "arm64" ? "osx-arm64" : "osx-x64";

await fs.mkdir(uabeaOutput, { recursive: true });
await fs.mkdir(rustOutput, { recursive: true });
await fs.rm(unityPyOutput, { recursive: true, force: true });
await fs.mkdir(unityPyOutput, { recursive: true });

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

await buildUnityPyExecutable("unitypy_patch_bundle", path.join(root, "python", "patch_bundle.py"));
await buildUnityPyExecutable("unitypy_scan_bundle", path.join(root, "python", "scan_bundle.py"));
await buildUnityPyExecutable("astc_encode", path.join(root, "python", "astc_encode.py"));

// Private Runtime Injection loader, when the private workspace is present.
await buildLoader();

async function buildUnityPyExecutable(name, entryPoint) {
  await run(python, [
    "-m", "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onefile",
    "--name", name,
    "--distpath", unityPyOutput,
    "--workpath", path.join(pyinstallerWork, name),
    "--specpath", pyinstallerSpecs,
    "--collect-all", "UnityPy",
    "--collect-all", "PIL",
    "--collect-all", "texture2ddecoder",
    "--collect-all", "astc_encoder",
    "--collect-all", "fmod_toolkit",
    "--collect-all", "archspec",
    entryPoint
  ]);
  await chmodExecutable(path.join(unityPyOutput, name));
}

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
      env: {
        ...process.env,
        PYINSTALLER_CONFIG_DIR: pyinstallerConfig
      },
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
