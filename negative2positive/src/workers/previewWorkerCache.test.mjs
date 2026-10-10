import assert from 'node:assert/strict';
import { createExportWorkerBridge } from './workerBridge.js';
import { applyPreparedAdjustmentsToBuffer } from '../app/adjustmentPipeline.js';

globalThis.ImageData = class {
  constructor(data, width, height) {
    assert.ok(data instanceof Uint8ClampedArray);
    assert.equal(data.length, width * height * 4);
    Object.assign(this, { data, width, height });
  }
};
let target;
globalThis.self = {
  postMessage(message, transfers = []) {
    const reply = structuredClone(message, { transfer: transfers });
    const worker = target;
    queueMicrotask(() => worker.onmessage?.({ data: reply }));
  }
};
await import('./exportWorker.js');
const posts = [];
class InProcessWorker {
  constructor() { target = this; }
  postMessage(message, transfers = []) {
    const data = structuredClone(message, { transfer: transfers });
    posts.push({ type: data.type, bytes: data.inputBuffer?.byteLength || 0, key: data.sourceKey });
    queueMicrotask(() => self.onmessage({ data }));
  }
  terminate() { this.onmessage = null; }
}

const bridge = createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });
const data = Uint8ClampedArray.from({ length: 64 * 48 * 4 }, (_, i) => (i * 31) % 256);
const image = new ImageData(data, 64, 48);
const original = data.slice();
const ramp = Uint8Array.from({ length: 256 }, (_, i) => i);
const recipe = { curves: { r: ramp, g: ramp, b: ramp }, wbR: 1.06, wbG: 1, wbB: 0.97,
  vibrance: 30, saturation: 12, cyan: 8, magenta: -3, yellow: 2 };
const expected = (source, settings) => {
  const frame = new ImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
  applyPreparedAdjustmentsToBuffer(source, settings, frame, { quality: 'preview' });
  return frame.data;
};

for (const cyan of [8, 20, -12, 8]) {
  const settings = { ...recipe, cyan };
  const frame = await bridge.workerApplyPreviewAdjustments(image, settings, 0);
  assert.deepEqual(frame.data, expected(image, settings), 'cached source uses the exact preview kernel');
  frame.data.fill(0); // A transferred result cannot corrupt the retained input.
}
assert.deepEqual(data, original, 'the editor buffer stays attached and unchanged');
assert.deepEqual(posts.map(p => p.bytes), [data.byteLength, 0, 0, 0], 'one pixel upload for a settings-only drag');
assert.equal(bridge.residentBytes, data.byteLength * 2, 'a cache hit still counts the worker input and output');

data[0] = 140; // An in-place dust edit invalidates the cached source.
const edited = await bridge.workerApplyPreviewAdjustments(image, recipe, 1);
assert.equal(posts.at(-1).bytes, data.byteLength);
assert.deepEqual(edited.data, expected(image, recipe));
const other = new ImageData(new Uint8ClampedArray(data.length).fill(127), 64, 48);
assert.deepEqual((await bridge.workerApplyPreviewAdjustments(other, recipe, 1)).data, expected(other, recipe));
assert.equal(posts.at(-1).bytes, data.byteLength, 'same-size photo switches upload their own pixels');

bridge.cancelWorkerRequests();
await bridge.workerApplyPreviewAdjustments(other, recipe, 1);
assert.equal(posts.at(-1).bytes, data.byteLength, 'a replacement worker is fed again');
bridge.dispose();
await assert.rejects(bridge.workerApplyPreviewAdjustments(other, recipe, 1), { name: 'AbortError' });
console.log('previewWorkerCache: exact pixels, one upload per source/revision, detached result ownership, restart and memory accounting passed');
