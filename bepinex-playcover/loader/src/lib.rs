//! bd2loader — BepInEx-for-PlayCover 原生 loader
//!
//! Phase 3：注入後進入遊戲、解析 il2cpp domain、attach thread。
//! Phase 4.1：用 frida-gum inline-hook `SkeletonDataAsset.GetSkeletonData`
//!            （UnityFramework.base + 0x94A9560），在 hook 內用 il2cpp runtime_invoke
//!            讀出正在載入的資產名稱（= 識別角色，決定要不要替換）。
//!
//! 注入：以 `LC_LOAD_DYLIB` 加進 BrownDustII 主程式（見 ../tools/inject_dylib.py）。

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---- 常數 ----
const LOG_NOTICE: c_int = 5;
const RTLD_NOLOAD: c_int = 0x10;
// IL2CPP_TARGETS.md：SkeletonDataAsset.GetSkeletonData 的 RVA。
const RVA_GET_SKELETON_DATA: usize = 0x94A9560;
// SkeletonDataAsset 欄位偏移（IL2CPP_TARGETS.md）
const OFF_ATLAS_ASSETS: usize = 0x18; // AtlasAssetBase[] atlasAssets
const OFF_SCALE: usize = 0x20; // float scale
const OFF_SKELETON_JSON: usize = 0x28; // TextAsset skeletonJSON
const OFF_SKELETON_DATA: usize = 0x70; // SkeletonData skeletonData（CreateRuntimeInstance(initialize=true) 後即填好）

// 多載用 RVA 精準定位（名稱+argc 會撞多載）
const RVA_SPINEATLAS_CREATE_TEX_MAT: usize = 0x94AC378; // SpineAtlasAsset.CreateRuntimeInstance(TextAsset, Texture2D[], Material, bool, Func)
const RVA_SKELDATA_CREATE_ARR: usize = 0x94AB660; // SkeletonDataAsset.CreateRuntimeInstance(TextAsset, AtlasAssetBase[], bool, float)

// il2cpp array 資料起點（64-bit）
const IL2CPP_ARRAY_DATA: usize = 0x20;

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
type FnStringNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type FnArrayNew = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type FnObjectNew = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type FnGcHandleNew = unsafe extern "C" fn(*mut c_void, c_int) -> u32;
type FnClassGetMethods = unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> *mut c_void;

// GetSkeletonData 原始函式（hook 後用來呼叫原始邏輯）
type FnGetSkeletonData = unsafe extern "C" fn(*mut c_void, bool) -> *mut c_void;

// ---- 全域狀態（pointer 以 usize 存）----
static ORIG_GET_SKELETON_DATA: AtomicUsize = AtomicUsize::new(0);
static UNITY_HANDLE: AtomicUsize = AtomicUsize::new(0);
static UNITY_BASE: AtomicUsize = AtomicUsize::new(0);
static M_OBJECT_GET_NAME: AtomicUsize = AtomicUsize::new(0); // MethodInfo* of UnityEngine.Object.get_name
static F_RUNTIME_INVOKE: AtomicUsize = AtomicUsize::new(0);

// ---- log / mods 目錄 ----
const HARDCODED_LOG: &str =
    "/Users/suzumiyahifumi/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2loader.log";
// 掛載目錄（Phase 5 GUI 會往這裡放選中的 mod）。
const MOUNT_DIR: &str =
    "/Users/suzumiyahifumi/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2mods";

// key（去副檔名的資產名，如 char003604 / illust_dating11 / cutscene_char066403）→ mod 子資料夾路徑
static MOD_MAP: OnceLock<HashMap<String, String>> = OnceLock::new();

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

// ---- mod 掛載目錄掃描 / 比對 ----
/// 掃 MOUNT_DIR 下每個 mod 子資料夾，把其中含 spine 檔（.atlas/.skel/.json）的「基底名」
/// 對應到該子資料夾。基底名即遊戲資產 key（去掉多頁後綴 _N 與副檔名）。
fn scan_mods() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let root = std::path::Path::new(MOUNT_DIR);
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        if let Ok(files) = std::fs::read_dir(&dir) {
            for f in files.flatten() {
                let p = f.path();
                let name = match p.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n, None => continue,
                };
                if name.starts_with("._") { continue; }
                // 只認 .atlas 當代表（每個 mod 一個 atlas，stem 即 key）
                if name.ends_with(".atlas") {
                    let key = name.trim_end_matches(".atlas").to_string();
                    map.insert(key, dir.to_string_lossy().into_owned());
                }
            }
        }
    }
    map
}

/// 由遊戲資產 name（如 "char003604.skel"）取出比對 key（去副檔名）。
fn asset_key(name: &str) -> &str {
    name.trim_end_matches(".skel")
        .trim_end_matches(".json")
        .trim_end_matches(".atlas")
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

// ---- 替換建構（策略 A）----
// key → 結果：SkeletonData ptr（成功）/ 1（失敗，不再重試）。
static REPL_CACHE: OnceLock<std::sync::Mutex<HashMap<String, usize>>> = OnceLock::new();
fn repl_cache() -> &'static std::sync::Mutex<HashMap<String, usize>> {
    REPL_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

unsafe fn rfn<T: Copy>(name: &str) -> Option<T> {
    let h = UNITY_HANDLE.load(Ordering::Acquire) as *mut c_void;
    if h.is_null() { return None; }
    resolve::<T>(h, name)
}

unsafe fn class_of(domain: *mut c_void, image: &str, ns: &str, name: &str) -> *mut c_void {
    let h = UNITY_HANDLE.load(Ordering::Acquire) as *mut c_void;
    let img = image_by_name(h, domain, image);
    if img.is_null() { logline(&format!("[build] image MISS {}", image)); return std::ptr::null_mut(); }
    let cfn: FnClassFromName = match rfn("il2cpp_class_from_name") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let nsc = CString::new(ns).unwrap();
    let nmc = CString::new(name).unwrap();
    let k = cfn(img, nsc.as_ptr(), nmc.as_ptr());
    if k.is_null() { logline(&format!("[build] class MISS {}.{} in {}", ns, name, image)); }
    k
}

unsafe fn method_by_name(klass: *mut c_void, name: &str, argc: c_int) -> *mut c_void {
    let g: FnClassGetMethodFromName = match rfn("il2cpp_class_get_method_from_name") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let c = CString::new(name).unwrap();
    g(klass, c.as_ptr(), argc)
}

/// 用 methodPointer == base+rva 精準定位多載的 MethodInfo*。
unsafe fn method_by_rva(klass: *mut c_void, base: usize, rva: usize) -> *mut c_void {
    let gm: FnClassGetMethods = match rfn("il2cpp_class_get_methods") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let want = (base + rva) as *mut c_void;
    let mut iter: *mut c_void = std::ptr::null_mut();
    loop {
        let m = gm(klass, &mut iter as *mut *mut c_void);
        if m.is_null() { break; }
        let mp = *(m as *const *mut c_void); // MethodInfo[0] = methodPointer
        if mp == want { return m; }
    }
    std::ptr::null_mut()
}

type FnFormatException = unsafe extern "C" fn(*mut c_void, *mut c_char, c_int);

unsafe fn invoke(m: *mut c_void, obj: *mut c_void, args: &mut [*mut c_void]) -> *mut c_void {
    let inv: FnRuntimeInvoke = match rfn("il2cpp_runtime_invoke") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let mut exc: *mut c_void = std::ptr::null_mut();
    let p = if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() };
    let r = inv(m, obj, p, &mut exc as *mut *mut c_void);
    if !exc.is_null() {
        let mut buf = [0u8; 1024];
        if let Some(fmt) = rfn::<FnFormatException>("il2cpp_format_exception") {
            fmt(exc, buf.as_mut_ptr() as *mut c_char, buf.len() as c_int);
        }
        let msg = CStr::from_ptr(buf.as_ptr() as *const c_char).to_string_lossy();
        logline(&format!("[build] runtime_invoke EXCEPTION: {}", msg));
    }
    r
}

unsafe fn make_string(s: &str) -> *mut c_void {
    let sn: FnStringNew = match rfn("il2cpp_string_new") { Some(f)=>f, None=>return std::ptr::null_mut() };
    match CString::new(s) { Ok(c)=>sn(c.as_ptr()), Err(_)=>std::ptr::null_mut() }
}

/// 由 bytes 建 byte[]（System.Byte 陣列）。
unsafe fn make_byte_array(domain: *mut c_void, bytes: &[u8]) -> *mut c_void {
    let byte_cls = class_of(domain, "mscorlib.dll", "System", "Byte");
    if byte_cls.is_null() { return std::ptr::null_mut(); }
    let an: FnArrayNew = match rfn("il2cpp_array_new") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let arr = an(byte_cls, bytes.len());
    if arr.is_null() { return std::ptr::null_mut(); }
    let dst = (arr as *mut u8).add(IL2CPP_ARRAY_DATA);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
    arr
}

/// 建單一參考型別陣列並填入元素。
unsafe fn make_ref_array(elem_cls: *mut c_void, elems: &[*mut c_void]) -> *mut c_void {
    let an: FnArrayNew = match rfn("il2cpp_array_new") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let arr = an(elem_cls, elems.len());
    if arr.is_null() { return std::ptr::null_mut(); }
    for (i, e) in elems.iter().enumerate() {
        let slot = (arr as *mut u8).add(IL2CPP_ARRAY_DATA + i * 8) as *mut *mut c_void;
        *slot = *e;
    }
    arr
}

/// png bytes → Texture2D（含 LoadImage 解碼），並把 .name 設為 `name`
/// （SpineAtlasAsset 以 texture.name 比對 atlas page，必須相符）。
unsafe fn make_texture(domain: *mut c_void, png: &[u8], name: &str) -> *mut c_void {
    let tex_cls = class_of(domain, "UnityEngine.CoreModule.dll", "UnityEngine", "Texture2D");
    if tex_cls.is_null() { return std::ptr::null_mut(); }
    let obj_new: FnObjectNew = match rfn("il2cpp_object_new") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let tex = obj_new(tex_cls);
    let ctor = method_by_name(tex_cls, ".ctor", 2); // Texture2D(int,int)
    if ctor.is_null() { logline("[build] Texture2D .ctor(2) MISS"); return std::ptr::null_mut(); }
    let mut w: i32 = 2; let mut h: i32 = 2;
    let mut args = [&mut w as *mut i32 as *mut c_void, &mut h as *mut i32 as *mut c_void];
    invoke(ctor, tex, &mut args);
    // ImageConversion.LoadImage(tex, byte[])
    let ic_cls = class_of(domain, "UnityEngine.ImageConversionModule.dll", "UnityEngine", "ImageConversion");
    if ic_cls.is_null() { return std::ptr::null_mut(); }
    let m_load = method_by_name(ic_cls, "LoadImage", 2);
    if m_load.is_null() { logline("[build] ImageConversion.LoadImage(2) MISS"); return std::ptr::null_mut(); }
    let bytes = make_byte_array(domain, png);
    if bytes.is_null() { return std::ptr::null_mut(); }
    let mut args2 = [tex, bytes];
    invoke(m_load, std::ptr::null_mut(), &mut args2);
    // 設定 texture.name（UnityEngine.Object.set_name）以對應 atlas page
    let obj_cls = class_of(domain, "UnityEngine.CoreModule.dll", "UnityEngine", "Object");
    if !obj_cls.is_null() {
        let m_setname = method_by_name(obj_cls, "set_name", 1);
        if !m_setname.is_null() {
            let s = make_string(name);
            let mut a = [s];
            invoke(m_setname, tex, &mut a);
        }
    }
    tex
}

unsafe fn make_textasset(domain: *mut c_void, text: &str) -> *mut c_void {
    let ta_cls = class_of(domain, "UnityEngine.CoreModule.dll", "UnityEngine", "TextAsset");
    if ta_cls.is_null() { return std::ptr::null_mut(); }
    let obj_new: FnObjectNew = match rfn("il2cpp_object_new") { Some(f)=>f, None=>return std::ptr::null_mut() };
    let ta = obj_new(ta_cls);
    let ctor = method_by_name(ta_cls, ".ctor", 1); // TextAsset(string)
    if ctor.is_null() { logline("[build] TextAsset .ctor(1) MISS"); return std::ptr::null_mut(); }
    let s = make_string(text);
    if s.is_null() { return std::ptr::null_mut(); }
    let mut args = [s]; // string 是參考型別，直接傳指標
    invoke(ctor, ta, &mut args);
    ta
}

/// 讀 atlas 文字裡列出的 page png 檔名（行首、以 .png 結尾）。
fn atlas_pages(atlas_text: &str) -> Vec<String> {
    atlas_text
        .lines()
        .map(|l| l.trim_end())
        .filter(|l| l.ends_with(".png") && !l.starts_with(char::is_whitespace))
        .map(|l| l.to_string())
        .collect()
}

/// 建構替換 SkeletonData（策略 A）。回傳 SkeletonData ptr 或 null。
/// 目前支援：文字 .json 骨架 + 單/多頁 png。二進位 .skel 暫不支援（會回 null）。
unsafe fn build_replacement(this: *mut c_void, key: &str, dir: &str, base: usize) -> *mut c_void {
    let domain = match rfn::<FnDomainGet>("il2cpp_domain_get") { Some(f)=>f(), None=>return std::ptr::null_mut() };
    let gc_new: FnGcHandleNew = match rfn("il2cpp_gchandle_new") { Some(f)=>f, None=>return std::ptr::null_mut() };

    // 1) 讀檔
    let dirp = std::path::Path::new(dir);
    let atlas_text = match std::fs::read_to_string(dirp.join(format!("{}.atlas", key))) {
        Ok(t)=>t, Err(e)=>{ logline(&format!("[build] read atlas fail: {}", e)); return std::ptr::null_mut(); }
    };
    let json_path = dirp.join(format!("{}.json", key));
    if !json_path.exists() {
        logline(&format!("[build] {}: 無 .json（可能是二進位 .skel），暫不支援", key));
        return std::ptr::null_mut();
    }
    let json_text = match std::fs::read_to_string(&json_path) {
        Ok(t)=>t, Err(e)=>{ logline(&format!("[build] read json fail: {}", e)); return std::ptr::null_mut(); }
    };
    logline(&format!("[build] atlas {} bytes, first line='{}'; json {} bytes",
        atlas_text.len(), atlas_text.lines().next().unwrap_or(""), json_text.len()));

    // 2) 建每頁 Texture2D
    let pages = atlas_pages(&atlas_text);
    if pages.is_empty() { logline("[build] atlas 無 page"); return std::ptr::null_mut(); }
    let mut textures: Vec<*mut c_void> = Vec::new();
    for page in &pages {
        let png = match std::fs::read(dirp.join(page)) {
            Ok(b)=>b, Err(e)=>{ logline(&format!("[build] read page {} fail: {}", page, e)); return std::ptr::null_mut(); }
        };
        let page_name = page.trim_end_matches(".png"); // texture.name 用去副檔名的 page 名
        let tex = make_texture(domain, &png, page_name);
        if tex.is_null() { logline(&format!("[build] make_texture fail page {}", page)); return std::ptr::null_mut(); }
        textures.push(tex);
    }
    logline(&format!("[build] {} textures built ({} page)", textures.len(), pages.len()));

    // 3) 取原始 material 以複製 shader
    let atlas_arr0 = *((this as *const u8).add(OFF_ATLAS_ASSETS) as *const *mut c_void);
    let mut orig_mat: *mut c_void = std::ptr::null_mut();
    if !atlas_arr0.is_null() {
        let orig_atlas = *((atlas_arr0 as *const u8).add(IL2CPP_ARRAY_DATA) as *const *mut c_void);
        if !orig_atlas.is_null() {
            let sa_cls = class_of(domain, "spine-unity.dll", "Spine.Unity", "SpineAtlasAsset");
            if !sa_cls.is_null() {
                let m_pm = method_by_name(sa_cls, "get_PrimaryMaterial", 0);
                if !m_pm.is_null() { orig_mat = invoke(m_pm, orig_atlas, &mut []); }
            }
        }
    }
    logline(&format!("[build] orig_material={:p}", orig_mat));

    // 4) SpineAtlasAsset.CreateRuntimeInstance(TextAsset, Texture2D[], Material, bool, Func)
    let sa_cls = class_of(domain, "spine-unity.dll", "Spine.Unity", "SpineAtlasAsset");
    if sa_cls.is_null() { return std::ptr::null_mut(); }
    let atlas_ta = make_textasset(domain, &atlas_text);
    if atlas_ta.is_null() { return std::ptr::null_mut(); }
    let tex_cls = class_of(domain, "UnityEngine.CoreModule.dll", "UnityEngine", "Texture2D");
    let tex_arr = make_ref_array(tex_cls, &textures);
    let m_sa_create = method_by_rva(sa_cls, base, RVA_SPINEATLAS_CREATE_TEX_MAT);
    if m_sa_create.is_null() { logline("[build] SpineAtlasAsset.CreateRuntimeInstance by RVA MISS"); return std::ptr::null_mut(); }
    let mut init: bool = true;
    // 參考型別直接傳指標；func（Func<>）傳 null 本身（不是 &null）；bool 傳 &value。
    let mut sa_args = [
        atlas_ta,
        tex_arr,
        orig_mat,
        &mut init as *mut bool as *mut c_void,
        std::ptr::null_mut(),
    ];
    let new_atlas = invoke(m_sa_create, std::ptr::null_mut(), &mut sa_args);
    if new_atlas.is_null() { logline("[build] new SpineAtlasAsset null"); return std::ptr::null_mut(); }
    logline(&format!("[build] new_atlas={:p}", new_atlas));

    // 5) 就地替換原始 asset 的欄位，讓「遊戲自己的 GetSkeletonData」用我們的資料重建。
    //    比自行 CreateRuntimeInstance + 回傳更穩：this->skeletonData 會被原始邏輯填好、保持一致，
    //    不會發生「回傳了 skeletonData 但 this->skeletonData 仍 null」導致後續 null deref。
    let base_cls = class_of(domain, "spine-unity.dll", "Spine.Unity", "AtlasAssetBase");
    let atlas_assets = make_ref_array(base_cls, &[new_atlas]);
    let skel_ta = make_textasset(domain, &json_text);
    if atlas_assets.is_null() || skel_ta.is_null() {
        logline("[build] atlas_array/skel_ta null"); return std::ptr::null_mut();
    }

    // pin 我們建的物件防 GC（Boehm 保守式 GC，欄位直接寫入無需 write barrier）
    gc_new(new_atlas, 0);
    gc_new(atlas_assets, 0);
    gc_new(skel_ta, 0);
    for t in &textures { gc_new(*t, 0); }

    // 寫欄位：atlasAssets / skeletonJSON；清空 skeletonData(0x70) 強制重建
    *((this as *mut u8).add(OFF_ATLAS_ASSETS) as *mut *mut c_void) = atlas_assets;
    *((this as *mut u8).add(OFF_SKELETON_JSON) as *mut *mut c_void) = skel_ta;
    *((this as *mut u8).add(OFF_SKELETON_DATA) as *mut *mut c_void) = std::ptr::null_mut();
    logline(&format!("[build] in-place swap DONE {} (new_atlas={:p} skelTA={:p})", key, new_atlas, skel_ta));
    1 as *mut c_void // 非 null = 成功
}

// ---- hook replacement ----
extern "C" fn repl_get_skeleton_data(this: *mut c_void, quiet: bool) -> *mut c_void {
    unsafe {
        // 讀 skeletonJSON 的 name = 資產名（角色識別）
        let name = if !this.is_null() {
            let skel_json = *((this as *const u8).add(OFF_SKELETON_JSON) as *const *mut c_void);
            unity_object_name(skel_json)
        } else { None };

        // 比對掛載 mod（去副檔名）→ 命中則建構/取用替換 SkeletonData（策略 A）。
        if let Some(n) = name.as_deref() {
            let key = asset_key(n).to_string();
            if let Some(map) = MOD_MAP.get() {
                if let Some(dir) = map.get(&key).cloned() {
                    // 只在第一次命中時就地替換欄位；之後遊戲自身 GetSkeletonData 會回傳
                    // 已重建並快取於 this->skeletonData 的我們的資料，故一律落到下方呼叫 orig。
                    let cached = repl_cache().lock().ok().and_then(|m| m.get(&key).copied());
                    if cached.is_none() {
                        let base = UNITY_BASE.load(Ordering::Acquire);
                        logline(&format!("[MOD MATCH] in-place swap for '{}' <- {}", key, dir));
                        let ok = !build_replacement(this, &key, &dir, base).is_null();
                        if let Ok(mut m) = repl_cache().lock() {
                            m.insert(key.clone(), if ok { 2 } else { 1 });
                        }
                        logline(&format!("[{}] '{}'", if ok { "REPLACED" } else { "BUILD FAILED" }, key));
                    }
                }
            }
        }
        // 未命中或建構失敗 → 呼叫原始函式
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
    // 掃掛載目錄，建立 key→mod 路徑表
    let map = scan_mods();
    let keys: Vec<String> = map.keys().cloned().collect();
    let _ = MOD_MAP.set(map);
    logline(&format!("scanned {} mod(s) from {}: {:?}", keys.len(), MOUNT_DIR, keys));

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
                        UNITY_BASE.store(base, Ordering::Release);
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
