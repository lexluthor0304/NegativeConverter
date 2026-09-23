import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
    automaticRollImportRunning: false, studioAutoFrameRunning: false, automaticRollRevision: 1,
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
    refreshThumbnailStates: () => { throw new Error('a cancelled preview is not a preview error'); },
    console: { warn: (...args) => warnings.push(args) },
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
  const result = { reads, decodes: reads.map(({ id, ...read }) => ({ ...read, readId: id, kind })),
    thumbs: [{ beforeReady: false }], selected: 3, firstReady: 100, busyAfterReady: 0 };
  assert.doesNotThrow(() => assertFolderDecodeBudget(result, 3, raw, fail));
  const duplicate = { ...reads[1], id: 4 };
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, duplicate],
    decodes: [...result.decodes, { ...duplicate, readId: 4, kind }] }, 3, raw, fail), /exactly once for analysis/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, decodes: result.decodes.slice(1) }, 3, raw, fail), /exactly once for foreground/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, reads: [...reads, { ...duplicate, route: 'unknown' }] }, 3, raw, fail), /not classified/);
  assert.throws(() => assertFolderDecodeBudget({ ...result, thumbs: [{ beforeReady: true }] }, 3, raw, fail), /competes/);
}

console.log('ok: thumbnail/automatic-roll ownership, latched cancellation, exact per-lane decode budgets');
