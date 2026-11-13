import assert from 'node:assert/strict';
import { defaultInferencePreference, webKitGpuInferenceSafe, allowWebKitGpuInference, webKitGpuInferenceAllowed } from './inferenceBackend.js';
assert.equal(defaultInferencePreference({ desktop: true, platform: 'MacIntel' }), 'wasm');
assert.equal(defaultInferencePreference({ desktop: false, platform: 'MacIntel' }), 'webgpu');
assert.equal(defaultInferencePreference({ desktop: true, platform: 'Win32' }), 'webgpu');
assert.equal(defaultInferencePreference({ desktop: true, platform: 'Linux x86_64' }), 'webgpu');
for (const userAgent of [
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15',
]) assert.equal(defaultInferencePreference({ userAgent }), 'wasm');
assert.equal(defaultInferencePreference({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' }), 'webgpu');
console.log('WebKit uses the non-JSEP WASM runtime; Chromium keeps GPU inference');

// The macOS desktop app from system 27.2, by the shell's answer only.
const mac = { shell: 'tauri', os: 'macos', mobile: false, osVersion: '27.2' };
assert.equal(webKitGpuInferenceSafe(mac), true);
for (const osVersion of ['27.2.1', '27.10', '28.0', '28']) assert.equal(webKitGpuInferenceSafe({ ...mac, osVersion }), true, osVersion);
for (const osVersion of ['27.1', '27.1.9', '27', '26.6.2', '15.7', '', null, undefined, '27.2 beta', 'x', 27.2]) {
  assert.equal(webKitGpuInferenceSafe({ ...mac, osVersion }), false, String(osVersion));
}
for (const other of [null, { ...mac, os: 'ios', mobile: true }, { ...mac, os: 'linux' }, { ...mac, shell: 'web' }, { ...mac, fallback: true }, { ...mac, simulated: true }, { ...mac, mobile: true }]) {
  assert.equal(webKitGpuInferenceSafe(other), false);
}
const wkMac = { desktop: true, platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15' };
assert.equal(webKitGpuInferenceAllowed(), false);
assert.equal(defaultInferencePreference({ ...wkMac, gpu: true }), 'wasm');
assert.equal(defaultInferencePreference({ ...wkMac, gpu: true, webKitGpuAllowed: true }), 'webgpu');
assert.equal(defaultInferencePreference({ ...wkMac, gpu: false, webKitGpuAllowed: true }), 'wasm');
allowWebKitGpuInference(true);
assert.equal(defaultInferencePreference({ ...wkMac, gpu: true }), 'webgpu');
allowWebKitGpuInference('yes');
assert.equal(webKitGpuInferenceAllowed(), false);
console.log('the macOS app runs GPU inference from system 27.2, where the realm has WebGPU and was told so');
