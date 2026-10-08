// The OpenCV.js half of the expired-film rescue: measures what varies across
// the frame. Age rarely fogs a roll evenly (light piping at the cassette lip,
// the outer turns of a roll, a lab's uneven bath), so per channel the local
// dark floor is estimated with a wide erosion (minimum filter) and a wide
// Gaussian blur, and the local luminance mean with a narrower blur. Both are
// measured on a small area-averaged copy of the analysis region, so the Mats
// stay tiny whatever the scan's resolution, and returned as grids that
// pipeline/expiredRescue.js fits and applies without OpenCV.
//
// Requires `globalThis.cv` (see opencvLoader.js). Every Mat is released.

import {
  analyzeExpiredFilm, buildExpiredSpatialStage, fitExpiredSpatial, resolveExpiredBounds, resolveExpiredSamplePlane,
  sanitizeExpiredRescueParams
} from '../pipeline/expiredRescue.js';

function getCv() {
  const cv = globalThis.cv;
  if (!cv || !cv.Mat) throw new Error('OpenCV is not loaded');
  return cv;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function odd(value) {
  const n = Math.max(3, Math.round(value));
  return n % 2 ? n : n + 1;
}

// Area-averaged RGBA copy of `bounds` at `width` pixels wide, allocated here
// and filled row by row (downsampleBoundsRows), so a caller can spread a
// large plane over several tasks. Every output pixel depends only on its own
// source block, so any split of the rows gives the same bytes.
function createBoundsSample(bounds, width) {
  const scale = width / bounds.width;
  const height = Math.max(8, Math.round(bounds.height * scale));
  return { rgba: new Uint8ClampedArray(width * height * 4), lum: new Float32Array(width * height), width, height };
}

function downsampleBoundsRows(image, plane, bounds, small, y0, y1) {
  const { rgba, lum, width, height } = small;
  const { data } = plane;
  const toByte = plane.bits === 16 ? 1 / 257 : 1;
  for (let y = y0; y < y1; y++) {
    const sy0 = bounds.top + Math.floor((y / height) * bounds.height);
    const sy1 = Math.max(sy0 + 1, bounds.top + Math.floor(((y + 1) / height) * bounds.height));
    for (let x = 0; x < width; x++) {
      const sx0 = bounds.left + Math.floor((x / width) * bounds.width);
      const sx1 = Math.max(sx0 + 1, bounds.left + Math.floor(((x + 1) / width) * bounds.width));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * image.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          if (!data[i + 3]) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * width + x) * 4;
      if (n) {
        rgba[o] = (r / n) * toByte;
        rgba[o + 1] = (g / n) * toByte;
        rgba[o + 2] = (b / n) * toByte;
      }
      rgba[o + 3] = 255;
      lum[y * width + x] = (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
    }
  }
}

// Everything the sample needs except the pixels: the plane, the bounds, the
// working and grid sizes and where the region sits in the frame. Null when
// there is nothing to measure.
function planSpatialSample(image, options) {
  const plane = resolveExpiredSamplePlane(image);
  if (!plane) return null;
  const bounds = resolveExpiredBounds(image, options);
  if (bounds.width < 8 || bounds.height < 8) return null;
  const workingWidth = clamp(Math.round(options.workingWidth || 160), 32, 512);
  const small = createBoundsSample(bounds, workingWidth);
  const gridWidth = clamp(Math.round(options.gridWidth || 32), 4, 64);
  const gridHeight = Math.max(3, Math.round(gridWidth * small.height / small.width));
  const placement = options.placement && typeof options.placement === 'object' ? options.placement : { left: 0, top: 0, width: 1, height: 1 };
  const fraction = {
    left: placement.left + (bounds.left / image.width) * placement.width,
    top: placement.top + (bounds.top / image.height) * placement.height,
    width: (bounds.width / image.width) * placement.width,
    height: (bounds.height / image.height) * placement.height
  };
  return { plane, bounds, small, gridWidth, gridHeight, fraction };
}

function spatialInput({ small, gridWidth, gridHeight, fraction }) {
  return { rgba: small.rgba, lum: small.lum, width: small.width, height: small.height, gridWidth, gridHeight, fraction };
}

/**
 * The page's half of measureExpiredSpatialMaps (#245): the area-averaged
 * sample of the analysis region (about 0.14 MB whatever the scan's size),
 * the grid size and the region's placement. The OpenCV half,
 * measureExpiredSpatialMapsFromSample, runs in the auto-frame worker.
 * Returns null when there is nothing to measure.
 */
export function sampleExpiredSpatialInput(image, options = {}) {
  const plan = planSpatialSample(image, options);
  if (!plan) return null;
  downsampleBoundsRows(image, plan.plane, plan.bounds, plan.small, 0, plan.small.height);
  return spatialInput(plan);
}

/**
 * sampleExpiredSpatialInput spread over several tasks: rows are summed until
 * `sliceMs` has passed, then `pause()` yields (a 60 MP full-resolution render
 * takes ~0.2 s in one loop). The same arithmetic per pixel, so the sample
 * bytes are identical. Resolves null when `isCurrent()` turns false between
 * slices.
 */
export async function sampleExpiredSpatialInputSliced(image, options = {}, {
  pause, isCurrent = () => true, sliceMs = 12, now = () => performance.now()
} = {}) {
  const plan = planSpatialSample(image, options);
  if (!plan) return null;
  const { small } = plan;
  let y = 0;
  while (y < small.height) {
    const start = now();
    do {
      downsampleBoundsRows(image, plan.plane, plan.bounds, small, y, y + 1);
      y++;
    } while (y < small.height && now() - start < sliceMs);
    if (y < small.height) {
      await pause();
      if (!isCurrent()) return null;
    }
  }
  return spatialInput(plan);
}

/**
 * Low-resolution maps of the analysis region: per-channel local dark floor
 * (`low`, three grids), local luminance mean (`mean`), the grid size and the
 * region's placement in the frame (`fraction`, normalised).
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint16Array,__image16?:object}} image
 * @param {{region?:object, borderBuffer?:number, placement?:object, workingWidth?:number, gridWidth?:number}} [options]
 */
export function measureExpiredSpatialMaps(image, options = {}) {
  getCv();
  const input = sampleExpiredSpatialInput(image, options);
  return input ? measureExpiredSpatialMapsFromSample(input) : null;
}

/**
 * The OpenCV half: erode, blur and resize the sample into the grids.
 * Requires `globalThis.cv`; runs in the auto-frame worker or, as a fallback,
 * on the page.
 */
export function measureExpiredSpatialMapsFromSample(input) {
  const cv = getCv();
  const small = { rgba: input.rgba, lum: input.lum, width: input.width, height: input.height };
  const { gridWidth, gridHeight, fraction } = input;

  const mats = [];
  const track = (mat) => { mats.push(mat); return mat; };
  try {
    const src = track(cv.matFromArray(small.height, small.width, cv.CV_8UC4, small.rgba));
    const rgb = track(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const f32 = track(new cv.Mat());
    rgb.convertTo(f32, cv.CV_32FC3, 1 / 255);
    const channels = new cv.MatVector();
    cv.split(f32, channels);
    const kernelSize = odd(small.width * 0.22);
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize)));
    const gridSize = new cv.Size(gridWidth, gridHeight);
    const low = [];
    try {
      for (let c = 0; c < 3; c++) {
        const channel = track(channels.get(c));
        const eroded = track(new cv.Mat());
        cv.erode(channel, eroded, kernel);
        // A light blur only (anti-aliasing before the resize): a wide one would
        // leak a bright region's high floor into its neighbours. The quadratic
        // fit in pipeline/expiredRescue.js is what smooths the surface.
        const blurred = track(new cv.Mat());
        cv.GaussianBlur(eroded, blurred, new cv.Size(0, 0), small.width * 0.04, 0, cv.BORDER_REPLICATE);
        const grid = track(new cv.Mat());
        cv.resize(blurred, grid, gridSize, 0, 0, cv.INTER_AREA);
        low.push(Float32Array.from(grid.data32F));
      }
    } finally {
      channels.delete();
    }
    const lum = track(cv.matFromArray(small.height, small.width, cv.CV_32FC1, small.lum));
    const lumBlur = track(new cv.Mat());
    cv.GaussianBlur(lum, lumBlur, new cv.Size(0, 0), small.width * 0.05, 0, cv.BORDER_REPLICATE);
    const meanGrid = track(new cv.Mat());
    cv.resize(lumBlur, meanGrid, gridSize, 0, 0, cv.INTER_AREA);
    const mean = Float32Array.from(meanGrid.data32F);
    return { gridWidth, gridHeight, low, mean, fraction, working: { width: small.width, height: small.height } };
  } finally {
    for (const mat of mats) {
      try { mat.delete(); } catch { /* already released */ }
    }
  }
}

/**
 * The analysis the maps lead to (no OpenCV): the fitted fog surface, then the
 * curves measured on the flattened sample. `sample` is what the maps were
 * measured on ({ image, options, placement }); local contrast does not move
 * the histogram's floor, so it is left out of that stage. Null when no
 * surface fits.
 */
export function expiredAnalysisFromMaps(maps, sample, settings) {
  const spatial = maps ? fitExpiredSpatial(maps) : null;
  if (!spatial) return null;
  const stage = buildExpiredSpatialStage({
    ...sanitizeExpiredRescueParams(settings),
    expiredEnabled: true,
    expiredLocalContrast: 0,
    expiredAnalysis: { spatial }
  });
  const analysis = analyzeExpiredFilm(sample.image, { ...sample.options, anchors: settings.semanticMap, placement: sample.placement, spatial: stage });
  return analysis ? { ...analysis, spatial } : null;
}
