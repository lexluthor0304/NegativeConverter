// Standalone Node test for localExposure.js - run with:
// node negative2positive/src/app/localExposure.test.mjs

import assert from 'node:assert/strict';
import {
  sanitizeLocalExposureForSettings,
  basePointToWorking,
  workingPointToBase,
  rasterizeExposureStops,
  applyExposureStopsToImage16
} from './localExposure.js';

// Geometry round trips through rotation, mirror and crop.
{
  const geometries = [
    { baseWidth: 600, baseHeight: 400, rotationAngle: 0, mirrored: false, rotatedWidth: 600, rotatedHeight: 400, cropRegion: null, width: 600, height: 400 },
    { baseWidth: 600, baseHeight: 400, rotationAngle: 0, mirrored: true, rotatedWidth: 600, rotatedHeight: 400, cropRegion: { x: 50, y: 40, width: 300, height: 200 }, width: 150, height: 100 },
    { baseWidth: 600, baseHeight: 400, rotationAngle: 90, mirrored: false, rotatedWidth: 400, rotatedHeight: 600, cropRegion: null, width: 200, height: 300 },
    { baseWidth: 600, baseHeight: 400, rotationAngle: 3.5, mirrored: true, rotatedWidth: 623, rotatedHeight: 436, cropRegion: { x: 60, y: 50, width: 500, height: 330 }, width: 250, height: 165 }
  ];
  for (const geometry of geometries) {
    for (const point of [{ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.7 }, { x: 0.9, y: 0.1 }]) {
      const working = basePointToWorking(point, geometry);
      const back = workingPointToBase(working, geometry);
      assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9, `round trip ${JSON.stringify(geometry)} ${JSON.stringify(point)}`);
    }
  }
  // The base centre lands on the working centre when the crop is centred.
  const centred = basePointToWorking({ x: 0.5, y: 0.5 }, geometries[0]);
  assert.ok(Math.abs(centred.x - 300) < 1e-9 && Math.abs(centred.y - 200) < 1e-9);
  // Mirror flips x in the rotated frame.
  const mirrored = basePointToWorking({ x: 0.1, y: 0.5 }, { ...geometries[0], mirrored: true });
  assert.ok(Math.abs(mirrored.x - 540) < 1e-9);
  // A 90 degree rotation turns the top-left corner into the top-right corner of the taller frame.
  const rotated = basePointToWorking({ x: 0, y: 0 }, geometries[2]);
  assert.ok(Math.abs(rotated.x - 200) < 1e-6 && Math.abs(rotated.y - 0) < 1e-6, JSON.stringify(rotated));
}

// Rasterisation: a burn stroke adds positive stops with a soft edge; a dodge subtracts.
{
  const geometry = { baseWidth: 200, baseHeight: 100, rotationAngle: 0, mirrored: false, rotatedWidth: 200, rotatedHeight: 100, cropRegion: null, width: 200, height: 100 };
  const burn = { strokes: [{ stops: 1, size: 0.3, feather: 0.5, points: [{ x: 0.25, y: 0.5, p: 1 }, { x: 0.75, y: 0.5, p: 1 }] }] };
  const stops = rasterizeExposureStops(burn, geometry);
  assert.equal(stops.length, 200 * 100);
  const at = (x, y) => stops[y * 200 + x];
  assert.ok(Math.abs(at(100, 50) - 1) < 1e-6, `centre of the stroke is a full stop, got ${at(100, 50)}`);
  assert.equal(at(5, 5), 0, 'far corner untouched');
  // Brush radius = 0.3 * 100 / 2 = 15 px; hard core 7.5 px, then a cosine falloff.
  assert.ok(at(100, 50 + 5) > 0.99, 'inside the hard core');
  const edge = at(100, 50 + 12);
  assert.ok(edge > 0.05 && edge < 0.6, `feathered edge ${edge}`);
  assert.equal(at(100, 50 + 16), 0, 'outside the brush');
  // Overlapping segments of one stroke do not double up, but two strokes do.
  const twice = rasterizeExposureStops({ strokes: [burn.strokes[0], burn.strokes[0]] }, geometry);
  assert.ok(Math.abs(twice[50 * 200 + 100] - 2) < 1e-6);
  const dodge = rasterizeExposureStops({ strokes: [{ ...burn.strokes[0], stops: -0.5 }] }, geometry);
  assert.ok(Math.abs(dodge[50 * 200 + 100] + 0.5) < 1e-6);
  // A single point paints a disc.
  const dot = rasterizeExposureStops({ strokes: [{ stops: 1, size: 0.2, feather: 0, points: [{ x: 0.5, y: 0.5, p: 1 }] }] }, geometry);
  assert.ok(dot[50 * 200 + 100] > 0.99 && dot[50 * 200 + 100 + 9] > 0.99 && dot[50 * 200 + 100 + 11] === 0);
  assert.equal(rasterizeExposureStops(null, geometry).length, 200 * 100);
  // The same stroke follows the crop: cropping the right half moves it left.
  const cropped = { ...geometry, cropRegion: { x: 100, y: 0, width: 100, height: 100 }, width: 100, height: 100 };
  const croppedStops = rasterizeExposureStops(burn, cropped);
  assert.ok(croppedStops[50 * 100 + 10] > 0.99, 'stroke end at base x=0.75 is at x=50 of the crop');
  assert.equal(croppedStops[50 * 100 + 90], 0);
}

// Applying stops multiplies the negative in linear light.
{
  const image = { width: 3, height: 1, data: new Uint16Array([32768, 32768, 32768, 65535, 32768, 32768, 32768, 65535, 65535, 65535, 65535, 65535]) };
  const stops = new Float32Array([1, 0, 1]);
  applyExposureStopsToImage16(image, stops);
  const doubled = Math.round(Math.pow(Math.pow(0.5, 2.2) * 2, 1 / 2.2) * 65535);
  assert.ok(Math.abs(image.data[0] - doubled) <= 1, `one stop doubles linear light: ${image.data[0]} vs ${doubled}`);
  assert.equal(image.data[4], 32768, 'zero stops untouched');
  assert.equal(image.data[8], 65535, 'clipped at white');
  assert.equal(image.data[3], 65535, 'alpha untouched');
  const untouched = { width: 1, height: 1, data: new Uint16Array([1, 2, 3, 4]) };
  assert.equal(applyExposureStopsToImage16(untouched, new Float32Array(5)), untouched, 'size mismatch is ignored');
}

// Settings sanitiser.
{
  const clean = sanitizeLocalExposureForSettings({ strokes: [
    { stops: 0.7, size: 0.2, feather: 0.4, points: [{ x: 0.1, y: 0.2, p: 0.5 }, { x: 'x', y: 0.3 }, { x: 0.4, y: 0.5 }] },
    { stops: 'nan', size: 0.2, points: [{ x: 0.1, y: 0.2 }] },
    { stops: 9, size: 5, points: [{ x: 2, y: -2 }] }
  ] });
  assert.equal(clean.strokes.length, 2);
  assert.equal(clean.strokes[0].points.length, 2);
  assert.equal(clean.strokes[0].points[0].p, 0.5);
  assert.equal(clean.strokes[0].points[1].p, 1);
  assert.equal(clean.strokes[1].stops, 3, 'stops clamped');
  assert.equal(clean.strokes[1].size, 1, 'size clamped');
  assert.equal(clean.strokes[1].points[0].x, 1.5, 'points clamped just outside the frame');
  assert.equal(sanitizeLocalExposureForSettings({ strokes: [] }), null);
  assert.equal(sanitizeLocalExposureForSettings(null), null);
}

console.log('localExposure.test.mjs passed');
