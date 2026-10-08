// Standalone Node test for areaResample.js - run with:
// node negative2positive/src/app/areaResample.test.mjs
import assert from 'node:assert/strict';
import { createAreaResampler, areaDownsample } from './areaResample.js';

function makeImage(width, height, seed = 1) {
  let s = seed;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s % 256; }
  return { width, height, data };
}

// Each output pixel is the plain average of its block (a naive reference).
function naive(image, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * image.height / height), y1 = Math.floor((y + 1) * image.height / height);
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * image.width / width), x1 = Math.floor((x + 1) * image.width / width);
      const sum = [0, 0, 0];
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        for (let c = 0; c < 3; c++) sum[c] += image.data[(sy * image.width + sx) * 4 + c];
      }
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 3; c++) out[(y * width + x) * 4 + c] = sum[c] / n;
      out[(y * width + x) * 4 + 3] = 255;
    }
  }
  return out;
}

for (const [w, h, tw, th] of [[97, 61, 30, 19], [64, 64, 64, 64], [200, 3, 7, 1], [123, 77, 122, 76], [40, 90, 13, 29]]) {
  const image = makeImage(w, h, w + h);
  const whole = areaDownsample(image, tw, th);
  assert.deepEqual(whole.data, naive(image, tw, th), `${w}x${h} -> ${tw}x${th}`);
  // Any split of the rows gives the same bytes.
  const sliced = createAreaResampler(image, tw, th);
  for (let y = 0; y < th; y += 3) sliced.rows(y, Math.min(th, y + 3));
  assert.deepEqual(sliced.data, whole.data, `${w}x${h}: sliced`);
}

// A one-pixel checkerboard reduced by an even factor is flat grey: the grain a
// point sample would alias averages out.
const board = { width: 64, height: 40, data: new Uint8ClampedArray(64 * 40 * 4) };
for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) {
  const v = (x + y) % 2 ? 255 : 0;
  board.data.set([v, v, v, 255], (y * 64 + x) * 4);
}
const grey = areaDownsample(board, 16, 10);
for (let i = 0; i < grey.data.length; i += 4) assert.ok(Math.abs(grey.data[i] - 127.5) <= 0.5, 'flat grey');

assert.throws(() => createAreaResampler(makeImage(10, 10), 11, 5), RangeError, 'no upscaling');
console.log('areaResample tests passed');
