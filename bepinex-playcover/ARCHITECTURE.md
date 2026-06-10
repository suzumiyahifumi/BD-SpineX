# Runtime Patch 技術架構（執行時 Spine 模組掛載）

> 本文說明 `bd2/BepInEx_for_playcover` 的**執行時掛載**機制的完整技術細節——
> 從注入、loader、hook、到 Spine 資源替換的端到端流程。
> 版本綁定的常數與更新流程見 [`VERSIONING.md`](VERSIONING.md)；
> 各 IL2CPP 方法位址見 [`IL2CPP_TARGETS.md`](IL2CPP_TARGETS.md)。

---

## 0. 與舊機制的差異

| | 舊：離線 `__data` Patch | 新：執行時掛載（本文） |
|---|---|---|
| 手法 | 用 UnityPy/UABEA 改寫 `Shared/**/__data` bundle | 注入 dylib，遊戲執行中 hook Spine 載入、動態替換 |
| 修改遊戲檔 | 是（改 `__data`，需備份/還原） | 否（不動 `Shared`；只在主程式加一條 load command） |
| 套用時機 | Patch 後重啟 | 啟動時注入、進角色畫面即套用 |
| mod 存放 | patch 進 bundle | 複製/hardlink 到遊戲 Data 容器 `bd2mods/` |

對應 Windows 的 **BepInEx + Harmony**；本專案用 **注入 dylib + frida-gum + il2cpp C API** 達到等價效果。

---

## 1. 全貌（資料流）

```
BD-SpineX (Electron)
  └─ 安裝注入: 主程式加 LC_LOAD_DYLIB → libbd2loader.dylib + adhoc 重簽（保留 entitlements）
  └─ 掛載 mod: 複製/hardlink 到 ~/Library/Containers/<game>/Data/bd2mods/（.skel 自動轉 .json）

遊戲啟動 (PlayCover)
  └─ dyld 載入 libbd2loader.dylib → __mod_init_func 觸發 constructor
       └─ 開背景執行緒（先 sleep 5s 讓 dyld 初始化完成）
            └─ 等 il2cpp 就緒 → dlopen(UnityFramework, RTLD_NOLOAD) 取 il2cpp C API
                 └─ frida-gum 安裝 hook: SkeletonDataAsset.GetSkeletonData @ base+RVA
                 └─ 掃 bd2mods/ 建 key→mod 路徑表

遊戲載入角色 Spine
  └─ 呼叫 GetSkeletonData(this)  ← 我們的 hook 攔截
       └─ 讀 this.skeletonJSON.name → 去副檔名得 key（char003604 / illust_dating11 / cutscene_charXXXXXX）
       └─ 比對掛載表；命中且此實例尚未替換 → build_objects() 建替換、apply_to_instance() 就地改欄位
       └─ 呼叫原始 GetSkeletonData → 回傳我們的 SkeletonData → 畫面顯示 mod
```

---

## 2. 注入層（= BepInEx Doorstop 等價物）

PlayCover 本身已用 `LC_LOAD_DYLIB` 把 `PlayTools.framework` 載入主程式。我們用相同手法。

可行的原因（靜態分析確認）：
- 主程式與 `UnityFramework` 皆 **arm64、IL2CPP、`cryptid=0`（已解密）**。
- 主程式為 **adhoc 簽章、無 hardened runtime** → **library validation 沒開** → 可載入自簽 dylib。

`installLoader()`（`core/runtime-loader.ts`）流程：
1. 判斷主程式是否已注入（`hasLoadDylib`）；未注入＝乾淨基底（全新或遊戲更新後）→ 用它刷新備份 + 擷取 entitlements。
2. 複製 `libbd2loader.dylib` 進 `Frameworks/`，`install_name_tool -id @executable_path/Frameworks/libbd2loader.dylib`，adhoc 簽。
3. `core/macho-inject.ts` 在 load commands 後的 padding 內插入一條 `LC_LOAD_DYLIB`（純 Node，免 python/lief），更新 `ncmds`/`sizeofcmds`。
4. `codesign -f -s - --entitlements <ent>` 重簽主程式（**entitlements 必須保留**，裡面有 sandbox 例外）。

> Mach-O 注入細節：dylib_command 24 bytes header + name（8-byte 對齊），插在 `32 + sizeofcmds` 處，
> 需確保 `< 第一個 section 的 file offset`（padding 足夠）。

---

## 3. Loader（`bepinex-playcover/loader/`，Rust cdylib，零外部 crate）

### 進入點
- `#[link_section = "__DATA,__mod_init_func"]` 註冊 constructor（等同 `__attribute__((constructor))`）。
- **constructor 內不可碰 dyld API**（dlsym/dlopen/_dyld_*）：dyld 初始化期間主執行緒持有 dyld lock，
  在此搶 lock 會卡死啟動。constructor 只開執行緒；執行緒先 `sleep(5s)` 等 app 進主迴圈再動作。

### 解析 il2cpp
- 遊戲以 **RTLD_LOCAL** 載入 `UnityFramework`，其 `il2cpp_*` 導出不在全域命名空間 →
  `dlsym(RTLD_DEFAULT, …)` 找不到。必須 `dlopen(UnityFramework 路徑, RTLD_NOLOAD)` 取 handle，再對 handle `dlsym`。
- 取 `il2cpp_domain_get`→`il2cpp_thread_attach`；以 `_dyld_get_image_header` 取 UnityFramework base。

### hook 引擎：frida-gum（靜態庫）
- 用 `gum_interceptor_replace(target, replacement, &original, NULL)` 取代函式並保留原始指標。
- target = `base + RVA_GET_SKELETON_DATA`。比 inline-hook listener 簡單、ABI 乾淨。
- gum 只做 hook、不開 server，與遊戲共存穩定（不像 frida-gadget 會衝突）。

---

## 4. Hook 與識別

`repl_get_skeleton_data(this, quiet)`：
1. 讀 `this->skeletonJSON`(`OFF_SKELETON_JSON=0x28`)，用 `il2cpp_runtime_invoke(UnityEngine.Object.get_name)` 取資產 name。
2. `asset_key()` 去掉 `.skel`/`.json` 副檔名 → key。
3. 在掛載表（啟動時掃 `bd2mods/` 建立，key=.atlas stem）比對。
4. 命中且**此實例尚未替換**（見 §6 快取）→ 建替換 + 就地改欄位。
5. 一律呼叫**原始** `GetSkeletonData`（保留的 original 指標）回傳結果。

---

## 5. Spine 替換（策略 A：換整個 SkeletonDataAsset）

替換在 hook 內、**主執行緒**（GetSkeletonData 被遊戲在主執行緒呼叫）執行，因此可安全建 Unity 物件。

### 建物件（`build_objects`）
1. 讀 mod 的 `.atlas` 文字、各頁 `.png`、`.json`（或 `.skel`）。
2. 每頁 png → `Texture2D`：`new Texture2D(2,2)` → `ImageConversion.LoadImage(tex, byte[])` →
   **`Object.set_name(tex, page 去副檔名)`**（`SpineAtlasAsset` 以 `texture.name` 比對 atlas page，必須相符）。
3. atlas 文字 → `TextAsset` → `SpineAtlasAsset.CreateRuntimeInstance(TextAsset, Texture2D[], 原始material, true, null)`
   （複製原始 atlas 的 `PrimaryMaterial` 取得正確 shader）。
4. 骨架分兩路：
   - **json**：建 `TextAsset(json)`，最後設 `skeletonJSON`、清空 `skeletonData` → 讓**遊戲自身** GetSkeletonData 完整重建。
   - **skel（二進位）**：`TextAsset` 無法承載二進位 → 自行 `SpineAtlasAsset.GetAtlas` → `AtlasAttachmentLoader(Atlas[])`
     → `SkeletonDataAsset.ReadSkeletonData(byte[], loader, scale)` 建 `SkeletonData`，再**手動補後處理**
     （`skeletonDataModifiers.Apply` → `BlendModeMaterials.ApplyMaterials` → `FillStateData`），最後設 `skeletonData`。

   > 註：GUI 掛載時已把 `.skel` 自動轉 `.json`，所以實務上幾乎都走較穩的 json 路線；skel 路線為備援。

### 套用（`apply_to_instance`）— 就地改欄位
- json：寫 `atlasAssets`、`skeletonJSON`、清空 `skeletonData(0x70)`；原始 GetSkeletonData 早退條件是
  `skeletonData != null`，清空後它會用我們的 `skeletonJSON`+`atlasAssets` 重建（含完整後處理），回傳一致。
- skel：寫 `atlasAssets`、`skeletonData`（已建好）、`FillStateData`；原始 GetSkeletonData 因 `skeletonData!=null` 直接回傳它。
- **為何就地改而非回傳另一個 asset 的 SkeletonData**：若只回傳、不寫 `this->skeletonData`，遊戲後續存取
  `this.skeletonData` 會是 null → null deref 崩潰（實測 `EXC_BAD_ACCESS @ 0xe`）。

### GC
- 建好的物件用 `il2cpp_gchandle_new(obj, 0)` pin 住，避免 Boehm GC 回收。

---

## 6. 多實例與衝突（重要）

- 遊戲重載同角色時會用**新的 SkeletonDataAsset 實例**。
- **不可跨實例共用**建好的 atlas/skeletonData：遊戲 `Clear/Dispose` 第一個實例時會連帶釋放共用 atlas，
  導致其他實例 spine 消失。→ **每個實例各自建一份**。
- 以「我們建過的 `skel_ta`/`skel_data` 指標集合」判斷某實例是否已替換（`skeletonJSON`/`skeletonData` 在集合內）→
  避免每次呼叫重建；新實例（或被 Clear）則重建。
- 失敗的 key 記錄在 `FAILED_KEYS` 不再重試。

---

## 7. 掛載層（`core/runtime-loader.ts`）

- 掛載目錄：`~/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2mods/`
  （遊戲自己的 Data 容器，sandbox 必可讀；遊戲更新會保留）。
- `mountMod`：逐檔 **hardlink 優先**（同 volume 不複製資料），跨 volume 退回複製。
- **skel→json 自動轉換**：mod 只有 `.skel` 時，用 `manager-data/tools/SpineSkeletonDataConverter <skel> <json>`
  產生 `.json`（工具支援雙向、自動偵測版本），loader 走穩定 json 路線、繞過 binary 渲染問題。
- sandbox 限制：**symlink 不可**（核心解析 target 到沙盒外被拒）；hardlink 可（同 volume、僅檔案）。

---

## 8. GUI（`app/renderer/src/App.tsx`）

沿用舊離線 Patch 版的 UI/UX，核心改為 runtime：
- 設定：**Mods Folder** + **Runtime 注入**（安裝/移除 + 狀態），版本鎖定保留。
- Mods 表格：colgroup、四欄排序、分類色塊（char/dating/cutscene）、狀態徽章、批次全選、鎖定遮罩。
- **Pending Changes**：勾選即時計算掛載/卸載差異；
  - 同 key 已掛載者勾選新的 → 舊的自動加入移除、標 **`(auto)`**（先卸後掛）。
  - 同時勾選多個未掛載、相同 key → **紫色衝突**、**Apply 禁用**。
- Apply Changes：套用差異（不自動注入，注入由設定控制）；啟動遊戲；全部還原。

---

## 9. 關鍵踩雷彙整（IL2CPP 互動）

1. **`il2cpp_runtime_invoke` 參數慣例**：參考型別傳「物件指標本身」，值型別傳 `&value`；
   delegate/Func 要傳 null 本身（不是 `&null`，否則被當非空 delegate 而丟例外）。
2. **多載定位**：同名同 argc 的多載（如兩個 `CreateRuntimeInstance`）用「methodPointer == base+RVA」精準找 MethodInfo。
3. **`SpineAtlasAsset.CreateRuntimeInstance` 以 `texture.name` 比對 atlas page** → Texture2D 必須 set_name。
4. **就地改欄位**、勿只回傳（否則 `this.skeletonData` 為 null → 崩潰）。
5. **dyld 初始化期不可碰 dyld API**（thread 先 sleep）。
6. **RTLD_LOCAL** → 用 `dlopen(RTLD_NOLOAD)` 解析 il2cpp。
7. **每實例各自建**（共用會被 Clear/Dispose 連帶釋放）。
8. **gum 而非 frida-gadget**（gadget 與自製 loader 同時注入會衝突）。
9. `il2cpp_format_exception` 取受控例外訊息，除錯利器。

---

## 10. 元件對照表

| 元件 | 路徑 | 角色 |
|------|------|------|
| Loader | `bepinex-playcover/loader/src/lib.rs` | 注入後在遊戲內 hook + 替換 |
| Mach-O 注入器 | `core/macho-inject.ts` | 加 `LC_LOAD_DYLIB`（Node） |
| Runtime 管理 | `core/runtime-loader.ts` | 注入/還原、掛載/卸載、啟動、狀態 |
| GUI | `app/renderer/src/App.tsx` | 勾選/Apply/Pending/注入控制 |
| IPC | `app/main/index.ts` + `app/preload/index.cts` | `runtime:*` 橋接 |
| 探測腳本 | `bepinex-playcover/probes/` | frida 驗證（開發用） |
| IL2CPP dump | `bepinex-playcover/tools/Il2CppDumper` | 取 RVA（開發用） |

---

## 11. 開發階段紀錄（對應文件）

- 可行性：[`FEASIBILITY.md`](FEASIBILITY.md)
- Phase 1 探測：[`PHASE1_RESULTS.md`](PHASE1_RESULTS.md)
- Phase 2 dump / 目標位址：[`IL2CPP_TARGETS.md`](IL2CPP_TARGETS.md)
- Phase 3 loader：[`PHASE3_RESULTS.md`](PHASE3_RESULTS.md)
- Phase 4 替換：[`PHASE4_RESULTS.md`](PHASE4_RESULTS.md)
- Phase 5 GUI：[`PHASE5_PLAN.md`](PHASE5_PLAN.md)
- 版本綁定/更新：[`VERSIONING.md`](VERSIONING.md)
- 注入流程（探測期 gadget）：[`INJECTION.md`](INJECTION.md)
