# BD-SpineX Mac Release

This app is packaged for macOS only. The release bundle includes the shared index files, the Spine converter, the UABEA patch backend, the UnityPy backend, and the Rust native CLI so users do not need to compile backend tools after installing.

## Licensing

BD-SpineX source code is licensed under GPLv3. The packaged release bundle includes `SpineSkeletonDataConverter`, which is licensed under PolyForm Noncommercial License 1.0.0, so the downloadable release bundle should be presented as noncommercial. Keep [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) up to date when bundled tools change.

## Build

Set the supported game version and, when needed, a separate hotfix release version:

```sh
BD_SPINEX_GAME_VERSION=1.2.3 npm run dist:mac
BD_SPINEX_GAME_VERSION=1.2.3 BD_SPINEX_RELEASE_VERSION=1.2.3-b2 npm run dist:mac
```

The command writes:

- `release/BD-SpineX-<version>-arm64.dmg`
- `release/BD-SpineX-<version>-arm64-mac.zip`

The macOS app icon is read from `build/icon.icns`. Keep `build/icon.png` as the source image when regenerating the icon.

## Packaged Resources

Only these `manager-data` files are bundled:

- `manager-data/shared-index.json`
- `manager-data/shared-file-index.json`

Runtime data such as patch history, converted files, user-scanned indexes, and backups is written to a versioned Electron `userData` folder, not into the app bundle:

```text
manager-data/versions/<supported-game-version>/
```

For hotfix builds, suffixes such as `-b2` are stripped for runtime data, so `2.25.29-b2` stores data under `manager-data/versions/2.25.29/`. This prevents a new game/index version from reusing stale history or backup files from older `__data` bundle hashes while allowing same-game hotfixes to keep using the same history.

## Checks

`npm run release:prepare` fails if required release inputs are missing or if packaged inputs contain private local paths such as `/Users/...` or `/Volumes/...`.

The current build config skips code signing. For public distribution, sign and notarize the app with an Apple Developer ID certificate.
