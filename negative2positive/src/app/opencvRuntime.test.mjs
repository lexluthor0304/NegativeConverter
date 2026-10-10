// The compile-once OpenCV runtime (#252 part 5): one compile per session,
// Modules handed to workers, and every fallback ending in a working realm or
// an error (never a hang).
import assert from 'node:assert/strict';
import {
  answerOpenCvWorker, chooseOpenCvVariant, compileWasmFromUrl, createOpenCvModuleCache, createOpenCvModuleRequester, createOpenCvRealmLoader,
  normalizeOpenCvVariant, OPENCV_MODULE_REPLY, OPENCV_MODULE_REQUEST, provideOpenCvModuleSource, serveOpenCvModule, WASM_SIMD_PROBE, wasmSimdSupported
} from './opencvRuntime.js';

// The smallest valid module, and one that imports a function.
const EMPTY = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

function fakeFetch(type, { failFirst = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: !(failFirst && calls.length === 1),
      status: failFirst && calls.length === 1 ? 500 : 200,
      headers: { get: key => (key === 'content-type' ? type : null) },
      arrayBuffer: async () => EMPTY.buffer.slice(0)
    };
  };
  return { fetchImpl, calls };
}

// Streaming when served as application/wasm; the whole body otherwise.
{
  const { fetchImpl, calls } = fakeFetch('application/wasm');
  let streamed = 0;
  const wasm = { ...WebAssembly, Module: WebAssembly.Module, compile: WebAssembly.compile,
    compileStreaming: async (response) => { streamed++; return WebAssembly.compile(await response.arrayBuffer()); } };
  const module = await compileWasmFromUrl('/opencv.wasm', { fetchImpl, wasm });
  assert.ok(module instanceof WebAssembly.Module);
  assert.equal(streamed, 1);
  assert.deepEqual(calls, ['/opencv.wasm']);
}
{
  const { fetchImpl, calls } = fakeFetch('application/octet-stream');
  let streamed = 0;
  const wasm = { Module: WebAssembly.Module, compile: WebAssembly.compile, compileStreaming: async () => { streamed++; throw new Error('no'); } };
  assert.ok(await compileWasmFromUrl('/opencv.wasm', { fetchImpl, wasm }) instanceof WebAssembly.Module);
  assert.equal(streamed, 0, 'a response not served as wasm is compiled whole');
  assert.equal(calls.length, 1);
}
{
  // A streaming refusal (a custom protocol's response) refetches and compiles whole.
  const { fetchImpl, calls } = fakeFetch('application/wasm');
  const warn = console.warn; console.warn = () => {};
  const wasm = { Module: WebAssembly.Module, compile: WebAssembly.compile, compileStreaming: async () => { throw new TypeError('bad response'); } };
  try { assert.ok(await compileWasmFromUrl('/opencv.wasm', { fetchImpl, wasm }) instanceof WebAssembly.Module); }
  finally { console.warn = warn; }
  assert.equal(calls.length, 2);
}
await assert.rejects(compileWasmFromUrl('/x.wasm', { fetchImpl: fakeFetch('application/wasm', { failFirst: true }).fetchImpl }), /500/);

// One compile per session; a failure is retried; a Module from elsewhere is adopted.
{
  let compiles = 0;
  const cache = createOpenCvModuleCache({ compile: async () => { compiles++; return WebAssembly.compile(EMPTY); } });
  assert.equal(cache.peek(), null);
  const [a, b] = await Promise.all([cache.ensure(), cache.ensure()]);
  assert.equal(a, b);
  assert.equal(await cache.ensure(), a);
  assert.equal(compiles, 1);
  assert.equal(cache.compiles, 1);
  assert.equal(cache.adopt(await WebAssembly.compile(EMPTY)), a, 'the first module stays');
}
{
  let attempt = 0;
  const cache = createOpenCvModuleCache({ compile: async () => { attempt++; if (attempt === 1) throw new Error('offline'); return WebAssembly.compile(EMPTY); } });
  await assert.rejects(cache.ensure(), /offline/);
  assert.ok(await cache.ensure() instanceof WebAssembly.Module);
  const other = createOpenCvModuleCache({ compile: async () => { throw new Error('never'); } });
  const module = await WebAssembly.compile(EMPTY);
  assert.equal(other.adopt({}), null, 'only a Module is adopted');
  assert.equal(other.adopt(module), module);
  assert.equal(await other.ensure(), module);
}

// A fake glue: calls the hook as the package's createWasm does and exposes
// its ready promise as globalThis.cv.
function fakeGlue(global) {
  return async () => {
    global.cv = new Promise((resolve) => {
      global.__opencvModuleArg.instantiateWasm({}, (instance, module) => resolve({ Mat: function Mat() {}, instance, module }));
    });
  };
}

// The shared Module is instantiated; no compile happens here.
{
  const global = {};
  const shared = await WebAssembly.compile(EMPTY);
  let own = 0;
  const loader = createOpenCvRealmLoader({
    glueUrl: '/glue.js', getModule: async () => shared, compileOwn: async () => { own++; return WebAssembly.compile(EMPTY); },
    importGlue: fakeGlue(global), global
  });
  const [cv1, cv2] = await Promise.all([loader.load(), loader.load()]);
  assert.equal(cv1, cv2, 'one realm load');
  assert.equal(global.cv, cv1);
  assert.equal(cv1.module, shared);
  assert.equal(own, 0);
  assert.equal(loader.stats.sharedModule, true);
  assert.equal(loader.stats.ownCompiles, 0);
  assert.ok(loader.stats.readyMs >= 0);
  assert.equal(global.__opencvModuleArg, undefined, 'the hook is removed after load');
}
// No Module from the page, or one that cannot be instantiated: compile here.
for (const offered of [null, 'broken']) {
  const global = {};
  const warn = console.warn; console.warn = () => {};
  const wasm = offered === 'broken'
    ? { instantiate: async (module, imports) => { if (module === 'broken') throw new Error('cannot'); return WebAssembly.instantiate(module, imports); } }
    : WebAssembly;
  const loader = createOpenCvRealmLoader({
    glueUrl: '/glue.js', getModule: async () => offered, compileOwn: async () => WebAssembly.compile(EMPTY),
    importGlue: fakeGlue(global), global, wasm
  });
  try { assert.ok((await loader.load()).Mat); } finally { console.warn = warn; }
  assert.equal(loader.stats.sharedModule, false);
  assert.equal(loader.stats.ownCompiles, 1);
}
// An ES-module glue evaluates once per realm. A failed factory never
// restarts on another import: every later load must reject promptly too.
{
  const global = {};
  let attempts = 0, evaluations = 0;
  const glue = fakeGlue(global);
  const loader = createOpenCvRealmLoader({
    glueUrl: '/glue.js', getModule: async () => null,
    compileOwn: async () => { attempts++; throw new Error('offline'); },
    importGlue: async () => { if (!evaluations++) await glue(); }, global
  });
  const first = loader.load();
  await assert.rejects(first, /offline/);
  let timer;
  try {
    await assert.rejects(Promise.race([loader.load(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('second load hung')), 100);
    })]), /offline/);
  } finally { clearTimeout(timer); }
  assert.equal(loader.load(), first, 'the first rejection stays cached');
  assert.equal(attempts, 1, 'only a fresh realm may compile again');
  assert.equal(evaluations, 1, 'the glue was imported once');
}

// The page answers a worker's request with the Module, or null when it
// cannot be cloned (the worker then compiles itself).
{
  const posted = [];
  const module = await WebAssembly.compile(EMPTY);
  const worker = { postMessage(message) { posted.push(message); } };
  assert.equal(serveOpenCvModule(worker, { id: 3, result: {} }, async () => module), false);
  assert.equal(serveOpenCvModule(worker, { type: OPENCV_MODULE_REQUEST }, async () => module), true);
  await flush();
  assert.deepEqual(posted, [{ type: OPENCV_MODULE_REPLY, opencvModule: module, variant: null }]);
  const refusing = { calls: 0, postMessage(message) { this.calls++; if (message.opencvModule) throw new DOMException('no', 'DataCloneError'); posted.push(message); } };
  serveOpenCvModule(refusing, { type: OPENCV_MODULE_REQUEST }, async () => module, 'simd');
  await flush();
  assert.equal(refusing.calls, 2);
  assert.deepEqual(posted.at(-1), { type: OPENCV_MODULE_REPLY, opencvModule: null, variant: 'simd' }, 'the variant survives a refused clone');
  serveOpenCvModule(worker, { type: OPENCV_MODULE_REQUEST }, async () => { throw new Error('offline'); }, 'scalar');
  await flush();
  assert.deepEqual(posted.at(-1), { type: OPENCV_MODULE_REPLY, opencvModule: null, variant: 'scalar' }, 'the variant survives a failed compile');
  serveOpenCvModule(worker, { type: OPENCV_MODULE_REQUEST }, async () => module, 'threads');
  await flush();
  assert.equal(posted.at(-1).variant, null, 'an unknown variant is not forwarded');
  // The registry the clients forward to: none registered answers null.
  provideOpenCvModuleSource(null);
  assert.equal(answerOpenCvWorker(worker, { type: OPENCV_MODULE_REQUEST }), true);
  await flush();
  assert.deepEqual(posted.at(-1), { type: OPENCV_MODULE_REPLY, opencvModule: null, variant: null });
  provideOpenCvModuleSource(async () => module, 'simd');
  answerOpenCvWorker(worker, { type: OPENCV_MODULE_REQUEST });
  await flush();
  assert.equal(posted.at(-1).opencvModule, module);
  assert.equal(posted.at(-1).variant, 'simd');
  assert.equal(answerOpenCvWorker(worker, { id: 1 }), false);
  provideOpenCvModuleSource(null);
}

// The worker asks once; the reply settles it with the Module and the
// variant; a silent page times out to null members.
{
  const sent = [];
  const requester = createOpenCvModuleRequester({ post: message => sent.push(message) });
  const first = requester.requestModule();
  const offer = requester.requestOffer();
  assert.equal(requester.requestModule(), first);
  assert.deepEqual(sent, [{ type: OPENCV_MODULE_REQUEST }], 'one request for both forms');
  assert.equal(requester.accept({ id: 4 }), false);
  const module = await WebAssembly.compile(EMPTY);
  assert.equal(requester.accept({ type: OPENCV_MODULE_REPLY, opencvModule: module, variant: 'simd' }), true);
  assert.equal(await first, module);
  assert.deepEqual(await offer, { module, variant: 'simd' });
  let fire;
  const silent = createOpenCvModuleRequester({ post() {}, setTimer: fn => { fire = fn; return 1; }, clearTimer() {} });
  const waiting = silent.requestOffer();
  fire();
  assert.deepEqual(await waiting, { module: null, variant: null });
  const legacy = createOpenCvModuleRequester({ post() {} });
  const old = legacy.requestOffer();
  legacy.accept({ type: OPENCV_MODULE_REPLY, opencvModule: module });
  assert.deepEqual(await old, { module, variant: null }, 'a reply without a variant');
}

// ---- Variant choice (#292) ----
// The probe: this Node validates v128; an engine that refuses it, or has no
// validate, reports no SIMD.
assert.equal(wasmSimdSupported(), true);
assert.equal(WebAssembly.validate(new Uint8Array(WASM_SIMD_PROBE)), true);
assert.equal(wasmSimdSupported({ validate: () => false }), false);
assert.equal(wasmSimdSupported({ validate: () => { throw new TypeError('no'); } }), false);
assert.equal(wasmSimdSupported({}), false);
assert.equal(wasmSimdSupported(null), false);
{
  const storage = (value) => ({ getItem: key => (key === 'nc_opencv_simd' ? value : null) });
  assert.deepEqual(chooseOpenCvVariant({ search: '' }), { variant: 'simd', simdSupported: true, forced: null, source: 'probe' });
  assert.deepEqual(chooseOpenCvVariant({ search: '?lang=en&opencvSimd=0' }), { variant: 'scalar', simdSupported: true, forced: 'scalar', source: 'query' });
  assert.deepEqual(chooseOpenCvVariant({ search: '?opencvSimd=1' }), { variant: 'simd', simdSupported: true, forced: 'simd', source: 'query' });
  assert.equal(chooseOpenCvVariant({ search: '?opencvSimd=yes' }).source, 'probe', 'other values are ignored');
  assert.deepEqual(chooseOpenCvVariant({ search: '', storage: storage('0') }), { variant: 'scalar', simdSupported: true, forced: 'scalar', source: 'storage' });
  assert.equal(chooseOpenCvVariant({ search: '?opencvSimd=1', storage: storage('0') }).variant, 'simd', 'the query wins over the kill switch');
  assert.equal(chooseOpenCvVariant({ search: '', storage: { getItem() { throw new Error('denied'); } } }).variant, 'simd', 'a throwing storage is ignored');
  // Without SIMD the scalar build runs whatever the switches say.
  const noSimd = { validate: () => false };
  assert.deepEqual(chooseOpenCvVariant({ search: '?opencvSimd=1', wasm: noSimd }), { variant: 'scalar', simdSupported: false, forced: 'simd', source: 'query' });
  assert.equal(chooseOpenCvVariant({ search: '', wasm: noSimd }).variant, 'scalar');
  assert.equal(normalizeOpenCvVariant('simd'), 'simd');
  assert.equal(normalizeOpenCvVariant('threads'), null);
  assert.equal(normalizeOpenCvVariant(undefined), null);
}

// The realm imports the glue of the variant the page offers, with its
// Module; the page's variant wins over the realm's own probe; without an
// offered variant the realm's probe decides; the realm compiles the offered
// variant itself when no Module comes.
{
  const imported = [];
  const makeLoader = (offer, { chooseVariant = () => 'simd', compileOwn = null } = {}) => {
    const global = {};
    const compiled = [];
    const loader = createOpenCvRealmLoader({
      glueUrls: { simd: '/codecs/opencv-simd-glue.js', scalar: '/assets/opencv-glue.js' },
      getOffer: async () => offer,
      compileOwn: compileOwn || (async (variant) => { compiled.push(variant); return WebAssembly.compile(EMPTY); }),
      chooseVariant,
      importGlue: async (url) => { imported.push(url); await fakeGlue(global)(); },
      global
    });
    return { loader, compiled };
  };
  const shared = await WebAssembly.compile(EMPTY);
  {
    const { loader, compiled } = makeLoader({ module: shared, variant: 'scalar' });
    const cv = await loader.load();
    assert.equal(cv.module, shared);
    assert.equal(imported.at(-1), '/assets/opencv-glue.js', 'the page\'s variant, not the realm\'s probe');
    assert.deepEqual(compiled, []);
    assert.equal(loader.stats.variant, 'scalar');
    assert.equal(loader.stats.offeredVariant, 'scalar');
    assert.equal(loader.stats.sharedModule, true);
  }
  {
    const { loader, compiled } = makeLoader({ module: null, variant: 'simd' });
    await loader.load();
    assert.equal(imported.at(-1), '/codecs/opencv-simd-glue.js');
    assert.deepEqual(compiled, ['simd'], 'no Module: the offered variant is compiled here');
    assert.equal(loader.stats.sharedModule, false);
    assert.equal(loader.stats.ownCompiles, 1);
  }
  {
    const { loader, compiled } = makeLoader({ module: null, variant: null }, { chooseVariant: () => 'scalar' });
    await loader.load();
    assert.equal(imported.at(-1), '/assets/opencv-glue.js', 'no offered variant: the realm\'s probe');
    assert.deepEqual(compiled, ['scalar']);
    assert.equal(loader.stats.offeredVariant, null);
  }
  {
    const { loader } = makeLoader({ module: shared, variant: 'threads' }, { chooseVariant: () => 'simd' });
    await loader.load();
    assert.equal(loader.stats.variant, 'simd', 'an unknown offered variant falls back to the probe');
  }
  {
    // A single glue (no variants) keeps its one URL whatever is offered.
    const global = {};
    const loader = createOpenCvRealmLoader({
      glueUrl: '/glue.js', getOffer: async () => ({ module: shared, variant: 'simd' }), compileOwn: async () => WebAssembly.compile(EMPTY),
      importGlue: async (url) => { imported.push(url); await fakeGlue(global)(); }, global
    });
    await loader.load();
    assert.equal(imported.at(-1), '/glue.js');
    assert.equal(loader.stats.variant, 'simd');
  }
}
console.log('ok opencvRuntime');
