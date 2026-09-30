import assert from 'node:assert/strict';
import { inferenceThreadCount, loadedInferenceThreads } from './inferenceRuntime.js';

// ORT threads (#264 Part A phase 1): min(4, cores - 2) in an isolated worker,
// one everywhere else.
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: 8 }), 4);
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: 16 }), 4, 'at most 4');
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: 5 }), 3);
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: 3 }), 1);
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: 2 }), 1, 'at least 1');
assert.equal(inferenceThreadCount({ isolated: true, worker: true, hardwareConcurrency: null }), 2, 'unknown core count: 4 cores');
assert.equal(inferenceThreadCount({ isolated: false, worker: true, hardwareConcurrency: 8 }), 1, 'not isolated: one thread');
assert.equal(inferenceThreadCount({ isolated: true, worker: false, hardwareConcurrency: 8 }), 1, 'the page\'s main-thread fallback: one thread');
assert.equal(inferenceThreadCount(), 1, 'Node: not isolated, not a worker');
assert.equal(loadedInferenceThreads(), 1, 'nothing loaded yet');
console.log('inferenceRuntime tests passed');
