//! The macOS transport: ImageCaptureCore finds the cameras on USB and carries
//! PTP transactions to them. The system's `ptpcamerad` owns the USB interface,
//! so this works inside the App Store sandbox and needs no driver.
//!
//! ImageCaptureCore objects stay on the main thread (`MAIN`); the async side
//! talks to them through `run_on_main_thread` and gets answers over channels.
use super::ptp;
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, Message};
use objc2_foundation::{NSData, NSError, NSFileManager, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_image_capture_core::{
    ICCameraDevice, ICDevice, ICDeviceBrowser, ICDeviceBrowserDelegate, ICDeviceLocationTypeMask, ICDeviceTypeMask,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// A camera as the page lists it.
#[derive(Clone, serde::Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub usb_vendor: u16,
    pub usb_product: u16,
    /// A body whose dialect this app speaks; the others are listed only to say so.
    pub supported: bool,
}

struct Main {
    app: AppHandle,
    _browser: Retained<ICDeviceBrowser>,
    _delegate: Retained<BrowserDelegate>,
    cameras: HashMap<String, Retained<ICCameraDevice>>,
    events: Sender<(String, ptp::Container)>,
}

thread_local! {
    static MAIN: RefCell<Option<Main>> = const { RefCell::new(None) };
}

fn describe(device: &ICDevice) -> Camera {
    // SAFETY: plain property reads on a live device, on the main thread.
    unsafe {
        let name = device.name().map(|name| name.to_string()).unwrap_or_default();
        let id = device
            .UUIDString()
            .map(|uuid| uuid.to_string())
            .filter(|uuid| !uuid.is_empty())
            .unwrap_or_else(|| format!("{:04x}:{:04x}:{name}", device.usbVendorID(), device.usbProductID()));
        let usb_vendor = device.usbVendorID() as u16;
        let supported = usb_vendor == ptp::leica::USB_VENDOR && ptp::leica::supported_model(&name);
        Camera { id, name, usb_vendor, usb_product: device.usbProductID() as u16, supported }
    }
}

fn listed(main: &Main) -> Vec<Camera> {
    let mut cameras: Vec<Camera> = main.cameras.values().map(|camera| describe(camera)).collect();
    cameras.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    cameras
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class adds no
    // state; its methods only run on the main thread, where the browser calls them.
    #[unsafe(super(NSObject))]
    #[name = "NCTetherBrowserDelegate"]
    struct BrowserDelegate;

    unsafe impl NSObjectProtocol for BrowserDelegate {}

    unsafe impl ICDeviceBrowserDelegate for BrowserDelegate {
        #[unsafe(method(deviceBrowser:didAddDevice:moreComing:))]
        fn did_add(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more_coming: bool) {
            let Ok(camera) = device.retain().downcast::<ICCameraDevice>() else { return };
            MAIN.with_borrow_mut(|main| {
                let Some(main) = main.as_mut() else { return };
                main.cameras.insert(describe(device).id, camera);
                let _ = main.app.emit("tether-cameras", listed(main));
            });
        }

        #[unsafe(method(deviceBrowser:didRemoveDevice:moreGoing:))]
        fn did_remove(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more_going: bool) {
            MAIN.with_borrow_mut(|main| {
                let Some(main) = main.as_mut() else { return };
                main.cameras.remove(&describe(device).id);
                let _ = main.app.emit("tether-cameras", listed(main));
            });
        }
    }
);

impl BrowserDelegate {
    fn new() -> Retained<Self> {
        // SAFETY: NSObject's designated initializer on a fresh allocation.
        unsafe { msg_send![Self::alloc(), init] }
    }
}

/// Starts looking for cameras (once) and returns the ones known so far; later
/// arrivals and removals reach the page as `tether-cameras`.
pub async fn cameras(app: &AppHandle, events: Sender<(String, ptp::Container)>) -> Result<Vec<Camera>, String> {
    on_main(app, move |app| {
        MAIN.with_borrow_mut(|main| {
            if main.is_none() {
                // SAFETY: created, configured and started on the main thread;
                // the delegate outlives the browser's (weak) reference in `Main`.
                unsafe {
                    let browser = ICDeviceBrowser::new();
                    let delegate = BrowserDelegate::new();
                    browser.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                    browser.setBrowsedDeviceTypeMask(ICDeviceTypeMask(
                        ICDeviceTypeMask::Camera.0 | ICDeviceLocationTypeMask::Local.0,
                    ));
                    browser.start();
                    *main = Some(Main { app: app.clone(), _browser: browser, _delegate: delegate, cameras: HashMap::new(), events });
                }
            }
            listed(main.as_ref().unwrap())
        })
    })
    .await
}

/// Runs `work` on the main thread and hands its result back.
async fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Result<T, String> {
    let (send, receive) = channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(10)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the main thread did not answer".to_string())
}

fn with_camera<T>(id: &str, work: impl FnOnce(&Main, &ICCameraDevice) -> T) -> Result<T, String> {
    MAIN.with_borrow(|main| {
        let main = main.as_ref().ok_or("tethering is not started")?;
        let camera = main.cameras.get(id).ok_or("the camera is no longer connected")?;
        Ok(work(main, camera))
    })
}

/// The bytes of an NSData a block was handed. ImageCaptureCore passes nil for
/// a transaction without a data phase, whatever the header's nullability says,
/// so the blocks below take raw pointers and are cast to the bindings' types.
fn bytes_of(data: *mut NSData) -> Vec<u8> {
    // SAFETY: a non-null NSData handed to a block is valid for the call.
    unsafe { data.as_ref() }.map(|data| data.to_vec()).unwrap_or_default()
}

fn error_text(error: *mut NSError) -> Option<String> {
    // SAFETY: a non-null error handed to a completion block is a live NSError for the call.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

/// Moves a file to the Trash, where the user can get it back.
pub fn trash(path: &std::path::Path) -> Result<(), String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| error.localizedDescription().to_string())
}

/// Opens the system's session with the camera and routes its PTP events to `events`.
pub async fn open(app: &AppHandle, id: &str) -> Result<(), String> {
    let (send, receive) = channel::<Option<String>>();
    let camera_id = id.to_string();
    on_main(app, move |_| {
        with_camera(&camera_id, |main, camera| {
            let events = main.events.clone();
            let event_id = camera_id.clone();
            let handler = RcBlock::new(move |data: *mut NSData| {
                if let Some(event) = ptp::event(&bytes_of(data)) {
                    let _ = events.send((event_id.clone(), event));
                }
            });
            // SAFETY: the same block ABI; only the declared nullability differs (bytes_of).
            let handler: &DynBlock<dyn Fn(NonNull<NSData>)> = unsafe { std::mem::transmute(&*handler) };
            let opened = RcBlock::new(move |error: *mut NSError| {
                let _ = send.send(error_text(error));
            });
            // SAFETY: both blocks are copied by ImageCaptureCore; the calls are on the main thread.
            unsafe {
                camera.setPtpEventHandler(handler);
                if camera.hasOpenSession() {
                    opened.call((std::ptr::null_mut(),));
                } else {
                    camera.requestOpenSessionWithOptions_completion(None, &opened);
                }
            }
        })
    })
    .await??;
    // The system lists the card before it reports the session open: 17 s
    // was measured for 748 files with two other apps on the camera.
    match tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(60)))
        .await
        .map_err(|error| error.to_string())?
    {
        Ok(None) => Ok(()),
        Ok(Some(error)) => Err(error),
        Err(_) => Err("the camera did not open a session".into()),
    }
}

/// Closes the system's session with the camera.
pub async fn close(app: &AppHandle, id: &str) {
    let camera_id = id.to_string();
    let _ = on_main(app, move |_| {
        // SAFETY: a plain request on the main thread.
        with_camera(&camera_id, |_, camera| unsafe {
            if camera.hasOpenSession() {
                camera.requestCloseSession();
            }
        })
    })
    .await;
}

/// One PTP transaction: the response container and the data-in phase, if any.
pub async fn transact(
    app: &AppHandle,
    id: &str,
    command: Vec<u8>,
    data_out: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<(ptp::Container, Vec<u8>), String> {
    let (send, receive) = channel::<Result<(Vec<u8>, Vec<u8>), String>>();
    let camera_id = id.to_string();
    on_main(app, move |_| {
        with_camera(&camera_id, |_, camera| {
            let completion = RcBlock::new(move |first: *mut NSData, second: *mut NSData, error: *mut NSError| {
                let result = match error_text(error) {
                    Some(error) => Err(error),
                    None => Ok((bytes_of(first), bytes_of(second))),
                };
                let _ = send.send(result);
            });
            // SAFETY: the same block ABI; only the declared nullability differs (bytes_of).
            let completion: &DynBlock<dyn Fn(NonNull<NSData>, NonNull<NSData>, *mut NSError)> = unsafe { std::mem::transmute(&*completion) };
            let command = NSData::with_bytes(&command);
            let data_out = data_out.map(|bytes| NSData::with_bytes(&bytes));
            // SAFETY: the command and data are copied by ImageCaptureCore before the call returns.
            unsafe { camera.requestSendPTPCommand_outData_completion(&command, data_out.as_deref(), completion) };
        })
    })
    .await??;
    let (first, second) = tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(timeout))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the camera did not answer".to_string())??;
    let (response, data) = ptp::split_transaction(&first, &second);
    let response = response.ok_or("the camera sent no response")?;
    Ok((response, data.to_vec()))
}
