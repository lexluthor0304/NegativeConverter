// Contact-sheet cells at cell size (#247 part 3, a flagged proof-sheet
// approximation): with an analysis area and no spatial effects, cell pixels equal
// nearest-decimating the frame's full-resolution convert + adjust output,
// because the conversion's levels come from the full-base analysis
// reference and every later stage is per pixel. Runs the app's
// processFileWithSettings with the real geometry chain, the real SilverCore
// colour and B&W conversions and the real adjustment stage.
// Run with: node negative2positive/src/app/contactSheetCells.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { downsampleImageDataForMaxDim } = await import('./imageDataOps.js');
const { applyGeometryChainToImageData, applyRotationToImageData, mirrorImageDataHorizontal, sanitizeCropRect, normalizeAngleDegrees, rotatedDimensions } = await import('./imageGeometry.js');
const { cropImageDataRegion } = await import('./imageDataOps.js');
const { applyPreparedAdjustmentsToBuffer } = await import('./adjustmentPipeline.js');
const { markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers } = await import('./planeRelease.js');
const { sampleAnalysisArea } = await import('./analysisRegion.js');
const { convertColorWithSilverCore, convertBwWithSilverCore } = await import('../pipeline/silverAdapter.js');
const { reducedTileGeometry, renderReducedGeometry, tileGeometryKey } = await import('./reducedGeometry.js');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
const runtime = ['processFileWithSettings', 'removeFrameDust', 'frameWantsAutoWhiteBalance', 'applyFrameAutoWhiteBalance',
  'applyFrameExpiredAnalysis', 'resolveLensCorrection', 'lensCorrectionActive', 'tileRecipeSettled', 'perPhotoSettingsFallback',
  'expiredImportKeepsFullFrame', 'renderPreviewFromWorkingImage', 'tileAnalysisReference'].map(functionSource).join('\n');

const exportSteps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? cropImageDataRegion(image, rect) : image;
  }
};

// A negative-looking 16-bit frame: an orange base, image content with
// structure, and a clear rebate around it.
function negative(width, height, seed = 17) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x > width * 0.08 && x < width * 0.92 && y > height * 0.1 && y < height * 0.9;
    const v = inside ? 9000 + 30000 * (0.5 + 0.5 * Math.sin(x / 37) * Math.cos(y / 23)) + 6000 * rnd() : 52000;
    const i = (y * width + x) * 4;
    data[i] = Math.min(65535, v * 1.35); data[i + 1] = v * 0.82; data[i + 2] = v * 0.46; data[i + 3] = 65535;
  }
  const image = new ImageData(Uint8ClampedArray.from(data, v => v >>> 8), width, height);
  image.__image16 = { width, height, data };
  return image;
}

const area = [{ x: 0.1, y: 0.12 }, { x: 0.9, y: 0.12 }, { x: 0.9, y: 0.88 }, { x: 0.1, y: 0.88 }];
const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
const lifted = Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, Math.round(v * 0.9 + 18)));
const adjustments = { saturation: 28, vibrance: 35, contrast: 12, temperature: 6, tint: -4, cyan: 3, highlights: -10, shadows: 8,
  wbR: 1.04, wbG: 1, wbB: 0.97, curves: { r: lifted, g: identity, b: lifted } };

function run(image, recipe, convertWith, { dust = false } = {}) {
  const file = { name: 'frame.tif', size: 1 };
  const analysisArea = recipe.autoFrameMeta?.imageArea || recipe.autoFrameMeta?.analysisArea;
  const reference = analysisArea ? sampleAnalysisArea(image, analysisArea) : null;
  const adjusted = [];
  const conversions = [];
  const context = vm.createContext({
    // A photo left inside a two-stage window (#255): none here.
    pendingGeometryEdits: () => null, withPendingEdits: (item, settings) => settings,
    state: { fileQueue: [{ file, settings: null }], dustRemoval: { enabled: dust, strength: 3, maxParticleSize: 40 }, autoFrame: { enabled: true } },
    createPerfTrace: () => ({ mark() {}, end() {} }),
    getImageDataPixelCount: img => img.width * img.height,
    loadFileToImageData: async () => image,
    assertRepairCurrent: () => {},
    sanitizeSettings: settings => structuredClone(settings),
    renderGeometryChain: async (img, geometry) => applyGeometryChainToImageData(img, geometry, exportSteps),
    applyLensCorrectionWithSettings: async img => img,
    downsampleImageDataForMaxDim, reducedTileGeometry, renderReducedGeometry, tileGeometryKey,
    sanitizeCropRegionForImage: sanitizeCropRect, normalizeAngleDegrees, rotatedDimensions, hasExactPlane16: () => true,
    buildRouterSettings: () => ({ colorModel: 'frontier', preSaturation: 115, borderBuffer: 10, filmBase: { r: 210, g: 150, b: 90 } }),
    getColorAnalysisSample: () => reference,
    detectDustOffMainThread: async () => { throw new Error('a contact sheet removes no dust'); },
    inpaintManualBrush: async img => img, withAiRepairTurn: work => work(),
    buildAdjustmentSettings: settings => settings,
    applyAdjustmentsWithSettings: async (img, settings, options) => {
      assert.equal(options.bitDepth, 8);
      const output = new ImageData(new Uint8ClampedArray(img.data.length), img.width, img.height);
      applyPreparedAdjustmentsToBuffer(img, settings, output, { quality: 'full' });
      adjusted.push(output);
      return output;
    },
    usesSilverCoreConversion: () => false, sanitizePresetType: type => type, markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers
  });
  vm.runInContext(runtime, context);
  const convert = async request => {
    conversions.push([request.imageData.width, request.imageData.height, request.options.forceFullProcess, request.options.analysisImageData === reference]);
    return convertWith(request.imageData, request.settings, request.options);
  };
  return { context, file, convert, conversions, adjusted, recipe: { ...recipe, ...adjustments } };
}

const recipes = [
  { rotationAngle: 0, mirrored: false, cropRegion: null },
  { rotationAngle: 1.3, mirrored: true, cropRegion: { left: 40, top: 30, width: 1100, height: 720 } },
  { rotationAngle: 90, mirrored: false, cropRegion: { left: 20, top: 60, width: 700, height: 1080 } }
];
for (const [label, convertWith] of [['colour', convertColorWithSilverCore], ['B&W', convertBwWithSilverCore]]) {
  for (const geometry of recipes) {
    const image = negative(1260, 840);
    const target = 330;
    const recipe = { filmType: 'color', autoFrameMeta: { imageArea: area }, filmEdge: { checked: true }, repairStrokes: [],
      lensCorrection: { enabled: false }, ...geometry };
    const full = run(image, recipe, convertWith);
    const exported = await full.context.processFileWithSettings(full.file, full.recipe, { convert: full.convert });
    const cell = run(image, recipe, convertWith, { dust: true });
    const sheet = await cell.context.processFileWithSettings(cell.file, cell.recipe, {
      tileMaxDimension: target, updateItemSettings: false, convert: cell.convert
    });
    const expected = downsampleImageDataForMaxDim(exported, target);
    assert.equal(Math.max(sheet.width, sheet.height) <= target, true);
    assert.deepEqual([sheet.width, sheet.height], [expected.width, expected.height], `${label} ${JSON.stringify(geometry)}: cell size`);
    assert.ok(Buffer.from(sheet.data.buffer).equals(Buffer.from(expected.data.buffer)),
      `${label} ${JSON.stringify(geometry)}: cell pixels equal the decimated full-resolution render`);
    // The cell's conversion and adjustment ran at cell size, with the full
    // base's reference; the export's at full resolution.
    assert.ok(cell.conversions.every(([w, h, force, ref]) => Math.max(w, h) <= target && force && ref));
    assert.ok(full.conversions.every(([w, h]) => Math.max(w, h) > target));
    assert.ok(cell.adjusted.every(img => Math.max(img.width, img.height) <= target));
    assert.equal(cell.context.state.fileQueue[0].settings, null, 'no recipe written');
    // Not a trivial frame: the cell has real tonal range.
    let min = 255, max = 0;
    for (let i = 0; i < sheet.data.length; i += 4) { min = Math.min(min, sheet.data[i + 1]); max = Math.max(max, sheet.data[i + 1]); }
    assert.ok(max - min > 60, `${label}: tonal range ${min}..${max}`);
  }
}

console.log('contactSheetCells: cells equal decimated full-resolution convert + adjust output (colour and B&W, with rotation, mirror and crop)');

// Without an area, levels are measured on the cell, as on any conversion
// without a reference. This is a documented proof-sheet approximation.
{
  const image = negative(1260, 840);
  const recipe = { filmType: 'color', autoFrameMeta: {}, filmEdge: { checked: true }, repairStrokes: [], lensCorrection: { enabled: false } };
  const cell = run(image, recipe, convertColorWithSilverCore);
  const sheet = await cell.context.processFileWithSettings(cell.file, cell.recipe, {
    tileMaxDimension: 330, updateItemSettings: false, convert: cell.convert
  });
  const reduced = downsampleImageDataForMaxDim(image, 330);
  const direct = run(reduced, recipe, convertColorWithSilverCore);
  const expected = await direct.context.processFileWithSettings(direct.file, direct.recipe, { convert: direct.convert });
  assert.deepEqual(sheet.data, expected.data, 'no-area cells use cell-sized analysis');
  assert.ok(cell.conversions.every(([w, h, force, noReference]) => Math.max(w, h) <= 330 && force && noReference));
}
