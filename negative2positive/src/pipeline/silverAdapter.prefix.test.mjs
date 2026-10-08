// #238 (2) + (4) + (5): what each slot keeps, when it rebuilds, and which per-pixel
// stages a slider tick no longer runs. Pixel parity lives in silverAdapter.parity.test.
import assert from 'node:assert/strict';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const {
  convertColorWithSilverCore,
  convertBwWithSilverCore,
  convertPositiveWithSilverCore,
  invalidateSilverCoreCache,
  getSilverCoreCacheStats,
  setLargeImagePixelsForTesting,
} = await import('./silverAdapter.js');
const { Engine } = await import('../silvercore/engine/Engine.js');
const { sanitizeFlatFieldMap } = await import('../app/flatField.js');

const CONVERT = { color: convertColorWithSilverCore, bw: convertBwWithSilverCore, positive: convertPositiveWithSilverCore };
const W = 48, H = 36, PX = W * H;

function negative(seed = 1) {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const t = p / PX;
    data.set([46000 - 20000 * t + (p * 37 * seed) % 3000, 30000 - 15000 * t + (p * 53) % 2000, 20000 - 9000 * t + (p * 29) % 1500, 65535], p * 4);
  }
  return { width: W, height: H, data };
}
// Bright slide with a cast: gain 1, white balance active.
function slide() {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const x = p % W, y = (p / W) | 0;
    const v = 0.25 + 0.75 * (x + y) / (W + H);
    const [r, g, b] = (x * 7 + y * 3) % 11 === 0 ? [v * 0.9, v * 0.5, v * 0.2] : [v, v, v];
    data.set([Math.min(65535, Math.round(r * 1.1 * 65535)), Math.round(g * 65535), Math.round(b * 0.9 * 65535), 65535], p * 4);
  }
  return { width: W, height: H, data };
}
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false };
const strokes = (x) => ({
  localExposure: { strokes: [{ stops: 0.7, size: 0.4, feather: 0.5, points: [{ x, y: 0.5, p: 1 }] }] },
  localExposureGeometry: geometry,
});
const flatField = {
  flatField: sanitizeFlatFieldMap({ id: 'pad', width: 2, height: 2, gains: [1, 1.1, 1.2, 1.05, 1, 1.1, 1.2, 1.3, 1, 1, 1.1, 1.2] }),
  flatFieldGeometry: { ...geometry, cropRegion: null },
};
const BASE = {
  color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { colorModel: 'standard' },
  positive: { positiveMode: 'correct' },
};
const SOURCE = { color: negative(), bw: negative(), positive: slide() };
const stats = () => getSilverCoreCacheStats();

// --- (2) forced and large requests keep no plane ---------------------------------
for (const mode of ['color', 'bw', 'positive']) {
  for (const slotOptions of [{ preview: true }, {}, { preview: true, scratch: true }]) {
    const slotName = slotOptions.scratch ? 'scratch' : slotOptions.preview ? 'preview' : 'full';
    for (const extra of [{}, flatField, strokes(0.3), { preSaturation: 130 }]) {
      invalidateSilverCoreCache();
      const settings = { ...BASE[mode], ...extra };
      await CONVERT[mode](SOURCE[mode], settings, slotOptions);
      await CONVERT[mode](SOURCE[mode], settings, { ...slotOptions, forceFullProcess: true, analysisImageData: extra.preSaturation ? negative(2) : undefined });
      const slot = stats()[slotName];
      assert.deepEqual(
        [slot.pristineBytes, slot.lastSourceRef, slot.levels, slot.promotedSource],
        [0, false, 0, false],
        `${mode} ${slotName} ${Object.keys(extra)}: nothing kept after forceFullProcess`,
      );
    }
  }
}
{
  // Over LARGE_IMAGE_PIXELS (lowered for the test) an interactive request keeps nothing either.
  setLargeImagePixelsForTesting(PX - 1);
  try {
    for (const mode of ['color', 'bw', 'positive']) {
      invalidateSilverCoreCache();
      await CONVERT[mode](SOURCE[mode], { ...BASE[mode], ...flatField, ...strokes(0.2), preSaturation: 120 }, { preview: true });
      const slot = stats().preview;
      assert.deepEqual([slot.pristineBytes, slot.lastSourceRef, slot.levels], [0, false, 0], `${mode}: large image keeps nothing`);
    }
  } finally {
    setLargeImagePixelsForTesting();
  }
}
{
  // An 8-bit source promoted for a forced request is the work plane itself (no clone).
  invalidateSilverCoreCache();
  const img8 = new ImageData(Uint8ClampedArray.from(SOURCE.color.data, (v) => v >>> 8), W, H);
  const result = await convertColorWithSilverCore(img8, BASE.color, { forceFullProcess: true });
  assert.equal(stats().full.promotedSource, false);
  assert.equal(result.__image16.data.length, PX * 4);
}

// --- (2) interactive requests keep the pristine plane in every slot ---------------
for (const slotOptions of [{ preview: true }, {}, { preview: true, scratch: true }]) {
  for (const extra of [{}, flatField]) {
    invalidateSilverCoreCache();
    await convertColorWithSilverCore(SOURCE.color, { ...BASE.color, ...extra }, slotOptions);
    const before = stats().preprocess;
    await convertColorWithSilverCore(SOURCE.color, { ...BASE.color, ...extra, brightness: 20 }, slotOptions);
    await convertColorWithSilverCore(SOURCE.color, { ...BASE.color, ...extra, contrast: -10, preSaturation: 140 }, slotOptions);
    assert.equal(stats().preprocess, before, `${JSON.stringify(slotOptions)}: a second tick does not run _preprocessBuffer`);
  }
}

// --- (4)/(5) what rebuilds the prepared plane and what does not -------------------
async function builds(mode, settings, options = { preview: true, includeAnalysisPreview: false }, image = SOURCE[mode]) {
  const before = stats();
  await CONVERT[mode](image, settings, options);
  const after = stats();
  return { prepared: after.preparedBuilds - before.preparedBuilds, exposed: after.exposedBuilds - before.exposedBuilds };
}
const REFERENCE = { color: negative(3), bw: negative(3), positive: slide() };
for (const mode of ['color', 'bw', 'positive']) {
  for (const withReference of [false, true]) {
    const options = { preview: true, includeAnalysisPreview: false, analysisImageData: withReference ? REFERENCE[mode] : undefined };
    const base = { ...BASE[mode], preSaturation: 120, ...strokes(0.3) };
    invalidateSilverCoreCache();
    assert.deepEqual(await builds(mode, base, options), { prepared: 1, exposed: 1 }, `${mode}: first tick builds both levels`);
    for (const change of [{ brightness: 30 }, { contrast: 25 }, { temperature: -20, tint: 10 }, { saturation: 130 }, { paper: mode === 'bw' ? 'multigrade-rc' : 'crystal-archive' }, { exposure: 15, highlights: -20 }]) {
      assert.deepEqual(await builds(mode, { ...base, ...change }, options), { prepared: 0, exposed: 0 }, `${mode}: ${Object.keys(change)} reuses the prepared planes`);
    }
    assert.deepEqual(await builds(mode, { ...base, ...strokes(0.6) }, options), { prepared: 0, exposed: 1 }, `${mode}: a stroke edit rebuilds only the exposed level`);
    const rebuilders = [
      { preSaturation: 90 }, { borderBuffer: 0 }, flatField,
      // With a reference sample the analysis ignores the region (the sample is the region).
      ...(withReference ? [] : [{ analysisRegion: { left: 0.1, top: 0.1, width: 0.5, height: 0.5 } }]),
      ...(mode === 'bw' ? [{ bwMix: 'red' }] : []),
      ...(mode === 'positive' ? [{ positiveMode: 'edit' }] : []),
      ...(mode === 'color' ? [{ filmBase: { r: 200, g: 150, b: 100 } }, { filmBaseStrength: 0.5 }] : []),
    ];
    for (const change of rebuilders) {
      await builds(mode, base, options);
      const counts = await builds(mode, { ...base, ...strokes(0.6), ...change }, options);
      assert.equal(counts.prepared, 1, `${mode} ref ${withReference}: ${Object.keys(change)} rebuilds the prepared plane`);
      assert.equal(counts.exposed, 1);
    }
    await builds(mode, base, options);
    assert.equal((await builds(mode, base, options, mode === 'positive' ? slide() : negative(5))).prepared, 1, `${mode}: a new source buffer rebuilds`);
    if (withReference) {
      await builds(mode, base, options);
      assert.equal((await builds(mode, base, { ...options, analysisImageData: negative(7) })).prepared, 1, `${mode}: a new reference sample rebuilds`);
    }
    await builds(mode, base, options);
    await builds(mode, base, { ...options, forceFullProcess: true });
    assert.deepEqual(await builds(mode, base, options), { prepared: 1, exposed: 1 }, `${mode}: forceFullProcess drops the planes`);
  }
}

// --- level count and size per slot ------------------------------------------------
async function levels(mode, settings, options = { preview: true }) {
  await CONVERT[mode](SOURCE[mode], settings, options);
  const slot = stats()[options.scratch ? 'scratch' : options.preview ? 'preview' : 'full'];
  return { levels: slot.levels, prepared: slot.preparedBytes / PX, exposed: slot.exposedBytes / PX, kind: slot.preparedKind };
}
invalidateSilverCoreCache();
assert.deepEqual(await levels('color', BASE.color), { levels: 0, prepared: 0, exposed: 0, kind: 'rgba' }, 'colour at defaults keeps no prepared plane');
assert.deepEqual(await levels('color', { ...BASE.color, ...strokes(0.3) }), { levels: 1, prepared: 0, exposed: 8, kind: 'rgba' });
assert.deepEqual(await levels('color', { ...BASE.color, preSaturation: 120 }), { levels: 1, prepared: 8, exposed: 0, kind: 'rgba' });
assert.deepEqual(await levels('color', { ...BASE.color, preSaturation: 120, ...strokes(0.3) }), { levels: 2, prepared: 8, exposed: 8, kind: 'rgba' });
assert.deepEqual(await levels('positive', BASE.positive), { levels: 1, prepared: 8, exposed: 0, kind: 'rgba' }, 'active white balance');
assert.deepEqual(await levels('positive', { ...BASE.positive, positiveMode: 'edit' }), { levels: 0, prepared: 0, exposed: 0, kind: 'rgba' });
assert.deepEqual(await levels('bw', BASE.bw), { levels: 1, prepared: 2, exposed: 0, kind: 'grey' }, 'B&W keeps a 2 B/px grey plane');
assert.deepEqual(await levels('bw', { ...BASE.bw, ...strokes(0.3) }), { levels: 2, prepared: 2, exposed: 2, kind: 'grey' });
assert.deepEqual(await levels('bw', { ...BASE.bw, ...strokes(0.3) }, { preview: true, forceFullProcess: true }), { levels: 0, prepared: 0, exposed: 0, kind: null });

// --- a Brightness drag runs none of the prefix stages -----------------------------
const spied = ['analyze', 'process', 'reprocess', '_applyPreSaturation', '_applyPositiveAnalysis', '_applyLocalExposure'];
const calls = {};
const originals = {};
for (const name of spied) {
  originals[name] = Engine.prototype[name];
  Engine.prototype[name] = function (...args) { calls[name] = (calls[name] || 0) + 1; return originals[name].apply(this, args); };
}
try {
  for (const mode of ['bw', 'positive', 'color']) {
    for (const analysisImageData of [undefined, REFERENCE[mode]]) {
      invalidateSilverCoreCache();
      const settings = { ...BASE[mode], preSaturation: 120, saturation: 100, ...strokes(0.4) };
      const options = { preview: true, includeAnalysisPreview: false, analysisImageData };
      await CONVERT[mode](SOURCE[mode], { ...settings, brightness: 0 }, options);
      for (const key of Object.keys(calls)) delete calls[key];
      const before = stats();
      for (let brightness = 1; brightness <= 5; brightness++) await CONVERT[mode](SOURCE[mode], { ...settings, brightness }, options);
      assert.deepEqual(calls, {}, `${mode}: no mix, pre-saturation, positive, stops or analysis during the drag`);
      assert.equal(stats().preparedBuilds, before.preparedBuilds);
      assert.equal(stats().exposedBuilds, before.exposedBuilds);
    }
  }

  // --- the gain-1 fold: forced positive conversions skip applyPositiveAnalysis ------
  const forced = { forceFullProcess: true };
  for (const [image, settings, expected, label] of [
    [slide(), BASE.positive, 0, 'gain 1 with WB active folds into the curves'],
    [slide(), { ...BASE.positive, ...strokes(0.3) }, 1, 'stops between the stages keep the pass'],
    [(() => { const s = slide(); for (let i = 0; i < s.data.length; i += 4) for (let c = 0; c < 3; c++) s.data[i + c] >>>= 1; return s; })(), BASE.positive, 1, 'gain > 1 keeps the cross-channel pass'],
  ]) {
    invalidateSilverCoreCache();
    calls._applyPositiveAnalysis = 0;
    await convertPositiveWithSilverCore(image, settings, forced);
    assert.equal(calls._applyPositiveAnalysis, expected, label);
  }
} finally {
  for (const name of spied) Engine.prototype[name] = originals[name];
}
invalidateSilverCoreCache();
console.log('silverAdapter.prefix: transient requests keep nothing, pristine reuse, rebuild keys, level sizes, drag without prefix stages, gain-1 fold');
