import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createGpuPreviewScheduler, GPU_SETTLE_IDLE_MS, GPU_INPUT_RETRY_MS, DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';
import { gpuSettleFixture, mainFunction, settle } from './gpuSettleHarness.mjs';

// #239: the GPU preview's own scheduling, on a fake clock: draws at the next frame
// with the newest settings, the settle 150 ms after the last request (or at once),
// busy while the display is ahead of its exact frame, and every way back.
function harness({ drawable = true } = {}) {
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const log = [];
  let idle = 0, abandoned = 0;
  const env = {
    armFrame: fire => { const id = nextId++; frames.set(id, fire); return { id }; },
    cancelFrame: handle => frames.delete(handle.id),
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    draw: () => { log.push('draw'); return h.drawable; },
    postExact: token => log.push(`exact:${token}`),
    onIdle: () => { idle++; },
    onAbandon: () => { abandoned++; },
  };
  const h = {
    drawable, log, timers, frames,
    scheduler: createGpuPreviewScheduler(env),
    runFrame() { const due = [...frames.values()]; frames.clear(); for (const fire of due) fire(); },
    runTimers() { const due = [...timers.values()]; timers.clear(); for (const t of due) t.callback(); },
    get idle() { return idle; },
    get abandoned() { return abandoned; },
  };
  return h;
}

{
  // A drag: one draw per frame with the newest state, no exact frame until 150 ms idle.
  const h = harness();
  const s = h.scheduler;
  s.request(1);
  s.request(2);
  assert.equal(h.frames.size, 1, 'one draw per frame');
  assert.equal([...h.timers.values()][0].delay, GPU_SETTLE_IDLE_MS);
  assert.ok(s.isAhead() && s.busy() && s.settleArmed());
  h.runFrame();
  s.request(3);
  h.runFrame();
  assert.deepEqual(h.log, ['draw', 'draw'], 'frames draw, nothing converts during the drag');
  assert.equal(h.timers.size, 1, 'each request re-arms the one settle timer');
  h.runTimers();
  assert.deepEqual(h.log, ['draw', 'draw', 'exact:3'], 'the settle carries the newest token');
  assert.ok(s.busy(), 'still busy until the exact frame is applied');
  s.settleNow();
  assert.equal(h.log.filter(entry => entry.startsWith('exact')).length, 1, 'a settle leaves once per token');
  s.exactApplied(2);
  assert.ok(s.isAhead(), 'an older exact frame does not settle a newer GPU frame');
  s.exactApplied(3);
  assert.ok(!s.isAhead() && !s.busy());
  assert.equal(h.idle, 1, 'the barrier hears that it is idle');
  assert.equal(s.stats.draws, 2);
}

{
  // A commit settles at once; a draw that cannot happen settles too.
  const h = harness();
  const s = h.scheduler;
  s.request(5, { settle: true });
  assert.deepEqual(h.log, ['exact:5']);
  assert.equal(h.timers.size, 0);
  h.runFrame();
  assert.deepEqual(h.log, ['exact:5', 'draw'], 'the GPU still shows it until the exact frame lands');
  h.drawable = false;
  s.request(6);
  h.runFrame();
  assert.deepEqual(h.log.slice(-2), ['draw', 'exact:6'], 'an impossible draw falls back to the exact frame');
  assert.equal(s.stats.failedDraws, 1);
  s.exactApplied(6);
  assert.ok(!s.busy());
}

{
  // settleNow from an export barrier; redraw only while ahead.
  const h = harness();
  const s = h.scheduler;
  assert.equal(s.settleNow(), false, 'nothing ahead: nothing to settle');
  s.redraw();
  assert.equal(h.frames.size, 0);
  s.request(8);
  assert.equal(s.settleNow(), true);
  assert.deepEqual(h.log, ['exact:8']);
  h.runFrame();
  s.redraw();
  assert.equal(h.frames.size, 1, 'an analysis reply redraws');
}

{
  // A conversion request takes over the newest settings.
  const h = harness();
  const s = h.scheduler;
  s.request(10);
  s.handOver(11);
  assert.equal(h.timers.size, 0, 'no settle of its own');
  assert.ok(s.busy());
  s.flightEnded(10);
  assert.ok(s.isAhead(), 'an older flight ends without effect');
  s.exactApplied(11);
  assert.ok(!s.busy());
  s.handOver(12);
  assert.ok(!s.isAhead(), 'nothing to hand over when the exact frame is current');
}

{
  // A settle that ends without applying (another photo, a failure) abandons the GPU frame.
  const h = harness();
  const s = h.scheduler;
  s.request(20);
  s.flightEnded(20);
  assert.ok(s.isAhead(), 'a flight that was not the settle does not abandon');
  s.settleNow();
  s.flightEnded(20);
  assert.ok(!s.isAhead() && !s.busy());
  assert.equal(h.abandoned, 1, 'the display returns to its exact frame');
  assert.equal(h.frames.size, 0, 'the pending draw is cancelled');
}

{
  // cancel: photo switch, undo, restart.
  const h = harness();
  const s = h.scheduler;
  s.request(30);
  s.cancel();
  assert.ok(!s.busy() && h.frames.size === 0 && h.timers.size === 0);
  assert.equal(h.idle, 1);
  s.cancel();
  assert.equal(h.idle, 1, 'cancelling nothing reports nothing');
  h.runTimers();
  assert.deepEqual(h.log, []);
}

for (const key of Object.keys(createGpuPreviewScheduler({ armFrame() {}, cancelFrame() {}, setTimeout() {}, clearTimeout() {} }))) {
  assert.ok(key in DISABLED_GPU_PREVIEW_SCHEDULER, `the disabled scheduler has ${key}`);
}
assert.equal(DISABLED_GPU_PREVIEW_SCHEDULER.busy(), false);

// ---- main.js on the scheduler (#229 review R1-046) ----

const applies = f => f.log.filter(entry => entry.startsWith('apply:')).map(entry => Number(entry.slice(6)));
const draws = f => f.log.filter(entry => entry.startsWith('gpu:'));

{
  // The preset's 3D profile failed to load: the GPU cannot draw these ticks,
  // so they are not its. Every tick of a continuous drag converts, and every
  // exact frame is applied as it lands, as before #239. Within the retry delay
  // no tick asks for the profile again.
  const f = gpuSettleFixture({ profile: 'frontier' });
  f.context.gpuPreview.profile.failed.set('frontier', 0);
  f.clock.now = 1000;
  const tick = async (exposure) => {
    f.clock.nextFrame();
    f.state.coreExposure = exposure;
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    f.clock.runFrame();
  };
  await tick(10);
  for (const exposure of [20, 30, 40]) {
    await tick(exposure);
    // The frame in flight lands behind the newer tick.
    await f.answer();
  }
  await f.answer();
  assert.deepEqual(f.conversions.map(entry => entry.exposure), [10, 20, 30, 40], 'each tick converts');
  assert.deepEqual(applies(f), [10, 20, 30, 40], 'every exact frame of the drag reaches the screen');
  assert.deepEqual(draws(f), [], 'the GPU draws none of them');
  assert.equal(f.context.gpuPreviewScheduler.stats.requests, 0, 'none of them is the GPU\'s');
  assert.equal(f.profileLoads.length, 0, 'the failed profile is not fetched again within the retry delay');

  // After the delay a tick fetches it again (the network is back): that tick
  // still converts, and once the profile is baked the GPU draws the next one.
  f.clock.now = GPU_INPUT_RETRY_MS + 1;
  f.clock.nextFrame();
  f.state.coreExposure = 50;
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  assert.deepEqual(f.profileLoads.map(load => load.name), ['frontier'], 'retried after the delay');
  assert.equal(f.conversions.at(-1).exposure, 50, 'the tick that retries converts');
  f.profileLoads[0].resolve({ name: 'frontier', baked: true });
  await settle();
  await f.answer();
  assert.equal(f.context.gpuPreview.profile.name, 'frontier');
  const converted = f.conversions.length;
  f.clock.nextFrame();
  f.state.coreExposure = 60;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  assert.equal(f.conversions.length, converted, 'the recovered profile takes the next tick to the GPU');
  assert.deepEqual(draws(f), ['gpu:60']);
  assert.equal(f.context.gpuPreview.engine.enhancedLut.name, 'frontier');
}

{
  // A tick the take test passes but applyProgram cannot draw: the exact frame
  // stays on screen. Each exact frame landing behind a newer tick is applied
  // all the same (the settle the newer tick owes follows), so a continuous drag
  // shows every frame instead of the pre-drag one until the pointer rests.
  const f = gpuSettleFixture();
  f.gpu.drawable = false;
  for (const exposure of [10, 20, 30, 40]) {
    f.clock.nextFrame();
    f.state.coreExposure = exposure;
    f.context.scheduleCoreReprocess({ full: false });
    if (f.conversions.length) await f.answer();
    f.clock.runFrame();
    await settle();
  }
  await f.answer();
  assert.deepEqual(applies(f), [10, 20, 30, 40], 'none is dropped while nothing newer was drawn');
  assert.equal(f.context.gpuPreviewScheduler.stats.failedDraws, 4);
  assert.equal(f.context.gpuPreviewScheduler.isAhead(), false, 'the last one settles the display');

  // A frame that lands behind a tick the GPU did draw is still dropped.
  f.gpu.drawable = true;
  f.clock.nextFrame();
  f.state.coreExposure = 50;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  f.context.gpuPreviewScheduler.settleNow();
  f.clock.nextFrame();
  f.state.coreExposure = 60;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  await f.answer();
  assert.deepEqual(applies(f), [10, 20, 30, 40], 'an older exact frame never replaces a newer GPU frame');
}

{
  // The take test declines what the draw would fail on, and asks for it: a
  // texture prepared for other inputs (film base, flat field, mode, strokes),
  // an analysis of another mode.
  const f = gpuSettleFixture();
  f.gpu.tag = 'film base moved';
  assert.equal(f.context.gpuPreviewCanTake(), false);
  assert.equal(f.gpu.prepares, 1, 'the texture is prepared again');
  f.context.gpuPreview.prepared.tag = 'film base moved';
  assert.equal(f.context.gpuPreviewCanTake(), true);
  f.gpu.mode = 'bw';
  f.gpu.tag = 'bw';
  f.context.gpuPreview.prepared.tag = 'bw';
  assert.equal(f.context.gpuPreviewCanTake(), false, 'an analysis of the colour mode cannot draw B&W');
  assert.equal(f.gpu.analyzes, 1, 'the analysis is asked for');
  f.context.gpuPreview.analysis.mode = 'bw';
  assert.equal(f.context.gpuPreviewCanTake(), true);
}

{
  // A failed analysis is asked again for another key at once, and for the same
  // key after the retry delay, never in a loop.
  const f = gpuSettleFixture();
  const requests = [];
  let key = 'k1';
  Object.assign(f.context, {
    getColorAnalysisSample: () => null, silverCoreAnalysisKey: () => key, previewRequestImage: image => ({ image }),
    convertPreviewFrameInWorker: { analyze: () => new Promise((resolve, reject) => requests.push({ key, resolve, reject })) },
  });
  Object.assign(f.context.gpuPreview, { analysis: null, analyzeFlight: false, analysisWanted: false });
  vm.runInContext(mainFunction('requestGpuAnalyze'), f.context);
  f.context.requestGpuAnalyze();
  requests[0].reject(new Error('worker restarted'));
  await settle();
  f.context.requestGpuAnalyze();
  assert.equal(requests.length, 1, 'not asked again at once');
  key = 'k2';
  f.context.requestGpuAnalyze();
  assert.equal(requests.length, 2, 'another key is asked for');
  requests[1].resolve({ channelData: [] });
  await settle();
  key = 'k1';
  f.context.requestGpuAnalyze();
  assert.equal(requests.length, 2, 'the failed key waits for the retry delay');
  f.clock.now = GPU_INPUT_RETRY_MS;
  f.context.requestGpuAnalyze();
  assert.equal(requests.length, 3, 'then it is asked again');
}

{
  // Picking a preset gives its failed profile another try at once.
  const f = gpuSettleFixture();
  f.context.applyFilmPresetSettingsToState = async (presetId) => {
    f.state.coreFilmPreset = presetId;
    f.state.coreEnhancedProfile = 'frontier';
  };
  vm.runInContext(mainFunction('handleFilmPresetChange'), f.context);
  f.context.gpuPreview.profile.failed.set('frontier', 0);
  f.clock.now = 1;
  f.context.handleFilmPresetChange('fuji-frontier');
  await settle();
  assert.deepEqual(f.profileLoads.map(load => load.name), ['frontier'], 'fetched again without waiting for the delay');
  assert.equal(f.conversions.length, 1, 'meanwhile the worker converts the preset');
}

console.log('gpuPreviewScheduler: frame-paced draws, idle/commit/barrier settles, hand-over, abandon and cancel; in main.js the GPU takes only ticks it can draw, a failed draw keeps the exact frames coming, failed profiles and analyses are retried');
