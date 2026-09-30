import assert from 'node:assert/strict';
import { runRawPostDecode, handleRawPostDecodeMessage, describeView, viewFromDescription } from './rawPostDecode.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';
import { isSharedPlane, hasDerivedEightBit } from './crossOriginIsolation.js';

// #264 Part A phase 2: on a cross-origin isolated realm the post-decode pass
// builds the RGBA16 plane in shared memory, with the same samples, and posts
// it without a transfer list entry (a SharedArrayBuffer there throws).
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const options = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };
const shapes = [
  { width: 64, height: 43, seed: 1, channels: 3, bits: 16 },
  { width: 50, height: 33, seed: 2, channels: 4, bits: 16, byteOffset: 8, padding: 4 },
  { width: 60, height: 40, seed: 3, channels: 3, bits: 8 },
  { width: 45, height: 30, seed: 4, channels: 1, bits: 16 }
];

function withIsolation(isolated, run) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: isolated, configurable: true, writable: true });
  try { return run(); } finally {
    if (saved) Object.defineProperty(globalThis, 'crossOriginIsolated', saved);
    else delete globalThis.crossOriginIsolated;
  }
}

for (const spec of shapes) {
  const fixture = makeRawResult(spec);
  const plain = runRawPostDecode(cloneRawResult(fixture), options);
  assert.equal(isSharedPlane(plain.rgba16), false, 'default: a plain plane');

  const asked = withIsolation(false, () => runRawPostDecode(cloneRawResult(fixture), { ...options, sharedPlanes: true }));
  assert.equal(isSharedPlane(asked.rgba16), false, 'not isolated: plain although shared planes were asked for');
  assert.ok(same(asked.rgba16, plain.rgba16));

  const shared = withIsolation(true, () => runRawPostDecode(cloneRawResult(fixture), { ...options, sharedPlanes: true }));
  assert.equal(isSharedPlane(shared.rgba16), true, `${spec.channels}ch/${spec.bits}bit: shared when isolated`);
  assert.ok(same(shared.rgba16, plain.rgba16), 'the same RGBA16 samples');
  assert.ok(same(shared.rgba8, plain.rgba8), 'the same 8-bit mirror');
  assert.equal(shared.rgba8.buffer instanceof ArrayBuffer, true, 'the 8-bit plane stays an ArrayBuffer (ImageData)');
  assert.deepEqual(shared.defects, plain.defects);
  assert.deepEqual(shared.filmStats, plain.filmStats);
  for (let i = 0; i < shared.rgba16.length; i++) {
    if ((shared.rgba16[i] >>> 8) !== shared.rgba8[i]) assert.fail('the 8-bit plane is the 16-bit one >>> 8');
  }
}

// The worker protocol: the shared plane is described, not transferred.
{
  const fixture = makeRawResult(shapes[0]);
  const input = cloneRawResult(fixture);
  const replies = [];
  withIsolation(true, () => handleRawPostDecodeMessage({
    type: 'process', id: 3, width: input.width, height: input.height, bits: input.bits, colors: input.colors,
    input: describeView(input.data), options: { ...options, sharedPlanes: true }
  }, (message, transfer) => replies.push({ message, transfer })));
  const [{ message, transfer }] = replies;
  assert.equal(message.type, 'result');
  assert.ok(message.rgba16.buffer instanceof SharedArrayBuffer);
  assert.ok(!transfer.includes(message.rgba16.buffer), 'no shared buffer in the transfer list');
  assert.ok(transfer.includes(message.rgba8.buffer));
  // The whole reply really crosses a postMessage with that transfer list.
  const cloned = structuredClone(message, { transfer });
  const view = viewFromDescription(cloned.rgba16);
  assert.ok(isSharedPlane(view));
  assert.ok(same(view, runRawPostDecode(cloneRawResult(fixture), options).rgba16));
}

assert.equal(hasDerivedEightBit({ data: new Uint8ClampedArray(4) }), false);
console.log('rawPostDecode shared-plane tests passed');
