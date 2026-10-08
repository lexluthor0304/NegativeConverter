// The page's OpenCV analyses, run in the warm auto-frame worker (#245).
//
// Apply Crop's crop-area detection, the expired rescue's fog surface and lab
// match's alignment each used to boot a second OpenCV.js in the page (about
// 145 MB kept for the session) and run it on the main thread. The worker
// already loads the same hashed opencv.js build, so each analysis is split in
// two: the page builds a small input from the pixels it holds (a <=1 MP
// region, a 160 px sample, two grey planes), and the worker runs the OpenCV
// half on those bytes. The same functions on byte-identical inputs in the
// same build give identical results in either realm.
//
// The page loads its own OpenCV only when the worker request fails (no
// Worker, the factory throws, a crash or a timeout); `createOpenCvTaskRunner`
// is that fallback. A result the worker computed, null included, is final.

import { detectCropAreaInRegion } from './cropColorAnalysis.js';
import { measureExpiredSpatialMapsFromSample } from './expiredRescueOpenCv.js';
import { matchAlignment, warpImageData } from './imageAlignment.js';

export const OPENCV_ANALYSIS_TYPES = Object.freeze(['detect-crop-area', 'expired-spatial-maps', 'estimate-alignment']);

export function isOpenCvAnalysisType(type) {
  return OPENCV_ANALYSIS_TYPES.includes(type);
}

function toImageData(raw) {
  return typeof ImageData === 'function'
    ? new ImageData(raw.data, raw.width, raw.height)
    : { data: raw.data, width: raw.width, height: raw.height };
}

// ---------------------------------------------------------------------------
// Messages. Every buffer in a payload is built for the request, so it is
// transferred, never copied twice.
// ---------------------------------------------------------------------------

/** detect-crop-area: the buildCropDetectionInput result and the format ratios. */
export function cropDetectionMessage(input, targets) {
  const { region } = input;
  return {
    payload: {
      region: { width: region.width, height: region.height, data: region.data },
      left: input.left, top: input.top, sx: input.sx, sy: input.sy,
      expected: input.expected, crop: input.crop, targets
    },
    transfers: [region.data.buffer]
  };
}

/** expired-spatial-maps: the sampleExpiredSpatialInput result. */
export function expiredSpatialMessage(input) {
  return { payload: { input }, transfers: [input.rgba.buffer, input.lum.buffer] };
}

/**
 * estimate-alignment: two sampleAlignmentGray samples. With `warp`, the worker
 * also warps `warp.image` (8-bit) into a `warp.width` x `warp.height` frame
 * when the match holds; that image is sent as a copy, since the caller keeps
 * it for the unaligned fallback.
 */
export function alignmentMessage(reference, moving, { options = {}, warp = null } = {}) {
  const payload = { reference, moving, options };
  const transfers = [reference.gray.buffer, moving.gray.buffer];
  if (warp) {
    const data = warp.image.data.slice();
    payload.warp = { image: { width: warp.image.width, height: warp.image.height, data }, width: warp.width, height: warp.height };
    transfers.push(data.buffer);
  }
  return { payload, transfers };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

// Lab match's alignment and warp, shared by the worker and the page fallback.
// A failed match is reported, not thrown, as the page always treated it (the
// caller warns and compares unaligned); a failed warp throws.
export function alignAndWarp({ reference, moving, options = {}, warp = null }) {
  let alignment = null;
  try {
    alignment = matchAlignment(reference, moving, options);
  } catch (error) {
    return { alignment: null, warped: null, error: String(error?.message || error) };
  }
  if (!alignment || !warp) return { alignment, warped: null };
  const warped = warpImageData(toImageData(warp.image), alignment.homography, warp.width, warp.height);
  return { alignment, warped };
}

/**
 * Runs one analysis request in the worker. Returns `{ result, transfers }`;
 * throws for an unknown type. Requires `globalThis.cv`.
 */
export function runOpenCvAnalysisTask(message) {
  switch (message.type) {
    case 'detect-crop-area': {
      const points = detectCropAreaInRegion({
        region: toImageData(message.region),
        left: message.left, top: message.top, sx: message.sx, sy: message.sy,
        expected: message.expected, crop: message.crop
      }, message.targets);
      return { result: { points }, transfers: [] };
    }
    case 'expired-spatial-maps': {
      const maps = measureExpiredSpatialMapsFromSample(message.input);
      return { result: { maps }, transfers: maps ? [...maps.low.map(grid => grid.buffer), maps.mean.buffer] : [] };
    }
    case 'estimate-alignment': {
      const output = alignAndWarp(message);
      const warped = output.warped;
      return {
        result: { ...output, warped: warped ? { width: warped.width, height: warped.height, data: warped.data } : null },
        transfers: warped ? [warped.data.buffer] : []
      };
    }
    default:
      throw new Error(`Unknown analysis request: ${message.type}`);
  }
}

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

function detached(transfers) {
  return transfers.some(buffer => buffer && buffer.byteLength === 0);
}

/**
 * Worker first, the page's OpenCV only when the worker request rejects.
 *
 * `run(type, { build, toMessage, fromWorker, onMainThread })`:
 * - `build()` (may be async) makes the input on the page; null skips the
 *   request and resolves null.
 * - `toMessage(input)` gives `{ payload, transfers }` for `runInWorker`.
 * - `fromWorker(result, input)` maps the worker's reply.
 * - `onMainThread(input)` computes the same result with the page's OpenCV.
 *   The input is built again when the failed attempt had transferred it.
 *
 * An error the worker reports from the analysis itself (`workerReported`) is
 * the result, as it would be on the page, and is rethrown. The fallback warns
 * once per type per session.
 */
export function createOpenCvTaskRunner({ runInWorker, ensureOpenCvReady, warn = (...args) => console.warn(...args) }) {
  const warned = new Set();
  const stats = { worker: 0, fallback: 0 };
  async function run(type, { build, toMessage, fromWorker = result => result, onMainThread }) {
    let input = await build();
    if (input == null) return null;
    let failure = null;
    let sent = [];
    if (runInWorker) {
      try {
        const { payload, transfers } = toMessage(input);
        sent = transfers;
        const result = await runInWorker(type, payload, transfers);
        stats.worker++;
        return fromWorker(result, input);
      } catch (error) {
        if (error?.workerReported) throw error;
        failure = error;
      }
    }
    if (!warned.has(type)) {
      warned.add(type);
      warn(`OpenCV worker unavailable for ${type}; running it on the page:`, failure);
    }
    if (!(await ensureOpenCvReady())) throw new Error('OpenCV is not available');
    if (detached(sent)) {
      input = await build();
      if (input == null) return null;
    }
    stats.fallback++;
    return onMainThread(input);
  }
  run.stats = stats;
  return run;
}
