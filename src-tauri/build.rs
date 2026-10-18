// The native RAW decoder (#264 part C): vendored LibRaw + the C shim.
#[path = "native/build_libraw.rs"]
mod build_libraw;

fn main() {
    build_libraw::build();
    // Capability files are validated against the permissions of every plugin
    // that is compiled in, so the updater capability may only be picked up
    // when the `updater` cargo feature is on. The Mac App Store build
    // (`scripts/build-mas.sh`) compiles with `--no-default-features`.
    // iOS and Android compile no updater plugin (Cargo.toml keeps it desktop
    // only), so the updater capability stays out of those builds too (#298).
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let mobile = matches!(target_os.as_str(), "ios" | "android");
    let capabilities_pattern: &'static str = if std::env::var_os("CARGO_FEATURE_UPDATER").is_some() && !mobile {
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
