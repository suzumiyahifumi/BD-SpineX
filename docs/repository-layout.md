# Repository Layout

BD-SpineX keeps public app work and private runtime-injection research separate.

## Public GitHub Surface

- `app/` - renderer, preload, and Electron shell.
- `core/` - public Patch `__data` engine plus runtime-facing type/fallback stubs.
- `python/` - Patch `__data` UnityPy helpers.
- `experiments/` - public Patch `__data` backend prototypes.
- `manager-data/versions/` - versioned shared indexes that ship with the app.
- `manager-data/tools/SpineSkeletonDataConverter` - bundled converter entrypoint.
- `docs/` - README assets, design docs, release notes, and project notes.
- `scripts/` - public build, packaging, and maintenance scripts.
- `src-tauri/` - public Tauri shell stub for frontend development.

## Local-Only Surface

- `private/runtime-injection/` - runtime-injection source, loader payload, Mach-O injection helpers, probes, and research notes.
- `mods/` - downloaded or test mods.
- `local/` - local test resources, screenshots, sample inputs, and scratch assets.
- `manager-data/backups/` and `manager-data/converted/` - generated user data.
- `dist/`, `dist-native/`, `release/`, `tmp/`, `.venv/`, `.claude/` - build output, tool caches, local environments, and personal settings.

Official release packaging expects `private/runtime-injection/` to exist locally so the private loader can be built into `dist-native/bd2loader/libbd2loader.dylib`. Public source builds can still typecheck and build the frontend without that private workspace.
