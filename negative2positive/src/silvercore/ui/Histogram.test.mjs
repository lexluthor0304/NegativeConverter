import assert from 'node:assert/strict';
import { Histogram, fillHistogramBins, HISTOGRAM_MAX_SAMPLES } from './Histogram.js';

const ctx = new Proxy({}, { get: () => () => {} });
const histogram = new Histogram({ width: 300, height: 150, getContext: () => ctx });
const originalBins = [histogram.rHist, histogram.gHist, histogram.bHist, histogram.lHist];
const data = Uint8ClampedArray.from({ length: 100 * 80 * 4 }, (_, i) => (i * 73 + (i >>> 5)) % 256);
histogram.draw({ width: 100, height: 80, data });
const expected = Array.from({ length: 4 }, () => new Uint32Array(256));
for (let i = 0; i < data.length; i += 4) {
  expected[0][data[i]]++; expected[1][data[i + 1]]++; expected[2][data[i + 2]]++;
  expected[3][Math.round(.299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2])]++;
}
assert.deepEqual(originalBins, expected, 'small images preserve every histogram bin');
histogram.draw({ width: 100, height: 80, data, __image16: { width: 100, height: 80, data: Uint16Array.from(data, v => v * 257) } });
assert.deepEqual(originalBins, expected, '16-bit handle preserves display bins');
assert.equal(histogram.rHist, originalBins[0], 'bin buffers reused');

for (const [width, height] of [[6000, 4000], [1000000, 1], [1, 1000000]]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  // Four equal vertical regions test that the grid spans the whole frame.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 4] = Math.floor((width > 1 ? x / width : y / height) * 4) * 64;
  const sampled = fillHistogramBins({ width, height, data: pixels }, histogram);
  assert.ok(sampled <= HISTOGRAM_MAX_SAMPLES);
  assert.equal(histogram.rHist.reduce((a, b) => a + b, 0), sampled);
  for (const value of [0, 64, 128, 192]) assert.ok(Math.abs(histogram.rHist[value] / sampled - .25) < .005, 'representative full-frame grid');
}
histogram.draw({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) });
assert.equal(histogram.rHist[0], 1, 'previous bins are cleared, including clipped images');
console.log('Histogram: exact small images, 16-bit source, sample cap, coverage and buffer reuse passed');
