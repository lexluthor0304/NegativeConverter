import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createCoreReprocessGates, previewDispatchAction,
  CORE_FULL_REPROCESS_DELAY_MS, CORE_FRAME_GATE_FALLBACK_MS
} from './coreReprocessDispatcher.js';

// Drives the real scheduler, reprocess and slider functions from main.js (as
// restartRender.test.mjs does) against a fake clock: timeouts and animation
// frames run only when a test says so, microtasks run for real.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const clock = {
    timers, frames, hidden: false,
    timeline: { currentTime: 1000 },
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => { frames.delete(id); },
    isHidden: () => clock.hidden,
    nextFrame() { clock.timeline.currentTime += 1000 / 60; },
    runFrame() {
      clock.nextFrame();
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(clock.timeline.currentTime);
    },
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.callback();
    },
    armed() { return timers.size + frames.size; },
  };
  return clock;
}

// ---- The gates on their own ----

assert.equal(previewDispatchAction({ laneBusy: true, gateArmed: true, postedThisFrame: true }), 'queue');
assert.equal(previewDispatchAction({ laneBusy: false, gateArmed: true, postedThisFrame: false }), 'keep');
assert.equal(previewDispatchAction({ laneBusy: false, gateArmed: false, postedThisFrame: false }), 'task');
assert.equal(previewDispatchAction({ laneBusy: false, gateArmed: false, postedThisFrame: true }), 'frame');

{
  const clock = fakeClock();
  const gates = createCoreReprocessGates(clock);
  const fired = [];
  const task = gates.armTask(() => fired.push('task'));
  assert.ok(task, 'an armed gate is truthy');
  assert.equal(clock.armed(), 0, 'a task gate arms no timer or frame');
  await Promise.resolve();
  assert.deepEqual(fired, ['task']);

  const frame = gates.armFrame(() => fired.push('frame'));
  assert.equal(clock.frames.size, 1);
  assert.equal([...clock.timers.values()][0].delay, CORE_FRAME_GATE_FALLBACK_MS, 'an occluded window cannot hold it past the fallback');
  clock.runFrame();
  assert.deepEqual(fired, ['task', 'frame']);
  assert.equal(clock.armed(), 0, 'the rAF cancels its fallback');

  gates.armFrame(() => fired.push('fallback'));
  clock.runTimers();
  assert.deepEqual(fired, ['task', 'frame', 'fallback']);
  assert.equal(clock.armed(), 0, 'the fallback cancels its rAF');

  clock.hidden = true;
  gates.armFrame(() => fired.push('hidden'));
  assert.equal(clock.frames.size, 0, 'a hidden document runs no rAF');
  assert.equal([...clock.timers.values()][0].delay, 0);
  clock.runTimers();
  assert.equal(fired.at(-1), 'hidden');
  clock.hidden = false;

  for (const arm of [
    () => gates.armTask(() => fired.push('cancelled')),
    () => gates.armFrame(() => fired.push('cancelled')),
    () => gates.armTimeout(() => fired.push('cancelled'), CORE_FULL_REPROCESS_DELAY_MS),
  ]) {
    const handle = arm();
    gates.cancel(handle);
    assert.equal(clock.armed(), 0, `${handle.kind} gate cancelled`);
    await Promise.resolve();
    clock.runFrame(); clock.runTimers();
  }
  assert.ok(!fired.includes('cancelled'), 'no cancelled gate fires');

  gates.markPosted();
  assert.equal(gates.postedThisFrame(), true);
  clock.nextFrame();
  assert.equal(gates.postedThisFrame(), false, 'the timeline marks a new frame');
}

{
  // Without document.timeline a counter bumped in the next rAF stands in.
  const clock = fakeClock();
  const gates = createCoreReprocessGates({ ...clock, timeline: null });
  gates.markPosted();
  assert.equal(gates.postedThisFrame(), true);
  clock.runFrame();
  assert.equal(gates.postedThisFrame(), false);
}

// ---- The real scheduler ----

function schedulerFixture({ repairs = false } = {}) {
  const clock = fakeClock();
  const base = { width: 400, height: 300, name: 'source' };
  const state = {
    conversionSourceImageData: base,
    conversionPreviewImageData: { width: 200, height: 150, name: 'preview' },
    processedImageData: { width: 200, height: 150 }, processedImageDataIsPreview: true,
    currentStep: 3, coreExposure: 0, repairStrokes: [], fullResolutionPending: false,
    dustRemoval: { enabled: repairs, processing: false },
  };
  let displayTarget = { width: 200, height: 150 };
  const log = [];
  const conversions = [];
  const busyAtApply = [];
  const context = vm.createContext({
    state, console: { error: () => {}, warn: () => {} },
    coreReprocessGates: createCoreReprocessGates(clock),
    previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS,
    coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessToken: 0, coreReprocessGeneration: 0,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0,
    _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreSliderCommitRecord: null, fullResolutionRenderTimer: null,
    usesSilverCoreConversion: () => true,
    hasFrameRepairs: () => state.dustRemoval.enabled,
    getDisplayPreviewSize: () => ({ ...displayTarget }),
    resizeDisplayPreview: (image, size) => ({ ...size, name: 'resized' }),
    convertFromCurrentSource: (settings, options) => new Promise((resolve, reject) => {
      // The request reads live state when it starts, as the real one does.
      const entry = { exposure: state.coreExposure, token: context.coreReprocessToken,
        full: !options.interactive, busy: context.coreReprocessBusy(), resolve, reject };
      conversions.push(entry);
      log.push(`${entry.full ? 'full' : 'post'}:${entry.exposure}`);
    }),
    applyPreviewProcessedImageToState: () => { busyAtApply.push(context.coreReprocessBusy()); log.push('apply'); },
    applyProcessedImageToState: () => { busyAtApply.push(context.coreReprocessBusy()); log.push('apply'); },
    updatePreview: () => log.push('draw'),
    updateFull: () => log.push('draw'),
    scheduleFullUpdate: () => {},
    resetDustForCleanSource: () => {},
    scheduleDustDetection: () => log.push('dust'),
  });
  vm.runInContext([
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
    'rerenderWithCoreControls', 'hasSeparateConversionPreview',
    'cancelScheduledFullResolutionRender', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
    'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
  ].map(functionSource).join('\n'), context);
  const request = (exposure, options = { full: false }) => {
    if (exposure !== undefined) state.coreExposure = exposure;
    context.scheduleCoreReprocess(options);
  };
  const result = () => ({ width: 200, height: 150 });
  return { context, state, clock, log, conversions, busyAtApply, request, result,
    setTarget: size => { displayTarget = size; } };
}

{
  // An idle lane posts in the same task: no timeout, no rAF, and state the
  // caller writes after scheduling is still part of the request.
  const f = schedulerFixture();
  f.request(10);
  f.state.coreExposure = 42;
  assert.equal(f.conversions.length, 0, 'the request leaves at the end of the task');
  assert.equal(f.clock.armed(), 0, 'no timeout or rAF is armed for an idle lane');
  assert.ok(f.context.coreReprocessTimer, 'the held request counts as armed');
  await Promise.resolve();
  assert.equal(f.conversions.length, 1, 'posted before the task yields to the event loop');
  assert.equal(f.conversions[0].exposure, 42, 'late same-task state is included');
  assert.equal(f.context.coreReprocessTimer, null);
  f.conversions[0].resolve(f.result());
  await settle();
  assert.equal(f.context.coreReprocessBusy(), false);
}

for (const earlyPost of [false]) {
  // A busy lane queues newest-wins; exactly one follow-up carries the newest
  // token. It leaves from finally, or (5) before the finished frame is
  // applied when the display preview already has the right size.
  const f = schedulerFixture();
  f.request(0);
  await Promise.resolve();
  for (const exposure of [10, 20, 30]) {
    f.clock.nextFrame();
    f.request(exposure);
    assert.equal(f.clock.armed(), 0, 'a busy lane arms no timer or rAF');
    assert.equal(f.context.coreReprocessTimer, null);
  }
  assert.equal(f.conversions.length, 1);
  assert.equal(f.context._coreReprocessPending.token, f.context.coreReprocessToken, 'the newest request wins the slot');
  // A resize while the frame converts makes the next request resample first.
  if (!earlyPost) f.setTarget({ width: 300, height: 225 });
  f.conversions[0].resolve(f.result());
  await settle();
  assert.equal(f.conversions.length, 2, 'exactly one follow-up post');
  assert.equal(f.conversions[1].exposure, 30);
  assert.equal(f.conversions[1].token, f.context.coreReprocessToken);
  assert.deepEqual(f.log, earlyPost
    ? ['post:0', 'post:30', 'apply', 'draw']
    : ['post:0', 'apply', 'draw', 'post:30']);
  assert.ok(f.conversions[1].busy && f.busyAtApply.every(Boolean), 'coreReprocessBusy() never reads false across the handoff');
  assert.equal(f.context.coreReprocessBusy(), true, 'the older finally leaves the newer flight in flight');
  assert.ok(f.context._coreReprocessPreviewInFlight);
  f.clock.nextFrame();
  f.request(40);
  assert.equal(f.context._coreReprocessPending?.token, f.context.coreReprocessToken, 'the newer flight still blocks the lane');
  f.conversions[1].resolve(f.result());
  await settle();
  assert.equal(f.conversions.length, 3);
  f.conversions[2].resolve(f.result());
  await settle();
  assert.equal(f.context.coreReprocessBusy(), false);
  assert.equal(f.context._coreReprocessActive, 0);
}

{
  // Full requests keep their 70 ms timer, and a queued full request never
  // posts early: the background full render (same token) waits for finally.
  const f = schedulerFixture();
  f.request(0, { full: true });
  assert.equal([...f.clock.timers.values()][0].delay, CORE_FULL_REPROCESS_DELAY_MS, 'full requests keep their 70 ms timer');
  f.request(0);
  assert.equal(f.clock.timers.size, 0, 'a preview replaces a queued full request');
  await Promise.resolve();
  f.state.coreExposure = 5;
  void f.context.rerenderWithCoreControls({ full: true, token: f.context.coreReprocessToken });
  assert.equal(f.context._coreReprocessPending?.full, true, 'blocked behind the preview');
  f.conversions[0].resolve(f.result());
  await settle();
  assert.deepEqual(f.log, ['post:0', 'apply', 'draw', 'full:5'], 'the full request leaves from finally');
  f.conversions[1].resolve(f.result());
  await settle();
  assert.equal(f.context.coreReprocessBusy(), false);
}

{
  // At most one post per frame: a second request in the same frame waits for
  // the next one (or a 0 ms timeout while hidden) and takes the newest state.
  const f = schedulerFixture();
  f.request(1);
  await Promise.resolve();
  f.conversions[0].resolve(f.result());
  await settle();
  f.request(2);
  await settle();
  assert.equal(f.conversions.length, 1, 'no second post in the same frame');
  assert.equal(f.clock.frames.size, 1, 'the request waits for the next frame');
  f.request(3);
  assert.equal(f.clock.frames.size, 1, 'the armed gate takes the newer request');
  f.clock.runFrame();
  assert.equal(f.conversions.length, 2);
  assert.equal(f.conversions[1].exposure, 3);
  assert.equal(f.clock.armed(), 0, 'the fallback timeout is cancelled');
  f.conversions[1].resolve(f.result());
  await settle();

  f.clock.hidden = true;
  f.request(4);
  assert.equal(f.clock.frames.size, 0);
  assert.equal([...f.clock.timers.values()][0]?.delay, 0, 'hidden: setTimeout(0) instead of rAF');
  f.clock.runTimers();
  assert.equal(f.conversions.at(-1).exposure, 4);
  f.conversions.at(-1).resolve(f.result());
  await settle();

  f.clock.hidden = false;
  f.clock.nextFrame();
  f.request(5);
  await Promise.resolve();
  assert.equal(f.conversions.at(-1).exposure, 5, 'a new frame posts in the same task again');
  f.conversions.at(-1).resolve(f.result());
  await settle();
}

{
  // flushScheduledCoreReprocess drains a gated request at once;
  // clearCoreReprocessTimer cancels every kind of gate.
  const f = schedulerFixture();
  f.request(1);
  await Promise.resolve();
  f.conversions[0].resolve(f.result());
  await settle();
  f.request(2);
  assert.equal(f.clock.frames.size, 1);
  let flushed = false;
  const flush = f.context.flushScheduledCoreReprocess().then(() => { flushed = true; });
  assert.equal(f.conversions.length, 2, 'the export barrier posts the gated request');
  assert.equal(f.clock.armed(), 0);
  await settle();
  assert.equal(flushed, false, 'and waits for it');
  f.conversions[1].resolve(f.result());
  await flush;

  f.clock.nextFrame();
  f.request(3);
  f.context.clearCoreReprocessTimer();
  f.clock.nextFrame();
  f.request(4, { full: true });
  assert.equal(f.clock.timers.size, 1);
  f.context.clearCoreReprocessTimer();
  assert.equal(f.clock.timers.size, 0, 'full timeout cancelled');
  f.request(5);
  f.context.clearCoreReprocessTimer();
  assert.equal(f.clock.armed(), 0, 'rAF gate and its fallback cancelled');
  await settle();
  f.clock.runFrame(); f.clock.runTimers();
  assert.equal(f.conversions.length, 2, 'no cancelled gate posts');
  assert.equal(f.context.coreReprocessTimer, null);
}

{
  // Stale replies stay rejected: another source, another generation, or a
  // superseded token with nothing newer queued.
  for (const change of ['source', 'generation', 'token']) {
    const f = schedulerFixture();
    f.request(1);
    await Promise.resolve();
    if (change === 'source') f.state.conversionSourceImageData = { width: 400, height: 300 };
    if (change === 'generation') f.context.coreReprocessGeneration += 1;
    if (change === 'token') f.context.coreReprocessToken += 1;
    f.conversions[0].resolve(f.result());
    await settle();
    assert.deepEqual(f.log, ['post:1'], `a reply for a stale ${change} is not applied`);
    assert.equal(f.context.coreReprocessBusy(), false);
  }
}

{
  // The photo-session settled check sees a held request as unsettled.
  const f = schedulerFixture();
  const stored = [];
  const item = { file: 'file' };
  Object.assign(f.state, { loadedFile: 'file', loadedBaseImageData: {}, rawDecodePending: false, previewSourceImageData: null });
  Object.assign(f.context, {
    processNegativeInFlight: null, dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false,
    undoStack: [], redoStack: [], photoSettingsKey: () => 'key', captureSnapshot: () => ({ refs: {} }),
    photoSessions: { put: (key, entry) => { stored.push(entry); return true; } },
    photoPreviews: { put: () => true }, createAdjustedPhotoPreview: () => ({}),
    currentConvertedPreviewSource: () => null, buildAdjustmentSettings: () => ({}),
  });
  vm.runInContext(functionSource('rememberPhotoSession'), f.context);
  f.request(1);
  f.context.rememberPhotoSession(item);
  assert.equal(stored.at(-1).snapshot, null, 'a request held to the end of the task is unsettled');
  await Promise.resolve();
  f.conversions[0].resolve(f.result());
  await settle();
  f.request(2);
  assert.equal(f.clock.frames.size, 1);
  f.context.rememberPhotoSession(item);
  assert.equal(stored.at(-1).snapshot, null, 'a request held for the next frame is unsettled');
  f.clock.runFrame();
  f.conversions[1].resolve(f.result());
  await settle();
  f.context.rememberPhotoSession(item);
  assert.ok(stored.at(-1).snapshot, 'settled once the frame is drawn');
}

// ---- One conversion per slider commit ----

function sliderFixture(options) {
  const f = schedulerFixture(options);
  const listeners = new Map();
  const element = (id, value) => ({
    id, value, min: '-100', max: '100', step: '1',
    addEventListener: (type, listener) => listeners.set(`${id}:${type}`, listener),
  });
  const slider = element('coreExposure', '0');
  const box = element('coreExposureValue', '0');
  Object.assign(f.context, {
    document: { getElementById: id => ({ coreExposure: slider, coreExposureValue: box })[id] || null },
    sliderBindings: [], sliderBindingMap: new Map(),
    markCurrentFileDirty: () => {}, schedulePreviewUpdate: () => {}, scheduleFullUpdate: () => {},
    captureSnapshot: () => ({}), commitUndoSnapshot: () => {}, updateUndoRedoButtons: () => {},
    pushUndo: () => {}, updateEnlargerUI: () => {},
  });
  vm.runInContext(['getStepDecimals', 'normalizeSliderValue', 'formatSliderValue', 'setupSlider',
    'syncSliderFromState', 'coreReprocessHandlersFor'].map(functionSource).join('\n'), f.context);
  vm.runInContext(`setupSlider('coreExposure', 'coreExposure', coreReprocessHandlersFor('coreExposure'))`, f.context);
  const fire = (target, type) => listeners.get(`${target.id}:${type}`)({ key: 'Enter', preventDefault() {} });
  // A trusted drag: one input per frame, each frame answered before the next.
  const drag = async (values) => {
    for (const value of values) {
      f.clock.nextFrame();
      slider.value = String(value);
      fire(slider, 'input');
      await Promise.resolve();
      await settle();
      f.conversions.at(-1)?.resolve(f.result());
      await settle();
    }
  };
  return { ...f, slider, box, fire, drag };
}

{
  const f = sliderFixture();
  await f.drag([10, 20, 30]);
  assert.equal(f.conversions.length, 3);
  const token = f.context.coreReprocessToken;
  f.fire(f.slider, 'change');
  await settle();
  assert.equal(f.conversions.length, 3, 'releasing the slider adds no conversion');
  assert.equal(f.context.coreReprocessToken, token, 'and does not mark the shown frame superseded');

  f.box.value = '30';
  f.fire(f.box, 'keydown');
  f.fire(f.box, 'blur');
  await settle();
  assert.equal(f.conversions.length, 3, 'Enter and blur with an unchanged value add none');

  f.clock.nextFrame();
  f.box.value = '45';
  f.fire(f.box, 'blur');
  await Promise.resolve();
  await settle();
  assert.equal(f.conversions.length, 4, 'a value-box commit with a new value adds exactly one');
  assert.equal(f.conversions[3].exposure, 45);
  f.conversions[3].resolve(f.result());
  await settle();

  f.clock.nextFrame();
  f.box.value = '50';
  f.fire(f.box, 'input');
  f.fire(f.box, 'keydown');
  await Promise.resolve();
  await settle();
  assert.equal(f.conversions.length, 5, 'typing then Enter converts the typed value once');
  f.conversions[4].resolve(f.result());
  await settle();
}

{
  // A failed frame is retried on release.
  const f = sliderFixture();
  f.clock.nextFrame();
  f.slider.value = '12';
  f.fire(f.slider, 'input');
  await Promise.resolve();
  f.conversions[0].reject(new Error('worker failed'));
  await settle();
  f.clock.nextFrame();
  f.fire(f.slider, 'change');
  await Promise.resolve();
  await settle();
  assert.equal(f.conversions.length, 2, 'the release retries the failed value');
  assert.equal(f.conversions[1].exposure, 12);
  f.conversions[1].resolve(f.result());
  await settle();
}

{
  // With repairs on every reprocess is full resolution. A release that lands
  // while the final value converts neither restarts it nor discards it, so
  // dust detection follows that one conversion.
  const f = sliderFixture({ repairs: true });
  f.clock.nextFrame();
  f.slider.value = '25';
  f.fire(f.slider, 'input');
  await Promise.resolve();
  assert.equal(f.conversions.length, 1);
  assert.equal(f.conversions[0].full, true);
  f.fire(f.slider, 'change');
  await Promise.resolve();
  await settle();
  assert.equal(f.conversions.length, 1, 'no second full-resolution conversion of the same value');
  f.conversions[0].resolve(f.result());
  await settle();
  assert.deepEqual(f.log.filter(entry => entry === 'dust'), ['dust'], 'exactly one dust detection follows');
  assert.equal(f.context.coreReprocessBusy(), false);
}

console.log('coreReprocessDispatcher: same-task idle posts, newest-wins busy lane, one post per frame, early handoff, gate cancel/flush/settle and one conversion per commit passed');
