import assert from 'node:assert/strict';
import { createStudioThumbnail } from './studioSettings.js';

// The per-pixel sampler as it was at 1703835, kept as the parity reference
// for the word-copy fast path.
function referenceThumbnail(imageData, maxSize = 144) {
  const scale = Math.min(1, maxSize / Math.max(imageData.width, imageData.height));
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.min(imageData.height - 1, Math.floor(y / scale)) * imageData.width
        + Math.min(imageData.width - 1, Math.floor(x / scale))) * 4;
      data.set(imageData.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

let seed = 0x2345;
const random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 | 0) >>> 0) / 2 ** 32;
function image(width, height, Type = Uint8ClampedArray, offset = 0) {
  const length = width * height * 4;
  const buffer = new ArrayBuffer((offset + length) * Type.BYTES_PER_ELEMENT);
  const data = new Type(buffer, offset * Type.BYTES_PER_ELEMENT, length);
  const range = Type === Uint16Array ? 65536 : 256;
  for (let i = 0; i < length; i++) data[i] = Math.floor(random() * range);
  return { width, height, data };
}
function assertSame(source, maxSize, label) {
  const expected = referenceThumbnail(source, maxSize);
  const actual = createStudioThumbnail(source, maxSize);
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(actual.data instanceof Uint8ClampedArray, `${label}: output type`);
  assert.deepEqual(Buffer.from(actual.data.buffer), Buffer.from(expected.data.buffer), `${label}: bytes`);
}

const sizes = [[1, 1], [2, 1], [1, 2], [3, 5], [7, 3], [143, 97], [144, 144], [145, 96], [289, 191],
  [600, 401], [401, 600], [1, 1000], [1000, 1], [2, 1537], [1537, 3], [1201, 799], [2458, 1626]];
for (const [width, height] of sizes) {
  const source = image(width, height);
  for (const maxSize of [1, 2, 3, 144, 1200, 5000]) assertSame(source, maxSize, `${width}x${height}@${maxSize}`);
}
// Uint8Array data (8-bit, other view type), an aligned non-zero byteOffset and
// trailing slack beyond width * height * 4 take the fast path too.
for (const [width, height] of [[5, 3], [300, 211]]) {
  const plain = image(width, height, Uint8Array);
  assertSame(plain, 144, `Uint8Array ${width}x${height}`);
  const aligned = image(width, height, Uint8ClampedArray, 8);
  assert.equal(aligned.data.byteOffset % 4, 0);
  assertSame(aligned, 144, `aligned offset ${width}x${height}`);
  const slack = image(width, height);
  const longer = new Uint8ClampedArray(slack.data.length + 12);
  longer.set(slack.data);
  assertSame({ width, height, data: longer }, 144, `trailing slack ${width}x${height}`);
}
// Fallbacks keep the per-pixel loop: an unaligned view and non-8-bit data.
for (const [width, height] of [[1, 1], [5, 3], [300, 211]]) {
  const unaligned = image(width, height, Uint8ClampedArray, 1);
  assert.notEqual(unaligned.data.byteOffset % 4, 0);
  assertSame(unaligned, 144, `unaligned ${width}x${height}`);
  assertSame(unaligned, 1200, `unaligned ${width}x${height}@1200`);
  assertSame(image(width, height, Uint16Array), 144, `Uint16Array ${width}x${height}`);
  assertSame(image(width, height, Float32Array), 144, `Float32Array ${width}x${height}`);
}

// 1200 px presentation proxy from a 12 MP frame (the largest this suite may
// allocate). The sampler touches output pixels only, so a 60 MP frame differs
// just by source-row cache misses.
const large = image(4243, 2828);
const timings = [];
for (let run = 0; run < 9; run++) {
  const start = performance.now();
  createStudioThumbnail(large, 1200);
  timings.push(performance.now() - start);
}
const referenceStart = performance.now();
const reference = referenceThumbnail(large, 1200);
const referenceMs = performance.now() - referenceStart;
assert.deepEqual(Buffer.from(createStudioThumbnail(large, 1200).data.buffer), Buffer.from(reference.data.buffer));
timings.sort((a, b) => a - b);
assert.ok(timings[0] <= 5, `1200 px proxy sampling took ${timings[0].toFixed(2)} ms`);
console.log(`studioThumbnail: byte-identical sampler; 12 MP -> 1200 px best ${timings[0].toFixed(2)} ms, `
  + `median ${timings[4].toFixed(2)} ms (reference loop ${referenceMs.toFixed(1)} ms)`);
