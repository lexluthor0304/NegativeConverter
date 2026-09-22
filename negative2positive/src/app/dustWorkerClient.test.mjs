import assert from 'node:assert/strict';
import { createDustWorkerClient } from './dustWorkerClient.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const image = new ImageData(new Uint8ClampedArray([80, 100, 120, 255]), 1, 1);
image.__image16 = { width: 1, height: 1, data: new Uint16Array([20123, 25234, 30345, 65535]) };
const workers = [];
const client = createDustWorkerClient({ workerFactory: () => {
  const worker = {
    messages: [],
    postMessage(message, transfers) { this.messages.push(structuredClone(message, { transfer: transfers })); },
    terminate() { this.terminated = true; },
    complete(message = this.messages.at(-1)) {
      this.onmessage({ data: { id: message.id, mask: new Uint8Array([255]), particleCount: 1 } });
    }
  };
  workers.push(worker); return worker;
} });
let request = client.detect(image, { strength: 3 });
assert.equal(workers[0].messages[0].image16, undefined, 'detection needs no redundant 16-bit plane');
assert.equal(workers[0].messages[0].reuseSource, false);
workers[0].complete(); await request;
request = client.detect(image, { strength: 5 });
assert.equal(workers[0].messages[1].reuseSource, true);
assert.equal(workers[0].messages[1].rgba, undefined, 'slider updates send settings only');
workers[0].complete(); await request;
const mask = new Uint8Array([255]);
request = client.inpaint(image, mask);
const repair = workers[0].messages[2];
assert.deepEqual(repair.image16, image.__image16.data);
workers[0].onmessage({ data: { id: repair.id, image: { width: 1, height: 1,
  data: image.data.slice(), image16: image.__image16.data.slice() } } });
assert.deepEqual((await request).__image16.data, image.__image16.data);
request = client.refine(image, mask, mask, 'direct');
const refined = workers[0].messages[3];
assert.equal(refined.image16, undefined, 'precision already cached by prior repair');
assert.deepEqual(refined.brushMask, mask);
workers[0].onmessage({ data: { id: refined.id, mask: mask.slice(), particleCount: 1,
  image: { width: 1, height: 1, data: image.data.slice(), image16: image.__image16.data.slice() } } });
const brushResult = await request;
assert.deepEqual(brushResult.mask, mask); assert.equal(brushResult.particleCount, 1);
assert.deepEqual(brushResult.imageData.__image16.data, image.__image16.data);
assert.equal(image.data.byteLength, 4); assert.equal(image.__image16.data.byteLength, 8); assert.equal(mask.byteLength, 1);
const a = client.detect(image), b = client.detect(image);
assert.equal(client.pendingCount, 2);
client.dispose();
await assert.rejects(a, { name: 'AbortError' }); await assert.rejects(b, { name: 'AbortError' });
assert.equal(client.pendingCount, 0); assert.equal(workers[0].terminated, true);
request = client.detect(image); assert.equal(workers[1].messages[0].reuseSource, false);
workers[1].onmessageerror(); await assert.rejects(request, /Invalid/);
assert.equal(workers[1].terminated, true);
request = client.detect(image); workers[2].onerror(); await assert.rejects(request, /crashed/);
let timedWorker;
const timed = createDustWorkerClient({ timeoutMs: 5, workerFactory: () => timedWorker = { postMessage() {}, terminate() { this.terminated = true; } } });
await assert.rejects(timed.detect(image), /timed out/); assert.equal(timedWorker.terminated, true);
let idleWorker;
const idle = createDustWorkerClient({ idleTimeoutMs: 5, workerFactory: () => idleWorker = {
  postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id, mask, particleCount: 1 } })); },
  terminate() { this.terminated = true; }
} });
await idle.detect(image); await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(idleWorker.terminated, true, 'idle OpenCV/source heap is released');
console.log('Dust worker client source reuse, precision, timeout, cancellation and cleanup passed');
