// The runner's orchestration without a browser or a build: ref preparation,
// repetitions interleaved across refs, the profiled repetition, summaries,
// the production assertion, compare/against exit codes, --record-baselines,
// outputs and cleanup, with the heavy steps stubbed.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nc-perf-runner-'));
process.env.NC_PERF_LOCK = join(dir, 'bench.lock');
const { main } = await import('./runner.mjs');

async function quiet(fn) {
  const log = console.log, error = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try { return { code: await fn(), text: lines.join('\n') }; } finally { console.log = log; console.error = error; }
}

// `rate(label)` gives the Brightness redraw rate a repetition of that ref reports.
function deps({ rate, suspicious = [], budgetsPath, calls = [], cleaned = [] }) {
  return {
    outBase: join(dir, 'out'),
    budgetsPath,
    readPressureLevel: async () => ({ level: 1, name: 'normal' }),
    freeDiskBytes: () => 100 * 1024 ** 3,
    waitForQuietMachine: async () => ({ noisy: false, load: 1, limit: 4, waitedMs: 0 }),
    findChrome: () => '/fake/chrome',
    prepareRef: async ({ label, ref, port, cdpPort }) => ({
      label, ref, sha: (label === 'base' ? 'a' : 'b').repeat(40), dirty: false, port, cdpPort, origin: `http://127.0.0.1:${port}`, dist: dir, exportDir: dir,
      worktree: { cleanup: async () => cleaned.push(`worktree:${label}`) }, preview: { stop: async () => cleaned.push(`preview:${label}`) }
    }),
    prepareFixtures: async () => ({
      singles: [], interactive: [{ name: 'synthetic-60mp-cfa.dng', path: '/f/synthetic-60mp-cfa.dng', sha256: 'f00d', synthetic: true }],
      roll: [], export: [], hang: [], smoke: []
    }),
    probeGpu: async ({ collector }) => { collector.gpu = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)'; collector.chromeVersion = 'Chrome/153.0.8010.53'; },
    suspiciousRequests: async origin => (origin.endsWith(':5298') ? suspicious : []),
    runRepetition: async ({ scenario, ref, rep, profiled, extra }) => {
      calls.push(`${ref.label}:${extra?.label || (profiled ? 'profiled' : `r${rep + 1}`)}`);
      return {
        label: `${ref.label}-${scenario.id}-${rep}`, ref: ref.label, rep, profiled, extra: extra?.label || null, status: 'ok',
        metrics: { 's2.coreExposure.dpr2.updatesPerSecond': rate(ref.label) + rep * 0.2, 's2.coreExposure.dpr2.probeSelfPct': 0.3, 's2.photo0.route': 'positive' },
        hashes: {}, routes: [{ photo: 'synthetic-60mp-cfa.dng', filmType: 'positive', route: 'positive' }], notes: [], raw: {}, hangs: [],
        profile: profiled ? { wallMs: 100, busyTotalMs: 80, coresUsed: 0.8, threads: [] } : undefined
      };
    }
  };
}

try {
  // --compare: interleaved repetitions, an improvement exits 0.
  const calls = [];
  const cleaned = [];
  const out = join(dir, 'compare');
  const improved = await quiet(() => main(['--compare', 'base', 'head', '--scenarios', 's2', '--reps', '3', '--out', out],
    deps({ rate: label => (label === 'head' ? 58 : 31), calls, cleaned })));
  assert.equal(improved.code, 0, improved.text);
  assert.deepEqual(calls, ['base:r1', 'head:r1', 'base:r2', 'head:r2', 'base:r3', 'head:r3', 'base:profiled', 'head:profiled'], 'A B A B …, then the profiled repetitions');
  assert.deepEqual(cleaned.sort(), ['preview:base', 'preview:head', 'worktree:base', 'worktree:head'], 'worktrees and servers are cleaned up');
  assert.equal(existsSync(process.env.NC_PERF_LOCK), false, 'the lock is released');
  const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  assert.deepEqual(results.runs.map(run => run.label), ['base', 'head']);
  const group = results.runs[1].scenarios.s2.fixtures['synthetic-60mp-cfa.dng'];
  assert.equal(group.summary['s2.coreExposure.dpr2.updatesPerSecond'].median, 58.2, 'the profiled repetition is not in the medians');
  assert.equal(group.summary['probe.selfPctMax'].median, 0.3);
  assert.equal(group.profile.coresUsed, 0.8);
  assert.equal(results.conditions.gpu, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)');
  assert.equal(results.conditions.browser.version, 'Chrome/153.0.8010.53');
  assert.equal(results.conditions.fixtures[0].sha256, 'f00d');
  assert.equal(results.runs[0].production, true);
  const row = results.compare.rows.find(entry => entry.key === 's2.coreExposure.dpr2.updatesPerSecond@synthetic-60mp-cfa.dng');
  assert.equal(row.status, 'improved');
  assert.match(improved.text, /\| `s2.coreExposure.dpr2.updatesPerSecond@synthetic-60mp-cfa.dng` \| ≥ 55 1\/s \| 31.2 \(31–31.4\) \| 58.2 \(58–58.4\) \| \+86.5 % \| improved \| – \|/);
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /## Compare/);

  // A regression beyond noise exits 1; so does a dev-server request.
  const regressed = await quiet(() => main(['--compare', 'base', 'head', '--scenarios', 's2', '--reps', '3', '--no-profile', '--out', join(dir, 'regressed')],
    deps({ rate: label => (label === 'head' ? 20 : 31) })));
  assert.equal(regressed.code, 1);
  const dev = await quiet(() => main(['--compare', 'base', 'head', '--scenarios', 's2', '--reps', '2', '--no-profile', '--out', join(dir, 'dev')],
    deps({ rate: () => 31, suspicious: [{ url: '/@vite/client' }] })));
  assert.equal(dev.code, 1, 'a request only a dev server sees invalidates the run');
  assert.equal(JSON.parse(readFileSync(join(dir, 'dev', 'results.json'), 'utf8')).runs[1].production, false);

  // --against a saved run: its head is "before", this run is "after".
  const same = await quiet(() => main(['--against', join(out, 'results.json'), '--scenarios', 's2', '--reps', '3', '--no-profile', '--out', join(dir, 'against')],
    deps({ rate: () => 58 })));
  assert.equal(same.code, 0, same.text);
  const slower = await quiet(() => main(['--against', join(out, 'results.json'), '--scenarios', 's2', '--reps', '3', '--no-profile', '--out', join(dir, 'against2')],
    deps({ rate: () => 31 })));
  assert.equal(slower.code, 1, 'met the budget in the saved run, misses it now: broke-budget');
  assert.match(slower.text, /broke-budget/);

  // --record-baselines writes this run's medians into (a copy of) budgets.json.
  const budgetsPath = join(dir, 'budgets.json');
  copyFileSync(join(here, '..', 'budgets.json'), budgetsPath);
  const recorded = await quiet(() => main(['--scenarios', 's2', '--reps', '3', '--no-profile', '--record-baselines', '--out', join(dir, 'record')],
    deps({ rate: () => 40, budgetsPath })));
  assert.equal(recorded.code, 0, recorded.text);
  const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const baseline = budgets.metrics['s2.coreExposure.dpr2.updatesPerSecond'].baselines.find(entry => entry.fixture === 'synthetic-60mp-cfa.dng');
  assert.equal(baseline.value, 40.2);
  assert.deepEqual(baseline.range, [40, 40.4]);
  assert.equal(baseline.route, 'positive');
  assert.match(baseline.source, /^bench:interactive \d{4}-\d{2}-\d{2}$/);

  // The pre-flight refuses low disk (exit 4) unless forced.
  const lowDisk = { ...deps({ rate: () => 31 }), freeDiskBytes: () => 5 * 1024 ** 3 };
  const refused = await quiet(() => main(['--scenarios', 's2', '--out', join(dir, 'refused')], lowDisk));
  assert.equal(refused.code, 4);
  assert.match(refused.text, /free disk 5.0 GB is below 20 GB/);
  const forced = await quiet(() => main(['--scenarios', 's2', '--reps', '1', '--no-profile', '--force', '--out', join(dir, 'forced')], lowDisk));
  assert.equal(forced.code, 0, forced.text);

  // Refused while another run holds the lock.
  const { acquireLock } = await import('./lock.mjs');
  const held = acquireLock({ path: process.env.NC_PERF_LOCK });
  const locked = await quiet(() => main(['--scenarios', 's2', '--out', join(dir, 'locked')], deps({ rate: () => 31 })));
  held.release();
  assert.equal(locked.code, 3);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('runner: interleaving, summaries, compare/against exit codes, production assertion, baselines, lock and cleanup tests passed');
