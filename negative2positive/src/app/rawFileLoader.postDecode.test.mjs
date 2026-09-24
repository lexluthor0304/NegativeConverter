// Standalone Node test for loadRawFile's LibRaw branch (#232) - run with:
// node negative2positive/src/app/rawFileLoader.postDecode.test.mjs
//
// LibRaw and the post-decode worker are faked at the Worker boundary (with
// real postMessage transfer semantics); everything else is the shipping code.
// Covers: planes identical to the 1703835 sequence, the per-decode worker's
// lifecycle, film statistics priming, the lazy embedded preview (never read
// on success; read from the Blob by every fallback), and the fallbacks.
import assert from 'node:assert/strict';
import { handleRawPostDecodeMessage } from './rawPostDecode.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';
import { rawResultToRgb16 } from './rawResultToRgb16.js';
import { packRGBToImage16, toRGBA8 } from '../silvercore/util/image16.js';
import { looksLikeBayerSnow } from '../silvercore/util/garbledCheck.js';
import { suppressSensorDefectsReference } from '../silvercore/util/sensorDefects.reference.mjs';
import { extractNefPreviewJpeg } from './nefJpegPreview.js';
import { autoDetectFilmBase } from './filmBaseDetection.js';
import { detectFilmType } from './filmTypeDetection.js';

console.info = () => {}; // the loader logs every decode's metadata

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
const bitmapInputs = [];
globalThis.createImageBitmap = async (blob) => {
  bitmapInputs.push(new Uint8Array(await blob.arrayBuffer()));
  return { width: 1620, height: 1080, close() {} };
};
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => new ImageData(new Uint8ClampedArray(w * h * 4).fill(128), w, h)
    })
  })
};

// --- a RAW container with an embedded 1620×1080 JPEG preview -------------------
function makeContainer(withPreview = true) {
  const bytes = new Uint8Array(96 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xFF;
  for (let i = 0; i < bytes.length - 2; i++) if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) bytes[i + 1] = 0;
  if (withPreview) {
    const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const sof0 = [0xFF, 0xC0, 0x00, 0x11, 0x08, 1080 >> 8, 1080 & 0xFF, 1620 >> 8, 1620 & 0xFF, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
    bytes.set([0xFF, 0xD8, ...app0, ...sof0], 40 * 1024);
  }
  return bytes;
}

function countingBlob(bytes) {
  const blob = new Blob([bytes]);
  const original = blob.arrayBuffer.bind(blob);
  const spy = { reads: 0, blob };
  blob.arrayBuffer = () => { spy.reads++; return original(); };
  return spy;
}

// --- fake workers ------------------------------------------------------------
const scene = {
  open: 'ok',              // 'ok' | 'hang'
  result: null,            // what imageData() returns (a fresh clone per decode)
  postDecode: 'real',      // 'real' | 'crash' | 'blocked'
  workers: [],
};

class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.kind = /rawPostDecodeWorker/.test(this.url) ? 'post' : /libraw-wasm/.test(this.url) ? 'libraw' : 'other';
    if (this.kind === 'post' && scene.postDecode === 'blocked') throw new Error('blocked');
    this.terminated = false;
    this.received = [];
    this.onmessage = null;
    this.onerror = null;
    scene.workers.push(this);
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
      if (fn === 'open') { if (scene.open === 'ok') this.reply({ id }); return; }
      if (fn === 'metadata') { this.reply({ id, out: { make: 'Fake', model: 'Sensor', width: 64, height: 48 } }); return; }
      if (fn === 'imageData') {
        const out = scene.result;
        this.reply({ id, out }, out?.data ? [out.data.buffer] : []);
      }
      return;
    }
    if (this.kind === 'post') {
      queueMicrotask(() => {
        if (this.terminated) return;
        if (moved.type === 'process' && scene.postDecode === 'crash') {
          this.onerror?.({ type: 'error', message: 'worker died', preventDefault() {} });
          return;
        }
        handleRawPostDecodeMessage(moved, (reply, replyTransfer) => this.reply(reply, replyTransfer));
      });
    }
  }

  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

const { loadRawFile } = await import('./rawFileLoader.js');
const { hasCachedFilmBase, cachedAutoDetectFilmBase, cachedDetectFilmType } = await import('./filmStatsCache.js');

function headPlanes(result, { suppress = true } = {}) {
  const { rgb16, channels } = rawResultToRgb16(result);
  const image16 = packRGBToImage16(result.width, result.height, rgb16, channels);
  if (looksLikeBayerSnow(image16)) return { garbled: true };
  if (suppress) suppressSensorDefectsReference(image16);
  return { rgba16: image16.data, rgba8: toRGBA8(image16).data };
}

function reset(overrides = {}) {
  scene.open = 'ok';
  scene.result = null;
  scene.postDecode = 'real';
  scene.workers.length = 0;
  bitmapInputs.length = 0;
  Object.assign(scene, overrides);
}

const fixture = makeRawResult({ width: 64, height: 48, seed: 17, channels: 3, bits: 16 });
const expected = headPlanes(cloneRawResult(fixture));
const expectedUnrepaired = headPlanes(cloneRawResult(fixture), { suppress: false });
const previewBytes = (() => {
  const extracted = extractNefPreviewJpeg(makeContainer().buffer);
  return new Uint8Array(extracted.jpegBytes);
})();

function assertPlanes(imageData, want, label) {
  assert.equal(imageData.width, 64, label);
  assert.equal(imageData.height, 48, label);
  assert.deepEqual(imageData.__image16.data, want.rgba16, `${label}: 16-bit plane`);
  assert.deepEqual(imageData.data, want.rgba8, `${label}: 8-bit plane`);
  assert.equal(imageData.__image16.width, 64);
}

function assertWorkersReleased(label) {
  for (const worker of scene.workers) assert.equal(worker.terminated, true, `${label}: ${worker.kind} worker terminated`);
}

// The eager preview scan (extractNefPreviewJpeg → findJpegSoiPositions) is the
// only Uint8Array.indexOf caller on this path: count it to see whether it ran.
let soiScans = 0;
const nativeIndexOf = Uint8Array.prototype.indexOf;
Uint8Array.prototype.indexOf = function (...args) { soiScans++; return nativeIndexOf.apply(this, args); };

// --- success with the source Blob: exact planes, no preview work, stats primed --
{
  reset({ result: cloneRawResult(fixture) });
  const spy = countingBlob(makeContainer());
  const container = makeContainer();
  soiScans = 0;
  const imageData = await loadRawFile(container.buffer, 'frame.nef', { sourceBlob: spy.blob, filmStats: { borderBufferPct: 10 } });
  assert.equal(soiScans, 0, 'a successful decode with a Blob never runs extractNefPreviewJpeg');
  assertPlanes(imageData, expected, 'worker path');
  assert.equal(spy.reads, 0, 'a successful decode never re-reads the file for its preview');
  assert.equal(bitmapInputs.length, 0);
  assert.equal(container.buffer.byteLength, 0, 'LibRaw took the container');
  const post = scene.workers.find((w) => w.kind === 'post');
  assert.deepEqual(post.received, ['ping', 'process'], 'post-decode ran in the per-decode worker');
  const libraw = scene.workers.find((w) => w.kind === 'libraw');
  assert.ok(scene.workers.indexOf(post) > scene.workers.indexOf(libraw) && libraw.received[0] === 'open', 'spawned in the LibRaw branch');
  assertWorkersReleased('success');
  assert.equal(hasCachedFilmBase(imageData, 10), true, 'worker statistics primed for createDefaultSettings');
  assert.deepEqual(cachedAutoDetectFilmBase(imageData, 10), autoDetectFilmBase(imageData, 10));
  assert.deepEqual(cachedDetectFilmType(imageData), detectFilmType(imageData));
}

// --- no statistics unless asked -------------------------------------------------
{
  reset({ result: cloneRawResult(fixture) });
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.nef', { sourceBlob: countingBlob(makeContainer()).blob });
  assertPlanes(imageData, expected, 'no stats request');
  assert.equal(hasCachedFilmBase(imageData, 10), false);
}

// --- without a Blob the preview is still extracted eagerly; planes unchanged ----
{
  reset({ result: cloneRawResult(fixture) });
  soiScans = 0;
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef'), expected, 'eager preview path');
  assert.ok(soiScans > 0, 'without a Blob the container is scanned before LibRaw takes it');
}

// --- post-decode worker blocked: main thread, bit-identical -----------------------
{
  reset({ result: cloneRawResult(fixture), postDecode: 'blocked' });
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { sourceBlob: countingBlob(makeContainer()).blob }), expected, 'no post-decode worker');
}

// --- suppressSensorDefects: false is honoured -----------------------------------
{
  reset({ result: cloneRawResult(fixture) });
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { suppressSensorDefects: false }), expectedUnrepaired, 'no defect pass');
}

// --- 8-bit half-size preview decode goes through the same worker ----------------
{
  const preview = makeRawResult({ width: 64, height: 48, seed: 18, channels: 3, bits: 8 });
  reset({ result: cloneRawResult(preview) });
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.nef', { preview: true, sourceBlob: countingBlob(makeContainer()).blob });
  assertPlanes(imageData, headPlanes(cloneRawResult(preview)), 'preview decode');
  assert.deepEqual(scene.workers.find((w) => w.kind === 'post').received, ['ping', 'process']);
}

// --- fallbacks read the preview lazily from the Blob -----------------------------
async function expectPreviewFallback(label, overrides, patchTimers = false) {
  reset(overrides);
  const spy = countingBlob(makeContainer());
  const realSetTimeout = globalThis.setTimeout;
  if (patchTimers) globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 10_000 ? 0 : ms, ...rest);
  let imageData;
  try {
    imageData = await loadRawFile(makeContainer().buffer, 'frame.nef', { sourceBlob: spy.blob });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(spy.reads, 1, `${label}: preview read from the Blob once`);
  assert.equal(bitmapInputs.length, 1, `${label}: preview decoded`);
  assert.deepEqual(bitmapInputs[0], previewBytes, `${label}: the same JPEG the eager scan finds`);
  assert.equal(imageData.width, 1620);
  assert.equal(imageData.height, 1080);
  assert.ok(imageData.__image16?.data instanceof Uint16Array, `${label}: 8-bit preview promoted`);
  assertWorkersReleased(label);
}

await expectPreviewFallback('empty LibRaw result', { result: {} });
await expectPreviewFallback('LibRaw open timeout', { open: 'hang' }, true);
await expectPreviewFallback('post-decode worker died with the pixels', { result: cloneRawResult(fixture), postDecode: 'crash' });
await expectPreviewFallback('garbled output', { result: makeRawResult({ width: 64, height: 64, seed: 19, channels: 3, bits: 16, snow: true }) });

// --- eager path still serves a timeout without a Blob ---------------------------
{
  reset({ result: {} });
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.nef');
  assert.equal(imageData.width, 1620);
  assert.deepEqual(bitmapInputs[0], previewBytes);
}

// --- no preview anywhere: the fallback fails as a decode error ------------------
{
  reset({ result: {} });
  await assert.rejects(
    loadRawFile(makeContainer(false).buffer, 'frame.nef', { sourceBlob: countingBlob(makeContainer(false)).blob }),
    (err) => err.code === 'RAW_DECODE_TIMEOUT'
  );
  // A file that can no longer be read fails the same way.
  reset({ result: {} });
  const unreadable = { arrayBuffer: () => Promise.reject(new Error('NotFoundError')) };
  await assert.rejects(loadRawFile(makeContainer().buffer, 'frame.nef', { sourceBlob: unreadable }), (err) => err.code === 'RAW_DECODE_TIMEOUT');
}

console.log('rawFileLoader.postDecode.test.mjs passed');
