// Cross-origin isolation (#264 Part A): the response headers that make the
// app `crossOriginIsolated`, so SharedArrayBuffer planes, threaded ONNX
// Runtime and a threaded LibRaw build can be used. One source for the Vite dev
// and preview servers (vite.config.js); scripts/check-vercel-config.mjs and
// scripts/check-tauri-config.mjs hold both vercel.json files and
// tauri.conf.json to the same pair.
//
// `require-corp`, not `credentialless`: WebKit (WKWebView, WebKitGTK, Safari)
// does not implement `credentialless`. Every cross-origin load the app makes
// is a CORS request (the GitHub star count, the update manifest, the feedback
// API, Tauri IPC) or comes from a CDN that sends
// `Cross-Origin-Resource-Policy: cross-origin` (jsDelivr, lensfun's fallback),
// so nothing needs a CORP header of ours. Worker scripts need COEP on their
// own responses, which is why the pair goes on every response, not only on
// documents.
export const CROSS_ORIGIN_ISOLATION_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
});

// Every script the build emits is named `[name]-[hash]-coi.js` (#229 review
// R2-041). Until the release that turned the pair on, /assets/ was served
// `immutable` for a year and without COEP, so a returning browser reuses such
// a copy without asking, and an isolated page refuses a dedicated worker
// whose own response lacks COEP. Scripts whose content did not change in that
// release (libraw-wasm's worker, ONNX Runtime's chunk that its pthreads start
// from) would have kept their names. Binary assets (wasm, onnx, data, fonts)
// keep theirs: they are fetched from the same origin, where COEP asks nothing
// of them. scripts/check-dist-asset-names.mjs holds a build to this.
export const ISOLATED_SCRIPT_SUFFIX = '-coi';

/**
 * Output file names for vite.config.js, for the page build and the worker
 * bundles alike: Vite's own patterns with the suffix on every script.
 */
export function isolatedOutputNames(assetsDir = 'assets') {
  const script = `${assetsDir}/[name]-[hash]${ISOLATED_SCRIPT_SUFFIX}.js`;
  return {
    entryFileNames: script,
    chunkFileNames: script,
    assetFileNames: (asset) => (/\.m?js$/i.test(asset.names?.[0] ?? asset.name ?? '')
      ? `${assetsDir}/[name]-[hash]${ISOLATED_SCRIPT_SUFFIX}.[ext]`
      : `${assetsDir}/[name]-[hash].[ext]`),
  };
}
