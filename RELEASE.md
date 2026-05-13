# BD-SpineX Mac Release

This app is packaged for macOS only. The release bundle includes the shared index files, the Spine converter, the UABEA patch backend, and the Rust native CLI so users do not need to compile backend tools after installing.

## Build

Set the release version to the game version you are building against:

```sh
BD_SPINEX_GAME_VERSION=1.2.3 npm run dist:mac
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
manager-data/versions/<app-version>/
```

This prevents a new game/index version from reusing stale history or backup files from older `__data` bundle hashes.

## Checks

`npm run release:prepare` fails if required release inputs are missing or if packaged inputs contain private local paths such as `/Users/...` or `/Volumes/...`.

The current build config skips code signing. For public distribution, sign and notarize the app with an Apple Developer ID certificate.
