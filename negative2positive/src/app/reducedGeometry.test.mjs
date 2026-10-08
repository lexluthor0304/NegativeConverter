// Standalone Node test for reducedGeometry.js (#247) - run with:
// node negative2positive/src/app/reducedGeometry.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const {
  applyRotationToImageData, mirrorImageDataHorizontal, applyGeometryChainToImageData, sanitizeCropRect, geometryCounters
} = await import('./imageGeometry.js');
const { cropImageDataRegion, downsampleImageDataForMaxDim } = await import('./imageDataOps.js');
const { createStudioThumbnail } = await import('./studioSettings.js');
const {
  buildReducedGeometrySample, reducedTileGeometry, renderReducedGeometry, tileGeometryKey
} = await import('./reducedGeometry.js');
const { halfDecodeFullSize } = await import('./imageDimensions.js');

function makeBase(width, height, seed = 5) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { data16[i + c] = rnd() % 65536; data8[i + c] = data16[i + c] >>> 8; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}
const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function assertSame(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit pixels`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane present`);
  if (expected.__image16) assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit pixels`);
}

// HEAD's buildRollAnalysisSample (main.js at 7d61dec), kept here as the
// reference: roll samples feed recipes and so exports, so they must not move.
function headSanitizeCropRegionForImage(cropRegion, imageData) { return sanitizeCropRect(cropRegion, imageData); }
function headCropImageData(imageData, cropRegion) {
  const sanitized = headSanitizeCropRegionForImage(cropRegion, imageData);
  if (!sanitized) return imageData;
  return cropImageDataRegion(imageData, sanitized);
}
function headBuildRollAnalysisSample(imageData, settings) {
  const reduced = downsampleImageDataForMaxDim(imageData, 900);
  const factor = reduced.width / imageData.width;
  let working = reduced;
  const angle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
  if (Math.abs(angle) > 0.001) working = applyRotationToImageData(working, angle);
  if (settings.mirrored) working = mirrorImageDataHorizontal(working);
  if (settings.cropRegion) {
    const scaled = {
      left: (settings.cropRegion.left ?? settings.cropRegion.x ?? 0) * factor,
      top: (settings.cropRegion.top ?? settings.cropRegion.y ?? 0) * factor,
      width: settings.cropRegion.width * factor,
      height: settings.cropRegion.height * factor
    };
    const region = headSanitizeCropRegionForImage(scaled, working);
    if (region) working = headCropImageData(working, region);
  }
  return working;
}

// The app's buildRollAnalysisSample, as main.js defines it.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}
const { sampleAnalysisArea } = await import('./analysisRegion.js');
const { TILE_ANALYSIS_REFERENCE_PIXELS } = await import('./thumbnailSources.js');
// main.js delegates to rollSample.js, which the roll-frame worker shares (#252).
const rollSample = await import('./rollSample.js');
const app = vm.createContext({ buildReducedGeometrySample, sampleAnalysisArea, TILE_ANALYSIS_REFERENCE_PIXELS, reducedTileGeometry,
  renderReducedGeometry, sanitizeCropRegionForImage: sanitizeCropRect, STUDIO_TILE_PREVIEW_MAX: 288,
  buildRollAnalysisSampleOf: rollSample.buildRollAnalysisSample, buildRollSampleOf: rollSample.buildRollSample });
vm.runInContext(['buildRollAnalysisSample', 'buildRollSample', 'tileAnalysisReference'].map(functionSource).join('\n'), app);

const recipes = [
  {},
  { rotationAngle: 0.0005 },
  { rotationAngle: 0.3, cropRegion: { left: 90, top: 60, width: 1500, height: 1000 } },
  { rotationAngle: -2.7, mirrored: true, cropRegion: { left: 40, top: 20, width: 1700, height: 1100 } },
  { rotationAngle: 90, cropRegion: { x: 10, y: 30, width: 1000, height: 1500 } },
  { rotationAngle: 180, mirrored: true },
  { rotationAngle: -90, mirrored: true, cropRegion: { left: 5, top: 5, width: 800, height: 1400 } },
  { mirrored: true, cropRegion: { left: 1900, top: 1300, width: 900, height: 900 } },
  { cropRegion: { left: 0, top: 0, width: 0, height: 10 } }
];

// Roll samples stay byte-identical to HEAD, 8 and 16 bits, at and below 900 px.
for (const [width, height] of [[1980, 1320], [1320, 1980], [640, 427]]) {
  const base = makeBase(width, height, width + height);
  for (const recipe of recipes) {
    const expected = headBuildRollAnalysisSample(base, recipe);
    assertSame(app.buildRollAnalysisSample(base, recipe), expected, `roll sample ${width}x${height} ${JSON.stringify(recipe)}`);
    assertSame(buildReducedGeometrySample(base, recipe, { maxDim: 900 }), expected, `maxDim 900 ${JSON.stringify(recipe)}`);
  }
}

// A roll sample keeps its pixels and carries its tile context (#247 2b): the
// base size, a 16-bit analysis reference of at most 16384 pixels and the
// lane's own reduced working image of the frame. A sample that is the base
// itself is wrapped: the base gains no fields.
{
  const area = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
  for (const [width, height] of [[1980, 1320], [640, 427], [200, 150]]) {
    const base = makeBase(width, height, 77);
    for (const geometry of [{}, { rotationAngle: 0.6, mirrored: true, cropRegion: { left: 20, top: 10, width: width - 60, height: height - 40 } }]) {
      const settings = { autoFrameMeta: { imageArea: area }, ...geometry };
      const sample = app.buildRollSample(base, settings);
      assertSame(sample, headBuildRollAnalysisSample(base, settings), `sample pixels ${width}x${height}`);
      assert.deepEqual([sample.__baseSize.width, sample.__baseSize.height], [width, height]);
      const reference = sample.__analysisReference;
      assert.ok(reference.data instanceof Uint16Array && reference.width * reference.height <= 16384);
      assert.deepEqual(reference.data, sampleAnalysisArea(base, area, 16384).data);
      const full = applyGeometryChainToImageData(base, { rotationAngle: geometry.rotationAngle || 0, mirrored: Boolean(geometry.mirrored), cropRegion: geometry.cropRegion || null }, {
        rotate: applyRotationToImageData, mirror: mirrorImageDataHorizontal,
        crop: (image, cropRegion, bounds = image) => { const rect = sanitizeCropRect(cropRegion, bounds); if (!image) return rect; return rect ? cropImageDataRegion(image, rect) : image; }
      });
      assertSame(sample.__tileWorking, downsampleImageDataForMaxDim(full, 288), `tile working image ${width}x${height} is the lane's`);
      assert.equal(base.__baseSize, undefined, 'the base is never annotated');
      assert.equal(base.__tileWorking, undefined);
    }
    assert.equal(app.buildRollSample(base, {}).__analysisReference, null, 'no area, no reference');
  }
}

// #252 part 6 (flagged): a roll sample from a half-size decode, for the full
// frame its recipe refers to; with the base's own size it is the usual sample.
{
  const half = makeBase(990, 660, 91);
  const full = { width: 1980, height: 1320 };
  const settings = { rotationAngle: 0.6, mirrored: true, cropRegion: { left: 40, top: 20, width: 1800, height: 1200 },
    autoFrameMeta: { imageArea: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] } };
  const sample = rollSample.buildRollSample(half, settings, { tileMax: 288, fullSize: full });
  assertSame(sample, buildReducedGeometrySample(half, settings, { maxDim: 900, fullWidth: full.width }), 'half-size sample');
  assert.deepEqual(sample.__baseSize, full);
  const frame = reducedTileGeometry(full, settings, 288, { sanitizeCrop: sanitizeCropRect });
  assertSame(sample.__tileWorking, renderReducedGeometry(half, settings, { step: frame.step, fullWidth: full.width, fullHeight: full.height }), 'half-size tile');
  assertSame(rollSample.buildRollSample(half, settings, { tileMax: 288, fullSize: { width: 990, height: 660 } }),
    rollSample.buildRollSample(half, settings, { tileMax: 288 }), 'a full size equal to the base changes nothing');
}

// The export chain's crop step, as main.js's exportGeometrySteps.
const exportSteps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? cropImageDataRegion(image, rect) : image;
  }
};

// A full-size tile: exactly HEAD's lane (full-resolution chain, then the
// preview downsample), from a strided plan that reads the output pixels only.
for (const [width, height] of [[1980, 1320], [1320, 1980]]) {
  const base = makeBase(width, height, 11);
  for (const recipe of recipes) {
    const geometry = { rotationAngle: recipe.rotationAngle || 0, mirrored: Boolean(recipe.mirrored), cropRegion: recipe.cropRegion || null };
    const full = applyGeometryChainToImageData(base, geometry, exportSteps);
    for (const maxDim of [288, 144, 5000]) {
      const expected = downsampleImageDataForMaxDim(full, maxDim);
      const frame = reducedTileGeometry(base, geometry, maxDim);
      assert.deepEqual([frame.width, frame.height], [full.width, full.height], 'analytic post-geometry size');
      const rotationsBefore = geometryCounters.rotations;
      const tile = renderReducedGeometry(base, geometry, { step: frame.step });
      assertSame(tile, expected, `tile ${width}x${height} ${JSON.stringify(recipe)} max ${maxDim}`);
      if (frame.step > 1) assert.equal(geometryCounters.rotations, rotationsBefore, 'no full-resolution rotation for a reduced tile');
    }
  }
}

// A half-size decode: the crop scales by the real ratio to the full size,
// and the tile lands within a few pixels of the full-size tile.
{
  const full = makeBase(1600, 1066, 21);
  const half = downsampleImageDataForMaxDim(full, 800);
  assert.deepEqual([half.width, half.height], [800, 533]);
  // (The export chain reads left/top only, as sanitised recipes carry them.)
  for (const recipe of [...recipes.slice(2, 4), recipes[6], recipes[7]]) {
    const geometry = { rotationAngle: recipe.rotationAngle || 0, mirrored: Boolean(recipe.mirrored), cropRegion: recipe.cropRegion || null };
    const size = { width: 1600, height: 1066 };
    const frame = reducedTileGeometry(size, geometry, 288);
    const expected = renderReducedGeometry(full, geometry, { step: frame.step });
    const tile = renderReducedGeometry(half, geometry, { step: frame.step, fullWidth: size.width, fullHeight: size.height });
    // Steps come in whole half-size pixels, so the working image may be a
    // step smaller; the 144 px tile it becomes keeps HEAD's size within 1 px.
    const final = image => createStudioThumbnail(image, 144);
    assert.ok(Math.abs(final(tile).width - final(expected).width) <= 1 && Math.abs(final(tile).height - final(expected).height) <= 1,
      `half-size tile ${tile.width}x${tile.height} against ${expected.width}x${expected.height}`);
    assert.ok(Math.max(tile.width, tile.height) <= 288);
  }
}

// Output-bound cost: a 12 MP base with a 0.75° straighten and an 85 % crop
// renders its 288 px tile in milliseconds (HEAD built the whole rotated frame).
{
  const width = 4240, height = 2832;
  const base = makeBase(width, height, 3);
  const geometry = { rotationAngle: 0.75, mirrored: false, cropRegion: { left: 318, top: 212, width: 3604, height: 2407 } };
  const frame = reducedTileGeometry(base, geometry, 288);
  renderReducedGeometry(base, geometry, { step: frame.step });
  const started = performance.now();
  for (let i = 0; i < 5; i++) renderReducedGeometry(base, geometry, { step: frame.step });
  const ms = (performance.now() - started) / 5;
  console.log(`reducedGeometry: 12 MP, 0.75°, 85 % crop -> ${frame.width}x${frame.height} / ${frame.step}: ${ms.toFixed(2)} ms per tile`);
  assert.ok(ms < 100, `tile geometry takes ${ms} ms`);
}

// Tile-source keys follow geometry, base and analysis area, nothing else.
{
  const settings = { rotationAngle: 0.4, mirrored: false, cropRegion: { left: 1, top: 2, width: 30, height: 20 },
    autoFrameMeta: { imageArea: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, coreExposure: 3 };
  const key = tileGeometryKey(settings, { width: 40, height: 30 });
  assert.equal(tileGeometryKey({ ...settings, coreExposure: 9, filmType: 'bw' }, { width: 40, height: 30 }), key);
  for (const changed of [{ rotationAngle: 0.5 }, { mirrored: true }, { cropRegion: { ...settings.cropRegion, left: 2 } }, { cropRegion: null },
    { autoFrameMeta: { imageArea: null, analysisArea: settings.autoFrameMeta.imageArea.slice(1) } }]) {
    assert.notEqual(tileGeometryKey({ ...settings, ...changed }, { width: 40, height: 30 }), key, JSON.stringify(changed));
  }
  assert.notEqual(tileGeometryKey(settings, { width: 41, height: 30 }), key);
}

// The full size behind a half-size LibRaw decode.
assert.deepEqual(halfDecodeFullSize(4768, 3168, 9536, 6336), { width: 9536, height: 6336 });
assert.deepEqual(halfDecodeFullSize(3168, 4768, 9536, 6336), { width: 6336, height: 9536 }, 'oriented metadata the other way round');
assert.deepEqual(halfDecodeFullSize(2001, 1336, 4001, 2671), { width: 4001, height: 2671 }, 'odd sides round up');
assert.deepEqual(halfDecodeFullSize(100, 50, 0, 0), { width: 100, height: 50 }, 'no evidence of shrinking');
assert.deepEqual(halfDecodeFullSize(100, 50, 640, 480), { width: 100, height: 50 }, 'a report of another size cannot prove shrinking');

console.log('reducedGeometry tests passed');
