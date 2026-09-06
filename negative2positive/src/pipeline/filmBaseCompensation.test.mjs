// Standalone Node test for filmBaseCompensation.js - run with:
// node negative2positive/src/pipeline/filmBaseCompensation.test.mjs

import assert from 'node:assert/strict';
import {
  applyFilmBaseCompensationToBuffer,
  computeFilmBaseGains
} from './filmBaseCompensation.js';

const base = { r: 210, g: 140, b: 90 };
const linear = computeFilmBaseGains(base, { method: 'linear' });
const density = computeFilmBaseGains(base, { method: 'density' });

assert.equal(linear.method, 'linear');
assert.equal(density.method, 'density');
assert.notEqual(linear.r, density.r);
assert.notEqual(linear.b, density.b);
assert.ok(density.r < 1);
assert.ok(density.b > 1);

const precise = { r16: 52000, g16: 35000, b16: 24000 };
const preciseGains = computeFilmBaseGains(precise, { method: 'density' });
assert.ok(preciseGains.r < 1);
assert.ok(preciseGains.b > 1);

const halfStrength = computeFilmBaseGains(precise, { method: 'density', strength: 0.5 });
assert.ok(halfStrength.r > preciseGains.r);
assert.ok(halfStrength.b < preciseGains.b);

const pixels = new Uint16Array([
  precise.r16, precise.g16, precise.b16, 65535,
  30000, 22000, 12000, 65535
]);
const applied = applyFilmBaseCompensationToBuffer(pixels, precise, { method: 'density' });
assert.equal(applied.method, 'density');
assert.ok(Math.abs(pixels[0] - pixels[1]) <= 1);
assert.ok(Math.abs(pixels[1] - pixels[2]) <= 1);
assert.equal(pixels[3], 65535);

console.log('filmBaseCompensation.test.mjs passed');

// 16-bit の全 65536 値・両方式・強度・キャッシュ切替で従来式と厳密一致する。
for (const filmBase of [base, precise, { r16: 1, g16: 65535, b16: 30000 }]) {
  for (const method of ['density', 'linear']) for (const strength of [0, .5, 1, 1.5]) {
    const options = { method, strength };
    const gains = computeFilmBaseGains(filmBase, options);
    const input = new Uint16Array(262144 * 4);
    for (let p = 0; p < 262144; p++) input.set([p & 65535, (65535 - p) & 65535, (p * 173) & 65535, p & 65535], p * 4);
    const expected = input.slice();
    for (let i = 0; i < expected.length; i += 4) for (const [c, gain] of [gains.r, gains.g, gains.b].entries()) {
      expected[i + c] = Math.max(0, Math.min(65535, Math.round(expected[i + c] * gain)));
    }
    assert.deepEqual(applyFilmBaseCompensationToBuffer(input, filmBase, options), gains);
    assert.deepEqual(input, expected);
  }
}
console.log('filmBaseCompensation: 大画像 LUT と従来式の全階調一致を検証');
