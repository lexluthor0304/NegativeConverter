// #239: the GPU preview's inputs from the adapter. prepare/analyze read the same slot
// the next exact frame uses, and:
//  - the frame that follows them is bit-identical to the frozen 1703835 adapter's
//    forced conversion (they leave exact frames unchanged);
//  - the CPU apply chain (render/previewTables.js) over the prepared plane, with an
//    engine seeded from the analysis and the tick's plan, gives that frame bit for
//    bit, and over the point-sampled histogram plane gives the frame's samples;
//  - the analysis key changes exactly when an analysis input changes.
import assert from 'node:assert/strict';

const { live, oracle } = await import('./oracle/adapterParity.mjs');
const {
  prepareSilverCorePreview, analyzeSilverCorePreview, silverCoreAnalysisKey, silverCorePreparedKey,
  buildSilverCoreParams, invalidateSilverCoreCache,
} = live;
const { Engine } = await import('../silvercore/engine/Engine.js');
const { loadProfile } = await import('../silvercore/engine/EnhancedProfiles.js');
const { applyPreviewChain } = await import('../render/previewTables.js');
const { applyFilmBaseCompensationToBuffer } = await import('./filmBaseCompensation.js');
const { rasterizeExposureStops } = await import('../app/localExposure.js');
const { sanitizeFlatFieldMap } = await import('../app/flatField.js');

const CONVERT = { color: 'convertColorWithSilverCore', bw: 'convertBwWithSilverCore', positive: 'convertPositiveWithSilverCore' };
const W = 40, H = 30, PX = W * H;

function negative(seed = 1) {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const t = p / PX;
    data.set([46000 - 20000 * t + (p * 37 * seed) % 3000, 30000 - 15000 * t + (p * 53) % 2000, 20000 - 9000 * t + (p * 29) % 1500,
      p % 97 === 0 ? 0 : 65535], p * 4);
  }
  return { width: W, height: H, data };
}
function slide() {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const x = p % W, y = (p / W) | 0;
    const v = 0.25 + 0.75 * (x + y) / (W + H);
    const [r, g, b] = (x * 7 + y * 3) % 11 === 0 ? [v * 0.9, v * 0.5, v * 0.2] : [v, v, v];
    data.set([Math.min(65535, Math.round(r * 1.1 * 65535)), Math.round(g * 65535), Math.round(b * 0.9 * 65535), 65535], p * 4);
  }
  return { width: W, height: H, data };
}
// An 8-bit source (no plane): the worker promotes it by 257.
function eightBit(image) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i] >>> 8;
  return new ImageData(data, image.width, image.height);
}
function crop(image) {
  const w = 20, h = 14, data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(image.data.subarray(((y + 8) * W + 10) * 4, ((y + 8) * W + 10 + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false };
const strokes = {
  localExposure: { strokes: [{ stops: 0.8, size: 0.35, feather: 0.5, points: [{ x: 0.3, y: 0.4, p: 1 }, { x: 0.6, y: 0.6, p: 0.8 }] }] },
  localExposureGeometry: geometry,
};
const flatField = {
  flatField: sanitizeFlatFieldMap({ id: 'pad', width: 2, height: 2, gains: [1, 1.1, 1.2, 1.05, 1, 1.1, 1.2, 1.3, 1, 1, 1.1, 1.2] }),
  flatFieldGeometry: { ...geometry, cropRegion: null },
};
const BASE = {
  color: { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { filmType: 'bw', colorModel: 'standard', bwMix: 'orange' },
  positive: { filmType: 'positive', positiveMode: 'correct' },
};

function samePlane(a, b, label) {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${label}: first difference at ${i}: ${a[i]} vs ${b[i]}`);
}

let checked = 0;
for (const mode of ['color', 'bw', 'positive']) {
  for (const extra of [{}, strokes, flatField, { preSaturation: 140, saturation: 130 },
    { enhancedProfile: 'frontier', profileStrength: 160, paper: mode === 'bw' ? 'fomatone' : 'crystal-archive', paperToning: 'sepia', paperToningStrength: 60 },
    { ...strokes, preSaturation: 70, filmBaseStrength: 0.8 }]) {
    for (const withReference of [false, true]) {
      for (const eight of [false, true]) {
        invalidateSilverCoreCache();
        oracle.invalidateSilverCoreCache();
        const image16 = mode === 'positive' ? slide() : negative(3);
        const source = eight ? eightBit(image16) : image16;
        const reference = withReference ? crop(image16) : null;
        const options = { preview: true, analysisImageData: reference, includeAnalysisPreview: false };
        const label = `${mode}/${JSON.stringify(Object.keys(extra))}/${withReference ? 'ref' : 'noref'}/${eight ? '8' : '16'}`;
        for (const tick of [0, 1]) {
          const settings = { ...BASE[mode], ...extra, brightness: tick * 12 - 6, contrast: 10 - tick * 25, temperature: tick * 9 };
          const prepared = prepareSilverCorePreview(source, settings, mode, { ...options, histogramSamples: 256 });
          const analysis = await analyzeSilverCorePreview(source, settings, mode, options);

          // The prepared plane: the pristine (film base, flat field) or the source itself.
          const promoted = eight ? Uint16Array.from(source.data, (v) => v * 257) : image16.data;
          const compensated = mode === 'color' || extra.flatField;
          if (!compensated) assert.equal(prepared.pristine, null, `${label}: nothing to upload without compensation`);
          const plane = prepared.pristine || promoted;
          if (mode === 'color' && !extra.flatField) {
            const expected = new Uint16Array(promoted);
            applyFilmBaseCompensationToBuffer(expected, settings.filmBase, { method: 'density', strength: settings.filmBaseStrength ?? 1 });
            samePlane(prepared.pristine, expected, `${label}: pristine`);
          }
          if (extra.localExposure) {
            const stops = rasterizeExposureStops(extra.localExposure, { ...geometry, width: W, height: H });
            samePlane(prepared.stops, stops, `${label}: stops`);
          } else {
            assert.equal(prepared.stops, null);
          }

          // The exact frame after prepare/analyze equals the frozen adapter's.
          const frame = await live[CONVERT[mode]](source, settings, options);
          const expected = await oracle[CONVERT[mode]](source, settings, { ...options, forceFullProcess: true });
          samePlane(frame.__image16.data, expected.__image16.data, `${label}/${tick}: frame vs 1703835`);

          // The CPU chain over the prepared plane gives the frame.
          const params = await buildSilverCoreParams(mode, settings);
          const engine = new Engine(W, H);
          engine.seedAnalysis(analysis);
          if (params.enhancedProfile !== 'none') engine.enhancedLut = await loadProfile(params.enhancedProfile);
          const plan = engine.previewPlan(params, { grey: mode === 'bw' });
          assert.equal(plan.pointwise, true);
          const work = { width: W, height: H, data: new Uint16Array(plane) };
          applyPreviewChain(engine, work, params, mode, prepared.stops);
          samePlane(work.data.filter((_, i) => i % 4 !== 3), frame.__image16.data.filter((_, i) => i % 4 !== 3), `${label}/${tick}: chain vs frame`);

          // The histogram plane: point samples at downsampleImageDataForMaxPixels' positions.
          const { histogram } = prepared;
          const step = Math.ceil(Math.sqrt(PX / 256));
          assert.equal(histogram.width, Math.floor(W / step));
          assert.equal(histogram.height, Math.floor(H / step));
          const sampled = { width: histogram.width, height: histogram.height, data: new Uint16Array(histogram.data) };
          applyPreviewChain(engine, sampled, params, mode, histogram.stops);
          for (let y = 0; y < histogram.height; y++) {
            for (let x = 0; x < histogram.width; x++) {
              const at = ((y * step) * W + x * step) * 4, o = (y * histogram.width + x) * 4;
              for (let c = 0; c < 3; c++) assert.equal(sampled.data[o + c], frame.__image16.data[at + c], `${label}: histogram sample ${x},${y}`);
            }
          }
          checked++;
        }
      }
    }
  }
}

// The analysis key follows the analysis inputs only.
{
  const source = negative(5);
  const reference = crop(source);
  const key = async (settings, mode = 'color', ref = null, src = source) => silverCoreAnalysisKey(mode,
    await buildSilverCoreParams(mode, settings), settings, src, ref);
  const base = BASE.color;
  const k0 = await key(base);
  for (const change of [{ brightness: 20 }, { contrast: -30 }, { temperature: 12 }, { saturation: 150 }, { paper: 'endura' },
    { profileStrength: 40, enhancedProfile: 'frontier' }, { glow: 20 }, { localExposure: strokes.localExposure }]) {
    assert.equal(await key({ ...base, ...change }), k0, `no re-analysis for ${JSON.stringify(change)}`);
  }
  for (const change of [{ preSaturation: 120 }, { borderBuffer: 20 }, { colorModel: 'frontier' }, { filmBase: { r: 200, g: 140, b: 90 } },
    { filmBaseStrength: 0.5 }, flatField]) {
    assert.notEqual(await key({ ...base, ...change }), k0, `re-analysis for ${JSON.stringify(Object.keys(change))}`);
  }
  assert.notEqual(await key(base, 'color', null, negative(5)), k0, 'another source object');
  assert.notEqual(await key(base, 'color', reference), k0, 'a reference sample');
  const region = { left: 0.1, top: 0.1, width: 0.5, height: 0.6 };
  assert.equal(await key(base, 'color', reference), await key({ ...base, analysisRegion: region }, 'color', reference),
    'with a reference, the analysis region is not an analysis input');
  assert.notEqual(await key(base), await key({ ...base, analysisRegion: region }), 'without one it is');
  assert.notEqual(await key({ ...BASE.bw, bwMix: 'red' }, 'bw'), await key(BASE.bw, 'bw'), 'the B&W mix');
  assert.equal(await key({ ...base, bwMix: 'red' }), k0, 'the mix is no colour analysis input');
  assert.notEqual(silverCorePreparedKey(base, 'color'), silverCorePreparedKey({ ...base, filmBaseStrength: 0.5 }, 'color'));
  assert.equal(silverCorePreparedKey(base, 'bw'), silverCorePreparedKey({ ...base, filmBase: null }, 'bw'), 'B&W ignores the film base');
  assert.notEqual(silverCorePreparedKey({ ...base, ...flatField }, 'bw'), silverCorePreparedKey(base, 'bw'));
}

// The preview inputs refuse frames the GPU never takes.
await assert.rejects(() => analyzeSilverCorePreview(negative(), BASE.color, 'color', { forceFullProcess: true }));
assert.throws(() => prepareSilverCorePreview(negative(), BASE.color, 'color', { forceFullProcess: true }));

assert.equal(checked, 144);
console.log(`silverAdapter.preview: ${checked} prepare/analyze ticks leave exact frames unchanged and the CPU chain reproduces them`);
