# Phase 5 — GUI 整合計畫

把執行時 loader（Phase 3/4）接進 BD-SpineX Electron app，實現使用者的 mod 管理願景：
**選 mod 庫資料夾 → 勾選要掛的 mod → 掛載進遊戲讀取的目錄 → 安裝注入 → 啟動遊戲**。

## 架構（沿用既有 IPC 模式）
- `core/macho-inject.ts`：Node 版 `LC_LOAD_DYLIB` 注入器（取代 dev 期的 python lief），免 python 依賴。
- `core/runtime-loader.ts`：執行時管理邏輯
  - 狀態：mount dir、loader dylib 是否就緒、主程式是否已注入、遊戲版本是否相符。
  - 注入：`installLoader()`（複製 dylib 進 Frameworks + macho-inject 加 load command + 保留 entitlements codesign + 備份原檔）/ `uninstallLoader()`（還原備份）。
  - 掛載：`listLibraryMods(dir)` / `getMountedMods()` / `mountMod()` / `unmountMod()`（複製到 mount dir；sandbox 下 symlink 目標需在允許路徑，故預設複製）。
  - `launchGame()`。
- `app/main/index.ts`：新增 `runtime:*` IPC handlers。
- `app/preload/index.cts`：暴露 `window.bd2.runtime*`。
- `app/renderer/src/App.tsx`：新增「Runtime Mods (Beta)」分頁/區塊。

## 路徑
- App bundle：`~/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app`
- 主程式：`<app>/BrownDustII`；備份：`<app>/../*.BAK-mainbin/BrownDustII`
- loader dylib：打包時放 extraResources `backend/bd2loader/libbd2loader.dylib` + frida-gum 已靜態連入。
- mount dir：`~/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2mods/`（sandbox 可讀寫）

## 子階段
- [ ] 5.1 `macho-inject.ts` + 實測（Node 注入 → 啟動 → loader log）。
- [ ] 5.2 `runtime-loader.ts`（狀態/注入/掛載/啟動）。
- [ ] 5.3 IPC + preload。
- [ ] 5.4 React「Runtime Mods」面板。
- [ ] 5.5 打包：loader dylib 納入 extraResources、build pipeline。

## 已知限制（沿用 Phase 4）
- 目前 JSON mod 全可；二進位 .skel 約會仍待解（loader 端問題，與 GUI 無關）。
- loader log 路徑硬編待改。記憶體 pin 累積待清理。
