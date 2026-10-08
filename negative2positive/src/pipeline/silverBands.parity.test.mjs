// #256 Part 5 parity: a conversion run as row bands (silverBands.js: plan,
// per-band prepare, merged analysis, tables, per-band apply, halo exchange
// for sharpening) against the whole-frame transient path of runSilverCore
// (convertFrameWithRouter with forceFullProcess), by SHA-256 of the 16-bit
// plane, the 8-bit data and the analysis preview. Band counts 1-7, one-row
// bands, odd widths, with and without a reference sample, colour, B&W and
// positive, flat field, dodge-and-burn strokes, overrides, profiles, paper and
// toning; film-base bands on both sides of the 262 144 px table threshold;
// sharpening at radius 0.5, 1 and 3 with halos at both frame edges; and
// Step 3 on bands (with the expired spatial map) against the whole frame.
// Run with: node negative2positive/src/pipeline/silverBands.parity.test.mjs
import assert from 'node:assert/strict';
import { sha, oracle } from './oracle/adapterParity.mjs';
import { convertFrameWithRouter } from './conversionRouter.js';
import { invalidateSilverCoreCache } from './silverAdapter.js';
import {
  convertInBands, planConversionBands, bandsSupported, copyBandRows, haloFor, sharpenSilverCoreBand, adjustBand, planSilverCoreBands, prepareSilverCoreBand, buildBandTables, applySilverCoreBand
} from './silverBands.js';
import { applyUnsharpMask, unsharpMaskHaloRows } from '../silvercore/engine/Sharpening.js';
import { PAPER_IDS, TONING_IDS, paperProfiles } from '../silvercore/engine/PaperProfiles.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import { filmPresets } from '../silvercore/engine/FilmPresets.js';
import { sanitizeFlatFieldMap } from '../app/flatField.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from '../workers/pixelAdjustments.js';
import { applyAdjustmentsToPixels16, downconvertPlane16 } from '../workers/pixelAdjustments16.js';
import { analyzeExpiredFilm, EXPIRED_RESCUE_DEFAULTS, EXPIRED_SPATIAL_VERSION } from './expiredRescue.js';

function negative(seed, w, h) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (w + h);
      let r = 52000 - 30000 * t, g = 36000 - 22000 * t, b = 24000 - 15000 * t;
      if ((x * 7 + y * 5 + seed) % 13 === 0) { r *= 0.6; g *= 1.2; }
      if ((x * 3 + y * 11 + seed) % 17 === 0) { b *= 1.8; }
      if ((x + y * seed) % 29 === 0) { r = g = b = 30000 + seed * 100; }
      const corner = (x < 3 || x >= w - 3) && (y < 3 || y >= h - 3);
      data[i] = Math.min(65535, Math.round(r + ((x * 131 + y * 71 * seed) % 900)));
      data[i + 1] = Math.min(65535, Math.round(g + ((x * 97 + y * 53 * seed) % 700)));
      data[i + 2] = Math.min(65535, Math.round(b + ((x * 61 + y * 89 * seed) % 500)));
      data[i + 3] = corner ? 0 : y === 5 ? 32768 : 65535;
    }
  }
  return { width: w, height: h, data };
}

function positive(scale, w, h, cast = [1.1, 1, 0.9]) {
  const data = new Uint16Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const x = p % w, y = (p / w) | 0;
    const v = (0.25 + 0.75 * (x + y) / (w + h)) * scale;
    let r = v, g = v, b = v;
    if ((x * 7 + y * 3) % 11 === 0) { r = v * 0.9; g = v * 0.5; b = v * 0.2; }
    const corner = (x < 2 || x >= w - 2) && (y < 2 || y >= h - 2);
    data.set([
      Math.min(65535, Math.round(r * cast[0] * 65535)),
      Math.min(65535, Math.round(g * cast[1] * 65535)),
      Math.min(65535, Math.round(b * cast[2] * 65535)),
      corner ? 0 : 65535,
    ], p * 4);
  }
  return { width: w, height: h, data };
}

function crop(image, left, top, w, h) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + left + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}

// The frame as the conversion sees it: ImageData with its genuine 16-bit plane.
function frame(plane) {
  const data8 = new Uint8ClampedArray(plane.data.length);
  for (let i = 0; i < data8.length; i++) data8[i] = plane.data[i] >>> 8;
  const image = new ImageData(data8, plane.width, plane.height);
  image.__image16 = { width: plane.width, height: plane.height, data: new Uint16Array(plane.data) };
  return image;
}

async function wholeFrame(plane, settings, options) {
  invalidateSilverCoreCache();
  const result = settings.filmType === 'positive'
    ? await oracle.convertPositiveWithSilverCore(frame(plane), structuredClone(settings), { forceFullProcess: true, ...options })
    : await convertFrameWithRouter({ imageData: frame(plane), settings: structuredClone(settings), options: { forceFullProcess: true, ...options } });
  return {
    image16: sha(result.__image16.data), image8: sha(result.data),
    analysisPreview: result.__analysisPreview ? sha(result.__analysisPreview.data) : null
  };
}

async function banded(plane, settings, options, count) {
  const result = await convertInBands({ imageData: frame(plane), settings: structuredClone(settings), options: { forceFullProcess: true, ...options } }, count);
  return {
    image16: sha(result.data16), image8: sha(result.data8),
    analysisPreview: result.analysisPreview ? sha(result.analysisPreview.data) : null
  };
}

let checks = 0;
async function expectSame(label, plane, settings, options = {}, counts = [1, 2, 3, 4, 5, 6, 7]) {
  const expected = await wholeFrame(plane, settings, options);
  for (const count of counts) {
    assert.deepEqual(await banded(plane, settings, options, count), expected, `${label}: ${count} band(s)`);
    checks++;
  }
}

// ---- band plans --------------------------------------------------------------------
assert.deepEqual(planConversionBands(10, 3), [{ y0: 0, y1: 4 }, { y0: 4, y1: 7 }, { y0: 7, y1: 10 }]);
assert.deepEqual(planConversionBands(3, 7), [{ y0: 0, y1: 1 }, { y0: 1, y1: 2 }, { y0: 2, y1: 3 }], 'never more bands than rows');
assert.deepEqual(planConversionBands(5, 0), [{ y0: 0, y1: 5 }]);
{
  const plane = negative(1, 5, 4);
  const image = frame(plane);
  assert.equal(bandsSupported({ imageData: image, options: { forceFullProcess: true } }), true);
  assert.equal(bandsSupported({ imageData: image, options: {} }), false, 'interactive requests keep their worker');
  assert.equal(bandsSupported({ imageData: image, options: { forceFullProcess: true, preview: true } }), false);
  assert.equal(bandsSupported({ imageData: new ImageData(image.data, 5, 4), options: { forceFullProcess: true } }), false, '8-bit sources');
  assert.equal(bandsSupported({ imageData: image, settings: { filmType: 'positive', positiveEngine: 'legacy' }, options: { forceFullProcess: true } }), false);
}

// ---- conversions: every mode, with and without a reference sample ----------------
const W = 41;
const H = 23; // odd width; 7 bands of 3-4 rows
const flatField = sanitizeFlatFieldMap({ id: 'pad', width: 4, height: 4, gains: Array.from({ length: 48 }, (_, i) => 1 + ((i * 7) % 11) / 25) });
const geometry = { baseWidth: 50, baseHeight: 30, rotatedWidth: 52, rotatedHeight: 34, rotationAngle: 3, mirrored: true, cropRegion: { left: 4, top: 5, width: 45, height: 26 } };
const flat = { flatField, flatFieldGeometry: geometry };
const strokes = {
  localExposure: { strokes: [
    { stops: 0.8, size: 0.3, feather: 0.5, points: [{ x: 0.2, y: 0.4, p: 1 }, { x: 0.45, y: 0.65, p: 0.8 }] },
    { stops: -0.6, size: 0.25, feather: 0.3, points: [{ x: 0.7, y: 0.2, p: 1 }] },
    { stops: 1.2, size: 0.05, feather: 0, points: [{ x: 0.5, y: 0.98, p: 1 }] },
  ] },
  localExposureGeometry: geometry,
};
const override = [
  { whitePointOrigin: 9000, blackPointOrigin: 52000, meanPoint: 0.42, settingName: 'ToneCurvePV2012Red' },
  { whitePointOrigin: 8000, blackPointOrigin: 41000, meanPoint: 0.45, settingName: 'ToneCurvePV2012Green' },
  { whitePointOrigin: 6000, blackPointOrigin: 30000, meanPoint: 0.5, settingName: 'ToneCurvePV2012Blue' },
];
const papers = (kind) => PAPER_IDS.filter((id) => id !== 'none' && paperProfiles[id].kind === kind);
const recipes = {
  color: [
    { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
    { filmType: 'color', colorModel: 'frontier', filmBase: { r: 205, g: 150, b: 100 }, filmBaseCompensation: 'linear', preSaturation: 120, saturation: 130 },
    { filmType: 'color', colorModel: 'none', preSaturation: 0, borderBuffer: 0, contrast: 20, temperature: 15 },
    { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, ...flat, ...strokes },
    { filmType: 'color', analysisRegion: { left: 0.1, top: 0.2, width: 0.5, height: 0.6 }, highlights: -30, shadows: 20 },
    { filmType: 'color', filmBase: { r: 210, g: 140, b: 90 }, analysisOverride: override },
    { filmType: 'color', enhancedProfile: 'frontier', profileStrength: 80, paper: papers('ra4')[0], paperToning: TONING_IDS.at(-1), paperToningStrength: 60 },
    { filmType: 'color', filmPreset: Object.keys(filmPresets).find((id) => filmPresets[id].category === 'color') },
  ],
  bw: [
    { filmType: 'bw' },
    { filmType: 'bw', bwMix: Object.keys(bwMixWeights).at(-1), preSaturation: 130, ...strokes },
    { filmType: 'bw', ...flat, paper: papers('bw')[0], paperToning: 'sepia', paperToningStrength: 70 },
    { filmType: 'bw', analysisOverride: override, enhancedProfile: 'natural', profileStrength: 120 },
    { filmType: 'bw', filmPreset: Object.keys(filmPresets).find((id) => filmPresets[id].category === 'bw') },
  ],
  positive: [
    { filmType: 'positive' },
    { filmType: 'positive', positiveMode: 'edit', saturation: 120 },
    { filmType: 'positive', ...strokes, preSaturation: 110, borderBuffer: 0 },
    { filmType: 'positive', ...flat, enhancedProfile: 'crystal', profileStrength: 100 },
  ],
};
const sources = {
  color: negative(2, W, H),
  bw: negative(3, W, H),
  positive: positive(1, W, H),
};
// The dim slide gets a gain above 1 (no fold); the bright one a white balance.
const dimPositive = positive(0.6, W, H, [1, 1, 1]);
for (const [mode, list] of Object.entries(recipes)) {
  const plane = sources[mode];
  const reference = crop(plane, 3, 2, 30, 17);
  for (const [index, settings] of list.entries()) {
    await expectSame(`${mode} #${index}`, plane, settings);
    await expectSame(`${mode} #${index} + reference`, plane, settings, { analysisImageData: reference });
    await expectSame(`${mode} #${index} + reference, no preview`, plane, settings,
      { analysisImageData: reference, includeAnalysisPreview: false }, [1, 3, 7]);
  }
}
await expectSame('dim positive (gain > 1)', dimPositive, { filmType: 'positive' });

// One-row bands of a 7-row frame, and a one-pixel-wide frame.
await expectSame('one-row bands', negative(4, 13, 7), recipes.color[3]);
await expectSame('one column', negative(5, 1, 9), recipes.bw[1], {}, [1, 4, 7]);

// Film base: the whole frame (602 x 500 = 301 000 px) takes the table path,
// bands under 262 144 px compute per pixel, bands over it take the table.
{
  const big = negative(6, 602, 500);
  await expectSame('film-base table threshold', big, recipes.color[1], {}, [1, 2, 6]);
}

// ---- sharpening with halos ----------------------------------------------------------
// The adapter never asks the engine to sharpen, but the stage exists: bands
// sharpen after exchanging their unsharpened edge rows, clamped at the frame's
// edges, never at a band's. Radius 0.5, 1 and 3 (a 19-row kernel: its halo
// spans several one-row bands).
for (const radius of [0.5, 1, 3]) {
  for (const [width, height] of [[17, 29], [9, 7]]) {
    const plane = negative(7, width, height);
    const sharpen = { amount: 140, radius, threshold: radius === 1 ? 3 : 0 };
    const whole = { width, height, data: new Uint16Array(plane.data) };
    applyUnsharpMask(whole, sharpen);
    const tables = { sharpen };
    const halo = unsharpMaskHaloRows(sharpen);
    for (let count = 1; count <= 7; count++) {
      const bands = planConversionBands(height, count).map(({ y0, y1 }) => ({
        y0, y1, band: { width, height: y1 - y0, data: copyBandRows(plane.data, width, 0, y0, y1) }
      }));
      const edges = bands.map(({ band, y0, y1 }) => ({
        y0, y1,
        top: copyBandRows(band.data, width, y0, y0, Math.min(y1, y0 + halo)),
        bottom: copyBandRows(band.data, width, y0, Math.max(y0, y1 - halo), y1)
      }));
      const out = new Uint16Array(plane.data.length);
      for (const { band, y0, y1 } of bands) {
        const { above, below } = haloFor(edges, width, height, y0, y1, halo);
        sharpenSilverCoreBand({ height }, tables, band, y0, above, below);
        out.set(band.data, y0 * width * 4);
      }
      assert.equal(sha(out), sha(whole.data), `sharpen radius ${radius} ${width}x${height}, ${count} band(s)`);
      checks++;
    }
  }
}

// ---- Step 3 on bands ------------------------------------------------------------------
{
  const IW = 37;
  const IH = 29;
  const plane16 = positive(0.9, IW, IH, [1.05, 1, 0.92]).data;
  for (let i = 3; i < plane16.length; i += 4) plane16[i] = 65535;
  const plane8 = downconvertPlane16(plane16, new Uint8ClampedArray(plane16.length));
  const linear = () => Uint8Array.from({ length: 256 }, (_, v) => v);
  const sCurve = () => Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
  const base = () => ({
    curves: { r: linear(), g: linear(), b: linear() }, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0,
    saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1, look: null, ...EXPIRED_RESCUE_DEFAULTS, expiredAnalysis: null
  });
  const measured = analyzeExpiredFilm({ width: IW, height: IH, data: plane8, __image16: { width: IW, height: IH, data: plane16 } }, { borderBuffer: 0 });
  assert.ok(measured);
  const spatial = {
    version: EXPIRED_SPATIAL_VERSION, fraction: { left: 0.05, top: 0.1, width: 0.9, height: 0.8 }, gridWidth: 4, gridHeight: 3,
    fog: { coefficients: [[0.18, -0.12, 0.02, 0.03, -0.01, 0.01], [0.16, -0.1, 0.01, 0.02, 0, 0.02], [0.2, -0.14, 0.03, 0.04, -0.02, 0]],
      offset: [0.02, 0.03, 0.01], amplitude: [0.12, 0.1, 0.14] },
    mean: [0.31, 0.42, 0.5, 0.58, 0.35, 0.44, 0.52, 0.61, 0.38, 0.47, 0.55, 0.66]
  };
  const steps = {
    separable: { ...base(), curves: { r: sCurve(), g: linear(), b: sCurve() }, exposure: 0.3, contrast: 12, temperature: 10, wbR: 1.08 },
    saturation: { ...base(), saturation: 10 },
    'hsl + highlights': { ...base(), highlights: -20, shadows: 15, saturation: 10, vibrance: 25 },
    'expired + spatial map': {
      ...base(), expiredEnabled: true, expiredLevels: 80, expiredNeutralize: 100, expiredCrossover: 60, expiredBrightness: 10,
      expiredContrast: 20, expiredUnevenFog: 100, expiredLocalContrast: 40, expiredAnalysis: { ...measured, spatial }
    },
  };
  assert.ok(computeAdjustmentParams(steps['expired + spatial map'], { width: IW, height: IH }).doRescueSpatial);
  for (const [label, settings] of Object.entries(steps)) {
    const params = computeAdjustmentParams(structuredClone(settings), { width: IW, height: IH });
    const whole16 = new Uint16Array(plane16);
    applyAdjustmentsToPixels16(whole16, whole16, IW * IH, params, 'full');
    const whole8 = new Uint8ClampedArray(plane8);
    applyAdjustmentsToPixels(whole8, whole8, IW * IH, params, 'full');
    const mirror = downconvertPlane16(whole16, new Uint8ClampedArray(whole16.length));
    for (let count = 1; count <= 7; count++) {
      const out16 = new Uint16Array(plane16.length);
      const out8 = new Uint8ClampedArray(plane8.length);
      const outMirror = new Uint8ClampedArray(plane8.length);
      for (const { y0, y1 } of planConversionBands(IH, count)) {
        const rows = y1 - y0;
        // A JPEG with the gain map runs both passes with identical parameters.
        const result = adjustBand({ data16: copyBandRows(plane16, IW, 0, y0, y1), data8: copyBandRows(plane8, IW, 0, y0, y1) }, {
          width: IW, rows, startRow: y0, frameWidth: IW, frameHeight: IH, settings: structuredClone(settings), bits16: true, bits8: true
        });
        out16.set(result.data16, y0 * IW * 4);
        out8.set(result.data8, y0 * IW * 4);
        const mirrored = adjustBand({ data16: copyBandRows(plane16, IW, 0, y0, y1) }, {
          width: IW, rows, startRow: y0, frameWidth: IW, frameHeight: IH, settings: structuredClone(settings), bits16: true, mirror8: true
        });
        outMirror.set(mirrored.data8, y0 * IW * 4);
      }
      assert.equal(sha(out16), sha(whole16), `Step 3 16-bit ${label}, ${count} band(s)`);
      assert.equal(sha(out8), sha(whole8), `Step 3 8-bit ${label}, ${count} band(s)`);
      assert.equal(sha(outMirror), sha(mirror), `Step 3 mirror ${label}, ${count} band(s)`);
      checks += 3;
    }
  }
}

console.log(`silverBands parity: ${checks} banded results match the whole frame`);

// D5 on the real band apply path: no tile memory in untouched bands. This
// small frame preserves relative brush geometry; scale bytes to 60 MP rather
// than allocating a 60 MP source. Both colour and grey must stay bit-exact.
{
  const width = 3000, height = 2000;
  const small = negative(11, width, height);
  const exposure = { localExposure: { strokes: [{ stops: 0.8, size: 0.07, feather: 0.5,
    points: [{ x: 0.3, y: 0.25, p: 1 }, { x: 0.6, y: 0.4, p: 0.7 }] }] },
    localExposureGeometry: { baseWidth: width, baseHeight: height, rotatedWidth: width, rotatedHeight: height,
      rotationAngle: 0, mirrored: false, cropRegion: null } };
  for (const filmType of ['color', 'bw']) {
    const settings = { filmType, ...exposure };
    await expectSame(`7 percent stroke ${filmType}`, small, settings, {}, [6]);
    const job = await planSilverCoreBands({ settings, width, height, includeAnalysisPreview: false });
    const bands = planConversionBands(height, 6).map(({ y0, y1 }) => ({ y0,
      band: { width, height: y1 - y0, data: copyBandRows(small.data, width, 0, y0, y1) } }));
    const partials = bands.map(({ band, y0 }) => prepareSilverCoreBand(job.plan, band, y0));
    const tables = buildBandTables(job, partials);
    for (const { band, y0 } of bands) applySilverCoreBand(job.plan, tables, band, y0);
    const bytes = bands.reduce((sum, { band }) => sum + band.stopsBytes, 0);
    assert.equal(bands.at(-1).band.stopsBytes, 0, 'untouched band allocates no stops tiles');
    const scaled = bytes * 60_000_000 / (width * height);
    assert.ok(scaled <= 40_000_000, `concurrent band stops scaled to 60 MP: ${scaled}`);
    console.log(`band stops ${filmType}: ${bytes} B, 60 MP scaled ${scaled} B`);
  }
}
