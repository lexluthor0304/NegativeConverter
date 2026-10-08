import assert from 'node:assert/strict';
import { createBackgroundGate, BACKGROUND_INPUT_QUIET_MS } from './backgroundGate.js';

// A fake clock: timers fire only when the test advances time.
function fakeClock() {
  let time = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
        await Promise.resolve();
      }
      time = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    get pending() { return timers.size; }
  };
}

function track(promise) {
  const state = { settled: false, value: undefined, error: null };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// Idle at once when nothing is busy and no input happened.
{
  const clock = fakeClock();
  const gate = createBackgroundGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(await gate.idle(), true);
  assert.equal(gate.isIdle(), true);
  assert.equal(clock.pending, 0, 'no timer when idle');
}

// Input: waits until 400 ms after the LAST input.
{
  const clock = fakeClock();
  const gate = createBackgroundGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  gate.noteInput();
  const waiting = track(gate.idle());
  await clock.advance(250);
  assert.equal(waiting.settled, false, 'inside the quiet period');
  gate.noteInput(); // a drag keeps going
  await clock.advance(250);
  assert.equal(waiting.settled, false, '250 ms after the second input');
  await clock.advance(BACKGROUND_INPUT_QUIET_MS - 250 - 1);
  assert.equal(waiting.settled, false, '1 ms before the quiet period ends');
  await clock.advance(1);
  assert.equal(waiting.value, true, 'idle exactly 400 ms after the last input');
}

// Busy flags: polled, and bump() re-checks at once when a flag clears.
{
  const clock = fakeClock();
  let busy = true;
  let checks = 0;
  const gate = createBackgroundGate({ isBusy: () => { checks++; return busy; }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, pollMs: 250 });
  const waiting = track(gate.idle());
  await clock.advance(1000);
  assert.equal(waiting.settled, false, 'never starts while the foreground is busy');
  assert.ok(checks >= 4, 'the flag is polled');
  busy = false;
  gate.bump();
  await flush();
  assert.equal(waiting.value, true, 'bump() releases the waiter without waiting for the poll');
  // A poll alone also releases it.
  busy = true;
  const polled = track(gate.idle());
  busy = false;
  await clock.advance(250);
  assert.equal(polled.value, true);
}

// Input and busy together: both must hold.
{
  const clock = fakeClock();
  let busy = true;
  const gate = createBackgroundGate({ isBusy: () => busy, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  gate.noteInput();
  const waiting = track(gate.idle());
  await clock.advance(500);
  assert.equal(waiting.settled, false, 'quiet but still busy');
  busy = false;
  gate.noteInput();
  gate.bump();
  await flush();
  assert.equal(waiting.settled, false, 'not busy but input just happened');
  await clock.advance(400);
  assert.equal(waiting.value, true);
}

// The step cap: a job mid-way proceeds after maxWaitMs (false), never holds forever.
{
  const clock = fakeClock();
  const gate = createBackgroundGate({ isBusy: () => true, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const capped = track(gate.idle({ maxWaitMs: 2000 }));
  const uncapped = track(gate.idle());
  await clock.advance(1999);
  assert.equal(capped.settled, false);
  await clock.advance(1);
  assert.equal(capped.value, false, 'the cap resolves false');
  assert.equal(uncapped.settled, false, 'an uncapped waiter keeps waiting');
  assert.equal(gate.waiting, 1);
}

// Abort: rejects with an AbortError and leaves no waiter behind.
{
  const clock = fakeClock();
  const gate = createBackgroundGate({ isBusy: () => true, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const controller = new AbortController();
  const waiting = track(gate.idle({ signal: controller.signal }));
  controller.abort();
  await flush();
  assert.equal(waiting.error?.name, 'AbortError');
  assert.equal(gate.waiting, 0);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(gate.idle({ signal: pre.signal }), { name: 'AbortError' });
}

// A throwing busy probe counts as busy (fail closed).
{
  const clock = fakeClock();
  const gate = createBackgroundGate({ isBusy: () => { throw new Error('boom'); }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(gate.isIdle(), false);
}

// Foreground-only waits (#256 decode-ahead): the batch's own export lock
// (in isBusy) never holds them; input, a switch or a foreground conversion
// (isForegroundBusy) does, and the cap still lets them go.
{
  const clock = fakeClock();
  let foregroundBusy = false;
  const gate = createBackgroundGate({
    isBusy: () => true, isForegroundBusy: () => foregroundBusy,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  assert.equal(await gate.idle({ foregroundOnly: true }), true, 'the export lock alone never holds it');
  assert.equal(gate.isIdle(), false);
  assert.equal(gate.isIdle({ foregroundOnly: true }), true);
  const full = track(gate.idle());
  gate.noteInput();
  assert.equal(gate.inputRecently(), true);
  const afterInput = track(gate.idle({ foregroundOnly: true, maxWaitMs: 2000 }));
  await clock.advance(BACKGROUND_INPUT_QUIET_MS - 1);
  assert.equal(afterInput.settled, false, 'no decode within 400 ms of input');
  await clock.advance(1);
  assert.equal(afterInput.value, true);
  assert.equal(gate.inputRecently(), false);
  assert.equal(full.settled, false, 'a full idle() still waits for the lock');
  foregroundBusy = true;
  const capped = track(gate.idle({ foregroundOnly: true, maxWaitMs: 2000 }));
  await clock.advance(1999);
  assert.equal(capped.settled, false);
  await clock.advance(1);
  assert.equal(capped.value, false, 'the 2 s cap forces it');
  foregroundBusy = false;
  const released = track(gate.idle({ foregroundOnly: true }));
  gate.bump();
  await flush();
  assert.equal(released.value, true);
  assert.equal(full.settled, false);
}

console.log('backgroundGate tests passed');
