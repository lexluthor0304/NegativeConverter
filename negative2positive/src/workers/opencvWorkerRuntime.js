// OpenCV in a worker realm (#252 part 5): asks the page for the session's
// compiled Module and instantiates it; compiles the wasm itself only when
// the page has none to give or it cannot be instantiated here.
//
// Each OpenCV worker's onmessage passes every message to
// `acceptOpenCvMessage` first (the page's reply is not a request), and
// calls `loadOpenCv()` where it used to import the 13 MB script.
import { opencvGlueUrl, opencvWasmUrl } from 'virtual:opencv-assets';
import { compileWasmFromUrl, createOpenCvModuleRequester, createOpenCvRealmLoader } from '../app/opencvRuntime.js';

// From the worker script's first statement: the realm's ready time is
// measured from here (performance marks, #252 acceptance).
const scriptStart = typeof performance !== 'undefined' ? performance.now() : 0;

const requester = createOpenCvModuleRequester({ post: message => self.postMessage(message) });

const loader = createOpenCvRealmLoader({
  glueUrl: opencvGlueUrl,
  getModule: () => requester.requestModule(),
  compileOwn: () => compileWasmFromUrl(opencvWasmUrl),
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
    try { performance.mark('opencv-ready', { detail: { sharedModule: loader.stats.sharedModule, sinceScriptMs: loader.stats.sinceScriptMs } }); } catch {}
  }
  return cv;
}

// For diagnostics replies: whether this realm instantiated the page's Module
// and how long it took from the script's first statement.
export function openCvRealmStats() {
  const { sharedModule, ownCompiles, readyMs, sinceScriptMs } = loader.stats;
  return { sharedModule, ownCompiles, readyMs, sinceScriptMs: sinceScriptMs ?? null,
    heapBytes: globalThis.cv?.HEAPU8?.buffer?.byteLength || 0 };
}
