// Runs every *.test.mjs under negative2positive/src, negative2positive/api and
// scripts/perf (the benchmark harness; no browser) with plain node, several
// at a time (TEST_JOBS). Test files are standalone assert scripts.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [
  join(repoRoot, 'negative2positive', 'src'),
  join(repoRoot, 'negative2positive', 'api'),
  join(repoRoot, 'scripts', 'perf'),
].filter(existsSync);

const tests = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.mjs')) tests.push(p);
  }
}
roots.forEach(walk);

// Repo-wide consistency checks count as part of the suite
const scriptsDir = dirname(fileURLToPath(import.meta.url));
tests.push(join(scriptsDir, 'check-seo-heads.mjs'));
tests.push(join(scriptsDir, 'check-search-contract.mjs'));
tests.push(join(scriptsDir, 'check-pinned-versions.mjs'));
tests.push(join(scriptsDir, 'check-vercel-config.mjs'));
tests.push(join(scriptsDir, 'check-appstore-screenshots.mjs'));
tests.push(join(scriptsDir, 'check-updater-manifest.mjs'));
tests.push(join(scriptsDir, 'check-tauri-config.mjs'));
tests.push(join(scriptsDir, 'check-third-party-notices.mjs'));
// Its real check needs a build (CI runs it after `npm run build:web`).
tests.push([join(scriptsDir, 'check-dist-asset-names.mjs'), '--self-test']);
// The export digests the import parity and gain-map smokes compare.
tests.push(join(scriptsDir, 'export-parity-digest.test.mjs'));
tests.push(join(repoRoot, '.github/scripts/prepare_ios_release.test.mjs'));

// Test files run in parallel, each in its own node process: TEST_JOBS, else
// one per core up to four (the 383 files took 11.5 min one after another on
// a 4-core CI runner; the longest ones, a minute each, start first so they do
// not end the run alone). Each file's output is printed whole when it ends,
// so lines of different files never interleave. TEST_JOBS=1 is the old
// sequential run.
const JOBS = Math.max(1, Number(process.env.TEST_JOBS) || Math.min(4, availableParallelism()));
// A test that leaves an open handle would otherwise hang the whole suite;
// files sharing the machine get twice the time.
const TIMEOUT_MS = 120_000 * (JOBS > 1 ? 2 : 1);
const HEAVY = /interpretationHistory|provisionalHistoryAnalysis|aiInpaint\.memo|exportPlaneLifecycle|interpretationRoutes|displaySessions|dustColdUndo|dustStrokeHistory|processFileWithSettings\.parity/;
const queue = [...tests.filter(entry => HEAVY.test(String(Array.isArray(entry) ? entry[0] : entry))),
  ...tests.filter(entry => !HEAVY.test(String(Array.isArray(entry) ? entry[0] : entry)))];

function runOne(entry) {
  const [file, ...args] = Array.isArray(entry) ? entry : [entry];
  const label = [file, ...args].join(' ');
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); resolve({ label, ms: Date.now() - started, output: `${error.message}\n`, status: 1, timedOut }); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ label, ms: Date.now() - started, output: Buffer.concat(chunks).toString('utf8'),
        status: timedOut ? 1 : (status === null && signal ? 1 : status), timedOut });
    });
  });
}

let failed = 0;
let timedOut = 0;
async function worker() {
  for (;;) {
    const entry = queue.shift();
    if (!entry) return;
    const r = await runOne(entry);
    process.stdout.write(r.output);
    if (r.timedOut) {
      failed += 1;
      timedOut += 1;
      console.error(`TIMEOUT ${r.label} (killed after ${TIMEOUT_MS / 1000}s)`);
    } else if (r.status !== 0) {
      failed += 1;
      console.error(`FAIL ${r.label} (${r.ms}ms)`);
    } else {
      console.log(`PASS ${r.label} (${r.ms}ms)`);
    }
  }
}
const suiteStarted = Date.now();
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, worker));

console.log(`\n${tests.length - failed}/${tests.length} test files passed`
  + (timedOut ? ` (${timedOut} timed out)` : '') + ` in ${Math.round((Date.now() - suiteStarted) / 1000)} s with ${JOBS} job(s)`);
process.exit(failed ? 1 : 0);
