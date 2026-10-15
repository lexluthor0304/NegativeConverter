//! Raw deflate for the 16-bit PNG encoder (#301), compiled to WebAssembly.
//!
//! A C ABI over zlib-rs's streaming deflate, for
//! `negative2positive/src/workers/pngDeflateWasm.js`, which gives it pako's
//! `Deflate` interface. Only raw streams: the PNG encoder writes the zlib
//! header and the Adler-32 itself (`png16Bands.js`).
//!
//! The caller owns every buffer: it allocates input and output space with
//! `pd_alloc`, and reads how much a call consumed and produced with
//! `pd_consumed` / `pd_produced`. zlib-rs asserts on a configuration it
//! rejects, and a panic aborts (traps), so `pd_new` checks level and
//! strategy first.

use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::slice;

use zlib_rs::{Deflate, DeflateConfig, DeflateFlush, Status, Strategy};

const ALIGN: usize = 16;
// zlib's maximum window: a raw stream is asked for with negative bits.
const RAW_WINDOW_BITS: i32 = -15;

/// One raw deflate stream and what its last call read and wrote.
pub struct Stream {
    deflate: Deflate,
    consumed: u32,
    produced: u32,
}

/// `len` bytes of memory for the caller, 16-byte aligned; null when `len` is
/// 0 or the memory cannot grow.
#[no_mangle]
pub extern "C" fn pd_alloc(len: usize) -> *mut u8 {
    match Layout::from_size_align(len, ALIGN) {
        Ok(layout) if len > 0 => unsafe { alloc(layout) },
        _ => ptr::null_mut(),
    }
}

/// Frees what `pd_alloc(len)` returned.
///
/// # Safety
/// `ptr` must come from `pd_alloc` with the same `len`, and be freed once.
#[no_mangle]
pub unsafe extern "C" fn pd_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(len, ALIGN));
    }
}

/// A new raw stream at zlib's `level` (-1 to 9) and `strategy` (0 default,
/// 1 filtered, 2 Huffman only, 3 RLE, 4 fixed), with zlib's 32 KiB window and
/// memory level 8; null for a level or strategy zlib would reject.
#[no_mangle]
pub extern "C" fn pd_new(level: i32, strategy: i32) -> *mut Stream {
    if !(-1..=9).contains(&level) {
        return ptr::null_mut();
    }
    let Ok(strategy) = Strategy::try_from(strategy) else {
        return ptr::null_mut();
    };
    let config = DeflateConfig {
        level,
        window_bits: RAW_WINDOW_BITS,
        strategy,
        ..DeflateConfig::default()
    };
    Box::into_raw(Box::new(Stream {
        deflate: Deflate::new_with_config(config),
        consumed: 0,
        produced: 0,
    }))
}

/// Deflates `in_len` bytes at `input` into at most `out_cap` bytes at
/// `output` with zlib's `flush` (0 none, 1 partial, 2 sync, 3 full, 4
/// finish, 5 block).
///
/// Returns 0 when it made progress, 1 at the end of the stream (after a
/// finish), 2 when no progress was possible (zlib's `Z_BUF_ERROR`, not an
/// error), or zlib's negative error code. As in zlib, a call that fills the
/// output has to be repeated with the same flush and more output space.
///
/// # Safety
/// `stream` must come from `pd_new` and not be ended; `input` must be
/// readable for `in_len` bytes and `output` writable for `out_cap` bytes
/// (either may be null when its length is 0).
#[no_mangle]
pub unsafe extern "C" fn pd_deflate(
    stream: *mut Stream,
    input: *const u8,
    in_len: usize,
    output: *mut u8,
    out_cap: usize,
    flush: i32,
) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return -2;
    };
    stream.consumed = 0;
    stream.produced = 0;
    let Ok(flush) = DeflateFlush::try_from(flush) else {
        return -2;
    };
    let input: &[u8] = if in_len == 0 || input.is_null() {
        &[]
    } else {
        slice::from_raw_parts(input, in_len)
    };
    let output: &mut [u8] = if out_cap == 0 || output.is_null() {
        &mut []
    } else {
        slice::from_raw_parts_mut(output, out_cap)
    };
    let (before_in, before_out) = (stream.deflate.total_in(), stream.deflate.total_out());
    let result = stream.deflate.compress(input, output, flush);
    stream.consumed = (stream.deflate.total_in() - before_in) as u32;
    stream.produced = (stream.deflate.total_out() - before_out) as u32;
    match result {
        Ok(Status::Ok) => 0,
        Ok(Status::StreamEnd) => 1,
        Ok(Status::BufError) => 2,
        Err(err) => err as i32,
    }
}

/// Input bytes the last `pd_deflate` call read.
///
/// # Safety
/// `stream` must come from `pd_new` and not be ended.
#[no_mangle]
pub unsafe extern "C" fn pd_consumed(stream: *const Stream) -> u32 {
    stream.as_ref().map_or(0, |s| s.consumed)
}

/// Output bytes the last `pd_deflate` call wrote.
///
/// # Safety
/// `stream` must come from `pd_new` and not be ended.
#[no_mangle]
pub unsafe extern "C" fn pd_produced(stream: *const Stream) -> u32 {
    stream.as_ref().map_or(0, |s| s.produced)
}

/// Frees a stream, finished or not.
///
/// # Safety
/// `stream` must come from `pd_new` and be ended once.
#[no_mangle]
pub unsafe extern "C" fn pd_end(stream: *mut Stream) {
    if !stream.is_null() {
        drop(Box::from_raw(stream));
    }
}
