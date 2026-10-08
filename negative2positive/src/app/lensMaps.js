// Lens correction's remap (#278). lensfun builds grid maps for a frame of
// a given size (the distortion's source positions, or per channel the
// source positions with distortion and TCA corrected together, and
// vignetting gains, one node every `step` pixels); every output pixel reads
// its source positions and gains bilinearly from the grid and samples the
// input there bilinearly (in place, without a geometry map, for a lens
// without distortion calibration). main.js applies it to the whole working
// image after the crop (applyLensCorrectionWithSettings); the display-proxy
// fills apply it to row bands of that image in the geometry pool, with the
// same arithmetic, so a band of rows is those rows of the whole image byte
// for byte. This module also holds what decides the maps lensfun is asked
// for (the lens a saved profile names in the running lensfun build:
// findLensHandle; the grid step, the request and which maps are built:
// buildLensMaps), so the store's code hash covers them.

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

const text = value => (typeof value === 'string' ? value.trim() : '');
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * A lens profile's stable identity (#278): what lensfun names the lens
 * (maker, model), the crop factor its calibration was measured at, its focal
 * and aperture ranges, and the camera the profile was found with (null when
 * the search named none). A recipe stores this, never lensfun's handle: a
 * handle is the lens's address in one lensfun-wasm build's memory, which
 * another build (or database) lays out differently. lensfun-wasm reports no
 * lens mounts: of 0.1.4's 1558 entries, 87 share a maker, model and crop
 * factor (33 names, mostly compact cameras' "fixed lens"), 16 the ranges too
 * (8 twins), which only the camera's mount tells apart. null without a maker
 * or model.
 */
export function lensProfileIdentity(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const maker = text(profile.maker);
  const model = text(profile.model);
  if (!maker && !model) return null;
  const cameraMaker = text(profile.camera?.maker);
  const cameraModel = text(profile.camera?.model);
  return {
    maker,
    model,
    cropFactor: finite(profile.cropFactor, 1),
    minFocal: finite(profile.minFocal),
    maxFocal: finite(profile.maxFocal),
    minAperture: finite(profile.minAperture),
    maxAperture: finite(profile.maxAperture),
    camera: cameraModel ? { maker: cameraMaker, model: cameraModel } : null
  };
}

/** The identity as a string (lensProfileIdentity), for keys; null without one. */
export function lensProfileKey(profile) {
  const id = lensProfileIdentity(profile);
  if (!id) return null;
  return JSON.stringify([id.maker, id.model, id.cropFactor, id.minFocal, id.maxFocal, id.minAperture, id.maxAperture,
    id.camera ? [id.camera.maker, id.camera.model] : null]);
}

// The words of a lens model lensfun's fuzzy match compares that hold no
// digit (lfFuzzyStrCmp::Split: runs of characters that are not ASCII
// whitespace, digits or ASCII punctuation), as a search pattern; '' when
// there are none. A pattern without digits gives lensfun's GuessParameters
// no focal length or aperture to rule entries out with.
function digitFreeWords(model) {
  return (model.match(/[^\t\n\v\f\r \d!-/:-@[-`{-~]+/g) || []).join(' ');
}

const SEARCH_EXACT = 0; // neither loose nor sorted and uniquified: every entry of a name

/**
 * The handle, in the running lensfun build (`client`), of the lens a saved
 * profile names (lensProfileIdentity), or null when the build has no entry
 * of that maker and model. lensfun is searched for the exact model, then for
 * the model's words without digits (it rules out an entry whose name parses
 * to focal lengths or apertures other than its own: 62 of 0.1.4's entries,
 * such as "FE 28mm f/2 + Sony SEL075 UWC" at 21 mm), without a camera, then
 * with the profile's camera (lensfun-wasm 0.1.3 searches one camera's mount
 * when none is named). Among the entries of that maker and model the one
 * chosen has the nearest calibration crop factor, then the same focal and
 * aperture ranges, then is found with the profile's camera (its mount), then
 * has the lowest handle (lensfun's database order). Over 0.1.4's database
 * every entry's identity resolves to it, but 8 entries to a twin with the
 * same name, crop factor and ranges (lensMaps.lensfun.test.mjs).
 */
export function findLensHandle(client, profile) {
  const id = lensProfileIdentity(profile);
  if (!id || !id.model || typeof client?.searchLenses !== 'function') return null;
  const search = (lensModel, camera = null) => {
    if (!lensModel) return [];
    try {
      const results = client.searchLenses({
        lensMaker: id.maker || undefined, lensModel,
        cameraMaker: camera?.maker || undefined, cameraModel: camera?.model || undefined,
        searchFlags: SEARCH_EXACT
      });
      return Array.isArray(results) ? results.filter(lens => lens && (!id.maker || lens.maker === id.maker)
        && lens.model === id.model && Number.isInteger(lens.handle) && lens.handle > 0) : [];
    } catch {
      return [];
    }
  };
  let candidates = [];
  for (const camera of id.camera ? [null, id.camera] : [null]) {
    for (const pattern of [id.model, digitFreeWords(id.model)]) {
      candidates = search(pattern, camera);
      if (candidates.length) break;
    }
    if (candidates.length) break;
  }
  if (!candidates.length) return null;
  const nearest = (list, distance) => {
    const best = Math.min(...list.map(distance));
    return list.filter(lens => distance(lens) <= best + 1e-6);
  };
  candidates = nearest(candidates, lens => Math.abs(finite(lens.cropFactor, 1) - id.cropFactor));
  const sameRanges = candidates.filter(lens => ['minFocal', 'maxFocal', 'minAperture', 'maxAperture']
    .every(field => Math.abs(finite(lens[field]) - id[field]) < 1e-3));
  if (sameRanges.length) candidates = sameRanges;
  if (candidates.length > 1 && id.camera) {
    const found = new Set(search(id.model, id.camera).map(lens => lens.handle));
    const withCamera = candidates.filter(lens => found.has(lens.handle));
    if (withCamera.length) candidates = withCamera;
  }
  return Math.min(...candidates.map(lens => lens.handle));
}

// Resolved handles, per lensfun client: the identity key's handle, or null
// when the build has no such lens. A profile is looked up once a session.
const resolvedHandles = new WeakMap();

function handlesOf(client) {
  let handles = resolvedHandles.get(client);
  if (!handles) {
    handles = new Map();
    resolvedHandles.set(client, handles);
  }
  return handles;
}

/** findLensHandle, once per profile and client. */
export function lensHandleFor(client, profile) {
  const key = lensProfileKey(profile);
  if (!key || !client || typeof client !== 'object') return null;
  const handles = handlesOf(client);
  if (!handles.has(key)) handles.set(key, findLensHandle(client, profile));
  return handles.get(key);
}

/**
 * Records the handle a search of `client` returned with `profile` (the
 * profile chosen from it), so it resolves to that very entry.
 */
export function rememberLensHandle(client, profile, handle) {
  const key = lensProfileKey(profile);
  if (!key || !client || typeof client !== 'object' || !Number.isInteger(handle) || handle < 1) return;
  handlesOf(client).set(key, handle);
}

/**
 * What lensfun's map builders are asked for a frame of `width` x `height`
 * under a resolved lens block (enabled, with a selected lens) whose lens is
 * `lensHandle` in the running build (lensHandleFor), and the key the maps
 * are cached by (the lens's identity, not its handle).
 */
export function lensMapRequest(lensCorrection, width, height, lensHandle) {
  const params = {
    focal: lensCorrection.params.focal,
    crop: lensCorrection.params.crop,
    aperture: lensCorrection.params.aperture,
    distance: lensCorrection.params.distance,
    stepMode: lensCorrection.params.stepMode,
    step: lensMapStep(lensCorrection.params, width, height)
  };
  const modes = lensCorrection.modes;
  const key = [
    lensProfileKey(lensCorrection.selectedLens),
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
const LF_MODIFY_DISTORTION = 0x8;

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

// lensfun-wasm's grid for a frame (toGrid): a node every `step` pixels.
const gridNodes = (size, step) => Math.floor((size - 1) / step) + 1;

// The vignetting gains of a lens without distortion calibration, or null.
// lensfun-wasm builds the gains only after the distortion map
// (buildCorrectionMaps), which such a lens fails (-4). Its client binds the
// native builder all the same (`fns.buildVignettingMap`, which its own
// buildCorrectionMaps runs through `runFloatMap`; 0.1.3 and 0.1.4): the same
// gains for the same grid, without the distortion map. Neither is part of
// lensfun-wasm's typed API, so a client without them gets no vignetting
// correction for these lenses (lensMaps.lensfun.test.mjs checks the
// installed release).
function vignettingOnlyMap(client, { lensHandle, width, height, focal, crop, step, reverse }, aperture, distance) {
  const native = client.fns?.buildVignettingMap;
  if (typeof native !== 'function' || typeof client.runFloatMap !== 'function') return null;
  try {
    const gains = client.runFloatMap(gridNodes(width, step) * gridNodes(height, step) * 3, native,
      lensHandle, focal, crop, aperture, distance ?? 1000, width, height, reverse ? 1 : 0, step);
    return gains instanceof Float32Array && gains.length === gridNodes(width, step) * gridNodes(height, step) * 3 ? gains : null;
  } catch {
    return null;
  }
}

/**
 * lensfun's maps for a request (lensMapRequest's), as the remap reads them:
 * `geometry`, every channel's source x, y per node (the distortion
 * correction); `tca`, per channel, the source x, y with distortion and TCA
 * corrected together; `vignetting`, the gains. Each is null where not
 * applied; without `geometry` and `tca` the remap reads every pixel in place.
 *
 * lensfun corrects distortion first and TCA at that distorted position
 * (lfModifier::ApplySubpixelGeometryDistortion, buildSubpixelGeometryMap,
 * lensfun-wasm 0.1.4 on). The `tca` map of buildCorrectionMaps is built
 * with TCA correction alone and carries no distortion: sampled in place of
 * the geometry map it would undo the distortion correction, so it is never
 * used. The distortion alone is applied when the lens has no TCA
 * calibration, when its TCA map fails, and on a lensfun-wasm without
 * buildSubpixelGeometryMap. Vignetting is applied when the lens has
 * vignetting calibration and its map builds. For a lens with distortion
 * calibration the distortion map is required: when it cannot be built this
 * throws, and the frame is converted uncorrected (lensfun-wasm 0.1.3 builds
 * no map at all: its module exports no HEAPF32 view). A lens without it (39
 * of 0.1.4's 1558 entries, among them macro lenses such as the Nikkor AF-S
 * 60 mm f/2.8G ED Micro, vignetting only, and the Sigma 70mm f/2.8 EX DG
 * Macro, TCA only) gets its TCA (buildSubpixelGeometryMap gives TCA alone)
 * and its vignetting (vignettingOnlyMap) without a geometry map. Maps that
 * would correct nothing throw too: no calibration at this crop factor (an
 * image crop under 0.96 of the calibration's), or none for the modes on.
 */
export function buildLensMaps(client, request) {
  const { includeTca, includeVignetting, aperture, distance, ...grid } = request;
  const available = lensModifications(client, grid.lensHandle, grid.crop);
  const vignetting = Boolean(includeVignetting) && (available & LF_MODIFY_VIGNETTING) !== 0;
  let maps;
  if (available & LF_MODIFY_DISTORTION) {
    let built;
    try {
      built = client.buildCorrectionMaps({ ...grid, includeTca: false, includeVignetting: vignetting, aperture, distance });
    } catch (error) {
      if (!vignetting) throw error;
      // The calibration does not reach this aperture and distance.
      built = client.buildCorrectionMaps({ ...grid, includeTca: false, includeVignetting: false });
    }
    maps = {
      gridWidth: built.gridWidth,
      gridHeight: built.gridHeight,
      step: built.step,
      geometry: built.geometry,
      tca: null,
      vignetting: (vignetting && built.vignetting) || null
    };
  } else {
    maps = {
      gridWidth: gridNodes(grid.width, grid.step),
      gridHeight: gridNodes(grid.height, grid.step),
      step: grid.step,
      geometry: null,
      tca: null,
      vignetting: vignetting ? vignettingOnlyMap(client, grid, aperture, distance) : null
    };
  }
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
  if (!maps.geometry && !maps.tca && !maps.vignetting) {
    throw new Error((available & (LF_MODIFY_DISTORTION | LF_MODIFY_TCA | LF_MODIFY_VIGNETTING))
      ? 'nothing to correct: this lens has no distortion calibration, and its TCA and vignetting corrections are off or failed'
      : `lensfun has no calibration of this lens for crop factor ${grid.crop}`);
  }
  return maps;
}

/** Whether the maps move any pixel (a geometry map, or TCA on with a TCA map). */
export function lensMapsMovePixels(maps, modes) {
  return Boolean(maps && (maps.geometry || (modes?.includeTca && maps.tca)));
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
 * from `maps.gridRow0` on (sliceLensMaps). Without a geometry map and TCA
 * (a lens without distortion calibration) every pixel is read in place, its
 * own value exactly. With a 16-bit plane the 8-bit bytes are its >>> 8;
 * every pixel of the rows is written, alpha opaque.
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
      } else if (geometry) {
        const geometryCoords = sampleGridPair(geometry, gridWidth, x0, x1, ly0, ly1, fx, fy);
        rX = geometryCoords.x; rY = geometryCoords.y;
        gX = geometryCoords.x; gY = geometryCoords.y;
        bX = geometryCoords.x; bY = geometryCoords.y;
      } else {
        rX = x; rY = y;
        gX = x; gY = y;
        bX = x; bY = y;
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
 * nodes name none: a pixel interpolated from one reads no row. null when
 * the remap reads every pixel in place (no geometry map, no TCA).
 */
export function lensRowExtents(maps, modes) {
  const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
  const grid = tca || maps.geometry;
  if (!grid) return null;
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
 * or the rows themselves when the remap reads in place (`extents` null), the
 * second tap's row below it, and a row of margin each way for
 * floating-point slack, clamped to the image. A superset: the remap reads no
 * row outside it.
 */
export function lensSourceRows(maps, modes, y0, y1, height, extents = lensRowExtents(maps, modes)) {
  let low = Infinity;
  let high = -Infinity;
  if (!extents) {
    low = y0;
    high = y1 - 1;
  } else {
    const [first, last] = lensGridRows(maps, y0, y1);
    for (let gy = first; gy <= last; gy++) {
      if (extents.min[gy] < low) low = extents.min[gy];
      if (extents.max[gy] > high) high = extents.max[gy];
    }
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
    geometry: tca || !maps.geometry ? null : rows(maps.geometry, 2),
    tca,
    vignetting: (modes.includeVignetting && maps.vignetting) ? rows(maps.vignetting, 3) : null
  };
}

/** The buffers of a slice's grids (sliceLensMaps), for a transfer list. */
export function lensMapBuffers(maps) {
  return [maps.geometry, maps.tca, maps.vignetting].filter(Boolean).map(array => array.buffer);
}
