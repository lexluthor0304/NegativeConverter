// Test-only harness for the geometry chain state of main.js (#244): runs the
// real functions in a vm with the real geometry core and pool. UI helpers
// that are not listed fall back to no-ops. Never imported by the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';

if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
}
const geometry = await import('./imageGeometry.js');
const imageDataOps = await import('./imageDataOps.js');
const { createGeometryPool, yieldToEventLoop } = await import('./geometryPool.js');
const { backingBuffers, createPhotoSessionCache } = await import('./photoSessionCache.js');
const { planGeometryBandsInFlight } = await import('./batchExportScheduler.js');
const { exactSettingsKey } = await import('./settingsKey.js');

export { geometry, imageDataOps, backingBuffers, createPhotoSessionCache };

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
export function functionSource(name) {
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

export function makeBase(width, height, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { data16[i + c] = rnd() % 65536; data8[i + c] = data16[i + c] >>> 8; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
export function samePixels(actual, expected, label) {
  assert.ok(actual && expected, `${label}: images exist`);
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit`);
  assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit`);
}

export function exportChain(base, geometryState) {
  return geometry.applyGeometryChainToImageData(base, geometryState, {
    rotate: geometry.applyRotationToImageData, mirror: geometry.mirrorImageDataHorizontal,
    crop: (image, crop, bounds = image) => {
      const rect = geometry.sanitizeCropRect(crop, bounds);
      if (!image) return rect;
      return rect ? imageDataOps.cropImageDataRegion(image, rect) : image;
    }
  });
}

export const settle = async () => { for (let i = 0; i < 8; i++) await yieldToEventLoop(); };

const FUNCTIONS = [
  'geometryBaseId', 'effectiveGeometryAngle', 'geometryFrameSize', 'geometryKeyFor', 'sameGeometryKey',
  'installedGeometryKey', 'hasExactPlane16', 'isGeometryFrame', 'takeAdoptedRotation', 'createGeometryFrame',
  'materializeGeometryFrame', 'geometryPlanFor', 'renderGeometryFrame', 'buildGeometryPlanes',
  'installGeometryPlanes', 'holdGeometryBusy', 'releaseGeometryBusy', 'endGeometryJob', 'cancelGeometryJob',
  'whenGeometrySettled', 'noteGeometryPixelRead', 'startGeometryJob', 'applyGeometryFromBase', 'afterGeometry',
  'renderFrameSample', 'geometryFramePixels', 'interimGeometryCss', 'showInterimGeometryDisplay',
  'clearInterimGeometryDisplay', 'settleInterimGeometryDisplay', 'mapDraftRectToFrame',
  'storedRotationDelta', 'applyRotation', 'convertAfterGeometryEdit', 'rebuildGeometryFromBase', 'applyMirror',
  'mapCropRegionAfterRotation', 'sanitizeCropRegionForImage', 'restoreSettings', 'offerAutoFrameRotation',
  'isCurrentLoad', 'applyZoomPanTransform', 'resetZoomPan', 'captureSnapshot', 'restoreSnapshot',
  'restoreColdSnapshotPixels', 'liveHistoryRoots', 'hotGeometrySnapshot', 'historyExclusiveBytes',
  'pruneHistoryForMemory', 'trimHistorySnapshot', 'commitUndoSnapshot', 'pushUndo', 'performUndo', 'performRedo',
  'rememberPhotoSession', 'releaseOutgoingPhotoPlanes', 'photoSettingsKey', 'switchToFile',
  'reactivateReleasedPhoto', 'invalidatePhotoActivation', 'getCropDraftTotalAngle', 'scaleCropRect',
  'interactiveGeometryBands',
  // Apply Crop's pending crop-area detection (#245).
  'getCropDraftSize', 'hasPendingCropDetection', 'noteConversionStarted', 'cancelCropDetection', 'sameCropRect',
  'isCurrentCropDetection', 'settlePendingCropDetection', 'startCropDetection', 'detectCropArea',
  'applyCropDetectionOutcome'
];

// The Apply Crop click handler, as a named function.
export function applyCropHandlerSource() {
  const marker = "    applyCropBtn.addEventListener('click', async () => {";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'Apply Crop handler exists');
  const end = source.indexOf('\n    });', start);
  return 'var applyCropHandler = ' + source.slice(start + marker.length - 'async () => {'.length, end) + '\n    };';
}

export function createHarness(base, { historyBudget = 768 * 1024 * 1024, sessionBudget = 768 * 1024 * 1024, workers = null, realProcessNegative = false } = {}) {
  const displayed = [];
  const conversions = [];
  const state = {
    loadedBaseImageData: base, originalImageData: base, croppedImageData: null,
    processedImageData: null, displayImageData: null, conversionSourceImageData: null,
    conversionPreviewImageData: null, previewSourceImageData: null, histogramSourceImageData: null,
    webglSourceImageData: null, geometryPending: false, geometryReady: Promise.resolve(true),
    rotationAngle: 0, mirrored: false, cropRegion: null, currentStep: 1, cropping: false,
    zoomLevel: 1, panX: 0, panY: 0, fileQueue: [], flatFields: {},
    autoFrame: { rotate180Default: false, lastDiagnostics: null },
    lensCorrection: { search: {}, enabled: false, params: {}, modes: {} },
    curves: { r: null, g: null, b: null },
    curvePoints: { r: [{ x: 0, y: 0 }], g: [{ x: 0, y: 0 }], b: [{ x: 0, y: 0 }] },
    dustRemoval: { enabled: false, strength: 3, maxParticleSize: 40, brushSize: 10, showMask: false, mask: null, inpaintedImageData: null, cleanSource: null, _state: null, processing: false },
    repairStrokes: [], filmBase: { r: 1, g: 2, b: 3 }, frameMetadata: {}, exposure: 0, wbR: 1, wbG: 1, wbB: 1
  };
  const pool = createGeometryPool(workers ? { workerFactory: workers, workersSupported: true, size: 2 } : { workersSupported: false, size: 2 });
  const target = {
    state, geometryPool: pool, yieldToEventLoop,
    normalizeAngleDegrees: geometry.normalizeAngleDegrees,
    rotatedDimensions: geometry.rotatedDimensions,
    sanitizeCropRect: geometry.sanitizeCropRect,
    planGeometry: geometry.planGeometry,
    renderGeometry: geometry.renderGeometry,
    applyRotationToImageData: geometry.applyRotationToImageData,
    mirrorImageDataHorizontal: geometry.mirrorImageDataHorizontal,
    cropImageDataRegion: imageDataOps.cropImageDataRegion,
    downsampleImageDataForMaxPixels: imageDataOps.downsampleImageDataForMaxPixels,
    backingBuffers, planGeometryBandsInFlight, exactSettingsKey,
    // Integration-branch state the photo-switch path reads (#233, #234): no
    // preview-worker plane held, and one file-list refresh per switch.
    corePreviewRetained: null, corePreviewCommit: null, deferFileListRefresh: () => () => {},
    // No first-photo detection tail is running (#236).
    importDetectionAbort: null,
    // No learned-repair refresh of dust-brush rects is pending (#259).
    dustAiRefresh: { rects: [], timer: null },
    // #263: no reduced preview-tier session is open.
    previewTier: 'normal', previewTierKept: null, reducedDisplayImages: new WeakSet(), displayIsReduced: () => false,
    // No GPU preview frame is ahead of its exact frame (#239).
    gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER,
    geometryMemo: new WeakMap(), geometryBaseIds: new WeakMap(), nextGeometryBaseId: 1,
    pendingImportRotation: null, geometryToken: 0, geometryJob: null, geometryBusyOwner: null,
    interimGeometry: null, loadGeneration: 1, DEBUG_UI: false, manualEditRevision: 0,
    geometryDiagnostics: { pendingReads: 0, frameSyncReads: 0, adoptedRotations: 0, workerRotations: 0, mainRotations: 0, coldRestores: 0, coldSessions: false },
    undoStack: [], redoStack: [], MAX_UNDO: 30, HISTORY_MEMORY_BUDGET_BYTES: historyBudget,
    processNegativeInFlight: null, coreReprocessTimer: null, coreReprocessToken: 0, coreReprocessGeneration: 0,
    studioAutoFrameRunning: false, singleExportActive: false, studioThumbnailUpdateFrame: 0, expiredAnalysisKey: null,
    cropDetection: null, cropDetectionStats: { started: 0, hits: 0, misses: 0, stale: 0, reconversions: 0, conversions: 0 },
    lensMapCache: new Map(), canvas: { style: {} }, glCanvas: { style: {} },
    dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false, fullUpdateTimer: null,
    photoSessions: createPhotoSessionCache({ maxBytes: sessionBudget }),
    photoPreviews: createPhotoSessionCache({ maxBytes: 0 }),
    // #243: an empty prefetch slot, and each activation its own signal.
    photoPrefetch: createPhotoSessionCache({ maxBytes: 0 }), prefetchedItem: null,
    beginActivation: () => new AbortController().signal,
    fullResolutionRenderAbort: null, rewarmAutoFrameWorker: false,
    aiRepair: { revision: 1 },
    document: { body: { dataset: {} }, visibilityState: 'hidden' },
    studioWorkspace: { sync() {}, flush() {} },
    canvasTransformWrapper: { style: { width: '400px', height: '300px', transform: '' }, offsetWidth: 400, offsetHeight: 300 },
    canvasContainer: { clientWidth: 620, clientHeight: 520, classList: { add() {}, remove() {} } },
    zoomIndicator: { style: {} },
    console: { warn() {}, error() {}, info() {} },
    displayNegative: image => { displayed.push(image); context.settleInterimGeometryDisplay(); },
    // The real conversion waits for geometry the same way.
    processNegative: async (options = {}) => {
      await context.whenGeometrySettled();
      conversions.push({ source: state.croppedImageData || state.originalImageData, options });
      state.processedImageData = state.croppedImageData || state.originalImageData;
      state.currentStep = 3;
    },
    invalidateProcessedPipelineState: () => {
      for (const key of ['processedImageData', 'displayImageData', 'conversionSourceImageData', 'conversionPreviewImageData', 'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData']) state[key] = null;
    },
    sanitizeSettings: settings => ({
      filmBase: {}, lensCorrection: { enabled: false, params: {}, modes: {} },
      curvePoints: { r: [], g: [], b: [] }, ...structuredClone(settings)
    }),
    EXPIRED_RESCUE_KEYS: [], sanitizePresetType: value => value, getLoadingOverlay: () => ({ hide() {} }),
    getLocalizedText: (key, fallback) => fallback, getUndoLabel: label => label,
    getCurrentQueueItem: () => null, currentConvertedPreviewSource: () => null,
    buildAdjustmentSettings: () => ({ curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    coreReprocessBusy: () => false, sanitizeRepairStrokes: strokes => strokes || [], sanitizeFrameMetadata: value => value || {},
    createSprocketEdgeSettings: value => value || {}, clearFullResolutionRenderState: () => {},
    geometryCounters: geometry.geometryCounters,
  };
  const context = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    }
  }));
  vm.runInContext(['SNAPSHOT_SCALAR_KEYS', 'SNAPSHOT_REF_KEYS', 'GEOMETRY_UNDO_LABELS'].map(constSource).join('\n'), context);
  if (realProcessNegative) {
    delete target.processNegative;
    Object.assign(target, {
      i18n: { en: {} }, currentLang: 'en',
      quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
      getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
      createPerfTrace: () => ({ mark() {}, end() {} }),
      applyLensCorrectionWithSettings: async source => source,
      buildPreviewSourceImageData: source => source,
      usesSilverCoreConversion: () => false, hasSeparateConversionPreview: () => false, hasFrameRepairs: () => false,
      convertFromCurrentSource: async () => { conversions.push({ source: state.conversionSourceImageData }); return state.conversionSourceImageData; },
      applyProcessedImageToState: processed => { state.processedImageData = processed; },
      maybeAutoWhiteBalance: () => { target.autoMeasurements++; },
      maybeAnalyzeExpiredRescue: () => {},
      goToStep: step => { state.currentStep = step; },
      aiRepair: { status: 'ready', revision: 1 }, autoMeasurements: 0
    });
  }
  vm.runInContext([...FUNCTIONS, ...(realProcessNegative ? ['processNegative'] : [])].map(functionSource).join('\n'), context);
  const jobs = () => pool.counters.jobs;
  return { context, state, pool, displayed, conversions, target, jobs };
}
