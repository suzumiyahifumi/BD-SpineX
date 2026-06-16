import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const outputDir = path.resolve(root, packageJson.build?.directories?.output ?? "release");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bd-spinex-electron-builder-"));

try {
  await run(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"), [
    "--mac",
    "--arm64",
    `--config.directories.output=${tempDir}`
  ]);

  await fs.mkdir(outputDir, { recursive: true });
  for (const entry of await fs.readdir(tempDir)) {
    const from = path.join(tempDir, entry);
    const to = path.join(outputDir, entry);
    await fs.rm(to, { recursive: true, force: true });
    await run("/usr/bin/ditto", ["--norsrc", from, to]);
  }
  await removeAppleDouble(outputDir);
  console.log(`Packaged Electron artifacts in ${path.relative(root, outputDir)} via ${tempDir}.`);
} finally {
  if (process.env.BD_SPINEX_KEEP_ELECTRON_BUILDER_OUTPUT !== "1") {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1"
      }
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function removeAppleDouble(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.name.startsWith("._")) {
      await fs.rm(filePath, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) {
      await removeAppleDouble(filePath);
    }
  }));
}
