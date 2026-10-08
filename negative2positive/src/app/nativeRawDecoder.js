// Native LibRaw on the desktop app (#264 part C).
//
// The desktop shell (src-tauri/src/native_raw.rs) links the same LibRaw
// release libraw-wasm runs, built with the same settings, and decodes on
// every core with OpenMP. `createRawDecoder` hands rawFileLoader.js an object
// with libraw-wasm's interface (open / metadata / imageData / dispose) and
// its exact semantics, so the loader's timeouts, aborts and fallbacks work
// unchanged:
//  - LibRaw rejecting the file itself (unsupported, corrupt or truncated
//    data: the shell's `librawError`) resolves like libraw-wasm, whose worker
//    swallows the C++ exception: `open()` and `imageData()` resolve
//    `undefined`, and the loader takes its embedded-preview path (the
//    HE-compressed NEFs) without a second LibRaw attempt, because WASM runs
//    the same code on the same bytes and fails the same way;
//  - anything else (an IPC or transfer failure, a step timeout, memory, a
//    file this build cannot decode like libraw-wasm does: lossy DNG needs its
//    libjpeg, decode settings other than the loader's) decodes the same bytes
//    with libraw-wasm instead;
//  - `dispose()` cancels the native decode (LibRaw stops at its next check)
//    and rejects what is pending with "LibRaw disposed".
// `imageData()` resolves the packed RGBA16 plane (4 colours, alpha 65535,
// exactly what the post-decode pass packs from LibRaw's RGB16), which
// packRGBToImage16 only wraps.
//
// The native decode runs only where it was verified bit-identical to the
// libraw-wasm release the page uses (NATIVE_RAW_PARITY), unless the support
// override `localStorage.nc_native_raw` is 'on' ('off' disables it).

import { openNativePlaneReader } from './nativeRawTransfer.js';

// Must equal UPLOAD_CHUNK_LIMIT in src-tauri/src/native_raw.rs (the test
// reads it).
export const NATIVE_RAW_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

// The libraw-wasm release the page decodes with.
// scripts/check-pinned-versions.mjs keeps it equal to package.json.
export const LIBRAW_WASM_VERSION = '1.6.0';

// Where native decodes are verified identical to a libraw-wasm release: the
// RGB16 SHA-256 of every gate fixture at 1, 4 and 8 threads (the src-tauri
// native_raw parity tests) equals the WASM gate's
// (src-tauri/native/wasm-parity-hashes.json, docs/native-raw-decode.md).
// macOS arm64, and x86_64 (run under Rosetta 2), match the deterministic
// libraw-wasm rebuild of #264 part B, which is not released yet: until
// package.json pins that release and it is entered here, desktops keep
// decoding with WASM.
export const NATIVE_RAW_PARITY = Object.freeze({
  librawWasm: null,
  platforms: Object.freeze(['macos-aarch64', 'macos-x86_64']),
});

// A background lane leaves the cores to the photo on screen.
export const NATIVE_BACKGROUND_THREADS = 2;

// The libraw-wasm settings the shell reproduces: rawFileLoader.js's fixed set
// (nc_libraw.cpp sets the same LibRaw parameters), plus halfSize and
// outputBps. libraw-wasm applies only the keys it is given, over LibRaw's
// defaults, so any other key or value decodes with WASM.
const NATIVE_FIXED_SETTINGS = Object.freeze({
  noInterpolation: false,
  useAutoWb: true,
  useCameraWb: true,
  useCameraMatrix: 3,
  outputColor: 1,
});

/**
 * The shell's `{ halfSize, outputBps }` for libraw-wasm `settings`, or null
 * when the native decode would not reproduce them.
 */
export function nativeDecodeOptions(settings) {
  if (!settings || typeof settings !== 'object') return null;
  for (const [key, value] of Object.entries(NATIVE_FIXED_SETTINGS)) {
    if (settings[key] !== value) return null;
  }
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(NATIVE_FIXED_SETTINGS, key) && key !== 'halfSize' && key !== 'outputBps') return null;
  }
  const halfSize = settings.halfSize ?? false;
  if (typeof halfSize !== 'boolean' || (settings.outputBps !== 8 && settings.outputBps !== 16)) return null;
  return { halfSize, outputBps: settings.outputBps };
}

const OVERRIDE_KEY = 'nc_native_raw';

/**
 * Whether this page decodes natively, from the shell's `native_raw_info`.
 * @returns {{ enabled: boolean, reason: string }}
 */
export function decideNativeRawDecode({ info, override = null, librawWasm = LIBRAW_WASM_VERSION, parity = NATIVE_RAW_PARITY }) {
  if (!info?.available) return { enabled: false, reason: 'unavailable' };
  if (override === 'off') return { enabled: false, reason: 'override-off' };
  if (override === 'on') return { enabled: true, reason: 'override-on' };
  if (!parity.librawWasm || parity.librawWasm !== librawWasm) return { enabled: false, reason: 'wasm-build-unverified' };
  if (!parity.platforms.includes(info.platform)) return { enabled: false, reason: 'platform-unverified' };
  return { enabled: true, reason: 'parity' };
}

function tauriCore() {
  const core = globalThis.window?.__TAURI__?.core;
  return core && typeof core.invoke === 'function' ? core : null;
}

function readOverride() {
  try {
    const value = globalThis.localStorage?.getItem(OVERRIDE_KEY);
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}

let probed = null;

/** The page's decision, asked once (`native_raw_info`). */
export function probeNativeRawDecoder({ core = tauriCore(), override = readOverride() } = {}) {
  if (!core) return Promise.resolve({ enabled: false, reason: 'not-desktop', info: null });
  if (!probed) {
    probed = Promise.resolve()
      .then(() => core.invoke('native_raw_info'))
      .then((info) => {
        const decision = decideNativeRawDecode({ info, override });
        console.info('[RAW] native decoder:', decision.reason, {
          platform: info?.platform, libraw: info?.libraw, openmp: info?.openmp, threads: info?.maxThreads
        });
        return { ...decision, info };
      }, (err) => {
        console.warn('[RAW] native decoder probe failed:', err?.message || err);
        return { enabled: false, reason: 'probe-failed', info: null };
      });
  }
  return probed;
}

export function resetNativeRawProbe() {
  probed = null;
}

function disposedError() {
  return new Error('LibRaw disposed');
}

class NativeStepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativeStepError';
    this.code = 'NATIVE_RAW_STEP';
  }
}

// `timers` collects the pending timeouts so dispose() can clear them.
function withStepTimeout(promise, ms, what, timers) {
  let timer;
  const clear = () => {
    clearTimeout(timer);
    timers?.delete(timer);
  };
  return Promise.race([
    promise.finally(clear),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        timers?.delete(timer);
        reject(new NativeStepError(`native ${what} timed out after ${ms} ms`));
      }, ms);
      timers?.add(timer);
    }),
  ]);
}

// libraw-wasm's metadata() post-processing of the wrapper's object.
const THUMB_FORMATS = ['unknown', 'jpeg', 'bitmap', 'bitmap16', 'layer', 'rollei', 'h265'];
export function decorateNativeMetadata(metadata, fullOutput) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const out = { ...metadata };
  if (!fullOutput) delete out.lens;
  if (Object.prototype.hasOwnProperty.call(out, 'thumb_format')) out.thumb_format = THUMB_FORMATS[out.thumb_format] || 'unknown';
  if (Object.prototype.hasOwnProperty.call(out, 'desc')) out.desc = String(out.desc).trim();
  if (Object.prototype.hasOwnProperty.call(out, 'timestamp')) out.timestamp = new Date(out.timestamp * 1e3);
  return out;
}

/**
 * A libraw-wasm–compatible decoder backed by the desktop shell.
 * `createWasm()` builds the libraw-wasm instance a fallback decodes with.
 */
export function createNativeLibRaw({
  core,
  createWasm,
  threads = 0,
  openTimeoutMs = 10_000,
  processTimeoutMs = 20_000,
  transferTimeoutMs = 20_000,
  openPlaneReader = openNativePlaneReader,
  sharedPlane = false,
  beforeDecode = null,
}) {
  let disposed = false;
  // Set once the native session is given up (a fallback or dispose): a
  // native step still running in the background must not start new ones.
  let abandoned = false;
  let wasm = null;
  let id = null;
  let input = null;
  let settings = null;
  let options = null; // nativeDecodeOptions(settings)
  let opened = null; // 'ok' | 'librawError'
  let metadata = null;
  const pending = new Set();
  const timers = new Set();
  const readers = new Set();
  const transfer = typeof AbortController === 'function' ? new AbortController() : null;
  let admissionError = null;
  const admit = async () => {
    try { if (beforeDecode) await beforeDecode(); }
    catch (error) { admissionError = error; throw error; }
    assertLive();
  };

  const invoke = (command, args, options) => core.invoke(command, args, options);

  // A pending call rejects with "LibRaw disposed" at once on dispose().
  function track(promise) {
    return new Promise((resolve, reject) => {
      const entry = { reject };
      pending.add(entry);
      promise.then(
        (value) => { pending.delete(entry); resolve(value); },
        (err) => { pending.delete(entry); reject(err); }
      );
    });
  }

  function assertLive() {
    if (disposed) throw disposedError();
  }

  function releaseSession(session) {
    if (session) Promise.resolve(invoke('native_raw_release', { id: session })).catch(() => {});
  }

  function release() {
    const session = id;
    id = null;
    releaseSession(session);
  }

  function assertNative() {
    if (abandoned) throw new NativeStepError('native decode abandoned');
  }

  async function nativeOpen() {
    const session = await invoke('native_raw_begin', { expectedBytes: input.byteLength });
    if (abandoned) {
      releaseSession(session);
      assertNative();
    }
    id = session;
    const total = input.byteLength;
    for (let offset = 0; offset < total; offset += NATIVE_RAW_UPLOAD_CHUNK_BYTES) {
      assertNative();
      const chunk = input.subarray(offset, Math.min(total, offset + NATIVE_RAW_UPLOAD_CHUNK_BYTES));
      await invoke('native_raw_append', chunk, { headers: { 'x-raw-decode-id': session } });
    }
    assertNative();
    return invoke('native_raw_open', { id: session, halfSize: options.halfSize, outputBps: options.outputBps });
  }

  // From here on every call is libraw-wasm's own.
  async function toWasm(step, reason) {
    abandoned = true;
    release();
    console.warn(`[RAW] native ${step} failed, decoding with WASM:`, reason?.message || reason?.status || reason);
    assertLive();
    wasm = createWasm();
    if (step !== 'open' && beforeDecode) await admit();
    await track(wasm.open(input, settings));
    assertLive();
    if (step === 'open') return undefined;
    if (beforeDecode) await admit();
    return track(wasm.imageData());
  }

  async function nativeImage() {
    const session = id;
    // The transfer worker loads while LibRaw decodes.
    const reader = openPlaneReader();
    readers.add(reader);
    let reply;
    try {
      if (beforeDecode) await admit();
      assertNative();
      reply = await withStepTimeout(invoke('native_raw_process', { id: session, threads }), processTimeoutMs, 'decode', timers);
      assertNative();
    } catch (err) {
      reader.close();
      throw err;
    }
    if (reply?.status !== 'ok') {
      reader.close();
      return reply;
    }
    const urls = Array.from({ length: reply.parts }, (_, part) => `${core.convertFileSrc(session, 'rawdecode')}?part=${part}`);
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const buffer = await withStepTimeout(
      reader.read(urls, reply.byteLength, { signal: transfer?.signal || null, shared: sharedPlane }),
      transferTimeoutMs,
      'transfer',
      timers
    );
    release();
    const transferMs = typeof performance !== 'undefined' ? Math.round(performance.now() - started) : 0;
    console.info('[RAW] native decode', { width: reply.width, height: reply.height, threads: reply.threads, decodeMs: reply.decodeMs, transferMs });
    return {
      status: 'ok',
      result: {
        width: reply.width,
        height: reply.height,
        colors: 4,
        bits: 16,
        dataSize: reply.byteLength,
        data: new Uint16Array(buffer),
      },
    };
  }

  return {
    async open(bytes, openSettings) {
      assertLive();
      input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      settings = openSettings || {};
      options = nativeDecodeOptions(settings);
      if (!options) return toWasm('open', 'settings the native decoder does not reproduce');
      let reply;
      try {
        reply = await track(withStepTimeout(nativeOpen(), openTimeoutMs, 'open', timers));
      } catch (err) {
        assertLive();
        return toWasm('open', err);
      }
      if (reply?.status === 'ok' || reply?.status === 'librawError') {
        opened = reply.status;
        metadata = reply.metadata || null;
        return undefined;
      }
      return toWasm('open', reply);
    },

    async metadata(fullOutput) {
      assertLive();
      if (wasm) return wasm.metadata(fullOutput);
      return decorateNativeMetadata(metadata, Boolean(fullOutput));
    },

    async imageData() {
      assertLive();
      if (wasm) return track(wasm.imageData());
      if (opened !== 'ok') {
        // libraw-wasm cannot unpack after a failed open either.
        release();
        return undefined;
      }
      let outcome;
      try {
        outcome = await track(nativeImage());
      } catch (err) {
        assertLive();
        if (err === admissionError) throw err;
        return toWasm('decode', err);
      }
      if (outcome?.status === 'ok') return outcome.result;
      if (outcome?.status === 'librawError') {
        release();
        console.warn(`[RAW] LibRaw could not decode this file (native ${outcome.code}: ${outcome.message})`);
        return undefined;
      }
      return toWasm('decode', outcome);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      abandoned = true;
      release();
      try { transfer?.abort(); } catch {}
      try { wasm?.dispose?.(); } catch {}
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const reader of readers) reader.close();
      readers.clear();
      for (const entry of pending) entry.reject(disposedError());
      pending.clear();
    },

    get native() { return !wasm; },
  };
}

/**
 * The decoder rawFileLoader.js opens: native on a verified desktop, else
 * `createWasm()` (libraw-wasm's `new LibRaw()`). The native step timeouts
 * leave the loader's own budget (`openTimeoutMs`, `decodeTimeoutMs`) room
 * for the WASM fallback. `sharedPlane` asks for the plane in shared memory
 * where the page is cross-origin isolated (#264 Part A); it stays off until
 * the post-decode pass keeps a shared 4-channel plane instead of copying it
 * (rawResultToRgb16).
 */
export async function createRawDecoder(createWasm, {
  priority = 'user',
  openTimeoutMs = 30_000,
  decodeTimeoutMs = 90_000,
  sharedPlane = false,
  core = tauriCore(),
  probe = probeNativeRawDecoder,
  beforeDecode = null,
} = {}) {
  const gate = core ? await probe({ core }) : null;
  if (!gate?.enabled) return createWasm();
  return createNativeLibRaw({
    core,
    createWasm,
    threads: priority === 'background' ? NATIVE_BACKGROUND_THREADS : 0,
    openTimeoutMs: Math.min(10_000, Math.max(1_000, Math.floor(openTimeoutMs / 2))),
    processTimeoutMs: Math.min(20_000, Math.max(2_000, Math.floor(decodeTimeoutMs / 3))),
    transferTimeoutMs: Math.min(20_000, Math.max(2_000, Math.floor(decodeTimeoutMs / 3))),
    sharedPlane,
    beforeDecode,
  });
}
