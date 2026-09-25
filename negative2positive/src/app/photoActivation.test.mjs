// Latest-wins photo activations (#243), with the real loadFile,
// invalidatePhotoActivation, beginActivation and convertFrameOffMainThread
// from main.js in a vm context (other helpers are no-ops):
// - a load runs under its activation's signal, and the next activation
//   aborts it: the superseded load ends 'stale', logs no error and marks
//   nothing;
// - loadFile adopts a background lane's decode instead of reading the file;
// - invalidatePhotoActivation aborts the full-resolution render's request
//   and asks the next cold load to warm a released detection worker;
// - WORKER_ABORTED never retires the conversion worker or reruns on the
//   main thread.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSharedDecodes } from './sharedDecodes.js';
import { WORKER_ABORTED, WORKER_CRASHED } from './conversionWorkerClient.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  const errors = [], toasts = [], rawLoads = [], reads = [], warmUps = [];
  const state = {
    fileQueue: [], currentFileIndex: 0, loadedFile: null, autoFrame: { enabled: true }, dustRemoval: {},
    cropping: false, beforeAfterActive: false, filmBase: {}, lensCorrection: {}
  };
  const target = {
    state, loadGeneration: 0, photoActivation: null, rewarmAutoFrameWorker: false, importDetectionAbort: null,
    fullResolutionRenderAbort: null, parkedPhoto: null, pendingImportRotation: null,
    coreReprocessGeneration: 0, coreReprocessToken: 0, _coreReprocessPending: null, processNegativeInFlight: null,
    conversionWorkerBroken: false, conversionWorkerTimeouts: 0, WORKER_ABORTED, CONVERSION_FAILED: 'CONVERSION_FAILED',
    WORKER_TIMEOUT: 'WORKER_TIMEOUT', AbortController, DOMException, Promise, Map, Set, JSON, Boolean,
    dustAiRefresh: { rects: [], timer: null },
    document: { body: { dataset: {} }, getElementById: () => null },
    console: { error: (...args) => errors.push(args), warn() {}, info() {} },
    i18n: { en: { processing: 'Processing' } }, currentLang: 'en',
    quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
    studioWorkspace: { sync() {} }, lensMapCache: new Map(), webglState: { gl: null },
    DEFAULT_FILM_BASE: { r: 1, g: 1, b: 1 },
    showToast: message => toasts.push(message),
    getLocalizedText: (key, fallback) => fallback,
    isRawLikeFileName: name => /\.(dng|nef)$/.test(name), isTiffContainerRawName: () => false,
    isPngFile: () => false, lowMemoryPhotoDevice: () => false,
    analyzeFrameInWorker: { abortReleases: 0 },
    warmUpAutoFrameWorker: () => { warmUps.push(true); return Promise.resolve(true); },
    convertPreviewFrameInWorker: { warmUp: () => Promise.resolve(true) },
    defaultFilmBaseBuffer: () => 10,
    loadRawImageData: (buffer, name, options) => {
      const gate = deferred();
      rawLoads.push({ name, options, ...gate });
      options.signal?.addEventListener('abort', () => gate.reject(options.signal.reason), { once: true });
      return gate.promise;
    },
    usesSilverCoreConversion: () => true,
  };
  const context = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    }
  }));
  target.sharedDecodes = createSharedDecodes({ decode: () => deferred().promise });
  vm.runInContext(['supersedeActivation', 'beginActivation', 'invalidatePhotoActivation', 'isCurrentLoad', 'loadFile',
    'adoptSharedDecode', 'convertFrameOffMainThread', 'convertRequestOnMain'].map(functionSource).join('\n'), context);
  const file = name => ({ name, arrayBuffer: async () => { reads.push(name); return new ArrayBuffer(8); } });
  return { context, target, state, errors, toasts, rawLoads, reads, warmUps, file };
}

// Latest wins: the next load aborts the previous one's decode.
{
  const f = fixture();
  const a = f.file('a.dng'), b = f.file('b.dng');
  const first = f.context.loadFile(a, { autoConvert: false, quiet: true });
  await flush();
  assert.equal(f.rawLoads.length, 1);
  const firstSignal = f.rawLoads[0].options.signal;
  assert.ok(firstSignal && !firstSignal.aborted, 'the decode runs under the activation');
  const second = f.context.loadFile(b, { autoConvert: false, quiet: true });
  assert.equal(firstSignal.aborted, true, 'the next activation aborts it');
  assert.equal((await first).status, 'stale');
  assert.deepEqual(f.errors, [], 'a superseded load logs no error');
  assert.deepEqual(f.toasts, [], 'and shows nothing');
  await flush();
  assert.equal(f.rawLoads[1].options.signal.aborted, false);
  f.rawLoads[1].resolve(null);
  assert.equal((await second).status, 'error', 'a real failure is still an error');
}

// Aborted between the file read and the decode: the decoder never starts.
{
  const f = fixture();
  let readGate;
  const a = { name: 'a.dng', arrayBuffer: () => new Promise(resolve => { readGate = resolve; }) };
  const first = f.context.loadFile(a, { autoConvert: false, quiet: true });
  await flush();
  f.context.supersedeActivation();
  readGate(new ArrayBuffer(8));
  assert.equal((await first).status, 'stale');
  assert.equal(f.rawLoads.length, 0, 'no decode for a superseded read');
}

// A switch passes its own activation: loadFile does not begin another.
{
  const f = fixture();
  const signal = f.context.beginActivation(null);
  void f.context.loadFile(f.file('a.dng'), { autoConvert: false, quiet: true, signal });
  await flush();
  assert.equal(f.rawLoads[0].options.signal, signal);
  assert.equal(signal.aborted, false);
}

// Adoption: a lane's decode of the same file is awaited, with its rawMetadata;
// the file is not read again.
{
  const f = fixture();
  const lane = deferred();
  f.target.sharedDecodes = createSharedDecodes({ decode: () => lane.promise });
  const a = f.file('a.dng');
  const laneLease = f.target.sharedDecodes.open(a);
  const loading = f.context.loadFile(a, { autoConvert: false, quiet: true });
  await flush();
  assert.equal(f.reads.length, 0, 'no second read');
  assert.equal(f.rawLoads.length, 0, 'no second decode');
  const base = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  lane.resolve({ base, rawMetadata: { lensModel: 'Summilux' } });
  assert.equal((await loading).status, 'loaded');
  assert.equal(f.state.loadedBaseImageData, base, 'the lane\'s base');
  assert.equal(f.state.rawMetadata.lensModel, 'Summilux', 'with its lens metadata');
  laneLease.release();
  assert.equal(f.target.sharedDecodes.size, 0, 'both leases released');
}

// invalidatePhotoActivation: the full-resolution render's request is aborted,
// and a detection worker released by the abort is warmed by the next cold load.
{
  const f = fixture();
  const render = new AbortController();
  f.target.fullResolutionRenderAbort = render;
  const detection = new AbortController();
  detection.signal.addEventListener('abort', () => { f.target.analyzeFrameInWorker.abortReleases++; });
  f.target.importDetectionAbort = detection;
  f.context.invalidatePhotoActivation();
  assert.equal(render.signal.aborted, true, 'the render request is aborted');
  assert.equal(f.target.fullResolutionRenderAbort, null);
  assert.equal(f.target.rewarmAutoFrameWorker, true);
  void f.context.loadFile(f.file('a.dng'), { autoConvert: false, quiet: true });
  assert.equal(f.warmUps.length, 1, 'a switch-style load warms the released worker');
  assert.equal(f.target.rewarmAutoFrameWorker, false);
  void f.context.loadFile(f.file('b.dng'), { autoConvert: false, quiet: true });
  assert.equal(f.warmUps.length, 1, 'only once');
}

// WORKER_ABORTED: rethrown, never counted against the worker, never rerun on the main thread.
{
  const f = fixture();
  let mainThread = 0;
  f.target.convertFrameWithRouter = async () => { mainThread++; return { main: true }; };
  f.target.convertFrameInWorker = async () => { throw Object.assign(new Error('aborted'), { code: WORKER_ABORTED }); };
  await assert.rejects(f.context.convertFrameOffMainThread({ imageData: {}, settings: {}, options: {}, signal: new AbortController().signal }),
    { code: WORKER_ABORTED });
  assert.equal(mainThread, 0);
  assert.equal(f.target.conversionWorkerBroken, false);
  assert.equal(f.target.conversionWorkerTimeouts, 0);
  // A crash still falls back (unchanged).
  f.target.convertFrameInWorker = async () => { throw Object.assign(new Error('crash'), { code: WORKER_CRASHED }); };
  assert.deepEqual({ ...await f.context.convertFrameOffMainThread({ imageData: {}, settings: {}, options: {} }) }, { main: true });
  assert.equal(f.target.conversionWorkerBroken, true);
}

// Low-memory devices: an activation aborts the lanes' decodes, except the target's.
{
  const f = fixture();
  const aborted = [];
  f.target.lowMemoryPhotoDevice = () => true;
  f.target.abortBackgroundDecodes = options => aborted.push(options.except);
  const a = f.file('a.dng');
  f.context.beginActivation(a);
  assert.deepEqual(aborted, [a]);
  f.target.lowMemoryPhotoDevice = () => false;
  f.context.beginActivation(a);
  assert.equal(aborted.length, 1, 'desktop lets them finish');
}

console.log('photoActivation tests passed');
