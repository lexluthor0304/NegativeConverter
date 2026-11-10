import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDustWorkerProcessor, summarizeDustMask } from './dustWorkerProcessor.js';
import { murmurHash3x86_128 } from '../app/contentHash.js';
import {
  detectDust, inpaintMasked, rgbaToGrayInto, updateDustStrength,
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
  const after = await tagged({ type: 'stroke', id: ++id, width, height, reuseSource: true,
    baseTag: 102, tag: 104, points: [{ x: 60, y: 60 }], brushRadius: 3, mode: 'direct' });
  assert.ok(after.payload.patch, 'an empty stroke keeps the mask tag');
}

// #254 B: detection and strokes return the display tint, pooled from the mask
// (a detection's whole tint; a stroke's cells over the rect it changed).
{
  const { buildDustTint, buildDustTintRect } = await import('../app/dustTint.js');
  const tinted = createDustWorkerProcessor();
  const tint = { width: 97, height: 73 };
  const { payload: detected, transfers: detectTransfers } = await tinted({ type: 'detect', id: 1, width, height, reuseSource: false,
    rgba: source.data.slice(), strength: 5, maskTag: 1, pinned: true, tint });
  assert.equal(detectTransfers.length, 2, 'mask and tint are transferred');
  assert.deepEqual([detected.tint.width, detected.tint.height], [97, 73]);
  assert.deepEqual(detected.tint.rgba, buildDustTint(detected.mask, width, height, 97, 73));
  const current = detected.mask.slice();
  const { payload: stroked } = await tinted({ type: 'stroke', id: 2, width, height, reuseSource: true, baseTag: 1, tag: 2,
    points: [{ x: 60, y: 60 }], brushRadius: 4, mode: 'direct', radius: 3, tint });
  const { patch } = stroked;
  for (let row = 0; row < patch.maskRect.height; row++) {
    current.set(patch.maskBytes.subarray(row * patch.maskRect.width, (row + 1) * patch.maskRect.width),
      (patch.maskRect.y + row) * width + patch.maskRect.x);
  }
  const expected = buildDustTintRect(current, width, height, 97, 73, patch.maskRect);
  assert.deepEqual({ ...patch.tint, rgba: [...patch.tint.rgba] }, { ...expected, rgba: [...expected.rgba], tintWidth: 97, tintHeight: 73 });
  // No tint asked for (or one larger than the frame): none sent.
  const plain = await tinted({ type: 'detect', id: 3, width, height, reuseSource: true, strength: 5, tint: { width: width + 1, height: 10 } });
  assert.equal(plain.payload.tint, null);
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
{
  // The grey the dust detector feeds the morphology is cv.cvtColor's, byte for
  // byte, for aligned and unaligned RGBA (every R, G and B value is met).
  const n = 256 * 64;
  const backing = new Uint8ClampedArray(n * 4 + 4);
  for (const offset of [0, 1]) {
    const rgba = backing.subarray(offset, offset + n * 4);
    for (let p = 0; p < n; p++) {
      rgba[p * 4] = p & 255; rgba[p * 4 + 1] = (p * 37 + (p >> 8)) & 255;
      rgba[p * 4 + 2] = (p * 101 + 7 * (p >> 8)) & 255; rgba[p * 4 + 3] = (p * 13) & 255;
    }
    const src = cv.matFromImageData({ data: rgba, width: 256, height: 64 });
    const expected = new cv.Mat();
    try {
      cv.cvtColor(src, expected, cv.COLOR_RGBA2GRAY);
      assert.deepEqual(rgbaToGrayInto(rgba, new Uint8Array(n), n), new Uint8Array(expected.data), `grey equals cv.cvtColor at offset ${offset}`);
    } finally { src.delete(); expected.delete(); }
  }
}
{
  // A detection keeps its candidates: a lower sensitivity only selects among
  // them and gives the mask a fresh detection gives; a higher one, or another
  // polarity, detects again. The worker does the same with the state it holds.
  const first = detectDust(source, { strength: 8 });
  assert.ok(first._state.records instanceof Float64Array && first._state.strength === 8);
  for (const strength of [1, 2, 4.5, 5, 8]) {
    const fresh = detectDust(source, { strength });
    const reused = updateDustStrength(source, first._state, strength);
    assert.equal(reused._state, first._state, `strength ${strength} is answered from the state`);
    assert.deepEqual(reused.mask, fresh.mask, `the state gives the fresh mask at strength ${strength}`);
    assert.equal(reused.particleCount, fresh.particleCount);
  }
  const higher = updateDustStrength(source, first._state, 10);
  assert.notEqual(higher._state, first._state, 'a higher sensitivity detects again');
  assert.deepEqual(higher.mask, detectDust(source, { strength: 10 }).mask);

  const stateful = createDustWorkerProcessor();
  const request = (strength, polarity, reuseSource) => stateful({ type: 'detect', id: ++id, width, height, reuseSource,
    ...(reuseSource ? {} : { rgba: source.data.slice() }), strength, ...(polarity ? { polarity } : {}) });
  let reuse = false;
  for (const [strength, polarity] of [[5, undefined], [3, undefined], [9, undefined], [9, 'dark'], [4, 'dark'], [4, 'bright']]) {
    const { payload } = await request(strength, polarity, reuse);
    reuse = true;
    const direct = detectDust(source, { strength, polarity });
    assert.deepEqual(payload.mask, direct.mask, `worker mask at strength ${strength}, ${polarity || 'default'} polarity`);
    assert.equal(payload.particleCount, direct.particleCount);
  }
  // The specks of this frame are bright: a positive's detection leaves them.
  assert.equal(detectDust(source, { strength: 5, polarity: 'dark' }).mask.some(Boolean), false);
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
