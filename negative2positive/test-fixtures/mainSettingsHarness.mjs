// Runs the real sanitizeSettings, createDefaultSettings, photoSettingsKey
// (plus any further main.js functions named) in the caller's realm, since
// settingsKey.js checks Object.prototype, with the module functions they call.
// Used by settingsKey.test.mjs and webglUniforms.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exactSettingsKey } from '../src/app/settingsKey.js';
import { normalizeAngleDegrees } from '../src/app/imageGeometry.js';
import { sanitizeSemanticMap } from '../src/app/semanticAnchors.js';
import { sanitizeFilmEdgeForSettings } from '../src/app/filmEdgeReader.js';
import { sanitizeRollFrameForSettings } from '../src/app/rollAnalysis.js';
import { normalizePaperId, normalizeToningId } from '../src/silvercore/engine/PaperProfiles.js';
import { sanitizeLocalExposureForSettings } from '../src/app/localExposure.js';
import { sanitizeRepairStrokes } from '../src/app/repairBrush.js';
import { sanitizeLookForSettings } from '../src/app/labMatch.js';
import { sanitizeExpiredRescueParams, sanitizeExpiredAnalysis, EXPIRED_RESCUE_DEFAULTS } from '../src/pipeline/expiredRescue.js';
import { sanitizeFrameMetadata } from '../src/app/analogMetadata.js';
import { computeSpline } from '../src/app/curveMath.js';
import { sanitizeFilmBaseForSettings } from '../src/app/filmBaseDetection.js';
import { sanitizeFilmTypeOverride } from '../src/app/filmTypeOverride.js';

const source = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');
export function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
function constSource(name) {
  const match = new RegExp(`^    const ${name} = .*;$`, 'm').exec(source);
  assert.ok(match, `${name} is a one-line constant in main.js`);
  return match[0];
}
export const state = {
  filmType: 'color', positiveMode: 'correct', importFilmTypeAuto: false, coreBorderBuffer: 10,
  coreBorderBufferBorderValue: 10, lensCorrection: null, expiredSession: false, flatFieldId: null,
  autoFrame: { lastDiagnostics: null }, filmEdge: null, rollFrame: null, localExposure: null, look: null,
  expiredAnalysis: null, frameMetadata: null, flatFields: {},
  dustRemoval: { enabled: false, strength: 3, maxParticleSize: 40, ai: false },
  curvePoints: { r: [{ x: 0, y: 0 }, { x: 255, y: 255 }], g: [{ x: 0, y: 0 }, { x: 255, y: 255 }], b: [{ x: 0, y: 0 }, { x: 255, y: 255 }] },
  curves: { r: null, g: null, b: null }
};
export const aiRepair = { revision: 3 };
const deps = {
  state, aiRepair, exactSettingsKey, normalizeAngleDegrees, sanitizeSemanticMap, sanitizeFilmEdgeForSettings,
  sanitizeRollFrameForSettings, normalizePaperId, normalizeToningId, sanitizeLocalExposureForSettings,
  sanitizeRepairStrokes, sanitizeLookForSettings, sanitizeExpiredRescueParams, sanitizeExpiredAnalysis,
  EXPIRED_RESCUE_DEFAULTS, sanitizeFrameMetadata, computeSpline, sanitizeFilmBaseForSettings, sanitizeFilmTypeOverride,
  detectedImportSettings: () => ({ filmType: 'color', positiveMode: 'correct', filmTypeSource: 'manual' }),
  autoDetectFilmBase: () => ({ r: 205, g: 141, b: 92 }),
  cachedDetectFilmType: () => null,
  createPerfTrace: () => ({ mark() {}, end() {} }),
  clampBetween: (v, min, max) => Math.min(max, Math.max(min, v))
};
export function mainFunctions(names, extraDeps = {}) {
  const all = { ...deps, ...extraDeps };
  const code = [
    ...['PRESET_TYPES', 'CORE_ENHANCED_PROFILE_OPTIONS', 'CORE_COLOR_MODEL_OPTIONS', 'CORE_COLOR_MODEL_MIGRATION_MAP'].map(constSource),
    ...['sanitizePresetType', 'inferFilmTypeFromLegacyPreset', 'sanitizeCoreEnhancedProfile', 'sanitizeCoreColorModel',
      'createDefaultLensCorrectionSettings', 'sanitizeLensSelection', 'sanitizeLensCorrection', 'makeLinearCurveLut',
      'makeLinearCurvePoints', 'sanitizeNumeric', 'sanitizeFilmBase', 'sanitizeCurvePointChannel',
      'buildCurveLutFromPoints', 'sanitizeCurveLut', 'sanitizeSettings', 'defaultFilmBaseBuffer', 'getImageDataPixelCount',
      'createDefaultSettings', 'photoSettingsKey',
      ...names].map(functionSource)
  ].join('\n');
  const exported = ['sanitizeSettings', 'createDefaultSettings', 'photoSettingsKey', 'sanitizeNumeric', ...names];
  return new Function(...Object.keys(all), `${code}\nreturn { ${exported.join(', ')} };`)(...Object.values(all));
}

