// Tile provenance across an automatic roll import (#229 review: R1-029),
// on the real main.js functions:
// 1. a frame's per-frame `analysis` tile is the roll's own tile recipe, so
//    the commit's tile of the same recipe has the same pixels.
// Run with: node negative2positive/src/app/rollTileProvenance.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { createAdjustedPhotoPreview } = await import('./photoPreview.js');
const { createStudioThumbnail } = await import('./studioSettings.js');
const { downsampleImageDataForMaxDim } = await import('./imageDataOps.js');
const { reducedTileGeometry, tileGeometryKey } = await import('./reducedGeometry.js');
const { buildRollSample } = await import('./rollSample.js');
const { sanitizeCropRect } = await import('./imageGeometry.js');
const { resolveAnalysisRegion, analysisPixelBounds } = await import('./analysisRegion.js');
const { estimateAutoWhiteBalance } = await import('./autoWhiteBalance.js');
const { canPublishThumbnail } = await import('./thumbnailRank.js');
const { exactSettingsKey } = await import('./settingsKey.js');
const { convertColorWithSilverCore } = await import('../pipeline/silverAdapter.js');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists in main.js`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

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

// ---- 1. R1-029: the per-frame tile is the commit's tile of its recipe ------
{
  const area = [{ x: 0.1, y: 0.12 }, { x: 0.9, y: 0.12 }, { x: 0.9, y: 0.88 }, { x: 0.1, y: 0.88 }];
  const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
  const lifted = Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, Math.round(v * 0.9 + 18)));
  // A pass-1 recipe: geometry, the detected image area, the film base and
  // Step-3 adjustments. Its white balance is the automatic gray point's.
  const recipe = {
    filmType: 'color', rotationAngle: 1.3, mirrored: true, cropRegion: { left: 60, top: 40, width: 1300, height: 860 },
    autoFrameMeta: { imageArea: area }, filmEdge: { checked: true }, filmBase: { r: 210, g: 150, b: 90, method: 'auto' },
    repairStrokes: [], lensCorrection: { enabled: false },
    saturation: 28, vibrance: 35, contrast: 12, temperature: 6, tint: -4, cyan: 3, highlights: -10, shadows: 8,
    wbR: 1, wbG: 1, wbB: 1, curves: { r: lifted, g: identity, b: lifted }
  };
  const base = negative(1500, 1000);
  // The sample pass 1 keeps while the frame is decoded (rollSample.js).
  const sample = buildRollSample(base, recipe, { tileMax: 288, sanitizeCrop: sanitizeCropRect });
  const routerSettings = settings => ({
    colorModel: 'frontier', preSaturation: 115, borderBuffer: 10, filmBase: settings.filmBase, exposure: settings.coreExposure || 0
  });
  const tiles = [];
  const conversions = [];
  const convert = request => {
    conversions.push(request);
    return convertColorWithSilverCore(request.imageData, request.settings, request.options);
  };
  const current = { id: 0, file: { name: '0.dng' }, settings: null };
  const item = { id: 1, file: { name: '1.dng' }, settings: recipe, automaticSettings: true,
    thumbnail: 'data:embedded', thumbnailKind: 'embedded', thumbnailKey: null };
  const flushed = [];
  const state = { fileQueue: [current, item], currentFileIndex: 0, loadedFile: current.file, flatFields: {},
    dustRemoval: { enabled: false, strength: 3, maxParticleSize: 40, ai: false } };
  const context = vm.createContext({
    state, console, aiRepair: { revision: 1 }, automaticRollImportRunning: false, automaticRollPendingItems: new Set(),
    frameThumbnailWorkers: null, frameThumbnailJobs: new Set(),
    createConversionWorkerPool: () => Object.assign(request => convert(request), { dispose() {} }),
    createTileConverter: () => Object.assign(request => convert(request), { dispose() {} }),
    scheduleTileFlush: entry => flushed.push(entry), updateFileThumbnail() {}, yieldTaskForJob: async () => {},
    getCurrentQueueItem: () => current, thumbnailSources: { put() {} },
    usesSilverCoreConversion: () => true, sanitizePresetType: type => type, lensCorrectionActive: () => false,
    sanitizeSettings: settings => structuredClone(settings), perPhotoSettingsFallback: () => ({}),
    STUDIO_TILE_PREVIEW_MAX: 288, reducedTileGeometry, tileGeometryKey, sanitizeCropRect,
    resolveAnalysisRegion, analysisPixelBounds, estimateAutoWhiteBalance, canPublishThumbnail, exactSettingsKey,
    buildRouterSettings: (settings, size) => ({ ...routerSettings(settings), analysisRegion: resolveAnalysisRegion(settings, size) }),
    // What the 1703835 per-frame recipe asked the converter for.
    buildCoreConversionSettings: routerSettings,
    buildAdjustmentSettings: settings => settings, createAdjustedPhotoPreview, downsampleImageDataForMaxDim,
    getImageDataPixelCount: image => image.width * image.height,
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw Object.assign(new Error('stale'), { name: 'AbortError' }); },
    withAiRepairTurn: work => work(),
    // The JPEG data URL stands for the 144 px tile's pixels.
    thumbnailDataUrl: (image, maxSize = 144) => {
      tiles.push(image);
      const fits = image.width <= maxSize && image.height <= maxSize && image.data.length === image.width * image.height * 4;
      const tile = fits ? image : createStudioThumbnail(image, maxSize);
      return `rgba:${tile.width}x${tile.height}:${createHash('sha256').update(tile.data).digest('hex')}`;
    },
  });
  vm.runInContext(['renderFrameAnalysisThumbnail', 'releaseFrameThumbnailWorkers', 'renderSampleTile', 'publishSampleTile',
    'renderRollSampleTiles', 'renderPreviewFromWorkingImage', 'removeFrameDust', 'frameWantsAutoWhiteBalance',
    'applyFrameAutoWhiteBalance', 'applyFrameExpiredAnalysis', 'analysisRegionSample', 'sanitizeCropRegionForImage',
    'photoSettingsKey'].map(functionSource).join('\n'), context);

  // The sink: the frame's recipe and sample are in, its tile renders.
  context.renderFrameAnalysisThumbnail(item, { sample, settings: item.settings }, () => item.settings === recipe);
  await flush();
  while (context.frameThumbnailJobs.size) await Promise.all([...context.frameThumbnailJobs]);
  assert.equal(item.thumbnailKind, 'analysis', 'the embedded tile becomes the converted analysis look');
  assert.equal(item.thumbnailKey, null, 'a per-frame tile never counts as canonical');
  assert.deepEqual(flushed, [item], 'published through the batched flush');
  const perFrame = { thumbnail: item.thumbnail, image: tiles.at(-1) };
  assert.ok(conversions.every(request => request.imageData === sample.__tileWorking
    && request.options.analysisImageData === sample.__analysisReference && request.options.forceFullProcess),
  'the tile working image converts with the frame\'s analysis reference');

  // The import commits the frame's tile from the same sample: for a frame no
  // roll group took (#247 2c) with the recipe pass 1 gave it.
  const before = tiles.length;
  await context.renderRollSampleTiles([item], { samples: { get: async () => sample }, valid: () => true, key: entry => JSON.stringify(entry.settings.cropRegion) });
  assert.equal(tiles.length, before + 1, 'the commit renders the frame once');
  const committed = tiles.at(-1);
  assert.equal(item.thumbnailKind, 'processed', 'the commit tile is canonical');
  assert.equal(item.thumbnailKey, context.photoSettingsKey(item));
  assert.deepEqual([committed.width, committed.height], [perFrame.image.width, perFrame.image.height], 'same tile size');
  assert.ok(Buffer.from(committed.data.buffer, committed.data.byteOffset, committed.data.byteLength)
    .equals(Buffer.from(perFrame.image.data.buffer, perFrame.image.data.byteOffset, perFrame.image.data.byteLength)),
  'the per-frame tile has the commit tile\'s pixels');
  assert.equal(item.thumbnail, perFrame.thumbnail, 'so the tile does not change its look at the commit');
  // Not a trivial frame: the tile has real tonal range, and the automatic
  // gray point was measured on it.
  let min = 255, max = 0;
  for (let i = 0; i < committed.data.length; i += 4) { min = Math.min(min, committed.data[i + 1]); max = Math.max(max, committed.data[i + 1]); }
  assert.ok(max - min > 60, `tonal range ${min}..${max}`);
}

console.log('roll tile provenance tests passed');
