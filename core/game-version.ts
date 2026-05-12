import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { GameVersionInfo } from "./types.js";

const gameHints = [
  "browndust",
  "brown dust",
  "bd2",
  "brave nine",
  "neowiz",
  "com.neowiz"
];

const versionKeys = [
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "bundleShortVersionString",
  "version",
  "gameVersion"
];
const execFileAsync = promisify(execFile);

type VersionCandidate = {
  version: string;
  sourcePath: string;
  score: number;
};

export async function detectGameVersion(sharedDir?: string): Promise<GameVersionInfo> {
  const candidates: VersionCandidate[] = [];
  const seenFiles = new Set<string>();

  for (const filePath of await collectVersionFilePaths(sharedDir)) {
    const resolved = path.resolve(filePath);
    if (seenFiles.has(resolved)) {
      continue;
    }

    seenFiles.add(resolved);
    const candidate = await readVersionCandidate(resolved, sharedDir);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return {
    version: best?.version,
    sourcePath: best?.sourcePath,
    detectedAt: new Date().toISOString()
  };
}

async function collectVersionFilePaths(sharedDir?: string) {
  const files = new Set<string>();
  const roots = await collectSearchRoots(sharedDir);

  for (const root of roots) {
    for (const file of directVersionFiles(root)) {
      files.add(file);
    }
  }

  for (const root of roots.slice(0, 6)) {
    for (const file of await findVersionFiles(root, 5, 800)) {
      files.add(file);
    }
  }

  return [...files];
}

async function collectSearchRoots(sharedDir?: string) {
  const sharedRoots: string[] = [];
  const playCoverRoots: string[] = [];
  const addExistingRoot = async (root?: string) => {
    if (!root?.trim()) {
      return;
    }

    try {
      const stats = await fs.stat(root);
      if (stats.isDirectory()) {
        return path.resolve(root);
      }
    } catch {
      // Optional detection path.
    }

    return undefined;
  };

  if (sharedDir?.trim()) {
    for (const ancestor of pathAncestors(sharedDir, 8)) {
      const root = await addExistingRoot(ancestor);
      if (root) {
        sharedRoots.push(root);
      }
    }
  }

  const home = os.homedir();
  for (const rootPath of [
    path.join(home, "Library/Containers/io.playcover.PlayCover"),
    path.join(home, "Library/Application Support/PlayCover"),
    path.join(home, "Library/Containers")
  ]) {
    const root = await addExistingRoot(rootPath);
    if (root) {
      playCoverRoots.push(root);
    }
  }

  return [...new Set([...playCoverRoots, ...sharedRoots])];
}

function pathAncestors(startPath: string, limit: number) {
  const ancestors: string[] = [];
  let current = path.resolve(startPath);

  for (let index = 0; index < limit; index += 1) {
    ancestors.push(current);
    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return ancestors;
}

function directVersionFiles(root: string) {
  return [
    path.join(root, "Info.plist"),
    path.join(root, "iTunesMetadata.plist"),
    path.join(root, ".com.apple.mobile_container_manager.metadata.plist"),
    path.join(root, "AppData/Documents/iTunesMetadata.plist"),
    path.join(root, "Data/Documents/iTunesMetadata.plist")
  ];
}

async function findVersionFiles(root: string, maxDepth: number, maxVisited: number) {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < maxVisited) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    visited += 1;

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isFile() && isVersionFileName(entry.name)) {
        found.push(entryPath);
      }

      if (entry.isDirectory() && current.depth < maxDepth && shouldEnterDirectory(entry.name, entryPath)) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }

  return found;
}

function isVersionFileName(fileName: string) {
  return [
    "Info.plist",
    "iTunesMetadata.plist",
    ".com.apple.mobile_container_manager.metadata.plist",
    "manifest.json",
    "metadata.json"
  ].includes(fileName);
}

function shouldEnterDirectory(name: string, fullPath: string) {
  const normalized = `${name} ${fullPath}`.toLowerCase();
  return name.endsWith(".app")
    || gameHints.some((hint) => normalized.includes(hint))
    || normalized.includes("playcover")
    || normalized.includes("container")
    || normalized.includes("application support")
    || normalized.includes("data")
    || normalized.includes("documents");
}

async function readVersionCandidate(filePath: string, sharedDir?: string): Promise<VersionCandidate | undefined> {
  let content: string;
  try {
    const buffer = await fs.readFile(filePath);
    content = buffer.toString("utf8");
  } catch {
    return undefined;
  }

  const plistJson = extractVersion(content) ? undefined : await readPlistJson(filePath);
  const searchableContent = plistJson ? `${content}\n${JSON.stringify(plistJson)}` : content;
  const version = extractVersion(content) ?? extractVersionFromObject(plistJson);
  if (!version || !looksLikeGameFile(searchableContent, filePath, sharedDir)) {
    return undefined;
  }

  return {
    version,
    sourcePath: filePath,
    score: scoreVersionCandidate(searchableContent, filePath, sharedDir)
  };
}

async function readPlistJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!filePath.endsWith(".plist")) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", filePath], {
      timeout: 2000,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractVersion(content: string) {
  for (const key of versionKeys) {
    const plistValue = content.match(new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`, "i"))?.[1];
    if (plistValue && isVersionLike(plistValue)) {
      return plistValue.trim();
    }

    const jsonValue = content.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`, "i"))?.[1];
    if (jsonValue && isVersionLike(jsonValue)) {
      return jsonValue.trim();
    }
  }

  return undefined;
}

function extractVersionFromObject(value: Record<string, unknown> | undefined) {
  if (!value) {
    return undefined;
  }

  for (const key of versionKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && isVersionLike(candidate)) {
      return candidate.trim();
    }
  }

  return undefined;
}

function looksLikeGameFile(content: string, filePath: string, sharedDir?: string) {
  const normalized = `${content}\n${filePath}`.toLowerCase();
  return gameHints.some((hint) => normalized.includes(hint))
    || Boolean(sharedDir && isNearSharedGamePath(filePath, sharedDir));
}

function scoreVersionCandidate(content: string, filePath: string, sharedDir?: string) {
  const normalized = `${content}\n${filePath}`.toLowerCase();
  let score = 0;
  for (const hint of gameHints) {
    if (normalized.includes(hint)) {
      score += 20;
    }
  }
  if (path.basename(filePath) === "Info.plist") {
    score += 8;
  }
  if (sharedDir && isNearSharedGamePath(filePath, sharedDir)) {
    score += 6;
  }
  return score;
}

function isNearSharedGamePath(filePath: string, sharedDir: string) {
  const sharedAncestors = pathAncestors(sharedDir, 8);
  return sharedAncestors.some((ancestor) => path.resolve(filePath) === path.join(path.resolve(ancestor), "Info.plist"))
    || sharedAncestors.some((ancestor) => path.resolve(filePath) === path.join(path.resolve(ancestor), "iTunesMetadata.plist"));
}

function isVersionLike(value: string) {
  return /^\d+(?:\.\d+){0,4}(?:[-+][\w.]+)?$/.test(value.trim());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
