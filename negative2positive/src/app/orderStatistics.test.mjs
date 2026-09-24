import assert from 'node:assert/strict';
import { selectKth, minFrom } from './orderStatistics.js';

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const rnd = makeRng(42);
const generators = [
  (n) => Float64Array.from({ length: n }, () => rnd()),
  (n) => Float64Array.from({ length: n }, () => Math.floor(rnd() * 4)),      // heavy duplicates
  (n) => Float64Array.from({ length: n }, (_, i) => i),                        // sorted
  (n) => Float64Array.from({ length: n }, (_, i) => n - i),                    // reversed
  (n) => new Float64Array(n).fill(0.5),                                        // flat
  (n) => Uint16Array.from({ length: n }, () => Math.floor(rnd() * 65536)),
  (n) => Float64Array.from({ length: n }, (_, i) => (i % 2 ? 1e-9 : 0) + (i % 7)),
];
for (const make of generators) {
  for (const n of [1, 2, 3, 5, 16, 17, 100, 1001]) {
    const base = make(n);
    const sorted = base.slice().sort();
    for (const k of new Set([0, 1, n >> 1, n - 2, n - 1, Math.floor((n - 1) * 0.1), Math.floor((n - 1) * 0.9)])) {
      if (k < 0 || k >= n) continue;
      const work = base.slice();
      assert.equal(selectKth(work, k, n), sorted[k], `n=${n} k=${k}`);
      for (let i = 0; i < k; i++) assert.ok(work[i] <= work[k]);
      for (let i = k + 1; i < n; i++) assert.ok(work[i] >= work[k]);
      if (k + 1 < n) assert.equal(minFrom(work, k + 1, n), sorted[k + 1]);
      assert.deepEqual(work.slice().sort(), sorted, 'selection only permutes');
    }
  }
}
// n smaller than the backing array: only the prefix counts.
{
  const values = Float64Array.from([5, 4, 3, 2, 1, -100, -100]);
  assert.equal(selectKth(values, 0, 5), 1);
  assert.equal(minFrom(values, 5, 5), undefined);
}
console.log('orderStatistics tests passed');
