// Standalone Node test for batchExportScheduler.js - run with:
// node negative2positive/src/app/batchExportScheduler.test.mjs
import assert from 'node:assert/strict';
import {
  BATCH_MAX_PARALLEL,
  BATCH_PIXEL_BUDGET,
  planBatchParallelism,
  runBatchPipeline
} from './batchExportScheduler.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---- planBatchParallelism ----------------------------------------------------

// A desktop with plenty of cores and small JPEG frames runs at the cap.
assert.equal(planBatchParallelism({ hardwareConcurrency: 10, deviceMemory: 8, pixelsPerFile: 6_000_000, fileCount: 36 }), BATCH_MAX_PARALLEL);
// 18 MP frames run four wide, 24 MP three wide, 36 MP two wide, 45 MP alone.
assert.equal(planBatchParallelism({ hardwareConcurrency: 10, deviceMemory: 8, pixelsPerFile: 18_500_000, fileCount: 36 }), 4);
assert.equal(planBatchParallelism({ hardwareConcurrency: 10, deviceMemory: 8, pixelsPerFile: 24_000_000, fileCount: 36 }), 3);
assert.equal(planBatchParallelism({ hardwareConcurrency: 10, deviceMemory: 8, pixelsPerFile: 36_000_000, fileCount: 36 }), 2);
assert.equal(planBatchParallelism({ hardwareConcurrency: 10, deviceMemory: 8, pixelsPerFile: 45_000_000, fileCount: 36 }), 1);
// A 100 MP scan stays sequential regardless of cores.
assert.equal(planBatchParallelism({ hardwareConcurrency: 16, deviceMemory: 32, pixelsPerFile: 100_000_000, fileCount: 36 }), 1);
// Two cores leave nothing for a second pipeline.
assert.equal(planBatchParallelism({ hardwareConcurrency: 2, deviceMemory: 8, pixelsPerFile: 6_000_000, fileCount: 36 }), 1);
// Four cores keep one lane for the encoder/main thread.
assert.equal(planBatchParallelism({ hardwareConcurrency: 4, deviceMemory: 8, pixelsPerFile: 6_000_000, fileCount: 36 }), 2);
// Low-memory devices get about a third of the pixel budget.
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, deviceMemory: 4, pixelsPerFile: 12_000_000, fileCount: 36 }), 2);
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, deviceMemory: 4, pixelsPerFile: 24_000_000, fileCount: 36 }), 1);
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, deviceMemory: 8, pixelsPerFile: 12_000_000, fileCount: 36 }), 4);
// Unknown memory (Safari never reports it) is treated as a desktop budget.
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, pixelsPerFile: 12_000_000, fileCount: 36 }), 4);
// Never more lanes than files.
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, deviceMemory: 8, pixelsPerFile: 1_000_000, fileCount: 1 }), 1);
// Missing everything still yields a sane value.
assert.ok(planBatchParallelism() >= 1 && planBatchParallelism() <= BATCH_MAX_PARALLEL);
assert.equal(planBatchParallelism({ hardwareConcurrency: 8, pixelsPerFile: BATCH_PIXEL_BUDGET + 1, fileCount: 5 }), 1);

// ---- runBatchPipeline ---------------------------------------------------------

// Sink order is the job order even when later jobs finish first.
{
  const jobs = [{ ms: 30 }, { ms: 5 }, { ms: 15 }, { ms: 1 }];
  const sunk = [];
  const events = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const result = await runBatchPipeline(jobs, {
    maxParallel: 3,
    process: async (job, index) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await sleep(job.ms);
      inFlight -= 1;
      return `payload-${index}`;
    },
    sink: async (_job, payload, index) => {
      sunk.push({ index, payload });
    },
    onEvent: (event) => events.push(event.type)
  });
  assert.deepEqual(sunk.map(s => s.index), [0, 1, 2, 3]);
  assert.deepEqual(sunk.map(s => s.payload), ['payload-0', 'payload-1', 'payload-2', 'payload-3']);
  assert.equal(result.successCount, 4);
  assert.equal(result.failCount, 0);
  assert.equal(result.cancelled, false);
  assert.equal(peakInFlight, 3);
  assert.equal(events.filter(t => t === 'start').length, 4);
  assert.equal(events.filter(t => t === 'done').length, 4);
}

// Parallelism is bounded by maxParallel and never exceeds the job count.
{
  let inFlight = 0;
  let peak = 0;
  await runBatchPipeline([1, 2, 3, 4, 5, 6], {
    maxParallel: 2,
    process: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await sleep(3); inFlight -= 1; return null; },
    sink: async () => {}
  });
  assert.equal(peak, 2);
  inFlight = 0; peak = 0;
  await runBatchPipeline([1], {
    maxParallel: 8,
    process: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await tick(); inFlight -= 1; return null; },
    sink: async () => {}
  });
  assert.equal(peak, 1);
}

// A failing process() marks only that job and the rest are still written in order.
{
  const sunk = [];
  const errors = [];
  const result = await runBatchPipeline(['a', 'b', 'c'], {
    maxParallel: 3,
    process: async (job) => { if (job === 'b') throw new Error('decode failed'); await sleep(2); return job.toUpperCase(); },
    sink: async (_job, payload) => { sunk.push(payload); },
    onEvent: (event) => { if (event.type === 'error') errors.push({ index: event.index, message: event.error.message }); }
  });
  assert.deepEqual(sunk, ['A', 'C']);
  assert.deepEqual(errors, [{ index: 1, message: 'decode failed' }]);
  assert.equal(result.successCount, 2);
  assert.equal(result.failCount, 1);
  assert.equal(result.results.find(r => r.index === 1).ok, false);
}

// A failing sink() is also a per-job failure, not a batch abort.
{
  const sunk = [];
  const result = await runBatchPipeline(['a', 'b', 'c'], {
    maxParallel: 2,
    process: async (job) => job,
    sink: async (job) => { if (job === 'a') throw new Error('disk full'); sunk.push(job); }
  });
  assert.deepEqual(sunk, ['b', 'c']);
  assert.equal(result.failCount, 1);
  assert.equal(result.successCount, 2);
}

// Cancelling stops new jobs from starting; in-flight ones finish and are written.
{
  const controller = new AbortController();
  const started = [];
  const sunk = [];
  const result = await runBatchPipeline([0, 1, 2, 3, 4, 5], {
    maxParallel: 2,
    signal: controller.signal,
    process: async (job) => {
      started.push(job);
      if (job === 1) controller.abort();
      await sleep(5);
      return job;
    },
    sink: async (job) => { sunk.push(job); }
  });
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(sunk, [0, 1]);
  assert.equal(result.cancelled, true);
  assert.equal(result.successCount, 2);
}

// An already-aborted signal does nothing at all.
{
  const controller = new AbortController();
  controller.abort();
  let processed = 0;
  const result = await runBatchPipeline([1, 2], {
    signal: controller.signal,
    process: async () => { processed += 1; return null; },
    sink: async () => {}
  });
  assert.equal(processed, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.successCount + result.failCount, 0);
}

// Progress counts reported to onEvent are monotonic and end at the total.
{
  const doneCounts = [];
  await runBatchPipeline([1, 2, 3, 4, 5], {
    maxParallel: 3,
    process: async (job) => { await sleep(6 - job); return job; },
    sink: async () => {},
    onEvent: (event) => { if (event.type === 'done') doneCounts.push(event.done); }
  });
  assert.deepEqual(doneCounts, [1, 2, 3, 4, 5]);
}

// Empty input resolves immediately.
{
  const result = await runBatchPipeline([], { process: async () => {}, sink: async () => {} });
  assert.deepEqual(result, { successCount: 0, failCount: 0, cancelled: false, results: [] });
}

// Missing callbacks are a programming error, reported up front.
await assert.rejects(() => runBatchPipeline([1], { process: async () => {} }), TypeError);

console.log('batchExportScheduler tests passed');
