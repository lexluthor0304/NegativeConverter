import assert from 'node:assert/strict';
import {
  createHiddenJobGate, hiddenJobLimitsApply, estimateHiddenJobBytes,
  HIDDEN_GRACE_MS, HIDDEN_BUDGET_BYTES, LANE_BYTES_PER_PIXEL,
  WEBKIT_INACTIVE_DELAY_MS, WEBKIT_INACTIVE_KILL_BYTES
} from './hiddenJobGate.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const GB = 1e9;

function harness({ limits = true, resident = 0, hidden = false } = {}) {
  const env = { hidden, limits, resident, time: 0, timers: new Map(), nextTimer: 0, changes: [], hiddenAdmits: 0, graceExpired: 0, idle: 0,
    budgetHolds: 0, log: [], shed: null };
  env.gate = createHiddenJobGate({
    isHidden: () => env.hidden,
    limitsApply: () => env.limits,
    residentBytes: () => env.resident,
    now: () => env.time,
    setTimer: (fn, ms) => { const id = ++env.nextTimer; env.timers.set(id, { fn, at: env.time + ms }); return id; },
    clearTimer: id => env.timers.delete(id),
    onChange: status => { env.changes.push(status.paused); env.log.push(status.paused ? 'paused' : 'resumed'); },
    onHiddenAdmit: () => { env.hiddenAdmits += 1; },
    onGraceExpired: () => { env.graceExpired += 1; },
    onIdle: () => { env.idle += 1; },
    // What a page sheds before an item is held for its bytes (`env.shed`).
    onBudgetHold: () => { env.budgetHolds += 1; env.log.push('shed'); env.shed?.(); }
  });
  env.hide = () => { env.hidden = true; env.gate.visibilityChanged(); };
  env.show = () => { env.hidden = false; env.gate.visibilityChanged(); };
  env.advance = (ms) => {
    env.time += ms;
    for (const [id, timer] of [...env.timers]) {
      if (timer.at <= env.time) { env.timers.delete(id); timer.fn(); }
    }
  };
  return env;
}

function track(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(value => { box.settled = true; box.value = value; }, error => { box.settled = true; box.error = error; });
  return box;
}

// Constants stay in one place and match the WebKit figures the issue uses.
assert.equal(HIDDEN_GRACE_MS, 5 * 60 * 1000);
assert.ok(HIDDEN_GRACE_MS < WEBKIT_INACTIVE_DELAY_MS, 'the grace period ends before WebKit marks the process inactive');
assert.ok(HIDDEN_BUDGET_BYTES < WEBKIT_INACTIVE_KILL_BYTES, 'the hidden budget leaves room under the inactive kill limit');
assert.equal(LANE_BYTES_PER_PIXEL, 50);

// Platform: WebKit on a Mac only (desktop WKWebView, Safari); not Chromium or WebKitGTK.
const safariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const chromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const gtkUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
assert.equal(hiddenJobLimitsApply({ platform: 'MacIntel', userAgent: safariUa }), true);
assert.equal(hiddenJobLimitsApply({ platform: 'MacIntel', userAgent: chromeUa }), false);
assert.equal(hiddenJobLimitsApply({ platform: 'Linux x86_64', userAgent: gtkUa }), false);
assert.equal(hiddenJobLimitsApply({ platform: 'Win32', userAgent: chromeUa.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64') }), false);

// Estimate: the larger of decode and lane peaks, never their sum.
assert.equal(estimateHiddenJobBytes(60e6, 1.84 * GB), 60e6 * 50);
assert.equal(estimateHiddenJobBytes(10e6, 1.84 * GB), 1.84 * GB);
assert.equal(estimateHiddenJobBytes(NaN, NaN), 0);

// Visible: admitted at once, any number in flight.
{
  const env = harness();
  const releases = await Promise.all([env.gate.admit({ bytes: 9 * GB }), env.gate.admit({ bytes: 9 * GB }), env.gate.admit()]);
  assert.equal(env.gate.inFlight, 3);
  releases.forEach(release => release());
  releases[0]();
  assert.equal(env.gate.inFlight, 0, 'release is idempotent');
  assert.equal(env.hiddenAdmits, 0);
}

// Hidden on Chromium/WebKitGTK: the normal plan.
{
  const env = harness({ limits: false, resident: 10 * GB });
  env.hide();
  env.advance(HIDDEN_GRACE_MS * 2);
  const releases = await Promise.all([env.gate.admit({ bytes: 5 * GB }), env.gate.admit({ bytes: 5 * GB })]);
  assert.equal(env.gate.inFlight, 2);
  releases.forEach(release => release());
}

// Hidden on macOS WebKit, within the grace period: one item in flight, no byte check.
{
  const env = harness({ resident: 3 * GB });
  env.hide();
  const first = await env.gate.admit({ bytes: 3 * GB });
  assert.equal(env.hiddenAdmits, 1, 'a hidden admission sheds idle workers first');
  const second = track(env.gate.admit({ bytes: 3 * GB }));
  await tick();
  assert.equal(second.settled, false, 'one in flight while hidden');
  assert.equal(env.gate.paused, false, 'serialising is not a pause');
  first();
  await tick();
  assert.equal(second.settled, true, 'the next item starts when the running one is released');
  assert.equal(env.idle, 0, 'not idle while the next item runs');
  second.value();
  assert.equal(env.idle, 1, 'idle once the last item is released and nothing waits');
}

// After the grace period: admit only when resident + bytes fit; otherwise
// wait for visibility. Running items are never interrupted.
{
  const env = harness({ resident: 0.73 * GB });
  env.hide();
  const running = await env.gate.admit({ bytes: 3 * GB });
  env.advance(HIDDEN_GRACE_MS);
  assert.equal(env.graceExpired, 1, 'the grace timer fires once');
  const held = track(env.gate.admit({ bytes: 3 * GB }));
  running();
  await tick();
  assert.equal(held.settled, false, '0.73 + 3.0 GB does not fit 3.3 GB');
  assert.equal(env.gate.paused, true);
  assert.deepEqual(env.changes, [true], 'the pause is announced once');
  assert.deepEqual(env.log, ['shed', 'paused'], 'and only after the page was asked to shed');
  env.show();
  await tick();
  assert.equal(held.settled, true, 'visible again releases the waiting item at once');
  assert.equal(env.gate.paused, false);
  assert.deepEqual(env.changes, [true, false]);
  held.value();
}

// A smaller estimate fits after the grace period; shedding (recheck) can unblock.
{
  const env = harness({ resident: 2.5 * GB });
  env.hide();
  env.advance(HIDDEN_GRACE_MS);
  const held = track(env.gate.admit({ bytes: 1.2 * GB }));
  await tick();
  assert.equal(held.settled, false);
  env.resident = 1.9 * GB;
  env.gate.recheck();
  await tick();
  assert.equal(held.settled, true, '1.9 + 1.2 GB fits after memory was shed');
  held.value();
  const small = await env.gate.admit({ bytes: 1 * GB });
  small();
}

// #229 review R1-053: before an item is held for its bytes the page sheds
// (caches, idle workers), and the item is checked again: what was shed can
// let it start, with no pause announced. Within the grace period, or behind a
// running item, nothing is shed for it.
{
  const env = harness({ resident: 2.5 * GB });
  env.hide();
  const running = await env.gate.admit({ bytes: 1.2 * GB });
  const queued = track(env.gate.admit({ bytes: 1.2 * GB }));
  await tick();
  assert.equal(env.budgetHolds, 0, 'one-in-flight and the grace period hold nothing for bytes');
  env.advance(HIDDEN_GRACE_MS);
  env.shed = () => {
    env.resident = 1.9 * GB;
    // A shed asks for a recheck itself: that is this same pass.
    env.gate.recheck();
  };
  running();
  await tick();
  assert.equal(queued.settled, true, '1.9 + 1.2 GB fits once the page has shed');
  assert.equal(env.budgetHolds, 1, 'one shed for the item');
  assert.deepEqual(env.changes, [], 'and no pause');
  queued.value();
  // Still over after the shed: held, and the pause follows the shed.
  env.resident = 2.5 * GB;
  env.shed = () => { env.resident = 2.4 * GB; };
  const held = track(env.gate.admit({ bytes: 1.2 * GB }));
  await tick();
  assert.equal(held.settled, false, '2.4 + 1.2 GB still does not fit');
  assert.deepEqual(env.log, ['shed', 'shed', 'paused']);
  assert.equal(env.gate.status().heldBytes, 1.2 * GB);
  // Every later check sheds once more before it keeps the item held.
  env.gate.recheck();
  assert.equal(env.budgetHolds, 3);
  assert.deepEqual(env.changes, [true], 'the pause is announced once');
  env.shed = () => { env.resident = 2 * GB; };
  env.gate.recheck();
  await tick();
  assert.equal(held.settled, true, 'a later shed that makes room admits it');
  assert.deepEqual(env.changes, [true, false]);
  held.value();
}

// Hiding again restarts the grace period (WebKit restarts its 8-minute delay too).
{
  const env = harness({ resident: 3 * GB });
  env.hide();
  env.advance(HIDDEN_GRACE_MS - 1000);
  env.show();
  env.hide();
  env.advance(2000);
  const release = await env.gate.admit({ bytes: 3 * GB });
  assert.equal(env.graceExpired, 0);
  release();
}

// Abort while waiting rejects with AbortError and lets the queue move on.
{
  const env = harness();
  env.hide();
  const running = await env.gate.admit();
  const controller = new AbortController();
  const aborted = track(env.gate.admit({ signal: controller.signal }));
  const next = track(env.gate.admit());
  controller.abort();
  await tick();
  assert.equal(aborted.error?.name, 'AbortError');
  assert.equal(next.settled, false);
  running();
  await tick();
  assert.equal(next.settled, true);
  next.value();
  await assert.rejects(env.gate.admit({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(env.gate.inFlight, 0);
}

// Crash-loop safe mode: one item in flight even while visible.
{
  const env = harness({ limits: false });
  env.gate.setSafeMode(true);
  const first = await env.gate.admit();
  const second = track(env.gate.admit());
  await tick();
  assert.equal(second.settled, false);
  first();
  await tick();
  assert.equal(second.settled, true);
  second.value();
  env.gate.setSafeMode(false);
  const a = await env.gate.admit(); const b = await env.gate.admit();
  assert.equal(env.gate.inFlight, 2);
  a(); b();
}

// A page that loads hidden starts its grace period at creation.
{
  const env = harness({ hidden: true, resident: 4 * GB });
  env.advance(HIDDEN_GRACE_MS);
  assert.equal(env.graceExpired, 1);
  assert.equal(env.gate.graceOver, true);
  const held = track(env.gate.admit({ bytes: 1 }));
  await tick();
  assert.equal(held.settled, false);
  env.show();
  await tick();
  held.value();
  env.gate.dispose();
}

console.log('hiddenJobGate tests passed');
