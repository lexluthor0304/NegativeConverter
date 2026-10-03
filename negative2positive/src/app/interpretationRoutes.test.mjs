import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness, samePixels } from './geometryTestHarness.mjs';
import * as filmType from './filmTypeOverride.js';
import { encodeRecipe, decodeRecipe, RECIPE_KEYS } from './recipes.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { hasWindowEdits, overlayWindowEdits } from './provisionalPhoto.js';
import { mergeStudioColors } from './studioSettings.js';
import { buildRollProject, serializeRollProject, parseRollProject } from './rollProject.js';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';
import { resolveAnalysisRegion, analysisPixelBounds } from './analysisRegion.js';
import { planeBuffersOf, sharesPlaneBuffers, markOwnedPlanes } from './planeRelease.js';
import { downsampleImageDataForMaxPixels } from './imageDataOps.js';
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
  'makeLinearCurvePoints', 'makeLinearCurveLut'];
const positiveMarker = "    document.getElementById('convertPositiveBtn').addEventListener('click', () => {";
const positiveStart = source.indexOf(positiveMarker), positiveEnd = source.indexOf('\n    });', positiveStart);
assert.ok(positiveStart >= 0 && positiveEnd > positiveStart);
const positiveCaller = 'var convertPositive = () => {' + source.slice(positiveStart + positiveMarker.length, positiveEnd) + '\n    };';

async function fixture({ type = 'positive', mode = 'correct', manual = false } = {}) {
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
    resolveAnalysisRegion, analysisPixelBounds, downsampleImageDataForMaxPixels,
    hasWindowEdits, overlayWindowEdits, mergeStudioColors, planeBuffersOf, sharesPlaneBuffers, markOwnedPlanes,
    decodedRecipe: null, expiredAnalysisKey: null, expiredTabPending: false,
    coreReprocessToken: 4, displayedFrameToken: 4, processNegativeInFlight: null,
    document: { body: { dataset: {} }, getElementById: () => ({ value: '', classList: { toggle() {} } }) },
    sanitizePresetType: v => ['positive', 'color', 'bw'].includes(v) ? v : 'color',
    inferFilmTypeFromLegacyPreset: (_v, fallback) => fallback,
    sanitizeCoreColorModel: (v, fallback) => v || fallback, sanitizeCoreEnhancedProfile: (v, fallback) => v || fallback,
    sanitizeFilmBase: (v, fallback) => structuredClone(v || fallback),
    sanitizeFilmEdgeForSettings: v => v ? { checked: true, ...structuredClone(v) } : null,
    sanitizeRollFrameForSettings: v => v ? structuredClone(v) : null,
    sanitizeLensCorrection: v => ({ enabled: false, params: {}, modes: {}, ...v }),
    normalizePaperId: v => v || 'none', normalizeToningId: v => v || 'none',
    sanitizeRepairStrokes: v => v || [], sanitizeFrameMetadata: v => v || {},
    sanitizeLookForSettings: v => v || null, sanitizeLocalExposureForSettings: () => null,
    usesSilverCoreConversion: () => true, requiresFilmBase: () => false,
    baseSizeSource: () => base, pendingGeometryEdits: () => null,
    createPerfTrace: () => ({ mark() {}, end() {} }),
    buildRouterSettings: s => ({ filmType: s.filmType, positiveMode: s.positiveMode, filmBase: s.filmBase,
      filmPreset: 'none', colorModel: 'standard', borderBuffer: 0, exposure: s.coreExposure }),
    getColorAnalysisSample: () => null,
    convertFrameOffMainThread: convertFrameWithRouter,
    renderGeometryChain: async image => image,
    applyLensCorrectionWithSettings: async image => image,
    applyAdjustmentsWithSettings: async (image, s, options) => adjusted(image, s, options.bitDepth),
    cloneSettings: s => structuredClone(s),
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
  vm.runInContext(positiveCaller, c);
  if (/^    function applyRecipeSettings\(/m.test(source)) vm.runInContext(fn('applyRecipeSettings'), c);
  target.extractCurrentSettings = () => c.sanitizeSettings(state);
  const realAnalyze = target.analyzeExpiredFilm;
  target.analyzeExpiredFilm = (...args) => { measurements.push(args); return realAnalyze(...args); };
  await target.flushScheduledCoreReprocess();
  c.runExpiredAnalysis();
  measurements.length = 0;
  const old = target.extractCurrentSettings();
  state.fileQueue[0].settings = structuredClone(old);
  return { ...h, file, timers, measurements, old, adjusted };
}

let cases = 0;
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
console.log(`interpretationRoutes: ${cases} tiny real-caller/conversion/rescue/batch cases; explicit WB/strengths, saved same-type analysis and history preserved; exact 8/16 samples`);
