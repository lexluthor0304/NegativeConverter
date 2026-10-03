import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  displayPreviewSize, resizeDisplayPreview, resizeDisplayPreviewInBands, displayTargetFor, isDisplayTarget,
  displaySizeServes, noteDisplayFilter, displayFilterOf, displayLevelFactor, displayLevelGeometry, resampleDisplayLevel,
  filterDisplayImage
} from './displayPreview.js';
import { previewTierMaxPixels } from './previewTier.js';
import { viewportRefreshBranch } from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

// #248 parts 2-4 in main.js (extracted with vm): the display target and its
// hysteresis, no resample in the input path, full-resolution results with their
// display preview, and display rebuilds off the input path.
globalThis.ImageData = class {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') Object.assign(this, { width: dataOrWidth, height: width, data: new Uint8ClampedArray(dataOrWidth * width * 4) });
    else Object.assign(this, { data: dataOrWidth, width, height });
  }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);

function image(width, height, seed = 1) {
  const out = new ImageData(width, height);
  const data16 = new Uint16Array(width * height * 4);
  for (let i = 0; i < data16.length; i++) data16[i] = (i * 2654435761 * seed) >>> 16;
  for (let i = 0; i < data16.length; i++) out.data[i] = data16[i] >>> 8;
  out.__image16 = { width, height, data: data16 };
  return out;
}

function fixture({ sourceSize = { width: 1200, height: 800 }, container = { width: 620, height: 420 }, dpr = 1 } = {}) {
  let nextId = 1;
  const timers = new Map();
  const conversionSource = sourceSize.pixels === false ? { ...sourceSize, name: 'source' } : image(sourceSize.width, sourceSize.height, 3);
  const log = [];
  const mainResamples = [];
  const workerResamples = [];
  const conversions = [];
  const state = {
    conversionSourceImageData: conversionSource, displayLevelImageData: conversionSource, conversionPreviewImageData: null,
    processedImageData: null, processedImageDataIsPreview: true, fullResolutionPending: true,
    previewSourceImageData: null, histogramSourceImageData: null, webglSourceImageData: null, displayImageData: null,
    currentStep: 3, cropping: false, beforeAfterActive: false, zoomLevel: 1, sprocketPreviewEnabled: false,
    fullResolutionPromise: null, repairStrokes: [],
    dustRemoval: { enabled: false, processing: false, revision: 1 },
  };
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, window: { devicePixelRatio: dpr }, console,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    webglState: { gl: {}, maxTextureSize: 8192, sourceDirty: false, curveDirty: false },
    getCanvasContainerSize: () => container, previewTier: 'normal', previewTierKept: null,
    reducedDisplayImages: new WeakSet(), previewTierMaxPixels,
    displayPreviewSize, displayTargetFor, isDisplayTarget, displaySizeServes, noteDisplayFilter, displayLevelFactor,
    displayLevelGeometry, resampleDisplayLevel, viewportRefreshBranch, isLargeImage,
    resizeDisplayPreview: (input, size) => {
      const result = resizeDisplayPreview(input, size);
      if (result !== input) mainResamples.push({ input, size });
      return result;
    },
    resizeDisplayPreviewInBands: (input, size, options) => {
      mainResamples.push({ input, size, banded: true });
      return resizeDisplayPreviewInBands(input, size, { ...options, pause: async () => {} });
    },
    convertPreviewFrameInWorker: {
      resample: async (input, size) => {
        workerResamples.push({ input, size });
        return filterDisplayImage(input, size, {});
      }
    },
    buildHistogramSourceImageData: input => ({ sampleOf: input }),
    releaseCorePreviewRetained: () => {}, initWebGLRenderer: () => true, isWebGLActive: () => true,
    // #242: new planes fit the CSS box; a CPU mode settles the new display
    // preview with the exact colour model.
    fitStep3CanvasBox: () => {}, scheduleFullUpdate: () => log.push('settle'),
    schedulePreviewUpdate: () => log.push('redraw'), scheduleGpuPreviewWarmup: () => log.push('gpu-warmup'),
    gpuApplyUsable: () => false, GPU_PREVIEW_MODE: 'auto', hasFrameRepairs: () => false,
    repairedPreviewShown: null, dustDetectionTimer: null, fullResolutionRenderTimer: null,
    scheduleFullResolutionRender: () => log.push('repair-pass'),
    scheduleCoreReprocess: (options) => conversions.push(options),
    displayPreviewResizeTimer: null, displayPreviewRebuild: null,
    displayCounters: { mainResamples: 0, mainFullResamples: 0, prebuilt: 0, workerRebuilds: 0, bandedRebuilds: 0 },
  });
  vm.runInContext([
    ...DISPLAY_SESSION_HELPERS,
    'getDisplayPreviewSize', 'conversionTargetFor', 'updateConversionTarget', 'noteTierImage', 'buildPreviewSourceImageData',
    'histogramSourceFor', 'installDisplayPreview', 'cancelDisplayPreviewRebuild', 'rebuildDisplayPreview',
    'captureSnapshotWithPendingDisplay', 'countMainResample', 'scheduleDisplayPreviewResize', 'refreshDisplayPreviewForViewport', 'installDisplayFor',
    'applyProcessedImageToState', 'hasSeparateConversionPreview', 'ensureConversionPreviewForDisplay', 'previewRequestImage',
  ].map(functionSource).join('\n'), context);
  state.conversionPreviewImageData = context.conversionTargetFor(conversionSource, conversionSource, 'normal');
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
  return { context, state, container, conversionSource, log, mainResamples, workerResamples, conversions, timers, runTimers };
}

// ---- The display target: k = 1 sources still convert at display size ----
{
  // The 8.9 MP NEF after auto-crop: its level is the source itself, yet a
  // tick converts at the display size, not at full resolution.
  const f = fixture({ sourceSize: { width: 3625, height: 2448, pixels: false }, container: { width: 1130, height: 760 }, dpr: 2 });
  assert.equal(displayLevelFactor(3625, 2448), 1);
  const preview = f.state.conversionPreviewImageData;
  assert.ok(isDisplayTarget(preview));
  assert.equal(preview.__displayOf, f.conversionSource, 'the level of a k 1 source is the source');
  assert.ok(preview.width < 3625, 'a display-size target');
  assert.equal(f.context.hasSeparateConversionPreview(), true, 'decided by size, not identity');
  const request = f.context.previewRequestImage(preview);
  assert.equal(request.imageData, f.conversionSource, 'the request sends the level (cached in the worker)');
  assert.equal(request.display.target.width, preview.width);
  assert.equal(f.context.conversionTargetFor(f.conversionSource, f.conversionSource, 'normal'), preview, 'one object per size');
  // A source the display fits whole is its own conversion preview.
  const small = fixture({ sourceSize: { width: 500, height: 300, pixels: false }, container: { width: 1200, height: 800 } });
  assert.equal(small.state.conversionPreviewImageData, small.conversionSource);
  assert.equal(small.context.hasSeparateConversionPreview(), false);
}

// ---- Part 2: nothing is resampled in the input path; the settle hook moves the target ----
{
  const f = fixture({ container: { width: 620, height: 900 } });
  const first = f.state.conversionPreviewImageData;
  f.state.processedImageData = image(first.width, first.height, 5);
  f.state.previewSourceImageData = f.state.processedImageData;
  // A panel toggle: the next tick converts the existing target.
  f.container.width = 820;
  f.context.ensureConversionPreviewForDisplay();
  assert.equal(f.state.conversionPreviewImageData, first, 'a tick keeps the target');
  assert.equal(f.mainResamples.length, 0);
  // The settle hook (ResizeObserver / DPR listener) moves it without pixels.
  f.context.scheduleDisplayPreviewResize();
  f.runTimers();
  assert.notEqual(f.state.conversionPreviewImageData, first);
  assert.equal(f.state.conversionPreviewImageData.width, displayPreviewSize(1200, 800, { viewportWidth: 800, viewportHeight: 880 }).width);
  assert.deepEqual(f.conversions.map(c => ({ ...c })), [{ full: false, displayOnly: true }], 'the preview-only frame converts again');
  assert.equal(f.mainResamples.length, 0, 'no main-thread resample');
  // Hysteresis: a change inside the band (<= 15 % larger, <= ~5 % smaller)
  // rebuilds nothing; the settled preview is never more than ~5 % smaller.
  const settled = f.state.conversionPreviewImageData;
  for (const width of [808, 790, 780]) {
    f.container.width = width;
    f.context.scheduleDisplayPreviewResize();
    f.runTimers();
    assert.equal(f.state.conversionPreviewImageData, settled, `inside the band at ${width}`);
  }
  assert.equal(f.conversions.length, 1);
  f.container.width = 700;
  f.context.scheduleDisplayPreviewResize();
  f.runTimers();
  assert.notEqual(f.state.conversionPreviewImageData, settled, 'outside the band the target moves');
  const target = f.context.getDisplayPreviewSize(f.conversionSource);
  assert.ok(f.state.conversionPreviewImageData.width >= target.width * 0.95);
  // A new source (photo switch, rotate) before the hook fires: nothing happens.
  f.container.width = 400;
  f.context.scheduleDisplayPreviewResize();
  f.state.conversionSourceImageData = image(10, 10);
  const before = f.state.conversionPreviewImageData;
  f.runTimers();
  assert.equal(f.state.conversionPreviewImageData, before);
}

// ---- Part 4: a full-resolution render lands with its display preview ----
{
  const f = fixture();
  const full = image(1200, 800, 7);
  const target = f.context.getDisplayPreviewSize(full);
  const prebuilt = filterDisplayImage(full, target);
  prebuilt.__histogramSample = { sample: true };
  full.__displayPreview = prebuilt;
  f.context.applyProcessedImageToState(full);
  assert.equal(f.state.previewSourceImageData, prebuilt, 'the prebuilt planes are installed');
  assert.equal(f.state.webglSourceImageData, prebuilt);
  assert.equal(f.state.histogramSourceImageData.sample, true, 'with its histogram sample');
  assert.equal(full.__displayPreview, undefined, 'the frame does not keep a second reference');
  assert.equal(f.mainResamples.length + f.workerResamples.length, 0, 'main only uploads');
  assert.equal(displayFilterOf(prebuilt).kind, 'area', 'region updates follow its filter');
  assert.equal(f.timers.size, 0);

  // The viewport changed between the request and the landing: the fallback
  // shows the prebuilt planes and the settle hook rebuilds them off the
  // input path (the preview worker at 16 MP or less).
  const g = fixture();
  const other = image(1200, 800, 9);
  other.__displayPreview = filterDisplayImage(other, { width: 400, height: 267 });
  g.context.applyProcessedImageToState(other);
  assert.equal(g.state.previewSourceImageData.width, 400);
  assert.equal(g.timers.size, 1, 'the settle hook is armed');
  g.runTimers();
  await settle();
  assert.equal(g.workerResamples.length, 1, 'the preview worker resamples it');
  assert.equal(g.mainResamples.length, 0);
  const expected = filterDisplayImage(other, g.context.getDisplayPreviewSize(other));
  assert.deepEqual(g.state.previewSourceImageData.__image16.data, expected.__image16.data, 'at the current size, with the display filter');
  assert.ok(g.log.includes('redraw'));
  assert.ok(!g.log.includes('settle'), 'WebGL draws the new preview as it is');

  // A CPU mode draws #canvas from the display preview (#242): the rebuilt one
  // is drawn and then settled with the exact colour model.
  const h = fixture();
  h.context.isWebGLActive = () => false;
  const cpu = image(1200, 800, 9);
  cpu.__displayPreview = filterDisplayImage(cpu, { width: 400, height: 267 });
  h.context.applyProcessedImageToState(cpu);
  h.runTimers();
  await settle();
  assert.deepEqual(h.log.filter(entry => entry === 'redraw' || entry === 'settle'), ['redraw', 'settle']);
}

// ---- Part 4: above 16 MP a viewport change resamples in row bands on main ----
{
  const f = fixture({ sourceSize: { width: 1200, height: 800 } });
  const full = image(1200, 800, 11);
  f.context.isLargeImage = () => true;
  f.context.applyProcessedImageToState(full);
  f.mainResamples.length = 0;
  const shown = f.state.previewSourceImageData;
  f.container.width = 300;
  f.context.refreshDisplayPreviewForViewport();
  assert.equal(f.state.previewSourceImageData, shown, 'the old preview stays on screen meanwhile');
  await settle(); await settle();
  assert.equal(f.mainResamples.length, 1);
  assert.equal(f.mainResamples[0].banded, true, 'in row bands');
  const target = f.context.getDisplayPreviewSize(full);
  assert.deepEqual(f.state.previewSourceImageData.__image16.data, resizeDisplayPreview(full, target).__image16.data, 'the exact kernel');
}

// ---- Part 4: whole-frame repair results keep the preview until theirs lands ----
{
  const f = fixture();
  const before = image(1200, 800, 13);
  f.context.applyProcessedImageToState(before, { previewOnly: false });
  const shown = f.state.previewSourceImageData;
  const repaired = image(1200, 800, 17);
  f.mainResamples.length = 0;
  f.context.applyProcessedImageToState(repaired, { deferDisplay: true });
  assert.equal(f.state.processedImageData, repaired);
  assert.equal(f.state.previewSourceImageData, shown, 'nothing resampled in this task');
  assert.equal(f.mainResamples.length, 0);
  // A brush patch while it is built starts it over.
  f.state.dustRemoval.revision += 1;
  await settle(); await settle(); await settle();
  assert.equal(f.workerResamples.length, 2, 'rebuilt once more after the patch');
  const expected = filterDisplayImage(repaired, f.context.getDisplayPreviewSize(repaired));
  assert.deepEqual(f.state.previewSourceImageData.__image16.data, expected.__image16.data);
  // A snapshot taken while one is pending gets the frame's own preview.
  const again = image(1200, 800, 19);
  f.context.applyProcessedImageToState(again, { deferDisplay: true });
  // Exercise captureSnapshot's actual pending-job guard; the remaining
  // history fields are covered by the existing dispatcher/history tests.
  f.context.captureSnapshot = label => ({ label, refs: {
    processedImageData: f.state.processedImageData, previewSourceImageData: f.state.previewSourceImageData
  } });
  const captured = f.context.captureSnapshotWithPendingDisplay('drag');
  assert.equal(f.mainResamples.length, 0, 'pointerdown never flushes a whole-frame resample');
  assert.equal(captured.refs.displayPreviewPending, true);
  const other = image(1200, 800, 23);
  f.state.processedImageData = other;
  f.context.cancelDisplayPreviewRebuild();
  await settle(); await settle();
  assert.equal(captured.refs.displayPreviewPending, undefined, 'history finishes after leaving the frame');
  assert.ok(captured.refs.processedImageData === again);
  assert.deepEqual(captured.refs.previewSourceImageData.__image16.data,
    filterDisplayImage(again, f.context.getDisplayPreviewSize(again)).__image16.data, 'same worker filter as the live preview');
  assert.ok(f.state.processedImageData === other, 'late history completion cannot replace the live frame');
}

console.log('displayPreviewWiring: size-decided display targets, no input-path resample, hysteresis, prebuilt full-resolution previews, fallbacks and deferred whole-frame previews');

// A brush patch while a snapshot waits must finish history with the restarted
// build too; pruning that history meanwhile must not revive its display refs.
{
  const f = fixture();
  f.context.applyProcessedImageToState(image(1200, 800));
  f.context.applyProcessedImageToState(image(1200, 800, 7), { deferDisplay: true });
  f.context.captureSnapshot = label => ({ label, refs: { processedImageData: f.state.processedImageData,
    previewSourceImageData: f.state.previewSourceImageData } });
  const kept = f.context.captureSnapshotWithPendingDisplay('kept');
  const discarded = f.context.captureSnapshotWithPendingDisplay('discarded');
  discarded.refs = { cold: true };
  f.state.dustRemoval.revision++;
  await settle(); await settle();
  assert.equal(f.workerResamples.length, 2);
  assert.ok(kept.refs.previewSourceImageData === f.state.previewSourceImageData, 'history follows the restarted build');
  assert.equal(kept.refs.displayPreviewPending, undefined);
  assert.deepEqual(discarded.refs, { cold: true }, 'late build cannot revive pruned history');
}
