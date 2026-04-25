// Standalone Node test for image16.js — run with: node image16.test.mjs
// No vitest / jest dependency; uses bare assertions to keep CI surface minimal.

import assert from 'node:assert/strict';
import {
  IMAGE16_MAX,
  createImage16,
  wrapImage16,
  fromImageData8,
  toRGBA8,
  cloneImage16,
  packRGBToImage16,
} from './image16.js';

function makeImageData8(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) data.set(fill.length === data.length ? fill : new Uint8ClampedArray(data.length).map((_, i) => fill[i % fill.length]));
  return { width, height, data };
}

// 1. createImage16 produces zeros
{
  const img = createImage16(4, 3);
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.equal(img.data.length, 4 * 3 * 4);
  assert.equal(img.data[0], 0);
  assert.ok(img.data instanceof Uint16Array);
}

// 2. fromImageData8 ×257 upscale
{
  const src = makeImageData8(2, 1, [0, 128, 255, 255, 1, 254, 200, 100]);
  const img = fromImageData8(src);
  assert.equal(img.data[0], 0);            // 0 × 257
  assert.equal(img.data[1], 128 * 257);    // 32896
  assert.equal(img.data[2], 65535);        // 255 × 257
  assert.equal(img.data[3], 65535);        // alpha
  assert.equal(img.data[4], 257);          // 1 × 257
  assert.equal(img.data[5], 254 * 257);    // 65278
  assert.equal(img.data[6], 200 * 257);    // 51400
  assert.equal(img.data[7], 100 * 257);    // 25700
}

// 3. fromImageData8 → toRGBA8 round-trip is lossless for any 8-bit input
{
  const src = makeImageData8(8, 8);
  for (let i = 0; i < src.data.length; i++) src.data[i] = (i * 7) & 0xff;
  const up = fromImageData8(src);
  const back = toRGBA8(up);
  for (let i = 0; i < src.data.length; i++) {
    assert.equal(back.data[i], src.data[i], `round-trip mismatch at ${i}: ${src.data[i]} → ${up.data[i]} → ${back.data[i]}`);
  }
}

// 4. Boundary values
{
  const src = makeImageData8(1, 1, [0, 0, 0, 255]);
  const up = fromImageData8(src);
  assert.equal(up.data[0], 0);
  assert.equal(up.data[3], IMAGE16_MAX);

  const src2 = makeImageData8(1, 1, [255, 255, 255, 255]);
  const up2 = fromImageData8(src2);
  assert.equal(up2.data[0], IMAGE16_MAX);
  assert.equal(up2.data[3], IMAGE16_MAX);
}

// 5. cloneImage16 deep-copies
{
  const a = createImage16(2, 2);
  a.data[0] = 12345;
  const b = cloneImage16(a);
  assert.equal(b.data[0], 12345);
  b.data[0] = 999;
  assert.equal(a.data[0], 12345);
  assert.notEqual(a.data, b.data);
}

// 6. wrapImage16 rejects mismatched length
{
  assert.throws(() => wrapImage16(2, 2, new Uint16Array(15)), /does not match/);
  assert.throws(() => wrapImage16(2, 2, new Uint8Array(16)), /Uint16Array/);
}

// 7. packRGBToImage16 RGB → RGBA pads alpha to 65535
{
  const rgb = new Uint16Array([100, 200, 300, 400, 500, 600]);
  const out = packRGBToImage16(2, 1, rgb, 3);
  assert.equal(out.data[0], 100);
  assert.equal(out.data[1], 200);
  assert.equal(out.data[2], 300);
  assert.equal(out.data[3], IMAGE16_MAX);
  assert.equal(out.data[4], 400);
  assert.equal(out.data[5], 500);
  assert.equal(out.data[6], 600);
  assert.equal(out.data[7], IMAGE16_MAX);
}

// 8. packRGBToImage16 grayscale → RGBA replicates
{
  const gray = new Uint16Array([1000, 2000]);
  const out = packRGBToImage16(2, 1, gray, 1);
  assert.equal(out.data[0], 1000);
  assert.equal(out.data[1], 1000);
  assert.equal(out.data[2], 1000);
  assert.equal(out.data[3], IMAGE16_MAX);
  assert.equal(out.data[4], 2000);
  assert.equal(out.data[5], 2000);
  assert.equal(out.data[6], 2000);
  assert.equal(out.data[7], IMAGE16_MAX);
}

// 9. packRGBToImage16 RGBA passthrough
{
  const rgba = new Uint16Array(2 * 1 * 4).fill(123);
  const out = packRGBToImage16(2, 1, rgba, 4);
  assert.equal(out.data, rgba);
  assert.equal(out.data[0], 123);
}

console.log('image16 tests: all passed');
