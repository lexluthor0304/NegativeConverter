#!/usr/bin/env node
// Plans the next iOS release and decides whether ios-release.yml publishes it
// (docs/ios-release.md). Every push to main, the two-hourly schedule and a
// manual dispatch run it on the check job; the macOS publish job runs it
// again to write the Tauri version overlay and the store's "What's New".
//
// Environment: IOS_RELEASE_CHANNEL (app-store, the default, or testflight),
//   GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT; ASC_API_KEY_ID, ASC_API_ISSUER_ID
//   and ASC_API_KEY_P8 to ask App Store Connect whether a version is in flight
//   (without them the lane goes ahead and deliver reports the state itself).
// Outputs (GITHUB_OUTPUT when set, always printed):
//   version=x.y.z build=<run>.<attempt> tag=ios/vx.y.z previous_tag=ios/v…|''
//   config=<Tauri overlay> decision=publish|skip|paused|blocked|done reason=<one line>
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascClientFromEnv } from '../../scripts/asc-api.mjs';
import { decideStorePublish, fetchStoreVersions, printStoreVersions, storeVersionsTable } from './asc_mas_state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const BUNDLE_ID = 'com.neoanaloglab.negativeconverter';
export const RELEASE_NOTES_PATH = 'fastlane/ios/metadata/en-US/release_notes.txt';

// The highest ios/v* tag (created after each App Store submission), or null.
export function latestTag(tags) {
  const versions = tags.filter((tag) => tag.startsWith('ios/v'))
    .map((tag) => tag.slice(5)).filter((version) => versionPattern.test(version))
    .map((version) => version.split('.').map(Number));
  versions.sort(compare);
  const latest = versions.at(-1);
  return latest ? { tag: `ios/v${latest.join('.')}`, version: latest } : null;
}

export function nextVersion(initialVersion, tags) {
  assert.match(initialVersion, versionPattern, 'initialVersion must be x.y.z');
  const initial = initialVersion.split('.').map(Number);
  const latest = latestTag(tags)?.version;
  const next = !latest || compare(initial, latest) > 0 ? initial : [latest[0], latest[1], latest[2] + 1];
  assert.ok(next.every((n) => Number.isSafeInteger(n) && n < 10000), 'iOS version component overflow');
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
  const version = nextVersion(config.initialVersion, tags);
  const build = buildNumber(runNumber, runAttempt);
  return { version, build, channel, tag: `ios/v${version}`, previousTag: latestTag(tags)?.tag ?? null,
    config: { version, bundle: { iOS: { bundleVersion: build } } } };
}

// Changes that leave the iPhone/iPad app as it is: tests, fixtures,
// benchmarks, documentation, CI and the desktop/Mac App Store lanes. A push
// that only touches these submits nothing (the iOS counterpart of
// desktop-release.yml's paths-ignore). Anything else, including the store
// copy and screenshots under fastlane/ios, is a new version.
export const IGNORED_PATHS = [
  '.github/**', '.gitattributes', '.gitignore', 'CLAUDE.md', 'LICENSE', 'README.md', 'img/**',
  'docs/**', 'vercel.json', 'negative2positive/vercel.json',
  'negative2positive/**/*.test.mjs', 'negative2positive/test-fixtures/**',
  'scripts/**/*.test.mjs', 'scripts/perf/**', 'scripts/run-tests.mjs', 'scripts/smoke-test.mjs',
  'scripts/*-smoke.mjs', 'scripts/bench*.mjs', 'scripts/benchmark-*.mjs', 'scripts/eval-*.mjs',
  'scripts/check-*.mjs', 'scripts/test-*.py', 'scripts/verify-*.py', 'scripts/ios-*',
  'scripts/asc-api.mjs', 'scripts/appstore-screenshots.mjs', 'scripts/build-mas.sh',
  'fastlane/Fastfile', 'fastlane/metadata/**', 'fastlane/screenshots/**', 'fastlane/ios/release.json',
];

// `**` spans directories, `*` stays within one path segment.
export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else { source += '.*'; index += 1; }
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`);
}

const ignored = IGNORED_PATHS.map(globToRegExp);

export function relevantChanges(files) {
  return files.filter((file) => file && !ignored.some((pattern) => pattern.test(file)));
}

// previousTag: the last submitted ios/v* tag or null (first version);
// changedFiles: `git diff --name-only previousTag HEAD`;
// storeVersions: App Store Connect's IOS versions, or null when not asked.
export function decideIosRelease({ channel, ready, previousTag, changedFiles, storeVersions, version }) {
  if (channel === 'testflight') return { decision: 'publish', reason: 'TestFlight upload; the App Store gates do not apply' };
  if (!ready) return { decision: 'paused', reason: 'fastlane/ios/release.json has appStoreSubmissionReady=false' };
  if (previousTag && !relevantChanges(changedFiles).length) {
    return { decision: 'skip', reason: `no app change since ${previousTag}` };
  }
  if (!storeVersions) {
    return { decision: 'publish', reason: `App Store Connect was not asked (no API credentials); deliver creates ${version}` };
  }
  const result = decideStorePublish(storeVersions, version, 'iOS');
  if (result.decision === 'done') {
    result.reason += `; tag that submission's commit as ios/v${version} so the sequence moves on`;
  }
  return result;
}

// "What's New" from the commit subjects since the previous submission:
// conventional-commit noise (ci, docs, test, chore, …) is dropped, feat/fix/perf
// prefixes become words, PR numbers go, and the text stays under Apple's limit.
const DROPPED_SUBJECTS = /^(ci|docs?|tests?|chore|build|refactor|style|release|revert|bench)(\([^)]*\))?!?:/i;
const KEPT_PREFIX = /^(feat|fix|perf)(\([^)]*\))?!?:\s*/i;
const PREFIX_WORDS = { feat: '', fix: 'Fixed: ', perf: 'Performance: ' };

export function whatsNew(subjects, limit = 3500) {
  const lines = [];
  for (const raw of subjects) {
    let subject = raw.trim();
    if (!subject || DROPPED_SUBJECTS.test(subject)) continue;
    const prefix = subject.match(KEPT_PREFIX);
    if (prefix) subject = PREFIX_WORDS[prefix[1].toLowerCase()] + subject.slice(prefix[0].length);
    subject = subject.replace(/\s*\(#\d+\)$/, '').trim();
    if (!subject) continue;
    const line = `- ${subject[0].toUpperCase()}${subject.slice(1)}`;
    if (!lines.includes(line)) lines.push(line);
  }
  let text = '';
  for (const line of lines) {
    if ([...text].length + [...line].length + 1 > limit) break;
    text += `${line}\n`;
  }
  return text.trimEnd();
}

async function main() {
  const config = JSON.parse(readFileSync(resolve(root, 'fastlane/ios/release.json'), 'utf8'));
  const channel = process.env.IOS_RELEASE_CHANNEL || 'app-store';
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const tags = git('tag', '--list', 'ios/v*').split('\n').filter(Boolean);
  const plan = releasePlan(config, tags, process.env.GITHUB_RUN_NUMBER ?? '1', process.env.GITHUB_RUN_ATTEMPT ?? '1', channel);
  const commit = git('rev-parse', 'HEAD');
  const changedFiles = plan.previousTag ? git('diff', '--name-only', plan.previousTag, 'HEAD').split('\n').filter(Boolean) : [];
  const relevant = relevantChanges(changedFiles);

  let storeVersions = null;
  const credentials = ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_P8'].every((name) => process.env[name]);
  if (channel === 'app-store' && config.appStoreSubmissionReady && credentials) {
    ({ versions: storeVersions } = await fetchStoreVersions(ascClientFromEnv(), BUNDLE_ID, 'IOS'));
    printStoreVersions('IOS', BUNDLE_ID, storeVersions);
  }

  const result = decideIosRelease({
    channel, ready: config.appStoreSubmissionReady, previousTag: plan.previousTag, changedFiles, storeVersions, version: plan.version,
  });

  let notes = '';
  if (channel === 'app-store' && plan.previousTag) {
    notes = whatsNew(git('log', '--no-merges', '--pretty=format:%s', `${plan.previousTag}..HEAD`).split('\n'));
    if (notes) writeFileSync(resolve(root, RELEASE_NOTES_PATH), `${notes}\n`);
  }

  const output = resolve(root, 'output/ios-release');
  mkdirSync(output, { recursive: true });
  const overlay = resolve(output, 'tauri.store.json');
  writeFileSync(overlay, `${JSON.stringify(plan.config, null, 2)}\n`);
  writeFileSync(resolve(output, 'plan.json'), `${JSON.stringify({
    ...plan, commit, decision: result.decision, reason: result.reason, relevantChanges: relevant,
  }, null, 2)}\n`);

  if (plan.previousTag) console.log(`${relevant.length} app change(s) since ${plan.previousTag} (${changedFiles.length} file(s) in all)`);
  else console.log('first iOS version: no ios/v* tag yet');
  if (notes) console.log(`What's New (${[...notes].length} chars):\n${notes}`);
  console.log(`iOS ${plan.version} (${plan.build}) -> ${channel}: ${result.decision}`);
  console.log(`decision=${result.decision}`);
  console.log(`reason=${result.reason}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `version=${plan.version}`, `build=${plan.build}`, `tag=${plan.tag}`, `previous_tag=${plan.previousTag ?? ''}`,
      `config=${overlay}`, `decision=${result.decision}`, `reason=${result.reason}`, '',
    ].join('\n'));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const since = plan.previousTag ? `${relevant.length} app change(s) since ${plan.previousTag}` : 'first iOS version';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### iOS ${plan.version} (${plan.build}) → ${channel}: ${result.decision}`, '', `${result.reason}. ${since}.`, '',
      storeVersions ? storeVersionsTable(storeVersions) : '', notes ? `What's New:\n\n${notes}\n` : '',
    ].join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`prepare_ios_release: ${error.message}`);
    process.exit(1);
  }
}
