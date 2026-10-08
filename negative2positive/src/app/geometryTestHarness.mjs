// Test-only harness for the geometry chain state of main.js (#244): runs the
// real functions in a vm with the real geometry core and pool. UI helpers
// that are not listed fall back to no-ops. Never imported by the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';
import { step3FrameReference } from './displayCanvas.js';

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
const displayProxy = await import('./displayProxy.js');
const displayPreview = await import('./displayPreview.js');
const analysisRegion = await import('./analysisRegion.js');
const { DISPLAY_SESSION_HELPERS, displaySessionDiagnosticsStub, emptyDisplayProxySpill } = await import('./displaySessionHarness.mjs');

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
  'installedGeometryKey', 'workingGeometryKey', 'geometryOutOfStep', 'rollBackFailedGeometry',
  'hasExactPlane16', 'isGeometryFrame', 'takeAdoptedRotation', 'createGeometryFrame',
  'materializeGeometryFrame', 'geometryPlanFor', 'renderGeometryFrame', 'buildGeometryPlanes',
  'installGeometryPlanes', 'holdGeometryBusy', 'releaseGeometryBusy', 'endGeometryJob', 'cancelGeometryJob',
  'whenGeometrySettled', 'noteGeometryPixelRead', 'startGeometryJob', 'applyGeometryFromBase', 'afterGeometry',
  'renderFrameSample', 'geometryFramePixels', 'interimGeometryCss', 'showInterimGeometryDisplay',
  'clearInterimGeometryDisplay', 'settleInterimGeometryDisplay', 'mapDraftRectToFrame',
  'storedRotationDelta', 'applyRotation', 'convertAfterGeometryEdit', 'rebuildGeometryFromBase', 'applyMirror',
  'mapCropRegionAfterRotation', 'sanitizeCropRegionForImage', 'restoreSettings', 'offerAutoFrameRotation',
  'isCurrentLoad', 'applyZoomPanTransform', 'resetZoomPan', 'captureSnapshot', 'restoreSnapshot',
  'restoreColdSnapshotPixels', 'liveHistoryRoots', 'hotGeometrySnapshot', 'historyExclusiveBytes',
  'pushHistoryEntry', 'pruneHistoryForMemory', 'trimHistorySnapshot', 'commitUndoSnapshot', 'pushUndo', 'performUndo', 'performRedo',
  'rememberPhotoSession', 'rememberUnsettledDisplaySession', 'releaseOutgoingPhotoPlanes', 'photoSettingsKey', 'switchToFile',
  'reactivateReleasedPhoto', 'resumeDeferredPhotoReactivation', 'reopenLivePhoto', 'invalidatePhotoActivation', 'getCropDraftTotalAngle', 'scaleCropRect',
  'interactiveGeometryBands',
  // Apply Crop's pending crop-area detection (#245).
  'getCropDraftSize', 'hasPendingCropDetection', 'noteConversionStarted', 'cancelCropDetection', 'sameCropRect',
  'isCurrentCropDetection', 'settlePendingCropDetection', 'startCropDetection', 'detectCropArea',
  'applyCropDetectionOutcome', 'appliedCropDiagnostics', 'cropAreaDetecting', 'cropWhiteBalanceFor', 'cropMeasurementInputs', 'cropMeasurementInputsMatch', 'recordProvisionalFrameEdit', 'provisionalUnits',
  // Display-resolution sessions (#249).
  ...DISPLAY_SESSION_HELPERS, 'applyGeometryWithoutBase', 'decodeRouteOf', 'describeBase', 'analysisAreaOf',
  'liveDisplayProxyKey', 'conversionTargetFor', 'autoWbSampleFor', 'displaySessionEligible', 'coldHistory', 'displayStandIns',
  'captureDisplaySession', 'tierASession', 'demoteDisplaySession', 'holdPreparingOriginal', 'ensureBase',
  'ensureSource', 'prepareOriginalForTool', 'displayProxyMatches', 'requestSourceForDisplay',
  'selfCheckDisplayProxy', 'spillDisplaySession', 'displaySessionMeta', 'forgetDisplayProxies',
  'readSpilledDisplaySession', 'spilledDisplayEntry', 'activateDisplaySession', 'getColorAnalysisSample',
  'colorAnalysisSampleMissing', 'ensureColorAnalysisSample', 'analysisSamplesFor', 'sameAnalysisSample',
  'sameDescriptorSamples', 'displaySessionMismatch',
  'hasSeparateConversionPreview', 'displayProxyShape', 'displayProxyFillPlan', 'storedDisplayProxyKept', 'fillDisplayProxy', 'readStoredDisplaySession',
  'expectedStoredProxyKey', 'persistDisplayProxy', 'displayProxyFileKeyFor', 'persistPresentationPreview',
  'presentStoredPreview', 'encodePresentationJpeg',
  // #278: the lens part of a proxy's key (null unless a test resolves a lens).
  'lensSignature', 'lensSignatureOf', 'lensRemapFor', 'lensRemapFailed', 'lensCorrectionMaps', 'storableDisplayLevel'
];

// The Apply Crop click handler, as a named function.
export function applyCropHandlerSource() {
  const marker = "    applyCropBtn.addEventListener('click', async () => {";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'Apply Crop handler exists');
  const end = source.indexOf('\n    });', start);
  return 'var applyCropHandler = ' + source.slice(start + marker.length - 'async () => {'.length, end) + '\n    };';
}

export function createHarness(base, { historyBudget = 768 * 1024 * 1024, sessionBudget = 768 * 1024 * 1024, workers = null, realProcessNegative = false, displayLevels = false, conversionRequests = false } = {}) {
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
    geometryDiagnostics: { pendingReads: 0, frameSyncReads: 0, adoptedRotations: 0, workerRotations: 0, mainRotations: 0, coldRestores: 0, rollbacks: 0, coldSessions: false },
    undoStack: [], redoStack: [], MAX_UNDO: 30, HISTORY_MEMORY_BUDGET_BYTES: historyBudget,
    processNegativeInFlight: null, coreReprocessTimer: null, coreReprocessToken: 0, coreReprocessGeneration: 0,
    studioAutoFrameRunning: false, singleExportActive: false, pendingPhotoReactivation: null, studioThumbnailUpdateFrame: 0, expiredAnalysisKey: null,
    cropDetection: null, cropDetectionStats: { started: 0, hits: 0, misses: 0, stale: 0, reconversions: 0, conversions: 0 },
    lensMapCache: new Map(), canvas: { style: {} }, glCanvas: { style: {} },
    dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false, fullUpdateTimer: null, fullResolutionRenderTimer: null,
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
    // The messages shown to the user (a failed geometry build, R1-065).
    toasts: [], showToast: message => { target.toasts.push(message); },
    displayNegative: image => { displayed.push(image); context.settleInterimGeometryDisplay(); },
    // The real conversion waits for geometry the same way.
    processNegative: async (options = {}) => {
      await context.whenGeometrySettled();
      conversions.push({ source: state.croppedImageData || state.originalImageData, options });
      state.processedImageData = state.croppedImageData || state.originalImageData;
      state.currentStep = 3;
    },
    invalidateProcessedPipelineState: () => {
      for (const key of ['processedImageData', 'displayImageData', 'conversionSourceImageData', 'conversionPreviewImageData',
        'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData', 'autoWbSample']) state[key] = null;
      // A Tier B session keeps its display level (#249), as main.js does.
      if (!state.sourcePending) state.displayLevelImageData = null;
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
    // #249: display-resolution sessions. Nothing spills unless a test gives
    // a spill; decodes come from `target.decodeBase` (a lane's shared decode).
    ensureSourcePromise: null, preparingOriginal: 0, displaySourceRequest: null,
    displaySessionDiagnostics: displaySessionDiagnosticsStub(), displayProxySpill: emptyDisplayProxySpill(),
    // No persistent store unless a test gives one (part 3).
    displayProxyStore: null, displayProxyFileKeys: new WeakMap(), DISPLAY_PROXY_HASHES: { decoder: 'wasm', code: 'code' },
    colorAnalysisSamples: new WeakMap(), colorAnalysisSampleMisses: new WeakSet(), autoWbFromRecords: new WeakSet(),
    // #278: the lens each corrected source and each display level carries.
    lensCorrectedSources: new WeakMap(), displayLevelLenses: new WeakMap(), lensRemapFailures: new Map(),
    displayProxyKey: displayProxy.displayProxyKey,
    displayPlaneHash: displayProxy.displayPlaneHash, checksum32: displayProxy.checksum32,
    displayPreviewSize: displayPreview.displayPreviewSize, resizeDisplayPreview: displayPreview.resizeDisplayPreview,
    // The display level (#248): the proxy of a display session.
    displayLevelGeometry: displayPreview.displayLevelGeometry, adoptDisplayLevel: displayPreview.adoptDisplayLevel,
    displayLevelFactor: displayPreview.displayLevelFactor, displayTargetFor: displayPreview.displayTargetFor,
    buildDisplayLevelInBands: displayPreview.buildDisplayLevelInBands, buildDisplayLevel: displayPreview.buildDisplayLevel,
    isDisplayTarget: displayPreview.isDisplayTarget, displaySizeServes: displayPreview.displaySizeServes,
    previewTier: 'normal', previewTierMaxPixels: () => 4_000_000, webglState: {},
    // main.js's getDisplayPreviewSize over the fixture's container.
    getDisplayPreviewSize: (image, maxDimension = 8192, tier = target.previewTier) => {
      const container = target.getCanvasContainerSize();
      return displayPreview.displayPreviewSize(image.width, image.height, {
        viewportWidth: container.width - 20 || 1280, viewportHeight: container.height - 20 || 900,
        dpr: target.window.devicePixelRatio || 1, zoom: 1, maxPixels: target.previewTierMaxPixels(tier), maxDimension
      });
    },
    getCanvasContainerSize: () => ({ width: 1280, height: 920 }), window: { devicePixelRatio: 2 },
    lensCorrectionActive: () => false, isRawLikeFileName: name => /\.(dng|nef|cr2|arw|rw2)$/.test(name),
    usesSilverCoreConversion: () => true, hasFrameRepairs: () => false, isAiBrushEnabled: () => false,
    requiresFilmBase: () => true, isLargeImage: image => Number(image?.width) * Number(image?.height) > target.largeImagePixels,
    largeImagePixels: 16_000_000, photoActivation: null, parkedPhoto: null, parkingPhoto: false,
    // The frame the Step-3 display stands for (displayCanvas.js).
    step3FrameReference,
    // A memory claim (#258) that records how it was taken and released.
    createFrameClaim: (file, options = {}) => {
      const claim = { file, priority: options.priority, label: options.label, released: false, release() { claim.released = true; }, atDecode: async () => {} };
      (target.frameClaims ||= []).push(claim);
      return claim;
    },
    sharedDecodes: {
      adopt: () => null,
      open: (file, options = {}) => {
        target.decodeOpens = [...(target.decodeOpens || []), { file, context: options.context || null }];
        const result = Promise.resolve(target.decodeBase ? target.decodeBase() : null).then(base => {
          target.baseDecodes = (target.baseDecodes || 0) + 1;
          return { base, rawMetadata: null };
        });
        return { result, release() {} };
      }
    },
    applyLensCorrectionWithSettings: async source => source,
    sampleAnalysisArea: analysisRegion.sampleAnalysisArea,
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
      // #248: small frames are their own display level and conversion preview.
      buildDisplayLevelInBands: async source => source, displayLevelFactor: () => 1, conversionTargetFor: source => source,
      usesSilverCoreConversion: () => false, hasSeparateConversionPreview: () => false, hasFrameRepairs: () => false,
      convertFromCurrentSource: async () => { conversions.push({ source: state.conversionSourceImageData }); return state.conversionSourceImageData; },
      applyProcessedImageToState: processed => { state.processedImageData = processed; },
      maybeAutoWhiteBalance: () => { target.autoMeasurements++; },
      maybeAnalyzeExpiredRescue: () => {},
      goToStep: step => { state.currentStep = step; },
      aiRepair: { status: 'ready', revision: 1 }, autoMeasurements: 0
    });
  }
  // The #248 stubs above make small frames their own level and preview; the
  // display-session tests (#249) keep the real levels and targets instead.
  const levelStubs = realProcessNegative && !displayLevels
    ? { conversionTargetFor: target.conversionTargetFor, hasSeparateConversionPreview: target.hasSeparateConversionPreview } : null;
  if (realProcessNegative && displayLevels) {
    Object.assign(target, {
      buildDisplayLevelInBands: displayPreview.buildDisplayLevelInBands, displayLevelFactor: displayPreview.displayLevelFactor,
      getDisplayPreviewSize: target.getDisplayPreviewSize,
      releaseBeforeAfterCanvas: () => {}, refreshCanvasContainerSize: () => {}
    });
  }
  // `conversionRequests`: the real request convertFromCurrentSource builds
  // (#249: the colour-analysis sample it carries), recorded in `requests` by
  // the worker clients, which answer with a copy of the image they were sent.
  const requests = [];
  if (conversionRequests) {
    delete target.convertFromCurrentSource;
    const answer = request => {
      requests.push(request);
      const size = request.display ? request.display.target : request.imageData;
      return makeBase(size.width, size.height, 7);
    };
    Object.assign(target, {
      buildRouterSettings: settings => ({ autoFrameMeta: settings === state ? state.autoFrame.lastDiagnostics : settings.autoFrameMeta }),
      HISTOGRAM_MAX_SAMPLES: 1,
      convertPreviewFrameInWorker: async request => answer(request),
      convertFrameOffMainThread: async request => answer(request)
    });
  }
  vm.runInContext([...FUNCTIONS, ...(realProcessNegative ? ['processNegative'] : []),
    ...(conversionRequests ? ['convertFromCurrentSource', 'previewRequestImage'] : [])].map(functionSource).join('\n'), context);
  if (levelStubs) Object.assign(target, levelStubs);
  const jobs = () => pool.counters.jobs;
  return { context, state, pool, displayed, conversions, target, jobs, requests };
}
