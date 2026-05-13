import { spawn } from "node:child_process";
import path from "node:path";
import { isPackagedRuntime, resourcePath } from "./runtime-paths.js";

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
};

export type PatchBundleBatchArgs = Omit<PatchBundleArgs, "modName" | "atlases" | "skels" | "pngs" | "assetBackupDir"> & {
  jobs: PatchBundleJob[];
  manifestPath: string;
  patchBackend?: "uabea" | "rust-native";
  dotnetPath?: string;
  uabeaPatcherProjectPath?: string;
};

export async function patchBundle(args: PatchBundleArgs): Promise<unknown> {
  throw new Error(`patchBundle is no longer supported. Use patchBundleBatch with UABEA backend. (${args.modName})`);
}

export async function patchBundleBatch(args: PatchBundleBatchArgs): Promise<unknown> {
  if (args.patchBackend === "rust-native") {
    return patchBundleBatchWithRustNative(args);
  }

  return patchBundleBatchWithUabea(args);
}

async function patchBundleBatchWithUabea(args: PatchBundleBatchArgs): Promise<unknown> {
  const command = uabeaCommand();
  const projectPath = args.uabeaPatcherProjectPath?.trim() || defaultUabeaProjectPath();
  const backendArgs = [
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath,
    "--compression", "lz4"
  ];
  const commandArgs = uabeaBaseArgs(isPackagedRuntime()
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

function defaultUabeaProjectPath() {
  return isPackagedRuntime()
    ? path.join(process.resourcesPath, "backend", "uabea-patcher", "UabeaPatchPrototype")
    : path.resolve("experiments/uabea-patcher/UabeaPatchPrototype.csproj");
}

function uabeaCommand() {
  return isPackagedRuntime()
    ? resourcePath("backend", "uabea-patcher", "UabeaPatchPrototype")
    : "cargo";
}

function uabeaBaseArgs(args: string[]) {
  if (isPackagedRuntime()) {
    return args;
  }

  return rustCliBaseArgs(args);
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
