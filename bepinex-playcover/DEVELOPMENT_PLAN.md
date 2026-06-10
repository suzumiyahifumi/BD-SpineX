# BepInEx-for-PlayCover — 開發規劃（修訂版）

> Branch: `bd2/BepInEx_for_playcover`
> 取代離線 `__data` Patch，改為「執行時掛載模組」。
> 本檔承接 `FEASIBILITY.md` 的判定結果與 `SPINE_RUNTIME_PROBE_RESEARCH.md` 的原始構想。

---

## 0. 名詞對照（Windows BepInEx ↔ 我們的 macOS 實作）

| Windows / BepInEx | macOS / PlayCover 等價物 |
|--------------------|---------------------------|
| Doorstop（winhttp.dll proxy 注入 runtime） | 在主程式加 `LC_LOAD_DYLIB` 指向我們的 loader dylib（同 PlayTools 手法） |
| BepInEx Preloader / Chainloader | 我們的 loader dylib：`il2cpp_thread_attach` 後初始化、載入 plugin |
| Harmony（C# method patch） | 原生 inline hook（Dobby）+ `il2cpp_*` API 解析方法位址 |
| Il2CppInterop（產生 proxy 組件） | 直接用 `il2cpp_class_from_name` / `il2cpp_runtime_invoke` 呼叫 |
| `BrownDustX.dll` plugin | 我們的 mod 邏輯（C/Rust/Swift），對應 `SpineReplacer` |
| `plugins/BrownDustX/mods/` | `~/Library/Containers/io.playcover.PlayCover/.../mods/`（sandbox 內） |

---

## Phase 1 — Runtime Probe ✅ 已完成（2026-06-10）

目標：在活著的遊戲程序裡確認模組、IL2CPP、Spine runtime 真的存在且可觀察。
**結果見 `PHASE1_RESULTS.md`；注入流程見 `INJECTION.md`。**

- [x] 工具：`.venv-tools` 裝 frida-tools 17.11.0。
- [x] attach：採 **frida-gadget 注入**（`LC_LOAD_DYLIB` + adhoc 重簽，listen 127.0.0.1:27042）。
- [x] `bd2_resolve_check.js`：解析 `SkeletonDataAsset`/`SpineAtlasAsset`/`SkeletonGraphic`，
      **執行時位址 == base + dumpRVA（match=true）**。
- [x] `bd2_hook_observe.js`：成功 attach `GetSkeletonData`（Interceptor 可掛）。

**全部成功條件達成**：注入鏈、il2cpp 解析、RVA 對應、攔截能力皆驗證。
（`bd2_file_probe.js` 為輔助觀察用，非阻塞。）

**關鍵結論**：UnityFramework base=0x300000000，靜態 dump 的 RVA 可**直接**用於 inline hook
（runtime addr = base + RVA），版本更新後只需重 dump。

---

## Phase 2 — IL2CPP Metadata 分析 ✅ 已完成（2026-06-10）

目標：拿到精確的類別/方法簽章，作為 hook 的依據。

- [x] 用 `Il2CppDumper` v6.7.46（輸入 `UnityFramework` + `global-metadata.dat`）產生 `dump.cs`/`script.json`。
      Metadata/Il2Cpp Version 31，dump 在 `dump/`（git ignored）。
- [x] 定位並記錄關鍵方法 RVA → 見 **`IL2CPP_TARGETS.md`**。
- [x] **重要轉折**：遊戲自身方法名**被混淆**（unicode），`Get*SpinePrefab` 僅以 enum 欄位名保留，
      **無法靠遊戲方法名 hook**。但 **Spine 函式庫類別（spine-unity）未混淆**，
      所以改 hook Spine 層（`SkeletonDataAsset.GetSkeletonData` 等），反而對應到原規劃的優先級 #1/#2/#4/#5/#6。
- [x] 已定位欄位偏移供直接改寫：`SkeletonDataAsset.atlasAssets/skeletonJSON/skeletonData`、
      `SkeletonGraphic.skeletonDataAsset/customTextureOverride`、`SpineAtlasAsset.atlasFile/materials/atlas`。

**RVA 重產方式**（版本更新後）：
```bash
DOTNET_ROLL_FORWARD=LatestMajor ~/.dotnet/dotnet \
  bepinex-playcover/tools/Il2CppDumper/Il2CppDumper.dll \
  "<UnityFramework>" "<global-metadata.dat>" bepinex-playcover/dump
```

---

## Phase 3 — 注入管線（Loader = Doorstop 等價物）

目標：做出能穩定注入並初始化的 loader dylib，先不替換資源，只證明「我們的程式碼在遊戲裡跑起來」。

- [ ] 建 `loader/`（建議 Rust `cdylib` 或 C；Swift 亦可但與 il2cpp C API 互動 Rust/C 較直接）。
- [ ] loader 入口（`__attribute__((constructor))` / dylib load）：
      等 `il2cpp_init` 完成 → `il2cpp_thread_attach(il2cpp_domain_get())` → 啟動背景 log。
- [ ] 注入器 `injector/`：對 app 主程式加 `LC_LOAD_DYLIB` 指向 loader、adhoc 重簽
      （參考 PlayTools 注入；`install_name_tool -add_load_command` 或自寫 Mach-O patcher + `codesign -f -s -`）。
- [ ] 驗證：啟動遊戲，loader 印出「hello from inside BrownDust II」與 il2cpp 版本。

**成功條件**：不靠 Frida，純自製 dylib 在遊戲程序內主動呼叫到 il2cpp API。

---

## Phase 4 — Spine 執行時替換（核心功能）

目標：重現 Windows `SpineReplacer` 行為。

- [ ] 用 Dobby inline-hook Phase 2 定位到的 `Get*SpinePrefab`。
- [ ] 在 hook 內判斷角色 ID（例 `char004102`）是否有對應 mod。
- [ ] 有 mod → 從 sandbox 內 mod 資料夾載入替換資源：
      - 路線 A：`AssetBundle.LoadFromFile` 載入我們預打包的 bundle，取出 `SkeletonDataAsset` 替換。
      - 路線 B：直接建構 `SkeletonData` / 替換 atlas 紋理（較複雜，後評估）。
- [ ] 替換 prefab 上的 `skeletonDataAsset` 與 `atlasAssets` 欄位後回傳。
- [ ] 加入 mod 資料夾監看（對應 BrownDustX 的 `WatchModsDirectory`）做熱重載。

**成功條件**：遊戲執行中切換角色即見替換，且不曾改動 `Shared/__data`。

---

## Phase 5 — 整合進 BD-SpineX（GUI）

- [ ] Electron app 新增「Runtime 模式」：負責安裝/移除注入、管理 sandbox 內 mod 資料夾、開關個別 mod。
- [ ] 保留現有離線 Patch 模式作為 fallback（遊戲更新初期、注入失效時）。
- [ ] 處理 app 更新後自動重新注入與重簽。
- [ ] 版本對應：注入需綁定遊戲版本（metadata 位址會隨版本變動）。

---

## 風險與待解未知

- `Get*SpinePrefab` 回傳物件的實際欄位結構（Phase 2 dump 後確認）。
- IL2CPP 方法位址隨遊戲版本改變 → 需要每版重新 dump，或做 signature scan 自動定位。
- 重簽與注入在每次遊戲更新後失效 → 需自動化。
- frida-gadget / 自製 loader 與 PlayTools 共存是否衝突（Phase 1/3 驗證）。
- 反作弊：目前未見明顯保護（adhoc、無 hardened runtime），但仍以「僅本機、不上線對戰」為前提。

---

## 進度與立即下一步

**已完成（2026-06-10）**
- [x] 工具環境：`bepinex-playcover/.venv-tools`（python3.13）裝好 frida-tools 17.11.0；
      `~/.dotnet` 裝好 .NET 8 runtime；`tools/Il2CppDumper` 就緒。
- [x] Phase 2 靜態 dump 完成，`IL2CPP_TARGETS.md` 產出。

**下一步（依序）**
1. **Phase 1 live probe**（需遊戲執行中 + 解決 attach）：
   - attach 需重簽 app 加 `get-task-allow`，**會修改你已安裝的遊戲簽章**——執行前先確認。
   - 或改用 frida-gadget 注入（與最終管線一致）。
   - 跑 `bd2_il2cpp_probe.js` 驗證 `SkeletonDataAsset` 執行時位址 == `base + 0x94A9560`。
2. **Phase 3 loader 雛形**：可在 Phase 1 驗證後或平行開始（Rust cdylib，先只 log）。

> 註：Phase 2 已先行完成（靜態、不碰遊戲）；Phase 1 因需動到遊戲簽章而暫緩，待你確認。
