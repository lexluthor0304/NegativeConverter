#!/usr/bin/env node
// What of a change reaches the store apps (docs/ios-release.md,
// docs/mas-release.md): which files are the app, and the "What's New" that
// store customers read. The iOS lane (prepare_ios_release.mjs) imports both;
// the Mac App Store lane (mas-publish.yml) runs this file for its What's New.
//
// What's New is for the photographers who use the app: what they can notice,
// and nothing about how the app is made. No documentation (CLAUDE.md, docs/),
// CI, tests, smokes, benchmarks, commit types or PR numbers: Mac 1.0.49 went
// out with the raw subject "docs: CLAUDE.md names every platform the app
// ships on (#328)" (2026-11-02).
//
// Usage: node .github/scripts/store_changes.mjs --since <ref> [--until <ref>] [--out <file>]
//   prints each commit of since..until (until: HEAD) with its verdict, then
//   the What's New; --out writes it, an empty file when nothing is news, so
//   the lane's fallback sentence applies. An empty --since means no previous
//   version, and no What's New.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

// Whether store customers can notice a commit at all: it changes a file of
// the app, not only the ignored ones or the store listing under fastlane/
// (new copy or screenshots are a reason to submit, not news).
export function changesTheApp(files) {
  return relevantChanges(files).some((file) => !file.startsWith('fastlane/'));
}

// A commit names its What's New itself with "Whats-New:" lines in its message
// (also spelt "What's New:"), one entry per line, written for customers;
// "Whats-New: none" says it is not news. Squash merges keep the commit
// messages (the repository's COMMIT_MESSAGES setting), so the line reaches main.
const NAMED = /^[ \t]*what['’]?s[ -]new[ \t]*:[ \t]*(.*?)[ \t]*$/gim;
const NOT_NEWS = /^(?:none|n\/a|-)?$/i;

// Without such a line the subject speaks, if it is a feat, fix or perf one:
// other conventional types are dropped, feat/fix/perf prefixes become words,
// issue and PR numbers go, and so does any "; "-separated clause about how
// the app is built or checked (a test strip is a darkroom print, not a test).
const DROPPED_SUBJECTS = /^(?:(?:ci|docs?|tests?|chore|build|refactor|style|release|revert|bench)(?:\([^)]*\))?!?:|revert\b)/i;
const KEPT_PREFIX = /^(feat|fix|perf)(\([^)]*\))?!?:\s*/i;
const PREFIX_WORDS = { feat: '', fix: 'Fixed: ', perf: 'Performance: ' };
const ISSUE_REFERENCES = /\s*\((?:\s*#\d+\s*,?)+\)|\s*#\d+\b/g;
const INTERNAL = /\b(?:CLAUDE\.md|AGENTS\.md|README|docs?|documentation|smokes?|bench(?:mark)?s?|fixtures?|harness(?:es)?|flak(?:e|y|iness)|lint(?:er|ing)?|audit[- ]backlog|dependabot)\b|\bCI\b|\btests?\b(?!\s*strips?\b)/i;

// commit: { subject, body, files } (files and body optional; a bare string is
// a subject). Returns the What's New lines it contributes and why.
export function classifyCommit(commit) {
  const { subject = '', body = '', files } = typeof commit === 'string' ? { subject: commit } : commit;
  const title = subject.trim();
  if (!title) return { lines: [], reason: 'no subject' };
  if (files && !changesTheApp(files)) return { lines: [], reason: 'does not change the app' };
  const named = [...body.matchAll(NAMED)].map((match) => match[1].replace(/^[-*]\s+/, '').trim());
  if (named.length) {
    const lines = named.filter((line) => !NOT_NEWS.test(line));
    return { lines, reason: lines.length ? 'its Whats-New line' : 'Whats-New: none' };
  }
  if (DROPPED_SUBJECTS.test(title)) return { lines: [], reason: 'not a feat, fix or perf subject' };
  const prefix = title.match(KEPT_PREFIX);
  const rest = (prefix ? title.slice(prefix[0].length) : title).replace(ISSUE_REFERENCES, '');
  const clauses = rest.split(/\s*;\s*/).map((clause) => clause.trim()).filter(Boolean);
  const kept = clauses.filter((clause) => !INTERNAL.test(clause));
  if (!kept.length) return { lines: [], reason: 'only about how the app is built or checked' };
  const text = (prefix ? PREFIX_WORDS[prefix[1].toLowerCase()] : '') + kept.join('; ');
  const reason = kept.length < clauses.length ? 'subject, without its internal clauses' : 'subject';
  return { lines: [text], reason };
}

// The What's New of a list of commits (newest first, as git log gives them),
// one "- " line per entry, without repeats, cut at a line under `limit`
// characters (Apple allows 4000).
export function whatsNew(commits, limit = 3500) {
  const lines = [];
  for (const commit of commits) {
    for (const entry of classifyCommit(commit).lines) {
      const line = `- ${entry[0].toUpperCase()}${entry.slice(1)}`;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  let text = '';
  for (const line of lines) {
    if ([...text].length + [...line].length + 1 > limit) break;
    text += `${line}\n`;
  }
  return text.trimEnd();
}

// The commits of since..until without merge commits, newest first:
// [{ hash, subject, body, files }].
export function readCommits(since, until = 'HEAD', cwd = root) {
  const log = execFileSync('git', [
    '-c', 'core.quotePath=false', 'log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b%x1f', '--name-only',
    '--end-of-options', `${since}..${until}`, '--',
  ], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return log.split('\x1e').slice(1).map((record) => {
    const [hash, subject, body, files = ''] = record.split('\x1f');
    return { hash, subject, body, files: files.split('\n').map((file) => file.trim()).filter(Boolean) };
  });
}

// One line per commit for the workflow log: what became news and what did not.
export function printVerdicts(commits) {
  for (const commit of commits) {
    const { lines, reason } = classifyCommit(commit);
    console.log(`${lines.length ? 'news   ' : 'skipped'} ${commit.hash.slice(0, 8)} ${commit.subject} [${reason}]`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1] ?? '';
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ?? '';
  const commits = since ? readCommits(since, args.until || 'HEAD') : [];
  if (since) printVerdicts(commits);
  else console.log("No previous version: no What's New.");
  const notes = whatsNew(commits);
  if (args.out) writeFileSync(args.out, notes ? `${notes}\n` : '');
  console.log(`What's New since ${since || '-'} (${[...notes].length} chars):\n${notes || "(nothing is news; the lane's fallback sentence applies)"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`store_changes: ${error.message}`);
    process.exit(1);
  }
}
