# 版本綁定技術細節與更新行為

> 對象：`bd2/BepInEx_for_playcover` 的執行時掛載（runtime）模式。
> 目前綁定：**BrownDust II 2.27.19**（iOS/PlayCover build，IL2CPP Metadata/Il2Cpp Version 31）。

---

## 1. 為什麼 loader 綁定遊戲版本

loader 不是用「方法名稱」找遊戲函式（遊戲自身方法名被混淆），而是用
**`執行時位址 = UnityFramework 載入基底(base) + 靜態 RVA`** 直接定位並 hook。

- `RVA` 來自對「**特定版本**的 `UnityFramework` + `global-metadata.dat`」做 Il2CppDumper 得到的位址。
- 不同遊戲版本重新編譯後，這些 RVA **幾乎必定改變**。
- 因此 loader 與「某一個遊戲版本」一對一綁定；用在別的版本上，hook 會打到錯誤位址 → 無效或崩潰。

> 註：`base` 每次啟動因 ASLR 而不同，但 loader 在執行時動態取得 base（`_dyld_get_image_header`），
> 真正寫死、且綁版本的是 **RVA 與欄位 offset**。

---

## 2. 版本綁定的具體項目（2.27.19）

全部集中在 `bepinex-playcover/loader/src/lib.rs` 頂部常數：

### Hook / 呼叫目標 RVA（`Spine.Unity` / `Spine`，spine-unity / spine-csharp）
| 常數 | RVA | 方法 |
|------|-----|------|
| `RVA_GET_SKELETON_DATA` | `0x94A9560` | `SkeletonDataAsset.GetSkeletonData(bool)`（hook 目標） |
| `RVA_SPINEATLAS_CREATE_TEX_MAT` | `0x94AC378` | `SpineAtlasAsset.CreateRuntimeInstance(TextAsset, Texture2D[], Material, bool, Func)` |
| `RVA_SKELDATA_CREATE_ARR` | `0x94AB660` | `SkeletonDataAsset.CreateRuntimeInstance(TextAsset, AtlasAssetBase[], bool, float)`（目前未用） |
| `RVA_SKELDATA_READ_BYTES` | `0x94AB960` | `SkeletonDataAsset.ReadSkeletonData(byte[], AttachmentLoader, float)`（binary） |

### `SkeletonDataAsset` 欄位 offset
| 常數 | offset | 欄位 |
|------|--------|------|
| `OFF_ATLAS_ASSETS` | `0x18` | `AtlasAssetBase[] atlasAssets` |
| `OFF_SCALE` | `0x20` | `float scale` |
| `OFF_SKELETON_JSON` | `0x28` | `TextAsset skeletonJSON` |
| `OFF_BLEND_MODE_MATERIALS` | `0x38` | `BlendModeMaterials blendModeMaterials` |
| `OFF_SKELETON_DATA_MODIFIERS` | `0x40` | `List<SkeletonDataModifierAsset> skeletonDataModifiers` |
| `OFF_SKELETON_DATA` | `0x70` | `SkeletonData skeletonData`（快取） |

其他非綁版本（穩定）：`il2cpp_*` C API 以名稱動態解析（`dlopen(UnityFramework, RTLD_NOLOAD)` + `dlsym`）、
`il2cpp array 資料起點 0x20`、`ExposedList.Count @ 0x18`、`List._items@0x10 / _size@0x18`（IL2CPP ABI 慣例，跨版本穩定）。

> 名稱解析的類別/方法（如 `UnityEngine.Object.get_name`、`AtlasAttachmentLoader.ctor`）用
> `il2cpp_class_from_name` + `class_get_method_from_name`，不綁 RVA；只有「多載需精準定位」者才用 RVA。

---

## 3. 遊戲更新時的行為

PlayCover 更新遊戲時會**替換 app bundle**（`…/Applications/…app/`，含主程式與 Frameworks），
但**不動遊戲的 Data 容器**（存檔資料）。

| 項目 | 位置 | 更新後 |
|------|------|--------|
| 已掛載的 mod | `~/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2mods/` | ✅ 保留（在 Data 容器內） |
| 注入（`LC_LOAD_DYLIB` + loader dylib + 重簽） | app bundle 內 | ❌ 消失，需重新注入 |
| 備份（`*.BAK-mainbin/`） | Applications 下、app 的同層 | 可能殘留但**對新版而言已過期** |

### 兩種更新情境
- **同版本重裝**（重新下載同一版）：RVA 仍正確 → 在設定區「安裝注入」即可，mod 照常生效。
- **升級到新版本**：RVA 失效 → **需要對應新版的 BD-SpineX**（重新 dump、更新常數、bump 版本）。
  版本鎖定會在版本不符時鎖定操作、提示更新。

---

## 4. 版本鎖定機制（version lock）

- 管理器「支援版本」= `app.getVersion()`（`package.json` 的 `version`，目前 `2.27.19`）。
- 遊戲版本由 `detectGameVersion()` 從 PlayCover app bundle 的 `Info.plist`（`CFBundleShortVersionString`）偵測。
- UI（`App.tsx` 的 `isGameVersionMismatch`）：兩者正規化後不同 → `versionLocked`：
  - Mods 表格鎖定（`modsLockOverlay` 顯示 “Update BD-SpineX version”）。
  - Apply Changes 禁用。
- `development` 模式（未打包）不鎖，方便開發。

---

## 5. 升級支援新遊戲版本的步驟（SOP）

當 BrownDust II 出新版時：

1. **重新 dump**（離線、不需啟動遊戲）：
   ```bash
   DOTNET_ROLL_FORWARD=LatestMajor ~/.dotnet/dotnet \
     bepinex-playcover/tools/Il2CppDumper/Il2CppDumper.dll \
     "<新版 UnityFramework>" "<新版 global-metadata.dat>" bepinex-playcover/dump
   ```
2. **重新取得 RVA**：用 `bepinex-playcover/tools/disasm.py` + `dump/script.json` 找出
   §2 各方法的新 RVA；欄位 offset 從 `dump/dump.cs` 的 `SkeletonDataAsset` 取得。
   （若有多載，用 `method_by_rva`，RVA 必須對；可在 live 用 `probes/bd2_resolve_check.js` 交叉驗證 `base+RVA`。）
3. **更新常數**：改 `loader/src/lib.rs` 頂部的 `RVA_*` / `OFF_*`。
4. **重編 loader**：`cd loader && cargo build --release --target aarch64-apple-darwin`。
5. **bump 版本**：把 `package.json` 的 `version` 改成新遊戲版本（解除版本鎖定）。
6. **實測**：注入 → 進角色畫面驗證替換、連續觸發、約會（含 skel→json）皆正常。

---

## 6. 近期改動細節（runtime 模式整合）

依序（最新在上）：

### 注入改為使用者控制（設定區）
- 設定區新增「Runtime 注入 (BepInEx)」：顯示已注入/未注入 + 安裝/移除按鈕。
- **Apply Changes 不再自動注入**（純掛載/卸載）；若掛載了但未注入，log 提醒到設定區開啟。
- 動機：讓使用者明確掌控注入與否。

### 注入「更新安全」修正（`core/runtime-loader.ts`）
- 問題：原本有舊備份時，`installLoader` 會用**舊版備份覆蓋新主程式**（等於降級）。
- 修正：偵測主程式是否已注入——
  - **未注入**（全新/更新後）→ 用**現在的新主程式**刷新備份與 entitlements，再注入。
  - **已注入** → 從（同版本）備份取乾淨基底再重做。
- `uninstallLoader` 只在「目前已注入」時還原，避免用舊備份覆蓋全新主程式。

### 同 key 衝突規則（`App.tsx`）
- 勾選 A（key K）且已掛載 B 也是 K → B 自動加入移除、標 **`(auto)`**（粉色），Apply 時先卸 B 再掛 A。
- 同時勾選**多個未掛載、相同 key** → 全部標 **紫色**衝突，**Apply 禁用**，需只留一個。

### UI 復刻舊版 + 核心替換
- App.tsx 重寫為 runtime 引擎，但沿用舊離線 Patch 版的 UI/UX：勾選 → Apply Changes → log → 鎖定、
  Mods 表格（colgroup/排序/分類色/狀態徽章/批次全選/鎖定遮罩）、Pending Changes 面板、版本徽章。
- 設定只留 **Mods Folder**（移除 Shared Folder 與離線 patch 設定）；舊離線 patch 核心保留在 repo 但 UI 不再使用。

### 掛載：hardlink + 自動 skel→json
- 掛載檔案優先 **hardlink**（同 volume 不複製），跨 volume 退回複製。
- mod 若只有二進位 `.skel` → 掛載時用 `SpineSkeletonDataConverter` 自動轉 `.json`，
  讓 loader 走穩定的 json 路線（繞過 binary 渲染問題）。

### Node Mach-O 注入器（`core/macho-inject.ts`）
- 純 Node 實作 `LC_LOAD_DYLIB` 插入（免 python/lief），供 packaged app 使用；加 padding 空間檢查。
