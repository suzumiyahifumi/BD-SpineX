#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use walkdir::WalkDir;

const BUNDLE_ID: &str = "com.neowizgames.game.browndust2ios";
const SUPPORTED_GAME_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_RELEASES_URL_PREFIX: &str = "https://github.com/suzumiyahifumi/BD-SpineX/releases";
const DISABLED_RUNTIME_MESSAGE: &str =
    "Runtime Injection is kept in the private runtime-injection workspace for release builds.";

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
#[serde(rename_all = "camelCase")]
struct PreviewSpineImage {
    name: String,
    mime: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSpineBundle {
    key: String,
    skeleton_name: String,
    skeleton_type: String,
    skeleton_data: String,
    atlas_name: String,
    atlas_text: String,
    images: Vec<PreviewSpineImage>,
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
    history_paths: Vec<String>,
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

fn mount_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/Containers").join(BUNDLE_ID).join("Data/bd2mods"))
}

fn is_game_running() -> bool {
    Command::new("pgrep").args(["-x", "BrownDustII"]).output().map(|o| o.status.success()).unwrap_or(false)
}

fn key_has_asset_id(key: &str, prefix: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    let Some(rest) = normalized.strip_prefix(prefix) else {
        return false;
    };
    rest.trim_start_matches(|c: char| c == '_' || c == '-' || c == '.' || c.is_ascii_whitespace())
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
}

fn classify_key(key: &str) -> &'static str {
    if key_has_asset_id(key, "cutscene_char") {
        "skillcut"
    } else if key_has_asset_id(key, "illust_dating") {
        "dating"
    } else if key_has_asset_id(key, "char") {
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
        subtitle: "PlayCover Mod Manager".to_string(),
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
fn open_external(url: String) -> Result<bool, String> {
    if !url.starts_with(GITHUB_RELEASES_URL_PREFIX) {
        return Err("Unsupported external URL.".to_string());
    }
    let status = Command::new("open").arg(&url).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(true)
    } else {
        Err(format!("Could not open external URL: {status}"))
    }
}

#[tauri::command]
fn select_directory() -> Option<String> {
    rfd::FileDialog::new().pick_folder().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn runtime_status() -> Result<RuntimeStatus, String> {
    let app_path = app_bundle_path()?;
    let bin = main_binary_path()?;
    let mount = mount_dir()?;
    let _ = fs::create_dir_all(&mount);
    Ok(RuntimeStatus {
        app_found: bin.exists(),
        app_path: app_path.to_string_lossy().to_string(),
        game_running: is_game_running(),
        injected: false,
        loader_available: false,
        loader_path: "private/runtime-injection".to_string(),
        mount_dir: mount.to_string_lossy().to_string(),
        mods_enabled: true,
        mounted_mods: scan_mod_dir(&mount),
    })
}

#[tauri::command]
fn runtime_migration_check() -> LegacyRuntimeMigrationCheck {
    LegacyRuntimeMigrationCheck {
        needed: false,
        mod_names: Vec::new(),
        source_versions: Vec::new(),
        history_paths: Vec::new(),
    }
}

#[tauri::command]
fn runtime_list_library(dir: String) -> Vec<RuntimeMod> {
    scan_mod_dir(Path::new(&dir))
}

fn validate_preview_key(key: &str) -> bool {
    !key.is_empty() && key != "." && key != ".." && !key.contains('/') && !key.contains('\\') && !key.contains("..")
}

fn preview_image_mime(name: &str) -> &'static str {
    match Path::new(name).extension().and_then(OsStr::to_str).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn atlas_page_names(atlas_text: &str) -> Vec<String> {
    let mut pages = Vec::new();
    for raw_line in atlas_text.lines() {
        let line = raw_line.trim();
        let lower = line.to_ascii_lowercase();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !(lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".webp")) {
            continue;
        }
        if !pages.iter().any(|page| page == line) {
            pages.push(line.to_string());
        }
    }
    pages
}

fn resolve_preview_asset(root: &Path, asset_name: &str) -> Option<PathBuf> {
    let normalized = asset_name.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") || Path::new(&normalized).is_absolute() {
        return None;
    }
    Some(root.join(normalized))
}

#[tauri::command]
fn runtime_preview_spine(src_dir: String, key: String) -> Result<PreviewSpineBundle, String> {
    if !validate_preview_key(&key) {
        return Err("Invalid Spine preview key.".to_string());
    }

    let root = PathBuf::from(&src_dir);
    if !root.is_dir() {
        return Err("Preview source folder does not exist.".to_string());
    }

    let atlas_name = format!("{key}.atlas");
    let atlas_path = root.join(&atlas_name);
    let atlas_text = fs::read_to_string(&atlas_path).map_err(|err| format!("Preview atlas not found: {atlas_name} ({err})"))?;

    let json_path = root.join(format!("{key}.json"));
    let skel_path = root.join(format!("{key}.skel"));
    let (skeleton_type, skeleton_path) = if json_path.exists() {
        ("json".to_string(), json_path)
    } else if skel_path.exists() {
        ("skel".to_string(), skel_path)
    } else {
        return Err(format!("Preview skeleton not found: {key}.json / {key}.skel"));
    };

    let mut page_names = atlas_page_names(&atlas_text);
    if page_names.is_empty() {
        let mut files = fs::read_dir(&root)
            .map_err(|err| err.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_ascii_lowercase();
                (entry.file_type().map(|ty| ty.is_file()).unwrap_or(false)
                    && !name.starts_with("._")
                    && (lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".webp")))
                    .then_some(name)
            })
            .collect::<Vec<_>>();
        files.sort_by(|a, b| a.cmp(b));
        page_names = files;
    }

    let mut images = Vec::new();
    let mut used = HashSet::new();
    for page_name in page_names {
        if !used.insert(page_name.clone()) {
            continue;
        }
        let resolved = resolve_preview_asset(&root, &page_name).unwrap_or_else(|| root.join(Path::new(&page_name).file_name().unwrap_or_else(|| OsStr::new(&page_name))));
        let image_path = if resolved.exists() {
            resolved
        } else {
            root.join(Path::new(&page_name).file_name().unwrap_or_else(|| OsStr::new(&page_name)))
        };
        if !image_path.exists() {
            continue;
        }
        let bytes = fs::read(&image_path).map_err(|err| err.to_string())?;
        images.push(PreviewSpineImage {
            name: page_name.clone(),
            mime: preview_image_mime(&page_name).to_string(),
            data: general_purpose::STANDARD.encode(bytes),
        });
    }

    if images.is_empty() {
        return Err("Preview atlas did not resolve any texture pages.".to_string());
    }

    let skeleton_data = fs::read(&skeleton_path).map_err(|err| err.to_string())?;
    Ok(PreviewSpineBundle {
        key,
        skeleton_name: skeleton_path.file_name().and_then(OsStr::to_str).unwrap_or("").to_string(),
        skeleton_type,
        skeleton_data: general_purpose::STANDARD.encode(skeleton_data),
        atlas_name,
        atlas_text,
        images,
    })
}

#[tauri::command]
fn runtime_set_enabled(_enabled: bool) -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn runtime_install() -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn runtime_uninstall() -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn runtime_mount(_src_dir: String, _folder: Option<String>) -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn runtime_unmount(_folder: String) -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn runtime_launch() -> Result<ActionResult, String> {
    Ok(fail(DISABLED_RUNTIME_MESSAGE))
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

fn fail(message: &str) -> ActionResult {
    ActionResult { ok: false, message: message.to_string() }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_default_paths,
            get_app_info,
            detect_game_version,
            open_external,
            select_directory,
            runtime_status,
            runtime_migration_check,
            runtime_list_library,
            runtime_preview_spine,
            runtime_set_enabled,
            runtime_install,
            runtime_uninstall,
            runtime_mount,
            runtime_unmount,
            runtime_launch,
            start_window_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running BD-SpineX");
}
