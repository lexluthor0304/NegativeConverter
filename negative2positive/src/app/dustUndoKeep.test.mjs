// Undo and redo across a step that converts the frame again (#259, #229
// review R1-105), in the app itself: main.js's real history (captureSnapshot,
// restoreSnapshot, performUndo/performRedo and the dust-stroke deltas), its
// real conversion landing (runCoreReprocess, rerenderWithCoreControls), its
// real detection pass with the keep step, and the export's repair step, run
// in a vm. SilverCore is a stand-in (an exposure offset, a new frame object
// per conversion); detection and TELEA are the real OpenCV ones and brush
// strokes the real regional DustBrush patches. Undoing a slider, strength or
// crop step used to detect dust again once the conversion landed, which
// dropped every brush refinement. Now the restored mask, repaired image and
// particle count stay, bit for bit, when the new frame has the restored clean
// source's pixels, and the export equals the one made before that step. A
// frame whose pixels really changed, a dust state its snapshot had not
// settled, other dust inputs or another inpainter detect again, as before.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { routeCoreConversion, restoredFrameFlags, repairsNeedSettling } from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';
import { backingBuffers } from './photoSessionCache.js';
import { createRepairStamps, sameRepairStrokes, captureDustPass, dustPassMatches, restoreDustPass } from './repairReuse.js';
import { applyStrokePatch, applyDustDelta, copyImageRect, sameFramePixels } from './dustStrokeHistory.js';
import { encodeTiffBlob } from './exportImageEncoders.js';
import { detectDust, inpaintMasked } from '../silvercore/engine/DustRemoval.js';
import { applyDustStroke } from '../silvercore/engine/DustBrush.js';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const require = createRequire(import.meta.url);
const UPNG = require('upng-js');
const opencv = require('@techstark/opencv-js');
globalThis.cv = typeof opencv.then === 'function' ? await opencv : opencv;

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
function constSource(name) {
  const start = source.indexOf(`    const ${name} = `);
  assert.ok(start >= 0, `runtime constant exists: ${name}`);
  const end = source.indexOf(';\n', start);
  return source.slice(start, end + 1).replace(`const ${name} =`, `var ${name} =`);
}

const FUNCTIONS = [
  // History.
  'captureSnapshot', 'restoreSnapshot', 'cancelPendingTimers', 'liveHistoryRoots', 'hotGeometrySnapshot',
  'historyExclusiveBytes', 'pruneHistoryForMemory', 'trimHistorySnapshot', 'commitUndoSnapshot', 'noteManualEdit',
  'pushHistoryEntry', 'pushUndo', 'pushUndoDelta', 'performUndo', 'performRedo',
  // The conversion and its landing.
  'runCoreReprocess', 'rerenderWithCoreControls', 'routeCoreRequest', 'conversionSourceSize',
  'beginFullResolutionConversion', 'endFullResolutionConversion', 'abortSupersededFullResolutionConversion',
  'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled',
  // Dust state, detection and the keep step.
  'resetDustForCleanSource', 'takeRestoredDust', 'restoredDustInputsHold', 'keepRestoredDust', 'dustStateSettled',
  'scheduleDustDetection', 'runDustDetection', 'runDustDetectionPass', 'noteDustReplaced', 'nextDustMaskTag',
  'getDustSource', 'hasFrameRepairs', 'applyDustResultToState', 'commitDustPass', 'dustPassUsesAi', 'aiRepairReady',
  'currentRepairRecipe', 'stampRepairResult', 'carryRestoredRepairStamp', 'detectDustOffMainThread',
  'assertRepairCurrent', 'dustMaskIsStale', 'isCurrentLoad', 'dustMaxParticleSizeFor',
  // The brush and its history entries.
  'commitDustStroke', 'restoreDustDelta', 'needsDustPrivateBuffer', 'installDustPrivateBuffer',
  'ensureDustPrivateBuffer', 'showDustParticleCount',
  // The export's repair step.
  'ensureRepairsReadyForExport', 'prepareCurrentImageForExport', 'dustMaskHasPixels', 'whenBrushRepairsSettled',
  'noteBrushRepairSettled',
];

let seed = 7;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

// The conversion source (a geometry plane of the negative), with bright
// specks; the same arguments give the same frame.
function makeSource(width, height, specks) {
  let state = 4242;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = (p - x) / width;
    for (let c = 0; c < 3; c++) {
      data[p * 4 + c] = 60 + ((x * (c + 1) + y * 2) >> 3) % 80;
      plane[p * 4 + c] = data[p * 4 + c] * 257 + (p % 200);
    }
    data[p * 4 + 3] = 255; plane[p * 4 + 3] = 65535;
  }
  for (let k = 0; k < specks; k++) {
    const cx = 4 + Math.floor(random() * (width - 8)), cy = 4 + Math.floor(random() * (height - 8));
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 245;
      plane[i] = plane[i + 1] = plane[i + 2] = 245 * 257;
    }
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}

// SilverCore's stand-in: deterministic in the source's pixels and the
// settings, and a new frame object every time, as a conversion is.
// `drift` is an input no snapshot holds (a roll analysis, say).
function convert(input, exposure, drift = 0) {
  const shift = exposure * 6 + drift;
  const data = new Uint8ClampedArray(input.data.length);
  const plane = new Uint16Array(input.data.length);
  for (let i = 0; i < data.length; i++) {
    if ((i & 3) === 3) { data[i] = 255; plane[i] = 65535; continue; }
    data[i] = input.data[i] + shift;
    plane[i] = Math.max(0, Math.min(65535, input.__image16.data[i] + shift * 257));
  }
  const frame = new ImageData(data, input.width, input.height);
  frame.__image16 = { width: input.width, height: input.height, data: plane };
  return frame;
}

function crop(image, rect) {
  const { rgba8, rgba16 } = copyImageRect(image, rect);
  const out = new ImageData(rgba8, rect.width, rect.height);
  out.__image16 = { width: rect.width, height: rect.height, data: rgba16 };
  return out;
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(setImmediate); };

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    run() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
  };
}

function fixture({ width = 160, height = 120, specks = 24, ai = false } = {}) {
  const base = makeSource(width, height, specks);
  const calls = { convert: 0, detect: 0, inpaint: 0 };
  const clock = fakeClock();
  let drift = 0;
  let status = '';
  const state = {
    currentStep: 3, coreExposure: 0, rotationAngle: 0, mirrored: false,
    loadedBaseImageData: base, originalImageData: base, croppedImageData: null, conversionSourceImageData: base,
    conversionPreviewImageData: base, processedImageData: null, processedImageDataIsPreview: false,
    fullResolutionPending: false, previewSourceImageData: null, histogramSourceImageData: null,
    webglSourceImageData: null, displayLevelImageData: null, autoWbSample: null, displayImageData: null,
    repairStrokes: [], filmBase: { r: 210, g: 140, b: 90 }, cropRegion: null, semanticMap: null, rollFrame: null,
    curves: { r: null, g: null, b: null }, curvePoints: { r: [], g: [], b: [] }, sprocketEdge: null,
    lensCorrection: null, filmEdge: null, learnedDefaults: null, localExposure: null, look: null,
    expiredAnalysis: null, frameMetadata: null, autoFrame: { lastDiagnostics: null }, fileQueue: [],
    dustRemoval: { enabled: true, ai, strength: 5, maxParticleSize: 40, brushSize: 5, showMask: true,
      mask: null, maskTag: null, inpaintedImageData: null, cleanSource: null, _state: null,
      processing: false, particleCount: 0, revision: 0 },
  };
  const target = {
    coreReprocessSettledListeners: new Set(),
    state, console: { warn() {}, error(...args) { target.errors.push(args.map(String).join(' ')); }, info() {} },
    errors: [], document: { body: { dataset: {} } }, structuredClone, Uint8Array, DOMException,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    // History.
    undoStack: [], redoStack: [], MAX_UNDO: 30, HISTORY_MEMORY_BUDGET_BYTES: 768 * 1024 * 1024, manualEditRevision: 0,
    parkedPhoto: null, parkingPhoto: false,
    previewTierKept: null, reducedDisplayImages: new WeakSet(), backingBuffers, isLargeImage, restoredFrameFlags,
    createSprocketEdgeSettings: value => value, sanitizeRepairStrokes: strokes => strokes || [],
    sanitizeFrameMetadata: value => value, getUndoLabel: label => label, getLocalizedText: (key, fallback) => fallback,
    applyRestoredImageToState: (processed, flags) => {
      Object.assign(state, { processedImageData: processed, processedImageDataIsPreview: flags.previewOnly,
        fullResolutionPending: flags.fullResolutionPending });
    },
    applyProcessedImageToState: (processed, options = {}) => {
      state.processedImageData = processed;
      state.processedImageDataIsPreview = Boolean(options.previewOnly);
      if (!options.previewOnly) state.fullResolutionPending = false;
    },
    // The conversion: one rule (#237), a frame without a separate preview.
    routeCoreConversion, usesSilverCoreConversion: () => true, hasSeparateConversionPreview: () => false,
    isAiBrushEnabled: () => false, gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, backgroundGate: { bump() {} },
    WORKER_ABORTED: 'WORKER_ABORTED', exportBands: null, fullResolutionConversionAbort: null, displayedFrameToken: null,
    coreReprocessToken: 1, coreReprocessGeneration: 1, coreReprocessTimer: null, coreReprocessScheduled: null,
    coreSliderCommitRecord: null, _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0, _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    corePreviewRetained: null, corePreviewCommit: null, fullUpdateTimer: null, displayPreviewResizeTimer: null,
    step2AutoConvertTimer: null, repairedPreviewShown: null, repairedPreviewMasks: null,
    convertFromCurrentSource: async (settings) => {
      calls.convert++;
      await settle(1);
      return convert(settings.conversionSourceImageData, settings.coreExposure, drift);
    },
    // Dust.
    dustDetectionTimer: null, dustDetectionRevision: 0, dustDetectionRun: null, dustMaskSources: new WeakMap(),
    dustMaskTagSequence: 0, dustAiRefresh: { rects: [], timer: null }, dustPassCache: null, dustRefreshRepairMask: null,
    restoredDust: null, pendingBrushRepairs: 0, brushRepairWaiters: [], dustDrawing: false, loadGeneration: 1,
    convertedPixelsRevision: 0, repairStamps: createRepairStamps(), sameRepairStrokes, captureDustPass,
    dustPassMatches, restoreDustPass, applyStrokePatch, applyDustDelta, sameFramePixels, repairsNeedSettling,
    aiRepair: ai ? { status: 'ready', revision: 1, released: false, run() {} } : { status: 'idle', revision: 1, released: false, run: null },
    yieldTaskForJob: () => new Promise(setImmediate),
    flushScheduledCoreReprocess: async () => {}, ensureFullResolutionReadyForExport: async () => {},
    updateDustStatusUI: text => { status = text; },
    // The dust worker's detect (the worker returns no top-hat state).
    detectDustInWorker: async (image, options) => {
      calls.detect++;
      await settle(1);
      const { mask, particleCount } = detectDust(image, { strength: options.strength, maxParticleSize: options.maxParticleSize });
      return { mask, particleCount, _state: null };
    },
    // TELEA; with AI repair on, a deterministic stand-in for MI-GAN.
    inpaintForCommit: async (image, mask, isCurrent, worker, { report } = {}) => {
      calls.inpaint++;
      await settle(1);
      const usedAi = target.aiRepairReady();
      const out = inpaintMasked(image, mask, 3);
      if (usedAi) for (let i = 0; i < mask.length; i++) if (mask[i]) out.data[i * 4 + 1] ^= 0x10;
      if (report) Object.assign(report, { usedAi, revision: target.aiRepair.revision, blocks: null });
      return out;
    },
    inpaintManualBrush: async (image) => image,
    dustMaskInfo: () => null, forgetDustMaskInfo() {}, followDustMaskInWorker: () => Promise.resolve(),
  };
  const context = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      // UI and display helpers this test does not look at.
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    }
  }));
  vm.runInContext([...['SNAPSHOT_SCALAR_KEYS', 'SNAPSHOT_REF_KEYS', 'GEOMETRY_UNDO_LABELS'].map(constSource),
    ...FUNCTIONS.map(functionSource)].join('\n'), context);

  const busy = () => context._coreReprocessActive > 0 || context._coreReprocessFullInFlight
    || context.dustDetectionRun || state.dustRemoval.processing;
  // Runs timers (the detection's debounce) and work until nothing is left.
  const idle = async () => {
    for (let round = 0; round < 200; round++) {
      await settle();
      if (clock.timers.size) { clock.run(); continue; }
      if (!busy()) return;
    }
    assert.fail('the app did not settle');
  };
  const f = {
    context, state, target, calls, clock, base, idle,
    status: () => status,
    setDrift: (value) => { drift = value; },
    // A core slider (or Reset): the snapshot first, then the conversion.
    async slider(label, value) {
      context.pushUndo(label);
      state.coreExposure = value;
      await context.runCoreReprocess({ full: true });
      await idle();
    },
    // The strength field: the snapshot, then detection on the same source.
    async strength(value) {
      context.pushUndo('dustStrength');
      state.dustRemoval.strength = value;
      context.scheduleDustDetection();
      await idle();
    },
    // Apply Crop: new planes (a new conversion source), converted again.
    async crop(rect) {
      context.pushUndo('crop');
      const cropped = crop(state.conversionSourceImageData, rect);
      Object.assign(state, { croppedImageData: cropped, conversionSourceImageData: cropped, conversionPreviewImageData: cropped });
      await context.runCoreReprocess({ full: true });
      await idle();
    },
    // onDustBrushEnd without the worker: the page's regional stroke on a copy
    // of the mask (strokeDustOffMainThread's fallback), then the real commit.
    stroke(points, { mode = 'direct', brushRadius = 4 } = {}) {
      const dust = state.dustRemoval;
      context.ensureDustPrivateBuffer();
      if (dust.maskTag == null) dust.maskTag = context.nextDustMaskTag();
      const brush = { baseTag: dust.maskTag, tag: context.nextDustMaskTag(), points, brushRadius, mode, radius: 3 };
      const patch = applyDustStroke({ source: dust.cleanSource, mask: dust.mask.slice(), particleCount: null }, brush);
      assert.ok(patch, 'the stroke lands on the frame');
      context.commitDustStroke(patch, brush);
    },
    async undo() { context.performUndo(); await idle(); },
    async redo() { context.performRedo(); await idle(); },
    fingerprint() {
      const dust = state.dustRemoval;
      const image = dust.inpaintedImageData || dust.cleanSource;
      return {
        mask: hash(dust.mask), image8: hash(image.data), image16: hash(image.__image16.data), count: dust.particleCount,
        clean8: hash(dust.cleanSource.data), clean16: hash(dust.cleanSource.__image16.data),
        shown: state.processedImageData === image, exposure: state.coreExposure, strength: dust.strength,
        width: dust.cleanSource.width,
      };
    },
    // What a single export encodes once its repair step ran: the repaired
    // frame (Step 3 adjusts it by the same settings either way), as PNG 8-bit
    // and TIFF 16-bit.
    async exportFiles() {
      await context.prepareCurrentImageForExport();
      const frame = state.processedImageData;
      const png8 = new Uint8Array(UPNG.encode([frame.data.slice().buffer], frame.width, frame.height, 0));
      const tiff16 = new Uint8Array(await encodeTiffBlob(frame, 16).arrayBuffer());
      return { png8: hash(png8), tiff16: hash(tiff16) };
    },
  };
  return f;
}

// The first detection of the photo, then one stroke that adds mask pixels
// where no speck was (a direct stroke): the refinement a re-detection drops.
async function opened(options) {
  const f = fixture(options);
  f.state.processedImageData = convert(f.base, 0);
  f.context.scheduleDustDetection();
  await f.idle();
  assert.ok(f.state.dustRemoval.particleCount > 0, 'dust found');
  assert.equal(f.calls.detect, 1);
  return f;
}
const refine = (f, x = 40, y = 30) => f.stroke([{ x, y }, { x: x + 9, y: y + 4 }]);

// ---- 1. Stroke D1, move a slider, undo: the state before the slider, bit for
// bit, also once the conversion and the detection after it have landed. ----
{
  const f = await opened();
  refine(f);
  const dust = f.state.dustRemoval;
  const before = { fingerprint: f.fingerprint(), mask: dust.mask, image: dust.inpaintedImageData, clean: dust.cleanSource };
  const exportedBefore = await f.exportFiles();
  await f.slider('coreExposure', 2);
  const moved = f.fingerprint();
  assert.notEqual(moved.clean8, before.fingerprint.clean8, 'the slider converted the frame again');
  assert.equal(f.calls.detect, 2, 'and detected dust on it');
  const detections = f.calls.detect, inpaints = f.calls.inpaint, conversions = f.calls.convert;

  f.context.performUndo();
  assert.ok(f.context.restoredDust?.settled, 'the restore leaves its settled dust state for the conversion');
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'restored at once');
  await f.idle();
  assert.equal(f.calls.convert, conversions + 1, 'the undo converted the frame again');
  assert.equal(f.calls.detect, detections, 'no detection after the conversion landed');
  assert.equal(f.calls.inpaint, inpaints, 'no repair pass');
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'mask, repaired image and count as before the slider');
  assert.equal(dust.mask, before.mask, 'the very mask the stroke refined');
  assert.equal(dust.inpaintedImageData, before.image);
  assert.equal(dust.cleanSource, before.clean, 'the clean source its history entries name');
  assert.equal(f.status(), `Detected ${before.fingerprint.count} dust particles`);
  assert.equal(f.context.restoredDust, null, 'nothing left behind');
  assert.ok(f.context.dustStateSettled(), 'settled again');
  assert.deepEqual(await f.exportFiles(), exportedBefore, 'PNG 8-bit and TIFF 16-bit as exported before the slider');
  assert.equal(f.calls.detect, detections, 'the export detected nothing');

  // Undo D1 (in place), redo D1, redo the slider, undo it again: every step
  // as it was.
  await f.undo();
  const unrefined = f.fingerprint();
  assert.notEqual(unrefined.mask, before.fingerprint.mask);
  await f.redo();
  assert.deepEqual(f.fingerprint(), before.fingerprint);
  await f.redo();
  assert.deepEqual(f.fingerprint(), moved, 'redo brings the slider step back as it was');
  await f.undo();
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'a second undo round-trip');
  await f.undo();
  assert.deepEqual(f.fingerprint(), unrefined);
  assert.equal(f.calls.detect, detections, 'the whole round trip detected nothing');
  assert.deepEqual(f.target.errors, []);
}

// ---- 2. Core sliders, the strength field and Apply Crop interleaved with
// strokes: undo all the way and redo all the way, bit-identical at every
// step, with no detection. ----
{
  const f = await opened({ width: 200, height: 150, specks: 30 });
  const steps = [f.fingerprint()];
  const act = async (name) => {
    if (name === 'stroke') refine(f, 20 + Math.floor(random() * 150), 20 + Math.floor(random() * 100));
    else if (name === 'slider') await f.slider('coreExposure', f.state.coreExposure + 1);
    else if (name === 'strength') await f.strength(f.state.dustRemoval.strength === 5 ? 7 : 5);
    else if (name === 'crop') await f.crop({ x: 6, y: 4, width: f.state.conversionSourceImageData.width - 12, height: f.state.conversionSourceImageData.height - 8 });
    steps.push(f.fingerprint());
  };
  for (const name of ['stroke', 'slider', 'stroke', 'stroke', 'slider', 'stroke', 'strength', 'stroke', 'crop', 'stroke', 'slider', 'stroke']) await act(name);
  assert.equal(new Set(steps.map(step => JSON.stringify(step))).size, steps.length, 'every step changed the state');
  const detections = f.calls.detect;
  for (let i = steps.length - 1; i > 0; i--) {
    await f.undo();
    assert.deepEqual(f.fingerprint(), steps[i - 1], `undo back to step ${i - 1}`);
  }
  for (let i = 1; i < steps.length; i++) {
    await f.redo();
    assert.deepEqual(f.fingerprint(), steps[i], `redo to step ${i}`);
  }
  assert.equal(f.calls.detect, detections, 'no detection in either direction');
  // Down again, past the crop and both sliders.
  for (let i = steps.length - 1; i > 3; i--) await f.undo();
  assert.deepEqual(f.fingerprint(), steps[3]);
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.target.errors, []);
}

// ---- 3. In doubt, detect again (today's behaviour). ----
{
  // The clean source really changed: the snapshot was taken while its frame
  // still lagged its settings (a second edit before the first converted), so
  // the frame converted for the restored settings has other pixels.
  const f = await opened();
  refine(f);
  const settled = f.fingerprint();
  f.context.pushUndo('coreExposure');
  f.state.coreExposure = 1;
  await f.slider('coreExposure', 2);
  const lagging = f.context.undoStack.at(-1).refs;
  assert.ok(lagging.dustSettled, 'its dust state was settled; its frame was not');
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'a lagging frame is detected again');
  const after = f.fingerprint();
  assert.equal(after.exposure, 1);
  assert.notEqual(after.clean8, settled.clean8, 'the clean source has the new pixels');
  assert.notEqual(f.state.dustRemoval.cleanSource, lagging.dustCleanSource, 'and is the new frame');
  assert.notEqual(f.state.dustRemoval.mask, lagging.dustMask);
  assert.deepEqual(f.target.errors, []);
}
{
  // An input no snapshot holds moved the conversion (a roll analysis): the
  // restored frame's pixels are not the new frame's.
  const f = await opened();
  refine(f);
  await f.slider('coreExposure', 2);
  f.setDrift(3);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'other pixels: detected again');
}
{
  // A dust state its snapshot had not settled: a detection was still due.
  const f = await opened();
  refine(f);
  f.state.dustRemoval.strength = 6;
  f.context.scheduleDustDetection();
  f.context.pushUndo('coreExposure');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null, 'not settled while a detection is due');
  f.state.coreExposure = 2;
  await f.context.runCoreReprocess({ full: true });
  await f.idle();
  f.context.performUndo();
  assert.equal(f.context.restoredDust?.settled, false, 'restored with its mark');
  // Captured again before its conversion landed: the mark travels with it.
  f.context.pushUndo('coreContrast');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null, 'the mark travels with the restored state');
  const detections = f.calls.detect;
  await f.idle();
  assert.equal(f.calls.detect, detections + 1, 'an unsettled restore is detected again');
  assert.equal(f.state.dustRemoval.strength, 6);
  assert.deepEqual(f.target.errors, []);
}
{
  // A learned refresh still owed (TELEA stand-ins in the repaired image).
  const f = await opened();
  refine(f);
  f.target.dustAiRefresh.rects.push({ x: 1, y: 1, width: 4, height: 4 });
  f.context.pushUndo('coreExposure');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null);
  f.target.dustAiRefresh.rects.length = 0;
}
{
  // Another dust strength between the landing and the detection after it.
  const f = await opened();
  refine(f);
  await f.slider('coreExposure', 2);
  f.context.performUndo();
  await settle();
  assert.ok(f.context.restoredDust?.landed, 'the conversion landed; detection is due');
  f.state.dustRemoval.strength = 7;
  f.context.scheduleDustDetection();
  const detections = f.calls.detect;
  await f.idle();
  assert.equal(f.calls.detect, detections + 1, 'other dust inputs: detected again');
}
{
  // Another inpainter: the AI model was reloaded on another provider.
  const f = await opened({ ai: true });
  await f.slider('coreExposure', 2);
  f.target.aiRepair.revision += 1;
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'another model revision: detected again');
}

// ---- 4. AI repair on: a settled commit keeps its stamp across the undo, and
// the export takes it as before the slider (no pass). ----
{
  const f = await opened({ ai: true });
  const before = f.fingerprint();
  const inpaints = f.calls.inpaint;
  const exportedBefore = await f.exportFiles();
  assert.equal(f.calls.inpaint, inpaints, 'the stamped commit is exported as it is');
  await f.slider('coreExposure', -1);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.fingerprint(), before);
  const inpaintsAfter = f.calls.inpaint;
  assert.deepEqual(await f.exportFiles(), exportedBefore);
  assert.equal(f.calls.inpaint, inpaintsAfter, 'the carried stamp: no pass on export');
}

// ---- 5. Parity with the old behaviour (the landing detects again), on a
// 1.9 MP frame. Without brush refinements both exports equal the one made
// before the slider: nothing changes. With one, only the kept state does. ----
for (const refined of [false, true]) {
  const runs = {};
  for (const mode of ['old', 'new']) {
    const f = await opened({ width: 1600, height: 1200, specks: 400 });
    if (refined) refine(f, 700, 500);
    const before = f.fingerprint();
    const exportedBefore = await f.exportFiles();
    await f.slider('coreExposure', 3);
    f.context.performUndo();
    // The old landing: no restored state for the conversion to keep.
    if (mode === 'old') f.context.restoredDust = null;
    await f.idle();
    runs[mode] = { before, exportedBefore, after: f.fingerprint(), exported: await f.exportFiles(), detections: f.calls.detect };
  }
  assert.deepEqual(runs.old.exportedBefore, runs.new.exportedBefore);
  assert.deepEqual(runs.new.after, runs.new.before, `${refined ? 'refined' : 'detected'}: kept`);
  assert.deepEqual(runs.new.exported, runs.new.exportedBefore, `${refined ? 'refined' : 'detected'}: the export before the slider`);
  assert.equal(runs.new.detections, 2);
  assert.equal(runs.old.detections, 3);
  if (refined) {
    assert.notEqual(runs.old.after.mask, runs.old.before.mask, 'old: the refinement is gone');
    assert.notDeepEqual(runs.old.exported, runs.old.exportedBefore, 'old: the export lost it too');
  } else {
    assert.deepEqual(runs.old.after, runs.old.before, 'old: a fresh detection of the same pixels');
    assert.deepEqual(runs.old.exported, runs.new.exported, 'no refinement: old and new export the same bytes');
  }
}

console.log('Dust undo across a conversion: the restored mask, repaired image and count are kept bit for bit (sliders, strength, crop, strokes, redo), exports equal the ones before the step, and a changed frame, an unsettled state, other dust inputs or another inpainter detect again');
