import assert from 'node:assert/strict';
import { canPublishThumbnail, THUMBNAIL_RANK } from './thumbnailRank.js';

assert.ok(THUMBNAIL_RANK.embedded < THUMBNAIL_RANK.analysis && THUMBNAIL_RANK.analysis < THUMBNAIL_RANK.processed);
for (const kind of ['embedded', 'analysis']) {
  assert.equal(canPublishThumbnail({ thumbnail: null }, kind), true, `${kind} fills an empty tile`);
  assert.equal(canPublishThumbnail({ thumbnail: 'data:e', thumbnailKind: 'embedded' }, kind), true, `${kind} refreshes an embedded tile`);
  assert.equal(canPublishThumbnail({ thumbnail: 'data:a', thumbnailKind: 'analysis' }, kind), false, `${kind} never replaces analysis`);
  assert.equal(canPublishThumbnail({ thumbnail: 'data:p', thumbnailKind: 'processed' }, kind), false, `${kind} never replaces processed`);
  // Restored projects carry a thumbnail without a kind: treat it as converted.
  assert.equal(canPublishThumbnail({ thumbnail: 'data:x' }, kind), false);
}
assert.equal(canPublishThumbnail({ thumbnail: null }, 'processed'), false, 'canonical tiles keep their own paths');
assert.equal(canPublishThumbnail(null, 'embedded'), false);
assert.equal(canPublishThumbnail({}, 'unknown'), false);
console.log('thumbnailRank tests passed: embedded < analysis < processed, never downgraded');
