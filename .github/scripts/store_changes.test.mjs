import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  changesTheApp, classifyCommit, globToRegExp, readCommits, relevantChanges, whatsNew,
} from './store_changes.mjs';

// Which changes make a new iOS version.
assert.ok(globToRegExp('negative2positive/**/*.test.mjs').test('negative2positive/src/app/main.test.mjs'));
assert.ok(globToRegExp('negative2positive/**/*.test.mjs').test('negative2positive/x.test.mjs'));
assert.ok(!globToRegExp('scripts/*-smoke.mjs').test('scripts/perf/x-smoke.mjs'));
assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
assert.deepEqual(relevantChanges([
  'docs/ios-release.md', '.github/workflows/ios-release.yml', '.github/scripts/prepare_ios_release.mjs',
  'negative2positive/src/app/main.test.mjs', 'negative2positive/test-fixtures/a.jpg', 'scripts/studio-smoke.mjs',
  'scripts/run-tests.mjs', 'scripts/perf/budgets.json', 'scripts/check-ios-store-assets.mjs', 'scripts/ios-ensure-store-profile.mjs',
  'scripts/verify-ios-package.py', 'scripts/asc-api.mjs', 'CLAUDE.md', 'README.md', 'fastlane/Fastfile',
  'fastlane/metadata/en-US/release_notes.txt', 'fastlane/screenshots/en-US/mac.png', 'fastlane/ios/release.json',
]), []);
assert.deepEqual(relevantChanges(['negative2positive/src/app/main.js', 'docs/x.md']), ['negative2positive/src/app/main.js']);
for (const file of ['src-tauri/src/lib.rs', 'src-tauri/tauri.ios.conf.json', 'package-lock.json', 'wasm/png-deflate/src/lib.rs',
  'negative2positive/vendor/libraw-wasm/libraw.wasm', 'scripts/build-ui-fonts.mjs', 'scripts/opencv-assets.mjs',
  'fastlane/ios/metadata/en-US/description.txt', 'fastlane/ios/screenshots/en-US/iphone-medium-01-editor.png']) {
  assert.deepEqual(relevantChanges([file]), [file], file);
}

// What customers can notice: the store listing submits a version but is not news.
assert.equal(changesTheApp(['CLAUDE.md']), false);
assert.equal(changesTheApp(['docs/ios-release.md', 'scripts/darkroom-smoke.mjs', '.github/workflows/mas-publish.yml']), false);
assert.equal(changesTheApp(['fastlane/ios/metadata/en-US/description.txt', 'fastlane/ios/screenshots/en-US/a.png']), false);
assert.equal(changesTheApp([]), false);
assert.equal(changesTheApp(['CLAUDE.md', 'negative2positive/src/app/main.js']), true);

// What's New from bare subjects (the iOS lane's rules since #326).
assert.equal(whatsNew([
  'feat: automatic colour correction replaces the one-click button; iOS icon from the Mac icon (#322)',
  'ci: run the unit suite in parallel and the smoke in four shards (#323)',
  'fix(ios): crash when importing HEIC',
  'docs: release notes',
  'perf!: faster 16-bit export',
  'Tidy the welcome screen',
  '',
  'feat: automatic colour correction replaces the one-click button; iOS icon from the Mac icon (#322)',
]), [
  '- Automatic colour correction replaces the one-click button; iOS icon from the Mac icon',
  '- Fixed: crash when importing HEIC',
  '- Performance: faster 16-bit export',
  '- Tidy the welcome screen',
].join('\n'));
assert.equal(whatsNew(['ci: a', 'docs: b', 'chore(deps): c', 'refactor: d', 'test: e', 'Revert "feat: f"']), '');
const long = whatsNew(Array.from({ length: 400 }, (_, i) => `feat: change number ${i} with a reasonably long subject line`));
assert.ok([...long].length <= 3500 && long.endsWith('subject line'), 'cut at a line boundary under the limit');

// Mac 1.0.49 (2026-11-02): the store showed "docs: CLAUDE.md names every
// platform the app ships on (#328)" under the perf subject, prefixes and PR
// numbers included. Neither the type nor the subject has to be right for the
// documentation to stay out: a commit that does not change the app is no news.
const app = ['negative2positive/src/app/dustDetector.js', 'negative2positive/src/app/dustDetector.test.mjs'];
const perf329 = { subject: 'perf: exact speedups with lower peak memory (dust detection, analysis histogram, RAW post-decode, Step 3) (#329)', files: app };
const docs328 = { subject: 'docs: CLAUDE.md names every platform the app ships on (#328)', files: ['CLAUDE.md'] };
assert.equal(whatsNew([perf329, docs328]),
  '- Performance: exact speedups with lower peak memory (dust detection, analysis histogram, RAW post-decode, Step 3)');
assert.deepEqual(classifyCommit(docs328), { lines: [], reason: 'does not change the app' });
for (const subject of ['feat: CLAUDE.md names every platform the app ships on', 'fix: the guide names every platform', 'Name every platform']) {
  assert.deepEqual(classifyCommit({ subject, files: ['CLAUDE.md', 'docs/ios-release.md'] }).lines, [], subject);
}
assert.deepEqual(classifyCommit({ subject: 'fix: give the harness tests the crop-detection hooks', files: ['negative2positive/src/app/x.test.mjs'] }).lines, []);

// Issue numbers go wherever they stand.
assert.equal(whatsNew([{ subject: 'fix: readable tips (#313); Nikon NEFX and more camera RAWs (#321, #268) (#327)', files: app }]),
  '- Fixed: readable tips; Nikon NEFX and more camera RAWs');

// A clause about tests, smokes, CI or docs leaves the line; one that is only
// that leaves nothing. A darkroom test strip is not a test.
assert.equal(whatsNew([{
  subject: "fix(a11y): keep the hidden file inputs out of the tab order; settle the darkroom smoke's paper readings (#335)",
  files: ['negative2positive/index.html', 'scripts/darkroom-smoke.mjs'],
}]), '- Fixed: keep the hidden file inputs out of the tab order');
assert.equal(whatsNew([{ subject: "fix: settle the darkroom smoke's paper readings; keep the inputs out of the tab order", files: app }]),
  '- Fixed: keep the inputs out of the tab order');
for (const subject of ['fix: let smoke probes on the 2D prototype see #canvas writes again', 'perf: keep bench:interactive --quick within its time budget',
  'fix: CI timing flakes', 'feat: document the export pipeline in docs', 'fix: unit tests for the crop box']) {
  assert.deepEqual(classifyCommit({ subject, files: app }), { lines: [], reason: 'only about how the app is built or checked' }, subject);
}
assert.equal(whatsNew([{ subject: 'feat: darkroom test strips in five steps; unit tests for the strip maths', files: app }]),
  '- Darkroom test strips in five steps');

// A commit's own Whats-New lines say it for customers, and override the subject.
const named = classifyCommit({
  subject: 'perf: dust level map (half the kept state), word-wise 8-bit promotion (#330)',
  body: 'Detail for reviewers.\n\nWhats-New: Dust detection uses less memory on large scans.\n'
    + "What's New: - removing dust repaints faster\nCo-Authored-By: Someone <someone@example.com>\n",
  files: app,
});
assert.deepEqual(named, { lines: ['Dust detection uses less memory on large scans.', 'removing dust repaints faster'], reason: 'its Whats-New line' });
assert.deepEqual(classifyCommit({ subject: 'feat: new export dialog', body: 'Whats-New: none\n', files: app }), { lines: [], reason: 'Whats-New: none' });
assert.deepEqual(classifyCommit({ subject: 'chore(deps): bump LibRaw', body: 'Whats-New: Opens RAW files from the Nikon Z5 II.', files: ['package-lock.json'] }).lines,
  ['Opens RAW files from the Nikon Z5 II.']);
assert.deepEqual(classifyCommit({ subject: 'docs: what is new', body: 'Whats-New: Faster export.', files: ['CLAUDE.md'] }).lines, []);
assert.equal(whatsNew([{ subject: 'fix: a', body: 'Whats-New: removing dust repaints faster', files: app }, { subject: 'fix: b', files: app }]),
  '- Removing dust repaints faster\n- Fixed: b');

// readCommits against a scratch repository: subjects, bodies and files per commit.
const repo = mkdtempSync(join(tmpdir(), 'store-changes-'));
try {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message, files) => {
    for (const file of files) {
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), `${message}\n`);
    }
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  const first = commit('chore: start', ['README.md']);
  commit('docs: CLAUDE.md names every platform the app ships on (#328)', ['CLAUDE.md']);
  commit("fix(a11y): keep the hidden file inputs out of the tab order; settle the darkroom smoke's paper readings (#335)\n\n"
    + 'Keyboard focus details.\n\nWhats-New: Keyboard users no longer stop on hidden file pickers.\n',
  ['negative2positive/index.html', 'scripts/darkroom-smoke.mjs']);
  const commits = readCommits(first, 'HEAD', repo);
  assert.deepEqual(commits.map(({ subject, files }) => ({ subject, files })), [
    { subject: "fix(a11y): keep the hidden file inputs out of the tab order; settle the darkroom smoke's paper readings (#335)",
      files: ['negative2positive/index.html', 'scripts/darkroom-smoke.mjs'] },
    { subject: 'docs: CLAUDE.md names every platform the app ships on (#328)', files: ['CLAUDE.md'] },
  ]);
  assert.match(commits[0].body, /^Keyboard focus details\./);
  assert.equal(whatsNew(commits), '- Keyboard users no longer stop on hidden file pickers.');
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("App paths and the store What's New passed");
