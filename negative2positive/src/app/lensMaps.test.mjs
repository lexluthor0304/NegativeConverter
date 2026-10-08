// Lens correction's remap (#278) moved out of main.js into lensMaps.js, so
// the display-proxy fills can run it on row bands in the geometry pool. The
// whole-image remap and the maps lensfun is asked for are byte-identical to
// main.js's before the move (its code is kept below as the reference), and
// a band of rows remapped from only the input rows lensSourceRows names and
// the grid rows sliceLensMaps keeps is those rows of the whole remap.
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
  applyLensMapsToImage, applyLensMapRows, lensMapRequest, lensMapStep, lensRowExtents, lensSourceRows, sliceLensMaps, lensMapBuffers
} = await import('./lensMaps.js');
const { allocPlane16, isSharedPlane, sharedPlanesAvailable } = await import('./crossOriginIsolation.js');
const { lensTestMaps } = await import('./lensTestMaps.mjs');

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
const MAPS = [
  ['lensfun-like', {}], ['strong', { strength: 0.3 }], ['outward', { strength: -0.08 }],
  ['below the frame', { shift: 1e4 }], ['poisoned', { poison: true }]
];

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

// ---- The maps lensfun is asked for, and their cache key, are as before ----
{
  const lens = (params, modes = MODES[0]) => ({
    enabled: true, selectedLens: { handle: 2741040, maker: 'Nikon', model: 'Nikkor AF-S 18-55mm f/3.5-5.6G DX VR' },
    params: { focal: 18, crop: 1.528, aperture: 5.6, distance: 1000, stepMode: 'auto', step: 2, ...params }, modes
  });
  for (const [width, height] of [[1499, 900], [1500, 1000], [2400, 1600], [3599, 2400], [3600, 2400], [5199, 3466], [5200, 3466], [9000, 6000]]) {
    for (const params of [{}, { stepMode: 'manual', step: 5 }, { stepMode: 'manual', step: 0 }, { stepMode: 'manual', step: 40 }, { focal: 55.123456, aperture: 22 }]) {
      for (const modes of MODES) {
        const block = lens(params, modes);
        assert.deepEqual(lensMapRequest(block, width, height), pre278Request(block, width, height), `request ${width}x${height} ${JSON.stringify(params)}`);
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
    for (const [mapLabel, options] of MAPS) {
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

console.log(`lensMaps: the remap equals main.js's of before (${cases} cases), the map requests too, and ${bands} bands equal the rows of the whole remap`);
