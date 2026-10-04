// Standalone Node test: what the expired rescue's stored measurement is
// taken on (#229 review R1-074, R1-017). Runs the real main.js functions,
// with the real opencv-js build for the fog surface - run with:
// node negative2positive/src/app/expiredMeasurement.test.mjs
//
// - R1-074: a fog-surface request joins the run in flight only when it
//   measures the same inputs. One whose inputs differ (the strengths One-click
//   colour correct resets, a new semantic map, analysis area or plane)
//   measures again and supersedes it, so the stored measurement is the one
//   1703835 took: every request measured with the settings of its call.
// - R1-017: an automatic retype (#231's flip of the open photo) and "These
//   are positives" measure the frame in its new mode, with the strengths that
//   measurement sets, as a photo opened in that mode is; strengths the user
//   moved stay. The flip converts through processNegative, which measures;
//   "These are positives" only converts again and is measured once that
//   frame has settled.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createHarness, makeBase, functionSource, settle } from './geometryTestHarness.mjs';
import { applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { ROLL_MONOCHROME } from './rollFilmType.js';
import { importConversionKey } from './importDetection.js';
import { withoutLearnedDefaults } from './learnedDefaults.js';
import { resolveAnalysisRegion, analysisPixelBounds } from './analysisRegion.js';
import { downsampleImageDataForMaxPixels } from './imageDataOps.js';
import {
  analyzeExpiredFilm, buildExpiredSpatialStage, defaultExpiredRescueParams, fitExpiredSpatial, sanitizeExpiredRescueParams,
  EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS
} from '../pipeline/expiredRescue.js';
import {
  expiredAnalysisFromMaps, measureExpiredSpatialMaps, measureExpiredSpatialMapsFromSample, sampleExpiredSpatialInputSliced
} from './expiredRescueOpenCv.js';

const require = createRequire(import.meta.url);
let cv = require('@techstark/opencv-js');
if (cv && typeof cv.then === 'function') cv = await cv;
if (cv && !cv.Mat && cv.default) cv = cv.default;
assert.ok(cv && cv.Mat, 'opencv-js loads in Node');
globalThis.cv = cv;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label) {
  for (let i = 0; i < 400 && !condition(); i++) await tick();
  assert.ok(condition(), label);
}
const strengthsOf = state => [state.expiredBrightness, state.expiredContrast];

// An aged positive (16-bit): a textured ramp under fog that grows towards the
// left edge, with per-layer gamma and a warm lean. `grey` gives the scene
// inverted to grey instead, the way a B&W negative of it converts.
function agedPositive({ width = 240, height = 160, seed = 0, grey = false } = {}) {
  const data8 = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const scene = ((x * 7 + y * 3 + seed) % 40) / 39;
    const fog = 0.10 + 0.14 * (1 - x / (width - 1));
    for (let c = 0; c < 3; c++) {
      const v = grey ? 0.08 + 0.8 * (1 - scene) * (1 - fog)
        : Math.min(1, (fog + (0.86 - fog) * Math.pow(scene, [0.9, 1, 1.1][c])) * [1, 0.94, 0.86][c]);
      data16[o + c] = Math.round(v * 65535);
      data8[o + c] = data16[o + c] >>> 8;
    }
    data16[o + 3] = 65535; data8[o + 3] = 255;
  }
  const image = { width, height, data: data8 };
  image.__image16 = { width, height, data: data16 };
  return image;
}

// A plain context over the real functions; unlisted UI helpers are no-ops.
function proxyContext(target) {
  return vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    }
  }));
}

// ---------------------------------------------------------------------------
// R1-074: the fog-surface join
// ---------------------------------------------------------------------------

const SPATIAL_FUNCTIONS = [
  'isCurrentLoad', 'expiredSourceKey', 'expiredInterpretation', 'baseSizeSource', 'sanitizeNumeric', 'clampBetween', 'expiredAnalysisSample',
  'measureExpiredAnalysisWithSpatial', 'expiredSpatialInputs', 'runExpiredSpatialAnalysis', 'measureExpiredSpatialAnalysis',
  'applyExpiredAnalysisDefaults', 'resetExpiredStrengthsInState', 'runExpiredAnalysis', 'settlePendingCropDetection'
];
// 1703835's interactive measurement: OpenCV in the page, each request measured
// in one go with the settings of its call once OpenCV was ready.
const SOURCE_1703835 = String.raw`
    async function runExpiredSpatialAnalysis() {
      const key = expiredSourceKey();
      const generation = loadGeneration;
      if (expiredOpenCvState !== 'ready') {
        expiredOpenCvState = 'loading';
        updateExpiredRescueUI();
      }
      const ready = await ensureOpenCvReady();
      expiredOpenCvState = ready ? 'ready' : 'failed';
      if (!ready) {
        updateExpiredRescueUI();
        return false;
      }
      const current = state.processedImageData;
      if (!current || !isCurrentLoad(generation) || key !== expiredSourceKey() || !state.expiredEnabled || !state.expiredAnalysis) return false;
      try {
        const analysis = measureExpiredAnalysisWithSpatial(
          current,
          { ...state, autoFrameMeta: state.autoFrame.lastDiagnostics },
          state.loadedBaseImageData || state.originalImageData
        );
        if (!analysis || key !== expiredSourceKey() || !isCurrentLoad(generation)) return false;
        // Brightness and contrast that still hold the first phase's measured
        // values follow the new measurement; values the user moved stay.
        const previousAuto = defaultExpiredRescueParams(state.expiredAnalysis);
        const untouched = state.expiredBrightness === previousAuto.expiredBrightness && state.expiredContrast === previousAuto.expiredContrast;
        applyExpiredAnalysisDefaults(state, analysis, { force: untouched });
        expiredAnalysisKey = key;
        syncAllSlidersFromState();
        updateExpiredRescueUI();
        markCurrentFileDirty();
        schedulePreviewUpdate();
        scheduleFullUpdate();
        return true;
      } catch (error) {
        console.warn('Expired film: OpenCV measurement failed', error);
        updateExpiredRescueUI();
        return false;
      }
    }
    function measureExpiredAnalysisWithSpatial(processed, settings, sourceImageData) {
      const sample = expiredAnalysisSample(processed, settings, sourceImageData);
      const maps = measureExpiredSpatialMaps(sample.image, { ...sample.options, placement: sample.placement });
      const spatial = maps ? fitExpiredSpatial(maps) : null;
      if (!spatial) return null;
      // Local contrast does not move the histogram's floor; leave it out here.
      const stage = buildExpiredSpatialStage({
        ...sanitizeExpiredRescueParams(settings),
        expiredEnabled: true,
        expiredLocalContrast: 0,
        expiredAnalysis: { spatial }
      });
      const analysis = analyzeExpiredFilm(sample.image, { ...sample.options, anchors: settings.semanticMap, placement: sample.placement, spatial: stage });
      return analysis ? { ...analysis, spatial } : null;
    }
    function runExpiredAnalysis(processed = state.processedImageData, { force = false } = {}) {
      if (!processed) return false;
      const sample = expiredAnalysisSample(
        processed,
        { ...state, autoFrameMeta: state.autoFrame.lastDiagnostics },
        state.loadedBaseImageData || state.originalImageData
      );
      const analysis = analyzeExpiredFilm(sample.image, { ...sample.options, anchors: state.semanticMap, placement: sample.placement });
      if (!analysis) {
        updateExpiredRescueUI();
        return false;
      }
      applyExpiredAnalysisDefaults(state, analysis, { force });
      expiredAnalysisKey = expiredSourceKey();
      syncAllSlidersFromState();
      updateExpiredRescueUI();
      markCurrentFileDirty();
      void runExpiredSpatialAnalysis();
      return true;
    }`;
const UNCHANGED_SINCE_1703835 = [
  'isCurrentLoad', 'expiredSourceKey', 'expiredInterpretation', 'sanitizeNumeric', 'clampBetween', 'expiredAnalysisSample', 'applyExpiredAnalysisDefaults',
  'resetExpiredStrengthsInState'
];

// A rescued positive on screen, its global measurement not yet taken. The
// worker half of each fog-surface request waits in `held` until released.
function spatialContext({ at1703835 = false, unevenFog = 0 } = {}) {
  const frame = agedPositive();
  const state = {
    processedImageData: frame, originalImageData: frame, croppedImageData: null, loadedBaseImageData: frame,
    loadedFile: { name: 'aged.png' }, filmType: 'positive', positiveMode: 'correct', coreBorderBuffer: 10,
    rotationAngle: 0, mirrored: false, cropRegion: null, autoFrame: { lastDiagnostics: null }, semanticMap: null,
    ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredUnevenFog: unevenFog, expiredAnalysis: null
  };
  const held = [];
  const target = {
    state, cropDetection: null, loadGeneration: 1, expiredAnalysisKey: null, expiredOpenCvState: 'idle', expiredSpatialRun: null,
    yieldToPaint: tick, ensureOpenCvReady: async () => true,
    runOpenCvTask: async (type, { build, onMainThread }) => {
      assert.equal(type, 'expired-spatial-maps');
      const input = await build();
      if (input == null) return null;
      await new Promise(resolve => held.push(resolve));
      return onMainThread(input);
    },
    analyzeExpiredFilm, buildExpiredSpatialStage, defaultExpiredRescueParams, fitExpiredSpatial, sanitizeExpiredRescueParams,
    EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS, resolveAnalysisRegion, analysisPixelBounds, downsampleImageDataForMaxPixels,
    expiredAnalysisFromMaps, measureExpiredSpatialMaps, measureExpiredSpatialMapsFromSample, sampleExpiredSpatialInputSliced
  };
  const context = proxyContext(target);
  const names = at1703835 ? UNCHANGED_SINCE_1703835 : SPATIAL_FUNCTIONS;
  vm.runInContext(names.map(functionSource).join('\n') + (at1703835 ? SOURCE_1703835 : ''), context);
  return { context, state, target, held, frame };
}

// One-click colour correct (setExpiredEnabled(true, { reanalyze: true }))
// with the rescue already on: the strengths go back to the defaults and the
// frame is measured again.
function colourCorrect(context) {
  context.resetExpiredStrengthsInState({ force: true });
  context.runExpiredAnalysis(context.state.processedImageData, { force: true });
}
const release = async (held, index) => { held[index](); await settle(); await tick(); };

// What 1703835 stored: the first request measured (uneven fog 0) before the
// click could happen, then the click's request with the reset strengths.
const reference = spatialContext({ at1703835: true });
reference.context.runExpiredAnalysis(reference.frame);
await until(() => reference.state.expiredAnalysis?.spatial, '1703835: the first fog surface is measured');
const firstAt1703835 = structuredClone(reference.state.expiredAnalysis);
colourCorrect(reference.context);
await until(() => reference.state.expiredAnalysis?.spatial && reference.state.expiredUnevenFog === 100, '1703835: the click is measured');
await settle();
const at1703835 = { analysis: structuredClone(reference.state.expiredAnalysis), strengths: strengthsOf(reference.state) };
assert.notDeepEqual(at1703835.analysis, firstAt1703835, 'the fixture: uneven fog 0 and 100 measure differently');

for (const order of [[0, 1], [1, 0]]) {
  const run = spatialContext();
  run.context.runExpiredAnalysis(run.frame);
  await until(() => run.held.length === 1, 'the first fog surface waits for the worker');
  // The click while it runs: the reset strengths (uneven fog 100) differ.
  colourCorrect(run.context);
  await until(() => run.held.length === 2, 'a request with other inputs measures again instead of joining');
  for (const index of order) await release(run.held, index);
  assert.deepEqual(run.state.expiredAnalysis, at1703835.analysis, `released ${order}: the click's measurement is stored, as at 1703835`);
  assert.deepEqual(strengthsOf(run.state), at1703835.strengths, `released ${order}: with its strengths`);
  assert.equal(run.target.expiredSpatialRun, null);
}

// Same inputs join; each input the measurement reads starts a run of its own.
{
  const run = spatialContext({ unevenFog: 100 });
  run.context.runExpiredAnalysis(run.frame);
  await until(() => run.held.length === 1, 'measuring');
  const joined = run.context.runExpiredSpatialAnalysis();
  assert.equal(joined, run.target.expiredSpatialRun.promise, 'a request with the same inputs joins');
  await tick();
  assert.equal(run.held.length, 1);
  const variants = [
    ['a semantic map', state => { state.semanticMap = { width: 2, height: 2, labels: [0, 0, 1, 1] }; }],
    ['an analysis area', state => {
      state.autoFrame.lastDiagnostics = { imageArea: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] };
    }],
    ['the border buffer', state => { state.coreBorderBuffer = 4; }],
    ['the committed plane', state => {
      state.processedImageData.__image16 = { ...state.processedImageData.__image16, data: state.processedImageData.__image16.data.slice() };
    }]
  ];
  for (const [label, change] of variants) {
    const count = run.held.length;
    change(run.state);
    run.context.runExpiredSpatialAnalysis();
    await until(() => run.held.length === count + 1, `${label} measures again`);
  }
  // Local contrast is left out of the measured stage: still the same inputs.
  const settings = { ...run.state, autoFrameMeta: run.state.autoFrame.lastDiagnostics };
  const now = run.context.expiredSpatialInputs(run.state.processedImageData, settings, run.frame);
  const local = run.context.expiredSpatialInputs(run.state.processedImageData, { ...settings, expiredLocalContrast: 60, expiredBrightness: 30 }, run.frame);
  assert.deepEqual(Object.keys(now).filter(key => now[key] !== local[key]), [], 'local contrast and brightness are not inputs');
  // Only the newest run lands: release the older ones last.
  const newest = run.held.length - 1;
  await release(run.held, newest);
  const landed = structuredClone(run.state.expiredAnalysis);
  for (let i = 0; i < newest; i++) await release(run.held, i);
  assert.deepEqual(run.state.expiredAnalysis, landed, 'superseded runs never land');
  assert.ok(landed.spatial);
}
for (const mode of ['owned', 'superseded', 'disabled', 'new-load', 'new-interpretation']) {
  const run = spatialContext({ unevenFog: 100 });
  run.context.runExpiredAnalysis(run.frame);
  await until(() => run.held.length === 1, mode + ': actual fog worker held');
  let settled = false;
  if (mode === 'disabled') run.state.expiredEnabled = false;
  if (mode === 'new-load') run.target.loadGeneration++;
  if (mode === 'new-interpretation') run.state.filmType = 'bw';
  const barrier = run.context.settlePendingCropDetection().then(() => { settled = true; });
  for (let i = 0; i < 10; i++) await tick();
  if (['owned', 'superseded'].includes(mode)) {
    assert.equal(settled, false, mode + ': exact recipe/export settlement must await its current spatial measurement');
    assert.equal(Boolean(run.state.expiredAnalysis.spatial), false);
    if (mode === 'superseded') {
      run.state.coreBorderBuffer = 4;
      run.context.runExpiredSpatialAnalysis();
      await until(() => run.held.length === 2, 'replacement worker held');
      await release(run.held, 0);
      for (let i = 0; i < 10; i++) await tick();
      assert.equal(settled, false, 'barrier follows the replacement owned measurement');
      await release(run.held, 1);
    } else await release(run.held, 0);
    await barrier;
    assert.ok(run.state.expiredAnalysis.spatial, 'exact recipe now includes actual OpenCV spatial result');
    assert.equal(run.target.expiredSpatialRun, null);
  } else {
    await barrier;
    assert.equal(settled, true, mode + ': an unowned measurement cannot block this recipe');
    const analysis = structuredClone(run.state.expiredAnalysis);
    await release(run.held, 0);
    assert.deepEqual(run.state.expiredAnalysis, analysis, mode + ': stale reply cannot change current recipe');
  }
  console.log('spatial settlement PASS ' + mode);
}

for (const format of ['png', 'tiff']) {
  const run = spatialContext({ unevenFog: 100 });
  const {context:c,state,target,held}=run;
  state.currentStep=3;state.dustRemoval={ai:false,enabled:false,mask:null};state.repairStrokes=[];state.currentFileIndex=0;
  const item={file:{name:'aged.png'},isDirty:true,settings:null};let promoted=false;let persisted=0;let encoded=0;
  const overlay={show:async()=>{},hide:()=>{},updateProgress:()=>{},setCancelable:()=>{}};
  Object.assign(target,{
    processNegativeInFlight:null,fullResolutionRenderTimer:null,
    getCurrentQueueItem:()=>item,getExportInfo:()=>({format,bitDepth:format==='tiff'?16:8,mimeType:'image/'+format}),
    buildActiveExportFileName:()=> 'output.'+format,isTauriDesktop:()=>false,
    manualEditRevision:0, i18n:{en:{}}, currentLang:'en',getLoadingOverlay:()=>overlay,
    createExportWorkerBridge:()=>({dispose(){}}),createExportBands:()=>null,exportBands:null,
    ensureFullDecode:async()=>{
      if(!promoted){promoted=true;const full=agedPositive({width:320,height:220,seed:7});state.originalImageData=state.loadedBaseImageData=state.processedImageData=full;c.runExpiredAnalysis(full);}
      return true;
    },
    colorAnalysisSampleMissing:()=>false,whenGeometrySettled:async()=>{},geometryOutOfStep:()=>false,
    flushScheduledCoreReprocess:async()=>{},fullResolutionIsStale:()=>false,
    extractCurrentSettings:()=>{persisted++;return structuredClone({filmType:state.filmType,positiveMode:state.positiveMode,expiredEnabled:state.expiredEnabled,expiredAnalysis:state.expiredAnalysis,expiredBrightness:state.expiredBrightness,expiredContrast:state.expiredContrast});},
    renderAndEncodeCurrentImage:async()=>{await c.prepareCurrentImageForExport();encoded++;assert.deepEqual(item.settings.expiredAnalysis,state.expiredAnalysis,'real saved recipe and prepared image measurement must agree');return new Blob(['bounded']);},
    saveBlob:async()=>({saved:false,path:null})
  });
  vm.runInContext(['exportSingle','persistCurrentFileSettings','prepareCurrentImageForExport','ensureFullResolutionReadyForExport','ensureRepairsReadyForExport'].map(functionSource).join('\n'),c);
  c.runExpiredAnalysis(run.frame);await until(()=>held.length===1,'initial source worker');await release(held,0);assert.ok(state.expiredAnalysis.spatial);
  let error;const exporting=c.exportSingle().catch(e=>{error=e;});
  await until(()=>held.length===2||error,'full decode starts new actual spatial measurement');if(error)throw error;
  const persistedBeforeFullMeasurement=persisted;
  await release(held,1);await exporting;if(error)throw error;
  assert.equal(persistedBeforeFullMeasurement,0,'post-decode recipe must wait for actual full-source measurement');
  assert.equal(persisted,1);assert.equal(encoded,1);assert.ok(item.settings.expiredAnalysis.spatial);
  console.log('postdecode saved recipe PASS '+format);
}

console.log('expiredMeasurement: a fog-surface request with other inputs measures again; the stored measurement is 1703835\'s (R1-074)');

// ---------------------------------------------------------------------------
// R1-017: the open photo retyped
// ---------------------------------------------------------------------------

const RETYPE_FUNCTIONS = [
  'expiredSourceKey', 'expiredInterpretation', 'hasCurrentExpiredAnalysis', 'expiredAnalysisSample', 'runExpiredAnalysis',
  'maybeAnalyzeExpiredRescue', 'applyExpiredAnalysisDefaults', 'remeasureExpiredAfterRetype', 'measurementInputsPending',
  'settleMeasurementInputs', 'sanitizeNumeric', 'clampBetween', 'flipImportPhoto', 'retypeImportItem', 'applyImportPositives'
];
// The positive each interpretation converts to (the conversion is a stand-in:
// a positive scan shows the frame as it is, a B&W negative inverts to grey).
const SCAN = agedPositive({ width: 96, height: 64, seed: 3 });
const AS_BW = agedPositive({ width: 96, height: 64, seed: 3, grey: true });
const positiveOf = filmType => {
  const frame = filmType === 'bw' ? AS_BW : SCAN;
  const copy = { width: frame.width, height: frame.height, data: frame.data.slice() };
  copy.__image16 = { width: frame.width, height: frame.height, data: frame.__image16.data.slice() };
  return copy;
};
const RECIPE_KEYS = ['filmType', 'positiveMode', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason', 'expiredAnalysis', ...EXPIRED_RESCUE_KEYS];

// The open photo of a rescue session, converted by the real processNegative.
// `convert` holds a conversion until released when `holdConversions` is set.
async function openRescued(filmType, { filmTypeReason = filmType === 'positive' ? 'noMask' : 'rollMonochrome', holdConversions = false } = {}) {
  const base = makeBase(96, 64, 9);
  const h = createHarness(base, { realProcessNegative: true });
  const c = h.context;
  const item = { id: 1, file: { name: 'leader.png' } };
  const measured = [];
  const heldConversions = [];
  // The roll's decision (#231): the frames are B&W negatives.
  const target = { filmType: 'bw', confidence: 'medium', reason: ROLL_MONOCHROME.reason };
  const record = { flipping: false, items: [item], rekeys: [], typed: new Map([[item, target]]) };
  let refreshes = 0;
  delete h.target.maybeAnalyzeExpiredRescue;
  Object.assign(h.state, {
    loadedFile: item.file, filmType, positiveMode: 'correct', filmTypeSource: 'auto', filmTypeConfidence: 'low', filmTypeReason,
    ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredAnalysis: null, semanticMap: null, coreBorderBuffer: 10,
    fileQueue: [item], currentFileIndex: 0
  });
  Object.assign(h.target, {
    EXPIRED_RESCUE_KEYS, EXPIRED_RESCUE_DEFAULTS, defaultExpiredRescueParams, sanitizeExpiredRescueParams, resolveAnalysisRegion,
    analysisPixelBounds, downsampleImageDataForMaxPixels, applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride,
    ROLL_MONOCHROME, withoutLearnedDefaults, getCurrentQueueItem: () => item,
    analyzeExpiredFilm: (image, options) => { measured.push(image); return analyzeExpiredFilm(image, options); },
    // The fog surface is R1-074's (above); here the global measurement.
    runExpiredSpatialAnalysis: () => Promise.resolve(false),
    usesSilverCoreConversion: () => true, studioBackgroundReady: () => true, importFilmTypeActive: () => true,
    importFilmTypeTarget: () => record.typed.get(item) || null, relearnImportSettings: settings => settings,
    // What converts: a flip that changes only the detection descriptions
    // skips the conversion (#229 review R1-015); a type change converts.
    conversionKey: settings => importConversionKey({ router: settings, adjustment: settings, meta: settings.autoFrameMeta || null }),
    automaticRollItemKey: () => '', automaticRollRevision: 0,
    persistCurrentFileSettings: () => { item.settings = Object.fromEntries(RECIPE_KEYS.map(key => [key, structuredClone(h.state[key])])); return true; },
    convertFromCurrentSource: async () => {
      h.conversions.push({ source: h.state.conversionSourceImageData });
      if (holdConversions) await new Promise(resolve => heldConversions.push(resolve));
      return positiveOf(h.state.filmType);
    },
    // "These are positives" converts again through the core reprocess; the
    // flush (an export's barrier) lands its frame.
    scheduleSilverSourceRefresh: () => { h.target.coreReprocessToken++; refreshes++; },
    displayedFrameToken: 0,
    flushScheduledCoreReprocess: async () => {
      await tick();
      if (h.target.displayedFrameToken === h.target.coreReprocessToken) return;
      h.target.displayedFrameToken = h.target.coreReprocessToken;
      h.state.processedImageData = positiveOf(h.state.filmType);
    },
    hasPendingCropDetection: () => false
  });
  vm.runInContext(RETYPE_FUNCTIONS.map(functionSource).join('\n'), c);
  const opening = c.processNegative();
  if (holdConversions) { await until(() => heldConversions.length === 1, 'converting'); heldConversions.shift()(); }
  await opening;
  await settle();
  return { h, c, state: h.state, item, record, measured, heldConversions, refreshes: () => refreshes };
}

const fresh = { bw: await openRescued('bw'), positive: await openRescued('positive') };
for (const [type, opened] of Object.entries(fresh)) {
  assert.ok(opened.state.expiredAnalysis, `opened as ${type}: measured`);
  assert.deepEqual(strengthsOf(opened.state), strengthsOf(defaultExpiredRescueParams(opened.state.expiredAnalysis)), `opened as ${type}: its strengths`);
}
assert.notDeepEqual(fresh.bw.state.expiredAnalysis, fresh.positive.state.expiredAnalysis, 'the fixture: the modes measure differently');

// The flip of the open photo (#231): processNegative measures the new mode.
for (const moved of [false, true]) {
  const leader = await openRescued('positive', { holdConversions: true });
  if (moved) leader.state.expiredBrightness += 9;
  const movedBrightness = leader.state.expiredBrightness;
  const flipping = leader.c.flipImportPhoto(leader.record);
  await until(() => leader.heldConversions.length === 1, 'the flip converts the new mode');
  await tick(); await tick();
  assert.equal(leader.measured.length, 1, 'nothing is measured before the new frame (the retype re-measure waits for processNegative)');
  leader.heldConversions.shift()();
  assert.equal(await flipping, true);
  await settle(); await tick();
  assert.equal(leader.state.filmType, 'bw');
  assert.equal(leader.measured.length, 2, 'one measurement of the new mode');
  assert.deepEqual(leader.state.expiredAnalysis, fresh.bw.state.expiredAnalysis, 'the B&W frame is measured, as when opened as B&W');
  assert.deepEqual(strengthsOf(leader.state), moved
    ? [movedBrightness, fresh.bw.state.expiredContrast] : strengthsOf(fresh.bw.state),
  moved ? 'a moved brightness stays, contrast follows the new measurement' : 'with the strengths it sets');
  assert.equal(leader.item.settings.expiredAnalysis, null, 'the recipe dropped the positive measurement');
}

// "These are positives" on the flipped leader: no processNegative; the
// frame of the new mode is measured once it has settled, Studio busy until.
{
  const leader = await openRescued('positive');
  await leader.c.flipImportPhoto(leader.record);
  await settle();
  assert.deepEqual(leader.state.expiredAnalysis, fresh.bw.state.expiredAnalysis);
  leader.item.settings = null;
  leader.c.applyImportPositives(leader.record);
  assert.equal(leader.state.filmType, 'positive');
  assert.equal(leader.state.expiredAnalysis, null, 'the B&W measurement is dropped');
  assert.equal(leader.refreshes(), 1, 'the new mode converts again');
  const busy = () => leader.h.target.document.body.dataset.studioBusy;
  await until(() => busy() === 'true', 'busy until the new frame is measured');
  assert.equal(leader.state.expiredAnalysis, null);
  await until(() => leader.state.expiredAnalysis, 'the new mode is measured');
  await until(() => busy() === undefined, 'and free again');
  assert.deepEqual(leader.state.expiredAnalysis, fresh.positive.state.expiredAnalysis, 'the positive frame is measured, as when opened as a positive');
  assert.deepEqual(strengthsOf(leader.state), strengthsOf(fresh.positive.state));
  assert.equal(leader.measured.length, 3, 'once per mode');
}

// The re-measure never reads a frame of the old mode: without a frame
// converted after the retype nothing is measured.
{
  const leader = await openRescued('bw');
  leader.item.settings = null;
  leader.h.target.scheduleSilverSourceRefresh = () => {};
  leader.c.applyImportPositives(leader.record);
  const busy = () => leader.h.target.document.body.dataset.studioBusy;
  await until(() => busy() === 'true', 'the retype waits for a frame of the new mode');
  await until(() => busy() === undefined, 'and gives up when none is converted');
  await settle();
  assert.equal(leader.state.expiredAnalysis, null, 'the B&W frame on screen is not measured as a positive');
  assert.equal(leader.measured.length, 1);
}
console.log('expiredMeasurement: a retype of the open photo measures its new mode and fills the strengths that measurement sets (R1-017)');
