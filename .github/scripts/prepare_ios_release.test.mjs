import assert from 'node:assert/strict';
import { buildNumber, nextVersion, releasePlan } from './prepare_ios_release.mjs';

assert.equal(nextVersion('1.0.0', ['v1.0.99', 'ios/v1.0.0-beta']), '1.0.0');
assert.equal(nextVersion('1.0.0', ['ios/v1.0.9', 'ios/v1.0.10', 'v2.0.0']), '1.0.11');
assert.equal(nextVersion('1.1.0', ['ios/v1.0.99']), '1.1.0');
assert.equal(nextVersion('1.0.0', ['ios/v2.0.0']), '2.0.1');
assert.throws(() => nextVersion('1.00.0', []));
assert.throws(() => nextVersion('1.0.0', ['ios/v1.0.9999']), /overflow/);
assert.equal(buildNumber('1', '1'), '1.1');
assert.equal(buildNumber('100', '2'), '100.2');
for (const pair of [['0', '1'], ['1', '0'], ['10000', '1'], ['1', '100'], ['1\nfoo=bar', '1'], ['01', '1']]) {
  assert.throws(() => buildNumber(...pair));
}
const pending = { initialVersion: '1.0.0', appStoreSubmissionReady: false };
assert.throws(() => releasePlan(pending, [], '1', '1', 'app-store'), /acceptance is incomplete/);
assert.throws(() => releasePlan(pending, [], '1', '1', 'unknown'), /Unknown/);
assert.throws(() => releasePlan({ ...pending, appStoreSubmissionReady: 'true' }, [], '1', '1', 'app-store'));
const beta = releasePlan(pending, ['v1.0.38'], '1', '1', 'testflight');
assert.deepEqual(beta.config, { version: '1.0.0', bundle: { iOS: { bundleVersion: '1.1' } } });
assert.equal(beta.tag, 'ios/v1.0.0');
const release = releasePlan({ ...pending, appStoreSubmissionReady: true }, ['ios/v1.0.0'], '2', '1', 'app-store');
assert.equal(release.version, '1.0.1');
console.log('iOS version isolation, retry numbering and first-submission gates passed');
