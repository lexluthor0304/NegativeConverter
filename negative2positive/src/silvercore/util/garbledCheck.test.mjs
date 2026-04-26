// Standalone Node test for garbledCheck.js — run with: node garbledCheck.test.mjs

import assert from 'node:assert/strict';
import { looksLikeBayerSnow } from './garbledCheck.js';

const W = 64, H = 64;

function make(width, height, fill) {
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

// 1. Pure white-noise → should look like snow
{
  // Deterministic PRNG so tests are reproducible
  let state = 1;
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state; };
  const noise = make(W, H, () => [rand() & 0xffff, rand() & 0xffff, rand() & 0xffff, 65535]);
  assert.equal(looksLikeBayerSnow(noise), true, 'noise should be flagged as snow');
}

// 2. Smooth gradient → should NOT be snow
{
  const grad = make(W, H, (x, y) => {
    const v = Math.round((x / (W - 1)) * 65535);
    const u = Math.round((y / (H - 1)) * 65535);
    return [v, u, (v + u) >> 1, 65535];
  });
  assert.equal(looksLikeBayerSnow(grad), false, 'smooth gradient should not be snow');
}

// 3. Dark, low-contrast scene (mimicking film shadow region) → should NOT be snow
{
  // Values in [200, 800] (≈0.3-1.2% of full range), tiny sinusoidal modulation
  const dark = make(W, H, (x, y) => {
    const v = 500 + Math.round(150 * Math.sin(x * 0.3) * Math.cos(y * 0.3));
    return [v, v, v, 65535];
  });
  assert.equal(looksLikeBayerSnow(dark), false, 'dark low-contrast scene should not be snow');
}

// 4. High-contrast checkerboard (16-pixel blocks) → still NOT snow (large smooth regions)
{
  const checker = make(W, H, (x, y) => {
    const v = ((x >> 4) + (y >> 4)) & 1 ? 60000 : 5000;
    return [v, v, v, 65535];
  });
  assert.equal(looksLikeBayerSnow(checker), false, 'large-block checkerboard should not be snow');
}

// 5. 8-bit input (Uint8ClampedArray) → still works correctly
{
  // Use Math.random — LCG low bits have poor spectral properties for this test.
  // Statistical detection doesn't need a deterministic seed; we just need true noise.
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (Math.random() * 256) | 0;
    data[i + 1] = (Math.random() * 256) | 0;
    data[i + 2] = (Math.random() * 256) | 0;
    data[i + 3] = 255;
  }
  assert.equal(looksLikeBayerSnow({ width: W, height: H, data }), true, '8-bit noise should also be flagged');
}

// 6. Edge cases
{
  assert.equal(looksLikeBayerSnow(null), false);
  assert.equal(looksLikeBayerSnow({}), false);
  assert.equal(looksLikeBayerSnow({ width: 2, height: 2, data: new Uint16Array(16) }), false, 'tiny image returns false safely');
}

console.log('garbledCheck tests: all passed');
