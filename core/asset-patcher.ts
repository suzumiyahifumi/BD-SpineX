import { spawn } from "node:child_process";
import path from "node:path";

export type PatchBundleArgs = {
  pythonPath: string;
  scriptPath: string;
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
  patchBackend?: "unitypy" | "uabea";
  dotnetPath?: string;
  uabeaPatcherProjectPath?: string;
};

export async function patchBundle(args: PatchBundleArgs): Promise<unknown> {
  const commandArgs = [
    args.scriptPath,
    "--input", args.input,
    "--output", args.output,
    "--mod-name", args.modName
  ];

  for (const atlas of args.atlases) {
    commandArgs.push("--atlas", atlas);
  }
  for (const skel of args.skels) {
    commandArgs.push("--skel", skel);
  }
  for (const png of args.pngs) {
    commandArgs.push("--png", png);
  }
  for (const png of args.insertPngs ?? []) {
    commandArgs.push("--insert-png", png);
  }
  if (args.unityVersion?.trim()) {
    commandArgs.push("--unity-version", args.unityVersion.trim());
  }
  if (args.decryptKey?.trim()) {
    commandArgs.push("--decrypt-key", args.decryptKey.trim());
  }
  if (args.assetBackupDir?.trim()) {
    commandArgs.push("--asset-backup-dir", args.assetBackupDir.trim());
  }

  const stdout = await run(args.pythonPath, commandArgs);

  return JSON.parse(stdout);
}

export async function patchBundleBatch(args: PatchBundleBatchArgs): Promise<unknown> {
  if (args.patchBackend === "uabea") {
    return patchBundleBatchWithUabea(args);
  }

  const commandArgs = [
    args.scriptPath,
    "--input", args.input,
    "--output", args.output,
    "--job-manifest", args.manifestPath
  ];

  if (args.unityVersion?.trim()) {
    commandArgs.push("--unity-version", args.unityVersion.trim());
  }
  if (args.decryptKey?.trim()) {
    commandArgs.push("--decrypt-key", args.decryptKey.trim());
  }

  const stdout = await run(args.pythonPath, commandArgs);

  return JSON.parse(stdout);
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
