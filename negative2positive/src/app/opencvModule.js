// The page's side of the shared OpenCV module (#252 part 5, opencvRuntime.js):
// the variant this session runs (#292), the one compile of the session, the
// answer to OpenCV workers asking for it, and the hook the page's own OpenCV
// realm instantiates it through.
import { opencvGlueUrl, opencvWasmUrl, opencvSimdGlueUrl, opencvSimdWasmUrl } from 'virtual:opencv-assets';
import { chooseOpenCvVariant, compileWasmFromUrl, createOpenCvModuleCache, provideOpenCvModuleSource } from './opencvRuntime.js';

export { opencvGlueUrl, opencvWasmUrl, opencvSimdGlueUrl, opencvSimdWasmUrl };

const URLS = Object.freeze({
  scalar: { glue: opencvGlueUrl, wasm: opencvWasmUrl },
  simd: { glue: opencvSimdGlueUrl, wasm: opencvSimdWasmUrl }
});

function pageStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// Decided once, when this module evaluates, before any OpenCV fetch: the
// SIMD build where WebAssembly validates v128, the package's scalar build
// otherwise or with ?opencvSimd=0 (chooseOpenCvVariant). Workers get the
// variant with the Module.
const choice = chooseOpenCvVariant({ search: globalThis.location?.search || '', storage: pageStorage() });
export const openCvVariant = choice.variant;
export const openCvPageGlueUrl = URLS[choice.variant].glue;
export const openCvPageWasmUrl = URLS[choice.variant].wasm;

const cache = createOpenCvModuleCache({ compile: () => compileWasmFromUrl(openCvPageWasmUrl) });

export function ensureOpenCvModule() {
  return cache.ensure();
}

export function openCvModuleCompiles() {
  return cache.compiles;
}

// OpenCV workers' requests (answerOpenCvWorker in their clients) get this
// Module and the variant.
provideOpenCvModuleSource(ensureOpenCvModule, openCvVariant);

/** For the isolation report and ?debug=1: which build runs and why. */
export function describeOpenCvRuntime() {
  return {
    variant: choice.variant,
    simdSupported: choice.simdSupported,
    forced: choice.forced,
    source: choice.source,
    wasmUrl: openCvPageWasmUrl,
    glueUrl: openCvPageGlueUrl,
    compiles: cache.compiles,
    compiled: Boolean(cache.peek())
  };
}

/**
 * The page's realm: the glue script (loaded by opencvLoader.js) finds this
 * hook and instantiates the session's Module. Installed before the script
 * tag is added; the glue reads it once.
 */
export function installPageOpenCvHook(global = globalThis) {
  global.__opencvModuleArg = {
    instantiateWasm(imports, done) {
      ensureOpenCvModule()
        .then(module => WebAssembly.instantiate(module, imports).then(instance => done(instance, module)))
        .catch(error => console.error('OpenCV could not be instantiated on the page:', error));
      return {};
    }
  };
}
