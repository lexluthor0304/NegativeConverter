import assert from 'node:assert/strict';
import { decideStorePublish, nextBuildNumber, storeVersionsTable } from './asc_mas_state.mjs';

const live43 = { versionString: '1.0.43', state: 'REPLACED_WITH_NEW_VERSION' };
const live44 = { versionString: '1.0.44', state: 'READY_FOR_DISTRIBUTION' };

// The previous version is live: deliver creates the new one.
assert.deepEqual(decideStorePublish([live44, live43], '1.0.45'),
  { decision: 'publish', reason: 'no macOS version is in flight; deliver creates 1.0.45' });
assert.equal(decideStorePublish([], '1.0.45').decision, 'publish');

// The previous version is with Apple: defer (the 2026-10-09 / 2026-10-27 failure).
for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_REVIEW']) {
  const result = decideStorePublish([{ versionString: '1.0.44', state }, live43], '1.0.45');
  assert.equal(result.decision, 'blocked', state);
  assert.match(result.reason, /^1\.0\.44 is /);
}

// The iOS lane asks the same question about the IOS platform.
assert.equal(decideStorePublish([{ versionString: '1.0.0', state: 'WAITING_FOR_REVIEW' }], '1.0.1', 'iOS').reason,
  '1.0.0 is WAITING_FOR_REVIEW; App Store Connect allows one iOS version in flight');
assert.equal(decideStorePublish([{ versionString: '1.0.0', state: 'READY_FOR_DISTRIBUTION' }], '1.0.1', 'iOS').reason,
  'no iOS version is in flight; deliver creates 1.0.1');

// The release itself is already there: nothing to do, whatever its stage.
assert.equal(decideStorePublish([{ versionString: '1.0.45', state: 'IN_REVIEW' }, live44], '1.0.45').decision, 'done');
assert.equal(decideStorePublish([{ versionString: '1.0.45', state: 'READY_FOR_DISTRIBUTION' }], '1.0.45').decision, 'done');

// Editable versions are deliver's business: it renames or re-submits them.
assert.equal(decideStorePublish([{ versionString: '1.0.45', state: 'DEVELOPER_REJECTED' }, live44], '1.0.45').decision, 'publish');
assert.equal(decideStorePublish([{ versionString: '1.0.45', state: 'METADATA_REJECTED' }], '1.0.45').decision, 'publish');
assert.equal(decideStorePublish([{ versionString: '1.0.44', state: 'PREPARE_FOR_SUBMISSION' }, live43], '1.0.45').decision, 'publish');

// Build numbers: above every upload of the version, none → formula only.
assert.equal(nextBuildNumber([]), null);
assert.equal(nextBuildNumber(['100004500', '100004501']), 100004502);
assert.equal(nextBuildNumber(['100004500', 'n/a']), 100004501);

assert.equal(storeVersionsTable([{ ...live44, created: '2026-10-25T00:00:00Z' }]),
  '| Version | State | Created |\n| --- | --- | --- |\n| 1.0.44 | READY_FOR_DISTRIBUTION | 2026-10-25T00:00:00Z |\n');

console.log('asc_mas_state: ok');
