// OpenCV compiled once per session and instantiated in every realm (#252
// part 5). The build splits the package into a wasm file and a small glue
// (scripts/opencv-assets.mjs); the glue calls its factory with
// `globalThis.__opencvModuleArg`, whose `instantiateWasm` hook is set here.
//
// The page compiles the wasm once (streaming when the server says
// application/wasm) and hands the compiled WebAssembly.Module to each OpenCV
// worker that asks for it; the worker instantiates it instead of parsing,
// decoding and compiling 12 MB again. A worker that gets no Module, or cannot
// instantiate the one it got, compiles on its own.
//
// Two builds of the same OpenCV ship (#292): the package's scalar module and
// a WASM SIMD build (public/codecs/opencv-simd.*). The page chooses once,
// before anything is fetched (`chooseOpenCvVariant`: a v128 probe through
// WebAssembly.validate, `?opencvSimd=0` to force the scalar build), and its
// reply to a worker's request names the variant with the Module, so every
// realm of a session runs the same bytes with the matching glue. A worker
// that gets no reply at all probes its own engine.
//
// Pure: fetch, WebAssembly and the glue import are injected.

// ---- Variant choice ---------------------------------------------------------
// A module only an engine with WASM SIMD validates (wasm-feature-detect's
// probe): one function that returns a v128 made by i8x16.splat.
export const WASM_SIMD_PROBE = Object.freeze([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function wasmSimdSupported(wasm = globalThis.WebAssembly) {
  try {
    return typeof wasm?.validate === 'function' && wasm.validate(new Uint8Array(WASM_SIMD_PROBE)) === true;
  } catch {
    return false;
  }
}

export const OPENCV_VARIANTS = Object.freeze(['simd', 'scalar']);
export const OPENCV_SIMD_SWITCH_PARAM = 'opencvSimd';
export const OPENCV_SIMD_SWITCH_STORAGE_KEY = 'nc_opencv_simd';

export function normalizeOpenCvVariant(value) {
  return OPENCV_VARIANTS.includes(value) ? value : null;
}

const readSwitch = value => (value === '0' ? 'scalar' : value === '1' ? 'simd' : null);

/**
 * Which build this page runs, decided once before any fetch: `?opencvSimd=0`
 * (or the kill switch `localStorage.nc_opencv_simd = '0'`) forces the scalar
 * build; otherwise, and with `=1`, the SIMD build wherever the engine
 * validates v128 (Chrome, WebView2, Safari and WKWebView 16.4+, WebKitGTK
 * 2.40+), the scalar build elsewhere (macOS 10.15's WebKit). Returns
 * `{ variant, simdSupported, forced, source }`; `source` is 'query',
 * 'storage' or 'probe'.
 */
export function chooseOpenCvVariant({ search = '', storage = null, wasm = globalThis.WebAssembly } = {}) {
  const simdSupported = wasmSimdSupported(wasm);
  let forced = null;
  let source = 'probe';
  try { forced = readSwitch(new URLSearchParams(search || '').get(OPENCV_SIMD_SWITCH_PARAM)); } catch { forced = null; }
  if (forced) {
    source = 'query';
  } else {
    try { forced = readSwitch(storage?.getItem?.(OPENCV_SIMD_SWITCH_STORAGE_KEY)); } catch { forced = null; }
    if (forced) source = 'storage';
  }
  const variant = simdSupported && forced !== 'scalar' ? 'simd' : 'scalar';
  return { variant, simdSupported, forced, source };
}

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
 * Loads OpenCV into this realm once. The page's offer comes first:
 * `getOffer()` resolves `{ module, variant }` (the compiled Module or null,
 * and the variant the page chose or null); the realm then imports the glue
 * of that variant (`glueUrls(variant)`, or the single `glueUrl`) and
 * instantiates the Module through the glue's hook, or compiles its own with
 * `compileOwn(variant)`. Without an offered variant `chooseVariant()` decides
 * (a page that never answers). `getModule()` is the one-variant form of the
 * offer. Resolves the ready `cv` (also set as `global.cv`). `stats` reports
 * the variant, whether the shared Module was used, the realm's own compile
 * count and the time to ready. A failure stays rejected: importing the
 * cached glue again cannot restart its factory. A fresh worker realm can
 * retry.
 */
export function createOpenCvRealmLoader({ glueUrl = null, glueUrls = null, getOffer = null, getModule = null, compileOwn, importGlue, chooseVariant = null, global = globalThis, wasm = globalThis.WebAssembly, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) }) {
  let ready = null;
  const stats = { sharedModule: false, ownCompiles: 0, readyMs: null, module: null, variant: null, offeredVariant: null };
  const glueUrlFor = variant => (typeof glueUrls === 'function' ? glueUrls(variant) : glueUrls?.[variant]) || glueUrl;
  const offerFromPage = async () => {
    try {
      if (getOffer) {
        const offer = await getOffer();
        return { module: offer?.module || null, variant: normalizeOpenCvVariant(offer?.variant) };
      }
      if (getModule) return { module: (await getModule()) || null, variant: null };
    } catch { /* no offer: compile here */ }
    return { module: null, variant: null };
  };
  const instantiateWith = async (imports, offered, variant) => {
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
    const own = await compileOwn(variant);
    const instance = await wasm.instantiate(own, imports);
    stats.module = own;
    return { instance, module: own };
  };
  function load() {
    ready ||= (async () => {
      const started = now();
      const offer = await offerFromPage();
      const variant = offer.variant || (chooseVariant ? normalizeOpenCvVariant(chooseVariant()) : null) || (glueUrls ? 'scalar' : null);
      stats.variant = variant;
      stats.offeredVariant = offer.variant;
      const url = glueUrlFor(variant);
      if (!url) throw new Error(`no OpenCV glue for the ${variant} variant`);
      let failInstantiate;
      const instantiateFailed = new Promise((_, reject) => { failInstantiate = reject; });
      global.__opencvModuleArg = {
        instantiateWasm(imports, done) {
          instantiateWith(imports, offer.module, variant).then(({ instance, module }) => done(instance, module), failInstantiate);
          return {};
        }
      };
      try {
        await importGlue(url);
        // The glue's hook never rejects its own ready promise on our errors.
        const cv = await Promise.race([global.cv, instantiateFailed]);
        if (!cv?.Mat) throw new Error('OpenCV initialized without Mat API');
        global.cv = cv;
        stats.readyMs = now() - started;
        return cv;
      } finally {
        delete global.__opencvModuleArg;
      }
    })();
    return ready;
  }
  return { load, stats };
}

// Message types between the page and an OpenCV worker: the worker asks for
// the Module when it first needs OpenCV; the page answers with it or null.
export const OPENCV_MODULE_REQUEST = 'opencv-module-request';
export const OPENCV_MODULE_REPLY = 'opencv-module';

/**
 * Page side: answers a worker's request with the compiled Module and the
 * page's `variant` ('simd' | 'scalar', or null when unknown). Returns true
 * when `data` was that request. A Module that cannot be cloned to this
 * worker (DataCloneError), or a compile that failed, is answered with null:
 * the worker compiles the same variant itself.
 */
export function serveOpenCvModule(worker, data, ensureModule, variant = null) {
  if (data?.type !== OPENCV_MODULE_REQUEST) return false;
  const chosen = normalizeOpenCvVariant(variant);
  Promise.resolve().then(ensureModule).then(module => module, () => null).then((module) => {
    try { worker.postMessage({ type: OPENCV_MODULE_REPLY, opencvModule: module, variant: chosen }); }
    catch {
      try { worker.postMessage({ type: OPENCV_MODULE_REPLY, opencvModule: null, variant: chosen }); } catch {}
    }
  });
  return true;
}

// The page registers where its Module comes from and which variant it is
// (opencvModule.js); the worker clients, which Node tests import without the
// build's assets, only forward requests here. Without a source every request
// is answered null.
let moduleSource = null;
let moduleVariant = null;
export function provideOpenCvModuleSource(ensureModule, variant = null) {
  moduleSource = typeof ensureModule === 'function' ? ensureModule : null;
  moduleVariant = moduleSource ? normalizeOpenCvVariant(variant) : null;
}

/**
 * Call first in an OpenCV worker's onmessage on the page: answers its
 * request for the compiled Module and returns true, or false for any other
 * message.
 */
export function answerOpenCvWorker(worker, data) {
  return serveOpenCvModule(worker, data, () => (moduleSource ? moduleSource() : null), moduleVariant);
}

/**
 * Worker side: `requestOffer()` asks the page once and resolves
 * `{ module, variant }` (null members after `timeoutMs`, for a page that
 * never answers); `requestModule()` resolves the Module alone; `accept(data)`
 * returns true for the page's reply.
 */
export function createOpenCvModuleRequester({ post, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let pendingModule = null;
  let settle = null;
  const request = () => {
    pending ||= new Promise((resolve) => {
      const timer = setTimer(() => resolve({ module: null, variant: null }), timeoutMs);
      settle = (reply) => { clearTimer(timer); resolve({ module: reply?.opencvModule || null, variant: normalizeOpenCvVariant(reply?.variant) }); };
      try { post({ type: OPENCV_MODULE_REQUEST }); } catch { settle(null); }
    });
    return pending;
  };
  return {
    requestOffer: request,
    requestModule: () => (pendingModule ||= request().then(offer => offer.module)),
    accept(data) {
      if (data?.type !== OPENCV_MODULE_REPLY) return false;
      settle?.(data);
      return true;
    }
  };
}
