//! Tethered capture: a camera on USB shows its live view, takes the picture on
//! request and hands the RAW over, which lands in the active watch folder and
//! is imported from there like any other arrival (`import_folder.rs`). One
//! cable, no vendor SDK. See `docs/tethered-capture.md`.
//!
//! Supported where a transport exists (macOS) and for the bodies whose dialect
//! was measured on the real camera (the Leica M11 series). Everything else answers
//! "unsupported" rather than guessing at a camera.
pub mod ptp;

#[cfg(target_os = "macos")]
mod macos;

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub id: String,
    pub model: String,
    pub firmware: String,
    pub live_view: bool,
    pub capture: bool,
}

/// One exposure setting as the camera reports it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub settable: bool,
    pub value: i64,
    /// The values the camera accepts, when it lists them.
    pub options: Vec<i64>,
}

/// The exposure settings the scan screen shows; a body that does not report one leaves it out.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub iso: Option<Setting>,
    pub shutter: Option<Setting>,
    pub compensation: Option<Setting>,
}

/// A captured file, written to the watch folder.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// A name for `wanted` in `directory` that replaces nothing: `L100.DNG`, then
/// `L100-2.DNG`. Only the file name of what the camera reports is used.
pub fn free_name(directory: &Path, wanted: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let name = Path::new(wanted).file_name()?.to_str()?;
    if name.is_empty() || name.starts_with('.') {
        return None;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    };
    (1..10_000).find_map(|attempt| {
        let candidate = match (attempt, extension) {
            (1, _) => name.to_string(),
            (_, Some(extension)) => format!("{stem}-{attempt}.{extension}"),
            (_, None) => format!("{stem}-{attempt}"),
        };
        let path = directory.join(candidate);
        (!exists(&path)).then_some(path)
    })
}

#[cfg(target_os = "macos")]
mod session {
    use super::macos::{self, Camera};
    use super::ptp::{self, ev, leica, op, prop, rc};
    use super::{free_name, Connected, Photo};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    const QUICK: Duration = Duration::from_secs(5);
    /// A 100 MB RAW at the 33 MB/s measured over USB 2 takes three seconds.
    const TRANSFER: Duration = Duration::from_secs(120);
    /// The system lists the whole card when a camera is plugged in or wakes,
    /// and passes no command on until it is done: 66 s was measured on a card
    /// with years of photos. The first command of a connection waits that out.
    const FIRST_ANSWER: Duration = Duration::from_secs(180);

    struct Session {
        id: String,
        info: ptp::DeviceInfo,
        directory: PathBuf,
        live_view: bool,
        kept_alive: Instant,
    }

    #[derive(Default)]
    pub struct Tether {
        inner: Arc<Inner>,
    }

    #[derive(Default)]
    struct Inner {
        /// One transaction at a time: a camera answers them in order.
        busy: tauri::async_runtime::Mutex<()>,
        session: Mutex<Option<Session>>,
        transaction: AtomicU32,
        events: Mutex<Option<Sender<(String, ptp::Container)>>>,
    }

    async fn pause(duration: Duration) {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
    }

    impl Inner {
        async fn call(&self, app: &AppHandle, id: &str, code: u16, parameters: &[u32], out: Option<Vec<u8>>, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
            let transaction = self.transaction.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
            let (response, data) = macos::transact(app, id, ptp::command(code, transaction, parameters), out, timeout).await?;
            Ok((response.code, data))
        }
        async fn expect(&self, app: &AppHandle, id: &str, what: &str, code: u16, parameters: &[u32], out: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            match self.call(app, id, code, parameters, out, QUICK).await? {
                (rc::OK, data) => Ok(data),
                (other, _) => Err(format!("{what}: the camera answered 0x{other:04x}")),
            }
        }
        async fn set_u32(&self, app: &AppHandle, id: &str, what: &str, property: u16, value: u32) -> Result<(), String> {
            self.expect(app, id, what, op::SET_DEVICE_PROP_VALUE, &[property as u32], Some(value.to_le_bytes().to_vec())).await.map(|_| ())
        }
        async fn device_info(&self, app: &AppHandle, id: &str, timeout: Duration) -> Result<ptp::DeviceInfo, String> {
            let data = match self.call(app, id, op::GET_DEVICE_INFO, &[], None, timeout).await? {
                (rc::OK, data) => data,
                (other, _) => return Err(format!("device info: the camera answered 0x{other:04x}")),
            };
            ptp::DeviceInfo::parse(&data).ok_or_else(|| "the camera's device info could not be read".to_string())
        }
        fn current(&self) -> Result<(String, bool), String> {
            let session = self.session.lock().map_err(|error| error.to_string())?;
            let session = session.as_ref().ok_or("no camera is connected")?;
            Ok((session.id.clone(), session.live_view))
        }
    }

    impl Tether {
        pub async fn cameras(&self, app: &AppHandle) -> Result<Vec<Camera>, String> {
            let events = {
                let mut events = self.inner.events.lock().map_err(|error| error.to_string())?;
                if events.is_none() {
                    let (send, receive) = channel::<(String, ptp::Container)>();
                    let inner = self.inner.clone();
                    let handle = app.clone();
                    // The camera's events: a new object is a photo to fetch,
                    // whether this app or the shutter button released it.
                    std::thread::spawn(move || {
                        while let Ok((id, event)) = receive.recv() {
                            if event.code != ev::OBJECT_ADDED {
                                continue;
                            }
                            let Some(object) = event.parameters.first().copied() else { continue };
                            let (inner, handle) = (inner.clone(), handle.clone());
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = fetch(&inner, &handle, &id, object).await {
                                    let _ = handle.emit("tether-error", error);
                                }
                            });
                        }
                    });
                    *events = Some(send);
                }
                events.clone().unwrap()
            };
            macos::cameras(app, events).await
        }

        pub async fn connect(&self, app: &AppHandle, id: String, directory: PathBuf) -> Result<Connected, String> {
            let listed = self.cameras(app).await?;
            let camera = listed.iter().find(|camera| camera.id == id).ok_or("the camera is no longer connected")?.clone();
            if !camera.supported {
                return Err("unsupported-camera".into());
            }
            self.disconnect(app).await;
            let inner = &self.inner;
            let _busy = inner.busy.lock().await;
            macos::open(app, &id).await?;
            let opened = async {
                inner.device_info(app, &id, FIRST_ANSWER).await?;
                // The Leica session: live view and the transfer handshake are behind it.
                inner.expect(app, &id, "Leica session", leica::OPEN_SESSION, &[leica::OPEN_SESSION_KEY], None).await?;
                inner.set_u32(app, &id, "tethered shooting", leica::PROP_EXTERNAL_SHOOTING, 1).await?;
                inner.device_info(app, &id, QUICK).await
            }
            .await;
            let info = match opened {
                Ok(info) => info,
                Err(error) => {
                    macos::close(app, &id).await;
                    return Err(error);
                }
            };
            let connected = Connected {
                id: id.clone(),
                model: info.model.clone(),
                firmware: info.firmware.clone(),
                live_view: info.supports(leica::CONTROL_LIVE_VIEW) && info.supports(leica::GET_STREAM_DATA),
                capture: info.supports(op::INITIATE_CAPTURE),
            };
            *inner.session.lock().map_err(|error| error.to_string())? =
                Some(Session { id, info, directory, live_view: false, kept_alive: Instant::now() });
            Ok(connected)
        }

        pub async fn disconnect(&self, app: &AppHandle) {
            let inner = &self.inner;
            let Ok((id, live_view)) = inner.current() else { return };
            let _busy = inner.busy.lock().await;
            // Leave the camera as it was found; a camera already unplugged answers nothing.
            if live_view {
                let _ = inner.call(app, &id, leica::CONTROL_LIVE_VIEW, &[leica::LIVE_VIEW_STOP], None, QUICK).await;
                let _ = inner.set_u32(app, &id, "stream off", prop::ENABLED_STREAMS, 0).await;
            }
            let _ = inner.set_u32(app, &id, "tethered shooting off", leica::PROP_EXTERNAL_SHOOTING, 0).await;
            macos::close(app, &id).await;
            if let Ok(mut session) = inner.session.lock() {
                *session = None;
            }
        }

        pub async fn live_view(&self, app: &AppHandle, on: bool) -> Result<(), String> {
            let inner = &self.inner;
            let (id, _) = inner.current()?;
            let _busy = inner.busy.lock().await;
            if on {
                // The body answers DeviceBusy while it settles after the session
                // opens, and takes the stream only once its own live view runs.
                let mut started = false;
                for _ in 0..10 {
                    match inner.call(app, &id, leica::CONTROL_LIVE_VIEW, &[leica::LIVE_VIEW_START], None, QUICK).await? {
                        (rc::OK, _) => {
                            started = true;
                            break;
                        }
                        (rc::DEVICE_BUSY, _) => pause(Duration::from_millis(500)).await,
                        (other, _) => return Err(format!("live view: the camera answered 0x{other:04x}")),
                    }
                }
                if !started {
                    return Err("live view: the camera stayed busy".into());
                }
                let mut enabled = false;
                for _ in 0..10 {
                    inner.set_u32(app, &id, "live view stream", prop::ENABLED_STREAMS, leica::STREAM_LIVE_VIEW).await?;
                    let _ = inner.call(app, &id, leica::KEEP_SESSION_ACTIVE, &[], None, QUICK).await;
                    let value = inner.expect(app, &id, "live view stream", op::GET_DEVICE_PROP_VALUE, &[prop::ENABLED_STREAMS as u32], None).await?;
                    if value.iter().any(|byte| *byte != 0) {
                        enabled = true;
                        break;
                    }
                    pause(Duration::from_millis(500)).await;
                }
                if !enabled {
                    let _ = inner.call(app, &id, leica::CONTROL_LIVE_VIEW, &[leica::LIVE_VIEW_STOP], None, QUICK).await;
                    return Err("live view: the camera did not start its stream".into());
                }
            } else {
                let _ = inner.call(app, &id, leica::CONTROL_LIVE_VIEW, &[leica::LIVE_VIEW_STOP], None, QUICK).await;
                let _ = inner.set_u32(app, &id, "stream off", prop::ENABLED_STREAMS, 0).await;
            }
            if let Some(session) = inner.session.lock().map_err(|error| error.to_string())?.as_mut() {
                session.live_view = on;
                session.kept_alive = Instant::now();
            }
            Ok(())
        }

        fn exposure_property(name: &str) -> Result<u16, String> {
            match name {
                "iso" => Ok(prop::EXPOSURE_INDEX),
                "shutter" => Ok(leica::PROP_SHUTTER_SPEED),
                "compensation" => Ok(prop::EXPOSURE_BIAS_COMPENSATION),
                _ => Err("unknown setting".into()),
            }
        }

        async fn describe(inner: &Inner, app: &AppHandle, id: &str, property: u16) -> Option<ptp::PropDesc> {
            match inner.call(app, id, op::GET_DEVICE_PROP_DESC, &[property as u32], None, QUICK).await {
                Ok((rc::OK, data)) => ptp::PropDesc::parse(&data).filter(|description| description.property == property),
                _ => None,
            }
        }

        /// ISO, shutter speed and exposure compensation as the camera has them now.
        pub async fn settings(&self, app: &AppHandle) -> Result<super::Settings, String> {
            let inner = &self.inner;
            let (id, _) = inner.current()?;
            let _busy = inner.busy.lock().await;
            let mut settings = super::Settings::default();
            for (name, slot) in [("iso", &mut settings.iso), ("shutter", &mut settings.shutter), ("compensation", &mut settings.compensation)] {
                *slot = Self::describe(inner, app, &id, Self::exposure_property(name)?)
                    .await
                    .map(|description| super::Setting { settable: description.settable, value: description.current, options: description.options });
            }
            Ok(settings)
        }

        /// Sets one of them; a value the camera does not list is refused here, not sent.
        pub async fn set(&self, app: &AppHandle, name: &str, value: i64) -> Result<(), String> {
            let inner = &self.inner;
            let (id, _) = inner.current()?;
            let property = Self::exposure_property(name)?;
            let _busy = inner.busy.lock().await;
            let description = Self::describe(inner, app, &id, property).await.ok_or("the camera does not report this setting")?;
            if !description.settable || (!description.options.is_empty() && !description.options.contains(&value)) || i32::try_from(value).is_err() {
                return Err("the camera does not accept this value".into());
            }
            inner.expect(app, &id, "setting", op::SET_DEVICE_PROP_VALUE, &[property as u32], Some(description.encode(value))).await.map(|_| ())
        }

        /// The newest live view frame as a JPEG.
        pub async fn frame(&self, app: &AppHandle) -> Result<Vec<u8>, String> {
            let inner = &self.inner;
            let (id, live_view) = inner.current()?;
            if !live_view {
                return Err("live view is off".into());
            }
            let _busy = inner.busy.lock().await;
            let keep_alive = {
                let mut session = inner.session.lock().map_err(|error| error.to_string())?;
                let session = session.as_mut().ok_or("no camera is connected")?;
                let due = session.kept_alive.elapsed() >= Duration::from_secs(2);
                if due {
                    session.kept_alive = Instant::now();
                }
                due
            };
            if keep_alive {
                let _ = inner.call(app, &id, leica::KEEP_SESSION_ACTIVE, &[], None, QUICK).await;
            }
            match inner.call(app, &id, leica::GET_STREAM_DATA, &[], None, QUICK).await? {
                (rc::OK, data) => leica::live_view_jpeg(&data).map(<[u8]>::to_vec).ok_or_else(|| "the camera sent no picture".to_string()),
                // Between frames, or while the body takes a picture.
                (rc::NO_STREAM_ENABLED | rc::DEVICE_BUSY, _) => Err("not-ready".into()),
                (other, _) => Err(format!("live view: the camera answered 0x{other:04x}")),
            }
        }

        /// Releases the shutter; the photo arrives through the camera's ObjectAdded event.
        pub async fn capture(&self, app: &AppHandle) -> Result<(), String> {
            let inner = &self.inner;
            let (id, _) = inner.current()?;
            let _busy = inner.busy.lock().await;
            match inner.call(app, &id, op::INITIATE_CAPTURE, &[0, 0], None, QUICK).await? {
                (rc::OK, _) => Ok(()),
                (rc::DEVICE_BUSY, _) => Err("camera-busy".into()),
                (other, _) => Err(format!("capture: the camera answered 0x{other:04x}")),
            }
        }
    }

    /// Fetches a new object into the watch folder: written beside its final
    /// name and renamed, so the folder watch only ever sees whole files.
    async fn fetch(inner: &Inner, app: &AppHandle, id: &str, object: u32) -> Result<(), String> {
        let (directory, transfer_ready) = {
            let session = inner.session.lock().map_err(|error| error.to_string())?;
            let Some(session) = session.as_ref().filter(|session| session.id == id) else { return Ok(()) };
            (session.directory.clone(), session.info.supports(leica::REQUEST_OBJECT_TRANSFER_READY))
        };
        let _busy = inner.busy.lock().await;
        if transfer_ready {
            let _ = inner.call(app, id, leica::REQUEST_OBJECT_TRANSFER_READY, &[], None, QUICK).await;
        }
        let info = inner.expect(app, id, "photo info", op::GET_OBJECT_INFO, &[object], None).await?;
        let info = ptp::ObjectInfo::parse(&info).ok_or("the camera's photo info could not be read")?;
        let (code, data) = inner.call(app, id, op::GET_OBJECT, &[object], None, TRANSFER).await?;
        if code != rc::OK || data.len() as u64 != info.size as u64 || data.is_empty() {
            return Err(format!("photo transfer: the camera answered 0x{code:04x} with {} of {} bytes", data.len(), info.size));
        }
        let size = data.len() as u64;
        let (name, path) = tauri::async_runtime::spawn_blocking(move || -> Result<(String, PathBuf), String> {
            let path = free_name(&directory, &info.filename, |path| path.exists()).ok_or("the camera reported no usable file name")?;
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let partial = directory.join(format!(".{name}.part"));
            std::fs::write(&partial, &data).map_err(|error| error.to_string())?;
            std::fs::rename(&partial, &path).map_err(|error| {
                let _ = std::fs::remove_file(&partial);
                error.to_string()
            })?;
            Ok((name, path))
        })
        .await
        .map_err(|error| error.to_string())??;
        // Whole already: the page imports it now instead of after the folder watch's wait for a stable file.
        {
            use tauri::Manager;
            if let Some(arrival) = app.state::<crate::import_folder::ImportWatch>().tethered_arrival(&path) {
                let _ = app.emit("import-folder-file", arrival);
            }
        }
        let _ = app.emit("tether-photo", Photo { name, path: path.to_string_lossy().into(), size });
        Ok(())
    }

}

#[cfg(target_os = "macos")]
pub use session::Tether;

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct Tether;

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "unsupported-platform";

#[cfg(target_os = "macos")]
mod commands {
    use super::*;
    use crate::import_folder::ImportWatch;

    #[tauri::command]
    pub async fn tether_cameras(app: tauri::AppHandle, tether: State<'_, Tether>) -> Result<serde_json::Value, String> {
        serde_json::to_value(tether.cameras(&app).await?).map_err(|error| error.to_string())
    }
    /// Connects to a camera; its photos go to the active watch folder, which
    /// the user chose in the native picker (`watch_import_folder`).
    #[tauri::command]
    pub async fn tether_connect(app: tauri::AppHandle, tether: State<'_, Tether>, watch: State<'_, ImportWatch>, id: String) -> Result<Connected, String> {
        let directory = watch.directory().ok_or("no-folder")?;
        tether.connect(&app, id, directory).await
    }
    #[tauri::command]
    pub async fn tether_disconnect(app: tauri::AppHandle, tether: State<'_, Tether>) -> Result<(), String> {
        tether.disconnect(&app).await;
        Ok(())
    }
    #[tauri::command]
    pub async fn tether_live_view(app: tauri::AppHandle, tether: State<'_, Tether>, on: bool) -> Result<(), String> {
        tether.live_view(&app, on).await
    }
    #[tauri::command]
    pub async fn tether_frame(app: tauri::AppHandle, tether: State<'_, Tether>) -> Result<tauri::ipc::Response, String> {
        tether.frame(&app).await.map(tauri::ipc::Response::new)
    }
    #[tauri::command]
    pub async fn tether_capture(app: tauri::AppHandle, tether: State<'_, Tether>) -> Result<(), String> {
        tether.capture(&app).await
    }
    /// Moves a photo of the watch folder to the Trash: a shot the user discards
    /// on the scan screen. Only a file directly in the granted folder.
    #[tauri::command]
    pub async fn tether_trash(watch: State<'_, ImportWatch>, path: String) -> Result<(), String> {
        let directory = watch.directory().ok_or("no-folder")?;
        let path = PathBuf::from(path);
        tauri::async_runtime::spawn_blocking(move || {
            if !crate::import_folder::scoped(&directory, &path) {
                return Err("the photo is not in the watched folder".to_string());
            }
            macos::trash(&path)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    pub async fn tether_settings(app: tauri::AppHandle, tether: State<'_, Tether>) -> Result<Settings, String> {
        tether.settings(&app).await
    }
    #[tauri::command]
    pub async fn tether_set(app: tauri::AppHandle, tether: State<'_, Tether>, name: String, value: i64) -> Result<(), String> {
        tether.set(&app, &name, value).await
    }
}

#[cfg(not(target_os = "macos"))]
mod commands {
    use super::*;

    #[tauri::command]
    pub async fn tether_cameras(_tether: State<'_, Tether>) -> Result<serde_json::Value, String> {
        Ok(serde_json::Value::Array(vec![]))
    }
    #[tauri::command]
    pub async fn tether_connect(_tether: State<'_, Tether>, _id: String) -> Result<Connected, String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_disconnect(_tether: State<'_, Tether>) -> Result<(), String> {
        Ok(())
    }
    #[tauri::command]
    pub async fn tether_live_view(_tether: State<'_, Tether>, _on: bool) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_frame(_tether: State<'_, Tether>) -> Result<tauri::ipc::Response, String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_capture(_tether: State<'_, Tether>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_trash(_path: String) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_settings(_tether: State<'_, Tether>) -> Result<Settings, String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub async fn tether_set(_tether: State<'_, Tether>, _name: String, _value: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

pub use commands::*;

/// Debug builds only: with `NC_TETHER_SELFTEST=<directory>` the app connects
/// to the first supported camera, reads a few live view frames, takes one
/// picture into the directory and disconnects, logging each step. The way to
/// check the native chain on a real camera without the page.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn self_test(app: &tauri::AppHandle) {
    use std::time::Duration;
    use tauri::Manager;
    let Some(directory) = std::env::var_os("NC_TETHER_SELFTEST").map(PathBuf::from) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let pause = |seconds: u64| tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(seconds)));
        let tether = app.state::<Tether>();
        let mut camera = None;
        for _ in 0..10 {
            match tether.cameras(&app).await {
                Ok(cameras) => {
                    eprintln!("[tether-selftest] cameras: {cameras:?}");
                    camera = cameras.into_iter().find(|camera| camera.supported);
                }
                Err(error) => eprintln!("[tether-selftest] cameras failed: {error}"),
            }
            if camera.is_some() {
                break;
            }
            let _ = pause(1).await;
        }
        let Some(camera) = camera else { return eprintln!("[tether-selftest] no supported camera") };
        match tether.connect(&app, camera.id.clone(), directory.clone()).await {
            Ok(connected) => eprintln!("[tether-selftest] connected: {connected:?}"),
            Err(error) => return eprintln!("[tether-selftest] connect failed: {error}"),
        }
        match tether.live_view(&app, true).await {
            Ok(()) => {
                let mut frames = 0;
                let started = std::time::Instant::now();
                for _ in 0..60 {
                    match tether.frame(&app).await {
                        Ok(jpeg) => {
                            frames += 1;
                            if frames == 1 {
                                eprintln!("[tether-selftest] first frame: {} bytes", jpeg.len());
                                let _ = std::fs::write(directory.join("selftest-frame.jpg"), &jpeg);
                            }
                        }
                        Err(error) => eprintln!("[tether-selftest] frame: {error}"),
                    }
                }
                eprintln!("[tether-selftest] {frames} of 60 frames in {:.2} s", started.elapsed().as_secs_f64());
            }
            Err(error) => eprintln!("[tether-selftest] live view failed: {error}"),
        }
        eprintln!("[tether-selftest] settings: {:?}", tether.settings(&app).await);
        eprintln!("[tether-selftest] capture: {:?}", tether.capture(&app).await);
        let _ = pause(9).await;
        let files: Vec<_> = std::fs::read_dir(&directory).map(|entries| entries.flatten().map(|entry| (entry.file_name(), entry.metadata().map(|meta| meta.len()).unwrap_or(0))).collect()).unwrap_or_default();
        eprintln!("[tether-selftest] directory: {files:?}");
        eprintln!("[tether-selftest] live view off: {:?}", tether.live_view(&app, false).await);
        tether.disconnect(&app).await;
        eprintln!("[tether-selftest] done");
    });
}

/// Leaves a connected camera as it was found: the page that drove it is gone.
pub async fn release(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        app.state::<Tether>().disconnect(app).await;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_never_replaces_a_file() {
        let directory = Path::new("/roll");
        let taken = ["/roll/L1002127.DNG", "/roll/L1002127-2.DNG", "/roll/NOEXT"];
        let exists = |path: &Path| taken.contains(&path.to_str().unwrap());
        assert_eq!(free_name(directory, "L1002128.DNG", exists), Some(directory.join("L1002128.DNG")));
        assert_eq!(free_name(directory, "L1002127.DNG", exists), Some(directory.join("L1002127-3.DNG")));
        assert_eq!(free_name(directory, "NOEXT", exists), Some(directory.join("NOEXT-2")));
        // Only the file name of what the camera reports: no way out of the folder.
        assert_eq!(free_name(directory, "../../etc/L1.DNG", exists), Some(directory.join("L1.DNG")));
        assert_eq!(free_name(directory, "/DCIM/100LEICA/L2.DNG", exists), Some(directory.join("L2.DNG")));
        for bad in ["", ".", "..", "/", ".hidden"] {
            assert_eq!(free_name(directory, bad, exists), None, "{bad:?}");
        }
    }
}
