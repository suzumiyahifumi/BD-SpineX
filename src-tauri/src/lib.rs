#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Utc;
use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const BUNDLE_ID: &str = "com.neowizgames.game.browndust2ios";
const LOADER_DYLIB: &str = "libbd2loader.dylib";
const LOADER_LOAD_NAME: &str = "@executable_path/Frameworks/libbd2loader.dylib";
const DISABLED_MARKER: &str = ".bdspinex-disabled";
const SUPPORTED_GAME_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    subtitle: String,
    version: String,
    supported_game_version: String,
    development: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameVersionInfo {
    version: Option<String>,
    source_path: Option<String>,
    detected_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMod {
    folder: String,
    key: String,
    #[serde(rename = "type")]
    mod_type: String,
    skeleton: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    app_found: bool,
    app_path: String,
    game_running: bool,
    injected: bool,
    loader_available: bool,
    loader_path: String,
    mount_dir: String,
    mods_enabled: bool,
    mounted_mods: Vec<RuntimeMod>,
}

#[derive(Serialize)]
struct ActionResult {
    ok: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRuntimeMigrationCheck {
    needed: bool,
    mod_names: Vec<String>,
    source_versions: Vec<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not resolve HOME.".to_string())
}

fn app_bundle_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/Containers/io.playcover.PlayCover/Applications").join(format!("{BUNDLE_ID}.app")))
}

fn main_binary_path() -> Result<PathBuf, String> {
    Ok(app_bundle_path()?.join("BrownDustII"))
}

fn frameworks_dir() -> Result<PathBuf, String> {
    Ok(app_bundle_path()?.join("Frameworks"))
}

fn backup_root() -> Result<PathBuf, String> {
    Ok(app_bundle_path()?.parent().unwrap_or(Path::new(".")).join(format!("{BUNDLE_ID}.app.BAK-mainbin")))
}

fn backup_binary_path() -> Result<PathBuf, String> {
    Ok(backup_root()?.join("BrownDustII"))
}

fn entitlements_cache_path() -> Result<PathBuf, String> {
    Ok(backup_root()?.join("bd2.entitlements.plist"))
}

fn mount_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/Containers").join(BUNDLE_ID).join("Data/bd2mods"))
}

fn disabled_marker_path() -> Result<PathBuf, String> {
    Ok(mount_dir()?.join(DISABLED_MARKER))
}

fn resource_candidate(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    for candidate in [
        resource_dir.join(relative),
        resource_dir.join("_up_").join(relative),
    ] {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let file_name = Path::new(relative).file_name()?;
    let flat = resource_dir.join(file_name);
    flat.exists().then_some(flat)
}

fn loader_source_path(app: &AppHandle) -> PathBuf {
    resource_candidate(app, "dist-native/bd2loader/libbd2loader.dylib")
        .or_else(|| resource_candidate(app, "native/bd2loader/target/aarch64-apple-darwin/release/libbd2loader.dylib"))
        .unwrap_or_else(|| PathBuf::from("dist-native/bd2loader/libbd2loader.dylib"))
}

fn converter_path(app: &AppHandle) -> PathBuf {
    resource_candidate(app, "manager-data/tools/SpineSkeletonDataConverter")
        .unwrap_or_else(|| PathBuf::from("manager-data/tools/SpineSkeletonDataConverter"))
}

fn is_game_running() -> bool {
    Command::new("pgrep").args(["-x", "BrownDustII"]).output().map(|o| o.status.success()).unwrap_or(false)
}

fn run_command(program: &str, args: &[&OsStr]) -> Result<String, String> {
    let output = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn classify_key(key: &str) -> &'static str {
    if key.starts_with("cutscene_char") {
        "skillcut"
    } else if key.starts_with("illust_dating") {
        "dating"
    } else if key.starts_with("char") && key[4..].chars().all(|c| c.is_ascii_digit()) {
        "standing"
    } else {
        "other"
    }
}

fn scan_mod_dir(root: &Path) -> Vec<RuntimeMod> {
    if !root.exists() {
        return Vec::new();
    }

    let mut mods = Vec::new();
    for entry in WalkDir::new(root).min_depth(1).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') || name == "__MACOSX" {
            continue;
        }
        let dir = entry.path();
        let files = match fs::read_dir(dir) {
            Ok(files) => files.filter_map(Result::ok).filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).collect::<Vec<_>>(),
            Err(_) => continue,
        };
        let Some(atlas) = files.iter().find_map(|f| {
            let name = f.file_name().to_string_lossy().to_string();
            (name.ends_with(".atlas") && !name.starts_with("._")).then_some(name)
        }) else {
            continue;
        };
        let key = atlas.trim_end_matches(".atlas").to_string();
        let names: HashSet<String> = files.iter().map(|f| f.file_name().to_string_lossy().to_string()).collect();
        let skeleton = if names.contains(&format!("{key}.json")) {
            "json"
        } else if names.contains(&format!("{key}.skel")) {
            "skel"
        } else {
            "unknown"
        };
        let folder = dir.strip_prefix(root).unwrap_or(dir).to_string_lossy().replace('\\', "/");
        mods.push(RuntimeMod {
            folder,
            key: key.clone(),
            mod_type: classify_key(&key).to_string(),
            skeleton: skeleton.to_string(),
            path: dir.to_string_lossy().to_string(),
        });
    }
    mods.sort_by(|a, b| a.folder.cmp(&b.folder));
    mods
}

fn safe_relative_folder(folder: &str) -> Option<String> {
    let normalized = folder.replace('\\', "/").trim_matches('/').to_string();
    if normalized.is_empty() || normalized == "." || normalized == ".." || normalized.starts_with("../") || Path::new(&normalized).is_absolute() {
        None
    } else {
        Some(normalized)
    }
}

fn safe_mount_path(folder: &str) -> Option<PathBuf> {
    safe_relative_folder(folder).and_then(|f| mount_dir().ok().map(|m| m.join(f)))
}

#[tauri::command]
fn get_default_paths() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "modsDir": env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("mods").to_string_lossy(),
        "sharedDir": "",
        "dotnetPath": ""
    }))
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        name: "BD-SpineX".to_string(),
        subtitle: "Runtime Mod Manager".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        supported_game_version: SUPPORTED_GAME_VERSION.to_string(),
        development: cfg!(debug_assertions),
    }
}

#[tauri::command]
fn detect_game_version() -> GameVersionInfo {
    let info_path = app_bundle_path().ok().map(|p| p.join("Info.plist"));
    let version = info_path.as_ref().and_then(|p| {
        let output = Command::new("plutil").args(["-extract", "CFBundleShortVersionString", "raw", p.to_string_lossy().as_ref()]).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    });
    GameVersionInfo {
        version,
        source_path: info_path.map(|p| p.to_string_lossy().to_string()),
        detected_at: Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
fn select_directory() -> Option<String> {
    rfd::FileDialog::new().pick_folder().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    let app_path = app_bundle_path()?;
    let bin = main_binary_path()?;
    let loader = loader_source_path(&app);
    let mount = mount_dir()?;
    let _ = fs::create_dir_all(&mount);
    let injected = bin.exists() && has_load_dylib(&bin, LOADER_LOAD_NAME).unwrap_or(false);
    Ok(RuntimeStatus {
        app_found: bin.exists(),
        app_path: app_path.to_string_lossy().to_string(),
        game_running: is_game_running(),
        injected,
        loader_available: loader.exists(),
        loader_path: loader.to_string_lossy().to_string(),
        mount_dir: mount.to_string_lossy().to_string(),
        mods_enabled: !disabled_marker_path()?.exists(),
        mounted_mods: scan_mod_dir(&mount),
    })
}

#[tauri::command]
fn runtime_migration_check() -> LegacyRuntimeMigrationCheck {
    LegacyRuntimeMigrationCheck {
        needed: false,
        mod_names: Vec::new(),
        source_versions: Vec::new(),
    }
}

#[tauri::command]
fn runtime_list_library(dir: String) -> Vec<RuntimeMod> {
    scan_mod_dir(Path::new(&dir))
}

#[tauri::command]
fn runtime_set_enabled(enabled: bool) -> Result<ActionResult, String> {
    fs::create_dir_all(mount_dir()?).map_err(|e| e.to_string())?;
    let marker = disabled_marker_path()?;
    if enabled {
        let _ = fs::remove_file(marker);
        Ok(ok("Mod Power restored. Restart the game to load mounted mods."))
    } else {
        fs::write(marker, "BD-SpineX runtime mods disabled\n").map_err(|e| e.to_string())?;
        Ok(ok("Mod Power turned off. Restart the game to run without mounted mods."))
    }
}

#[tauri::command]
fn runtime_install(app: AppHandle) -> Result<ActionResult, String> {
    let bin = main_binary_path()?;
    if !bin.exists() {
        return Ok(fail("Could not find BrownDustII. Is the PlayCover app installed?"));
    }
    if is_game_running() {
        return Ok(fail("Close BrownDust II before installing Runtime Injection."));
    }
    let src = loader_source_path(&app);
    if !src.exists() {
        return Ok(fail(&format!("Runtime loader dylib was not found: {}", src.to_string_lossy())));
    }

    let bak = backup_binary_path()?;
    let ent = entitlements_cache_path()?;
    fs::create_dir_all(bak.parent().unwrap()).map_err(|e| e.to_string())?;
    let already_injected = has_load_dylib(&bin, LOADER_LOAD_NAME).unwrap_or(false);
    if !already_injected {
        fs::copy(&bin, &bak).map_err(|e| e.to_string())?;
        let entitlements = run_command("codesign", &[OsStr::new("-d"), OsStr::new("--entitlements"), OsStr::new("-"), OsStr::new("--xml"), bin.as_os_str()])?;
        fs::write(&ent, entitlements).map_err(|e| e.to_string())?;
    } else if bak.exists() {
        fs::copy(&bak, &bin).map_err(|e| e.to_string())?;
        if !ent.exists() {
            let entitlements = run_command("codesign", &[OsStr::new("-d"), OsStr::new("--entitlements"), OsStr::new("-"), OsStr::new("--xml"), bin.as_os_str()])?;
            fs::write(&ent, entitlements).map_err(|e| e.to_string())?;
        }
    } else {
        return Ok(fail("Injection is installed, but the clean backup is missing. Reinstall the game in PlayCover before trying again."));
    }

    let dst = frameworks_dir()?.join(LOADER_DYLIB);
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    run_command("codesign", &[OsStr::new("-f"), OsStr::new("-s"), OsStr::new("-"), dst.as_os_str()])?;

    if let Err(reason) = add_load_dylib(&bin, LOADER_LOAD_NAME) {
        return Ok(fail(&format!("Injection failed: {reason}")));
    }
    run_command("codesign", &[OsStr::new("-f"), OsStr::new("-s"), OsStr::new("-"), OsStr::new("--entitlements"), ent.as_os_str(), bin.as_os_str()])?;
    run_command("codesign", &[OsStr::new("-v"), bin.as_os_str()])?;
    Ok(ok("Runtime loader installed. It will take effect the next time the game starts."))
}

#[tauri::command]
fn runtime_uninstall() -> Result<ActionResult, String> {
    let bin = main_binary_path()?;
    let bak = backup_binary_path()?;
    if !bin.exists() {
        return Ok(fail("Could not find BrownDustII."));
    }
    if is_game_running() {
        return Ok(fail("Close BrownDust II before removing Runtime Injection."));
    }
    if !has_load_dylib(&bin, LOADER_LOAD_NAME).unwrap_or(false) {
        return Ok(ok("Injection is not installed. Nothing to restore."));
    }
    if !bak.exists() {
        return Ok(fail("Clean backup is missing. Cannot restore the original executable."));
    }
    fs::copy(&bak, &bin).map_err(|e| e.to_string())?;
    Ok(ok("Runtime loader removed. Original executable restored."))
}

#[tauri::command]
fn runtime_mount(app: AppHandle, src_dir: String, folder: Option<String>) -> Result<ActionResult, String> {
    let src = PathBuf::from(&src_dir);
    if !src.exists() {
        return Ok(fail("Source folder does not exist."));
    }
    let folder = safe_relative_folder(folder.as_deref().unwrap_or_else(|| src.file_name().and_then(OsStr::to_str).unwrap_or("")))
        .ok_or_else(|| "Invalid mod folder name.".to_string())?;
    let dest = safe_mount_path(&folder).ok_or_else(|| "Invalid mod folder name.".to_string())?;
    fs::create_dir_all(mount_dir()?).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    let mut linked = 0;
    let mut copied = 0;
    for entry in fs::read_dir(&src).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("._") {
            continue;
        }
        let dst = dest.join(&name);
        if fs::hard_link(entry.path(), &dst).is_ok() {
            linked += 1;
        } else {
            fs::copy(entry.path(), &dst).map_err(|e| e.to_string())?;
            copied += 1;
        }
    }

    let mut converted_note = String::new();
    let atlas_key = fs::read_dir(&dest).ok().and_then(|files| {
        files.filter_map(Result::ok).find_map(|f| {
            let name = f.file_name().to_string_lossy().to_string();
            (name.ends_with(".atlas") && !name.starts_with("._")).then(|| name.trim_end_matches(".atlas").to_string())
        })
    });
    if let Some(key) = atlas_key {
        let json = dest.join(format!("{key}.json"));
        let skel = dest.join(format!("{key}.skel"));
        if !json.exists() && skel.exists() {
            let converter = converter_path(&app);
            match Command::new(&converter).args([skel.as_os_str(), json.as_os_str()]).output() {
                Ok(output) if output.status.success() => converted_note = " (.skel was converted to .json)".to_string(),
                Ok(output) => converted_note = format!(" (.skel to .json conversion failed: {})", String::from_utf8_lossy(&output.stderr).trim()),
                Err(err) => converted_note = format!(" (.skel to .json conversion failed: {err})"),
            }
        }
    }

    Ok(ok(&format!("Mounted {folder} (hardlink {linked} / copied {copied}){converted_note}")))
}

#[tauri::command]
fn runtime_unmount(folder: String) -> Result<ActionResult, String> {
    let dest = safe_mount_path(&folder).ok_or_else(|| "Invalid mod folder name.".to_string())?;
    let _ = fs::remove_dir_all(dest);
    Ok(ok(&format!("Unmounted {folder}")))
}

#[tauri::command]
fn runtime_launch() -> Result<ActionResult, String> {
    let app_path = app_bundle_path()?;
    if !app_path.exists() {
        return Ok(fail("Could not find the game app."));
    }
    let output = Command::new("open").arg(app_path).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(ok("Game launched."))
    } else {
        Ok(fail(String::from_utf8_lossy(&output.stderr).trim()))
    }
}

fn ok(message: &str) -> ActionResult {
    ActionResult { ok: true, message: message.to_string() }
}

fn fail(message: &str) -> ActionResult {
    ActionResult { ok: false, message: message.to_string() }
}

const MH_MAGIC_64: u32 = 0xfeedfacf;
const LC_LOAD_DYLIB: u32 = 0x0c;
const LC_SEGMENT_64: u32 = 0x19;
const HEADER_SIZE: usize = 32;
const DYLIB_CMD_HEADER: usize = 24;

fn read_u32(buf: &[u8], off: usize) -> Result<u32, String> {
    let bytes: [u8; 4] = buf.get(off..off + 4).ok_or_else(|| "Mach-O header is truncated.".to_string())?.try_into().unwrap();
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(buf: &[u8], off: usize) -> Result<u64, String> {
    let bytes: [u8; 8] = buf.get(off..off + 8).ok_or_else(|| "Mach-O section is truncated.".to_string())?.try_into().unwrap();
    Ok(u64::from_le_bytes(bytes))
}

fn write_u32(buf: &mut [u8], off: usize, value: u32) {
    buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
}

fn align8(n: usize) -> usize {
    (n + 7) & !7
}

fn has_load_dylib(file_path: &Path, dylib_name: &str) -> Result<bool, String> {
    let mut buf = Vec::new();
    fs::File::open(file_path).map_err(|e| e.to_string())?.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    find_load_dylib(&buf, dylib_name)
}

fn find_load_dylib(buf: &[u8], dylib_name: &str) -> Result<bool, String> {
    if read_u32(buf, 0)? != MH_MAGIC_64 {
        return Ok(false);
    }
    let ncmds = read_u32(buf, 16)? as usize;
    let mut off = HEADER_SIZE;
    for _ in 0..ncmds {
        let cmd = read_u32(buf, off)?;
        let cmdsize = read_u32(buf, off + 4)? as usize;
        if cmd == LC_LOAD_DYLIB {
            let name_off = read_u32(buf, off + 8)? as usize;
            let start = off + name_off;
            let end = buf[start..off + cmdsize].iter().position(|b| *b == 0).map(|i| start + i).unwrap_or(off + cmdsize);
            if std::str::from_utf8(&buf[start..end]).unwrap_or("") == dylib_name {
                return Ok(true);
            }
        }
        off += cmdsize;
    }
    Ok(false)
}

fn add_load_dylib(file_path: &Path, dylib_name: &str) -> Result<(), String> {
    let mut buf = Vec::new();
    fs::File::open(file_path).map_err(|e| e.to_string())?.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if read_u32(&buf, 0)? != MH_MAGIC_64 {
        return Err("Not a thin 64-bit Mach-O executable.".to_string());
    }
    if find_load_dylib(&buf, dylib_name)? {
        return Ok(());
    }

    let ncmds = read_u32(&buf, 16)? as usize;
    let sizeofcmds = read_u32(&buf, 20)? as usize;
    let load_end = HEADER_SIZE + sizeofcmds;
    let mut lowest_section_offset = usize::MAX;
    let mut off = HEADER_SIZE;
    for _ in 0..ncmds {
        let cmd = read_u32(&buf, off)?;
        let cmdsize = read_u32(&buf, off + 4)? as usize;
        if cmd == LC_SEGMENT_64 {
            let nsects = read_u32(&buf, off + 64)? as usize;
            let mut sec = off + 72;
            for _ in 0..nsects {
                let sec_size = read_u64(&buf, sec + 40)?;
                let sec_offset = read_u32(&buf, sec + 48)? as usize;
                if sec_size > 0 && sec_offset > 0 && sec_offset < lowest_section_offset {
                    lowest_section_offset = sec_offset;
                }
                sec += 80;
            }
        }
        off += cmdsize;
    }

    let name_bytes = dylib_name.as_bytes();
    let new_cmd_size = align8(DYLIB_CMD_HEADER + name_bytes.len() + 1);
    let free_space = lowest_section_offset.saturating_sub(load_end);
    if free_space < new_cmd_size {
        return Err(format!("load command padding is insufficient (needs {new_cmd_size}, has {free_space})."));
    }

    let mut cmd = vec![0u8; new_cmd_size];
    write_u32(&mut cmd, 0, LC_LOAD_DYLIB);
    write_u32(&mut cmd, 4, new_cmd_size as u32);
    write_u32(&mut cmd, 8, DYLIB_CMD_HEADER as u32);
    write_u32(&mut cmd, 12, 2);
    write_u32(&mut cmd, 16, 0x10000);
    write_u32(&mut cmd, 20, 0x10000);
    cmd[DYLIB_CMD_HEADER..DYLIB_CMD_HEADER + name_bytes.len()].copy_from_slice(name_bytes);

    buf[load_end..load_end + new_cmd_size].copy_from_slice(&cmd);
    write_u32(&mut buf, 16, (ncmds + 1) as u32);
    write_u32(&mut buf, 20, (sizeofcmds + new_cmd_size) as u32);
    fs::File::create(file_path).map_err(|e| e.to_string())?.write_all(&buf).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_default_paths,
            get_app_info,
            detect_game_version,
            select_directory,
            runtime_status,
            runtime_migration_check,
            runtime_list_library,
            runtime_set_enabled,
            runtime_install,
            runtime_uninstall,
            runtime_mount,
            runtime_unmount,
            runtime_launch
        ])
        .run(tauri::generate_context!())
        .expect("error while running BD-SpineX");
}
