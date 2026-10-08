import assert from 'node:assert/strict';
import { cloneImageDataChunked } from './aiInpaint.js';

const saved = Object.fromEntries(['document', 'scheduler', 'ImageData', 'setTimeout', 'MessageChannel'].map(key => [key, globalThis[key]]));
let timers = 0, tasks = 0;
try {
  globalThis.document = { visibilityState: 'hidden' };
  globalThis.scheduler = undefined;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.setTimeout = (...args) => { timers++; return saved.setTimeout(...args); };
  globalThis.MessageChannel = class extends saved.MessageChannel {
    constructor() { super(); tasks++; }
  };
  const image = new ImageData(Uint8ClampedArray.from({ length: 64 }, (_, i) => i * 3), 4, 4);
  image.__image16 = { width: 4, height: 4, data: Uint16Array.from({ length: 64 }, (_, i) => i * 997) };
  let checks = 0;
  const copy = await cloneImageDataChunked(image, { chunkBytes: 16, check: () => checks++ });
  assert.equal(tasks, 10, '3 RGBA8 and 7 RGBA16 task boundaries');
  assert.equal(checks, tasks, 'cancellation is checked after each yield');
  assert.equal(timers, 0, 'hidden WebKit copies never yield on DOM timers');
  assert.deepEqual(copy.data, image.data);
  assert.deepEqual(copy.__image16.data, image.__image16.data);
  assert.notEqual(copy.data.buffer, image.data.buffer);
  assert.notEqual(copy.__image16.data.buffer, image.__image16.data.buffer);
  await assert.rejects(cloneImageDataChunked(image, { chunkBytes: 16, check() { throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
} finally {
  Object.assign(globalThis, saved);
}
console.log('aiInpaintYield: hidden copies yield through MessageChannel, preserve both planes and remain cancellable');
