import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createSemanticAnalyzer, SEMANTIC_MODEL_URL } from './semanticModel.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';
const bytes = readFileSync(new URL('../assets/models/efficientvit-b1-ade20k.onnx', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '904544216395cf81b583771c9ca107994b388dc379fc3beabeaf57cd1e76d3f9');
assert.match(readFileSync(new URL('../../public/models/EfficientViT-LICENSE.txt', import.meta.url), 'utf8'), /Apache License/);
assert.ok(bytes.includes(Buffer.from('image')) && bytes.includes(Buffer.from('logits')));
// Under Node the literal new URL() resolves to the file Vite fingerprints into /assets.
assert.equal(SEMANTIC_MODEL_URL, new URL('../assets/models/efficientvit-b1-ade20k.onnx', import.meta.url).href);
console.log('semantic model hash, licence and named contract passed');
const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
// Lets queued tasks (and a model load) run up to their worker creation.
const flush = () => new Promise(resolve => setImmediate(resolve));
const model = { kind: 'session model copy' };
const workers = [];
const analyze = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => model, workerFactory: () => {
  const worker = { postMessage(message) { this.message = message; }, terminate() { this.terminated = true; } };
  workers.push(worker); return worker;
} });
const first = analyze(image);
let current = true;
const stale = analyze(image, { isCurrent: () => current });
const latest = analyze(image);
await flush();
assert.equal(workers.length, 1, 'only one ONNX heap can be active');
current = false;
workers[0].onmessage({ data: { labels: [1] } });
assert.deepEqual(await first, { labels: [1] });
assert.equal(await stale, null);
await flush();
assert.equal(workers.length, 2, 'stale queued preview never creates or downloads a model');
assert.equal(workers[0].terminated, true);
workers[1].onmessage({ data: { labels: [2] } });
assert.deepEqual(await latest, { labels: [2] });
const timed = analyze(image, { timeoutMs: 5 });
assert.equal(await timed, null);
assert.equal(workers[2].terminated, true);
const invalid = analyze(image);
await flush();
workers[3].onmessageerror();
assert.equal(await invalid, null);
assert.equal(workers[3].terminated, true);
let failedWorker;
const broken = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => model, workerFactory: () => failedWorker = {
  postMessage() { throw new Error('post failed'); }, terminate() { this.terminated = true; }
} });
assert.equal(await broken(image), null);
assert.equal(failedWorker.terminated, true);
// Leaving the photo is for good (`isWanted`, polled): the worker ends at the
// next tick instead of when the run ends.
let stillCurrent = true;
const leftMidRun = analyze(image, { isWanted: () => stillCurrent, pollMs: 5 });
await Promise.resolve();
const running = workers.at(-1);
assert.ok(running.message, 'the inference was started');
stillCurrent = false;
assert.equal(await leftMidRun, null, 'leaving the photo mid-inference resolves without an answer');
assert.equal(running.terminated, true, 'and terminates the model worker without waiting for the run');
running.onmessage?.({ data: { labels: [9] } });
// A passing state (`isCurrent` false for a few ticks, as with crop mode
// opened and cancelled) is checked when the task starts, never polled: the
// run goes on and answers (R1-037).
{
  let passing = true;
  const passed = analyze(image, { isCurrent: () => passing, pollMs: 5 });
  await flush();
  const worker = workers.at(-1);
  assert.ok(worker.message && !worker.terminated, 'the inference was started');
  passing = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(worker.terminated, undefined, 'six poll ticks of a passing state do not end it');
  passing = true;
  worker.onmessage({ data: { labels: [4] } });
  assert.deepEqual(await passed, { labels: [4] }, 'the answer comes back');
}
console.log('Semantic queue skips stale photos and releases workers on all failure paths');

// The model is loaded once per page session and posted to every short-lived
// worker; each worker still ends with its photo.
assert.equal(analyze.modelLoads(), 1, 'six photos, one model load');
assert.ok(workers.every(worker => worker.message.model === model), 'every worker gets the page copy, not a fetch');
assert.ok(workers.every(worker => worker.message.modelUrl === '/model.onnx'), 'the URL stays as the worker fallback');
assert.ok(workers.every(worker => worker.terminated), 'no persistent semantic session');
{
  // A failed load is not memoised: that photo's worker falls back to fetching,
  // and the next photo tries the page copy again.
  let attempts = 0;
  const posted = [];
  const retrying = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => {
    if (++attempts === 1) throw new Error('offline');
    return model;
  }, workerFactory: () => {
    const worker = { postMessage(message) { posted.push(message); this.onmessage({ data: { labels: [attempts] } }); }, terminate() {} };
    return worker;
  } });
  assert.deepEqual(await retrying(image), { labels: [1] });
  assert.equal(posted[0].model, null, 'no page copy: the worker fetches modelUrl itself');
  assert.deepEqual(await retrying(image), { labels: [2] });
  assert.equal(posted[1].model, model);
  await retrying(image);
  assert.equal(attempts, 2, 'a loaded model is reused');
  assert.equal(retrying.modelLoads(), 2);
}
{
  // Leaving the photo during the first (slow) model download starts no worker;
  // the model is still kept for the next photo.
  let release;
  let created = 0;
  let stillCurrent = true;
  const slow = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: () => new Promise(resolve => { release = resolve; }),
    workerFactory: () => { created++; return { postMessage() { this.onmessage({ data: { labels: [3] } }); }, terminate() {} }; } });
  const left = slow(image, { isWanted: () => stillCurrent });
  await flush();
  stillCurrent = false;
  release(model);
  assert.equal(await left, null);
  assert.equal(created, 0, 'a photo left during the model download creates no worker');
  assert.deepEqual(await slow(image), { labels: [3] });
  assert.equal(slow.modelLoads(), 1);
}
console.log('Semantic model loads once per page session and reaches each worker by postMessage');

// R1-037: main.js's scheduleSemanticColour with this analyzer (a stub worker,
// a 5 ms poll). Crop mode opened during the inference and cancelled before
// its answer is a passing state: as at 1703835, which checked only before
// and after the inference, the map is applied. What stays false once false
// (an edit) still ends the worker at the next tick, and a passing state at
// the answer still drops it.
{
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const functionSource = name => {
    const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(match, `${name} exists`);
    return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
  };
  const answer = { width: 2, height: 2, labels: [0, 0, 1, 1], confidence: 0.9 };
  const pass = () => {
    const item = { id: 1 };
    const workers = [];
    const analyzer = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => model, workerFactory: () => {
      const worker = { postMessage(message) { this.message = message; }, terminate() { this.terminated = true; } };
      workers.push(worker);
      return worker;
    } });
    const state = {
      filmType: 'color', positiveMode: 'correct', expiredEnabled: false, cropping: false, wbUserOverride: false, grayPointSampled: false,
      rollReference: { applyLock: false }, filmBase: { method: 'auto' }, wbR: 1, wbG: 1, wbB: 1, wbSemanticApplied: false,
      processedImageData: { width: 8, height: 8, data: new Uint8ClampedArray(256) }, conversionSourceImageData: null, autoWbSample: null
    };
    const context = vm.createContext({
      ...displaySessionStubs(),
      state, console, setTimeout, manualEditRevision: 0, studioAutoFrameRunning: false, automaticRollImportRunning: false,
      semanticColourInFlight: 0, automaticRollPendingItems: new Set(),
      isCurrentLoad: () => true, getCurrentQueueItem: () => item,
      downsampleImageDataForMaxDim: image => image,
      analyzeSemanticPreview: (image, options) => analyzer(image, { ...options, pollMs: 5 }),
      sanitizeSemanticMap,
      estimateAutoWhiteBalance: (image, { anchors }) => ({ anchored: Boolean(anchors), confidence: 'high', wbR: 1.25, wbG: 1, wbB: 0.8 }),
      pushUndo() {}, updateWBSliders() {}, updateGrayPointGuideUI() {}, markCurrentFileDirty() {},
      persistCurrentFileSettings() {}, schedulePreviewUpdate() {}
    });
    vm.runInContext([...DISPLAY_SESSION_HELPERS, 'autoWbSampleFor', 'scheduleSemanticColour'].map(functionSource).join('\n'), context);
    context.scheduleSemanticColour(item, 1);
    return { context, state, workers };
  };
  const started = async run => {
    await new Promise(resolve => setTimeout(resolve, 5));
    await flush();
    assert.equal(run.workers.length, 1, 'the inference started');
    return run.workers[0];
  };
  const ticks = () => new Promise(resolve => setTimeout(resolve, 30));
  const wb = state => [state.wbR, state.wbG, state.wbB];

  const cancelled = pass();
  const worker = await started(cancelled);
  cancelled.state.cropping = true;
  await ticks();
  assert.equal(worker.terminated, undefined, 'crop mode open over several poll ticks does not end the inference');
  cancelled.state.cropping = false;
  worker.onmessage({ data: answer });
  await flush();
  assert.equal(cancelled.state.wbSemanticApplied, true, 'crop opened and cancelled during the inference: the map is applied');
  assert.deepEqual(wb(cancelled.state), [1.25, 1, 0.8]);

  const edited = pass();
  const editedWorker = await started(edited);
  edited.context.manualEditRevision++;
  await ticks();
  assert.equal(editedWorker.terminated, true, 'an edit mid-inference ends the worker at the next tick');
  assert.equal(edited.state.wbSemanticApplied, false);

  const open = pass();
  const openWorker = await started(open);
  open.state.cropping = true;
  openWorker.onmessage({ data: answer });
  await flush();
  assert.equal(open.state.wbSemanticApplied, false, 'crop mode still open at the answer drops it, as before');
  assert.deepEqual(wb(open.state), [1, 1, 1]);
}
console.log('Semantic colour polls only what stays false: crop mode opened and cancelled mid-inference keeps the map; an edit ends the worker');
