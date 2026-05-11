# UABEA Patch Prototype

Experimental patch backend using the same underlying family of libraries as UABEA: `AssetsTools.NET` plus `AssetsTools.NET.Texture`.

This is intentionally not wired into the manager. It reads the current `__data.patch-jobs.json` shape and writes a patched bundle to an explicit output path.

## Usage

```bash
dotnet run --project experiments/uabea-patcher -- \
  --input /path/to/__data \
  --output /tmp/__data.uabea-patched \
  --job-manifest manager-data/backups/.../__data.patch-jobs.json \
  --compression lz4
```

`--compression none` writes the bundle without recompression for timing comparison.

## Notes

- TextAsset replacement is implemented for `.atlas` and `.skel`.
- Texture2D replacement uses `AssetsTools.NET.Texture` and mirrors UABEA's texture path at a CLI level.
- The output is always a separate file. It never modifies manager backups or game files in place.
- This prototype requires .NET SDK 8+ to build/run.
