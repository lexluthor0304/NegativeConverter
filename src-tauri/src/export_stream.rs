use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const CHUNK_LIMIT: usize = 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct PendingExport {
    target: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    expected: u64,
    written: u64,
}

impl Drop for PendingExport {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.temporary);
    }
}

impl PendingExport {
    fn create(target: PathBuf, expected: u64, id: &str) -> Result<Self, String> {
        let parent = target.parent().ok_or("export path has no parent")?;
        // MASの保存パネルがファイルのみを許可する場合は、一時ディレクトリへ退避する。
        let candidates = [parent.to_path_buf(), std::env::temp_dir()];
        for directory in candidates {
            for attempt in 0..4 {
                let temporary = directory.join(format!(".nc-export-{}-{id}-{attempt}.part", std::process::id()));
                if let Ok(file) = OpenOptions::new().write(true).create_new(true).open(&temporary) {
                    return Ok(Self { target, temporary, file: Some(file), expected, written: 0 });
                }
            }
        }
        Err("could not create export staging file".into())
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > CHUNK_LIMIT || bytes.len() as u64 > self.expected.saturating_sub(self.written) {
            return Err("export chunk exceeds declared size or chunk limit".into());
        }
        self.file.as_mut().ok_or("export is closed")?.write_all(bytes)
            .map_err(|err| format!("write export chunk failed: {err}"))?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<PathBuf, String> {
        if self.written != self.expected { return Err("export is incomplete".into()); }
        self.file.take().ok_or("export is closed")?.sync_all()
            .map_err(|err| format!("sync export failed: {err}"))?;
        if std::fs::rename(&self.temporary, &self.target).is_err() {
            // 別ファイルシステム/MASでも、全データをメモリへ戻さずコピーする。
            std::fs::copy(&self.temporary, &self.target)
                .map_err(|err| format!("copy staged export failed: {err}"))?;
            OpenOptions::new().write(true).open(&self.target)
                .and_then(|file| file.sync_all()).map_err(|err| format!("sync target failed: {err}"))?;
        }
        Ok(self.target.clone())
    }
}

#[derive(Default)]
pub struct ExportStreams(Mutex<HashMap<String, PendingExport>>);

impl ExportStreams {
    pub fn begin(&self, target: &Path, expected: u64) -> Result<String, String> {
        let mut streams = self.0.lock().map_err(|_| "export state unavailable")?;
        if streams.len() >= 4 { return Err("too many pending exports".into()); }
        if streams.values().any(|stream| stream.target == target) {
            return Err("export destination is already being written".into());
        }
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
        streams.insert(id.clone(), PendingExport::create(target.to_path_buf(), expected, &id)?);
        Ok(id)
    }

    pub fn append(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let mut streams = self.0.lock().map_err(|_| "export state unavailable")?;
        let result = streams.get_mut(id).ok_or("unknown export")?.append(bytes);
        if result.is_err() { streams.remove(id); }
        result
    }

    pub fn take(&self, id: &str) -> Result<PendingExport, String> {
        self.0.lock().map_err(|_| "export state unavailable")?.remove(id).ok_or("unknown export".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("nc-stream-test-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn chunks_commit_only_when_complete_and_keep_target_until_commit() {
        let dir = directory(); let path = dir.join("result.png");
        std::fs::write(&path, b"old").unwrap();
        let streams = ExportStreams::default();
        let id = streams.begin(&path, 6).unwrap();
        streams.append(&id, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        streams.append(&id, b"123").unwrap();
        streams.take(&id).unwrap().finish().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new123");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn abort_incomplete_and_oversized_chunks_preserve_existing_file() {
        let dir = directory(); let path = dir.join("result.tiff");
        std::fs::write(&path, b"old").unwrap();
        let streams = ExportStreams::default();
        let id = streams.begin(&path, 6).unwrap();
        streams.append(&id, b"new").unwrap();
        assert!(streams.take(&id).unwrap().finish().is_err());
        let id = streams.begin(&path, 2).unwrap();
        assert!(streams.append(&id, b"too long").is_err());
        assert!(streams.take(&id).is_err());
        let id = streams.begin(&path, 2).unwrap();
        drop(streams.take(&id).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(streams.append("missing", b"x").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn streams_enforce_chunk_limit_and_release_staging_files_on_drop() {
        let dir = directory();
        let streams = ExportStreams::default();
        let path = dir.join("large.tiff");
        let id = streams.begin(&path, (CHUNK_LIMIT * 2) as u64).unwrap();
        assert!(streams.append(&id, &vec![0; CHUNK_LIMIT + 1]).is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        for i in 0..4 { streams.begin(&dir.join(format!("{i}.png")), 0).unwrap(); }
        assert!(streams.begin(&dir.join("extra.png"), 0).is_err());
        assert!(streams.begin(&dir.join("0.png"), 0).is_err());
        drop(streams);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn multiple_binary_chunks_and_empty_exports_round_trip() {
        let dir = directory();
        let streams = ExportStreams::default();
        let bytes: Vec<u8> = (0..CHUNK_LIMIT * 2 + 17).map(|i| (i % 251) as u8).collect();
        let path = dir.join("large.tiff");
        let id = streams.begin(&path, bytes.len() as u64).unwrap();
        for chunk in bytes.chunks(CHUNK_LIMIT) { streams.append(&id, chunk).unwrap(); }
        streams.take(&id).unwrap().finish().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let path = dir.join("empty");
        let id = streams.begin(&path, 0).unwrap();
        streams.take(&id).unwrap().finish().unwrap();
        assert_eq!(std::fs::metadata(path).unwrap().len(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
