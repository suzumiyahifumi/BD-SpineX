use std::path::PathBuf;

fn main() {
    // frida-gum devkit（預編譯靜態庫）位於 ../tools/frida-gum（git ignored）。
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let gum_dir = manifest.join("..").join("tools").join("frida-gum");
    let gum_dir = gum_dir.canonicalize().unwrap_or(gum_dir);

    println!("cargo:rustc-link-search=native={}", gum_dir.display());
    println!("cargo:rustc-link-lib=static=frida-gum");
    // frida-gum 在 macOS 的相依
    println!("cargo:rustc-link-lib=dylib=resolv");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=dylib=c++");

    println!("cargo:rerun-if-changed=build.rs");
}
