// Standalone Node test for the #256 stages of batchExportScheduler.js: the
// byte cap on unwritten payloads (Part 2), the learning barrier, the
// decode-ahead prepare stage and its admission (Part 3), and the
// decode / post-decode sub-stages (Part 4). The #199 lane rule and the rest
// of runBatchPipeline are covered, unchanged, by batchExportScheduler.test.mjs.
// Run with: node negative2positive/src/app/batchPipelineStages.test.mjs
import assert from 'node:assert/strict';
import {
  runBatchPipeline,
  createPrepareStage,
  createLearningBarrier,
  planDecodeAhead,
  EXPORT_MAX_UNWRITTEN_BYTES,
  DECODE_AHEAD_CEILING_BYTES,
  PROCESSING_SLOT_BYTES_PER_PIXEL
} from './batchExportScheduler.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---- Part 2: byte cap ----------------------------------------------------------

// A payload that fits the cap frees its lane at once; the next frame is
// processed while the payload waits for its (slow) write. Order is kept.
{
  const events = [];
  const stats = {};
  const result = await runBatchPipeline([0, 1, 2], {
    maxParallel: 1,
    maxUnwrittenBytes: 1000,
    payloadBytes: (payload) => payload.bytes,
    stats,
    process: async (job) => { events.push(`process:${job}`); await sleep(2); return { job, bytes: 100 }; },
    sink: async (job) => { events.push(`sink:${job}`); await sleep(15); events.push(`written:${job}`); }
  });
  assert.equal(result.successCount, 3);
  assert.ok(events.indexOf('process:1') < events.indexOf('written:0'), 'frame 1 is processed while frame 0 is written');
  assert.deepEqual(events.filter(e => e.startsWith('written')), ['written:0', 'written:1', 'written:2']);
  assert.equal(stats.earlyReleases, 3);
  assert.ok(stats.peakUnwrittenBytes <= 1000);
}

// A stalled first sink: the lanes go on only while the waiting payloads fit
// the cap, then hold as before (#199), so at most `lanes` processed frames
// plus the capped payloads wait.
for (const lanes of [1, 2]) {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const started = [];
  const stats = {};
  const controller = new AbortController();
  const run = runBatchPipeline(Array.from({ length: 50 }, (_, i) => i), {
    maxParallel: lanes,
    signal: controller.signal,
    maxUnwrittenBytes: 300,
    payloadBytes: () => 100,
    stats,
    process: async (job) => { started.push(job); await tick(); return job; },
    sink: async (job) => { if (job === 0) await stalled; }
  });
  for (let i = 0; i < 20; i++) await tick();
  // Three payloads fit (0, 1, 2); the next one holds its lane, and with two
  // lanes the second lane's next payload holds it too.
  assert.equal(started.length, 3 + lanes, `lanes ${lanes}: ${started}`);
  controller.abort();
  release();
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.successCount, 3 + lanes);
  assert.ok(stats.peakUnwrittenBytes <= 300, 'unwritten payload bytes never exceed the cap');
}

// A payload larger than the cap holds its lane as today; failures carry no bytes.
{
  const events = [];
  const stats = {};
  await runBatchPipeline(['big', 'bad', 'small'], {
    maxParallel: 1,
    maxUnwrittenBytes: 50,
    payloadBytes: (payload) => payload.length,
    stats,
    process: async (job) => { events.push(`process:${job}`); if (job === 'bad') throw new Error('decode failed'); return job === 'big' ? 'x'.repeat(100) : 'y'; },
    sink: async (job) => { await sleep(5); events.push(`written:${job}`); }
  });
  assert.ok(events.indexOf('written:big') < events.indexOf('process:bad'), 'an oversized payload holds its lane');
  assert.equal(stats.earlyReleases, 2);
}

// The hidden-job admission still lasts until the payload is written.
{
  const events = [];
  await runBatchPipeline(['a', 'b'], {
    maxParallel: 1,
    maxUnwrittenBytes: 10,
    payloadBytes: () => 1,
    beforeStart: async ({ index }) => { events.push(`admit@${index}`); return () => events.push(`release@${index}`); },
    process: async (job) => job,
    sink: async (job) => { await sleep(5); events.push(`sink:${job}`); }
  });
  assert.ok(events.indexOf('sink:a') < events.indexOf('release@0'));
  assert.ok(events.indexOf('sink:b') < events.indexOf('release@1'));
}

assert.equal(EXPORT_MAX_UNWRITTEN_BYTES, 512 * 1024 * 1024);

// ---- Part 2: learning barrier ------------------------------------------------------

// Frame 0 learns in its sink (slow write); frame 1 (no saved settings) reads
// the learned records only after that write, as a one-lane batch did.
// Frame 2 does not wait for a frame that learns nothing.
{
  const log = [];
  const learnsAt = new Set([0]);
  const barrier = createLearningBarrier(4, (i) => learnsAt.has(i));
  const result = await runBatchPipeline([0, 1, 2, 3], {
    maxParallel: 1,
    maxUnwrittenBytes: 1e9,
    payloadBytes: () => 1,
    process: async (job) => {
      if (job === 1 || job === 3) {
        await barrier.before(job);
        log.push(`read:${job}`);
      }
      return job;
    },
    sink: async (job, _payload, index) => {
      await sleep(3);
      const learned = learnsAt.has(job) ? sleep(15).then(() => log.push(`write:${job}`)) : null;
      barrier.settle(index, learned);
    }
  });
  assert.equal(result.successCount, 4);
  assert.ok(log.indexOf('write:0') < log.indexOf('read:1'), log.join());
  assert.equal(barrier.waitingFor(3), 0);
}
{
  // A failed learner frees its successors; one that never learns never holds.
  const barrier = createLearningBarrier(3, (i) => i === 0);
  let passed = false;
  const waiting = barrier.before(2).then(() => { passed = true; });
  await tick();
  assert.equal(passed, false);
  assert.equal(barrier.waitingFor(2), 1);
  barrier.settle(0, Promise.reject(new Error('write failed')));
  await waiting;
  assert.equal(passed, true);
  assert.equal(barrier.waitingFor(1), 0);
  await barrier.before(0);
}

// ---- Part 3: prepare stage ----------------------------------------------------------

// One lane: the next frame decodes while the current one is processed. At
// most `prepareDepth` frames are prepared, one decoder runs at a time, and a
// prepared frame arrives in process() instead of being decoded there.
{
  let decoders = 0;
  let peakDecoders = 0;
  const log = [];
  const stats = {};
  const decode = async (job) => {
    decoders += 1; peakDecoders = Math.max(peakDecoders, decoders);
    await sleep(8);
    decoders -= 1;
    return { base: job };
  };
  const result = await runBatchPipeline([0, 1, 2, 3, 4], {
    maxParallel: 1,
    prepareDepth: 1,
    stats,
    prepare: async (job, { signal }) => { assert.ok(signal instanceof AbortSignal); log.push(`prepare:${job}`); return decode(job); },
    process: async (job, _index, prepared, context) => {
      let base = prepared;
      if (!base) {
        base = await decode(job);
        context.decoded();
      }
      assert.deepEqual(base, { base: job });
      log.push(`process:${job}:${prepared ? 'prepared' : 'self'}`);
      await sleep(12);
      return job;
    },
    sink: async () => {}
  });
  assert.equal(result.successCount, 5);
  assert.equal(peakDecoders, 1, 'one decode at a time');
  assert.deepEqual(log.filter(e => e.startsWith('process')),
    ['process:0:self', 'process:1:prepared', 'process:2:prepared', 'process:3:prepared', 'process:4:prepared']);
  assert.equal(stats.prepare.peakPrepared, 1);
  assert.equal(stats.prepare.started, 4);
  assert.equal(stats.prepare.taken, 4);
}

// Admission decides: refused frames decode inside process() as before, and
// the request carries the waiting payload bytes and the lanes' jobs.
{
  const requests = [];
  const seen = [];
  const result = await runBatchPipeline([0, 1, 2], {
    maxParallel: 1,
    prepareDepth: 1,
    maxUnwrittenBytes: 1000,
    payloadBytes: () => 10,
    admitPrepare: (request) => { requests.push(request); return false; },
    prepare: async () => assert.fail('refused'),
    process: async (job, _index, prepared, context) => { seen.push(prepared); await tick(); context.decoded(); await sleep(2); return job; },
    sink: async () => { await sleep(3); }
  });
  assert.equal(result.successCount, 3);
  assert.deepEqual(seen, [undefined, undefined, undefined]);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(r => Number.isFinite(r.unwrittenBytes) && r.bytes === r.unwrittenBytes && r.processing >= 1 && Array.isArray(r.prepared)));
}

// Cancelling while a frame is prepared aborts its decoder and never processes
// or writes it; a frame that was ready is released (disposePrepared).
for (const readyBeforeCancel of [false, true]) {
  const controller = new AbortController();
  const processed = [];
  const written = [];
  const disposed = [];
  let prepareSignal = null;
  let abortedAt = null;
  const result = await runBatchPipeline([0, 1, 2], {
    maxParallel: 1,
    prepareDepth: 1,
    signal: controller.signal,
    prepare: async (job, { signal }) => {
      prepareSignal = signal;
      if (readyBeforeCancel) return { base: job };
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { abortedAt = job; reject(new DOMException('Decode was aborted', 'AbortError')); }, { once: true });
      });
    },
    disposePrepared: (value, job) => disposed.push({ value, job }),
    process: async (job, _index, prepared, context) => {
      processed.push(job);
      if (!prepared) context.decoded();
      await sleep(10);
      if (job === 0) controller.abort();
      return job;
    },
    sink: async (job) => { written.push(job); }
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(processed, [0]);
  assert.deepEqual(written, [0], 'the frame in process still finishes and is written');
  assert.equal(prepareSignal.aborted, true);
  if (readyBeforeCancel) assert.deepEqual(disposed, [{ value: { base: 1 }, job: 1 }]);
  else {
    assert.equal(abortedAt, 1);
    assert.deepEqual(disposed, []);
  }
}

// A batch that fails outright (an admission error) releases a frame that was
// decoded ahead and never taken.
{
  const disposed = [];
  let admissions = 0;
  await assert.rejects(runBatchPipeline([0, 1, 2], {
    maxParallel: 1,
    prepareDepth: 1,
    beforeStart: async () => { admissions += 1; if (admissions === 2) { await sleep(10); throw new Error('gate broke'); } },
    prepare: async (job) => ({ base: job }),
    disposePrepared: (value) => disposed.push(value),
    process: async (job, _index, prepared, context) => { if (!prepared) context.decoded(); await sleep(3); return job; },
    sink: async () => {}
  }), /gate broke/);
  assert.deepEqual(disposed, [{ base: 1 }]);
}

// A failed prepare fails only its own frame, with the prepare's error.
{
  const errors = [];
  const written = [];
  const result = await runBatchPipeline([0, 1, 2, 3], {
    maxParallel: 1,
    prepareDepth: 1,
    prepare: async (job) => { await sleep(2); if (job === 2) throw new Error('prefetch failed'); return job; },
    process: async (job, _index, prepared, context) => { if (prepared === undefined) context.decoded(); await sleep(5); return job; },
    sink: async (job) => { written.push(job); },
    onEvent: (event) => { if (event.type === 'error') errors.push([event.index, event.error.message]); }
  });
  assert.deepEqual(errors, [[2, 'prefetch failed']]);
  assert.deepEqual(written, [0, 1, 3]);
  assert.equal(result.failCount, 1);
}

// A lane that claims a frame while its admission is still being decided
// decodes it itself; the offer then never starts a second decode.
{
  const stage = createPrepareStage({
    depth: 1,
    admit: () => sleep(5).then(() => true),
    prepare: async () => assert.fail('the lane took the frame first')
  });
  const offered = stage.offer(0, 'job');
  assert.equal(stage.take(0), null);
  assert.equal(await offered, false);
  assert.equal(stage.size, 0);
}

// A prepared frame is process()'s alone: once process() lets it go (the early
// release, #256 Part 1), neither the pipeline nor the prepare stage keeps it.
{
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const collected = new Set();
  const registry = new FinalizationRegistry((name) => collected.add(name));
  const seen = [];
  const result = await runBatchPipeline([0, 1, 2], {
    maxParallel: 1,
    prepareDepth: 1,
    prepare: async (job) => {
      const base = { job, pixels: new Uint16Array(1 << 16) };
      registry.register(base, `base-${job}`);
      return base;
    },
    process: async (job, _index, prepared, context) => {
      if (!prepared) {
        context.decoded();
        await sleep(5);
        return job;
      }
      const holder = { prepared };
      prepared = null;
      holder.prepared = null; // released early
      for (let i = 0; i < 4; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      seen.push(collected.has(`base-${job}`));
      return job;
    },
    sink: async () => {}
  });
  assert.equal(result.successCount, 3);
  assert.deepEqual(seen, [true, true], 'the prepared base is unreachable once process() lets it go');
}

// ---- Part 4: decode and post-decode sub-stages -------------------------------------

// With depth 2 the next frame's decoder starts once the previous prepared
// frame has moved to its post-decode pass; each sub-stage holds one frame.
{
  let inDecode = 0; let peakDecode = 0;
  let inPost = 0; let peakPost = 0;
  const order = [];
  const stats = {};
  const result = await runBatchPipeline([0, 1, 2, 3, 4, 5], {
    maxParallel: 1,
    prepareDepth: 2,
    stats,
    prepare: async (job, { stage }) => {
      inDecode += 1; peakDecode = Math.max(peakDecode, inDecode);
      order.push(`decode:${job}`);
      await sleep(6);
      inDecode -= 1;
      await stage('postDecode');
      inPost += 1; peakPost = Math.max(peakPost, inPost);
      order.push(`post:${job}`);
      await sleep(4);
      inPost -= 1;
      order.push(`postDone:${job}`);
      return job;
    },
    process: async (job, _index, prepared, context) => {
      if (prepared === undefined) { await sleep(10); context.decoded(); }
      await sleep(25);
      return job;
    },
    sink: async () => {}
  });
  assert.equal(result.successCount, 6);
  assert.equal(peakDecode, 1, 'one frame in the decoder');
  assert.equal(peakPost, 1, 'one frame in the post-decode pass');
  assert.equal(stats.prepare.peakPrepared, 2, 'two sub-stages hold two frames');
  // Frame 2's decoder started before frame 1 left its post-decode pass or
  // was taken: the decode slot is free once a frame reaches post-decode.
  assert.ok(order.indexOf('decode:2') < order.indexOf('postDone:1'), order.join());
}

// ---- planDecodeAhead -------------------------------------------------------------

{
  const px60 = 60_400_000;
  // The issue's budget example: editor + sessions 2.46 GB, one processing
  // lane after Part 1, one decode ahead, one unwritten TIFF16.
  const example = planDecodeAhead({
    candidatePixels: px60, processingPixels: [px60], unwrittenBytes: 0.36e9, residentBytes: 2.46e9
  });
  assert.equal(example.admit, true);
  assert.ok(example.bytes > 5.8e9 && example.bytes < 6.3e9, String(example.bytes));
  // The pre-#256 lane (50 B/px) does not fit.
  const before = planDecodeAhead({
    candidatePixels: px60, residentBytes: 2.46e9 + px60 * (50 - PROCESSING_SLOT_BYTES_PER_PIXEL),
    processingPixels: [px60], unwrittenBytes: 0.36e9
  });
  assert.equal(before.admit, false);
  assert.equal(before.reason, 'ceiling');
  // Low-memory devices and the hidden-window limit switch it off.
  assert.equal(planDecodeAhead({ candidatePixels: 1e6, deviceMemory: 4 }).reason, 'low-memory');
  assert.equal(planDecodeAhead({ candidatePixels: 1e6, deviceMemory: 8 }).admit, true);
  assert.equal(planDecodeAhead({ candidatePixels: 1e6, hiddenLimited: true }).reason, 'hidden');
  // WebKit reports no deviceMemory: the estimate alone decides.
  assert.equal(planDecodeAhead({ candidatePixels: px60, residentBytes: DECODE_AHEAD_CEILING_BYTES }).admit, false);
  // A second frame decoded ahead counts its decoder.
  assert.ok(planDecodeAhead({ candidatePixels: px60, decodingPixels: [px60] }).bytes
    > planDecodeAhead({ candidatePixels: px60, waitingPixels: [px60] }).bytes);
}

console.log('batch pipeline stage tests passed');
