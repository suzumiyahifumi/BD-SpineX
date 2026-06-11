<p align="center">
  <img src="build/icon.png" alt="BD-SpineX icon" width="128" height="128">
</p>

<h1 align="center">BD-SpineX</h1>

<p align="center">
  Runtime Spine mod manager for the PlayCover version of BrownDust II on macOS.
</p>

[![GitHub Release](https://img.shields.io/github/v/release/suzumiyahifumi/BD-SpineX?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Downloads](https://img.shields.io/github/downloads/suzumiyahifumi/BD-SpineX/total?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)](#requirements)
[![License](https://img.shields.io/badge/source-GPLv3-blue?style=flat-square)](LICENSE)

> Manage BrownDust II Spine mods on macOS without manually editing game bundles.
>
> Download the latest version: [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases)

BD-SpineX is made for the PlayCover version of BrownDust II. Current builds use Runtime Injection: mods are mounted into the game container and loaded at runtime, while the original `__data` files can stay clean.

---

## Requirements

- 🍎 macOS on Apple Silicon
- 🎮 PlayCover version of BrownDust II
- 🔐 A BD-SpineX release matching your BrownDust II game version

The app is currently unsigned. On first launch, macOS may require manual approval in System Settings.

---

## ⚙️ How to Use

1. Download the DMG from [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases).
2. Open BD-SpineX.
3. Select the folder where you keep your mods.
4. Click `Install Runtime Injection`.
5. Click `Refresh Mods`.
6. Select the mods you want.
7. Click `Apply Changes`.
8. Launch or restart the game.

After a BrownDust II game update, install the matching BD-SpineX release and run `Install Runtime Injection` again.

---

## 📁 Mods Folder

Nested folders are supported, so you can organize mods by source, author, pack, or character.

```text
Mods/
  Discord/
    AuthorName/
      CostumePack/
        char123456.skel
        char123456.atlas
        char123456.png
  Nexus/
    CollectionName/
      AnotherMod/
        illust_dating11.json
        illust_dating11.atlas
        illust_dating11.png
```

Each mod folder should include:

- `.atlas`
- `.png`
- `.skel` or `.json`

---

## 🧩 Runtime Injection

Runtime Injection installs `libbd2loader.dylib` into the PlayCover BrownDust II app and adds it to the game executable. BD-SpineX keeps a clean executable backup so injection can be removed later.

- ✅ `Apply Changes` mounts or unmounts selected mods.
- 🧹 `Restore All` removes all mounted runtime mods, but keeps injection installed.
- 💡 `Mod Power` turns all mounted mods off or back on without moving folders.
- 🚀 `Launch Game` opens the PlayCover app bundle through macOS.

Close BrownDust II before installing or removing injection.

---

## 🔄 Upgrading From Older Patch Builds

Older BD-SpineX builds patched `__data` directly. If BD-SpineX detects old patch records, it lets you choose:

- `Do Nothing`: keep files as-is and continue using the app.
- `Unpatch Only`: restore clean `__data` from old backups and remove old patch records.
- `Migrate`: restore clean `__data`, install Runtime Injection, and mount matching mods from your Mods Folder.

If you choose `Do Nothing` and later want a clean `__data`, reinstall BrownDust II in PlayCover.

---

## ⚠️ Notes

- BD-SpineX is macOS-only.
- Use the release that matches your BrownDust II version. Suffixes such as `-ex1` are BD-SpineX experiment/hotfix builds for the same game version.
- Runtime mods may load the first time a matching asset appears in-game, so very large mods can cause a brief first-load stutter.
- Release builds include the required backend tools; users do not need .NET, Rust, Python, or UABEA installed.
- Keep your own backup before experimenting with mods, especially after game updates.

---

## ❓ FAQ

### Why are mods locked?

BD-SpineX locks mod actions when the game app is missing, Runtime Injection is not installed, the Mods Folder is not set, the game version does not match, or a task is already running.

### Do I need to scan PlayCover Shared?

No for runtime mods. The current runtime workflow loads mounted Spine files directly instead of patching `__data`.

### Why do I need to reinject after a game update?

Game updates can replace the BrownDust II app bundle and executable. Reinstall Runtime Injection after updating the game.

### Can I use this with the Windows version?

No. This project is for macOS and PlayCover.

---

## 📜 License

BD-SpineX source code is licensed under **GPLv3**. See [LICENSE](LICENSE).

Packaged release builds include `SpineSkeletonDataConverter`, which is licensed separately under **PolyForm Noncommercial License 1.0.0**. Treat downloadable release bundles as noncommercial because that converter is bundled. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for details.

---

## 🙏 Credits

- Thanks to the BrownDust II modding community for testing, workflows, and feedback.
- Thanks to the projects and tools that make Spine and runtime modding possible.
