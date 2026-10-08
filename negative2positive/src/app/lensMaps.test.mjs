// Lens correction's remap (#278) moved out of main.js into lensMaps.js, so
// the display-proxy fills can run it on row bands in the geometry pool. The
// whole-image remap and the maps lensfun is asked for are byte-identical to
// main.js's before the move (its code is kept below as the reference; the
// cache key names the profile's identity where it named lensfun's handle),
// and a band of rows remapped from only the input rows lensSourceRows names
// and the grid rows sliceLensMaps keeps is those rows of the whole remap.
// The maps cover the frame (lensGridNodes), so the last columns and rows
// interpolate between nodes, in the remap and the repair brush alike.
// Lenses without distortion calibration are remapped in place; a saved
// profile resolves to the running build's handle by its identity.
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
    } else {
      this.data = dataOrWidth; this.width = width; this.height = height;
    }
  }
};
const {
  applyLensMapsToImage, applyLensMapRows, buildLensMaps, lensGridNodes, lensMapRequest, lensMapStep, lensRowExtents, lensSourceRows, sliceLensMaps,
  lensMapBuffers, lensProfileIdentity, lensProfileKey, findLensHandle, lensHandleFor, rememberLensHandle, lensMapsMovePixels
} = await import('./lensMaps.js');
const { lensSourcePoint } = await import('./repairBrush.js');
const { allocPlane16, isSharedPlane, sharedPlanesAvailable } = await import('./crossOriginIsolation.js');
const { lensTestMaps, lensTestClient } = await import('./lensTestMaps.mjs');

// ---- main.js before #278, verbatim: the reference ----
function pre278Remap() {
  function clampBetween(v, min, max) {
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  function bilerp(a00, a10, a01, a11, fx, fy) {
    const x0 = a00 + (a10 - a00) * fx;
    const x1 = a01 + (a11 - a01) * fx;
    return x0 + (x1 - x0) * fy;
  }

  function sampleImageChannelBilinear(data, width, height, x, y, channel) {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0;
    const fy = y - y0;

    const i00 = (y0 * width + x0) * 4 + channel;
    const i10 = (y0 * width + x1) * 4 + channel;
    const i01 = (y1 * width + x0) * 4 + channel;
    const i11 = (y1 * width + x1) * 4 + channel;

    return bilerp(data[i00], data[i10], data[i01], data[i11], fx, fy);
  }

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

  function applyLensMapsToImage(imageData, maps, modes) {
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
    const gridWidth = maps.gridWidth;
    const gridHeight = maps.gridHeight;
    const step = Math.max(1, maps.step || 1);
    const geometry = maps.geometry;
    const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
    const vignetting = (modes.includeVignetting && maps.vignetting) ? maps.vignetting : null;

    for (let y = 0; y < height; y++) {
      const gyRaw = y / step;
      const y0 = clampBetween(Math.floor(gyRaw), 0, gridHeight - 1);
      const y1 = clampBetween(y0 + 1, 0, gridHeight - 1);
      const fy = clampBetween(gyRaw - y0, 0, 1);

      for (let x = 0; x < width; x++) {
        const gxRaw = x / step;
        const x0 = clampBetween(Math.floor(gxRaw), 0, gridWidth - 1);
        const x1 = clampBetween(x0 + 1, 0, gridWidth - 1);
        const fx = clampBetween(gxRaw - x0, 0, 1);

        let rX, rY, gX, gY, bX, bY;
        if (tca) {
          const tcaCoords = sampleGridTca(tca, gridWidth, x0, x1, y0, y1, fx, fy);
          rX = tcaCoords.rx; rY = tcaCoords.ry;
          gX = tcaCoords.gx; gY = tcaCoords.gy;
          bX = tcaCoords.bx; bY = tcaCoords.by;
        } else {
          const geometryCoords = sampleGridPair(geometry, gridWidth, x0, x1, y0, y1, fx, fy);
          rX = geometryCoords.x; rY = geometryCoords.y;
          gX = geometryCoords.x; gY = geometryCoords.y;
          bX = geometryCoords.x; bY = geometryCoords.y;
        }

        let r = sampleImageChannelBilinear(source, width, height, rX, rY, 0);
        let g = sampleImageChannelBilinear(source, width, height, gX, gY, 1);
        let b = sampleImageChannelBilinear(source, width, height, bX, bY, 2);

        if (vignetting) {
          const gains = sampleGridTriple(vignetting, gridWidth, x0, x1, y0, y1, fx, fy);
          r *= gains.r;
          g *= gains.g;
          b *= gains.b;
        }

        const outIdx = (y * width + x) * 4;
        const rv = clampBetween(Math.round(r), 0, maxValue);
        const gv = clampBetween(Math.round(g), 0, maxValue);
        const bv = clampBetween(Math.round(b), 0, maxValue);
        if (out16) {
          out16[outIdx] = rv;
          out16[outIdx + 1] = gv;
          out16[outIdx + 2] = bv;
          out16[outIdx + 3] = 65535;
          // Keep the 8-bit view exactly consistent with the 16-bit plane.
          outData[outIdx] = rv >>> 8;
          outData[outIdx + 1] = gv >>> 8;
          outData[outIdx + 2] = bv >>> 8;
        } else {
          outData[outIdx] = rv;
          outData[outIdx + 1] = gv;
          outData[outIdx + 2] = bv;
        }
        outData[outIdx + 3] = 255;
      }
    }
    if (out16) {
      output.__image16 = { width, height, data: out16 };
    }
    return output;
  }

  return applyLensMapsToImage;
}

// The maps main.js asked lensfun for before #278 (applyLensCorrectionWithSettings).
function pre278Request(lensCorrection, width, height) {
  function clampBetween(v, min, max) {
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }
  function getAutoLensMapStep(width, height) {
    const maxSide = Math.max(width, height);
    if (maxSide >= 5200) return 8;
    if (maxSide >= 3600) return 6;
    if (maxSide >= 2400) return 4;
    if (maxSide >= 1500) return 3;
    return 2;
  }
  function resolveLensMapStep(params, width, height) {
    if (params.stepMode === 'manual') {
      return Math.round(clampBetween(params.step || 2, 1, 16));
    }
    return getAutoLensMapStep(width, height);
  }
  function buildLensMapCacheKey(lensHandle, width, height, params, modes) {
    return [
      lensHandle, width, height, params.focal.toFixed(4), params.crop.toFixed(4), params.aperture.toFixed(4),
      params.distance.toFixed(4), params.step, params.stepMode, modes.includeTca ? 1 : 0, modes.includeVignetting ? 1 : 0
    ].join('|');
  }
  const selectedLens = lensCorrection.selectedLens;
  const params = {
    focal: lensCorrection.params.focal,
    crop: lensCorrection.params.crop,
    aperture: lensCorrection.params.aperture,
    distance: lensCorrection.params.distance,
    stepMode: lensCorrection.params.stepMode,
    step: resolveLensMapStep(lensCorrection.params, width, height)
  };
  const cacheKey = buildLensMapCacheKey(selectedLens.handle, width, height, params, lensCorrection.modes);
  return {
    key: cacheKey,
    request: {
      lensHandle: selectedLens.handle, width, height, focal: params.focal, crop: params.crop, step: params.step, reverse: false,
      includeTca: lensCorrection.modes.includeTca, includeVignetting: lensCorrection.modes.includeVignetting,
      aperture: params.aperture, distance: params.distance
    }
  };
}

const pre278 = pre278Remap();

function image(width, height, { seed = 3, with16 = true } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { data16[i + c] = rnd() % 65536; data8[i + c] = with16 ? data16[i + c] >>> 8 : rnd() % 256; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  const result = new ImageData(data8, width, height);
  if (with16) result.__image16 = { width, height, data: data16 };
  return result;
}

const lensMaps = lensTestMaps;

const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function sameImage(actual, expected, label) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${label}: size`);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane`);
  if (expected.__image16) assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit`);
}

const MODES = [
  { includeTca: true, includeVignetting: true }, { includeTca: false, includeVignetting: true },
  { includeTca: true, includeVignetting: false }, { includeTca: false, includeVignetting: false }
];
// Grids that cover the frame (buildLensMaps'), and one that ends at or
// before the last pixel (lensfun-wasm's default grid: the remap holds the
// last node past it).
const MAPS = [
  ['lensfun-like', {}], ['strong', { strength: 0.3 }], ['outward', { strength: -0.08 }],
  ['below the frame', { shift: 1e4 }], ['poisoned', { poison: true }], ['default grid', { coverFrame: false }]
];
// A lens without distortion calibration (#278): no geometry map; TCA alone
// and vignetting, or vignetting alone. Read in place where TCA is off.
const IN_PLACE_MAPS = [['no distortion, TCA and vignetting', { distortion: false }], ['no distortion, vignetting only', { distortion: false, tca: false }]];

// ---- The whole-image remap is main.js's of before, byte for byte ----
let cases = 0;
for (const [width, height] of [[37, 23], [64, 48], [23, 61]]) {
  for (const step of [1, 2, 3, 5]) {
    for (const [mapLabel, options] of MAPS) {
      const maps = lensMaps(width, height, step, options);
      for (const modes of MODES) {
        for (const with16 of [true, false]) {
          const input = image(width, height, { seed: width + step, with16 });
          const label = `${width}x${height} step ${step} ${mapLabel} ${JSON.stringify(modes)} ${with16 ? '16' : '8'}-bit`;
          sameImage(applyLensMapsToImage(input, maps, modes), pre278(input, maps, modes), label);
          cases++;
        }
      }
    }
  }
}
// A shared 16-bit plane gives a shared output with the same pixels.
{
  const before = { isolated: globalThis.crossOriginIsolated, location: globalThis.location };
  globalThis.crossOriginIsolated = true;
  globalThis.location = { search: '' };
  try {
    const input = image(40, 30, { seed: 9 });
    const shared = allocPlane16(input.__image16.data.length, { shared: true });
    shared.set(input.__image16.data);
    input.__image16 = { width: 40, height: 30, data: shared };
    const maps = lensMaps(40, 30, 2);
    const output = applyLensMapsToImage(input, maps, MODES[0]);
    assert.equal(isSharedPlane(output.__image16.data), isSharedPlane(pre278(input, maps, MODES[0]).__image16.data), 'the same allocation as before');
    sameImage(output, pre278(input, maps, MODES[0]), 'a shared plane');
  } finally {
    globalThis.crossOriginIsolated = before.isolated;
    globalThis.location = before.location;
  }
}

// ---- The maps lensfun is asked for are as before, for the handle the
// profile resolves to; their cache key names the profile's identity where
// it named the handle (#278) ----
{
  const lens = (params, modes = MODES[0]) => ({
    enabled: true, selectedLens: { handle: 2741040, maker: 'Nikon', model: 'Nikkor AF-S 18-55mm f/3.5-5.6G DX VR', cropFactor: 1.528 },
    params: { focal: 18, crop: 1.528, aperture: 5.6, distance: 1000, stepMode: 'auto', step: 2, ...params }, modes
  });
  for (const [width, height] of [[1499, 900], [1500, 1000], [2400, 1600], [3599, 2400], [3600, 2400], [5199, 3466], [5200, 3466], [9000, 6000]]) {
    for (const params of [{}, { stepMode: 'manual', step: 5 }, { stepMode: 'manual', step: 0 }, { stepMode: 'manual', step: 40 }, { focal: 55.123456, aperture: 22 }]) {
      for (const modes of MODES) {
        const block = lens(params, modes);
        const before = pre278Request(block, width, height);
        const now = lensMapRequest(block, width, height, 2741040);
        assert.deepEqual(now.request, before.request, `request ${width}x${height} ${JSON.stringify(params)}`);
        assert.equal(now.key, [lensProfileKey(block.selectedLens), ...before.key.split('|').slice(1)].join('|'), `key ${width}x${height} ${JSON.stringify(params)}`);
        // Another build's handle for the same profile: the same maps.
        assert.equal(lensMapRequest(block, width, height, 917504).key, now.key, 'the key names no handle');
      }
    }
  }
  assert.equal(lensMapStep({ stepMode: 'auto' }, 9000, 6000), 8);
  assert.equal(lensMapStep({ stepMode: 'manual', step: 3.4 }, 9000, 6000), 3);
}

// ---- Bands: rows [y0, y1) remapped from the input rows lensSourceRows
// names (a buffer of only those rows: a read outside it would read nothing)
// and the grid rows sliceLensMaps keeps are those rows of the whole remap ----
let bands = 0;
for (const [width, height] of [[64, 48], [23, 61]]) {
  for (const step of [1, 2, 3, 5]) {
    for (const [mapLabel, options] of [...MAPS, ...IN_PLACE_MAPS]) {
      const maps = lensMaps(width, height, step, options);
      for (const modes of MODES) {
        for (const with16 of [true, false]) {
          const input = image(width, height, { seed: 31 + step, with16 });
          const whole = applyLensMapsToImage(input, maps, modes);
          const plane = with16 ? input.__image16.data : input.data;
          const outPlane = with16 ? whole.__image16.data : whole.data;
          const extents = lensRowExtents(maps, modes);
          for (const rows of [1, 3, 7, height]) {
            for (let y0 = 0; y0 < height; y0 += rows) {
              const y1 = Math.min(height, y0 + rows);
              const window = lensSourceRows(maps, modes, y0, y1, height, extents);
              assert.ok(window.y0 >= 0 && window.y1 <= height && window.y1 > window.y0, 'a window inside the frame');
              assert.deepEqual(lensSourceRows(maps, modes, y0, y1, height), window, 'the extents are those of the maps');
              const source = plane.slice(window.y0 * width * 4, window.y1 * width * 4);
              const slice = sliceLensMaps(maps, modes, y0, y1);
              const out = with16 ? new Uint16Array((y1 - y0) * width * 4) : new Uint8ClampedArray((y1 - y0) * width * 4);
              applyLensMapRows({ source, sourceRow0: window.y0, width, height, maxValue: with16 ? 65535 : 255 }, slice, modes,
                with16 ? { out16: out } : { out8: out }, y0, y1);
              const label = `${width}x${height} step ${step} ${mapLabel} ${JSON.stringify(modes)} ${with16 ? '16' : '8'}-bit rows ${y0}-${y1}`;
              assert.ok(bytes(out).equals(bytes(outPlane.subarray(y0 * width * 4, y1 * width * 4))), label);
              bands++;
            }
          }
        }
      }
    }
  }
}

// The windows are tight where the lens moves rows little: a middle band of a
// lensfun-like map reads its own rows and a few more, not the frame.
{
  const width = 600, height = 400;
  const maps = lensMaps(width, height, 4);
  const window = lensSourceRows(maps, MODES[0], 192, 208, height);
  assert.ok(window.y0 >= 185 && window.y1 <= 215, `a middle band's window: ${JSON.stringify(window)}`);
  const top = lensSourceRows(maps, MODES[0], 0, 16, height);
  assert.equal(top.y0, 0);
  assert.ok(top.y1 < 30, `the top band reads its rows and the inward pull: ${JSON.stringify(top)}`);
  // Only the grid rows a band reads travel with it, as its own copies.
  const slice = sliceLensMaps(maps, MODES[0], 192, 208);
  assert.equal(slice.gridRow0, 48);
  assert.equal(slice.tca.length, (53 - 48) * maps.gridWidth * 6, 'grid rows 48-52');
  assert.equal(slice.geometry, null, 'with TCA the geometry map is not read');
  assert.equal(slice.vignetting.length, (53 - 48) * maps.gridWidth * 3);
  assert.notEqual(slice.tca.buffer, maps.tca.buffer);
  assert.deepEqual(lensMapBuffers(slice), [slice.tca.buffer, slice.vignetting.buffer]);
  const plain = sliceLensMaps(maps, MODES[3], 192, 208);
  assert.ok(plain.geometry && !plain.tca && !plain.vignetting, 'without TCA or vignetting: the geometry map only');
}

// ---- Which maps buildLensMaps builds (#278): the distortion map always,
// TCA as buildSubpixelGeometryMap's per-channel map (distortion and TCA
// together) where the lens has TCA calibration, vignetting where it has
// vignetting calibration; a TCA or vignetting map that fails is left out,
// a distortion map that fails throws (the frame converts uncorrected) ----
{
  const LF_TCA = 0x1, LF_VIGNETTING = 0x2, LF_DISTORTION = 0x8;
  const request = lensMapRequest({
    enabled: true, selectedLens: { maker: 'Test', model: 'Test 24mm' },
    params: { focal: 24, crop: 1, aperture: 8, distance: 1000, stepMode: 'manual', step: 4 },
    modes: { includeTca: true, includeVignetting: true }
  }, 120, 80, 7).request;
  const expected = lensTestMaps(120, 80, 4);
  const sameArray = (actual, wanted, label) => assert.ok(actual && bytes(actual).equals(bytes(wanted)), label);

  // A lens with all three: lensfun's geometry and vignetting, and the
  // per-channel map of distortion and TCA together; buildCorrectionMaps is
  // never asked for its TCA-only map.
  const full = lensTestClient();
  const maps = buildLensMaps(full, request);
  sameArray(maps.geometry, expected.geometry, 'the geometry map');
  sameArray(maps.tca, expected.tca, 'TCA: buildSubpixelGeometryMap\'s per-channel map');
  sameArray(maps.vignetting, expected.vignetting, 'the vignetting map');
  assert.deepEqual([maps.gridWidth, maps.gridHeight, maps.step], [expected.gridWidth, expected.gridHeight, 4]);
  assert.deepEqual(full.requests.map(r => [r.includeTca, r.includeVignetting, r.aperture, r.distance]), [[false, true, 8, 1000]]);
  const { includeTca, includeVignetting, aperture, distance, ...grid } = request;
  assert.deepEqual(full.subpixelRequests, [{ ...grid, coverFrame: true }], 'the per-channel map is asked for the same grid');
  assert.ok(full.requests.every(r => r.coverFrame === true), 'every map covers the frame');

  // Without TCA or vignetting calibration: neither is asked for.
  for (const [label, modifications, tca, vignetting] of [
    ['no TCA calibration', LF_DISTORTION | LF_VIGNETTING, false, true],
    ['no vignetting calibration', LF_DISTORTION | LF_TCA, true, false],
    ['distortion only', LF_DISTORTION, false, false]
  ]) {
    const client = lensTestClient({ modifications });
    const built = buildLensMaps(client, request);
    assert.equal(Boolean(built.tca), tca, `${label}: TCA`);
    assert.equal(Boolean(built.vignetting), vignetting, `${label}: vignetting`);
    assert.equal(client.subpixelRequests.length, tca ? 1 : 0, `${label}: the per-channel map asked for`);
    assert.deepEqual(client.requests.map(r => r.includeVignetting), [vignetting], `${label}: one geometry request`);
  }
  // The modes switched off: neither is built.
  {
    const client = lensTestClient();
    const built = buildLensMaps(client, { ...request, includeTca: false, includeVignetting: false });
    assert.ok(built.geometry && !built.tca && !built.vignetting && client.subpixelRequests.length === 0, 'TCA and vignetting off');
  }
  // A per-channel map that fails, reports no TCA, or a lensfun-wasm without
  // buildSubpixelGeometryMap (before 0.1.4): the distortion alone. Its
  // TCA-only map would drop the distortion, so it is never used.
  for (const [label, patch] of [
    ['a per-channel map that throws', { buildSubpixelGeometryMap() { throw new Error('native map builder failed with code -4'); } }],
    ['a per-channel map without TCA', { buildSubpixelGeometryMap(r) { const m = lensTestMaps(r.width, r.height, r.step); return { ...m, coords: m.tca, modifications: LF_DISTORTION }; } }],
    ['a client without buildSubpixelGeometryMap', { buildSubpixelGeometryMap: undefined }]
  ]) {
    const client = Object.assign(lensTestClient(), patch);
    const built = buildLensMaps(client, request);
    sameArray(built.geometry, expected.geometry, `${label}: the geometry map`);
    assert.equal(built.tca, null, `${label}: no TCA`);
    assert.ok(client.requests.every(r => r.includeTca === false), `${label}: no TCA-only map`);
  }
  // A vignetting map that fails: built again without it.
  {
    const client = lensTestClient();
    const build = client.buildCorrectionMaps;
    client.buildCorrectionMaps = r => { if (r.includeVignetting) throw new Error('native map builder failed with code -4'); return build(r); };
    const built = buildLensMaps(client, request);
    assert.ok(built.geometry && built.tca && !built.vignetting, 'a failed vignetting map is left out');
    assert.deepEqual(client.requests.map(r => r.includeVignetting), [false]);
  }
  // A client that cannot tell what the lens has: every map is tried.
  {
    const client = Object.assign(lensTestClient(), { getAvailableModifications: undefined });
    const built = buildLensMaps(client, request);
    assert.ok(built.geometry && built.tca && built.vignetting, 'without getAvailableModifications');
  }
  // A distortion map that fails (lensfun-wasm 0.1.3 reads a heap view its
  // module does not export): buildLensMaps throws, with and without the
  // vignetting retry.
  for (const modifications of [LF_DISTORTION | LF_TCA | LF_VIGNETTING, LF_DISTORTION]) {
    const client = Object.assign(lensTestClient({ modifications }), {
      buildCorrectionMaps() { throw new TypeError("Cannot read properties of undefined (reading 'subarray')"); }
    });
    assert.throws(() => buildLensMaps(client, request), TypeError);
    assert.equal(client.subpixelRequests.length, 0, 'nothing else is built');
  }
}

// ---- In place (#278): without a geometry map, and without TCA, every
// pixel is read where it is: its own value exactly, times the vignetting
// gain; with TCA, red and blue move and green stays. The same as main.js's
// remap of before given a geometry map of the nodes themselves, where the
// grid ends on the frame's last row and column (its nodes then interpolate
// to every pixel exactly) ----
let inPlaceCases = 0;
{
  const identityGrid = (width, height, step) => {
    const maps = lensTestMaps(width, height, step);
    const grid = new Float32Array(maps.gridWidth * maps.gridHeight * 2);
    for (let gy = 0; gy < maps.gridHeight; gy++) {
      for (let gx = 0; gx < maps.gridWidth; gx++) {
        grid[(gy * maps.gridWidth + gx) * 2] = gx * step;
        grid[(gy * maps.gridWidth + gx) * 2 + 1] = gy * step;
      }
    }
    return grid;
  };
  for (const [width, height] of [[37, 25], [65, 49]]) {
    for (const step of [1, 2, 4]) {
      for (const [mapLabel, options] of IN_PLACE_MAPS) {
        const maps = lensTestMaps(width, height, step, options);
        assert.equal(maps.geometry, null, `${mapLabel}: no geometry map`);
        for (const modes of MODES) {
          for (const with16 of [true, false]) {
            const input = image(width, height, { seed: width * step, with16 });
            const label = `in place ${width}x${height} step ${step} ${mapLabel} ${JSON.stringify(modes)} ${with16 ? '16' : '8'}-bit`;
            const output = applyLensMapsToImage(input, maps, modes);
            sameImage(output, pre278(input, { ...maps, geometry: identityGrid(width, height, step) }, modes), label);
            if (!modes.includeVignetting && !(modes.includeTca && maps.tca)) {
              const plane = with16 ? input.__image16.data : input.data;
              const out = with16 ? output.__image16.data : output.data;
              assert.ok(bytes(out).equals(bytes(plane)), `${label}: the frame itself`);
            }
            if (modes.includeTca && maps.tca) {
              const channel = (plane, c) => plane.filter((_, i) => i % 4 === c);
              const plane16 = with16 ? input.__image16.data : input.data, out16 = with16 ? output.__image16.data : output.data;
              if (!modes.includeVignetting) {
                assert.deepEqual(channel(out16, 1), channel(plane16, 1), `${label}: TCA leaves green in place`);
                assert.notDeepEqual(channel(out16, 0), channel(plane16, 0), `${label}: and moves red`);
              }
            }
            inPlaceCases++;
          }
        }
      }
    }
  }
  // What a band reads in place: its own rows, the second tap and a row of
  // margin; no grid row decides it.
  const maps = lensTestMaps(64, 48, 4, { distortion: false });
  const modes = { includeTca: false, includeVignetting: true };
  assert.equal(lensRowExtents(maps, modes), null, 'in place: no row extents');
  assert.deepEqual(lensSourceRows(maps, modes, 10, 14, 48), { y0: 9, y1: 16 });
  assert.deepEqual(lensSourceRows(maps, modes, 0, 48, 48), { y0: 0, y1: 48 });
  assert.deepEqual(lensSourceRows(maps, modes, 46, 48, 48), { y0: 45, y1: 48 });
  assert.ok(lensRowExtents(maps, { includeTca: true, includeVignetting: true }), 'with TCA: its map\'s rows');
  const slice = sliceLensMaps(maps, modes, 10, 14);
  assert.ok(slice.geometry === null && slice.tca === null && slice.vignetting, 'a band of an in-place remap carries its gains only');
  assert.deepEqual(lensMapBuffers(slice), [slice.vignetting.buffer]);
  const tcaSlice = sliceLensMaps(maps, { includeTca: true, includeVignetting: false }, 10, 14);
  assert.ok(tcaSlice.geometry === null && tcaSlice.tca && tcaSlice.vignetting === null);
  // Whether the remap moves pixels (the repair brush maps strokes only then).
  assert.equal(lensMapsMovePixels(maps, modes), false, 'vignetting alone moves nothing');
  assert.equal(lensMapsMovePixels(maps, { includeTca: true }), true, 'TCA moves red and blue');
  assert.equal(lensMapsMovePixels(lensTestMaps(64, 48, 4), { includeTca: false }), true, 'distortion moves everything');
}

// ---- Lenses without distortion calibration (#278: 39 of lensfun-wasm
// 0.1.4's 1558 entries): no geometry map (lensfun fails it, -4), TCA from
// buildSubpixelGeometryMap alone and vignetting from buildVignettingMap
// alone; nothing to apply throws, and the frame converts uncorrected ----
{
  const LF_TCA = 0x1, LF_VIGNETTING = 0x2;
  const request = lensMapRequest({
    enabled: true, selectedLens: { maker: 'Test', model: 'Test 60mm Macro' },
    params: { focal: 60, crop: 1, aperture: 5.6, distance: 1000, stepMode: 'manual', step: 4 },
    modes: { includeTca: true, includeVignetting: true }
  }, 120, 80, 9).request;
  const expected = lensTestMaps(120, 80, 4, { distortion: false });
  const sameArray = (actual, wanted, label) => assert.ok(actual && bytes(actual).equals(bytes(wanted)), label);
  for (const [label, modifications, tca, vignetting] of [
    ['TCA and vignetting', LF_TCA | LF_VIGNETTING, true, true],
    ['TCA only (the Sigma 70mm f/2.8 EX DG Macro)', LF_TCA, true, false],
    ['vignetting only (the Nikkor AF-S 60 mm f/2.8G ED Micro)', LF_VIGNETTING, false, true]
  ]) {
    const client = lensTestClient({ modifications });
    const maps = buildLensMaps(client, request);
    assert.equal(maps.geometry, null, `${label}: no geometry map`);
    assert.deepEqual([maps.gridWidth, maps.gridHeight, maps.step], [expected.gridWidth, expected.gridHeight, 4], `${label}: lensfun's grid`);
    assert.equal(client.requests.length, 0, `${label}: buildCorrectionMaps is not asked (it fails without distortion)`);
    if (tca) sameArray(maps.tca, expected.tca, `${label}: TCA alone, buildSubpixelGeometryMap's`);
    else assert.equal(maps.tca, null, `${label}: no TCA`);
    if (vignetting) sameArray(maps.vignetting, expected.vignetting, `${label}: the gains alone`);
    else assert.equal(maps.vignetting, null, `${label}: no vignetting`);
    assert.equal(client.vignettingRequests.length, vignetting ? 1 : 0, `${label}: buildVignettingMap asked`);
    if (vignetting) {
      const { includeTca, includeVignetting, ...grid } = request;
      assert.deepEqual(client.vignettingRequests[0], { ...grid, coverFrame: true }, `${label}: buildVignettingMap, for the request's grid`);
    }
    // TCA switched off: the gains alone, or nothing to correct.
    const off = lensTestClient({ modifications });
    if (vignetting) assert.ok(buildLensMaps(off, { ...request, includeTca: false }).tca === null, `${label}: TCA off`);
    else assert.throws(() => buildLensMaps(off, { ...request, includeTca: false }), /nothing to correct/, `${label}: TCA off leaves nothing`);
  }
  // Vignetting only, switched off: nothing to correct.
  assert.throws(() => buildLensMaps(lensTestClient({ modifications: LF_VIGNETTING }), { ...request, includeVignetting: false }), /nothing to correct/);
  // No calibration at this crop factor (an image crop under 0.96 of the
  // calibration's): lensfun reports none.
  assert.throws(() => buildLensMaps(lensTestClient({ modifications: 0 }), request), /no calibration of this lens for crop factor 1/);
  // A client without buildVignettingMap (before lensfun-wasm 0.1.4), or
  // whose builder cannot read its maps (as 0.1.3's cannot): no vignetting,
  // and here nothing to correct.
  for (const patch of [{ buildVignettingMap: undefined }, { buildVignettingMap() { throw new TypeError("Cannot read properties of undefined (reading 'subarray')"); } }]) {
    const client = Object.assign(lensTestClient({ modifications: LF_TCA | LF_VIGNETTING }), patch);
    const maps = buildLensMaps(client, request);
    assert.ok(maps.tca && maps.vignetting === null, 'TCA still, without vignetting');
    assert.throws(() => buildLensMaps(Object.assign(lensTestClient({ modifications: LF_VIGNETTING }), patch), request), /nothing to correct/);
  }
}

// ---- The maps cover the frame (#278): lensfun-wasm's default grid ends
// on the last node at or before the last pixel, and the remap held that
// node's position for the last (size - 1) % step columns and rows.
// buildLensMaps asks for the grid that covers the frame (coverFrame:
// lensGridNodes nodes, the last up to step - 1 pixels past the last pixel)
// and continues the grid of a client that ignores it (before lensfun-wasm
// 0.1.4) past its last node, linearly. Every pixel then reads the lens's
// positions to within the grid's interpolation; the repair brush maps a
// pixel where the remap reads green ----
let coverCases = 0;
const coverResults = [];
{
  const sameArray = (actual, wanted, label) => assert.ok(actual && bytes(actual).equals(bytes(wanted)), label);
  assert.deepEqual([lensGridNodes(120, 4), lensGridNodes(121, 4), lensGridNodes(1, 4), lensGridNodes(4, 4), lensGridNodes(5, 4)], [31, 31, 1, 2, 2]);
  const blockFor = (step, modes = { includeTca: true, includeVignetting: true }) => ({
    enabled: true, selectedLens: { maker: 'Test', model: 'Test 24mm' },
    params: { focal: 24, crop: 1, aperture: 8, distance: 1000, stepMode: 'manual', step }, modes
  });
  for (const [width, height, step] of [[120, 80, 4], [101, 67, 8], [121, 81, 4], [37, 23, 5], [3, 30, 8]]) {
    const request = lensMapRequest(blockFor(step), width, height, 7).request;
    const covering = lensTestMaps(width, height, step);
    const plain = lensTestMaps(width, height, step, { coverFrame: false });
    // A client with coverFrame: its maps as they are.
    const maps = buildLensMaps(lensTestClient(), request);
    assert.deepEqual([maps.gridWidth, maps.gridHeight, maps.step], [lensGridNodes(width, step), lensGridNodes(height, step), step], `${width}x${height} step ${step}: the covering grid`);
    sameArray(maps.geometry, covering.geometry, `${width}x${height} step ${step}: the client's covering geometry map`);
    sameArray(maps.tca, covering.tca, `${width}x${height} step ${step}: its per-channel map`);
    sameArray(maps.vignetting, covering.vignetting, `${width}x${height} step ${step}: its gains`);
    // A client without: its default grid continued, the nodes it has kept.
    const old = lensTestClient({ coversFrame: false });
    const continued = buildLensMaps(old, request);
    assert.deepEqual([continued.gridWidth, continued.gridHeight], [maps.gridWidth, maps.gridHeight], `${width}x${height} step ${step}: continued to the covering grid`);
    for (const [key, stride] of [['geometry', 2], ['tca', 6], ['vignetting', 3]]) {
      const label = `${width}x${height} step ${step} ${key}`;
      const at = (map, columns, gx, gy, k) => map[(gy * columns + gx) * stride + k];
      for (let gy = 0; gy < continued.gridHeight; gy++) {
        for (let gx = 0; gx < continued.gridWidth; gx++) {
          for (let k = 0; k < stride; k++) {
            const value = at(continued[key], continued.gridWidth, gx, gy, k);
            let expected;
            if (gx < plain.gridWidth && gy < plain.gridHeight) {
              expected = at(plain[key], plain.gridWidth, gx, gy, k);
            } else if (gy < plain.gridHeight) {
              // The new column: the row's last two nodes continued.
              const last = at(plain[key], plain.gridWidth, plain.gridWidth - 1, gy, k);
              expected = Math.fround(2 * last - (plain.gridWidth > 1 ? at(plain[key], plain.gridWidth, plain.gridWidth - 2, gy, k) : last));
            } else {
              // The new row: the column's last two (continued) nodes continued.
              const last = at(continued[key], continued.gridWidth, gx, gy - 1, k);
              expected = Math.fround(2 * last - (plain.gridHeight > 1 ? at(continued[key], continued.gridWidth, gx, gy - 2, k) : last));
            }
            assert.equal(value, expected, `${label}: node ${gx},${gy}[${k}]`);
          }
        }
      }
    }
    assert.ok(old.requests.every(r => r.coverFrame === true), 'it was asked for the covering grid');
    coverCases++;
  }
  // A frame whose sides step divides: the default grid covers it already.
  {
    const request = lensMapRequest(blockFor(4), 121, 81, 7).request;
    sameArray(buildLensMaps(lensTestClient({ coversFrame: false }), request).geometry, lensTestMaps(121, 81, 4, { coverFrame: false }).geometry, 'nothing to continue');
  }
  // Maps of another size: no geometry map (the frame converts uncorrected),
  // no TCA or vignetting map.
  {
    const request = lensMapRequest(blockFor(4), 120, 80, 7).request;
    const wrong = r => lensTestMaps(r.width + 8, r.height, r.step);
    const odd = Object.assign(lensTestClient(), { buildCorrectionMaps: wrong });
    assert.throws(() => buildLensMaps(odd, request), /no geometry map of a 120 x 80 frame at step 4/);
    const oddTca = Object.assign(lensTestClient(), {
      buildSubpixelGeometryMap: r => { const m = wrong(r); return { gridWidth: m.gridWidth, gridHeight: m.gridHeight, step: m.step, coords: m.tca, modifications: 0x9 }; }
    });
    const built = buildLensMaps(oddTca, request);
    assert.ok(built.geometry && built.tca === null && built.vignetting, 'a per-channel map of another size is left out');
    const oddGains = Object.assign(lensTestClient({ modifications: 0x2 }), {
      buildVignettingMap: r => { const m = wrong(r); return { gridWidth: m.gridWidth, gridHeight: m.gridHeight, step: m.step, gains: m.vignetting }; }
    });
    assert.throws(() => buildLensMaps(oddGains, request), /nothing to correct/, 'gains of another size are left out');
  }
  // Every pixel reads the lens's positions (the stand-in's radial remap at
  // the pixel itself): within the grid's interpolation on a covering grid,
  // the last columns and rows too; held at the last node on the default
  // grid. The repair brush maps every pixel where the remap reads green.
  const coordinatePlane = (width, height, axis) => {
    const data16 = new Uint16Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = ((axis === 'x' ? x : y) + 1) * 16;
        data16.fill(v, (y * width + x) * 4, (y * width + x) * 4 + 3);
        data16[(y * width + x) * 4 + 3] = 65535;
      }
    }
    const result = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), width, height);
    result.__image16 = { width, height, data: data16 };
    return result;
  };
  const strength = 0.12;
  for (const [width, height, step] of [[101, 67, 8], [37, 23, 5], [120, 80, 4]]) {
    const cx = (width - 1) / 2, cy = (height - 1) / 2, norm = cx * cx + cy * cy;
    // lensTestMaps' geometry at any pixel.
    const lens = (x, y) => {
      const dx = x - cx, dy = y - cy, scale = 1 - strength * (dx * dx + dy * dy) / norm;
      return [cx + dx * scale, cy + dy * scale];
    };
    const X = coordinatePlane(width, height, 'x'), Y = coordinatePlane(width, height, 'y');
    const lastX = Math.floor((width - 1) / step) * step, lastY = Math.floor((height - 1) / step) * step;
    const read = (maps, modes) => {
      const xs = applyLensMapsToImage(X, maps, modes).__image16.data, ys = applyLensMapsToImage(Y, maps, modes).__image16.data;
      let worst = 0, edge = 0, interior = 0, brush = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4 + 1;
          if (!xs[i] || !ys[i]) continue;
          const rx = xs[i] / 16 - 1, ry = ys[i] / 16 - 1;
          const [ex, ey] = lens(x, y);
          const error = Math.hypot(rx - ex, ry - ey);
          worst = Math.max(worst, error);
          if (x > lastX || y > lastY) edge = Math.max(edge, error);
          else interior = Math.max(interior, error);
          const point = lensSourcePoint({ x, y }, { maps, includeTca: modes.includeTca });
          brush = Math.max(brush, Math.abs(point.x - rx), Math.abs(point.y - ry));
        }
      }
      return { worst, edge, interior, brush };
    };
    const label = `${width}x${height} step ${step}`;
    const modes = { includeTca: false, includeVignetting: false };
    const covered = read(lensTestMaps(width, height, step, { strength, tca: false, vignetting: false }), modes);
    // A strong lens on a small frame: the grid's interpolation is a few
    // tenths of a pixel off, no more at the edges than inside.
    assert.ok(covered.worst < 0.5 && covered.edge <= covered.interior + 1 / 32,
      `${label}: every pixel within the grid's interpolation of the lens (edges ${covered.edge.toFixed(3)} px, inside ${covered.interior.toFixed(3)} px)`);
    assert.ok(covered.brush <= 1 / 32 + 1e-9, `${label}: the repair brush maps every pixel where the remap reads (${covered.brush} px)`);
    const continued = read(buildLensMaps(lensTestClient({ coversFrame: false, strength, tca: false, vignetting: false, modifications: 0x8 }),
      lensMapRequest(blockFor(step, modes), width, height, 7).request), modes);
    assert.ok(continued.worst < 0.5, `${label}: continued, within ${continued.worst.toFixed(3)} px`);
    const held = read(lensTestMaps(width, height, step, { strength, tca: false, vignetting: false, coverFrame: false }), modes);
    assert.ok(held.edge > 1, `${label}: the default grid holds the last node's position (${held.edge.toFixed(2)} px off)`);
    coverResults.push(`${label}: edges ${held.edge.toFixed(2)} -> ${covered.edge.toFixed(3)} px (continued ${continued.edge.toFixed(3)}, inside ${covered.interior.toFixed(3)})`);
    coverCases++;
  }
}

// ---- A lens profile's stable identity (#278): recipes keep lensfun's name
// for the lens, never its handle ----
{
  const legacy = { handle: 2741040, maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', score: 87, minFocal: 24, maxFocal: 105, minAperture: 4, maxAperture: 22, cropFactor: 1 };
  const identity = lensProfileIdentity(legacy);
  assert.deepEqual(identity, { maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', cropFactor: 1, minFocal: 24, maxFocal: 105, minAperture: 4, maxAperture: 22, camera: null });
  assert.equal(lensProfileKey({ ...legacy, handle: 917504, score: 12 }), lensProfileKey(legacy), 'another build\'s handle and score: the same profile');
  assert.ok(!lensProfileKey(legacy).includes('2741040'), 'the key names no handle');
  assert.notEqual(lensProfileKey({ ...legacy, cropFactor: 1.611 }), lensProfileKey(legacy), 'another calibration');
  assert.notEqual(lensProfileKey({ ...legacy, camera: { maker: 'Canon', model: 'Canon EOS 5D Mark III' } }), lensProfileKey(legacy), 'the camera it was found with');
  assert.equal(lensProfileIdentity({ ...legacy, camera: { maker: 'Canon', model: '' } }).camera, null, 'a camera without a model narrows no search');
  assert.equal(lensProfileIdentity({ handle: 2741040 }), null, 'a handle alone names no lens');
  assert.equal(lensProfileKey(null), null);
}

// ---- Resolving a saved profile in the running lensfun build
// (findLensHandle, lensHandleFor) ----
{
  // A stand-in database searched the way lensfun searches: an exact model
  // (unless its name parses to other focal lengths: `unparsable`), or words
  // without digits; a camera narrows to its mount.
  const searchClient = entries => {
    const searches = [];
    const words = text => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return {
      searches,
      searchLenses({ lensMaker, lensModel, cameraModel, searchFlags }) {
        searches.push({ lensMaker, lensModel, cameraModel: cameraModel || null, searchFlags });
        return entries.filter(entry => (!lensMaker || entry.maker === lensMaker)
          && (lensModel === entry.model ? !entry.unparsable : (!/\d/.test(lensModel) && words(lensModel).every(word => words(entry.model).includes(word))))
          && (!entry.needsCamera || cameraModel) && (!cameraModel || !entry.mounts || entry.mounts.includes(cameraModel)))
          .map(({ unparsable, needsCamera, mounts, ...lens }) => ({ score: 50, ...lens }));
      }
    };
  };
  const ranges = { minFocal: 24, maxFocal: 105, minAperture: 4, maxAperture: 22 };
  const entries = [
    { handle: 20, maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', cropFactor: 1.611, ...ranges },
    { handle: 10, maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', cropFactor: 1, ...ranges },
    { handle: 30, maker: 'Sony', model: 'FE 28mm f/2 + Sony SEL075 UWC', cropFactor: 1, minFocal: 21, maxFocal: 21, minAperture: 2.8, maxAperture: 0, unparsable: true },
    { handle: 41, maker: 'Canon', model: 'fixed lens', cropFactor: 6, minFocal: 6, maxFocal: 72, minAperture: 0, maxAperture: 0, mounts: ['Canon PowerShot S5 IS'] },
    { handle: 40, maker: 'Canon', model: 'fixed lens', cropFactor: 6, minFocal: 6, maxFocal: 72, minAperture: 0, maxAperture: 0, mounts: ['Canon PowerShot S2 IS'] },
    { handle: 50, maker: 'Mamiya', model: '35mm f/22.0-3.5', cropFactor: 0.644, minFocal: 35, maxFocal: 35, minAperture: 3.5, maxAperture: 22, unparsable: true, needsCamera: true }
  ];
  const client = searchClient(entries);
  const profile = (handle, extra = {}) => {
    const { unparsable, needsCamera, mounts, ...lens } = entries.find(entry => entry.handle === handle);
    return { ...lens, handle: 999, ...extra };
  };
  assert.equal(findLensHandle(client, profile(10)), 10, 'the exact model, the calibration of its crop factor');
  assert.equal(findLensHandle(client, profile(20)), 20, 'the other calibration of that name');
  assert.equal(findLensHandle(client, profile(10, { cropFactor: 1.05 })), 10, 'the nearest calibration crop factor');
  assert.equal(findLensHandle(client, profile(30)), 30, 'a name lensfun rules out by its own focal length: found by its words without digits');
  assert.equal(client.searches.at(-1).lensModel, 'FE mm f Sony SEL UWC', 'the words lensfun compares, without digits');
  assert.equal(findLensHandle(client, profile(40)), 40, 'twins that only the mount tells apart: the lowest handle (lensfun\'s database order)');
  assert.equal(findLensHandle(client, profile(41, { camera: { maker: 'Canon', model: 'Canon PowerShot S5 IS' } })), 41, 'the camera it was found with tells them apart');
  assert.equal(findLensHandle(client, profile(50)), null, 'a lens found only with a camera, saved without one');
  assert.equal(findLensHandle(client, profile(50, { camera: { maker: 'Mamiya', model: 'Mamiya ZD' } })), 50, 'with its camera');
  assert.equal(findLensHandle(client, { ...profile(10), model: 'Canon EF 24-105mm f/4L IS USM II' }), null, 'a lens this database does not have');
  assert.equal(findLensHandle(client, { handle: 10 }), null, 'a handle alone');
  assert.equal(findLensHandle({ searchLenses() { throw new Error('[lensfun-wasm] LensfunClient is disposed'); } }, profile(10)), null, 'a search that throws');
  assert.ok(client.searches.every(search => search.searchFlags === 0), 'every entry of a name: neither loose nor uniquified');

  // Once per profile and client; a profile the build lacks is not searched again.
  const counted = searchClient(entries);
  assert.equal(lensHandleFor(counted, profile(10)), 10);
  assert.equal(lensHandleFor(counted, profile(10, { handle: 4 })), 10, 'any saved handle: the same profile');
  const missing = { ...profile(10), model: 'Canon EF 24-105mm f/4L IS USM II' };
  assert.equal(lensHandleFor(counted, missing), null);
  const searched = counted.searches.length;
  assert.equal(lensHandleFor(counted, missing), null);
  assert.equal(lensHandleFor(counted, profile(10)), 10);
  assert.equal(counted.searches.length, searched, 'resolved once');
  // The handle of the search a profile was chosen from.
  const primed = searchClient(entries);
  rememberLensHandle(primed, profile(41), 41);
  assert.equal(lensHandleFor(primed, profile(41)), 41, 'the entry chosen, not its twin');
  assert.equal(primed.searches.length, 0, 'without a search');
  assert.equal(lensHandleFor(searchClient(entries), profile(41)), 40, 'another client resolves on its own');
}

console.log(`lensMaps: the remap equals main.js's of before (${cases} cases), the map requests too, ${bands} bands equal the rows of the whole remap, ${inPlaceCases} in-place remaps (lenses without distortion calibration), buildLensMaps builds distortion, TCA (with the distortion) and vignetting where the lens has them, on grids that cover the frame (${coverCases} cases; ${coverResults.join('; ')}), and saved profiles resolve by their identity`);
