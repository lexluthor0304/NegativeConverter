import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeLocalExposureForSettings, strokeSanitizerStats } from './localExposure.js';
import { sanitizeRepairStrokes } from './repairBrush.js';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';

// The uncached sanitisers as they were at 1703835, kept as the reference, with
// #280's stored-point cap (1000; it was 400).
function clamp(value, min, max) { return value < min ? min : value > max ? max : value; }
function referenceLocalExposure(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.strokes)) return null;
  const strokes = [];
  for (const stroke of input.strokes.slice(0, 200)) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) continue;
    const stops = Number(stroke.stops);
    const size = Number(stroke.size);
    if (!Number.isFinite(stops) || !Number.isFinite(size)) continue;
    const points = [];
    for (const point of stroke.points.slice(0, 1000)) {
      const x = Number(point?.x); const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const pressure = Number(point?.p);
      points.push({ x: Number(clamp(x, -0.5, 1.5).toFixed(5)), y: Number(clamp(y, -0.5, 1.5).toFixed(5)), p: Number.isFinite(pressure) ? Number(clamp(pressure, 0.05, 1).toFixed(3)) : 1 });
    }
    if (!points.length) continue;
    strokes.push({
      stops: Number(clamp(stops, -3, 3).toFixed(3)),
      size: Number(clamp(size, 0.005, 1).toFixed(4)),
      feather: Number(clamp(Number(stroke.feather) || 0.5, 0, 1).toFixed(3)),
      points
    });
  }
  if (!strokes.length) return null;
  return { strokes };
}
function referenceRepairStrokes(input) {
  if (!Array.isArray(input)) return [];
  return referenceLocalExposure({ strokes: input.slice(0, 200).map(stroke => ({
    ...stroke, stops: 1, feather: 0,
    points: stroke?.points?.length > 400
      ? Array.from({ length: 400 }, (_, i) => stroke.points[Math.round(i * (stroke.points.length - 1) / 399)])
      : stroke?.points
  })) })?.strokes.map(({ points, size }) => ({ points, size })) || [];
}

let seed = 17;
const random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 | 0) >>> 0) / 2 ** 32;
const stroke = (points, extra = {}) => ({ stops: random() * 4 - 2, size: random() * 0.1, feather: random(),
  points: Array.from({ length: points }, () => ({ x: random() * 1.2 - 0.1, y: random(), p: random() })), ...extra });
const strokes = (count, points = 150) => Array.from({ length: count }, () => stroke(points));

// Same results as the uncached sanitiser, on the first and every later call,
// for valid, odd and invalid input (null and primitives bypass the cache).
const inputs = [
  null, undefined, 0, 'x', {}, { strokes: 'x' }, { strokes: [] }, { strokes: [null, { points: [] }, { stops: 'a', size: 1, points: [{ x: 0, y: 0 }] }] },
  { strokes: strokes(3, 20) }, { strokes: [stroke(5, { feather: -1 })] }, { strokes: [stroke(5, { feather: 0.0004 })] },
  { strokes: [stroke(5, { feather: 0 })] }, { strokes: [stroke(450)] }, { strokes: [stroke(1100)] }, { strokes: strokes(210, 2) },
];
for (const input of inputs) {
  const expected = referenceLocalExposure(input);
  for (let pass = 0; pass < 3; pass++) assert.deepEqual(sanitizeLocalExposureForSettings(input), expected);
  // The brush path stores an output and every frame sanitises that output.
  const output = sanitizeLocalExposureForSettings(input);
  if (output) for (let pass = 0; pass < 3; pass++) assert.deepEqual(sanitizeLocalExposureForSettings(output), referenceLocalExposure(output));
}
for (const input of [null, 'x', {}, [], [null, { size: 0.1 }], strokes(4, 30), [stroke(500)], strokes(205, 3)]) {
  const expected = referenceRepairStrokes(input);
  for (let pass = 0; pass < 3; pass++) assert.deepEqual(sanitizeRepairStrokes(input), expected);
}

// A feather that sanitises to 0 becomes 0.5 on a second pass. Keying by input
// keeps both results exactly as before: the stored stroke keeps 0 and the
// per-frame pass over it (a different input) yields 0.5, every time.
{
  const stored = sanitizeLocalExposureForSettings({ strokes: [stroke(4, { feather: -1 })] });
  assert.equal(stored.strokes[0].feather, 0);
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(sanitizeLocalExposureForSettings(stored).strokes[0].feather, 0.5);
    assert.equal(stored.strokes[0].feather, 0, 'the stored output is never replaced by its second pass');
  }
}

// Per-frame calls hit; every write-site pattern misses once. 30 dodge-and-burn
// and 30 repair strokes of 150 points each, as in the acceptance setup.
{
  const state = { localExposure: sanitizeLocalExposureForSettings({ strokes: strokes(30) }),
    repairStrokes: sanitizeRepairStrokes(strokes(30).map(({ size, points }) => ({ size, points }))) };
  const frame = () => [sanitizeLocalExposureForSettings(state.localExposure), sanitizeRepairStrokes(state.repairStrokes)];
  const first = frame();
  const misses = strokeSanitizerStats.misses;
  const start = performance.now();
  for (let i = 0; i < 300; i++) {
    const [exposure, repairs] = frame();
    assert.equal(exposure, first[0]); assert.equal(repairs, first[1]);
  }
  const perFrame = (performance.now() - start) / 300;
  assert.equal(strokeSanitizerStats.misses, misses, 'no misses after the first frame');
  assert.ok(perFrame < 0.1, `cached frame took ${perFrame.toFixed(3)} ms`);

  const expectMiss = (label, next) => {
    const before = strokeSanitizerStats.misses;
    const exposure = sanitizeLocalExposureForSettings(next.localExposure);
    const repairs = sanitizeRepairStrokes(next.repairStrokes);
    assert.ok(strokeSanitizerStats.misses > before, `${label} misses`);
    assert.deepEqual(exposure, referenceLocalExposure(next.localExposure), label);
    assert.deepEqual(repairs, referenceRepairStrokes(next.repairStrokes), label);
    const again = strokeSanitizerStats.misses;
    sanitizeLocalExposureForSettings(next.localExposure); sanitizeRepairStrokes(next.repairStrokes);
    assert.equal(strokeSanitizerStats.misses, again, `${label} hits on the next frame`);
  };
  // Write sites in main.js: brush end (new strokes array + object), stroke
  // removal, undo/redo (restoreSnapshot of structuredClone'd settings), and
  // restoreSettings (structuredClone of the sanitised settings).
  const added = { localExposure: sanitizeLocalExposureForSettings({ strokes: [...state.localExposure.strokes, stroke(10)] }),
    repairStrokes: sanitizeRepairStrokes([...state.repairStrokes, { size: 0.02, points: [{ x: 0.5, y: 0.5 }] }]) };
  expectMiss('add', added);
  expectMiss('remove', { localExposure: { strokes: added.localExposure.strokes.slice(0, -1) }, repairStrokes: [] });
  const snapshot = { localExposure: structuredClone(state.localExposure), repairStrokes: structuredClone(state.repairStrokes) };
  expectMiss('undo', { localExposure: structuredClone(snapshot.localExposure), repairStrokes: sanitizeRepairStrokes(snapshot.repairStrokes).slice() });
  expectMiss('redo', { localExposure: structuredClone(added.localExposure), repairStrokes: sanitizeRepairStrokes(structuredClone(added.repairStrokes)).slice() });
  const saved = deepCopySanitizedSettings({ ...minimalSafeSettings(), localExposure: state.localExposure, repairStrokes: state.repairStrokes });
  expectMiss('restoreSettings', { localExposure: structuredClone(saved.localExposure), repairStrokes: sanitizeRepairStrokes(saved.repairStrokes).slice() });
  assert.notEqual(saved.localExposure, state.localExposure, 'stored settings copy the shared cached strokes');
  assert.notEqual(saved.repairStrokes, state.repairStrokes);
}

// Stroke data is replaced, never edited in place: an in-place edit would be
// invisible to the input-keyed caches. Guard main.js against such writes.
{
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const mutation = /(?:localExposure|repairStrokes)(?:\??\.[\w$]+|\[[^\]]+\])*\??\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\(|(?:localExposure|repairStrokes)(?:\??\.[\w$]+|\[[^\]]+\])+\s*(?:[+\-*/]?=)(?!=)/g;
  assert.deepEqual(source.match(mutation) || [], [], 'stroke sets must be replaced, not mutated');
  // Every assignment to the live stroke sets creates a new object or array.
  for (const [line] of source.matchAll(/state\.(?:localExposure|repairStrokes) = [^;]+;/g)) {
    assert.match(line, /= (?:null|\[\]|sanitize|structuredClone|kept\.length|s\.|safe\.)/, line);
  }
}

function minimalSafeSettings() {
  return {
    filmBase: { r: 1, g: 2, b: 3 },
    lensCorrection: { enabled: false, selectedLens: null, params: {}, modes: {}, lastError: '' },
    curvePoints: { r: [], g: [], b: [] },
    curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) }
  };
}

console.log('strokeSanitizerCache: identical results on every pass, per-frame hits, misses on every write pattern');
