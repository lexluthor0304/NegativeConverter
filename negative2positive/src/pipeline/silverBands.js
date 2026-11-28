// Row bands of one conversion (#256 Part 5).
//
// A full-resolution conversion (the transient, forceFullProcess path of
// runSilverCore) is one global analysis followed by per-pixel stages. This
// module splits it so that several workers each convert a row band of the
// frame, bit-identical to the whole-frame path:
//
// 1. plan (worker 0): the parameters, the loaded 3D profile, the
//    preprocessing and which analysis the bands must measure. With a
//    reference sample the analysis runs on it right here, as runSilverCore
//    does, and the tables are ready at once.
// 2. prepare (every band): flat field (at its frame rows), film base, B&W mix
//    and pre-saturation in place, then its share of the analysis: 256-bin
//    histograms of its rows inside the analysis crop (integer counts, so the
//    bands add up to the frame's exactly), or its rows of the positive
//    analysis's strided sample, in frame order.
// 3. tables (worker 0): the merged analysis sets the engine exactly as
//    Engine.analyze would, then the settings, the curves, the paper tables
//    and the baked 3D profile (or the B&W grey table) are built once and
//    broadcast. Band workers never load profiles.
// 4. apply (every band): the engine's per-pixel tail (positive gain, local
//    exposure from the band's own rows of the stop map, curves, HSL, 3D
//    profile, saturation, paper), or the grey table. Sharpening, the one
//    stage that reads neighbours, runs after the bands have exchanged their
//    unsharpened edge rows (the kernel's half-width, clamped at the frame's
//    edges, never at a band's).
//
// Step 3 (the export adjustment) runs on the same bands with the frame's
// size and each band's start row, which only the expired-film spatial stage
// reads (adjustBand).
//
// Pure apart from the profile load: the worker (workers/conversionBandWorker.js)
// keeps the state between messages; tests run the steps in-process.

import { Engine } from '../silvercore/engine/Engine.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import {
  analysisBoundsFor,
  createAnalysisHistograms,
  accumulateAnalysisHistograms,
  channelLevelsFromHistograms,
  adjustSaturation,
  greyChannelLevels,
} from '../silvercore/engine/ImageProcessor.js';
import {
  analyzePositive,
  positiveSampleGrid,
  collectPositiveSamples,
  finishPositiveAnalysis,
  identityPositiveChannels,
} from '../silvercore/engine/PositiveProcessing.js';
import { computeAutoColor } from '../silvercore/engine/WhiteBalance.js';
import { generateCurves } from '../silvercore/engine/CurveEngine.js';
import { applyUnsharpMaskBand, unsharpMaskHaloRows } from '../silvercore/engine/Sharpening.js';
import { toImageData8, cloneImage16 } from '../silvercore/util/image16.js';
import { packGreyTable, convertGreyFromSource, greyHistogramFromSource } from '../silvercore/util/greyPlane.js';
import { applyFlatFieldToImage16 } from '../app/flatField.js';
import { rasterizeExposureStopsTiled, exposureStopsBytes } from '../app/localExposure.js';
import { applyFilmBaseCompensationToBuffer } from './filmBaseCompensation.js';
import { resolveConversionMode } from './conversionRouter.js';
import { drcEnabled, drcSolveSize, solveDrcMap, drcMethodParams, drcPrepKey } from './dynamicRange.js';
import { exposeDrcFrame, drcPrepFor } from './silverAdapter.js';
import {
  buildSilverCoreParams,
  toGrayscaleInPlace,
  silverCorePreprocessFor,
  preprocessSilverCorePlane,
  silverCoreAnalysisReference,
  loadSilverCoreProfile,
} from './silverAdapter.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from '../workers/pixelAdjustments.js';
import { applyAdjustmentsToPixels16, downconvertPlane16 } from '../workers/pixelAdjustments16.js';

/**
 * Splits `height` rows into at most `count` bands of whole rows, in order.
 * @returns {Array<{y0: number, y1: number}>}
 */
export function planConversionBands(height, count) {
  const rows = Math.max(0, Math.floor(height) || 0);
  const bands = Math.max(1, Math.min(rows || 1, Math.floor(count) || 1));
  const result = [];
  const base = Math.floor(rows / bands);
  const extra = rows % bands;
  let y0 = 0;
  for (let i = 0; i < bands; i++) {
    const y1 = y0 + base + (i < extra ? 1 : 0);
    result.push({ y0, y1 });
    y0 = y1;
  }
  return result;
}

/**
 * Whether a conversion request can run as bands: the forceFullProcess path of
 * SilverCore on a genuine 16-bit plane (8-bit sources, the legacy positive
 * engine and interactive requests keep the single worker).
 */
export function bandsSupported({ imageData, settings = {}, options = {} } = {}) {
  if (!options || !options.forceFullProcess || options.preview || options.scratch || options.workBuffer16) return false;
  if (settings && settings.positiveEngine === 'legacy' && resolveConversionMode(settings) === 'positive') return false;
  const plane = imageData && imageData.__image16;
  // A compressed frame's bands sum its sample cells, which needs a frame at
  // least the size of the solve grid (smaller ones are sampled bilinearly).
  if (drcEnabled(settings) && plane && !(settings.drcSample?.rgb instanceof Float32Array)) {
    const grid = drcSolveSize(plane.width, plane.height);
    if (plane.width < grid.width || plane.height < grid.height) return false;
  }
  return Boolean(plane && plane.data instanceof Uint16Array
    && plane.width === imageData.width && plane.height === imageData.height
    && plane.data.length === imageData.width * imageData.height * 4 && imageData.height >= 1);
}

function exposureFor(settings, width, height) {
  const exposure = settings && settings.localExposure;
  const geometry = settings && settings.localExposureGeometry;
  if (!geometry || !exposure?.strokes?.length) return null;
  return { localExposure: exposure, geometry: { ...geometry, width, height } };
}

// The engine's sharpening parameters, or null when it does not sharpen.
function sharpenOf(settings) {
  if (!settings || !(settings.sharpenAmount > 0)) return null;
  return { amount: settings.sharpenAmount, radius: settings.sharpenRadius, threshold: settings.sharpenThreshold };
}

// Engine state that analyze() leaves behind, from the merged analysis.
function adoptAnalysis(engine, params, { positiveAnalysis, channelData }) {
  engine.positiveAnalysis = positiveAnalysis;
  engine.channelData = channelData;
  engine.autoColor = params.imageType === 'positive' ? null : computeAutoColor(channelData);
  engine.lastLuts = null;
}

/**
 * Step 1, in worker 0. Resolves the parameters and the profile, and runs the
 * analysis of a reference sample (runSilverCore's `analysisImageData`), with
 * its `__analysisPreview`, when there is one.
 *
 * @param {{settings: object, width: number, height: number, analysisImageData?: object, includeAnalysisPreview?: boolean}} request
 * @returns {Promise<{plan: object, engine: Engine, tables: object|null, analysisPreview: ImageData|null}>}
 *   `plan` is structured-clone safe and goes to every band; keep `engine` for
 *   buildBandTables.
 */
export async function planSilverCoreBands({ settings = {}, width, height, analysisImageData = null, includeAnalysisPreview = true }) {
  const mode = resolveConversionMode(settings);
  const params = await buildSilverCoreParams(mode, settings);
  const engine = new Engine(width, height);
  await loadSilverCoreProfile(engine, params);
  const preprocess = silverCorePreprocessFor(settings, mode);
  const reference = silverCoreAnalysisReference(analysisImageData);
  const analysisParams = reference ? { ...params, analysisRegion: null, excludeTransparent: true } : params;
  // Dynamic range compression: the bands sum the frame's sample cells (unless
  // the editor sent the photo's sample), worker 0 solves the map once, each
  // band exposes its own rows with it. A B&W frame takes the RGBA path.
  const drc = drcEnabled(settings) ? drcPlanFor(settings, mode, width, height) : null;
  const greyPath = mode === 'bw' && !drc && engine.greyTableAvailable(params);
  const exposure = exposureFor(settings, width, height);

  // The reference sample's analysis, as runSilverCore runs it.
  let analysisPreview = null;
  if (reference) {
    const sample = cloneImage16(reference);
    if (preprocess) preprocessSilverCorePlane(sample.data, sample.width, sample.height, preprocess);
    if (mode === 'bw') toGrayscaleInPlace(sample, params.bwMix);
    if (includeAnalysisPreview) analysisPreview = toImageData8(engine.process(sample, analysisParams));
    else engine.analyze(sample, analysisParams);
  }

  // What the bands measure: nothing when the reference or an override (or
  // the positive 'edit' mode) decides the analysis.
  const positive = params.imageType === 'positive';
  let analysis = 'none';
  if (!reference) {
    if (greyPath) {
      if (!Array.isArray(params.analysisOverride)) analysis = 'grey-histogram';
    } else if (positive) {
      if (params.positiveMode !== 'edit') analysis = 'positive';
    } else if (!Array.isArray(params.analysisOverride)) {
      analysis = 'histogram';
    }
  }
  const plan = {
    mode,
    width,
    height,
    params,
    preprocess,
    greyPath,
    exposure,
    reference: Boolean(reference),
    analysisPreview: Boolean(analysisPreview),
    analysis,
    bounds: analysis === 'histogram' || analysis === 'grey-histogram' ? analysisBoundsFor(width, height, params) : null,
    positiveGrid: analysis === 'positive' ? positiveSampleGrid(width, height, params) : null,
    haloRows: 0,
    drc,
  };
  const job = { plan, engine, analysisParams, settings };
  const tables = analysis === 'none' && !(drc && !drc.sample) ? buildBandTables(job, []) : null;
  return { plan, engine, job, tables, analysisPreview };
}

function greyWeights(params) {
  return bwMixWeights[params.bwMix] || bwMixWeights.standard;
}

function preSaturationRampOf(params) {
  return new Engine(1, 1).preSaturationRamp(params);
}

/**
 * Step 2, in every band: the preprocessing, the B&W mix and the
 * pre-saturation in place, and the band's share of the analysis.
 * `band` is `{ width, height, data }` holding frame rows [y0, y0 + height).
 * @returns {object} the band's partial analysis (structured-clone safe)
 */
export function prepareSilverCoreBand(plan, band, y0) {
  const { params } = plan;
  const { width, height: rows, data } = band;
  // The compression's sample cells this band's rows fall in, from the frame as
  // received (integer sums: they add up to sampleDrcInput's exactly).
  const drcPartial = plan.drc && !plan.drc.sample ? drcBandSums(plan, data, width, y0, rows) : null;
  const partial = prepareBandAnalysis(plan, band, y0);
  if (drcPartial) partial.drc = drcPartial;
  return partial;
}

function prepareBandAnalysis(plan, band, y0) {
  const { params } = plan;
  const { width, height: rows, data } = band;
  if (plan.preprocess) {
    const preprocess = plan.preprocess;
    if (preprocess.flatField && preprocess.flatFieldGeometry) {
      applyFlatFieldToImage16(band, preprocess.flatField, {
        ...preprocess.flatFieldGeometry, width, height: plan.height, window: { x: 0, y: y0 }
      });
    }
    if (preprocess.base) applyFilmBaseCompensationToBuffer(data, preprocess.base, preprocess.options);
  }
  if (plan.greyPath) {
    if (plan.analysis !== 'grey-histogram') return { kind: 'none' };
    const bounds = plan.bounds;
    const top = Math.max(bounds.top, y0);
    const bottom = Math.min(bounds.top + bounds.height, y0 + rows);
    if (bottom <= top) return { kind: 'grey-histogram', hist: new Uint32Array(256), total: 0 };
    const local = { left: bounds.left, top: top - y0, width: bounds.width, height: bottom - top };
    const { hist, total } = greyHistogramFromSource(data, width, local, greyWeights(params), preSaturationRampOf(params),
      Boolean(params.excludeTransparent));
    return { kind: 'grey-histogram', hist, total };
  }
  if (plan.mode === 'bw') toGrayscaleInPlace(band, params.bwMix);
  // Engine._applyPreSaturation: before the analysis reads the pixels.
  if ((params.preSaturation ?? 100) !== 100) adjustSaturation(band, params.preSaturation);
  if (plan.analysis === 'histogram') {
    const histograms = accumulateAnalysisHistograms(band, plan.bounds, params, createAnalysisHistograms(), y0);
    return { kind: 'histogram', ...histograms };
  }
  if (plan.analysis === 'positive') {
    const peaks = [];
    const sample = [];
    collectPositiveSamples(band, plan.positiveGrid, peaks, sample, y0);
    return { kind: 'positive', peaks: Float64Array.from(peaks), sample: Uint8Array.from(sample) };
  }
  return { kind: 'none' };
}

// The partial analyses of every band, in band order, merged.
function mergePartials(partials) {
  const merged = { histograms: null, grey: null, peaks: [], sample: [], drc: [] };
  for (const partial of partials) {
    if (!partial) continue;
    if (partial.drc) merged.drc.push(partial.drc);
    if (partial.kind === 'histogram') {
      if (!merged.histograms) merged.histograms = createAnalysisHistograms();
      for (let i = 0; i < 256; i++) {
        merged.histograms.r[i] += partial.r[i];
        merged.histograms.g[i] += partial.g[i];
        merged.histograms.b[i] += partial.b[i];
      }
      merged.histograms.total += partial.total;
    } else if (partial.kind === 'grey-histogram') {
      if (!merged.grey) merged.grey = { hist: new Uint32Array(256), total: 0 };
      for (let i = 0; i < 256; i++) merged.grey.hist[i] += partial.hist[i];
      merged.grey.total += partial.total;
    } else if (partial.kind === 'positive') {
      for (const value of partial.peaks) merged.peaks.push(value);
      for (const value of partial.sample) merged.sample.push(value);
    }
  }
  return merged;
}

/**
 * Step 3, in worker 0: the analysis from the merged partials, then the tables
 * every band applies. Mirrors runSilverCore's transient paths:
 * - grey path: analyzeGrey + buildGreyTable (or buildCurrentGreyTable after a
 *   reference preview), packed with the pre-saturation ramp unless stops;
 * - RGBA without a reference: process() (analysis, settings, curves);
 * - RGBA with a reference: its preview's curves (applyCurrentCurves), or
 *   reprocess() without a preview.
 * @returns {object} structured-clone safe
 */
export function buildBandTables(job, partials) {
  const tables = buildBandTablesWithoutDrc(job, partials);
  if (job.plan.drc) tables.drc = drcTablesFor(job, mergePartials(partials).drc);
  return tables;
}

function buildBandTablesWithoutDrc(job, partials) {
  const { plan, engine } = job;
  const { params } = plan;
  const merged = mergePartials(partials);
  const positive = params.imageType === 'positive';
  const override = Array.isArray(params.analysisOverride) ? params.analysisOverride : null;

  if (plan.greyPath) {
    if (!plan.reference) {
      engine.analyzeGrey(() => greyChannelLevels(merged.grey.hist, merged.grey.total, params), params);
    }
    const table = plan.analysisPreview ? engine.buildCurrentGreyTable(params) : engine.buildGreyTable(params);
    const preSatRamp = engine.preSaturationRamp(params);
    const stops = Boolean(plan.exposure);
    return {
      kind: 'grey',
      packed: packGreyTable(table, stops ? null : preSatRamp),
      preSatRamp: stops ? preSatRamp : null,
      sharpen: null,
    };
  }

  if (!plan.reference) {
    // Engine.analyze on the frame, from the bands' measurements.
    const positiveAnalysis = positive
      ? (params.positiveMode === 'edit' ? analyzePositive(null, params) : finishPositiveAnalysis(merged.peaks, merged.sample))
      : null;
    const channelData = positive ? identityPositiveChannels()
      : override ? override.map((channel) => ({ ...channel }))
      : channelLevelsFromHistograms(merged.histograms || createAnalysisHistograms(), params);
    adoptAnalysis(engine, params, { positiveAnalysis, channelData });
  }
  let luts;
  if (plan.reference && plan.analysisPreview && engine.lastLuts) {
    luts = engine.lastLuts;
  } else {
    const settings = engine.buildSettings(params);
    engine.lastSettings = settings;
    luts = generateCurves(engine.channelData, settings);
    engine.lastLuts = luts;
  }
  const settings = engine.lastSettings;
  const paper = settings.paper && settings.paper !== 'none' ? { key: null, luts: engine._paperLuts(settings) } : null;
  if (paper) paper.key = engine._paperCache.key;
  const lut3d = engine.enhancedLut ? { name: engine.enhancedLut.name, size: engine.enhancedLut.size, bakedData: engine.enhancedLut.bakedData } : null;
  return {
    kind: 'rgba',
    luts: { r: luts.r, g: luts.g, b: luts.b },
    settings,
    positiveAnalysis: engine.positiveAnalysis ? { gain: engine.positiveAnalysis.gain, wb: [...engine.positiveAnalysis.wb] } : null,
    enhancedLut: lut3d,
    paper,
    sharpen: sharpenOf(settings),
  };
}

/** Unsharpened edge rows each band shares with its neighbours (0: no sharpening). */
export function bandHaloRows(tables) {
  return tables && tables.sharpen ? unsharpMaskHaloRows(tables.sharpen) : 0;
}

/**
 * Step 4, in every band: the per-pixel stages, in place, everything but the
 * sharpening. Returns the band's 16-bit plane (the same array).
 */
export function applySilverCoreBand(plan, tables, band, y0) {
  const { params } = plan;
  const { width, height: rows, data } = band;
  const stops = plan.exposure
    ? rasterizeExposureStopsTiled(plan.exposure.localExposure, { ...plan.exposure.geometry, window: { x: 0, y: y0, width, height: rows } })
    : null;
  band.stopsBytes = exposureStopsBytes(stops);
  if (tables.kind === 'grey') {
    // convertGreyFromSource reads each pixel before it writes it.
    band.data8 = new Uint8ClampedArray(data.length);
    convertGreyFromSource(data, greyWeights(params), stops ? tables.preSatRamp : null, stops, tables.packed, data, band.data8, undefined, width);
    return data;
  }
  // An engine seeded with worker 0's state: no analysis, no curve build, and
  // the sharpening left to sharpenSilverCoreBand.
  const engine = new Engine(width, rows);
  engine.enhancedLut = tables.enhancedLut;
  engine.positiveAnalysis = tables.positiveAnalysis;
  engine.lastSettings = { ...tables.settings, sharpenAmount: 0 };
  engine._paperCache = tables.paper;
  const bandParams = { ...params, localExposureStops: stops };
  if (tables.drc) bandParams.drc = drcBandStage(plan, tables.drc, bandParams, y0);
  engine._positiveExposureAndLuts(band, tables.luts, bandParams);
  // Where the compression's exposure ran ('gpu', 'gpu+reference', 'reference').
  band.drcPath = bandParams.drcPath || null;
  return data;
}

// ── Dynamic range compression in bands ───────────────────────────────────────

let drcBandMaps = 0;

function drcPlanFor(settings, mode, width, height) {
  const supplied = settings.drcSample;
  const valid = supplied && supplied.rgb instanceof Float32Array && supplied.rgb.length === supplied.width * supplied.height * 3;
  const drcSettings = {};
  for (const key of ['drcAmount', 'drcDetail', 'drcShadows', 'drcHighlights', 'drcLocalContrast', 'drcSaturation']) drcSettings[key] = settings[key];
  return {
    settings: drcSettings,
    inverted: mode !== 'positive',
    grid: drcSolveSize(width, height),
    sample: valid ? { width: supplied.width, height: supplied.height, rgb: supplied.rgb } : null,
  };
}

// The integer sums of the grid cells whose rows meet this band (sampleDrcInput's cells).
function drcBandSums(plan, data, width, y0, rows) {
  const { width: gw, height: gh } = plan.drc.grid;
  const height = plan.height;
  const xStart = new Int32Array(gw + 1);
  for (let gx = 0; gx <= gw; gx++) xStart[gx] = Math.floor((gx * width) / gw);
  const cellTop = (gy) => Math.floor((gy * height) / gh);
  let gy0 = 0;
  while (gy0 < gh && cellTop(gy0 + 1) <= y0) gy0++;
  let gy1 = gy0;
  while (gy1 < gh && cellTop(gy1) < y0 + rows) gy1++;
  const sums = new Float64Array((gy1 - gy0) * gw * 3);
  const counts = new Float64Array((gy1 - gy0) * gw);
  for (let gy = gy0; gy < gy1; gy++) {
    const from = Math.max(cellTop(gy), y0);
    const to = Math.min(cellTop(gy + 1), y0 + rows);
    for (let y = from; y < to; y++) {
      const base = (y - y0) * width * 4;
      for (let gx = 0; gx < gw; gx++) {
        const x0 = xStart[gx];
        const x1 = xStart[gx + 1];
        let r = 0; let g = 0; let b = 0;
        for (let i = base + x0 * 4, end = base + x1 * 4; i < end; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
        const o = (gy - gy0) * gw + gx;
        sums[o * 3] += r; sums[o * 3 + 1] += g; sums[o * 3 + 2] += b;
        counts[o] += x1 - x0;
      }
    }
  }
  return { gy0, gy1, sums, counts };
}

function drcTablesFor(job, partials) {
  const { plan, engine } = job;
  const drc = plan.drc;
  let sample = drc.sample;
  if (!sample) {
    const { width: gw, height: gh } = drc.grid;
    const sums = new Float64Array(gw * gh * 3);
    const counts = new Float64Array(gw * gh);
    for (const part of partials) {
      const offset = part.gy0 * gw;
      for (let k = 0; k < part.counts.length; k++) {
        counts[offset + k] += part.counts[k];
        sums[(offset + k) * 3] += part.sums[k * 3];
        sums[(offset + k) * 3 + 1] += part.sums[k * 3 + 1];
        sums[(offset + k) * 3 + 2] += part.sums[k * 3 + 2];
      }
    }
    const rgb = new Float32Array(gw * gh * 3);
    for (let i = 0; i < gw * gh; i++) {
      const n = counts[i] || 1;
      rgb[i * 3] = sums[i * 3] / n; rgb[i * 3 + 1] = sums[i * 3 + 1] / n; rgb[i * 3 + 2] = sums[i * 3 + 2] / n;
    }
    sample = { width: gw, height: gh, rgb };
  }
  const prep = drcPrepFor(job.settings || {}, plan.mode, plan.params, engine.positiveAnalysis);
  const map = solveDrcMap(sample, drc.settings, { prep, inverted: drc.inverted });
  if (!map) return null;
  const method = drcMethodParams(drc.settings);
  return {
    // A key of its own per frame: the GPU stage keeps the last map it uploaded by key.
    map: { width: map.width, height: map.height, logGain: map.logGain, guide: map.guide, key: `bands:${++drcBandMaps}:${Math.random().toString(36).slice(2)}:${drcPrepKey(prep)}` },
    method,
    inverted: drc.inverted,
    protect: plan.mode !== 'bw' ? method.protect : 0,
  };
}

// The band's exposure stage: its rows of the frame, the frame's map.
function drcBandStage(plan, drc, bandParams, y0) {
  return {
    key: drc.map.key,
    expose(image16) {
      const weights = drc.protect > 0 ? new Uint8Array(image16.width * image16.height) : null;
      const strokes = bandParams.localExposureStops || null;
      bandParams.drcPath = exposeDrcFrame(image16, drc.map, drc.method, {
        inverted: drc.inverted, strokes, weights, frame: { x: 0, y: y0, frameWidth: plan.width, frameHeight: plan.height }
      });
      bandParams.drcProtection = weights ? { weights, width: image16.width, height: image16.height, protect: drc.protect } : null;
    }
  };
}

/**
 * The rows [from, to) of frame rows [y0, y0 + rows) held by `data` (copies).
 */
export function copyBandRows(data, width, y0, from, to) {
  const rowWords = width * 4;
  const start = Math.max(0, from - y0) * rowWords;
  const end = Math.max(0, to - y0) * rowWords;
  return data.slice(start, end);
}

/**
 * The sharpening of one band after the exchange: `above` and `below` hold the
 * unsharpened frame rows just outside it (bandHaloRows of them, fewer at the
 * frame's edges).
 */
export function sharpenSilverCoreBand(plan, tables, band, y0, above, below) {
  if (!tables.sharpen) return band.data;
  applyUnsharpMaskBand(band, tables.sharpen, { startRow: y0, frameHeight: plan.height, above, below });
  return band.data;
}

/** The band's 8-bit output (toImageData8 of its 16-bit rows), once it is final. */
export function bandOutput8(band) {
  if (band.data8) return band.data8;
  return toImageData8(band).data;
}

/**
 * Step 3 of the export on a band: the adjustment stage in place, with the
 * frame's size and the band's start row (for the expired spatial stage), so
 * the band's pixels are exactly those rows of the whole-frame pass.
 * `planes` is `{ data16?, data8? }`; `bits` says which to adjust. With
 * `mirror8` the 16-bit result's 8-bit mirror is made as the export worker
 * makes it.
 * @returns {{data16: Uint16Array|null, data8: Uint8ClampedArray|null}}
 */
export function adjustBand(planes, { width, rows, startRow, frameWidth, frameHeight, settings, bits16 = false, bits8 = false, mirror8 = false, scratch = null }) {
  normalizeCurves(settings);
  const params = computeAdjustmentParams(settings, { width: frameWidth, height: frameHeight, startRow });
  let data16 = null;
  let data8 = null;
  if (bits16 && planes.data16) {
    data16 = planes.data16;
    applyAdjustmentsToPixels16(data16, data16, width * rows, params, 'full', null, 500000, scratch?.lut16 || null);
    if (mirror8) data8 = downconvertPlane16(data16, new Uint8ClampedArray(data16.length));
  }
  if (bits8 && planes.data8) {
    data8 = planes.data8;
    applyAdjustmentsToPixels(data8, data8, width * rows, params, 'full', null, 500000, scratch?.lut8 || null);
  }
  return { data16, data8 };
}

function normalizeCurves(settings) {
  const curves = settings && settings.curves;
  if (!curves) return;
  if (!(curves.r instanceof Uint8Array)) curves.r = new Uint8Array(curves.r);
  if (!(curves.g instanceof Uint8Array)) curves.g = new Uint8Array(curves.g);
  if (!(curves.b instanceof Uint8Array)) curves.b = new Uint8Array(curves.b);
}

/**
 * Every step in one thread, for the tests and the pool's synchronous
 * fallback: the frame converted band by band. Returns what runSilverCore's
 * transient path returns: { data8, data16, analysisPreview }.
 */
export async function convertInBands({ imageData, settings, options = {} }, count) {
  const source = imageData.__image16;
  const { width, height } = source;
  const planned = await planSilverCoreBands({
    settings, width, height,
    analysisImageData: options.analysisImageData || null,
    includeAnalysisPreview: options.includeAnalysisPreview !== false
  });
  const { plan } = planned;
  const bands = planConversionBands(height, count).map(({ y0, y1 }) => ({
    y0, y1, band: { width, height: y1 - y0, data: copyBandRows(source.data, width, 0, y0, y1) }
  }));
  const partials = bands.map(({ band, y0 }) => prepareSilverCoreBand(plan, band, y0));
  const tables = planned.tables || buildBandTables(planned.job, partials);
  for (const { band, y0 } of bands) applySilverCoreBand(plan, tables, band, y0);
  const halo = bandHaloRows(tables);
  if (halo) {
    const edges = bands.map(({ band, y0, y1 }) => ({
      y0, y1,
      top: copyBandRows(band.data, width, y0, y0, Math.min(y1, y0 + halo)),
      bottom: copyBandRows(band.data, width, y0, Math.max(y0, y1 - halo), y1)
    }));
    for (const { band, y0, y1 } of bands) {
      const { above, below } = haloFor(edges, width, height, y0, y1, halo);
      sharpenSilverCoreBand(plan, tables, band, y0, above, below);
    }
  }
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (const { band, y0 } of bands) {
    data16.set(band.data, y0 * width * 4);
    data8.set(bandOutput8(band), y0 * width * 4);
  }
  return { width, height, data16, data8, analysisPreview: planned.analysisPreview };
}

/**
 * The unsharpened rows [max(0, y0 - halo), y0) and [y1, min(height, y1 + halo))
 * of a band, from every band's edge rows (`edges`: { y0, y1, top, bottom },
 * `top` the first min(halo, rows) rows and `bottom` the last).
 */
export function haloFor(edges, width, height, y0, y1, halo) {
  const rowWords = width * 4;
  const rowOf = (y) => {
    for (const edge of edges) {
      if (y < edge.y0 || y >= edge.y1) continue;
      const topRows = edge.top.length / rowWords;
      if (y < edge.y0 + topRows) return edge.top.subarray((y - edge.y0) * rowWords, (y - edge.y0 + 1) * rowWords);
      const bottomStart = edge.y1 - edge.bottom.length / rowWords;
      if (y >= bottomStart) return edge.bottom.subarray((y - bottomStart) * rowWords, (y - bottomStart + 1) * rowWords);
    }
    throw new Error(`No edge row ${y} for the band ${y0}-${y1}`);
  };
  const aboveStart = Math.max(0, y0 - halo);
  const belowEnd = Math.min(height, y1 + halo);
  const above = new Uint16Array((y0 - aboveStart) * rowWords);
  for (let y = aboveStart; y < y0; y++) above.set(rowOf(y), (y - aboveStart) * rowWords);
  const below = new Uint16Array((belowEnd - y1) * rowWords);
  for (let y = y1; y < belowEnd; y++) below.set(rowOf(y), (y - y1) * rowWords);
  return { above, below };
}
