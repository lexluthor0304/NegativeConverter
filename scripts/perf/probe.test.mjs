// Runs the in-page probe against stand-in browser objects: the wrappers must
// pass every call through unchanged, record what the harness needs, and never
// issue readPixels, getError or getImageData of their own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dragMetrics, pictures } from './lib/metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'probe.js'), 'utf8');

function createEnvironment({ invoke } = {}) {
  const calls = { readPixels: 0, getError: 0, getImageData: 0, texImage2D: 0, drawArrays: 0 };
  // As in browsers, WebGL2RenderingContext does not inherit from WebGLRenderingContext.
  const makeGl = () => class {
    constructor(id) { this.canvas = { id }; this.drawingBufferWidth = 1800; this.drawingBufferHeight = 1200; }
    activeTexture() {}
    bindTexture() {}
    useProgram() {}
    texImage2D(...args) { calls.texImage2D++; return args.length; }
    texSubImage2D() {}
    uniform1f() {}
    uniform4fv() {}
    uniformMatrix4fv() {}
    uniformBlockBinding() { return 'untouched'; }
    drawArrays() { calls.drawArrays++; return 'drawn'; }
    drawElements() {}
    readPixels() { calls.readPixels++; }
    getError() { calls.getError++; return 0; }
  };
  const FakeGl = makeGl();
  const FakeGl2 = makeGl();
  FakeGl2.prototype.drawArraysInstanced = function () {};
  class Fake2d {
    constructor(canvas) { this.canvas = canvas; }
    putImageData() { return 'put'; }
    drawImage() { return 'drew'; }
    getImageData() { calls.getImageData++; return null; }
  }
  const listeners = {};
  class FakeWorker {
    constructor(url, options) { this.url = url; this.options = options; this.listeners = []; this.posted = []; }
    postMessage(message) { this.posted.push(message); return 'posted'; }
    terminate() { this.terminated = true; }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    emit(data) { for (const listener of this.listeners) listener({ data }); }
  }
  class FakeBlob { constructor(parts = [], options = {}) { this.parts = parts; this.size = parts.reduce((n, p) => n + (p.length || p.byteLength || 0), 0); this.type = options.type || ''; } arrayBuffer() { return Promise.resolve(new ArrayBuffer(this.size)); } slice() { return new FakeBlob(); } stream() {} text() { return Promise.resolve(''); } }
  class FakeFile extends FakeBlob { constructor(parts, name, options) { super(parts, options); this.name = name; } }
  const observers = [];
  class FakePerformanceObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.options = options; }
    static supportedEntryTypes = ['longtask', 'measure', 'event'];
  }
  let rafQueue = [];
  const intervals = [];
  const body = { classList: { contains: () => false }, dataset: {} };
  const document = {
    readyState: 'complete', body,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => ({})
  };
  const blobUrls = new Map();
  const URLStub = { createObjectURL: blob => { const url = `blob:test/${blobUrls.size}`; blobUrls.set(url, blob); return url; }, revokeObjectURL: () => {} };
  class Anchor { click() { this.clicked = true; } }
  const global = {
    performance, WebGLRenderingContext: FakeGl, WebGL2RenderingContext: FakeGl2,
    CanvasRenderingContext2D: Fake2d, Worker: FakeWorker, Blob: FakeBlob, File: FakeFile,
    PerformanceObserver: FakePerformanceObserver, devicePixelRatio: 2,
    addEventListener: (type, listener, options) => { (listeners[type] ||= []).push({ listener, options }); }
  };
  if (invoke) global.__TAURI_INTERNALS__ = { invoke };
  const bindings = {
    document, requestAnimationFrame: callback => rafQueue.push(callback),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: id => { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
    setTimeout: () => 0, getComputedStyle: () => ({ opacity: '1', display: 'block' }),
    MutationObserver: undefined, PerformanceObserver: FakePerformanceObserver, OffscreenCanvas: undefined,
    URL: URLStub, HTMLAnchorElement: Anchor, location: { origin: 'http://127.0.0.1:1' }, fetch: () => Promise.reject(new Error('offline')),
    Worker: FakeWorker, Blob: FakeBlob, File: FakeFile, crypto: undefined, createImageBitmap: undefined, DataTransfer: undefined, Event: class {}
  };
  const names = Object.keys(bindings);
  // The probe ends with `(typeof globalThis !== 'undefined' ? globalThis : this)`;
  // shadow globalThis and the bare browser globals it reads.
  const install = new Function('globalThis', ...names, source);
  install(global, ...names.map(name => bindings[name]));
  return {
    global, calls, listeners, observers, FakeWorker, Fake2d, Anchor, URLStub, blobUrls,
    flushFrames(times) { for (const time of times) { const queue = rafQueue; rafQueue = []; queue.forEach(cb => cb(time)); } },
    intervals, FakeFile
  };
}

const env = createEnvironment();
const probe = env.global.__ncPerf;
assert.ok(probe, 'probe installs itself on the global object');
assert.equal(probe.version, 1);

// ---- WebGL: pass-through, uploads, draw signatures ----
const gl = new env.global.WebGLRenderingContext('glCanvas');
const pixels = new Uint8Array(1809 * 1202 * 4).map((_, i) => (i * 7) & 255);
gl.activeTexture(0x84C0);
gl.bindTexture(0x0DE1, { texture: 1 });
assert.equal(gl.texImage2D(0x0DE1, 0, 0x1908, 1809, 1202, 0, 0x1908, 0x1401, pixels), 9, 'return value passes through');
assert.equal(gl.drawArrays(5, 0, 4), 'drawn');
assert.equal(gl.drawArrays(5, 0, 4), 'drawn');
gl.uniform1f({ loc: 'exposure' }, 0.5);
gl.drawArrays(5, 0, 4);
assert.equal(gl.uniformBlockBinding(), 'untouched', 'non-uniform-value methods are not wrapped');
const gl2 = new env.global.WebGL2RenderingContext('webgl2Canvas');
gl2.bindTexture(0x0DE1, {});
gl2.texImage2D(0x0DE1, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, new Uint8Array(64));
gl2.drawArraysInstanced(5, 0, 4, 1);

let drained = probe.drain();
const uploads = drained.events.filter(event => event.k === 'gl.upload');
const draws = drained.events.filter(event => event.k === 'gl.draw');
assert.equal(uploads.length, 2);
assert.equal(uploads[0].c, 'glCanvas');
assert.equal(uploads[0].w, 1809);
assert.equal(uploads[0].format, 0x1908);
assert.equal(uploads[0].type, 0x1401);
assert.equal(uploads[0].hash, probe.hash(pixels));
assert.equal(uploads[1].ctx, 'webgl2', 'WebGL2 contexts are wrapped too');
assert.equal(draws.length, 4);
assert.equal(draws[0].sig, draws[1].sig, 'same state, same signature');
assert.notEqual(draws[1].sig, draws[2].sig, 'a uniform change is a new picture');
assert.ok(Number.isFinite(draws[2].ut), 'the uniform change time is recorded');
assert.equal(draws[3].ctx, 'webgl2');
assert.equal(env.calls.readPixels, 0, 'probe never reads pixels back');
assert.equal(env.calls.getError, 0, 'probe never calls getError');
gl.getError();
drained = probe.drain();
assert.equal(env.calls.getError, 1, 'the app’s own getError still runs once');
assert.equal(drained.events.filter(event => event.k === 'gl.sync').length, 1, 'and is counted');

// ---- 2D canvas ----
const ctx2d = new env.global.CanvasRenderingContext2D({ id: 'canvas', width: 900, height: 600 });
const image = { width: 900, height: 600, data: new Uint8ClampedArray(900 * 600 * 4).fill(9) };
assert.equal(ctx2d.putImageData(image, 0, 0), 'put');
assert.equal(ctx2d.drawImage({ width: 10, height: 10 }, 0, 0, 900, 600), 'drew');
drained = probe.drain();
const c2d = drained.events.filter(event => event.k === 'c2d');
assert.deepEqual(c2d.map(event => event.fn), ['putImageData', 'drawImage']);
assert.equal(c2d[0].hash, probe.hash(image.data));
assert.equal(env.calls.getImageData, 0, 'probe never calls getImageData');

// ---- workers: requests, results, hashes, FIFO pairing ----
const worker = new env.global.Worker('/assets/conversionWorker.js', { type: 'module' });
assert.ok(worker instanceof env.FakeWorker, 'the Worker proxy constructs real workers');
const result = new Uint8Array(1809 * 1202 * 4).map((_, i) => (i * 13) & 255);
assert.equal(worker.postMessage({ type: 'convert', id: 7, width: 9536, height: 6336, cacheInput: true, reuseSource: true, settings: { filmType: 'positive' } }), 'posted');
worker.emit({ type: 'result', id: 7, width: 1809, height: 1202, rgba: result.buffer });
const libraw = new env.global.Worker('/assets/worker.js');
libraw.postMessage({ id: 0, fn: 'open', args: [new Uint8Array(4), {}] });
libraw.emit({ id: 0, out: null });
libraw.postMessage({ id: 1, fn: 'imageData', args: [] });
libraw.emit({ id: 1, out: { width: 9536, height: 6336, data: new Uint16Array(4) } });
const decoder = new env.global.Worker('/assets/scanDecodeWorker.js');
decoder.emit({ ready: true });
decoder.postMessage({ buffer: new ArrayBuffer(8), format: 'tiff' });
decoder.emit({ width: 6000, height: 4000, data: new Uint16Array(4) });
libraw.terminate();
drained = probe.drain();
const requests = drained.events.filter(event => event.k === 'req');
const responses = drained.events.filter(event => event.k === 'res');
assert.deepEqual(requests.map(event => event.cls), ['convert', 'libraw', 'libraw', 'decode']);
assert.equal(requests[0].ft, 'positive');
assert.equal(requests[0].cache, true);
assert.equal(responses[0].hash, probe.hash(result), 'conversion results hash like uploads');
assert.equal(responses[0].rt, requests[0].t);
assert.equal(responses[2].w, 9536, 'LibRaw decode size is recorded');
assert.equal(responses[3].cls, 'decode', 'id-less protocols pair first-in-first-out');
assert.equal(drained.counters['libraw.decodes'], 1);
assert.equal(drained.events.filter(event => event.k === 'w.new').length, 3);
assert.equal(drained.events.filter(event => event.k === 'w.end').length, 1);
assert.equal(drained.events.filter(event => event.k === 'w.ready').length, 1);

// GPU preparation updates the recipe; cacheRecipe/reuseRecipe omits settings
// on a later message, without changing its film type or geometry evidence.
worker.postMessage({ type: 'prepare', id: 8, cacheInput: true,
  settings: { filmType: 'positive', rotationAngle: 91.5, mirrored: true, cropRegion: { left: 5, top: 7, width: 80, height: 60 } } });
worker.emit({ id: 8 });
worker.postMessage({ type: 'convert', id: 9, cacheInput: true, reuseRecipe: true });
worker.emit({ id: 9 });
const reused = probe.drain().events.filter(event => event.k === 'req');
assert.equal(reused[0].cls, 'prepare');
assert.equal(reused[1].ft, 'positive');
assert.equal(reused[1].geometry.rotationAngle, 91.5);
assert.equal(reused[1].geometry.mirrored, true);
assert.deepEqual(reused[1].geometry.cropRegion, { left: 5, top: 7, width: 80, height: 60 });

// The current dust protocol is attributed even when a plane/maskDelta does
// not carry reuseSource; removed refine messages retain their own class.
{
  const dust = new env.global.Worker('/assets/dustWorker.js');
  for (const [index, type] of ['stroke', 'plane', 'maskDelta', 'refine'].entries()) {
    const message = { type, id: index + 100, data: new Uint8Array(1024) };
    assert.equal(dust.postMessage(message), 'posted');
    assert.equal(dust.posted.at(-1), message, 'no payload is copied or replaced');
    dust.emit({ id: message.id, type: `${type}Result`, patch: new Uint8Array(2048) });
  }
  const dustEvents = probe.drain().events;
  const reqs = dustEvents.filter(event => event.k === 'req');
  assert.deepEqual(reqs.map(event => event.cls), ['dust', 'dust', 'dust', 'refine']);
  assert.deepEqual(reqs.map(event => event.fn), ['stroke', 'plane', 'maskDelta', 'refine']);
  assert.ok(reqs.slice(0, 3).every(event => event.bytes >= 1024 && event.bytes < 1200));
  assert.ok(dustEvents.filter(event => event.k === 'res' && event.cls === 'dust').every(event => event.bytes >= 2048));
  const backing = new ArrayBuffer(8192);
  dust.postMessage({ type: 'stroke', id: 199, patch: new Uint8Array(backing, 0, 16), alias: new Uint8Array(backing, 16, 32) });
  const sliced = probe.drain().events.find(event => event.k === 'req');
  assert.ok(sliced.bytes >= 8192 && sliced.bytes < 8400, 'the full backing buffer is counted once, not just the subarray lengths');
  if (typeof SharedArrayBuffer === 'function') {
    dust.postMessage({ type: 'plane', id: 200, data: new Uint8Array(new SharedArrayBuffer(4096)) });
    const shared = probe.drain().events.find(event => event.k === 'req');
    assert.equal(shared.sharedBytes, 4096);
    assert.ok(shared.bytes < 100, 'a shared view never counts as a copied 4 KB plane');
  }
}

// Native write timing follows the matching begin through finish resolution,
// without changing return identity or recording path/capability arguments.
{
  let finish;
  const nativePromise = new Promise(resolve => { finish = resolve; });
  const native = createEnvironment({ invoke: cmd => cmd === 'begin_export_write' ? Promise.resolve('private-capability') : nativePromise });
  const ipc = native.global.__TAURI_INTERNALS__;
  await ipc.invoke('begin_export_write', { path: '/private/export.tif' });
  assert.equal(ipc.invoke('finish_export_write', { id: 'private-capability' }), nativePromise);
  finish({ bytes: 80 });
  await nativePromise; await Promise.resolve();
  const events = native.global.__ncPerf.drain().events;
  const begin = events.find(event => event.k === 'invoke' && event.cmd === 'begin_export_write');
  const end = events.find(event => event.k === 'invoke.end' && event.cmd === 'finish_export_write');
  assert.equal(end.writeStart, begin.t);
  assert.ok(end.t >= end.writeStart);
  assert.doesNotMatch(JSON.stringify(events), /private-capability|private\/export/);
}

// ---- file reads ----
const file = new env.global.File([new Uint8Array(10)], 'L1000617.DNG');
await file.arrayBuffer();
drained = probe.drain();
assert.deepEqual(drained.events.filter(event => event.k === 'read').map(event => [event.fn, event.name]), [['arrayBuffer', 'L1000617.DNG']]);

// ---- input capture ----
const fire = (type, event) => env.listeners[type].forEach(({ listener }) => listener({ type, isTrusted: true, timeStamp: 100, ...event }));
assert.ok(env.listeners.mousemove[0].options.capture, 'input listeners run in the capture phase');
fire('mousemove', { target: { nodeType: 1, id: 'coreExposure' }, clientX: 10.4, clientY: 20, buttons: 1 });
fire('input', { target: { nodeType: 1, id: 'coreExposure', value: '12', type: 'range' } });
fire('pointermove', { pointerType: 'mouse', target: { nodeType: 1, id: 'x' } });
drained = probe.drain();
const inputs = drained.events.filter(event => event.k === 'input');
assert.deepEqual(inputs.map(event => event.type), ['mousemove', 'input'], 'mouse pointer events are recorded once, as mouse events');
assert.equal(inputs[0].x, 10);
assert.equal(inputs[1].v, '12');

// ---- performance observers ----
const longtaskObserver = env.observers.find(observer => observer.options?.type === 'longtask');
longtaskObserver.callback({ getEntries: () => [{ startTime: 5, duration: 80 }] });
const eventObserver = env.observers.find(observer => observer.options?.type === 'event');
assert.equal(eventObserver.options.durationThreshold, 16);
assert.equal(env.observers.some(observer => observer.options?.type === 'long-animation-frame'), false, 'unsupported entry types are skipped');
drained = probe.drain();
assert.deepEqual(drained.events.filter(event => event.k === 'lt').map(event => event.d), [80]);
assert.equal(drained.observed.loaf, false);
assert.equal(drained.observed.longtask, true);

// ---- measurement windows ----
probe.beginWindow('drag');
env.flushFrames([1000, 1016.7, 1033.3, 1100]);
env.intervals.filter(timer => timer.ms === 5 && !timer.cleared).forEach(timer => { timer.fn(); timer.fn(); });
const window = probe.endWindow();
assert.equal(window.label, 'drag');
assert.deepEqual(window.frames, [1000, 1016.7, 1033.3, 1100]);
assert.equal(window.ticks.length, 2);
assert.ok(env.intervals.filter(timer => timer.ms === 5).every(timer => timer.cleared), 'the heartbeat stops with the window');

// ---- export capture: download anchors and the save picker ----
probe.exports.install();
const exported = new env.global.Blob([new Uint8Array(123)], { type: 'image/png' });
const anchor = new env.Anchor();
anchor.download = 'photo.png';
anchor.href = env.URLStub.createObjectURL(exported);
anchor.click();
assert.equal(anchor.clicked, undefined, 'captured downloads do not navigate');
const handle = await env.global.showSaveFilePicker({ suggestedName: 'roll.zip' });
const writable = await handle.createWritable();
await writable.write(new Uint8Array(50));
await writable.close();
assert.deepEqual(probe.exports.list().map(entry => [entry.name, entry.size, entry.kind, entry.done]), [
  ['photo.png', 123, 'download', true], ['roll.zip', 50, 'stream', true]
]);

// ---- ring buffer and self time ----
const dump = probe.dump();
assert.ok(dump.ring.length > 0, 'the ring buffer keeps recent events for hang dumps');
assert.ok(probe.selfMs() >= 0);

// ---- end to end with the metric definitions: a slider drag through the worker ----
{
  const run = createEnvironment();
  const p = run.global.__ncPerf;
  const ctx = new run.global.WebGLRenderingContext('glCanvas');
  const w = new run.global.Worker('/assets/conversionWorker.js');
  const fireInput = (time, value) => run.listeners.input.forEach(({ listener }) => listener({ type: 'input', isTrusted: true, timeStamp: time, target: { nodeType: 1, id: 'coreExposure', value: String(value) } }));
  const fireMove = time => run.listeners.mousemove.forEach(({ listener }) => listener({ type: 'mousemove', isTrusted: true, timeStamp: time, buttons: 1, clientX: time, clientY: 0, target: { nodeType: 1, id: 'coreExposure' } }));
  // Six inputs one frame apart; the worker only keeps up with every other one.
  for (let i = 0; i < 6; i++) { fireMove(1000 + i * 16.7); fireInput(1000.5 + i * 16.7, i + 1); }
  const frame = n => new Uint8Array(4096 * 4).fill(n);
  const posted = [];
  const originalNow = performance.now.bind(performance);
  let clock = 1000;
  performance.now = () => clock;
  try {
    for (const [index, value] of [[0, 1], [2, 3], [4, 5]]) {
      clock = 1001 + index * 16.7;
      w.postMessage({ type: 'convert', id: value, cacheInput: true, settings: {} });
      posted.push(value);
      clock += 20;
      w.emit({ type: 'result', id: value, width: 64, height: 64, rgba: frame(value).buffer });
      clock += 1;
      ctx.bindTexture(0x0DE1, {});
      ctx.texImage2D(0x0DE1, 0, 0x1908, 64, 64, 0, 0x1908, 0x1401, frame(value));
      clock += 2;
      ctx.drawArrays(5, 0, 4);
    }
  } finally { performance.now = originalNow; }
  const events = p.drain().events.sort((a, b) => a.t - b.t);
  const pics = pictures(events, 'glCanvas');
  assert.equal(pics.length, 3);
  assert.ok(pics.every(pic => pic.positive), 'each draw shows a conversion result');
  const metrics = dragMetrics(events, { targetId: 'coreExposure', window: { start: 999, release: 1100, end: 1200 }, initialValue: 0 });
  assert.equal(metrics.inputs, 6);
  assert.equal(metrics.pictures, 3);
  assert.equal(metrics.framesCoveredPct, 50, 'half of the value-changing frames got a picture');
  assert.equal(metrics.inputToDrawP50Ms, 24, 'draw minus the trusted move it reflects');
  assert.equal(metrics.workerRoundTripMs, 20);
}

console.log('probe: wrappers, worker pairing, windows, export capture and metric integration tests passed');
