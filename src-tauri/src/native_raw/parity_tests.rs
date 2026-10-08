//! Real-file checks of the native decoder (#264): thread-count independence,
//! the packed plane against LibRaw's own dcraw_make_mem_image() for every
//! orientation and bit depth, the HE-compressed NEF failure mode,
//! cancellation latency, and equality with the WASM gate's hashes.
//!
//! The camera files are not in the repository. By default the tests use the
//! fixtures symlinked at the worktree root when present; otherwise, or with
//!   NATIVE_RAW_FILES=/abs/a.NEF:/abs/b.dng
//! the listed files. NATIVE_RAW_HE_FILES lists HE-compressed NEFs the same
//! way. The WASM gate's hashes are in native/wasm-parity-hashes.json
//! (NATIVE_RAW_EXPECTED=/abs/other.json replaces it): a decoded file listed
//! there under its name and size must match them. Without files each test
//! prints why it skipped.
use super::*;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

// Fixtures of at most ~24 MP by default; list larger files explicitly.
const DEFAULT_FILES: &[&str] = &["_DSC3111.NEF", "_DSC5290.dng"];
const DEFAULT_HE_FILES: &[&str] = &["DSC_8800.NEF", "DSC_8798.NEF", "DSC_8806.NEF", "DSC_4127.NEF"];

fn listed(var: &str, defaults: &[&str]) -> Vec<PathBuf> {
    if let Ok(list) = std::env::var(var) {
        return std::env::split_paths(&list).filter(|path| path.is_file()).collect();
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    defaults.iter().map(|name| root.join(name)).filter(|path| path.is_file()).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// dcraw_make_mem_image()'s result, freed on drop: what libraw-wasm's
/// imageData() returns.
struct Reference {
    image: ffi::NcRawImage,
}

impl Reference {
    fn of(decoder: &mut Decoder) -> Reference {
        // SAFETY: the shim fills the struct or returns an error code.
        let mut image: ffi::NcRawImage = unsafe { std::mem::zeroed() };
        let code = unsafe { ffi::nc_raw_make_image(decoder.raw, &mut image) };
        assert_eq!(code, LIBRAW_SUCCESS, "dcraw_make_mem_image: {}", strerror(code));
        Reference { image }
    }

    fn data(&self) -> &[u8] {
        // SAFETY: LibRaw's buffer of `size` bytes lives until nc_raw_free_image.
        unsafe { std::slice::from_raw_parts(self.image.data, self.image.size) }
    }

    fn packed(&self) -> Vec<u8> {
        let image = &self.image;
        pack_rgba16(image.width as usize, image.height as usize, image.colors as usize, image.bits as usize, self.data()).expect("packs")
    }
}

impl Drop for Reference {
    fn drop(&mut self) {
        // SAFETY: from nc_raw_make_image, freed once.
        unsafe { ffi::nc_raw_free_image(&mut self.image) };
    }
}

fn open(bytes: &[u8], options: DecodeOptions) -> Decoder {
    let mut decoder = Decoder::new(bytes.to_vec()).expect("LibRaw allocates");
    assert_eq!(decoder.open(options), 0, "open_buffer");
    decoder
}

/// The decode path's plane (nc_raw_pack_rgba16) for the current flip.
fn direct_plane(decoder: &mut Decoder, threads: u32) -> (usize, usize, Vec<u8>) {
    let (width, height) = decoder.plane_size().expect("a layout the page packs");
    let mut plane = vec![0xA5u8; width * height * 8];
    assert_eq!(decoder.pack_rgba16(&mut plane, threads), 0, "nc_raw_pack_rgba16");
    (width, height, plane)
}

struct Run {
    width: usize,
    height: usize,
    rgb16: String,
    rgba16: String,
    ms: u128,
}

/// A decode as the page gets it: the RGB16 hash of LibRaw's own image (the
/// WASM gate's hash) and the packed plane, which must be exactly the page's
/// packing of that image.
fn decode(bytes: &[u8], half_size: bool, threads: u32) -> Run {
    let mut decoder = open(bytes, DecodeOptions { half_size, output_bps: 16 });
    let started = Instant::now();
    assert_eq!(decoder.process(threads), 0, "unpack + dcraw_process");
    let (width, height, plane) = direct_plane(&mut decoder, threads);
    let ms = started.elapsed().as_millis();
    let reference = Reference::of(&mut decoder);
    assert_eq!((reference.image.width as usize, reference.image.height as usize), (width, height));
    assert!(plane == reference.packed(), "the packed plane differs from packRGBToImage16(dcraw_make_mem_image)");
    Run { width, height, rgb16: hex(&Sha256::digest(reference.data())), rgba16: hex(&Sha256::digest(&plane)), ms }
}

fn expected_hashes() -> serde_json::Value {
    let path = std::env::var("NATIVE_RAW_EXPECTED")
        .map(PathBuf::from)
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("native/wasm-parity-hashes.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).expect("the expected hashes are JSON")
}

#[test]
fn decodes_identically_at_1_4_and_8_threads() {
    let files = listed("NATIVE_RAW_FILES", DEFAULT_FILES);
    if files.is_empty() {
        eprintln!("skipped: no RAW fixtures (set NATIVE_RAW_FILES)");
        return;
    }
    let info = info();
    eprintln!("native LibRaw {} openmp={} cores={} on {}", info.libraw, info.openmp, info.max_threads, info.platform);
    let expected = expected_hashes();
    let mut compared = 0;
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let bytes = std::fs::read(&file).expect("fixture reads");
        let want = expected["files"].get(&name).filter(|entry| entry["bytes"].as_u64() == Some(bytes.len() as u64));
        for half_size in [false, true] {
            let runs: Vec<(u32, Run)> = [1u32, 4, 8].into_iter().map(|threads| (threads, decode(&bytes, half_size, threads))).collect();
            let first = &runs[0].1;
            for (threads, run) in &runs {
                eprintln!("{name} half={half_size} threads={threads}: {}x{} rgb16 {} rgba16 {} {} ms", run.width, run.height, run.rgb16, run.rgba16, run.ms);
                assert_eq!((run.width, run.height), (first.width, first.height), "{name}: size at {threads} threads");
                assert_eq!(run.rgb16, first.rgb16, "{name} half={half_size}: RGB16 differs at {threads} threads");
                assert_eq!(run.rgba16, first.rgba16, "{name} half={half_size}: RGBA16 differs at {threads} threads");
            }
            let key = if half_size { "halfRgb16" } else { "rgb16" };
            if let Some(hash) = want.and_then(|entry| entry[key].as_str()) {
                assert_eq!(first.rgb16, hash, "{name}: native {key} differs from the WASM gate's hash");
                eprintln!("{name} {key}: equals the WASM gate's hash");
                compared += 1;
            }
        }
    }
    eprintln!("{compared} decode(s) compared with the WASM gate");
}

/// Every orientation (EXIF flip 0-7) and both output depths, full and half
/// size: the plane the decode path writes equals packRGBToImage16 over
/// dcraw_make_mem_image() for the same LibRaw state.
#[test]
fn packed_plane_equals_the_pages_packing_for_every_flip_and_depth() {
    let Some(file) = listed("NATIVE_RAW_FILES", DEFAULT_FILES).into_iter().next() else {
        eprintln!("skipped: no RAW fixtures (set NATIVE_RAW_FILES)");
        return;
    };
    let bytes = std::fs::read(&file).expect("fixture reads");
    for (output_bps, half_size) in [(16u8, true), (8, true), (16, false)] {
        let mut decoder = open(&bytes, DecodeOptions { half_size, output_bps });
        assert_eq!(decoder.process(4), 0);
        for flip in 0..8 {
            // SAFETY: the test hook sets imgdata.sizes.flip.
            unsafe { ffi::nc_raw_set_flip(decoder.raw, flip) };
            let (width, height, plane) = direct_plane(&mut decoder, 4);
            let reference = Reference::of(&mut decoder);
            assert_eq!(reference.image.bits as u8, output_bps);
            assert_eq!((reference.image.width as usize, reference.image.height as usize), (width, height), "flip {flip}");
            assert!(plane == reference.packed(), "{file:?} flip {flip} {output_bps}-bit half={half_size}: plane differs");
            eprintln!("{:?} flip {flip} {output_bps}-bit half={half_size} {width}x{height}: identical", file.file_name().unwrap());
        }
    }
}

#[test]
fn he_compressed_nefs_fail_in_unpack_like_the_wasm_decoder() {
    let files = listed("NATIVE_RAW_HE_FILES", DEFAULT_HE_FILES);
    if files.is_empty() {
        eprintln!("skipped: no HE-compressed NEFs (set NATIVE_RAW_HE_FILES)");
        return;
    }
    for file in files {
        let bytes = std::fs::read(&file).expect("fixture reads");
        let mut decoder = Decoder::new(bytes).expect("LibRaw allocates");
        let code = decoder.open(DecodeOptions { half_size: false, output_bps: 16 });
        let (metadata, warnings) = decoder.metadata();
        assert_eq!(open_status(code, warnings), StepStatus::Ok, "{file:?}: open_buffer succeeds");
        assert!(metadata.width > 0 && !metadata.camera_model.is_empty(), "{file:?}: identified");
        // libraw-wasm throws from imageData() here and resolves undefined;
        // the page then takes the embedded-JPEG fallback without a retry.
        match process_to_rgba16(&mut decoder, 8) {
            Err((status, code)) => {
                assert_eq!((status, code), (StepStatus::LibrawError, LIBRAW_FILE_UNSUPPORTED), "{file:?}: {}", strerror(code));
                eprintln!("{:?}: {} {} -> {status:?} {code} ({})", file.file_name().unwrap(), metadata.camera_make, metadata.camera_model, strerror(code));
            }
            Ok(_) => panic!("{file:?}: an HE-compressed NEF decoded"),
        }
    }
}

/// The one-minute load average, where the OS reports it.
fn load_average() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let mut loads = [0f64; 3];
        // SAFETY: getloadavg writes at most the requested number of doubles.
        let count = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
        if count >= 1 {
            return Some(loads[0]);
        }
    }
    None
}

/// Cancels whole decodes (process_to_rgba16, 8 threads) at points spread
/// over their run and reports how long each took to return. Asserted at
/// 200 ms unless the machine runs more threads than it has cores (OpenMP
/// teams wait for every thread at the end of a region, so the latency then
/// says nothing about the decoder).
#[test]
fn release_stops_a_running_decode_within_200_ms() {
    let files = listed("NATIVE_RAW_FILES", DEFAULT_FILES);
    if files.is_empty() {
        eprintln!("skipped: no RAW fixtures (set NATIVE_RAW_FILES)");
        return;
    }
    let cores = info().max_threads as f64;
    for file in files {
        let bytes = std::fs::read(&file).expect("fixture reads");
        let started = Instant::now();
        let mut decoder = open(&bytes, DecodeOptions { half_size: false, output_bps: 16 });
        process_to_rgba16(&mut decoder, 8).map_err(|(status, code)| format!("{status:?} {code}")).expect("decodes");
        let full = started.elapsed();
        let mut worst = Duration::ZERO;
        for step in 1..=12u32 {
            let delay = full * step / 13;
            let mut decoder = open(&bytes, DecodeOptions { half_size: false, output_bps: 16 });
            let canceller = decoder.canceller();
            let worker = std::thread::spawn(move || {
                let result = process_to_rgba16(&mut decoder, 8).map(|_| ());
                (result, Instant::now())
            });
            std::thread::sleep(delay);
            let cancelled_at = Instant::now();
            canceller.cancel();
            let (result, finished_at) = worker.join().expect("decode thread");
            let latency = finished_at.saturating_duration_since(cancelled_at);
            worst = worst.max(latency);
            if let Err((status, code)) = result {
                assert_eq!((status, code), (StepStatus::Cancelled, LIBRAW_CANCELLED_BY_CALLBACK));
            }
            match load_average() {
                Some(load) if load > cores => eprintln!(
                    "{:?} cancel at {} of ~{} ms: returned {} ms later (load average {load:.1} > {cores} cores: not asserted)",
                    file.file_name().unwrap(), delay.as_millis(), full.as_millis(), latency.as_millis()
                ),
                _ => {
                    eprintln!("{:?} cancel at {} of ~{} ms: returned {} ms later", file.file_name().unwrap(), delay.as_millis(), full.as_millis(), latency.as_millis());
                    assert!(latency <= Duration::from_millis(200), "cancel took {} ms", latency.as_millis());
                }
            }
        }
        eprintln!("{:?}: worst cancel latency {} ms over 12 points of a {} ms decode", file.file_name().unwrap(), worst.as_millis(), full.as_millis());
    }
}

#[test]
fn metadata_matches_libraw_wasm_for_the_loader() {
    let files = listed("NATIVE_RAW_FILES", DEFAULT_FILES).into_iter().chain(listed("NATIVE_RAW_HE_FILES", DEFAULT_HE_FILES));
    let expected = expected_hashes();
    let mut compared = 0;
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let bytes = std::fs::read(&file).expect("fixture reads");
        let Some(want) = expected["files"]
            .get(&name)
            .filter(|entry| entry["bytes"].as_u64() == Some(bytes.len() as u64))
            .and_then(|entry| entry.get("metadata"))
        else {
            continue;
        };
        let mut decoder = Decoder::new(bytes).expect("LibRaw allocates");
        assert_eq!(decoder.open(DecodeOptions { half_size: false, output_bps: 16 }), 0);
        let (metadata, _) = decoder.metadata();
        let got = serde_json::to_value(&metadata).expect("serializes");
        // Every field libraw-wasm's metadata(true) reported for this file at
        // the paths the native object has, with the same value (numbers
        // compared as the JavaScript numbers they become).
        fn check(path: &str, want: &serde_json::Value, got: &serde_json::Value) {
            match want {
                serde_json::Value::Object(map) => {
                    for (key, value) in map {
                        check(&format!("{path}.{key}"), value, &got[key.as_str()]);
                    }
                }
                serde_json::Value::Array(items) => {
                    for (index, value) in items.iter().enumerate() {
                        check(&format!("{path}[{index}]"), value, &got[index]);
                    }
                }
                serde_json::Value::Number(number) => {
                    assert_eq!(got.as_f64(), number.as_f64(), "{path}");
                }
                _ => assert_eq!(got, want, "{path}"),
            }
        }
        check(&name, want, &got);
        // The page sees the keys in libraw-wasm's order (Tauri serializes the
        // struct as declared).
        let text = serde_json::to_string(&metadata).expect("serializes");
        let order = ["width", "height", "raw_width", "raw_height", "top_margin", "left_margin", "flip", "camera_make",
            "camera_model", "iso_speed", "shutter", "aperture", "focal_len", "timestamp", "shot_order", "desc", "artist",
            "gps_data", "thumb_width", "thumb_height", "thumb_format", "lens"];
        let positions: Vec<usize> = order.iter().map(|key| text.find(&format!("\"{key}\":")).expect(key)).collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{name}: key order {text}");
        eprintln!("{name}: metadata equals libraw-wasm's");
        compared += 1;
    }
    if compared == 0 {
        eprintln!("skipped: no fixture with recorded libraw-wasm metadata");
    }
}
