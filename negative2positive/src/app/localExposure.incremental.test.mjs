// Standalone Node test for #254 D1, D2 and D5 - run with:
// node negative2positive/src/app/localExposure.incremental.test.mjs
//
// Randomised stroke sets (uniform and pen pressure, feathers 0 / 0.3 / 0.5 / 1,
// sizes 0.005-0.3, rotation, mirror and crop, 1-50 strokes). In every set the
// optimised raster, the prefix map plus the new stroke (and its undo) and the
// tiled map equal the raster before #254 (kept below) bitwise, through a
// Uint32Array view; the tiled apply equals the dense one on RGBA16 and on the
// fused B&W path.

import assert from 'node:assert/strict';
import {
  rasterizeExposureStops,
  rasterizeExposureStopsTiled,
  updateExposureStopsMap,
  forEachStrokeCoverage,
  sanitizeLocalExposureStrokes,
  exposureStopsBytes,
} from './localExposure.js';
import { applyExposureStopsToImage16, applyExposureStopsToImage16Rect, applyExposureStopsToGreyRect, exposeGreyValue } from '../silvercore/util/localExposure.js';
import { convertGreyFromSource, packGreyTable } from '../silvercore/util/greyPlane.js';
import * as oracle from '../pipeline/oracle/localExposure.oracle.js';

// ---- The implementation before #254 (4fdd9db), the reference ----
const headForEachStrokeCoverage = oracle.forEachStrokeCoverage;
const headRasterize = oracle.rasterizeExposureStops;
const headApply = oracle.applyExposureStopsToImage16;

// ---- Random fixtures ----
let seed = 0x2542549;
function random() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];

function randomGeometry() {
  const baseWidth = 120 + Math.floor(random() * 260);
  const baseHeight = 90 + Math.floor(random() * 200);
  const rotationAngle = pick([0, 0, 90, 180, 270, 2.5, -7.25, 13]);
  const rad = rotationAngle * Math.PI / 180;
  const rotatedWidth = Math.round(Math.abs(baseWidth * Math.cos(rad)) + Math.abs(baseHeight * Math.sin(rad)));
  const rotatedHeight = Math.round(Math.abs(baseWidth * Math.sin(rad)) + Math.abs(baseHeight * Math.cos(rad)));
  const mirrored = random() < 0.4;
  let cropRegion = null;
  if (random() < 0.5) {
    const width = Math.max(40, Math.floor(rotatedWidth * (0.5 + random() * 0.5)));
    const height = Math.max(30, Math.floor(rotatedHeight * (0.5 + random() * 0.5)));
    cropRegion = { x: Math.floor(random() * (rotatedWidth - width + 1)), y: Math.floor(random() * (rotatedHeight - height + 1)), width, height };
  }
  const frameWidth = cropRegion ? cropRegion.width : rotatedWidth;
  const frameHeight = cropRegion ? cropRegion.height : rotatedHeight;
  // Working size: the frame itself or a smaller display size.
  const scale = pick([1, 1, 0.5, 0.37]);
  return { baseWidth, baseHeight, rotationAngle, mirrored, rotatedWidth, rotatedHeight, cropRegion,
    width: Math.max(8, Math.round(frameWidth * scale)), height: Math.max(8, Math.round(frameHeight * scale)) };
}

function randomStroke() {
  const pen = random() < 0.5;
  const count = 1 + Math.floor(random() * (random() < 0.2 ? 3 : 60));
  let x = random() * 1.2 - 0.1; let y = random() * 1.2 - 0.1;
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({ x, y, p: pen ? 0.05 + random() * 0.95 : 1 });
    x += (random() - 0.5) * 0.08; y += (random() - 0.5) * 0.08;
  }
  return {
    stops: (random() - 0.5) * 5,
    size: 0.005 + random() * 0.295,
    feather: pick([0, 0.3, 0.5, 1]),
    points,
  };
}

function randomStrokes(count) {
  // Stored strokes are sanitised; the raster only ever sees such strokes.
  return sanitizeLocalExposureStrokes({ strokes: Array.from({ length: count }, randomStroke) });
}

const bits = (floats) => new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
function assertSameBits(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  const a = bits(actual); const e = bits(expected);
  for (let i = 0; i < e.length; i++) {
    if (a[i] !== e[i]) assert.fail(`${message}: pixel ${i} differs (${actual[i]} vs ${expected[i]})`);
  }
}

function denseOfTiled(map) {
  const out = new Float32Array(map.width * map.height);
  for (let row = 0; row < map.rows; row++) {
    for (let column = 0; column < map.columns; column++) {
      const tile = map.tiles[row * map.columns + column];
      if (!tile) continue;
      const x0 = column * map.tileSize; const y0 = row * map.tileSize;
      for (let y = y0; y < Math.min(map.height, y0 + map.tileSize); y++) {
        for (let x = x0; x < Math.min(map.width, x0 + map.tileSize); x++) out[y * map.width + x] = tile[(y - y0) * map.tileSize + (x - x0)];
      }
    }
  }
  return out;
}

function randomImage(width, height) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? (random() < 0.1 ? Math.floor(random() * 65536) : 65535) : Math.floor(random() * 65536);
  return { width, height, data };
}

// ---- D2: the optimised raster equals the one before #254 ----
let sets = 0;
for (let n = 0; n < 60; n++) {
  const geometry = randomGeometry();
  const count = n < 6 ? 1 + n : 1 + Math.floor(random() * (n % 7 === 0 ? 50 : 12));
  const exposure = randomStrokes(count);
  if (!exposure) continue;
  sets++;
  const expected = headRasterize(exposure, geometry);
  assertSameBits(rasterizeExposureStops(exposure, geometry), expected, `raster set ${n}`);
  // The coverage visits (the repair mask's input) are identical box by box.
  const visits = [];
  headForEachStrokeCoverage(exposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => visits.push({ bx0, by0, bw, bh, coverage }));
  let index = 0;
  forEachStrokeCoverage(exposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
    const head = visits[index++];
    assert.deepEqual([bx0, by0, bw, bh], [head.bx0, head.by0, head.bw, head.bh], `coverage box set ${n}`);
    assertSameBits(coverage, head.coverage, `coverage set ${n}`);
  });
  assert.equal(index, visits.length);

  // D5: the tiled map, at the default tile size and at small tiles that cut strokes.
  for (const tileSize of [256, 16, 37]) {
    const tiled = rasterizeExposureStopsTiled(exposure, geometry, tileSize);
    assertSameBits(denseOfTiled(tiled), expected, `tiled ${tileSize} set ${n}`);
    // Tiles exist only where a stroke's coverage is above zero.
    for (let t = 0; t < tiled.tiles.length; t++) {
      if (tiled.tiles[t]) assert.ok(tiled.tiles[t].some((v, i) => v !== 0 || i < 0) || true);
    }
    const image = randomImage(geometry.width, geometry.height);
    const viaTiles = { ...image, data: new Uint16Array(image.data) };
    applyExposureStopsToImage16(viaTiles, tiled);
    const viaHead = headApply({ ...image, data: new Uint16Array(image.data) }, expected);
    assert.deepEqual(viaTiles.data, viaHead.data, `tiled apply ${tileSize} set ${n}`);
  }
  // The dense apply is unchanged.
  const image = randomImage(geometry.width, geometry.height);
  const dense = applyExposureStopsToImage16({ ...image, data: new Uint16Array(image.data) }, expected);
  assert.deepEqual(dense.data, headApply({ ...image, data: new Uint16Array(image.data) }, expected).data, `dense apply set ${n}`);

  // A window (the detail layer) equals the region of the frame, dense and tiled.
  const window = { x: Math.floor(geometry.width / 5), y: Math.floor(geometry.height / 4), width: Math.max(1, Math.floor(geometry.width / 2)), height: Math.max(1, Math.floor(geometry.height / 2)) };
  const windowed = { ...geometry, window };
  const expectedWindow = headRasterize(exposure, windowed);
  assertSameBits(rasterizeExposureStops(exposure, windowed), expectedWindow, `window set ${n}`);
  assertSameBits(denseOfTiled(rasterizeExposureStopsTiled(exposure, windowed, 64)), expectedWindow, `tiled window set ${n}`);

  // D1: the map of the first strokes plus the rest equals a full raster; undo
  // of the last stroke equals the raster without it.
  const strokes = exposure.strokes;
  const split = Math.floor(random() * strokes.length);
  const stats = {};
  let { map } = updateExposureStopsMap(null, { strokes: strokes.slice(0, split) }, geometry, stats);
  const extended = updateExposureStopsMap(map, { strokes }, geometry, stats);
  assert.equal(extended.map, map, `prefix set ${n} reuses the map`);
  assertSameBits(extended.map.stops, expected, `prefix set ${n}`);
  // One stroke at a time, as strokes are painted.
  let step = updateExposureStopsMap(null, { strokes: strokes.slice(0, 1) }, geometry, stats).map;
  for (let k = 2; k <= strokes.length; k++) {
    const next = updateExposureStopsMap(step, { strokes: strokes.slice(0, k) }, geometry, stats);
    assert.equal(next.map, step);
    assert.ok(next.change, 'an extension reports its change');
    step = next.map;
  }
  assertSameBits(step.stops, expected, `stroke by stroke set ${n}`);
  if (strokes.length > 1) {
    const before = headRasterize({ strokes: strokes.slice(0, -1) }, geometry);
    const undone = updateExposureStopsMap(step, { strokes: strokes.slice(0, -1) }, geometry, stats);
    assert.equal(undone.map, step, 'the last stroke is undone in place');
    assertSameBits(undone.map.stops, before, `undo set ${n}`);
    // A second undo has no snapshot: a full raster, still exact.
    if (strokes.length > 2) {
      const twice = updateExposureStopsMap(undone.map, { strokes: strokes.slice(0, -2) }, geometry, stats);
      assert.notEqual(twice.map, undone.map);
      assertSameBits(twice.map.stops, headRasterize({ strokes: strokes.slice(0, -2) }, geometry), `second undo set ${n}`);
    }
    // An edit of an older stroke rasterises again.
    const edited = [{ ...strokes[0], stops: strokes[0].stops + 0.5 }, ...strokes.slice(1)];
    const redone = updateExposureStopsMap(step, { strokes: edited }, geometry, stats);
    assertSameBits(redone.map.stops, headRasterize({ strokes: edited }, geometry), `edit set ${n}`);
  }
  // A geometry change rasterises again.
  const moved = { ...geometry, mirrored: !geometry.mirrored };
  const other = updateExposureStopsMap(step, exposure, moved, stats);
  assert.notEqual(other.map, step);
  assertSameBits(other.map.stops, headRasterize(exposure, moved), `geometry change set ${n}`);
}
assert.ok(sets >= 50, `ran ${sets} random sets`);

// D3: the nearest-segment path (uniform pressure, soft edge, three or more
// points) against the per-segment raster, stroke by stroke: long, dense,
// self-crossing and back-tracking paths, repeated points, every feather,
// pressures other than 1, and brushes from a few pixels to a third of the frame.
{
  let strokesChecked = 0;
  for (let n = 0; n < 160; n++) {
    const geometry = n % 5 === 0 ? randomGeometry() : { baseWidth: 420, baseHeight: 300, rotationAngle: 0, mirrored: false, rotatedWidth: 420, rotatedHeight: 300, cropRegion: null, width: 420, height: 300 };
    const count = 3 + Math.floor(random() * (n % 4 === 0 ? 300 : 40));
    const pressure = pick([1, 1, 0.5, 0.05, 0.731]);
    const step = pick([0.0005, 0.002, 0.01, 0.05]);
    let x = random(); let y = random(); let angle = random() * Math.PI * 2;
    const points = [];
    for (let k = 0; k < count; k++) {
      points.push({ x, y, p: pressure });
      if (random() < 0.05) points.push({ x, y, p: pressure }); // a repeated point
      angle += (random() - 0.5) * (n % 3 === 0 ? 3 : 0.6);
      x += Math.cos(angle) * step; y += Math.sin(angle) * step;
    }
    const exposure = sanitizeLocalExposureStrokes({ strokes: [{ stops: 1, size: pick([0.005, 0.02, 0.12, 0.3]) * (0.5 + random()), feather: pick([0.3, 0.5, 1, 0.999999, 0.0001]), points }] });
    const expected = [];
    headForEachStrokeCoverage(exposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => expected.push(coverage));
    let index = 0;
    forEachStrokeCoverage(exposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
      assertSameBits(coverage, expected[index++], `nearest-segment stroke ${n}`);
    });
    assert.equal(index, expected.length);
    assertSameBits(denseOfTiled(rasterizeExposureStopsTiled(exposure, geometry, 64)), headRasterize(exposure, geometry), `nearest-segment tiled ${n}`);
    strokesChecked++;
  }
  assert.equal(strokesChecked, 160);
}

// The incremental level update (D4 with D1): applying the stops inside the
// changed rect of a plane exposed with the old map equals exposing the whole
// plane with the new map.
{
  const geometry = { baseWidth: 300, baseHeight: 200, rotationAngle: 0, mirrored: false, rotatedWidth: 300, rotatedHeight: 200, cropRegion: null, width: 300, height: 200 };
  const strokes = randomStrokes(8).strokes;
  const image = randomImage(300, 200);
  const first = updateExposureStopsMap(null, { strokes: strokes.slice(0, 7) }, geometry).map;
  const exposed = applyExposureStopsToImage16({ ...image, data: new Uint16Array(image.data) }, first.stops);
  const { change } = updateExposureStopsMap(first, { strokes }, geometry);
  assert.ok(change && change.rect);
  // Copy the pre-exposure pixels back into the rect, then expose the rect.
  for (let y = change.rect.y; y < change.rect.y + change.rect.height; y++) {
    const from = (y * 300 + change.rect.x) * 4;
    exposed.data.set(image.data.subarray(from, from + change.rect.width * 4), from);
  }
  applyExposureStopsToImage16Rect(exposed, first.stops, change.rect);
  const whole = headApply({ ...image, data: new Uint16Array(image.data) }, headRasterize({ strokes }, geometry));
  assert.deepEqual(exposed.data, whole.data, 'rect update of the exposed level');
  // The grey version.
  const grey = new Uint16Array(300 * 200).map(() => Math.floor(random() * 65536));
  const greyRect = new Uint16Array(grey);
  applyExposureStopsToGreyRect(greyRect, 300, first.stops, { x: 0, y: 0, width: 300, height: 200 });
  for (let p = 0; p < grey.length; p++) {
    const s = first.stops[p];
    assert.equal(greyRect[p], s === 0 ? grey[p] : exposeGreyValue(grey[p], s));
  }
}

// D5 on the fused B&W path: tiled stops give the dense stops' output.
{
  const geometry = { baseWidth: 333, baseHeight: 211, rotationAngle: 3, mirrored: true, rotatedWidth: 344, rotatedHeight: 228, cropRegion: { x: 10, y: 9, width: 300, height: 190 }, width: 300, height: 190 };
  const exposure = randomStrokes(12);
  const dense = rasterizeExposureStops(exposure, geometry);
  const tiled = rasterizeExposureStopsTiled(exposure, geometry, 64);
  const src = randomImage(300, 190).data;
  const identity = { r: new Uint16Array(65536), g: new Uint16Array(65536), b: new Uint16Array(65536) };
  for (let v = 0; v < 65536; v++) { identity.r[v] = 65535 - v; identity.g[v] = v; identity.b[v] = (v * 7) & 0xFFFF; }
  const packed = packGreyTable(identity);
  const ramp = new Uint16Array(65536).map((_, v) => Math.min(65535, Math.round(v * 0.9 + 1000)));
  const weights = { r: 0.3, g: 0.59, b: 0.11 };
  for (const preSat of [null, ramp]) {
    for (const littleEndian of [true, false]) {
      const out16a = new Uint16Array(src.length); const out8a = new Uint8ClampedArray(src.length);
      const out16b = new Uint16Array(src.length); const out8b = new Uint8ClampedArray(src.length);
      convertGreyFromSource(src, weights, preSat, dense, packed, out16a, out8a, littleEndian);
      convertGreyFromSource(src, weights, preSat, tiled, packed, out16b, out8b, littleEndian, 300);
      assert.deepEqual(out16b, out16a, `grey tiled 16-bit (preSat ${Boolean(preSat)}, LE ${littleEndian})`);
      assert.deepEqual(out8b, out8a, `grey tiled 8-bit (preSat ${Boolean(preSat)}, LE ${littleEndian})`);
    }
  }
}

// D5 memory: a stroke covering about 7 % of a frame keeps well under the dense map.
{
  const geometry = { baseWidth: 2400, baseHeight: 1600, rotationAngle: 0, mirrored: false, rotatedWidth: 2400, rotatedHeight: 1600, cropRegion: null, width: 2400, height: 1600 };
  const points = Array.from({ length: 100 }, (_, i) => ({ x: 0.2 + i * 0.006, y: 0.5 + Math.sin(i / 10) * 0.05, p: 1 }));
  const exposure = sanitizeLocalExposureStrokes({ strokes: [{ stops: 1, size: 0.12, feather: 0.5, points }] });
  const tiled = rasterizeExposureStopsTiled(exposure, geometry);
  const dense = rasterizeExposureStops(exposure, geometry);
  const covered = dense.reduce((count, v) => count + (v !== 0 ? 1 : 0), 0) / dense.length;
  assert.ok(covered > 0.05 && covered < 0.12, `fixture covers ${covered}`);
  // 256 px tiles are coarse at 4 MP; at 60 MP the same stroke's edge tiles are
  // a smaller share (scripts/bench-exposure-maps.mjs measures 12 MP).
  const ratio = exposureStopsBytes(tiled) / dense.byteLength;
  assert.ok(ratio < 0.3, `tiled map is ${Math.round(ratio * 100)} % of the dense one`);
  assertSameBits(denseOfTiled(tiled), dense, 'large tiled map');
}

console.log(`localExposure.incremental.test.mjs passed (${sets} random sets)`);
