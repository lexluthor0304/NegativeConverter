// Standalone Node test for rawPostDecode.js - run with:
// node negative2positive/src/app/rawPostDecode.test.mjs
//
// The post-decode steps must produce exactly what the loader produced at
// 1703835 (rawResultToRgb16 → packRGBToImage16 → looksLikeBayerSnow → the
// defect pass → >>> 8 mirror), for every LibRaw result shape, while freeing
// the RGB16 source as soon as the RGBA16 plane exists — and never the source
// of a 4-channel result, which becomes the RGBA16 plane itself.
import assert from 'node:assert/strict';
import {
  runRawPostDecode,
  finishRawPostDecode,
  packRawResult,
  computeFilmStats,
  handleRawPostDecodeMessage,
  describeView,
  viewFromDescription,
  isTransferableRawData
} from './rawPostDecode.js';
import { rawResultToRgb16 } from './rawResultToRgb16.js';
import { packRGBToImage16, toRGBA8 } from '../silvercore/util/image16.js';
import { looksLikeBayerSnow } from '../silvercore/util/garbledCheck.js';
import { suppressSensorDefectsReference } from '../silvercore/util/sensorDefects.reference.mjs';
import { detectFilmType } from './filmTypeDetection.js';
import { autoDetectFilmBase } from './filmBaseDetection.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';

const hasTransfer = typeof ArrayBuffer.prototype.transfer === 'function';

// The loader's sequence at 1703835, with the frozen defect kernel.
function headSequence(result, { suppress = true } = {}) {
  const { rgb16, channels } = rawResultToRgb16(result);
  const image16 = packRGBToImage16(result.width, result.height, rgb16, channels);
  if (looksLikeBayerSnow(image16)) return { garbled: true };
  const defects = suppress ? suppressSensorDefectsReference(image16) : { repaired: 0, dead: 0, hot: 0, perChannel: [0, 0, 0] };
  return { garbled: false, rgba16: image16.data, rgba8: toRGBA8(image16).data, defects };
}

function assertSameOutcome(got, want, label) {
  assert.equal(got.garbled, want.garbled, `${label}: garbled`);
  if (want.garbled) return;
  assert.ok(got.rgba16 instanceof Uint16Array && got.rgba8 instanceof Uint8ClampedArray, `${label}: plane types`);
  assert.deepEqual(got.defects, want.defects, `${label}: defect stats`);
  assert.ok(Buffer.from(got.rgba16.buffer, got.rgba16.byteOffset, got.rgba16.byteLength)
    .equals(Buffer.from(want.rgba16.buffer, want.rgba16.byteOffset, want.rgba16.byteLength)), `${label}: RGBA16 bytes`);
  assert.ok(Buffer.from(got.rgba8.buffer).equals(Buffer.from(want.rgba8.buffer)), `${label}: RGBA8 bytes`);
}

const SHAPES = [
  { label: '16-bit RGB', channels: 3, bits: 16 },
  { label: '16-bit RGB as bytes', channels: 3, bits: 16, asBytes: true },
  { label: '16-bit RGB as odd-offset bytes', channels: 3, bits: 16, asBytes: true, byteOffset: 1 },
  { label: '16-bit RGB subarray with offset', channels: 3, bits: 16, byteOffset: 6, padding: 10 },
  { label: '16-bit RGB with trailing samples', channels: 3, bits: 16, padding: 12 },
  { label: '16-bit RGBA', channels: 4, bits: 16 },
  { label: '16-bit RGBA with offset', channels: 4, bits: 16, byteOffset: 8, padding: 4 },
  { label: '16-bit mono', channels: 1, bits: 16 },
  { label: '8-bit RGB (half-size preview)', channels: 3, bits: 8 },
  { label: '8-bit RGB, no bits field', channels: 3, bits: 8, dropBits: true },
  { label: '8-bit RGBA', channels: 4, bits: 8 },
  { label: '8-bit mono', channels: 1, bits: 8 },
];

// --- every result shape matches the 1703835 sequence -------------------------
for (const shape of SHAPES) {
  for (const [w, h] of [[48, 37], [65, 50]]) {
    const result = makeRawResult({ width: w, height: h, seed: w + h + shape.channels, ...shape });
    const want = headSequence(cloneRawResult(result));
    const got = runRawPostDecode(cloneRawResult(result), { suppressSensorDefects: true });
    assertSameOutcome(got, want, `${shape.label} ${w}x${h}`);
    if (shape.channels !== 1) assert.ok(want.defects.repaired > 0, `${shape.label}: fixture must contain repairable defects`);
    assert.equal(got.width, w);
    assert.equal(got.height, h);
    assert.equal(got.filmStats, null, 'no statistics unless requested');
  }
}

// --- suppressSensorDefects: false is honoured --------------------------------
{
  const result = makeRawResult({ width: 50, height: 40, seed: 3, channels: 3, bits: 16 });
  const got = runRawPostDecode(cloneRawResult(result), { suppressSensorDefects: false });
  assertSameOutcome(got, headSequence(cloneRawResult(result), { suppress: false }), 'no defect pass');
  assert.equal(got.defects.repaired, 0);
  assert.notDeepEqual(got.rgba16, runRawPostDecode(cloneRawResult(result)).rgba16, 'the pass would have changed pixels');
}

// --- the RGB16 source is released after packing; a 4-channel source never ----
if (hasTransfer) {
  const rgb = makeRawResult({ width: 32, height: 24, seed: 5, channels: 3, bits: 16 });
  const out = runRawPostDecode(rgb);
  assert.equal(rgb.data.buffer.byteLength, 0, 'RGB16 buffer detached once the RGBA16 plane exists');
  assert.equal(out.rgba16.length, 32 * 24 * 4);

  const bytes = makeRawResult({ width: 32, height: 24, seed: 6, channels: 3, bits: 8 });
  runRawPostDecode(bytes);
  assert.equal(bytes.data.buffer.byteLength, 0, '8-bit source detached after widening');

  const rgba = makeRawResult({ width: 32, height: 24, seed: 7, channels: 4, bits: 16, byteOffset: 8, padding: 4 });
  const rgbaOut = runRawPostDecode(rgba);
  assert.ok(rgba.data.buffer.byteLength > 0, 'a 4-channel source is the RGBA16 plane and must stay attached');
  assert.equal(rgbaOut.rgba16.buffer, rgba.data.buffer);

  const kept = makeRawResult({ width: 32, height: 24, seed: 8, channels: 3, bits: 16 });
  packRawResult(kept, { releaseSource: false });
  assert.ok(kept.data.buffer.byteLength > 0, 'releaseSource: false keeps the source');
}

// --- garbled output stops before the defect pass ------------------------------
{
  const snow = makeRawResult({ width: 64, height: 64, seed: 9, channels: 3, bits: 16, snow: true });
  assert.equal(looksLikeBayerSnow(packRGBToImage16(64, 64, rawResultToRgb16(cloneRawResult(snow)).rgb16, 3)), true);
  assert.deepEqual(runRawPostDecode(cloneRawResult(snow)), { garbled: true });
}

// --- film statistics equal the main-thread computation on the returned planes -
{
  const result = makeRawResult({ width: 90, height: 60, seed: 11, channels: 3, bits: 16 });
  const out = runRawPostDecode(cloneRawResult(result), { filmStats: { borderBufferPct: 12 } });
  const imageData = { width: 90, height: 60, data: out.rgba8, __image16: { width: 90, height: 60, data: out.rgba16 } };
  assert.equal(out.filmStats.borderBufferPct, 12);
  assert.deepEqual(out.filmStats.filmType, detectFilmType(imageData));
  assert.deepEqual(out.filmStats.filmBase, autoDetectFilmBase(imageData, 12));
  assert.equal(computeFilmStats(imageData.__image16, out.rgba8, 99).borderBufferPct, 30, 'buffer normalised like the detector');
  assert.equal(computeFilmStats(imageData.__image16, out.rgba8, undefined).borderBufferPct, 10);
}

// --- resuming from a stage gives the same bytes --------------------------------
{
  const result = makeRawResult({ width: 40, height: 40, seed: 12, channels: 3, bits: 16 });
  const want = runRawPostDecode(cloneRawResult(result));
  const packed = packRawResult(cloneRawResult(result));
  assertSameOutcome(finishRawPostDecode(packed, {}, { from: 'packed' }), want, 'resume after packing');
  const repaired = packRawResult(cloneRawResult(result));
  const progress = {};
  const first = finishRawPostDecode(repaired, {}, { from: 'packed' }, progress);
  assert.equal(progress.stage, 'repaired');
  assertSameOutcome(finishRawPostDecode({ width: 40, height: 40, data: first.rgba16 }, {}, { from: 'repaired', defects: progress.defects }), want, 'resume after the defect pass');
}

// --- view descriptions survive a structured clone with transfer ---------------
{
  const backing = new Uint16Array(20);
  backing.set([1, 2, 3, 4, 5], 4);
  const view = backing.subarray(4, 9);
  const desc = describeView(view);
  const cloned = structuredClone(desc, { transfer: [desc.buffer] });
  assert.deepEqual(Array.from(viewFromDescription(cloned)), [1, 2, 3, 4, 5]);
  assert.throws(() => viewFromDescription({ kind: 'Float32Array', buffer: new ArrayBuffer(4), byteOffset: 0, length: 1 }));
  assert.equal(isTransferableRawData(new Uint16Array(4)), true);
  assert.equal(isTransferableRawData(new Uint8Array(4)), true);
  assert.equal(isTransferableRawData([1, 2, 3]), false);
  assert.equal(isTransferableRawData(new Float32Array(4)), false);
  assert.equal(isTransferableRawData(null), false);
}

// --- the worker protocol ------------------------------------------------------
function post(msg, transfer = [], afterClone = null) {
  // What postMessage does: clone, moving the transferred buffers.
  const moved = structuredClone({ msg }, { transfer }).msg;
  afterClone?.(moved); // failure injection the clone could not carry
  const replies = [];
  handleRawPostDecodeMessage(moved, (reply, replyTransfer = []) => {
    replies.push(structuredClone({ reply }, { transfer: replyTransfer }).reply);
  });
  assert.equal(replies.length, 1, 'exactly one reply per message');
  return replies[0];
}

function processMessage(result, options = {}) {
  const input = describeView(result.data);
  return [{ type: 'process', id: 7, width: result.width, height: result.height, bits: result.bits, colors: result.colors, input, options }, [input.buffer]];
}

assert.deepEqual(post({ type: 'ping', id: 3 }), { type: 'pong', id: 3 });
assert.equal(post({ type: 'bogus', id: 4 }).type, 'error');

for (const shape of [SHAPES[0], SHAPES[3], SHAPES[6], SHAPES[8]]) {
  const result = makeRawResult({ width: 41, height: 33, seed: 21, ...shape });
  const want = headSequence(cloneRawResult(result));
  const [msg, transfer] = processMessage(cloneRawResult(result), { filmStats: { borderBufferPct: 10 } });
  const reply = post(msg, transfer);
  assert.equal(reply.type, 'result');
  assert.equal(reply.id, 7);
  assertSameOutcome({
    garbled: reply.garbled,
    rgba16: viewFromDescription(reply.rgba16),
    rgba8: viewFromDescription(reply.rgba8),
    defects: reply.defects
  }, want, `worker message, ${shape.label}`);
  assert.equal(reply.filmStats.borderBufferPct, 10);
}

{
  const snow = makeRawResult({ width: 64, height: 64, seed: 9, channels: 3, bits: 16, snow: true });
  const [msg, transfer] = processMessage(snow);
  assert.deepEqual(post(msg, transfer), { type: 'result', id: 7, garbled: true });
}

// Failures hand back whatever pixels are intact, labelled with the stage.
{
  // Before packing finished: an impossible layout. The input comes back untouched.
  const bad = { width: 5, height: 5, bits: 16, colors: 3, data: new Uint16Array(7) };
  bad.data.set([1, 2, 3, 4, 5, 6, 7]);
  const [msg, transfer] = processMessage(bad);
  const reply = post(msg, transfer);
  assert.equal(reply.type, 'error');
  assert.equal(reply.stage, 'input');
  assert.equal(reply.code, 'RAW_DECODE_GARBLED');
  assert.deepEqual(Array.from(viewFromDescription(reply.input)), [1, 2, 3, 4, 5, 6, 7]);
}
{
  // After packing, before the defect pass: the RGBA16 plane comes back unrepaired.
  const result = makeRawResult({ width: 40, height: 30, seed: 31, channels: 3, bits: 16 });
  const unrepaired = headSequence(cloneRawResult(result), { suppress: false });
  const [msg, transfer] = processMessage(cloneRawResult(result));
  const reply = post(msg, transfer, (moved) => {
    moved.options = { get suppressSensorDefects() { throw new Error('defect pass failed'); } };
  });
  assert.equal(reply.stage, 'packed');
  assert.equal(reply.defects, undefined);
  assert.deepEqual(viewFromDescription(reply.rgba16), unrepaired.rgba16);
}
{
  // After the defect pass: the repaired plane and its stats come back.
  const result = makeRawResult({ width: 40, height: 30, seed: 32, channels: 3, bits: 16 });
  const want = headSequence(cloneRawResult(result));
  const [msg, transfer] = processMessage(cloneRawResult(result));
  const reply = post(msg, transfer, (moved) => {
    moved.options = { filmStats: { get borderBufferPct() { throw new Error('statistics failed'); } } };
  });
  assert.equal(reply.stage, 'repaired');
  assert.deepEqual(reply.defects, want.defects);
  assert.deepEqual(viewFromDescription(reply.rgba16), want.rgba16);
}

console.log('rawPostDecode.test.mjs passed');
