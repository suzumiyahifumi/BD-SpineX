import { spawn } from "node:child_process";
import path from "node:path";

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
  patchBackend?: "uabea";
  dotnetPath?: string;
  uabeaPatcherProjectPath?: string;
};

export async function patchBundle(args: PatchBundleArgs): Promise<unknown> {
  throw new Error(`patchBundle is no longer supported. Use patchBundleBatch with UABEA backend. (${args.modName})`);
}

export async function patchBundleBatch(args: PatchBundleBatchArgs): Promise<unknown> {
  return patchBundleBatchWithUabea(args);
}

async function patchBundleBatchWithUabea(args: PatchBundleBatchArgs): Promise<unknown> {
  const dotnetPath = args.dotnetPath?.trim() || defaultDotnetPath();
  const projectPath = args.uabeaPatcherProjectPath?.trim() || defaultUabeaProjectPath();
  const commandArgs = [
    "run",
    "--project", projectPath,
    "--",
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath,
    "--compression", "lz4"
  ];

  const stdout = await run(dotnetPath, commandArgs);

  return JSON.parse(stdout);
}

function defaultDotnetPath() {
  return path.resolve("manager-data/tools/dotnet/dotnet");
}

function defaultUabeaProjectPath() {
  return path.resolve("experiments/uabea-patcher/UabeaPatchPrototype.csproj");
}

function run(command: string, args: string[]): Promise<string> {
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
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
}
