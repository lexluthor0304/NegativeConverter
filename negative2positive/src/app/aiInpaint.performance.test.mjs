import assert from 'node:assert/strict';
import { blendTile, createSparseBlendWeights, inpaintWithModel } from './aiInpaint.js';

globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const width = 159, height = 127;
const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 251);
const source = new ImageData(data, width, height);
source.__image16 = { width, height, data: Uint16Array.from(data, (v, i) => v * 251 + i % 251) };
const clone = () => {
  const image = new ImageData(data.slice(), width, height);
  image.__image16 = { width, height, data: source.__image16.data.slice() };
  return image;
};
const denseImage = clone(), sparseImage = clone();
const dense = new Float32Array(width * height), sparse = createSparseBlendWeights(width);
for (const [x, y] of [[0, 0], [50, 50], [31, 22], [95, 63]]) {
  const tile = { x, y, size: 64 };
  const weights = Float32Array.from({ length: 64 * 64 }, (_, i) => i % 7 ? (i % 5 + 1) / 5 : 0);
  const output = Float32Array.from({ length: 3 * 64 * 64 }, (_, i) => (i % 251) / 255);
  assert.equal(blendTile(denseImage, source, tile, output, weights, dense),
    blendTile(sparseImage, source, tile, output, weights, sparse));
}
assert.deepEqual(sparseImage.data, denseImage.data, 'overlapping tiles remain exactly equal in 8 bits');
assert.deepEqual(sparseImage.__image16.data, denseImage.__image16.data, '16-bit blending preserves exact float weights');
const large = createSparseBlendWeights(10000);
assert.equal(large.allocatedBytes, 0);
large.accept(5000 * 10000 + 5000, 1);
assert.equal(large.allocatedBytes, 64 * 64 * 4, 'a speck needs one block rather than 240 MB for a 60 MP source');

const mask = new Uint8Array(width * height); mask[0] = mask[mask.length - 1] = 255;
let calls = 0;
const controller = new AbortController();
await assert.rejects(inpaintWithModel(source, mask, async (input) => {
  calls++; controller.abort(); return input;
}, { tile: 64, signal: controller.signal }), { name: 'AbortError' });
assert.equal(calls, 1, 'superseded work never starts the next tile');
calls = 0;
await assert.rejects(inpaintWithModel(source, mask, async input => { calls++; return input; },
  { shouldContinue: () => false }), { name: 'AbortError' });
assert.equal(calls, 0);
assert.deepEqual(source.data, data, 'cancellation never mutates the source');
console.log('AI sparse overlap storage is pixel-exact; superseded tile work is cancelled');
