// Standalone Node test for batchExportScheduler.js - run with:
// node negative2positive/src/app/batchExportScheduler.test.mjs
import assert from 'node:assert/strict';
import {
  BATCH_MAX_PARALLEL,
  BATCH_PIXEL_BUDGET,
  planBatchParallelism,
  runBatchPipeline,
  planGeometryBandsInFlight,
  GEOMETRY_BAND_BUDGET_BYTES,
  GEOMETRY_BYTES_PER_BAND_PIXEL
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
// Completed payloads count toward the lane budget, even behind a slow first
// decode or sink. Otherwise one fast lane buffers an entire roll in memory.
for (const stalledStage of ['process', 'sink']) {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const started = [];
  const written = [];
  const controller = new AbortController();
  const run = runBatchPipeline(Array.from({ length: 100 }, (_, i) => i), {
    maxParallel: 2,
    signal: controller.signal,
    process: async (job) => {
      started.push(job);
      if (job === 0 && stalledStage === 'process') await stalled;
      return new Uint8Array(1024);
    },
    sink: async (job) => {
      if (job === 0 && stalledStage === 'sink') await stalled;
      written.push(job);
    }
  });
  await tick();
  assert.deepEqual(started, [0, 1], `${stalledStage}: pending payloads must retain their lane`);
  controller.abort();
  release();
  const result = await run;
  assert.deepEqual(written, [0, 1]);
  assert.equal(result.cancelled, true);
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

// ---- beforeStart admission (hidden-job gate, #241) ---------------------------
{
  const { createHiddenJobGate } = await import('./hiddenJobGate.js');

  // Deadlock guard: 3 lanes behind a gate that admits one item at a time, a
  // slow first sink. Admission happens before an index is claimed, so every
  // job completes, in order, and never more than one is in flight.
  let hidden = true;
  const gate = createHiddenJobGate({ isHidden: () => hidden, limitsApply: () => true, setTimer: () => 0, clearTimer: () => {} });
  const sunk = [];
  const started = [];
  let inFlight = 0;
  let peak = 0;
  const result = await runBatchPipeline([0, 1, 2, 3, 4, 5], {
    maxParallel: 3,
    beforeStart: ({ signal }) => gate.admit({ bytes: 1, signal }),
    process: async (job) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      started.push(job);
      await sleep(job === 0 ? 1 : 4);
      inFlight -= 1;
      return job;
    },
    sink: async (job) => { if (job === 0) await sleep(25); sunk.push(job); }
  });
  assert.deepEqual(sunk, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.equal(result.successCount, 6);
  assert.equal(peak, 1, 'one item in flight while the gate holds the others');
  assert.equal(gate.inFlight, 0, 'every admission is released after its sink');
  assert.equal(gate.waiting, 0);

  // A reservation lasts until the job's payload has been sunk, not just processed.
  const events = [];
  const releases = [];
  await runBatchPipeline(['a', 'b'], {
    maxParallel: 2,
    beforeStart: async ({ index }) => { events.push(`admit@${index}`); return () => { events.push('release'); releases.push(1); }; },
    process: async (job) => { events.push(`process:${job}`); return job; },
    sink: async (job) => { await sleep(3); events.push(`sink:${job}`); }
  });
  assert.equal(releases.length, 2);
  assert.ok(events.indexOf('sink:a') < events.indexOf('release'), 'released only after the sink');
  assert.ok(events.indexOf('admit@0') < events.indexOf('process:a'), 'admitted before the job starts');

  // Showing the window lets the waiting lanes start together again.
  hidden = true;
  const gate2 = createHiddenJobGate({ isHidden: () => hidden, limitsApply: () => true, setTimer: () => 0, clearTimer: () => {} });
  let inFlight2 = 0; let peak2 = 0;
  const run = runBatchPipeline([0, 1, 2, 3], {
    maxParallel: 3,
    beforeStart: ({ signal }) => gate2.admit({ signal }),
    process: async (job) => {
      inFlight2 += 1; peak2 = Math.max(peak2, inFlight2);
      if (job === 0) { hidden = false; gate2.visibilityChanged(); }
      await sleep(5);
      inFlight2 -= 1;
      return job;
    },
    sink: async () => {}
  });
  assert.equal((await run).successCount, 4);
  assert.ok(peak2 >= 2, 'the lane plan is restored once visible');

  // Cancelling while lanes wait at the gate stops them without claiming an index.
  hidden = true;
  const gate3 = createHiddenJobGate({ isHidden: () => hidden, limitsApply: () => true, setTimer: () => 0, clearTimer: () => {} });
  const cancel = new AbortController();
  const processed = [];
  const cancelled = await runBatchPipeline([0, 1, 2, 3], {
    maxParallel: 3,
    signal: cancel.signal,
    beforeStart: ({ signal }) => gate3.admit({ signal }),
    process: async (job) => { processed.push(job); if (job === 0) cancel.abort(); await sleep(3); return job; },
    sink: async () => {}
  });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(processed, [0], 'waiting lanes never claimed an index');
  assert.equal(cancelled.successCount, 1, 'the running job still finishes and is written');
  assert.equal(gate3.inFlight, 0);
  assert.equal(gate3.waiting, 0);

  // A non-abort admission failure is a programming error and surfaces.
  await assert.rejects(runBatchPipeline([1], {
    beforeStart: async () => { throw new Error('boom'); },
    process: async () => 1, sink: async () => {}
  }), /boom/);
}

// ---- planGeometryBandsInFlight (#244) ------------------------------------------

// One 60 MP lane may keep every band in flight; the lanes share the budget.
const bandBytes60 = 60_000_000 / 6 * GEOMETRY_BYTES_PER_BAND_PIXEL;
assert.equal(planGeometryBandsInFlight({ lanes: 1, pixelsPerFile: 60_000_000, poolSize: 6 }), Math.min(6, Math.floor(GEOMETRY_BAND_BUDGET_BYTES / bandBytes60)));
assert.ok(planGeometryBandsInFlight({ lanes: 3, pixelsPerFile: 60_000_000, poolSize: 6 }) <= planGeometryBandsInFlight({ lanes: 1, pixelsPerFile: 60_000_000, poolSize: 6 }));
for (const lanes of [1, 2, 3, 4]) {
  const perLane = planGeometryBandsInFlight({ lanes, pixelsPerFile: 60_000_000, poolSize: 6 });
  assert.ok(perLane >= 1 && (perLane === 1 || perLane * lanes * bandBytes60 <= GEOMETRY_BAND_BUDGET_BYTES), `lanes ${lanes}`);
}
// Small frames are bounded by the pool; low-memory devices get fewer bands.
assert.equal(planGeometryBandsInFlight({ lanes: 4, pixelsPerFile: 6_000_000, poolSize: 6 }), 6);
assert.ok(planGeometryBandsInFlight({ lanes: 1, pixelsPerFile: 60_000_000, poolSize: 6, deviceMemory: 4 })
  < planGeometryBandsInFlight({ lanes: 1, pixelsPerFile: 60_000_000, poolSize: 6 }));
assert.equal(planGeometryBandsInFlight({ lanes: 8, pixelsPerFile: 200_000_000, poolSize: 2 }), 1, 'never below one band');

// Missing callbacks are a programming error, reported up front.
await assert.rejects(() => runBatchPipeline([1], { process: async () => {} }), TypeError);

console.log('batchExportScheduler tests passed');
