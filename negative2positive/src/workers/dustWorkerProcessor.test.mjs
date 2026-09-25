import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDustWorkerProcessor, summarizeDustMask } from './dustWorkerProcessor.js';
import { murmurHash3x86_128 } from '../app/contentHash.js';
import {
  buildBinaryIntegralImage, detectDust, inpaintMasked,
  refineMaskIntelligent, refineMaskDirect, refineMaskRemove
} from '../silvercore/engine/DustRemoval.js';
import { countMaskParticles } from '../silvercore/engine/DustBrush.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');

const width = 256, height = 192, data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const p = (y * width + x) * 4;
  data[p] = data[p + 1] = data[p + 2] = 80 + (x % 20); data[p + 3] = 255;
}
for (const [cx, cy] of [[125, 90], [40, 40], [200, 150]]) {
  for (let y = cy; y < cy + 3; y++) for (let x = cx; x < cx + 3; x++) {
    const p = (y * width + x) * 4; data[p] = data[p + 1] = data[p + 2] = 250;
  }
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
  assert.deepEqual(payload.maskInfo, summarizeDustMask(direct.mask, width, height), 'detection reports the mask summary');
}
const mask = detectDust(source, { strength: 5 }).mask;
assert.ok(mask.some(Boolean));
const directRepair = inpaintMasked(source, mask, 3);
const { payload, transfers } = await worker({ type: 'inpaint', id: ++id, width, height,
  reuseSource: true, image16: source.__image16.data.slice(), mask, radius: 3 });
assert.deepEqual(payload.image.data, directRepair.data);
assert.deepEqual(payload.image.image16, directRepair.__image16.data, 'unmasked 16-bit precision is unchanged');
assert.equal(transfers.length, 2);

// Brush strokes: only points go in; a patch sized to the touched rect comes
// back, equal to the full-frame refine + repair from the clean source.
const brushAt = (x0, y0, r) => {
  const brush = new Uint8Array(width * height);
  for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
    if (x >= 0 && y >= 0 && (x - x0) ** 2 + (y - y0) ** 2 <= r * r) brush[y * width + x] = 255;
  }
  return brush;
};
{
  const tagged = createDustWorkerProcessor();
  await tagged({ type: 'detect', id: 1, width, height, reuseSource: false, rgba: source.data.slice(),
    strength: 5, maskTag: 7, pinned: true });
  // Its 16-bit plane arrives in slices.
  const plane = source.__image16.data;
  for (let offset = 0; offset < plane.length; offset += 50000) {
    const chunk = plane.slice(offset, offset + 50000);
    const ack = await tagged({ type: 'plane', id: 2, kind: 'image16', width, height, offset,
      total: plane.length, chunk, done: offset + 50000 >= plane.length });
    assert.deepEqual(ack.payload, { id: 2 });
  }
  let current = mask.slice(), tag = 7;
  const buffer = inpaintMasked(source, current, 3);
  for (const [mode, x, y, r] of [['intelligent', 126, 91, 4], ['direct', 60, 60, 3], ['remove', 126, 91, 5], ['direct', 0, 0, 6]]) {
    const brush = brushAt(x, y, r);
    const expectedMask = mode === 'intelligent' ? refineMaskIntelligent(source, current, brush)
      : mode === 'direct' ? refineMaskDirect(current, brush) : refineMaskRemove(current, brush);
    const { payload: reply, transfers: moved } = await tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
      baseTag: tag, tag: tag + 1, points: [{ x, y }], brushRadius: r, mode, radius: 3 });
    tag++;
    const { patch } = reply;
    assert.equal(moved.length, 3, 'patch planes are transferred');
    assert.ok(patch.rect.width < width && patch.rect.height < height, 'the patch is regional');
    assert.equal(patch.rgba8.length, patch.rect.width * patch.rect.height * 4);
    for (let row = 0; row < patch.rect.height; row++) {
      const start = ((patch.rect.y + row) * width + patch.rect.x) * 4;
      buffer.data.set(patch.rgba8.subarray(row * patch.rect.width * 4, (row + 1) * patch.rect.width * 4), start);
      buffer.__image16.data.set(patch.rgba16.subarray(row * patch.rect.width * 4, (row + 1) * patch.rect.width * 4), start);
    }
    for (let row = 0; row < patch.maskRect.height; row++) {
      current.set(patch.maskBytes.subarray(row * patch.maskRect.width, (row + 1) * patch.maskRect.width),
        (patch.maskRect.y + row) * width + patch.maskRect.x);
    }
    assert.deepEqual(current, expectedMask, `${mode} stroke mask`);
    const expected = inpaintMasked(source, current, 3);
    assert.deepEqual(buffer.data, expected.data, `${mode} stroke 8-bit`);
    assert.deepEqual(buffer.__image16.data, expected.__image16.data, `${mode} stroke 16-bit`);
    assert.equal(patch.particleCount, countMaskParticles(current, width, height), `${mode} particle count`);
  }
  // Undo moves the page's mask back by the stroke's rect; the worker follows.
  const before = mask.slice();
  await tagged({ type: 'maskDelta', id: ++id, width, height, baseTag: tag, tag: 100,
    rect: { x: 0, y: 0, width, height }, bytes: before, particleCount: 3 });
  const again = await tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
    baseTag: 100, tag: 101, points: [{ x: 60, y: 60 }], brushRadius: 3, mode: 'direct' });
  assert.equal(again.payload.patch.countBefore, 3, 'the count follows the delta');
  // A delta for another mask drops the worker's copy; a stroke must re-send it.
  await tagged({ type: 'maskDelta', id: ++id, width, height, baseTag: 55, tag: 56,
    rect: { x: 0, y: 0, width: 1, height: 1 }, bytes: new Uint8Array(1) });
  await assert.rejects(tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
    baseTag: 101, tag: 102, points: [{ x: 60, y: 60 }], brushRadius: 3, mode: 'direct' }),
  (error) => error.staleMask === true);
  const reseeded = await tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
    baseTag: 101, tag: 102, mask: before.slice(), points: [{ x: 3, y: 3 }], brushRadius: 2, mode: 'remove' });
  assert.equal(reseeded.payload.patch.countBefore, countMaskParticles(before, width, height));
  // Off-frame strokes set nothing and return no patch.
  const none = await tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
    baseTag: 102, tag: 103, points: [{ x: -50, y: -50 }], brushRadius: 3, mode: 'direct' });
  assert.equal(none.payload.patch, null);
}

// Planes, including the source itself, can arrive in slices.
{
  const sliced = createDustWorkerProcessor();
  const rgba = source.data.slice();
  for (let offset = 0; offset < rgba.length; offset += 70000) {
    await sliced({ type: 'plane', id: 1, kind: 'rgba', width, height, offset, total: rgba.length,
      chunk: rgba.slice(offset, offset + 70000), done: offset + 70000 >= rgba.length });
  }
  await sliced({ type: 'plane', id: 2, kind: 'mask', width, height, offset: 0, total: mask.length,
    chunk: mask.slice(), done: true, tag: 9, particleCount: 3 });
  const reply = await sliced({ type: 'stroke', id: 3, width, height, reuseSource: true, baseTag: 9, tag: 10,
    points: [{ x: 60, y: 60 }], brushRadius: 3, mode: 'direct' });
  assert.equal(reply.payload.patch.countBefore, 3);
  assert.equal(reply.payload.patch.rgba16, null, 'no 16-bit plane was sent');
  await assert.rejects(sliced({ type: 'plane', id: 4, kind: 'image16', width, height, offset: 10, total: 20,
    chunk: new Uint16Array(10), done: true }), /out of order/);
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
{
  // Summary: content hash, and exactly the 64 px blocks holding a masked pixel.
  const sparse = new Uint8Array(200 * 130);
  sparse[5 * 200 + 7] = 255; sparse[129 * 200 + 199] = 255; sparse[70 * 200 + 64] = 1;
  const summary = summarizeDustMask(sparse, 200, 130);
  assert.equal(summary.hash, murmurHash3x86_128(sparse, 200));
  assert.deepEqual(summary.blocks, { size: 64, columns: 4, keys: Uint32Array.of(0, 5, 11) });
  const moved = sparse.slice(); moved[5 * 200 + 7] = 0; moved[5 * 200 + 8] = 255;
  assert.notEqual(summarizeDustMask(moved, 200, 130).hash, summary.hash, 'the hash follows the content');
}
await assert.rejects(createDustWorkerProcessor()({ type: 'refine', width, height, reuseSource: true }), /Unknown/);
console.log('Dust worker output equals direct OpenCV masks, 8/16-bit repair and full-frame strokes; planes arrive in slices; masks are summarised');
