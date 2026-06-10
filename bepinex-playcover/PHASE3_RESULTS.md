# Phase 3 — 原生 loader 雛形結果

> 日期：2026-06-10　loader：`loader/`（Rust cdylib，零外部依賴）
> 注入方式：`LC_LOAD_DYLIB` + adhoc 重簽（`tools/inject_dylib.py`），與 `INJECTION.md` 同管線。

## 結論：成功 ✅

我們自己的原生 dylib 在遊戲程序內跑起來，並在**不靠 Frida** 的情況下與 il2cpp 對話：

```
=== bd2loader constructor invoked (deferring dyld work) ===
loader thread start; waiting for UnityFramework + il2cpp...
il2cpp ready: UnityFramework handle=0x6e1de110 domain=0x11b407fc0
il2cpp_thread_attach -> 0x3347b8a80
HELLO FROM INSIDE BrownDust II (bd2loader) — Phase 3 OK
```

遊戲程序在 loader 注入後**穩定存活**。

## 驗證了什麼

1. `__mod_init_func` constructor 被 dyld 呼叫（= 我們的程式碼進入遊戲）。
2. 背景執行緒成功解析 **UnityFramework**（用 `dlopen(path, RTLD_NOLOAD)` 取 handle）。
3. 取得 il2cpp **domain** 並 `il2cpp_thread_attach` 成功。
4. 全程穩定、不影響遊戲執行。

## 過程中踩到的兩個關鍵雷（已解，務必記住）

### 雷 1：在 dyld 初始化器裡呼叫 dyld API → 卡死啟動
constructor（及其剛 spawn 的執行緒）在 dyld 持有 lock 期間呼叫
`dlsym/dlopen/_dyld_*` 會與主執行緒搶 lock，**害遊戲卡在 UnityFramework 載入前並退出**。
**解法**：constructor 只開執行緒；執行緒先 `sleep(5s)` 等 dyld 初始化與 app 啟動完成，才碰 dyld API。

### 雷 2：`dlsym(RTLD_DEFAULT, "il2cpp_*")` 找不到符號
遊戲以 **RTLD_LOCAL** 載入 UnityFramework，其 il2cpp 導出不在全域命名空間，
`dlsym(RTLD_DEFAULT,…)` 回 null（但 Frida 直接讀 export table 看得到，故易誤判）。
**解法**：先 `dlopen(UnityFramework_path, RTLD_NOLOAD)` 取得該框架 handle，再對 handle `dlsym`。

### 雷 3：frida-gadget 與自製 loader 同時注入會衝突
兩者同時存在時遊戲啟動異常（gadget 不 listen、UnityFramework 不載入、最終退出）。
**結論**：探測期用 gadget，開發 loader 時請**只注入 loader**（移除 gadget load command）。

## 已知技術債（Phase 4 前處理）

- log 路徑目前**硬編**遊戲 container Data 絕對路徑（含使用者名稱），方便診斷；
  正式版應改成由 `_NSGetExecutablePath` / bundle 推導，或寫進 io.playcover 容器。
- `il2cpp_get_version` 未成功解析（非阻塞；domain + attach 已足夠）。

## 進入 Phase 4

loader 已能進入遊戲並握有 il2cpp domain/thread。
下一步：引入 **Dobby**，對 `IL2CPP_TARGETS.md` 的 `SkeletonDataAsset.GetSkeletonData`
（base + 0x94A9560）等做 inline hook，開始實作 Spine 替換。
