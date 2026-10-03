// A photo that leaves the queue (Clear queue, or a drop that replaces the
// roll) through main.js's own handlers, renderFileListUI and the background
// lanes (backgroundLanesHarness.mjs), with the real caches (#229 review
// R1-079 = R1-140, R1-141):
//
// - the prefetch slot lets the removed photo's base go, and forgets it;
// - a lane's decode of a removed photo stops (its LibRaw is disposed), but a
//   decode the foreground already adopted goes on for the foreground;
// - a photo that stays queued keeps its lane job.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLaneFixture, functionSource, flush } from './backgroundLanesHarness.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
// An anonymous listener of main.js as a named function.
function listenerSource(name, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists in main.js`);
  const end = source.indexOf('\n    });', start);
  const head = marker.slice(marker.lastIndexOf('('));
  return `var ${name} = ${head}${source.slice(start + marker.length, end)}\n    };`;
}

// main.js's file list, queue handlers and import in a lane fixture: the real
// renderFileListUI over the fixture's real caches (no retainKeys stub).
function withQueue(f) {
  const c = f.context;
  const noop = () => {};
  const disposed = [];
  const loads = [];
  Object.assign(c, {
    uiDebugCounters: { fileListRenders: 0 }, fileListRefreshDeferrals: 0, fileListRefreshDeferred: false, loadGeneration: 1,
    supersedeActivation: noop, invalidatePhotoActivation: noop, syncEmbeddedPreviewQueue: noop, updateReviewFilter: noop,
    renderFileList: noop, studioWorkspace: null, updateAutoFrameButtons: noop, syncBatchUIState: noop,
    refreshThumbnailStates: noop, tileVisibility: null, observeTileVisibility: noop, observeBackgroundVisibility: noop,
    getLocalizedText: (_key, fallback) => fallback, i18n: { en: {} }, currentLang: 'en',
    // The Clear queue handler and the drop's reset.
    stopHotFolder: async () => {}, sanitizeRollMetadata: value => value, updateMetadataUI: noop, pendingProject: null,
    clearProjectRecovery: async () => {}, resetRollReferenceState: noop, updateExportButtons: noop,
    updateMirrorButtonState: noop, isProjectFileName: name => name.endsWith('.ncproj'), applyPendingProject: noop,
    openProjectFile: noop, canvasContainer: { style: {} },
    loadFile: file => { loads.push(file.name); },
    // addFilesToQueue.
    crypto: { randomUUID: () => 'import-2' }, hasRollReference: () => false, scheduleAutomaticRollImport: noop,
    queueEmbeddedTiles: noop, scheduleProjectRecovery: noop
  });
  c.state.rollReference = { enabled: false };
  // As rawFileLoader.js: aborting a decode's signal disposes its LibRaw.
  const load = c.loadFileToImageData;
  c.loadFileToImageData = (file, options = {}) => {
    options.signal?.addEventListener('abort', () => disposed.push(file.name), { once: true });
    return load(file, options);
  };
  vm.runInContext([
    ...['forgetRemovedBackgroundPhotos', 'updateFileListUI', 'renderFileListUI', 'addFilesToQueue', 'createQueueItemId'].map(functionSource),
    listenerSource('clearQueue', "    document.getElementById('clearFileListBtn').addEventListener('click', () => {"),
    listenerSource('dropFiles', "    canvasContainer.addEventListener('drop', (e) => {")
  ].join('\n'), c);
  const drop = names => c.dropFiles({
    preventDefault: noop,
    dataTransfer: { files: names.map(name => ({ name, size: 1, lastModified: 0, type: '' })) }
  });
  return { c, disposed, loads, drop };
}

// --- Clear queue empties the prefetch slot ------------------------------------------
{
  const f = createLaneFixture({ count: 4, current: 0, prefetch: true, tilesDone: true });
  const { c } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'the next photo is prefetched');
  await f.finishDecode(1);
  await f.finishRender(1, 'veil-1');
  assert.equal(c.photoPrefetch.has(f.items[1]), true);
  assert.equal(c.prefetchedItem, f.items[1]);
  assert.ok(c.photoPrefetch.bytes > 0);
  c.clearQueue();
  assert.equal(c.photoPrefetch.size, 0, 'the removed photo\'s base left the slot');
  assert.equal(c.photoPrefetch.bytes, 0);
  assert.equal(c.prefetchedItem, null, 'and the slot no longer names it');
  assert.equal(c.photoPreviews.size, 0, 'its preview went too');
  await f.clock.advance(1000);
  assert.equal(c.backgroundLanes.running, 0, 'the lane ends with the queue');
}

// --- a drop that replaces the roll: the old roll's prefetched base goes ----------------
{
  const f = createLaneFixture({ count: 4, current: 0, prefetch: true, tilesDone: true });
  const { c, loads, drop } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1);
  await f.finishRender(1, 'veil-1');
  assert.equal(c.prefetchedItem, f.items[1]);
  drop(['b0.dng', 'b1.dng']);
  assert.deepEqual(Array.from(c.state.fileQueue, item => item.file.name), ['b0.dng', 'b1.dng']);
  assert.deepEqual(loads, ['b0.dng'], 'the new roll\'s first photo is opened');
  assert.equal(c.photoPrefetch.size, 0, 'no base of the old roll is pinned through the new first decode');
  assert.equal(c.prefetchedItem, null);
}

// --- Clear queue stops a lane's decode of a removed photo -------------------------------
{
  const f = createLaneFixture({ count: 4, current: 0 });
  const { c, disposed } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'a tile decode is in flight');
  assert.equal(c.backgroundLanes.active.size, 1);
  c.clearQueue();
  await flush();
  assert.deepEqual(disposed, ['1.dng'], 'its LibRaw is disposed');
  assert.equal(f.decodeOf(1)[0].aborted, true);
  assert.equal(c.sharedDecodes.size, 0);
  assert.equal(c.backgroundLanes.active.size, 0, 'the job ended');
  assert.equal(c.photoSessions.size, 0, 'nothing was handed over');
  assert.equal(c.memoryBudget.snapshot().background, 0, 'its frame\'s memory is released');
  await f.clock.advance(1000);
  assert.equal(c.backgroundLanes.running, 0);
  assert.deepEqual(f.pools(), { convertPools: 0, convertDisposed: 0, analyzerPools: 0, analyzerDisposed: 0 });
  assert.equal(f.published.length, 0);
  assert.equal(f.warnings.length, 0, 'a stopped job is not a failure');
}

// --- ... and so does a drop that replaces the roll; the lane goes on with the new one ----
{
  const f = createLaneFixture({ count: 4, current: 0 });
  const { c, disposed, drop } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  drop(['b0.dng', 'b1.dng']);
  await flush();
  assert.deepEqual(disposed, ['1.dng'], 'the old roll\'s decode does not run beside the new first photo');
  assert.equal(c.backgroundLanes.active.size, 0);
  // The new first photo opens (the fixture's loadFile only records it).
  c.state.loadedFile = c.state.fileQueue[0].file;
  await f.clock.advance(1000);
  assert.deepEqual(f.started(), ['1.dng', 'b1.dng'], 'the lane goes on with the new roll');
}

// --- a job still waiting for its frame's memory stops too -------------------------------------
{
  const f = createLaneFixture({ count: 4, current: 0, memoryBudgetBytes: 10e9 });
  const { c } = withQueue(f);
  const budget = c.memoryBudget;
  const opening = await budget.reserve(2e9, { priority: 'foreground', label: 'open 0.dng' });
  c.kickBackgroundPhotoWork();
  await f.clock.advance(2000);
  assert.deepEqual(budget.snapshot().waiting.map(entry => entry.priority), ['background'], 'photo 1\'s job waits for memory');
  c.clearQueue();
  await flush();
  assert.equal(budget.snapshot().waiting.length, 0, 'its reservation left the queue');
  assert.equal(c.backgroundLanes.active.size, 0);
  opening.release();
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 0, 'nothing of the removed roll is decoded');
}

// --- a decode the foreground adopted goes on ----------------------------------------------
{
  const f = createLaneFixture({ count: 4, current: 0 });
  const { c, disposed } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  // The user opens photo 1: its activation adopts the lane's decode.
  const activation = new AbortController();
  const adopted = c.sharedDecodes.adopt(f.items[1].file, { signal: activation.signal });
  assert.ok(adopted);
  c.clearQueue();
  await flush();
  assert.deepEqual(disposed, [], 'the adopted decode is not disposed');
  assert.equal(f.decodeOf(1)[0].aborted, undefined);
  assert.equal(c.backgroundLanes.active.size, 0, 'the lane\'s job on the removed photo stopped');
  await f.finishDecode(1);
  const { base } = await adopted.result;
  assert.equal(base.id, 1, 'the foreground gets its base');
  adopted.release();
  assert.equal(c.sharedDecodes.size, 0);
  assert.equal(c.photoSessions.size, 0, 'the lane keeps nothing of a photo that left the queue');
}

// --- a queue change that keeps the photo keeps its job ---------------------------------------
{
  const f = createLaneFixture({ count: 4, current: 0 });
  const { c, disposed } = withQueue(f);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  c.addFilesToQueue([{ name: 'extra.dng', size: 1, lastModified: 0, type: '' }]);
  c.state.fileQueue = c.state.fileQueue.filter(item => item !== f.items[3]);
  c.updateFileListUI();
  await flush();
  assert.deepEqual(disposed, [], 'photo 1 is still queued');
  await f.finishDecode(1);
  await f.finishRender(1);
  assert.deepEqual(f.published.map(entry => entry.id), [1], 'its tile is written');
  assert.equal(c.photoSessions.has(f.items[1]), true, 'and its base kept');
}

console.log('laneQueueRemoval: a photo that leaves the queue keeps no prefetched base and no lane decode, an adopted decode goes on');
