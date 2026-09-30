import assert from 'node:assert/strict';
import { serializableSample } from './analysisSampleStore.js';

// #264: a roll sample of a small base references the base's planes, which may
// be in shared memory. IndexedDB (the spill) cannot store a SharedArrayBuffer:
// the stored record holds copies with the same samples.
const shared16 = new Uint16Array(new SharedArrayBuffer(60 * 2)).map((_, i) => i * 1021);
const base = { width: 5, height: 3, data: Uint8ClampedArray.from({ length: 60 }, (_, i) => i), __image16: { width: 5, height: 3, data: shared16 } };
const sample = { ...base, __baseSize: { width: 5, height: 3 }, __tileWorking: base };
const stored = serializableSample(sample);
for (const plane of [stored.__image16.data, stored.__tileWorking.__image16.data]) {
  assert.ok(plane.buffer instanceof ArrayBuffer, 'a plain copy');
  assert.deepEqual([...plane], [...shared16]);
}
assert.equal(stored.data, base.data, 'plain planes are stored as they are');
assert.doesNotThrow(() => structuredClone(stored), 'the record is storable');
console.log('analysisSampleStore: shared planes are stored as copies');
