// Standalone Node test for curveMath.js - run with:
// node negative2positive/src/app/curveMath.test.mjs
import assert from 'node:assert/strict';
import {
  computeSpline,
  buildCurveLut,
  getCurvePresetPoints,
  insertCurvePoint,
  moveCurvePoint,
  findNearPointIndex,
} from './curveMath.js';

// 1. Two-point diagonal is the identity curve
{
  const lut = buildCurveLut([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
  assert.equal(lut.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(lut[i], i);
}

// 2. Spline clamps outside the endpoint range
{
  const spline = computeSpline([{ x: 50, y: 100 }, { x: 200, y: 150 }]);
  assert.equal(spline(0), 100);
  assert.equal(spline(255), 150);
}

// 3. Monotone input stays monotone (no spline overshoot ringing)
{
  const lut = buildCurveLut([{ x: 0, y: 0 }, { x: 64, y: 48 }, { x: 192, y: 208 }, { x: 255, y: 255 }]);
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `not monotone at ${i}`);
  // S-curve: darker shadows, brighter highlights
  assert.ok(lut[64] < 64);
  assert.ok(lut[192] > 192);
}

// 4. LUT values always land in 0-255 even for wild control points
{
  const lut = buildCurveLut([{ x: 0, y: 0 }, { x: 10, y: 255 }, { x: 20, y: 0 }, { x: 255, y: 255 }]);
  for (const v of lut) assert.ok(v >= 0 && v <= 255);
}

// 5. Presets return fresh copies (mutating one must not corrupt the preset)
{
  const a = getCurvePresetPoints('scurve');
  a[1].y = 999;
  const b = getCurvePresetPoints('scurve');
  assert.equal(b[1].y, 48);
  assert.deepEqual(getCurvePresetPoints('nonsense'), [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
}

// 6. insertCurvePoint keeps x order and returns the insertion index
{
  const points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const idx = insertCurvePoint(points, 128, 100);
  assert.equal(idx, 1);
  assert.deepEqual(points.map((p) => p.x), [0, 128, 255]);
  const idxEnd = insertCurvePoint(points, 255, 250); // ties append after equal x
  assert.equal(idxEnd, 3);
}

// 7. moveCurvePoint: endpoints move only vertically
{
  const points = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
  moveCurvePoint(points, 0, 77, 40);
  assert.deepEqual(points[0], { x: 0, y: 40 });
  moveCurvePoint(points, 2, 10, 200);
  assert.deepEqual(points[2], { x: 255, y: 200 });
}

// 8. moveCurvePoint: middle point x is fenced between neighbours
{
  const points = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
  moveCurvePoint(points, 1, -50, 60);
  assert.deepEqual(points[1], { x: 1, y: 60 });    // clamped to prev.x + 1
  moveCurvePoint(points, 1, 300, 70);
  assert.deepEqual(points[1], { x: 254, y: 70 });  // clamped to next.x - 1
}

// 9. findNearPointIndex hit-tests in canvas space (y axis flipped)
{
  const points = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
  const w = 256, h = 256;
  // point 1 sits at canvas (128, 128)
  assert.equal(findNearPointIndex(points, 130, 126, w, h), 1);
  // point 0 sits at canvas (0, 256) — bottom-left
  assert.equal(findNearPointIndex(points, 4, 252, w, h), 0);
  assert.equal(findNearPointIndex(points, 60, 60, w, h), -1);
}

console.log('curveMath tests: all passed');
