/**
 * The 16-bit PNG encoder's deflate (#301): zlib-rs compiled to WebAssembly
 * (wasm/png-deflate), behind pako's streaming `Deflate` interface, so
 * png16Bands.js runs it unchanged.
 *
 * zlib-rs is a port of zlib-ng. On the encoder's real band streams it
 * deflates about 1.8× as fast as pako in V8 and 1.5× in JavaScriptCore, with
 * the same compression. The bytes differ from pako's (another
 * implementation); decoded samples do not. The scalar and the SIMD module
 * write identical bytes (pngDeflateWasm.test.mjs), so a file depends only on
 * the frame and on whether WebAssembly could be instantiated at all.
 *
 * Every PNG16 path takes its deflater from loadPng16Zlib(): the export
 * worker's band and whole-frame encodes, the main-thread fallback and the
 * multi-shot merge. pako stays as the fallback where the module cannot be
 * instantiated, and for the rest of the realm after a module failed while
 * encoding (runWithPng16Fallback encodes that frame again with pako).
 */
import * as pako from 'pako';
import { wasmSimdSupported } from '../app/opencvRuntime.js';

export const PNG_DEFLATE_MODULE_URLS = Object.freeze({
  scalar: new URL('./png-deflate.wasm', import.meta.url),
  simd: new URL('./png-deflate-simd.wasm', import.meta.url)
});

const Z_NO_FLUSH = 0;
const Z_FINISH = 4;
const STATUS_OK = 0;
const STATUS_STREAM_END = 1;
const STATUS_NO_PROGRESS = 2;
const MESSAGES = { [-2]: 'stream error', [-3]: 'data error', [-4]: 'insufficient memory', [-5]: 'buffer error' };
const MIN_OUTPUT_BYTES = 64 << 10;
// The encoder pushes up to PNG16_SCRATCH_BYTES (4 MiB) at a time.
const MIN_BUFFER_BYTES = 1 << 20;
const EXPORTS = ['memory', 'pd_alloc', 'pd_free', 'pd_new', 'pd_deflate', 'pd_consumed', 'pd_produced', 'pd_end'];

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('png-deflate takes bytes (a typed array or an ArrayBuffer)');
}

/**
 * pako's `Deflate` over one instance of the module: `{ Deflate, variant,
 * memoryBytes, failed }`.
 * Raw streams only (`raw: true`). One input and one output buffer serve every
 * stream of the instance: a push copies its input in and leaves nothing in
 * either buffer when it returns, so streams may interleave.
 */
export function createWasmZlib(exports, variant = 'wasm') {
  for (const name of EXPORTS) {
    if (!exports || !(name in exports)) throw new TypeError(`png-deflate module lacks ${name}`);
  }
  const ex = exports;
  const buffers = { inPtr: 0, inCap: 0, outPtr: 0, outCap: 0 };
  // Set once the module trapped, ran out of memory or reported a zlib
  // error: runWithPng16Fallback then encodes again with pako.
  let failed = false;
  const guard = (call) => {
    try {
      return call();
    } catch (err) {
      failed = true;
      throw err;
    }
  };

  function reserve(which, bytes) {
    const ptrKey = `${which}Ptr`;
    const capKey = `${which}Cap`;
    if (bytes <= buffers[capKey]) return buffers[ptrKey];
    if (buffers[ptrKey]) ex.pd_free(buffers[ptrKey], buffers[capKey]);
    buffers[ptrKey] = 0;
    buffers[capKey] = 0;
    const capacity = Math.max(bytes, MIN_BUFFER_BYTES);
    const ptr = guard(() => ex.pd_alloc(capacity));
    if (!ptr) {
      failed = true;
      throw new RangeError(`png-deflate could not allocate ${capacity} bytes`);
    }
    buffers[ptrKey] = ptr;
    buffers[capKey] = capacity;
    return ptr;
  }

  class Deflate {
    constructor({ raw = false, windowBits = 15, level = -1, strategy = 0, chunkSize = 1 << 14 } = {}) {
      if (!raw && !(windowBits < 0)) {
        throw new RangeError('png-deflate writes raw deflate streams only (raw: true)');
      }
      this.err = 0;
      this.msg = '';
      this.ended = false;
      this.chunks = [];
      this.result = null;
      this.chunkSize = Math.max(MIN_OUTPUT_BYTES, Math.floor(chunkSize) || 0);
      this.stream = guard(() => ex.pd_new(level, strategy));
      if (!this.stream) throw new RangeError(`png-deflate rejects level ${level} / strategy ${strategy}`);
    }

    /**
     * pako's push: `mode` is a zlib flush value (`true` finishes, `false` or
     * none does not flush). Every output chunk goes to `onData` as a copy.
     * @returns {boolean} false once the stream ended or failed
     */
    push(data, mode) {
      if (this.ended || !this.stream) return false;
      const flush = mode === true ? Z_FINISH : (mode === false || mode == null ? Z_NO_FLUSH : mode);
      const input = asBytes(data);
      const inPtr = input.length > 0 ? reserve('in', input.length) : 0;
      const outPtr = reserve('out', this.chunkSize);
      const outCap = this.chunkSize;
      if (input.length > 0) new Uint8Array(ex.memory.buffer, inPtr, input.length).set(input);
      let offset = 0;
      for (;;) {
        const status = guard(() => ex.pd_deflate(this.stream, inPtr + offset, input.length - offset, outPtr, outCap, flush));
        const consumed = ex.pd_consumed(this.stream);
        const produced = ex.pd_produced(this.stream);
        offset += consumed;
        // A view after the call: the memory may have grown.
        if (produced > 0) this.onData(new Uint8Array(ex.memory.buffer, outPtr, produced).slice());
        if (status < 0) {
          this.onEnd(status);
          return false;
        }
        if (status === STATUS_STREAM_END) {
          this.onEnd(STATUS_OK);
          return true;
        }
        // As in zlib: done once the input is in and the call left output
        // space, i.e. the requested flush is complete. A finish ends above.
        const settled = offset >= input.length && produced < outCap;
        if (settled && flush !== Z_FINISH) return true;
        if (consumed === 0 && produced === 0) {
          // No progress although input or a flush is pending: zlib's
          // Z_BUF_ERROR; stop instead of spinning.
          this.onEnd(status === STATUS_NO_PROGRESS ? -5 : -2);
          return false;
        }
      }
    }

    onData(chunk) {
      this.chunks.push(chunk);
    }

    onEnd(status) {
      if (status !== STATUS_OK) failed = true;
      this.err = status;
      this.msg = status === STATUS_OK ? '' : (MESSAGES[status] || `zlib status ${status}`);
      this.ended = true;
      if (status === STATUS_OK && this.chunks.length > 0) {
        const total = this.chunks.reduce((n, chunk) => n + chunk.length, 0);
        this.result = new Uint8Array(total);
        let at = 0;
        for (const chunk of this.chunks) {
          this.result.set(chunk, at);
          at += chunk.length;
        }
      }
      this.chunks = [];
      this.dispose();
    }

    /** Frees the stream's WebAssembly memory; a stream never finished must be disposed. */
    dispose() {
      if (this.stream) {
        ex.pd_end(this.stream);
        this.stream = 0;
      }
    }
  }

  return { Deflate, variant, memoryBytes: () => ex.memory.buffer.byteLength, failed: () => failed };
}

async function readModuleBytes(url, fetchImpl) {
  if (url.protocol === 'file:') {
    // Node (the tests); never reached in a browser.
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ fs);
    return readFile(url);
  }
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`png-deflate: HTTP ${response.status} for ${url.href}`);
  return response.arrayBuffer();
}

/**
 * Instantiates the SIMD module where the engine validates WASM SIMD, the
 * scalar one elsewhere. Rejects when neither can run here.
 */
export async function instantiatePngDeflate({
  simd = wasmSimdSupported(),
  wasm = globalThis.WebAssembly,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!wasm || typeof wasm.instantiate !== 'function') throw new Error('WebAssembly is not available');
  const variant = simd ? 'simd' : 'scalar';
  const bytes = await readModuleBytes(PNG_DEFLATE_MODULE_URLS[variant], fetchImpl);
  const { instance } = await wasm.instantiate(bytes, {});
  return createWasmZlib(instance.exports, variant);
}

let loading = null;
let loaded = null;
let failure = null;

function warnOnce(stage, err) {
  if (failure) return;
  failure = { stage, message: err && err.message ? err.message : String(err) };
  console.warn(`[png16] WebAssembly deflate ${stage} failed, using pako:`, err);
}

/**
 * This realm's PNG16 deflater: the module's `{ Deflate }`, or pako when it
 * cannot run here (or failed while encoding). Never rejects.
 */
export function loadPng16Zlib(options) {
  if (!loading) {
    loading = instantiatePngDeflate(options).catch((err) => {
      warnOnce('start', err);
      return pako;
    }).then((zlib) => {
      loaded = zlib;
      return zlib;
    });
  }
  return loading.then((zlib) => (failure ? pako : zlib));
}

const isTrap = (err) => typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError;

/**
 * `encode(zlib)` with the given deflater. If the module failed (a trap, its
 * memory, a zlib error), the realm switches to pako and the frame is encoded
 * again with it: the encoders only read their samples, so the second run is
 * complete. Any other error (a bad frame) is the encoder's and is rethrown.
 */
export function runWithPng16Fallback(zlib, encode) {
  if (zlib === pako || failure) return encode(pako);
  try {
    return encode(zlib);
  } catch (err) {
    if (!isTrap(err) && !(typeof zlib.failed === 'function' && zlib.failed())) throw err;
    warnOnce('encode', err);
    return encode(pako);
  }
}

/** This realm's deflater: 'simd', 'scalar' or 'pako'; null before loadPng16Zlib() settled. */
export function png16DeflateVariant() {
  if (failure) return 'pako';
  if (!loaded) return null;
  return loaded === pako ? 'pako' : loaded.variant;
}
