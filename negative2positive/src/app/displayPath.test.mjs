// #242 in main.js itself: the real display and export functions, extracted
// with vm as restartRender.test.mjs does, against counting stand-ins.
// node negative2positive/src/app/displayPath.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const noop = () => {};
const settle = () => new Promise(setImmediate);

class TestImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    Object.assign(this, { data, width, height });
  }
}
function image(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  return new TestImageData(data, width, height);
}

// ---- B2: Steps 1-2 export the negative that was painted, not a readback ----
{
  const negative = image(6, 4, 90);
  negative.__image16 = { width: 6, height: 4, data: new Uint16Array(6 * 4 * 4) };
  const state = { currentStep: 2, processedImageData: null, croppedImageData: null, originalImageData: negative,
    sprocketPreviewEnabled: false, exportSprocketHolesEnabled: false };
  const reads = [];
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, ImageData: TestImageData,
    ensureFullResolutionReadyForExport: async () => {}, ensureRepairsReadyForExport: async () => {},
    applyAdjustmentsWithSettings: () => assert.fail('Steps 1-2 run no adjustment'),
    noteGeometryPixelRead: reader => reads.push(reader),
    canvas: { get width() { return assert.fail('#canvas is never read back'); } },
    ctx: { getImageData: () => assert.fail('#canvas is never read back') },
  });
  vm.runInContext(functionSource('getCurrentExportImageData'), context);
  for (const bitDepth of [8, 16]) {
    const exported = await context.getCurrentExportImageData({ bitDepth });
    assert.notEqual(exported, negative, 'a wrapper, so nothing set on it reaches the editor plane');
    assert.equal(exported.data, negative.data, 'the painted pixels, shared rather than copied');
    assert.deepEqual([exported.width, exported.height], [6, 4]);
    assert.equal(exported.__image16, undefined, 'the 8-bit pixels #canvas held, as before: no 16-bit plane');
  }
  const cropped = image(3, 2, 40);
  state.croppedImageData = cropped;
  assert.equal((await context.getCurrentExportImageData()).data, cropped.data, 'the crop when there is one');
  state.sprocketPreviewEnabled = true;
  assert.equal(await context.getCurrentExportImageData(), cropped, 'the border export frames the plane itself, as before');
  state.croppedImageData = null; state.originalImageData = null; state.sprocketPreviewEnabled = false;
  assert.equal(await context.getCurrentExportImageData(), null);
  assert.deepEqual(reads, ['currentExportImageData', 'currentExportImageData', 'currentExportImageData', 'currentExportImageData']);
}

// ---- B1: a failed conversion shows the framed negative ----
{
  const state = { processedImageData: null, croppedImageData: null, originalImageData: image(4, 4) };
  const painted = [];
  const context = vm.createContext({ state, displayNegative: imageData => painted.push(imageData) });
  vm.runInContext(functionSource('showNegativeAfterFailedConversion'), context);
  context.showNegativeAfterFailedConversion();
  assert.deepEqual(painted, [state.originalImageData]);
  state.croppedImageData = image(2, 2);
  context.showNegativeAfterFailedConversion();
  assert.equal(painted.at(-1), state.croppedImageData, 'the framed negative');
  state.processedImageData = image(2, 2);
  context.showNegativeAfterFailedConversion();
  assert.equal(painted.length, 2, 'a positive already on screen stays');
}

for (const failure of ['null', 'throw']) {
  const negative = image(4, 4);
  const state = { croppedImageData: null, originalImageData: negative, processedImageData: null,
    conversionSourceImageData: null, conversionPreviewImageData: null, beforeAfterActive: false };
  const painted = [];
  const alerts = [];
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, console: { error: noop }, loadGeneration: 1, coreReprocessGeneration: 0, processNegativeInFlight: null,
    whenGeometrySettled: async () => true, isCurrentLoad: generation => generation === 1,
    createPerfTrace: () => ({ mark: noop, end: noop }), getImageDataPixelCount: () => 16,
    quietLoadingOverlay: { show: async () => {}, updateProgress: noop, hide: noop },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress: noop, hide: noop }),
    i18n: { en: {} }, currentLang: 'en',
    applyLensCorrectionWithSettings: async imageData => imageData, invalidateSilverCoreCache: noop,
    gpuPreviewScheduler: { cancel: noop }, releaseBeforeAfterCanvas: noop, refreshCanvasContainerSize: noop,
    noteConversionStarted: noop, scheduleCropViewProxy: noop,
    // #248: the display level of the new source (the source itself at this size).
    displayLevelFactor: () => 1, displayLevelGeometry: () => ({ k: 1 }), buildDisplayLevelInBands: async imageData => imageData,
    conversionTargetFor: source => source,
    buildPreviewSourceImageData: imageData => imageData, usesSilverCoreConversion: () => true,
    hasSeparateConversionPreview: () => false,
    extractCurrentSettings: () => ({ ...state }),
    convertFromCurrentSource: async () => { if (failure === 'throw') throw new Error('decoder'); return null; },
    applyProcessedImageToState: () => assert.fail('nothing to apply'),
    displayNegative: imageData => painted.push(imageData),
    appAlert: message => { alerts.push(message); }, getLocalizedText: (key, fallback) => fallback,
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'whiteBalanceMeasurementSettings', 'provisionalWhiteBalanceMeasurement',
    'provisionalUnits', 'liveGeometry', 'showNegativeAfterFailedConversion', 'processNegative'].map(functionSource).join('\n'), context);
  await context.processNegative({ quiet: true });
  await settle();
  assert.deepEqual(painted, [negative], `${failure}: the framed negative is painted once`);
  assert.equal(alerts.length, failure === 'throw' ? 1 : 0);
}

// ---- A: the settled CPU display, at display size, off this thread ----
// The real export worker behind the real bridge, in-process: every message
// crosses a structured clone both ways.
let activeWorker = null;
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers = []) {
    const cloned = structuredClone(message, { transfer: transfers });
    const target = activeWorker;
    queueMicrotask(() => target && target.onmessage && target.onmessage({ data: cloned }));
  }
};
globalThis.ImageData = TestImageData;
await import('../workers/exportWorker.js');
class InProcessWorker {
  constructor() { this.onmessage = null; activeWorker = this; }
  postMessage(message, transfers = []) {
    const received = structuredClone(message, { transfer: transfers });
    queueMicrotask(() => self.onmessage({ data: received }));
  }
  terminate() { if (activeWorker === this) activeWorker = null; }
}
const { createExportWorkerBridge } = await import('../workers/workerBridge.js');
const { applyPreparedAdjustmentsToBuffer, createAdjustmentLutScratch } = await import('./adjustmentPipeline.js');
const { settledDisplayRoute, step3FrameReference } = await import('./displayCanvas.js');
const { previewTierMaxPixels } = await import('./previewTier.js');

const linear = () => Uint8Array.from({ length: 256 }, (_, v) => v);
// Vibrance and saturation: the one step where 'full' and 'preview' differ.
const recipe = { curves: { r: linear(), g: linear(), b: linear() }, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, saturation: 12, vibrance: 30, cyan: 3, magenta: 0, yellow: -2, wbR: 1.06, wbG: 1, wbB: 0.95,
  look: null, expiredEnabled: false, expiredAnalysis: null };
function ramp(width, height) {
  const imageData = image(width, height);
  for (let i = 0; i < width * height; i++) {
    imageData.data[i * 4] = (i * 5) & 255; imageData.data[i * 4 + 1] = (i * 3 + 40) & 255;
    imageData.data[i * 4 + 2] = (i * 11 + 90) & 255; imageData.data[i * 4 + 3] = 255;
  }
  return imageData;
}
function expectedFull(source) {
  const out = image(source.width, source.height);
  applyPreparedAdjustmentsToBuffer(source, recipe, out, { quality: 'full' });
  return out;
}
const sameData = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function settleFixture({ width = 1200, height = 900, worker = 'real', gl = false } = {}) {
  const shown = ramp(width, height);
  const state = {
    currentStep: 3, cropping: false, beforeAfterActive: false,
    processedImageData: { width: width * 4, height: height * 4, name: 'full plane' },
    previewSourceImageData: shown, displayImageData: null,
    dustRemoval: { showMask: false, mask: null }
  };
  const drawn = [], histograms = [], requests = [], overlaySyncs = [];
  let glActive = gl;
  const real = createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });
  const workers = {
    isWorkerAvailable: () => worker !== 'none',
    workerApplyAdjustments: (source, prepared, quality, ...rest) => {
      requests.push({ source, prepared, quality });
      if (worker === 'failing') return Promise.resolve(null);
      if (worker === 'cancelled') return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      return real.workerApplyAdjustments(source, prepared, quality, ...rest);
    }
  };
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, ImageData: TestImageData, Uint8ClampedArray, console,
    canvas: { width: 1809, height: 1202 }, mainCanvasPhoto: null,
    settledDisplayToken: 0, settledAdjustedBuffer: null, previewAdjustedBuffer: null, expiredCompareHeld: false,
    displayDebugCounters: { mainAdjustments: 0, mainAdjustMaxPixels: 0, mainAdjustOverPreviewCap: 0,
      exportFallbackAdjustments: 0, exportFallbackMaxPixels: 0, settleRequests: 0, settleWorker: 0, settleSync: 0, settlePresented: 0 },
    defaultExportWorkers: workers, settledDisplayRoute, step3FrameReference, previewTierMaxPixels,
    buildAdjustmentSettings: () => ({ ...recipe }),
    applyPreparedAdjustmentsToBuffer, adjustmentLutScratch: createAdjustmentLutScratch(),
    renderAdjustedImageDataToMainCanvas: (imageData, reference, options) => drawn.push({ imageData, reference, options }),
    // #253, #254: the tint and the strokes are on their own layer, synced per
    // frame; a full frame drops the live dodge rectangles.
    syncDisplayOverlay: () => overlaySyncs.push(drawn.length), scheduleDisplayModesWarmup: noop, refreshGlBorderSmear: noop,
    liveDisplaySerial: 0,
    renderHistogram: imageData => histograms.push(imageData),
    isWebGLActive: () => glActive,
    // updateFull's own dependencies.
    scheduleStudioThumbnailUpdate: noop, updateExportUI: noop, initWebGLRenderer: () => true,
    updateCanvasVisibility: noop, renderWebGL: () => true, settleInterimGeometryDisplay: noop,
    renderHistogramForWebGL: noop, gpuPreview: { lastDraw: 'step3' }, scheduleGpuPreviewWarmup: noop,
    schedulePreviewUpdate: () => drawn.push('scheduled'),
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'supersedeSettledDisplay', 'presentGlFrame', 'displaySourceImageData', 'presentCpuFrame',
    'buildDisplayAdjustmentSettings', 'noteMainThreadAdjustment', 'ensureImageDataBuffer', 'applyAdjustmentsToBuffer',
    'updatePreviewCpu', 'updateFull', 'renderSettledDisplay', 'getCurrentHistogramSource', 'redrawHistogramIfPossible'
  ].map(functionSource).join('\n'), context);
  return { context, state, shown, drawn, overlaySyncs, histograms, requests, counters: context.displayDebugCounters,
    setGl: value => { glActive = value; }, dispose: () => real.terminateWorker() };
}

{
  // Above 1 MP: one worker request at quality 'full' on the display preview;
  // nothing is drawn until it lands; then the handle, the canvas and the
  // histogram all show exactly the main-thread 'full' pass of that preview.
  const f = settleFixture();
  f.context.updateFull();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].source, f.shown, 'the display preview, never the full-resolution plane');
  assert.equal(f.requests[0].quality, 'full', 'the exact colour model of exports');
  assert.deepEqual(f.drawn, [], 'the preview-quality frame stays until the result lands');
  await settle(); await settle();
  assert.equal(f.drawn.length, 1);
  const shown = f.state.displayImageData;
  assert.equal(f.drawn[0].imageData, shown, 'the handle is what was drawn');
  assert.equal(f.drawn[0].reference, f.state.processedImageData, 'its CSS box fits the full-resolution frame it stands for');
  assert.equal(f.histograms.at(-1), shown, 'and what the histogram shows');
  assert.ok(sameData(shown.data, expectedFull(f.shown).data), 'displayImageData == applyPreparedAdjustmentsToBuffer(preview, full)');
  const preview = image(f.shown.width, f.shown.height);
  applyPreparedAdjustmentsToBuffer(f.shown, recipe, preview, { quality: 'preview' });
  assert.ok(!sameData(preview.data, shown.data), 'the fixture tells full from preview quality');
  assert.deepEqual({ ...f.counters }, { mainAdjustments: 0, mainAdjustMaxPixels: 0, mainAdjustOverPreviewCap: 0,
    exportFallbackAdjustments: 0, exportFallbackMaxPixels: 0, settleRequests: 1, settleWorker: 1, settleSync: 0, settlePresented: 1 },
  'no Step-3 pass on this thread');
  assert.equal(f.context.getCurrentHistogramSource(), shown);
  f.dispose();
}

for (const supersede of ['newer frame', 'new source', 'crop', 'comparison', 'GL', 'Step 2']) {
  // A result that lands after a newer frame or a mode that owns the canvas is dropped.
  const f = settleFixture();
  f.context.updateFull();
  if (supersede === 'newer frame') f.context.updatePreviewCpu();
  if (supersede === 'new source') f.state.previewSourceImageData = ramp(1200, 900);
  if (supersede === 'crop') f.state.cropping = true;
  if (supersede === 'comparison') f.state.beforeAfterActive = true;
  if (supersede === 'GL') f.setGl(true);
  if (supersede === 'Step 2') f.state.currentStep = 2;
  const drawnBefore = f.drawn.length;
  await settle(); await settle();
  assert.equal(f.drawn.length, drawnBefore, `${supersede}: the late result is not drawn`);
  assert.equal(f.counters.settlePresented, 0);
  f.dispose();
}

{
  // A GL frame supersedes a pending settle and clears the handle.
  const f = settleFixture();
  f.context.updateFull();
  f.setGl(true);
  f.context.updateFull();
  await settle(); await settle();
  assert.equal(f.state.displayImageData, null);
  assert.equal(f.drawn.length, 0);
  assert.deepEqual([f.context.canvas.width, f.context.canvas.height], [1, 1], 'the hidden #canvas lets its backing go');
  f.dispose();
}

for (const worker of ['none', 'failing']) {
  // Without a worker, or when it fails, the display-size pass runs here.
  const f = settleFixture({ worker });
  f.context.updateFull();
  await settle(); await settle();
  assert.equal(f.drawn.length, 1, `${worker}: drawn`);
  assert.ok(sameData(f.state.displayImageData.data, expectedFull(f.shown).data), `${worker}: the same exact pass`);
  assert.equal(f.counters.settleSync, 1);
  assert.equal(f.counters.mainAdjustMaxPixels, 1200 * 900, `${worker}: never more than the display preview here`);
  assert.equal(f.counters.mainAdjustOverPreviewCap, 0);
  f.dispose();
}

{
  // A cancelled worker (hidden-window shedding) leaves the frame on screen.
  const f = settleFixture({ worker: 'cancelled' });
  f.context.updateFull();
  await settle(); await settle();
  assert.equal(f.drawn.length, 0);
  assert.equal(f.counters.settleSync, 0, 'no main-thread pass after a cancellation');
  f.dispose();
}

{
  // At or below 1 MP the pass is short: it runs in the caller's task.
  const f = settleFixture({ width: 1000, height: 1000 });
  f.context.updateFull();
  assert.equal(f.requests.length, 0);
  assert.equal(f.drawn.length, 1);
  assert.ok(sameData(f.state.displayImageData.data, expectedFull(f.shown).data));
  f.dispose();
}

{
  // The preview frame: the handle is the display-size frame on screen; the
  // overlays are synced on their own layer after it (#253, #254), never drawn
  // into the photo's canvas and never redrawn from the unadjusted positive.
  const f = settleFixture({ width: 64, height: 48 });
  f.context.updatePreviewCpu();
  const handle = f.state.displayImageData;
  assert.deepEqual([handle.width, handle.height], [64, 48]);
  assert.equal(f.drawn.at(-1).imageData, handle);
  assert.equal(f.drawn.at(-1).options.fastSprocketPreview, true);
  assert.deepEqual(f.overlaySyncs, [1], 'the overlay layer is synced after the frame, which alone went to #canvas');
  assert.equal(f.context.liveDisplaySerial, 1, 'a full frame drops the live dodge rectangles');
  f.state.displayImageData = null;
  assert.equal(f.context.getCurrentHistogramSource(), null, 'never the unadjusted positive');
  f.context.redrawHistogramIfPossible();
  assert.equal(f.drawn.at(-1), 'scheduled');
  f.state.currentStep = 2;
  f.state.croppedImageData = image(4, 4);
  assert.equal(f.context.getCurrentHistogramSource(), f.state.croppedImageData, 'Steps 1-2: the negative');
  f.dispose();
}

// ---- B3: #canvas holds the drawn buffer; its CSS box fits the full frame ----
const { getSprocketFrameLayout, getSprocketFrameMetrics, composeSprocketFrame } = await import('./sprocketFrame.js');
const { upscaleReference, photoRectPercent } = await import('./displayCanvas.js');

function canvasFixture({ sprocket = false, step = 3 } = {}) {
  const calls = [];
  const fits = [];
  const makeCanvas = (id) => {
    let width = 300, height = 150;
    const element = {
      id, style: { display: 'block' },
      get width() { return width; }, set width(value) { width = value; calls.push([id, 'width', value]); },
      get height() { return height; }, set height(value) { height = value; calls.push([id, 'height', value]); },
    };
    element.ctx = {
      putImageData: (imageData, x, y) => calls.push([id, 'put', imageData.width, imageData.height, x, y]),
      drawImage: (source, ...args) => calls.push([id, 'draw', source.id, ...args]),
      clearRect: () => {},
    };
    element.getContext = () => element.ctx;
    return element;
  };
  const canvas = makeCanvas('canvas');
  const glCanvas = makeCanvas('glCanvas');
  glCanvas.style.display = 'none';
  const frameCanvas = makeCanvas('frame');
  const comparison = makeCanvas('comparison');
  comparison.style.display = 'none';
  const full = { width: 6000, height: 4000, name: 'full plane' };
  const state = { currentStep: step, cropping: false, sprocketPreviewEnabled: sprocket, processedImageData: full,
    processedImageDataIsPreview: false, conversionSourceImageData: full, previewSourceImageData: image(1500, 1000) };
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, canvas, ctx: canvas.ctx, glCanvas, sprocketPreviewFrameCanvas: frameCanvas, sprocketPreviewFrameCtx: frameCanvas.ctx,
    sprocketPreviewFrameCache: { key: '', sourceRef: null, metrics: null },
    beforeAfterCanvas: comparison, beforeAfterCanvasSource: null, beforeAfterBuiltReference: null, mainCanvasPhoto: null,
    hideDetailLayer: noop,
    mainCanvasFit: { width: 0, height: 0, reference: null },
    composeDisplaySprocketFrame: (imageData, options) => composeSprocketFrame(imageData, options),
    composeSprocketFrameBackground: (imageData, options) => {
      const framed = composeSprocketFrame(imageData, options);
      return framed;
    },
    getSprocketFrameMetrics, getSprocketFrameLayout, getSprocketFrameComposeOptions: () => ({ edgeMarkings: {} }),
    prepareSprocketPreviewFont: noop, settleInterimGeometryDisplay: noop,
    step3FrameReference, upscaleReference, photoRectPercent, JSON,
    adjustCanvasDisplay: (w, h, reference) => fits.push({ w, h,
      reference: reference === undefined ? 'state' : reference && { width: reference.width, height: reference.height } }),
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'setMainCanvasBox', 'setMainCanvasDimensions', 'refitMainCanvasBox', 'sprocketFrameSize', 'sprocketFrameReference',
    'displaySourceImageData', 'fitStep3CanvasBox', 'getSprocketPreviewFrameCacheKey', 'ensureSprocketPreviewFrameBackground',
    'renderFastSprocketPreview', 'renderAdjustedImageDataToMainCanvas', 'placeBeforeAfterCanvas',
    'showBeforeAfterReference', 'releaseBeforeAfterCanvas'].map(functionSource).join('\n'), context);
  return { context, state, canvas, glCanvas, comparison, full, calls, fits };
}

{
  // Unframed: the backing is the drawn buffer, one put at 0,0, no scaled
  // draw; the box fits the full frame.
  const f = canvasFixture();
  const shown = image(1500, 1000);
  f.context.renderAdjustedImageDataToMainCanvas(shown, f.full);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1500, 1000]);
  assert.deepEqual(f.calls.filter(call => call[1] === 'put' || call[1] === 'draw'), [['canvas', 'put', 1500, 1000, 0, 0]]);
  assert.deepEqual(f.fits.at(-1), { w: 1500, h: 1000, reference: { width: 6000, height: 4000 } });
  assert.equal(f.context.mainCanvasFit.reference.name, undefined, 'the refit keeps sizes, never the image');
  // A refit (window resize, showImageUI) reuses that fit, not the backing.
  f.context.refitMainCanvasBox();
  assert.deepEqual(f.fits.at(-1), { w: 1500, h: 1000, reference: { width: 6000, height: 4000 } });
  // Steps 1-2 draw the negative at its own size.
  f.context.renderAdjustedImageDataToMainCanvas(image(40, 30));
  assert.deepEqual(f.fits.at(-1).reference, { width: 40, height: 30 });
}

{
  // New planes set the CSS box only: the backing waits for a presented frame.
  const f = canvasFixture();
  f.context.renderAdjustedImageDataToMainCanvas(image(1500, 1000), f.full);
  const writes = f.calls.length;
  f.state.previewSourceImageData = image(1200, 800);
  f.state.processedImageData = { width: 9000, height: 6000 };
  f.context.fitStep3CanvasBox();
  assert.equal(f.calls.length, writes, 'no backing write, so an in-flight settle never exposes a cleared canvas');
  assert.deepEqual(f.fits.at(-1), { w: 1200, h: 800, reference: { width: 9000, height: 6000 } });
  f.state.cropping = true;
  f.context.fitStep3CanvasBox();
  assert.deepEqual(f.fits.at(-1).w, 1200, 'the crop draft keeps its canvas');
}

for (const [width, height] of [[1500, 1000], [1000, 1500]]) {
  // With the border: the frame is composed at display metrics and drawn 1:1;
  // the box fits the full frame's border (portrait-aware); the comparison sits
  // over the photo, not the border.
  const f = canvasFixture({ sprocket: true });
  f.state.processedImageData = width > height ? f.full : { width: 4000, height: 6000 };
  const reference = f.state.processedImageData;
  const shown = image(width, height);
  f.context.renderAdjustedImageDataToMainCanvas(shown, reference);
  const layout = getSprocketFrameLayout(width, height, { edgeMarkings: {} });
  assert.deepEqual([f.canvas.width, f.canvas.height], [layout.frameWidth, layout.frameHeight], `${width}x${height}: display-size frame`);
  // The box: the drawn frame scaled to the full photo, so it keeps the drawn
  // frame's aspect (no letterbox) whatever the border's minimum widths do.
  const boxed = f.fits.at(-1).reference;
  assert.ok(Math.abs(boxed.width / boxed.height - layout.frameWidth / layout.frameHeight) < 1e-9, 'the drawn frame\'s aspect');
  assert.ok(Math.abs(boxed.width - layout.frameWidth * reference.width / width) < 1e-9);
  assert.deepEqual({ ...f.context.mainCanvasPhoto }, layout);
  assert.ok(f.calls.every(call => call[1] !== 'draw' || call.length === 5), 'no scaled draw');
  if (width > height) {
    // The fast drag path: the cached border 1:1, the photo put inside it.
    f.calls.length = 0;
    f.context.renderAdjustedImageDataToMainCanvas(shown, reference, { fastSprocketPreview: true });
    const metrics = getSprocketFrameMetrics(width, height, { edgeMarkings: {} });
    assert.deepEqual(f.calls.filter(call => call[1] === 'put' || call[1] === 'draw').filter(call => call[0] === 'canvas'),
      [['canvas', 'draw', 'frame', 0, 0], ['canvas', 'put', width, height, metrics.sideMargin, metrics.bandHeight]]);
    assert.deepEqual([f.canvas.width, f.canvas.height], [metrics.outputWidth, metrics.outputHeight]);
    assert.deepEqual({ ...f.context.mainCanvasPhoto }, layout);
  }
  // The comparison over the photo rectangle, drawn once per reference.
  const before = image(width, height);
  assert.equal(f.context.showBeforeAfterReference(before), true);
  const box = photoRectPercent(layout);
  assert.deepEqual([f.comparison.style.left, f.comparison.style.top, f.comparison.style.width, f.comparison.style.height],
    [box.left, box.top, box.width, box.height]);
  assert.deepEqual([f.comparison.width, f.comparison.height], [width, height]);
  const puts = f.calls.filter(call => call[0] === 'comparison' && call[1] === 'put').length;
  f.comparison.style.display = 'none';
  f.context.showBeforeAfterReference(before);
  assert.equal(f.calls.filter(call => call[0] === 'comparison' && call[1] === 'put').length, puts, 'the next press is a style flip');
  assert.equal(f.comparison.style.display, 'block');
  f.context.releaseBeforeAfterCanvas();
  assert.deepEqual([f.comparison.width, f.comparison.height, f.comparison.style.display], [1, 1, 'none']);
  assert.equal(f.context.beforeAfterCanvasSource, null);
}

{
  // Without the border the comparison covers the whole image box.
  const f = canvasFixture();
  f.context.renderAdjustedImageDataToMainCanvas(image(1500, 1000), f.full);
  f.context.showBeforeAfterReference(image(1500, 1000));
  assert.deepEqual([f.comparison.style.left, f.comparison.style.top, f.comparison.style.width, f.comparison.style.height], ['', '', '', '']);
}

{
  // #248: the conversion preview is a display target without pixels. The
  // comparison's reference is its display negative, resampled from the level
  // once (as the preview worker does, 16-bit rounded to 8) and kept, so the
  // next press on the photo writes nothing; a release drops it.
  const { displayTargetFor, isDisplayTarget, resampleDisplayLevel, displayLevelGeometry, buildDisplayLevel } = await import('./displayPreview.js');
  const source = ramp(1203, 803);
  const level = buildDisplayLevel(source, 3);
  const target = displayTargetFor(level, { width: 301, height: 201 });
  const state = { currentStep: 3, conversionPreviewImageData: target, conversionSourceImageData: source };
  const built = [];
  // ImageData's (width, height) form too, as the page has it.
  class PageImageData extends TestImageData {
    constructor(...args) { super(...(typeof args[0] === 'number' ? [new Uint8ClampedArray(args[0] * args[1] * 4), ...args] : args)); }
  }
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, setTimeout, convertPreviewFrameInWorker: { displayNegative: async () => { throw Error('worker unavailable'); } }, previewRequestImage: () => ({}), buildRouterSettings: () => ({}), getColorAnalysisSample: () => null, ImageData: PageImageData, Uint16Array, Math, beforeAfterBuiltReference: null, beforeAfterCanvasSource: null,
    beforeAfterCanvas: null, isDisplayTarget, resampleDisplayLevel, displayLevelGeometry,
    buildPreviewSourceImageData: imageData => { built.push(imageData); return image(4, 4); },
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'prepareBeforeAfterReference', 'getBeforeAfterReferenceImageData', 'displayNegativeOfTarget', 'releaseBeforeAfterCanvas'].map(functionSource).join('\n'), context);
  assert.equal(context.getBeforeAfterReferenceImageData(), null);
  await new Promise(resolve => setTimeout(resolve, 10));
  const reference = context.getBeforeAfterReferenceImageData();
  assert.ok(reference instanceof TestImageData, 'an 8-bit ImageData to put');
  assert.deepEqual([reference.width, reference.height], [301, 201]);
  const plane = resampleDisplayLevel(level, displayLevelGeometry(level), target);
  assert.deepEqual(reference.data, Uint8ClampedArray.from(plane.data, value => Math.round(value / 257)), 'the worker\'s display negative');
  assert.equal(context.getBeforeAfterReferenceImageData(), reference, 'kept for the next press');
  context.releaseBeforeAfterCanvas();
  assert.notEqual(context.getBeforeAfterReferenceImageData(), reference, 'released with the comparison');
  // A preview with pixels (the source itself at display size) is the reference.
  const small = image(8, 6);
  state.conversionPreviewImageData = small;
  assert.equal(context.getBeforeAfterReferenceImageData(), small);
  // No preview: built once from the source, never the source itself.
  state.conversionPreviewImageData = null;
  context.getBeforeAfterReferenceImageData();
  await new Promise(resolve => setTimeout(resolve, 10));
  const fallback = context.getBeforeAfterReferenceImageData();
  assert.equal(context.getBeforeAfterReferenceImageData(), fallback);
  assert.deepEqual(built, [source]);
  assert.equal(state.conversionPreviewImageData, null, 'the conversion preview is left alone');
}

console.log('displayPath: Steps 1-2 export without a readback, failed conversions show the framed negative, the settled CPU display is exact, display-size and off this thread, #canvas holds the drawn buffer, and the comparison is a cached element over the photo passed');
