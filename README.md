<p align="center">
  <img src="build/icon.png" alt="BD-SpineX icon" width="128" height="128">
</p>

<h1 align="center">BD-SpineX</h1>

<p align="center">
  BrownDust II PlayCover mod manager for macOS.
</p>

[![GitHub Release](https://img.shields.io/github/v/release/suzumiyahifumi/BD-SpineX?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Downloads](https://img.shields.io/github/downloads/suzumiyahifumi/BD-SpineX/total?style=flat-square)](https://github.com/suzumiyahifumi/BD-SpineX/releases)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)](#requirements)
[![License](https://img.shields.io/badge/source-GPLv3-blue?style=flat-square)](LICENSE)

> Easily manage, preview, and switch BrownDust II Spine mods for the PlayCover version on Mac.
>
> Download the latest version: [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases)

BD-SpineX is made for players who want a cleaner way to use BrownDust II mods on macOS. Keep your mods in one folder, preview them before installing, stage changes safely, and apply everything from a single app.

If you run into problems or have ideas, feel free to open an issue.

> [!WARNING]
> Use the BD-SpineX release that matches your BrownDust II game version. Close BrownDust II before installing or removing Runtime Injection, applying changes, or restoring all mods.

---

## ✨ Features

- **Cartridge Library**: Browse your mods as visual cartridges, filter them quickly, and see which ones are mounted, staged, or conflicting.

- **Pending Changes**: Review everything before applying. Click a pending item to jump back to the matching cartridge.

- **Spine Preview**: Preview supported Spine mods before installing. Compare up to two mods, switch animations, stack animation tracks, and adjust visible parts.

- **Roster View**: Find mods by character instead of digging through folders.

- **One-click Apply**: Stage the mods you want, then apply the whole set when you are ready.

- **Restore All**: Remove all mounted mods in one go while keeping your source mod folder untouched.

- **Mod Power**: Temporarily turn mounted mods off or back on without deleting them.

- **Author Labels**: Add or adjust author stickers so your library stays easy to recognize.

- **PlayCover-first Workflow**: Designed around the macOS PlayCover version of BrownDust II.

---

## Requirements

- macOS on Apple Silicon
- PlayCover version of BrownDust II
- A BD-SpineX release matching your BrownDust II game version

The app may be unsigned. On first launch, macOS might ask you to approve it in System Settings.

---

## ⚙️ How to Use

1. Download the DMG from [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases).
2. Open BD-SpineX.
3. Choose your Mods Folder.
4. Click **Install Runtime Injection**.
5. Click **Refresh Mods**.
6. Select the mods you want to use.
7. Click **Apply Changes**.
8. Launch or restart BrownDust II.

After a BrownDust II update, download the matching BD-SpineX release and install Runtime Injection again.

---

## 📁 Mods Folder

You can organize mods however you like. Nested folders are supported.

```text
Mods/
  AuthorName/
    Character Costume/
      char123456.skel
      char123456.atlas
      char123456.png

  CollectionName/
    Cutscene Pack/
      illust_dating11.json
      illust_dating11.atlas
      illust_dating11.png
```

Each mod folder usually includes:

- `.atlas`
- `.png`
- `.skel` or `.json`

---

## 🖼️ Screenshots

### Library

![BD-SpineX Library](docs/images/readme/library.png)

### Roster

![BD-SpineX Roster](docs/images/readme/roster.png)

### Preview

![BD-SpineX Preview](docs/images/readme/preview.png)

---

## ❓ FAQ

### Where do I download BD-SpineX?

Download the latest release from [GitHub Releases](https://github.com/suzumiyahifumi/BD-SpineX/releases).

### Why are some buttons locked?

BD-SpineX locks actions when the game is running, the game version does not match, Runtime Injection is missing, the Mods Folder is not set, or another task is already running.

### Do I need to close the game before changing mods?

Yes. Close BrownDust II before installing or removing Runtime Injection, applying changes, using Mod Power, or restoring all mods.

### Will Restore All delete my downloaded mods?

No. Restore All removes mounted mods from the game side only. Your source Mods Folder is kept as-is.

### Can I use this with the Windows version?

No. BD-SpineX is built for macOS and the PlayCover version of BrownDust II.

---

## ❤️ Support & Feedback

If BD-SpineX helps you, starring the repo is always appreciated. For bugs, suggestions, or questions, please open an issue on GitHub.

---

## 🙏 Credits & Thanks

- Thanks to the BrownDust II modding community for testing, feedback, and workflows.
- Thanks to the projects and tools that make Spine modding possible.

---

## 📜 License

BD-SpineX source code is licensed under **GPLv3**. See [LICENSE](LICENSE).

Packaged release builds include third-party tools with separate licenses. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for details.
