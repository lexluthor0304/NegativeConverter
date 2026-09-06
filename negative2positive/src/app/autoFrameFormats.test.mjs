import assert from 'node:assert/strict';
import { AUTO_FRAME_FORMAT_RATIOS, AUTO_FRAME_DEFAULT_120_FORMATS, canAutoApplyImportFrame } from './autoFrameFormats.js';
import { getAutoFrameAspectTargets } from './autoFrameAnalyzer.js';

const context = settings => ({ settings, formatRatios: AUTO_FRAME_FORMAT_RATIOS, default120Formats: AUTO_FRAME_DEFAULT_120_FORMATS });
assert.equal(Object.keys(AUTO_FRAME_FORMAT_RATIOS).length, 10);
assert.equal(getAutoFrameAspectTargets(context({ formatPreference: 'auto' })).length, 10);
assert.equal(getAutoFrameAspectTargets(context({ formatPreference: '135' })).length, 3);
assert.equal(getAutoFrameAspectTargets(context({ formatPreference: '120' })).length, 7);
assert.deepEqual(getAutoFrameAspectTargets(context({ formatPreference: '135-standard' })).map(t => t.key), ['135']);
for (const key of Object.keys(AUTO_FRAME_FORMAT_RATIOS).filter(key => key !== '135')) {
  assert.deepEqual(getAutoFrameAspectTargets(context({ formatPreference: key })).map(t => t.key), [key]);
}
const result = { cropRegion: { left: 10, top: 10, width: 500, height: 400 }, angle: -4.5, confidence: 0.78, confidenceLevel: 'high' };
assert.equal(canAutoApplyImportFrame(result), true);
assert.equal(canAutoApplyImportFrame({ ...result, requiresReview: true }, { highConfidence: 0 }), false);
assert.equal(canAutoApplyImportFrame(null), false);
assert.equal(canAutoApplyImportFrame({ ...result, confidence: 0.66, confidenceLevel: 'medium' }), false);
assert.equal(canAutoApplyImportFrame({ ...result, confidence: NaN }), false);
assert.equal(canAutoApplyImportFrame({ ...result, angle: Infinity }), false);
assert.equal(canAutoApplyImportFrame({ ...result, cropRegion: { ...result.cropRegion, width: 0 } }), false);
assert.equal(canAutoApplyImportFrame(result, { highConfidence: 0.8 }), false);
console.log('autoFrameFormats: 全画幅・個別指定・安全な自動適用の検証に成功');
