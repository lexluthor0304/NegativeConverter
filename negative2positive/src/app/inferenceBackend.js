// WebKit can keep compiling the JSEP/Asyncify runtime after inference and grow
// past its process memory limit (WebKit #304810, ONNX Runtime #26827). Selecting
// the WASM provider in the WebGPU bundle is insufficient: load the non-JSEP
// runtime as well. WKWebView on macOS/iOS and Safari use the CPU path.
//
// One exception, by the shell's own answer and never by the user agent: the
// macOS desktop app on a system whose WebKit was measured not to grow
// (docs/macos-export-cancel.md). The page allows it for its realm after it
// asked the shell, and passes it to the AI repair worker with the session's
// options; a realm nobody told stays on the CPU path.
const WEBKIT_GPU_FROM = Object.freeze([27, 2]); // macOS 27.2: the first system measured

let webKitGpu = false;
export function allowWebKitGpuInference(allowed) { webKitGpu = allowed === true; }
export function webKitGpuInferenceAllowed() { return webKitGpu; }

/** Whether this shell's WebKit may run GPU inference: the macOS desktop app, system 27.2 or later. */
export function webKitGpuInferenceSafe(platform) {
  if (!platform || platform.shell !== 'tauri' || platform.os !== 'macos' || platform.mobile || platform.fallback || platform.simulated) return false;
  if (typeof platform.osVersion !== 'string' || !/^\d+(\.\d+){0,2}$/.test(platform.osVersion)) return false;
  const [major, minor = 0] = platform.osVersion.split('.').map(Number);
  return major > WEBKIT_GPU_FROM[0] || (major === WEBKIT_GPU_FROM[0] && minor >= WEBKIT_GPU_FROM[1]);
}

export function defaultInferencePreference({
  desktop = Boolean(globalThis.window?.__TAURI__),
  platform = globalThis.navigator?.platform || '',
  userAgent = globalThis.navigator?.userAgent || '',
  gpu = Boolean(globalThis.navigator?.gpu),
  webKitGpuAllowed = webKitGpu,
} = {}) {
  const webkit = /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
  if (!(webkit || (desktop && /^Mac/.test(platform)))) return 'webgpu';
  // Without WebGPU in this realm the JSEP runtime would only bring its risk.
  return webKitGpuAllowed && gpu ? 'webgpu' : 'wasm';
}
