import assert from 'node:assert/strict';
import { createAutoFrameWorkerClient } from './autoFrameWorkerClient.js';
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
source.__image16 = { width: 1, height: 1, data: new Uint16Array([123, 456, 789, 65535]) };
let worker, count = 0;
const analyze = createAutoFrameWorkerClient({ workerFactory: () => {
  count++;
  return worker = {
    terminate() { this.terminated = true; },
    postMessage(message, transfers) {
      assert.notEqual(message.rgba.buffer, source.data.buffer);
      assert.notEqual(message.image16.buffer, source.__image16.data.buffer);
      assert.equal(transfers.length, 2);
      queueMicrotask(() => this.onmessage({ data: { id: message.id, result: {
        angle: 0, rotatedImageData: { width: 1, height: 1, data: message.rgba, image16: message.image16 },
      } } }));
    },
  };
} });
const result = await analyze(source, {});
assert.deepEqual(result.rotatedImageData.__image16.data, source.__image16.data);
assert.equal(source.data.byteLength, 4);
await analyze(source, {});
assert.equal(count, 1);
worker.postMessage = () => queueMicrotask(() => worker.onerror());
await assert.rejects(analyze(source, {}), /crashed/);
assert.equal(worker.terminated, true);
await analyze(source, {});
assert.equal(count, 2);
let timedWorker;
const timeout = createAutoFrameWorkerClient({ timeoutMs: 10, workerFactory: () => timedWorker = {
  postMessage() {}, terminate() { this.terminated = true; },
} });
await assert.rejects(timeout(source, {}), /timed out/);
assert.equal(timedWorker.terminated, true);
console.log('autoFrameWorkerClient tests passed');
