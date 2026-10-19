import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextVersion(initialVersion, tags) {
  assert.match(initialVersion, versionPattern, 'initialVersion must be x.y.z');
  const initial = initialVersion.split('.').map(Number);
  const versions = tags.filter(t => t.startsWith('ios/v'))
    .map(t => t.slice(5)).filter(v => versionPattern.test(v))
    .map(v => v.split('.').map(Number));
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  versions.sort(compare);
  const latest = versions.at(-1);
  const next = !latest || compare(initial, latest) > 0 ? initial : [latest[0], latest[1], latest[2] + 1];
  assert.ok(next.every(n => Number.isSafeInteger(n) && n < 10000), 'iOS version component overflow');
  return next.join('.');
}

export function buildNumber(runNumber, runAttempt) {
  // Apple CFBundleVersion: up to four digits, then two digits. The workflow's
  // run number is independent of the desktop/MAS build sequence.
  assert.match(String(runNumber), /^[1-9]\d{0,3}$/, 'iOS run number must be 1..9999');
  assert.match(String(runAttempt), /^[1-9]\d?$/, 'iOS run attempt must be 1..99');
  return `${runNumber}.${runAttempt}`;
}

export function releasePlan(config, tags, runNumber, runAttempt, channel) {
  assert.ok(['testflight', 'app-store'].includes(channel), 'Unknown iOS release channel');
  assert.equal(typeof config.appStoreSubmissionReady, 'boolean', 'Submission readiness must be explicit');
  if (channel === 'app-store') {
    assert.equal(config.appStoreSubmissionReady, true,
      'iOS App Store acceptance is incomplete; see docs/ios-release.md');
  }
  const version = nextVersion(config.initialVersion, tags);
  const build = buildNumber(runNumber, runAttempt);
  return { version, build, channel, tag: `ios/v${version}`,
    config: { version, bundle: { iOS: { bundleVersion: build } } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(resolve(root, 'fastlane/ios/release.json'), 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', 'ios/v*'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const plan = releasePlan(config, tags, process.env.GITHUB_RUN_NUMBER,
    process.env.GITHUB_RUN_ATTEMPT, process.env.IOS_RELEASE_CHANNEL);
  const output = resolve(root, 'output/ios-release');
  mkdirSync(output, { recursive: true });
  const overlay = resolve(output, 'tauri.store.json');
  writeFileSync(overlay, `${JSON.stringify(plan.config, null, 2)}\n`);
  writeFileSync(resolve(output, 'plan.json'), `${JSON.stringify({ ...plan,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  }, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${plan.version}\nbuild=${plan.build}\ntag=${plan.tag}\nconfig=${overlay}\n`);
  }
  console.log(`iOS ${plan.version} (${plan.build}) -> ${plan.channel}`);
}
