//! bd2loader — BepInEx-for-PlayCover 原生 loader（Phase 3 雛形）
//!
//! 注入方式與 frida-gadget 相同：以 `LC_LOAD_DYLIB` 加進 BrownDustII 主程式，
//! 程序啟動時本 dylib 的 `__mod_init_func` constructor 會被 dyld 呼叫。
//!
//! 本階段目標（只證明「我們的程式碼在遊戲內跑起來且能對話 il2cpp」）：
//!   1. constructor 觸發 → 開背景執行緒（constructor 內不可碰 il2cpp，太早）。
//!   2. 等 `il2cpp_domain_get()` 回非 null（= il2cpp 已初始化）。
//!   3. `il2cpp_thread_attach`，記錄 domain / 版本。
//!   4. 全程寫入 `$HOME/bd2loader.log`（sandbox 下 = 遊戲 container Data 目錄）。
//!
//! 之後 Phase 4 會在此基礎上用 Dobby inline-hook `IL2CPP_TARGETS.md` 的方法。

use std::ffi::{CStr, CString};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::raw::{c_char, c_int, c_void};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOG_NOTICE: c_int = 5;

const RTLD_NOLOAD: c_int = 0x10;

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    // 變參 C 函式；用固定格式 "%s" 呼叫即可。syslog 會進 macOS 統一日誌，
    // 可用 `log stream --predicate 'process=="BrownDustII"'` 擷取，最可靠。
    fn syslog(priority: c_int, format: *const c_char, ...);
    // 列舉已載入 dyld image，用來定位 UnityFramework 的實際路徑。
    fn _dyld_image_count() -> u32;
    fn _dyld_get_image_name(index: u32) -> *const c_char;
}

/// 取得 UnityFramework 的 dlopen handle。
/// 遊戲以 RTLD_LOCAL 載入 UnityFramework，故 dlsym(RTLD_DEFAULT,…) 找不到 il2cpp_*，
/// 必須先用 image 路徑 + RTLD_NOLOAD 取得該框架 handle，再對 handle dlsym。
unsafe fn unity_handle() -> *mut c_void {
    let n = _dyld_image_count();
    for i in 0..n {
        let name_ptr = _dyld_get_image_name(i);
        if name_ptr.is_null() {
            continue;
        }
        let name = CStr::from_ptr(name_ptr).to_string_lossy();
        if name.ends_with("/UnityFramework") || name.contains("UnityFramework.framework/UnityFramework") {
            // RTLD_NOLOAD：只在已載入時回傳 handle，不會重新載入。
            return dlopen(name_ptr, RTLD_NOLOAD);
        }
    }
    std::ptr::null_mut()
}

type FnDomainGet = unsafe extern "C" fn() -> *mut c_void;
type FnThreadAttach = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type FnGetVersion = unsafe extern "C" fn() -> *const c_char;

/// 候選 log 檔路徑（哪個可寫就寫哪個；sandbox 下不一定每個都成功）。
/// 註：constructor 在 dyld 早期執行時 `$HOME` 可能尚未設定，故第一順位用硬編的
/// 遊戲 container Data 絕對路徑（開發期方便診斷；正式版會改成從 bundle 推導）。
const HARDCODED_LOG: &str =
    "/Users/suzumiyahifumi/Library/Containers/com.neowizgames.game.browndust2ios/Data/bd2loader.log";

fn log_paths() -> Vec<String> {
    let mut v = vec![HARDCODED_LOG.to_string()];
    if let Ok(home) = std::env::var("HOME") {
        v.push(format!("{}/bd2loader.log", home));
    }
    if let Ok(tmp) = std::env::var("TMPDIR") {
        v.push(format!("{}/bd2loader.log", tmp));
    }
    v.push("/tmp/bd2loader.log".to_string());
    v
}

fn logline(msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}", ts, msg);

    // 1) syslog（統一日誌，最可靠）
    if let Ok(c) = CString::new(format!("BD2LOADER: {}", line)) {
        let fmt = CString::new("%s").unwrap();
        unsafe { syslog(LOG_NOTICE, fmt.as_ptr(), c.as_ptr()) };
    }
    // 2) 檔案（哪個路徑可寫就寫）
    for p in log_paths() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{}", line);
            break;
        }
    }
}

/// 對指定 handle dlsym 一個 il2cpp 導出並轉成函式指標型別 T。
unsafe fn resolve<T: Copy>(handle: *mut c_void, name: &str) -> Option<T> {
    let c = CString::new(name).ok()?;
    let p = dlsym(handle, c.as_ptr());
    if p.is_null() {
        None
    } else {
        // p 與 fn-ptr 同寬（8 bytes），用 transmute_copy 繞過泛型大小檢查。
        Some(std::mem::transmute_copy::<*mut c_void, T>(&p))
    }
}

fn worker() {
    logline("loader thread start; waiting for UnityFramework + il2cpp...");
    let mut waited_ms: u64 = 0;
    loop {
        unsafe {
            let uf = unity_handle();
            if !uf.is_null() {
                if let Some(domain_get) = resolve::<FnDomainGet>(uf, "il2cpp_domain_get") {
                    let domain = domain_get();
                    if !domain.is_null() {
                        logline(&format!("il2cpp ready: UnityFramework handle={:p} domain={:p}", uf, domain));

                        if let Some(attach) = resolve::<FnThreadAttach>(uf, "il2cpp_thread_attach") {
                            let t = attach(domain);
                            logline(&format!("il2cpp_thread_attach -> {:p}", t));
                        }
                        if let Some(getver) = resolve::<FnGetVersion>(uf, "il2cpp_get_version") {
                            let v = getver();
                            if !v.is_null() {
                                let s = CStr::from_ptr(v).to_string_lossy().into_owned();
                                logline(&format!("il2cpp version: {}", s));
                            }
                        }
                        logline("HELLO FROM INSIDE BrownDust II (bd2loader) — Phase 3 OK");
                        return;
                    }
                }
            }
        }
        // 前幾次與每 5 秒記錄一次進度，便於診斷。
        if waited_ms < 2000 || waited_ms % 5000 == 0 {
            unsafe {
                let uf = unity_handle();
                logline(&format!("…waiting t={}ms UnityFramework_handle={:p}", waited_ms, uf));
            }
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
    // ⚠️ 重要：constructor 在 dyld 初始化期間執行，主執行緒此時持有 dyld lock。
    // 絕對不要在這裡（或剛 spawn 就立刻）呼叫 dlopen/dlsym/_dyld_*，否則會與主執行緒
    // 搶 dyld lock、拖垮 app 啟動（實測會讓遊戲卡在 UnityFramework 載入前並退出）。
    // 這裡只記一行（純檔案 I/O + syslog，不碰 dyld）並開背景執行緒。
    logline("=== bd2loader constructor invoked (deferring dyld work) ===");
    std::thread::Builder::new()
        .name("bd2loader".into())
        .spawn(|| {
            // 先讓 dyld 初始化器全部跑完、app 進入主迴圈，再開始碰 dyld API。
            std::thread::sleep(Duration::from_secs(5));
            worker();
        })
        .ok();
}

/// 把 `ctor` 註冊進 Mach-O 的 __mod_init_func，dyld 載入時會呼叫（等同 __attribute__((constructor))）。
#[link_section = "__DATA,__mod_init_func"]
#[used]
static CTOR: extern "C" fn() = ctor;
