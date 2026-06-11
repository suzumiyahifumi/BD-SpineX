# bd2loader

BD-SpineX 的執行時 loader：一個注入進 BrownDust II（macOS / PlayCover）的 Rust `cdylib`，
在遊戲執行時 hook Spine 載入並動態套用掛載的 mod（不需修改遊戲的 `__data`）。

由 BD-SpineX 主程式（`core/runtime-loader.ts`）以 `LC_LOAD_DYLIB` 注入並 adhoc 重簽。

## 建置

由 `scripts/build-loader.mjs` 自動化（`npm run build:loader`，亦由 `npm run build:backends` 呼叫）：
1. 取得 frida-gum devkit（缺少時自動下載到 `../frida-gum`，靜態連入）。
2. `cargo build --release --target aarch64-apple-darwin`。
3. 複製到 `dist-native/bd2loader/libbd2loader.dylib`（打包時納入 `backend/bd2loader`）。

手動：
```bash
cargo build --release --target aarch64-apple-darwin
# 需要 ../frida-gum/{libfrida-gum.a,frida-gum.h}（build-loader.mjs 會自動下載）
```

## 重點

- 入口為 `__DATA,__mod_init_func` constructor（零外部 crate）；frida-gum 靜態連入，無執行時相依。
- `install_name` 在連結期烤入（`@executable_path/Frameworks/libbd2loader.dylib`），安裝時免 `install_name_tool`。
- IL2CPP hook 位址（`src/lib.rs` 頂部的 `RVA_*` / `OFF_*`）**綁定遊戲版本**；遊戲改版需重新取得位址。
