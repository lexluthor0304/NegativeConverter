//! App-owned originals and two atomic recovery checkpoints (#298 P2).
//! Paths never cross IPC. A page gets a lease; reload revokes it so a late
//! write from a dead WebContent process cannot replace the new page's work.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::Manager;

pub const CHUNK_LIMIT: usize = 1024 * 1024;
const SOURCE_LIMIT: u64 = 512 * 1024 * 1024;
const SNAPSHOT_LIMIT: usize = 16 * 1024 * 1024;
const FILE_LIMIT: usize = 256;
const SPACE_FLOOR: u64 = 512 * 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
fn new_id() -> String {
    format!(
        "{:016x}{:016x}",
        now_ms(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn io_error(e: std::io::Error) -> String {
    format!("Recovery storage: {e}")
}
fn regular_file(path: &Path) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(io_error)?;
    if !meta.file_type().is_file() {
        return Err("Recovery storage is not a regular file".into());
    }
    Ok(meta)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub name: String,
    pub size: u64,
    pub last_modified: u64,
    pub mime_type: String,
}
impl SourceInfo {
    fn validate(&self) -> Result<(), String> {
        if self.name.is_empty()
            || self.name.len() > 1024
            || self.name.contains(['/', '\\', '\0'])
            || self.name == "."
            || self.name == ".."
            || self.mime_type.len() > 256
            || self.size == 0
            || self.size > SOURCE_LIMIT
        {
            return Err("Invalid or oversized recovery source".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    version: u32,
    pub revision: u64,
    pub saved_at: u64,
    pub project: String,
    pub source_ids: Vec<String>,
    pub queue_ids: Vec<String>,
    pub active_index: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    session: String,
    revision: u64,
    checkpoint: Option<Checkpoint>,
    sources: Vec<SourceInfo>,
    recovered_previous: bool,
}
#[derive(Deserialize, Serialize)]
struct SavedSource {
    #[serde(flatten)]
    info: SourceInfo,
    sha256: String,
}
struct Pending {
    info: SourceInfo,
    path: PathBuf,
    file: File,
    written: u64,
    digest: Sha256,
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct Store {
    root: PathBuf,
    session: String,
    revision: u64,
    pending: HashMap<String, Pending>,
    // Originals completed during this page stay until a checkpoint owns them
    // or the page closes. A failed checkpoint can retry without copying again.
    uncommitted: HashSet<String>,
}

fn atomic_json(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing recovery directory")?;
    let temp = parent.join(format!("{}.part", new_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io_error)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(io_error)?;
        drop(file);
        // There is deliberately no in-place fallback on failure.
        fs::rename(&temp, path).map_err(io_error)?;
        sync_directory(parent)
    })();
    let _ = fs::remove_file(&temp);
    result
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(io_error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

impl Store {
    fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("sources")).map_err(io_error)?;
        for path in [&root, &root.join("sources")] {
            if !fs::symlink_metadata(path)
                .map_err(io_error)?
                .file_type()
                .is_dir()
            {
                return Err("Invalid recovery directory".into());
            }
        }
        Ok(Self {
            root,
            session: String::new(),
            revision: 0,
            pending: HashMap::new(),
            uncommitted: HashSet::new(),
        })
    }
    fn source_path(&self, id: &str, extension: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid recovery source id".into());
        }
        Ok(self.root.join("sources").join(format!("{id}.{extension}")))
    }
    fn source_info(&self, id: &str) -> Result<SourceInfo, String> {
        let path = self.source_path(id, "json")?;
        if regular_file(&path)?.len() > 4096 {
            return Err("Invalid recovery source metadata".into());
        }
        let saved: SavedSource = serde_json::from_slice(&fs::read(path).map_err(io_error)?)
            .map_err(|e| e.to_string())?;
        let info = saved.info;
        info.validate()?;
        if regular_file(&self.source_path(id, "bin")?)?.len() != info.size {
            return Err("Incomplete recovery source".into());
        }
        Ok(info)
    }
    fn validate_checkpoint(&self, c: &Checkpoint) -> Result<(), String> {
        if c.version != 1
            || c.revision == 0
            || c.project.len() > SNAPSHOT_LIMIT
            || c.source_ids.len() > FILE_LIMIT
            || c.source_ids.len() != c.queue_ids.len()
            || c.queue_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 2048)
            || c.queue_ids.iter().collect::<HashSet<_>>().len() != c.queue_ids.len()
            || c.source_ids.iter().collect::<HashSet<_>>().len() != c.source_ids.len()
            || (!c.source_ids.is_empty() && c.active_index >= c.source_ids.len())
        {
            return Err("Invalid recovery checkpoint".into());
        }
        let project: serde_json::Value =
            serde_json::from_str(&c.project).map_err(|e| e.to_string())?;
        let files = project["files"]
            .as_array()
            .ok_or("Invalid recovery project")?;
        if project["kind"] != "neoanaloglab-roll"
            || project["version"] != 1
            || files.len() != c.source_ids.len()
        {
            return Err("Unsupported recovery project".into());
        }
        for (entry, id) in files.iter().zip(&c.source_ids) {
            let info = self.source_info(id)?;
            if entry["name"].as_str() != Some(&info.name)
                || entry["size"].as_u64() != Some(info.size)
            {
                return Err("Recovery original does not match its project entry".into());
            }
        }
        Ok(())
    }
    fn checkpoints(&self) -> Result<(Vec<Checkpoint>, bool), String> {
        let mut valid = Vec::new();
        let mut invalid = false;
        for slot in 0..2 {
            let path = self.root.join(format!("checkpoint-{slot}.json"));
            if !path.exists() {
                continue;
            }
            // A downgrade must not silently fall back and then overwrite a
            // future schema. Leave all files for the newer application.
            if regular_file(&path).is_ok_and(|m| m.len() <= (SNAPSHOT_LIMIT * 2) as u64) {
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if value["version"].as_u64().is_some_and(|version| version > 1) {
                            return Err(
                                "Recovery was saved by a newer app; originals were preserved"
                                    .into(),
                            );
                        }
                    }
                }
            }
            let read = || -> Result<Checkpoint, String> {
                if regular_file(&path)?.len() > (SNAPSHOT_LIMIT * 2) as u64 {
                    return Err("Oversized checkpoint".into());
                }
                let c: Checkpoint = serde_json::from_slice(&fs::read(&path).map_err(io_error)?)
                    .map_err(|e| e.to_string())?;
                self.validate_checkpoint(&c)?;
                Ok(c)
            };
            match read() {
                Ok(c) => valid.push(c),
                Err(_) => invalid = true,
            }
        }
        if valid.is_empty() && invalid {
            return Err("Recovery checkpoints are unreadable; originals were preserved".into());
        }
        valid.sort_by_key(|c| c.revision);
        Ok((valid, invalid))
    }
    fn invalidate(&mut self) {
        self.session.clear();
        self.pending.clear();
        self.uncommitted.clear();
    }
    fn open(&mut self) -> Result<Opened, String> {
        self.invalidate();
        let (mut checkpoints, recovered_previous) = self.checkpoints()?;
        // A corrupt generation may name originals we cannot parse. Preserve
        // those too until a later successful commit replaces that slot.
        if !recovered_previous {
            self.collect(&checkpoints)?;
        }
        let checkpoint = checkpoints.pop();
        self.revision = checkpoint.as_ref().map(|c| c.revision).unwrap_or(0);
        self.session = new_id();
        let sources = checkpoint
            .as_ref()
            .map(|c| {
                c.source_ids
                    .iter()
                    .map(|id| self.source_info(id))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Opened {
            session: self.session.clone(),
            revision: self.revision,
            checkpoint,
            sources,
            recovered_previous,
        })
    }
    fn check_session(&self, session: &str) -> Result<(), String> {
        if self.session.is_empty() || self.session != session {
            return Err("Recovery page lease expired".into());
        }
        Ok(())
    }
    fn begin(&mut self, info: SourceInfo, free: Option<u64>) -> Result<String, String> {
        info.validate()?;
        if !self.pending.is_empty() {
            return Err("A recovery copy is already running".into());
        }
        if free.is_none_or(|free| free < info.size.saturating_add(SPACE_FLOOR)) {
            return Err("Not enough free space to preserve the original".into());
        }
        // create_new also protects against the clock/counter repeating after
        // an app restart; a collision never replaces an existing original.
        for _ in 0..8 {
            let id = new_id();
            if self.source_path(&id, "bin")?.exists() || self.source_path(&id, "json")?.exists() {
                continue;
            }
            let path = self.source_path(&id, "part")?;
            let file = match OpenOptions::new().create_new(true).write(true).open(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_error(e)),
            };
            self.pending.insert(
                id.clone(),
                Pending {
                    info,
                    path,
                    file,
                    written: 0,
                    digest: Sha256::new(),
                },
            );
            return Ok(id);
        }
        Err("Could not create a recovery source".into())
    }
    fn append(&mut self, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let pending = self.pending.get_mut(id).ok_or("Unknown recovery copy")?;
        if bytes.is_empty()
            || bytes.len() > CHUNK_LIMIT
            || pending.written != offset
            || pending.written.saturating_add(bytes.len() as u64) > pending.info.size
        {
            return Err("Invalid or out-of-order recovery chunk".into());
        }
        pending.file.write_all(bytes).map_err(io_error)?;
        pending.digest.update(bytes);
        pending.written += bytes.len() as u64;
        Ok(())
    }
    fn finish(&mut self, id: &str) -> Result<(), String> {
        let pending = self.pending.remove(id).ok_or("Unknown recovery copy")?;
        if pending.written != pending.info.size {
            return Err("Incomplete recovery copy".into());
        }
        pending.file.sync_all().map_err(io_error)?;
        let path = self.source_path(id, "bin")?;
        fs::rename(&pending.path, &path).map_err(io_error)?;
        let saved = SavedSource {
            info: pending.info.clone(),
            sha256: format!("{:x}", pending.digest.clone().finalize()),
        };
        let meta = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
        if let Err(e) = atomic_json(&self.source_path(id, "json")?, &meta) {
            let _ = fs::remove_file(path);
            return Err(e);
        }
        self.uncommitted.insert(id.to_owned());
        Ok(())
    }
    fn commit(
        &mut self,
        project: String,
        source_ids: Vec<String>,
        queue_ids: Vec<String>,
        active_index: usize,
        expected_revision: u64,
    ) -> Result<Checkpoint, String> {
        if expected_revision != self.revision {
            return Err("Recovery checkpoint changed; refusing a stale write".into());
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or("Recovery revision overflow")?;
        let checkpoint = Checkpoint {
            version: 1,
            revision,
            saved_at: now_ms(),
            project,
            source_ids,
            queue_ids,
            active_index,
        };
        self.validate_checkpoint(&checkpoint)?;
        let bytes = serde_json::to_vec(&checkpoint).map_err(|e| e.to_string())?;
        let path = self.root.join(format!("checkpoint-{}.json", revision % 2));
        atomic_json(&path, &bytes)?;
        self.revision = revision;
        self.uncommitted.clear();
        // GC is best effort after the durable commit. Both valid generations
        // keep their originals, so a damaged newest checkpoint can fall back.
        if let Ok((checkpoints, false)) = self.checkpoints() {
            let _ = self.collect(&checkpoints);
        }
        Ok(checkpoint)
    }
    fn collect(&self, checkpoints: &[Checkpoint]) -> Result<(), String> {
        let mut keep: HashSet<&str> = checkpoints
            .iter()
            .flat_map(|c| c.source_ids.iter().map(String::as_str))
            .collect();
        keep.extend(self.uncommitted.iter().map(String::as_str));
        keep.extend(self.pending.keys().map(String::as_str));
        for entry in fs::read_dir(self.root.join("sources")).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            // Only our exact filenames and regular files may be reclaimed.
            if valid_id(id)
                && !keep.contains(id)
                && entry.file_type().map_err(io_error)?.is_file()
                && matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("bin" | "json" | "part")
                )
            {
                fs::remove_file(path).map_err(io_error)?;
            }
        }
        for entry in fs::read_dir(&self.root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("part")
                && valid_id(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
                && entry.file_type().map_err(io_error)?.is_file()
            {
                fs::remove_file(path).map_err(io_error)?;
            }
        }
        Ok(())
    }
    fn read(&self, id: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        let info = self.source_info(id)?;
        if length == 0
            || length > CHUNK_LIMIT
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > info.size)
        {
            return Err("Invalid recovery read range".into());
        }
        let mut file = File::open(self.source_path(id, "bin")?).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(io_error)?;
        Ok(bytes)
    }
    fn verify(&self, id: &str) -> Result<(), String> {
        self.source_info(id)?;
        let saved: SavedSource =
            serde_json::from_slice(&fs::read(self.source_path(id, "json")?).map_err(io_error)?)
                .map_err(|e| e.to_string())?;
        let mut file = File::open(self.source_path(id, "bin")?).map_err(io_error)?;
        let mut digest = Sha256::new();
        let mut bytes = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut bytes).map_err(io_error)?;
            if count == 0 {
                break;
            }
            digest.update(&bytes[..count]);
        }
        if format!("{:x}", digest.finalize()) != saved.sha256 {
            return Err("Recovery original checksum does not match; source preserved".into());
        }
        Ok(())
    }
    fn clear(&mut self, expected_revision: u64) -> Result<Checkpoint, String> {
        let empty = r#"{"kind":"neoanaloglab-roll","version":1,"files":[],"roll":{}}"#.to_owned();
        let first = self.commit(empty.clone(), vec![], vec![], 0, expected_revision)?;
        // Once the first empty checkpoint is durable, old work will no longer
        // reopen. Replacing the second slot releases its retained originals.
        let second = self.commit(empty, vec![], vec![], 0, first.revision)?;
        self.pending.clear();
        self.uncommitted.clear();
        let (checkpoints, _) = self.checkpoints()?;
        self.collect(&checkpoints)?;
        Ok(second)
    }
}

#[derive(Default)]
pub struct MobileRecovery(Mutex<Option<Store>>);
impl MobileRecovery {
    pub fn invalidate(&self) {
        if let Ok(mut store) = self.0.lock() {
            if let Some(store) = store.as_mut() {
                store.invalidate();
            }
        }
    }
}
async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    session: Option<String>,
    action: impl FnOnce(&mut Store) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if !cfg!(mobile) {
        return Err("Original recovery is available in the mobile shell only".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MobileRecovery>();
        let mut guard = state.0.lock().map_err(|_| "Recovery storage unavailable")?;
        if guard.is_none() {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("mobile-recovery-v1");
            *guard = Some(Store::new(root)?);
        }
        let store = guard.as_mut().ok_or("Recovery storage unavailable")?;
        if let Some(session) = session {
            store.check_session(&session)?;
        }
        action(store)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_recovery_open(app: tauri::AppHandle) -> Result<Opened, String> {
    with_store(app, None, Store::open).await
}
#[tauri::command]
pub async fn mobile_recovery_begin(
    app: tauri::AppHandle,
    session: String,
    info: SourceInfo,
) -> Result<String, String> {
    with_store(app, Some(session), move |s| {
        s.begin(info, crate::display_proxy_store::space(&s.root).free_bytes)
    })
    .await
}
#[tauri::command]
pub async fn mobile_recovery_append(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or("Missing recovery chunk header")
    };
    let session = header("x-recovery-session")?;
    let id = header("x-source-id")?;
    let offset = header("x-source-offset")?
        .parse::<u64>()
        .map_err(|_| "Invalid recovery offset")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary recovery chunk".into());
    };
    if bytes.len() > CHUNK_LIMIT {
        return Err("Recovery chunk too large".into());
    }
    let bytes = bytes.clone();
    with_store(app, Some(session), move |s| s.append(&id, offset, &bytes)).await
}
#[tauri::command]
pub async fn mobile_recovery_finish(
    app: tauri::AppHandle,
    session: String,
    id: String,
) -> Result<(), String> {
    with_store(app, Some(session), move |s| s.finish(&id)).await
}
#[tauri::command]
pub async fn mobile_recovery_abort(
    app: tauri::AppHandle,
    session: String,
    id: String,
) -> Result<(), String> {
    with_store(app, Some(session), move |s| {
        s.pending.remove(&id);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn mobile_recovery_commit(
    app: tauri::AppHandle,
    session: String,
    project: String,
    source_ids: Vec<String>,
    queue_ids: Vec<String>,
    active_index: usize,
    expected_revision: u64,
) -> Result<Checkpoint, String> {
    with_store(app, Some(session), move |s| {
        s.commit(
            project,
            source_ids,
            queue_ids,
            active_index,
            expected_revision,
        )
    })
    .await
}
#[tauri::command]
pub async fn mobile_recovery_read(
    app: tauri::AppHandle,
    session: String,
    id: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    with_store(app, Some(session), move |s| {
        s.read(&id, offset, length).map(tauri::ipc::Response::new)
    })
    .await
}
#[tauri::command]
pub async fn mobile_recovery_verify(
    app: tauri::AppHandle,
    session: String,
    id: String,
) -> Result<(), String> {
    with_store(app, Some(session), move |s| s.verify(&id)).await
}
#[tauri::command]
pub async fn mobile_recovery_clear(
    app: tauri::AppHandle,
    session: String,
    expected_revision: u64,
) -> Result<Checkpoint, String> {
    with_store(app, Some(session), move |s| s.clear(expected_revision)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(Store);
    impl Fixture {
        fn new() -> Self {
            Self(
                Store::new(std::env::temp_dir().join(format!("nc-recovery-{}", new_id()))).unwrap(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.root);
        }
    }
    fn source(s: &mut Store, name: &str, bytes: &[u8]) -> String {
        let id = s
            .begin(
                SourceInfo {
                    name: name.into(),
                    size: bytes.len() as u64,
                    last_modified: 1,
                    mime_type: "image/png".into(),
                },
                Some(u64::MAX),
            )
            .unwrap();
        s.append(&id, 0, bytes).unwrap();
        s.finish(&id).unwrap();
        id
    }
    fn checkpoint(s: &mut Store, ids: &[String], edit: u32) -> Checkpoint {
        let files: Vec<_> = ids
            .iter()
            .map(|id| {
                let info = s.source_info(id).unwrap();
                serde_json::json!({"name":info.name,"size":info.size,"settings":{"exposure":edit}})
            })
            .collect();
        s.commit(
            serde_json::json!({"kind":"neoanaloglab-roll","version":1,"files":files}).to_string(),
            ids.to_vec(),
            ids.to_vec(),
            0,
            s.revision,
        )
        .unwrap()
    }
    #[test]
    fn restart_restores_exact_originals_and_latest_recipe() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "same.png", b"first");
        let b = source(&mut f.0, "same.png", b"other");
        let saved = checkpoint(&mut f.0, &[a.clone(), b.clone()], 2);
        let mut restarted = Store::new(f.0.root.clone()).unwrap();
        let opened = restarted.open().unwrap();
        assert_eq!(opened.checkpoint.unwrap().project, saved.project);
        assert_eq!(opened.sources.len(), 2);
        assert_eq!(restarted.read(&a, 0, 5).unwrap(), b"first");
        assert_eq!(restarted.read(&b, 0, 5).unwrap(), b"other");
    }
    #[test]
    fn torn_latest_checkpoint_falls_back_and_keeps_both_originals() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"old");
        checkpoint(&mut f.0, &[a.clone()], 1);
        let b = source(&mut f.0, "b.png", b"new");
        checkpoint(&mut f.0, &[b.clone()], 2);
        fs::write(f.0.root.join("checkpoint-0.json"), b"{torn").unwrap();
        let opened = f.0.open().unwrap();
        assert!(opened.recovered_previous);
        assert_eq!(opened.checkpoint.unwrap().source_ids, vec![a.clone()]);
        assert_eq!(f.0.read(&a, 0, 3).unwrap(), b"old");
    }
    #[test]
    fn incomplete_source_never_replaces_checkpoint_and_reload_revokes_writes() {
        let mut f = Fixture::new();
        let lease = f.0.open().unwrap().session;
        let a = source(&mut f.0, "a.png", b"old");
        checkpoint(&mut f.0, &[a.clone()], 1);
        let id =
            f.0.begin(
                SourceInfo {
                    name: "broken.png".into(),
                    size: 5,
                    last_modified: 0,
                    mime_type: "".into(),
                },
                Some(u64::MAX),
            )
            .unwrap();
        f.0.append(&id, 0, b"xx").unwrap();
        assert!(f.0.finish(&id).is_err());
        assert!(!f.0.source_path(&id, "part").unwrap().exists());
        f.0.invalidate();
        assert!(f.0.check_session(&lease).is_err());
        let opened = f.0.open().unwrap();
        assert_ne!(lease, opened.session);
        assert_eq!(opened.checkpoint.unwrap().source_ids, vec![a]);
    }
    #[test]
    fn rejects_stale_revision_bad_ranges_and_path_traversal() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"data");
        let saved = checkpoint(&mut f.0, &[a.clone()], 1);
        assert!(f
            .0
            .commit(saved.project, vec![a.clone()], vec![a.clone()], 0, 0)
            .is_err());
        for id in [
            "../checkpoint-1",
            "/etc/passwd",
            "",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(f.0.read(id, 0, 1).is_err());
        }
        assert!(f.0.read(&a, u64::MAX, 1).is_err());
        assert!(f.0.read(&a, 0, CHUNK_LIMIT + 1).is_err());
        assert!(f.0.read(&a, 3, 2).is_err());
    }
    #[test]
    fn ordered_chunks_and_low_disk_refusal_preserve_previous_work() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let info = SourceInfo {
            name: "a.png".into(),
            size: 4,
            last_modified: 0,
            mime_type: "".into(),
        };
        assert!(f.0.begin(info.clone(), Some(SPACE_FLOOR)).is_err());
        assert!(f.0.begin(info.clone(), None).is_err());
        let id = f.0.begin(info, Some(u64::MAX)).unwrap();
        assert!(f.0.append(&id, 1, b"xx").is_err());
        f.0.append(&id, 0, b"ab").unwrap();
        assert!(f.0.append(&id, 0, b"ab").is_err());
        f.0.append(&id, 2, b"cd").unwrap();
        f.0.finish(&id).unwrap();
        assert_eq!(f.0.read(&id, 0, 4).unwrap(), b"abcd");
    }
    #[test]
    fn failed_atomic_replace_preserves_valid_checkpoint() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"old");
        let saved = checkpoint(&mut f.0, &[a.clone()], 1);
        fs::create_dir(f.0.root.join("checkpoint-0.json")).unwrap();
        assert!(f
            .0
            .commit(
                saved.project.clone(),
                vec![a.clone()],
                vec![a],
                0,
                saved.revision
            )
            .is_err());
        assert_eq!(f.0.revision, saved.revision);
        assert_eq!(
            f.0.open().unwrap().checkpoint.unwrap().project,
            saved.project
        );
    }
    #[test]
    fn garbage_collection_retains_previous_generation_then_clear_reclaims_sources() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"old");
        checkpoint(&mut f.0, &[a.clone()], 1);
        let b = source(&mut f.0, "b.png", b"new");
        checkpoint(&mut f.0, &[b.clone()], 2);
        assert!(f.0.source_info(&a).is_ok());
        checkpoint(&mut f.0, &[b], 3);
        assert!(f.0.source_info(&a).is_err());
        let revision = f.0.revision;
        f.0.clear(revision).unwrap();
        assert_eq!(fs::read_dir(f.0.root.join("sources")).unwrap().count(), 0);
        assert!(f
            .0
            .open()
            .unwrap()
            .checkpoint
            .unwrap()
            .source_ids
            .is_empty());
    }
    #[test]
    fn no_valid_checkpoint_never_deletes_originals() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"original");
        checkpoint(&mut f.0, &[a.clone()], 1);
        fs::write(f.0.root.join("checkpoint-1.json"), b"broken").unwrap();
        assert!(f.0.open().is_err());
        assert!(f.0.source_info(&a).is_ok());
    }
    #[test]
    fn same_size_corruption_is_detected_before_restore() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"original");
        checkpoint(&mut f.0, &[a.clone()], 1);
        f.0.verify(&a).unwrap();
        fs::write(f.0.source_path(&a, "bin").unwrap(), b"damaged!").unwrap();
        assert!(f.0.verify(&a).is_err());
        assert!(f.0.source_path(&a, "bin").unwrap().exists());
    }
    #[test]
    fn future_schema_prevents_downgrade_overwrite() {
        let mut f = Fixture::new();
        f.0.open().unwrap();
        let a = source(&mut f.0, "a.png", b"original");
        checkpoint(&mut f.0, &[a.clone()], 1);
        fs::write(f.0.root.join("checkpoint-0.json"), br#"{"version":2}"#).unwrap();
        assert!(f.0.open().is_err());
        assert!(f.0.source_info(&a).is_ok());
    }
}
