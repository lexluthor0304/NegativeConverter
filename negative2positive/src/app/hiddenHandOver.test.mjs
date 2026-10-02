// The background photo lanes and the open photo in a hidden macOS window
// (#241, #243; #229 review R1-053, R1-059, R1-136, R1-061): main.js's lane
// functions (backgroundLanesHarness.mjs) with the real hidden-job gate under
// the macOS WebKit rules, wired as main.js wires it, the real memory ledger,
// and main.js's shedding, parking, photo switch and load.
//
// - A hidden window keeps no lane base and prefetches nothing: the caches it
//   shed stay empty, and the next photo is not decoded again after every
//   hidden job (R1-053, R1-059).
// - An item is held for its bytes only once the page has shed (R1-053).
// - A lane is a hidden job only while one of its jobs holds an admission for
//   an analysis or a tile: hiding while a lane rests or prefetches keeps the
//   warm caches, and so does the end of that prefetch (R1-059).
// - Parking turns history cold, so the derived planes really go and the held
//   item starts (R1-136).
// - A switch holds a lane's decode from its first task: a lane step that ends
//   while the switch paints cannot drop the decode it adopts (R1-061).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLaneFixture, functionSource, deferred, flush } from './backgroundLanesHarness.mjs';
import { createHiddenJobGate, HIDDEN_GRACE_MS } from './hiddenJobGate.js';
import { createRetainedLedger } from './memoryBudget.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
// A generator of main.js (functionSource reads plain and async functions).
function generatorSource(name) {
  const match = new RegExp(`^    function\\* ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists in main.js`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}
const SNAPSHOT_REF_KEYS = /const SNAPSHOT_REF_KEYS = (\[[^\]]+\]);/.exec(source)[1];

// The hidden-job section of main.js, its parking and the memory ledger.
const HIDDEN_FUNCTIONS = [
  'hiddenJobRunning', 'shedHiddenJobMemory', 'hiddenJobUsesAiRepair', 'onHiddenJobAdmitted', 'onHiddenJobsIdle',
  'hiddenJobVisibilityChanged', 'hiddenResidentBytes', 'onHiddenJobPaused', 'hiddenParkEnabled',
  'parkOpenPhotoForHiddenJob', 'memoryLedgerConsumers', 'openPhotoMemoryRoots', 'liveHistoryRoots',
  'sampleStoreBytes', 'workerResidentBytes'
];

// A plane of `bytes` bytes, with a buffer of its own.
const plane = (bytes, tag) => ({ tag, width: 1, height: 1, data: new Uint8ClampedArray(bytes) });

// main.js's hidden-job section in a lane fixture, and the real gate wired as
// main.js wires it (`createHiddenJobGate` there) on the fixture's clock.
// `budgetBytes` scales the hidden budget to the fixture's planes, `itemBytes`
// is every item's estimate. `events` records each shed the gate asks for
// before it holds an item ('shed'), and every pause and resume.
function hiddenWindow(f, { budgetBytes = 1e15, itemBytes = 0, park = false } = {}) {
  const c = f.context;
  const view = { hidden: false };
  const events = [];
  const workers = { exportAlive: false, exportBytes: 0, terminated: 0 };
  Object.assign(c, {
    activeLongJobs: 0, automaticRollAnalysisRunning: false, hiddenJobSeen: false, parkedPhoto: null,
    undoStack: [], redoStack: [], settledAdjustedBuffer: null, previewAdjustedBuffer: null, workerResidents: new Map(),
    exportWorkerPendingCount: () => 0,
    terminateExportWorker: () => {
      if (workers.exportAlive) workers.terminated++;
      workers.exportAlive = false;
    },
    analyzeFrameInWorker: { releaseHelpers() {} }, releaseAiRepairSession: async () => {},
    applyMemoryCeiling() {}, refreshHiddenJobStatus() {}, reloadAiRepairForArmedBrush() {}, unparkOpenPhoto: async () => {},
    safeStorageGet: key => (park && key === 'nc_hidden_park_v1' ? 'on' : null),
    // What parking touches besides the planes.
    loadGeneration: 1, dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false,
    persistCurrentFileSettings() {}, supersedeActivation() {}, invalidatePhotoActivation() { c.parkedPhoto = null; },
    gpuPreview: { prepared: null }, webglState: { renderer2: null }, queueMicrotask
  });
  // The export worker after a batch item: a worker resident the shed ends.
  c.workerResidents.set('export', { residentBytes: () => (workers.exportAlive ? workers.exportBytes : 0) });
  f.state.dustRemoval = { ai: false, enabled: false, processing: false, mask: null, inpaintedImageData: null, cleanSource: null, _state: null };
  c.SNAPSHOT_REF_KEYS = vm.runInContext(SNAPSHOT_REF_KEYS, c);
  vm.runInContext([...HIDDEN_FUNCTIONS.map(functionSource), generatorSource('boundedStoreBuffers')].join('\n'), c);
  c.memoryLedger = createRetainedLedger(() => c.memoryLedgerConsumers());
  const gate = createHiddenJobGate({
    isHidden: () => view.hidden, limitsApply: () => true, residentBytes: () => c.hiddenResidentBytes(), budgetBytes,
    now: f.clock.now, setTimer: f.clock.setTimeout, clearTimer: f.clock.clearTimeout,
    onChange: () => {
      events.push(gate.paused ? 'paused' : 'resumed');
      if (gate.paused) c.onHiddenJobPaused();
    },
    onHiddenAdmit: () => c.onHiddenJobAdmitted(),
    onGraceExpired: () => c.shedHiddenJobMemory(),
    onIdle: () => c.onHiddenJobsIdle(),
    onBudgetHold: () => {
      events.push('shed');
      c.shedHiddenJobMemory();
    }
  });
  c.hiddenJobs = gate;
  c.hiddenJobBytesFor = async () => itemBytes;
  return {
    gate, events, workers,
    // As the visibilitychange listener does.
    setHidden(hidden) {
      view.hidden = hidden;
      c.document.visibilityState = hidden ? 'hidden' : 'visible';
      c.hiddenJobVisibilityChanged();
    }
  };
}

// Finish every decode and render the lanes start, until they go quiet.
async function drain(f, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    const decode = f.decodes.find(record => !record.settled && !record.aborted);
    if (decode) { await f.finishDecode(f.items.findIndex(item => item.file === decode.file)); continue; }
    const render = f.renders.find(entry => !entry.done);
    if (render) { await f.finishRender(f.items.findIndex(item => item.file === render.file)); continue; }
    await f.clock.advance(250);
    if (!f.decodes.some(record => !record.settled && !record.aborted) && !f.renders.some(entry => !entry.done)) return;
  }
}

// --- a hidden window: no lane base comes back, and the next photo is decoded once -------------
// The lane prefetched photo 1 while visible; hidden, it renders the tiles of
// 2-4. Every hidden admission sheds the caches, and nothing fills them again.
{
  const f = createLaneFixture({ count: 5, current: 0, prefetch: true, tilesDone: true });
  for (const id of [2, 3, 4]) f.items[id].thumbnail = null;
  const w = hiddenWindow(f);
  const c = f.context;
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'visible: the next photo is prefetched first');
  await f.finishDecode(1);
  await f.finishRender(1);
  assert.equal(c.photoPrefetch.has(f.items[1]), true);
  assert.equal(c.photoPreviews.size, 1);
  // Hidden while the lane rests between jobs: no job runs, the caches stay.
  w.setHidden(true);
  assert.equal(c.photoPrefetch.has(f.items[1]), true, 'a resting lane is no hidden job');
  await f.clock.advance(30);
  assert.deepEqual(f.started(), ['1.dng', '2.dng'], 'the lane goes on with a tile');
  assert.equal(c.photoPrefetch.size + c.photoPreviews.size + c.photoSessions.size, 0, 'whose hidden admission sheds the caches');
  await f.finishDecode(2);
  await f.finishRender(2);
  assert.equal(c.photoSessions.size, 0, 'the tile\'s base is not kept (R1-053)');
  await drain(f);
  assert.deepEqual(f.started(), ['1.dng', '2.dng', '3.dng', '4.dng'], 'photo 1 is not decoded again after each hidden job (R1-059)');
  assert.deepEqual(f.items.slice(2).map(item => item.thumbnailKind), ['processed', 'processed', 'processed']);
  assert.equal(c.photoSessions.size + c.photoPrefetch.size + c.photoPreviews.size, 0, 'and no cache was filled again');
  assert.equal(c.backgroundLanes.running, 0, 'with nothing else to do the lane stops');
  assert.equal(c.backgroundLanes.gateItems, 0);
  // Shown again: the prefetch comes back (the first switch may be cold).
  w.setHidden(false);
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng', '2.dng', '3.dng', '4.dng', '1.dng'], 'visible again, the slot refills');
  await f.finishDecode(1);
  assert.equal(c.photoPrefetch.has(f.items[1]), true);
}

// --- an item is held for its bytes only after the page shed (R1-053) ------------------------
{
  const f = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  f.items[2].thumbnail = null;
  const w = hiddenWindow(f, { budgetBytes: 10_000, itemBytes: 4000 });
  const c = f.context;
  f.state.loadedBaseImageData = plane(4000, 'open photo');
  w.setHidden(true);
  await f.clock.advance(HIDDEN_GRACE_MS);
  // An idle export worker left by a hidden batch item: 4000 + 4000 + 4000
  // do not fit 10 000, the open photo and the item do.
  Object.assign(w.workers, { exportAlive: true, exportBytes: 4000 });
  assert.equal(c.hiddenResidentBytes(), 8000);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(w.events, ['shed'], 'the gate asked the page to shed first');
  assert.equal(w.workers.terminated, 1, 'which ended the idle worker');
  assert.deepEqual(f.started(), ['2.dng'], 'and the item started: no pause');
  await drain(f);
  // Still over after the shed: held, and the pause comes after the shed.
  const g = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  g.items[2].thumbnail = null;
  const v = hiddenWindow(g, { budgetBytes: 10_000, itemBytes: 4000 });
  g.state.loadedBaseImageData = plane(7000, 'open photo');
  v.setHidden(true);
  await g.clock.advance(HIDDEN_GRACE_MS);
  g.context.kickBackgroundPhotoWork();
  await g.clock.advance(250);
  assert.deepEqual(v.events, ['shed', 'paused'], 'paused only after the shed');
  assert.equal(g.decodes.length, 0);
  assert.deepEqual({ waiting: v.gate.waiting, gateItems: g.context.backgroundLanes.gateItems }, { waiting: 1, gateItems: 1 });
  assert.equal(g.context.hiddenJobRunning(), false, 'a lane waiting for its admission is no hidden job (R1-059)');
  v.setHidden(false);
  await flush();
  assert.deepEqual(v.events, ['shed', 'paused', 'resumed']);
  assert.deepEqual(g.started(), ['2.dng'], 'shown again, it starts');
  assert.equal(g.context.hiddenJobRunning(), true, 'and is a job while it holds its admission for a tile');
}

// --- a lane that rests, waits or prefetches is no hidden job (R1-059) -----------------------
{
  // Hidden while the lane prefetches: the photo just left keeps its session,
  // also once that prefetch ends.
  const f = createLaneFixture({ count: 4, current: 0, prefetch: true, tilesDone: true });
  const w = hiddenWindow(f);
  const c = f.context;
  c.photoSessions.put(f.items[3], { file: f.items[3].file, base: plane(64, 'left') });
  assert.equal(c.hiddenJobRunning(), false);
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng'], 'the prefetch decodes');
  assert.equal(w.gate.inFlight, 1);
  assert.equal(c.hiddenJobRunning(), false, 'a prefetch holding its admission is no hidden job');
  w.setHidden(true);
  assert.equal(c.photoSessions.has(f.items[3]), true, 'hiding during a prefetch sheds nothing');
  await f.finishDecode(1);
  await drain(f);
  assert.equal(w.gate.inFlight, 0, 'the prefetch ended');
  assert.equal(c.photoSessions.has(f.items[3]), true, 'and its end sheds nothing either');
  assert.equal(c.photoPrefetch.size, 0, 'its base is not kept in a hidden window');
  assert.equal(f.renders.length, 0, 'nor its preview rendered');
  // A job of another caller: counted, admitted under the hidden limits, shed.
  const release = await w.gate.admit({ bytes: 1 });
  assert.equal(c.hiddenJobRunning(), true);
  assert.equal(c.photoSessions.size, 0, 'a hidden admission sheds');
  release();
  assert.equal(c.hiddenJobRunning(), false);
}
{
  // A preview render that the hide stopped is rendered again from the held
  // base once the window is shown, without a second decode.
  const f = createLaneFixture({ count: 3, current: 0, prefetch: true, tilesDone: true });
  const w = hiddenWindow(f);
  const c = f.context;
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1);
  assert.equal(c.photoPrefetch.has(f.items[1]), true, 'the base is held before its preview renders');
  assert.equal(f.renderOf(1).length, 1);
  w.setHidden(true);
  await f.finishRender(1);
  assert.equal(c.photoPreviews.size, 0, 'a preview that lands hidden is not kept');
  assert.equal(c.photoPrefetch.has(f.items[1]), true, 'the slot stays: no job ran hidden');
  await f.clock.advance(1000);
  assert.equal(f.renderOf(1).length, 1, 'nothing more while hidden');
  w.setHidden(false);
  await f.clock.advance(250);
  assert.equal(f.renderOf(1).length, 2, 'shown again, the preview renders from the held base');
  assert.equal(f.decodeOf(1).length, 1, 'without a second decode');
  await f.finishRender(1);
  assert.equal(c.photoPreviews.peek(f.items[1])?.key, c.photoSettingsKey(f.items[1]));
}
{
  // A tile job holding its admission is one: hiding sheds at once.
  const f = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  f.items[2].thumbnail = null;
  const w = hiddenWindow(f);
  const c = f.context;
  c.photoSessions.put(f.items[1], { file: f.items[1].file, base: plane(64, 'left') });
  // A lane waiting for the foreground holds nothing and is no job.
  c.document.body.dataset.studioBusy = 'true';
  c.kickBackgroundPhotoWork();
  await f.clock.advance(1000);
  assert.equal(c.backgroundLanes.running, 1);
  assert.equal(c.hiddenJobRunning(), false, 'a lane waiting for the foreground is no hidden job');
  delete c.document.body.dataset.studioBusy;
  c.backgroundGate.bump();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['2.dng']);
  assert.equal(c.hiddenJobRunning(), true, 'a tile job holding its admission is a hidden job');
  w.setHidden(true);
  assert.equal(c.photoSessions.size, 0, 'hiding while it runs sheds at once');
  await drain(f);
  assert.equal(c.hiddenJobRunning(), false);
}

// --- parking frees the planes its hot history pinned (R1-136) ------------------------------
{
  const f = createLaneFixture({ count: 2, current: 0, tilesDone: true });
  f.items[1].thumbnail = null;
  const w = hiddenWindow(f, { budgetBytes: 10_000, itemBytes: 3000, park: true });
  const c = f.context;
  const base = plane(2000, 'base');
  const live = {
    originalImageData: plane(1500, 'rotated'), croppedImageData: plane(1000, 'crop'),
    conversionSourceImageData: plane(1000, 'source'), processedImageData: plane(1000, 'processed')
  };
  Object.assign(f.state, { loadedBaseImageData: base, ...live });
  // Undo: a rotation (the frame before it), a slider step on the planes on
  // screen, then a dust-brush stroke, which cannot go cold.
  const beforeRotation = { originalImageData: plane(1500, 'unrotated'), croppedImageData: plane(1000, 'unrotated crop') };
  const stroke = { label: 'dustBrushStroke', pushed: 3, dustDelta: { target: plane(400, 'repaired'), bytes: new Uint8Array(100) } };
  c.undoStack.push({ label: 'rotation', pushed: 1, refs: beforeRotation }, { label: 'exposure', pushed: 2, refs: { ...live } }, stroke);
  const snapshotBytes = 1500 + 1000 + 1000 + 1000 + 1500 + 1000;
  const before = c.hiddenResidentBytes();
  assert.equal(before, 2000 + snapshotBytes + 500);
  w.setHidden(true);
  await f.clock.advance(HIDDEN_GRACE_MS);
  // The tile job of photo 1: 9500 + 3000 do not fit 10 000, even after the
  // shed. The held item parks the open photo: 2500 + 3000 do.
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.ok(c.parkedPhoto, 'the held item parked the open photo');
  assert.equal(c.hiddenResidentBytes(), before - snapshotBytes, 'parking frees what the history pinned, not only the state');
  assert.deepEqual(JSON.parse(JSON.stringify(c.undoStack.map(entry => (entry.dustDelta ? 'stroke' : entry.refs)))),
    [{ cold: true }, { cold: true }, 'stroke'], 'every step is kept, as scalars where it can be');
  assert.equal(c.undoStack[2], stroke, 'the stroke as it was');
  assert.deepEqual(c.parkedPhoto.undo, c.undoStack, 'the parked history is the same');
  assert.deepEqual(w.events, ['shed', 'paused', 'resumed'], 'held, then admitted once the photo was parked');
  assert.deepEqual(f.started(), ['1.dng']);
}

// --- a switch keeps the decode a lane step drops while the switch paints (R1-061) -----------
// main.js's switchToFile and loadFile beside the lanes, with the editor
// stubbed (other lower-case names are no-ops, as in photoActivation.test.mjs).
// `opens` counts the foreground's LibRaw decodes, `reads` its file reads.
function switchHarness(f) {
  const c = f.context;
  const paints = [];
  const opens = [];
  const reads = [];
  const errors = [];
  for (const item of f.items) item.file.arrayBuffer = async () => { reads.push(item.file.name); return new ArrayBuffer(8); };
  f.state.autoFrame = { enabled: false };
  const target = {
    loadGeneration: 0, photoActivation: null, rewarmAutoFrameWorker: false, corePreviewRetained: null, corePreviewCommit: null,
    studioWorkspace: null, lensMapCache: new Map(), webglState: { gl: null }, DEFAULT_FILM_BASE: { r: 1, g: 1, b: 1 },
    quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
    i18n: { en: {} }, currentLang: 'en',
    convertPreviewFrameInWorker: { warmUp: async () => true },
    deferFileListRefresh: () => () => {},
    yieldToPaint: () => {
      const paint = deferred();
      paints.push(paint);
      return paint.promise;
    },
    invalidatePhotoActivation() {},
    readStoredDisplaySession: async () => null,
    rawDecodePlan: async () => ({ stages: 1 }),
    loadRawImageData: (buffer, name, options) => {
      const decode = deferred();
      opens.push({ name, ...decode });
      options.signal?.addEventListener('abort', () => decode.reject(options.signal.reason), { once: true });
      return decode.promise;
    },
    prepareStudioPhoto: async () => {},
    console: { error: (...args) => errors.push(args), warn() {}, info() {} }
  };
  const b = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in c) return c[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    },
    set(t, key, value) {
      if (!(key in t) && key in c) c[key] = value;
      else t[key] = value;
      return true;
    }
  }));
  vm.runInContext(['supersedeActivation', 'beginActivation', 'isCurrentLoad', 'adoptSharedDecode', 'sharedDecodeInFlight',
    'switchToFile', 'loadFile'].map(functionSource).join('\n'), b);
  return { b, paints, opens, reads, errors };
}

// The lane holds photo 1's decode while it renders the tile; the user opens
// photo 1, and the render lands while the switch paints.
{
  const f = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  f.items[1].thumbnail = null;
  const s = switchHarness(f);
  const c = f.context;
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1, { lensModel: 'Summilux' });
  assert.equal(f.renderOf(1).length, 1, 'the lane renders the tile from its decode');
  const switching = s.b.switchToFile(1);
  assert.equal(s.paints.length, 1, 'the switch paints its target first');
  await f.finishRender(1);
  assert.equal(c.backgroundLanes.active.size, 0, 'the lane\'s job ended and let go of the decode');
  assert.equal(f.published.length, 0, 'without a tile for the photo being opened');
  s.paints[0].resolve();
  await f.clock.advance(250);
  assert.deepEqual({ opens: s.opens.length, reads: s.reads.length }, { opens: 0, reads: 0 }, 'the foreground neither reads nor decodes the file');
  assert.equal(f.decodeOf(1).length, 1, 'one LibRaw open for the file');
  assert.equal((await switching), undefined);
  assert.equal(f.state.loadedFile, f.items[1].file);
  assert.equal(f.state.loadedBaseImageData.id, 1, 'the switch adopted the lane\'s base');
  assert.deepEqual({ ...f.state.rawMetadata }, { lensModel: 'Summilux' }, 'with its metadata');
  assert.equal(c.sharedDecodes.size, 0, 'no lease is left');
  assert.deepEqual(s.errors, []);
}

// The lane's decode itself lands while the switch paints.
{
  const f = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  f.items[1].thumbnail = null;
  const s = switchHarness(f);
  const c = f.context;
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  const switching = s.b.switchToFile(1);
  await f.finishDecode(1);
  assert.equal(c.backgroundLanes.active.size, 0, 'the lane\'s job ended with its decode: the photo is being opened');
  s.paints[0].resolve();
  await f.clock.advance(250);
  assert.deepEqual({ opens: s.opens.length, reads: s.reads.length }, { opens: 0, reads: 0 });
  assert.equal(f.decodeOf(1).length, 1, 'one LibRaw open for the file');
  await switching;
  assert.equal(f.state.loadedBaseImageData.id, 1, 'adopted');
  assert.equal(c.sharedDecodes.size, 0);
}

// A switch superseded before its load lets go of its lease: once the lane is
// done, nothing pins the decode.
{
  const f = createLaneFixture({ count: 3, current: 0, tilesDone: true });
  f.items[1].thumbnail = null;
  const s = switchHarness(f);
  const c = f.context;
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  await f.finishDecode(1);
  const first = s.b.switchToFile(1);
  // Its lease holds the finished decode (an abort only ends a waiting one).
  await flush();
  const second = s.b.switchToFile(2);
  s.paints[0].resolve();
  await flush();
  await first;
  assert.equal(c.sharedDecodes.size, 1, 'the lane still holds its decode');
  await f.finishRender(1);
  await f.clock.advance(5000);
  assert.equal(c.backgroundLanes.active.size, 0, 'the lane is done with photo 1');
  assert.equal(c.sharedDecodes.size, 0, 'and the superseded switch holds nothing');
  // The second switch decodes its own photo.
  s.paints[1].resolve();
  await f.clock.advance(250);
  assert.equal(s.opens.length, 1);
  s.opens[0].resolve({ id: 2, width: 4, height: 4, data: new Uint8ClampedArray(64) });
  await second;
  assert.equal(f.state.loadedBaseImageData.id, 2);
  assert.deepEqual(s.errors, []);
}

console.log('hiddenHandOver tests passed');
