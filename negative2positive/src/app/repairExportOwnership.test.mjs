import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

function fixture({ enabled = false, mask = null } = {}) {
  const clean = image(), repaired = image();
  const state = {
    originalImageData: image(), conversionSourceImageData: image(),
    processedImageData: clean, processedImageDataIsPreview: false,
    currentStep: 3, lastRenderQuality: 'full',
    repairStrokes: [{ size: .02, points: [{ x: .5, y: .5 }] }],
    dustRemoval: { enabled, mask, cleanSource: clean, inpaintedImageData: null,
      processing: false, strength: 3, particleCount: 0, _state: null },
  };
  const commits = [], manualCalls = [], observers = [], timers = new Map(), backgroundRuns = [];
  let timerId = 0;
  const c = vm.createContext({
    state, coreReprocessToken: 7, dustDetectionRevision: 11, loadGeneration: 3,
    dustDetectionTimer: null, Uint8Array,
    console: { error: (...args) => assert.fail(`Unexpected background error: ${args.join(' ')}`) },
    ensureFullResolutionReadyForExport: async () => {},
    aiRepairReady: () => true,
    inpaintForCommit: async input => input,
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
    isDisplayImageDataFullResolution: () => true,
    isWebGLActive: () => false,
    ensureFullRender: () => assert.fail('Fixture already has a full-resolution display'),
    getCurrentExportImageData: async () => state.processedImageData,
    setTimeout(callback, delay) {
      assert.equal(delay, 300, 'Use the real detection debounce');
      timers.set(++timerId, callback); return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(['getDustSource', 'hasFrameRepairs', 'isCurrentLoad',
    'applyDustResultToState', 'runDustDetection', 'scheduleDustDetection',
    'renderCurrentImageDataForExport'].map(functionSource).join('\n'), c);
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
  return { c, state, clean, repaired, commits, manualCalls, timers, startExport, startScheduledDetection };
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
  ['enabled dust mask', true, f => { f.state.dustRemoval.mask = new Uint8Array(16); }],
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

console.log('repairExportOwnership: scheduled manual-only zero-mask refresh is safe in both completion orders; genuine source/token/stroke/dust-mask/mode changes reject without stale commits');
