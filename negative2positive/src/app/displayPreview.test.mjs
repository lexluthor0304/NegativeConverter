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

// #259: after a dust patch, recomputing only the preview pixels whose taps
// fall in the patched rect equals rebuilding the whole preview.
{
  const { updateDisplayPreviewRect } = await import('./displayPreview.js');
  const reference = (image, target) => {
    // The implementation before the rect update was factored out (1703835).
    const output = new ImageData(target.width, target.height);
    const source16 = image.__image16?.data;
    const source = source16 || image.data;
    const data = source16 ? new Uint16Array(target.width * target.height * 4) : output.data;
    const sx = image.width / target.width, sy = image.height / target.height;
    for (let y = 0; y < target.height; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.floor(fy), y1 = Math.min(image.height - 1, y0 + 1), dy = fy - y0;
      for (let x = 0; x < target.width; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.floor(fx), x1 = Math.min(image.width - 1, x0 + 1), dx = fx - x0;
        const a = (y0 * image.width + x0) * 4, b = (y0 * image.width + x1) * 4;
        const c = (y1 * image.width + x0) * 4, d = (y1 * image.width + x1) * 4;
        const dest = (y * target.width + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top = source[a + ch] + (source[b + ch] - source[a + ch]) * dx;
          const bottom = source[c + ch] + (source[d + ch] - source[c + ch]) * dx;
          data[dest + ch] = Math.round(top + (bottom - top) * dy);
          if (source16) output.data[dest + ch] = Math.round(data[dest + ch] / 257);
        }
      }
    }
    if (source16) output.__image16 = { width: target.width, height: target.height, data };
    return output;
  };
  let seed = 5;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (const [w, h, pw, ph, wide] of [[97, 61, 40, 25, true], [300, 200, 173, 111, false], [64, 64, 63, 1, true], [50, 40, 50, 40, false]]) {
    const image = new ImageData(w, h);
    for (let i = 0; i < image.data.length; i++) image.data[i] = next() >>> 24;
    if (wide) image.__image16 = { width: w, height: h, data: Uint16Array.from(image.data, v => v * 257 + (next() >>> 25)) };
    const preview = resizeDisplayPreview(image, { width: pw, height: ph });
    const expectedBefore = reference(image, { width: pw, height: ph });
    if (preview !== image) {
      assert.deepEqual(preview.data, expectedBefore.data, 'refactored resize is unchanged');
      if (wide) assert.deepEqual(preview.__image16.data, expectedBefore.__image16.data);
    }
    for (let n = 0; n < 12; n++) {
      const rect = { x: next() % w, y: next() % h, width: 1 + next() % 9, height: 1 + next() % 9 };
      rect.width = Math.min(rect.width, w - rect.x); rect.height = Math.min(rect.height, h - rect.y);
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          image.data[i + c] = next() >>> 24;
          if (wide) image.__image16.data[i + c] = image.data[i + c] * 257;
        }
      }
      const dirty = updateDisplayPreviewRect(image, preview, rect);
      const expected = reference(image, { width: pw, height: ph });
      if (preview === image) { assert.deepEqual(dirty, rect); continue; }
      assert.ok(!dirty || dirty.width <= Math.ceil(rect.width * pw / w) + 2, 'only a small preview rect is rewritten');
      assert.deepEqual(preview.data, expected.data, `8-bit preview after patch ${n}`);
      if (wide) assert.deepEqual(preview.__image16.data, expected.__image16.data, `16-bit preview after patch ${n}`);
    }
  }
  console.log('displayPreview: dirty-rect updates equal a full resize');
}
