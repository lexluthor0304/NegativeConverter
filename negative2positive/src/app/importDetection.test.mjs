import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { META_ONLY_KEYS, importConversionKey, omitKeys } from './importDetection.js';
import { resolveAnalysisRegion } from './analysisRegion.js';

// 1. No conversion or export code reads the fields the key leaves out.
const src = fileURLToPath(new URL('..', import.meta.url));
const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.js')) files.push(path);
  }
};
for (const dir of ['pipeline', 'silvercore', 'render']) walk(join(src, dir));
for (const name of ['conversionWorker.js', 'exportWorker.js', 'pixelAdjustments.js', 'pixelAdjustments16.js']) files.push(join(src, 'workers', name));
assert.ok(files.length > 20);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const key of META_ONLY_KEYS) {
    assert.ok(!new RegExp(`\\b${key}\\b`).test(text), `${key} is read in ${file.slice(src.length)}; it can no longer be left out of the conversion key`);
  }
}

// 2. The pure key: detection descriptions and the flat-field gain map object
// drop out; the analysis area and the WB review gate stay in.
{
  const router = { coreExposure: 3, cropRegion: null, flatFieldId: 'ff', flatField: { gains: [1, 2] }, autoFrameMeta: { method: 'a' }, filmEdge: null };
  const adjustment = { exposure: 0, frameMetadata: { frameNumber: '12' }, learnedDefaults: null };
  const key = importConversionKey({ router, adjustment, meta: null });
  assert.equal(importConversionKey({
    router: { ...router, flatField: { gains: [9] }, autoFrameMeta: { method: 'b' }, filmEdge: { found: true }, filmTypeSource: 'auto' },
    adjustment: { ...adjustment, frameMetadata: {}, learnedDefaults: { key: 'k', n: 3 }, filmTypeReason: 'dx' },
    meta: { method: 'b', importAuto: true }
  }), key);
  assert.notEqual(importConversionKey({ router, adjustment, meta: { imageArea: [{ x: 0, y: 0 }] } }), key);
  assert.notEqual(importConversionKey({ router, adjustment, meta: { analysisArea: [{ x: 0, y: 1 }] } }), key);
  assert.notEqual(importConversionKey({ router, adjustment, meta: { analysisNeedsReview: true } }), key);
  assert.notEqual(importConversionKey({ router: { ...router, flatFieldId: 'other' }, adjustment }), key);
  assert.deepEqual(omitKeys({ a: 1, filmEdge: 2 }, META_ONLY_KEYS), { a: 1 });
}

// 3. The real conversionKey over the real settings builders. Helpers that only
// validate a value (sanitizers, curve LUT builders) pass it through; unequal
// inputs stay unequal and equal inputs equal, which is all the key needs.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
const state = {
  filmType: 'color', cropRegion: null, rotationAngle: 0, mirrored: false, flatFields: {},
  autoFrame: { lastDiagnostics: null }, curvePoints: {}, curves: {}, filmBase: { r: 200, g: 120, b: 80 }
};
const context = vm.createContext({
  state, console, structuredClone, importConversionKey, resolveAnalysisRegion,
  rollFrameExposureUnits: () => 0,
});
vm.runInContext(['sanitizeSettings', 'getEffectiveFilmType', 'usesSilverCoreConversion', 'buildCoreConversionSettings',
  'buildRouterSettings', 'localExposureGeometryFor', 'buildAdjustmentSettings', 'conversionKey'].map(functionSource).join('\n'), context);
const key = (settings, image = { width: 400, height: 300 }) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return context.conversionKey(settings, image); }
    catch (error) {
      const missing = error?.name === 'ReferenceError' && /^(\w+) is not defined$/.exec(error.message);
      if (!missing) throw error;
      context[missing[1]] = value => value;
    }
  }
  throw new Error('too many unknown helpers');
};
const snapshot = {
  cropRegion: null, rotationAngle: 0, mirrored: false, autoFrameMeta: null, filmType: 'color', positiveMode: 'correct',
  filmTypeSource: 'auto', filmTypeConfidence: 'medium', filmTypeReason: 'orange-mask', filmBase: { r: 210, g: 140, b: 90 },
  filmEdge: null, frameMetadata: {}, learnedDefaults: null, semanticMap: null, rollFrame: null, flatFieldId: null,
  coreFilmPreset: 'none', coreColorModel: 'standard', coreExposure: 0, coreTemperature: 0, coreTint: 0, coreSaturation: 100,
  wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null, repairStrokes: [], localExposure: null, curvePoints: {}, curves: {}
};
const provisional = key(snapshot);
// Auto-frame without an applied crop and a film edge that found nothing: only
// autoFrameMeta and filmEdge differ, so the provisional render is final.
const unapplied = {
  ...snapshot,
  autoFrameMeta: { confidence: 0.68, confidenceLevel: 'medium', detectedFormat: '135', method: 'density-template', appliedMode: 'none', importAuto: true, frameIncomplete: false, imageArea: null },
  filmEdge: { checked: true, found: false }
};
assert.equal(key(unapplied), provisional, 'an unapplied detection and an empty film edge keep the key');
assert.equal(key({ ...unapplied, frameMetadata: { frameNumber: '12A' }, filmTypeSource: 'auto', filmTypeConfidence: 'high', filmTypeReason: 'dx',
  learnedDefaults: { key: 'k', n: 2 }, filmEdge: { checked: true, found: true, filmName: 'KODAK PORTRA 400' } }), provisional,
  'provenance, frame number, learned tag and a found edge are descriptions only');
const area = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
for (const [label, change] of [
  ['crop', { cropRegion: { left: 10, top: 10, width: 300, height: 200 } }],
  ['angle', { rotationAngle: 1.25 }],
  ['mirror', { mirrored: true }],
  ['film type', { filmType: 'bw' }],
  ['image area', { autoFrameMeta: { ...unapplied.autoFrameMeta, imageArea: area } }],
  ['analysis review', { autoFrameMeta: { ...unapplied.autoFrameMeta, analysisNeedsReview: true } }],
  ['learned value', { coreTemperature: 4 }],
  ['learned category', { coreFilmPreset: 'kodak_portra_400' }],
]) {
  assert.notEqual(key({ ...unapplied, ...change }), provisional, `${label} changes the conversion key`);
}
console.log('import detection: META_ONLY_KEYS unread by conversion code; conversion key equal for descriptions, different for crop, angle, mirror, film type, area and learned values');
