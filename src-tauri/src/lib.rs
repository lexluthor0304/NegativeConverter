use base64::Engine;
use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_export_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
