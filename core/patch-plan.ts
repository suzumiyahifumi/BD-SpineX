import fs from "node:fs";
import path from "node:path";
import type {
  AssetType,
  BundleAsset,
  ModEntry,
  PatchMissingTarget,
  ModsIndex,
  PatchPlanEntry,
  PatchPlanIndex,
  PatchTarget,
  SharedBundle,
  SharedIndex
} from "./types.js";

export function createPatchPlan(sharedIndex: SharedIndex, modsIndex: ModsIndex): PatchPlanIndex {
  const bundlesById = new Map(sharedIndex.bundles.map((bundle) => [bundle.bundleId, bundle]));

  return {
    plans: modsIndex.mods.flatMap((mod): PatchPlanEntry[] => {
      if (mod.status !== "ready") {
        return [{
          modName: mod.modName,
          name: mod.name,
          status: "mod_not_ready",
          targets: {}
        }];
      }

      const requiredTargets = getRequiredTargets(mod);
      const candidateBundles = findCandidateBundles(sharedIndex, bundlesById, mod.name, requiredTargets);
      const matches = normalizeVariableAtlasPageTextureTargets(mod, candidateBundles
        .map((bundle) => {
          const targets = findTargets(bundle, mod.name, requiredTargets);
          const foundCount = countTargets(targets);
          return {
            bundle,
            targets,
            foundCount,
            missingTargets: findMissingTargets(requiredTargets, targets)
          };
        })
        .filter((match) => match.foundCount > 0)
        .sort((a, b) => a.missingTargets.length - b.missingTargets.length), requiredTargets)
        .sort((a, b) => a.missingTargets.length - b.missingTargets.length);

      if (matches.length === 0) {
        return [{
          modName: mod.modName,
          name: mod.name,
          status: "bundle_not_found",
          targets: {},
          missingTargets: requiredTargets
        }];
      }

      const completeMatches = matches.filter((match) => match.missingTargets.length === 0);
      const completeMatchSignatures = new Set(completeMatches.map((match) => targetSignature(match.targets)));
      if (completeMatchSignatures.size > 1) {
        return [{
          modName: mod.modName,
          name: mod.name,
          status: "conflict",
          targets: {}
        }];
      }

      const insertableMatchesWithComplete = matches.filter((match) =>
        match.missingTargets.length > 0 &&
        areInsertableAtlasTextureTargets(mod, match.missingTargets)
      );
      if (completeMatches.length > 0 && insertableMatchesWithComplete.length > 0) {
        return [...completeMatches, ...insertableMatchesWithComplete]
          .sort((a, b) => a.bundle.bundleId.localeCompare(b.bundle.bundleId))
          .map((match) => ({
            modName: mod.modName,
            name: mod.name,
            bundleId: match.bundle.bundleId,
            bundlePath: match.bundle.dataPath,
            bundleSha256: match.bundle.sha256,
            status: "ready",
            targets: match.targets,
            missingTargets: []
          }));
      }

      if (completeMatches.length > 0) {
        return completeMatches.map((match) => ({
          modName: mod.modName,
          name: mod.name,
          bundleId: match.bundle.bundleId,
          bundlePath: match.bundle.dataPath,
          bundleSha256: match.bundle.sha256,
          status: "ready",
          targets: match.targets,
          missingTargets: []
        }));
      }

      const splitMatches = findSplitMatches(getRequiredTextTargets(requiredTargets), matches);
      if (splitMatches) {
        return splitMatches.map((match) => ({
          modName: mod.modName,
          name: mod.name,
          bundleId: match.bundle.bundleId,
          bundlePath: match.bundle.dataPath,
          bundleSha256: match.bundle.sha256,
          status: "ready",
          targets: match.targets,
          missingTargets: []
        }));
      }

      const bestMissingCount = matches[0].missingTargets.length;
      const insertableMatches = matches.filter((match) =>
        match.missingTargets.length === bestMissingCount &&
        areInsertableAtlasTextureTargets(mod, match.missingTargets)
      );
      const insertableMatchSignatures = new Set(insertableMatches.map((match) => targetSignature(match.targets)));
      if (insertableMatchSignatures.size > 1) {
        return [{
          modName: mod.modName,
          name: mod.name,
          status: "conflict",
          targets: {}
        }];
      }
      if (insertableMatches.length > 0) {
        return insertableMatches.map((match) => ({
          modName: mod.modName,
          name: mod.name,
          bundleId: match.bundle.bundleId,
          bundlePath: match.bundle.dataPath,
          bundleSha256: match.bundle.sha256,
          status: "ready",
          targets: match.targets,
          missingTargets: []
        }));
      }

      const match = matches[0];
      const missingTypes = new Set(match.missingTargets.map((target) => target.type));
      const status = missingTypes.has("TextAsset") && match.missingTargets.some((target) => target.assetName.endsWith(".atlas"))
        ? "missing_atlas"
        : missingTypes.has("TextAsset")
          ? "missing_skel"
          : missingTypes.has("Texture2D")
            ? "missing_texture"
            : "ready";

      return [{
        modName: mod.modName,
        name: mod.name,
        bundleId: match.bundle.bundleId,
        bundlePath: match.bundle.dataPath,
        bundleSha256: match.bundle.sha256,
        status,
        targets: match.targets,
        missingTargets: match.missingTargets
      }];
    })
  };
}

type RequiredTarget = PatchMissingTarget;
type CandidateMatch = {
  bundle: SharedBundle;
  targets: PatchPlanEntry["targets"];
  foundCount: number;
  missingTargets: PatchMissingTarget[];
};

function normalizeVariableAtlasPageTextureTargets(
  mod: ModEntry,
  matches: CandidateMatch[],
  requiredTargets: RequiredTarget[]
): CandidateMatch[] {
  const atlasPageNames = getModAtlasPageTextureNames(mod);
  if (matches.length < 2 || atlasPageNames.size === 0) {
    return matches;
  }

  const texturePresence = new Map<string, number>();
  for (const match of matches) {
    const names = new Set((match.targets.textures ?? [])
      .map((target) => target.assetName.toLowerCase())
      .filter((name) => atlasPageNames.has(name)));
    for (const name of names) {
      texturePresence.set(name, (texturePresence.get(name) ?? 0) + 1);
    }
  }

  const variablePageNames = new Set([...texturePresence]
    .filter(([, count]) => count > 0 && count < matches.length)
    .map(([name]) => name));
  if (variablePageNames.size === 0) {
    return matches;
  }

  return matches.map((match) => {
    const targets = removeTextureTargets(match.targets, variablePageNames);
    return {
      ...match,
      targets,
      foundCount: countTargets(targets),
      missingTargets: findMissingTargets(requiredTargets, targets)
    };
  });
}

function removeTextureTargets(targets: PatchPlanEntry["targets"], textureNames: Set<string>): PatchPlanEntry["targets"] {
  const textures = (targets.textures ?? []).filter((target) => !textureNames.has(target.assetName.toLowerCase()));
  const texture = targets.texture && !textureNames.has(targets.texture.assetName.toLowerCase())
    ? targets.texture
    : textures[0];

  return {
    ...targets,
    texture,
    textures
  };
}

function findCandidateBundles(
  sharedIndex: SharedIndex,
  bundlesById: Map<string, SharedBundle>,
  modName: string,
  requiredTargets: RequiredTarget[]
) {
  if (!sharedIndex.assetsByName) {
    return sharedIndex.bundles;
  }

  const bundleIds = new Set<string>();

  for (const target of requiredTargets) {
    for (const entry of sharedIndex.assetsByName[target.assetName.toLowerCase()] ?? []) {
      if (entry.type === target.type) {
        bundleIds.add(entry.bundleId);
      }
    }
  }

  const lowerName = modName.toLowerCase();
  for (const [assetName, entries] of Object.entries(sharedIndex.assetsByName)) {
    if (!assetName.includes(lowerName)) {
      continue;
    }

    for (const entry of entries) {
      if (isSpineCandidateAsset(entry.assetName.toLowerCase(), entry.type)) {
        bundleIds.add(entry.bundleId);
      }
    }
  }

  return [...bundleIds]
    .map((bundleId) => bundlesById.get(bundleId))
    .filter((bundle): bundle is SharedBundle => Boolean(bundle));
}

function getRequiredTargets(mod: ModEntry): RequiredTarget[] {
  const atlasTextureNames = getModAtlasPageTextureNames(mod);
  const pngFiles = atlasTextureNames.size > 0
    ? mod.files.png.filter((file) => atlasTextureNames.has(file.baseName.toLowerCase()))
    : mod.files.png;
  const targets = [
    ...mod.files.atlas.map((file) => ({
      assetName: file.file,
      type: "TextAsset" as const,
      sourceFile: file.file
    })),
    ...mod.files.skel.map((file) => ({
      assetName: file.file,
      type: "TextAsset" as const,
      sourceFile: file.file
    })),
    ...mod.files.json.map((file) => ({
      assetName: `${file.baseName}.skel`,
      type: "TextAsset" as const,
      sourceFile: file.file
    })),
    ...pngFiles.map((file) => ({
      assetName: file.baseName,
      type: "Texture2D" as const,
      sourceFile: file.file
    }))
  ];

  return dedupeRequiredTargets(targets);
}

function areInsertableAtlasTextureTargets(mod: ModEntry, missingTargets: PatchMissingTarget[]) {
  if (missingTargets.length === 0 || missingTargets.some((target) => target.type !== "Texture2D")) {
    return false;
  }

  const atlasTextureNames = getModAtlasPageTextureNames(mod);
  if (atlasTextureNames.size === 0) {
    return false;
  }

  const pngNames = new Set(mod.files.png.map((file) => file.baseName.toLowerCase()));
  return missingTargets.every((target) => {
    const name = target.assetName.toLowerCase();
    return atlasTextureNames.has(name) && pngNames.has(name);
  });
}

function getModAtlasPageTextureNames(mod: ModEntry) {
  const names = new Set<string>();

  for (const atlas of mod.files.atlas) {
    for (const line of readTextFileSync(atlas.path).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || line !== trimmed || trimmed.includes(":") || !trimmed.toLowerCase().endsWith(".png")) {
        continue;
      }

      names.add(path.basename(trimmed, path.extname(trimmed)).toLowerCase());
    }
  }

  return names;
}

function readTextFileSync(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function getRequiredTextTargets(targets: RequiredTarget[]) {
  return targets.filter((target) => target.type === "TextAsset");
}

function dedupeRequiredTargets(targets: RequiredTarget[]) {
  const deduped = new Map<string, RequiredTarget>();

  for (const target of targets) {
    const key = `${target.type}:${target.assetName.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, target);
    }
  }

  return [...deduped.values()];
}

function findTargets(bundle: SharedBundle, modName: string, requiredTargets: RequiredTarget[]): PatchPlanEntry["targets"] {
  const lowerName = modName.toLowerCase();
  const atlases = findRequiredAssets(bundle.assets, requiredTargets, "TextAsset", (name) => name.endsWith(".atlas"));
  const skels = findRequiredAssets(bundle.assets, requiredTargets, "TextAsset", (name) => name.endsWith(".skel"));
  const textures = findRequiredAssets(bundle.assets, requiredTargets, "Texture2D");
  const atlas = atlases[0] ?? findAsset(bundle.assets, (asset) =>
    asset.type === "TextAsset" && asset.name.toLowerCase().includes(lowerName) && asset.name.toLowerCase().includes("atlas")
  );
  const skel = skels[0] ?? findAsset(bundle.assets, (asset) =>
    asset.type === "TextAsset" && asset.name.toLowerCase().includes(lowerName) && asset.name.toLowerCase().includes("skel")
  );
  const texture = textures[0] ?? findAsset(bundle.assets, (asset) =>
    asset.type === "Texture2D" && asset.name.toLowerCase().includes(lowerName)
  );

  return {
    atlas: atlas ? toTarget(atlas) : undefined,
    skel: skel ? toTarget(skel) : undefined,
    texture: texture ? toTarget(texture) : undefined,
    atlases: atlases.map(toTarget),
    skels: skels.map(toTarget),
    textures: textures.map(toTarget)
  };
}

function findRequiredAssets(
  assets: BundleAsset[],
  requiredTargets: RequiredTarget[],
  type: AssetType,
  nameFilter?: (name: string) => boolean
) {
  return requiredTargets
    .filter((target) => target.type === type && (!nameFilter || nameFilter(target.assetName.toLowerCase())))
    .map((target) => findAssetByRequiredTarget(assets, target))
    .filter((asset): asset is BundleAsset => Boolean(asset));
}

function findAssetByRequiredTarget(assets: BundleAsset[], target: RequiredTarget) {
  const lowerName = target.assetName.toLowerCase();

  return findAsset(assets, (asset) => {
    if (asset.type !== target.type) {
      return false;
    }

    const assetName = asset.name.toLowerCase();
    if (assetName === lowerName) {
      return true;
    }

    return target.type === "Texture2D" && assetName === lowerName.replace(/\.png$/i, "");
  });
}

function findMissingTargets(requiredTargets: RequiredTarget[], targets: PatchPlanEntry["targets"]) {
  const found = new Set([
    ...(targets.atlases ?? []).map((target) => targetKey(target)),
    ...(targets.skels ?? []).map((target) => targetKey(target)),
    ...(targets.textures ?? []).map((target) => targetKey(target))
  ]);

  return requiredTargets.filter((target) => !found.has(targetKey(target)));
}

function findSplitMatches(requiredTargets: RequiredTarget[], matches: CandidateMatch[]) {
  const requiredKeys = new Set(requiredTargets.map((target) => targetKey(target)));
  const ownersByKey = new Map<string, CandidateMatch[]>();

  for (const match of matches) {
    for (const target of getPlanTargets(match.targets)) {
      const key = targetKey(target);
      if (!requiredKeys.has(key)) {
        continue;
      }

      ownersByKey.set(key, [...(ownersByKey.get(key) ?? []), match]);
    }
  }

  const selected = new Map<string, CandidateMatch>();
  for (const key of requiredKeys) {
    const owners = ownersByKey.get(key) ?? [];
    if (owners.length !== 1) {
      return undefined;
    }

    selected.set(owners[0].bundle.bundleId, owners[0]);
  }

  return [...selected.values()].sort((a, b) => a.bundle.bundleId.localeCompare(b.bundle.bundleId));
}

function countTargets(targets: PatchPlanEntry["targets"]) {
  return (targets.atlases?.length ?? 0) + (targets.skels?.length ?? 0) + (targets.textures?.length ?? 0);
}

function targetSignature(targets: PatchPlanEntry["targets"]) {
  return getPlanTargets(targets)
    .map((target) => `${target.type}:${target.assetName.toLowerCase()}`)
    .sort()
    .join("|");
}

function getPlanTargets(targets: PatchPlanEntry["targets"]) {
  return [
    ...(targets.atlases ?? []),
    ...(targets.skels ?? []),
    ...(targets.textures ?? [])
  ];
}

function targetKey(target: Pick<PatchTarget, "assetName" | "type">) {
  return `${target.type}:${target.assetName.toLowerCase()}`;
}

function findAsset(assets: BundleAsset[], predicate: (asset: BundleAsset) => boolean) {
  return assets.find(predicate);
}

function isSpineCandidateAsset(assetName: string, type: string) {
  return (type === "TextAsset" && (assetName.includes("skel") || assetName.includes("atlas"))) ||
    type === "Texture2D";
}

function toTarget(asset: BundleAsset) {
  return {
    assetName: asset.name,
    type: asset.type,
    pathId: asset.pathId,
    width: asset.width,
    height: asset.height,
    textureFormat: asset.textureFormat,
    textureFormatName: asset.textureFormatName,
    streamDataSize: asset.streamDataSize,
    streamDataPath: asset.streamDataPath,
    imageDataSize: asset.imageDataSize
  };
}
