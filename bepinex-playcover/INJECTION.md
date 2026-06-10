# 注入流程（frida-gadget，已實測）

> 這是 Phase 1 實際使用、且與最終產品一致的注入管線（macOS 版的 BepInEx「Doorstop」）。
> 對象：`~/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app`

## 原理

PlayCover 已用 `LC_LOAD_DYLIB` 把 `PlayTools.framework` 載入主程式。
我們用同樣手法，額外加一條 `LC_LOAD_DYLIB` 指向我們的 dylib（探測期是 frida-gadget，
Phase 3 之後換成自製 loader）。因為主程式是 **adhoc 簽章且無 hardened runtime
→ library validation 沒開**，所以可載入自簽 dylib，只需重簽主程式。

## 已執行的步驟（探測期：frida-gadget）

```bash
APP="$HOME/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app"

# 0) 備份主程式（已存於 ../com.neowizgames.game.browndust2ios.app.BAK-mainbin/）
cp -p "$APP/BrownDustII" "<backup>/BrownDustII"

# 1) 取得 frida-gadget（macOS universal）→ 抽 arm64 → 放進 Frameworks
lipo frida-gadget.dylib -thin arm64 -output FridaGadget.dylib
cp FridaGadget.dylib "$APP/Frameworks/FridaGadget.dylib"

# 2) gadget config：listen 模式（127.0.0.1:27042, on_load=resume）
#    檔名須與 dylib 同名：FridaGadget.config.json
cat > "$APP/Frameworks/FridaGadget.config.json" <<'JSON'
{ "interaction": { "type": "listen", "address": "127.0.0.1", "port": 27042, "on_load": "resume" } }
JSON

# 3) adhoc 簽 gadget
codesign -f -s - "$APP/Frameworks/FridaGadget.dylib"

# 4) 加 LC_LOAD_DYLIB（用 lief；install_name_tool 無法新增 load dylib）
#    指向 @executable_path/Frameworks/FridaGadget.dylib
python - <<'PY'
import lief, os
binp = os.path.expanduser("~/Library/.../BrownDustII")
fat = lief.MachO.parse(binp); m = fat.at(0)
m.add_library("@executable_path/Frameworks/FridaGadget.dylib")
fat.write(binp)
PY

# 5) 保留原 entitlements 重簽主程式（重要：sandbox 例外都在裡面）
codesign -d --entitlements - --xml "$APP/BrownDustII" > bd2.entitlements.plist
codesign -f -s - --entitlements bd2.entitlements.plist "$APP/BrownDustII"
codesign -v "$APP/BrownDustII"   # 應為 valid

# 6) 啟動
open "$APP"
# 等 gadget listen
lsof -nP -iTCP:27042 -sTCP:LISTEN
frida-ps -H 127.0.0.1:27042       # 應看到 "Gadget"
```

## 還原（移除注入）

```bash
APP="$HOME/Library/Containers/io.playcover.PlayCover/Applications/com.neowizgames.game.browndust2ios.app"
BAK="$APP/../com.neowizgames.game.browndust2ios.app.BAK-mainbin"
cp -p "$BAK/BrownDustII" "$APP/BrownDustII"          # 還原原始主程式
rm -f "$APP/Frameworks/FridaGadget.dylib" "$APP/Frameworks/FridaGadget.config.json"
# 主程式還原後即為原 adhoc 簽章，無需重簽
```

## 注意事項

- **遊戲更新 / 重裝會還原主程式 → 注入失效**，需重做（Phase 5 GUI 要自動化）。
- gadget listen 模式會讓遊戲一直開著 127.0.0.1:27042；正式產品換成自製 loader 後就不需要。
- 目前 `bypass=0`、`playChain=1`（PlayCover 設定）下注入可正常啟動。
- 這條管線 = 之後 Phase 3 自製 loader 的注入方式，只是把 `FridaGadget.dylib` 換成 `libbd2loader.dylib`。
