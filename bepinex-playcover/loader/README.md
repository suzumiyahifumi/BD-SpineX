# bd2loader — 原生 loader（Phase 3+）

macOS 版 BepInEx「Doorstop + Preloader」的等價物：一個注入進 BrownDust II 的
Rust cdylib，啟動時進入遊戲程序、等 il2cpp 就緒、attach 執行緒，之後（Phase 4）
用 Dobby inline-hook Spine 方法做模組替換。

## 建置

```bash
cd loader
cargo build --release --target aarch64-apple-darwin
# 產物：target/aarch64-apple-darwin/release/libbd2loader.dylib
```

## 注入 / 測試

```bash
# 從 bepinex-playcover/ 執行
.venv-tools/bin/python tools/inject_dylib.py \
  loader/target/aarch64-apple-darwin/release/libbd2loader.dylib

open "$HOME/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app"

# 觀察 loader log（目前硬編路徑）
tail -f "$HOME/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2loader.log"
```

> ⚠️ 測試 loader 時，請確保 app 主程式**沒有同時注入 frida-gadget**
> （兩者衝突會害遊戲啟動失敗）。需要乾淨狀態時，先從備份還原主程式再只注入 loader：
> 見 `../INJECTION.md`。

## 設計重點（見 src/lib.rs 註解）

- 入口用 `__DATA,__mod_init_func`（等同 `__attribute__((constructor))`），零外部 crate。
- **constructor 不碰 dyld**；spawn 的執行緒先 `sleep(5s)` 再開始（避開 dyld lock 卡死）。
- 用 `dlopen(UnityFramework, RTLD_NOLOAD)` + `dlsym(handle,…)` 解析 il2cpp
  （遊戲以 RTLD_LOCAL 載入，`RTLD_DEFAULT` 找不到）。

## Roadmap

- [x] Phase 3：進入遊戲、解析 il2cpp domain、attach thread（見 `../PHASE3_RESULTS.md`）。
- [ ] Phase 4：整合 Dobby，inline-hook `SkeletonDataAsset.GetSkeletonData`（base+0x94A9560）等，
      實作 Spine 資源替換（見 `../IL2CPP_TARGETS.md`）。
- [ ] 技術債：log 路徑改為動態推導（目前硬編）。
