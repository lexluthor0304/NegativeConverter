import assert from 'node:assert/strict';
import { buildNumber, decideIosRelease, latestTag, nextVersion, releasePlan } from './prepare_ios_release.mjs';

// Version isolation from the desktop v* tags.
assert.equal(nextVersion('1.0.0', ['v1.0.99', 'ios/v1.0.0-beta']), '1.0.0');
assert.equal(nextVersion('1.0.0', ['ios/v1.0.9', 'ios/v1.0.10', 'v2.0.0']), '1.0.11');
assert.equal(nextVersion('1.1.0', ['ios/v1.0.99']), '1.1.0');
assert.equal(nextVersion('1.0.0', ['ios/v2.0.0']), '2.0.1');
assert.throws(() => nextVersion('1.00.0', []));
assert.throws(() => nextVersion('1.0.0', ['ios/v1.0.9999']), /overflow/);
assert.equal(latestTag(['v1.0.47', 'ios/v1.0.9', 'ios/v1.0.10']).tag, 'ios/v1.0.10');
assert.equal(latestTag(['v1.0.47']), null);

// Build numbers from the workflow run.
assert.equal(buildNumber('1', '1'), '1.1');
assert.equal(buildNumber('100', '2'), '100.2');
for (const pair of [['0', '1'], ['1', '0'], ['10000', '1'], ['1', '100'], ['1\nfoo=bar', '1'], ['01', '1']]) {
  assert.throws(() => buildNumber(...pair));
}

// The plan: readiness is a decision now, not an exception.
const pending = { initialVersion: '1.0.0', appStoreSubmissionReady: false };
assert.throws(() => releasePlan(pending, [], '1', '1', 'unknown'), /Unknown/);
assert.throws(() => releasePlan({ ...pending, appStoreSubmissionReady: 'true' }, [], '1', '1', 'app-store'));
const beta = releasePlan(pending, ['v1.0.38'], '1', '1', 'testflight');
assert.deepEqual(beta.config, { version: '1.0.0', bundle: { iOS: { bundleVersion: '1.1' } } });
assert.equal(beta.tag, 'ios/v1.0.0');
assert.equal(beta.previousTag, null);
const release = releasePlan({ ...pending, appStoreSubmissionReady: true }, ['ios/v1.0.0'], '2', '1', 'app-store');
assert.equal(release.version, '1.0.1');
assert.equal(release.previousTag, 'ios/v1.0.0');

// The decision, in order of precedence.
const live = [{ versionString: '1.0.0', state: 'READY_FOR_DISTRIBUTION' }];
const base = { channel: 'app-store', ready: true, previousTag: 'ios/v1.0.0',
  changedFiles: ['negative2positive/src/app/main.js'], storeVersions: live, version: '1.0.1' };
assert.deepEqual(decideIosRelease(base), { decision: 'publish', reason: 'no iOS version is in flight; deliver creates 1.0.1' });
assert.equal(decideIosRelease({ ...base, channel: 'testflight', ready: false, changedFiles: [] }).decision, 'publish');
assert.equal(decideIosRelease({ ...base, ready: false }).decision, 'paused');
assert.equal(decideIosRelease({ ...base, ready: false, changedFiles: [] }).decision, 'paused');
assert.deepEqual(decideIosRelease({ ...base, changedFiles: ['docs/a.md', '.github/workflows/ios-release.yml'] }),
  { decision: 'skip', reason: 'no app change since ios/v1.0.0' });
assert.equal(decideIosRelease({ ...base, changedFiles: [], storeVersions: [{ versionString: '1.0.0', state: 'IN_REVIEW' }] }).decision, 'skip');
assert.equal(decideIosRelease({ ...base, previousTag: null, changedFiles: [], version: '1.0.0', storeVersions: [] }).decision, 'publish');
assert.match(decideIosRelease({ ...base, storeVersions: null }).reason, /not asked/);
const blocked = decideIosRelease({ ...base, storeVersions: [{ versionString: '1.0.0', state: 'IN_REVIEW' }] });
assert.equal(blocked.decision, 'blocked');
assert.equal(blocked.reason, '1.0.0 is IN_REVIEW; App Store Connect allows one iOS version in flight');
const done = decideIosRelease({ ...base, storeVersions: [{ versionString: '1.0.1', state: 'WAITING_FOR_REVIEW' }, ...live] });
assert.equal(done.decision, 'done');
assert.match(done.reason, /tag that submission's commit as ios\/v1\.0\.1/);
assert.equal(decideIosRelease({ ...base, storeVersions: [{ versionString: '1.0.1', state: 'DEVELOPER_REJECTED' }, ...live] }).decision, 'publish');

console.log('iOS version isolation and release decision passed');
