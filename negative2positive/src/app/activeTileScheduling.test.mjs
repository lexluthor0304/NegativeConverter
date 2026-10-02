import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { exactSettingsKey } from './settingsKey.js';
import { createStudioThumbnail } from './studioSettings.js';
import { applyStrokePatch, applyDustDelta, amendDustDelta, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';
import { updateDisplayPreviewRect } from './displayPreview.js';
import { createRepairStamps } from './repairReuse.js';
import { TILE as AI_TILE, CONTEXT as AI_CONTEXT } from './aiInpaint.js';
import { createHarness, makeBase, settle } from './geometryTestHarness.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
// Collected means unreachable: a WeakRef is cleared only after the job that
// made or read it, so collect across a few turns.
async function collectGarbage() {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setImmediate(resolve));
    gc();
  }
  await new Promise(resolve => setImmediate(resolve));
}
// A pair of tile inputs holds no pixels: no typed array, nothing with one.
function assertHoldsNoPixels(value, label, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer), `${label} holds no pixel buffer`);
  for (const [key, child] of Object.entries(value)) assertHoldsNoPixels(child, `${label}.${key}`, seen);
}

// Run the active filmstrip tile's real scheduling and rebuild decisions from
// main.js. Only the canvas, the adjustment stage and the row DOM are stubbed.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
const raster = (width, height, fill = 90) => new TestImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);

const TILE_FUNCTIONS = ['getCurrentQueueItem', 'thumbnailDataUrl', 'studioThumbnailSignature', 'rasterIdentity',
  'updateStudioThumbnail', 'adoptStudioThumbnailInputs', 'carryStudioThumbnailSource', 'currentConvertedPreviewSource',
  'scheduleStudioThumbnailUpdate', 'cancelStudioThumbnailUpdate'];

function fixture() {
  const file = { name: 'a.png' };
  const item = { file, settings: { cyan: 0 } };
  const state = {
    fileQueue: [item], currentFileIndex: 0, loadedFile: file, cyan: 0,
    curves: { r: Uint8Array.from({ length: 256 }, (_, i) => i), g: new Uint8Array(256), b: new Uint8Array(256) },
    processedImageData: raster(600, 400), previewSourceImageData: null, fullResolutionPending: false,
  };
  const timers = new Map(), frames = new Map();
  let nextHandle = 1;
  const counts = { adjusted: 0, sampled: 0, encodes: 0, canvases: 0, rows: 0, keys: 0 };
  const puts = [];
  const context = vm.createContext({
    state, loadGeneration: 1, exactSettingsKey, ImageData: TestImageData, Uint8ClampedArray, Uint8Array,
    studioThumbnailInputs: new WeakMap(), rasterIdentities: new WeakMap(), nextRasterIdentity: 1, convertedPixelsRevision: 0,
    STUDIO_THUMBNAIL_SETTLE_MS: 250,
    studioThumbnailUpdateTimer: 0, studioThumbnailUpdateFrame: 0, thumbnailCanvas: null,
    previewTier: 'normal', reducedDisplayImages: new WeakSet(), coreReprocessTimer: null, coreReprocessBusy: () => false,
    setTimeout: (fn, ms) => { const id = nextHandle++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = nextHandle++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    isCurrentLoad: generation => generation === context.loadGeneration,
    buildAdjustmentSettings: settings => ({ cyan: settings.cyan, curves: { ...settings.curves } }),
    createAdjustedPhotoPreview: (sourceImage, adjustments) => {
      counts.adjusted++;
      const sample = createStudioThumbnail(sourceImage, 144);
      return new TestImageData(sample.data.map(value => value + adjustments.cyan), sample.width, sample.height);
    },
    createStudioThumbnail: (...args) => { counts.sampled++; return createStudioThumbnail(...args); },
    photoSettingsKey: entry => { counts.keys++; return JSON.stringify(entry.settings); },
    updateFileThumbnail: () => { counts.rows++; },
    document: { createElement: () => {
      counts.canvases++;
      return { width: 0, height: 0, getContext: () => ({ putImageData: image => puts.push(image) }),
        toDataURL: () => `data:image/jpeg;base64,${++counts.encodes}` };
    } },
  });
  vm.runInContext(TILE_FUNCTIONS.map(functionSource).join('\n'), context);
  const fireTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  const fireFrames = () => { for (const [id, frame] of [...frames]) { frames.delete(id); frame(); } };
  return { context, state, item, timers, frames, counts, puts, fireTimers, fireFrames };
}

// A drag: every preview frame re-arms one trailing timer; nothing is sampled,
// adjusted or encoded until it fires, then the tile is rebuilt once.
{
  const f = fixture(), c = f.context;
  c.updateStudioThumbnail();
  assert.equal(f.counts.encodes, 1);
  const first = f.item.thumbnail;
  for (let frame = 1; frame <= 90; frame++) {
    f.state.cyan = 1 + frame % 30;
    c.scheduleStudioThumbnailUpdate();
    assert.equal(f.timers.size, 1, 'one pending timer, re-armed by every preview frame');
  }
  assert.equal([...f.timers.values()][0].ms, 250);
  assert.deepEqual([f.counts.adjusted, f.counts.encodes, f.counts.rows], [1, 1, 1], 'no tile work while the slider moves');
  f.fireTimers();
  assert.deepEqual([f.counts.adjusted, f.counts.encodes, f.counts.rows], [2, 2, 2], 'one rebuild after it settles');
  assert.notEqual(f.item.thumbnail, first);
  assert.equal(f.item.thumbnailKind, 'processed');
  assert.equal(f.item.thumbnailKey, JSON.stringify(f.item.settings));
  assert.equal(f.counts.canvases, 1, 'one canvas serves every encode');

  // Zoom, pan and resize redraws: same source and settings, no rebuild; a
  // persisted settings change is still restamped on the row.
  for (let step = 0; step < 5; step++) c.scheduleStudioThumbnailUpdate();
  f.item.settings = { cyan: f.state.cyan };
  f.fireTimers();
  assert.deepEqual([f.counts.adjusted, f.counts.encodes], [2, 2]);
  assert.equal(f.item.thumbnailKey, JSON.stringify(f.item.settings), 'restamped without a rebuild');
  assert.equal(f.counts.rows, 3);

  // An in-place curve edit (updateCurveFromPoints) changes the signature.
  f.state.curves.r[7] = 200;
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 3);

  // A full render updates the tile in the next frame; a later preview redraw
  // replaces that frame with the trailing timer, and the reverse.
  f.state.processedImageData = raster(600, 400, 91);
  c.scheduleStudioThumbnailUpdate({ settled: true });
  assert.deepEqual([f.frames.size, f.timers.size], [1, 0]);
  c.scheduleStudioThumbnailUpdate();
  assert.deepEqual([f.frames.size, f.timers.size], [0, 1]);
  c.scheduleStudioThumbnailUpdate({ settled: true });
  assert.deepEqual([f.frames.size, f.timers.size], [1, 0]);
  f.fireFrames();
  assert.equal(f.counts.encodes, 4, 'a new converted source rebuilds');

  // Another writer of the tile (roll-transaction undo restores an old data
  // URL) makes it stale even though source and settings match.
  f.item.thumbnail = first;
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 5);
  assert.notEqual(f.item.thumbnail, first);

  // A pending update never writes into a newer load.
  f.state.cyan = 1;
  c.scheduleStudioThumbnailUpdate();
  c.loadGeneration++;
  f.fireTimers();
  assert.equal(f.counts.encodes, 5);
  c.scheduleStudioThumbnailUpdate();
  c.cancelStudioThumbnailUpdate();
  assert.deepEqual([f.frames.size, f.timers.size, c.studioThumbnailUpdateTimer, c.studioThumbnailUpdateFrame], [0, 0, 0, 0]);
}

// The display-preview refinement after a zoom converts the same settings at
// another size: its result carries the tile over. A source it did not sample
// is not carried.
{
  const f = fixture(), c = f.context;
  f.state.fullResolutionPending = true;
  f.state.previewSourceImageData = raster(300, 200);
  c.updateStudioThumbnail();
  const replaced = c.currentConvertedPreviewSource();
  f.state.previewSourceImageData = raster(450, 300);
  c.carryStudioThumbnailSource(replaced);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 1, 'a zoom refinement rebuilds nothing');
  f.state.previewSourceImageData = raster(450, 300, 70);
  c.carryStudioThumbnailSource(replaced);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 2, 'only the source the tile was sampled from is carried');
  c.carryStudioThumbnailSource(null);
  f.state.previewSourceImageData = raster(450, 300, 60);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 3, 'an ordinary conversion result rebuilds');
}

// Warm switch: the incoming photo's current tile is adopted, not rebuilt, and
// the restore's own redraw does not rebuild it later.
{
  const f = fixture(), c = f.context;
  f.item.thumbnail = 'data:image/jpeg;base64,kept';
  f.item.thumbnailKind = 'processed';
  c.scheduleStudioThumbnailUpdate();
  c.adoptStudioThumbnailInputs(f.item);
  assert.equal(f.timers.size, 0);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 0);
  assert.equal(f.item.thumbnail, 'data:image/jpeg;base64,kept');
}

// thumbnailDataUrl encodes a source that already fits as it is (the sampler
// at scale 1 is an exact copy) and samples anything larger.
{
  const f = fixture(), c = f.context;
  const small = raster(144, 96);
  c.thumbnailDataUrl(small);
  assert.equal(f.puts.at(-1), small);
  assert.equal(f.counts.sampled, 0);
  const odd = { width: 100, height: 60, data: new Uint8ClampedArray(100 * 60 * 4 + 8) };
  c.thumbnailDataUrl(odd);
  assert.equal(f.counts.sampled, 1, 'a view with slack is sampled');
  c.thumbnailDataUrl(raster(288, 192));
  assert.equal(f.counts.sampled, 2);
  assert.deepEqual([f.puts.at(-1).width, f.puts.at(-1).height], [144, 96]);
  assert.equal(f.counts.canvases, 1);
}

// R1-025 / R1-138: the pair names its source, it does not hold it. A left
// photo's display preview, the raster a zoom refinement carried the tile to,
// and its full-resolution frame are all collectable once nothing else holds
// them; the photo's queue item (which outlives them) keeps no pixels.
{
  const f = fixture(), c = f.context;
  const itemA = f.item, itemB = { file: { name: 'b.png' }, settings: { cyan: 0 } };
  f.state.fileQueue.push(itemB);
  let previewA = raster(300, 200), resizedA = raster(450, 300), fullA = raster(600, 400, 91);
  const refs = [previewA, resizedA, fullA].map(image => new WeakRef(image));
  Object.assign(f.state, { fullResolutionPending: true, previewSourceImageData: previewA, processedImageData: null });
  c.updateStudioThumbnail();
  f.state.previewSourceImageData = resizedA;
  c.carryStudioThumbnailSource(previewA);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 1, 'the zoom refinement still carries the tile');
  Object.assign(f.state, { fullResolutionPending: false, processedImageData: fullA });
  c.scheduleStudioThumbnailUpdate({ settled: true }); f.fireFrames();
  assert.equal(f.counts.encodes, 2, 'the full-resolution frame rebuilds it');
  // Leaving A (its persist restamps the tile), then B restored warm.
  c.updateStudioThumbnail();
  assert.equal(f.counts.encodes, 2);
  Object.assign(f.state, { currentFileIndex: 1, loadedFile: itemB.file, processedImageData: raster(600, 400, 70), previewSourceImageData: null });
  Object.assign(itemB, { thumbnail: 'data:image/jpeg;base64,b', thumbnailKind: 'processed' });
  c.adoptStudioThumbnailInputs(itemB);
  for (const [label, item] of [['A', itemA], ['B', itemB]]) {
    const pair = c.studioThumbnailInputs.get(item);
    assert.ok(pair, `${label} has its tile inputs`);
    assertHoldsNoPixels(pair, `${label}'s tile inputs`);
  }
  previewA = resizedA = fullA = null;
  await collectGarbage();
  assert.deepEqual(refs.map(ref => ref.deref() === undefined), [true, true, true],
    "no raster of the photo left is pinned by its tile inputs");
  // B's adopted pair still skips the restore's redraw.
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 2);
  assert.equal(itemB.thumbnail, 'data:image/jpeg;base64,b');
}

// R1-026: dust-brush strokes, their undo and redo, and MI-GAN's refresh of the
// stroked rects patch the converted frame in place (#259). The real writers,
// display refresh and tile: each rebuilds the tile from the patched pixels
// before its key is stamped again, on the settle timer and on the leave path.
function checksum(data) {
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
  return (hash >>> 0).toString(16);
}
function dustFixture() {
  const width = 160, height = 120;
  const frame = fill => {
    const image = new TestImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);
    image.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(fill * 257) };
    return image;
  };
  const clean = frame(140), target = frame(140);
  const mask = new Uint8Array(width * height);
  const file = { name: 'dust.png' };
  const item = { file, settings: { cyan: 0 }, thumbnailKind: 'processed' };
  const log = [];
  let key = null;
  Object.defineProperty(item, 'thumbnailKey', {
    get: () => key, set: value => { key = value; log.push(['stamp', item.thumbnail]); }, enumerable: true
  });
  const state = {
    fileQueue: [item], currentFileIndex: 0, loadedFile: file, cyan: 0, currentStep: 3,
    curves: { r: Uint8Array.from({ length: 256 }, (_, i) => i), g: new Uint8Array(256), b: new Uint8Array(256) },
    processedImageData: target, previewSourceImageData: target, webglSourceImageData: null, displayImageData: null,
    processedImageDataIsPreview: false, fullResolutionPending: false, repairStrokes: [],
    loadedBaseImageData: clean, originalImageData: clean, conversionSourceImageData: clean,
    dustRemoval: { enabled: true, ai: true, mask, cleanSource: clean, inpaintedImageData: target,
      particleCount: 1, maskTag: 1, revision: 4 },
  };
  const timers = [];
  let lastPut = null;
  const sample = image => {
    const thumb = createStudioThumbnail(image, 144);
    return new TestImageData(thumb.data.map(value => value + state.cyan), thumb.width, thumb.height);
  };
  const context = vm.createContext({
    state, loadGeneration: 1, exactSettingsKey, ImageData: TestImageData, Uint8ClampedArray, Uint8Array, Uint16Array,
    studioThumbnailInputs: new WeakMap(), rasterIdentities: new WeakMap(), nextRasterIdentity: 1, convertedPixelsRevision: 0,
    STUDIO_THUMBNAIL_SETTLE_MS: 250, studioThumbnailUpdateTimer: 0, studioThumbnailUpdateFrame: 0, thumbnailCanvas: null,
    previewTier: 'normal', reducedDisplayImages: new WeakSet(), coreReprocessTimer: null, coreReprocessBusy: () => false,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    requestAnimationFrame: () => assert.fail('no full render here'), cancelAnimationFrame: () => {},
    isCurrentLoad: generation => generation === context.loadGeneration,
    buildAdjustmentSettings: settings => ({ cyan: settings.cyan, curves: { ...settings.curves } }),
    createAdjustedPhotoPreview: source => sample(source), createStudioThumbnail,
    photoSettingsKey: entry => JSON.stringify(entry.settings), updateFileThumbnail: () => {},
    document: { createElement: () => ({
      width: 0, height: 0, getContext: () => ({ putImageData: image => { lastPut = image; } }),
      toDataURL: () => { log.push(['encode']); return `data:image/jpeg;base64,${checksum(lastPut.data)}`; }
    }) },
    // The display the patches refresh (refreshDustDisplay, restoreDustDelta).
    applyProcessedImageToState: image => { state.processedImageData = image; },
    updatePreview: () => context.scheduleStudioThumbnailUpdate(),
    updateDisplayPreviewRect, webglUploadSourceRect: () => {}, scheduleDustHistogramRefresh: () => {},
    // A stroke and its history (commitDustStroke, restoreDustDelta).
    repairStamps: createRepairStamps(), forgetDustMaskInfo: () => {}, applyStrokePatch, applyDustDelta,
    undoStack: [], pushUndoDelta: (label, delta) => context.undoStack.push({ label, dustDelta: delta }),
    showDustParticleCount: () => {}, patchDustTint: () => {}, followDustMaskInWorker: () => Promise.resolve(),
    syncDustWorkerPin: () => {}, dustDetectionRevision: 0, dustDetectionTimer: null,
    // MI-GAN's refresh of the stroked rect (runDustAiRefresh), with a stand-in
    // inpainter that paints the masked pixels 30.
    dustAiRefresh: { rects: [], timer: null }, coreReprocessToken: 3, pendingBrushRepairs: 0, brushRepairWaiters: [],
    aiRepair: { status: 'ready', revision: 1, run: () => {}, tiles: 0, ms: 0 }, aiRepairRunsInFlight: 0,
    noteAiRepairUsed: () => {}, updateAiRepairUI: () => {}, showToast: () => {}, console, DOMException, performance,
    copyImageRect, pasteImageRect, amendDustDelta, AI_TILE, AI_CONTEXT, DEFAULT_MODEL_URL: '/m.onnx',
    loadAiRepairModel: async () => {}, localExposureGeometryFor: () => ({}), buildRepairMask: () => ({ mask: null }),
    inpaintWithModel: async (image, layerMask) => {
      const out = new TestImageData(image.data.slice(), image.width, image.height);
      out.__image16 = { width: image.width, height: image.height, data: image.__image16.data.slice() };
      for (let i = 0; i < layerMask.length; i++) {
        if (!layerMask[i]) continue;
        for (let c = 0; c < 3; c++) { out.data[i * 4 + c] = 30; out.__image16.data[i * 4 + c] = 30 * 257; }
      }
      return { imageData: out, tiles: 1 };
    },
  });
  vm.runInContext([...TILE_FUNCTIONS, 'refreshDustDisplay', 'commitDustStroke', 'restoreDustDelta', 'runDustAiRefresh',
    'queueDustAiRefresh', 'mergeDustRefreshRects', 'dustAiWindow', 'cropDustImage', 'cropDustMask', 'repairStrokeMaskFor',
    'noteBrushRepairSettled', 'aiRepairReady', 'dustPassUsesAi', 'settleAiRepairModel', 'aiRepairLoadArgs',
    'assertRepairCurrent', 'countAiRepairRun', 'baseSizeSource'].map(functionSource).join('\n')
    + '\nlet dustRefreshRepairMask = null;', context);
  // Fires the pending timers of one kind: the tile's settle (250 ms) or the
  // refresh's debounce (200 ms), whose run then completes.
  const fire = async ms => {
    for (const timer of timers.slice()) {
      if (!timer.fn || timer.ms !== ms) continue;
      const fn = timer.fn; timer.fn = null;
      fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  // The tile a fresh build of the frame on screen gives.
  const expectedTile = () => `data:image/jpeg;base64,${checksum(sample(target).data)}`;
  return { context, state, item, target, mask, log, fire, expectedTile, width, height };
}
{
  const f = dustFixture(), c = f.context;
  c.updateStudioThumbnail();
  const clean = f.item.thumbnail;
  assert.equal(clean, f.expectedTile());
  // A stroke over a speck: TELEA's stand-in (200) inside its rect, the mask
  // refined there, and the rect queued for MI-GAN.
  const rect = { x: 60, y: 40, width: 24, height: 20 };
  const rgba8 = new Uint8ClampedArray(rect.width * rect.height * 4).fill(200);
  const rgba16 = new Uint16Array(rgba8.length).fill(200 * 257);
  const maskBytes = new Uint8Array(rect.width * rect.height);
  for (let y = 6; y < 14; y++) for (let x = 8; x < 16; x++) maskBytes[y * rect.width + x] = 255;
  const step = async (label, action) => {
    f.log.length = 0;
    await action();
    await f.fire(250);
    assert.deepEqual(f.log.map(([kind]) => kind), ['encode', 'stamp'], `${label}: the tile is rebuilt before its key is stamped`);
    assert.equal(f.log[1][1], f.expectedTile(), `${label}: the stamped tile shows the patched pixels`);
    return f.item.thumbnail;
  };
  const stroked = await step('stroke', () => {
    c.commitDustStroke({ rect, rgba8, rgba16, maskRect: rect, maskBytes, particleCount: 2 }, { baseTag: 1, tag: 2 });
    assert.equal(c.dustAiRefresh.rects.length, 1, 'the stroked rect is queued for MI-GAN');
  });
  assert.notEqual(stroked, clean);
  const refreshed = await step('MI-GAN refresh', () => f.fire(200));
  assert.equal(c.dustAiRefresh.rects.length, 0, 'the rect was refreshed');
  assert.notEqual(refreshed, stroked, 'MI-GAN replaced the stroke\'s stand-in');
  const entry = c.undoStack.at(-1).dustDelta;
  assert.equal(await step('undo', () => c.restoreDustDelta(entry, 'undo')), clean, 'undo shows the frame before the stroke again');
  assert.equal(await step('redo', () => c.restoreDustDelta(entry, 'redo')), refreshed, 'redo shows the refreshed stroke again');
  // Leaving right after a patch: persistCurrentFileSettings rebuilds the
  // outgoing tile before it stamps the key (the settle timer is cancelled).
  f.log.length = 0;
  c.restoreDustDelta(entry, 'undo');
  c.updateStudioThumbnail();
  assert.deepEqual(f.log.map(([kind]) => kind), ['encode', 'stamp'], 'leave: rebuilt before it is stamped');
  assert.equal(f.item.thumbnail, clean);
  // Nothing patched since: a redraw only stamps.
  f.log.length = 0;
  c.scheduleStudioThumbnailUpdate(); await f.fire(250);
  assert.deepEqual(f.log.map(([kind]) => kind), ['stamp']);
}

// A 116-photo roll in the geometry harness, photo A open and settled: the
// real switchToFile, persist and tile. A's session is kept without planes
// (#244's cold sessions), so after a switch nothing but a leak can keep its
// converted frame.
function rollHarness() {
  const h = createHarness(makeBase(48, 32, 5)), c = h.context, t = h.target;
  const items = Array.from({ length: 116 }, (_, i) => ({
    id: `f${i}`, file: { name: `f${String(i).padStart(3, '0')}.png` }, status: 'done',
    settings: { rotationAngle: 0, mirrored: false, cropRegion: null, cyan: i % 7 }
  }));
  Object.assign(h.state, { fileQueue: items, currentFileIndex: 0, loadedFile: items[0].file, currentStep: 3,
    batchSessionActive: true, processedImageData: makeBase(48, 32, 7), dustRemoval: { ...h.state.dustRemoval, ai: false } });
  t.geometryDiagnostics.coldSessions = true;
  const counts = { encodes: 0, rows: 0 };
  Object.assign(t, {
    studioThumbnailInputs: new WeakMap(), rasterIdentities: new WeakMap(), nextRasterIdentity: 1, convertedPixelsRevision: 0,
    STUDIO_THUMBNAIL_SETTLE_MS: 250, studioThumbnailUpdateTimer: 0, thumbnailCanvas: null, state: h.state,
    updateFileThumbnail: () => { counts.rows++; },
    extractCurrentSettings: () => ({ ...h.state.fileQueue[h.state.currentFileIndex].settings }),
    buildAdjustmentSettings: settings => ({ cyan: settings.cyan || 0, curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    createAdjustedPhotoPreview: source => createStudioThumbnail(source, 144),
    document: Object.assign(t.document, {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }),
        toDataURL: () => `data:image/jpeg;base64,${++counts.encodes}` })
    }),
    loadFile: async file => {
      const base = makeBase(40, 30, 9);
      Object.assign(h.state, { loadedFile: file, loadedBaseImageData: base, originalImageData: base, croppedImageData: null,
        cropRegion: null, rotationAngle: 0, mirrored: false, processedImageData: null, currentStep: 1 });
      return { status: 'loaded' };
    },
  });
  vm.runInContext([...TILE_FUNCTIONS, 'persistCurrentFileSettings'].map(functionSource).join('\n'), c);
  // A's settled tile.
  c.updateStudioThumbnail();
  assert.equal(counts.encodes, 1);
  const open = async index => {
    await c.switchToFile(index);
    await settle();
    await h.state.geometryReady;
    assert.equal(h.state.loadedFile, items[index].file);
    // Its settled frame (the harness converts nothing).
    Object.assign(h.state, { processedImageData: makeBase(40, 30, 11), currentStep: 3 });
  };
  return { h, c, t, items, counts, open };
}

// R1-025 through a real switch: leaving A forgets its tile inputs
// (invalidatePhotoActivation), and nothing keeps its converted frame.
{
  const { h, c, t, items, open } = rollHarness();
  const convertedARef = new WeakRef(h.state.processedImageData);
  await open(5);
  assert.equal(t.studioThumbnailInputs.get(items[0]), undefined, "the switch forgot A's tile inputs");
  await collectGarbage();
  assert.equal(convertedARef.deref(), undefined, "A's converted frame is not reachable after the switch");
  c.updateStudioThumbnail();
  assertHoldsNoPixels(t.studioThumbnailInputs.get(items[5]), "B's tile inputs");
}

console.log('activeTileScheduling: trailing settle timer, next-frame full renders, exact skip/restamp, zoom carry, warm adoption, '
  + 'tile inputs without pixels, in-place patches rebuild the tile');
