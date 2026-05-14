import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isPackagedRuntime, resourcePath } from "./runtime-paths.js";
import type { PatchBackend, PatchTarget } from "./types.js";

export type PatchBundleArgs = {
  input: string;
  output: string;
  modName: string;
  atlases: string[];
  skels: string[];
  pngs: string[];
  insertPngs?: string[];
  unityVersion?: string;
  decryptKey?: string;
  assetBackupDir?: string;
};

export type PatchBundleJob = {
  modName: string;
  atlases: string[];
  skels: string[];
  pngs: string[];
  insertPngs?: string[];
  assetBackupDir?: string;
  textureTargets?: PatchTarget[];
};

type ExecutablePatchBackend = Exclude<PatchBackend, "auto">;

export type PatchBundleBatchArgs = Omit<PatchBundleArgs, "modName" | "atlases" | "skels" | "pngs" | "assetBackupDir"> & {
  jobs: PatchBundleJob[];
  manifestPath: string;
  patchBackend?: PatchBackend;
  pythonPath?: string;
  dotnetPath?: string;
  uabeaPatcherProjectPath?: string;
};

export async function patchBundle(args: PatchBundleArgs): Promise<unknown> {
  throw new Error(`patchBundle is no longer supported. Use patchBundleBatch with UABEA backend. (${args.modName})`);
}

export async function patchBundleBatch(args: PatchBundleBatchArgs): Promise<unknown> {
  const requestedBackend = args.patchBackend ?? "uabea";
  const patchBackend = resolvePatchBackend(args);

  if (patchBackend === "rust-native") {
    return withResolvedBackend(await patchBundleBatchWithRustNative(args), patchBackend);
  }

  if (patchBackend === "unitypy") {
    try {
      return withResolvedBackend(await patchBundleBatchWithUnityPy(args), patchBackend);
    } catch (error) {
      if (requestedBackend === "auto" && isUnityPyUnavailableError(error)) {
        return withResolvedBackend(await patchBundleBatchWithUabea(args), "uabea");
      }

      throw error;
    }
  }

  return withResolvedBackend(await patchBundleBatchWithUabea(args, patchBackend === "uabea-astc"), patchBackend);
}

async function patchBundleBatchWithUnityPy(args: PatchBundleBatchArgs): Promise<unknown> {
  if (args.jobs.some((job) => (job.insertPngs?.length ?? 0) > 0)) {
    throw new Error("UnityPy backend does not support inserting new Texture2D assets. Use UABEA for mods that need extra atlas pages.");
  }

  const executablePath = unityPyPatchExecutablePath();
  const command = executablePath ?? args.pythonPath?.trim() ?? defaultPythonPath();
  const commandArgs = executablePath ? [] : [defaultUnityPyPatchScriptPath()];
  commandArgs.push(
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath
  );

  if (args.unityVersion?.trim()) {
    commandArgs.push("--unity-version", args.unityVersion.trim());
  }
  if (args.decryptKey?.trim()) {
    commandArgs.push("--decrypt-key", args.decryptKey.trim());
  }

  const stdout = await run(command, commandArgs);

  return JSON.parse(stdout);
}

async function patchBundleBatchWithUabea(args: PatchBundleBatchArgs, useAstcEncoder = false): Promise<unknown> {
  const command = uabeaCommand();
  const projectPath = args.uabeaPatcherProjectPath?.trim() || defaultUabeaProjectPath();
  const directUabea = usesDirectUabeaExecutable();
  const backendArgs = [
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath,
    "--compression", "lz4"
  ];
  const astcEncoderPath = useAstcEncoder ? astcEncoderExecutablePath() : undefined;
  if (useAstcEncoder && !astcEncoderPath) {
    throw new Error("ASTC patch mode requires the bundled astc_encode backend. Run npm run build:backends before using Force ASTC Mode.");
  }
  if (astcEncoderPath) {
    backendArgs.push("--astc-encoder", astcEncoderPath);
  }
  const commandArgs = uabeaBaseArgs(directUabea
    ? backendArgs
    : [
        ...backendArgs,
        "--dotnet-path", args.dotnetPath?.trim() || defaultDotnetPath(),
        "--uabea-project", projectPath
      ]);

  const stdout = await run(command, commandArgs);

  return JSON.parse(stdout);
}

async function patchBundleBatchWithRustNative(args: PatchBundleBatchArgs): Promise<unknown> {
  const command = rustCliCommand();
  const commandArgs = rustCliBaseArgs([
    "--rust-backend", "native",
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath,
    "--compression", "lz4"
  ]);

  const stdout = await run(command, commandArgs, { parseJsonOnFailure: true });

  return JSON.parse(stdout);
}

function defaultDotnetPath() {
  return path.resolve("manager-data/tools/dotnet/dotnet");
}

function resolvePatchBackend(args: PatchBundleBatchArgs): ExecutablePatchBackend {
  if (args.patchBackend === "uabea" || args.patchBackend === "unitypy" || args.patchBackend === "rust-native" || args.patchBackend === "uabea-astc") {
    return args.patchBackend;
  }

  return "uabea-astc";
}

function withResolvedBackend(result: unknown, backend: ExecutablePatchBackend) {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? { ...result, backend }
    : result;
}

function isUnityPyUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /UnityPy import failed|No module named ['"]?UnityPy|python3 ENOENT|spawn .*python.*ENOENT/i.test(message);
}

function defaultPythonPath() {
  const venvPython = path.resolve(".venv/bin/python");
  return existsSync(venvPython) ? venvPython : "python3";
}

function defaultUnityPyPatchScriptPath() {
  return resourcePath("python", "patch_bundle.py");
}

function unityPyPatchExecutablePath() {
  const executablePath = isPackagedRuntime()
    ? resourcePath("backend", "unitypy", "unitypy_patch_bundle")
    : path.resolve("dist-native/unitypy-backend/unitypy_patch_bundle");

  return existsSync(executablePath) ? executablePath : undefined;
}

function astcEncoderExecutablePath() {
  const executablePath = isPackagedRuntime()
    ? resourcePath("backend", "unitypy", "astc_encode")
    : path.resolve("dist-native/unitypy-backend/astc_encode");

  return existsSync(executablePath) ? executablePath : undefined;
}

function defaultUabeaProjectPath() {
  return isPackagedRuntime()
    ? path.join(process.resourcesPath, "backend", "uabea-patcher", "UabeaPatchPrototype")
    : path.resolve("experiments/uabea-patcher/UabeaPatchPrototype.csproj");
}

function uabeaCommand() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-patcher", "UabeaPatchPrototype")
    : devUabeaExecutablePath() ?? "cargo";
}

function uabeaBaseArgs(args: string[]) {
  if (usesDirectUabeaExecutable()) {
    return args;
  }

  return rustCliBaseArgs(args);
}

function usesDirectUabeaExecutable() {
  return isPackagedRuntime() || Boolean(devUabeaExecutablePath());
}

function devUabeaExecutablePath() {
  const executablePath = path.resolve("dist-native/uabea-patcher/UabeaPatchPrototype");
  return existsSync(executablePath) ? executablePath : undefined;
}

function rustCliCommand() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-cli", "uabea_cli")
    : "cargo";
}

function rustCliBaseArgs(args: string[]) {
  if (isPackagedRuntime()) {
    return args;
  }

  return [
    "run",
    "--manifest-path", path.resolve("experiments/rust-uabea-cli/Cargo.toml"),
    "--quiet",
    "--",
    ...args
  ];
}

function run(command: string, args: string[], options: { parseJsonOnFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else if (options.parseJsonOnFailure && looksLikeJson(stdout)) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}
