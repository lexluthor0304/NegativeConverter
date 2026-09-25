// Standalone Node test for the batch conversion hand-off (#250 Part 4):
// - a lent source (transferred to the lane and returned) is never written:
//   it hashes the same before and after the conversion;
// - an owned source (`ownedSource`, a geometry output nothing reads again)
//   becomes the work buffer and the result is written into it, bit-identical
//   to the cloned path: colour with film-base compensation on and off, a
//   flat field, B&W and positive;
// - `releaseSlotBuffers` leaves no source, pristine or analysis plane behind.
// Run with: node negative2positive/src/pipeline/silverAdapter.ownedSource.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convertFrameWithRouter } from './conversionRouter.js';
import { inspectSlotBuffers, invalidateSilverCoreCache, releaseSlotBuffers } from './silverAdapter.js';
import { buildFlatFieldMap } from '../app/flatField.js';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const W = 53;
const H = 37;
const hash = (view) => createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');

// The 16-bit-only payload the conversion worker builds from a transferred plane.
function source16(seed = 5) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const t = x / (W - 1) * 0.6 + y / (H - 1) * 0.4;
    const noise = (next() >>> 22) - 512;
    // An orange-masked negative: dense red, thin blue, falloff towards the corners.
    const falloff = 1 - 0.25 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2);
    data[o] = Math.max(0, Math.min(65535, Math.round((52000 - t * 30000) * falloff + noise)));
    data[o + 1] = Math.max(0, Math.min(65535, Math.round((38000 - t * 24000) * falloff + noise)));
    data[o + 2] = Math.max(0, Math.min(65535, Math.round((26000 - t * 17000) * falloff + noise)));
    data[o + 3] = 65535;
  }
  return { width: W, height: H, data };
}

const flatFrame = (() => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const v = Math.round(230 - 60 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2));
    data[o] = v; data[o + 1] = v - 4; data[o + 2] = v - 9; data[o + 3] = 255;
  }
  return { width: W, height: H, data };
})();
const flatField = buildFlatFieldMap(flatFrame, { size: 8, id: 'ff-test' });
const flatFieldGeometry = { baseWidth: W, baseHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null };

const cases = [
  ['colour, film-base compensation', { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } }],
  ['colour, film-base compensation (linear)', { filmType: 'color', colorModel: 'standard', filmBase: { r: 205, g: 150, b: 95 }, filmBaseCompensation: 'linear', filmBaseStrength: 0.8 }],
  ['colour, no film base', { filmType: 'color', colorModel: 'standard' }],
  ['colour, flat field', { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, flatField, flatFieldGeometry }],
  ['colour, flat field only', { filmType: 'color', colorModel: 'standard', flatField, flatFieldGeometry }],
  ['B&W', { filmType: 'bw', filmBase: { r: 200, g: 200, b: 200 }, bwMix: 'red' }],
  ['B&W, flat field', { filmType: 'bw', flatField, flatFieldGeometry }],
  ['positive', { filmType: 'positive' }],
  ['positive, pre-saturation', { filmType: 'positive', preSaturation: 130, saturation: 110 }]
];

for (const [label, settings] of cases) {
  for (const withSample of [false, true]) {
    const name = `${label}${withSample ? ' + analysis sample' : ''}`;
    const options = { forceFullProcess: true, ...(withSample ? { analysisImageData: source16(11) } : {}) };

    // Cloned path (what a lent source gets): the source is never written.
    invalidateSilverCoreCache();
    const lent = source16();
    const before = hash(lent.data);
    const cloned = await convertFrameWithRouter({ imageData: lent, settings, options: { ...options } });
    assert.equal(hash(lent.data), before, `${name}: a lent source hashes the same after the conversion`);
    assert.notEqual(cloned.__image16.data.buffer, lent.data.buffer);

    // Owned path: the source is the output.
    invalidateSilverCoreCache();
    const owned = source16();
    const result = await convertFrameWithRouter({ imageData: owned, settings, options: { ...options, ownedSource: true } });
    assert.equal(result.__image16.data.buffer, owned.data.buffer, `${name}: the owned source became the work buffer`);
    assert.equal(hash(result.__image16.data), hash(cloned.__image16.data), `${name}: 16-bit output bit-identical`);
    assert.equal(hash(result.data), hash(cloned.data), `${name}: 8-bit output bit-identical`);
    const slot = inspectSlotBuffers('full');
    assert.equal(slot.pristineBuffer, null, `${name}: no pristine plane for an owned source`);
    assert.equal(slot.lastSourceRef, null);

    // After the frame the lane releases its caches: nothing pins a plane.
    releaseSlotBuffers('full');
    const released = inspectSlotBuffers('full');
    assert.ok(released.engine, `${name}: the engine stays for the next frame`);
    for (const field of ['pristineBuffer', 'lastSourceRef', 'analysis', 'promotedSource', 'exposureMap']) {
      assert.equal(released[field], null, `${name}: ${field} released`);
    }
    assert.deepEqual(released.referencePixels, {}, `${name}: reference pixels released`);

    // The next frame after a release converts exactly as a fresh slot would.
    const again = await convertFrameWithRouter({ imageData: source16(), settings, options: { ...options } });
    assert.equal(hash(again.__image16.data), hash(cloned.__image16.data), `${name}: a released slot converts the same`);
  }
}

{
  // A cloned (lent) conversion with film-base compensation builds a pristine
  // plane and pins the source; releaseSlotBuffers drops both.
  invalidateSilverCoreCache();
  const lent = source16();
  await convertFrameWithRouter({ imageData: lent, settings: cases[0][1], options: { forceFullProcess: true } });
  const slot = inspectSlotBuffers('full');
  assert.ok(slot.pristineBuffer && slot.lastSourceRef === lent.data, 'the cloned path keeps its pristine plane');
  releaseSlotBuffers('full');
  assert.equal(inspectSlotBuffers('full').pristineBuffer, null);
  assert.equal(inspectSlotBuffers('full').lastSourceRef, null);
}

{
  // `ownedSource` is ignored where it cannot apply: an 8-bit input (promoted
  // into a slot plane) and a request that reuses the cached analysis.
  invalidateSilverCoreCache();
  const eight = new ImageData(Uint8ClampedArray.from(source16().data, (v) => v >>> 8), W, H);
  const before = hash(eight.data);
  const reference = await convertFrameWithRouter({ imageData: new ImageData(eight.data.slice(), W, H), settings: cases[0][1], options: { forceFullProcess: true } });
  const result = await convertFrameWithRouter({ imageData: eight, settings: cases[0][1], options: { forceFullProcess: true, ownedSource: true } });
  assert.equal(hash(eight.data), before, 'the 8-bit input is untouched');
  assert.equal(hash(result.__image16.data), hash(reference.__image16.data));

  invalidateSilverCoreCache();
  const interactive = source16();
  const interactiveBefore = hash(interactive.data);
  await convertFrameWithRouter({ imageData: interactive, settings: cases[0][1], options: { ownedSource: true } });
  assert.equal(hash(interactive.data), interactiveBefore, 'without forceFullProcess the source is never taken');
}

invalidateSilverCoreCache();
console.log('silverAdapter.ownedSource.test.mjs passed');
