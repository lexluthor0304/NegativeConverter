import assert from 'node:assert/strict';
import LibRaw from 'libraw-wasm';
import { librawThreadSupport, planLibRawThreads, createLibRaw, probeLibRawWorker, resetLibRawRuntime, watchLibRawWorker, THREADED_START_TIMEOUT_MS } from './librawRuntime.js';

// The published libraw-wasm (1.6.0) has no thread flag: the app keeps
// constructing it exactly as before.
assert.equal(librawThreadSupport(LibRaw), null, 'the installed libraw-wasm is not a threaded build');
assert.equal(librawThreadSupport(null), null);
assert.equal(librawThreadSupport(class {}), null);
assert.equal(librawThreadSupport(Object.assign(class {}, { features: { threads: false } })), null);
assert.deepEqual(librawThreadSupport(Object.assign(class {}, { features: { threads: true } })), { threads: true, maxThreads: 8 });
assert.deepEqual(librawThreadSupport(Object.assign(class {}, { features: { threads: true, maxThreads: 4 } })), { threads: true, maxThreads: 4 });

// ---- thread plan
assert.equal(planLibRawThreads({ isolated: false, hardwareConcurrency: 16 }), 1);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 8 }), 8);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 16 }), 8, 'capped at 8 threads');
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 6 }), 6);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 1 }), 1);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: undefined }), 4, 'unknown core count: 4');
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 8, background: true }), 2, 'a background lane is capped');
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 1, background: true }), 1);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 8, maxThreads: 4 }), 4, 'the build\'s cap');

// ---- construction
class Recorder {
  constructor(...args) { Recorder.calls.push(args); }
  dispose() { this.disposed = true; }
}
Recorder.calls = [];
const Threaded = Object.assign(class extends Recorder {}, { features: { threads: true } });
const isolatedEnv = { crossOriginIsolated: true, SharedArrayBuffer, navigator: { hardwareConcurrency: 8 } };
const plainEnv = { crossOriginIsolated: false, SharedArrayBuffer, navigator: { hardwareConcurrency: 8 } };
// macOS WKWebView: isolated, but no SharedArrayBuffer constructor.
const webkitEnv = { crossOriginIsolated: true, navigator: { hardwareConcurrency: 8 } };
{
  Recorder.calls = [];
  const plain = createLibRaw({ LibRawClass: Recorder, env: isolatedEnv });
  assert.deepEqual(Recorder.calls, [[]], 'a build without threads: new LibRaw() with no argument, as before');
  assert.equal(plain.threads, 1);
  assert.equal(plain.threaded, false);

  Recorder.calls = [];
  const notIsolated = createLibRaw({ LibRawClass: Threaded, env: plainEnv });
  assert.deepEqual(Recorder.calls, [[]], 'a threaded build on a page that is not isolated: no argument either');
  assert.equal(notIsolated.threaded, false);

  Recorder.calls = [];
  const noSharedMemory = createLibRaw({ LibRawClass: Threaded, env: webkitEnv });
  assert.deepEqual(Recorder.calls, [[]], 'isolated without SharedArrayBuffer (WKWebView): no threads');
  assert.equal(noSharedMemory.threaded, false);

  Recorder.calls = [];
  const foreground = createLibRaw({ LibRawClass: Threaded, env: isolatedEnv });
  assert.deepEqual(Recorder.calls, [[{ threads: 8 }]]);
  assert.equal(foreground.threads, 8);
  assert.equal(foreground.threaded, true);

  Recorder.calls = [];
  createLibRaw({ LibRawClass: Threaded, env: isolatedEnv, background: true });
  assert.deepEqual(Recorder.calls, [[{ threads: 2 }]]);
}

// ---- a threaded instance that does not start: the same decode on `new LibRaw()`
{
  console.warn = () => {};
  // libraw-wasm's client: calls are answered in order, `open()` detaches the
  // bytes it is given, dispose() rejects what is pending.
  const log = [];
  const makeClass = (startup) => {
    class Fake {
      constructor(options) {
        this.threads = options?.threads ?? null;
        this.pending = new Set();
        log.push(['new', this.threads]);
      }
      track(promise) {
        return new Promise((resolve, reject) => {
          const entry = { reject };
          this.pending.add(entry);
          promise.then((v) => { this.pending.delete(entry); resolve(v); }, (e) => { this.pending.delete(entry); reject(e); });
        });
      }
      runtimeInfo() {
        log.push(['runtimeInfo', this.threads]);
        if (this.threads === null) return Promise.resolve({ threaded: false, threads: 1 });
        return this.track(startup());
      }
      open(bytes, settings) {
        log.push(['open', this.threads, bytes.byteLength, settings.halfSize]);
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
        return Promise.resolve();
      }
      metadata() { log.push(['metadata', this.threads]); return Promise.resolve({ width: 4, height: 2 }); }
      imageData() { log.push(['imageData', this.threads]); return Promise.resolve({ width: 4, height: 2, colors: 3, bits: 16, data: new Uint16Array(24) }); }
      dispose() {
        log.push(['dispose', this.threads]);
        for (const entry of this.pending) entry.reject(new Error('LibRaw disposed'));
        this.pending.clear();
      }
    }
    return Object.assign(Fake, { features: { threads: true, maxThreads: 16 } });
  };
  const decodeWith = async (raw) => {
    const bytes = new Uint8Array(64).fill(7);
    await raw.open(bytes, { halfSize: false });
    assert.equal(bytes.byteLength, 0, 'open() took the bytes');
    await raw.metadata(true);
    return raw.imageData();
  };
  assert.ok(THREADED_START_TIMEOUT_MS >= 1000 && THREADED_START_TIMEOUT_MS <= 10_000);

  // It starts: every call goes to the threaded instance.
  resetLibRawRuntime();
  log.length = 0;
  const Starts = makeClass(() => Promise.resolve({ threaded: true, crossOriginIsolated: true, poolSize: 7, threads: 8 }));
  const ok = createLibRaw({ LibRawClass: Starts, env: isolatedEnv });
  assert.equal(ok.threaded, true);
  assert.equal((await decodeWith(ok.raw)).width, 4);
  assert.deepEqual(log, [['new', 8], ['runtimeInfo', 8], ['open', 8, 64, false], ['metadata', 8], ['imageData', 8]]);
  assert.equal(ok.raw.threads, 8);
  ok.raw.dispose();

  // Its module or pool fails: the decode runs on the single-threaded build with
  // the untouched bytes, and the page stops asking for threads.
  resetLibRawRuntime();
  log.length = 0;
  const Fails = makeClass(() => Promise.reject(new Error('RangeError: WebAssembly.Memory(): could not allocate memory')));
  const failed = createLibRaw({ LibRawClass: Fails, env: isolatedEnv });
  assert.equal((await decodeWith(failed.raw)).width, 4);
  assert.deepEqual(log, [['new', 8], ['runtimeInfo', 8], ['dispose', 8], ['new', null],
    ['open', null, 64, false], ['metadata', null], ['imageData', null]]);
  assert.equal(failed.raw.threads, 1);
  assert.equal(failed.raw.threaded, false);
  log.length = 0;
  const next = createLibRaw({ LibRawClass: Fails, env: isolatedEnv, background: true });
  assert.equal(next.threaded, false, 'later decodes go straight to the single-threaded build');
  assert.deepEqual(log, [['new', null]]);
  next.raw.dispose?.();

  // It never answers (a pool worker that does not load): the same, after the timeout.
  resetLibRawRuntime();
  log.length = 0;
  const Hangs = makeClass(() => new Promise(() => {}));
  const hung = createLibRaw({ LibRawClass: Hangs, env: isolatedEnv, background: true, startTimeoutMs: 20 });
  assert.equal(hung.threads, 2);
  assert.equal((await decodeWith(hung.raw)).width, 4);
  assert.deepEqual(log.map((entry) => entry.slice(0, 2)), [['new', 2], ['runtimeInfo', 2], ['dispose', 2], ['new', null],
    ['open', null], ['metadata', null], ['imageData', null]]);

  // An abort while it starts is no failure: "LibRaw disposed", no fallback, threads stay on.
  resetLibRawRuntime();
  log.length = 0;
  const aborted = createLibRaw({ LibRawClass: Hangs, env: isolatedEnv });
  const opening = aborted.raw.open(new Uint8Array(8), { halfSize: true });
  await Promise.resolve();
  aborted.raw.dispose();
  await assert.rejects(opening, /LibRaw disposed/);
  assert.deepEqual(log, [['new', 8], ['runtimeInfo', 8], ['dispose', 8]]);
  assert.equal(createLibRaw({ LibRawClass: Starts, env: isolatedEnv }).threaded, true);
  resetLibRawRuntime();
}

// ---- the report entry
{
  const ThreadedInfo = Object.assign(class extends Recorder {
    async runtimeInfo() { return { crossOriginIsolated: true, poolSize: 7, threads: 8 }; }
  }, { features: { threads: true } });
  const saved = globalThis.crossOriginIsolated;
  globalThis.crossOriginIsolated = true;
  try {
    const answer = await probeLibRawWorker({ LibRawClass: ThreadedInfo });
    assert.deepEqual(answer, { crossOriginIsolated: true, sharedArrayBuffer: true, threads: 8, poolSize: 7, threaded: true });
  } finally {
    if (saved === undefined) delete globalThis.crossOriginIsolated;
    else globalThis.crossOriginIsolated = saved;
  }
}
{
  // Without runtimeInfo, the worker script's COEP header decides: the class
  // below starts its worker through the global Worker constructor like
  // libraw-wasm does.
  const started = [];
  const SavedWorker = globalThis.Worker;
  globalThis.Worker = class { constructor(url, options) { started.push({ url: String(url), options }); } terminate() {} };
  class Plain {
    constructor() { this.worker = new Worker(new URL('https://app.test/assets/worker-abc.js'), { type: 'module' }); }
    dispose() { this.worker.terminate(); }
  }
  const headers = (value) => ({ get: (name) => (name.toLowerCase() === 'cross-origin-embedder-policy' ? value : null) });
  try {
    const fetched = [];
    const withCoep = await probeLibRawWorker({ LibRawClass: Plain, pageIsolated: true,
      fetchImpl: async (url, init) => { fetched.push([url, init?.cache ?? 'default']); return { headers: headers('require-corp') }; } });
    // The HTTP cache's copy, as the worker load gets it (#229 review R2-046):
    // a copy cached before the site sent COEP must read as not isolated.
    assert.deepEqual(fetched, [['https://app.test/assets/worker-abc.js', 'default']]);
    assert.deepEqual(withCoep, { crossOriginIsolated: true, inferred: true, coep: 'require-corp', threaded: false });
    assert.equal(globalThis.Worker.name, '', 'the global Worker is restored');

    const without = await probeLibRawWorker({ LibRawClass: Plain, pageIsolated: true, fetchImpl: async () => ({ headers: headers(null) }) });
    assert.equal(without.crossOriginIsolated, false);
    assert.equal(without.coep, null);

    const notIsolated = await probeLibRawWorker({ LibRawClass: Plain, pageIsolated: false, fetchImpl: async () => ({ headers: headers('require-corp') }) });
    assert.equal(notIsolated.crossOriginIsolated, false);

    const failed = await probeLibRawWorker({ LibRawClass: Plain, pageIsolated: true, fetchImpl: async () => { throw new Error('offline'); } });
    assert.match(failed.error, /offline/);
  } finally {
    globalThis.Worker = SavedWorker;
  }
  assert.equal(started.length, 4);
}

// ---- a LibRaw worker that fails (#229 review R2-046): every call rejects at
// once with the loader's timeout code instead of waiting out its timeout
{
  const warn = console.warn;
  console.warn = () => {};
  const within = (promise, ms = 2000) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    })]).finally(() => clearTimeout(timer));
  };
  const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  // libraw-wasm 1.6.0 itself, on a Worker that never answers unless told to.
  const started = [];
  class FakeWorker extends EventTarget {
    constructor(url, options) {
      super();
      this.url = String(url);
      this.options = options;
      this.posted = [];
      this.terminated = false;
      this.answer = null;
      started.push(this);
    }
    postMessage(message) {
      this.posted.push(message.fn);
      if (this.answer) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, out: this.answer(message.fn) } }));
    }
    terminate() { this.terminated = true; }
  }
  const SavedWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    // Its script does not load while open() waits: open() rejects at once,
    // the instance is disposed, and later calls reject with the same error.
    const { raw, threads } = createLibRaw({ env: plainEnv });
    assert.equal(threads, 1);
    const worker = started.at(-1);
    assert.match(worker.url, /libraw-wasm\/dist\/worker\.js$/);
    assert.equal(raw.worker, worker);
    const opening = settled(raw.open(new Uint8Array(16), { halfSize: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(worker.posted, ['open'], 'the call reached the worker');
    worker.dispatchEvent(new Event('error'));
    const { error } = await within(opening);
    assert.equal(error?.code, 'RAW_DECODE_TIMEOUT', 'the loader\'s timeout path');
    assert.match(error.message, /LibRaw's worker failed: its script did not load/);
    assert.equal(worker.terminated, true, 'disposed at once');
    assert.equal((await within(settled(raw.metadata(true)))).error, error);
    assert.equal((await within(settled(raw.imageData()))).error, error);
    raw.dispose();

    // The error comes before the first call: open() rejects at once too.
    const early = createLibRaw({ env: plainEnv }).raw;
    started.at(-1).dispatchEvent(Object.assign(new Event('error'), { message: 'Uncaught RuntimeError: unreachable' }));
    assert.match((await within(settled(early.open(new Uint8Array(4), {})))).error.message, /LibRaw's worker failed: Uncaught RuntimeError: unreachable/);
    assert.equal(started.at(-1).posted.length, 0, 'nothing was posted to the failed worker');

    // An abort is unchanged: "LibRaw disposed", and a later error is not watched.
    const aborted = createLibRaw({ env: plainEnv }).raw;
    const abortedWorker = started.at(-1);
    const pendingOpen = settled(aborted.open(new Uint8Array(4), {}));
    aborted.dispose();
    assert.match((await within(pendingOpen)).error.message, /^LibRaw disposed$/);
    abortedWorker.dispatchEvent(new Event('error'));

    // A worker that answers: the calls and their results pass through.
    const healthy = createLibRaw({ env: plainEnv }).raw;
    started.at(-1).answer = (fn) => (fn === 'metadata' ? { width: 4, height: 2, desc: ' x ' } : fn === 'imageData' ? { width: 4, height: 2 } : undefined);
    await within(healthy.open(new Uint8Array(4), {}));
    assert.deepEqual(await within(healthy.metadata(true)), { width: 4, height: 2, desc: 'x' });
    assert.deepEqual(await within(healthy.imageData()), { width: 4, height: 2 });
    healthy.dispose();
    assert.equal(started.at(-1).terminated, true);

    // Instances without a worker to watch are returned as they are.
    const bare = new Recorder();
    assert.equal(watchLibRawWorker(bare), bare);

    // A threaded instance whose worker fails: the single-threaded build
    // decodes at once, not after the start timeout.
    resetLibRawRuntime();
    const made = [];
    class ThreadedFake {
      static features = { threads: true };
      constructor(options) {
        this.threads = options?.threads ?? null;
        this.worker = new FakeWorker(this.threads ? 'worker-threaded.js' : 'worker.js');
        made.push(this);
      }
      runtimeInfo() { return this.threads ? new Promise(() => {}) : Promise.resolve({ threaded: false, threads: 1 }); }
      open() { return Promise.resolve(); }
      metadata() { return Promise.resolve({ width: 4, height: 2 }); }
      imageData() { return Promise.resolve({ width: 4, height: 2, threads: this.threads }); }
      dispose() { this.disposed = true; this.worker.terminate(); }
    }
    const threaded = createLibRaw({ LibRawClass: ThreadedFake, env: isolatedEnv, startTimeoutMs: 60_000 });
    assert.equal(threaded.threaded, true);
    const decoding = settled(threaded.raw.open(new Uint8Array(4), {}).then(() => threaded.raw.imageData()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    made[0].worker.dispatchEvent(new Event('error'));
    assert.deepEqual((await within(decoding)).value, { width: 4, height: 2, threads: null });
    assert.deepEqual(made.map((instance) => instance.threads), [8, null]);
    assert.equal(made[0].disposed, true);
    assert.equal(threaded.raw.threads, 1);
    assert.equal(createLibRaw({ LibRawClass: ThreadedFake, env: isolatedEnv }).threaded, false, 'the page stops asking for threads');
    resetLibRawRuntime();

    // The loader then takes its timeout path, the embedded JPEG, at once
    // (rawFileLoader.js is unchanged: the error carries its timeout code).
    console.info = () => {};
    globalThis.ImageData ??= class ImageData {
      constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
    };
    globalThis.createImageBitmap = async () => ({ width: 1620, height: 1080, close() {} });
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => new ImageData(new Uint8ClampedArray(w * h * 4).fill(128), w, h)
        })
      })
    };
    // A RAW container with an embedded 1620x1080 JPEG preview.
    const container = new Uint8Array(96 * 1024);
    for (let i = 0; i < container.length; i++) container[i] = (i * 31) & 0xFF;
    for (let i = 0; i < container.length - 2; i++) if (container[i] === 0xFF && container[i + 1] === 0xD8) container[i + 1] = 0;
    container.set([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 1080 >> 8, 1080 & 0xFF, 1620 >> 8, 1620 & 0xFF, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 40 * 1024);
    started.length = 0;
    globalThis.Worker = class extends FakeWorker {
      constructor(url, options) {
        super(url, options);
        // LibRaw's script is refused, as an isolated page refuses a copy cached without COEP.
        if (/libraw-wasm/.test(this.url)) setTimeout(() => this.dispatchEvent(new Event('error')), 0);
        // The preview's decode worker has no image decoder: the page decodes it.
        if (/scanDecodeWorker/.test(this.url)) setTimeout(() => this.onmessage?.({ data: { ready: true, canDecodeImages: false } }), 0);
      }
    };
    const { loadRawFile } = await import('./rawFileLoader.js');
    const began = performance.now();
    const image = await within(loadRawFile(container.slice().buffer, 'frame.nef', { sourceBlob: new Blob([container]) }), 5000);
    assert.ok(performance.now() - began < 5000, 'no 30 s open timeout');
    assert.equal(image.width, 1620);
    assert.equal(image.height, 1080);
    assert.ok(image.__image16?.data instanceof Uint16Array, 'the embedded JPEG, promoted');
    assert.ok(started.some((entry) => /libraw-wasm/.test(entry.url)), 'LibRaw started its worker');
    assert.ok(started.every((entry) => entry.terminated), 'every worker released');
  } finally {
    globalThis.Worker = SavedWorker;
    console.warn = warn;
  }
}

console.log('librawRuntime tests passed');
