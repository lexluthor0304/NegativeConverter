// Display proxies on the desktop (#249). A display proxy is the 16-bit
// display preview a large photo's settled view converts from; the page keeps
// the ones it spills (this run) and stores (across runs) here, in the app's
// cache directory, instead of WebKit's origin storage: an origin eviction or
// the origin quota never touches the MI-GAN model, the learned defaults or
// the project recovery copy, and no pixels land there. The directory lives
// inside the container of the Mac App Store build (no new entitlement).
//
// Records are opaque, checksummed files the page encodes; this side only
// writes them atomically (a `.part` file, then a rename), reads them back in
// chunks, lists, deletes and reports free space. Names are 64 lowercase hex
// digits (a hash of the record's key) or `index`, so no request can name a
// path. The spill of an earlier run is removed at start, and the spill of the
// page before whenever a page starts loading.
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
#[cfg(not(feature = "perf-harness"))]
use tauri::Manager;

// Must equal DISPLAY_PROXY_CHUNK_BYTES in displayProxyDesktop.js: the IPC
// limit the export stream uses too.
pub const CHUNK_LIMIT: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scope {
    Store,
    Spill,
}

pub fn parse_scope(value: &str) -> Result<Scope, String> {
    match value {
        "store" => Ok(Scope::Store),
        "spill" => Ok(Scope::Spill),
        _ => Err("unknown display proxy scope".into()),
    }
}

pub fn valid_name(name: &str) -> bool {
    name == "index" || (name.len() == 64 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn scope_dir(root: &Path, scope: Scope) -> PathBuf {
    root.join(match scope {
        Scope::Store => "store",
        Scope::Spill => "session",
    })
}

fn record_path(root: &Path, scope: Scope, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("invalid display proxy name".into());
    }
    Ok(scope_dir(root, scope).join(format!("{name}.ncdp")))
}

fn part_path(root: &Path, scope: Scope, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("invalid display proxy name".into());
    }
    Ok(scope_dir(root, scope).join(format!("{name}.part")))
}

/// Creates the directories, marks them as a cache for backup tools and
/// removes the spill an earlier run left behind.
pub fn prepare_root(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(scope_dir(root, Scope::Store))?;
    let _ = fs::remove_dir_all(scope_dir(root, Scope::Spill));
    fs::create_dir_all(scope_dir(root, Scope::Spill))?;
    // The Cache Directory Tagging Specification (borg, restic, tar, GNU tools).
    let tag = root.join("CACHEDIR.TAG");
    if !tag.exists() {
        fs::write(&tag, b"Signature: 8a477f597d28d172789f06886806bc55\n# NeoAnalogLab display proxies: a cache, rebuilt on demand.\n")?;
    }
    exclude_from_backup(root);
    // Leftover partial writes of an interrupted run.
    if let Ok(entries) = fs::read_dir(scope_dir(root, Scope::Store)) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("part") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// Removes the spill of the page before, best effort, and returns how many
/// records (or partial writes) went. A page that starts loading (a reload,
/// or the one after macOS terminated WebContent) has an empty spill index,
/// so what an earlier page spilled is unreachable (R2-008). It runs before
/// that page's script, so none of its own records are here yet. The store
/// is kept.
pub fn reset_spill(root: &Path) -> usize {
    let Ok(dir) = fs::read_dir(scope_dir(root, Scope::Spill)) else { return 0 };
    let mut removed = 0;
    for entry in dir.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        if (ext == Some("ncdp") || ext == Some("part")) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// Time Machine's sticky exclusion, the attribute `tmutil addexclusion` sets.
#[cfg(target_os = "macos")]
fn exclude_from_backup(root: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(path), Ok(name)) = (
        CString::new(root.as_os_str().as_bytes()),
        CString::new("com.apple.metadata:com_apple_backup_excludeItem"),
    ) else {
        return;
    };
    let value = b"com.apple.backupd";
    unsafe {
        libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr() as *const libc::c_void, value.len(), 0, 0);
    }
}

// Windows keeps the cache under the local (not roaming) app data; Linux
// backup tools honour CACHEDIR.TAG.
#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_root: &Path) {}

/// Appends one chunk of a record at `offset` (0 starts it over) and, with
/// `last`, flushes it and renames it into place. Returns the length written.
pub fn write_chunk(root: &Path, scope: Scope, name: &str, offset: u64, bytes: &[u8], last: bool) -> Result<u64, String> {
    if bytes.len() > CHUNK_LIMIT {
        return Err("display proxy chunk too large".into());
    }
    let part = part_path(root, scope, name)?;
    let target = record_path(root, scope, name)?;
    fs::create_dir_all(scope_dir(root, scope)).map_err(|e| e.to_string())?;
    let mut file = if offset == 0 {
        fs::File::create(&part).map_err(|e| e.to_string())?
    } else {
        let file = fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length != offset {
            let _ = fs::remove_file(&part);
            return Err("display proxy chunk out of order".into());
        }
        file
    };
    let end = offset + bytes.len() as u64;
    if end > MAX_RECORD_BYTES {
        let _ = fs::remove_file(&part);
        return Err("display proxy record too large".into());
    }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    if last {
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&part, &target).map_err(|e| e.to_string())?;
    }
    Ok(end)
}

/// Up to `length` bytes of a record from `offset` (empty past its end or
/// when there is no such record). Reading its start marks it recently used.
pub fn read_chunk(root: &Path, scope: Scope, name: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let path = record_path(root, scope, name)?;
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    if offset == 0 {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(length.min(CHUNK_LIMIT as u64)).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

pub fn list(root: &Path, scope: Scope) -> Vec<Entry> {
    let mut entries = Vec::new();
    let Ok(dir) = fs::read_dir(scope_dir(root, scope)) else { return entries };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ncdp") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if !valid_name(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(Entry { name: name.to_string(), bytes: meta.len(), modified_ms });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

pub fn delete(root: &Path, scope: Scope, name: &str) -> Result<(), String> {
    let path = record_path(root, scope, name)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn clear(root: &Path, scope: Scope) -> Result<(), String> {
    let Ok(dir) = fs::read_dir(scope_dir(root, scope)) else { return Ok(()) };
    for entry in dir.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        if ext == Some("ncdp") || ext == Some("part") {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

/// The real free space of the volume holding the cache (the page's budget
/// follows the disk, #249).
#[cfg(unix)]
pub fn space(root: &Path) -> Space {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(root.as_os_str().as_bytes()) else { return Space { free_bytes: None, total_bytes: None } };
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return Space { free_bytes: None, total_bytes: None };
    }
    let unit = stats.f_frsize as u64;
    Space { free_bytes: Some(stats.f_bavail as u64 * unit), total_bytes: Some(stats.f_blocks as u64 * unit) }
}

#[cfg(windows)]
pub fn space(root: &Path) -> Space {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(directory: *const u16, free_to_caller: *mut u64, total: *mut u64, total_free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free) } == 0 {
        return Space { free_bytes: None, total_bytes: None };
    }
    Space { free_bytes: Some(free), total_bytes: Some(total) }
}

#[cfg(not(any(unix, windows)))]
pub fn space(_root: &Path) -> Space {
    Space { free_bytes: None, total_bytes: None }
}

pub fn root_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(feature = "perf-harness")]
    {
        let _ = app;
        return perf_cache_root(std::env::var_os("NC_PERF_TAURI_CACHE_ROOT").map(PathBuf::from),
            std::env::var("NC_PERF_TAURI_CACHE_TOKEN").ok());
    }
    #[cfg(not(feature = "perf-harness"))]
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("display-proxies"))
}

// The harness launches the real app, whose startup clears prior spill files.
// Never fall back to the user's cache when the harness claim is unavailable.
#[cfg(feature = "perf-harness")]
fn perf_cache_root(root: Option<PathBuf>, token: Option<String>) -> Result<PathBuf, String> {
    let root = root.ok_or("performance harness cache root missing")?;
    let token = token.ok_or("performance harness cache token missing")?;
    if !root.is_absolute() || token.len() != 32 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid performance harness cache claim".into());
    }
    let metadata = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_dir() || root.canonicalize().map_err(|e| e.to_string())? != root {
        return Err("performance harness cache root is not a canonical directory".into());
    }
    let marker = root.join(".nc-perf-harness");
    let claim = fs::symlink_metadata(&marker).map_err(|e| e.to_string())?;
    if !claim.file_type().is_file() {
        return Err("performance harness cache claim is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid || claim.uid() != uid || metadata.mode() & 0o077 != 0 || claim.mode() & 0o077 != 0 {
            return Err("performance harness cache claim is not private to this user".into());
        }
    }
    if fs::read_to_string(marker).map_err(|e| e.to_string())? != format!("{token}\n") {
        return Err("performance harness cache claim does not match".into());
    }
    Ok(root.join("display-proxies"))
}

#[cfg(all(test, feature = "perf-harness", unix))]
mod perf_cache_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn fixture(marker: bool) -> PathBuf {
        let base = std::env::var_os("NC_PERF_TEST_ROOT").map(PathBuf::from).unwrap_or(std::env::temp_dir());
        let nonce = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = base.join(format!("perf-cache-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        if marker {
            fs::write(root.join(".nc-perf-harness"), format!("{TOKEN}\n")).unwrap();
            fs::set_permissions(root.join(".nc-perf-harness"), fs::Permissions::from_mode(0o600)).unwrap();
        }
        root
    }

    #[test]
    fn isolated_claim_has_no_user_cache_fallback() {
        let root = fixture(true);
        let resolve = |root, token| perf_cache_root(root, token);
        assert_eq!(resolve(Some(root.clone()), Some(TOKEN.into())).unwrap(), root.join("display-proxies"));
        assert!(resolve(None, Some(TOKEN.into())).is_err());
        assert!(resolve(Some(root.clone()), None).is_err());
        assert!(resolve(Some(PathBuf::from("relative")), Some(TOKEN.into())).is_err());
        assert!(resolve(Some(root.clone()), Some("wrong".into())).is_err());
        fs::write(root.join(".nc-perf-harness"), "different\n").unwrap();
        assert!(resolve(Some(root.clone()), Some(TOKEN.into())).is_err());
    }

    #[test]
    fn shared_permissions_and_symlink_claims_are_refused() {
        let root = fixture(true);
        fs::set_permissions(root.join(".nc-perf-harness"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(perf_cache_root(Some(root.clone()), Some(TOKEN.into())).is_err());
        fs::set_permissions(root.join(".nc-perf-harness"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(perf_cache_root(Some(root.clone()), Some(TOKEN.into())).is_err());
        let links = fixture(false);
        symlink(&root, links.join("root-link")).unwrap();
        symlink(root.join(".nc-perf-harness"), links.join(".nc-perf-harness")).unwrap();
        assert!(perf_cache_root(Some(links.join("root-link")), Some(TOKEN.into())).is_err());
        assert!(perf_cache_root(Some(links), Some(TOKEN.into())).is_err());
    }
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request.headers().get(name).and_then(|value| value.to_str().ok()).ok_or_else(|| format!("missing {name}"))
}

// Async commands with the file work on the blocking pool: a synchronous
// command runs on the native main thread.
#[tauri::command]
pub async fn display_proxy_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let scope = parse_scope(header(&request, "x-proxy-scope")?)?;
    let name = header(&request, "x-proxy-name")?.to_string();
    let offset: u64 = header(&request, "x-proxy-offset")?.parse().map_err(|_| "invalid offset")?;
    let last = header(&request, "x-proxy-last")? == "1";
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected a binary display proxy chunk".into()) };
    let bytes = bytes.clone();
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_chunk(&root, scope, &name, offset, &bytes, last))
        .await
        .map_err(|e| format!("display proxy write failed: {e}"))?
}

#[tauri::command]
pub async fn display_proxy_read(app: tauri::AppHandle, scope: String, name: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    let scope = parse_scope(&scope)?;
    let root = root_for(&app)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_chunk(&root, scope, &name, offset, length))
        .await
        .map_err(|e| format!("display proxy read failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn display_proxy_list(app: tauri::AppHandle, scope: String) -> Result<Vec<Entry>, String> {
    let scope = parse_scope(&scope)?;
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || list(&root, scope)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn display_proxy_delete(app: tauri::AppHandle, scope: String, name: String) -> Result<(), String> {
    let scope = parse_scope(&scope)?;
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete(&root, scope, &name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn display_proxy_clear(app: tauri::AppHandle, scope: String) -> Result<(), String> {
    let scope = parse_scope(&scope)?;
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || clear(&root, scope)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn display_proxy_space(app: tauri::AppHandle) -> Result<Space, String> {
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = fs::create_dir_all(&root);
        space(&root)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nc-display-proxy-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    const NAME: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn names_never_reach_outside_the_directory() {
        assert!(valid_name(NAME));
        assert!(valid_name("index"));
        for bad in ["../index", "index.ncdp", "", "0123", &NAME.to_uppercase(), &format!("{NAME}0"), "/etc/passwd", "a/b"] {
            assert!(!valid_name(bad), "{bad}");
        }
        let root = temp_root("names");
        assert!(write_chunk(&root, Scope::Store, "../escape", 0, b"x", true).is_err());
        assert!(read_chunk(&root, Scope::Store, "..", 0, 4).is_err());
        assert!(delete(&root, Scope::Spill, "x/y").is_err());
        assert!(parse_scope("other").is_err());
    }

    #[test]
    fn chunked_writes_rename_into_place_and_read_back() {
        let root = temp_root("roundtrip");
        prepare_root(&root).unwrap();
        let record: Vec<u8> = (0..20_000u32).map(|i| (i * 7 % 251) as u8).collect();
        assert_eq!(write_chunk(&root, Scope::Store, NAME, 0, &record[..9000], false).unwrap(), 9000);
        assert!(list(&root, Scope::Store).is_empty(), "a partial record is not listed");
        assert!(read_chunk(&root, Scope::Store, NAME, 0, 10).unwrap().is_empty(), "nor readable");
        assert!(write_chunk(&root, Scope::Store, NAME, 8000, &record[8000..], true).is_err(), "out-of-order chunks are refused");
        assert_eq!(write_chunk(&root, Scope::Store, NAME, 0, &record[..9000], false).unwrap(), 9000);
        assert_eq!(write_chunk(&root, Scope::Store, NAME, 9000, &record[9000..], true).unwrap(), 20_000);
        let mut back = read_chunk(&root, Scope::Store, NAME, 0, 12_000).unwrap();
        back.extend(read_chunk(&root, Scope::Store, NAME, 12_000, 12_000).unwrap());
        assert_eq!(back, record);
        let entries = list(&root, Scope::Store);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, NAME);
        assert_eq!(entries[0].bytes, 20_000);
        assert!(list(&root, Scope::Spill).is_empty(), "scopes are separate");
        delete(&root, Scope::Store, NAME).unwrap();
        assert!(list(&root, Scope::Store).is_empty());
        delete(&root, Scope::Store, NAME).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_run_drops_the_spill_and_keeps_the_store() {
        let root = temp_root("restart");
        prepare_root(&root).unwrap();
        write_chunk(&root, Scope::Store, NAME, 0, b"kept", true).unwrap();
        write_chunk(&root, Scope::Spill, NAME, 0, b"session", true).unwrap();
        write_chunk(&root, Scope::Store, "index", 0, b"half", false).unwrap();
        prepare_root(&root).unwrap();
        assert_eq!(list(&root, Scope::Store).len(), 1);
        assert!(list(&root, Scope::Spill).is_empty());
        assert!(!part_path(&root, Scope::Store, "index").unwrap().exists(), "interrupted writes are removed");
        assert!(root.join("CACHEDIR.TAG").exists());
        clear(&root, Scope::Store).unwrap();
        assert!(list(&root, Scope::Store).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resetting_page_owned_state_drops_the_spill_and_keeps_the_store() {
        let root = temp_root("page");
        prepare_root(&root).unwrap();
        write_chunk(&root, Scope::Store, NAME, 0, b"kept", true).unwrap();
        write_chunk(&root, Scope::Store, "index", 0, b"{}", true).unwrap();
        write_chunk(&root, Scope::Spill, NAME, 0, b"previous page", true).unwrap();
        write_chunk(&root, Scope::Spill, "index", 0, b"half", false).unwrap();
        assert_eq!(reset_spill(&root), 2, "a record and a partial write");
        assert!(list(&root, Scope::Spill).is_empty(), "the previous page's spill is gone");
        assert!(!part_path(&root, Scope::Spill, "index").unwrap().exists(), "with its partial writes");
        assert_eq!(list(&root, Scope::Store).len(), 2, "the store is kept");
        assert_eq!(read_chunk(&root, Scope::Store, NAME, 0, 16).unwrap(), b"kept");
        // The new page spills as before, and its own records go at the next reset.
        write_chunk(&root, Scope::Spill, NAME, 0, b"this page", true).unwrap();
        assert_eq!(read_chunk(&root, Scope::Spill, NAME, 0, 16).unwrap(), b"this page");
        assert_eq!(reset_spill(&root), 1);
        assert_eq!(reset_spill(&root), 0);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(reset_spill(&temp_root("page-none")), 0, "nothing to drop before the cache exists");
    }

    #[test]
    fn oversized_chunks_are_refused() {
        let root = temp_root("limits");
        let chunk = vec![0u8; CHUNK_LIMIT + 1];
        assert!(write_chunk(&root, Scope::Store, NAME, 0, &chunk, true).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn free_space_is_read_from_the_volume() {
        let root = temp_root("space");
        fs::create_dir_all(&root).unwrap();
        let space = space(&root);
        assert!(space.total_bytes.unwrap() > 0);
        assert!(space.free_bytes.unwrap() <= space.total_bytes.unwrap());
        let _ = fs::remove_dir_all(&root);
    }
}
