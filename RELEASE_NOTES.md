# Release Notes

## BD-SpineX

**BD-SpineX is a macOS tool built specifically for installing and managing mods for the PlayCover version of _BrownDust II_.**

It is designed for players who want a smoother mod workflow: scan your game data, organize your mod folders, apply selected mods, and restore changes without manually opening AssetBundle editors.

## What It Does

- Scans PlayCover's `Shared` game cache and maps mod targets to the correct AssetBundles
- Scans Mods folders recursively, so you can organize mods by source, author, pack, or character
- Shows detected mod status before you apply anything
- Lets you enable or disable selected mods from one table
- Applies Spine `.atlas`, `.skel`, `.json`, and `.png` mod files
- Converts supported Spine `.json` files automatically when needed
- Keeps backups for restore workflows
- Keeps history and backups separated by game/app version
- Includes **Mod Power** for quickly turning active mods off and restoring saved mod state later
- Locks mod actions when required folders are missing or when the app version does not match the detected game version

## Version Matching

Use the BD-SpineX release that matches your _BrownDust II_ game version.

```text
BD-SpineX 2.25.19 -> BrownDust II 2.25.19
```

If the detected game version is different, BD-SpineX locks mod actions and asks you to update the app version.

History, backups, and user-scanned indexes are stored separately per version. After a game update, use the matching BD-SpineX release and rescan so old `__data` hashes are not reused.

When BD-SpineX finds patched mods in an older version history, it selects those mods for review and asks whether to inherit the previous installation automatically. Confirming runs a fresh patch against the current version's index instead of reusing old backups.

## First-Time Setup

BD-SpineX needs two folders:

- **Shared Folder**: PlayCover's _BrownDust II_ `Shared` cache folder
- **Mods Folder**: the folder where you store your mods

Missing folder settings are highlighted in red, and mod actions stay locked until both are set.

## Recommended Mods Layout

Nested folders are supported:

```text
Mods/
  Nexus/
    AuthorName/
      CostumePack/
        char123456.skel
        char123456.atlas
        char123456.png
  Discord/
    CollectionName/
      AnotherMod/
        char654321.json
        char654321.atlas
        char654321.png
```

Each mod folder should contain matching Spine files:

- `.atlas`
- `.png`
- `.skel` or `.json`

## Basic Use

1. Select **Shared Folder**.
2. Select **Mods Folder**.
3. Click **Scan Mods**.
4. Click **Scan Shared for Mods**.
5. Choose the mods you want.
6. Click **Apply Changes**.

## Notes

- BD-SpineX is macOS-only.
- It is intended for the PlayCover version of _BrownDust II_.
- The packaged app includes its required backend tools; users do not need to build them.
- The app is currently unsigned, so macOS may require manual approval the first time you open it.
- Keep your own backup before experimenting with mods, especially after game updates.
