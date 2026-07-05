// Standalone Node test for settingsSnapshot.js - run with:
// node negative2positive/src/app/settingsSnapshot.test.mjs
import assert from 'node:assert/strict';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';

function makeSafeSettings() {
  return {
    cropRegion: { x: 10, y: 20, width: 800, height: 600 },
    rotationAngle: 90,
    autoFrameMeta: { confidence: 0.9 },
    filmType: 'color',
    filmBase: { r: 210, g: 140, b: 90 },
    lensCorrection: {
      enabled: true,
      selectedLens: { model: '50mm f/1.8' },
      params: { focal: 50, aperture: 8 },
      modes: { distortion: true },
      lastError: ''
    },
    coreFilmPreset: 'portra-classic',
    coreColorModel: 'frontier',
    coreEnhancedProfile: 'none',
    coreProfileStrength: 100,
    corePreSaturation: 100,
    coreBorderBuffer: 10,
    coreBorderBufferBorderValue: 10,
    coreBrightness: 5,
    coreExposure: 10,
    coreContrast: 0,
    coreHighlights: 0,
    coreShadows: 0,
    coreWhites: 0,
    coreBlacks: 0,
    coreWbMode: 'auto',
    coreTemperature: 0,
    coreTint: 0,
    coreSaturation: 100,
    coreGlow: 0,
    coreFade: 0,
    coreCurvePrecision: 'auto',
    coreUseWebGL: true,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    cyan: 0,
    magenta: 0,
    yellow: 0,
    wbR: 1,
    wbG: 1,
    wbB: 1,
    grayPointSampled: false,
    curvePoints: {
      r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      g: [{ x: 0, y: 0 }, { x: 128, y: 100 }, { x: 255, y: 255 }],
      b: [{ x: 0, y: 0 }, { x: 255, y: 255 }]
    },
    curves: {
      r: new Uint8Array(256).map((_, i) => i),
      g: new Uint8Array(256).map((_, i) => i),
      b: new Uint8Array(256).map((_, i) => i)
    }
  };
}

// 1. Copy equals source structurally
{
  const safe = makeSafeSettings();
  const copy = deepCopySanitizedSettings(safe);
  assert.deepEqual(copy.cropRegion, safe.cropRegion);
  assert.equal(copy.coreFilmPreset, 'portra-classic');
  assert.deepEqual(copy.curvePoints.g, safe.curvePoints.g);
  assert.deepEqual([...copy.curves.r], [...safe.curves.r]);
}

// 2. Copy is fully independent: mutating it never touches the source
{
  const safe = makeSafeSettings();
  const copy = deepCopySanitizedSettings(safe);
  copy.cropRegion.x = 999;
  copy.filmBase.r = 0;
  copy.lensCorrection.params.focal = 999;
  copy.lensCorrection.selectedLens.model = 'changed';
  copy.curvePoints.g[1].y = 7;
  copy.curves.r[10] = 250;
  copy.autoFrameMeta.confidence = 0;
  assert.equal(safe.cropRegion.x, 10);
  assert.equal(safe.filmBase.r, 210);
  assert.equal(safe.lensCorrection.params.focal, 50);
  assert.equal(safe.lensCorrection.selectedLens.model, '50mm f/1.8');
  assert.equal(safe.curvePoints.g[1].y, 100);
  assert.equal(safe.curves.r[10], 10);
  assert.equal(safe.autoFrameMeta.confidence, 0.9);
}

// 3. autoFrameMeta override (extractCurrentSettings passes live diagnostics)
{
  const safe = makeSafeSettings();
  const copy = deepCopySanitizedSettings(safe, { autoFrameMeta: { confidence: 0.42 } });
  assert.deepEqual(copy.autoFrameMeta, { confidence: 0.42 });
  const copyNull = deepCopySanitizedSettings(safe, { autoFrameMeta: null });
  assert.equal(copyNull.autoFrameMeta, null);
}

// 4. Null crop region and missing lens survive
{
  const safe = makeSafeSettings();
  safe.cropRegion = null;
  safe.lensCorrection.selectedLens = null;
  const copy = deepCopySanitizedSettings(safe);
  assert.equal(copy.cropRegion, null);
  assert.equal(copy.lensCorrection.selectedLens, null);
}

console.log('settingsSnapshot tests: all passed');
