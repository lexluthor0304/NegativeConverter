use base64::Engine;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
struct SaveResult {
    saved: bool,
    path: Option<String>,
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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

fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("failed to launch browser: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|err| format!("failed to launch browser: {err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("failed to launch browser: {err}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for opening URL".to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.to_ascii_lowercase().starts_with("https://") {
        return Err("only https URLs are allowed".to_string());
    }
    open_url_with_system_browser(trimmed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_linux_appimage_compat_env();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_export_file,
            get_app_version,
            open_external_url
        ])
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
