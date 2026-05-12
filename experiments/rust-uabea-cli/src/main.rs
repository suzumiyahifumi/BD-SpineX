use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, exit};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mode = read_arg_value(&args, "--mode").unwrap_or_else(|| "patch".to_string());
    let dotnet = read_arg_value(&args, "--dotnet-path").unwrap_or_else(default_dotnet_path);
    let project = read_arg_value(&args, "--uabea-project").unwrap_or_else(default_project_path);

    let mut forward: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let key = &args[i];
        if key == "--dotnet-path" || key == "--uabea-project" {
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
