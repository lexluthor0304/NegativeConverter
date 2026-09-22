import assert from 'node:assert/strict';
import { applyUnsharpMask } from './Sharpening.js';

// Independent full-plane Gaussian reference, including the original Float32
// storage boundaries. Compare exact 16-bit samples, not a visual tolerance.
function reference(image, { radius, amount, threshold }) {
  const { width, height } = image;
  const data = image.data.slice();
  const half = Math.ceil(radius * 3);
  const kernel = new Float32Array(half * 2 + 1);
  let weight = 0;
  for (let k = -half; k <= half; k++) {
    kernel[k + half] = Math.exp(-(k * k) / (2 * radius * radius));
    weight += kernel[k + half];
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= weight;
  const luma = new Float32Array(width * height);
  const horizontal = new Float32Array(luma.length);
  const blurred = new Float32Array(luma.length);
  for (let p = 0; p < luma.length; p++) luma[p] = .299 * data[p * 4] + .587 * data[p * 4 + 1] + .114 * data[p * 4 + 2];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += luma[y * width + Math.max(0, Math.min(width - 1, x + k))] * kernel[k + half];
    horizontal[y * width + x] = sum;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x] * kernel[k + half];
    blurred[y * width + x] = sum;
  }
  for (let p = 0; p < luma.length; p++) {
    const diff = luma[p] - blurred[p];
    if (Math.abs(diff) < threshold * 257) continue;
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.max(0, Math.min(65535, data[p * 4 + c] + (amount / 100) * diff + .5)) | 0;
  }
  return data;
}

for (const [width, height] of [[53, 31], [1, 1], [1, 17], [23, 1], [3, 2]]) {
  const source = { width, height, data: Uint16Array.from({ length: width * height * 4 }, (_, i) => (i * 571 + i * i * 37) % 65536) };
  for (const radius of [.5, 1, 1.9, 3]) for (const threshold of [0, 12]) for (const amount of [75, 200]) {
    const params = { radius, threshold, amount };
    const copy = { ...source, data: source.data.slice() };
    applyUnsharpMask(copy, params);
    assert.deepEqual(copy.data, reference(source, params), `${width}x${height}: ${JSON.stringify(params)}`);
    for (let i = 3; i < copy.data.length; i += 4) assert.equal(copy.data[i], source.data[i], 'alpha unchanged');
  }
}

// A 24 MP image must never allocate a frame-sized scratch plane.
const nativeFloat32 = globalThis.Float32Array;
let bytes = 0;
globalThis.Float32Array = class extends nativeFloat32 {
  constructor(...args) { super(...args); bytes += this.byteLength; }
};
try {
  applyUnsharpMask({ width: 6000, height: 4000, data: new Uint16Array(6000 * 4000 * 4) }, { radius: 1, amount: 75 });
} finally { globalThis.Float32Array = nativeFloat32; }
assert.ok(bytes <= 6000 * 8 * 4, `row scratch only: ${bytes} bytes`);
console.log('Sharpening: exact Gaussian output, edges, alpha, and bounded scratch memory passed');
