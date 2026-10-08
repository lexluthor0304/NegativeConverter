import assert from 'node:assert/strict';
import { renderReport } from './report.mjs';
import { summarize } from './stats.mjs';
import { compareRuns } from './compare.mjs';

const budgets = { metrics: { 's1.firstPositiveVisibleMs': { unit: 'ms', better: 'lower', target: 2000, tolerance: { rel: 0.1, abs: 50 } } } };
const results = {
  harnessVersion: 1, mode: 'run', browser: 'chrome', reps: 3, profile: true, startedAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T01:00:00Z',
  conditions: {
    cpuModel: 'Apple M1 Pro', cores: 8, memoryGB: 16, os: 'Darwin 27.0.0', browser: { name: 'chrome', version: 'Chrome/153', headless: true },
    gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)', softwareGl: false, dprs: [1, 2], fixtureSet: 'synthetic',
    fixtures: [{ name: 'synthetic-60mp-cfa.dng', sha256: 'abcdef0123456789' }], loadStart: [3.2, 2, 1], loadEnd: [4.1, 3, 2], noisy: false,
    power: { battery: { source: 'AC Power', percent: 100 }, thermal: { thermalWarningLevel: 0, performanceWarningLevel: 0 } }, swapStart: 1048576 * 100, swapEnd: 1048576 * 120, probe: true
  },
  runs: [{
    label: 'run', sha: '1703835c6842405975ee', dirty: false,
    scenarios: {
      s1: {
        title: 'Import', status: 'ok', fixtures: {
          'synthetic-60mp-cfa.dng': {
            summary: { 's1.firstPositiveVisibleMs': summarize([13332, 13135, 13553]), 's1.photo0.route': summarize(['positive', 'positive']) },
            routes: [{ photo: 'synthetic-60mp-cfa.dng', filmType: 'positive', route: 'positive' }],
            profile: { wallMs: 1000, busyTotalMs: 800, coresUsed: 0.8, threads: [{ label: 'CrRendererMain', busyMs: 500, hot: [{ label: 'toImageData8 src/silvercore/util/image16.js:42', selfMs: 268 }] }] },
            loaf: [{ label: 'onmessage src/app/sensorDefectsClient.js:37', ms: 380, count: 1 }],
            workerTiming: { convert: { queueP50Ms: 1, handleP50Ms: 26 } },
            reps: [{ status: 'ok' }, { status: 'hang' }],
            notes: ['r2: hang']
          }
        }
      }
    }
  }],
  hangs: [{ label: 'run-h-r1', info: { silentMs: 31000 }, topFrame: 'ncInjectedHang', file: 'hang-run-h-r1.json' }]
};
results.compare = compareRuns({ budgets, before: { 's1.firstPositiveVisibleMs@a': summarize([13332, 13135, 13553]) }, after: { 's1.firstPositiveVisibleMs@a': summarize([1900, 1800, 1950]) } });
results.compare.baseLabel = '1703835';
results.compare.headLabel = 'HEAD';

const report = renderReport(results, budgets);
assert.match(report, /^# Interactive benchmark \(run\)/);
assert.match(report, /\| GPU \| ANGLE \(Apple, ANGLE Metal Renderer: Apple M1 Pro\) \|/);
assert.match(report, /\| Swap used \(start \/ end\) \| 100 \/ 120 MB \|/);
assert.match(report, /## run: `1703835c6842`/);
assert.match(report, /\| `s1.firstPositiveVisibleMs` \| 13332 \(13135–13553\) \| ≤ 2000 ms \| fails \|/);
assert.match(report, /\| `s1.photo0.route` \| positive \| tracked \| – \|/);
assert.match(report, /Film type \/ route per photo: synthetic-60mp-cfa.dng: positive → positive/);
assert.match(report, /Repetition statuses: hang\./);
assert.match(report, /\*\*CrRendererMain\*\* \(busy 500 ms\): `toImageData8 src\/silvercore\/util\/image16.js:42` 268/);
assert.match(report, /Long animation frame scripts \(first repetition\): `onmessage src\/app\/sensorDefectsClient.js:37` 380 ms ×1/);
assert.match(report, /## Compare/);
assert.match(report, /\| `s1.firstPositiveVisibleMs@a` \| ≤ 2000 ms \| 13332 \(13135–13553\) \| 1900 \(1800–1950\) \| -85.7 % \| improved \| – \|/);
assert.match(report, /- run-h-r1: silent 31 s; top frame ncInjectedHang/);

console.log('report: conditions, metric tables, profile, LoAF, compare and hang sections render');
