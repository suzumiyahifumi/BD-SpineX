'use strict';
function log(s){ send(s); }
log('frida ' + Frida.version);
// modules containing Unity/il2cpp
const mods = Process.enumerateModules().filter(m => /Unity|il2cpp|PlayTools|Gadget|BrownDust/i.test(m.name));
mods.forEach(m => log(`[mod] ${m.name} base=${m.base} size=${m.size} path=${m.path}`));
// API probing
log('Module.findExportByName? ' + (typeof Module.findExportByName));
log('Module.getGlobalExportByName? ' + (typeof Module.getGlobalExportByName));
log('Module.findGlobalExportByName? ' + (typeof Module.findGlobalExportByName));
const uf = Process.findModuleByName('UnityFramework');
log('UnityFramework module: ' + uf);
if (uf) {
  log('uf.findExportByName? ' + (typeof uf.findExportByName));
  const a = uf.findExportByName ? uf.findExportByName('il2cpp_domain_get') : null;
  log('il2cpp_domain_get via uf = ' + a);
}
const g = (typeof Module.findGlobalExportByName==='function') ? Module.findGlobalExportByName('il2cpp_domain_get') : null;
log('il2cpp_domain_get global = ' + g);
log('[done]');
