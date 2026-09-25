// The background photo lanes of main.js (#243), run with the real scheduler
// functions (backgroundLanesHarness.mjs): pick order, the foreground gate,
// one shared decode per frame, roll-analysis pass 1 through the lanes, the
// prefetch slot and the hand-over of finished bases.
import assert from 'node:assert/strict';
import { createLaneFixture, flush } from './backgroundLanesHarness.mjs';

// --- lane tiles follow the display order around the open photo -----------------
{
  // Display order is the reverse of the queue; the open photo is queue 2 at
  // display position 2. Direction +1 (towards display position 3 = queue 1).
  const f = createLaneFixture({ count: 5, order: [4, 3, 2, 1, 0], current: 2, settings: true });
  f.context.kickBackgroundPhotoWork();
  assert.equal(f.decodes.length, 0, 'the lane lets the import start first');
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'priority 1: the next photo in the direction of travel');
  assert.equal(f.decodeOf(1)[0].options.filmStats, true);
  await f.finishDecode(1);
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].options.sourceImageData.id, 1, 'the tile renders from the shared decode');
  assert.equal(f.renders[0].options.previewMaxDimension, 288);
  assert.equal(typeof f.renders[0].options.beforeHeavyStep, 'function', 'heavy steps wait for the foreground');
  assert.ok(f.renders[0].options.analyzers, 'frame detection runs on the lane\'s own analyzers');
  await f.finishRender(1);
  assert.deepEqual(f.published.map(entry => entry.id), [1]);
  assert.equal(f.items[1].thumbnailKind, 'processed');
  // The finished base is kept as a base-only session when it fits without eviction.
  assert.equal(f.context.photoSessions.has(f.items[1]), true);
  assert.deepEqual(f.context.photoSessions.peek(f.items[1]).rawMetadata, { lensModel: 'lens-1' }, 'with its rawMetadata');
  assert.equal(f.context.sharedDecodes.size, 0, 'the lane released its lease');
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '3.dng'], 'priority 2: the neighbour on the other side');
  await f.finishDecode(3); await f.finishRender(3); await f.clock.advance(30);
  await f.finishDecode(0); await f.finishRender(0); await f.clock.advance(30);
  await f.finishDecode(4); await f.finishRender(4); await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '3.dng', '0.dng', '4.dng'], 'then by display distance');
  await f.clock.advance(1000);
  assert.equal(f.context.backgroundLanes.running, 0, 'the lane ends when nothing is left');
  assert.deepEqual(f.pools(), { convertPools: 1, convertDisposed: 1, analyzerPools: 1, analyzerDisposed: 1 },
    'the lane\'s workers are released when it ends');
}

// --- the foreground gate: no decode starts while busy or within 400 ms of input ------
{
  const f = createLaneFixture({ count: 3, current: 0 });
  f.context.document.body.dataset.photoSwitching = 'true';
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(2000);
  assert.equal(f.decodes.length, 0, 'never during a photo switch');
  delete f.context.document.body.dataset.photoSwitching;
  f.context.processNegativeInFlight = Promise.resolve();
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 0, 'never during a conversion');
  f.context.processNegativeInFlight = null;
  f.context.backgroundGate.noteInput();
  f.context.backgroundGate.bump();
  await f.clock.advance(399);
  assert.equal(f.decodes.length, 0, 'not within 400 ms of input');
  await f.clock.advance(1);
  assert.deepEqual(f.started(), ['1.dng'], 'starts once idle');
  // A job mid-way waits (capped) before its next heavy step.
  await f.finishDecode(1);
  const step = f.renders[0].options.beforeHeavyStep;
  f.context.document.body.dataset.studioBusy = 'true';
  let stepped = false;
  void step('geometry').then(() => { stepped = true; });
  await f.clock.advance(1999);
  assert.equal(stepped, false, 'paused while the foreground is busy');
  await f.clock.advance(1);
  assert.equal(stepped, true, 'but never longer than 2 s');
}

// --- a decode in flight is shared with the foreground (collision) ---------------------
{
  const f = createLaneFixture({ count: 4, current: 0 });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  // The user opens photo 1 while the lane decodes it.
  f.open(1, { loaded: false });
  const activation = new AbortController();
  const adopted = f.context.sharedDecodes.adopt(f.items[1].file, { signal: activation.signal });
  assert.ok(adopted, 'the foreground adopts the lane\'s decode');
  await f.finishDecode(1, { lensModel: 'Summilux' });
  const { base, rawMetadata } = await adopted.result;
  assert.equal(base.id, 1);
  assert.deepEqual(rawMetadata, { lensModel: 'Summilux' }, 'with the lens metadata a cold open would have');
  adopted.release();
  assert.equal(f.decodeOf(1).length, 1, 'exactly one decode of the file');
  assert.equal(f.renders.length, 0, 'the lane does not render the photo the user opened');
  assert.equal(f.context.photoSessions.has(f.items[1]), false, 'nor keep a second reference to the open photo');
  f.state.loadedFile = f.items[1].file;
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '2.dng'], 'and moves on');
}

// --- no two jobs on one file, and lanes pick up after a superseded foreground -----------
{
  const f = createLaneFixture({ count: 3, current: 0 });
  f.context.kickBackgroundPhotoWork();
  f.context.kickBackgroundPhotoWork();
  assert.equal(f.context.backgroundLanes.running, 1, 'one lane for tiles');
  await f.clock.advance(250);
  const activation = new AbortController();
  const adopted = f.context.sharedDecodes.adopt(f.items[1].file, { signal: activation.signal });
  activation.abort(new DOMException('Superseded photo activation', 'AbortError'));
  await assert.rejects(adopted.result, { name: 'AbortError' });
  assert.equal(f.decodeOf(1)[0].aborted, undefined, 'a superseded adopter never cancels the lane\'s decode');
}

// --- low-memory devices: an activation aborts background decodes (but the target's) ----
{
  const f = createLaneFixture({ count: 4, current: 0 });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  f.context.abortBackgroundDecodes({ except: f.items[2].file });
  await flush();
  assert.equal(f.decodeOf(1)[0].aborted, true, 'the lane decode is aborted');
  assert.equal(f.context.sharedDecodes.size, 0);
  assert.equal(f.published.length, 0);
  const g = createLaneFixture({ count: 4, current: 0 });
  g.context.kickBackgroundPhotoWork();
  await g.clock.advance(250);
  g.context.abortBackgroundDecodes({ except: g.items[1].file });
  assert.equal(g.decodeOf(1)[0].aborted, undefined, 'the target\'s own decode is kept for adoption');
}

// --- roll analysis pass 1 through the lanes ---------------------------------------------
{
  const f = createLaneFixture({ count: 5, order: [4, 3, 2, 1, 0], current: 2, settings: false });
  f.context.automaticRollImportRunning = true;
  const analysed = [], sunk = [], errors = [];
  const pending = new Set([f.items[0], f.items[1], f.items[3], f.items[4]]);
  let valid = true;
  const pass = f.context.runRollAnalysisPass([...pending], {
    lanes: 1,
    valid: () => valid,
    wants: item => !item.settings && item !== f.state.fileQueue[f.state.currentFileIndex],
    begin: item => ({
      valid: () => valid && !item.settings && item !== f.state.fileQueue[f.state.currentFileIndex],
      async analyze(image, step) {
        await step();
        analysed.push(image.id);
        return image.id === 4 ? null : { settings: { analysed: image.id } };
      }
    }),
    sink: async (item, payload) => { item.settings = payload.settings; sunk.push(item.id); },
    onError: (item, error) => errors.push([item.id, error.message])
  });
  let done = false;
  void pass.then(() => { done = true; });
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'the display neighbour first (queue order would take 0)');
  await f.finishDecode(1);
  assert.deepEqual(sunk, [1]);
  assert.equal(f.renders.length, 0, 'no tile render during a roll import');
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '3.dng']);
  // The user opens photo 3 while the lane decodes it: its analysis stops
  // (the foreground analyses it), without a retry, and the pass goes on.
  f.open(3, { loaded: false });
  await f.finishDecode(3);
  assert.deepEqual(analysed, [1], 'the now-current frame is left to the foreground');
  await f.clock.advance(1000);
  assert.deepEqual(f.started(), ['1.dng', '3.dng'], 'nothing starts while the opened photo loads');
  f.state.loadedFile = f.items[3].file;
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng', '3.dng', '4.dng'], 're-prioritised around the newly opened photo');
  f.decodeOf(4)[0].reject(new Error('garbled'));
  await flush();
  assert.deepEqual(errors, [[4, 'garbled']], 'a decode error reaches the pass');
  f.items[4].settings = { failed: true }; // the pass marks it failed
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '3.dng', '4.dng', '0.dng']);
  assert.equal(done, false, 'a frame is still being analysed');
  await f.finishDecode(0);
  await f.clock.advance(30);
  assert.equal(done, true, 'the pass resolves once nothing it wants is left (the open photo is the foreground\'s)');
  assert.deepEqual(sunk, [1, 0]);
  assert.equal(f.items[3].settings, null, 'the attempt retries the open photo later if it is left without a recipe');
}

// --- prefetch: the next photo's base in its own slot, and a preview for the veil ----------
{
  const f = createLaneFixture({ count: 4, current: 1, prefetch: true, sessionBudget: 64, tilesDone: true });
  // photoSessions holds the photo the user came from (A/B/A).
  const visited = { file: f.items[0].file, base: { data: new Uint8Array(64) } };
  f.context.photoSessions.put(f.items[0], visited);
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['2.dng'], 'the next photo is prefetched');
  await f.finishDecode(2);
  assert.equal(f.context.photoPrefetch.has(f.items[2]), true, 'its base is in the prefetch slot');
  assert.equal(f.context.photoSessions.peek(f.items[0]), visited, 'the visited photo is not evicted');
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].options.previewMaxDimension, 1200);
  assert.equal(f.renders[0].options.updateItemSettings, false);
  assert.equal(f.renders[0].options.sourceImageData.id, 2);
  assert.equal(typeof f.renders[0].options.convert, 'function', 'the lane\'s pool, never the foreground converter');
  await f.finishRender(2, 'veil-2');
  const preview = f.context.photoPreviews.peek(f.items[2]);
  assert.equal(preview.key, JSON.stringify(f.items[2].settings), 'keyed by the recipe it shows');
  assert.equal(preview.image.preview, 'veil-2');
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 1, 'nothing else to do: no second prefetch');
  // A new recipe (a roll commit) redoes the preview from the held base, without a decode.
  f.items[2].settings = { id: 2, rolled: true };
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.equal(f.decodes.length, 1, 'the base does not depend on the recipe');
  // One job: the new tile and the new preview, both from the held base.
  assert.equal(f.renders.length, 2);
  assert.equal(f.renders[1].options.previewMaxDimension, 288);
  assert.equal(f.renders[1].options.sourceImageData.id, 2);
  await f.finishRender(2, 'tile-2b');
  assert.equal(f.renders.length, 3);
  assert.equal(f.renders[2].options.previewMaxDimension, 1200);
  await f.finishRender(2, 'veil-2b');
  assert.equal(f.context.photoPreviews.peek(f.items[2]).image.preview, 'veil-2b');
  assert.equal(f.context.photoPreviews.peek(f.items[2]).key, JSON.stringify(f.items[2].settings));
  await f.clock.advance(1000);
  // Moving two photos away drops the slot.
  f.open(3);
  assert.equal(f.context.photoPrefetch.has(f.items[2]), true, 'one away: kept');
  f.open(0);
  assert.equal(f.context.photoPrefetch.has(f.items[2]), false, 'two away: dropped');
  assert.equal(f.context.photoPrefetch.bytes, 0);
}

// --- prefetch waits for a settled photo, and is off without the desktop budget -------------
{
  const f = createLaneFixture({ count: 3, current: 0, prefetch: true, tilesDone: true });
  f.context.getCurrentQueueItem().provisional = { wasDirty: false };
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 0, 'no prefetch while the open photo is provisional');
  delete f.items[0].provisional;
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  const off = createLaneFixture({ count: 3, current: 0, prefetch: false, tilesDone: true });
  off.context.kickBackgroundPhotoWork();
  await off.clock.advance(1000);
  assert.equal(off.decodes.length, 0, 'no slot on low-memory devices');
}

// --- hand-over: a lane base goes to the slot only when it is the next photo -------------------
{
  const f = createLaneFixture({ count: 4, current: 0, prefetch: true, sessionBudget: 0 });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  await f.finishDecode(1);
  assert.equal(f.context.photoPrefetch.has(f.items[1]), true, 'the tile job for the next photo also prefetches it');
  await f.finishRender(1);
  await f.finishRender(1, 'veil');
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '2.dng']);
  await f.finishDecode(2);
  await f.finishRender(2);
  assert.equal(f.context.photoPrefetch.has(f.items[1]), true, 'a later tile base never replaces the next photo');
  assert.equal(f.context.photoPrefetch.has(f.items[2]), false, 'no room in the sessions and not the next photo: dropped');
}

console.log('backgroundLanes tests passed');
