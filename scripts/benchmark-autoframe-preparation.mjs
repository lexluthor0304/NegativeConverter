// Isolates the repeated zero-angle fallback preparation. The comparison keeps
// the existing Hough cache active on both sides and changes no detector inputs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { getAnalyzerContext, detectFrameCandidatesWithCv } from '../negative2positive/src/app/autoFrameAnalyzer.js';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
const width = 1600, height = 1067;
const data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const inside = x > 270 && x < 1300 && y > 195 && y < 875;
  const grain = (x * 13 + y * 23) % 27;
  data.set(inside ? [90 + grain, 50 + grain, 30 + grain, 255] : [238, 160, 100, 255], (y * width + x) * 4);
}
const image = { width, height, data };
const context = getAnalyzerContext({ settings: { formatPreference: '135', filmType: 'color' } });
context.reusablePreview = image;
detectFrameCandidatesWithCv(image, context, { minAreaRatio: .04 });
const options = { minAreaRatio: .04, retrievalMode: 'external' };
const baseline = [], cached = [];
for (let repeat = 0; repeat < 5; repeat++) {
  // Simulate the prior zero-angle pass: Hough candidate reused, but edge
  // preparation and density analysis/template scoring repeated.
  context.previewEdges = null;
  context.previewDensityCandidates = null;
  let start = performance.now();
  const expected = detectFrameCandidatesWithCv(image, context, options);
  baseline.push(performance.now() - start);
  start = performance.now();
  const result = detectFrameCandidatesWithCv(image, context, options);
  cached.push(performance.now() - start);
  assert.deepEqual(result, expected, 'candidate values and ordering must be exact');
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ width, height, comparison: 'zero-angle pass with Hough reused in both cases',
  baselineMs: baseline, cachedMs: cached, medianBaselineMs: median(baseline), medianCachedMs: median(cached),
  retainedEdgeBytes: context.previewEdges.byteLength, densityCandidates: context.previewDensityCandidates.length,
  exactResults: true }, null, 2));
