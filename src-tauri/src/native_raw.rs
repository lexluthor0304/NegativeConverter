//! Native LibRaw decode for the desktop app (#264 part C).
//!
//! The page decodes RAW files with libraw-wasm on one core. Here the same
//! LibRaw release, with the same parameters and the same determinism flags
//! (docs/native-raw-decode.md), runs natively with OpenMP on the blocking
//! pool, and its result is served as the packed RGBA16 plane the page's
//! post-decode pass builds (`packRGBToImage16`: alpha 65535, one channel
//! replicated, 8-bit samples ×257).
//!
//! The page drives one decode per session, the way it drives libraw-wasm:
//!   `native_raw_begin` → `native_raw_append` (raw 8 MiB chunks of the bytes
//!   the page already holds, so the App Store sandbox never sees a path) →
//!   `native_raw_open` (open_buffer + metadata) → the page's memory
//!   reservation → `native_raw_process` (unpack, dcraw_process, the plane) →
//!   GET `rawdecode://localhost/<id>?part=k` (`http://rawdecode.localhost/…`
//!   on Windows) from a worker → `native_raw_release`.
//! Releasing a session cancels its running decode (LibRaw's cancel flag, a
//! progress handler that stops dcraw_process at its next check, and the
//! plane packing) and frees its memory.
//!
//! Without the decoder compiled in (`cfg(native_raw)`, see
//! native/build_libraw.rs) the commands report it unavailable.
#![cfg_attr(not(native_raw), allow(dead_code))]

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// Must equal NATIVE_RAW_UPLOAD_CHUNK_BYTES in nativeRawDecoder.js (its test
/// reads this line).
pub const UPLOAD_CHUNK_LIMIT: usize = 8 * 1024 * 1024;
/// Bytes of the packed plane per `rawdecode://` response. wry copies each
/// response body once more before WebKit/WebView2 take it, so parts keep that
/// transient copy small.
pub const PIXEL_PART_BYTES: usize = 32 * 1024 * 1024;
/// Largest RAW file accepted (the heaviest IIQ/3FR files are ~250 MB).
const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
/// A session the page stopped talking to (a lost release) is dropped after
/// this long without a call. Generous: between `open` and `process` the page
/// may wait for its memory budget (#258) behind a batch's other frames.
const SESSION_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);
const MAX_SESSIONS: usize = 12;
/// The URI scheme that serves decoded planes.
pub const PIXEL_SCHEME: &str = "rawdecode";

// LibRaw's return codes (libraw_const.h, enum LibRaw_errors).
const LIBRAW_SUCCESS: i32 = 0;
#[cfg(test)]
const LIBRAW_UNSPECIFIED_ERROR: i32 = -1;
const LIBRAW_FILE_UNSUPPORTED: i32 = -2;
const LIBRAW_REQUEST_FOR_NONEXISTENT_IMAGE: i32 = -3;
const LIBRAW_OUT_OF_ORDER_CALL: i32 = -4;
const LIBRAW_NOT_IMPLEMENTED: i32 = -8;
const LIBRAW_UNSUFFICIENT_MEMORY: i32 = -100_007;
const LIBRAW_DATA_ERROR: i32 = -100_008;
const LIBRAW_IO_ERROR: i32 = -100_009;
const LIBRAW_CANCELLED_BY_CALLBACK: i32 = -100_010;
const LIBRAW_BAD_CROP: i32 = -100_011;
const LIBRAW_TOO_BIG: i32 = -100_012;
const LIBRAW_MEMPOOL_OVERFLOW: i32 = -100_013;
// nc_libraw.cpp: a sample layout the page would reject, or a wrong plane.
const NC_RAW_BAD_LAYOUT: i32 = -200_001;
// libraw_const.h LIBRAW_WARN_NO_JPEGLIB: identify() refused a lossy DNG or
// Kodak JPEG file because this build has no libjpeg; libraw-wasm has one.
const LIBRAW_WARN_NO_JPEGLIB: u32 = 1 << 4;

#[cfg(native_raw)]
mod ffi {
    use std::os::raw::{c_char, c_int, c_uchar, c_uint};
    #[cfg(test)]
    use std::os::raw::c_void;

    #[repr(C)]
    pub struct NcRaw {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct NcRawOptions {
        pub half_size: c_int,
        pub output_bps: c_int,
    }

    #[repr(C)]
    pub struct NcRawMeta {
        pub width: c_uint,
        pub height: c_uint,
        pub raw_width: c_uint,
        pub raw_height: c_uint,
        pub top_margin: c_uint,
        pub left_margin: c_uint,
        pub flip: c_int,
        pub make: [c_char; 64],
        pub model: [c_char; 64],
        pub iso_speed: f32,
        pub shutter: f32,
        pub aperture: f32,
        pub focal_len: f32,
        pub timestamp: f64,
        pub shot_order: c_uint,
        pub desc: [c_char; 512],
        pub artist: [c_char; 64],
        pub gps_latitude: [f32; 3],
        pub gps_longitude: [f32; 3],
        pub gps_altitude: f32,
        pub gps_latref: c_char,
        pub gps_longref: c_char,
        pub gps_altref: c_char,
        pub gps_status: c_char,
        pub gps_parsed: c_char,
        pub thumb_width: c_uint,
        pub thumb_height: c_uint,
        pub thumb_format: c_int,
        pub lens: [c_char; 128],
        pub lens_make: [c_char; 128],
        pub lens_serial: [c_char; 128],
        pub internal_lens_serial: [c_char; 128],
        pub lens_min_focal: f32,
        pub lens_max_focal: f32,
        pub lens_max_ap4_min_focal: f32,
        pub lens_max_ap4_max_focal: f32,
        pub lens_exif_max_ap: f32,
        pub lens_focal_35mm: c_int,
        pub mk_lens: [c_char; 128],
        pub mk_lens_id: f64,
        pub mk_min_focal: f32,
        pub mk_max_focal: f32,
        pub mk_max_ap: f32,
        pub mk_min_ap: f32,
        pub mk_cur_focal: f32,
        pub mk_cur_ap: f32,
        pub mk_focal_35mm: f32,
        pub mk_min_focus_distance: f32,
        pub mk_lens_mount: c_int,
        pub mk_camera_mount: c_int,
        pub mk_body: [c_char; 64],
        pub process_warnings: c_uint,
    }

    #[cfg(test)]
    #[repr(C)]
    pub struct NcRawImage {
        pub width: c_int,
        pub height: c_int,
        pub colors: c_int,
        pub bits: c_int,
        pub size: usize,
        pub data: *const c_uchar,
        pub handle: *mut c_void,
    }

    extern "C" {
        pub fn nc_raw_new() -> *mut NcRaw;
        pub fn nc_raw_free(raw: *mut NcRaw);
        pub fn nc_raw_open(raw: *mut NcRaw, data: *const c_uchar, size: usize, options: *const NcRawOptions) -> c_int;
        pub fn nc_raw_metadata(raw: *mut NcRaw, out: *mut NcRawMeta) -> c_int;
        pub fn nc_raw_process(raw: *mut NcRaw, threads: c_int) -> c_int;
        pub fn nc_raw_image_format(raw: *mut NcRaw, width: *mut c_int, height: *mut c_int, colors: *mut c_int, bps: *mut c_int) -> c_int;
        pub fn nc_raw_release_input(raw: *mut NcRaw);
        pub fn nc_raw_pack_rgba16(raw: *mut NcRaw, out: *mut c_uchar, out_size: usize, threads: c_int) -> c_int;
        pub fn nc_raw_recycle(raw: *mut NcRaw);
        pub fn nc_raw_cancel(raw: *mut NcRaw);
        pub fn nc_raw_libraw_version() -> *const c_char;
        pub fn nc_raw_openmp() -> c_int;
        pub fn nc_raw_max_threads() -> c_int;
        pub fn nc_raw_openmp_register();
        pub fn nc_raw_strerror(code: c_int) -> *const c_char;
        // The parity tests' reference path (dcraw_make_mem_image) and flips.
        #[cfg(test)]
        pub fn nc_raw_make_image(raw: *mut NcRaw, out: *mut NcRawImage) -> c_int;
        #[cfg(test)]
        pub fn nc_raw_free_image(image: *mut NcRawImage);
        #[cfg(test)]
        pub fn nc_raw_set_flip(raw: *mut NcRaw, flip: c_int);
    }
}

/// The libraw-wasm options rawFileLoader.js varies per decode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecodeOptions {
    pub half_size: bool,
    pub output_bps: u8,
}

/// What libraw-wasm's `metadata(true)` reports that the page reads, in its
/// key order: the oriented size (memory budget), camera and lens fields
/// (`extractRawLensMetadata`). Float fields are LibRaw's `float`s widened
/// exactly, as embind hands them to JavaScript.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RawMetadata {
    pub width: u32,
    pub height: u32,
    pub raw_width: u32,
    pub raw_height: u32,
    pub top_margin: u32,
    pub left_margin: u32,
    pub flip: i32,
    pub camera_make: String,
    pub camera_model: String,
    pub iso_speed: f64,
    pub shutter: f64,
    pub aperture: f64,
    pub focal_len: f64,
    pub timestamp: f64,
    pub shot_order: u32,
    pub desc: String,
    pub artist: String,
    pub gps_data: GpsData,
    pub thumb_width: u32,
    pub thumb_height: u32,
    pub thumb_format: i32,
    pub lens: LensInfo,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct GpsData {
    pub latitude: [f64; 3],
    pub longitude: [f64; 3],
    pub altitude: f64,
    pub latref: Option<String>,
    pub longref: Option<String>,
    pub altref: i32,
    pub gpsstatus: Option<String>,
    pub gpsparsed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[allow(non_snake_case)]
pub struct LensInfo {
    pub Lens: String,
    pub LensMake: String,
    pub LensSerial: String,
    pub InternalLensSerial: String,
    pub MinFocal: f64,
    pub MaxFocal: f64,
    pub MaxAp4MinFocal: f64,
    pub MaxAp4MaxFocal: f64,
    pub EXIF_MaxAp: f64,
    pub FocalLengthIn35mmFormat: i32,
    pub makernotes: LensMakernotes,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[allow(non_snake_case)]
pub struct LensMakernotes {
    pub Lens: String,
    pub LensID: f64,
    pub MinFocal: f64,
    pub MaxFocal: f64,
    pub MaxAp: f64,
    pub MinAp: f64,
    pub CurFocal: f64,
    pub CurAp: f64,
    pub FocalLengthIn35mmFormat: f64,
    pub MinFocusDistance: f64,
    pub LensMount: i32,
    pub CameraMount: i32,
    pub body: String,
}

/// The page's packing of libraw-wasm's `imageData()` result
/// (`packRGBToImage16(rawResultToRgb16(result))`), from
/// `dcraw_make_mem_image`'s samples: RGBA, 16 bits native-endian, alpha
/// 65535 for RGB and grey, a single channel replicated to RGB, a fourth
/// channel kept, 8-bit samples scaled by 257. The decode path writes the
/// plane straight from LibRaw's image (nc_libraw.cpp, NcLibRaw::pack_rgba16);
/// the tests hold it to this.
#[cfg(test)]
pub fn pack_rgba16(width: usize, height: usize, colors: usize, bits: usize, data: &[u8]) -> Option<Vec<u8>> {
    let pixels = width.checked_mul(height)?;
    if pixels == 0 || !matches!(colors, 1 | 3 | 4) || !matches!(bits, 8 | 16) {
        return None;
    }
    let bytes_per_pixel = colors * bits / 8;
    if data.len() < pixels.checked_mul(bytes_per_pixel)? {
        return None;
    }
    let sample = |pixel: &[u8], index: usize| -> u16 {
        if bits == 16 {
            u16::from_ne_bytes([pixel[index * 2], pixel[index * 2 + 1]])
        } else {
            u16::from(pixel[index]) * 257
        }
    };
    let mut out = Vec::with_capacity(pixels * 8);
    for pixel in data[..pixels * bytes_per_pixel].chunks_exact(bytes_per_pixel) {
        let (r, g, b, a) = match colors {
            1 => {
                let v = sample(pixel, 0);
                (v, v, v, u16::MAX)
            }
            3 => (sample(pixel, 0), sample(pixel, 1), sample(pixel, 2), u16::MAX),
            _ => (sample(pixel, 0), sample(pixel, 1), sample(pixel, 2), sample(pixel, 3)),
        };
        for value in [r, g, b, a] {
            out.extend_from_slice(&value.to_ne_bytes());
        }
    }
    Some(out)
}

/// A zeroed buffer, or None when the allocator refuses (instead of aborting
/// the app over one plane).
fn zeroed_bytes(length: usize) -> Option<Vec<u8>> {
    if length == 0 {
        return Some(Vec::new());
    }
    let layout = std::alloc::Layout::array::<u8>(length).ok()?;
    // SAFETY: non-zero size; the Vec takes ownership of exactly this block.
    unsafe {
        let ptr = std::alloc::alloc_zeroed(layout);
        (!ptr.is_null()).then(|| Vec::from_raw_parts(ptr, length, length))
    }
}

/// How the page should continue after a step (see nativeRawDecoder.js).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    /// The step succeeded.
    Ok,
    /// LibRaw rejected the file itself. libraw-wasm runs the same code on the
    /// same bytes and fails the same way, so the page takes the path it
    /// takes for that failure and never retries with WASM (the HE-compressed
    /// NEFs).
    LibrawError,
    /// This process could not decode the file the way libraw-wasm does (no
    /// libjpeg for lossy DNG, out of memory, an unexpected failure or sample
    /// layout): decode with WASM.
    NeedsWasm,
    /// The session was released while the step ran.
    Cancelled,
}

/// Which way a LibRaw failure goes. Only failures that are properties of the
/// file skip the WASM retry; memory, unexpected exceptions and anything
/// unknown are this process's own and decode with WASM instead.
pub fn failure_status(code: i32) -> StepStatus {
    match code {
        LIBRAW_FILE_UNSUPPORTED
        | LIBRAW_REQUEST_FOR_NONEXISTENT_IMAGE
        | LIBRAW_NOT_IMPLEMENTED
        | LIBRAW_DATA_ERROR
        | LIBRAW_IO_ERROR
        | LIBRAW_BAD_CROP
        | LIBRAW_TOO_BIG
        | LIBRAW_MEMPOOL_OVERFLOW => StepStatus::LibrawError,
        LIBRAW_CANCELLED_BY_CALLBACK => StepStatus::Cancelled,
        _ => StepStatus::NeedsWasm,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReply {
    pub status: StepStatus,
    pub code: i32,
    pub message: String,
    pub metadata: Option<RawMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReply {
    pub status: StepStatus,
    pub code: i32,
    pub message: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
    pub part_bytes: u64,
    pub parts: u32,
    pub threads: u32,
    pub decode_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRawInfo {
    /// The decoder is compiled into this build.
    pub available: bool,
    /// LibRaw runs its parallel regions on several threads.
    pub openmp: bool,
    pub max_threads: u32,
    pub libraw: String,
    /// `<os>-<arch>`, the key the page's parity gate lists.
    pub platform: String,
    pub scheme: &'static str,
    pub upload_chunk_bytes: u64,
}

fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(native_raw)]
fn c_text(text: &[std::os::raw::c_char]) -> String {
    let bytes: Vec<u8> = text.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(native_raw)]
fn c_char_ref(value: std::os::raw::c_char) -> Option<String> {
    (value != 0).then(|| String::from_utf8_lossy(&[value as u8]).into_owned())
}

#[cfg(native_raw)]
pub fn strerror(code: i32) -> String {
    if code == NC_RAW_BAD_LAYOUT {
        return "unexpected sample layout".into();
    }
    // SAFETY: libraw_strerror returns a static NUL-terminated string.
    unsafe {
        let text = ffi::nc_raw_strerror(code);
        if text.is_null() {
            return format!("LibRaw error {code}");
        }
        std::ffi::CStr::from_ptr(text).to_string_lossy().into_owned()
    }
}

#[cfg(not(native_raw))]
pub fn strerror(code: i32) -> String {
    format!("LibRaw error {code}")
}

pub fn info() -> NativeRawInfo {
    #[cfg(native_raw)]
    let (available, openmp, max_threads, libraw) = unsafe {
        // SAFETY: plain queries of static build information.
        let version = ffi::nc_raw_libraw_version();
        let version = if version.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(version).to_string_lossy().into_owned()
        };
        (true, ffi::nc_raw_openmp() != 0, ffi::nc_raw_max_threads().max(1) as u32, version)
    };
    #[cfg(not(native_raw))]
    let (available, openmp, max_threads, libraw) = (false, false, 1u32, String::new());
    NativeRawInfo {
        available,
        openmp,
        max_threads,
        libraw,
        platform: platform_key(),
        scheme: PIXEL_SCHEME,
        upload_chunk_bytes: UPLOAD_CHUNK_LIMIT as u64,
    }
}

/// Stops a decode from another thread. The decoder clears the pointer under
/// the lock before it frees LibRaw, so a late cancel never touches freed
/// memory.
#[derive(Default)]
pub struct Canceller {
    #[cfg(native_raw)]
    raw: Mutex<Option<SendPtr>>,
    requested: std::sync::atomic::AtomicBool,
}

#[cfg(native_raw)]
struct SendPtr(*mut ffi::NcRaw);
// SAFETY: the pointer is only dereferenced through nc_raw_cancel, which LibRaw
// allows from any thread, and only while the owning Decoder is alive.
#[cfg(native_raw)]
unsafe impl Send for SendPtr {}

impl Canceller {
    pub fn cancel(&self) {
        self.requested.store(true, Ordering::SeqCst);
        #[cfg(native_raw)]
        if let Ok(raw) = self.raw.lock() {
            if let Some(ptr) = raw.as_ref() {
                // SAFETY: see SendPtr.
                unsafe { ffi::nc_raw_cancel(ptr.0) };
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
}

/// One LibRaw instance and the file bytes it reads in place.
#[cfg(native_raw)]
pub struct Decoder {
    raw: *mut ffi::NcRaw,
    // Read by LibRaw through `raw` until release_input() or drop.
    input: Vec<u8>,
    canceller: Arc<Canceller>,
}

// SAFETY: a LibRaw object may move between threads; it is used by one thread
// at a time (the session hands it to one blocking task), and the only
// concurrent entry point is Canceller::cancel.
#[cfg(native_raw)]
unsafe impl Send for Decoder {}

/// Keeps the statically linked OpenMP runtime alive for the whole process.
/// libomp shuts down when the last thread registered with it exits, and the
/// decodes run on blocking-pool threads that come and go; a restarted runtime
/// leaves LibRaw's `omp critical` lock dangling (a crash on the next decode).
/// One parked thread that registered first never exits, so the runtime stays.
#[cfg(native_raw)]
fn openmp_anchor() {
    static ANCHOR: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ANCHOR.get_or_init(|| {
        let (registered, wait) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new().name("libraw-openmp-anchor".into()).stack_size(64 * 1024).spawn(move || {
            // SAFETY: registers this thread with libomp; no other effect.
            unsafe { ffi::nc_raw_openmp_register() };
            let _ = registered.send(());
            loop {
                std::thread::park();
            }
        });
        if spawned.is_ok() {
            let _ = wait.recv();
        }
    });
}

#[cfg(native_raw)]
impl Decoder {
    pub fn new(input: Vec<u8>) -> Result<Self, String> {
        openmp_anchor();
        // SAFETY: plain allocation; null on failure.
        let raw = unsafe { ffi::nc_raw_new() };
        if raw.is_null() {
            return Err("LibRaw could not be allocated".into());
        }
        let canceller = Arc::new(Canceller::default());
        *canceller.raw.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(SendPtr(raw));
        Ok(Self { raw, input, canceller })
    }

    pub fn canceller(&self) -> Arc<Canceller> {
        self.canceller.clone()
    }

    /// open_buffer() with the page's parameters; LibRaw's return code.
    pub fn open(&mut self, options: DecodeOptions) -> i32 {
        let options = ffi::NcRawOptions {
            half_size: i32::from(options.half_size),
            output_bps: if options.output_bps == 8 { 8 } else { 16 },
        };
        // SAFETY: `input` stays alive and unmoved until release_input() or
        // drop, which close LibRaw's view of it first.
        unsafe { ffi::nc_raw_open(self.raw, self.input.as_ptr(), self.input.len(), &options) }
    }

    /// LibRaw's metadata after open() (also after a failed open, as
    /// libraw-wasm reports it), plus its process warnings.
    pub fn metadata(&mut self) -> (RawMetadata, u32) {
        // SAFETY: NcRawMeta is plain old data; the shim fills it.
        let mut meta: ffi::NcRawMeta = unsafe { std::mem::zeroed() };
        unsafe { ffi::nc_raw_metadata(self.raw, &mut meta) };
        let f = f64::from;
        let metadata = RawMetadata {
            width: meta.width,
            height: meta.height,
            raw_width: meta.raw_width,
            raw_height: meta.raw_height,
            top_margin: meta.top_margin,
            left_margin: meta.left_margin,
            flip: meta.flip,
            camera_make: c_text(&meta.make),
            camera_model: c_text(&meta.model),
            iso_speed: f(meta.iso_speed),
            shutter: f(meta.shutter),
            aperture: f(meta.aperture),
            focal_len: f(meta.focal_len),
            timestamp: meta.timestamp,
            shot_order: meta.shot_order,
            desc: c_text(&meta.desc),
            artist: c_text(&meta.artist),
            gps_data: GpsData {
                latitude: meta.gps_latitude.map(f),
                longitude: meta.gps_longitude.map(f),
                altitude: f(meta.gps_altitude),
                latref: c_char_ref(meta.gps_latref),
                longref: c_char_ref(meta.gps_longref),
                altref: i32::from(meta.gps_altref as i8),
                gpsstatus: c_char_ref(meta.gps_status),
                gpsparsed: meta.gps_parsed != 0,
            },
            thumb_width: meta.thumb_width,
            thumb_height: meta.thumb_height,
            thumb_format: meta.thumb_format,
            lens: LensInfo {
                Lens: c_text(&meta.lens),
                LensMake: c_text(&meta.lens_make),
                LensSerial: c_text(&meta.lens_serial),
                InternalLensSerial: c_text(&meta.internal_lens_serial),
                MinFocal: f(meta.lens_min_focal),
                MaxFocal: f(meta.lens_max_focal),
                MaxAp4MinFocal: f(meta.lens_max_ap4_min_focal),
                MaxAp4MaxFocal: f(meta.lens_max_ap4_max_focal),
                EXIF_MaxAp: f(meta.lens_exif_max_ap),
                FocalLengthIn35mmFormat: meta.lens_focal_35mm,
                makernotes: LensMakernotes {
                    Lens: c_text(&meta.mk_lens),
                    LensID: meta.mk_lens_id,
                    MinFocal: f(meta.mk_min_focal),
                    MaxFocal: f(meta.mk_max_focal),
                    MaxAp: f(meta.mk_max_ap),
                    MinAp: f(meta.mk_min_ap),
                    CurFocal: f(meta.mk_cur_focal),
                    CurAp: f(meta.mk_cur_ap),
                    FocalLengthIn35mmFormat: f(meta.mk_focal_35mm),
                    MinFocusDistance: f(meta.mk_min_focus_distance),
                    LensMount: meta.mk_lens_mount,
                    CameraMount: meta.mk_camera_mount,
                    body: c_text(&meta.mk_body),
                },
            },
        };
        (metadata, meta.process_warnings)
    }

    /// unpack() + dcraw_process() on this thread with `threads` OpenMP
    /// threads (0: every core).
    pub fn process(&mut self, threads: u32) -> i32 {
        // SAFETY: exclusive use of `raw` on this thread.
        unsafe { ffi::nc_raw_process(self.raw, threads.min(i32::MAX as u32) as i32) }
    }

    /// The processed image's (width, height) when its samples are a layout
    /// the page packs (1, 3 or 4 colours of 8 or 16 bits), else None.
    pub fn plane_size(&mut self) -> Option<(usize, usize)> {
        let (mut width, mut height, mut colors, mut bps) = (0, 0, 0, 0);
        // SAFETY: the shim writes the four ints.
        let code = unsafe { ffi::nc_raw_image_format(self.raw, &mut width, &mut height, &mut colors, &mut bps) };
        let usable = code == LIBRAW_SUCCESS && width > 0 && height > 0 && matches!(colors, 1 | 3 | 4) && matches!(bps, 8 | 16);
        usable.then_some((width as usize, height as usize))
    }

    /// Closes LibRaw's view of the file bytes and frees them. Only after
    /// dcraw_process(): nothing later reads the file.
    pub fn release_input(&mut self) {
        // SAFETY: exclusive use of `raw` on this thread.
        unsafe { ffi::nc_raw_release_input(self.raw) };
        self.input = Vec::new();
    }

    /// The packed RGBA16 plane into `plane` (width × height × 8 bytes).
    pub fn pack_rgba16(&mut self, plane: &mut [u8], threads: u32) -> i32 {
        // SAFETY: exclusive use of `raw`; the shim writes at most
        // `plane.len()` bytes and checks that length first.
        unsafe { ffi::nc_raw_pack_rgba16(self.raw, plane.as_mut_ptr(), plane.len(), threads.min(i32::MAX as u32) as i32) }
    }

    /// Frees LibRaw's working buffers and the file bytes.
    pub fn recycle(&mut self) {
        // SAFETY: exclusive use of `raw` on this thread.
        unsafe { ffi::nc_raw_recycle(self.raw) };
        self.input = Vec::new();
    }
}

#[cfg(native_raw)]
impl Drop for Decoder {
    fn drop(&mut self) {
        let mut guard = self.canceller.raw.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
        // SAFETY: no cancel can reach `raw` any more; freed once, before
        // `input` (a field, dropped after this).
        unsafe { ffi::nc_raw_free(self.raw) };
    }
}

/// The result of a whole native decode as the page receives it.
#[cfg(native_raw)]
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba16: Vec<u8>,
}

/// unpack → dcraw_process → the packed RGBA16 plane. The file bytes are
/// freed before the plane is allocated and LibRaw's working buffers right
/// after it is written, so at 60 MP the peak is LibRaw's image and raw data
/// plus the plane (about 1.1 GB). `Err((status, code))` on failure.
#[cfg(native_raw)]
pub fn process_to_rgba16(decoder: &mut Decoder, threads: u32) -> Result<Decoded, (StepStatus, i32)> {
    let canceller = decoder.canceller();
    let stopped = (StepStatus::Cancelled, LIBRAW_CANCELLED_BY_CALLBACK);
    let code = decoder.process(threads);
    if canceller.is_cancelled() {
        return Err(stopped);
    }
    if code != LIBRAW_SUCCESS {
        return Err((failure_status(code), code));
    }
    let (width, height) = decoder.plane_size().ok_or((StepStatus::NeedsWasm, NC_RAW_BAD_LAYOUT))?;
    decoder.release_input();
    let length = width.checked_mul(height).and_then(|pixels| pixels.checked_mul(8));
    let mut plane = length.and_then(zeroed_bytes).ok_or((StepStatus::NeedsWasm, LIBRAW_UNSUFFICIENT_MEMORY))?;
    let code = decoder.pack_rgba16(&mut plane, threads);
    decoder.recycle();
    if canceller.is_cancelled() {
        return Err(stopped);
    }
    if code != LIBRAW_SUCCESS {
        return Err((failure_status(code), code));
    }
    Ok(Decoded { width: width as u32, height: height as u32, rgba16: plane })
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

fn session_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    // Unguessable enough for a URL only this webview can load: two
    // randomly keyed SipHash outputs over a counter and the clock.
    let counter = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut parts = [0u64; 2];
    for part in parts.iter_mut() {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(counter);
        hasher.write_u128(now);
        *part = hasher.finish();
    }
    format!("{:016x}{:016x}", parts[0], parts[1])
}

enum Stage {
    Uploading { bytes: Vec<u8>, expected: usize },
    #[cfg(native_raw)]
    Opened { decoder: Box<Decoder>, failed: bool },
    /// A blocking task holds the decoder.
    Busy,
    Decoded { pixels: Arc<Vec<u8>> },
}

struct Session {
    stage: Stage,
    canceller: Option<Arc<Canceller>>,
    touched: Instant,
}

/// Native decodes by session id.
#[derive(Default)]
pub struct NativeRawDecodes(Mutex<HashMap<String, Session>>);

impl NativeRawDecodes {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, expected: u64) -> Result<String, String> {
        if expected == 0 || expected > MAX_INPUT_BYTES {
            return Err("RAW file size out of range".into());
        }
        let mut sessions = self.sessions();
        let stale: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| session.touched.elapsed() > SESSION_IDLE_LIMIT)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(session) = sessions.remove(&id) {
                if let Some(canceller) = session.canceller {
                    canceller.cancel();
                }
            }
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("too many native RAW decodes".into());
        }
        let expected = expected as usize;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(expected).map_err(|_| "not enough memory for the RAW file".to_string())?;
        let id = session_id();
        sessions.insert(id.clone(), Session { stage: Stage::Uploading { bytes, expected }, canceller: None, touched: Instant::now() });
        Ok(id)
    }

    pub fn append(&self, id: &str, chunk: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions();
        let session = sessions.get_mut(id).ok_or("unknown native RAW decode")?;
        session.touched = Instant::now();
        let Stage::Uploading { bytes, expected } = &mut session.stage else {
            return Err("native RAW decode is not uploading".into());
        };
        if chunk.len() > UPLOAD_CHUNK_LIMIT || chunk.len() > *expected - bytes.len() {
            sessions.remove(id);
            return Err("RAW chunk exceeds the declared size or the chunk limit".into());
        }
        bytes.extend_from_slice(chunk);
        Ok(())
    }

    /// Takes the complete upload for `open`.
    fn take_upload(&self, id: &str) -> Result<Vec<u8>, String> {
        let mut sessions = self.sessions();
        let session = sessions.get_mut(id).ok_or("unknown native RAW decode")?;
        session.touched = Instant::now();
        match &session.stage {
            Stage::Uploading { bytes, expected } if bytes.len() == *expected => {}
            Stage::Uploading { .. } => return Err("RAW upload is incomplete".into()),
            _ => return Err("native RAW decode was already opened".into()),
        }
        let Stage::Uploading { bytes, .. } = std::mem::replace(&mut session.stage, Stage::Busy) else { unreachable!() };
        Ok(bytes)
    }

    fn set_canceller(&self, id: &str, canceller: Arc<Canceller>) -> bool {
        match self.sessions().get_mut(id) {
            Some(session) => {
                session.canceller = Some(canceller);
                true
            }
            None => false,
        }
    }

    fn finish_stage(&self, id: &str, stage: Stage) -> bool {
        match self.sessions().get_mut(id) {
            Some(session) => {
                session.stage = stage;
                session.touched = Instant::now();
                true
            }
            None => false,
        }
    }

    #[cfg(native_raw)]
    fn take_opened(&self, id: &str) -> Result<(Box<Decoder>, bool), String> {
        let mut sessions = self.sessions();
        let session = sessions.get_mut(id).ok_or("unknown native RAW decode")?;
        session.touched = Instant::now();
        if !matches!(session.stage, Stage::Opened { .. }) {
            return Err("native RAW decode is not open".into());
        }
        let Stage::Opened { decoder, failed } = std::mem::replace(&mut session.stage, Stage::Busy) else { unreachable!() };
        Ok((decoder, failed))
    }

    /// Part `index` of a decoded plane, or None.
    pub fn pixel_part(&self, id: &str, index: usize) -> Option<Vec<u8>> {
        let pixels = {
            let mut sessions = self.sessions();
            let session = sessions.get_mut(id)?;
            session.touched = Instant::now();
            match &session.stage {
                Stage::Decoded { pixels } => pixels.clone(),
                _ => return None,
            }
        };
        let start = index.checked_mul(PIXEL_PART_BYTES)?;
        if start >= pixels.len() {
            return None;
        }
        let end = (start + PIXEL_PART_BYTES).min(pixels.len());
        Some(pixels[start..end].to_vec())
    }

    /// Cancels a running step and drops the session and its memory.
    pub fn release(&self, id: &str) {
        let removed = self.sessions().remove(id);
        if let Some(session) = removed {
            if let Some(canceller) = session.canceller {
                canceller.cancel();
            }
        }
    }

    /// Everything a reloaded page can no longer finish.
    pub fn clear(&self) -> usize {
        let drained: Vec<Session> = self.sessions().drain().map(|(_, session)| session).collect();
        for session in &drained {
            if let Some(canceller) = &session.canceller {
                canceller.cancel();
            }
        }
        drained.len()
    }
}

#[tauri::command]
pub fn native_raw_info() -> NativeRawInfo {
    info()
}

#[tauri::command]
pub fn native_raw_begin(decodes: State<'_, NativeRawDecodes>, expected_bytes: u64) -> Result<String, String> {
    if !info().available {
        return Err("native RAW decoder is not built into this app".into());
    }
    decodes.begin(expected_bytes)
}

#[tauri::command]
pub async fn native_raw_append(request: tauri::ipc::Request<'_>, decodes: State<'_, NativeRawDecodes>) -> Result<(), String> {
    let id = request.headers().get("x-raw-decode-id").and_then(|value| value.to_str().ok()).ok_or("missing decode id")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected binary RAW chunk".into()); };
    decodes.append(id, bytes)
}

fn step_message(code: i32) -> String {
    if code == LIBRAW_SUCCESS { String::new() } else { strerror(code) }
}

/// How an open ends: LibRaw's code, or libraw-wasm when this build refused a
/// file only for lack of libjpeg.
pub fn open_status(code: i32, warnings: u32) -> StepStatus {
    if code == LIBRAW_SUCCESS {
        StepStatus::Ok
    } else if warnings & LIBRAW_WARN_NO_JPEGLIB != 0 {
        StepStatus::NeedsWasm
    } else {
        failure_status(code)
    }
}

#[tauri::command]
pub async fn native_raw_open(
    decodes: State<'_, NativeRawDecodes>,
    id: String,
    half_size: bool,
    output_bps: u8,
) -> Result<OpenReply, String> {
    #[cfg(native_raw)]
    {
        let cancelled = || OpenReply { status: StepStatus::Cancelled, code: LIBRAW_CANCELLED_BY_CALLBACK, message: String::new(), metadata: None };
        let bytes = decodes.take_upload(&id)?;
        // From here every error drops the session: the page decodes with WASM.
        let fail = |err: String| {
            decodes.release(&id);
            err
        };
        let mut decoder = Box::new(Decoder::new(bytes).map_err(fail)?);
        if !decodes.set_canceller(&id, decoder.canceller()) {
            return Ok(cancelled());
        }
        let options = DecodeOptions { half_size, output_bps };
        let (decoder, reply) = tauri::async_runtime::spawn_blocking(move || {
            let code = decoder.open(options);
            let (metadata, warnings) = decoder.metadata();
            let status = open_status(code, warnings);
            (decoder, OpenReply { status, code, message: step_message(code), metadata: Some(metadata) })
        })
        .await
        .map_err(|err| fail(format!("native RAW open task failed: {err}")))?;
        if !matches!(reply.status, StepStatus::Ok | StepStatus::LibrawError) {
            // WASM decodes this file (or the session is gone): nothing more here.
            decodes.release(&id);
            return Ok(if decoder.canceller().is_cancelled() { cancelled() } else { reply });
        }
        let failed = reply.status != StepStatus::Ok;
        if !decodes.finish_stage(&id, Stage::Opened { decoder, failed }) {
            return Ok(cancelled());
        }
        Ok(reply)
    }
    #[cfg(not(native_raw))]
    {
        let _ = (decodes, id, half_size, output_bps);
        Err("native RAW decoder is not built into this app".into())
    }
}

/// Threads for one decode: every core in the foreground, a few for a
/// background lane so it leaves the cores to the photo on screen.
pub fn decode_threads(requested: u32, max_threads: u32) -> u32 {
    if requested == 0 { max_threads.max(1) } else { requested.clamp(1, max_threads.max(1)) }
}

#[tauri::command]
pub async fn native_raw_process(decodes: State<'_, NativeRawDecodes>, id: String, threads: u32) -> Result<ProcessReply, String> {
    #[cfg(native_raw)]
    {
        let reply = |status: StepStatus, code: i32, threads: u32| ProcessReply {
            status,
            code,
            message: step_message(code),
            width: 0,
            height: 0,
            byte_length: 0,
            part_bytes: PIXEL_PART_BYTES as u64,
            parts: 0,
            threads,
            decode_ms: 0,
        };
        let (mut decoder, failed) = decodes.take_opened(&id)?;
        let threads = decode_threads(threads, info().max_threads);
        if failed {
            // libraw-wasm's unpack() refuses to run after a failed open.
            decodes.release(&id);
            return Ok(reply(StepStatus::LibrawError, LIBRAW_OUT_OF_ORDER_CALL, threads));
        }
        let started = Instant::now();
        let result = tauri::async_runtime::spawn_blocking(move || process_to_rgba16(&mut decoder, threads))
            .await
            .map_err(|err| {
                decodes.release(&id);
                format!("native RAW decode task failed: {err}")
            })?;
        let decode_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(decoded) => {
                let byte_length = decoded.rgba16.len() as u64;
                let (width, height) = (decoded.width, decoded.height);
                if !decodes.finish_stage(&id, Stage::Decoded { pixels: Arc::new(decoded.rgba16) }) {
                    return Ok(reply(StepStatus::Cancelled, LIBRAW_CANCELLED_BY_CALLBACK, threads));
                }
                Ok(ProcessReply {
                    width,
                    height,
                    byte_length,
                    parts: byte_length.div_ceil(PIXEL_PART_BYTES as u64) as u32,
                    decode_ms,
                    ..reply(StepStatus::Ok, LIBRAW_SUCCESS, threads)
                })
            }
            Err((status, code)) => {
                decodes.release(&id);
                Ok(ProcessReply { decode_ms, ..reply(status, code, threads) })
            }
        }
    }
    #[cfg(not(native_raw))]
    {
        let _ = (decodes, id, threads);
        Err("native RAW decoder is not built into this app".into())
    }
}

#[tauri::command]
pub fn native_raw_release(decodes: State<'_, NativeRawDecodes>, id: String) {
    decodes.release(&id);
}

/// `rawdecode://localhost/<id>?part=<k>`: one part of a decoded plane. CORS
/// and CORP headers let the page's workers read it cross-origin (also under
/// COEP require-corp).
pub fn pixel_response(decodes: &NativeRawDecodes, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, Response, StatusCode};
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("*")
        .to_string();
    let builder = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.as_str())
            .header(header::VARY, "Origin")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .header(header::CACHE_CONTROL, "no-store")
    };
    if request.method() == Method::OPTIONS {
        return builder(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(Vec::new())
            .unwrap_or_default();
    }
    let not_found = || builder(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_default();
    if request.method() != Method::GET {
        return not_found();
    }
    let uri = request.uri();
    let id = uri.path().trim_start_matches('/');
    let part = uri
        .query()
        .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("part=")))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    match decodes.pixel_part(id, part) {
        Some(bytes) => builder(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .unwrap_or_default(),
        None => not_found(),
    }
}

#[cfg(all(test, native_raw))]
mod parity_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(bytes: &[u8]) -> Vec<u16> {
        bytes.chunks_exact(2).map(|b| u16::from_ne_bytes([b[0], b[1]])).collect()
    }

    #[test]
    fn packs_three_channels_with_opaque_alpha() {
        let rgb: Vec<u8> = [1u16, 2, 3, 65535, 0, 32768].iter().flat_map(|v| v.to_ne_bytes()).collect();
        assert_eq!(samples(&pack_rgba16(2, 1, 3, 16, &rgb).unwrap()), vec![1, 2, 3, 65535, 65535, 0, 32768, 65535]);
    }

    #[test]
    fn packs_grey_and_eight_bit_like_the_page() {
        assert_eq!(samples(&pack_rgba16(2, 1, 1, 8, &[0, 255]).unwrap()), vec![0, 0, 0, 65535, 65535, 65535, 65535, 65535]);
        assert_eq!(samples(&pack_rgba16(1, 1, 4, 8, &[1, 2, 3, 4]).unwrap()), vec![257, 514, 771, 1028]);
    }

    #[test]
    fn refuses_layouts_the_page_rejects() {
        assert!(pack_rgba16(1, 1, 2, 16, &[0; 4]).is_none());
        assert!(pack_rgba16(0, 1, 3, 16, &[]).is_none());
        assert!(pack_rgba16(2, 2, 3, 16, &[0; 10]).is_none());
        assert!(pack_rgba16(1, 1, 3, 12, &[0; 6]).is_none());
    }

    #[test]
    fn only_file_failures_skip_the_wasm_retry() {
        for code in [LIBRAW_FILE_UNSUPPORTED, LIBRAW_DATA_ERROR, LIBRAW_IO_ERROR, LIBRAW_TOO_BIG, LIBRAW_NOT_IMPLEMENTED] {
            assert_eq!(failure_status(code), StepStatus::LibrawError, "{code}");
        }
        for code in [LIBRAW_UNSPECIFIED_ERROR, LIBRAW_UNSUFFICIENT_MEMORY, LIBRAW_OUT_OF_ORDER_CALL, NC_RAW_BAD_LAYOUT, -12345] {
            assert_eq!(failure_status(code), StepStatus::NeedsWasm, "{code}");
        }
        assert_eq!(failure_status(LIBRAW_CANCELLED_BY_CALLBACK), StepStatus::Cancelled);
        assert_eq!(open_status(LIBRAW_SUCCESS, LIBRAW_WARN_NO_JPEGLIB), StepStatus::Ok);
        assert_eq!(open_status(LIBRAW_FILE_UNSUPPORTED, LIBRAW_WARN_NO_JPEGLIB), StepStatus::NeedsWasm, "lossy DNG: WASM has libjpeg");
        assert_eq!(open_status(LIBRAW_FILE_UNSUPPORTED, 0), StepStatus::LibrawError);
        assert_eq!(open_status(LIBRAW_UNSUFFICIENT_MEMORY, 0), StepStatus::NeedsWasm);
    }

    #[test]
    fn sessions_accept_exactly_the_declared_bytes() {
        let decodes = NativeRawDecodes::default();
        assert!(decodes.begin(0).is_err());
        assert!(decodes.begin(MAX_INPUT_BYTES + 1).is_err());
        let id = decodes.begin(10).unwrap();
        decodes.append(&id, &[1; 6]).unwrap();
        assert!(decodes.take_upload(&id).is_err(), "an incomplete upload cannot open");
        decodes.append(&id, &[2; 4]).unwrap();
        assert_eq!(decodes.take_upload(&id).unwrap(), [[1u8; 6].as_slice(), &[2; 4]].concat());
        let other = decodes.begin(4).unwrap();
        assert!(decodes.append(&other, &[0; 5]).is_err(), "more than declared");
        assert!(decodes.append(&other, &[0; 1]).is_err(), "the session is gone after a refused chunk");
        assert!(decodes.append("nope", &[0]).is_err());
    }

    #[test]
    fn too_many_sessions_are_refused() {
        let decodes = NativeRawDecodes::default();
        let ids: Vec<String> = (0..MAX_SESSIONS).map(|_| decodes.begin(1).unwrap()).collect();
        assert!(decodes.begin(1).is_err());
        decodes.release(&ids[0]);
        assert!(decodes.begin(1).is_ok());
    }

    #[test]
    fn session_ids_are_distinct_and_opaque() {
        let a = session_id();
        let b = session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn released_sessions_serve_nothing() {
        let decodes = NativeRawDecodes::default();
        let id = decodes.begin(4).unwrap();
        decodes.finish_stage(&id, Stage::Decoded { pixels: Arc::new(vec![7; PIXEL_PART_BYTES + 3]) });
        assert_eq!(decodes.pixel_part(&id, 0).map(|part| part.len()), Some(PIXEL_PART_BYTES));
        assert_eq!(decodes.pixel_part(&id, 1), Some(vec![7; 3]));
        assert_eq!(decodes.pixel_part(&id, 2), None);
        decodes.release(&id);
        assert_eq!(decodes.pixel_part(&id, 0), None);
        let again = decodes.begin(4).unwrap();
        assert_eq!(decodes.clear(), 1);
        assert!(decodes.append(&again, &[0]).is_err());
    }

    #[test]
    fn pixel_scheme_answers_cors_and_parts() {
        let decodes = NativeRawDecodes::default();
        let id = decodes.begin(4).unwrap();
        decodes.finish_stage(&id, Stage::Decoded { pixels: Arc::new(vec![1, 2, 3, 4]) });
        let request = tauri::http::Request::builder()
            .method("GET")
            .uri(format!("rawdecode://localhost/{id}?part=0"))
            .header("Origin", "tauri://localhost")
            .body(Vec::new())
            .unwrap();
        let response = pixel_response(&decodes, &request);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), &vec![1, 2, 3, 4]);
        assert_eq!(response.headers()["access-control-allow-origin"], "tauri://localhost");
        assert_eq!(response.headers()["cross-origin-resource-policy"], "cross-origin");
        let windows = tauri::http::Request::builder().uri(format!("http://rawdecode.localhost/{id}?part=0")).body(Vec::new()).unwrap();
        assert_eq!(pixel_response(&decodes, &windows).body(), &vec![1, 2, 3, 4], "WebView2 spells the scheme as http://rawdecode.localhost");
        let missing = tauri::http::Request::builder().uri("rawdecode://localhost/unknown?part=0").body(Vec::new()).unwrap();
        assert_eq!(pixel_response(&decodes, &missing).status(), 404);
        let beyond = tauri::http::Request::builder().uri(format!("rawdecode://localhost/{id}?part=1")).body(Vec::new()).unwrap();
        assert_eq!(pixel_response(&decodes, &beyond).status(), 404);
        let post = tauri::http::Request::builder().method("POST").uri(format!("rawdecode://localhost/{id}?part=0")).body(Vec::new()).unwrap();
        assert_eq!(pixel_response(&decodes, &post).status(), 404);
        let preflight = tauri::http::Request::builder().method("OPTIONS").uri(format!("rawdecode://localhost/{id}")).body(Vec::new()).unwrap();
        assert_eq!(pixel_response(&decodes, &preflight).status(), 204);
    }

    #[test]
    fn background_lanes_get_fewer_threads() {
        assert_eq!(decode_threads(0, 8), 8);
        assert_eq!(decode_threads(2, 8), 2);
        assert_eq!(decode_threads(16, 8), 8);
        assert_eq!(decode_threads(0, 0), 1);
    }
}
