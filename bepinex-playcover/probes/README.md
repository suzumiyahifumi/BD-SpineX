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

## attach 限制與解法

主程式 **沒有 `get-task-allow`**，Frida 不能直接 attach。二選一：

### A. 重簽成可除錯（最快開始探測）

```bash
APP="$HOME/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app"
# 取出現有 entitlements，加入 get-task-allow，再 adhoc 重簽
codesign -d --entitlements ent.plist --xml "$APP/BrownDustII"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.get-task-allow bool true" ent.plist
codesign -f -s - --entitlements ent.plist "$APP/BrownDustII"
```

> 注意：重簽後若 SIP 仍限制，attach 可能需要 `sudo frida ...`。
> 重裝/更新遊戲會還原簽章，需重做。

### B. frida-gadget（推薦，與最終注入管線一致）

把 `frida-gadget.dylib` 當成普通 dylib，用與 PlayTools 相同的 `LC_LOAD_DYLIB` 手法注入
（見 `../DEVELOPMENT_PLAN.md` Phase 3）。這條路不需要 `get-task-allow`，
也順便驗證了最終產品的注入機制。

## 執行

啟動遊戲後：

```bash
frida -n BrownDustII -l bd2_modules_probe.js     # 確認 UnityFramework / il2cpp 導出
frida -n BrownDustII -l bd2_il2cpp_probe.js       # 從執行時解析 Spine 類別與方法位址
frida -n BrownDustII -l bd2_file_probe.js         # 觀察 __data / Spine 資源載入路徑
```

## 成功條件（對應 DEVELOPMENT_PLAN Phase 1）

- `bd2_modules_probe`：看到 `UnityFramework` base/size，il2cpp 導出非 MISS。
- `bd2_il2cpp_probe`：印出 `SkeletonGraphic` / `SkeletonDataAsset` 等類別與其方法位址。
- `bd2_file_probe`：在切換角色時看到 `__data` 載入與 backtrace。

通過後進入 Phase 2（Il2CppDumper 取精確簽章）。
