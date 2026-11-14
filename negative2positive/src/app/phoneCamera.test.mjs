import assert from 'node:assert/strict';
import { preferredScanCamera } from './phoneCamera.js';

const cameras = (...labels) => labels.map((label, index) => ({ kind: 'videoinput', deviceId: `id${index}`, label }));

// iPhone Pro: the triple camera does the macro switch by itself.
assert.equal(preferredScanCamera(cameras('Front Camera', 'Back Camera', 'Back Ultra Wide Camera', 'Back Telephoto Camera', 'Back Triple Camera', 'Back Dual Wide Camera')), 'id4');
// iPhone without a telephoto lens.
assert.equal(preferredScanCamera(cameras('Front Camera', 'Back Camera', 'Back Ultra Wide Camera', 'Back Dual Wide Camera')), 'id3');
// The same phones in Chinese and Japanese.
assert.equal(preferredScanCamera(cameras('前置摄像头', '后置摄像头', '后置三镜头摄像头')), 'id2');
assert.equal(preferredScanCamera(cameras('前面カメラ', '背面カメラ', '背面デュアル広角カメラ')), 'id2');
// A camera that says macro wins, but not a front one.
assert.equal(preferredScanCamera(cameras('camera2 0, facing back', 'Back Macro Camera', 'Back Triple Camera')), 'id1');
assert.equal(preferredScanCamera(cameras('Front Macro Camera', 'Back Camera')), null);
// Nothing to prefer: a single back camera, a laptop, labels not readable yet, no list.
assert.equal(preferredScanCamera(cameras('Back Camera', 'Front Camera')), null);
assert.equal(preferredScanCamera(cameras('FaceTime HD Camera', 'iPhone Camera')), null);
assert.equal(preferredScanCamera(cameras('', '')), null);
assert.equal(preferredScanCamera([{ kind: 'audioinput', deviceId: 'mic', label: 'Macro microphone' }]), null);
assert.equal(preferredScanCamera(null), null);

console.log('phoneCamera tests passed');
