//! Physical memory for the page's memory budget (#258).
//!
//! WKWebView and WebKitGTK implement no `navigator.deviceMemory`, so without
//! this the desktop app plans every job for an unknown machine. The page
//! sizes its renderer-wide budget from `totalBytes` and picks its idle policy
//! from `engine` (WebKit's 30 s memory monitor purges caches and JIT code
//! above 1.5 GiB on macOS and Linux; WebView2 has no such monitor).
//!
//! macOS reads `hw.memsize`, which the App Store sandbox allows. #252 uses
//! the same command and signature.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: Option<u64>,
    /// "wkwebview" | "webkitgtk" | "webview2"
    pub engine: &'static str,
}

/// The webview engine of this build.
pub fn webview_engine() -> &'static str {
    if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "wkwebview"
    } else if cfg!(target_os = "windows") {
        "webview2"
    } else {
        "webkitgtk"
    }
}

/// `MemTotal` and `MemAvailable` of a `/proc/meminfo` text, in bytes.
/// `MemAvailable` is missing on kernels before 3.14. (Tested on every host.)
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_meminfo(text: &str) -> Option<(u64, Option<u64>)> {
    let field = |name: &str| -> Option<u64> {
        text.lines().find_map(|line| {
            let rest = line.strip_prefix(name)?.strip_prefix(':')?;
            let mut parts = rest.split_whitespace();
            let value: u64 = parts.next()?.parse().ok()?;
            let scale = match parts.next() {
                Some(unit) if unit.eq_ignore_ascii_case("kb") => 1024,
                Some(unit) if unit.eq_ignore_ascii_case("mb") => 1024 * 1024,
                Some(unit) if unit.eq_ignore_ascii_case("gb") => 1024 * 1024 * 1024,
                None => 1,
                Some(_) => return None,
            };
            value.checked_mul(scale)
        })
    };
    let total = field("MemTotal").filter(|value| *value > 0)?;
    Some((total, field("MemAvailable")))
}

/// WebKitGTK's `memory-limit` (MB) that would move the Strict threshold from
/// 1.5 GiB to about 4 GiB on a 16 GB machine: half of `MemTotal`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn webkitgtk_memory_limit_mb(total_bytes: u64) -> u32 {
    let mb = total_bytes / 2 / (1024 * 1024);
    u32::try_from(mb).unwrap_or(u32::MAX)
}

#[cfg(target_os = "macos")]
fn read_physical_memory() -> Result<(u64, Option<u64>), String> {
    let mut total: u64 = 0;
    let mut length = std::mem::size_of::<u64>();
    let name = c"hw.memsize";
    // SAFETY: `name` is NUL-terminated, `total` is a u64 and `length` holds
    // its size, as sysctlbyname expects for hw.memsize.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut total as *mut u64).cast::<libc::c_void>(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 || length != std::mem::size_of::<u64>() || total == 0 {
        return Err(format!(
            "sysctlbyname(hw.memsize) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok((total, None))
}

#[cfg(target_os = "windows")]
fn read_physical_memory() -> Result<(u64, Option<u64>), String> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is plain data; dwLength is set before the call
    // as GlobalMemoryStatusEx requires.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 || status.ullTotalPhys == 0 {
        return Err(format!(
            "GlobalMemoryStatusEx failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok((status.ullTotalPhys, Some(status.ullAvailPhys)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_physical_memory() -> Result<(u64, Option<u64>), String> {
    let text = std::fs::read_to_string("/proc/meminfo")
        .map_err(|err| format!("reading /proc/meminfo failed: {err}"))?;
    parse_meminfo(&text).ok_or_else(|| "/proc/meminfo has no MemTotal".to_string())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn read_physical_memory() -> Result<(u64, Option<u64>), String> {
    Err("physical memory is unknown on this platform".to_string())
}

pub fn memory_info() -> Result<MemoryInfo, String> {
    let (total_bytes, available_bytes) = read_physical_memory()?;
    Ok(MemoryInfo {
        total_bytes,
        available_bytes,
        engine: webview_engine(),
    })
}

#[tauri::command]
pub fn get_memory_info() -> Result<MemoryInfo, String> {
    memory_info()
}

/// Linux: the WebContent memory-pressure settings (#258 part 6). WebKitGTK
/// takes them only as the construct-only `memory-pressure-settings` property
/// of the WebKitWebContext, and wry 0.55 builds that context itself without
/// it (`webkit_website_data_manager_set_memory_pressure_settings`, the one
/// static setter, covers the network process only). Until wry exposes the
/// property the web process keeps WebKit's defaults; one startup line says
/// so, with the limit this machine would get.
#[cfg(target_os = "linux")]
pub fn log_linux_memory_pressure_plan() {
    match read_physical_memory() {
        Ok((total, _)) => eprintln!(
            "[memory] WebKitGTK memory pressure: WebKit defaults (Strict from 1.5 GiB); \
             planned memory-limit {} MB of {} MB not applied: wry does not expose WebContext memory-pressure-settings",
            webkitgtk_memory_limit_mb(total),
            total / (1024 * 1024)
        ),
        Err(err) => eprintln!("[memory] WebKitGTK memory pressure: WebKit defaults ({err})"),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn log_linux_memory_pressure_plan() {}

#[cfg(test)]
mod tests {
    use super::{memory_info, parse_meminfo, webkitgtk_memory_limit_mb, webview_engine};

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn memory_info_reports_at_least_one_gib() {
        let info = memory_info().expect("physical memory is readable on the test host");
        assert!(info.total_bytes >= GIB, "total {} bytes", info.total_bytes);
        assert_eq!(info.engine, webview_engine());
        if let Some(available) = info.available_bytes {
            assert!(available <= info.total_bytes);
        }
    }

    #[test]
    fn memory_info_serialises_in_camel_case() {
        let info = super::MemoryInfo { total_bytes: 16 * GIB, available_bytes: None, engine: "wkwebview" };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["totalBytes"], 16 * GIB);
        assert!(json["availableBytes"].is_null());
        assert_eq!(json["engine"], "wkwebview");
    }

    #[test]
    fn parse_meminfo_reads_total_and_available() {
        let text = "MemTotal:       16303196 kB\nMemFree:         1033416 kB\nMemAvailable:    9876540 kB\nBuffers:          312348 kB\n";
        assert_eq!(parse_meminfo(text), Some((16303196 * 1024, Some(9876540 * 1024))));
    }

    #[test]
    fn parse_meminfo_without_available() {
        // Kernels before 3.14 have no MemAvailable.
        let text = "MemTotal:        2048000 kB\nMemFree:          512000 kB\n";
        assert_eq!(parse_meminfo(text), Some((2048000 * 1024, None)));
    }

    #[test]
    fn parse_meminfo_rejects_missing_or_bad_total() {
        assert_eq!(parse_meminfo(""), None);
        assert_eq!(parse_meminfo("MemFree: 12 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: lots kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: 0 kB\n"), None);
        // A prefix of another field name is not the field.
        assert_eq!(parse_meminfo("MemTotalish: 12 kB\n"), None);
    }

    #[test]
    fn parse_meminfo_ignores_field_order_and_spacing() {
        let text = "MemAvailable: 100 kB\nSwapTotal: 0 kB\nMemTotal:\t200 kB\n";
        assert_eq!(parse_meminfo(text), Some((200 * 1024, Some(100 * 1024))));
    }

    #[test]
    fn webkitgtk_limit_is_half_of_total_in_mb() {
        assert_eq!(webkitgtk_memory_limit_mb(16 * GIB), 8192);
        assert_eq!(webkitgtk_memory_limit_mb(8 * GIB), 4096);
        assert_eq!(webkitgtk_memory_limit_mb(0), 0);
    }
}
