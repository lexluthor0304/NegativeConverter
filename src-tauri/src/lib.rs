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
fn apply_appimage_dmabuf_policy() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        eprintln!(
            "[linux-compat] WEBKIT_DISABLE_DMABUF_RENDERER already set by user; keeping existing value."
        );
        return;
    }

    let dmabuf_override = std::env::var("NEGATIVE_CONVERTER_DMABUF").ok();
    if let Some(raw) = dmabuf_override.as_deref() {
        match parse_bool_flag(raw) {
            Some(true) => {
                eprintln!("[linux-compat] Keeping DMABUF enabled (NEGATIVE_CONVERTER_DMABUF={raw}).");
                return;
            }
            Some(false) => {
                disable_dmabuf_renderer("forced by NEGATIVE_CONVERTER_DMABUF.");
                return;
            }
            None => {
                eprintln!(
                    "[linux-compat] Ignoring NEGATIVE_CONVERTER_DMABUF={raw}; expected on/off/true/false/1/0."
                );
            }
        }
    }

    match probe_dmabuf_support() {
        DmabufProbeResult::Supported(path) => {
            eprintln!("[linux-compat] DMABUF render node is accessible ({path}); keeping DMABUF enabled.");
        }
        DmabufProbeResult::NoRenderNode => {
            disable_dmabuf_renderer("no /dev/dri/renderD* node found.");
        }
        DmabufProbeResult::PermissionDenied(paths) => {
            disable_dmabuf_renderer(&format!(
                "permission denied opening render node(s): {}",
                paths.join(", ")
            ));
        }
        DmabufProbeResult::Unavailable(reason) => {
            disable_dmabuf_renderer(&format!("render node probe failed: {reason}"));
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_appimage_compat_env() {
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }

    eprintln!("[linux-compat] AppImage runtime detected. Applying Linux compatibility guards.");
    apply_appimage_gio_guards();
    apply_appimage_dmabuf_policy();
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
    use super::parse_bool_flag;

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
}
