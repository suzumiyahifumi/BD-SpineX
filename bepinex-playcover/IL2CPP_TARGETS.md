# IL2CPP Hook 目標表（Phase 2 產出）

> 來源：對本機 `UnityFramework` + `global-metadata.dat` 執行 Il2CppDumper v6.7.46（net7，roll-forward 到 .NET 8）。
> Metadata Version 31 / Il2Cpp Version 31。
> 完整 dump 在 `dump/`（git 已忽略；可隨遊戲版本重產）。
> 日期：2026-06-10　遊戲版本：BrownDust II 2.27.19（iOS/PlayCover build）

## 重要前提

1. **遊戲自身方法名被混淆**（unicode 亂碼），例如 `MenuIllustController` 的方法、`Get*SpinePrefab`
   只以 **enum 欄位名**（`TypeDefIndex 1643`，`GetAsset/SyncGetAsset/GetPrefabAsset/GetScene/
   GetIllustSpinePrefab/GetSpecialIllustSpinePrefab/GetDatingIllustSpinePrefab`）保留。
   → **不能像 Windows BrownDustX 那樣靠遊戲方法名 hook。**

2. **Spine 函式庫類別未混淆**（來自 `spine-unity.dll`）。
   → 我們改 hook **Spine 層**，這也是 `SPINE_RUNTIME_PROBE_RESEARCH.md` 列的優先級 #1/#2/#4/#5/#6，反而更穩。

3. **RVA 換算**：dump 中 `RVA == Offset == VA`。執行時實際位址 ≈ `UnityFramework.base + RVA`。
   Phase 1 的 `bd2_il2cpp_probe.js` 會用 `il2cpp_class_from_name` + method 列舉取得「執行時真實位址」，
   **必須與 `base + RVA` 交叉驗證**後才可用於 inline hook（避免 ASLR/版本誤差）。

---

## 主要 hook 目標（依優先序）

### 1. `Spine.Unity.SkeletonDataAsset.GetSkeletonData(bool quiet)` — **首選**
- RVA: `0x94A9560`
- 角色骨架資料的總入口。hook 後可回傳我們自建/替換的 `SkeletonData`。
- 類別欄位（offset，供直接改寫）：
  | 欄位 | 型別 | offset |
  |------|------|--------|
  | `atlasAssets` | `AtlasAssetBase[]` | 0x18 |
  | `scale` | float | 0x20 |
  | `skeletonJSON` | `TextAsset` | 0x28 |
  | `skeletonData`（私有快取） | `SkeletonData` | 0x70 |
  | `stateData`（私有快取） | `AnimationStateData` | 0x78 |
- 相關方法：
  | 方法 | RVA | 用途 |
  |------|-----|------|
  | `GetSkeletonData(bool)` | 0x94A9560 | hook 主目標 |
  | `InitializeWithData(SkeletonData)` | 0x94ABBF4 | 注入自建資料 |
  | `Clear()` | 0x94AB55C | 強制重載 |
  | `ReadSkeletonData(byte[], AttachmentLoader, float)` | 0x94AB960 | **.skel 二進位讀取（優先級 #5）** |
  | `ReadSkeletonData(string, AttachmentLoader, float)` | 0x94ABB28 | JSON 讀取（優先級 #6） |
  | `CreateRuntimeInstance(TextAsset, AtlasAssetBase[], bool, float)` | 0x94AB660 | 從檔案建新 asset |

### 2. `Spine.Unity.SpineAtlasAsset.GetAtlas(bool onlyMetaData)` — **Atlas 替換（優先級 #4）**
- RVA: `0x94AC8F4`（Slot 9，virtual override）
- 類別 `SpineAtlasAsset : AtlasAssetBase`，欄位：
  | 欄位 | 型別 | offset |
  |------|------|--------|
  | `atlasFile` | `TextAsset` | 0x18 |
  | `materials` | `Material[]` | 0x20 |
  | `customTextureLoader` | `TextureLoader` | 0x28 |
  | `atlas`（protected 快取） | `Atlas` | 0x30 |
- `CreateRuntimeInstance(TextAsset, Texture2D[], Shader, bool, Func<...>)` @ `0x94AC7F4`：從 mod 的 atlas+png 建 runtime atlas。

### 3. `Spine.Unity.SkeletonGraphic`（UI 立繪渲染元件） — **就地換貼圖/換 asset**
- TypeDefIndex 41786。重要欄位：
  | 欄位 | 型別 | offset | 用途 |
  |------|------|--------|------|
  | `skeletonDataAsset` | `SkeletonDataAsset` | 0xD8 | **替換整個 asset** |
  | `customTextureOverride` | `Dictionary<Texture,Texture>` | 0x198 | **內建貼圖覆寫表（免重建！）** |
  | `customMaterialOverride` | `Dictionary<Texture,Material>` | 0x1A0 | 材質覆寫 |
  | `overrideTexture` | `Texture` | 0x1A8 | 單一貼圖覆寫 |
  | `skeleton` | `Skeleton` | 0x1B0 | runtime 骨架 |
- 方法 RVA：
  | 方法 | RVA |
  |------|-----|
  | `get_SkeletonData()` | 0x94BC634 |
  | `Initialize(bool overwrite)` | 0x94B16AC |
  | `Initialize(bool overwrite, bool quiet)`（override, Slot 9） | 0x94C196C |
  | `Initialize(Animator, SkeletonDataAsset)` | 0x94C20C4 |
  | `Clear()` | 0x94BB7C0 |
  | `Rebuild(CanvasUpdate)`（Slot 37） | 0x94BB8F8 |
- 替換策略 A：改 `skeletonDataAsset`(0xD8) 後呼叫 `Initialize(true)` @ 0x94B16AC 重建。
  策略 B（輕量）：往 `customTextureOverride` 塞入「原貼圖→mod 貼圖」對應，不動骨架。

### 4. `UnityEngine.AssetBundle.LoadFromFile` — **載入 mod 打包的 bundle**
- 多載 RVA：
  | 簽章 | RVA |
  |------|-----|
  | `LoadFromFile(string)` | 0x9F80FF0 |
  | `LoadFromFile(string, uint crc)` | 0x9F81050 |
  | `LoadFromFile(string, uint crc, ulong offset)` | 0x9F810BC |
- 可用 `il2cpp_runtime_invoke` 主動呼叫（不一定要 hook），把 mod 資料夾的 bundle 載進來取 asset。

---

## 與 Windows BrownDustX 的對應

| BrownDustX (Windows, 靠遊戲方法名) | 本專案 (macOS, 靠 Spine 層) |
|-------------------------------------|------------------------------|
| hook `GetIllustSpinePrefab` 換 prefab 上的 asset | hook `SkeletonDataAsset.GetSkeletonData` / 改 `SkeletonGraphic.skeletonDataAsset` |
| 換 `atlasAssets` / `spineAtlasAsset` | 改 `SkeletonDataAsset.atlasAssets`(0x18) / hook `SpineAtlasAsset.GetAtlas` |
| `ReplaceSpineData` | `InitializeWithData` / `CreateRuntimeInstance` |
| 貼圖替換 | `SkeletonGraphic.customTextureOverride`(0x198) |

→ 遊戲方法混淆不影響我們，因為替換點全在未混淆的 Spine 層。

---

## 待補 / 下一步

- [ ] 補 `SkeletonGraphic.get_SkeletonData` 與 Initialize/Rebuild 系列的 RVA（行 2543107 起，dump 內）。
- [ ] Phase 1 探測時，用 `il2cpp_class_from_name("spine-unity","SkeletonDataAsset")` 取執行時位址，
      驗證 `runtime_addr - UnityFramework.base == 0x94A9560`。
- [ ] 確認角色 ID（如 `char004102`）在哪個欄位/呼叫點可取得，作為「要不要替換」的判斷依據
      （可在 `GetSkeletonData` hook 內讀 `this->skeletonJSON.name` 或 atlas 名）。
- [ ] 每次遊戲版本更新後重跑 dump，RVA 會變。
