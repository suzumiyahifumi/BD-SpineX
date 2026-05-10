import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export async function convertJsonToSkel(jsonPath: string, outputDir: string, converterPath: string): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });

  const baseName = path.basename(jsonPath, ".json");
  const outputPath = path.join(outputDir, `${baseName}.skel`);

  try {
    await run(converterPath, [jsonPath, outputPath]);
  } catch (error) {
    await run(converterPath, ["-i", jsonPath, "-o", outputPath], error);
  }
  return outputPath;
}

function run(command: string, args: string[], previousError?: unknown): Promise<void> {
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
        resolve();
      } else {
        const previous = previousError instanceof Error ? ` Previous attempt: ${previousError.message}` : "";
        reject(new Error(stderr || stdout || `${command} exited with code ${code}.${previous}`));
      }
    });
  });
}
