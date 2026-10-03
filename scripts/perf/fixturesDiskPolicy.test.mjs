import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureFixtures } from './fixtures.mjs';
import { GiB } from './lib/guards.mjs';

const dir = mkdtempSync(join(tmpdir(), 'nc-perf-fixture-policy-'));
const spec = { name: 'tiny.tif', format: 'tiff', width: 8, height: 6, seed: 1, kind: 'color' };
try {
  const logs = [];
  const options = { dir: join(dir, 'forced'), specs: [spec], readDisk: () => 4.5 * GiB,
    diskPolicy: { force: true, freeDiskAtStart: 4.5 * GiB }, log: line => logs.push(line) };
  const made = await ensureFixtures(options);
  assert.ok(made[spec.name].bytes < 4096, 'only a 48-pixel fixture is generated');
  await ensureFixtures(options);
  assert.equal(logs.length, 1, 'the run policy must not mean regenerate cached fixtures');
  await assert.rejects(ensureFixtures({ ...options, dir: join(dir, 'ordinary'), diskPolicy: { force: false } }), /free disk/);
  await assert.rejects(ensureFixtures({ ...options, dir: join(dir, 'missing-baseline'), diskPolicy: { force: true } }), /free disk/);
  await assert.rejects(ensureFixtures({ ...options, dir: join(dir, 'consumed'), readDisk: () => 2.5 * GiB }), /disk.*drop|dropped/);
  await assert.rejects(ensureFixtures({ ...options, dir: join(dir, 'projected'), readDisk: () => 2.5 * GiB + 100 }), /disk.*drop|dropped/,
    'the estimated fixture bytes must count against the remaining allowance before generation');
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('fixture disk policy: fake-disk forced allowance, projected loss, unchanged ordinary floor and cache reuse passed');
