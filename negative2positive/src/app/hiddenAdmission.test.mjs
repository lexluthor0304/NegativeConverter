// The background photo lanes in a hidden window (#241, #243; #229 review
// R1-051, R1-052, R1-135): main.js's lane functions (backgroundLanesHarness.mjs)
// with the real hidden-job gate under the macOS WebKit rules (limitsApply
// true), where one item runs at a time while the window is hidden.
//
// - A full-resolution render that waits for its first frame in a hidden
//   window, which paints none, holds no lane.
// - A lane never waits for the foreground while it holds its admission: a
//   desktop batch export or a roll analysis keeps the foreground busy and
//   admits its own next item through the same gate.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLaneFixture, functionSource, deferred, flush } from './backgroundLanesHarness.mjs';
import { createHiddenJobGate, HIDDEN_BUDGET_BYTES } from './hiddenJobGate.js';

const MINUTE = 60 * 1000;

// The real gate on the fixture's clock. `resident.bytes` is the ledger.
function hiddenGate(f, resident = { bytes: 0 }) {
  const view = { hidden: false };
  const gate = createHiddenJobGate({
    isHidden: () => view.hidden, limitsApply: () => true, residentBytes: () => resident.bytes,
    now: f.clock.now, setTimer: f.clock.setTimeout, clearTimer: f.clock.clearTimeout
  });
  // Every admission, with the bytes it asked for.
  const admissions = [];
  const admit = gate.admit;
  gate.admit = (options = {}) => {
    admissions.push(options.bytes);
    return admit(options);
  };
  f.context.hiddenJobs = gate;
  return {
    gate,
    admissions,
    setHidden(hidden) {
      view.hidden = hidden;
      f.context.document.visibilityState = hidden ? 'hidden' : 'visible';
      gate.visibilityChanged();
    },
    holds: () => {
      const { inFlight, waiting, paused } = gate.status();
      return { inFlight, waiting, paused };
    }
  };
}

// main.js's startFullResolutionRender with a requestAnimationFrame that only
// fires when the test paints.
function fullResolutionRender(f) {
  const frames = [];
  const conversions = [];
  Object.assign(f.context, {
    requestAnimationFrame: callback => frames.push(callback),
    usesSilverCoreConversion: () => true, hasSeparateConversionPreview: () => true,
    createPerfTrace: () => ({ end() {} }), getImageDataPixelCount: () => 0,
    coreReprocessToken: 0, coreReprocessGeneration: 0, fullResolutionRenderAbort: null,
    scheduleFullResolutionRender: () => null, FULL_RESOLUTION_INTERACTIVE_DELAY_MS: 160,
    rerenderWithCoreControls: () => {
      const conversion = deferred();
      conversions.push(conversion);
      return conversion.promise;
    }
  });
  f.state.conversionSourceImageData = { width: 4000, height: 3000 };
  vm.runInContext(['waitForNextFrame', 'startFullResolutionRender'].map(functionSource).join('\n'), f.context);
  return {
    frames,
    conversions,
    async paint() {
      for (const frame of frames.splice(0)) frame(0);
      await flush();
    }
  };
}

// The tile job's header read is not cached yet (a project restore): the lane
// crosses a task between its pick, after an idle foreground, and its admission.
function slowFirstHeaderRead(f, bytes) {
  const header = deferred();
  let reads = 0;
  f.context.hiddenJobBytesFor = async () => {
    reads += 1;
    if (reads === 1) await header.promise;
    return bytes;
  };
  return header;
}

// --- a render armed while hidden waits for a frame that never comes; the lane decodes --------
{
  const f = createLaneFixture({ count: 2, current: 0 });
  const { gate, setHidden, holds } = hiddenGate(f);
  const render = fullResolutionRender(f);
  setHidden(true);
  // The idle render's timer fires after the user switched to another app.
  void f.context.startFullResolutionRender('idle');
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(10 * MINUTE);
  assert.ok(f.state.fullResolutionPromise, 'the render still waits for its first frame');
  assert.equal(render.conversions.length, 0, 'and has not converted anything');
  assert.deepEqual(f.started(), ['1.dng'], 'the lane starts its decode meanwhile');
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false }, 'as the one hidden item');
  await f.finishDecode(1);
  await f.finishRender(1);
  assert.equal(gate.inFlight, 0, 'released after its tile');
  assert.equal(f.items[1].thumbnailKind, 'processed');
  // Shown again: the frame comes and the render runs; the lanes wait for it again.
  setHidden(false);
  await render.paint();
  assert.equal(render.conversions.length, 1, 'the render converts at its first frame');
  assert.equal(f.context.foregroundBusyForBackground(), true, 'a converting render holds the lanes');
  render.conversions[0].resolve(true);
  await flush();
  assert.equal(f.state.fullResolutionPromise, null);
  assert.equal(f.context.foregroundBusyForBackground(), false);
}

// --- a render armed just before hiding: held while visible, not once hidden --------------------
{
  const f = createLaneFixture({ count: 3, current: 0 });
  const { setHidden } = hiddenGate(f);
  const render = fullResolutionRender(f);
  void f.context.startFullResolutionRender('idle');
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 0, 'visible: the render that waits for its frame holds the lanes, as before');
  setHidden(true);
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'hidden before its frame: the lane starts at its next check');
  await f.finishDecode(1);
  await f.finishRender(1);
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '2.dng'], 'and goes on with the next frame');
  setHidden(false);
  assert.equal(f.context.foregroundBusyForBackground(), true, 'shown: the waiting render counts again');
  await render.paint();
  assert.equal(render.conversions.length, 1);
  render.conversions[0].resolve(true);
  await flush();
  assert.equal(f.context.foregroundBusyForBackground(), false);
}

// --- a newer render owns the wait: the older one's frame does not end it ----------------------
{
  const f = createLaneFixture({ count: 2, current: 0 });
  const render = fullResolutionRender(f);
  const older = f.context.startFullResolutionRender('idle');
  // A switch drops the older render (state.fullResolutionPromise = null) and a
  // newer one starts before the older one's frame.
  f.state.fullResolutionPromise = null;
  const newer = f.context.startFullResolutionRender('idle');
  assert.notEqual(newer, older);
  assert.equal(f.context.fullResolutionFrameWait, newer);
  render.frames.shift()(0);
  await flush();
  assert.equal(f.context.fullResolutionFrameWait, newer, 'the older frame leaves the newer wait in place');
  await render.paint();
  assert.equal(f.context.fullResolutionFrameWait, null);
  for (const conversion of render.conversions) conversion.resolve(true);
  await flush();
}

// --- a desktop batch export and a lane job admitted while the batch locks the foreground --------
// The lane picked photo 1's tile while idle; the batch starts during its header
// read, so the lane's admission comes while the batch holds the foreground.
// Hidden, the batch's next item must still be admitted, and a held item reads
// as paused (the hold is the budget's), never as another item in flight.
{
  const f = createLaneFixture({ count: 3, current: 0 });
  const resident = { bytes: 0 };
  const { gate, admissions, setHidden, holds } = hiddenGate(f, resident);
  const LANE_BYTES = 1e9, ITEM_BYTES = 2e9;
  const header = slowFirstHeaderRead(f, LANE_BYTES);
  const batch = { locked: false };
  f.context.isDesktopBatchExportLocked = () => batch.locked;
  const exportItem = label => f.context.admitJobItem({ hiddenBytes: ITEM_BYTES, memoryBytes: 1e8, priority: 'user', label });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.equal(f.decodes.length, 0, 'the lane reads the header of the frame it picked');
  batch.locked = true;
  const first = await exportItem('export 1');
  header.resolve();
  await flush();
  assert.deepEqual(admissions, [ITEM_BYTES, LANE_BYTES], 'the lane was admitted while the batch locks the foreground');
  setHidden(true);
  first();
  let second = null;
  void exportItem('export 2').then(release => { second = release; });
  await f.clock.advance(30 * MINUTE);
  assert.ok(second, 'the batch\'s next item is admitted while the lane waits for the foreground');
  assert.equal(f.decodes.length, 0, 'the lane has not decoded: the batch keeps the foreground busy');
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false }, 'the lane holds no admission while it waits');
  assert.equal(admissions.filter(bytes => bytes === LANE_BYTES).length, 1, 'nor asks again while the foreground stays busy');
  // Past the grace period an item that does not fit next to the resident
  // bytes is held: paused, so the strip says "Paused while the window is hidden".
  second();
  resident.bytes = HIDDEN_BUDGET_BYTES;
  let third = null;
  void exportItem('export 3').then(release => { third = release; });
  await f.clock.advance(MINUTE);
  assert.equal(third, null);
  assert.deepEqual(holds(), { inFlight: 0, waiting: 1, paused: true }, 'held by the budget, reported as paused');
  // Shown again: the item runs; once the batch is done the lane decodes.
  setHidden(false);
  await flush();
  assert.ok(third, 'admitted when the window is shown');
  third();
  batch.locked = false;
  f.context.backgroundGate.bump();
  await flush();
  assert.deepEqual(f.started(), ['1.dng'], 'the lane decodes once the batch is done');
  assert.equal(gate.inFlight, 1);
  await f.finishDecode(1);
  await f.finishRender(1);
  assert.equal(gate.inFlight, 0);
}

// --- a retained base: the job gives its admission back too, before any step --------------------
{
  const f = createLaneFixture({ count: 3, current: 0 });
  const { setHidden, holds } = hiddenGate(f);
  f.context.photoSessions.put(f.items[1], { file: f.items[1].file, base: f.image(1) });
  const header = slowFirstHeaderRead(f, 1e9);
  const batch = { locked: false };
  f.context.isDesktopBatchExportLocked = () => batch.locked;
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  batch.locked = true;
  const first = await f.context.admitJobItem({ hiddenBytes: 2e9, memoryBytes: 1e8, priority: 'user', label: 'export 1' });
  header.resolve();
  await flush();
  setHidden(true);
  await f.clock.advance(10 * MINUTE);
  assert.equal(f.renders.length, 0, 'no tile render from the retained base while the batch runs');
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false }, 'only the batch\'s item holds the gate');
  first();
  batch.locked = false;
  f.context.backgroundGate.bump();
  await flush();
  assert.equal(f.decodes.length, 0, 'the retained base needs no decode');
  assert.equal(f.renders.length, 1, 'the tile renders once the batch is done');
  assert.equal(f.renders[0].options.sourceImageData.id, 1);
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false }, 'as the one hidden item');
  await f.finishRender(1);
  assert.deepEqual(holds(), { inFlight: 0, waiting: 0, paused: false });
}

// --- memory granted inside a photo switch: the memory and the admission both go back ------------
{
  const f = createLaneFixture({ count: 3, current: 0, memoryBudgetBytes: 10e9 });
  const { gate, setHidden, holds } = hiddenGate(f);
  const budget = f.context.memoryBudget;
  const opening = await budget.reserve(2e9, { priority: 'foreground', label: 'open 0.dng' });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(2000);
  assert.deepEqual(budget.snapshot().waiting.map(entry => entry.priority), ['background']);
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false }, 'admitted before it reserves its memory');
  f.context.document.body.dataset.photoSwitching = 'true';
  opening.release();
  await flush();
  assert.equal(budget.snapshot().background, 0, 'the memory is given back while the lane waits for the switch');
  assert.deepEqual(holds(), { inFlight: 0, waiting: 0, paused: false }, 'and so is the admission');
  setHidden(true);
  const other = await gate.admit({ bytes: 2e9 });
  assert.equal(gate.inFlight, 1, 'another job\'s item runs meanwhile');
  other();
  delete f.context.document.body.dataset.photoSwitching;
  f.context.backgroundGate.bump();
  await flush();
  assert.deepEqual(f.started(), ['1.dng'], 'the frame starts once the switch is over');
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false });
  assert.ok(budget.snapshot().background > 0, 'reserved again before its decode');
}

// --- Analyze roll (studioBusy) and a prefetch admitted as it starts -------------------------------
// The analysis admits each decode through the gate; the prefetch of the next
// photo picked before it and was admitted as it set studioBusy.
{
  const f = createLaneFixture({ count: 3, current: 0, prefetch: true, tilesDone: true });
  const { gate, setHidden, holds } = hiddenGate(f);
  const header = slowFirstHeaderRead(f, 1e9);
  vm.runInContext(functionSource('runHiddenJobItem'), f.context);
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  f.context.document.body.dataset.studioBusy = 'true';
  f.context.studioAutoFrameRunning = true;
  header.resolve();
  await flush();
  setHidden(true);
  const analysed = [];
  const analysis = (async () => {
    for (const item of f.items) {
      await f.context.runHiddenJobItem([item.file], async () => {
        analysed.push(item.id);
        await new Promise(resolve => f.clock.setTimeout(resolve, MINUTE));
      });
    }
  })();
  await f.clock.advance(30 * MINUTE);
  assert.deepEqual(analysed, [0, 1, 2], 'every decode of the analysis is admitted while the prefetch waits');
  await analysis;
  assert.equal(f.decodes.length, 0, 'the prefetch has not decoded during the analysis');
  assert.deepEqual(holds(), { inFlight: 0, waiting: 0, paused: false });
  delete f.context.document.body.dataset.studioBusy;
  f.context.studioAutoFrameRunning = false;
  f.context.backgroundGate.bump();
  await f.clock.advance(1000);
  // A hidden macOS window prefetches nothing (R1-059): the prefetch decodes
  // once the window is shown, when the lanes are kicked again.
  assert.equal(f.decodes.length, 0, 'no prefetch while the window is hidden');
  assert.deepEqual(holds(), { inFlight: 0, waiting: 0, paused: false });
  setHidden(false);
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'the prefetch decodes once the window is shown');
  assert.equal(gate.inFlight, 1);
}

// --- safe mode (a resumed job that was killed again): one item even while visible ---------------
{
  const f = createLaneFixture({ count: 3, current: 0 });
  const { gate, holds } = hiddenGate(f);
  gate.setSafeMode(true);
  const header = slowFirstHeaderRead(f, 1e9);
  const batch = { locked: false };
  f.context.isDesktopBatchExportLocked = () => batch.locked;
  const exportItem = label => f.context.admitJobItem({ hiddenBytes: 2e9, memoryBytes: 1e8, priority: 'user', label });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  batch.locked = true;
  const first = await exportItem('resumed 1');
  header.resolve();
  await flush();
  first();
  let second = null;
  void exportItem('resumed 2').then(release => { second = release; });
  await f.clock.advance(30 * MINUTE);
  assert.ok(second, 'the resumed batch goes on while the lane waits for it');
  assert.deepEqual(holds(), { inFlight: 1, waiting: 0, paused: false });
  second();
  batch.locked = false;
  f.context.backgroundGate.bump();
  await flush();
  assert.deepEqual(f.started(), ['1.dng']);
}

console.log('hiddenAdmission tests passed');
