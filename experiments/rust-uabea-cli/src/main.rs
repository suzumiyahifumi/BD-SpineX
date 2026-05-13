use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};
use std::time::Instant;
use unity_asset_binary::bundle::load_bundle;
use unity_asset_core::UnityValue;

const CLASS_ID_TEXTURE_2D: i32 = 28;
const CLASS_ID_TEXT_ASSET: i32 = 49;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mode = read_arg_value(&args, "--mode").unwrap_or_else(|| "patch".to_string());
    let rust_backend =
        read_arg_value(&args, "--rust-backend").unwrap_or_else(|| "uabea".to_string());

    if rust_backend == "native" {
        let code = match run_native(&args, &mode) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        };
        exit(code);
    }

    run_uabea(args, mode);
}

fn run_uabea(args: Vec<String>, mode: String) {
    let dotnet = read_arg_value(&args, "--dotnet-path").unwrap_or_else(default_dotnet_path);
    let project = read_arg_value(&args, "--uabea-project").unwrap_or_else(default_project_path);

    let mut forward: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let key = &args[i];
        if key == "--dotnet-path" || key == "--uabea-project" || key == "--rust-backend" {
            i += 2;
            continue;
        }
        forward.push(args[i].clone());
        i += 1;
    }

    let mut cmd = Command::new(dotnet);
    if mode == "scan" {
        let dll_path = default_dll_path(&project);
        if dll_path.is_file() {
            cmd.arg(dll_path);
            cmd.args(forward);
        } else {
            cmd.arg("run").arg("--project").arg(project).arg("--");
            cmd.args(forward);
        }
    } else {
        cmd.arg("run").arg("--project").arg(project).arg("--");
        cmd.args(forward);
    }

    let status = match cmd.status() {
        Ok(status) => status,
        Err(error) => {
            eprintln!("Failed to launch backend: {error}");
            exit(1);
        }
    };

    exit(status.code().unwrap_or(1));
}

fn run_native(args: &[String], mode: &str) -> Result<()> {
    match mode {
        "scan" => {
            let input = read_arg_value(args, "--input").context("Missing --input")?;
            let result = scan_bundle_native(&input);
            println!("{}", serde_json::to_string_pretty(&result)?);
            if result.ok {
                Ok(())
            } else {
                Err(anyhow::anyhow!(
                    "{}",
                    result
                        .error
                        .unwrap_or_else(|| "Native scan failed".to_string())
                ))
            }
        }
        "patch" => {
            let input = read_arg_value(args, "--input").context("Missing --input")?;
            let job_manifest =
                read_arg_value(args, "--job-manifest").context("Missing --job-manifest")?;
            let result = patch_bundle_native(&input, &job_manifest);
            println!("{}", serde_json::to_string_pretty(&result)?);
            if result.ok {
                Ok(())
            } else {
                Err(anyhow::anyhow!(
                    "{}",
                    result
                        .error
                        .unwrap_or_else(|| "Native Rust patch failed".to_string())
                ))
            }
        }
        "inspect" => {
            let result = InspectResult {
                ok: false,
                error: Some(
                    "Native Rust inspect is not implemented yet; use the UABEA backend."
                        .to_string(),
                ),
                elapsed_ms: 0,
            };
            println!("{}", serde_json::to_string_pretty(&result)?);
            Err(anyhow::anyhow!(
                "Native Rust inspect is not implemented yet"
            ))
        }
        other => Err(anyhow::anyhow!(
            "--mode must be patch, scan, or inspect ({other})"
        )),
    }
}

fn patch_bundle_native(input: &str, job_manifest: &str) -> PatchResult {
    let started = Instant::now();
    let mut timings = Vec::new();

    let patch = (|| -> Result<(Vec<ChangedAsset>, Vec<MissingAsset>)> {
        let manifest_text = std::fs::read_to_string(job_manifest)
            .with_context(|| format!("Failed to read job manifest: {job_manifest}"))?;
        let manifest: PatchManifest =
            serde_json::from_str(&manifest_text).context("Failed to parse job manifest")?;

        let scan_started = Instant::now();
        let scan = scan_bundle_native(input);
        timings.push(TimingEntry {
            name: "scan_bundle".to_string(),
            ms: scan_started.elapsed().as_millis() as u64,
        });
        if !scan.ok {
            return Err(anyhow::anyhow!(
                "{}",
                scan.error
                    .unwrap_or_else(|| "Failed to scan bundle".to_string())
            ));
        }

        let available = scan
            .assets
            .iter()
            .map(|asset| {
                format!(
                    "{}:{}",
                    asset.asset_type.to_lowercase(),
                    asset.name.to_lowercase()
                )
            })
            .collect::<HashSet<_>>();
        let mut changed = Vec::new();
        let mut missing = Vec::new();

        for job in manifest.jobs {
            for atlas in job.atlases.unwrap_or_default() {
                add_native_text_plan(
                    &available,
                    &mut changed,
                    &mut missing,
                    &job.mod_name,
                    &atlas,
                    "replace_atlas",
                );
            }
            for skel in job.skels.unwrap_or_default() {
                add_native_text_plan(
                    &available,
                    &mut changed,
                    &mut missing,
                    &job.mod_name,
                    &skel,
                    "replace_skel",
                );
            }
            for png in job.pngs.unwrap_or_default() {
                add_native_texture_plan(
                    &available,
                    &mut changed,
                    &mut missing,
                    &job.mod_name,
                    &png,
                    "replace_texture",
                );
            }
            for png in job.insert_pngs.unwrap_or_default() {
                changed.push(ChangedAsset {
                    mod_name: job.mod_name.clone(),
                    asset_type: "Texture2D".to_string(),
                    name: file_stem(&png),
                    action: "would_insert_texture".to_string(),
                    source: png,
                    asset_backup: None,
                });
            }
        }

        Ok((changed, missing))
    })();

    timings.push(TimingEntry {
        name: "total".to_string(),
        ms: started.elapsed().as_millis() as u64,
    });

    match patch {
        Ok((changed, missing)) => PatchResult {
            ok: false,
            error: Some(
                "Native Rust patch planner ran, but bundle write/repack is not implemented yet; use UABEA to apply changes.".to_string(),
            ),
            elapsed_ms: started.elapsed().as_millis() as u64,
            timings,
            changed: Some(changed),
            missing: if missing.is_empty() { None } else { Some(missing) },
        },
        Err(error) => PatchResult {
            ok: false,
            error: Some(error.to_string()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            timings,
            changed: None,
            missing: None,
        },
    }
}

fn scan_bundle_native(input: &str) -> ScanResult {
    let started = Instant::now();
    let mut assets = Vec::new();
    let mut skipped = 0;
    let candidate = Regex::new(r"(?i)(?:cutscene_char\d+|char\d+|illust_dating[\w\d_]*)")
        .expect("candidate regex must compile");

    let scan = (|| -> Result<()> {
        let bundle =
            load_bundle(input).with_context(|| format!("Failed to load bundle: {input}"))?;

        for asset_file in &bundle.assets {
            for handle in asset_file.object_handles() {
                let type_name = match handle.class_id() {
                    CLASS_ID_TEXT_ASSET => "TextAsset",
                    CLASS_ID_TEXTURE_2D => "Texture2D",
                    _ => continue,
                };

                let name = match handle.peek_name() {
                    Ok(Some(name)) if candidate.is_match(&name) => name,
                    Ok(_) => continue,
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                };

                let (width, height) = if handle.class_id() == CLASS_ID_TEXTURE_2D {
                    match handle.read() {
                        Ok(object) => (
                            int_field(object.get("m_Width")),
                            int_field(object.get("m_Height")),
                        ),
                        Err(_) => {
                            skipped += 1;
                            (None, None)
                        }
                    }
                } else {
                    (None, None)
                };

                assets.push(ScannedAsset {
                    name,
                    asset_type: type_name.to_string(),
                    path_id: handle.path_id(),
                    width,
                    height,
                });
            }
        }

        assets.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.asset_type.cmp(&b.asset_type))
        });
        Ok(())
    })();

    match scan {
        Ok(()) => ScanResult {
            ok: true,
            error: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            assets,
            skipped,
            timings: Some(vec![TimingEntry {
                name: "total".to_string(),
                ms: started.elapsed().as_millis() as u64,
            }]),
        },
        Err(error) => ScanResult {
            ok: false,
            error: Some(error.to_string()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            assets: Vec::new(),
            skipped,
            timings: Some(vec![TimingEntry {
                name: "total".to_string(),
                ms: started.elapsed().as_millis() as u64,
            }]),
        },
    }
}

fn add_native_text_plan(
    available: &HashSet<String>,
    changed: &mut Vec<ChangedAsset>,
    missing: &mut Vec<MissingAsset>,
    mod_name: &str,
    source: &str,
    action: &str,
) {
    let name = file_name(source);
    if available.contains(&format!("textasset:{}", name.to_lowercase())) {
        changed.push(ChangedAsset {
            mod_name: mod_name.to_string(),
            asset_type: "TextAsset".to_string(),
            name,
            action: format!("would_{action}"),
            source: source.to_string(),
            asset_backup: None,
        });
    } else {
        missing.push(MissingAsset {
            asset_type: "TextAsset".to_string(),
            name,
            source: source.to_string(),
            mod_name: mod_name.to_string(),
        });
    }
}

fn add_native_texture_plan(
    available: &HashSet<String>,
    changed: &mut Vec<ChangedAsset>,
    missing: &mut Vec<MissingAsset>,
    mod_name: &str,
    source: &str,
    action: &str,
) {
    let name = file_stem(source);
    if available.contains(&format!("texture2d:{}", name.to_lowercase())) {
        changed.push(ChangedAsset {
            mod_name: mod_name.to_string(),
            asset_type: "Texture2D".to_string(),
            name,
            action: format!("would_{action}"),
            source: source.to_string(),
            asset_backup: None,
        });
    } else {
        missing.push(MissingAsset {
            asset_type: "Texture2D".to_string(),
            name,
            source: source.to_string(),
            mod_name: mod_name.to_string(),
        });
    }
}

fn file_name(source: &str) -> String {
    Path::new(source)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| source.to_string())
}

fn file_stem(source: &str) -> String {
    Path::new(source)
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| source.to_string())
}

fn int_field(value: Option<&UnityValue>) -> Option<i32> {
    match value {
        Some(UnityValue::Integer(value)) => (*value).try_into().ok(),
        _ => None,
    }
}

fn read_arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1).cloned())
}

fn default_dotnet_path() -> String {
    path_string(["manager-data", "tools", "dotnet", "dotnet"])
}

fn default_project_path() -> String {
    path_string(["experiments", "uabea-patcher", "UabeaPatchPrototype.csproj"])
}

fn default_dll_path(project_path: &str) -> PathBuf {
    let project = Path::new(project_path);
    project
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("bin")
        .join("Debug")
        .join("net8.0")
        .join("UabeaPatchPrototype.dll")
}

fn path_string<const N: usize>(parts: [&str; N]) -> String {
    let mut path = PathBuf::new();
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannedAsset {
    name: String,
    #[serde(rename = "type")]
    asset_type: String,
    path_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    elapsed_ms: u64,
    assets: Vec<ScannedAsset>,
    skipped: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    timings: Option<Vec<TimingEntry>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimingEntry {
    name: String,
    ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchManifest {
    jobs: Vec<PatchJob>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchJob {
    mod_name: String,
    atlases: Option<Vec<String>>,
    skels: Option<Vec<String>>,
    pngs: Option<Vec<String>>,
    insert_pngs: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    elapsed_ms: u64,
    timings: Vec<TimingEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    changed: Option<Vec<ChangedAsset>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<Vec<MissingAsset>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedAsset {
    mod_name: String,
    #[serde(rename = "type")]
    asset_type: String,
    name: String,
    action: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_backup: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MissingAsset {
    #[serde(rename = "type")]
    asset_type: String,
    name: String,
    source: String,
    mod_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    elapsed_ms: u64,
}
