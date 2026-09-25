// OpenCV compiled once per session and instantiated in every realm (#252
// part 5). The build splits the package into a wasm file and a small glue
// (scripts/opencv-assets.mjs); the glue calls its factory with
// `globalThis.__opencvModuleArg`, whose `instantiateWasm` hook is set here.
//
// The page compiles the wasm once (streaming when the server says
// application/wasm) and hands the compiled WebAssembly.Module to each OpenCV
// worker that asks for it; the worker instantiates it instead of parsing,
// decoding and compiling 12 MB again. A worker that gets no Module, or cannot
// instantiate the one it got, compiles on its own. The bytes are the
// package's in every case, so results cannot differ.
//
// Pure: fetch, WebAssembly and the glue import are injected.

/**
 * Compiles the wasm at `url`. Streaming when the response is served as
 * application/wasm; otherwise (or when streaming refuses it, as some custom
 * protocols' responses are) from the whole body.
 */
export async function compileWasmFromUrl(url, { fetchImpl = globalThis.fetch, wasm = globalThis.WebAssembly } = {}) {
  const response = await fetchImpl(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`OpenCV wasm request failed: ${response.status}`);
  const type = response.headers?.get?.('content-type') || '';
  if (typeof wasm.compileStreaming === 'function' && /application\/wasm/i.test(type)) {
    try {
      return await wasm.compileStreaming(response);
    } catch (error) {
      console.warn('OpenCV streaming compile failed, compiling the whole file:', error?.message || error);
      const again = await fetchImpl(url, { credentials: 'same-origin' });
      if (!again.ok) throw new Error(`OpenCV wasm request failed: ${again.status}`);
      return wasm.compile(await again.arrayBuffer());
    }
  }
  return wasm.compile(await response.arrayBuffer());
}

/**
 * The session's compiled module: `ensure()` compiles once (a failure is
 * retried by the next call), `adopt()` takes one compiled elsewhere,
 * `peek()` returns it or null.
 */
export function createOpenCvModuleCache({ compile, wasm = globalThis.WebAssembly } = {}) {
  let module = null;
  let compiling = null;
  let compiles = 0;
  const isModule = value => Boolean(value) && typeof wasm?.Module === 'function' && value instanceof wasm.Module;
  return {
    peek: () => module,
    adopt(value) {
      if (!module && isModule(value)) module = value;
      return module;
    },
    ensure() {
      if (module) return Promise.resolve(module);
      compiling ||= Promise.resolve().then(() => { compiles += 1; return compile(); }).then((value) => {
        module ||= value;
        return module;
      }, (error) => {
        compiling = null;
        throw error;
      });
      return compiling;
    },
    get compiles() { return compiles; }
  };
}

/**
 * Loads OpenCV into this realm once. `getModule()` resolves the page's
 * compiled Module (or null); `compileOwn()` compiles one here. Resolves the
 * ready `cv` (also set as `global.cv`). `stats` reports whether the shared
 * Module was used, the realm's own compile count and the time to ready.
 */
export function createOpenCvRealmLoader({ glueUrl, getModule, compileOwn, importGlue, global = globalThis, wasm = globalThis.WebAssembly, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) }) {
  let ready = null;
  const stats = { sharedModule: false, ownCompiles: 0, readyMs: null, module: null };
  const instantiateWith = async (imports) => {
    let offered = null;
    try { offered = await getModule(); } catch { offered = null; }
    if (offered) {
      try {
        const instance = await wasm.instantiate(offered, imports);
        stats.sharedModule = true;
        stats.module = offered;
        return { instance, module: offered };
      } catch (error) {
        console.warn('OpenCV shared module could not be instantiated here, compiling it again:', error?.message || error);
      }
    }
    stats.ownCompiles += 1;
    const own = await compileOwn();
    const instance = await wasm.instantiate(own, imports);
    stats.module = own;
    return { instance, module: own };
  };
  function load() {
    ready ||= (async () => {
      const started = now();
      let failInstantiate;
      const instantiateFailed = new Promise((_, reject) => { failInstantiate = reject; });
      global.__opencvModuleArg = {
        instantiateWasm(imports, done) {
          instantiateWith(imports).then(({ instance, module }) => done(instance, module), failInstantiate);
          return {};
        }
      };
      try {
        await importGlue(glueUrl);
        // The glue's hook never rejects its own ready promise on our errors.
        const cv = await Promise.race([global.cv, instantiateFailed]);
        if (!cv?.Mat) throw new Error('OpenCV initialized without Mat API');
        global.cv = cv;
        stats.readyMs = now() - started;
        return cv;
      } finally {
        delete global.__opencvModuleArg;
      }
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  }
  return { load, stats };
}

// Message types between the page and an OpenCV worker: the worker asks for
// the Module when it first needs OpenCV; the page answers with it or null.
export const OPENCV_MODULE_REQUEST = 'opencv-module-request';
export const OPENCV_MODULE_REPLY = 'opencv-module';

/**
 * Page side: answers a worker's request for the compiled Module. Returns
 * true when `data` was that request. A Module that cannot be cloned to this
 * worker (DataCloneError) is answered with null: the worker compiles itself.
 */
export function serveOpenCvModule(worker, data, ensureModule) {
  if (data?.type !== OPENCV_MODULE_REQUEST) return false;
  Promise.resolve().then(ensureModule).then(module => module, () => null).then((module) => {
    try { worker.postMessage({ type: OPENCV_MODULE_REPLY, opencvModule: module }); }
    catch {
      try { worker.postMessage({ type: OPENCV_MODULE_REPLY, opencvModule: null }); } catch {}
    }
  });
  return true;
}

// The page registers where its Module comes from (opencvModule.js); the
// worker clients, which Node tests import without the build's assets, only
// forward requests here. Without a source every request is answered null.
let moduleSource = null;
export function provideOpenCvModuleSource(ensureModule) {
  moduleSource = typeof ensureModule === 'function' ? ensureModule : null;
}

/**
 * Call first in an OpenCV worker's onmessage on the page: answers its
 * request for the compiled Module and returns true, or false for any other
 * message.
 */
export function answerOpenCvWorker(worker, data) {
  return serveOpenCvModule(worker, data, () => (moduleSource ? moduleSource() : null));
}

/**
 * Worker side: `requestModule()` asks the page once and resolves its Module
 * or null (null too after `timeoutMs`, for a page that never answers);
 * `accept(data)` returns true for the page's reply.
 */
export function createOpenCvModuleRequester({ post, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let settle = null;
  return {
    requestModule() {
      pending ||= new Promise((resolve) => {
        const timer = setTimer(() => resolve(null), timeoutMs);
        settle = (module) => { clearTimer(timer); resolve(module || null); };
        try { post({ type: OPENCV_MODULE_REQUEST }); } catch { settle(null); }
      });
      return pending;
    },
    accept(data) {
      if (data?.type !== OPENCV_MODULE_REPLY) return false;
      settle?.(data.opencvModule || null);
      return true;
    }
  };
}
