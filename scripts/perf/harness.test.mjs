// Harness wiring without a browser: every module loads, the scenario
// registry is complete, the CLI parses, refuses a held lock quickly and
// names the holder, and the WebKit self-driven report maps onto the same
// metric keys as Chrome.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, selectScenarios } from './scenarios/index.mjs';
import { ALL_SCENARIOS } from './lib/args.mjs';
import { resolveFixtureGroups, syntheticNamesFor } from './lib/fixture-sets.mjs';
import { summarizeGroup, pickSavedRun, labelThreads } from './lib/runner.mjs';
import { metricsFromSelfDriven, tauriDevArgs, webkitWindowMetrics, WEBKIT_SCENARIOS } from './lib/webkit.mjs';
import { acquireLock } from './lib/lock.mjs';
import { findMetricDef } from './lib/compare.mjs';
import budgets from './budgets.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// Registry: every CLI scenario exists and has what the runner needs.
for (const id of ALL_SCENARIOS) {
  const scenario = SCENARIOS[id];
  assert.ok(scenario, `scenario ${id} is registered`);
  assert.equal(scenario.id, id);
  assert.equal(typeof scenario.run, 'function');
  assert.ok(['singles', 'interactive', 'roll', 'export', 'hang', 'smoke'].includes(scenario.fixtureGroup), `${id} fixture group`);
}
assert.equal(selectScenarios(['s1'], { injectHang: true })[0].id, 'selftest-hang', 'the hang self-test runs first');
assert.ok(SCENARIOS.s9.extraReps.some(extra => extra.perfFlag === false), 'S9 verifies pixels with ?perf=1 off too');

// Fixture groups resolve for the synthetic set.
const synthetic = Object.fromEntries(syntheticNamesFor(['singles', 'interactive', 'roll', 'export', 'hang'], { rollSize: 12 })
  .map(name => [name, { path: `/fixtures/${name}`, width: 9536, height: 6336, sha256: 'x' }]));
const groups = resolveFixtureGroups({ set: 'synthetic', synthetic, rollSize: 12, repoRoot, env: {} });
assert.equal(groups.singles.length, 5);
assert.equal(groups.interactive[0].name, 'synthetic-60mp-cfa.dng');
assert.equal(groups.roll.length, 12);
assert.deepEqual(groups.export.map(entry => entry.name), ['synthetic-60mp-cfa.dng', 'synthetic-roll-01.dng', 'synthetic-roll-02.dng', 'synthetic-roll-03.dng']);
assert.match(groups.hang[0].label, /synthetic stand-in for _DSC3111\.NEF/, 'H falls back to the synthetic 24 MP DNG, labelled');
assert.equal(resolveFixtureGroups({ set: 'synthetic', synthetic, quick: true, repoRoot, env: {} }).singles.length, 1, '--quick uses one fixture');
assert.throws(() => resolveFixtureGroups({ set: 'real', synthetic, repoRoot, env: {} }), /NC_PERF_RAW_DIR/);

// Group summaries: medians over timing reps; hashes from verification reps;
// ?perf=1 parity; the probe self-time maximum.
const reps = [
  { status: 'ok', metrics: { 's9.single.png8.imported.totalMs': 10, 's2.cyan.dpr2.probeSelfPct': 0.4 }, hashes: {} },
  { status: 'ok', metrics: { 's9.single.png8.imported.totalMs': 30, 's2.cyan.dpr2.probeSelfPct': 0.6 }, hashes: {} },
  { status: 'hang', metrics: { 's9.single.png8.imported.totalMs': 999 }, hashes: {} },
  { status: 'ok', profiled: true, metrics: { 's9.single.png8.imported.totalMs': 500 }, hashes: {} },
  { status: 'ok', extra: 'verify', metrics: { 's9.single.tiff16.imported.bitDepth': 16 }, hashes: { 's9.single.png8.imported.pixelsSha256': 'aa' } },
  { status: 'ok', extra: 'verify-noflag', metrics: {}, hashes: { 's9.single.png8.imported.pixelsSha256': 'aa' } }
];
const summary = summarizeGroup(reps);
assert.equal(summary['s9.single.png8.imported.totalMs'].median, 20, 'profiled, failed and extra reps are not in the medians');
assert.equal(summary['s9.single.png8.imported.pixelsSha256'].value, 'aa');
assert.equal(summary['s9.single.tiff16.imported.bitDepth'].median, 16);
assert.equal(summary['s9.perfFlagParity'].value, 'identical');
assert.equal(summary['probe.selfPctMax'].median, 0.6);
reps[5].hashes['s9.single.png8.imported.pixelsSha256'] = 'bb';
assert.match(summarizeGroup(reps)['s9.perfFlagParity'].value, /^differs/);
assert.equal(pickSavedRun({ runs: [{ label: 'base' }, { label: 'head' }] }).label, 'head');
assert.equal(labelThreads({ threads: [{ name: 'DedicatedWorker thread', tid: 3, hot: [{ label: 'suppressSensorDefects src/app/sensorDefects.js:74' }] }] }).threads[0].label,
  'DedicatedWorker thread (sensorDefects.js)');

// Every Chrome metric the budgets name has a definition the report can use.
for (const key of ['s2.coreExposure.dpr2.inputToDrawP95Ms', 's1.memory.rendererPeakMB', 's7.warm1Back.firstDisplayPositiveMs', 's3.curve.dpr2.longTaskCount', 's5.mirror.maxLongTaskMs', 's4.dpr1.fitTo2x.nativeDetailMs']) {
  assert.ok(findMetricDef(budgets, key), `budget for ${key}`);
}

// WebKit: self-driven reports use the Chrome keys; Tauri launches against the preview server.
const report = {
  scenario: 's2', dpr: 2,
  parts: [
    { name: 'import', before: 0, window: { start: 0, end: 100, frames: [], ticks: [0, 5, 10] }, events: [
      { k: 'input', type: 'change', id: 'fileInput', t: 1, tr: false },
      { k: 'req', t: 10, wid: 1, cls: 'convert', id: 1 },
      { k: 'res', t: 20, wid: 1, cls: 'convert', id: 1, rt: 10, hash: 'p' },
      { k: 'gl.upload', t: 21, c: 'glCanvas', w: 1800, h: 1200, hash: 'p' },
      { k: 'gl.draw', t: 22, c: 'glCanvas', sig: 'x' }
    ] },
    { name: 'drag:cyan', id: 'cyan', initial: '0', start: 100, release: 200, window: { start: 100, end: 700, frames: [100, 116, 133], ticks: [100, 105, 180] }, events: [
      { k: 'input', type: 'input', id: 'cyan', v: '1', t: 101, tr: false },
      { k: 'gl.draw', t: 110, c: 'glCanvas', sig: 'a', ut: 102 }
    ] }
  ]
};
const mapped = metricsFromSelfDriven(report);
assert.equal(mapped['s2.firstPositiveVisibleMs'], 21);
assert.equal(mapped['s2.cyan.dpr2.inputs'], 1, 'untrusted self-driven inputs count');
assert.equal(mapped['s2.cyan.dpr2.inputToDrawP50Ms'], 9);
assert.equal(mapped['s2.cyan.dpr2.timerGapCount'], 1);
const tauri = tauriDevArgs({ port: 5297, scenario: 's1', fixtures: ['L1000617.DNG'] });
assert.deepEqual(tauri.slice(0, 3), ['dev', '--release', '--no-watch']);
const config = JSON.parse(tauri[4]);
assert.equal(config.build.beforeDevCommand, '', 'no dev server is started');
assert.match(config.build.devUrl, /^http:\/\/127\.0\.0\.1:5297\/\?lang=en&perf=1&scenario=s1&fixtures=L1000617\.DNG/);
assert.deepEqual(WEBKIT_SCENARIOS.safari, ['s1', 's2', 's4', 's7']);
assert.equal(webkitWindowMetrics({ start: 0, end: 20, frames: [0, 16], ticks: [0, 5, 10, 15, 20] }).mainBusyPct, 0);

// CLI: usage errors exit 2; --help exits 0; a held lock exits 3 within about
// a second and names the holder, whatever $TMPDIR says.
const cli = join(here, 'bench-interactive.mjs');
const runCli = (args, env = {}) => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  child.once('exit', code => resolve({ code, out, ms: Date.now() - started }));
});
assert.equal((await runCli(['--help'])).code, 0);
const bad = await runCli(['--scenarios', 's42']);
assert.equal(bad.code, 2);
assert.match(bad.out, /unknown scenario s42/);
const dir = mkdtempSync(join(tmpdir(), 'nc-perf-cli-'));
try {
  const lockPath = join(dir, 'bench.lock');
  const held = acquireLock({ path: lockPath, argv: ['bench:interactive', '--quick'] });
  const second = await runCli(['--quick'], { NC_PERF_LOCK: lockPath, TMPDIR: join(dir, 'other-tmp') });
  held.release();
  assert.equal(second.code, 3, second.out);
  assert.match(second.out, new RegExp(`PID ${process.pid}`));
  assert.ok(second.ms < 1500, `refused in ${second.ms} ms including Node startup`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('harness: registry, fixture groups, summaries, WebKit mapping and CLI lock tests passed');
