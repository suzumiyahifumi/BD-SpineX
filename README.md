<p align="center">
  <img src="build/readme-icon.png" alt="BD-SpineX icon" width="128" height="128">
</p>

<h1 align="center">BD-SpineX</h1>

<p align="center">
  A macOS Spine mod manager for the PlayCover version of BrownDust II.
</p>

[![GitHub Release](https://img.shields.io/github/v/release/suzumiyahifumi/BD-SpineX?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Downloads](https://img.shields.io/github/downloads/suzumiyahifumi/BD-SpineX/total?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)](#requirements)

> ✨ Install and manage Spine mods for the PlayCover version of BrownDust II on macOS.
>
> ⬇️ Download the latest version: [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases)

BD-SpineX is built for players who want a simpler BrownDust II mod workflow on macOS: choose your PlayCover game data, scan your mod folders, apply selected Spine mods, and restore changes without manually editing AssetBundles.

---

## ✨ Current Release

The app version is tied to the supported BrownDust II game version.

```text
BD-SpineX 2.25.19 -> BrownDust II 2.25.19
```

If your installed game version does not match the BD-SpineX release version, mod actions are locked until you use a matching release.

### 🚀 Highlights

- 🔎 PlayCover `Shared` AssetBundle scanning
- 📁 Recursive Mods folder scanning
- ✅ Mod status table with selectable apply/restore workflow
- 🧩 Spine `.atlas`, `.skel`, `.json`, and `.png` patch support
- 🔄 Automatic supported Spine JSON conversion when needed
- 🛟 Incremental backups and restore support
- 🗂️ Versioned history, backups, converted files, and user-scanned indexes
- ⚡ Mod Power for turning active mods off and restoring saved selections later
- 📦 Bundled backend tools, so release users do not need .NET, Rust, or build tools

---

## 🖥️ Requirements

- 🍎 macOS
- 🎮 PlayCover version of BrownDust II
- 🔐 A BD-SpineX release matching your current BrownDust II version

⚠️ The current release build is unsigned. On first launch, macOS may require manual approval in System Settings.

---

## 🛠️ How to Use

1. Download the macOS build from [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases).
2. Open BD-SpineX.
3. Select your PlayCover BrownDust II `Shared` folder.
4. Select the folder where you store your mods.
5. Click `Scan Mods`.
6. Click `Scan Shared for Mods`.
7. Select the mods you want to install.
8. Click `Apply Changes`.

💡 After changing mod selections, apply changes again so the game files match your current enabled list.

---

## 📁 Recommended Mods Layout

BD-SpineX supports nested folders, so you can organize mods by source, author, pack, character, or any structure you prefer.

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

---

## 🔐 Version Matching

Use the BD-SpineX release that matches your BrownDust II game version.

When the game updates, install the matching BD-SpineX release and rescan your `Shared` folder. BD-SpineX keeps history and backups separated by version so old bundle hashes are not reused on a newer game build.

If BD-SpineX finds patched mods from an older version, it can select them for review and ask whether to inherit the previous install state. Confirming runs a fresh patch against the current version's index.

---

## 📝 Notes

- 🍎 BD-SpineX is macOS-only.
- 🎮 BD-SpineX is intended for the PlayCover version of BrownDust II.
- 🛟 Keep your own backup before experimenting with mods, especially after game updates.
- 📦 The packaged app includes the required patch backend and Spine converter.
- 🧰 Development and packaging notes are kept in [RELEASE.md](RELEASE.md).

---

## ❓ FAQ

### 🔒 Why are mod actions locked?

BD-SpineX locks mod actions when required folders are missing or when the app version does not match the detected BrownDust II version.

### 📦 Do I need to install .NET, Rust, or UABEA?

No. Release builds bundle the backend tools needed by the app.

### 🪟 Can I use this with the Windows version of BrownDust II?

No. This project is currently built for macOS and the PlayCover version of BrownDust II.

---

## 🙏 Credits

- 💬 Thanks to the BrownDust II modding community for the workflows and testing needs this tool is built around.
- 🧩 Thanks to the projects and tools that make Spine and AssetBundle patching possible.
