use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
#[cfg(target_os = "linux")]
use std::io::ErrorKind;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::State;
mod export_stream;
mod import_folder;
mod memory_info;
use memory_info::get_memory_info;
use import_folder::{ImportWatch, watch_import_folder, stop_watch_import_folder, read_import_file};
use export_stream::ExportStreams;

#[derive(Serialize)]
struct SaveResult {
    saved: bool,
    path: Option<String>,
}

/// Destinations the user picked in a native file dialog during this run.
///
/// The webview asks the backend to write bytes to a path it was handed
/// earlier; without this list any script running in the webview could name an
/// arbitrary path (`~/.zshrc`, a LaunchAgent plist) and have the backend
/// write it. Granting only what the user chose in the powerbox also matches
/// what the macOS App Store sandbox actually permits.
#[derive(Default)]
struct ExportGrants {
    files: Mutex<HashSet<PathBuf>>,
    directories: Mutex<HashSet<PathBuf>>,
}

impl ExportGrants {
    fn grant_file(&self, path: &Path) {
        if let Ok(mut files) = self.files.lock() {
            files.insert(grant_key(path));
        }
    }

    fn grant_directory(&self, path: &Path) {
        if let Ok(mut directories) = self.directories.lock() {
            directories.insert(grant_key(path));
        }
    }

    fn allows_file(&self, path: &Path) -> bool {
        let key = grant_key(path);
        self.files
            .lock()
            .map(|files| files.contains(&key))
            .unwrap_or(false)
    }

    fn allows_directory(&self, path: &Path) -> bool {
        let key = grant_key(path);
        self.directories
            .lock()
            .map(|directories| directories.contains(&key))
            .unwrap_or(false)
    }
}

/// A comparable form of a path: the file name kept as-is (the target may not
/// exist yet) on top of the canonicalized parent, so `/a/./b/x.png` and
/// `/a/b/x.png` are recognised as the same grant.
fn grant_key(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => match parent.canonicalize() {
            Ok(canonical_parent) => canonical_parent.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

fn normalize_export_path(mut path: PathBuf, suggested_name: &str) -> PathBuf {
    let suggested_extension = std::path::Path::new(suggested_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty());

    if path.extension().is_none() {
        if let Some(extension) = suggested_extension {
            path.set_extension(extension);
        }
    }

    path
}

/// Reduces a name proposed by the webview to a single file name, so it can
/// never walk out of the directory the user picked.
fn sanitize_export_file_name(suggested_name: &str) -> String {
    let candidate = Path::new(suggested_name.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("converted_negative");

    // `Path::file_name` already strips `..` and the platform's own separator,
    // but a Unix file name may legally contain `\` and `:`, which are
    // separators elsewhere. Neutralise them so the same name is contained on
    // every platform.
    let sanitized = candidate.replace(['/', '\\', ':'], "_");
    if sanitized.is_empty() {
        return "converted_negative".to_string();
    }
    sanitized
}

fn decode_export_bytes(bytes_base64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|err| format!("decode base64 failed: {err}"))
}

fn temp_export_path(parent: &Path, final_path: &Path, attempt: u32) -> PathBuf {
    let name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    parent.join(format!(".{name}.{unique}-{attempt}.part"))
}

/// Writes to a sibling temporary file and renames it onto the target, so a
/// failure part-way through leaves the previous file (or nothing) rather than
/// a truncated export that the batch exporter would treat as finished.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "export path has no parent directory".to_string())?;

    let mut last_error = "could not create a temporary file".to_string();
    for attempt in 0..4 {
        let temp_path = temp_export_path(parent, path, attempt);
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = format!("create temporary file failed: {err}");
                continue;
            }
            Err(err) => {
                // Anything else (most likely a sandbox denial on the chosen
                // file's directory) will not improve with another name.
                return Err(format!("create temporary file failed: {err}"));
            }
        };

        let written = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(err) = written {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("write file failed: {err}"));
        }

        if let Err(err) = std::fs::rename(&temp_path, path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("rename temporary file failed: {err}"));
        }

        return Ok(());
    }

    Err(last_error)
}

/// Fallback for destinations where a sibling temporary file cannot be created
/// — most importantly the macOS App Store sandbox, where the save panel grants
/// access to the chosen file and not to its directory. A failed write deletes
/// the half-written file instead of leaving it behind.
fn write_directly(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path).map_err(|err| format!("write file failed: {err}"))?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(err) = written {
        let _ = std::fs::remove_file(path);
        return Err(format!("write file failed: {err}"));
    }
    Ok(())
}

fn write_export_bytes(path: &Path, bytes: &[u8]) -> Result<SaveResult, String> {
    if let Err(atomic_error) = write_atomically(path, bytes) {
        eprintln!("[export] atomic write unavailable ({atomic_error}); writing in place.");
        write_directly(path, bytes)?;
    }

    Ok(SaveResult {
        saved: true,
        path: Some(path.to_string_lossy().to_string()),
    })
}

/// Decodes and writes off the UI thread: a 16-bit TIFF of a 48 MP scan is a
/// few hundred megabytes, and doing that on the native main thread freezes the
/// window for the duration.
async fn write_export_bytes_off_thread(
    path: PathBuf,
    bytes_base64: String,
) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_export_bytes(&bytes_base64)?;
        write_export_bytes(&path, &bytes)
    })
    .await
    .map_err(|err| format!("export task failed: {err}"))?
}

fn build_unique_export_path(directory: &Path, suggested_name: &str) -> PathBuf {
    let base_name = sanitize_export_file_name(suggested_name);
    let base_path = normalize_export_path(directory.join(&base_name), &base_name);
    if !base_path.exists() {
        return base_path;
    }

    let stem = base_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("converted_negative");
    let extension = base_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());

    for index in 1.. {
        let candidate_name = match &extension {
            Some(ext) => format!("{stem}_{index}.{ext}"),
            None => format!("{stem}_{index}"),
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    base_path
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Build-time override for the key this binary looks up in `updater.json`.
///
/// The default lookup is `<os>-<arch>[-<installer>]`. The legacy glibc 2.35
/// AppImage is compiled with `NC_UPDATER_TARGET=linux-x86_64-glibc235` so it
/// keeps pulling the legacy variant: the standard AppImage would not start on
/// the older distributions that build exists for.
const UPDATER_TARGET_OVERRIDE: Option<&str> = option_env!("NC_UPDATER_TARGET");

fn updater_target_override(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    let well_formed = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    well_formed.then(|| value.to_string())
}

/// What the running build can do about a newer release. The webview shows a
/// "download and install" button only when `in_app` is true; otherwise it
/// links to the download page as before.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateCapability {
    in_app: bool,
    target: Option<String>,
    installer: Option<&'static str>,
    reason: &'static str,
}

fn describe_update_capability(
    updater_enabled: bool,
    os: &str,
    installer: Option<&'static str>,
    target: Option<String>,
) -> DesktopUpdateCapability {
    // The Mac App Store build is compiled without the updater feature: store
    // apps must not replace themselves.
    if !updater_enabled {
        return DesktopUpdateCapability {
            in_app: false,
            target,
            installer,
            reason: "updater-disabled",
        };
    }
    // On Windows and Linux the bundler stamps the installer format into the
    // binary. Without it (a bare executable, a dev build, an unknown package)
    // there is nothing the updater could safely replace.
    if os != "macos" && installer.is_none() {
        return DesktopUpdateCapability {
            in_app: false,
            target,
            installer,
            reason: "unpackaged",
        };
    }
    DesktopUpdateCapability {
        in_app: true,
        target,
        installer,
        reason: "ok",
    }
}

fn current_installer_name() -> Option<&'static str> {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type()? {
        BundleType::AppImage => Some("appimage"),
        BundleType::Deb => Some("deb"),
        BundleType::Rpm => Some("rpm"),
        BundleType::Msi => Some("msi"),
        BundleType::Nsis => Some("nsis"),
        BundleType::App => Some("app"),
        _ => Some("other"),
    }
}

#[tauri::command]
fn get_desktop_update_capability() -> DesktopUpdateCapability {
    describe_update_capability(
        cfg!(feature = "updater"),
        std::env::consts::OS,
        current_installer_name(),
        updater_target_override(UPDATER_TARGET_OVERRIDE),
    )
}

/// The WebKit variables that decide how the Linux web process composites.
/// Users can set them on any Linux install, so the page gets their effective
/// values even when no AppImage policy ran.
const WEBVIEW_COMPOSITING_ENV: [&str; 3] = [
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];

/// What the shell decided about webview compositing. Before this the decision
/// only reached stderr; the page uses it to start slider drags at a lower
/// preview resolution when the web process paints in software, and shows it
/// next to the WebGL renderer in its diagnostics.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WebviewCompositing {
    /// "linux" | "macos" | "windows"
    os: &'static str,
    /// "standard" | "legacy" when an AppImage policy ran.
    appimage: Option<&'static str>,
    /// The policy's decision, e.g. "kept:probe-supported" or "disabled:legacy-default".
    dmabuf: Option<String>,
    /// WEBVIEW_COMPOSITING_ENV as the web process inherits them (Linux only).
    env: Vec<(&'static str, Option<String>)>,
    /// The WebKitGTK version on Linux, filled in when the page asks.
    webkitgtk: Option<String>,
    /// NEGATIVE_CONVERTER_FRAME_LOG: log each slider session's frame times.
    frame_log: bool,
}

fn describe_webview_compositing(
    os: &'static str,
    appimage: Option<&'static str>,
    dmabuf: Option<&'static str>,
    read_env: impl Fn(&str) -> Option<String>,
) -> WebviewCompositing {
    let env = if os == "linux" {
        WEBVIEW_COMPOSITING_ENV
            .iter()
            .map(|&name| (name, read_env(name)))
            .collect()
    } else {
        Vec::new()
    };
    WebviewCompositing {
        os,
        appimage,
        dmabuf: dmabuf.map(str::to_string),
        env,
        webkitgtk: None,
        frame_log: read_env("NEGATIVE_CONVERTER_FRAME_LOG")
            .as_deref()
            .and_then(parse_bool_flag)
            .unwrap_or(false),
    }
}

#[tauri::command]
fn get_webview_compositing(compositing: State<'_, WebviewCompositing>) -> WebviewCompositing {
    let mut value = compositing.inner().clone();
    if value.os == "linux" {
        value.webkitgtk = tauri::webview_version().ok();
    }
    value
}

const MAX_DIAGNOSTICS_LINE_CHARS: usize = 600;

/// One line from the page, safe to print: no control characters (so it cannot
/// forge further log lines) and bounded in length.
fn sanitize_diagnostics_line(line: &str) -> String {
    let cleaned: String = line
        .chars()
        .take(MAX_DIAGNOSTICS_LINE_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cleaned.trim().to_string()
}

/// Puts the page's GL facts and frame-time summaries in the same terminal log
/// as the `[linux-compat]` lines, where the README's troubleshooting looks.
#[tauri::command]
fn log_webview_diagnostics(line: String) {
    let line = sanitize_diagnostics_line(&line);
    if !line.is_empty() {
        eprintln!("[webview] {line}");
    }
}

#[tauri::command]
fn pick_export_file_path(grants: State<'_, ExportGrants>, suggested_name: String) -> Option<String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()?;
    let normalized = normalize_export_path(path, &suggested_name);
    grants.grant_file(&normalized);
    Some(normalized.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_export_directory(grants: State<'_, ExportGrants>) -> Option<String> {
    let path = rfd::FileDialog::new().pick_folder()?;
    grants.grant_directory(&path);
    Some(path.to_string_lossy().to_string())
}

/// Runs the save panel on the native main thread (AppKit/GTK require it) while
/// the command itself stays off it, so the following write does not block the
/// event loop.
async fn pick_save_path_on_main_thread(
    app: &tauri::AppHandle,
    suggested_name: String,
) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_file_name(&suggested_name)
            .save_file();
        // The receiver only disappears if the command was dropped.
        let _ = sender.send(picked);
    })
    .map_err(|err| format!("failed to open the save dialog: {err}"))?;

    tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|err| format!("save dialog failed: {err}"))
}

#[tauri::command]
async fn save_export_file(
    app: tauri::AppHandle,
    grants: State<'_, ExportGrants>,
    suggested_name: String,
    bytes_base64: String,
) -> Result<SaveResult, String> {
    let Some(path) = pick_save_path_on_main_thread(&app, suggested_name.clone()).await? else {
        return Ok(SaveResult {
            saved: false,
            path: None,
        });
    };

    let normalized = normalize_export_path(path, &suggested_name);
    grants.grant_file(&normalized);
    write_export_bytes_off_thread(normalized, bytes_base64).await
}

#[tauri::command]
async fn write_export_file_to_path(
    grants: State<'_, ExportGrants>,
    path: String,
    bytes_base64: String,
) -> Result<SaveResult, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("export path is empty".to_string());
    }

    let target = PathBuf::from(trimmed);
    if !grants.allows_file(&target) {
        return Err("export path was not chosen in a save dialog".to_string());
    }

    write_export_bytes_off_thread(target, bytes_base64).await
}

#[tauri::command]
async fn write_export_file_to_directory(
    grants: State<'_, ExportGrants>,
    directory: String,
    suggested_name: String,
    bytes_base64: String,
) -> Result<SaveResult, String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Err("export directory is empty".to_string());
    }

    let directory_path = PathBuf::from(trimmed);
    if !directory_path.is_dir() {
        return Err(format!("export directory is invalid: {trimmed}"));
    }
    if !grants.allows_directory(&directory_path) {
        return Err("export directory was not chosen in a folder dialog".to_string());
    }

    let target_path = build_unique_export_path(&directory_path, &suggested_name);
    write_export_bytes_off_thread(target_path, bytes_base64).await
}

#[tauri::command]
fn begin_export_write(
    grants: State<'_, ExportGrants>, streams: State<'_, ExportStreams>,
    path: Option<String>, directory: Option<String>, suggested_name: Option<String>, expected_bytes: u64,
) -> Result<String, String> {
    let target = match (path, directory) {
        (Some(path), None) => {
            let target = PathBuf::from(path);
            if !grants.allows_file(&target) { return Err("export path was not chosen in a save dialog".into()); }
            target
        }
        (None, Some(directory)) => {
            let directory = PathBuf::from(directory);
            if !directory.is_dir() || !grants.allows_directory(&directory) {
                return Err("export directory was not chosen in a folder dialog".into());
            }
            build_unique_export_path(&directory, &suggested_name.ok_or("missing export file name")?)
        }
        _ => return Err("choose one export destination".into()),
    };
    streams.begin(&target, expected_bytes)
}

#[tauri::command]
async fn append_export_chunk(request: tauri::ipc::Request<'_>, streams: State<'_, ExportStreams>) -> Result<(), String> {
    let id = request.headers().get("x-export-id").and_then(|value| value.to_str().ok()).ok_or("missing export id")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected binary export chunk".into()); };
    streams.append(id, bytes)
}

#[tauri::command]
async fn finish_export_write(streams: State<'_, ExportStreams>, id: String) -> Result<SaveResult, String> {
    let pending = streams.take(&id)?;
    let path = tauri::async_runtime::spawn_blocking(move || pending.finish()).await
        .map_err(|err| format!("export task failed: {err}"))??;
    Ok(SaveResult { saved: true, path: Some(path.to_string_lossy().into_owned()) })
}

#[tauri::command]
fn abort_export_write(streams: State<'_, ExportStreams>, id: String) {
    if let Ok(pending) = streams.take(&id) { drop(pending); }
}

/// Which of `paths` exist as files directly inside `directory`. Resuming an
/// interrupted batch export skips the frames it recorded as written only when
/// their file is still there (#241).
fn existing_exports_in(directory: &Path, paths: &[String]) -> Vec<bool> {
    let root = grant_key(directory);
    paths
        .iter()
        .map(|path| {
            let path = PathBuf::from(path);
            path.parent().map(grant_key).as_deref() == Some(root.as_path()) && path.is_file()
        })
        .collect()
}

#[tauri::command]
fn exported_files_exist(
    grants: State<'_, ExportGrants>,
    directory: String,
    paths: Vec<String>,
) -> Result<Vec<bool>, String> {
    let directory = PathBuf::from(directory.trim());
    if !directory.is_dir() || !grants.allows_directory(&directory) {
        return Err("export directory was not chosen in a folder dialog".into());
    }
    Ok(existing_exports_in(&directory, &paths))
}

/// A WebContent process that macOS terminated (memory limit, crash). The
/// hook reloads the page; the page reads this once at boot to say why the
/// job it finds interrupted stopped (#241).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebContentTermination {
    /// Milliseconds since the Unix epoch.
    at: u64,
    /// Terminations since the app started.
    count: u32,
}

#[derive(Default)]
struct WebContentTerminations(Mutex<(u32, Option<WebContentTermination>)>);

impl WebContentTerminations {
    fn record(&self, at: u64) -> WebContentTermination {
        let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.0 = state.0.saturating_add(1);
        let record = WebContentTermination { at, count: state.0 };
        state.1 = Some(record);
        record
    }

    fn take(&self) -> Option<WebContentTermination> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1.take()
    }
}

#[tauri::command]
fn take_web_content_termination(state: State<'_, WebContentTerminations>) -> Option<WebContentTermination> {
    state.take()
}

/// A page that starts loading owns no export stream and no folder watch: the
/// previous page (killed, crashed or navigated away) can no longer finish or
/// listen to them.
fn reset_page_owned_state<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    let cleared = manager.state::<ExportStreams>().clear();
    if cleared > 0 {
        eprintln!("[export] dropped {cleared} unfinished export stream(s) from the previous page");
    }
    manager.state::<ImportWatch>().stop();
}

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
enum DmabufShmReason {
    LegacyDefault,
    OverrideShm,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufDecision {
    Keep(DmabufKeepReason),
    Disable(DmabufDisableReason),
    /// Keeps accelerated compositing but hands frames to the UI process
    /// through shared memory instead of DMA-BUF.
    ShmOnly(DmabufShmReason),
}

/// `NEGATIVE_CONVERTER_DMABUF`: on/off (and the usual boolean spellings), or
/// `shm` for the shared-memory transport.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufOverride {
    On,
    Off,
    Shm,
}

#[cfg(any(target_os = "linux", test))]
fn parse_dmabuf_override(value: &str) -> Option<DmabufOverride> {
    if value.trim().eq_ignore_ascii_case("shm") {
        return Some(DmabufOverride::Shm);
    }
    parse_bool_flag(value).map(|on| if on { DmabufOverride::On } else { DmabufOverride::Off })
}

/// Whether the legacy AppImage defaults to `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`
/// (accelerated compositing, frames copied through shared memory) instead of
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` (software compositing). The old default
/// was chosen for startup stability, so this stays off until the startup
/// matrix of #263 part 3 (Ubuntu 22.04 and Debian 12; Intel, AMD, NVIDIA
/// proprietary; X11 and Wayland) passes. `NEGATIVE_CONVERTER_DMABUF=shm`
/// runs that matrix on a release build.
#[cfg(any(target_os = "linux", test))]
const LEGACY_APPIMAGE_SHM_DEFAULT: bool = false;

#[cfg(any(target_os = "linux", test))]
fn decide_dmabuf_policy(
    variant: AppImageVariant,
    user_set_webkit_dmabuf: bool,
    override_value: Option<DmabufOverride>,
    probe_kind: Option<DmabufProbeKind>,
    legacy_shm_default: bool,
) -> DmabufDecision {
    if user_set_webkit_dmabuf {
        return DmabufDecision::Keep(DmabufKeepReason::UserPreset);
    }

    if let Some(override_value) = override_value {
        return match override_value {
            DmabufOverride::On => DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled),
            DmabufOverride::Off => DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled),
            DmabufOverride::Shm => DmabufDecision::ShmOnly(DmabufShmReason::OverrideShm),
        };
    }

    if variant == AppImageVariant::LegacyCompat {
        return if legacy_shm_default {
            DmabufDecision::ShmOnly(DmabufShmReason::LegacyDefault)
        } else {
            DmabufDecision::Disable(DmabufDisableReason::LegacyDefault)
        };
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

/// The decision as the page and the diagnostics log report it.
#[cfg(any(target_os = "linux", test))]
fn dmabuf_decision_label(decision: DmabufDecision) -> &'static str {
    match decision {
        DmabufDecision::Keep(DmabufKeepReason::UserPreset) => "kept:user-preset",
        DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled) => "kept:override-enabled",
        DmabufDecision::Keep(DmabufKeepReason::ProbeSupported) => "kept:probe-supported",
        DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled) => "disabled:override-disabled",
        DmabufDecision::Disable(DmabufDisableReason::LegacyDefault) => "disabled:legacy-default",
        DmabufDecision::Disable(DmabufDisableReason::NoRenderNode) => "disabled:no-render-node",
        DmabufDecision::Disable(DmabufDisableReason::PermissionDenied) => "disabled:permission-denied",
        DmabufDecision::Disable(DmabufDisableReason::ProbeUnavailable) => "disabled:probe-unavailable",
        DmabufDecision::ShmOnly(DmabufShmReason::LegacyDefault) => "shm:legacy-default",
        DmabufDecision::ShmOnly(DmabufShmReason::OverrideShm) => "shm:override",
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
fn force_shm_transport(reason: &str) {
    set_env_if_absent("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    eprintln!("[linux-compat] Using the shared-memory DMABUF renderer transport: {reason}");
}

#[cfg(target_os = "linux")]
fn apply_appimage_dmabuf_policy(variant: AppImageVariant) -> DmabufDecision {
    // A user who set either transport variable has chosen; leave both alone.
    let user_set_webkit_dmabuf = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()
        || std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_some();
    let dmabuf_override_raw = std::env::var("NEGATIVE_CONVERTER_DMABUF").ok();
    let dmabuf_override = dmabuf_override_raw.as_deref().and_then(parse_dmabuf_override);

    if dmabuf_override_raw.is_some() && dmabuf_override.is_none() {
        eprintln!(
            "[linux-compat] Ignoring NEGATIVE_CONVERTER_DMABUF={}; expected on/off/shm/true/false/1/0.",
            dmabuf_override_raw.as_deref().unwrap_or_default()
        );
    }

    let probe_result = if !user_set_webkit_dmabuf
        && dmabuf_override.is_none()
        && variant == AppImageVariant::Standard
    {
        Some(probe_dmabuf_support())
    } else {
        None
    };

    let decision = decide_dmabuf_policy(
        variant,
        user_set_webkit_dmabuf,
        dmabuf_override,
        probe_result.as_ref().map(dmabuf_probe_kind),
        LEGACY_APPIMAGE_SHM_DEFAULT,
    );

    match decision {
        DmabufDecision::Keep(DmabufKeepReason::UserPreset) => {
            eprintln!(
                "[linux-compat] WEBKIT_DISABLE_DMABUF_RENDERER or WEBKIT_DMABUF_RENDERER_FORCE_SHM already set by user; keeping existing values."
            );
        }
        DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled) => {
            eprintln!("[linux-compat] Keeping DMABUF enabled by NEGATIVE_CONVERTER_DMABUF override.");
        }
        DmabufDecision::Keep(DmabufKeepReason::ProbeSupported) => {
            if let Some(DmabufProbeResult::Supported(path)) = &probe_result {
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
            if let Some(DmabufProbeResult::PermissionDenied(paths)) = &probe_result {
                disable_dmabuf_renderer(&format!(
                    "permission denied opening render node(s): {}",
                    paths.join(", ")
                ));
            } else {
                disable_dmabuf_renderer("permission denied opening /dev/dri/render node.");
            }
        }
        DmabufDecision::Disable(DmabufDisableReason::ProbeUnavailable) => {
            if let Some(DmabufProbeResult::Unavailable(reason)) = &probe_result {
                disable_dmabuf_renderer(&format!("render node probe failed: {reason}"));
            } else {
                disable_dmabuf_renderer("render node probe failed.");
            }
        }
        DmabufDecision::ShmOnly(DmabufShmReason::LegacyDefault) => {
            force_shm_transport("legacy compatibility AppImage default.");
        }
        DmabufDecision::ShmOnly(DmabufShmReason::OverrideShm) => {
            force_shm_transport("forced by NEGATIVE_CONVERTER_DMABUF=shm.");
        }
    }
    decision
}

/// Applies the AppImage guards and reports what the webview will run with.
/// The environment is read after the policy ran, so it is what the web
/// process inherits.
#[cfg(target_os = "linux")]
fn apply_linux_appimage_compat_env() -> WebviewCompositing {
    let read_env = |name: &str| std::env::var(name).ok();
    if std::env::var_os("APPIMAGE").is_none() {
        return describe_webview_compositing("linux", None, None, read_env);
    }

    let variant = detect_appimage_variant();
    eprintln!(
        "[linux-compat] AppImage runtime detected ({}). Applying Linux compatibility guards.",
        appimage_variant_label(variant)
    );
    apply_appimage_gio_guards();
    let decision = apply_appimage_dmabuf_policy(variant);
    describe_webview_compositing(
        "linux",
        Some(appimage_variant_label(variant)),
        Some(dmabuf_decision_label(decision)),
        read_env,
    )
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_appimage_compat_env() -> WebviewCompositing {
    describe_webview_compositing(std::env::consts::OS, None, None, |name| std::env::var(name).ok())
}

const MAX_EXTERNAL_URL_LEN: usize = 2048;

fn strip_https_prefix(value: &str) -> Option<&str> {
    const PREFIX: &str = "https://";
    if value.len() < PREFIX.len() {
        return None;
    }
    let (head, rest) = value.split_at(PREFIX.len());
    head.eq_ignore_ascii_case(PREFIX).then_some(rest)
}

fn is_allowed_authority(authority: &str) -> bool {
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };

    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
    }

    if host.is_empty()
        || host.len() > 253
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
    {
        return false;
    }

    // No userinfo (`https://trusted.example@attacker.example`), no escapes, no
    // IPv6 literals — the app only ever opens ordinary registered domains.
    host.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
}

/// Every outbound desktop link goes through `open_external_url`, so the string
/// arriving here is attacker-influenced as soon as anything can inject script
/// into the webview. The page always hands over the output of `URL.toString()`,
/// which is percent-encoded printable ASCII; anything else is rejected.
fn sanitize_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }
    if trimmed.len() > MAX_EXTERNAL_URL_LEN {
        return Err("URL is too long".to_string());
    }
    if trimmed
        .bytes()
        .any(|byte| !(0x21..=0x7e).contains(&byte))
    {
        // Control characters, spaces and non-ASCII bytes never survive URL
        // serialization, and they are what argument-splitting tricks rely on.
        return Err("URL contains characters that are not allowed".to_string());
    }

    let Some(rest) = strip_https_prefix(trimmed) else {
        return Err("only https URLs are allowed".to_string());
    };

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if !is_allowed_authority(&rest[..authority_end]) {
        return Err("URL host is not allowed".to_string());
    }

    Ok(trimmed)
}

/// Spawns the opener and reaps it on a helper thread; `spawn` alone leaves a
/// zombie entry for every link the user clicks until the app quits.
fn spawn_and_reap(command: &mut Command) -> Result<(), String> {
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to launch browser: {err}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return spawn_and_reap(Command::new("open").arg(url));
    }

    #[cfg(target_os = "windows")]
    {
        // Never `cmd /C start`: cmd.exe would treat `&`, `|`, `^` and `%VAR%`
        // inside the URL as shell syntax. rundll32 receives the URL as a plain
        // CreateProcess argument and hands it to the registered protocol
        // handler without a shell in between.
        return spawn_and_reap(
            Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return spawn_and_reap(Command::new("xdg-open").arg(url));
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for opening URL".to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let sanitized = sanitize_external_url(&url)?;
    open_url_with_system_browser(sanitized)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let webview_compositing = apply_linux_appimage_compat_env();
    // Before the first webview: what WebKitGTK's memory pressure runs with (#258).
    memory_info::log_linux_memory_pressure_plan();
    let builder = tauri::Builder::default()
        .manage(webview_compositing)
        .manage(ExportGrants::default())
        .manage(ExportStreams::default())
        .manage(ImportWatch::default())
        .manage(WebContentTerminations::default())
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                reset_page_owned_state(webview);
            }
        });
    // Registering the hook replaces Tauri's default handler, which only
    // reloads; this one records the termination for the page and releases
    // what the dead page owned before it reloads the webview itself.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let record = tauri::Manager::state::<WebContentTerminations>(webview).record(at);
        eprintln!("[webview] WebContent process terminated ({} this run); reloading", record.count);
        reset_page_owned_state(webview);
        if let Err(err) = webview.reload() {
            eprintln!("[webview] reload after termination failed: {err}");
        }
    });
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_process::init()).plugin({
        let mut updater = tauri_plugin_updater::Builder::new();
        if let Some(target) = updater_target_override(UPDATER_TARGET_OVERRIDE) {
            updater = updater.target(target);
        }
        updater.build()
    });
    builder
        .invoke_handler(tauri::generate_handler![
            watch_import_folder,
            stop_watch_import_folder,
            read_import_file,
            begin_export_write,
            append_export_chunk,
            finish_export_write,
            abort_export_write,
            exported_files_exist,
            take_web_content_termination,
            save_export_file,
            pick_export_file_path,
            pick_export_directory,
            write_export_file_to_path,
            write_export_file_to_directory,
            get_app_version,
            get_memory_info,
            get_desktop_update_capability,
            get_webview_compositing,
            log_webview_diagnostics,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_unique_export_path, decide_dmabuf_policy, describe_update_capability,
        describe_webview_compositing, dmabuf_decision_label, looks_like_legacy_appimage_name,
        normalize_export_path, parse_bool_flag, parse_dmabuf_override, sanitize_diagnostics_line,
        sanitize_export_file_name, sanitize_external_url, updater_target_override,
        write_export_bytes, existing_exports_in, AppImageVariant, DesktopUpdateCapability, DmabufDecision,
        DmabufDisableReason, DmabufKeepReason, DmabufOverride, DmabufProbeKind,
        DmabufShmReason, ExportGrants, WebContentTermination, WebContentTerminations,
        LEGACY_APPIMAGE_SHM_DEFAULT, MAX_DIAGNOSTICS_LINE_CHARS,
    };
    use std::path::PathBuf;

    #[test]
    fn updater_target_override_ignores_blank_values() {
        assert_eq!(updater_target_override(None), None);
        assert_eq!(updater_target_override(Some("")), None);
        assert_eq!(updater_target_override(Some("   ")), None);
    }

    #[test]
    fn updater_target_override_keeps_manifest_keys() {
        assert_eq!(
            updater_target_override(Some(" linux-x86_64-glibc235 ")),
            Some("linux-x86_64-glibc235".to_string())
        );
    }

    #[test]
    fn updater_target_override_rejects_malformed_keys() {
        assert_eq!(updater_target_override(Some("linux x86_64")), None);
        assert_eq!(updater_target_override(Some("linux/x86_64")), None);
    }

    #[test]
    fn update_capability_is_off_without_the_updater_feature() {
        let capability = describe_update_capability(false, "windows", Some("nsis"), None);
        assert_eq!(
            capability,
            DesktopUpdateCapability {
                in_app: false,
                target: None,
                installer: Some("nsis"),
                reason: "updater-disabled",
            }
        );
    }

    #[test]
    fn update_capability_requires_a_known_installer_outside_macos() {
        assert!(!describe_update_capability(true, "linux", None, None).in_app);
        assert!(!describe_update_capability(true, "windows", None, None).in_app);
        assert!(describe_update_capability(true, "linux", Some("appimage"), None).in_app);
        assert!(describe_update_capability(true, "linux", Some("deb"), None).in_app);
        assert!(describe_update_capability(true, "windows", Some("msi"), None).in_app);
    }

    #[test]
    fn update_capability_on_macos_needs_no_installer_stamp() {
        let capability = describe_update_capability(true, "macos", Some("app"), None);
        assert!(capability.in_app);
        assert_eq!(capability.reason, "ok");
    }

    #[test]
    fn update_capability_reports_the_legacy_target() {
        let capability = describe_update_capability(
            true,
            "linux",
            Some("appimage"),
            Some("linux-x86_64-glibc235".to_string()),
        );
        assert!(capability.in_app);
        assert_eq!(capability.target.as_deref(), Some("linux-x86_64-glibc235"));
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("negative-converter-test-{label}-{unique}"));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

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
    fn normalize_export_path_adds_missing_extension_from_suggested_name() {
        let path = normalize_export_path(PathBuf::from("/tmp/converted_negatives"), "converted.zip");
        assert_eq!(path, PathBuf::from("/tmp/converted_negatives.zip"));
    }

    #[test]
    fn normalize_export_path_preserves_explicit_extension() {
        let path =
            normalize_export_path(PathBuf::from("/tmp/converted_negatives.custom"), "converted.zip");
        assert_eq!(path, PathBuf::from("/tmp/converted_negatives.custom"));
    }

    #[test]
    fn dmabuf_policy_respects_user_preset_first() {
        let decision = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            true,
            Some(DmabufOverride::Off),
            Some(DmabufProbeKind::PermissionDenied),
            true,
        );
        assert_eq!(decision, DmabufDecision::Keep(DmabufKeepReason::UserPreset));
    }

    #[test]
    fn dmabuf_policy_allows_override_on_for_legacy_variant() {
        let decision = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            false,
            Some(DmabufOverride::On),
            Some(DmabufProbeKind::PermissionDenied),
            false,
        );
        assert_eq!(
            decision,
            DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled)
        );
    }

    #[test]
    fn dmabuf_policy_disables_legacy_by_default() {
        let decision = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            false,
            None,
            None,
            LEGACY_APPIMAGE_SHM_DEFAULT,
        );
        // Until the startup matrix of #263 part 3 passes, the legacy build
        // keeps software compositing.
        assert!(!LEGACY_APPIMAGE_SHM_DEFAULT);
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
            false,
        );
        assert_eq!(supported, DmabufDecision::Keep(DmabufKeepReason::ProbeSupported));

        let no_render = decide_dmabuf_policy(
            AppImageVariant::Standard,
            false,
            None,
            Some(DmabufProbeKind::NoRenderNode),
            false,
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
            false,
        );
        assert_eq!(
            denied,
            DmabufDecision::Disable(DmabufDisableReason::PermissionDenied)
        );
    }

    #[test]
    fn dmabuf_override_parses_shm_and_booleans() {
        assert_eq!(parse_dmabuf_override("shm"), Some(DmabufOverride::Shm));
        assert_eq!(parse_dmabuf_override(" SHM "), Some(DmabufOverride::Shm));
        assert_eq!(parse_dmabuf_override("on"), Some(DmabufOverride::On));
        assert_eq!(parse_dmabuf_override("1"), Some(DmabufOverride::On));
        assert_eq!(parse_dmabuf_override("off"), Some(DmabufOverride::Off));
        assert_eq!(parse_dmabuf_override("false"), Some(DmabufOverride::Off));
        assert_eq!(parse_dmabuf_override("maybe"), None);
    }

    #[test]
    fn dmabuf_policy_shm_default_keeps_acceleration_for_legacy_only() {
        let legacy = decide_dmabuf_policy(AppImageVariant::LegacyCompat, false, None, None, true);
        assert_eq!(legacy, DmabufDecision::ShmOnly(DmabufShmReason::LegacyDefault));

        // Hosts without a usable GPU keep the non-accelerated painter.
        for (kind, reason) in [
            (DmabufProbeKind::NoRenderNode, DmabufDisableReason::NoRenderNode),
            (DmabufProbeKind::PermissionDenied, DmabufDisableReason::PermissionDenied),
            (DmabufProbeKind::Unavailable, DmabufDisableReason::ProbeUnavailable),
        ] {
            let decision =
                decide_dmabuf_policy(AppImageVariant::Standard, false, None, Some(kind), true);
            assert_eq!(decision, DmabufDecision::Disable(reason));
        }
        let supported = decide_dmabuf_policy(
            AppImageVariant::Standard,
            false,
            None,
            Some(DmabufProbeKind::Supported),
            true,
        );
        assert_eq!(supported, DmabufDecision::Keep(DmabufKeepReason::ProbeSupported));
    }

    #[test]
    fn dmabuf_overrides_win_over_the_shm_default() {
        let off = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            false,
            Some(DmabufOverride::Off),
            None,
            true,
        );
        assert_eq!(off, DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled));
        let on = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            false,
            Some(DmabufOverride::On),
            None,
            true,
        );
        assert_eq!(on, DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled));
        // `shm` opts into the shared-memory transport while the default is off,
        // on either variant.
        for variant in [AppImageVariant::LegacyCompat, AppImageVariant::Standard] {
            let shm = decide_dmabuf_policy(
                variant,
                false,
                Some(DmabufOverride::Shm),
                Some(DmabufProbeKind::NoRenderNode),
                false,
            );
            assert_eq!(shm, DmabufDecision::ShmOnly(DmabufShmReason::OverrideShm));
        }
        // A user who set a WebKit transport variable has chosen.
        let preset = decide_dmabuf_policy(
            AppImageVariant::LegacyCompat,
            true,
            Some(DmabufOverride::Shm),
            None,
            true,
        );
        assert_eq!(preset, DmabufDecision::Keep(DmabufKeepReason::UserPreset));
    }

    #[test]
    fn dmabuf_decision_labels_are_the_page_contract() {
        let cases = [
            (DmabufDecision::Keep(DmabufKeepReason::UserPreset), "kept:user-preset"),
            (DmabufDecision::Keep(DmabufKeepReason::OverrideEnabled), "kept:override-enabled"),
            (DmabufDecision::Keep(DmabufKeepReason::ProbeSupported), "kept:probe-supported"),
            (DmabufDecision::Disable(DmabufDisableReason::OverrideDisabled), "disabled:override-disabled"),
            (DmabufDecision::Disable(DmabufDisableReason::LegacyDefault), "disabled:legacy-default"),
            (DmabufDecision::Disable(DmabufDisableReason::NoRenderNode), "disabled:no-render-node"),
            (DmabufDecision::Disable(DmabufDisableReason::PermissionDenied), "disabled:permission-denied"),
            (DmabufDecision::Disable(DmabufDisableReason::ProbeUnavailable), "disabled:probe-unavailable"),
            (DmabufDecision::ShmOnly(DmabufShmReason::LegacyDefault), "shm:legacy-default"),
            (DmabufDecision::ShmOnly(DmabufShmReason::OverrideShm), "shm:override"),
        ];
        for (decision, label) in cases {
            assert_eq!(dmabuf_decision_label(decision), label);
        }
    }

    fn fake_env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn webview_compositing_reports_the_legacy_decision_and_effective_env() {
        let legacy = describe_webview_compositing(
            "linux",
            Some("legacy"),
            Some("disabled:legacy-default"),
            fake_env(&[
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("NEGATIVE_CONVERTER_FRAME_LOG", "1"),
            ]),
        );
        assert_eq!(legacy.os, "linux");
        assert_eq!(legacy.appimage, Some("legacy"));
        assert_eq!(legacy.dmabuf.as_deref(), Some("disabled:legacy-default"));
        assert_eq!(
            legacy.env,
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", Some("1".to_string())),
                ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", None),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", None),
            ]
        );
        assert!(legacy.frame_log);
        assert_eq!(legacy.webkitgtk, None, "filled in by the command");

        let value = serde_json::to_value(&legacy).expect("serialise");
        assert_eq!(value["appimage"], "legacy");
        assert_eq!(value["dmabuf"], "disabled:legacy-default");
        assert_eq!(value["frameLog"], true);
        assert_eq!(value["webkitgtk"], serde_json::Value::Null);
        assert_eq!(value["env"][0][0], "WEBKIT_DISABLE_DMABUF_RENDERER");
        assert_eq!(value["env"][0][1], "1");
        assert_eq!(value["env"][1][1], serde_json::Value::Null);
    }

    #[test]
    fn webview_compositing_fills_env_on_linux_without_an_appimage() {
        // .deb and .rpm installs run no policy, but users can set the variables.
        let deb = describe_webview_compositing(
            "linux",
            None,
            None,
            fake_env(&[("WEBKIT_DISABLE_COMPOSITING_MODE", "1")]),
        );
        assert_eq!(deb.appimage, None);
        assert_eq!(deb.dmabuf, None);
        assert_eq!(deb.env[2], ("WEBKIT_DISABLE_COMPOSITING_MODE", Some("1".to_string())));
        assert!(!deb.frame_log);
    }

    #[test]
    fn webview_compositing_is_empty_on_macos_and_windows() {
        for os in ["macos", "windows"] {
            let value = describe_webview_compositing(
                os,
                None,
                None,
                fake_env(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]),
            );
            assert_eq!(value.os, os);
            assert_eq!(value.appimage, None);
            assert_eq!(value.dmabuf, None);
            assert!(value.env.is_empty());
            let json = serde_json::to_value(&value).expect("serialise");
            assert_eq!(json["appimage"], serde_json::Value::Null);
            assert_eq!(json["frameLog"], false);
        }
    }

    #[test]
    fn diagnostics_lines_are_bounded_and_single_line() {
        assert_eq!(
            sanitize_diagnostics_line("renderer=llvmpipe\n[linux-compat] forged\r\x1b[2J"),
            "renderer=llvmpipe [linux-compat] forged  [2J"
        );
        assert_eq!(sanitize_diagnostics_line("  \t\n "), "");
        let long = "x".repeat(MAX_DIAGNOSTICS_LINE_CHARS * 2);
        assert_eq!(
            sanitize_diagnostics_line(&long).chars().count(),
            MAX_DIAGNOSTICS_LINE_CHARS
        );
        // Multi-byte text is cut on character boundaries.
        let wide = "é".repeat(MAX_DIAGNOSTICS_LINE_CHARS + 5);
        assert_eq!(
            sanitize_diagnostics_line(&wide).chars().count(),
            MAX_DIAGNOSTICS_LINE_CHARS
        );
    }

    #[test]
    fn sanitize_external_url_accepts_the_urls_the_app_opens() {
        assert_eq!(
            sanitize_external_url("https://negative-converter.tokugai.com/download.html?lang=en&from=desktop-update"),
            Ok("https://negative-converter.tokugai.com/download.html?lang=en&from=desktop-update")
        );
        assert_eq!(
            sanitize_external_url("  https://apps.apple.com/app/id6797694070  "),
            Ok("https://apps.apple.com/app/id6797694070")
        );
        // The scheme check has always been case-insensitive; keep it that way.
        assert_eq!(
            sanitize_external_url("HTTPS://github.com/lexluthor0304/NegativeConverter"),
            Ok("HTTPS://github.com/lexluthor0304/NegativeConverter")
        );
    }

    #[test]
    fn sanitize_external_url_rejects_non_https_schemes() {
        for url in [
            "http://negative-converter.tokugai.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "",
            "   ",
            "https://",
        ] {
            assert!(
                sanitize_external_url(url).is_err(),
                "expected {url:?} to be rejected"
            );
        }
    }

    #[test]
    fn sanitize_external_url_rejects_argument_splitting_and_userinfo() {
        for url in [
            // Whitespace and control characters never survive URL serialization.
            "https://example.com/a b",
            "https://example.com/a\tb",
            "https://example.com/a\nb",
            "https://exa mple.com/",
            "https://example.com/\u{0}",
            // Credentials in the authority are a phishing shape, never used here.
            "https://negative-converter.tokugai.com@attacker.example/",
            // Non-ASCII must arrive percent-encoded.
            "https://exämple.com/",
        ] {
            assert!(
                sanitize_external_url(url).is_err(),
                "expected {url:?} to be rejected"
            );
        }

        let too_long = format!("https://example.com/{}", "a".repeat(4096));
        assert!(sanitize_external_url(&too_long).is_err());
    }

    #[test]
    fn sanitize_external_url_allows_ampersands_in_the_query() {
        // `&` is legitimate in a query string; safety comes from never handing
        // the URL to a shell, not from banning shell metacharacters.
        let url = "https://negative-converter.tokugai.com/download.html?a=1&b=2%20c";
        assert_eq!(sanitize_external_url(url), Ok(url));
        // ...but the same characters in the host are still refused.
        assert!(sanitize_external_url("https://exa&mple.com/").is_err());
    }

    #[test]
    fn sanitize_export_file_name_keeps_only_the_file_name() {
        assert_eq!(sanitize_export_file_name("scan_001.tif"), "scan_001.tif");
        assert_eq!(
            sanitize_export_file_name("../../../.zshrc"),
            ".zshrc"
        );
        assert_eq!(sanitize_export_file_name("/etc/passwd"), "passwd");
        assert_eq!(sanitize_export_file_name(".."), "converted_negative");
        assert_eq!(sanitize_export_file_name(""), "converted_negative");
        assert_eq!(sanitize_export_file_name("   "), "converted_negative");
        // Whatever the platform makes of these, the result is always a single
        // path component with no separator left in it.
        for name in ["a\\b.png", "C:evil.png", "../..\\x/y.png", "..\\..\\.zshrc"] {
            let sanitized = sanitize_export_file_name(name);
            assert!(
                !sanitized.contains(['/', '\\', ':']),
                "{name:?} produced {sanitized:?}"
            );
            assert_eq!(
                PathBuf::from(&sanitized).components().count(),
                1,
                "{name:?} produced {sanitized:?}"
            );
        }
    }

    #[test]
    fn build_unique_export_path_stays_inside_the_chosen_directory() {
        let dir = scratch_dir("unique-path");
        let escaped = build_unique_export_path(&dir, "../../escaped.png");
        assert_eq!(escaped, dir.join("escaped.png"));

        std::fs::write(dir.join("scan.png"), b"first").expect("seed file");
        let second = build_unique_export_path(&dir, "scan.png");
        assert_eq!(second, dir.join("scan_1.png"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn web_content_terminations_are_counted_and_taken_once() {
        let log = WebContentTerminations::default();
        assert_eq!(log.take(), None, "a clean start reports nothing");
        assert_eq!(log.record(1_000), WebContentTermination { at: 1_000, count: 1 });
        assert_eq!(log.record(2_000), WebContentTermination { at: 2_000, count: 2 });
        assert_eq!(log.take(), Some(WebContentTermination { at: 2_000, count: 2 }), "the page reads the latest one");
        assert_eq!(log.take(), None, "and only once");
        assert_eq!(log.record(3_000).count, 3, "the count spans the whole app run");
        let json = serde_json::to_string(&log.take().unwrap()).expect("serialises");
        assert_eq!(json, r#"{"at":3000,"count":3}"#);
    }

    #[test]
    fn existing_exports_are_checked_inside_the_folder_only() {
        let dir = scratch_dir("resume-exists");
        std::fs::write(dir.join("frame_01.tiff"), b"done").expect("seed file");
        std::fs::create_dir(dir.join("nested")).expect("nested dir");
        std::fs::write(dir.join("nested").join("frame_02.tiff"), b"x").expect("nested file");
        let outside = std::env::temp_dir().join(format!("nc-resume-outside-{}.tiff", std::process::id()));
        std::fs::write(&outside, b"x").expect("outside file");
        let paths = [
            dir.join("frame_01.tiff"),
            dir.join("frame_03.tiff"),
            dir.join("nested").join("frame_02.tiff"),
            dir.join("..").join(dir.file_name().unwrap()).join("frame_01.tiff"),
            outside.clone(),
            dir.clone(),
        ]
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        assert_eq!(
            existing_exports_in(&dir, &paths),
            vec![true, false, false, true, false, false]
        );
        std::fs::remove_file(outside).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_export_bytes_replaces_the_target_and_leaves_no_temporary_file() {
        let dir = scratch_dir("atomic-write");
        let target = dir.join("export.png");
        std::fs::write(&target, b"stale contents that must be replaced").expect("seed file");

        let result = write_export_bytes(&target, b"new").expect("write succeeds");
        assert!(result.saved);
        assert_eq!(std::fs::read(&target).expect("read back"), b"new");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("list dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != "export.png")
            .collect();
        assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_grants_only_allow_paths_that_came_from_a_dialog() {
        let dir = scratch_dir("grants");
        let picked = dir.join("chosen.png");
        let grants = ExportGrants::default();

        assert!(!grants.allows_file(&picked));
        assert!(!grants.allows_directory(&dir));

        grants.grant_file(&picked);
        grants.grant_directory(&dir);

        assert!(grants.allows_file(&picked));
        assert!(grants.allows_directory(&dir));
        // The same destination spelled differently is still the same grant.
        assert!(grants.allows_file(&dir.join(".").join("chosen.png")));
        // Anything else the webview could name is refused.
        assert!(!grants.allows_file(&dir.join("not-chosen.png")));
        assert!(!grants.allows_file(&PathBuf::from("/etc/passwd")));
        assert!(!grants.allows_directory(&dir.join("subdir")));

        std::fs::remove_dir_all(&dir).ok();
    }
}
