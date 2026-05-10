import { spawn } from "node:child_process";

export type PatchBundleArgs = {
  pythonPath: string;
  scriptPath: string;
  input: string;
  output: string;
  modName: string;
  atlases: string[];
  skels: string[];
  pngs: string[];
  unityVersion?: string;
  decryptKey?: string;
  assetBackupDir?: string;
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
