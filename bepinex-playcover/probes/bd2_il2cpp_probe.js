'use strict';

// Probe 2 — 透過 il2cpp C API 從執行時解析 Spine 相關類別與方法位址。
// 這是 macOS/IL2CPP 版的核心探測：證明我們能在不靠 metadata dump 的情況下，
// 從活著的程序裡拿到 hook 目標的位址（Phase 1 成功條件）。

const uf = Process.findModuleByName('UnityFramework');
if (!uf) {
  console.log('[il2cpp probe] UnityFramework 未載入，先確認遊戲已啟動');
}

function fn(name, ret, args) {
  // frida 17 API：模組層級查找優先，再退回全域。
  let a = uf && uf.findExportByName ? uf.findExportByName(name) : null;
  if (!a) a = Module.findGlobalExportByName(name);
  if (!a) { console.log(`[MISS] ${name}`); return null; }
  return new NativeFunction(a, ret, args);
}

const il2cpp_domain_get        = fn('il2cpp_domain_get', 'pointer', []);
const il2cpp_thread_attach     = fn('il2cpp_thread_attach', 'pointer', ['pointer']);
const il2cpp_class_from_name   = fn('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
const il2cpp_domain_assemblies = fn('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
const il2cpp_assembly_get_image= fn('il2cpp_assembly_get_image', 'pointer', ['pointer']);
const il2cpp_class_get_methods = fn('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
const il2cpp_method_get_name   = fn('il2cpp_method_get_name', 'pointer', ['pointer']);

if (!il2cpp_domain_get) { console.log('沒有 il2cpp_domain_get，停止'); }

const domain = il2cpp_domain_get();
il2cpp_thread_attach(domain);
console.log(`[il2cpp] domain = ${domain}`);

// 走訪所有 assembly image，對每個 image 嘗試解析目標類別。
const countPtr = Memory.alloc(Process.pointerSize);
const asmArr = il2cpp_domain_assemblies(domain, countPtr);
const count = countPtr.readUInt();
console.log(`[il2cpp] assemblies = ${count}`);

const targets = [
  'SkeletonGraphic',
  'SkeletonDataAsset',
  'SpineAtlasAsset',
  'AtlasAssetBase',
  'MenuIllustController',
  'SpineAnimationController',
];

function dumpClass(image, ns, name) {
  const nsPtr = Memory.allocUtf8String(ns);
  const namePtr = Memory.allocUtf8String(name);
  const klass = il2cpp_class_from_name(image, nsPtr, namePtr);
  if (klass.isNull()) return false;
  console.log(`\n[CLASS] ${ns ? ns + '.' : ''}${name} @ ${klass}`);
  const iter = Memory.alloc(Process.pointerSize);
  let m;
  let n = 0;
  while (!(m = il2cpp_class_get_methods(klass, iter)).isNull() && n < 40) {
    const mn = il2cpp_method_get_name(m).readUtf8String();
    console.log(`    ${mn}  -> ${m}`);
    n++;
  }
  return true;
}

for (let i = 0; i < count; i++) {
  const asm = asmArr.add(i * Process.pointerSize).readPointer();
  const image = il2cpp_assembly_get_image(asm);
  for (const t of targets) {
    // 多數 Spine 類別在 namespace "Spine.Unity"；遊戲類別在預設 namespace。
    if (dumpClass(image, 'Spine.Unity', t)) continue;
    dumpClass(image, '', t);
  }
}

console.log('\n[il2cpp probe] done');
