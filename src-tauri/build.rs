fn main() {
    // Capability files are validated against the permissions of every plugin
    // that is compiled in, so the updater capability may only be picked up
    // when the `updater` cargo feature is on. The Mac App Store build
    // (`scripts/build-mas.sh`) compiles with `--no-default-features`.
    let capabilities_pattern: &'static str = if std::env::var_os("CARGO_FEATURE_UPDATER").is_some() {
        "./capabilities/**/*"
    } else {
        "./capabilities/default.json"
    };
    println!("cargo:rerun-if-changed=capabilities");
    tauri_build::try_build(
        tauri_build::Attributes::new().capabilities_path_pattern(capabilities_pattern),
    )
    .expect("failed to run tauri-build");
}
