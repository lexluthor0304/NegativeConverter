import { MEMORY_FUNCTIONS, memoryGlobals } from './memoryHarness.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runBatchPipeline } from './batchExportScheduler.js';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { createJobMarker, readJobMarker, JOB_MARKER_KEYS } from './jobMarker.js';
import { aggregateRollAnalysis, groupAutomaticRollFrames, sanitizeRollFrameForSettings } from './rollAnalysis.js';
import { decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, ROLL_MONOCHROME } from './rollFilmType.js';
import { applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { applyLearnedDefaults, learnedDefaultsKey, withoutLearnedDefaults } from './learnedDefaults.js';
import { canPublishThumbnail } from './thumbnailRank.js';
import { createSharedDecodes } from './sharedDecodes.js';
import { pickBackgroundJob, travelDirection, displayDistance } from './backgroundPhotoScheduler.js';
import { createPhotoSessionCache } from './photoSessionCache.js';
import { SCHEDULER_FUNCTIONS } from './backgroundLanesHarness.mjs';
import { createRollSampleCache } from './rollSampleCache.js';
import { reducedTileGeometry, tileGeometryKey } from './reducedGeometry.js';
import { sanitizeCropRect, rotatedDimensions } from './imageGeometry.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';
import { createDecodeSlots, rollAnalysisFootprint } from './batchExportScheduler.js';
import { primeFilmStats } from './filmStatsCache.js';
import { rollSampleSettings } from './rollSample.js';

// Test the actual orchestration functions, not a second scheduler. Deferred
// decoders/analysis replies make navigation and recipe races deterministic.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
// Pass 1 runs in the background lanes (#243), which yield a macrotask between jobs.
const flush = async () => { for (let i = 0; i < 80; i++) await new Promise(setImmediate); };
const recipe = id => ({ filmType: 'color', filmBase: { r: 210, g: 140, b: 90, method: 'auto' }, filmEdge: { checked: true }, id });
const channels = [0, 1, 2].map(() => ({ whitePointOrigin: 50000, blackPointOrigin: 500, meanPoint: 0.5 }));

// Film-type orchestration (#231) is evaluated with the roll import it feeds.
const FILM_TYPE_FUNCTIONS = ['importFilmTypeRoll', 'importFilmTypeActive', 'createImportFilmTypeRoll', 'liveImportSettings',
  'importFilmTypeLocked', 'refreshImportFilmTypeDecision', 'importFilmTypeTarget', 'settleImportFilmType',
  'scheduleImportFilmTypeUpdate', 'relearnImportSettings', 'retypeImportItem', 'applyImportFilmTypeDecision',
  'flipImportPhoto', 'finalizeImportFilmType', 'deferImportFilmTypeToast', 'showImportFilmTypeToast', 'applyImportPositives'];
const VERDICTS = {
  mono: { filmType: 'bw', filmTypeConfidence: 'low', filmTypeReason: 'monochrome' },
  noMask: { filmType: 'positive', filmTypeConfidence: 'medium', filmTypeReason: 'noMask' },
  warm: { filmType: 'positive', filmTypeConfidence: 'low', filmTypeReason: 'warmScene' },
  orange: { filmType: 'color', filmTypeConfidence: 'medium', filmTypeReason: 'orangeMask' }
};

function fixture({ count = 4, prepared = false, realRoll = false, verdicts = null } = {}) {
  if (verdicts) count = verdicts.length;
  // With verdicts, every recipe carries an automatic detection as the app's do.
  const make = id => verdicts
    ? { ...recipe(id), ...VERDICTS[verdicts[id]], filmTypeSource: 'auto', positiveMode: 'correct', filmEdge: { checked: true, found: false } }
    : recipe(id);
  const items = Array.from({ length: count }, (_, index) => ({
    id: index, file: { name: `${index}.png`, size: 100 }, selected: true,
    settings: prepared ? make(index) : null, isDirty: false, ...(verdicts ? { importId: 'import-1' } : {})
  }));
  const pixels = id => ({ width: 10, height: 10, id });
  const state = {
    fileQueue: items, currentFileIndex: 0, loadedFile: items[0].file,
    loadedBaseImageData: pixels(0), originalImageData: pixels(0),
    currentStep: 3, rollReference: { applyLock: false }, rollAnalysis: {},
    importFilmTypeAuto: true, cropping: false, positiveMode: 'correct', rollMetadata: {},
    autoFrame: { enabled: true }
  };
  const timers = new Map(), decoded = [], analyzed = [], groups = [], stores = [], restored = [], renders = [], undos = [];
  const markerMap = new Map();
  const markerStorage = { get: key => markerMap.get(key) ?? null, set: (key, value) => markerMap.set(key, value), remove: key => markerMap.delete(key) };
  const toasts = [], frameTypes = [], samplesBuilt = [], importRequests = [];
  const frameRenders = [], flushed = [];
  const tileSources = new Map(), laneStarts = [], tileRenders = [];
  let frameWorkersDisposed = 0;
  const analyzerPools = { created: 0, disposed: 0 }, rollPools = [], idleHolds = [];
  let timerId = 0;
  const noop = () => {};
  const context = vm.createContext({
    ...memoryGlobals(),
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, console, Map, Set, AbortController, structuredClone,
    AUTO_ROLL_KEY: 'auto', automaticRollRevision: 0, automaticRollPendingItems: new Set(),
    automaticRollImportRunning: false, automaticRollAnalysisRunning: false,
    studioAutoFrameRunning: false, processNegativeInFlight: null,
    loadGeneration: 1, manualEditRevision: 0, off: false,
    document: { body: { dataset: {} }, getElementById: () => null },
    studioWorkspace: { sync: noop },
    setTimeout(fn, ms) {
      if (ms === 0) { queueMicrotask(fn); return 0; }
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    yieldTaskForJob: () => new Promise(resolve => context.setTimeout(resolve, 0)),
    hiddenJobs: createHiddenJobGate({ isHidden: () => false }), hiddenJobBytesFor: async () => 0,
    createJobMarker, jobMarkerStorage: markerStorage, recoveryWrites: 0,
    parkedPhoto: null,
    safeStorageGet: () => context.off ? 'off' : null,
    studioBackgroundReady: () => state.currentStep >= 3 && context.getCurrentQueueItem()?.file === state.loadedFile
      && !context.document.body.dataset.studioBusy && !context.processNegativeInFlight,
    getCurrentQueueItem: () => items[state.currentFileIndex],
    extractCurrentSettings: () => state.liveSettings || make(state.currentFileIndex),
    persistCurrentFileSettings: () => {
      const item = items[state.currentFileIndex];
      if (item.file !== state.loadedFile) return;
      item.settings ||= make(item.id);
      if (item.isDirty && state.liveSettings) item.settings = structuredClone(state.liveSettings);
      item.isDirty = false;
    },
    canReuseLoadedRollSource: item => item === items[state.currentFileIndex],
    createAnalysisSampleStore: () => {
      const values = new Map();
      const store = { cleared: false, values,
        async put(key, value) { values.set(key, value); },
        async get(key) { return values.get(key) || null; },
        async delete(key) { values.delete(key); },
        async clear() { store.cleared = true; values.clear(); }
      };
      stores.push(store);
      return store;
    },
    // Roll samples carry their tile context (#247 2b).
    buildRollSample: (image) => {
      samplesBuilt.push(image.id);
      return { ...image, __baseSize: { width: image.width, height: image.height }, __analysisReference: null };
    },
    planBatchLanes: async () => 1,
    createAutoFrameWorkerPool: () => { analyzerPools.created++; return { analyze: noop, analyzeImport: noop, dispose: () => { analyzerPools.disposed++; } }; },
    // #252: roll-analysis lanes, the roll's workers and the lane decode.
    planRollAnalysisLanes: async files => ({ ...(context.rollPlan || {}), decodeSlots: context.rollPlan?.decodeSlots || 1,
      framesInFlight: context.rollPlan?.framesInFlight || await context.planBatchLanes(files), slotBytes: Infinity }),
    createDecodeSlots, primeFilmStats, rollSampleSettings, STUDIO_TILE_PREVIEW_MAX: 288,
    createRollFramePool: config => { const pool = context.rollFramePoolFactory(config); rollPools.push(pool); return pool; },
    rollFramePoolFactory: () => ({ frame: () => null, warm: noop, resize: noop, dispose() { this.disposed = true; } }),
    analyzeFrameInWorker: { holdIdle: () => { idleHolds.push(true); return () => idleHolds.push(false); } },
    rollFrameWorkerUsable: () => false,
    rollFrameDecodable: file => /\.(dng|nef)$/i.test(file.name),
    autoFrameAnalyzerOptions: ({ filmType, rotatedOutput }) => ({ settings: { enabled: true, filmType, lastDiagnostics: null }, rotatedOutput }),
    defaultFilmBaseBuffer: () => 10,
    rememberImageDimensions: noop, rotatedDimensions,
    buildRollSampleOf: (image, settings, options) => ({ ...image, halfSample: true, fullSize: options.fullSize, __baseSize: options.fullSize, __analysisReference: null }),
    createPerfTrace: () => ({ end: noop }), runBatchPipeline,
    loadFileToImageData: async file => { const id = Number(file.name.split('.')[0]); decoded.push(id); return pixels(id); },
    createDefaultSettings: (_image, item) => make(item.id),
    analyzeStudioImportFrame: async (_image, settings, options = {}) => { frameTypes.push(options.filmType); return settings; },
    // Frame and film edge of a lane's own decode in one request (#251).
    runImportDetections: async (image, options) => { importRequests.push(options); return { image, detection: { result: null }, read: { result: null } }; },
    mergeImportFilmEdge: async (_image, settings) => ({ settings }),
    learnedImportSettings: async settings => settings,
    groupAutomaticRollFrames, aggregateRollAnalysis, sanitizeRollFrameForSettings,
    notifyImportReview: noop, updateFileListUI: noop, scheduleProjectRecovery: () => { context.recoveryWrites++; },
    runRollAnalysis: async ({ items: group }) => {
      if (!context.studioBackgroundReady()) return { status: 'deferred' };
      groups.push(group.map(item => item.id));
      for (const item of group) item.settings.rollFrame = { rollId: 'complete' };
      return { status: 'committed' };
    },
    isDesktopBatchExportLocked: () => false,
    isCurrentLoad: generation => generation === context.loadGeneration,
    getLocalizedText: (_key, fallback) => fallback,
    getInterpolatedText: (_key, _args, fallback) => fallback,
    appAlert: noop, showBatchProgress: noop, updateBatchProgress: noop,
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw Object.assign(new Error('stale'), { name: 'AbortError' }); },
    cloneSettings: value => structuredClone(value),
    measureNegativeMean: () => 0.4,
    requiresFilmBase: () => true,
    analyzeSilverCoreFrame: async image => { analyzed.push(image.id); return channels; },
    buildCoreConversionSettings: settings => settings,
    resolveConversionMode: () => 'color', usesSilverCoreConversion: () => true,
    downsampleImageDataForMaxDim: image => image,
    convertFrameWithRouter: async ({ imageData }) => imageData,
    createAdjustedPhotoPreview: image => image,
    buildAdjustmentSettings: settings => settings,
    thumbnailDataUrl: image => `thumbnail:${image.id}`,
    photoSettingsKey: item => JSON.stringify(item.settings),
    pushUndo: label => undos.push({ label, file: state.loadedFile }),
    invalidateSilverCoreCache: noop,
    restoreSettings: settings => {
      restored.push(settings.id);
      for (const key of ['filmType', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason']) state[key] = settings[key];
    },
    updateRollAnalysisUI: noop,
    showToast: (text, duration, options) => toasts.push({ text, duration, action: options?.action || null }),
    processNegative: async options => renders.push({ id: state.currentFileIndex, options }),
    importFilmTypeRolls: new Map(), learnedRecords: new Map(), i18n: { en: { filmTypeMonochrome: 'Monochrome' } }, currentLang: 'en',
    decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, ROLL_MONOCHROME,
    applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride, applyLearnedDefaults, learnedDefaultsKey, withoutLearnedDefaults,
    scheduleSilverSourceRefresh: noop, schedulePreviewUpdate: noop,
    // Per-frame analysis tiles: a deferred worker conversion per frame.
    canPublishThumbnail, frameThumbnailWorkers: null, frameThumbnailJobs: new Set(),
    createConversionWorkerPool: () => Object.assign(request => {
      const gate = deferred();
      frameRenders.push({ request, ...gate });
      return gate.promise;
    }, { dispose: () => { frameWorkersDisposed++; } }),
    scheduleTileFlush: item => flushed.push(item.id),
    // The background lanes (#243): an always idle gate, no photo caches or
    // prefetch, the display order is the queue order, no lane tiles.
    DOMException, backgroundGate: { idle: async () => true, isIdle: () => true, bump: noop, noteInput: noop },
    photoSessions: createPhotoSessionCache({ maxBytes: 0 }), photoPreviews: createPhotoSessionCache({ maxBytes: 0 }),
    photoPrefetch: createPhotoSessionCache({ maxBytes: 0 }), lowMemoryPhotoDevice: () => true,
    backgroundLanes: { running: 0, active: new Map() }, rollPassRequests: new Set(), backgroundVisibleItems: new Set(),
    backgroundDirection: 1, prefetchedItem: null, backgroundWorkers: null, prefetchPreviewAttempts: new WeakMap(), prefetchRefused: new WeakSet(),
    BACKGROUND_LANE_REST_MS: 30, BACKGROUND_LANE_POLL_MS: 250, ACTIVATION_DWELL_MS: 120, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    pickBackgroundJob, travelDirection, displayDistance,
    getFileListOrder: () => state.fileQueue.map((_, index) => index), reviewFilter: false, reviewForItem: () => ({ needs: false }),
    // Canonical tiles from roll samples (#247): the real render/publish
    // orchestration around a recording renderer on the tile converter.
    thumbnailSources: { put: (item, source) => tileSources.set(item, source) },
    watchRollSamples: createRollSampleCache(1024 * 1024),
    updateFileThumbnail: noop, STUDIO_TILE_PREVIEW_MAX: 288, reducedTileGeometry, tileGeometryKey,
    sanitizeCropRegionForImage: sanitizeCropRect, sanitizeSettings: settings => structuredClone(settings),
    perPhotoSettingsFallback: () => ({}), lensCorrectionActive: settings => Boolean(settings.lensActive),
    createTileConverter: () => Object.assign(request => context.convertFrameWithRouter(request), { dispose: noop }),
    renderPreviewFromWorkingImage: async (working, settings, ctx) => {
      tileRenders.push({ id: working.id, settings, ctx });
      const converted = await ctx.convert({ imageData: working, settings, options: {} });
      if (!ctx.isCurrent()) throw Object.assign(new Error('stale'), { name: 'AbortError' });
      return converted;
    },
  });
  context.sharedDecodes = createSharedDecodes({ decode: (file, { signal }) => context.decodeForBackground(file, signal) });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'getCurrentQueueItem', 'automaticRollItemKey', 'scheduleAutomaticRollImport', 'createRollAnalysisWorkers', 'decodeRollFrame',
    'rollAnalysisHalfSize', 'scaleHalfSizeCrop', ...FILM_TYPE_FUNCTIONS,
    'renderFrameAnalysisThumbnail', 'releaseFrameThumbnailWorkers', 'renderSampleTile', 'publishSampleTile', 'renderRollSampleTiles',
    ...(realRoll ? ['runRollAnalysis'] : []),
    ...SCHEDULER_FUNCTIONS.filter(name => name !== 'backgroundRest'), ...MEMORY_FUNCTIONS]
    .map(functionSource).join('\n'), context);
  // Lanes rest a macrotask, not a timer; tiles are not part of these tests.
  context.backgroundRest = () => new Promise(resolve => setImmediate(resolve));
  context.laneTileWanted = () => false;
  // Lane starts, with the frames the import still owns at each (#247 2e).
  const kick = context.kickBackgroundPhotoWork;
  context.kickBackgroundPhotoWork = () => { laneStarts.push(context.automaticRollPendingItems.size); kick(); };
  const fire = async (ms) => {
    const entry = [...timers].find(([, timer]) => ms === undefined || timer.ms === ms);
    assert.ok(entry, `scheduled timer ${ms ?? 'any'} exists`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  };
  const navigate = (index, { busy = false } = {}) => {
    context.loadGeneration++;
    state.currentFileIndex = index;
    if (busy) context.document.body.dataset.studioBusy = 'true';
    else {
      state.loadedFile = items[index].file;
      state.loadedBaseImageData = state.originalImageData = pixels(index);
      delete context.document.body.dataset.studioBusy;
    }
  };
  const marker = () => readJobMarker(markerStorage, { key: JOB_MARKER_KEYS.roll });
  // The foreground photo as prepareStudioPhoto leaves it: its own verdict is
  // recorded and the import's decision applied.
  const prepareForeground = (index = state.currentFileIndex) => {
    const settings = context.settleImportFilmType(items[index], make(index));
    items[index].settings = settings;
    for (const key of ['filmType', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason']) state[key] = settings[key];
  };
  return { context, state, items, timers, decoded, analyzed, groups, stores, restored, renders, undos, toasts, frameTypes, samplesBuilt, importRequests, fire, navigate, make, prepareForeground, marker,
    frameRenders, flushed, frameWorkersDisposed: () => frameWorkersDisposed, tileSources, laneStarts, tileRenders, analyzerPools, rollPools, idleHolds };
}

// Exactly two imported photos must leave the thumbnail queue independent.
{
  const f = fixture({ count: 2 });
  f.context.scheduleAutomaticRollImport(f.items);
  assert.equal(f.timers.size, 0);
  assert.equal(f.context.automaticRollImportRunning, false);
  assert.equal(f.context.automaticRollPendingItems.size, 0, 'a two-photo import keeps its semantic pass');
}

// A scheduled roll marks its frames (the first photo's semantic pass skips
// them) until it finishes, then releases them.
{
  const f = fixture();
  f.context.scheduleAutomaticRollImport(f.items);
  assert.deepEqual([...f.context.automaticRollPendingItems], f.items);
  await f.fire(1200);
  assert.equal(f.groups.length, 1);
  assert.equal(f.context.automaticRollPendingItems.size, 0, 'finish releases the frames');
}

// Navigation during decode no longer throws away other detached measurements.
// The newly foreground photo owns its own recipe (it adopts the lane's decode,
// #243); unvisited neighbours wait while the foreground is busy, then finish.
{
  const f = fixture();
  const held = deferred();
  const decode = f.context.loadFileToImageData;
  f.context.loadFileToImageData = async file => file === f.items[1].file ? held.promise : decode(file);
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  f.navigate(1, { busy: true });
  assert.equal(f.context.getCurrentQueueItem(), null, 'requested photo is not loaded yet');
  held.resolve({ id: 1, width: 10, height: 10 });
  await flush();
  assert.equal(f.items[1].settings, null, 'background never overwrites a foreground preparation');
  assert.ok(!f.items[2].settings && !f.items[3].settings, 'no background decode starts while the foreground is busy');
  assert.deepEqual(f.decoded, [], 'nothing else was decoded meanwhile');
  assert.equal(f.context.automaticRollImportRunning, true, 'pass 1 waits for the foreground instead of retrying');
  // The job marker (#241) is written when the analysis starts.
  const running = f.marker();
  assert.equal(running?.kind, 'roll-analysis');
  assert.equal(running.files.length, 4);
  // The foreground settles with its own recipe; the lanes finish the rest.
  f.navigate(1);
  f.items[1].settings = recipe(1);
  await flush();
  assert.ok(f.items[2].settings && f.items[3].settings, 'unrelated frames are prepared after the switch');
  assert.ok(f.context.recoveryWrites >= 2, 'each analysed frame schedules the recovery copy');
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].length, 4);
  assert.deepEqual(f.decoded, [2, 3], 'one decode per background frame; the opened frame\'s went to the foreground');
  assert.equal(f.timers.size, 0, 'no resume timer');
  assert.ok(f.stores.every(store => store.cleared), 'sample storage is disposed after completion');
  assert.equal(f.marker(), null, 'the marker is deleted when the analysis ends');
}

// A manual edit / removed item is excluded, not retried forever or overwritten.
for (const change of ['edit', 'remove', 'recipe', 'cancel']) {
  const f = fixture();
  const held = deferred();
  f.context.analyzeStudioImportFrame = async (_image, settings) => settings.id === 1 ? held.promise : settings;
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  const changed = f.items[1];
  if (change === 'edit') { changed.userEdited = true; changed.settings = { ...recipe(1), coreExposure: 31 }; }
  if (change === 'remove') f.state.fileQueue = f.items.filter(item => item !== changed);
  if (change === 'recipe') { changed.settings = { ...recipe(1), coreExposure: 47 }; }
  if (change === 'cancel') f.context.automaticRollRevision++;
  held.resolve(recipe(1));
  await flush();
  if (f.timers.size) await f.fire(750);
  if (change === 'edit') assert.equal(changed.settings.coreExposure, 31);
  if (change === 'recipe') assert.equal(changed.settings.coreExposure, 47);
  if (change === 'remove') assert.equal(changed.settings, null);
  if (change === 'cancel') assert.equal(f.groups.length, 0);
  assert.equal(f.timers.size, 0, 'no edit/cancel retry loop');
  assert.ok(f.stores.every(store => store.cleared));
}

// The real aggregation path survives a generation change, and only refreshes
// the current photo when it belongs to the committed group.
for (const destination of [1, 3]) {
  const f = fixture({ prepared: true, realRoll: true });
  const held = deferred();
  let first = true;
  f.context.analyzeSilverCoreFrame = async image => {
    f.analyzed.push(image.id);
    if (first) { first = false; await held.promise; }
    return channels;
  };
  const pending = f.context.runRollAnalysis({ items: f.items.slice(0, 3), automatic: true });
  await flush();
  f.navigate(destination);
  held.resolve();
  const result = await pending;
  assert.equal(result.status, 'committed');
  assert.equal(f.items.slice(0, 3).filter(item => item.settings.rollFrame?.locked).length, 3);
  // #247 2b: the roll renders each frame's tile as the lane would (dust,
  // repair, per-photo WB, analysis reference), so default recipes are final.
  assert.ok(f.items.slice(0, 3).every(item => item.thumbnailKind === 'processed'
    && item.thumbnailKey === f.context.photoSettingsKey(item) && item.thumbnail === `thumbnail:${item.id}`),
    'roll tiles of default recipes are canonical');
  assert.ok(f.items.slice(0, 3).every(item => f.tileSources.get(item)?.geometryKey), 'and each keeps its tile source');
  assert.deepEqual(f.analyzed, [0, 1, 2]);
  assert.deepEqual(f.restored, destination === 1 ? [1] : [], 'never restore an unrelated photo');
  assert.equal(f.renders.length, destination === 1 ? 1 : 0, 'never reconvert an unrelated photo');
  if (f.renders.length) assert.equal(f.renders[0].options.quiet, true);
}

// Real aggregation refuses stale recipes, queue removals, dirty live settings,
// explicit roll cancellation and import opt-out even if no generation changed.
for (const change of ['recipe', 'edit', 'dirty', 'remove', 'cancel', 'off']) {
  const f = fixture({ prepared: true, realRoll: true });
  const held = deferred();
  f.context.analyzeSilverCoreFrame = async () => { await held.promise; return channels; };
  const pending = f.context.runRollAnalysis({ items: f.items.slice(0, 3), automatic: true });
  await flush();
  if (change === 'recipe') f.items[1].settings = { ...recipe(1), coreExposure: 57 };
  if (change === 'edit') f.items[1].userEdited = true;
  if (change === 'dirty') { f.items[0].isDirty = true; f.state.liveSettings = { ...recipe(0), coreExposure: 23 }; }
  if (change === 'remove') f.state.fileQueue = f.items.filter(item => item.id !== 1);
  if (change === 'cancel') f.context.automaticRollRevision++;
  if (change === 'off') f.context.off = true;
  held.resolve();
  assert.equal((await pending).status, 'stale', change);
  assert.equal(f.undos.length, 0, 'stale roll never creates undo or commits recipes');
  assert.ok(f.items.every(item => !item.settings.rollFrame));
  assert.equal(f.renders.length, 0);
  assert.ok(f.stores.every(store => store.cleared));
}

// Finish measuring while foreground decode owns the viewer, but defer the
// atomic commit without repeating the measurements or touching its undo state.
{
  const f = fixture({ prepared: true, realRoll: true });
  const held = deferred();
  const convert = f.context.convertFrameWithRouter;
  f.context.convertFrameWithRouter = async request => {
    if (request.imageData.id === 2) await held.promise;
    return convert(request);
  };
  const pending = f.context.runRollAnalysis({ items: f.items.slice(0, 3), automatic: true });
  await flush();
  f.navigate(3, { busy: true });
  held.resolve(); await flush();
  assert.equal(f.undos.length, 0);
  assert.deepEqual(f.analyzed, [0, 1, 2]);
  f.navigate(3);
  await f.fire(250);
  assert.equal((await pending).status, 'committed');
  assert.deepEqual(f.analyzed, [0, 1, 2], 'settlement does not repeat completed analysis');
  assert.equal(f.undos[0].file, f.items[3].file);
  assert.equal(f.renders.length, 0);
}

// #231, the M11 roll: a noMask leader is the open photo, the rest are
// uncertain monochrome frames. The decision types the whole roll while pass 1
// runs, flips the untouched leader from its loaded base, keeps the pass-1
// samples valid and runs one B&W roll analysis without decoding again.
{
  const f = fixture({ verdicts: ['noMask', 'mono', 'mono', 'mono', 'mono'], realRoll: true });
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  assert.equal(f.items[0].settings.filmType, 'positive', 'alone, the leader has no evidence');
  await f.fire(1200);
  assert.deepEqual(f.decoded, [1, 2, 3, 4], 'one decode per background frame');
  assert.deepEqual(f.samplesBuilt, [0, 1, 2, 3, 4], 'roll analysis reused every pass-1 sample, the leader\'s included');
  assert.ok(f.items.every(item => item.settings.filmType === 'bw' && item.settings.filmTypeSource === 'auto'
    && item.settings.filmTypeConfidence === 'medium' && item.settings.filmTypeReason === 'rollMonochrome'), 'all frames typed by the roll');
  assert.ok(f.items.every(item => item.settings.rollFrame?.locked), 'one B&W roll analysis covers all five frames');
  assert.equal(f.restored[0], 0, 'the leader was flipped through restoreSettings');
  assert.equal(f.renders[0].options.quiet, true);
  assert.equal(f.undos.filter(entry => entry.label !== 'rollAnalysis').length, 0, 'the decision adds no undo entry');
  assert.deepEqual(new Set(f.frameTypes), new Set(['positive']), 'auto-frame kept the film type pass 1 started with');
  // #251: frame and film edge in one request per frame, on the lane's own
  // analyzer. A lane's base is a shared decode the foreground may adopt
  // (#243), so its 8-bit plane is copied, never transferred.
  assert.equal(f.importRequests.length, 4);
  assert.ok(f.importRequests.every(request => request.owned === false && request.frame === true && request.analyzer),
    'lane requests copy the shared base');
  assert.ok(f.importRequests.every(request => request.filmEdge === false), 'a recipe whose edge was read is not read again');
  assert.deepEqual(new Set(f.importRequests.map(request => request.filmType)), new Set(['positive']), 'the roll decision scores the frame');
  assert.deepEqual(f.importRequests.map(request => request.frameFilmType), ['bw', 'bw', 'bw', 'bw'], 'the frame\'s own type picks the line-search planes');
  const rollToasts = f.toasts.filter(toast => toast.action?.id === 'rollPositives');
  assert.equal(rollToasts.length, 1, 'one toast per import');
  assert.deepEqual(f.toasts.filter(toast => !toast.action).map(toast => toast.text.split(':')[0]), ['Roll analysis'], 'no per-frame film-type prompt');
  assert.equal(f.timers.size, 0);
  // These are positives: exactly the typed frames, one undo step.
  rollToasts[0].action.onClick();
  assert.deepEqual(f.undos.map(entry => entry.label).filter(label => label !== 'rollAnalysis'), ['rollFilmType']);
  assert.ok(f.items.every(item => item.filmTypeOverride?.filmType === 'positive' && item.settings.filmType === 'positive'
    && item.settings.filmTypeSource === 'manual'));
  assert.equal(f.state.filmType, 'positive', 'the open photo follows the correction');
  assert.equal(f.context.automaticRollRevision, 1);
}

// A colour roll after the B&W roll: a run of noMask frames and a warm scene.
// Only the frame next to the B&W segment is retyped.
{
  const f = fixture({ verdicts: ['mono', 'mono', 'mono', 'mono', 'noMask', 'noMask', 'warm', 'noMask'] });
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  await f.fire(1200);
  assert.deepEqual(f.items.map(item => item.settings.filmType), ['bw', 'bw', 'bw', 'bw', 'bw', 'positive', 'positive', 'positive']);
  assert.deepEqual(f.items.map(item => item.settings.filmTypeReason),
    ['rollMonochrome', 'rollMonochrome', 'rollMonochrome', 'rollMonochrome', 'rollMonochrome', 'noMask', 'warmScene', 'noMask']);
  assert.deepEqual(f.groups, [[0, 1, 2, 3, 4]], 'the colour frames stay out of the B&W analysis');
  assert.equal(f.toasts.filter(toast => toast.action).length, 1);
  assert.ok(f.toasts[0].text.includes('5'), 'the toast counts the typed frames');
  // The correction leaves the colour roll alone.
  f.toasts[0].action.onClick();
  assert.deepEqual(f.items.map(item => item.filmTypeOverride?.filmType || null), ['positive', 'positive', 'positive', 'positive', 'positive', null, null, null]);
}

// An edited open photo and a manual type are never retyped; the roll still
// forms around them and a frame the user edited keeps voting with its type.
{
  const f = fixture({ verdicts: ['noMask', 'mono', 'mono', 'mono', 'noMask'] });
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  f.items[0].userEdited = true;
  f.items[4].filmTypeOverride = { filmType: 'positive', positiveMode: 'correct' };
  await f.fire(1200);
  assert.equal(f.items[0].settings.filmType, 'positive', 'edited leader keeps its type');
  assert.equal(f.restored.length, 0, 'no flip of an edited photo');
  assert.equal(f.renders.length, 0);
  assert.deepEqual(f.items.slice(1, 4).map(item => item.settings.filmTypeReason), ['rollMonochrome', 'rollMonochrome', 'rollMonochrome']);
  assert.equal(f.items[4].settings.filmTypeReason, 'noMask', 'an overridden frame is left alone');
}

// No segment: the open photo's monochrome prompt, deferred at import, is
// shown once the decision is known. Single B&W frames keep their review flag.
{
  const f = fixture({ verdicts: ['mono', 'orange', 'noMask', 'orange'] });
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  assert.equal(f.context.deferImportFilmTypeToast(f.items[0], f.items[0].settings), true, 'deferred during the import');
  await f.fire(1200);
  assert.equal(f.items[0].settings.filmTypeConfidence, 'low');
  assert.deepEqual(f.toasts.map(toast => toast.text), ['Monochrome']);
  assert.equal(f.context.deferImportFilmTypeToast(f.items[0], f.items[0].settings), false, 'after the decision a prompt is shown directly');
}

// Watch-folder batch: frames arrive prepared, and a later export of a frame
// that pass 1 never read takes the recorded decision.
{
  const f = fixture({ verdicts: ['mono', 'mono', 'noMask', 'mono', 'mono'], prepared: true });
  f.state.filmType = 'bw'; f.state.filmTypeSource = 'auto'; f.state.filmTypeConfidence = 'low'; f.state.filmTypeReason = 'monochrome';
  f.context.scheduleAutomaticRollImport(f.items.slice(0, 4), { prepared: true });
  await f.fire(1200);
  assert.deepEqual(f.decoded, [], 'prepared frames are not decoded');
  assert.equal(f.items[2].settings.filmTypeReason, 'rollMonochrome', 'noMask between B&W frames');
  assert.equal(f.items[0].settings.filmTypeReason, 'rollMonochrome');
  assert.equal(f.state.filmTypeReason, 'rollMonochrome', 'the open photo was confirmed');
  const late = f.context.settleImportFilmType(f.items[4], f.make(4));
  assert.equal(late.filmTypeReason, 'monochrome', 'a frame outside the batch is not part of its decision');
}

// Retypes re-apply learned defaults under the B&W key.
{
  const f = fixture({ verdicts: ['mono', 'mono', 'mono', 'noMask'] });
  const record = { version: 1, key: '', rolls: ['a', 'b', 'c'].map(id => ({ id, frames: { x: { coreContrast: 12 } } })) };
  const key = learnedDefaultsKey({ filmType: 'bw' }, {});
  f.context.learnedRecords.set(key, { ...record, key });
  f.context.learnedImportSettings = async (settings, item) => {
    item.automaticDefaults ||= structuredClone(settings);
    const learned = f.context.learnedRecords.get(learnedDefaultsKey(settings, {}));
    return learned ? applyLearnedDefaults(settings, learned) : settings;
  };
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  await f.fire(1200);
  assert.equal(f.items[3].settings.filmType, 'bw');
  assert.equal(f.items[3].settings.learnedDefaults?.key, key, 'learned defaults follow the new key');
  assert.equal(f.items[3].automaticDefaults.filmType, 'bw', 'later learning compares against the B&W recipe');
}

// Per-frame analysis thumbnails: each measured frame gets a converted tile
// without blocking the next decode; they never downgrade a converted tile and
// the roll commit still replaces them.
{
  const f = fixture({ count: 5 });
  f.items[2].thumbnail = 'data:processed'; f.items[2].thumbnailKind = 'processed';
  f.items[3].thumbnail = 'data:embedded'; f.items[3].thumbnailKind = 'embedded';
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  // Frames 1-4 were decoded and sunk while every render is still pending.
  assert.deepEqual(f.decoded, [1, 2, 3, 4], 'renders never hold back the next decode');
  assert.equal(f.frameRenders.length, 3, 'a processed tile needs no per-frame render');
  assert.ok(f.frameRenders.every(job => job.request.options.preview && job.request.settings.analysisRegion === null));
  // Complete the renders after the commit took over frame 4's tile.
  f.items[4].thumbnail = 'thumbnail:commit'; f.items[4].thumbnailKind = 'analysis';
  f.items[1].thumbnail = 'data:live'; f.items[1].thumbnailKind = 'processed';
  for (const job of f.frameRenders) job.resolve({ id: job.request.imageData.id });
  await flush();
  assert.equal(f.items[3].thumbnail, 'thumbnail:3', 'an embedded tile becomes the converted analysis look');
  assert.equal(f.items[3].thumbnailKind, 'analysis');
  assert.equal(f.items[3].thumbnailKey, null, 'an analysis tile is never counted as canonical');
  assert.equal(f.items[1].thumbnail, 'data:live', 'never back from processed');
  assert.equal(f.items[4].thumbnail, 'thumbnail:commit', 'a late per-frame render never replaces the commit');
  assert.equal(f.items[2].thumbnail, 'data:processed');
  assert.deepEqual(f.flushed, [3], 'published tiles go through the batched flush');
  assert.ok(f.frameWorkersDisposed() >= 1, 'the render worker is released after the import');
}
{
  // A stale import (recipe changed) never publishes its late render.
  const f = fixture({ count: 4 });
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  f.items[2].settings = { ...recipe(2), coreExposure: 12 };
  for (const job of f.frameRenders) job.resolve({ id: job.request.imageData.id });
  await flush();
  assert.equal(f.items[2].thumbnail, undefined, 'a changed recipe drops its per-frame tile');
  assert.equal(f.items[1].thumbnailKind, 'analysis');
}

// #243: pass 1 now runs in display order around the open photo instead of
// import order. With no navigation or edits, every frame's final recipe and
// sample are the same in any order (the roll's film-type decision is
// recomputed once pass 1 has read every frame).
for (const verdicts of [['noMask', 'mono', 'mono', 'mono', 'mono'], ['mono', 'mono', 'mono', 'mono', 'noMask', 'noMask', 'warm', 'noMask'],
  ['mono', 'orange', 'noMask', 'orange', 'mono', 'mono']]) {
  const outcomes = [];
  for (const order of ['import', 'reverse', 'shuffled']) {
    const f = fixture({ verdicts, realRoll: true });
    const n = f.items.length;
    const display = order === 'import' ? [...Array(n).keys()]
      : order === 'reverse' ? [...Array(n).keys()].reverse()
        : [...Array(n).keys()].sort((a, b) => ((a * 7 + 3) % n) - ((b * 7 + 3) % n));
    f.context.getFileListOrder = () => display;
    f.context.scheduleAutomaticRollImport(f.items);
    f.prepareForeground(0);
    await f.fire(1200);
    assert.equal(f.timers.size, 0, `${order}: the import finished`);
    // The roll id is a fresh time-based id per analysis.
    const recipes = JSON.stringify(f.items.map(item => item.settings)).replace(/"rollId":"[^"]*"/g, '"rollId":"*"');
    outcomes.push({ order, decoded: [...f.decoded].sort(), settings: recipes,
      samples: [...f.samplesBuilt].sort().join(','), groups: JSON.stringify(f.groups) });
  }
  for (const outcome of outcomes.slice(1)) {
    assert.deepEqual(outcome.decoded, outcomes[0].decoded, `${outcome.order}: one decode per background frame`);
    assert.equal(outcome.settings, outcomes[0].settings, `${outcome.order}: identical recipes (${verdicts.join(' ')})`);
    assert.equal(outcome.samples, outcomes[0].samples, `${outcome.order}: identical samples`);
    assert.equal(outcome.groups, outcomes[0].groups, `${outcome.order}: identical roll groups`);
  }
}

// #247 2b: lens-corrected frames stay provisional (the lane renders them
// natively); a global dust change while the commit waits leaves every tile
// provisional, and the lane re-renders them from their tile sources.
{
  const f = fixture({ prepared: true, realRoll: true });
  f.items[1].settings.lensActive = true;
  const result = await f.context.runRollAnalysis({ items: f.items.slice(0, 3), automatic: true });
  assert.equal(result.status, 'committed');
  assert.deepEqual(f.items.slice(0, 3).map(item => item.thumbnailKind), ['processed', 'analysis', 'processed']);
  assert.equal(f.items[1].thumbnailKey, null);
  assert.equal(f.tileSources.has(f.items[1]), false, 'no tile source for a lens-corrected frame');
}
{
  const f = fixture({ prepared: true, realRoll: true });
  f.context.dust = false;
  f.context.photoSettingsKey = item => JSON.stringify([item.settings, f.context.dust]);
  const held = deferred();
  const convert = f.context.convertFrameWithRouter;
  f.context.convertFrameWithRouter = async request => {
    if (request.imageData.id === 2) await held.promise;
    return convert(request);
  };
  const pending = f.context.runRollAnalysis({ items: f.items.slice(0, 3), automatic: true });
  await flush();
  f.navigate(3, { busy: true });
  held.resolve(); await flush();
  assert.equal(f.tileRenders.length, 3, 'the tiles rendered before the commit waited');
  f.context.dust = true;
  f.navigate(3);
  await f.fire(250);
  assert.equal((await pending).status, 'committed');
  assert.ok(f.items.slice(0, 3).every(item => item.thumbnailKind === 'analysis' && item.thumbnailKey === null),
    'a global dust change during the wait keeps the tiles provisional');
  assert.equal(f.tileSources.size, 3, 'their tile sources let the lane re-render without a decode');
}

// #247 part 4: trickled watch-folder frames bring the samples the lane kept
// from their decodes; a roll the quiet timer forms measures them without
// decoding them again. A sample whose recipe changed since is not used.
{
  const f = fixture({ prepared: true, realRoll: true });
  const sample = id => ({ width: 10, height: 10, id, data: new Uint8ClampedArray(400), __baseSize: { width: 10, height: 10 }, __analysisReference: null });
  for (const item of f.items.slice(1)) {
    const kept = sample(item.id);
    kept.__itemKey = f.context.automaticRollItemKey(item);
    f.context.watchRollSamples.put(item, kept);
  }
  f.items[3].settings = { ...f.items[3].settings, coreExposure: 4 };
  f.context.scheduleAutomaticRollImport(f.items.slice(1), { prepared: true });
  await f.fire(1200);
  assert.equal(f.groups.length, 0, 'the real roll analysis ran');
  assert.ok(f.items.slice(1).every(item => item.settings.rollFrame?.locked));
  assert.deepEqual(f.decoded, [3], 'only the frame whose recipe changed is decoded again');
  assert.equal(f.context.watchRollSamples.bytes, 0, 'the import took every kept sample');
}

// #247 2c/2e: frames no group took (positives among a colour roll here) get
// canonical tiles from their pass-1 samples before the import finishes; the
// import releases its frames as they get tiles and restarts the lane at the
// end, once, for whatever is left.
{
  const f = fixture({ verdicts: ['orange', 'orange', 'orange', 'noMask', 'orange'], realRoll: true });
  f.context.scheduleAutomaticRollImport(f.items);
  f.prepareForeground(0);
  await f.fire(1200);
  assert.deepEqual(f.decoded, [1, 2, 3, 4], 'one decode per background frame');
  const grouped = f.groups.flat();
  const ungrouped = f.items.slice(1).filter(item => !grouped.includes(item.id));
  assert.ok(ungrouped.length >= 1, 'a frame outside the roll group');
  for (const item of f.items.slice(1)) {
    assert.equal(item.thumbnailKind, 'processed', `frame ${item.id} is final`);
    assert.equal(item.thumbnailKey, f.context.photoSettingsKey(item));
  }
  assert.equal(f.decoded.length, 4, 'no decode for the ungrouped tiles');
  assert.equal(f.context.automaticRollPendingItems.size, 0);
  // The roll pass kicks the lanes too (#243); finish restarts them once
  // every frame is released.
  assert.equal(f.laneStarts.at(-1), 0, 'finish restarts the lane after releasing every frame');
}
{
  // A frame that fails in pass 1 leaves the import's ownership at once.
  const f = fixture({ count: 4 });
  f.context.loadFileToImageData = async file => {
    const id = Number(file.name.split('.')[0]);
    if (id === 2) throw new Error('decoder failure');
    f.decoded.push(id); return { width: 10, height: 10, id };
  };
  const held = deferred();
  const analyze = f.context.analyzeStudioImportFrame;
  f.context.analyzeStudioImportFrame = async (image, settings, options) => {
    if (image.id === 3) await held.promise;
    return analyze(image, settings, options);
  };
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.equal(f.items[2].status, 'error');
  assert.equal(f.context.automaticRollPendingItems.has(f.items[2]), false, 'released while the import still runs');
  assert.equal(f.context.automaticRollPendingItems.has(f.items[3]), true);
  held.resolve(); await flush();
}

{
  // #252 + #258: a frame the roll pass measures on the page (a scan, or a RAW
  // whose worker is unusable) decodes inside its lane's memory claim, like
  // the shared decode, never under a second claim of its own: a budget below
  // one frame could never grant that one next to the lane's.
  const f = fixture();
  const claims = [];
  const load = f.context.loadFileToImageData;
  f.context.loadFileToImageData = async (file, options = {}) => {
    const claim = options.claim || null;
    claims.push(claim && { priority: claim.priority, held: claim.held, bytes: claim.bytes });
    return load(file, options);
  };
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.ok(f.items.every(item => item.settings), 'every frame measured');
  assert.equal(claims.length, 3, 'one decode per background frame');
  assert.ok(claims.every(claim => claim && claim.priority === 'background' && claim.held), 'each inside its lane\'s held claim');
}

// #252: RAW frames decode into their lane's roll-frame worker, which keeps
// the planes, detects the frame and reads the edge; the page merges its
// results with today's functions and the worker builds the sample.
function workerRoll(f, { analysisFor = () => ({}), dng = true } = {}) {
  f.context.rollFrameWorkerUsable = () => true;
  if (dng) for (const item of f.items) item.file.name = `${item.id}.dng`;
  const adapters = [];
  const pool = {
    disposed: false, warmed: 0,
    frame({ options, returnPlanes }) {
      const adapter = { options, returnPlanes, analysis: null, held: null, doneCalls: 0, done() { adapter.doneCalls++; } };
      adapters.push(adapter);
      return adapter;
    },
    warm() { pool.warmed++; }, resize(n) { pool.size = n; }, dispose() { pool.disposed = true; }
  };
  f.context.rollFramePoolFactory = () => pool;
  const pageReads = [];
  const heldFrames = [];
  f.context.loadFileToImageData = async (file, { postDecode = null, claim = null } = {}) => {
    const id = Number(file.name.split('.')[0]);
    f.decoded.push(id);
    // The loader gate: LibRaw's size and decode estimate.
    await claim?.atDecode({ kind: 'raw', width: 10, height: 10, estimatedBytes: 5000 });
    if (!postDecode) { pageReads.push(id); return { width: 10, height: 10, id }; }
    const extra = analysisFor(id, postDecode.options) || {};
    postDecode.analysis = {
      complete: true, frameFilmType: f.make(id).filmType, detection: null, detectionError: null, edge: null, edgeError: null,
      filmStats: { borderBufferPct: 10, filmType: { filmType: f.make(id).filmType }, filmBase: { r: 1, g: 2, b: 3 } }, ...extra
    };
    const held = {
      id, width: 10, height: 10, samples: [], released: false,
      async sample(settings, options) {
        held.samples.push({ settings, options });
        const sample = { id, width: 10, height: 10, fromWorker: true, __baseSize: { width: 10, height: 10 }, __analysisReference: null };
        // Asked for them, the worker hands the planes back with the sample.
        return options?.returnPlanes ? { sample, base: { id, width: 10, height: 10, planesFromWorker: true } } : { sample };
      },
      release() { held.released = true; }
    };
    heldFrames.push(held);
    postDecode.held = held;
    return { held: true, width: 10, height: 10 };
  };
  return { pool, adapters, pageReads, heldFrames };
}

{
  // The worker path gives every frame the recipe the page path gives it.
  const page = fixture();
  page.state.filmType = 'color';
  for (const item of page.items) item.file.name = `${item.id}.dng`;
  page.context.scheduleAutomaticRollImport(page.items);
  await page.fire(1200);
  const f = fixture();
  const detections = [];
  const analyze = f.context.analyzeStudioImportFrame;
  f.context.analyzeStudioImportFrame = async (image, settings, options) => {
    detections.push({ size: [image.width, image.height], detection: options.detection, filmType: options.filmType });
    return analyze(image, settings, options);
  };
  f.state.filmType = 'color';
  const { pool, adapters, pageReads, heldFrames } = workerRoll(f);
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.equal(JSON.stringify(f.items.map(item => item.settings)), JSON.stringify(page.items.map(item => item.settings)), 'same recipes');
  assert.deepEqual(f.decoded, [1, 2, 3], 'one decode per background frame');
  assert.deepEqual(pageReads, [], 'no frame fell back to the page');
  assert.equal(f.importRequests.length, 0, 'no detection request on the page');
  assert.deepEqual(f.samplesBuilt, [0], 'only the open photo\'s sample is built on the page');
  assert.ok(heldFrames.every(held => held.samples.length === 1 && held.samples[0].options.tileMax === 288), 'the worker built each sample');
  assert.deepEqual(heldFrames[0].samples[0].settings, rollSampleSettings(f.items[1].settings), 'from the recipe\'s geometry');
  assert.ok(detections.every(entry => entry.size.join() === '10,10' && entry.detection.result === null && entry.filmType === 'color'));
  assert.ok(adapters.every(adapter => adapter.options.frame.settings.filmType === 'color' && adapter.options.filmEdge === true
    && adapter.options.filmTypeChoice.automatic === true), 'options snapshotted when each job started');
  assert.equal(f.rollPools.length, 1, 'one roll-frame pool per roll');
  assert.equal(pool.warmed, 1, 'its workers are started ahead of the first frame');
  assert.equal(pool.disposed, true, 'and released when the roll ends');
  assert.deepEqual(f.idleHolds, [true, false], 'the shared auto-frame worker stays warm while the roll runs');
}

{
  // #252 + #258: a roll frame measured in its worker reserves that plan's
  // footprint, not the export lane's 50 B/px: the frame in analysis from
  // admission to its sink, plus its decode from the loader gate until its
  // planes are packed.
  const f = fixture();
  workerRoll(f);
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.ok(f.items.every(item => item.settings), 'every frame measured');
  const header = rollAnalysisFootprint(1e6).frameBytes;
  const frame = rollAnalysisFootprint(100).frameBytes;
  for (const id of [1, 2, 3]) {
    const events = f.context.memoryEvents.filter(event => event.label?.endsWith(` ${id}.dng`) && event.priority === 'background');
    assert.deepEqual(events.map(event => [event.type, event.bytes]),
      [['grant', header], ['resize', frame + 5000], ['resize', frame], ['release', frame]], `frame ${id}`);
  }
}

{
  // #249 on #252's worker path: a held frame whose display proxy is still to
  // be filled comes back to the page with its sample and is filled from those
  // planes; a frame the fill passes over (or already has) stays in its worker.
  const f = fixture();
  const { heldFrames, pageReads } = workerRoll(f);
  const plans = [];
  f.context.displayProxyFillPlan = (item, shape, settings) => {
    plans.push({ id: item.id, shape, settings });
    return item.id === 2 ? { kept: false } : item.id === 3 ? { kept: true } : { skip: true };
  };
  const fills = [];
  f.context.fillDisplayProxy = async (item, base, settings, { isCurrent }) => {
    fills.push({ id: item.id, base, settings, current: isCurrent() });
    return true;
  };
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.deepEqual(pageReads, [], 'every frame was measured in its worker');
  assert.deepEqual(plans.map(plan => plan.id).sort(), [1, 2, 3], 'each held frame is planned once, before its sample');
  assert.ok(plans.every(plan => plan.shape.width === 10 && plan.shape.height === 10 && plan.shape.route === 'libraw16' && plan.shape.has16),
    'planned on the held frame\'s size as an exact 16-bit LibRaw decode');
  const asked = Object.fromEntries(heldFrames.map(held => [held.id, Boolean(held.samples[0].options.returnPlanes)]));
  assert.deepEqual(asked, { 1: false, 2: true, 3: false }, 'only a frame with a proxy to fill asks for its planes');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].id, 2);
  assert.equal(fills[0].base.planesFromWorker, true, 'filled from the planes the worker handed back');
  assert.equal(fills[0].current, true);
  assert.equal(fills[0].settings.id, 2, 'with the recipe measured for that frame');
  assert.ok(f.items.every(item => item.settings), 'every frame measured');
}

{
  // Two frames in flight: the next frame decodes while the first is measured.
  const f = fixture({ count: 5 });
  f.context.rollPlan = { framesInFlight: 2, decodeSlots: 1 };
  const decodes = new Map();
  f.context.loadFileToImageData = file => {
    const id = Number(file.name.split('.')[0]);
    f.decoded.push(id);
    const gate = deferred();
    decodes.set(id, gate);
    return gate.promise.then(() => ({ width: 10, height: 10, id }));
  };
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.equal(f.decoded.length, 2, 'two frames in flight');
  assert.equal(f.context.backgroundLanes.running, 2);
  for (let round = 0; round < 3 && f.decoded.length < 4; round++) {
    for (const [id, gate] of [...decodes]) { decodes.delete(id); gate.resolve(); }
    await flush();
  }
  for (const [, gate] of decodes) gate.resolve();
  await flush();
  assert.deepEqual([...f.decoded].sort(), [1, 2, 3, 4]);
  assert.ok(f.items.every(item => item.settings), 'every frame measured');
  assert.equal(f.groups.length, 1);
}

{
  // A retry attempt reuses the roll's workers; the roll releases them once.
  const f = fixture();
  workerRoll(f);
  let commits = 0;
  const commit = f.context.runRollAnalysis;
  f.context.runRollAnalysis = async options => (commits++ === 0 ? { status: 'deferred' } : commit(options));
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.equal(f.timers.size, 1, 'a deferred commit schedules a retry');
  await f.fire(750);
  assert.equal(f.groups.length, 1);
  assert.equal(f.rollPools.length, 1, 'one roll-frame pool across attempts');
  assert.deepEqual([f.analyzerPools.created, f.analyzerPools.disposed], [1, 1], 'one analyzer pool across attempts');
  assert.equal(f.rollPools[0].disposed, true);
  assert.deepEqual(f.idleHolds, [true, false]);
}

{
  // A frame whose worker analysis fails is measured again in the worker, and
  // after a second failure on the page, as before; PNG frames stay on the page.
  const f = fixture({ count: 5 });
  let failures = 0;
  const { pageReads, heldFrames } = workerRoll(f, {
    analysisFor: id => (id === 2 && failures++ < 2 ? { detectionError: 'OpenCV aborted' } : {})
  });
  f.items[4].file.name = '4.png';
  const warn = console.warn; console.warn = () => {};
  try {
    f.context.scheduleAutomaticRollImport(f.items);
    await f.fire(1200);
  } finally { console.warn = warn; }
  assert.equal(failures, 2);
  assert.deepEqual(f.decoded.filter(id => id === 2).length, 3, 'twice in the worker, then once on the page');
  assert.deepEqual(pageReads.sort(), [2, 4], 'the failed frame and the PNG are measured on the page');
  assert.ok(f.items.every(item => item.settings), 'every frame ends with its recipe');
  assert.ok(heldFrames.filter(held => held.id === 2).every(held => held.released && !held.samples.length), 'failed frames are dropped in the worker');
  assert.equal(f.importRequests.length, 2, 'the page path detects frames 2 and 4');
}

{
  // Options that changed between a frame's decode and its merge (a detector
  // setting here) make the frame measure again, with the new options.
  const f = fixture();
  let changed = false;
  const { adapters, heldFrames } = workerRoll(f, {
    analysisFor: () => {
      if (!changed) { changed = true; f.state.autoFrame = { ...f.state.autoFrame, marginRatio: 0.05 }; }
      return {};
    }
  });
  f.context.autoFrameAnalyzerOptions = ({ filmType, rotatedOutput }) => ({ settings: { ...f.state.autoFrame, filmType, lastDiagnostics: Math.random() }, rotatedOutput });
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.equal(heldFrames[0].released, true, 'the stale frame is dropped');
  assert.equal(heldFrames[0].samples.length, 0);
  assert.equal(f.decoded.filter(id => id === heldFrames[0].id).length, 2, 'and decoded again');
  assert.equal(adapters.at(-1).options.frame.settings.marginRatio, 0.05);
  assert.ok(f.items.every(item => item.settings));
}

{
  // A worker that goes with its frame before the sample: the frame is
  // measured again, not marked failed.
  const f = fixture();
  let lost = 0;
  const { heldFrames } = workerRoll(f);
  const load = f.context.loadFileToImageData;
  f.context.loadFileToImageData = async (file, options) => {
    const out = await load(file, options);
    const held = heldFrames.at(-1);
    if (options?.postDecode && held?.id === 2 && lost++ === 0) held.sample = async () => { throw new Error('Roll-frame worker crashed'); };
    return out;
  };
  const warn = console.warn; console.warn = () => {};
  try {
    f.context.scheduleAutomaticRollImport(f.items);
    await f.fire(1200);
  } finally { console.warn = warn; }
  assert.equal(f.items[2].status, undefined, 'not marked failed');
  assert.ok(f.items.every(item => item.settings));
  assert.equal(f.decoded.filter(id => id === 2).length, 2, 'decoded again');
}

{
  // #252 part 6, flagged off by default: half-size analysis decodes. Off, no
  // decode asks for half size; on, the worker's crop maps x2 onto the full
  // frame, the sample is built for the full size, and the decode is never
  // adoptable by the foreground.
  const off = fixture();
  const offCalls = [];
  workerRoll(off);
  const offLoad = off.context.loadFileToImageData;
  off.context.loadFileToImageData = async (file, options) => { offCalls.push(Boolean(options?.halfSize)); return offLoad(file, options); };
  off.context.scheduleAutomaticRollImport(off.items);
  await off.fire(1200);
  assert.deepEqual(offCalls, [false, false, false], 'full-size decodes by default');

  const f = fixture();
  f.context.safeStorageGet = key => (key === 'nc_roll_analysis_half_v1' ? 'on' : null);
  const { heldFrames } = workerRoll(f, { analysisFor: () => ({ detection: { angle: 0, cropRegion: { left: 1, top: 2, width: 5, height: 4 } } }) });
  const load = f.context.loadFileToImageData;
  const halfCalls = [];
  f.context.loadFileToImageData = async (file, options) => {
    halfCalls.push(Boolean(options?.halfSize));
    const out = await load(file, options);
    return out?.held ? { ...out, fullSize: { width: 20, height: 20 } } : out;
  };
  const detections = [];
  const analyze = f.context.analyzeStudioImportFrame;
  f.context.analyzeStudioImportFrame = async (image, settings, options) => {
    detections.push({ size: [image.width, image.height], crop: options.detection?.result?.cropRegion });
    return analyze(image, settings, options);
  };
  const opened = [];
  const open = f.context.sharedDecodes.open;
  f.context.sharedDecodes.open = (file, options = {}) => { opened.push(options.adoptable); return open(file, options); };
  f.context.scheduleAutomaticRollImport(f.items);
  await f.fire(1200);
  assert.deepEqual(halfCalls, [true, true, true]);
  assert.deepEqual(opened, [false, false, false], 'never adoptable');
  assert.ok(detections.every(entry => entry.size.join() === '20,20' && JSON.stringify(entry.crop) === JSON.stringify({ left: 2, top: 4, width: 10, height: 8 })),
    'merged on the full frame with the crop scaled x2: ' + JSON.stringify(detections));
  assert.ok(heldFrames.every(held => held.samples[0].options.fullSize.width === 20), 'samples built for the full size');
  assert.ok(f.items.every(item => item.settings));
}

console.log('automaticRollImport tests passed');
