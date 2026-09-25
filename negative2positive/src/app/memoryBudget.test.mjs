import assert from 'node:assert/strict';
import {
  createMemoryBudget, createRetainedLedger, createMemoryClaim, createIdleCheck, relievePressure,
  budgetFor, resolveMemoryRam, memoryEngine, hasPeriodicMemoryPurge,
  GIB, UNKNOWN_RAM_BYTES, WAIT_RECHECK_MS, IDLE_CHECK_DELAY_MS, DECODED_BYTES_PER_PIXEL
} from './memoryBudget.js';
import { createPhotoSessionCache } from './photoSessionCache.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function track(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(value => { box.settled = true; box.value = value; }, error => { box.settled = true; box.error = error; });
  return box;
}

function harness({ budget = 100, retained = 0, onPressure = null } = {}) {
  const env = { retained, timers: new Map(), nextTimer: 0, pressure: [], events: [] };
  env.budget = createMemoryBudget({
    budgetBytes: budget,
    retainedBytes: () => env.retained,
    onPressure: (need, request) => {
      env.pressure.push({ need, ...request });
      return onPressure ? onPressure(need, request, env) : 0;
    },
    setTimer: (fn, ms) => { const id = ++env.nextTimer; env.timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => env.timers.delete(id),
    onEvent: event => env.events.push(event)
  });
  env.fireTimers = () => {
    for (const [id, timer] of [...env.timers]) { env.timers.delete(id); timer.fn(); }
  };
  return env;
}

// ---- Budget sizing (§3) -----------------------------------------------------
assert.equal(budgetFor({ ramBytes: 8 * GIB }), Math.floor(3.6 * GIB));
assert.equal(budgetFor({ ramBytes: 16 * GIB }), 6 * GIB, '16 GiB: the WebKit kill limit minus the margin');
assert.equal(budgetFor({ ramBytes: 32 * GIB }), 14 * GIB);
assert.equal(budgetFor({ ramBytes: 64 * GIB }), 14 * GIB);
assert.equal(budgetFor({ ramBytes: null }), Math.floor(3.6 * GIB), 'unknown web memory is treated as 8 GiB');
assert.equal(budgetFor(), budgetFor({ ramBytes: UNKNOWN_RAM_BYTES }));
assert.equal(budgetFor({ ramBytes: 4 * GIB }), Math.floor(1.8 * GIB));
// One formula whatever the engine.
for (const engine of ['wkwebview', 'webkitgtk', 'webview2', 'chromium', 'webkit']) {
  assert.equal(budgetFor({ ramBytes: 16 * GIB, engine }), 6 * GIB);
}

assert.deepEqual(resolveMemoryRam({ overrideGib: '32', desktopTotalBytes: 16 * GIB, deviceMemory: 8 }),
  { ramBytes: 32 * GIB, source: 'override', known: true });
assert.deepEqual(resolveMemoryRam({ desktopTotalBytes: 17179869184, deviceMemory: 8 }),
  { ramBytes: 17179869184, source: 'desktop', known: true });
assert.deepEqual(resolveMemoryRam({ deviceMemory: 16 }), { ramBytes: 16 * GIB, source: 'deviceMemory', known: true });
assert.deepEqual(resolveMemoryRam({}), { ramBytes: null, source: 'unknown', known: false });
assert.equal(resolveMemoryRam({ overrideGib: 'abc', deviceMemory: 4 }).source, 'deviceMemory', 'a bad override is ignored');
assert.equal(resolveMemoryRam({ overrideGib: '', deviceMemory: 4 }).source, 'deviceMemory');

const safariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const chromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const firefoxUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:130.0) Gecko/20100101 Firefox/130.0';
assert.equal(memoryEngine({ userAgent: safariUa }), 'webkit');
assert.equal(memoryEngine({ userAgent: chromeUa }), 'chromium');
assert.equal(memoryEngine({ userAgent: firefoxUa }), 'gecko');
assert.equal(memoryEngine({ desktopEngine: 'webview2', userAgent: chromeUa }), 'webview2');
assert.equal(hasPeriodicMemoryPurge('wkwebview'), true);
assert.equal(hasPeriodicMemoryPurge('webkitgtk'), true);
assert.equal(hasPeriodicMemoryPurge('webkit'), true);
assert.equal(hasPeriodicMemoryPurge('webview2'), false);
assert.equal(hasPeriodicMemoryPurge('chromium'), false);

// ---- Foreground: synchronous, over budget, never waits ----------------------
{
  const env = harness({ budget: 100, retained: 80 });
  const promise = env.budget.reserve(500, { priority: 'foreground', label: 'open A' });
  // Recorded inside reserve(), before the promise settles.
  assert.equal(env.budget.snapshot().foreground, 500);
  assert.equal(env.budget.foregroundOutstanding, 1);
  assert.deepEqual(env.budget.snapshot().outstanding, [{ label: 'open A', priority: 'foreground', bytes: 500 }]);
  const handle = await promise;
  assert.equal(env.pressure.length, 0, 'a foreground grant never calls onPressure');
  assert.equal(env.events.find(event => event.type === 'grant').rule, 'foreground');
  handle.release();
  assert.equal(env.budget.snapshot().foreground, 0);
}

// ---- User/background wait for foreground, even when they fit ---------------
{
  const env = harness({ budget: 100 });
  const fg = await env.budget.reserve(10, { priority: 'foreground', label: 'fg' });
  const user = track(env.budget.reserve(5, { priority: 'user', label: 'export' }));
  const bg = track(env.budget.reserve(5, { priority: 'background', label: 'tile' }));
  await tick();
  assert.equal(user.settled, false, 'waits while a foreground reservation is outstanding');
  assert.equal(bg.settled, false);
  assert.equal(env.pressure.length, 0, 'no eviction for a request blocked by the foreground');
  assert.deepEqual(env.budget.snapshot().waiting.map(w => w.label), ['export', 'tile']);
  fg.release();
  await tick();
  assert.equal(user.settled && !user.error, true);
  assert.equal(bg.settled && !bg.error, true);
  // The log never shows a job grant while a foreground reservation was out.
  const grantOrder = env.events.filter(event => event.type === 'grant' || (event.type === 'release' && event.priority === 'foreground'))
    .map(event => `${event.type}:${event.label}`);
  assert.deepEqual(grantOrder, ['grant:fg', 'release:fg', 'grant:export', 'grant:tile']);
}

// ---- Waiting on bytes: reserved + retained + bytes > budget -----------------
{
  const env = harness({ budget: 100, retained: 30 });
  const a = await env.budget.reserve(50, { priority: 'user', label: 'a' });
  const b = track(env.budget.reserve(30, { priority: 'user', label: 'b' }));
  await tick();
  assert.equal(b.settled, false, '50 + 30 retained + 30 > 100');
  assert.equal(env.pressure.at(-1).need, 10, 'onPressure gets the shortfall');
  assert.equal(env.pressure.at(-1).priority, 'user');
  // Retained bytes dropped without a poke: the fallback timer finds it.
  env.retained = 10;
  assert.equal(env.timers.size, 1, 'a waiting request keeps a fallback timer armed');
  assert.equal([...env.timers.values()][0].ms, WAIT_RECHECK_MS);
  env.fireTimers();
  await tick();
  assert.equal(b.settled && !b.error, true);
  assert.equal(env.timers.size, 0, 'no timer once nothing waits');
  a.release();
  b.value.release();
}

// ---- Queue order: FIFO, head only, user ahead of background -----------------
{
  const env = harness({ budget: 100 });
  const running = await env.budget.reserve(60, { priority: 'background', label: 'running' });
  const bg1 = track(env.budget.reserve(60, { priority: 'background', label: 'bg1' }));
  const bg2 = track(env.budget.reserve(10, { priority: 'background', label: 'bg2' }));
  const user1 = track(env.budget.reserve(70, { priority: 'user', label: 'user1' }));
  const user2 = track(env.budget.reserve(20, { priority: 'user', label: 'user2' }));
  await tick();
  assert.deepEqual(env.budget.snapshot().waiting.map(w => w.label), ['user1', 'user2', 'bg1', 'bg2'],
    'user requests queue ahead of every waiting background request, FIFO within a priority');
  assert.equal(bg2.settled, false, 'a small later request never overtakes the head');
  assert.equal(user2.settled, false);
  running.release();
  await tick();
  // user1 (70) fits alone; user2 (20) fits next to it; bg1 (60) does not.
  assert.equal(user1.settled && !user1.error, true);
  assert.equal(user2.settled && !user2.error, true);
  assert.equal(bg1.settled, false);
  assert.equal(bg2.settled, false, 'bg2 would fit, but bg1 is the head');
  user1.value.release();
  await tick();
  assert.equal(bg1.settled && !bg1.error, true, 'release wakes the next head');
  assert.equal(bg2.settled && !bg2.error, true);
  const grants = env.events.filter(event => event.type === 'grant').map(event => event.label);
  assert.deepEqual(grants, ['running', 'user1', 'user2', 'bg1', 'bg2']);
  user2.value.release();
  bg1.value.release();
  bg2.value.release();
  assert.equal(env.budget.idle, true);
}

// ---- Abort -------------------------------------------------------------------
{
  const env = harness({ budget: 100 });
  const running = await env.budget.reserve(80, { priority: 'user', label: 'running' });
  const controller = new AbortController();
  const big = track(env.budget.reserve(50, { priority: 'user', label: 'big', signal: controller.signal }));
  const small = track(env.budget.reserve(15, { priority: 'background', label: 'small' }));
  await tick();
  assert.equal(small.settled, false, 'behind the head');
  const before = env.budget.snapshot();
  controller.abort();
  await tick();
  assert.equal(big.error?.name, 'AbortError', 'a waiting request rejects with AbortError');
  assert.equal(small.settled && !small.error, true, 'the next head is re-evaluated at once');
  assert.equal(env.budget.snapshot().user, before.user, 'the aborted request held nothing');
  // An already-aborted signal rejects at once, for every priority.
  const aborted = AbortSignal.abort();
  for (const priority of ['foreground', 'user', 'background']) {
    const result = track(env.budget.reserve(1, { priority, signal: aborted }));
    await tick();
    assert.equal(result.error?.name, 'AbortError');
  }
  // A granted handle is not released by its signal: the owner releases it
  // once the memory is really gone (a running LibRaw decode).
  const owner = new AbortController();
  const granted = await env.budget.reserve(0, { priority: 'user', signal: owner.signal, label: 'granted' });
  owner.abort();
  assert.equal(granted.released, false);
  running.release();
  small.value.release();
  granted.release();
  assert.equal(env.budget.idle, true);
}

// ---- onPressure --------------------------------------------------------------
{
  // Frees enough: the grant proceeds in the same evaluation.
  const env = harness({
    budget: 100,
    retained: 70,
    onPressure: (need, request, e) => { e.retained -= need; return need; }
  });
  const other = await env.budget.reserve(10, { priority: 'background', label: 'other' });
  const request = env.budget.reserve(40, { priority: 'user', label: 'export' });
  assert.equal(env.pressure.length, 1);
  assert.equal(env.pressure[0].need, 20, '10 reserved + 70 retained + 40 - 100');
  assert.equal(env.budget.snapshot().user, 40, 'granted within the same evaluation');
  const handle = await request;
  assert.equal(env.events.find(event => event.type === 'grant' && event.label === 'export').rule, 'pressure');
  // Fits without pressure: onPressure is not called.
  handle.release();
  env.pressure.length = 0;
  const small = await env.budget.reserve(1, { priority: 'background', label: 'small' });
  assert.equal(env.pressure.length, 0);
  other.release();
  small.release();
}

// ---- Progress rule -------------------------------------------------------------
{
  const env = harness({ budget: 100, retained: 40 });
  const huge = await env.budget.reserve(500, { priority: 'background', label: 'huge' });
  assert.equal(env.events.find(event => event.type === 'grant').rule, 'progress',
    'a sole request larger than the budget is granted when nothing else is outstanding');
  const next = track(env.budget.reserve(1, { priority: 'user', label: 'next' }));
  await tick();
  assert.equal(next.settled, false, 'the progress rule needs nothing else outstanding');
  huge.release();
  await tick();
  assert.equal(next.settled && !next.error, true);
  next.value.release();
  // A foreground reservation outstanding blocks even the progress rule.
  const fg = await env.budget.reserve(1, { priority: 'foreground' });
  const blocked = track(env.budget.reserve(500, { priority: 'user' }));
  await tick();
  assert.equal(blocked.settled, false);
  fg.release();
  await tick();
  assert.equal(blocked.settled && !blocked.error, true);
  blocked.value.release();
}

// ---- release idempotent, setBudget, poke, resize -----------------------------
{
  const env = harness({ budget: 100 });
  const a = await env.budget.reserve(60, { priority: 'user', label: 'a' });
  a.release();
  a.release();
  assert.equal(env.budget.snapshot().user, 0, 'a second release changes nothing');
  assert.equal(env.events.filter(event => event.type === 'release').length, 1);

  const b = await env.budget.reserve(60, { priority: 'user', label: 'b' });
  env.budget.setBudget(30);
  assert.equal(b.released, false, 'a lower ceiling revokes nothing');
  assert.equal(env.budget.snapshot().user, 60);
  const c = track(env.budget.reserve(20, { priority: 'background', label: 'c' }));
  await tick();
  assert.equal(c.settled, false, '60 + 20 > 30');
  b.release();
  await tick();
  assert.equal(c.settled && !c.error, true, 'waiters are re-evaluated against the new ceiling');
  const d = track(env.budget.reserve(20, { priority: 'background', label: 'd' }));
  await tick();
  assert.equal(d.settled, false, '20 + 20 > 30');
  env.budget.setBudget(40);
  await tick();
  assert.equal(d.settled && !d.error, true, 'raising the ceiling admits at once');

  // poke(): a cache shrank.
  env.budget.setBudget(45);
  env.retained = 50;
  const e = track(env.budget.reserve(5, { priority: 'user', label: 'e' }));
  await tick();
  assert.equal(e.settled, false);
  env.retained = 0;
  env.budget.poke();
  await tick();
  assert.equal(e.settled && !e.error, true);

  // resize(): corrected at the loader gate; shrinking wakes waiters.
  const f = track(env.budget.reserve(20, { priority: 'user', label: 'f' }));
  await tick();
  assert.equal(f.settled, false, '20 + 20 + 5 + 20 > 45');
  c.value.resize(0);
  await tick();
  assert.equal(f.settled && !f.error, true);
  assert.equal(env.budget.snapshot().background, 20);
  for (const handle of [c.value, d.value, e.value, f.value]) handle.release();
  assert.equal(env.budget.snapshot().reserved, 0);
}

// ---- Ledger: each buffer once, attributed to the first holder ---------------
{
  const shared = new Uint8ClampedArray(1000);
  const editor = { data: shared, __image16: { data: new Uint16Array(500) } };
  const session = createPhotoSessionCache({ maxBytes: 1e6 });
  session.put('A', { base: { data: shared }, extra: new Uint8Array(300) });
  const history = [{ refs: { processedImageData: editor, old: new Uint8Array(200) } }];
  const ledger = createRetainedLedger(() => [
    { name: 'editor', roots: () => [editor] },
    { name: 'sessions', buffers: () => session.buffers() },
    { name: 'history', roots: () => history },
    { name: 'workers', bytes: () => 4096 }
  ]);
  const { total, breakdown } = ledger.measure();
  assert.deepEqual(breakdown, { editor: 2000, sessions: 300, history: 200, workers: 4096 },
    'the shared plane counts once, under the editor');
  assert.equal(total, 2000 + 300 + 200 + 4096);
  assert.equal(ledger.retained(), total);
}

// ---- trim(target, { keep }) never evicts a kept key -------------------------
{
  const cache = createPhotoSessionCache({ maxBytes: 10_000 });
  cache.put('A', { data: new Uint8Array(1000) });
  cache.put('B', { data: new Uint8Array(1000) });
  cache.put('C', { data: new Uint8Array(1000) });
  assert.equal(cache.lastStoredKey, 'C');
  cache.peek('A');
  // LRU order is now B, C, A.
  const freed = cache.trim(0, { keep: [cache.lastStoredKey] });
  assert.equal(freed, 2000);
  assert.equal(cache.has('C'), true, 'the kept key survives a trim to zero');
  assert.equal(cache.has('A') || cache.has('B'), false);
  assert.equal(cache.bytes, 1000);
  cache.put('D', { data: new Uint8Array(1000) });
  assert.equal(cache.trim(1000, { keep: ['D'] }), 1000, 'stops once the target is met');
  assert.deepEqual([cache.has('C'), cache.has('D')], [false, true]);
  cache.delete('D');
  assert.equal(cache.lastStoredKey, undefined, 'a removed entry is no longer the last stored');
  cache.put('E', { data: new Uint8Array(10) });
  cache.clear();
  assert.equal(cache.lastStoredKey, undefined);
}

// ---- relievePressure: in order, stops once enough is freed ------------------
{
  const calls = [];
  const freed = relievePressure(100, [
    (remaining) => { calls.push(['previews', remaining]); return 30; },
    (remaining) => { calls.push(['sessions', remaining]); return 80; },
    (remaining) => { calls.push(['history', remaining]); return 50; }
  ]);
  assert.equal(freed, 110);
  assert.deepEqual(calls, [['previews', 100], ['sessions', 70]]);
  assert.equal(relievePressure(10, [() => { throw new Error('x'); }, () => 12]), 12, 'a failing step frees nothing');
}

// ---- Memory claims -------------------------------------------------------------
{
  const env = harness({ budget: 10 * GIB });
  const frame = ({ pixels, decodeBytes }) => (decodeBytes ?? 0) + pixels * DECODED_BYTES_PER_PIXEL;
  // Reserved at the loader gate with the real size.
  const claim = createMemoryClaim(env.budget, { priority: 'user', label: 'auto frame', bytesFor: frame });
  await claim.atDecode({ width: 100, height: 50, estimatedBytes: 1000 });
  assert.equal(claim.held, true);
  assert.equal(env.budget.snapshot().user, 1000 + 5000 * 12);
  // A second decode of the same frame (a reload) is already covered.
  await claim.atDecode({ width: 100, height: 50, estimatedBytes: 1000 });
  assert.equal(env.events.filter(event => event.type === 'grant').length, 1);
  claim.release();
  claim.release();
  assert.equal(env.budget.snapshot().user, 0);

  // Reserved up front from the header, corrected at the gate.
  const lane = createMemoryClaim(env.budget, { priority: 'background', bytesFor: frame });
  await lane.reserve(150e6);
  assert.equal(env.budget.snapshot().background, 150e6 * 12);
  await lane.atDecode({ width: 6000, height: 4000, estimatedBytes: 2e9 });
  assert.equal(env.budget.snapshot().background, 2e9 + 24e6 * 12, 'resized to the real size, without waiting');
  lane.release();

  // A decode without a size of its own uses the header.
  const scan = createMemoryClaim(env.budget, { priority: 'foreground', bytesFor: frame, headerPixels: async () => 1000 });
  await scan.atDecode({});
  assert.equal(env.budget.snapshot().foreground, 12_000);
  scan.release();

  // A fixed claim (an Export All lane) is neither resized nor released by the loader's owner.
  const laneHandle = await env.budget.reserve(3e9, { priority: 'user', label: 'lane' });
  const fixed = createMemoryClaim(env.budget, { handle: laneHandle });
  await fixed.atDecode({ width: 10, height: 10, estimatedBytes: 1 });
  assert.equal(env.budget.snapshot().user, 3e9);
  fixed.release();
  assert.equal(laneHandle.released, false, 'the lane releases its own reservation after its sink');
  laneHandle.release();

  // Releasing a claim that still waits withdraws the request.
  const blocker = await env.budget.reserve(1, { priority: 'foreground' });
  const waiting = createMemoryClaim(env.budget, { priority: 'background', bytesFor: frame });
  const result = track(waiting.atDecode({ width: 10, height: 10 }));
  await tick();
  assert.equal(env.budget.waiting, 1);
  waiting.release();
  await tick();
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(env.budget.waiting, 0);
  blocker.release();
  assert.equal(env.budget.snapshot().reserved, 0);

  // The caller's signal aborts a waiting claim.
  const blocker2 = await env.budget.reserve(1, { priority: 'foreground' });
  const controller = new AbortController();
  const aborted = createMemoryClaim(env.budget, { priority: 'user', signal: controller.signal, bytesFor: frame });
  const pending = track(aborted.reserve(10));
  await tick();
  controller.abort();
  await tick();
  assert.equal(pending.error?.name, 'AbortError');
  blocker2.release();
  assert.equal(env.budget.idle, true);
}

// ---- Idle check ------------------------------------------------------------------
{
  const timers = new Map();
  let next = 0;
  let ready = false;
  let ran = 0;
  const idle = createIdleCheck({
    onIdle: () => { ran += 1; },
    canRun: () => ready,
    setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id)
  });
  const fire = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  idle.note();
  idle.note();
  assert.equal(timers.size, 1, 'each note restarts the one timer');
  assert.equal([...timers.values()][0].ms, IDLE_CHECK_DELAY_MS);
  fire();
  assert.equal(ran, 0, 'work outstanding: re-armed instead');
  assert.equal(idle.armed, true);
  ready = true;
  fire();
  assert.equal(ran, 1);
  assert.equal(idle.armed, false);
  idle.setEnabled(false);
  idle.note();
  assert.equal(timers.size, 0, 'disabled on engines without the periodic purge');
}

console.log('memoryBudget tests passed');
