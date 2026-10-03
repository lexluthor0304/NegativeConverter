import assert from 'node:assert/strict';
import { applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { buildRollProject, serializeRollProject, parseRollProject } from './rollProject.js';
import { analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';
const pick = (source, keys) => Object.fromEntries(keys.map(key => [key, source[key]]));
// A fogged, low-contrast, dark positive: its measurement sets brightness and
// contrast off the defaults.
function agedFrame(width = 64, height = 48) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4, v = 60 + ((x * 3 + y * 5) % 70);
    data[o] = v + 6; data[o + 1] = v; data[o + 2] = v - 4; data[o + 3] = 255;
  }
  return { width, height, data };
}
const original = { filmType: 'color', filmTypeSource: 'auto', filmTypeConfidence: 'high', rollFrame: { locked: true }, cropRegion: { left: 10, width: 90 }, coreExposure: 25, repairStrokes: [{ x: 5 }], wbAutoConfidence: .8, wbR: 1.2, wbG: 1, wbB: .8 };
const next = applyFilmTypeOverride(original, { filmType: 'bw' });
assert.equal(next.filmType, 'bw');
assert.equal(next.filmTypeSource, 'manual');
assert.equal(next.rollFrame, null);
assert.equal(next.wbR, 1);
assert.deepEqual(next.cropRegion, original.cropRegion);
assert.deepEqual(next.repairStrokes, original.repairStrokes);
assert.equal(next.coreExposure, 25);
assert.equal(original.rollFrame.locked, true);
assert.equal(applyFilmTypeOverride({ ...original, wbUserOverride: true }, { filmType: 'bw' }).wbR, 1.2);
assert.equal(sanitizeFilmTypeOverride({ filmType: 'invalid' }), null);
assert.deepEqual(sanitizeFilmTypeOverride({ filmType: 'positive', positiveMode: 'edit', cropRegion: {} }), { filmType: 'positive', positiveMode: 'edit' });
const project = buildRollProject({ files: [{ name: 'unopened.dng', size: 123, filmTypeOverride: { filmType: 'bw', positiveMode: 'correct' } }] });
assert.deepEqual(parseRollProject(serializeRollProject(project)).files[0].filmTypeOverride, project.files[0].filmTypeOverride);
// Automatic retype (#231): same invalidation, automatic provenance.
const retyped = applyAutomaticFilmType({ ...original, filmType: 'positive', filmTypeReason: 'noMask' }, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' });
assert.deepEqual([retyped.filmType, retyped.filmTypeSource, retyped.filmTypeConfidence, retyped.filmTypeReason], ['bw', 'auto', 'medium', 'rollMonochrome']);
assert.equal(retyped.rollFrame, null);
assert.equal(retyped.wbR, 1);
assert.equal(retyped.coreExposure, 25);
assert.equal(applyAutomaticFilmType({ ...original, grayPointSampled: true }, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' }).wbR, 1.2);
const confirmed = applyAutomaticFilmType({ ...original, filmType: 'bw', filmTypeConfidence: 'low', filmTypeReason: 'monochrome' }, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' });
assert.deepEqual(confirmed.rollFrame, original.rollFrame, 'a confirmation keeps analysis of the same type');
assert.equal(confirmed.wbR, 1.2);
assert.equal(confirmed.filmTypeConfidence, 'medium');
// HEAD's override, kept as the reference for the refactor.
function referenceOverride(settings, override) {
  const choice = sanitizeFilmTypeOverride(override);
  if (!choice) return settings;
  const next = { ...settings, ...choice, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null, rollFrame: null };
  if (next.wbAutoConfidence && !next.wbUserOverride && !next.grayPointSampled) {
    next.wbR = next.wbG = next.wbB = 1;
    next.wbAutoConfidence = null; next.wbSemanticApplied = false;
  }
  return next;
}
for (const settings of [original, { ...original, wbUserOverride: true }, { ...original, grayPointSampled: true }, { ...original, wbAutoConfidence: null }, { filmType: 'bw' }]) {
  for (const choice of [{ filmType: 'bw' }, { filmType: 'positive', positiveMode: 'edit' }, { filmType: 'color' }, { filmType: 'nope' }, null]) {
    assert.deepEqual(applyFilmTypeOverride(settings, choice), referenceOverride(settings, choice));
  }
}
// R1-017: the expired rescue's measurement belongs to the interpretation it
// was taken on (film type and positive mode, as main.js keys it). A retype
// drops it, so the frame is measured again in its new mode; brightness and
// contrast still holding what that measurement set go back to the defaults
// for the new measurement to fill, values the user moved stay.
{
  const positive = analyzeExpiredFilm(agedFrame(), {});
  const measured = defaultExpiredRescueParams(positive);
  assert.ok(measured.expiredBrightness !== EXPIRED_RESCUE_DEFAULTS.expiredBrightness
    && measured.expiredContrast !== EXPIRED_RESCUE_DEFAULTS.expiredContrast, 'the fixture measures off-default strengths');
  const rescued = {
    ...original, filmType: 'positive', positiveMode: 'correct', filmTypeReason: 'noMask', expiredEnabled: true,
    expiredAnalysis: positive, expiredLevels: 80, expiredUnevenFog: 40, ...pick(measured, ['expiredBrightness', 'expiredContrast'])
  };
  const flipped = applyAutomaticFilmType(rescued, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' });
  assert.equal(flipped.expiredAnalysis, null, 'an automatic retype drops the positive measurement');
  assert.deepEqual(pick(flipped, ['expiredBrightness', 'expiredContrast']), pick(EXPIRED_RESCUE_DEFAULTS, ['expiredBrightness', 'expiredContrast']),
    'strengths the measurement set are left for the new one');
  assert.deepEqual([flipped.expiredEnabled, flipped.expiredLevels, flipped.expiredUnevenFog], [true, 80, 40], 'the rescue and the user strengths stay');
  assert.ok(rescued.expiredAnalysis === positive && rescued.expiredBrightness === measured.expiredBrightness, 'the input is not mutated');
  const moved = applyAutomaticFilmType({ ...rescued, expiredBrightness: measured.expiredBrightness + 7 }, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' });
  assert.deepEqual([moved.expiredBrightness, moved.expiredContrast], [measured.expiredBrightness + 7, EXPIRED_RESCUE_DEFAULTS.expiredContrast], 'a moved brightness stays');
  const confirmedRescue = applyAutomaticFilmType(rescued, { filmType: 'positive', confidence: 'medium', reason: 'rollMonochrome' });
  assert.equal(confirmedRescue.expiredAnalysis, positive, 'a confirmation keeps the measurement');
  assert.equal(confirmedRescue.expiredBrightness, measured.expiredBrightness);
  // "These are positives" and Apply film type to roll (applyFilmTypeOverride).
  const bwRescued = { ...rescued, filmType: 'bw', filmTypeReason: 'rollMonochrome' };
  const corrected = applyFilmTypeOverride(bwRescued, { filmType: 'positive', positiveMode: 'correct' });
  assert.equal(corrected.expiredAnalysis, null, 'These are positives drops the B&W measurement');
  assert.equal(corrected.expiredContrast, EXPIRED_RESCUE_DEFAULTS.expiredContrast);
  const sameType = applyFilmTypeOverride(bwRescued, { filmType: 'bw' });
  assert.equal(sameType.expiredAnalysis, positive, 'the roll override of the photo\'s own type keeps its measurement');
  assert.equal(sameType.expiredBrightness, measured.expiredBrightness);
  const mode = applyFilmTypeOverride(rescued, { filmType: 'positive', positiveMode: 'edit' });
  assert.equal(mode.expiredAnalysis, null, 'another positive mode is another interpretation');
  assert.equal(applyFilmTypeOverride({ ...rescued, positiveMode: undefined }, { filmType: 'positive' }).expiredAnalysis, positive,
    'an unset positive mode is correct');
  assert.ok(!('expiredAnalysis' in applyAutomaticFilmType(original, { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' })),
    'settings without a measurement get none');
}
console.log('filmTypeOverride: isolated film selection, manual WB and unopened project persistence passed');
console.log('filmTypeOverride: a retype drops the expired measurement of the old interpretation and the strengths it set (R1-017)');

// A completed semantic map must not provide old-interpretation rescue anchors.
{
  const semanticMap = { labels: [1, 2], confidence: 0.9 };
  const settings = { ...original, filmType: 'positive', positiveMode: 'correct', semanticMap,
    expiredEnabled: true, expiredBrightness: 17, expiredContrast: 23 };
  const manual = applyFilmTypeOverride(settings, { filmType: 'color' });
  const automatic = applyAutomaticFilmType(settings, { filmType: 'bw', confidence: 'high', reason: 'rollMonochrome' });
  const editOnly = applyFilmTypeOverride(settings, { filmType: 'positive', positiveMode: 'edit' });
  for (const result of [manual, automatic, editOnly]) {
    assert.equal(result.semanticMap, null, 'retype clears completed old-interpretation anchors');
    assert.deepEqual([result.expiredBrightness, result.expiredContrast], [17, 23], 'user rescue strengths survive');
  }
  assert.equal(applyAutomaticFilmType(settings, { filmType: 'positive', confidence: 'high' }).semanticMap, semanticMap,
    'confirming the same interpretation keeps its anchors');
  assert.equal(settings.semanticMap, semanticMap, 'saved history is not mutated');
}
