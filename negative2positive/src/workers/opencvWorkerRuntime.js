// OpenCV in a worker realm (#252 part 5): asks the page for the session's
// compiled Module and the variant it chose (#292), imports that variant's
// glue and instantiates the Module; compiles the wasm itself only when the
// page has none to give or it cannot be instantiated here. A page that never
// answers (none in the app) leaves the choice to this realm's own v128 probe.
//
// Each OpenCV worker's onmessage passes every message to
// `acceptOpenCvMessage` first (the page's reply is not a request), and
// calls `loadOpenCv()` where it used to import the 13 MB script.
import { opencvGlueUrl, opencvWasmUrl, opencvSimdGlueUrl, opencvSimdWasmUrl } from 'virtual:opencv-assets';
import { compileWasmFromUrl, createOpenCvModuleRequester, createOpenCvRealmLoader, wasmSimdSupported } from '../app/opencvRuntime.js';

// From the worker script's first statement: the realm's ready time is
// measured from here (performance marks, #252 acceptance).
const scriptStart = typeof performance !== 'undefined' ? performance.now() : 0;

const URLS = Object.freeze({
  scalar: { glue: opencvGlueUrl, wasm: opencvWasmUrl },
  simd: { glue: opencvSimdGlueUrl, wasm: opencvSimdWasmUrl }
});

const requester = createOpenCvModuleRequester({ post: message => self.postMessage(message) });

const loader = createOpenCvRealmLoader({
  glueUrls: variant => URLS[variant].glue,
  getOffer: () => requester.requestOffer(),
  compileOwn: variant => compileWasmFromUrl(URLS[variant].wasm),
  chooseVariant: () => (wasmSimdSupported() ? 'simd' : 'scalar'),
  importGlue: url => import(/* @vite-ignore */ url)
});

export function acceptOpenCvMessage(data) {
  return requester.accept(data);
}

export async function loadOpenCv() {
  const cv = await loader.load();
  if (typeof performance !== 'undefined' && !loader.stats.marked) {
    loader.stats.marked = true;
    loader.stats.sinceScriptMs = performance.now() - scriptStart;
    try { performance.mark('opencv-ready', { detail: { sharedModule: loader.stats.sharedModule, variant: loader.stats.variant, sinceScriptMs: loader.stats.sinceScriptMs } }); } catch {}
  }
  return cv;
}

// For diagnostics replies: which variant this realm runs, whether it
// instantiated the page's Module and how long it took from the script's
// first statement.
export function openCvRealmStats() {
  const { sharedModule, ownCompiles, readyMs, sinceScriptMs, variant, offeredVariant } = loader.stats;
  return { sharedModule, ownCompiles, readyMs, sinceScriptMs: sinceScriptMs ?? null, variant, offeredVariant,
    heapBytes: globalThis.cv?.HEAPU8?.buffer?.byteLength || 0 };
}
