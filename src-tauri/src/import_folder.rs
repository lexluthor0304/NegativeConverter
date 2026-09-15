//! Session-scoped, non-recursive import grants. The native picker is the only
//! way to create a grant; every chunk is checked against that active grant.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{collections::HashMap, fs, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant, UNIX_EPOCH}};
use tauri::{Emitter, State};

#[derive(Default)]
pub struct ImportWatch { active: Mutex<Option<Active>> }
struct Active { directory: PathBuf, stop: Arc<AtomicBool>, session: String }
impl Drop for Active { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrival { path: String, name: String, size: u64, modified: String, session: String }
#[derive(Serialize)]
pub struct WatchResult { path: String, session: String }

pub fn supported(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|x| x.to_str()) else { return false; };
    if name.starts_with('.') || name.starts_with('~') { return false; }
    matches!(path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "heic" | "heif" | "hif" | "webp" | "bmp" | "dng" | "nef" | "nrw" | "cr2" | "cr3" | "arw" | "raf" | "rw2" | "raw" | "orf" | "pef")
}
fn fingerprint(path: &Path) -> Option<(u64, String)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 { return None; }
    Some((meta.len(), meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos().to_string()))
}
fn scoped(directory: &Path, path: &Path) -> bool {
    supported(path) && fs::symlink_metadata(path).map(|m| m.is_file() && !m.file_type().is_symlink()).unwrap_or(false)
        && path.canonicalize().ok().and_then(|p| p.parent().map(Path::to_path_buf)).as_deref() == Some(directory)
}
fn stable(previous: &(u64, String), current: &(u64, String), quiet: Duration) -> bool {
    previous == current && quiet >= Duration::from_secs(1)
}

#[tauri::command]
pub fn watch_import_folder(app: tauri::AppHandle, state: State<'_, ImportWatch>, import_existing: bool) -> Result<Option<WatchResult>, String> {
    let Some(picked) = rfd::FileDialog::new().pick_folder() else { return Ok(None); };
    let directory = picked.canonicalize().map_err(|e| e.to_string())?;
    let session = format!("{}", std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
    let stop = Arc::new(AtomicBool::new(false));
    // Keep the OS watcher alive on its worker thread. Notifications wake the
    // sampler; the timed rescan also catches a writer that renames atomically.
    let (send, recv) = std::sync::mpsc::channel();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| { let _ = send.send(event); }).map_err(|e| e.to_string())?;
    watcher.watch(&directory, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    let mut emitted = HashMap::new();
    if !import_existing {
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())?.flatten() {
            if let Some(fp) = fingerprint(&entry.path()) { emitted.insert(entry.path(), fp); }
        }
    }
    *state.active.lock().map_err(|e| e.to_string())? = Some(Active { directory: directory.clone(), stop: stop.clone(), session: session.clone() });
    let result = WatchResult { path: directory.to_string_lossy().into(), session: session.clone() };
    std::thread::spawn(move || {
        let _watcher = watcher;
        let mut pending: HashMap<PathBuf, ((u64, String), Instant)> = HashMap::new();
        while !stop.load(Ordering::Relaxed) {
            let _ = recv.recv_timeout(Duration::from_millis(250));
            while recv.try_recv().is_ok() {}
            let Ok(entries) = fs::read_dir(&directory) else { break; };
            for entry in entries.flatten() {
                let path = entry.path();
                if !scoped(&directory, &path) { continue; }
                let Some(fp) = fingerprint(&path) else { continue; };
                if emitted.get(&path) == Some(&fp) { continue; }
                let previous = pending.entry(path.clone()).or_insert_with(|| (fp.clone(), Instant::now()));
                if previous.0 != fp { *previous = (fp.clone(), Instant::now()); continue; }
                if stable(&previous.0, &fp, previous.1.elapsed()) && !stop.load(Ordering::Relaxed) {
                    let _ = app.emit("import-folder-file", Arrival { name: path.file_name().unwrap().to_string_lossy().into(), path: path.to_string_lossy().into(), size: fp.0, modified: fp.1.clone(), session: session.clone() });
                    emitted.insert(path.clone(), fp); pending.remove(&path);
                }
            }
            pending.retain(|path, _| path.exists());
        }
    });
    Ok(Some(result))
}
#[tauri::command]
pub fn stop_watch_import_folder(state: State<'_, ImportWatch>) -> Result<(), String> {
    *state.active.lock().map_err(|e| e.to_string())? = None; Ok(())
}
#[tauri::command]
pub fn read_import_file(state: State<'_, ImportWatch>, path: String, session: String, offset: u64, expected_size: u64, modified: String) -> Result<tauri::ipc::Response, String> {
    let grant = state.active.lock().map_err(|e| e.to_string())?;
    let active = grant.as_ref().ok_or("No active import folder")?;
    let path = PathBuf::from(path);
    if session != active.session || !scoped(&active.directory, &path) { return Err("Import path is outside the active grant".into()); }
    let bytes = read_scoped_chunk(&active.directory, &path, offset, expected_size, &modified)?;
    Ok(tauri::ipc::Response::new(bytes))
}
// Check the opened file as well as the pathname, so replacing a file with a
// symlink between the scope check and open cannot return an outside file.
fn read_scoped_chunk(directory: &Path, path: &Path, offset: u64, expected_size: u64, modified: &str) -> Result<Vec<u8>, String> {
    let expected = (expected_size, modified.to_owned());
    if !scoped(directory, path) || fingerprint(path) != Some(expected.clone()) || offset > expected_size { return Err("Import file changed while reading".into()); }
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() { return Err("Import file replaced while opening".into()); }
    }
    if !opened.is_file() || opened.len() != expected_size || opened.modified().ok() != before.modified().ok()
        || !scoped(directory, path) || fingerprint(path) != Some(expected.clone()) { return Err("Import file changed while opening".into()); }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let length = (expected_size - offset).min(1024 * 1024) as usize;
    let mut bytes = vec![0; length]; file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    if fingerprint(path) != Some(expected) || file.metadata().map_err(|e| e.to_string())?.modified().ok() != opened.modified().ok() { return Err("Import file changed while reading".into()); }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ignores_partial_and_hidden() { for p in [".scan.jpg", "scan.jpg.part", "scan.tmp", "~scan.png"] { assert!(!supported(Path::new(p))); } assert!(supported(Path::new("SCAN.HEIC"))); }
    #[test] fn waits_for_stable_size_and_mtime() { let a = (4, "1".into()); assert!(!stable(&a, &a, Duration::from_millis(999))); assert!(stable(&a, &a, Duration::from_secs(1))); assert!(!stable(&a, &(5, "1".into()), Duration::from_secs(2))); assert!(!stable(&a, &(4, "2".into()), Duration::from_secs(2))); }
    #[test] fn dropped_grant_stops_watch() { let stop = Arc::new(AtomicBool::new(false)); { let _active = Active { directory: PathBuf::new(), session: "a".into(), stop: stop.clone() }; } assert!(stop.load(Ordering::Relaxed)); }
    #[test] fn chunks_reject_changed_files_and_symlinks() {
        let dir = std::env::temp_dir().join(format!("nc-import-chunks-{}", std::process::id())); fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap(); let path = root.join("scan.jpg");
        fs::write(&path, vec![7; 1024 * 1024 + 17]).unwrap(); let fp = fingerprint(&path).unwrap();
        assert_eq!(read_scoped_chunk(&root, &path, 0, fp.0, &fp.1).unwrap().len(), 1024 * 1024);
        assert_eq!(read_scoped_chunk(&root, &path, 1024 * 1024, fp.0, &fp.1).unwrap(), vec![7; 17]);
        assert!(read_scoped_chunk(&root, &path, fp.0 + 1, fp.0, &fp.1).is_err());
        fs::write(&path, [2]).unwrap(); assert!(read_scoped_chunk(&root, &path, 0, fp.0, &fp.1).is_err());
        #[cfg(unix)] { let link = root.join("link.jpg"); std::os::unix::fs::symlink(&path, &link).unwrap(); let fp = fingerprint(&path).unwrap(); assert!(read_scoped_chunk(&root, &link, 0, fp.0, &fp.1).is_err()); }
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn scope_is_direct_child_only() {
        let dir = std::env::temp_dir().join(format!("nc-import-test-{}", std::process::id())); fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("scan.jpg"), [1]).unwrap(); fs::write(dir.join("nested/scan.jpg"), [1]).unwrap();
        let root = dir.canonicalize().unwrap(); assert!(scoped(&root, &dir.join("scan.jpg"))); assert!(!scoped(&root, &dir.join("nested/scan.jpg")));
        #[cfg(unix)] { std::os::unix::fs::symlink(dir.join("scan.jpg"), dir.join("link.jpg")).unwrap(); assert!(!scoped(&root, &dir.join("link.jpg"))); }
        fs::remove_dir_all(dir).unwrap();
    }
}
