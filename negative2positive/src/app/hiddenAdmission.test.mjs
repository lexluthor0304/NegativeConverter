// The background photo lanes in a hidden window (#241, #243; #229 review
// R1-051): main.js's lane functions (backgroundLanesHarness.mjs) with the
// real hidden-job gate under the macOS WebKit rules (limitsApply true), where
// one item runs at a time while the window is hidden.
//
// - A full-resolution render that waits for its first frame in a hidden
//   window, which paints none, holds no lane.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLaneFixture, functionSource, deferred, flush } from './backgroundLanesHarness.mjs';
import { createHiddenJobGate } from './hiddenJobGate.js';

const MINUTE = 60 * 1000;

// The real gate on the fixture's clock.
function hiddenGate(f) {
  const view = { hidden: false };
  const gate = createHiddenJobGate({
    isHidden: () => view.hidden, limitsApply: () => true,
    now: f.clock.now, setTimer: f.clock.setTimeout, clearTimer: f.clock.clearTimeout
  });
  f.context.hiddenJobs = gate;
  return {
    gate,
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

console.log('hiddenAdmission tests passed');
