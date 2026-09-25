// Tables and uniforms of the GPU preview (#239), and the CPU chain its histogram and
// self-test use. Pure JS: no GL here, so all of it runs in Node tests.

import { hueWeightTables, HUE_TABLE_SIZE, HUE_BANDS_STRICT } from '../silvercore/engine/ImageProcessor.js';
import { LINEAR_LUT, LINEAR_STEPS, applyExposureStopsToImage16 } from '../silvercore/util/localExposure.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import { toGrayscaleInPlace } from '../pipeline/silverAdapter.js';
import { TABLE_TEXTURE_SIZE, PACKED_ROW_TEXELS } from './previewShader.js';

export const TABLE_ENTRIES = TABLE_TEXTURE_SIZE * TABLE_TEXTURE_SIZE;

// Rows of PACKED_ROW_TEXELS texels holding `entries` values.
export function packedRows(entries) {
  return Math.ceil(entries / PACKED_ROW_TEXELS);
}

// Three 65536-entry tables as RGBA16UI texels (alpha 0), into `out` when given: the
// preview keeps one buffer, so a tick allocates nothing here.
export function packTableTexture(r, g, b, out = null) {
  const data = out && out.length === TABLE_ENTRIES * 4 ? out : new Uint16Array(TABLE_ENTRIES * 4);
  for (let v = 0, i = 0; v < TABLE_ENTRIES; v++, i += 4) {
    data[i] = r[v];
    data[i + 1] = g[v];
    data[i + 2] = b[v];
    data[i + 3] = 0;
  }
  return data;
}

// The hue-weight tables applyHSLAdjustments reads, as RGBA32F texels (weights of the
// red, green and blue bands, alpha 0), PACKED_ROW_TEXELS per row.
export function packHueWeights() {
  const [tR, tG, tB] = hueWeightTables();
  const data = new Float32Array(packedRows(HUE_TABLE_SIZE) * PACKED_ROW_TEXELS * 4);
  for (let i = 0; i < HUE_TABLE_SIZE; i++) {
    data[i * 4] = tR[i];
    data[i * 4 + 1] = tG[i];
    data[i * 4 + 2] = tB[i];
  }
  return { width: PACKED_ROW_TEXELS, height: packedRows(HUE_TABLE_SIZE), data };
}

// The dodge-and-burn linear-light table (LINEAR_STEPS + 1 entries) as R32F texels.
export function packLinearLut() {
  const entries = LINEAR_STEPS + 1;
  const data = new Float32Array(packedRows(entries) * PACKED_ROW_TEXELS);
  data.set(LINEAR_LUT);
  return { width: PACKED_ROW_TEXELS, height: packedRows(entries), data };
}

/**
 * The shader's per-tick uniforms for one plan (Engine.previewPlan) in `mode`, from the
 * values the CPU stages read: the same factors, divided the same way (the GPU then
 * holds them as fp32). `positive` is the engine's positiveAnalysis.
 */
export function applyUniforms({ mode, params, plan, positive, hasStops, prepared8 = false }) {
  const bw = mode === 'bw';
  const weights = bwMixWeights[params.bwMix] || bwMixWeights.standard;
  const preSaturation = plan.preSaturation;
  const hsl = plan.hsl;
  const shifts = hsl ? [hsl.redHue / 360, hsl.greenHue / 360, hsl.blueHue / 360] : [0, 0, 0];
  const sats = hsl ? [hsl.redSaturation / 100, hsl.greenSaturation / 100, hsl.blueSaturation / 100] : [0, 0, 0];
  const bands = [0, 1, 2].map((band) => (shifts[band] !== 0 || sats[band] !== 0 ? 1 : 0));
  const hslOn = !bw && Boolean(hsl) && bands.some(Boolean);
  const positiveOn = !bw && Boolean(positive) && !(positive.gain === 1 && positive.wb.every((value) => value === 1));
  const str = plan.lutStrength / 100;
  return {
    prepared8: prepared8 ? 1 : 0,
    mode: bw ? 1 : 0,
    mix: [weights.r, weights.g, weights.b],
    preSatOn: preSaturation !== 100 ? 1 : 0,
    preSat: preSaturation / 100,
    positiveOn: positiveOn ? 1 : 0,
    gain: positiveOn ? positive.gain : 1,
    posWb: positiveOn ? [...positive.wb] : [1, 1, 1],
    stopsOn: hasStops ? 1 : 0,
    hslOn: hslOn ? 1 : 0,
    hueSkip: HUE_BANDS_STRICT && !(bands[0] && bands[1] && bands[2]) ? 1 : 0,
    bandActive: bands,
    hueShift: shifts,
    satFactor: sats,
    lut3dOn: !bw && plan.lutStrength > 0 ? 1 : 0,
    lut3dStr: str,
    lut3dInvStr: 1 - str,
    satOn: !bw && plan.saturation !== 100 ? 1 : 0,
    sat: plan.saturation / 100,
    paperOn: !bw && plan.paper ? 1 : 0,
  };
}

/**
 * The CPU apply chain of one tick on a prepared plane (the pristine, film-base
 * compensated negative), in place: the stage functions the engine runs for an
 * interactive frame, in its order. `engine` holds the analysis and the tick's
 * tables (Engine.previewPlan). Every stage is pointwise, so on point samples of the
 * prepared plane (and of its stops) this gives the exact frame's pixels at those
 * points: the histogram during a GPU drag, and the self-test's reference.
 */
export function applyPreviewChain(engine, image16, params, mode, stops = null) {
  if (mode === 'bw') toGrayscaleInPlace(image16, params.bwMix);
  engine._applyPreSaturation(image16, params);
  engine._applyPositiveAnalysis(image16);
  if (stops && stops.length === image16.width * image16.height) applyExposureStopsToImage16(image16, stops);
  return engine._applyLuts(image16, engine.lastLuts, params);
}
