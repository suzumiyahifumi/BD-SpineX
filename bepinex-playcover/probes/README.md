# Probes — Phase 1 Runtime Probe

針對 macOS + PlayCover 的 BrownDust II 做執行時探測。先讀 `../FEASIBILITY.md`。

## 環境

- App: `~/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app`
- 主程式（attach 用的程序名）：`BrownDustII`
- IL2CPP runtime：`Frameworks/UnityFramework.framework/UnityFramework`（已解密、arm64）

## 先安裝

```bash
pip install frida-tools     # frida CLI + python
frida --version
```

## attach 方式（已採用：frida-gadget）

主程式 **沒有 `get-task-allow`**，Frida 不能直接 `attach`。本專案採用 **frida-gadget 注入**
（與最終產品管線一致）：把 gadget 當 dylib 用 `LC_LOAD_DYLIB` 注入，listen 在 `127.0.0.1:27042`。
完整步驟與還原見 [`../INJECTION.md`](../INJECTION.md)。

## 執行（gadget listen 模式）

啟動遊戲、等 gadget listen 後：

```bash
# 確認 gadget 在 listen
lsof -nP -iTCP:27042 -sTCP:LISTEN
.venv-tools/bin/frida-ps -H 127.0.0.1:27042       # 應看到 "Gadget"

# 非互動 runner（推薦，腳本用 send() 回傳）：
.venv-tools/bin/python run_probe.py bd2_resolve_check.js 10    # ★ RVA 交叉驗證
.venv-tools/bin/python run_probe.py bd2_hook_observe.js 30     # 攔截 GetSkeletonData（需切到角色畫面）
.venv-tools/bin/python run_probe.py _diag.js 6                 # 模組/API 診斷

# 互動 REPL（腳本用 console.log）：
.venv-tools/bin/frida -H 127.0.0.1:27042 Gadget -l bd2_modules_probe.js
.venv-tools/bin/frida -H 127.0.0.1:27042 Gadget -l bd2_il2cpp_probe.js
```

> frida 17 API 注意：舊的 `Module.findExportByName(null, ...)` 已移除，改用
> `Module.findGlobalExportByName(...)` 或 `module.findExportByName(...)`。腳本已更新。

## 成功條件（對應 DEVELOPMENT_PLAN Phase 1）— **已全數通過**

- ✅ `_diag` / `bd2_modules_probe`：`UnityFramework` base=0x300000000，il2cpp 導出非 MISS。
- ✅ `bd2_resolve_check`：`SkeletonDataAsset`/`SpineAtlasAsset`/`SkeletonGraphic` 解析成功，
      執行時位址 == `base + dumpRVA`（match=true）。
- ✅ `bd2_hook_observe`：成功 attach 到 `GetSkeletonData`（切到角色畫面可看到 live 呼叫）。

結果見 [`../PHASE1_RESULTS.md`](../PHASE1_RESULTS.md)。下一步：Phase 3 自製 loader。
