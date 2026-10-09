// Test-only harness for undo and redo of dust states (#259, #281): main.js's
// real history (captureSnapshot, restoreSnapshot with its cold restore,
// performUndo/performRedo, the memory budget and the dust-stroke deltas), its
// real conversion landing (runCoreReprocess, rerenderWithCoreControls, and
// processNegative for a cold entry's rebuild), its real detection pass with
// the keep steps, cold entries' dust compaction, and the export's repair step,
// run in a vm. SilverCore is a stand-in (an exposure offset, a new frame
// object per conversion) and geometry a crop of the base; detection and TELEA
// are the real OpenCV ones and brush strokes the real regional DustBrush
// patches. UI helpers that are not listed fall back to no-ops. Never imported
// by the app.
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
import { compactDustSteps, rebuildDustSteps, frameDigestSteps, coldDustRecordBytes, runSteps, runStepsInSlices } from './dustColdState.js';
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
  // A cold entry: its rebuild and conversion, and its dust state (#281).
  'restoreColdSnapshotPixels', 'afterGeometry', 'convertAfterGeometryEdit', 'processNegative',
  'coldRefsFor', 'heldDustObjects', 'compactColdDust', 'startColdDustJob', 'endColdDustJob', 'coldDustWanted',
  'finishColdDustJobs', 'keepColdRestoredDust', 'keepColdDust', 'stampColdRestoredRepair', 'coldHistory',
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

// The conversion source (a geometry plane of the negative), with bright
// specks; the same arguments give the same frame.
export function makeSource(width, height, specks) {
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
export function convert(input, exposure, drift = 0) {
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

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
export const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(setImmediate); };

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

// `budget`: history's memory budget (HISTORY_MEMORY_BUDGET_BYTES); a small
// one makes entries cold at this size the way 768 MiB does from about 30 MP.
export function fixture({ width = 160, height = 120, specks = 24, ai = false, budget = 768 * 1024 * 1024,
  coldDustMaxBytes = null } = {}) {
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
  // The planes of the geometry the settings name: the base, or a crop of it.
  const buildPlanes = () => {
    state.originalImageData = base;
    state.croppedImageData = state.cropRegion ? crop(base, state.cropRegion) : null;
  };
  const target = {
    coreReprocessSettledListeners: new Set(),
    // processNegative records which lens a source and its display level carry (#278).
    lensCorrectedSources: new WeakMap(), displayLevelLenses: new WeakMap(),
    state, console: { warn() {}, error(...args) { target.errors.push(args.map(String).join(' ')); }, info() {} },
    errors: [], document: { body: { dataset: {} } }, structuredClone, Uint8Array, DOMException,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    // History.
    undoStack: [], redoStack: [], MAX_UNDO: 30, HISTORY_MEMORY_BUDGET_BYTES: budget, manualEditRevision: 0,
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
    // A cold entry's rebuild (#244): the planes from the base, then
    // processNegative without new automatic measurements.
    geometryDiagnostics: { coldRestores: 0 }, geometryToken: 0, processNegativeInFlight: null,
    installedGeometryKey: () => ({ baseId: 1 }), geometryBaseId: () => 1,
    applyGeometryFromBase: () => { buildPlanes(); return Promise.resolve(true); },
    whenGeometrySettled: async () => true, workingPlanes: () => state.croppedImageData || state.originalImageData,
    invalidateProcessedPipelineState: () => {
      for (const key of ['processedImageData', 'displayImageData', 'conversionSourceImageData', 'conversionPreviewImageData',
        'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData', 'autoWbSample', 'displayLevelImageData']) state[key] = null;
    },
    applyLensCorrectionWithSettings: async image => image, displayLevelFactor: () => 1,
    buildDisplayLevelInBands: async image => image, conversionTargetFor: image => image,
    filmInterpretationChanged: () => false, cropMeasurementInputsMatch: () => true,
    createPerfTrace: () => ({ mark() {}, end() {} }), i18n: { en: {} }, currentLang: 'en',
    quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
    // The conversion: one rule (#237), a frame without a separate preview.
    routeCoreConversion, usesSilverCoreConversion: () => true, hasSeparateConversionPreview: () => false,
    isAiBrushEnabled: () => false, gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, backgroundGate: { bump() {} },
    WORKER_ABORTED: 'WORKER_ABORTED', exportBands: null, fullResolutionConversionAbort: null, displayedFrameToken: null,
    coreReprocessToken: 1, coreReprocessGeneration: 1, coreReprocessTimer: null, coreReprocessScheduled: null,
    coreSliderCommitRecord: null, _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0, _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    corePreviewRetained: null, corePreviewCommit: null, fullUpdateTimer: null, displayPreviewResizeTimer: null,
    step2AutoConvertTimer: null, repairedPreviewShown: null, repairedPreviewMasks: null,
    // The conversion reads the planes on state (rerenderWithCoreControls
    // passes state itself, processNegative a snapshot of its settings).
    convertFromCurrentSource: async (settings) => {
      calls.convert++;
      await settle(1);
      return convert(state.conversionSourceImageData, settings.coreExposure, drift);
    },
    // Dust.
    dustDetectionTimer: null, dustDetectionRevision: 0, dustDetectionRun: null, dustMaskSources: new WeakMap(),
    dustMaskTagSequence: 0, dustAiRefresh: { rects: [], timer: null }, dustPassCache: null, dustRefreshRepairMask: null,
    restoredDust: null, pendingBrushRepairs: 0, brushRepairWaiters: [], dustDrawing: false, loadGeneration: 1,
    convertedPixelsRevision: 0, repairStamps: createRepairStamps(), sameRepairStrokes, captureDustPass,
    dustPassMatches, restoreDustPass, applyStrokePatch, applyDustDelta, sameFramePixels, repairsNeedSettling,
    // Cold entries' dust states (#281).
    coldRestoredDust: null, coldDustJobs: new Map(), cleanSourceDigests: new WeakMap(),
    coldDustDiagnostics: { compacted: 0, failed: 0, kept: 0 }, heldJobFrames: new Set(), memoryBudget: { poke() {} },
    compactDustSteps, rebuildDustSteps, frameDigestSteps, coldDustRecordBytes, runSteps, runStepsInSlices,
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
  vm.runInContext([...['SNAPSHOT_SCALAR_KEYS', 'SNAPSHOT_REF_KEYS', 'GEOMETRY_UNDO_LABELS', 'COLD_DUST_MAX_BYTES'].map(constSource),
    ...FUNCTIONS.map(functionSource)].join('\n'), context);
  if (coldDustMaxBytes !== null) target.COLD_DUST_MAX_BYTES = coldDustMaxBytes;

  const busy = () => context._coreReprocessActive > 0 || context._coreReprocessFullInFlight
    || context.dustDetectionRun || state.dustRemoval.processing || context.processNegativeInFlight
    || target.coldDustJobs.size > 0;
  // Runs timers (the detection's debounce) and work until nothing is left.
  const idle = async () => {
    for (let round = 0; round < 4000; round++) {
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
    // Apply Crop: new planes (a crop of the base, which the settings name),
    // converted again.
    async crop(rect) {
      context.pushUndo('crop');
      state.cropRegion = { ...rect };
      buildPlanes();
      Object.assign(state, { conversionSourceImageData: state.croppedImageData, conversionPreviewImageData: state.croppedImageData });
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

// The first detection of the photo.
export async function opened(options) {
  const f = fixture(options);
  f.state.processedImageData = convert(f.base, 0);
  f.context.scheduleDustDetection();
  await f.idle();
  assert.ok(f.state.dustRemoval.particleCount > 0, 'dust found');
  assert.equal(f.calls.detect, 1);
  return f;
}

// One stroke that adds mask pixels where no speck was (a direct stroke): the
// refinement a re-detection drops.
export const refine = (f, x = 40, y = 30) => f.stroke([{ x, y }, { x: x + 9, y: y + 4 }]);
