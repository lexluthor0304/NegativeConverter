// Roll-analysis lane planning (#252 part 1) and the decode slots its lanes
// share (part 3): never below the export planner, exactly today's plan
// without a known RAM above 8 GiB, and 2 frames in flight at 60 MP on 16 GB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  planRollAnalysis, planBatchParallelism, rollAnalysisFootprint, createDecodeSlots,
  ROLL_ANALYSIS_RAM_SHARE, ROLL_ANALYSIS_MIN_RAM_BYTES
} from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import { importPixelsForRoll, rememberImageDimensions, UNKNOWN_IMAGE_PIXELS } from './imageDimensions.js';

const GiB = 1024 ** 3;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

// Footprint model: the decode estimate, and 14 B/px plus one OpenCV realm.
{
  const px = 9536 * 6336;
  const { decodeBytes, frameBytes } = rollAnalysisFootprint(px);
  assert.equal(decodeBytes, estimateRawDecodeBytes(9536, 6336));
  assert.ok(Math.abs(decodeBytes / 1e9 - 1.84) < 0.01, `decode slot ${decodeBytes}`);
  assert.ok(Math.abs(frameBytes / 1e9 - 1.0) < 0.02, `frame in analysis ${frameBytes}`);
}

// The table: 18/24/36/45/60 MP x unknown/4/8/16/32 GB on 8 cores.
const table = {};
for (const mp of [18.5, 24, 36, 45, 60.4]) {
  for (const gb of [undefined, 4, 8, 16, 32]) {
    const pixels = Math.round(mp * 1e6);
    const options = { pixels, ramBytes: gb ? gb * GiB : undefined, hardwareConcurrency: 8, deviceMemory: gb, fileCount: 20 };
    const plan = planRollAnalysis(options);
    const today = planBatchParallelism({ hardwareConcurrency: 8, deviceMemory: gb, pixelsPerFile: pixels, fileCount: 20 });
    table[`${mp}@${gb ?? '?'}`] = `${plan.decodeSlots}/${plan.framesInFlight}`;
    assert.ok(plan.decodeSlots >= today && plan.framesInFlight >= today, `never below today at ${mp} MP / ${gb} GB`);
    assert.ok(plan.framesInFlight >= plan.decodeSlots);
    if (!gb || gb <= 8) assert.deepEqual([plan.decodeSlots, plan.framesInFlight], [today, today], `today's plan at ${mp} MP / ${gb} GB`);
    else if (plan.decodeSlots !== today || plan.framesInFlight !== today) {
      const bytes = plan.decodeSlots * plan.decodeBytes + plan.framesInFlight * plan.frameBytes;
      assert.ok(bytes <= gb * GiB * ROLL_ANALYSIS_RAM_SHARE, `planned bytes fit at ${mp} MP / ${gb} GB`);
      assert.ok(plan.decodeSlots + plan.framesInFlight <= 6, 'two cores stay free');
    }
  }
}
assert.deepEqual(table, {
  '18.5@?': '4/4', '18.5@4': '1/1', '18.5@8': '4/4', '18.5@16': '4/4', '18.5@32': '4/4',
  '24@?': '3/3', '24@4': '1/1', '24@8': '3/3', '24@16': '3/3', '24@32': '3/3',
  '36@?': '2/2', '36@4': '1/1', '36@8': '2/2', '36@16': '2/2', '36@32': '2/4',
  '45@?': '1/1', '45@4': '1/1', '45@8': '1/1', '45@16': '1/2', '45@32': '2/4',
  '60.4@?': '1/1', '60.4@4': '1/1', '60.4@8': '1/1', '60.4@16': '1/2', '60.4@32': '2/4'
});

// Unknown RAM equals today's lanes across a sweep, whatever deviceMemory says.
for (let mp = 1; mp <= 150; mp += 7) {
  for (let cores = 1; cores <= 16; cores += 3) {
    for (const deviceMemory of [undefined, 2, 4, 8, 16]) {
      const pixels = mp * 1e6;
      const today = planBatchParallelism({ hardwareConcurrency: cores, deviceMemory, pixelsPerFile: pixels, fileCount: 40 });
      const plan = planRollAnalysis({ pixels, hardwareConcurrency: cores, deviceMemory, fileCount: 40 });
      assert.deepEqual([plan.decodeSlots, plan.framesInFlight], [today, today]);
      assert.equal(plan.budgetBytes, null);
    }
  }
}

// The nc_batch_lanes_v1 ceiling, the file count and the cores bound the plan.
assert.deepEqual(pick(planRollAnalysis({ pixels: 60.4e6, ramBytes: 16 * GiB, hardwareConcurrency: 8, maxParallel: 1, fileCount: 20 })), [1, 1]);
assert.deepEqual(pick(planRollAnalysis({ pixels: 60.4e6, ramBytes: 64 * GiB, hardwareConcurrency: 8, maxParallel: 2, fileCount: 20 })), [1, 2]);
assert.deepEqual(pick(planRollAnalysis({ pixels: 60.4e6, ramBytes: 16 * GiB, hardwareConcurrency: 8, fileCount: 1 })), [1, 1]);
assert.deepEqual(pick(planRollAnalysis({ pixels: 60.4e6, ramBytes: 16 * GiB, hardwareConcurrency: 4, fileCount: 20 })), [1, 1], 'four cores leave no room for a second frame');
assert.deepEqual(pick(planRollAnalysis({ pixels: 60.4e6, ramBytes: 16 * GiB, hardwareConcurrency: 5, fileCount: 20 })), [1, 2]);
// A header-less RAW (150 MP) keeps today's plan until its size is known.
assert.deepEqual(pick(planRollAnalysis({ pixels: UNKNOWN_IMAGE_PIXELS, ramBytes: 16 * GiB, hardwareConcurrency: 8, fileCount: 20 })), [1, 1]);
function pick(plan) { return [plan.decodeSlots, plan.framesInFlight]; }

// Header-less RAWs take the decoded size of a same-extension file of the
// import; others keep their header size; nothing else is seeded.
{
  const headerless = name => new File([new Uint8Array(64)], name);
  const a = headerless('L1.DNG'), b = headerless('L2.dng'), c = headerless('X.NEF');
  assert.equal(await importPixelsForRoll([a, b, c]), UNKNOWN_IMAGE_PIXELS);
  rememberImageDimensions(a, { width: 9536, height: 6336 });
  assert.equal(await importPixelsForRoll([a, b]), 9536 * 6336, 'the other DNG takes the decoded one\'s size');
  assert.equal(await importPixelsForRoll([a, b, c]), UNKNOWN_IMAGE_PIXELS, 'no NEF was decoded yet');
  assert.equal(await importPixelsForRoll([b]), UNKNOWN_IMAGE_PIXELS, 'only files of the same import seed');
  rememberImageDimensions(c, { width: 6000, height: 4000 });
  assert.equal(await importPixelsForRoll([a, b, c]), 9536 * 6336);
  // The plan follows: from today's single lane to 2 frames in flight.
  const plan = planRollAnalysis({ pixels: await importPixelsForRoll([a, b, c]), ramBytes: 16 * GiB, hardwareConcurrency: 8, fileCount: 3 });
  assert.deepEqual(pick(plan), [1, 2]);
}

// The app's plan (main.js planRollAnalysisLanes) is never below the export
// planner's lanes for the same files, which count the machine's RAM since
// #258 where planRollAnalysis's own floor does not (#229 review R2-013):
// where the analysis plan would run fewer frames or decoders, those lanes
// run, each with its own decoder. The reviewers' 24-50 MP x 16/24/32/64 GiB
// configurations on 8 cores, at every integer MP, with the web's capped
// deviceMemory and without one (the desktop app's WebViews).
const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function mainFunction(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(mainSource);
  assert.ok(match, `${name} exists`);
  const end = mainSource.indexOf('\n    }\n', match.index);
  return mainSource.slice(match.index, end + 6);
}
function planContext({ worker = true } = {}) {
  const context = vm.createContext({
    navigator: { hardwareConcurrency: 8, deviceMemory: undefined },
    memoryRuntime: { ramBytes: NaN }, desktopMemoryInfoReady: Promise.resolve(),
    safeStorageGet: () => null, pixels: 0,
    pixelsForMemory: async () => context.pixels,
    importPixelsForRoll: async () => context.pixels,
    planBatchParallelism, planRollAnalysis, ROLL_ANALYSIS_MIN_RAM_BYTES,
    ...(worker ? { Worker: function Worker() {}, OffscreenCanvas: function OffscreenCanvas() {} } : {})
  });
  vm.runInContext(['planBatchLaneBudget', 'planBatchLanes', 'machineRamBytes', 'rollFrameWorkerUsable', 'planRollAnalysisLanes']
    .map(mainFunction).join('\n'), context);
  return context;
}
{
  const context = planContext();
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `L${i}.NEF` }));
  let configurations = 0, raised = 0;
  for (const gb of [16, 24, 32, 64]) {
    for (const deviceMemory of [undefined, Math.min(gb, 32)]) {
      for (let mp = 24; mp <= 50; mp++) {
        configurations++;
        const pixels = mp * 1e6;
        Object.assign(context, { pixels });
        context.memoryRuntime.ramBytes = gb * GiB;
        context.navigator.deviceMemory = deviceMemory;
        const lanes = planBatchParallelism({ hardwareConcurrency: 8, deviceMemory, ramBytes: gb * GiB, pixelsPerFile: pixels, fileCount: 20 });
        const plan = await context.planRollAnalysisLanes(files);
        const at = `${mp} MP / ${gb} GiB / deviceMemory ${deviceMemory}`;
        assert.ok(plan.decodeSlots >= lanes && plan.framesInFlight >= lanes,
          `never below the export planner's ${lanes} lanes at ${at}: ${plan.decodeSlots}/${plan.framesInFlight}`);
        const analysis = planRollAnalysis({ pixels, ramBytes: gb * GiB, hardwareConcurrency: 8, deviceMemory, fileCount: 20 });
        if (analysis.decodeSlots >= lanes && analysis.framesInFlight >= lanes) {
          assert.deepEqual(pick(plan), pick(analysis), `the analysis plan where it is not below them at ${at}`);
          assert.equal(plan.slotBytes, analysis.decodeSlots * analysis.decodeBytes);
        } else {
          raised++;
          assert.deepEqual([plan.decodeSlots, plan.framesInFlight, plan.slotBytes], [lanes, lanes, Infinity],
            `else those lanes, each with its own decoder, at ${at}`);
        }
      }
    }
  }
  assert.equal(configurations, 216);
  assert.ok(raised >= 52, `the analysis plan alone fell below the export planner in ${raised} configurations`);
  // The reviewers' example: a 24 MP NEF roll on 8 cores and 24 GiB keeps
  // its 4 lanes (the analysis plan alone: 3 decoders, 3 frames).
  Object.assign(context, { pixels: 24e6 });
  context.memoryRuntime.ramBytes = 24 * GiB;
  context.navigator.deviceMemory = undefined;
  assert.deepEqual(pick(planRollAnalysis({ pixels: 24e6, ramBytes: 24 * GiB, hardwareConcurrency: 8, fileCount: 20 })), [3, 3]);
  assert.deepEqual(pick(await context.planRollAnalysisLanes(files)), [4, 4]);
  // 60 MP on 16 GiB keeps the analysis plan's 2 frames in flight on 1 decoder.
  Object.assign(context, { pixels: 60.4e6 });
  context.memoryRuntime.ramBytes = 16 * GiB;
  assert.deepEqual(pick(await context.planRollAnalysisLanes(files)), [1, 2]);
  // Unknown RAM or 8 GiB: exactly the export planner's lanes.
  for (const ram of [NaN, 8 * GiB]) {
    context.memoryRuntime.ramBytes = ram;
    const lanes = planBatchParallelism({ hardwareConcurrency: 8, ramBytes: ram, pixelsPerFile: 60.4e6, fileCount: 20 });
    const plan = await context.planRollAnalysisLanes(files);
    assert.deepEqual([plan.decodeSlots, plan.framesInFlight, plan.slotBytes], [lanes, lanes, Infinity]);
  }
}

// Decode slots: granted up to the slot count and byte budget, in order; a
// larger frame waits at the checkpoint; nothing overtakes it; abort and
// configure re-run the queue; one slot is always granted when none is held.
{
  const slots = createDecodeSlots({ slots: 1, budgetBytes: 1.84e9 });
  const first = await slots.acquire({ bytes: 1.84e9 });
  assert.equal(slots.held, 1);
  let second = null;
  const waiting = slots.acquire({ bytes: 1.84e9 }).then(release => { second = release; });
  await flush();
  assert.equal(second, null, 'the second demosaic waits for the first');
  assert.equal(slots.waiting, 1);
  first();
  await waiting;
  assert.equal(slots.held, 1);
  second();
  first();
  assert.equal(slots.held, 0, 'a release runs once');
  assert.equal(slots.peak, 1, 'no two demosaics overlapped');
}
{
  const slots = createDecodeSlots({ slots: 2, budgetBytes: 2 * 1.84e9 });
  const a = await slots.acquire({ bytes: 1.84e9 });
  let large = null, small = null;
  const largeWait = slots.acquire({ bytes: 2.9e9 }).then(release => { large = release; });
  const smallWait = slots.acquire({ bytes: 1e9 }).then(release => { small = release; });
  await flush();
  assert.equal(large, null, 'a larger frame waits instead of overcommitting');
  assert.equal(small, null, 'and nothing overtakes it');
  a();
  await largeWait;
  assert.ok(large, 'progress: a frame larger than the budget runs alone');
  await flush();
  assert.equal(small, null);
  large();
  await smallWait;
  small();
  // Abort removes a waiter; configure admits more.
  const held = await slots.acquire({ bytes: 1.84e9 });
  const held2 = await slots.acquire({ bytes: 1.84e9 });
  const controller = new AbortController();
  const aborted = slots.acquire({ bytes: 1, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, error => error.name === 'AbortError');
  assert.equal(slots.waiting, 0);
  await assert.rejects(slots.acquire({ bytes: 1, signal: controller.signal }), error => error.name === 'AbortError');
  let third = null;
  const thirdWait = slots.acquire({ bytes: 1e8 }).then(release => { third = release; });
  await flush();
  assert.equal(third, null);
  slots.configure({ slots: 3, budgetBytes: 4e9 });
  await thirdWait;
  assert.equal(slots.held, 3);
  held(); held2(); third();
  assert.equal(slots.held, 0);
  assert.equal(slots.heldBytes, 0);
}
console.log('ok planRollAnalysis');
