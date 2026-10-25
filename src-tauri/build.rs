// The native RAW decoder (#264 part C): vendored LibRaw + the C shim.
#[path = "native/build_libraw.rs"]
mod build_libraw;

fn main() {
    build_libraw::build();
    refuse_self_test_fixtures();
    // Capability files are validated against the permissions of every plugin
    // that is compiled in, so the updater capability may only be picked up
    // when the `updater` cargo feature is on. The Mac App Store build
    // (`scripts/build-mas.sh`) compiles with `--no-default-features`.
    // iOS and Android compile no updater plugin (Cargo.toml keeps it desktop
    // only); updater.json names the desktop platforms, mobile.json the mobile
    // ones, and Tauri skips a capability whose `platforms` exclude the target,
    // so both builds can collect every file (#298).
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let mobile = matches!(target_os.as_str(), "ios" | "android");
    let capabilities_pattern: &'static str = if std::env::var_os("CARGO_FEATURE_UPDATER").is_some() || mobile {
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

/// The iOS device self-test (#298) bundles real RAW fixtures from
/// `negative2positive/public/p0-fixtures`, an ignored directory. Vite drops
/// them from `dist` unless `NC_P0_FIXTURES=1` (scripts/p0-fixtures.mjs), but
/// an Xcode archive or a `tauri build` embeds whatever `dist` holds without
/// rebuilding the web assets, so the embed itself refuses a stale copy. The
/// opt-in is `NC_P0_FIXTURES=1` on cargo's environment or the `p0-fixtures`
/// cargo feature: `tauri ios build` runs cargo from an Xcode script phase
/// whose environment the CLI scrubs, so there only `--features p0-fixtures`
/// reaches this script (ios-ci.yml "Store screenshots").
fn refuse_self_test_fixtures() {
    println!("cargo:rerun-if-env-changed=NC_P0_FIXTURES");
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let fixtures = manifest.join("../negative2positive/dist/p0-fixtures");
    println!("cargo:rerun-if-changed={}", fixtures.display());
    let opted_in = std::env::var("NC_P0_FIXTURES").ok().as_deref() == Some("1")
        || std::env::var_os("CARGO_FEATURE_P0_FIXTURES").is_some();
    if fixtures.is_dir() && !opted_in {
        panic!(
            "negative2positive/dist/p0-fixtures would be embedded in the app: run `npm run build:web` to drop the device self-test fixtures, or opt in for a self-test build with NC_P0_FIXTURES=1 or `--features p0-fixtures` (docs/ios-p0-feasibility.md)"
        );
    }
}
