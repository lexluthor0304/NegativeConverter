// What a lane-prepared recipe is measured on (#229 review, R1-081). The
// light-table lane's first render of a frame without a recipe prepares the
// recipe it stores (gray point, expired-rescue measurement), and exports
// reuse it. 1703835 built that tile with the full-resolution chain and the
// preview downsample; #247's reduced tile decimates first wherever the
// geometry core cannot plan the chain (an 8-bit source at a non-right
// angle), so a recipe-preparing render keeps 1703835's order there. Renders
// with a saved recipe only show it and keep the reduced path.
// Run with: node negative2positive/src/app/laneRecipeInputs.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
globalThis.ImageData = TestImageData;

// A deterministic stand-in for the 2D canvas that rotates 8-bit frames by a
// non-right angle (imageGeometry's applyRotationToImageData): nearest
// sampling through the inverse of translate/rotate. It is not Chrome's
// filter, but the old and the new order both go through it.
class FakeContext2D {
  constructor(canvas) { this.canvas = canvas; this.matrix = [1, 0, 0, 1, 0, 0]; }
  transform([a2, b2, c2, d2, e2, f2]) {
    const [a, b, c, d, e, f] = this.matrix;
    this.matrix = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  }
  translate(x, y) { this.transform([1, 0, 0, 1, x, y]); }
  rotate(rad) { const cos = Math.cos(rad), sin = Math.sin(rad); this.transform([cos, sin, -sin, cos, 0, 0]); }
  putImageData(image, dx, dy) {
    const { width, pixels } = this.canvas;
    for (let y = 0; y < image.height; y++) {
      pixels.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + dy) * width + dx) * 4);
    }
  }
  drawImage(source, dx, dy) {
    const [a, b, c, d, e, f] = this.matrix;
    const det = a * d - b * c;
    const { width, height, pixels } = this.canvas;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const px = x + 0.5 - e, py = y + 0.5 - f;
      const u = Math.floor((d * px - c * py) / det - dx);
      const v = Math.floor((-b * px + a * py) / det - dy);
      if (u < 0 || v < 0 || u >= source.width || v >= source.height) continue;
      const from = (v * source.width + u) * 4, to = (y * width + x) * 4;
      for (let i = 0; i < 4; i++) pixels[to + i] = source.pixels[from + i];
    }
  }
  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      out.set(this.canvas.pixels.subarray(((row + y) * this.canvas.width + x) * 4, ((row + y) * this.canvas.width + x + w) * 4), row * w * 4);
    }
    return new TestImageData(out, w, h);
  }
}
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.w = width; this.h = height; this.pixels = new Uint8ClampedArray(width * height * 4); }
  get width() { return this.w; }
  set width(value) { this.w = value; this.pixels = new Uint8ClampedArray(this.w * this.h * 4); }
  get height() { return this.h; }
  set height(value) { this.h = value; this.pixels = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext() { return new FakeContext2D(this); }
};

const { applyGeometryChainToImageData, applyRotationToImageData, mirrorImageDataHorizontal, planGeometry, renderGeometry,
  sanitizeCropRect } = await import('./imageGeometry.js');
const { cropImageDataRegion, downsampleImageDataForMaxDim } = await import('./imageDataOps.js');
const { reducedTileGeometry, renderReducedGeometry, reducedGeometryExact, tileGeometryKey } = await import('./reducedGeometry.js');
const { markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers } = await import('./planeRelease.js');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}

const digest = image => createHash('sha256').update(`${image.width}x${image.height}:`).update(image.data).digest('hex').slice(0, 16);
const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function assertSame(actual, expected, label) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${label}: size`);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit pixels`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane`);
  if (expected.__image16) assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit pixels`);
}

function makeBase(width, height, { sixteen = false, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data8 = new Uint8ClampedArray(width * height * 4);
  const data16 = sixteen ? new Uint16Array(width * height * 4) : null;
  for (let i = 0; i < data8.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const value = rnd() % 65536;
      data8[i + c] = value >>> 8;
      if (data16) data16[i + c] = value;
    }
    data8[i + 3] = 255;
    if (data16) data16[i + 3] = 65535;
  }
  const image = new TestImageData(data8, width, height);
  if (data16) image.__image16 = { width, height, data: data16 };
  return image;
}

// main.js's exportGeometrySteps.
const exportGeometrySteps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? cropImageDataRegion(image, rect) : image;
  }
};

// 1703835's lane tile (processFileWithSettings with previewMaxDimension, no
// active lens): the full-resolution chain, then the preview downsample.
const tile1703835 = (base, geometry, maxDim = 288) => downsampleImageDataForMaxDim(applyGeometryChainToImageData(base, geometry, exportGeometrySteps), maxDim);

const runtime = ['processFileWithSettings', 'renderPreviewFromWorkingImage', 'renderGeometryChain', 'removeFrameDust',
  'frameWantsAutoWhiteBalance', 'applyFrameAutoWhiteBalance', 'applyFrameExpiredAnalysis', 'tileAnalysisReference',
  'resolveLensCorrection', 'lensCorrectionActive', 'tileRecipeSettled', 'perPhotoSettingsFallback', 'expiredImportKeepsFullFrame']
  .map(functionSource).join('\n');
const noop = () => {};

// `frame` is what auto-frame decides for a frame without a recipe.
function fixture(base, { frame, expired = true } = {}) {
  const file = { name: 'frame.jpg', size: base.data.byteLength };
  const item = { file, settings: null };
  const calls = { chains: 0, reduced: 0, conversions: [], expired: [], whiteBalance: [], detections: 0 };
  const context = vm.createContext({
    state: { fileQueue: [item], dustRemoval: { enabled: false }, autoFrame: { enabled: true }, importFilmTypeAuto: true, exportFormat: 'png' },
    console: { warn: noop, info: noop, error: noop },
    createPerfTrace: () => ({ mark: noop, end: noop }),
    getImageDataPixelCount: image => image.width * image.height,
    loadFileToImageData: async () => { throw new Error('the lane hands its base over'); },
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw new DOMException('stale', 'AbortError'); },
    markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers,
    // A new frame: defaults, then auto-frame's straighten and crop.
    pendingGeometryEdits: () => null, withPendingEdits: (_item, settings) => settings,
    createDefaultSettings: () => ({ filmType: 'color', expiredEnabled: expired, wbR: 1, wbG: 1, wbB: 1,
      rotationAngle: 0, mirrored: false, cropRegion: null, autoFrameMeta: null, filmEdge: null,
      lensCorrection: { enabled: false }, repairStrokes: [] }),
    mergeStudioColors: (settings, colors) => ({ ...settings, ...colors }),
    runImportDetections: async image => { calls.detections++; return { image, detection: { result: frame }, read: null }; },
    analyzeStudioImportFrame: async (_image, settings) => ({ ...settings, ...frame, autoFrameMeta: { method: 'test' } }),
    mergeImportFilmEdge: async (_image, settings) => ({ settings: { ...settings, filmEdge: { checked: true } } }),
    learnedImportSettings: async settings => settings,
    settleImportFilmType: (_item, settings) => settings,
    sanitizeSettings: settings => structuredClone(settings),
    // The geometry core and pool: the real planner and renderer.
    planGeometry, applyGeometryChainToImageData, exportGeometrySteps, sanitizeCropRegionForImage: sanitizeCropRect,
    geometryPool: { render: async (image, plan) => renderGeometry(image, plan) },
    interactiveGeometryBands: () => 1,
    reducedTileGeometry, tileGeometryKey,
    reducedGeometryExact,
    renderReducedGeometry: (...args) => { calls.reduced++; return renderReducedGeometry(...args); },
    applyLensCorrectionWithSettings: async image => image,
    downsampleImageDataForMaxDim,
    sampleAnalysisArea: () => null, TILE_ANALYSIS_REFERENCE_PIXELS: 16384,
    buildRouterSettings: settings => settings,
    getColorAnalysisSample: () => null,
    // The conversion hands its input back, so what the measurements read is
    // the tile's working image.
    convertFrameOffMainThread: async request => { calls.conversions.push(request); return request.imageData; },
    usesSilverCoreConversion: () => true,
    sanitizePresetType: type => type || 'color',
    resolveAnalysisRegion: () => null,
    analysisRegionSample: image => image,
    estimateAutoWhiteBalance: image => { calls.whiteBalance.push(digest(image)); return { wbR: 1.1, wbG: 1, wbB: 0.9, confidence: 'high' }; },
    measureExpiredAnalysisForExport: async processed => { calls.expired.push(digest(processed)); return { measuredOn: digest(processed) }; },
    applyExpiredAnalysisDefaults: (settings, analysis) => { settings.expiredAnalysis = analysis; },
    buildAdjustmentSettings: settings => settings,
    createAdjustedPhotoPreview: image => image,
    withAiRepairTurn: work => work(),
    cloneSettings: settings => structuredClone(settings)
  });
  vm.runInContext(runtime, context);
  const chain = context.renderGeometryChain;
  context.renderGeometryChain = (...args) => { calls.chains++; return chain(...args); };
  // The lane's render (beginLaneTile.run): the shared base, tile size, the
  // recipe it prepares and the working image it offers as the tile source.
  const render = async recipe => {
    let prepared = null;
    let tileSource = null;
    await context.processFileWithSettings(file, recipe, {
      previewMaxDimension: 288, updateItemSettings: false, sourceImageData: base,
      onPreparedSettings: settings => { prepared = settings; }, onTileSource: entry => { tileSource = entry; }
    });
    return { prepared, tileSource, working: calls.conversions.at(-1).imageData };
  };
  return { context, calls, render, item };
}

const tilted = { rotationAngle: 1.4, cropRegion: { left: 60, top: 40, width: 820, height: 540 } };

// R1-081: an 8-bit frame that auto-frame straightens by a non-right angle.
// Without a recipe the lane's render prepares one: the full chain, then the
// downsample, so its measurements read 1703835's tile exactly. With the
// recipe saved, the next render only shows it and keeps the reduced path.
{
  const base = makeBase(960, 640);
  const geometry = { ...tilted, mirrored: false };
  const expected = tile1703835(base, geometry);
  assert.equal(planGeometry(base, geometry), null, 'the geometry core cannot plan an 8-bit non-right angle');
  assert.equal(reducedGeometryExact(base, geometry), false);

  const f = fixture(base, { frame: tilted });
  const first = await f.render(null);
  assert.equal(f.calls.detections, 1, 'auto-frame decided the geometry');
  assert.equal(f.calls.chains, 1, 'a recipe-preparing render takes the full chain');
  assert.equal(f.calls.reduced, 0, 'and not the reduced tile');
  assertSame(first.working, expected, 'recipe-preparing tile = 1703835 tile');
  assert.deepEqual(f.calls.expired, [digest(expected)], 'the expired rescue is measured on 1703835\'s tile');
  assert.deepEqual(first.prepared.expiredAnalysis, { measuredOn: digest(expected) });
  assert.equal(first.prepared.rotationAngle, 1.4);
  assert.equal(first.tileSource.working, first.working, 'its working image is still the tile source');
  assert.equal(first.tileSource.geometryKey, tileGeometryKey(first.prepared, base));
  assert.equal(f.item.settings, null, 'the lane stores the recipe, not the render');

  const second = await f.render(structuredClone(first.prepared));
  assert.equal(f.calls.chains, 1, 'a render with a saved recipe builds no full-resolution frame');
  assert.equal(f.calls.reduced, 1, 'it keeps the reduced path');
  const step = reducedTileGeometry(base, geometry, 288, { sanitizeCrop: sanitizeCropRect }).step;
  assertSame(second.working, renderReducedGeometry(base, geometry, { step }), 'saved-recipe tile = reduced tile');
  assert.notEqual(digest(second.working), digest(expected), 'the reduced tile is not 1703835\'s (why it may only be shown)');
  assert.equal(f.calls.expired.length, 1, 'a saved measurement is not taken again');

  // The automatic gray point of a colour frame reads the same tile.
  const colour = fixture(base, { frame: tilted, expired: false });
  const prepared = (await colour.render(null)).prepared;
  assert.equal(colour.calls.chains, 1);
  assert.deepEqual(colour.calls.whiteBalance, [digest(expected)], 'the gray point is measured on 1703835\'s tile');
  assert.deepEqual([prepared.wbR, prepared.wbB, prepared.wbAutoConfidence], [1.1, 0.9, 'high']);
}

// Where the reduced tile is exactly the chain's (the geometry core's strided
// plan on a full-size base: a 16-bit base at any angle, an 8-bit base at a
// right angle or unrotated), a recipe-preparing render keeps the reduced path
// and still measures 1703835's tile.
for (const [label, base, frame] of [
  ['16-bit, tilted', makeBase(960, 640, { sixteen: true, seed: 3 }), tilted],
  ['16-bit, tilted and mirrored', makeBase(960, 640, { sixteen: true, seed: 4 }), { ...tilted, rotationAngle: -2.7, mirrored: true }],
  ['8-bit, right angle', makeBase(960, 640, { seed: 5 }), { rotationAngle: 90, cropRegion: { left: 30, top: 50, width: 560, height: 860 } }],
  ['8-bit, crop only', makeBase(960, 640, { seed: 6 }), { rotationAngle: 0, cropRegion: { left: 61, top: 37, width: 777, height: 555 } }]
]) {
  const geometry = { rotationAngle: frame.rotationAngle, mirrored: Boolean(frame.mirrored), cropRegion: frame.cropRegion };
  const expected = tile1703835(base, geometry);
  assert.equal(reducedGeometryExact(base, geometry), true, `${label}: exact`);
  const f = fixture(base, { frame });
  const { working, prepared } = await f.render(null);
  assert.equal(f.calls.chains, 0, `${label}: no full-resolution frame`);
  assert.equal(f.calls.reduced, 1, `${label}: the reduced tile`);
  assertSame(working, expected, `${label}: reduced tile = 1703835 tile`);
  assert.deepEqual(prepared.expiredAnalysis, { measuredOn: digest(expected) }, `${label}: measured on 1703835's tile`);
}

// What is exact: the strided plan on the base the recipe refers to. A
// half-size decode (its recipe's frame is twice its size) and a 16-bit plane
// that is not the base's exact companion are decimated first too.
{
  const sixteen = makeBase(400, 300, { sixteen: true });
  const eight = makeBase(400, 300);
  assert.equal(reducedGeometryExact(sixteen, { rotationAngle: 0.6 }), true);
  assert.equal(reducedGeometryExact(sixteen, { rotationAngle: 0.6 }, { fullWidth: 800, fullHeight: 600 }), false, 'half-size decode');
  assert.equal(reducedGeometryExact(eight, { rotationAngle: 0.6 }), false, '8-bit, non-right angle');
  assert.equal(reducedGeometryExact(eight, { rotationAngle: -90, mirrored: true }), true, '8-bit, right angle');
  const loose = makeBase(400, 300);
  loose.__image16 = { width: 200, height: 150, data: new Uint16Array(200 * 150 * 4) };
  assert.equal(reducedGeometryExact(loose, {}), false, 'a 16-bit plane of another size');
}

console.log('laneRecipeInputs: recipe-preparing lane renders measure 1703835\'s tile; saved-recipe renders keep the reduced path');
