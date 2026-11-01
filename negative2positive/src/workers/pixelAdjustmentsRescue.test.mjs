// Standalone Node test: the Step-3 kernels' inline expired-rescue tone path
// (every photo's automatic colour correction) gives exactly the samples the
// stage functions give through a Float32Array - run with:
// node negative2positive/src/workers/pixelAdjustmentsRescue.test.mjs
//
// The 8-bit kernel is checked on all 2^24 RGB inputs, the 16-bit one on a
// fixed-seed sample of 2^20 triples, both with a neutral tail (where the
// output is the stage's own value) and with curves, CMY, gains and contrast
// after it (compared with the same tail applied to the stage's value).

import assert from 'node:assert/strict';
import { applyExpiredTone, EXPIRED_RESCUE_VERSION } from '../pipeline/expiredRescue.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';
import { applyAdjustmentsToPixels16, curveAt } from './pixelAdjustments16.js';

const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
const sCurve = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 / (1 + Math.exp(-(v - 128) / 40))));
// A cast that leans differently by tone, so the luminance-indexed offsets move.
const lums = [0.03, 0.1, 0.22, 0.37, 0.52, 0.67, 0.82, 0.95];
const analysis = {
  version: EXPIRED_RESCUE_VERSION, bits: 8, samples: 10000,
  lumLow: 0.04, lumHigh: 0.93, lumMedian: 0.4, leveledMedian: 0.38,
  bands: lums.map((lum, k) => ({ lum, mean: [lum + 0.04 - 0.01 * k, lum - 0.01 + 0.005 * k, lum - 0.05 + 0.008 * k], share: 0.125 })),
  lean: [0.03, 0, -0.02], neutralShare: 0.5
};
const rescue = {
  expiredEnabled: true, expiredAnalysis: analysis, expiredLevels: 100, expiredNeutralize: 100,
  expiredCrossover: 100, expiredBrightness: 15, expiredContrast: 25, expiredUnevenFog: 0, expiredLocalContrast: 0
};
const base = { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, vibrance: 0, highlights: 0, shadows: 0,
  cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1, curves: { r: identity, g: identity, b: identity } };
const neutral = computeAdjustmentParams({ ...base, ...rescue });
assert.equal(neutral.doRescuePixel, true, 'the offsets make the rescue a per-pixel stage');
assert.ok(neutral.rescueStages.offsets, 'the test cast produces offsets');
const tailed = computeAdjustmentParams({ ...base, ...rescue, curves: { r: sCurve, g: identity, b: sCurve },
  cyan: 4, yellow: -3, wbR: 1.04, wbB: 0.97, contrast: 12 });
assert.equal(tailed.doRescuePixel, true);

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
// The rest of the 16-bit chain after the rescue, as the kernel writes it.
function tail16(p, c, v) {
  const mult = [p.rMult, p.gMult, p.bMult][c];
  let x = v * mult;
  if (p.doContrast) x = (x - 127.5) * p.contrastFactor + 127.5;
  x = clamp255(x);
  if (p.doCMY) x = clamp255(x - [p.cmyRShift, p.cmyGShift, p.cmyBShift][c]);
  return Math.round(curveAt([p.curveR, p.curveG, p.curveB][c], x) * (65535 / 255));
}
// The rest of the 8-bit chain after the rescue (no HSL: rounded before CMY).
function tail8(p, c, v) {
  const mult = [p.rMult, p.gMult, p.bMult][c];
  let x = v * mult;
  if (p.doContrast) x = (x - 127.5) * p.contrastFactor + 127.5;
  x = (clamp255(x) + 0.5) | 0;
  if (p.doCMY) x = clamp255(x - [p.cmyRShift, p.cmyGShift, p.cmyBShift][c]);
  return [p.curveR, p.curveG, p.curveB][c][(x + 0.5) | 0];
}

// 8-bit: every RGB triple, one blue level per 65536-pixel block.
{
  const n = 65536;
  const input = new Uint8ClampedArray(n * 4);
  const outN = new Uint8ClampedArray(n * 4);
  const outT = new Uint8ClampedArray(n * 4);
  const px = new Float32Array(3);
  let checked = 0;
  for (let b = 0; b < 256; b++) {
    for (let p = 0; p < n; p++) {
      input[p * 4] = p & 255; input[p * 4 + 1] = p >>> 8; input[p * 4 + 2] = b; input[p * 4 + 3] = 255;
    }
    applyAdjustmentsToPixels(input, outN, n, neutral, 'full');
    applyAdjustmentsToPixels(input, outT, n, tailed, 'full');
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      px[0] = input[i]; px[1] = input[i + 1]; px[2] = input[i + 2];
      applyExpiredTone(neutral.rescueStages, px);
      for (let c = 0; c < 3; c++) {
        if (outN[i + c] !== ((clamp255(px[c]) + 0.5) | 0) || outT[i + c] !== tail8(tailed, c, px[c])) {
          assert.fail(`8-bit RGB (${input[i]}, ${input[i + 1]}, ${b}) channel ${c}: ${outN[i + c]}/${outT[i + c]}`);
        }
      }
      checked++;
    }
  }
  assert.equal(checked, 1 << 24);
}

// 16-bit: a fixed-seed sample of 2^20 triples.
{
  const n = 1 << 20;
  const input = new Uint16Array(n * 4);
  let seed = 0x2468ace1;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let p = 0; p < n; p++) {
    input[p * 4] = next() >>> 16; input[p * 4 + 1] = next() >>> 16; input[p * 4 + 2] = next() >>> 16; input[p * 4 + 3] = 65535;
  }
  const outN = new Uint16Array(n * 4);
  const outT = new Uint16Array(n * 4);
  applyAdjustmentsToPixels16(input, outN, n, neutral, 'full');
  applyAdjustmentsToPixels16(input, outT, n, tailed, 'full');
  const px = new Float32Array(3);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    px[0] = input[i] * (255 / 65535); px[1] = input[i + 1] * (255 / 65535); px[2] = input[i + 2] * (255 / 65535);
    applyExpiredTone(neutral.rescueStages, px);
    for (let c = 0; c < 3; c++) {
      if (outN[i + c] !== Math.round(clamp255(px[c]) * (65535 / 255)) || outT[i + c] !== tail16(tailed, c, px[c])) {
        assert.fail(`16-bit RGB (${input[i]}, ${input[i + 1]}, ${input[i + 2]}) channel ${c}: ${outN[i + c]}/${outT[i + c]}`);
      }
    }
  }
}

console.log('Step-3 rescue tone: 8-bit kernel equals the stages on all 2^24 inputs, 16-bit on 2^20 sampled triples, with and without a tail');
