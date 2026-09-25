// #238 (5): the B&W grey plane pieces reproduce the RGBA stages exactly — the grey
// histogram, the pre-saturation ramp, single-channel stops, the grey → RGB table and
// the packed / per-channel output loops.
import assert from 'node:assert/strict';
import { Engine } from './Engine.js';
import { analyzeImage, analyzeGreyImage, greyChannelLevels, adjustSaturation } from './ImageProcessor.js';
import { bwMixWeights } from './Presets.js';
import { applyExposureStopsToImage16, applyExposureStopsToGrey, exposeGreyValue } from '../util/localExposure.js';
import { mixToGrey, packGreyTable, writeGreyOutput, convertGreyFromSource, greyHistogramFromSource } from '../util/greyPlane.js';
import { analysisPixelBounds } from '../../app/analysisRegion.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// An RGBA16 source with transparent pixels; its grey mix as RGBA (what the adapter's
// toGrayscaleInPlace produced) and as a plane.
function fixture(w, h, seed) {
  const rand = rng(seed);
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rand() * 65536; data[i + 1] = rand() * 65536; data[i + 2] = rand() * 65536;
    data[i + 3] = rand() < 0.08 ? 0 : rand() < 0.1 ? 1234 : 65535;
  }
  return { width: w, height: h, data };
}
function rgbaGrey(src, weights) {
  const out = new Uint16Array(src.data);
  for (let i = 0; i < out.length; i += 4) {
    const y = Math.round(out[i] * weights.r + out[i + 1] * weights.g + out[i + 2] * weights.b);
    out[i] = out[i + 1] = out[i + 2] = y;
  }
  return { width: src.width, height: src.height, data: out };
}

const src = fixture(97, 71, 5);
for (const [mix, weights] of Object.entries(bwMixWeights)) {
  const grey = mixToGrey(src.data, weights, null, new Uint16Array(97 * 71));
  const rgba = rgbaGrey(src, weights);
  for (let p = 0; p < grey.length; p++) assert.equal(grey[p], rgba.data[p * 4], `${mix}: mix`);

  // --- histogram → channel levels ------------------------------------------------
  for (const borderBuffer of [0, 10, 30]) {
    for (const analysisRegion of [null, { left: 0.1, top: 0.25, width: 0.6, height: 0.5 }]) {
      for (const excludeTransparent of [false, true]) {
        for (const colorModel of ['mono', 'standard']) {
          const params = { borderBuffer, analysisRegion, excludeTransparent, colorModel, imageType: 'negative' };
          const expected = analyzeImage(rgba, params);
          assert.deepEqual(analyzeGreyImage(grey, 97, 71, params, src.data), expected, `${mix} grey plane levels`);
          const bounds = analysisPixelBounds(97, 71, analysisRegion, borderBuffer / 100);
          const { hist, total } = greyHistogramFromSource(src.data, 97, bounds, weights, null, excludeTransparent);
          assert.deepEqual(greyChannelLevels(hist, total, params), expected, `${mix} on-the-fly levels`);
        }
      }
    }
  }
}
{
  // Opaque plane: alpha null gives the same levels as the RGBA image with alpha 65535.
  const opaque = fixture(64, 48, 9);
  for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 65535;
  const weights = bwMixWeights.standard;
  const grey = mixToGrey(opaque.data, weights, null, new Uint16Array(64 * 48));
  const params = { borderBuffer: 10, excludeTransparent: true, colorModel: 'mono' };
  assert.deepEqual(analyzeGreyImage(grey, 64, 48, params, null), analyzeImage(rgbaGrey(opaque, weights), params));
}

// --- pre-saturation ramp = adjustSaturation on grey pixels (drift included) ---------
const engine = new Engine(4, 4);
assert.equal(engine.preSaturationRamp({ preSaturation: 100 }), null);
for (const amount of [0, 37, 120, 200]) {
  const ramp = engine.preSaturationRamp({ preSaturation: amount });
  const rgba = rgbaGrey(src, bwMixWeights.standard);
  adjustSaturation(rgba, amount);
  const grey = mixToGrey(src.data, bwMixWeights.standard, ramp, new Uint16Array(97 * 71));
  for (let p = 0; p < grey.length; p++) {
    assert.equal(grey[p], rgba.data[p * 4], `preSaturation ${amount}`);
    assert.equal(rgba.data[p * 4 + 1], rgba.data[p * 4]);
    assert.equal(rgba.data[p * 4 + 2], rgba.data[p * 4]);
  }
}

// --- single-channel stops = applyExposureStopsToImage16 on grey pixels -------------
{
  const n = 65536;
  const img = { width: n, height: 1, data: new Uint16Array(n * 4) };
  const grey = new Uint16Array(n);
  const stops = new Float32Array(n);
  const rand = rng(3);
  for (let v = 0; v < n; v++) {
    img.data[v * 4] = img.data[v * 4 + 1] = img.data[v * 4 + 2] = v;
    grey[v] = v;
    stops[v] = v % 5 === 0 ? 0 : (rand() - 0.5) * 6;
  }
  applyExposureStopsToImage16(img, stops);
  applyExposureStopsToGrey(grey, stops);
  for (let v = 0; v < n; v++) {
    assert.equal(grey[v], img.data[v * 4], 'stops');
    assert.equal(img.data[v * 4 + 1], img.data[v * 4]);
    if (stops[v] !== 0) assert.equal(exposeGreyValue(v, stops[v]), grey[v]);
  }
}

// --- the table: _applyLuts over the ramp = _applyLuts over a grey image ------------
{
  const e = new Engine(97, 71);
  const params = { colorModel: 'mono', imageType: 'negative', brightness: 12, contrast: 20, saturation: 130, paper: 'multigrade-fb-warmtone', paperToning: 'split', paperToningStrength: 70, shadowTemp: 8, highlightTint: -5 };
  e.analyze(rgbaGrey(src, bwMixWeights.standard), params);
  const table = e.buildGreyTable(params);
  const reference = e.reprocess(rgbaGrey(src, bwMixWeights.standard), params);
  const grey = mixToGrey(src.data, bwMixWeights.standard, null, new Uint16Array(97 * 71));
  for (let p = 0; p < grey.length; p++) {
    const y = grey[p];
    assert.deepEqual([table.r[y], table.g[y], table.b[y]], Array.from(reference.data.subarray(p * 4, p * 4 + 3)), 'table');
  }
  assert.equal(e.greyTableAvailable(params), true);
  // A spatial stage has no per-value table.
  const sharpen = e.buildSettings;
  e.buildSettings = (p) => ({ ...sharpen.call(e, p), sharpenAmount: 40 });
  assert.ok(e.buildGreyTable(params) === null);
  e.reprocess(rgbaGrey(src, bwMixWeights.standard), params);
  assert.ok(e.buildCurrentGreyTable(params) === null);
  assert.equal(e.greyTableAvailable(params), false);
}

// --- output loops: packed little-endian stores = per-channel stores -----------------
{
  const n = 97 * 71;
  const table = { r: new Uint16Array(65536), g: new Uint16Array(65536), b: new Uint16Array(65536) };
  const rand = rng(11);
  for (let v = 0; v < 65536; v++) { table.r[v] = rand() * 65536; table.g[v] = rand() * 65536; table.b[v] = rand() * 65536; }
  const ramp = engine.preSaturationRamp({ preSaturation: 140 });
  const grey = mixToGrey(src.data, bwMixWeights.red, null, new Uint16Array(n));
  const expect = (y, a) => [table.r[y], table.g[y], table.b[y], a];
  for (const alpha of [null, src.data]) {
    for (const littleEndian of [true, false]) {
      const out16 = new Uint16Array(n * 4), out8 = new Uint8ClampedArray(n * 4);
      writeGreyOutput(grey, alpha, packGreyTable(table), out16, out8, littleEndian);
      for (let p = 0; p < n; p++) {
        const want = expect(grey[p], alpha ? alpha[p * 4 + 3] : 65535);
        assert.deepEqual(Array.from(out16.subarray(p * 4, p * 4 + 4)), want);
        assert.deepEqual(Array.from(out8.subarray(p * 4, p * 4 + 4)), want.map((v) => v >>> 8));
      }
    }
  }
  const stops = new Float32Array(n).map((_, p) => (p % 3 ? 0 : (p % 7) / 3 - 1));
  for (const [preSatRamp, withStops] of [[null, false], [ramp, false], [null, true], [ramp, true]]) {
    const wantGrey = mixToGrey(src.data, bwMixWeights.red, preSatRamp, new Uint16Array(n));
    if (withStops) applyExposureStopsToGrey(wantGrey, stops);
    const results = [];
    for (const littleEndian of [true, false]) {
      const out16 = new Uint16Array(n * 4), out8 = new Uint8ClampedArray(n * 4);
      const packed = packGreyTable(table, withStops ? null : preSatRamp);
      convertGreyFromSource(src.data, bwMixWeights.red, withStops ? preSatRamp : null, withStops ? stops : null, packed, out16, out8, littleEndian);
      for (let p = 0; p < n; p++) {
        assert.deepEqual(Array.from(out16.subarray(p * 4, p * 4 + 4)), expect(wantGrey[p], src.data[p * 4 + 3]));
      }
      results.push(out16, out8);
    }
    assert.deepEqual(results[0], results[2]);
    assert.deepEqual(results[1], results[3]);
    // In place: the source plane itself takes the output.
    const inPlace = new Uint16Array(src.data), out8 = new Uint8ClampedArray(n * 4);
    convertGreyFromSource(inPlace, bwMixWeights.red, withStops ? preSatRamp : null, withStops ? stops : null, packGreyTable(table, withStops ? null : preSatRamp), inPlace, out8);
    assert.deepEqual(inPlace, results[0]);
  }
}

console.log('greyTable: histogram levels, pre-saturation ramp, grey stops, table, packed and per-channel output identical to the RGBA stages');
