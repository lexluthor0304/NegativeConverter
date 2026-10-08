#!/usr/bin/env node
// Dodge-and-burn map timings (#254 D1/D2/D5) on synthetic frames, against the
// raster before #254 (pipeline/oracle/localExposure.oracle.js).
//
//   node scripts/bench-exposure-maps.mjs [--max-mp 12] [--runs 3]
//
// Default stroke: 100 points, size 12 %, feather 50 %, uniform pressure (the
// issue's micro-benchmark stroke). Frames above --max-mp are skipped; the 60 MP
// figure of the acceptance criteria (9504 x 6320) needs `--max-mp 61` on an idle
// machine.
import { performance } from 'node:perf_hooks';
import {
  rasterizeExposureStops,
  rasterizeExposureStopsTiled,
  updateExposureStopsMap,
  exposureStopsBytes,
  sanitizeLocalExposureStrokes,
} from '../negative2positive/src/app/localExposure.js';
import * as oracle from '../negative2positive/src/pipeline/oracle/localExposure.oracle.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const maxMp = option('max-mp', 12);
const runs = option('runs', 3);

function geometryOf(width, height) {
  return { baseWidth: width, baseHeight: height, rotationAngle: 0, mirrored: false, rotatedWidth: width, rotatedHeight: height, cropRegion: null, width, height };
}

// Stroke i of a session: a wavy 100-point path, shifted per stroke.
function defaultStroke(i = 0) {
  const points = Array.from({ length: 100 }, (_, k) => ({
    x: 0.15 + ((i * 0.037) % 0.3) + k * 0.005,
    y: 0.25 + ((i * 0.061) % 0.5) + Math.sin(k / 12 + i) * 0.04,
    p: 1,
  }));
  return { stops: i % 2 ? -0.5 : 0.7, size: 0.12, feather: 0.5, points };
}
const strokesOf = (count, from = 0) => sanitizeLocalExposureStrokes({ strokes: Array.from({ length: count }, (_, i) => defaultStroke(from + i)) }).strokes;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function time(fn) {
  const samples = [];
  let result;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    result = fn();
    samples.push(performance.now() - start);
  }
  return { ms: median(samples), result };
}
const fmt = (ms) => `${ms.toFixed(1)} ms`;

const frames = [[1832, 1222], [2449, 1628], [4000, 3000], [9504, 6320]];
console.log(`bench-exposure-maps: runs=${runs}, max ${maxMp} MP`);
for (const [width, height] of frames) {
  if (width * height > maxMp * 1e6) {
    console.log(`${width}x${height}: skipped (above --max-mp ${maxMp})`);
    continue;
  }
  const geometry = geometryOf(width, height);
  const one = { strokes: strokesOf(1) };
  const head = time(() => oracle.rasterizeExposureStops(one, geometry));
  const dense = time(() => rasterizeExposureStops(one, geometry));
  const tiled = time(() => rasterizeExposureStopsTiled(one, geometry));
  const coverage = dense.result.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0) / dense.result.length;
  console.log(`${width}x${height} one default stroke: before ${fmt(head.ms)}, dense ${fmt(dense.ms)}, tiled ${fmt(tiled.ms)}; `
    + `covers ${(coverage * 100).toFixed(1)} %, map ${(dense.result.byteLength / 1048576).toFixed(1)} MB dense vs ${(exposureStopsBytes(tiled.result) / 1048576).toFixed(1)} MB tiled`);
}

// Prefix maps at 2449 x 1628: the cost of stroke N+1 and of undoing it.
{
  const geometry = geometryOf(2449, 1628);
  const strokes = strokesOf(21);
  for (const n of [1, 10, 20]) {
    const addSamples = [];
    const undoSamples = [];
    let full = 0;
    for (let r = 0; r < runs; r++) {
      const { map } = updateExposureStopsMap(null, { strokes: strokes.slice(0, n) }, geometry);
      let start = performance.now();
      updateExposureStopsMap(map, { strokes: strokes.slice(0, n + 1) }, geometry);
      addSamples.push(performance.now() - start);
      start = performance.now();
      updateExposureStopsMap(map, { strokes: strokes.slice(0, n) }, geometry);
      undoSamples.push(performance.now() - start);
      if (r === 0) {
        start = performance.now();
        oracle.rasterizeExposureStops({ strokes: strokes.slice(0, n + 1) }, geometry);
        full = performance.now() - start;
      }
    }
    console.log(`2449x1628 stroke ${n + 1} after ${n}: add ${fmt(median(addSamples))}, undo ${fmt(median(undoSamples))} (full raster before #254: ${fmt(full)})`);
  }
}
