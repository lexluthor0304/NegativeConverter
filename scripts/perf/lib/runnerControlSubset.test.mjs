import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'nc-perf-control-subset-'));
process.env.NC_PERF_LOCK = join(dir, 'bench.lock');
const { main } = await import('./runner.mjs');
const { ALL_SCENARIOS } = await import('./args.mjs');
const fixtures = ['tiny.dng', 'other.dng'].map(name => ({ name, path: `/fake/${name}`, sha256: 'fake', width: 4, height: 3 }));
const saved = out => join(dir, out, 'results.json');
const read = out => JSON.parse(readFileSync(saved(out), 'utf8'));
async function run(out, flags = [], { omit, headOmit, fail, only = null, emptyFixture } = {}) {
  return main(['--reps', '1', '--no-profile', '--out', join(dir, out), ...flags], {
    outBase: dir, readPressureLevel: async () => ({ name: 'normal' }), freeDiskBytes: () => 100 * 1024 ** 3,
    waitForQuietMachine: async () => ({ noisy: false }), findChrome: () => '/fake/chrome',
    prepareRef: async options => ({ ...options, sha: 'a'.repeat(40), origin: 'http://fake.invalid', dist: dir }),
    prepareFixtures: async ({ args }) => Object.fromEntries(['singles', 'interactive', 'roll', 'export', 'export-parallel', 'dust', 'hang']
      .map(group => [group, fixtures.filter(f => (!args.fixture || f.name === args.fixture) && (!only || f.name === only))])),
    probeGpu: async () => {}, suspiciousRequests: async () => [],
    runRepetition: async ({ scenario, fixture, args, profiled, extra, rep, ref }) => {
      const metrics = { [`${scenario.id}.control.stage.librawDecodeMs`]: 100, [`${scenario.id}.control.readyByPollMs`]: 150 };
      for (const dpr of args.dprs) metrics[`${scenario.id}.control.dpr${dpr}.stage.autoFrameMs`] = 50;
      if (args.probe) metrics[`${scenario.id}.photo0.route`] = 'bw';
      if (omit) delete metrics[omit];
      if (headOmit && ref.label === 'head') delete metrics[headOmit];
      return { label: 'fake', status: fail === scenario.id && ref.label !== 'base' ? 'hang' : 'ok',
        metrics: fixture?.name === emptyFixture ? {} : metrics, hashes: {}, routes: [], notes: [], raw: {}, hangs: [], profiled, extra: extra?.label, rep };
    }
  });
}
try {
  // This is the production caller saving its entire ordinary selection, then
  // loading that file for an intentionally narrower probe-free control.
  assert.equal(await run('full-probe'), 0);
  assert.deepEqual(Object.keys(read('full-probe').runs[0].scenarios).sort(), ALL_SCENARIOS.slice().sort());
  const subset = ['--no-probe', '--scenarios', 's1', '--fixture', 'tiny.dng', '--dpr', '2', '--against', saved('full-probe')];
  assert.equal(await run('subset-control', subset), 0, 'unrun S4, other fixtures and DPR 1 cannot fail an S1/DPR 2 control');
  const rows = read('subset-control').compare.rows;
  assert.ok(rows.some(row => row.key === 's1.control.stage.librawDecodeMs@tiny.dng'));
  assert.ok(rows.every(row => row.key.startsWith('s1.') && !row.key.includes('@other.dng') && !row.key.includes('.dpr1.')));
  assert.equal(await run('reverse-probe', ['--against', saved('subset-control')]), 0, 'a full new probe compares only the saved control scope');
  const legacy = read('full-probe');
  delete legacy.selection;
  writeFileSync(saved('full-probe'), JSON.stringify(legacy));
  assert.equal(await run('legacy-subset-control', subset), 0, 'existing saved full probe files remain comparable');
  assert.equal(await run('missing-stage', subset, { omit: 's1.control.stage.librawDecodeMs' }), 1);
  assert.equal(await run('missing-dpr-stage', subset, { omit: 's1.control.dpr2.stage.autoFrameMs' }), 1);
  assert.equal(await run('missing-fixture-metrics', subset, { emptyFixture: 'tiny.dng' }), 1,
    'a fixture whose entire measurement is missing stays in the intended scope');
  assert.equal(await run('failed-subset', subset, { fail: 's1' }), 1);
  assert.equal(await run('ordinary-subset', ['--scenarios', 's1', '--fixture', 'tiny.dng', '--dpr', '2', '--against', saved('full-probe')]), 1,
    'same-mode saved comparisons retain ordinary missing-after strictness');
  assert.equal(await run('ordinary-base-head', ['--scenarios', 's1', '--compare', 'base', 'head'], { fail: 's1' }), 1);
  assert.equal(await run('ordinary-missing-head', ['--scenarios', 's1', '--compare', 'base', 'head'], { headOmit: 's1.control.stage.librawDecodeMs' }), 1);
  assert.equal(await run('no-common-fixtures', subset, { only: 'other.dng' }), 1, 'empty scope is not evidence of compatibility');
  if (process.env.NC_PERF_CALLER_EVIDENCE) {
    mkdirSync(process.env.NC_PERF_CALLER_EVIDENCE, { recursive: true });
    for (const name of ['full-probe', 'subset-control', 'reverse-probe', 'legacy-subset-control', 'missing-stage', 'missing-dpr-stage',
      'missing-fixture-metrics', 'failed-subset', 'ordinary-subset', 'ordinary-base-head', 'ordinary-missing-head', 'no-common-fixtures']) {
      copyFileSync(saved(name), join(process.env.NC_PERF_CALLER_EVIDENCE, `${name}.json`));
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('runner saved full probe/control: intended scopes and strict compared-scope/base-head gates passed');
