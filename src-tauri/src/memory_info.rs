//! Physical memory for the page's memory budget (#258).
//!
//! WKWebView and WebKitGTK implement no `navigator.deviceMemory`, so without
//! this the desktop app plans every job for an unknown machine. The page
//! sizes its renderer-wide budget from `totalBytes` and picks its idle policy
//! from `engine` (WebKit's 30 s memory monitor purges caches and JIT code
//! above 1.5 GiB on macOS, and on Linux above a quarter of RAM once
//! `apply_linux_memory_pressure_settings` ran, #282; WebView2 has no such
//! monitor).
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

/// WebKitGTK's `memory-limit` (MB) that moves the Strict threshold from
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

/// What WebKitGTK's memory pressure runs with on this machine (#258 part 6,
/// #282): a `memory-limit` of half of `MemTotal`, so the Strict policy that
/// purges caches and JIT code every 30 s starts at a quarter of RAM instead
/// of WebKit's fixed 1.5 GiB. Everything else stays WebKitGTK's default: the
/// conservative and strict thresholds (0.33 and 0.5 of the limit), the 30 s
/// poll, and the kill threshold (unset: the web process is never killed).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebKitGtkMemoryPlan {
    /// `MemTotal` in MB.
    pub total_mb: u64,
    /// WebKitGTK's `memory-limit` in MB: half of `MemTotal`.
    pub memory_limit_mb: u32,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl WebKitGtkMemoryPlan {
    /// `None` when the limit would be 0 MB, which WebKitGTK refuses.
    pub fn for_total_bytes(total_bytes: u64) -> Option<Self> {
        let memory_limit_mb = webkitgtk_memory_limit_mb(total_bytes);
        (memory_limit_mb > 0).then_some(Self { total_mb: total_bytes / (1024 * 1024), memory_limit_mb })
    }

    /// The startup line of #258's acceptance: the applied limit, where Strict
    /// starts (WebKitGTK's default strict threshold, half of the limit), and
    /// that the kill threshold stays unset.
    pub fn log_line(&self) -> String {
        format!(
            "[memory] WebKitGTK memory-limit {} MB of {} MB (Strict from {} MB); kill threshold unset",
            self.memory_limit_mb,
            self.total_mb,
            self.memory_limit_mb / 2
        )
    }

    /// wry's settings: only the limit; every other field `None` keeps
    /// WebKitGTK's default.
    #[cfg(target_os = "linux")]
    pub fn settings(&self) -> tauri_runtime_wry::wry::MemoryPressureSettings {
        tauri_runtime_wry::wry::MemoryPressureSettings {
            memory_limit_mb: Some(self.memory_limit_mb),
            ..Default::default()
        }
    }
}

/// Linux: apply the plan before the first webview and log it. WebKitGTK takes
/// the settings only as the construct-only `memory-pressure-settings`
/// property of the WebKitWebContext, which Tauri's wry builds itself when the
/// main window from tauri.conf.json is created, so they go in as the
/// process-wide default of the wry fork this build pins (`[patch.crates-io]`
/// in Cargo.toml) through the wry instance Tauri uses. Without a readable
/// `MemTotal` the web process keeps WebKit's defaults and the line says so.
#[cfg(target_os = "linux")]
pub fn apply_linux_memory_pressure_settings() {
    let plan = read_physical_memory().and_then(|(total, _)| {
        WebKitGtkMemoryPlan::for_total_bytes(total)
            .ok_or_else(|| format!("MemTotal {total} bytes gives a 0 MB limit"))
    });
    match plan {
        Ok(plan) => {
            tauri_runtime_wry::wry::set_default_memory_pressure_settings(plan.settings());
            eprintln!("{}", plan.log_line());
        }
        Err(err) => eprintln!("[memory] WebKitGTK memory pressure: WebKit defaults ({err})"),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn apply_linux_memory_pressure_settings() {}

#[cfg(test)]
mod tests {
    use super::{
        memory_info, parse_meminfo, webkitgtk_memory_limit_mb, webview_engine, WebKitGtkMemoryPlan,
    };

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

    #[test]
    fn webkitgtk_plan_logs_the_applied_limit_and_where_strict_starts() {
        // A 16 GB machine's /proc/meminfo (#282's numbers).
        let (total, _) = parse_meminfo("MemTotal:       16303196 kB\n").unwrap();
        let plan = WebKitGtkMemoryPlan::for_total_bytes(total).unwrap();
        assert_eq!(plan, WebKitGtkMemoryPlan { total_mb: 15921, memory_limit_mb: 7960 });
        assert_eq!(
            plan.log_line(),
            "[memory] WebKitGTK memory-limit 7960 MB of 15921 MB (Strict from 3980 MB); kill threshold unset"
        );
        assert_eq!(
            WebKitGtkMemoryPlan::for_total_bytes(16 * GIB),
            Some(WebKitGtkMemoryPlan { total_mb: 16384, memory_limit_mb: 8192 })
        );
    }

    #[test]
    fn webkitgtk_plan_refuses_a_zero_limit() {
        // WebKitGTK rejects memory-limit 0: such a machine keeps the defaults.
        assert_eq!(WebKitGtkMemoryPlan::for_total_bytes(0), None);
        assert_eq!(WebKitGtkMemoryPlan::for_total_bytes(1024 * 1024), None);
        assert!(WebKitGtkMemoryPlan::for_total_bytes(2 * 1024 * 1024).is_some());
    }

    /// Runs where the wry types exist (CI's ubuntu test job): only the limit
    /// is set; the thresholds, the kill threshold and the poll stay WebKitGTK's.
    #[cfg(target_os = "linux")]
    #[test]
    fn webkitgtk_settings_set_only_the_limit() {
        let settings = WebKitGtkMemoryPlan::for_total_bytes(16 * GIB).unwrap().settings();
        assert_eq!(settings.memory_limit_mb, Some(8192));
        assert_eq!(settings.conservative_threshold, None);
        assert_eq!(settings.strict_threshold, None);
        assert_eq!(settings.kill_threshold, None);
        assert_eq!(settings.poll_interval, None);
    }
}
