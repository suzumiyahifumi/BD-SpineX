# Brown Dust 2 PlayCover Runtime Mod Research

> **更新 2026-06-10：可行性研究已完成（branch `bd2/BepInEx_for_playcover`）。**
> 判定為**技術可行**：可做到類似 Windows BepInEx 的執行時掛載，不需 Patch `__data`。
> 完整結論見 [`bepinex-playcover/FEASIBILITY.md`](bepinex-playcover/FEASIBILITY.md)，
> 修訂後的開發規劃見 [`bepinex-playcover/DEVELOPMENT_PLAN.md`](bepinex-playcover/DEVELOPMENT_PLAN.md)，
> 可執行的探測腳本見 [`bepinex-playcover/probes/`](bepinex-playcover/probes/)。
> 以下為原始構想，保留作為記錄。

## Background

目前已成功完成：

```text
Spine JSON
↓
SpineSkeletonDataConverter
↓
Spine Binary (.skel)
↓
Unity AssetBundle (__data)
↓
PlayCover Brown Dust 2
```

替換流程。

目前模組管理器已能：

* 找到 Shared 中對應 bundle
* 替換 atlas
* 替換 skel
* 替換 png
* 遊戲正常載入

---

## Current Architecture

目前流程：

```text
mods/
├── char004102
│   ├── char004102.json
│   ├── char004102.atlas
│   └── char004102.png

↓

SpineSkeletonDataConverter

↓

char004102.skel

↓

UnityPy Patcher

↓

Shared/**/__data

↓

PlayCover Brown Dust 2
```

---

# Next Research Goal

目前採用：

```text
Offline Bundle Replacement
```

希望研究：

```text
Runtime Spine Injection
```

避免：

* 修改 Shared
* 重複覆蓋 `__data`
* 遊戲重啟才能套用

目標：

```text
遊戲執行時
↓
攔截 Spine Runtime
↓
動態切換角色資源
```

---

# Research Phases

## Phase 1: Runtime Probe

只觀察：

```text
不修改
不注入
不替換
```

確認：

```text
1. PlayCover Process
2. Unity Runtime
3. IL2CPP
4. Spine Runtime
```

是否存在。

---

# Probe 1: File Access Probe

目的：

找出：

```text
__data
.skel
.atlas
.png
```

實際載入位置。

## `bd2_spine_probe.js`

```javascript
'use strict';

const keywords = [
  '__data',
  '.skel',
  '.atlas',
  '.png',
  'char',
  'Spine',
  'spine'
];

function shouldLog(path) {
  if (!path) return false;
  return keywords.some(k => path.includes(k));
}

function readPath(ptr) {
  try {
    if (ptr.isNull()) return null;
    return ptr.readUtf8String();
  } catch (_) {
    return null;
  }
}

function hookExport(name, argIndex = 0) {
  const addr = Module.findExportByName(null, name);

  if (!addr) {
    console.log(`[MISS] ${name}`);
    return;
  }

  console.log(`[HOOK] ${name} @ ${addr}`);

  Interceptor.attach(addr, {
    onEnter(args) {
      const path = readPath(args[argIndex]);

      if (shouldLog(path)) {
        console.log(`\n[${name}] ${path}`);

        console.log(
          Thread.backtrace(
            this.context,
            Backtracer.ACCURATE
          )
          .map(DebugSymbol.fromAddress)
          .join('\n')
        );
      }
    }
  });
}

console.log('[BD2 Spine Probe] start');

hookExport('open', 0);
hookExport('openat', 1);
hookExport('stat', 0);
hookExport('lstat', 0);
hookExport('access', 0);
hookExport('fopen', 0);
```

## Execute

```bash
frida-ps | grep -i brown
```

```bash
frida -n "BrownDust2" \
  -l bd2_spine_probe.js
```

---

# Probe 2: Module Probe

目的：

確認：

```text
UnityFramework
libil2cpp
GameAssembly
Spine
```

是否存在。

## `bd2_modules_probe.js`

```javascript
'use strict';

console.log('[BD2 Module Probe]');

Process.enumerateModules()
  .filter(m =>
    m.name.includes('Unity') ||
    m.name.includes('il2cpp') ||
    m.name.includes('Game') ||
    m.name.includes('Spine')
  )
  .forEach(m => {
    console.log(m.name);

    console.log(`  base: ${m.base}`);
    console.log(`  size: ${m.size}`);
    console.log(`  path: ${m.path}`);
  });
```

## Execute

```bash
frida -n "BrownDust2" \
  -l bd2_modules_probe.js
```

---

# Probe 3: Spine String Probe

目的：

確認：

```text
Spine.Unity.SkeletonDataAsset
SkeletonDataAsset
SkeletonAnimation
SkeletonGraphic
SkeletonBinary
SkeletonJson
AtlasAsset
```

是否存在。

## `bd2_spine_string_probe.js`

```javascript
'use strict';

const patterns = [
  'Spine.Unity.SkeletonDataAsset',
  'SkeletonDataAsset',
  'SkeletonAnimation',
  'SkeletonGraphic',
  'SkeletonBinary',
  'SkeletonJson',
  'AtlasAsset'
];

for (const mod of Process.enumerateModules()) {
  if (
    !mod.name.includes('Unity') &&
    !mod.name.includes('il2cpp')
  ) {
    continue;
  }

  console.log(`[SCAN MODULE] ${mod.name}`);

  for (const text of patterns) {
    Memory.scan(
      mod.base,
      mod.size,
      text,
      {
        onMatch(address) {
          console.log(
            `[FOUND] ${text} @ ${address}`
          );
        },
        onError(reason) {
          console.log(
            `[SCAN ERROR] ${reason}`
          );
        },
        onComplete() {}
      }
    );
  }
}
```

## Execute

```bash
frida -n "BrownDust2" \
  -l bd2_spine_string_probe.js
```

---

# Success Criteria

## Stage 1

成功條件：

```text
✓ Frida 可 attach
✓ 可看到 __data 載入
✓ 可看到 .skel 載入
✓ 可看到 .atlas 載入
✓ 可看到 Spine 類別字串
```

---

## Stage 2

若找到：

```text
SkeletonDataAsset
SkeletonAnimation
SkeletonGraphic
```

進入：

```text
IL2CPP Metadata Analysis
```

---

# Phase 2: IL2CPP Metadata Research

工具：

```text
Il2CppDumper
Il2CppInspector
```

目標：

分析：

```text
global-metadata.dat
UnityFramework
```

找出：

```text
Spine.Unity.SkeletonDataAsset
Spine.Unity.SkeletonAnimation
Spine.Unity.AtlasAsset
```

實際 Method。

---

# Future Runtime Hook Targets

優先順序：

```text
1. SkeletonDataAsset.GetSkeletonData()

2. SkeletonAnimation.Initialize()

3. SkeletonGraphic.Initialize()

4. AtlasAsset.GetAtlas()

5. SkeletonBinary.ReadSkeletonData()

6. SkeletonJson.ReadSkeletonData()
```

---

# Runtime Injection Goal

最終目標：

```text
角色載入
↓
Hook Spine Runtime
↓
攔截 char004102
↓
動態替換 skel
↓
動態替換 atlas
↓
動態替換 texture
↓
不用修改 Shared
```

---

# Long-Term Architecture

```text
Electron/Tauri GUI
        ↓
Runtime Hook Layer
        ↓
Frida
or
Rust dylib
        ↓
IL2CPP
        ↓
Spine Runtime
        ↓
Brown Dust 2
```

---

# Future Research Topics

## File Redirect

```text
hook open()
hook fopen()

Shared/.../__data

↓

Mods/.../__data
```

---

## AssetBundle Redirect

```text
AssetBundle.LoadFromFile()

↓

Redirect Bundle
```

---

## Spine Runtime Redirect

```text
SkeletonDataAsset

↓

Custom SkeletonData
```

---

## Rust dylib Injection

研究：

```text
Rust cdylib
DYLD_INSERT_LIBRARIES
fishhook
mach_override
```

目標：

```text
不依賴 Frida
直接 Runtime Hook
```

---

# Current Recommendation

優先完成：

```text
Phase 1
Runtime Probe
```

不要直接進行：

```text
Runtime Asset Replacement
```

先取得：

```text
Spine Runtime Structure
```

再決定後續 Hook 策略。
