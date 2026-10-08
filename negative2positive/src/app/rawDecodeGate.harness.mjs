// RGB16 gate harness (#264 part B), loaded by scripts/raw-decode-gate-smoke.mjs
// in the smoke run's page; not part of the app. It decodes with libraw-wasm
// exactly as rawFileLoader.js does (same settings, same package, including the
// test-only LIBRAW_WASM_DIST override of vite.config.js) and hashes LibRaw's
// own output, imageData().data (width * height * 3 little-endian uint16), so the
// hashes compare with src-tauri/native/wasm-parity-hashes.json and the native
// decoder's parity tests.
import LibRaw from 'libraw-wasm';
import { librawDecodeSettings, loadRawFile } from './rawFileLoader.js';

async function sha256(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the page runs: the package's feature flags, isolation, cores. */
export function describeDecoderRuntime() {
  return {
    features: LibRaw.features ? { ...LibRaw.features } : null,
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    cores: navigator.hardwareConcurrency || 1
  };
}

/**
 * One decode of `buffer` (not detached): `threads` null is `new LibRaw()`,
 * a number the threaded build. Resolves `{ sha256, width, height, colors,
 * bits, info, ms }`, or `{ empty: true, info, ms }` when LibRaw returns no
 * image (a file it cannot decode, e.g. the HE-compressed NEFs).
 */
export async function decodeRgb16(buffer, { threads = null, halfSize = false } = {}) {
  const raw = threads === null ? new LibRaw() : new LibRaw({ threads });
  const started = performance.now();
  try {
    await raw.open(new Uint8Array(buffer.slice(0)), librawDecodeSettings({ outputBps: 16, halfSize }));
    const image = await raw.imageData();
    const ms = Math.round(performance.now() - started);
    const info = typeof raw.runtimeInfo === 'function' ? await raw.runtimeInfo() : null;
    if (!image?.data) return { empty: true, info, ms };
    return { sha256: await sha256(image.data), width: image.width, height: image.height, colors: image.colors, bits: image.bits, info, ms };
  } finally {
    raw.dispose();
  }
}

/**
 * The app's loader on `buffer` (not detached), as the editor opens a file:
 * the decoder it chose, whether it fell back to the embedded preview, and
 * SHA-256 of the 8-bit plane (and of the 16-bit plane when it is not just
 * the 8-bit one widened).
 */
export async function loadWithApp(buffer, fileName, sourceBlob = null) {
  const warnings = [];
  let decoder = null;
  const { info, warn } = console;
  console.info = (...args) => {
    if (args[0] === '[RAW]' && args[1]?.decoder) decoder = { decoder: args[1].decoder, threads: args[1].threads };
    info.apply(console, args);
  };
  console.warn = (...args) => {
    if (typeof args[0] === 'string') warnings.push(args[0]);
    warn.apply(console, args);
  };
  try {
    const image = await loadRawFile(buffer.slice(0), fileName, sourceBlob ? { sourceBlob } : {});
    return {
      width: image.width,
      height: image.height,
      decoder,
      embeddedPreview: warnings.some((line) => /embedded preview/.test(line)),
      rgba8: await sha256(image.data),
      rgba16: image.__image16 ? await sha256(image.__image16.data) : null
    };
  } finally {
    console.info = info;
    console.warn = warn;
  }
}
