// Standalone Node test for recipes.js - run with:
// node negative2positive/src/app/recipes.test.mjs

import assert from 'node:assert/strict';
import { encodeRecipe, decodeRecipe, extractRecipeCode, recipeDiff, describeRecipeChange, RecipeError, RECIPE_KEYS, RECIPE_VERSION, pickRecipeSettings } from './recipes.js';

const settings = {
  filmType: 'color', coreFilmPreset: 'gold-warm', coreColorModel: 'standard', coreEnhancedProfile: 'natural', coreProfileStrength: 100,
  corePreSaturation: 100, coreBrightness: 0, coreExposure: 20, coreContrast: 12, coreHighlights: -4, coreShadows: -18, coreWhites: 2, coreBlacks: 0,
  coreWbMode: 'auto', coreTemperature: 0, coreTint: -1, coreCyan: 0, coreSaturation: 135, coreGlow: 14, coreFade: 8,
  corePaper: 'kodak-endura', corePaperToning: 'none', corePaperToningStrength: 100,
  look: { matrix: [1.05, 0.02, -0.04, -0.03, 1, 0.05, 0, -0.02, 1.12], offset: [-6, 4, 9], curves: null },
  exposure: 0, contrast: 5, highlights: 0, shadows: 0, temperature: 3, tint: 0, vibrance: 10, saturation: 0, cyan: 0, magenta: 0, yellow: 0,
  curvePoints: { r: [{ x: 0, y: 0 }, { x: 128, y: 140 }, { x: 255, y: 255 }], g: [{ x: 0, y: 0 }, { x: 255, y: 255 }], b: [{ x: 0, y: 0 }, { x: 255, y: 255 }] },
  curves: { r: Uint8Array.from({ length: 256 }, (_, i) => i), g: null, b: null },
  wbR: 1.02, wbG: 1, wbB: 0.97, wbUserOverride: true,
  // Geometry and file data must never travel.
  cropRegion: { left: 1, top: 2, width: 3, height: 4 }, rotationAngle: 1.5, mirrored: true, filmBase: { r: 1, g: 2, b: 3 }, autoFrameMeta: { x: 1 }, lensCorrection: { enabled: true }
};

// Every recipe key round-trips (curves as points, numbers to four decimals) and no geometry travels.
{
  const code = encodeRecipe(settings, { stock: 'Ultra Max 400', lab: 'Corner Lab', note: 'sunny' });
  assert.match(code, /^NC1\.[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 500, `full code length ${code.length}`);
  const decoded = decodeRecipe(code);
  assert.equal(decoded.version, RECIPE_VERSION);
  assert.deepEqual(decoded.tags, { stock: 'Ultra Max 400', lab: 'Corner Lab', note: 'sunny' });
  for (const key of RECIPE_KEYS) {
    if (settings[key] === undefined || key === 'curves') continue;
    assert.deepEqual(decoded.settings[key], JSON.parse(JSON.stringify(settings[key], (k, v) => (v === null ? undefined : v))), key);
  }
  for (const key of ['cropRegion', 'rotationAngle', 'mirrored', 'filmBase', 'autoFrameMeta', 'lensCorrection', 'curves']) {
    assert.equal(decoded.settings[key], undefined, `${key} must not travel`);
  }
  assert.equal(pickRecipeSettings(settings).curves, undefined);
  // A typical recipe (a handful of controls away from the defaults) stays well under 300 characters.
  const defaults = { ...settings, coreExposure: 0, coreContrast: 0, coreSaturation: 100, corePaper: 'none', look: null, vibrance: 0, curvePoints: { r: [{ x: 0, y: 0 }, { x: 255, y: 255 }], g: settings.curvePoints.g, b: settings.curvePoints.b } };
  const typical = encodeRecipe(settings, { stock: 'Ultra Max 400' }, { defaults });
  assert.ok(typical.length < 300, `typical code length ${typical.length}`);
  const typicalSettings = decodeRecipe(typical).settings;
  assert.deepEqual(Object.keys(typicalSettings).sort(), ['coreContrast', 'coreExposure', 'corePaper', 'coreSaturation', 'curvePoints', 'look', 'vibrance']);
  assert.deepEqual(typicalSettings.curvePoints.r, settings.curvePoints.r);
  console.log('recipe lengths:', { full: code.length, typical: typical.length });
  // The code survives being pasted inside other text.
  assert.equal(extractRecipeCode(`Try this: https://example.com/?r=${code} :)`), code);
  assert.deepEqual(decodeRecipe(`  ${code}\n`).settings.coreExposure, 20);
}

// Malformed input fails with a reason; newer versions fail gracefully.
{
  assert.throws(() => decodeRecipe('hello'), (e) => e instanceof RecipeError && e.reason === 'format');
  assert.throws(() => decodeRecipe('NC1.!!!'), (e) => e instanceof RecipeError && e.reason === 'format');
  assert.throws(() => decodeRecipe('NC1.AAAAAAAA'), (e) => e instanceof RecipeError && e.reason === 'corrupt');
  assert.throws(() => decodeRecipe('NC99.AAAA'), (e) => e instanceof RecipeError && e.reason === 'version' && /newer/.test(e.message));
  const truncated = encodeRecipe(settings).slice(0, 30);
  assert.throws(() => decodeRecipe(truncated), (e) => e instanceof RecipeError && e.reason === 'corrupt');
}

// The diff lists only what would change, comparing curves and looks by value.
{
  const decoded = decodeRecipe(encodeRecipe(settings));
  assert.deepEqual(recipeDiff(settings, decoded.settings), [], 'the same settings produce no diff');
  const current = { ...settings, coreExposure: 0, corePaper: 'none', curvePoints: { r: [{ x: 0, y: 0 }, { x: 255, y: 255 }], g: settings.curvePoints.g, b: settings.curvePoints.b } };
  const diff = recipeDiff(current, decoded.settings);
  assert.deepEqual(diff.map((d) => d.key), ['coreExposure', 'corePaper', 'curvePoints']);
  assert.equal(describeRecipeChange(diff[0]), 'coreExposure: 0 → 20');
  assert.equal(describeRecipeChange(diff[2]), 'curvePoints: curve → curve');
  assert.equal(describeRecipeChange({ key: 'look', from: null, to: {} }), 'look: – → look');
}

console.log('recipes.test.mjs passed');
