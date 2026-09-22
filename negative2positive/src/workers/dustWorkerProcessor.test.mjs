import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDustWorkerProcessor } from './dustWorkerProcessor.js';
import {
  buildBinaryIntegralImage, detectDust, inpaintMasked,
  refineMaskIntelligent, refineMaskDirect, refineMaskRemove
} from '../silvercore/engine/DustRemoval.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');

const width = 256, height = 192, data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const p = (y * width + x) * 4;
  data[p] = data[p + 1] = data[p + 2] = 80 + (x % 20); data[p + 3] = 255;
}
for (let y = 90; y < 93; y++) for (let x = 125; x < 128; x++) {
  const p = (y * width + x) * 4; data[p] = data[p + 1] = data[p + 2] = 250;
}
const source = new ImageData(data, width, height);
source.__image16 = { width, height, data: Uint16Array.from(data, (v, i) => v * 257 - i % 5) };
const worker = createDustWorkerProcessor();
let id = 0;
for (const strength of [1, 3, 5, 10]) {
  const direct = detectDust(source, { strength });
  const { payload } = await worker({ type: 'detect', id: ++id, width, height,
    reuseSource: id > 1, rgba: source.data.slice(), strength });
  assert.deepEqual(payload.mask, direct.mask, `worker mask equals direct detector at strength ${strength}`);
  assert.equal(payload.particleCount, direct.particleCount);
}
const mask = detectDust(source, { strength: 5 }).mask;
const directRepair = inpaintMasked(source, mask, 3);
const { payload, transfers } = await worker({ type: 'inpaint', id: ++id, width, height,
  reuseSource: true, image16: source.__image16.data.slice(), mask, radius: 3 });
assert.deepEqual(payload.image.data, directRepair.data);
assert.deepEqual(payload.image.image16, directRepair.__image16.data, 'unmasked 16-bit precision is unchanged');
assert.equal(transfers.length, 2);
const brush = new Uint8Array(width * height);
for (let y = 89; y < 95; y++) for (let x = 124; x < 130; x++) brush[y * width + x] = 255;
for (const mode of ['intelligent', 'direct', 'remove']) {
  const expectedMask = mode === 'intelligent' ? refineMaskIntelligent(source, mask, brush)
    : mode === 'direct' ? refineMaskDirect(mask, brush) : refineMaskRemove(mask, brush);
  const expected = inpaintMasked(source, expectedMask, 3);
  const { payload: refined } = await worker({ type: 'refine', id: ++id, width, height,
    reuseSource: true, mask, brushMask: brush, mode, radius: 3 });
  assert.deepEqual(refined.mask, expectedMask, `${mode} brush mask is unchanged`);
  assert.deepEqual(refined.image.data, expected.data);
  assert.deepEqual(refined.image.image16, expected.__image16.data);
  assert.ok(Number.isInteger(refined.particleCount));
}

// Source A/B/A requests may all arrive while OpenCV starts. Their cache and
// morphology must still change in request order, without crossing photographs.
let ready;
const gate = new Promise(resolve => { ready = resolve; });
const queued = createDustWorkerProcessor({ loadCv: () => gate });
const blank = new Uint8ClampedArray(width * height * 4).fill(128);
const requests = [data, blank, data].map((rgba, index) => queued({ type: 'detect', id: index,
  width, height, reuseSource: false, rgba: rgba.slice(), strength: 5 }));
ready();
const results = await Promise.all(requests);
assert.deepEqual(results[0].payload.mask, mask);
assert.equal(results[1].payload.mask.some(Boolean), false);
assert.deepEqual(results[2].payload.mask, mask);
const bin = Uint8Array.from({ length: 53 * 41 }, (_, i) => i % 7 === 0 ? 255 : 0);
const prefix = buildBinaryIntegralImage(bin, 53, 41);
assert.ok(prefix instanceof Uint32Array);
assert.equal(prefix.byteLength, 54 * 42 * 4);
for (let y = 0; y <= 41; y++) for (let x = 0; x <= 53; x++) {
  let expected = 0;
  for (let yy = 0; yy < y; yy++) for (let xx = 0; xx < x; xx++) expected += bin[yy * 53 + xx] > 0;
  assert.equal(prefix[y * 54 + x], expected, 'integer prefix counts are exact');
}
await assert.rejects(createDustWorkerProcessor()({ type: 'detect', width, height, reuseSource: true }), /Missing/);
console.log('Dust worker output equals direct OpenCV masks and 8/16-bit repair; prefix memory halved');
