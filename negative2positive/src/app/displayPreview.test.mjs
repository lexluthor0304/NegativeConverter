import assert from 'node:assert/strict';
import { displayPreviewSize, resizeDisplayPreview } from './displayPreview.js';
globalThis.ImageData = class {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
};
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800 }), { width: 1200, height: 800 });
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800, dpr: 2 }), { width: 2400, height: 1600 });
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800, zoom: 2 }), { width: 2400, height: 1600 });
assert.deepEqual(displayPreviewSize(4000, 6000, { viewportWidth: 360, viewportHeight: 600, dpr: 2 }), { width: 720, height: 1080 });
assert.deepEqual(displayPreviewSize(100, 60, { dpr: 3, zoom: 10 }), { width: 100, height: 60 });
for (const dpr of [1, 2, 3]) for (const zoom of [1, 2, 8]) {
  const result = displayPreviewSize(12000, 8000, { viewportWidth: 7680, viewportHeight: 4320, dpr, zoom, maxDimension: 2048 });
  assert.ok(result.width <= 2048 && result.height <= 2048 && result.width * result.height <= 4_000_000);
}
const source = new ImageData(2, 2);
source.data.set([0, 0, 0, 0, 100, 100, 100, 100, 200, 200, 200, 200, 240, 240, 240, 240]);
assert.equal(resizeDisplayPreview(source, { width: 2, height: 2 }), source);
assert.deepEqual([...resizeDisplayPreview(source, { width: 1, height: 1 }).data], [135, 135, 135, 135]);
source.__image16 = { width: 2, height: 2, data: new Uint16Array([1, 11, 21, 65535, 101, 111, 121, 65535, 201, 211, 221, 65535, 301, 311, 321, 65535]) };
const before = source.__image16.data.slice();
const resized = resizeDisplayPreview(source, { width: 1, height: 1 });
assert.deepEqual([...resized.__image16.data], [151, 161, 171, 65535]);
assert.deepEqual([...resized.data], [1, 1, 1, 255]);
assert.deepEqual(source.__image16.data, before);
console.log('displayPreview: DPR・拡大・メモリ上限・16bit 補間・入力不変を検証');
