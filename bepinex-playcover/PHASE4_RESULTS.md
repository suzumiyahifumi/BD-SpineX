# Phase 4 — Spine 執行時替換（策略 A）進度

## 4.1 hook + 識別 ✅ 已驗證（2026-06-10）

在 loader 用 frida-gum `gum_interceptor_replace` hook `SkeletonDataAsset.GetSkeletonData`
（UnityFramework.base + 0x94A9560），call-through 原始函式，並讀 `this->skeletonJSON`(0x28) 的
Unity name 識別資產。**實機遊玩驗證：72 次觸發、資產名稱全部正確、遊戲穩定。**

實際攔截到的資產名（樣本）：
```
char061092.skel  char067803.skel  char004202.skel  char003601.skel
char060403.skel  char061001.skel  specialillust194.skel
cutscene_char067504.skel  cutscene_char004301.skel  cutscene_char000296.skel
```

### 由 4.1 得到、影響後續設計的事實
1. **資產 name 含副檔名**（`.skel`/`.json`）。比對 mod 時要**去副檔名**：
   `char003604.skel` → key `char003604` → 找掛載目錄中含 `char003604.*` 的 mod。
2. 三種型態的 key 前綴：`charNNNNNN`（standing）、`illust_datingNN`（dating）、
   `cutscene_charNNNNNN`（skillcut）— 與 `mods/` 命名一致。
3. **同一資產的 GetSkeletonData 會被呼叫多次**（每資產 4~8 次）→ 替換結果必須**快取**
   （`asset name → 已建好的替換 SkeletonData/Asset`），否則重複重建會很慢且可能 leak。
4. gum hook 在 arm64、與 il2cpp 並存穩定；call-through ABI 正確（`fn(this, bool)->ptr`）。

## 4.2–4.5 ✅ 成功（2026-06-11）— 執行時 Spine 替換運作

char003604（Olivier 立繪）在遊戲中**成功顯示 mod**，穩定、0 例外、未碰 `__data`。
loader 在 `GetSkeletonData` hook 內就地替換原始 asset 欄位，讓遊戲自身重建。

### 除錯過程記錄的關鍵事實（Phase 4 後續沿用）
1. **il2cpp_runtime_invoke 參數慣例**：參考型別（string/array/object）直接傳「物件指標」；
   值型別（bool/int/float）傳 `&value`。**Func<>/delegate 等參考型別若要傳 null，傳 null 本身**
   （不是 `&null`）——傳 `&null` 會被當成非空 delegate 而丟例外。
2. **SpineAtlasAsset.CreateRuntimeInstance 以 `texture.name` 比對 atlas page**：
   每個 `Texture2D` 必須 `set_name` 成 page 檔名（去 `.png`），否則丟
   `ArgumentException: Could not find matching atlas page in the texture array.`
3. **務必就地改寫原始 asset 欄位**（`atlasAssets`/`skeletonJSON`，並清空 `skeletonData`(0x70)），
   再讓遊戲自身 `GetSkeletonData` 重建。若改成回傳「另一個 asset 的 skeletonData」，
   原始 `this->skeletonData` 仍為 null → 後續 null deref 崩潰（EXC_BAD_ACCESS @ 0xe）。
4. 建好的物件（atlas/textures/TextAsset/陣列）以 `il2cpp_gchandle_new` pin 住防 GC。
5. 例外訊息可用 `il2cpp_format_exception` 取得，除錯極有用。

### 運作流程（成功路徑）
```
GetSkeletonData(this) hook
 → 讀 this->skeletonJSON.name 得資產名 → 去副檔名比對掛載 mod
 → 命中(首次)：讀 png→Texture2D(set_name)、atlas→TextAsset
   → SpineAtlasAsset.CreateRuntimeInstance(tex[], 複製原始material)
   → 就地寫 this.atlasAssets/skeletonJSON、清空 this.skeletonData、pin
 → 落到 orig(this) → 遊戲用我們的資料重建並快取 → 顯示 mod
```

### 尚待處理
- **二進位 `.skel`**（dating/skillcut 多數）：目前只支援文字 `.json`。需用 byte[] 建 skeletonJSON
  （TextAsset 無法用 UTF-16 string 承載二進位；可改走能吃 byte[] 的路徑或建立帶 bytes 的 TextAsset）。
- 多頁 atlas 已支援（依 atlas page 行序組 textures），待用 dating/skillcut 實測。
- 還原/熱重載、log 路徑硬編改為動態、Phase 5 GUI 串接。

## （原 4.2–4.5 規劃，已完成）

- 4.2 il2cpp 互動 helper（class/method/invoke/string/array/Texture2D/TextAsset 建構）+ GC pin。
- 4.3 掃掛載目錄 `…/Data/bd2mods/`，建 `key → mod 路徑` 表；hook 內去副檔名比對。
- 4.4 由 mod 檔建替換 asset：png→Texture2D、atlas→TextAsset→SpineAtlasAsset.CreateRuntimeInstance、
  skel/json→TextAsset→SkeletonDataAsset.CreateRuntimeInstance。多頁 png 需依 atlas page 順序組。
- 4.5 hook 回傳替換 asset 的 SkeletonData（並快取、pin 物件）。

測試 mod（已放入掛載目錄）：
- `char003604`（Olivier standing）、`illust_dating11`（Eclipse dating）、`cutscene_char066403`（Angelica skillcut）。
