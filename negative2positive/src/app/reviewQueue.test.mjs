import assert from 'node:assert/strict';
import { frameNeedsReview } from './reviewQueue.js';
for (const [settings, reason] of [
  [{ autoFrameMeta: { confidenceLevel: 'low' } }, 'reviewFrame'],
  [{ autoFrameMeta: { analysisNeedsReview: true } }, 'reviewFrame'],
  [{ autoFrameMeta: { frameIncomplete: true } }, 'reviewFrame'],
  [{ filmTypeConfidence: 'low', filmTypeSource: 'auto' }, 'reviewFilmType'],
  [{ wbAutoConfidence: 'low' }, 'reviewWhiteBalance'],
  [{ rollFrame: { outlier: true } }, 'reviewRoll'],
  [{ filmEdge: { found: true, polarity: 'light', filmKind: 'color' } }, 'reviewDx'],
]) {
  assert.deepEqual(frameNeedsReview({ settings }).reasons, [reason]);
  assert.equal(frameNeedsReview({ settings: { ...settings, reviewed: true } }).needs, false);
}
assert.equal(frameNeedsReview({ status: 'error', settings: { reviewed: true } }).needs, true, 'acknowledging never hides a load error');
assert.equal(frameNeedsReview({ settings: { wbAutoConfidence: 'low', grayPointSampled: true } }).needs, false);
assert.equal(frameNeedsReview({ settings: { filmTypeConfidence: 'low', filmTypeSource: 'manual' } }).needs, false);
assert.equal(frameNeedsReview({ settings: { autoFrameMeta: { confidenceLevel: 'low' }, cropRegion: { width: 10 } } }).needs, false);
assert.equal(frameNeedsReview({}).needs, false);
// While Apply Crop's crop-area detection decides the live photo's image area,
// its provisional miss outcome is no reason to look at the frame (R1-148);
// the other reasons stay.
const provisional = { cropRegion: { width: 10 }, wbAutoConfidence: 'low', autoFrame: { lastDiagnostics: { importAuto: true, method: 'manual-image-window', analysisNeedsReview: true } } };
assert.deepEqual(frameNeedsReview({}, provisional).reasons, ['reviewFrame', 'reviewWhiteBalance']);
assert.deepEqual(frameNeedsReview({}, provisional, { areaPending: true }).reasons, ['reviewWhiteBalance']);
assert.deepEqual(frameNeedsReview({ status: 'error' }, provisional, { areaPending: true }).reasons, ['reviewLoadError', 'reviewWhiteBalance']);
console.log('review queue: all reasons and manual resolution passed');
