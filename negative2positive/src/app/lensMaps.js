// Lens correction's remap (#278). lensfun builds grid maps for a frame of
// a given size (the distortion's source positions, or per channel the
// source positions with distortion and TCA corrected together, and
// vignetting gains, one node every `step` pixels); every output pixel reads
// its source positions and gains bilinearly from the grid and samples the
// input there bilinearly. main.js applies it to the whole working image
// after the crop (applyLensCorrectionWithSettings); the display-proxy fills
// apply it to row bands of that image in the geometry pool, with the same
// arithmetic, so a band of rows is those rows of the whole image byte for
// byte. This module also holds what decides the maps lensfun is asked for
// (the grid step, the request and which maps are built: buildLensMaps), so
// the store's code hash covers them.

import { allocPlane16, isSharedPlane, sharedPlanesAvailable } from './crossOriginIsolation.js';

function clampBetween(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function autoLensMapStep(width, height) {
  const maxSide = Math.max(width, height);
  if (maxSide >= 5200) return 8;
  if (maxSide >= 3600) return 6;
  if (maxSide >= 2400) return 4;
  if (maxSide >= 1500) return 3;
  return 2;
}

/** The grid step of the maps for a frame of this size. */
export function lensMapStep(params, width, height) {
  if (params.stepMode === 'manual') {
    return Math.round(clampBetween(params.step || 2, 1, 16));
  }
  return autoLensMapStep(width, height);
}

/**
 * What lensfun's buildCorrectionMaps is asked for a frame of `width` x
 * `height` under a resolved lens block (enabled, with a selected lens), and
 * the key the maps are cached by.
 */
export function lensMapRequest(lensCorrection, width, height) {
  const params = {
    focal: lensCorrection.params.focal,
    crop: lensCorrection.params.crop,
    aperture: lensCorrection.params.aperture,
    distance: lensCorrection.params.distance,
    stepMode: lensCorrection.params.stepMode,
    step: lensMapStep(lensCorrection.params, width, height)
  };
  const modes = lensCorrection.modes;
  const lensHandle = lensCorrection.selectedLens.handle;
  const key = [
    lensHandle,
    width,
    height,
    params.focal.toFixed(4),
    params.crop.toFixed(4),
    params.aperture.toFixed(4),
    params.distance.toFixed(4),
    params.step,
    params.stepMode,
    modes.includeTca ? 1 : 0,
    modes.includeVignetting ? 1 : 0
  ].join('|');
  return {
    key,
    request: {
      lensHandle,
      width,
      height,
      focal: params.focal,
      crop: params.crop,
      step: params.step,
      reverse: false,
      includeTca: modes.includeTca,
      includeVignetting: modes.includeVignetting,
      aperture: params.aperture,
      distance: params.distance
    }
  };
}

// lensfun's modification flags (LF_MODIFY_* in lensfun.h).
const LF_MODIFY_TCA = 0x1;
const LF_MODIFY_VIGNETTING = 0x2;

// The corrections lensfun has calibration data for, for this lens and crop
// (every flag when the client cannot tell).
function lensModifications(client, lensHandle, crop) {
  if (typeof client.getAvailableModifications !== 'function') return ~0;
  try {
    const flags = Number(client.getAvailableModifications(lensHandle, crop));
    return Number.isFinite(flags) ? flags : ~0;
  } catch {
    return ~0;
  }
}

/**
 * lensfun's maps for a request (lensMapRequest's), as the remap reads them:
 * `geometry`, every channel's source x, y per node (the distortion
 * correction); `tca`, per channel, the source x, y with distortion and TCA
 * corrected together; `vignetting`, the gains. `tca` and `vignetting` are
 * null where not applied.
 *
 * lensfun corrects distortion first and TCA at that distorted position
 * (lfModifier::ApplySubpixelGeometryDistortion, buildSubpixelGeometryMap,
 * lensfun-wasm 0.1.4 on). The `tca` map of buildCorrectionMaps is built
 * with TCA correction alone and carries no distortion: sampled in place of
 * the geometry map it would undo the distortion correction, so it is never
 * used. The distortion alone is applied when the lens has no TCA
 * calibration, when its TCA map fails, and on a lensfun-wasm without
 * buildSubpixelGeometryMap. Vignetting is applied when the lens has
 * vignetting calibration and its map builds. The distortion map is
 * required: when it cannot be built this throws, and the frame is converted
 * uncorrected (lensfun-wasm 0.1.3 builds no map at all: its module exports
 * no HEAPF32 view).
 */
export function buildLensMaps(client, request) {
  const { includeTca, includeVignetting, aperture, distance, ...grid } = request;
  const available = lensModifications(client, grid.lensHandle, grid.crop);
  const vignetting = Boolean(includeVignetting) && (available & LF_MODIFY_VIGNETTING) !== 0;
  let built;
  try {
    built = client.buildCorrectionMaps({ ...grid, includeTca: false, includeVignetting: vignetting, aperture, distance });
  } catch (error) {
    if (!vignetting) throw error;
    // The calibration does not reach this aperture and distance.
    built = client.buildCorrectionMaps({ ...grid, includeTca: false, includeVignetting: false });
  }
  const maps = {
    gridWidth: built.gridWidth,
    gridHeight: built.gridHeight,
    step: built.step,
    geometry: built.geometry,
    tca: null,
    vignetting: (vignetting && built.vignetting) || null
  };
  if (includeTca && (available & LF_MODIFY_TCA) && typeof client.buildSubpixelGeometryMap === 'function') {
    try {
      const combined = client.buildSubpixelGeometryMap(grid);
      if ((combined.modifications & LF_MODIFY_TCA) && combined.coords?.length === maps.gridWidth * maps.gridHeight * 6) {
        maps.tca = combined.coords;
      }
    } catch {
      // The distortion alone.
    }
  }
  return maps;
}

function bilerp(a00, a10, a01, a11, fx, fy) {
  const x0 = a00 + (a10 - a00) * fx;
  const x1 = a01 + (a11 - a01) * fx;
  return x0 + (x1 - x0) * fy;
}

// `row0`: the first row of the image that `data` holds (a band's rows).
function sampleImageChannelBilinear(data, width, height, x, y, channel, row0) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  // The same integer indices as (y * width + x) * 4 + channel of the whole
  // image, rows counted from row0.
  const top = (y0 - row0) * width;
  const bottom = (y1 - row0) * width;
  const i00 = (top + x0) * 4 + channel;
  const i10 = (top + x1) * 4 + channel;
  const i01 = (bottom + x0) * 4 + channel;
  const i11 = (bottom + x1) * 4 + channel;

  return bilerp(data[i00], data[i10], data[i01], data[i11], fx, fy);
}

// Grid rows y0, y1 are the slice's own (the grid row minus its gridRow0).
function sampleGridPair(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
  const p00 = (y0 * gridWidth + x0) * 2;
  const p10 = (y0 * gridWidth + x1) * 2;
  const p01 = (y1 * gridWidth + x0) * 2;
  const p11 = (y1 * gridWidth + x1) * 2;
  return {
    x: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
    y: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy)
  };
}

function sampleGridTriple(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
  const p00 = (y0 * gridWidth + x0) * 3;
  const p10 = (y0 * gridWidth + x1) * 3;
  const p01 = (y1 * gridWidth + x0) * 3;
  const p11 = (y1 * gridWidth + x1) * 3;
  return {
    r: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
    g: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
    b: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy)
  };
}

function sampleGridTca(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
  const p00 = (y0 * gridWidth + x0) * 6;
  const p10 = (y0 * gridWidth + x1) * 6;
  const p01 = (y1 * gridWidth + x0) * 6;
  const p11 = (y1 * gridWidth + x1) * 6;
  return {
    rx: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
    ry: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
    gx: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy),
    gy: bilerp(grid[p00 + 3], grid[p10 + 3], grid[p01 + 3], grid[p11 + 3], fx, fy),
    bx: bilerp(grid[p00 + 4], grid[p10 + 4], grid[p01 + 4], grid[p11 + 4], fx, fy),
    by: bilerp(grid[p00 + 5], grid[p10 + 5], grid[p01 + 5], grid[p11 + 5], fx, fy)
  };
}

/**
 * Rows [y0, y1) of the remap of a `width` x `height` image into `out16`
 * and/or `out8`, whose first row is row y0. `source` is the plane the remap
 * reads (16-bit when `maxValue` is 65535, else 8-bit), holding the image's
 * rows from `sourceRow0` on: every row these output rows read
 * (lensSourceRows). `maps` may hold only the grid rows these rows read,
 * from `maps.gridRow0` on (sliceLensMaps). With a 16-bit plane the 8-bit
 * bytes are its >>> 8; every pixel of the rows is written, alpha opaque.
 */
export function applyLensMapRows({ source, sourceRow0 = 0, width, height, maxValue }, maps, modes, { out8 = null, out16 = null }, y0, y1) {
  const gridWidth = maps.gridWidth;
  const gridHeight = maps.gridHeight;
  const gridRow0 = maps.gridRow0 || 0;
  const step = Math.max(1, maps.step || 1);
  const geometry = maps.geometry;
  const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
  const vignetting = (modes.includeVignetting && maps.vignetting) ? maps.vignetting : null;

  for (let y = y0; y < y1; y++) {
    const gyRaw = y / step;
    const gy0 = clampBetween(Math.floor(gyRaw), 0, gridHeight - 1);
    const gy1 = clampBetween(gy0 + 1, 0, gridHeight - 1);
    const fy = clampBetween(gyRaw - gy0, 0, 1);
    const ly0 = gy0 - gridRow0;
    const ly1 = gy1 - gridRow0;

    for (let x = 0; x < width; x++) {
      const gxRaw = x / step;
      const x0 = clampBetween(Math.floor(gxRaw), 0, gridWidth - 1);
      const x1 = clampBetween(x0 + 1, 0, gridWidth - 1);
      const fx = clampBetween(gxRaw - x0, 0, 1);

      let rX, rY, gX, gY, bX, bY;
      if (tca) {
        const tcaCoords = sampleGridTca(tca, gridWidth, x0, x1, ly0, ly1, fx, fy);
        rX = tcaCoords.rx; rY = tcaCoords.ry;
        gX = tcaCoords.gx; gY = tcaCoords.gy;
        bX = tcaCoords.bx; bY = tcaCoords.by;
      } else {
        const geometryCoords = sampleGridPair(geometry, gridWidth, x0, x1, ly0, ly1, fx, fy);
        rX = geometryCoords.x; rY = geometryCoords.y;
        gX = geometryCoords.x; gY = geometryCoords.y;
        bX = geometryCoords.x; bY = geometryCoords.y;
      }

      let r = sampleImageChannelBilinear(source, width, height, rX, rY, 0, sourceRow0);
      let g = sampleImageChannelBilinear(source, width, height, gX, gY, 1, sourceRow0);
      let b = sampleImageChannelBilinear(source, width, height, bX, bY, 2, sourceRow0);

      if (vignetting) {
        const gains = sampleGridTriple(vignetting, gridWidth, x0, x1, ly0, ly1, fx, fy);
        r *= gains.r;
        g *= gains.g;
        b *= gains.b;
      }

      const outIdx = ((y - y0) * width + x) * 4;
      const rv = clampBetween(Math.round(r), 0, maxValue);
      const gv = clampBetween(Math.round(g), 0, maxValue);
      const bv = clampBetween(Math.round(b), 0, maxValue);
      if (out16) {
        out16[outIdx] = rv;
        out16[outIdx + 1] = gv;
        out16[outIdx + 2] = bv;
        out16[outIdx + 3] = 65535;
        if (out8) {
          // Keep the 8-bit view exactly consistent with the 16-bit plane.
          out8[outIdx] = rv >>> 8;
          out8[outIdx + 1] = gv >>> 8;
          out8[outIdx + 2] = bv >>> 8;
        }
      } else {
        out8[outIdx] = rv;
        out8[outIdx + 1] = gv;
        out8[outIdx + 2] = bv;
      }
      if (out8) out8[outIdx + 3] = 255;
    }
  }
}

/** The remap of a whole image (main.js's lens correction): a new ImageData. */
export function applyLensMapsToImage(imageData, maps, modes) {
  const { width, height, data } = imageData;
  const output = new ImageData(new Uint8ClampedArray(data.length), width, height);
  const outData = output.data;
  // Resample the 16-bit plane when the loader attached one, otherwise every
  // RAW or 16-bit PNG converted with lens correction on would reach the
  // engine as 8-bit data upcast back to 16.
  const plane16 = imageData.__image16;
  const use16 = Boolean(
    plane16
    && plane16.data instanceof Uint16Array
    && plane16.width === width
    && plane16.height === height
    && plane16.data.length === data.length
  );
  const source = use16 ? plane16.data : data;
  const maxValue = use16 ? 65535 : 255;
  const out16 = use16 ? allocPlane16(data.length, { shared: isSharedPlane(plane16.data) && sharedPlanesAvailable() }) : null;
  applyLensMapRows({ source, width, height, maxValue }, maps, modes, { out8: outData, out16 }, 0, height);
  if (out16) {
    output.__image16 = { width, height, data: out16 };
  }
  return output;
}

// The grid rows output rows [y0, y1) read: [first, last].
function lensGridRows(maps, y0, y1) {
  const step = Math.max(1, maps.step || 1);
  const first = clampBetween(Math.floor(y0 / step), 0, maps.gridHeight - 1);
  const last = clampBetween(Math.floor((y1 - 1) / step) + 1, 0, maps.gridHeight - 1);
  return [first, last];
}

/**
 * Per grid row, the least and greatest source row any of its nodes names
 * (the y of the geometry map, or of all three channels with TCA). NaN
 * nodes name none: a pixel interpolated from one reads no row.
 */
export function lensRowExtents(maps, modes) {
  const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
  const grid = tca || maps.geometry;
  const stride = tca ? 6 : 2;
  const { gridWidth, gridHeight } = maps;
  const min = new Float64Array(gridHeight).fill(Infinity);
  const max = new Float64Array(gridHeight).fill(-Infinity);
  for (let gy = 0; gy < gridHeight; gy++) {
    let low = Infinity;
    let high = -Infinity;
    // The source y of every channel sits at the odd offsets of a node.
    for (let i = gy * gridWidth * stride + 1, end = (gy + 1) * gridWidth * stride; i < end; i += 2) {
      const v = grid[i];
      if (v < low) low = v;
      if (v > high) high = v;
    }
    min[gy] = low;
    max[gy] = high;
  }
  return { min, max };
}

/**
 * The input rows `{ y0, y1 }` (half-open) that output rows [y0, y1) of the
 * remap read: from the least to the greatest source y of the grid nodes
 * those rows interpolate (bilinear weights keep a value between its nodes),
 * the second tap's row below it, and a row of margin each way for
 * floating-point slack, clamped to the image. A superset: the remap reads no
 * row outside it.
 */
export function lensSourceRows(maps, modes, y0, y1, height, extents = lensRowExtents(maps, modes)) {
  const [first, last] = lensGridRows(maps, y0, y1);
  let low = Infinity;
  let high = -Infinity;
  for (let gy = first; gy <= last; gy++) {
    if (extents.min[gy] < low) low = extents.min[gy];
    if (extents.max[gy] > high) high = extents.max[gy];
  }
  const top = Math.max(0, Math.floor(low) - 1);
  const bottom = Math.min(height, Math.floor(high) + 3);
  // No node names a row inside the image: nothing is read (any row will do).
  if (!(bottom > top)) return { y0: 0, y1: Math.min(1, height) };
  return { y0: top, y1: bottom };
}

/**
 * The grid rows output rows [y0, y1) read, as maps of their own
 * (`gridRow0` is the first), copied: a band posts only these to its worker.
 */
export function sliceLensMaps(maps, modes, y0, y1) {
  const [first, last] = lensGridRows(maps, y0, y1);
  const rows = (array, stride) => array.slice(first * maps.gridWidth * stride, (last + 1) * maps.gridWidth * stride);
  const tca = (modes.includeTca && maps.tca) ? rows(maps.tca, 6) : null;
  return {
    gridWidth: maps.gridWidth,
    gridHeight: maps.gridHeight,
    step: maps.step,
    gridRow0: first,
    // The remap reads the geometry map only without TCA.
    geometry: tca ? null : rows(maps.geometry, 2),
    tca,
    vignetting: (modes.includeVignetting && maps.vignetting) ? rows(maps.vignetting, 3) : null
  };
}

/** The buffers of a slice's grids (sliceLensMaps), for a transfer list. */
export function lensMapBuffers(maps) {
  return [maps.geometry, maps.tca, maps.vignetting].filter(Boolean).map(array => array.buffer);
}
