// What the recipes the light-table lane prepares are measured on (#229
// review). The lane's first render of a frame without a recipe prepares the
// recipe it stores (gray point, expired-rescue measurement), and exports
// reuse it.
// - R1-081: 1703835 built that tile with the full-resolution chain and the
//   preview downsample; #247's reduced tile decimates first wherever the
//   geometry core cannot plan the chain (an 8-bit source at a non-right
//   angle), so a recipe-preparing render keeps 1703835's order there.
//   Renders with a saved recipe only show it and keep the reduced path.
// - R1-082, R1-124: a watch-folder arrival's recipe is the full-resolution
//   one 1703835's arrival handler made, rendered in the lane from its one
//   decode, and a batch of arrivals starts no roll import of its own.
// Run with: node negative2positive/src/app/laneRecipeInputs.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLaneFixture, flush, functionSource as laneFunctionSource } from './backgroundLanesHarness.mjs';
import { isRawLikeFileName } from './imageFileLoaders.js';
import { ROLL_MONOCHROME } from './rollFilmType.js';

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
  'resolveLensCorrection', 'lensCorrectionActive', 'tileRecipeSettled', 'perPhotoSettingsFallback', 'expiredImportKeepsFullFrame',
  'autoFrameDetectionFilmType']
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
    isRawLikeFileName, ROLL_MONOCHROME,
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

// ---------------------------------------------------------------------------
// R1-082, R1-124: watch-folder arrivals, with the desktop IPC stubbed. The
// app's own arrival handlers, addFilesToQueue and light-table lane run; the
// renders are recorded. 1703835's handler rendered each arrival with
// processFileWithSettings(file, null, { bitDepth: 8 }): a full-resolution
// recipe (gray point and expired rescue measured on the whole frame), not
// marked automatic, one arrival at a time; 2.5 s after the last one, three
// or more formed a roll on top of their recipes and fewer were dropped.
// ---------------------------------------------------------------------------
const { readDesktopImportFile } = await import('./desktopImportReader.js');
const WATCH_FUNCTIONS = ['addFilesToQueue', 'createQueueItemId', 'receiveHotFolderArrival', 'hotFolderHas', 'queueHotFolderBatch',
  'noteHotFolderRecipe', 'scheduleHotFolderRoll'];

function watchFixture({ open = true } = {}) {
  const f = createLaneFixture({ count: open ? 1 : 0, current: 0, settings: true, tilesDone: true });
  const disk = new Map();
  const rolls = [], toasts = [], switched = [], released = [];
  Object.assign(f.context, {
    hotFolder: { session: 'S', path: '/watched' }, hotFolderEpoch: 1, hotFolderImports: Promise.resolve(), hotFolderFiles: [],
    hotFolderQuiet: null, hotFolderBatch: [], hotFolderBatchTimer: null, HOT_FOLDER_BATCH_MS: 1000,
    // The desktop side: the watched folder's files, read in checked chunks.
    window: { __TAURI__: { core: { invoke: async (command, args) => {
      assert.equal(command, 'read_import_file');
      assert.equal(args.session, 'S');
      const bytes = disk.get(args.path);
      return bytes.slice(args.offset, Math.min(bytes.length, args.offset + 8 * 1024 * 1024)).buffer;
    } } } },
    readDesktopImportFile,
    crypto: { randomUUID: () => 'import-id' },
    hasRollReference: () => false, syncBatchUIState: noop, updateFileListUI: noop, queueEmbeddedTiles: noop,
    updateExportButtons: noop, scheduleProjectRecovery: noop,
    scheduleAutomaticRollImport: (items, options) => rolls.push({ names: Array.from(items, item => item.file.name), options: { ...options } }),
    switchToFile: async index => {
      const item = f.state.fileQueue[index];
      switched.push(item.file.name);
      item.settings = { opened: item.file.name };
      f.state.currentFileIndex = index; f.state.loadedFile = item.file; f.state.originalImageData = {};
    },
    showToast: text => toasts.push(text),
    getInterpolatedText: (_key, _values, fallback) => fallback, getLocalizedText: (_key, fallback) => fallback,
    releaseOwnedPlanes: (...planes) => released.push(...planes)
  });
  f.state.originalImageData = open ? {} : null;
  vm.runInContext(WATCH_FUNCTIONS.map(laneFunctionSource).join('\n'), f.context);
  const arrive = async name => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + name.length) & 255);
    disk.set(`/watched/${name}`, bytes);
    f.context.receiveHotFolderArrival({ name, size: bytes.length, path: `/watched/${name}`, session: 'S', modified: '1700000000000000000' }, 1);
    await flush();
  };
  const item = name => f.state.fileQueue.find(entry => entry.file.name === name);
  // The lane's decode of `name`, then its renders: what each render is asked
  // for, answered as processFileWithSettings would.
  const decode = async name => {
    for (let i = 0; i < 40 && !f.decodes.some(record => record.file.name === name && !record.settled); i++) await f.clock.advance(250);
    const record = f.decodes.find(entry => entry.file.name === name && !entry.settled);
    assert.ok(record, `the lane decodes ${name}`);
    record.settled = true;
    record.resolve({ name, width: 4, height: 4, data: new Uint8ClampedArray(64) });
    await flush();
  };
  const pendingRender = name => f.renders.find(entry => entry.file.name === name && !entry.done);
  const recipeRender = async name => {
    const render = pendingRender(name);
    assert.ok(render, `a render of ${name} is pending`);
    assert.deepEqual([render.settings, render.options.stage, render.options.previewMaxDimension, render.options.silent],
      [null, 'processed', undefined, true], `${name}: a full-resolution recipe render, no tile size, no overlay`);
    assert.equal(render.options.updateItemSettings, false);
    render.done = true;
    render.options.ownedPlanes.push({ plane: name });
    render.resolve({ processed: { plane: name }, settings: { measuredOn: `full:${name}` } });
    await flush();
  };
  const tileRender = async name => {
    const render = pendingRender(name);
    assert.ok(render, `a tile render of ${name} is pending`);
    assert.equal(render.options.previewMaxDimension, 288, `${name}: then the tile`);
    assert.deepEqual({ ...render.settings }, { measuredOn: `full:${name}` }, `${name}: rendered from its full-resolution recipe`);
    render.done = true;
    render.options.onPreparedSettings?.({ measuredOn: `tile:${name}` });
    render.resolve({ preview: `tile:${name}` });
    await f.clock.advance(50);
  };
  return { ...f, rolls, toasts, switched, released, arrive, item, decode, recipeRender, tileRender };
}

// One capture while a photo is open: the lane gives it the recipe 1703835's
// handler made (full resolution, not automatic) and its tile from that
// recipe, from one decode. Alone it forms no roll.
{
  const f = watchFixture();
  await f.arrive('a.jpg');
  await f.clock.advance(1000);
  const a = f.item('a.jpg');
  assert.ok(a, 'queued after the batch window');
  assert.equal(a.importId, 'watch:S');
  assert.equal(a.settings, null, 'not converted on arrival');
  await f.decode('a.jpg');
  await f.recipeRender('a.jpg');
  await f.tileRender('a.jpg');
  assert.deepEqual({ ...a.settings }, { measuredOn: 'full:a.jpg' }, 'the recipe measured on the full-resolution frame');
  assert.notEqual(a.automaticSettings, true, 'not marked automatic: exports keep its gray point, as at 1703835');
  assert.equal(a.thumbnail, 'tile:a.jpg');
  assert.equal(a.thumbnailKey, JSON.stringify(a.settings), 'the tile is keyed by that recipe');
  assert.deepEqual(f.released, [{ plane: 'a.jpg' }], 'the full-resolution planes are released once measured');
  assert.equal(f.decodes.filter(record => record.file.name === 'a.jpg').length, 1, 'one decode');
  assert.deepEqual(Array.from(f.context.hotFolderFiles, entry => entry.file.name), ['a.jpg'], 'counted once its recipe exists');
  await f.clock.advance(2500);
  assert.deepEqual(f.rolls, [], 'one recipe is not a roll');
  assert.equal(f.context.hotFolderFiles.length, 0, 'and is dropped, as at 1703835');
}

// Three captures within 1 s: one addFilesToQueue call, no roll import of
// their own; each gets its own full-resolution recipe. Recipes that land
// more than 2.5 s apart (full-resolution renders of real captures; 1703835's
// handler took about 17 s per 60 MP capture) never form a roll. Recipes that
// land within 2.5 s of each other form one on top of them, as at 1703835.
for (const gap of [3000, 500]) {
  const f = watchFixture();
  for (const name of ['1.jpg', '2.jpg', '3.jpg']) { await f.arrive(name); await f.clock.advance(300); }
  await f.clock.advance(1000);
  const names = ['1.jpg', '2.jpg', '3.jpg'];
  assert.deepEqual(names.map(name => f.item(name)?.importId), ['watch:S', 'watch:S', 'watch:S'], 'one batch');
  assert.deepEqual(f.rolls, [], `gap ${gap}: a batch of three starts no roll import (no roll-analysis recipes instead of their own)`);
  for (const name of names) {
    await f.decode(name);
    await f.recipeRender(name);
    await f.tileRender(name);
    assert.deepEqual({ ...f.item(name).settings }, { measuredOn: `full:${name}` }, `gap ${gap}: ${name} has its own full-resolution recipe`);
    assert.notEqual(f.item(name).automaticSettings, true);
    if (name !== '3.jpg') await f.clock.advance(gap);
  }
  assert.equal(f.renders.filter(render => render.options.stage === 'processed').length, 3, 'three full-resolution recipe renders');
  await f.clock.advance(2500);
  if (gap > 2500) assert.deepEqual(f.rolls, [], 'recipes 3 s apart form no roll: each frame exports with its own recipe');
  else assert.deepEqual(f.rolls, [{ names, options: { prepared: true } }], 'recipes within the quiet window form a roll on top of them');
  assert.equal(f.toasts.length, 1);
}

// Nothing open: the first arrival of a batch opens (its recipe is the
// editor's, as at 1703835) and counts once open; the lane makes the others'.
{
  const f = watchFixture({ open: false });
  for (const name of ['x.jpg', 'y.jpg']) await f.arrive(name);
  await f.clock.advance(1000);
  assert.deepEqual(f.switched, ['x.jpg']);
  assert.deepEqual(Array.from(f.context.hotFolderFiles, entry => entry.file.name), ['x.jpg']);
  await f.decode('y.jpg');
  await f.recipeRender('y.jpg');
  await f.tileRender('y.jpg');
  assert.deepEqual({ ...f.item('y.jpg').settings }, { measuredOn: 'full:y.jpg' });
  assert.equal(f.renders.some(render => render.file.name === 'x.jpg'), false, 'the open photo is the foreground\'s');
  assert.deepEqual(Array.from(f.context.hotFolderFiles, entry => entry.file.name), ['x.jpg', 'y.jpg']);
}

// A frame imported with the picker keeps the lane's tile recipe (1703835's
// lane did the same): marked automatic, no full-resolution render.
{
  const f = watchFixture();
  f.context.addFilesToQueue([new File([new Uint8Array(10)], 'p.jpg')]);
  await f.decode('p.jpg');
  const render = f.renders.find(entry => entry.file.name === 'p.jpg');
  assert.equal(render.options.previewMaxDimension, 288, 'only the tile render');
  render.done = true;
  render.options.onPreparedSettings({ measuredOn: 'tile:p.jpg' });
  render.resolve({ preview: 'tile:p.jpg' });
  await f.clock.advance(50);
  assert.deepEqual({ ...f.item('p.jpg').settings }, { measuredOn: 'tile:p.jpg' });
  assert.equal(f.item('p.jpg').automaticSettings, true);
  assert.equal(f.renders.length, 1);
}

console.log('laneRecipeInputs: recipe-preparing lane renders measure 1703835\'s tile; saved-recipe renders keep the reduced path; watch-folder arrivals get full-resolution recipes, no roll import of their own');
