import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runBatchPipeline } from './batchExportScheduler.js';
import { aggregateRollAnalysis, groupAutomaticRollFrames, sanitizeRollFrameForSettings } from './rollAnalysis.js';

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
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };
const recipe = id => ({ filmType: 'color', filmBase: { r: 210, g: 140, b: 90, method: 'auto' }, filmEdge: { checked: true }, id });
const channels = [0, 1, 2].map(() => ({ whitePointOrigin: 50000, blackPointOrigin: 500, meanPoint: 0.5 }));

function fixture({ count = 4, prepared = false, realRoll = false } = {}) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: index, file: { name: `${index}.png`, size: 100 }, selected: true,
    settings: prepared ? recipe(index) : null, isDirty: false
  }));
  const pixels = id => ({ width: 10, height: 10, id });
  const state = {
    fileQueue: items, currentFileIndex: 0, loadedFile: items[0].file,
    loadedBaseImageData: pixels(0), originalImageData: pixels(0),
    currentStep: 3, rollReference: { applyLock: false }, rollAnalysis: {},
    importFilmTypeAuto: true, cropping: false
  };
  const timers = new Map(), decoded = [], analyzed = [], groups = [], stores = [], restored = [], renders = [], undos = [];
  let timerId = 0;
  const noop = () => {};
  const context = vm.createContext({
    state, console, Map, Set, AbortController, structuredClone,
    AUTO_ROLL_KEY: 'auto', automaticRollRevision: 0,
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
    safeStorageGet: () => context.off ? 'off' : null,
    studioBackgroundReady: () => state.currentStep >= 3 && context.getCurrentQueueItem()?.file === state.loadedFile
      && !context.document.body.dataset.studioBusy && !context.processNegativeInFlight,
    getCurrentQueueItem: () => items[state.currentFileIndex],
    extractCurrentSettings: () => state.liveSettings || recipe(state.currentFileIndex),
    persistCurrentFileSettings: () => {
      const item = items[state.currentFileIndex];
      if (item.file !== state.loadedFile) return;
      item.settings ||= recipe(item.id);
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
    buildRollAnalysisSample: (image) => image,
    planBatchLanes: async () => 1,
    createAutoFrameWorkerPool: () => ({ analyze: noop, readFilmEdge: noop, dispose: noop }),
    createPerfTrace: () => ({ end: noop }), runBatchPipeline,
    loadFileToImageData: async file => { const id = Number(file.name.split('.')[0]); decoded.push(id); return pixels(id); },
    createDefaultSettings: (_image, item) => recipe(item.id),
    analyzeStudioImportFrame: async (_image, settings) => settings,
    analyzeImportFilmEdge: async (_image, settings) => ({ settings }),
    learnedImportSettings: async settings => settings,
    groupAutomaticRollFrames, aggregateRollAnalysis, sanitizeRollFrameForSettings,
    notifyImportReview: noop, updateFileListUI: noop, scheduleProjectRecovery: noop,
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
    restoreSettings: settings => restored.push(settings.id),
    updateRollAnalysisUI: noop, showToast: noop,
    processNegative: async options => renders.push({ id: state.currentFileIndex, options })
  });
  vm.runInContext(['getCurrentQueueItem', 'automaticRollItemKey', 'scheduleAutomaticRollImport', ...(realRoll ? ['runRollAnalysis'] : [])]
    .map(functionSource).join('\n'), context);
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
  return { context, state, items, timers, decoded, analyzed, groups, stores, restored, renders, undos, fire, navigate };
}

// Exactly two imported photos must leave the thumbnail queue independent.
{
  const f = fixture({ count: 2 });
  f.context.scheduleAutomaticRollImport(f.items);
  assert.equal(f.timers.size, 0);
  assert.equal(f.context.automaticRollImportRunning, false);
}

// Navigation during decode no longer throws away other detached measurements.
// The newly foreground photo owns its own recipe; unvisited neighbours finish.
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
  assert.ok(f.items[2].settings && f.items[3].settings, 'unrelated frames are prepared despite navigation');
  assert.equal(f.items[1].settings, null, 'background never overwrites a foreground preparation');
  assert.equal(f.context.automaticRollImportRunning, false, 'waiting does not lock thumbnail work');
  assert.equal(f.timers.size, 1, 'one bounded resume timer');
  f.navigate(1);
  f.items[1].settings = recipe(1);
  await f.fire(750);
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].length, 4);
  assert.deepEqual(f.decoded, [2, 3], 'already prepared frames are not decoded on resume');
  assert.equal(f.timers.size, 0);
  assert.ok(f.stores.every(store => store.cleared), 'sample storage is disposed after completion');
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
  assert.ok(f.items.slice(0, 3).every(item => item.thumbnailKind === 'analysis' && item.thumbnailKey === null),
    'roll-only thumbnails are provisional until lens, dust, WB and repair stages run');
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

console.log('automaticRollImport tests passed');
