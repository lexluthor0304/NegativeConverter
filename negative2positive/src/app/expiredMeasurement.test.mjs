// Standalone Node test: what the expired rescue's stored measurement is
// taken on (#229 review R1-074). Runs the real main.js functions, with the
// real opencv-js build for the fog surface - run with:
// node negative2positive/src/app/expiredMeasurement.test.mjs
//
// - R1-074: a fog-surface request joins the run in flight only when it
//   measures the same inputs. One whose inputs differ (the strengths One-click
//   colour correct resets, a new semantic map, analysis area or plane)
//   measures again and supersedes it, so the stored measurement is the one
//   1703835 took: every request measured with the settings of its call.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { functionSource, settle } from './geometryTestHarness.mjs';
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
// left edge, with per-layer gamma and a warm lean.
function agedPositive({ width = 240, height = 160, seed = 0 } = {}) {
  const data8 = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const scene = ((x * 7 + y * 3 + seed) % 40) / 39;
    const fog = 0.10 + 0.14 * (1 - x / (width - 1));
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, (fog + (0.86 - fog) * Math.pow(scene, [0.9, 1, 1.1][c])) * [1, 0.94, 0.86][c]);
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
  'isCurrentLoad', 'expiredSourceKey', 'baseSizeSource', 'sanitizeNumeric', 'clampBetween', 'expiredAnalysisSample',
  'measureExpiredAnalysisWithSpatial', 'expiredSpatialInputs', 'runExpiredSpatialAnalysis', 'measureExpiredSpatialAnalysis',
  'applyExpiredAnalysisDefaults', 'resetExpiredStrengthsInState', 'runExpiredAnalysis'
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
  'isCurrentLoad', 'expiredSourceKey', 'sanitizeNumeric', 'clampBetween', 'expiredAnalysisSample', 'applyExpiredAnalysisDefaults',
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
    state, loadGeneration: 1, expiredAnalysisKey: null, expiredOpenCvState: 'idle', expiredSpatialRun: null,
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
console.log('expiredMeasurement: a fog-surface request with other inputs measures again; the stored measurement is 1703835\'s (R1-074)');
