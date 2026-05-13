# Rust Backend Notes

## Current Shape

The Rust CLI now has two execution paths:

- default: forwards scan, patch, and inspect to the existing .NET UABEA / AssetsTools.NET prototype.
- `--rust-backend native`: runs Rust-native code where implemented.

Native Rust scan is implemented as an experiment through `unity-asset-binary`.
It loads UnityFS AssetBundles, walks serialized objects, and emits the same JSON shape as the UABEA scanner for `TextAsset` and `Texture2D` candidates.

Native Rust patch now reads the same job manifest as the UABEA patcher and performs a Rust-side planning pass:

- scan the target bundle
- match atlas / skel / png replacement targets
- report `would_*` changes and missing targets in the normal patch JSON shape

It still returns `ok: false` before writing. This is intentional because bundle write/repack is not implemented safely yet.
Native Rust inspect also intentionally returns a JSON error for now.

## Why Patch Is Still UABEA

The current C# patcher depends on mature editing behavior from AssetsTools.NET:

- replace `TextAsset.m_Script`
- encode PNGs into `Texture2D`
- insert new `Texture2D` objects
- clone and update `Material` objects
- update `MonoBehaviour` atlas material arrays
- update `AssetBundle.m_PreloadTable` and `m_Container`
- write and LZ4-pack the modified bundle

The Rust crates checked during this pass are useful but not yet a drop-in replacement:

- `unity-asset-binary` / `unity-asset` can parse UnityFS bundles, serialized files, TypeTrees, and object metadata.
- upstream documentation and README describe the binary side as parser-focused / read-only for manipulation.
- `runirip` is worth watching as a manipulation-oriented Rust library, but it still appears early-stage for this specific writeback workload.

## Next Milestones

1. Compare Rust-native scan output against UABEA scan output on the same `__data` files.
2. Add native inspect once scan parity is acceptable.
3. Prototype a single-object `TextAsset` replacement in Rust on a copied bundle.
4. Only after byte-level validation, attempt `Texture2D` replacement and bundle repacking.
5. Keep the manager default on UABEA until patch parity is proven.
