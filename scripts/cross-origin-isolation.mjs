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
