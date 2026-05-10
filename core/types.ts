export type AssetType = "TextAsset" | "Texture2D";

export type BundleAsset = {
  name: string;
  type: AssetType;
  pathId: number;
  width?: number;
  height?: number;
};

export type SharedBundle = {
  bundleId: string;
  dataPath: string;
  infoPath?: string;
  sizeBytes?: number;
  assets: BundleAsset[];
  scanError?: string;
};

export type SharedIndex = {
  bundles: SharedBundle[];
};

export type SharedFileEntry = {
  bundleId: string;
  dataPath: string;
  infoPath?: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type SharedFileIndex = {
  generatedAt: string;
  sharedDir: string;
  files: SharedFileEntry[];
};

export type SharedScanOptions = {
  pythonPath?: string;
  unityVersion?: string;
  decryptKey?: string;
  scanLimit?: number;
  targetNames?: string[];
  forceRescan?: boolean;
};

export type SharedScanProgress = {
  phase: "discovering" | "found" | "scanning" | "scanned" | "done" | "stopped";
  current: number;
  total: number;
  discoveredTotal?: number;
  targetTotal?: number;
  targetFound?: number;
  bundleId?: string;
  sizeBytes?: number;
  assetCount?: number;
  error?: string;
};

export type ModEntryStatus = "ready" | "missing_skeleton" | "missing_json" | "missing_atlas" | "missing_png";

export type ModFileEntry = {
  file: string;
  path: string;
  baseName: string;
};

export type ModEntry = {
  modName: string;
  name: string;
  dir: string;
  jsonPath?: string;
  skelPath?: string;
  atlasPath?: string;
  pngPath?: string;
  jsonFile?: string;
  skelFile?: string;
  atlasFile?: string;
  pngFile?: string;
  files: {
    json: ModFileEntry[];
    skel: ModFileEntry[];
    atlas: ModFileEntry[];
    png: ModFileEntry[];
  };
  status: ModEntryStatus;
};

export type ModsIndex = {
  mods: ModEntry[];
};

export type PatchPlanStatus =
  | "ready"
  | "bundle_not_found"
  | "missing_atlas"
  | "missing_skel"
  | "missing_texture"
  | "conflict"
  | "mod_not_ready";

export type PatchTarget = {
  assetName: string;
  type: AssetType;
  pathId: number;
};

export type PatchMissingTarget = {
  assetName: string;
  type: AssetType;
  sourceFile: string;
};

export type PatchPlanEntry = {
  modName: string;
  name: string;
  bundleId?: string;
  bundlePath?: string;
  status: PatchPlanStatus;
  targets: {
    atlas?: PatchTarget;
    skel?: PatchTarget;
    texture?: PatchTarget;
    atlases?: PatchTarget[];
    skels?: PatchTarget[];
    textures?: PatchTarget[];
  };
  missingTargets?: PatchMissingTarget[];
};

export type PatchPlanIndex = {
  plans: PatchPlanEntry[];
};

export type PatchRunStatus = "ready" | "patched" | "restored" | "failed" | "skipped";

export type PatchRunEntry = {
  id: string;
  modName: string;
  name: string;
  bundleId: string;
  bundlePath: string;
  status: PatchRunStatus;
  updatedAt: string;
  message?: string;
  changed?: unknown[];
};

export type PatchHistory = {
  updatedAt: string;
  entries: PatchRunEntry[];
};

export type ApplyPatchOptions = {
  pythonPath: string;
  converterPath?: string;
  unityVersion?: string;
  decryptKey?: string;
};

export type PatchStateChange = {
  modName: string;
  enabled: boolean;
};

export type PatchProgressPhase =
  | "starting"
  | "converting"
  | "preparing_backup"
  | "patching"
  | "copying"
  | "restoring"
  | "done"
  | "failed";

export type PatchProgress = {
  phase: PatchProgressPhase;
  current: number;
  total: number;
  modName?: string;
  bundleId?: string;
  message: string;
};

export type ApplyPatchResult = {
  ok: boolean;
  entries: PatchRunEntry[];
  history: PatchHistory;
};
