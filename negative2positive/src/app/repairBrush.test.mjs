import assert from 'node:assert/strict';
import { repairMask, pointerToRepairPoint, sanitizeRepairStrokes } from './repairBrush.js';
import { workingPointToBase, basePointToWorking } from './localExposure.js';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';

// CSS zoom/pan must not move the selected image pixel.
assert.deepEqual(pointerToRepairPoint({ clientX: 200, clientY: 150 },
  { left: 100, top: 50, width: 400, height: 200 }, 800, 400), { x: 200, y: 200 });
assert.deepEqual(pointerToRepairPoint({ clientX: 200, clientY: 150 },
  { left: -200, top: -250, width: 1600, height: 800 }, 800, 400), { x: 200, y: 200 });
assert.equal(pointerToRepairPoint({}, { width: 0, height: 0 }, 100, 100), null);

const geometry = { baseWidth: 100, baseHeight: 80, rotatedWidth: 100, rotatedHeight: 80,
  width: 100, height: 80, rotationAngle: 0, mirrored: false, cropRegion: null };
const strokes = sanitizeRepairStrokes([{ size: 0.1, points: [{ x: 0.3, y: 0.4 }] }]);
const mask = repairMask(strokes, geometry);
assert.equal(mask[32 * 100 + 30], 255);
assert.equal(mask[60 * 100 + 70], 0, 'unpainted region stays outside mask');
assert.equal(repairMask([], geometry).some(Boolean), false, 'enabling a brush never selects automatic dust');
const mirrored = repairMask(strokes, { ...geometry, mirrored: true });
assert.equal(mirrored[32 * 100 + 70], 255);
assert.equal(mirrored[32 * 100 + 30], 0);
const cropped = { ...geometry, cropRegion: { left: 20, top: 20, width: 50, height: 40 }, width: 50, height: 40 };
assert.equal(repairMask(strokes, cropped)[12 * 50 + 10], 255);
const rotated = { ...geometry, rotationAngle: 90, rotatedWidth: 80, rotatedHeight: 100, width: 80, height: 100 };
const point = basePointToWorking(strokes[0].points[0], rotated);
assert.equal(repairMask(strokes, rotated)[Math.floor(point.y) * 80 + Math.floor(point.x)], 255);
const back = workingPointToBase(point, rotated);
assert.ok(Math.abs(back.x - 0.3) < 1e-6 && Math.abs(back.y - 0.4) < 1e-6);
const copy = deepCopySanitizedSettings({ repairStrokes: strokes, lensCorrection: {},
  curvePoints: { r: [], g: [], b: [] }, curves: { r: [], g: [], b: [] } });
copy.repairStrokes[0].points[0].x = 0.9;
assert.equal(strokes[0].points[0].x, 0.3, 'photo settings must not share mutable strokes');
assert.deepEqual(sanitizeRepairStrokes(null), []);
const long = sanitizeRepairStrokes([{ size: 0.1, points: Array.from({ length: 800 }, (_, i) => ({ x: i / 799, y: 0.5 })) }]);
assert.equal(long[0].points.at(-1).x, 1, 'long strokes retain their endpoint');
console.log('Repair brush zoom, geometry, masks and per-photo settings passed');
