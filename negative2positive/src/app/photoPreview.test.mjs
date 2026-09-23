import assert from 'node:assert/strict';
import { createAdjustedPhotoPreview } from './photoPreview.js';
import {
  applyPreparedAdjustmentsToBuffer,
  stripLegacyToneSettingsForSilverCore
} from './adjustmentPipeline.js';
import { createStudioThumbnail } from './studioSettings.js';
import { analyzeExpiredFilm, EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';

const identity = () => Uint8Array.from({ length: 256 }, (_, value) => value);
const settings = (extra = {}) => ({
  curves: { r: identity(), g: identity(), b: identity() },
  ...extra
});
function image(width, height, pixel = (x, y) => [40 + x % 150, 50 + y % 140, 80 + (x + y) % 120, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}
function reference(source, prepared, maxSize = 144) {
  const small = createStudioThumbnail(source, maxSize);
  const output = { width: small.width, height: small.height, data: new Uint8ClampedArray(small.data.length) };
  applyPreparedAdjustmentsToBuffer(small, prepared, output, { quality: 'preview' });
  return output;
}

// Regression: the WebGL renderer does not populate an adjusted CPU buffer.
// A cyan edit must therefore affect the thumbnail using processed pixels alone.
{
  const source = image(4, 2, () => [100, 120, 140, 255]);
  const before = source.data.slice();
  const gpu = createAdjustedPhotoPreview(source, settings({ cyan: 20, coreUseWebGL: true }));
  const cpu = createAdjustedPhotoPreview(source, settings({ cyan: 20, coreUseWebGL: false }));
  assert.deepEqual(Array.from(gpu.data.slice(0, 4)), [49, 120, 140, 255]);
  assert.deepEqual(gpu.data, cpu.data, 'renderer choice cannot change final thumbnail colour');
  assert.notDeepEqual(gpu.data, createStudioThumbnail(source).data, 'old unadjusted thumbnail misses cyan');
  assert.deepEqual(source.data, before, 'preview does not modify converted pixels');
  assert.notEqual(gpu.data.buffer, source.data.buffer);
}

// White balance, CMY, curves, look and HSL must use the real preview pipeline,
// exactly once. The source is already core-converted, so legacy core tone
// settings are prepared by the caller, just as they are for the main canvas.
{
  const source = image(31, 23);
  const curved = settings({ wbR: 1.16, wbG: 0.91, wbB: 1.04, magenta: 4, yellow: -3 });
  curved.curves.r = Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, v + 15));
  curved.curves.b = Uint8Array.from({ length: 256 }, (_, v) => Math.round(v * 0.85));
  const variants = [
    curved,
    settings({ vibrance: 37, saturation: 19 }),
    settings({ look: {
      matrix: [1.02, 0.03, 0, 0, 0.98, 0.03, 0.02, 0, 0.97],
      offset: [3, 1, -2],
      curves: { r: identity(), g: identity(), b: identity() }
    } })
  ];
  for (const prepared of variants) {
    const actual = createAdjustedPhotoPreview(source, prepared, { maxSize: 17 });
    assert.deepEqual(actual.data, reference(source, prepared, 17).data);
    assert.notDeepEqual(actual.data, createStudioThumbnail(source, 17).data, 'the adjustment is visibly applied');
    assert.notDeepEqual(actual.data, createAdjustedPhotoPreview(actual, prepared, { maxSize: 17 }).data,
      'the reference distinguishes a second, erroneous adjustment pass');
  }
  const prepared = stripLegacyToneSettingsForSilverCore(settings({
    exposure: 2, contrast: 60, saturation: 90, temperature: 30,
    coreExposure: 40, coreContrast: 60, coreFilmPreset: 'portra400'
  }));
  assert.deepEqual(createAdjustedPhotoPreview(source, prepared).data, source.data,
    'core-converted pixels are neither inverted nor core-tone-adjusted again');
}

// Expired-film analysis belongs to the photo; reuse it at thumbnail dimensions
// and apply the rescue only once, without reanalysing or reconverting the source.
{
  const source = image(256, 24, (x) => [70 + x * 0.60, 85 + x * 0.47, 95 + x * 0.55, 255]);
  const analysis = analyzeExpiredFilm(source, { borderBuffer: 0 });
  assert.ok(analysis);
  const prepared = settings({
    ...EXPIRED_RESCUE_DEFAULTS,
    expiredEnabled: true,
    expiredLevels: 85,
    expiredNeutralize: 80,
    expiredCrossover: 65,
    expiredBrightness: 15,
    expiredAnalysis: analysis
  });
  const analysisBefore = structuredClone(analysis);
  const actual = createAdjustedPhotoPreview(source, prepared, { maxSize: 64 });
  assert.deepEqual(actual.data, reference(source, prepared, 64).data);
  assert.notDeepEqual(actual.data, createStudioThumbnail(source, 64).data);
  assert.notDeepEqual(actual.data, createAdjustedPhotoPreview(actual, prepared, { maxSize: 64 }).data);
  assert.deepEqual(analysis, analysisBefore, 'per-photo analysis remains unchanged');
}

// Geometry is already baked into the source. Recipe geometry must never cause
// a second rotation/crop, and portrait/landscape previews preserve its framing.
for (const [width, height, expectedWidth, expectedHeight] of [
  [600, 400, 144, 96], [400, 600, 96, 144], [1, 1, 1, 1], [33, 19, 33, 19]
]) {
  const source = image(width, height);
  const prepared = settings({ rotation: 90, flipHorizontal: true, cropRect: { x: 0, y: 0, width: 1, height: 1 } });
  const actual = createAdjustedPhotoPreview(source, prepared);
  assert.equal(actual.width, expectedWidth);
  assert.equal(actual.height, expectedHeight);
  assert.deepEqual(actual.data, createStudioThumbnail(source).data, 'use already-cropped/rotated pixels once');
}

// Display previews read the existing 8-bit presentation plane even when a
// genuine 16-bit export plane exists. Do not quantize differently, mutate it,
// or retain that potentially enormous plane on a tiny thumbnail.
{
  const source = image(2, 1, () => [18, 171, 255, 255]);
  source.__image16 = { width: 2, height: 1, data: new Uint16Array([0x12ff, 0xab00, 65535, 65535, 0x12ff, 0xab00, 65535, 65535]) };
  const plane = source.__image16;
  const before = plane.data.slice();
  const actual = createAdjustedPhotoPreview(source, settings());
  assert.deepEqual(actual.data, source.data);
  assert.equal(actual.__image16, undefined);
  assert.equal(source.__image16, plane);
  assert.deepEqual(plane.data, before);
}

// A virtual 40 GB presentation source makes any full-source traversal/copy
// fail, while exposing the same subarray interface as real typed-array input.
// Instrument destination allocations: two thumbnail buffers, never full size.
{
  const NativeArray = globalThis.Uint8ClampedArray;
  const allocations = [];
  let reads = 0;
  const sample = new NativeArray([100, 120, 140, 255]);
  const source = {
    width: 100000,
    height: 100000,
    data: {
      length: 40000000000,
      subarray(start, end) {
        assert.equal(end - start, 4);
        assert.ok(start >= 0 && end <= this.length);
        reads++;
        return sample;
      }
    }
  };
  const prepared = settings({ cyan: 20 });
  try {
    globalThis.Uint8ClampedArray = new Proxy(NativeArray, {
      construct(Target, args) {
        assert.equal(typeof args[0], 'number', 'never clone a source buffer');
        allocations.push(args[0]);
        assert.ok(args[0] <= 144 * 144 * 4, 'allocation is bounded by preview size');
        return new Target(...args);
      }
    });
    const actual = createAdjustedPhotoPreview(source, prepared);
    assert.equal(actual.width, 144);
    assert.equal(actual.height, 144);
    assert.equal(reads, 144 * 144, 'only sampled pixels are visited');
    assert.deepEqual(allocations, [144 * 144 * 4, 144 * 144 * 4]);
  } finally {
    globalThis.Uint8ClampedArray = NativeArray;
  }
}

// Node consumers receive the same ImageData-like shape; browsers get an
// actual ImageData without another pixel allocation or a canvas dependency.
{
  const previous = globalThis.ImageData;
  class TestImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  }
  try {
    globalThis.ImageData = TestImageData;
    assert.ok(createAdjustedPhotoPreview(image(1, 1), settings()) instanceof TestImageData);
  } finally {
    if (previous === undefined) delete globalThis.ImageData;
    else globalThis.ImageData = previous;
  }
}

for (const maxSize of [0, -1, NaN, Infinity, 1.5]) {
  assert.throws(() => createAdjustedPhotoPreview(image(1, 1), settings(), { maxSize }), RangeError);
}
for (const source of [null, { width: 0, height: 1, data: new Uint8Array(4) }, { width: 2, height: 2, data: new Uint8Array(4) }]) {
  assert.throws(() => createAdjustedPhotoPreview(source, settings()), TypeError);
}

console.log('photoPreview tests passed');
