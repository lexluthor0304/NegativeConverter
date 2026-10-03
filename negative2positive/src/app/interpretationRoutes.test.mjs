import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createHarness, samePixels } from './geometryTestHarness.mjs';
import * as filmType from './filmTypeOverride.js';
import { encodeRecipe, decodeRecipe, RECIPE_KEYS } from './recipes.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { hasWindowEdits, overlayWindowEdits } from './provisionalPhoto.js';
import { mergeStudioColors } from './studioSettings.js';
import { buildRollProject, serializeRollProject, parseRollProject } from './rollProject.js';
const { deepCopySanitizedSettings } = await import(process.env.NC229_SNAPSHOT_SOURCE
  ? pathToFileURL(process.env.NC229_SNAPSHOT_SOURCE).href : './settingsSnapshot.js');
import { convertFrameWithRouter, resolveConversionMode } from '../pipeline/conversionRouter.js';
import { analyzeSilverCoreFrame } from '../pipeline/silverAdapter.js';
import { aggregateRollAnalysis, measureNegativeMean, sanitizeRollFrameForSettings, rollFrameExposureUnits } from './rollAnalysis.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';
import { resolveAnalysisRegion, analysisPixelBounds } from './analysisRegion.js';
import { planeBuffersOf, sharesPlaneBuffers, markOwnedPlanes } from './planeRelease.js';
import { downsampleImageDataForMaxPixels, downsampleImageDataForMaxDim } from './imageDataOps.js';
import { analyzeExpiredFilm, defaultExpiredRescueParams, sanitizeExpiredAnalysis, sanitizeExpiredRescueParams,
  EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS } from '../pipeline/expiredRescue.js';

// Real production writers, recipe codec, batch processor, conversion, rescue
// and 8/16 adjustment kernels. UI and spatial-worker availability are leaves.
// The identical assertions run against an immutable main.js at the pinned base.
const source = readFileSync(process.env.NC229_CALLER_SOURCE || new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
};
const map = sanitizeSemanticMap({ width: 2, height: 1, labels: [0, 4], confidence: .95 });
const width = 64, height = 48, data16 = new Uint16Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const at = (y * width + x) * 4, value = 9000 + ((x * 71 + y * 157) % 35000);
  for (let c = 0; c < 3; c++) data16[at + c] = Math.min(65535, Math.round(value * (x < width / 2 ? [1.25, 1, .8] : [.7, 1.15, .85])[c]));
  data16[at + 3] = 65535;
}
const base = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), width, height);
base.__image16 = { width, height, data: data16 };
const canon = value => JSON.parse(JSON.stringify(value));
const selection = process.env.NC229_ROUTE_CASE || 'all';
const functions = ['recipePatch', 'applyRecipeToCurrent', 'applyRecipeToSelected', 'applyDetectedFilmToCurrent',
  'applyRollReferenceToCurrentForStep2', 'mergeImportFilmEdge', 'mirrorCropForRotatedFrame',
  'remeasureExpiredAfterRetype', 'expiredInterpretation', 'expiredSourceKey', 'expiredAnalysisSample',
  'applyExpiredAnalysisDefaults', 'runExpiredAnalysis', 'maybeAnalyzeExpiredRescue', 'measureExpiredAnalysisForExport',
  'applyFrameExpiredAnalysis', 'processFileWithSettings', 'frameWantsAutoWhiteBalance',
  'resolveLensCorrection', 'lensCorrectionActive', 'perPhotoSettingsFallback', 'withPendingEdits',
  'sanitizeSettings', 'sanitizeNumeric', 'clampBetween', 'sanitizeCurveLut', 'sanitizeCurvePointChannel', 'buildCurveLutFromPoints',
  'makeLinearCurvePoints', 'makeLinearCurveLut', 'extractCurrentSettings', 'cloneSettings',
  'applySettingsToItems', 'applyCurrentSettingsToSelected', 'applyRollReferenceToSelected', 'addFilesToQueue',
  'createQueueItemId', 'persistCurrentFileSettings', 'buildCurrentProject', 'sanitizeProjectSettings',
  'getEffectiveFilmType', 'usesSilverCoreConversion', 'buildCoreConversionSettings', 'buildRouterSettings', 'localExposureGeometryFor'];
const positiveMarker = "    document.getElementById('convertPositiveBtn').addEventListener('click', () => {";
const positiveStart = source.indexOf(positiveMarker), positiveEnd = source.indexOf('\n    });', positiveStart);
assert.ok(positiveStart >= 0 && positiveEnd > positiveStart);
const positiveCaller = 'var convertPositive = () => {' + source.slice(positiveStart + positiveMarker.length, positiveEnd) + '\n    };';

async function fixture({ type = 'positive', mode = 'correct', manual = false, roll = null } = {}) {
  const h = createHarness(base), { context: c, target, state } = h;
  Object.assign(state, EXPIRED_RESCUE_DEFAULTS, { filmType: type, positiveMode: mode, currentStep: 3,
    filmTypeSource: 'auto', expiredEnabled: true, semanticMap: structuredClone(map),
    filmBase: { r: 228, g: 194, b: 144, method: 'manual' }, filmBaseSet: true, coreBorderBuffer: 0,
    coreExposure: 19, expiredBrightness: 17, expiredContrast: 23, expiredNeutralize: 61,
    wbR: 1.17, wbG: 1, wbB: .86, wbAutoConfidence: 'high', wbUserOverride: manual,
    wbSemanticApplied: true, grayPointSampled: false,
    curves: Object.fromEntries(['r', 'g', 'b'].map(ch => [ch, Uint8Array.from({ length: 256 }, (_, i) => i)])),
    rollReference: { applyLock: false },
    expiredBrightnessUserOverride: false, expiredContrastUserOverride: false });
  const file = { name: 'routes.png', size: 1 }, timers = [], measurements = [];
  state.loadedFile = file;
  state.fileQueue = [{ file, selected: true, settings: null }];
  const adjusted = (image, settings, depth) => {
    const output = new ImageData(new Uint8ClampedArray(image.data.length), image.width, image.height);
    (depth === 16 ? applyPreparedAdjustmentsToBuffer16 : applyPreparedAdjustmentsToBuffer)(image, settings, output);
    return output;
  };
  Object.assign(target, filmType, { RECIPE_KEYS, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS,
    sanitizeSemanticMap, sanitizeExpiredAnalysis, sanitizeExpiredRescueParams, analyzeExpiredFilm, defaultExpiredRescueParams,
    resolveAnalysisRegion, analysisPixelBounds, downsampleImageDataForMaxPixels, downsampleImageDataForMaxDim,
    hasWindowEdits, overlayWindowEdits, mergeStudioColors, planeBuffersOf, sharesPlaneBuffers, markOwnedPlanes,
    deepCopySanitizedSettings, buildRollProject,
    decodedRecipe: null, expiredAnalysisKey: null, expiredTabPending: false,
    coreReprocessToken: 4, displayedFrameToken: 4, processNegativeInFlight: null,
    document: { body: { dataset: {} }, getElementById: () => ({ value: '', classList: { toggle() {} } }) },
    sanitizePresetType: v => ['positive', 'color', 'bw'].includes(v) ? v : 'color',
    inferFilmTypeFromLegacyPreset: (_v, fallback) => fallback,
    sanitizeCoreColorModel: (v, fallback) => v || fallback, sanitizeCoreEnhancedProfile: (v, fallback) => v || fallback,
    sanitizeFilmBase: (v, fallback) => structuredClone(v || fallback),
    sanitizeFilmEdgeForSettings: v => v ? { checked: true, ...structuredClone(v) } : null,
    sanitizeRollFrameForSettings, rollFrameExposureUnits,
    sanitizeLensCorrection: v => ({ enabled: false, params: {}, modes: {}, ...v }),
    normalizePaperId: v => v || 'none', normalizeToningId: v => v || 'none',
    sanitizeRepairStrokes: v => v || [], sanitizeFrameMetadata: v => v || {},
    sanitizeLookForSettings: v => v || null, sanitizeLocalExposureForSettings: () => null,
    requiresFilmBase: () => false,
    baseSizeSource: () => base, pendingGeometryEdits: () => null,
    createPerfTrace: () => ({ mark() {}, end() {} }),
    getColorAnalysisSample: () => null,
    convertFrameOffMainThread: convertFrameWithRouter,
    renderGeometryChain: async image => image,
    applyLensCorrectionWithSettings: async image => image,
    applyAdjustmentsWithSettings: async (image, s, options) => adjusted(image, s, options.bitDepth),
    getCurrentQueueItem: () => state.fileQueue.find(item => item.file === state.loadedFile),
    savedProjectThumbnail: () => ({}), ensureFullDecodeWithNotice: async () => true,
    appConfirm: async () => true, i18n: { en: {} }, currentLang: 'en',
    studioWorkspace: { sync() {}, text: () => 'Apply settings' },
    hasRollReference: () => Boolean(state.rollReference.settingsSnapshot),
    runImportDetections: async image => ({ image, read: { result: null } }),
    measureExpiredAnalysisWithSpatial: async () => null,
    runExpiredSpatialAnalysis: () => Promise.resolve(false),
    createDefaultSettings: (_image, item) => ({ ...c.sanitizeSettings(state), expiredAnalysis: null, semanticMap: null,
      ...item?.filmTypeOverride, filmEdge: { checked: true } }),
    loadDxFilmTable: async () => ({}), describeDxFilm: () => ({ filmKind: 'bw', primaryName: 'B&W' }),
    settleImportFilmType: (_item, settings) => settings, learnedImportSettings: async settings => settings,
    shortFilmName: v => v, getInterpolatedText: (_key, _values, fallback) => fallback,
    getLocalizedText: (_key, fallback) => fallback, loadGeneration: 1,
    setTimeout: callback => { timers.push(callback); },
    scheduleSilverSourceRefresh: () => { target.coreReprocessToken++; },
    flushScheduledCoreReprocess: async () => {
      state.processedImageData = await convertFrameWithRouter({ imageData: base, settings: target.buildRouterSettings(state), options: { forceFullProcess: true } });
      target.displayedFrameToken = target.coreReprocessToken;
    },
    settleMeasurementInputs: async (measure, current) => { if (current()) measure(); }
  });
  vm.runInContext(functions.map(fn).join('\n'), c);
  if (/^    function copiedFrameAnalysisMatches\(/m.test(source)) vm.runInContext(fn('copiedFrameAnalysisMatches'), c);
  if (/^    function adoptFrameExpiredAnalysis\(/m.test(source)) vm.runInContext(fn('adoptFrameExpiredAnalysis'), c);
  vm.runInContext(positiveCaller, c);
  if (/^    function applyRecipeSettings\(/m.test(source)) vm.runInContext(fn('applyRecipeSettings'), c);
  const realAnalyze = target.analyzeExpiredFilm;
  target.analyzeExpiredFilm = (...args) => { measurements.push(args); return realAnalyze(...args); };
  if (roll) {
    const channelData = await analyzeSilverCoreFrame(base, target.buildCoreConversionSettings(state), resolveConversionMode(state));
    const darker = new ImageData(Uint8ClampedArray.from(base.data, (v, i) => i % 4 === 3 ? v : Math.round(v * Math.pow(.5, 1 / 2.2))), width, height);
    const measured = aggregateRollAnalysis([base, darker, darker].map((image, i) => ({ id: i,
      filmBase: state.filmBase, channelData, negativeMean: measureNegativeMean(image, 0) })));
    state.rollFrame = sanitizeRollFrameForSettings({ rollId: 'recipient-roll', channelData: measured.channelData,
      ...measured.frames[0], locked: true, equalize: true, ...roll });
    assert.ok(state.rollFrame.channelData && state.rollFrame.offsetStops > .9, 'real histogram/density aggregation produces a meaningful recipient offset');
  }
  await target.flushScheduledCoreReprocess();
  c.runExpiredAnalysis();
  measurements.length = 0;
  const old = target.extractCurrentSettings();
  state.fileQueue[0].settings = structuredClone(old);
  return { ...h, file, timers, measurements, old, adjusted };
}
let cases = 0;
// Both copy buttons must use the recipient after interpretation invalidation.
// The locked levels and density offset reach the real router, conversion,
// measurement and 8/16 adjustment kernels, rather than a simplified router.
for (const route of ['locked-copy-current', 'locked-copy-reference', 'locked-copy-import']) {
  if (selection !== 'all' && selection !== route) continue;
  for (const crossing of ['bw', 'positive', 'mode']) {
    if (process.env.NC229_LOCK_CROSSING && process.env.NC229_LOCK_CROSSING !== crossing) continue;
    const f = await fixture({ type: crossing === 'mode' ? 'positive' : 'color', manual: true, roll: {} });
    const { context: c, state, target, old } = f;
    const donor = c.cloneSettings({ ...old, filmType: crossing === 'bw' ? 'bw' : 'positive',
      positiveMode: crossing === 'mode' ? 'edit' : 'correct', wbR: 1.23, wbG: 1, wbB: .91,
      expiredBrightness: old.expiredBrightness, expiredContrast: 0, expiredBrightnessUserOverride: true,
      expiredContrastUserOverride: true, rollFrame: { ...old.rollFrame, rollId: 'donor-roll', offsetStops: -.5 } });
    c.restoreSettings(donor, { refreshDisplay: false });
    await target.flushScheduledCoreReprocess();
    state.fileQueue[0].selected = false;
    const file = { name: route + '-' + crossing + '.png', size: 1, type: 'image/png' };
    let recipient;
    if (route === 'locked-copy-import') {
      state.rollReference = { settingsSnapshot: donor, applyLock: true, applyCrop: false };
      [recipient] = c.addFilesToQueue([file], { automaticRoll: false });
    } else {
      recipient = { file, selected: true, settings: c.cloneSettings(old) };
      state.fileQueue.push(recipient);
      if (route === 'locked-copy-current') await c.applyCurrentSettingsToSelected();
      else {
        state.rollReference = { settingsSnapshot: donor, applyCrop: false };
        c.applyRollReferenceToSelected();
      }
    }
    const recipe = c.cloneSettings(recipient.settings), prior = c.cloneSettings(old);
    const fresh = { ...recipe, rollFrame: null, semanticMap: null, expiredAnalysis: null };
    const router = c.buildRouterSettings(recipe);
    const comparisons = [];
    let settled;
    f.measurements.length = 0;
    for (const depth of [8, 16]) {
      const before = f.measurements.length;
      const actual = await c.processFileWithSettings(file, recipe, { sourceImageData: base, bitDepth: depth,
        onPreparedSettings: s => { settled ||= c.cloneSettings(s); } });
      const count = f.measurements.length - before;
      const reference = await c.processFileWithSettings(file, fresh, { sourceImageData: base, bitDepth: depth });
      const samples = depth === 16 ? actual.__image16.data : actual.data;
      const expected = depth === 16 ? reference.__image16.data : reference.data;
      const differences = samples.reduce((n, v, i) => n + Number(v !== expected[i]), 0);
      console.log(`${route} ${crossing} ${depth}-bit: recipient measurements=${count}, exposure=${router.exposure}, differing samples=${differences}`);
      comparisons.push({ samples, expected, count, depth, differences });
    }
    for (const { samples, expected, count, depth, differences } of comparisons) {
      assert.equal(count, 1, `${route}: changed recipient is remeasured at ${depth} bits`);
      assert.equal(differences, 0, `${route} ${crossing}: exact fresh ${depth}-bit locked-roll samples`);
      assert.deepEqual(Array.from(samples), Array.from(expected), `${route} ${crossing}: exact fresh ${depth}-bit locked-roll samples`);
    }
    assert.equal(recipe.rollFrame, null, `${route}: invalidated recipient/donor roll record excluded`);
    assert.equal(router.analysisOverride, null, `${route}: old roll histogram does not reach conversion`);
    assert.equal(router.exposure, recipe.coreExposure, `${route}: old density offset does not reach conversion`);
    assert.equal(recipe.semanticMap, null, `${route}: old semantic analysis stays invalidated`);
    assert.equal(recipe.expiredAnalysis, null, `${route}: old rescue stays invalidated`);
    assert.deepEqual(canon(old), canon(prior), `${route}: invalidation does not mutate saved history`);
    assert.deepEqual([settled.wbR, settled.wbG, settled.wbB, settled.expiredBrightness, settled.expiredContrast],
      [1.23, 1, .91, old.expiredBrightness, 0], `${route}: explicit WB and strengths preserved`);
    assert.ok(settled.expiredBrightnessUserOverride && settled.expiredContrastUserOverride);
    assert.deepEqual(canon(settled.filmBase), canon(donor.filmBase), `${route}: manual base remains explicit`);
    assert.deepEqual(canon(recipient.settings.expiredAnalysis), canon(settled.expiredAnalysis), `${route}: corresponding fresh measurement adopted`);
    const count = f.measurements.length;
    await c.processFileWithSettings(file, recipient.settings, { sourceImageData: base, bitDepth: 16 });
    assert.equal(f.measurements.length, count, `${route}: valid new saved measurement reused`);
    c.restoreSettings(settled, { refreshDisplay: false });
    await target.flushScheduledCoreReprocess();
    for (const { expected, depth } of comparisons) {
      const live = f.adjusted(state.processedImageData, settled, depth);
      assert.deepEqual(Array.from(depth === 16 ? live.__image16.data : live.data), Array.from(expected), `${route}: live conversion and real batch ${depth}-bit samples match`);
    }
    f.pool.dispose(); cases++;
  }
}
if (selection === 'all' || selection === 'locked-preservation') {
  for (const roll of [{}, { equalize: false }, { locked: false }, { locked: false, outlier: true, reasons: ['base-density'] }]) {
    for (const route of ['current', 'reference']) {
      const f = await fixture({ type: 'color', manual: true, roll }), { context: c, target, state, old } = f;
      const recipient = { file: { name: 'valid-roll.png' }, selected: true, settings: c.cloneSettings(old) };
      const donor = c.cloneSettings({ ...old, rollFrame: { ...old.rollFrame, rollId: 'donor-roll', offsetStops: -.5 },
        wbR: 1.23, expiredContrast: 0 });
      state.fileQueue[0].selected = false;
      state.fileQueue.push(recipient);
      c.restoreSettings(donor, { refreshDisplay: false });
      if (route === 'current') await c.applyCurrentSettingsToSelected();
      else {
        state.rollReference = { settingsSnapshot: donor, applyCrop: true };
        c.applyRollReferenceToSelected();
      }
      assert.deepEqual(canon(recipient.settings.rollFrame), canon(old.rollFrame), `${route}: matching recipient retains its own lock/density/outlier semantics`);
      assert.notEqual(recipient.settings.rollFrame, old.rollFrame, 'roll record is cloned');
      assert.deepEqual(canon(recipient.settings.semanticMap), canon(old.semanticMap), 'matching recipient anchors retained');
      assert.deepEqual(canon(recipient.settings.expiredAnalysis), canon(old.expiredAnalysis), 'matching recipient rescue retained');
      const router = c.buildRouterSettings(recipient.settings);
      assert.deepEqual(canon(router.analysisOverride), old.rollFrame.locked ? canon(old.rollFrame.channelData) : null, 'only a locked record supplies histogram levels');
      assert.equal(router.exposure, old.coreExposure + rollFrameExposureUnits(old.rollFrame), 'equalization and outlier policy preserved');
      const count = f.measurements.length;
      for (const depth of [8, 16]) {
        const actual = await c.processFileWithSettings(recipient.file, recipient.settings, { sourceImageData: base, bitDepth: depth });
        const reference = await c.processFileWithSettings(recipient.file, { ...old, wbR: 1.23, expiredContrast: 0 }, { sourceImageData: base, bitDepth: depth });
        assert.deepEqual(Array.from(actual.data), Array.from(reference.data), 'valid locked-roll conversion reused exactly');
        if (depth === 16) samePixels(actual, reference, 'valid locked-roll 16-bit precision');
      }
      assert.equal(f.measurements.length, count, 'valid matching recipient needs no rescue remeasurement');
      c.restoreSettings(recipient.settings, { refreshDisplay: false });
      const before = c.captureSnapshot('valid roll');
      c.pushUndo('retype roll');
      Object.assign(state, c.applyInterpretationPatch(state, { filmType: 'bw' }));
      const after = c.captureSnapshot('retyped roll');
      assert.equal(after.settings.rollFrame, null, 'history stores invalidated roll after retype');
      await c.performUndo();
      assert.deepEqual(canon(state.rollFrame), canon(old.rollFrame), 'Undo retains matching old roll analysis');
      assert.deepEqual(canon(state.expiredAnalysis), canon(before.settings.expiredAnalysis), 'Undo retains matching old rescue');
      await c.performRedo();
      assert.equal(state.rollFrame, null, 'Redo restores invalidated new roll recipe');
      f.pool.dispose(); cases++;
    }
  }
}

for (const route of ['current', 'selected', 'detected', 'reference', 'edge-text', 'edge-dx', 'positive-entry']) {
  if (selection !== 'all' && selection !== route) continue;
  for (const modeOnly of route === 'current' || route === 'selected' ? [false, true] : [false]) {
    for (const manual of [false, true]) {
      const f = await fixture({ manual, type: route === 'positive-entry' ? 'bw' : 'positive' }), { context: c, state, target, old } = f;
      const patch = modeOnly ? { positiveMode: 'edit' } : { filmType: 'bw' };
      Object.assign(patch, { wbR: 1.23, wbG: 1, wbB: .91, wbUserOverride: true,
        expiredBrightness: old.expiredBrightness, expiredContrast: 0, coreExposure: 19 });
      target.decodedRecipe = decodeRecipe(encodeRecipe(patch));
      let saved;
      if (route === 'current') c.applyRecipeToCurrent();
      if (route === 'selected') {
        const selected = { file: { name: 'selected.png', size: 1 }, selected: true, settings: structuredClone(old) };
        const unopened = { file: { name: 'unopened.png', size: 1 }, selected: true, settings: null };
        state.fileQueue.push(selected, unopened);
        c.applyRecipeToSelected(); saved = selected.settings;
        assert.equal(state.filmType, old.filmType, 'selected recipe keeps the current photo');
        if (!process.env.NC229_CHECK_BATCH_FIRST) {
          assert.equal(saved.semanticMap, null, 'selected: completed old anchors invalidated');
          assert.equal(saved.expiredAnalysis, null, 'selected: completed old rescue invalidated');
        }
        if (!process.env.NC229_CHECK_BATCH_FIRST) {
          const prepared = await c.processFileWithSettings(unopened.file, null, { sourceImageData: base, stage: 'processed' });
          assert.deepEqual([prepared.settings.filmType, prepared.settings.positiveMode], [modeOnly ? 'positive' : 'bw', modeOnly ? 'edit' : 'correct'], 'unopened selected recipe interpretation reaches the actual processor');
          assert.deepEqual([prepared.settings.wbR, prepared.settings.wbB, prepared.settings.expiredContrast], [1.23, .91, 0], 'unopened recipe gains and explicit default strength survive measurement');
          const roundTrip = parseRollProject(serializeRollProject(buildRollProject({ files: [{ name: unopened.file.name, studioColors: unopened.studioColors, filmTypeOverride: unopened.filmTypeOverride }] })));
          const restored = mergeStudioColors({ filmType: 'color', positiveMode: 'correct', wbR: 1, wbB: 1 }, roundTrip.files[0].studioColors);
          assert.deepEqual([restored.filmType, restored.positiveMode, restored.wbR, restored.wbB, restored.expiredContrast], [modeOnly ? 'color' : 'bw', modeOnly ? 'edit' : 'correct', 1.23, .91, 0], 'saved unopened recipe retains mode/WB/strengths without relying on unsaved pending edits');
          const synced = mergeStudioColors({ filmType: 'color', positiveMode: 'correct' }, { ...unopened.studioColors, coreExposure: 4,
            expiredContrast: 12, expiredContrastUserOverride: false });
          assert.deepEqual([synced.coreExposure, synced.expiredContrast, synced.expiredContrastUserOverride], [4, 12, false], 'later color sync wins over stored recipe colors and strengths');
          assert.equal(synced.wbR, 1.23, 'later color sync retains explicit recipient recipe WB');
          f.measurements.length = 0;
        }
      }
      if (route === 'detected') {
        state.filmEdge = { found: true, filmKind: 'bw' }; await c.applyDetectedFilmToCurrent();
      }
      if (route === 'reference') {
        target.hasRollReference = () => true;
        state.rollReference.settingsSnapshot = { filmType: 'bw', filmBase: { r: 211, g: 192, b: 173, method: 'manual' } };
        c.applyRollReferenceToCurrentForStep2();
      }
      if (route === 'positive-entry') c.convertPositive();
      if (route.startsWith('edge-')) {
        const result = route === 'edge-text' ? { text: { filmKind: 'bw', text: 'B&W' } }
          : { found: true, dx: { dx1: 1, dx2: 2 }, polarity: 'dark' };
        saved = (await c.mergeImportFilmEdge(base, { ...old, filmEdge: null }, { result })).settings;
      }
      saved ||= target.extractCurrentSettings();
      if (process.env.NC229_CHECK_BATCH_FIRST) {
        await c.processFileWithSettings(f.file, saved, { sourceImageData: base, stage: 'processed' });
        assert.ok(f.measurements.length > 0, `${route}: real batch processor must remeasure the retyped recipe`);
      }
      assert.equal(saved.semanticMap, null, `${route}: completed old anchors invalidated`);
      assert.equal(saved.expiredAnalysis, null, `${route}: completed old rescue invalidated`);
      if (!['selected', 'edge-text', 'edge-dx', 'reference', 'positive-entry'].includes(route)) {
        assert.equal(f.timers.length, 1, `${route}: measurement armed before the new conversion token`);
        await f.timers.shift()();
        assert.ok(state.expiredAnalysis, `${route}: live frame measured after conversion`);
      }
      if (route === 'current' || route === 'selected') {
        assert.deepEqual([saved.wbR, saved.wbG, saved.wbB, saved.expiredBrightness, saved.expiredContrast], [1.23, 1, .91, old.expiredBrightness, 0], 'explicit recipe gains and strengths win after invalidation');
        if (route === 'current') assert.deepEqual([state.expiredBrightness, state.expiredContrast], [old.expiredBrightness, 0], 'measurement retains explicit recipe strengths, including defaults');
      } else if (manual) assert.deepEqual([saved.wbR, saved.wbG, saved.wbB], [old.wbR, old.wbG, old.wbB], 'manual WB survives the detected retype');
      f.measurements.length = 0;
      let first;
      const fresh = { ...saved, expiredAnalysis: null, semanticMap: null };
      for (const depth of [8, 16]) {
        const actual = await c.processFileWithSettings(f.file, saved, { sourceImageData: base, bitDepth: depth,
          onPreparedSettings: s => { first ||= structuredClone(s); } });
        const reference = await c.processFileWithSettings(f.file, fresh, { sourceImageData: base, bitDepth: depth });
        assert.deepEqual(Array.from(actual.data), Array.from(reference.data), `${route}: fresh ${depth}-bit adjustment samples`);
        if (depth === 16) samePixels(actual, reference, `${route}: fresh 16-bit plane`);
      }
      assert.ok(f.measurements.length >= 4, `${route}: actual batch remeasures each invalidated saved recipe`);
      assert.notDeepEqual(first.expiredAnalysis, old.expiredAnalysis, `${route}: this fixture distinguishes the interpretations`);
      assert.equal(first.semanticMap, null);
      const count = f.measurements.length;
      const repeated = await c.processFileWithSettings(f.file, first, { sourceImageData: base, bitDepth: 16 });
      const expected = await c.processFileWithSettings(f.file, first, { sourceImageData: base, bitDepth: 16 });
      samePixels(repeated, expected, `${route}: consecutive settled exports exact`);
      assert.equal(f.measurements.length, count, 'valid saved measurement adopted on later exports');
      f.pool.dispose(); cases++;
    }
  }
}
if (selection === 'all' || selection === 'preservation') {
  const f = await fixture({ manual: true }), { context: c, target, state, old } = f;
  target.decodedRecipe = decodeRecipe(encodeRecipe({ filmType: old.filmType, positiveMode: old.positiveMode, coreExposure: 27 }));
  c.applyRecipeToCurrent();
  assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), 'same-interpretation recipe keeps valid anchors');
  assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'same-interpretation recipe keeps valid rescue');
  assert.equal(f.timers.length, 0);
  target.decodedRecipe = decodeRecipe(encodeRecipe({ filmType: 'bw' })); c.applyRecipeToCurrent();
  await f.timers.shift()();
  const retyped = target.extractCurrentSettings();
  await c.performUndo();
  assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), 'undo restores matching old anchors');
  assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'undo restores matching old rescue');
  await c.performRedo();
  assert.deepEqual(canon(state.expiredAnalysis), canon(retyped.expiredAnalysis), 'redo restores matching new rescue');
  assert.equal(state.semanticMap, null, 'redo keeps new interpretation anchors invalidated');
  c.restoreSettings(old, { refreshDisplay: false });
  assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), 'saved source/interpretation restoration keeps matching anchors');
  assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'saved restoration adopts valid measurement');
  assert.deepEqual(canon(state.filmBase), canon(old.filmBase), 'manual base preserved');
  state.filmEdge = { found: true, filmKind: old.filmType };
  await c.applyDetectedFilmToCurrent();
  assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), 'same detected type keeps anchors');
  assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'same detected type keeps rescue');
  for (const result of [{ text: { filmKind: old.filmType, text: 'slide' } }, { found: true, dx: { dx1: 1, dx2: 2 }, polarity: 'dark' }]) {
    target.describeDxFilm = () => ({ filmKind: old.filmType, primaryName: 'slide' });
    const merged = (await c.mergeImportFilmEdge(base, { ...old, filmEdge: null }, { result })).settings;
    assert.deepEqual(canon(merged.semanticMap), canon(old.semanticMap), 'same-type edge merge keeps anchors');
    assert.deepEqual(canon(merged.expiredAnalysis), canon(old.expiredAnalysis), 'same-type edge merge keeps rescue');
  }
  // A mode-only patch on an unopened photo must leave its independently
  // chosen film type intact when the pending recipe overlays its defaults.
  const blank = { file: { name: 'blank.png' }, selected: true, settings: null, filmTypeOverride: { filmType: 'bw', positiveMode: 'correct' } };
  state.fileQueue = [state.fileQueue[0], blank];
  target.decodedRecipe = decodeRecipe(encodeRecipe({ positiveMode: 'edit' })); c.applyRecipeToSelected();
  assert.ok(!Object.hasOwn(blank.pendingEdits, 'filmType'), 'mode-only pending patch never injects an undefined film type');
  const pending = { file: { name: 'pending.png' }, selected: true, settings: structuredClone(old),
    pendingFrameEdit: { baseline: structuredClone(old) }, pendingEdits: { coreExposure: 22 } };
  state.fileQueue.push(pending);
  target.decodedRecipe = decodeRecipe(encodeRecipe({ filmType: 'bw', wbR: 1.31, expiredBrightness: 0 })); c.applyRecipeToSelected();
  assert.equal(pending.pendingFrameEdit.baseline.expiredAnalysis, null, 'provisional selected baseline drops old analysis');
  assert.equal(pending.pendingEdits.wbR, 1.31, 'provisional selected recipe survives the full-source overlay');
  assert.equal(pending.pendingEdits.expiredBrightnessUserOverride, true);
  assert.equal(pending.pendingEdits.coreExposure, 22, 'existing provisional edits preserved');
  f.pool.dispose(); cases++;
}
// Full-settings copying is distinct from applying a partial recipe. The
// donor's measurement comes from different pixels, even in the same mode.
for (const route of ['copy-current', 'copy-reference', 'copy-import']) {
  if (selection !== 'all' && selection !== route) continue;
  for (const modeOnly of [false, true]) {
    if (process.env.NC229_COPY_CROSSING && process.env.NC229_COPY_CROSSING !== (modeOnly ? 'mode' : 'type')) continue;
    const f = await fixture(), { context: c, target, state, old } = f;
    const donor = c.cloneSettings({ ...old, filmType: modeOnly ? 'positive' : 'bw', positiveMode: modeOnly ? 'edit' : 'correct',
      wbR: 1.23, wbG: 1, wbB: .91, wbUserOverride: true, expiredBrightness: old.expiredBrightness, expiredContrast: 0 });
    const donorImage = new ImageData(Uint8ClampedArray.from(base.data, (v, i) => i % 4 === 3 ? v : Math.round(v * .7)), width, height);
    donorImage.__image16 = { width, height, data: Uint16Array.from(data16, (v, i) => i % 4 === 3 ? v : Math.round(v * .7)) };
    const donorPositive = await convertFrameWithRouter({ imageData: donorImage, settings: target.buildRouterSettings(donor), options: { forceFullProcess: true } });
    donor.expiredAnalysis = analyzeExpiredFilm(donorPositive, { borderBuffer: 0 });
    donor.semanticMap = null;
    c.restoreSettings(donor, { refreshDisplay: false });
    await target.flushScheduledCoreReprocess();
    state.fileQueue[0].selected = false;
    const file = { name: 'copy-recipient.png', size: 1, type: 'image/png' };
    let recipient;
    if (route === 'copy-import') {
      state.rollReference = { settingsSnapshot: donor, applyLock: true, applyCrop: false };
      [recipient] = c.addFilesToQueue([file], { automaticRoll: false });
    } else {
      recipient = { file, selected: true, settings: c.cloneSettings(old) };
      state.fileQueue.push(recipient);
      if (route === 'copy-current') await c.applyCurrentSettingsToSelected();
      else {
        state.rollReference = { settingsSnapshot: donor, applyCrop: false };
        c.applyRollReferenceToSelected();
      }
    }
    f.measurements.length = 0;
    const copiedRecipe = c.cloneSettings(recipient.settings);
    let settled;
    const comparisons = [];
    const fresh = { ...copiedRecipe, semanticMap: null, expiredAnalysis: null,
      expiredBrightnessUserOverride: true, expiredContrastUserOverride: true };
    for (const depth of [8, 16]) {
      const before = f.measurements.length;
      const actual = await c.processFileWithSettings(file, copiedRecipe, { sourceImageData: base, bitDepth: depth,
        onPreparedSettings: s => { settled ||= c.cloneSettings(s); } });
      const actualCount = f.measurements.length - before;
      const reference = await c.processFileWithSettings(file, fresh, { sourceImageData: base, bitDepth: depth });
      const plane = depth === 16 ? '__image16' : null;
      const samples = plane ? actual[plane].data : actual.data, expected = plane ? reference[plane].data : reference.data;
      const differences = samples.reduce((n, v, i) => n + Number(v !== expected[i]), 0);
      console.log(`${route} ${modeOnly ? 'mode' : 'type'} ${depth}-bit: recipient measurements=${actualCount}, differing samples=${differences}`);
      comparisons.push({ actualCount, samples, expected, depth });
    }
    for (const { actualCount, samples, expected, depth } of comparisons) {
      assert.equal(actualCount, 1, `${route}: recipient must measure its own new positive`);
      assert.deepEqual(Array.from(samples), Array.from(expected), `${route}: strict fresh ${depth}-bit samples`);
    }
    assert.equal(copiedRecipe.semanticMap, null, `${route}: stale recipient anchors excluded`);
    assert.equal(copiedRecipe.expiredAnalysis, null, `${route}: donor rescue never copied`);
    assert.deepEqual(canon(recipient.settings.expiredAnalysis), canon(settled.expiredAnalysis), `${route}: valid recipient measurement saved by actual processor`);
    assert.deepEqual([settled.wbR, settled.wbB, settled.expiredBrightness, settled.expiredContrast],
      [1.23, .91, old.expiredBrightness, 0], `${route}: explicit WB and measured-equal/default strengths preserved`);
    assert.deepEqual(canon(settled.filmBase), canon(donor.filmBase), `${route}: explicit donor film base preserved`);
    assert.notDeepEqual(canon(settled.expiredAnalysis), canon(donor.expiredAnalysis), `${route}: measurement belongs to recipient pixels`);
    const count = f.measurements.length;
    await c.processFileWithSettings(file, settled, { sourceImageData: base, bitDepth: 16 });
    await c.processFileWithSettings(file, recipient.settings, { sourceImageData: base, bitDepth: 16 });
    assert.equal(f.measurements.length, count, `${route}: valid prepared recipient analysis adopted`);
    f.pool.dispose(); cases++;
  }
}
if (selection === 'all' || selection === 'copy-preservation') {
  const f = await fixture({ manual: true }), { context: c, state, old } = f;
  const recipient = state.fileQueue[0];
  const donor = c.cloneSettings(old);
  donor.expiredAnalysis = { ...donor.expiredAnalysis, confidence: .1 };
  donor.semanticMap = null;
  donor.wbR = 1.23; donor.expiredContrast = 0;
  c.applySettingsToItems(donor, [recipient]);
  assert.deepEqual(canon(recipient.settings.semanticMap), canon(old.semanticMap), 'matching recipient anchors retained');
  assert.deepEqual(canon(recipient.settings.expiredAnalysis), canon(old.expiredAnalysis), 'matching recipient rescue retained instead of donor rescue');
  const count = f.measurements.length;
  await c.processFileWithSettings(f.file, recipient.settings, { sourceImageData: base, bitDepth: 16 });
  assert.equal(f.measurements.length, count, 'matching recipient recipe needs no replacement measurement');
  c.applySettingsToItems(donor, [recipient], { includeCrop: true });
  assert.deepEqual(canon(recipient.settings.semanticMap), canon(old.semanticMap), 'matching copied geometry keeps recipient anchors');
  assert.deepEqual(canon(recipient.settings.expiredAnalysis), canon(old.expiredAnalysis), 'matching copied geometry keeps recipient rescue');
  for (const patch of [{ filmBase: { ...donor.filmBase, r: 199 } }, { coreBorderBuffer: 12 }, { expiredUnevenFog: 27 },
    { coreExposure: 25 }, { cropRegion: { left: 1, top: 2, width: 60, height: 44 } }, { mirrored: true }]) {
    recipient.settings = c.cloneSettings(old);
    c.applySettingsToItems({ ...donor, ...patch }, [recipient], { includeCrop: true });
    assert.equal(recipient.settings.expiredAnalysis, null, 'changed copied measurement input excludes old recipient rescue');
    if (patch.cropRegion || patch.mirrored) assert.equal(recipient.settings.semanticMap, null, 'changed copied geometry excludes old anchors');
  }
  recipient.settings = c.cloneSettings(old);
  recipient.pendingFrameEdit = { baseline: c.cloneSettings(old) };
  recipient.pendingEdits = { filmType: 'positive', positiveMode: 'edit', wbR: .7, expiredContrast: 12 };
  c.applySettingsToItems({ ...donor, filmType: 'bw' }, [recipient]);
  assert.equal(recipient.pendingFrameEdit.baseline.expiredAnalysis, null, 'full-copy pending baseline excludes old rescue');
  assert.equal(recipient.pendingFrameEdit.baseline.filmType, 'bw', 'full-copy pending baseline keeps new interpretation');
  assert.equal(recipient.pendingEdits, undefined, 'superseded pending recipe cannot restore old values');
  f.pool.dispose(); cases++;
}
if (selection === 'all' || selection === 'saved-ownership') {
  for (const modeOnly of [false, true]) for (const explicitDefaults of [false, true]) {
    const caseName = `${modeOnly ? 'mode' : 'type'}-${explicitDefaults ? 'defaults' : 'equal'}`;
    if (process.env.NC229_OWNERSHIP_CASE && process.env.NC229_OWNERSHIP_CASE !== caseName) continue;
    const f = await fixture({ manual: true }), { context: c, target, state, old } = f;
    const values = explicitDefaults ? EXPIRED_RESCUE_DEFAULTS : defaultExpiredRescueParams(old.expiredAnalysis);
    const strengths = ['expiredBrightness', 'expiredContrast'].map(key => values[key]);
    Object.assign(state, c.applyRecipeSettings(state, { expiredBrightness: strengths[0], expiredContrast: strengths[1] }));
    const extracted = c.extractCurrentSettings(), cloned = c.cloneSettings(extracted);
    const project = parseRollProject(serializeRollProject(c.buildCurrentProject({ persist: true })));
    const restored = c.sanitizeProjectSettings(project.files[0].settings);
    c.restoreSettings(restored, { refreshDisplay: false });
    assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'project restoration retains corresponding valid rescue');
    const count = f.measurements.length;
    await c.processFileWithSettings(f.file, restored, { sourceImageData: base, bitDepth: 16 });
    assert.equal(f.measurements.length, count, 'saved matching analysis is adopted');
    target.decodedRecipe = decodeRecipe(encodeRecipe(modeOnly ? { positiveMode: 'edit' } : { filmType: 'bw' }));
    c.applyRecipeToCurrent();
    await f.timers.shift()();
    console.log(`saved-ownership ${modeOnly ? 'mode' : 'type'} ${explicitDefaults ? 'defaults' : 'measured-equal'}: expected=${strengths}, restored/retyped=${[state.expiredBrightness, state.expiredContrast]}`);
    for (const depth of [8, 16]) {
      const retyped = c.extractCurrentSettings();
      const actual = await c.processFileWithSettings(f.file, retyped, { sourceImageData: base, bitDepth: depth });
      const reference = await c.processFileWithSettings(f.file, { ...retyped, expiredBrightness: strengths[0], expiredContrast: strengths[1],
        expiredBrightnessUserOverride: true, expiredContrastUserOverride: true }, { sourceImageData: base, bitDepth: depth });
      const samples = depth === 16 ? actual.__image16.data : actual.data;
      const expected = depth === 16 ? reference.__image16.data : reference.data;
      console.log(`saved-ownership ${caseName} ${depth}-bit: differing samples=${samples.reduce((n, v, i) => n + Number(v !== expected[i]), 0)}`);
    }
    assert.deepEqual([state.expiredBrightness, state.expiredContrast], strengths, 'saved explicit strength intent survives retype and remeasurement');
    for (const snapshot of [extracted, cloned, project.files[0].settings, restored, c.extractCurrentSettings()]) {
      assert.equal(snapshot.expiredBrightnessUserOverride, true, 'production extraction/clone/project/restore retains brightness ownership');
      assert.equal(snapshot.expiredContrastUserOverride, true, 'production extraction/clone/project/restore retains contrast ownership');
    }
    const retyped = c.extractCurrentSettings();
    await c.performUndo();
    assert.deepEqual([state.expiredBrightness, state.expiredContrast], strengths, 'undo restores explicit saved strengths');
    assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'undo restores matching old rescue');
    await c.performRedo();
    assert.deepEqual([state.expiredBrightness, state.expiredContrast], strengths, 'redo retains explicit strengths');
    assert.deepEqual(canon(state.expiredAnalysis), canon(retyped.expiredAnalysis), 'redo adopts matching new rescue');
    for (const depth of [8, 16]) {
      const actual = await c.processFileWithSettings(f.file, c.cloneSettings(retyped), { sourceImageData: base, bitDepth: depth });
      const reference = await c.processFileWithSettings(f.file, { ...retyped, expiredAnalysis: null,
        expiredBrightness: strengths[0], expiredContrast: strengths[1], expiredBrightnessUserOverride: true, expiredContrastUserOverride: true },
      { sourceImageData: base, bitDepth: depth });
      assert.deepEqual(Array.from(actual.data), Array.from(reference.data), 'saved retyped recipe exact 8-bit samples');
      if (depth === 16) samePixels(actual, reference, 'saved retyped recipe strict 16-bit samples');
    }
    f.pool.dispose(); cases++;
  }
}
if (selection === 'all' || selection === 'copy-adoption') {
  for (const change of ['type', 'region', 'strength']) {
    const f = await fixture(), { context: c, target, state, old } = f;
    const item = state.fileQueue[0];
    item.settings = c.cloneSettings({ ...old, semanticMap: null, expiredAnalysis: null });
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    target.measureExpiredAnalysisWithSpatial = async () => { enter(); await held; return null; };
    const processing = c.processFileWithSettings(f.file, c.cloneSettings(item.settings), { sourceImageData: base, bitDepth: 16 });
    await entered;
    const edit = change === 'type' ? { filmType: 'bw' } : change === 'region' ? { coreBorderBuffer: 14 }
      : { expiredBrightness: 0, expiredContrast: 25, expiredBrightnessUserOverride: true, expiredContrastUserOverride: true, wbR: 1.31 };
    item.settings = c.cloneSettings({ ...item.settings, ...edit });
    release(); await processing;
    if (change === 'strength') {
      assert.ok(item.settings.expiredAnalysis, 'same measurement inputs adopt corresponding analysis despite later tone edits');
      assert.deepEqual([item.settings.expiredBrightness, item.settings.expiredContrast, item.settings.wbR], [0, 25, 1.31], 'adopting measurement preserves newer explicit strengths/WB');
    } else assert.equal(item.settings.expiredAnalysis, null, 'new interpretation/region rejects stale measurement adoption');
    assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'batch adoption never mutates live history measurement');
    f.pool.dispose(); cases++;
  }
  const f = await fixture(), { context: c, state, old } = f;
  const item = state.fileQueue[0];
  item.settings = c.cloneSettings({ ...old, semanticMap: null, expiredAnalysis: null });
  const reduced = await c.processFileWithSettings(f.file, c.cloneSettings(item.settings), {
    sourceImageData: base, tileMaxDimension: 32, bitDepth: 16 });
  assert.equal(reduced.width, 32, 'actual contact-sheet route measures a reduced source');
  assert.equal(item.settings.expiredAnalysis, null, 'reduced contact-sheet measurement cannot enter full-resolution saved recipe');
  const count = f.measurements.length;
  const full = await c.processFileWithSettings(f.file, item.settings, { sourceImageData: base, bitDepth: 16 });
  assert.equal(full.width, width);
  assert.equal(f.measurements.length, count + 1, 'subsequent full export must measure its full source');
  assert.ok(item.settings.expiredAnalysis, 'full-source result adopted by saved recipient');
  f.pool.dispose(); cases++;
}
console.log(`interpretationRoutes: ${cases} tiny real-caller/conversion/rescue/batch cases; explicit WB/strengths, saved same-type analysis and history preserved; exact 8/16 samples`);
