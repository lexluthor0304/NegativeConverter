// The page's side of the shared OpenCV module (#252 part 5, opencvRuntime.js):
// the one compile of the session, the answer to OpenCV workers asking for it,
// and the hook the page's own OpenCV realm instantiates it through.
import { opencvGlueUrl, opencvWasmUrl } from 'virtual:opencv-assets';
import { compileWasmFromUrl, createOpenCvModuleCache, provideOpenCvModuleSource } from './opencvRuntime.js';

export { opencvGlueUrl, opencvWasmUrl };

const cache = createOpenCvModuleCache({ compile: () => compileWasmFromUrl(opencvWasmUrl) });

export function ensureOpenCvModule() {
  return cache.ensure();
}

export function openCvModuleCompiles() {
  return cache.compiles;
}

// OpenCV workers' requests (answerOpenCvWorker in their clients) get this Module.
provideOpenCvModuleSource(ensureOpenCvModule);

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
