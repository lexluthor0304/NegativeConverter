import assert from 'node:assert/strict';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { assertFolderDecodeBudget, classifyFolderReadStack } from '../../../scripts/folder-import-smoke.mjs';
import { createLaneFixture, flush } from './backgroundLanesHarness.mjs';

// Lane tiles run in the background photo lanes (#243). The fixture's open
// photo is queue 0; photo 1 needs a canonical tile.
function fixture() {
  const f = createLaneFixture({ count: 2, current: 0, settings: false });
  f.items[1].thumbnail = 'previous-preview';
  f.items[1].thumbnailKind = 'analysis';
  f.items[1].thumbnailKey = null;
  f.items[0].thumbnail = 'open'; f.items[0].thumbnailKind = 'processed'; f.items[0].thumbnailKey = 'null';
  return f;
}

// Deterministic overlap: the tile starts first, then the automatic roll takes
// ownership while its render is suspended. Even if that analysis ends before
// the worker reply, the old job must stay cancelled.
for (const handoff of ['automatic', 'manual', 'revision']) for (const lateResult of ['success', 'abort', 'error']) {
  const f = fixture();
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1);
  assert.equal(f.renders.length, 1);
  const job = f.renders[0];
  assert.equal(job.options.updateItemSettings, false);
  assert.equal(job.options.isCurrent(), true);
  if (handoff === 'automatic') f.context.automaticRollImportRunning = true;
  else if (handoff === 'manual') f.context.studioAutoFrameRunning = true;
  else f.context.automaticRollRevision++;
  assert.equal(job.options.isCurrent(), false, `${handoff} analysis supersedes an in-flight tile`);
  f.context.automaticRollImportRunning = false;
  f.context.studioAutoFrameRunning = false;
  assert.equal(job.options.isCurrent(), false, 'superseded validity cannot revive after analysis');
  job.done = true;
  if (lateResult === 'success') {
    job.options.onPreparedSettings({ owner: 'obsolete-thumbnail' });
    job.resolve({ preview: 'obsolete-preview' });
  } else job.reject(lateResult === 'abort'
    ? new DOMException('Superseded', 'AbortError') : new Error('Late obsolete decoder failure'));
  await flush();
  assert.equal(f.items[1].settings, null, 'the tile cannot replace the analysis recipe');
  assert.equal(f.items[1].thumbnail, 'previous-preview', 'keep the existing preview while a fresh one is queued');
  assert.equal(f.items[1].thumbnailErrorKey, undefined, 'obsolete ordinary errors must not poison the new recipe');
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.rowRefreshes, []);
  // The superseded job's base went back as a base-only session: no second decode.
  await f.clock.advance(30);
  assert.equal(f.decodes.length, 1, 'the next tile job reuses the retained base');
  assert.equal(f.renders.length, 2);
  const fresh = f.renders[1];
  assert.equal(fresh.options.isCurrent(), true);
  await f.finishRender(1, 'fresh-preview');
  assert.deepEqual({ ...f.items[1].settings }, { prepared: 1 });
  assert.deepEqual(f.published.map(entry => entry.thumbnail), ['fresh-preview']);
  await f.clock.advance(1000);
  assert.equal(f.context.backgroundLanes.running, 0);
  assert.equal(f.pools().convertDisposed, 1);
}

// A scheduled roll import owns its frames before it starts (#236 made the
// first photo ready early enough for the lane to win the gap): no tile
// recipe for them, so its roll analysis keeps every pass-1 sample (#231).
// Frames it prepares with a recipe, and frames outside it, are not held back.
{
  const f = fixture();
  f.context.automaticRollPendingItems.add(f.items[1]);
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(1000);
  assert.equal(f.decodes.length, 0, 'no tile recipe for a frame a scheduled roll import will prepare');
  assert.equal(f.context.backgroundLanes.running, 1, 'the lane waits instead of ending');
  // The roll import prepared the frame and finished.
  f.items[1].settings = { owner: 'roll' };
  f.context.automaticRollPendingItems.delete(f.items[1]);
  await f.clock.advance(250);
  await f.finishDecode(1);
  assert.equal(f.renders.length, 1, 'then its tile renders from the roll recipe');
  assert.deepEqual({ ...f.renders[0].settings }, { owner: 'roll' });
  await f.finishRender(1, 'roll-preview');
  assert.deepEqual({ ...f.items[1].settings }, { owner: 'roll' }, 'the roll recipe stays');
  assert.deepEqual(f.published.map(entry => entry.thumbnail), ['roll-preview']);
}
{
  const f = fixture();
  f.items[1].settings = { owner: 'prepared' };
  f.context.automaticRollPendingItems.add(f.items[1]);
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1);
  assert.equal(f.renders.length, 1, 'a pending frame that already has its recipe still gets a tile');
  await f.finishRender(1, 'prepared-preview');
  assert.deepEqual(f.published.map(entry => entry.thumbnail), ['prepared-preview']);
}

// Bookkeeping per tile is O(rows) only in the pick, which computes one
// settings key per entry; results touch their own row.
for (const outcome of ['success', 'error']) {
  const rows = 116;
  const f = createLaneFixture({ count: rows, current: 0, settings: true, tilesDone: true });
  const stale = f.items.at(-1);
  stale.thumbnailKey = 'older';
  let keys = 0;
  const key = f.context.photoSettingsKey;
  f.context.photoSettingsKey = item => { keys++; return key(item); };
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  const afterPick = keys;
  assert.ok(afterPick <= rows + 4, `${outcome}: one key per scanned entry (${afterPick})`);
  if (outcome === 'error') f.decodes[0].reject(new Error('decoder failure'));
  else { await f.finishDecode(stale.id); await f.finishRender(stale.id, 'fresh'); }
  await flush();
  assert.ok(keys - afterPick <= 16, `${outcome}: O(1) keys for the job (${keys - afterPick})`);
  const beforeRescan = keys;
  await f.clock.advance(2000);
  assert.ok(keys - beforeRescan <= rows + 4, `${outcome}: the idle rescan computes one key per entry (${keys - beforeRescan})`);
  assert.equal(f.context.backgroundLanes.running, 0);
  assert.equal(outcome === 'success' ? f.published.length : f.rowRefreshes.length, 1);
  assert.equal(stale.thumbnailKey, outcome === 'success' ? JSON.stringify(stale.settings) : 'older');
  if (outcome === 'error') assert.equal(stale.thumbnailErrorKey, JSON.stringify(stale.settings));
}

// Hidden-job gate (#241): with the window hidden under the WebKit limits, the
// tile waits while another job's item is in flight and starts once it is
// released; it holds its own admission until the tile is done.
{
  const f = fixture();
  const gate = createHiddenJobGate({ isHidden: () => true, limitsApply: () => true, setTimer: () => 0, clearTimer: () => {} });
  f.context.hiddenJobs = gate;
  const exportItem = await gate.admit({ bytes: 1 });
  f.context.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.equal(f.decodes.length, 0, 'no decode while another item is in flight');
  assert.equal(gate.waiting, 1);
  exportItem();
  await flush();
  assert.equal(f.decodes.length, 1, 'the tile starts once the item is released');
  assert.equal(gate.inFlight, 1, 'the tile holds its own admission');
  await f.finishDecode(1);
  await f.finishRender(1, 'gated-preview');
  assert.equal(gate.inFlight, 0, 'released when the tile is done');
  assert.deepEqual(f.published.map(entry => entry.thumbnail), ['gated-preview']);
}

// Probe regression: allow a separate final-recipe tile, but still reject the
// exact duplicate automatic-analysis read exposed by the overlap above.
const stack = names => names.map(name => `    at ${name} (http://localhost/src/app/main.js:1:1)`).join('\n');
assert.equal(classifyFolderReadStack(stack(['loadFile'])), 'foreground');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'decodeForBackground', 'start', 'open', 'openTileDecode', 'runBackgroundPhotoJob'])), 'thumbnail');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'decodeForBackground', 'start', 'open', 'openAnalysisDecode', 'runBackgroundPhotoJob'])), 'analysis');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'decodeForBackground', 'start', 'open', 'openPrefetchDecode', 'runBackgroundPhotoJob'])), 'prefetch');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'runRollAnalysis', 'attempt'])), 'analysis');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'newUnknownCaller'])), 'unknown');
const fail = message => { throw new Error(message); };
for (const raw of [false, true]) {
  const extension = raw ? 'dng' : 'png', kind = raw ? 'raw' : 'png';
  const reads = [
    { id: 0, name: `folder-1.${extension}`, route: 'foreground', beforeReady: true },
    { id: 1, name: `folder-2.${extension}`, route: 'analysis', beforeReady: false },
    { id: 2, name: `folder-3.${extension}`, route: 'analysis', beforeReady: false },
    { id: 3, name: `folder-2.${extension}`, route: 'thumbnail', beforeReady: false },
    { id: 4, name: `folder-3.${extension}`, route: 'prefetch', beforeReady: false },
  ];
  // Embedded-preview jobs are their own route: tiles for every DNG (read
  // before the editor is ready, by design) and the first photo's viewer frame.
  const embedded = raw ? [1, 2, 3].map(n => ({ name: `folder-${n}.dng`, purpose: 'tile', bytesRead: 90_000, preview: 60_000, beforeReady: true }))
    .concat({ name: 'folder-1.dng', purpose: 'viewer', bytesRead: 540_000, preview: 530_000, beforeReady: true }) : [];
  const result = { reads, decodes: reads.map(({ id, ...read }) => ({ ...read, readId: id, kind })),
    thumbs: [{ beforeReady: false }], selected: 3, firstReady: 100, busyAfterReady: 0, embedded };
  assert.doesNotThrow(() => assertFolderDecodeBudget(result, 3, raw, fail));
  if (raw) {
    const over = (index, bytesRead) => ({ ...result, embedded: embedded.map((job, i) => i === index ? { ...job, bytesRead } : job) });
    assert.throws(() => assertFolderDecodeBudget(over(0, 201 * 1024), 3, raw, fail), /tile read exceeds 200 KB/);
    assert.throws(() => assertFolderDecodeBudget(over(3, 530_000 + 33 * 1024), 3, raw, fail), /viewer read exceeds/);
    assert.throws(() => assertFolderDecodeBudget(over(1, null), 3, raw, fail), /never answered/);
    assert.throws(() => assertFolderDecodeBudget({ ...result, embedded: [] }, 3, raw, fail), /queued no embedded tiles/);
    assert.throws(() => assertFolderDecodeBudget({ ...result, embedded: [...embedded, { ...embedded[0], name: 'other.dng' }] }, 3, raw, fail), /unknown file/);
  }
  const duplicate = { ...reads[1], id: 5 };
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, duplicate],
    decodes: [...result.decodes, { ...duplicate, readId: 5, kind }] }, 3, raw, fail), /exactly once for analysis/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, decodes: result.decodes.slice(1) }, 3, raw, fail), /exactly once for foreground/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, { ...duplicate, route: 'unknown' }] }, 3, raw, fail), /not classified/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, thumbs: [{ beforeReady: true }] }, 3, raw, fail), /competes/);
}

console.log('ok: tile/automatic-roll ownership, latched cancellation, exact per-lane decode budgets, embedded route budget');
