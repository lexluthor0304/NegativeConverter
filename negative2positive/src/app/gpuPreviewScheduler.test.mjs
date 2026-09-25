import assert from 'node:assert/strict';
import { createGpuPreviewScheduler, GPU_SETTLE_IDLE_MS, DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';

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

console.log('gpuPreviewScheduler: frame-paced draws, idle/commit/barrier settles, hand-over, abandon and cancel');
