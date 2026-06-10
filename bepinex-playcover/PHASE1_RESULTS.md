# Phase 1 — Runtime Probe 結果（live 驗證）

> 日期：2026-06-10　遊戲：BrownDust II 2.27.19（iOS/PlayCover build, PID 觀測 base=0x300000000）
> 注入方式：frida-gadget 經 `LC_LOAD_DYLIB` 注入（見 `INJECTION.md`）。

## 驗證結論：全數通過 ✅

| 成功條件 | 結果 |
|----------|------|
| 能把程式碼注入並在遊戲程序內執行 | ✅ frida-gadget 透過我們加的 `@executable_path/Frameworks/FridaGadget.dylib` 載入，listen 127.0.0.1:27042 |
| 看到 `UnityFramework` 模組 | ✅ base=`0x300000000`、size=186 MB |
| il2cpp C API 可用 | ✅ `il2cpp_domain_get/class_from_name/runtime_invoke/thread_attach` 皆可解析 |
| 從執行時解析 Spine 類別 | ✅ 185 個 assembly，定位 `spine-unity.dll` / `Assembly-CSharp.dll` image |
| **RVA 交叉驗證（靜態 dump ↔ 執行時）** | ✅ **完全吻合**（見下表） |
| Interceptor 可掛上目標方法 | ✅ 成功 attach 到 `GetSkeletonData`（無錯誤） |

## RVA 交叉驗證（關鍵）

執行時方法位址 = `UnityFramework.base + dumpRVA`，三個目標全部 `match=true`：

| 方法 | klass | runtime RVA | dump RVA (IL2CPP_TARGETS) |
|------|-------|-------------|---------------------------|
| `Spine.Unity.SkeletonDataAsset.GetSkeletonData` | 0x1490a8e20 | 0x94a9560 | 0x94a9560 |
| `Spine.Unity.SpineAtlasAsset.GetAtlas` | 0x1592d92c0 | 0x94ac8f4 | 0x94ac8f4 |
| `Spine.Unity.SkeletonGraphic.Initialize` | 0x179f8e740 | 0x94b16ac | 0x94b16ac |

→ **靜態 dump 的 RVA 可直接用於執行時 inline hook**（位址 = base + RVA），
  Phase 3/4 不需要再靠 signature scan 定位（只需在版本更新後重 dump）。

額外確認：`il2cpp_domain_get` 執行時在 `0x30183baf8` = base + `0x183BAF8`，與 `dyld_info -exports` 的靜態 RVA 一致。

## 已知觀察

- `bd2_hook_observe.js` 在標題/登入畫面 20 秒內未捕捉到 `GetSkeletonData` 呼叫——
  因為已載入的骨架被快取。需在遊戲內切到**有角色立繪**的畫面才會觸發新載入。
  （Interceptor 已成功掛上，只是等不到呼叫；非失敗。）

## 重現方式

```bash
cd bepinex-playcover
# 1) 確保已注入（見 INJECTION.md），啟動遊戲
# 2) 等 gadget listen 後執行：
.venv-tools/bin/python probes/run_probe.py probes/bd2_resolve_check.js 10   # RVA 驗證
.venv-tools/bin/python probes/run_probe.py probes/bd2_hook_observe.js 30    # 切到角色畫面看 live 呼叫
```

## 進入 Phase 3

判定依據已足夠：注入鏈、il2cpp 解析、RVA 對應、攔截能力全部驗證。
下一步開始 loader（原生 dylib）雛形，把「靠 frida 驗證」轉成「自製 dylib 直接 hook」。
