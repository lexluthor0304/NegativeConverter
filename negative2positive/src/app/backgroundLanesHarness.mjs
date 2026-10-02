// Test harness for the background photo lanes in main.js (#243): the real
// scheduler functions, run in a vm context with the real pure modules (gate,
// shared decodes, job pick, session caches, hidden-job gate) and stubbed
// decoders and renders. Used by backgroundLanes.test.mjs and
// thumbnailScheduling.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createBackgroundGate, BACKGROUND_STEP_WAIT_CAP_MS } from './backgroundGate.js';
import { createSharedDecodes } from './sharedDecodes.js';
import { pickBackgroundJob, travelDirection, displayDistance } from './backgroundPhotoScheduler.js';
import { createPhotoSessionCache } from './photoSessionCache.js';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { createThumbnailSourceCache } from './thumbnailSources.js';
import { createRollSampleCache } from './rollSampleCache.js';
import { reducedTileGeometry, tileGeometryKey } from './reducedGeometry.js';
import { sanitizeCropRect } from './imageGeometry.js';
import { MEMORY_FUNCTIONS, memoryGlobals } from './memoryHarness.mjs';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
export function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

export const SCHEDULER_FUNCTIONS = [
  'foregroundBusyForBackground', 'foregroundInteractionBusy', 'backgroundRest', 'decodeForBackground',
  'openAnalysisDecode', 'openTileDecode', 'openPrefetchDecode', 'openHalfSizeTileDecode', 'abortHalfSizeTileDecode',
  'abortBackgroundDecodes', 'backgroundLanesRunning',
  'kickBackgroundPhotoWork', 'backgroundLaneTarget', 'backgroundWorkPending', 'runBackgroundLane',
  'backgroundDisplayOrder', 'pickNextBackgroundJob', 'backgroundNeeds', 'laneTileWanted', 'photoPrefetchEnabled',
  'currentPhotoSettled', 'canPrefetchPhoto', 'prefetchTargetItem', 'holdPrefetchedBase', 'dropDistantPrefetch',
  'notePhotoActivation', 'handOverBackgroundBase', 'backgroundConvert', 'backgroundAnalyzers',
  'releaseBackgroundWorkers', 'runBackgroundPhotoJob', 'beginLaneTile', 'beginPrefetch', 'runRollAnalysisPass',
  'beginRollPassFrame', 'settleRollPassRequests', 'activationDwell'
];
// How lane tiles are made (#247): tile sources, half-size decodes and the
// roll samples kept for watch-folder frames.
export const TILE_FUNCTIONS = ['tileSourceFor', 'renderTileFromSource', 'canDecodeTileHalfSize', 'keepsWatchRollSample', 'keepWatchRollSample'];

// Timers fire only when the test advances the clock.
export function fakeClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: time + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
    get pending() { return timers.size; }
  };
  return clock;
}

export const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * @param {object} options
 * @param {number} [options.count] photos in the queue
 * @param {number[]} [options.order] display order (queue indices), default queue order
 * @param {number} [options.current] queue index of the open photo
 * @param {boolean} [options.prefetch] prefetch slot enabled (desktop budget)
 * @param {number} [options.sessionBudget] photoSessions bytes
 * @param {boolean} [options.settings] every photo has a recipe
 * @param {number} [options.memoryBudgetBytes] the memory budget (#258; every
 *   file's header says 1 MP)
 */
export function createLaneFixture({ count = 5, order = null, current = 0, prefetch = false, sessionBudget = 1 << 20,
  settings = true, tilesDone = false, memoryBudgetBytes = 1e15 } = {}) {
  const clock = fakeClock();
  const items = Array.from({ length: count }, (_, index) => ({
    id: index, file: { name: `${index}.dng` }, settings: settings ? { id: index } : null,
    ...(tilesDone ? { thumbnail: 'done', thumbnailKind: 'processed', thumbnailKey: JSON.stringify(settings ? { id: index } : null) } : {})
  }));
  const state = {
    fileQueue: items, currentFileIndex: current, loadedFile: items[current]?.file || null, currentStep: 3,
    geometryPending: false, rawDecodePending: false, fullResolutionPromise: null
  };
  const decodes = [];      // { file, signal, resolve, reject, options }
  const renders = [];      // processFileWithSettings calls
  const published = [];
  const warnings = [];
  const rowRefreshes = [];
  const sourceRenders = []; // renderPreviewFromWorkingImage calls (tile-source renders)
  let convertPools = 0, convertDisposed = 0, analyzerPools = 0, analyzerDisposed = 0;
  const noop = () => {};
  const context = vm.createContext({
    // The memory budget (#258): real, large enough to admit everything.
    ...memoryGlobals({ budgetBytes: memoryBudgetBytes, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout }),
    getPerfNow: clock.now,
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, console: { warn: (...args) => warnings.push(args), error: noop, info: noop },
    Map, Set, WeakMap, Promise, AbortController, DOMException, structuredClone, JSON, Math, Number, Boolean, Array,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    document: { body: { dataset: {} }, getElementById: () => null },
    processNegativeInFlight: null, coreReprocessTimer: null, fullResolutionRenderTimer: null, singleExportActive: false,
    coreReprocessBusy: () => false, isDesktopBatchExportLocked: () => false,
    studioBackgroundReady: () => state.currentStep >= 3 && context.getCurrentQueueItem()?.file === state.loadedFile
      && !context.document.body.dataset.studioBusy && !context.processNegativeInFlight,
    getCurrentQueueItem: () => {
      const item = state.fileQueue[state.currentFileIndex];
      return item && item.file === state.loadedFile ? item : null;
    },
    getFileListOrder: () => order || state.fileQueue.map((_, index) => index),
    reviewFilter: false, reviewForItem: () => ({ needs: false }),
    automaticRollImportRunning: false, studioAutoFrameRunning: false, automaticRollRevision: 1,
    automaticRollPendingItems: new Set(),
    photoSettingsKey: item => JSON.stringify(item.settings ?? null),
    photoSessions: createPhotoSessionCache({ maxBytes: sessionBudget }),
    photoPreviews: createPhotoSessionCache({ maxBytes: 1 << 20 }),
    photoPrefetch: createPhotoSessionCache({ maxBytes: prefetch ? 1 << 20 : 0 }),
    lowMemoryPhotoDevice: () => !prefetch,
    hiddenJobs: createHiddenJobGate({ isHidden: () => false }), hiddenJobBytesFor: async () => 0,
    backgroundLanes: { running: 0, active: new Map() }, rollPassRequests: new Set(), backgroundVisibleItems: new Set(),
    backgroundDirection: 1, prefetchedItem: null, backgroundWorkers: null, prefetchPreviewAttempts: new WeakMap(), prefetchRefused: new WeakSet(),
    BACKGROUND_LANE_REST_MS: 30, BACKGROUND_LANE_POLL_MS: 250, ACTIVATION_DWELL_MS: 120, BACKGROUND_STEP_WAIT_CAP_MS,
    pickBackgroundJob, travelDirection, displayDistance,
    loadFileToImageData: (file, options = {}) => {
      const gate = deferred();
      const record = { file, signal: options.signal || null, options, ...gate, settled: false };
      options.signal?.addEventListener('abort', () => { record.aborted = true; gate.reject(options.signal.reason); }, { once: true });
      decodes.push(record);
      return gate.promise;
    },
    processFileWithSettings: (file, recipe, options) => {
      const gate = deferred();
      renders.push({ file, settings: recipe, options, ...gate });
      return gate.promise;
    },
    createConversionWorkerPool: () => { convertPools++; return Object.assign(() => Promise.resolve(null), { dispose: () => { convertDisposed++; } }); },
    createAutoFrameWorkerPool: () => { analyzerPools++; return { analyze: noop, readFilmEdge: noop, dispose: () => { analyzerDisposed++; } }; },
    cloneSettings: value => structuredClone(value),
    thumbnailDataUrl: image => image.preview,
    updateFileThumbnail: item => published.push({ id: item.id, thumbnail: item.thumbnail }),
    refreshThumbnailRow: item => rowRefreshes.push(item.id),
    // Tile sources and half-size decodes (#247): off unless a test settles a
    // recipe (tileRecipeSettled) or puts a source. The tile renderer records.
    STUDIO_TILE_PREVIEW_MAX: 288, thumbnailSources: createThumbnailSourceCache(), watchRollSamples: createRollSampleCache(1 << 20),
    tileRecipeSettled: () => false, lensCorrectionActive: settings => Boolean(settings?.lens),
    sanitizeSettings: settings => structuredClone(settings), perPhotoSettingsFallback: () => ({}),
    tileGeometryKey, reducedTileGeometry, sanitizeCropRegionForImage: sanitizeCropRect,
    isRawLikeFileName: name => /\.(dng|nef|cr2|arw)$/.test(name),
    automaticRollItemKey: item => JSON.stringify(item.settings ?? null),
    buildRollSample: (base, settings) => ({ width: 1, height: 1, data: new Uint8ClampedArray(4), base, settings }),
    // A watch-folder arrival's full-resolution recipe render releases the
    // planes it made; the watch's roll timer is not part of this harness
    // (#229 review, R1-124; laneRecipeInputs.test.mjs runs it).
    releaseOwnedPlanes: () => {}, noteHotFolderRecipe: () => {},
    renderPreviewFromWorkingImage: async (working, settings, ctx) => {
      sourceRenders.push({ working, settings, ctx });
      if (!ctx.isCurrent()) throw new DOMException('stale', 'AbortError');
      return { preview: `source:${settings.owner}` };
    },
  });
  context.backgroundGate = createBackgroundGate({
    isBusy: () => context.foregroundBusyForBackground(), now: clock.now,
    setTimer: clock.setTimeout, clearTimer: clock.clearTimeout
  });
  context.sharedDecodes = createSharedDecodes({ decode: (file, { signal, context: opener }) => context.decodeForBackground(file, signal, opener) });
  vm.runInContext([...SCHEDULER_FUNCTIONS, ...TILE_FUNCTIONS, ...MEMORY_FUNCTIONS].map(functionSource).join('\n'), context);
  const decodeOf = id => decodes.filter(record => record.file === items[id].file);
  const image = id => ({ id, width: 4, height: 4, data: new Uint8ClampedArray(64) });
  // Resolve the pending decode of photo `id` (with its metadata callback).
  const finishDecode = async (id, meta = { lensModel: `lens-${id}` }) => {
    const record = decodeOf(id).find(entry => !entry.settled);
    assert.ok(record, `a decode of photo ${id} is pending`);
    record.settled = true;
    record.options.onMetadata?.(meta);
    record.resolve(image(id));
    await flush();
    return record;
  };
  const renderOf = id => renders.filter(render => render.file === items[id].file);
  const finishRender = async (id, preview = `tile-${id}`) => {
    const render = renderOf(id).find(entry => !entry.done);
    assert.ok(render, `a render of photo ${id} is pending`);
    render.done = true;
    render.options.onPreparedSettings?.({ prepared: id });
    render.resolve({ preview });
    await flush();
    return render;
  };
  // Open another photo the way switchToFile does for the lanes.
  const open = (index, { loaded = true } = {}) => {
    const from = state.fileQueue[state.currentFileIndex];
    state.currentFileIndex = index;
    if (loaded) state.loadedFile = items[index].file;
    context.notePhotoActivation(from, items[index]);
  };
  const started = () => decodes.map(record => record.file.name);
  return {
    context, state, items, clock, decodes, renders, published, warnings, rowRefreshes, sourceRenders, decodeOf, renderOf, finishDecode,
    finishRender, image, open, started,
    pools: () => ({ convertPools, convertDisposed, analyzerPools, analyzerDisposed })
  };
}
