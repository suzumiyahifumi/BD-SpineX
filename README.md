# BD-SpineX Developer README

BD-SpineX is an Electron + TypeScript desktop app for managing Spine mods for the PlayCover version of _BrownDust II_ on macOS.

This repository contains the application source, packaging scripts, bundled index data, and backend experiments used by the release build.

For user-facing release copy, see [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Current Product Shape

The app provides:

- PlayCover `Shared` AssetBundle scanning
- Portable shared index loading from bundled release resources
- Recursive Mods folder scanning
- Patch plan generation from mod files and indexed Unity assets
- Incremental apply/restore workflows with backups
- Mod Power for turning all active mods off and restoring saved state
- Version locking between BD-SpineX and the detected game version
- macOS release packaging with bundled backend tools

## Tech Stack

- Electron main/preload/renderer
- React renderer
- TypeScript
- Vite
- UABEA / AssetsTools.NET patch backend
- Rust CLI wrapper and native scanner/patch-planner experiment
- Bundled SpineSkeletonDataConverter
- electron-builder for macOS packaging

## Project Layout

```text
app/
  main/        Electron main process and IPC handlers
  preload/     Safe renderer bridge
  renderer/    React UI
core/
  asset-patcher.ts     Backend patch runner selection
  backup-manager.ts    Original/modded backup handling
  game-version.ts      PlayCover game version detection
  mod-indexer.ts       Recursive Mods folder scanner
  patch-plan.ts        Shared asset to mod matching
  patch-runner.ts      Apply/restore orchestration
  runtime-paths.ts     Dev vs packaged resource/userData paths
  shared-indexer.ts    Shared cache scanner and portable index loader
  spine-converter.ts   Spine JSON to SKEL conversion wrapper
  tool-manager.ts      Converter discovery/download in dev
experiments/
  rust-uabea-cli/      Rust CLI wrapper and native backend experiment
  uabea-patcher/       AssetsTools.NET patch backend
manager-data/
  shared-index.json       Release-bundled portable index
  shared-file-index.json  Release-bundled Shared file index
scripts/
  build-backends.mjs      Publishes backend binaries for release
  prepare-release.mjs     Version sync and release input validation
```

## Runtime Paths

Development mode reads and writes local project data:

```text
manager-data/
```

Packaged mode splits data by purpose:

- Bundled read-only resources: `process.resourcesPath`
- Runtime writable data: Electron `app.getPath("userData")`
- Versioned runtime data: `manager-data/versions/<app-version>/`

Patch history, backups, converted files, and user-generated shared indexes are versioned by app/game version. This prevents a newer game build from reusing stale bundle hashes or backups from an older index.

Example packaged data path:

```text
~/Library/Application Support/BD-SpineX/manager-data/versions/2.25.19/
```

This keeps private local paths, patch history, converted files, and backups out of the release bundle.

If an older version history contains mods whose latest state is `patched`, the renderer asks the user whether to inherit that selection. Acceptance triggers a fresh patch using the current version's Shared index; rejection simply unlocks the UI while keeping the imported checkbox selection for manual review.

## Development

Install dependencies:

```sh
npm install
```

Run the app in development mode:

```sh
npm run dev
```

Run type checks:

```sh
npm run typecheck
```

Build the Electron app and renderer:

```sh
npm run build
```

## Backend Builds

Build release backend binaries:

```sh
npm run build:backends
```

This publishes:

- `dist-native/uabea-patcher/UabeaPatchPrototype`
- `dist-native/uabea-cli/uabea_cli`

The packaged app uses those binaries directly, so end users do not need .NET, Cargo, or backend build tools.

## Release Build

Set the app version to the target _BrownDust II_ game version:

```sh
BD_SPINEX_GAME_VERSION=2.25.19 npm run dist:mac
```

The release script performs:

1. Backend build
2. Version sync into `package.json` and `package-lock.json`
3. Release input validation
4. TypeScript/Vite build
5. macOS DMG/zip packaging

Outputs:

```text
release/BD-SpineX-<version>-arm64.dmg
release/BD-SpineX-<version>-arm64-mac.zip
```

## Release Inputs

The release package includes only selected runtime resources:

- `manager-data/shared-index.json`
- `manager-data/shared-file-index.json`
- `manager-data/tools/SpineSkeletonDataConverter`
- `dist-native/uabea-patcher`
- `dist-native/uabea-cli`
- `build/icon.icns`

It must not include:

- `manager-data/patch-history.json`
- `manager-data/backups`
- `manager-data/converted`
- local `/Users/...` or `/Volumes/...` paths

`npm run release:prepare` checks required inputs and scans release-relevant files for private path leaks.

## Version Locking

The app version is treated as the supported game version. At runtime, BD-SpineX detects the installed _BrownDust II_ version from PlayCover-related metadata and locks mod actions if it does not match `app.getVersion()`.

Example:

```text
BD-SpineX 2.25.19 supports BrownDust II 2.25.19
```

## macOS App Icon

The release icon is:

```text
build/icon.icns
```

Keep `build/icon.png` as the source image when regenerating the icon.

## DevTools Policy

DevTools are available in development mode.

Packaged builds disable DevTools, remove the application menu, and intercept common DevTools shortcuts.

## Signing

The current build config skips macOS code signing:

```json
"identity": null
```

For public distribution, sign and notarize with an Apple Developer ID certificate.

## Notes For Release Repositories

For a separate release-only repository, use:

- `RELEASE_NOTES.md` as the user-facing description
- The generated `.dmg` and `.zip` from `release/`
- Versioned release titles matching the game version
