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

## 4.2–4.5（待實作）

- 4.2 il2cpp 互動 helper（class/method/invoke/string/array/Texture2D/TextAsset 建構）+ GC pin。
- 4.3 掃掛載目錄 `…/Data/bd2mods/`，建 `key → mod 路徑` 表；hook 內去副檔名比對。
- 4.4 由 mod 檔建替換 asset：png→Texture2D、atlas→TextAsset→SpineAtlasAsset.CreateRuntimeInstance、
  skel/json→TextAsset→SkeletonDataAsset.CreateRuntimeInstance。多頁 png 需依 atlas page 順序組。
- 4.5 hook 回傳替換 asset 的 SkeletonData（並快取、pin 物件）。

測試 mod（已放入掛載目錄）：
- `char003604`（Olivier standing）、`illust_dating11`（Eclipse dating）、`cutscene_char066403`（Angelica skillcut）。
