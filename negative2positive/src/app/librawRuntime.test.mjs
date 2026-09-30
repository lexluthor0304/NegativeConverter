import assert from 'node:assert/strict';
import LibRaw from 'libraw-wasm';
import { librawThreadSupport, planLibRawThreads, createLibRaw, probeLibRawWorker, resetLibRawRuntime, THREADED_START_TIMEOUT_MS } from './librawRuntime.js';

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
      fetchImpl: async (url) => { fetched.push(url); return { headers: headers('require-corp') }; } });
    assert.deepEqual(fetched, ['https://app.test/assets/worker-abc.js']);
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

console.log('librawRuntime tests passed');
