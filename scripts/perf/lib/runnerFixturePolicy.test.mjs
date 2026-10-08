import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureFixtures } from '../fixtures.mjs';
import { GiB } from './guards.mjs';

const dir = mkdtempSync(join(tmpdir(), 'nc-perf-prepare-policy-'));
process.env.NC_PERF_LOCK = join(dir, 'bench.lock');
process.env.NC_PERF_FIXTURE_DIR = join(dir, 'fixtures');
const runner = await import('./runner.mjs');
let prepared = 0, reads = 0;
const deps = {
  outBase: dir, readPressureLevel: async () => ({ name: 'normal' }), freeDiskBytes: () => 4.5 * GiB,
  waitForQuietMachine: async () => ({ noisy: false }), findChrome: () => '/fake/chrome',
  prepareRef: async options => ({ ...options, sha: 'a'.repeat(40), origin: 'http://fake.invalid', dist: dir }),
  prepareFixtures: async options => {
    prepared++;
    assert.equal(options.freeDiskAtStart, 4.5 * GiB, 'the runner must pass its admission baseline to actual fixture preparation');
    return runner.prepareFixtures({ ...options, chromeBin: null }, {
      syntheticFixtureSpecs: () => [{ name: 'synthetic-60mp-cfa.dng', format: 'dng', width: 8, height: 6, seed: 1, kind: 'color' }],
      ensureFixtures: options => ensureFixtures({ ...options, readDisk: () => { reads++; return 4.5 * GiB; } })
    });
  },
  probeGpu: async () => {}, suspiciousRequests: async () => [],
  runRepetition: async () => ({ status: 'ok', metrics: {}, hashes: {}, routes: [], notes: [], raw: {}, hangs: [] })
};
try {
  const args = ['--scenarios', 's1', '--quick', '--reps', '1', '--no-profile'];
  assert.equal(await runner.main([...args, '--out', join(dir, 'refused')], deps), 4);
  assert.equal(prepared, 0, 'unforced low-disk preflight must stop before preparation');
  assert.equal(await runner.main([...args, '--force', '--out', join(dir, 'fake-forced')], deps), 0,
    'the runner and real preparation/generator must share the fake forced-run disk policy');
  assert.equal(prepared, 1);
  assert.equal(reads, 1, 'the actual generator checks fake disk before writing its 48-pixel fixture');
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('runner fixture policy: fake admission baseline reaches actual preparation and tiny generator');
