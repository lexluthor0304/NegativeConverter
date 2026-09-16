import assert from 'node:assert/strict';
import { defaultInferencePreference } from './inferenceBackend.js';
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
