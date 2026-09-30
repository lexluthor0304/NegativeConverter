import assert from 'node:assert/strict';
import LibRaw from 'libraw-wasm';
import { librawThreadSupport, planLibRawThreads, createLibRaw, probeLibRawWorker } from './librawRuntime.js';

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
const isolatedEnv = { crossOriginIsolated: true, navigator: { hardwareConcurrency: 8 } };
const plainEnv = { crossOriginIsolated: false, navigator: { hardwareConcurrency: 8 } };
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
  const foreground = createLibRaw({ LibRawClass: Threaded, env: isolatedEnv });
  assert.deepEqual(Recorder.calls, [[{ threads: 8 }]]);
  assert.equal(foreground.threads, 8);
  assert.equal(foreground.threaded, true);

  Recorder.calls = [];
  createLibRaw({ LibRawClass: Threaded, env: isolatedEnv, background: true });
  assert.deepEqual(Recorder.calls, [[{ threads: 2 }]]);
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
