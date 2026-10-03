import assert from 'node:assert/strict';
import { createDustHistoryArchive } from './dustHistoryArchive.js';
import { archiveDatabaseFixture } from './dustHistoryArchiveHarness.mjs';
import { applyStrokePatch, applyDustDelta, amendDustDelta } from './dustStrokeHistory.js';

class TestImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
}
const image = seed => {
  const frame = new TestImageData(Uint8ClampedArray.from({ length: 64 }, (_, i) => (i * 17 + seed) % 256), 4, 4);
  frame.__image16 = { width: 4, height: 4, data: Uint16Array.from(frame.data, (v, i) => v * 257 + i % 255) };
  return frame;
};
const pixels = target => ({ rgba8: [...target.data], rgba16: [...target.__image16.data] });
const target = image(7), cleanSource = image(5), mask = new Uint8Array(16);
const before = pixels(target);
function stroke(x, value, countBefore) {
  const rect = { x, y: 1, width: 1, height: 1 };
  return applyStrokePatch(target, mask, {
    rect, maskRect: rect, rgba8: new Uint8ClampedArray(4).fill(value), rgba16: new Uint16Array(4).fill(value * 257),
    maskBytes: Uint8Array.of(255), particleCount: countBefore + 1
  }, { cleanSource, countBefore, tagBefore: countBefore, tagAfter: countBefore + 1 });
}
const one = stroke(1, 30, 0);
amendDustDelta(one, { x: 0, y: 0, width: 1, height: 1 }, () => { target.data[0] = 90; target.__image16.data[0] = 23145; });
const afterOne = pixels(target);
const two = stroke(2, 40, 1), afterTwo = pixels(target);
const db = archiveDatabaseFixture();
const archive = createDustHistoryArchive({ indexedDB: db.indexedDB, ImageDataCtor: TestImageData, chunkBytes: 16 });
const key = await archive.save({ deltas: [one, two], target, cleanSource, mask, refs: { processedImageData: target } });
const restored = await archive.load(key);
assert.ok([...db.records.values()].filter(ArrayBuffer.isView).every(chunk => chunk.byteLength <= 16), 'writes are bounded chunks');
assert.ok(restored.target instanceof TestImageData);
assert.notEqual(restored.target, target, 'the record owns bytes independently of live planes');
assert.equal(restored.deltas[0].target, restored.target);
assert.equal(restored.deltas[1].target, restored.target);
assert.equal(restored.refs.processedImageData, restored.target);
assert.equal(restored.deltas[0].cleanSource, restored.cleanSource);
assert.equal(restored.deltas[1].mask, restored.mask);
assert.deepEqual(pixels(restored.target), afterTwo, '16-bit and 8-bit current pixels survive');
assert.deepEqual(pixels(restored.cleanSource), pixels(cleanSource));
applyDustDelta(restored.deltas[1], 'undo');
assert.deepEqual(pixels(restored.target), afterOne);
applyDustDelta(restored.deltas[0], 'undo');
assert.deepEqual(pixels(restored.target), before, 'including the learned-repair amendment');
assert.deepEqual([...restored.mask], new Array(16).fill(0));
applyDustDelta(restored.deltas[0], 'redo');
assert.deepEqual(pixels(restored.target), afterOne);
applyDustDelta(restored.deltas[1], 'redo');
assert.deepEqual(pixels(restored.target), afterTwo);
for (const failure of ['open', 'write']) {
  const failing = archiveDatabaseFixture(); failing.failures[failure] = true;
  const store = createDustHistoryArchive({ indexedDB: failing.indexedDB });
  await assert.rejects(store.save({ target }), /Storage denied|Quota exceeded/);
  assert.equal(failing.records.size, 0, 'a failed write cannot appear committed');
  assert.deepEqual(pixels(target), afterTwo, 'failed storage cannot mutate a live plane');
}
{
  const failing = archiveDatabaseFixture(); failing.failures.writeAt = 3;
  const store = createDustHistoryArchive({ indexedDB: failing.indexedDB, chunkBytes: 16 });
  await assert.rejects(store.save({ target }), /Quota exceeded/);
  assert.equal(failing.records.size, 0, 'partial chunks are rolled back before a failed save returns');
}
{
  const base = image(11);
  const saved = await archive.save({ base, alias: base, target }, { base });
  const hydrated = await archive.load(saved, { base });
  assert.equal(hydrated.base, base, 'a kept base is an external reference, never another persisted full plane');
  assert.equal(hydrated.alias, base);
  await archive.remove(saved);
}
db.failures.read = true;
await assert.rejects(archive.load(key), /Storage read failed/);
assert.ok(db.records.has(key), 'read failure retains the record for retry');
db.failures.read = false;
await archive.remove(key);
await assert.rejects(archive.load(key), /missing/);
console.log('dustHistoryArchive: exact aliased 8/16-bit undo/redo, amendments, atomic write failure and retry passed');
