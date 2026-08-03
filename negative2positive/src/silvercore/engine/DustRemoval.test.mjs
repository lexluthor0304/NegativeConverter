// Standalone Node test for DustRemoval.js threshold mapping and blob
// classification (#113) - run with:
// node negative2positive/src/silvercore/engine/DustRemoval.test.mjs

import assert from 'node:assert/strict';
import { classifyDustBlob, defaultMaxParticleSize, hatThreshold } from './DustRemoval.js';

// --- defaultMaxParticleSize scales with the short edge ---
assert.equal(defaultMaxParticleSize(6000, 4000), 64);
assert.equal(defaultMaxParticleSize(1280, 768), 12);
assert.equal(defaultMaxParticleSize(400, 300), 8); // floor

// --- hatThreshold: strength 1 admits almost nothing ---
{
  // 1% of pixels carry a strong top-hat response of 200
  const n = 100000;
  const data = new Uint8Array(n);
  for (let i = 0; i < 1000; i++) data[i] = 200;
  // Strength 1 budgets ~0.03% of the frame, far below the 1% cluster, so the
  // threshold climbs to the cluster value and excludes it (values must be > th).
  assert.equal(hatThreshold(data, 1), 200);
  // Strength 10 budgets 1.2% and lets the whole cluster through via the floor.
  assert.equal(hatThreshold(data, 10), 12);
}
{
  // Flat response: quantile collapses, absolute floor holds the line
  const flat = new Uint8Array(10000);
  assert.equal(hatThreshold(flat, 1), 30);
  assert.equal(hatThreshold(flat, 10), 12);
}

// --- classifyDustBlob on a 4000x3000 frame with the default 48px cap ---
const W = 4000, H = 3000, MAX = defaultMaxParticleSize(W, H);
assert.equal(MAX, 48);

// small compact spot → dust
assert.deepEqual(classifyDustBlob({ width: 10, height: 12 }, 90, MAX, W, H), { keep: true, isScratch: false });

// a ~100px lamp: compact blob over the size cap → image content, stays (#113)
assert.equal(classifyDustBlob({ width: 100, height: 96 }, 7500, MAX, W, H).keep, false);

// thin diagonal hair: bbox 300x60 but stroke ≈ 2px (area/length) → scratch
{
  const r = classifyDustBlob({ width: 300, height: 60 }, 600, MAX, W, H);
  assert.equal(r.keep, true);
  assert.equal(r.isScratch, true);
}

// thick bright tube 300x20 solid: effective thickness 20 > cap → stays
assert.equal(classifyDustBlob({ width: 300, height: 20 }, 6000, MAX, W, H).keep, false);

// thin line spanning most of the frame is structure, not a scratch
assert.equal(classifyDustBlob({ width: 2000, height: 8 }, 4000, MAX, W, H).keep, false);

// stringy low-fill texture shard within the size cap → rejected by fill
assert.equal(classifyDustBlob({ width: 40, height: 40 }, 200, MAX, W, H).keep, false);

console.log('DustRemoval threshold/classification tests passed');
