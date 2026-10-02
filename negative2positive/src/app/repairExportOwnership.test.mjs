import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRepairStamps, captureDustPass, dustPassMatches, restoreDustPass } from './repairReuse.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

// Execute real export/detection ownership, with deferred inference and a
// manually advanced debounce. No wall-clock sleeps or duplicated guards.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists`);
  const end = source.indexOf('\n    }', start);
  assert.ok(end > start, `${name} closes at module indentation`);
  return source.slice(start, end + '\n    }'.length);
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const noop = () => {};
const image = () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) });

function fixture({ enabled = false, mask = null, model = null } = {}) {
  const clean = image(), repaired = image();
  const state = {
    originalImageData: image(), conversionSourceImageData: image(),
    processedImageData: clean, processedImageDataIsPreview: false,
    currentStep: 3,
    repairStrokes: [{ size: .02, points: [{ x: .5, y: .5 }] }],
    dustRemoval: { enabled, mask, cleanSource: clean, inpaintedImageData: null,
      processing: false, strength: 3, particleCount: 0, _state: null, revision: 0, maskTag: null },
  };
  const commits = [], manualCalls = [], observers = [], timers = new Map(), backgroundRuns = [], exportReads = [];
  const dustPasses = [], loadRequests = [];
  let timerId = 0;
  const c = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    // #254 stand-ins: the live dodge frame note, the dust tint, the overlays.
    noteLiveFrame: () => {}, adoptDustTint: () => {}, patchDustTint: () => {}, displayOverlaySize: () => null,
    syncBrushTools: () => {}, cancelDustBrush: () => {},
    brushFeedback: { drawing: false, end: () => {}, cancel: () => {}, sync: () => {} }, remapBrushStroke: () => {},
    liveDisplaySerial: 0,
    state, coreReprocessToken: 7, dustDetectionRevision: 11, loadGeneration: 3,
    dustDetectionTimer: null, Uint8Array, dustMaskTagSequence: 0, dustAiRefresh: { rects: [] },
    // No undo or redo restored a dust state here (#259).
    restoredDust: null,
    syncDustWorkerPin: noop,
    aiRepair: model || { status: 'ready', revision: 5 }, repairStamps: createRepairStamps(), dustPassCache: null,
    aiRepairLoadWatcher: null, DEFAULT_MODEL_URL: '/m.onnx',
    getInterpolatedText: (key, values, fallback) => fallback,
    // A case with a `model` loads it through here (#236/#241 released it).
    loadAiRepairModel: async (...args) => { loadRequests.push(args); },
    dustMaskInfo: () => null, captureDustPass, dustPassMatches, restoreDustPass,
    assertRepairCurrent(isCurrent) { if (!isCurrent()) throw new DOMException('Repair superseded', 'AbortError'); },
    console: { error: (...args) => assert.fail(`Unexpected background error: ${args.join(' ')}`) },
    ensureFullResolutionReadyForExport: async () => {}, flushScheduledCoreReprocess: async () => {},
    // The export's repair barrier has its own test (fullResolutionRouting.main.test.mjs):
    // here export and detection deliberately overlap.
    ensureRepairsReadyForExport: async () => {},
    dustDetectionRun: null, dustMaskSources: new WeakMap(), rememberRepairMasks: noop,
    // A case with a `model` runs the real aiRepairReady on it.
    ...(model ? {} : { aiRepairReady: () => true }),
    inpaintForCommit: async (input, passMask) => {
      dustPasses.push(passMask);
      // Brushes patch the mask in place: the pass must read its own copy.
      if (state.dustRemoval.mask) assert.notEqual(passMask, state.dustRemoval.mask);
      if (passMask) assert.deepEqual(passMask, state.dustRemoval.mask);
      return input;
    },
    inpaintManualBrush(input, ...args) {
      const gate = deferred(), call = { ...gate, input, args };
      manualCalls.push(call);
      assert.ok(observers.length, 'Every inference call must be explicitly expected');
      observers.shift()(call);
      return gate.promise;
    },
    dustMaxParticleSizeFor: () => 40,
    detectDustOffMainThread: () => assert.fail('Manual-only detection must not run automatic dust detection'),
    updateDustStatusUI: noop, cancelFullUpdate: noop, updatePreview: noop,
    getLocalizedText: (key, fallback) => fallback,
    applyProcessedImageToState(next) { commits.push(next); state.processedImageData = next; },
    isWebGLActive: () => false,
    // Export always adjusts through getCurrentExportImageData (the export
    // worker); no display buffer is rendered or reused for it (#242).
    getCurrentExportImageData: async (options) => { exportReads.push(options); return state.processedImageData; },
    setTimeout(callback, delay) {
      assert.equal(delay, 300, 'Use the real detection debounce');
      timers.set(++timerId, callback); return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'getDustSource', 'nextDustMaskTag', 'noteDustReplaced', 'hasFrameRepairs', 'isCurrentLoad',
    'currentRepairRecipe', 'stampRepairResult', 'commitDustPass', 'dustPassUsesAi',
    'applyDustResultToState', 'runDustDetection', 'runDustDetectionPass', 'keepRestoredDust', 'restoredDustInputsHold', 'scheduleDustDetection',
    'prepareCurrentImageForExport', 'renderCurrentImageDataForExport', 'dustMaskHasPixels', 'loadAiRepairForExport',
    'settleAiRepairModel', 'aiRepairLoadArgs', ...(model ? ['aiRepairReady'] : [])].map(functionSource).join('\n'), c);
  const actualRunDustDetection = c.runDustDetection;
  c.runDustDetection = () => {
    const pending = actualRunDustDetection(); backgroundRuns.push(pending); return pending;
  };
  const nextInference = () => new Promise(resolve => observers.push(resolve));
  const startExport = async () => {
    const started = nextInference();
    const completion = c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 })
      .then(value => ({ value }), error => ({ error }));
    return { call: await started, completion };
  };
  const startScheduledDetection = async () => {
    const started = nextInference();
    c.scheduleDustDetection();
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback();
    return { call: await started, completion: backgroundRuns.at(-1) };
  };
  return { c, state, clean, repaired, commits, manualCalls, timers, exportReads, dustPasses, loadRequests, startExport, startScheduledDetection };
}

// A manual brush schedules detection even with automatic dust removal off.
// Its fresh zero mask is irrelevant to the export recipe, in either completion
// order. Both computations receive the same immutable full-resolution source.
for (const mask of [null, new Uint8Array(16)]) {
  for (const finishBackgroundFirst of [false, true]) {
    const f = fixture({ mask });
    const exporting = await f.startExport();
    const background = await f.startScheduledDetection();
    assert.notEqual(f.state.dustRemoval.mask, mask, 'Actual detection replaced the mask during export inference');
    assert.deepEqual([...f.state.dustRemoval.mask], Array(16).fill(0));
    assert.equal(exporting.call.input, f.clean);
    assert.equal(background.call.input, f.clean);
    assert.equal(f.c.coreReprocessToken, 7);
    if (finishBackgroundFirst) {
      background.call.resolve(f.repaired); await background.completion;
    }
    exporting.call.resolve(f.repaired);
    const outcome = await exporting.completion;
    assert.ifError(outcome.error);
    assert.equal(outcome.value, f.repaired, 'Export commits the completed repair, not its temporary preview');
    assert.deepEqual(f.exportReads.map(options => options.bitDepth), [8], 'the export pixels come from getCurrentExportImageData');
    if (!finishBackgroundFirst) {
      background.call.resolve(f.repaired); await background.completion;
    }
    assert.equal(f.state.processedImageData, f.repaired);
    assert.equal(f.state.dustRemoval.processing, false);
    assert.equal(f.commits.length, 2, 'Both same-recipe completions are safe');
    assert.equal(f.timers.size, 0);
  }
}

// Removing the false positive must not weaken any actual ownership boundary.
const mutations = [
  ['source', false, f => { f.state.dustRemoval.cleanSource = image(); }],
  ['conversion token', false, f => { f.c.coreReprocessToken++; }],
  ['manual strokes', false, f => { f.state.repairStrokes = [...f.state.repairStrokes]; }],
  // Masks change through noteDustReplaced or an in-place brush patch; both
  // advance the dust revision, which export compares instead of identity (#259).
  ['enabled dust mask', true, f => { f.state.dustRemoval.mask = new Uint8Array(16); f.c.noteDustReplaced(); }],
  ['brush patch in place', true, f => { f.state.dustRemoval.mask[3] = 255; f.state.dustRemoval.revision++; }],
  ['enable automatic dust', false, f => { f.state.dustRemoval.enabled = true; }],
  ['disable automatic dust', true, f => { f.state.dustRemoval.enabled = false; }],
];
for (const [label, enabled, mutate] of mutations) {
  const f = fixture({ enabled, mask: new Uint8Array(16) });
  const exporting = await f.startExport();
  mutate(f);
  exporting.call.resolve(f.repaired);
  const outcome = await exporting.completion;
  assert.match(outcome.error?.message || '', /Photo changed during AI repair/, label);
  assert.equal(outcome.value, undefined, `${label}: stale export does not escape`);
  assert.equal(f.commits.length, 0, `${label}: stale repair never commits`);
  assert.equal(f.state.dustRemoval.inpaintedImageData, null, `${label}: state is not stamped with stale repair`);
}

// AI repair on with its model released by #236's idle rule or #241's hidden
// window (status 'idle', no run): the real aiRepairReady says no, yet the
// model is still the repair's inpainter. A dust-brush stroke left the repair
// patched in place and unstamped (#259), so the export loads the released
// model on its provider, shows the load, and repairs from scratch over its
// own copy of the mask; it never encodes the patched image.
const releasedModel = () => ({ status: 'idle', released: true, run: null, revision: 5, provider: 'wasm',
  prefer: 'wasm', sourceRef: '/m.onnx', error: '', percent: 0 });
function releasedFixture() {
  const mask = new Uint8Array(16);
  mask[5] = 255;
  const f = fixture({ enabled: true, mask, model: releasedModel() });
  f.state.dustRemoval.ai = true;
  f.state.repairStrokes = [];
  const patched = image();
  f.state.dustRemoval.inpaintedImageData = f.state.processedImageData = patched;
  return { f, patched };
}
{
  const { f, patched } = releasedFixture();
  assert.equal(f.c.aiRepairReady(), false, 'the real check: a released model is not ready');
  f.c.loadAiRepairModel = async (...args) => {
    f.loadRequests.push(args);
    Object.assign(f.c.aiRepair, { status: 'ready', run() {}, released: false });
  };
  const progress = [];
  const started = new Promise(resolve => { f.c.inpaintManualBrush = (input) => { resolve(input); return Promise.resolve(f.repaired); }; });
  const value = await f.c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 }, { onModelLoad: percent => progress.push(percent) });
  assert.equal(JSON.stringify(f.loadRequests), JSON.stringify([['/m.onnx', { refresh: false, prefer: 'wasm' }]]), 'the released model, on its provider');
  assert.deepEqual(progress, [0, null], 'the load shows on the export overlay');
  assert.equal(f.dustPasses.length, 1, 'a from-scratch dust pass');
  assert.notEqual(f.dustPasses[0], f.state.dustRemoval.mask, 'over a copy of the mask');
  assert.deepEqual([...f.dustPasses[0]], [...f.state.dustRemoval.mask]);
  assert.equal(await started, f.clean, 'the stroke pass takes the dust pass result');
  assert.equal(value, f.repaired, 'the export encodes the from-scratch repair');
  assert.notEqual(value, patched, 'not the stroke-patched image');
  assert.equal(f.state.dustRemoval.inpaintedImageData, f.repaired);
  assert.equal(f.c.repairStamps.recipeOf(f.repaired)?.revision, 5, 'stamped under the revision it ran with');
}

// Offline without a cached model the load fails: the export stops with a
// clear error before any pass, and nothing (no TELEA stand-in) is committed.
{
  const { f, patched } = releasedFixture();
  f.c.loadAiRepairModel = async (...args) => {
    f.loadRequests.push(args);
    Object.assign(f.c.aiRepair, { status: 'error', error: 'Failed to fetch', released: false });
  };
  f.c.inpaintManualBrush = () => assert.fail('no stroke pass without the model');
  await assert.rejects(f.c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 }),
    /AI repair model could not be loaded \(Failed to fetch\), so nothing was exported/);
  assert.equal(f.loadRequests.length, 1);
  assert.equal(f.dustPasses.length, 0, 'no TELEA pass in its place');
  assert.deepEqual([f.commits.length, f.exportReads.length], [0, 0], 'nothing committed or encoded');
  assert.equal(f.state.dustRemoval.inpaintedImageData, patched);
}

// A clean frame (a dust mask with nothing set) needs no pass: a released
// model is not loaded for it, and the frame on screen is exported.
{
  const { f, patched } = releasedFixture();
  f.state.dustRemoval.mask.fill(0);
  const value = await f.c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 });
  assert.deepEqual([f.loadRequests.length, f.dustPasses.length], [0, 0], 'no load and no pass');
  assert.equal(value, patched);
  // The scan reads 32-bit words where the view allows, and the bytes after them.
  const bytes = new Uint8Array(23);
  for (const [offset, length, set] of [[0, 23, 22], [1, 21, 21], [3, 9, 4], [4, 16, null]]) {
    bytes.fill(0);
    if (set !== null) bytes[set] = 1;
    assert.equal(f.c.dustMaskHasPixels(new Uint8Array(bytes.buffer, offset, length)), set !== null, `mask view ${offset}+${length}`);
  }
}

// A model that had failed before the export (status 'error', TELEA on
// screen) is not loaded for the dust: TELEA is that repair, run from scratch
// over a copy of the mask instead of encoding the patched image.
{
  const { f, patched } = releasedFixture();
  Object.assign(f.c.aiRepair, { status: 'error', released: false, error: 'bad model' });
  f.c.inpaintManualBrush = (input) => Promise.resolve(input === f.clean ? f.repaired : null);
  const value = await f.c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 });
  assert.equal(f.loadRequests.length, 0, 'no load for the dust');
  assert.equal(f.dustPasses.length, 1, 'a from-scratch pass');
  assert.equal(value, f.repaired);
  assert.notEqual(value, patched);
}

console.log('repairExportOwnership: scheduled manual-only zero-mask refresh is safe in both completion orders; genuine source/token/stroke/dust-mask/mode changes reject without stale commits; a released model is loaded again and repairs from scratch, or the export fails clearly; a failed model repairs with TELEA from scratch');
