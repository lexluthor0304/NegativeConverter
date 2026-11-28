// Standalone Node test for the editor's side of dynamic range compression -
// run with: node negative2positive/src/app/dynamicRangeHint.test.mjs
//
// The settings travel where a tone setting travels (recipe code, Sync color,
// the settings snapshot that history, projects and batch jobs copy), the
// hint appears when the estimate says so and stays away once dismissed or
// used, and the page's sliced sample equals the adapter's own.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { encodeRecipe, decodeRecipe, RECIPE_KEYS } = await import('./recipes.js');
const { pickStudioColors, STUDIO_COLOR_KEYS } = await import('./studioSettings.js');
const { deepCopySanitizedSettings } = await import('./settingsSnapshot.js');
const { createDrcSampler, drcHintWanted, drcAutoSettings, drcPlaneOf } = await import('./dynamicRangeHint.js');
const drc = await import('../pipeline/dynamicRange.js');

const DRC = { drcAmount: 45, drcDetail: 30, drcShadows: 70, drcHighlights: 55, drcLocalContrast: 20, drcSaturation: 80 };

{
  // Recipe code: the six controls round-trip; the hint's dismissal is the
  // photo's own and is not part of a recipe.
  for (const key of drc.DRC_KEYS) assert.ok(RECIPE_KEYS.includes(key), `recipe carries ${key}`);
  assert.ok(!RECIPE_KEYS.includes('drcHintDismissed'));
  const decoded = decodeRecipe(encodeRecipe({ filmType: 'color', ...DRC, drcHintDismissed: true }));
  for (const [key, value] of Object.entries(DRC)) assert.equal(decoded.settings[key], value, key);
  assert.equal(decoded.settings.drcHintDismissed, undefined);
  // The schema only appends: the expired keys keep their packed indices.
  assert.ok(RECIPE_KEYS.indexOf('drcAmount') > RECIPE_KEYS.indexOf('expiredLocalContrast'));
}

{
  // Sync color copies them (a tone setting, unlike focus recovery).
  for (const key of drc.DRC_KEYS) assert.ok(STUDIO_COLOR_KEYS.includes(key), `Sync color carries ${key}`);
  assert.ok(!STUDIO_COLOR_KEYS.includes('drcHintDismissed'));
  assert.ok(!STUDIO_COLOR_KEYS.includes('focusRecovery'));
  const picked = pickStudioColors({ ...DRC, drcHintDismissed: true, focusRecovery: 40 });
  for (const [key, value] of Object.entries(DRC)) assert.equal(picked[key], value);
  assert.equal(picked.drcHintDismissed, undefined);
}

{
  // The snapshot (history, projects, batch jobs) keeps all seven; an older
  // settings object reads as off.
  const minimal = {
    filmBase: {}, lensCorrection: { params: {}, modes: {} }, dustRemoval: {}, repairStrokes: [],
    curvePoints: { r: [], g: [], b: [] }, curves: { r: [], g: [], b: [] }
  };
  const copy = deepCopySanitizedSettings({ ...minimal, ...DRC, drcHintDismissed: true });
  for (const [key, value] of Object.entries(DRC)) assert.equal(copy[key], value);
  assert.equal(copy.drcHintDismissed, true);
  const old = deepCopySanitizedSettings(minimal);
  assert.equal(old.drcAmount, 0);
  assert.equal(old.drcDetail, 50);
  assert.equal(old.drcHintDismissed, false);
}

{
  // main.js lists them where the editor snapshots, sanitises, restores and
  // resets its state, so Undo, saved projects and Reset all carry them.
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const snapshotKeys = main.slice(main.indexOf('const SNAPSHOT_SCALAR_KEYS = ['), main.indexOf('];', main.indexOf('const SNAPSHOT_SCALAR_KEYS = [')));
  for (const key of [...drc.DRC_KEYS, 'drcHintDismissed']) {
    assert.ok(snapshotKeys.includes(`'${key}'`), `undo snapshots ${key}`);
    assert.ok(main.includes(`${key}: Math.round(sanitizeNumeric(source.${key}`) || key === 'drcHintDismissed', `sanitizeSettings reads ${key}`);
  }
  assert.ok(main.includes('drcHintDismissed: Boolean(source === state ? state.drcHintDismissed : source.drcHintDismissed)'));
  // The GPU preview draws it once the photo's map for these settings is solved.
  assert.ok(/Number\(settings\.drcAmount\) > 0 && !gpuDrcInputs\(settings, mode, params, analysis\)\) return false;/.test(main));
  assert.ok(main.includes('return { mode, params, plan, engine, width: prepared.width, height: prepared.height, drc };'));
}

{
  // The hint: offered when the compression brings back enough, never when the
  // photo already uses it or the hint was dismissed there.
  const estimate = { reduction: drc.DRC_HINT_THRESHOLD + 0.01, suggested: { ...drc.DRC_DEFAULTS, drcAmount: 30 } };
  assert.equal(drcHintWanted({ drcAmount: 0, drcHintDismissed: false }, estimate), true);
  assert.equal(drcHintWanted({ drcAmount: 0, drcHintDismissed: false }, { reduction: drc.DRC_HINT_THRESHOLD - 0.001 }), false);
  assert.equal(drcHintWanted({ drcAmount: 0, drcHintDismissed: true }, estimate), false);
  assert.equal(drcHintWanted({ drcAmount: 20, drcHintDismissed: false }, estimate), false);
  assert.equal(drcHintWanted({ drcAmount: 0 }, null), false);
  assert.deepEqual(drcAutoSettings(estimate), estimate.suggested);
  assert.equal(drcAutoSettings(null), null);
  // Auto leans towards the end that was clipped more, and keeps the fine defaults.
  const by = { 30: { shadows: 0.01, highlights: 0.02 }, 50: { shadows: 0, highlights: 0.01 }, 70: { shadows: 0, highlights: 0 } };
  const auto = drc.suggestDrcSettings({ shadows: 0.02, highlights: 0.2 }, by);
  assert.ok(auto.drcAmount >= 30 && auto.drcHighlights > 50 && auto.drcShadows < 50);
  assert.equal(auto.drcDetail, 50);
  assert.equal(auto.drcLocalContrast, 50);
  assert.equal(auto.drcSaturation, 50);
}

{
  // The page's sample, made in slices from an 8-bit or 16-bit frame, equals
  // the adapter's own (sampleDrcInput of the 16-bit plane it converts).
  const width = 900; const height = 600;
  const data16 = new Uint16Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data16[i * 4] = (i * 37) % 65536; data16[i * 4 + 1] = (i * 101) % 65536; data16[i * 4 + 2] = (i * 7) % 65536; data16[i * 4 + 3] = 65535;
  }
  const frame16 = { width, height, data: new Uint8ClampedArray(width * height * 4), __image16: { width, height, data: data16 } };
  let clock = 0;
  const ready = [];
  const sampler = createDrcSampler({ now: () => (clock += 3), yieldTask: async () => {}, sliceMs: 8, onReady: (f) => ready.push(f) });
  assert.equal(sampler.sampleFor(frame16), null, 'not ready at first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let k = 0; k < 50 && !sampler.has(frame16); k++) await new Promise((resolve) => setTimeout(resolve, 0));
  const sample = sampler.sampleFor(frame16);
  assert.ok(sample && typeof sample.key === 'string', 'the sample is made');
  assert.deepEqual(ready, [frame16]);
  const own = drc.sampleDrcInput(data16, width, height);
  assert.ok(Buffer.from(sample.rgb.buffer).equals(Buffer.from(own.rgb.buffer)), 'page sample = adapter sample');
  // An 8-bit frame is read as its x257 promotion.
  const data8 = new Uint8ClampedArray(width * height * 4).map((_, i) => (i * 13) % 256);
  const plane = drcPlaneOf({ width, height, data: data8 });
  assert.equal(plane.scale, 257);
}

console.log('dynamic range editor tests passed');
