import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { assertFolderDecodeBudget, classifyFolderReadStack } from '../../../scripts/folder-import-smoke.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function loadStudioThumbnails()');
assert.ok(start >= 0);
const end = source.indexOf('\n    }', start);
const thumbnailFunction = source.slice(start, end + '\n    }'.length);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  const active = { file: { name: 'active.png' } };
  const item = { file: { name: 'background.png' }, settings: null,
    thumbnail: 'previous-preview', thumbnailKind: 'analysis', thumbnailKey: null };
  const jobs = [], timers = [], published = [], warnings = [];
  let disposed = 0;
  const c = vm.createContext({
    state: { fileQueue: [active, item] }, studioThumbnailsRunning: false,
    automaticRollImportRunning: false, studioAutoFrameRunning: false, automaticRollRevision: 1, automaticRollPendingItems: new Set(),
    document: { body: { dataset: {} } },
    setTimeout: fn => timers.push(fn), studioBackgroundReady: () => true,
    getCurrentQueueItem: () => active, photoSettingsKey: entry => JSON.stringify(entry.settings),
    photoSessions: { peek: () => null }, cloneSettings: structuredClone,
    createConversionWorkerPool: () => ({ dispose: () => { disposed++; } }),
    processFileWithSettings: (file, settings, options) => {
      assert.equal(file, item.file); assert.equal(options.updateItemSettings, false);
      const task = deferred(); jobs.push({ ...task, settings, options }); return task.promise;
    },
    thumbnailDataUrl: image => image.preview,
    updateFileThumbnail: entry => published.push(entry.thumbnail),
    refreshThumbnailRow: () => { throw new Error('a cancelled preview is not a preview error'); },
    refreshThumbnailStates: () => { throw new Error('a lane result refreshes its own row only'); },
    console: { warn: (...args) => warnings.push(args) },
    hiddenJobs: createHiddenJobGate({ isHidden: () => false }), hiddenJobBytesFor: async () => 0,
  });
  vm.runInContext(thumbnailFunction, c);
  const timer = async () => { assert.ok(timers.length); timers.shift()(); await flush(); };
  return { c, item, jobs, timers, published, warnings, timer, disposed: () => disposed };
}

// Deterministic overlap: the thumbnail starts first, then the automatic roll
// takes ownership while its real asynchronous pipeline is suspended. Even if
// that analysis ends before the worker reply, the old job must stay cancelled.
for (const handoff of ['automatic', 'manual', 'revision']) for (const lateResult of ['success', 'abort', 'error']) {
  const f = fixture(), pending = f.c.loadStudioThumbnails();
  await f.timer();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].options.isCurrent(), true);
  if (handoff === 'automatic') f.c.automaticRollImportRunning = true;
  else if (handoff === 'manual') f.c.studioAutoFrameRunning = true;
  else f.c.automaticRollRevision++;
  assert.equal(f.jobs[0].options.isCurrent(), false, `${handoff} analysis supersedes an in-flight thumbnail`);
  f.c.automaticRollImportRunning = false;
  f.c.studioAutoFrameRunning = false;
  assert.equal(f.jobs[0].options.isCurrent(), false, 'superseded preview validity cannot revive after analysis');
  if (lateResult === 'success') {
    f.jobs[0].options.onPreparedSettings({ owner: 'obsolete-thumbnail' });
    f.jobs[0].resolve({ preview: 'obsolete-preview' });
  } else f.jobs[0].reject(lateResult === 'abort'
    ? new DOMException('Superseded', 'AbortError') : new Error('Late obsolete decoder failure'));
  await flush();
  assert.equal(f.item.settings, null, 'the thumbnail cannot replace the analysis recipe');
  assert.equal(f.item.thumbnail, 'previous-preview', 'keep the existing preview while a fresh one is queued');
  assert.equal(f.item.thumbnailErrorKey, undefined, 'obsolete ordinary errors must not poison the new recipe');
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.warnings, []);
  // Success skips directly to the next loop; AbortError waits its normal 30ms.
  if (f.jobs.length === 1) await f.timer();
  assert.equal(f.jobs.length, 2);
  const fresh = f.jobs[1];
  assert.equal(fresh.options.isCurrent(), true);
  fresh.options.onPreparedSettings({ owner: 'fresh-thumbnail' });
  fresh.resolve({ preview: 'fresh-preview' });
  await flush(); await f.timer(); await pending;
  assert.deepEqual(f.item.settings, { owner: 'fresh-thumbnail' });
  assert.deepEqual(f.published, ['fresh-preview']);
  assert.equal(f.disposed(), 1);
  assert.equal(f.c.studioThumbnailsRunning, false);
}

// A scheduled roll import owns its frames before it starts (#236 made the
// first photo ready early enough for the lane to win the gap): no thumbnail
// recipe for them, so its roll analysis keeps every pass-1 sample (#231).
// Frames it prepares with a recipe, and frames outside it, are not held back.
{
  const f = fixture();
  f.c.automaticRollPendingItems.add(f.item);
  const pending = f.c.loadStudioThumbnails();
  await f.timer();
  await f.timer();
  assert.equal(f.jobs.length, 0, 'no thumbnail recipe for a frame a scheduled roll import will prepare');
  assert.equal(f.c.studioThumbnailsRunning, true, 'the lane waits instead of ending');
  // The roll import prepared the frame and finished.
  f.item.settings = { owner: 'roll' };
  f.c.automaticRollPendingItems.delete(f.item);
  await f.timer();
  assert.equal(f.jobs.length, 1, 'then its thumbnail renders from the roll recipe');
  assert.deepEqual(f.jobs[0].settings, { owner: 'roll' });
  f.jobs[0].resolve({ preview: 'roll-preview' });
  await flush(); await f.timer(); await pending;
  assert.deepEqual(f.item.settings, { owner: 'roll' }, 'the roll recipe stays');
  assert.deepEqual(f.published, ['roll-preview']);
}
{
  const f = fixture();
  f.item.settings = { owner: 'prepared' };
  f.c.automaticRollPendingItems.add(f.item);
  const pending = f.c.loadStudioThumbnails();
  await f.timer();
  assert.equal(f.jobs.length, 1, 'a pending frame that already has its recipe still gets a thumbnail');
  f.jobs[0].resolve({ preview: 'prepared-preview' });
  await flush(); await f.timer(); await pending;
  assert.deepEqual(f.published, ['prepared-preview']);
}

// Bookkeeping per background thumbnail is O(rows) only in the candidate scan,
// which computes one settings key per entry; results touch their own row.
for (const outcome of ['success', 'error']) {
  const rows = 116;
  const active = { file: { name: 'active.png' }, settings: { n: -1 } };
  const queue = [active, ...Array.from({ length: rows - 1 }, (_, i) => ({ file: { name: `f${i}.png` }, settings: { n: i },
    thumbnail: 'ready', thumbnailKind: 'processed', thumbnailKey: JSON.stringify({ n: i }) }))];
  const stale = queue.at(-1);
  stale.thumbnailKey = 'older';
  let keys = 0, rowRefreshes = 0, tileUpdates = 0;
  const timers = [];
  const c = vm.createContext({
    state: { fileQueue: queue }, studioThumbnailsRunning: false,
    automaticRollImportRunning: false, studioAutoFrameRunning: false, automaticRollRevision: 1, automaticRollPendingItems: new Set(),
    document: { body: { dataset: {} } },
    setTimeout: fn => timers.push(fn), studioBackgroundReady: () => true,
    getCurrentQueueItem: () => active, photoSettingsKey: entry => { keys++; return JSON.stringify(entry.settings); },
    photoSessions: { peek: () => null }, cloneSettings: structuredClone,
    createConversionWorkerPool: () => ({ dispose() {} }),
    hiddenJobs: createHiddenJobGate({ isHidden: () => false }), hiddenJobBytesFor: async () => 0,
    processFileWithSettings: async () => {
      if (outcome === 'error') throw new Error('decoder failure');
      return { preview: 'fresh' };
    },
    thumbnailDataUrl: image => image.preview,
    updateFileThumbnail: () => { tileUpdates++; },
    refreshThumbnailRow: entry => { assert.equal(entry, stale); rowRefreshes++; },
    refreshThumbnailStates: () => { throw new Error('a lane result refreshes its own row only'); },
    console: { warn() {} },
  });
  vm.runInContext(thumbnailFunction, c);
  const pending = c.loadStudioThumbnails();
  timers.shift()(); await flush();
  const afterFirstJob = keys;
  assert.ok(afterFirstJob <= rows - 1 + 4, `${outcome}: one key per scanned entry plus O(1) for the job (${afterFirstJob})`);
  while (timers.length) { timers.shift()(); await flush(); }
  await pending;
  assert.ok(keys - afterFirstJob <= rows - 1, `${outcome}: the idle rescan computes one key per entry (${keys - afterFirstJob})`);
  assert.equal(outcome === 'success' ? tileUpdates : rowRefreshes, 1);
  assert.equal(stale.thumbnailKey, outcome === 'success' ? JSON.stringify(stale.settings) : 'older');
  if (outcome === 'error') assert.equal(stale.thumbnailErrorKey, JSON.stringify(stale.settings));
}

// Hidden-job gate (#241): with the window hidden under the WebKit limits, the
// preview waits while another job's item is in flight and starts once it is
// released; it holds its own admission until the preview is done.
{
  const f = fixture();
  const gate = createHiddenJobGate({ isHidden: () => true, limitsApply: () => true, setTimer: () => 0, clearTimer: () => {} });
  f.c.hiddenJobs = gate;
  const exportItem = await gate.admit({ bytes: 1 });
  const pending = f.c.loadStudioThumbnails();
  await f.timer();
  assert.equal(f.jobs.length, 0, 'no preview decode while another item is in flight');
  assert.equal(gate.waiting, 1);
  exportItem();
  await flush();
  assert.equal(f.jobs.length, 1, 'the preview starts once the item is released');
  assert.equal(gate.inFlight, 1, 'the preview holds its own admission');
  f.jobs[0].options.onPreparedSettings({ owner: 'gated' });
  f.jobs[0].resolve({ preview: 'gated-preview' });
  await flush();
  assert.equal(gate.inFlight, 0, 'released when the preview is done');
  await f.timer(); await pending;
  assert.deepEqual(f.published, ['gated-preview']);
}

// Probe regression: allow a separate final-recipe thumbnail, but still reject
// the exact duplicate automatic-analysis read exposed by the overlap above.
const stack = names => names.map(name => `    at async ${name} (http://localhost/src/app/main.js:1:1)`).join('\n');
assert.equal(classifyFolderReadStack(stack(['loadFile'])), 'foreground');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'processFileWithSettings', 'loadStudioThumbnails'])), 'thumbnail');
assert.equal(classifyFolderReadStack(stack(['loadFileToImageData', 'process', 'runBatchPipeline', 'attempt'])), 'analysis');
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
  const duplicate = { ...reads[1], id: 4 };
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, duplicate],
    decodes: [...result.decodes, { ...duplicate, readId: 4, kind }] }, 3, raw, fail), /exactly once for analysis/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, decodes: result.decodes.slice(1) }, 3, raw, fail), /exactly once for foreground/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, { ...duplicate, route: 'unknown' }] }, 3, raw, fail), /not classified/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, thumbs: [{ beforeReady: true }] }, 3, raw, fail), /competes/);
}

console.log('ok: thumbnail/automatic-roll ownership, latched cancellation, exact per-lane decode budgets, embedded route budget');
