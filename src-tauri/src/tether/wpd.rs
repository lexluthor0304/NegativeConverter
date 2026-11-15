//! The Windows transport: Windows Portable Devices finds the cameras on USB
//! and its MTP driver carries PTP transactions to them, vendor operations
//! included (the "MTP extension" commands). The driver ships with Windows and
//! binds to every camera in PTP mode, so nothing is installed and no driver is
//! replaced.
//!
//! Not yet run on a camera: every body is offered as beta on Windows
//! (`super::beta`). What differs from the macOS transport:
//! - the driver owns the PTP session and the transaction ids;
//! - it has to be told whether an operation answers with data (`ptp::wpd::sends_data`);
//! - a new object arrives as the driver's own event, with the object id it
//!   gave the handle (`ptp::wpd::object_handle`).
//!
//! The COM objects live on one thread (`tether-wpd`); the async side hands it
//! jobs and gets answers over channels.
use super::{ptp, Camera};
use std::collections::HashMap;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, Interface, Ref, GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Devices::PortableDevices::{
    IPortableDevice, IPortableDeviceEventCallback, IPortableDeviceEventCallback_Impl, IPortableDeviceManager,
    IPortableDevicePropVariantCollection, IPortableDeviceValues, PortableDeviceFTM, PortableDeviceManager,
    PortableDevicePropVariantCollection, PortableDeviceValues, WPD_CLIENT_MAJOR_VERSION, WPD_CLIENT_MINOR_VERSION,
    WPD_CLIENT_NAME, WPD_CLIENT_REVISION, WPD_CLIENT_SECURITY_QUALITY_OF_SERVICE, WPD_COMMAND_MTP_EXT_END_DATA_TRANSFER,
    WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITHOUT_DATA_PHASE, WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_READ,
    WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_WRITE, WPD_COMMAND_MTP_EXT_READ_DATA, WPD_COMMAND_MTP_EXT_WRITE_DATA,
    WPD_EVENT_OBJECT_ADDED, WPD_EVENT_PARAMETER_EVENT_ID, WPD_OBJECT_ID, WPD_PROPERTY_COMMON_COMMAND_CATEGORY,
    WPD_PROPERTY_COMMON_COMMAND_ID, WPD_PROPERTY_COMMON_HRESULT, WPD_PROPERTY_MTP_EXT_OPERATION_CODE,
    WPD_PROPERTY_MTP_EXT_OPERATION_PARAMS, WPD_PROPERTY_MTP_EXT_OPTIMAL_TRANSFER_BUFFER_SIZE, WPD_PROPERTY_MTP_EXT_RESPONSE_CODE,
    WPD_PROPERTY_MTP_EXT_RESPONSE_PARAMS, WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, WPD_PROPERTY_MTP_EXT_TRANSFER_DATA,
    WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_READ, WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_WRITE,
    WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_WRITTEN, WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE,
};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{VT_UI4, VT_UI8};
use windows::Win32::UI::Shell::{SHFileOperationW, FO_DELETE, SHFILEOPSTRUCTW};

/// How often the list of plugged-in cameras is read again while none is open.
const LOOK_AGAIN: Duration = Duration::from_secs(3);
/// One read or write of a data phase when the driver names no size of its own.
const CHUNK: u32 = 256 * 1024;
/// SECURITY_IMPERSONATION: the driver acts for this process, as every WPD client asks.
const IMPERSONATION: u32 = 0x0002_0000;
/// FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI.
const TO_RECYCLE_BIN: u16 = 0x0004 | 0x0010 | 0x0040 | 0x0400;

type Job = Box<dyn FnOnce(&mut Worker) + Send>;

static JOBS: OnceLock<Sender<Job>> = OnceLock::new();

struct Open {
    device: IPortableDevice,
    /// The event registration, to end it with the session.
    advised: Option<HSTRING>,
}

struct Worker {
    app: AppHandle,
    events: Sender<(String, ptp::Container)>,
    manager: IPortableDeviceManager,
    listed: Vec<Camera>,
    open: HashMap<String, Open>,
}

fn text(error: windows::core::Error) -> String {
    format!("{} (0x{:08x})", error.message(), error.code().0)
}

/// A string the system allocated, copied and freed.
///
/// SAFETY: `string` is null or a NUL-terminated string from CoTaskMemAlloc that nothing else frees.
unsafe fn take_string(string: PWSTR) -> String {
    if string.is_null() {
        return String::new();
    }
    let copy = String::from_utf16_lossy(string.as_wide());
    CoTaskMemFree(Some(string.0 as *const _));
    copy
}

fn create<T: Interface>(class: &GUID) -> Result<T, String> {
    // SAFETY: an in-process COM class of the system, on a thread that initialised COM.
    unsafe { CoCreateInstance(class, None, CLSCTX_INPROC_SERVER) }.map_err(text)
}

fn unsigned32(value: u32) -> PROPVARIANT {
    let mut variant = PROPVARIANT::default();
    // SAFETY: a zeroed PROPVARIANT is VT_EMPTY; these two fields make it a VT_UI4.
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = value;
    }
    variant
}

/// A 32- or 64-bit unsigned value of a result set; the driver's headers and
/// its samples disagree on the width of the sizes.
fn unsigned(values: &IPortableDeviceValues, key: &PROPERTYKEY) -> Option<u64> {
    // SAFETY: GetValue fills a PROPVARIANT this function owns and clears.
    unsafe {
        let mut variant = values.GetValue(key).ok()?;
        let inner = &*variant.Anonymous.Anonymous;
        let value = match inner.vt {
            vt if vt == VT_UI4 => Some(inner.Anonymous.ulVal as u64),
            vt if vt == VT_UI8 => Some(inner.Anonymous.uhVal),
            _ => None,
        };
        let _ = PropVariantClear(&mut variant);
        value
    }
}

/// One command to the driver: its results, once the driver says it succeeded.
fn send(
    device: &IPortableDevice,
    command: &PROPERTYKEY,
    fill: impl FnOnce(&IPortableDeviceValues) -> windows::core::Result<()>,
) -> Result<IPortableDeviceValues, String> {
    let parameters: IPortableDeviceValues = create(&PortableDeviceValues)?;
    // SAFETY: plain calls on COM objects of this thread; every pointer outlives its call.
    unsafe {
        parameters.SetGuidValue(&WPD_PROPERTY_COMMON_COMMAND_CATEGORY, &command.fmtid).map_err(text)?;
        parameters.SetUnsignedIntegerValue(&WPD_PROPERTY_COMMON_COMMAND_ID, command.pid).map_err(text)?;
        fill(&parameters).map_err(text)?;
        let results = device.SendCommand(0, &parameters).map_err(text)?;
        results.GetErrorValue(&WPD_PROPERTY_COMMON_HRESULT).map_err(text)?.ok().map_err(text)?;
        Ok(results)
    }
}

/// The data phase's context, which every later step of the transfer names.
fn transfer_context(results: &IPortableDeviceValues) -> Result<HSTRING, String> {
    // SAFETY: the driver's string is copied and freed.
    let context = unsafe { take_string(results.GetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT).map_err(text)?) };
    Ok(HSTRING::from(context))
}

/// Ends a data phase: the results carry the camera's response.
fn end_transfer(device: &IPortableDevice, context: &HSTRING) -> Result<IPortableDeviceValues, String> {
    // SAFETY: as in `send`.
    send(device, &WPD_COMMAND_MTP_EXT_END_DATA_TRANSFER, |values| unsafe { values.SetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context) })
}

/// The camera's data, read in the driver's pieces.
fn read_data(device: &IPortableDevice, context: &HSTRING, total: u64, chunk: u32) -> Result<Vec<u8>, String> {
    let mut data = Vec::with_capacity(total.min(512 * 1024 * 1024) as usize);
    let buffer = vec![0u8; chunk as usize];
    while (data.len() as u64) < total {
        let want = (total - data.len() as u64).min(chunk as u64) as u32;
        // SAFETY: as in `send`; the driver copies out of `buffer` during the call.
        let results = send(device, &WPD_COMMAND_MTP_EXT_READ_DATA, |values| unsafe {
            values.SetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context)?;
            values.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_READ, want)?;
            values.SetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, &buffer[..want as usize])
        })?;
        let mut bytes: *mut u8 = std::ptr::null_mut();
        let mut length = 0u32;
        // SAFETY: GetBufferValue hands out a CoTaskMemAlloc block of `length` bytes, copied and freed here.
        unsafe {
            results.GetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, &mut bytes, &mut length).map_err(text)?;
            if !bytes.is_null() {
                data.extend_from_slice(std::slice::from_raw_parts(bytes, length as usize));
                CoTaskMemFree(Some(bytes as *const _));
            }
        }
        // A camera that names no size (0xFFFFFFFF) ends its data with a short read.
        if length == 0 {
            break;
        }
    }
    Ok(data)
}

fn write_data(device: &IPortableDevice, context: &HSTRING, data: &[u8], chunk: u32) -> Result<(), String> {
    let mut written = 0usize;
    while written < data.len() {
        let piece = &data[written..(written + chunk as usize).min(data.len())];
        // SAFETY: as in `send`; the driver copies `piece` during the call.
        let results = send(device, &WPD_COMMAND_MTP_EXT_WRITE_DATA, |values| unsafe {
            values.SetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context)?;
            values.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_WRITE, piece.len() as u32)?;
            values.SetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, piece)
        })?;
        match unsigned(&results, &WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_WRITTEN) {
            Some(0) => return Err("the camera took no data".into()),
            Some(count) => written += (count as usize).min(piece.len()),
            None => written += piece.len(),
        }
    }
    Ok(())
}

/// One PTP transaction through the driver.
fn transaction(device: &IPortableDevice, code: u16, parameters: &[u32], out: Option<&[u8]>) -> Result<(ptp::Container, Vec<u8>), String> {
    let sends_data = match out {
        Some(_) => false,
        None => ptp::wpd::sends_data(code).ok_or_else(|| format!("operation 0x{code:04x} is not prepared for Windows"))?,
    };
    let collection: IPortableDevicePropVariantCollection = create(&PortableDevicePropVariantCollection)?;
    for parameter in parameters.iter().take(5) {
        // SAFETY: the collection copies the value.
        unsafe { collection.Add(&unsigned32(*parameter)) }.map_err(text)?;
    }
    let command = match (out, sends_data) {
        (Some(_), _) => &WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_WRITE,
        (None, true) => &WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_READ,
        (None, false) => &WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITHOUT_DATA_PHASE,
    };
    // SAFETY: as in `send`.
    let started = send(device, command, |values| unsafe {
        values.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_OPERATION_CODE, code as u32)?;
        values.SetIPortableDevicePropVariantCollectionValue(&WPD_PROPERTY_MTP_EXT_OPERATION_PARAMS, &collection)?;
        match out {
            Some(data) => values.SetUnsignedLargeIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE, data.len() as u64),
            None => Ok(()),
        }
    })?;
    let chunk = unsigned(&started, &WPD_PROPERTY_MTP_EXT_OPTIMAL_TRANSFER_BUFFER_SIZE)
        .map(|size| size.clamp(4096, 8 * 1024 * 1024) as u32)
        .unwrap_or(CHUNK);
    let mut data = Vec::new();
    let finished = if let Some(out) = out {
        let context = transfer_context(&started)?;
        let wrote = write_data(device, &context, out, chunk);
        // The transfer is ended whatever happened, or the driver keeps its context.
        let ended = end_transfer(device, &context);
        wrote?;
        ended?
    } else if sends_data {
        let context = transfer_context(&started)?;
        let total = unsigned(&started, &WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE).unwrap_or(0);
        let read = read_data(device, &context, total, chunk);
        let ended = end_transfer(device, &context);
        data = read?;
        ended?
    } else {
        started
    };
    // SAFETY: plain reads of the results; the PROPVARIANTs are owned and cleared here.
    unsafe {
        let code = finished.GetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_RESPONSE_CODE).map_err(text)? as u16;
        let mut answered = Vec::new();
        if let Ok(collection) = finished.GetIPortableDevicePropVariantCollectionValue(&WPD_PROPERTY_MTP_EXT_RESPONSE_PARAMS) {
            let mut count = 0u32;
            let _ = collection.GetCount(&mut count as *mut u32 as *const u32);
            for index in 0..count.min(5) {
                let mut variant = PROPVARIANT::default();
                if collection.GetAt(index, &mut variant as *mut PROPVARIANT as *const PROPVARIANT).is_ok() {
                    let inner = &*variant.Anonymous.Anonymous;
                    if inner.vt == VT_UI4 {
                        answered.push(inner.Anonymous.ulVal);
                    }
                }
                let _ = PropVariantClear(&mut variant);
            }
        }
        Ok((ptp::Container { code, transaction: 0, parameters: answered }, data))
    }
}

/// The driver's events for one camera. A new object is passed on as the PTP
/// event the session waits for.
#[implement(IPortableDeviceEventCallback)]
struct Events {
    id: String,
    events: Sender<(String, ptp::Container)>,
}

impl IPortableDeviceEventCallback_Impl for Events_Impl {
    fn OnEvent(&self, parameters: Ref<IPortableDeviceValues>) -> windows::core::Result<()> {
        let Some(values) = parameters.as_ref() else { return Ok(()) };
        // SAFETY: plain reads of the event's values; the string is copied and freed.
        unsafe {
            if values.GetGuidValue(&WPD_EVENT_PARAMETER_EVENT_ID).ok() != Some(WPD_EVENT_OBJECT_ADDED) {
                return Ok(());
            }
            let Ok(object) = values.GetStringValue(&WPD_OBJECT_ID) else { return Ok(()) };
            if let Some(handle) = ptp::wpd::object_handle(&take_string(object)) {
                let event = ptp::Container { code: ptp::ev::OBJECT_ADDED, transaction: 0, parameters: vec![handle] };
                let _ = self.events.send((self.id.clone(), event));
            }
        }
        Ok(())
    }
}

impl Worker {
    /// A device's name as Windows shows it; the model, for a camera.
    fn name(&self, device: PCWSTR) -> String {
        type Getter = unsafe fn(&IPortableDeviceManager, PCWSTR, PWSTR, *mut u32) -> windows::core::Result<()>;
        let getters: [Getter; 2] = [
            |manager, device, name, length| unsafe { manager.GetDeviceFriendlyName(device, name, length) },
            |manager, device, name, length| unsafe { manager.GetDeviceDescription(device, name, length) },
        ];
        for getter in getters {
            let mut length = 0u32;
            // SAFETY: the first call asks for the length, the second fills a buffer of that length.
            unsafe {
                let _ = getter(&self.manager, device, PWSTR::null(), &mut length);
                if length == 0 {
                    continue;
                }
                let mut name = vec![0u16; length as usize];
                if getter(&self.manager, device, PWSTR(name.as_mut_ptr()), &mut length).is_ok() {
                    let name = String::from_utf16_lossy(&name);
                    let name = name.trim_end_matches('\0').trim();
                    if !name.is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
        String::new()
    }

    /// The cameras on USB now. Portable devices are also phones, players and
    /// card readers: only the vendors this app drives are listed.
    fn look(&self) -> Vec<Camera> {
        let mut cameras = Vec::new();
        // SAFETY: GetDevices fills `count` strings from CoTaskMemAlloc, each read and freed here.
        unsafe {
            let _ = self.manager.RefreshDeviceList();
            let mut count = 0u32;
            if self.manager.GetDevices(std::ptr::null_mut(), &mut count).is_err() || count == 0 {
                return cameras;
            }
            let mut devices = vec![PWSTR::null(); count as usize];
            if self.manager.GetDevices(devices.as_mut_ptr(), &mut count).is_err() {
                return cameras;
            }
            for device in devices.into_iter().take(count as usize) {
                if device.is_null() {
                    continue;
                }
                let id = String::from_utf16_lossy(device.as_wide());
                if let Some((usb_vendor, usb_product)) = ptp::wpd::usb_ids(&id) {
                    let name = self.name(PCWSTR(device.0));
                    if ptp::Dialect::of(usb_vendor, &name).is_some() {
                        cameras.push(Camera { id, beta: super::beta(usb_vendor, &name), name, usb_vendor, usb_product, supported: true });
                    }
                }
                CoTaskMemFree(Some(device.0 as *const _));
            }
        }
        cameras.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        cameras
    }

    /// Reads the list again and tells the page when it changed.
    fn look_again(&mut self) {
        let cameras = self.look();
        if cameras != self.listed {
            self.listed = cameras;
            let _ = self.app.emit("tether-cameras", &self.listed);
        }
    }

    fn open(&mut self, id: &str) -> Result<(), String> {
        if self.open.contains_key(id) {
            return Ok(());
        }
        let client: IPortableDeviceValues = create(&PortableDeviceValues)?;
        let device: IPortableDevice = create(&PortableDeviceFTM)?;
        // SAFETY: plain calls on COM objects of this thread.
        let advised = unsafe {
            client.SetStringValue(&WPD_CLIENT_NAME, &HSTRING::from("Negative Converter")).map_err(text)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_MAJOR_VERSION, 1).map_err(text)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_MINOR_VERSION, 0).map_err(text)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_REVISION, 0).map_err(text)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_SECURITY_QUALITY_OF_SERVICE, IMPERSONATION).map_err(text)?;
            device.Open(&HSTRING::from(id), &client).map_err(text)?;
            let callback: IPortableDeviceEventCallback = Events { id: id.to_string(), events: self.events.clone() }.into();
            // Without its events a Leica's photos would not arrive; Sony and Fujifilm are asked instead.
            device.Advise(0, &callback, None).ok().map(|cookie| HSTRING::from(take_string(cookie)))
        };
        self.open.insert(id.to_string(), Open { device, advised });
        Ok(())
    }

    fn close(&mut self, id: &str) {
        if let Some(open) = self.open.remove(id) {
            // SAFETY: plain calls on COM objects of this thread.
            unsafe {
                if let Some(advised) = &open.advised {
                    let _ = open.device.Unadvise(advised);
                }
                let _ = open.device.Close();
            }
        }
        self.look_again();
    }
}

/// Starts the camera thread (once) and returns the way to hand it jobs.
fn start(app: &AppHandle, events: Sender<(String, ptp::Container)>) -> Result<&'static Sender<Job>, String> {
    if let Some(jobs) = JOBS.get() {
        return Ok(jobs);
    }
    let (jobs, queue) = channel::<Job>();
    let (ready, started) = channel::<Result<(), String>>();
    let app = app.clone();
    std::thread::Builder::new()
        .name("tether-wpd".into())
        .spawn(move || {
            // SAFETY: COM is initialised once for this thread, which never ends before the process does.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let manager = match create::<IPortableDeviceManager>(&PortableDeviceManager) {
                Ok(manager) => manager,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            let mut worker = Worker { app, events, manager, listed: Vec::new(), open: HashMap::new() };
            worker.listed = worker.look();
            let _ = ready.send(Ok(()));
            loop {
                match queue.recv_timeout(LOOK_AGAIN) {
                    Ok(job) => job(&mut worker),
                    // Reading the list costs the driver time: not while a camera streams its live view.
                    Err(RecvTimeoutError::Timeout) if worker.open.is_empty() => worker.look_again(),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|error| error.to_string())?;
    started.recv().map_err(|_| "the camera thread did not start".to_string())??;
    Ok(JOBS.get_or_init(|| jobs))
}

/// Runs `work` on the camera thread and hands its result back.
async fn run<T: Send + 'static>(timeout: Duration, work: impl FnOnce(&mut Worker) -> T + Send + 'static) -> Result<T, String> {
    let jobs = JOBS.get().ok_or("tethering is not started")?;
    let (send, receive) = channel();
    jobs.send(Box::new(move |worker: &mut Worker| {
        let _ = send.send(work(worker));
    }))
    .map_err(|_| "the camera thread stopped".to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(timeout))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the camera did not answer".to_string())
}

/// Starts looking for cameras (once) and returns the ones plugged in now;
/// later arrivals and removals reach the page as `tether-cameras`.
pub async fn cameras(app: &AppHandle, events: Sender<(String, ptp::Container)>) -> Result<Vec<Camera>, String> {
    let (app, started) = (app.clone(), events);
    tauri::async_runtime::spawn_blocking(move || start(&app, started).map(|_| ()))
        .await
        .map_err(|error| error.to_string())??;
    run(Duration::from_secs(10), |worker| {
        if worker.open.is_empty() {
            worker.look_again();
        }
        worker.listed.clone()
    })
    .await
}

/// Opens the camera through the system's driver and routes its new objects to the session.
pub async fn open(_app: &AppHandle, id: &str) -> Result<(), String> {
    let id = id.to_string();
    run(Duration::from_secs(60), move |worker| worker.open(&id)).await?
}

/// Lets go of the camera.
pub async fn close(_app: &AppHandle, id: &str) {
    let id = id.to_string();
    let _ = run(Duration::from_secs(10), move |worker| worker.close(&id)).await;
}

/// One PTP transaction: the response and the data-in phase, if any.
pub async fn transact(
    _app: &AppHandle,
    id: &str,
    code: u16,
    parameters: &[u32],
    data_out: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<(ptp::Container, Vec<u8>), String> {
    let (id, parameters) = (id.to_string(), parameters.to_vec());
    run(timeout, move |worker| {
        let open = worker.open.get(&id).ok_or("the camera is no longer connected")?;
        transaction(&open.device, code, &parameters, data_out.as_deref())
    })
    .await?
}

/// Moves a file to the Recycle Bin, where the user can get it back.
pub fn trash(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    // The list of paths ends with two NULs.
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut operation = SHFILEOPSTRUCTW { wFunc: FO_DELETE, pFrom: PCWSTR(from.as_ptr()), fFlags: TO_RECYCLE_BIN, ..Default::default() };
    // SAFETY: `from` outlives the call, which shows no window.
    match unsafe { SHFileOperationW(&mut operation) } {
        0 if !operation.fAnyOperationsAborted.as_bool() => Ok(()),
        0 => Err("the photo was not moved to the Recycle Bin".into()),
        code => Err(format!("the photo was not moved to the Recycle Bin (0x{code:x})")),
    }
}
