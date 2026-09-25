import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exactSettingsKey } from './settingsKey.js';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';
import { pickStudioColors } from './studioSettings.js';
import { normalizeAngleDegrees } from './imageGeometry.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { sanitizeFilmEdgeForSettings } from './filmEdgeReader.js';
import { sanitizeRollFrameForSettings } from './rollAnalysis.js';
import { normalizePaperId, normalizeToningId } from '../silvercore/engine/PaperProfiles.js';
import { sanitizeLocalExposureForSettings } from './localExposure.js';
import { sanitizeRepairStrokes } from './repairBrush.js';
import { sanitizeLookForSettings } from './labMatch.js';
import { sanitizeExpiredRescueParams, sanitizeExpiredAnalysis, EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';
import { sanitizeFrameMetadata } from './analogMetadata.js';
import { computeSpline } from './curveMath.js';
import { sanitizeFilmBaseForSettings } from './filmBaseDetection.js';
import { sanitizeFilmTypeOverride } from './filmTypeOverride.js';

// Run the real sanitizeSettings, createDefaultSettings and photoSettingsKey
// from main.js in this realm (the key's fast path checks Object.prototype).
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
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
const state = {
  filmType: 'color', positiveMode: 'correct', importFilmTypeAuto: false, coreBorderBuffer: 10,
  coreBorderBufferBorderValue: 10, lensCorrection: null, expiredSession: false, flatFieldId: null,
  autoFrame: { lastDiagnostics: null }, filmEdge: null, rollFrame: null, localExposure: null, look: null,
  expiredAnalysis: null, frameMetadata: null, flatFields: {},
  dustRemoval: { enabled: false, strength: 3, maxParticleSize: 40, ai: false },
  curvePoints: { r: [{ x: 0, y: 0 }, { x: 255, y: 255 }], g: [{ x: 0, y: 0 }, { x: 255, y: 255 }], b: [{ x: 0, y: 0 }, { x: 255, y: 255 }] },
  curves: { r: null, g: null, b: null }
};
const aiRepair = { revision: 3 };
const deps = {
  state, aiRepair, exactSettingsKey, normalizeAngleDegrees, sanitizeSemanticMap, sanitizeFilmEdgeForSettings,
  sanitizeRollFrameForSettings, normalizePaperId, normalizeToningId, sanitizeLocalExposureForSettings,
  sanitizeRepairStrokes, sanitizeLookForSettings, sanitizeExpiredRescueParams, sanitizeExpiredAnalysis,
  EXPIRED_RESCUE_DEFAULTS, sanitizeFrameMetadata, computeSpline, sanitizeFilmBaseForSettings, sanitizeFilmTypeOverride,
  detectedImportSettings: () => ({ filmType: 'color', positiveMode: 'correct', filmTypeSource: 'manual' }),
  autoDetectFilmBase: () => ({ r: 205, g: 141, b: 92 }),
  clampBetween: (v, min, max) => Math.min(max, Math.max(min, v))
};
const code = [
  ...['PRESET_TYPES', 'CORE_ENHANCED_PROFILE_OPTIONS', 'CORE_COLOR_MODEL_OPTIONS', 'CORE_COLOR_MODEL_MIGRATION_MAP'].map(constSource),
  ...['sanitizePresetType', 'inferFilmTypeFromLegacyPreset', 'sanitizeCoreEnhancedProfile', 'sanitizeCoreColorModel',
    'createDefaultLensCorrectionSettings', 'sanitizeLensSelection', 'sanitizeLensCorrection', 'makeLinearCurveLut',
    'makeLinearCurvePoints', 'sanitizeNumeric', 'sanitizeFilmBase', 'sanitizeCurvePointChannel',
    'buildCurveLutFromPoints', 'sanitizeCurveLut', 'sanitizeSettings', 'createDefaultSettings', 'photoSettingsKey'].map(functionSource)
].join('\n');
const app = new Function(...Object.keys(deps), `${code}\nreturn { sanitizeSettings, createDefaultSettings, photoSettingsKey };`)(...Object.values(deps));

// The key as it was at 1703835.
const oldKey = item => JSON.stringify([item.settings, item.studioColors, item.filmTypeOverride,
  state.dustRemoval.enabled, state.dustRemoval.strength, state.dustRemoval.maxParticleSize,
  state.dustRemoval.ai,
  state.dustRemoval.enabled || item.settings?.repairStrokes?.length ? aiRepair.revision : null,
  state.flatFields[item.settings?.flatFieldId]?.id || null]);

const image = { width: 8, height: 6, data: new Uint8ClampedArray(8 * 6 * 4).fill(120) };
const defaults = app.createDefaultSettings(image, null);
assert.ok(defaults.curves.r instanceof Uint8Array, 'createDefaultSettings carries LUT curves');
const sanitized = app.sanitizeSettings(defaults, { fallbackSettings: defaults });
const copied = deepCopySanitizedSettings(sanitized);
assert.ok(app.photoSettingsKey({ settings: copied }).includes('\u0000'), 'realistic settings take the fast path');

const withCurve = (settings, channel, index, value) => {
  const next = { ...settings, curves: { ...settings.curves, [channel]: Uint8Array.from(settings.curves[channel]) } };
  next.curves[channel][index] = value;
  return next;
};
const strokes = count => Array.from({ length: count }, (_, i) => ({ stops: i % 2 ? 1 : -1, size: .05, feather: .5,
  points: Array.from({ length: 20 }, (_, j) => ({ x: (i + j) / 40, y: j / 20, p: 1 })) }));
const bases = [
  ['default', defaults],
  ['sanitized', sanitized],
  ['deep copy', copied],
  ['sanitized from raw', app.sanitizeSettings({ coreExposure: 25, cyan: 10, curvePoints: { r: [{ x: 0, y: 10 }, { x: 128, y: 150 }, { x: 255, y: 250 }] } }, { fallbackSettings: defaults })],
  ['strokes', deepCopySanitizedSettings(app.sanitizeSettings({ ...copied, localExposure: { strokes: strokes(3) }, repairStrokes: [{ size: .02, points: [{ x: .5, y: .5 }] }] }, { fallbackSettings: copied }))],
  ['feather zero', app.sanitizeSettings({ ...copied, localExposure: { strokes: [{ ...strokes(1)[0], feather: -1 }] } }, { fallbackSettings: copied })],
];
const settingsVariants = [];
for (const [label, base] of bases) {
  settingsVariants.push([label, base]);
  settingsVariants.push([`${label} r[0]`, withCurve(base, 'r', 0, 1)]);
  settingsVariants.push([`${label} g[128]`, withCurve(base, 'g', 128, 127)]);
  settingsVariants.push([`${label} b[255]`, withCurve(base, 'b', 255, 254)]);
  settingsVariants.push([`${label} same bytes`, withCurve(base, 'r', 0, base.curves.r[0])]);
  settingsVariants.push([`${label} points`, { ...base, curvePoints: { ...base.curvePoints, g: [{ x: 0, y: 0 }, { x: 60, y: 90 }, { x: 255, y: 255 }] } }]);
  settingsVariants.push([`${label} cyan`, { ...base, cyan: 7 }]);
  settingsVariants.push([`${label} flat field`, { ...base, flatFieldId: 'flat-1' }]);
  settingsVariants.push([`${label} null curves`, { ...base, curves: null }]);
  settingsVariants.push([`${label} missing curves`, (({ curves, ...rest }) => rest)(base)]);
  settingsVariants.push([`${label} array curves`, { ...base, curves: { r: Array.from(base.curves.r), g: Array.from(base.curves.g), b: Array.from(base.curves.b) } }]);
  settingsVariants.push([`${label} repair`, { ...base, repairStrokes: [{ size: .03, points: [{ x: .2, y: .3 }] }] }]);
}
settingsVariants.push(['null settings', null], ['undefined settings', undefined]);
const studioVariants = [
  ['none', undefined], ['null', null], ['empty', {}],
  ['colors', pickStudioColors(copied)],
  ['colors r[3]', (() => { const colors = pickStudioColors(copied); colors.curves.r[3] = 9; return colors; })()],
  ['colors points', { ...pickStudioColors(copied), curvePoints: { r: [{ x: 0, y: 5 }, { x: 255, y: 255 }], g: copied.curvePoints.g, b: copied.curvePoints.b } }],
  ['colors null curves', { ...pickStudioColors(copied), curves: null }],
  ['colors without curves', { coreExposure: 12 }],
];
const overrides = [undefined, null, { filmType: 'bw' }, { filmType: 'positive', positiveMode: 'edit' }];
const globals = [
  () => Object.assign(state.dustRemoval, { enabled: false, strength: 3, maxParticleSize: 40, ai: false }),
  () => Object.assign(state.dustRemoval, { enabled: true, strength: 3, maxParticleSize: 40, ai: false }),
  () => Object.assign(state.dustRemoval, { enabled: true, strength: 5, maxParticleSize: 40, ai: true }),
  () => Object.assign(state.dustRemoval, { enabled: true, strength: 5, maxParticleSize: 60, ai: true }),
  () => { aiRepair.revision++; },
  () => { state.flatFields['flat-1'] = { id: 'flat-1' }; },
  () => { delete state.flatFields['flat-1']; Object.assign(state.dustRemoval, { enabled: false, ai: false }); },
];

// Equality classes must match exactly: equal new keys <=> equal old keys.
let checked = 0;
for (const applyGlobals of globals) {
  applyGlobals();
  const items = [];
  for (const [settingsLabel, settings] of settingsVariants) for (const [studioLabel, studioColors] of studioVariants) {
    for (const filmTypeOverride of overrides) {
      const item = { settings, filmTypeOverride };
      if (studioColors !== undefined) item.studioColors = studioColors;
      items.push({ label: `${settingsLabel} / ${studioLabel} / ${JSON.stringify(filmTypeOverride)}`, item });
    }
  }
  const byOld = new Map(), byNew = new Map();
  for (const { label, item } of items) {
    const old = oldKey(item), next = app.photoSettingsKey(item);
    if (!byOld.has(old)) byOld.set(old, next);
    else assert.equal(byOld.get(old), next, `old-equal keys must stay equal: ${label}`);
    if (!byNew.has(next)) byNew.set(next, old);
    else assert.equal(byNew.get(next), old, `new-equal keys must be old-equal: ${label}`);
    checked++;
  }
  assert.equal(byOld.size, byNew.size);
}
// Same content in fresh objects (as every persist produces) keeps the key.
assert.equal(app.photoSettingsKey({ settings: deepCopySanitizedSettings(sanitized) }), app.photoSettingsKey({ settings: copied }));

// Adversarial shapes: never a false hit. A fast key (with U+0000) can only
// equal another fast key, and then the plain JSON must be equal too.
const lut = (fill, length = 256, Type = Uint8Array) => { const value = new Type(length); value.fill(fill); return value; };
const weird = [
  { curves: { r: lut(1), g: lut(2), b: lut(3) } },
  { curves: { g: lut(2), r: lut(1), b: lut(3) } },
  { curves: { r: lut(1), g: lut(2), b: lut(3), extra: 1 } },
  { curves: { r: lut(1), g: lut(2) } },
  { curves: { r: lut(1, 256, Uint8ClampedArray), g: lut(2), b: lut(3) } },
  { curves: { r: lut(1, 255), g: lut(2), b: lut(3) } },
  { curves: { r: lut(1, 0), g: lut(2), b: lut(3) } },
  { curves: { r: lut(1, 5000), g: lut(2), b: lut(3) } },
  { curves: { r: Object.fromEntries(Array.from(lut(1), (v, i) => [i, v])), g: lut(2), b: lut(3) } },
  { curves: null }, {}, { curves: undefined }, { curves: [] }, { curves: 'rgb' },
  { curves: { r: lut(1), g: lut(2), b: lut(3) }, toJSON() { return 'x'; } },
  Object.assign(Object.create(null), { curves: { r: lut(1), g: lut(2), b: lut(3) } }),
  { nested: { curves: { r: lut(1), g: lut(2), b: lut(3) } }, curves: { r: lut(1), g: lut(2), b: lut(3) } },
  { a: '\u0000', curves: { r: lut(1), g: lut(2), b: lut(3) } },
  { curves: { r: lut(1), g: lut(2), b: lut(3).subarray(0, 256) } },
];
const weirdKeys = [];
for (const settings of weird) for (const studioColors of [undefined, ...weird.slice(0, 6)]) {
  const values = [settings, studioColors, null];
  weirdKeys.push({ old: JSON.stringify(values), next: exactSettingsKey(values, 2) });
}
for (let i = 0; i < weirdKeys.length; i++) {
  assert.equal(weirdKeys[i].next.includes('\u0000'), weirdKeys[i].old !== weirdKeys[i].next,
    'only fast keys differ from the plain JSON, and they contain U+0000');
  for (let j = i + 1; j < weirdKeys.length; j++) {
    if (weirdKeys[i].next === weirdKeys[j].next) assert.equal(weirdKeys[i].old, weirdKeys[j].old, `no false hit ${i}/${j}`);
  }
}
assert.notEqual(exactSettingsKey([{ curves: { r: lut(1), g: lut(2), b: lut(3) } }, { curves: null }], 2),
  exactSettingsKey([{ curves: null }, { curves: { r: lut(1), g: lut(2), b: lut(3) } }], 2), 'slot mask separates the owners');
assert.ok(!JSON.stringify(['\u0000', { a: '\u0000' }]).includes('\u0000'), 'JSON escapes U+0000');

// Benchmark: 2 keys x 116 realistic items. The audit's profile has the
// colour sliders synced (studioColors without curves, keys of 8-10 KB); a
// roll whose curves are synced too carries six LUTs per key.
const rollSettings = Array.from({ length: 116 }, (_, i) => deepCopySanitizedSettings(app.sanitizeSettings({ ...copied,
  coreExposure: i, cyan: i % 7, curvePoints: { r: [{ x: 0, y: i % 20 }, { x: 128, y: 130 }, { x: 255, y: 250 }],
    g: copied.curvePoints.g, b: copied.curvePoints.b } }, { fallbackSettings: copied })));
const sliders = settings => (({ curves, curvePoints, ...colors }) => colors)(pickStudioColors(settings));
const time = (roll, keyOf) => {
  const runs = [];
  for (let run = 0; run < 15; run++) {
    const start = performance.now();
    for (const item of roll) { keyOf(item); keyOf(item); }
    runs.push(performance.now() - start);
  }
  return runs.sort((a, b) => a - b);
};
const report = [];
for (const [label, colors, bound] of [['slider colours', sliders, 1.5], ['colours with curves', pickStudioColors, 3]]) {
  const roll = rollSettings.map(settings => ({ settings, studioColors: colors(settings), filmTypeOverride: null }));
  const oldRuns = time(roll, oldKey), newRuns = time(roll, app.photoSettingsKey);
  assert.ok(newRuns[0] <= bound, `${label}: 232 keys took ${newRuns[0].toFixed(2)} ms`);
  report.push(`${label} (${(oldKey(roll[0]).length / 1024).toFixed(1)} KB -> ${(app.photoSettingsKey(roll[0]).length / 1024).toFixed(1)} KB) `
    + `best ${newRuns[0].toFixed(2)} / median ${newRuns[7].toFixed(2)} ms, old JSON median ${oldRuns[7].toFixed(2)} ms`);
}
console.log(`settingsKey: ${checked} keys match old JSON equality exactly, no false hits; 232 keys: ${report.join('; ')}`);
