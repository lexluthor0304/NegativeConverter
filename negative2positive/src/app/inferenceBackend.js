// WebKit can keep compiling the JSEP/Asyncify runtime after inference and grow
// past its process memory limit (WebKit #304810, ONNX Runtime #26827). Selecting
// the WASM provider in the WebGPU bundle is insufficient: load the non-JSEP
// runtime as well. WKWebView on macOS/iOS and Safari use the CPU path.
export function defaultInferencePreference({
  desktop = Boolean(globalThis.window?.__TAURI__),
  platform = globalThis.navigator?.platform || '',
  userAgent = globalThis.navigator?.userAgent || '',
} = {}) {
  const webkit = /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
  return webkit || (desktop && /^Mac/.test(platform)) ? 'wasm' : 'webgpu';
}
