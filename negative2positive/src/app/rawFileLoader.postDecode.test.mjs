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
  openOptions: null,       // the options LibRaw's open() received
  metaWidth: 64,           // what metadata() reports
  metaHeight: 48,
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
      if (fn === 'open') { scene.openOptions = moved.args?.[1] || null; if (scene.open === 'ok') this.reply({ id }); return; }
      if (fn === 'metadata') { this.reply({ id, out: { make: 'Fake', model: 'Sensor', width: scene.metaWidth, height: scene.metaHeight } }); return; }
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
  scene.openOptions = null;
  scene.metaWidth = 64;
  scene.metaHeight = 48;
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

// --- the caller states the decode (#255) ------------------------------------------
{
  // `preview: true` alone no longer means half size or 8 bits.
  reset({ result: cloneRawResult(fixture) });
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.nef', { preview: true, sourceBlob: countingBlob(makeContainer()).blob });
  assert.equal(scene.openOptions.halfSize, false);
  assert.equal(scene.openOptions.outputBps, 16);
  assert.equal(imageData.__decodeScale, undefined);
  assert.equal(imageData.__fullSize, undefined);
}
{
  // The two-stage stand-in: half size, 16 bits, no defect pass, tagged with
  // its scale and the full size from LibRaw's metadata. onLibRawReleased
  // fires once, when the LibRaw worker is gone and before the planes are built.
  const half = makeRawResult({ width: 32, height: 24, seed: 21, channels: 3, bits: 16 });
  reset({ result: cloneRawResult(half) });
  const released = [];
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.dng', {
    preview: true, halfSize: true, outputBps: 16, suppressSensorDefects: false,
    sourceBlob: countingBlob(makeContainer()).blob,
    onLibRawReleased: () => released.push({
      libraw: scene.workers.find((w) => w.kind === 'libraw')?.terminated,
      processed: scene.workers.find((w) => w.kind === 'post')?.received.includes('process')
    })
  });
  assert.equal(scene.openOptions.halfSize, true);
  assert.equal(scene.openOptions.outputBps, 16);
  assert.deepEqual(released, [{ libraw: true, processed: false }]);
  assert.equal(imageData.width, 32);
  assert.equal(imageData.__decodeScale, 0.5);
  assert.deepEqual(imageData.__fullSize, { width: 64, height: 48 });
  assert.deepEqual(imageData.__image16.data, headPlanes(cloneRawResult(half), { suppress: false }).rgba16, 'no defect pass');
}
{
  // LibRaw returned the full size anyway (a LinearRaw DNG): not a stand-in scale.
  reset({ result: cloneRawResult(fixture) });
  const released = [];
  const imageData = await loadRawFile(makeContainer().buffer, 'frame.dng', {
    halfSize: true, outputBps: 16, suppressSensorDefects: false, onLibRawReleased: () => released.push(true)
  });
  assert.equal(imageData.width, 64);
  assert.equal(imageData.__decodeScale, undefined);
  assert.equal(imageData.__fullSize, undefined);
  assert.equal(released.length, 1);
}
{
  // #229 review R1-080: a half-size request on the app's own LinearRaw DNG
  // (240x160). LibRaw cannot halve LinearRaw data and returns the frame at
  // 240x160 (libraw-wasm 1.6.0 reports width 240, filters 0). With LibRaw's
  // size, and without one (the header's LinearRaw IFD stands in, where twice
  // the decode was assumed), the result is not a half-size frame.
  const { buildLinearDngParts } = await import('./linearDng.js');
  const parts = buildLinearDngParts({ width: 240, height: 160, data: new Uint16Array(240 * 160 * 3).fill(30000) });
  const dng = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { dng.set(part, at); at += part.length; }
  const unshrunk = makeRawResult({ width: 240, height: 160, seed: 23, channels: 3, bits: 16 });
  const holding = {
    async run(result) { return { garbled: false, held: true, width: result.width, height: result.height }; },
    terminate() {}
  };
  for (const [metaWidth, metaHeight] of [[240, 160], [0, 0], [242, 162], [480, 320]]) {
    const label = `LinearRaw with metadata ${metaWidth}x${metaHeight}`;
    reset({ result: cloneRawResult(unshrunk), metaWidth, metaHeight });
    const imageData = await loadRawFile(dng.slice().buffer, 'scan.dng', { halfSize: true, outputBps: 16, suppressSensorDefects: false });
    assert.equal(scene.openOptions.halfSize, true);
    assert.deepEqual([imageData.width, imageData.height], [240, 160]);
    assert.equal(imageData.__fullSize, undefined, `${label}: its own full size`);
    assert.equal(imageData.__decodeScale, undefined, label);
    reset({ result: cloneRawResult(unshrunk), metaWidth, metaHeight });
    const held = await loadRawFile(dng.slice().buffer, 'scan.dng', { postDecode: holding, halfSize: true, outputBps: 16, suppressSensorDefects: false });
    assert.deepEqual(held, { held: true, width: 240, height: 160 }, `${label}: a held frame without a fullSize`);
  }
  // A request flag alone is not evidence: non-TIFF RAWs can be unshrunk too.
  for (const [metaWidth, metaHeight] of [[0, 0], [66, 50], [640, 480]]) {
    const options = { halfSize: true, outputBps: 16, suppressSensorDefects: false };
    reset({ result: cloneRawResult(fixture), metaWidth, metaHeight });
    const page = await loadRawFile(makeContainer().buffer, 'frame.nef', options);
    assert.equal(page.__fullSize, undefined, `page: unmatched report ${metaWidth}x${metaHeight}`);
    assert.equal(page.__decodeScale, undefined);
    assert.equal(page.__halfSizeUncertain, true, 'unknown shrinkage requests full-size recovery');
    assertPlanes(page, headPlanes(cloneRawResult(fixture), { suppress: false }), 'unshrunk pixels unchanged');
    reset({ result: cloneRawResult(fixture), metaWidth, metaHeight });
    const held = await loadRawFile(makeContainer().buffer, 'frame.nef', { ...options, postDecode: holding });
    assert.deepEqual(held, { held: true, width: 64, height: 48, halfSizeUncertain: true }, 'held: unmatched report requires recovery');
  }
  // Earlier full decoding is independent of absent or misleading metadata.
  const knownFullSize = { width: 240, height: 160 };
  for (const [width, height] of [[240, 160], [120, 80]]) for (const [metaWidth, metaHeight] of [[0, 0], [480, 320], [120, 80]]) {
    const result = makeRawResult({ width, height, seed: 23, channels: 3, bits: 16 });
    const options = { halfSize: true, outputBps: 16, suppressSensorDefects: false, knownFullSize };
    reset({ result: cloneRawResult(result), metaWidth, metaHeight });
    const page = await loadRawFile(makeContainer().buffer, 'remembered.nef', options);
    assert.deepEqual(page.__fullSize, width === 120 ? knownFullSize : undefined, 'page uses the proven full/half match');
    assert.equal(page.__decodeScale, width === 120 ? .5 : undefined);
    assert.equal(page.__halfSizeUncertain, undefined);
    const expected = headPlanes(cloneRawResult(result), { suppress: false });
    assert.deepEqual([page.width, page.height], [width, height]);
    assert.deepEqual(page.data, expected.rgba8, 'remembered-size inference preserves the 8-bit plane');
    assert.deepEqual(page.__image16.data, expected.rgba16, 'remembered-size inference preserves every precision sample');
    reset({ result: cloneRawResult(result), metaWidth, metaHeight });
    const held = await loadRawFile(makeContainer().buffer, 'remembered.nef', { ...options, postDecode: holding });
    assert.deepEqual(held, { held: true, width, height, ...(width === 120 ? { fullSize: knownFullSize } : {}) },
      'held result uses the same authoritative match');
  }
  // A matching CFA header still proves a genuine half decode when the
  // metadata is missing or mismatched (active size vs raw sensor size).
  const cfa = new Uint8Array(50), header = new DataView(cfa.buffer);
  header.setUint16(0, 0x4949); header.setUint16(2, 42, true); header.setUint32(4, 8, true); header.setUint16(8, 3, true);
  [[256, 128], [257, 96], [262, 32803]].forEach(([tag, value], i) => {
    const offset = 10 + i * 12;
    header.setUint16(offset, tag, true); header.setUint16(offset + 2, 4, true);
    header.setUint32(offset + 4, 1, true); header.setUint32(offset + 8, value, true);
  });
  for (const [metaWidth, metaHeight] of [[0, 0], [130, 100], [64, 48], [256, 192]]) {
    reset({ result: cloneRawResult(fixture), metaWidth, metaHeight });
    const page = await loadRawFile(cfa.slice().buffer, 'frame.dng', { halfSize: true, outputBps: 16, suppressSensorDefects: false });
    assert.deepEqual(page.__fullSize, { width: 128, height: 96 });
    assert.equal(page.__decodeScale, 0.5);
    reset({ result: cloneRawResult(fixture), metaWidth, metaHeight });
    const held = await loadRawFile(cfa.slice().buffer, 'frame.dng', { halfSize: true, outputBps: 16, suppressSensorDefects: false, postDecode: holding });
    assert.deepEqual(held.fullSize, { width: 128, height: 96 }, 'held: header proves half size');
  }
  const fullCfa = makeRawResult({ width: 128, height: 96, seed: 23, channels: 3, bits: 16 });
  reset({ result: cloneRawResult(fullCfa), metaWidth: 256, metaHeight: 192 });
  const pageCfa = await loadRawFile(cfa.slice().buffer, 'frame.dng', { halfSize: true });
  assert.equal(pageCfa.__fullSize, undefined, 'CFA header proves unshrunk output despite doubled metadata');
  assert.equal(pageCfa.__halfSizeUncertain, undefined);
}
{
  // A failed decode still reports the release (sequential stage 2 starts there).
  reset({ result: {} });
  const released = [];
  await assert.rejects(loadRawFile(makeContainer(false).buffer, 'frame.nef', { halfSize: true, onLibRawReleased: () => released.push(true) }));
  assert.equal(released.length, 1);
}
// --- decode-ahead sub-stages (#256 Part 4): the hook runs after LibRaw is
// disposed and before the post-decode pass, which waits for it --------------
{
  reset({ result: cloneRawResult(fixture) });
  const seen = [];
  let letPass;
  const gate = new Promise((resolve) => { letPass = resolve; });
  const loading = loadRawFile(makeContainer().buffer, 'frame.nef', {
    sourceBlob: countingBlob(makeContainer()).blob,
    onStage: (name) => {
      const libraw = scene.workers.find((w) => w.kind === 'libraw');
      const post = scene.workers.find((w) => w.kind === 'post');
      seen.push({ name, librawTerminated: libraw.terminated, processPosted: post.received.includes('process') });
      return gate;
    }
  });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ name: 'postDecode', librawTerminated: true, processPosted: false }]);
  letPass();
  assertPlanes(await loading, expected, 'post-decode after the stage hook');
  assertWorkersReleased('stage hook');
  // Aborted while waiting for the post-decode slot: nothing is posted.
  reset({ result: cloneRawResult(fixture) });
  const controller = new AbortController();
  const aborted = loadRawFile(makeContainer().buffer, 'frame.nef', {
    sourceBlob: countingBlob(makeContainer()).blob,
    signal: controller.signal,
    onStage: () => new Promise((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 1))
  });
  await assert.rejects(aborted, (err) => err.name === 'AbortError');
  assert.equal(scene.workers.find((w) => w.kind === 'post').received.includes('process'), false);
  assertWorkersReleased('aborted at the stage hook');
}
// --- #252: a roll lane's decode slot and its own frame worker --------------------
{
  const { runRawPostDecode } = await import('./rawPostDecode.js');
  const { createDecodeSlots } = await import('./batchExportScheduler.js');
  const { estimateRawDecodeBytes } = await import('./rawDecodeEstimate.js');
  const libraw = () => scene.workers.find((w) => w.kind === 'libraw');
  // The lane's worker keeps the planes: a sizes-only result, no per-decode worker.
  reset({ result: cloneRawResult(fixture) });
  const runs = [];
  const holding = {
    async run(result, options) { runs.push({ width: result.width, options }); return { garbled: false, held: true, width: result.width, height: result.height }; },
    terminate() {}
  };
  const held = await loadRawFile(makeContainer().buffer, 'frame.nef', { postDecode: holding, filmStats: { borderBufferPct: 10 } });
  assert.deepEqual(held, { held: true, width: 64, height: 48 });
  assert.deepEqual(runs[0].options, { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } });
  assert.equal(scene.workers.some((w) => w.kind === 'post'), false, 'no per-decode worker for a lane decode');
  assertWorkersReleased('held');
  // A flagged half-size analysis decode (#252 part 6) reports the full size
  // LibRaw's metadata gives for the frame it halved.
  reset({ result: cloneRawResult(fixture) });
  scene.metaWidth = 128;
  scene.metaHeight = 96;
  const halfHeld = await loadRawFile(makeContainer().buffer, 'frame.nef', { postDecode: holding, halfSize: true, outputBps: 16, suppressSensorDefects: false });
  assert.deepEqual(halfHeld.fullSize, { width: 128, height: 96 });
  // LibRaw returned the metadata's full size anyway (a LinearRaw DNG, #255):
  // not a half-size frame.
  reset({ result: cloneRawResult(fixture) });
  const fullHeld = await loadRawFile(makeContainer().buffer, 'frame.dng', { postDecode: holding, halfSize: true, outputBps: 16, suppressSensorDefects: false });
  assert.equal(fullHeld.fullSize, undefined);

  // Planes the lane's worker hands back are wrapped exactly as the loader's own.
  reset({ result: cloneRawResult(fixture) });
  const local = { run: async (result, options) => runRawPostDecode(result, options), terminate() {} };
  assertPlanes(await loadRawFile(makeContainer().buffer, 'frame.nef', { postDecode: local }), expected, 'lane worker planes');

  // The demosaic waits for a slot reserving the real decode bytes, and gives
  // it back before the post-decode steps.
  reset({ result: cloneRawResult(fixture) });
  const slots = createDecodeSlots({ slots: 1, budgetBytes: Infinity });
  const other = await slots.acquire({ bytes: 1 });
  const order = [];
  const tracked = {
    acquire(request) { order.push(['acquire', request.bytes]); return slots.acquire(request).then(release => () => { order.push(['release']); release(); }); }
  };
  const watching = { run: async (result, options) => { order.push(['post', slots.held]); return runRawPostDecode(result, options); }, terminate() {} };
  const decoding = loadRawFile(makeContainer().buffer, 'frame.nef', { postDecode: watching, decodeSlot: tracked });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(order, [['acquire', estimateRawDecodeBytes(64, 48)]], 'reserved with the size LibRaw reported');
  assert.deepEqual(libraw().received, ['open', 'metadata'], 'no demosaic while another frame holds the slot');
  other();
  assertPlanes(await decoding, expected, 'slotted decode');
  assert.deepEqual(order.map(entry => entry[0]), ['acquire', 'release', 'post']);
  assert.equal(order[2][1], 0, 'the slot is free while the post-decode steps run');
  assert.deepEqual(libraw().received, ['open', 'metadata', 'imageData']);

  // An abort while waiting for the slot: no demosaic, workers released, the
  // waiter leaves the queue.
  reset({ result: cloneRawResult(fixture) });
  const busy = await slots.acquire({ bytes: 1 });
  const controller = new AbortController();
  const waiting = loadRawFile(makeContainer().buffer, 'frame.nef', { decodeSlot: slots, signal: controller.signal });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(slots.waiting, 1);
  controller.abort(new DOMException('superseded', 'AbortError'));
  await assert.rejects(waiting, (err) => err.name === 'AbortError');
  assert.equal(slots.waiting, 0);
  assert.equal(libraw().received.includes('imageData'), false);
  assertWorkersReleased('aborted at the slot');
  busy();
  assert.equal(slots.held, 0);
}

console.log('rawFileLoader.postDecode.test.mjs passed');
