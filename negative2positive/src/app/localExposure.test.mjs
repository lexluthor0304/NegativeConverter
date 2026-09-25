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

// #248: rasterizeExposureStops gained a window for the detail layer. Without
// one it must equal the implementation before it (b8f4cc2, kept here), and a
// window must equal the same region of the whole frame's raster.
{
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  function headForEachStrokeCoverage(localExposure, geometry, visit) {
    const width = geometry.width; const height = geometry.height;
    const strokes = localExposure?.strokes;
    if (!Array.isArray(strokes) || !strokes.length) return;
    const shortSide = Math.min(geometry.baseWidth, geometry.baseHeight);
    for (const stroke of strokes) {
      const points = stroke.points.map((p) => ({ ...basePointToWorking(p, geometry), p: p.p ?? 1 }));
      if (!points.length) continue;
      const scale = points[0].scale / Math.min(geometry.cropRegion ? geometry.cropRegion.width : (geometry.rotatedWidth || geometry.baseWidth), geometry.cropRegion ? geometry.cropRegion.height : (geometry.rotatedHeight || geometry.baseHeight));
      const radius = Math.max(1, stroke.size * shortSide * scale / 2);
      const feather = clamp(stroke.feather ?? 0.5, 0, 1);
      const hard = radius * (1 - feather);
      const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
      // Coverage keeps the maximum falloff per stroke so overlapping segments
      // of one stroke do not double up.
      const maxR = radius * Math.max(...points.map((p) => p.p));
      const bx0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - maxR));
      const bx1 = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x)) + maxR));
      const by0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - maxR));
      const by1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) + maxR));
      if (bx1 < bx0 || by1 < by0) continue;
      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      const coverage = new Float32Array(bw * bh);
      for (const [a, b] of segments) {
        const r = radius * Math.max(a.p, b.p);
        const x0 = Math.max(bx0, Math.floor(Math.min(a.x, b.x) - r)); const x1 = Math.min(bx1, Math.ceil(Math.max(a.x, b.x) + r));
        const y0 = Math.max(by0, Math.floor(Math.min(a.y, b.y) - r)); const y1 = Math.min(by1, Math.ceil(Math.max(a.y, b.y) + r));
        if (x1 < x0 || y1 < y0) continue;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const ph = hard * Math.max(a.p, b.p);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5; const py = y + 0.5;
            let t = lengthSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lengthSq : 0;
            t = clamp(t, 0, 1);
            const cx = a.x + t * dx; const cy = a.y + t * dy;
            const dist = Math.hypot(px - cx, py - cy);
            if (dist >= r) continue;
            const falloff = dist <= ph ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (dist - ph) / Math.max(1e-6, r - ph));
            const idx = (y - by0) * bw + (x - bx0);
            if (falloff > coverage[idx]) coverage[idx] = falloff;
          }
        }
      }
      visit(stroke, bx0, by0, bw, bh, coverage);
    }
  }

  // Rasterises strokes into a Float32Array of stops per pixel (0 = untouched).
  // Overlapping strokes add up, so a second pass burns twice.
  function headRasterizeExposureStops(localExposure, geometry) {
    const width = geometry.width; const height = geometry.height;
    const stops = new Float32Array(width * height);
    headForEachStrokeCoverage(localExposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
      for (let y = by0; y < by0 + bh; y++) {
        for (let x = bx0; x < bx0 + bw; x++) {
          const c = coverage[(y - by0) * bw + (x - bx0)];
          if (c > 0) stops[y * width + x] += stroke.stops * c;
        }
      }
    });
    return stops;
  }

  const strokes = { strokes: [
    { stops: 1.3, size: 0.25, feather: 0.5, points: [{ x: 0.2, y: 0.3, p: 1 }, { x: 0.7, y: 0.6, p: 0.6 }] },
    { stops: -0.9, size: 0.12, feather: 0.1, points: [{ x: 0.5, y: 0.5, p: 1 }] },
    { stops: 0.4, size: 0.4, feather: 0.9, points: [{ x: 0.9, y: 0.1, p: 0.8 }, { x: 0.95, y: 0.2, p: 1 }, { x: 0.6, y: 0.9, p: 0.3 }] }
  ] };
  for (const geometry of [
    { baseWidth: 120, baseHeight: 80, rotationAngle: 0, mirrored: false, rotatedWidth: 120, rotatedHeight: 80, cropRegion: null, width: 120, height: 80 },
    { baseWidth: 120, baseHeight: 80, rotationAngle: 7, mirrored: true, rotatedWidth: 129, rotatedHeight: 94, cropRegion: { left: 10, top: 6, width: 100, height: 70 }, width: 50, height: 35 },
  ]) {
    const full = rasterizeExposureStops(strokes, geometry);
    assert.deepEqual(full, headRasterizeExposureStops(strokes, geometry), 'no window: identical to the implementation before #248');
    for (const window of [{ x: 7, y: 5, width: 30, height: 20 }, { x: geometry.width - 12, y: geometry.height - 9, width: 12, height: 9 }]) {
      const region = rasterizeExposureStops(strokes, { ...geometry, window });
      for (let y = 0; y < window.height; y++) for (let x = 0; x < window.width; x++) {
        assert.equal(region[y * window.width + x], full[(window.y + y) * geometry.width + window.x + x], 'a window equals the frame raster');
      }
    }
  }
}

console.log('localExposure.test.mjs passed');
