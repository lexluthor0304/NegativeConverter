import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'nc-perf-control-'));
process.env.NC_PERF_LOCK = join(dir, 'bench.lock');
const { main } = await import('./runner.mjs');
const fixture = { name: 'tiny.dng', path: '/fake/tiny.dng', sha256: 'fake', width: 4, height: 3 };
const deps = (metrics, status = 'ok') => ({
  outBase: dir, readPressureLevel: async () => ({ name: 'normal' }), freeDiskBytes: () => 100 * 1024 ** 3,
  waitForQuietMachine: async () => ({ noisy: false }), findChrome: () => '/fake/chrome',
  prepareRef: async options => ({ ...options, sha: 'a'.repeat(40), origin: 'http://fake.invalid', dist: dir }),
  prepareFixtures: async () => ({ singles: [fixture] }), probeGpu: async () => {}, suspiciousRequests: async () => [],
  runRepetition: async () => ({ status, metrics, hashes: {}, routes: [], notes: [], raw: {}, hangs: [] })
});
const run = (out, args, metrics, status) => main(['--scenarios', 's1', '--reps', '1', '--no-profile', '--out', join(dir, out), ...args], deps(metrics, status));
const saved = out => join(dir, out, 'results.json');
const read = out => JSON.parse(readFileSync(saved(out), 'utf8'));
try {
  const probe = { 's1.control.stage.librawDecodeMs': 100, 's1.control.readyByPollMs': 150,
    's1.firstPositiveVisibleMs': 120, 's1.photo0.route': 'bw' };
  const control = { 's1.control.stage.librawDecodeMs': 100, 's1.control.readyByPollMs': 150 };
  assert.equal(await run('probe', [], probe), 0);
  assert.equal(await run('control', ['--no-probe', '--against', saved('probe')], control), 0,
    'identical saved-probe/control metrics must not fail on intentionally absent probe-only keys');
  assert.ok(read('control').compare.rows.every(row => row.key.includes('.control.') || row.key.includes('.status')));
  assert.equal(await run('reverse', ['--against', saved('control')], probe), 0, 'cross-mode selection also works in reverse');
  assert.equal(await run('ordinary-missing', ['--against', saved('probe')], control), 1, 'ordinary missing-head gates remain strict');
  assert.equal(await run('missing-control', ['--no-probe', '--against', saved('probe')], { 's1.control.readyByPollMs': 150 }), 1,
    'a missing comparable control stage must fail');
  assert.equal(await run('failed-control', ['--no-probe', '--against', saved('probe')], control, 'hang'), 1,
    'cross-mode selection must retain the scenario failure gate');
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('runner control comparison: cross-mode selection and strict ordinary/failure gates passed');
