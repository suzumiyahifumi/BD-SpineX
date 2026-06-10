# BepInEx-for-PlayCover

在 macOS + PlayCover 上，做到類似 Windows 桌機版 **BrownDustX (BepInEx 插件)** 的
**執行時掛載 Spine 模組**，取代目前 BD-SpineX 的離線 `__data` Patch 流程。

| 檔案 | 內容 |
|------|------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **整個 runtime patch 機制的端到端技術細節（先看這個）** |
| [`VERSIONING.md`](VERSIONING.md) | 版本綁定常數、遊戲更新行為、升級新版 SOP、近期改動 |
| [`IL2CPP_TARGETS.md`](IL2CPP_TARGETS.md) | hook 目標方法 RVA 與欄位偏移 |
| [`FEASIBILITY.md`](FEASIBILITY.md) | 可行性研究報告與本機靜態分析 |
| [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) | 分階段開發規劃（Phase 1–5） |
| `PHASE{1,3,4,5}_*.md` | 各階段實作結果與踩雷紀錄 |
| [`INJECTION.md`](INJECTION.md) | 注入流程（探測期 frida-gadget） |
| [`probes/`](probes/) | Frida 探測腳本（開發用） |

## 一句話結論

遊戲是 arm64 **IL2CPP** Unity app、已解密、library validation 沒開、PlayCover 本來就用
`LC_LOAD_DYLIB` 注入 PlayTools——所以「注入 dylib（Doorstop 等價）+ 原生 hook + il2cpp API（Harmony 等價）」
這條路可行，且 Windows BrownDustX 的 Spine 替換目標方法在 macOS build 都存在。

下一步：安裝 frida-tools 跑 `probes/`，並用 Il2CppDumper 取得精確方法簽章。詳見 `DEVELOPMENT_PLAN.md`。
