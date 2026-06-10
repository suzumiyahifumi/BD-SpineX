# BepInEx-for-PlayCover — 可行性研究報告

> Branch: `bd2/BepInEx_for_playcover`
> 目標：在 macOS + PlayCover 上，做到類似 Windows 桌機版 **BrownDustX (BepInEx 插件)** 的「執行時掛載模組」，
> 取代目前 BD-SpineX 的離線 `__data` Patch 流程。
> 日期：2026-06-10

---

## 1. 結論（先講重點）

**技術上可行。** 不需要修改 `Shared` / 不需要 Patch `__data`，可以做到 Windows 版那樣的執行時替換。
原因是 macOS/PlayCover 上的 BrownDust II 與 Windows 版本質上是**同一個 IL2CPP Unity 遊戲**，
而 PlayCover 本身就已經在用「注入 dylib」的機制（PlayTools），這正好是 Windows 上 BepInEx「Doorstop」做的事的等價物。

關鍵差異：
- Windows BrownDustX 用 **BepInEx + Harmony** 在 **C#/Mono 層**做 method patch。
- 我們在 macOS 上沒有現成的 BepInEx IL2CPP 移植，但遊戲有完整的 **`il2cpp_*` C API（241 個導出函式）**，
  所以可以用 **原生 dylib（C/Rust/Swift）+ inline hook（Dobby/fishhook）+ il2cpp API** 達到同樣效果。
- 換句話說：我們要做的是「**BepInEx 的角色，用原生 hook 取代 Harmony**」。

---

## 2. 已驗證的環境事實（本機靜態分析）

App bundle：
`~/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app`

| 項目 | 結果 | 對開發的意義 |
|------|------|--------------|
| 主程式 `BrownDustII` 架構 | Mach-O **arm64**，executable | 原生 Apple Silicon，無轉譯層 |
| `UnityFramework.framework/UnityFramework` | Mach-O **arm64** dylib，206 MB | IL2CPP runtime 所在 |
| IL2CPP 加密 `cryptid` | **0（已解密）** | 主程式與 UnityFramework 都可靜態分析、可 dump metadata |
| `global-metadata.dat` | 存在，`Data/Managed/Metadata/`，55 MB | 可用 Il2CppDumper 還原類別/方法 |
| `il2cpp_*` 導出函式數量 | **241 個** | 有完整 hook 工具鏈（見下） |
| Code signing | **adhoc**，**無 hardened runtime（flags=0x2）** | **library validation 沒有開啟** → 可載入自簽/未簽 dylib |
| 注入機制 | 主程式已被加入 `LC_LOAD_DYLIB` → `~/Library/Frameworks/PlayTools.framework/PlayTools` | **這就是我們的注入點範本**（Doorstop 等價物） |
| Sandbox | `app-sandbox=true`，但 SBPL 例外允許 **讀寫** `~/Library/Containers/io.playcover.PlayCover` | 模組檔與 plugin 放這裡可被遊戲程序存取 |
| `get-task-allow` entitlement | **不存在** | Frida 無法直接 `attach`（見 §4 限制） |
| PlayTools 插件機制 | `PlayTools.framework/PlugIns/AKInterface.bundle` | PlayCover 自己也用 bundle 外掛，可參考其載入流程 |

關鍵 `il2cpp_*` 導出（已確認存在）：
`il2cpp_init`、`il2cpp_domain_get`、`il2cpp_domain_get_assemblies`、
`il2cpp_class_from_name`、`il2cpp_resolve_icall`、`il2cpp_runtime_invoke`、
`il2cpp_object_new`、`il2cpp_thread_attach`、`il2cpp_init_utf16` …（共 241）。

---

## 3. 與 Windows BrownDustX 的對照（hook 目標相同）

反組譯 `doc/BepInEx/plugins/BrownDustX/lynesth.bd2.browndustx.dll` 取得它 Harmony patch 的目標，
再去 macOS 的 `global-metadata.dat` 比對是否存在同名類別/方法：

| Windows BrownDustX 目標 | macOS metadata 命中數 | 說明 |
|--------------------------|------------------------|------|
| `SkeletonGraphic`（spine-unity） | 10 | Spine 渲染元件，存在 |
| `SkeletonDataAsset` | 4 | 骨架資料 asset，存在 |
| `SpineAtlasAsset` / `AtlasAssetBase` | 3 / 3 | Atlas asset，存在 |
| `GetIllustSpinePrefab` | 1 | 角色立繪 Spine 取得方法，存在 |
| `GetDatingIllustSpinePrefab` | 1 | 約會立繪，存在 |
| `MenuIllustController` | 1 | 立繪控制器，存在 |
| `SpineAnimationController` | 1 | 動畫控制器，存在 |
| `AssetBundle.LoadFromFile` | 3（`LoadFromFile`） | 可用來載入模組 bundle |
| `GetSpineSceneContainer` | 0 | iOS build 可能改名/內聯，需 dump 後再定位（非阻塞） |

**結論：Windows 版所依賴的 Spine 替換 API 在 macOS build 幾乎全部存在**，
代表 BrownDustX 的策略（hook `Get*SpinePrefab` → 替換 `skeletonDataAsset` / `atlasAssets`）可以原樣移植。

---

## 4. 已知限制與對策

1. **Frida 無法直接 attach（無 `get-task-allow`）。**
   - 對策 A（研究/探測階段）：重簽 app 加上 `get-task-allow`，再 `frida -n BrownDustII`。
   - 對策 B（推薦，與最終產品一致）：把 **frida-gadget** 當成一個 dylib，用 §2 的 `LC_LOAD_DYLIB` 手法注入。
     因為 library validation 沒開，這條路最乾淨，也直接驗證了最終注入管線。

2. **本機尚未安裝任何工具。**
   - 需安裝：`frida` / `frida-tools`（探測）、`Il2CppDumper` 或 `Il2CppInspector`（metadata）、
     `Dobby`（inline hook，後期）、`ldid` 或 Xcode `codesign`（重簽）。

3. **IL2CPP，不是 Mono。** 不能像 BepInEx Mono 模式直接丟 C# DLL 進去跑。
   必須走「原生 hook + il2cpp API」路線，或長期評估移植 BepInEx 6 (Il2CppInterop) — 後者成本高，列為非優先。

4. **Sandbox 路徑限制。** 模組與 plugin 必須放在 `~/Library/Containers/io.playcover.PlayCover` 子路徑下，
   否則遊戲程序讀不到。這也決定了 mod 資料夾的設計位置。

5. **PlayCover/遊戲更新會覆蓋注入。** 每次重裝或更新 app 後，`LC_LOAD_DYLIB` 與重簽會被洗掉，
   需要管理器重新套用（與目前 BD-SpineX「套用/還原」流程相同概念）。

6. **重簽合法性。** 僅供本機個人使用、不散布遊戲檔；工具散布的是「注入器 + 我們自己的 plugin」，不含遊戲資產。

---

## 5. 可行性判定

| 問題 | 判定 |
|------|------|
| 能不能不改 `Shared` / 不 Patch `__data` 就替換 Spine？ | ✅ 可行 |
| 有沒有注入點？ | ✅ 有（PlayTools 的 `LC_LOAD_DYLIB` 模式，library validation 關閉） |
| 有沒有 hook 能力？ | ✅ 有（241 個 il2cpp 導出 + Dobby inline hook） |
| Windows 版策略能否移植？ | ✅ 能（hook 目標方法在 macOS build 存在） |
| 探測階段的阻礙？ | ⚠️ Frida 需重簽或用 gadget；工具待安裝 |
| 最大未知數 | metadata dump 後實際方法簽章 / `Get*SpinePrefab` 的回傳物件結構 |

→ **進入 Phase 1（Runtime Probe）與 Phase 2（IL2CPP Metadata dump）。** 詳見 `DEVELOPMENT_PLAN.md`。
