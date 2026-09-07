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

import { resolveExpiredBounds, resolveExpiredSamplePlane } from '../pipeline/expiredRescue.js';

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

// Area-averaged RGBA copy of `bounds` at `width` pixels wide.
function downsampleBounds(image, plane, bounds, width) {
  const scale = width / bounds.width;
  const height = Math.max(8, Math.round(bounds.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const lum = new Float32Array(width * height);
  const { data } = plane;
  const toByte = plane.bits === 16 ? 1 / 257 : 1;
  for (let y = 0; y < height; y++) {
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
  return { rgba, lum, width, height };
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
  const cv = getCv();
  const plane = resolveExpiredSamplePlane(image);
  if (!plane) return null;
  const bounds = resolveExpiredBounds(image, options);
  if (bounds.width < 8 || bounds.height < 8) return null;
  const workingWidth = clamp(Math.round(options.workingWidth || 160), 32, 512);
  const small = downsampleBounds(image, plane, bounds, workingWidth);
  const gridWidth = clamp(Math.round(options.gridWidth || 32), 4, 64);
  const gridHeight = Math.max(3, Math.round(gridWidth * small.height / small.width));
  const placement = options.placement && typeof options.placement === 'object' ? options.placement : { left: 0, top: 0, width: 1, height: 1 };
  const fraction = {
    left: placement.left + (bounds.left / image.width) * placement.width,
    top: placement.top + (bounds.top / image.height) * placement.height,
    width: (bounds.width / image.width) * placement.width,
    height: (bounds.height / image.height) * placement.height
  };

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
