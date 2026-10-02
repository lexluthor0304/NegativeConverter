// Tile provenance across an automatic roll import (#229 review: R1-029,
// R1-033, R1-036), on the real main.js functions:
// 1. a frame's per-frame `analysis` tile is the roll's own tile recipe, so
//    the commit's tile of the same recipe has the same pixels;
// 2. undo and redo of a roll commit bring each tile back with its kind and
//    settings key, so a restored camera-JPEG tile is neither counted as
//    converted nor used as a colour-match target;
// 3. a photo left before its import detections (or its full decode) settled
//    keeps no settings key on its provisional tile, so the lane renders it.
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

// ---- 2. R1-033: undo/redo of a roll commit restores each tile's kind and key
{
  const { createHarness, makeBase } = await import('./geometryTestHarness.mjs');
  const { aggregateRollAnalysis, sanitizeRollFrameForSettings } = await import('./rollAnalysis.js');
  const { isTiffContainerRawName } = await import('./rawEmbeddedPreview.js');
  const h = createHarness(makeBase(40, 30)), c = h.context;
  const recipe = id => ({ filmType: 'color', filmBase: { r: 210, g: 140, b: 90, method: 'auto' }, filmEdge: { checked: true }, exposure: id });
  // The open photo and three frames of the roll, with the tiles they show
  // before the commit: a camera-JPEG inversion, a per-frame analysis look
  // and a canonical lane tile of the frame's recipe.
  const open = { id: 'a', file: { name: 'a.dng' }, settings: recipe(0), thumbnail: 'data:live', thumbnailKind: 'processed' };
  const embedded = { id: 'b', file: { name: 'b.dng' }, settings: recipe(1), thumbnail: 'data:embedded:b', thumbnailKind: 'embedded', thumbnailKey: null };
  const analysis = { id: 'c', file: { name: 'c.dng' }, settings: recipe(2), thumbnail: 'data:analysis:c', thumbnailKind: 'analysis', thumbnailKey: null };
  const lane = { id: 'd', file: { name: 'd.dng' }, settings: recipe(3), thumbnail: 'data:lane:d', thumbnailKind: 'processed' };
  const roll = [embedded, analysis, lane];
  Object.assign(h.state, { fileQueue: [open, ...roll], currentFileIndex: 0, loadedFile: open.file,
    rollReference: { applyLock: false }, rollAnalysis: { equalize: false } });
  open.thumbnailKey = c.photoSettingsKey(open);
  lane.thumbnailKey = c.photoSettingsKey(lane);
  const jobs = [];
  Object.assign(h.target, {
    automaticRollRevision: 0, automaticRollAnalysisRunning: false, manualRollAnalysisRunning: false, automaticRollImportRunning: false,
    automaticRollPendingItems: new Set(roll), studioBackgroundReady: () => true, safeStorageGet: () => null,
    getCurrentQueueItem: () => (h.state.fileQueue[h.state.currentFileIndex]?.file === h.state.loadedFile ? h.state.fileQueue[h.state.currentFileIndex] : null),
    cloneSettings: value => structuredClone(value), measureNegativeMean: () => 0.4, aggregateRollAnalysis, sanitizeRollFrameForSettings,
    analyzeSilverCoreFrame: async () => [0, 1, 2].map(() => ({ whitePointOrigin: 50000, blackPointOrigin: 500, meanPoint: 0.5 })),
    buildCoreConversionSettings: settings => settings, resolveConversionMode: () => 'color',
    createTileConverter: () => Object.assign(async () => null, { dispose() {} }),
    // The commit renders each frame's canonical tile from its sample.
    renderSampleTile: async (item, settings) => ({ thumbnail: `data:commit:${item.id}`, renderKey: c.photoSettingsKey({ ...item, settings }), lensActive: false, source: null }),
    thumbnailSources: { put() {} },
    // A cold switch's provisional frame (#235): only its job matters here.
    provisionalRequest: null, viewerLongSidePx: () => 2000, provisionalToneFor: () => ({}), isTiffContainerRawName,
    getEmbeddedPreviewPool: () => ({ request: job => { jobs.push(job); return new Promise(() => {}); } }),
  });
  h.target.document.getElementById = () => null;
  h.target.studioWorkspace.photoSwitchPresentation = { showBitmap: () => true };
  vm.runInContext(['runRollAnalysis', 'publishSampleTile', 'laneTileWanted', 'cancelProvisionalFrame', 'requestProvisionalFrame']
    .map(functionSource).join('\n'), c);
  const tileOf = item => [item.thumbnail, item.thumbnailKind, item.thumbnailKey];
  const ready = item => Boolean(item.thumbnail && item.thumbnailKind === 'processed' && item.thumbnailKey === c.photoSettingsKey(item));
  const before = new Map(roll.map(item => [item, tileOf(item)]));
  const samples = { get: async item => ({ id: item.id, __baseSize: { width: 40, height: 30 } }), put: async () => {}, delete: async () => {}, clear: async () => {} };

  const result = await c.runRollAnalysis({ items: roll, automatic: true, samples });
  assert.equal(result.status, 'committed');
  assert.deepEqual(h.target.undoStack.map(entry => entry.label), ['rollAnalysis'], 'the commit is one undo step');
  const after = new Map(roll.map(item => [item, tileOf(item)]));
  for (const item of roll) {
    assert.equal(item.thumbnail, `data:commit:${item.id}`);
    assert.ok(item.settings.rollFrame?.locked, 'the frame is locked to the roll');
    assert.ok(ready(item), `frame ${item.id}: the commit tile is canonical`);
  }

  // Cmd+Z: the recipes and the tiles before the commit, with what they were.
  await c.performUndo();
  for (const item of roll) {
    assert.equal(item.settings.rollFrame, undefined, `frame ${item.id}: its pass-1 recipe is back`);
    assert.deepEqual(tileOf(item), before.get(item), `frame ${item.id}: thumbnail, kind and key are restored together`);
  }
  assert.equal(ready(embedded) || ready(analysis), false, 'a restored embedded or analysis tile is pending');
  assert.equal(ready(lane), true, 'the restored lane tile is the canonical tile of the restored recipe');
  assert.deepEqual(roll.map(item => c.laneTileWanted(item)), [true, true, false],
    'the lane renders the restored recipes that have no canonical tile, and only those');
  // A cold switch to a frame colour-matches its provisional frame only to a
  // converted tile, never to a restored camera-JPEG inversion.
  for (const item of roll) {
    h.state.photoSwitchTarget = item;
    h.target.document.body.dataset.photoSwitching = 'true';
    c.requestProvisionalFrame(item);
  }
  delete h.target.document.body.dataset.photoSwitching;
  h.state.photoSwitchTarget = null;
  assert.deepEqual(jobs.map(job => job.matchTo), [null, 'data:analysis:c', 'data:lane:d']);

  // Cmd+Shift+Z: the commit's tiles come back canonical.
  await c.performRedo();
  for (const item of roll) {
    assert.deepEqual(tileOf(item), after.get(item), `frame ${item.id}: redo restores the commit tile with its key`);
    assert.ok(ready(item) && !c.laneTileWanted(item), `frame ${item.id}: ready again, nothing to render`);
  }

  // "These are positives" / apply to the whole roll: the same transaction.
  const snapshot = c.captureSnapshot('rollFilmType');
  assert.deepEqual(snapshot.settings.rollTransaction.frames.map(frame => [frame.thumbnailKind, frame.thumbnailKey]),
    h.state.fileQueue.map(item => [item.thumbnailKind, item.thumbnailKey]), 'a film-type transaction records the tiles\' kind and key too');
}

// ---- 3. R1-036: a photo left before its preparation settled ---------------
// The provisional render paints the active tile and stamps it with the
// item's settings key while the item's settings are still null (or are not
// what the window rendered). Leaving keeps those settings, so the lane must
// render the frame's own recipe instead of counting that tile as ready.
for (const window of ['detection tail (#236)', 'two-stage stand-in (#255)', 'settled (control)']) {
  const { createHarness, makeBase } = await import('./geometryTestHarness.mjs');
  const h = createHarness(makeBase(40, 30)), c = h.context;
  const left = { id: 'a', file: { name: 'a.nef' }, settings: null, isDirty: true };
  const next = { id: 'b', file: { name: 'b.nef' }, settings: null };
  Object.assign(h.state, { fileQueue: [left, next], currentFileIndex: 0, loadedFile: left.file, currentStep: 3 });
  const thumbnails = [];
  Object.assign(h.target, {
    automaticRollImportRunning: false, automaticRollPendingItems: new Set(),
    getCurrentQueueItem: () => (h.state.fileQueue[h.state.currentFileIndex]?.file === h.state.loadedFile ? h.state.fileQueue[h.state.currentFileIndex] : null),
    studioThumbnailInputs: new WeakMap(), rasterIdentities: new WeakMap(), nextRasterIdentity: 1, convertedPixelsRevision: 0,
    createAdjustedPhotoPreview: image => image, thumbnailDataUrl: image => { thumbnails.push(image); return `data:tile:${thumbnails.length}`; },
    twoStageDiagnostics: { leftEarly: 0 }, hasWindowEdits: edits => Boolean(edits && Object.keys(edits).length),
    // A settled photo is persisted on leave, which restamps its tile.
    persistCurrentFileSettings: () => { left.settings = { filmType: 'color', exposure: 4 }; c.updateStudioThumbnail(); return true; },
  });
  vm.runInContext(['updateStudioThumbnail', 'studioThumbnailSignature', 'rasterIdentity', 'currentConvertedPreviewSource',
    'laneTileWanted', 'leaveProvisionalPhoto'].map(functionSource).join('\n'), c);
  // The positive on screen: the provisional render, or the settled one.
  h.state.processedImageData = makeBase(40, 30, 9);
  if (window.startsWith('detection')) left.provisional = { wasDirty: false };
  if (window.startsWith('two-stage')) h.state.provisional = { item: left, swapped: false, settledSnapshot: null, start: { fresh: true } };
  if (window.startsWith('settled')) left.settings = { filmType: 'color', exposure: 4 };
  c.updateStudioThumbnail();
  const tile = left.thumbnail;
  assert.equal(left.thumbnailKind, 'processed', `${window}: the active tile shows the photo's positive`);
  assert.equal(left.thumbnailKey, c.photoSettingsKey(left), `${window}: stamped with the item's settings key`);

  await c.switchToFile(1);
  assert.equal(h.state.currentFileIndex, 1, `${window}: the next photo is opened`);
  assert.equal(left.thumbnail, tile, `${window}: the left photo keeps its tile image`);
  if (window.startsWith('settled')) {
    assert.equal(c.laneTileWanted(left), false, 'a settled photo left with its recipe keeps a ready tile');
    continue;
  }
  assert.equal(left.settings, null, `${window}: its settings stay as they were`);
  assert.equal(left.provisional, undefined);
  assert.equal(left.thumbnailKey, null, `${window}: no settings key describes the provisional render`);
  assert.equal(c.laneTileWanted(left), true, `${window}: the lane renders the photo's own recipe`);
  assert.equal(left.thumbnailKind, 'processed', `${window}: still a converted look, never replaced by a lower rank`);
}

console.log('roll tile provenance tests passed');
