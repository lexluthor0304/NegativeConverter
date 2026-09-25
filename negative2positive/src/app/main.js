import { applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, ROLL_MONOCHROME } from './rollFilmType.js';
import { createPhotoSessionCache, backingBuffers } from './photoSessionCache.js';
import { createAdjustedPhotoPreview, samplePhotoPreviewSource, adjustPhotoPreviewSample } from './photoPreview.js';
import { exactSettingsKey } from './settingsKey.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { analyzeSemanticPreview } from './semanticModel.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { defaultInferencePreference } from './inferenceBackend.js';
import { readDesktopImportFile } from './desktopImportReader.js';
import { learnedDefaultsKey, learnedDelta, recordLearnedObservation, applyLearnedDefaults, withoutLearnedDefaults, LEARNED_NUMERIC_KEYS, LEARNED_CATEGORY_KEYS } from './learnedDefaults.js';
import { readLearnedDefaults, writeLearnedDefaults, resetLearnedDefaults } from './learnedDefaultsStore.js';
import { exportNameStem } from './exportFileName.js';
import { frameNeedsReview } from './reviewQueue.js';
import { yieldForJob, yieldToPaint, yieldTaskForJob } from './yieldToPaint.js';
import { createHiddenJobGate, hiddenJobLimitsApply, estimateHiddenJobBytes } from './hiddenJobGate.js';
import { createJobMarker, readJobMarkers, clearJobMarker, matchJobFiles, planResumedExport, resumedJobMarker, jobNeedsSafeMode } from './jobMarker.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import { createEmbeddedPreviewPool } from './scanDecodeClient.js';
import { isTiffContainerRawName } from './rawEmbeddedPreview.js';
import { renderEmbeddedPreview, createDocumentPreviewEnv } from './embeddedPreviewRender.js';
import { canPublishThumbnail } from './thumbnailRank.js';
    import { detectedImportSettings } from './filmTypeDetection.js';
    import { createAiModelLoader } from './aiModelLoading.js';
    import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
    import { i18n } from './i18n.js';
    import { interpolateText, summarizePathForUi } from './textUtils.js';
    import { computeSpline, buildCurveLut, getCurvePresetPoints, insertCurvePoint, moveCurvePoint, findNearPointIndex } from './curveMath.js';
    import { deepCopySanitizedSettings } from './settingsSnapshot.js';
    import { computeZoomGeometry, clampPanValues } from './zoomGeometry.js';
    import { showToast } from '../ui/toast.js';
    import { writeDesktopBlob } from './desktopExportWriter.js';
    import { normalizeAngleDegrees, applyRotationToImageData, mirrorImageDataHorizontal, applyGeometryChainToImageData, rotatedDimensions, sanitizeCropRect, planGeometry, renderGeometry, geometryCounters } from './imageGeometry.js';
    import { createGeometryPool, yieldToEventLoop } from './geometryPool.js';
    import { analyzeFrameInWorker, readFilmEdgeInWorker, createAutoFrameWorkerPool, warmUpAutoFrameWorker } from './autoFrameWorkerClient.js';
    import { detectFrameWithFallback } from './autoFrameExecution.js';
    import { importConversionKey } from './importDetection.js';
    import { createAnalysisSampleStore } from './analysisSampleStore.js';
    import { mountStudioWorkspace } from './studioWorkspace.js';
    import { AUTO_FRAME_FORMAT_RATIOS, AUTO_FRAME_DEFAULT_120_FORMATS, canAutoApplyImportFrame } from './autoFrameFormats.js';
    import { DEFAULT_CROP_RATIO_CHOICE, findCropRatioPreset, parseCropRatioChoice, serializeCropRatioChoice, fitRectToRatio, resizeRectWithRatio, drawRectWithRatio, preferredCropOrientation, flipOrientation } from './cropRatio.js';
    import { imageAreaFromDetection, resolveAnalysisRegion, analysisPixelBounds, imageAreaFromWorkingRect, sampleAnalysisArea } from './analysisRegion.js';
    import { detectCropImageArea, workingPointsToBase, isSameAnalysisFrame } from './cropColorAnalysis.js';
    import { pickStudioColors, mergeStudioColors, createStudioThumbnail } from './studioSettings.js';
    import {
      analyzeExpiredFilm, defaultExpiredRescueParams, sanitizeExpiredRescueParams, sanitizeExpiredAnalysis,
      describeExpiredAnalysis, fitExpiredSpatial, buildExpiredSpatialStage, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS
    } from '../pipeline/expiredRescue.js';
    import { measureExpiredSpatialMaps } from './expiredRescueOpenCv.js';
    import { readFilmEdge, sanitizeFilmEdgeForSettings, formatFilmEdgeFrames } from './filmEdgeReader.js';
    import { loadDxFilmTable, describeDxFilm, shortFilmName } from './dxFilmDatabase.js';
    import { groupAutomaticRollFrames, aggregateRollAnalysis, measureNegativeMean, sanitizeRollFrameForSettings, rollFrameExposureUnits } from './rollAnalysis.js';
    import { filtrationFromSliders, slidersFromFiltration, stopsFromExposureUnits, exposureUnitsFromStops, contrastForGradeValue, gradeValueForContrast, gradeLabelForValue, TEST_STRIP_AXES, formatAxisValue, testStripValues } from './enlarger.js';
    import { sanitizeLocalExposureForSettings, workingPointToBase, basePointToWorking } from './localExposure.js';
    import { sanitizeRepairStrokes, buildRepairMask, pointerToRepairPoint, lensSourcePoint } from './repairBrush.js';
    import { createRepairStamps, sameRepairStrokes, captureDustPass, dustPassMatches, restoreDustPass } from './repairReuse.js';
    import { paperProfiles, paperIdsForFilmKind, normalizePaperId, normalizeToningId } from '../silvercore/engine/PaperProfiles.js';
    import { buildFlatFieldMap, scoreBlankFrame } from './flatField.js';
    import { estimateAlignment, warpImageData } from './imageAlignment.js';
    import { collectPairs, fitLook, sanitizeLookForSettings } from './labMatch.js';
    import { toImage16 } from './multiShot.js';
    import { createMultiShotMergeJob, createMultiShotProgress, multiShotFitsBudget } from './multiShotWorkerClient.js';
    import { MultiShotError, describeMultiShotError } from './multiShotErrors.js';
    import { sanitizeRollMetadata, sanitizeFrameMetadata, buildExportMetadata, frameNumberFor } from './analogMetadata.js';
    import { attachMetadataToBlob } from './exportMetadata.js';
    import { buildRollProject, serializeRollProject, parseRollProject, matchProjectFiles, hashFileForProject, projectFileName, isProjectFileName, saveProjectRecovery, loadProjectRecovery, clearProjectRecovery } from './rollProject.js';
    import { encodeRecipe, decodeRecipe, recipeDiff, describeRecipeChange, RECIPE_KEYS } from './recipes.js';
    import qrcode from 'qrcode-generator';
    import { layoutContactSheet, pagesFor, renderContactSheetPage, contactSheetHeader, normalizeLayoutId, normalizePageId } from './contactSheet.js';

    import { convertFrameWithRouter, resolveConversionMode } from '../pipeline/conversionRouter.js';
    import { convertFrameInWorker, convertPreviewFrameInWorker, createConversionWorkerPool, CONVERSION_FAILED, WORKER_TIMEOUT, isConversionInputLost } from './conversionWorkerClient.js';
    import { planBatchParallelism, planPng16BandWorkers, runBatchPipeline, planGeometryBandsInFlight } from './batchExportScheduler.js';
    import { displayPreviewSize, resizeDisplayPreview, updateDisplayPreviewRect } from './displayPreview.js';
    import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
    import { createPreviewTierController, previewTierMaxPixels, capBackingSize, parsePreviewTierOverride } from './previewTier.js';
    import { describeWebglRenderer, startsReducedReason, formatRenderEnvironmentLine, formatPreviewSessionLine } from './renderEnvironment.js';
    import { invalidateSilverCoreCache, analyzeSilverCoreFrame } from '../pipeline/silverAdapter.js';
    import { canUseBrowserZipStreaming, ZipStoreWriter, createZipNameDeduper } from './zipStoreWriter.js';
    import {
      createAdjustmentLutScratch,
      stripLegacyToneSettingsForSilverCore,
      applyPreparedAdjustmentsToBuffer,
      applyPreparedAdjustmentsToBuffer16,
      applyPreparedAdjustmentsToPlane16,
      areAdjustmentsIdentity
    } from './adjustmentPipeline.js';
    import { gainMapInputsMatch, requestExportGainMap } from './exportGainMap.js';
    import { buildLinearPositive, buildLinearPositiveAsync, encodeLinearDngBlob } from './linearDng.js';
    import { inpaintWithModel, fetchModelBytes, inpaintBackends, DEFAULT_MODEL_URL, TILE as AI_TILE, CONTEXT as AI_CONTEXT } from './aiInpaint.js';
    import { createInpaintSessionInWorker } from './aiInpaintWorkerClient.js';
    import {
      downsampleImageDataForMaxPixels,
      downsampleImageDataForMaxDim,
      cropImageDataRegion
    } from './imageDataOps.js';
    import {
      createImageDataCanvasBlobEncoder
    } from './canvasBlobEncoder.js';
    import {
      DEFAULT_SPROCKET_EDGE_MARKINGS,
      composeSprocketFrame,
      composeSprocketFrameBackground,
      areSprocketFrameFontsReady,
      ensureSprocketFrameFonts,
      getSprocketFrameMetrics,
      normalizeSprocketEdgeMarkings
    } from './sprocketFrame.js';
    import { renderFileList } from './fileListView.js';
    import { normalizeFileListSort, orderedFileIndices, selectionRangeIndices } from './fileListOrder.js';
    import { createSprocketFrameCache } from './sprocketFrameCache.js';
    import { imagePixelsForBatch, rememberImageDimensions } from './imageDimensions.js';
    import {
      createDustWorkerClient, detectDustInWorker, inpaintDustInWorker, strokeDustInWorker, followDustMaskInWorker,
      pinDustWorker, unpinDustWorker, disposeDustWorker, dustMaskInfo, forgetDustMaskInfo
    } from './dustWorkerClient.js';
    import { applyStrokePatch, applyDustDelta, amendDustDelta, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';
    import { loadLocalLensfunAssets } from './lensfunLoader.js';
    import { createOpenCvLoader } from './opencvLoader.js';
    import {
      sampleFilmBase as sampleFilmBaseRobust,
      sanitizeFilmBaseForSettings
    } from './filmBaseDetection.js';
    import { cachedAutoDetectFilmBase, cachedDetectFilmType } from './filmStatsCache.js';
    import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
    import {
      isRawLikeFileName,
      isPngFile,
      loadPngImageData,
      loadRawImageData,
      loadRawImageDataPreview,
      loadStandardImage
    } from './imageFileLoaders.js';
    import { Histogram } from '../silvercore/ui/Histogram.js';
    import { loadFilmPresets } from '../silvercore/engine/filmPresetsLoader.js';
    import { detectDust, updateDustStrength, inpaintMasked } from '../silvercore/engine/DustRemoval.js';
    import { applyDustStroke } from '../silvercore/engine/DustBrush.js';
    import { getLoadingOverlay } from '../ui/LoadingOverlay.js';
    import { createPerfTraceFactory, readPerfFlags } from './perfTrace.js';
    import {
      workerApplyAdjustments,
      workerApplyAdjustments16,
      workerGainMap16,
      workerAdjust16AndEncode,
      workerEncodeImage,
      workerEncodePng16,
      workerEncodeTiff,
      isWorkerAvailable,
      isExportInputLostError,
      isAbortError,
      createExportWorkerBridge,
      createExportWorkerPool,
      createPng16BandPool,
      terminateWorker as terminateExportWorker,
      exportWorkerPendingCount,
      isExportWorkerAlive
    } from '../workers/workerBridge.js';
    import {
      markOwnedPlanes,
      markLiveMutableBuffer,
      planeBuffersOf,
      releaseOwnedPlanes,
      setLiveReferenceProbe
    } from './planeRelease.js';
    import { registerEvictablePlane } from './evictablePlanes.js';

    const DEBUG_UI = new URLSearchParams(window.location.search).get('debug') === '1';
    const WEBGL_DEBUG_ERRORS = new URLSearchParams(window.location.search).has('debugGL');
    // ?perf=1 (benchmark harness) also records every trace as User Timing.
    const { createPerfTrace, recordStages: recordPerfStages } = createPerfTraceFactory({
      debug: DEBUG_UI,
      userTiming: readPerfFlags(window.location.search).userTiming
    });
    // The default export bridge, for the callers without an operation of their
    // own (contact sheet, multi-shot merge, watch folder). A single export
    // makes its own bridge and a batch export its own pool (#250); both pass
    // it through `bridge`.
    const defaultExportWorkers = { workerApplyAdjustments, workerApplyAdjustments16, workerGainMap16, workerAdjust16AndEncode, workerEncodeImage, workerEncodePng16, workerEncodeTiff, isWorkerAvailable };
    // 暗室 UI に一本化。古い workspace パラメーターで別画面へ分岐しない。
    let studioAutoFrameRunning = false;
    let studioWorkspace = null;
    // Full-resolution renders run in a worker and no longer block interactive
    // preview reprocessing, so they can start soon after the user pauses; a
    // render made stale by further input is discarded and rescheduled.
    const FULL_RESOLUTION_IDLE_DELAY_MS = 2500;
    const FULL_RESOLUTION_INTERACTIVE_DELAY_MS = 600; // after a slider commit / stale retry

    function getImageDataPixelCount(imageData) {
      return imageData ? imageData.width * imageData.height : 0;
    }


    // Vite substitutes this at build time; the hard-coded string it replaced had
    // been stale for months and was shown in the debug badge and the diagnostics
    // dump as if it identified the running build.
    const BUILD_ID = (typeof __BUILD_ID__ === 'string' && __BUILD_ID__) || 'dev';
    const ensureOpenCvReady = createOpenCvLoader([opencvScriptUrl]);
    const AUTO_FRAME_MAX_SIDE = 1600;
    const AUTO_FRAME_SCORE_WEIGHTS = {
      area: 0.18,
      rectangularity: 0.20,
      orthogonality: 0.14,
      parallelism: 0.10,
      edgeSupport: 0.18,
      centerPrior: 0.08,
      aspect: 0.12
    };
    // Must stay in step with PROFILES in silvercore/engine/EnhancedProfiles.js.
    // 'noritsu' was missing here, so the shipped noritsu.bin and the profile the
    // "Noritsu Lab" film preset asks for were sanitised away to 'none'.
    const CORE_ENHANCED_PROFILE_OPTIONS = new Set(['none', 'frontier', 'crystal', 'natural', 'pakon', 'noritsu']);
    const CORE_COLOR_MODEL_OPTIONS = new Set(['frontier', 'standard', 'warm', 'mono', 'noritsu', 'cine-log', 'cine-rich', 'cine-flat', 'neutral']);
    const CORE_COLOR_MODEL_MIGRATION_MAP = Object.freeze({});
    const SPROCKET_EDGE_CONTROL_IDS = Object.freeze({
      textEnabled: 'sprocketTextEnabledInput',
      frameNumberEnabled: 'sprocketFrameNumberEnabledInput',
      dxEnabled: 'sprocketDxEnabledInput',
      halfFrameMarksEnabled: 'sprocketHalfFrameMarksEnabledInput',
      overexposedSprockets: 'sprocketOverexposureEnabledInput',
      text: 'sprocketTextInput',
      frameNumber: 'sprocketFrameNumberInput',
      frameNumberHole: 'sprocketFrameNumberHoleInput',
      firstHoleOffsetMm: 'sprocketFirstHoleOffsetInput',
      dx1: 'sprocketDx1Input',
      dx2: 'sprocketDx2Input',
      overexposureStrength: 'sprocketOverexposureStrengthInput',
      fontStyle: 'sprocketFontStyleSelect',
      fontFamily: 'sprocketFontFamilyInput',
      holeColor: 'sprocketHoleColorInput',
      letteringColor: 'sprocketLetteringColorInput',
      overexposureColor: 'sprocketGlowColorInput'
    });
    const DESKTOP_UPDATE_LAST_CHECK_TS_KEY = 'nc_desktop_update_last_check_ts';
    const DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY = 'nc_desktop_update_last_seen_latest';
    const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const DESKTOP_UPDATE_FETCH_TIMEOUT_MS = 5000;
    const DESKTOP_UPDATE_MANIFEST_URLS = [
      'https://download.neoanaloglab.com/negative-converter/release/latest.json',
      'https://negative-converter.tokugai.com/negative-converter/release/latest.json'
    ];
    const DESKTOP_UPDATE_PAGE_URL = 'https://negative-converter.tokugai.com/download.html';
    const LENSFUN_PACKAGE_VERSION = '0.1.3';
    const LENSFUN_CDN_BASE = `https://cdn.jsdelivr.net/npm/@neoanaloglabkk/lensfun-wasm@${LENSFUN_PACKAGE_VERSION}/dist`;
    const lensScriptLoadPromises = new Map();
    const lensMapCache = new Map();
    const lensfunRuntime = {
      initPromise: null,
      client: null,
      source: null,
      searchFlags: 2,
      lastError: ''
    };

    function rgbaToHex(color, fallback = '#ffffff') {
      if (!Array.isArray(color) && !ArrayBuffer.isView(color)) return fallback;
      const toHex = (value) => {
        const n = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
        return n.toString(16).padStart(2, '0');
      };
      return `#${toHex(color[0])}${toHex(color[1])}${toHex(color[2])}`;
    }

    function createSprocketEdgeSettings(input = {}) {
      const normalized = normalizeSprocketEdgeMarkings({
        ...DEFAULT_SPROCKET_EDGE_MARKINGS,
        ...input
      });
      return {
        textEnabled: normalized.textEnabled,
        text: normalized.text,
        frameNumberEnabled: normalized.frameNumberEnabled,
        frameNumber: normalized.frameNumber,
        frameNumberHole: normalized.frameNumberHole,
        firstHoleOffsetMm: normalized.firstHoleOffsetMm,
        dxEnabled: normalized.dxEnabled,
        dx1: normalized.dx1,
        dx2: normalized.dx2,
        halfFrameMarksEnabled: normalized.halfFrameMarksEnabled,
        overexposedSprockets: normalized.overexposedSprockets,
        overexposureStrength: normalized.overexposureStrength,
        fontStyle: normalized.fontStyle,
        fontFamily: normalized.fontFamily,
        holeColor: rgbaToHex(normalized.holeColor, DEFAULT_SPROCKET_EDGE_MARKINGS.holeColor),
        letteringColor: rgbaToHex(normalized.letteringColor, DEFAULT_SPROCKET_EDGE_MARKINGS.letteringColor),
        overexposureColor: rgbaToHex(normalized.overexposureColor, DEFAULT_SPROCKET_EDGE_MARKINGS.overexposureColor)
      };
    }

    let currentLang = 'en';
    let stateReady = false;
    // Expired-film rescue session flags (see the "Expired film rescue" block).
    let expiredCompareHeld = false;
    let expiredTabPending = false;
    let expiredAnalysisKey = null;
    let singleExportActive = false;
    const desktopBatchExportState = {
      active: false,
      current: 0,
      total: 0,
      percent: 0,
      fileName: '',
      targetDirectory: ''
    };
    // The open photo while it is parked in a hidden window (#241 part 2e).
    let parkedPhoto = null;
    // Every long job asks this gate before an item starts, so a hidden macOS
    // window stays under WebKit's inactive memory limit (#241; the callbacks
    // live under "Hidden-window jobs" below).
    const hiddenJobs = createHiddenJobGate({
      isHidden: () => document.visibilityState === 'hidden',
      limitsApply: () => hiddenJobLimitsForced() || hiddenJobLimitsApply(),
      residentBytes: () => hiddenResidentBytes(),
      onChange: () => {
        refreshHiddenJobStatus();
        if (hiddenJobs.paused) onHiddenJobPaused();
      },
      onHiddenAdmit: () => shedHiddenJobMemory(),
      onGraceExpired: () => shedHiddenJobMemory(),
      // A job that ends while hidden leaves nothing idle behind.
      onIdle: () => shedHiddenJobMemory()
    });
    const desktopUpdateState = {
      visible: false,
      currentVersion: '',
      latestVersion: '',
      // From get_desktop_update_capability: whether this build may replace itself.
      capability: null,
      installing: false
    };

    // --- In-app modal dialogs -------------------------------------------
    // window.alert() and window.confirm() are silently ignored inside the
    // macOS desktop build: WKWebView only shows JavaScript dialogs when the
    // host app implements the WKUIDelegate panels, and the Tauri runtime here
    // registers none. An unimplemented alert panel behaves as if OK were
    // pressed (nothing is shown) and an unimplemented confirm panel returns
    // false, so export failures were invisible and the auto-frame prompt
    // always answered "Cancel". These render in the page instead, which
    // behaves identically on every platform.
    let appDialogState = null;
    const appDialogQueue = [];

    function dismissAppDialog(result) {
      if (!appDialogState) return;
      const { overlay, resolve, onKeydown, previousFocus } = appDialogState;
      appDialogState = null;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try {
          previousFocus.focus();
        } catch (err) {
          // The element may have been removed while the dialog was open.
        }
      }
      resolve(result);
      presentNextAppDialog();
    }

    function presentNextAppDialog() {
      if (appDialogState) return;
      const next = appDialogQueue.shift();
      if (!next) return;
      const { message, showCancel, resolve } = next;

      const overlay = document.createElement('div');
      overlay.className = 'app-dialog-overlay';
      overlay.dataset.appDialog = 'true';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10000', 'display:flex',
        'align-items:center', 'justify-content:center', 'padding:24px',
        'background:rgba(8,6,20,0.72)'
      ].join(';');

      const panel = document.createElement('div');
      panel.setAttribute('role', showCancel ? 'alertdialog' : 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.style.cssText = [
        'max-width:min(460px,100%)', 'width:100%',
        'background:var(--surface,#1a1430)',
        'border:1px solid var(--border,#3d2f6b)', 'border-radius:10px',
        'padding:20px', 'box-shadow:0 18px 48px rgba(0,0,0,0.55)',
        'color:var(--text,#eee)'
      ].join(';');

      const text = document.createElement('p');
      text.dataset.appDialogMessage = 'true';
      text.textContent = String(message == null ? '' : message);
      text.style.cssText = 'margin:0 0 18px;white-space:pre-wrap;line-height:1.5;font-size:14px';
      panel.appendChild(text);
      panel.setAttribute('aria-label', text.textContent);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

      const buttonBase = 'padding:8px 18px;border-radius:6px;font:inherit;font-size:13px;cursor:pointer';
      let cancelBtn = null;
      if (showCancel) {
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.dataset.appDialogCancel = 'true';
        cancelBtn.textContent = getLocalizedText('dialogCancel', 'Cancel');
        cancelBtn.style.cssText = `${buttonBase};background:transparent;color:var(--text-muted,#b0a8c8);border:1px solid var(--border,#3d2f6b)`;
        cancelBtn.addEventListener('click', () => dismissAppDialog(false));
        actions.appendChild(cancelBtn);
      }

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.dataset.appDialogConfirm = 'true';
      confirmBtn.textContent = getLocalizedText('dialogOk', 'OK');
      confirmBtn.style.cssText = `${buttonBase};background:var(--accent,#d63aa0);color:#fff;border:1px solid var(--accent,#d63aa0)`;
      confirmBtn.addEventListener('click', () => dismissAppDialog(true));
      actions.appendChild(confirmBtn);

      panel.appendChild(actions);
      overlay.appendChild(panel);

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          dismissAppDialog(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          dismissAppDialog(true);
        } else if (event.key === 'Tab') {
          // Keep focus inside the dialog.
          const focusable = [cancelBtn, confirmBtn].filter(Boolean);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      appDialogState = { overlay, resolve, onKeydown, previousFocus: document.activeElement };
      document.addEventListener('keydown', onKeydown, true);
      document.body.appendChild(overlay);
      confirmBtn.focus();
    }

    // Dialogs are queued so a burst behaves like the sequential alert() calls
    // these replaced, instead of the last one hiding the rest.
    function openAppDialog(message, { showCancel = false } = {}) {
      return new Promise((resolve) => {
        appDialogQueue.push({ message, showCancel, resolve });
        presentNextAppDialog();
      });
    }

    function appAlert(message) {
      return openAppDialog(message, { showCancel: false });
    }

    function appConfirm(message) {
      return openAppDialog(message, { showCancel: true });
    }

    function getLocalizedText(key, fallback = '') {
      const dict = i18n[currentLang] || i18n.en || {};
      if (Object.prototype.hasOwnProperty.call(dict, key) && dict[key]) {
        return dict[key];
      }
      return fallback;
    }

    function setLanguage(lang) {
      currentLang = lang;
      // Screen readers pick their voice, and browsers pick Han glyph variants,
      // from the document language rather than the text content.
      document.documentElement.lang = lang;
      document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
      });
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (i18n[lang][key]) {
          el.textContent = i18n[lang][key];
        }
      });
      document.querySelectorAll('[data-i18n-label]').forEach(el => {
        const key = el.dataset.i18nLabel;
        if (i18n[lang][key]) {
          el.label = i18n[lang][key];
        }
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        if (i18n[lang][key]) {
          el.placeholder = i18n[lang][key];
        }
      });
      // Tooltips and accessible names are markup-driven too, so they follow the
      // language instead of being frozen at the English fallback.
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        if (i18n[lang][key]) {
          el.title = i18n[lang][key];
        }
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.dataset.i18nAriaLabel;
        if (i18n[lang][key]) {
          el.setAttribute('aria-label', i18n[lang][key]);
        }
      });
      document.title = getLocalizedText('title', document.title || 'Negative Converter');
      const privacyLink = document.getElementById('privacyDetailsLink');
      if (privacyLink) {
        privacyLink.href = `./privacy.html?lang=${encodeURIComponent(lang)}`;
      }
      const offlineLink = document.getElementById('offlineDownloadLink');
      if (offlineLink) {
        offlineLink.href = `./download.html?lang=${encodeURIComponent(lang)}`;
        // The desktop build must not advertise its own web download.
        if (isTauriDesktop()) offlineLink.style.display = 'none';
      }
      updateDesktopUpdateBannerText();
      if (stateReady) {
        updateCurrentFileLabel();
        updateRollReferenceUI();
        updateAutoFrameConfigUI();
        updateAutoFrameDiagnosticsUI();
        updateAutoFrameButtons();
        updateGrayPointGuideUI();
        updateFilmEdgeUI();
        updateRollAnalysisUI();
        updateEnlargerUI();
        updatePaperUI();
        updateDodgeBurnUI();
        updateFlatFieldUI();
        updateLabMatchUI();
        populateTestStripAxes();
        if (typeof updateLensCorrectionUI === 'function') updateLensCorrectionUI();
        if (typeof updateExportUI === 'function') updateExportUI();
        updateDesktopBatchExportUI();
        if (state.sprocketPreviewEnabled) refreshSprocketPreviewAfterSettingsChange();
      }
      studioWorkspace?.sync();
    }

    // Language: an explicit ?lang= wins, then the remembered choice, then the
    // browser default. Anything unknown falls through, because setLanguage
    // indexes i18n[lang] without a guard.
    const LANGUAGE_STORAGE_KEY = 'nc_lang_v1';
    function resolveInitialLanguage() {
      const candidates = [];
      try {
        candidates.push(new URLSearchParams(location.search).get('lang'));
      } catch (err) {
        // location may be unavailable in exotic embeddings; ignore.
      }
      candidates.push(safeStorageGet(LANGUAGE_STORAGE_KEY));
      candidates.push(
        navigator.language.startsWith('ja') ? 'ja'
          : navigator.language.startsWith('zh') ? 'zh' : 'en'
      );
      return candidates.find((lang) => lang && Object.prototype.hasOwnProperty.call(i18n, lang)) || 'en';
    }
    setLanguage(resolveInitialLanguage());

    if (DEBUG_UI) {
      const badge = document.getElementById('buildBadge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `build ${BUILD_ID}`;
      }
    }

    // Language selector
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (!lang || !Object.prototype.hasOwnProperty.call(i18n, lang)) return;
        safeStorageSet(LANGUAGE_STORAGE_KEY, lang);
        setLanguage(lang);
      });
    });

    function safeStorageGet(key) {
      try {
        return localStorage.getItem(key);
      } catch (err) {
        return null;
      }
    }

	    function safeStorageSet(key, value) {
	      try {
	        localStorage.setItem(key, value);
	      } catch (err) {
	        // ignore
	      }
	    }

    function safeSessionStorageGet(key) {
      try {
        return sessionStorage.getItem(key);
      } catch (err) {
        return null;
      }
    }

    function safeSessionStorageSet(key, value) {
      try {
        sessionStorage.setItem(key, value);
      } catch (err) {
        // ignore
      }
    }



    function setSectionCollapsed(section, collapsed) {
      const header = document.querySelector(`.section-header[data-section="${section}"]`);
      const toggle = header ? header.querySelector('.section-toggle') : null;
      const content = document.getElementById(section + 'SectionContent')
        || document.getElementById(section + 'Section');
      if (toggle) toggle.classList.toggle('collapsed', Boolean(collapsed));
      if (content) content.classList.toggle('collapsed', Boolean(collapsed));
    }



    function isGrayPointGuideAvailable() {
      if (!stateReady) return false;
      return state.currentStep >= 3
        && usesSilverCoreConversion(state)
        && sanitizePresetType(state.filmType || 'color') !== 'bw';
    }




    async function applyFilmPresetSettingsToState(presetId) {
      const nextPresetId = String(presetId || 'none');
      state.coreFilmPreset = nextPresetId;
      if (nextPresetId === 'none') {
        syncAllSelectsFromState();
        return false;
      }

      const filmPresets = await loadFilmPresets();
      const preset = filmPresets[nextPresetId];
      if (!preset || !preset.settings) {
        syncAllSelectsFromState();
        return false;
      }

      const s = preset.settings;
      if (s.enhancedProfile) {
        state.coreEnhancedProfile = s.enhancedProfile;
      }
      if (s.saturation !== undefined) {
        state.coreSaturation = s.saturation;
      }
      if (s.glow !== undefined) {
        state.coreGlow = s.glow;
      }
      if (s.fade !== undefined) {
        state.coreFade = s.fade;
      }
      if (s.shadows !== undefined) {
        state.coreShadows = s.shadows;
      }
      if (s.highlights !== undefined) {
        state.coreHighlights = s.highlights;
      }
      if (s.blacks !== undefined) {
        state.coreBlacks = s.blacks;
      }
      if (s.whites !== undefined) {
        state.coreWhites = s.whites;
      }

      syncAllSelectsFromState();
      [
        'coreSaturation',
        'coreGlow',
        'coreFade',
        'coreShadows',
        'coreHighlights',
        'coreBlacks',
        'coreWhites'
      ].forEach(syncSliderFromState);
      return true;
    }

    function updateGrayPointGuideUI() {
      if (!stateReady) return;

      const show = isGrayPointGuideAvailable();
      const isActive = state.samplingMode === 'whiteBalance';
      const headerBtn = document.getElementById('headerGrayPointBtn');
      const sampleBtn = document.getElementById('sampleWBBtn');
      const guideSection = document.getElementById('grayPointGuideSection');
      const guideCard = document.getElementById('grayPointGuideCard');
      const guideTitle = document.getElementById('grayPointGuideTitle');
      const guideBody = document.getElementById('grayPointGuideBody');
      const guideHint = document.getElementById('grayPointGuideHint');

      if (headerBtn) {
        headerBtn.style.display = show ? 'inline-flex' : 'none';
        headerBtn.disabled = !state.processedImageData;
        headerBtn.classList.toggle('active', isActive);
        headerBtn.classList.toggle('done', !isActive && Boolean(state.grayPointSampled));
        const labelKey = isActive
          ? 'grayPointHeaderSampling'
          : (state.grayPointSampled ? 'grayPointHeaderResample' : 'sampleWB');
        headerBtn.textContent = getLocalizedText(labelKey, getLocalizedText('sampleWB', 'Sample Gray Point'));
      }

      if (sampleBtn) {
        sampleBtn.style.display = show ? 'inline-flex' : 'none';
        sampleBtn.classList.toggle('active', isActive);
      }

      if (guideSection) {
        guideSection.style.display = show ? 'block' : 'none';
      }
      if (!show) return;

      // Three resting states: auto WB applied (calm, info tone), manual sample
      // done, or the default nudge toward clicking a gray point. The active
      // sampling state overrides all of them.
      const autoApplied = !state.grayPointSampled && ['high', 'medium'].includes(state.wbAutoConfidence);
      if (guideCard) {
        guideCard.classList.toggle('is-active', isActive);
        guideCard.classList.toggle('is-auto', !isActive && autoApplied);
      }
      const stateKey = (suffix, fallbackKey) => {
        if (isActive) return `grayPointGuideActive${suffix}`;
        if (autoApplied) return `grayPointGuideAuto${suffix}`;
        return fallbackKey;
      };
      if (guideTitle) {
        guideTitle.textContent = getLocalizedText(
          stateKey('Title', 'grayPointGuideTitle'),
          'Find a neutral gray point'
        );
      }
      if (guideBody) {
        guideBody.textContent = getLocalizedText(
          stateKey('Body', 'grayPointGuideBody'),
          'Sample a neutral gray area to refine white balance.'
        );
      }
      if (guideHint) {
        guideHint.textContent = getLocalizedText(
          stateKey('Hint', 'grayPointGuideHint'),
          'Click the image directly after starting gray-point sampling.'
        );
      }
    }

    function updateSamplingModeUI() {
      if (!stateReady) return;
      const sampleBaseBtn = document.getElementById('sampleBaseBtn');
      if (sampleBaseBtn) {
        sampleBaseBtn.classList.toggle('active', state.samplingMode === 'filmBase');
      }

      const cursor = state.samplingMode ? 'crosshair' : '';
      const canvasEl = document.getElementById('canvas');
      const glCanvasEl = document.getElementById('glCanvas');
      if (canvasEl) canvasEl.style.cursor = cursor;
      if (glCanvasEl) glCanvasEl.style.cursor = cursor;
      if (!state.samplingMode) {
        hideLoupe();
      }
      updateGrayPointGuideUI();
      studioWorkspace?.sync();
    }

    function resetFrontierGuideImageState() {
      state.frontierGuideAutoAppliedForImage = false;
      state.frontierGuideStep2ChoiceTouched = false;
    }

    function startWhiteBalanceSampling() {
      if (!state.processedImageData) return;
      exitBeforeAfter();
      state.samplingMode = 'whiteBalance';
      updateSamplingModeUI();
      updateBeforeAfterButtonState();
    }



    // ===========================================
    // SP3000-style correction console
    // Discrete-step C/M/Y/D keys writing the existing state channels, so the
    // whole undo/snapshot/batch/export machinery applies unchanged. C/M/Y hit
    // the legacy pixel channels (kept live under SilverCore on purpose); D
    // hits coreExposure and reconverts like any other core control.
    // ===========================================
    const CONSOLE_MAX_STEPS = 8; // Frontier-style key range: N ± 8
    const CONSOLE_CHANNELS = {
      cyan:    { stateKey: 'cyan',         step: 5,  commit: 'pixel', readoutId: 'consoleReadoutCyan' },
      magenta: { stateKey: 'magenta',      step: 5,  commit: 'pixel', readoutId: 'consoleReadoutMagenta' },
      yellow:  { stateKey: 'yellow',       step: 5,  commit: 'pixel', readoutId: 'consoleReadoutYellow' },
      density: { stateKey: 'coreExposure', step: 10, commit: 'core',  readoutId: 'consoleReadoutDensity' },
    };

    function consoleChannelSteps(channel) {
      return Math.round((Number(state[channel.stateKey]) || 0) / channel.step);
    }

    function consoleChannelsEnabled() {
      return document.body.dataset.photoSwitching !== 'true' && stateReady && Boolean(state.processedImageData);
    }

    function consoleColorKeysEnabled() {
      return consoleChannelsEnabled() && sanitizePresetType(state.filmType || 'color') !== 'bw';
    }

    function updateConsoleReadouts() {
      if (!stateReady) return;
      const enabled = consoleChannelsEnabled();
      const colorEnabled = consoleColorKeysEnabled();
      for (const [name, channel] of Object.entries(CONSOLE_CHANNELS)) {
        const readout = document.getElementById(channel.readoutId);
        if (!readout) continue;
        const steps = consoleChannelSteps(channel);
        readout.textContent = steps === 0 ? 'N' : (steps > 0 ? `+${steps}` : `−${Math.abs(steps)}`);
        readout.classList.toggle('is-live', steps !== 0);
        const channelEnabled = name === 'density' ? enabled : colorEnabled;
        const column = readout.closest('.console-channel');
        if (column) column.classList.toggle('disabled', !channelEnabled);
        document.querySelectorAll(`.console-key[data-channel="${name}"]`).forEach((key) => {
          key.disabled = !channelEnabled;
        });
      }
      const resetBtn = document.getElementById('consoleResetBtn');
      if (resetBtn) resetBtn.disabled = !enabled;
    }

    function commitConsoleChannel(channel) {
      syncSliderFromState(channel.stateKey);
      markCurrentFileDirty();
      schedulePreviewUpdate();
      if (channel.commit === 'core') {
        scheduleCoreReprocess({ full: false });
      } else {
        scheduleFullUpdate();
      }
    }

    function nudgeConsoleChannel(name, dir) {
      const channel = CONSOLE_CHANNELS[name];
      if (!channel) return;
      const enabled = name === 'density' ? consoleChannelsEnabled() : consoleColorKeysEnabled();
      if (!enabled) return;
      const current = consoleChannelSteps(channel);
      const next = Math.max(-CONSOLE_MAX_STEPS, Math.min(CONSOLE_MAX_STEPS, current + dir));
      const nextValue = next * channel.step;
      // Snap: a press lands exactly on a step even if a detail-mode slider
      // left the value between steps.
      if (nextValue === state[channel.stateKey]) return;
      pushUndo(channel.stateKey);
      state[channel.stateKey] = nextValue;
      commitConsoleChannel(channel);
      updateConsoleReadouts();
    }

    function resetConsoleChannels() {
      if (!consoleChannelsEnabled()) return;
      const touched = Object.values(CONSOLE_CHANNELS).filter((c) => (Number(state[c.stateKey]) || 0) !== 0);
      if (touched.length === 0) return;
      pushUndo('consoleReset');
      let coreTouched = false;
      let pixelTouched = false;
      for (const channel of touched) {
        state[channel.stateKey] = 0;
        syncSliderFromState(channel.stateKey);
        if (channel.commit === 'core') coreTouched = true; else pixelTouched = true;
      }
      markCurrentFileDirty();
      schedulePreviewUpdate();
      if (coreTouched) scheduleCoreReprocess({ full: false });
      if (pixelTouched) scheduleFullUpdate();
      updateConsoleReadouts();
    }

    document.querySelectorAll('.console-key[data-channel]').forEach((key) => {
      key.addEventListener('click', () => {
        nudgeConsoleChannel(key.dataset.channel, key.dataset.dir === '-1' ? -1 : 1);
      });
    });
    document.getElementById('consoleResetBtn')?.addEventListener('click', resetConsoleChannels);




    document.getElementById('headerGrayPointBtn')?.addEventListener('click', () => {
      startWhiteBalanceSampling();
    });


    // Feedback popup: posts to the Vercel function that files a GitHub issue.
    // The desktop webview has a tauri:// origin, so it must hit the site by full URL.
    const FEEDBACK_ENDPOINT = isTauriDesktop()
      ? 'https://negative-converter.tokugai.com/api/feedback'
      : '/api/feedback';
    let feedbackType = 'bug';
    let feedbackSending = false;
    const FEEDBACK_MAX_IMAGES = 3;
    let feedbackImages = []; // JPEG data URLs, compressed client-side

    async function compressFeedbackImage(file) {
      const bitmap = await createImageBitmap(file);
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      if (bitmap.close) bitmap.close();
      let quality = 0.82;
      let dataUrl = canvas.toDataURL('image/jpeg', quality);
      // Keep each image comfortably inside the endpoint's per-image cap.
      while (dataUrl.length > 1200000 && quality > 0.4) {
        quality -= 0.14;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      return dataUrl;
    }

    function renderFeedbackImages() {
      const list = document.getElementById('feedbackImageList');
      const attachBtn = document.getElementById('feedbackAttachBtn');
      const count = document.getElementById('feedbackAttachCount');
      if (!list) return;
      list.textContent = '';
      feedbackImages.forEach((dataUrl, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'feedback-image-thumb';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = `feedback image ${index + 1}`;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'feedback-image-remove';
        removeBtn.dataset.index = String(index);
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', getLocalizedText('feedbackRemoveImage', 'Remove'));
        thumb.appendChild(img);
        thumb.appendChild(removeBtn);
        list.appendChild(thumb);
      });
      if (attachBtn) attachBtn.disabled = feedbackImages.length >= FEEDBACK_MAX_IMAGES;
      if (count) {
        count.hidden = feedbackImages.length === 0;
        count.textContent = `${feedbackImages.length}/${FEEDBACK_MAX_IMAGES}`;
      }
    }

    function setFeedbackStatus(status) {
      ['Sending', 'Success', 'Error'].forEach((name) => {
        const el = document.getElementById(`feedbackStatus${name}`);
        if (el) el.hidden = status !== name.toLowerCase();
      });
    }

    function updateFeedbackSubmitState() {
      const messageEl = document.getElementById('feedbackMessage');
      const submitBtn = document.getElementById('feedbackSubmitBtn');
      if (submitBtn) submitBtn.disabled = feedbackSending || !messageEl?.value.trim();
    }

    function setFeedbackPopupVisible(visible) {
      const overlay = document.getElementById('feedbackPopupOverlay');
      if (!overlay) return;
      overlay.classList.toggle('visible', Boolean(visible));
      overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (visible) {
        setFeedbackStatus('none');
        const skippedEl = document.getElementById('feedbackStatusImageSkipped');
        if (skippedEl) skippedEl.hidden = true;
        renderFeedbackImages();
        updateFeedbackSubmitState();
        document.getElementById('feedbackMessage')?.focus();
      }
    }

    function closeFeedbackPopup() {
      setFeedbackPopupVisible(false);
    }

    async function submitFeedback() {
      if (feedbackSending) return;
      const messageEl = document.getElementById('feedbackMessage');
      const message = messageEl?.value.trim() || '';
      if (!message) return;
      feedbackSending = true;
      setFeedbackStatus('sending');
      updateFeedbackSubmitState();
      try {
        const res = await fetch(FEEDBACK_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: feedbackType,
            message,
            website: document.getElementById('feedbackWebsite')?.value || '',
            lang: currentLang,
            source: isTauriDesktop() ? 'desktop' : 'web',
            images: feedbackImages.map((dataUrl) => ({
              type: 'image/jpeg',
              data: dataUrl.slice(dataUrl.indexOf(',') + 1)
            }))
          })
        });
        if (!res.ok) throw new Error(`feedback endpoint returned ${res.status}`);
        setFeedbackStatus('success');
        if (messageEl) messageEl.value = '';
        feedbackImages = [];
        renderFeedbackImages();
        setTimeout(() => {
          if (document.getElementById('feedbackPopupOverlay')?.classList.contains('visible')) {
            closeFeedbackPopup();
          }
        }, 1600);
      } catch (err) {
        console.error('Feedback submit failed', err);
        setFeedbackStatus('error');
      } finally {
        feedbackSending = false;
        updateFeedbackSubmitState();
      }
    }

    document.getElementById('feedbackBtn')?.addEventListener('click', () => {
      setFeedbackPopupVisible(true);
    });
    document.getElementById('feedbackCancelBtn')?.addEventListener('click', closeFeedbackPopup);
    document.getElementById('feedbackPopupOverlay')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeFeedbackPopup();
      }
    });
    document.getElementById('feedbackTypeGroup')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-feedback-type]');
      if (!btn) return;
      feedbackType = btn.dataset.feedbackType;
      document.querySelectorAll('#feedbackTypeGroup .feedback-type-btn').forEach((el) => {
        const active = el === btn;
        el.classList.toggle('active', active);
        el.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
    document.getElementById('feedbackMessage')?.addEventListener('input', updateFeedbackSubmitState);
    document.getElementById('feedbackAttachBtn')?.addEventListener('click', () => {
      document.getElementById('feedbackImageInput')?.click();
    });
    document.getElementById('feedbackImageInput')?.addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      let skipped = false;
      for (const file of files) {
        if (feedbackImages.length >= FEEDBACK_MAX_IMAGES) { skipped = true; break; }
        try {
          feedbackImages.push(await compressFeedbackImage(file));
        } catch (err) {
          console.warn('Feedback image skipped', err);
          skipped = true;
        }
      }
      const skippedEl = document.getElementById('feedbackStatusImageSkipped');
      if (skippedEl) skippedEl.hidden = !skipped;
      renderFeedbackImages();
    });
    document.getElementById('feedbackImageList')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.feedback-image-remove');
      if (!btn) return;
      const index = Number(btn.dataset.index);
      if (!Number.isInteger(index)) return;
      feedbackImages.splice(index, 1);
      renderFeedbackImages();
    });
    document.getElementById('feedbackForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitFeedback();
    });

	    function applyTemplate(template, vars = {}) {
	      let output = String(template || '');
	      Object.entries(vars).forEach(([key, value]) => {
	        output = output.replaceAll(`{${key}}`, String(value));
      });
      return output;
    }

    function formatLensLabel(lens) {
      if (!lens || typeof lens !== 'object') return '';
      const maker = String(lens.maker || '').trim();
      const model = String(lens.model || '').trim();
      return `${maker} ${model}`.trim() || model || maker || '';
    }

    function sanitizeLensRuntimeError(err) {
      const raw = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
      if (!raw) return 'unknown';
      return raw.slice(0, 180);
    }

    async function getLensSourceAssets(source) {
      if (source === 'local') {
        const localAssets = await loadLocalLensfunAssets();
        return {
          source: 'local',
          ...localAssets
        };
      }
      return {
        source: 'cdn',
        searchFlags: (window.LensfunWasm && Number.isFinite(window.LensfunWasm.LF_SEARCH_SORT_AND_UNIQUIFY))
          ? window.LensfunWasm.LF_SEARCH_SORT_AND_UNIQUIFY
          : 2,
        iifeUrl: `${LENSFUN_CDN_BASE}/umd/index.iife.js`,
        moduleJsUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.js`,
        wasmUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.wasm`,
        dataUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.data`
      };
    }

    function loadLensScript(url) {
      if (lensScriptLoadPromises.has(url)) return lensScriptLoadPromises.get(url);

      const promise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-lensfun-src="${url}"]`);
        if (existing) {
          existing.addEventListener('load', () => resolve(url), { once: true });
          existing.addEventListener('error', () => reject(new Error(`failed to load ${url}`)), { once: true });
          return;
        }

        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.lensfunSrc = url;
        script.onload = () => resolve(url);
        script.onerror = () => {
          // Drop the element: its load/error events have already fired, so a
          // retry that found it via querySelector would attach listeners that
          // never run and hang every later lens operation.
          script.remove();
          reject(new Error(`failed to load ${url}`));
        };
        document.head.appendChild(script);
      }).catch((err) => {
        lensScriptLoadPromises.delete(url);
        throw err;
      });

      lensScriptLoadPromises.set(url, promise);
      return promise;
    }

    async function initLensfunClientFromSource(source) {
      const assets = await getLensSourceAssets(source);
      if (source === 'local') {
        const client = await assets.createLensfun({
          moduleFactory: assets.moduleFactory,
          wasmUrl: assets.wasmUrl,
          dataUrl: assets.dataUrl
        });
        return { client, source: assets.source, searchFlags: assets.searchFlags };
      }

      await loadLensScript(assets.iifeUrl);
      if (!window.LensfunWasm || typeof window.LensfunWasm.createLensfun !== 'function') {
        throw new Error('LensfunWasm global is unavailable');
      }

      const client = await window.LensfunWasm.createLensfun({
        moduleJsUrl: assets.moduleJsUrl,
        wasmUrl: assets.wasmUrl,
        dataUrl: assets.dataUrl
      });
      return { client, source: assets.source, searchFlags: assets.searchFlags };
    }

    async function ensureLensfunClient() {
      if (lensfunRuntime.client) {
        return {
          client: lensfunRuntime.client,
          source: lensfunRuntime.source,
          searchFlags: lensfunRuntime.searchFlags
        };
      }
      if (lensfunRuntime.initPromise) {
        return lensfunRuntime.initPromise;
      }

      lensfunRuntime.initPromise = (async () => {
        try {
          const runtime = await initLensfunClientFromSource('local');
          lensfunRuntime.client = runtime.client;
          lensfunRuntime.source = runtime.source;
          lensfunRuntime.searchFlags = runtime.searchFlags;
          lensfunRuntime.lastError = '';
          return runtime;
        } catch (localErr) {
          if (isTauriDesktop()) {
            // The desktop build bundles the lensfun assets and is expected to
            // work offline: do not fall back to a CDN it should never contact.
            lensfunRuntime.lastError = sanitizeLensRuntimeError(localErr);
            throw new Error(lensfunRuntime.lastError);
          }
          try {
            const runtime = await initLensfunClientFromSource('cdn');
            lensfunRuntime.client = runtime.client;
            lensfunRuntime.source = runtime.source;
            lensfunRuntime.searchFlags = runtime.searchFlags;
            lensfunRuntime.lastError = '';
            return runtime;
          } catch (cdnErr) {
            const localReason = sanitizeLensRuntimeError(localErr);
            const cdnReason = sanitizeLensRuntimeError(cdnErr);
            lensfunRuntime.lastError = `local: ${localReason}; CDN: ${cdnReason}`;
            throw new Error(lensfunRuntime.lastError);
          }
        }
      })();

      try {
        return await lensfunRuntime.initPromise;
      } finally {
        if (!lensfunRuntime.client) lensfunRuntime.initPromise = null;
      }
    }

    function resolveLensStatusKeyForSource(source) {
      return source === 'cdn' ? 'lensStatusReadyCdn' : 'lensStatusReadyLocal';
    }

    function setLensStatus(statusKey, statusVars = {}) {
      if (!state || !state.lensCorrection) return;
      state.lensCorrection.statusKey = statusKey || 'lensStatusIdle';
      state.lensCorrection.statusVars = statusVars && typeof statusVars === 'object'
        ? { ...statusVars }
        : {};
      if (stateReady) updateLensCorrectionUI();
    }

    function getAutoLensMapStep(width, height) {
      const maxSide = Math.max(width, height);
      if (maxSide >= 5200) return 8;
      if (maxSide >= 3600) return 6;
      if (maxSide >= 2400) return 4;
      if (maxSide >= 1500) return 3;
      return 2;
    }

    function resolveLensMapStep(params, width, height) {
      if (params.stepMode === 'manual') {
        return Math.round(clampBetween(params.step || 2, 1, 16));
      }
      return getAutoLensMapStep(width, height);
    }

    function buildLensMapCacheKey(lensHandle, width, height, params, modes) {
      return [
        lensHandle,
        width,
        height,
        params.focal.toFixed(4),
        params.crop.toFixed(4),
        params.aperture.toFixed(4),
        params.distance.toFixed(4),
        params.step,
        params.stepMode,
        modes.includeTca ? 1 : 0,
        modes.includeVignetting ? 1 : 0
      ].join('|');
    }

    function bilerp(a00, a10, a01, a11, fx, fy) {
      const x0 = a00 + (a10 - a00) * fx;
      const x1 = a01 + (a11 - a01) * fx;
      return x0 + (x1 - x0) * fy;
    }

    function sampleImageChannelBilinear(data, width, height, x, y, channel) {
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = x - x0;
      const fy = y - y0;

      const i00 = (y0 * width + x0) * 4 + channel;
      const i10 = (y0 * width + x1) * 4 + channel;
      const i01 = (y1 * width + x0) * 4 + channel;
      const i11 = (y1 * width + x1) * 4 + channel;

      return bilerp(data[i00], data[i10], data[i01], data[i11], fx, fy);
    }

    function sampleGridPair(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 2;
      const p10 = (y0 * gridWidth + x1) * 2;
      const p01 = (y1 * gridWidth + x0) * 2;
      const p11 = (y1 * gridWidth + x1) * 2;
      return {
        x: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        y: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy)
      };
    }

    function sampleGridTriple(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 3;
      const p10 = (y0 * gridWidth + x1) * 3;
      const p01 = (y1 * gridWidth + x0) * 3;
      const p11 = (y1 * gridWidth + x1) * 3;
      return {
        r: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        g: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
        b: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy)
      };
    }

    function sampleGridTca(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 6;
      const p10 = (y0 * gridWidth + x1) * 6;
      const p01 = (y1 * gridWidth + x0) * 6;
      const p11 = (y1 * gridWidth + x1) * 6;
      return {
        rx: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        ry: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
        gx: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy),
        gy: bilerp(grid[p00 + 3], grid[p10 + 3], grid[p01 + 3], grid[p11 + 3], fx, fy),
        bx: bilerp(grid[p00 + 4], grid[p10 + 4], grid[p01 + 4], grid[p11 + 4], fx, fy),
        by: bilerp(grid[p00 + 5], grid[p10 + 5], grid[p01 + 5], grid[p11 + 5], fx, fy)
      };
    }

    function applyLensMapsToImage(imageData, maps, modes) {
      const { width, height, data } = imageData;
      const output = new ImageData(new Uint8ClampedArray(data.length), width, height);
      const outData = output.data;
      // Resample the 16-bit plane when the loader attached one, otherwise every
      // RAW or 16-bit PNG converted with lens correction on would reach the
      // engine as 8-bit data upcast back to 16.
      const plane16 = imageData.__image16;
      const use16 = Boolean(
        plane16
        && plane16.data instanceof Uint16Array
        && plane16.width === width
        && plane16.height === height
        && plane16.data.length === data.length
      );
      const source = use16 ? plane16.data : data;
      const maxValue = use16 ? 65535 : 255;
      const out16 = use16 ? new Uint16Array(data.length) : null;
      const gridWidth = maps.gridWidth;
      const gridHeight = maps.gridHeight;
      const step = Math.max(1, maps.step || 1);
      const geometry = maps.geometry;
      const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
      const vignetting = (modes.includeVignetting && maps.vignetting) ? maps.vignetting : null;

      for (let y = 0; y < height; y++) {
        const gyRaw = y / step;
        const y0 = clampBetween(Math.floor(gyRaw), 0, gridHeight - 1);
        const y1 = clampBetween(y0 + 1, 0, gridHeight - 1);
        const fy = clampBetween(gyRaw - y0, 0, 1);

        for (let x = 0; x < width; x++) {
          const gxRaw = x / step;
          const x0 = clampBetween(Math.floor(gxRaw), 0, gridWidth - 1);
          const x1 = clampBetween(x0 + 1, 0, gridWidth - 1);
          const fx = clampBetween(gxRaw - x0, 0, 1);

          let rX, rY, gX, gY, bX, bY;
          if (tca) {
            const tcaCoords = sampleGridTca(tca, gridWidth, x0, x1, y0, y1, fx, fy);
            rX = tcaCoords.rx; rY = tcaCoords.ry;
            gX = tcaCoords.gx; gY = tcaCoords.gy;
            bX = tcaCoords.bx; bY = tcaCoords.by;
          } else {
            const geometryCoords = sampleGridPair(geometry, gridWidth, x0, x1, y0, y1, fx, fy);
            rX = geometryCoords.x; rY = geometryCoords.y;
            gX = geometryCoords.x; gY = geometryCoords.y;
            bX = geometryCoords.x; bY = geometryCoords.y;
          }

          let r = sampleImageChannelBilinear(source, width, height, rX, rY, 0);
          let g = sampleImageChannelBilinear(source, width, height, gX, gY, 1);
          let b = sampleImageChannelBilinear(source, width, height, bX, bY, 2);

          if (vignetting) {
            const gains = sampleGridTriple(vignetting, gridWidth, x0, x1, y0, y1, fx, fy);
            r *= gains.r;
            g *= gains.g;
            b *= gains.b;
          }

          const outIdx = (y * width + x) * 4;
          const rv = clampBetween(Math.round(r), 0, maxValue);
          const gv = clampBetween(Math.round(g), 0, maxValue);
          const bv = clampBetween(Math.round(b), 0, maxValue);
          if (out16) {
            out16[outIdx] = rv;
            out16[outIdx + 1] = gv;
            out16[outIdx + 2] = bv;
            out16[outIdx + 3] = 65535;
            // Keep the 8-bit view exactly consistent with the 16-bit plane.
            outData[outIdx] = rv >>> 8;
            outData[outIdx + 1] = gv >>> 8;
            outData[outIdx + 2] = bv >>> 8;
          } else {
            outData[outIdx] = rv;
            outData[outIdx + 1] = gv;
            outData[outIdx + 2] = bv;
          }
          outData[outIdx + 3] = 255;
        }
      }
      if (out16) {
        output.__image16 = { width, height, data: out16 };
      }
      return output;
    }

    async function applyLensCorrectionWithSettings(imageData, settings, options = {}) {
      const { updateUi = false } = options;
      const safeSettings = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });
      const lensCorrection = safeSettings.lensCorrection;
      const selectedLens = lensCorrection.selectedLens;

      if (!lensCorrection.enabled) {
        if (updateUi) setLensStatus('lensStatusSkipped');
        return imageData;
      }

      if (!selectedLens || !selectedLens.handle) {
        if (updateUi) setLensStatus('lensStatusNeedProfile');
        return imageData;
      }

      if (updateUi) setLensStatus('lensStatusLoading');

      let runtime;
      try {
        runtime = await ensureLensfunClient();
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        if (updateUi) {
          state.lensCorrection.lastError = reason;
          setLensStatus('lensStatusInitFailed', { reason });
        }
        return imageData;
      }

      if (updateUi) {
        state.lensCorrection.source = runtime.source;
        setLensStatus(resolveLensStatusKeyForSource(runtime.source));
      }

      try {
        const params = {
          focal: lensCorrection.params.focal,
          crop: lensCorrection.params.crop,
          aperture: lensCorrection.params.aperture,
          distance: lensCorrection.params.distance,
          stepMode: lensCorrection.params.stepMode,
          step: resolveLensMapStep(lensCorrection.params, imageData.width, imageData.height)
        };
        const cacheKey = buildLensMapCacheKey(
          selectedLens.handle,
          imageData.width,
          imageData.height,
          params,
          lensCorrection.modes
        );
        let maps = lensMapCache.get(cacheKey);
        if (!maps) {
          maps = runtime.client.buildCorrectionMaps({
            lensHandle: selectedLens.handle,
            width: imageData.width,
            height: imageData.height,
            focal: params.focal,
            crop: params.crop,
            step: params.step,
            reverse: false,
            includeTca: lensCorrection.modes.includeTca,
            includeVignetting: lensCorrection.modes.includeVignetting,
            aperture: params.aperture,
            distance: params.distance
          });
          lensMapCache.set(cacheKey, maps);
          if (lensMapCache.size > 12) {
            const oldestKey = lensMapCache.keys().next().value;
            if (oldestKey) lensMapCache.delete(oldestKey);
          }
        }

        const corrected = applyLensMapsToImage(imageData, maps, lensCorrection.modes);
        // Keep the display-to-source map for brush coordinates. Non-enumerable
        // metadata avoids copying the grid into conversion worker messages.
        Object.defineProperty(corrected, '__lensMapping', { value: { maps, includeTca: lensCorrection.modes.includeTca } });
        if (updateUi) {
          state.lensCorrection.lastError = '';
          setLensStatus('lensStatusApplied');
        }
        return corrected;
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        if (updateUi) {
          state.lensCorrection.lastError = reason;
          setLensStatus('lensStatusApplyFailed', { reason });
        }
        return imageData;
      }
    }

    function applyLensMetadataPrefill(metadata) {
      if (!metadata || typeof metadata !== 'object') return;
      const search = state.lensCorrection.search;
      if (!search.lensModel && metadata.lensModel) search.lensModel = metadata.lensModel;
      if (!search.lensMaker && metadata.lensMaker) search.lensMaker = metadata.lensMaker;
      if (!search.cameraModel && metadata.cameraModel) search.cameraModel = metadata.cameraModel;
      if (!search.cameraMaker && metadata.cameraMaker) search.cameraMaker = metadata.cameraMaker;

      if (!state.lensCorrection.paramTouched.focal && Number.isFinite(metadata.focal)) {
        state.lensCorrection.params.focal = clampBetween(metadata.focal, 1, 10_000);
      }
      if (!state.lensCorrection.paramTouched.aperture && Number.isFinite(metadata.aperture)) {
        state.lensCorrection.params.aperture = clampBetween(metadata.aperture, 0.5, 512);
      }

      updateLensCorrectionUI();
    }

    function guessFocalFromLensProfile(lens) {
      if (!lens || typeof lens !== 'object') return 50;
      const minFocal = sanitizeNumeric(lens.minFocal, NaN, 0, 10_000);
      const maxFocal = sanitizeNumeric(lens.maxFocal, NaN, 0, 10_000);
      if (Number.isFinite(minFocal) && Number.isFinite(maxFocal) && maxFocal >= minFocal && maxFocal > 0) {
        if (minFocal > 0 && maxFocal > 0) return (minFocal + maxFocal) / 2;
      }
      if (Number.isFinite(minFocal) && minFocal > 0) return minFocal;
      if (Number.isFinite(maxFocal) && maxFocal > 0) return maxFocal;
      return 50;
    }

    function syncLensStepInputState() {
      const stepModeSelect = document.getElementById('lensStepModeSelect');
      const stepInput = document.getElementById('lensStepInput');
      if (!stepModeSelect || !stepInput) return;
      const manual = stepModeSelect.value === 'manual';
      stepInput.disabled = !manual;
    }

    function renderLensSearchResults() {
      const select = document.getElementById('lensResultSelect');
      if (!select) return;
      const results = Array.isArray(state.lensCorrection.searchResults)
        ? state.lensCorrection.searchResults
        : [];
      const selectedHandle = state.lensCorrection.selectedLens?.handle || null;

      select.innerHTML = '';
      if (!results.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = getLocalizedText('lensNoResult', 'No profiles loaded yet');
        select.appendChild(opt);
        select.disabled = true;
        return;
      }

      results.forEach((lens, idx) => {
        const option = document.createElement('option');
        option.value = String(idx);
        const maker = String(lens.maker || '').trim();
        const model = String(lens.model || '').trim();
        const lensLabel = `${maker} ${model}`.trim() || '-';
        const score = Number.isFinite(lens.score) ? Number(lens.score).toFixed(3) : '0.000';
        const minFocal = Number.isFinite(lens.minFocal) ? Number(lens.minFocal).toFixed(1) : '-';
        const maxFocal = Number.isFinite(lens.maxFocal) ? Number(lens.maxFocal).toFixed(1) : '-';
        const scoreLabel = getLocalizedText('lensScoreLabel', 'score');
        const template = getLocalizedText(
          'lensResultItemTemplate',
          '{lens} | {scoreLabel} {score} | {minFocal}-{maxFocal}mm'
        );
        option.textContent = applyTemplate(template, {
          lens: lensLabel,
          scoreLabel,
          score,
          minFocal,
          maxFocal
        }).trim();
        if (selectedHandle && lens.handle === selectedHandle) {
          option.selected = true;
        }
        select.appendChild(option);
      });
      select.disabled = false;
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }

    function updateLensCorrectionUI() {
      const panel = document.getElementById('lensCorrectionPanel');
      if (!panel) return;

      const enableInput = document.getElementById('lensEnableInput');
      const lensModelInput = document.getElementById('lensLensModelInput');
      const lensMakerInput = document.getElementById('lensLensMakerInput');
      const cameraModelInput = document.getElementById('lensCameraModelInput');
      const cameraMakerInput = document.getElementById('lensCameraMakerInput');
      const focalInput = document.getElementById('lensFocalInput');
      const cropInput = document.getElementById('lensCropInput');
      const apertureInput = document.getElementById('lensApertureInput');
      const distanceInput = document.getElementById('lensDistanceInput');
      const stepModeSelect = document.getElementById('lensStepModeSelect');
      const stepInput = document.getElementById('lensStepInput');
      const useSelectedBtn = document.getElementById('lensUseSelectedBtn');
      const statusBox = document.getElementById('lensStatusBox');
      const selectedText = document.getElementById('lensSelectedText');

      enableInput.checked = Boolean(state.lensCorrection.enabled);
      lensModelInput.value = state.lensCorrection.search.lensModel || '';
      lensMakerInput.value = state.lensCorrection.search.lensMaker || '';
      cameraModelInput.value = state.lensCorrection.search.cameraModel || '';
      cameraMakerInput.value = state.lensCorrection.search.cameraMaker || '';

      focalInput.value = String(Number(state.lensCorrection.params.focal).toFixed(2)).replace(/\.00$/, '');
      cropInput.value = String(Number(state.lensCorrection.params.crop).toFixed(3)).replace(/\.?0+$/, '');
      apertureInput.value = String(Number(state.lensCorrection.params.aperture).toFixed(2)).replace(/\.00$/, '');
      distanceInput.value = String(Number(state.lensCorrection.params.distance).toFixed(2)).replace(/\.00$/, '');
      stepModeSelect.value = state.lensCorrection.params.stepMode === 'manual' ? 'manual' : 'auto';
      stepInput.value = String(Math.round(state.lensCorrection.params.step || 2));
      syncLensStepInputState();

      renderLensSearchResults();
      const hasResults = Array.isArray(state.lensCorrection.searchResults) && state.lensCorrection.searchResults.length > 0;
      useSelectedBtn.disabled = !hasResults;

      const selectedLens = state.lensCorrection.selectedLens;
      const statusKey = state.lensCorrection.statusKey || 'lensStatusIdle';
      panel.classList.toggle(
        'is-open',
        Boolean(state.lensCorrection.enabled || selectedLens || hasResults || statusKey !== 'lensStatusIdle')
      );

      if (selectedLens) {
        selectedText.textContent = applyTemplate(
          getLocalizedText('lensSelectedPrefix', 'Selected profile: {lens}'),
          { lens: formatLensLabel(selectedLens) || `#${selectedLens.handle}` }
        );
      } else {
        selectedText.textContent = getLocalizedText('lensSelectedNone', 'Selected profile: none');
      }

      const template = getLocalizedText(statusKey, getLocalizedText('lensStatusIdle', 'Lens correction is optional.'));
      statusBox.textContent = applyTemplate(template, state.lensCorrection.statusVars || {});
      statusBox.classList.remove('error', 'ready');
      if (statusKey === 'lensStatusInitFailed' || statusKey === 'lensStatusApplyFailed') {
        statusBox.classList.add('error');
      } else if (statusKey === 'lensStatusReadyCdn' || statusKey === 'lensStatusReadyLocal' || statusKey === 'lensStatusApplied') {
        statusBox.classList.add('ready');
      }
    }

    function parseSemver(value) {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().replace(/^v/i, '');
      const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!match) return null;
      return {
        normalized,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3])
      };
    }

    function compareSemver(a, b) {
      if (a.major !== b.major) return a.major - b.major;
      if (a.minor !== b.minor) return a.minor - b.minor;
      return a.patch - b.patch;
    }

    function updateDesktopUpdateBannerText() {
      const body = document.getElementById('desktopUpdateBody');
      if (!body) return;
      const template = getLocalizedText(
        'desktopUpdateBody',
        'Current version {current}, latest version {latest}.'
      );
      const current = desktopUpdateState.currentVersion || '0.0.0';
      const latest = desktopUpdateState.latestVersion || '0.0.0';
      body.textContent = applyTemplate(template, { current, latest });
    }

    function showDesktopUpdateBanner(currentVersion, latestVersion) {
      const banner = document.getElementById('desktopUpdateBanner');
      if (!banner) return;
      desktopUpdateState.visible = true;
      desktopUpdateState.currentVersion = currentVersion;
      desktopUpdateState.latestVersion = latestVersion;
      updateDesktopUpdateBannerText();
      banner.style.display = 'flex';
    }

    function hideDesktopUpdateBanner() {
      const banner = document.getElementById('desktopUpdateBanner');
      if (!banner) return;
      desktopUpdateState.visible = false;
      banner.style.display = 'none';
    }

    function shouldSkipDesktopUpdateCheck() {
      const raw = safeStorageGet(DESKTOP_UPDATE_LAST_CHECK_TS_KEY);
      const lastCheck = Number(raw);
      if (!Number.isFinite(lastCheck) || lastCheck <= 0) return false;
      return (Date.now() - lastCheck) < DESKTOP_UPDATE_CHECK_INTERVAL_MS;
    }

    function markDesktopUpdateChecked() {
      safeStorageSet(DESKTOP_UPDATE_LAST_CHECK_TS_KEY, String(Date.now()));
    }

    async function fetchLatestDesktopVersion() {
      let lastError = null;
      for (const url of DESKTOP_UPDATE_MANIFEST_URLS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DESKTOP_UPDATE_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const fromVersion = typeof payload.version === 'string' ? payload.version : '';
          const fromTag = typeof payload.tag === 'string' ? payload.tag : '';
          const parsed = parseSemver(fromVersion) || parseSemver(fromTag);
          if (!parsed) throw new Error('invalid version in latest.json');
          return parsed.normalized;
        } catch (err) {
          lastError = err;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw lastError || new Error('failed to load release manifest');
    }

    function buildDesktopUpdateDownloadUrl() {
      const url = new URL(DESKTOP_UPDATE_PAGE_URL);
      url.searchParams.set('lang', currentLang || 'en');
      url.searchParams.set('from', 'desktop-update');
      if (desktopUpdateState.currentVersion) url.searchParams.set('current', desktopUpdateState.currentVersion);
      if (desktopUpdateState.latestVersion) url.searchParams.set('latest', desktopUpdateState.latestVersion);
      return url.toString();
    }

    const SITE_ORIGIN = 'https://negative-converter.tokugai.com/';

    async function openExternalUrl(url) {
      if (isTauriDesktop()) {
        try {
          await window.__TAURI__.core.invoke('open_external_url', { url });
          return;
        } catch (err) {
          console.warn('Desktop open_external_url failed:', err);
          // window.open opens nothing inside the desktop window (there is no
          // new-window handler), so the link would just die silently. Show the
          // address instead — under the App Store sandbox, launching the
          // browser can be refused.
          showToast(
            getInterpolatedText(
              'externalLinkFailed',
              { url },
              `Could not open the link. Open it manually: ${url}`
            ),
            8000
          );
          return;
        }
      }
      window.open(url, '_blank', 'noopener');
    }

    async function openDownloadPageForUpdate() {
      await openExternalUrl(buildDesktopUpdateDownloadUrl());
    }

    // Inside the desktop window there is no new-window handler and no tab bar,
    // so a target="_blank" link does nothing at all and a same-window link to
    // one of the bundled marketing pages replaces the app — silently discarding
    // the loaded queue, per-file settings, roll reference and undo history with
    // no way back. Route every outbound link to the system browser instead.
    function installDesktopExternalLinkHandler() {
      if (!isTauriDesktop()) return;
      document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor || anchor.hasAttribute('download')) return;

        const href = anchor.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        let resolved;
        try {
          resolved = new URL(href, SITE_ORIGIN);
        } catch (err) {
          return;
        }
        // Upgrade http:// — the Rust side only opens https URLs.
        if (resolved.protocol === 'http:') resolved.protocol = 'https:';
        if (resolved.protocol !== 'https:') return;

        event.preventDefault();
        void openExternalUrl(resolved.toString());
      });
    }

    installDesktopExternalLinkHandler();

    async function checkDesktopUpdate(options = {}) {
      if (!isTauriDesktop()) return;
      const force = Boolean(options.force);
      if (!force && shouldSkipDesktopUpdateCheck()) return;

      try {
        const currentRaw = await window.__TAURI__.core.invoke('get_app_version');
        const currentParsed = parseSemver(String(currentRaw || ''));
        if (!currentParsed) return;

        const latest = await fetchLatestDesktopVersion();
        const latestParsed = parseSemver(latest);
        if (!latestParsed) return;

        if (compareSemver(latestParsed, currentParsed) > 0) {
          safeStorageSet(DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY, latestParsed.normalized);
          showDesktopUpdateBanner(currentParsed.normalized, latestParsed.normalized);
        }
      } catch (err) {
        console.info('Desktop update check skipped:', err);
      } finally {
        markDesktopUpdateChecked();
      }
    }

    function formatMegabytes(bytes) {
      return (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
    }

    function setDesktopUpdateBusy(busy) {
      const actionBtn = document.getElementById('desktopUpdateActionBtn');
      const laterBtn = document.getElementById('desktopUpdateLaterBtn');
      const banner = document.getElementById('desktopUpdateBanner');
      if (actionBtn) actionBtn.disabled = busy;
      if (laterBtn) laterBtn.disabled = busy;
      if (banner) banner.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function setDesktopUpdateBody(key, vars, fallback) {
      const body = document.getElementById('desktopUpdateBody');
      if (!body) return;
      body.textContent = applyTemplate(getLocalizedText(key, fallback), vars || {});
    }

    // The action button installs in place when the running build can, and
    // opens the download page otherwise: the App Store build, a package the
    // manifest has no signed entry for, or an in-app attempt that failed.
    function applyDesktopUpdateActionMode() {
      const actionBtn = document.getElementById('desktopUpdateActionBtn');
      if (!actionBtn) return;
      const inApp = Boolean(desktopUpdateState.capability && desktopUpdateState.capability.inApp);
      const key = inApp ? 'desktopUpdateInstall' : 'desktopUpdateAction';
      actionBtn.dataset.i18n = key;
      actionBtn.textContent = getLocalizedText(key, inApp ? 'Download and install' : 'Download update');
    }

    async function loadDesktopUpdateCapability() {
      if (!isTauriDesktop()) return null;
      try {
        const capability = await window.__TAURI__.core.invoke('get_desktop_update_capability');
        desktopUpdateState.capability = capability && typeof capability === 'object' ? capability : null;
      } catch (err) {
        console.info('Desktop update capability unavailable:', err);
        desktopUpdateState.capability = null;
      }
      applyDesktopUpdateActionMode();
      return desktopUpdateState.capability;
    }

    function describeDesktopUpdateError(err) {
      if (!err) return 'unknown error';
      if (typeof err === 'string') return err;
      if (err.message) return String(err.message);
      try {
        return JSON.stringify(err);
      } catch (e) {
        return String(err);
      }
    }

    // Downloads the signed package for this build through tauri-plugin-updater
    // and applies it. Resolves false when updater.json has no entry for this
    // build, so the caller can fall back to the download page.
    async function runInAppDesktopUpdate() {
      const updater = window.__TAURI__ && window.__TAURI__.updater;
      const processApi = window.__TAURI__ && window.__TAURI__.process;
      if (!updater || typeof updater.check !== 'function') {
        throw new Error('updater plugin unavailable');
      }
      desktopUpdateState.installing = true;
      setDesktopUpdateBusy(true);
      setDesktopUpdateBody('desktopUpdateChecking', {}, 'Fetching update package details…');
      try {
        const update = await updater.check();
        if (!update) return false;

        let total = 0;
        let received = 0;
        const report = () => {
          const receivedMb = formatMegabytes(received);
          if (total > 0) {
            const percent = Math.min(100, Math.round((received / total) * 100));
            setDesktopUpdateBody(
              'desktopUpdateDownloading',
              { percent, received: receivedMb, total: formatMegabytes(total) },
              'Downloading update {percent}% ({received} / {total} MB)'
            );
          } else {
            setDesktopUpdateBody(
              'desktopUpdateDownloadingUnknown',
              { received: receivedMb },
              'Downloading update… ({received} MB so far)'
            );
          }
        };
        report();
        await update.downloadAndInstall((event) => {
          if (!event || typeof event !== 'object') return;
          if (event.event === 'Started') {
            total = Number(event.data && event.data.contentLength) || 0;
            report();
          } else if (event.event === 'Progress') {
            received += Number(event.data && event.data.chunkLength) || 0;
            report();
          } else if (event.event === 'Finished') {
            setDesktopUpdateBody('desktopUpdateInstalling', {}, 'Installing… the app will restart when done.');
          }
        });
        // On Windows the plugin hands over to the installer and exits the
        // process before this resolves; macOS and Linux need the relaunch.
        setDesktopUpdateBody('desktopUpdateRestarting', {}, 'Update installed. Restarting…');
        if (processApi && typeof processApi.relaunch === 'function') {
          await processApi.relaunch();
        }
        return true;
      } finally {
        desktopUpdateState.installing = false;
        setDesktopUpdateBusy(false);
      }
    }

    async function handleDesktopUpdateAction() {
      if (desktopUpdateState.installing) return;
      const capability = desktopUpdateState.capability;
      if (capability && capability.inApp) {
        try {
          const installed = await runInAppDesktopUpdate();
          if (installed) return;
          updateDesktopUpdateBannerText();
          showToast(
            getLocalizedText(
              'desktopUpdateNoPackage',
              'No in-app update package for this build. Opening the download page.'
            ),
            6000
          );
        } catch (err) {
          console.warn('In-app update failed:', err);
          updateDesktopUpdateBannerText();
          const error = describeDesktopUpdateError(err);
          showToast(
            getInterpolatedText(
              'desktopUpdateFailed',
              { error },
              `Automatic update failed: ${error}. Opening the download page.`
            ),
            8000
          );
        }
        // Retrying the same download would just loop; from here the button
        // leads to the download page.
        desktopUpdateState.capability = { ...capability, inApp: false, reason: 'fallback' };
        applyDesktopUpdateActionMode();
      }
      await openDownloadPageForUpdate();
    }

    function initDesktopUpdateCheck() {
      const actionBtn = document.getElementById('desktopUpdateActionBtn');
      const laterBtn = document.getElementById('desktopUpdateLaterBtn');
      if (actionBtn) {
        actionBtn.addEventListener('click', () => {
          handleDesktopUpdateAction().catch((err) => {
            console.warn('Desktop update action failed:', err);
          });
        });
      }
      if (laterBtn) {
        laterBtn.addEventListener('click', () => {
          hideDesktopUpdateBanner();
        });
      }
      loadDesktopUpdateCapability().finally(() => {
        checkDesktopUpdate().catch((err) => {
          console.info('Desktop update check failed:', err);
        });
      });
    }

    initDesktopUpdateCheck();

    window.addEventListener('beforeunload', () => {
      if (lensfunRuntime.client && typeof lensfunRuntime.client.dispose === 'function') {
        try {
          lensfunRuntime.client.dispose();
        } catch (err) {
          // ignore
        }
      }
    });

    // ===========================================
    // Film Type
    // ===========================================
    const PRESET_TYPES = ['color', 'bw', 'positive'];

    function sanitizePresetType(type) {
      return PRESET_TYPES.includes(type) ? type : 'color';
    }

    function inferFilmTypeFromLegacyPreset(presetId, fallback = 'color') {
      const fallbackType = sanitizePresetType(fallback);
      const normalized = String(presetId || '').trim().toLowerCase();
      if (!normalized) return fallbackType;

      if (
        normalized.endsWith('_positive')
        || normalized.includes('positive')
        || normalized.includes('provia')
        || normalized.includes('velvia')
        || normalized.includes('ektachrome')
        || normalized.includes('slide')
      ) {
        return 'positive';
      }

      if (
        normalized.endsWith('_bw')
        || normalized.includes('bw')
        || normalized.includes('ilford')
        || normalized.includes('trix')
        || normalized.includes('tri-x')
        || normalized.includes('tmax')
        || normalized.includes('acros')
        || normalized.includes('hp5')
        || normalized.includes('fp4')
        || normalized.includes('panf')
        || normalized.includes('delta')
        || normalized.includes('sfx')
        || normalized.includes('xp2')
        || normalized.includes('neopan')
      ) {
        return 'bw';
      }

      return 'color';
    }

    function sanitizeCoreEnhancedProfile(value, fallback = 'none') {
      const normalizedFallback = CORE_ENHANCED_PROFILE_OPTIONS.has(fallback) ? fallback : 'none';
      const normalized = String(value || normalizedFallback);
      return CORE_ENHANCED_PROFILE_OPTIONS.has(normalized) ? normalized : normalizedFallback;
    }

    function sanitizeCoreColorModel(value, fallback = 'standard') {
      const fallbackRaw = String(fallback || 'standard').trim().toLowerCase();
      const fallbackMigrated = CORE_COLOR_MODEL_MIGRATION_MAP[fallbackRaw] || fallbackRaw;
      const normalizedFallback = CORE_COLOR_MODEL_OPTIONS.has(fallbackMigrated) ? fallbackMigrated : 'standard';

      const raw = String(value || normalizedFallback).trim().toLowerCase();
      const migrated = CORE_COLOR_MODEL_MIGRATION_MAP[raw] || raw;
      return CORE_COLOR_MODEL_OPTIONS.has(migrated) ? migrated : normalizedFallback;
    }

    function createDefaultLensCorrectionSettings() {
      return {
        enabled: false,
        selectedLens: null,
        params: {
          focal: 50,
          crop: 1,
          aperture: 8,
          distance: 1000,
          stepMode: 'auto',
          step: 2
        },
        modes: {
          includeTca: true,
          includeVignetting: true
        },
        lastError: ''
      };
    }

    function createInitialLensCorrectionState() {
      const base = createDefaultLensCorrectionSettings();
      return {
        enabled: base.enabled,
        selectedLens: base.selectedLens,
        params: { ...base.params },
        modes: { ...base.modes },
        lastError: base.lastError,
        search: {
          lensModel: '',
          lensMaker: '',
          cameraModel: '',
          cameraMaker: ''
        },
        searchResults: [],
        statusKey: 'lensStatusIdle',
        statusVars: {},
        source: null,
        paramTouched: {
          focal: false,
          crop: false,
          aperture: false,
          distance: false,
          stepMode: false,
          step: false
        }
      };
    }

    function sanitizeLensSelection(input, fallback = null) {
      const source = (input && typeof input === 'object') ? input : fallback;
      if (!source || typeof source !== 'object') return null;
      const handleRaw = Number(source.handle);
      const handle = Number.isFinite(handleRaw) ? Math.trunc(handleRaw) : NaN;
      if (!Number.isFinite(handle) || handle < 1) return null;
      return {
        handle,
        maker: String(source.maker || '').trim(),
        model: String(source.model || '').trim(),
        score: sanitizeNumeric(source.score, 0, 0, 1_000_000),
        minFocal: sanitizeNumeric(source.minFocal, 0, 0, 10_000),
        maxFocal: sanitizeNumeric(source.maxFocal, 0, 0, 10_000),
        minAperture: sanitizeNumeric(source.minAperture, 0, 0, 512),
        maxAperture: sanitizeNumeric(source.maxAperture, 0, 0, 512),
        cropFactor: sanitizeNumeric(source.cropFactor, 1, 0.1, 10)
      };
    }

    function sanitizeLensCorrection(input, fallback = null) {
      const fallbackValue = (fallback && typeof fallback === 'object')
        ? fallback
        : createDefaultLensCorrectionSettings();
      const source = (input && typeof input === 'object') ? input : {};
      const selectedLens = sanitizeLensSelection(source.selectedLens, fallbackValue.selectedLens);

      const fallbackParams = (fallbackValue.params && typeof fallbackValue.params === 'object')
        ? fallbackValue.params
        : createDefaultLensCorrectionSettings().params;
      const sourceParams = (source.params && typeof source.params === 'object') ? source.params : {};
      const stepMode = sourceParams.stepMode === 'manual'
        ? 'manual'
        : (fallbackParams.stepMode === 'manual' ? 'manual' : 'auto');

      const fallbackModes = (fallbackValue.modes && typeof fallbackValue.modes === 'object')
        ? fallbackValue.modes
        : createDefaultLensCorrectionSettings().modes;
      const sourceModes = (source.modes && typeof source.modes === 'object') ? source.modes : {};

      return {
        enabled: Boolean(source.enabled ?? fallbackValue.enabled),
        selectedLens,
        params: {
          focal: sanitizeNumeric(sourceParams.focal, fallbackParams.focal ?? 50, 1, 10_000),
          crop: sanitizeNumeric(sourceParams.crop, fallbackParams.crop ?? 1, 0.1, 10),
          aperture: sanitizeNumeric(sourceParams.aperture, fallbackParams.aperture ?? 8, 0.5, 512),
          distance: sanitizeNumeric(sourceParams.distance, fallbackParams.distance ?? 1000, 0.1, 100_000),
          stepMode,
          step: Math.round(sanitizeNumeric(sourceParams.step, fallbackParams.step ?? 2, 1, 16))
        },
        modes: {
          includeTca: (sourceModes.includeTca ?? fallbackModes.includeTca) !== false,
          includeVignetting: (sourceModes.includeVignetting ?? fallbackModes.includeVignetting) !== false
        },
        lastError: String(source.lastError || fallbackValue.lastError || '').slice(0, 300)
      };
    }

    // Neutral orange-mask estimate used until a real film base is detected or
    // sampled. Shared so the initial state and the per-file reset cannot drift.
    const DEFAULT_FILM_BASE = { r: 210, g: 140, b: 90 };

    // ===========================================
    // Application State
    // ===========================================
    const state = {
      // Workflow state
      currentStep: 1,  // 1=crop, 2=film base, 3=adjust

      // Image data
      loadedBaseImageData: null,    // File-loaded baseline (never transformed)
      originalImageData: null,      // Working frame (rotation, mirror); a size-only descriptor beside a crop (#244)
      croppedImageData: null,       // After cropping (still negative)
      processedImageData: null,     // After negative conversion
      displayImageData: null,       // After all adjustments
      conversionSourceImageData: null, // Lens-corrected source used for core conversion rerender
      conversionPreviewImageData: null, // Downscaled conversionSourceImageData for preview-resolution SilverCore
      previewSourceImageData: null, // Downscaled source for preview renders
      histogramSourceImageData: null, // Further downscaled source for histogram updates
      webglSourceImageData: null,   // Downscaled source for WebGL preview renders
      // A geometry build is running in the pool (#244): the planes above still
      // hold the previous geometry until geometryReady resolves.
      geometryPending: false,
      geometryReady: Promise.resolve(true),

      // 16-bit pipeline (Stage 2+) — full-precision counterparts to the 8-bit fields above.
      // Shape: { width, height, data: Uint16Array }, RGBA, range [0, 65535].
      // SilverCore Engine consumes Image16 starting in Stage 3; until then these are dormant.

      // Film settings
      filmType: 'color',
      importFilmTypeAuto: true,
      positiveMode: 'correct',
      filmTypeSource: 'manual',
      filmTypeConfidence: null,
      filmTypeReason: null,
      mirrored: false,
      filmBase: { ...DEFAULT_FILM_BASE },
      filmBaseSet: false,
      grayPointSampled: false,
      step2Mode: 'border', // 'border' | 'noBorder'
      frontierGuideAutoAppliedForImage: false,
      frontierGuideStep2ChoiceTouched: false,
      lensCorrection: createInitialLensCorrectionState(),
      rawMetadata: null,
      // Perforation / DX edge barcode reading for the current file (per-file setting).
      filmEdge: null,
      // Whole-roll analysis: the current file's share (per-file setting) ...
      rollFrame: null,

      // SilverCore conversion controls (for color/bw negatives)
      coreFilmPreset: 'none',
      coreColorModel: 'standard',
      coreEnhancedProfile: 'none',
      coreProfileStrength: 100,
      corePreSaturation: 100,
      coreBorderBuffer: 10,
      coreBorderBufferBorderValue: 10,
      coreBrightness: 0,
      coreExposure: 0,
      coreContrast: 0,
      coreHighlights: 0,
      coreShadows: 0,
      coreWhites: 0,
      coreBlacks: 0,
      coreWbMode: 'auto',
      coreTemperature: 0,
      coreTint: 0,
      // Cyan/red balance: the enlarger's C filtration.
      coreCyan: 0,
      // Paper emulation (print character after every colour decision).
      corePaper: 'none',
      corePaperToning: 'none',
      corePaperToningStrength: 100,
      // Dodge and burn strokes (per-file setting), see localExposure.js.
      localExposure: null,
      repairStrokes: [],
      // Lab-match look (colour setting, see labMatch.js).
      look: null,
      // Expired-film rescue (pipeline/expiredRescue.js). The strengths are
      // colour settings; the analysis is this frame's own measurement.
      // `expiredSession` is the separate entry: photos added while it is on
      // start rescued.
      expiredSession: false,
      expiredEnabled: false,
      expiredLevels: 100,
      expiredNeutralize: 100,
      expiredCrossover: 100,
      expiredBrightness: 0,
      expiredContrast: 25,
      expiredUnevenFog: 100,
      expiredLocalContrast: 0,
      expiredAnalysis: null,
      // Analog metadata: the roll (session-wide) and this frame (per file).
      rollMetadata: sanitizeRollMetadata({}),
      frameMetadata: sanitizeFrameMetadata({}),
      // A recovery copy of the last roll exists in IndexedDB (see rollProject.js).
      projectRecoveryAvailable: false,
      // Flat field: session registry of gain maps and the current file's choice.
      flatFields: {},
      flatFieldActiveId: null,
      flatFieldId: null,
      // Control paradigm (UI preference): 'digital' sliders or 'enlarger' head.
      controlParadigm: 'digital',
      // Dodge and burn brush UI state (session only).
      dodgeBurn: { active: false, mode: 'burn', stops: 0.5, size: 12, feather: 50, showOverlay: true },
      coreSaturation: 100,
      coreGlow: 0,
      coreFade: 0,
      coreCurvePrecision: 'auto',
      coreUseWebGL: true,

      // White balance multipliers
      wbR: 1.0,
      wbG: 1.0,
      wbB: 1.0,
      // Provenance of the current gains: null = defaults / user-owned,
      // 'high' | 'medium' = set by the automatic gray-point estimator.
      wbAutoConfidence: null,
      wbSemanticApplied: false,
      // True once the user touches the RGB gain sliders directly; the
      // estimator then keeps its hands off this image.
      wbUserOverride: false,

      // Tone adjustments
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,

      // Color adjustments
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,

      // CMY
      cyan: 0,
      magenta: 0,
      yellow: 0,

      // Curves (256-value lookup tables)
      curves: { r: null, g: null, b: null },
      // Control points for each channel [{x, y}, ...] sorted by x
      curvePoints: {
        r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        b: [{ x: 0, y: 0 }, { x: 255, y: 255 }]
      },

      // Zoom/Pan state
      zoomLevel: 1,
      panX: 0,
      panY: 0,
      isPanning: false,
      panStartX: 0,
      panStartY: 0,
      panStartPanX: 0,
      panStartPanY: 0,

      // UI state
      cropping: false,
      cropStart: null,
      cropDraft: null,
      croppingActive: false,
      samplingMode: null,  // null, 'filmBase', 'whiteBalance'
      rotationAngle: 0,
      beforeAfterActive: false,
      beforeAfterSource: null, // null | 'button' | 'shortcut'

      autoFrame: {
        enabled: true,
        onImport: true,
        marginRatio: 0.02,
        minConfidence: 0.55,
        highConfidence: 0.72,
        autoApplyHighConfidence: true,
        formatPreference: 'auto', // 'auto' | '135' | '120'
        allowed120Formats: Object.fromEntries(AUTO_FRAME_DEFAULT_120_FORMATS.map(format => [format, true])),
        lowConfidenceBehavior: 'suggest', // 'suggest' | 'rotateOnly' | 'ignore'
        rotate180Default: false,
        lastDiagnostics: null
      },

      // Batch mode state
      batchMode: false,
      batchSessionActive: false,
      // fileQueue item: {id, file, selected, status, error, settings: null | {...}, isDirty: boolean}
      // settings = null means use auto-detect for film base
      fileQueue: [],
      fileListSort: normalizeFileListSort(safeStorageGet('nc_photo_sort_v1')),
      currentFileIndex: 0,
      // Saved crop region for current image (used when saving settings)
      cropRegion: null,

      // Roll-level reference profile (session scoped)
      rollReference: {
        enabled: false,
        sourceFileId: null,
        settingsSnapshot: null,
        applyLock: false,
        applyCrop: false
      },
      // ... and the roll-wide result (session scoped, like the roll reference).
      rollAnalysis: {
        id: null,
        filmBase: null,
        channelData: null,
        count: 0,
        usable: 0,
        outlierCount: 0,
        outliers: [],
        equalize: true
      },

      // Dust removal
      dustRemoval: {
        enabled: false,
        strength: 3,
        maxParticleSize: 40,   // px at full resolution; scaled down for preview detection
        mask: null,          // Uint8Array (h*w)
        showMask: false,
        processing: false,
        particleCount: 0,
        _state: null,        // Internal state for updateDustStrength
        inpaintedImageData: null, // ImageData after inpainting
        // Bumped whenever the mask or the repaired image changes, including
        // in-place brush patches; staleness checks compare it, not identity.
        revision: 0,
        maskTag: null,       // names the mask's content for the dust worker's copy
        brushSize: 5,
        ai: true,            // MI-GAN by default; loaded on intent (ensureAiRepairPreload)
      },

      // Export settings
      exportFormat: 'png',  // 'png' | 'jpeg' | 'tiff'
      exportBitDepth: 8,    // 8 | 16
      jpegQuality: 92,      // 1-100
      sprocketPreviewEnabled: false,
      exportSprocketHolesEnabled: false,
      sprocketEdge: createSprocketEdgeSettings(),

      // Render state
      lastRenderQuality: 'full', // 'full' | 'preview' | 'gl'
      processedImageDataIsPreview: false,
      fullResolutionPending: false,
      fullResolutionPromise: null
    };
    stateReady = true;
    updateGrayPointGuideUI();

    // Dust brush bookkeeping (#259). Tags name mask contents for the dust
    // worker's copy; the refresh queue holds brush rects whose learned repair
    // (MI-GAN) has not been redone since TELEA patched them.
    let dustMaskTagSequence = 0;
    const dustAiRefresh = { rects: [], timer: null };

    let fullResolutionRenderTimer = null;

    // Geometry chain state (#244), declared before any code can run a
    // geometry path; the functions live in the geometry chain section.
    const geometryMemo = new WeakMap();
    const geometryBaseIds = new WeakMap();
    let nextGeometryBaseId = 1;
    // The import's auto-frame worker already rotated a copy of the base by the
    // angle it detected. restoreSettings adopts that frame (side channel, not
    // part of the settings) instead of rotating the base a second time.
    let pendingImportRotation = null;
    const geometryPool = createGeometryPool();
    let geometryToken = 0;
    let geometryJob = null;
    let geometryBusyOwner = null;
    let interimGeometry = null;
    // Debug counters for tests and the smoke run: reads of plane pixels while
    // a build was pending (must stay 0), synchronous full-frame fallbacks,
    // full-resolution rotations adopted from or built by the auto-frame
    // worker, and full-resolution rotations built on the main thread. The
    // pool counts its own jobs (window.__ncGeometry.pool).
    const geometryDiagnostics = {
      pendingReads: 0, frameSyncReads: 0, adoptedRotations: 0, workerRotations: 0, mainRotations: 0, coldRestores: 0,
      // Smoke-run switch: cache photo sessions without their planes, as a
      // 60 MP session that does not fit the budget is.
      coldSessions: false
    };

    function clearFullResolutionRenderState() {
      if (fullResolutionRenderTimer) {
        clearTimeout(fullResolutionRenderTimer);
        fullResolutionRenderTimer = null;
      }
      state.processedImageDataIsPreview = false;
      state.fullResolutionPending = false;
      state.fullResolutionPromise = null;
    }

    // ===========================================
    // Localized text helpers (toast + text utils now live in modules)
    // ===========================================
    function getInterpolatedText(key, replacements = {}, fallback = '') {
      return interpolateText(getLocalizedText(key, fallback), replacements);
    }

    function updateDesktopBatchExportUI() {
      const container = document.getElementById('headerExportProgress');
      const label = document.getElementById('headerExportProgressLabel');
      const file = document.getElementById('headerExportProgressFile');
      const fill = document.getElementById('headerExportProgressFill');
      if (!container || !label || !file || !fill) return;

      const show = isTauriDesktop() && desktopBatchExportState.active;
      container.classList.toggle('visible', show);
      container.setAttribute('aria-hidden', show ? 'false' : 'true');

      if (!show) {
        fill.style.width = '0%';
        file.textContent = '';
        label.textContent = getInterpolatedText(
          'desktopBatchExportProgress',
          { current: 0, total: 0 },
          'Exporting 0 / 0'
        );
        return;
      }

      label.textContent = hiddenJobs.paused ? hiddenJobPausedText() : getInterpolatedText(
        'desktopBatchExportProgress',
        {
          current: desktopBatchExportState.current,
          total: desktopBatchExportState.total
        },
        `Exporting ${desktopBatchExportState.current} / ${desktopBatchExportState.total}`
      );
      file.textContent = desktopBatchExportState.fileName || summarizePathForUi(desktopBatchExportState.targetDirectory);
      fill.style.width = `${Math.max(0, Math.min(100, desktopBatchExportState.percent || 0))}%`;
    }

    function setDesktopBatchExportState(patch = {}) {
      const wasActive = desktopBatchExportState.active;
      Object.assign(desktopBatchExportState, patch);
      updateDesktopBatchExportUI();
      if (wasActive !== desktopBatchExportState.active) {
        updateDesktopBatchExportControlLock();
      }
      if (stateReady && typeof updateExportButtons === 'function' && wasActive !== desktopBatchExportState.active) {
        updateExportButtons();
      }
    }

    function resetDesktopBatchExportState() {
      setDesktopBatchExportState({
        active: false,
        current: 0,
        total: 0,
        percent: 0,
        fileName: '',
        targetDirectory: ''
      });
    }

    function setUploadLabelDisabled(label, disabled, inputId) {
      if (!label) return;
      label.classList.toggle('is-disabled', Boolean(disabled));
      label.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (disabled) {
        label.removeAttribute('for');
        label.tabIndex = -1;
        return;
      }
      label.setAttribute('for', inputId);
      label.tabIndex = 0;
    }

    function isDesktopBatchExportLocked() {
      return isTauriDesktop() && desktopBatchExportState.active;
    }

    function updateDesktopBatchExportControlLock() {
      const locked = isDesktopBatchExportLocked();
      [
        'studioNewSession',
        'studioRestart',
        'selectAllBtn',
        'selectNoneBtn',
        'addMoreFilesBtn',
        'addFilesToolbarBtn',
        'clearFileListBtn',
        'saveSettingsBtn',
        'applyToSelectedBtn'
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = locked;
      });

      setUploadLabelDisabled(document.getElementById('uploadBtn'), locked, 'fileInput');
      if (locked) {
        setUploadLabelDisabled(document.getElementById('uploadFolderBtn'), true, 'folderInput');
      } else if (typeof applyFolderPickerAvailability === 'function') {
        applyFolderPickerAvailability();
      }
    }

    function handleSaveResult(result, {
      cancelledKey,
      cancelledFallback,
      savedPathKey,
      savedPathFallback,
      savedFileKey,
      savedFileFallback,
      browserSuccessKey,
      browserSuccessFallback,
      toastDurationMs = 3500
    } = {}) {
      if (!result || !result.saved) {
        showToast(getLocalizedText(cancelledKey, cancelledFallback), toastDurationMs);
        return false;
      }

      if (result.path && savedFileKey) {
        const name = String(result.path).split(/[\\/]/).pop() || String(result.path);
        showToast(getInterpolatedText(savedFileKey, { name }, savedFileFallback), toastDurationMs);
      } else if (result.path && savedPathKey) {
        void appAlert(getInterpolatedText(savedPathKey, { path: result.path }, savedPathFallback));
      } else if (browserSuccessKey) {
        showToast(getLocalizedText(browserSuccessKey, browserSuccessFallback), toastDurationMs);
      }

      return true;
    }

    // ===========================================
    // Undo / Redo System
    // ===========================================
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 30;

    const undoLabelMap = {
      zh: {
        rotation: '旋转', mirror: '镜像', crop: '裁剪', filmType: '胶片类型',
        curveEdit: '曲线编辑', curvePointDelete: '删除曲线点', curvePreset: '曲线预设',
        curveReset: '重置曲线', dustBrushStroke: '除尘笔刷', dustToggle: '除尘开关',
        filmBase: '色罩基准', whiteBalance: '白平衡', autoDetectBase: '自动检测色罩',
        filmEdgeApply: '应用片边识别', filmEdgeBase: '片边片基', rollAnalysis: '整卷分析',
        testStrip: '试条', dodgeBurn: '加减光', enlarger: '放大机', flatField: '平场校正', labMatch: '匹配店扫', coreCyan: '青 / 红', corePaper: '相纸', corePaperToning: '调色', corePaperToningStrength: '调色强度',
        expiredEnabled: '过期卷矫正开关', expiredReset: '过期卷：恢复自动值', expiredAnalyze: '过期卷：重新分析',
        expiredLevels: '过期卷：去雾与范围', expiredNeutralize: '过期卷：中和偏色', expiredCrossover: '过期卷：交叉偏色',
        expiredBrightness: '过期卷：亮度补偿', expiredContrast: '过期卷：对比恢复',
        expiredUnevenFog: '过期卷：不均匀雾化', expiredLocalContrast: '过期卷：局部对比',
        coreExposure: '曝光', coreContrast: '对比度', coreHighlights: '高光',
        coreShadows: '阴影', coreWhites: '白色', coreBlacks: '黑色',
        coreBrightness: '亮度', coreTemperature: '色温', coreTint: '色调',
        coreSaturation: '饱和度', coreGlow: '辉光', coreFade: '褪色',
        coreWbMode: '白平衡模式', coreFilmPreset: '胶片预设',
        coreColorModel: '色彩模型', coreEnhancedProfile: '增强曲线',
        coreProfileStrength: '曲线强度', corePreSaturation: '预饱和度',
        coreBorderBuffer: '边框缓冲', coreBorderBufferBorderValue: '边框阈值',
        coreCurvePrecision: '曲线精度', coreUseWebGL: 'WebGL渲染',
        exposure: '曝光微调', contrast: '对比度微调', highlights: '高光微调',
        shadows: '阴影微调', temperature: '色温微调', tint: '色调微调',
        vibrance: '自然饱和度', saturation: '饱和度微调',
        cyan: '青色', magenta: '品红', yellow: '黄色',
        dustStrength: '除尘灵敏度', dustMaxSize: '最大颗粒尺寸', dustBrushSize: '笔刷大小',
        consoleReset: '校正台重置',
      },
      en: {
        rotation: 'Rotation', mirror: 'Mirror', crop: 'Crop', filmType: 'Film Type',
        curveEdit: 'Curve Edit', curvePointDelete: 'Delete Curve Point', curvePreset: 'Curve Preset',
        curveReset: 'Reset Curves', dustBrushStroke: 'Dust Brush', dustToggle: 'Dust Toggle',
        filmBase: 'Film Base', whiteBalance: 'White Balance', autoDetectBase: 'Auto Detect Base',
        filmEdgeApply: 'Apply Detected Film', filmEdgeBase: 'Rebate Film Base', rollAnalysis: 'Roll Analysis',
        testStrip: 'Test Strip', dodgeBurn: 'Dodge and Burn', enlarger: 'Enlarger', flatField: 'Flat Field', labMatch: 'Match Lab Scan', coreCyan: 'Cyan / Red', corePaper: 'Paper', corePaperToning: 'Toning', corePaperToningStrength: 'Toning Strength',
        expiredEnabled: 'Expired-film rescue', expiredReset: 'Expired film: automatic values', expiredAnalyze: 'Expired film: analyse again',
        expiredLevels: 'Expired film: fog and range', expiredNeutralize: 'Expired film: neutralise cast', expiredCrossover: 'Expired film: crossover',
        expiredBrightness: 'Expired film: brightness', expiredContrast: 'Expired film: contrast',
        expiredUnevenFog: 'Expired film: uneven fog', expiredLocalContrast: 'Expired film: local contrast',
        coreExposure: 'Exposure', coreContrast: 'Contrast', coreHighlights: 'Highlights',
        coreShadows: 'Shadows', coreWhites: 'Whites', coreBlacks: 'Blacks',
        coreBrightness: 'Brightness', coreTemperature: 'Temperature', coreTint: 'Tint',
        coreSaturation: 'Saturation', coreGlow: 'Glow', coreFade: 'Fade',
        coreWbMode: 'WB Mode', coreFilmPreset: 'Film Preset',
        coreColorModel: 'Color Model', coreEnhancedProfile: 'Enhanced Profile',
        coreProfileStrength: 'Profile Strength', corePreSaturation: 'Pre-Saturation',
        coreBorderBuffer: 'Border Buffer', coreBorderBufferBorderValue: 'Border Threshold',
        coreCurvePrecision: 'Curve Precision', coreUseWebGL: 'WebGL',
        exposure: 'Exposure Fine', contrast: 'Contrast Fine', highlights: 'Highlights Fine',
        shadows: 'Shadows Fine', temperature: 'Temperature Fine', tint: 'Tint Fine',
        vibrance: 'Vibrance', saturation: 'Saturation Fine',
        cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow',
        dustStrength: 'Dust Sensitivity', dustMaxSize: 'Max Particle Size', dustBrushSize: 'Brush Size',
        consoleReset: 'Console Reset',
      },
      ja: {
        rotation: '回転', mirror: 'ミラー', crop: 'トリミング', filmType: 'フィルムタイプ',
        curveEdit: 'カーブ編集', curvePointDelete: 'カーブポイント削除', curvePreset: 'カーブプリセット',
        curveReset: 'カーブリセット', dustBrushStroke: '除塵ブラシ', dustToggle: '除塵切替',
        filmBase: 'フィルムベース', whiteBalance: 'ホワイトバランス', autoDetectBase: '自動検出',
        filmEdgeApply: 'フィルム縁を適用', filmEdgeBase: '縁のベース', rollAnalysis: 'ロール解析',
        testStrip: 'テストストリップ', dodgeBurn: '覆い焼き・焼き込み', enlarger: '引き伸ばし機', flatField: 'フラットフィールド', labMatch: 'ラボスキャンに合わせる', coreCyan: 'シアン / 赤', corePaper: '印画紙', corePaperToning: '調色', corePaperToningStrength: '調色の強さ',
        expiredEnabled: '期限切れ補正の切替', expiredReset: '期限切れ：自動値に戻す', expiredAnalyze: '期限切れ：再解析',
        expiredLevels: '期限切れ：かぶりと階調範囲', expiredNeutralize: '期限切れ：色かぶりの中和', expiredCrossover: '期限切れ：クロスオーバー',
        expiredBrightness: '期限切れ：明るさ補正', expiredContrast: '期限切れ：コントラスト',
        expiredUnevenFog: '期限切れ：かぶりのむら', expiredLocalContrast: '期限切れ：局所コントラスト',
        coreExposure: '露出', coreContrast: 'コントラスト', coreHighlights: 'ハイライト',
        coreShadows: 'シャドウ', coreWhites: 'ホワイト', coreBlacks: 'ブラック',
        coreBrightness: '明るさ', coreTemperature: '色温度', coreTint: '色合い',
        coreSaturation: '彩度', coreGlow: 'グロー', coreFade: 'フェード',
        coreWbMode: 'WBモード', coreFilmPreset: 'フィルムプリセット',
        coreColorModel: 'カラーモデル', coreEnhancedProfile: '強化プロファイル',
        coreProfileStrength: 'プロファイル強度', corePreSaturation: 'プリサチュレーション',
        coreBorderBuffer: 'ボーダーバッファ', coreBorderBufferBorderValue: 'ボーダー閾値',
        coreCurvePrecision: 'カーブ精度', coreUseWebGL: 'WebGL',
        exposure: '露出微調整', contrast: 'コントラスト微調整', highlights: 'ハイライト微調整',
        shadows: 'シャドウ微調整', temperature: '色温度微調整', tint: '色合い微調整',
        vibrance: '自然な彩度', saturation: '彩度微調整',
        cyan: 'シアン', magenta: 'マゼンタ', yellow: 'イエロー',
        dustStrength: '除塵感度', dustMaxSize: '最大粒子サイズ', dustBrushSize: 'ブラシサイズ',
        consoleReset: 'コンソールリセット',
      }
    };

    function getUndoLabel(label) {
      if (label === 'rollFilmType') return getLocalizedText('applyFilmTypeToRoll', 'Apply film type to roll');
      if (studioWorkspace && label === 'colorCorrect') return studioWorkspace.text('colorCorrect');
      if (studioWorkspace && label === 'studioStyle') return studioWorkspace.text('look');
      if (studioWorkspace && label === 'studioReset') return studioWorkspace.text('reset');
      const map = undoLabelMap[currentLang] || undoLabelMap.en;
      return map[label] || label;
    }

    // Snapshot keys for Category A (lightweight, deep-copied)
    const SNAPSHOT_SCALAR_KEYS = [
      'reviewed', 'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
      'vibrance', 'saturation', 'cyan', 'magenta', 'yellow',
      'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
      'corePreSaturation', 'coreBorderBuffer', 'coreBorderBufferBorderValue',
      'coreBrightness', 'coreExposure', 'coreContrast', 'coreHighlights', 'coreShadows',
      'coreWhites', 'coreBlacks', 'coreWbMode', 'coreTemperature', 'coreTint',
      'coreSaturation', 'coreGlow', 'coreFade', 'coreCurvePrecision', 'coreUseWebGL',
      'coreCyan', 'corePaper', 'corePaperToning', 'corePaperToningStrength', 'flatFieldId',
      'wbR', 'wbG', 'wbB', 'wbAutoConfidence', 'wbUserOverride', 'wbSemanticApplied',
      'filmType', 'positiveMode', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason', 'filmBaseSet', 'grayPointSampled', 'step2Mode', 'rotationAngle',
      'mirrored', 'sprocketPreviewEnabled', 'currentStep',
      'expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover', 'expiredBrightness', 'expiredContrast',
      'expiredUnevenFog', 'expiredLocalContrast',
    ];

    // Category B: heavy image data (stored by reference)
    const SNAPSHOT_REF_KEYS = [
      'originalImageData', 'croppedImageData', 'processedImageData',
      'conversionSourceImageData', 'conversionPreviewImageData', 'previewSourceImageData',
      'histogramSourceImageData', 'webglSourceImageData',
    ];

    function captureSnapshot(label) {
      // The snapshot keeps the frame on screen; its 16-bit plane attaches to
      // that same object when the commit lands.
      requestCorePreviewCommit();
      const settings = {};
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        settings[key] = state[key];
      }
      // A roll action changes multiple detached settings records. Capture them
      // with the live state so Undo/Redo is atomic across the whole import.
      if (label === 'rollAnalysis' || label === 'rollFilmType') {
        settings.rollTransaction = {
          analysis: structuredClone(state.rollAnalysis),
          frames: state.fileQueue.map(item => ({ id: item.id, filmTypeOverride: item.filmTypeOverride ? { ...item.filmTypeOverride } : null, settings: item.settings ? structuredClone(item.settings) : null, thumbnail: item.thumbnail, status: item.status }))
        };
      }
      settings.semanticMap = state.semanticMap ? structuredClone(state.semanticMap) : null;
      settings.rollFrame = state.rollFrame ? structuredClone(state.rollFrame) : null;
      // Deep copy objects
      settings.filmBase = state.filmBase ? { ...state.filmBase } : null;
      settings.cropRegion = state.cropRegion ? { ...state.cropRegion } : null;
      // Deep copy curves
      settings.curves = {
        r: state.curves.r ? new Uint8Array(state.curves.r) : null,
        g: state.curves.g ? new Uint8Array(state.curves.g) : null,
        b: state.curves.b ? new Uint8Array(state.curves.b) : null,
      };
      settings.curvePoints = {
        r: state.curvePoints.r.map(p => ({ ...p })),
        g: state.curvePoints.g.map(p => ({ ...p })),
        b: state.curvePoints.b.map(p => ({ ...p })),
      };
      // Dust removal settings
      settings.dustRemoval = {
        enabled: state.dustRemoval.enabled,
        strength: state.dustRemoval.strength,
        maxParticleSize: state.dustRemoval.maxParticleSize,
        brushSize: state.dustRemoval.brushSize,
        showMask: state.dustRemoval.showMask,
      };
      settings.sprocketEdge = createSprocketEdgeSettings(state.sprocketEdge);
      settings.lensCorrection = structuredClone(state.lensCorrection);
      settings.filmEdge = state.filmEdge ? structuredClone(state.filmEdge) : null;
      settings.learnedDefaults = state.learnedDefaults ? structuredClone(state.learnedDefaults) : null;
      settings.localExposure = state.localExposure ? structuredClone(state.localExposure) : null;
      settings.repairStrokes = structuredClone(state.repairStrokes);
      settings.look = state.look ? structuredClone(state.look) : null;
      settings.expiredAnalysis = state.expiredAnalysis ? structuredClone(state.expiredAnalysis) : null;
      settings.frameMetadata = sanitizeFrameMetadata(state.frameMetadata);
      settings.autoFrameMeta = state.autoFrame.lastDiagnostics ? structuredClone(state.autoFrame.lastDiagnostics) : null;

      // Category B: references. While geometry is being rebuilt the planes
      // still belong to the previous geometry, so the snapshot keeps only its
      // scalars and a restore rebuilds the pixels from them (#244).
      if (state.geometryPending) return { label, settings, refs: { cold: true } };
      const refs = {};
      for (const key of SNAPSHOT_REF_KEYS) {
        refs[key] = state[key];
      }
      // A reduced preview-tier session (#263) swaps the conversion preview on
      // screen only; history keeps the normal-tier object.
      if (previewTierKept && previewTierKept.source === state.conversionSourceImageData
        && reducedDisplayImages.has(refs.conversionPreviewImageData)) {
        refs.conversionPreviewImageData = previewTierKept.preview;
      }
      // Dust refs
      refs.dustMask = state.dustRemoval.mask;
      refs.dustMaskTag = state.dustRemoval.maskTag;
      refs.dustInpaintedImageData = state.dustRemoval.inpaintedImageData;
      refs.dustCleanSource = state.dustRemoval.cleanSource || null;
      refs.dustState = state.dustRemoval._state;

      return { label, settings, refs };
    }

    function cancelPendingTimers() {
      dustDetectionRevision += 1;
      if (fullUpdateTimer) { clearTimeout(fullUpdateTimer); fullUpdateTimer = null; }
      clearCoreReprocessTimer();
      coreReprocessScheduled = null;
      releaseCorePreviewRetained();
      if (displayPreviewResizeTimer) { clearTimeout(displayPreviewResizeTimer); displayPreviewResizeTimer = null; }
      if (step2AutoConvertTimer) { clearTimeout(step2AutoConvertTimer); step2AutoConvertTimer = null; }
      if (dustDetectionTimer) { clearTimeout(dustDetectionTimer); dustDetectionTimer = null; }
    }

    // Returns a promise when the snapshot kept no pixels (a cold entry, #244):
    // it resolves once the planes are rebuilt and converted.
    function restoreSnapshot(snapshot, { reprocess = true, previewOnly = false } = {}) {
      cancelPendingTimers();
      coreReprocessToken += 1;
      // A pending geometry build belongs to the state being replaced.
      cancelGeometryJob();

      // Restore Category A
      const s = snapshot.settings;
      state.semanticMap = s.semanticMap ? structuredClone(s.semanticMap) : null;
      state.rollFrame = s.rollFrame ? structuredClone(s.rollFrame) : null;
      if (s.rollTransaction) {
        state.rollAnalysis = structuredClone(s.rollTransaction.analysis);
        for (const frame of s.rollTransaction.frames) {
          const item = state.fileQueue.find(item => item.id === frame.id);
          if (item) Object.assign(item, { settings: frame.settings ? structuredClone(frame.settings) : null, thumbnail: frame.thumbnail, status: frame.status, filmTypeOverride: frame.filmTypeOverride, isDirty: false });
        }
        invalidateSilverCoreCache();
        updateRollAnalysisUI();
        updateFileListUI();
      }
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        state[key] = s[key];
      }
      updateMirrorButtonState();
      updateFileListUI();
      state.filmBase = s.filmBase ? { ...s.filmBase } : { r: 210, g: 140, b: 90 };
      state.cropRegion = s.cropRegion ? { ...s.cropRegion } : null;
      state.curves = {
        r: s.curves.r ? new Uint8Array(s.curves.r) : null,
        g: s.curves.g ? new Uint8Array(s.curves.g) : null,
        b: s.curves.b ? new Uint8Array(s.curves.b) : null,
      };
      state.curvePoints = {
        r: s.curvePoints.r.map(p => ({ ...p })),
        g: s.curvePoints.g.map(p => ({ ...p })),
        b: s.curvePoints.b.map(p => ({ ...p })),
      };
      state.dustRemoval.enabled = s.dustRemoval.enabled;
      state.dustRemoval.strength = s.dustRemoval.strength;
      if (Number.isFinite(s.dustRemoval.maxParticleSize)) {
        state.dustRemoval.maxParticleSize = s.dustRemoval.maxParticleSize;
      }
      state.dustRemoval.brushSize = s.dustRemoval.brushSize;
      state.dustRemoval.showMask = s.dustRemoval.showMask;
      state.sprocketEdge = createSprocketEdgeSettings(s.sprocketEdge);
      if (s.lensCorrection) state.lensCorrection = structuredClone(s.lensCorrection);
      state.filmEdge = s.filmEdge ? structuredClone(s.filmEdge) : null;
      state.learnedDefaults = s.learnedDefaults ? structuredClone(s.learnedDefaults) : null;
      updateLensCorrectionUI();
      updateFilmEdgeUI();
      state.localExposure = s.localExposure ? structuredClone(s.localExposure) : null;
      // A fresh array per restore, as before the sanitiser cache: in-flight
      // repairs compare state.repairStrokes by identity.
      state.repairStrokes = sanitizeRepairStrokes(s.repairStrokes).slice();
      state.look = s.look ? structuredClone(s.look) : null;
      state.expiredAnalysis = s.expiredAnalysis ? structuredClone(s.expiredAnalysis) : null;
      state.frameMetadata = sanitizeFrameMetadata(s.frameMetadata);
      updateDodgeBurnUI();
      updateLabMatchUI();
      updateExpiredRescueUI();
      updateMetadataUI();
      state.autoFrame.lastDiagnostics = s.autoFrameMeta ? structuredClone(s.autoFrameMeta) : null;

      // Restore Category B refs
      const r = snapshot.refs;
      if (r.cold) return restoreColdSnapshotPixels(s);
      for (const key of SNAPSHOT_REF_KEYS) {
        state[key] = r[key];
      }
      state.dustRemoval.mask = r.dustMask;
      state.dustRemoval.maskTag = r.dustMask ? (r.dustMaskTag ?? nextDustMaskTag()) : null;
      state.dustRemoval.inpaintedImageData = r.dustInpaintedImageData;
      state.dustRemoval.cleanSource = r.dustCleanSource;
      state.dustRemoval._state = r.dustState;
      noteDustReplaced();
      // After the revision moves: a carried stamp names the restored state.
      if (!reprocess) carryRestoredRepairStamp();

      // Sync UI
      updateFilmModeUI();
      updateSlidersFromState();
      renderCurve();
      updateDustControlsVisibility();
      updateSprocketControlsUI();

      // Re-render
      if (state.processedImageData) {
        applyProcessedImageToState(state.processedImageData, { previewOnly });
        if (reprocess && usesSilverCoreConversion(state)) {
          rerenderWithCoreControls({
            full: true, token: coreReprocessToken, sourceRef: state.conversionSourceImageData
          }).catch(() => {});
        } else {
          updateFull();
        }
      } else {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (sourceData) {
          displayNegative(sourceData);
          updateCanvasVisibility();
        }
      }
      goToStep(s.currentStep);
      // A reprocessing restore re-detects dust and pins again when that lands.
      if (!reprocess || !state.dustRemoval.enabled || !state.dustRemoval.showMask) syncDustWorkerPin();
    }

    // A cold history entry keeps its scalars only: rotationAngle, mirrored and
    // cropRegion are exact, so its planes are rebuilt from the base in the
    // pool while the current frame stays on screen, then converted without
    // new automatic measurements. It never falls back to the negative.
    function restoreColdSnapshotPixels(s) {
      geometryDiagnostics.coldRestores++;
      invalidateProcessedPipelineState();
      const base = state.loadedBaseImageData;
      const installed = installedGeometryKey();
      if (base && (!installed || installed.baseId !== geometryBaseId(base))) {
        // Another photo's planes (a session restore) must not stand in for
        // this one's while they are rebuilt.
        state.originalImageData = createGeometryFrame(base, geometryKeyFor(base, { rotationAngle: state.rotationAngle, mirrored: state.mirrored }));
        state.croppedImageData = null;
      }
      state.dustRemoval.mask = null;
      state.dustRemoval.maskTag = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.cleanSource = null;
      state.dustRemoval._state = null;
      noteDustReplaced();
      updateFilmModeUI();
      updateSlidersFromState();
      renderCurve();
      updateDustControlsVisibility();
      updateSprocketControlsUI();
      const step = s.currentStep;
      const ready = applyGeometryFromBase({ cropRegion: state.cropRegion });
      return afterGeometry(ready, async isCurrent => {
        if (step >= 3) {
          await convertAfterGeometryEdit(isCurrent, { quiet: true, automatic: false });
        } else {
          const sourceData = state.croppedImageData || state.originalImageData;
          if (sourceData) {
            displayNegative(sourceData);
            updateCanvasVisibility();
          }
          goToStep(step);
        }
      });
    }

    // Snapshots hold references to up to eight full-resolution buffers each.
    // Slider moves share them, but every rotate/crop/dust operation makes new
    // ones, so a handful of transforms on a large scan can pin gigabytes.
    // History budgets only the bytes it holds exclusively: buffers live state
    // holds anyway do not count (#244). Over budget, the oldest entries lose
    // their pixel references and become cold instead of being dropped; a cold
    // entry restores its exact scalars and rebuilds its pixels from the base.
    // The most recent geometry entry stays hot, so undoing the last geometry
    // edit remains an instant reference swap.
    const HISTORY_MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;
    const GEOMETRY_UNDO_LABELS = new Set(['crop', 'rotation', 'mirror', 'autoFrame', 'restoreFullFrame']);

    function liveHistoryRoots() {
      return [
        ...SNAPSHOT_REF_KEYS.map(key => state[key]), state.loadedBaseImageData, state.displayImageData,
        state.dustRemoval.mask, state.dustRemoval.inpaintedImageData, state.dustRemoval.cleanSource, state.dustRemoval._state
      ];
    }

    function hotGeometrySnapshot() {
      for (let i = undoStack.length - 1; i >= 0; i--) {
        if (GEOMETRY_UNDO_LABELS.has(undoStack[i].label)) return undoStack[i].refs.cold ? null : undoStack[i];
      }
      return null;
    }

    // Bytes reachable only through history, once per ArrayBuffer. `spared`
    // entries count as owned elsewhere (the hot geometry snapshot).
    function historyExclusiveBytes(spared = null) {
      const owned = backingBuffers([liveHistoryRoots(), spared?.refs || null]);
      let bytes = 0;
      // A dust-stroke entry (#259) holds its changed bytes and the objects it
      // patches; live state usually owns the latter.
      for (const buffer of backingBuffers([...undoStack, ...redoStack].map(entry => entry.dustDelta || entry.refs))) {
        if (!owned.has(buffer)) bytes += buffer.byteLength;
      }
      return bytes;
    }

    function pruneHistoryForMemory() {
      const hot = hotGeometrySnapshot();
      // Oldest first: the bottom of the undo stack, then the far end of redo.
      const order = [...undoStack, ...redoStack.slice().reverse()];
      for (const snapshot of order) {
        if (historyExclusiveBytes(hot) <= HISTORY_MEMORY_BUDGET_BYTES) return;
        if (snapshot === hot || snapshot.dustDelta || snapshot.refs.cold) continue;
        // Only references are dropped; buffers are never detached, so the
        // session cache and live state keep theirs.
        snapshot.refs = { cold: true };
      }
      // A dust-stroke entry (#259) patches the objects it holds and cannot go
      // cold. One that still pins objects live state has let go of is dropped
      // with everything older on its stack, so undo and redo stay LIFO.
      for (const stack of [undoStack, redoStack]) {
        for (let i = 0; i < stack.length; i++) {
          if (historyExclusiveBytes(hot) <= HISTORY_MEMORY_BUDGET_BYTES) return;
          if (!stack[i].dustDelta) continue;
          stack.splice(0, i + 1);
          i = -1;
        }
      }
    }

    function commitUndoSnapshot(snapshot) {
      undoStack.push(snapshot);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      pruneHistoryForMemory();
      redoStack.length = 0;
      updateUndoRedoButtons();
    }

    function noteManualEdit(label) {
      if (['rollAnalysis', 'semanticColor'].includes(label)) return;
      manualEditRevision++;
      const item = getCurrentQueueItem();
      if (item) {
        item.userEdited = true;
        if ([...LEARNED_NUMERIC_KEYS, ...LEARNED_CATEGORY_KEYS].includes(label)) (item.touchedKeys ||= new Set()).add(label);
      }
    }

    function pushUndo(label) {
      noteManualEdit(label);
      commitUndoSnapshot(captureSnapshot(label));
      if (['crop', 'rotation', 'mirror', 'autoFrame', 'restoreFullFrame'].includes(label)) state.semanticMap = null;
    }

    // A dust-brush stroke: the entry holds the bytes it changed (see
    // dustStrokeHistory.js), with pushUndo's side effects.
    function pushUndoDelta(label, dustDelta) {
      noteManualEdit(label);
      commitUndoSnapshot({ label, dustDelta });
    }

    function performUndo() {
      if (document.body.dataset.photoSwitching === 'true') return;
      if (undoStack.length === 0) {
        showToast(getLocalizedText('nothingToUndo', 'Nothing to undo'));
        return;
      }
      manualEditRevision++;
      if (getCurrentQueueItem()) getCurrentQueueItem().userEdited = true;
      const snapshot = undoStack.pop();
      let restoring = null;
      if (snapshot.dustDelta) {
        // In place, without a conversion or a new detection (#259).
        restoreDustDelta(snapshot.dustDelta, 'undo');
        redoStack.push(snapshot);
      } else {
        // Carry the action's own label across so the redo toast names the
        // action rather than the literal word "undo".
        redoStack.push(captureSnapshot(snapshot.label));
        restoring = restoreSnapshot(snapshot);
      }
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('undone', 'Undone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
      return restoring;
    }

    function performRedo() {
      if (document.body.dataset.photoSwitching === 'true') return;
      if (redoStack.length === 0) {
        showToast(getLocalizedText('nothingToRedo', 'Nothing to redo'));
        return;
      }
      manualEditRevision++;
      if (getCurrentQueueItem()) getCurrentQueueItem().userEdited = true;
      const snapshot = redoStack.pop();
      undoStack.push(snapshot.dustDelta ? snapshot : captureSnapshot(snapshot.label));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      pruneHistoryForMemory();
      let restoring = null;
      if (snapshot.dustDelta) restoreDustDelta(snapshot.dustDelta, 'redo');
      else restoring = restoreSnapshot(snapshot);
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('redone', 'Redone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
      return restoring;
    }

    function clearUndoHistory() {
      undoStack.length = 0;
      redoStack.length = 0;
      updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
      const undoBtn = document.getElementById('undoBtn');
      const redoBtn = document.getElementById('redoBtn');
      if (undoBtn) undoBtn.disabled = undoStack.length === 0;
      if (redoBtn) redoBtn.disabled = redoStack.length === 0;
      studioWorkspace?.sync();
    }

    // Initialize curves
    function initCurves(markDirty = false) {
      state.curves.r = new Uint8Array(256);
      state.curves.g = new Uint8Array(256);
      state.curves.b = new Uint8Array(256);
      // Reset control points to linear
      state.curvePoints.r = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      state.curvePoints.g = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      state.curvePoints.b = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      // Fill curves with linear values
      for (let i = 0; i < 256; i++) {
        state.curves.r[i] = i;
        state.curves.g[i] = i;
        state.curves.b[i] = i;
      }

      if (markDirty && webglState.gl) webglState.curveDirty = true;
    }
    initCurves(false);

    // ===========================================
    // Canvas & Context
    // ===========================================
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const glCanvas = document.getElementById('glCanvas');
    const canvasContainer = document.getElementById('canvasContainer');
    const canvasTransformWrapper = document.getElementById('canvasTransformWrapper');
    // #canvasContainer's client size. A ResizeObserver keeps it current (see
    // the Window Resize section), so fitting the canvas and sizing the display
    // preview never force layout on the draw and result paths.
    const canvasContainerSize = { width: 0, height: 0, valid: false, observed: false };
    // Interactive preview tier (#263, previewTier.js): 'reduced' only inside a
    // slider or curve session, where the display preview, the WebGL texture
    // sources and the drawing buffer are capped at about 1 MP. Every settled
    // view comes from the normal tier.
    let previewTier = 'normal';
    // The normal-tier conversion preview a reduced one was built from, put
    // back when the session ends: { source, preview }.
    let previewTierKept = null;
    // A reduced conversion preview built ahead of the next session on hosts
    // known to be slow: { base, image }.
    let previewTierPrebuilt = null;
    let previewTierPrebuildHandle = null;
    // Every display image made at the reduced tier. While one is on screen the
    // view is not settled, and the session end converts once more at the
    // normal size.
    const reducedDisplayImages = new WeakSet();
    // Set while a photo switch closes a session: no work for the old photo.
    let previewTierQuietEnd = false;
    const renderEnvironment = { compositing: null, compositingLoaded: false, renderer: null, rendererKnown: false, reported: false };
    const previewTierController = createPreviewTierController({
      force: parsePreviewTierOverride(window.location.search),
      isHidden: () => document.hidden,
      onChange: (tier) => onPreviewTierChange(tier),
      onSessionEnd: (summary) => onPreviewTierSessionEnd(summary),
      measureBacking: () => {
        const surface = glCanvas.style.display === 'block' ? glCanvas : canvas;
        return { width: surface.width, height: surface.height };
      }
    });
    const zoomIndicator = document.getElementById('zoomIndicator');
    const zoomControls = document.getElementById('zoomControls');
    const ZOOM_MIN = 1;
    const ZOOM_MAX = 8;
    const ZOOM_BUTTON_FACTOR = 1.25;
    const ZOOM_DOUBLE_CLICK_FACTOR = 2;
    const ZOOM_WHEEL_SENSITIVITY = 0.0024;
    const ZOOM_PINCH_WHEEL_SENSITIVITY = 0.0042;
    const beforeAfterBtn = document.getElementById('beforeAfterBtn');
    const sprocketPreviewBtn = document.getElementById('sprocketPreviewBtn');
    const histogramContainer = document.getElementById('histogramContainer');
    const histogramCanvas = document.getElementById('histogramCanvas');
    const histogram = new Histogram(histogramCanvas);
    const HISTOGRAM_MAX_SAMPLES = 24_576;
    const HISTOGRAM_UPDATE_INTERVAL_MS = 260;
    const curveCanvas = document.getElementById('curveCanvas');
    const curveCtx = curveCanvas.getContext('2d');
    const loupe = document.getElementById('loupe');
    const loupeCanvas = document.getElementById('loupeCanvas');
    const loupeCtx = loupeCanvas.getContext('2d');
    const loupeInfo = document.getElementById('loupeInfo');

    const loupeSrcCanvas = document.createElement('canvas');
    const loupeSrcCtx = loupeSrcCanvas.getContext('2d', { willReadFrequently: true });
    const beforeAfterScratchCanvas = document.createElement('canvas');
    const beforeAfterScratchCtx = beforeAfterScratchCanvas.getContext('2d', { willReadFrequently: true });
    const sprocketScratchCanvas = document.createElement('canvas');
    const sprocketScratchCtx = sprocketScratchCanvas.getContext('2d', { willReadFrequently: true });
    const sprocketPreviewFrameCanvas = document.createElement('canvas');
    const sprocketPreviewFrameCtx = sprocketPreviewFrameCanvas.getContext('2d');
    const sprocketPreviewFrameCache = {
      key: '',
      sourceRef: null,
      metrics: null
    };
    const composeDisplaySprocketFrame = createSprocketFrameCache();

    // ===========================================
    // Workflow Management
    // ===========================================
    const debugUI = {
      fileListSetCalls: 0,
      lastFileListVisible: null,
      lastFileListReason: ''
    };

    function ensureDebugWidget() {
      if (!DEBUG_UI) return null;
      let el = document.getElementById('debugWidget');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'debugWidget';
      el.className = 'debug-widget';
      document.body.appendChild(el);
      return el;
    }

    function updateDebugWidget() {
      if (!DEBUG_UI) return;
      const el = ensureDebugWidget();
      if (!el) return;

      const fileListEl = document.getElementById('fileListSection');
      const fileListDisplay = fileListEl
        ? (fileListEl.style.display || getComputedStyle(fileListEl).display)
        : 'n/a';
      const fileListRect = fileListEl ? fileListEl.getBoundingClientRect() : null;
      const fileListH = fileListRect ? Math.round(fileListRect.height) : 0;

      el.textContent =
        `BUILD ${BUILD_ID}\n` +
        `step=${state.currentStep} queue=${state.fileQueue.length} idx=${state.currentFileIndex}\n` +
        `batchSessionActive=${state.batchSessionActive} batchMode=${state.batchMode}\n` +
        `fileList display=${fileListDisplay} h=${fileListH}\n` +
        `fileList last=${debugUI.lastFileListVisible} reason=${debugUI.lastFileListReason}\n` +
        `fileList setCalls=${debugUI.fileListSetCalls}\n` +
        `${renderEnvironmentLine()}\n` +
        `tier=${previewTier} last ${formatPreviewSessionLine(previewTierController.lastSummary)}`;
    }

    function setFileListVisible(visible, reason) {
      const fileListEl = document.getElementById('fileListSection');
      if (!fileListEl) return;

      // Once a batch session is active, keep the list visible unless the session is explicitly cleared.
      if (!visible && state.batchSessionActive) {
        visible = true;
        reason = `${reason || 'unknown'} (blocked)`;
      }

      const nextDisplay = visible ? 'block' : 'none';
      if (fileListEl.style.display !== nextDisplay) {
        fileListEl.style.display = nextDisplay;
      }

      if (DEBUG_UI) {
        debugUI.fileListSetCalls++;
        debugUI.lastFileListVisible = visible;
        debugUI.lastFileListReason = reason || '';
        updateDebugWidget();
      }
    }

    function updateBatchStep3GuideVisibility() {
    }

    function syncBatchUIState(options = {}) {
      if (state.fileQueue.length > 1) state.batchSessionActive = true;

      state.batchMode = state.batchSessionActive;
      showBatchUI(state.batchSessionActive, options.reason || 'syncBatchUIState');

      const saveSettingsBtn = document.getElementById('saveSettingsBtn');
      const applyToSelectedBtn = document.getElementById('applyToSelectedBtn');
      const showBatchStep3Actions = state.batchSessionActive && state.currentStep >= 3;
      if (saveSettingsBtn) {
        saveSettingsBtn.style.display = showBatchStep3Actions ? 'inline-flex' : 'none';
      }
      if (applyToSelectedBtn) {
        applyToSelectedBtn.style.display = showBatchStep3Actions ? 'inline-flex' : 'none';
      }

      updateCurrentFileLabel();
      updateRollReferenceUI();
      updateAutoFrameButtons();
      updateDebugWidget();
      studioWorkspace?.sync();
    }

    function revealBatchFileList(reason = 'revealBatchFileList') {
      if (!state.batchSessionActive) return;

      const controlsPanel = document.getElementById('controlsPanel');
      if (!controlsPanel) return;

      setFileListVisible(true, reason);
      controlsPanel.scrollTop = 0;
    }

    function getCurrentQueueItem() {
      if (state.currentFileIndex < 0 || state.currentFileIndex >= state.fileQueue.length) return null;
      const item = state.fileQueue[state.currentFileIndex];
      return item.file === state.loadedFile ? item : null;
    }

    function getQueueItemById(id) {
      if (!id) return null;
      return state.fileQueue.find(item => item.id === id) || null;
    }

    function hasRollReference() {
      return Boolean(state.rollReference.enabled && state.rollReference.settingsSnapshot);
    }

    function resetRollReferenceState() {
      state.rollReference.enabled = false;
      state.rollReference.sourceFileId = null;
      state.rollReference.settingsSnapshot = null;
      state.rollReference.applyLock = false;
      state.rollReference.applyCrop = false;
      resetRollAnalysisState();
      resetFlatFieldState();
    }

    function resetRollAnalysisState() {
      const equalize = state.rollAnalysis ? state.rollAnalysis.equalize : true;
      state.rollAnalysis = { id: null, filmBase: null, channelData: null, count: 0, usable: 0, outlierCount: 0, outliers: [], equalize };
      if (stateReady) updateRollAnalysisUI();
    }

    function updateCurrentFileLabel() {
      const label = document.getElementById('currentFileLabel');
      if (!label) return;

      const item = getCurrentQueueItem();
      if (!item || !item.file) {
        label.style.display = 'none';
        label.textContent = '';
        return;
      }

      const prefix = i18n[currentLang].currentFile || 'Current File';
      const unsavedText = item.isDirty ? ` • ${i18n[currentLang].unsaved || 'Unsaved'}` : '';
      label.textContent = `${prefix}: ${item.file.name}${unsavedText}`;
      label.style.display = 'inline-flex';
    }

    function updateRollReferenceUI() {
      const statusEl = document.getElementById('rollReferenceStatus');
      const setBtn = document.getElementById('setRollReferenceBtn');
      const applyBtn = document.getElementById('applyRollReferenceBtn');
      const clearBtn = document.getElementById('clearRollReferenceBtn');
      const useBtn = document.getElementById('useReferenceBtn');
      const lockInput = document.getElementById('lockRollReference');
      const cropInput = document.getElementById('applyCropWithReference');
      const controlsEl = document.getElementById('rollReferenceControls');
      if (!statusEl || !setBtn || !applyBtn || !clearBtn || !lockInput || !cropInput || !controlsEl) return;

      const showControls = requiresFilmBase();
      controlsEl.style.display = showControls ? 'flex' : 'none';
      if (!showControls) return;

      const hasReference = hasRollReference();
      const sourceItem = getQueueItemById(state.rollReference.sourceFileId);
      const sourceName = sourceItem ? sourceItem.file.name : 'n/a';

      statusEl.textContent = hasReference
        ? (i18n[currentLang].rollReferenceActive || 'Reference source: {file}').replace('{file}', sourceName)
        : (i18n[currentLang].rollReferenceNone || 'No roll reference set.');

      setBtn.disabled = !(state.currentStep >= 3 && state.processedImageData);
      applyBtn.disabled = !hasReference;
      clearBtn.disabled = !hasReference;
      if (useBtn) useBtn.disabled = !hasReference;
      lockInput.checked = Boolean(state.rollReference.applyLock);
      cropInput.checked = Boolean(state.rollReference.applyCrop);
      lockInput.disabled = !hasReference;
      cropInput.disabled = !hasReference;
    }

    function updateWorkflowUI() {
      const steps = ['step1', 'step2', 'step3'];
      const badge = document.getElementById('statusBadge');

      steps.forEach((stepId, idx) => {
        const stepEl = document.getElementById(stepId);
        if (!stepEl) return;
        stepEl.classList.remove('active', 'completed');
        if (idx + 1 < state.currentStep) {
          stepEl.classList.add('completed');
        } else if (idx + 1 === state.currentStep) {
          stepEl.classList.add('active');
        }
      });


      // Update badge
      badge.className = 'status-badge step' + state.currentStep;
      badge.setAttribute('data-i18n', 'step' + state.currentStep);
      badge.textContent = i18n[currentLang]['step' + state.currentStep];

      // Show/hide sections based on step
      document.getElementById('autoFrameSettingsSection').style.display =
        state.currentStep === 1 ? 'block' : 'none';
      // 変換ペインから処理設定へいつでも戻れる。
      document.getElementById('filmSettingsSection').style.display =
        state.currentStep >= 2 ? 'block' : 'none';
      updateStep3SectionVisibility();

      // Show convert button after cropping is done
      document.getElementById('convertSeparator').style.display =
        state.currentStep === 1 ? 'inline-block' : 'none';
      document.getElementById('convertBtn').style.display =
        state.currentStep === 1 ? 'inline-flex' : 'none';
      document.getElementById('convertPositiveBtn').style.display =
        state.currentStep === 1 ? 'inline-flex' : 'none';
      document.getElementById('applyConvertBtn').style.display =
        state.currentStep === 2 ? 'flex' : 'none';

      syncBatchUIState({ reason: 'updateWorkflowUI' });
      updateAutoFrameButtons();
      updateBeforeAfterButtonState();
      updateSprocketControlsUI();
      updateExpiredRescueUI();
      studioWorkspace?.sync();
    }

    function updateStep3SectionVisibility() {
      const inStep3 = state.currentStep >= 3;
      const showCore = inStep3 && usesSilverCoreConversion(state);
      const dustSection = document.getElementById('dustRemovalSection');
      if (dustSection) dustSection.style.display = inStep3 ? 'block' : 'none';
      document.getElementById('aiBrushSection').style.display = inStep3 ? 'block' : 'none';

      // CMYD キーパッドも通常の調色ペインで使う。
      const consoleSection = document.getElementById('consoleSection');
      if (consoleSection) consoleSection.style.display = showCore ? 'block' : 'none';
      const quickFix = document.getElementById('whiteBalanceSection');
      if (quickFix) quickFix.style.display = showCore ? 'block' : 'none';

      ['toneSection', 'colorSection', 'cmySection', 'advancedSection'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = showCore ? 'block' : 'none';
      });

      const additional = document.getElementById('additionalSection');
      if (additional) {
        additional.style.display = inStep3 ? 'block' : 'none';
      }

      updateConsoleReadouts();
      updateGrayPointGuideUI();
    }

    function goToStep(step) {
      state.currentStep = step;
      if (step === 2 && requiresFilmBase()) {
        setStep2Mode(suggestStep2Mode());
      }
      updateWorkflowUI();
      updateCanvasVisibility();
    }

    function getBeforeAfterReferenceImageData() {
      if (state.currentStep >= 3) {
        return state.conversionSourceImageData || state.croppedImageData || state.originalImageData || null;
      }
      return state.croppedImageData || state.originalImageData || null;
    }

    function canActivateBeforeAfter() {
      if (document.body.dataset.photoSwitching === 'true' || document.body.dataset.studioDetecting
        || state.cropping || state.samplingMode) return false;
      return Boolean(getBeforeAfterReferenceImageData());
    }

    function renderBeforeAfterReference(referenceImageData) {
      if (!referenceImageData) return false;

      if (isWebGLActive()) {
        glCanvas.style.display = 'none';
        canvas.style.display = 'block';
      }

      if (canvas.width === referenceImageData.width && canvas.height === referenceImageData.height) {
        ctx.putImageData(referenceImageData, 0, 0);
      } else {
        beforeAfterScratchCanvas.width = referenceImageData.width;
        beforeAfterScratchCanvas.height = referenceImageData.height;
        beforeAfterScratchCtx.putImageData(referenceImageData, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(beforeAfterScratchCanvas, 0, 0, canvas.width, canvas.height);
      }

      renderHistogram(referenceImageData);
      return true;
    }

    function enterBeforeAfter(source = 'button') {
      if (state.beforeAfterActive) return;
      if (!canActivateBeforeAfter()) return;

      const referenceImageData = getBeforeAfterReferenceImageData();
      if (!referenceImageData) return;

      state.beforeAfterActive = true;
      state.beforeAfterSource = source;
      if (beforeAfterBtn) {
        beforeAfterBtn.classList.add('active');
        beforeAfterBtn.setAttribute('aria-pressed', 'true');
      }
      updateSprocketControlsUI();
      renderBeforeAfterReference(referenceImageData);
    }

    function exitBeforeAfter() {
      if (!state.beforeAfterActive) return;

      state.beforeAfterActive = false;
      state.beforeAfterSource = null;
      if (beforeAfterBtn) {
        beforeAfterBtn.classList.remove('active');
        beforeAfterBtn.setAttribute('aria-pressed', 'false');
      }
      updateSprocketControlsUI();

      if (state.currentStep >= 3 && state.processedImageData) {
        // A previous full-size buffer may predate a recent preview adjustment,
        // including edits made while comparison suppressed normal redraws.
        updatePreview();
        if (isWebGLActive()) renderHistogramForWebGL(true);
        else renderHistogram(previewAdjustedBuffer || state.processedImageData);
        return;
      }

      const sourceData = state.croppedImageData || state.originalImageData;
      if (sourceData) {
        displayNegative(sourceData);
        renderHistogram(sourceData);
      }
    }

    function toggleBeforeAfter(source = 'button') {
      if (state.beforeAfterActive) {
        exitBeforeAfter();
        return;
      }
      enterBeforeAfter(source);
    }

    function updateBeforeAfterButtonState() {
      if (!beforeAfterBtn) return;

      const enabled = canActivateBeforeAfter();
      if (!enabled && state.beforeAfterActive) {
        exitBeforeAfter();
      }
      beforeAfterBtn.disabled = !enabled;
      beforeAfterBtn.classList.toggle('active', state.beforeAfterActive);
      beforeAfterBtn.setAttribute('aria-pressed', state.beforeAfterActive ? 'true' : 'false');
    }

    function canPreviewSprocketFrame() {
      if (state.beforeAfterActive || state.cropping || state.samplingMode) return false;
      return Boolean(
        (state.currentStep >= 3 && state.processedImageData)
        || state.croppedImageData
        || state.originalImageData
      );
    }

    function updateSprocketControlsUI() {
      const previewEnabled = Boolean(state.sprocketPreviewEnabled);
      if (sprocketPreviewBtn) {
        sprocketPreviewBtn.disabled = !canPreviewSprocketFrame();
        sprocketPreviewBtn.classList.toggle('active', previewEnabled);
        sprocketPreviewBtn.setAttribute('aria-pressed', previewEnabled ? 'true' : 'false');
      }

      const exportSprocketBtn = document.getElementById('exportSprocketBtn');
      if (exportSprocketBtn) {
        exportSprocketBtn.classList.toggle('active', Boolean(state.exportSprocketHolesEnabled));
        exportSprocketBtn.setAttribute('aria-pressed', state.exportSprocketHolesEnabled ? 'true' : 'false');
      }

      const sprocketSettingsSection = document.getElementById('sprocketSettingsSection');
      if (sprocketSettingsSection) {
        const hasImage = state.originalImageData || state.croppedImageData || state.processedImageData;
        sprocketSettingsSection.style.display = hasImage ? 'block' : 'none';
      }
      syncSprocketEdgeSettingsUI();
      studioWorkspace?.sync();
    }

    // Edge text and frame number default to the roll's stock and this frame's
    // number while the user has not typed their own values.
    function getSprocketFrameComposeOptions(settings = state, position = state.currentFileIndex) {
      const edge = { ...state.sprocketEdge, fontLocale: currentLang };
      const roll = state.rollMetadata || {};
      const frame = settings === state || !settings ? state.frameMetadata : settings.frameMetadata;
      if (roll.stock && (!edge.text || edge.text === DEFAULT_SPROCKET_EDGE_MARKINGS.text)) edge.text = roll.stock.toUpperCase();
      const number = parseInt(frameNumberFor(frame, position), 10);
      if (Number.isFinite(number) && edge.frameNumber === DEFAULT_SPROCKET_EDGE_MARKINGS.frameNumber) edge.frameNumber = Math.max(0, Math.min(99, number));
      return { edgeMarkings: edge };
    }

    function syncSprocketEdgeSettingsUI() {
      const settings = createSprocketEdgeSettings(state.sprocketEdge);
      const setChecked = (key, value) => {
        const el = document.getElementById(SPROCKET_EDGE_CONTROL_IDS[key]);
        if (el) el.checked = Boolean(value);
      };
      const setValue = (key, value) => {
        const el = document.getElementById(SPROCKET_EDGE_CONTROL_IDS[key]);
        if (el && document.activeElement !== el) el.value = value;
      };

      setChecked('textEnabled', settings.textEnabled);
      setChecked('frameNumberEnabled', settings.frameNumberEnabled);
      setChecked('dxEnabled', settings.dxEnabled);
      setChecked('halfFrameMarksEnabled', settings.halfFrameMarksEnabled);
      setChecked('overexposedSprockets', settings.overexposedSprockets);
      setValue('text', settings.text);
      setValue('frameNumber', settings.frameNumber);
      setValue('frameNumberHole', settings.frameNumberHole);
      setValue('firstHoleOffsetMm', settings.firstHoleOffsetMm);
      setValue('dx1', settings.dx1);
      setValue('dx2', settings.dx2);
      setValue('overexposureStrength', settings.overexposureStrength);
      setValue('fontStyle', settings.fontStyle);
      setValue('fontFamily', settings.fontFamily);
      setValue('holeColor', settings.holeColor);
      setValue('letteringColor', settings.letteringColor);
      setValue('overexposureColor', settings.overexposureColor);
    }

    function readSprocketEdgeSettingsFromUI() {
      const getEl = (key) => document.getElementById(SPROCKET_EDGE_CONTROL_IDS[key]);
      const getChecked = (key) => Boolean(getEl(key)?.checked);
      const getValue = (key, fallback = '') => {
        const el = getEl(key);
        return el ? el.value : fallback;
      };
      return createSprocketEdgeSettings({
        textEnabled: getChecked('textEnabled'),
        frameNumberEnabled: getChecked('frameNumberEnabled'),
        dxEnabled: getChecked('dxEnabled'),
        halfFrameMarksEnabled: getChecked('halfFrameMarksEnabled'),
        overexposedSprockets: getChecked('overexposedSprockets'),
        text: getValue('text', DEFAULT_SPROCKET_EDGE_MARKINGS.text),
        frameNumber: getValue('frameNumber', DEFAULT_SPROCKET_EDGE_MARKINGS.frameNumber),
        frameNumberHole: getValue('frameNumberHole', DEFAULT_SPROCKET_EDGE_MARKINGS.frameNumberHole),
        firstHoleOffsetMm: getValue('firstHoleOffsetMm', DEFAULT_SPROCKET_EDGE_MARKINGS.firstHoleOffsetMm),
        dx1: getValue('dx1', DEFAULT_SPROCKET_EDGE_MARKINGS.dx1),
        dx2: getValue('dx2', DEFAULT_SPROCKET_EDGE_MARKINGS.dx2),
        overexposureStrength: getValue('overexposureStrength', DEFAULT_SPROCKET_EDGE_MARKINGS.overexposureStrength),
        fontStyle: getValue('fontStyle', DEFAULT_SPROCKET_EDGE_MARKINGS.fontStyle),
        fontFamily: getValue('fontFamily', DEFAULT_SPROCKET_EDGE_MARKINGS.fontFamily),
        holeColor: getValue('holeColor', DEFAULT_SPROCKET_EDGE_MARKINGS.holeColor),
        letteringColor: getValue('letteringColor', DEFAULT_SPROCKET_EDGE_MARKINGS.letteringColor),
        overexposureColor: getValue('overexposureColor', DEFAULT_SPROCKET_EDGE_MARKINGS.overexposureColor)
      });
    }

    function refreshSprocketPreviewAfterSettingsChange() {
      updateSprocketControlsUI();
      if (!state.sprocketPreviewEnabled) return;

      if (state.currentStep >= 3 && state.processedImageData) {
        updatePreview();
        return;
      }

      const sourceData = state.croppedImageData || state.originalImageData;
      if (sourceData) {
        displayNegative(sourceData);
        renderHistogram(sourceData);
      }
    }

    function handleSprocketEdgeSettingsChange() {
      state.sprocketEdge = readSprocketEdgeSettingsFromUI();
      // 枠の設定を触ったら、その結果をすぐ見せる。書き出し指定は変更しない。
      if (canPreviewSprocketFrame() && !state.sprocketPreviewEnabled) {
        setSprocketPreviewEnabled(true);
        return;
      }
      refreshSprocketPreviewAfterSettingsChange();
    }

    function setSprocketPreviewEnabled(enabled, options = {}) {
      const nextEnabled = Boolean(enabled);
      state.sprocketPreviewEnabled = nextEnabled;
      updateSprocketControlsUI();
      updateCanvasVisibility();

      if (options.render === false) return;
      if (state.beforeAfterActive) exitBeforeAfter();
      if (state.currentStep >= 3 && state.processedImageData) {
        updatePreview();
        return;
      }

      const sourceData = state.croppedImageData || state.originalImageData;
      if (sourceData) {
        displayNegative(sourceData);
        renderHistogram(sourceData);
      }
    }

    function setMainCanvasDimensions(width, height) {
      const nextWidth = Math.max(1, Math.round(width));
      const nextHeight = Math.max(1, Math.round(height));
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;
      adjustCanvasDisplay(nextWidth, nextHeight);
    }

    function drawImageDataToMainCanvas(imageData, targetWidth, targetHeight) {
      if (imageData.width === targetWidth && imageData.height === targetHeight) {
        ctx.putImageData(imageData, 0, 0);
        return;
      }

      if (sprocketScratchCanvas.width !== imageData.width) sprocketScratchCanvas.width = imageData.width;
      if (sprocketScratchCanvas.height !== imageData.height) sprocketScratchCanvas.height = imageData.height;
      sprocketScratchCtx.putImageData(imageData, 0, 0);
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sprocketScratchCanvas, 0, 0, targetWidth, targetHeight);
    }

    function getSprocketPreviewFrameCacheKey(imageData, fullSizeReference, composeOptions) {
      return JSON.stringify({
        sourceWidth: imageData.width,
        sourceHeight: imageData.height,
        targetWidth: fullSizeReference.width,
        targetHeight: fullSizeReference.height,
        edgeMarkings: composeOptions.edgeMarkings
      });
    }

    function ensureSprocketPreviewFrameBackground(imageData, fullSizeReference, composeOptions) {
      if (!sprocketPreviewFrameCtx) return null;
      const key = getSprocketPreviewFrameCacheKey(imageData, fullSizeReference, composeOptions);
      if (
        sprocketPreviewFrameCache.key === key
        && sprocketPreviewFrameCache.sourceRef === fullSizeReference
        && sprocketPreviewFrameCache.metrics
        && sprocketPreviewFrameCanvas.width > 0
        && sprocketPreviewFrameCanvas.height > 0
      ) {
        return sprocketPreviewFrameCache;
      }

      const background = composeSprocketFrameBackground(imageData, composeOptions);
      if (sprocketPreviewFrameCanvas.width !== background.width) sprocketPreviewFrameCanvas.width = background.width;
      if (sprocketPreviewFrameCanvas.height !== background.height) sprocketPreviewFrameCanvas.height = background.height;
      sprocketPreviewFrameCtx.clearRect(0, 0, background.width, background.height);
      sprocketPreviewFrameCtx.putImageData(background, 0, 0);

      sprocketPreviewFrameCache.key = key;
      sprocketPreviewFrameCache.sourceRef = fullSizeReference;
      sprocketPreviewFrameCache.metrics = getSprocketFrameMetrics(imageData.width, imageData.height, composeOptions);
      return sprocketPreviewFrameCache;
    }

    function renderFastSprocketPreview(imageData, fullSizeReference, composeOptions) {
      // Portrait images go through the full compose path (composeSprocketFrame
      // handles pre/post rotation internally).
      if (imageData.height > imageData.width) return false;

      const targetMetrics = getSprocketFrameMetrics(fullSizeReference.width, fullSizeReference.height, composeOptions);
      const frameCache = ensureSprocketPreviewFrameBackground(imageData, fullSizeReference, composeOptions);
      if (!frameCache) return false;
      const frameMetrics = frameCache.metrics;
      setMainCanvasDimensions(targetMetrics.outputWidth, targetMetrics.outputHeight);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sprocketPreviewFrameCanvas, 0, 0, canvas.width, canvas.height);

      if (sprocketScratchCanvas.width !== imageData.width) sprocketScratchCanvas.width = imageData.width;
      if (sprocketScratchCanvas.height !== imageData.height) sprocketScratchCanvas.height = imageData.height;
      sprocketScratchCtx.putImageData(imageData, 0, 0);

      const scaleX = targetMetrics.outputWidth / frameMetrics.outputWidth;
      const scaleY = targetMetrics.outputHeight / frameMetrics.outputHeight;
      ctx.drawImage(
        sprocketScratchCanvas,
        frameMetrics.sideMargin * scaleX,
        frameMetrics.bandHeight * scaleY,
        frameMetrics.sourceWidth * scaleX,
        frameMetrics.sourceHeight * scaleY
      );
      return true;
    }

    let pendingSprocketPreviewFont = null;

    function prepareSprocketPreviewFont(composeOptions) {
      if (areSprocketFrameFontsReady(composeOptions)) return;
      const locale = composeOptions.edgeMarkings.fontLocale;
      if (pendingSprocketPreviewFont === locale) return;
      pendingSprocketPreviewFont = locale;
      void ensureSprocketFrameFonts(composeOptions).then(() => {
        sprocketPreviewFrameCache.key = null;
        refreshSprocketPreviewAfterSettingsChange();
      }).catch(error => {
        console.warn('Film-edge font could not be loaded:', error);
      }).finally(() => {
        if (pendingSprocketPreviewFont === locale) pendingSprocketPreviewFont = null;
      });
    }

    function renderAdjustedImageDataToMainCanvas(imageData, fullSizeReference = imageData, options = {}) {
      if (state.sprocketPreviewEnabled && !state.cropping) {
        const composeOptions = getSprocketFrameComposeOptions();
        prepareSprocketPreviewFont(composeOptions);
        if (options.fastSprocketPreview && renderFastSprocketPreview(imageData, fullSizeReference, composeOptions)) {
          return;
        }
        const framed = composeDisplaySprocketFrame(imageData, composeOptions);
        setMainCanvasDimensions(framed.width, framed.height);
        drawImageDataToMainCanvas(framed, framed.width, framed.height);
        return;
      }

      setMainCanvasDimensions(fullSizeReference.width, fullSizeReference.height);
      drawImageDataToMainCanvas(imageData, fullSizeReference.width, fullSizeReference.height);
      settleInterimGeometryDisplay();
    }

    function isEditableTarget(target) {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable]'));
    }

    // ===========================================
    // Core Negative Processing Algorithm
    // ===========================================
    function sampleFilmBase(imageData, x, y, radius = 10) {
      return sampleFilmBaseRobust(imageData, x, y, radius);
    }

    // Memoised per decoded plane and effective buffer (filmStatsCache.js): the
    // import defaults and the Step-2 suggestion ask for the same numbers, and a
    // fresh RAW decode arrives with them already computed by its worker.
    function autoDetectFilmBase(imageData, borderBufferPct = 10) {
      return cachedAutoDetectFilmBase(imageData, borderBufferPct);
    }

    // ===========================================
    // Pixel Adjustments (Optimized)
    // ===========================================
    function ensureImageDataBuffer(buffer, width, height) {
      if (buffer && buffer.width === width && buffer.height === height) return buffer;
      return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    }

    const adjustmentLutScratch = createAdjustmentLutScratch();

    function makeLinearCurveLut() {
      const curve = new Uint8Array(256);
      for (let i = 0; i < 256; i++) curve[i] = i;
      return curve;
    }

    function makeLinearCurvePoints() {
      return [{ x: 0, y: 0 }, { x: 255, y: 255 }];
    }

    function sanitizeNumeric(value, fallback, min = -Infinity, max = Infinity) {
      const n = Number(value);
      const base = Number.isFinite(n) ? n : fallback;
      if (!Number.isFinite(base)) return Number.isFinite(fallback) ? fallback : 0;
      return clampBetween(base, min, max);
    }

    function sanitizeFilmBase(input, fallback = null) {
      return sanitizeFilmBaseForSettings(input, fallback);
    }

    function sanitizeCurvePointChannel(points, fallbackPoints = null) {
      const source = Array.isArray(points) ? points : (Array.isArray(fallbackPoints) ? fallbackPoints : null);
      if (!source || source.length < 2) return makeLinearCurvePoints();

      const normalized = [];
      source.forEach((point) => {
        if (!point || typeof point !== 'object') return;
        const x = sanitizeNumeric(point.x, NaN, 0, 255);
        const y = sanitizeNumeric(point.y, NaN, 0, 255);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        normalized.push({ x: Math.round(x), y: Math.round(y) });
      });
      if (normalized.length < 2) return makeLinearCurvePoints();

      normalized.sort((a, b) => a.x - b.x);
      const deduped = [];
      normalized.forEach((point) => {
        if (!deduped.length) {
          deduped.push(point);
          return;
        }
        const last = deduped[deduped.length - 1];
        if (point.x === last.x) {
          last.y = point.y;
        } else {
          deduped.push(point);
        }
      });
      if (deduped.length < 2) return makeLinearCurvePoints();

      if (deduped[0].x !== 0) {
        deduped.unshift({ x: 0, y: deduped[0].y });
      } else {
        deduped[0].y = Math.round(sanitizeNumeric(deduped[0].y, 0, 0, 255));
      }

      const tail = deduped[deduped.length - 1];
      if (tail.x !== 255) {
        deduped.push({ x: 255, y: tail.y });
      } else {
        tail.y = Math.round(sanitizeNumeric(tail.y, 255, 0, 255));
      }

      if (deduped.length < 2 || deduped[0].x !== 0 || deduped[deduped.length - 1].x !== 255) {
        return makeLinearCurvePoints();
      }
      return deduped;
    }

    function buildCurveLutFromPoints(points) {
      const safePoints = sanitizeCurvePointChannel(points, null);
      const curve = new Uint8Array(256);
      let spline = null;
      try {
        spline = computeSpline(safePoints);
      } catch (err) {
        spline = null;
      }
      if (!spline) return makeLinearCurveLut();

      for (let i = 0; i < 256; i++) {
        const value = Math.round(spline(i));
        curve[i] = clampBetween(value, 0, 255);
      }
      return curve;
    }

    function sanitizeCurveLut(channelCurve, fallbackCurve = null) {
      if (channelCurve instanceof Uint8Array && channelCurve.length >= 256) {
        return channelCurve;
      }
      const source = (channelCurve && typeof channelCurve.length === 'number' && channelCurve.length >= 256)
        ? channelCurve
        : ((fallbackCurve && typeof fallbackCurve.length === 'number' && fallbackCurve.length >= 256)
          ? fallbackCurve
          : null);
      if (!source) return null;

      const next = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const value = Number(source[i]);
        if (!Number.isFinite(value)) return null;
        next[i] = clampBetween(Math.round(value), 0, 255);
      }
      return next;
    }

    function sanitizeSettings(rawSettings, options = {}) {
      const fallbackSettings = (options.fallbackSettings && typeof options.fallbackSettings === 'object')
        ? options.fallbackSettings
        : state;
      const source = (rawSettings && typeof rawSettings === 'object') ? rawSettings : {};
      const includeCurvePoints = options.includeCurvePoints !== false;
      const includeCurves = options.includeCurves !== false;

      const fallbackType = sanitizePresetType(fallbackSettings.filmType || 'color');
      const inferredType = inferFilmTypeFromLegacyPreset(source.filmPreset, fallbackType);
      const filmType = sanitizePresetType(source.filmType || inferredType || fallbackType);
      const sourceMeta = source === state ? state.autoFrame.lastDiagnostics : source.autoFrameMeta;
      const fallbackMeta = fallbackSettings === state ? state.autoFrame.lastDiagnostics : fallbackSettings.autoFrameMeta;

      const safe = {
        cropRegion: source.cropRegion ? { ...source.cropRegion } : (fallbackSettings.cropRegion ? { ...fallbackSettings.cropRegion } : null),
        rotationAngle: normalizeAngleDegrees(sanitizeNumeric(source.rotationAngle, fallbackSettings.rotationAngle || 0, -3600, 3600)),
        mirrored: Boolean('mirrored' in source ? source.mirrored : fallbackSettings.mirrored),
        autoFrameMeta: sourceMeta ? structuredClone(sourceMeta) : ((source === state || Object.hasOwn(source, 'autoFrameMeta')) ? null : (fallbackMeta ? structuredClone(fallbackMeta) : null)),
        semanticMap: sanitizeSemanticMap(source.semanticMap),
        learnedDefaults: source.learnedDefaults && typeof source.learnedDefaults.key === 'string' ? { key: source.learnedDefaults.key.slice(0, 500), n: Math.max(0, Math.min(32, Number(source.learnedDefaults.n) || 0)) } : null,
        reviewed: Boolean(source.reviewed),
        wbUserOverride: Boolean(source.wbUserOverride),
        wbSemanticApplied: Boolean(source.wbSemanticApplied),
        filmType,
        positiveMode: source.positiveMode === 'edit' ? 'edit' : 'correct',
        filmTypeSource: source.filmTypeSource === 'auto' ? 'auto' : 'manual',
        filmTypeConfidence: ['high', 'medium', 'low'].includes(source.filmTypeConfidence) ? source.filmTypeConfidence : null,
        filmTypeReason: typeof source.filmTypeReason === 'string' ? source.filmTypeReason : null,
        filmBase: sanitizeFilmBase(source.filmBase, fallbackSettings.filmBase),
        // Per-file like the crop: never inherited from the fallback frame.
        filmEdge: sanitizeFilmEdgeForSettings(source === state ? state.filmEdge : source.filmEdge),
        rollFrame: sanitizeRollFrameForSettings(source === state ? state.rollFrame : source.rollFrame),
        lensCorrection: sanitizeLensCorrection(source.lensCorrection, fallbackSettings.lensCorrection),
        coreFilmPreset: String(source.coreFilmPreset || fallbackSettings.coreFilmPreset || 'none'),
        coreColorModel: sanitizeCoreColorModel(
          source.coreColorModel,
          sanitizeCoreColorModel(fallbackSettings.coreColorModel, 'standard')
        ),
        coreEnhancedProfile: sanitizeCoreEnhancedProfile(source.coreEnhancedProfile, sanitizeCoreEnhancedProfile(fallbackSettings.coreEnhancedProfile, 'none')),
        coreProfileStrength: sanitizeNumeric(source.coreProfileStrength, fallbackSettings.coreProfileStrength ?? 100, 0, 200),
        corePreSaturation: sanitizeNumeric(source.corePreSaturation, fallbackSettings.corePreSaturation ?? 100, 0, 200),
        coreBorderBuffer: sanitizeNumeric(source.coreBorderBuffer, fallbackSettings.coreBorderBuffer ?? 10, 0, 30),
        coreBorderBufferBorderValue: sanitizeNumeric(
          source.coreBorderBufferBorderValue,
          source.coreBorderBuffer ?? fallbackSettings.coreBorderBufferBorderValue ?? fallbackSettings.coreBorderBuffer ?? 10,
          0,
          30
        ),
        coreBrightness: sanitizeNumeric(source.coreBrightness, fallbackSettings.coreBrightness ?? 0, -100, 100),
        coreExposure: sanitizeNumeric(source.coreExposure, fallbackSettings.coreExposure ?? 0, -300, 300),
        coreContrast: sanitizeNumeric(source.coreContrast, fallbackSettings.coreContrast ?? 0, -100, 100),
        coreHighlights: sanitizeNumeric(source.coreHighlights, fallbackSettings.coreHighlights ?? 0, -100, 100),
        coreShadows: sanitizeNumeric(source.coreShadows, fallbackSettings.coreShadows ?? 0, -100, 100),
        coreWhites: sanitizeNumeric(source.coreWhites, fallbackSettings.coreWhites ?? 0, -100, 100),
        coreBlacks: sanitizeNumeric(source.coreBlacks, fallbackSettings.coreBlacks ?? 0, -100, 100),
        coreWbMode: String(source.coreWbMode || fallbackSettings.coreWbMode || 'auto'),
        coreTemperature: sanitizeNumeric(source.coreTemperature, fallbackSettings.coreTemperature ?? 0, -100, 100),
        coreTint: sanitizeNumeric(source.coreTint, fallbackSettings.coreTint ?? 0, -100, 100),
        coreCyan: sanitizeNumeric(source.coreCyan, fallbackSettings.coreCyan ?? 0, -100, 100),
        corePaper: normalizePaperId(source.corePaper ?? fallbackSettings.corePaper),
        corePaperToning: normalizeToningId(source.corePaperToning ?? fallbackSettings.corePaperToning),
        corePaperToningStrength: sanitizeNumeric(source.corePaperToningStrength, fallbackSettings.corePaperToningStrength ?? 100, 0, 100),
        // Per-file like the crop: strokes are never inherited from the fallback frame.
        localExposure: sanitizeLocalExposureForSettings(source === state ? state.localExposure : source.localExposure),
        repairStrokes: sanitizeRepairStrokes(source.repairStrokes),
        // A colour setting like the curves: copied with the look, inherited from the fallback frame.
        look: sanitizeLookForSettings(source === state ? state.look : (Object.hasOwn(source, 'look') ? source.look : fallbackSettings.look)),
        // Expired-film rescue: the strengths are colour settings and inherit like
        // the look; the analysis is this frame's own measurement, never inherited.
        ...sanitizeExpiredRescueParams(source, fallbackSettings),
        expiredAnalysis: sanitizeExpiredAnalysis(source === state ? state.expiredAnalysis : source.expiredAnalysis),
        frameMetadata: sanitizeFrameMetadata(source === state ? state.frameMetadata : (Object.hasOwn(source, 'frameMetadata') ? source.frameMetadata : fallbackSettings.frameMetadata)),
        // Roll-level like the film base: a new file inherits the roll's flat field.
        flatFieldId: typeof (source.flatFieldId ?? fallbackSettings.flatFieldId) === 'string' ? String(source.flatFieldId ?? fallbackSettings.flatFieldId).slice(0, 64) : null,
        coreSaturation: sanitizeNumeric(source.coreSaturation, fallbackSettings.coreSaturation ?? 100, 0, 200),
        coreGlow: sanitizeNumeric(source.coreGlow, fallbackSettings.coreGlow ?? 0, 0, 100),
        coreFade: sanitizeNumeric(source.coreFade, fallbackSettings.coreFade ?? 0, 0, 100),
        coreCurvePrecision: String(source.coreCurvePrecision || fallbackSettings.coreCurvePrecision || 'auto'),
        coreUseWebGL: typeof source.coreUseWebGL === 'boolean'
          ? source.coreUseWebGL
          : (typeof fallbackSettings.coreUseWebGL === 'boolean' ? fallbackSettings.coreUseWebGL : true),
        exposure: sanitizeNumeric(source.exposure, fallbackSettings.exposure ?? 0, -3, 3),
        contrast: sanitizeNumeric(source.contrast, fallbackSettings.contrast ?? 0, -100, 100),
        highlights: sanitizeNumeric(source.highlights, fallbackSettings.highlights ?? 0, -100, 100),
        shadows: sanitizeNumeric(source.shadows, fallbackSettings.shadows ?? 0, -100, 100),
        temperature: sanitizeNumeric(source.temperature, fallbackSettings.temperature ?? 0, -100, 100),
        tint: sanitizeNumeric(source.tint, fallbackSettings.tint ?? 0, -100, 100),
        vibrance: sanitizeNumeric(source.vibrance, fallbackSettings.vibrance ?? 0, -100, 100),
        saturation: sanitizeNumeric(source.saturation, fallbackSettings.saturation ?? 0, -100, 100),
        cyan: sanitizeNumeric(source.cyan, fallbackSettings.cyan ?? 0, -100, 100),
        magenta: sanitizeNumeric(source.magenta, fallbackSettings.magenta ?? 0, -100, 100),
        yellow: sanitizeNumeric(source.yellow, fallbackSettings.yellow ?? 0, -100, 100),
        wbR: sanitizeNumeric(source.wbR, fallbackSettings.wbR ?? 1, 0.5, 2),
        wbG: sanitizeNumeric(source.wbG, fallbackSettings.wbG ?? 1, 0.5, 2),
        wbB: sanitizeNumeric(source.wbB, fallbackSettings.wbB ?? 1, 0.5, 2),
        wbAutoConfidence: (['high', 'medium', 'low'].includes(source.wbAutoConfidence))
          ? source.wbAutoConfidence
          : null,
        grayPointSampled: typeof source.grayPointSampled === 'boolean'
          ? source.grayPointSampled
          : Boolean(fallbackSettings.grayPointSampled)
      };

      if (includeCurvePoints) {
        const fallbackPoints = fallbackSettings.curvePoints || {};
        const sourcePoints = source.curvePoints || {};
        safe.curvePoints = {
          r: sanitizeCurvePointChannel(sourcePoints.r, fallbackPoints.r),
          g: sanitizeCurvePointChannel(sourcePoints.g, fallbackPoints.g),
          b: sanitizeCurvePointChannel(sourcePoints.b, fallbackPoints.b)
        };
      }

      if (includeCurves) {
        const sourceCurves = source.curves || {};
        const fallbackCurves = fallbackSettings.curves || {};
        let rCurve = sanitizeCurveLut(sourceCurves.r, fallbackCurves.r);
        let gCurve = sanitizeCurveLut(sourceCurves.g, fallbackCurves.g);
        let bCurve = sanitizeCurveLut(sourceCurves.b, fallbackCurves.b);

        if (!rCurve || !gCurve || !bCurve) {
          const curvePoints = safe.curvePoints || {
            r: sanitizeCurvePointChannel((source.curvePoints || {}).r, (fallbackSettings.curvePoints || {}).r),
            g: sanitizeCurvePointChannel((source.curvePoints || {}).g, (fallbackSettings.curvePoints || {}).g),
            b: sanitizeCurvePointChannel((source.curvePoints || {}).b, (fallbackSettings.curvePoints || {}).b)
          };
          if (!rCurve) rCurve = buildCurveLutFromPoints(curvePoints.r);
          if (!gCurve) gCurve = buildCurveLutFromPoints(curvePoints.g);
          if (!bCurve) bCurve = buildCurveLutFromPoints(curvePoints.b);
        }

        safe.curves = { r: rCurve, g: gCurve, b: bCurve };
      }

      return safe;
    }

    function getEffectiveFilmType(settings = state) {
      return sanitizePresetType(settings.filmType || 'color');
    }

    function usesSilverCoreConversion(settings = state) {
      const type = getEffectiveFilmType(settings);
      return type === 'color' || type === 'bw' || type === 'positive';
    }

    function buildCoreConversionSettings(settings = state) {
      const safe = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });

      return {
        ...safe,
        filmPreset: safe.coreFilmPreset || 'none',
        colorModel: safe.coreColorModel,
        enhancedProfile: safe.coreEnhancedProfile,
        profileStrength: safe.coreProfileStrength,
        preSaturation: safe.corePreSaturation,
        borderBuffer: safe.coreBorderBuffer,
        // Roll analysis: shared histogram levels for every locked frame and the
        // per-frame density offset folded into the exposure the engine sees.
        analysisOverride: safe.rollFrame?.locked ? safe.rollFrame.channelData : null,
        brightness: safe.coreBrightness,
        exposure: Math.max(-300, Math.min(300, safe.coreExposure + rollFrameExposureUnits(safe.rollFrame))),
        contrast: safe.coreContrast,
        highlights: safe.coreHighlights,
        shadows: safe.coreShadows,
        whites: safe.coreWhites,
        blacks: safe.coreBlacks,
        wbMode: safe.coreWbMode,
        temperature: safe.coreTemperature,
        tint: safe.coreTint,
        colorCyan: safe.coreCyan,
        paper: safe.corePaper,
        paperToning: safe.corePaperToning,
        paperToningStrength: safe.corePaperToningStrength,
        localExposure: safe.localExposure,
        saturation: safe.coreSaturation,
        glow: safe.coreGlow,
        fade: safe.coreFade,
        curvePrecision: safe.coreCurvePrecision,
        useWebGL: safe.coreUseWebGL
      };
    }

    function buildRouterSettings(settings = state, source = state.loadedBaseImageData || state.originalImageData) {
      const router = usesSilverCoreConversion(settings)
        ? buildCoreConversionSettings(settings)
        : settings;
      const meta = settings === state ? state.autoFrame.lastDiagnostics : settings.autoFrameMeta;
      const flatField = router.flatFieldId ? state.flatFields[router.flatFieldId] || null : null;
      // Repair strokes act on the converted positive (inpaintManualBrush); no
      // converter reads them, so they are not cloned into worker requests.
      const { repairStrokes, ...conversion } = router;
      return {
        ...conversion,
        analysisRegion: resolveAnalysisRegion({ ...settings, autoFrameMeta: meta }, source),
        // Dodge and burn strokes are stored on the unrotated base; the adapter
        // rasterises them for the working frame it converts.
        localExposureGeometry: router.localExposure ? localExposureGeometryFor(settings, source) : null,
        // Flat field gain map (session registry) with the same frame geometry.
        flatField,
        flatFieldGeometry: flatField ? localExposureGeometryFor(settings, source) : null
      };
    }

    // Geometry chain (base -> rotation -> mirror -> crop) for mapping strokes.
    // width/height are filled in by the adapter for the buffer it converts.
    function localExposureGeometryFor(settings = state, source = state.loadedBaseImageData || state.originalImageData) {
      if (!source) return null;
      const live = settings === state;
      const angle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
      const rotated = live && state.originalImageData
        ? { width: state.originalImageData.width, height: state.originalImageData.height }
        : rotatedDimensions(source.width, source.height, angle);
      const crop = live ? state.cropRegion : settings.cropRegion;
      return {
        baseWidth: source.width,
        baseHeight: source.height,
        rotationAngle: angle,
        mirrored: Boolean(settings.mirrored),
        rotatedWidth: rotated.width,
        rotatedHeight: rotated.height,
        cropRegion: crop ? { left: crop.left ?? crop.x ?? 0, top: crop.top ?? crop.y ?? 0, width: crop.width, height: crop.height } : null
      };
    }

    const colorAnalysisSamples = new WeakMap();
    function getColorAnalysisSample(settings = state, source = state.loadedBaseImageData || state.originalImageData) {
      if (!source) return null;
      const meta = settings === state ? state.autoFrame.lastDiagnostics : settings.autoFrameMeta;
      const area = meta?.imageArea || meta?.analysisArea;
      if (!area) return null;
      const key = JSON.stringify(area);
      const cached = colorAnalysisSamples.get(source);
      if (cached?.key === key) return cached.sample;
      const sample = sampleAnalysisArea(source, area);
      colorAnalysisSamples.set(source, { key, sample });
      return sample;
    }

    function buildAdjustmentSettings(settings) {
      const safeSettings = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: true
      });

      if (!usesSilverCoreConversion(safeSettings)) return safeSettings;

      return stripLegacyToneSettingsForSilverCore(safeSettings);
    }

    // Two settings objects with the same key convert to the same pixels and
    // the same automatic analysis (see importDetection.js).
    function conversionKey(settings, source = state.loadedBaseImageData || state.originalImageData) {
      return importConversionKey({
        router: buildRouterSettings(settings, source),
        adjustment: buildAdjustmentSettings(settings),
        meta: settings.autoFrameMeta || null
      });
    }

    function applyAdjustmentsToBuffer(imageData, settings, output, quality = 'full') {
      const prepared = buildAdjustmentSettings(settings);
      // "Hold to see before" on the expired-film panel affects the screen only;
      // exports go through applyAdjustmentsWithSettings.
      if (expiredCompareHeld && prepared.expiredEnabled) prepared.expiredEnabled = false;
      applyPreparedAdjustmentsToBuffer(imageData, prepared, output, {
        quality,
        lutScratch: adjustmentLutScratch
      });
    }

    // Reads live layout. The observer, the window resize handler, a first
    // read and the few places that just changed the layout themselves call
    // it; everything else reads getCanvasContainerSize().
    function refreshCanvasContainerSize() {
      const width = canvasContainer.clientWidth;
      const height = canvasContainer.clientHeight;
      const changed = !canvasContainerSize.valid
        || width !== canvasContainerSize.width || height !== canvasContainerSize.height;
      canvasContainerSize.width = width;
      canvasContainerSize.height = height;
      // Without an observer nothing would keep the cache current.
      canvasContainerSize.valid = canvasContainerSize.observed;
      return changed;
    }

    function getCanvasContainerSize() {
      if (!canvasContainerSize.valid) refreshCanvasContainerSize();
      return canvasContainerSize;
    }

    function getDisplayPreviewSize(imageData, maxDimension = webglState.maxTextureSize || 8192, tier = previewTier) {
      const container = getCanvasContainerSize();
      return displayPreviewSize(imageData.width, imageData.height, {
        viewportWidth: container.width - 20 || 1280,
        viewportHeight: container.height - 20 || 900,
        dpr: window.devicePixelRatio || 1,
        zoom: state.zoomLevel,
        maxPixels: previewTierMaxPixels(tier),
        maxDimension
      });
    }

    // Marks a smaller copy made at the reduced tier. An image returned as it
    // is keeps whatever mark it already has.
    function noteTierImage(result, input) {
      if (previewTier === 'reduced' && result !== input) reducedDisplayImages.add(result);
      return result;
    }

    function buildPreviewSourceImageData(imageData) {
      return noteTierImage(resizeDisplayPreview(imageData, getDisplayPreviewSize(imageData)), imageData);
    }

    function buildHistogramSourceImageData(imageData) {
      return downsampleImageDataForMaxPixels(imageData, HISTOGRAM_MAX_SAMPLES);
    }

    // A retained preview frame arrives without its 16-bit plane but with the
    // worker's downsample of that plane, which is what this would compute.
    function histogramSourceFor(processed) {
      const source = state.previewSourceImageData || processed;
      if (processed.__histogramSample && source === processed) return processed.__histogramSample;
      return buildHistogramSourceImageData(source);
    }

    function buildWebglSourceImageData(imageData, maxDim = webglState.maxTextureSize || 8192) {
      return noteTierImage(resizeDisplayPreview(imageData, getDisplayPreviewSize(imageData, maxDim)), imageData);
    }

    let displayPreviewResizeTimer = null;
    function scheduleDisplayPreviewResize() {
      if (displayPreviewResizeTimer) clearTimeout(displayPreviewResizeTimer);
      displayPreviewResizeTimer = setTimeout(() => {
        displayPreviewResizeTimer = null;
        const source = state.conversionSourceImageData;
        if (!source || state.currentStep < 3 || state.cropping || state.beforeAfterActive) return;
        // A reduced session sizes its own preview; its end calls this again.
        if (previewTier === 'reduced') return;
        const target = getDisplayPreviewSize(source);
        const previous = state.conversionPreviewImageData;
        if (previous?.width === target.width && previous?.height === target.height) return;
        state.conversionPreviewImageData = resizeDisplayPreview(source, target);
        scheduleCoreReprocess({ full: false, displayResize: true });
      }, 100);
    }

    // ===========================================
    // Interactive preview tier (#263)
    // ===========================================

    // Sizes the SilverCore conversion preview for the current tier before a
    // preview tick. The reduced one is resampled from the normal-tier preview
    // (small and cache-friendly) rather than from the full-resolution source,
    // and the normal one is kept for the session end.
    function ensureConversionPreviewForDisplay() {
      const source = state.conversionSourceImageData;
      const target = getDisplayPreviewSize(source);
      const current = state.conversionPreviewImageData;
      if (current?.width === target.width && current?.height === target.height) return;
      if (previewTier !== 'reduced') {
        state.conversionPreviewImageData = resizeDisplayPreview(source, target);
        return;
      }
      if (current && !reducedDisplayImages.has(current)) previewTierKept = { source, preview: current };
      const base = previewTierKept?.source === source ? previewTierKept.preview : null;
      const prebuilt = previewTierPrebuilt;
      previewTierPrebuilt = null;
      let reduced;
      if (prebuilt && base && prebuilt.base === base
        && prebuilt.image.width === target.width && prebuilt.image.height === target.height) {
        reduced = prebuilt.image;
      } else if (base && base.width >= target.width && base.height >= target.height) {
        reduced = resizeDisplayPreview(base, target);
      } else {
        reduced = resizeDisplayPreview(source, target);
      }
      if (reduced !== source && reduced !== base) reducedDisplayImages.add(reduced);
      state.conversionPreviewImageData = reduced;
    }

    function displayIsReduced() {
      return [state.processedImageData, state.previewSourceImageData, state.webglSourceImageData, state.conversionPreviewImageData]
        .some(image => image && reducedDisplayImages.has(image));
    }

    // Resizes the drawing buffer and draws in the same task, so no cleared
    // frame shows. The SilverCore preview follows on its next tick.
    function redrawForPreviewTier() {
      if (!state.processedImageData || state.cropping || state.beforeAfterActive || state.currentStep < 3) return;
      if (isWebGLActive()) renderWebGL();
    }

    // Session end: the settled frame comes from exactly the normal path, the
    // kept conversion preview and one normal-size tick with the final settings.
    function leavePreviewTier() {
      const source = state.conversionSourceImageData;
      const kept = previewTierKept;
      previewTierKept = null;
      if (source && kept?.source === source && reducedDisplayImages.has(state.conversionPreviewImageData)) {
        const target = getDisplayPreviewSize(source);
        if (kept.preview.width === target.width && kept.preview.height === target.height) {
          state.conversionPreviewImageData = kept.preview;
        }
      }
      if (source && state.currentStep >= 3) {
        scheduleDisplayPreviewResize();
        if (displayIsReduced()) restoreNormalTierDisplay();
      }
      redrawForPreviewTier();
      schedulePreviewTierPrebuild();
    }

    function restoreNormalTierDisplay() {
      const processed = state.processedImageData;
      if (!processed || reducedDisplayImages.has(processed) || state.fullResolutionPending) {
        // A frame converted at the reduced size is on screen: convert the
        // final settings once at the normal size, whether or not the display
        // resize finds a new size. A restored preview of matching size would
        // otherwise leave the reduced texture up, and on a large image no
        // full-resolution render ever replaces it.
        const before = coreReprocessToken;
        scheduleCoreReprocess({ full: false });
        // This tick converts the live settings, so the released slider's
        // commit of the value it last asked for still needs nothing new.
        if (coreSliderCommitRecord?.token === before && coreReprocessToken !== before) {
          coreSliderCommitRecord.token = coreReprocessToken;
        }
        return;
      }
      // Only resampled copies of a full-resolution frame (one that landed
      // during the session, as every frame does with repairs on): rebuild
      // them instead of converting again.
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.histogramSourceImageData = histogramSourceFor(processed);
      state.webglSourceImageData = state.previewSourceImageData;
      if (webglState.gl) webglState.sourceDirty = true;
    }

    function onPreviewTierChange(tier) {
      previewTier = tier;
      document.documentElement.dataset.previewTier = tier;
      if (tier === 'reduced') redrawForPreviewTier();
      else if (!previewTierQuietEnd) leavePreviewTier();
      updateDebugWidget();
    }

    function onPreviewTierSessionEnd(summary) {
      document.documentElement.dataset.previewTierLastSession = summary.reduced ? 'reduced' : 'normal';
      if (renderEnvironment.compositing?.frameLog) logWebviewDiagnostics(formatPreviewSessionLine(summary));
      updateDebugWidget();
    }

    function beginPreviewTierSession(kind) {
      if (!state.processedImageData || state.currentStep < 3 || state.cropping) return;
      previewTierController.begin(kind);
    }

    // Input keeps a session alive; after the watchdog closed one mid-drag,
    // the next input of the same drag opens a new one.
    function touchPreviewTierSession(kind) {
      if (previewTierController.active) previewTierController.touch();
      else beginPreviewTierSession(kind);
    }

    function endPreviewTierSession(reason, kind = null) {
      previewTierController.end(reason, kind);
    }

    // A photo switch closes the session without converting the old photo again.
    function resetPreviewTierForActivation() {
      previewTierKept = null;
      previewTierPrebuilt = null;
      cancelPreviewTierPrebuild();
      if (!previewTierController.active) return;
      previewTierQuietEnd = true;
      try {
        previewTierController.end('activation');
      } finally {
        previewTierQuietEnd = false;
      }
    }

    function cancelPreviewTierPrebuild() {
      if (!previewTierPrebuildHandle) return;
      if (previewTierPrebuildHandle.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(previewTierPrebuildHandle.id);
      else clearTimeout(previewTierPrebuildHandle.id);
      previewTierPrebuildHandle = null;
    }

    // On hosts where sessions start reduced, the first reduced tick would
    // resample the preview inside the input event (about 12 MB of planes).
    // Do it when idle after each settle instead.
    function schedulePreviewTierPrebuild() {
      if (previewTierPrebuildHandle || previewTierController.nextStart().tier !== 'reduced') return;
      const run = () => {
        previewTierPrebuildHandle = null;
        if (previewTier !== 'normal' || previewTierController.active || state.currentStep < 3 || state.cropping) return;
        const source = state.conversionSourceImageData;
        const base = state.conversionPreviewImageData;
        if (!source || !base || reducedDisplayImages.has(base) || previewTierPrebuilt?.base === base) return;
        const target = getDisplayPreviewSize(source, undefined, 'reduced');
        if (base.width <= target.width && base.height <= target.height) return;
        const image = resizeDisplayPreview(base, target);
        reducedDisplayImages.add(image);
        previewTierPrebuilt = { base, image };
      };
      previewTierPrebuildHandle = typeof requestIdleCallback === 'function'
        ? { idle: true, id: requestIdleCallback(run, { timeout: 2000 }) }
        : { idle: false, id: setTimeout(run, 300) };
    }

    // Slider sessions: every range drag in the controls panel, including
    // ranges wired on their own (the enlarger head). The end runs in the
    // capture phase, before the slider's own change handler, so the commit's
    // conversion already runs at the normal size.
    function setupPreviewTierSessions() {
      const panel = document.getElementById('controlsPanel');
      if (!panel) return;
      let rangePointer = false;
      const isRange = target => target instanceof HTMLInputElement && target.type === 'range';
      panel.addEventListener('pointerdown', (event) => {
        if (!isRange(event.target) || event.button > 0) return;
        rangePointer = true;
        beginPreviewTierSession('slider');
      }, { capture: true });
      panel.addEventListener('input', (event) => {
        if (isRange(event.target) && rangePointer) touchPreviewTierSession('slider');
      }, { capture: true });
      panel.addEventListener('change', (event) => {
        if (!isRange(event.target)) return;
        rangePointer = false;
        endPreviewTierSession('change', 'slider');
      }, { capture: true });
      const release = (event) => {
        if (!rangePointer) return;
        rangePointer = false;
        endPreviewTierSession(event.type, 'slider');
      };
      window.addEventListener('pointerup', release, { capture: true });
      window.addEventListener('pointercancel', release, { capture: true });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        previewTierController.resetFrameClock();
        previewTierController.measureIdleInterval();
      });
      const measureIdle = () => previewTierController.measureIdleInterval();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(measureIdle, { timeout: 3000 });
      else setTimeout(measureIdle, 1000);
    }

    // ---- What the page runs on: WebGL renderer and webview compositing ----

    function logWebviewDiagnostics(line) {
      if (!isTauriDesktop()) return;
      Promise.resolve(window.__TAURI__.core.invoke('log_webview_diagnostics', { line })).catch(() => {});
    }

    function renderEnvironmentLine() {
      const start = previewTierController.nextStart();
      return formatRenderEnvironmentLine({
        renderer: renderEnvironment.renderer, compositing: renderEnvironment.compositing,
        startTier: start.tier, startReason: start.reason
      });
    }

    function applyRenderEnvironment() {
      previewTierController.setEnvironment(startsReducedReason(renderEnvironment));
      // One line in the terminal log once both halves are known.
      if (!renderEnvironment.reported && renderEnvironment.rendererKnown && renderEnvironment.compositingLoaded) {
        renderEnvironment.reported = true;
        logWebviewDiagnostics(renderEnvironmentLine());
      }
      schedulePreviewTierPrebuild();
      updateDebugWidget();
    }

    // After the first WebGL context (or the failure to create one). A masked
    // or empty renderer string counts as hardware.
    function noteWebglRenderer(gl) {
      renderEnvironment.renderer = gl ? describeWebglRenderer(gl) : null;
      renderEnvironment.rendererKnown = true;
      webglState.renderer = renderEnvironment.renderer;
      applyRenderEnvironment();
    }

    async function loadWebviewCompositing() {
      if (isTauriDesktop()) {
        try {
          const compositing = await window.__TAURI__.core.invoke('get_webview_compositing');
          renderEnvironment.compositing = compositing && typeof compositing === 'object' ? compositing : null;
        } catch (err) {
          console.info('Webview compositing unavailable:', err);
        }
      }
      renderEnvironment.compositingLoaded = true;
      applyRenderEnvironment();
    }

    // ===========================================
    // Histogram (Lightroom-style)
    // ===========================================

    function resizeHistogramCanvas() {
      if (!histogramContainer || !histogramCanvas) return false;
      const rect = histogramContainer.getBoundingClientRect();
      const styles = window.getComputedStyle(histogramContainer);
      const paddingX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
      const displayWidth = Math.max(1, Math.round(rect.width - paddingX));
      let resized = false;
      if (displayWidth > 0 && histogramCanvas.width !== displayWidth) {
        histogramCanvas.width = displayWidth;
        histogram.width = displayWidth;
        resized = true;
      }
      const h = histogramCanvas.height;
      if (histogram.height !== h) {
        histogram.height = h;
        resized = true;
      }
      return resized;
    }

    function renderHistogram(imageData) {
      if (!imageData) return;
      resizeHistogramCanvas();
      histogram.draw(imageData);
    }

    function getCurrentHistogramSource() {
      return state.displayImageData
        || state.processedImageData
        || state.croppedImageData
        || state.originalImageData
        || null;
    }

    function redrawHistogramIfPossible() {
      const source = getCurrentHistogramSource();
      if (!source) return;
      renderHistogram(source);
    }

    // ===========================================
    // Curve Editor (Lightroom-style with control points)
    // ===========================================
    let currentCurveChannel = 'r';
    let draggingPoint = null;
    let hoveredPoint = null;

    // Update the 256-value curve from control points (math in curveMath.js)
    function updateCurveFromPoints(channel) {
      const lut = buildCurveLut(state.curvePoints[channel]);
      const curve = state.curves[channel];
      for (let i = 0; i < 256; i++) curve[i] = lut[i];

      if (webglState.gl) webglState.curveDirty = true;
    }

    function renderCurve() {
      const cw = curveCanvas.width = curveCanvas.offsetWidth * 2;
      const ch = curveCanvas.height = curveCanvas.offsetHeight * 2;

      curveCtx.fillStyle = '#111';
      curveCtx.fillRect(0, 0, cw, ch);

      // Grid lines
      curveCtx.strokeStyle = '#333';
      curveCtx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = (i / 4) * cw;
        const y = (i / 4) * ch;
        curveCtx.beginPath();
        curveCtx.moveTo(x, 0);
        curveCtx.lineTo(x, ch);
        curveCtx.stroke();
        curveCtx.beginPath();
        curveCtx.moveTo(0, y);
        curveCtx.lineTo(cw, y);
        curveCtx.stroke();
      }

      // Diagonal reference line
      curveCtx.strokeStyle = '#444';
      curveCtx.beginPath();
      curveCtx.moveTo(0, ch);
      curveCtx.lineTo(cw, 0);
      curveCtx.stroke();

      // Draw the curve
      const colors = { r: '#ff6b6b', g: '#69db7c', b: '#74c0fc' };
      curveCtx.strokeStyle = colors[currentCurveChannel];
      curveCtx.lineWidth = 2;
      curveCtx.beginPath();

      const curve = state.curves[currentCurveChannel];
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * cw;
        const y = ch - (curve[i] / 255) * ch;
        if (i === 0) curveCtx.moveTo(x, y);
        else curveCtx.lineTo(x, y);
      }
      curveCtx.stroke();

      // Draw control points
      const points = state.curvePoints[currentCurveChannel];
      points.forEach((point, index) => {
        const px = (point.x / 255) * cw;
        const py = ch - (point.y / 255) * ch;
        const isHovered = hoveredPoint === index;
        const isDragging = draggingPoint === index;

        // Point circle
        curveCtx.beginPath();
        curveCtx.arc(px, py, isHovered || isDragging ? 8 : 6, 0, Math.PI * 2);
        curveCtx.fillStyle = isDragging ? '#fff' : (isHovered ? colors[currentCurveChannel] : '#222');
        curveCtx.fill();
        curveCtx.strokeStyle = colors[currentCurveChannel];
        curveCtx.lineWidth = 2;
        curveCtx.stroke();
      });
    }

    function setCurvePreset(preset) {
      pushUndo('curvePreset');
      state.curvePoints[currentCurveChannel] = getCurvePresetPoints(preset);
      updateCurveFromPoints(currentCurveChannel);
      renderCurve();
      markCurrentFileDirty();
      scheduleFullUpdate();
    }

    document.querySelectorAll('.curve-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.curve-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentCurveChannel = tab.dataset.channel;
        draggingPoint = null;
        hoveredPoint = null;
        renderCurve();
      });
    });

    document.querySelectorAll('.curve-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setCurvePreset(btn.dataset.preset));
    });

    document.getElementById('resetCurveBtn').addEventListener('click', () => {
      pushUndo('curveReset');
      // Reset ALL channels, not just the current one
      ['r', 'g', 'b'].forEach(channel => {
        state.curvePoints[channel] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
        updateCurveFromPoints(channel);
      });
      renderCurve();
      markCurrentFileDirty();
      scheduleFullUpdate();
    });

    // Get canvas position from mouse event
    function getCurvePosition(e) {
      const rect = curveCanvas.getBoundingClientRect();
      const scaleX = curveCanvas.width / rect.width;
      const scaleY = curveCanvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;
      return {
        x: Math.max(0, Math.min(255, Math.round((canvasX / curveCanvas.width) * 255))),
        y: Math.max(0, Math.min(255, 255 - Math.round((canvasY / curveCanvas.height) * 255))),
        canvasX,
        canvasY
      };
    }

    // Find point near position
    function findNearPoint(canvasX, canvasY, threshold = 15) {
      return findNearPointIndex(
        state.curvePoints[currentCurveChannel],
        canvasX, canvasY,
        curveCanvas.width, curveCanvas.height,
        threshold
      );
    }

    let curvePreUndoSnapshot = null;

    curveCanvas.addEventListener('mousedown', (e) => {
      beginPreviewTierSession('curve');
      curvePreUndoSnapshot = captureSnapshot('curveEdit');
      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        // Start dragging existing point
        draggingPoint = nearPoint;
      } else {
        // Add new point in sorted order
        draggingPoint = insertCurvePoint(state.curvePoints[currentCurveChannel], pos.x, pos.y);
        updateCurveFromPoints(currentCurveChannel);
        markCurrentFileDirty();
      }
      renderCurve();
    });

    curveCanvas.addEventListener('mousemove', (e) => {
      const pos = getCurvePosition(e);

      if (draggingPoint !== null) {
        touchPreviewTierSession('curve');
        moveCurvePoint(state.curvePoints[currentCurveChannel], draggingPoint, pos.x, pos.y);
        updateCurveFromPoints(currentCurveChannel);
        renderCurve();
        markCurrentFileDirty();
        schedulePreviewUpdate();
      } else {
        // Update hover state
        const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);
        if (nearPoint !== hoveredPoint) {
          hoveredPoint = nearPoint;
          renderCurve();
        }
        curveCanvas.style.cursor = nearPoint >= 0 ? 'grab' : 'crosshair';
      }
    });

    curveCanvas.addEventListener('mouseup', () => {
      endPreviewTierSession('mouseup', 'curve');
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          commitUndoSnapshot(curvePreUndoSnapshot);
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
    });

    curveCanvas.addEventListener('mouseleave', () => {
      endPreviewTierSession('mouseleave', 'curve');
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          commitUndoSnapshot(curvePreUndoSnapshot);
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
      hoveredPoint = null;
      renderCurve();
    });

    // Double-click to remove point (except endpoints)
    curveCanvas.addEventListener('dblclick', (e) => {
      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint > 0 && nearPoint < state.curvePoints[currentCurveChannel].length - 1) {
        pushUndo('curvePointDelete');
        state.curvePoints[currentCurveChannel].splice(nearPoint, 1);
        updateCurveFromPoints(currentCurveChannel);
        renderCurve();
        markCurrentFileDirty();
        scheduleFullUpdate();
      }
    });

    // Touch-friendly pointer support for iOS Safari. Keep mouse path above unchanged for PC.
    let activeCurvePointerId = null;

    curveCanvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      beginPreviewTierSession('curve');
      curvePreUndoSnapshot = captureSnapshot('curveEdit');

      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        draggingPoint = nearPoint;
      } else {
        draggingPoint = insertCurvePoint(state.curvePoints[currentCurveChannel], pos.x, pos.y);
        updateCurveFromPoints(currentCurveChannel);
        markCurrentFileDirty();
      }

      activeCurvePointerId = e.pointerId;
      curveCanvas.setPointerCapture(e.pointerId);
      renderCurve();
    }, { passive: false });

    curveCanvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      if (activeCurvePointerId !== e.pointerId || draggingPoint === null) return;
      e.preventDefault();
      touchPreviewTierSession('curve');

      const pos = getCurvePosition(e);
      moveCurvePoint(state.curvePoints[currentCurveChannel], draggingPoint, pos.x, pos.y);
      updateCurveFromPoints(currentCurveChannel);
      renderCurve();
      markCurrentFileDirty();
      schedulePreviewUpdate();
    }, { passive: false });

    function finishCurvePointerDrag(pointerId) {
      if (activeCurvePointerId !== pointerId) return;
      endPreviewTierSession('pointerup', 'curve');
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          commitUndoSnapshot(curvePreUndoSnapshot);
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
      if (curveCanvas.hasPointerCapture(pointerId)) {
        curveCanvas.releasePointerCapture(pointerId);
      }
      activeCurvePointerId = null;
    }

    curveCanvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      finishCurvePointerDrag(e.pointerId);
    });

    curveCanvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'mouse') return;
      finishCurvePointerDrag(e.pointerId);
    });

    // ===========================================
    // Image Processing Pipeline
    // ===========================================
    // WebGL is used to keep Step 3 adjustments responsive (WB/Tone/CMY/Curves) on large scans.
    // CPU rendering is still used for fallback + batch export.

    const webglState = {
      gl: null,
      program: null,
      quadBuffer: null,
      sourceTex: null,
      curveTex: null,
      disabledByError: false,
      lastError: null,
      curveDirty: true,
      sourceDirty: true,
      sourceSize: { w: 0, h: 0 },
      maxTextureSize: 0,
      handlersAttached: false,
      locations: {
        aPos: null,
        uImage: null,
        uCurve: null,
        uWb: null,
        uExposure: null,
        uContrast: null,
        uHighlights: null,
        uShadows: null,
        uTemp: null,
        uTint: null,
        uSat: null,
        uVib: null,
        uCmy: null
      },
      // describeWebglRenderer() of the current context (#263); #239 and #253
      // keep their shaders off software rasterisers.
      renderer: null
    };

    const webglCurveRgba = new Uint8Array(256 * 4);

    setupPreviewTierSessions();
    void loadWebviewCompositing();

    function disableWebGLByError(err) {
      const message = err && err.message ? err.message : String(err);
      if (!webglState.disabledByError) {
        console.error('WebGL render failed. Falling back to CPU preview:', message, err);
      }
      webglState.disabledByError = true;
      webglState.lastError = message;
      updateCanvasVisibility();
    }

    function compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
        gl.deleteShader(shader);
        throw new Error(info);
      }
      return shader;
    }

    function createProgram(gl, vsSource, fsSource) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) || 'Unknown program link error';
        gl.deleteProgram(program);
        throw new Error(info);
      }
      return program;
    }

    function initWebGLRenderer() {
      // The "WebGL Acceleration" checkbox was plumbed all the way to the engine
      // and read by nothing. Honour it here and in isWebGLActive: unchecking it
      // now genuinely falls back to the CPU preview path.
      if (state.coreUseWebGL === false) return false;
      if (webglState.disabledByError) return false;
      if (webglState.gl) return true;

      let gl = null;
      try {
        gl = glCanvas.getContext('webgl', {
          alpha: false,
          depth: false,
          stencil: false,
          antialias: false,
          preserveDrawingBuffer: false,
          premultipliedAlpha: false
        });
      } catch {
        gl = null;
      }

      if (!gl) {
        if (!renderEnvironment.rendererKnown) noteWebglRenderer(null);
        return false;
      }

      const vsSource = `
        attribute vec2 a_pos;
        varying vec2 v_uv;
        void main() {
          // Rows are uploaded top-down as stored. Flipping here instead of with
          // UNPACK_FLIP_Y_WEBGL spares the browser a flipped copy per upload;
          // the framebuffer keeps its bottom-up orientation.
          v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      `;

      const fsSource = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        #else
        precision mediump float;
        #endif
        varying vec2 v_uv;
        uniform sampler2D u_image;
        uniform sampler2D u_curve;

        uniform vec3 u_wb;
        uniform float u_exposure;
        uniform float u_contrast;
        uniform float u_highlights;
        uniform float u_shadows;
        uniform float u_temp;
        uniform float u_tint;
        uniform float u_sat;
        uniform float u_vib;
        uniform vec3 u_cmy;

        float hue2rgb(float p, float q, float t) {
          if (t < 0.0) t += 1.0;
          if (t > 1.0) t -= 1.0;
          if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
          if (t < 1.0 / 2.0) return q;
          if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
          return p;
        }

        vec3 rgbToHsl(vec3 c) {
          float r = c.r, g = c.g, b = c.b;
          float maxc = max(r, max(g, b));
          float minc = min(r, min(g, b));
          float h = 0.0;
          float s = 0.0;
          float l = (maxc + minc) * 0.5;

          if (maxc != minc) {
            float d = maxc - minc;
            s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);

            if (maxc == r) {
              h = (g - b) / d + (g < b ? 6.0 : 0.0);
            } else if (maxc == g) {
              h = (b - r) / d + 2.0;
            } else {
              h = (r - g) / d + 4.0;
            }
            h /= 6.0;
          }

          return vec3(h, s, l);
        }

        vec3 hslToRgb(float h, float s, float l) {
          float r, g, b;
          if (s == 0.0) {
            r = g = b = l;
          } else {
            float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
            float p = 2.0 * l - q;
            r = hue2rgb(p, q, h + 1.0 / 3.0);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1.0 / 3.0);
          }
          return vec3(r, g, b);
        }

        vec3 applyCurves(vec3 c) {
          float rIdx = floor(c.r * 255.0 + 0.5);
          float gIdx = floor(c.g * 255.0 + 0.5);
          float bIdx = floor(c.b * 255.0 + 0.5);
          vec4 cr = texture2D(u_curve, vec2((rIdx + 0.5) / 256.0, 0.5));
          vec4 cg = texture2D(u_curve, vec2((gIdx + 0.5) / 256.0, 0.5));
          vec4 cb = texture2D(u_curve, vec2((bIdx + 0.5) / 256.0, 0.5));
          return vec3(cr.r, cg.g, cb.b);
        }

        void main() {
          vec3 c = texture2D(u_image, v_uv).rgb;

          float exposureMult = pow(2.0, u_exposure);
          c *= u_wb * exposureMult;

          c = (c - 0.5) * u_contrast + 0.5;

          float luma = dot(c, vec3(0.299, 0.587, 0.114));
          if (u_highlights != 0.0 && luma > 0.5) {
            float mult = 1.0 + u_highlights * (luma - 0.5) * 2.0;
            c *= mult;
          }
          if (u_shadows != 0.0 && luma < 0.5) {
            float mult = 1.0 + u_shadows * (0.5 - luma) * 2.0;
            c *= mult;
          }

          c.r *= (1.0 + u_temp * 0.3);
          c.b *= (1.0 - u_temp * 0.3);
          c.g *= (1.0 + u_tint * 0.3);
          c = clamp(c, 0.0, 1.0);

          if (u_sat != 1.0 || u_vib != 0.0) {
            vec3 hsl = rgbToHsl(c);
            float s = hsl.y * u_sat;
            if (u_vib >= 0.0) {
              s += (1.0 - s) * u_vib;
            } else {
              s *= (1.0 + u_vib);
            }
            hsl.y = clamp(s, 0.0, 1.0);
            c = hslToRgb(hsl.x, hsl.y, hsl.z);
          }

          vec3 cmy = vec3(1.0) - c;
          cmy = clamp(cmy + u_cmy, 0.0, 1.0);
          c = vec3(1.0) - cmy;

          c = applyCurves(c);

          gl_FragColor = vec4(c, 1.0);
        }
      `;

      try {
        webglState.program = createProgram(gl, vsSource, fsSource);
      } catch (err) {
        console.warn('WebGL shader init failed:', err);
        return false;
      }

      webglState.gl = gl;
      webglState.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;

      if (!webglState.handlersAttached) {
        glCanvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          // Mark renderer as unavailable; fall back to CPU.
          webglState.gl = null;
          webglState.program = null;
          webglState.quadBuffer = null;
          webglState.sourceTex = null;
          webglState.curveTex = null;
          webglState.sourceSize = { w: 0, h: 0 };
          webglState.maxTextureSize = 0;
          webglState.curveDirty = true;
          webglState.sourceDirty = true;
          webglState.lastError = null;
          updateCanvasVisibility();
          schedulePreviewUpdate();
        }, false);

        glCanvas.addEventListener('webglcontextrestored', () => {
          // Resources are lost; re-init lazily on next render.
          webglState.gl = null;
          webglState.program = null;
          webglState.quadBuffer = null;
          webglState.sourceTex = null;
          webglState.curveTex = null;
          webglState.sourceSize = { w: 0, h: 0 };
          webglState.maxTextureSize = 0;
          webglState.curveDirty = true;
          webglState.sourceDirty = true;
          webglState.lastError = null;
          schedulePreviewUpdate();
        }, false);

        webglState.handlersAttached = true;
      }

      // Full-screen quad
      webglState.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
         1,  1
      ]), gl.STATIC_DRAW);

      gl.useProgram(webglState.program);

      webglState.locations.aPos = gl.getAttribLocation(webglState.program, 'a_pos');
      webglState.locations.uImage = gl.getUniformLocation(webglState.program, 'u_image');
      webglState.locations.uCurve = gl.getUniformLocation(webglState.program, 'u_curve');
      webglState.locations.uWb = gl.getUniformLocation(webglState.program, 'u_wb');
      webglState.locations.uExposure = gl.getUniformLocation(webglState.program, 'u_exposure');
      webglState.locations.uContrast = gl.getUniformLocation(webglState.program, 'u_contrast');
      webglState.locations.uHighlights = gl.getUniformLocation(webglState.program, 'u_highlights');
      webglState.locations.uShadows = gl.getUniformLocation(webglState.program, 'u_shadows');
      webglState.locations.uTemp = gl.getUniformLocation(webglState.program, 'u_temp');
      webglState.locations.uTint = gl.getUniformLocation(webglState.program, 'u_tint');
      webglState.locations.uSat = gl.getUniformLocation(webglState.program, 'u_sat');
      webglState.locations.uVib = gl.getUniformLocation(webglState.program, 'u_vib');
      webglState.locations.uCmy = gl.getUniformLocation(webglState.program, 'u_cmy');

      // Textures
      webglState.sourceTex = gl.createTexture();
      // A new texture has no storage yet: the first upload must allocate it.
      webglState.sourceSize = { w: 0, h: 0 };
      gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      webglState.curveTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // Bind samplers
      gl.uniform1i(webglState.locations.uImage, 0);
      gl.uniform1i(webglState.locations.uCurve, 1);

      // Unpack state is per context and never changes after this.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      webglState.curveDirty = true;
      webglState.sourceDirty = true;
      webglState.lastError = null;
      noteWebglRenderer(gl);

      return true;
    }

    function isWebGLActive() {
      if (state.cropping) return false;
      if (state.coreUseWebGL === false) return false;
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;
      if (state.dodgeBurn && state.dodgeBurn.active) return false;
      if (state.look) return false;
      // The rescue curves live in the CPU adjustment stage, like the look.
      if (state.expiredEnabled && state.expiredAnalysis) return false;
      if (state.sprocketPreviewEnabled) return false;
      return !!webglState.gl && !webglState.disabledByError && state.currentStep >= 3 && !!state.processedImageData;
    }

    // The drawing buffer matches the texture it shows, not the zoomed
    // viewport. A zoom gesture only moves the CSS transform; the buffer (whose
    // resize clears it) changes only when a new texture is drawn after the
    // display preview settles at the new size.
    function resizeWebGLCanvas(width = webglState.sourceSize.w, height = webglState.sourceSize.h) {
      if (!webglState.gl || !(width > 0) || !(height > 0)) return;
      // A reduced session (#263) caps the buffer below the texture; the
      // shader samples the texture, so the draw only gets smaller.
      if (previewTier === 'reduced') ({ width, height } = capBackingSize(width, height, previewTierMaxPixels('reduced')));
      if (glCanvas.width !== width) glCanvas.width = width;
      if (glCanvas.height !== height) glCanvas.height = height;
    }

    function getWebglSourceImageData() {
      const full = state.processedImageData;
      if (!full) return null;

      const maxTex = webglState.maxTextureSize || 0;
      const targetMaxDim = maxTex || 8192;

      let src = state.webglSourceImageData;
      if (!src || src.width !== Math.min(src.width, targetMaxDim) || src.height !== Math.min(src.height, targetMaxDim)) {
        // If cached source is missing or too large for the current device, rebuild from full-res.
        src = buildWebglSourceImageData(full, targetMaxDim);
        state.webglSourceImageData = src;
      }

      // Safety: if the result still doesn't fit (very old GPUs), force it down.
      if (maxTex && (src.width > maxTex || src.height > maxTex)) {
        src = buildWebglSourceImageData(full, maxTex);
        state.webglSourceImageData = src;
      }

      return src;
    }

    function webglUploadSource(imageData) {
      if (!webglState.gl) return;
      if (!imageData) return;

      const gl = webglState.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
      if (webglState.sourceSize.w !== imageData.width || webglState.sourceSize.h !== imageData.height) {
        // Allocate only when the size changes. This is the one place an
        // out-of-memory can surface, so it keeps the only error check; a
        // failure throws into disableWebGLByError and the CPU preview.
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          imageData.width,
          imageData.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          imageData.data
        );
        const errCode = gl.getError();
        if (errCode !== gl.NO_ERROR) {
          webglState.sourceSize = { w: 0, h: 0 };
          // A lost context reports itself here as well; its own events
          // restore the renderer, so it must not disable WebGL for good.
          if (errCode === gl.CONTEXT_LOST_WEBGL || gl.isContextLost()) return;
          throw new Error(`WebGL texture allocation error code: ${errCode}`);
        }
        webglState.sourceSize.w = imageData.width;
        webglState.sourceSize.h = imageData.height;
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          imageData.width,
          imageData.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          imageData.data
        );
      }
      webglState.sourceDirty = false;
    }

    function webglUploadCurves() {
      if (!webglState.gl) return;
      const gl = webglState.gl;

      for (let i = 0; i < 256; i++) {
        const idx = i * 4;
        webglCurveRgba[idx] = state.curves.r[i];
        webglCurveRgba[idx + 1] = state.curves.g[i];
        webglCurveRgba[idx + 2] = state.curves.b[i];
        webglCurveRgba[idx + 3] = 255;
      }

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        webglCurveRgba
      );

      webglState.curveDirty = false;
    }

    function webglSetUniforms() {
      const gl = webglState.gl;
      if (!gl) return;
      // The shader reads seven scalars. Sanitise just those, with the same
      // arguments sanitizeSettings(state, { fallbackSettings: state }) uses,
      // instead of rebuilding every setting (and both stroke sets) per draw.
      // SilverCore bakes the legacy tone controls into the conversion
      // (usesSilverCoreConversion is true for every film type), so their
      // uniforms stay at the identity values.
      const vibrance = sanitizeNumeric(state.vibrance, state.vibrance ?? 0, -100, 100);
      const wbR = sanitizeNumeric(state.wbR, state.wbR ?? 1, 0.5, 2);
      const wbG = sanitizeNumeric(state.wbG, state.wbG ?? 1, 0.5, 2);
      const wbB = sanitizeNumeric(state.wbB, state.wbB ?? 1, 0.5, 2);
      const cyan = sanitizeNumeric(state.cyan, state.cyan ?? 0, -100, 100);
      const magenta = sanitizeNumeric(state.magenta, state.magenta ?? 0, -100, 100);
      const yellow = sanitizeNumeric(state.yellow, state.yellow ?? 0, -100, 100);

      gl.uniform3f(webglState.locations.uWb, wbR, wbG, wbB);
      gl.uniform1f(webglState.locations.uExposure, 0);
      gl.uniform1f(webglState.locations.uContrast, 1);
      gl.uniform1f(webglState.locations.uHighlights, 0);
      gl.uniform1f(webglState.locations.uShadows, 0);
      gl.uniform1f(webglState.locations.uTemp, 0);
      gl.uniform1f(webglState.locations.uTint, 0);
      gl.uniform1f(webglState.locations.uSat, 1);
      gl.uniform1f(webglState.locations.uVib, vibrance / 100);
      gl.uniform3f(webglState.locations.uCmy, cyan / 100, magenta / 100, yellow / 100);
    }

    function renderWebGL() {
      if (state.cropping || !webglState.gl || webglState.disabledByError || !state.processedImageData) return false;

      try {
        const source = getWebglSourceImageData();
        if (!source) return false;
        // Refits only when the texture, container, reference size or zoom
        // changed since the last fit; otherwise it touches no layout.
        adjustCanvasDisplay(source.width, source.height);

        const gl = webglState.gl;
        gl.useProgram(webglState.program);

        // Uploads if needed
        if (webglState.sourceDirty || webglState.sourceSize.w !== source.width || webglState.sourceSize.h !== source.height) {
          webglUploadSource(source);
        }
        if (webglState.curveDirty) {
          webglUploadCurves();
        }
        resizeWebGLCanvas(source.width, source.height);
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);

        // Bind geometry
        gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
        gl.enableVertexAttribArray(webglState.locations.aPos);
        gl.vertexAttribPointer(webglState.locations.aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);

        webglSetUniforms();

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // getError is a round trip to the GPU process that waits behind the
        // upload just queued. Context loss has its own event, and allocation
        // failures are checked in webglUploadSource; ?debugGL restores it.
        if (WEBGL_DEBUG_ERRORS) {
          const errCode = gl.getError();
          if (errCode !== gl.NO_ERROR) {
            throw new Error(`WebGL draw error code: ${errCode}`);
          }
        }
        return true;
      } catch (err) {
        disableWebGLByError(err);
        return false;
      }
    }

    function updateCanvasVisibility() {
      const showGL = isWebGLActive();
      glCanvas.style.display = showGL ? 'block' : 'none';
      canvas.style.display = showGL ? 'none' : 'block';
    }

    let updateScheduled = false;
    let fullUpdateTimer = null;

    let fullAdjustedBuffer = null;
    let previewAdjustedBuffer = null;
    let histogramAdjustedBuffer = null;
    let lastHistogramUpdateTime = 0;
    // The active tile is a function of the converted preview source it was
    // sampled from and the exact adjustment settings. Remember both per item,
    // with the data URL made from them: zoom, pan and resize redraws change
    // neither, so they rebuild nothing, and any other writer of the tile
    // (roll-transaction undo) shows up as a different data URL.
    const studioThumbnailInputs = new WeakMap();
    const STUDIO_THUMBNAIL_SETTLE_MS = 250;
    let studioThumbnailUpdateTimer = 0;
    let studioThumbnailUpdateFrame = 0;

    function renderHistogramForWebGL(force = false) {
      if (!state.processedImageData) return;
      const now = performance.now();
      if (!force && (now - lastHistogramUpdateTime) < HISTOGRAM_UPDATE_INTERVAL_MS) return;

      const source = state.histogramSourceImageData || state.previewSourceImageData || state.processedImageData;
      histogramAdjustedBuffer = ensureImageDataBuffer(histogramAdjustedBuffer, source.width, source.height);
      applyAdjustmentsToBuffer(source, state, histogramAdjustedBuffer, 'preview');
      renderHistogram(histogramAdjustedBuffer);
      lastHistogramUpdateTime = now;
    }

    function schedulePreviewUpdate() {
      postponeFullResolutionRenderForInteraction();
      if (!updateScheduled) {
        updateScheduled = true;
        requestAnimationFrame(() => {
          updatePreview();
          updateScheduled = false;
        });
      }
    }

    function scheduleFullUpdate() {
      if (fullUpdateTimer) clearTimeout(fullUpdateTimer);
      // Full-res CPU rendering can be expensive on large scans; debounce aggressively.
      fullUpdateTimer = setTimeout(() => {
        fullUpdateTimer = null;
        if (hasFrameRepairs() && state.dustRemoval.cleanSource) {
          updateFull();
          return;
        }
        // If SilverCore mode and we were using preview-resolution, run full reprocess
        if (usesSilverCoreConversion(state) && state.conversionSourceImageData
          && state.conversionPreviewImageData && state.conversionPreviewImageData !== state.conversionSourceImageData) {
          scheduleFullResolutionRender('scheduleFullUpdate', FULL_RESOLUTION_INTERACTIVE_DELAY_MS);
          return;
        }
        updateFull();
      }, 1200);
    }

    function cancelFullUpdate() {
      if (!fullUpdateTimer) return;
      clearTimeout(fullUpdateTimer);
      fullUpdateTimer = null;
    }

    function updatePreview() {
      if (!state.processedImageData) return;
      if (state.beforeAfterActive || state.cropping) return;
      scheduleStudioThumbnailUpdate();

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
          settleInterimGeometryDisplay();
          renderHistogramForWebGL(false);
          state.displayImageData = null;
          state.lastRenderQuality = 'gl';
          return;
        }
      }

      updateCanvasVisibility();
      updatePreviewCpu();
    }

    function updatePreviewCpu() {
      if (!state.processedImageData || state.cropping) return;

      const source = state.previewSourceImageData || state.processedImageData;
      previewAdjustedBuffer = ensureImageDataBuffer(previewAdjustedBuffer, source.width, source.height);
      // Rewritten in place on every render: an export copies it in one task.
      markLiveMutableBuffer(previewAdjustedBuffer);
      applyAdjustmentsToBuffer(source, state, previewAdjustedBuffer, 'preview');

      if (source !== state.processedImageData) {
        renderAdjustedImageDataToMainCanvas(previewAdjustedBuffer, state.processedImageData, {
          fastSprocketPreview: true
        });
        state.lastRenderQuality = 'preview';
      } else {
        renderAdjustedImageDataToMainCanvas(previewAdjustedBuffer, source, {
          fastSprocketPreview: true
        });
        state.displayImageData = previewAdjustedBuffer;
        state.lastRenderQuality = 'full';
      }
      // Histogram updates are deferred to full renders for responsiveness.
      if (state.dustRemoval.showMask && state.dustRemoval.mask) renderDustMaskOverlay();
      renderDodgeBurnOverlay();
    }

    function updateFull() {
      if (!state.processedImageData) return;
      if (state.beforeAfterActive || state.cropping) return;
      scheduleStudioThumbnailUpdate({ settled: true });
      // Whether a 16-bit export keeps 16-bit samples depends on the Step-3
      // controls, so the export panel's warning has to follow them.
      updateExportUI();

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
          settleInterimGeometryDisplay();
          renderHistogramForWebGL(true);
          state.displayImageData = null;
          state.lastRenderQuality = 'gl';
          return;
        }
      }

      updateCanvasVisibility();
      updateFullCpu();
    }

    function updateFullCpu() {
      if (!state.processedImageData || state.cropping) return;

      const source = state.processedImageData;
      fullAdjustedBuffer = ensureImageDataBuffer(fullAdjustedBuffer, source.width, source.height);
      // Rewritten in place on every full render: an export copies it in one task.
      markLiveMutableBuffer(fullAdjustedBuffer);
      applyAdjustmentsToBuffer(source, state, fullAdjustedBuffer, 'full');
      state.displayImageData = fullAdjustedBuffer;
      renderAdjustedImageDataToMainCanvas(fullAdjustedBuffer, source);
      renderHistogram(fullAdjustedBuffer);

      state.lastRenderQuality = 'full';
      if (state.dustRemoval.showMask && state.dustRemoval.mask) renderDustMaskOverlay();
      renderDodgeBurnOverlay();
    }

    function renderFullWebGL() {
      if (!webglState.gl || !state.processedImageData) return false;
      // WebGL only usable for legacy tone path (non-SilverCore)
      if (usesSilverCoreConversion(state)) return false;
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;
      if (state.dodgeBurn && state.dodgeBurn.active) return false;

      const source = state.processedImageData;
      const gl = webglState.gl;
      const maxTex = webglState.maxTextureSize || 0;
      if (maxTex && (source.width > maxTex || source.height > maxTex)) return false;

      try {
        // Save original canvas size
        const origW = glCanvas.width;
        const origH = glCanvas.height;

        // Resize to full resolution
        glCanvas.width = source.width;
        glCanvas.height = source.height;
        gl.viewport(0, 0, source.width, source.height);
        gl.useProgram(webglState.program);

        // Upload full-res source
        webglUploadSource(source);
        webglUploadCurves();
        webglSetUniforms();

        // Bind geometry
        gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
        gl.enableVertexAttribArray(webglState.locations.aPos);
        gl.vertexAttribPointer(webglState.locations.aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.finish();

        // Read back pixels
        const pixels = new Uint8Array(source.width * source.height * 4);
        gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // WebGL readPixels returns Y-flipped data — flip it
        const rowSize = source.width * 4;
        const tempRow = new Uint8Array(rowSize);
        for (let y = 0; y < (source.height >> 1); y++) {
          const topOffset = y * rowSize;
          const bottomOffset = (source.height - 1 - y) * rowSize;
          tempRow.set(pixels.subarray(topOffset, topOffset + rowSize));
          pixels.set(pixels.subarray(bottomOffset, bottomOffset + rowSize), topOffset);
          pixels.set(tempRow, bottomOffset);
        }

        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), source.width, source.height);

        // Restore canvas size
        glCanvas.width = origW;
        glCanvas.height = origH;

        // Mark source as dirty so next preview re-uploads the preview-sized texture
        webglState.sourceDirty = true;

        return imageData;
      } catch (err) {
        console.warn('WebGL full-res render failed, falling back to CPU:', err);
        return false;
      }
    }

    function ensureFullRender() {
      if (!state.processedImageData) return;

      // Try WebGL for 8-bit export (legacy tone path only)
      if (!usesSilverCoreConversion(state) && webglState.gl && !webglState.disabledByError) {
        const result = renderFullWebGL();
        if (result && result instanceof ImageData) {
          state.displayImageData = result;
          renderAdjustedImageDataToMainCanvas(result, result);
          renderHistogram(result);
          state.lastRenderQuality = 'full';
          return;
        }
      }

      // Fallback to CPU
      updateFullCpu();
    }

    function isDisplayImageDataFullResolution() {
      return Boolean(
        state.displayImageData
        && state.processedImageData
        && !state.processedImageDataIsPreview
        && state.displayImageData.width === state.processedImageData.width
        && state.displayImageData.height === state.processedImageData.height
      );
    }

    function applyProcessedImageToState(processed, options = {}) {
      if (!processed) return;
      const previewOnly = Boolean(options.previewOnly);
      releaseCorePreviewRetained(processed);
      state.processedImageData = processed;
      state.processedImageDataIsPreview = previewOnly;
      if (!previewOnly) {
        state.fullResolutionPending = false;
      }
      state.displayImageData = null;
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.histogramSourceImageData = histogramSourceFor(processed);
      state.webglSourceImageData = state.previewSourceImageData;
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      // 非同期変換は結果を保存してよいが、切り抜き草稿の画布を変更しない。
      if (state.cropping) return;
      if (state.sprocketPreviewEnabled) {
        const frameMetrics = getSprocketFrameMetrics(processed.width, processed.height);
        setMainCanvasDimensions(frameMetrics.outputWidth, frameMetrics.outputHeight);
      } else {
        setMainCanvasDimensions(processed.width, processed.height);
      }
    }

    // Automatic gray point: estimate WB gains from the freshly converted
    // positive so most images never need a manual gray-point click. Runs only
    // when a NEW positive is produced (processNegative) — never on preview
    // re-renders, core-control tweaks, dust updates, or undo restores — and
    // never once the user has sampled a gray point or touched the RGB gain
    // sliders. Low-confidence estimates apply nothing and leave the existing
    // gray-point guide nudging toward the manual click instead.
    function maybeAutoWhiteBalance(processed) {
      if (!usesSilverCoreConversion(state)) return;
      if (sanitizePresetType(state.filmType || 'color') !== 'color') return;
      // The expired-film rescue balances per tonal band; a global gain on top
      // would fight it.
      if (state.expiredEnabled) return;
      if (state.grayPointSampled || state.wbUserOverride || state.wbSemanticApplied) return;
      if (state.autoFrame.lastDiagnostics?.analysisNeedsReview) return;
      const reference = processed?.__analysisPreview;
      const source = reference || state.previewSourceImageData || state.processedImageData;
      if (!source) return;
      const roi = resolveAnalysisRegion({ ...state, autoFrameMeta: state.autoFrame.lastDiagnostics }, state.loadedBaseImageData || state.originalImageData);
      const estimate = state.semanticMap ? estimateAutoWhiteBalance(processed, { anchors: state.semanticMap }) : estimateAutoWhiteBalance(reference ? source : roi ? cropImageData(source, analysisPixelBounds(source.width, source.height, roi, 0.02)) : source);
      if (estimate.confidence === 'low') {
        // Only clear a previous auto estimate; user-owned gains stay put.
        if (state.wbAutoConfidence && state.wbAutoConfidence !== 'low') {
          state.wbR = 1;
          state.wbG = 1;
          state.wbB = 1;
          state.wbAutoConfidence = null; state.wbSemanticApplied = false;
          updateWBSliders();
          updateGrayPointGuideUI();
        }
        state.wbAutoConfidence = 'low';
        return;
      }
      state.wbR = estimate.wbR;
      state.wbG = estimate.wbG;
      state.wbB = estimate.wbB;
      state.wbAutoConfidence = estimate.confidence;
      updateWBSliders();
      updateGrayPointGuideUI();
      markCurrentFileDirty();
    }

    // Full-resolution conversions run in a worker so a 90+ MP scan does not
    // freeze the UI for seconds. Interactive previews have a separate worker.
    let conversionWorkerBroken = false;
    let conversionWorkerTimeouts = 0;
    async function convertFrameOffMainThread({ imageData, settings, options }) {
      if (!conversionWorkerBroken && usesSilverCoreConversion(state)) {
        try {
          return await convertFrameInWorker({ imageData, settings, options });
        } catch (err) {
          // Only retire the worker for infrastructure failures. A conversion
          // that threw inside it will throw on the main thread too, and
          // disabling the worker for that costs every later full-resolution
          // render a frozen UI on large scans. A timeout is the likeliest false
          // positive of all — a big scan on a slow machine — so it gets two
          // strikes before the worker is written off for the session.
          if (err?.code === CONVERSION_FAILED) {
            console.warn('Conversion failed in worker, retrying on main thread:', err?.message || err);
          } else if (err?.code === WORKER_TIMEOUT) {
            conversionWorkerTimeouts += 1;
            if (conversionWorkerTimeouts >= 2) {
              conversionWorkerBroken = true;
              console.warn('Conversion worker timed out repeatedly, using main thread from now on');
            } else {
              console.warn('Conversion worker timed out, retrying on the main thread this once');
            }
          } else {
            conversionWorkerBroken = true;
            console.warn('Conversion worker unavailable, using main thread:', err?.message || err);
          }
        }
      }
      return convertFrameWithRouter({ imageData, settings, options });
    }

    async function convertFromCurrentSource(settings = state, { preview = false, interactive = false, includeAnalysisPreview = true, retain16 = false } = {}) {
      const fullSource = state.conversionSourceImageData || state.croppedImageData || state.originalImageData;
      if (!fullSource) return null;
      if (!state.conversionSourceImageData) noteGeometryPixelRead('convertFromCurrentSource');
      const source = (preview && state.conversionPreviewImageData) ? state.conversionPreviewImageData : fullSource;
      const request = {
        imageData: source,
        settings: buildRouterSettings(settings),
        options: {
          preview,
          includeAnalysisPreview,
          analysisImageData: getColorAnalysisSample(settings),
          forceFullProcess: !preview && !interactive,
          // The preview worker keeps this frame's 16-bit plane until it is
          // committed, and sends the histogram sample built from it instead.
          ...(retain16 ? { retain16: true, histogramSamples: HISTOGRAM_MAX_SAMPLES } : {})
        }
      };
      if (preview || interactive) {
        try {
          return await convertPreviewFrameInWorker(request);
        } catch (err) {
          console.warn('Preview worker failed, retrying on main thread:', err?.message || err);
          return await convertFrameWithRouter(request);
        }
      }
      return await convertFrameOffMainThread(request);
    }

    // The armed dispatch gate (see coreReprocessDispatcher.js): truthy while a
    // request is held in coreReprocessScheduled, null otherwise.
    let coreReprocessTimer = null;
    let coreReprocessScheduled = null;
    let coreReprocessToken = 0;
    const coreReprocessGates = createCoreReprocessGates({
      timeline: document.timeline || null,
      isHidden: () => document.hidden
    });
    // Unlike slider tokens, a restart generation must never admit an older
    // preview, even when a newer preview is already queued for the same source.
    let coreReprocessGeneration = 0;
    let step2AutoConvertTimer = null;
    let step2AutoConvertToken = 0;
    let processNegativeInFlight = null;

    function canAutoConvertFromStep2() {
      if (state.currentStep < 2 || state.currentStep >= 3) return false;
      if (!usesSilverCoreConversion(state)) return false;
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return false;
      if (requiresFilmBase(state) && !state.filmBaseSet) return false;
      if (state.samplingMode === 'filmBase' || state.cropping) return false;
      return true;
    }

    async function runAutoConvertFromStep2(options = {}) {
      const token = Number.isInteger(options.token) ? options.token : null;
      if (token !== null && token !== step2AutoConvertToken) return;
      if (!canAutoConvertFromStep2()) return;

      await processNegative();
    }

    function scheduleAutoConvertFromStep2(options = {}) {
      if (!canAutoConvertFromStep2()) return;
      const immediate = Boolean(options.immediate);
      const token = ++step2AutoConvertToken;

      if (step2AutoConvertTimer) clearTimeout(step2AutoConvertTimer);
      step2AutoConvertTimer = setTimeout(() => {
        step2AutoConvertTimer = null;
        void runAutoConvertFromStep2({ token }).catch((err) => {
          console.error('Step2 auto convert failed:', err);
        });
      }, immediate ? 0 : 70);
    }

    function scheduleSilverSourceRefresh(options = {}) {
      if (!usesSilverCoreConversion(state)) return;
      if (state.currentStep >= 3) {
        scheduleCoreReprocess({ full: false });
        return;
      }
      scheduleAutoConvertFromStep2(options);
    }

    function applyPreviewProcessedImageToState(processed) {
      if (!processed) return;
      if (!state.processedImageData || state.processedImageDataIsPreview) {
        applyProcessedImageToState(processed, { previewOnly: true });
        return;
      }
      // Only update preview-related state; leave processedImageData untouched
      // so that full-resolution export remains correct. It is now stale
      // relative to what the user sees, so flag it: without this an export
      // fired inside the debounce window passes the "already full resolution"
      // check in ensureFullResolutionReadyForExport and silently writes the
      // previous conversion.
      state.fullResolutionPending = true;
      releaseCorePreviewRetained(processed);
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.histogramSourceImageData = histogramSourceFor(processed);
      state.webglSourceImageData = state.previewSourceImageData;
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      const fullW = state.processedImageData ? state.processedImageData.width : processed.width;
      const fullH = state.processedImageData ? state.processedImageData.height : processed.height;
      if (!state.cropping) setMainCanvasDimensions(fullW, fullH);
    }

    let _coreReprocessFullInFlight = false;
    // The running preview flight's own token object, or false. A follow-up
    // posted early (postPendingPreviewEarly) takes the lane over while its
    // predecessor still applies its result; that predecessor's finally then
    // clears the flag only if it is still its own.
    let _coreReprocessPreviewInFlight = false;
    let _coreReprocessPending = null;
    // An export has to wait for the reprocess chain to drain, and
    // rerenderWithCoreControls returns immediately when it queues itself behind
    // a run already in flight — so the caller's promise is not a usable handle.
    // Count the calls that are genuinely doing work instead, and hand out a
    // promise that settles when the count reaches zero.
    let _coreReprocessActive = 0;
    let _coreReprocessIdle = null;
    let _resolveCoreReprocessIdle = null;
    // While a slider drags a frame with a separate display preview, the preview
    // worker keeps each frame's 16-bit plane (the next frame writes into it)
    // and sends the 8-bit plane and a histogram sample only. The frame on
    // screen is `corePreviewRetained` until its plane is committed back: on
    // release, after CORE_PREVIEW_COMMIT_IDLE_MS without a new frame, and
    // before an export, a photo switch or a snapshot reads it. `?retain16=0`
    // turns this off.
    const CORE_RETAIN_PREVIEW_PLANE = new URLSearchParams(window.location.search).get('retain16') !== '0';
    const CORE_PREVIEW_COMMIT_IDLE_MS = 150;
    let corePreviewRetained = null;
    let corePreviewCommit = null;
    let corePreviewCommitWanted = false;
    let corePreviewCommitTimer = null;
    let corePreviewSettleWaiters = [];

    function coreReprocessBusy() {
      return _coreReprocessActive > 0 || _coreReprocessPending !== null
        || _coreReprocessFullInFlight || Boolean(_coreReprocessPreviewInFlight)
        || corePreviewRetained !== null || corePreviewCommit !== null;
    }

    function whenCoreReprocessIdle() {
      if (!coreReprocessBusy()) return null;
      if (!_coreReprocessIdle) {
        _coreReprocessIdle = new Promise((resolve) => { _resolveCoreReprocessIdle = resolve; });
      }
      return _coreReprocessIdle;
    }

    function noteCoreReprocessSettled() {
      if (coreReprocessBusy()) return;
      const resolve = _resolveCoreReprocessIdle;
      _coreReprocessIdle = null;
      _resolveCoreReprocessIdle = null;
      if (resolve) resolve();
    }

    function runCoreReprocess(options) {
      _coreReprocessActive += 1;
      return rerenderWithCoreControls(options)
        .catch((err) => {
          // A failed frame must be retried when the slider is released.
          coreSliderCommitRecord = null;
          console.error('Core reprocess failed:', err);
        })
        .finally(() => {
          _coreReprocessActive -= 1;
          noteCoreReprocessSettled();
        });
    }

    function resetDustForCleanSource(source) {
      dustDetectionRevision += 1;
      dustPassCache = null;
      state.dustRemoval.cleanSource = source || null;
      state.dustRemoval._state = null;
      state.dustRemoval.mask = null;
      state.dustRemoval.maskTag = null;
      noteDustReplaced();
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.particleCount = 0;
    }

    // Resolves true only when it actually rendered. Callers use that to decide
    // whether the display is up to date: a blocked or superseded call queues
    // itself and returns at once, and treating that as a completed render is
    // how a stale frame reached the exporter.
    async function rerenderWithCoreControls(options = {}) {
      const full = Boolean(options.full) || hasFrameRepairs();
      const token = Number.isInteger(options.token) ? options.token : coreReprocessToken;
      const generation = options.generation ?? coreReprocessGeneration;
      const sourceRef = options.sourceRef || state.conversionSourceImageData;
      if (generation !== coreReprocessGeneration) return false;
      if (!usesSilverCoreConversion(state)) return false;
      if (!state.conversionSourceImageData) return false;
      if (sourceRef && state.conversionSourceImageData !== sourceRef) return false;

      // In-flight guard: serialize preview-vs-preview and full-vs-anything,
      // but let a preview reprocess run while a full-resolution render is
      // busy in the worker — queueing it behind the full render would freeze
      // slider feedback for the whole render.
      const blocked = full
        ? (_coreReprocessFullInFlight || _coreReprocessPreviewInFlight)
        : _coreReprocessPreviewInFlight;
      if (blocked) {
        const displayResize = Boolean(options.displayResize)
          && (!_coreReprocessPending || _coreReprocessPending.displayResize === true);
        const displayResizeFrom = displayResize
          ? _coreReprocessPending?.displayResizeFrom || options.displayResizeFrom || null : null;
        _coreReprocessPending = { ...options, full, token, sourceRef, generation, displayResize, displayResizeFrom };
        return false;
      }
      const previewFlight = full ? null : {};
      if (full) _coreReprocessFullInFlight = true;
      else _coreReprocessPreviewInFlight = previewFlight;

      try {
        if (full) {
          // Full-resolution path
          const processed = await convertFromCurrentSource(state, { preview: false, includeAnalysisPreview: false });
          if (!processed) return false;
          if (generation !== coreReprocessGeneration) return false;
          if (token !== null && token !== coreReprocessToken) return false;
          if (sourceRef && state.conversionSourceImageData !== sourceRef) return false;
          applyProcessedImageToState(processed);
          updateFull();
          if (hasFrameRepairs()) {
            resetDustForCleanSource(processed);
            scheduleDustDetection();
          }
          return true;
        } else {
          // DPR の変更は CSS resize を発火しない場合もあるため、入力時にも確認。
          // The preview tier (#263) may also have changed since the last tick.
          ensureConversionPreviewForDisplay();
          // Check if preview source is actually smaller than full source
          const hasSmallPreview = state.conversionPreviewImageData
            && state.conversionPreviewImageData !== state.conversionSourceImageData;
          const reducedInput = hasSmallPreview && reducedDisplayImages.has(state.conversionPreviewImageData);

          // Preview-resolution path: run SilverCore on small image. Its 16-bit
          // plane may stay in the worker until committed; never when the
          // preview is the source, whose plane feeds the 16-bit export.
          const retain16 = CORE_RETAIN_PREVIEW_PLANE && Boolean(hasSmallPreview) && options.retain16 !== false;
          const previewProcessed = await convertFromCurrentSource(state, { preview: hasSmallPreview, interactive: true, includeAnalysisPreview: false, retain16 });
          if (!previewProcessed) return false;
          if (reducedInput) reducedDisplayImages.add(previewProcessed);
          if (generation !== coreReprocessGeneration) return false;
          if (state.conversionSourceImageData !== sourceRef) return false;
          // 連続入力中も完了したフレームを表示する。別画像の結果は破棄し、
          // 古い設定のフレームを「書き出し可能な原寸」としては扱わない。
          const superseded = token !== coreReprocessToken;
          const nextPreview = coreReprocessScheduled || _coreReprocessPending;
          if (superseded && (!nextPreview || nextPreview.full || nextPreview.token !== coreReprocessToken)) return false;
          // Start the worker on the next frame before this one is applied and
          // drawn, so it does not sit idle through the result handling.
          postPendingPreviewEarly(previewFlight);

          const replacedSource = displayResizeReplaces(options);
          if (hasSmallPreview || superseded) {
            // Preview source is smaller — update preview display path only
            applyPreviewProcessedImageToState(previewProcessed);
            carryStudioThumbnailSource(replacedSource);
            updatePreview();
            scheduleFullUpdate();
          } else {
            // No downscaled preview (image already small) — treat as full
            applyProcessedImageToState(previewProcessed);
            carryStudioThumbnailSource(replacedSource);
            updatePreview();
            // No need to schedule full update; we already processed at full resolution
          }
          if (previewProcessed.__retained16) retainCorePreviewPlane(previewProcessed);
          return true;
        }
      } finally {
        if (full) _coreReprocessFullInFlight = false;
        else if (_coreReprocessPreviewInFlight === previewFlight) _coreReprocessPreviewInFlight = false;
        // A commit waits for the preview lane: a request already posted would
        // write into the plane before the commit reached the worker.
        if (!full) maybeCommitCorePreviewPlane();
        // Re-dispatch the latest queued request. If it is still blocked
        // (e.g. a queued full render while a preview is running) it simply
        // re-queues itself and the next finally picks it up — but a queued
        // preview must not wait for an in-flight full render.
        if (_coreReprocessPending) {
          const pending = _coreReprocessPending;
          // Claim the work before clearing the slot so coreReprocessBusy() never
          // reads as idle in the gap between the two.
          _coreReprocessActive += 1;
          _coreReprocessPending = null;
          void runCoreReprocess(pending).finally(() => {
            _coreReprocessActive -= 1;
            noteCoreReprocessSettled();
          });
        }
        // Direct callers (dust toggle, undo, reset and background promotion)
        // also participate in the export barrier, without runCoreReprocess.
        noteCoreReprocessSettled();
      }
    }

    // Posts the queued preview from inside the finishing flight, before its
    // result is applied. Only a non-full preview for the current generation and
    // source whose display preview is already the right size qualifies: any
    // other request needs main-thread work first, and a full one always waits
    // for finally.
    function postPendingPreviewEarly(flight) {
      const pending = _coreReprocessPending;
      if (!pending || pending.full || !flight || _coreReprocessPreviewInFlight !== flight) return false;
      if (pending.generation !== coreReprocessGeneration) return false;
      const source = state.conversionSourceImageData;
      if (!source || (pending.sourceRef && pending.sourceRef !== source)) return false;
      const target = getDisplayPreviewSize(source);
      if (state.conversionPreviewImageData?.width !== target.width
        || state.conversionPreviewImageData?.height !== target.height) return false;
      // Claim the work before clearing the slot so coreReprocessBusy() never
      // reads as idle, then hand the lane over: otherwise the in-flight guard
      // sees this flight and queues the request again.
      _coreReprocessActive += 1;
      _coreReprocessPending = null;
      _coreReprocessPreviewInFlight = false;
      void runCoreReprocess(pending).finally(() => {
        _coreReprocessActive -= 1;
        noteCoreReprocessSettled();
      });
      return true;
    }

    // The frame just applied keeps its 16-bit plane in the preview worker.
    function retainCorePreviewPlane(processed) {
      corePreviewRetained = { processed, derived: state.previewSourceImageData };
      armCorePreviewCommitTimer();
      maybeCommitCorePreviewPlane();
    }

    // Commits once no new frame has been asked for in a while. While one is
    // still coming the wait starts over, so a request that ends without a
    // frame cannot leave the plane (and the export barrier) waiting.
    function armCorePreviewCommitTimer() {
      if (corePreviewCommitTimer) clearTimeout(corePreviewCommitTimer);
      corePreviewCommitTimer = setTimeout(() => {
        corePreviewCommitTimer = null;
        if (!corePreviewRetained) return;
        if (_coreReprocessPreviewInFlight || _coreReprocessPending || coreReprocessTimer) {
          armCorePreviewCommitTimer();
          return;
        }
        requestCorePreviewCommit();
      }, CORE_PREVIEW_COMMIT_IDLE_MS);
    }

    // Any other frame on screen carries its own plane; the retained one is
    // superseded (the worker reuses or drops it). A commit already in flight
    // still delivers to the frame it was asked for, which a snapshot may hold.
    function releaseCorePreviewRetained(next = null) {
      if (!corePreviewRetained || corePreviewRetained.processed === next) return;
      corePreviewRetained = null;
      if (corePreviewCommitTimer) {
        clearTimeout(corePreviewCommitTimer);
        corePreviewCommitTimer = null;
      }
      // A retained frame replacing this one inherits the wish to commit, and
      // whoever waits for the plane waits for that frame's instead.
      if (next?.__retained16) return;
      corePreviewCommitWanted = false;
      settleCorePreviewWaiters();
      noteCoreReprocessSettled();
    }

    function requestCorePreviewCommit() {
      if (!corePreviewRetained) return;
      corePreviewCommitWanted = true;
      maybeCommitCorePreviewPlane();
    }

    function maybeCommitCorePreviewPlane() {
      const retained = corePreviewRetained;
      if (!retained || !corePreviewCommitWanted || corePreviewCommit) return;
      if (_coreReprocessPreviewInFlight) return;
      corePreviewCommitWanted = false;
      if (corePreviewCommitTimer) {
        clearTimeout(corePreviewCommitTimer);
        corePreviewCommitTimer = null;
      }
      const commit = convertPreviewFrameInWorker.commit(retained.processed)
        .catch((err) => {
          console.warn('Preview plane commit failed:', err?.message || err);
          return null;
        })
        .then((plane) => {
          const processed = retained.processed;
          if (plane) {
            processed.__image16 = { width: processed.width, height: processed.height, data: plane };
            delete processed.__retained16;
            // A display preview resampled from this frame was built from 8 bits.
            if (retained.derived !== processed && state.previewSourceImageData === retained.derived) {
              state.previewSourceImageData = buildPreviewSourceImageData(processed);
              state.histogramSourceImageData = histogramSourceFor(processed);
              state.webglSourceImageData = state.previewSourceImageData;
              if (webglState.gl) webglState.sourceDirty = true;
              schedulePreviewUpdate();
            }
          } else if (corePreviewRetained === retained) {
            // The plane is gone (a newer request reused it, or the worker
            // restarted): convert the frame on screen again, plane included.
            void runCoreReprocess({ full: false, retain16: false });
          }
        })
        .finally(() => {
          if (corePreviewCommit === commit) corePreviewCommit = null;
          if (corePreviewRetained === retained) corePreviewRetained = null;
          settleCorePreviewWaiters();
          noteCoreReprocessSettled();
        });
      corePreviewCommit = commit;
    }

    function settleCorePreviewWaiters() {
      if (corePreviewRetained || corePreviewCommit) return;
      const waiters = corePreviewSettleWaiters;
      corePreviewSettleWaiters = [];
      for (const resolve of waiters) resolve();
    }

    // Resolves once no frame on screen still has its plane in the worker.
    function settleCorePreviewPlane() {
      if (!corePreviewRetained && !corePreviewCommit) return Promise.resolve();
      const settled = new Promise(resolve => corePreviewSettleWaiters.push(resolve));
      requestCorePreviewCommit();
      return settled;
    }

    function hasSeparateConversionPreview() {
      return Boolean(
        state.conversionSourceImageData
        && state.conversionPreviewImageData
        && state.conversionPreviewImageData !== state.conversionSourceImageData
      );
    }

    function startFullResolutionRender(reason = 'background') {
      if (!usesSilverCoreConversion(state)) return null;
      if (!hasSeparateConversionPreview()) return null;
      if (state.fullResolutionPromise) return state.fullResolutionPromise;
      if (fullResolutionRenderTimer) {
        clearTimeout(fullResolutionRenderTimer);
        fullResolutionRenderTimer = null;
      }

      state.fullResolutionPending = true;
      const sourceRef = state.conversionSourceImageData;
      const token = coreReprocessToken;
      const generation = coreReprocessGeneration;
      const trace = createPerfTrace('fullResolutionRender', {
        reason,
        pixels: getImageDataPixelCount(state.conversionSourceImageData)
      });

      let rendered = false;
      const promise = waitForNextFrame()
        .then(() => rerenderWithCoreControls({ full: true, sourceRef, token, generation }))
        .then((didRender) => {
          rendered = didRender === true;
          trace.end({
            outputPixels: getImageDataPixelCount(state.processedImageData),
            previewOnly: Boolean(state.processedImageDataIsPreview)
          });
        })
        .finally(() => {
          // A reset may already own a new promise (and even the same source
          // object). The discarded render cannot change its readiness flags.
          if (state.fullResolutionPromise !== promise) return;
          state.fullResolutionPromise = null;
          // A render that was queued behind another one has not produced
          // anything yet, so the work is still outstanding.
          state.fullResolutionPending = rendered ? Boolean(state.processedImageDataIsPreview) : true;
          // Settings changed while this render was in flight, so its result
          // was discarded. Schedule another pass so the display converges on
          // the latest settings instead of staying at preview quality.
          if (token !== coreReprocessToken && state.conversionSourceImageData === sourceRef) {
            scheduleFullResolutionRender('stale-retry', FULL_RESOLUTION_INTERACTIVE_DELAY_MS);
          }
        });

      state.fullResolutionPromise = promise;
      return promise;
    }

    function scheduleFullResolutionRender(reason = 'idle', delayMs = FULL_RESOLUTION_IDLE_DELAY_MS) {
      if (!usesSilverCoreConversion(state)) return null;
      if (!hasSeparateConversionPreview()) return null;
      if (state.fullResolutionPromise) return state.fullResolutionPromise;

      state.fullResolutionPending = true;
      const sourceRef = state.conversionSourceImageData;
      if (fullResolutionRenderTimer) clearTimeout(fullResolutionRenderTimer);
      fullResolutionRenderTimer = null;
      // Provisional import settings are never rendered at full resolution;
      // the final settings arm this render (armSettledConversion).
      if (getCurrentQueueItem()?.provisional) return null;
      // A 60 MP RAW plus its working 16-bit planes can exhaust WKWebView
      // before the user even exports. The display already has its own preview;
      // original-resolution export/repair calls startFullResolutionRender directly.
      if (isLargeImage(sourceRef) && !hasFrameRepairs()) return null;
      fullResolutionRenderTimer = setTimeout(() => {
        fullResolutionRenderTimer = null;
        if (sourceRef && state.conversionSourceImageData !== sourceRef) return;
        const pendingFullRender = startFullResolutionRender(reason);
        void pendingFullRender?.catch((err) => {
          console.error('Background full-resolution conversion failed:', err);
        });
      }, Math.max(0, delayMs));
      return null;
    }

    function postponeFullResolutionRenderForInteraction() {
      if (!state.fullResolutionPending) return;
      if (state.fullResolutionPromise) return;
      scheduleFullResolutionRender('interactive-idle', FULL_RESOLUTION_IDLE_DELAY_MS);
    }

    function cancelScheduledFullResolutionRender() {
      if (!fullResolutionRenderTimer) return;
      clearTimeout(fullResolutionRenderTimer);
      fullResolutionRenderTimer = null;
      if (!state.fullResolutionPromise) {
        state.fullResolutionPending = Boolean(state.processedImageDataIsPreview);
      }
    }

    async function ensureFullResolutionReadyForExport() {
      // Export reads the planes of the current geometry.
      await whenGeometrySettled();
      // Crop/analysis confirmation also runs processNegative directly. Its
      // preview may be temporarily cleared even though no debounced render is
      // pending, so export must settle that conversion before choosing pixels.
      if (processNegativeInFlight) await processNegativeInFlight;
      // Settle the debounced/in-flight reprocess first. Exporting while one is
      // running used to either ship the previous conversion or fail outright,
      // because startFullResolutionRender hands back the queued render whose
      // promise resolves before the new pixels exist.
      await flushScheduledCoreReprocess();
      if (!state.processedImageDataIsPreview && !state.fullResolutionPending) return;
      if (fullResolutionRenderTimer) {
        clearTimeout(fullResolutionRenderTimer);
        fullResolutionRenderTimer = null;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending = state.fullResolutionPromise || startFullResolutionRender('export');
        if (!pending) break;
        await pending;
        await flushScheduledCoreReprocess();
        if (!state.processedImageDataIsPreview && !state.fullResolutionPending) return;
      }
      if (state.processedImageDataIsPreview) {
        throw new Error('Full-resolution processing is not ready yet. Please wait for the background render to finish.');
      }
      // Only clear the flag when there really is no separate preview source, so
      // that a still-pending render is not silently declared ready.
      if (!hasSeparateConversionPreview()) {
        state.fullResolutionPending = false;
      }
    }

    // The full-resolution `processedImageData` an export (or a repair) leaves
    // resident, about 725 MB at 60 MP, is the one active-editor plane that may
    // be given back (#250): demoted to the preview plane, as right after the
    // photo opened, the next export or repair converts it again. When to do
    // it is the memory budget's policy (#258); this refuses while anything
    // needs the full plane. History snapshots that still reference it keep
    // it alive.
    function canDemoteFullResolutionPlane() {
      return Boolean(state.processedImageData && !state.processedImageDataIsPreview
        && state.previewSourceImageData && state.previewSourceImageData !== state.processedImageData
        && state.currentStep >= 3 && usesSilverCoreConversion(state) && hasSeparateConversionPreview()
        && !state.fullResolutionPromise && !processNegativeInFlight && !singleExportActive
        && !coreReprocessBusy() && !coreReprocessTimer && !state.dustRemoval.processing
        && !hasFrameRepairs() && !state.cropping && !state.beforeAfterActive);
    }

    function fullResolutionPlaneBytes() {
      if (!state.processedImageData || state.processedImageDataIsPreview) return 0;
      return planeBuffersOf(state.processedImageData).reduce((sum, buffer) => sum + buffer.byteLength, 0);
    }

    function demoteFullResolutionPlane() {
      if (!canDemoteFullResolutionPlane()) return 0;
      const bytes = fullResolutionPlaneBytes();
      applyProcessedImageToState(state.previewSourceImageData, { previewOnly: true });
      state.fullResolutionPending = true;
      // The CPU display buffer was the full plane's rendering.
      fullAdjustedBuffer = null;
      updatePreview();
      return bytes;
    }

    registerEvictablePlane('processedImageData', {
      bytes: fullResolutionPlaneBytes,
      canEvict: canDemoteFullResolutionPlane,
      evict: demoteFullResolutionPlane
    });

    function scheduleCoreReprocess(options = {}) {
      const full = Boolean(options.full);
      if (!usesSilverCoreConversion(state)) return;
      if (!state.conversionSourceImageData || state.currentStep < 3) return;

      const token = ++coreReprocessToken;
      cancelScheduledFullResolutionRender();
      // A display-preview resize converts unchanged settings at another size
      // (carryStudioThumbnailSource), but only while no other request merges in.
      const displayResize = Boolean(options.displayResize)
        && (!coreReprocessScheduled || coreReprocessScheduled.displayResize === true);
      const displayResizeFrom = displayResize
        ? coreReprocessScheduled?.displayResizeFrom || displayResizeOrigin() : null;
      // The controls moved, so processedImageData no longer matches the UI even
      // while it is still full resolution. Mark it stale here rather than
      // waiting for the debounce to fire, so an export issued in between waits
      // for the new conversion instead of writing the previous one.
      if (hasSeparateConversionPreview()) state.fullResolutionPending = true;
      const wasFull = coreReprocessScheduled?.full;
      coreReprocessScheduled = { full, token, sourceRef: state.conversionSourceImageData, displayResize, displayResizeFrom };
      if (full) {
        // Settings that need a full-resolution pass still settle for 70 ms.
        clearCoreReprocessTimer();
        coreReprocessTimer = coreReprocessGates.armTimeout(fireCoreReprocessGate, CORE_FULL_REPROCESS_DELAY_MS);
        return;
      }
      // A preview replaces a queued full request, as it always has.
      if (wasFull) clearCoreReprocessTimer();
      // 最新入力を 1 フレームに 1 回だけ送る。空いていれば同じタスクの終わりに、
      // 同じフレームで送信済みなら次のフレームに、変換中なら finally が送る。
      const action = previewDispatchAction({
        laneBusy: Boolean(_coreReprocessPreviewInFlight),
        gateArmed: Boolean(coreReprocessTimer),
        postedThisFrame: coreReprocessGates.postedThisFrame()
      });
      if (action === 'queue') {
        // rerenderWithCoreControls parks it in the newest-wins slot.
        clearCoreReprocessTimer();
        void runCoreReprocess(takeScheduledCoreReprocess());
      } else if (action === 'task') {
        coreReprocessTimer = coreReprocessGates.armTask(fireCoreReprocessGate);
      } else if (action === 'frame') {
        coreReprocessTimer = coreReprocessGates.armFrame(fireCoreReprocessGate);
      }
    }

    function takeScheduledCoreReprocess() {
      const scheduled = coreReprocessScheduled;
      coreReprocessScheduled = null;
      return scheduled;
    }

    function fireCoreReprocessGate() {
      coreReprocessTimer = null;
      const scheduled = takeScheduledCoreReprocess();
      if (!scheduled) return;
      if (!scheduled.full) coreReprocessGates.markPosted();
      void runCoreReprocess(scheduled);
    }

    // Cancels whichever gate is armed: the full request's timeout, a frame
    // gate (rAF plus its fallback timeout) or an end-of-task microtask.
    function clearCoreReprocessTimer() {
      if (!coreReprocessTimer) return;
      coreReprocessGates.cancel(coreReprocessTimer);
      coreReprocessTimer = null;
    }

    // Run whatever the dispatch gate is still holding, then wait for the
    // reprocess chain to drain. Used before export so the file on disk matches
    // the screen.
    async function flushScheduledCoreReprocess() {
      for (let guard = 0; guard < 8; guard++) {
        if (coreReprocessTimer) {
          clearCoreReprocessTimer();
          const scheduled = takeScheduledCoreReprocess();
          if (scheduled) await runCoreReprocess(scheduled);
          continue;
        }
        // A frame whose plane is still in the preview worker settles only
        // once it is committed.
        requestCorePreviewCommit();
        const idle = whenCoreReprocessIdle();
        if (idle) {
          await idle;
          continue;
        }
        return;
      }
    }

    // `automatic: false` keeps the automatic measurements (white balance,
    // expired analysis) the settings already hold, for rebuilding pixels of a
    // restored snapshot. `provisional` renders settings that the import
    // detections may still replace (prepareStudioPhoto): it arms neither the
    // idle full-resolution render nor the dust pass, which
    // armSettledConversion starts later.
    async function processNegative({ quiet = false, automatic = true, provisional = false } = {}) {
      if (processNegativeInFlight) return processNegativeInFlight;

      const processingGeneration = coreReprocessGeneration;
      const promise = (async () => {
        const generation = loadGeneration;
        // Convert the planes of the current geometry, never the previous one;
        // a build superseded while this waited is converted by its successor.
        if (!(await whenGeometrySettled()) || !isCurrentLoad(generation)) return;
        const sourceData = state.croppedImageData || state.originalImageData;
        if (!sourceData) return;
        const isCurrentConversion = () => isCurrentLoad(generation)
          && processingGeneration === coreReprocessGeneration
          && sourceData === (state.croppedImageData || state.originalImageData);
        const trace = createPerfTrace('processNegative', {
          pixels: getImageDataPixelCount(sourceData)
        });

        const overlay = quiet ? quietLoadingOverlay : getLoadingOverlay();
        const lang = i18n[currentLang];
        await overlay.show({ title: lang.loadingConverting });

        try {
          if (!isCurrentConversion()) return;
          overlay.updateProgress(10, lang.loadingConverting);
          const correctedSourceData = await applyLensCorrectionWithSettings(sourceData, state, { updateUi: true });
          if (!isCurrentConversion()) return;
          trace.mark('lensCorrection', {
            outputPixels: getImageDataPixelCount(correctedSourceData)
          });
          invalidateSilverCoreCache();
          state.conversionSourceImageData = correctedSourceData;
          // A new photo usually arrives with a layout change (panels, the
          // loaded state) the observer has not reported yet; size its display
          // preview from live layout once rather than convert it twice.
          refreshCanvasContainerSize();
          state.conversionPreviewImageData = buildPreviewSourceImageData(correctedSourceData);
          const hasPreviewSource = usesSilverCoreConversion(state) && hasSeparateConversionPreview();
          overlay.updateProgress(hasPreviewSource ? 35 : 40, lang.loadingConverting);

          const processed = await convertFromCurrentSource(state, { preview: hasPreviewSource });
          if (!processed || !isCurrentConversion()) return;
          trace.mark(hasPreviewSource ? 'previewConversion' : 'fullConversion', {
            outputPixels: getImageDataPixelCount(processed)
          });
          overlay.updateProgress(hasPreviewSource ? 78 : 85, lang.loadingProcessing);
          applyProcessedImageToState(processed, { previewOnly: hasPreviewSource });
          if (automatic) {
            maybeAutoWhiteBalance(processed);
            maybeAnalyzeExpiredRescue(processed);
          }
          // Reset dust removal state for new conversion
          dustPassCache = null;
          state.dustRemoval._state = null;
          state.dustRemoval.mask = null;
          state.dustRemoval.maskTag = null;
          noteDustReplaced();
          state.dustRemoval.inpaintedImageData = null;
          state.dustRemoval.particleCount = 0;
          state.dustRemoval.cleanSource = null;
          goToStep(3);
          syncBatchUIState({ reason: 'processNegative' });
          revealBatchFileList('processNegative');
          updatePreview();
          updateStudioThumbnail();
          if (hasPreviewSource) {
            state.fullResolutionPending = true;
            if (!provisional) scheduleFullResolutionRender('initial-preview');
          } else {
            scheduleFullUpdate();
          }
          overlay.updateProgress(100, lang.loadingComplete);
          trace.end({
            previewFirst: hasPreviewSource,
            outputPixels: getImageDataPixelCount(processed)
          });
          // The overlay hides in this task; its CSS delay keeps a fast
          // conversion from flashing it at all.
          // Auto-run dust detection if enabled
          if (!provisional && isCurrentConversion() && hasFrameRepairs() && !hasPreviewSource) {
            scheduleDustDetection();
          }
        } catch (err) {
          if (!isCurrentConversion()) return;
          // Every caller fires this with `void`, so without a catch here a
          // failed conversion became an unhandled rejection: the overlay
          // vanished and the user was left on the previous image with no
          // indication that anything went wrong.
          console.error('Conversion failed:', err);
          const detail = String(err?.message || err || '');
          void appAlert(
            `${getLocalizedText('conversionFailed', 'Conversion failed.')}${detail ? `\n${detail}` : ''}`
          );
        } finally {
          if (isCurrentLoad(generation) && processingGeneration === coreReprocessGeneration) overlay.hide();
        }
      })();
      processNegativeInFlight = promise;

      try {
        return await promise;
      } finally {
        if (processNegativeInFlight === promise) processNegativeInFlight = null;
      }
    }

    // ===========================================
    // Dust Removal Pipeline
    // ===========================================
    let dustDetectionTimer = null;
    let dustDetectionRevision = 0;
    let dustDrawing = false;
    let dustBrushMode = 'intelligent';
    // The last dust pass as the blocks it changed (repairReuse.js), and the
    // recipes of committed repairs that export can reuse (#246).
    let dustPassCache = null;
    const repairStamps = createRepairStamps();

    function getDustSource() {
      return state.dustRemoval.cleanSource || state.processedImageData;
    }

    // The repair the current state asks for, in the terms of a stamped recipe.
    function currentRepairRecipe() {
      const dustEnabled = Boolean(state.dustRemoval.enabled);
      return { source: getDustSource(), token: coreReprocessToken, dustEnabled,
        dustMask: dustEnabled ? state.dustRemoval.mask : null,
        dustRevision: dustEnabled ? state.dustRemoval.revision : null, strokes: state.repairStrokes,
        lensMapping: state.conversionSourceImageData?.__lensMapping || null,
        revision: aiRepair.revision, dustUsedAi: aiRepairReady() };
    }

    // Stamps a committed repair unless the model changed while it ran (a
    // WebGPU -> WASM reload mid-pass bumps the revision).
    function stampRepairResult(result, recipe) {
      if (result && aiRepair.revision === recipe.revision) repairStamps.stamp(result, recipe);
    }

    // A settled photo session brings back the repair objects themselves. The
    // stamped recipe still holds under the restore's token when the restored
    // strokes select the same pixels, so export can reuse the result.
    function carryRestoredRepairStamp() {
      const restored = state.dustRemoval.inpaintedImageData;
      const recipe = repairStamps.recipeOf(restored);
      if (recipe && sameRepairStrokes(recipe.strokes, state.repairStrokes)) {
        // A stroke patches the repaired image in place and forgets its stamp
        // (#259), so a result that still has one holds the stamped pixels.
        repairStamps.stamp(restored, { ...recipe, token: coreReprocessToken, strokes: state.repairStrokes,
          dustRevision: recipe.dustEnabled ? state.dustRemoval.revision : null });
      }
    }

    // The dust half of a commit, MI-GAN or TELEA over the whole dust mask. When
    // the same clean source, dust-mask content, inpainter and model revision
    // come back (a fresh detection after an AI-brush stroke), the blocks the
    // last pass changed are written onto a copy of the source instead. A mask
    // from the page's OpenCV fallback carries no hash and always runs.
    // `info` is the summary of the mask's content; the export passes that of
    // the live mask while the pass reads a copy of it.
    async function commitDustPass(source, mask, isCurrent = () => true, info = dustMaskInfo(mask)) {
      const deciding = state.dustRemoval.ai && (aiRepair.status === 'idle' || aiRepair.status === 'loading');
      const key = { source, maskHash: info?.hash, usedAi: aiRepairReady(), revision: aiRepair.revision };
      if (info && !deciding && dustPassMatches(dustPassCache, key)) {
        const imageData = await restoreDustPass(dustPassCache, source, { check: () => assertRepairCurrent(isCurrent) });
        if (imageData) return { imageData, usedAi: key.usedAi };
      }
      const report = {};
      const imageData = await inpaintForCommit(source, mask, isCurrent, null, { report });
      if (info && isCurrent() && report.revision === aiRepair.revision) {
        dustPassCache = captureDustPass(imageData, { source, maskHash: info.hash, usedAi: report.usedAi,
          revision: report.revision, blocks: report.usedAi ? report.blocks : info.blocks });
      }
      return { imageData, usedAi: report.usedAi };
    }

    function nextDustMaskTag() {
      dustMaskTagSequence += 1;
      return dustMaskTagSequence;
    }

    // The mask or the repaired image was replaced outside the brush: pending
    // strokes, learned-repair refreshes and the tint layer are now stale.
    function noteDustReplaced() {
      state.dustRemoval.revision += 1;
      dustAiRefresh.rects.length = 0;
    }

    // Brush patches go into the repaired image in place. When there is none
    // yet (no dust found, no repair strokes), the clean source stands in for
    // it and must not be patched, so it is cloned once per photo, off the
    // stroke path: when the pin starts, 32 MB per task. The pixels are the
    // same, so the display sources stay valid.
    let dustPrivateClone = null;
    function needsDustPrivateBuffer() {
      const dust = state.dustRemoval;
      return Boolean(dust.cleanSource && (!dust.inpaintedImageData || dust.inpaintedImageData === dust.cleanSource));
    }
    function installDustPrivateBuffer(copy) {
      const dust = state.dustRemoval;
      if (state.processedImageData === dust.cleanSource) state.processedImageData = copy;
      dust.inpaintedImageData = copy;
      return copy;
    }
    function ensureDustPrivateBuffer() {
      if (!needsDustPrivateBuffer()) return state.dustRemoval.inpaintedImageData;
      const clean = state.dustRemoval.cleanSource;
      const copy = new ImageData(new Uint8ClampedArray(clean.data), clean.width, clean.height);
      if (clean.__image16) copy.__image16 = { width: clean.width, height: clean.height, data: new Uint16Array(clean.__image16.data) };
      return installDustPrivateBuffer(copy);
    }
    function prepareDustPrivateBuffer() {
      if (!needsDustPrivateBuffer()) return Promise.resolve();
      const clean = state.dustRemoval.cleanSource;
      if (dustPrivateClone?.source === clean) return dustPrivateClone.promise;
      const promise = (async () => {
        const data = new Uint8ClampedArray(clean.data.length);
        const plane = clean.__image16 ? new Uint16Array(clean.__image16.data.length) : null;
        for (const [target, from] of [[data, clean.data], [plane, clean.__image16?.data]]) {
          if (!target) continue;
          const step = (32 * 1024 * 1024) / target.BYTES_PER_ELEMENT;
          for (let offset = 0; offset < target.length; offset += step) {
            target.set(from.subarray(offset, offset + step), offset);
            await new Promise(resolve => setTimeout(resolve, 0));
            if (state.dustRemoval.cleanSource !== clean || !needsDustPrivateBuffer()) return;
          }
        }
        const copy = new ImageData(data, clean.width, clean.height);
        if (plane) copy.__image16 = { width: clean.width, height: clean.height, data: plane };
        installDustPrivateBuffer(copy);
      })();
      dustPrivateClone = { source: clean, promise };
      promise.finally(() => { if (dustPrivateClone?.promise === promise) dustPrivateClone = null; }).catch(() => {});
      return promise;
    }

    // While the dust brush can paint (dust on, Show mask on, a settled full-
    // resolution frame), the dust worker stays pinned with the clean source,
    // its 16-bit plane and the mask, so a stroke only sends its points.
    function syncDustWorkerPin() {
      const dust = state.dustRemoval;
      if (!dust.enabled || !dust.showMask || state.currentStep < 3) {
        unpinDustWorker();
        return;
      }
      const source = dust.cleanSource;
      if (!source || !dust.mask || dust.processing || state.processedImageDataIsPreview) return;
      if (source.width * source.height !== dust.mask.length) return;
      void prepareDustPrivateBuffer();
      if (dust.maskTag == null) dust.maskTag = nextDustMaskTag();
      pinDustWorker(source, { mask: dust.mask, tag: dust.maskTag }).catch(() => {});
    }

    // The UI value means px at full resolution; when detection runs on a
    // smaller preview, scale it so both passes target the same physical specks.
    function dustMaxParticleSizeFor(imageData) {
      const ui = Number.isFinite(state.dustRemoval.maxParticleSize)
        ? state.dustRemoval.maxParticleSize
        : 40;
      const full = state.croppedImageData || state.originalImageData;
      const fullShort = full ? Math.min(full.width, full.height) : 0;
      const short = imageData ? Math.min(imageData.width, imageData.height) : 0;
      if (!fullShort || !short || short >= fullShort) return ui;
      return Math.max(3, Math.round(ui * (short / fullShort)));
    }

    function updateDustStatusUI(text) {
      const el = document.getElementById('dustStatus');
      if (el) el.textContent = text;
    }

    function updateDustControlsVisibility() {
      const controls = document.getElementById('dustRemovalControls');
      if (controls) controls.style.display = state.dustRemoval.enabled ? 'block' : 'none';
      const brushControls = document.getElementById('dustBrushControls');
      if (brushControls) brushControls.style.display = state.dustRemoval.showMask ? 'block' : 'none';
    }

    function hasFrameRepairs() {
      return Boolean(state.dustRemoval.enabled || state.repairStrokes?.length);
    }

    function assertRepairCurrent(isCurrent) {
      if (!isCurrent()) throw new DOMException('Repair superseded', 'AbortError');
    }

    async function detectDustOffMainThread(source, options, previous = null, isCurrent = () => true, worker = null) {
      assertRepairCurrent(isCurrent);
      try { return await (worker?.detect || detectDustInWorker)(source, options); }
      catch (error) {
        assertRepairCurrent(isCurrent);
        if (error?.name === 'AbortError') throw error;
        console.warn('Dust worker unavailable; using OpenCV fallback:', error);
        if (!(await ensureOpenCvReady())) throw new Error('OpenCV is not available');
        assertRepairCurrent(isCurrent);
        return previous ? updateDustStrength(source, previous, options.strength, options.maxParticleSize)
          : detectDust(source, options);
      }
    }

    async function inpaintDustOffMainThread(source, mask, isCurrent = () => true, worker = null) {
      assertRepairCurrent(isCurrent);
      try { return await (worker?.inpaint || inpaintDustInWorker)(source, mask, 3); }
      catch (error) {
        assertRepairCurrent(isCurrent);
        // The worker ran TELEA and OpenCV failed: that is the result, not a
        // reason to repeat it here. Only a lost worker falls back.
        if (error?.name === 'AbortError' || error?.dustWorkerReported) throw error;
        console.warn('Dust worker unavailable; using TELEA fallback:', error);
        if (!(await ensureOpenCvReady())) throw new Error('OpenCV is not available');
        assertRepairCurrent(isCurrent);
        return inpaintMasked(source, mask, 3);
      }
    }

    async function runDustDetection() {
      if (!hasFrameRepairs() || !state.processedImageData) return;
      if (state.dustRemoval.processing) {
        scheduleDustDetection();
        return;
      }

      const sourceRef = state.conversionSourceImageData;
      const token = coreReprocessToken;
      const revision = dustDetectionRevision;
      const activation = loadGeneration;
      const strokes = state.repairStrokes;
      const isCurrent = () => hasFrameRepairs() && state.repairStrokes === strokes
        && state.conversionSourceImageData === sourceRef
        && coreReprocessToken === token
        && dustDetectionRevision === revision;

      state.dustRemoval.processing = true;
      updateDustStatusUI(getLocalizedText('dustStatusProcessing', 'Processing...'));

      try {
        // プレビューに作ったマスクを原寸画像へ適用しない。
        await ensureFullResolutionReadyForExport();
        // 原寸レンダリングが新しい検出を予約した場合はそちらへ引き継ぐ。
        if (!isCurrent()) return;
        const source = getDustSource();
        if (!source || state.processedImageDataIsPreview) return;
        if (!isCurrent() || source !== getDustSource()) return;

        // Save original source before inpainting overwrites processedImageData
        if (!state.dustRemoval.cleanSource) {
          state.dustRemoval.cleanSource = source;
        }

        const prevState = state.dustRemoval._state;
        const maxParticleSize = dustMaxParticleSizeFor(source);
        const dustEnabled = Boolean(state.dustRemoval.enabled);
        // The worker keeps the mask it returns under this tag for the brush.
        const maskTag = nextDustMaskTag();
        const { mask, particleCount, _state } = !dustEnabled
          ? { mask: new Uint8Array(source.width * source.height), particleCount: 0, _state: null }
          : await detectDustOffMainThread(source, { strength: state.dustRemoval.strength, maxParticleSize, maskTag }, prevState, isCurrent);
        if (!isCurrent() || source !== getDustSource()) return;
        state.dustRemoval.mask = mask;
        state.dustRemoval.maskTag = maskTag;
        state.dustRemoval.particleCount = particleCount;
        state.dustRemoval._state = _state;
        noteDustReplaced();
        const maskRevision = state.dustRemoval.revision;

        let committed = null;
        if (particleCount > 0 || strokes.length) {
          const lensMapping = sourceRef?.__lensMapping || null;
          const modelRevision = aiRepair.revision;
          const dust = particleCount > 0 ? await commitDustPass(source, mask, isCurrent) : null;
          const inpainted = await inpaintManualBrush(dust ? dust.imageData : source, state,
            state.loadedBaseImageData || state.originalImageData, lensMapping, isCurrent);
          if (!isCurrent() || source !== getDustSource()) return;
          state.dustRemoval.inpaintedImageData = inpainted;
          committed = { source, token, dustEnabled, dustMask: dustEnabled ? mask : null, strokes,
            lensMapping, revision: modelRevision, dustUsedAi: dust ? dust.usedAi : null };
          const tmpl = getLocalizedText('dustStatusDone', 'Detected {count} dust particles');
          updateDustStatusUI(tmpl.replace('{count}', String(particleCount)));
        } else {
          state.dustRemoval.inpaintedImageData = null;
          updateDustStatusUI(getLocalizedText('dustStatusNone', 'No dust detected'));
        }
        noteDustReplaced();
        // Stamped under the revision this commit ends at, unless a brush
        // stroke moved the mask while the passes ran (#259).
        if (committed && state.dustRemoval.revision === maskRevision + 1) {
          stampRepairResult(state.dustRemoval.inpaintedImageData, { ...committed,
            dustRevision: committed.dustEnabled ? state.dustRemoval.revision : null });
        }
        cancelFullUpdate();
        applyDustResultToState();
        updatePreview();
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Dust detection failed:', err);
        state.dustRemoval.mask = null;
        state.dustRemoval.maskTag = null;
        state.dustRemoval.inpaintedImageData = null;
        noteDustReplaced();
        updateDustStatusUI('Error: ' + (err.message || err));
      } finally {
        if (isCurrentLoad(activation)) {
          state.dustRemoval.processing = false;
          if (isCurrent()) syncDustWorkerPin();
        }
      }
    }

    function applyDustResultToState() {
      if (!hasFrameRepairs()) return;
      const nextImage = state.dustRemoval.inpaintedImageData || state.dustRemoval.cleanSource;
      if (!nextImage) return;
      applyProcessedImageToState(nextImage, { previewOnly: state.processedImageDataIsPreview });
    }

    function scheduleDustDetection() {
      dustDetectionRevision += 1;
      if (dustDetectionTimer) clearTimeout(dustDetectionTimer);
      dustDetectionTimer = setTimeout(() => {
        dustDetectionTimer = null;
        void runDustDetection();
      }, 300);
    }

    function clearDustState() {
      dustDetectionRevision += 1;
      dustPassCache = null;
      unpinDustWorker();
      disposeDustWorker();
      if (dustDetectionTimer) clearTimeout(dustDetectionTimer);
      dustDetectionTimer = null;
      state.dustRemoval.mask = null;
      state.dustRemoval.maskTag = null;
      noteDustReplaced();
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.particleCount = 0;
      state.dustRemoval._state = null;
      state.dustRemoval.cleanSource = null;
      updateDustStatusUI(getLocalizedText('dustStatusIdle', 'Ready'));
    }

    // The mask tint is cached as its own canvas: it only changes when the mask
    // or the canvas size changes, so a brush drag composites a ready-made layer
    // instead of running a full-canvas getImageData, per-pixel JS loop and
    // putImageData on every pointer move.
    // The brush patches the mask in place, so the layer is keyed by the dust
    // revision as well as the mask object (#259).
    const dustMaskOverlayCache = { canvas: null, mask: null, revision: -1, width: 0, height: 0 };

    function getDustMaskOverlayCanvas() {
      const mask = state.dustRemoval.mask;
      if (!mask || !state.processedImageData) return null;
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) return null;

      if (
        dustMaskOverlayCache.canvas
        && dustMaskOverlayCache.mask === mask
        && dustMaskOverlayCache.revision === state.dustRemoval.revision
        && dustMaskOverlayCache.width === w
        && dustMaskOverlayCache.height === h
      ) {
        return dustMaskOverlayCache.canvas;
      }

      const { width, height } = state.processedImageData;
      const layer = dustMaskOverlayCache.canvas && dustMaskOverlayCache.width === w && dustMaskOverlayCache.height === h
        ? dustMaskOverlayCache.canvas
        : document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const layerCtx = layer.getContext('2d', { willReadFrequently: false });
      if (!layerCtx) return null;
      layerCtx.clearRect(0, 0, w, h);

      const tint = layerCtx.createImageData(w, h);
      const data = tint.data;
      const scaleX = width / w;
      const scaleY = height / h;
      for (let cy = 0; cy < h; cy++) {
        const my = Math.min(height - 1, Math.round(cy * scaleY));
        const rowOffset = my * width;
        for (let cx = 0; cx < w; cx++) {
          const mx = Math.min(width - 1, Math.round(cx * scaleX));
          if (mask[rowOffset + mx] > 0) {
            const idx = (cy * w + cx) * 4;
            data[idx] = 255;
            data[idx + 3] = 128; // 50% red, composited over the image below
          }
        }
      }
      layerCtx.putImageData(tint, 0, 0);

      dustMaskOverlayCache.canvas = layer;
      dustMaskOverlayCache.mask = mask;
      dustMaskOverlayCache.revision = state.dustRemoval.revision;
      dustMaskOverlayCache.width = w;
      dustMaskOverlayCache.height = h;
      return layer;
    }

    // After a brush patch at `revision`, redraws only the tint cells whose
    // nearest mask sample lies in `rect` (image pixels), with the same rule
    // as the full layer. A layer that was not current is rebuilt on demand.
    function updateDustTintRect(rect, revision) {
      const cache = dustMaskOverlayCache;
      const mask = state.dustRemoval.mask;
      const image = state.processedImageData;
      if (!cache.canvas || !mask || !image || cache.mask !== mask
        || cache.revision !== revision - 1 || cache.width !== canvas.width || cache.height !== canvas.height) return;
      const { width, height } = image;
      const w = cache.width, h = cache.height;
      const scaleX = width / w, scaleY = height / h;
      const span = (start, end, scale, count, limit) => {
        let first = -1, last = -1;
        for (let i = Math.max(0, Math.floor((start - 1) / scale)); i < count; i++) {
          const m = Math.min(limit - 1, Math.round(i * scale));
          if (m >= end) break;
          if (m < start) continue;
          if (first < 0) first = i;
          last = i;
        }
        return first < 0 ? null : [first, last + 1];
      };
      const columns = span(rect.x, rect.x + rect.width, scaleX, w, width);
      const rows = span(rect.y, rect.y + rect.height, scaleY, h, height);
      if (columns && rows) {
        const layerCtx = cache.canvas.getContext('2d', { willReadFrequently: false });
        if (!layerCtx) return;
        const tw = columns[1] - columns[0], th = rows[1] - rows[0];
        const tint = layerCtx.createImageData(tw, th);
        for (let cy = rows[0]; cy < rows[1]; cy++) {
          const rowOffset = Math.min(height - 1, Math.round(cy * scaleY)) * width;
          for (let cx = columns[0]; cx < columns[1]; cx++) {
            if (mask[rowOffset + Math.min(width - 1, Math.round(cx * scaleX))] > 0) {
              const idx = ((cy - rows[0]) * tw + (cx - columns[0])) * 4;
              tint.data[idx] = 255;
              tint.data[idx + 3] = 128;
            }
          }
        }
        layerCtx.putImageData(tint, columns[0], rows[0]);
      }
      cache.revision = revision;
    }

    function renderDustMaskOverlay() {
      if (state.cropping) return;
      if (!state.dustRemoval.showMask || !state.dustRemoval.mask || !state.processedImageData) return;
      const layer = getDustMaskOverlayCanvas();
      if (!layer) return;
      ctx.drawImage(layer, 0, 0);
    }

    // Repaint the image under the overlay first. Without this the tint is
    // composited on top of the previous tint, so a brush drag turned the whole
    // mask solid red and toggling the mask twice doubled its opacity.
    function repaintDustMaskOverlay() {
      const display = state.displayImageData || state.processedImageData;
      if (!display) return;
      renderAdjustedImageDataToMainCanvas(display, display);
      renderDustMaskOverlay();
    }

    // ── Dust Removal UI Event Handlers ───────────────────────────────────────

    document.getElementById('dustRemovalEnabled')?.addEventListener('change', function () {
      pushUndo('dustToggle');
      state.dustRemoval.enabled = this.checked;
      updateDustControlsVisibility();
      // The detection below waits for the model; start loading it now.
      if (state.dustRemoval.enabled && state.dustRemoval.ai) ensureAiRepairPreload();

      if (state.dustRemoval.enabled && state.processedImageData) {
        // Re-run detection on the original converted image (before inpainting)
        // Need to reconvert to get clean processedImageData
        scheduleDustDetection();
      } else if (!state.dustRemoval.enabled) {
        // Disabled: restore original processedImageData by reconverting
        state.dustRemoval.showMask = false;
        const showMaskCheckbox = document.getElementById('dustShowMask');
        if (showMaskCheckbox) showMaskCheckbox.checked = false;
        clearDustState();
        updateCanvasVisibility();
        void rerenderWithCoreControls({ full: true });
      }
      syncDustWorkerPin();
    });

    let dustStrengthPreSnapshot = null;
    document.getElementById('dustStrength')?.addEventListener('pointerdown', function () {
      dustStrengthPreSnapshot = captureSnapshot('dustStrength');
    });
    document.getElementById('dustStrength')?.addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      state.dustRemoval.strength = val;
      const numInput = document.getElementById('dustStrengthValue');
      if (numInput) numInput.value = String(val);

      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });
    document.getElementById('dustStrength')?.addEventListener('change', function () {
      if (dustStrengthPreSnapshot) {
        commitUndoSnapshot(dustStrengthPreSnapshot);
        dustStrengthPreSnapshot = null;
        updateUndoRedoButtons();
      }
    });

    let dustMaxSizePreSnapshot = null;
    document.getElementById('dustMaxSize')?.addEventListener('pointerdown', function () {
      dustMaxSizePreSnapshot = captureSnapshot('dustMaxSize');
    });
    document.getElementById('dustMaxSize')?.addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      state.dustRemoval.maxParticleSize = val;
      const numInput = document.getElementById('dustMaxSizeValue');
      if (numInput) numInput.value = String(val);

      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });
    document.getElementById('dustMaxSize')?.addEventListener('change', function () {
      if (dustMaxSizePreSnapshot) {
        commitUndoSnapshot(dustMaxSizePreSnapshot);
        dustMaxSizePreSnapshot = null;
        updateUndoRedoButtons();
      }
    });

    document.getElementById('dustMaxSizeValue')?.addEventListener('change', function () {
      pushUndo('dustMaxSize');
      const val = Math.max(6, Math.min(80, parseInt(this.value, 10) || 40));
      this.value = String(val);
      state.dustRemoval.maxParticleSize = val;
      const slider = document.getElementById('dustMaxSize');
      if (slider) slider.value = String(val);
      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });

    document.getElementById('dustStrengthValue')?.addEventListener('change', function () {
      pushUndo('dustStrength');
      const val = Math.max(1, Math.min(10, parseInt(this.value, 10) || 3));
      this.value = String(val);
      state.dustRemoval.strength = val;
      const slider = document.getElementById('dustStrength');
      if (slider) slider.value = String(val);

      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });

    document.getElementById('dustShowMask')?.addEventListener('change', function () {
      state.dustRemoval.showMask = this.checked;
      if (this.checked) document.getElementById('aiBrushEnabled').checked = false;
      updateDustControlsVisibility();
      updateCanvasVisibility();
      if (state.dustRemoval.showMask) {
        updatePreview();           // render image on 2D canvas first
        requestAnimationFrame(() => renderDustMaskOverlay());
      } else {
        updatePreview();           // restore normal render path (may switch back to WebGL)
      }
      // The brush paints only while the mask is shown: keep the worker ready.
      syncDustWorkerPin();
    });

    document.getElementById('dustBrushSize')?.addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      state.dustRemoval.brushSize = val;
      const numInput = document.getElementById('dustBrushSizeValue');
      if (numInput) numInput.value = String(val);
    });

    document.getElementById('dustBrushSizeValue')?.addEventListener('change', function () {
      const val = Math.max(1, Math.min(50, parseInt(this.value, 10) || 5));
      this.value = String(val);
      state.dustRemoval.brushSize = val;
      const slider = document.getElementById('dustBrushSize');
      if (slider) slider.value = String(val);
    });

    document.getElementById('dustClearMaskBtn')?.addEventListener('click', () => {
      if (!state.dustRemoval.enabled) return;
      const source = getDustSource();
      if (source) {
        applyProcessedImageToState(source, { previewOnly: state.processedImageDataIsPreview });
      }
      clearDustState();
      state.dustRemoval.cleanSource = source;
      updatePreview();
      // Re-run fresh detection
      scheduleDustDetection();
    });

    // ── Brush drawing on canvas ──────────────────────────────────────────────

    function canvasToImageCoords(canvasX, canvasY) {
      const source = state.processedImageData;
      if (!source) return null;
      const scaleX = source.width / canvas.width;
      const scaleY = source.height / canvas.height;
      return {
        x: Math.round(canvasX * scaleX),
        y: Math.round(canvasY * scaleY)
      };
    }

    let dustBrushPoints = [];
    let dustBrushSource = null;
    let dustBrushToken = null;

    function onDustBrushStart(e) {
      if (canPaintAiBrush()) return;
      if (!state.dustRemoval.enabled || !state.dustRemoval.showMask) return;
      if (!state.dustRemoval.mask || !state.processedImageData) return;
      if (state.dustRemoval.processing || state.processedImageDataIsPreview) return;
      if (state.samplingMode || state.cropping) return;

      e.preventDefault();
      e.stopPropagation();
      dustDrawing = true;
      dustBrushPoints = [];
      dustBrushSource = getDustSource();
      dustBrushToken = coreReprocessToken;

      // Determine mode
      if (e.altKey) {
        dustBrushMode = 'direct';
      } else if (e.shiftKey) {
        dustBrushMode = 'remove';
      } else {
        dustBrushMode = 'intelligent';
      }

      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const imgCoord = canvasToImageCoords(cx, cy);
      if (imgCoord) dustBrushPoints.push(imgCoord);
    }

    function onDustBrushMove(e) {
      if (!dustDrawing) return;
      const activeCanvas = isWebGLActive() ? glCanvas : canvas;
      const rect = activeCanvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const imgCoord = canvasToImageCoords(cx, cy);
      if (imgCoord) dustBrushPoints.push(imgCoord);

      // Visual feedback: draw brush stroke on canvas
      if (state.dustRemoval.showMask) {
        repaintDustMaskOverlay();
        // Draw brush points
        const scaleX = canvas.width / (state.processedImageData?.width || 1);
        const scaleY = canvas.height / (state.processedImageData?.height || 1);
        const r = state.dustRemoval.brushSize * scaleX;
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = dustBrushMode === 'direct' ? '#ff0000'
          : dustBrushMode === 'remove' ? '#0066ff' : '#ffff00';
        for (const pt of dustBrushPoints) {
          ctx.beginPath();
          ctx.arc(pt.x * scaleX, pt.y * scaleY, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    let dustBrushTurn = Promise.resolve();

    // A stroke goes to the dust worker as its points; the worker refines its
    // copy of the mask around them and returns a patch sized to the rect it
    // touched (#259). A lost worker is re-seeded by the client; without one,
    // the same regional code runs here.
    async function strokeDustOffMainThread(source, stroke, isCurrent) {
      let failure;
      try { return await strokeDustInWorker(source, stroke); } catch (error) { failure = error; }
      assertRepairCurrent(isCurrent);
      if (failure?.name === 'AbortError') throw failure;
      if (failure?.staleMask) {
        // The worker holds another mask (a race with undo, or a new worker).
        try { return await strokeDustInWorker(source, { ...stroke, forceMask: true }); } catch (error) { failure = error; }
        assertRepairCurrent(isCurrent);
        if (failure?.name === 'AbortError') throw failure;
      }
      if (failure?.dustWorkerReported && !failure.staleMask) throw failure;
      console.warn('Dust worker unavailable; brushing on the page:', failure);
      if (!(await ensureOpenCvReady())) throw new Error('OpenCV is not available');
      assertRepairCurrent(isCurrent);
      return applyDustStroke({ source, mask: state.dustRemoval.mask.slice(), particleCount: null }, stroke);
    }

    // Uploads one rect of the WebGL source texture. Rows are stored top-down
    // and the shader flips them (#233), so the rect lands at its own y; the
    // context's unpack state (alignment 1, no flip) is never changed.
    function webglUploadSourceRect(imageData, rect) {
      if (!webglState.gl || webglState.sourceDirty) return;
      if (webglState.sourceSize.w !== imageData.width || webglState.sourceSize.h !== imageData.height) {
        webglState.sourceDirty = true;
        return;
      }
      const gl = webglState.gl;
      const rows = new Uint8Array(rect.width * rect.height * 4);
      for (let y = 0; y < rect.height; y++) {
        const start = ((rect.y + y) * imageData.width + rect.x) * 4;
        rows.set(imageData.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, rows);
    }

    let dustHistogramTimer = null;
    function scheduleDustHistogramRefresh() {
      if (dustHistogramTimer) clearTimeout(dustHistogramTimer);
      dustHistogramTimer = setTimeout(() => {
        dustHistogramTimer = null;
        const image = state.processedImageData;
        if (!image) return;
        state.histogramSourceImageData = buildHistogramSourceImageData(state.previewSourceImageData || image);
        if (isWebGLActive()) renderHistogramForWebGL(true);
      }, 250);
    }

    // After in-place patches of the repaired image inside `rects`, updates
    // what the display derives from it (preview source, WebGL texture, tint,
    // histogram on idle) for those rects only, then repaints. A repaired
    // image that is not the one on screen is shown the ordinary way.
    function refreshDustDisplay(target, rects, maskRect, revision) {
      if (state.processedImageData !== target || state.processedImageDataIsPreview) {
        applyProcessedImageToState(target);
        updatePreview();
        return;
      }
      // A pending full render means the preview shows newer settings than
      // the repaired image; it is rebuilt from the new frame when that lands.
      const preview = state.fullResolutionPending ? null : state.previewSourceImageData;
      if (preview) {
        for (const rect of rects) {
          const dirty = updateDisplayPreviewRect(target, preview, rect);
          if (dirty && state.webglSourceImageData === preview) webglUploadSourceRect(preview, dirty);
        }
      }
      state.displayImageData = null;
      if (maskRect) updateDustTintRect(maskRect, revision);
      scheduleDustHistogramRefresh();
      updatePreview();
    }

    function showDustParticleCount() {
      updateDustStatusUI(getLocalizedText('dustStatusDone', 'Detected {count} dust particles')
        .replace('{count}', String(state.dustRemoval.particleCount)));
    }

    function commitDustStroke(patch, stroke) {
      const dust = state.dustRemoval;
      const target = dust.inpaintedImageData;
      // Patched in place: neither the committed repair's stamp (#246) nor
      // the mask's content summary describes them any more.
      repairStamps.forget(target);
      forgetDustMaskInfo(dust.mask);
      const delta = applyStrokePatch(target, dust.mask, patch, {
        cleanSource: dust.cleanSource, countBefore: dust.particleCount,
        tagBefore: stroke.baseTag, tagAfter: stroke.tag,
        aiCleanBefore: !dustAiRefresh.rects.length,
      });
      dust.particleCount = patch.particleCount;
      dust.maskTag = stroke.tag;
      dust.revision += 1;
      pushUndoDelta('dustBrushStroke', delta);
      showDustParticleCount();
      refreshDustDisplay(target, [patch.rect], patch.maskRect, dust.revision);
      // TELEA now stands in over any MI-GAN pixels inside the rect.
      if (aiRepairReady() || state.repairStrokes.length) queueDustAiRefresh([patch.rect]);
    }

    // Undo/redo of a stroke: the bytes go back into the objects the stroke
    // patched, which become current again. No conversion, no new detection,
    // and earlier brush refinements stay.
    function restoreDustDelta(delta, direction) {
      dustDetectionRevision += 1;
      if (dustDetectionTimer) { clearTimeout(dustDetectionTimer); dustDetectionTimer = null; }
      const dust = state.dustRemoval;
      repairStamps.forget(delta.target);
      forgetDustMaskInfo(delta.mask);
      const restored = applyDustDelta(delta, direction);
      const displayed = state.processedImageData === restored.target && dust.mask === restored.mask;
      dust.cleanSource = restored.cleanSource;
      dust.inpaintedImageData = restored.target;
      dust.mask = restored.mask;
      dust.particleCount = restored.particleCount;
      dust.maskTag = restored.maskTag;
      dust.revision += 1;
      if (displayed) refreshDustDisplay(restored.target, restored.rects, delta.maskRect, dust.revision);
      else {
        applyProcessedImageToState(restored.target);
        updatePreview();
      }
      showDustParticleCount();
      followDustMaskInWorker(restored.cleanSource, restored.worker).catch(() => {});
      if (restored.aiClean) dustAiRefresh.rects.length = 0;
      else if (aiRepairReady() || state.repairStrokes.length) queueDustAiRefresh(restored.rects);
      syncDustWorkerPin();
    }

    async function onDustBrushEnd(e) {
      if (!dustDrawing) return;
      dustDrawing = false;

      if (dustBrushPoints.length === 0 || !state.processedImageData || !state.dustRemoval.mask) {
        dustBrushPoints = [];
        dustBrushSource = null;
        return;
      }
      const source = getDustSource();
      if (!state.dustRemoval.enabled || !source || source !== dustBrushSource
        || coreReprocessToken !== dustBrushToken) {
        dustBrushPoints = [];
        dustBrushSource = null;
        return;
      }
      const points = dustBrushPoints;
      const mode = dustBrushMode;
      const brushSize = state.dustRemoval.brushSize;
      const token = dustBrushToken;
      const revision = dustDetectionRevision;
      dustBrushPoints = [];
      dustBrushSource = null;
      const previousTurn = dustBrushTurn;
      let releaseTurn;
      dustBrushTurn = new Promise(resolve => { releaseTurn = resolve; });
      const isCurrent = () => state.dustRemoval.enabled && source === getDustSource()
        && coreReprocessToken === token && dustDetectionRevision === revision;
      pendingBrushRepairs += 1;
      try {
        await previousTurn;
        // Normally ready since the pin started; a stroke never clones itself.
        await prepareDustPrivateBuffer();
        if (!isCurrent() || !state.dustRemoval.mask) return;
        const dust = state.dustRemoval;
        ensureDustPrivateBuffer();
        if (dust.maskTag == null) dust.maskTag = nextDustMaskTag();
        const dustRevision = dust.revision;
        const stroke = { baseTag: dust.maskTag, tag: nextDustMaskTag(), mask: dust.mask,
          points, brushRadius: brushSize, mode, radius: 3 };
        const isStrokeCurrent = () => isCurrent() && dust.revision === dustRevision;
        const patch = await strokeDustOffMainThread(source, stroke, isStrokeCurrent);
        if (!isStrokeCurrent() || !patch) return;
        commitDustStroke(patch, stroke);
      } catch (err) {
        if (!isCurrent() || err?.name === 'AbortError') return;
        console.error('Dust brush failed:', err);
        updateDustStatusUI('Error: ' + (err.message || err));
      } finally {
        pendingBrushRepairs -= 1;
        releaseTurn();
      }
    }

    // Attach brush handlers
    canvas.addEventListener('mousedown', onDustBrushStart);
    glCanvas.addEventListener('mousedown', onDustBrushStart);
    document.addEventListener('mousemove', onDustBrushMove);
    document.addEventListener('mouseup', onDustBrushEnd);

    // Ctrl+scroll to adjust brush size
    const dustWheelHandler = (e) => {
      if (!state.dustRemoval.enabled || !state.dustRemoval.showMask) return;
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -1 : 1;
      state.dustRemoval.brushSize = Math.max(1, Math.min(50, state.dustRemoval.brushSize + delta));
      const slider = document.getElementById('dustBrushSize');
      const numInput = document.getElementById('dustBrushSizeValue');
      if (slider) slider.value = String(state.dustRemoval.brushSize);
      if (numInput) numInput.value = String(state.dustRemoval.brushSize);
    };
    canvas.addEventListener('wheel', dustWheelHandler, { passive: false });
    glCanvas.addEventListener('wheel', dustWheelHandler, { passive: false });

    // ===========================================
    // Canvas Display
    // ===========================================
    function getFullResDisplayReference(w, h) {
      // Dimensions the on-screen image will have once full-resolution
      // processing lands. While a preview-resolution stand-in is displayed
      // (SilverCore preview reprocess, downscaled WebGL source), the CSS box
      // must be fitted against this reference so the visible image keeps a
      // stable footprint instead of shrinking to the stand-in's pixel size.
      if (state.cropping || state.currentStep < 3) return null;
      const full = (state.processedImageData && !state.processedImageDataIsPreview)
        ? state.processedImageData
        : state.conversionSourceImageData;
      if (!full || !(full.width > 0) || !(full.height > 0)) return null;
      let refW = full.width;
      let refH = full.height;
      if (state.sprocketPreviewEnabled) {
        // Frame metrics expect landscape input; composeSprocketFrame rotates
        // portrait images before framing and back afterwards, so mirror that.
        const portrait = refH > refW;
        const metrics = portrait
          ? getSprocketFrameMetrics(refH, refW, getSprocketFrameComposeOptions())
          : getSprocketFrameMetrics(refW, refH, getSprocketFrameComposeOptions());
        if (metrics && metrics.outputWidth > 0 && metrics.outputHeight > 0) {
          refW = portrait ? metrics.outputHeight : metrics.outputWidth;
          refH = portrait ? metrics.outputWidth : metrics.outputHeight;
        }
      }
      if (refW <= w || refH <= h) return null;
      return { width: refW, height: refH };
    }

    // The inputs of the last fit. renderWebGL calls adjustCanvasDisplay on
    // every draw, and the result path calls it with the 2D canvas size; with
    // the container size cached, an unchanged fit costs a few comparisons and
    // touches no layout.
    const canvasDisplayFit = { w: 0, h: 0, containerW: 0, containerH: 0, zoom: 0, dpr: 0 };

    function invalidateCanvasDisplayFit() {
      canvasDisplayFit.w = 0;
    }

    function adjustCanvasDisplay(w, h) {
      const container = getCanvasContainerSize();
      // Never upscale past 100% — but for a preview-resolution stand-in,
      // "100%" means the full-resolution image it temporarily represents.
      // Fit that image itself, so the box is the same whichever stand-in
      // (GL texture, 2D canvas) asks, rather than differing by its rounding.
      const ref = getFullResDisplayReference(w, h);
      const fitW = ref ? ref.width : w;
      const fitH = ref ? ref.height : h;
      const dpr = window.devicePixelRatio || 1;
      const fit = canvasDisplayFit;
      if (fit.w === fitW && fit.h === fitH && fit.containerW === container.width && fit.containerH === container.height
        && fit.zoom === state.zoomLevel && fit.dpr === dpr) return;
      Object.assign(fit, { w: fitW, h: fitH, containerW: container.width, containerH: container.height, zoom: state.zoomLevel, dpr });
      const maxWidth = container.width - 20;
      const maxHeight = container.height - 20;
      const scale = Math.min(maxWidth / fitW, maxHeight / fitH, 1);
      const cssW = (fitW * scale) + 'px';
      const cssH = (fitH * scale) + 'px';
      canvas.style.width = cssW;
      canvas.style.height = cssH;
      glCanvas.style.width = cssW;
      glCanvas.style.height = cssH;
      canvasTransformWrapper.style.width = cssW;
      canvasTransformWrapper.style.height = cssH;
      // The GL drawing buffer follows the texture (resizeWebGLCanvas), so a
      // fit never resizes, and never clears, it.
      if (state.zoomLevel > 1) {
        clampPan();
        applyZoomPanTransform();
      }
    }

    // ===========================================
    // Zoom / Pan
    // ===========================================
    function applyZoomPanTransform() {
      const z = state.zoomLevel;
      canvasTransformWrapper.style.transform = `matrix(${z}, 0, 0, ${z}, ${state.panX}, ${state.panY}) ${interimGeometryCss()}`.trim();
      if (z > 1) {
        zoomIndicator.textContent = Math.round(z * 100) + '%';
        zoomIndicator.style.display = 'block';
        canvasContainer.classList.add('zoom-pan-active');
      } else {
        zoomIndicator.style.display = 'none';
        canvasContainer.classList.remove('zoom-pan-active');
      }
    }

    function getZoomGeometry(zoom = state.zoomLevel) {
      const container = getCanvasContainerSize();
      return computeZoomGeometry({
        wrapperW: parseFloat(canvasTransformWrapper.style.width) || canvasTransformWrapper.offsetWidth || 0,
        wrapperH: parseFloat(canvasTransformWrapper.style.height) || canvasTransformWrapper.offsetHeight || 0,
        containerW: container.width,
        containerH: container.height,
        zoom
      });
    }

    function clampPan() {
      const z = state.zoomLevel;
      if (z <= ZOOM_MIN) {
        state.panX = 0;
        state.panY = 0;
        return;
      }

      const clamped = clampPanValues(state.panX, state.panY, getZoomGeometry(z));
      state.panX = clamped.panX;
      state.panY = clamped.panY;
    }

    function resetZoomPan() {
      state.zoomLevel = 1;
      state.panX = 0;
      state.panY = 0;
      state.isPanning = false;
      canvasTransformWrapper.style.transform = interimGeometryCss();
      zoomIndicator.style.display = 'none';
      canvasContainer.classList.remove('zoom-pan-active', 'zoom-panning');
    }

    function zoomAtPoint(newZoom, clientX, clientY) {
      const oldZoom = state.zoomLevel;
      newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
      if (newZoom <= ZOOM_MIN + 0.01) newZoom = ZOOM_MIN;
      if (newZoom === oldZoom) return;

      const containerRect = canvasContainer.getBoundingClientRect();
      const cursorX = clientX - containerRect.left;
      const cursorY = clientY - containerRect.top;
      const oldGeometry = getZoomGeometry(oldZoom);

      // Content position under cursor in pre-transform space
      const contentX = (cursorX - oldGeometry.baseX - state.panX) / oldZoom;
      const contentY = (cursorY - oldGeometry.baseY - state.panY) / oldZoom;
      const newGeometry = getZoomGeometry(newZoom);

      state.zoomLevel = newZoom;
      state.panX = cursorX - newGeometry.baseX - contentX * newZoom;
      state.panY = cursorY - newGeometry.baseY - contentY * newZoom;

      clampPan();
      applyZoomPanTransform();
      // Zoom changes no pixels until the display preview settles at the new
      // size, so a tick is a compositor transform only. It still keeps a
      // full render of a <=16 MP image from landing mid-gesture.
      postponeFullResolutionRenderForInteraction();
      scheduleDisplayPreviewResize();
    }

    function canPan() {
      return state.zoomLevel > 1 && !state.cropping && !state.samplingMode
        && !canPaintAiBrush() && !(state.dustRemoval.enabled && state.dustRemoval.showMask);
    }

    function displayNegative(imageData) {
      resetZoomPan();
      renderAdjustedImageDataToMainCanvas(imageData, imageData);
      updateSprocketControlsUI();
    }

    // ===========================================
    // File Loading
    // ===========================================
    // Bumped by every loadFile call. Decodes are long (a heavy RAW takes
    // minutes) and are started fire-and-forget from the file list, the file
    // input and the drop handler, so every continuation has to check that it is
    // still the newest load before it touches state: otherwise a slow earlier
    // decode lands on top of the file the user has since opened, and the
    // settings written afterwards attach to the wrong queue entry.
    let loadGeneration = 0;
    // The background detections of the photo being prepared. A newer
    // activation aborts both requests (invalidatePhotoActivation).
    let importDetectionAbort = null;
    const quietLoadingOverlay = { show: async () => {}, updateProgress() {}, hide() {} };
    // Only inactive photos are retained here. Taking the destination before
    // storing the outgoing photo lets A -> B -> A fit a one-photo budget.
    const photoSessions = createPhotoSessionCache({
      // A 60 MP RAW base has both 8/16-bit planes (~692 MiB). Keep one
      // inactive large-frame preview session on desktop, while unknown-memory
      // touch devices and devices reporting <=4 GiB stay conservative.
      maxBytes: ((navigator.deviceMemory && navigator.deviceMemory <= 4)
        || (!navigator.deviceMemory && navigator.maxTouchPoints > 1) ? 128 : 768) * 1024 * 1024
    });
    const photoPreviews = createPhotoSessionCache({ maxBytes: 48 * 1024 * 1024 });

    // Every buffer the editor still references (#250): live `state.*` planes,
    // the display buffers, the dust planes, history snapshots and photo
    // sessions. An export never transfers or releases one of these, whatever
    // stamp it carries. Compared by buffer: an export wrapper shares
    // `state.displayImageData.data`, an identity recipe shares the processed plane.
    function liveEditorBuffers() {
      const buffers = new Set();
      const addPlanes = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value instanceof ArrayBuffer) { buffers.add(value); return; }
        if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); return; }
        const hasPlane = ArrayBuffer.isView(value.data) || (value.__image16 && ArrayBuffer.isView(value.__image16.data));
        if (!hasPlane) return;
        for (const buffer of planeBuffersOf(value)) buffers.add(buffer);
        if (value.__analysisPreview) for (const buffer of planeBuffersOf(value.__analysisPreview)) buffers.add(buffer);
      };
      for (const value of Object.values(state)) addPlanes(value);
      for (const value of Object.values(state.dustRemoval || {})) addPlanes(value);
      addPlanes(fullAdjustedBuffer);
      addPlanes(previewAdjustedBuffer);
      for (const snapshot of [...undoStack, ...redoStack]) {
        for (const value of Object.values(snapshot?.refs || {})) addPlanes(value);
      }
      for (const cache of [photoSessions, photoPreviews]) {
        const held = typeof cache.buffers === 'function' ? cache.buffers() : cache.buffers;
        for (const buffer of held || []) buffers.add(buffer);
      }
      return buffers;
    }
    setLiveReferenceProbe(liveEditorBuffers);

    // Exact, not memoised: equal only when the JSON of these values is equal
    // (settingsKey.js), with the curve LUTs of settings and studioColors
    // appended as bytes instead of index-keyed JSON objects.
    function photoSettingsKey(item) {
      return exactSettingsKey([item.settings, item.studioColors, item.filmTypeOverride,
        state.dustRemoval.enabled, state.dustRemoval.strength, state.dustRemoval.maxParticleSize,
        state.dustRemoval.ai,
        state.dustRemoval.enabled || item.settings?.repairStrokes?.length ? aiRepair.revision : null,
        state.flatFields[item.settings?.flatFieldId]?.id || null], 2);
    }

    // ===========================================
    // Hidden-window jobs (#241)
    // ===========================================
    // Batch exports, roll analysis, the contact sheet and the thumbnail lane
    // pass `hiddenJobs` (hiddenJobGate.js) before each full-resolution item.
    // With the window hidden on macOS WebKit one item runs at a time and,
    // after the grace period, only one that fits WebKit's inactive memory
    // limit. What a hidden window does not need is shed first: the photo
    // caches, idle workers and the MI-GAN session. The open photo is left
    // alone, so the same photo and edits are on screen when it is shown again.
    let activeLongJobs = 0;

    // QA/measurement override: localStorage nc_hidden_job_limits_v1 = 'force'
    // applies the macOS WebKit rules in any browser.
    function hiddenJobLimitsForced() {
      return safeStorageGet('nc_hidden_job_limits_v1') === 'force';
    }

    function hiddenJobRunning() {
      return activeLongJobs > 0 || hiddenJobs.busy || studioThumbnailsRunning || isDesktopBatchExportLocked()
        || automaticRollImportRunning || automaticRollAnalysisRunning;
    }

    // Unique backing buffers of the open photo's planes (each with its
    // __image16), the undo history and both photo caches.
    function hiddenResidentBytes() {
      const buffers = new Set();
      backingBuffers([
        state.loadedBaseImageData, state.originalImageData, state.croppedImageData, state.processedImageData,
        state.conversionSourceImageData, state.conversionPreviewImageData, state.previewSourceImageData,
        state.histogramSourceImageData, state.webglSourceImageData, state.displayImageData,
        state.dustRemoval.mask, state.dustRemoval.inpaintedImageData, state.dustRemoval.cleanSource,
        undoStack, redoStack
      ], buffers);
      for (const cache of [photoSessions, photoPreviews]) {
        for (const buffer of cache.buffers()) buffers.add(buffer);
      }
      let bytes = 0;
      for (const buffer of buffers) bytes += buffer.byteLength;
      return bytes;
    }

    // One item of these files: the larger of the RAW decode peak and the lane
    // peak, from header dimensions (the batch's largest frame).
    async function hiddenJobBytesFor(files) {
      let pixels = 0;
      for (const file of files) pixels = Math.max(pixels, await imagePixelsForBatch(file));
      return estimateHiddenJobBytes(pixels, estimateRawDecodeBytes(pixels, 1));
    }

    // Runs `work` as one gated item of a job that has no runBatchPipeline lane.
    async function runHiddenJobItem(files, work, { signal = null } = {}) {
      const release = await hiddenJobs.admit({ bytes: await hiddenJobBytesFor(files), signal });
      try {
        return await work();
      } finally {
        release();
      }
    }

    function hiddenJobUsesAiRepair() {
      if (!hiddenJobRunning()) return false;
      return Boolean(state.dustRemoval.ai && state.dustRemoval.enabled)
        || state.fileQueue.some(item => item.settings?.repairStrokes?.length);
    }

    // Terminating a worker frees its heap at once; dropped main-thread
    // references go with the next GC, which WebKit's shrink-or-die pass runs
    // before it re-measures. Workers and caches come back lazily on use.
    function shedHiddenJobMemory() {
      if (document.visibilityState !== 'hidden' || !hiddenJobs.status().limited) return;
      photoSessions.clear();
      photoPreviews.clear();
      if (!exportWorkerPendingCount()) terminateExportWorker();
      // RAW post-decode workers live only for their decode (#232): none idles.
      if (!hiddenJobUsesAiRepair()) void releaseAiRepairSession();
      hiddenJobs.recheck();
    }

    function refreshHiddenJobStatus() {
      updateDesktopBatchExportUI();
      updateRollAnalysisUI();
      if (batchOverlayProgress) {
        getLoadingOverlay().updateProgress(batchOverlayProgress.percent,
          hiddenJobs.paused ? hiddenJobPausedText() : batchOverlayProgress.label);
      }
    }

    function hiddenJobPausedText() {
      return getLocalizedText('hiddenJobPaused', 'Paused while the window is hidden');
    }

    // The browser batches' overlay progress, so a pause can replace its label.
    let batchOverlayProgress = null;
    function updateBatchOverlayProgress(percent, label) {
      batchOverlayProgress = { percent, label };
      getLoadingOverlay().updateProgress(percent, hiddenJobs.paused ? hiddenJobPausedText() : label);
    }

    document.addEventListener('visibilitychange', () => {
      hiddenJobs.visibilityChanged();
      if (document.visibilityState === 'hidden') {
        // While a job runs, shed now; an idle window keeps its warm caches
        // until the grace period ends, so a quick app switch stays warm.
        if (hiddenJobRunning()) shedHiddenJobMemory();
      } else {
        // Waiting items were released above; the thumbnail lane restarts if
        // it stopped. Caches refill on use and workers respawn lazily.
        if (parkedPhoto) void unparkOpenPhoto().catch(error => console.warn('Rebuilding the parked photo failed:', error));
        if (state.fileQueue.length) void loadStudioThumbnails();
      }
      refreshHiddenJobStatus();
    });

    // An item is held back because the hidden estimate does not fit. Log the
    // breakdown for the acceptance runs, which decide whether parking the
    // open photo (below) is needed.
    function onHiddenJobPaused() {
      const status = hiddenJobs.status();
      console.info('[hidden-job] paused while hidden', {
        residentBytes: hiddenResidentBytes(), heldBytes: status.heldBytes,
        photoSessionBytes: photoSessions.bytes, photoPreviewBytes: photoPreviews.bytes,
        undoSnapshots: undoStack.length + redoStack.length, hiddenForMs: status.hiddenForMs
      });
      if (parkOpenPhotoForHiddenJob()) queueMicrotask(() => hiddenJobs.recheck());
    }

    // Part 2e, opt-in until the footprint is measured (localStorage
    // nc_hidden_park_v1 = 'on'): while an item is held back, park the open
    // photo: persist its recipe, keep only the decoded base (and the undo
    // history, which is never dropped) and drop the derived planes. Showing
    // the window rebuilds them from the base through the cold photo-switch
    // path (base -> rotation -> mirror -> crop, then conversion) without a
    // re-decode.
    function hiddenParkEnabled() {
      return safeStorageGet('nc_hidden_park_v1') === 'on';
    }

    function parkOpenPhotoForHiddenJob() {
      if (parkedPhoto || !hiddenParkEnabled() || document.visibilityState !== 'hidden') return false;
      const item = getCurrentQueueItem();
      if (!item || item.file !== state.loadedFile || !state.loadedBaseImageData || state.rawDecodePending
        || state.currentStep < 3 || state.cropping || document.body.dataset.studioBusy || document.body.dataset.photoSwitching
        || processNegativeInFlight || coreReprocessBusy() || coreReprocessTimer || state.dustRemoval.processing
        || dustDetectionTimer || pendingBrushRepairs || dustDrawing) return false;
      persistCurrentFileSettings({ silent: true, force: true });
      ++loadGeneration;
      invalidatePhotoActivation();
      parkedPhoto = {
        item, file: item.file, base: state.loadedBaseImageData, rawMetadata: state.rawMetadata,
        undo: undoStack.slice(), redo: redoStack.slice(), isDirty: item.isDirty
      };
      for (const key of SNAPSHOT_REF_KEYS) state[key] = null;
      state.displayImageData = null;
      state.dustRemoval.mask = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.cleanSource = null;
      state.dustRemoval._state = null;
      return true;
    }

    async function unparkOpenPhoto() {
      const parked = parkedPhoto;
      parkedPhoto = null;
      const item = parked?.item;
      if (!item || state.fileQueue[state.currentFileIndex] !== item || state.loadedFile !== parked.file) return;
      const loading = loadFile(parked.file, { autoConvert: false, decoded: parked, quiet: true });
      const generation = loadGeneration;
      const result = await loading;
      if (!isCurrentLoad(generation) || result?.status !== 'loaded') return;
      resetZoomPan();
      if (item.settings) restoreSettings(item.settings, { refreshDisplay: false });
      await prepareStudioPhoto(generation, item, { quiet: true });
      if (!isCurrentLoad(generation)) return;
      undoStack.splice(0, undoStack.length, ...parked.undo);
      redoStack.splice(0, redoStack.length, ...parked.redo);
      item.isDirty = parked.isDirty;
      updateUndoRedoButtons();
      updateFileListUI();
      updateRollAnalysisUI();
      studioWorkspace?.sync();
    }

    // Debug counters for the acceptance runs (#241): what a hidden window holds.
    window.__ncHiddenJobs = {
      status: () => ({
        ...hiddenJobs.status(),
        activeLongJobs,
        residentBytes: hiddenResidentBytes(),
        photoSessionBytes: photoSessions.bytes,
        photoPreviewBytes: photoPreviews.bytes,
        exportWorkerAlive: isExportWorkerAlive(),
        aiRepairSession: aiRepair.status === 'ready' || aiRepair.status === 'loading',
        aiRepairStatus: aiRepair.status,
        aiRepairRevision: aiRepair.revision
      })
    };

    // Smoke tests (?debug=1): make a queued frame look never analysed, and
    // park the open photo without waiting for a held-back item.
    if (DEBUG_UI) {
      window.__ncHiddenJobs.parkOpenPhoto = () => parkOpenPhotoForHiddenJob();
      window.__ncHiddenJobs.forgetFrameSettings = (index) => {
        const item = state.fileQueue[index];
        if (!item || index === state.currentFileIndex) return false;
        item.settings = null;
        item.automaticSettings = false;
        return true;
      };
    }

    // Only the decoded base: used for a photo left while its import
    // detections still ran, whose provisional state must not be restored.
    function rememberPhotoBase(item) {
      if (hiddenJobs.safeMode) return false;
      if (!item || item.file !== state.loadedFile || !state.loadedBaseImageData || state.rawDecodePending) return false;
      return photoSessions.put(item, { file: item.file, base: state.loadedBaseImageData, rawMetadata: state.rawMetadata });
    }

    function rememberPhotoSession(item) {
      // The crash-loop guard runs a resumed job with the caches off.
      if (hiddenJobs.safeMode) return;
      if (item?.provisional) return rememberPhotoBase(item);
      if (!item || item.file !== state.loadedFile || !state.loadedBaseImageData || state.rawDecodePending) return;
      // A reduced preview-tier frame (#263) is never a settled view, nor is
      // one still waiting for its normal-size tick.
      const settled = state.currentStep >= 3 && state.processedImageData && !processNegativeInFlight
        && !state.geometryPending
        && !coreReprocessBusy() && !coreReprocessTimer && !state.dustRemoval.processing
        && !dustDetectionTimer && !pendingBrushRepairs && !dustDrawing && !dustAiRefresh.rects.length
        && previewTier === 'normal' && !displayIsReduced();
      const entry = {
        file: item.file, base: state.loadedBaseImageData, rawMetadata: state.rawMetadata,
        key: photoSettingsKey(item), snapshot: settled ? captureSnapshot('photoSession') : null,
        undo: settled ? undoStack.slice() : [], redo: settled ? redoStack.slice() : [],
        previewOnly: state.processedImageDataIsPreview, fullResolutionPending: state.fullResolutionPending,
        zoom: state.zoomLevel, panX: state.panX, panY: state.panY,
        filmEdge: state.filmEdge, particleCount: state.dustRemoval.particleCount
      };
      if (entry.snapshot && state.fullResolutionPending && state.previewSourceImageData) {
        // Full pixels can intentionally lag a newer slider preview. Never
        // restore those older pixels under the newer saved settings.
        entry.snapshot.refs.processedImageData = state.previewSourceImageData;
        entry.previewOnly = true;
      }
      let stored = !geometryDiagnostics.coldSessions && photoSessions.put(item, entry);
      if (!stored && entry.snapshot) {
        // Too large with its planes (#244): keep the recipe, the history as
        // scalars and the base. Opening the photo again rebuilds the planes
        // from the base in the pool behind the adjusted preview kept below.
        const cold = snapshot => ({ ...snapshot, refs: { cold: true } });
        // Dust-stroke entries (#259) only patch the planes they hold; a cold
        // history rebuilds and re-detects instead.
        const coldHistory = entries => entries.filter(entry => !entry.dustDelta).map(cold);
        stored = photoSessions.put(item, {
          ...entry, snapshot: cold(entry.snapshot), undo: coldHistory(entry.undo), redo: coldHistory(entry.redo),
          previewOnly: false, fullResolutionPending: false
        });
      }
      if (!stored) {
        // Huge geometry/history must not prevent reuse of a base that fits.
        stored = photoSessions.put(item, { file: entry.file, base: entry.base, rawMetadata: entry.rawMetadata });
      }
      if (settled) {
        // The 1200 px proxy only serves a cold revisit after eviction, so the
        // click does not build it. Sample now (a few ms, and the deferred task
        // then pins no full-resolution plane) and adjust after the next paint,
        // with the settings of this moment (curve LUTs change in place).
        const sample = samplePhotoPreviewSource(currentConvertedPreviewSource(), { maxSize: 1200 });
        const adjustments = buildAdjustmentSettings(state);
        const { r, g, b } = adjustments.curves;
        adjustments.curves = { r: new Uint8Array(r), g: new Uint8Array(g), b: new Uint8Array(b) };
        const key = entry.key;
        schedulePostPaintTask(() => {
          // A removed or re-keyed photo never gets a proxy of older settings.
          if (!state.fileQueue.includes(item) || photoSettingsKey(item) !== key) return;
          photoPreviews.put(item, { key, image: adjustPhotoPreviewSample(sample, adjustments) });
        });
      }
      return stored;
    }

    // Drops the outgoing photo's planes and history pins once its session is
    // in the cache (#244), so they are not reachable during the next decode.
    // A size-only stand-in keeps the workspace laid out as loaded; the canvas
    // keeps showing the last paint under the loading surface.
    function releaseOutgoingPhotoPlanes() {
      cancelGeometryJob();
      const frame = state.originalImageData;
      state.originalImageData = frame ? { width: frame.width, height: frame.height, released: true } : null;
      for (const key of ['croppedImageData', 'processedImageData', 'displayImageData', 'conversionSourceImageData',
        'conversionPreviewImageData', 'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData']) {
        state[key] = null;
      }
      state.dustRemoval.mask = null;
      state.dustRemoval.maskTag = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.cleanSource = null;
      state.dustRemoval._state = null;
      clearFullResolutionRenderState();
      undoStack.length = 0;
      redoStack.length = 0;
    }

    // A failed switch after the outgoing planes were released: take the
    // outgoing session back from the cache through the normal warm or
    // base-only activation.
    function reactivateReleasedPhoto(item) {
      const index = state.fileQueue.indexOf(item);
      if (index < 0) return false;
      state.loadedFile = null;
      void switchToFile(index);
      return true;
    }

    // Runs after the next paint (rAF, then a task); a hidden page paints no
    // frames, so a task alone. Behaves alike in Chromium and every WebView.
    function schedulePostPaintTask(task) {
      if (document.visibilityState === 'hidden') setTimeout(task, 0);
      else requestAnimationFrame(() => setTimeout(task, 0));
    }

    // ===========================================
    // Provisional pixels for cold opens and tiles (#235)
    // ===========================================
    // Everything here is presentation-only. Retained previews, thumbnails and
    // embedded camera JPEGs are drawn by the switch veil or published as
    // `embedded` / `analysis` tiles. None of it is ever assigned to the image
    // fields of `state`, to photoSessions, or passed to frame, film-edge, roll,
    // dust or semantic analysis, or to export.
    let embeddedPreviewPool = null;
    let provisionalRequest = null;
    function getEmbeddedPreviewPool() {
      embeddedPreviewPool ||= createEmbeddedPreviewPool({
        // Only where workers cannot decode images: small tiles, one per frame.
        mainThreadRender: job => renderEmbeddedPreview(job, createDocumentPreviewEnv(document)),
      });
      return embeddedPreviewPool;
    }

    function viewerLongSidePx() {
      const box = document.getElementById('canvasContainer')?.getBoundingClientRect();
      const css = Math.max(box?.width || 0, box?.height || 0) || Math.max(window.innerWidth || 0, window.innerHeight || 0);
      return Math.round(css * (window.devicePixelRatio || 1));
    }

    // Invert unless the exact render will not invert either, so the frame does
    // not flip between negative and positive when the exact render lands. A
    // frame without settings is never typed from the camera JPEG (#231): it
    // inverts by default. B&W frames show luminance.
    function provisionalToneFor(item) {
      const filmType = sanitizeFilmTypeOverride(item?.filmTypeOverride)?.filmType
        || item?.settings?.filmType || (!state.importFilmTypeAuto ? state.filmType : null);
      return { invert: filmType !== 'positive', monochrome: filmType === 'bw' };
    }

    // Slice 1: show what the app already holds for a cold target, in the same
    // task that shows the veil: the retained 1200 px converted copy when its
    // recipe still matches, otherwise the tile's thumbnail of any kind.
    function presentRetainedPreview(item) {
      const presentation = studioWorkspace?.photoSwitchPresentation;
      if (!presentation || state.photoSwitchTarget !== item) return null;
      const retained = photoPreviews.peek(item);
      let shown = null;
      if (retained?.key === photoSettingsKey(item) && presentation.showImageData(item, retained.image, 'cached')) shown = 'cached';
      else if (item.thumbnail && presentation.showUrl(item, item.thumbnail, 'thumbnail')) shown = 'thumbnail';
      // Perf marks let the #230 harness time provisional paints without hooks.
      if (shown) performance.mark?.('nc:provisional-paint');
      return shown;
    }

    function cancelProvisionalFrame() {
      provisionalRequest?.abort();
      provisionalRequest = null;
    }

    // Slice 2: decode the camera JPEG in a worker and show a quick positive
    // (inverted, geometry-mapped, colour-matched to a converted thumbnail when
    // one exists) in the veil. Posted before the container read is issued.
    function requestProvisionalFrame(item) {
      cancelProvisionalFrame();
      if (!item?.file || !studioWorkspace?.photoSwitchPresentation || !isTiffContainerRawName(item.file.name)) return;
      const controller = provisionalRequest = new AbortController();
      const settings = item.settings;
      const converted = item.thumbnail && (item.thumbnailKind === 'analysis' || item.thumbnailKind === 'processed');
      const job = {
        file: item.file, purpose: 'viewer', output: 'bitmap', longSidePx: viewerLongSidePx(),
        geometry: settings ? { rotationAngle: settings.rotationAngle || 0, mirrored: Boolean(settings.mirrored),
          cropRegion: settings.cropRegion || null } : null,
        matchTo: converted ? item.thumbnail : null,
        ...provisionalToneFor(item),
      };
      performance.mark?.('nc:provisional-request');
      void getEmbeddedPreviewPool().request(job, { priority: -1, signal: controller.signal }).then(result => {
        const bitmap = result?.bitmap;
        if (!bitmap) return;
        // Only the activation that asked may draw, and only while its veil is up.
        if (provisionalRequest !== controller || state.photoSwitchTarget !== item
          || document.body.dataset.photoSwitching !== 'true') { bitmap.close?.(); return; }
        if (studioWorkspace.photoSwitchPresentation.showBitmap(item, bitmap, 'embedded')) performance.mark?.('nc:provisional-paint');
      });
    }

    // Import-time tiles: every TIFF-container RAW gets an `embedded` tile from
    // its smallest adequate preview (~50-140 KB read). Not gated on roll import
    // or the editor: the jobs cost a few ms of worker time each.
    const embeddedTileItems = new Set();
    const visibleTileItems = new Set();
    const tileFlushItems = new Set();
    let tileVisibility = null;
    let tileFlushFrame = 0;

    // At most one thumbnail flush and one state refresh per frame.
    function scheduleTileFlush(item) {
      tileFlushItems.add(item);
      if (tileFlushFrame) return;
      tileFlushFrame = requestAnimationFrame(() => {
        tileFlushFrame = 0;
        const items = [...tileFlushItems];
        tileFlushItems.clear();
        for (const entry of items) updateFileThumbnail(entry, { refresh: false });
        refreshThumbnailStates();
      });
    }

    // The first photo first, then rows on screen, then the rest.
    function tilePriority(item) {
      if (item === state.fileQueue[state.currentFileIndex]) return 0;
      return visibleTileItems.has(item) ? 1 : 2;
    }

    function observeTileVisibility() {
      if (typeof IntersectionObserver !== 'function') return;
      tileVisibility ||= new IntersectionObserver(entries => {
        for (const entry of entries) {
          const item = state.fileQueue[Number(entry.target.dataset.index)];
          if (!item) continue;
          if (entry.isIntersecting) visibleTileItems.add(item);
          else visibleTileItems.delete(item);
        }
        embeddedPreviewPool?.reprioritize((job, priority) => {
          if (job.purpose !== 'tile') return priority;
          const item = state.fileQueue.find(entry => entry.file === job.file);
          return item ? tilePriority(item) : priority;
        });
      });
      for (const button of document.querySelectorAll('#fileListItems .file-list-name')) tileVisibility.observe(button);
    }

    function queueEmbeddedTiles(items) {
      const raws = items.filter(item => isTiffContainerRawName(item.file?.name) && !item.thumbnail && !embeddedTileItems.has(item));
      if (!raws.length) return;
      const pool = getEmbeddedPreviewPool();
      pool.setKeepWarm(true);
      observeTileVisibility();
      for (const item of raws) {
        embeddedTileItems.add(item);
        void pool.request({ file: item.file, purpose: 'tile', output: 'dataUrl', ...provisionalToneFor(item) },
          { priority: tilePriority(item) }).then(result => {
          embeddedTileItems.delete(item);
          if (!result?.dataUrl || !state.fileQueue.includes(item) || !canPublishThumbnail(item, 'embedded')) return;
          item.thumbnail = result.dataUrl;
          item.thumbnailKind = 'embedded';
          item.thumbnailKey = null;
          scheduleTileFlush(item);
        });
      }
    }

    // Queue changes: drop jobs of removed photos, keep one worker warm only
    // while TIFF RAWs remain, and release the pool with the queue.
    function syncEmbeddedPreviewQueue() {
      if (!embeddedPreviewPool) return;
      if (!state.fileQueue.length) {
        embeddedPreviewPool.clear();
        visibleTileItems.clear();
        return;
      }
      const files = new Set(state.fileQueue.map(item => item.file));
      embeddedPreviewPool.cancel(job => job.purpose === 'tile' && !files.has(job.file));
      for (const item of visibleTileItems) if (!files.has(item.file)) visibleTileItems.delete(item);
      embeddedPreviewPool.setKeepWarm(state.fileQueue.some(item => isTiffContainerRawName(item.file?.name)));
    }

    function invalidatePhotoActivation() {
      // A newer activation supersedes a photo parked while hidden (#241).
      parkedPhoto = null;
      pendingImportRotation = null;
      cancelGeometryJob();
      resetPreviewTierForActivation();
      cancelPendingTimers();
      // The outgoing photo's tile update cannot write into the incoming one.
      cancelStudioThumbnailUpdate();
      // The pin belongs to the outgoing photo; the next one pins on its own.
      unpinDustWorker();
      if (dustAiRefresh.timer) { clearTimeout(dustAiRefresh.timer); dustAiRefresh.timer = null; }
      dustAiRefresh.rects.length = 0;
      cancelScheduledFullResolutionRender();
      coreReprocessGeneration += 1;
      coreReprocessToken += 1;
      _coreReprocessPending = null;
      processNegativeInFlight = null;
      state.fullResolutionPromise = null;
      state.dustRemoval.processing = false;
      state.rawDecodePending = false;
      // The outgoing photo's background detections are dropped with it.
      importDetectionAbort?.abort(new DOMException('Superseded photo activation', 'AbortError'));
      importDetectionAbort = null;
      delete document.body.dataset.studioDetecting;
      getLoadingOverlay().hide();
      noteCoreReprocessSettled();
    }

    function isCurrentLoad(generation) {
      return generation === loadGeneration;
    }

    // Replacing the placeholder's innerHTML deleted the Select File / Select
    // Folder labels and both hidden file inputs, and nothing ever put them
    // back: after a load, "New Image" showed a placeholder reading only
    // "Processing…" with no way to pick a file. Write into a dedicated status
    // line instead and leave the controls in the DOM.
    function setUploadPlaceholderStatus(text, { error = false } = {}) {
      const placeholder = document.getElementById('uploadPlaceholder');
      if (!placeholder) return;
      let status = document.getElementById('uploadStatus');
      if (!status) {
        status = document.createElement('p');
        status.id = 'uploadStatus';
        status.setAttribute('role', 'status');
        placeholder.appendChild(status);
      }
      status.textContent = text || '';
      status.style.color = error ? 'var(--danger)' : '';
      status.style.display = text ? '' : 'none';
    }

    async function loadFile(file, { autoConvert = true, decoded = null, quiet = false } = {}) {
      const generation = ++loadGeneration;
      // The canvas is uncovered during a photo's detection tail, so a drop
      // can supersede it; its busy lock belongs to the dropped tail.
      const supersedesTail = Boolean(document.body.dataset.studioDetecting);
      invalidatePhotoActivation();
      // Direct imports/drops supersede any pending quiet file-list activation.
      if (!quiet && (state.photoSwitchTarget || supersedesTail)) {
        cancelProvisionalFrame();
        state.photoSwitchTarget = null;
        state.photoSwitchPhase = null;
        delete document.body.dataset.photoSwitching;
        delete document.body.dataset.studioBusy;
        studioWorkspace?.sync();
      }
      // The frame detector needs OpenCV compiled in its worker; start that
      // now so it overlaps the decode instead of following it. The preview
      // conversion follows the decode directly, so its worker starts too.
      if (autoConvert && state.autoFrame.enabled) void warmUpAutoFrameWorker();
      void convertPreviewFrameInWorker.warmUp();
      // A crop draft holds the previous image; leaving crop mode armed lets
      // "Apply" replace the newly loaded file with the old one.
      if (state.cropping) exitCropMode({ restore: false });
      if (state.beforeAfterActive) exitBeforeAfter();
      state.samplingMode = null;
      // Any background full-resolution decode still queued belongs to the file
      // being replaced.
      state._pendingFullResBuffer = null;
      state._pendingFullResFileName = null;
      state._pendingFullResFile = null;
      // Correction maps are keyed by image dimensions, so the outgoing file's
      // entries can never be reused; they just hold Float32Array grids.
      lensMapCache.clear();

      setUploadPlaceholderStatus(i18n[currentLang].processing);
      const fileName = file.name.toLowerCase();
      const isRawLikeFile = isRawLikeFileName(fileName);
      // A TIFF-container RAW import opens through the same viewer-local veil
      // as a cold switch (busy/locked datasets, "Opening {name}" live region),
      // not the full-screen overlay, so its provisional frame is visible. The
      // embedded-preview job is posted before the container read is issued.
      const openingItem = !quiet && studioWorkspace && isRawLikeFile && isTiffContainerRawName(fileName)
        ? state.fileQueue.find(entry => entry.file === file) || null : null;
      if (openingItem) beginImportOpening(openingItem);

      const overlay = quiet || openingItem ? quietLoadingOverlay : getLoadingOverlay();
      const lang = i18n[currentLang];

      try {
        if (isRawLikeFile) {
          await overlay.show({ title: lang.loadingLoading });
          overlay.updateProgress(10, lang.loadingLoading);
        }

        let imageData;
        let extractedRawMeta = decoded?.rawMetadata || null;

        if (decoded?.file === file && decoded.base) {
          imageData = decoded.base;
        } else if (isRawLikeFile) {
          const arrayBuffer = await file.arrayBuffer();
          const isHeavy = arrayBuffer.byteLength > 100 * 1024 * 1024 && !/\.tiff?$/.test(fileName);
          // A photo without settings gets createDefaultSettings right after
          // this load; let the decode's worker compute its film statistics.
          const loadingItem = state.fileQueue.find(entry => entry.file === file);
          const filmStats = loadingItem?.settings ? null : { borderBufferPct: defaultFilmBaseBuffer() };

          if (isHeavy) {
            // Two-stage loading: show fast half-size preview immediately,
            // then decode full resolution in the background.
            // The preview stage gets a COPY: LibRaw transfers its input buffer
            // to a worker, which would detach arrayBuffer and break the
            // full-resolution decode scheduled below.
            overlay.updateProgress(20, lang.loadingProcessing);
            imageData = await loadRawImageDataPreview(arrayBuffer.slice(0), fileName, {
              sourceBlob: file,
              filmStats,
              onMetadata(meta) {
                extractedRawMeta = meta;
              }
            });
            if (!isCurrentLoad(generation)) return { status: 'stale' };
            overlay.updateProgress(60, lang.loadingProcessing);

            // Schedule full-res decode. Store buffer so it stays alive.
            state._pendingFullResBuffer = arrayBuffer;
            state._pendingFullResFileName = fileName;
            state._pendingFullResFile = file;
            state.rawDecodePending = true;
          } else {
            overlay.updateProgress(30, lang.loadingProcessing);
            imageData = await loadRawImageData(arrayBuffer, fileName, {
              sourceBlob: file,
              filmStats,
              onMetadata(meta) {
                extractedRawMeta = meta;
              }
            });
            overlay.updateProgress(90, lang.loadingProcessing);
          }
        } else if (isPngFile(file)) {
          const arrayBuffer = await file.arrayBuffer();
          imageData = await loadPngImageData(arrayBuffer);
        } else {
          imageData = await loadStandardImage(file);
        }

        if (!isCurrentLoad(generation)) {
          // A newer file was opened while this decode ran. Drop the result and
          // leave the overlay alone — it belongs to that newer load now.
          return { status: 'stale' };
        }

        if (!imageData) throw new Error('Image decoder returned no pixels');
        if (imageData) {
          state.loadedFile = file;
          state.loadedBaseImageData = imageData;
          state.originalImageData = imageData;
          state.croppedImageData = null;
          state.cropRegion = null;
          state.rotationAngle = 0;
          state.mirrored = false;
          updateMirrorButtonState();
          state.processedImageData = null;
          state.displayImageData = null;
          clearFullResolutionRenderState();
          invalidateSilverCoreCache();
          state.conversionSourceImageData = null;
          state.conversionPreviewImageData = null;
          state.previewSourceImageData = null;
          state.histogramSourceImageData = null;
          state.webglSourceImageData = null;
          state.lastRenderQuality = 'full';
          state.filmBaseSet = false;
          state.grayPointSampled = false;
          state.wbAutoConfidence = null; state.wbSemanticApplied = false;
          state.wbUserOverride = false;
          // Reset the values too, not just the "was it set" flags. They used to
          // survive a file switch, so a snapshot taken of the next file — which
          // switchToFile does before the user has touched anything — carried
          // the previous frame's film base and gray-point gains and then
          // suppressed auto-detection for that file.
          state.filmBase = { ...DEFAULT_FILM_BASE };
          state.wbR = 1.0;
          state.wbG = 1.0;
          state.wbB = 1.0;
          resetFrontierGuideImageState();
          state.autoFrame.lastDiagnostics = null;
          state.filmEdge = null;
          state.rollFrame = null;
          state.localExposure = null;
          state.repairStrokes = [];
          state.rawMetadata = extractedRawMeta;
          if (webglState.gl) {
            webglState.sourceDirty = true;
            webglState.sourceSize = { w: 0, h: 0 };
          }

          if (extractedRawMeta) {
            applyLensMetadataPrefill(extractedRawMeta);
          } else {
            updateLensCorrectionUI();
          }
          // Under the opening veil the negative is not drawn, but the new
          // photo still starts unzoomed, as displayNegative would leave it.
          if (!quiet && !openingItem) displayNegative(imageData);
          else if (openingItem) { resetZoomPan(); updateSprocketControlsUI(); }
          showImageUI();
          if (openingItem && state.photoSwitchTarget === openingItem) state.photoSwitchPhase = 'preparing';
          goToStep(1);
          clearUndoHistory();
          updateAutoFrameDiagnosticsUI();
          syncBatchUIState({ reason: 'loadFile' });
          updateAutoFrameButtons();
          updateSamplingModeUI();
        }
        if (isRawLikeFile) {
          overlay.updateProgress(100, lang.loadingComplete);
          // One overlay session from decode to positive: with autoConvert the
          // conversion re-titles this overlay and hides it after the paint.
          if (!autoConvert && isCurrentLoad(generation)) overlay.hide();
          // Schedule background full-resolution decode if we used fast preview
          if (state._pendingFullResBuffer) {
            if (isCurrentLoad(generation)) {
              scheduleBackgroundFullResDecode(generation);
            } else {
              state._pendingFullResBuffer = null;
              state._pendingFullResFileName = null;
              state._pendingFullResFile = null;
            }
          }
        }
        if (autoConvert && isCurrentLoad(generation)) {
          await prepareStudioPhoto(generation, undefined, { quiet: quiet || Boolean(openingItem) });
        }
        return { status: isCurrentLoad(generation) ? 'loaded' : 'stale' };
      } catch (err) {
        console.error('Error loading file:', err);
        // Only touch the overlay if this is still the current load; a newer one
        // may already own it.
        if (!isCurrentLoad(generation)) return { status: 'stale' };
        overlay.hide();
        const text = String(err?.message || err || '');
        const isRawSupportIssue = isRawLikeFile && /module worker|worker|webassembly|wasm/i.test(text);
        // The loaders tag their failures; map each to its own explanation so a
        // too-large scan or a HEIC from a phone camera roll does not read as a
        // generic "Error loading file".
        const messageByCode = {
          RAW_DECODE_TIMEOUT: ['rawDecodeTimeout', 'This RAW file took too long to decode. Try converting to DNG or TIFF first.'],
          RAW_DECODE_GARBLED: ['rawDecodeGarbled', 'Could not decode this RAW file. Try Lossless Compressed mode or convert to DNG.'],
          TIFF_UNSUPPORTED_PHOTOMETRIC: ['rawDecodeGarbled', 'Could not decode this RAW file. Try Lossless Compressed mode or convert to DNG.'],
          IMAGE_TOO_LARGE: ['imageTooLarge', 'This scan is too large for this browser to render. Downscale it or use the desktop app.'],
          HEIC_DECODE_FAILED: ['heicDecodeFailed', 'Could not decode this HEIC/HEIF photo. Please try another copy.'],
          DEVICE_MEMORY_LIMIT: ['deviceMemoryLimit', 'This device does not have enough memory for this file. Try a smaller scan or the desktop app.'],
          IMAGE_DECODE_FAILED: ['loadError', 'Error loading file']
        };
        const mapped = messageByCode[err?.code];
        const message = mapped
          ? getLocalizedText(mapped[0], mapped[1])
          : isRawSupportIssue
            ? getLocalizedText('rawUnsupported', 'RAW decode is not supported in this Safari version. Update Safari or convert to TIFF/JPEG first.')
            : getLocalizedText('loadError', 'Error loading file');
        setUploadPlaceholderStatus(message, { error: true });
        // The placeholder is hidden once an image is on screen, so a failure
        // while switching files would otherwise be completely invisible.
        showToast(message);
        return { status: 'error', message };
      } finally {
        // Only the current import may remove its own opening feedback.
        if (openingItem && isCurrentLoad(generation)) endImportOpening(openingItem);
      }
    }

    function beginImportOpening(item) {
      state.photoSwitchTarget = item;
      state.photoSwitchPhase = 'loading';
      document.body.dataset.photoSwitching = 'true';
      document.body.dataset.studioBusy = 'true';
      // sync() also lays the viewer out ahead of the decode: the empty state
      // otherwise removes it (body.studio-opening, photo-switch-feedback.css).
      studioWorkspace.sync();
      presentRetainedPreview(item);
      requestProvisionalFrame(item);
    }

    function endImportOpening(item) {
      cancelProvisionalFrame();
      if (state.photoSwitchTarget === item) {
        state.photoSwitchTarget = null;
        state.photoSwitchPhase = null;
        delete document.body.dataset.photoSwitching;
        delete document.body.dataset.studioBusy;
      }
      updateFileListUI();
      studioWorkspace?.sync();
    }

    async function scheduleBackgroundFullResDecode(generation = loadGeneration) {
      const buf = state._pendingFullResBuffer;
      const name = state._pendingFullResFileName;
      const sourceFile = state._pendingFullResFile;
      if (!buf || !name) return;
      if (!isCurrentLoad(generation)) return;
      state._pendingFullResBuffer = null;
      state._pendingFullResFileName = null;
      state._pendingFullResFile = null;

      if (DEBUG_UI) {
        console.info('[RAW] starting background full-res decode for', name, (buf.byteLength / 1024 / 1024).toFixed(0) + 'MB');
      }

      try {
        const fullImageData = await loadRawImageData(buf, name, {
          // Its embedded-preview fallback re-reads the file instead of
          // scanning and copying the preview up front.
          sourceBlob: sourceFile && sourceFile === state.loadedFile ? sourceFile : null,
          onMetadata(meta) {
            if (isCurrentLoad(generation) && meta && !state.rawMetadata) {
              state.rawMetadata = meta;
              applyLensMetadataPrefill(meta);
            }
          }
        });
        if (!fullImageData) return;
        // The decode takes tens of seconds to minutes. Anything the user did
        // in the meantime wins: a different file must not be replaced by this
        // one, and a crop draft in progress must not be yanked out from under
        // the pointer.
        if (!isCurrentLoad(generation)) return;
        if (state.cropping) return;

        // Replace the preview with the full-res image. Rotation and crop were
        // set against the half-size preview, so they have to be re-applied to
        // the full-size decode — the crop rectangle in particular is in
        // preview pixels and would otherwise cut out the top-left quadrant and
        // keep the export at half resolution.
        const preview = state.loadedBaseImageData;
        const scaleX = preview && preview.width ? fullImageData.width / preview.width : 1;
        const scaleY = preview && preview.height ? fullImageData.height / preview.height : 1;
        const previewCropRegion = state.cropRegion;

        state.loadedBaseImageData = fullImageData;
        state.rawDecodePending = false;
        // A new base: the chain is rebuilt from it (the memo cannot match).
        // The preview's planes stay installed until the full ones land.
        const ready = applyGeometryFromBase({
          cropRegion: previewCropRegion ? {
            left: previewCropRegion.left * scaleX,
            top: previewCropRegion.top * scaleY,
            width: previewCropRegion.width * scaleX,
            height: previewCropRegion.height * scaleY
          } : null
        });

        clearFullResolutionRenderState();
        invalidateSilverCoreCache();
        state.conversionSourceImageData = null;
        state.conversionPreviewImageData = null;

        await afterGeometry(ready, async isCurrent => {
          if (state.currentStep >= 3) {
            // Already converted against the preview: redo the conversion at full
            // resolution rather than painting the raw negative over the result.
            await convertAfterGeometryEdit(isCurrent).catch((err) => {
              console.error('Re-conversion after full-res decode failed:', err);
            });
          } else {
            displayNegative(state.croppedImageData || state.originalImageData);
            updateCanvasVisibility();
          }
        });
        if (DEBUG_UI) console.info('[RAW] background full-res decode complete');
      } catch (err) {
        console.warn('[RAW] background full-res decode failed, keeping preview', err.message);
        // Keep the preview — it's still usable.
      }
    }

    function showImageUI() {
      setUploadPlaceholderStatus('');
      document.getElementById('uploadPlaceholder').style.display = 'none';
      document.getElementById('previewToolbar').style.display = 'flex';
      document.getElementById('histogramContainer').style.display = 'block';
      document.getElementById('controlsPanel').style.display = 'flex';

      // Zoom button tooltips come from data-i18n-title in the markup.
      zoomControls.style.display = 'flex';

      redrawHistogramIfPossible();
      updateCanvasVisibility();
      // The panels above just changed the container before the observer
      // could report it.
      refreshCanvasContainerSize();
      adjustCanvasDisplay(canvas.width, canvas.height);
      updateAutoFrameConfigUI();
      updateAutoFrameDiagnosticsUI();
      updateLensCorrectionUI();
      updateBeforeAfterButtonState();
      updateSprocketControlsUI();
    }

    // ===========================================
    // Film Base Sampling
    // ===========================================
    function requiresFilmBase(settings = state) {
      return sanitizePresetType(settings?.filmType || state.filmType || 'color') === 'color';
    }

    function suggestStep2Mode() {
      if (!requiresFilmBase()) return 'border';
      if (state.cropRegion) return 'noBorder';

      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return 'border';
      noteGeometryPixelRead('suggestStep2Mode');
      const suggestionBuffer = state.step2Mode === 'noBorder'
        ? state.coreBorderBufferBorderValue
        : state.coreBorderBuffer;
      const sample = autoDetectFilmBase(sourceData, suggestionBuffer);
      const orangeBias = (sample.r - sample.b) + ((sample.r - sample.g) * 0.5);
      return orangeBias > 10 ? 'border' : 'noBorder';
    }

    function setStep2Mode(mode) {
      const nextMode = mode === 'noBorder' ? 'noBorder' : 'border';
      state.step2Mode = nextMode;
      const borderBtn = document.getElementById('step2ModeBorderBtn');
      const noBorderBtn = document.getElementById('step2ModeNoBorderBtn');
      if (borderBtn) borderBtn.classList.toggle('active', state.step2Mode === 'border');
      if (noBorderBtn) noBorderBtn.classList.toggle('active', state.step2Mode === 'noBorder');
      syncSliderFromState('coreBorderBuffer');
      const borderBufferSlider = document.getElementById('coreBorderBuffer');
      const borderBufferValue = document.getElementById('coreBorderBufferValue');
      if (borderBufferSlider) borderBufferSlider.disabled = false;
      if (borderBufferValue) borderBufferValue.disabled = false;
      updateFilmModeUI();
    }

    function applyRollReferenceToCurrentForStep2() {
      if (!hasRollReference()) return false;
      const ref = state.rollReference.settingsSnapshot;
      if (!ref) return false;

      state.filmType = sanitizePresetType(ref.filmType || inferFilmTypeFromLegacyPreset(ref.filmPreset, 'color'));
      state.filmBase = { ...ref.filmBase };
      state.filmBaseSet = true;
      if (ref.lensCorrection) {
        const safeLens = sanitizeLensCorrection(ref.lensCorrection, state.lensCorrection);
        state.lensCorrection.enabled = Boolean(safeLens.enabled);
        state.lensCorrection.selectedLens = safeLens.selectedLens ? { ...safeLens.selectedLens } : null;
        state.lensCorrection.params = { ...safeLens.params };
        state.lensCorrection.modes = { ...safeLens.modes };
        state.lensCorrection.lastError = safeLens.lastError || '';
        if (state.lensCorrection.selectedLens) {
          state.lensCorrection.search.lensModel = state.lensCorrection.selectedLens.model || state.lensCorrection.search.lensModel;
          state.lensCorrection.search.lensMaker = state.lensCorrection.selectedLens.maker || state.lensCorrection.search.lensMaker;
        }
      }

      updateSlidersFromState();
      updateLensCorrectionUI();
      updateFilmBasePreview();
      markCurrentFileDirty();
      return true;
    }




    function updateFilmModeUI() {
      const filmBaseControls = document.getElementById('filmBaseControls');
      const positiveFilmInfo = document.getElementById('positiveFilmInfo');
      const modeToggle = document.getElementById('step2ModeToggle');
      const step2CoreColorModelControl = document.getElementById('coreColorModelStep2Control');
      const sampleBaseBtn = document.getElementById('sampleBaseBtn');
      const autoDetectBtn = document.getElementById('autoDetectBtn');
      const useReferenceBtn = document.getElementById('useReferenceBtn');
      const showFilmBase = requiresFilmBase();
      const showStep2CoreModel = usesSilverCoreConversion(state);
      updateStep3SectionVisibility();

      modeToggle.style.display = showFilmBase ? 'flex' : 'none';
      filmBaseControls.style.display = showFilmBase ? 'block' : 'none';
      positiveFilmInfo.style.display = showFilmBase ? 'none' : 'block';
      const positiveControls = document.getElementById('positiveModeControl');
      if (positiveControls) {
        positiveControls.hidden = state.filmType !== 'positive';
        document.getElementById('positiveModeSelect').value = state.positiveMode;
      }
      const detectionStatus = document.getElementById('filmTypeDetectionStatus');
      if (detectionStatus) {
        const automatic = state.filmTypeSource === 'auto' && state.filmTypeConfidence;
        const key = !automatic ? 'filmTypeManual' : state.filmTypeConfidence === 'low' ? (state.filmTypeReason === 'monochrome' ? 'filmTypeMonochrome' : 'filmTypeUncertain')
          : state.filmTypeReason === ROLL_MONOCHROME.reason ? 'filmTypeRollMonochrome'
          : state.filmTypeConfidence === 'high' ? 'filmTypeDetected' : 'filmTypeSuggested';
        detectionStatus.dataset.i18n = key;
        detectionStatus.textContent = i18n[currentLang][key];
        detectionStatus.dataset.confidence = automatic ? state.filmTypeConfidence : 'manual';
      }
      if (step2CoreColorModelControl) {
        step2CoreColorModelControl.style.display = showStep2CoreModel ? 'block' : 'none';
      }

      if (!showFilmBase) {
        if (state.samplingMode === 'filmBase') {
          state.samplingMode = null;
          updateSamplingModeUI();
        }
        document.getElementById('filmBasePreview').style.display = 'none';
        updateRollReferenceUI();
        updateLensCorrectionUI();
        updateBeforeAfterButtonState();
        return;
      }

      if (state.samplingMode === 'filmBase' && state.step2Mode === 'noBorder') {
        state.samplingMode = null;
        updateSamplingModeUI();
      }

      sampleBaseBtn.style.display = state.step2Mode === 'border' ? 'inline-flex' : 'none';
      autoDetectBtn.style.display = 'inline-flex';
      useReferenceBtn.style.display = state.step2Mode === 'noBorder' ? 'inline-flex' : 'none';

      updateFilmBasePreview();
      updateRollReferenceUI();
      updateLensCorrectionUI();
      updateBeforeAfterButtonState();
    }

    function updateFilmBasePreview() {
      const preview = document.getElementById('filmBasePreview');
      const colorBox = document.getElementById('filmBaseColor');
      const values = document.getElementById('filmBaseValues');

      if (!requiresFilmBase()) {
        preview.style.display = 'none';
        return;
      }

      if (state.filmBaseSet) {
        preview.style.display = 'flex';
        colorBox.style.backgroundColor = `rgb(${state.filmBase.r}, ${state.filmBase.g}, ${state.filmBase.b})`;
        const confidence = Number(state.filmBase.confidence);
        const confidenceText = Number.isFinite(confidence) ? ` C: ${Math.round(confidence * 100)}%` : '';
        const selected = Number(state.filmBase.selected);
        const selectedText = Number.isFinite(selected) && selected > 0 ? ` N: ${selected}` : '';
        values.textContent = `R: ${state.filmBase.r} G: ${state.filmBase.g} B: ${state.filmBase.b}${confidenceText}${selectedText}`;
      } else {
        preview.style.display = 'none';
      }
    }

    document.getElementById('sampleBaseBtn').addEventListener('click', () => {
      if (!requiresFilmBase()) return;
      if (state.step2Mode !== 'border') return;
      exitBeforeAfter();
      state.samplingMode = 'filmBase';
      updateSamplingModeUI();
      updateBeforeAfterButtonState();
    });

    document.getElementById('autoDetectBtn').addEventListener('click', () => {
      if (!requiresFilmBase()) return;
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return;
      noteGeometryPixelRead('autoDetectBase');
      pushUndo('autoDetectBase');
      state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
      state.filmBaseSet = true;
      updateFilmBasePreview();
      markCurrentFileDirty();
      scheduleSilverSourceRefresh({ immediate: true });
    });

    document.getElementById('useReferenceBtn').addEventListener('click', () => {
      if (!hasRollReference()) {
        void appAlert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      if (applyRollReferenceToCurrentForStep2()) {
        scheduleSilverSourceRefresh({ immediate: true });
        void appAlert(i18n[currentLang].rollReferenceAppliedCurrent || 'Roll reference applied to current image.');
      }
    });

    document.getElementById('applyConvertBtn').addEventListener('click', () => {
      if (requiresFilmBase() && !state.filmBaseSet) {
        const usedReference = state.step2Mode === 'noBorder' ? applyRollReferenceToCurrentForStep2() : false;
        if (!usedReference) {
          // Auto detect if not set
          const sourceData = state.croppedImageData || state.originalImageData;
          noteGeometryPixelRead('applyConvert');
          state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
          state.filmBaseSet = true;
          updateFilmBasePreview();
          markCurrentFileDirty();
          if (state.step2Mode === 'border') {
            void appAlert(getLocalizedText('guideAutoDetectFallback', 'Mask was not sampled manually, so auto-detect was applied.'));
          } else if (!hasRollReference()) {
            void appAlert(getLocalizedText('guideReferenceSuggestion', 'If auto-detect is unstable, set one frame as roll reference first.'));
          }
        }
      }
      void processNegative();
    });

    function readLensSearchInputsFromUI() {
      const lensModelInput = document.getElementById('lensLensModelInput');
      const lensMakerInput = document.getElementById('lensLensMakerInput');
      const cameraModelInput = document.getElementById('lensCameraModelInput');
      const cameraMakerInput = document.getElementById('lensCameraMakerInput');
      state.lensCorrection.search = {
        lensModel: String(lensModelInput?.value || '').trim(),
        lensMaker: String(lensMakerInput?.value || '').trim(),
        cameraModel: String(cameraModelInput?.value || '').trim(),
        cameraMaker: String(cameraMakerInput?.value || '').trim()
      };
      return state.lensCorrection.search;
    }

    function applyLensProfileSelection(lens) {
      const selected = sanitizeLensSelection(lens, null);
      if (!selected) return false;
      state.lensCorrection.selectedLens = selected;
      state.lensCorrection.enabled = true;
      state.lensCorrection.search.lensModel = selected.model || state.lensCorrection.search.lensModel;
      state.lensCorrection.search.lensMaker = selected.maker || state.lensCorrection.search.lensMaker;
      if (!state.lensCorrection.paramTouched.crop && Number.isFinite(selected.cropFactor) && selected.cropFactor > 0) {
        state.lensCorrection.params.crop = clampBetween(selected.cropFactor, 0.1, 10);
      }
      if (!state.lensCorrection.paramTouched.focal) {
        state.lensCorrection.params.focal = clampBetween(guessFocalFromLensProfile(selected), 1, 10_000);
      }
      if (!state.lensCorrection.paramTouched.aperture && Number.isFinite(selected.maxAperture) && selected.maxAperture > 0) {
        state.lensCorrection.params.aperture = clampBetween(selected.maxAperture, 0.5, 512);
      }
      state.lensCorrection.lastError = '';
      setLensStatus('lensStatusSelected', { lens: formatLensLabel(selected) || `#${selected.handle}` });
      updateLensCorrectionUI();
      markCurrentFileDirty();
      return true;
    }

    async function runLensProfileSearch() {
      const searchBtn = document.getElementById('lensSearchBtn');
      const query = readLensSearchInputsFromUI();
      if (!query.lensModel) {
        setLensStatus('lensStatusNeedModel');
        updateLensCorrectionUI();
        return;
      }

      const previousText = searchBtn.textContent;
      searchBtn.disabled = true;
      setLensStatus('lensStatusLoading');
      updateLensCorrectionUI();

      try {
        const runtime = await ensureLensfunClient();
        state.lensCorrection.source = runtime.source;
        setLensStatus(resolveLensStatusKeyForSource(runtime.source));

        const searchFlags = Number.isFinite(runtime.searchFlags) ? runtime.searchFlags : 2;
        const results = runtime.client.searchLenses({
          lensModel: query.lensModel,
          lensMaker: query.lensMaker || undefined,
          cameraMaker: query.cameraMaker || undefined,
          cameraModel: query.cameraModel || undefined,
          searchFlags
        });

        state.lensCorrection.searchResults = Array.isArray(results) ? results.slice(0, 200) : [];
        renderLensSearchResults();

        if (!state.lensCorrection.searchResults.length) {
          setLensStatus('lensStatusNoResult');
          updateLensCorrectionUI();
          return;
        }

        setLensStatus('lensStatusSearchCount', {
          count: state.lensCorrection.searchResults.length
        });
        updateLensCorrectionUI();
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        state.lensCorrection.lastError = reason;
        setLensStatus('lensStatusInitFailed', { reason });
        updateLensCorrectionUI();
      } finally {
        searchBtn.disabled = false;
        if (previousText) searchBtn.textContent = previousText;
      }
    }

    document.getElementById('lensEnableInput').addEventListener('change', (e) => {
      state.lensCorrection.enabled = Boolean(e.target.checked);
      if (state.lensCorrection.enabled && !state.lensCorrection.selectedLens) {
        setLensStatus('lensStatusNeedProfile');
      } else if (!state.lensCorrection.enabled) {
        setLensStatus('lensStatusSkipped');
      } else if (state.lensCorrection.selectedLens) {
        setLensStatus('lensStatusSelected', {
          lens: formatLensLabel(state.lensCorrection.selectedLens) || `#${state.lensCorrection.selectedLens.handle}`
        });
      }
      updateLensCorrectionUI();
      markCurrentFileDirty();
    });

    document.getElementById('lensSkipBtn').addEventListener('click', () => {
      state.lensCorrection.enabled = false;
      setLensStatus('lensStatusSkipped');
      updateLensCorrectionUI();
      markCurrentFileDirty();
    });

    document.getElementById('lensSearchBtn').addEventListener('click', () => {
      void runLensProfileSearch();
    });

    document.getElementById('lensUseSelectedBtn').addEventListener('click', () => {
      const select = document.getElementById('lensResultSelect');
      const idx = Number(select.value);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.lensCorrection.searchResults.length) {
        setLensStatus('lensStatusNeedProfile');
        updateLensCorrectionUI();
        return;
      }
      applyLensProfileSelection(state.lensCorrection.searchResults[idx]);
    });

    document.getElementById('lensResultSelect').addEventListener('change', (e) => {
      const idx = Number(e.target.value);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.lensCorrection.searchResults.length) return;
      const candidate = state.lensCorrection.searchResults[idx];
      setLensStatus('lensStatusSelected', { lens: formatLensLabel(candidate) || `#${candidate.handle}` });
      updateLensCorrectionUI();
    });

    const lensTextInputs = ['lensLensModelInput', 'lensLensMakerInput', 'lensCameraModelInput', 'lensCameraMakerInput'];
    lensTextInputs.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', () => {
        readLensSearchInputsFromUI();
      });
    });

    function bindLensNumericParamInput(id, key, min, max, decimals = 3) {
      const input = document.getElementById(id);
      if (!input) return;
      const handler = () => {
        const value = sanitizeNumeric(input.value, state.lensCorrection.params[key], min, max);
        state.lensCorrection.params[key] = value;
        input.value = String(Number(value).toFixed(decimals)).replace(/\.?0+$/, '');
        state.lensCorrection.paramTouched[key] = true;
        markCurrentFileDirty();
      };
      input.addEventListener('change', handler);
      input.addEventListener('blur', handler);
    }

    bindLensNumericParamInput('lensFocalInput', 'focal', 1, 10_000, 2);
    bindLensNumericParamInput('lensCropInput', 'crop', 0.1, 10, 3);
    bindLensNumericParamInput('lensApertureInput', 'aperture', 0.5, 512, 2);
    bindLensNumericParamInput('lensDistanceInput', 'distance', 0.1, 100_000, 2);
    bindLensNumericParamInput('lensStepInput', 'step', 1, 16, 0);

    document.getElementById('lensStepModeSelect').addEventListener('change', (e) => {
      state.lensCorrection.params.stepMode = e.target.value === 'manual' ? 'manual' : 'auto';
      state.lensCorrection.paramTouched.stepMode = true;
      syncLensStepInputState();
      markCurrentFileDirty();
    });

    updateLensCorrectionUI();

    // ===========================================
    // White Balance Sampling
    // ===========================================
    document.getElementById('sampleWBBtn').addEventListener('click', () => {
      startWhiteBalanceSampling();
    });

    // ===========================================
    // Sampling Loupe (Magnifier)
    // ===========================================
    const LOUPE_PATCH_SIZE = 31;
    const LOUPE_HALF = (LOUPE_PATCH_SIZE - 1) / 2;
    const loupePatchData = new Uint8ClampedArray(LOUPE_PATCH_SIZE * LOUPE_PATCH_SIZE * 4);
    const loupePatch = new ImageData(loupePatchData, LOUPE_PATCH_SIZE, LOUPE_PATCH_SIZE);
    const loupePatchAdjustedData = new Uint8ClampedArray(LOUPE_PATCH_SIZE * LOUPE_PATCH_SIZE * 4);
    const loupePatchAdjusted = new ImageData(loupePatchAdjustedData, LOUPE_PATCH_SIZE, LOUPE_PATCH_SIZE);

    loupeSrcCanvas.width = LOUPE_PATCH_SIZE;
    loupeSrcCanvas.height = LOUPE_PATCH_SIZE;

    let loupeRaf = 0;
    let loupePending = null;

    function clampBetween(v, min, max) {
      if (v < min) return min;
      if (v > max) return max;
      return v;
    }

    function showLoupe() {
      loupe.style.display = 'block';
    }

    function hideLoupe() {
      if (loupeRaf) cancelAnimationFrame(loupeRaf);
      loupeRaf = 0;
      loupePending = null;
      loupe.style.display = 'none';
      loupeInfo.textContent = '';
    }

    function positionLoupe(clientX, clientY) {
      const containerRect = canvasContainer.getBoundingClientRect();
      const loupeRect = loupe.getBoundingClientRect();

      const offset = 18;
      const margin = 6;
      let left = clientX - containerRect.left + offset;
      let top = clientY - containerRect.top + offset;

      if (left + loupeRect.width + margin > containerRect.width) {
        left = clientX - containerRect.left - loupeRect.width - offset;
      }
      if (top + loupeRect.height + margin > containerRect.height) {
        top = clientY - containerRect.top - loupeRect.height - offset;
      }

      const maxLeft = Math.max(margin, containerRect.width - loupeRect.width - margin);
      const maxTop = Math.max(margin, containerRect.height - loupeRect.height - margin);
      loupe.style.left = clampBetween(left, margin, maxLeft) + 'px';
      loupe.style.top = clampBetween(top, margin, maxTop) + 'px';
    }

    function fillLoupePatchFromSource(sourceData, cx, cy) {
      const { width, height, data } = sourceData;
      let dstIdx = 0;
      for (let py = 0; py < LOUPE_PATCH_SIZE; py++) {
        const sy = clampBetween(cy + py - LOUPE_HALF, 0, height - 1);
        const row = sy * width * 4;
        for (let px = 0; px < LOUPE_PATCH_SIZE; px++) {
          const sx = clampBetween(cx + px - LOUPE_HALF, 0, width - 1);
          const srcIdx = row + sx * 4;
          loupePatchData[dstIdx] = data[srcIdx];
          loupePatchData[dstIdx + 1] = data[srcIdx + 1];
          loupePatchData[dstIdx + 2] = data[srcIdx + 2];
          loupePatchData[dstIdx + 3] = 255;
          dstIdx += 4;
        }
      }
    }

    function drawLoupeOverlay() {
      const pixelSize = loupeCanvas.width / LOUPE_PATCH_SIZE;
      const center = LOUPE_HALF * pixelSize + pixelSize / 2;
      const centerPixel = LOUPE_HALF * pixelSize;

	      // Center pixel outline
	      loupeCtx.lineWidth = 2;
	      loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
	      loupeCtx.strokeRect(centerPixel, centerPixel, pixelSize, pixelSize);
	      loupeCtx.lineWidth = 1;
	      loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
	      loupeCtx.strokeRect(centerPixel + 0.5, centerPixel + 0.5, pixelSize - 1, pixelSize - 1);

      // Crosshair (with outline for contrast)
      loupeCtx.lineCap = 'butt';
      loupeCtx.beginPath();
      loupeCtx.lineWidth = 3;
      loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      loupeCtx.moveTo(center, 0);
      loupeCtx.lineTo(center, loupeCanvas.height);
      loupeCtx.moveTo(0, center);
      loupeCtx.lineTo(loupeCanvas.width, center);
      loupeCtx.stroke();

      loupeCtx.beginPath();
      loupeCtx.lineWidth = 1;
      loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      loupeCtx.moveTo(center, 0);
      loupeCtx.lineTo(center, loupeCanvas.height);
      loupeCtx.moveTo(0, center);
      loupeCtx.lineTo(loupeCanvas.width, center);
      loupeCtx.stroke();
    }

    function updateLoupe() {
      loupeRaf = 0;
      const pending = loupePending;
      loupePending = null;

      if (!pending || !state.samplingMode || state.cropping) {
        hideLoupe();
        return;
      }

      const target = pending.target;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        hideLoupe();
        return;
      }

      const relX = (pending.clientX - rect.left) / rect.width;
      const relY = (pending.clientY - rect.top) / rect.height;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
        hideLoupe();
        return;
      }

      let sourceData = null;
      const showAdjusted = state.samplingMode === 'whiteBalance';
      if (state.samplingMode === 'filmBase') {
        sourceData = state.geometryPending ? null : state.croppedImageData || state.originalImageData;
      } else if (state.samplingMode === 'whiteBalance') {
        sourceData = state.processedImageData;
      }
      if (!sourceData) {
        hideLoupe();
        return;
      }

      const cx = clampBetween(Math.floor(relX * sourceData.width), 0, sourceData.width - 1);
      const cy = clampBetween(Math.floor(relY * sourceData.height), 0, sourceData.height - 1);

      fillLoupePatchFromSource(sourceData, cx, cy);

      let centerR = 0, centerG = 0, centerB = 0;
      const centerIdx = (LOUPE_HALF * LOUPE_PATCH_SIZE + LOUPE_HALF) * 4;

      if (showAdjusted) {
        applyAdjustmentsToBuffer(loupePatch, state, loupePatchAdjusted, 'full');
        loupeSrcCtx.putImageData(loupePatchAdjusted, 0, 0);
        centerR = loupePatchAdjustedData[centerIdx];
        centerG = loupePatchAdjustedData[centerIdx + 1];
        centerB = loupePatchAdjustedData[centerIdx + 2];
      } else {
        loupeSrcCtx.putImageData(loupePatch, 0, 0);
        centerR = loupePatchData[centerIdx];
        centerG = loupePatchData[centerIdx + 1];
        centerB = loupePatchData[centerIdx + 2];
      }

      loupeCtx.imageSmoothingEnabled = false;
      loupeCtx.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);
      loupeCtx.drawImage(loupeSrcCanvas, 0, 0, loupeCanvas.width, loupeCanvas.height);
      drawLoupeOverlay();

      loupeInfo.textContent = `x ${cx}  y ${cy}   RGB ${centerR} ${centerG} ${centerB}`;

      showLoupe();
      positionLoupe(pending.clientX, pending.clientY);
    }

    function handleLoupePointer(e) {
      if (!state.samplingMode || state.cropping) {
        hideLoupe();
        return;
      }

      loupePending = {
        clientX: e.clientX,
        clientY: e.clientY,
        target: e.currentTarget
      };

      if (!loupeRaf) {
        loupeRaf = requestAnimationFrame(updateLoupe);
      }
    }

    [canvas, glCanvas].forEach(el => {
      el.addEventListener('pointermove', handleLoupePointer);
      el.addEventListener('pointerdown', handleLoupePointer);
      el.addEventListener('pointerleave', hideLoupe);
      el.addEventListener('pointercancel', hideLoupe);
    });

    // ===========================================
    // Canvas Click Handler (Sampling)
    // ===========================================
    function handleSamplingClick(e) {
      if (state.cropping) return;
      if (!state.samplingMode) return;

      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

      if (state.samplingMode === 'filmBase') {
        // The planes on screen are being rebuilt: no sample of the old ones.
        if (state.geometryPending) return;
        const sourceData = state.croppedImageData || state.originalImageData;
        if (!sourceData) return;

        pushUndo('filmBase');
        const x = Math.floor(relX * sourceData.width);
        const y = Math.floor(relY * sourceData.height);

        state.filmBase = sampleFilmBase(sourceData, x, y, 10);
        state.filmBaseSet = true;
        state.samplingMode = null;
        updateSamplingModeUI();
        updateFilmBasePreview();
        markCurrentFileDirty();
        updateBeforeAfterButtonState();
        scheduleSilverSourceRefresh({ immediate: true });
      } else if (state.samplingMode === 'whiteBalance') {
        // Sample from processed image (post-inversion)
        if (!state.processedImageData) return;

        pushUndo('whiteBalance');
        const x = Math.floor(relX * state.processedImageData.width);
        const y = Math.floor(relY * state.processedImageData.height);

        const sample = sampleFilmBase(state.processedImageData, x, y, 5);
        const gray = (sample.r + sample.g + sample.b) / 3;

        // Calculate multipliers to make sampled point neutral
        state.wbR = sample.r > 0 ? gray / sample.r : 1;
        state.wbG = sample.g > 0 ? gray / sample.g : 1;
        state.wbB = sample.b > 0 ? gray / sample.b : 1;

        // Normalize so G=1
        const norm = state.wbG;
        state.wbR /= norm;
        state.wbG = 1;
        state.wbB /= norm;
        state.grayPointSampled = true;
        state.wbAutoConfidence = null; state.wbSemanticApplied = false;

        state.samplingMode = null;
        updateSamplingModeUI();
        updateWBSliders();
        markCurrentFileDirty();
        updateBeforeAfterButtonState();
        updateFull();
      }
    }

    canvas.addEventListener('click', handleSamplingClick);
    glCanvas.addEventListener('click', handleSamplingClick);

    // ===========================================
    // Film Type & Preset Selection
    // ===========================================
    function setFilmTypeButtons(type) {
      document.querySelectorAll('.film-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
      });
    }

    document.querySelectorAll('.step2-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setStep2Mode(btn.dataset.mode);
      });
    });

    document.querySelectorAll('.film-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pushUndo('filmType');
        state.filmType = btn.dataset.type;
        state.filmTypeSource = 'manual';
        state.filmTypeConfidence = null;
        state.filmTypeReason = null;
        if (state.wbAutoConfidence && !state.wbUserOverride && !state.grayPointSampled) {
          state.wbR = state.wbG = state.wbB = 1;
          state.wbAutoConfidence = null; state.wbSemanticApplied = false;
          updateWBSliders();
        }
        setFilmTypeButtons(state.filmType);
        let modeUpdated = false;
        if (requiresFilmBase()) {
          setStep2Mode(suggestStep2Mode());
          modeUpdated = true;
        }
        if (!modeUpdated) {
          updateFilmModeUI();
        }

        markCurrentFileDirty();
        if (usesSilverCoreConversion(state)) {
          scheduleSilverSourceRefresh();
        } else {
          schedulePreviewUpdate();
        }
      });
    });

    document.getElementById('applyFilmTypeToRollBtn').addEventListener('click', () => {
      if (state.currentStep < 3 || !state.originalImageData || document.body.dataset.studioBusy
        || state.cropping || isDesktopBatchExportLocked() || !state.fileQueue.length) return;
      persistCurrentFileSettings({ silent: true, force: true });
      pushUndo('rollFilmType');
      automaticRollRevision++;
      const choice = { filmType: state.filmType, positiveMode: state.positiveMode };
      for (const item of state.fileQueue) {
        item.filmTypeOverride = { ...choice };
        if (item.settings) item.settings = applyFilmTypeOverride(item.settings, choice);
        item.thumbnailKey = null; item.thumbnailAttempted = false;
        item.status = 'pending'; item.isDirty = false;
      }
      state.rollAnalysis = { equalize: Boolean(state.rollAnalysis.equalize) };
      restoreSettings(getCurrentQueueItem().settings);
      invalidateSilverCoreCache();
      updateFileListUI(); updateRollAnalysisUI();
      scheduleSilverSourceRefresh({ immediate: true });
      scheduleProjectRecovery();
      showToast(getInterpolatedText('filmTypeAppliedRoll', { count: String(state.fileQueue.length) }, `Film type applied to ${state.fileQueue.length} photos`));
    });

    document.getElementById('importFilmTypeAuto').addEventListener('change', event => {
      state.importFilmTypeAuto = event.target.checked;
    });
    document.getElementById('positiveModeSelect').addEventListener('change', event => {
      pushUndo('filmType');
      state.positiveMode = event.target.value === 'edit' ? 'edit' : 'correct';
      if (state.wbAutoConfidence && !state.wbUserOverride && !state.grayPointSampled) {
        state.wbR = state.wbG = state.wbB = 1;
        state.wbAutoConfidence = null; state.wbSemanticApplied = false;
        updateWBSliders();
      }
      markCurrentFileDirty();
      scheduleSilverSourceRefresh();
    });
    setFilmTypeButtons(state.filmType);

    // ===========================================
    // Slider Controls
    // ===========================================
    const sliderBindings = [];
    const sliderBindingMap = new Map();
    const selectBindings = [];
    const checkboxBindings = [];

    function getStepDecimals(step) {
      const text = String(step);
      if (text.includes('e-')) {
        const exp = Number.parseInt(text.split('e-')[1], 10);
        return Number.isFinite(exp) ? exp : 0;
      }
      const dotIndex = text.indexOf('.');
      return dotIndex >= 0 ? (text.length - dotIndex - 1) : 0;
    }

    function normalizeSliderValue(value, min, max, step, decimals) {
      if (!Number.isFinite(value)) return min;

      let nextValue = Math.min(max, Math.max(min, value));
      if (Number.isFinite(step) && step > 0) {
        nextValue = min + (Math.round((nextValue - min) / step) * step);
      }
      return Number(nextValue.toFixed(decimals));
    }

    function formatSliderValue(value, decimals) {
      return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    }

    function setupSlider(id, stateKey, options = {}) {
      const slider = document.getElementById(id);
      const valueInput = document.getElementById(id + 'Value');
      if (!slider || !valueInput) return;

      const min = Number.parseFloat(slider.min);
      const max = Number.parseFloat(slider.max);
      const step = Number.parseFloat(slider.step || '1');
      const decimals = Number.isInteger(options.decimals) ? options.decimals : getStepDecimals(step);
      const format = options.format || ((value) => formatSliderValue(value, decimals));
      const normalize = (rawValue) => normalizeSliderValue(rawValue, min, max, step, decimals);
      const onInput = typeof options.onInput === 'function' ? options.onInput : null;
      const onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;

      const syncUI = (value) => {
        slider.value = String(value);
        valueInput.value = format(value);
      };

      // The value the input handler last asked for. A commit (`change`, or
      // value-box Enter/blur) repeats it; asking again would queue a duplicate
      // conversion of the frame already shown.
      const binding = { id, stateKey, slider, valueInput, normalize, format, lastInputValue: null };
      const handleInput = (value) => {
        if (onInput) onInput(value);
        else schedulePreviewUpdate();
        binding.lastInputValue = value;
      };

      const applyValue = (rawValue, commitFull = false) => {
        const value = normalize(rawValue);
        const unchanged = commitFull && value === binding.lastInputValue && state[stateKey] === value;
        state[stateKey] = value;
        syncUI(value);
        markCurrentFileDirty();
        if (!unchanged) handleInput(value);
        if (commitFull) {
          if (onCommit) onCommit(value);
          else scheduleFullUpdate();
        }
      };

      // Undo: capture snapshot before drag starts
      let preDragSnapshot = null;

      slider.addEventListener('pointerdown', () => {
        preDragSnapshot = captureSnapshot(stateKey);
      });

      slider.addEventListener('input', () => {
        applyValue(Number.parseFloat(slider.value), false);
      });

      slider.addEventListener('change', () => {
        if (preDragSnapshot) {
          commitUndoSnapshot(preDragSnapshot);
          preDragSnapshot = null;
          updateUndoRedoButtons();
        }
        applyValue(Number.parseFloat(slider.value), true);
      });

      valueInput.addEventListener('input', () => {
        const parsed = Number.parseFloat(valueInput.value);
        if (!Number.isFinite(parsed)) return;
        const value = normalize(parsed);
        state[stateKey] = value;
        slider.value = String(value);
        markCurrentFileDirty();
        handleInput(value);
      });

      const commitFromInput = () => {
        pushUndo(stateKey);
        const parsed = Number.parseFloat(valueInput.value);
        const sourceValue = Number.isFinite(parsed) ? parsed : state[stateKey];
        applyValue(sourceValue, true);
      };

      valueInput.addEventListener('blur', commitFromInput);
      valueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitFromInput();
        }
      });

      sliderBindings.push(binding);
      sliderBindingMap.set(id, binding);
      syncUI(normalize(state[stateKey]));
    }

    function syncSliderFromState(id) {
      const binding = sliderBindingMap.get(id);
      if (!binding) return;
      const value = binding.normalize(Number.parseFloat(state[binding.stateKey]));
      state[binding.stateKey] = value;
      binding.slider.value = String(value);
      binding.valueInput.value = binding.format(value);
      // State set from outside the slider was not asked for by its input
      // handler, so the next commit of this value must not be skipped.
      binding.lastInputValue = null;
    }

    function syncAllSlidersFromState() {
      sliderBindings.forEach(binding => syncSliderFromState(binding.id));
    }

    function setupSelect(id, stateKey, options = {}) {
      const select = document.getElementById(id);
      if (!select) return;
      const onChange = typeof options.onChange === 'function' ? options.onChange : null;

      if (typeof state[stateKey] === 'string' && select.value !== state[stateKey]) {
        select.value = state[stateKey];
      }

      select.addEventListener('change', () => {
        if (state[stateKey] === select.value) return;
        pushUndo(stateKey);
        state[stateKey] = select.value;
        markCurrentFileDirty();
        if (onChange) onChange(select.value);
        else scheduleFullUpdate();
      });

      selectBindings.push({ id, stateKey, select });
    }

    function setupCheckbox(id, stateKey, options = {}) {
      const checkbox = document.getElementById(id);
      if (!checkbox) return;
      const onChange = typeof options.onChange === 'function' ? options.onChange : null;

      checkbox.checked = Boolean(state[stateKey]);
      checkbox.addEventListener('change', () => {
        pushUndo(stateKey);
        state[stateKey] = Boolean(checkbox.checked);
        markCurrentFileDirty();
        if (onChange) onChange(state[stateKey]);
        else schedulePreviewUpdate();
      });

      checkboxBindings.push({ id, stateKey, checkbox });
    }

    function syncAllSelectsFromState() {
      selectBindings.forEach(({ select, stateKey }) => {
        const value = String(state[stateKey] ?? '');
        if (select.value !== value) select.value = value;
      });
    }

    function syncAllCheckboxesFromState() {
      checkboxBindings.forEach(({ checkbox, stateKey }) => {
        checkbox.checked = Boolean(state[stateKey]);
      });
    }

    function updateWBSliders() {
      ['wbR', 'wbG', 'wbB'].forEach(syncSliderFromState);
    }

    // The last frame a SilverCore slider asked for: which control, which value,
    // and the token that request received. runCoreReprocess clears it when a
    // frame fails, so the release retries.
    let coreSliderCommitRecord = null;

    function coreReprocessHandlersFor(stateKey) {
      return {
        // SilverCore の色調は画素に焼き込まれるため、ドラッグ中も変換する。
        // The enlarger head mirrors the same values, so it follows every change.
        onInput: (value) => {
          updateEnlargerUI();
          const before = coreReprocessToken;
          scheduleCoreReprocess({ full: false });
          coreSliderCommitRecord = coreReprocessToken !== before
            ? { key: stateKey, value, token: coreReprocessToken }
            : null;
        },
        onCommit: (value) => {
          updateEnlargerUI();
          // Releasing the slider settles the drag: bring the plane back.
          requestCorePreviewCommit();
          // An unchanged token proves nothing else asked for a frame since
          // this value's request. The conversion reads live state when it
          // starts, so the queued, running or finished frame already shows it.
          const record = coreSliderCommitRecord;
          if (record && record.key === stateKey && record.value === value
            && record.token === coreReprocessToken) return;
          scheduleCoreReprocess({ full: false });
        }
      };
    }

    function cacheBorderBufferValueForBorderMode(value) {
      if (!requiresFilmBase()) return;
      if (state.step2Mode === 'noBorder') return;
      state.coreBorderBufferBorderValue = sanitizeNumeric(value, state.coreBorderBufferBorderValue ?? 10, 0, 30);
    }

    const coreBorderBufferHandlers = {
      onInput: (value) => {
        cacheBorderBufferValueForBorderMode(value);
        scheduleSilverSourceRefresh();
      },
      onCommit: (value) => {
        cacheBorderBufferValueForBorderMode(value);
        scheduleSilverSourceRefresh({ immediate: true });
      }
    };

    function handleCoreColorModelChange() {
      state.frontierGuideStep2ChoiceTouched = true;
      scheduleSilverSourceRefresh();
    }

    function handleFilmPresetChange(presetId) {
      state.frontierGuideStep2ChoiceTouched = true;
      void applyFilmPresetSettingsToState(presetId).then(() => {
        scheduleSilverSourceRefresh();
      });
    }

    setupSlider('coreProfileStrength', 'coreProfileStrength', coreReprocessHandlersFor('coreProfileStrength'));
    setupSlider('corePreSaturation', 'corePreSaturation', coreReprocessHandlersFor('corePreSaturation'));
    setupSlider('coreBorderBuffer', 'coreBorderBuffer', coreBorderBufferHandlers);
    setupSlider('coreBrightness', 'coreBrightness', coreReprocessHandlersFor('coreBrightness'));
    setupSlider('coreExposure', 'coreExposure', coreReprocessHandlersFor('coreExposure'));
    setupSlider('coreContrast', 'coreContrast', coreReprocessHandlersFor('coreContrast'));
    setupSlider('coreHighlights', 'coreHighlights', coreReprocessHandlersFor('coreHighlights'));
    setupSlider('coreShadows', 'coreShadows', coreReprocessHandlersFor('coreShadows'));
    setupSlider('coreWhites', 'coreWhites', coreReprocessHandlersFor('coreWhites'));
    setupSlider('coreBlacks', 'coreBlacks', coreReprocessHandlersFor('coreBlacks'));
    setupSlider('coreTemperature', 'coreTemperature', coreReprocessHandlersFor('coreTemperature'));
    setupSlider('coreTint', 'coreTint', coreReprocessHandlersFor('coreTint'));
    setupSlider('coreCyan', 'coreCyan', coreReprocessHandlersFor('coreCyan'));
    populatePaperOptions();
    setupSelect('corePaper', 'corePaper', {
      onChange: () => { updatePaperUI(); scheduleCoreReprocess({ full: false }); }
    });
    setupSelect('corePaperToning', 'corePaperToning', {
      onChange: () => scheduleCoreReprocess({ full: false })
    });
    setupSlider('corePaperToningStrength', 'corePaperToningStrength', coreReprocessHandlersFor('corePaperToningStrength'));
    setupSlider('coreSaturation', 'coreSaturation', coreReprocessHandlersFor('coreSaturation'));
    setupSlider('coreGlow', 'coreGlow', coreReprocessHandlersFor('coreGlow'));
    setupSlider('coreFade', 'coreFade', coreReprocessHandlersFor('coreFade'));
    setupSelect('coreColorModelStep2', 'coreColorModel', {
      onChange: handleCoreColorModelChange
    });
    setupSelect('filmPreset', 'coreFilmPreset', {
      onChange: handleFilmPresetChange
    });
    setupSelect('coreEnhancedProfile', 'coreEnhancedProfile', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupSelect('coreWbMode', 'coreWbMode', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupSelect('coreCurvePrecision', 'coreCurvePrecision', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupCheckbox('coreUseWebGL', 'coreUseWebGL', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });

    // A manual RGB-gain drag hands WB ownership to the user: the automatic
    // gray-point estimator must never overwrite it afterwards. The handlers
    // replicate setupSlider's default scheduling on top of flagging that.
    const markWbUserOverride = () => {
      if (!state.wbUserOverride || state.wbAutoConfidence) {
        state.wbUserOverride = true;
        state.wbAutoConfidence = null; state.wbSemanticApplied = false;
        updateGrayPointGuideUI();
      }
    };
    const wbSliderOptions = {
      decimals: 2,
      onInput: () => {
        markWbUserOverride();
        schedulePreviewUpdate();
      },
      onCommit: () => {
        markWbUserOverride();
        scheduleFullUpdate();
      },
    };
    setupSlider('wbR', 'wbR', wbSliderOptions);
    setupSlider('wbG', 'wbG', wbSliderOptions);
    setupSlider('wbB', 'wbB', wbSliderOptions);
    setupSlider('cyan', 'cyan');
    setupSlider('magenta', 'magenta');
    setupSlider('yellow', 'yellow');

    // Initialize step2 mode only after slider bindings exist.
    // setStep2Mode() syncs coreBorderBuffer via syncSliderFromState().
    setStep2Mode(suggestStep2Mode());

    // ===========================================
    // Section Toggle
    // ===========================================
    document.querySelectorAll('.section-header').forEach(header => {
      header.addEventListener('click', () => {
        const toggle = header.querySelector('.section-toggle');
        const section = header.dataset.section;
        if (!section) return;

        const content = document.getElementById(section + 'SectionContent') ||
                       document.getElementById(section + 'Section');
        if (content && toggle) {
          toggle.classList.toggle('collapsed');
          content.classList.toggle('collapsed');
        }
      });
    });

    // ===========================================
    // Rotation
    // ===========================================

    let autoFrameAnalyzerPromise = null;

    function getAutoFrameAnalyzer() {
      if (!autoFrameAnalyzerPromise) {
        autoFrameAnalyzerPromise = import('./autoFrameAnalyzer.js').catch((err) => {
          autoFrameAnalyzerPromise = null;
          throw err;
        });
      }
      return autoFrameAnalyzerPromise;
    }

    function inferConfidenceLevel(confidence) {
      const high = Number.isFinite(state.autoFrame.highConfidence) ? state.autoFrame.highConfidence : 0.72;
      const min = Number.isFinite(state.autoFrame.minConfidence) ? state.autoFrame.minConfidence : 0.55;
      if (confidence >= high) return 'high';
      if (confidence >= min) return 'medium';
      return 'low';
    }

    // `silent` runs without the blocking overlay (background roll analysis
    // must not cover the editor); `analyzeInWorker` picks a worker other than
    // the shared one so several frames can be detected at once. The import
    // path passes the auto-frame settings and film type of its snapshot, so a
    // provisional render cannot change what the detector sees, and a signal
    // that a superseded activation aborts.
    async function detectFrameAndRotation(imageData, {
      silent = false, analyzeInWorker = analyzeFrameInWorker,
      autoFrame = state.autoFrame, filmType = state.filmType, signal = null
    } = {}) {
      if (!imageData) return null;
      const overlay = getLoadingOverlay();
      const ownsOverlay = !silent && !overlay.isVisible;
      if (ownsOverlay) {
        await overlay.show({ title: studioWorkspace.text('detectingFrame'), indeterminate: true });
        // Paint the overlay while visible; a hidden window never fires rAF.
        await yieldForJob();
      }
      try {
      const options = {
        settings: {
          ...autoFrame,
          filmType
        },
        maxSide: AUTO_FRAME_MAX_SIDE,
        formatRatios: AUTO_FRAME_FORMAT_RATIOS,
        default120Formats: AUTO_FRAME_DEFAULT_120_FORMATS,
        scoreWeights: AUTO_FRAME_SCORE_WEIGHTS
      };
      let mainThread = false;
      const result = await detectFrameWithFallback(imageData, options, {
        workerSupported: typeof Worker === 'function' && typeof OffscreenCanvas === 'function',
        analyzeInWorker: signal ? (image, config) => analyzeInWorker(image, config, 'analyze-frame', { signal }) : analyzeInWorker,
        ensureOpenCvReady,
        onWorkerError: err => console.warn('Auto-frame worker unavailable, using fallback:', err),
        analyzeOnMainThread: async (source, config) => {
          mainThread = true;
          const { detectFrameAndRotation: analyzeFrameAndRotation } = await getAutoFrameAnalyzer();
          return analyzeFrameAndRotation(source, {
            ...config,
            rotateImageData: (image, angle) => {
              if (image === source) geometryDiagnostics.mainRotations++;
              return applyRotationToImageData(image, angle);
            },
            sanitizeCropRegion: sanitizeCropRegionForImage
          });
        }
      });
      // The debug count of full-resolution rotations (#244): the worker
      // returns its rotated frame for every non-zero angle it applies.
      if (!mainThread && result?.rotatedImageData && result.rotatedImageData.width !== imageData.width) {
        geometryDiagnostics.workerRotations++;
      }
      return result;
      } finally {
        if (ownsOverlay) overlay.hide();
      }
    }

    function formatAutoFrameDetail(result) {
      const detailTemplate = i18n[currentLang].autoFramePreviewDetail
        || 'Rotate {angle}°, crop to {width}x{height}, confidence {confidence}';
      const base = detailTemplate
        .replace('{angle}', String(result.angle))
        .replace('{width}', String(result.cropRegion.width))
        .replace('{height}', String(result.cropRegion.height))
        .replace('{confidence}', String(result.confidence.toFixed(2)));
      const formatPart = result.detectedFormat ? `\nformat: ${result.detectedFormat}` : '';
      return `${base}${formatPart}`;
    }

    function autoFrameEffectiveAngle(angle) {
      const base = normalizeAngleDegrees(angle || 0);
      return state.autoFrame.rotate180Default ? normalizeAngleDegrees(base + 180) : base;
    }

    // 180° keeps the canvas size, so a crop region computed on the detector's
    // rotated frame maps onto the flipped frame by mirroring both corners.
    function rotate180CropRegion(cropRegion, frameWidth, frameHeight) {
      if (!cropRegion) return null;
      return {
        left: Math.max(0, frameWidth - cropRegion.left - cropRegion.width),
        top: Math.max(0, frameHeight - cropRegion.top - cropRegion.height),
        width: cropRegion.width,
        height: cropRegion.height
      };
    }

    // The detector's pre-rotated frame is only valid when no 180° flip is
    // added. The Auto Frame button has always installed it as is.
    function offerAutoFrameRotation(result, effectiveAngle, base) {
      pendingImportRotation = !state.autoFrame.rotate180Default && result?.rotatedImageData && base
        ? { base, angle: effectiveGeometryAngle(effectiveAngle), image: result.rotatedImageData, anySource: true }
        : null;
    }

    // `baseImageData` is the frame the detector analysed. It is only adopted as
    // the new working image when the result is actually applied: assigning it
    // up front left originalImageData as the unrotated base whenever the user
    // declined the prompt, while rotationAngle, cropRegion and the canvas still
    // described the rotated frame.
    async function applyAutoFrameResult(result, baseImageData) {
      const base = baseImageData || state.originalImageData;
      if (!result || result.requiresReview || !result.cropRegion || !base) return false;

      const effectiveAngle = autoFrameEffectiveAngle(result.angle);
      state.rotationAngle = effectiveAngle;
      state.mirrored = false; // the detector ran on the unmirrored base
      updateMirrorButtonState();
      offerAutoFrameRotation(result, effectiveAngle, base);
      const frame = geometryFrameSize(base, effectiveAngle);
      const cropRegion = state.autoFrame.rotate180Default
        ? rotate180CropRegion(result.cropRegion, frame.width, frame.height)
        : result.cropRegion;
      const ready = applyGeometryFromBase({ cropRegion, refreshDisplay: true });
      state.autoFrame.lastDiagnostics = {
        ...state.autoFrame.lastDiagnostics,
        ...(canAutoApplyImportFrame(result, state.autoFrame) ? { imageArea: imageAreaFromDetection(result, base), analysisNeedsReview: false } : {}),
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: false,
        appliedMode: 'crop',
        lowConfidenceApplied: (result.confidenceLevel || inferConfidenceLevel(result.confidence || 0)) === 'low'
      };
      updateAutoFrameDiagnosticsUI();
      // The border-mode suggestion reads the new planes.
      await afterGeometry(ready, () => setStep2Mode(suggestStep2Mode()));
      return true;
    }

    async function applyAutoFrameRotationOnly(result, baseImageData) {
      const base = baseImageData || state.originalImageData;
      if (!result || !base) return false;
      const effectiveAngle = autoFrameEffectiveAngle(result.angle);
      state.rotationAngle = effectiveAngle;
      state.mirrored = false; // the detector ran on the unmirrored base
      updateMirrorButtonState();
      offerAutoFrameRotation(result, effectiveAngle, base);
      const ready = applyGeometryFromBase({ cropRegion: null, refreshDisplay: true });
      state.autoFrame.lastDiagnostics = {
        ...state.autoFrame.lastDiagnostics,
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: true,
        appliedMode: 'rotateOnly',
        lowConfidenceApplied: false
      };
      updateAutoFrameDiagnosticsUI();
      await afterGeometry(ready, () => setStep2Mode(suggestStep2Mode()));
      return true;
    }

    function mapCropRegionAfterRotation(cropRegion, sourceWidth, sourceHeight, rotatedWidth, rotatedHeight, angleDegrees) {
      if (!cropRegion) return null;
      const rad = (Number(angleDegrees) || 0) * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const srcCx = sourceWidth / 2;
      const srcCy = sourceHeight / 2;
      const dstCx = rotatedWidth / 2;
      const dstCy = rotatedHeight / 2;

      const corners = [
        { x: cropRegion.left, y: cropRegion.top },
        { x: cropRegion.left + cropRegion.width, y: cropRegion.top },
        { x: cropRegion.left + cropRegion.width, y: cropRegion.top + cropRegion.height },
        { x: cropRegion.left, y: cropRegion.top + cropRegion.height }
      ];

      const rotated = corners.map((point) => {
        const relX = point.x - srcCx;
        const relY = point.y - srcCy;
        const x = relX * cos - relY * sin + dstCx;
        const y = relX * sin + relY * cos + dstCy;
        return { x, y };
      });

      const minX = Math.min(...rotated.map(point => point.x));
      const maxX = Math.max(...rotated.map(point => point.x));
      const minY = Math.min(...rotated.map(point => point.y));
      const maxY = Math.max(...rotated.map(point => point.y));

      return sanitizeCropRegionForImage({
        left: Math.floor(minX),
        top: Math.floor(minY),
        width: Math.ceil(maxX - minX),
        height: Math.ceil(maxY - minY)
      }, { width: rotatedWidth, height: rotatedHeight });
    }

    function invalidateProcessedPipelineState() {
      state.processedImageData = null;
      state.displayImageData = null;
      clearFullResolutionRenderState();
      invalidateSilverCoreCache();
      state.conversionSourceImageData = null;
      state.conversionPreviewImageData = null;
      state.previewSourceImageData = null;
      state.histogramSourceImageData = null;
      state.webglSourceImageData = null;
      state.lastRenderQuality = 'full';
      if (webglState.gl) {
        webglState.sourceDirty = true;
        webglState.sourceSize = { w: 0, h: 0 };
      }
      clearCoreReprocessTimer();
      releaseCorePreviewRetained();
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }
    }

    // ===========================================
    // Geometry chain: base -> rotation -> mirror -> crop (#244)
    // ===========================================
    // Every frame is derived from the decoded base by the total angle, so the
    // live planes always equal what restoreSettings and batch export build.
    // The installed output (the crop, or the frame when there is no crop)
    // carries the key it was built for. A refresh that leaves the geometry
    // unchanged then makes no kernel call. The key lives on the object, never
    // in a free variable: undo, a new file, a heavy-RAW upgrade or any other
    // install replaces that object and so invalidates the memo by itself.
    //
    // Pixels are built off the main thread by the geometry pool, in row bands
    // of the crop window only. With a crop, state.originalImageData is a
    // frame descriptor (size and recipe, no pixels); readers that need the
    // whole frame's pixels ask for them asynchronously. Scalars
    // (rotationAngle, mirrored, cropRegion) change synchronously; a reader of
    // the planes awaits whenGeometrySettled() first.
    if (typeof window !== 'undefined') {
      window.__ncGeometry = {
        diagnostics: geometryDiagnostics, main: geometryCounters, pool: geometryPool.counters,
        disableWorkers: () => geometryPool.disableWorkers(),
        pending: () => Boolean(state.geometryPending),
        inspect: inspectGeometryState,
        // Builds the current geometry again (the memo is dropped for it).
        rebuild: () => {
          const installed = state.croppedImageData || state.originalImageData;
          if (installed) geometryMemo.delete(installed);
          return applyGeometryFromBase();
        }
      };
    }

    // For the smoke run and the #230 memory scenario: the planes' hashes, the
    // same chain built on this thread from the base, and the unique bytes
    // held by state, history and photo sessions (once per ArrayBuffer).
    function inspectGeometryState({ chain = false } = {}) {
      const hash = data => {
        let value = 2166136261;
        for (let i = 0; i < data.length; i++) value = Math.imul(value ^ data[i], 16777619);
        return value >>> 0;
      };
      const planes = state.croppedImageData || state.originalImageData;
      const frame = state.originalImageData;
      const base = state.loadedBaseImageData;
      const held = backingBuffers([state, undoStack, redoStack]);
      for (const buffer of photoSessions.buffers()) held.add(buffer);
      let uniqueBytes = 0;
      for (const buffer of held) uniqueBytes += buffer.byteLength;
      const baseBuffers = new Set(base ? [base.data?.buffer, base.__image16?.data?.buffer] : []);
      const frameBytes = frame ? frame.width * frame.height * 4 : 0;
      const frameSized = [...held].filter(buffer => !baseBuffers.has(buffer)
        && (buffer.byteLength === frameBytes || buffer.byteLength === frameBytes * 2)).length;
      const result = {
        pending: Boolean(state.geometryPending), descriptor: isGeometryFrame(frame),
        rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion,
        width: planes?.width || 0, height: planes?.height || 0,
        hash8: !isGeometryFrame(planes) && planes?.data ? hash(planes.data) : null,
        hash16: !isGeometryFrame(planes) && planes?.__image16?.data ? hash(planes.__image16.data) : null,
        frameSized, uniqueBytes, undoDepth: undoStack.length, coldEntries: undoStack.filter(entry => entry.refs?.cold).length
      };
      if (chain && base) {
        const expected = applyGeometryChainToImageData(base, {
          rotationAngle: effectiveGeometryAngle(state.rotationAngle), mirrored: state.mirrored, cropRegion: state.cropRegion
        }, exportGeometrySteps);
        result.chainHash8 = hash(expected.data);
        result.chainHash16 = expected.__image16 ? hash(expected.__image16.data) : null;
      }
      return result;
    }

    function geometryBaseId(base) {
      let id = geometryBaseIds.get(base);
      if (!id) {
        id = nextGeometryBaseId++;
        geometryBaseIds.set(base, id);
      }
      return id;
    }

    // restoreSettings has always ignored angles within 0.001° of zero.
    function effectiveGeometryAngle(angle) {
      const normalized = normalizeAngleDegrees(Number(angle) || 0);
      return Math.abs(normalized) > 0.001 ? normalized : 0;
    }

    function geometryFrameSize(base, angle) {
      if (!base) return null;
      return rotatedDimensions(base.width, base.height, effectiveGeometryAngle(angle));
    }

    function geometryKeyFor(base, { rotationAngle = 0, mirrored = false, cropRegion = null } = {}) {
      if (!base) return null;
      const angle = effectiveGeometryAngle(rotationAngle);
      const frame = rotatedDimensions(base.width, base.height, angle);
      return {
        baseId: geometryBaseId(base), angle, mirrored: Boolean(mirrored),
        frameWidth: frame.width, frameHeight: frame.height,
        crop: sanitizeCropRect(cropRegion, frame)
      };
    }

    function sameGeometryKey(a, b) {
      if (!a || !b || a.baseId !== b.baseId || a.angle !== b.angle || a.mirrored !== b.mirrored) return false;
      if (!a.crop || !b.crop) return !a.crop && !b.crop;
      return a.crop.left === b.crop.left && a.crop.top === b.crop.top
        && a.crop.width === b.crop.width && a.crop.height === b.crop.height;
    }

    function installedGeometryKey() {
      const installed = state.croppedImageData || state.originalImageData;
      return installed ? geometryMemo.get(installed) || null : null;
    }

    function hasExactPlane16(image) {
      const plane = image?.__image16;
      return Boolean(plane && plane.data instanceof Uint16Array && plane.width === image.width
        && plane.height === image.height && plane.data.length === image.data?.length);
    }

    function isGeometryFrame(image) {
      return Boolean(image?.__geometryFrame);
    }

    // A frame rotated elsewhere is adopted only when it is the one this thread
    // would build: the same base, the same angle, and the exact 16-bit kernel
    // (a worker's OffscreenCanvas may rasterise an 8-bit source differently).
    // `anySource` keeps the Auto Frame button's installation of the worker
    // frame for 8-bit sources; that frame is then not memoised.
    function takeAdoptedRotation(base, angle) {
      const adopted = pendingImportRotation;
      pendingImportRotation = null;
      if (!adopted || !angle || adopted.base !== base || adopted.angle !== angle) return null;
      const image = adopted.image;
      const frame = rotatedDimensions(base.width, base.height, angle);
      if (!image || image.width !== frame.width || image.height !== frame.height) return null;
      const exact = hasExactPlane16(base) && hasExactPlane16(image);
      if (!exact && !adopted.anySource) return null;
      geometryDiagnostics.adoptedRotations++;
      return { image, exact };
    }

    // The whole rotated (and mirrored) frame of a crop, as size and recipe
    // only. Its pixels are not kept: renderFrameSample and geometryFramePixels
    // build what a reader needs. A synchronous read of `data` still works as
    // a last resort (counted, built once on this thread).
    function createGeometryFrame(base, key) {
      const frame = { width: key.frameWidth, height: key.frameHeight };
      const recipe = { base, key, pixels: null };
      Object.defineProperties(frame, {
        __geometryFrame: { value: recipe },
        data: { get: () => materializeGeometryFrame(recipe).data },
        __image16: { get: () => materializeGeometryFrame(recipe).__image16 }
      });
      return frame;
    }

    function materializeGeometryFrame(recipe) {
      if (!recipe.pixels) {
        geometryDiagnostics.frameSyncReads++;
        if (geometryDiagnostics.frameSyncReads === 1) console.warn('Geometry frame pixels were read synchronously; building them on the main thread.');
        recipe.pixels = renderGeometryFrame(recipe.base, recipe.key) || recipe.base;
      }
      return recipe.pixels;
    }

    function geometryPlanFor(source, key, { crop = key.crop, step = 1, rotated = false } = {}) {
      return planGeometry(source, {
        rotationAngle: rotated ? 0 : key.angle, mirrored: key.mirrored, cropRegion: crop
      }, { step });
    }

    // The full frame on this thread: the core, or the 2D canvas for 8-bit
    // sources at a non-right angle.
    function renderGeometryFrame(base, key) {
      if (key.angle) geometryDiagnostics.mainRotations++;
      const plan = geometryPlanFor(base, key, { crop: null });
      if (plan) return renderGeometry(base, plan);
      let frame = applyRotationToImageData(base, key.angle);
      if (key.mirrored) frame = mirrorImageDataHorizontal(frame);
      return frame;
    }

    // The band budget of one batch lane also bounds an interactive build's
    // transient band copies (WebKit's content process has less headroom).
    function interactiveGeometryBands(plan) {
      return planGeometryBandsInFlight({
        lanes: 1, pixelsPerFile: plan.outWidth * plan.outHeight, poolSize: geometryPool.size,
        deviceMemory: typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined
      });
    }

    // Planes for `key`: the crop window (or the frame when there is no crop)
    // from the pool, and a frame descriptor beside a crop.
    async function buildGeometryPlanes(base, key, adopted, isCurrent) {
      if (adopted && !adopted.exact) {
        // The Auto Frame button's worker rotation of an 8-bit source (its
        // canvas): this thread could not rebuild it, so it stays the working
        // frame as it always was.
        const plan = geometryPlanFor(adopted.image, key, { crop: null, rotated: true });
        const frame = plan && !plan.identity ? await geometryPool.render(adopted.image, plan, { isCurrent }) : adopted.image;
        if (!frame || !isCurrent()) return null;
        return { frame, cropped: key.crop ? cropImageDataRegion(frame, key.crop) : null };
      }
      const source = adopted ? adopted.image : base;
      const plan = geometryPlanFor(source, key, { rotated: Boolean(adopted) });
      if (!plan) {
        // 8-bit source at a non-right angle: the canvas rotates here, as it
        // always has; the rotated frame is then the only full-size plane.
        await yieldToEventLoop();
        if (!isCurrent()) return null;
        const frame = renderGeometryFrame(base, key);
        return { frame, cropped: key.crop ? cropImageDataRegion(frame, key.crop) : null };
      }
      const output = plan.identity ? source : await geometryPool.render(source, plan, { isCurrent, maxInFlight: interactiveGeometryBands(plan) });
      if (!output || !isCurrent()) return null;
      if (!key.crop) return { frame: output, cropped: null };
      return { frame: createGeometryFrame(base, key), cropped: output };
    }

    function installGeometryPlanes(key, planes, { memo = true } = {}) {
      state.originalImageData = planes.frame;
      state.croppedImageData = planes.cropped;
      state.cropRegion = key.crop ? { ...key.crop } : null;
      if (memo) geometryMemo.set(planes.cropped || planes.frame, key);
    }

    function holdGeometryBusy(job) {
      if (geometryBusyOwner || document.body.dataset.studioBusy) return;
      geometryBusyOwner = job;
      document.body.dataset.studioBusy = 'true';
      studioWorkspace?.sync();
    }

    function releaseGeometryBusy(job) {
      if (!job || geometryBusyOwner !== job) return;
      geometryBusyOwner = null;
      delete document.body.dataset.studioBusy;
      studioWorkspace?.sync();
    }

    function endGeometryJob(job) {
      if (geometryJob === job) {
        geometryJob = null;
        state.geometryPending = false;
      }
      releaseGeometryBusy(job);
    }

    // Supersedes a pending build: its later bands are skipped and its result
    // is dropped. Undo, redo, file switches and new edits call this.
    function cancelGeometryJob({ keepInterim = false } = {}) {
      geometryToken++;
      const job = geometryJob;
      if (job) {
        endGeometryJob(job);
        job.finish(false);
      }
      if (!keepInterim) clearInterimGeometryDisplay();
    }

    // Resolves false when a build the caller waited for was superseded (a
    // newer edit, an undo) or failed: its own follow-up owns the conversion.
    async function whenGeometrySettled() {
      let installed = true;
      while (geometryJob) installed = (await geometryJob.done) && installed;
      return installed;
    }

    // A read of the working planes while a build is pending sees the previous
    // geometry. Every such reader awaits the build; this counts the ones
    // that do not.
    function noteGeometryPixelRead(reader) {
      if (!geometryJob) return;
      geometryDiagnostics.pendingReads++;
      if (DEBUG_UI) console.error(`Geometry planes read while a build is pending: ${reader}`);
    }

    function startGeometryJob(base, key, adopted, refreshDisplay) {
      cancelGeometryJob({ keepInterim: true });
      const token = geometryToken;
      const generation = loadGeneration;
      let finish;
      const job = { token, key, base, refreshDisplay, settled: false };
      job.done = new Promise(resolve => { finish = resolve; });
      job.finish = installed => {
        if (job.settled) return;
        job.settled = true;
        finish(installed);
      };
      geometryJob = job;
      state.geometryPending = true;
      state.geometryReady = job.done;
      holdGeometryBusy(job);
      const isCurrent = () => geometryJob === job && token === geometryToken && isCurrentLoad(generation);
      buildGeometryPlanes(base, key, adopted, isCurrent).then(planes => {
        if (!planes || !isCurrent()) return false;
        installGeometryPlanes(key, planes, { memo: !adopted || adopted.exact });
        if (job.refreshDisplay) displayNegative(state.croppedImageData || state.originalImageData);
        return true;
      }).catch(error => {
        console.error('Geometry build failed:', error);
        return false;
      }).then(installed => {
        endGeometryJob(job);
        job.finish(installed);
      });
      return job.done;
    }

    // Builds (or keeps) the planes for state.rotationAngle / state.mirrored and
    // `cropRegion`, which is sanitised against the frame at once. Resolves true
    // when those planes are installed and still current.
    function applyGeometryFromBase({ cropRegion = state.cropRegion, refreshDisplay = false } = {}) {
      const base = state.loadedBaseImageData || state.originalImageData;
      if (!base || isGeometryFrame(base)) {
        cancelGeometryJob();
        pendingImportRotation = null;
        state.cropRegion = null;
        state.croppedImageData = null;
        return Promise.resolve(false);
      }
      const key = geometryKeyFor(base, { rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion });
      state.cropRegion = key.crop ? { ...key.crop } : null;
      if (geometryJob && geometryJob.base === base && sameGeometryKey(geometryJob.key, key)) {
        pendingImportRotation = null;
        if (refreshDisplay) geometryJob.refreshDisplay = true;
        return geometryJob.done;
      }
      if (sameGeometryKey(key, installedGeometryKey())) {
        cancelGeometryJob();
        pendingImportRotation = null;
        if (refreshDisplay) displayNegative(state.croppedImageData || state.originalImageData);
        return Promise.resolve(true);
      }
      if (!key.angle && !key.mirrored && !key.crop) {
        // No geometry: the base is the working image.
        cancelGeometryJob();
        pendingImportRotation = null;
        installGeometryPlanes(key, { frame: base, cropped: null });
        if (refreshDisplay) displayNegative(base);
        return Promise.resolve(true);
      }
      return startGeometryJob(base, key, takeAdoptedRotation(base, key.angle), refreshDisplay);
    }

    // Runs `then` once the planes an edit asked for are installed, unless a
    // newer edit, an undo or another photo superseded it.
    function afterGeometry(ready, then) {
      const generation = loadGeneration;
      const token = geometryToken;
      const isCurrent = () => isCurrentLoad(generation) && token === geometryToken;
      return ready.then(installed => {
        if (!installed || !isCurrent()) return false;
        return then(isCurrent);
      }).catch(error => console.error('Geometry edit failed:', error));
    }

    // Exactly downsampleImageDataForMaxPixels(the whole working frame,
    // maxPixels), without building that frame when it is not kept.
    function renderFrameSample(maxPixels, { base = state.loadedBaseImageData, rotationAngle = state.rotationAngle, mirrored = state.mirrored } = {}) {
      const frame = state.originalImageData;
      // The installed working frame, when it has pixels and is this geometry,
      // is what HEAD sampled (for 8-bit sources it may be the Auto Frame
      // worker's canvas rotation, which this thread could not rebuild).
      const current = !state.geometryPending && base === (state.loadedBaseImageData || null)
        && effectiveGeometryAngle(rotationAngle) === effectiveGeometryAngle(state.rotationAngle)
        && Boolean(mirrored) === Boolean(state.mirrored);
      if (frame && !isGeometryFrame(frame) && !frame.released && (current || !base)) {
        return downsampleImageDataForMaxPixels(frame, maxPixels) || frame;
      }
      const key = base ? geometryKeyFor(base, { rotationAngle, mirrored }) : null;
      if (!key) return null;
      const total = key.frameWidth * key.frameHeight;
      const step = total > maxPixels ? Math.ceil(Math.sqrt(total / maxPixels)) : 1;
      const plan = geometryPlanFor(base, key, { crop: null, step });
      if (plan) return renderGeometry(base, plan);
      const full = renderGeometryFrame(base, key);
      return downsampleImageDataForMaxPixels(full, maxPixels) || full;
    }

    // The whole working frame's pixels for the rare reader that needs them
    // (built in the pool, not kept in state).
    async function geometryFramePixels() {
      await whenGeometrySettled();
      const frame = state.originalImageData;
      if (!frame || !isGeometryFrame(frame)) return frame;
      const { base, key } = frame.__geometryFrame;
      if (frame.__geometryFrame.pixels) return frame.__geometryFrame.pixels;
      const plan = geometryPlanFor(base, key, { crop: null });
      if (!plan) return renderGeometryFrame(base, key);
      const generation = loadGeneration;
      return geometryPool.render(base, plan, {
        isCurrent: () => isCurrentLoad(generation) && state.originalImageData === frame, maxInFlight: interactiveGeometryBands(plan)
      });
    }

    // While a rotate or mirror builds, the current display is turned or
    // flipped with CSS: a pure permutation of the pixels on screen, UI only
    // (no measurement reads it). The first paint of the new planes removes it.
    // Edits made before that paint compose: the state is rotate(t) scaleX(s).
    function interimGeometryCss() {
      return interimGeometry ? interimGeometry.css : '';
    }

    function showInterimGeometryDisplay({ rotate = 0, mirror = false } = {}) {
      const width = parseFloat(canvasTransformWrapper.style.width) || canvasTransformWrapper.offsetWidth || 0;
      const height = parseFloat(canvasTransformWrapper.style.height) || canvasTransformWrapper.offsetHeight || 0;
      if (!geometryJob || !width || !height) return;
      let turn = interimGeometry?.turn || 0;
      let flip = interimGeometry?.flip || 1;
      // Mirroring after a turn t equals turning by -t after the mirror.
      if (mirror) { turn = -turn; flip = -flip; }
      turn = normalizeAngleDegrees(turn + rotate);
      const quarter = Math.abs(turn) === 90;
      const visualWidth = quarter ? height : width;
      const visualHeight = quarter ? width : height;
      const maxWidth = Math.max(1, canvasContainer.clientWidth - 20);
      const maxHeight = Math.max(1, canvasContainer.clientHeight - 20);
      let scale = Math.min(maxWidth / visualWidth, maxHeight / visualHeight);
      // A picture shown at its natural size stays at that size.
      if (width < maxWidth - 1 && height < maxHeight - 1) scale = Math.min(scale, 1);
      const css = `translate(${width / 2}px, ${height / 2}px) rotate(${turn}deg) scale(${scale}) scaleX(${flip}) translate(${-width / 2}px, ${-height / 2}px)`;
      interimGeometry = { key: geometryJob.key, turn, flip, css };
      applyZoomPanTransform();
    }

    function clearInterimGeometryDisplay() {
      if (!interimGeometry) return;
      interimGeometry = null;
      applyZoomPanTransform();
    }

    // Called after every paint of the main canvases.
    function settleInterimGeometryDisplay() {
      if (interimGeometry && !geometryJob && sameGeometryKey(interimGeometry.key, installedGeometryKey())) {
        clearInterimGeometryDisplay();
      }
    }

    // Apply Crop draws on the current frame rotated once more by the draft
    // angle (canvas D). The frame derived from the base by the total angle (F)
    // shows the same picture about the same centre on a canvas of its own
    // size, so the drawn rectangle maps to F by a pure translation.
    function mapDraftRectToFrame(rect, draftFrame, frame) {
      if (!rect || !draftFrame || !frame) return null;
      return sanitizeCropRegionForImage({
        left: rect.left + (frame.width - draftFrame.width) / 2,
        top: rect.top + (frame.height - draftFrame.height) / 2,
        width: rect.width,
        height: rect.height
      }, frame);
    }

    // rotationAngle is measured on the unmirrored base, and the geometry chain
    // is base -> rotate -> mirror -> crop. Mirroring reverses the sense of a
    // rotation (R(f) after M equals M after R(-f)), so an angle the user applies
    // to a mirrored view must be recorded with the opposite sign; otherwise a
    // rebuild — a file switch, an undo, or batch export — turns the frame the
    // wrong way.
    function storedRotationDelta(angle) {
      return state.mirrored ? -angle : angle;
    }

    function applyRotation(angle) {
      if (!state.originalImageData || !Number.isFinite(angle) || angle === 0) return;

      const normalizedAngle = normalizeAngleDegrees(Number(angle) || 0);
      if (Math.abs(normalizedAngle) < 0.001) return;

      if (state.cropping && rotateCropDraftBy(normalizedAngle)) return;

      pushUndo('rotation');
      // The new frame is the base rotated once by the total angle (#244), not
      // the current frame rotated again: restore and batch export build it
      // that way, so single export now matches them.
      const base = state.loadedBaseImageData || state.originalImageData;
      // The scalars, not the installed planes (which lag behind a pending
      // build), say which frame the crop is on.
      const sourceFrame = geometryFrameSize(base, state.rotationAngle);
      const sourceCrop = state.cropRegion ? { ...state.cropRegion } : null;
      state.rotationAngle = normalizeAngleDegrees((state.rotationAngle || 0) + storedRotationDelta(normalizedAngle));
      const frame = geometryFrameSize(base, state.rotationAngle);
      const mappedCrop = sourceCrop ? mapCropRegionAfterRotation(
        sourceCrop, sourceFrame.width, sourceFrame.height, frame.width, frame.height, normalizedAngle
      ) : null;
      const ready = applyGeometryFromBase({ cropRegion: mappedCrop });
      invalidateProcessedPipelineState();
      resetZoomPan();
      // The new framing shows at once; the exact planes follow from the pool.
      showInterimGeometryDisplay({ rotate: normalizedAngle });
      markCurrentFileDirty();
      return afterGeometry(ready, async isCurrent => {
        setStep2Mode(suggestStep2Mode());
        if (state.currentStep >= 3) {
          await convertAfterGeometryEdit(isCurrent);
        } else {
          displayNegative(state.croppedImageData || state.originalImageData);
          updateCanvasVisibility();
        }
      });
    }

    // A conversion already running belongs to the previous geometry: let it
    // finish (it discards itself) and convert the new planes.
    async function convertAfterGeometryEdit(isCurrent, options = {}) {
      if (processNegativeInFlight) await processNegativeInFlight;
      if (isCurrent()) await processNegative(options);
    }

    // base -> rotation -> mirror -> crop. Mirror used to be applied straight to
    // the working buffer and recorded nowhere, so it was silently dropped by the
    // next crop, by a file switch, and by every batch export.
    function updateMirrorButtonState() {
      const mirrorBtn = document.getElementById('mirrorBtn');
      if (!mirrorBtn) return;
      const on = Boolean(state.mirrored);
      mirrorBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      mirrorBtn.classList.toggle('active', on);
    }

    function rebuildGeometryFromBase() {
      if (!(state.loadedBaseImageData || state.originalImageData)) return Promise.resolve(false);
      return applyGeometryFromBase();
    }

    function applyMirror() {
      if (!state.originalImageData) return;

      pushUndo('mirror');
      state.mirrored = !state.mirrored;
      updateMirrorButtonState();
      // The crop box was drawn on the pre-mirror view, so flip it to keep the
      // framed area over the same part of the picture.
      if (state.cropRegion) {
        const frameWidth = geometryFrameSize(state.loadedBaseImageData || state.originalImageData, state.rotationAngle).width;
        state.cropRegion = {
          ...state.cropRegion,
          left: frameWidth - (state.cropRegion.left + state.cropRegion.width)
        };
      }
      const ready = applyGeometryFromBase();

      invalidateProcessedPipelineState();
      resetZoomPan();
      showInterimGeometryDisplay({ mirror: true });
      markCurrentFileDirty();
      return afterGeometry(ready, async isCurrent => {
        if (state.currentStep >= 3) {
          await convertAfterGeometryEdit(isCurrent);
        } else {
          const newImageData = state.croppedImageData || state.originalImageData;
          displayNegative(newImageData);
          updateCanvasVisibility();
          renderHistogram(newImageData);
        }
      });
    }

    document.getElementById('rotateLeftBtn').addEventListener('click', () => {
      if (state.cropping && rotateCropDraftBy(-90)) return;
      applyRotation(-90);
    });
    document.getElementById('rotateRightBtn').addEventListener('click', () => {
      if (state.cropping && rotateCropDraftBy(90)) return;
      applyRotation(90);
    });
    document.getElementById('mirrorBtn').addEventListener('click', () => {
      if (state.cropping) return;
      applyMirror();
    });

    async function applyAutoFrameToCurrent() {
      if (state.currentStep !== 1) return;
      const source = state.loadedBaseImageData || state.originalImageData;
      if (!source) return;

      const button = document.getElementById('autoFrameBtn');
      const previousText = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = i18n[currentLang].autoFrameAnalyzing || 'Analyzing frame borders...';
      }

      try {
        const result = await detectFrameAndRotation(source);
        if (state.currentStep !== 1 || (state.loadedBaseImageData || state.originalImageData) !== source) return;
        if (!result) {
          void appAlert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          return;
        }

        if (result.requiresReview) {
          void appAlert(studioWorkspace.text(result.diagnostics?.incomplete ? 'frameIncomplete' : 'frameReview'));
          return;
        }

        const detail = formatAutoFrameDetail(result);
        const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
        let applied = false;

        if (result.confidenceLevel === 'low') {
          if (lowBehavior === 'rotateOnly') {
            if (Math.abs(result.angle) > 0.05 || state.autoFrame.rotate180Default) {
              applied = await applyAutoFrameRotationOnly(result, source);
              if (applied) {
                const template = i18n[currentLang].autoFrameRotateOnlyApplied
                  || 'Low confidence: applied rotation only ({angle}°).';
                void appAlert(template.replace('{angle}', String(result.angle)));
              }
            } else {
              void appAlert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
            }
          } else if (lowBehavior === 'ignore') {
            void appAlert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          } else {
            applied = await applyAutoFrameResult(result, source);
            if (applied) {
              const template = i18n[currentLang].autoFrameLowConfidenceApplied
                || 'Low confidence: crop applied. Please verify the result (confidence {confidence}).';
              const confidenceText = Number.isFinite(result.confidence) ? result.confidence.toFixed(2) : '0.00';
              void appAlert(template.replace('{confidence}', confidenceText));
            }
          }
        } else if (result.confidenceLevel === 'high' && state.autoFrame.autoApplyHighConfidence) {
          applied = await applyAutoFrameResult(result, source);
        } else {
          const title = i18n[currentLang].autoFramePreviewTitle || 'Reliable frame detected. Apply auto rotation and crop?';
          const confirmed = await appConfirm(`${title}\n${detail}`);
          // Unlike window.confirm, this dialog does not freeze the page: a
          // background full-resolution decode can land while it is open and
          // replace the base the detection ran against.
          if (confirmed && (state.loadedBaseImageData || state.originalImageData) === source) {
            applied = await applyAutoFrameResult(result, source);
          }
        }

        if (applied) {
          markCurrentFileDirty();
        } else {
          state.autoFrame.lastDiagnostics = {
            ...state.autoFrame.lastDiagnostics,
            confidence: result.confidence,
            detectedFormat: result.detectedFormat || 'unknown',
            method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
            confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
            rotateOnly: false,
            appliedMode: 'none',
            lowConfidenceApplied: false
          };
          updateAutoFrameDiagnosticsUI();
        }
      } finally {
        if (button) {
          button.textContent = previousText || (i18n[currentLang].autoFrame || 'Auto Frame');
          updateAutoFrameButtons();
        }
      }
    }

    async function applyAutoFrameToSelected() {
      if (state.currentStep !== 1) return;
      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) return;

      const button = document.getElementById('autoFrameSelectedBtn');
      const previousText = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = i18n[currentLang].autoFrameAnalyzing || 'Analyzing frame borders...';
      }

      let successCount = 0;
      let lowAppliedCount = 0;
      let rotateOnlyCount = 0;
      let failCount = 0;
      showBatchProgress(true);

      try {
        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
          updateBatchProgress(i + 1, selectedItems.length, item.file.name);

          try {
            const imageData = await loadFileToImageData(item.file, { filmStats: !item.settings });
            const result = await detectFrameAndRotation(imageData);
            if (!result || result.requiresReview) {
              failCount++;
              continue;
            }

            const existing = item.settings ? cloneSettings(item.settings) : settleImportFilmType(item, createDefaultSettings(imageData, item));
            const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
            const effectiveAngle = autoFrameEffectiveAngle(result.angle);
            const frame = result.rotatedImageData || imageData;
            const effectiveCropRegion = !result.cropRegion
              ? null
              : (state.autoFrame.rotate180Default
                ? rotate180CropRegion(result.cropRegion, frame.width, frame.height)
                : { ...result.cropRegion });
            let appliedMode = 'none';
            // detectFrameAndRotation ran on the unmirrored decode, so the crop
            // it produced is in unmirrored coordinates — matching what
            // applyAutoFrameResult does for the single-file path.
            existing.mirrored = false;
            if (result.confidenceLevel === 'low') {
              if (lowBehavior === 'rotateOnly' && (Math.abs(result.angle) > 0.05 || state.autoFrame.rotate180Default)) {
                existing.rotationAngle = effectiveAngle;
                existing.cropRegion = null;
                rotateOnlyCount++;
                appliedMode = 'rotateOnly';
              } else if (lowBehavior === 'suggest') {
                existing.rotationAngle = effectiveAngle;
                existing.cropRegion = effectiveCropRegion;
                successCount++;
                lowAppliedCount++;
                appliedMode = 'crop';
              } else {
                failCount++;
                continue;
              }
            } else {
              existing.rotationAngle = effectiveAngle;
              existing.cropRegion = effectiveCropRegion;
              successCount++;
              appliedMode = 'crop';
            }

            existing.autoFrameMeta = {
              ...existing.autoFrameMeta,
              ...(canAutoApplyImportFrame(result, state.autoFrame) ? { imageArea: imageAreaFromDetection(result, imageData), analysisNeedsReview: false } : {}),
              confidence: result.confidence,
              confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
              detectedFormat: result.detectedFormat || 'unknown',
              method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
              rotateOnly: appliedMode === 'rotateOnly',
              appliedMode,
              lowConfidenceApplied: result.confidenceLevel === 'low' && appliedMode === 'crop',
              detectedAt: Date.now()
            };
            item.settings = existing;
            item.isDirty = false;
          } catch (err) {
            console.error('Auto frame batch item failed:', item.file.name, err);
            failCount++;
          }
        }
      } finally {
        showBatchProgress(false);
        if (button) {
          button.textContent = previousText || (i18n[currentLang].autoFrameSelected || 'Auto Frame Selected');
          updateAutoFrameButtons();
        }
      }

      const currentItem = getCurrentQueueItem();
      if (currentItem && currentItem.settings && currentItem.selected) {
        restoreSettings(currentItem.settings);
      }

      updateFileListUI();
      const template = i18n[currentLang].autoFrameBatchDoneExtended
        || i18n[currentLang].autoFrameBatchDone
        || 'Auto frame finished: {success} succeeded, {failed} failed.';
      void appAlert(template
        .replace('{success}', String(successCount))
        .replace('{lowApplied}', String(lowAppliedCount))
        .replace('{rotated}', String(rotateOnlyCount))
        .replace('{failed}', String(failCount)));
    }

    async function runStudioAutoFrame(selected) {
      if (document.body.dataset.studioBusy || state.cropping || isDesktopBatchExportLocked() || !state.originalImageData) return;
      const generation = loadGeneration;
      studioAutoFrameRunning = true;
      document.body.dataset.studioBusy = 'true';
      studioWorkspace?.sync();
      try {
        if (processNegativeInFlight) await processNegativeInFlight;
        if (!isCurrentLoad(generation)) return;
        persistCurrentFileSettings({ silent: true, force: true });
        pushUndo('autoFrame');
        // 旧 Step 1 の取景処理を内部で使い、完了後は同じ写真の調色へ戻す。
        goToStep(1);
        await (selected ? applyAutoFrameToSelected() : applyAutoFrameToCurrent());
        if (isCurrentLoad(generation) && state.originalImageData) await processNegative();
      } finally {
        studioAutoFrameRunning = false;
        if (isCurrentLoad(generation)) {
          delete document.body.dataset.studioBusy;
          updateAutoFrameButtons();
          studioWorkspace?.sync();
        }
      }
    }

    document.getElementById('autoFrameBtn').addEventListener('click', () => {
      void runStudioAutoFrame(false);
    });

    document.getElementById('autoFrameSelectedBtn').addEventListener('click', () => {
      void runStudioAutoFrame(true);
    });

    // ===========================================
    // Before / After (toggle to preview original)
    // ===========================================
    if (beforeAfterBtn) {
      beforeAfterBtn.setAttribute('aria-pressed', 'false');
      beforeAfterBtn.addEventListener('click', (event) => {
        if (beforeAfterBtn.disabled) return;
        event.preventDefault();
        toggleBeforeAfter('button');
      });
    }

    if (sprocketPreviewBtn) {
      sprocketPreviewBtn.setAttribute('aria-pressed', 'false');
      sprocketPreviewBtn.addEventListener('click', (event) => {
        if (sprocketPreviewBtn.disabled) return;
        event.preventDefault();
        setSprocketPreviewEnabled(!state.sprocketPreviewEnabled);
      });
    }

    Object.values(SPROCKET_EDGE_CONTROL_IDS).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const eventName = (
        el.tagName === 'SELECT'
        || el.type === 'checkbox'
        || el.type === 'color'
      ) ? 'change' : 'input';
      el.addEventListener(eventName, handleSprocketEdgeSettingsChange);
    });
    syncSprocketEdgeSettingsUI();

    // Keyboard: SP3000 console keys. c/m/y/d = +1 step, Shift+key = -1,
    // n = reset all four channels. Guarded like the other global shortcuts.
    document.addEventListener('keydown', (event) => {
      if (!stateReady || state.currentStep < 3) return;
      // A photo being prepared (e.g. its provisional render while detection
      // runs) is not editable yet; the panel is inert then too.
      if (document.body.dataset.studioBusy) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (state.cropping || state.samplingMode) return;
      const key = event.key.toLowerCase();
      const channelByKey = { c: 'cyan', m: 'magenta', y: 'yellow', d: 'density' };
      if (channelByKey[key]) {
        event.preventDefault();
        nudgeConsoleChannel(channelByKey[key], event.shiftKey ? -1 : 1);
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        resetConsoleChannels();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (event.target === beforeAfterBtn) return;
      if (!canActivateBeforeAfter()) return;
      event.preventDefault();
      toggleBeforeAfter('shortcut');
    });

    // Keyboard zoom shortcuts
    document.addEventListener('keydown', (event) => {
      if (document.body.dataset.photoSwitching === 'true') return;
      if (isEditableTarget(event.target)) return;
      // Cmd/Ctrl +, - and 0 are the browser's own page zoom. Claiming them
      // leaves the user with no keyboard way to resize the page.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.cropping || state.samplingMode) return;
      if (!state.originalImageData) return;
      const key = event.key;
      if (key === '+' || key === '=') {
        event.preventDefault();
        const containerRect = canvasContainer.getBoundingClientRect();
        const cx = containerRect.left + containerRect.width / 2;
        const cy = containerRect.top + containerRect.height / 2;
        zoomAtPoint(state.zoomLevel * ZOOM_BUTTON_FACTOR, cx, cy);
      } else if (key === '-') {
        event.preventDefault();
        const containerRect = canvasContainer.getBoundingClientRect();
        const cx = containerRect.left + containerRect.width / 2;
        const cy = containerRect.top + containerRect.height / 2;
        zoomAtPoint(state.zoomLevel / ZOOM_BUTTON_FACTOR, cx, cy);
      } else if (key === '0') {
        event.preventDefault();
        resetZoomPan();
      }
    });

    // Undo/Redo keyboard shortcuts
    document.addEventListener('keydown', (event) => {
      if (isEditableTarget(event.target)) return;

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        event.preventDefault();
        performUndo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        performRedo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
        event.preventDefault();
        performRedo();
        return;
      }
    });

    // Undo/Redo button click handlers
    document.getElementById('undoBtn').addEventListener('click', () => performUndo());
    document.getElementById('redoBtn').addEventListener('click', () => performRedo());

    // Escape key handler
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      // Handled before isEditableTarget so Escape still closes the popup while
      // typing in its textarea (but not mid-IME-composition).
      const feedbackPopupOverlay = document.getElementById('feedbackPopupOverlay');
      if (feedbackPopupOverlay?.classList.contains('visible')) {
        if (event.isComposing) return;
        event.preventDefault();
        closeFeedbackPopup();
        return;
      }
      if (isEditableTarget(event.target)) return;

      if (state.beforeAfterActive) {
        event.preventDefault();
        exitBeforeAfter();
        return;
      }
      if (state.cropping) {
        event.preventDefault();
        document.getElementById('cancelCropBtn').click();
        showToast(getLocalizedText('cancelledCrop', 'Crop cancelled'));
        return;
      }
      if (state.samplingMode) {
        event.preventDefault();
        state.samplingMode = null;
        updateSamplingModeUI();
        updateBeforeAfterButtonState();
        showToast(getLocalizedText('cancelledSampling', 'Exited sampling mode'));
        return;
      }
      if (dustDrawing) {
        event.preventDefault();
        dustDrawing = false;
        dustBrushPoints = [];
        if (state.dustRemoval.showMask) renderDustMaskOverlay();
        showToast(getLocalizedText('cancelledBrush', 'Brush cancelled'));
        return;
      }
    });

    // Zoom control buttons
    document.getElementById('zoomInBtn').addEventListener('click', () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const cx = containerRect.left + containerRect.width / 2;
      const cy = containerRect.top + containerRect.height / 2;
      zoomAtPoint(state.zoomLevel * ZOOM_BUTTON_FACTOR, cx, cy);
    });

    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const cx = containerRect.left + containerRect.width / 2;
      const cy = containerRect.top + containerRect.height / 2;
      zoomAtPoint(state.zoomLevel / ZOOM_BUTTON_FACTOR, cx, cy);
    });

    document.getElementById('zoomResetBtn').addEventListener('click', () => {
      resetZoomPan();
    });

    // ===========================================
    // Cropping
    // ===========================================
    const cropOverlay = document.getElementById('cropOverlay');
    const cropBtn = document.getElementById('cropBtn');
    const applyCropBtn = document.getElementById('applyCropBtn');
    const cancelCropBtn = document.getElementById('cancelCropBtn');
    const straightenGuideLine = document.getElementById('straightenGuideLine');
    const cropModeHint = document.getElementById('cropModeHint');
    const cropModeHintTitle = document.getElementById('cropModeHintTitle');
    const cropModeHintBody = document.getElementById('cropModeHintBody');
    const CROP_HIT_TARGET_PX = 14;
    const CROP_EDGE_TARGET_PX = 10;
    const CROP_MIN_DISPLAY_PX = 28;
    const CROP_PREVIEW_MAX_PIXELS = 700_000;
    const STRAIGHTEN_LINE_MIN_DISPLAY_PX = 32;
    let activeCropPointerId = null;
    let cropPreviewRenderFrame = null;
    let cropHintTimer = null;

    // Aspect-ratio lock. The choice is remembered across photos so a roll is
    // cropped to one format. The box orientation follows the frame; the
    // remembered orientation only decides square frames (preferredCropOrientation).
    const CROP_RATIO_STORAGE_KEY = 'nc_crop_ratio_v1';
    const cropRatioField = document.getElementById('cropRatioField');
    const cropRatioSelect = document.getElementById('cropRatioSelect');
    const cropRatioFlipBtn = document.getElementById('cropRatioFlipBtn');
    let cropRatioChoice = { ...DEFAULT_CROP_RATIO_CHOICE };

    function getCropRatioLock() {
      const draft = state.cropDraft;
      if (!draft || draft.analysisOnly) return null;
      const preset = findCropRatioPreset(cropRatioChoice.id);
      return preset.ratio ? { ratio: preset.ratio, orientation: draft.ratioOrientation } : null;
    }

    // Re-shapes the draft box to the locked ratio. The box keeps the
    // orientation it already has (a rotated portrait frame gets a portrait
    // box) unless `orientation` forces one, as the flip button does.
    function fitCropDraftToRatio(orientation = null) {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      if (!draft?.rect || !imageData) return;
      draft.ratioOrientation = orientation || preferredCropOrientation(draft.rect, draft.ratioOrientation);
      const lock = getCropRatioLock();
      if (lock) {
        draft.rect = fitRectToRatio(draft.rect, lock.ratio, imageData, { orientation: lock.orientation, minSize: getCropMinSize(imageData) });
      }
      updateCropRatioUi();
    }

    function updateCropRatioUi() {
      const visible = state.cropping && Boolean(state.cropDraft) && !state.cropDraft.analysisOnly;
      cropRatioField.style.display = visible ? 'inline-flex' : 'none';
      cropRatioFlipBtn.style.display = visible ? 'inline-flex' : 'none';
      if (!visible) return;
      cropRatioSelect.value = cropRatioChoice.id;
      const lock = getCropRatioLock();
      cropRatioFlipBtn.disabled = !lock || lock.ratio === 1;
      cropRatioFlipBtn.classList.toggle('portrait', Boolean(lock) && lock.orientation === 'portrait');
    }

    function setCropRatioChoice(id, orientation = null) {
      cropRatioChoice = { id: findCropRatioPreset(id).id, orientation: cropRatioChoice.orientation };
      fitCropDraftToRatio(orientation);
      // The orientation the box ended up with is what a square frame reuses.
      cropRatioChoice.orientation = state.cropDraft?.ratioOrientation || cropRatioChoice.orientation;
      safeStorageSet(CROP_RATIO_STORAGE_KEY, serializeCropRatioChoice(cropRatioChoice));
      updateCropOverlayFromDraft();
    }

    cropRatioSelect.addEventListener('change', () => setCropRatioChoice(cropRatioSelect.value));
    cropRatioFlipBtn.addEventListener('click', () => {
      const lock = getCropRatioLock();
      if (lock) setCropRatioChoice(cropRatioChoice.id, flipOrientation(lock.orientation));
    });

    cropBtn.addEventListener('click', () => {
      beginCropMode();
    });

    function showCropModeHint(options = {}) {
      if (!cropModeHint || !cropModeHintTitle || !cropModeHintBody) return;
      const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 4200;

      cropModeHintTitle.textContent = getLocalizedText('cropHintTitle', 'Crop and straighten');
      cropModeHintBody.textContent = getLocalizedText(
        'cropHintBody',
        'Drag inside the box to move it, or drag edges/corners to resize. Hold Command/Ctrl and draw a line to straighten. Lock a film ratio (135, 120, 4×5…) in the toolbar.'
      );

      if (cropHintTimer) clearTimeout(cropHintTimer);
      cropModeHint.style.display = 'flex';
      requestAnimationFrame(() => cropModeHint.classList.add('visible'));
      cropHintTimer = setTimeout(() => hideCropModeHint(), durationMs);
    }

    function hideCropModeHint() {
      if (!cropModeHint) return;
      if (cropHintTimer) {
        clearTimeout(cropHintTimer);
        cropHintTimer = null;
      }
      cropModeHint.classList.remove('visible');
      cropModeHint.addEventListener('transitionend', () => {
        if (!cropModeHint.classList.contains('visible')) {
          cropModeHint.style.display = 'none';
        }
      }, { once: true });
    }

    function getCropDisplayScale() {
      // Pre-transform CSS size of the canvas (unaffected by zoom)
      const cssW = parseFloat(canvas.style.width) || canvas.width;
      const cssH = parseFloat(canvas.style.height) || canvas.height;
      return {
        scaleX: canvas.width / cssW,
        scaleY: canvas.height / cssH,
        cssW,
        cssH
      };
    }

    function screenToWrapperLocal(clientX, clientY) {
      const wrapperRect = canvasTransformWrapper.getBoundingClientRect();
      const z = state.zoomLevel;
      return {
        x: (clientX - wrapperRect.left) / z,
        y: (clientY - wrapperRect.top) / z
      };
    }

    function clampCropValue(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function scaleCropRect(rect, scaleX, scaleY) {
      if (!rect) return null;
      return {
        left: rect.left * scaleX,
        top: rect.top * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY
      };
    }

    function buildCropPreviewSourceImageData(imageData) {
      return downsampleImageDataForMaxPixels(imageData, CROP_PREVIEW_MAX_PIXELS) || imageData;
    }

    function getDefaultCropRect(imageData) {
      if (!imageData) return null;

      const existing = sanitizeCropRegionForImage(state.cropRegion, imageData);
      if (existing) return existing;

      const marginX = Math.floor(imageData.width * 0.05);
      const marginY = Math.floor(imageData.height * 0.05);
      return sanitizeDraftCropRect({
        left: marginX,
        top: marginY,
        width: imageData.width - marginX * 2,
        height: imageData.height - marginY * 2
      }, imageData);
    }

    function sanitizeDraftCropRect(rect, imageData, options = {}) {
      if (!rect || !imageData) return null;

      const scale = getCropDisplayScale();
      const minWidth = options.minWidth || Math.max(1, Math.min(imageData.width, CROP_MIN_DISPLAY_PX * scale.scaleX));
      const minHeight = options.minHeight || Math.max(1, Math.min(imageData.height, CROP_MIN_DISPLAY_PX * scale.scaleY));

      let left = Number(rect.left);
      let top = Number(rect.top);
      let width = Number(rect.width);
      let height = Number(rect.height);

      if (!Number.isFinite(left)) left = 0;
      if (!Number.isFinite(top)) top = 0;
      if (!Number.isFinite(width)) width = imageData.width;
      if (!Number.isFinite(height)) height = imageData.height;

      if (width < 0) {
        left += width;
        width = Math.abs(width);
      }
      if (height < 0) {
        top += height;
        height = Math.abs(height);
      }

      width = clampCropValue(width, minWidth, imageData.width);
      height = clampCropValue(height, minHeight, imageData.height);
      left = clampCropValue(left, 0, Math.max(0, imageData.width - width));
      top = clampCropValue(top, 0, Math.max(0, imageData.height - height));

      return { left, top, width, height };
    }

    function createCropDraft(sourceImageData) {
      if (!sourceImageData) return null;
      // A sample of the whole frame; beside a crop the frame is not kept, so
      // the sample is built from the base (#244).
      const previewSourceImageData = sourceImageData === state.originalImageData
        ? renderFrameSample(CROP_PREVIEW_MAX_PIXELS)
        : buildCropPreviewSourceImageData(sourceImageData);
      const initialSourceRect = getDefaultCropRect(sourceImageData);
      if (!previewSourceImageData || !initialSourceRect) return null;

      const previewRect = scaleCropRect(
        initialSourceRect,
        previewSourceImageData.width / sourceImageData.width,
        previewSourceImageData.height / sourceImageData.height
      );

      return {
        sourceImageData,
        previewSourceImageData,
        rotatedImageData: previewSourceImageData,
        rect: previewRect,
        interaction: null,
        ratioOrientation: cropRatioChoice.orientation,
        rotationBase: 0,
        straightenAngle: 0,
        straightenLineAngles: []
      };
    }

    function getCropDraftTotalAngle() {
      const draft = state.cropDraft;
      if (!draft) return 0;
      return normalizeAngleDegrees((draft.rotationBase || 0) + (draft.straightenAngle || 0));
    }

    function decomposeCropDraftAngle(angle) {
      const total = normalizeAngleDegrees(Number(angle) || 0);
      let rotationBase = Math.round(total / 90) * 90;
      rotationBase = normalizeAngleDegrees(rotationBase);
      let straightenAngle = normalizeAngleDegrees(total - rotationBase);

      if (straightenAngle > 45) {
        rotationBase = normalizeAngleDegrees(rotationBase + 90);
        straightenAngle = normalizeAngleDegrees(total - rotationBase);
      } else if (straightenAngle < -45) {
        rotationBase = normalizeAngleDegrees(rotationBase - 90);
        straightenAngle = normalizeAngleDegrees(total - rotationBase);
      }

      return {
        rotationBase,
        straightenAngle: clampCropValue(straightenAngle, -45, 45)
      };
    }

    function setCropDraftTotalAngle(angle, options = {}) {
      const draft = state.cropDraft;
      if (!draft) return false;

      const next = decomposeCropDraftAngle(angle);
      draft.rotationBase = next.rotationBase;
      draft.straightenAngle = next.straightenAngle;
      if (!options.keepLineSamples) draft.straightenLineAngles = [];
      scheduleCropDraftPreview({ preserveRect: true });
      return true;
    }

    function rotateCropDraftBy(angleDelta) {
      const draft = state.cropDraft;
      if (!draft) return false;

      draft.rotationBase = normalizeAngleDegrees((draft.rotationBase || 0) + (Number(angleDelta) || 0));
      draft.straightenLineAngles = [];
      scheduleCropDraftPreview({ preserveRect: true });
      return true;
    }

    function setCropActionUi(active) {
      cropBtn.style.display = active ? 'none' : 'inline-flex';
      applyCropBtn.style.display = active ? 'inline-flex' : 'none';
      cancelCropBtn.style.display = active ? 'inline-flex' : 'none';
      updateCropRatioUi();
      cropOverlay.style.display = active ? 'block' : 'none';
      canvasContainer.classList.toggle('crop-mode', active);
      canvasContainer.classList.toggle('straighten-line-mode', false);
      canvasContainer.style.touchAction = active ? 'none' : '';
      canvasContainer.style.cursor = active ? 'crosshair' : '';
      if (!active && straightenGuideLine) straightenGuideLine.style.display = 'none';

      const mirrorBtn = document.getElementById('mirrorBtn');
      const autoFrameBtn = document.getElementById('autoFrameBtn');
      const autoFrameSelectedBtn = document.getElementById('autoFrameSelectedBtn');
      if (mirrorBtn) mirrorBtn.disabled = active;
      if (autoFrameBtn) autoFrameBtn.disabled = active;
      if (autoFrameSelectedBtn) autoFrameSelectedBtn.disabled = active;
      ['zoomInBtn', 'zoomOutBtn', 'zoomResetBtn'].forEach(id => {
        document.getElementById(id).disabled = active;
      });
      updateSprocketControlsUI();
      studioWorkspace?.sync();
    }

    // The draft shows the whole frame: a pending geometry build finishes
    // first. Otherwise the draft opens in the click's own task, as before.
    function beginCropMode(options = {}) {
      if (state.geometryPending) return whenGeometrySettled().then(() => openCropMode(options));
      openCropMode(options);
      return Promise.resolve();
    }

    function openCropMode({ analysisOnly = false } = {}) {
      const sourceImageData = state.originalImageData;
      if (!sourceImageData || state.cropping) return;

      exitBeforeAfter();
      state.samplingMode = null;
      updateSamplingModeUI();
      if (state.sprocketPreviewEnabled) {
        setSprocketPreviewEnabled(false, { render: false });
      }
      if (cropPreviewRenderFrame) {
        cancelAnimationFrame(cropPreviewRenderFrame);
        cropPreviewRenderFrame = null;
      }

      resetZoomPan();
      state.cropping = true;
      state.croppingActive = false;
      state.cropStart = null;
      activeCropPointerId = null;
      cropRatioChoice = parseCropRatioChoice(safeStorageGet(CROP_RATIO_STORAGE_KEY));
      state.cropDraft = createCropDraft(sourceImageData);
      if (!state.cropDraft) {
        state.cropping = false;
        return;
      }
      state.cropDraft.analysisOnly = analysisOnly;
      if (analysisOnly) {
        const roi = resolveAnalysisRegion({ ...state, cropRegion: null, autoFrameMeta: state.autoFrame.lastDiagnostics }, state.loadedBaseImageData || sourceImageData);
        if (roi) state.cropDraft.rect = scaleCropRect(analysisPixelBounds(sourceImageData.width, sourceImageData.height, roi), state.cropDraft.previewSourceImageData.width / sourceImageData.width, state.cropDraft.previewSourceImageData.height / sourceImageData.height);
      }
      applyCropBtn.textContent = analysisOnly ? studioWorkspace.text('confirmAnalysis') : i18n[currentLang].applyCrop;

      setCropActionUi(true);
      renderCropDraftPreview({ preserveRect: false });
      showCropModeHint();
      if (analysisOnly) {
        document.getElementById('cropModeHintTitle').textContent = studioWorkspace.text('confirmAnalysis');
        document.getElementById('cropModeHintBody').textContent = studioWorkspace.text('analysisHint');
      }
      updateBeforeAfterButtonState();
    }

    function updateCropOverlayFromDraft() {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      if (!state.cropping || !draft || !imageData || !draft.rect) return;

      draft.rect = sanitizeDraftCropRect(draft.rect, imageData) || draft.rect;
      const { scaleX, scaleY } = getCropDisplayScale();
      cropOverlay.style.display = 'block';
      cropOverlay.style.left = (draft.rect.left / scaleX) + 'px';
      cropOverlay.style.top = (draft.rect.top / scaleY) + 'px';
      cropOverlay.style.width = (draft.rect.width / scaleX) + 'px';
      cropOverlay.style.height = (draft.rect.height / scaleY) + 'px';
    }

    function renderCropDraftPreview(options = {}) {
      const draft = state.cropDraft;
      if (!state.cropping || !draft || !draft.previewSourceImageData) return;

      const previousImage = draft.rotatedImageData;
      const previousRect = draft.rect;
      let normalizedRect = null;
      if (options.preserveRect && previousImage && previousRect) {
        normalizedRect = {
          left: previousRect.left / previousImage.width,
          top: previousRect.top / previousImage.height,
          width: previousRect.width / previousImage.width,
          height: previousRect.height / previousImage.height
        };
      }

      const angle = getCropDraftTotalAngle();
      const rotatedImageData = Math.abs(angle) < 0.001
        ? draft.previewSourceImageData
        : applyRotationToImageData(draft.previewSourceImageData, angle);
      if (!rotatedImageData) return;

      draft.rotatedImageData = rotatedImageData;
      displayNegative(rotatedImageData);
      canvas.style.display = 'block';
      glCanvas.style.display = 'none';

      if (normalizedRect) {
        draft.rect = sanitizeDraftCropRect({
          left: normalizedRect.left * rotatedImageData.width,
          top: normalizedRect.top * rotatedImageData.height,
          width: normalizedRect.width * rotatedImageData.width,
          height: normalizedRect.height * rotatedImageData.height
        }, rotatedImageData);
      } else {
        draft.rect = sanitizeDraftCropRect(draft.rect || getDefaultCropRect(rotatedImageData), rotatedImageData);
      }
      fitCropDraftToRatio();

      renderHistogram(rotatedImageData);
      updateCropOverlayFromDraft();
    }

    function scheduleCropDraftPreview(options = {}) {
      if (cropPreviewRenderFrame) cancelAnimationFrame(cropPreviewRenderFrame);
      cropPreviewRenderFrame = requestAnimationFrame(() => {
        cropPreviewRenderFrame = null;
        renderCropDraftPreview(options);
      });
    }

    function restoreDisplayAfterCropDraft() {
      const sourceImageData = state.croppedImageData || state.originalImageData;
      if (state.currentStep >= 3 && state.processedImageData) {
        // GPU 表示は CSS サイズだけを更新する。草稿用 2D 画布の寸法も戻す。
        setMainCanvasDimensions(state.processedImageData.width, state.processedImageData.height);
        updateCanvasVisibility();
        updatePreview();
        scheduleFullUpdate();
        return;
      }

      if (sourceImageData) {
        displayNegative(sourceImageData);
        updateCanvasVisibility();
        renderHistogram(sourceImageData);
      }
    }

    function exitCropMode(options = {}) {
      if (cropPreviewRenderFrame) {
        cancelAnimationFrame(cropPreviewRenderFrame);
        cropPreviewRenderFrame = null;
      }

      state.cropping = false;
      state.croppingActive = false;
      state.cropStart = null;
      state.cropDraft = null;
      activeCropPointerId = null;
      hideCropModeHint();
      setCropActionUi(false);
      updateBeforeAfterButtonState();

      if (options.restore) {
        restoreDisplayAfterCropDraft();
      }
    }

    function getCropPointerPosition(clientX, clientY) {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      if (!imageData) return null;

      const { scaleX, scaleY } = getCropDisplayScale();
      const local = screenToWrapperLocal(clientX, clientY);
      return {
        x: clampCropValue(local.x * scaleX, 0, imageData.width),
        y: clampCropValue(local.y * scaleY, 0, imageData.height)
      };
    }

    function hitTestCropDraft(position) {
      const draft = state.cropDraft;
      const rect = draft?.rect;
      if (!position || !rect) return 'draw';

      const { scaleX, scaleY } = getCropDisplayScale();
      const edgeX = CROP_EDGE_TARGET_PX * scaleX;
      const edgeY = CROP_EDGE_TARGET_PX * scaleY;
      const handleX = CROP_HIT_TARGET_PX * scaleX;
      const handleY = CROP_HIT_TARGET_PX * scaleY;
      const right = rect.left + rect.width;
      const bottom = rect.top + rect.height;
      const withinX = position.x >= rect.left - edgeX && position.x <= right + edgeX;
      const withinY = position.y >= rect.top - edgeY && position.y <= bottom + edgeY;
      const nearLeft = Math.abs(position.x - rect.left) <= handleX && withinY;
      const nearRight = Math.abs(position.x - right) <= handleX && withinY;
      const nearTop = Math.abs(position.y - rect.top) <= handleY && withinX;
      const nearBottom = Math.abs(position.y - bottom) <= handleY && withinX;

      if (nearLeft && nearTop) return 'nw';
      if (nearRight && nearTop) return 'ne';
      if (nearRight && nearBottom) return 'se';
      if (nearLeft && nearBottom) return 'sw';
      if (nearTop) return 'n';
      if (nearRight) return 'e';
      if (nearBottom) return 's';
      if (nearLeft) return 'w';
      if (position.x >= rect.left && position.x <= right && position.y >= rect.top && position.y <= bottom) {
        return 'move';
      }
      return 'draw';
    }

    function getCropCursor(hit) {
      switch (hit) {
        case 'move': return 'move';
        case 'n':
        case 's': return 'ns-resize';
        case 'e':
        case 'w': return 'ew-resize';
        case 'ne':
        case 'sw': return 'nesw-resize';
        case 'nw':
        case 'se': return 'nwse-resize';
        default: return 'crosshair';
      }
    }

    function getCropMinSize(imageData) {
      const { scaleX, scaleY } = getCropDisplayScale();
      return {
        width: Math.max(1, Math.min(imageData.width, CROP_MIN_DISPLAY_PX * scaleX)),
        height: Math.max(1, Math.min(imageData.height, CROP_MIN_DISPLAY_PX * scaleY))
      };
    }

    function resizeDraftRect(startRect, mode, position) {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      if (!imageData || !startRect) return null;

      const minSize = getCropMinSize(imageData);
      const lock = getCropRatioLock();
      const locked = lock && resizeRectWithRatio(startRect, mode, position, lock.ratio, imageData, minSize, { orientation: lock.orientation });
      if (locked) return locked;

      let left = startRect.left;
      let top = startRect.top;
      let right = startRect.left + startRect.width;
      let bottom = startRect.top + startRect.height;

      if (mode.includes('w')) left = position.x;
      if (mode.includes('e')) right = position.x;
      if (mode.includes('n')) top = position.y;
      if (mode.includes('s')) bottom = position.y;

      if (right - left < minSize.width) {
        if (mode.includes('w')) left = right - minSize.width;
        else right = left + minSize.width;
      }
      if (bottom - top < minSize.height) {
        if (mode.includes('n')) top = bottom - minSize.height;
        else bottom = top + minSize.height;
      }

      left = clampCropValue(left, 0, imageData.width - minSize.width);
      top = clampCropValue(top, 0, imageData.height - minSize.height);
      right = clampCropValue(right, left + minSize.width, imageData.width);
      bottom = clampCropValue(bottom, top + minSize.height, imageData.height);

      return {
        left,
        top,
        width: right - left,
        height: bottom - top
      };
    }

    function drawDraftRect(start, position) {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      if (!imageData || !start || !position) return null;

      const lock = getCropRatioLock();
      const locked = lock && drawRectWithRatio(start, position, lock.ratio, imageData, getCropMinSize(imageData), { orientation: lock.orientation });
      if (locked) return locked;

      return sanitizeDraftCropRect({
        left: Math.min(start.x, position.x),
        top: Math.min(start.y, position.y),
        width: Math.abs(position.x - start.x),
        height: Math.abs(position.y - start.y)
      }, imageData);
    }

    function positionStraightenGuideLine(line) {
      if (!straightenGuideLine || !line) return;

      const { scaleX, scaleY } = getCropDisplayScale();
      const x1 = line.start.x / scaleX;
      const y1 = line.start.y / scaleY;
      const x2 = line.current.x / scaleX;
      const y2 = line.current.y / scaleY;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;

      straightenGuideLine.style.display = 'block';
      straightenGuideLine.style.left = x1 + 'px';
      straightenGuideLine.style.top = y1 + 'px';
      straightenGuideLine.style.width = Math.max(1, length) + 'px';
      straightenGuideLine.style.transform = `rotate(${angle}deg)`;
    }

    function hideStraightenGuideLine() {
      if (!straightenGuideLine) return;
      straightenGuideLine.style.display = 'none';
    }

    function getNearestAxisCorrection(lineAngle) {
      const candidates = [0, 90, -90, 180, -180]
        .map(target => normalizeAngleDegrees(target - lineAngle));
      const best = candidates.reduce((closest, candidate) => (
        Math.abs(candidate) < Math.abs(closest) ? candidate : closest
      ), candidates[0]);
      return clampCropValue(best, -45, 45);
    }

    function averageCropAngles(angles) {
      if (!angles.length) return 0;
      const base = angles[0];
      const avgDelta = angles.reduce((sum, angle) => (
        sum + normalizeAngleDegrees(angle - base)
      ), 0) / angles.length;
      return normalizeAngleDegrees(base + avgDelta);
    }

    function finishStraightenLine(interaction) {
      const draft = state.cropDraft;
      if (!draft || !interaction?.start || !interaction?.current) return;

      const { scaleX, scaleY } = getCropDisplayScale();
      const dx = interaction.current.x - interaction.start.x;
      const dy = interaction.current.y - interaction.start.y;
      const displayLength = Math.hypot(dx / scaleX, dy / scaleY);
      if (displayLength < STRAIGHTEN_LINE_MIN_DISPLAY_PX) return;

      const lineAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      const correction = getNearestAxisCorrection(lineAngle);
      const targetAngle = normalizeAngleDegrees((interaction.startAngle || 0) + correction);
      draft.straightenLineAngles = [...(draft.straightenLineAngles || []), targetAngle].slice(-2);
      setCropDraftTotalAngle(averageCropAngles(draft.straightenLineAngles), { keepLineSamples: true });
    }

    function startCropDrag(clientX, clientY, options = {}) {
      const draft = state.cropDraft;
      if (!state.cropping || !draft) return;

      const position = getCropPointerPosition(clientX, clientY);
      if (!position) return;
      const startStraightenLine = Boolean(options.straightenLine);
      if (startStraightenLine) {
        draft.interaction = {
          mode: 'straighten-line',
          start: position,
          current: position,
          startAngle: getCropDraftTotalAngle()
        };
        state.cropStart = position;
        state.croppingActive = true;
        positionStraightenGuideLine(draft.interaction);
        canvasContainer.style.cursor = 'crosshair';
        return;
      }

      const mode = hitTestCropDraft(position);

      draft.interaction = {
        mode,
        start: position,
        startRect: draft.rect ? { ...draft.rect } : null
      };

      if (mode === 'draw') draft.rect = drawDraftRect(position, position);

      state.cropStart = position;
      state.croppingActive = true;
      canvasContainer.style.cursor = getCropCursor(mode);
      updateCropOverlayFromDraft();
    }

    function updateCropDrag(clientX, clientY) {
      const draft = state.cropDraft;
      const imageData = draft?.rotatedImageData;
      const interaction = draft?.interaction;
      if (!state.cropping || !state.croppingActive || !interaction || !imageData) return;

      const position = getCropPointerPosition(clientX, clientY);
      if (!position) return;

      if (interaction.mode === 'straighten-line') {
        interaction.current = position;
        positionStraightenGuideLine(interaction);
      } else if (interaction.mode === 'move') {
        const startRect = interaction.startRect;
        const dx = position.x - interaction.start.x;
        const dy = position.y - interaction.start.y;
        draft.rect = sanitizeDraftCropRect({
          left: startRect.left + dx,
          top: startRect.top + dy,
          width: startRect.width,
          height: startRect.height
        }, imageData);
      } else if (interaction.mode === 'draw') {
        draft.rect = drawDraftRect(interaction.start, position);
      } else {
        draft.rect = resizeDraftRect(interaction.startRect, interaction.mode, position);
      }

      updateCropOverlayFromDraft();
    }

    function finishCropDrag() {
      if (!state.cropping) return;
      const interaction = state.cropDraft?.interaction;
      state.croppingActive = false;
      if (interaction?.mode === 'straighten-line') {
        finishStraightenLine(interaction);
        hideStraightenGuideLine();
      }
      if (state.cropDraft) state.cropDraft.interaction = null;
      canvasContainer.style.cursor = 'crosshair';
      updateCropOverlayFromDraft();
    }

    function updateCropHoverCursor(clientX, clientY, options = {}) {
      if (!state.cropping || state.croppingActive) return;
      if (options.straightenLine) {
        canvasContainer.style.cursor = 'crosshair';
        return;
      }
      const position = getCropPointerPosition(clientX, clientY);
      canvasContainer.style.cursor = getCropCursor(hitTestCropDraft(position));
    }

    function shouldStartStraightenLine(event) {
      return Boolean(event.metaKey || event.ctrlKey);
    }

    canvasContainer.addEventListener('mousedown', (e) => {
      if (state.cropping) {
        e.preventDefault();
        startCropDrag(e.clientX, e.clientY, { straightenLine: shouldStartStraightenLine(e) });
      } else if (canPan()) {
        state.isPanning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        state.panStartPanX = state.panX;
        state.panStartPanY = state.panY;
        canvasContainer.classList.add('zoom-panning');
        e.preventDefault();
      }
    });

    canvasContainer.addEventListener('mousemove', (e) => {
      if (state.cropping) {
        if (state.croppingActive) updateCropDrag(e.clientX, e.clientY);
        else updateCropHoverCursor(e.clientX, e.clientY, { straightenLine: shouldStartStraightenLine(e) });
      } else if (state.isPanning) {
        state.panX = state.panStartPanX + (e.clientX - state.panStartX);
        state.panY = state.panStartPanY + (e.clientY - state.panStartY);
        clampPan();
        applyZoomPanTransform();
      }
    });

    function finishPan() {
      if (state.isPanning) {
        state.isPanning = false;
        canvasContainer.classList.remove('zoom-panning');
      }
    }

    canvasContainer.addEventListener('mouseup', () => { finishCropDrag(); finishPan(); });
    canvasContainer.addEventListener('mouseleave', () => { finishCropDrag(); finishPan(); });

    canvasContainer.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      if (state.cropping) {
        e.preventDefault();
        activeCropPointerId = e.pointerId;
        canvasContainer.setPointerCapture(e.pointerId);
        startCropDrag(e.clientX, e.clientY, { straightenLine: shouldStartStraightenLine(e) });
      } else if (canPan()) {
        e.preventDefault();
        state.isPanning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        state.panStartPanX = state.panX;
        state.panStartPanY = state.panY;
        canvasContainer.setPointerCapture(e.pointerId);
        canvasContainer.classList.add('zoom-panning');
      }
    }, { passive: false });

    canvasContainer.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      if (state.cropping && activeCropPointerId === e.pointerId) {
        e.preventDefault();
        updateCropDrag(e.clientX, e.clientY);
      } else if (state.isPanning) {
        e.preventDefault();
        state.panX = state.panStartPanX + (e.clientX - state.panStartX);
        state.panY = state.panStartPanY + (e.clientY - state.panStartY);
        clampPan();
        applyZoomPanTransform();
      }
    }, { passive: false });

    function finishCropPointer(e) {
      if (e.pointerType === 'mouse') return;
      if (activeCropPointerId === e.pointerId) {
        finishCropDrag();
        if (canvasContainer.hasPointerCapture(e.pointerId)) {
          canvasContainer.releasePointerCapture(e.pointerId);
        }
        activeCropPointerId = null;
      }
      if (state.isPanning) {
        finishPan();
        if (canvasContainer.hasPointerCapture(e.pointerId)) {
          canvasContainer.releasePointerCapture(e.pointerId);
        }
      }
    }

    canvasContainer.addEventListener('pointerup', finishCropPointer);
    canvasContainer.addEventListener('pointercancel', finishCropPointer);

    // Wheel zoom
    canvasContainer.addEventListener('wheel', (e) => {
      if (state.cropping || state.samplingMode || aiBrushDrawing) return;
      e.preventDefault();
      const deltaUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvasContainer.clientHeight : 1;
      const deltaY = e.deltaY * deltaUnit;
      const sensitivity = e.ctrlKey ? ZOOM_PINCH_WHEEL_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
      const factor = Math.max(0.72, Math.min(1.38, Math.exp(-deltaY * sensitivity)));
      zoomAtPoint(state.zoomLevel * factor, e.clientX, e.clientY);
    }, { passive: false });

    // Double-click: toggle zoom
    canvasContainer.addEventListener('dblclick', (e) => {
      if (state.cropping || state.samplingMode || canPaintAiBrush() || state.dustRemoval.showMask) return;
      if (state.zoomLevel > 1) {
        resetZoomPan();
      } else {
        zoomAtPoint(ZOOM_DOUBLE_CLICK_FACTOR, e.clientX, e.clientY);
      }
    });

    // Touch pinch zoom
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    canvasContainer.addEventListener('touchstart', (e) => {
      if (state.cropping) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.hypot(dx, dy);
        pinchStartZoom = state.zoomLevel;
      }
    }, { passive: false });

    canvasContainer.addEventListener('touchmove', (e) => {
      if (state.cropping) return;
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const newZoom = pinchStartZoom * (dist / pinchStartDist);
        zoomAtPoint(newZoom, centerX, centerY);
      }
    }, { passive: false });

    canvasContainer.addEventListener('touchend', () => {
      pinchStartDist = 0;
    });

    cancelCropBtn.addEventListener('click', () => {
      exitCropMode({ restore: true });
    });

    applyCropBtn.addEventListener('click', async () => {
      const draft = state.cropDraft;
      if (!draft || !draft.sourceImageData || studioAutoFrameRunning) return;

      const angle = getCropDraftTotalAngle();
      const previewRotatedImageData = draft.rotatedImageData;
      if (!previewRotatedImageData) return;
      // The draft is the current frame rotated by the draft angle (canvas D).
      // The result is derived from the base by the total angle (#244), so the
      // drawn rectangle is translated from D onto that frame F.
      const draftFrame = rotatedDimensions(draft.sourceImageData.width, draft.sourceImageData.height, angle);
      const nextGeometry = { rotationAngle: normalizeAngleDegrees((state.rotationAngle || 0) + storedRotationDelta(angle)), mirrored: state.mirrored };
      const base = state.loadedBaseImageData || draft.sourceImageData;
      const frame = geometryFrameSize(base, nextGeometry.rotationAngle);
      const cropRegion = mapDraftRectToFrame(scaleCropRect(
        draft.rect,
        draftFrame.width / previewRotatedImageData.width,
        draftFrame.height / previewRotatedImageData.height
      ), draftFrame, frame);
      if (!cropRegion) return;

      const generation = loadGeneration;
      let nextMeta = state.autoFrame.lastDiagnostics;
      {
        studioAutoFrameRunning = true;
        document.body.dataset.studioBusy = 'true';
        applyCropBtn.disabled = cancelCropBtn.disabled = true;
        studioWorkspace?.sync();
        try {
          if (processNegativeInFlight) await processNegativeInFlight;
          const overlay = getLoadingOverlay();
          await overlay.show({ title: studioWorkspace.text('detectingFrame'), indeterminate: true });
          await new Promise(resolve => requestAnimationFrame(resolve));
          const selectedArea = imageAreaFromWorkingRect(cropRegion, nextGeometry, base);
          nextMeta = structuredClone(state.autoFrame.lastDiagnostics || {});
          // 不確かな再検出では前回の解析範囲・WB を維持する。
          nextMeta.analysisArea ||= imageAreaFromWorkingRect(state.cropRegion || { left: 0, top: 0, width: state.originalImageData.width, height: state.originalImageData.height }, state, base);
          if (draft.analysisOnly) {
            nextMeta.imageArea = selectedArea;
            nextMeta.analysisNeedsReview = false;
            nextMeta.frameIncomplete = false;
            nextMeta.method = 'manual-analysis-area';
          } else if (!isSameAnalysisFrame(nextMeta.imageArea, selectedArea)) {
            let points = null;
            try {
              if (await ensureOpenCvReady()) {
                // The detector looks at a <=1 MP sample of the new frame; build
                // exactly that sample instead of the whole rotated frame.
                const preview = renderFrameSample(1000000, { base, ...nextGeometry });
                points = detectCropImageArea(frame, cropRegion, Object.entries(AUTO_FRAME_FORMAT_RATIOS).map(([key, ratio]) => ({ key, ratio })), { preview });
              }
            } catch (error) { console.warn('Crop analysis detection failed; keeping the previous color reference:', error); }
            if (points) {
              nextMeta.imageArea = workingPointsToBase(points, nextGeometry, base);
              nextMeta.analysisNeedsReview = false;
              nextMeta.frameIncomplete = false;
              nextMeta.method = 'manual-image-window';
            } else nextMeta.analysisNeedsReview = true;
          }
          nextMeta.importAuto = true;
        } finally {
          getLoadingOverlay().hide();
          studioAutoFrameRunning = false;
          delete document.body.dataset.studioBusy;
          applyCropBtn.disabled = cancelCropBtn.disabled = false;
          studioWorkspace?.sync();
        }
        if (!isCurrentLoad(generation) || state.cropDraft !== draft) return;
      }

      pushUndo('crop');
      state.autoFrame.lastDiagnostics = nextMeta;
      let ready = Promise.resolve(true);
      if (!draft.analysisOnly) {
        state.rotationAngle = nextGeometry.rotationAngle;
        // Only the crop window is resampled, in the pool.
        ready = applyGeometryFromBase({ cropRegion });
      }
      invalidateProcessedPipelineState();
      resetZoomPan();
      // With the crop in place this reads no pixels.
      setStep2Mode(suggestStep2Mode());
      markCurrentFileDirty();
      exitCropMode({ restore: false });

      await afterGeometry(ready, async isCurrent => {
        if (state.currentStep >= 3) {
          await convertAfterGeometryEdit(isCurrent);
        } else {
          const sourceImageData = state.croppedImageData || state.originalImageData;
          displayNegative(sourceImageData);
          updateCanvasVisibility();
          renderHistogram(sourceImageData);
        }
      });
    });

    // Convert button (skip to step 2)
    document.getElementById('convertBtn').addEventListener('click', () => {
      goToStep(2);
    });

    // Convert positive button (skip to step 2 with positive mode selected)
    document.getElementById('convertPositiveBtn').addEventListener('click', () => {
      state.filmType = 'positive';
      state.filmTypeSource = 'manual';
      state.filmTypeConfidence = null;
      state.filmTypeReason = null;
      setFilmTypeButtons(state.filmType);
      updateFilmModeUI();
      markCurrentFileDirty();
      goToStep(2);
    });

    // ===========================================
    // Reset & Start Over
    // ===========================================
    function resetAllAdjustments() {
      if (state.originalImageData) pushUndo('resetAllAdjustments');
      // Reset adjustments only
      state.coreFilmPreset = 'none';
      state.coreColorModel = 'standard';
      state.coreEnhancedProfile = 'none';
      state.coreProfileStrength = 100;
      state.corePreSaturation = 100;
      state.coreBorderBuffer = 10;
      state.coreBorderBufferBorderValue = 10;
      state.coreBrightness = 0;
      state.coreExposure = 0;
      state.coreContrast = 0;
      state.coreHighlights = 0;
      state.coreShadows = 0;
      state.coreWhites = 0;
      state.coreBlacks = 0;
      state.coreWbMode = 'auto';
      state.coreTemperature = 0;
      state.coreTint = 0;
      state.coreCyan = 0;
      state.corePaper = 'none';
      state.corePaperToning = 'none';
      state.corePaperToningStrength = 100;
      state.look = null;
      resetExpiredStrengthsInState();
      state.coreSaturation = 100;
      state.coreGlow = 0;
      state.coreFade = 0;
      state.coreCurvePrecision = 'auto';
      state.coreUseWebGL = true;

      state.exposure = 0;
      state.contrast = 0;
      state.highlights = 0;
      state.shadows = 0;
      state.temperature = 0;
      state.tint = 0;
      state.vibrance = 0;
      state.saturation = 0;
      state.cyan = 0;
      state.magenta = 0;
      state.yellow = 0;
      state.wbR = 1;
      state.wbG = 1;
      state.wbB = 1;
      state.grayPointSampled = false;
      state.wbAutoConfidence = null; state.wbSemanticApplied = false;
      state.wbUserOverride = false;

      updateSlidersFromState();
      initCurves(true);
      renderCurve();
      markCurrentFileDirty();
      if (usesSilverCoreConversion(state) && state.conversionSourceImageData) {
        void rerenderWithCoreControls({ full: true }).catch((err) => {
          console.error('Core rerender failed:', err);
        });
      } else {
        updateFull();
      }
    }

    function restartPhotoProcessing() {
      if (isDesktopBatchExportLocked()) return;
      if (state.photoSwitchTarget) {
        ++loadGeneration;
        state.photoSwitchTarget = null;
        state.photoSwitchPhase = null;
        delete document.body.dataset.photoSwitching;
        delete document.body.dataset.studioBusy;
        state.currentFileIndex = state.fileQueue.findIndex(item => item.file === state.loadedFile);
        updateFileListUI();
        studioWorkspace?.sync();
      }
      // Lens correction can return the original object unchanged. Source
      // identity alone cannot distinguish a discarded render from this reset.
      coreReprocessGeneration += 1;
      coreReprocessToken += 1;
      cancelPendingTimers();
      _coreReprocessPending = null;
      processNegativeInFlight = null;
      noteCoreReprocessSettled();
      clearUndoHistory();
      state.repairStrokes = [];
      // Leave crop mode first: the draft still points at the image
      // being discarded, and Apply would restore it over the reset.
      if (state.cropping) exitCropMode({ restore: false });
      state.samplingMode = null;
      exitBeforeAfter();
      resetZoomPan();
      if (state.loadedBaseImageData || state.originalImageData) {
        cancelGeometryJob();
        state.originalImageData = state.loadedBaseImageData || state.originalImageData;
        state.rotationAngle = 0;
        state.mirrored = false;
        updateMirrorButtonState();
        state.cropRegion = null;
        state.croppedImageData = null;
        state.processedImageData = null;
        state.displayImageData = null;
        clearFullResolutionRenderState();
        invalidateSilverCoreCache();
        state.conversionSourceImageData = null;
        state.conversionPreviewImageData = null;
        state.previewSourceImageData = null;
        state.histogramSourceImageData = null;
        state.webglSourceImageData = null;
        state.filmBaseSet = false;
        state.grayPointSampled = false;
        state.wbAutoConfidence = null; state.wbSemanticApplied = false;
        state.wbUserOverride = false;
        state.sprocketPreviewEnabled = false;
        resetFrontierGuideImageState();
        state.lastRenderQuality = 'full';
        if (webglState.gl) {
          webglState.sourceDirty = true;
          webglState.sourceSize = { w: 0, h: 0 };
        }
        displayNegative(state.originalImageData);
        updateAutoFrameButtons();
        goToStep(1);
        resetAllAdjustments();
        markCurrentFileDirty();
        void processNegative();
      }
    }

    function closePhotoSession() {
      if (isDesktopBatchExportLocked()) return;
      ++loadGeneration;
      invalidatePhotoActivation();
      photoSessions.clear();
      photoPreviews.clear();
      state.photoSwitchTarget = null;
      state.photoSwitchPhase = null;
      delete document.body.dataset.photoSwitching;
      delete document.body.dataset.studioBusy;
      clearDustState();
      clearUndoHistory();
      pendingProject = null;
      void clearProjectRecovery();
      // Leave crop mode first: the draft still points at the image
      // being discarded, and Apply would restore it over the reset.
      if (state.cropping) exitCropMode({ restore: false });
      state.samplingMode = null;
      exitBeforeAfter();
      // Comparison exit can draw once more; release caches after that draw.
      composeDisplaySprocketFrame.clear();
      sprocketPreviewFrameCache.key = '';
      sprocketPreviewFrameCache.sourceRef = null;
      sprocketPreviewFrameCache.metrics = null;
      for (const scratch of [sprocketPreviewFrameCanvas, sprocketScratchCanvas, beforeAfterScratchCanvas]) {
        scratch.width = scratch.height = 1;
      }
      resetZoomPan();
      zoomControls.style.display = 'none';
      // Reset all state
      state.loadedFile = null;
      state._pendingFullResBuffer = null;
      state._pendingFullResFileName = null;
      state._pendingFullResFile = null;
      state.loadedBaseImageData = null;
      state.originalImageData = null;
      state.croppedImageData = null;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.mirrored = false;
      updateMirrorButtonState();
      state.processedImageData = null;
      state.displayImageData = null;
      clearFullResolutionRenderState();
      invalidateSilverCoreCache();
      state.conversionSourceImageData = null;
      state.conversionPreviewImageData = null;
      state.previewSourceImageData = null;
      state.histogramSourceImageData = null;
      state.webglSourceImageData = null;
      state.filmBaseSet = false;
      state.grayPointSampled = false;
      state.wbAutoConfidence = null; state.wbSemanticApplied = false;
      state.wbUserOverride = false;
      state.sprocketPreviewEnabled = false;
      state.rawMetadata = null;
      state.currentStep = 1;
      state.lastRenderQuality = 'full';
      void stopHotFolder();
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.batchSessionActive = false;
      state.batchMode = false;
      state.lensCorrection = createInitialLensCorrectionState();
      resetFrontierGuideImageState();
      resetRollReferenceState();
      state.expiredSession = false;
      state.expiredEnabled = false;
      state.expiredAnalysis = null;
      expiredAnalysisKey = null;
      expiredTabPending = false;
      fullAdjustedBuffer = null;
      previewAdjustedBuffer = null;
      if (webglState.gl) {
        webglState.sourceDirty = true;
        webglState.sourceSize = { w: 0, h: 0 };
      }
      if (fullUpdateTimer) {
        clearTimeout(fullUpdateTimer);
        fullUpdateTimer = null;
      }
      clearCoreReprocessTimer();
      releaseCorePreviewRetained();
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }

      // Reset UI
      canvas.style.display = 'none';
      glCanvas.style.display = 'none';
      setUploadPlaceholderStatus('');
      document.getElementById('uploadPlaceholder').style.display = 'flex';
      document.getElementById('previewToolbar').style.display = 'none';
      document.getElementById('histogramContainer').style.display = 'none';
      document.getElementById('controlsPanel').style.display = 'none';
      updateBeforeAfterButtonState();
      updateSprocketControlsUI();

      // Reset adjustments
      resetAllAdjustments();
      syncBatchUIState({ reason: 'closePhotoSession' });
      // Drop the rendered rows and their memoized File references too, even
      // when the next picker is cancelled and no import triggers a refresh.
      updateFileListUI();

      // Trigger file selection
      warmImportPipeline();
      fileInput.value = '';
      fileInput.click();
    }

    // ===========================================
    // Export
    // ===========================================
    const exportBtn = document.getElementById('exportBtn');
    const exportSprocketBtn = document.getElementById('exportSprocketBtn');
    const exportDropdownMenu = document.getElementById('exportDropdownMenu');

    function setExportSprocketMode(enabled) {
      state.exportSprocketHolesEnabled = Boolean(enabled);
      updateSprocketControlsUI();
      updateExportUI();
    }

    function toggleExportDropdownForMode(enabled, event) {
      event.stopPropagation();
      const wasOpen = exportDropdownMenu.classList.contains('show');
      const previousMode = Boolean(state.exportSprocketHolesEnabled);
      setExportSprocketMode(enabled);
      exportDropdownMenu.classList.toggle('show', !(wasOpen && previousMode === Boolean(enabled)));
    }

    // Toggle dropdown on export button click
    exportBtn.addEventListener('click', (e) => {
      toggleExportDropdownForMode(state.exportSprocketHolesEnabled, e);
    });

    exportSprocketBtn.addEventListener('click', (e) => {
      toggleExportDropdownForMode(true, e);
    });

    // Prevent dropdown from closing when clicking inside it (for export settings)
    exportDropdownMenu.addEventListener('click', (e) => {
      if (
        e.target.closest('.export-format-section')
        || e.target.closest('.export-bitdepth-section')
        || e.target.closest('.export-quality-section')
      ) {
        e.stopPropagation();
      }
    });

    // Close dropdown when clicking elsewhere
    document.addEventListener('click', () => {
      exportDropdownMenu.classList.remove('show');
    });

    function isTauriDesktop() {
      return typeof window !== 'undefined'
        && !!window.__TAURI__
        && !!window.__TAURI__.core
        && typeof window.__TAURI__.core.invoke === 'function';
    }

    function downloadBlobInBrowser(blob, fileName) {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    }


    function normalizeExportBlob(blob, mimeType = 'application/octet-stream') {
      if (!(blob instanceof Blob)) {
        throw new Error('Export payload is not a Blob.');
      }
      return blob.type ? blob : new Blob([blob], { type: mimeType });
    }

    function normalizeSaveResult(result) {
      return {
        saved: Boolean(result && result.saved),
        path: result && result.path ? result.path : null
      };
    }

    async function pickDesktopSavePath(fileName) {
      if (!isTauriDesktop()) return null;
      const path = await window.__TAURI__.core.invoke('pick_export_file_path', {
        suggestedName: fileName
      });
      return typeof path === 'string' && path ? path : null;
    }

    async function pickDesktopExportDirectory() {
      if (!isTauriDesktop()) return null;
      const path = await window.__TAURI__.core.invoke('pick_export_directory');
      return typeof path === 'string' && path ? path : null;
    }

    async function writeBlobToDesktopPath(blob, targetPath, mimeType = 'application/octet-stream', { onProgress = null, signal = null } = {}) {
      if (!isTauriDesktop()) {
        throw new Error('Desktop path writes require the Tauri runtime.');
      }

      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      const result = await writeDesktopBlob(normalizedBlob, { path: targetPath }, window.__TAURI__.core.invoke, { onProgress, signal });
      return normalizeSaveResult(result);
    }

    async function writeBlobToDesktopDirectory(blob, directory, fileName, mimeType = 'application/octet-stream') {
      if (!isTauriDesktop()) {
        throw new Error('Desktop directory writes require the Tauri runtime.');
      }

      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      const result = await writeDesktopBlob(normalizedBlob, { directory, suggestedName: fileName }, window.__TAURI__.core.invoke);
      return normalizeSaveResult(result);
    }

    async function saveBlob(blob, fileName, mimeType = 'application/octet-stream') {
      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      if (isTauriDesktop()) {
        const path = await pickDesktopSavePath(fileName);
        if (!path) return { saved: false, path: null };
        return writeBlobToDesktopPath(normalizedBlob, path, mimeType);
      }

      downloadBlobInBrowser(normalizedBlob, fileName);
      return { saved: true, path: null };
    }

    function isBrowserSavePickerCancel(err) {
      return Boolean(err && (
        err.name === 'AbortError'
        || err.code === 20
      ));
    }

    async function createBrowserZipWritable(zipFileName) {
      if (!canUseBrowserZipStreaming(window)) {
        return null;
      }

      const handle = await window.showSaveFilePicker({
        suggestedName: zipFileName,
        types: [{
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] }
        }]
      });
      if (!handle || typeof handle.createWritable !== 'function') {
        return null;
      }

      return {
        fileName: handle.name || zipFileName,
        writable: await handle.createWritable()
      };
    }

    const imageDataToCanvasBlob = createImageDataCanvasBlobEncoder();

    let exportImageEncodersPromise = null;

    function getExportImageEncoders() {
      if (!exportImageEncodersPromise) {
        exportImageEncodersPromise = import('./exportImageEncoders.js').catch((err) => {
          exportImageEncodersPromise = null;
          throw err;
        });
      }
      return exportImageEncodersPromise;
    }

    const hdrGainInput = document.getElementById('exportHdrGainMap');
    if (hdrGainInput) {
      hdrGainInput.checked = safeStorageGet('nc_hdr_gain_map_v1') !== 'off';
      hdrGainInput.addEventListener('change', () => safeStorageSet('nc_hdr_gain_map_v1', hdrGainInput.checked ? 'on' : 'off'));
    }
    function getEffectiveExportBitDepth(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      if (format === 'jpeg') return 8;
      if (format === 'dng') return 16;
      return Number(requestedBitDepth) === 16 ? 16 : 8;
    }

    function getExportInfo(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      const normalizedFormat = format === 'jpeg' || format === 'tiff' || format === 'dng' ? format : 'png';
      const bitDepth = getEffectiveExportBitDepth(normalizedFormat, requestedBitDepth);
      if (normalizedFormat === 'jpeg') {
        return { format: normalizedFormat, bitDepth, extension: '.jpg', mimeType: 'image/jpeg' };
      }
      if (normalizedFormat === 'dng') {
        return { format: normalizedFormat, bitDepth: 16, extension: '.dng', mimeType: 'image/x-adobe-dng' };
      }
      if (normalizedFormat === 'tiff') {
        return { format: normalizedFormat, bitDepth, extension: '.tiff', mimeType: 'image/tiff' };
      }
      return { format: 'png', bitDepth, extension: '.png', mimeType: 'image/png' };
    }

    // A 16-bit export carries real 16-bit samples whenever the conversion
    // produced a 16-bit plane: the Step-3 stage runs at 16 bits on export
    // (applyPreparedAdjustmentsToBuffer16). Only the legacy (non-SilverCore)
    // path, which has no plane, is limited to 8-bit data.
    function exportKeeps16BitSamples(settings = state) {
      if (!settings) return true;
      if (settings === state) return Boolean(state.processedImageData?.__image16) || usesSilverCoreConversion(state);
      return usesSilverCoreConversion(settings);
    }

    function buildExportFileName(sourceName, exportInfo, options = {}) {
      const index = state.fileQueue.findIndex(item => item.file.name === sourceName);
      const withConverted = exportNameStem(sourceName || '', options.settings || state, state.rollMetadata, index >= 0 ? index + 1 : null);
      const sprocketSuffix = options.sprocket ? '_sprocket' : '';
      const wants16 = exportInfo.bitDepth === 16 && exportInfo.format !== 'jpeg';
      // In a batch each file carries its own adjustments, so the claim has to be
      // judged against those rather than the frame that happens to be on screen.
      const depthSuffix = wants16 && exportKeeps16BitSamples(options.settings || state)
        ? '_16bit'
        : '';
      if (exportInfo.format === 'dng') return `${withConverted.replace(/_converted$/, '')}_linear${exportInfo.extension}`;
      return `${withConverted}${sprocketSuffix}${depthSuffix}${exportInfo.extension}`;
    }

    // `settings` is the per-file settings object in a batch, so the 16-bit
    // claim in the name reflects that file rather than the live controls.
    function buildActiveExportFileName(sourceName, exportInfo, settings = state) {
      return buildExportFileName(sourceName, exportInfo, {
        sprocket: state.exportSprocketHolesEnabled,
        settings
      });
    }

    async function applySprocketFrameForExport(imageData, exportInfo, settings = state, position = state.currentFileIndex) {
      if (!state.exportSprocketHolesEnabled) return imageData;
      const options = getSprocketFrameComposeOptions(settings, position);
      await ensureSprocketFrameFonts(options);
      // A fresh frame this export owns (#250).
      return markOwnedPlanes(composeSprocketFrame(imageData, options));
    }

    // `planeOnly` (#250): a 16-bit TIFF/PNG without the sprocket frame reads
    // only the adjusted plane, so no 8-bit mirror is built for it.
    async function getCurrentExportImageData({ bitDepth = 8, bridge = null, planeOnly = false } = {}) {
      await ensureFullResolutionReadyForExport();
      // A 16-bit export re-runs the adjustment stage on the engine's 16-bit
      // plane instead of reusing the 8-bit display buffer.
      if (bitDepth === 16 && state.currentStep >= 3 && state.processedImageData?.__image16) {
        return await applyAdjustmentsWithSettings(state.processedImageData, state, { bitDepth: 16, bridge, planeOnly });
      }
      if (state.currentStep >= 3 && isDisplayImageDataFullResolution()) {
        return state.displayImageData;
      }
      if (state.processedImageData && state.currentStep >= 3) {
        return await applyAdjustmentsWithSettings(state.processedImageData, state, { bridge });
      }
      if (state.sprocketPreviewEnabled || state.exportSprocketHolesEnabled) {
        const sourceData = state.croppedImageData || state.originalImageData;
        noteGeometryPixelRead('currentExportImageData');
        if (sourceData) return sourceData;
      }
      if (canvas.width > 0 && canvas.height > 0) {
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      }
      return null;
    }

    // The prepare step of a single export: full resolution plus AI/dust repair.
    async function prepareCurrentImageForExport() {
      await ensureFullResolutionReadyForExport();
      // A quick export after a stroke must use MI-GAN, not its temporary preview.
      // A committed repair stamped with the current recipe is that result
      // already; only a TELEA stand-in or an outdated result is repaired again.
      const needsRepair = (aiRepairReady() && state.dustRemoval.enabled && state.dustRemoval.mask) || state.repairStrokes.length;
      if (needsRepair && repairStamps.matches(state.dustRemoval.inpaintedImageData, currentRepairRecipe())) {
        if (state.processedImageData !== state.dustRemoval.inpaintedImageData) applyDustResultToState();
      } else if (needsRepair) {
        const source = getDustSource();
        const dustEnabled = Boolean(state.dustRemoval.enabled);
        // Brush strokes patch the mask in place, so the pass reads a copy
        // and the revision tells whether the mask moved meanwhile (#259).
        const liveMask = state.dustRemoval.mask;
        const mask = liveMask ? liveMask.slice() : null;
        const dustRevision = state.dustRemoval.revision;
        const strokes = state.repairStrokes;
        const token = coreReprocessToken;
        const lensMapping = state.conversionSourceImageData?.__lensMapping || null;
        const modelRevision = aiRepair.revision;
        const dust = dustEnabled && mask ? await commitDustPass(source, mask, () => true, dustMaskInfo(liveMask)) : null;
        const repaired = await inpaintManualBrush(dust ? dust.imageData : source);
        // Manual-only background repair creates a fresh, unused zero dust
        // mask. Its identity does not change the export recipe. Actual dust
        // mode/mask changes and photo/stroke changes still invalidate it.
        if (token !== coreReprocessToken || source !== getDustSource() || strokes !== state.repairStrokes
          || dustEnabled !== Boolean(state.dustRemoval.enabled)
          || (dustEnabled && dustRevision !== state.dustRemoval.revision)) {
          throw new Error('Photo changed during AI repair. Please export again.');
        }
        // A from-scratch result: nothing left for the brush refresh to redo.
        // It replaces the repaired image outside history; stroke entries keep
        // patching the image they recorded.
        state.dustRemoval.inpaintedImageData = repaired;
        if (repaired !== source) {
          stampRepairResult(repaired, { source, token, dustEnabled, dustMask: dustEnabled ? liveMask : null,
            dustRevision: dustEnabled ? dustRevision : null, strokes,
            lensMapping, revision: modelRevision, dustUsedAi: dust ? dust.usedAi : null });
        }
        dustAiRefresh.rects.length = 0;
        applyDustResultToState();
      }
    }

    // The adjust step. `prepared` skips the prepare step a caller already ran.
    async function renderCurrentImageDataForExport(exportInfo = null, { bridge = null, planeOnly = false, prepared = false } = {}) {
      if (!prepared) await prepareCurrentImageForExport();
      // ensureFullRender exists to leave a full-resolution CPU buffer in
      // state.displayImageData, which getCurrentExportImageData then reuses.
      // Skip it when there is nothing to reuse or it is already current: with
      // the GPU preview active there is no CPU display buffer at all, so this
      // was a full-resolution adjustment pass on the main thread — a second or
      // more of frozen UI the moment the user clicks Export — purely to
      // populate one. getCurrentExportImageData produces the same pixels
      // through the export worker instead.
      const displayAlreadyCurrent = state.lastRenderQuality === 'full'
        && isDisplayImageDataFullResolution();
      const previewIsGpu = state.lastRenderQuality === 'gl' && isWebGLActive();
      if (!displayAlreadyCurrent && !previewIsGpu) {
        ensureFullRender();
      }
      const imageData = await getCurrentExportImageData({ bitDepth: exportInfo?.bitDepth || 8, bridge, planeOnly });
      if (!imageData) throw new Error('No image available for export.');
      if (exportInfo?.format === 'jpeg' && safeStorageGet('nc_hdr_gain_map_v1') !== 'off' && state.processedImageData?.__image16) {
        if (state.currentStep >= 3) {
          // The sprocket frame is a new ImageData without the map, so a map
          // computed for it was always dropped: do not compute one.
          if (state.exportSprocketHolesEnabled) return imageData;
          // Never mutate the display buffer: a wrapper shares its pixels, and
          // only the wrapper carries the export's map.
          const sdr = imageData === state.displayImageData
            ? new ImageData(imageData.data, imageData.width, imageData.height)
            : imageData;
          // The unadjusted plane and the recipe, captured now; imageDataToBlob
          // sends them with the SDR encode (#250). The plane is the editor's:
          // it is copied, never transferred.
          sdr.__gainMapSource = { processed: state.processedImageData, adjustmentSettings: buildAdjustmentSettings(state), transferPlane: false };
          return sdr;
        }
        const high = await getCurrentExportImageData({ bitDepth: 16, bridge });
        if (high?.__image16) imageData.__image16 = high.__image16;
      }
      return imageData;
    }

    // A 16-bit TIFF/PNG without the sprocket frame (#250): one worker request
    // adjusts the unadjusted plane and encodes it, so the adjusted plane never
    // exists on this thread. PNG metadata is attached here, at Blob level, as
    // imageDataToBlob does. Null: the caller runs the adjust + encode path.
    async function encodeFused16(source, adjustmentSettings, exportInfo, { bridge = null, metadata = null, onProgress = null, signal = null, transferPlane = false } = {}) {
      const exportWorkers = bridge || defaultExportWorkers;
      if (exportInfo.bitDepth !== 16 || (exportInfo.format !== 'tiff' && exportInfo.format !== 'png')) return null;
      if (!source?.__image16 || typeof exportWorkers.workerAdjust16AndEncode !== 'function' || !exportWorkers.isWorkerAvailable()) return null;
      const trace = createPerfTrace('imageDataToBlob', {
        format: exportInfo.format,
        bitDepth: exportInfo.bitDepth,
        pixels: getImageDataPixelCount(source),
        fused: true
      });
      const blob = await exportWorkers.workerAdjust16AndEncode(source, adjustmentSettings, {
        format: exportInfo.format,
        metadata: exportInfo.format === 'tiff' ? metadata : null,
        // PNG16: the band encoder's settings, so the file matches the other paths.
        ...(exportInfo.format === 'png' ? png16EncodeSettings() : {}),
        transferPlane,
        onProgress,
        signal
      });
      if (!blob) return null;
      trace.end({ bytes: blob.size || 0, worker: true });
      return exportInfo.format === 'png' ? attachMetadataToBlob(blob, 'png', metadata) : blob;
    }

    // Render and encode the open photo with `bridge`. `transferPlanes` lets
    // the worker take the planes this export allocated (never an editor
    // plane); `ownedPlanes` collects them for release when the export ends.
    // `png16Pool` (#257): a PNG16 is encoded by the band pool from the
    // adjusted plane instead of the fused request; `signal` cancels the
    // worker requests from the encode on.
    async function renderAndEncodeCurrentImage(exportInfo, { bridge, png16Pool = null, signal = null, metadata = null, onProgress = null, onEncoding = null, transferPlanes = true, ownedPlanes = [] }) {
      const planeOnly = exportInfo.bitDepth === 16 && (exportInfo.format === 'tiff' || exportInfo.format === 'png')
        && !state.exportSprocketHolesEnabled;
      const fused = planeOnly && (exportInfo.format === 'tiff' || !png16Pool);
      if (fused) {
        await prepareCurrentImageForExport();
        // getCurrentExportImageData's 16-bit trigger: the editor's plane is
        // sent as a sliced copy (it belongs to the editor).
        if (state.currentStep >= 3 && state.processedImageData?.__image16) {
          onEncoding?.();
          const blob = await encodeFused16(state.processedImageData, buildAdjustmentSettings(state), exportInfo, { bridge, metadata, onProgress, signal });
          if (blob) return blob;
        }
      }
      const imageData = await renderCurrentImageDataForExport(exportInfo, { bridge, planeOnly, prepared: fused });
      ownedPlanes.push(imageData);
      const outputImageData = await applySprocketFrameForExport(imageData, exportInfo);
      if (outputImageData !== imageData) ownedPlanes.push(outputImageData);
      onEncoding?.();
      return imageDataToBlob(outputImageData, exportInfo.format, state.jpegQuality, exportInfo.bitDepth, onProgress, metadata, { bridge, png16Pool, signal, transferPlane: transferPlanes });
    }

    function notifyExportError(err) {
      console.error('Export failed:', err);
      const message = err && err.message ? err.message : String(err || 'Unknown error');
      void appAlert(`Export failed: ${message}`);
    }

    async function exportSingle() {
      const currentItem = getCurrentQueueItem();
      const exportInfo = getExportInfo();
      const fileName = buildActiveExportFileName(currentItem?.file?.name, exportInfo);
      // Ask before rendering: even a cancelled 60 MP export used to allocate
      // full-resolution buffers and encode an image. Repeated cancellations
      // could exceed WKWebView's memory limit and reload the entire workspace.
      const desktop = isTauriDesktop();
      const targetPath = desktop ? await pickDesktopSavePath(fileName) : null;
      if (desktop && !targetPath) return { saved: false, path: null };
      if (currentItem !== getCurrentQueueItem()) {
        throw new Error('Photo changed while choosing a save location. Please export again.');
      }
      // Export freezes the result visible when the user requested it. A late
      // background colour estimate must not replace the recipe mid-encode.
      manualEditRevision++;
      notifyReviewExport([currentItem].filter(Boolean));
      // The linear DNG reads the geometry planes directly.
      await whenGeometrySettled();
      if (processNegativeInFlight) await processNegativeInFlight;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      // Cancel is offered from the encode on: it stops the PNG16 band
      // workers or the export worker, and on the desktop the write.
      const cancel = new AbortController();
      const allowCancel = () => overlay.setCancelable(true, {
        onCancel: () => cancel.abort(),
        cancelText: getLocalizedText('loadingCancel', 'Cancel')
      });
      let blob;
      let result;

      await overlay.show({ title: lang.loadingExporting });
      // This export's own worker, terminated when the export ends (#250): its
      // dead planes go with it instead of waiting for the next export. Every
      // request is awaited before the `finally`, so terminating there rejects
      // nothing on the normal path.
      const bridge = createExportWorkerBridge();
      // Its PNG16 band pool (#257), for the same lifetime.
      const png16Pool = exportInfo.format === 'png' && exportInfo.bitDepth === 16 ? createOperationPng16Pool(1) : null;
      const ownedPlanes = [];
      try {
        overlay.updateProgress(5, lang.loadingAdjusting);

        if (exportInfo.format === 'dng') {
          persistCurrentFileSettings({ silent: true, force: true });
          overlay.updateProgress(40, lang.loadingEncoding);
          blob = renderLinearDngBlob(state.conversionSourceImageData || state.croppedImageData || state.originalImageData, state, Math.max(0, state.currentFileIndex));
        } else {
          const full = state.currentStep >= 3 && state.processedImageData;
          if (full) persistCurrentFileSettings({ silent: true, force: true });
          else overlay.updateProgress(50, lang.loadingEncoding);
          const start = full ? 60 : 50;
          const span = full ? 0.35 : 0.45;
          const render = (transferPlanes) => renderAndEncodeCurrentImage(exportInfo, {
            bridge,
            png16Pool,
            signal: cancel.signal,
            transferPlanes,
            ownedPlanes,
            metadata: full ? exportMetadataFor(state, Math.max(0, state.currentFileIndex)) : null,
            onEncoding: () => {
              if (full) overlay.updateProgress(60, lang.loadingEncoding);
              allowCancel();
            },
            onProgress: (pct) => overlay.updateProgress(start + pct * span, lang.loadingEncoding)
          });
          try {
            blob = await render(true);
          } catch (err) {
            // The worker died holding a plane this export made. The editor's
            // planes were only ever copied, so the frame renders again.
            if (!isExportInputLostError(err) || cancel.signal.aborted) throw err;
            console.warn('Export plane lost with the export worker; rendering the frame again:', err?.message || err);
            blob = await render(false);
          }
        }
        if (cancel.signal.aborted) throw makeExportCancelledError();

        if (desktop) {
          // The overlay stays up until the file exists: byte progress while
          // the Blob streams to the native writer, "Complete!" only after
          // finish_export_write. Cancel aborts the write; the staging file
          // goes and the previous target stays.
          allowCancel();
          const savingLabel = (written, total) => getInterpolatedText('loadingSaving', {
            written: formatExportMegabytes(written),
            total: formatExportMegabytes(total)
          }, 'Saving… {written} / {total} MB');
          overlay.updateProgress(0, savingLabel(0, blob.size));
          result = await writeBlobToDesktopPath(blob, targetPath, exportInfo.mimeType, {
            signal: cancel.signal,
            onProgress: (written, total) => overlay.updateProgress(total > 0 ? (written / total) * 100 : 100, savingLabel(written, total))
          });
        } else {
          result = await saveBlob(blob, fileName, exportInfo.mimeType);
        }
        overlay.updateProgress(100, lang.loadingComplete);
      } catch (err) {
        if (cancel.signal.aborted && isAbortError(err)) return { saved: false, path: null };
        throw err;
      } finally {
        overlay.setCancelable(false);
        bridge.terminateWorker();
        if (png16Pool) png16Pool.dispose();
        releaseOwnedPlanes(...ownedPlanes);
        overlay.hide();
      }

      if (result?.saved) await learnFromExport(currentItem);
      return result;
    }

    function makeExportCancelledError() {
      const err = new Error('Export cancelled');
      err.name = 'AbortError';
      return err;
    }

    function formatExportMegabytes(bytes) {
      const megabytes = bytes / (1024 * 1024);
      return megabytes >= 100 ? String(Math.round(megabytes)) : megabytes.toFixed(1);
    }

    document.getElementById('exportSingleBtn').addEventListener('click', async () => {
      if (singleExportActive || isDesktopBatchExportLocked()) return;
      singleExportActive = true;
      updateExportButtons();
      try {
        const result = await exportSingle();
        handleSaveResult(result, {
          cancelledKey: 'exportSaveCancelled',
          cancelledFallback: 'Save cancelled. No file was written.',
          // Desktop: the write has finished, so name the file it made.
          savedFileKey: 'exportSavedFile',
          savedFileFallback: 'Saved {name}'
        });
      } catch (err) {
        notifyExportError(err);
      } finally {
        singleExportActive = false;
        updateExportButtons();
        updateExportUI();
      }
    });

    document.getElementById('exportZipBtn').addEventListener('click', async () => {
      try {
        await exportBatchAsZip();
      } catch (err) {
        notifyExportError(err);
      }
    });

    document.getElementById('exportAllBtn').addEventListener('click', async () => {
      try {
        await exportBatchIndividually();
      } catch (err) {
        notifyExportError(err);
      }
    });

    // Format toggle buttons
    document.querySelectorAll('.format-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.exportFormat = btn.dataset.format;
        updateExportUI();
      });
    });

    // Bit depth toggle buttons
    document.querySelectorAll('.bitdepth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled')) return;
        document.querySelectorAll('.bitdepth-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.exportBitDepth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        updateExportUI();
      });
    });

    // Quality slider
    document.getElementById('exportQualitySlider').addEventListener('input', (e) => {
      state.jpegQuality = parseInt(e.target.value);
      document.getElementById('exportQualityValue').textContent = state.jpegQuality + '%';
    });

    function updateDesktopExportMenuUI() {
      const zipBtn = document.getElementById('exportZipBtn');
      const exportAllBtn = document.getElementById('exportAllBtn');
      if (!zipBtn || !exportAllBtn) return;

      const desktop = isTauriDesktop();
      zipBtn.style.display = desktop ? 'none' : '';
      const exportAllKey = desktop ? 'exportIndividualDesktop' : 'exportIndividual';
      exportAllBtn.textContent = getLocalizedText(exportAllKey, exportAllBtn.textContent || 'Export All Individually');
      exportAllBtn.setAttribute('data-i18n', exportAllKey);
    }

    function updateExportUI() {
      updateDesktopExportMenuUI();
      const format = state.exportFormat;
      const isJpeg = format === 'jpeg';
      const isDng = format === 'dng';
      if (isJpeg) state.exportBitDepth = 8;
      const hdrSection = document.getElementById('exportHdrGainMapSection');
      if (hdrSection) hdrSection.hidden = !isJpeg;
      const bitDepthSection = document.getElementById('exportBitDepthSection');
      if (bitDepthSection) bitDepthSection.style.display = isDng ? 'none' : '';
      const dngNote = document.getElementById('exportDngNote');
      if (dngNote) dngNote.classList.toggle('show', isDng);
      const qualitySection = document.getElementById('exportQualitySection');
      qualitySection.classList.toggle('show', isJpeg);

      const bitDepthNote = document.getElementById('exportBitDepthNote');
      bitDepthNote.classList.toggle('show', isJpeg);

      document.querySelectorAll('.bitdepth-btn').forEach(btn => {
        const depth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        const disabled = isJpeg && depth === 16;
        btn.classList.toggle('disabled', disabled);
        btn.classList.toggle('active', depth === state.exportBitDepth);
      });

      // Update export button text
      const exportBtn = document.getElementById('exportBtn');
      const exportKey = isJpeg ? 'exportJpeg' : (format === 'tiff' ? 'exportTiff' : isDng ? 'exportDng' : 'exportPng');
      exportBtn.textContent = i18n[currentLang][exportKey];
      exportBtn.setAttribute('data-i18n', exportKey);

      const exportSprocketBtn = document.getElementById('exportSprocketBtn');
      if (exportSprocketBtn) {
        const sprocketKey = isJpeg ? 'exportSprocketJpeg' : (format === 'tiff' ? 'exportSprocketTiff' : isDng ? 'exportSprocketDng' : 'exportSprocketPng');
        exportSprocketBtn.disabled = isDng || isDesktopBatchExportLocked();
        exportSprocketBtn.textContent = i18n[currentLang][sprocketKey];
        exportSprocketBtn.setAttribute('data-i18n', sprocketKey);
      }

      // Update export current button text
      const exportSingleBtn = document.getElementById('exportSingleBtn');
      const exportSingleKey = isJpeg ? 'exportCurrentJpeg' : (format === 'tiff' ? 'exportCurrentTiff' : isDng ? 'exportCurrentDng' : 'exportCurrent');
      exportSingleBtn.textContent = i18n[currentLang][exportSingleKey];
      exportSingleBtn.setAttribute('data-i18n', exportSingleKey);

      const bitDepthButtons = document.querySelectorAll('.bitdepth-btn');
      bitDepthButtons.forEach((btn) => {
        const depth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        btn.textContent = depth === 16 ? '16-bit' : '8-bit';
      });
      updateSprocketControlsUI();
      studioWorkspace?.sync();
    }

    updateExportUI();

    // ===========================================
    // Batch Processing
    // ===========================================
    function extractCurrentSettings() {
      const safe = sanitizeSettings(state, { fallbackSettings: state });
      return deepCopySanitizedSettings(safe, {
        autoFrameMeta: state.autoFrame.lastDiagnostics
      });
    }

    // Fallback for sanitizing one photo's own settings. Geometry belongs to
    // that photo: a null crop means "not cropped", never "whatever the photo
    // on screen is cropped to". Falling back to `state` stamped the open
    // photo's crop onto every never-cropped frame a batch export, thumbnail or
    // roll pass cloned.
    function perPhotoSettingsFallback() {
      return { ...state, cropRegion: null, autoFrameMeta: null, rotationAngle: 0, mirrored: false };
    }

    function cloneSettings(settings) {
      if (!settings) return null;
      const safe = sanitizeSettings(settings, { fallbackSettings: perPhotoSettingsFallback() });
      return deepCopySanitizedSettings(safe);
    }

    let manualEditRevision = 0;
    document.addEventListener('input', event => {
      if (!event.target.closest('#controlsPanel')) return;
      manualEditRevision++;
      const item = getCurrentQueueItem();
      if (item) {
        item.userEdited = true;
        const key = event.target.id.replace(/Value$/, '');
        if ([...LEARNED_NUMERIC_KEYS, ...LEARNED_CATEGORY_KEYS].includes(key)) (item.touchedKeys ||= new Set()).add(key);
      }
    }, true);
    function markCurrentFileDirty() {
      const item = getCurrentQueueItem();
      if (!item) return;
      scheduleProjectRecovery();
      if (item.isDirty) return;
      item.isDirty = true;
      if (state.batchSessionActive) {
        updateFileListUI();
      } else {
        updateCurrentFileLabel();
      }
    }

    function persistCurrentFileSettings(options = {}) {
      const { silent = false, force = false } = options;
      const item = getCurrentQueueItem();
      if (!item) return false;
      // Provisional import settings (detections still running) are never
      // saved; `isDirty` cannot tell, since their automatic WB sets it.
      if (item.provisional) return false;
      if (!state.originalImageData) return false;
      if (!force && !item.isDirty && item.settings) return false;

      item.settings = extractCurrentSettings();
      updateStudioThumbnail();
      item.isDirty = false;
      updateFileListUI();

      if (!silent) {
        void appAlert(i18n[currentLang].settingsSaved || 'Settings saved for current image');
      }
      return true;
    }

    function applySettingsToItems(baseSettings, items, options = {}) {
      const includeCrop = Boolean(options.includeCrop);
      const copied = cloneSettings(baseSettings);
      if (!copied) return 0;
      // An explicit apply-to-all means the user wants one uniform look across
      // the roll — the receiving files must keep these exact gains, so strip
      // the auto provenance: the restore heuristic then treats them as
      // user-owned and the per-file estimator leaves them alone.
      copied.wbAutoConfidence = null; copied.wbSemanticApplied = false;

      let count = 0;
      items.forEach(item => {
        const next = cloneSettings(copied);
        next.repairStrokes = structuredClone(item.settings?.repairStrokes || []);
        // These describe the receiving photograph, not the copied colour recipe.
        next.reviewed = Boolean(item.settings?.reviewed);
        next.semanticMap = !includeCrop && item.settings?.semanticMap ? structuredClone(item.settings.semanticMap) : null;
        next.frameMetadata = sanitizeFrameMetadata(item.settings?.frameMetadata);
        next.filmEdge = item.settings?.filmEdge ? structuredClone(item.settings.filmEdge) : null;
        // The roll analysis share (lock, offset, outlier flag) describes the
        // receiving frame, not the reference, so each item keeps its own.
        next.rollFrame = item.settings?.rollFrame ? structuredClone(item.settings.rollFrame) : null;
        if (!includeCrop) {
          next.autoFrameMeta = item.settings?.autoFrameMeta ? structuredClone(item.settings.autoFrameMeta) : null;
          const existingCrop = item.settings && item.settings.cropRegion ? { ...item.settings.cropRegion } : null;
          const existingRotation = item.settings && Number.isFinite(item.settings.rotationAngle)
            ? item.settings.rotationAngle
            : 0;
          next.cropRegion = existingCrop;
          next.rotationAngle = existingRotation;
          // Mirroring is per-frame geometry like crop and rotation, not part of
          // the look being copied across the roll.
          next.mirrored = Boolean(item.settings && item.settings.mirrored);
        }
        item.settings = next;
        item.isDirty = false;
        count++;
      });
      return count;
    }

    async function applyCurrentSettingsToSelected() {
      if (state.currentStep < 3 || !state.processedImageData) {
        void appAlert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }

      const selectedItems = state.fileQueue.filter(item => item.selected && item.file !== state.loadedFile);
      if (selectedItems.length < 1) {
        void appAlert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
        return;
      }

      const baseSettings = extractCurrentSettings();
      if (!await appConfirm(studioWorkspace.text('settingsConfirm'))) return;
      applySettingsToItems(baseSettings, selectedItems, { includeCrop: false });

      updateFileListUI();
      const template = i18n[currentLang].appliedToSelected || 'Applied current settings to {count} image(s).';
      void appAlert(template.replace('{count}', String(selectedItems.length)));
    }

    function setRollReferenceFromCurrent() {
      if (state.currentStep < 3 || !state.processedImageData) {
        void appAlert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }
      const currentItem = getCurrentQueueItem();
      state.rollReference.enabled = true;
      state.rollReference.sourceFileId = currentItem ? currentItem.id : null;
      state.rollReference.settingsSnapshot = extractCurrentSettings();
      persistCurrentFileSettings({ silent: true, force: true });
      updateRollReferenceUI();
      void appAlert(i18n[currentLang].rollReferenceSet || 'Current image has been set as the roll reference.');
    }

    function applyRollReferenceToSelected() {
      if (!hasRollReference()) {
        void appAlert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) {
        void appAlert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
        return;
      }
      const applied = applySettingsToItems(
        state.rollReference.settingsSnapshot,
        selectedItems,
        { includeCrop: state.rollReference.applyCrop }
      );

      const currentItem = getCurrentQueueItem();
      if (currentItem && currentItem.selected && currentItem.settings) {
        restoreSettings(currentItem.settings);
        if (state.currentStep >= 3 && state.originalImageData) {
          void processNegative();
        }
      }

      updateFileListUI();
      const template = i18n[currentLang].rollReferenceApplied || 'Applied roll reference to {count} image(s).';
      void appAlert(template.replace('{count}', String(applied)));
    }

    function clearRollReference() {
      resetRollReferenceState();
      updateRollReferenceUI();
      void appAlert(i18n[currentLang].rollReferenceCleared || 'Roll reference cleared.');
    }

    function getSettingsForExport(index, item) {
      if (!item) return null;
      if (index === state.currentFileIndex && (item.isDirty || !item.settings)) {
        persistCurrentFileSettings({ silent: true, force: true });
      }
      return item.settings || null;
    }

    // `bitDepth` 16 runs the stage on the engine's 16-bit plane (when the
    // image carries one) so the export gets real 16-bit samples; 8 keeps the
    // LUT stage the preview uses. `planeOnly` (16 bits only) returns just
    // `{ width, height, __image16 }` for callers that read only the plane.
    // `transferPlane` (#250) lets the worker take the input plane when this
    // export owns it and nothing reads it again; it may then reject with
    // ExportInputLostError.
    async function applyAdjustmentsWithSettings(imageData, settings, options = {}) {
      return applyPreparedAdjustmentsWithWorkers(imageData, buildAdjustmentSettings(settings), options);
    }

    async function applyPreparedAdjustmentsWithWorkers(imageData, adjustmentSettings, { bitDepth = 8, bridge = null, planeOnly = false, transferPlane = false } = {}) {
      const wants16 = bitDepth === 16 && Boolean(imageData.__image16 && imageData.__image16.data instanceof Uint16Array);
      const planeOnlyPass = wants16 && planeOnly;
      const exportWorkers = bridge || defaultExportWorkers;
      // A transferred 8-bit frame that comes back is a new ImageData.
      let source = imageData;

      // Try Worker for large images (>1MP)
      if (imageData.width * imageData.height > 1_000_000 && exportWorkers.isWorkerAvailable()) {
        const result = wants16
          ? await exportWorkers.workerApplyAdjustments16(imageData, adjustmentSettings, 'full', { planeOnly: planeOnlyPass, transferPlane })
          : await exportWorkers.workerApplyAdjustments(imageData, adjustmentSettings, 'full', { transferPlane, onRestore: (frame) => { source = frame; } });
        if (result) return result;
      }

      // Fallback to main thread. The outputs are fresh: this export owns them.
      if (planeOnlyPass) {
        // No 8-bit output and no downconvert. A plane of another size yields
        // none, as the full pass attaches none then either.
        const plane16 = applyPreparedAdjustmentsToPlane16(source, adjustmentSettings, { quality: 'full' });
        if (plane16) markOwnedPlanes(plane16.data);
        return { width: source.width, height: source.height, __image16: plane16 };
      }
      const output = new ImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
      markOwnedPlanes(output.data);
      if (wants16) {
        applyPreparedAdjustmentsToBuffer16(source, adjustmentSettings, output, { quality: 'full' });
        if (output.__image16) markOwnedPlanes(output.__image16.data);
      } else {
        applyPreparedAdjustmentsToBuffer(source, adjustmentSettings, output, {
          quality: 'full',
          lutScratch: adjustmentLutScratch
        });
      }
      return output;
    }

    // The JPEG gain map for `sdr` on its own request: the canvas fallback of
    // imageDataToBlob starts it just before the main-thread SDR encode, so the
    // map still overlaps that encode. The export worker runs the 16-bit pass
    // and the map; without it the plane-only pass and the same table map run
    // here. `adjustmentSettings` is the recipe captured at the adjust stage.
    function startExportGainMap(processed, sdr, adjustmentSettings, { bridge = null, transferPlane = false } = {}) {
      return requestExportGainMap({
        processed,
        sdr,
        adjustmentSettings,
        workers: bridge || defaultExportWorkers,
        transferPlane,
        adjustPlane16: (prepared) => applyPreparedAdjustmentsWithWorkers(processed, prepared, { bitDepth: 16, bridge, planeOnly: true })
      });
    }

    function sanitizeCropRegionForImage(cropRegion, imageData) {
      return sanitizeCropRect(cropRegion, imageData);
    }

    function cropImageData(imageData, cropRegion) {
      const sanitized = sanitizeCropRegionForImage(cropRegion, imageData);
      if (!sanitized) return imageData;
      return cropImageDataRegion(imageData, sanitized);
    }

    // The export geometry chain in the pool, bit-identical to
    // applyGeometryChainToImageData. 8-bit sources at a non-right angle keep
    // the canvas rotation on this thread.
    async function renderGeometryChain(source, geometry, { isCurrent = () => true, maxInFlight = null } = {}) {
      const plan = planGeometry(source, geometry, { sanitizeCrop: (crop, frame) => sanitizeCropRegionForImage(crop, frame) });
      if (!plan) return applyGeometryChainToImageData(source, geometry, exportGeometrySteps);
      if (plan.identity) return source;
      const output = await geometryPool.render(source, plan, { isCurrent, maxInFlight: maxInFlight || interactiveGeometryBands(plan) });
      assertRepairCurrent(isCurrent);
      return output;
    }

    // Step implementations for applyGeometryChainToImageData. crop(null,
    // region, bounds) only sanitises the region against `bounds`.
    const exportGeometrySteps = {
      rotate: applyRotationToImageData,
      mirror: mirrorImageDataHorizontal,
      crop: (image, cropRegion, bounds = image) => {
        const rect = sanitizeCropRegionForImage(cropRegion, bounds);
        if (!image) return rect;
        return rect ? cropImageDataRegion(image, rect) : image;
      }
    };

    // The on-device repair model has a single session, so batch lanes take
    // turns with it instead of running it concurrently.
    let aiRepairTurn = Promise.resolve();
    function withAiRepairTurn(task) {
      const run = aiRepairTurn.then(task, task);
      aiRepairTurn = run.then(() => undefined, () => undefined);
      return run;
    }

    // `filmStats`: the caller will run createDefaultSettings on the result, so
    // a RAW decode's worker computes the film statistics alongside the planes.
    async function loadFileToImageData(file, { filmStats = false } = {}) {
      const fileName = file.name.toLowerCase();
      let image;
      if (isRawLikeFileName(fileName)) {
        const arrayBuffer = await file.arrayBuffer();
        image = await loadRawImageData(arrayBuffer, fileName, {
          sourceBlob: file,
          filmStats: filmStats ? { borderBufferPct: defaultFilmBaseBuffer() } : null
        });
      } else if (isPngFile(file)) {
        const arrayBuffer = await file.arrayBuffer();
        image = await loadPngImageData(arrayBuffer);
      } else {
        image = await loadStandardImage(file);
      }
      rememberImageDimensions(file, image);
      return image;
    }

    // PNG16 compression settings. Level 6 and the default strategy always;
    // `nc_png16_rle_v1 = on` (support/benchmarks only, no UI) switches to the
    // run-length strategy: still lossless, about +4 % size, much faster.
    function png16EncodeSettings() {
      return safeStorageGet('nc_png16_rle_v1') === 'on' ? { level: 6, strategy: 3 } : { level: 6, strategy: 0 };
    }

    // One PNG16 band pool per export operation. A batch creates its own (or
    // none with three or more lanes); every other export gets one for the
    // encode and releases it right after.
    function createOperationPng16Pool(lanes = 1) {
      const size = planPng16BandWorkers({ lanes, hardwareConcurrency: navigator.hardwareConcurrency });
      return size > 0 && typeof Worker === 'function' ? createPng16BandPool({ size }) : null;
    }

    // `transferPlane` (#250): the worker may take the frame's planes when this
    // export owns them (the bridge checks the stamp and refuses editor
    // planes); the call may then reject with ExportInputLostError.
    async function imageDataToBlob(imageData, format = null, quality = null, bitDepth = null, onProgress = null, metadata = null, { bridge = null, png16Pool = null, signal = null, transferPlane = false } = {}) {
      const exportInfo = getExportInfo(format || state.exportFormat, bitDepth ?? state.exportBitDepth);
      const jpegQuality = quality !== null ? quality : state.jpegQuality;
      const exportWorkers = bridge || defaultExportWorkers;
      const trace = createPerfTrace('imageDataToBlob', {
        format: exportInfo.format,
        bitDepth: exportInfo.bitDepth,
        pixels: getImageDataPixelCount(imageData)
      });
      let blob = null;
      // A transferred 8-bit frame that the worker hands back is a new ImageData.
      let frame = imageData;
      const onRestore = (restored) => { frame = restored; };

      if (exportInfo.format === 'tiff') {
        // Try Worker first for TIFF encoding
        if (exportWorkers.isWorkerAvailable()) {
          blob = await exportWorkers.workerEncodeTiff(frame, exportInfo.bitDepth, { onProgress, signal, transferPlane, onRestore }, metadata);
          if (blob) {
            trace.end({ bytes: blob.size || 0, worker: true });
            return blob;
          }
        }
        const { encodeTiffBlob } = await getExportImageEncoders();
        blob = encodeTiffBlob(frame, exportInfo.bitDepth, metadata);
        trace.end({ bytes: blob.size || 0, worker: false });
        return blob;
      }
      if (exportInfo.format === 'png' && exportInfo.bitDepth === 16) {
        // The row bands go to the band pool; if it cannot run them, one
        // export worker encodes them in turn, then the main thread. All three
        // write the same bytes. The pool copies its bands; the single worker
        // may take the frame's plane (#250).
        const settings = png16EncodeSettings();
        const ownPool = !png16Pool && !bridge ? createOperationPng16Pool(1) : null;
        const pool = png16Pool || ownPool;
        let bands = 0;
        try {
          if (pool) {
            blob = await pool.encode(frame, { ...settings, onProgress, signal });
            if (blob) bands = pool.size;
          }
          if (!blob && exportWorkers.isWorkerAvailable()) {
            blob = await exportWorkers.workerEncodePng16(frame, { ...settings, onProgress, signal, transferPlane, onRestore });
            if (blob) bands = 1;
          }
        } finally {
          if (ownPool) ownPool.dispose();
        }
        if (blob) {
          trace.end({ bytes: blob.size || 0, worker: true, bandWorkers: bands });
          return attachMetadataToBlob(blob, 'png', metadata);
        }
        const { encodePng16Blob } = await getExportImageEncoders();
        blob = encodePng16Blob(frame, settings);
        trace.end({ bytes: blob.size || 0, worker: false });
        return attachMetadataToBlob(blob, 'png', metadata);
      }

      // PNG8 and JPEG (#250): OffscreenCanvas in the export worker, with the
      // JPEG gain map in the same request; the main thread keeps only the
      // Blob-level work (metadata, gain-map container).
      const jpeg = exportInfo.format === 'jpeg';
      const mimeType = jpeg ? 'image/jpeg' : 'image/png';
      const canvasQuality = jpeg ? jpegQuality / 100 : undefined;
      const wantsGainMap = jpeg && safeStorageGet('nc_hdr_gain_map_v1') !== 'off';
      // `__gainMapSource`: the unadjusted plane and the recipe captured at the
      // adjust stage (a map only when they match the frame, as before). A
      // caller that attaches only an adjusted plane gets its map from it.
      const gainSource = wantsGainMap ? frame.__gainMapSource || null : null;
      const gainRequest = gainSource
        ? (gainMapInputsMatch(gainSource.processed, frame)
          ? { source: gainSource.processed, settings: gainSource.adjustmentSettings, transferPlane: Boolean(gainSource.transferPlane) }
          : null)
        : (wantsGainMap && frame.__image16 ? { plane16: frame.__image16, settings: null } : null);
      if (exportWorkers.isWorkerAvailable() && typeof exportWorkers.workerEncodeImage === 'function') {
        const encoded = await exportWorkers.workerEncodeImage(frame, { mimeType, quality: canvasQuality, gainMap: gainRequest, transferPlane, onRestore, onProgress, signal });
        if (encoded) {
          trace.end({ bytes: encoded.blob.size || 0, worker: true });
          blob = await attachMetadataToBlob(encoded.blob, jpeg ? 'jpeg' : 'png', metadata);
          if (jpeg && encoded.gain) {
            const { packGainMapJpeg } = await import('./gainMapJpeg.js');
            blob = await packGainMapJpeg(blob, encoded.gain.blob, encoded.gain);
          }
          return blob;
        }
      }

      // Main-thread canvas encode. The gain map's own worker pass starts first
      // so it still overlaps the canvas encode.
      const pendingMap = gainRequest && gainRequest.source
        ? startExportGainMap(gainRequest.source, frame, gainRequest.settings, { bridge, transferPlane: gainRequest.transferPlane })
        : null;
      blob = await imageDataToCanvasBlob(frame, mimeType, canvasQuality);
      trace.end({ bytes: blob.size || 0, worker: false });
      blob = await attachMetadataToBlob(blob, jpeg ? 'jpeg' : 'png', metadata);
      if (gainRequest) {
        const { computeGainMap, packGainMapJpeg } = await import('./gainMapJpeg.js');
        const map = pendingMap ? await pendingMap : computeGainMap(frame, gainRequest.plane16);
        if (map) {
          const gain = await imageDataToCanvasBlob(new ImageData(map.data, map.width, map.height), 'image/jpeg', 0.85);
          blob = await packGainMapJpeg(blob, gain, map);
        }
      }
      return blob;
    }

    // Analog metadata for one exported frame: the roll fields plus this file's
    // frame fields; `position` is the frame's place in the export order and
    // numbers frames that carry no number of their own.
    function exportMetadataFor(settings, position) {
      const frame = settings === state || !settings ? state.frameMetadata : settings.frameMetadata;
      return buildExportMetadata({ roll: state.rollMetadata, frame, index: position });
    }

    function updateBatchProgress(current, total, fileName) {
      const percent = Math.round((current / total) * 100);
      document.getElementById('batchProgressFill').style.width = percent + '%';
      document.getElementById('batchProgressText').textContent = `${current} / ${total}`;
      document.getElementById('batchProgressCurrent').textContent = fileName || '';
    }

    function showBatchProgress(show) {
      document.getElementById('batchProgressOverlay').style.display = show ? 'flex' : 'none';
    }

    // Process a single file with given settings (streaming - no memory accumulation)
    // Get selected files for batch processing
    function getSelectedFiles() {
      return getFileListOrder()
        .map(index => ({ item: state.fileQueue[index], index }))
        .filter(({ item }) => item.selected);
    }

    // Create default settings with auto-detected film base.
    // Film type, lens correction and border buffer are session-level choices: a
    // file the user opens inherits them from the previous frame, because
    // loadFile never resets them. Files that are only ever exported must
    // inherit the same values, otherwise pressing "Convert positive" and then
    // Export All returns every unviewed slide inverted as a colour negative,
    // and a B&W roll comes back tinted by an orange-mask compensation.
    // The border buffer new-photo defaults detect the film base with. A RAW
    // decode that will need defaults asks its worker for the statistics at
    // this buffer, so createDefaultSettings finds them cached.
    function defaultFilmBaseBuffer() {
      return sanitizeNumeric(state.coreBorderBuffer, 10, 0, 30);
    }

    function createDefaultSettings(imageData, item = null) {
      const trace = createPerfTrace('createDefaultSettings', { pixels: getImageDataPixelCount(imageData) });
      const choice = sanitizeFilmTypeOverride(item?.filmTypeOverride);
      const importSettings = detectedImportSettings(imageData, { automatic: !choice && state.importFilmTypeAuto, filmType: choice?.filmType || state.filmType, positiveMode: choice?.positiveMode || state.positiveMode, detect: cachedDetectFilmType });
      const borderBuffer = defaultFilmBaseBuffer();
      const borderBufferBorderValue = sanitizeNumeric(state.coreBorderBufferBorderValue, 10, 0, 30);
      const filmBase = autoDetectFilmBase(imageData, borderBuffer);
      trace.end();
      return {
        cropRegion: null,
        rotationAngle: 0,
        mirrored: false,
        autoFrameMeta: null,
        ...importSettings,
        filmBase: filmBase,
        filmEdge: null,
        rollFrame: null,
        lensCorrection: state.lensCorrection
          ? sanitizeLensCorrection(state.lensCorrection, createDefaultLensCorrectionSettings())
          : createDefaultLensCorrectionSettings(),
        coreFilmPreset: 'none',
        coreColorModel: 'standard',
        coreEnhancedProfile: 'none',
        coreProfileStrength: 100,
        corePreSaturation: 100,
        coreBorderBuffer: borderBuffer,
        coreBorderBufferBorderValue: borderBufferBorderValue,
        coreBrightness: 0,
        coreExposure: 0,
        coreContrast: 0,
        coreHighlights: 0,
        coreShadows: 0,
        coreWhites: 0,
        coreBlacks: 0,
        coreWbMode: 'auto',
        coreTemperature: 0,
        coreTint: 0,
        coreCyan: 0,
        corePaper: 'none',
        corePaperToning: 'none',
        corePaperToningStrength: 100,
        localExposure: null,
        repairStrokes: [],
        look: null,
        ...EXPIRED_RESCUE_DEFAULTS,
        expiredEnabled: Boolean(state.expiredSession),
        expiredAnalysis: null,
        frameMetadata: sanitizeFrameMetadata({}),
        flatFieldId: state.flatFieldId || null,
        coreSaturation: 100,
        coreGlow: 0,
        coreFade: 0,
        coreCurvePrecision: 'auto',
        coreUseWebGL: true,
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        temperature: 0,
        tint: 0,
        vibrance: 0,
        saturation: 0,
        cyan: 0,
        magenta: 0,
        yellow: 0,
        wbR: 1,
        wbG: 1,
        wbB: 1,
        grayPointSampled: false,
        curvePoints: {
          r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          b: [{ x: 0, y: 0 }, { x: 255, y: 255 }]
        },
        curves: {
          r: makeLinearCurveLut(),
          g: makeLinearCurveLut(),
          b: makeLinearCurveLut()
        }
      };
    }

    // Process a file with its own settings or auto-detect.
    //
    // Planes (#250): this function is shared with the thumbnail lane (which
    // borrows a photo session's base), the contact sheet and the watch folder,
    // so it never transfers or frees a plane itself. It stamps the planes it
    // allocates as export-owned and, when the caller passes
    // `options.ownedPlanes` (an array), pushes them there for the caller to
    // release after its last use. `stage: 'processed'` stops before the
    // adjustment stage and returns `{ processed, settings }`.
    async function processFileWithSettings(file, savedSettings, options = {}) {
      const isCurrent = options.isCurrent || (() => true);
      const previewMax = Math.max(0, Number(options.previewMaxDimension) || 0);
      // Batch jobs run without the blocking "Detecting frame" overlay and its
      // frame wait: they must keep going in a hidden window (#241). Detection
      // inputs, thresholds and geometry are the same either way.
      const silent = options.silent ?? Boolean(previewMax);
      const ownedPlanes = Array.isArray(options.ownedPlanes) ? options.ownedPlanes : null;
      // A plane this call allocated: stamped, and exposed to the caller.
      const own = (plane, input = null) => {
        if (!plane || plane === input) return plane;
        if (input) {
          const inputBuffers = planeBuffersOf(input);
          if (planeBuffersOf(plane).some((buffer) => inputBuffers.includes(buffer))) return plane;
        }
        markOwnedPlanes(plane);
        ownedPlanes?.push(plane);
        return plane;
      };
      const trace = createPerfTrace('processFileWithSettings', {
        file: file?.name || '',
        bytes: file?.size || 0
      });
      // Load the image
      const imageData = options.sourceImageData || own(await loadFileToImageData(file, { filmStats: !savedSettings }));
      assertRepairCurrent(isCurrent);
      options.onDecoded?.(imageData);
      trace.mark('load', {
        pixels: getImageDataPixelCount(imageData)
      });

      // Use saved settings or create default with auto-detect.
      // Geometry is per-file and must never leak in from whichever frame
      // happens to be on screen: sanitizeSettings substitutes the fallback
      // whenever cropRegion / autoFrameMeta are null, which is exactly what a
      // never-cropped file carries, so the live crop would be stamped onto
      // every other frame in the roll.
      const studioColors = state.fileQueue.find(item => item.file === file)?.studioColors;
      let initialSettings = savedSettings || mergeStudioColors(createDefaultSettings(imageData, state.fileQueue.find(item => item.file === file)), studioColors || {});
      let importRotation = null;
      if (!initialSettings.autoFrameMeta && !initialSettings.cropRegion && !expiredImportKeepsFullFrame(initialSettings)) {
        initialSettings = await analyzeStudioImportFrame(imageData, initialSettings, {
          allowCrop: !savedSettings, silent, onRotation: rotation => { importRotation = rotation; }
        });
      }
      assertRepairCurrent(isCurrent);
      if (!initialSettings.filmEdge?.checked) {
        const edge = await analyzeImportFilmEdge(imageData, initialSettings, { applyDefaults: !savedSettings && state.importFilmTypeAuto });
        if (edge) initialSettings = edge.settings;
      }
      if (!savedSettings) {
        const queued = state.fileQueue.find(item => item.file === file);
        initialSettings = await learnedImportSettings(settleImportFilmType(queued, initialSettings), queued);
      }
      assertRepairCurrent(isCurrent);
      const settings = sanitizeSettings(initialSettings, {
        fallbackSettings: { ...state, cropRegion: null, autoFrameMeta: null, rotationAngle: 0, mirrored: false }
      });

      // Geometry chain (base -> rotation -> mirror -> crop). One pass that
      // only resamples the cropped window: rotating a whole 24 MP scan to keep
      // a 5 MP frame of it was the largest main-thread block per file.
      const geometry = {
        rotationAngle: Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0,
        mirrored: Boolean(settings.mirrored),
        cropRegion: settings.cropRegion || null
      };
      // The auto-frame worker already rotated this decode by the same angle
      // with the same exact kernel: mirror and crop that frame instead (#244).
      const adoptedRotation = importRotation && importRotation.base === imageData && importRotation.angle
        && importRotation.angle === normalizeAngleDegrees(geometry.rotationAngle)
        && hasExactPlane16(imageData) && hasExactPlane16(importRotation.image)
        && importRotation.image.width === rotatedDimensions(imageData.width, imageData.height, importRotation.angle).width
        && importRotation.image.height === rotatedDimensions(imageData.width, imageData.height, importRotation.angle).height
        ? importRotation.image : null;
      importRotation = null;
      // In the geometry pool: batch lanes, the contact sheet and the thumbnail
      // lane no longer queue on the main thread for this step (#244).
      let workingData = own(await renderGeometryChain(
        adoptedRotation || imageData, adoptedRotation ? { ...geometry, rotationAngle: 0 } : geometry,
        { isCurrent, maxInFlight: options.geometryBands }
      ), imageData);
      workingData = own(await applyLensCorrectionWithSettings(workingData, settings, { updateUi: false }), workingData);
      assertRepairCurrent(isCurrent);
      const fullWorkingShortSide = Math.min(workingData.width, workingData.height);
      // Lensfun's repair mapping is expressed in native working pixels.
      // Downsampling drops that map; reusing it unscaled would also misplace
      // strokes. Keep this combination native until repair, then shrink only
      // the final adjusted thumbnail. Other previews retain the small path.
      const nativeMappedRepair = Boolean(workingData.__lensMapping && settings.repairStrokes?.length);
      const reducedPreview = Boolean(previewMax && !nativeMappedRepair);
      if (reducedPreview) workingData = downsampleImageDataForMaxDim(workingData, previewMax);
      trace.mark('transform', {
        pixels: getImageDataPixelCount(workingData)
      });
      // The linear DNG wants the geometry-applied negative, not the conversion.
      if (options.stage === 'source') {
        trace.end({ outputPixels: getImageDataPixelCount(workingData) });
        if (!savedSettings) {
          const item = state.fileQueue.find((entry) => entry.file === file);
          if (item) item.settings = cloneSettings(settings);
        }
        return { source: workingData, settings };
      }

      // Convert negative/positive via unified conversion router (in a worker
      // when available — keeps batch export from freezing the page).
      // Every batch file is a new source, so it needs its own histogram
      // analysis. Without forceFullProcess the adapter reuses the cached
      // engine whenever the dimensions match and rebuilds the LUTs from the
      // PREVIOUS frame's black/white points, so a thin negative in a roll of
      // same-size scans is levelled against its neighbour.
      // A batch export brings its own pooled workers (options.convert).
      const convert = typeof options.convert === 'function' ? options.convert : convertFrameOffMainThread;
      // `sourceRole` states what happens to the working plane afterwards
      // (#250): 'base' is read again below (analysis region, brush mapping,
      // expired rescue); 'derived' (a geometry or lens output) is not, only
      // its dimensions and `__lensMapping` are. A batch export's convert may
      // lend the one and hand over the other; every other convert ignores it.
      const baseBuffers = planeBuffersOf(imageData);
      const sourceRole = workingData !== imageData && !planeBuffersOf(workingData).some((buffer) => baseBuffers.includes(buffer))
        ? 'derived' : 'base';
      let processed = own(await convert({
        imageData: workingData,
        settings: buildRouterSettings(settings, imageData),
        options: { preview: reducedPreview, forceFullProcess: true, analysisImageData: getColorAnalysisSample(settings, imageData) },
        sourceRole
      }), workingData);
      assertRepairCurrent(isCurrent);
      trace.mark('convert', {
        pixels: getImageDataPixelCount(processed)
      });

      // Apply dust removal if enabled (full resolution for export)
      const dustRemoval = options.dustRemoval || state.dustRemoval;
      if (dustRemoval && dustRemoval.enabled && processed) {
        const strength = Number.isFinite(dustRemoval.strength) ? dustRemoval.strength : state.dustRemoval.strength;
        let maxParticleSize = Number.isFinite(dustRemoval.maxParticleSize)
          ? dustRemoval.maxParticleSize
          : state.dustRemoval.maxParticleSize;
        const processedShortSide = Math.min(processed.width, processed.height);
        if (previewMax && processedShortSide > 0 && processedShortSide < fullWorkingShortSide) {
          maxParticleSize = Math.max(3, Math.round(maxParticleSize * processedShortSide / fullWorkingShortSide));
        }
        const { mask, particleCount } = await detectDustOffMainThread(processed, { strength, maxParticleSize }, null, isCurrent, options.dustWorker);
        const dustSource = processed;
        // Batch lanes and thumbnails reuse the open photo's tiles but never
        // evict them (lookups only).
        if (particleCount > 0) processed = own(await withAiRepairTurn(() => inpaintForCommit(dustSource, mask, isCurrent, options.dustWorker, { memoInsert: false })), dustSource);
        trace.mark('dustRemoval', {
          pixels: getImageDataPixelCount(processed)
        });
      }

      if (settings.repairStrokes?.length) {
        const brushSource = processed;
        processed = own(await withAiRepairTurn(() => inpaintManualBrush(brushSource, settings, imageData, workingData.__lensMapping, isCurrent, { memoInsert: false })), brushSource);
      }

      // Never-viewed batch files carry default settings — give them the same
      // automatic gray point a viewed file would get, baked into the settings
      // BEFORE the adjustment stage (which may run in the export worker).
      // Saved settings are always respected as-is: they already hold manual,
      // auto, or roll-applied gains.
      if (
        (!savedSettings || state.fileQueue.find(item => item.file === file)?.automaticSettings)
        && !settings.wbUserOverride
        && !settings.wbSemanticApplied
        && processed
        && usesSilverCoreConversion(settings)
        && sanitizePresetType(settings.filmType || 'color') === 'color'
        && !settings.grayPointSampled
        && !settings.expiredEnabled
      ) {
        const roi = resolveAnalysisRegion(settings, imageData);
        const estimate = settings.autoFrameMeta?.analysisNeedsReview ? { confidence: 'low' }
          : settings.semanticMap ? estimateAutoWhiteBalance(processed, { anchors: settings.semanticMap })
          : estimateAutoWhiteBalance(processed.__analysisPreview || (roi ? cropImageData(processed, analysisPixelBounds(processed.width, processed.height, roi, 0.02)) : processed));
        if (estimate.confidence !== 'low') {
          settings.wbR = estimate.wbR;
          settings.wbG = estimate.wbG;
          settings.wbB = estimate.wbB;
          settings.wbAutoConfidence = estimate.confidence;
        }
        settings.wbAutoConfidence = estimate.confidence;
        trace.mark('autoWhiteBalance', { confidence: estimate.confidence });
      }

      // Expired-film rescue: a frame the user never opened carries no
      // measurement yet, so take it from this frame's own positive (with the
      // OpenCV fog map when OpenCV is available).
      if (settings.expiredEnabled && !settings.expiredAnalysis && processed) {
        const analysis = await measureExpiredAnalysisForExport(processed, settings, imageData);
        if (analysis) applyExpiredAnalysisDefaults(settings, analysis);
        trace.mark('expiredRescue', { analysed: Boolean(analysis), spatial: Boolean(analysis?.spatial) });
      }

      // A batch export adjusts, composes and encodes the frame itself (#250),
      // so it can hand its planes to the worker without a copy.
      if (options.stage === 'processed') {
        assertRepairCurrent(isCurrent);
        trace.end({ outputPixels: getImageDataPixelCount(processed) });
        options.onPreparedSettings?.(settings);
        if (!savedSettings && options.updateItemSettings !== false) {
          const item = state.fileQueue.find(item => item.file === file);
          if (item) item.settings = cloneSettings(settings);
        }
        return { processed, settings };
      }

      // Apply adjustments (at 16 bits when the export asks for it)
      assertRepairCurrent(isCurrent);
      const adjusted = previewMax
        ? createAdjustedPhotoPreview(processed, buildAdjustmentSettings(settings), { maxSize: previewMax })
        : await applyAdjustmentsWithSettings(processed, settings, { bitDepth: options.bitDepth === 16 ? 16 : 8, bridge: options.bridge });
      if (!previewMax) ownedPlanes?.push(adjusted);
      trace.mark('adjustments', {
        pixels: getImageDataPixelCount(adjusted)
      });
      trace.end({
        outputPixels: getImageDataPixelCount(adjusted)
      });
      assertRepairCurrent(isCurrent);
      options.onPreparedSettings?.(settings);
      if (!savedSettings && options.updateItemSettings !== false) {
        const item = state.fileQueue.find(item => item.file === file);
        if (item) item.settings = cloneSettings(settings);
      }
      return adjusted;
    }

    function showBrowserZipStreamSummary({ zipFileName, successCount, failCount, total }) {
      const key = failCount > 0 ? 'zipStreamingPartial' : 'zipStreamingSaved';
      const fallback = failCount > 0
        ? `ZIP saved: ${zipFileName}. Exported ${successCount} / ${total} files; ${failCount} failed.`
        : `ZIP saved: ${zipFileName}. Exported ${successCount} / ${total} files.`;
      showToast(
        getInterpolatedText(key, {
          file: zipFileName,
          success: successCount,
          failed: failCount,
          total
        }, fallback),
        failCount > 0 ? 6000 : 4500
      );
    }

    // ===========================================
    // Batch export: one pipelined driver, three sinks
    // ===========================================
    // Every selected file runs decode -> geometry -> convert -> adjust ->
    // encode. The scheduler keeps several files in flight so their stages
    // interleave across the main thread, the RAW decoders and the worker
    // pools, and hands the encoded results to the sink in the original order
    // (ZIP entries, folder writes and downloads keep the roll's sequence).

    // `nc_batch_lanes_v1` is a 1-4 lane ceiling for support/benchmarks; cores,
    // device memory and the largest decoded frame may require fewer lanes.
    async function planBatchLaneBudget(files) {
      const pinned = Number.parseInt(safeStorageGet('nc_batch_lanes_v1') || '', 10);
      // Read a bounded header at a time so a long roll cannot flood IO either.
      let pixelsPerFile = 0;
      for (const file of files) pixelsPerFile = Math.max(pixelsPerFile, await imagePixelsForBatch(file));
      const lanes = planBatchParallelism({
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        pixelsPerFile,
        fileCount: files.length,
        maxParallel: Number.isInteger(pinned) && pinned >= 1 && pinned <= 4 ? pinned : 4
      });
      return { lanes, pixelsPerFile };
    }

    async function planBatchLanes(files) {
      return (await planBatchLaneBudget(files)).lanes;
    }

    function planBatchExportLanes(jobs) {
      return planBatchLaneBudget(jobs.map(job => job.file));
    }

    // Workers one batch shares and releases when it ends: `lanes` conversion
    // workers kept alive across frames (no per-file restart), as many export
    // workers for the adjustment/encode stages, and for a 16-bit PNG batch of
    // one or two lanes the PNG16 band pool. One lane is an export pool of one
    // too, so its worker ends with the batch instead of living on in the
    // module-level bridge (#250).
    //
    // `convertHandoff` also hands the frame's 16-bit source to the lane
    // (#250): the base is lent and comes back, a geometry/lens output is
    // given up. Both release the lane's cached planes after each frame. A
    // source lost with its lane is never converted on the main thread: the
    // frame is rendered again from decode.
    function createBatchExportWorkers(lanes, { pixelsPerFile = 0, exportInfo = null } = {}) {
      const dust = createDustWorkerClient();
      // The lanes share the geometry pool; each keeps few enough bands in
      // flight that their transient copies stay within the band budget.
      const geometryBands = planGeometryBandsInFlight({
        lanes, pixelsPerFile, poolSize: geometryPool.size, deviceMemory: navigator.deviceMemory
      });
      const pool = !conversionWorkerBroken && usesSilverCoreConversion(state)
        ? createConversionWorkerPool({ size: lanes })
        : null;
      const bridge = createExportWorkerPool({ size: lanes });
      const png16Pool = exportInfo && exportInfo.format === 'png' && exportInfo.bitDepth === 16
        ? createOperationPng16Pool(lanes)
        : null;
      const convertWith = (handoff) => async (request) => {
        const laneRequest = { ...request, releaseAfter: true };
        if (handoff) laneRequest.handoff = request.sourceRole === 'derived' ? 'consume' : 'lend';
        try {
          return await pool(laneRequest);
        } catch (err) {
          if (isConversionInputLost(err)) throw err;
          // Same policy as convertFrameOffMainThread: the frame still exports.
          console.warn('Batch conversion worker failed, converting on the main thread:', err?.message || err);
          return convertFrameWithRouter(request);
        }
      };
      return {
        convert: pool ? convertWith(false) : null,
        convertHandoff: pool ? convertWith(true) : null,
        bridge,
        png16Pool,
        dust,
        geometryBands,
        dispose() {
          dust.dispose();
          if (pool) pool.dispose();
          bridge.dispose();
          if (png16Pool) png16Pool.dispose();
        }
      };
    }

    // One frame: the per-file pipeline plus the sprocket border and encoder.
    //
    // Planes (#250): every plane of the frame belongs to this call, so each
    // stage hands its input to the worker without a copy (`transferPlanes`):
    // the source to the conversion lane, the processed frame to the adjust
    // stage, the adjusted frame and the gain map's plane to the encoder, and a
    // 16-bit TIFF/PNG goes through one fused request. Whatever is left is
    // released once the file is encoded. If a worker dies holding a plane, the
    // frame is rendered once more, from decode, with copies.
    async function renderBatchExportFile(job, position, { exportInfo, workers, dustRemoval }, { transferPlanes = true } = {}) {
      const { file, settings } = job;
      if (exportInfo.format === 'dng') {
        const { source, settings: usedSettings } = await processFileWithSettings(file, settings, { stage: 'source', convert: workers.convert, geometryBands: workers.geometryBands, silent: true });
        return renderLinearDngBlobInSlices(source, usedSettings, position);
      }
      const sprocket = state.exportSprocketHolesEnabled;
      const metadata = exportMetadataFor(settings, position);
      const ownedPlanes = [];
      try {
        const { processed, settings: used } = await processFileWithSettings(file, settings, {
          stage: 'processed',
          silent: true,
          dustRemoval,
          dustWorker: workers.dust,
          convert: (transferPlanes && workers.convertHandoff) || workers.convert,
          geometryBands: workers.geometryBands,
          ownedPlanes
        });
        const adjustmentSettings = buildAdjustmentSettings(used);
        const wants16 = exportInfo.bitDepth === 16;

        // 16-bit TIFF/PNG without the sprocket frame: adjust and encode in one
        // worker request; the adjusted plane never comes to this thread. A
        // PNG16 band pool (#257) encodes in parallel instead: the adjusted
        // plane comes back by transfer and the pool takes its bands.
        if (wants16 && !sprocket && (exportInfo.format === 'tiff' || !workers.png16Pool)) {
          const blob = await encodeFused16(processed, adjustmentSettings, exportInfo, { bridge: workers.bridge, metadata, transferPlane: transferPlanes });
          if (blob) return blob;
        }

        // The sprocket frame drops the map, so only a plain JPEG asks for one.
        const gainMap = exportInfo.format === 'jpeg'
          && safeStorageGet('nc_hdr_gain_map_v1') !== 'off'
          && !sprocket
          && Boolean(processed.__image16);
        // The adjust stage may take its input unless the gain map still needs
        // the unadjusted plane (the 8-bit pass only takes `processed.data`).
        const adjusted = await applyPreparedAdjustmentsWithWorkers(processed, adjustmentSettings, {
          bitDepth: wants16 ? 16 : 8,
          bridge: workers.bridge,
          planeOnly: wants16 && !sprocket,
          transferPlane: transferPlanes
        });
        ownedPlanes.push(adjusted);
        if (gainMap) {
          // The map reads the unadjusted plane. An identity recipe shares that
          // plane with `adjusted`: drop the alias, so the transfer list never
          // names a buffer twice and the frame never encodes a detached view.
          if (adjusted.__image16 === processed.__image16) adjusted.__image16 = null;
          adjusted.__gainMapSource = { processed, adjustmentSettings, transferPlane: transferPlanes };
        }
        const outputImageData = await applySprocketFrameForExport(adjusted, exportInfo, settings, position);
        if (outputImageData !== adjusted) ownedPlanes.push(outputImageData);
        return await imageDataToBlob(
          outputImageData,
          exportInfo.format,
          state.jpegQuality,
          exportInfo.bitDepth,
          null,
          metadata,
          { bridge: workers.bridge, png16Pool: workers.png16Pool, transferPlane: transferPlanes }
        );
      } catch (err) {
        // A worker died holding one of this frame's planes. Render the frame
        // once more with copied planes so the file does not depend on the
        // failure.
        if (transferPlanes && (isExportInputLostError(err) || isConversionInputLost(err))) {
          console.warn(`A plane of ${file.name} was lost with its worker; rendering the frame again:`, err?.message || err);
          return await renderBatchExportFile(job, position, { exportInfo, workers, dustRemoval }, { transferPlanes: false });
        }
        throw err;
      } finally {
        // Encoders own their inputs by now (canvas toBlob snapshots at the call).
        releaseOwnedPlanes(...ownedPlanes);
      }
    }

    // Runs `jobs` through the pipeline, keeps the file-list statuses current
    // and releases the workers afterwards. `sink` writes one encoded frame and
    // throws to fail that frame; `signal` stops further frames from starting.
    async function runBatchExport(jobs, { exportInfo, sink, onProgress = null, signal = null, dustRemoval = null }) {
      const { lanes: plannedLanes, pixelsPerFile } = await planBatchExportLanes(jobs);
      // The crash-loop guard runs a resumed batch in one lane.
      const lanes = hiddenJobs.safeMode ? 1 : plannedLanes;
      const bytes = await hiddenJobBytesFor(jobs.map(job => job.file));
      const workers = createBatchExportWorkers(lanes, { pixelsPerFile, exportInfo });
      const trace = createPerfTrace('batchExport', { files: jobs.length, lanes });
      activeLongJobs += 1;
      try {
        return await runBatchPipeline(jobs, {
          maxParallel: lanes,
          signal,
          // Admission happens before a lane claims its next index (#241).
          beforeStart: ({ signal: stop }) => hiddenJobs.admit({ bytes, signal: stop }),
          process: (job, index) => renderBatchExportFile(job, job.markerIndex ?? index, { exportInfo, workers, dustRemoval }),
          sink,
          onEvent: (event) => {
            const { item } = event.job;
            if (event.type === 'start') {
              item.status = 'processing';
              item.error = null;
            } else if (event.type === 'done') {
              item.status = 'done';
              item.error = null;
            } else if (event.type === 'error') {
              console.error(`Error processing ${item.file.name}:`, event.error);
              item.status = 'error';
              item.error = event.error && event.error.message ? event.error.message : String(event.error || 'Unknown error');
            }
            updateFileListUI();
            if (onProgress) onProgress(event);
          }
        });
      } finally {
        activeLongJobs -= 1;
        workers.dispose();
        trace.end();
      }
    }

    function batchProgressLabel(done, total) {
      return i18n[currentLang].loadingBatchFile
        .replace('{current}', Math.min(total, done + 1))
        .replace('{total}', total);
    }

    function showBatchExportOverlay(onCancel) {
      return getLoadingOverlay().show({
        title: i18n[currentLang].loadingExporting,
        cancelable: true,
        cancelText: getLocalizedText('loadingCancel', 'Cancel'),
        onCancel
      });
    }

    function notifyBatchCancelled() {
      showToast(
        getLocalizedText('batchDownloadCancelled', 'Batch export cancelled. Files already saved were kept.'),
        3500
      );
    }

    async function exportBatchAsZipBrowser(selectedFiles, zipFileName, { markerAttempt = 0 } = {}) {
      if (!canUseBrowserZipStreaming(window)) {
        showToast(
          getLocalizedText(
            'zipStreamingUnsupportedFallback',
            'This browser cannot stream ZIP saves safely, so files will download individually instead.'
          ),
          5000
        );
        await exportBatchIndividuallyBrowser();
        return;
      }

      let streamTarget;
      try {
        streamTarget = await createBrowserZipWritable(zipFileName);
      } catch (err) {
        if (isBrowserSavePickerCancel(err)) {
          showToast(
            getLocalizedText(
              'zipStreamingCancelled',
              'ZIP save cancelled before batch processing started.'
            ),
            3500
          );
          return;
        }
        throw err;
      }

      if (!streamTarget || !streamTarget.writable) {
        showToast(
          getLocalizedText(
            'zipStreamingUnsupportedFallback',
            'This browser cannot stream ZIP saves safely, so files will download individually instead.'
          ),
          5000
        );
        await exportBatchIndividuallyBrowser();
        return;
      }

      const exportInfo = getExportInfo();
      const jobs = createBatchExportJobs(selectedFiles, exportInfo);
      const total = jobs.length;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const cancel = new AbortController();
      let zipWriter = null;
      // A partial archive has no central directory: after a kill the marker
      // only names the job and offers to start it again.
      const marker = beginExportJobMarker('export-zip', jobs, { destination: streamTarget.fileName || zipFileName, exportInfo, attempt: markerAttempt });

      resetBatchExportStatuses(jobs);
      await showBatchExportOverlay(() => cancel.abort());

      try {
        zipWriter = new ZipStoreWriter(streamTarget.writable);
        const result = await runBatchExport(jobs, {
          exportInfo,
          signal: cancel.signal,
          sink: async (job, blob) => {
            await zipWriter.addBlob(job.outputName, blob);
            marker.record(job.markerIndex);
            scheduleProjectRecovery();
          },
          onProgress: (event) => updateBatchOverlayProgress((event.done / total) * 95, batchProgressLabel(event.done, total))
        });
        batchOverlayProgress = null;

        overlay.updateProgress(98, lang.loadingBatchZip);
        await zipWriter.close();
        zipWriter = null;
        for (const { item } of jobs) if (item.status === 'done') void learnFromExport(item);
        overlay.updateProgress(100, lang.loadingComplete);
        if (result.cancelled) {
          notifyBatchCancelled();
        } else {
          showBrowserZipStreamSummary({
            zipFileName: streamTarget.fileName || zipFileName,
            successCount: result.successCount,
            failCount: result.failCount,
            total
          });
        }
      } catch (err) {
        if (zipWriter) {
          try {
            await zipWriter.abort();
          } catch (abortErr) {
            console.warn('Failed to abort ZIP stream:', abortErr);
          }
        }
        throw err;
      } finally {
        batchOverlayProgress = null;
        overlay.hide();
        marker.finish();
      }
    }

    async function exportBatchAsZip() {
      notifyReviewExport();
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;
      await exportBatchAsZipBrowser(selectedFiles, 'converted_negatives.zip');
    }

    function createBatchExportJobs(selectedFiles, exportInfo) {
      // Two source files can map to one output name (a RAW + JPEG pair, or the
      // same frame number in two folders); without this the second write
      // silently replaces the first.
      const claimName = createZipNameDeduper();
      return selectedFiles.map(({ item, index }, position) => ({
        item,
        index,
        // The job's place in the original list: its frame position for the
        // sprocket border and metadata, and its index in the job marker.
        markerIndex: position,
        file: item.file,
        outputName: claimName(buildActiveExportFileName(
          item.file.name,
          exportInfo,
          getSettingsForExport(index, item)
        )),
        settings: cloneSettings(getSettingsForExport(index, item))
      }));
    }

    function resetBatchExportStatuses(jobs) {
      jobs.forEach(({ item }) => {
        item.status = 'pending';
        item.error = null;
      });
      updateFileListUI();
    }

    function waitForNextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    function showDesktopBatchExportSummary({ successCount, failCount, total, targetDirectory }) {
      const folder = summarizePathForUi(targetDirectory) || targetDirectory || 'selected folder';
      const key = failCount > 0 ? 'desktopBatchExportSummaryErrors' : 'desktopBatchExportSummary';
      const fallback = failCount > 0
        ? `Exported ${successCount} / ${total} files, ${failCount} failed. Target: ${folder}.`
        : `Exported ${successCount} / ${total} files to ${folder}.`;
      showToast(
        getInterpolatedText(key, {
          success: successCount,
          total,
          failed: failCount,
          folder
        }, fallback),
        4500
      );
    }

    // The desktop batch shows no overlay (the editor stays usable), so its
    // cancel button lives in the header progress strip.
    let desktopBatchCancelController = null;
    document.getElementById('headerExportProgressCancel')?.addEventListener('click', () => {
      if (desktopBatchCancelController) desktopBatchCancelController.abort();
    });

    async function exportBatchIndividuallyDesktop() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      const targetDirectory = await pickDesktopExportDirectory();
      if (!targetDirectory) {
        showToast(
          getLocalizedText(
            'desktopBatchExportFolderCancelled',
            'Folder selection cancelled. No files were exported.'
          ),
          3500
        );
        return;
      }

      const exportInfo = getExportInfo();
      const jobs = createBatchExportJobs(selectedFiles, exportInfo);
      // Snapshot: toggling dust removal mid-batch must not change later frames.
      const dustRemoval = {
        enabled: Boolean(state.dustRemoval.enabled),
        strength: state.dustRemoval.strength,
        maxParticleSize: state.dustRemoval.maxParticleSize
      };
      const marker = beginExportJobMarker('export-folder', jobs, { destination: targetDirectory, exportInfo, dustRemoval });
      await runDesktopFolderExport(jobs, { targetDirectory, exportInfo, dustRemoval, marker });
    }

    // `jobs` may be the unwritten rest of an interrupted export (#241): each
    // job keeps its original position, name and marker index.
    async function runDesktopFolderExport(jobs, { targetDirectory, exportInfo, dustRemoval, marker }) {
      const total = jobs.length;
      const cancel = new AbortController();
      desktopBatchCancelController = cancel;

      resetBatchExportStatuses(jobs);
      setDesktopBatchExportState({
        active: true,
        current: 0,
        total,
        percent: 0,
        fileName: '',
        targetDirectory
      });
      await yieldForJob();

      let result;
      try {
        result = await runBatchExport(jobs, {
          exportInfo,
          dustRemoval,
          signal: cancel.signal,
          sink: async (job, blob) => {
            const saved = await writeBlobToDesktopDirectory(blob, targetDirectory, job.outputName, exportInfo.mimeType);
            // Recorded only once the native write returned (after its rename
            // or copy and sync), so a recorded file is complete. The recovery
            // copy then carries the recipe this frame was exported with.
            marker.record(job.markerIndex, saved.path || '');
            scheduleProjectRecovery();
            void learnFromExport(job.item);
          },
          onProgress: (event) => setDesktopBatchExportState({
            active: true,
            current: Math.min(total, event.done + 1),
            total,
            percent: (event.done / total) * 100,
            fileName: event.type === 'start' ? event.job.file.name : desktopBatchExportState.fileName,
            targetDirectory
          })
        });
      } finally {
        desktopBatchCancelController = null;
        resetDesktopBatchExportState();
        marker.finish();
      }

      if (result.cancelled) notifyBatchCancelled();
      showDesktopBatchExportSummary({ successCount: result.successCount, failCount: result.failCount, total, targetDirectory });
    }

    // Browser: each frame becomes its own download as soon as it is written.
    async function exportBatchIndividuallyBrowser() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      const exportInfo = getExportInfo();
      const jobs = createBatchExportJobs(selectedFiles, exportInfo);
      const marker = beginExportJobMarker('export-downloads', jobs, { exportInfo });
      await runBrowserDownloadsExport(jobs, { exportInfo, marker });
    }

    async function runBrowserDownloadsExport(jobs, { exportInfo, marker }) {
      const total = jobs.length;
      const overlay = getLoadingOverlay();
      const cancel = new AbortController();

      resetBatchExportStatuses(jobs);
      await showBatchExportOverlay(() => cancel.abort());

      let result;
      try {
        result = await runBatchExport(jobs, {
          exportInfo,
          signal: cancel.signal,
          sink: async (job, blob) => {
            const saved = await saveBlob(blob, job.outputName, exportInfo.mimeType);
            if (!saved.saved) {
              cancel.abort();
              throw new Error('Save cancelled');
            }
            marker.record(job.markerIndex);
            scheduleProjectRecovery();
            void learnFromExport(job.item);
          },
          onProgress: (event) => updateBatchOverlayProgress((event.done / total) * 100, batchProgressLabel(event.done, total))
        });
      } finally {
        batchOverlayProgress = null;
        overlay.hide();
        marker.finish();
      }

      if (result.cancelled) {
        console.info('Batch individual export cancelled by user.');
        notifyBatchCancelled();
      }
    }

    async function exportBatchIndividually() {
      notifyReviewExport();
      if (isTauriDesktop()) {
        await exportBatchIndividuallyDesktop();
        return;
      }
      await exportBatchIndividuallyBrowser();
    }

    // ===========================================
    // File List UI
    // ===========================================
    let fileSelectionAnchor = null;
    let reviewFilter = false;
    let fileOrderCache = null;
    function getFileListOrder() {
      // Files have immutable names/timestamps. Cache by queue identity, append
      // length and preference so thumbnail/status updates do not keep sorting.
      const mode = normalizeFileListSort(state.fileListSort);
      if (!fileOrderCache || fileOrderCache.queue !== state.fileQueue
        || fileOrderCache.length !== state.fileQueue.length || fileOrderCache.mode !== mode) {
        fileOrderCache = { queue: state.fileQueue, length: state.fileQueue.length,
          mode, order: orderedFileIndices(state.fileQueue, mode) };
      }
      return fileOrderCache.order;
    }
    function setFileListSort(mode) {
      if (singleExportActive || isDesktopBatchExportLocked()) return;
      state.fileListSort = normalizeFileListSort(mode);
      safeStorageSet('nc_photo_sort_v1', state.fileListSort);
      // Only the presentation order changes. Queue indices and item objects
      // remain stable for current edits, in-flight work and photo-session keys.
      updateFileListUI();
      studioWorkspace?.sync();
    }
    const reviewForItem = item => frameNeedsReview(item, item.file === state.loadedFile ? state : null);
    function updateReviewFilter() {
      const button = document.getElementById('studioReviewFilter');
      const count = state.fileQueue.filter(item => reviewForItem(item).needs).length;
      if (!button) return;
      if (!count) reviewFilter = false;
      button.hidden = !count;
      button.textContent = getInterpolatedText('reviewFilter', { count }, `Needs a look (${count})`);
      button.setAttribute('aria-pressed', String(reviewFilter));
      if (!button.dataset.bound) {
        button.dataset.bound = 'true';
        button.addEventListener('click', () => { reviewFilter = !reviewFilter; updateFileListUI(); });
      }
    }
    function notifyImportReview(items) {
      const converted = items.filter(item => item?.status === 'done');
      const review = converted.filter(item => reviewForItem(item).needs).length;
      if (review) showToast(getInterpolatedText('reviewImport', { count: converted.length, review }, `Converted ${converted.length} · ${review} need review`), 5000);
    }
    function notifyReviewExport(items = state.fileQueue.filter(item => item.selected)) {
      const count = items.filter(item => reviewForItem(item).needs).length;
      if (count) showToast(getInterpolatedText('reviewExport', { count }, `${count} frames were flagged for review and will be exported as they are.`), 5000);
    }
    // Inside the synchronous part of a photo switch the list is only marked
    // dirty; the switch then refreshes it once (switchToFile). Nothing else
    // defers it: callers rely on its synchronous side effects.
    let fileListRefreshDeferrals = 0;
    let fileListRefreshDeferred = false;
    function deferFileListRefresh() {
      fileListRefreshDeferrals += 1;
      let open = true;
      const close = ({ flush = true } = {}) => {
        if (!open) return;
        open = false;
        fileListRefreshDeferrals -= 1;
        if (flush && !fileListRefreshDeferrals && fileListRefreshDeferred) updateFileListUI();
      };
      // A deferral never outlives its task, even if the switch throws first.
      queueMicrotask(close);
      return close;
    }
    function updateFileListUI() {
      if (fileListRefreshDeferrals) { fileListRefreshDeferred = true; return; }
      fileListRefreshDeferred = false;
      renderFileListUI();
    }
    function renderFileListUI() {
      // Queue replacement/removal must also invalidate a delayed activation.
      if (state.photoSwitchTarget && !state.fileQueue.includes(state.photoSwitchTarget)) {
        ++loadGeneration;
        invalidatePhotoActivation();
        state.photoSwitchTarget = null;
        state.photoSwitchPhase = null;
        delete document.body.dataset.photoSwitching;
        delete document.body.dataset.studioBusy;
      }
      photoSessions.retainKeys(state.fileQueue);
      photoPreviews.retainKeys(state.fileQueue);
      syncEmbeddedPreviewQueue();
      const container = document.getElementById('fileListItems');
      const countEl = document.getElementById('fileListCount');
      updateReviewFilter();
      renderFileList({
        visible: item => !reviewFilter || reviewForItem(item).needs,
        onMarkReviewed: index => {
          const item = state.fileQueue[index];
          if (item.file === state.loadedFile) { pushUndo('reviewed'); state.reviewed = true; persistCurrentFileSettings({ force: true, silent: true }); }
          else item.settings = { ...(item.settings || {}), reviewed: true };
          updateFileListUI(); scheduleProjectRecovery();
        },
        container,
        countEl,
        items: state.fileQueue,
        order: getFileListOrder(),
        currentFileIndex: state.currentFileIndex,
        labels: {
          markReviewed: getLocalizedText('reviewMark', 'Mark as reviewed'),
          canReview: item => reviewForItem(item).needs && item.status !== 'error',
          configured: i18n[currentLang].configured || 'configured',
          customSettings: i18n[currentLang].customSettings || 'Custom',
          unsaved: i18n[currentLang].unsaved || 'Unsaved',
          statusText: (status) => i18n[currentLang][status === 'processing' ? 'processingStatus' : status] || status,
          selectFile: (name) => (i18n[currentLang].fileListSelectFile || 'Select {name}').replace('{name}', name),
          badges: (item) => {
            const badges = [];
            const review = reviewForItem(item);
            if (review.needs) badges.push({ className: 'needs-review', text: '?', title: review.reasons.map(key => getLocalizedText(key, key)).join(' · ') });
            // The open file's records live in state until its settings are persisted.
            const live = item.file === state.loadedFile;
            const edge = live && state.filmEdge ? state.filmEdge : item.settings?.filmEdge;
            if (edge?.found) {
              const name = edge.shortName || edge.filmName || (edge.dxNumber ? `DX ${edge.dxNumber}` : null);
              if (name) {
                badges.push({
                  className: 'film-stock',
                  text: name,
                  title: getInterpolatedText('filmEdgeBadgeTitle', { name: edge.filmName || name, dx: edge.dxNumber || '' }, `Film edge: ${name}`)
                });
              }
            }
            const roll = live && state.rollFrame ? state.rollFrame : item.settings?.rollFrame;
            if (roll?.outlier) {
              badges.push({
                className: 'roll-outlier',
                text: getLocalizedText('rollOutlierBadge', '≠ roll'),
                title: getInterpolatedText('rollOutlierBadgeTitle', { reasons: formatRollReasons(roll.reasons) }, `Differs from the roll: ${formatRollReasons(roll.reasons)}`)
              });
            }
            return badges;
          }
        },
        onToggleSelected: (index, selected, { range = false } = {}) => {
          const anchor = state.fileQueue.findIndex(item => item.id === fileSelectionAnchor);
          if (range && anchor >= 0) {
            const visibleOrder = getFileListOrder().filter(i => !reviewFilter || reviewForItem(state.fileQueue[i]).needs);
            for (const i of selectionRangeIndices(visibleOrder, anchor, index)) {
              state.fileQueue[i].selected = selected;
            }
          }
          fileSelectionAnchor = state.fileQueue[index].id;
          state.fileQueue[index].selected = selected;
          updateFileListUI();
          updateExportButtons();
        },
        onOpenFile: (index) => {
          switchToFile(index);
        }
      });

      updateAutoFrameButtons();
      syncBatchUIState({ reason: 'updateFileListUI' });
      refreshThumbnailStates();
      if (tileVisibility) observeTileVisibility();
      void loadStudioThumbnails();
    }

    async function switchToFile(index) {
      if (studioAutoFrameRunning || isDesktopBatchExportLocked() || singleExportActive) return;
      if (index < 0 || index >= state.fileQueue.length) return;
      if (index === state.currentFileIndex && state.fileQueue[index].file === state.loadedFile) return;
      // A dragged frame's 16-bit plane may still be in the preview worker. The
      // photo being left is remembered only once it is back.
      if (corePreviewRetained || corePreviewCommit) {
        await settleCorePreviewPlane();
        return switchToFile(index);
      }
      if (state.cropping) exitCropMode({ restore: false });
      if (state.beforeAfterActive) exitBeforeAfter();
      state.samplingMode = null;
      cancelProvisionalFrame();

      // Snapshot the file being left only if there is something to snapshot.
      // A file the user merely clicked through in Step 1/2 has no settings of
      // its own, and freezing live state into it marks it "configured", which
      // makes batch export skip its automatic film-base and gray-point passes.
      const leavingItem = getCurrentQueueItem();
      const fileItem = state.fileQueue[index];
      const cached = photoSessions.take(fileItem);
      // Leaving, restoring and the incoming tile would each refresh the whole
      // list. Refresh it once: before the cold feedback paints, or in finally.
      const flushFileList = deferFileListRefresh();
      let released = null;
      if (leavingItem?.provisional) {
        // Left while its detections still ran: its settings stay as they were
        // (null for a fresh photo, so roll analysis or the next visit detects
        // again), and only the decoded base is kept.
        leavingItem.isDirty = leavingItem.provisional.wasDirty;
        if (rememberPhotoBase(leavingItem)) released = leavingItem;
        delete leavingItem.provisional;
      } else if (leavingItem && leavingItem.file === state.loadedFile
        && (leavingItem.isDirty || leavingItem.settings || state.currentStep >= 3)) {
        persistCurrentFileSettings({ silent: true, force: true });
        if (rememberPhotoSession(leavingItem)) released = leavingItem;
      }
      state.currentFileIndex = index;
      state.photoSwitchTarget = null;
      state.photoSwitchPhase = null;
      document.body.dataset.photoSwitching = 'true';
      document.body.dataset.studioBusy = 'true';
      let generation = ++loadGeneration;
      invalidatePhotoActivation();
      try {
        // A settled cache hit is synchronous: do not paint a loading veil or
        // announce a new live-region message for an already available photo.
        if (cached?.snapshot && cached.file === fileItem.file && cached.key === photoSettingsKey(fileItem)) {
          state._pendingFullResBuffer = null;
          state._pendingFullResFileName = null;
          state._pendingFullResFile = null;
          state.loadedFile = fileItem.file;
          state.loadedBaseImageData = cached.base;
          state.rawMetadata = cached.rawMetadata;
          state.filmEdge = cached.filmEdge;
          expiredAnalysisKey = null;
          state.displayImageData = null;
          state.samplingMode = null;
          lensMapCache.clear();
          invalidateSilverCoreCache();
          // Preview raster size depends on zoom. Restore it before rebuilding
          // display sources, not after sampling them at the outgoing photo's zoom.
          state.zoomLevel = cached.zoom; state.panX = cached.panX; state.panY = cached.panY;
          const restoring = restoreSnapshot(cached.snapshot, { reprocess: false, previewOnly: cached.previewOnly });
          state.fullResolutionPending = cached.fullResolutionPending;
          state.dustRemoval.particleCount = cached.particleCount;
          undoStack.splice(0, undoStack.length, ...cached.undo);
          redoStack.splice(0, redoStack.length, ...cached.redo);
          applyZoomPanTransform();
          updateUndoRedoButtons();
          if (restoring) {
            // A session kept without its planes (#244): show the adjusted
            // preview while the pool rebuilds them from the base.
            const preview = photoPreviews.peek(fileItem);
            if (preview?.key === photoSettingsKey(fileItem)) {
              canvas.style.display = 'block'; glCanvas.style.display = 'none';
              renderAdjustedImageDataToMainCanvas(preview.image, preview.image);
            }
            await restoring;
            if (!isCurrentLoad(generation)) return;
          } else {
            updatePreview();
          }
          // Its tile already shows these pixels unless the settings moved on.
          if (fileItem.thumbnail && fileItem.thumbnailKind === 'processed'
            && fileItem.thumbnailKey === photoSettingsKey(fileItem)) adoptStudioThumbnailInputs(fileItem);
          else updateStudioThumbnail();
          if (state.fullResolutionPending) scheduleFullResolutionRender('photo-restored');
          scheduleAiRepairPreloadForRecipe();
          return;
        }

        // The outgoing photo lives in the session cache now.
        if (released) releaseOutgoingPhotoPlanes();

        state.photoSwitchTarget = fileItem;
        state.photoSwitchPhase = 'loading';
        flushFileList();
        studioWorkspace?.sync();
        // The veil shows the target's own pixels in this same task when the
        // app holds any. An exact 1200 px copy needs no camera JPEG, and a
        // retained decoded base reaches the exact positive in ~0.3 s.
        const presented = presentRetainedPreview(fileItem);
        if (presented !== 'cached' && !(cached?.base && cached.file === fileItem.file)) requestProvisionalFrame(fileItem);
        // Paint the target identity before decoder or cached-base preparation
        // can occupy the main thread. Hidden tabs need not await a paused rAF.
        await yieldToPaint();
        if (!isCurrentLoad(generation) || state.fileQueue[index] !== fileItem) return;

        // Load the file
        const loading = loadFile(fileItem.file, { autoConvert: false, decoded: cached, quiet: true });
        generation = loadGeneration;
        const result = await loading;

        // A newer switch may have started (and finished) while this decode ran;
        // applying these settings now would stamp them onto the file the user is
        // actually looking at.
        if (!isCurrentLoad(generation) || state.fileQueue[index] !== fileItem) return;
        if (result?.status !== 'loaded') {
          if (result?.status === 'error') {
            fileItem.status = 'error';
            fileItem.error = result.message;
            // Presentation images live on the veil, never on #canvas: the
            // outgoing photo's display is untouched and needs no restoring.
            state.currentFileIndex = state.fileQueue.findIndex(item => item.file === state.loadedFile);
            // Planes released for the switch come back through the outgoing
            // photo's session.
            if (released) reactivateReleasedPhoto(released);
          }
          return;
        }
        state.photoSwitchPhase = 'preparing';
        studioWorkspace?.sync();
        resetZoomPan();

        // If this file has saved settings, restore them
        if (fileItem.settings) {
          restoreSettings(fileItem.settings, { refreshDisplay: false });
          fileItem.isDirty = false;
        }

        await prepareStudioPhoto(generation, fileItem, { quiet: true });
      } catch (error) {
        if (!isCurrentLoad(generation)) return;
        console.error('Error switching photo:', error);
        fileItem.status = 'error';
        fileItem.error = String(error?.message || error);
        state.currentFileIndex = state.fileQueue.findIndex(item => item.file === state.loadedFile);
        if (released && state.loadedFile !== fileItem.file) reactivateReleasedPhoto(released);
        showToast(getLocalizedText('loadError', 'Error loading file'));
      } finally {
        // The warm switch's refresh is the one below.
        flushFileList({ flush: !isCurrentLoad(generation) });
        // An old completion must never clear the newest target's feedback.
        if (isCurrentLoad(generation)) {
          cancelProvisionalFrame();
          state.photoSwitchTarget = null;
          state.photoSwitchPhase = null;
          delete document.body.dataset.photoSwitching;
          delete document.body.dataset.studioBusy;
          updateFileListUI();
          studioWorkspace?.sync();
          void loadStudioThumbnails();
        }
      }
    }

    // Save current settings to the current file's queue entry
    function saveCurrentFileSettings() {
      persistCurrentFileSettings({ silent: false, force: true });
      void learnFromExport(getCurrentQueueItem());
    }

    function restoreAutoFrameDiagnostics(meta) {
      if (meta) {
        const restoredMode = meta.appliedMode
          || (Boolean(meta.rotateOnly) ? 'rotateOnly' : 'none');
        state.autoFrame.lastDiagnostics = {
          confidence: meta.confidence,
          detectedFormat: meta.detectedFormat || 'unknown',
          method: meta.method || 'unknown',
          confidenceLevel: meta.confidenceLevel || inferConfidenceLevel(meta.confidence || 0),
          rotateOnly: restoredMode === 'rotateOnly',
          appliedMode: restoredMode,
          lowConfidenceApplied: Boolean(meta.lowConfidenceApplied),
          importAuto: Boolean(meta.importAuto),
          imageArea: meta.imageArea ? structuredClone(meta.imageArea) : null,
          analysisArea: meta.analysisArea ? structuredClone(meta.analysisArea) : null,
          analysisNeedsReview: Boolean(meta.analysisNeedsReview),
          frameIncomplete: Boolean(meta.frameIncomplete)
        };
      } else {
        state.autoFrame.lastDiagnostics = null;
      }
      updateAutoFrameDiagnosticsUI();
    }

    // Applies only the META_ONLY_KEYS of `settings` (what the import
    // detections describe), exactly as restoreSettings would, without touching
    // geometry or the rendered pixels. Used when the final import settings
    // convert identically to the provisional ones.
    function applyImportMetaToState(settings) {
      const safe = sanitizeSettings(settings, { fallbackSettings: state });
      restoreAutoFrameDiagnostics(safe.autoFrameMeta);
      state.filmTypeSource = safe.filmTypeSource;
      state.filmTypeConfidence = safe.filmTypeConfidence;
      state.filmTypeReason = safe.filmTypeReason;
      state.filmEdge = safe.filmEdge ? structuredClone(safe.filmEdge) : null;
      updateFilmEdgeUI();
      state.learnedDefaults = safe.learnedDefaults;
      state.frameMetadata = sanitizeFrameMetadata(safe.frameMetadata);
      prefillRollStockFromFilmEdge();
      updateMetadataUI();
      updateFilmModeUI();
      studioWorkspace?.sync();
    }

    // Restore settings from a saved settings object
    function restoreSettings(settings, { refreshDisplay = true } = {}) {
      if (!settings) return;
      const safe = sanitizeSettings(settings, { fallbackSettings: state });

      state.rotationAngle = Number.isFinite(safe.rotationAngle) ? normalizeAngleDegrees(safe.rotationAngle) : 0;
      state.mirrored = Boolean(safe.mirrored);
      updateMirrorButtonState();

      // Rotation, mirror and crop from the base; kept as is when the
      // installed planes were already built for this geometry.
      applyGeometryFromBase({ cropRegion: safe.cropRegion, refreshDisplay });
      if (state.originalImageData) {
        safe.rotationAngle = state.rotationAngle;
        safe.cropRegion = state.cropRegion ? { ...state.cropRegion } : null;
      }

      restoreAutoFrameDiagnostics(safe.autoFrameMeta);

      // Restore film settings
      state.filmType = sanitizePresetType(safe.filmType || 'color');
      state.positiveMode = safe.positiveMode;
      state.filmTypeSource = safe.filmTypeSource;
      state.filmTypeConfidence = safe.filmTypeConfidence;
      state.filmTypeReason = safe.filmTypeReason;
      state.filmBase = { ...safe.filmBase };
      state.filmBaseSet = true;
      state.filmEdge = safe.filmEdge ? structuredClone(safe.filmEdge) : null;
      updateFilmEdgeUI();
      state.semanticMap = safe.semanticMap;
      state.learnedDefaults = safe.learnedDefaults;
      state.reviewed = safe.reviewed;
      state.wbUserOverride = safe.wbUserOverride;
      state.wbSemanticApplied = safe.wbSemanticApplied;
      state.rollFrame = safe.rollFrame ? structuredClone(safe.rollFrame) : null;
      updateRollAnalysisUI();
      state.lensCorrection.enabled = Boolean(safe.lensCorrection.enabled);
      state.lensCorrection.selectedLens = safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null;
      state.lensCorrection.params = { ...safe.lensCorrection.params };
      state.lensCorrection.modes = { ...safe.lensCorrection.modes };
      state.lensCorrection.lastError = safe.lensCorrection.lastError || '';
      if (state.lensCorrection.selectedLens) {
        state.lensCorrection.search.lensModel = state.lensCorrection.selectedLens.model || state.lensCorrection.search.lensModel;
        state.lensCorrection.search.lensMaker = state.lensCorrection.selectedLens.maker || state.lensCorrection.search.lensMaker;
      }
      state.lensCorrection.statusKey = state.lensCorrection.enabled
        ? (state.lensCorrection.selectedLens ? 'lensStatusSelected' : 'lensStatusNeedProfile')
        : 'lensStatusSkipped';
      state.lensCorrection.statusVars = state.lensCorrection.selectedLens
        ? { lens: formatLensLabel(state.lensCorrection.selectedLens) }
        : {};

      // Restore adjustments
      state.coreFilmPreset = safe.coreFilmPreset || 'none';
      state.coreColorModel = safe.coreColorModel;
      state.coreEnhancedProfile = safe.coreEnhancedProfile;
      state.coreProfileStrength = safe.coreProfileStrength;
      state.corePreSaturation = safe.corePreSaturation;
      state.coreBorderBuffer = safe.coreBorderBuffer;
      state.coreBorderBufferBorderValue = safe.coreBorderBufferBorderValue;
      state.coreBrightness = safe.coreBrightness;
      state.coreExposure = safe.coreExposure;
      state.coreContrast = safe.coreContrast;
      state.coreHighlights = safe.coreHighlights;
      state.coreShadows = safe.coreShadows;
      state.coreWhites = safe.coreWhites;
      state.coreBlacks = safe.coreBlacks;
      state.coreWbMode = safe.coreWbMode;
      state.coreTemperature = safe.coreTemperature;
      state.coreTint = safe.coreTint;
      state.coreCyan = safe.coreCyan ?? 0;
      state.corePaper = safe.corePaper || 'none';
      state.corePaperToning = safe.corePaperToning || 'none';
      state.corePaperToningStrength = safe.corePaperToningStrength ?? 100;
      state.localExposure = safe.localExposure ? structuredClone(safe.localExposure) : null;
      state.repairStrokes = sanitizeRepairStrokes(safe.repairStrokes).slice();
      state.flatFieldId = safe.flatFieldId && state.flatFields[safe.flatFieldId] ? safe.flatFieldId : null;
      updateFlatFieldUI();
      state.look = safe.look ? structuredClone(safe.look) : null;
      for (const key of EXPIRED_RESCUE_KEYS) state[key] = safe[key];
      state.expiredAnalysis = safe.expiredAnalysis ? structuredClone(safe.expiredAnalysis) : null;
      // A saved measurement belongs to this file; adopt it instead of re-measuring.
      expiredAnalysisKey = null;
      state.frameMetadata = sanitizeFrameMetadata(safe.frameMetadata);
      prefillRollStockFromFilmEdge();
      updateMetadataUI();
      updateRecipeUI();
      updateLabMatchUI();
      updateExpiredRescueUI();
      state.coreSaturation = safe.coreSaturation;
      state.coreGlow = safe.coreGlow;
      state.coreFade = safe.coreFade;
      state.coreCurvePrecision = safe.coreCurvePrecision;
      state.coreUseWebGL = safe.coreUseWebGL;

      state.exposure = safe.exposure;
      state.contrast = safe.contrast;
      state.highlights = safe.highlights;
      state.shadows = safe.shadows;
      state.temperature = safe.temperature;
      state.tint = safe.tint;
      state.vibrance = safe.vibrance;
      state.saturation = safe.saturation;
      state.cyan = safe.cyan;
      state.magenta = safe.magenta;
      state.yellow = safe.yellow;
      state.wbR = safe.wbR;
      state.wbG = safe.wbG;
      state.wbB = safe.wbB;
      // Non-unity gains without a recorded origin mean the user set them (old
      // snapshots, manual tweaks), so treat them as sampled. Gains the auto
      // estimator produced are exempt — they stay auto-owned across file
      // switches so a later conversion may refresh them.
      state.wbAutoConfidence = safe.wbAutoConfidence || null;
      state.wbUserOverride = Boolean(safe.wbUserOverride);
      state.grayPointSampled = Boolean(
        safe.grayPointSampled
        || (!safe.wbAutoConfidence && (
          Math.abs(safe.wbR - 1) > 0.01
          || Math.abs(safe.wbB - 1) > 0.01
        ))
      );
      state.frontierGuideStep2ChoiceTouched = state.coreColorModel !== 'standard' || state.coreFilmPreset !== 'none';
      state.frontierGuideAutoAppliedForImage = state.frontierGuideStep2ChoiceTouched;

      // Restore curves
      state.curvePoints = {
        r: safe.curvePoints.r.map(p => ({ ...p })),
        g: safe.curvePoints.g.map(p => ({ ...p })),
        b: safe.curvePoints.b.map(p => ({ ...p }))
      };
      ['r', 'g', 'b'].forEach(ch => updateCurveFromPoints(ch));

      // Update UI to reflect restored settings
      updateSlidersFromState();
      renderCurve();
      updateLensCorrectionUI();
    }

    // Update all slider UI elements from state
    function updateSlidersFromState() {
      syncAllSlidersFromState();
      syncAllSelectsFromState();
      syncAllCheckboxesFromState();

      // Update film type buttons
      setFilmTypeButtons(state.filmType);
      updateFilmModeUI();
      updateLensCorrectionUI();
      updateConsoleReadouts();
      updateEnlargerUI();
      updatePaperUI();
      updateDodgeBurnUI();
      studioWorkspace?.sync();
    }

    function updateExportButtons() {
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      const exportLocked = singleExportActive || isDesktopBatchExportLocked();
      const exportBtn = document.getElementById('exportBtn');
      const exportSprocketBtn = document.getElementById('exportSprocketBtn');
      const exportSingleBtn = document.getElementById('exportSingleBtn');
      const exportZipBtn = document.getElementById('exportZipBtn');
      const exportAllBtn = document.getElementById('exportAllBtn');
      if (exportBtn) exportBtn.disabled = exportLocked;
      if (exportSprocketBtn) exportSprocketBtn.disabled = exportLocked;
      if (exportSingleBtn) exportSingleBtn.disabled = exportLocked;
      if (exportZipBtn) exportZipBtn.disabled = selectedCount < 1 || exportLocked;
      if (exportAllBtn) exportAllBtn.disabled = selectedCount < 1 || exportLocked;
      const contactSheetBtn = document.getElementById('exportContactSheetBtn');
      if (contactSheetBtn) contactSheetBtn.disabled = selectedCount < 1 || exportLocked;
      updateAutoFrameButtons();
      studioWorkspace?.sync();
    }

    function normalizeAutoFrame120Options() {
      const map = state.autoFrame.allowed120Formats || {};
      const anyEnabled = AUTO_FRAME_DEFAULT_120_FORMATS.some(fmt => map[fmt] !== false);
      if (!anyEnabled) {
        map['6x6'] = true;
      }
      AUTO_FRAME_DEFAULT_120_FORMATS.forEach(fmt => {
        if (typeof map[fmt] !== 'boolean') {
          map[fmt] = true;
        }
      });
      state.autoFrame.allowed120Formats = map;
    }

    function updateAutoFrameConfigUI() {
      const enabledInput = document.getElementById('autoFrameEnabledInput');
      const autoApplyInput = document.getElementById('autoFrameAutoApplyInput');
      const formatSelect = document.getElementById('autoFrameFormatSelect');
      const lowSelect = document.getElementById('autoFrameLowConfidenceSelect');
      const optionsContainer = document.getElementById('autoFrame120Options');
      if (!enabledInput || !autoApplyInput || !formatSelect || !lowSelect) return;

      normalizeAutoFrame120Options();
      enabledInput.checked = Boolean(state.autoFrame.enabled);
      autoApplyInput.checked = Boolean(state.autoFrame.autoApplyHighConfidence);
      const rotate180Input = document.getElementById('autoFrameRotate180Input');
      if (rotate180Input) rotate180Input.checked = Boolean(state.autoFrame.rotate180Default);
      formatSelect.value = state.autoFrame.formatPreference || 'auto';
      lowSelect.value = state.autoFrame.lowConfidenceBehavior || 'suggest';
      AUTO_FRAME_DEFAULT_120_FORMATS.forEach(format => {
        const option = document.getElementById('autoFrame120_' + format.replace(/\D/g, ''));
        if (option) option.checked = state.autoFrame.allowed120Formats[format] !== false;
      });
      if (optionsContainer) {
        optionsContainer.style.opacity = formatSelect.value === '135' ? '0.55' : '1';
      }
    }

    function formatDetectedFormatLabel(formatKey) {
      if (!formatKey || formatKey === 'unknown') return 'unknown';
      if (formatKey === '135') return '135';
      if (String(formatKey).startsWith('120-')) return formatKey.replace('120-', '120 ');
      return String(formatKey);
    }

    function formatAppliedModeLabel(mode) {
      const normalized = mode === 'crop' || mode === 'rotateOnly' ? mode : 'none';
      if (normalized === 'crop') {
        return getLocalizedText('autoFrameModeCrop', 'Crop');
      }
      if (normalized === 'rotateOnly') {
        return getLocalizedText('autoFrameModeRotateOnly', 'Rotate only');
      }
      return getLocalizedText('autoFrameModeNone', 'None');
    }

    function updateAutoFrameDiagnosticsUI() {
      const box = document.getElementById('autoFrameDiagnosticsBox');
      if (!box) return;
      const diag = state.autoFrame.lastDiagnostics;
      if (!diag) {
        box.style.display = 'none';
        box.textContent = '';
        return;
      }
      const template = i18n[currentLang].autoFrameDiagnostics
        || 'Detection: method {method} | format {format} | confidence {confidence}';
      const appliedMode = diag.appliedMode || (diag.rotateOnly ? 'rotateOnly' : 'none');
      box.textContent = template
        .replace('{method}', String(diag.method || 'unknown'))
        .replace('{format}', formatDetectedFormatLabel(diag.detectedFormat))
        .replace('{confidence}', Number.isFinite(diag.confidence) ? diag.confidence.toFixed(2) : '0.00')
        .replace('{mode}', formatAppliedModeLabel(appliedMode));
      box.style.display = 'block';
      box.dataset.angle = String(state.rotationAngle || 0);
    }

    function applyAutoFrameConfigFromUI() {
      const enabledInput = document.getElementById('autoFrameEnabledInput');
      const autoApplyInput = document.getElementById('autoFrameAutoApplyInput');
      const formatSelect = document.getElementById('autoFrameFormatSelect');
      const lowSelect = document.getElementById('autoFrameLowConfidenceSelect');

      if (enabledInput) state.autoFrame.enabled = Boolean(enabledInput.checked);
      if (autoApplyInput) state.autoFrame.autoApplyHighConfidence = Boolean(autoApplyInput.checked);
      const rotate180Input = document.getElementById('autoFrameRotate180Input');
      if (rotate180Input) state.autoFrame.rotate180Default = Boolean(rotate180Input.checked);
      if (formatSelect) state.autoFrame.formatPreference = ['135', '120', '135-standard'].includes(formatSelect.value) || Object.hasOwn(AUTO_FRAME_FORMAT_RATIOS, formatSelect.value) ? formatSelect.value : 'auto';
      if (lowSelect) {
        const value = lowSelect.value;
        state.autoFrame.lowConfidenceBehavior = (value === 'rotateOnly' || value === 'ignore') ? value : 'suggest';
      }

      state.autoFrame.allowed120Formats = Object.fromEntries(AUTO_FRAME_DEFAULT_120_FORMATS.map(format => [
        format, document.getElementById('autoFrame120_' + format.replace(/\D/g, ''))?.checked !== false
      ]));
      normalizeAutoFrame120Options();
      updateAutoFrameConfigUI();
      updateAutoFrameButtons();
      studioWorkspace?.sync();
    }

    function updateAutoFrameButtons() {
      const currentBtn = document.getElementById('autoFrameBtn');
      const selectedBtn = document.getElementById('autoFrameSelectedBtn');
      if (!currentBtn || !selectedBtn) return;

      const stepReady = !state.cropping && !document.body.dataset.studioBusy && !isDesktopBatchExportLocked();
      currentBtn.disabled = !state.originalImageData || !state.autoFrame.enabled || !stepReady;
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      selectedBtn.disabled = !state.autoFrame.enabled || selectedCount < 1 || !stepReady;
      updateAutoFrameConfigUI();
      updateRollAnalysisUI();
      updateFlatFieldUI();
      updateLabMatchUI();
    }

    function showBatchUI(show, reason) {
      setFileListVisible(show, reason || 'showBatchUI');
      updateBatchStep3GuideVisibility();
    }

    // Select all button
    document.getElementById('selectAllBtn').addEventListener('click', () => {
      state.fileQueue.forEach(item => item.selected = true);
      updateFileListUI();
      updateExportButtons();
    });

    // Select none button
    document.getElementById('selectNoneBtn').addEventListener('click', () => {
      state.fileQueue.forEach(item => item.selected = false);
      updateFileListUI();
      updateExportButtons();
    });

    // Save settings button
    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      if (state.currentStep < 3) {
        void appAlert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }
      saveCurrentFileSettings();
    });

    document.getElementById('applyToSelectedBtn').addEventListener('click', () => {
      applyCurrentSettingsToSelected();
    });

    document.getElementById('setRollReferenceBtn').addEventListener('click', () => {
      setRollReferenceFromCurrent();
    });

    document.getElementById('applyRollReferenceBtn').addEventListener('click', () => {
      applyRollReferenceToSelected();
    });

    document.getElementById('clearRollReferenceBtn').addEventListener('click', () => {
      clearRollReference();
    });

    document.getElementById('lockRollReference').addEventListener('change', (e) => {
      state.rollReference.applyLock = Boolean(e.target.checked);
      updateRollReferenceUI();
    });

    document.getElementById('applyCropWithReference').addEventListener('change', (e) => {
      state.rollReference.applyCrop = Boolean(e.target.checked);
      updateRollReferenceUI();
    });

    ['autoFrameEnabledInput', 'autoFrameAutoApplyInput', 'autoFrameRotate180Input', 'autoFrameFormatSelect',
      'autoFrameLowConfidenceSelect', 'autoFrame120_645', 'autoFrame120_66', 'autoFrame120_67', 'autoFrame120_68', 'autoFrame120_69', 'autoFrame120_612', 'autoFrame120_617']
      .forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', applyAutoFrameConfigFromUI);
      });
    updateAutoFrameConfigUI();

    function openAddFilesPicker() {
      if (isDesktopBatchExportLocked()) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.cr2,.cr3,.crw,.nef,.nrw,.arw,.dng,.raf,.raw,.rw2,.pef,.srw,.3fr,.mef,.orf,.rwl,.iiq,.x3f,.mrw,.kdc,.dcr,.tif,.tiff,image/*';
      input.onchange = (e) => {
        if (isDesktopBatchExportLocked()) return;
        if (e.target.files.length > 0) {
          addFilesToQueue(Array.from(e.target.files));
          if (!state.originalImageData && state.fileQueue.length > 0) {
            loadFile(state.fileQueue[state.currentFileIndex].file);
          }
        }
      };
      input.click();
    }

    // Add more files button
    document.getElementById('addMoreFilesBtn').addEventListener('click', () => {
      openAddFilesPicker();
    });

    // Add files button in toolbar (single image + batch)
    document.getElementById('addFilesToolbarBtn').addEventListener('click', () => {
      openAddFilesPicker();
    });

    // Clear file list button
    document.getElementById('clearFileListBtn').addEventListener('click', () => {
      if (isDesktopBatchExportLocked()) return;
      void stopHotFolder();
      state.fileQueue = [];
      state.rollMetadata = sanitizeRollMetadata({});
      updateMetadataUI();
      pendingProject = null;
      void clearProjectRecovery();
      state.currentFileIndex = 0;
      state.batchSessionActive = false;
      resetRollReferenceState();
      updateFileListUI();
      syncBatchUIState({ reason: 'clearFileListBtn' });
      updateExportButtons();
    });

    function createQueueItemId(file) {
      return `${file.name}::${file.size}::${file.lastModified || 0}`;
    }

    function addFilesToQueue(files) {
      // Filter for supported image files
      const supportedExtensions = ['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.dng', '.raf', '.raw', '.rw2', '.pef', '.srw', '.3fr', '.mef', '.orf', '.rwl', '.iiq', '.x3f', '.mrw', '.kdc', '.dcr', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.hif'];
      const validFiles = files.filter(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return supportedExtensions.includes(ext) || file.type.startsWith('image/');
      });

      if (validFiles.length === 0) return;

      const imported = [];
      const importId = crypto.randomUUID();
      const queuedIds = new Set(state.fileQueue.map(item => item.id));
      // Add files to queue
      for (const file of validFiles) {
        // Avoid duplicates
        const id = createQueueItemId(file);
        if (!queuedIds.has(id)) {
          queuedIds.add(id);
          const newItem = {
            id,
            importId,
            touchedKeys: new Set(),
            file: file,
            selected: true,  // Selected by default
            status: 'pending',
            error: null,
            settings: null,  // null = use auto-detect, otherwise saved settings
            isDirty: false
          };
          if (hasRollReference() && state.rollReference.applyLock) {
            const applied = applySettingsToItems(
              state.rollReference.settingsSnapshot,
              [newItem],
              { includeCrop: state.rollReference.applyCrop }
            );
            if (applied > 0) {
              newItem.status = 'pending';
            }
          }
          state.fileQueue.push(newItem);
          imported.push(newItem);
        }
      }

      if (state.fileQueue.length > 1) {
        state.batchSessionActive = true;
      }
      syncBatchUIState({ reason: 'addFilesToQueue' });
      if (imported.length >= 3) scheduleAutomaticRollImport(imported);

      updateFileListUI();
      queueEmbeddedTiles(imported);
      updateExportButtons();
      void loadStudioThumbnails();
      scheduleProjectRecovery();
    }

    // ===========================================
    // File Input Handling
    // ===========================================
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadFolderBtn = document.getElementById('uploadFolderBtn');
    const folderPickerHint = document.getElementById('folderPickerHint');

    function supportsFolderPicker() {
      return !!(folderInput && ('webkitdirectory' in folderInput));
    }

    function handleUploadLabelKeydown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const label = e.currentTarget;
      if (!label || label.getAttribute('aria-disabled') === 'true') return;
      const inputId = label.getAttribute('for');
      if (!inputId) return;
      const input = document.getElementById(inputId);
      if (!input) return;
      e.preventDefault();
      input.value = '';
      input.click();
    }

    function applyFolderPickerAvailability() {
      if (!uploadFolderBtn) return;
      if (supportsFolderPicker()) {
        uploadFolderBtn.classList.remove('is-disabled');
        uploadFolderBtn.removeAttribute('aria-disabled');
        uploadFolderBtn.setAttribute('for', 'folderInput');
        uploadFolderBtn.tabIndex = 0;
        if (folderPickerHint) folderPickerHint.classList.remove('visible');
        return;
      }
      uploadFolderBtn.classList.add('is-disabled');
      uploadFolderBtn.setAttribute('aria-disabled', 'true');
      uploadFolderBtn.removeAttribute('for');
      uploadFolderBtn.tabIndex = -1;
      if (folderPickerHint) folderPickerHint.classList.add('visible');
    }

    // Import intent (opening a picker, dragging files in, watching a folder)
    // starts what the first photo needs: the RAW loader chunk, the OpenCV
    // frame detector and the preview conversion worker. Never on page load:
    // an unused OpenCV worker ends on its own 30 s idle timer.
    const IMPORT_WARM_UP_INTERVAL_MS = 30_000;
    let importWarmUpAt = -Infinity;
    // The monotonic clock of the import warm-up and the MI-GAN idle release
    // (#236); the trace helpers that also had one live in perfTrace.js (#230).
    function getPerfNow() {
      return performance.now();
    }
    function warmImportPipeline() {
      const now = getPerfNow();
      if (now - importWarmUpAt < IMPORT_WARM_UP_INTERVAL_MS) return;
      importWarmUpAt = now;
      void import('./rawFileLoader.js').catch(() => {});
      if (state.autoFrame.enabled) void warmUpAutoFrameWorker();
      void convertPreviewFrameInWorker.warmUp();
    }

    const uploadExpiredBtn = document.getElementById('uploadExpiredBtn');
    [uploadBtn, uploadFolderBtn, uploadExpiredBtn].forEach(label => {
      if (!label) return;
      label.addEventListener('keydown', handleUploadLabelKeydown);
      label.addEventListener('pointerdown', warmImportPipeline);
      label.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') warmImportPipeline();
      });
    });
    document.addEventListener('dragenter', (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) warmImportPipeline();
    });
    // The separate entry for an expired roll: the same picker, with the
    // session switched to rescue before the photos arrive.
    uploadExpiredBtn?.addEventListener('click', () => setExpiredSession(true, { fromEntry: true }));
    uploadExpiredBtn?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') setExpiredSession(true, { fromEntry: true });
    });

    applyFolderPickerAvailability();

    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
    folderInput.addEventListener('click', () => {
      folderInput.value = '';
    });

    fileInput.addEventListener('change', (e) => {
      if (isDesktopBatchExportLocked()) return;
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      const projectFile = files.find((file) => isProjectFileName(file.name));

      // Reset state for new batch
      void stopHotFolder();
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.mirrored = false;
      updateMirrorButtonState();
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'fileInput_change_reset' });

      addFilesToQueue(files);

      // A project file among the drop restores the roll once the photos are queued.
      if (projectFile) {
        void openProjectFile(projectFile);
      } else if (pendingProject) {
        void applyPendingProject();
      } else if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    folderInput.addEventListener('change', (e) => {
      if (isDesktopBatchExportLocked()) return;
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      const projectFile = files.find((file) => isProjectFileName(file.name));

      // Reset state for new batch
      void stopHotFolder();
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.mirrored = false;
      updateMirrorButtonState();
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'folderInput_change_reset' });

      addFilesToQueue(files);

      // A project file among the drop restores the roll once the photos are queued.
      if (projectFile) {
        void openProjectFile(projectFile);
      } else if (pendingProject) {
        void applyPendingProject();
      } else if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    // A file dropped outside the canvas would otherwise hit the browser
    // default and navigate the tab to that image, discarding the file queue,
    // per-file settings, roll reference and undo history without warning.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    canvasContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      canvasContainer.style.borderColor = 'var(--accent)';
    });

    canvasContainer.addEventListener('dragleave', () => {
      canvasContainer.style.borderColor = '';
    });

    canvasContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      canvasContainer.style.borderColor = '';
      if (isDesktopBatchExportLocked()) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const projectFile = files.find((file) => isProjectFileName(file.name));

      // Reset state for new batch
      void stopHotFolder();
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.mirrored = false;
      updateMirrorButtonState();
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'drop_reset' });

      addFilesToQueue(files);

      // A project file among the drop restores the roll once the photos are queued.
      if (projectFile) {
        void openProjectFile(projectFile);
      } else if (pendingProject) {
        void applyPendingProject();
      } else if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    // ===========================================
    // Window Resize
    // ===========================================
    // Fits the canvas to the container after it changed size. The GL drawing
    // buffer follows the texture, so this never clears it; the draw only
    // refits the CSS box to the texture, as every renderWebGL does.
    function refitCanvasToContainer() {
      if (canvas.width > 0 && canvas.height > 0) {
        adjustCanvasDisplay(canvas.width, canvas.height);
        if (isWebGLActive() && !state.beforeAfterActive && !state.cropping) renderWebGL();
      }
      if (state.cropping) updateCropOverlayFromDraft();
      scheduleDisplayPreviewResize();
    }

    window.addEventListener('resize', () => {
      // The observer reports this size only after this handler in the same
      // frame, so read live layout first rather than fit to the old size.
      refreshCanvasContainerSize();
      refitCanvasToContainer();
      const histogramResized = resizeHistogramCanvas();
      if (histogramResized) redrawHistogramIfPossible();
      if (curveCanvas.getBoundingClientRect().width > 0) renderCurve();
    });

    // Container-only resizes (a panel, the film strip) fire no window resize.
    if (typeof ResizeObserver === 'function') {
      canvasContainerSize.observed = true;
      canvasContainerSize.valid = false;
      new ResizeObserver(() => {
        // Layout is clean while observers run, so this read is free. The
        // observer reports only real size changes; refit even when a live
        // read elsewhere has already brought the cache up to date.
        refreshCanvasContainerSize();
        refitCanvasToContainer();
      }).observe(canvasContainer);
    }

    // devicePixelRatio changes (moving the window to another display) resize
    // the display preview. The query matches one ratio, so re-arm each time.
    function watchDevicePixelRatio() {
      if (typeof window.matchMedia !== 'function') return;
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      const onChange = () => {
        if (query.removeEventListener) query.removeEventListener('change', onChange);
        else query.removeListener?.(onChange);
        watchDevicePixelRatio();
        invalidateCanvasDisplayFit();
        scheduleDisplayPreviewResize();
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else query.addListener?.(onChange);
    }
    watchDevicePixelRatio();

    let automaticRollImportRunning = false;
    let automaticRollAnalysisRunning = false;
    let manualRollAnalysisRunning = false;
    let automaticRollRevision = 0;
    // Frames a scheduled roll analysis will prepare. Their first photo skips
    // the semantic pass: the roll assigns (and locks) its recipe meanwhile.
    const automaticRollPendingItems = new Set();
    let studioThumbnailsRunning = false;
    function fileListButtonFor(item) {
      const index = state.fileQueue.indexOf(item);
      return index < 0 ? null : document.querySelector(`#fileListItems .file-list-name[data-index="${index}"]`);
    }
    // `refresh: false` leaves the row's state to a later refreshThumbnailStates
    // (a batch of embedded tiles publishes in one pass per frame, #235).
    function updateFileThumbnail(item, { refresh = true } = {}) {
      const button = item.thumbnail ? fileListButtonFor(item) : null;
      if (!button) return;
      let image = button.querySelector('.file-list-thumbnail');
      if (!image) {
        image = document.createElement('img'); image.className = 'file-list-thumbnail'; image.alt = '';
        const placeholder = button.querySelector('.file-list-placeholder');
        if (placeholder) placeholder.replaceWith(image);
        else button.prepend(image);
      }
      if (image.getAttribute('src') !== item.thumbnail) image.src = item.thumbnail;
      if (refresh) refreshThumbnailState(button, item);
    }
    function refreshThumbnailRow(item) {
      const button = fileListButtonFor(item);
      if (button) refreshThumbnailState(button, item);
    }
    // One row. The settings key is computed once for both stamps, and the DOM
    // is written only where the state changed.
    function refreshThumbnailState(button, item) {
      const key = photoSettingsKey(item);
      const ready = Boolean(item.thumbnail && item.thumbnailKind === 'processed' && item.thumbnailKey === key);
      const failed = item.thumbnailErrorKey === key;
      const previewState = ready ? 'ready' : failed ? 'error' : 'pending';
      if (button.dataset.previewState !== previewState) button.dataset.previewState = previewState;
      // embedded < analysis < processed; an embedded tile is never ready.
      const thumbnailKind = item.thumbnail ? item.thumbnailKind || '' : '';
      if (button.dataset.thumbnailKind !== thumbnailKind) button.dataset.thumbnailKind = thumbnailKind;
      const switching = state.photoSwitchTarget === item && document.body.dataset.photoSwitching === 'true';
      const busy = String(switching || (!ready && !failed));
      if (button.getAttribute('aria-busy') !== busy) button.setAttribute('aria-busy', busy);
      let status = button.querySelector('.file-list-preview-state');
      if (!status) {
        status = document.createElement('span');
        status.className = 'file-list-preview-state';
        button.append(status);
      }
      if (status.hidden !== ready) status.hidden = ready;
      const text = failed ? '!' : '…';
      if (status.textContent !== text) status.textContent = text;
      const title = failed ? getLocalizedText('error', 'Error') : getLocalizedText('processingStatus', 'Processing');
      if (status.title !== title) status.title = title;
    }
    function refreshThumbnailStates() {
      // A photo switch refreshes the list once, when it flushes (switchToFile).
      if (fileListRefreshDeferrals) { fileListRefreshDeferred = true; return; }
      for (const button of document.querySelectorAll('#fileListItems .file-list-name')) {
        const item = state.fileQueue[Number(button.dataset.index)];
        if (item) refreshThumbnailState(button, item);
      }
    }
    function canReuseLoadedRollSource(item) {
      // Large RAW imports may still hold a temporary half-size preview.
      return item === getCurrentQueueItem() && (!isRawLikeFileName(item.file.name.toLowerCase())
        || item.file.size <= 100 * 1024 * 1024);
    }
    function studioBackgroundReady() {
      return state.currentStep >= 3 && getCurrentQueueItem()?.file === state.loadedFile
        && !document.body.dataset.studioBusy && !processNegativeInFlight
        && !isDesktopBatchExportLocked();
    }
    async function loadStudioThumbnails() {
      if (studioThumbnailsRunning || !state.fileQueue.length) return;
      studioThumbnailsRunning = true;
      let workers = null;
      try {
        // Let the import handler start the active photo first. Background work
        // must not demosaic a whole folder alongside the foreground RAW.
        await new Promise(resolve => setTimeout(resolve, 250));
        while (state.fileQueue.length) {
          if (!studioBackgroundReady() || automaticRollImportRunning) {
            await new Promise(resolve => setTimeout(resolve, 250)); continue;
          }
          // One settings key per candidate, reused for the job it starts.
          let key = null;
          let rollOwned = false;
          const item = state.fileQueue.find(entry => {
            if (entry === getCurrentQueueItem()) return false;
            // A scheduled roll import prepares these frames' recipes and
            // samples (and their analysis tiles). A thumbnail recipe set in
            // the gap before it starts would leave its roll analysis without
            // a pass-1 sample and decode the frame again, so they wait.
            if (!entry.settings && automaticRollPendingItems.has(entry)) { rollOwned = true; return false; }
            const entryKey = photoSettingsKey(entry);
            if (entry.thumbnailErrorKey === entryKey || (entry.thumbnail
              && entry.thumbnailKind === 'processed' && entry.thumbnailKey === entryKey)) return false;
            key = entryKey;
            return true;
          });
          if (!item) {
            if (!rollOwned) break;
            await new Promise(resolve => setTimeout(resolve, 250)); continue;
          }
          const rollRevision = automaticRollRevision;
          let superseded = false;
          const valid = () => {
            // A thumbnail may start in the brief gap before roll analysis.
            // Once that analysis takes over, its prepared recipe/sample owns
            // the frame; a late thumbnail must not replace it and force a
            // second analysis decode. Cancellation cannot revive after idle.
            superseded ||= automaticRollImportRunning || studioAutoFrameRunning
              || rollRevision !== automaticRollRevision || !state.fileQueue.includes(item)
              || item === getCurrentQueueItem() || key !== photoSettingsKey(item)
              || Boolean(document.body.dataset.photoSwitching);
            return !superseded;
          };
          let release = null;
          try {
            // One gated item (#241); a lane that waited while hidden re-checks,
            // and still pauses below before it looks for the next item.
            release = await hiddenJobs.admit({ bytes: await hiddenJobBytesFor([item.file]) });
            if (!valid()) throw Object.assign(new Error('Preview superseded while waiting'), { name: 'AbortError' });
            workers ||= createConversionWorkerPool({ size: 1 });
            let prepared;
            const image = await processFileWithSettings(item.file, item.settings, {
              previewMaxDimension: 288, updateItemSettings: false,
              sourceImageData: photoSessions.peek(item)?.base,
              isCurrent: valid, convert: request => workers(request),
              onPreparedSettings: settings => { prepared = settings; }
            });
            if (!valid()) continue;
            if (!item.settings && prepared) {
              item.settings = cloneSettings(prepared);
              item.automaticSettings = true;
            }
            item.thumbnail = thumbnailDataUrl(image);
            item.thumbnailKind = 'processed';
            item.thumbnailKey = photoSettingsKey(item);
            item.thumbnailErrorKey = null;
            updateFileThumbnail(item);
          } catch (error) {
            if (error?.name !== 'AbortError' && valid()) {
              item.thumbnailErrorKey = key;
              console.warn('Photo preview failed:', item.file.name, error);
              refreshThumbnailRow(item);
            }
          } finally {
            release?.();
          }
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      } finally { workers?.dispose(); studioThumbnailsRunning = false; }
    }

    // 標準暗室は既存の描画・履歴・書き出し経路を再利用する。
    // Tiles stay JPEG data URLs: roll-transaction undo snapshots keep them.
    // Encoding is synchronous, so one canvas serves every tile.
    let thumbnailCanvas = null;
    function thumbnailDataUrl(source, maxSize = 144) {
      // At scale 1 the sampler is an exact copy, so a source that already
      // fits is encoded as it is.
      const fits = source.width <= maxSize && source.height <= maxSize
        && source.data instanceof Uint8ClampedArray && source.data.length === source.width * source.height * 4;
      const thumbnail = fits ? source : createStudioThumbnail(source, maxSize);
      thumbnailCanvas ||= document.createElement('canvas');
      thumbnailCanvas.width = thumbnail.width;
      thumbnailCanvas.height = thumbnail.height;
      thumbnailCanvas.getContext('2d').putImageData(thumbnail instanceof ImageData ? thumbnail
        : new ImageData(thumbnail.data, thumbnail.width, thumbnail.height), 0, 0);
      return thumbnailCanvas.toDataURL('image/jpeg', 0.8);
    }

    function studioThumbnailSignature(adjustments) {
      return exactSettingsKey([adjustments], 1);
    }

    // Rebuilds the active tile only when its inputs changed; otherwise it only
    // restamps the settings key (item.settings may have been persisted since).
    function updateStudioThumbnail() {
      const item = getCurrentQueueItem();
      const source = currentConvertedPreviewSource();
      if (!item || item.file !== state.loadedFile || !source) return;
      // After a reduced preview-tier session (#263) the tile waits for the
      // normal-size tick, which schedules it again when it lands.
      if (previewTier === 'normal' && reducedDisplayImages.has(source) && (coreReprocessTimer || coreReprocessBusy())) return;
      cancelStudioThumbnailUpdate();
      const adjustments = buildAdjustmentSettings(state);
      const signature = studioThumbnailSignature(adjustments);
      const rendered = studioThumbnailInputs.get(item);
      if (!rendered || rendered.source !== source || rendered.signature !== signature
        || rendered.thumbnail !== item.thumbnail || item.thumbnailKind !== 'processed') {
        item.thumbnail = thumbnailDataUrl(createAdjustedPhotoPreview(source, adjustments));
        item.thumbnailKind = 'processed';
        studioThumbnailInputs.set(item, { source, signature, thumbnail: item.thumbnail });
      }
      item.thumbnailKey = photoSettingsKey(item);
      item.thumbnailErrorKey = null;
      updateFileThumbnail(item);
    }

    // The incoming photo of a warm switch restores the pixels its current
    // tile was made from: adopt them as the tile's inputs instead of
    // rebuilding it.
    function adoptStudioThumbnailInputs(item) {
      const source = currentConvertedPreviewSource();
      if (!source || !item.thumbnail) return;
      cancelStudioThumbnailUpdate();
      studioThumbnailInputs.set(item, {
        source, signature: studioThumbnailSignature(buildAdjustmentSettings(state)), thumbnail: item.thumbnail
      });
    }

    // A display-preview resize converts the same settings at another size.
    // When its result replaces the source a current tile was sampled from,
    // the tile stays current.
    function carryStudioThumbnailSource(previousSource) {
      const item = getCurrentQueueItem();
      const rendered = item && studioThumbnailInputs.get(item);
      if (rendered && previousSource && rendered.source === previousSource) {
        rendered.source = currentConvertedPreviewSource();
      }
    }

    function currentConvertedPreviewSource() {
      return state.fullResolutionPending && state.previewSourceImageData
        ? state.previewSourceImageData : state.processedImageData;
    }

    // What a display-preview resize replaces, read when it is requested: the
    // request itself marks the full-resolution pixels pending, which turns
    // currentConvertedPreviewSource() from them to the preview raster.
    function displayResizeOrigin() {
      return { tile: currentConvertedPreviewSource(), preview: state.previewSourceImageData,
        processed: state.processedImageData };
    }

    // The raster a resize result replaces for the tile, or null when another
    // result was applied since the resize was requested (it may carry other
    // settings, so the tile is rebuilt).
    function displayResizeReplaces(options) {
      const from = options.displayResize ? options.displayResizeFrom : null;
      if (!from || from.preview !== state.previewSourceImageData || from.processed !== state.processedImageData) return null;
      return from.tile;
    }

    // Nobody looks at the tile during a drag, and each rebuild re-encodes a
    // JPEG: preview redraws settle it about 250 ms after the last one; a full
    // render updates it in the next frame. Either replaces a pending update.
    function scheduleStudioThumbnailUpdate({ settled = false } = {}) {
      cancelStudioThumbnailUpdate();
      const generation = loadGeneration;
      const run = () => {
        studioThumbnailUpdateTimer = 0;
        studioThumbnailUpdateFrame = 0;
        if (isCurrentLoad(generation)) updateStudioThumbnail();
      };
      if (settled) studioThumbnailUpdateFrame = requestAnimationFrame(run);
      else studioThumbnailUpdateTimer = setTimeout(run, STUDIO_THUMBNAIL_SETTLE_MS);
    }

    function cancelStudioThumbnailUpdate() {
      if (studioThumbnailUpdateTimer) clearTimeout(studioThumbnailUpdateTimer);
      if (studioThumbnailUpdateFrame) cancelAnimationFrame(studioThumbnailUpdateFrame);
      studioThumbnailUpdateTimer = 0;
      studioThumbnailUpdateFrame = 0;
    }

    // Starts the frame and film-edge detections of a snapshot without awaiting
    // them. They are queued from a zero-delay task so their main-thread plane
    // copies overlap the provisional conversion instead of delaying its preview
    // resize, and read their options from the snapshot, never from the state
    // the provisional restore changes. Resolves [framedSettings, filmEdgeRead].
    function startImportDetection(source, snapshot, { detectFrame, readEdge, allowCrop, autoFrame, signal, trace, onRotation = null }) {
      const detected = new Promise(resolve => setTimeout(resolve, 0)).then(() => {
        if (signal.aborted) throw new DOMException('Superseded photo activation', 'AbortError');
        const frame = detectFrame
          ? analyzeStudioImportFrame(source, snapshot, { allowCrop, silent: true, autoFrame, filmType: snapshot.filmType, signal, onRotation })
            .then(settings => { trace.mark('autoFrame', { applied: settings.autoFrameMeta?.appliedMode || 'none' }); return settings; })
          : Promise.resolve(snapshot);
        const edge = readEdge
          ? readImportFilmEdge(source, { signal })
            .then(read => { trace.mark('filmEdge', { found: Boolean(read?.result?.found || read?.result?.text) }); return read; })
          : Promise.resolve(null);
        frame.catch(() => {});
        edge.catch(() => {});
        return Promise.all([frame, edge]);
      });
      detected.catch(() => {});
      return detected;
    }

    // The settings of today's single conversion, in today's order from the
    // pre-provisional snapshot: the auto-frame result, the film edge (with its
    // roll-date side effect), then learned defaults, which alone record
    // `automaticDefaults`.
    async function buildFinalImportSettings(source, framed, read, item, { readEdge, freshFile, applyEdgeDefaults }) {
      let settings = framed;
      let toast = null;
      if (readEdge) {
        const edge = await mergeImportFilmEdge(source, settings, read, { applyDefaults: applyEdgeDefaults });
        if (edge) { settings = edge.settings; toast = edge.toast; }
      }
      // The frame's own verdict (after DX and edge text) joins the import's
      // roll film-type decision (#231), which then applies to it.
      if (freshFile) settings = await learnedImportSettings(settleImportFilmType(item, settings), item);
      return { settings, toast };
    }

    // The provisional positive is on screen: uncover it, and let the filmstrip
    // navigate while editing stays locked until the detections end.
    function revealProvisionalPhoto(overlay, detectingFrame) {
      overlay.hide();
      state.photoSwitchTarget = null;
      state.photoSwitchPhase = null;
      delete document.body.dataset.photoSwitching;
      document.body.dataset.studioDetecting = detectingFrame ? 'frame' : 'edge';
      studioWorkspace?.sync();
    }

    // A provisional processNegative leaves the idle full-resolution render and
    // the dust pass to the final settings; arm them when those settings did not
    // need a second conversion.
    function armSettledConversion() {
      if (usesSilverCoreConversion(state) && hasSeparateConversionPreview()) {
        if (state.fullResolutionPending) scheduleFullResolutionRender('initial-preview');
      } else if (hasFrameRepairs()) {
        scheduleDustDetection();
      }
    }

    // A photo activation converts first and detects in the background: the
    // provisional settings (snapshot plus learned values) are rendered at once
    // while the frame and film-edge detections run; their final settings are
    // then built exactly as before and, only when they convert differently,
    // rendered once more. Without detection work this is today's single pass.
    async function prepareStudioPhoto(generation, item = getCurrentQueueItem(), { quiet = false } = {}) {
      const overlay = quiet ? quietLoadingOverlay : getLoadingOverlay();
      // loadFile leaves its overlay up for the conversion; until a conversion
      // has hidden it, every return of this load must.
      let painted = false;
      // 切り替え前の変換が終了してから、新しい写真の変換を開始する。
      if (processNegativeInFlight) await processNegativeInFlight;
      if (!isCurrentLoad(generation) || !state.originalImageData) {
        if (isCurrentLoad(generation)) overlay.hide();
        return;
      }
      if (!item?.settings) {
        restoreSettings(mergeStudioColors(createDefaultSettings(state.originalImageData, item), item?.studioColors || {}), { refreshDisplay: !quiet });
      }
      document.body.dataset.studioBusy = 'true';
      studioWorkspace?.sync();
      const trace = createPerfTrace('prepareStudioPhoto', {
        file: item?.file?.name || '',
        pixels: getImageDataPixelCount(state.loadedBaseImageData || state.originalImageData)
      });
      // Marks the item while its live state holds provisional settings, which
      // are never persisted, cached as a session or read by the roll lane.
      const provisionalToken = { wasDirty: Boolean(item?.isDirty) };
      let detection = null;
      try {
        const source = state.loadedBaseImageData || state.originalImageData;
        const freshFile = !item?.settings;
        const snapshot = extractCurrentSettings();
        const detectFrame = !item?.settings?.autoFrameMeta && !state.cropRegion && state.autoFrame.enabled && !expiredImportKeepsFullFrame(snapshot);
        // Read the rebate once per file: perforations, DX edge barcode, film base.
        const readEdge = !snapshot.filmEdge?.checked;
        let settings = snapshot;
        let filmEdgeToast = null;
        if (detectFrame || readEdge) {
          detection = new AbortController();
          importDetectionAbort = detection;
          const applyEdgeDefaults = freshFile && state.importFilmTypeAuto;
          // The auto-frame worker's rotated frame: the final restore adopts it
          // instead of rotating the base again (#244).
          let importRotation = null;
          const detected = startImportDetection(source, snapshot, {
            detectFrame, readEdge, allowCrop: freshFile, autoFrame: { ...state.autoFrame }, signal: detection.signal, trace,
            onRotation: rotation => { importRotation = rotation; }
          });
          const provisional = freshFile ? await provisionalLearnedSettings(snapshot, item) : snapshot;
          if (!isCurrentLoad(generation)) return;
          if (item) item.provisional = provisionalToken;
          const step2Mode = state.step2Mode;
          restoreSettings(provisional, { refreshDisplay: false });
          // The border-mode suggestion of Step 2 reads the new planes.
          await whenGeometrySettled();
          if (!isCurrentLoad(generation)) return;
          goToStep(2);
          const provisionalKey = conversionKey(provisional, source);
          trace.mark('provisionalSettings');
          await processNegative({ quiet, provisional: true });
          painted = true;
          trace.mark('provisionalConversion');
          if (!isCurrentLoad(generation)) return;
          revealProvisionalPhoto(overlay, detectFrame);
          let framed, read;
          try { [framed, read] = await detected; }
          catch (error) {
            if (!isCurrentLoad(generation)) return;
            throw error;
          }
          if (!isCurrentLoad(generation)) return;
          const final = await buildFinalImportSettings(source, framed, read, item, { readEdge, freshFile, applyEdgeDefaults });
          if (!isCurrentLoad(generation)) return;
          settings = final.settings;
          filmEdgeToast = final.toast;
          trace.mark('settings', { found: Boolean(settings.filmEdge?.found) });
          if (conversionKey(settings, source) === provisionalKey) {
            // Same conversion: the provisional render, its automatic WB and
            // rescue measurement are exactly today's. Only the detection
            // descriptions change.
            applyImportMetaToState(settings);
            if (item?.provisional === provisionalToken) delete item.provisional;
            armSettledConversion();
            trace.mark('metaOnly');
          } else {
            if (processNegativeInFlight) await processNegativeInFlight;
            if (!isCurrentLoad(generation)) return;
            // Start from the state today's single render started from.
            if (item) {
              item.isDirty = provisionalToken.wasDirty;
              if (item.provisional === provisionalToken) delete item.provisional;
            }
            state.step2Mode = step2Mode;
            pendingImportRotation = importRotation;
            restoreSettings(settings, { refreshDisplay: false });
            // The frame changed under the provisional view: fit it again.
            resetZoomPan();
            await whenGeometrySettled();
            if (!isCurrentLoad(generation)) return;
            goToStep(2);
            await processNegative({ quiet: true });
            trace.mark('processNegative');
          }
        } else {
          if (freshFile) settings = await learnedImportSettings(settleImportFilmType(item, settings), item);
          if (!isCurrentLoad(generation)) return;
          if (freshFile) restoreSettings(settings, { refreshDisplay: !quiet });
          await whenGeometrySettled();
          if (!isCurrentLoad(generation)) return;
          goToStep(2);
          trace.mark('settings');
          await processNegative({ quiet });
          painted = true;
          trace.mark('processNegative');
        }
        if (!isCurrentLoad(generation)) return;
        let filmTypeDeferred = false;
        if (filmEdgeToast) showToast(filmEdgeToast, 3200);
        else if (freshFile && settings.filmTypeConfidence === 'low') {
          filmTypeDeferred = deferImportFilmTypeToast(item, settings);
          if (!filmTypeDeferred) showToast(i18n[currentLang][settings.filmTypeReason === 'monochrome' ? 'filmTypeMonochrome' : 'filmTypeUncertain'], 6500);
        }
        if (settings.filmEdge?.found) updateFileListUI();
        if (freshFile) {
          scheduleSemanticColour(item, generation);
          // A deferred film-type prompt is not repeated as a review toast.
          if (!filmTypeDeferred || reviewForItem(item).reasons.some(reason => reason !== 'reviewFilmType')) notifyImportReview([item]);
        }
        // The provisional render may have queued the recovery copy early.
        if (item?.isDirty) scheduleProjectRecovery();
        scheduleAiRepairPreloadForRecipe();
      } finally {
        trace.end();
        if (item?.provisional === provisionalToken) {
          item.isDirty = provisionalToken.wasDirty;
          delete item.provisional;
        }
        if (importDetectionAbort === detection) importDetectionAbort = null;
        if (isCurrentLoad(generation)) {
          if (!painted) overlay.hide();
          delete document.body.dataset.studioDetecting;
          delete document.body.dataset.studioBusy;
          updateAutoFrameButtons();
          // The tail's final settings refresh the compare button while
          // studioDetecting still disables it; re-read it now the tail is over.
          updateBeforeAfterButtonState();
          updateExpiredRescueUI();
          studioWorkspace?.sync();
        }
      }
    }

    function scheduleSemanticColour(item, generation) {
      // Only colour film (or any film under rescue) can use the map: the same
      // test the result is dropped by below, taken before the downsample and
      // the worker. A roll that analyses this import takes over its recipe
      // while the inference would still run, so its frames skip it too.
      if (!state.expiredEnabled && state.filmType !== 'color') return;
      if (automaticRollPendingItems.has(item)) return;
      if (!item || item.semanticAttempted || item.savedSettings || item.userEdited || state.wbUserOverride || state.grayPointSampled || state.rollReference.applyLock || state.filmBase?.method === 'manual' || (state.filmType === 'positive' && state.positiveMode === 'edit')) return;
      item.semanticAttempted = true;
      const source = state.processedImageData;
      if (!source) return;
      const revision = manualEditRevision;
      const valid = () => isCurrentLoad(generation) && item === getCurrentQueueItem() && revision === manualEditRevision && !state.cropping && !studioAutoFrameRunning && !automaticRollImportRunning && !state.rollFrame?.locked && !state.wbUserOverride && !state.grayPointSampled && !state.rollReference.applyLock && !item.savedSettings;
      // Whole converted preview coordinates are used for both WB and rescue.
      const preview = downsampleImageDataForMaxDim(source, 512);
      setTimeout(async () => {
        try {
          if (!valid()) return;
          const map = sanitizeSemanticMap(await analyzeSemanticPreview(preview, { isCurrent: valid }));
          if (!map || !valid()) return;
          if (state.expiredEnabled) {
            const analysis = await measureExpiredAnalysisForExport(source, { ...state, semanticMap: map, autoFrameMeta: state.autoFrame.lastDiagnostics }, state.loadedBaseImageData || state.originalImageData);
            if (!analysis || !valid()) return;
            pushUndo('semanticColor'); state.semanticMap = map;
            applyExpiredAnalysisDefaults(state, analysis);
            updateExpiredRescueUI();
          } else {
            if (state.filmType !== 'color') return;
            const estimate = estimateAutoWhiteBalance(preview, { anchors: map });
            if (!estimate.anchored || estimate.confidence === 'low') return;
            pushUndo('semanticColor'); state.semanticMap = map;
            state.wbR = estimate.wbR; state.wbG = estimate.wbG; state.wbB = estimate.wbB;
            state.wbSemanticApplied = true;
            state.wbAutoConfidence = estimate.confidence; updateWBSliders(); updateGrayPointGuideUI();
          }
          markCurrentFileDirty(); persistCurrentFileSettings({ force: true, silent: true });
          schedulePreviewUpdate();
        } catch (error) { console.warn('Semantic colour skipped:', error); }
      }, 0);
    }

    // `onRotation` receives the worker's rotated frame of an applied result so
    // the caller can adopt it instead of rotating the base again (#244).
    // `autoFrame`/`filmType` default to the live state; the first-photo path
    // passes its snapshot's (see prepareStudioPhoto). An aborted request
    // rejects instead of keeping the full image.
    async function analyzeStudioImportFrame(source, settings, {
      allowCrop = true, silent = false, analyzeInWorker = analyzeFrameInWorker, onRotation = null,
      autoFrame = state.autoFrame, filmType = state.filmType, signal = null
    } = {}) {
      if (!autoFrame.enabled || settings.cropRegion) return settings;
      let result;
      try { result = await detectFrameAndRotation(source, { silent, analyzeInWorker, autoFrame, filmType, signal }); }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('Import frame detection failed; keeping the full image:', error);
      }
      if (result?.stageMs) recordPerfStages('autoFrameStages', result.stageMs, { method: result.diagnostics?.method });
      const reliable = canAutoApplyImportFrame(result, autoFrame);
      const apply = reliable && autoFrame.onImport && allowCrop;
      const meta = {
        confidence: result?.confidence || 0,
        confidenceLevel: result?.confidenceLevel || 'low',
        detectedFormat: result?.detectedFormat || 'unknown',
        method: result?.diagnostics?.method || 'unavailable',
        appliedMode: apply ? 'crop' : 'none',
        importAuto: true,
        frameIncomplete: Boolean(result?.diagnostics?.incomplete),
        imageArea: reliable ? imageAreaFromDetection(result, source) : null
      };
      if (!apply) return { ...settings, autoFrameMeta: meta };
      const angle = autoFrameEffectiveAngle(result.angle);
      // Only the rotated frame's size is needed here: the one pixel build of
      // this geometry is restoreSettings' (#244), not a second rotation.
      const rotated = rotatedDimensions(source.width, source.height, angle);
      if (onRotation && !autoFrame.rotate180Default && result.rotatedImageData) {
        onRotation({ base: source, angle: effectiveGeometryAngle(angle), image: result.rotatedImageData });
      }
      const cropRegion = autoFrame.rotate180Default
        ? rotate180CropRegion(result.cropRegion, rotated.width, rotated.height) : result.cropRegion;
      return { ...settings, rotationAngle: angle, mirrored: false, cropRegion, autoFrameMeta: meta };
    }

    // ===========================================
    // Film edge: perforation lanes, DX edge barcode, rebate film base
    // ===========================================
    async function readFilmEdgeForImage(imageData, readInWorker = readFilmEdgeInWorker, { signal = null } = {}) {
      if (!imageData) return null;
      if (typeof Worker === 'function') {
        try { return await (signal ? readInWorker(imageData, {}, { signal }) : readInWorker(imageData, {})); }
        catch (error) {
          // A superseded read must not repeat itself on the main thread.
          if (error?.name === 'AbortError') throw error;
          console.warn('Film edge worker unavailable, reading on the main thread:', error);
        }
      }
      return readFilmEdge(imageData, {});
    }

    // Mirrors applyFilmPresetSettingsToState for a detached settings object.
    async function applyFilmPresetToSettings(settings, presetId) {
      const filmPresets = await loadFilmPresets();
      const preset = filmPresets[presetId];
      if (!preset || !preset.settings) return false;
      const s = preset.settings;
      settings.coreFilmPreset = presetId;
      if (s.enhancedProfile) settings.coreEnhancedProfile = s.enhancedProfile;
      const fields = { saturation: 'coreSaturation', glow: 'coreGlow', fade: 'coreFade', shadows: 'coreShadows', highlights: 'coreHighlights', blacks: 'coreBlacks', whites: 'coreWhites' };
      for (const [from, to] of Object.entries(fields)) if (s[from] !== undefined) settings[to] = s[from];
      return true;
    }

    function rebateFilmBaseForSettings(filmBase) {
      return sanitizeFilmBaseForSettings({ ...filmBase, method: 'rebate', confidence: 0.92, precision: 8 });
    }

    // Mirroring flips the crop box across the rotated frame. Only the frame's
    // width is needed, so no pixels are rotated for it.
    function mirrorCropForRotatedFrame(source, next) {
      if (!next.cropRegion) return;
      const frame = Math.abs(next.rotationAngle || 0) > 0.001
        ? rotatedDimensions(source.width, source.height, next.rotationAngle) : source;
      next.cropRegion = { ...next.cropRegion, left: frame.width - next.cropRegion.left - next.cropRegion.width };
    }

    // Reads the rebate of a loaded image and folds the result into `settings`.
    // Returns { settings, toast } or null when the reader was unavailable.
    // With applyDefaults the detected stock also sets the film type (B&W or
    // slide film from the database). The matched preset and the rebate film
    // base are only offered, through the Film edge buttons: applying both on
    // import cost 0.7 stop and cooled the render on a real Ultra Max strip
    // against the border auto-detect with no preset.
    async function analyzeImportFilmEdge(source, settings, { applyDefaults = true, readFilmEdge = readFilmEdgeInWorker } = {}) {
      if (!source || settings.filmEdge?.checked) return null;
      return mergeImportFilmEdge(source, settings, await readImportFilmEdge(source, { readFilmEdge }), { applyDefaults });
    }

    // The read depends only on the pixels, so the first photo starts it before
    // its provisional conversion. Resolves { result } (result may be null), or
    // null when the reader failed; an abort rejects.
    async function readImportFilmEdge(source, { readFilmEdge = readFilmEdgeInWorker, signal = null } = {}) {
      try { return { result: await readFilmEdgeForImage(source, readFilmEdge, { signal }) }; }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('Film edge detection failed:', error);
        return null;
      }
    }

    // Folds a read into `settings` (after any auto-frame result, whose geometry
    // the mirror flip follows). Sets the roll date as a side effect.
    async function mergeImportFilmEdge(source, settings, read, { applyDefaults = true } = {}) {
      if (!source || settings.filmEdge?.checked || !read) return null;
      applyDefaults = applyDefaults && settings.filmTypeSource !== 'manual';
      const result = read.result;
      if (result?.text && !result.dx) {
        const text = result.text;
        const next = { ...settings, filmEdge: sanitizeFilmEdgeForSettings({ ...text, found: true, shortName: text.filmName, text: text.text }) };
        if (applyDefaults && text.year && !state.rollMetadata.date) { state.rollMetadata.date = String(text.year); updateMetadataUI(); }
        if (applyDefaults && text.filmKind) {
          next.filmType = text.filmKind; next.filmTypeSource = 'auto'; next.filmTypeConfidence = 'high'; next.filmTypeReason = 'edge-text';
        }
        if (!next.frameMetadata?.frameNumber && text.frameNumber) next.frameMetadata = { ...next.frameMetadata, frameNumber: text.frameNumber };
        if (applyDefaults && text.mirrorDetected && !settings.mirrored) {
          next.mirrored = true;
          mirrorCropForRotatedFrame(source, next);
        }
        return { settings: next, toast: getInterpolatedText('filmEdgeTextDetected', { text: text.text, frame: text.frameNumber || '' }, `Film edge: ${text.text} ${text.frameNumber || ''}`) };
      }
      if (!result?.found || !result.dx) {
        return { settings: { ...settings, filmEdge: sanitizeFilmEdgeForSettings({ found: false }) }, toast: null };
      }
      let table = null;
      try { table = await loadDxFilmTable(); }
      catch (error) { console.warn('DX film table unavailable:', error); }
      const description = describeDxFilm(result.dx.dx1, result.dx.dx2, table);
      const record = {
        found: true,
        text: result.text?.text, frameNumber: result.text?.frameNumber, mirrorDetected: result.text?.mirrorDetected,
        dx1: result.dx.dx1,
        dx2: result.dx.dx2,
        votes: result.dx.votes,
        total: result.dx.total,
        filmName: description?.primaryName || null,
        shortName: description?.primaryName ? shortFilmName(description.primaryName) : null,
        names: description?.names || [],
        filmKind: description?.filmKind || null,
        presetId: description?.presetId || null,
        frames: result.dx.frames,
        filmBase: result.filmBase,
        pxPerMm: result.geometry?.pxPerMm,
        angleDeg: result.geometry?.angleDeg,
        axis: result.geometry?.axis,
        polarity: result.polarity
      };
      const next = { ...settings };
      // Clear marks on a dense rebate belong to slide film (or to a border the
      // app rendered itself); a colour-negative DX number read that way is
      // contradictory, so it is shown but not applied automatically.
      const contradictory = record.polarity === 'light' && record.filmKind !== 'positive';
      if (applyDefaults && !contradictory && record.filmKind) {
        record.appliedFilmType = record.filmKind !== next.filmType;
        next.filmType = record.filmKind;
        next.filmTypeSource = 'auto';
        next.filmTypeConfidence = 'high';
        next.filmTypeReason = 'dx';
      }
      if (applyDefaults && result.text?.mirrorDetected && !settings.mirrored) {
        next.mirrored = true;
        mirrorCropForRotatedFrame(source, next);
      }
      next.filmEdge = sanitizeFilmEdgeForSettings(record);
      if (!next.frameMetadata?.frameNumber && record.frameNumber) next.frameMetadata = { ...next.frameMetadata, frameNumber: record.frameNumber };
      const dx = `${record.dx1}-${record.dx2}`;
      const name = record.shortName || record.filmName;
      let toast = name
        ? getInterpolatedText('filmEdgeToastDetected', { name, dx }, `Detected ${name} (DX ${dx})`)
        : getInterpolatedText('filmEdgeToastUnknown', { dx }, `Read DX ${dx}; no matching film in the database`);
      if (!contradictory && (record.presetId || record.filmBase)) toast += getLocalizedText('filmEdgeToastSuggest', '; its preset and rebate film base are under Film edge');
      return { settings: next, toast };
    }

    function updateFilmEdgeUI() {
      if (!stateReady) return;
      const group = document.getElementById('filmEdgeGroup');
      const status = document.getElementById('filmEdgeStatus');
      const applyBtn = document.getElementById('applyFilmEdgePresetBtn');
      const baseBtn = document.getElementById('useFilmEdgeBaseBtn');
      if (!group || !status || !applyBtn || !baseBtn) return;
      const edge = state.filmEdge;
      if (!edge?.checked || !state.originalImageData) {
        group.style.display = 'none';
        return;
      }
      group.style.display = '';
      if (!edge.found) {
        status.textContent = getLocalizedText('filmEdgeStatusNone', 'No DX edge code found on the rebate.');
        applyBtn.style.display = 'none';
        baseBtn.style.display = 'none';
        return;
      }
      const dx = edge.dxNumber || (edge.dx1 !== null && edge.dx2 !== null ? `${edge.dx1}-${edge.dx2}` : '');
      const name = edge.filmName || edge.shortName;
      const parts = [
        edge.text && !dx ? edge.text : name
          ? getInterpolatedText('filmEdgeStatusDetected', { dx, name }, `DX ${dx} · ${name}`)
          : getInterpolatedText('filmEdgeStatusUnknown', { dx }, `DX ${dx} (not in the film database)`)
      ];
      if (edge.frameNumber) parts.push(edge.frameNumber);
      if (edge.year) parts.push(String(edge.year));
      if (edge.frames?.length) {
        parts.push(getInterpolatedText('filmEdgeStatusFrames', { frames: formatFilmEdgeFrames(edge.frames) }, `frames ${formatFilmEdgeFrames(edge.frames)}`));
      }
      if (edge.total > 1) {
        parts.push(getInterpolatedText('filmEdgeStatusVotes', { votes: String(edge.votes), total: String(edge.total) }, `${edge.votes}/${edge.total} codes agree`));
      }
      status.textContent = parts.join(' · ');
      const canApply = Boolean(edge.presetId) || Boolean(edge.filmKind && edge.filmKind !== state.filmType);
      applyBtn.style.display = canApply ? '' : 'none';
      baseBtn.style.display = edge.filmBase && requiresFilmBase() ? '' : 'none';
    }

    async function applyDetectedFilmToCurrent() {
      const edge = state.filmEdge;
      if (!edge?.found || !state.originalImageData) return;
      pushUndo('filmEdgeApply');
      if (edge.filmKind && edge.filmKind !== state.filmType) {
        state.filmType = edge.filmKind;
        setFilmTypeButtons(state.filmType);
        if (requiresFilmBase()) setStep2Mode(suggestStep2Mode());
        else updateFilmModeUI();
      }
      if (edge.presetId && (!edge.filmKind || edge.filmKind === state.filmType)) {
        state.frontierGuideStep2ChoiceTouched = true;
        await applyFilmPresetSettingsToState(edge.presetId);
      }
      state.filmEdge = { ...edge, appliedPreset: Boolean(edge.presetId), appliedFilmType: true };
      markCurrentFileDirty();
      updateSlidersFromState();
      updateFilmEdgeUI();
      const label = edge.shortName || edge.filmName || edge.dxNumber;
      showToast(getInterpolatedText('filmEdgeAppliedPreset', { name: label }, `Applied the ${label} preset.`));
      if (usesSilverCoreConversion(state)) scheduleSilverSourceRefresh();
      else schedulePreviewUpdate();
    }

    function useFilmEdgeBaseForCurrent() {
      const edge = state.filmEdge;
      if (!edge?.found || !edge.filmBase || !requiresFilmBase()) return;
      pushUndo('filmEdgeBase');
      state.filmBase = rebateFilmBaseForSettings(edge.filmBase);
      state.filmBaseSet = true;
      state.filmEdge = { ...edge, appliedFilmBase: true };
      updateFilmBasePreview();
      markCurrentFileDirty();
      updateFilmEdgeUI();
      showToast(getLocalizedText('filmEdgeAppliedBase', 'Film base taken from the unexposed rebate.'));
      scheduleSilverSourceRefresh({ immediate: true });
    }

    document.getElementById('applyFilmEdgePresetBtn')?.addEventListener('click', () => { void applyDetectedFilmToCurrent(); });
    document.getElementById('useFilmEdgeBaseBtn')?.addEventListener('click', useFilmEdgeBaseForCurrent);

    // ===========================================
    // Enlarger paradigm: dichroic filtration, stops and paper grade as a view
    // of the core sliders (enlarger.js holds the deterministic mapping).
    // ===========================================
    const PARADIGM_STORAGE_KEY = 'nc_paradigm_v1';
    let enlargerSyncing = false;

    function setControlParadigm(paradigm, { persist = true } = {}) {
      state.controlParadigm = paradigm === 'enlarger' ? 'enlarger' : 'digital';
      const enlarger = state.controlParadigm === 'enlarger';
      document.body.classList.toggle('studio-enlarger', enlarger);
      const digitalBtn = document.getElementById('paradigmDigitalBtn');
      const enlargerBtn = document.getElementById('paradigmEnlargerBtn');
      if (digitalBtn) { digitalBtn.classList.toggle('active', !enlarger); digitalBtn.setAttribute('aria-pressed', String(!enlarger)); }
      if (enlargerBtn) { enlargerBtn.classList.toggle('active', enlarger); enlargerBtn.setAttribute('aria-pressed', String(enlarger)); }
      if (persist) safeStorageSet(PARADIGM_STORAGE_KEY, state.controlParadigm);
      updateEnlargerUI();
      populateTestStripAxes();
    }

    function setEnlargerInput(id, value, decimals = 0) {
      const range = document.getElementById(id);
      const number = document.getElementById(`${id}Value`);
      const text = Number(value).toFixed(decimals);
      if (range && range.value !== text) range.value = text;
      if (number && number.tagName === 'INPUT' && number.value !== text) number.value = text;
    }

    function updateEnlargerUI() {
      if (!stateReady) return;
      const controls = document.getElementById('enlargerControls');
      if (!controls) return;
      enlargerSyncing = true;
      try {
        const filters = filtrationFromSliders({ cyan: state.coreCyan, tint: state.coreTint, temperature: state.coreTemperature });
        setEnlargerInput('enlargerCyan', filters.cyan);
        setEnlargerInput('enlargerMagenta', filters.magenta);
        setEnlargerInput('enlargerYellow', filters.yellow);
        setEnlargerInput('enlargerExposure', stopsFromExposureUnits(state.coreExposure), 1);
        const gradeValue = gradeValueForContrast(state.coreContrast);
        const grade = document.getElementById('enlargerGrade');
        const gradeReadout = document.getElementById('enlargerGradeValue');
        if (grade && Number(grade.value) !== gradeValue) grade.value = String(gradeValue);
        if (gradeReadout) gradeReadout.textContent = gradeLabelForValue(gradeValue);
        const gradeControl = document.getElementById('enlargerGradeControl');
        // Multigrade paper has grades; RA-4 colour paper does not.
        if (gradeControl) gradeControl.style.display = getEffectiveFilmType() === 'bw' ? '' : 'none';
      } finally {
        enlargerSyncing = false;
      }
    }

    function applyEnlargerFiltration() {
      const read = (id) => Number(document.getElementById(id)?.value);
      const sliders = slidersFromFiltration({ cyan: read('enlargerCyan'), magenta: read('enlargerMagenta'), yellow: read('enlargerYellow') });
      state.coreCyan = sliders.cyan;
      state.coreTint = sliders.tint;
      state.coreTemperature = sliders.temperature;
      ['coreCyan', 'coreTint', 'coreTemperature'].forEach(syncSliderFromState);
    }

    function bindEnlargerControl(id, apply) {
      const range = document.getElementById(id);
      const number = document.getElementById(`${id}Value`);
      if (!range) return;
      let preDragSnapshot = null;
      const commit = (source) => {
        if (enlargerSyncing) return;
        if (number && number.tagName === 'INPUT') {
          if (source === range) number.value = range.value;
          else range.value = number.value;
        }
        apply();
        markCurrentFileDirty();
        updateEnlargerUI();
        scheduleCoreReprocess({ full: false });
      };
      range.addEventListener('pointerdown', () => { preDragSnapshot = captureSnapshot('enlarger'); });
      range.addEventListener('input', () => commit(range));
      range.addEventListener('change', () => {
        if (preDragSnapshot) { commitUndoSnapshot(preDragSnapshot); preDragSnapshot = null; }
      });
      if (number && number.tagName === 'INPUT') {
        number.addEventListener('change', () => { pushUndo('enlarger'); commit(number); });
      }
    }

    bindEnlargerControl('enlargerCyan', applyEnlargerFiltration);
    bindEnlargerControl('enlargerMagenta', applyEnlargerFiltration);
    bindEnlargerControl('enlargerYellow', applyEnlargerFiltration);
    bindEnlargerControl('enlargerExposure', () => {
      state.coreExposure = exposureUnitsFromStops(Number(document.getElementById('enlargerExposure').value));
      syncSliderFromState('coreExposure');
    });
    bindEnlargerControl('enlargerGrade', () => {
      state.coreContrast = contrastForGradeValue(Number(document.getElementById('enlargerGrade').value));
      syncSliderFromState('coreContrast');
    });
    document.getElementById('paradigmDigitalBtn')?.addEventListener('click', () => setControlParadigm('digital'));
    document.getElementById('paradigmEnlargerBtn')?.addEventListener('click', () => setControlParadigm('enlarger'));
    setControlParadigm(safeStorageGet(PARADIGM_STORAGE_KEY) === 'enlarger' ? 'enlarger' : 'digital', { persist: false });

    // ===========================================
    // Test strip: several patches of the photo along one axis; click to apply.
    // ===========================================
    const testStrip = { rendering: false, values: [], axisKey: null };

    function currentTestStripAxes() {
      const axes = TEST_STRIP_AXES[state.controlParadigm === 'enlarger' ? 'enlarger' : 'digital'];
      return axes.filter((axis) => !(axis.format === 'grade' && getEffectiveFilmType() !== 'bw'));
    }

    function currentTestStripAxis() {
      const select = document.getElementById('testStripAxis');
      const axes = currentTestStripAxes();
      return axes.find((axis) => axis.key === select?.value) || axes[0];
    }

    function populateTestStripAxes() {
      if (!stateReady) return;
      const select = document.getElementById('testStripAxis');
      if (!select) return;
      const previous = select.value;
      const axes = currentTestStripAxes();
      select.replaceChildren(...axes.map((axis) => {
        const option = document.createElement('option');
        option.value = axis.key;
        option.textContent = getLocalizedText(axis.label, axis.key);
        return option;
      }));
      select.value = axes.some((axis) => axis.key === previous) ? previous : axes[0].key;
    }

    function readTestStripStep(axis) {
      const input = document.getElementById('testStripStep');
      const value = Math.round(Number(input?.value));
      return Number.isFinite(value) && value >= 1 ? Math.min(100, value) : axis.step;
    }

    function setTestStripStep(step) {
      const input = document.getElementById('testStripStep');
      if (input) input.value = String(step);
    }

    async function renderTestStrip() {
      const tiles = document.getElementById('testStripTiles');
      const button = document.getElementById('testStripRenderBtn');
      if (!tiles || testStrip.rendering) return;
      const source = state.conversionPreviewImageData || state.conversionSourceImageData;
      if (state.currentStep < 3 || !source || !usesSilverCoreConversion(state)) {
        tiles.replaceChildren(Object.assign(document.createElement('span'), { className: 'test-strip-empty', textContent: getLocalizedText('testStripEmpty', 'Convert a photo first.') }));
        return;
      }
      const axis = currentTestStripAxis();
      const step = readTestStripStep(axis);
      const count = Number(document.getElementById('testStripCount')?.value) || 5;
      const area = document.getElementById('testStripArea')?.value || 'full';
      const centre = Number(state[axis.key]) || 0;
      const values = testStripValues(axis, centre, step, count);
      const small = downsampleImageDataForMaxDim(source, 360);
      const base = state.loadedBaseImageData || state.originalImageData;
      testStrip.rendering = true;
      testStrip.axisKey = axis.key;
      testStrip.values = values;
      if (button) button.disabled = true;
      const rendered = [];
      try {
        for (const value of values) {
          const variant = { ...state, [axis.key]: value };
          const converted = await convertFrameWithRouter({
            imageData: small,
            settings: buildRouterSettings(variant, base),
            options: { preview: true, scratch: true, includeAnalysisPreview: false }
          });
          const output = new ImageData(converted.width, converted.height);
          applyAdjustmentsToBuffer(converted, state, output, 'preview');
          rendered.push({ value, imageData: output });
        }
      } catch (error) {
        console.warn('Test strip render failed:', error);
      } finally {
        testStrip.rendering = false;
        if (button) button.disabled = false;
      }
      if (testStrip.axisKey !== axis.key) return;
      tiles.replaceChildren(...rendered.map(({ value, imageData }) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'test-strip-tile' + (value === centre ? ' current' : '');
        tile.dataset.value = String(value);
        tile.setAttribute('role', 'option');
        tile.setAttribute('aria-selected', String(value === centre));
        const surface = document.createElement('canvas');
        const sx = area === 'centre' ? Math.floor(imageData.width * 0.25) : 0;
        const sy = area === 'centre' ? Math.floor(imageData.height * 0.25) : 0;
        const sw = area === 'centre' ? Math.max(1, Math.floor(imageData.width * 0.5)) : imageData.width;
        const sh = area === 'centre' ? Math.max(1, Math.floor(imageData.height * 0.5)) : imageData.height;
        surface.width = sw;
        surface.height = sh;
        const scratch = document.createElement('canvas');
        scratch.width = imageData.width;
        scratch.height = imageData.height;
        scratch.getContext('2d').putImageData(imageData, 0, 0);
        surface.getContext('2d').drawImage(scratch, sx, sy, sw, sh, 0, 0, sw, sh);
        const label = document.createElement('span');
        label.textContent = formatAxisValue(axis, value);
        tile.append(surface, label);
        tile.addEventListener('click', (event) => applyTestStripValue(axis, value, { narrow: event.shiftKey }));
        return tile;
      }));
    }

    function applyTestStripValue(axis, value, { narrow = false } = {}) {
      if (state.currentStep < 3) return;
      pushUndo('testStrip');
      state[axis.key] = value;
      markCurrentFileDirty();
      syncSliderFromState(axis.key);
      updateEnlargerUI();
      scheduleCoreReprocess({ full: false });
      showToast(getInterpolatedText('testStripApplied', { label: formatAxisValue(axis, value) }, `Applied ${formatAxisValue(axis, value)}`));
      if (narrow) setTestStripStep(Math.max(1, Math.round(readTestStripStep(axis) / 2)));
      void renderTestStrip();
    }

    document.getElementById('testStripRenderBtn')?.addEventListener('click', () => { void renderTestStrip(); });
    document.getElementById('testStripAxis')?.addEventListener('change', () => {
      const axis = currentTestStripAxis();
      setTestStripStep(axis.step);
      if (document.getElementById('testStripTiles')?.childElementCount) void renderTestStrip();
    });
    document.getElementById('testStripTiles')?.addEventListener('keydown', (event) => {
      const tiles = [...document.querySelectorAll('#testStripTiles .test-strip-tile')];
      if (/^[1-9]$/.test(event.key)) {
        const tile = tiles[Number(event.key) - 1];
        if (tile) { event.preventDefault(); tile.click(); }
        return;
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const axis = currentTestStripAxis();
        const step = readTestStripStep(axis);
        setTestStripStep(event.key === '[' ? Math.max(1, Math.round(step / 2)) : Math.min(100, step * 2));
        void renderTestStrip();
      }
    });

    // ===========================================
    // Paper emulation selector (Looks drawer)
    // ===========================================
    function paperKindForState() {
      const type = getEffectiveFilmType();
      return type === 'positive' ? 'positive' : type;
    }

    function populatePaperOptions() {
      const select = document.getElementById('corePaper');
      if (!select) return;
      const ids = paperIdsForFilmKind(paperKindForState());
      const current = ids.includes(state.corePaper) ? state.corePaper : 'none';
      select.replaceChildren(...ids.map((id) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id === 'none' ? getLocalizedText('paperNone', 'None') : paperProfiles[id].label;
        return option;
      }));
      select.value = current;
    }

    function updatePaperUI() {
      if (!stateReady) return;
      const section = document.getElementById('paperSection');
      const select = document.getElementById('corePaper');
      if (!section || !select) return;
      const kind = paperKindForState();
      const ids = paperIdsForFilmKind(kind);
      if (!ids.includes(state.corePaper)) state.corePaper = 'none';
      populatePaperOptions();
      const bw = kind === 'bw' && state.corePaper !== 'none';
      const toningControl = document.getElementById('corePaperToningControl');
      const strengthControl = document.getElementById('corePaperToningStrengthControl');
      if (toningControl) toningControl.style.display = bw ? '' : 'none';
      if (strengthControl) strengthControl.style.display = bw && state.corePaperToning !== 'none' ? '' : 'none';
      section.dataset.paperKind = kind;
    }

    // ===========================================
    // Dodge and burn brush (Retouch tab)
    // ===========================================
    let dodgeBurnDrawing = false;
    let dodgeBurnPointerId = null;
    let dodgeBurnPoints = [];
    let dodgeBurnFrame = 0;

    function dodgeBurnGeometry() {
      const geometry = localExposureGeometryFor(state);
      const working = state.processedImageData || state.croppedImageData || state.originalImageData;
      if (!geometry || !working) return null;
      return { ...geometry, width: working.width, height: working.height };
    }

    function canPaintDodgeBurn() {
      return Boolean(state.dodgeBurn?.active && state.currentStep >= 3 && state.processedImageData
        && !state.samplingMode && !state.cropping && !document.body.dataset.studioBusy && usesSilverCoreConversion(state));
    }

    function pointerToWorkingPoint(event) {
      const activeCanvas = isWebGLActive() ? glCanvas : canvas;
      const rect = activeCanvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const cx = (event.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (event.clientY - rect.top) * (canvas.height / rect.height);
      const point = canvasToImageCoords(cx, cy);
      if (!point) return null;
      return { x: point.x, y: point.y, p: event.pressure && event.pressure > 0 && event.pointerType === 'pen' ? event.pressure : 1 };
    }

    function onDodgeBurnPointerDown(event) {
      if (!canPaintDodgeBurn() || (event.button !== 0 && event.pointerType === 'mouse')) return;
      const point = pointerToWorkingPoint(event);
      if (!point) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dodgeBurnDrawing = true;
      dodgeBurnPointerId = event.pointerId;
      dodgeBurnPoints = [point];
      scheduleDodgeBurnLivePaint();
    }

    function onDodgeBurnPointerMove(event) {
      if (!dodgeBurnDrawing || event.pointerId !== dodgeBurnPointerId) return;
      const point = pointerToWorkingPoint(event);
      if (!point) return;
      const last = dodgeBurnPoints[dodgeBurnPoints.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
      dodgeBurnPoints.push(point);
      scheduleDodgeBurnLivePaint();
    }

    function onDodgeBurnPointerUp(event) {
      if (!dodgeBurnDrawing || event.pointerId !== dodgeBurnPointerId) return;
      dodgeBurnDrawing = false;
      dodgeBurnPointerId = null;
      const points = dodgeBurnPoints;
      dodgeBurnPoints = [];
      const geometry = dodgeBurnGeometry();
      if (!points.length || !geometry) { updatePreview(); return; }
      const stroke = {
        stops: state.dodgeBurn.mode === 'dodge' ? -Math.abs(state.dodgeBurn.stops) : Math.abs(state.dodgeBurn.stops),
        size: state.dodgeBurn.size / 100,
        feather: state.dodgeBurn.feather / 100,
        points: points.map((p) => ({ ...workingPointToBase(p, geometry), p: p.p }))
      };
      pushUndo('dodgeBurn');
      const strokes = [...(state.localExposure?.strokes || []), stroke];
      state.localExposure = sanitizeLocalExposureForSettings({ strokes });
      markCurrentFileDirty();
      updateDodgeBurnUI();
      scheduleCoreReprocess({ full: false });
    }

    function scheduleDodgeBurnLivePaint() {
      if (dodgeBurnFrame) return;
      dodgeBurnFrame = requestAnimationFrame(() => {
        dodgeBurnFrame = 0;
        const display = state.displayImageData || state.processedImageData;
        if (!display) return;
        renderAdjustedImageDataToMainCanvas(display, display);
        renderDodgeBurnOverlay();
        drawDodgeBurnPath(dodgeBurnPoints.map((p) => ({ x: p.x, y: p.y, p: p.p })), state.dodgeBurn.mode === 'dodge' ? -1 : 1, true);
      });
    }

    // Draws one stroke path (working-frame pixel points) on the main canvas.
    function drawDodgeBurnPath(points, sign, live = false) {
      if (!points.length || !state.processedImageData) return;
      const ctx = canvas.getContext('2d');
      const scaleX = canvas.width / state.processedImageData.width;
      const scaleY = canvas.height / state.processedImageData.height;
      const shortSide = Math.min(state.processedImageData.width, state.processedImageData.height);
      const width = Math.max(2, state.dodgeBurn.size / 100 * shortSide * Math.min(scaleX, scaleY));
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.strokeStyle = sign < 0 ? `rgba(120, 200, 255, ${live ? 0.45 : 0.3})` : `rgba(255, 170, 0, ${live ? 0.45 : 0.3})`;
      ctx.beginPath();
      points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * scaleX, p.y * scaleY); else ctx.lineTo(p.x * scaleX, p.y * scaleY); });
      if (points.length === 1) ctx.lineTo(points[0].x * scaleX + 0.01, points[0].y * scaleY);
      ctx.stroke();
      ctx.restore();
    }

    function renderDodgeBurnOverlay() {
      if (!state.dodgeBurn?.active || !state.dodgeBurn.showOverlay) return;
      const strokes = state.localExposure?.strokes;
      if (!Array.isArray(strokes) || !strokes.length || !state.processedImageData) return;
      const geometry = dodgeBurnGeometry();
      if (!geometry) return;
      for (const stroke of strokes) {
        const points = stroke.points.map((p) => basePointToWorking(p, geometry));
        const saved = state.dodgeBurn.size;
        state.dodgeBurn.size = stroke.size * 100;
        drawDodgeBurnPath(points, stroke.stops < 0 ? -1 : 1);
        state.dodgeBurn.size = saved;
      }
    }

    function updateDodgeBurnUI() {
      if (!stateReady) return;
      const enabled = document.getElementById('dodgeBurnEnabled');
      const controls = document.getElementById('dodgeBurnControls');
      const status = document.getElementById('dodgeBurnStatus');
      if (!enabled || !controls || !status) return;
      const brush = state.dodgeBurn;
      enabled.checked = Boolean(brush.active);
      controls.style.display = brush.active ? '' : 'none';
      document.body.classList.toggle('dodge-burn-active', Boolean(brush.active));
      const dodgeBtn = document.getElementById('dodgeBurnModeDodge');
      const burnBtn = document.getElementById('dodgeBurnModeBurn');
      if (dodgeBtn) { dodgeBtn.classList.toggle('active', brush.mode === 'dodge'); dodgeBtn.setAttribute('aria-pressed', String(brush.mode === 'dodge')); }
      if (burnBtn) { burnBtn.classList.toggle('active', brush.mode === 'burn'); burnBtn.setAttribute('aria-pressed', String(brush.mode === 'burn')); }
      setEnlargerInput('dodgeBurnStops', brush.stops, 1);
      setEnlargerInput('dodgeBurnSize', brush.size);
      setEnlargerInput('dodgeBurnFeather', brush.feather);
      const overlay = document.getElementById('dodgeBurnShowOverlay');
      if (overlay) overlay.checked = Boolean(brush.showOverlay);
      const count = state.localExposure?.strokes?.length || 0;
      status.textContent = count
        ? getInterpolatedText('dodgeBurnStatusCount', { count: String(count) }, `${count} stroke(s)`)
        : getLocalizedText('dodgeBurnStatusNone', 'No strokes.');
      const undoBtn = document.getElementById('dodgeBurnUndoStrokeBtn');
      const clearBtn = document.getElementById('dodgeBurnClearBtn');
      if (undoBtn) undoBtn.disabled = count === 0;
      if (clearBtn) clearBtn.disabled = count === 0;
    }

    function setDodgeBurnActive(active) {
      state.dodgeBurn.active = Boolean(active);
      if (active) document.getElementById('aiBrushEnabled').checked = false;
      updateDodgeBurnUI();
      // The overlay needs the 2D canvas; leaving the mode may hand the preview back to WebGL.
      updatePreview();
    }

    function removeDodgeBurnStrokes(count) {
      const strokes = state.localExposure?.strokes || [];
      if (!strokes.length) return;
      pushUndo('dodgeBurn');
      const kept = count >= strokes.length ? [] : strokes.slice(0, strokes.length - count);
      state.localExposure = kept.length ? { strokes: kept } : null;
      markCurrentFileDirty();
      updateDodgeBurnUI();
      scheduleCoreReprocess({ full: false });
    }

    function bindDodgeBurnNumber(id, key, decimals = 0) {
      const range = document.getElementById(id);
      const number = document.getElementById(`${id}Value`);
      const apply = (value) => {
        if (!Number.isFinite(value)) return;
        state.dodgeBurn[key] = value;
        updateDodgeBurnUI();
      };
      range?.addEventListener('input', () => apply(Number(range.value)));
      number?.addEventListener('change', () => apply(Number(number.value)));
      void decimals;
    }

    document.getElementById('dodgeBurnEnabled')?.addEventListener('change', (event) => setDodgeBurnActive(event.target.checked));
    document.getElementById('dodgeBurnModeDodge')?.addEventListener('click', () => { state.dodgeBurn.mode = 'dodge'; updateDodgeBurnUI(); });
    document.getElementById('dodgeBurnModeBurn')?.addEventListener('click', () => { state.dodgeBurn.mode = 'burn'; updateDodgeBurnUI(); });
    document.getElementById('dodgeBurnShowOverlay')?.addEventListener('change', (event) => { state.dodgeBurn.showOverlay = event.target.checked; updatePreview(); });
    document.getElementById('dodgeBurnUndoStrokeBtn')?.addEventListener('click', () => removeDodgeBurnStrokes(1));
    document.getElementById('dodgeBurnClearBtn')?.addEventListener('click', () => removeDodgeBurnStrokes(Infinity));
    bindDodgeBurnNumber('dodgeBurnStops', 'stops', 1);
    bindDodgeBurnNumber('dodgeBurnSize', 'size');
    bindDodgeBurnNumber('dodgeBurnFeather', 'feather');
    for (const surface of [canvas, glCanvas]) {
      surface.addEventListener('pointerdown', onDodgeBurnPointerDown);
    }
    document.addEventListener('pointermove', onDodgeBurnPointerMove);
    document.addEventListener('pointerup', onDodgeBurnPointerUp);
    document.addEventListener('pointercancel', onDodgeBurnPointerUp);

    // ===========================================
    // Roll analysis: one film base and one tone analysis for the whole roll
    // ===========================================
    function formatRollReasons(reasons) {
      const keys = { 'base-colour': 'rollReasonBaseColour', 'base-density': 'rollReasonBaseDensity', 'no-base': 'rollReasonNoBase' };
      const fallback = { 'base-colour': 'film base colour', 'base-density': 'film base density', 'no-base': 'no film base' };
      return (Array.isArray(reasons) ? reasons : []).map((r) => getLocalizedText(keys[r] || '', fallback[r] || r)).join(', ');
    }

    function formatStops(stops) {
      const value = Number(stops) || 0;
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
    }

    // Downsampled, geometry-applied negative used for the roll measurements.
    function buildRollAnalysisSample(imageData, settings) {
      const reduced = downsampleImageDataForMaxDim(imageData, 900);
      const factor = reduced.width / imageData.width;
      let working = reduced;
      const angle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
      if (Math.abs(angle) > 0.001) working = applyRotationToImageData(working, angle);
      if (settings.mirrored) working = mirrorImageDataHorizontal(working);
      if (settings.cropRegion) {
        const scaled = {
          left: (settings.cropRegion.left ?? settings.cropRegion.x ?? 0) * factor,
          top: (settings.cropRegion.top ?? settings.cropRegion.y ?? 0) * factor,
          width: settings.cropRegion.width * factor,
          height: settings.cropRegion.height * factor
        };
        const region = sanitizeCropRegionForImage(scaled, working);
        if (region) working = cropImageData(working, region);
      }
      return working;
    }

    // ===========================================
    // Expired film rescue: a separate entry and flow for aged rolls
    // (pipeline/expiredRescue.js). Negatives are converted as usual first;
    // the rescue then measures the positive and reshapes it per channel.
    // ===========================================
    function expiredSourceKey() {
      const source = state.croppedImageData || state.originalImageData;
      if (!source) return null;
      return `${state.loadedFile?.name || ''}|${source.width}x${source.height}|${state.filmType}|${state.positiveMode}`;
    }

    // A fogged, borderless positive scan (a lab's JPEG of an expired roll) has
    // nothing to crop, and the fog makes the image-window detector see the
    // subject as the window: in the rescue flow such a photo keeps its full
    // frame and skips the detection altogether (on a large scan the worker
    // times out and the main-thread fallback freezes the page for a minute).
    // The colour analysis then uses the frame inside the border buffer.
    function expiredImportKeepsFullFrame(settings) {
      return Boolean(settings?.expiredEnabled) && sanitizePresetType(settings?.filmType || 'color') === 'positive';
    }

    function hasCurrentExpiredAnalysis() {
      if (!state.expiredAnalysis) return false;
      return expiredAnalysisKey === null || expiredAnalysisKey === expiredSourceKey();
    }

    // The sample the rescue measures: the engine's analysis-area preview when
    // the conversion produced one, otherwise the positive inside the colour
    // analysis region (its 16-bit plane when there is one). Without a region
    // the same border buffer as the engine's histogram keeps a rebate or a
    // scanner edge out of the measurement.
    // `placement` says where the sample sits in the frame (normalised), so
    // the spatial stage measured on it lands on the right pixels of the
    // full frame.
    function expiredAnalysisSample(processed, settings, sourceImageData) {
      const roi = resolveAnalysisRegion(settings, sourceImageData);
      const borderBuffer = Math.max(0, Math.min(0.3, sanitizeNumeric(settings.coreBorderBuffer, 10, 0, 30) / 100));
      const whole = { left: 0, top: 0, width: 1, height: 1 };
      const inset = (rect, amount) => ({
        left: rect.left + rect.width * amount,
        top: rect.top + rect.height * amount,
        width: rect.width * (1 - 2 * amount),
        height: rect.height * (1 - 2 * amount)
      });
      if (processed.__image16 && processed.__image16.data instanceof Uint16Array) {
        return {
          image: processed,
          options: { region: roi ? analysisPixelBounds(processed.width, processed.height, roi, 0.02) : null, borderBuffer },
          placement: whole
        };
      }
      if (processed.__analysisPreview) {
        return { image: processed.__analysisPreview, options: {}, placement: inset(roi || whole, borderBuffer) };
      }
      const base = downsampleImageDataForMaxPixels(processed, 600000);
      return {
        image: roi ? cropImageData(base, analysisPixelBounds(base.width, base.height, roi, 0.02)) : base,
        options: { borderBuffer: roi ? 0 : borderBuffer },
        placement: roi ? inset(roi, 0.02) : whole
      };
    }

    // OpenCV's part of the measurement: the fog surface and the local mean
    // across the frame, then the curves measured on the flattened frame.
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

    // Batch exports measure a never-opened frame in one go: with OpenCV when
    // it loads, the global measurement alone otherwise.
    async function measureExpiredAnalysisForExport(processed, settings, sourceImageData) {
      if (await ensureOpenCvReady()) {
        try {
          const analysis = measureExpiredAnalysisWithSpatial(processed, settings, sourceImageData);
          if (analysis) return analysis;
        } catch (error) {
          console.warn('Expired film: OpenCV measurement failed', error);
        }
      }
      const sample = expiredAnalysisSample(processed, settings, sourceImageData);
      return analyzeExpiredFilm(sample.image, { ...sample.options, anchors: settings.semanticMap, placement: sample.placement });
    }

    let expiredOpenCvState = 'idle';

    // Phase two of the interactive measurement. The global result is on
    // screen immediately; OpenCV loads (once per session) and the frame is
    // re-measured with its fog surface, replacing the analysis in place.
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

    // A frame's first measurement sets brightness and contrast from what it
    // measured, unless the user (or a sync) already moved them off the defaults.
    function applyExpiredAnalysisDefaults(target, analysis, { force = false } = {}) {
      const auto = defaultExpiredRescueParams(analysis);
      if (force || target.expiredBrightness === EXPIRED_RESCUE_DEFAULTS.expiredBrightness) target.expiredBrightness = auto.expiredBrightness;
      if (force || target.expiredContrast === EXPIRED_RESCUE_DEFAULTS.expiredContrast) target.expiredContrast = auto.expiredContrast;
      target.expiredAnalysis = analysis;
    }

    function resetExpiredStrengthsInState({ force = true } = {}) {
      for (const key of EXPIRED_RESCUE_KEYS) if (key !== 'expiredEnabled') state[key] = EXPIRED_RESCUE_DEFAULTS[key];
      if (state.expiredAnalysis) applyExpiredAnalysisDefaults(state, state.expiredAnalysis, { force });
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
    }

    // Runs once per conversion source (file, crop, film type). A rescued frame
    // keeps its measurement across core-control tweaks, so the sliders never
    // chase the user's own adjustments.
    function maybeAnalyzeExpiredRescue(processed) {
      if (!state.expiredEnabled) return;
      const key = expiredSourceKey();
      if (state.expiredAnalysis && expiredAnalysisKey === null) {
        expiredAnalysisKey = key;
        // A measurement saved before OpenCV had its say gets its fog map now.
        if (!state.expiredAnalysis.spatial) void runExpiredSpatialAnalysis();
      } else if (!state.expiredAnalysis || expiredAnalysisKey !== key) {
        runExpiredAnalysis(processed);
      }
      if (expiredTabPending) {
        expiredTabPending = false;
        studioWorkspace?.selectTab?.('expired');
      }
    }

    function expiredHueName(hue) {
      if (!hue) return getLocalizedText('expiredNone', 'none');
      return getLocalizedText(`hue${hue[0].toUpperCase()}${hue.slice(1)}`, hue);
    }

    function updateExpiredRescueUI() {
      if (!stateReady) return;
      const section = document.getElementById('expiredSection');
      const checkbox = document.getElementById('expiredEnabled');
      if (!section || !checkbox) return;
      const ready = state.currentStep >= 3 && Boolean(state.processedImageData) && !document.body.dataset.studioBusy;
      const enabled = Boolean(state.expiredEnabled);
      checkbox.checked = enabled;
      checkbox.disabled = !ready;
      document.getElementById('expiredControls').hidden = !enabled;
      const info = enabled && state.expiredAnalysis ? describeExpiredAnalysis(state.expiredAnalysis) : null;
      const lines = [];
      if (!ready) {
        lines.push(getLocalizedText('expiredNeedPhoto', 'Add and convert a photo first.'));
      } else if (!enabled) {
        lines.push(getLocalizedText('expiredOff', 'Expired-film rescue is off for this photo.'));
      } else if (!info) {
        lines.push(getLocalizedText('expiredNoAnalysis', 'Not analysed yet.'));
      } else {
        const type = sanitizePresetType(state.filmType || 'color');
        lines.push(type === 'positive'
          ? getLocalizedText('expiredDiagSourcePositive', 'Source: positive scan, rescued directly')
          : getInterpolatedText('expiredDiagSourceNegative', { type: getLocalizedText(type === 'bw' ? 'bwFilm' : 'colorFilm', type) }, 'Source: negative, converted first'));
        lines.push(getInterpolatedText('expiredDiagFog', { fog: String(info.fogPercent), range: String(info.rangePercent) }, `Fog: black point raised ${info.fogPercent}%`));
        lines.push(info.cast
          ? getInterpolatedText('expiredDiagCast', { hue: expiredHueName(info.cast), strength: String(info.castPercent) }, `Overall cast: ${info.cast}`)
          : getLocalizedText('expiredDiagNoCast', 'Overall cast: none to speak of'));
        lines.push(info.shadowCast || info.highlightCast
          ? getInterpolatedText('expiredDiagCrossover', { shadow: expiredHueName(info.shadowCast), highlight: expiredHueName(info.highlightCast) }, 'Crossover present')
          : getLocalizedText('expiredDiagNoCrossover', 'Crossover: none to speak of'));
        const stops = Math.abs(info.exposureStops).toFixed(1);
        lines.push(info.exposureStops <= -0.3
          ? getInterpolatedText('expiredDiagUnderexposed', { stops }, `Underexposed by about ${stops} stops`)
          : info.exposureStops >= 0.3
            ? getInterpolatedText('expiredDiagOverexposed', { stops }, `Overexposed by about ${stops} stops`)
            : getLocalizedText('expiredDiagExposureOk', 'Exposure: midtones sit where they should'));
        if (info.hasSpatial) {
          lines.push(info.unevenFogPercent >= 2
            ? getInterpolatedText('expiredDiagUneven', { amp: String(info.unevenFogPercent) }, `Uneven fog: ${info.unevenFogPercent}% across the frame, flattened`)
            : getLocalizedText('expiredDiagEven', 'Uneven fog: none to speak of'));
        } else {
          lines.push(getLocalizedText(expiredOpenCvState === 'failed' ? 'expiredDiagOpenCvFailed' : 'expiredDiagOpenCvLoading', expiredOpenCvState === 'failed' ? 'OpenCV unavailable: global rescue only' : 'OpenCV is loading…'));
        }
        if (info.lowBitDepth) lines.push(getInterpolatedText('expiredDiagBits', { levels: String(info.levelsUsed) }, `Only about ${info.levelsUsed} usable levels`));
      }
      for (const id of ['expiredUnevenFog', 'expiredLocalContrast']) {
        const disabled = !ready || !enabled || !info?.hasSpatial;
        document.getElementById(id).disabled = disabled;
        document.getElementById(`${id}Value`).disabled = disabled;
      }
      const list = document.getElementById('expiredDiagnosis');
      list.replaceChildren(...lines.map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
      list.dataset.state = !ready ? 'idle' : !enabled ? 'off' : info ? 'analysed' : 'pending';
      const hasOthers = state.fileQueue.some((item) => item.selected && item.file !== state.loadedFile);
      document.getElementById('expiredAnalyzeBtn').disabled = !ready || !enabled;
      document.getElementById('expiredResetBtn').disabled = !ready || !enabled;
      document.getElementById('expiredCompareBtn').disabled = !ready || !enabled || !state.expiredAnalysis;
      document.getElementById('expiredApplySelectedBtn').disabled = !ready || !hasOthers;
    }

    function setExpiredEnabled(enabled, { reanalyze = false, undoLabel = 'expiredEnabled' } = {}) {
      const next = Boolean(enabled);
      if (Boolean(state.expiredEnabled) === next && !reanalyze) {
        updateExpiredRescueUI();
        return;
      }
      pushUndo(undoLabel);
      state.expiredEnabled = next;
      if (next) {
        // Gains from the automatic gray point would fight the per-band balance.
        if (state.wbAutoConfidence && state.wbAutoConfidence !== 'low') {
          state.wbR = 1;
          state.wbG = 1;
          state.wbB = 1;
          state.wbAutoConfidence = null; state.wbSemanticApplied = false;
          updateWBSliders();
          updateGrayPointGuideUI();
        }
        if (reanalyze) resetExpiredStrengthsInState({ force: true });
        if (state.processedImageData && (reanalyze || !hasCurrentExpiredAnalysis())) {
          runExpiredAnalysis(state.processedImageData, { force: reanalyze });
        }
      }
      markCurrentFileDirty();
      updateExpiredRescueUI();
      studioWorkspace?.sync();
      schedulePreviewUpdate();
      scheduleFullUpdate();
    }

    // The session-level entry: photos added while it is on start rescued, and
    // the Studio shows the rescue tab first.
    function setExpiredSession(on, { fromEntry = false } = {}) {
      const next = Boolean(on);
      const changed = state.expiredSession !== next;
      state.expiredSession = next;
      if (next) expiredTabPending = true;
      if (state.originalImageData && Boolean(state.expiredEnabled) !== next) setExpiredEnabled(next);
      else updateExpiredRescueUI();
      if (next && state.processedImageData && expiredTabPending) {
        expiredTabPending = false;
        studioWorkspace?.selectTab?.('expired');
      }
      studioWorkspace?.sync();
      if (changed && !fromEntry) {
        showToast(getLocalizedText(next ? 'expiredSessionOn' : 'expiredSessionOff', next ? 'Expired-roll rescue is on.' : 'Expired-roll rescue is off.'), 3500);
      }
    }

    function resetExpiredStrengths() {
      if (!state.processedImageData) return;
      pushUndo('expiredReset');
      resetExpiredStrengthsInState({ force: true });
      syncAllSlidersFromState();
      markCurrentFileDirty();
      updateExpiredRescueUI();
      schedulePreviewUpdate();
      scheduleFullUpdate();
    }

    // After "Reset color" put back the defaults: strengths from this frame's
    // measurement, and a measurement if the rescue is now on without one.
    function refreshExpiredAfterColorReset() {
      if (state.expiredEnabled && state.processedImageData && !hasCurrentExpiredAnalysis()) runExpiredAnalysis(state.processedImageData);
      else if (state.expiredAnalysis) applyExpiredAnalysisDefaults(state, state.expiredAnalysis, { force: true });
      updateExpiredRescueUI();
    }

    function applyExpiredToSelected() {
      const patch = {};
      for (const key of EXPIRED_RESCUE_KEYS) patch[key] = state[key];
      const targets = state.fileQueue.filter((item) => item.selected && item.file !== state.loadedFile);
      for (const item of targets) {
        if (item.settings) item.settings = { ...item.settings, ...patch };
        else item.studioColors = { ...(item.studioColors || {}), ...patch };
        item.isDirty = false;
        item.status = 'pending';
      }
      updateFileListUI();
      showToast(getInterpolatedText('expiredAppliedSelected', { count: String(targets.length) }, `Strengths applied to ${targets.length} photo(s)`));
      scheduleProjectRecovery();
    }

    const expiredSliderHandlers = {
      onInput: () => schedulePreviewUpdate(),
      onCommit: () => {
        schedulePreviewUpdate();
        scheduleFullUpdate();
      }
    };
    for (const key of ['expiredLevels', 'expiredNeutralize', 'expiredCrossover', 'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast']) {
      setupSlider(key, key, expiredSliderHandlers);
    }
    document.getElementById('expiredEnabled')?.addEventListener('change', (event) => setExpiredEnabled(event.target.checked));
    document.getElementById('expiredAnalyzeBtn')?.addEventListener('click', () => {
      if (!state.processedImageData) return;
      pushUndo('expiredAnalyze');
      runExpiredAnalysis(state.processedImageData, { force: true });
      schedulePreviewUpdate();
      scheduleFullUpdate();
    });
    document.getElementById('expiredResetBtn')?.addEventListener('click', resetExpiredStrengths);
    document.getElementById('expiredApplySelectedBtn')?.addEventListener('click', applyExpiredToSelected);
    {
      const compareBtn = document.getElementById('expiredCompareBtn');
      const holdCompare = (held) => {
        if (!compareBtn || expiredCompareHeld === held) return;
        expiredCompareHeld = held;
        compareBtn.classList.toggle('active', held);
        compareBtn.setAttribute('aria-pressed', held ? 'true' : 'false');
        schedulePreviewUpdate();
        if (!held) scheduleFullUpdate();
      };
      compareBtn?.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        holdCompare(true);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'blur']) compareBtn?.addEventListener(type, () => holdCompare(false));
      compareBtn?.addEventListener('keydown', (event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        holdCompare(true);
      });
      compareBtn?.addEventListener('keyup', () => holdCompare(false));
    }

    // ===========================================
    // Match a lab scan: align the lab's JPEG and fit a colour look
    // ===========================================
    let labMatchReferenceFile = null;
    let labMatchRunning = false;

    function updateLabMatchUI() {
      if (!stateReady) return;
      const status = document.getElementById('labMatchStatus');
      const runBtn = document.getElementById('labMatchRunBtn');
      const applyBtn = document.getElementById('labMatchApplySelectedBtn');
      const clearBtn = document.getElementById('labMatchClearBtn');
      if (!status || !runBtn || !applyBtn || !clearBtn) return;
      const look = state.look;
      if (labMatchRunning) {
        status.textContent = getLocalizedText('labMatchRunning', 'Aligning and fitting…');
      } else if (look && look.source) {
        const key = look.method === 'aligned-affine' ? 'labMatchStatusAligned' : 'labMatchStatusHistogram';
        status.textContent = getInterpolatedText(key, {
          name: look.source,
          inliers: String(look.inliers || 0),
          before: look.deltaBefore === null ? '?' : String(look.deltaBefore),
          after: look.deltaAfter === null ? '?' : String(look.deltaAfter)
        }, `From ${look.source}`);
      } else if (labMatchReferenceFile) {
        status.textContent = getInterpolatedText('labMatchStatusPicked', { name: labMatchReferenceFile.name }, `${labMatchReferenceFile.name} chosen; press Match.`);
      } else {
        status.textContent = getLocalizedText('labMatchStatusNone', 'No lab scan matched yet.');
      }
      const ready = state.currentStep >= 3 && Boolean(state.processedImageData) && !document.body.dataset.studioBusy;
      runBtn.disabled = !labMatchReferenceFile || !ready || labMatchRunning;
      applyBtn.disabled = !look || labMatchRunning;
      clearBtn.disabled = !look || labMatchRunning;
    }

    async function decodeReferenceImage(file, maxSide) {
      const bitmap = await createImageBitmap(file);
      try {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const surface = document.createElement('canvas');
        surface.width = width;
        surface.height = height;
        const ctx = surface.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
      } finally {
        bitmap.close?.();
      }
    }

    // Our current rendering without the look, at analysis size.
    function renderCurrentForMatching(maxSide) {
      const positive = state.processedImageData;
      if (!positive) return null;
      const small = downsampleImageDataForMaxDim(positive, maxSide);
      const output = new ImageData(small.width, small.height);
      applyAdjustmentsToBuffer(small, { ...state, look: null }, output, 'preview');
      return output;
    }

    function resizeImageDataNearest(imageData, width, height) {
      const out = new ImageData(width, height);
      for (let y = 0; y < height; y++) {
        const sy = Math.min(imageData.height - 1, Math.floor((y / height) * imageData.height));
        for (let x = 0; x < width; x++) {
          const sx = Math.min(imageData.width - 1, Math.floor((x / width) * imageData.width));
          const si = (sy * imageData.width + sx) * 4; const di = (y * width + x) * 4;
          out.data[di] = imageData.data[si]; out.data[di + 1] = imageData.data[si + 1]; out.data[di + 2] = imageData.data[si + 2]; out.data[di + 3] = imageData.data[si + 3];
        }
      }
      return out;
    }

    async function runLabMatch() {
      if (labMatchRunning || !labMatchReferenceFile) return;
      if (state.currentStep < 3 || !state.processedImageData) {
        void appAlert(getLocalizedText('labMatchNeedPhoto', 'Convert a photo first.'));
        return;
      }
      labMatchRunning = true;
      updateLabMatchUI();
      try {
        const ours = renderCurrentForMatching(1000);
        let reference;
        try {
          reference = await decodeReferenceImage(labMatchReferenceFile, 1600);
        } catch (error) {
          console.warn('Lab match reference decode failed:', error);
          void appAlert(getLocalizedText('labMatchFailed', 'The reference image could not be read.'));
          return;
        }
        let alignment = null;
        if (await ensureOpenCvReady()) {
          try { alignment = estimateAlignment(ours, reference, { maxSide: 1000 }); }
          catch (error) { console.warn('Lab match alignment failed:', error); }
        }
        let pairs; let aligned = false;
        if (alignment) {
          const warped = warpImageData(reference, alignment.homography, ours.width, ours.height);
          pairs = collectPairs(ours, warped, { step: 2 });
          aligned = pairs.count >= 400;
        }
        if (!aligned) {
          pairs = collectPairs(ours, resizeImageDataNearest(reference, ours.width, ours.height), { step: 2, skipClipped: true });
        }
        const fit = fitLook(pairs, { aligned });
        if (!fit) {
          void appAlert(getLocalizedText('labMatchFailed', 'The reference image could not be read.'));
          return;
        }
        pushUndo('labMatch');
        state.look = sanitizeLookForSettings({
          ...fit.look,
          source: labMatchReferenceFile.name,
          method: fit.method,
          inliers: aligned ? alignment.inliers : 0,
          deltaBefore: fit.deltaBefore,
          deltaAfter: fit.deltaAfter
        });
        markCurrentFileDirty();
        schedulePreviewUpdate();
        scheduleFullUpdate();
      } finally {
        labMatchRunning = false;
        updateLabMatchUI();
      }
    }

    function applyLookToSelected() {
      if (!state.look) return;
      const targets = state.fileQueue.filter((item) => item.selected && item.file !== state.loadedFile);
      for (const item of targets) {
        const look = structuredClone(state.look);
        if (item.settings) item.settings = { ...item.settings, look };
        else item.studioColors = { ...(item.studioColors || {}), look };
        item.isDirty = false;
        item.status = 'pending';
      }
      updateFileListUI();
      showToast(getInterpolatedText('labMatchApplied', { count: String(targets.length) }, `Look applied to ${targets.length} photo(s)`));
    }

    function clearLook() {
      if (!state.look) return;
      pushUndo('labMatch');
      state.look = null;
      markCurrentFileDirty();
      updateLabMatchUI();
      showToast(getLocalizedText('labMatchCleared', 'Look cleared.'));
      schedulePreviewUpdate();
      scheduleFullUpdate();
    }

    document.getElementById('labMatchInput')?.addEventListener('change', (event) => {
      labMatchReferenceFile = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      updateLabMatchUI();
    });
    document.getElementById('labMatchRunBtn')?.addEventListener('click', () => { void runLabMatch(); });
    document.getElementById('labMatchApplySelectedBtn')?.addEventListener('click', applyLookToSelected);
    document.getElementById('labMatchClearBtn')?.addEventListener('click', clearLook);

    // ===========================================
    // AI repair: learned inpainting on the commit and export paths
    // ===========================================
    const aiRepair = { release: null, trim: null, status: 'idle', provider: '', run: null, source: '', sourceRef: null, prefer: '', released: false, error: '', percent: 0, tiles: 0, ms: 0, revision: 0 };
    let pendingBrushRepairs = 0;
    let aiRepairRunsInFlight = 0;

    // Hidden-window shedding (#241): a warmed MI-GAN session holds 0.6-0.8 GB
    // of WASM heap in WKWebView. Release it while no run, brush repair or dust
    // pass needs it. The next load brings back the same model (a picked file
    // included) on the same provider under the same `revision`, so photo keys
    // and thumbnails stay valid.
    async function releaseAiRepairSession() {
      if (aiRepair.status !== 'ready' || typeof aiRepair.release !== 'function'
        || aiRepairRunsInFlight || pendingBrushRepairs || state.dustRemoval.processing) return false;
      const release = aiRepair.release;
      aiRepair.run = null;
      aiRepair.trim = null;
      aiRepair.release = null;
      aiRepair.status = 'idle';
      aiRepair.released = true;
      updateAiRepairUI();
      try { await release(); } catch (error) { console.warn('AI repair release failed:', error); }
      return true;
    }
    // Every model run counts, and each one restarts the idle release (#236).
    async function countAiRepairRun(run) {
      aiRepairRunsInFlight += 1;
      try { return await run(); } finally {
        aiRepairRunsInFlight -= 1;
        noteAiRepairUsed();
      }
    }
    // What an implicit load asks for: the bundled model, or after an idle
    // release the released model on its provider.
    function aiRepairLoadArgs(options = {}) {
      return aiRepair.released && aiRepair.sourceRef
        ? [aiRepair.sourceRef, { ...options, prefer: aiRepair.prefer || undefined }]
        : [DEFAULT_MODEL_URL, options];
    }

    // Idle release (#236): a warmed MI-GAN session holds 0.6-1.7 GB. After
    // about 5 minutes without a run, with no run, brush repair, dust pass or
    // long job (batch export, contact sheet) pending, the session and its
    // worker are released the way a hidden window releases them, so the next
    // load brings back the same model under the same `revision` and warm
    // photo sessions with dust on stay cache hits.
    const AI_REPAIR_IDLE_RELEASE_MS = 5 * 60 * 1000;
    const AI_REPAIR_IDLE_RECHECK_MS = 30 * 1000;
    let aiRepairIdleTimer = null;
    let aiRepairLastUsed = 0;
    function noteAiRepairUsed() {
      aiRepairLastUsed = getPerfNow();
      clearTimeout(aiRepairIdleTimer);
      aiRepairIdleTimer = aiRepair.status === 'ready' ? setTimeout(releaseIdleAiRepair, AI_REPAIR_IDLE_RELEASE_MS) : null;
    }
    function canReleaseIdleAiRepair(now = getPerfNow()) {
      return aiRepair.status === 'ready' && typeof aiRepair.release === 'function'
        && !aiRepairRunsInFlight && !pendingBrushRepairs && !activeLongJobs
        && !state.dustRemoval.processing && !dustDetectionTimer
        && now - aiRepairLastUsed >= AI_REPAIR_IDLE_RELEASE_MS;
    }
    async function releaseIdleAiRepair() {
      aiRepairIdleTimer = null;
      if (aiRepair.status !== 'ready') return false;
      if (!canReleaseIdleAiRepair()) {
        aiRepairIdleTimer = setTimeout(releaseIdleAiRepair, AI_REPAIR_IDLE_RECHECK_MS);
        return false;
      }
      return releaseAiRepairSession();
    }

    async function inpaintManualBrush(source, settings = state, base = state.loadedBaseImageData || state.originalImageData,
      lensMapping = settings === state ? state.conversionSourceImageData?.__lensMapping : null, isCurrent = () => true,
      { memoInsert = true } = {}) {
      assertRepairCurrent(isCurrent);
      const strokes = settings.repairStrokes || [];
      if (!strokes.length) return source;
      while (aiRepair.status === 'loading') {
        await new Promise(resolve => setTimeout(resolve, 50));
        assertRepairCurrent(isCurrent);
      }
      if (aiRepair.status !== 'ready') await loadAiRepairModel(...aiRepairLoadArgs({ refresh: false }));
      assertRepairCurrent(isCurrent);
      if (aiRepair.status !== 'ready') throw new Error(aiRepair.error || 'AI repair model is not ready');
      const geometry = { ...localExposureGeometryFor(settings, base), width: source.width, height: source.height };
      // Built inside the strokes' bounds; the bounds also limit the box scan.
      const { mask, bounds } = buildRepairMask(strokes, geometry, lensMapping);
      const started = performance.now();
      let result;
      try {
        result = await countAiRepairRun(() => inpaintWithModel(source, mask, aiRepair.run, {
          shouldContinue: isCurrent, memoInsert, maskBounds: bounds || { x: 0, y: 0, width: 0, height: 0 },
          onProgress: (done, total) => {
            document.getElementById('dustAiStatus').textContent = getInterpolatedText('dustAiStatusRunning', { done, total });
          }
        }));
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        assertRepairCurrent(isCurrent);
        if (aiRepair.provider === 'webgpu') {
          await loadAiRepairModel(aiRepair.sourceRef || DEFAULT_MODEL_URL, { prefer: 'wasm', refresh: false });
          if (aiRepair.status === 'ready') return inpaintManualBrush(source, settings, base, lensMapping, isCurrent, { memoInsert });
        }
        aiRepair.status = 'error';
        aiRepair.error = error?.message || String(error);
        updateAiRepairUI();
        aiRepair.revision += 1;
        throw error;
      }
      aiRepair.tiles = result.tiles;
      aiRepair.ms = Math.round(performance.now() - started);
      updateAiRepairUI();
      return result.imageData;
    }

    function canPaintAiBrush() {
      return Boolean(document.getElementById('aiBrushEnabled')?.checked
        && document.getElementById('studioTab-repair')?.getAttribute('aria-selected') === 'true'
        && state.currentStep >= 3 && !state.cropping && !state.samplingMode);
    }

    let aiBrushDrawing = null;
    const brushOverlay = document.createElement('canvas');
    brushOverlay.id = 'aiBrushOverlay';
    brushOverlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20;';
    document.getElementById('canvasTransformWrapper').append(brushOverlay);

    function paintAiBrushOverlay() {
      brushOverlay.width = canvas.width;
      brushOverlay.height = canvas.height;
      if (!aiBrushDrawing) return;
      const ctx = brushOverlay.getContext('2d');
      const { geometry, points, size } = aiBrushDrawing;
      const cropShort = Math.min(geometry.cropRegion?.width || geometry.rotatedWidth, geometry.cropRegion?.height || geometry.rotatedHeight);
      const radius = size * Math.min(geometry.baseWidth, geometry.baseHeight) * Math.min(geometry.width, geometry.height) / cropShort / 2;
      ctx.scale(canvas.width / geometry.width, canvas.height / geometry.height);
      ctx.lineWidth = radius * 2;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = ctx.fillStyle = 'rgba(244, 180, 105, 0.55)';
      ctx.beginPath();
      points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2); ctx.fill(); }
    }

    function finishAiBrush(event, cancelled = false) {
      const drawing = aiBrushDrawing;
      if (!drawing || event.pointerId !== drawing.pointerId) return;
      aiBrushDrawing = null;
      paintAiBrushOverlay();
      if (drawing.surface.hasPointerCapture?.(event.pointerId)) drawing.surface.releasePointerCapture(event.pointerId);
      if (cancelled || !canPaintAiBrush() || drawing.source !== state.conversionSourceImageData || drawing.token !== coreReprocessToken) return;
      pushUndo('dustBrushStroke');
      state.repairStrokes = sanitizeRepairStrokes([...state.repairStrokes, {
        size: drawing.size,
        points: drawing.points.map(point => workingPointToBase(lensSourcePoint(point, drawing.lensMapping), drawing.geometry))
      }]);
      markCurrentFileDirty();
      if (!state.dustRemoval.cleanSource) state.dustRemoval.cleanSource = state.processedImageData;
      scheduleDustDetection();
    }

    for (const surface of [canvas, glCanvas]) {
      surface.addEventListener('pointerdown', event => {
        if (!canPaintAiBrush() || event.button !== 0) return;
        if (aiBrushDrawing) {
          finishAiBrush({ pointerId: aiBrushDrawing.pointerId }, true);
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (aiRepair.status !== 'ready') {
          // The brush waits for its model (the status line shows the load);
          // say so instead of dropping the stroke silently.
          ensureAiRepairPreload();
          showToast(aiRepair.status === 'error'
            ? getInterpolatedText('dustAiStatusError', { message: aiRepair.error }, `Model failed: ${aiRepair.error}. Load a MI-GAN Pipeline ONNX file instead.`)
            : getLocalizedText('aiBrushModelLoading', 'The repair model is still loading. Paint again once it is ready.'), 3000);
          return;
        }
        if (state.processedImageDataIsPreview || state.dustRemoval.processing) return;
        const source = state.processedImageData;
        const rect = surface.getBoundingClientRect();
        const point = pointerToRepairPoint(event, rect, source.width, source.height);
        if (!point) return;
        aiBrushDrawing = {
          pointerId: event.pointerId, surface, rect, source: state.conversionSourceImageData, token: coreReprocessToken,
          geometry: { ...localExposureGeometryFor(state), width: source.width, height: source.height },
          lensMapping: state.conversionSourceImageData?.__lensMapping,
          points: [point], size: Number(document.getElementById('aiBrushSize').value) / 100
        };
        surface.setPointerCapture?.(event.pointerId);
        paintAiBrushOverlay();
      }, { capture: true, passive: false });
      surface.addEventListener('pointermove', event => {
        if (!aiBrushDrawing || event.pointerId !== aiBrushDrawing.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const { geometry, rect } = aiBrushDrawing;
        const point = pointerToRepairPoint(event, rect, geometry.width, geometry.height);
        if (point) aiBrushDrawing.points.push(point);
        paintAiBrushOverlay();
      }, { passive: false });
      surface.addEventListener('pointerup', event => finishAiBrush(event));
      surface.addEventListener('pointercancel', event => finishAiBrush(event, true));
      surface.addEventListener('lostpointercapture', event => finishAiBrush(event, true));
    }
    document.getElementById('aiBrushEnabled').addEventListener('change', async event => {
      if (event.target.checked) {
        state.dodgeBurn.active = false;
        updateDodgeBurnUI();
        state.dustRemoval.showMask = false;
        document.getElementById('dustShowMask').checked = false;
        updateDustControlsVisibility();
        updateCanvasVisibility();
        updatePreview();
        syncDustWorkerPin();
        updateAiRepairUI();
        await ensureFullResolutionReadyForExport();
        if (aiRepair.status !== 'ready') await loadAiRepairModel(...aiRepairLoadArgs());
      } else {
        if (aiBrushDrawing) finishAiBrush({ pointerId: aiBrushDrawing.pointerId }, true);
        updateAiRepairUI();
      }
    });
    document.getElementById('aiBrushSize').addEventListener('input', event => {
      document.getElementById('aiBrushSizeValue').textContent = `${event.target.value}%`;
    });
    document.getElementById('aiBrushClear').addEventListener('click', () => {
      if (!state.repairStrokes.length) return;
      pushUndo('dustBrushStroke');
      state.repairStrokes = [];
      markCurrentFileDirty();
      const source = getDustSource();
      if (source) applyProcessedImageToState(source, { previewOnly: state.processedImageDataIsPreview });
      clearDustState();
      state.dustRemoval.cleanSource = state.dustRemoval.enabled ? source : null;
      if (state.dustRemoval.enabled) scheduleDustDetection();
      updatePreview();
    });

    function aiRepairReady() {
      return Boolean(state.dustRemoval.ai && aiRepair.status === 'ready' && typeof aiRepair.run === 'function');
    }

    function updateAiRepairUI() {
      const status = document.getElementById('dustAiStatus');
      const enabled = document.getElementById('dustAiEnabled');
      const loadBtn = document.getElementById('dustAiLoadBtn');
      if (enabled) enabled.checked = Boolean(state.dustRemoval.ai);
      if (loadBtn) loadBtn.disabled = aiRepair.status === 'loading';
      // A checked AI brush is disabled until its model is ready.
      const brushWaiting = Boolean(document.getElementById('aiBrushEnabled')?.checked) && aiRepair.status !== 'ready';
      document.getElementById('aiBrushSection')?.toggleAttribute('data-model-pending', brushWaiting);
      if (!status) return;
      const providerName = aiRepair.provider === 'webgpu' ? 'WebGPU' : 'WASM';
      let text;
      if (aiRepair.status === 'loading') {
        text = getInterpolatedText('dustAiStatusLoading', { percent: String(aiRepair.percent) }, `Loading model… ${aiRepair.percent}%`);
      } else if (aiRepair.status === 'ready') {
        text = getInterpolatedText('dustAiStatusReady', { source: aiRepair.source, provider: providerName }, `Model ready: ${aiRepair.source} on ${providerName}`);
        if (aiRepair.tiles) text += ' · ' + getInterpolatedText('dustAiStatusLast', { tiles: String(aiRepair.tiles), ms: String(aiRepair.ms) }, `last run ${aiRepair.tiles} tile(s) in ${aiRepair.ms} ms`);
      } else if (aiRepair.status === 'error') {
        text = getInterpolatedText('dustAiStatusError', { message: aiRepair.error }, `Model failed: ${aiRepair.error}. Load a MI-GAN Pipeline ONNX file instead.`);
      } else {
        text = getLocalizedText(inpaintBackends().webgpu ? 'dustAiStatusIdleGpu' : 'dustAiStatusIdleWasm', 'No model loaded.');
      }
      status.textContent = text;
    }

    // `source` is a File (a model the user picked) or a URL (the self-hosted
    // asset, fetched once and cached in IndexedDB).
    const loadAiRepairModel = createAiModelLoader(performAiRepairModelLoad, DEFAULT_MODEL_URL);

    async function performAiRepairModelLoad(source, { prefer = defaultInferencePreference(), refresh = true } = {}) {
      // Reloading a released model (hidden-window or idle release) on its
      // provider keeps its revision.
      const reload = aiRepair.released && source === aiRepair.sourceRef && prefer === aiRepair.prefer;
      const previousProvider = aiRepair.provider;
      aiRepair.released = false;
      if (!reload) aiRepair.revision += 1;
      aiRepair.status = 'loading';
      aiRepair.percent = 0;
      aiRepair.error = '';
      updateAiRepairUI();
      try {
        aiRepair.run = null;
        aiRepair.trim = null;
        await aiRepair.release?.();
        aiRepair.release = null;
        let bytes; let label;
        if (source instanceof File) {
          bytes = await source.arrayBuffer();
          label = source.name;
        } else {
          bytes = await fetchModelBytes(source, {
            onProgress: (received, total) => {
              aiRepair.percent = total ? Math.round((received / total) * 100) : 0;
              updateAiRepairUI();
            }
          });
          // The bundled model's URL carries Vite's content hash; show its plain name.
          label = String(source).split('/').pop().replace(/-[\w-]{8}(\.onnx)$/, '$1');
        }
        const session = await createInpaintSessionInWorker(bytes, { prefer });
        aiRepair.run = session.run;
        aiRepair.release = session.release;
        // Shrinks the session's tile memo (#258); resolves to its size.
        aiRepair.trim = session.trim || null;
        aiRepair.provider = session.provider;
        aiRepair.source = label;
        aiRepair.sourceRef = source;
        aiRepair.prefer = prefer;
        aiRepair.status = 'ready';
        if (!reload || session.provider !== previousProvider) aiRepair.revision += 1;
        aiRepair.tiles = 0;
        noteAiRepairUsed();
      } catch (error) {
        console.warn('AI repair model failed:', error);
        aiRepair.status = 'error';
        aiRepair.error = error?.message || String(error);
        aiRepair.run = null;
      }
      updateAiRepairUI();
      if (refresh && hasFrameRepairs()) scheduleDustDetection();
    }

    // The commit-path inpaint: the learned model when it is on and ready,
    // TELEA otherwise (and always for brush strokes, which stay interactive).
    // `report`, when given, learns which inpainter ran (`usedAi`), the model
    // revision it ran with and, for MI-GAN, the blocks it wrote.
    async function inpaintForCommit(source, mask, isCurrent = () => true, worker = null, { memoInsert = true, report = null } = {}) {
      assertRepairCurrent(isCurrent);
      if (state.dustRemoval.ai && aiRepair.status === 'idle') await loadAiRepairModel(...aiRepairLoadArgs({ refresh: false }));
      while (state.dustRemoval.ai && aiRepair.status === 'loading') {
        await new Promise(resolve => setTimeout(resolve, 50));
        assertRepairCurrent(isCurrent);
      }
      assertRepairCurrent(isCurrent);
      if (report) Object.assign(report, { usedAi: aiRepairReady(), revision: aiRepair.revision, blocks: null });
      if (!aiRepairReady()) return inpaintDustOffMainThread(source, mask, isCurrent, worker);
      const started = performance.now();
      try {
        const { imageData, tiles, blocks } = await countAiRepairRun(() => inpaintWithModel(source, mask, aiRepair.run, {
          shouldContinue: isCurrent, memoInsert,
          onProgress: (done, total) => updateDustStatusUI(getInterpolatedText('dustAiStatusRunning', { done: String(done), total: String(total) }, `AI repair: tile ${done} / ${total}`))
        }));
        if (report) report.blocks = blocks;
        aiRepair.tiles = tiles;
        aiRepair.ms = Math.round(performance.now() - started);
        updateAiRepairUI();
        return imageData;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        assertRepairCurrent(isCurrent);
        console.warn('AI repair failed:', error);
        // A WebGPU session that fails mid-run is rebuilt on WASM once; only
        // when that fails too does TELEA take over.
        if (aiRepair.provider === 'webgpu' && aiRepair.sourceRef) {
          await loadAiRepairModel(aiRepair.sourceRef, { prefer: 'wasm', refresh: false });
          if (aiRepairReady()) return inpaintForCommit(source, mask, isCurrent, worker, { memoInsert, report });
        }
        aiRepair.status = 'error';
        aiRepair.revision += 1;
        aiRepair.error = error?.message || String(error);
        aiRepair.run = null;
        updateAiRepairUI();
        return inpaintDustOffMainThread(source, mask, isCurrent, worker);
      }
    }

    // ── Learned repair after a dust-brush stroke (#259) ──────────────────────
    // A stroke's TELEA patch also overwrote MI-GAN pixels of other dust and of
    // repair strokes inside its rect. Once it is visible, only the tiles that
    // cover such rects are inferred again, over a window of the repaired image
    // itself, and only the rects are written back. The result lands if the
    // dust state did not change meanwhile and then amends the stroke's history
    // entry; otherwise its rects stay queued for the next refresh, so no TELEA
    // stand-in is left behind. Preview only: export runs the from-scratch pass.
    function queueDustAiRefresh(rects) {
      for (const rect of rects) dustAiRefresh.rects.push({ ...rect });
      if (dustAiRefresh.timer) clearTimeout(dustAiRefresh.timer);
      // Coalesce quick strokes, as the whole-mask pass did.
      dustAiRefresh.timer = setTimeout(() => {
        dustAiRefresh.timer = null;
        void runDustAiRefresh().catch((error) => {
          if (error?.name === 'AbortError') return;
          console.warn('Brush repair failed:', error);
          showToast(error?.message || String(error), 'error');
        });
      }, 200);
    }

    // Rects whose context windows overlap are refreshed together.
    function mergeDustRefreshRects(rects) {
      const merged = rects.map(rect => ({ ...rect }));
      const near = (a, b) => a.x - AI_CONTEXT < b.x + b.width && b.x - AI_CONTEXT < a.x + a.width
        && a.y - AI_CONTEXT < b.y + b.height && b.y - AI_CONTEXT < a.y + a.height;
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < merged.length && !changed; i++) {
          for (let j = i + 1; j < merged.length; j++) {
            const a = merged[i], b = merged[j];
            if (!near(a, b)) continue;
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            merged[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
            merged.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
      return merged;
    }

    // The window the model sees: the rect with its context, at least one tile.
    function dustAiWindow(rect, width, height) {
      const axis = (start, length, limit) => {
        const size = Math.min(limit, Math.max(AI_TILE, length + 2 * AI_CONTEXT));
        const from = Math.max(0, Math.min(limit - size, Math.round(start + length / 2 - size / 2)));
        return [from, size];
      };
      const [x, w] = axis(rect.x, rect.width, width);
      const [y, h] = axis(rect.y, rect.height, height);
      return { x, y, width: w, height: h };
    }

    function cropDustImage(image, rect) {
      const { rgba8, rgba16 } = copyImageRect(image, rect);
      const crop = new ImageData(rgba8, rect.width, rect.height);
      if (rgba16) crop.__image16 = { width: rect.width, height: rect.height, data: rgba16 };
      return crop;
    }

    // `mask` restricted to `inside` (frame pixels), cut to `win`; null when empty.
    function cropDustMask(mask, width, win, inside) {
      const out = new Uint8Array(win.width * win.height);
      let any = false;
      const x0 = Math.max(win.x, inside.x), x1 = Math.min(win.x + win.width, inside.x + inside.width);
      for (let y = Math.max(win.y, inside.y); y < Math.min(win.y + win.height, inside.y + inside.height); y++) {
        for (let x = x0; x < x1; x++) {
          if (!mask[y * width + x]) continue;
          out[(y - win.y) * win.width + (x - win.x)] = 255;
          any = true;
        }
      }
      return any ? out : null;
    }

    let dustRefreshRepairMask = { strokes: null, source: null, mask: null };
    function repairStrokeMaskFor(target) {
      const strokes = state.repairStrokes;
      const source = state.dustRemoval.cleanSource;
      if (dustRefreshRepairMask.strokes !== strokes || dustRefreshRepairMask.source !== source) {
        const base = state.loadedBaseImageData || state.originalImageData;
        const geometry = { ...localExposureGeometryFor(state, base), width: target.width, height: target.height };
        dustRefreshRepairMask = { strokes, source,
          mask: buildRepairMask(strokes, geometry, state.conversionSourceImageData?.__lensMapping).mask };
      }
      return dustRefreshRepairMask.mask;
    }

    async function runDustAiRefresh() {
      const dust = state.dustRemoval;
      const target = dust.inpaintedImageData;
      const queued = dustAiRefresh.rects.slice();
      if (!queued.length || !target || !dust.cleanSource) return;
      const strokes = state.repairStrokes;
      const useDust = Boolean(aiRepairReady() && dust.enabled && dust.mask);
      if (!useDust && !strokes.length) {
        // TELEA is the repair when no model is on.
        dustAiRefresh.rects.length = 0;
        return;
      }
      if (strokes.length && aiRepair.status !== 'ready') return;
      const revision = dust.revision, token = coreReprocessToken, mask = dust.mask;
      const isCurrent = () => dust.revision === revision && dust.inpaintedImageData === target
        && coreReprocessToken === token && state.repairStrokes === strokes;
      pendingBrushRepairs += 1;
      const started = performance.now();
      try {
        const repair = strokes.length ? repairStrokeMaskFor(target) : null;
        const results = [];
        let tiles = 0;
        for (const rect of mergeDustRefreshRects(queued)) {
          const win = dustAiWindow(rect, target.width, target.height);
          let image = cropDustImage(target, win);
          for (const layer of [useDust ? mask : null, repair]) {
            const layerMask = layer && cropDustMask(layer, target.width, win, rect);
            if (!layerMask) continue;
            const pass = await inpaintWithModel(image, layerMask, aiRepair.run, { shouldContinue: isCurrent });
            image = pass.imageData;
            tiles += pass.tiles;
          }
          results.push({ rect, win, image });
        }
        if (!isCurrent()) return;
        const top = undoStack.at(-1)?.dustDelta;
        const entry = top?.target === target ? top : null;
        for (const { rect, win, image } of results) {
          const local = { x: rect.x - win.x, y: rect.y - win.y, width: rect.width, height: rect.height };
          const { rgba8, rgba16 } = copyImageRect(image, local);
          const write = () => pasteImageRect(target, rect, rgba8, rgba16);
          if (entry) amendDustDelta(entry, rect, write);
          else write();
        }
        dustAiRefresh.rects = dustAiRefresh.rects.filter(rect => !queued.some(done => done.x === rect.x
          && done.y === rect.y && done.width === rect.width && done.height === rect.height));
        if (entry && !dustAiRefresh.rects.length) entry.aiCleanAfter = true;
        aiRepair.tiles = tiles;
        aiRepair.ms = Math.round(performance.now() - started);
        updateAiRepairUI();
        refreshDustDisplay(target, results.map(result => result.rect), null, dust.revision);
      } catch (error) {
        if (error?.name === 'AbortError' || !isCurrent()) return;
        // A WebGPU session that fails mid-run is rebuilt on WASM once.
        if (aiRepair.provider === 'webgpu' && aiRepair.sourceRef) {
          await loadAiRepairModel(aiRepair.sourceRef, { prefer: 'wasm', refresh: false });
          if (aiRepair.status === 'ready' && isCurrent()) queueDustAiRefresh([]);
          return;
        }
        throw error;
      } finally {
        pendingBrushRepairs -= 1;
      }
    }

    document.getElementById('dustAiEnabled')?.addEventListener('change', (event) => {
      state.dustRemoval.ai = Boolean(event.target.checked);
      updateAiRepairUI();
      if (state.dustRemoval.ai && aiRepair.status === 'idle') void loadAiRepairModel(...aiRepairLoadArgs());
      else if (state.dustRemoval.enabled) scheduleDustDetection();
    });
    // Only a load the user asked for (the Load button or a picked model file)
    // is announced; implicit loads report through the status line alone.
    function loadAiRepairModelExplicitly(source) {
      void loadAiRepairModel(source).then(() => {
        if (aiRepair.status !== 'ready') return;
        showToast(getInterpolatedText('dustAiLoaded', { provider: aiRepair.provider === 'webgpu' ? 'WebGPU' : 'WASM' }, `AI repair model loaded (${aiRepair.provider})`));
      });
    }
    document.getElementById('dustAiLoadBtn')?.addEventListener('click', () => { loadAiRepairModelExplicitly(DEFAULT_MODEL_URL); });
    document.getElementById('dustAiModelInput')?.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) loadAiRepairModelExplicitly(file);
      event.target.value = '';
    });

    // MI-GAN loads on intent, never with a photo: dust removal is off by
    // default and the model holds 0.6-1.7 GB once warmed. The intents are the
    // Repair tab, dust removal turned on with AI, the AI brush, and a settled
    // photo whose recipe has repair strokes. Every repair still loads on
    // demand (inpaintManualBrush, inpaintForCommit), which covers export.
    function ensureAiRepairPreload() {
      if (aiRepair.status !== 'idle') return;
      void loadAiRepairModel(...aiRepairLoadArgs({ refresh: false }));
    }
    function scheduleAiRepairPreloadForRecipe() {
      if (!state.repairStrokes.length || aiRepair.status !== 'idle') return;
      const run = () => ensureAiRepairPreload();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 0);
    }
    updateAiRepairUI();

    // ===========================================
    // Linear DNG export (inverted, base-normalised raw)
    // ===========================================
    // `source` is the geometry-applied negative (16-bit plane when the file
    // carries one); the film base and film type come from `settings`.
    function linearDngInputs(source, settings) {
      if (!source) throw new Error('No image available for export.');
      const plane = source.__image16 && source.__image16.data instanceof Uint16Array ? source.__image16 : toImage16(source);
      const positive = sanitizePresetType(settings.filmType || 'color') === 'positive';
      const filmBase = requiresFilmBase(settings) && settings.filmBase ? settings.filmBase : null;
      return { plane, filmBase, positive };
    }

    // Single export: synchronous behind the overlay (about 0.3 s at 60 MP),
    // since it reads live editor state that must not change mid-build.
    function renderLinearDngBlob(source, settings, position) {
      const { plane, filmBase, positive } = linearDngInputs(source, settings);
      const linear = buildLinearPositive(plane, filmBase, { positive });
      return encodeLinearDngBlob(linear, { metadata: exportMetadataFor(settings, position) });
    }

    // Batch: the desktop batch keeps the editor live, so the build runs in
    // slices of about 16 ms with a task in between. It reads only the job's
    // own decoded source and settings. `new Blob` still copies the strip in
    // one call; its duration is traced (`blobMs`, ?debug=1 or ?perf=1) because moving
    // the batch build into the lane's export worker is the next step if it
    // exceeds 50 ms in the macOS app (#257).
    async function renderLinearDngBlobInSlices(source, settings, position) {
      const { plane, filmBase, positive } = linearDngInputs(source, settings);
      const trace = createPerfTrace('linearDngBatch', { pixels: plane.width * plane.height });
      const linear = await buildLinearPositiveAsync(plane, filmBase, { positive });
      trace.mark('build');
      const blobStart = performance.now();
      const blob = encodeLinearDngBlob(linear, { metadata: exportMetadataFor(settings, position) });
      trace.end({ bytes: blob.size, blobMs: Math.round((performance.now() - blobStart) * 10) / 10 });
      return blob;
    }

    // ===========================================
    // Contact sheet export
    // ===========================================
    const CONTACT_SHEET_FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';

    function contactSheetFileName(pageIndex, pageCount, exportInfo) {
      const roll = state.rollMetadata || {};
      const stem = (roll.rollName || roll.stock || roll.date || 'roll').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'roll';
      const page = pageCount > 1 ? `-p${pageIndex + 1}` : '';
      return `contact-sheet-${stem}${page}${exportInfo.extension}`;
    }

    // Renders the selected photos in roll order onto 300 dpi pages: header from
    // the roll metadata, frame numbers under each frame, optional sprocket
    // borders through the same renderer as the sprocket export. Frames are
    // converted through the batch path and downscaled twice the cell size
    // before drawing; TIFF when that is the export format, otherwise PNG.
    async function exportContactSheet() {
      if (isDesktopBatchExportLocked()) return;
      const selected = getSelectedFiles();
      if (!selected.length) return;
      const layoutId = normalizeLayoutId(document.getElementById('contactSheetLayout')?.value);
      const pageId = normalizePageId(document.getElementById('contactSheetPage')?.value);
      const sprockets = Boolean(document.getElementById('contactSheetSprockets')?.checked);
      const exportInfo = getExportInfo(state.exportFormat === 'tiff' ? 'tiff' : 'png', 8);
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const thumbs = [];
      const pages = [];
      await overlay.show({ title: lang.loadingExporting });
      activeLongJobs += 1;
      try {
        persistCurrentFileSettings({ silent: true, force: true });
        const probe = layoutContactSheet({ pageId, layoutId, count: selected.length });
        const cell = probe.cells[0].frame;
        const target = Math.max(cell.width, cell.height) * 2;
        for (let i = 0; i < selected.length; i++) {
          const { item, index } = selected[i];
          updateBatchOverlayProgress((i / selected.length) * 80, lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', selected.length));
          const settingsForFile = getSettingsForExport(index, item);
          const label = frameNumberFor(settingsForFile?.frameMetadata, i);
          // The frame's full-resolution planes live only until its bitmap
          // exists (#250): released then, not at the next major GC.
          const ownedPlanes = [];
          try {
            // Each full-resolution frame is one gated item (#241).
            const bitmap = await runHiddenJobItem([item.file], async () => {
              let adjusted = await processFileWithSettings(item.file, settingsForFile, { ownedPlanes });
              if (Math.max(adjusted.width, adjusted.height) > target) {
                adjusted = markOwnedPlanes(downsampleImageDataForMaxDim(adjusted, target));
                ownedPlanes.push(adjusted);
              }
              if (sprockets) {
                const options = getSprocketFrameComposeOptions(settingsForFile, i);
                await ensureSprocketFrameFonts(options);
                adjusted = markOwnedPlanes(composeSprocketFrame(adjusted, options));
                ownedPlanes.push(adjusted);
              }
              return createImageBitmap(adjusted);
            });
            thumbs.push({ image: bitmap, width: bitmap.width, height: bitmap.height, label });
          } catch (error) {
            console.warn('Contact sheet frame failed:', item.file.name, error);
            thumbs.push({ image: null, width: 1, height: 1, label });
          } finally {
            releaseOwnedPlanes(...ownedPlanes);
          }
          await yieldForJob();
        }
        batchOverlayProgress = null;
        const header = contactSheetHeader(state.rollMetadata, { fallbackTitle: getLocalizedText('contactSheetTitle', 'Contact sheet') });
        const pageCount = pagesFor(selected.length, layoutId);
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
          const sheet = layoutContactSheet({ pageId, layoutId, count: selected.length, pageIndex });
          const perPage = sheet.layout.columns * sheet.layout.rows;
          const surface = document.createElement('canvas');
          surface.width = sheet.page.width;
          surface.height = sheet.page.height;
          const ctx = surface.getContext('2d');
          renderContactSheetPage(ctx, sheet, thumbs.slice(pageIndex * perPage, (pageIndex + 1) * perPage), {
            header,
            footer: 'NeoAnalogLab Negative Converter',
            fontFamily: CONTACT_SHEET_FONT
          });
          overlay.updateProgress(80 + ((pageIndex + 1) / pageCount) * 18, lang.loadingEncoding);
          const imageData = ctx.getImageData(0, 0, surface.width, surface.height);
          const blob = await imageDataToBlob(imageData, exportInfo.format, null, 8, null, buildExportMetadata({ roll: state.rollMetadata, frame: {}, index: -1 }));
          pages.push({ blob, name: contactSheetFileName(pageIndex, pageCount, exportInfo) });
          await yieldForJob();
        }
        overlay.updateProgress(100, lang.loadingComplete);
      } finally {
        activeLongJobs -= 1;
        batchOverlayProgress = null;
        overlay.hide();
        for (const thumb of thumbs) thumb.image?.close?.();
      }
      for (const page of pages) {
        const result = await saveBlob(page.blob, page.name, exportInfo.mimeType);
        handleSaveResult(result, {
          cancelledKey: 'exportSaveCancelled',
          cancelledFallback: 'Save cancelled. No file was written.'
        });
        if (!result?.saved) break;
      }
      if (pages.length) showToast(getInterpolatedText('contactSheetDone', { pages: String(pages.length) }, `Contact sheet exported (${pages.length} page(s))`));
    }

    document.getElementById('exportContactSheetBtn')?.addEventListener('click', async () => {
      try {
        await exportContactSheet();
      } catch (error) {
        console.error('Contact sheet export failed:', error);
        void appAlert(getLocalizedText('contactSheetFailed', 'The contact sheet could not be exported.'));
      }
    });
    document.querySelector('.contact-sheet-options')?.addEventListener('click', (event) => event.stopPropagation());

    // ===========================================
    // Analog metadata panel (roll + frame)
    // ===========================================
    function updateMetadataUI() {
      if (!stateReady) return;
      for (const input of document.querySelectorAll('[data-meta-roll]')) {
        if (document.activeElement !== input) input.value = state.rollMetadata[input.dataset.metaRoll] || '';
      }
      for (const input of document.querySelectorAll('[data-meta-frame]')) {
        if (document.activeElement !== input) input.value = state.frameMetadata[input.dataset.metaFrame] || '';
      }
      const frameNumber = document.getElementById('metaFrameNumber');
      if (frameNumber) frameNumber.placeholder = frameNumberFor({}, Math.max(0, state.currentFileIndex));
    }

    // The DX read names the stock; the roll takes it while the field is empty.
    function prefillRollStockFromFilmEdge() {
      const edge = state.filmEdge;
      const name = edge?.found ? (edge.shortName || edge.filmName) : '';
      if (name && !state.rollMetadata.stock) state.rollMetadata = sanitizeRollMetadata({ ...state.rollMetadata, stock: name });
    }

    document.querySelectorAll('[data-meta-roll]').forEach((input) => {
      input.addEventListener('input', () => {
        state.rollMetadata = sanitizeRollMetadata({ ...state.rollMetadata, [input.dataset.metaRoll]: input.value });
      });
    });
    document.querySelectorAll('[data-meta-frame]').forEach((input) => {
      input.addEventListener('input', () => {
        state.frameMetadata = sanitizeFrameMetadata({ ...state.frameMetadata, [input.dataset.metaFrame]: input.value });
        markCurrentFileDirty();
      });
    });

    // ===========================================
    // Roll project file: save, open, recovery copy
    // ===========================================
    let pendingProject = null;
    let recoveredProject = null;
    let projectRecoveryTimer = null;

    async function queueItemHash(item) {
      if (item.hash === undefined) {
        try { item.hash = await hashFileForProject(item.file); } catch { item.hash = ''; }
      }
      return item.hash || '';
    }

    // Project settings come from disk: geometry that is null must stay null
    // rather than inherit the open photo's crop (see perPhotoSettingsFallback).
    function sanitizeProjectSettings(settings) {
      return cloneSettings(settings);
    }

    // The roll as a project object. Without `persist` the open photo's live
    // settings are read without touching its dirty flag (the recovery copy).
    function buildCurrentProject({ persist = false } = {}) {
      if (persist) persistCurrentFileSettings({ silent: true, force: true });
      const current = getCurrentQueueItem();
      const files = state.fileQueue.map((item) => ({
        name: item.file.name,
        size: item.file.size,
        lastModified: item.file.lastModified || 0,
        path: item.file.path || '',
        hash: item.hash || '',
        settings: item === current && state.originalImageData && !persist && !item.provisional ? extractCurrentSettings() : (item.settings || null),
        studioColors: item.studioColors || null,
        filmTypeOverride: sanitizeFilmTypeOverride(item.filmTypeOverride),
        selected: item.selected !== false
      }));
      return buildRollProject({
        files,
        rollMetadata: state.rollMetadata,
        rollReference: state.rollReference,
        rollAnalysis: state.rollAnalysis,
        lensCorrection: state.lensCorrection
      });
    }

    async function saveProject() {
      if (!state.fileQueue.length || isDesktopBatchExportLocked()) return;
      for (const item of state.fileQueue) await queueItemHash(item);
      const project = buildCurrentProject({ persist: true });
      const blob = new Blob([serializeRollProject(project)], { type: 'application/json' });
      const result = await saveBlob(blob, projectFileName(state.rollMetadata), 'application/json');
      handleSaveResult(result, {
        cancelledKey: 'exportSaveCancelled',
        cancelledFallback: 'Save cancelled. No file was written.'
      });
      if (result?.saved) showToast(getInterpolatedText('projectSaved', { count: String(project.files.length) }, `Project saved (${project.files.length} photo(s))`));
    }

    // Recovery copy: a debounced snapshot in IndexedDB so a crash does not lose the roll.
    function scheduleProjectRecovery() {
      if (projectRecoveryTimer) clearTimeout(projectRecoveryTimer);
      projectRecoveryTimer = setTimeout(() => {
        projectRecoveryTimer = null;
        if (!state.fileQueue.length) return;
        try {
          const text = serializeRollProject(buildCurrentProject());
          saveProjectRecovery(text).catch((error) => console.warn('Project recovery save failed:', error));
        } catch (error) {
          console.warn('Project recovery failed:', error);
        }
      }, 2500);
    }

    async function offerProjectRecovery() {
      try {
        const record = await loadProjectRecovery();
        if (!record || Date.now() - (record.savedAt || 0) > 14 * 24 * 3600 * 1000) return;
        const project = parseRollProject(record.text);
        if (!project.files.length) return;
        recoveredProject = project;
        state.projectRecoveryAvailable = true;
        studioWorkspace?.sync();
        showToast(getLocalizedText('projectRecoveryAvailable', 'A recovery copy of the last roll is available under Batch tools.'), 5000);
      } catch (error) {
        console.warn('Project recovery unavailable:', error);
      }
    }

    function restoreRecoveredProject() {
      if (!recoveredProject) return;
      pendingProject = recoveredProject;
      if (state.fileQueue.length) void applyPendingProject();
      else showToast(getLocalizedText('projectNeedsFiles', 'Project read. Add the original photos to restore it.'), 4000);
    }

    async function openProjectFile(file) {
      let project;
      try {
        project = parseRollProject(await file.text());
      } catch (error) {
        const newer = error?.message === 'newer-version';
        void appAlert(getLocalizedText(newer ? 'projectNewer' : 'projectOpenFailed', newer ? 'This project was saved by a newer version of the app.' : 'This is not a NeoAnalogLab project file.'));
        return;
      }
      pendingProject = project;
      if (state.fileQueue.length) await applyPendingProject();
      else showToast(getLocalizedText('projectNeedsFiles', 'Project read. Add the original photos to restore it.'), 4000);
    }

    // Matches the queued photos to the project (hash, then name and size,
    // then name), restores their settings and order plus the roll-level
    // state, reports what is missing or changed, and opens the first photo.
    async function applyPendingProject() {
      const project = pendingProject;
      if (!project || !state.fileQueue.length) return;
      pendingProject = null;
      const hashes = new Map();
      for (const item of state.fileQueue) hashes.set(item.file, await queueItemHash(item));
      const result = matchProjectFiles(project, state.fileQueue.map((item) => item.file), hashes);
      const byFile = new Map(state.fileQueue.map((item) => [item.file, item]));
      const ordered = [];
      for (const { entry, file } of [...result.matched, ...result.changed]) {
        const item = byFile.get(file);
        if (!item) continue;
        item.savedSettings = true;
        item.filmTypeOverride = sanitizeFilmTypeOverride(entry.filmTypeOverride);
        item.settings = sanitizeProjectSettings(entry.settings);
        item.studioColors = entry.studioColors && typeof entry.studioColors === 'object' ? structuredClone(entry.studioColors) : null;
        item.selected = entry.selected !== false;
        item.status = 'pending';
        item.error = null;
        item.isDirty = false;
        ordered.push({ order: entry.order, item });
      }
      ordered.sort((a, b) => a.order - b.order);
      const restored = ordered.map((o) => o.item);
      // An interrupted roll analysis resumes over its frames (#241).
      const rollFrames = interruptedRollFrames(restored);
      state.fileQueue = [...restored, ...result.extra.map((file) => byFile.get(file)).filter(Boolean)];
      state.rollMetadata = sanitizeRollMetadata(project.roll?.metadata);
      const reference = project.roll?.reference;
      if (reference && typeof reference === 'object') {
        state.rollReference = {
          ...state.rollReference,
          enabled: Boolean(reference.enabled),
          sourceFileId: reference.sourceFileId || null,
          applyLock: Boolean(reference.applyLock),
          applyCrop: Boolean(reference.applyCrop),
          settingsSnapshot: reference.settingsSnapshot ? sanitizeProjectSettings(reference.settingsSnapshot) : null
        };
      }
      const analysis = project.roll?.analysis;
      if (analysis && typeof analysis === 'object') state.rollAnalysis = { ...state.rollAnalysis, ...structuredClone(analysis) };
      if (project.lensCorrection && typeof project.lensCorrection === 'object') {
        // Keep the UI-only fields (search box state) the sanitiser strips.
        state.lensCorrection = { ...state.lensCorrection, ...sanitizeLensCorrection(project.lensCorrection, createDefaultLensCorrectionSettings()) };
      }
      state.currentFileIndex = 0;
      state.batchSessionActive = state.fileQueue.length > 1;
      updateFileListUI();
      updateExportButtons();
      updateMetadataUI();
      updateRollReferenceUI();
      updateRollAnalysisUI();
      syncBatchUIState({ reason: 'project' });
      let message = getInterpolatedText('projectOpened', { count: String(restored.length) }, `Project opened: ${restored.length} photo(s) restored`);
      if (result.changed.length) message += ' · ' + getInterpolatedText('projectChanged', { count: String(result.changed.length) }, `${result.changed.length} changed since it was saved`);
      showToast(message, 4200);
      if (result.missing.length) {
        void appAlert(getInterpolatedText('projectMissing', { names: result.missing.map((entry) => entry.name).join(', ') }, `Missing originals: ${result.missing.map((entry) => entry.name).join(', ')}`));
      }
      // switchToFile is the path that restores a queued item's saved settings.
      state.currentFileIndex = -1;
      if (state.fileQueue.length) await switchToFile(0);
      scheduleProjectRecovery();
      void offerInterruptedJobResume({ rollFrames }).catch(error => notifyExportError(error));
    }

    // ===========================================
    // Interrupted jobs: marker, boot message, resume (#241)
    // ===========================================
    // A long job keeps a small marker in localStorage while it runs. A marker
    // still there at boot means the page died mid-job: a WebKit memory kill,
    // a renderer crash, a discarded tab. The page names the job, routes to the
    // recovery copy (the originals must be added again: no queue item keeps a
    // path) and, once the roll is restored, resumes it.
    const jobMarkerStorage = {
      get: key => safeStorageGet(key),
      set: (key, value) => { localStorage.setItem(key, value); },
      remove: key => { localStorage.removeItem(key); }
    };
    // Markers found at boot, until their job is resumed or dismissed.
    let interruptedJobs = [];

    function beginExportJobMarker(kind, jobs, { destination = '', exportInfo = null, dustRemoval = null, attempt = 0 } = {}) {
      const marker = createJobMarker(jobMarkerStorage);
      marker.begin({
        kind, destination, exportInfo, attempt,
        options: { jpegQuality: state.jpegQuality, sprocket: Boolean(state.exportSprocketHolesEnabled), dustRemoval },
        // `auto`: the frame's recipe came from automatic analysis, so its
        // export bakes the automatic gray point (processFileWithSettings).
        files: jobs.map(job => ({ name: job.file.name, size: job.file.size, lastModified: job.file.lastModified || 0,
          output: job.outputName, auto: Boolean(job.item.automaticSettings) }))
      });
      return marker;
    }

    function describeInterruptedJob(marker) {
      const values = { total: String(marker.files.length), done: String(marker.written.length) };
      if (marker.kind === 'export-folder') {
        const folder = summarizePathForUi(marker.destination) || marker.destination;
        return getInterpolatedText('interruptedExportFolder', { ...values, folder }, `Export of ${values.total} photos to ${folder} stopped after ${values.done}.`);
      }
      if (marker.kind === 'export-zip') return getInterpolatedText('interruptedExportZip', values, `ZIP export of ${values.total} photos stopped after ${values.done}. A partial ZIP cannot be resumed.`);
      if (marker.kind === 'roll-analysis') return getInterpolatedText('interruptedRollAnalysis', values, `Roll analysis of ${values.total} photos stopped after ${values.done}.`);
      return getInterpolatedText('interruptedExportDownloads', values, `Export of ${values.total} photos stopped after ${values.done}.`);
    }

    // Once at boot: name the jobs that stopped, and say when macOS stopped
    // the app's web process (the Rust hook recorded it before reloading).
    async function checkInterruptedJobs() {
      const markers = readJobMarkers(jobMarkerStorage);
      let termination = null;
      if (isTauriDesktop()) {
        try { termination = await window.__TAURI__.core.invoke('take_web_content_termination'); } catch { termination = null; }
      }
      const webProcess = getLocalizedText('interruptedWebProcess', "macOS stopped the app's web process.");
      if (!markers.length) {
        if (termination) showToast(webProcess, 6000);
        return;
      }
      interruptedJobs = markers;
      const parts = markers.map(describeInterruptedJob);
      if (termination) parts.push(webProcess);
      if (markers.some(jobNeedsSafeMode)) {
        parts.push(getLocalizedText('interruptedJobSafeMode', 'It stopped again after resuming, so the next attempt runs one photo at a time with the photo caches off.'));
      }
      parts.push(getLocalizedText('interruptedJobNext', 'Add the original photos again, then restore the roll under Batch tools to continue.'));
      void appAlert(parts.join(' '));
    }

    // Frames of an interrupted roll analysis go back to automatic analysis
    // unless the user had edited them: those keep their saved recipe.
    function interruptedRollFrames(restored) {
      const marker = interruptedJobs.find(entry => entry.kind === 'roll-analysis');
      if (!marker) return [];
      const edited = new Set(marker.edited);
      const frames = [];
      matchJobFiles(marker, restored).forEach((item, index) => {
        if (!item || edited.has(index)) return;
        item.savedSettings = false;
        if (item.settings) item.automaticSettings = true;
        frames.push(item);
      });
      return frames;
    }

    // A job that already stopped again after a resume runs with the hidden
    // limits on even while visible: one lane, caches off.
    async function runResumedJob(marker, run) {
      const safe = jobNeedsSafeMode(marker);
      if (safe) {
        photoSessions.clear();
        photoPreviews.clear();
        hiddenJobs.setSafeMode(true);
      }
      try {
        return await run();
      } finally {
        if (safe) hiddenJobs.setSafeMode(false);
      }
    }

    async function offerInterruptedJobResume({ rollFrames = [] } = {}) {
      for (const marker of [...interruptedJobs]) {
        const matched = matchJobFiles(marker, state.fileQueue);
        if (!matched.some(Boolean)) continue;
        interruptedJobs = interruptedJobs.filter(entry => entry !== marker);
        if (marker.kind === 'roll-analysis') {
          if (!rollFrames.length) { clearJobMarker(jobMarkerStorage, marker); continue; }
          showToast(getInterpolatedText('resumeRollAnalysis', { count: String(rollFrames.length) }, `Resuming the roll analysis of ${rollFrames.length} photos.`), 4000);
          // The resumed analysis writes its own marker, one attempt later;
          // an analysis the re-import scheduled for the same frames stops.
          automaticRollRevision++;
          scheduleAutomaticRollImport(rollFrames, { prepared: true, resumeAttempt: marker.attempt + 1, safeMode: jobNeedsSafeMode(marker) });
          continue;
        }
        if (isDesktopBatchExportLocked() || singleExportActive) continue;
        const missing = matched.filter(item => !item).length;
        const missingNote = missing ? ' ' + getInterpolatedText('resumeExportMissing', { count: String(missing) }, `${missing} of its originals are missing and are left out.`) : '';
        if (marker.kind === 'export-zip') {
          const question = getInterpolatedText('resumeZipConfirm', { total: String(marker.files.length) }, `The ZIP export of ${marker.files.length} photos was interrupted and cannot be resumed. Export the ZIP again?`);
          if (!await appConfirm(question + missingNote)) { clearJobMarker(jobMarkerStorage, marker); continue; }
          clearJobMarker(jobMarkerStorage, marker);
          const selected = matched.filter(Boolean).map(item => ({ item, index: state.fileQueue.indexOf(item) }));
          restoreInterruptedExportOptions(marker);
          await runResumedJob(marker, () => exportBatchAsZipBrowser(selected, marker.destination || 'converted_negatives.zip', { markerAttempt: marker.attempt + 1 }));
          continue;
        }
        await resumeInterruptedExport(marker, { missingNote });
      }
    }

    // The export options the interrupted job used; they are not persisted.
    function restoreInterruptedExportOptions(marker) {
      const quality = Number(marker.options?.jpegQuality);
      if (Number.isFinite(quality) && quality >= 1 && quality <= 100) {
        state.jpegQuality = quality;
        const slider = document.getElementById('exportQualitySlider');
        if (slider) slider.value = String(quality);
        const value = document.getElementById('exportQualityValue');
        if (value) value.textContent = quality + '%';
      }
      if (typeof marker.options?.sprocket === 'boolean') setExportSprocketMode(marker.options.sprocket);
    }

    // Per-file exports: the full original job list (same order, names and
    // positions), minus the frames recorded as written whose file exists.
    async function resumeInterruptedExport(marker, { missingNote = '' } = {}) {
      const desktop = marker.kind === 'export-folder';
      if (desktop && !isTauriDesktop()) { clearJobMarker(jobMarkerStorage, marker); return; }
      let targetDirectory = desktop ? marker.destination : '';
      let exists = null;
      if (desktop) {
        const check = async (directory) => {
          const answers = await window.__TAURI__.core.invoke('exported_files_exist', { directory, paths: marker.written.map(([, path]) => path) });
          const present = new Set(marker.written.filter((_, i) => answers[i] === true).map(([index]) => index));
          return async (index) => present.has(index);
        };
        try {
          exists = await check(targetDirectory);
        } catch {
          // A full app restart drops the folder grant: the folder is picked again.
          showToast(getLocalizedText('resumeExportFolderAgain', 'Choose the export folder again to resume.'), 4000);
          targetDirectory = await pickDesktopExportDirectory();
          if (!targetDirectory) { clearJobMarker(jobMarkerStorage, marker); return; }
          try { exists = await check(targetDirectory); } catch { exists = async () => false; }
        }
      }
      const plan = await planResumedExport(marker, state.fileQueue, { exists });
      if (!plan.jobs.length) { clearJobMarker(jobMarkerStorage, marker); return; }
      const folder = summarizePathForUi(targetDirectory) || targetDirectory;
      const question = desktop
        ? getInterpolatedText('resumeExportConfirm', { total: String(marker.files.length), folder, skipped: String(plan.skipped.length) }, `Resume the export of ${marker.files.length} photos to ${folder}? ${plan.skipped.length} already written are skipped, and the rest keep their names.`)
        : getInterpolatedText('resumeExportDownloadsConfirm', { total: String(marker.files.length), skipped: String(plan.skipped.length) }, `Resume the export of ${marker.files.length} photos? ${plan.skipped.length} already downloaded are skipped.`);
      if (!await appConfirm(question + missingNote)) { clearJobMarker(jobMarkerStorage, marker); return; }
      restoreInterruptedExportOptions(marker);
      const exportInfo = marker.exportInfo || getExportInfo();
      const jobs = plan.jobs.map(({ markerIndex, item, outputName }) => {
        const index = state.fileQueue.indexOf(item);
        // The recovery copy keeps recipes, not how they were made: an
        // automatic recipe exports with the automatic gray point, as before.
        if (marker.files[markerIndex].auto) item.automaticSettings = true;
        const settings = getSettingsForExport(index, item);
        return {
          item, index, markerIndex, file: item.file,
          outputName: outputName || buildActiveExportFileName(item.file.name, exportInfo, settings),
          settings: cloneSettings(settings)
        };
      });
      // The resumed run keeps the records of what it skips, one attempt later.
      const resumed = createJobMarker(jobMarkerStorage);
      resumed.begin({ ...resumedJobMarker(marker, { keep: plan.skipped }), destination: desktop ? targetDirectory : marker.destination });
      const dustRemoval = marker.options?.dustRemoval || null;
      await runResumedJob(marker, () => (desktop
        ? runDesktopFolderExport(jobs, { targetDirectory, exportInfo, dustRemoval, marker: resumed })
        : runBrowserDownloadsExport(jobs, { exportInfo, marker: resumed })));
    }

    document.getElementById('projectInput')?.addEventListener('change', (e) => {
      if (isDesktopBatchExportLocked()) return;
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      const projectFile = files.find((file) => isProjectFileName(file.name));
      void stopHotFolder();
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.mirrored = false;
      updateMirrorButtonState();
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'projectInput_change_reset' });
      addFilesToQueue(files);
      if (projectFile) {
        void openProjectFile(projectFile);
      } else if (pendingProject) {
        void applyPendingProject();
      } else if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    // ===========================================
    // Shareable recipes: code, QR, paste, scan
    // ===========================================
    let decodedRecipe = null;

    function recipeTags() {
      return { stock: state.rollMetadata.stock, lab: state.rollMetadata.lab, note: document.getElementById('recipeNote')?.value || '' };
    }

    // The film type always travels; every other key only when it differs
    // from this photo's automatic defaults, which keeps the code short.
    // The defaults are measured on the whole working frame; beside a crop
    // that frame is built in the pool for this (#244).
    async function currentRecipeCode() {
      let defaults = null;
      const frame = state.originalImageData ? await geometryFramePixels() : null;
      if (frame) {
        const { filmType, positiveMode, ...rest } = createDefaultSettings(frame);
        defaults = rest;
      }
      return encodeRecipe(extractCurrentSettings(), recipeTags(), { defaults });
    }

    async function copyRecipe() {
      if (state.currentStep < 3 || !state.processedImageData) {
        void appAlert(getLocalizedText('recipeNeedPhoto', 'Convert a photo first.'));
        return;
      }
      const code = await currentRecipeCode();
      const box = document.getElementById('recipeCode');
      if (box) box.value = code;
      try {
        await navigator.clipboard.writeText(code);
        showToast(getInterpolatedText('recipeCopied', { chars: String(code.length) }, `Recipe copied (${code.length} characters)`));
      } catch {
        showToast(getLocalizedText('recipeShown', 'Recipe code shown below; copy it from the box.'));
      }
      const canvas = document.getElementById('recipeQrCanvas');
      if (canvas && !canvas.hidden) drawRecipeQr(code);
    }

    function drawRecipeQr(code) {
      const canvas = document.getElementById('recipeQrCanvas');
      if (!canvas || !code) return;
      const qr = qrcode(0, 'M');
      qr.addData(code, 'Byte');
      qr.make();
      const modules = qr.getModuleCount();
      const scale = 4;
      const quiet = 4;
      canvas.width = canvas.height = (modules + quiet * 2) * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      for (let row = 0; row < modules; row++) {
        for (let col = 0; col < modules; col++) {
          if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
        }
      }
      canvas.hidden = false;
    }

    async function toggleRecipeQr() {
      const canvas = document.getElementById('recipeQrCanvas');
      if (!canvas) return;
      if (!canvas.hidden) { canvas.hidden = true; return; }
      const box = document.getElementById('recipeCode');
      let code = box?.value.trim() || '';
      if (!code && state.currentStep >= 3 && state.processedImageData) {
        code = await currentRecipeCode();
        if (box) box.value = code;
      }
      if (code) drawRecipeQr(code);
    }

    function readRecipeFromBox() {
      const text = document.getElementById('recipeCode')?.value || '';
      try {
        decodedRecipe = decodeRecipe(text);
      } catch (error) {
        decodedRecipe = null;
        const key = error?.reason === 'version' ? 'recipeNewer' : error?.reason === 'corrupt' ? 'recipeCorrupt' : 'recipeInvalid';
        showToast(getLocalizedText(key, 'That is not a recipe code.'), 3500);
      }
      updateRecipeUI();
    }

    function updateRecipeUI() {
      if (!stateReady) return;
      const list = document.getElementById('recipeDiff');
      const status = document.getElementById('recipeStatus');
      const applyBtn = document.getElementById('recipeApplyBtn');
      const applySelectedBtn = document.getElementById('recipeApplySelectedBtn');
      const scanBtn = document.getElementById('recipeScanBtn');
      const box = document.getElementById('recipeCode');
      if (!list || !status) return;
      if (box) box.placeholder = getLocalizedText('recipePlaceholder', 'Paste a recipe code here');
      if (scanBtn) scanBtn.hidden = !(typeof BarcodeDetector === 'function' && navigator.mediaDevices?.getUserMedia);
      const ready = state.currentStep >= 3 && Boolean(state.processedImageData);
      if (!decodedRecipe) {
        list.replaceChildren();
        status.textContent = getLocalizedText('recipeStatusNone', 'No recipe read yet.');
        if (applyBtn) applyBtn.disabled = true;
        if (applySelectedBtn) applySelectedBtn.disabled = true;
        return;
      }
      const diff = recipeDiff(state, decodedRecipe.settings);
      list.replaceChildren(...diff.map((change) => {
        const li = document.createElement('li');
        li.textContent = describeRecipeChange(change);
        return li;
      }));
      const tags = Object.entries(decodedRecipe.tags).map(([key, value]) => `${key}: ${value}`).join(' · ');
      status.textContent = getInterpolatedText('recipeStatusRead', { count: String(diff.length), tags: tags ? ` · ${tags}` : '' }, `Recipe read: ${diff.length} change(s)${tags ? ` · ${tags}` : ''}`);
      if (applyBtn) applyBtn.disabled = !ready || !diff.length;
      if (applySelectedBtn) applySelectedBtn.disabled = !state.fileQueue.some((item) => item.selected && item.file !== state.loadedFile);
    }

    // Recipe settings sanitised against the current photo, keyed by recipe key.
    function recipePatch() {
      const next = decodedRecipe?.settings || {};
      const safe = sanitizeSettings({ ...extractCurrentSettings(), ...next }, { fallbackSettings: state });
      const patch = {};
      for (const key of RECIPE_KEYS) if (Object.hasOwn(next, key) && safe[key] !== undefined) patch[key] = structuredClone(safe[key]);
      return patch;
    }

    function applyRecipeToCurrent() {
      if (!decodedRecipe || state.currentStep < 3 || !state.processedImageData) return;
      const patch = recipePatch();
      if (!Object.keys(patch).length) return;
      pushUndo('recipe');
      const filmTypeChanged = Object.hasOwn(patch, 'filmType') && patch.filmType !== state.filmType;
      if (filmTypeChanged) {
        state.filmType = patch.filmType;
        setFilmTypeButtons(state.filmType);
        if (requiresFilmBase()) setStep2Mode(suggestStep2Mode());
        else updateFilmModeUI();
      }
      for (const [key, value] of Object.entries(patch)) if (key !== 'filmType') state[key] = value;
      if (Object.hasOwn(patch, 'filmType')) state.filmTypeSource = 'manual';
      updateFilmModeUI();
      if (patch.curvePoints) ['r', 'g', 'b'].forEach((ch) => updateCurveFromPoints(ch));
      state.frontierGuideStep2ChoiceTouched = true;
      updateSlidersFromState();
      renderCurve();
      updateEnlargerUI();
      updateLabMatchUI();
      updateExpiredRescueUI();
      markCurrentFileDirty();
      if (filmTypeChanged || usesSilverCoreConversion(state)) scheduleSilverSourceRefresh();
      else schedulePreviewUpdate();
      showToast(getLocalizedText('recipeApplied', 'Recipe applied.'));
      updateRecipeUI();
    }

    function applyRecipeToSelected() {
      if (!decodedRecipe) return;
      const patch = recipePatch();
      const targets = state.fileQueue.filter((item) => item.selected && item.file !== state.loadedFile);
      for (const item of targets) {
        if (item.settings) item.settings = { ...item.settings, ...structuredClone(patch) };
        else item.studioColors = { ...(item.studioColors || {}), ...structuredClone(patch) };
        item.isDirty = false;
        item.status = 'pending';
      }
      updateFileListUI();
      showToast(getInterpolatedText('recipeAppliedSelected', { count: String(targets.length) }, `Recipe applied to ${targets.length} photo(s)`));
      scheduleProjectRecovery();
    }

    let recipeImageReading = false;
    async function importRecipeQrImage(file) {
      if (!file || recipeImageReading) return;
      recipeImageReading = true;
      decodedRecipe = null;
      const recipeBox = document.getElementById('recipeCode');
      if (recipeBox) recipeBox.value = '';
      updateRecipeUI();
      const button = document.getElementById('recipeUploadBtn');
      if (button) button.disabled = true;
      showToast(getLocalizedText('recipeImageReading', 'Reading QR image…'));
      try {
        const { readRecipeQrImage } = await import('./recipeQrImage.js');
        const code = await readRecipeQrImage(file);
        if (!code) {
          showToast(getLocalizedText('recipeScanNone', 'No recipe QR found.'), 3500);
          return;
        }
        const box = document.getElementById('recipeCode');
        if (box) box.value = code;
        readRecipeFromBox();
      } catch (error) {
        const key = error?.message === 'size' ? 'recipeImageSize' : 'recipeImageError';
        showToast(getLocalizedText(key, 'Could not read this image. Please choose another image.'), 3500);
      } finally {
        recipeImageReading = false;
        if (button) button.disabled = false;
      }
    }

    async function scanRecipeQr() {
      if (typeof BarcodeDetector !== 'function' || !navigator.mediaDevices?.getUserMedia) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (error) {
        console.warn('Recipe scan camera failed:', error);
        showToast(getLocalizedText('loupeNoCamera', 'No camera available.'));
        return;
      }
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      try { await video.play(); } catch {}
      showToast(getLocalizedText('recipeScanning', 'Point the camera at the recipe QR…'), 3000);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const started = Date.now();
      let found = '';
      while (!found && Date.now() - started < 20000) {
        try {
          const codes = await detector.detect(video);
          found = codes.map((code) => code.rawValue).find((value) => /NC\d+\./.test(value || '')) || '';
        } catch {}
        if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      for (const track of stream.getTracks()) track.stop();
      if (found) {
        const box = document.getElementById('recipeCode');
        if (box) box.value = found;
        readRecipeFromBox();
      } else {
        showToast(getLocalizedText('recipeScanNone', 'No recipe QR found.'));
      }
    }

    document.getElementById('recipeCopyBtn')?.addEventListener('click', () => { void copyRecipe(); });
    document.getElementById('recipeQrBtn')?.addEventListener('click', toggleRecipeQr);
    document.getElementById('recipeUploadBtn')?.addEventListener('click', () => document.getElementById('recipeQrInput')?.click());
    document.getElementById('recipeQrInput')?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      void importRecipeQrImage(file);
    });
    document.getElementById('recipeScanBtn')?.addEventListener('click', () => { void scanRecipeQr(); });
    document.getElementById('recipeDecodeBtn')?.addEventListener('click', readRecipeFromBox);
    document.getElementById('recipeApplyBtn')?.addEventListener('click', applyRecipeToCurrent);
    document.getElementById('recipeApplySelectedBtn')?.addEventListener('click', applyRecipeToSelected);
    document.getElementById('recipeCode')?.addEventListener('input', () => { decodedRecipe = null; updateRecipeUI(); });

    // ===========================================
    // Multi-shot merge (camera scanning)
    // ===========================================
    const MULTI_SHOT_MAX = 5;

    // Renderer-wide memory budget for a merge's worker, in bytes. #258 supplies
    // it; until then every selection is attempted and an allocation failure
    // is reported when it happens.
    function multiShotBudgetBytes() {
      return Infinity;
    }

    function setBatchProgressCancel(onCancel) {
      const button = document.getElementById('batchProgressCancel');
      if (!button) return;
      button.hidden = !onCancel;
      button.onclick = onCancel ? () => onCancel() : null;
    }

    function showMultiShotProgress(view, names) {
      document.getElementById('batchProgressFill').style.width = `${Math.round(view.fraction * 100)}%`;
      if (view.key) document.getElementById('batchProgressText').textContent = getInterpolatedText(view.key, view.params, view.fallback);
      document.getElementById('batchProgressCurrent').textContent = Number.isInteger(view.index) ? names[view.index] || '' : '';
    }

    // Aligns the selected shots to the first one, merges them in linear light
    // and adds the result to the queue as a 16-bit PNG, opened and selected in
    // place of its sources. Alignment, warps, merge and encoding run in a
    // disposable worker (multiShotWorkerClient.js); the page only decodes.
    async function mergeSelectedShots(mode = 'average') {
      if (document.body.dataset.studioBusy || state.cropping || isDesktopBatchExportLocked()) return;
      const selectedItems = state.fileQueue.filter((item) => item.selected);
      if (selectedItems.length < 2 || selectedItems.length > MULTI_SHOT_MAX) return;
      const memoryText = () => getLocalizedText('multiShotMemory', 'These shots are too large to merge with the memory available. Merge fewer shots or close other apps.');
      studioAutoFrameRunning = true;
      document.body.dataset.studioBusy = 'true';
      studioWorkspace?.sync();
      let uiOpen = true;
      const closeUi = () => {
        if (!uiOpen) return;
        uiOpen = false;
        setBatchProgressCancel(null);
        showBatchProgress(false);
        studioAutoFrameRunning = false;
        delete document.body.dataset.studioBusy;
        studioWorkspace?.sync();
      };
      // The worker holds every frame at 16 bits plus its OpenCV heap: refuse a
      // selection the budget cannot hold before anything is decoded.
      const budgetBytes = multiShotBudgetBytes();
      if (Number.isFinite(budgetBytes)) {
        const pixels = await Promise.all(selectedItems.map((item) => imagePixelsForBatch(item.file)));
        if (!multiShotFitsBudget(pixels, budgetBytes)) {
          closeUi();
          void appAlert(memoryText());
          return;
        }
      }
      const names = selectedItems.map((item) => item.file.name);
      const progress = createMultiShotProgress(selectedItems.length);
      const job = createMultiShotMergeJob({
        mode,
        onProgress: (event) => { if (uiOpen) showMultiShotProgress(progress.update(event), names); },
        // Used only when the module worker cannot start: the same pipeline on
        // this thread with the page's OpenCV, yielding between merge bands.
        createInlineProcessor: async ({ post, signal }) => {
          if (!(await ensureOpenCvReady())) return null;
          const { createMultiShotWorkerProcessor } = await import('../workers/multiShotWorkerProcessor.js');
          return createMultiShotWorkerProcessor({ post, signal, pause: () => new Promise((resolve) => setTimeout(resolve, 0)) });
        }
      });
      // Cancel ends the merge at once: the worker is terminated and the UI is
      // released; a decode still running finishes unobserved and is dropped.
      setBatchProgressCancel(() => { job.cancel(); closeUi(); });
      showBatchProgress(true);
      let result = null; let decodeSkipped = 0; let failure = null;
      try {
        persistCurrentFileSettings({ silent: true, force: true });
        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
          if (uiOpen) showMultiShotProgress(progress.update({ stage: 'decode', index: i }), names);
          const decoded = await Promise.race([
            loadFileToImageData(item.file).then((imageData) => ({ imageData }), (error) => ({ error })),
            job.failed
          ]);
          if (decoded.error) {
            console.warn('Multi-shot decode failed for', item.file.name, decoded.error);
            decodeSkipped++;
            continue;
          }
          let imageData = decoded.imageData;
          decoded.imageData = null;
          await job.addFrame(i, imageData);
          imageData = null;
        }
        if (job.framesPosted >= 2) result = await job.merge();
      } catch (error) {
        failure = error;
      } finally {
        job.dispose();
        closeUi();
      }
      if (failure) {
        const { code, message } = failure instanceof MultiShotError ? failure : describeMultiShotError(failure);
        if (code === 'cancelled') return;
        if (code === 'memory') {
          console.warn('Multi-shot merge ran out of memory:', message);
          void appAlert(memoryText());
        } else if (code === 'opencv') {
          void appAlert(getLocalizedText('multiShotOpenCv', 'Alignment needs OpenCV, which could not be loaded.'));
        } else {
          console.error('Multi-shot merge failed:', failure);
          void appAlert(getLocalizedText('multiShotFailed', 'The selected shots could not be aligned, so nothing was merged.'));
        }
        return;
      }
      if (!result?.blob) {
        void appAlert(getLocalizedText('multiShotFailed', 'The selected shots could not be aligned, so nothing was merged.'));
        return;
      }
      // The worker encoded exactly what the 16-bit PNG export writes; the page
      // adds the sRGB iCCP chunk, as imageDataToBlob does.
      const blob = await attachMetadataToBlob(result.blob, 'png', null);
      const used = result.used;
      const skipped = decodeSkipped + result.skipped;
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
      const name = `merged-${mode}-${stamp}.png`;
      const file = new File([blob], name, { type: 'image/png', lastModified: Date.now() });
      for (const item of selectedItems) item.selected = false;
      addFilesToQueue([file]);
      let message = getInterpolatedText('multiShotDone', { count: String(used), name }, `Merged ${used} shots into ${name}`);
      if (skipped) message += ' · ' + getInterpolatedText('multiShotSkipped', { count: String(skipped) }, `${skipped} shot(s) could not be aligned and were skipped`);
      showToast(message, 3600);
      const index = state.fileQueue.findIndex((item) => item.file === file);
      if (index >= 0) await switchToFile(index);
    }

    // ===========================================
    // Live loupe (camera scanning)
    // ===========================================
    const LOUPE_PREVIEW_SIDE = 640;
    const liveLoupe = { stream: null, track: null, running: false, capturing: false, frames: 0, view: 'converted', surface: null, generation: 0 };

    function loupeElement(id) {
      return document.getElementById(id);
    }

    function loupeSupported() {
      return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    }

    function setLoupeStatus(text) {
      const status = loupeElement('loupeStatus');
      if (status) status.textContent = text;
    }

    function stopLoupeStream() {
      liveLoupe.generation++;
      liveLoupe.running = false;
      if (liveLoupe.stream) for (const track of liveLoupe.stream.getTracks()) track.stop();
      liveLoupe.stream = null;
      liveLoupe.track = null;
      const video = loupeElement('loupeVideo');
      if (video) video.srcObject = null;
      const capture = loupeElement('loupeCaptureBtn');
      if (capture) capture.disabled = true;
    }

    // The conversion the loupe looks through: the current photo's recipe when
    // one is converted (film base, preset, colour controls and look, without
    // its geometry, strokes, flat field or roll lock), otherwise the automatic
    // defaults for the camera frame itself.
    function loupeRecipe(frame) {
      if (state.currentStep >= 3 && state.originalImageData) {
        return {
          settings: { ...state, cropRegion: null, rotationAngle: 0, mirrored: false, autoFrameMeta: null, localExposure: null, flatFieldId: null, rollFrame: null, filmEdge: null },
          name: state.loadedFile?.name || ''
        };
      }
      return { settings: createDefaultSettings(frame), name: getLocalizedText('loupeRecipeAuto', 'automatic') };
    }

    function grabLoupeFrame(video, maxSide) {
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (!liveLoupe.surface) liveLoupe.surface = document.createElement('canvas');
      const surface = liveLoupe.surface;
      if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
      }
      const ctx = surface.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    }

    async function convertLoupeFrame(frame) {
      const recipe = loupeRecipe(frame);
      const converted = await convertFrameWithRouter({
        imageData: frame,
        settings: buildRouterSettings(recipe.settings, frame),
        options: { preview: true, scratch: true, includeAnalysisPreview: false }
      });
      if (!converted) return null;
      const output = new ImageData(converted.width, converted.height);
      applyAdjustmentsToBuffer(converted, recipe.settings, output, 'preview');
      return { imageData: output, recipe: recipe.name };
    }

    async function loupeLoop() {
      const video = loupeElement('loupeVideo');
      const canvas = loupeElement('liveLoupeCanvas');
      const overlay = loupeElement('loupeOverlay');
      const stream = liveLoupe.stream;
      while (liveLoupe.running && liveLoupe.stream === stream) {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const frame = grabLoupeFrame(video, LOUPE_PREVIEW_SIDE);
            const result = await convertLoupeFrame(frame);
            if (!liveLoupe.running || liveLoupe.stream !== stream) break;
            if (result) {
              if (canvas.width !== result.imageData.width || canvas.height !== result.imageData.height) {
                canvas.width = result.imageData.width;
                canvas.height = result.imageData.height;
              }
              canvas.getContext('2d').putImageData(result.imageData, 0, 0);
              liveLoupe.frames++;
              overlay.dataset.frames = String(liveLoupe.frames);
              if (liveLoupe.frames === 1 || liveLoupe.frames % 15 === 0) {
                setLoupeStatus(getInterpolatedText('loupeLive', {
                  width: String(video.videoWidth),
                  height: String(video.videoHeight),
                  recipe: result.recipe
                }, `Live · ${video.videoWidth}×${video.videoHeight} · recipe: ${result.recipe}`));
              }
            }
          } catch (error) {
            console.warn('Loupe frame failed:', error);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    async function populateLoupeCameras() {
      const select = loupeElement('loupeCameraSelect');
      if (!select || !navigator.mediaDevices?.enumerateDevices) return;
      let devices = [];
      try {
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
      } catch (error) {
        console.warn('Loupe camera list failed:', error);
      }
      const current = liveLoupe.track?.getSettings?.().deviceId || '';
      select.replaceChildren(...devices.map((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || getInterpolatedText('loupeCameraLabel', { index: String(index + 1) }, `Camera ${index + 1}`);
        option.selected = device.deviceId === current;
        return option;
      }));
      select.disabled = devices.length < 2;
    }

    function configureLoupeTrackControls() {
      const zoom = loupeElement('loupeZoom');
      const torch = loupeElement('loupeTorch');
      let caps = {};
      let current = {};
      try { caps = liveLoupe.track?.getCapabilities?.() || {}; } catch { caps = {}; }
      try { current = liveLoupe.track?.getSettings?.() || {}; } catch { current = {}; }
      if (zoom) {
        const range = caps.zoom;
        const ok = Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min);
        zoom.disabled = !ok;
        if (ok) {
          zoom.min = String(range.min);
          zoom.max = String(range.max);
          zoom.step = String(range.step || 0.1);
          zoom.value = String(current.zoom ?? range.min);
        }
      }
      if (torch) {
        const ok = Array.isArray(caps.torch) ? caps.torch.includes(true) : Boolean(caps.torch);
        torch.disabled = !ok;
        torch.checked = Boolean(current.torch);
      }
    }

    async function applyLoupeConstraint(constraint) {
      if (!liveLoupe.track) return;
      try {
        await liveLoupe.track.applyConstraints({ advanced: [constraint] });
      } catch (error) {
        console.warn('Loupe constraint failed:', error);
      }
    }

    async function openLoupe(deviceId = null) {
      const overlay = loupeElement('loupeOverlay');
      if (!overlay) return;
      if (!loupeSupported()) {
        void appAlert(getLocalizedText('loupeUnsupported', 'This browser cannot open a camera.'));
        return;
      }
      stopLoupeStream();
      const generation = liveLoupe.generation;
      const isCurrent = () => liveLoupe.generation === generation && !overlay.hidden;
      overlay.hidden = false;
      overlay.dataset.view = liveLoupe.view;
      overlay.dataset.frames = '0';
      liveLoupe.frames = 0;
      setLoupeStatus(getLocalizedText('loupeStarting', 'Starting camera…'));
      const video = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (!isCurrent()) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        liveLoupe.stream = stream;
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('Loupe camera failed:', error);
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        setLoupeStatus(getLocalizedText(denied ? 'loupeDenied' : 'loupeNoCamera', denied ? 'Camera access was denied.' : 'No camera available.'));
        return;
      }
      const videoEl = loupeElement('loupeVideo');
      videoEl.srcObject = liveLoupe.stream;
      liveLoupe.track = liveLoupe.stream.getVideoTracks()[0] || null;
      try {
        await videoEl.play();
      } catch (error) {
        console.warn('Loupe video play failed:', error);
      }
      if (!isCurrent()) return;
      await populateLoupeCameras();
      if (!isCurrent()) return;
      configureLoupeTrackControls();
      liveLoupe.running = true;
      loupeElement('loupeCaptureBtn').disabled = false;
      loupeElement('loupeCloseBtn')?.focus();
      void loupeLoop();
    }

    function closeLoupe() {
      const overlay = loupeElement('loupeOverlay');
      if (!overlay || overlay.hidden) return;
      stopLoupeStream();
      overlay.hidden = true;
      document.getElementById('studioLoupe')?.focus();
      // Captures made before any photo was open behave like added files.
      if (!state.originalImageData && state.fileQueue.length > 0) {
        void loadFile(state.fileQueue[Math.max(0, Math.min(state.currentFileIndex, state.fileQueue.length - 1))].file);
      }
    }

    async function captureLoupeFrame() {
      if (!liveLoupe.running || liveLoupe.capturing) return;
      const video = loupeElement('loupeVideo');
      if (!(video.videoWidth > 0)) return;
      liveLoupe.capturing = true;
      const button = loupeElement('loupeCaptureBtn');
      button.disabled = true;
      try {
        let blob = null;
        // ImageCapture returns the sensor's still resolution where supported;
        // otherwise the current video frame at stream resolution.
        if (typeof ImageCapture === 'function' && liveLoupe.track) {
          try {
            blob = await new ImageCapture(liveLoupe.track).takePhoto();
          } catch (error) {
            blob = null;
          }
        }
        if (!blob) {
          const surface = document.createElement('canvas');
          surface.width = video.videoWidth;
          surface.height = video.videoHeight;
          surface.getContext('2d').drawImage(video, 0, 0);
          blob = await new Promise((resolve) => surface.toBlob(resolve, 'image/png'));
        }
        if (!blob) throw new Error('Capture produced no image');
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const file = new File([blob], `loupe-${stamp}.${extension}`, { type: blob.type || 'image/png', lastModified: Date.now() });
        addFilesToQueue([file]);
        showToast(getInterpolatedText('loupeCaptured', { name: file.name }, `Captured ${file.name}`));
      } catch (error) {
        console.warn('Loupe capture failed:', error);
        void appAlert(getLocalizedText('loupeCaptureFailed', 'The capture failed.'));
      } finally {
        liveLoupe.capturing = false;
        button.disabled = !liveLoupe.running;
      }
    }

    loupeElement('loupeCloseBtn')?.addEventListener('click', closeLoupe);
    loupeElement('loupeCaptureBtn')?.addEventListener('click', () => { void captureLoupeFrame(); });
    loupeElement('loupeCameraSelect')?.addEventListener('change', (event) => { void openLoupe(event.target.value || null); });
    loupeElement('loupeZoom')?.addEventListener('input', (event) => { void applyLoupeConstraint({ zoom: Number(event.target.value) }); });
    loupeElement('loupeTorch')?.addEventListener('change', (event) => { void applyLoupeConstraint({ torch: event.target.checked }); });
    loupeElement('loupeRaw')?.addEventListener('change', (event) => {
      liveLoupe.view = event.target.checked ? 'raw' : 'converted';
      const overlay = loupeElement('loupeOverlay');
      if (overlay) overlay.dataset.view = liveLoupe.view;
    });
    loupeElement('loupeOverlay')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLoupe();
      }
    });
    window.addEventListener('pagehide', stopLoupeStream);

    // ===========================================
    // Flat field: blank light-source frame -> gain map for the roll
    // ===========================================
    function resetFlatFieldState() {
      state.flatFields = {};
      state.flatFieldActiveId = null;
      state.flatFieldId = null;
      if (stateReady) updateFlatFieldUI();
    }

    function flatFieldUsageCount(id) {
      return state.fileQueue.filter((item) => (item.file === state.loadedFile ? state.flatFieldId : item.settings?.flatFieldId) === id).length;
    }

    function updateFlatFieldUI() {
      if (!stateReady) return;
      const status = document.getElementById('flatFieldStatus');
      const enabled = document.getElementById('flatFieldEnabled');
      if (!status || !enabled) return;
      const active = state.flatFieldActiveId ? state.flatFields[state.flatFieldActiveId] : null;
      status.textContent = active
        ? getInterpolatedText('flatFieldStatusActive', {
          source: active.source || active.id,
          falloff: String(Math.round((active.stats?.cornerFalloff || 0) * 100)),
          count: String(flatFieldUsageCount(active.id))
        }, `From ${active.source}`)
        : getLocalizedText('flatFieldStatusNone', 'No flat field yet.');
      enabled.checked = Boolean(active && state.flatFieldId === active.id);
      enabled.disabled = !active || !state.originalImageData;
      const busy = Boolean(document.body.dataset.studioBusy);
      const useBtn = document.getElementById('flatFieldUseCurrentBtn');
      const detectBtn = document.getElementById('flatFieldDetectBtn');
      const applyBtn = document.getElementById('flatFieldApplySelectedBtn');
      const clearBtn = document.getElementById('flatFieldClearBtn');
      if (useBtn) useBtn.disabled = !state.loadedBaseImageData && !state.originalImageData || busy;
      if (detectBtn) detectBtn.disabled = state.fileQueue.filter((item) => item.selected).length < 2 || busy;
      if (applyBtn) applyBtn.disabled = !active || busy;
      if (clearBtn) clearBtn.disabled = !active || busy;
      const warning = document.getElementById('flatFieldLensWarning');
      if (warning) {
        const lensVignetting = Boolean(state.lensCorrection?.enabled && state.lensCorrection.modes?.includeVignetting !== false && state.lensCorrection.selectedLens);
        warning.style.display = active && state.flatFieldId === active.id && lensVignetting ? '' : 'none';
      }
    }

    function registerFlatField(map) {
      state.flatFields[map.id] = map;
      state.flatFieldActiveId = map.id;
    }

    // Sets the roll's flat field on the selected files (never on the blank
    // itself) and on the open file.
    function applyFlatFieldToItems(id, items, { sourceFile = null, defaultsImage = null } = {}) {
      let count = 0;
      for (const item of items) {
        if (sourceFile && item.file === sourceFile) continue;
        if (item.file === state.loadedFile) {
          if (state.flatFieldId !== id) {
            state.flatFieldId = id;
            markCurrentFileDirty();
          }
          count++;
          continue;
        }
        if (item.settings) {
          if (item.settings.flatFieldId !== id) {
            item.settings = { ...item.settings, flatFieldId: id };
            item.status = 'pending';
          }
        } else {
          item.settings = { ...createDefaultSettings(defaultsImage || state.originalImageData || { width: 1, height: 1 }), flatFieldId: id };
          item.isDirty = false;
        }
        count++;
      }
      return count;
    }

    // Files without settings get defaults measured on the open frame; beside
    // a crop that frame is built in the pool first (#244).
    async function flatFieldDefaultsImage(items, sourceFile = null) {
      const needed = items.some(item => !(sourceFile && item.file === sourceFile) && item.file !== state.loadedFile && !item.settings);
      return needed && state.originalImageData ? geometryFramePixels() : null;
    }

    async function useCurrentAsFlatField() {
      const source = state.loadedBaseImageData || state.originalImageData;
      const currentItem = getCurrentQueueItem();
      if (!source || document.body.dataset.studioBusy) return;
      const score = scoreBlankFrame(source);
      if (!score.blank) {
        const ok = await appConfirm(getLocalizedText('flatFieldNotBlankConfirm', 'This photo does not look like a blank frame of the light source. Use it as the flat field anyway?'));
        if (!ok) return;
      }
      const map = buildFlatFieldMap(source, { source: currentItem?.file?.name || state.loadedFile?.name || 'current photo' });
      if (!map) return;
      const targets = state.fileQueue.filter((item) => item.selected && item.file !== currentItem?.file);
      const defaultsImage = await flatFieldDefaultsImage(targets, currentItem?.file || null);
      if (getCurrentQueueItem() !== currentItem) return;
      pushUndo('flatField');
      registerFlatField(map);
      const count = applyFlatFieldToItems(map.id, targets, { sourceFile: currentItem?.file || null, defaultsImage });
      updateFlatFieldUI();
      updateFileListUI();
      showToast(getInterpolatedText('flatFieldApplied', { count: String(count) }, `Flat field applied to ${count} photo(s)`));
    }

    async function detectBlankFrameInSelection() {
      if (document.body.dataset.studioBusy || state.cropping || isDesktopBatchExportLocked()) return;
      const selectedItems = items || state.fileQueue.filter((item) => item.selected);
      if (selectedItems.length < (automatic ? 3 : 2)) return;
      const generation = loadGeneration;
      studioAutoFrameRunning = true;
      document.body.dataset.studioBusy = 'true';
      studioWorkspace?.sync();
      showBatchProgress(true);
      let best = null;
      try {
        persistCurrentFileSettings({ silent: true, force: true });
        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
          updateBatchProgress(i + 1, selectedItems.length, item.file.name);
          try {
            const imageData = await loadFileToImageData(item.file);
            const score = scoreBlankFrame(imageData);
            if (score.blank && (!best || score.score > best.score.score)) best = { item, imageData, score };
          } catch (error) {
            console.warn('Blank frame check failed for', item.file.name, error);
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!isCurrentLoad(generation)) return;
        if (!best) {
          void appAlert(getLocalizedText('flatFieldDetectNone', 'No blank light-source frame found among the selected photos.'));
          return;
        }
        const defaultsImage = await flatFieldDefaultsImage(selectedItems, best.item.file);
        if (!isCurrentLoad(generation)) return;
        pushUndo('flatField');
        const map = buildFlatFieldMap(best.imageData, { source: best.item.file.name });
        registerFlatField(map);
        const count = applyFlatFieldToItems(map.id, selectedItems, { sourceFile: best.item.file, defaultsImage });
        showToast(getInterpolatedText('flatFieldDetected', { name: best.item.file.name }, `Blank frame found: ${best.item.file.name}`) + ' · ' + getInterpolatedText('flatFieldApplied', { count: String(count) }, `Flat field applied to ${count} photo(s)`), 3200);
      } finally {
        showBatchProgress(false);
        studioAutoFrameRunning = false;
        delete document.body.dataset.studioBusy;
        studioWorkspace?.sync();
      }
      updateFlatFieldUI();
      updateFileListUI();
      if (state.originalImageData && state.flatFieldId) scheduleSilverSourceRefresh({ immediate: true });
    }

    async function applyFlatFieldToSelected() {
      const id = state.flatFieldActiveId;
      if (!id || !state.flatFields[id]) return;
      const source = state.flatFields[id].source;
      const targets = state.fileQueue.filter((item) => item.selected && item.file.name !== source);
      const generation = loadGeneration;
      const defaultsImage = await flatFieldDefaultsImage(targets);
      if (!isCurrentLoad(generation) || state.flatFieldActiveId !== id) return;
      pushUndo('flatField');
      const count = applyFlatFieldToItems(id, targets, { defaultsImage });
      updateFlatFieldUI();
      updateFileListUI();
      showToast(getInterpolatedText('flatFieldApplied', { count: String(count) }, `Flat field applied to ${count} photo(s)`));
      if (state.flatFieldId === id) scheduleSilverSourceRefresh({ immediate: true });
    }

    function clearFlatField() {
      if (!state.flatFieldActiveId) return;
      pushUndo('flatField');
      const hadCurrent = Boolean(state.flatFieldId);
      for (const item of state.fileQueue) {
        if (item.settings?.flatFieldId) {
          item.settings = { ...item.settings, flatFieldId: null };
          item.status = 'pending';
        }
      }
      resetFlatFieldState();
      markCurrentFileDirty();
      updateFileListUI();
      showToast(getLocalizedText('flatFieldCleared', 'Flat field cleared.'));
      if (hadCurrent) scheduleSilverSourceRefresh({ immediate: true });
    }

    function setFlatFieldForCurrent(enabled) {
      const id = state.flatFieldActiveId;
      if (!id || !state.flatFields[id]) return;
      const next = enabled ? id : null;
      if (state.flatFieldId === next) return;
      pushUndo('flatField');
      state.flatFieldId = next;
      markCurrentFileDirty();
      updateFlatFieldUI();
      scheduleSilverSourceRefresh({ immediate: true });
    }

    document.getElementById('flatFieldUseCurrentBtn')?.addEventListener('click', () => { void useCurrentAsFlatField(); });
    document.getElementById('flatFieldDetectBtn')?.addEventListener('click', () => { void detectBlankFrameInSelection(); });
    document.getElementById('flatFieldApplySelectedBtn')?.addEventListener('click', applyFlatFieldToSelected);
    document.getElementById('flatFieldClearBtn')?.addEventListener('click', clearFlatField);
    document.getElementById('flatFieldEnabled')?.addEventListener('change', (event) => setFlatFieldForCurrent(event.target.checked));

    queueMicrotask(mountLearningUI);
    queueMicrotask(mountHotFolderUI);
    let hotFolder = null, hotFolderUnlisten = null, hotFolderEpoch = 0, hotFolderFiles = [], hotFolderQuiet;
    let hotFolderImports = Promise.resolve();
    async function stopHotFolder() {
      hotFolderEpoch++; hotFolder = null; hotFolderFiles = []; clearTimeout(hotFolderQuiet);
      if (hotFolderUnlisten) { hotFolderUnlisten(); hotFolderUnlisten = null; }
      if (isTauriDesktop()) await window.__TAURI__.core.invoke('stop_watch_import_folder');
      updateHotFolderUI();
    }
    function updateHotFolderUI() {
      const button = document.getElementById('studioWatchFolder');
      if (!button) return;
      const existing = document.getElementById('studioWatchExisting');
      if (existing) existing.disabled = Boolean(hotFolder);
      button.textContent = hotFolder ? getInterpolatedText('watchFolderActive', { folder: hotFolder.path.split(/[\\/]/).pop() }, `Watching ${hotFolder.path} · Stop`) : getLocalizedText('watchFolder', 'Watch a folder…');
    }
    function mountHotFolderUI() {
      if (!isTauriDesktop()) return;
      const button = document.createElement('button'); button.type = 'button'; button.id = 'studioWatchFolder';
      const existing = document.createElement('label'); existing.className = 'studio-watch-existing';
      existing.innerHTML = '<input type="checkbox" id="studioWatchExisting"><span data-i18n="watchFolderExisting"></span>';
      existing.querySelector('span').textContent = getLocalizedText('watchFolderExisting', 'Import existing files too');
      const controls = document.createElement('div'); controls.id = 'studioWatchControls'; controls.append(button, existing);
      document.getElementById(state.originalImageData ? 'studioBatchActions' : 'uploadPlaceholder')?.append(controls); updateHotFolderUI();
      button.addEventListener('click', async () => {
        if (hotFolder) { await stopHotFolder(); return; }
        button.disabled = true;
        warmImportPipeline();
        try {
          const epoch = ++hotFolderEpoch;
          hotFolderUnlisten = await window.__TAURI__.event.listen('import-folder-file', ({ payload }) => {
            hotFolderImports = hotFolderImports.then(async () => {
              if (epoch !== hotFolderEpoch || payload.session !== hotFolder?.session) return;
              const file = await readDesktopImportFile(payload, window.__TAURI__.core.invoke, () => epoch === hotFolderEpoch);
              if (state.fileQueue.some(item => item.file.name === file.name && item.file.size === file.size)) return;
              addFilesToQueue([file]);
              const item = state.fileQueue.find(item => item.file === file);
              if (!item) return;
              item.importId = `watch:${payload.session}`;
              if (!state.originalImageData) await switchToFile(state.fileQueue.indexOf(item));
              else {
                // The full-resolution planes serve only the thumbnail (#250).
                const ownedPlanes = [];
                try {
                  const image = await processFileWithSettings(file, null, { bitDepth: 8, ownedPlanes });
                  if (epoch !== hotFolderEpoch || !state.fileQueue.includes(item)) return;
                  item.thumbnail = thumbnailDataUrl(image); item.status = 'done'; updateFileListUI();
                } finally {
                  releaseOwnedPlanes(...ownedPlanes);
                }
              }
              showToast(getInterpolatedText('watchFolderArrival', { name: file.name }, `Imported ${file.name}`));
              hotFolderFiles.push(item); clearTimeout(hotFolderQuiet);
              hotFolderQuiet = setTimeout(() => {
                const arrived = hotFolderFiles; hotFolderFiles = [];
                if (arrived.length >= 3) scheduleAutomaticRollImport(arrived, { prepared: true });
              }, 2500);
            }).catch(error => { console.warn('Hot folder import failed:', error); showToast(getLocalizedText('watchFolderFailed', 'Could not import the new file.')); });
          });
          hotFolder = await window.__TAURI__.core.invoke('watch_import_folder', { importExisting: document.getElementById('studioWatchExisting').checked });
          if (!hotFolder && hotFolderUnlisten) { hotFolderUnlisten(); hotFolderUnlisten = null; }
          updateHotFolderUI();
        } catch (error) { await stopHotFolder(); console.warn('Folder watch failed:', error); showToast(getLocalizedText('watchFolderFailed', 'Could not watch this folder.')); }
        finally { button.disabled = false; }
      });
    }
    const learnedRecords = new Map();
    let learningEpoch = 0;
    const learnedReady = readLearnedDefaults().then(records => {
      for (const record of records) learnedRecords.set(record.key, record);
      updateLearningUI();
    }).catch(error => console.warn('Learned defaults storage unavailable:', error));
    function learnsImportDefaults(item) {
      return Boolean(item && !item.savedSettings && !state.rollReference.applyLock && !item.userEdited);
    }
    async function learnedImportSettings(settings, item) {
      if (!learnsImportDefaults(item)) return settings;
      await learnedReady;
      item.automaticDefaults ||= structuredClone(settings);
      const key = learnedDefaultsKey(settings, state.rollMetadata);
      return applyLearnedDefaults(settings, learnedRecords.get(key));
    }
    // The same learned values for a provisional render, without recording
    // `automaticDefaults`: only the final (post-detection) settings may.
    async function provisionalLearnedSettings(settings, item) {
      if (!learnsImportDefaults(item)) return settings;
      await learnedReady;
      return applyLearnedDefaults(settings, learnedRecords.get(learnedDefaultsKey(settings, state.rollMetadata)));
    }
    let learningWrites = Promise.resolve();
    function learnFromExport(item) {
      if (!item || item.savedSettings || state.rollReference.applyLock || !item.automaticDefaults || !item.touchedKeys?.size) return Promise.resolve();
      const final = item === getCurrentQueueItem() ? extractCurrentSettings() : item.settings;
      if (!final) return Promise.resolve();
      const key = learnedDefaultsKey(final, state.rollMetadata);
      const delta = learnedDelta(item.automaticDefaults, final, [...item.touchedKeys]);
      const epoch = learningEpoch;
      learningWrites = learningWrites.then(async () => {
        await learnedReady;
        if (epoch !== learningEpoch) return;
        const record = recordLearnedObservation(learnedRecords.get(key), { key, rollId: item.importId, frameId: item.id, delta });
        if (!record) return;
        await writeLearnedDefaults(record);
        if (epoch !== learningEpoch) return;
        learnedRecords.set(key, record); updateLearningUI();
      }).catch(error => console.warn('Could not save learned defaults:', error));
      return learningWrites;
    }
    function updateLearningUI() {
      const line = document.getElementById('learnedDefaultsCount');
      if (line) line.textContent = getInterpolatedText('learnedDefaultsCount', { count: learnedRecords.size }, `Learned defaults: ${learnedRecords.size} stocks`);
    }
    // Mounted below with the workspace, and kept local to this device.
    function mountLearningUI() {
      const content = document.querySelector('#studioMenu .studio-menu-content');
      if (!content) return;
      const line = document.createElement('div'); line.id = 'learnedDefaultsLine';
      const label = document.createElement('span'); label.id = 'learnedDefaultsCount';
      const button = document.createElement('button'); button.type = 'button'; button.id = 'resetLearnedDefaults';
      button.dataset.i18n = 'learnedDefaultsReset'; button.textContent = getLocalizedText('learnedDefaultsReset', 'Reset');
      button.addEventListener('click', async () => {
        if (!await appConfirm(getLocalizedText('learnedDefaultsResetConfirm', 'Reset the learned defaults on this device?'))) return;
        learningEpoch++;
        await learningWrites;
        await resetLearnedDefaults(); learnedRecords.clear(); updateLearningUI();
      });
      line.append(label, button); content.append(line); updateLearningUI();
    }

    // Roll-level film type (#231). One record per import transaction of at
    // least three frames (with automatic roll import on) keeps each frame's
    // own verdict in import order; decideRollFilmType turns B&W majorities
    // into segments. Retypes stay automatic (filmTypeSource 'auto'), never
    // touch manual, overridden, saved or edited frames, and change only
    // film-type fields, so roll-analysis samples remain valid.
    const importFilmTypeRolls = new Map();
    function importFilmTypeRoll(item) {
      return item?.importId ? importFilmTypeRolls.get(item.importId) || null : null;
    }
    function importFilmTypeActive(record) {
      return Boolean(record && !record.corrected && record.revision === automaticRollRevision && importFilmTypeRolls.get(record.id) === record);
    }
    function createImportFilmTypeRoll(items) {
      const importId = items[0]?.importId;
      if (!importId || !state.importFilmTypeAuto) return null;
      for (const [id, record] of importFilmTypeRolls) {
        if (!record.items.some(item => state.fileQueue.includes(item))) importFilmTypeRolls.delete(id);
      }
      let record = importFilmTypeRolls.get(importId);
      if (!record) {
        record = { id: importId, items: [], verdicts: new Map(), typed: new Map(), revision: automaticRollRevision, final: false,
          corrected: false, toastShown: false, deferredToast: null, timer: null, flipping: false, rechecks: 0, rekeys: new Set() };
        importFilmTypeRolls.set(importId, record);
      }
      record.revision = automaticRollRevision;
      record.final = false;
      for (const item of items) {
        if (item.importId !== importId || record.items.includes(item)) continue;
        record.items.push(item);
        // Watch-folder frames are prepared before their batch is known.
        const own = ownFilmTypeVerdict(item.settings);
        if (own) record.verdicts.set(item, own);
      }
      return record;
    }
    function liveImportSettings(item) {
      return item && item === getCurrentQueueItem() && state.originalImageData ? state : item?.settings || null;
    }
    function importFilmTypeLocked(item) {
      const settings = liveImportSettings(item);
      return Boolean(item.savedSettings || item.userEdited || sanitizeFilmTypeOverride(item.filmTypeOverride)
        || (settings && settings.filmTypeSource !== 'auto'));
    }
    function refreshImportFilmTypeDecision(record) {
      const { typed } = decideRollFilmType(record.items.map(item => {
        const own = state.fileQueue.includes(item) ? record.verdicts.get(item) || null : null;
        return rollDecisionFrame(item.id, own, { locked: importFilmTypeLocked(item), live: liveImportSettings(item) });
      }));
      const next = new Map();
      for (const item of record.items) {
        const entry = typed.get(item.id);
        if (entry) next.set(item, { filmType: entry.filmType, confidence: entry.confidence, reason: entry.reason });
      }
      record.typed = mergeRollDecision(record.typed, next, { final: record.final });
    }
    function importFilmTypeTarget(record, item) {
      if (!state.fileQueue.includes(item) || importFilmTypeLocked(item)) return null;
      return rollFilmTypeTarget({ own: record.verdicts.get(item), live: liveImportSettings(item), typed: record.typed.get(item), final: record.final });
    }
    // Records a fresh recipe's own verdict, after DX and edge text, and
    // returns it with the import's decision applied. Frames that get settings
    // outside pass 1 (batch export, batch auto-frame, the thumbnail lane) take
    // the same decision.
    function settleImportFilmType(item, settings) {
      const record = importFilmTypeRoll(item);
      if (!record || !settings || !record.items.includes(item)) return settings;
      const own = ownFilmTypeVerdict(settings);
      if (own) record.verdicts.set(item, own);
      if (record.corrected) return settings;
      refreshImportFilmTypeDecision(record);
      if (importFilmTypeActive(record)) scheduleImportFilmTypeUpdate(record);
      const target = own && !own.manual && !importFilmTypeLocked(item) ? record.typed.get(item) : null;
      return target ? applyAutomaticFilmType(settings, target) : settings;
    }
    function scheduleImportFilmTypeUpdate(record, delay = 0) {
      if (!importFilmTypeActive(record) || record.timer !== null) return;
      record.timer = setTimeout(() => {
        record.timer = null;
        if (!importFilmTypeActive(record)) return;
        refreshImportFilmTypeDecision(record);
        applyImportFilmTypeDecision(record);
      }, delay);
    }
    function relearnImportSettings(settings, item) {
      if (!item.automaticDefaults || item.savedSettings || item.userEdited || state.rollReference.applyLock) return settings;
      return applyLearnedDefaults(settings, learnedRecords.get(learnedDefaultsKey(settings, state.rollMetadata)));
    }
    // Applied the way a film-type change is: automatic WB and analysis of the
    // old type are reset, and learned defaults follow the new type's key.
    function retypeImportItem(record, item, target) {
      const before = automaticRollItemKey(item);
      const base = applyAutomaticFilmType(withoutLearnedDefaults(item.settings, item.automaticDefaults), target);
      if (item.automaticDefaults) item.automaticDefaults = applyAutomaticFilmType(item.automaticDefaults, target);
      item.settings = relearnImportSettings(base, item);
      for (const rekey of record.rekeys) rekey(item, before);
    }
    function applyImportFilmTypeDecision(record) {
      let changed = false, loading = false;
      for (const item of record.items) {
        const target = importFilmTypeTarget(record, item);
        if (!target) continue;
        if (item === getCurrentQueueItem()) { void flipImportPhoto(record); continue; }
        // A photo still being opened adopts the decision once it is current.
        if (item === state.fileQueue[state.currentFileIndex] || item === state.photoSwitchTarget) { loading = true; continue; }
        retypeImportItem(record, item, target);
        changed = true;
      }
      if (changed) { record.rechecks = 0; updateFileListUI(); scheduleProjectRecovery(); }
      if (loading && record.rechecks++ < 120) scheduleImportFilmTypeUpdate(record, 500);
    }
    // The open photo follows the decision only while untouched, from its
    // loaded base: no decode and no undo entry. A newer load, a roll revision
    // or an edit wins.
    async function flipImportPhoto(record, { wait = false, isValid = () => true } = {}) {
      if (record.flipping) return false;
      const item = getCurrentQueueItem();
      const generation = loadGeneration;
      const current = () => isValid() && importFilmTypeActive(record) && isCurrentLoad(generation)
        && item === getCurrentQueueItem() && Boolean(importFilmTypeTarget(record, item));
      record.flipping = true;
      try {
        while (current() && (!studioBackgroundReady() || state.cropping)) {
          if (!wait) { scheduleImportFilmTypeUpdate(record, 250); return false; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!current()) return false;
        persistCurrentFileSettings({ silent: true, force: true });
        const target = importFilmTypeTarget(record, item);
        if (!target || !item.settings) return false;
        retypeImportItem(record, item, target);
        restoreSettings(item.settings);
        updateFileListUI();
        await processNegative({ quiet: true });
        return true;
      } finally { record.flipping = false; }
    }
    // Pass 1 has read every frame: the decision becomes authoritative and is
    // applied before roll grouping, so the shared analysis runs once in the
    // settled mode from the samples pass 1 kept.
    async function finalizeImportFilmType(record, isValid) {
      if (!importFilmTypeActive(record)) return;
      record.final = true;
      refreshImportFilmTypeDecision(record);
      applyImportFilmTypeDecision(record);
      const current = getCurrentQueueItem();
      if (current && record.items.includes(current) && importFilmTypeTarget(record, current)) {
        await flipImportPhoto(record, { wait: true, isValid });
      }
      if (isValid() && importFilmTypeActive(record)) showImportFilmTypeToast(record);
    }
    // In a roll import the roll's toast replaces the per-frame monochrome
    // prompt; it is shown later only when no B&W segment formed.
    function deferImportFilmTypeToast(item, settings) {
      const record = importFilmTypeRoll(item);
      if (!importFilmTypeActive(record) || record.final || !record.items.includes(item) || settings.filmTypeReason !== 'monochrome') return false;
      record.deferredToast = item;
      return true;
    }
    function showImportFilmTypeToast(record) {
      const typed = [...record.typed.keys()].filter(item => state.fileQueue.includes(item) && !importFilmTypeLocked(item));
      if (!record.toastShown && typed.length) {
        record.toastShown = true;
        record.deferredToast = null;
        showToast(getInterpolatedText('filmTypeRollMonochromeToast', { count: String(typed.length) }, `${typed.length} photos treated as B&W negatives.`), 12000, {
          action: { id: 'rollPositives', label: getLocalizedText('filmTypeRollPositives', 'These are positives'), onClick: () => applyImportPositives(record) }
        });
        return;
      }
      const deferred = record.deferredToast;
      record.deferredToast = null;
      if (deferred && deferred === getCurrentQueueItem() && state.filmTypeSource === 'auto'
        && state.filmTypeConfidence === 'low' && state.filmTypeReason === 'monochrome') {
        showToast(i18n[currentLang].filmTypeMonochrome, 6500);
      }
    }
    // "These are positives": the existing roll override, on exactly the frames
    // the decision typed, as one undo step. A colour roll in the same import
    // is left alone.
    function applyImportPositives(record) {
      if (record.corrected) return;
      if (!state.originalImageData || !studioBackgroundReady() || state.cropping) {
        if (state.fileQueue.some(item => record.items.includes(item))) setTimeout(() => applyImportPositives(record), 250);
        return;
      }
      persistCurrentFileSettings({ silent: true, force: true });
      const targets = record.items.filter(item => state.fileQueue.includes(item) && !sanitizeFilmTypeOverride(item.filmTypeOverride)
        && (item.settings ? item.settings.filmTypeSource === 'auto' && item.settings.filmTypeReason === ROLL_MONOCHROME.reason : record.typed.has(item)));
      if (!targets.length) return;
      pushUndo('rollFilmType');
      automaticRollRevision++;
      record.corrected = true;
      clearTimeout(record.timer); record.timer = null;
      const choice = { filmType: 'positive', positiveMode: state.positiveMode };
      const analysed = targets.some(item => item.settings?.rollFrame?.rollId && item.settings.rollFrame.rollId === state.rollAnalysis.id);
      for (const item of targets) {
        item.filmTypeOverride = { ...choice };
        if (item.settings) item.settings = applyFilmTypeOverride(item.settings, choice);
        item.thumbnailKey = null; item.thumbnailAttempted = false;
        item.status = 'pending'; item.isDirty = false;
      }
      if (analysed) state.rollAnalysis = { equalize: Boolean(state.rollAnalysis.equalize) };
      const current = getCurrentQueueItem();
      if (current && targets.includes(current)) {
        restoreSettings(current.settings);
        invalidateSilverCoreCache();
        if (usesSilverCoreConversion(state)) scheduleSilverSourceRefresh({ immediate: true });
        else schedulePreviewUpdate();
      }
      updateFileListUI(); updateRollAnalysisUI();
      scheduleProjectRecovery();
      showToast(getInterpolatedText('filmTypeAppliedRoll', { count: String(targets.length) }, `Film type applied to ${targets.length} photos`));
    }

    const AUTO_ROLL_KEY = 'nc_auto_roll_import_v1';
    function automaticRollItemKey(item) {
      // Navigation alone does not invalidate detached measurements. Unsaved
      // edits to the live photo do: its queue recipe has not caught up yet.
      return JSON.stringify([item.settings, item.studioColors, item.filmTypeOverride,
        item.file === state.loadedFile && item.isDirty && !item.provisional ? extractCurrentSettings() : null]);
    }

    // `resumeAttempt` and `safeMode` resume an interrupted analysis (#241).
    function scheduleAutomaticRollImport(imported, { prepared = false, resumeAttempt = 0, safeMode = false } = {}) {
      if (safeStorageGet(AUTO_ROLL_KEY) === 'off') return;
      const pending = imported.filter(item => !item.savedSettings && (!item.settings || prepared));
      if (pending.length < 3) return;
      const filmTypeRoll = createImportFilmTypeRoll(imported);
      for (const item of pending) automaticRollPendingItems.add(item);
      const requestRevision = automaticRollRevision;
      const failed = new Set();
      const sampleKeys = new Map();
      const pendingPuts = new Map();
      let storage = null;
      let timer = null;
      let finished = false;
      // The job marker: written when the first attempt starts, updated as
      // frames are analysed, deleted when the analysis ends.
      let marker = null;
      const recordRollFrame = (item) => {
        if (!marker) return;
        marker.record(pending.indexOf(item));
        marker.setEdited(pending.flatMap((entry, index) => (entry.userEdited ? [index] : [])));
      };
      // Auto-frame scores with the film type of the open photo. Keep the value
      // pass 1 started with, so a roll decision that flips the open photo does
      // not switch the density profile for the frames still to come.
      let frameFilmType = null;
      const eligible = item => state.fileQueue.includes(item) && !item.savedSettings && !item.userEdited && !failed.has(item);
      const valid = () => requestRevision === automaticRollRevision && safeStorageGet(AUTO_ROLL_KEY) !== 'off'
        && !state.rollReference.applyLock && pending.some(eligible);
      // Keep lossless, byte-bounded samples across a deferred attempt. A recipe
      // change invalidates its sample without re-decoding unchanged neighbours.
      const samples = {
        async get(item) {
          if (sampleKeys.get(item) !== automaticRollItemKey(item)) {
            await samples.delete(item);
            return null;
          }
          return storage ? storage.get(item) : null;
        },
        async put(item, sample) {
          const put = { key: automaticRollItemKey(item) };
          pendingPuts.set(item, put);
          storage ||= createAnalysisSampleStore();
          await storage.put(item, sample);
          if (pendingPuts.get(item) === put) pendingPuts.delete(item);
          sampleKeys.set(item, put.key);
        },
        async delete(item) { sampleKeys.delete(item); await storage?.delete(item); }
      };
      // A roll film-type decision changes only film-type fields of a recipe.
      // A sample depends on the base and geometry alone, so it stays valid
      // and roll analysis does not decode the frame again (#231).
      const rekeySample = (item, before) => {
        const after = automaticRollItemKey(item);
        if (sampleKeys.get(item) === before) sampleKeys.set(item, after);
        const put = pendingPuts.get(item);
        if (put?.key === before) put.key = after;
      };
      filmTypeRoll?.rekeys.add(rekeySample);
      const finish = async () => {
        if (!finished) for (const item of pending) automaticRollPendingItems.delete(item);
        finished = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        marker?.finish();
        marker = null;
        if (safeMode) hiddenJobs.setSafeMode(false);
        filmTypeRoll?.rekeys.delete(rekeySample);
        await storage?.clear();
      };
      const schedule = delay => {
        if (finished || timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          void attempt().catch(async error => {
            console.warn('Automatic roll analysis failed:', error);
            await finish();
          });
        }, delay);
      };
      const attempt = async () => {
        if (finished) return;
        if (!valid()) { await finish(); return; }
        if (!studioBackgroundReady() || automaticRollImportRunning || state.cropping) {
          schedule(750); return;
        }
        automaticRollImportRunning = true;
        let retry = false;
        if (!marker) {
          if (safeMode) hiddenJobs.setSafeMode(true);
          marker = createJobMarker(jobMarkerStorage);
          marker.begin({
            kind: 'roll-analysis', attempt: resumeAttempt,
            files: pending.map(item => ({ name: item.file.name, size: item.file.size, lastModified: item.file.lastModified || 0 })),
            written: pending.flatMap((item, index) => (item.settings ? [[index, '']] : []))
          });
        }
        try {
          persistCurrentFileSettings({ silent: true, force: true });
          const current = getCurrentQueueItem();
          if (pending.includes(current) && eligible(current) && current.settings && canReuseLoadedRollSource(current)
            && !await samples.get(current)) {
            await samples.put(current, buildRollAnalysisSample(state.loadedBaseImageData || state.originalImageData, current.settings));
          }
          // Frames are decoded and measured a few at a time (same lane planning
          // as the batch export), each lane with its own frame analyzer, and
          // never behind the blocking overlay: the editor stays usable.
          // The requested foreground item already owns its decode even before
          // loadedFile catches up and getCurrentQueueItem becomes non-null.
          const toAnalyze = pending.filter(item => eligible(item) && !item.settings && item !== state.fileQueue[state.currentFileIndex]);
          if (toAnalyze.length) frameFilmType ??= state.filmType;
          const lanes = hiddenJobs.safeMode ? 1 : await planBatchLanes(toAnalyze.map(item => item.file));
          const bytes = await hiddenJobBytesFor(toAnalyze.map(item => item.file));
          const analyzers = createAutoFrameWorkerPool({ size: lanes });
          const stop = new AbortController();
          const trace = createPerfTrace('automaticRollImport', { files: toAnalyze.length, lanes });
          try {
            await runBatchPipeline(toAnalyze, {
              maxParallel: lanes,
              signal: stop.signal,
              beforeStart: ({ signal }) => hiddenJobs.admit({ bytes, signal }),
              process: async (item) => {
                if (!valid()) { stop.abort(); return null; }
                const key = automaticRollItemKey(item);
                const itemValid = () => valid() && eligible(item) && !item.settings
                  && item !== state.fileQueue[state.currentFileIndex] && key === automaticRollItemKey(item);
                if (!itemValid()) return null;
                const image = await loadFileToImageData(item.file, { filmStats: true });
                if (!itemValid()) { retry = true; return null; }
                let settings = await analyzeStudioImportFrame(image, createDefaultSettings(image, item), { silent: true, analyzeInWorker: analyzers.analyze, filmType: frameFilmType ?? state.filmType });
                if (!itemValid()) { retry = true; return null; }
                const edge = await analyzeImportFilmEdge(image, settings, { applyDefaults: state.importFilmTypeAuto, readFilmEdge: analyzers.readFilmEdge });
                if (!itemValid()) { retry = true; return null; }
                if (edge) settings = edge.settings;
                settings = await learnedImportSettings(settleImportFilmType(item, settings), item);
                if (!itemValid()) { retry = true; return null; }
                return { settings, sample: buildRollAnalysisSample(image, settings), key };
              },
              sink: async (item, payload) => {
                if (!payload || !valid() || !eligible(item) || item.settings || item === state.fileQueue[state.currentFileIndex]
                  || payload.key !== automaticRollItemKey(item)) return;
                item.settings = payload.settings; item.automaticSettings = true;
                await samples.put(item, payload.sample);
                // Each frame's recipe reaches the recovery copy within 2.5 s,
                // so a kill loses at most the frames still in flight (#241).
                recordRollFrame(item);
                scheduleProjectRecovery();
                // Apply a decision that changed while this frame was measured.
                scheduleImportFilmTypeUpdate(filmTypeRoll);
                // The tile shows this frame's converted look as soon as it is
                // measured; the next decode does not wait for the render.
                renderFrameAnalysisThumbnail(item, payload,
                  () => valid() && eligible(item) && item.settings === payload.settings);
              },
              onEvent: (event) => {
                if (event.type !== 'error' || !valid() || !eligible(event.job)
                  || event.job.settings || event.job === state.fileQueue[state.currentFileIndex]) return;
                failed.add(event.job);
                event.job.status = 'error'; event.job.error = event.error?.message || String(event.error);
              }
            });
          } finally {
            analyzers.dispose();
            trace.end();
          }
          if (!valid()) return;
          if (studioBackgroundReady()) persistCurrentFileSettings({ silent: true, force: true });
          // Settle the film type before grouping (#231), once pass 1 has read
          // every frame of the import.
          if (filmTypeRoll && pending.filter(eligible).every(item => item.settings || filmTypeRoll.verdicts.has(item))) {
            await finalizeImportFilmType(filmTypeRoll, valid);
            if (!valid()) return;
          }
          for (const group of groupAutomaticRollFrames(pending.filter(eligible), { referenceLocked: state.rollReference.applyLock })) {
            if (!valid()) return;
            const result = await runRollAnalysis({ items: group, automatic: true, samples });
            if (result?.status === 'deferred' || result?.status === 'stale') retry = true;
          }
          if (!valid()) return;
          // A foreground load owns its recipe while it is being prepared.
          // Resume once it settles instead of permanently dropping the roll.
          if (pending.some(item => eligible(item) && !item.settings)) retry = true;
          if (pending.includes(getCurrentQueueItem()) && eligible(getCurrentQueueItem()) && !studioBackgroundReady()) retry = true;
          notifyImportReview(pending); updateFileListUI(); scheduleProjectRecovery();
        } finally {
          automaticRollImportRunning = false;
          releaseFrameThumbnailWorkers();
          if (retry && valid()) schedule(750);
          else await finish();
        }
      };
      schedule(1200);
    }

    // Per-frame `analysis` tiles during automatic roll import, rendered from
    // the frame's 900 px sample with the same recipe the roll commit uses
    // (worker conversion, then createAdjustedPhotoPreview with the frame's
    // adjustment settings). They only fill empty or `embedded` tiles; the
    // commit and the canonical lane replace them as before.
    let frameThumbnailWorkers = null;
    const frameThumbnailJobs = new Set();
    function renderFrameAnalysisThumbnail(item, { sample, settings }, isValid) {
      if (!sample || !settings || !usesSilverCoreConversion(settings) || !canPublishThumbnail(item, 'analysis')) return;
      const job = (async () => {
        try {
          frameThumbnailWorkers ||= createConversionWorkerPool({ size: 1 });
          const converted = await frameThumbnailWorkers({
            imageData: downsampleImageDataForMaxDim(sample, 288),
            settings: { ...buildCoreConversionSettings(settings), analysisRegion: null },
            options: { preview: true, includeAnalysisPreview: false }
          });
          if (!converted || !isValid() || !state.fileQueue.includes(item) || !canPublishThumbnail(item, 'analysis')) return;
          item.thumbnail = thumbnailDataUrl(createAdjustedPhotoPreview(converted, buildAdjustmentSettings(settings)));
          item.thumbnailKind = 'analysis';
          item.thumbnailKey = null;
          scheduleTileFlush(item);
        } catch (error) {
          if (error?.name !== 'AbortError') console.warn('Frame thumbnail failed for', item.file?.name, error);
        }
      })();
      frameThumbnailJobs.add(job);
      void job.finally(() => {
        frameThumbnailJobs.delete(job);
        releaseFrameThumbnailWorkers();
      });
    }
    function releaseFrameThumbnailWorkers() {
      if (frameThumbnailJobs.size || automaticRollImportRunning || !frameThumbnailWorkers) return;
      frameThumbnailWorkers.dispose();
      frameThumbnailWorkers = null;
    }

    function updateRollAnalysisUI() {
      if (!stateReady) return;
      const group = document.getElementById('rollAnalysisGroup');
      const status = document.getElementById('rollAnalysisStatus');
      const frameStatus = document.getElementById('rollAnalysisFrameStatus');
      const analyzeBtn = document.getElementById('analyzeRollBtn');
      const clearBtn = document.getElementById('clearRollAnalysisBtn');
      const equalizeInput = document.getElementById('rollEqualizeExposure');
      if (!group || !status || !frameStatus || !analyzeBtn || !clearBtn || !equalizeInput) return;
      const roll = state.rollAnalysis || {};
      const hasRoll = Boolean(roll.id);
      group.style.display = state.originalImageData ? '' : 'none';
      const rollPaused = hiddenJobs.paused && (automaticRollImportRunning || automaticRollAnalysisRunning || manualRollAnalysisRunning);
      const selectedCount = state.fileQueue.filter((item) => item.selected).length;
      analyzeBtn.disabled = selectedCount < 2 || Boolean(document.body.dataset.studioBusy) || state.cropping || isDesktopBatchExportLocked();
      clearBtn.disabled = !hasRoll;
      equalizeInput.checked = Boolean(roll.equalize);
      if (rollPaused) {
        status.textContent = hiddenJobPausedText();
      } else if (!hasRoll) {
        status.textContent = getLocalizedText('rollAnalysisNone', 'Not analysed yet. Select the frames of one roll and analyse them together.');
      } else {
        const parts = [getInterpolatedText('rollAnalysisSummary', { usable: String(roll.usable), count: String(roll.count) }, `${roll.usable}/${roll.count} frames share one film base and tone analysis`)];
        if (roll.filmBase) parts.push(`R ${roll.filmBase.r} G ${roll.filmBase.g} B ${roll.filmBase.b}`);
        if (roll.outlierCount > 0) parts.push(getInterpolatedText('rollAnalysisOutliers', { count: String(roll.outlierCount), names: roll.outliers.join(', ') }, `${roll.outlierCount} outlier(s): ${roll.outliers.join(', ')}`));
        status.textContent = parts.join(' · ');
      }
      const frame = state.rollFrame;
      if (!frame) {
        frameStatus.textContent = hasRoll ? getLocalizedText('rollAnalysisFrameNone', 'This frame: not analysed') : '';
      } else if (frame.outlier) {
        frameStatus.textContent = getInterpolatedText('rollAnalysisFrameOutlier', { reasons: formatRollReasons(frame.reasons) }, `This frame: outlier (${formatRollReasons(frame.reasons)})`);
      } else {
        frameStatus.textContent = getInterpolatedText('rollAnalysisFrameLocked', { offset: formatStops(frame.offsetStops) }, `This frame: locked to the roll, ${formatStops(frame.offsetStops)} stop`);
      }
    }

    async function runRollAnalysis({ items = null, automatic = false, samples = null } = {}) {
      if (studioAutoFrameRunning || automaticRollAnalysisRunning || document.body.dataset.studioBusy || state.cropping || isDesktopBatchExportLocked() || !state.originalImageData) return { status: 'deferred' };
      if (!automatic) automaticRollRevision++;
      const selectedItems = items || state.fileQueue.filter((item) => item.selected);
      if (selectedItems.length < (automatic ? 3 : 2)) {
        if (!automatic) void appAlert(getLocalizedText('rollAnalysisNeedFiles', 'Select at least two frames of the same roll first.'));
        return;
      }
      const generation = loadGeneration;
      const requestRevision = automaticRollRevision;
      let recipeKeys = null;
      let committed = false;
      const isValid = () => (automatic
        ? requestRevision === automaticRollRevision && !state.rollReference.applyLock
          && safeStorageGet(AUTO_ROLL_KEY) !== 'off'
          && (committed || selectedItems.every(item => !item.savedSettings && !item.userEdited
            && (!recipeKeys || recipeKeys.get(item) === automaticRollItemKey(item))))
        : isCurrentLoad(generation)) && selectedItems.every(item => state.fileQueue.includes(item));
      if (automatic) automaticRollAnalysisRunning = true;
      else { studioAutoFrameRunning = true; manualRollAnalysisRunning = true; document.body.dataset.studioBusy = 'true'; }
      studioWorkspace?.sync();
      const button = document.getElementById('analyzeRollBtn');
      const previousText = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = getLocalizedText('rollAnalysisRunning', 'Analysing roll…');
      }
      if (!automatic) showBatchProgress(true);
      const measurements = [];
      const analysisSamples = samples || createAnalysisSampleStore();
      async function sampleForMeasurement(measurement) {
        const cached = await analysisSamples.get(measurement.item);
        if (cached) return cached;
        // Storage-disabled/private-mode fallback stays bounded and lossless.
        if (measurement.item.file === state.loadedFile && !state.rawDecodePending && canReuseLoadedRollSource(measurement.item)) {
          assertRepairCurrent(isValid);
          const sample = buildRollAnalysisSample(state.loadedBaseImageData || state.originalImageData, measurement.settings);
          await analysisSamples.put(measurement.item, sample);
          return sample;
        }
        // A decode is one gated item of this job (#241).
        return runHiddenJobItem([measurement.item.file], async () => {
          const image = await loadFileToImageData(measurement.item.file);
          assertRepairCurrent(isValid);
          const sample = buildRollAnalysisSample(image, measurement.settings);
          await analysisSamples.put(measurement.item, sample);
          return sample;
        });
      }
      let roll = null;
      try {
        if (!automatic && processNegativeInFlight) await processNegativeInFlight;
        if (!isValid()) return { status: 'stale' };
        if (!automatic || studioBackgroundReady()) persistCurrentFileSettings({ silent: true, force: true });
        recipeKeys = new Map(selectedItems.map(item => [item, automaticRollItemKey(item)]));
        // Pass 1: decode every frame once, read its rebate, keep a small
        // geometry-applied sample and measure base and density.
        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
          if (!isValid()) return { status: 'stale' };
          if (!automatic) updateBatchProgress(i + 1, selectedItems.length, item.file.name);
          try {
            let sample = await analysisSamples.get(item);
            let settings;
            if (sample && item.settings) settings = cloneSettings(item.settings);
            else {
              const reuse = item.file === state.loadedFile && !state.rawDecodePending && canReuseLoadedRollSource(item);
              // A decode is one gated item of this job (#241).
              const release = reuse ? null : await hiddenJobs.admit({ bytes: await hiddenJobBytesFor([item.file]) });
              try {
                const imageData = reuse ? state.loadedBaseImageData || state.originalImageData : await loadFileToImageData(item.file, { filmStats: !item.settings });
                if (!isValid()) return { status: 'stale' };
                settings = item.settings ? cloneSettings(item.settings) : createDefaultSettings(imageData, item);
                if (!settings.filmEdge?.checked) {
                  const edge = await analyzeImportFilmEdge(imageData, settings, { applyDefaults: !item.settings });
                  if (edge) settings = edge.settings;
                }
                if (!item.settings) settings = settleImportFilmType(item, settings);
                if (!isValid()) return { status: 'stale' };
                sample = buildRollAnalysisSample(imageData, settings);
                await analysisSamples.put(item, sample);
              } finally {
                release?.();
              }
            }
            measurements.push({
              item,
              settings,
              negativeMean: measureNegativeMean(sample, (settings.coreBorderBuffer ?? 10) / 100),
              filmBase: requiresFilmBase(settings) ? settings.filmBase : null
            });
          } catch (error) {
            console.error('Roll analysis failed for', item.file.name, error);
          }
          // Hidden windows clamp setTimeout to 1 s or more (#241).
          await yieldTaskForJob();
        }
        if (!isValid()) return { status: 'stale' };
        if (!measurements.length) return { status: 'skipped' };
        // Pass 2: the roll base decides the outliers, then every inlier is analysed
        // with that base so the shared channelData matches what the conversion sees.
        const colorRoll = measurements.some((m) => m.filmBase);
        const first = aggregateRollAnalysis(measurements.map((m) => ({ id: m.item.id, filmBase: colorRoll ? m.filmBase : { r: 128, g: 128, b: 128, method: 'manual' }, negativeMean: m.negativeMean })));
        for (const m of measurements) {
          if (!isValid()) return { status: 'stale' };
          const frame = first.frames.find((f) => f.id === m.item.id);
          if (frame?.outlier) continue;
          const settings = { ...m.settings, rollFrame: null };
          if (colorRoll && first.filmBase && requiresFilmBase(settings)) settings.filmBase = { ...first.filmBase };
          try {
            const sample = await sampleForMeasurement(m);
            if (!isValid()) return { status: 'stale' };
            m.channelData = await analyzeSilverCoreFrame(sample, buildCoreConversionSettings(settings), resolveConversionMode(settings));
          } catch (error) {
            console.error('Roll analysis could not analyse', m.item.file.name, error);
          }
        }
        roll = aggregateRollAnalysis(measurements.map((m) => ({
          id: m.item.id,
          filmBase: colorRoll ? m.filmBase : { r: 128, g: 128, b: 128, method: 'manual' },
          channelData: m.channelData,
          negativeMean: m.negativeMean
        })));
        if (!isValid()) return { status: 'stale' };
        const rollId = `roll-${Date.now().toString(36)}`;
        const equalize = Boolean(state.rollAnalysis.equalize);
        for (const m of measurements) {
          const frame = roll.frames.find((f) => f.id === m.item.id);
          if (!frame) continue;
          const next = m.settings;
          next.rollFrame = sanitizeRollFrameForSettings({
            rollId,
            locked: !frame.outlier && Boolean(roll.channelData),
            channelData: frame.outlier ? null : roll.channelData,
            offsetStops: frame.offsetStops,
            equalize,
            outlier: frame.outlier,
            reasons: frame.reasons
          });
          if (!frame.outlier && colorRoll && roll.filmBase && requiresFilmBase(next) && next.filmBase?.method !== 'manual') {
            next.filmBase = { ...roll.filmBase };
          }

        }
        // The light table shows the roll as it will convert. Automatic imports
        // retain byte-bounded samples until commit, so a deferred group can reuse
        // them; an explicit analysis releases each sample after its thumbnail.
        for (const m of measurements) {
          if (!isValid()) return { status: 'stale' };
          if (!usesSilverCoreConversion(m.settings)) continue;
          try {
            const thumbSource = downsampleImageDataForMaxDim(await sampleForMeasurement(m), 288);
            if (!isValid()) return { status: 'stale' };
            const converted = await convertFrameWithRouter({
              imageData: thumbSource,
              settings: { ...buildCoreConversionSettings(m.settings), analysisRegion: null },
              options: { preview: true, includeAnalysisPreview: false }
            });
            if (converted) m.thumbnail = thumbnailDataUrl(createAdjustedPhotoPreview(converted, buildAdjustmentSettings(m.settings)));
          } catch (error) {
            console.warn('Roll thumbnail failed for', m.item.file.name, error);
          } finally { if (!automatic) await analysisSamples.delete(m.item); }
        }
        if (!isValid()) return { status: 'stale' };
        // Measurements can continue across navigation, but the atomic undo
        // snapshot and live recipe adoption must belong to a settled editor.
        // Keep completed measurements while foreground decoding finishes.
        while (automatic && (!studioBackgroundReady() || state.cropping)) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (!isValid()) return { status: 'stale' };
        }
        pushUndo('rollAnalysis');
        state.rollAnalysis = {
          id: rollId,
          filmBase: colorRoll ? roll.filmBase : null,
          channelData: roll.channelData,
          count: roll.count,
          usable: roll.usable,
          outlierCount: roll.outlierCount,
          outliers: roll.frames.filter((f) => f.outlier).map((f) => measurements.find((m) => m.item.id === f.id)?.item.file.name).filter(Boolean),
          equalize
        };
        for (const m of measurements) {
          m.item.settings = m.settings; m.item.isDirty = false; m.item.status = 'pending';
          if (m.thumbnail) {
            m.item.thumbnail = m.thumbnail;
            // Roll samples omit lens correction, repairs and per-photo WB.
            // Keep the useful first preview, then let the canonical lane finish.
            m.item.thumbnailKind = 'analysis';
            m.item.thumbnailKey = null;
          }
        }
        committed = true;
        invalidateSilverCoreCache();
      } finally {
        if (!samples) await analysisSamples.clear();
        if (!automatic) showBatchProgress(false);
        if (button) {
          button.disabled = false;
          button.textContent = previousText;
        }
        if (automatic) automaticRollAnalysisRunning = false;
        else { studioAutoFrameRunning = false; manualRollAnalysisRunning = false; }
        if (!automatic && isCurrentLoad(generation)) delete document.body.dataset.studioBusy;
        studioWorkspace?.sync();
      }
      if (!isValid()) return { status: 'stale' };
      const currentItem = getCurrentQueueItem();
      // A photo parked while hidden picks the roll recipe up when it is rebuilt.
      const updateCurrent = currentItem?.settings && measurements.some((m) => m.item === currentItem)
        && (!automatic || studioBackgroundReady()) && !parkedPhoto;
      if (updateCurrent) restoreSettings(currentItem.settings);
      updateRollAnalysisUI();
      updateFileListUI();
      if (roll) {
        showToast(getInterpolatedText('rollAnalysisToast', { usable: String(roll.usable), count: String(roll.count), outliers: String(roll.outlierCount) }, `Roll analysis: ${roll.usable} of ${roll.count} frames locked, ${roll.outlierCount} outlier(s)`), 3200);
      }
      if (state.originalImageData && (!automatic || updateCurrent)) await processNegative({ quiet: automatic });
      return { status: 'committed' };
    }

    function clearRollAnalysis() {
      if (!state.rollAnalysis?.id) return;
      pushUndo('rollAnalysis');
      for (const item of state.fileQueue) {
        if (item.settings?.rollFrame) {
          item.settings = { ...item.settings, rollFrame: null };
          item.status = 'pending';
        }
      }
      state.rollFrame = null;
      resetRollAnalysisState();
      markCurrentFileDirty();
      updateFileListUI();
      if (usesSilverCoreConversion(state)) scheduleSilverSourceRefresh({ immediate: true });
      else schedulePreviewUpdate();
    }

    function setRollEqualize(enabled) {
      state.rollAnalysis.equalize = Boolean(enabled);
      for (const item of state.fileQueue) {
        if (item.settings?.rollFrame) item.settings = { ...item.settings, rollFrame: { ...item.settings.rollFrame, equalize: state.rollAnalysis.equalize } };
      }
      if (state.rollFrame) state.rollFrame = { ...state.rollFrame, equalize: state.rollAnalysis.equalize };
      updateRollAnalysisUI();
      if (state.rollFrame && usesSilverCoreConversion(state)) scheduleSilverSourceRefresh({ immediate: true });
    }

    document.getElementById('analyzeRollBtn')?.addEventListener('click', () => { void runRollAnalysis(); });
    document.getElementById('clearRollAnalysisBtn')?.addEventListener('click', clearRollAnalysis);
    const autoRollInput = document.getElementById('autoRollOnImport');
    if (autoRollInput) {
      autoRollInput.checked = safeStorageGet(AUTO_ROLL_KEY) !== 'off';
      autoRollInput.addEventListener('change', () => safeStorageSet(AUTO_ROLL_KEY, autoRollInput.checked ? 'on' : 'off'));
    }
    document.getElementById('rollEqualizeExposure')?.addEventListener('change', (event) => setRollEqualize(event.target.checked));

    {
      // 共通コントロールを唯一の暗室 UI に配置する。
      studioWorkspace = mountStudioWorkspace({
        getText: key => getLocalizedText(key),
        getState: () => state,
        getLanguage: () => currentLang,
        isExportLocked: () => singleExportActive || isDesktopBatchExportLocked(),
        // Opening the Repair tab is the usual intent to repair: load MI-GAN
        // then, so the first stroke rarely waits for it.
        onTabSelect: key => { if (key === 'repair') ensureAiRepairPreload(); },
        onResetAll: resetAllAdjustments,
        onRestart: restartPhotoProcessing,
        onNewSession: closePhotoSession,
        onSortFiles: setFileListSort,
        onStyle: model => {
          if (state.currentStep < 3) return;
          pushUndo('studioStyle');
          state.coreColorModel = model;
          state.coreFilmPreset = 'none';
          state.coreEnhancedProfile = 'none';
          state.frontierGuideStep2ChoiceTouched = true;
          markCurrentFileDirty();
          updateSlidersFromState();
          scheduleCoreReprocess({ full: false });
        },
        onReset: () => {
          if (state.currentStep < 3) return;
          pushUndo('studioReset');
          // Studio colours never depend on the pixels createDefaultSettings
          // analyses, so the working planes serve (no frame is built).
          Object.assign(state, pickStudioColors(createDefaultSettings(state.croppedImageData || state.originalImageData)));
          refreshExpiredAfterColorReset();
          ['r', 'g', 'b'].forEach(ch => updateCurveFromPoints(ch));
          updateSlidersFromState();
          renderCurve();
          markCurrentFileDirty();
          scheduleCoreReprocess({ full: false });
        },
        onSync: () => {
          if (state.currentStep < 3 || isDesktopBatchExportLocked()) return;
          const colors = pickStudioColors(state);
          const targets = state.fileQueue.filter(item => item.selected && item.file !== state.loadedFile);
          targets.forEach(item => {
            if (item.settings) item.settings = mergeStudioColors(item.settings, colors);
            else item.studioColors = structuredClone(colors);
            item.isDirty = false;
            item.status = 'pending';
          });
          persistCurrentFileSettings({ silent: true, force: true });
          updateFileListUI();
          showToast(studioWorkspace.text('synced').replace('{count}', targets.length));
        },
        onRetry: () => {
          if (!state.originalImageData) return;
          document.getElementById('applyConvertBtn').click();
        },
        onExpiredMode: () => setExpiredSession(!state.expiredSession),
        onColorCorrect: () => {
          if (!state.processedImageData || state.cropping || singleExportActive || isDesktopBatchExportLocked() || document.body.dataset.studioBusy) return;
          setExpiredEnabled(true, { reanalyze: true, undoLabel: 'colorCorrect' });
        },
        onConfirm: message => appConfirm(message),
        onExportBorder: enabled => setExportSprocketMode(enabled),
        onAutoCrop: enabled => {
          state.autoFrame.onImport = enabled;
          if (enabled) state.autoFrame.enabled = true;
          updateAutoFrameConfigUI();
          studioWorkspace?.sync();
        },
        onRestoreFrame: () => {
          if (!state.originalImageData || state.cropping || document.body.dataset.studioBusy) return;
          pushUndo('restoreFullFrame');
          state.rotationAngle = 0;
          state.mirrored = false;
          state.cropRegion = null;
          if (state.autoFrame.lastDiagnostics) state.autoFrame.lastDiagnostics.appliedMode = 'none';
          rebuildGeometryFromBase();
          markCurrentFileDirty();
          void processNegative();
        },
        onConfirmAnalysis: () => beginCropMode({ analysisOnly: true }),
        onMergeShots: (mode) => {
          mergeSelectedShots(mode).catch((error) => {
            console.error('Multi-shot merge failed:', error);
            void appAlert(getLocalizedText('multiShotFailed', 'The selected shots could not be aligned, so nothing was merged.'));
          });
        },
        onLoupe: () => { void openLoupe(); },
        onSaveProject: () => { void saveProject(); },
        onOpenProject: () => { const input = document.getElementById('projectInput'); if (input) { input.value = ''; input.click(); } },
        onRestoreProject: () => { restoreRecoveredProject(); }
      });
      void offerProjectRecovery();
      void checkInterruptedJobs();
      updateWorkflowUI();
      studioWorkspace.sync();
    }
