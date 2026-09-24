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
    importFilmTypeAuto: true, cropping: false, positiveMode: 'correct', rollMetadata: {}
  };
  const timers = new Map(), decoded = [], analyzed = [], groups = [], stores = [], restored = [], renders = [], undos = [];
  const markerMap = new Map();
  const markerStorage = { get: key => markerMap.get(key) ?? null, set: (key, value) => markerMap.set(key, value), remove: key => markerMap.delete(key) };
  const toasts = [], frameTypes = [], samplesBuilt = [];
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
    buildRollAnalysisSample: (image) => { samplesBuilt.push(image.id); return image; },
    planBatchLanes: async () => 1,
    createAutoFrameWorkerPool: () => ({ analyze: noop, readFilmEdge: noop, dispose: noop }),
    createPerfTrace: () => ({ end: noop }), runBatchPipeline,
    loadFileToImageData: async file => { const id = Number(file.name.split('.')[0]); decoded.push(id); return pixels(id); },
    createDefaultSettings: (_image, item) => make(item.id),
    analyzeStudioImportFrame: async (_image, settings, options = {}) => { frameTypes.push(options.filmType); return settings; },
    analyzeImportFilmEdge: async (_image, settings) => ({ settings }),
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
    scheduleSilverSourceRefresh: noop, schedulePreviewUpdate: noop
  });
  vm.runInContext(['getCurrentQueueItem', 'automaticRollItemKey', 'scheduleAutomaticRollImport', ...FILM_TYPE_FUNCTIONS, ...(realRoll ? ['runRollAnalysis'] : [])]
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
  const marker = () => readJobMarker(markerStorage, { key: JOB_MARKER_KEYS.roll });
  // The foreground photo as prepareStudioPhoto leaves it: its own verdict is
  // recorded and the import's decision applied.
  const prepareForeground = (index = state.currentFileIndex) => {
    const settings = context.settleImportFilmType(items[index], make(index));
    items[index].settings = settings;
    for (const key of ['filmType', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason']) state[key] = settings[key];
  };
  return { context, state, items, timers, decoded, analyzed, groups, stores, restored, renders, undos, toasts, frameTypes, samplesBuilt, fire, navigate, make, prepareForeground, marker };
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
  // The job marker (#241) survives the deferred attempt with every analysed frame.
  const running = f.marker();
  assert.equal(running?.kind, 'roll-analysis');
  assert.equal(running.files.length, 4);
  assert.deepEqual(running.written.map(([index]) => index).sort(), [2, 3], 'both analysed frames are recorded');
  assert.ok(f.context.recoveryWrites >= 2, 'each analysed frame schedules the recovery copy');
  f.navigate(1);
  f.items[1].settings = recipe(1);
  await f.fire(750);
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].length, 4);
  assert.deepEqual(f.decoded, [2, 3], 'already prepared frames are not decoded on resume');
  assert.equal(f.timers.size, 0);
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

console.log('automaticRollImport tests passed');
