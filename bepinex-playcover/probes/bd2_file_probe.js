'use strict';

// Probe 3 — 觀察角色資源 (__data / .skel / .atlas / .png) 實際載入路徑與時機。
// 純觀察，不修改。對應 SPINE_RUNTIME_PROBE_RESEARCH.md 的 File Access Probe。

const keywords = ['__data', '.skel', '.atlas', '.png', 'char', 'Spine', 'spine'];

function shouldLog(path) {
  return path && keywords.some(k => path.includes(k));
}

function readPath(ptr) {
  try { return ptr.isNull() ? null : ptr.readUtf8String(); }
  catch (_) { return null; }
}

function hookExport(name, argIndex) {
  const addr = Module.findExportByName(null, name);
  if (!addr) { console.log(`[MISS] ${name}`); return; }
  console.log(`[HOOK] ${name} @ ${addr}`);
  Interceptor.attach(addr, {
    onEnter(args) {
      const path = readPath(args[argIndex]);
      if (shouldLog(path)) {
        console.log(`\n[${name}] ${path}`);
        console.log(
          Thread.backtrace(this.context, Backtracer.ACCURATE)
            .map(DebugSymbol.fromAddress).join('\n')
        );
      }
    }
  });
}

console.log('[BD2 File Probe] start');
hookExport('open', 0);
hookExport('openat', 1);
hookExport('stat', 0);
hookExport('lstat', 0);
hookExport('access', 0);
hookExport('fopen', 0);
