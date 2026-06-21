# Third-Party Licenses

BD-SpineX source code is licensed under **GNU General Public License v3.0**. See [LICENSE](LICENSE).

Packaged BD-SpineX releases include third-party tools and libraries that remain under their own licenses. The packaged release bundle is distributed for noncommercial use because it includes `SpineSkeletonDataConverter`, which is licensed under **PolyForm Noncommercial License 1.0.0**.

## Release Bundle License Notice

The installable BD-SpineX release package includes:

- BD-SpineX application code: GPLv3
- `SpineSkeletonDataConverter`: PolyForm Noncommercial License 1.0.0
- UABEA-style patch backend using `AssetsTools.NET`: MIT and compatible dependency licenses
- Electron/React/Vite runtime dependencies: mostly MIT/BSD/ISC/Apache-2.0
- Rust native CLI prototype dependencies: MIT/Apache-2.0/BSD/0BSD/Unlicense-compatible licenses
- BD2ModManager type icons: GPLv3
- BD2ModManager character metadata and standing images: source/credit notice below
- Bundled label fonts: SIL Open Font License 1.1

Because `SpineSkeletonDataConverter` is bundled, the release package should be treated as **PolyForm Noncommercial License 1.0.0 for distribution/use of the bundled converter**, while BD-SpineX's own source code remains GPLv3.

## Bundled Tool: SpineSkeletonDataConverter

Path in development workspace:

```text
manager-data/tools/SpineSkeletonDataConverter
```

Source/license references currently present in this repository:

```text
manager-data/tools/source/v3.7/wang606-SpineSkeletonDataConverter-d02514c/LICENSE
manager-data/tools/git-source/v3.7/SpineSkeletonDataConverter/LICENSE
```

License:

```text
PolyForm Noncommercial License 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
```

## Other Notable Dependencies

- Electron: MIT
- React / React DOM: MIT
- Vite / Rollup / esbuild: MIT
- TypeScript: Apache-2.0
- AssetsTools.NET / AssetsTools.NET.Texture: MIT
- AssetRipper.TextureDecoder: MIT
- Rust `unity-asset-binary` / `unity-asset-core`: MIT
- BD2ModManager public type icons (`app/renderer/public/bd2modmanager-icons`): GPLv3, source https://github.com/bruhnn/BD2ModManager
- BD2ModManager character metadata (`app/renderer/src/data/bd2-characters.json`) and public character standing images (`app/renderer/public/characters/standing`): sourced from https://github.com/bruhnn/BD2ModManager, which credits myssal/Brown-Dust-2-Asset for character assets
- Barlow Condensed label font (`app/renderer/public/fonts/barlow-condensed-*.ttf`): SIL Open Font License 1.1, source https://fonts.google.com/specimen/Barlow+Condensed
- Noto Sans TC label fallback (`app/renderer/public/fonts/noto-sans-tc-*.ttf`): SIL Open Font License 1.1, source https://fonts.google.com/noto/specimen/Noto+Sans+TC

This file is a summary for convenience and is not a replacement for the original license texts included with third-party projects.
