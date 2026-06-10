//! bd2loader — BepInEx-for-PlayCover 原生 loader
//!
//! Phase 3：注入後進入遊戲、解析 il2cpp domain、attach thread。
//! Phase 4.1：用 frida-gum inline-hook `SkeletonDataAsset.GetSkeletonData`
//!            （UnityFramework.base + 0x94A9560），在 hook 內用 il2cpp runtime_invoke
//!            讀出正在載入的資產名稱（= 識別角色，決定要不要替換）。
//!
//! 注入：以 `LC_LOAD_DYLIB` 加進 BrownDustII 主程式（見 ../tools/inject_dylib.py）。

use std::ffi::{CStr, CString};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---- 常數 ----
const LOG_NOTICE: c_int = 5;
const RTLD_NOLOAD: c_int = 0x10;
// IL2CPP_TARGETS.md：SkeletonDataAsset.GetSkeletonData 的 RVA。
const RVA_GET_SKELETON_DATA: usize = 0x94A9560;
// SkeletonDataAsset 欄位偏移（IL2CPP_TARGETS.md）
const OFF_SKELETON_JSON: usize = 0x28; // TextAsset skeletonJSON

// ---- 外部符號 ----
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn syslog(priority: c_int, format: *const c_char, ...);
    fn _dyld_image_count() -> u32;
    fn _dyld_get_image_name(index: u32) -> *const c_char;
    fn _dyld_get_image_header(index: u32) -> *const c_void;

    // frida-gum（靜態庫）
    fn gum_init_embedded();
    fn gum_interceptor_obtain() -> *mut c_void;
    fn gum_interceptor_begin_transaction(interceptor: *mut c_void);
    fn gum_interceptor_end_transaction(interceptor: *mut c_void);
    // 注意參數順序：第 4 個是 original_function（out），第 5 個才是 options（可 NULL）。
    fn gum_interceptor_replace(
        interceptor: *mut c_void,
        function_address: *mut c_void,
        replacement_function: *mut c_void,
        original_function: *mut *mut c_void,
        options: *mut c_void,
    ) -> c_int;
}

// ---- il2cpp 函式型別 ----
type FnDomainGet = unsafe extern "C" fn() -> *mut c_void;
type FnThreadAttach = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type FnDomainGetAssemblies = unsafe extern "C" fn(*mut c_void, *mut usize) -> *mut c_void;
type FnAssemblyGetImage = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type FnImageGetName = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type FnClassFromName = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_void;
type FnClassGetMethodFromName = unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> *mut c_void;
type FnRuntimeInvoke =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *mut *mut c_void, *mut *mut c_void) -> *mut c_void;

// GetSkeletonData 原始函式（hook 後用來呼叫原始邏輯）
type FnGetSkeletonData = unsafe extern "C" fn(*mut c_void, bool) -> *mut c_void;

// ---- 全域狀態（pointer 以 usize 存）----
static ORIG_GET_SKELETON_DATA: AtomicUsize = AtomicUsize::new(0);
static UNITY_HANDLE: AtomicUsize = AtomicUsize::new(0);
static M_OBJECT_GET_NAME: AtomicUsize = AtomicUsize::new(0); // MethodInfo* of UnityEngine.Object.get_name
static F_RUNTIME_INVOKE: AtomicUsize = AtomicUsize::new(0);

// ---- log ----
const HARDCODED_LOG: &str =
    "/Users/suzumiyahifumi/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2loader.log";

fn log_paths() -> Vec<String> {
    let mut v = vec![HARDCODED_LOG.to_string()];
    if let Ok(home) = std::env::var("HOME") {
        v.push(format!("{}/bd2loader.log", home));
    }
    v.push("/tmp/bd2loader.log".to_string());
    v
}

fn logline(msg: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("[{}] {}", ts, msg);
    if let Ok(c) = CString::new(format!("BD2LOADER: {}", line)) {
        let fmt = CString::new("%s").unwrap();
        unsafe { syslog(LOG_NOTICE, fmt.as_ptr(), c.as_ptr()) };
    }
    for p in log_paths() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{}", line);
            break;
        }
    }
}

// ---- il2cpp helpers ----
unsafe fn resolve<T: Copy>(handle: *mut c_void, name: &str) -> Option<T> {
    let c = CString::new(name).ok()?;
    let p = dlsym(handle, c.as_ptr());
    if p.is_null() { None } else { Some(std::mem::transmute_copy::<*mut c_void, T>(&p)) }
}

/// 找 UnityFramework 的 (dlopen handle, base address)。
unsafe fn find_unity() -> (*mut c_void, usize) {
    let n = _dyld_image_count();
    for i in 0..n {
        let name_ptr = _dyld_get_image_name(i);
        if name_ptr.is_null() { continue; }
        let name = CStr::from_ptr(name_ptr).to_string_lossy();
        if name.contains("UnityFramework.framework/UnityFramework") {
            let handle = dlopen(name_ptr, RTLD_NOLOAD);
            let base = _dyld_get_image_header(i) as usize;
            return (handle, base);
        }
    }
    (std::ptr::null_mut(), 0)
}

/// 取得某 assembly image（依 dll 名）。
unsafe fn image_by_name(handle: *mut c_void, domain: *mut c_void, want: &str) -> *mut c_void {
    let get_asm: FnDomainGetAssemblies = match resolve(handle, "il2cpp_domain_get_assemblies") {
        Some(f) => f, None => return std::ptr::null_mut(),
    };
    let asm_img: FnAssemblyGetImage = match resolve(handle, "il2cpp_assembly_get_image") {
        Some(f) => f, None => return std::ptr::null_mut(),
    };
    let img_name: FnImageGetName = match resolve(handle, "il2cpp_image_get_name") {
        Some(f) => f, None => return std::ptr::null_mut(),
    };
    let mut count: usize = 0;
    let arr = get_asm(domain, &mut count as *mut usize);
    for i in 0..count {
        let asm = *(arr as *mut *mut c_void).add(i);
        let img = asm_img(asm);
        let nm = CStr::from_ptr(img_name(img)).to_string_lossy();
        if nm == want { return img; }
    }
    std::ptr::null_mut()
}

/// 讀 Il2CppString*（length@0x10, utf16@0x14）。
unsafe fn read_il2cpp_string(s: *mut c_void) -> Option<String> {
    if s.is_null() { return None; }
    let len = *((s as *const u8).add(0x10) as *const i32);
    if len < 0 || len > 4096 { return None; }
    let chars = (s as *const u8).add(0x14) as *const u16;
    let slice = std::slice::from_raw_parts(chars, len as usize);
    Some(String::from_utf16_lossy(slice))
}

/// 取得 Unity 物件的 name（呼叫 UnityEngine.Object.get_name）。
unsafe fn unity_object_name(obj: *mut c_void) -> Option<String> {
    if obj.is_null() { return None; }
    let m = M_OBJECT_GET_NAME.load(Ordering::Acquire) as *mut c_void;
    let invoke_p = F_RUNTIME_INVOKE.load(Ordering::Acquire);
    if m.is_null() || invoke_p == 0 { return None; }
    let invoke: FnRuntimeInvoke = std::mem::transmute(invoke_p);
    let mut exc: *mut c_void = std::ptr::null_mut();
    let res = invoke(m, obj, std::ptr::null_mut(), &mut exc as *mut *mut c_void);
    read_il2cpp_string(res)
}

// ---- hook replacement ----
extern "C" fn repl_get_skeleton_data(this: *mut c_void, quiet: bool) -> *mut c_void {
    unsafe {
        // 讀 skeletonJSON 的 name = 資產名（角色識別）
        let name = if !this.is_null() {
            let skel_json = *((this as *const u8).add(OFF_SKELETON_JSON) as *const *mut c_void);
            unity_object_name(skel_json)
        } else { None };
        logline(&format!(
            "[GetSkeletonData] this={:p} asset='{}'",
            this,
            name.as_deref().unwrap_or("?")
        ));
        // 呼叫原始函式
        let orig_p = ORIG_GET_SKELETON_DATA.load(Ordering::Acquire);
        if orig_p != 0 {
            let orig: FnGetSkeletonData = std::mem::transmute(orig_p);
            orig(this, quiet)
        } else {
            std::ptr::null_mut()
        }
    }
}

fn install_hook(handle: *mut c_void, domain: *mut c_void, base: usize) {
    unsafe {
        // 解析 UnityEngine.Object.get_name 供識別用
        if let (Some(class_from_name), Some(get_method)) = (
            resolve::<FnClassFromName>(handle, "il2cpp_class_from_name"),
            resolve::<FnClassGetMethodFromName>(handle, "il2cpp_class_get_method_from_name"),
        ) {
            let img = image_by_name(handle, domain, "UnityEngine.CoreModule.dll");
            if !img.is_null() {
                let ns = CString::new("UnityEngine").unwrap();
                let cls = CString::new("Object").unwrap();
                let klass = class_from_name(img, ns.as_ptr(), cls.as_ptr());
                if !klass.is_null() {
                    let mname = CString::new("get_name").unwrap();
                    let m = get_method(klass, mname.as_ptr(), 0);
                    M_OBJECT_GET_NAME.store(m as usize, Ordering::Release);
                    logline(&format!("resolved UnityEngine.Object.get_name = {:p}", m));
                }
            }
        }
        if let Some(invoke) = resolve::<FnRuntimeInvoke>(handle, "il2cpp_runtime_invoke") {
            F_RUNTIME_INVOKE.store(invoke as usize, Ordering::Release);
        }

        // 安裝 gum hook
        gum_init_embedded();
        let interceptor = gum_interceptor_obtain();
        let target = (base + RVA_GET_SKELETON_DATA) as *mut c_void;
        let mut orig: *mut c_void = std::ptr::null_mut();
        gum_interceptor_begin_transaction(interceptor);
        let rc = gum_interceptor_replace(
            interceptor,
            target,
            repl_get_skeleton_data as *mut c_void,
            &mut orig as *mut *mut c_void, // original_function (out)
            std::ptr::null_mut(),          // options
        );
        gum_interceptor_end_transaction(interceptor);
        ORIG_GET_SKELETON_DATA.store(orig as usize, Ordering::Release);
        logline(&format!(
            "gum_interceptor_replace target={:p} rc={} orig={:p}",
            target, rc, orig
        ));
    }
}

fn worker() {
    logline("loader thread start; waiting for UnityFramework + il2cpp...");
    let mut waited_ms: u64 = 0;
    loop {
        unsafe {
            let (handle, base) = find_unity();
            if !handle.is_null() && base != 0 {
                if let Some(domain_get) = resolve::<FnDomainGet>(handle, "il2cpp_domain_get") {
                    let domain = domain_get();
                    if !domain.is_null() {
                        UNITY_HANDLE.store(handle as usize, Ordering::Release);
                        logline(&format!(
                            "il2cpp ready: UnityFramework base={:#x} domain={:p}",
                            base, domain
                        ));
                        if let Some(attach) = resolve::<FnThreadAttach>(handle, "il2cpp_thread_attach") {
                            attach(domain);
                        }
                        install_hook(handle, domain, base);
                        logline("HELLO FROM INSIDE BrownDust II (bd2loader) — Phase 4.1 hook armed");
                        return;
                    }
                }
            }
        }
        if waited_ms < 2000 || waited_ms % 5000 == 0 {
            logline(&format!("…waiting t={}ms", waited_ms));
        }
        std::thread::sleep(Duration::from_millis(200));
        waited_ms += 200;
        if waited_ms > 60_000 {
            logline("timeout waiting for il2cpp (60s)");
            return;
        }
    }
}

extern "C" fn ctor() {
    // ⚠️ constructor 在 dyld 初始化期間執行，不可在此（或剛 spawn 就）呼叫 dyld API，
    // 否則與主執行緒搶 dyld lock 會卡死啟動。只記一行並開執行緒（執行緒先睡 5s）。
    logline("=== bd2loader constructor invoked (deferring dyld work) ===");
    std::thread::Builder::new()
        .name("bd2loader".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_secs(5));
            worker();
        })
        .ok();
}

#[link_section = "__DATA,__mod_init_func"]
#[used]
static CTOR: extern "C" fn() = ctor;
