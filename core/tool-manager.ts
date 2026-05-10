import fs from "node:fs/promises";
import fsSync from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const toolsRoot = path.resolve("manager-data/tools");
const converterRepoApi = "https://api.github.com/repos/wang606/SpineSkeletonDataConverter/releases/latest";

type GitHubRelease = {
  tag_name: string;
  zipball_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

export async function ensureSpineConverter(converterPath?: string): Promise<string> {
  if (converterPath?.trim()) {
    await assertExecutableExists(converterPath.trim());
    return converterPath.trim();
  }

  const managed = await findManagedConverter();
  if (managed) {
    return managed;
  }

  return downloadManagedConverter();
}

async function findManagedConverter() {
  const directPath = path.join(toolsRoot, executableName());
  if (await fileExists(directPath)) {
    return directPath;
  }

  try {
    const entries = await fs.readdir(toolsRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isConverterExecutable(entry.name)) {
        continue;
      }

      const parentPath = "parentPath" in entry ? entry.parentPath : toolsRoot;
      return path.join(parentPath as string, entry.name);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function downloadManagedConverter() {
  await fs.mkdir(toolsRoot, { recursive: true });
  const release = await getJson<GitHubRelease>(converterRepoApi);
  const asset = selectReleaseAsset(release);
  if (!asset) {
    throw new Error(`No SpineSkeletonDataConverter release asset found for ${process.platform}/${process.arch}.`);
  }

  const downloadsDir = path.join(toolsRoot, "downloads");
  await fs.mkdir(downloadsDir, { recursive: true });
  const archivePath = path.join(downloadsDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);

  if (asset.name.toLowerCase().endsWith(".zip")) {
    const extractDir = path.join(toolsRoot, release.tag_name);
    await fs.mkdir(extractDir, { recursive: true });
    await run("unzip", ["-o", archivePath, "-d", extractDir]);
    const extracted = await findManagedConverter();
    if (extracted) {
      await chmodExecutable(extracted);
      return extracted;
    }
    return buildManagedConverter(release);
  }

  if (/\.(tar\.gz|tgz)$/i.test(asset.name)) {
    const extractDir = path.join(toolsRoot, release.tag_name);
    await fs.mkdir(extractDir, { recursive: true });
    await run("tar", ["-xzf", archivePath, "-C", extractDir]);
    const extracted = await findManagedConverter();
    if (extracted) {
      await chmodExecutable(extracted);
      return extracted;
    }
    return buildManagedConverter(release);
  }

  if (process.platform !== "win32" && asset.name.toLowerCase().endsWith(".exe")) {
    return buildManagedConverter(release);
  }

  const outputPath = path.join(toolsRoot, executableName());
  await fs.copyFile(archivePath, outputPath);
  await chmodExecutable(outputPath);
  return outputPath;
}

async function buildManagedConverter(release: GitHubRelease) {
  const sourceDir = path.join(toolsRoot, "git-source", release.tag_name, "SpineSkeletonDataConverter");
  if (!await fileExists(path.join(sourceDir, "CMakeLists.txt"))) {
    await fs.rm(path.dirname(sourceDir), { recursive: true, force: true });
    await fs.mkdir(path.dirname(sourceDir), { recursive: true });
    await run("git", [
      "clone",
      "--recursive",
      "--depth",
      "1",
      "--branch",
      release.tag_name,
      "https://github.com/wang606/SpineSkeletonDataConverter.git",
      sourceDir
    ]);
  }
  await patchConverterSource(sourceDir);

  const buildDir = path.join(toolsRoot, "build", release.tag_name);
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });
  try {
    await run("cmake", ["-S", sourceDir, "-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"]);
    await run("cmake", ["--build", buildDir, "--config", "Release"]);
  } catch (error) {
    throw new Error(`Failed to build managed SpineSkeletonDataConverter. Install or repair Xcode Command Line Tools/CMake, or set an override path. ${error instanceof Error ? error.message : String(error)}`);
  }

  const built = await findExecutableInDir(buildDir);
  if (!built) {
    throw new Error("Built SpineSkeletonDataConverter, but no executable was found.");
  }

  const managedPath = path.join(toolsRoot, executableName());
  await fs.copyFile(built, managedPath);
  await chmodExecutable(managedPath);
  return managedPath;
}

async function patchConverterSource(sourceDir: string) {
  const commonPath = path.join(sourceDir, "src", "common.cpp");
  let common = await fs.readFile(commonPath, "utf8");
  if (!common.includes("#include <sstream>")) {
    common = common.replace("#include \"SkeletonData.h\"", "#include \"SkeletonData.h\"\n#include <sstream>");
    await fs.writeFile(commonPath, common, "utf8");
  }
}

function selectReleaseAsset(release: GitHubRelease) {
  const platformTerms = getPlatformTerms();
  const archTerms = getArchTerms();
  const assets = release.assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    return name.includes("spineskeletondataconverter") || name.includes("spine-skeleton-data-converter");
  });

  return assets.find((asset) => {
    const name = asset.name.toLowerCase();
    return platformTerms.some((term) => name.includes(term)) &&
      archTerms.some((term) => name.includes(term));
  }) ?? assets.find((asset) => {
    const name = asset.name.toLowerCase();
    return platformTerms.some((term) => name.includes(term));
  }) ?? (process.platform === "win32" ? assets.find((asset) => asset.name.toLowerCase().endsWith(".exe")) : undefined)
    ?? assets.find((asset) => asset.name.toLowerCase().endsWith(".zip"))
    ?? assets[0];
}

function getPlatformTerms() {
  if (process.platform === "darwin") {
    return ["mac", "macos", "osx", "darwin"];
  }

  if (process.platform === "win32") {
    return ["win", "windows"];
  }

  return ["linux"];
}

function getArchTerms() {
  if (process.arch === "arm64") {
    return ["arm64", "aarch64", "universal"];
  }

  return ["x64", "x86_64", "amd64", "universal"];
}

function executableName() {
  return process.platform === "win32" ? "SpineSkeletonDataConverter.exe" : "SpineSkeletonDataConverter";
}

function isConverterExecutable(fileName: string) {
  if (process.platform === "win32") {
    return fileName === "SpineSkeletonDataConverter.exe";
  }

  return fileName === "SpineSkeletonDataConverter";
}

async function assertExecutableExists(filePath: string) {
  if (!await fileExists(filePath)) {
    throw new Error(`Converter not found: ${filePath}`);
  }
}

async function chmodExecutable(filePath: string) {
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o755);
  }
}

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "BD2-Spine-Mod-Manager"
      }
    }, (response) => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        resolve(getJson<T>(response.headers.location));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 400) {
          reject(new Error(`GitHub release request failed: ${response.statusCode} ${body}`));
          return;
        }

        resolve(JSON.parse(body) as T);
      });
    }).on("error", reject);
  });
}

function downloadFile(url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fsSync.createWriteStream(outputPath);
    https.get(url, {
      headers: {
        "User-Agent": "BD2-Spine-Mod-Manager"
      }
    }, (response) => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        file.close();
        fsSync.rmSync(outputPath, { force: true });
        downloadFile(response.headers.location, outputPath).then(resolve, reject);
        return;
      }

      if ((response.statusCode ?? 0) >= 400) {
        file.close();
        fsSync.rmSync(outputPath, { force: true });
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (error) => {
      file.close();
      fsSync.rmSync(outputPath, { force: true });
      reject(error);
    });
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });
  });
}

async function findExecutableInDir(root: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutableInDir(current);
      if (found) {
        return found;
      }
      continue;
    }

    if (entry.isFile() && isConverterExecutable(entry.name)) {
      return current;
    }
  }

  return undefined;
}

function isRedirect(statusCode?: number) {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}
