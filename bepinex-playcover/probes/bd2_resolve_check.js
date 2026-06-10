'use strict';

// Live 驗證腳本：解析 Spine 類別 + 交叉驗證 IL2CPP_TARGETS.md 的 RVA。
// 訊息用 send() 經 run_probe.py 印出。

function log(s) { send(s); }

const UF = Process.findModuleByName('UnityFramework');
if (!UF) { log('[FATAL] UnityFramework 未載入'); throw new Error('no UnityFramework'); }
log(`[mod] UnityFramework base=${UF.base} size=${UF.size}`);

function fn(name, ret, args) {
  // frida 17 API：優先用模組層級查找，再退回全域。
  let a = UF && UF.findExportByName ? UF.findExportByName(name) : null;
  if (!a) a = Module.findGlobalExportByName(name);
  return a ? new NativeFunction(a, ret, args) : null;
}

const il2cpp_domain_get        = fn('il2cpp_domain_get', 'pointer', []);
const il2cpp_thread_attach     = fn('il2cpp_thread_attach', 'pointer', ['pointer']);
const il2cpp_class_from_name   = fn('il2cpp_class_from_name', 'pointer', ['pointer','pointer','pointer']);
const il2cpp_domain_assemblies = fn('il2cpp_domain_get_assemblies', 'pointer', ['pointer','pointer']);
const il2cpp_assembly_get_image= fn('il2cpp_assembly_get_image', 'pointer', ['pointer']);
const il2cpp_image_get_name    = fn('il2cpp_image_get_name', 'pointer', ['pointer']);
const il2cpp_class_get_methods = fn('il2cpp_class_get_methods', 'pointer', ['pointer','pointer']);
const il2cpp_method_get_name   = fn('il2cpp_method_get_name', 'pointer', ['pointer']);
const il2cpp_class_get_method_from_name = fn('il2cpp_class_get_method_from_name', 'pointer', ['pointer','pointer','int']);

log(`[api] domain_get=${!!il2cpp_domain_get} class_from_name=${!!il2cpp_class_from_name} runtime_invoke=${!!fn('il2cpp_runtime_invoke','pointer',[])}`);

const domain = il2cpp_domain_get();
il2cpp_thread_attach(domain);

// 找 spine-unity image
const cntp = Memory.alloc(Process.pointerSize);
const arr = il2cpp_domain_assemblies(domain, cntp);
const cnt = cntp.readUInt();
log(`[il2cpp] assemblies=${cnt}`);
let spineImg = null, asmImg = null;
for (let i = 0; i < cnt; i++) {
  const asm = arr.add(i*Process.pointerSize).readPointer();
  const img = il2cpp_assembly_get_image(asm);
  const nm = il2cpp_image_get_name(img).readUtf8String();
  if (nm === 'spine-unity.dll') spineImg = img;
  if (nm === 'Assembly-CSharp.dll') asmImg = img;
}
log(`[img] spine-unity=${spineImg} Assembly-CSharp=${asmImg}`);

// RVA 交叉驗證表（來自 IL2CPP_TARGETS.md）
const checks = [
  { img: 'spine', ns: 'Spine.Unity', cls: 'SkeletonDataAsset', method: 'GetSkeletonData', argc: 1, rva: 0x94A9560 },
  { img: 'spine', ns: 'Spine.Unity', cls: 'SpineAtlasAsset',   method: 'GetAtlas',        argc: 1, rva: 0x94AC8F4 },
  { img: 'spine', ns: 'Spine.Unity', cls: 'SkeletonGraphic',   method: 'Initialize',      argc: 1, rva: 0x94B16AC },
];

function imgOf(tag) { return tag === 'spine' ? spineImg : asmImg; }

for (const c of checks) {
  const image = imgOf(c.img);
  if (!image) { log(`[skip] ${c.cls}: image null`); continue; }
  const klass = il2cpp_class_from_name(image, Memory.allocUtf8String(c.ns), Memory.allocUtf8String(c.cls));
  if (klass.isNull()) { log(`[MISS class] ${c.ns}.${c.cls}`); continue; }
  const m = il2cpp_class_get_method_from_name(klass, Memory.allocUtf8String(c.method), c.argc);
  if (m.isNull()) { log(`[MISS method] ${c.cls}.${c.method}/${c.argc}`); continue; }
  // MethodInfo 第一個欄位是 methodPointer
  const mptr = m.readPointer();
  const runtimeRva = mptr.sub(UF.base);
  const match = (runtimeRva.toUInt32 ? runtimeRva.toUInt32() : parseInt(runtimeRva.toString(),16)) === c.rva;
  log(`[CHECK] ${c.cls}.${c.method}: klass=${klass} mptr=${mptr} runtimeRVA=${runtimeRva} dumpRVA=0x${c.rva.toString(16)} match=${match}`);
}

log('[done]');
