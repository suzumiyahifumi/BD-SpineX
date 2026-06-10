'use strict';

// Probe 1 — 確認 UnityFramework / IL2CPP 模組是否載入。
// 用法見 probes/README.md。

console.log('[BD2 Module Probe] start');

Process.enumerateModules()
  .filter(m =>
    m.name.includes('Unity') ||
    m.name.includes('il2cpp') ||
    m.name.includes('GameAssembly') ||
    m.name.includes('PlayTools') ||
    m.name.includes('Spine')
  )
  .forEach(m => {
    console.log(`\n${m.name}`);
    console.log(`  base: ${m.base}`);
    console.log(`  size: ${m.size}`);
    console.log(`  path: ${m.path}`);
  });

// 確認 il2cpp API 是否可解析（feasibility 已靜態確認 241 個導出）。
// frida 17 API：Module.findGlobalExportByName（舊 Module.findExportByName 已移除）。
const probe = ['il2cpp_init', 'il2cpp_domain_get', 'il2cpp_class_from_name', 'il2cpp_runtime_invoke'];
console.log('\n[il2cpp exports]');
for (const name of probe) {
  const addr = Module.findGlobalExportByName(name);
  console.log(`  ${name}: ${addr ? addr : 'MISS'}`);
}
