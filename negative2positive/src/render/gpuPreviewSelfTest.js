// The GPU preview's idle-time self-test (#239): 64 × 64 fixtures that hit the edge
// cases of every stage (grey ramps across the 8-bit boundaries, hue-band borders,
// channel ties, 0 / 65535, transparent pixels, dodge-and-burn stops, HSL in every
// band, a 3D profile at strength 150, papers with toning, the B&W grey table and the
// positive gain), with the CPU engine's 8-bit output as the reference. The renderer
// draws them with applyProgram (Step 3 at identity) and reads them back once; any
// channel off by more than 1 keeps the session on the worker path.

import { Engine } from '../silvercore/engine/Engine.js';
import { resolveSilverCoreParams, toGrayscaleInPlace } from '../pipeline/silverAdapter.js';
import { toRGBA8 } from '../silvercore/util/image16.js';
import { applyPreviewChain } from './previewTables.js';

export const SELF_TEST_SIZE = 64;
export const SELF_TEST_MAX_DIFF = 1;

// A deterministic 32³ profile with cross-talk and curvature, baked like
// EnhancedProfiles' tables (r-major, b fastest), so the self-test needs no fetch.
export function syntheticProfile() {
  const size = 32;
  const bakedData = new Uint16Array(size * size * size * 3);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  for (let ri = 0; ri < size; ri++) {
    for (let gi = 0; gi < size; gi++) {
      for (let bi = 0; bi < size; bi++) {
        const r = ri / (size - 1), g = gi / (size - 1), b = bi / (size - 1);
        const i = ((ri * size + gi) * size + bi) * 3;
        bakedData[i] = Math.round(clamp(0.86 * r + 0.1 * g + 0.04 * b + 0.04 * Math.sin(6 * g)) * 65535);
        bakedData[i + 1] = Math.round(clamp(0.07 * r + 0.85 * g + 0.08 * b + 0.03 * Math.cos(5 * b) - 0.03) * 65535);
        bakedData[i + 2] = Math.round(clamp(0.05 * r + 0.12 * g + 0.83 * b + 0.05 * Math.sin(4 * r)) * 65535);
      }
    }
  }
  return { name: 'self-test', size, data: bakedData, bakedData };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// The fixture: eight bands of eight rows.
export function selfTestFixture(seed = 7) {
  const n = SELF_TEST_SIZE;
  const data = new Uint16Array(n * n * 4);
  const random = lcg(seed);
  const hsv = (h, s, v) => {
    const k = (m) => (m + h * 6) % 6;
    const ch = (m) => v - v * s * Math.max(0, Math.min(k(m), 4 - k(m), 1));
    return [ch(5), ch(3), ch(1)];
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const t = (y % 8) * n + x; // 0..511 within the band
      let px;
      switch (y >> 3) {
        case 0: // grey ramp over the whole range, landing on 256 k ± 1
          px = [0, 0, 0].map(() => Math.min(65535, Math.max(0, Math.round(t * 128.25) + ((t % 3) - 1))));
          break;
        case 1: // hue sweep, strong saturation
        case 2: { // hue sweep, soft saturation and dark values
          const soft = (y >> 3) === 2;
          const [r, g, b] = hsv(t / 512, soft ? 0.25 : 0.9, soft ? 0.35 : 0.8);
          px = [r, g, b].map((v) => Math.round(v * 65535));
          break;
        }
        case 3: { // two-channel ties at many magnitudes
          const hi = Math.round(((t % 64) + 1) / 64 * 65535), lo = Math.round(hi * 0.4);
          px = [[hi, hi, lo], [lo, hi, hi], [hi, lo, hi], [hi, hi, hi]][(t >> 6) % 4];
          break;
        }
        case 4: // extremes
          px = [0, 1, 255, 256, 257, 65279, 65534, 65535].map((v, i, all) => all[(i + t) % 8]).slice(0, 3);
          break;
        case 5: // typical colour negative densities
          px = [22000 + 24000 * random(), 14000 + 18000 * random(), 8000 + 14000 * random()].map(Math.round);
          break;
        default: // anything
          px = [65535 * random(), 65535 * random(), 65535 * random()].map(Math.round);
      }
      const i = (y * n + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      // Transparent pixels (rotated corners): the positive stage skips them.
      data[i + 3] = y >= 56 && x < 8 ? 0 : 65535;
    }
  }
  return { width: n, height: n, data };
}

// Stops in the right half: large, small and fractional values, both signs.
export function selfTestStops() {
  const n = SELF_TEST_SIZE;
  const stops = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = n / 2; x < n; x++) stops[y * n + x] = [-2, -0.75, -0.01, 0.01, 0.4, 1.3, 2.5, 0][(x + y) % 8];
  }
  return stops;
}

const CASES = [
  {
    name: 'colour',
    mode: 'color',
    settings: {
      filmType: 'color', colorModel: 'frontier', preSaturation: 130, saturation: 160, profileStrength: 150,
      enhancedProfile: 'frontier', paper: 'crystal-archive', contrast: 25, brightness: -10, temperature: 20,
      highlights: -30, shadows: 15, glow: 10,
    },
    profile: true,
    stops: true,
  },
  {
    name: 'bw',
    mode: 'bw',
    settings: {
      filmType: 'bw', bwMix: 'red', preSaturation: 150, saturation: 120, profileStrength: 80,
      enhancedProfile: 'frontier', paper: 'multigrade-fb-warmtone', paperToning: 'split', paperToningStrength: 70,
      contrast: 15, fade: 12,
    },
    profile: true,
    stops: true,
  },
  {
    name: 'positive',
    mode: 'positive',
    settings: { filmType: 'positive', colorModel: 'basic', saturation: 70, exposure: 40, whites: -20 },
    positive: { gain: 1.8, wb: [0.93, 1, 0.87] },
    profile: false,
    stops: false,
  },
];

function clonePlane(image) {
  return { width: image.width, height: image.height, data: new Uint16Array(image.data) };
}

/**
 * The self-test cases with their CPU reference: for each, the Image16 fixture, the
 * stops, the resolved params, a seeded engine and its plan (what the renderer
 * uploads), and `expected`, the 8-bit RGBA the CPU engine produces.
 */
export function buildSelfTestCases() {
  const fixture = selfTestFixture();
  const stops = selfTestStops();
  const profile = syntheticProfile();
  return CASES.map((spec) => {
    const params = resolveSilverCoreParams(spec.mode, spec.settings, null);
    const engine = new Engine(SELF_TEST_SIZE, SELF_TEST_SIZE);
    engine.enhancedLut = spec.profile ? profile : null;
    // The analysis as the adapter makes it: B&W frames arrive mixed down, and
    // analyze() applies the pre-saturation itself.
    const sample = clonePlane(fixture);
    if (spec.mode === 'bw') toGrayscaleInPlace(sample, params.bwMix);
    engine.analyze(sample, params);
    if (spec.positive) engine.positiveAnalysis = { gain: spec.positive.gain, wb: [...spec.positive.wb] };
    const plan = engine.previewPlan(params, { grey: spec.mode === 'bw' });
    const caseStops = spec.stops ? stops : null;
    const output = applyPreviewChain(engine, clonePlane(fixture), params, spec.mode, caseStops);
    return {
      name: spec.name, mode: spec.mode, width: SELF_TEST_SIZE, height: SELF_TEST_SIZE,
      prepared: fixture, stops: caseStops, params, engine, plan,
      profile: engine.enhancedLut, positive: engine.positiveAnalysis,
      expected: toRGBA8(output).data,
    };
  });
}

/**
 * Compares a readback (bottom-up rows, as readPixels returns them) of `width` ×
 * `height` pixels whose case k occupies columns [k * 64, k * 64 + 64) against the
 * cases' expected bytes. Returns { ok, maxDiff, worst } per case and overall.
 */
export function compareSelfTest(cases, pixels, width, height = SELF_TEST_SIZE) {
  const n = SELF_TEST_SIZE;
  const results = cases.map((testCase, k) => {
    let maxDiff = 0, worst = null, differing = 0;
    for (let y = 0; y < n; y++) {
      const row = height - 1 - y; // the fixture's top row is drawn at the top
      for (let x = 0; x < n; x++) {
        const got = (row * width + k * n + x) * 4;
        const want = (y * n + x) * 4;
        let pixelDiff = 0;
        for (let c = 0; c < 3; c++) {
          const diff = Math.abs(pixels[got + c] - testCase.expected[want + c]);
          if (diff > pixelDiff) pixelDiff = diff;
        }
        if (pixelDiff) differing++;
        if (pixelDiff > maxDiff) { maxDiff = pixelDiff; worst = { x, y }; }
      }
    }
    return { name: testCase.name, maxDiff, worst, differing };
  });
  const maxDiff = Math.max(0, ...results.map((result) => result.maxDiff));
  return { ok: maxDiff <= SELF_TEST_MAX_DIFF, maxDiff, cases: results };
}
