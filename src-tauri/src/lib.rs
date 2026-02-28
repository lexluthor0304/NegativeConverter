use base64::Engine;
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::io::ErrorKind;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct SaveResult {
    saved: bool,
    path: Option<String>,
}

#[tauri::command]
fn save_export_file(suggested_name: String, bytes_base64: String) -> Result<SaveResult, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()
    else {
        return Ok(SaveResult {
            saved: false,
            path: None,
        });
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|err| format!("decode base64 failed: {err}"))?;

    std::fs::write(&path, bytes).map_err(|err| format!("write file failed: {err}"))?;

    Ok(SaveResult {
        saved: true,
        path: Some(path.to_string_lossy().to_string()),
    })
}

#[cfg(any(target_os = "linux", test))]
fn parse_bool_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppImageVariant {
    Standard,
    LegacyCompat,
}

#[cfg(any(target_os = "linux", test))]
fn looks_like_legacy_appimage_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("legacy") && lower.contains("glibc")
}

#[cfg(target_os = "linux")]
fn detect_appimage_variant() -> AppImageVariant {
    if let Some(appimage) = std::env::var("APPIMAGE").ok() {
        if looks_like_legacy_appimage_name(&appimage) {
            return AppImageVariant::LegacyCompat;
        }
    }

    if let Some(argv0) = std::env::args_os().next() {
        if looks_like_legacy_appimage_name(&argv0.to_string_lossy()) {
            return AppImageVariant::LegacyCompat;
        }
    }

    AppImageVariant::Standard
}

#[cfg(target_os = "linux")]
fn appimage_variant_label(variant: AppImageVariant) -> &'static str {
    match variant {
        AppImageVariant::Standard => "standard",
        AppImageVariant::LegacyCompat => "legacy",
    }
}

#[cfg(target_os = "linux")]
fn set_env_if_absent(key: &str, value: &str) -> bool {
    if std::env::var_os(key).is_some() {
        return false;
    }
    std::env::set_var(key, value);
    true
}

#[cfg(target_os = "linux")]
fn ensure_empty_gio_module_dir() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("negative-converter-gio-modules-empty");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Some(dir),
        Err(err) => {
            eprintln!(
                "[linux-compat] Failed to create empty GIO module dir at {}: {err}",
                dir.display()
            );
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_appimage_gio_guards() {
    if set_env_if_absent("GIO_USE_VFS", "local") {
        eprintln!("[linux-compat] Set GIO_USE_VFS=local for AppImage runtime.");
    }

    let Some(empty_dir) = ensure_empty_gio_module_dir() else {
        eprintln!("[linux-compat] Skipping GIO module isolation because helper dir is unavailable.");
        return;
    };

    let dir_value = empty_dir.to_string_lossy().into_owned();
    if set_env_if_absent("GIO_MODULE_DIR", &dir_value) {
        eprintln!(
            "[linux-compat] Set GIO_MODULE_DIR={} to avoid host gvfs ABI conflicts.",
            dir_value
        );
    }
    if set_env_if_absent("GIO_EXTRA_MODULES", &dir_value) {
        eprintln!(
            "[linux-compat] Set GIO_EXTRA_MODULES={} to avoid host gvfs ABI conflicts.",
            dir_value
        );
    }
}

#[cfg(target_os = "linux")]
enum DmabufProbeResult {
    Supported(String),
    NoRenderNode,
    PermissionDenied(Vec<String>),
    Unavailable(String),
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufProbeKind {
    Supported,
    NoRenderNode,
    PermissionDenied,
    Unavailable,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufKeepReason {
    UserPreset,
    OverrideEnabled,
    ProbeSupported,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufDisableReason {
    OverrideDisabled,
    LegacyDefault,
    NoRenderNode,
    PermissionDenied,
    ProbeUnavailable,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufDecision {
    Keep(DmabufKeepReason),
    Disable(DmabufDisableReason),
}

#[cfg(any(target_os = "linux", test))]
fn decide_dmabuf_policy(
    variant: AppImageVariant,
    user_set_webkit_disable: bool,
    override_value: Option<bool>,
    probe_kind: Option<DmabufProbeKind>,
) -> DmabufDecision {
    if user_set_webkit_disable {
        return DmabufDecision::Keep(DmabufKeepReason::UserPreset);
    }

    if let Some(override_value) = override_value {
        return if override_value {
            DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled)
        } else {
            DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled)
        };
    }

    if variant == AppImageVariant::LegacyCompat {
        return DmabufDecision::Disable(DmabufDisableReason::LegacyDefault);
    }

    match probe_kind.unwrap_or(DmabufProbeKind::Unavailable) {
        DmabufProbeKind::Supported => DmabufDecision::Keep(DmabufKeepReason::ProbeSupported),
        DmabufProbeKind::NoRenderNode => DmabufDecision::Disable(DmabufDisableReason::NoRenderNode),
        DmabufProbeKind::PermissionDenied => {
            DmabufDecision::Disable(DmabufDisableReason::PermissionDenied)
        }
        DmabufProbeKind::Unavailable => DmabufDecision::Disable(DmabufDisableReason::ProbeUnavailable),
    }
}

#[cfg(target_os = "linux")]
fn dmabuf_probe_kind(result: &DmabufProbeResult) -> DmabufProbeKind {
    match result {
        DmabufProbeResult::Supported(_) => DmabufProbeKind::Supported,
        DmabufProbeResult::NoRenderNode => DmabufProbeKind::NoRenderNode,
        DmabufProbeResult::PermissionDenied(_) => DmabufProbeKind::PermissionDenied,
        DmabufProbeResult::Unavailable(_) => DmabufProbeKind::Unavailable,
    }
}

#[cfg(target_os = "linux")]
fn probe_dmabuf_support() -> DmabufProbeResult {
    let dri_dir = Path::new("/dev/dri");
    let entries = match std::fs::read_dir(dri_dir) {
        Ok(entries) => entries,
        Err(err) => {
            return if err.kind() == ErrorKind::NotFound {
                DmabufProbeResult::NoRenderNode
            } else {
                DmabufProbeResult::Unavailable(format!(
                    "unable to inspect {}: {err}",
                    dri_dir.display()
                ))
            };
        }
    };

    let mut saw_render_node = false;
    let mut permission_denied = Vec::new();
    let mut other_errors = Vec::new();

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(err) => {
                other_errors.push(format!("failed to inspect /dev/dri entry: {err}"));
                continue;
            }
        };

        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with("renderD") {
            continue;
        }

        saw_render_node = true;
        let path = entry.path();
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(_) => return DmabufProbeResult::Supported(path.display().to_string()),
            Err(err) if err.kind() == ErrorKind::PermissionDenied => {
                permission_denied.push(path.display().to_string());
            }
            Err(err) => {
                other_errors.push(format!("{}: {err}", path.display()));
            }
        }
    }

    if !saw_render_node {
        return DmabufProbeResult::NoRenderNode;
    }
    if !permission_denied.is_empty() && other_errors.is_empty() {
        return DmabufProbeResult::PermissionDenied(permission_denied);
    }
    if !permission_denied.is_empty() {
        return DmabufProbeResult::Unavailable(format!(
            "permission denied on {}; additional errors: {}",
            permission_denied.join(", "),
            other_errors.join("; ")
        ));
    }
    if !other_errors.is_empty() {
        return DmabufProbeResult::Unavailable(other_errors.join("; "));
    }

    DmabufProbeResult::Unavailable("render node probing returned no usable result".into())
}

#[cfg(target_os = "linux")]
fn disable_dmabuf_renderer(reason: &str) {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    eprintln!("[linux-compat] Disabled DMABUF renderer: {reason}");
}

#[cfg(target_os = "linux")]
fn apply_appimage_dmabuf_policy(variant: AppImageVariant) {
    let user_set_webkit_disable = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();
    let dmabuf_override_raw = std::env::var("NEGATIVE_CONVERTER_DMABUF").ok();
    let dmabuf_override = dmabuf_override_raw.as_deref().and_then(parse_bool_flag);

    if dmabuf_override_raw.is_some() && dmabuf_override.is_none() {
        eprintln!(
            "[linux-compat] Ignoring NEGATIVE_CONVERTER_DMABUF={}; expected on/off/true/false/1/0.",
            dmabuf_override_raw.as_deref().unwrap_or_default()
        );
    }

    let probe_result = if !user_set_webkit_disable
        && dmabuf_override.is_none()
        && variant == AppImageVariant::Standard
    {
        Some(probe_dmabuf_support())
    } else {
        None
    };

    let decision = decide_dmabuf_policy(
        variant,
        user_set_webkit_disable,
        dmabuf_override,
        probe_result.as_ref().map(dmabuf_probe_kind),
    );

    match decision {
        DmabufDecision::Keep(DmabufKeepReason::UserPreset) => {
            eprintln!(
                "[linux-compat] WEBKIT_DISABLE_DMABUF_RENDERER already set by user; keeping existing value."
            );
        }
        DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled) => {
            eprintln!("[linux-compat] Keeping DMABUF enabled by NEGATIVE_CONVERTER_DMABUF override.");
        }
        DmabufDecision::Keep(DmabufKeepReason::ProbeSupported) => {
            if let Some(DmabufProbeResult::Supported(path)) = probe_result {
                eprintln!(
                    "[linux-compat] DMABUF render node is accessible ({path}); keeping DMABUF enabled."
                );
            } else {
                eprintln!("[linux-compat] Keeping DMABUF enabled.");
            }
        }
        DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled) => {
            disable_dmabuf_renderer("forced by NEGATIVE_CONVERTER_DMABUF.");
        }
        DmabufDecision::Disable(DmabufDisableReason::LegacyDefault) => {
            disable_dmabuf_renderer(
                "legacy compatibility AppImage defaults DMABUF off for startup stability.",
            );
        }
        DmabufDecision::Disable(DmabufDisableReason::NoRenderNode) => {
            disable_dmabuf_renderer("no /dev/dri/renderD* node found.");
        }
        DmabufDecision::Disable(DmabufDisableReason::PermissionDenied) => {
            if let Some(DmabufProbeResult::PermissionDenied(paths)) = probe_result {
                disable_dmabuf_renderer(&format!(
                    "permission denied opening render node(s): {}",
                    paths.join(", ")
                ));
            } else {
                disable_dmabuf_renderer("permission denied opening /dev/dri/render node.");
            }
        }
        DmabufDecision::Disable(DmabufDisableReason::ProbeUnavailable) => {
            if let Some(DmabufProbeResult::Unavailable(reason)) = probe_result {
                disable_dmabuf_renderer(&format!("render node probe failed: {reason}"));
            } else {
                disable_dmabuf_renderer("render node probe failed.");
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_appimage_compat_env() {
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }

    let variant = detect_appimage_variant();
    eprintln!(
        "[linux-compat] AppImage runtime detected ({}). Applying Linux compatibility guards.",
        appimage_variant_label(variant)
    );
    apply_appimage_gio_guards();
    apply_appimage_dmabuf_policy(variant);
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_appimage_compat_env() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_linux_appimage_compat_env();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_export_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        decide_dmabuf_policy, looks_like_legacy_appimage_name, parse_bool_flag, AppImageVariant,
        DmabufDecision, DmabufDisableReason, DmabufKeepReason, DmabufProbeKind,
    };

    #[test]
    fn parse_bool_flag_accepts_truthy_values() {
        assert_eq!(parse_bool_flag("1"), Some(true));
        assert_eq!(parse_bool_flag("true"), Some(true));
        assert_eq!(parse_bool_flag("ON"), Some(true));
    }

    #[test]
    fn parse_bool_flag_accepts_falsy_values() {
        assert_eq!(parse_bool_flag("0"), Some(false));
        assert_eq!(parse_bool_flag("false"), Some(false));
        assert_eq!(parse_bool_flag("Off"), Some(false));
    }

    #[test]
    fn parse_bool_flag_rejects_unknown_values() {
        assert_eq!(parse_bool_flag("maybe"), None);
        assert_eq!(parse_bool_flag(""), None);
    }

    #[test]
    fn legacy_appimage_name_detection_requires_legacy_and_glibc() {
        assert!(looks_like_legacy_appimage_name(
            "Negative Converter_0.1.4_amd64_legacy-glibc235.AppImage"
        ));
        assert!(looks_like_legacy_appimage_name(
            "/tmp/negative_converter_legacy_glibc_231.appimage"
        ));
        assert!(!looks_like_legacy_appimage_name(
            "Negative Converter_0.1.4_amd64.AppImage"
        ));
        assert!(!looks_like_legacy_appimage_name("legacy-build.AppImage"));
    }

    #[test]
    fn dmabuf_policy_respects_user_preset_first() {
        let decision = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            true,
            Some(false),
            Some(DmabufProbeKind::PermissionDenied),
        );
        assert_eq!(decision, DmabufDecision::Keep(DmabufKeepReason::UserPreset));
    }

    #[test]
    fn dmabuf_policy_allows_override_on_for_legacy_variant() {
        let decision = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            false,
            Some(true),
            Some(DmabufProbeKind::PermissionDenied),
        );
        assert_eq!(
            decision,
            DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled)
        );
    }

    #[test]
    fn dmabuf_policy_disables_legacy_by_default() {
        let decision = decide_dmabuf_policy(AppImageVariant::LegacyCompat, false, None, None);
        assert_eq!(
            decision,
            DmabufDecision::Disable(DmabufDisableReason::LegacyDefault)
        );
    }

    #[test]
    fn dmabuf_policy_uses_probe_for_standard_appimage() {
        let supported = decide_dmabuf_policy(
            AppImageVariant::Standard,
            false,
            None,
            Some(DmabufProbeKind::Supported),
        );
        assert_eq!(supported, DmabufDecision::Keep(DmabufKeepReason::ProbeSupported));

        let no_render = decide_dmabuf_policy(
            AppImageVariant::Standard,
            false,
            None,
            Some(DmabufProbeKind::NoRenderNode),
        );
        assert_eq!(
            no_render,
            DmabufDecision::Disable(DmabufDisableReason::NoRenderNode)
        );

        let denied = decide_dmabuf_policy(
            AppImageVariant::Standard,
            false,
            None,
            Some(DmabufProbeKind::PermissionDenied),
        );
        assert_eq!(
            denied,
            DmabufDecision::Disable(DmabufDisableReason::PermissionDenied)
        );
    }
}
