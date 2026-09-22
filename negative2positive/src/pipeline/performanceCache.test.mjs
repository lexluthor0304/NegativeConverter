import assert from 'node:assert/strict';
import { Engine } from '../silvercore/engine/Engine.js';
import { fromImageData8 } from '../silvercore/util/image16.js';
import { convertColorWithSilverCore, invalidateSilverCoreCache } from './silverAdapter.js';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const image = new ImageData(Uint8ClampedArray.from({ length: 80 * 60 * 4 }, (_, i) => (i * 79 + (i >>> 4)) % 256), 80, 60);
const settings = { filmBase: { r: 210, g: 140, b: 90 }, colorModel: 'standard' };
let analyses = 0;
const analyze = Engine.prototype.analyze;
Engine.prototype.analyze = function (...args) { analyses++; return analyze.apply(this, args); };
try {
  invalidateSilverCoreCache();
  const first = await convertColorWithSilverCore(image, settings, { preview: true });
  const originalOutput = first.__image16.data.slice();
  const changed = await convertColorWithSilverCore(image, { ...settings, contrast: 15 }, { preview: true });
  await convertColorWithSilverCore(image, settings, { preview: true });
  assert.equal(analyses, 1, '8-bit source is promoted once, and unrelated controls reuse analysis');
  assert.deepEqual(first.__image16.data, originalOutput, 'cached promotion never aliases output');
  const oracle = await convertColorWithSilverCore(fromImageData8(image), { ...settings, contrast: 15 }, { scratch: true });
  assert.deepEqual(changed.__image16.data, oracle.__image16.data, 'promotion cache preserves exact 16-bit result');
  const before = analyses;
  image.data[0] = 13;
  const refreshed = await convertColorWithSilverCore(image, settings, { preview: true, forceFullProcess: true });
  assert.equal(analyses, before + 1, 'explicit refresh replaces cached promotion');
  const freshOracle = await convertColorWithSilverCore(fromImageData8(image), settings, { scratch: true, forceFullProcess: true });
  assert.deepEqual(refreshed.__image16.data, freshOracle.__image16.data);
  const switched = new ImageData(image.data.slice(), 80, 60);
  switched.data.fill(170);
  const prior = analyses;
  await convertColorWithSilverCore(switched, settings, { preview: true });
  assert.equal(analyses, prior + 1, 'new source invalidates analysis');
  await convertColorWithSilverCore(new ImageData(switched.data, 60, 80), settings, { preview: true });
  assert.equal(analyses, prior + 2, 'shape changes invalidate promotion');
  invalidateSilverCoreCache();
  await convertColorWithSilverCore(switched, settings, { preview: true });
  assert.equal(analyses, prior + 3, 'explicit cache reset drops promotion');
} finally { Engine.prototype.analyze = analyze; }

const localSettings = {
  ...settings,
  localExposure: { strokes: [{ stops: .5, size: .4, feather: .5, points: [{ x: .3, y: .4, p: 1 }, { x: .6, y: .7, p: .8 }] }] },
  localExposureGeometry: { baseWidth: 80, baseHeight: 60, rotatedWidth: 80, rotatedHeight: 60, rotationAngle: 0, mirrored: false },
};
const maps = [];
const applyLocal = Engine.prototype._applyLocalExposure;
Engine.prototype._applyLocalExposure = function (input, params) { maps.push(params.localExposureStops); return applyLocal.call(this, input, params); };
try {
  invalidateSilverCoreCache();
  await convertColorWithSilverCore(image, localSettings, { preview: true });
  const firstMap = maps.at(-1);
  const preserved = firstMap.slice();
  const changed = await convertColorWithSilverCore(image, { ...structuredClone(localSettings), contrast: 17 }, { preview: true });
  assert.equal(maps.at(-1), firstMap, 'copied settings and unrelated control changes reuse rasterization');
  const oracle = await convertColorWithSilverCore(image, { ...localSettings, contrast: 17 }, { scratch: true });
  assert.deepEqual(changed.__image16.data, oracle.__image16.data, 'cached stops preserve exact pixels');
  localSettings.localExposure.strokes[0].points[0].x = .7;
  await convertColorWithSilverCore(image, localSettings, { preview: true });
  assert.notEqual(maps.at(-1), firstMap, 'stroke edits invalidate map even with same object');
  assert.deepEqual(firstMap, preserved, 'old maps remain immutable');
  for (const change of [{ mirrored: true }, { rotationAngle: 15 }, { cropRegion: { left: 5, top: 4, width: 65, height: 48 } }]) {
    const previous = maps.at(-1);
    await convertColorWithSilverCore(image, { ...localSettings, localExposureGeometry: { ...localSettings.localExposureGeometry, ...change } }, { preview: true });
    assert.notEqual(maps.at(-1), previous, 'geometry changes invalidate map');
  }
  await convertColorWithSilverCore(image, { ...localSettings, localExposure: null }, { preview: true });
  assert.equal(maps.at(-1), null, 'clearing strokes releases map');
} finally { Engine.prototype._applyLocalExposure = applyLocal; }
console.log('performanceCache: 8-bit promotion, exact output, stroke reuse, invalidation and ownership passed');
