import assert from 'node:assert/strict';
import {
  createPreviewTierController, capBackingSize, frameIntervalStats, isSlowFrameSample,
  parsePreviewTierOverride, previewTierMaxPixels,
  PREVIEW_TIER_NORMAL_MAX_PIXELS, PREVIEW_TIER_REDUCED_MAX_PIXELS, PREVIEW_TIER_WATCHDOG_MS,
  PREVIEW_TIER_REPROBE_EVERY
} from './previewTier.js';
import { displayPreviewSize } from './displayPreview.js';

// ---- Sizes ----
assert.equal(previewTierMaxPixels('normal'), PREVIEW_TIER_NORMAL_MAX_PIXELS);
assert.equal(previewTierMaxPixels('reduced'), PREVIEW_TIER_REDUCED_MAX_PIXELS);
assert.equal(previewTierMaxPixels(undefined), PREVIEW_TIER_NORMAL_MAX_PIXELS);
// The normal tier passes exactly the limit displayPreviewSize defaulted to, so
// every display size outside a reduced session is unchanged.
for (const [w, h, options] of [
  [9504, 6336, { viewportWidth: 1100, viewportHeight: 620, dpr: 2, zoom: 1 }],
  [9504, 6336, { viewportWidth: 1100, viewportHeight: 620, dpr: 1, zoom: 4 }],
  [4288, 2848, { viewportWidth: 1100, viewportHeight: 620, dpr: 2, zoom: 1 }],
  [900, 600, { viewportWidth: 1400, viewportHeight: 880, dpr: 2, zoom: 1 }],
]) {
  assert.deepEqual(displayPreviewSize(w, h, { ...options, maxPixels: previewTierMaxPixels('normal') }), displayPreviewSize(w, h, options));
  const reduced = displayPreviewSize(w, h, { ...options, maxPixels: previewTierMaxPixels('reduced') });
  assert.ok(reduced.width * reduced.height <= PREVIEW_TIER_REDUCED_MAX_PIXELS, `reduced ${w}x${h} fits 1 MP`);
}

assert.deepEqual(capBackingSize(1809, 1202, PREVIEW_TIER_NORMAL_MAX_PIXELS), { width: 1809, height: 1202 }, 'within the limit: unchanged');
assert.deepEqual(capBackingSize(1000, 1000, 1_000_000), { width: 1000, height: 1000 });
{
  const capped = capBackingSize(2448, 1632, PREVIEW_TIER_REDUCED_MAX_PIXELS);
  assert.ok(capped.width * capped.height <= PREVIEW_TIER_REDUCED_MAX_PIXELS);
  assert.ok(Math.abs(capped.width / capped.height - 2448 / 1632) < 0.01, 'aspect ratio kept');
  assert.ok(capped.width * capped.height > 0.99 * PREVIEW_TIER_REDUCED_MAX_PIXELS - capped.width - capped.height);
}
assert.deepEqual(capBackingSize(0, 10, 100), { width: 0, height: 10 });

assert.equal(parsePreviewTierOverride('?previewTier=reduced'), 'reduced');
assert.equal(parsePreviewTierOverride('?lang=en&previewTier=normal'), 'normal');
assert.equal(parsePreviewTierOverride('?previewTier=fast'), null);
assert.equal(parsePreviewTierOverride(''), null);

// ---- Frame statistics ----
assert.deepEqual(frameIntervalStats([]), { count: 0, p50: null, p95: null });
assert.deepEqual(frameIntervalStats([10, 30, 20]), { count: 3, p50: 20, p95: 30 });
const steady = (ms, n = 12) => Array.from({ length: n }, () => ms);
assert.equal(isSlowFrameSample(steady(40, 9), 16.7), false, 'fewer than 10 intervals never decide');
assert.equal(isSlowFrameSample(steady(40), 16.7), true);
assert.equal(isSlowFrameSample(steady(16.7), 16.7), false, '60 Hz is fast');
assert.equal(isSlowFrameSample(steady(33.3), 33.3), false, 'a host capped at 30 Hz is not slow');
assert.equal(isSlowFrameSample(steady(33.3), 16.7), true, 'the same 30 Hz on a 60 Hz host is');
assert.equal(isSlowFrameSample(steady(22), 8.3), false, 'under 24 ms is never slow, even on a 120 Hz host');
// Isolated gaps from background roll work (up to ~480 ms) do not move the median.
assert.equal(isSlowFrameSample([...steady(16.7, 10), 478, 120, 60], 16.7), false);
// Only the recent window counts: a drag that turns slow is caught.
assert.equal(isSlowFrameSample([...steady(16.7, 60), ...steady(45, 16)], 16.7), true);
assert.equal(isSlowFrameSample(steady(40), null), true, 'unknown idle interval assumes 60 Hz');

// ---- The controller, on a fake clock ----
function fakeClock() {
  let nextId = 1;
  const frames = new Map();
  const timers = new Map();
  const clock = {
    time: 0, hidden: false, frames, timers,
    requestFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: clock.time + delay }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    now: () => clock.time,
    isHidden: () => clock.hidden,
    // Advances by `ms` and runs the frame callbacks queued before it.
    // Input arrives with every frame unless a test turns it off.
    input: null,
    frame(ms) {
      clock.time += ms;
      clock.input?.();
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(clock.time);
      clock.fireTimers();
    },
    frames_(ms, count) { for (let i = 0; i < count; i++) clock.frame(ms); },
    advance(ms) { clock.time += ms; clock.fireTimers(); },
    fireTimers() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock.time) { timers.delete(id); timer.callback(); }
      }
    },
  };
  return clock;
}

function controllerFixture(options = {}) {
  const clock = fakeClock();
  const changes = [];
  const sessions = [];
  let backing = { width: 2448, height: 1632 };
  const controller = createPreviewTierController({
    requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, isHidden: clock.isHidden,
    onChange: (tier, reason) => {
      changes.push([tier, reason]);
      backing = tier === 'reduced' ? { width: 1224, height: 816 } : { width: 2448, height: 1632 };
    },
    onSessionEnd: (summary) => sessions.push(summary),
    measureBacking: () => backing,
    ...options
  });
  clock.input = () => controller.touch();
  return { clock, controller, changes, sessions };
}

{
  // A fast drag never engages the tier.
  const { clock, controller, changes, sessions } = controllerFixture();
  assert.equal(controller.begin('slider'), 'normal');
  assert.equal(controller.active, true);
  clock.frames_(16.7, 40);
  controller.end('pointerup');
  assert.deepEqual(changes, []);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].reduced, false);
  // 40 frames give 39 intervals; the first is dropped.
  assert.equal(sessions[0].intervals, 38, 'the first interval is dropped');
  assert.ok(Math.abs(sessions[0].p50 - 16.7) < 1e-9);
  assert.deepEqual(sessions[0].backing, { width: 2448, height: 1632 });
  assert.deepEqual(sessions[0].maxBacking, { width: 2448, height: 1632 });
  assert.equal(clock.frames.size + clock.timers.size, 0, 'no rAF loop or watchdog after the session');
}

{
  // A slow drag drops after 10 intervals and stays reduced until release.
  const { clock, controller, changes, sessions } = controllerFixture();
  controller.begin('slider');
  clock.frame(250); // the first frame after pointerdown only starts the clock
  clock.frame(40); // the first interval is dropped
  clock.frames_(40, 9);
  assert.equal(controller.tier, 'normal', 'nine intervals decide nothing');
  clock.frame(40);
  assert.equal(controller.tier, 'reduced');
  assert.deepEqual(changes, [['reduced', 'slow-frames']]);
  clock.frames_(16.7, 40); // fast again at the reduced tier: no oscillation
  assert.equal(controller.tier, 'reduced');
  const summary = controller.end('change');
  assert.deepEqual(changes, [['reduced', 'slow-frames'], ['normal', 'change']]);
  assert.equal(summary.reduced, true);
  assert.equal(summary.trigger, 'slow-frames');
  assert.deepEqual(summary.backing, { width: 1224, height: 816 }, 'the reduced buffer at release');
  assert.deepEqual(summary.maxBacking, { width: 2448, height: 1632 }, 'largest backing store of the session');
  assert.equal(sessions.length, 1);
}

{
  // The idle interval: a host whose rAF runs at 30 Hz is not slow at 30 Hz.
  const { clock, controller, changes } = controllerFixture();
  assert.equal(controller.measureIdleInterval(), true);
  clock.frames_(33.3, 14);
  assert.ok(Math.abs(controller.idleInterval - 33.3) < 1e-6);
  controller.begin('slider');
  clock.frames_(33.3, 30);
  controller.end('pointerup');
  assert.deepEqual(changes, []);
  // A session starting mid-probe discards it.
  controller.measureIdleInterval();
  clock.frames_(10, 3);
  controller.begin('curve');
  clock.frames_(10, 20);
  controller.end('mouseup');
  assert.ok(Math.abs(controller.idleInterval - 33.3) < 1e-6, 'probe interrupted by a session is discarded');
}

{
  // Watchdog: a session with no input for 1 s ends on its own; input keeps it.
  const { clock, controller, sessions } = controllerFixture();
  clock.input = null;
  controller.begin('slider');
  clock.advance(PREVIEW_TIER_WATCHDOG_MS - 100);
  controller.touch();
  clock.advance(PREVIEW_TIER_WATCHDOG_MS - 100);
  assert.equal(controller.active, true);
  clock.advance(200);
  assert.equal(controller.active, false);
  assert.equal(sessions.at(-1).endReason, 'watchdog');
  // end() for another kind leaves the session alone.
  controller.begin('slider');
  assert.equal(controller.end('mouseleave', 'curve'), null);
  assert.equal(controller.active, true);
  assert.ok(controller.end('pointerup', 'slider'));
}

{
  // Hidden pages paint nothing: the gap is not counted, and no decision is made.
  const { clock, controller, changes } = controllerFixture();
  controller.begin('slider');
  clock.frames_(16.7, 5);
  clock.hidden = true;
  clock.frames_(1000, 3);
  clock.hidden = false;
  controller.resetFrameClock();
  clock.frames_(16.7, 20);
  const summary = controller.end('pointerup');
  assert.deepEqual(changes, []);
  assert.ok(summary.p95 < 20, 'hidden gaps are not frame intervals');
}

{
  // Known software compositing: every session starts reduced; the settled
  // state (between sessions) is always normal.
  const { clock, controller, changes } = controllerFixture();
  controller.setEnvironment('software-compositing');
  assert.deepEqual(controller.nextStart(), { tier: 'reduced', reason: 'software-compositing' });
  for (let i = 0; i < 3; i++) {
    assert.equal(controller.begin('slider'), 'reduced');
    clock.frames_(16.7, 3);
    controller.end('pointerup');
    assert.equal(controller.tier, 'normal');
  }
  assert.deepEqual(changes.map(([tier]) => tier), ['reduced', 'normal', 'reduced', 'normal', 'reduced', 'normal']);
  assert.equal(controller.lastSummary.trigger, 'software-compositing');
}

{
  // Two dropped sessions in a row start the following ones reduced; every
  // 10th re-probes at normal, and a fast probe clears the memory.
  const { clock, controller } = controllerFixture();
  const slowSession = () => { controller.begin('slider'); clock.frames_(40, 14); return controller.end('pointerup'); };
  const fastSession = () => { controller.begin('slider'); clock.frames_(16.7, 14); return controller.end('pointerup'); };
  assert.equal(slowSession().startTier, 'normal');
  assert.equal(controller.nextStart().tier, 'normal', 'one slow session is not a pattern');
  assert.equal(slowSession().startTier, 'normal');
  const starts = [];
  for (let i = 0; i < PREVIEW_TIER_REPROBE_EVERY; i++) {
    const next = controller.nextStart();
    starts.push(next.reason);
    if (next.reason === 'reprobe') slowSession(); else fastSession();
  }
  assert.deepEqual(starts, [...Array(PREVIEW_TIER_REPROBE_EVERY - 1).fill('slow-sessions'), 'reprobe']);
  assert.equal(controller.nextStart().reason, 'slow-sessions', 'a slow re-probe keeps the memory');
  for (let i = 0; i < PREVIEW_TIER_REPROBE_EVERY - 1; i++) fastSession();
  assert.equal(controller.nextStart().reason, 'reprobe');
  // A short (inconclusive) probe proves nothing; the next session probes again.
  controller.begin('slider'); clock.frames_(16.7, 4); controller.end('pointerup');
  assert.equal(controller.nextStart().reason, 'reprobe');
  fastSession();
  assert.deepEqual(controller.nextStart(), { tier: 'normal', reason: null }, 'a fast probe clears the memory');
  // A slow session followed by a fast one is no streak.
  slowSession(); fastSession(); slowSession();
  assert.equal(controller.nextStart().tier, 'normal');
}

{
  // Test hooks: forced tiers.
  const reduced = controllerFixture({ force: 'reduced' });
  assert.equal(reduced.controller.begin('slider'), 'reduced');
  assert.equal(reduced.controller.end('pointerup').startReason, 'forced');
  const normal = controllerFixture({ force: 'normal' });
  normal.controller.begin('slider');
  normal.clock.frames_(80, 30);
  assert.equal(normal.controller.tier, 'normal', 'forced normal never drops');
  normal.controller.end('pointerup');
  assert.deepEqual(normal.changes, []);
}

console.log('previewTier tests passed');
