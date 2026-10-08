// Standalone Node test for loadRawFile's native desktop decode (#264 part C) -
// run with: node negative2positive/src/app/rawFileLoader.native.test.mjs
//
// The desktop shell (Tauri invoke + the rawdecode:// scheme), libraw-wasm, the
// plane-transfer worker and the post-decode worker are faked at their
// boundaries; everything else is the shipping code. Covers: a native decode
// gives exactly the planes the WASM decode gives for the same LibRaw output;
// a LibRaw failure (the HE-compressed NEFs) takes the embedded-preview path
// with no WASM attempt; every other native failure (open refused, IPC error,
// transfer error, step timeout) decodes the same bytes with WASM instead; an
// abort cancels the native session; background decodes ask for fewer threads.
//
// Decoder selection end to end (#264, docs/raw-decoding.md): libraw-wasm is
// the installed package behind a module hook whose class can advertise the
// threaded build (`LibRaw.features.threads`) and record how it is built, so
// the same file also covers the threaded build on an isolated page (every
// core in the foreground, two in a background lane, from the same flag the
// native decoder reads), a threaded build that does not start (the same
// decode on `new LibRaw()`), the native fallback building the threaded WASM
// decoder, and a desktop whose gate is off.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { handleRawPostDecodeMessage } from './rawPostDecode.js';
import { handleNativePlaneMessage, resetNativePlaneTransport } from './nativeRawTransfer.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';
import { rawResultToRgb16 } from './rawResultToRgb16.js';
import { packRGBToImage16, toRGBA8 } from '../silvercore/util/image16.js';
import { suppressSensorDefectsReference } from '../silvercore/util/sensorDefects.reference.mjs';

console.info = () => {};
console.warn = () => {};
console.error = () => {};

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new RangeError('bad ImageData');
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// --- the embedded-preview decode (browser APIs) --------------------------------
let bitmapDecodes = 0;
globalThis.createImageBitmap = async () => { bitmapDecodes++; return { width: 1620, height: 1080, close() {} }; };
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => new ImageData(new Uint8ClampedArray(w * h * 4).fill(128), w, h) })
  })
};

function makeContainer() {
  const bytes = new Uint8Array(96 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xFF;
  for (let i = 0; i < bytes.length - 2; i++) if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) bytes[i + 1] = 0;
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xFF, 0xC0, 0x00, 0x11, 0x08, 1080 >> 8, 1080 & 0xFF, 1620 >> 8, 1620 & 0xFF, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  bytes.set([0xFF, 0xD8, ...app0, ...sof0], 40 * 1024);
  return bytes;
}

const fixture = makeRawResult({ width: 64, height: 48, seed: 29, channels: 3, bits: 16 });
// The plane native_raw.rs serves: LibRaw's RGB16 packed as packRGBToImage16 packs it.
function packedNativePlane() {
  const { rgb16, channels } = rawResultToRgb16(cloneRawResult(fixture));
  const image16 = packRGBToImage16(fixture.width, fixture.height, rgb16, channels);
  return new Uint8Array(image16.data.buffer.slice(image16.data.byteOffset, image16.data.byteOffset + image16.data.byteLength));
}
function expectedPlanes() {
  const { rgb16, channels } = rawResultToRgb16(cloneRawResult(fixture));
  const image16 = packRGBToImage16(fixture.width, fixture.height, rgb16, channels);
  suppressSensorDefectsReference(image16);
  return { rgba16: image16.data, rgba8: toRGBA8(image16).data };
}
const expected = expectedPlanes();

const NATIVE_METADATA = {
  width: 64, height: 48, raw_width: 70, raw_height: 50, top_margin: 0, left_margin: 0, flip: 0,
  camera_make: 'Nikon', camera_model: 'Z f', iso_speed: 100, shutter: 0.004000000189989805,
  aperture: 2.799999952316284, focal_len: 50, timestamp: 1700000000, shot_order: 0, desc: ' note ', artist: '',
  gps_data: { latitude: [0, 0, 0], longitude: [0, 0, 0], altitude: 0, latref: null, longref: null, altref: 0, gpsstatus: null, gpsparsed: false },
  thumb_width: 1620, thumb_height: 1080, thumb_format: 1,
  lens: { Lens: 'NIKKOR Z 50mm f/1.8 S', LensMake: 'Nikon', LensSerial: '', InternalLensSerial: '', MinFocal: 50, MaxFocal: 50,
    MaxAp4MinFocal: 1.8, MaxAp4MaxFocal: 1.8, EXIF_MaxAp: 1.8, FocalLengthIn35mmFormat: 50,
    makernotes: { Lens: '', LensID: 0, MinFocal: 0, MaxFocal: 0, MaxAp: 0, MinAp: 0, CurFocal: 0, CurAp: 0,
      FocalLengthIn35mmFormat: 0, MinFocusDistance: 0, LensMount: 0, CameraMount: 0, body: '' } },
};

// --- the desktop shell ---------------------------------------------------------
const scene = {};
function reset(overrides = {}) {
  Object.assign(scene, {
    open: 'ok',          // 'ok' | 'librawError' | 'needsWasm' | 'throw'
    process: 'ok',       // 'ok' | 'librawError' | 'throw' | 'hang'
    fetch: 'ok',         // 'ok' | 'missing' | 'network'
    workerFetch: 'ok',   // 'ok' | 'network' (the worker cannot reach the scheme)
    calls: [],
    uploads: [],
    released: [],
    threads: [],
    planes: new Map(),
    sessions: 0,
    workers: [],
    wasmOpenBytes: null,
    wasmOpenSettings: null,
    onProcess: null,
  }, overrides);
  bitmapDecodes = 0;
}

const core = {
  convertFileSrc: (path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`,
  async invoke(command, args, options) {
    scene.calls.push(command);
    await Promise.resolve();
    switch (command) {
      case 'native_raw_info':
        return { available: true, openmp: true, maxThreads: 8, libraw: '0.22.1-Release', platform: 'macos-aarch64', scheme: 'rawdecode', uploadChunkBytes: 8 * 1024 * 1024 };
      case 'native_raw_begin':
        scene.sessions++;
        scene.uploads = [];
        scene.expected = args.expectedBytes;
        return `s${scene.sessions}`;
      case 'native_raw_append':
        assert.ok(args instanceof Uint8Array, 'chunks go as raw bytes');
        assert.equal(options.headers['x-raw-decode-id'], `s${scene.sessions}`);
        scene.uploads.push(new Uint8Array(args));
        return undefined;
      case 'native_raw_open': {
        assert.equal(scene.uploads.reduce((n, chunk) => n + chunk.length, 0), scene.expected, 'the whole file is uploaded before open');
        if (scene.open === 'throw') throw new Error('IPC failed');
        if (scene.open === 'needsWasm') return { status: 'needsWasm', code: -2, message: 'no libjpeg', metadata: NATIVE_METADATA };
        if (scene.open === 'librawError') return { status: 'librawError', code: -2, message: 'Unsupported file format', metadata: { ...NATIVE_METADATA, width: 0, height: 0 } };
        return { status: 'ok', code: 0, message: '', metadata: NATIVE_METADATA };
      }
      case 'native_raw_process': {
        scene.threads.push(args.threads);
        scene.onProcess?.();
        if (scene.process === 'hang') return new Promise(() => {});
        if (scene.process === 'throw') throw new Error('decode task failed');
        if (scene.process === 'librawError') return { status: 'librawError', code: -2, message: 'Unsupported file format or not RAW file' };
        const plane = packedNativePlane();
        scene.planes.set(args.id, plane);
        const partBytes = 7000;
        return { status: 'ok', code: 0, message: '', width: 64, height: 48, byteLength: plane.length, partBytes, parts: Math.ceil(plane.length / partBytes), threads: args.threads || 8, decodeMs: 3 };
      }
      case 'native_raw_release':
        scene.released.push(args.id);
        return undefined;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  },
};
globalThis.window = { __TAURI__: { core } };
globalThis.localStorage = { getItem: key => (key === 'nc_native_raw' ? 'on' : null) };

// rawdecode://localhost/<id>?part=k, 7000-byte parts, delivered in 3 chunks each.
globalThis.fetch = async (url) => {
  const match = /^rawdecode:\/\/localhost\/([^?]+)\?part=(\d+)$/.exec(String(url));
  if (!match) throw new TypeError(`fetch failed: ${url}`);
  if (scene.fetch === 'network') throw new TypeError('Load failed');
  const plane = scene.planes.get(decodeURIComponent(match[1]));
  if (!plane || scene.fetch === 'missing') return new Response(null, { status: 404 });
  const start = Number(match[2]) * 7000;
  const part = plane.subarray(start, Math.min(plane.length, start + 7000));
  const third = Math.ceil(part.length / 3);
  return new Response(new ReadableStream({
    start(controller) {
      for (let at = 0; at < part.length; at += third) controller.enqueue(part.slice(at, at + third));
      controller.close();
    }
  }));
};

// --- workers ----------------------------------------------------------------------
class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.kind = /rawPostDecodeWorker/.test(this.url) ? 'post'
      : /libraw-wasm/.test(this.url) ? 'libraw'
        : /nativeRawFetchWorker/.test(this.url) ? 'fetch'
          : /scanDecodeWorker/.test(this.url) ? 'scan' : 'other';
    this.terminated = false;
    this.received = [];
    scene.workers.push(this);
    // The preview JPEG decodes on the page (createImageBitmap above): the
    // scan worker reports that it cannot decode images.
    if (this.kind === 'scan') this.reply({ ready: true, canDecodeImages: false });
  }

  reply(data, transfer = []) {
    const back = structuredClone({ data }, { transfer }).data;
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: back }); });
  }

  postMessage(message, transfer = []) {
    if (this.terminated) return;
    const moved = structuredClone({ message }, { transfer }).message;
    this.received.push(moved.fn || moved.type);
    if (this.kind === 'libraw') {
      const { id, fn } = moved;
      if (fn === 'open') {
        scene.wasmOpenBytes = new Uint8Array(moved.args[0]);
        scene.wasmOpenSettings = moved.args[1];
        this.reply({ id });
      } else if (fn === 'metadata') {
        this.reply({ id, out: { make: 'Fake', model: 'Sensor', width: 64, height: 48 } });
      } else if (fn === 'imageData') {
        const out = cloneRawResult(fixture);
        this.reply({ id, out }, [out.data.buffer]);
      }
      return;
    }
    if (this.kind === 'fetch') {
      const fetchImpl = scene.workerFetch === 'network' ? async () => { throw new TypeError('Load failed'); } : globalThis.fetch;
      handleNativePlaneMessage(moved, (reply, replyTransfer) => this.reply(reply, replyTransfer), { fetchImpl });
      return;
    }
    if (this.kind === 'post') {
      queueMicrotask(() => {
        if (!this.terminated) handleRawPostDecodeMessage(moved, (reply, replyTransfer) => this.reply(reply, replyTransfer));
      });
    }
  }

  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

// libraw-wasm as installed (1.6.0), as a subclass that can advertise the
// threaded build and records its constructor argument ('single' for none).
const librawTest = globalThis.__ncLibRawTest = { features: undefined, constructed: [], startup: null };
{
  const real = import.meta.resolve('libraw-wasm');
  const fake = 'nc-test:libraw-wasm';
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'libraw-wasm' && context.parentURL !== fake) return { url: fake, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url !== fake) return nextLoad(url, context);
      return {
        format: 'module',
        shortCircuit: true,
        source: `import Installed from ${JSON.stringify(real)};
          export default class LibRaw extends Installed {
            static get features() { return globalThis.__ncLibRawTest.features; }
            constructor(options) {
              super();
              this.options = options;
              globalThis.__ncLibRawTest.constructed.push(options === undefined ? 'single' : options);
            }
            runtimeInfo() {
              const startup = globalThis.__ncLibRawTest.startup;
              return startup ? startup(this.options) : Promise.resolve({ threaded: this.options !== undefined, threads: this.options?.threads ?? 1 });
            }
          }`
      };
    }
  });
}

const { loadRawFile } = await import('./rawFileLoader.js');
const { planLibRawThreads, resetLibRawRuntime } = await import('./librawRuntime.js');
const { resetNativeRawProbe } = await import('./nativeRawDecoder.js');

const workersOf = kind => scene.workers.filter(worker => worker.kind === kind);

function assertPlanes(imageData, label) {
  assert.equal(imageData.width, 64, label);
  assert.equal(imageData.height, 48, label);
  assert.deepEqual(imageData.__image16.data, expected.rgba16, `${label}: 16-bit plane`);
  assert.deepEqual(imageData.data, expected.rgba8, `${label}: 8-bit plane`);
}

// --- native decode: the planes the WASM decode gives, no WASM worker -------------
{
  reset();
  const container = makeContainer();
  const metadata = [];
  const imageData = await loadRawFile(container.buffer.slice(0), 'frame.nef', { onMetadata: meta => metadata.push(meta) });
  assertPlanes(imageData, 'native');
  assert.equal(workersOf('libraw').length, 0, 'libraw-wasm is never started');
  assert.equal(workersOf('fetch').length, 1, 'the plane comes through the transfer worker');
  assert.deepEqual(scene.threads, [0], 'a foreground decode asks for every core');
  assert.deepEqual(scene.released, ['s1'], 'the session is released once the plane is in');
  assert.deepEqual(Buffer.concat(scene.uploads), Buffer.from(container), 'the exact file bytes are uploaded');
  assert.ok(scene.uploads.every(chunk => chunk.length <= 8 * 1024 * 1024));
  assert.equal(bitmapDecodes, 0, 'no preview decode');
  assert.deepEqual(metadata, [{ lensModel: '[object Object]', lensMaker: 'Nikon', cameraModel: 'Z f', cameraMaker: 'Nikon', focal: 50, aperture: 2.799999952316284 }],
    'lens metadata is read from the native metadata exactly as from libraw-wasm\'s');
  for (const worker of scene.workers) assert.equal(worker.terminated, true, `${worker.kind} worker terminated`);
}

// --- the same decode through libraw-wasm (no desktop) gives the same planes -------
{
  reset();
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const imageData = await loadRawFile(makeContainer().buffer, 'frame.nef');
    assertPlanes(imageData, 'wasm reference');
    assert.equal(workersOf('libraw').length, 1);
  } finally {
    globalThis.window = saved;
  }
}

// --- background lanes ask for two threads -------------------------------------------
{
  reset();
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { priority: 'background' }), 'background');
  assert.deepEqual(scene.threads, [2]);
}

// Explicit foreground priority, as supplied by shared adoption and ensureBase.
{
  reset();
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { priority: 'user' }), 'foreground');
  assert.deepEqual(scene.threads, [0], 'native foreground uses the full pool');
}

// --- LibRaw cannot decode the file (HE NEF): embedded preview, no WASM retry ------
{
  reset({ process: 'librawError' });
  const imageData = await loadRawFile(makeContainer().buffer, 'DSC_8800.NEF');
  assert.equal(bitmapDecodes, 1, 'the embedded JPEG is decoded');
  assert.equal(imageData.width, 1620);
  assert.equal(workersOf('libraw').length, 0, 'no second LibRaw attempt');
  assert.deepEqual(scene.released, ['s1']);
}

// --- a failed open resolves like libraw-wasm's, then the preview path -------------
{
  reset({ open: 'librawError' });
  const imageData = await loadRawFile(makeContainer().buffer, 'broken.nef');
  assert.equal(bitmapDecodes, 1);
  assert.equal(imageData.width, 1620);
  assert.ok(!scene.calls.includes('native_raw_process'), 'nothing unpacks after a failed open');
  assert.equal(workersOf('libraw').length, 0);
}

// --- every other native failure decodes the same bytes with WASM ------------------
for (const [label, overrides] of [
  ['open refused (no libjpeg)', { open: 'needsWasm' }],
  ['open IPC error', { open: 'throw' }],
  ['decode task error', { process: 'throw' }],
  ['transfer 404', { fetch: 'missing', workerFetch: 'ok' }],
]) {
  reset(overrides);
  resetNativePlaneTransport();
  const container = makeContainer();
  const imageData = await loadRawFile(container.buffer.slice(0), 'frame.nef', { halfSize: true, outputBps: 16, suppressSensorDefects: true });
  assertPlanes(imageData, label);
  assert.equal(workersOf('libraw').length, 1, `${label}: libraw-wasm decodes`);
  assert.deepEqual(scene.wasmOpenBytes, container, `${label}: WASM gets the untouched file bytes`);
  assert.equal(scene.wasmOpenSettings.halfSize, true, `${label}: with the same settings`);
  assert.equal(bitmapDecodes, 0, `${label}: no preview`);
  if (scene.sessions > 0) assert.ok(scene.released.includes('s1'), `${label}: native session released`);
}

// --- a worker that cannot reach the scheme: the page reads the plane itself -------
{
  reset({ workerFetch: 'network' });
  resetNativePlaneTransport();
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef'), 'page transfer');
  assert.equal(workersOf('libraw').length, 0);
  reset();
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef'), 'page transfer remembered');
  assert.equal(workersOf('fetch').length, 0, 'the page keeps reading planes itself');
  resetNativePlaneTransport();
}

// --- a native step that never answers: WASM within the loader's budget -------------
{
  reset({ process: 'hang' });
  const realSetTimeout = globalThis.setTimeout;
  // Run the native step timeouts (20 s for the loader's 90 s budget) at once.
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 20_000 ? 0 : ms, ...rest);
  try {
    assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef'), 'timeout');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(workersOf('libraw').length, 1, 'timeout: libraw-wasm decodes');
  assert.deepEqual(scene.released, ['s1'], 'timeout: the native decode is cancelled');
}

// --- abort while the native decode runs: AbortError, session cancelled -------------
{
  const controller = new AbortController();
  reset({ process: 'hang', onProcess: () => queueMicrotask(() => controller.abort(new DOMException('Superseded photo activation', 'AbortError'))) });
  await assert.rejects(
    loadRawFile(makeContainer().buffer, 'frame.nef', { signal: controller.signal }),
    error => error.name === 'AbortError'
  );
  assert.deepEqual(scene.released, ['s1'], 'abort releases (cancels) the native session');
  assert.equal(workersOf('libraw').length, 0, 'abort: no fallback');
  assert.equal(bitmapDecodes, 0);
}

// --- decoder selection (#264) --------------------------------------------------------
// Until here the page was not isolated and the package had no threaded build:
// every WASM decode above was `new LibRaw()`, exactly as before.
assert.ok(librawTest.constructed.length > 0 && librawTest.constructed.every(made => made === 'single'),
  `libraw-wasm is constructed without an argument: ${JSON.stringify(librawTest.constructed)}`);

const savedWindow = globalThis.window;
const savedStorage = globalThis.localStorage;
const cores = navigator.hardwareConcurrency;
const foregroundThreads = planLibRawThreads({ isolated: true, hardwareConcurrency: cores });
function isolate(on) {
  if (on) globalThis.crossOriginIsolated = true;
  else delete globalThis.crossOriginIsolated;
}

// The web, isolated, with a threaded build: every core in the foreground, two
// in a background lane, no desktop in sight.
{
  globalThis.window = {};
  isolate(true);
  librawTest.features = Object.freeze({ threads: true, maxThreads: 16 });
  try {
    reset();
    librawTest.constructed = [];
    assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { priority: 'user' }), 'threaded WASM');
    assert.deepEqual(librawTest.constructed, [{ threads: foregroundThreads }], 'the foreground decode asks for every core');
    assert.equal(workersOf('libraw').length, 1);
    librawTest.constructed = [];
    assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { priority: 'background' }), 'threaded WASM, background');
    assert.deepEqual(librawTest.constructed, [{ threads: Math.min(2, foregroundThreads) }], 'a background lane asks for two');

    // A threaded instance that does not start: the same bytes on `new LibRaw()`,
    // and the page stops asking for threads.
    reset();
    librawTest.constructed = [];
    librawTest.startup = () => Promise.reject(new Error('pthread pool failed to start'));
    const container = makeContainer();
    assertPlanes(await loadRawFile(container.buffer.slice(0), 'frame.nef'), 'threaded start failure');
    assert.deepEqual(librawTest.constructed, [{ threads: foregroundThreads }, 'single']);
    assert.deepEqual(scene.wasmOpenBytes, container, 'the single-threaded build gets the untouched file bytes');
    assert.equal(workersOf('libraw').filter(worker => worker.received.includes('open')).length, 1, 'only one LibRaw instance opens the file');
    librawTest.constructed = [];
    assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef'), 'after a start failure');
    assert.deepEqual(librawTest.constructed, ['single'], 'later decodes go straight to the single-threaded build');
  } finally {
    librawTest.startup = null;
    resetLibRawRuntime();
  }
}

// The desktop with native decoding on: a background decode caps the native
// threads and, when native fails, the threaded WASM fallback's threads alike.
{
  globalThis.window = savedWindow;
  globalThis.localStorage = savedStorage;
  resetNativeRawProbe();
  reset({ process: 'throw' });
  librawTest.constructed = [];
  const container = makeContainer();
  assertPlanes(await loadRawFile(container.buffer.slice(0), 'frame.nef', { priority: 'background' }), 'native fallback, threaded WASM');
  assert.deepEqual(scene.threads, [2], 'native: two threads for a background lane');
  assert.deepEqual(librawTest.constructed, [{ threads: Math.min(2, foregroundThreads) }], 'its WASM fallback: the threaded build, two threads');
  assert.deepEqual(scene.wasmOpenBytes, container);
}

// The desktop with the gate off (what ships until the deterministic
// libraw-wasm is pinned) and a webview without SharedArrayBuffer (macOS
// WKWebView reports isolation without it): `new LibRaw()` and nothing native
// beyond the probe.
{
  globalThis.localStorage = { getItem: () => null };
  resetNativeRawProbe();
  reset();
  librawTest.constructed = [];
  const SavedSharedArrayBuffer = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;
  try {
    assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { priority: 'background' }), 'gate off, no shared memory');
  } finally {
    globalThis.SharedArrayBuffer = SavedSharedArrayBuffer;
  }
  assert.deepEqual(scene.calls, ['native_raw_info'], 'the gate is asked, nothing is decoded natively');
  assert.deepEqual(librawTest.constructed, ['single']);
  globalThis.localStorage = savedStorage;
  resetNativeRawProbe();
}
isolate(false);
librawTest.features = undefined;

console.log('rawFileLoader.native.test.mjs passed');
