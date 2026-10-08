fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_manifest_for_all_targets();
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

fn embed_manifest_for_all_targets() {
    let manifest = std::env::current_dir().unwrap().join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
