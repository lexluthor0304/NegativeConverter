// Standalone Node test for rollAnalysis.js - run with:
// node negative2positive/src/app/rollAnalysis.test.mjs

import assert from 'node:assert/strict';
import {
  baseChromaticity,
  measureNegativeMean,
  aggregateRollAnalysis,
  exposureUnitsForStops,
  exposureMidGreyResponse,
  sanitizeRollFrameForSettings,
  rollFrameExposureUnits
} from './rollAnalysis.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// Chromaticity ignores light-box brightness.
{
  const a = baseChromaticity({ r: 216, g: 148, b: 94 });
  const b = baseChromaticity({ r: 108, g: 74, b: 47 });
  assert.ok(Math.abs(a.r - b.r) < 1e-9 && Math.abs(a.b - b.b) < 1e-9);
  assert.ok(a.luminance > b.luminance);
  assert.equal(baseChromaticity(null), null);
  assert.equal(baseChromaticity({ r: 0, g: 0, b: 0 }), null);
}

// Negative mean: brighter negative -> larger value; inset skips the border.
{
  const make = (inner, border) => {
    const w = 100; const h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const edge = x < 10 || x >= 90 || y < 6 || y >= 54;
      const v = edge ? border : inner;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    return new ImageData(data, w, h);
  };
  const dim = measureNegativeMean(make(80, 255), 0.1);
  const bright = measureNegativeMean(make(160, 255), 0.1);
  assert.ok(bright > dim * 3, `bright ${bright} vs dim ${dim}`);
  const noBorderInfluence = measureNegativeMean(make(80, 0), 0.1);
  assert.ok(Math.abs(noBorderInfluence - dim) < 1e-6, 'border pixels are outside the inset');
}

const channels = (white, black, mean) => [0, 1, 2].map((ch) => ({
  whitePointOrigin: white + ch * 100, blackPointOrigin: black - ch * 100, meanPoint: mean, settingName: `ch${ch}`
}));

// Aggregation: consistent roll with one foreign frame.
{
  const frames = [
    { id: 'a', filmBase: { r: 216, g: 148, b: 94, method: 'rebate' }, channelData: channels(3000, 60000, 0.5), negativeMean: 0.30 },
    { id: 'b', filmBase: { r: 214, g: 150, b: 95, method: 'auto', confidence: 0.7 }, channelData: channels(2800, 58000, 0.48), negativeMean: 0.30 },
    { id: 'c', filmBase: { r: 218, g: 147, b: 92, method: 'auto', confidence: 0.8 }, channelData: channels(3200, 61000, 0.52), negativeMean: 0.60 },
    { id: 'd', filmBase: { r: 212, g: 149, b: 96, method: 'auto', confidence: 0.6 }, channelData: channels(3100, 59000, 0.5), negativeMean: 0.15 },
    // Different stock: greener, bluer base (Fuji-like) -> outlier.
    { id: 'x', filmBase: { r: 200, g: 170, b: 125, method: 'auto', confidence: 0.9 }, channelData: channels(9000, 40000, 0.3), negativeMean: 0.30 }
  ];
  const roll = aggregateRollAnalysis(frames);
  assert.equal(roll.count, 5);
  assert.equal(roll.usable, 4);
  assert.equal(roll.outlierCount, 1);
  const byId = Object.fromEntries(roll.frames.map((f) => [f.id, f]));
  assert.equal(byId.x.outlier, true);
  assert.deepEqual(byId.x.reasons, ['base-colour']);
  assert.equal(byId.a.outlier, false);
  // Roll base is a weighted median of the inliers, near the rebate sample.
  assert.ok(Math.abs(roll.filmBase.r - 215) <= 2 && Math.abs(roll.filmBase.g - 148) <= 2 && Math.abs(roll.filmBase.b - 94) <= 2, JSON.stringify(roll.filmBase));
  assert.equal(roll.filmBase.method, 'roll');
  assert.equal(roll.filmBase.r16, roll.filmBase.r * 257);
  // Shared channelData ignores the outlier's wild range.
  assert.ok(roll.channelData[0].whitePointOrigin >= 2800 && roll.channelData[0].whitePointOrigin <= 3100, JSON.stringify(roll.channelData[0]));
  assert.ok(roll.channelData[0].blackPointOrigin >= 59000 && roll.channelData[0].blackPointOrigin <= 61000);
  assert.equal(roll.channelData[2].settingName, 'ch2');
  // Exposure offsets: c is one stop thinner (brighter negative), d one stop denser.
  assert.ok(Math.abs(byId.c.offsetStops - 1) < 0.01, `c offset ${byId.c.offsetStops}`);
  assert.ok(Math.abs(byId.d.offsetStops + 1) < 0.01, `d offset ${byId.d.offsetStops}`);
  assert.equal(byId.a.offsetStops, 0);
}

// Light-box brightness change alone is a density outlier, not a colour one.
{
  const frames = [
    { id: 'a', filmBase: { r: 216, g: 148, b: 94 } },
    { id: 'b', filmBase: { r: 214, g: 146, b: 93 } },
    { id: 'c', filmBase: { r: 218, g: 149, b: 95 } },
    { id: 'dim', filmBase: { r: 108, g: 74, b: 47 } }
  ];
  const roll = aggregateRollAnalysis(frames);
  const dim = roll.frames.find((f) => f.id === 'dim');
  assert.equal(dim.outlier, true);
  assert.deepEqual(dim.reasons, ['base-density']);
  assert.equal(roll.channelData, null, 'no channelData without per-frame analyses');
}

// Two frames cannot outvote each other; a frame without a base is still flagged.
{
  const roll = aggregateRollAnalysis([
    { id: 'a', filmBase: { r: 216, g: 148, b: 94 } },
    { id: 'b', filmBase: { r: 200, g: 170, b: 125 } }
  ]);
  assert.equal(roll.outlierCount, 0);
  const missing = aggregateRollAnalysis([
    { id: 'a', filmBase: { r: 216, g: 148, b: 94 } },
    { id: 'b', filmBase: null },
    { id: 'c', filmBase: { r: 214, g: 146, b: 93 } }
  ]);
  assert.equal(missing.frames.find((f) => f.id === 'b').outlier, true);
  assert.deepEqual(missing.frames.find((f) => f.id === 'b').reasons, ['no-base']);
  assert.deepEqual(aggregateRollAnalysis([]), { count: 0, usable: 0, filmBase: null, channelData: null, frames: [], outlierCount: 0 });
}

// Exposure mapping inverts the mid-grey response of the curve engine.
{
  for (const stops of [-1.5, -1, -0.5, -0.2, 0.2, 0.5, 0.9]) {
    const units = exposureUnitsForStops(stops);
    const response = exposureMidGreyResponse(units);
    const achieved = Math.log2(response / 0.5);
    assert.ok(Math.abs(achieved - stops) < 0.06, `${stops} stops -> ${units} units -> ${achieved.toFixed(3)} stops`);
    assert.ok(Number.isInteger(units) && Math.abs(units) <= 300);
  }
  assert.equal(exposureUnitsForStops(0), 0);
  assert.equal(exposureUnitsForStops(NaN), 0);
  assert.ok(exposureUnitsForStops(3) <= 300, 'clamped');
  assert.ok(exposureUnitsForStops(-5) >= -300, 'clamped');
}

// Settings sanitiser and the per-frame exposure contribution.
{
  const frame = sanitizeRollFrameForSettings({
    rollId: 'roll-1', locked: true, channelData: channels(3000, 60000, 0.5), offsetStops: 0.5, equalize: true, outlier: false, reasons: ['bogus', 'base-colour']
  });
  assert.equal(frame.locked, true);
  assert.equal(frame.channelData.length, 3);
  assert.equal(frame.offsetStops, 0.5);
  assert.deepEqual(frame.reasons, ['base-colour']);
  // A thinner negative (+0.5 stop brighter than the roll) inverts to a darker
  // positive, so equalising brightens it: positive units.
  assert.ok(rollFrameExposureUnits(frame) > 0, `units ${rollFrameExposureUnits(frame)}`);
  const denser = sanitizeRollFrameForSettings({ locked: true, channelData: channels(3000, 60000, 0.5), offsetStops: -0.5, equalize: true });
  assert.ok(rollFrameExposureUnits(denser) < 0);
  assert.equal(rollFrameExposureUnits({ ...frame, equalize: false }), 0);
  assert.equal(rollFrameExposureUnits({ ...frame, outlier: true }), 0);
  assert.equal(sanitizeRollFrameForSettings({ locked: true, channelData: [{}, {}, {}] }).locked, false, 'lock needs valid channelData');
  assert.equal(sanitizeRollFrameForSettings(null), null);
  assert.equal(sanitizeRollFrameForSettings({ offsetStops: 9 }).offsetStops, 3);
}

console.log('rollAnalysis.test.mjs passed');
