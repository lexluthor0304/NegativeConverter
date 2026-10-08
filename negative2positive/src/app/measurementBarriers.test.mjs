// Standalone Node test: the measurements that persist settings wait for
// their inputs (#229 review R1-023, R1-071, R1-073). Runs the real main.js
// functions in the geometry harness - run with:
// node negative2positive/src/app/measurementBarriers.test.mjs
//
// - A retained preview frame (#233) keeps its 16-bit plane in the preview
//   worker until a commit lands. The gray-point click and the expired
//   rescue's analysis (One-click colour correct, the Analyze button, Reset
//   colour, the expired-roll entry) wait for it and measure the 16-bit
//   plane, as 1703835 did, not the 8-bit samples (or their 600k-pixel
//   downsample).
// - A pending crop-area detection (#245): One-click colour correct, the
//   gray-point click, lab match, Copy recipe and Apply film type to roll
//   wait for it, then use the hit's analysis area and white balance.
// - A new load, an edit, leaving the sampling mode or turning the expired-roll
//   entry off again while they wait: nothing is measured or persisted.
// - Nothing pending: each runs within the click, as before.
// - Parity: the same clicks at once and after waiting leave the same state.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness, makeBase, applyCropHandlerSource, settle, functionSource } from './geometryTestHarness.mjs';
import { imageAreaFromWorkingRect, resolveAnalysisRegion, analysisPixelBounds } from './analysisRegion.js';
import { isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput } from './cropColorAnalysis.js';
import { sampleFilmBase as sampleFilmBaseRobust } from './filmBaseDetection.js';
import { downsampleImageDataForMaxDim } from './imageDataOps.js';
import { pickStudioColors } from './studioSettings.js';
import {
  analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS
} from '../pipeline/expiredRescue.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
// A callback main.js passes inline (a Studio option or a click listener), as
// a named function: from `marker` to the first line equal to `close`.
function inlineSource(name, marker, close) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `inline handler exists: ${name}`);
  const body = source.indexOf('{', start + marker.length - 1);
  const end = source.indexOf(close, body);
  assert.ok(end > body, `inline handler closes: ${name}`);
  const head = marker.trim().replace(/^.*?(async )?\(\) => \{$/, (_, async) => `${async || ''}() => {`);
  return `var ${name} = ${head}${source.slice(body + 1, end)}\n};`;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gainsOf = state => [state.wbR, state.wbG, state.wbB].map(value => Number(value.toFixed(5)));
const whiteBalanceOf = state => ({ wbR: state.wbR, wbG: state.wbG, wbB: state.wbB, wbAutoConfidence: state.wbAutoConfidence ?? null });

// Apply film type to roll: the click listener, or the function it calls
// (#255 names it, to wait for a two-stage import's full decode first).
const NAMED_ROLL_HANDLER = /^    async function applyFilmTypeToRoll\(/m.test(source);
// The real functions on the measurement path, beside the harness's.
const MEASURE_FUNCTIONS = [
  // A retained frame's 16-bit plane (#233).
  'releaseCorePreviewRetained', 'requestCorePreviewCommit', 'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters',
  'settleCorePreviewPlane',
  // The barrier and the measurements behind it.
  'measurementInputsPending', 'settleMeasurementInputs', 'handleSamplingClick', 'sampleGrayPoint', 'sampleFilmBase',
  'clampBetween', 'setExpiredEnabled', 'setExpiredSession', 'analyzeExpiredAgain', 'runExpiredAnalysis', 'expiredAnalysisSample',
  'applyExpiredAnalysisDefaults', 'resetExpiredStrengthsInState', 'hasCurrentExpiredAnalysis', 'expiredSourceKey',
  'baseSizeSource', 'sanitizeNumeric', 'cropImageData', 'sanitizeCropRegionForImage', 'resetStudioColors',
  'refreshExpiredAfterColorReset', 'runLabMatch', 'renderCurrentForMatching', 'currentRecipeCode', 'copyRecipe',
  ...(NAMED_ROLL_HANDLER ? ['applyFilmTypeToRoll'] : [])
];
const INLINE_HANDLERS = [
  inlineSource('onColorCorrect', '        onColorCorrect: () => {', '\n        },'),
  inlineSource('onReset', '        onReset: () => {', '\n        },'),
  inlineSource('expiredAnalyzeClick', "    document.getElementById('expiredAnalyzeBtn')?.addEventListener('click', () => {", '\n    });'),
  ...(NAMED_ROLL_HANDLER ? [] : [inlineSource('applyFilmTypeToRoll', "    document.getElementById('applyFilmTypeToRollBtn').addEventListener('click', async () => {", '\n    });')])
];

// The harness with the measurement path. `analysed` records each expired
// analysis (the image, its options and the diagnostics it was taken with),
// `sampled` each gray-point sample, `rendered` lab match's rendering and
// `commits` the plane commits asked of the preview worker.
function measureContext(base = makeBase(90, 64, 7)) {
  const h = createHarness(base);
  const c = h.context;
  const commits = [];
  const sampled = [];
  const analysed = [];
  const rendered = [];
  const persisted = [];
  const copied = [];
  const elements = { recipeCode: { value: '' }, recipeQrCanvas: { hidden: true } };
  class TestImageData {
    constructor(data, width, height) {
      if (typeof data === 'number') { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
      this.data = data; this.width = width; this.height = height;
    }
  }
  Object.assign(h.target, {
    ImageData: TestImageData,
    // #233: the preview worker keeps a retained frame's plane until a commit.
    corePreviewRetained: null, corePreviewCommit: null, corePreviewCommitWanted: false, corePreviewCommitTimer: null,
    corePreviewSettleWaiters: [], _coreReprocessPreviewInFlight: false, _coreReprocessPending: null,
    convertPreviewFrameInWorker: { commit: frame => new Promise(resolve => commits.push({ frame, resolve })) },
    buildPreviewSourceImageData: image => image, histogramSourceFor: image => image, runCoreReprocess: async () => {},
    sampleFilmBaseRobust: (image, ...rest) => {
      sampled.push({ image, plane16: Boolean(image.__image16) });
      return sampleFilmBaseRobust(image, ...rest);
    },
    analyzeExpiredFilm: (image, options) => {
      analysed.push({ image, options, plane16: Boolean(image.__image16), meta: structuredClone(h.state.autoFrame.lastDiagnostics) });
      return analyzeExpiredFilm(image, options);
    },
    defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS, resolveAnalysisRegion, analysisPixelBounds,
    downsampleImageDataForMaxDim, pickStudioColors,
    // OpenCV's fog surface is the second phase, measured on the same frame.
    runExpiredSpatialAnalysis: () => Promise.resolve(false),
    // Reset colour's defaults: the session decides whether the rescue stays on.
    createDefaultSettings: () => ({ ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: Boolean(h.state.expiredSession), coreExposure: 0 }),
    // Lab match around our rendering: the reference, alignment and fit are stand-ins.
    labMatchRunning: false, labMatchReferenceFile: { name: 'lab.jpg' },
    decodeReferenceImage: async () => new TestImageData(8, 8),
    applyAdjustmentsToBuffer: (image, settings) => {
      rendered.push({ image, wb: whiteBalanceOf(settings), meta: structuredClone(h.state.autoFrame.lastDiagnostics) });
    },
    alignmentSide: () => 8, collectPairs: () => ({ count: 0 }), resizeImageDataNearest: image => image,
    fitLook: () => ({ look: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, method: 'histogram', deltaBefore: 2, deltaAfter: 1 }),
    sanitizeLookForSettings: look => look,
    // Copy recipe around the settings it encodes.
    extractCurrentSettings: () => ({ ...whiteBalanceOf(h.state), autoFrameMeta: structuredClone(h.state.autoFrame.lastDiagnostics) }),
    encodeRecipe: settings => `NC1.${JSON.stringify({ wb: [settings.wbR, settings.wbG, settings.wbB], method: settings.autoFrameMeta?.method })}`,
    recipeTags: () => ({}), navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    // Apply film type to roll persists and restores the open photo.
    persistCurrentFileSettings: () => {
      persisted.push({ meta: structuredClone(h.state.autoFrame.lastDiagnostics), wb: whiteBalanceOf(h.state), pending: c.hasPendingCropDetection() });
    },
    applyFilmTypeOverride: (settings, choice) => ({ ...settings, ...choice }),
    // The photo is its full decode (#255).
    currentPhotoExact: () => true
  });
  h.target.document.getElementById = id => elements[id] || null;
  Object.assign(h.state, {
    ...EXPIRED_RESCUE_DEFAULTS, samplingMode: null, expiredSession: false, expiredAnalysis: null,
    wbAutoConfidence: null, wbUserOverride: false, grayPointSampled: false, wbSemanticApplied: false,
    coreBorderBuffer: 10, semanticMap: null, loadedFile: { name: 'frame.tif' }, filmType: 'color', positiveMode: 'correct',
    look: null, processedImageDataIsPreview: true, currentStep: 3, rollAnalysis: {}
  });
  vm.runInContext([...MEASURE_FUNCTIONS.map(functionSource), ...INLINE_HANDLERS].join('\n'), c);
  const body = h.target.document.body;
  return { h, c, state: h.state, target: h.target, body, commits, sampled, analysed, rendered, persisted, copied, elements };
}

// A click at (x, y) on a 64 x 64 canvas showing the frame.
const click = (x, y) => ({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }) }, clientX: x, clientY: y });

// The finding's gray-point patch: the frame's 8-bit samples and its 16-bit
// plane round to neighbouring levels, so the two give different gains. (The
// app then rounds the gains to the WB sliders' step, syncSliderFromState,
// so a 16-bit and an 8-bit sample land on different stored gains only when
// they straddle a step; the expired analysis differs whenever they differ.)
function patchFrame(width = 64, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set([121, 111, 101, 255], i);
    plane.set([120 * 257, 110 * 257, 100 * 257, 65535], i);
  }
  return { frame: new ImageData(data, width, height), plane };
}

// An aged positive of 700k pixels (above the 600k-pixel 8-bit downsample),
// whose 16-bit plane carries what its 8-bit samples round away.
function agedFrame(width = 1000, height = 700) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(width * height * 4);
  const fog = [0.30, 0.36, 0.42], top = [0.86, 0.76, 0.90];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const v = ((x * 7 + y * 13) % 997) / 996;
    for (let k = 0; k < 3; k++) {
      const value = fog[k] + (top[k] - fog[k]) * Math.pow(v, 0.8 + 0.1 * k) + 0.04 * Math.sin((x + 3 * k) / 37) * Math.cos(y / 29);
      plane[i + k] = Math.round(Math.max(0, Math.min(1, value)) * 65535);
      data[i + k] = plane[i + k] >>> 8;
    }
    plane[i + 3] = 65535; data[i + 3] = 255;
  }
  return { frame: new ImageData(data, width, height), plane };
}

// A frame on screen whose plane is still in the preview worker.
function showRetained(t, frame) {
  frame.__retained16 = true;
  t.state.processedImageData = frame;
  t.target.corePreviewRetained = { processed: frame, derived: frame };
}

// ---- R1-023: the gray-point click waits for the committed 16-bit plane ----
{
  const t = measureContext();
  const { frame, plane } = patchFrame();
  showRetained(t, frame);
  t.state.samplingMode = 'whiteBalance';
  t.c.handleSamplingClick(click(32, 32));
  assert.deepEqual(gainsOf(t.state), [1, 1, 1], 'nothing is sampled while the plane is in the worker');
  assert.equal(t.commits.length, 1, 'the click asks for the plane');
  assert.equal(t.commits[0].frame, frame);
  assert.equal(t.body.dataset.studioBusy, 'true', 'Studio is busy while the click waits');
  assert.equal(t.target.undoStack.length, 0, 'and nothing is in history yet');
  t.commits[0].resolve(plane);
  await settle();
  assert.deepEqual(t.sampled.map(entry => entry.plane16), [true], 'the click samples the frame with its 16-bit plane');
  assert.equal(t.sampled[0].image, frame, 'the frame clicked on');
  assert.deepEqual(gainsOf(t.state), [0.91667, 1, 1.1], 'the 16-bit result, not [0.91736, 1, 1.09901]');
  assert.equal(t.state.grayPointSampled, true);
  assert.equal(t.state.samplingMode, null);
  assert.deepEqual(t.target.undoStack.map(entry => entry.label), ['whiteBalance']);
  assert.equal(t.body.dataset.studioBusy, undefined, 'the click releases the lock it took');
}

{
  // Nothing pending: the click samples within the event, as before; the
  // 8-bit samples alone give the other gains.
  for (const [attached, expected] of [[true, [0.91667, 1, 1.1]], [false, [0.91736, 1, 1.09901]]]) {
    const t = measureContext();
    const { frame, plane } = patchFrame();
    if (attached) frame.__image16 = { width: frame.width, height: frame.height, data: plane };
    t.state.processedImageData = frame;
    t.state.samplingMode = 'whiteBalance';
    t.c.handleSamplingClick(click(32, 32));
    assert.deepEqual(gainsOf(t.state), expected, `sampled within the click (${attached ? '16-bit' : '8-bit'} frame)`);
    assert.equal(t.commits.length, 0);
    assert.equal(t.body.dataset.studioBusy, undefined, 'no busy state when nothing is pending');
  }
}

{
  // Leaving the sampling mode (Escape), an edit, or a new load while the
  // click waits: nothing is sampled.
  for (const change of ['escape', 'edit', 'load']) {
    const t = measureContext();
    const { frame, plane } = patchFrame();
    showRetained(t, frame);
    t.state.samplingMode = 'whiteBalance';
    t.c.handleSamplingClick(click(32, 32));
    if (change === 'escape') t.state.samplingMode = null;
    if (change === 'edit') t.target.manualEditRevision++;
    if (change === 'load') t.target.loadGeneration++;
    t.commits[0].resolve(plane);
    await settle();
    assert.equal(t.sampled.length, 0, `${change}: nothing sampled`);
    assert.deepEqual(gainsOf(t.state), [1, 1, 1], `${change}: no gains set`);
    assert.equal(t.target.undoStack.length, 0, `${change}: nothing in history`);
    // A new load owns the lock from here (as with prepareOriginalForTool).
    assert.equal(t.body.dataset.studioBusy, change === 'load' ? 'true' : undefined);
  }
}

// ---- R1-023: the expired rescue's analysis waits for the plane too ----
{
  // One-click colour correct right after a slider release: the analysis is
  // the 16-bit plane's, the same as after the commit, not the 8-bit samples'.
  const run = async ({ retained }) => {
    const t = measureContext();
    const { frame, plane } = agedFrame();
    if (retained) showRetained(t, frame);
    else {
      frame.__image16 = { width: frame.width, height: frame.height, data: plane };
      t.state.processedImageData = frame;
    }
    t.c.onColorCorrect();
    if (retained) {
      assert.equal(t.state.expiredEnabled, false, 'colour correct waits for the plane');
      assert.equal(t.analysed.length, 0);
      assert.equal(t.body.dataset.studioBusy, 'true');
      assert.equal(t.commits.length, 1);
      t.commits[0].resolve(plane);
      await settle();
    }
    assert.equal(t.analysed.length, 1);
    assert.equal(t.analysed[0].image, frame, 'measured on the frame itself');
    assert.equal(t.analysed[0].plane16, true, '...with its 16-bit plane, not the 600k-pixel 8-bit downsample');
    assert.equal(t.state.expiredEnabled, true);
    assert.deepEqual(t.target.undoStack.map(entry => entry.label), ['colorCorrect']);
    return { analysis: t.state.expiredAnalysis, strengths: Object.fromEntries(EXPIRED_RESCUE_KEYS.map(key => [key, t.state[key]])) };
  };
  const atOnce = await run({ retained: true });
  const waited = await run({ retained: false });
  assert.deepEqual(atOnce, waited, 'colour correct right after a release measures what it measures after the commit');
  // The 8-bit samples (the downsample the frame falls back to) measure
  // something else: what the stored analysis, and the export, used to get.
  const { frame } = agedFrame();
  const t = measureContext();
  t.state.processedImageData = frame;
  t.c.onColorCorrect();
  assert.equal(t.analysed[0].plane16, false);
  assert.notEqual(t.analysed[0].image, frame, 'without a plane the 8-bit downsample is measured');
  assert.notDeepEqual(t.state.expiredAnalysis, atOnce.analysis, 'and gives another analysis');
}

{
  // The Analyze button and Reset colour (the rescue left on without a
  // current measurement) wait the same way.
  for (const action of ['analyze', 'reset']) {
    const t = measureContext();
    const { frame, plane } = agedFrame(800, 800);
    showRetained(t, frame);
    Object.assign(t.state, { expiredEnabled: true, expiredSession: action === 'reset' });
    if (action === 'analyze') t.c.expiredAnalyzeClick();
    else t.c.onReset();
    assert.equal(t.analysed.length, 0, `${action}: waits for the plane`);
    assert.equal(t.commits.length, 1);
    t.commits[0].resolve(plane);
    await settle();
    assert.deepEqual(t.analysed.map(entry => entry.plane16), [true], `${action}: measures the 16-bit plane`);
    assert.deepEqual(t.target.undoStack.map(entry => entry.label), [action === 'analyze' ? 'expiredAnalyze' : 'studioReset']);
  }
  // Reset colour that measures nothing does not wait.
  const t = measureContext();
  const { frame } = agedFrame(64, 64);
  showRetained(t, frame);
  t.c.onReset();
  assert.deepEqual(t.target.undoStack.map(entry => entry.label), ['studioReset'], 'a Reset without a measurement runs at once');
  assert.equal(t.body.dataset.studioBusy, undefined);
}

{
  // The expired-roll entry (the menu) turns the rescue on: it measures the
  // 16-bit plane too; toggled off again while it waits (the menu is outside
  // the busy panel), the rescue stays off.
  for (const toggledOff of [false, true]) {
    const t = measureContext();
    const { frame, plane } = agedFrame(64, 64);
    showRetained(t, frame);
    t.target.expiredTabPending = false;
    t.c.setExpiredSession(true);
    assert.equal(t.state.expiredSession, true);
    assert.equal(t.state.expiredEnabled, false, 'the entry\'s rescue waits for the plane');
    if (toggledOff) t.c.setExpiredSession(false);
    t.commits[0].resolve(plane);
    await settle();
    assert.equal(t.state.expiredEnabled, !toggledOff, toggledOff ? 'turned off meanwhile: the rescue stays off' : 'then turns the rescue on');
    assert.deepEqual(t.analysed.map(entry => entry.plane16), toggledOff ? [] : [true]);
    assert.deepEqual(t.target.undoStack.map(entry => entry.label), toggledOff ? [] : ['expiredEnabled']);
  }
}

// ---- R1-071, R1-073: a pending crop-area detection ----
// Apply Crop on a frame the detector hits: Apply converts with the miss
// outcome and releases the UI; the hit then converts again and its auto
// white balance runs (the stand-in below, as in cropDetectionApply.test).
const HIT_WB = { wbR: 1.08, wbG: 1, wbB: 0.93, wbAutoConfidence: 'high' };
const hitPoints = input => {
  const { crop } = input;
  return [{ x: crop.left + 3, y: crop.top + 2 }, { x: crop.left + crop.width - 3, y: crop.top + 2 },
    { x: crop.left + crop.width - 3, y: crop.top + crop.height - 2 }, { x: crop.left + 3, y: crop.top + crop.height - 2 }];
};

// The positive a conversion makes: its colour follows the analysis area, so
// the provisional (miss) positive and the hit's differ. 16-bit, as a
// processNegative frame is.
function positiveOf(frame, hit) {
  const scale = hit ? [0.92, 1, 1.05] : [1.06, 1, 0.9];
  const data = new Uint8ClampedArray(frame.data.length);
  const plane = new Uint16Array(frame.data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      plane[i + k] = Math.min(65535, Math.round(frame.__image16.data[i + k] * scale[k]));
      data[i + k] = plane[i + k] >>> 8;
    }
    plane[i + 3] = 65535; data[i + 3] = 255;
  }
  const positive = new ImageData(data, frame.width, frame.height);
  positive.__image16 = { width: frame.width, height: frame.height, data: plane };
  positive.outcome = hit ? 'hit' : 'miss';
  return positive;
}

function detectionContext() {
  const t = measureContext();
  const { h, c } = t;
  let release = null;
  const detection = { resolve: null };
  Object.assign(h.target, {
    applyCropBtn: { disabled: false }, cancelCropBtn: { disabled: false },
    getLoadingOverlay: () => ({ show: async () => {}, hide() {} }),
    studioWorkspace: { sync() {}, flush() {}, text: key => key },
    imageAreaFromWorkingRect, isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput,
    exitCropMode: () => { h.state.cropping = false; h.state.cropDraft = null; },
    runOpenCvTask: async (type, task) => {
      if (type === 'estimate-alignment') return { alignment: null, warped: null };
      assert.equal(type, 'detect-crop-area');
      const input = await task.build();
      await new Promise(resolve => { detection.resolve = resolve; });
      return hitPoints(input);
    },
    // A conversion that reads the diagnostics, with processNegative's
    // in-flight rule; its frame carries its 16-bit plane.
    processNegative: (options = {}) => {
      if (h.target.processNegativeInFlight) return h.target.processNegativeInFlight;
      c.noteConversionStarted();
      const promise = (async () => {
        await c.whenGeometrySettled();
        await new Promise(resolve => { release = resolve; });
        const hit = !h.state.autoFrame.lastDiagnostics?.analysisNeedsReview;
        h.state.processedImageData = positiveOf(h.state.croppedImageData || h.state.originalImageData, hit);
        h.state.currentStep = 3;
        const s = h.state;
        if (options.automatic !== false && !s.expiredEnabled && !s.grayPointSampled && !s.wbUserOverride
          && !s.wbSemanticApplied && !s.autoFrame.lastDiagnostics?.analysisNeedsReview) Object.assign(s, HIT_WB);
      })();
      h.target.processNegativeInFlight = promise;
      return promise.finally(() => { if (h.target.processNegativeInFlight === promise) h.target.processNegativeInFlight = null; });
    }
  });
  vm.runInContext(applyCropHandlerSource(), c);
  h.state.currentStep = 3;
  h.state.autoFrame.lastDiagnostics = { analysisArea: null, imageArea: null, method: 'import' };
  const finishConversion = async () => {
    for (let i = 0; i < 50 && !release; i++) await tick();
    assert.ok(release, 'a conversion is running');
    const done = release; release = null;
    done();
    await settle();
  };
  // Apply, and the provisional (miss) conversion: the UI is free again.
  const apply = async () => {
    const preview = c.renderFrameSample(700_000);
    h.state.cropping = true;
    h.state.cropDraft = { sourceImageData: h.state.originalImageData, rotatedSize: { width: preview.width, height: preview.height }, rect: { left: 10.2, top: 8.6, width: 60.3, height: 40.1 }, rotationBase: 0, straightenAngle: 0 };
    const applying = c.applyCropHandler();
    await finishConversion();
    await applying;
    assert.ok(c.hasPendingCropDetection(), 'the detection is still pending');
    assert.equal(h.state.autoFrame.lastDiagnostics.analysisNeedsReview, true, 'the miss outcome is installed');
  };
  // The worker answers with a hit, which converts again.
  const hitLands = async () => {
    for (let i = 0; i < 50 && !detection.resolve; i++) await tick();
    assert.ok(detection.resolve, 'the detection was requested');
    const done = detection.resolve; detection.resolve = null;
    done();
    await settle();
    await finishConversion();
    await c.settlePendingCropDetection();
    await settle();
  };
  return { ...t, apply, hitLands };
}

const hitView = t => ({
  wb: whiteBalanceOf(t.state), meta: structuredClone(t.state.autoFrame.lastDiagnostics), expiredEnabled: t.state.expiredEnabled,
  expiredAnalysis: t.state.expiredAnalysis, grayPointSampled: Boolean(t.state.grayPointSampled), look: t.state.look,
  history: t.target.undoStack.map(entry => entry.label)
});

{
  // One-click colour correct during the detection: measured after the hit,
  // with its image area; the hit's auto white balance ran first, and the
  // rescue then drops it, as when pressed after the hit.
  const run = async atOnce => {
    const t = detectionContext();
    await t.apply();
    if (!atOnce) await t.hitLands();
    t.c.onColorCorrect();
    if (atOnce) {
      assert.equal(t.state.expiredEnabled, false, 'colour correct waits for the detection');
      assert.equal(t.body.dataset.studioBusy, 'true');
      await t.hitLands();
    }
    assert.equal(t.analysed.length, 1);
    const measured = t.analysed[0];
    assert.equal(measured.image.outcome, 'hit', 'the expired analysis measures the hit\'s positive');
    assert.equal(measured.meta.method, 'manual-image-window', '...with the hit\'s diagnostics');
    assert.equal(measured.meta.analysisNeedsReview, false);
    assert.equal(measured.plane16, true);
    const roi = resolveAnalysisRegion({ ...t.state, autoFrameMeta: measured.meta }, t.c.baseSizeSource());
    assert.deepEqual(measured.options.region, analysisPixelBounds(measured.image.width, measured.image.height, roi, 0.02), '...inside the hit\'s image area');
    assert.deepEqual(whiteBalanceOf(t.state), { wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null }, 'the hit\'s auto white balance is dropped by the rescue');
    return hitView(t);
  };
  assert.deepEqual(await run(true), await run(false), 'colour correct during the detection leaves what it leaves after the hit');
}

{
  // The gray-point click during the detection samples the hit's positive.
  const run = async atOnce => {
    const t = detectionContext();
    await t.apply();
    if (!atOnce) await t.hitLands();
    t.state.samplingMode = 'whiteBalance';
    t.c.handleSamplingClick(click(20, 30));
    if (atOnce) {
      assert.equal(t.sampled.length, 0, 'the click waits for the detection');
      await t.hitLands();
    }
    assert.equal(t.sampled.length, 1);
    assert.equal(t.sampled[0].image.outcome, 'hit', 'the click samples the hit\'s positive');
    assert.equal(t.state.grayPointSampled, true);
    return hitView(t);
  };
  assert.deepEqual(await run(true), await run(false), 'a gray-point click during the detection gives what it gives after the hit');
}

{
  // Lab match fits the look to our rendering after the hit, its auto white
  // balance included.
  const t = detectionContext();
  await t.apply();
  const matching = t.c.runLabMatch();
  await settle();
  assert.equal(t.rendered.length, 0, 'lab match waits for the detection');
  await t.hitLands();
  await matching;
  assert.equal(t.rendered.length, 1);
  assert.equal(t.rendered[0].image.outcome, 'hit', 'the look is fitted to the hit\'s positive');
  assert.deepEqual(t.rendered[0].wb, HIT_WB, '...with its white balance');
  assert.equal(t.rendered[0].meta.method, 'manual-image-window');
  assert.ok(t.state.look, 'the look is fitted');
  assert.equal(t.target.labMatchRunning, false);
}

{
  // Copy recipe during the detection copies the hit's white balance (R1-073).
  const t = detectionContext();
  await t.apply();
  const copying = t.c.copyRecipe();
  await settle();
  assert.equal(t.copied.length, 0, 'Copy recipe waits for the detection');
  await t.hitLands();
  await copying;
  assert.equal(t.copied.length, 1);
  assert.deepEqual(JSON.parse(t.copied[0].slice(4)), { wb: [HIT_WB.wbR, HIT_WB.wbG, HIT_WB.wbB], method: 'manual-image-window' });
  assert.equal(t.elements.recipeCode.value, t.copied[0]);
}

{
  // Apply film type to roll persists and restores the open photo: after the
  // hit, so the restore cannot end the detection unapplied (R1-073).
  const t = detectionContext();
  await t.apply();
  const item = { file: t.state.loadedFile, settings: { filmType: 'color' } };
  const restored = [];
  Object.assign(t.target, {
    getCurrentQueueItem: () => item, restoreSettings: settings => { restored.push(settings); }
  });
  t.state.fileQueue = [item, { file: { name: 'other.tif' }, settings: null }];
  const applying = t.c.applyFilmTypeToRoll();
  await settle();
  assert.equal(t.persisted.length, 0, 'the roll action waits for the detection');
  await t.hitLands();
  await applying;
  assert.equal(t.persisted.length, 1);
  assert.equal(t.persisted[0].pending, false);
  assert.equal(t.persisted[0].meta.method, 'manual-image-window', 'the photo is persisted with the hit');
  assert.deepEqual(t.persisted[0].wb, HIT_WB);
  assert.equal(t.target.cropDetectionStats.stale, 0, 'the hit was not dropped');
  assert.equal(restored.length, 1);
}

{
  // A new load while they wait: nothing is measured or persisted, for
  // either photo.
  for (const action of ['colorCorrect', 'grayPoint', 'labMatch', 'copyRecipe']) {
    const t = detectionContext();
    await t.apply();
    const before = hitView(t);
    let done = null;
    if (action === 'colorCorrect') t.c.onColorCorrect();
    if (action === 'grayPoint') { t.state.samplingMode = 'whiteBalance'; t.c.handleSamplingClick(click(20, 30)); }
    if (action === 'labMatch') done = t.c.runLabMatch();
    if (action === 'copyRecipe') done = t.c.copyRecipe();
    await settle();
    // A dropped file loads: a new load generation, and the detection ends.
    t.target.loadGeneration++;
    t.state.loadedFile = { name: 'dropped.tif' };
    t.c.cancelCropDetection();
    await settle();
    await done;
    assert.equal(t.analysed.length + t.sampled.length + t.rendered.length + t.copied.length, 0, `${action}: nothing measured or copied`);
    assert.deepEqual(hitView(t), before, `${action}: nothing persisted`);
    assert.equal(t.target.labMatchRunning, false);
  }
}

console.log('measurementBarriers tests passed');
