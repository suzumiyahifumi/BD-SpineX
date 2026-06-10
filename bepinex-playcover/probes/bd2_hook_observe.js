'use strict';
// 驗證可實際攔截 SkeletonDataAsset.GetSkeletonData（Phase 3/4 hook 前提）。
function log(s){ send(s); }
const UF = Process.findModuleByName('UnityFramework');
log(`[mod] UnityFramework base=${UF.base}`);

const GET_SKELETON_DATA = UF.base.add(0x94A9560);
const il2cpp_string = (function(){
  return null; // 先不解字串，只計數 + 印 instance
})();

let n = 0;
Interceptor.attach(GET_SKELETON_DATA, {
  onEnter(args) {
    n++;
    // arg0 = this (SkeletonDataAsset*)；讀 skeletonJSON 指標(0x28) 與 atlasAssets(0x18)
    const self = args[0];
    let info = '';
    try {
      const skelJSON = self.add(0x28).readPointer();
      const atlas = self.add(0x18).readPointer();
      info = ` skeletonJSON=${skelJSON} atlasAssets=${atlas}`;
    } catch (e) { info = ' (read fail)'; }
    if (n <= 20) log(`[GetSkeletonData #${n}] this=${self}${info}`);
  },
  onLeave(ret) {
    if (n <= 20) log(`   -> SkeletonData=${ret}`);
  }
});
log('[hooked] GetSkeletonData @ ' + GET_SKELETON_DATA + ' — 等待呼叫…');
