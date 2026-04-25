// Stage 3 smoke test — exercise the full SilverCore 16-bit pipeline end-to-end
// without browser globals. We synthesize a 16-bit gradient image, hand it to
// silverAdapter.runSilverCore, and verify the output is a sane Image16.
//
// Run: node negative2positive/src/silvercore/util/silvercore16.smoke.mjs
//
// What this proves:
//   - CurveEngine generates 65536-entry Uint16Array LUTs
//   - ImageProcessor reads/writes Uint16Array data correctly
//   - silverAdapter accepts Image16 input via __image16 attachment
//   - End-to-end output is a valid Image16 with values in [0, 65535]

import assert from 'node:assert/strict';
import { createImage16, IMAGE16_MAX } from './image16.js';

// Provide a minimal ImageData shim so toImageData8 inside silverAdapter doesn't
// crash. We don't use the result for anything that needs real ImageData semantics.
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// Synthesize a 64×64 16-bit RGBA gradient negative — R goes high→low across X,
// G goes low→high across Y, B is mid. Channels span the full 16-bit range so
// histogram analysis sees real contrast.
function makeGradient16(w, h) {
  const img = createImage16(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      data[idx]     = Math.round(((w - 1 - x) / (w - 1)) * IMAGE16_MAX);
      data[idx + 1] = Math.round((y / (h - 1)) * IMAGE16_MAX);
      data[idx + 2] = IMAGE16_MAX >>> 1;
      data[idx + 3] = IMAGE16_MAX;
    }
  }
  return img;
}

const W = 64, H = 64;
const image16 = makeGradient16(W, H);

// Wrap as ImageData-like with __image16 attachment, mirroring what main.js loaders produce.
const fakeImageData = {
  width: W,
  height: H,
  data: new Uint8ClampedArray(W * H * 4),
  __image16: image16,
};

// Dynamic import so the Engine's profile fetch (resources/profiles/*.bin via fetch())
// is only constructed lazily — and only triggered when a non-'none' enhancedProfile
// is requested. Default settings use 'none', so no fetch happens.
const { convertColorWithSilverCore } = await import('../../pipeline/silverAdapter.js');

console.log(`Input: ${W}×${H} 16-bit gradient (R falloff, G ramp, B=midgray)`);
console.log(`  Sample input pixel (0,0) → R=${image16.data[0]}, G=${image16.data[1]}, B=${image16.data[2]}`);
console.log(`  Sample input pixel (${W-1},${H-1}) → R=${image16.data[(H*W-1)*4]}, G=${image16.data[(H*W-1)*4+1]}`);

const start = Date.now();
const result = await convertColorWithSilverCore(fakeImageData, {
  filmType: 'color',
  filmBase: { r: 210, g: 140, b: 90 },
  filmPreset: 'none',
  colorModel: 'standard',
  enhancedProfile: 'none',
  brightness: 0,
  exposure: 0,
  contrast: 0,
  saturation: 100,
  temperature: 0,
  tint: 0,
});
const elapsed = Date.now() - start;

console.log(`\nSilverCore returned in ${elapsed}ms`);

// Result should be ImageData-like with __image16 attached
assert.ok(result, 'result is null/undefined');
assert.equal(result.width, W);
assert.equal(result.height, H);
assert.ok(result.__image16, 'result is missing __image16');
const out16 = result.__image16;
assert.ok(out16.data instanceof Uint16Array, 'result.__image16.data is not Uint16Array');
assert.equal(out16.data.length, W * H * 4);

// Validate range — every channel must be in [0, 65535]
let minR = 65535, maxR = 0, minG = 65535, maxG = 0, minB = 65535, maxB = 0;
for (let i = 0; i < out16.data.length; i += 4) {
  if (out16.data[i] < minR) minR = out16.data[i];
  if (out16.data[i] > maxR) maxR = out16.data[i];
  if (out16.data[i + 1] < minG) minG = out16.data[i + 1];
  if (out16.data[i + 1] > maxG) maxG = out16.data[i + 1];
  if (out16.data[i + 2] < minB) minB = out16.data[i + 2];
  if (out16.data[i + 2] > maxB) maxB = out16.data[i + 2];
  assert.ok(out16.data[i] <= IMAGE16_MAX, `R channel out of range at ${i}: ${out16.data[i]}`);
  assert.ok(out16.data[i + 1] <= IMAGE16_MAX, `G channel out of range at ${i}: ${out16.data[i + 1]}`);
  assert.ok(out16.data[i + 2] <= IMAGE16_MAX, `B channel out of range at ${i}: ${out16.data[i + 2]}`);
}

console.log(`Output range:`);
console.log(`  R: [${minR}, ${maxR}]`);
console.log(`  G: [${minG}, ${maxG}]`);
console.log(`  B: [${minB}, ${maxB}]`);

// Stage 3 sanity: the output should differ from the input (negative was inverted).
let diffPixels = 0;
for (let i = 0; i < out16.data.length; i += 4) {
  if (out16.data[i] !== image16.data[i]
   || out16.data[i + 1] !== image16.data[i + 1]
   || out16.data[i + 2] !== image16.data[i + 2]) diffPixels++;
}
const totalPixels = W * H;
console.log(`Pixels changed by SilverCore: ${diffPixels}/${totalPixels} (${(100*diffPixels/totalPixels).toFixed(1)}%)`);
assert.ok(diffPixels > totalPixels * 0.5, 'SilverCore did not transform most pixels — pipeline may be broken');

// Stage 3 sanity: at least one pixel exceeds the 8-bit boundary (256-multiple precision)
// — i.e., not just multiples of 257 (which would imply a hidden 8-bit downscale + ×257 upscale).
let nonByteAlignedPixels = 0;
for (let i = 0; i < out16.data.length; i += 4) {
  if (out16.data[i] % 257 !== 0 || out16.data[i + 1] % 257 !== 0 || out16.data[i + 2] % 257 !== 0) {
    nonByteAlignedPixels++;
  }
}
console.log(`Pixels with sub-8-bit precision: ${nonByteAlignedPixels}/${totalPixels} (${(100*nonByteAlignedPixels/totalPixels).toFixed(1)}%)`);
assert.ok(nonByteAlignedPixels > 0, 'No sub-8-bit precision detected — 16-bit pipeline may be silently downscaling');

console.log('\n✓ SilverCore 16-bit smoke passed');
