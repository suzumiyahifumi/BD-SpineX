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
      const matches = sharedIndex.bundles
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

      if (completeMatches.length > 0) {
        return completeMatches.map((match) => ({
          modName: mod.modName,
          name: mod.name,
          bundleId: match.bundle.bundleId,
          bundlePath: match.bundle.dataPath,
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
        status,
        targets: match.targets,
        missingTargets: match.missingTargets
      }];
    })
  };
}

type RequiredTarget = PatchMissingTarget;

function getRequiredTargets(mod: ModEntry): RequiredTarget[] {
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
    ...mod.files.png.map((file) => ({
      assetName: file.baseName,
      type: "Texture2D" as const,
      sourceFile: file.file
    }))
  ];

  return dedupeRequiredTargets(targets);
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

function countTargets(targets: PatchPlanEntry["targets"]) {
  return (targets.atlases?.length ?? 0) + (targets.skels?.length ?? 0) + (targets.textures?.length ?? 0);
}

function targetSignature(targets: PatchPlanEntry["targets"]) {
  return [
    ...(targets.atlases ?? []),
    ...(targets.skels ?? []),
    ...(targets.textures ?? [])
  ]
    .map((target) => `${target.type}:${target.assetName.toLowerCase()}`)
    .sort()
    .join("|");
}

function targetKey(target: Pick<PatchTarget, "assetName" | "type">) {
  return `${target.type}:${target.assetName.toLowerCase()}`;
}

function findAsset(assets: BundleAsset[], predicate: (asset: BundleAsset) => boolean) {
  return assets.find(predicate);
}

function toTarget(asset: BundleAsset) {
  return {
    assetName: asset.name,
    type: asset.type,
    pathId: asset.pathId
  };
}
