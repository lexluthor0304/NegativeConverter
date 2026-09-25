// Standalone Node test for exportWorker.js — the message handler that every
// normal browser export actually runs (the main-thread encoders in
// app/exportImageEncoders.js are only the fallback).
//
// Drives real messages through the worker's onmessage and decodes the Blobs it
// posts back, so a regression to "8-bit data x257 labelled 16-bit" fails here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UPNG = require('upng-js');

const posted = [];
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers) {
    posted.push({ message, transfers });
  }
};

await import('./exportWorker.js');
assert.equal(typeof self.onmessage, 'function', 'exportWorker must install an onmessage handler');

function send(message) {
  posted.length = 0;
  self.onmessage({ data: message });
  return posted.map((p) => p.message);
}

async function blobOf(messages) {
  const result = messages.find((m) => m.type === 'blobResult');
  assert.ok(result, `expected a blobResult, got ${messages.map((m) => m.type).join(', ')}`);
  return new Uint8Array(await result.blob.arrayBuffer());
}

function png16Samples(bytes) {
  assert.equal(bytes[24], 16, 'IHDR bit depth');
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(decoded.depth, 16);
  const channels = decoded.ctype === 2 ? 3 : 4;
  const samples = new Uint16Array(decoded.width * decoded.height * 4);
  for (let i = 0; i < samples.length; i++) {
    const offset = (Math.floor(i / 4) * channels + i % 4) * 2;
    samples[i] = i % 4 === 3 && channels === 3 ? 65535 : (decoded.data[offset] << 8) | decoded.data[offset + 1];
  }
  return samples;
}

function tiff16Samples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  let stripOffset = 0;
  let stripByteCount = 0;
  let bitsOffset = 0;
  let channels = 4;
  for (let i = 0; i < entryCount; i++) {
    const off = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(off, true);
    const value = view.getUint32(off + 8, true);
    if (tag === 273) stripOffset = value;
    if (tag === 279) stripByteCount = value;
    if (tag === 258) bitsOffset = value;
    if (tag === 277) channels = value;
  }
  assert.equal(view.getUint16(bitsOffset, true), 16, 'BitsPerSample must be 16');
  const samples = new Uint16Array(stripByteCount / 2 / channels * 4);
  for (let i = 0; i < samples.length; i++) {
    const offset = (Math.floor(i / 4) * channels + i % 4) * 2;
    samples[i] = i % 4 === 3 && channels === 3 ? 65535 : view.getUint16(stripOffset + offset, true);
  }
  return samples;
}

const WIDTH = 2;
const HEIGHT = 1;
const EIGHT_BIT = new Uint8ClampedArray([0, 64, 128, 255, 255, 128, 64, 255]);
// Deliberately not multiples of 257.
const SIXTEEN_BIT = new Uint16Array([0x1234, 0x0001, 0xFFFE, 0xFFFF, 0xABCD, 0x8000, 0x0100, 0xFFFF]);

const copyOf = (view) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

// ------------------------------------------- PNG16: 8-bit fallback vs 16-bit

{
  const samples = png16Samples(await blobOf(send({
    type: 'encodePng16', id: 1, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT
  })));
  assert.deepEqual(Array.from(samples), Array.from(EIGHT_BIT).map((v) => v * 257));
}

{
  const samples = png16Samples(await blobOf(send({
    type: 'encodePng16', id: 2, pixelData: copyOf(SIXTEEN_BIT), sourceBits: 16, width: WIDTH, height: HEIGHT
  })));
  assert.equal(samples[0], 0x1234, 'the worker must write genuine 16-bit samples');
  assert.equal(samples[4], 0xABCD);
  assert.equal(samples[1], 0x0001);
  assert.equal(samples[3], 65535, 'alpha forced opaque');
  assert.ok(samples[0] % 257 !== 0, 'a x257 regression must fail here');
}

// -------------------------------------------------------------------- TIFF16

{
  const samples = tiff16Samples(await blobOf(send({
    type: 'encodeTiff', id: 3, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT, bitDepth: 16
  })));
  assert.deepEqual(Array.from(samples), Array.from(EIGHT_BIT).map((v) => v * 257));
}

{
  const samples = tiff16Samples(await blobOf(send({
    type: 'encodeTiff', id: 4, pixelData: copyOf(SIXTEEN_BIT), sourceBits: 16, width: WIDTH, height: HEIGHT, bitDepth: 16
  })));
  assert.equal(samples[0], 0x1234);
  assert.equal(samples[4], 0xABCD);
}

// ------------------------------------------- progress + applyAdjustments path

{
  const messages = send({
    type: 'encodePng16', id: 5, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT
  });
  assert.deepEqual(
    messages.filter((m) => m.type === 'progress').map((m) => m.percent),
    [10, 100]
  );
}

{
  const identity = new Uint8Array(256);
  for (let i = 0; i < 256; i++) identity[i] = i;
  const messages = send({
    type: 'applyAdjustments',
    id: 6,
    inputBuffer: copyOf(EIGHT_BIT),
    width: WIDTH,
    height: HEIGHT,
    settings: { curves: { r: identity, g: identity, b: identity }, exposure: 1 },
    quality: 'full'
  });
  const result = messages.find((m) => m.type === 'result');
  assert.ok(result);
  assert.equal(result.width, WIDTH);
  assert.deepEqual(Array.from(new Uint8ClampedArray(result.data)), [0, 128, 255, 255, 255, 255, 128, 255]);
  const transferred = posted.find((p) => p.message.type === 'result').transfers;
  assert.deepEqual(transferred, [result.data], 'the result buffer must be transferred, not cloned');
}

// ------------------------------------------------------------ error handling

{
  const messages = send({ type: 'nonsense', id: 7 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'error');
  assert.match(messages[0].message, /Unknown message type/);
}

{
  // A throwing handler must report back rather than strand the request.
  const messages = send({ type: 'encodePng16', id: 8, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: -1, height: 1 });
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(messages.at(-1).id, 8);
}

console.log('exportWorker.test.mjs passed');

// ======================================================= #250: owned planes
//
// Every input the worker gets is private to it (a copy, or a plane the export
// transferred), so both adjustment handlers run in place and hand the SAME
// buffer back, bit-identical to a run into a fresh buffer.

const { applyAdjustmentsToPixels, computeAdjustmentParams } = await import('./pixelAdjustments.js');
const { applyAdjustmentsToPixels16, downconvertPlane16 } = await import('./pixelAdjustments16.js');
const { encodeTiffBlob, encodePng16Blob, HOST_LITTLE_ENDIAN } = await import('./imageEncoders.js');
const { computeGainMap } = await import('./gainMap.js');
const { analyzeExpiredFilm, EXPIRED_RESCUE_DEFAULTS, EXPIRED_SPATIAL_VERSION } = await import('../pipeline/expiredRescue.js');
const pako = await import('pako');

// Not multiples of 4: partial gain-map blocks, odd strides.
const IW = 37;
const IH = 23;
function makePlane16(seed = 7) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const plane = new Uint16Array(IW * IH * 4);
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const o = (y * IW + x) * 4;
    const t = (x / (IW - 1)) * 0.7 + (y / (IH - 1)) * 0.3;
    const lift = 0.1 * (1 - x / (IW - 1));
    const v = (lift + (1 - lift) * t) * 65535;
    const grain = ((next() >>> 20) - 2048) * 3;
    plane[o] = Math.max(0, Math.min(65535, Math.round(v + grain)));
    plane[o + 1] = Math.max(0, Math.min(65535, Math.round(v * 0.83 + grain)));
    plane[o + 2] = Math.max(0, Math.min(65535, Math.round(v * 0.68 + grain)));
    plane[o + 3] = 65535;
  }
  return plane;
}
const plane8Of = (plane) => downconvertPlane16(plane, new Uint8ClampedArray(plane.length));
const linearCurve = () => Uint8Array.from({ length: 256 }, (_, v) => v);
const sCurve = () => Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
const baseSettings = () => ({
  curves: { r: linearCurve(), g: linearCurve(), b: linearCurve() },
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0,
  saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1,
  look: null, ...EXPIRED_RESCUE_DEFAULTS, expiredAnalysis: null
});
const measuredFrame = { width: IW, height: IH, data: plane8Of(makePlane16(3)) };
measuredFrame.__image16 = { width: IW, height: IH, data: makePlane16(3) };
const measured = analyzeExpiredFilm(measuredFrame, { borderBuffer: 0 });
assert.ok(measured, 'the synthetic frame yields an expired-film measurement');
const spatial = {
  version: EXPIRED_SPATIAL_VERSION,
  fraction: { left: 0.05, top: 0.1, width: 0.9, height: 0.8 },
  gridWidth: 4, gridHeight: 3,
  fog: {
    coefficients: [[0.18, -0.12, 0.02, 0.03, -0.01, 0.01], [0.16, -0.1, 0.01, 0.02, 0, 0.02], [0.2, -0.14, 0.03, 0.04, -0.02, 0]],
    offset: [0.02, 0.03, 0.01], amplitude: [0.12, 0.1, 0.14]
  },
  mean: [0.31, 0.42, 0.5, 0.58, 0.35, 0.44, 0.52, 0.61, 0.38, 0.47, 0.55, 0.66]
};
const recipes = {
  separable: { ...baseSettings(), curves: { r: sCurve(), g: linearCurve(), b: sCurve() }, exposure: 0.3, contrast: 12, temperature: 10, tint: -5, wbR: 1.08, wbB: 0.94, cyan: 4, magenta: -3, yellow: 2 },
  'per-pixel HSL + highlights/shadows': { ...baseSettings(), highlights: -20, shadows: 15, saturation: 10, vibrance: 25, contrast: 6 },
  'look matrix': { ...baseSettings(), look: { matrix: [1.05, 0.02, -0.04, -0.03, 1, 0.05, 0, -0.02, 1.12], offset: [-6, 4, 9], curves: { r: sCurve(), g: linearCurve(), b: linearCurve() } } },
  'expired rescue + spatial map': {
    ...baseSettings(), expiredEnabled: true, expiredLevels: 80, expiredNeutralize: 100, expiredCrossover: 60,
    expiredBrightness: 10, expiredContrast: 20, expiredUnevenFog: 100, expiredLocalContrast: 40,
    expiredAnalysis: { ...measured, spatial }
  }
};
{
  const params = computeAdjustmentParams(recipes['expired rescue + spatial map'], { width: IW, height: IH });
  assert.ok(params.doRescueSpatial, 'the rescue recipe exercises the spatial map');
  assert.ok(computeAdjustmentParams(recipes['per-pixel HSL + highlights/shadows']).doHsl);
  assert.ok(computeAdjustmentParams(recipes['look matrix']).doLookMatrix);
}

function sameArray(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  assert.equal(actual.constructor, expected.constructor, `${label}: type`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: sample ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

for (const [name, settings] of Object.entries(recipes)) {
  for (const quality of ['full', 'preview']) {
    const label = `${name} (${quality})`;
    const plane = makePlane16();
    const pixels = plane8Of(plane);
    const params = computeAdjustmentParams(settings, { width: IW, height: IH });

    // 8-bit: reference into a fresh buffer.
    const expected8 = new Uint8ClampedArray(pixels.length);
    applyAdjustmentsToPixels(pixels, expected8, IW * IH, params, quality, null, 500000, null);
    const input8 = pixels.slice().buffer;
    const replies8 = send({ type: 'applyAdjustments', id: 100, inputBuffer: input8, width: IW, height: IH, settings: structuredClone(settings), quality });
    const result8 = replies8.find((m) => m.type === 'result');
    assert.ok(result8, `${label}: 8-bit result`);
    assert.equal(result8.data, input8, `${label}: the 8-bit handler returns the buffer it received`);
    assert.deepEqual(posted.find((p) => p.message.type === 'result').transfers, [input8]);
    sameArray(new Uint8ClampedArray(result8.data), expected8, `${label}: 8-bit in place`);

    // 16-bit: reference into a fresh buffer.
    const expected16 = new Uint16Array(plane.length);
    applyAdjustmentsToPixels16(plane, expected16, IW * IH, params, quality, null, 500000, null);
    for (const planeOnly of [true, false]) {
      const input16 = plane.slice().buffer;
      const replies16 = send({ type: 'applyAdjustments16', id: 101, inputBuffer: input16, width: IW, height: IH, settings: structuredClone(settings), quality, planeOnly });
      const result16 = replies16.find((m) => m.type === 'result');
      assert.equal(result16.data, input16, `${label}: the 16-bit handler returns the buffer it received`);
      assert.equal(result16.bits, 16);
      sameArray(new Uint16Array(result16.data), expected16, `${label}: 16-bit in place`);
      if (planeOnly) assert.equal(result16.data8, undefined, `${label}: planeOnly sends no mirror`);
      else sameArray(new Uint8ClampedArray(result16.data8), plane8Of(expected16), `${label}: mirror`);
    }
  }
}

{
  // An error before the pass writes the input hands the input back.
  const input = makePlane16().buffer;
  const replies = send({ type: 'applyAdjustments16', id: 102, inputBuffer: input, width: IW, height: IH, settings: { ...baseSettings(), curves: null }, quality: 'full' });
  const error = replies.find((m) => m.type === 'error');
  assert.ok(error, 'a bad recipe is an error');
  assert.equal(error.returned.input, input, 'the unwritten plane goes back with the error');
  assert.deepEqual(posted.at(-1).transfers, [input]);
  const input8 = new Uint8ClampedArray(IW * IH * 4).buffer;
  const replies8 = send({ type: 'applyAdjustments', id: 103, inputBuffer: input8, width: IW + 1, height: IH, settings: baseSettings(), quality: 'full' });
  assert.equal(replies8.find((m) => m.type === 'error').returned.input, input8, 'a size mismatch is caught before any write');
}

// ----------------------------------------- adjust16AndEncode == adjust + encode

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

const tiffMetadata = { exif: { Make: 'Synthetic', DateTimeOriginal: '2026:09:25 12:00:00' }, xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' };
for (const [name, settings] of Object.entries({ identity: baseSettings(), ...recipes })) {
  const plane = makePlane16(11);
  const adjusted = send({ type: 'applyAdjustments16', id: 110, inputBuffer: plane.slice().buffer, width: IW, height: IH, settings: structuredClone(settings), quality: 'full', planeOnly: true })
    .find((m) => m.type === 'result');
  const adjustedPlane = new Uint16Array(adjusted.data);
  for (const format of ['tiff', 'png']) {
    const separate = format === 'tiff'
      ? await blobOf(send({ type: 'encodeTiff', id: 111, pixelData: adjustedPlane.slice().buffer, sourceBits: 16, width: IW, height: IH, bitDepth: 16, metadata: tiffMetadata }))
      : await blobOf(send({ type: 'encodePng16', id: 111, pixelData: adjustedPlane.slice().buffer, sourceBits: 16, width: IW, height: IH }));
    const fusedReplies = send({ type: 'adjust16AndEncode', id: 112, inputBuffer: plane.slice().buffer, width: IW, height: IH, settings: structuredClone(settings), quality: 'full', format, metadata: format === 'tiff' ? tiffMetadata : null });
    const replyTypes = fusedReplies.filter((m) => m.type !== 'progress').map((m) => m.type);
    assert.deepEqual(replyTypes, ['blobResult'], `${name}/${format}: only the Blob comes back`);
    const fused = await blobOf(fusedReplies);
    sameArray(fused, separate, `${name}/${format}: adjust16AndEncode bytes == applyAdjustments16 + encode`);
    // And the shipped (main-thread, copying) encoder writes the same file.
    const shipped = format === 'tiff'
      ? await bytesOf(encodeTiffBlob(adjustedPlane.slice(), IW, IH, 16, tiffMetadata))
      : await bytesOf(encodePng16Blob(adjustedPlane.slice(), IW, IH, pako));
    sameArray(fused, shipped, `${name}/${format}: == the copying encoder`);
  }
}

{
  const input = makePlane16().buffer;
  const replies = send({ type: 'adjust16AndEncode', id: 113, inputBuffer: input, width: IW, height: IH, settings: baseSettings(), quality: 'full', format: 'jpeg' });
  assert.equal(replies.at(-1).returned.input, input, 'an unsupported format is refused before the plane is written');
}

// ------------------------------------------------ owned-plane TIFF16 strip

{
  const plane = makePlane16(19);
  const shipped = await bytesOf(encodeTiffBlob(plane.slice(), IW, IH, 16, tiffMetadata));
  const owned = plane.slice();
  const inPlace = await bytesOf(encodeTiffBlob(owned, IW, IH, 16, tiffMetadata, { ownedPlane: true }));
  assert.ok(HOST_LITTLE_ENDIAN, 'every shipped target is little-endian');
  sameArray(inPlace, shipped, 'the owned-plane strip equals the shipped encoder byte for byte');
  assert.equal(owned[3], plane[4], 'the owned plane was compacted in place (pixel 1 red moved to sample 3)');
  // The endianness guard falls back to the copying loop and leaves the plane alone.
  const guarded = plane.slice();
  const fallback = await bytesOf(encodeTiffBlob(guarded, IW, IH, 16, tiffMetadata, { ownedPlane: true, littleEndian: false }));
  sameArray(fallback, shipped, 'the big-endian guard writes the same file');
  sameArray(guarded, plane, 'the guard does not touch the plane');
  // 8-bit sources and 8-bit output keep the loop.
  const eight = plane8Of(plane);
  sameArray(await bytesOf(encodeTiffBlob(eight.slice(), IW, IH, 16, null, { ownedPlane: true })), await bytesOf(encodeTiffBlob(eight.slice(), IW, IH, 16)), '8-bit source');
  const eightOut = plane.slice();
  sameArray(await bytesOf(encodeTiffBlob(eightOut, IW, IH, 8, null, { ownedPlane: true })), await bytesOf(encodeTiffBlob(plane.slice(), IW, IH, 8)), '8-bit output');
  sameArray(eightOut, plane, '8-bit output never compacts the plane');
}

// ------------------------------------------------------------- encodeImage

// Node has neither ImageData nor OffscreenCanvas. The stubs record what the
// worker draws and encode it as `type|quality|bytes`, so the test can tell
// which pixels and options reached the encoder.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    Object.assign(this, { data, width, height });
  }
};
const canvases = [];
class StubOffscreenCanvas {
  constructor(width, height) { Object.assign(this, { width, height, drawn: null, contextOptions: null }); canvases.push(this); }
  getContext(kind, options) {
    if (kind !== '2d' || StubOffscreenCanvas.noContext) return null;
    this.contextOptions = options || null;
    return { putImageData: (image) => { this.drawn = new Uint8ClampedArray(image.data); } };
  }
  async convertToBlob({ type, quality } = {}) {
    return new Blob([`${type}|${quality}|`, this.drawn], { type });
  }
}
async function encodedPixels(blob) {
  const bytes = await bytesOf(blob);
  const text = new TextDecoder('latin1').decode(bytes);
  const [type, quality] = text.split('|');
  return { type, quality, pixels: new Uint8ClampedArray(bytes.subarray(type.length + quality.length + 2)) };
}
function collectAsync() {
  const start = posted.length;
  return async () => {
    for (let i = 0; i < 200 && !posted.slice(start).some((p) => p.message.type !== 'progress'); i++) await new Promise((r) => setTimeout(r, 0));
    return posted.slice(start);
  };
}

{
  // No OffscreenCanvas: 'unsupported', with the pixels (and the plane) handed back.
  const instance = await import('./exportWorker.js?no-offscreen');
  const pixels = plane8Of(makePlane16()).buffer;
  const plane = makePlane16().buffer;
  const done = collectAsync();
  await instance.handleEncodeImage({ id: 120, pixelData: pixels, width: IW, height: IH, mimeType: 'image/jpeg', quality: 0.9, gainMap: { plane, settings: baseSettings() } });
  const [reply] = await done();
  assert.equal(reply.message.code, 'unsupported');
  assert.equal(reply.message.returned.pixels, pixels);
  assert.equal(reply.message.returned.plane, plane);
  assert.deepEqual(reply.transfers, [pixels, plane]);
}

{
  // getContext('2d') null: unsupported too.
  globalThis.OffscreenCanvas = StubOffscreenCanvas;
  StubOffscreenCanvas.noContext = true;
  const instance = await import('./exportWorker.js?no-context');
  const done = collectAsync();
  await instance.handleEncodeImage({ id: 121, pixelData: plane8Of(makePlane16()).buffer, width: IW, height: IH, mimeType: 'image/png' });
  assert.equal((await done())[0].message.code, 'unsupported');
  StubOffscreenCanvas.noContext = false;
}

{
  const instance = await import('./exportWorker.js?offscreen');
  // Non-opaque frames stay on the main thread.
  const translucent = plane8Of(makePlane16());
  translucent[7] = 128;
  let done = collectAsync();
  await instance.handleEncodeImage({ id: 122, pixelData: translucent.buffer, width: IW, height: IH, mimeType: 'image/png' });
  let [reply] = await done();
  assert.equal(reply.message.code, 'unsupported-alpha');
  assert.equal(reply.message.returned.pixels, translucent.buffer);

  // PNG8: the frame's own bytes reach the encoder; the canvas is CPU-backed
  // and released afterwards.
  const frame = plane8Of(makePlane16(5));
  canvases.length = 0;
  done = collectAsync();
  await instance.handleEncodeImage({ id: 123, pixelData: frame.slice().buffer, width: IW, height: IH, mimeType: 'image/png' });
  [reply] = await done();
  assert.equal(reply.message.type, 'imageResult');
  assert.equal(reply.message.gain, null);
  const png = await encodedPixels(reply.message.blob);
  assert.equal(png.type, 'image/png');
  assert.equal(png.quality, 'undefined', 'PNG passes no quality');
  sameArray(png.pixels, frame, 'PNG8 pixels');
  assert.deepEqual(canvases[0].contextOptions, { willReadFrequently: true });
  assert.equal(canvases[0].width, 0, 'the backing store is released after the encode');

  // JPEG with the gain map in the same request: the map equals the table map
  // of the SDR frame against the adjusted plane, encoded at 0.85.
  for (const [name, settings] of Object.entries(recipes)) {
    const sdrPlane = makePlane16(23);
    const sdr = plane8Of(sdrPlane);
    const unadjusted = makePlane16(29);
    const params = computeAdjustmentParams(settings, { width: IW, height: IH });
    const adjusted = new Uint16Array(unadjusted.length);
    applyAdjustmentsToPixels16(unadjusted, adjusted, IW * IH, params, 'full', null, 500000, null);
    const expectedMap = computeGainMap({ width: IW, height: IH, data: sdr }, { width: IW, height: IH, data: adjusted });
    done = collectAsync();
    await instance.handleEncodeImage({ id: 124, pixelData: sdr.slice().buffer, width: IW, height: IH, mimeType: 'image/jpeg', quality: 0.92, gainMap: { plane: unadjusted.slice().buffer, settings: structuredClone(settings) } });
    const replies = (await done()).filter((p) => p.message.type !== 'progress');
    assert.equal(replies.length, 1);
    const result = replies[0].message;
    assert.equal(result.type, 'imageResult', `${name}: ${result.message || ''}`);
    const primary = await encodedPixels(result.blob);
    assert.equal(primary.quality, '0.92');
    sameArray(primary.pixels, sdr, `${name}: SDR pixels`);
    assert.ok(Object.is(result.gain.gainMax, expectedMap.gainMax), `${name}: gainMax`);
    assert.equal(result.gain.gainMin, expectedMap.gainMin);
    const gain = await encodedPixels(result.gain.blob);
    assert.equal(gain.type, 'image/jpeg');
    assert.equal(gain.quality, '0.85');
    sameArray(gain.pixels, expectedMap.data, `${name}: gain-map pixels`);
  }

  // An already adjusted plane (settings null) is used as it is.
  {
    const sdr = plane8Of(makePlane16(31));
    const high = makePlane16(37);
    const expectedMap = computeGainMap({ width: IW, height: IH, data: sdr }, { width: IW, height: IH, data: high });
    done = collectAsync();
    await instance.handleEncodeImage({ id: 125, pixelData: sdr.slice().buffer, width: IW, height: IH, mimeType: 'image/jpeg', quality: 0.9, gainMap: { plane: high.slice().buffer, settings: null } });
    const result = (await done()).find((p) => p.message.type !== 'progress').message;
    sameArray((await encodedPixels(result.gain.blob)).pixels, expectedMap.data, 'adjusted plane map');
  }

  // A failure after the plane was written returns only the SDR pixels.
  {
    const original = StubOffscreenCanvas.prototype.convertToBlob;
    let calls = 0;
    StubOffscreenCanvas.prototype.convertToBlob = async function (options) {
      if (++calls === 2) throw new Error('map encode failed');
      return original.call(this, options);
    };
    try {
      const sdr = plane8Of(makePlane16()).buffer;
      const plane = makePlane16().buffer;
      done = collectAsync();
      await instance.handleEncodeImage({ id: 126, pixelData: sdr, width: IW, height: IH, mimeType: 'image/jpeg', quality: 0.9, gainMap: { plane, settings: recipes.separable } });
      const reply2 = (await done()).find((p) => p.message.type !== 'progress').message;
      assert.equal(reply2.type, 'error');
      assert.equal(reply2.returned.pixels, sdr);
      assert.equal(reply2.returned.plane, undefined, 'a written plane is never handed back');
    } finally {
      StubOffscreenCanvas.prototype.convertToBlob = original;
    }
  }
  delete globalThis.OffscreenCanvas;
}

console.log('exportWorker.test.mjs: in-place handlers, adjust16AndEncode, owned TIFF strip and encodeImage verified');

