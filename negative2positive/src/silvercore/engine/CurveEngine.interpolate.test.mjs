// interpolateToLUT walks the knots segment by segment (#272). Its tables must
// equal those of the entry-by-entry loop it replaced, for every knot set: the
// GPU preview, the worker conversions and every export read these LUTs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateCurves, interpolateToLUT } from './CurveEngine.js';

const PIXEL_MAX = 65535;
const LUT_SIZE = 65536;

// The implementation at e101b5df, verbatim.
function previousInterpolateToLUT(points) {
  const lut = new Uint16Array(LUT_SIZE);
  points.sort((a, b) => a.x - b.x);
  const firstY = points[0].y < 0 ? 0 : points[0].y > PIXEL_MAX ? PIXEL_MAX : points[0].y;
  const lastY = points[points.length - 1].y < 0 ? 0 : points[points.length - 1].y > PIXEL_MAX ? PIXEL_MAX : points[points.length - 1].y;
  const lastX = points[points.length - 1].x;
  let lo = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    if (i <= points[0].x) {
      lut[i] = firstY;
    } else if (i >= lastX) {
      lut[i] = lastY;
    } else {
      while (lo < points.length - 2 && points[lo + 1].x < i) {
        lo++;
      }
      const p0 = points[lo];
      const p1 = points[lo + 1];
      const t = (p1.x === p0.x) ? 0 : (i - p0.x) / (p1.x - p0.x);
      const v = p0.y + t * (p1.y - p0.y);
      lut[i] = v < 0 ? 0 : v > PIXEL_MAX ? PIXEL_MAX : (v + 0.5) | 0;
    }
  }
  return lut;
}

const copy = (points) => points.map((point) => ({ ...point }));
let checked = 0;
function assertSameTable(points, label) {
  const before = copy(points);
  const after = copy(points);
  const expected = previousInterpolateToLUT(before);
  const actual = interpolateToLUT(after);
  assert.ok(actual instanceof Uint16Array && actual.length === LUT_SIZE, `${label}: a 65536-entry Uint16Array`);
  for (let i = 0; i < LUT_SIZE; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: entry ${i} is ${actual[i]}, was ${expected[i]} (${JSON.stringify(points)})`);
  }
  assert.deepEqual(after, before, `${label}: the knots are sorted in place as before`);
  checked++;
}

// Edge cases: the ends of the table, equal and unsorted knots, knots and values
// outside the 16-bit range, a single knot, and knots that are not integers (the
// entry-by-entry loop).
const edges = {
  'full range': [{ x: 0, y: PIXEL_MAX }, { x: PIXEL_MAX, y: 0 }],
  'two equal knots': [{ x: 100, y: 5 }, { x: 100, y: 9 }],
  'a zero-width segment inside': [{ x: 10, y: 0 }, { x: 500, y: 300 }, { x: 500, y: 9000 }, { x: 900, y: 100 }],
  'knots beyond both ends': [{ x: -5, y: 3 }, { x: 70000, y: 70000 }],
  'every knot at the end': [{ x: PIXEL_MAX, y: 1 }, { x: PIXEL_MAX, y: 2 }, { x: PIXEL_MAX, y: 3 }],
  'every knot at the start': [{ x: 0, y: -4 }, { x: 0, y: 7 }, { x: 1, y: 9 }],
  'every knot before the table': [{ x: -900, y: 40 }, { x: -20, y: 70 }],
  'every knot after the table': [{ x: 70000, y: 40 }, { x: 90000, y: 70 }],
  'unsorted knots': [{ x: 30000, y: 10 }, { x: 20000, y: 60000 }, { x: 40000, y: 5 }],
  'a single knot': [{ x: 1234, y: 777 }],
  'negative zero': [{ x: -0, y: 10 }, { x: 900, y: 400 }],
  'values outside the range': [{ x: 1000, y: -9000 }, { x: 30000, y: 80000 }, { x: 60000, y: -1 }],
  'fractional values': [{ x: 1000, y: 0.4 }, { x: 2000, y: 65534.6 }, { x: 3000, y: 12.5 }],
  'fractional knots': [{ x: 1.5, y: 10 }, { x: 900.25, y: 400 }, { x: 40000.75, y: 20 }],
  'a NaN knot': [{ x: 10, y: 10 }, { x: Number.NaN, y: 400 }, { x: 40000, y: 20 }],
};
for (const [label, points] of Object.entries(edges)) assertSameTable(points, label);

// Random knot sets from a fixed seed: in range, out of range, duplicated,
// dense, out-of-range and fractional values, fractional knots.
let seed = 0x2720;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
for (let trial = 0; trial < 3000; trial++) {
  const count = 1 + Math.floor(random() * 15);
  const mode = trial % 7;
  const points = [];
  for (let k = 0; k < count; k++) {
    let x = Math.round(random() * PIXEL_MAX);
    if (mode === 1) x = Math.round(random() * 80000) - 7000;
    if (mode === 2 && k > 0 && random() < 0.4) x = points[k - 1].x;
    if (mode === 3) x = Math.round(random() * 20) + 32000;
    if (mode === 6) x = random() * PIXEL_MAX;
    let y = Math.round(random() * PIXEL_MAX);
    if (mode === 4) y = Math.round(random() * 90000) - 12000;
    if (mode === 5) y = random() * PIXEL_MAX;
    points.push({ x, y });
  }
  assertSameTable(points, `random set ${trial} (mode ${mode})`);
}

// The curves generateCurves builds for a grid of analyses and settings keep the
// SHA-256 they had at e101b5df.
const channels = {
  typical: [
    { whitePointOrigin: 9000, blackPointOrigin: 52000, meanPoint: 0.42 },
    { whitePointOrigin: 12000, blackPointOrigin: 50000, meanPoint: 0.45 },
    { whitePointOrigin: 15000, blackPointOrigin: 47000, meanPoint: 0.47 },
  ],
  narrow: [
    { whitePointOrigin: 30000, blackPointOrigin: 30020, meanPoint: 0.5 },
    { whitePointOrigin: 30010, blackPointOrigin: 30090, meanPoint: 0.5 },
    { whitePointOrigin: 29990, blackPointOrigin: 30200, meanPoint: 0.5 },
  ],
  clipped: [
    { whitePointOrigin: -800, blackPointOrigin: 66000, meanPoint: 0.3 },
    { whitePointOrigin: 0, blackPointOrigin: 65535, meanPoint: 0.6 },
    { whitePointOrigin: 200, blackPointOrigin: 65000, meanPoint: 0.9 },
  ],
};
const cases = [
  {}, { exposure: 120 }, { exposure: -250 }, { contrast: 60 }, { contrast: -70 }, { temperature: 40, temp: 40, wbTemp: 40 },
  { temp: -35, wbTemp: -35, tint: 20, wbTint: 20 }, { highlights: 80, shadows: -60 }, { whites: -40, blacks: 50 },
  { glow: 30, fade: 25 }, { brightness: 45 }, { brightness: -48 }, { curvePrecision: 'precise', contrast: 25 },
  { curvePrecision: 'smooth' }, { imageType: 'positive', toneProfile: 'positive' }, { layerOrder: 'tonesFirst', temp: 15, wbTemp: 15 },
  { wbTonality: 'subtractDensity', wbTemp: 30, wbTint: -10 }, { wbMethod: 'midtoneWeighted', wbCyan: 25 },
  { highlightCyan: 20, shadowTemp: -15, midTint: 10 }, { softHighlights: true, softShadows: true, contrast: 10 },
];
function settings(overrides) {
  return {
    imageType: 'negative', toneProfile: 'standard', brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
    whites: 0, blacks: 0, glow: 0, fade: 0, temp: 0, tint: 0, cyan: 0, wbCyan: 0, wbTemp: 0, wbTint: 0,
    wbTonality: 'addDensity', wbMethod: 'linearFixed', layerOrder: 'colorFirst', shadowRange: 5, highlightRange: 5,
    shadowCyan: 0, shadowTint: 0, shadowTemp: 0, highlightCyan: 0, highlightTint: 0, highlightTemp: 0,
    midCyan: 0, midTint: 0, midTemp: 0, curvePrecision: 'auto', autoToneLevel: 1, autoColorLevel: 1,
    softHighlights: false, softShadows: false, ...overrides,
  };
}
const digest = createHash('sha256');
for (const channelData of Object.values(channels)) {
  for (const overrides of cases) {
    const luts = generateCurves(channelData, settings(overrides));
    for (const lut of [luts.r, luts.g, luts.b]) digest.update(new Uint8Array(lut.buffer, lut.byteOffset, lut.byteLength));
  }
}
assert.equal(digest.digest('hex'), 'b51357bbb2daa9f0a9c35ed362939b159d60131f79e1553224cdbe0da6ef5955',
  'generateCurves builds the tables it built at e101b5df');

console.log(`CurveEngine.interpolate.test.mjs: ${checked} knot sets identical to the entry-by-entry loop; generateCurves digest unchanged`);
