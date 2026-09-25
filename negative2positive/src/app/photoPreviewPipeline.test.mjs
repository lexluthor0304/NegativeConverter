import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { downsampleImageDataForMaxDim } from './imageDataOps.js';
import { createAdjustedPhotoPreview } from './photoPreview.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';
import { markOwnedPlanes, planeBuffersOf } from './planeRelease.js';
import { reducedTileGeometry, renderReducedGeometry, tileGeometryKey } from './reducedGeometry.js';
import { sanitizeCropRect, normalizeAngleDegrees, rotatedDimensions } from './imageGeometry.js';

// Execute the real orchestration with actual downsampling/final adjustments.
// Only expensive conversion, Lensfun and AI operations are substituted. Their
// argument records pin the coordinate space, precision and call ordering.
class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
globalThis.ImageData = TestImageData;
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
// processFileWithSettings and the tile helpers it shares with the lane and
// roll tiles (#247); everything else is a stub below.
const runtime = ['processFileWithSettings', 'renderPreviewFromWorkingImage', 'removeFrameDust', 'frameWantsAutoWhiteBalance',
  'applyFrameAutoWhiteBalance', 'applyFrameExpiredAnalysis', 'tileAnalysisReference', 'resolveLensCorrection',
  'lensCorrectionActive', 'tileRecipeSettled', 'perPhotoSettingsFallback', 'expiredImportKeepsFullFrame']
  .map(functionSource).join('\n');
const noop = () => {};
const identity = Uint8Array.from({ length: 256 }, (_, value) => value);

function fixture({ lens = false, brush = false, dust = false, width = 600, height = 400, geometry = {}, settled = true } = {}) {
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < plane.length; i += 4) {
    plane[i] = 0x1234; plane[i + 1] = 0x5678; plane[i + 2] = 0x9abc; plane[i + 3] = 65535;
  }
  const image = new TestImageData(Uint8ClampedArray.from(plane, value => value >>> 8), width, height);
  image.__image16 = { width, height, data: plane };
  const mapping = { maps: { gridWidth: 2, gridHeight: 2, step: width,
    geometry: new Float32Array([0, 0, width, 0, 0, height, width, height]) }, includeTca: false };
  const corrected = new TestImageData(image.data, width, height);
  corrected.__image16 = image.__image16;
  if (lens) Object.defineProperty(corrected, '__lensMapping', { value: mapping });
  const file = { name: 'fixture.png', size: image.data.byteLength };
  // A selected lens is what makes lens correction active (#247): only then
  // does a frame keep the native path.
  const settings = {
    filmType: 'color', autoFrameMeta: settled ? {} : null, filmEdge: { checked: settled },
    rotationAngle: 0, mirrored: false, cropRegion: null, ...geometry,
    lensCorrection: { enabled: lens, selectedLens: lens ? { handle: 7 } : null },
    repairStrokes: brush ? [{ size: 0.02, points: [{ x: 0.25, y: 0.5 }] }] : [],
    curves: { r: identity, g: identity, b: identity }
  };
  const calls = { conversions: [], dust: [], brushes: [], adjustments: [], previews: [], downsample: [], decoded: 0,
    loads: [], geometry: 0, lens: 0 };
  const context = vm.createContext({
    // A photo left inside a two-stage window (#255): none here.
    pendingGeometryEdits: () => null, withPendingEdits: (item, settings) => settings,
    state: { fileQueue: [{ file, settings }], dustRemoval: { enabled: dust, strength: 3, maxParticleSize: 40 }, exportFormat: 'png',
      autoFrame: { enabled: true } },
    createPerfTrace: () => ({ mark: noop, end: noop }),
    getImageDataPixelCount: image => image.width * image.height,
    loadFileToImageData: async (_file, options) => { calls.decoded++; calls.loads.push(options); return image; },
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw Object.assign(new Error('stale'), { name: 'AbortError' }); },
    sanitizeSettings: settings => structuredClone(settings),
    renderGeometryChain: async () => { calls.geometry++; return image; },
    applyLensCorrectionWithSettings: async () => { calls.lens++; return corrected; },
    downsampleImageDataForMaxDim: (source, max) => {
      calls.downsample.push([source.width, source.height, max]);
      return downsampleImageDataForMaxDim(source, max);
    },
    reducedTileGeometry, renderReducedGeometry, tileGeometryKey,
    sanitizeCropRegionForImage: sanitizeCropRect, normalizeAngleDegrees, rotatedDimensions,
    hasExactPlane16: () => true,
    sampleAnalysisArea: () => ({ width: 1, height: 1, data: new Uint16Array(4) }),
    TILE_ANALYSIS_REFERENCE_PIXELS: 16384,
    buildRouterSettings: settings => settings,
    getColorAnalysisSample: () => image,
    convertFrameOffMainThread: async request => {
      calls.conversions.push(request);
      return request.imageData;
    },
    detectDustOffMainThread: async (source, options) => {
      calls.dust.push({ source, options });
      return { mask: new Uint8Array(source.width * source.height), particleCount: 0 };
    },
    withAiRepairTurn: work => work(),
    inpaintManualBrush: async (source, settings, base, lensMapping) => {
      calls.brushes.push({ source, settings, base, lensMapping });
      return source;
    },
    buildAdjustmentSettings: settings => settings,
    createAdjustedPhotoPreview: (source, settings, options) => {
      calls.previews.push({ source, options });
      return createAdjustedPhotoPreview(source, settings, options);
    },
    applyAdjustmentsWithSettings: async (source, settings, options) => {
      calls.adjustments.push({ source, options });
      const output = new TestImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
      (options.bitDepth === 16 ? applyPreparedAdjustmentsToBuffer16 : applyPreparedAdjustmentsToBuffer)(source, settings, output);
      return output;
    },
    usesSilverCoreConversion: () => false,
    sanitizePresetType: type => type,
    safeStorageGet: () => 'off',
    markOwnedPlanes, planeBuffersOf
  });
  vm.runInContext(runtime, context);
  return { context, calls, image, corrected, mapping, settings, file };
}

// Regression: early downsampling loses the non-enumerable native Lensfun map.
// Keep native geometry through conversion and brush repair for this combination;
// only the final adjusted preview may shrink it.
{
  const f = fixture({ lens: true, brush: true, dust: true });
  const result = await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [600, 400],
    'lens-mapped repairs must convert at the mapping native dimensions');
  assert.equal(request.options.preview, false, 'native repairs must not enter a preview conversion path');
  assert.equal(request.imageData.__image16, f.image.__image16, 'native conversion receives the original precision');
  assert.equal(f.calls.brushes[0].lensMapping, f.mapping, 'repair receives the native lens-coordinate mapping');
  assert.equal(f.calls.brushes[0].source.width, 600);
  assert.equal(f.calls.brushes[0].base, f.image);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40, 'native repair keeps native dust size');
  assert.equal(f.calls.downsample.length, 0, 'do not discard mapping before conversion/repair');
  assert.equal(f.calls.previews[0].source.width, 600);
  assert.deepEqual([result.width, result.height], [288, 192]);
  assert.equal(f.calls.adjustments.length, 0, 'no separate full-frame adjustment pass for a thumbnail');
  assert.equal(f.calls.geometry, 1, 'an active lens keeps the full-resolution chain');
}

// Ordinary thumbnails retain the small-conversion path, including lens-only or
// brush-only photos. Dust size follows the actual post-crop/lens dimensions.
for (const options of [{}, { lens: true }, { brush: true }]) {
  const f = fixture({ ...options, dust: true });
  const result = await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [200, 133]);
  assert.equal(request.options.preview, true);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 13,
    '40 native pixels scale to round(40 * 133 / 400), not 40 preview pixels');
  assert.deepEqual([result.width, result.height], [200, 133]);
  assert.equal(f.calls.adjustments.length, 0);
  if (options.brush) assert.equal(f.calls.brushes[0].source.width, 200);
  // Without an active lens the tile never builds the full-resolution frame.
  assert.equal(f.calls.geometry, options.lens ? 1 : 0, 'reduced geometry skips the full-resolution chain');
  assert.equal(f.calls.lens, options.lens ? 1 : 0);
  if (options.brush) assert.equal(f.calls.brushes[0].base, f.image, 'the stroke mapping reads the full base size');
}

{
  const f = fixture({ dust: true });
  await f.context.processFileWithSettings(f.file, f.settings, {
    previewMaxDimension: 12, dustRemoval: { enabled: true, strength: 7, maxParticleSize: 6 }
  });
  assert.equal(f.calls.dust[0].options.strength, 7);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 3, 'preview scaling retains the existing three-pixel floor');
}

// No resize means no dust-size change (including callers with a small source).
{
  const f = fixture({ dust: true, width: 12, height: 8 });
  await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40);
}

// The reduced branch: the crop and rotation apply at tile scale, the dust
// size scales from the analytic full-resolution crop, and the working image
// is offered as the frame's tile source with its geometry key (#247).
{
  const geometry = { rotationAngle: 0.75, cropRegion: { left: 40, top: 30, width: 510, height: 340 } };
  const f = fixture({ dust: true, geometry });
  let tileSource = null;
  const result = await f.context.processFileWithSettings(f.file, f.settings, {
    previewMaxDimension: 288, onTileSource: entry => { tileSource = entry; }
  });
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [255, 170], 'the 510x340 crop at step 2');
  assert.equal(f.calls.geometry, 0);
  assert.equal(f.calls.dust[0].options.maxParticleSize, Math.round(40 * 170 / 340));
  assert.deepEqual([result.width, result.height], [255, 170]);
  assert.equal(tileSource.working, request.imageData, 'the tile source is the converted working image');
  assert.equal(tileSource.geometryKey, tileGeometryKey(f.settings, { width: 600, height: 400 }));
  assert.deepEqual([tileSource.baseSize.width, tileSource.baseSize.height], [600, 400]);
  // An active lens renders natively and offers no tile source.
  const lensed = fixture({ lens: true, geometry });
  let offered = false;
  await lensed.context.processFileWithSettings(lensed.file, lensed.settings, { previewMaxDimension: 288, onTileSource: () => { offered = true; } });
  assert.equal(offered, false);
}

// #247 1b: a half-size decode for a frame with a settled recipe. The recipe's
// crop and the dust size refer to the full size the decode reports.
{
  const geometry = { cropRegion: { left: 100, top: 60, width: 1020, height: 680 } };
  const f = fixture({ dust: true, geometry });
  f.image.__fullSize = { width: 1200, height: 800 };
  const result = await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288, halfSizeDecode: true });
  assert.deepEqual([f.calls.loads[0].filmStats, f.calls.loads[0].halfSize], [false, true]);
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [255, 170], 'the full-scale crop scaled by 600 / 1200');
  assert.equal(f.calls.dust[0].options.maxParticleSize, Math.round(40 * 170 / 680));
  assert.deepEqual([result.width, result.height], [255, 170]);
  // Never without a recipe, with an active lens, or when detection would
  // still read the decoded pixels.
  for (const [label, run] of [
    ['no recipe', f2 => f2.context.processFileWithSettings(f2.file, null, { previewMaxDimension: 288, halfSizeDecode: true })],
    ['lens', f2 => f2.context.processFileWithSettings(f2.file, { ...f2.settings, lensCorrection: { enabled: true, selectedLens: { handle: 1 } } }, { previewMaxDimension: 288, halfSizeDecode: true })],
    ['export', f2 => f2.context.processFileWithSettings(f2.file, f2.settings, { halfSizeDecode: true })]
  ]) {
    const f2 = fixture({ settled: true });
    await run(f2).catch(() => {});
    assert.equal(f2.calls.loads[0]?.halfSize, false, `no half-size decode: ${label}`);
  }
  const unsettled = fixture({ settled: false });
  // Frame and film edge in one request (#251), then folded into the recipe.
  unsettled.context.runImportDetections = async image => ({ image, detection: { result: null }, read: null });
  unsettled.context.analyzeStudioImportFrame = async (_image, settings) => settings;
  unsettled.context.mergeImportFilmEdge = async () => null;
  await unsettled.context.processFileWithSettings(unsettled.file, unsettled.settings, { previewMaxDimension: 288, halfSizeDecode: true });
  assert.equal(unsettled.calls.loads[0].halfSize, false, 'no half-size decode while frame detection reads the pixels');
}

// Contact-sheet cells (#247 part 3): geometry and lens correction as for an
// export, then the cell converts and adjusts at its own size, 8-bit at full
// quality, without dust removal, and never writes a recipe.
{
  const f = fixture({ lens: true, dust: true });
  f.context.state.fileQueue[0].settings = null;
  const result = await f.context.processFileWithSettings(f.file, f.settings, { tileMaxDimension: 150, updateItemSettings: false });
  assert.equal(f.calls.geometry, 1, 'the export chain');
  assert.equal(f.calls.lens, 1, 'and lens correction, exact');
  assert.deepEqual(f.calls.downsample, [[600, 400, 150]], 'then one reduction to the cell size');
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [150, 100]);
  assert.equal(request.options.forceFullProcess, true);
  assert.equal(request.options.analysisImageData, f.image, 'the full-base analysis sample');
  assert.equal(f.calls.dust.length, 0, 'no dust removal on a proof sheet');
  assert.equal(f.calls.adjustments.length, 1);
  assert.equal(f.calls.adjustments[0].options.bitDepth, 8);
  assert.deepEqual([result.width, result.height], [150, 100]);
  assert.equal(f.context.state.fileQueue[0].settings, null);
  // Lens-mapped repairs stay native, as for previews.
  const native = fixture({ lens: true, brush: true });
  await native.context.processFileWithSettings(native.file, native.settings, { tileMaxDimension: 150 });
  assert.equal(native.calls.conversions[0].imageData.width, 600);
  assert.equal(native.calls.brushes[0].lensMapping, native.mapping);
}

// Default full-resolution exports keep the existing precision/dimensions and
// native repair mapping. Real prepared 16-bit adjustments pin every sample.
for (const bitDepth of [8, 16]) {
  const f = fixture({ lens: true, brush: true, dust: true, width: 24, height: 16 });
  const planeBefore = f.image.__image16.data.slice();
  const bridge = {};
  const result = await f.context.processFileWithSettings(f.file, f.settings, { bitDepth, bridge });
  assert.equal(f.calls.conversions[0].imageData, f.corrected);
  assert.equal(f.calls.conversions[0].options.preview, false);
  assert.equal(f.calls.conversions[0].options.forceFullProcess, true);
  assert.equal(f.calls.downsample.length, 0);
  assert.equal(f.calls.previews.length, 0);
  assert.equal(f.calls.adjustments[0].options.bitDepth, bitDepth);
  assert.equal(f.calls.adjustments[0].options.bridge, bridge);
  assert.equal(f.calls.brushes[0].lensMapping, f.mapping);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40);
  assert.deepEqual([result.width, result.height], [24, 16]);
  if (bitDepth === 16) assert.deepEqual(result.__image16.data, planeBefore);
  assert.deepEqual(f.image.__image16.data, planeBefore, 'source precision is never modified');
  assert.deepEqual(result.data, f.image.data, 'identity final adjustments preserve all RGBA8 samples');
}
// Exports without an active lens still build the full-resolution chain.
{
  const f = fixture({ dust: true, width: 24, height: 16 });
  await f.context.processFileWithSettings(f.file, f.settings, { bitDepth: 8 });
  assert.equal(f.calls.geometry, 1);
  assert.equal(f.calls.loads[0].halfSize, false);
}

console.log('photoPreviewPipeline tests passed');
