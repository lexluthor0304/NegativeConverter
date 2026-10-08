import assert from 'node:assert/strict';
import {
  quantile, median, p95, distribution, summarize, summarizeRepetitions, rangesOverlap, formatSummary, mean
} from './stats.mjs';

assert.equal(quantile([], 0.5), null);
assert.equal(median([5]), 5);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5, 'even counts interpolate');
assert.equal(quantile([0, 10], 0.95), 9.5);
assert.equal(p95(Array.from({ length: 101 }, (_, i) => i)), 95);
assert.equal(median([1, NaN, null, 3, undefined, 'x']), 2, 'non-finite values are ignored');
assert.equal(mean([1, 2, 3, 6]), 3);
assert.deepEqual(distribution([10, 20, 30, 40]), { n: 4, p50: 25, p95: 38.5, max: 40 });

// Medians with (min–max) over repetitions.
assert.deepEqual(summarize([31.3, 29.3, 30.1]), { median: 30.1, min: 29.3, max: 31.3, n: 3, values: [31.3, 29.3, 30.1] });
assert.deepEqual(summarize([]), { median: null, min: null, max: null, n: 0, values: [] });
assert.deepEqual(summarize(['abc', 'abc']), { value: 'abc', n: 2 }, 'identical hashes summarise to the hash');
assert.deepEqual(summarize(['abc', 'abd']), { value: 'mixed', distinct: ['abc', 'abd'], n: 2 });
assert.deepEqual(summarize([null, 4, undefined, 2]), { median: 3, min: 2, max: 4, n: 2, values: [4, 2] });

const reps = summarizeRepetitions([{ a: 1, b: 'x' }, { a: 3, b: 'x' }, { a: 2, c: 7 }]);
assert.equal(reps.a.median, 2);
assert.equal(reps.b.value, 'x');
assert.equal(reps.c.median, 7);
assert.deepEqual(Object.keys(reps), ['a', 'b', 'c']);

assert.equal(rangesOverlap({ min: 1, max: 3 }, { min: 3, max: 5 }), true, 'touching ranges overlap');
assert.equal(rangesOverlap({ min: 1, max: 3 }, { min: 3.1, max: 5 }), false);
assert.equal(rangesOverlap({ median: 2 }, { median: 2 }), true);
assert.equal(rangesOverlap(null, { min: 1, max: 2 }), true);

assert.equal(formatSummary(summarize([31.3, 29.3, 30.12])), '30.1 (29.3–31.3)');
assert.equal(formatSummary(summarize([7])), '7');
assert.equal(formatSummary(summarize([])), '–');
assert.equal(formatSummary(summarize(['positive', 'positive'])), 'positive');

console.log('stats: quantiles, summaries and range overlap tests passed');
