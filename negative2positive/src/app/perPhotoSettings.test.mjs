import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';
import { normalizeAngleDegrees } from './imageGeometry.js';

// cloneSettings copies one photo's settings for a batch job, a thumbnail or a
// roll pass. It must not fill that photo's missing geometry from the photo on
// screen: a never-cropped frame used to be exported with the open frame's crop.
// The real main.js functions run here; only the unrelated sanitizers are stubs.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

const pass = value => value ?? null;
const linear = () => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const openCrop = { left: 84, top: 83, width: 472, height: 312 };
const context = vm.createContext({
  structuredClone,
  deepCopySanitizedSettings,
  normalizeAngleDegrees,
  sanitizePresetType: type => type || 'color',
  inferFilmTypeFromLegacyPreset: (_preset, fallback) => fallback,
  sanitizeSemanticMap: pass,
  sanitizeFilmBase: (value, fallback) => ({ ...(value || fallback || {}) }),
  sanitizeFilmEdgeForSettings: pass,
  sanitizeRollFrameForSettings: pass,
  sanitizeLensCorrection: (value, fallback) => ({ enabled: false, selectedLens: null, params: {}, modes: {}, ...(value || fallback || {}) }),
  sanitizeCoreColorModel: (value, fallback) => value || fallback,
  sanitizeCoreEnhancedProfile: (value, fallback) => value || fallback,
  normalizePaperId: id => id || 'none',
  normalizeToningId: id => id || 'none',
  sanitizeLocalExposureForSettings: pass,
  sanitizeRepairStrokes: strokes => strokes || [],
  sanitizeLookForSettings: pass,
  sanitizeExpiredRescueParams: () => ({}),
  sanitizeExpiredAnalysis: pass,
  sanitizeFrameMetadata: pass,
  sanitizeCurvePointChannel: (value, fallback) => (value || fallback || linear()).map(point => ({ ...point })),
  sanitizeCurveLut: (value, fallback) => value || fallback || null,
  buildCurveLutFromPoints: () => new Uint8Array(256),
  // The photo on screen: cropped, rotated, mirrored, with its own detection.
  state: {
    cropRegion: { ...openCrop },
    rotationAngle: 3,
    mirrored: true,
    autoFrame: { lastDiagnostics: { method: 'open-photo', appliedMode: 'crop' } },
    filmType: 'color',
    filmBase: { r: 200, g: 120, b: 80 },
    exposure: 0.5,
    wbR: 1.1,
    wbG: 1,
    wbB: 0.9
  }
});
vm.runInContext(['clampBetween', 'sanitizeNumeric', 'sanitizeSettings', 'perPhotoSettingsFallback', 'cloneSettings', 'sanitizeProjectSettings']
  .map(functionSource).join('\n'), context);
const { cloneSettings, sanitizeProjectSettings, state } = context;

// A never-cropped photo stays uncropped while another photo is open cropped.
{
  const uncropped = { cropRegion: null, rotationAngle: 0, mirrored: false, autoFrameMeta: null, exposure: 0 };
  const copy = cloneSettings(uncropped);
  assert.equal(copy.cropRegion, null);
  assert.equal(copy.rotationAngle, 0);
  assert.equal(copy.mirrored, false);
  assert.equal(copy.autoFrameMeta, null);
  // The open photo is untouched.
  assert.deepEqual(state.cropRegion, openCrop);
}

// Settings without geometry keys (an older project, a partial recipe) inherit
// no geometry either, as sanitizeProjectSettings already guaranteed.
for (const clone of [cloneSettings, sanitizeProjectSettings]) {
  const copy = clone({ exposure: 0 });
  assert.equal(copy.cropRegion, null);
  assert.equal(copy.rotationAngle, 0);
  assert.equal(copy.mirrored, false);
  assert.equal(copy.autoFrameMeta, null);
}

// A photo's own geometry is kept, as an independent copy.
{
  const own = {
    cropRegion: { left: 10, top: 12, width: 300, height: 200 },
    rotationAngle: -1.5,
    mirrored: true,
    autoFrameMeta: { method: 'own', appliedMode: 'crop' }
  };
  const copy = cloneSettings(own);
  assert.deepEqual(copy.cropRegion, own.cropRegion);
  assert.notEqual(copy.cropRegion, own.cropRegion);
  assert.equal(copy.rotationAngle, -1.5);
  assert.equal(copy.mirrored, true);
  assert.deepEqual(copy.autoFrameMeta, own.autoFrameMeta);
  assert.notEqual(copy.autoFrameMeta, own.autoFrameMeta);
}

// Only geometry changed: a missing colour value still comes from the open
// photo, as before.
{
  const copy = cloneSettings({ cropRegion: null });
  assert.equal(copy.exposure, 0.5);
  assert.deepEqual([copy.wbR, copy.wbG, copy.wbB], [1.1, 1, 0.9]);
  assert.deepEqual(copy.filmBase, state.filmBase);
}

assert.equal(cloneSettings(null), null);
assert.equal(sanitizeProjectSettings(null), null);

console.log('perPhotoSettings tests passed');
