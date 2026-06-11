// 建置執行時 loader（bepinex-playcover/loader → dist-native/bd2loader/libbd2loader.dylib）。
// 由 build:backends 呼叫，亦可獨立執行：node scripts/build-loader.mjs
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// frida-gum devkit（loader 靜態連入；macOS arm64）。pin 版本即可，只用其 hook API。
const GUM_VERSION = "17.11.0";
const loaderDir = path.join(root, "native", "bd2loader");
const gumDir = path.join(root, "native", "frida-gum");
const target = "aarch64-apple-darwin";
const builtDylib = path.join(loaderDir, "target", target, "release", "libbd2loader.dylib");
const outDir = path.join(root, "dist-native", "bd2loader");
const outDylib = path.join(outDir, "libbd2loader.dylib");

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

async function ensureGumDevkit() {
  if (existsSync(path.join(gumDir, "libfrida-gum.a")) && existsSync(path.join(gumDir, "frida-gum.h"))) {
    return;
  }
  console.log(`[build-loader] fetching frida-gum devkit ${GUM_VERSION}…`);
  await fs.mkdir(gumDir, { recursive: true });
  const url = `https://github.com/frida/frida/releases/download/${GUM_VERSION}/frida-gum-devkit-${GUM_VERSION}-macos-arm64.tar.xz`;
  const archive = path.join(gumDir, "devkit.tar.xz");
  await run("curl", ["-fsSL", "-o", archive, url]);
  await run("tar", ["-xf", archive, "-C", gumDir]);
  await fs.rm(archive, { force: true });
  if (!existsSync(path.join(gumDir, "libfrida-gum.a"))) {
    throw new Error("frida-gum devkit 解壓後仍找不到 libfrida-gum.a");
  }
}

export async function buildLoader() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("loader 僅支援 macOS arm64");
  }
  await ensureGumDevkit();
  console.log("[build-loader] cargo build --release…");
  await run("cargo", ["build", "--release", "--target", target], loaderDir);
  if (!existsSync(builtDylib)) {
    throw new Error(`找不到建好的 loader：${builtDylib}`);
  }
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(builtDylib, outDylib);
  await fs.chmod(outDylib, 0o755);
  console.log(`[build-loader] done → ${path.relative(root, outDylib)}`);
}

// 獨立執行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLoader().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
