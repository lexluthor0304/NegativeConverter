//! iOS and Android stand-ins for the desktop watch folder (import_folder.rs,
//! #298): there is no folder picker (rfd has no mobile backend) and nothing
//! to watch inside the sandbox. The commands the page invokes say so, and the
//! state the page-load hook resets is an empty shell.
use tauri::State;

#[derive(Default)]
pub struct ImportWatch;

impl ImportWatch {
    pub fn stop(&self) {}
}

const UNAVAILABLE: &str = "the watch folder is not available on this platform";

#[tauri::command]
pub fn watch_import_folder(_state: State<'_, ImportWatch>) -> Result<Option<()>, String> {
    Err(UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn stop_watch_import_folder(_state: State<'_, ImportWatch>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn read_import_file(_state: State<'_, ImportWatch>) -> Result<tauri::ipc::Response, String> {
    Err(UNAVAILABLE.to_string())
}
