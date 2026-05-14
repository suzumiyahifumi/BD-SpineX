export type AssetType = "TextAsset" | "Texture2D";

export type BundleAsset = {
  name: string;
  type: AssetType;
  pathId: number;
  width?: number;
  height?: number;
  textureFormat?: number;
  textureFormatName?: string;
  streamDataSize?: number;
  streamDataPath?: string;
  imageDataSize?: number;
};

export type SharedBundle = {
  bundleId: string;
  dataPath?: string;
  infoPath?: string;
  hasInfo?: boolean;
  sizeBytes?: number;
  assets: BundleAsset[];
  scanError?: string;
};

export type SharedIndex = {
  bundles: SharedBundle[];
  assetsByName?: SharedAssetNameIndex;
};

export type SharedAssetNameIndex = Record<string, SharedAssetNameIndexEntry[]>;

export type SharedAssetNameIndexEntry = {
  bundleId: string;
  assetName: string;
  type: AssetType;
  pathId: number;
  width?: number;
  height?: number;
  textureFormat?: number;
  textureFormatName?: string;
  streamDataSize?: number;
  streamDataPath?: string;
  imageDataSize?: number;
};

export type SharedFileEntry = {
  bundleId: string;
  sizeBytes: number;
  modifiedAt: string;
  hasInfo?: boolean;
};

export type SharedFileIndex = {
  generatedAt: string;
  sharedRootKey: string;
  files: SharedFileEntry[];
};

export type AppInfo = {
  name: string;
  subtitle: string;
  version: string;
  supportedGameVersion: string;
  development: boolean;
};

export type GameVersionInfo = {
  version?: string;
  sourcePath?: string;
  detectedAt: string;
};

export type SharedScanOptions = {
  pythonPath?: string;
  scanBackend?: SharedScanBackend;
  dotnetPath?: string;
  uabeaScannerProjectPath?: string;
  unityVersion?: string;
  decryptKey?: string;
  scanLimit?: number;
  targetNames?: string[];
  forceRescan?: boolean;
};

export type SharedScanBackend = "uabea" | "rust-native" | "unitypy";

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
  width?: number;
  height?: number;
  textureFormat?: number;
  textureFormatName?: string;
  streamDataSize?: number;
  streamDataPath?: string;
  imageDataSize?: number;
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

export type PatchRunStatus = "ready" | "patched" | "restored" | "failed" | "skipped" | "changed";

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

export type PreviousPatchedMods = {
  modNames: string[];
  sourceVersions: string[];
};

export type PatchDataCheckStatus = "ok" | "missing" | "changed" | "no_backup";

export type PatchDataCheckEntry = {
  modName: string;
  name: string;
  bundleId: string;
  bundlePath: string;
  status: PatchDataCheckStatus;
  message: string;
};

export type PatchDataCheckResult = {
  ok: boolean;
  entries: PatchDataCheckEntry[];
};

export type ApplyPatchOptions = {
  pythonPath?: string;
  patchBackend?: PatchBackend;
  dotnetPath?: string;
  uabeaPatcherProjectPath?: string;
  converterPath?: string;
  unityVersion?: string;
  decryptKey?: string;
};

export type PatchBackend = "auto" | "uabea" | "uabea-astc" | "rust-native" | "unitypy";

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
  backend?: PatchBackend;
  timing?: PatchTimingEntry;
  message: string;
};

export type PatchTimingEntry = {
  name: string;
  ms: number;
};

export type ApplyPatchResult = {
  ok: boolean;
  entries: PatchRunEntry[];
  history: PatchHistory;
};
