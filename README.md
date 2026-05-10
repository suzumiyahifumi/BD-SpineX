請幫我建立一個 macOS 可運行的《Brown Dust 2 / PlayCover》Spine 模組管理器專案。

目標是自動化以下手動流程：

1. 掃描 PlayCover 遊戲 cache 的 `Shared/**/__data`
2. 找出每個 `__data` 裡有哪些 Unity AssetBundle 資源
3. 建立「模組名稱 → 對應 __data 位置」索引
4. 掃描 mods 資料夾內的大量 Spine 模組
5. 每個模組格式為：
   - `char004102.json`
   - `char004102.atlas`
   - `char004102.png`
6. 使用 `SpineSkeletonDataConverter` 將 `.json` 轉成 `.skel`
7. 不依賴 UABEA GUI，而是用 Python + UnityPy 實作以下功能：
   - 替換 TextAsset 裡的 `.atlas`
   - 替換 TextAsset 裡的 `.skel`
   - 替換 Texture2D 裡的 `.png`
8. 管理 `__data` 的原檔與修改檔
9. 提供 GUI，可以掃描、套用模組、還原原檔

請使用以下技術：

- Electron
- TypeScript
- Vue 3 或 React，請選一個你認為較適合的
- Node.js
- Python 輔助腳本
- UnityPy
- Pillow
- SpineSkeletonDataConverter CLI

專案需要能在 macOS 上運行。

---

## 專案架構

請建立類似以下架構：

```text
BD2ModManager/
├── package.json
├── README.md
├── app/
│   ├── main/
│   ├── preload/
│   └── renderer/
├── core/
│   ├── shared-indexer.ts
│   ├── mod-indexer.ts
│   ├── patch-plan.ts
│   ├── backup-manager.ts
│   ├── spine-converter.ts
│   └── asset-patcher.ts
├── python/
│   ├── patch_bundle.py
│   └── requirements.txt
├── manager-data/
│   ├── shared-index.json
│   ├── mods-index.json
│   ├── patch-history.json
│   └── backups/
└── mods/


--

功能 1：Shared 掃描與索引

請實作 core/shared-indexer.ts。

功能：

遞迴掃描指定的 Shared 資料夾
找到所有 __data
讀取 Unity AssetBundle
建立索引檔：
{
  "bundles": [
    {
      "bundleId": "00044c1c0b4b673e127e271e219f70b2/3dcf985e24fdc96ab662cc29a6591835",
      "dataPath": "/path/to/Shared/.../.../__data",
      "infoPath": "/path/to/Shared/.../.../__info",
      "assets": [
        {
          "name": "char004102.atlas",
          "type": "TextAsset",
          "pathId": 123456
        },
        {
          "name": "char004102.skel",
          "type": "TextAsset",
          "pathId": 123457
        },
        {
          "name": "char004102",
          "type": "Texture2D",
          "pathId": 123458,
          "width": 2048,
          "height": 2048
        }
      ]
    }
  ]
}

如果 Node.js 端不方便直接解析 AssetBundle，請讓 shared-indexer.ts 呼叫 Python 腳本產生索引。

功能 2：Mods 掃描

請實作 core/mod-indexer.ts。

掃描 mods 資料夾，支援：

mods/
├── Tyr_Innocent_Bunny_standing_yuk11sh1d4_v1/
│   ├── char004102.json
│   ├── char004102.atlas
│   └── char004102.png
├── char004103/
│   ├── char004103.json
│   ├── char004103.atlas
│   └── char004103.png

輸出：

{
  "mods": [
    {
	  "modName": "Tyr_Innocent_Bunny_standing_yuk11sh1d4_v1"
      "name": "char004102",
      "dir": "/path/to/mods/Tyr_Innocent_Bunny_standing_yuk11sh1d4_v1",
      "jsonPath": "/path/to/char004102.json",
      "atlasPath": "/path/to/char004102.atlas",
      "pngPath": "/path/to/char004102.png",
      "status": "ready"
    }
  ]
}
功能 3：Patch Plan

請實作 core/patch-plan.ts。

功能：

根據 shared-index 與 mods-index 產生替換計畫
判斷每個 mod 是否找到對應 bundle
判斷是否找到：
atlas TextAsset
skel TextAsset
Texture2D
輸出：
{
  "plans": [
    {
      "modName": "char004102",
      "bundlePath": "/path/to/__data",
      "status": "ready",
      "targets": {
        "atlas": {
          "assetName": "char004102.atlas",
          "type": "TextAsset",
          "pathId": 123456
        },
        "skel": {
          "assetName": "char004102.skel",
          "type": "TextAsset",
          "pathId": 123457
        },
        "texture": {
          "assetName": "char004102",
          "type": "Texture2D",
          "pathId": 123458
        }
      }
    }
  ]
}
功能 4：備份與切換

請實作 core/backup-manager.ts。

規則：

第一次套用模組前，將原本 __data 備份成：
manager-data/backups/<bundleId>/__data.original
每次修改時從 __data.original 開始產生修改版，不要在已修改檔案上重複疊加修改
修改後輸出：
manager-data/backups/<bundleId>/__data.modded
套用時把 __data.modded 複製回原本的 __data
還原時把 __data.original 複製回原本的 __data

需要提供：

backupOriginal(bundlePath: string, bundleId: string): Promise<void>
applyModded(bundlePath: string, bundleId: string): Promise<void>
restoreOriginal(bundlePath: string, bundleId: string): Promise<void>
hasBackup(bundleId: string): Promise<boolean>
功能 5：Spine 轉換

請實作 core/spine-converter.ts。

不要使用 Spine 官方 Editor。

請呼叫 SpineSkeletonDataConverter CLI。

輸入：

char004102.json

輸出：

manager-data/converted/char004102/char004102.skel

需要提供：

convertJsonToSkel(jsonPath: string, outputDir: string): Promise<string>

請把 converter 路徑做成 GUI 設定。

功能 6：AssetBundle patcher

請實作 python/patch_bundle.py。

用 Python + UnityPy + Pillow 實作。

功能：

python patch_bundle.py \
  --input /path/to/__data.original \
  --output /path/to/__data.modded \
  --mod-name char004102 \
  --atlas /path/to/char004102.atlas \
  --skel /path/to/char004102.skel \
  --png /path/to/char004102.png

需要做：

找到 TextAsset 名稱包含 char004102 且像 atlas 的資源，替換為 .atlas
找到 TextAsset 名稱包含 char004102 且像 skel 的資源，替換為 .skel
找到 Texture2D 名稱包含 char004102 的資源，替換為 .png
儲存為新的 __data.modded
不要覆蓋 input
回傳 JSON 結果，例如：
{
  "ok": true,
  "changed": [
    {
      "type": "TextAsset",
      "name": "char004102.atlas",
      "action": "replace_atlas"
    },
    {
      "type": "TextAsset",
      "name": "char004102.skel",
      "action": "replace_skel"
    },
    {
      "type": "Texture2D",
      "name": "char004102",
      "action": "replace_texture"
    }
  ]
}
功能 7：Electron GUI

請建立 GUI。

畫面需要包含：

設定區
Shared 資料夾選擇
Mods 資料夾選擇
SpineSkeletonDataConverter 執行檔路徑
Python 路徑
UnityPy 安裝狀態檢查
掃描區

按鈕：

掃描 Shared
掃描 Mods
產生 Patch Plan

列表顯示：

模組名稱	Bundle	atlas	skel	png	狀態
操作區

按鈕：

Dry Run
套用選取模組
套用全部 ready 模組
還原選取模組
還原全部
Log 區

顯示：

掃描進度
轉換進度
替換結果
錯誤訊息
功能 8：安全機制

請務必加入：

套用前自動備份原始 __data
所有 patch 從 original backup 開始
支援一鍵還原
Patch 前先驗證：
.json 存在
.atlas 存在
.png 存在
.skel 可成功轉出
目標 bundle 存在
如果找不到對應資源，不要修改檔案
如果多個 bundle 都命中同一 mod，GUI 要顯示衝突，讓使用者選擇
README 需求

請建立 README，內容包含：

專案用途
macOS 安裝方式
Node.js 安裝
Python venv 建立
pip install -r python/requirements.txt
SpineSkeletonDataConverter 設定
開發啟動方式
打包方式
Shared 路徑設定方式
Mods 資料夾格式
一鍵還原說明
開發順序

請照這個順序完成：

建立 Electron + TypeScript 專案
建立 GUI 基礎畫面
完成 mods 掃描
完成 Shared 掃描
完成 patch plan
完成 backup manager
完成 SpineSkeletonDataConverter 呼叫
完成 Python UnityPy patcher
串接 GUI 操作
補 README

請先完成 MVP，不要一開始做太複雜。

MVP 必須能做到：

掃描 Shared
掃描 mods
顯示哪些 mod 可套用
對單一 mod 執行：
json → skel
替換 atlas
替換 skel
替換 png
備份原檔
套用到 __data
還原原檔