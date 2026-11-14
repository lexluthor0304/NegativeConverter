//! Tethered capture: a camera on USB shows its live view, takes the picture on
//! request and hands the RAW over, which lands in the active watch folder and
//! is imported from there like any other arrival (`import_folder.rs`). One
//! cable, no vendor SDK. See `docs/tethered-capture.md`.
//!
//! Supported where a transport exists (macOS). The Leica M11 series was
//! measured on the real camera; other Leica bodies, Sony (PC Remote) and
//! Fujifilm (USB tether shooting) cameras are offered as beta
//! (`ptp::Dialect::measured`). Everything else answers "unsupported" rather than
//! guessing at a camera.
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
    /// Not yet measured on the real camera.
    pub beta: bool,
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
    use super::ptp::{self, ev, fuji, leica, op, prop, rc, sony, Dialect};
    use super::{free_name, Connected, Photo};
    use std::collections::HashSet;
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
        dialect: Dialect,
        /// Fujifilm: the transaction that started the live view, which also ends it.
        open_capture: Option<u32>,
        /// Fujifilm: objects fetched already, or there before this connection.
        seen: HashSet<u32>,
        /// Sony, Fujifilm: when the camera was last asked for captured files.
        polled: Instant,
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
        async fn set_u16(&self, app: &AppHandle, id: &str, what: &str, property: u16, value: u16) -> Result<(), String> {
            self.expect(app, id, what, op::SET_DEVICE_PROP_VALUE, &[property as u32], Some(value.to_le_bytes().to_vec())).await.map(|_| ())
        }
        /// A 16-bit property's value, or None when the camera does not answer OK.
        async fn get_u16(&self, app: &AppHandle, id: &str, property: u16) -> Result<Option<u16>, String> {
            Ok(match self.call(app, id, op::GET_DEVICE_PROP_VALUE, &[property as u32], None, QUICK).await? {
                (rc::OK, data) if data.len() >= 2 => Some(u16::from_le_bytes([data[0], data[1]])),
                _ => None,
            })
        }
        async fn handles(&self, app: &AppHandle, id: &str) -> Result<Vec<u32>, String> {
            let data = self.expect(app, id, "object list", op::GET_OBJECT_HANDLES, &[fuji::ALL_STORAGES, 0, 0], None).await?;
            Ok(ptp::Reader::new(&data).array32())
        }
        /// Fujifilm: starts the live view and returns the transaction that ends it.
        async fn fuji_open_capture(&self, app: &AppHandle, id: &str) -> Result<u32, String> {
            let mut answer = rc::OK;
            for _ in 0..5 {
                answer = self.call(app, id, op::INITIATE_OPEN_CAPTURE, &[0, 0], None, QUICK).await?.0;
                if answer == rc::OK {
                    return Ok(self.transaction.load(Ordering::Relaxed));
                }
            }
            Err(format!("live view: the camera answered 0x{answer:04x}"))
        }
        /// Fujifilm: InitiateCapture does what the action property says.
        async fn fuji_act(&self, app: &AppHandle, id: &str, action: u16) -> Result<(), String> {
            self.set_u16(app, id, "capture", fuji::PROP_ACTION, action).await?;
            match self.call(app, id, op::INITIATE_CAPTURE, &[0, 0], None, QUICK).await? {
                (rc::OK, _) => Ok(()),
                (rc::DEVICE_BUSY, _) => Err("camera-busy".to_string()),
                (other, _) => Err(format!("capture: the camera answered 0x{other:04x}")),
            }
        }
        async fn sony_button(&self, app: &AppHandle, id: &str, code: u16, state: u16) -> Result<(), String> {
            self.expect(app, id, "shutter button", sony::CONTROL, &[code as u32], Some(state.to_le_bytes().to_vec())).await.map(|_| ())
        }
        async fn fuji_close_capture(&self, app: &AppHandle, id: &str) {
            let open = self.session.lock().ok().and_then(|mut session| session.as_mut().and_then(|session| session.open_capture.take()));
            if let Some(transaction) = open {
                let _ = self.call(app, id, op::TERMINATE_OPEN_CAPTURE, &[transaction], None, QUICK).await;
            }
        }
        fn current(&self) -> Result<(String, bool), String> {
            let session = self.session.lock().map_err(|error| error.to_string())?;
            let session = session.as_ref().ok_or("no camera is connected")?;
            Ok((session.id.clone(), session.live_view))
        }
        fn dialect(&self) -> Result<Dialect, String> {
            let session = self.session.lock().map_err(|error| error.to_string())?;
            Ok(session.as_ref().ok_or("no camera is connected")?.dialect)
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
            let dialect = Dialect::of(camera.usb_vendor, &camera.name).ok_or("unsupported-camera")?;
            self.disconnect(app).await;
            let inner = &self.inner;
            let _busy = inner.busy.lock().await;
            macos::open(app, &id).await?;
            // What the body offers (live view, capture) and the objects it already holds.
            let opened = async {
                let first = inner.device_info(app, &id, FIRST_ANSWER).await?;
                match dialect {
                    Dialect::Leica => {
                        // The Leica session: live view and the transfer handshake are behind it.
                        // A Leica without it (an older body, or one in mass storage mode) cannot be driven.
                        match inner.call(app, &id, leica::OPEN_SESSION, &[leica::OPEN_SESSION_KEY], None, QUICK).await? {
                            (rc::OK, _) => {}
                            (rc::OPERATION_NOT_SUPPORTED, _) => return Err("unsupported-camera".to_string()),
                            (other, _) => return Err(format!("Leica session: the camera answered 0x{other:04x}")),
                        }
                        inner.set_u32(app, &id, "tethered shooting", leica::PROP_EXTERNAL_SHOOTING, 1).await?;
                        let info = inner.device_info(app, &id, QUICK).await?;
                        let live_view = info.supports(leica::CONTROL_LIVE_VIEW) && info.supports(leica::GET_STREAM_DATA);
                        let capture = info.supports(op::INITIATE_CAPTURE);
                        Ok((info, live_view, capture, HashSet::new()))
                    }
                    Dialect::Sony => {
                        // Only "PC Remote" offers the connect; mass storage and MTP do not.
                        if !first.supports(sony::CONNECT) {
                            return Err("sony-pc-remote".to_string());
                        }
                        for phase in [1, 2] {
                            inner.expect(app, &id, "Sony connect", sony::CONNECT, &[phase, 0, 0], None).await?;
                        }
                        let mut codes = Vec::new();
                        for _ in 0..20 {
                            codes = sony::ext_device_info(&inner.expect(app, &id, "Sony controls", sony::GET_EXT_DEVICE_INFO, &[sony::PROTOCOL, 1], None).await?);
                            if !codes.is_empty() {
                                break;
                            }
                            pause(Duration::from_millis(100)).await;
                        }
                        inner.expect(app, &id, "Sony connect", sony::CONNECT, &[3, 0, 0], None).await?;
                        let _ = inner.call(app, &id, sony::SET_PROPERTY, &[sony::PROP_PRIORITY as u32], Some(vec![1]), QUICK).await;
                        let capture = codes.contains(&sony::BUTTON_RELEASE);
                        Ok((first, true, capture, HashSet::new()))
                    }
                    Dialect::Fuji => {
                        // A card reader lists the whole card as objects and takes no pictures.
                        let mode = inner.get_u16(app, &id, fuji::PROP_USB_MODE).await?;
                        if !first.supports(op::INITIATE_CAPTURE) || mode.is_some_and(|mode| mode != fuji::USB_MODE_TETHER) {
                            return Err("fuji-tether-mode".to_string());
                        }
                        let _ = inner.set_u16(app, &id, "PC mode", fuji::PROP_PC_MODE, 1).await;
                        // Only what is taken from now on is fetched.
                        let seen = inner.handles(app, &id).await?.into_iter().collect();
                        Ok((first, true, true, seen))
                    }
                }
            }
            .await;
            let (info, live_view, capture, seen) = match opened {
                Ok(opened) => opened,
                Err(error) => {
                    macos::close(app, &id).await;
                    return Err(error);
                }
            };
            let connected = Connected { id: id.clone(), model: info.model.clone(), firmware: info.firmware.clone(), live_view, capture, beta: !Dialect::measured(camera.usb_vendor, &camera.name) };
            *inner.session.lock().map_err(|error| error.to_string())? =
                Some(Session { id, info, directory, live_view: false, kept_alive: Instant::now(), dialect, open_capture: None, seen, polled: Instant::now() });
            Ok(connected)
        }

        pub async fn disconnect(&self, app: &AppHandle) {
            let inner = &self.inner;
            let Ok((id, live_view)) = inner.current() else { return };
            let _busy = inner.busy.lock().await;
            // Leave the camera as it was found; a camera already unplugged answers nothing.
            match inner.dialect() {
                Ok(Dialect::Leica) => {
                    if live_view {
                        let _ = inner.call(app, &id, leica::CONTROL_LIVE_VIEW, &[leica::LIVE_VIEW_STOP], None, QUICK).await;
                        let _ = inner.set_u32(app, &id, "stream off", prop::ENABLED_STREAMS, 0).await;
                    }
                    let _ = inner.set_u32(app, &id, "tethered shooting off", leica::PROP_EXTERNAL_SHOOTING, 0).await;
                }
                Ok(Dialect::Fuji) => {
                    inner.fuji_close_capture(app, &id).await;
                    let _ = inner.set_u16(app, &id, "priority", fuji::PROP_PRIORITY, fuji::PRIORITY_CAMERA).await;
                }
                Ok(Dialect::Sony) | Err(_) => {}
            }
            macos::close(app, &id).await;
            if let Ok(mut session) = inner.session.lock() {
                *session = None;
            }
        }

        pub async fn live_view(&self, app: &AppHandle, on: bool) -> Result<(), String> {
            let inner = &self.inner;
            let (id, _) = inner.current()?;
            let _busy = inner.busy.lock().await;
            let dialect = inner.dialect()?;
            if dialect == Dialect::Fuji {
                if on {
                    let transaction = inner.fuji_open_capture(app, &id).await?;
                    if let Some(session) = inner.session.lock().map_err(|error| error.to_string())?.as_mut() {
                        session.open_capture = Some(transaction);
                    }
                } else {
                    inner.fuji_close_capture(app, &id).await;
                }
            } else if dialect == Dialect::Sony {
                // The live view object is there whenever the camera shows a picture.
            } else if on {
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
            let mut settings = super::Settings::default();
            // Sony and Fujifilm encode exposure their own ways: set it on the camera for now.
            if inner.dialect()? != Dialect::Leica {
                return Ok(settings);
            }
            let _busy = inner.busy.lock().await;
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
            if inner.dialect()? != Dialect::Leica {
                return Err("the camera does not report this setting".into());
            }
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
            let dialect = inner.dialect()?;
            if dialect != Dialect::Leica {
                // These bodies send no event for a new file: ask once a second,
                // which also brings in what the camera's own shutter button took.
                let due = {
                    let mut session = inner.session.lock().map_err(|error| error.to_string())?;
                    let session = session.as_mut().ok_or("no camera is connected")?;
                    let due = session.polled.elapsed() >= Duration::from_secs(1);
                    if due {
                        session.polled = Instant::now();
                    }
                    due
                };
                if due {
                    if let Err(error) = arrivals(inner, app, &id).await {
                        let _ = app.emit("tether-error", error);
                    }
                }
                return match dialect {
                    Dialect::Sony => match inner.call(app, &id, op::GET_OBJECT, &[sony::LIVE_VIEW_OBJECT], None, QUICK).await? {
                        (rc::OK, data) => sony::live_view_jpeg(&data).map(<[u8]>::to_vec).ok_or_else(|| "not-ready".to_string()),
                        // Asked too soon after the last frame, or the camera is busy with a picture.
                        (rc::ACCESS_DENIED | rc::INVALID_OBJECT_HANDLE | rc::DEVICE_BUSY, _) => {
                            pause(Duration::from_millis(150)).await;
                            Err("not-ready".into())
                        }
                        (other, _) => Err(format!("live view: the camera answered 0x{other:04x}")),
                    },
                    _ => {
                        // A capture ends the live view; it starts again here.
                        let open = inner.session.lock().map_err(|error| error.to_string())?.as_ref().is_some_and(|session| session.open_capture.is_some());
                        if !open {
                            let Ok(transaction) = inner.fuji_open_capture(app, &id).await else {
                                // Still exposing or writing: a long exposure is not a lost camera.
                                pause(Duration::from_millis(300)).await;
                                return Err("not-ready".into());
                            };
                            if let Some(session) = inner.session.lock().map_err(|error| error.to_string())?.as_mut() {
                                session.open_capture = Some(transaction);
                            }
                        }
                        if inner.call(app, &id, op::GET_OBJECT_INFO, &[fuji::LIVE_VIEW_OBJECT], None, QUICK).await?.0 != rc::OK {
                            return Err("not-ready".into());
                        }
                        let (code, data) = inner.call(app, &id, op::GET_OBJECT, &[fuji::LIVE_VIEW_OBJECT], None, QUICK).await?;
                        // The frame is a pseudo object: deleting it makes room for the next one.
                        let _ = inner.call(app, &id, op::DELETE_OBJECT, &[fuji::LIVE_VIEW_OBJECT, 0], None, QUICK).await;
                        if code == rc::OK && data.len() > 4 && data[0] == 0xFF && data[1] == 0xD8 { Ok(data) } else { Err("not-ready".into()) }
                    }
                };
            }
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
            match inner.dialect()? {
                Dialect::Leica => {
                    return match inner.call(app, &id, op::INITIATE_CAPTURE, &[0, 0], None, QUICK).await? {
                        (rc::OK, _) => Ok(()),
                        (rc::DEVICE_BUSY, _) => Err("camera-busy".into()),
                        (other, _) => Err(format!("capture: the camera answered 0x{other:04x}")),
                    };
                }
                Dialect::Sony => {
                    // The shutter button, pressed half, then fully, held until
                    // the camera has focus (a second at most), then let go.
                    let button = |code: u16, state: u16| inner.sony_button(app, &id, code, state);
                    button(sony::BUTTON_HALF_PRESS, sony::PRESS).await?;
                    button(sony::BUTTON_RELEASE, sony::PRESS).await?;
                    let pressed = Instant::now();
                    while pressed.elapsed() < Duration::from_secs(1) {
                        let blob = inner.expect(app, &id, "camera state", sony::GET_ALL_PROPERTIES, &[], None).await.unwrap_or_default();
                        if matches!(sony::current_value(&blob, sony::PROP_FOCUS_FOUND), Some(2 | 3)) {
                            break;
                        }
                        pause(Duration::from_millis(100)).await;
                    }
                    button(sony::BUTTON_RELEASE, sony::LET_GO).await?;
                    button(sony::BUTTON_HALF_PRESS, sony::LET_GO).await?;
                }
                Dialect::Fuji => {
                    inner.fuji_close_capture(app, &id).await;
                    let _ = inner.set_u16(app, &id, "priority", fuji::PROP_PRIORITY, fuji::PRIORITY_HOST).await;
                    let act = |action: u16| inner.fuji_act(app, &id, action);
                    let shot = async {
                        act(fuji::ACTION_FOCUS).await?;
                        let asked = Instant::now();
                        let mut focus = Some(fuji::FOCUS_BUSY);
                        while focus == Some(fuji::FOCUS_BUSY) && asked.elapsed() < Duration::from_secs(5) {
                            focus = inner.get_u16(app, &id, fuji::PROP_FOCUS_STATUS).await?;
                        }
                        if focus == Some(fuji::FOCUS_FAILED) || focus == Some(fuji::FOCUS_BUSY) {
                            let _ = act(fuji::ACTION_CANCEL).await;
                            return Err("camera-busy".to_string());
                        }
                        act(fuji::ACTION_SHOOT).await
                    }
                    .await;
                    // The camera's own button works again.
                    let _ = inner.set_u16(app, &id, "priority", fuji::PROP_PRIORITY, fuji::PRIORITY_CAMERA).await;
                    shot?;
                }
            }
            // No event announces the file on these bodies: look for it until it is there.
            let (inner, app) = (self.inner.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                for _ in 0..100 {
                    pause(Duration::from_millis(400)).await;
                    let _busy = inner.busy.lock().await;
                    if inner.current().map(|(current, _)| current != id).unwrap_or(true) {
                        break;
                    }
                    match arrivals(&inner, &app, &id).await {
                        Ok(0) => {}
                        Ok(_) => break,
                        Err(error) => {
                            let _ = app.emit("tether-error", error);
                            break;
                        }
                    }
                }
            });
            Ok(())
        }
    }

    /// A camera's ObjectAdded event (Leica): fetches the new object.
    async fn fetch(inner: &Inner, app: &AppHandle, id: &str, object: u32) -> Result<(), String> {
        let (directory, transfer_ready) = {
            let session = inner.session.lock().map_err(|error| error.to_string())?;
            // The other dialects find their files by asking (`arrivals`).
            let Some(session) = session.as_ref().filter(|session| session.id == id && session.dialect == Dialect::Leica) else { return Ok(()) };
            (session.directory.clone(), session.info.supports(leica::REQUEST_OBJECT_TRANSFER_READY))
        };
        let _busy = inner.busy.lock().await;
        if transfer_ready {
            let _ = inner.call(app, id, leica::REQUEST_OBJECT_TRANSFER_READY, &[], None, QUICK).await;
        }
        store(inner, app, id, directory, object, true).await.map(|_| ())
    }

    /// Sony and Fujifilm, with `busy` held: fetches the captured files that
    /// wait in the camera and says how many there were.
    async fn arrivals(inner: &Inner, app: &AppHandle, id: &str) -> Result<usize, String> {
        let (directory, dialect) = {
            let session = inner.session.lock().map_err(|error| error.to_string())?;
            let Some(session) = session.as_ref().filter(|session| session.id == id) else { return Ok(0) };
            (session.directory.clone(), session.dialect)
        };
        let mut fetched = 0;
        match dialect {
            Dialect::Leica => {}
            Dialect::Sony => {
                // RAW + JPEG is two files, one after the other at the same handle.
                for _ in 0..4 {
                    let blob = inner.expect(app, id, "camera state", sony::GET_ALL_PROPERTIES, &[], None).await?;
                    if sony::current_value(&blob, sony::PROP_OBJECT_IN_MEMORY).is_none_or(|waiting| waiting < sony::OBJECT_READY) {
                        break;
                    }
                    if store(inner, app, id, directory.clone(), sony::CAPTURED_OBJECT, false).await? {
                        fetched += 1;
                    }
                }
            }
            Dialect::Fuji => {
                let _ = inner.call(app, id, op::GET_DEVICE_PROP_VALUE, &[fuji::PROP_EVENTS as u32], None, QUICK).await;
                for object in inner.handles(app, id).await? {
                    let new = object != fuji::LIVE_VIEW_OBJECT
                        && inner.session.lock().map_err(|error| error.to_string())?.as_mut().is_some_and(|session| session.seen.insert(object));
                    if new && store(inner, app, id, directory.clone(), object, false).await? {
                        fetched += 1;
                    }
                }
            }
        }
        Ok(fetched)
    }

    /// Fetches one object into the watch folder: written beside its final
    /// name and renamed, so the folder watch only ever sees whole files.
    /// False for a folder, which is not a photo. Nothing is deleted on the camera.
    async fn store(inner: &Inner, app: &AppHandle, id: &str, directory: PathBuf, object: u32, exact_size: bool) -> Result<bool, String> {
        let info = inner.expect(app, id, "photo info", op::GET_OBJECT_INFO, &[object], None).await?;
        let info = ptp::ObjectInfo::parse(&info).ok_or("the camera's photo info could not be read")?;
        if info.format == ptp::FORMAT_ASSOCIATION {
            return Ok(false);
        }
        let (code, data) = inner.call(app, id, op::GET_OBJECT, &[object], None, TRANSFER).await?;
        if code != rc::OK || data.is_empty() || (exact_size && data.len() as u64 != info.size as u64) {
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
        Ok(true)
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
