    import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
    import '@fontsource/inter/400.css';
    import '@fontsource/inter/500.css';
    import '@fontsource/inter/600.css';
    import '@fontsource/orbitron/500.css';
    import '@fontsource/orbitron/700.css';
    import '@fontsource/share-tech-mono/400.css';
    import { i18n } from './i18n.js';

    import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
    import { invalidateSilverCoreCache } from '../pipeline/silverAdapter.js';
    import { fromImageData8 } from '../silvercore/util/image16.js';
    import { canUseBrowserZipStreaming, ZipStoreWriter } from './zipStoreWriter.js';
    import {
      createAdjustmentLutScratch,
      stripLegacyToneSettingsForSilverCore,
      applyPreparedAdjustmentsToBuffer
    } from './adjustmentPipeline.js';
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
      getSprocketFrameMetrics,
      normalizeSprocketEdgeMarkings
    } from './sprocketFrame.js';
    import { renderFileList } from './fileListView.js';
    import { loadLocalLensfunAssets } from './lensfunLoader.js';
    import { createOpenCvLoader } from './opencvLoader.js';
    import {
      autoDetectFilmBase as detectFilmBaseAutomatically,
      sampleFilmBase as sampleFilmBaseRobust,
      sanitizeFilmBaseForSettings
    } from './filmBaseDetection.js';
    import {
      isRawLikeFileName,
      loadPngImageData,
      loadRawImageData,
      loadRawImageDataPreview,
      loadStandardImage
    } from './imageFileLoaders.js';
    import { Histogram } from '../silvercore/ui/Histogram.js';
    import { loadFilmPresets } from '../silvercore/engine/filmPresetsLoader.js';
    import {
      detectDust, updateDustStrength, inpaintMasked,
      refineMaskIntelligent, refineMaskDirect, refineMaskRemove
    } from '../silvercore/engine/DustRemoval.js';
    import { getLoadingOverlay } from '../ui/LoadingOverlay.js';
    import {
      workerApplyAdjustments,
      workerEncodePng16,
      workerEncodeTiff,
      isWorkerAvailable
    } from '../workers/workerBridge.js';

    const PERF_LOG_THRESHOLD_MS = 120;
    const FULL_RESOLUTION_IDLE_DELAY_MS = 8000;  // long enough that user won't trigger it while adjusting

    function getPerfNow() {
      return (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
    }

    function createPerfTrace(label, details = {}) {
      const startedAt = getPerfNow();
      let lastAt = startedAt;
      const stages = [];

      return {
        mark(stage, extra = {}) {
          const now = getPerfNow();
          stages.push({
            stage,
            ms: Math.round((now - lastAt) * 10) / 10,
            totalMs: Math.round((now - startedAt) * 10) / 10,
            ...extra
          });
          lastAt = now;
        },
        end(extra = {}) {
          const totalMs = Math.round((getPerfNow() - startedAt) * 10) / 10;
          if (totalMs >= PERF_LOG_THRESHOLD_MS) {
            console.info('[perf]', label, { totalMs, ...details, ...extra, stages });
          }
        }
      };
    }

    function getImageDataPixelCount(imageData) {
      return imageData ? imageData.width * imageData.height : 0;
    }


    const DEBUG_UI = new URLSearchParams(window.location.search).get('debug') === '1';
    const BUILD_ID = '2026-05-22-auto-frame-detect-5';
    const ensureOpenCvReady = createOpenCvLoader([opencvScriptUrl]);
    const AUTO_FRAME_MAX_SIDE = 1600;
    const AUTO_FRAME_FORMAT_RATIOS = {
      '135': 1.5,
      '120-6x4.5': 1.33,
      '120-6x6': 1.0,
      '120-6x7': 1.17,
      '120-6x9': 1.5
    };
    const AUTO_FRAME_DEFAULT_120_FORMATS = ['6x4.5', '6x6', '6x7', '6x9'];
    const AUTO_FRAME_SCORE_WEIGHTS = {
      area: 0.18,
      rectangularity: 0.20,
      orthogonality: 0.14,
      parallelism: 0.10,
      edgeSupport: 0.18,
      centerPrior: 0.08,
      aspect: 0.12
    };
    const CORE_ENHANCED_PROFILE_OPTIONS = new Set(['none', 'frontier', 'crystal', 'natural', 'pakon']);
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
    const STEP3_GUIDE_COLLAPSED_SESSION_KEY = 'nc_step3_guide_collapsed_v2';
    const FRONTIER_GUIDE_POPUP_SESSION_KEY = 'nc_frontier_guide_popup_shown_v1';
    const PRIVACY_BANNER_COLLAPSED_STORAGE_KEY = 'nc_privacy_banner_collapsed_v1';
    const GUIDE_MODE_STORAGE_KEY = 'nc_guide_mode_enabled_v1';
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
    let guideModeEnabled = true;
    let stateReady = false;
    let step3GuideCollapsedOnce = false;
    let frontierGuidePopupShownThisSession = false;
    let frontierGuidePopupPending = false;
    const desktopBatchExportState = {
      active: false,
      current: 0,
      total: 0,
      percent: 0,
      fileName: '',
      targetDirectory: ''
    };
    const desktopUpdateState = {
      visible: false,
      currentVersion: '',
      latestVersion: ''
    };

    function getLocalizedText(key, fallback = '') {
      const dict = i18n[currentLang] || i18n.en || {};
      if (Object.prototype.hasOwnProperty.call(dict, key) && dict[key]) {
        return dict[key];
      }
      return fallback;
    }

    function setLanguage(lang) {
      currentLang = lang;
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
      document.title = getLocalizedText('title', document.title || 'Negative Converter');
      const privacyLink = document.getElementById('privacyDetailsLink');
      if (privacyLink) {
        privacyLink.href = `./privacy.html?lang=${encodeURIComponent(lang)}`;
      }
      const offlineLink = document.getElementById('offlineDownloadLink');
      if (offlineLink) {
        offlineLink.href = `./download.html?lang=${encodeURIComponent(lang)}`;
      }
      updateDesktopUpdateBannerText();
      updateGuideModeUI();
      if (stateReady) {
        updateCurrentFileLabel();
        updateRollReferenceUI();
        updateAutoFrameConfigUI();
        updateAutoFrameDiagnosticsUI();
        updateAutoFrameButtons();
        renderNoviceGuide({ applyStep3Collapse: false });
        updateGrayPointGuideUI();
        if (typeof updateLensCorrectionUI === 'function') updateLensCorrectionUI();
        if (typeof updateExportUI === 'function') updateExportUI();
        updateDesktopBatchExportUI();
      }
    }

    // Detect language
    const browserLang = navigator.language.startsWith('ja') ? 'ja'
      : navigator.language.startsWith('zh') ? 'zh' : 'en';
    setLanguage(browserLang);

    if (DEBUG_UI) {
      const badge = document.getElementById('buildBadge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `build ${BUILD_ID}`;
      }
    }

    // Language selector
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
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

    function clearRecommendedActions() {
      [
        'autoFrameBtn',
        'cropBtn',
        'convertBtn',
        'convertPositiveBtn',
        'sampleBaseBtn',
        'autoDetectBtn',
        'useReferenceBtn',
        'applyConvertBtn',
        'sampleWBBtn',
        'headerGrayPointBtn',
        'saveSettingsBtn',
        'applyToSelectedBtn',
        'exportBtn'
      ].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('recommended-action');
      });
    }

    function setRecommendedActions(actionIds = []) {
      clearRecommendedActions();
      if (!guideModeEnabled || !Array.isArray(actionIds)) return;
      actionIds.forEach(id => {
        const btn = document.getElementById(id);
        if (!btn || btn.disabled) return;
        if (btn.style.display === 'none') return;
        btn.classList.add('recommended-action');
      });
    }

    function setSectionCollapsed(section, collapsed) {
      const header = document.querySelector(`.section-header[data-section="${section}"]`);
      const toggle = header ? header.querySelector('.section-toggle') : null;
      const content = document.getElementById(section + 'SectionContent')
        || document.getElementById(section + 'Section');
      if (toggle) toggle.classList.toggle('collapsed', Boolean(collapsed));
      if (content) content.classList.toggle('collapsed', Boolean(collapsed));
    }

    function collapseStep3SectionsForGuideIfNeeded() {
      if (!guideModeEnabled) return;
      if (state.currentStep < 3) return;
      if (step3GuideCollapsedOnce) return;
      ['color', 'effects', 'engine', 'additional'].forEach(section => {
        setSectionCollapsed(section, true);
      });
      step3GuideCollapsedOnce = true;
      safeSessionStorageSet(STEP3_GUIDE_COLLAPSED_SESSION_KEY, '1');
    }

    function updateGuideModeUI() {
      const toggleBtn = document.getElementById('guideToggleBtn');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', guideModeEnabled ? 'true' : 'false');
        toggleBtn.textContent = guideModeEnabled
          ? getLocalizedText('guideToggleOn', 'Guide: On')
          : getLocalizedText('guideToggleOff', 'Guide: Off');
      }

      const card = document.getElementById('noviceGuideCard');
      if (card) card.style.display = guideModeEnabled ? 'flex' : 'none';
      if (!guideModeEnabled) {
        clearRecommendedActions();
      }

      if (stateReady) {
        renderNoviceGuide({ applyStep3Collapse: true });
      }
    }

    function isGrayPointGuideAvailable() {
      if (!stateReady) return false;
      return state.currentStep >= 3
        && usesSilverCoreConversion(state)
        && sanitizePresetType(state.filmType || 'color') !== 'bw';
    }

    function setFrontierGuidePopupVisible(visible) {
      const overlay = document.getElementById('frontierGuidePopupOverlay');
      if (!overlay) return;
      overlay.classList.toggle('visible', Boolean(visible));
      overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    function closeFrontierGuidePopup() {
      setFrontierGuidePopupVisible(false);
    }

    function maybeShowFrontierGuidePopup() {
      if (!frontierGuidePopupPending) return;
      frontierGuidePopupPending = false;
      if (frontierGuidePopupShownThisSession) return;
      frontierGuidePopupShownThisSession = true;
      safeSessionStorageSet(FRONTIER_GUIDE_POPUP_SESSION_KEY, '1');
      setFrontierGuidePopupVisible(true);
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

      if (guideCard) {
        guideCard.classList.toggle('is-active', isActive);
      }
      if (guideTitle) {
        guideTitle.textContent = getLocalizedText(
          isActive ? 'grayPointGuideActiveTitle' : 'grayPointGuideTitle',
          'Find a neutral gray point'
        );
      }
      if (guideBody) {
        guideBody.textContent = getLocalizedText(
          isActive ? 'grayPointGuideActiveBody' : 'grayPointGuideBody',
          'Sample a neutral gray area to refine white balance.'
        );
      }
      if (guideHint) {
        guideHint.textContent = getLocalizedText(
          isActive ? 'grayPointGuideActiveHint' : 'grayPointGuideHint',
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
    }

    function resetFrontierGuideImageState() {
      state.frontierGuideAutoAppliedForImage = false;
      state.frontierGuideStep2ChoiceTouched = false;
      frontierGuidePopupPending = false;
    }

    function startWhiteBalanceSampling() {
      if (!state.processedImageData) return;
      exitBeforeAfter();
      state.samplingMode = 'whiteBalance';
      updateSamplingModeUI();
      updateBeforeAfterButtonState();
    }

    async function maybeApplyFrontierGuideDefaults() {
      if (!stateReady) return false;
      if (state.currentStep >= 3) return false;
      if (!usesSilverCoreConversion(state)) return false;
      if (sanitizePresetType(state.filmType || 'color') !== 'color') return false;
      if (state.frontierGuideAutoAppliedForImage) return false;
      if (state.frontierGuideStep2ChoiceTouched) return false;
      if (state.coreColorModel !== 'standard' || state.coreFilmPreset !== 'none') return false;

      state.coreColorModel = 'frontier';
      await applyFilmPresetSettingsToState('frontier-lab');
      state.frontierGuideAutoAppliedForImage = true;
      markCurrentFileDirty();
      frontierGuidePopupPending = !frontierGuidePopupShownThisSession;
      return true;
    }

    function setGuideModeEnabled(enabled, options = {}) {
      const { persist = true } = options;
      guideModeEnabled = Boolean(enabled);
      if (persist) safeStorageSet(GUIDE_MODE_STORAGE_KEY, guideModeEnabled ? '1' : '0');
      updateGuideModeUI();
    }

    guideModeEnabled = safeStorageGet(GUIDE_MODE_STORAGE_KEY) !== '0';
    step3GuideCollapsedOnce = safeSessionStorageGet(STEP3_GUIDE_COLLAPSED_SESSION_KEY) === '1';
    frontierGuidePopupShownThisSession = safeSessionStorageGet(FRONTIER_GUIDE_POPUP_SESSION_KEY) === '1';
    const guideToggleBtn = document.getElementById('guideToggleBtn');
    if (guideToggleBtn) {
      guideToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setGuideModeEnabled(!guideModeEnabled);
      });
    }
    updateGuideModeUI();

    document.getElementById('headerGrayPointBtn')?.addEventListener('click', () => {
      startWhiteBalanceSampling();
    });

    document.getElementById('frontierGuidePopupCloseBtn')?.addEventListener('click', () => {
      closeFrontierGuidePopup();
    });

    document.getElementById('frontierGuidePopupOverlay')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeFrontierGuidePopup();
      }
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
        script.onerror = () => reject(new Error(`failed to load ${url}`));
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

          let r = sampleImageChannelBilinear(data, width, height, rX, rY, 0);
          let g = sampleImageChannelBilinear(data, width, height, gX, gY, 1);
          let b = sampleImageChannelBilinear(data, width, height, bX, bY, 2);

          if (vignetting) {
            const gains = sampleGridTriple(vignetting, gridWidth, x0, x1, y0, y1, fx, fy);
            r *= gains.r;
            g *= gains.g;
            b *= gains.b;
          }

          const outIdx = (y * width + x) * 4;
          outData[outIdx] = clampBetween(Math.round(r), 0, 255);
          outData[outIdx + 1] = clampBetween(Math.round(g), 0, 255);
          outData[outIdx + 2] = clampBetween(Math.round(b), 0, 255);
          outData[outIdx + 3] = 255;
        }
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

    async function openDownloadPageForUpdate() {
      const url = buildDesktopUpdateDownloadUrl();
      if (isTauriDesktop()) {
        try {
          await window.__TAURI__.core.invoke('open_external_url', { url });
          return;
        } catch (err) {
          console.warn('Desktop open_external_url failed, falling back to window.open:', err);
        }
      }
      window.open(url, '_blank', 'noopener');
    }

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

    function initDesktopUpdateCheck() {
      const actionBtn = document.getElementById('desktopUpdateActionBtn');
      const laterBtn = document.getElementById('desktopUpdateLaterBtn');
      if (actionBtn) {
        actionBtn.addEventListener('click', () => {
          openDownloadPageForUpdate().catch((err) => {
            console.warn('Failed to open download page:', err);
          });
        });
      }
      if (laterBtn) {
        laterBtn.addEventListener('click', () => {
          hideDesktopUpdateBanner();
        });
      }
      checkDesktopUpdate().catch((err) => {
        console.info('Desktop update check failed:', err);
      });
    }

    function initPrivacyBannerToggle() {
      const banner = document.querySelector('.privacy-banner');
      const toggle = document.getElementById('privacyBannerToggle');
      if (!banner || !toggle) return;

      const collapsed = safeStorageGet(PRIVACY_BANNER_COLLAPSED_STORAGE_KEY) === '1';
      banner.classList.toggle('collapsed', collapsed);

      toggle.addEventListener('click', () => {
        banner.classList.add('collapsed');
        safeStorageSet(PRIVACY_BANNER_COLLAPSED_STORAGE_KEY, '1');
      });
    }

    initPrivacyBannerToggle();
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
          includeTca: sourceModes.includeTca !== false,
          includeVignetting: sourceModes.includeVignetting !== false
        },
        lastError: String(source.lastError || fallbackValue.lastError || '').slice(0, 300)
      };
    }

    // ===========================================
    // Application State
    // ===========================================
    const state = {
      // Workflow state
      currentStep: 1,  // 1=crop, 2=film base, 3=adjust

      // Image data
      loadedBaseImageData: null,    // File-loaded baseline (never transformed)
      originalImageData: null,      // Current working base image (may include rotation)
      croppedImageData: null,       // After cropping (still negative)
      processedImageData: null,     // After negative conversion
      displayImageData: null,       // After all adjustments
      conversionSourceImageData: null, // Lens-corrected source used for core conversion rerender
      conversionPreviewImageData: null, // Downscaled conversionSourceImageData for preview-resolution SilverCore
      previewSourceImageData: null, // Downscaled source for preview renders
      histogramSourceImageData: null, // Further downscaled source for histogram updates
      webglSourceImageData: null,   // Downscaled source for WebGL preview renders

      // 16-bit pipeline (Stage 2+) — full-precision counterparts to the 8-bit fields above.
      // Shape: { width, height, data: Uint16Array }, RGBA, range [0, 65535].
      // SilverCore Engine consumes Image16 starting in Stage 3; until then these are dormant.
      original16: null,
      cropped16: null,
      processed16: null,

      // Film settings
      filmType: 'color',
      filmBase: { r: 210, g: 140, b: 90 },
      filmBaseSet: false,
      grayPointSampled: false,
      step2Mode: 'border', // 'border' | 'noBorder'
      frontierGuideAutoAppliedForImage: false,
      frontierGuideStep2ChoiceTouched: false,
      lensCorrection: createInitialLensCorrectionState(),
      rawMetadata: null,

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
      coreSaturation: 100,
      coreGlow: 0,
      coreFade: 0,
      coreCurvePrecision: 'auto',
      coreUseWebGL: true,

      // White balance multipliers
      wbR: 1.0,
      wbG: 1.0,
      wbB: 1.0,

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
        marginRatio: 0.02,
        minConfidence: 0.55,
        highConfidence: 0.72,
        autoApplyHighConfidence: true,
        formatPreference: 'auto', // 'auto' | '135' | '120'
        allowed120Formats: {
          '6x4.5': true,
          '6x6': true,
          '6x7': true,
          '6x9': true
        },
        lowConfidenceBehavior: 'suggest', // 'suggest' | 'rotateOnly' | 'ignore'
        lastDiagnostics: null
      },

      // Batch mode state
      batchMode: false,
      batchSessionActive: false,
      // fileQueue item: {id, file, selected, status, error, settings: null | {...}, isDirty: boolean}
      // settings = null means use auto-detect for film base
      fileQueue: [],
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

      // Dust removal
      dustRemoval: {
        enabled: false,
        strength: 3,
        mask: null,          // Uint8Array (h*w)
        showMask: false,
        processing: false,
        particleCount: 0,
        _state: null,        // Internal state for updateDustStrength
        inpaintedImageData: null, // ImageData after inpainting
        brushSize: 5,
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
    updateGuideModeUI();
    updateGrayPointGuideUI();

    let fullResolutionRenderTimer = null;

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
    // Toast Notification System
    // ===========================================
    function showToast(message, durationMs = 2000) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = 'toast-message';
      el.textContent = message;
      container.appendChild(el);
      requestAnimationFrame(() => el.classList.add('toast-visible'));
      setTimeout(() => {
        el.classList.remove('toast-visible');
        el.addEventListener('transitionend', () => el.remove(), { once: true });
      }, durationMs);
    }

    function interpolateText(template, replacements = {}) {
      let text = String(template || '');
      for (const [key, value] of Object.entries(replacements)) {
        text = text.replaceAll(`{${key}}`, String(value ?? ''));
      }
      return text;
    }

    function getInterpolatedText(key, replacements = {}, fallback = '') {
      return interpolateText(getLocalizedText(key, fallback), replacements);
    }

    function summarizePathForUi(path) {
      const normalized = String(path || '').replace(/[\\/]+$/, '');
      if (!normalized) return '';
      const parts = normalized.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : normalized;
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

      label.textContent = getInterpolatedText(
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
        'newImageBtn',
        'startOverBtn',
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
      browserSuccessKey,
      browserSuccessFallback,
      toastDurationMs = 3500
    } = {}) {
      if (!result || !result.saved) {
        showToast(getLocalizedText(cancelledKey, cancelledFallback), toastDurationMs);
        return false;
      }

      if (result.path && savedPathKey) {
        alert(getInterpolatedText(savedPathKey, { path: result.path }, savedPathFallback));
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
        dustStrength: '除尘灵敏度', dustBrushSize: '笔刷大小',
      },
      en: {
        rotation: 'Rotation', mirror: 'Mirror', crop: 'Crop', filmType: 'Film Type',
        curveEdit: 'Curve Edit', curvePointDelete: 'Delete Curve Point', curvePreset: 'Curve Preset',
        curveReset: 'Reset Curves', dustBrushStroke: 'Dust Brush', dustToggle: 'Dust Toggle',
        filmBase: 'Film Base', whiteBalance: 'White Balance', autoDetectBase: 'Auto Detect Base',
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
        dustStrength: 'Dust Sensitivity', dustBrushSize: 'Brush Size',
      },
      ja: {
        rotation: '回転', mirror: 'ミラー', crop: 'トリミング', filmType: 'フィルムタイプ',
        curveEdit: 'カーブ編集', curvePointDelete: 'カーブポイント削除', curvePreset: 'カーブプリセット',
        curveReset: 'カーブリセット', dustBrushStroke: '除塵ブラシ', dustToggle: '除塵切替',
        filmBase: 'フィルムベース', whiteBalance: 'ホワイトバランス', autoDetectBase: '自動検出',
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
        dustStrength: '除塵感度', dustBrushSize: 'ブラシサイズ',
      }
    };

    function getUndoLabel(label) {
      const map = undoLabelMap[currentLang] || undoLabelMap.en;
      return map[label] || label;
    }

    // Snapshot keys for Category A (lightweight, deep-copied)
    const SNAPSHOT_SCALAR_KEYS = [
      'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
      'vibrance', 'saturation', 'cyan', 'magenta', 'yellow',
      'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
      'corePreSaturation', 'coreBorderBuffer', 'coreBorderBufferBorderValue',
      'coreBrightness', 'coreExposure', 'coreContrast', 'coreHighlights', 'coreShadows',
      'coreWhites', 'coreBlacks', 'coreWbMode', 'coreTemperature', 'coreTint',
      'coreSaturation', 'coreGlow', 'coreFade', 'coreCurvePrecision', 'coreUseWebGL',
      'wbR', 'wbG', 'wbB', 'filmType', 'filmBaseSet', 'grayPointSampled', 'step2Mode', 'rotationAngle',
      'sprocketPreviewEnabled', 'currentStep',
    ];

    // Category B: heavy image data (stored by reference)
    const SNAPSHOT_REF_KEYS = [
      'originalImageData', 'croppedImageData', 'processedImageData',
      'conversionSourceImageData', 'conversionPreviewImageData', 'previewSourceImageData',
      'histogramSourceImageData', 'webglSourceImageData',
    ];

    function captureSnapshot(label) {
      const settings = {};
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        settings[key] = state[key];
      }
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
        brushSize: state.dustRemoval.brushSize,
        showMask: state.dustRemoval.showMask,
      };
      settings.sprocketEdge = createSprocketEdgeSettings(state.sprocketEdge);

      // Category B: references
      const refs = {};
      for (const key of SNAPSHOT_REF_KEYS) {
        refs[key] = state[key];
      }
      // Dust refs
      refs.dustMask = state.dustRemoval.mask;
      refs.dustInpaintedImageData = state.dustRemoval.inpaintedImageData;
      refs.dustCleanSource = state.dustRemoval.cleanSource || null;
      refs.dustState = state.dustRemoval._state;

      return { label, settings, refs };
    }

    function cancelPendingTimers() {
      if (fullUpdateTimer) { clearTimeout(fullUpdateTimer); fullUpdateTimer = null; }
      if (coreReprocessTimer) { clearTimeout(coreReprocessTimer); coreReprocessTimer = null; }
      if (step2AutoConvertTimer) { clearTimeout(step2AutoConvertTimer); step2AutoConvertTimer = null; }
      if (dustDetectionTimer) { clearTimeout(dustDetectionTimer); dustDetectionTimer = null; }
    }

    function restoreSnapshot(snapshot) {
      cancelPendingTimers();

      // Restore Category A
      const s = snapshot.settings;
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        state[key] = s[key];
      }
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
      state.dustRemoval.brushSize = s.dustRemoval.brushSize;
      state.dustRemoval.showMask = s.dustRemoval.showMask;
      state.sprocketEdge = createSprocketEdgeSettings(s.sprocketEdge);

      // Restore Category B refs
      const r = snapshot.refs;
      for (const key of SNAPSHOT_REF_KEYS) {
        state[key] = r[key];
      }
      state.dustRemoval.mask = r.dustMask;
      state.dustRemoval.inpaintedImageData = r.dustInpaintedImageData;
      state.dustRemoval.cleanSource = r.dustCleanSource;
      state.dustRemoval._state = r.dustState;

      // Sync UI
      updateSlidersFromState();
      renderCurve();
      updateDustControlsVisibility();
      updateSprocketControlsUI();

      // Re-render
      if (state.processedImageData) {
        applyProcessedImageToState(state.processedImageData);
        if (usesSilverCoreConversion(state)) {
          rerenderWithCoreControls({ full: true }).catch(() => {});
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
    }

    function pushUndo(label) {
      undoStack.push(captureSnapshot(label));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
      updateUndoRedoButtons();
    }

    function performUndo() {
      if (undoStack.length === 0) {
        showToast(getLocalizedText('nothingToUndo', 'Nothing to undo'));
        return;
      }
      redoStack.push(captureSnapshot('redo'));
      const snapshot = undoStack.pop();
      restoreSnapshot(snapshot);
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('undone', 'Undone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
    }

    function performRedo() {
      if (redoStack.length === 0) {
        showToast(getLocalizedText('nothingToRedo', 'Nothing to redo'));
        return;
      }
      undoStack.push(captureSnapshot('undo'));
      const snapshot = redoStack.pop();
      restoreSnapshot(snapshot);
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('redone', 'Redone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
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

    let transformCanvas = document.createElement('canvas');
    let transformCtx = transformCanvas.getContext('2d');

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
        `fileList setCalls=${debugUI.fileListSetCalls}`;
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
      renderNoviceGuide({ applyStep3Collapse: false });
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
      return state.fileQueue[state.currentFileIndex];
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

      [1, 2, 3].forEach((stage) => {
        const stageEl = document.getElementById('panelStage' + stage);
        if (!stageEl) return;
        stageEl.classList.remove('active', 'completed');
        stageEl.removeAttribute('aria-current');
        if (stage < state.currentStep) {
          stageEl.classList.add('completed');
        } else if (stage === state.currentStep) {
          stageEl.classList.add('active');
          stageEl.setAttribute('aria-current', 'step');
        }
      });

      // Update badge
      badge.className = 'status-badge step' + state.currentStep;
      badge.setAttribute('data-i18n', 'step' + state.currentStep);
      badge.textContent = i18n[currentLang]['step' + state.currentStep];

      // Show/hide sections based on step
      document.getElementById('autoFrameSettingsSection').style.display =
        state.currentStep === 1 ? 'block' : 'none';
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
      renderNoviceGuide({ applyStep3Collapse: true });
    }

    function updateStep3SectionVisibility() {
      const inStep3 = state.currentStep >= 3;
      const showCore = inStep3 && usesSilverCoreConversion(state);
      const dustSection = document.getElementById('dustRemovalSection');
      if (dustSection) dustSection.style.display = inStep3 ? 'block' : 'none';

      ['whiteBalanceSection', 'toneSection', 'colorSection', 'cmySection', 'advancedSection'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = showCore ? 'block' : 'none';
      });

      const additional = document.getElementById('additionalSection');
      if (additional) {
        additional.style.display = inStep3 ? 'block' : 'none';
      }

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
      if (state.cropping || state.samplingMode) return false;
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
        glCanvas.style.display = 'none';
        canvas.style.display = 'block';
        updateFullCpu();
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
        sprocketSettingsSection.style.display = (
          state.originalImageData || state.croppedImageData || state.processedImageData
        ) ? 'block' : 'none';
      }
      syncSprocketEdgeSettingsUI();
    }

    function getSprocketFrameComposeOptions() {
      return {
        edgeMarkings: state.sprocketEdge
      };
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

    function renderAdjustedImageDataToMainCanvas(imageData, fullSizeReference = imageData, options = {}) {
      if (state.sprocketPreviewEnabled && !state.cropping) {
        const composeOptions = getSprocketFrameComposeOptions();
        if (options.fastSprocketPreview && renderFastSprocketPreview(imageData, fullSizeReference, composeOptions)) {
          return;
        }
        const framed = composeSprocketFrame(imageData, composeOptions);
        setMainCanvasDimensions(framed.width, framed.height);
        drawImageDataToMainCanvas(framed, framed.width, framed.height);
        return;
      }

      setMainCanvasDimensions(fullSizeReference.width, fullSizeReference.height);
      drawImageDataToMainCanvas(imageData, fullSizeReference.width, fullSizeReference.height);
    }

    function syncTransformCanvasFromMainCanvas() {
      transformCanvas.width = canvas.width;
      transformCanvas.height = canvas.height;
      transformCtx.clearRect(0, 0, transformCanvas.width, transformCanvas.height);
      transformCtx.drawImage(canvas, 0, 0);
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

    function autoDetectFilmBase(imageData, borderBufferPct = 10) {
      return detectFilmBaseAutomatically(imageData, borderBufferPct);
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

      const safe = {
        cropRegion: source.cropRegion ? { ...source.cropRegion } : (fallbackSettings.cropRegion ? { ...fallbackSettings.cropRegion } : null),
        rotationAngle: normalizeAngleDegrees(sanitizeNumeric(source.rotationAngle, fallbackSettings.rotationAngle || 0, -3600, 3600)),
        autoFrameMeta: source.autoFrameMeta ? { ...source.autoFrameMeta } : (fallbackSettings.autoFrameMeta ? { ...fallbackSettings.autoFrameMeta } : null),
        filmType,
        filmBase: sanitizeFilmBase(source.filmBase, fallbackSettings.filmBase),
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
        brightness: safe.coreBrightness,
        exposure: safe.coreExposure,
        contrast: safe.coreContrast,
        highlights: safe.coreHighlights,
        shadows: safe.coreShadows,
        whites: safe.coreWhites,
        blacks: safe.coreBlacks,
        wbMode: safe.coreWbMode,
        temperature: safe.coreTemperature,
        tint: safe.coreTint,
        saturation: safe.coreSaturation,
        glow: safe.coreGlow,
        fade: safe.coreFade,
        curvePrecision: safe.coreCurvePrecision,
        useWebGL: safe.coreUseWebGL
      };
    }

    function buildRouterSettings(settings = state) {
      return usesSilverCoreConversion(settings)
        ? buildCoreConversionSettings(settings)
        : settings;
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

    function applyAdjustmentsToBuffer(imageData, settings, output, quality = 'full') {
      applyPreparedAdjustmentsToBuffer(imageData, buildAdjustmentSettings(settings), output, {
        quality,
        lutScratch: adjustmentLutScratch
      });
    }

    function buildPreviewSourceImageData(imageData) {
      // Keep interactive preview responsive on slower machines.
      return downsampleImageDataForMaxPixels(imageData, 250_000);
    }

    function buildHistogramSourceImageData(imageData) {
      return downsampleImageDataForMaxPixels(imageData, HISTOGRAM_MAX_SAMPLES);
    }

    function buildWebglSourceImageData(imageData, maxDim = 2048) {
      return downsampleImageDataForMaxDim(imageData, maxDim);
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

    // Monotonic cubic spline interpolation
    function computeSpline(points) {
      const n = points.length;
      if (n < 2) return (x) => x;

      // Sort points by x
      points = [...points].sort((a, b) => a.x - b.x);

      const xs = points.map(p => p.x);
      const ys = points.map(p => p.y);

      // Calculate slopes
      const dxs = [], dys = [], ms = [];
      for (let i = 0; i < n - 1; i++) {
        dxs.push(xs[i + 1] - xs[i]);
        dys.push(ys[i + 1] - ys[i]);
        ms.push(dys[i] / dxs[i]);
      }

      // Calculate degree-1 coefficients
      const c1s = [ms[0]];
      for (let i = 0; i < dxs.length - 1; i++) {
        const m = ms[i], mNext = ms[i + 1];
        if (m * mNext <= 0) {
          c1s.push(0);
        } else {
          const dx = dxs[i], dxNext = dxs[i + 1], common = dx + dxNext;
          c1s.push(3 * common / ((common + dxNext) / m + (common + dx) / mNext));
        }
      }
      c1s.push(ms[ms.length - 1]);

      // Calculate degree-2 and degree-3 coefficients
      const c2s = [], c3s = [];
      for (let i = 0; i < c1s.length - 1; i++) {
        const c1 = c1s[i], m = ms[i], invDx = 1 / dxs[i], common = c1 + c1s[i + 1] - 2 * m;
        c2s.push((m - c1 - common) * invDx);
        c3s.push(common * invDx * invDx);
      }

      // Return interpolation function
      return function(x) {
        let i = xs.length - 1;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];

        // Binary search
        let low = 0, high = c3s.length - 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (xs[mid] < x) low = mid + 1;
          else high = mid - 1;
        }
        i = Math.max(0, high);

        const diff = x - xs[i];
        return ys[i] + c1s[i] * diff + c2s[i] * diff * diff + c3s[i] * diff * diff * diff;
      };
    }

    // Update the 256-value curve from control points
    function updateCurveFromPoints(channel) {
      const points = state.curvePoints[channel];
      const curve = state.curves[channel];
      const spline = computeSpline(points);

      for (let i = 0; i < 256; i++) {
        curve[i] = Math.max(0, Math.min(255, Math.round(spline(i))));
      }

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
      let points;
      switch (preset) {
        case 'linear':
          points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
          break;
        case 'scurve':
          points = [{ x: 0, y: 0 }, { x: 64, y: 48 }, { x: 192, y: 208 }, { x: 255, y: 255 }];
          break;
        case 'log':
          points = [{ x: 0, y: 0 }, { x: 64, y: 128 }, { x: 128, y: 192 }, { x: 255, y: 255 }];
          break;
        default:
          points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      }
      state.curvePoints[currentCurveChannel] = points;
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
      const points = state.curvePoints[currentCurveChannel];
      const cw = curveCanvas.width;
      const ch = curveCanvas.height;

      for (let i = 0; i < points.length; i++) {
        const px = (points[i].x / 255) * cw;
        const py = ch - (points[i].y / 255) * ch;
        const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
        if (dist < threshold) return i;
      }
      return -1;
    }

    let curvePreUndoSnapshot = null;

    curveCanvas.addEventListener('mousedown', (e) => {
      curvePreUndoSnapshot = captureSnapshot('curveEdit');
      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        // Start dragging existing point
        draggingPoint = nearPoint;
      } else {
        // Add new point
        const points = state.curvePoints[currentCurveChannel];
        const newPoint = { x: pos.x, y: pos.y };

        // Insert in sorted order
        let insertIndex = points.findIndex(p => p.x > pos.x);
        if (insertIndex === -1) insertIndex = points.length;
        points.splice(insertIndex, 0, newPoint);

        draggingPoint = insertIndex;
        updateCurveFromPoints(currentCurveChannel);
        markCurrentFileDirty();
      }
      renderCurve();
    });

    curveCanvas.addEventListener('mousemove', (e) => {
      const pos = getCurvePosition(e);

      if (draggingPoint !== null) {
        const points = state.curvePoints[currentCurveChannel];
        const point = points[draggingPoint];

        // Endpoints can only move vertically
        if (draggingPoint === 0) {
          point.y = pos.y;
        } else if (draggingPoint === points.length - 1) {
          point.y = pos.y;
        } else {
          // Middle points: constrain x between neighbors
          const prevX = points[draggingPoint - 1].x + 1;
          const nextX = points[draggingPoint + 1].x - 1;
          point.x = Math.max(prevX, Math.min(nextX, pos.x));
          point.y = pos.y;
        }

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
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
    });

    curveCanvas.addEventListener('mouseleave', () => {
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
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
      curvePreUndoSnapshot = captureSnapshot('curveEdit');

      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        draggingPoint = nearPoint;
      } else {
        const points = state.curvePoints[currentCurveChannel];
        const newPoint = { x: pos.x, y: pos.y };
        let insertIndex = points.findIndex(p => p.x > pos.x);
        if (insertIndex === -1) insertIndex = points.length;
        points.splice(insertIndex, 0, newPoint);
        draggingPoint = insertIndex;
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

      const pos = getCurvePosition(e);
      const points = state.curvePoints[currentCurveChannel];
      const point = points[draggingPoint];

      if (draggingPoint === 0 || draggingPoint === points.length - 1) {
        point.y = pos.y;
      } else {
        const prevX = points[draggingPoint - 1].x + 1;
        const nextX = points[draggingPoint + 1].x - 1;
        point.x = Math.max(prevX, Math.min(nextX, pos.x));
        point.y = pos.y;
      }

      updateCurveFromPoints(currentCurveChannel);
      renderCurve();
      markCurrentFileDirty();
      schedulePreviewUpdate();
    }, { passive: false });

    function finishCurvePointerDrag(pointerId) {
      if (activeCurvePointerId !== pointerId) return;
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
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
      }
    };

    const webglCurveRgba = new Uint8Array(256 * 4);

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

      if (!gl) return false;

      const vsSource = `
        attribute vec2 a_pos;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_pos + 1.0) * 0.5;
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

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      webglState.curveDirty = true;
      webglState.sourceDirty = true;
      webglState.lastError = null;

      return true;
    }

    function isWebGLActive() {
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;
      if (state.sprocketPreviewEnabled) return false;
      return !!webglState.gl && !webglState.disabledByError && state.currentStep >= 3 && !!state.processedImageData;
    }

    function resizeWebGLCanvas() {
      if (!webglState.gl) return;
      // Use pre-transform CSS dimensions to avoid bloating the buffer when zoomed
      const cssW = parseFloat(glCanvas.style.width) || 0;
      const cssH = parseFloat(glCanvas.style.height) || 0;
      if (cssW <= 0 || cssH <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      let targetW = Math.max(1, Math.round(cssW * dpr));
      let targetH = Math.max(1, Math.round(cssH * dpr));

      // Limit interactive draw resolution to keep things smooth on very large displays.
      const maxDim = 2048;
      const maxCurrent = Math.max(targetW, targetH);
      if (maxCurrent > maxDim) {
        const scale = maxDim / maxCurrent;
        targetW = Math.max(1, Math.floor(targetW * scale));
        targetH = Math.max(1, Math.floor(targetH * scale));
      }

      if (glCanvas.width !== targetW) glCanvas.width = targetW;
      if (glCanvas.height !== targetH) glCanvas.height = targetH;
    }

    function getWebglSourceImageData() {
      const full = state.processedImageData;
      if (!full) return null;

      const maxTex = webglState.maxTextureSize || 0;
      const targetMaxDim = Math.min(2048, maxTex || 2048);

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
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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
      webglState.sourceSize.w = imageData.width;
      webglState.sourceSize.h = imageData.height;
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
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
      const safe = sanitizeSettings(state, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });

      const useLegacyTone = !usesSilverCoreConversion(safe);

      const legacyExposure = useLegacyTone ? safe.exposure : 0;
      const legacyContrast = useLegacyTone ? safe.contrast : 0;
      const legacyHighlights = useLegacyTone ? safe.highlights : 0;
      const legacyShadows = useLegacyTone ? safe.shadows : 0;
      const legacyTemperature = useLegacyTone ? safe.temperature : 0;
      const legacyTint = useLegacyTone ? safe.tint : 0;
      const legacySaturation = useLegacyTone ? safe.saturation : 0;

      const exposure = legacyExposure;
      const contrast = 1 + (legacyContrast / 100);
      const highlights = legacyHighlights / 100;
      const shadows = legacyShadows / 100;
      const tempFactor = legacyTemperature / 100;
      const tintFactor = legacyTint / 100;
      const satFactor = 1 + (legacySaturation / 100);
      const vibFactor = safe.vibrance / 100;

      gl.uniform3f(webglState.locations.uWb, safe.wbR, safe.wbG, safe.wbB);
      gl.uniform1f(webglState.locations.uExposure, exposure);
      gl.uniform1f(webglState.locations.uContrast, contrast);
      gl.uniform1f(webglState.locations.uHighlights, highlights);
      gl.uniform1f(webglState.locations.uShadows, shadows);
      gl.uniform1f(webglState.locations.uTemp, tempFactor);
      gl.uniform1f(webglState.locations.uTint, tintFactor);
      gl.uniform1f(webglState.locations.uSat, satFactor);
      gl.uniform1f(webglState.locations.uVib, vibFactor);
      gl.uniform3f(webglState.locations.uCmy, safe.cyan / 100, safe.magenta / 100, safe.yellow / 100);
    }

    function renderWebGL() {
      if (!webglState.gl || webglState.disabledByError || !state.processedImageData) return false;

      try {
        const source = getWebglSourceImageData();
        if (!source) return false;
        adjustCanvasDisplay(source.width, source.height);
        resizeWebGLCanvas();

        const gl = webglState.gl;
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
        gl.useProgram(webglState.program);

        // Uploads if needed
        if (webglState.sourceDirty || webglState.sourceSize.w !== source.width || webglState.sourceSize.h !== source.height) {
          webglUploadSource(source);
        }
        if (webglState.curveDirty) {
          webglUploadCurves();
        }

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
        const errCode = gl.getError();
        if (errCode !== gl.NO_ERROR) {
          throw new Error(`WebGL draw error code: ${errCode}`);
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

    const previewCanvas = document.createElement('canvas');
    const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
    let fullAdjustedBuffer = null;
    let previewAdjustedBuffer = null;
    let histogramAdjustedBuffer = null;
    let lastHistogramUpdateTime = 0;

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
        if (state.dustRemoval.enabled && state.dustRemoval.cleanSource) {
          updateFull();
          return;
        }
        // If SilverCore mode and we were using preview-resolution, run full reprocess
        if (usesSilverCoreConversion(state) && state.conversionSourceImageData
          && state.conversionPreviewImageData && state.conversionPreviewImageData !== state.conversionSourceImageData) {
          scheduleFullResolutionRender('scheduleFullUpdate');
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
      if (state.beforeAfterActive) return;

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
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
      if (!state.processedImageData) return;

      const source = state.previewSourceImageData || state.processedImageData;
      previewAdjustedBuffer = ensureImageDataBuffer(previewAdjustedBuffer, source.width, source.height);
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
    }

    function updateFull() {
      if (!state.processedImageData) return;
      if (state.beforeAfterActive) return;

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
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
      if (!state.processedImageData) return;

      const source = state.processedImageData;
      fullAdjustedBuffer = ensureImageDataBuffer(fullAdjustedBuffer, source.width, source.height);
      applyAdjustmentsToBuffer(source, state, fullAdjustedBuffer, 'full');
      state.displayImageData = fullAdjustedBuffer;
      renderAdjustedImageDataToMainCanvas(fullAdjustedBuffer, source);
      renderHistogram(fullAdjustedBuffer);

      syncTransformCanvasFromMainCanvas();
      state.lastRenderQuality = 'full';
      if (state.dustRemoval.showMask && state.dustRemoval.mask) renderDustMaskOverlay();
    }

    function renderFullWebGL() {
      if (!webglState.gl || !state.processedImageData) return false;
      // WebGL only usable for legacy tone path (non-SilverCore)
      if (usesSilverCoreConversion(state)) return false;
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;

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
          syncTransformCanvasFromMainCanvas();
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
      state.processedImageData = processed;
      state.processedImageDataIsPreview = previewOnly;
      if (!previewOnly) {
        state.fullResolutionPending = false;
      }
      state.displayImageData = null;
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.histogramSourceImageData = buildHistogramSourceImageData(state.previewSourceImageData || processed);
      state.webglSourceImageData = buildWebglSourceImageData(processed);
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      if (state.sprocketPreviewEnabled) {
        const frameMetrics = getSprocketFrameMetrics(processed.width, processed.height);
        setMainCanvasDimensions(frameMetrics.outputWidth, frameMetrics.outputHeight);
      } else {
        setMainCanvasDimensions(processed.width, processed.height);
      }
    }

    async function convertFromCurrentSource(settings = state, { preview = false } = {}) {
      const fullSource = state.conversionSourceImageData || state.croppedImageData || state.originalImageData;
      if (!fullSource) return null;
      const source = (preview && state.conversionPreviewImageData) ? state.conversionPreviewImageData : fullSource;
      return await convertFrameWithRouter({
        imageData: source,
        settings: buildRouterSettings(settings),
        options: {
          preview,
          forceFullProcess: !preview
        }
      });
    }

    let coreReprocessTimer = null;
    let coreReprocessToken = 0;
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
      // so that full-resolution export remains correct.
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.webglSourceImageData = buildWebglSourceImageData(processed);
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      const fullW = state.processedImageData ? state.processedImageData.width : processed.width;
      const fullH = state.processedImageData ? state.processedImageData.height : processed.height;
      setMainCanvasDimensions(fullW, fullH);
    }

    let _coreReprocessInFlight = false;
    let _coreReprocessPending = null;

    function resetDustForCleanSource(source) {
      state.dustRemoval.cleanSource = source || null;
      state.dustRemoval._state = null;
      state.dustRemoval.mask = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.particleCount = 0;
    }

    async function rerenderWithCoreControls(options = {}) {
      const full = Boolean(options.full) || Boolean(state.dustRemoval.enabled);
      const token = Number.isInteger(options.token) ? options.token : null;
      const sourceRef = options.sourceRef || null;
      if (!usesSilverCoreConversion(state)) return;
      if (!state.conversionSourceImageData) return;
      if (sourceRef && state.conversionSourceImageData !== sourceRef) return;

      // In-flight guard: if a reprocess is already running, queue the latest request
      if (_coreReprocessInFlight) {
        _coreReprocessPending = options;
        return;
      }
      _coreReprocessInFlight = true;

      try {
        if (full) {
          // Full-resolution path
          const processed = await convertFromCurrentSource(state, { preview: false });
          if (!processed) return;
          if (token !== null && token !== coreReprocessToken) return;
          if (sourceRef && state.conversionSourceImageData !== sourceRef) return;
          applyProcessedImageToState(processed);
          updateFull();
          if (state.dustRemoval.enabled) {
            resetDustForCleanSource(processed);
            scheduleDustDetection();
          }
        } else {
          // Check if preview source is actually smaller than full source
          const hasSmallPreview = state.conversionPreviewImageData
            && state.conversionPreviewImageData !== state.conversionSourceImageData;

          // Preview-resolution path: run SilverCore on small image
          const previewProcessed = await convertFromCurrentSource(state, { preview: hasSmallPreview });
          if (!previewProcessed) return;
          if (token !== null && token !== coreReprocessToken) return;

          if (hasSmallPreview) {
            // Preview source is smaller — update preview display path only
            applyPreviewProcessedImageToState(previewProcessed);
            updatePreview();
            scheduleFullUpdate();
          } else {
            // No downscaled preview (image already small) — treat as full
            applyProcessedImageToState(previewProcessed);
            updatePreview();
            // No need to schedule full update; we already processed at full resolution
          }
        }
      } finally {
        _coreReprocessInFlight = false;
        // If a new request came in while we were processing, run the latest one
        if (_coreReprocessPending) {
          const pending = _coreReprocessPending;
          _coreReprocessPending = null;
          void rerenderWithCoreControls(pending).catch((err) => {
            console.error('Core reprocess (pending) failed:', err);
          });
        }
      }
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
      const trace = createPerfTrace('fullResolutionRender', {
        reason,
        pixels: getImageDataPixelCount(state.conversionSourceImageData)
      });

      const promise = waitForNextFrame()
        .then(() => rerenderWithCoreControls({ full: true, sourceRef, token }))
        .then(() => {
          trace.end({
            outputPixels: getImageDataPixelCount(state.processedImageData),
            previewOnly: Boolean(state.processedImageDataIsPreview)
          });
        })
        .finally(() => {
          if (state.fullResolutionPromise === promise) {
            state.fullResolutionPromise = null;
          }
          state.fullResolutionPending = Boolean(state.processedImageDataIsPreview);
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
      if (!state.processedImageDataIsPreview && !state.fullResolutionPending) return;
      if (fullResolutionRenderTimer) {
        clearTimeout(fullResolutionRenderTimer);
        fullResolutionRenderTimer = null;
      }
      const pending = state.fullResolutionPromise || startFullResolutionRender('export');
      if (pending) await pending;
      if (state.processedImageDataIsPreview) {
        throw new Error('Full-resolution processing is not ready yet. Please wait for the background render to finish.');
      }
    }

    function scheduleCoreReprocess(options = {}) {
      const full = Boolean(options.full);
      if (!usesSilverCoreConversion(state)) return;
      if (!state.conversionSourceImageData || state.currentStep < 3) return;

      const token = ++coreReprocessToken;
      cancelScheduledFullResolutionRender();
      if (coreReprocessTimer) clearTimeout(coreReprocessTimer);
      coreReprocessTimer = setTimeout(() => {
        coreReprocessTimer = null;
        void rerenderWithCoreControls({ full, token }).catch((err) => {
          console.error('Core reprocess failed:', err);
        });
      }, full ? 70 : 80);
    }

    async function processNegative() {
      if (processNegativeInFlight) return processNegativeInFlight;

      processNegativeInFlight = (async () => {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (!sourceData) return;
        const trace = createPerfTrace('processNegative', {
          pixels: getImageDataPixelCount(sourceData)
        });

        const overlay = getLoadingOverlay();
        const lang = i18n[currentLang];
        await overlay.show({ title: lang.loadingConverting });

        try {
          const frontierAutoApplied = await maybeApplyFrontierGuideDefaults();
          if (frontierAutoApplied) {
            updateSlidersFromState();
          }
          overlay.updateProgress(10, lang.loadingConverting);
          const correctedSourceData = await applyLensCorrectionWithSettings(sourceData, state, { updateUi: true });
          trace.mark('lensCorrection', {
            outputPixels: getImageDataPixelCount(correctedSourceData)
          });
          invalidateSilverCoreCache();
          state.conversionSourceImageData = correctedSourceData;
          state.conversionPreviewImageData = buildPreviewSourceImageData(correctedSourceData);
          const hasPreviewSource = usesSilverCoreConversion(state) && hasSeparateConversionPreview();
          overlay.updateProgress(hasPreviewSource ? 35 : 40, lang.loadingConverting);

          const processed = await convertFromCurrentSource(state, { preview: hasPreviewSource });
          if (!processed) return;
          trace.mark(hasPreviewSource ? 'previewConversion' : 'fullConversion', {
            outputPixels: getImageDataPixelCount(processed)
          });
          overlay.updateProgress(hasPreviewSource ? 78 : 85, lang.loadingProcessing);
          applyProcessedImageToState(processed, { previewOnly: hasPreviewSource });
          // Reset dust removal state for new conversion
          state.dustRemoval._state = null;
          state.dustRemoval.mask = null;
          state.dustRemoval.inpaintedImageData = null;
          state.dustRemoval.particleCount = 0;
          state.dustRemoval.cleanSource = null;
          goToStep(3);
          syncBatchUIState({ reason: 'processNegative' });
          revealBatchFileList('processNegative');
          updatePreview();
          if (hasPreviewSource) {
            state.fullResolutionPending = true;
            scheduleFullResolutionRender('initial-preview');
          } else {
            scheduleFullUpdate();
          }
          maybeShowFrontierGuidePopup();
          overlay.updateProgress(100, lang.loadingComplete);
          trace.end({
            previewFirst: hasPreviewSource,
            outputPixels: getImageDataPixelCount(processed)
          });
          await new Promise(r => setTimeout(r, 250));
          // Auto-run dust detection if enabled
          if (state.dustRemoval.enabled && !hasPreviewSource) {
            scheduleDustDetection();
          }
        } finally {
          overlay.hide();
        }
      })();

      try {
        return await processNegativeInFlight;
      } finally {
        processNegativeInFlight = null;
      }
    }

    // ===========================================
    // Dust Removal Pipeline
    // ===========================================
    let dustDetectionTimer = null;
    let dustDrawing = false;
    let dustBrushMode = 'intelligent';

    function getDustSource() {
      return state.dustRemoval.cleanSource || state.processedImageData;
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

    async function runDustDetection() {
      const source = getDustSource();
      if (!source) return;
      if (state.dustRemoval.processing) return;

      state.dustRemoval.processing = true;
      updateDustStatusUI(getLocalizedText('dustStatusProcessing', 'Processing...'));

      await ensureOpenCvReady();

      // Use a short timeout to let the UI update
      await new Promise(r => setTimeout(r, 10));

      try {
        // Save original source before inpainting overwrites processedImageData
        if (!state.dustRemoval.cleanSource) {
          state.dustRemoval.cleanSource = source;
        }

        const prevState = state.dustRemoval._state;
        const { mask, particleCount, _state } = prevState
          ? updateDustStrength(source, prevState, state.dustRemoval.strength)
          : detectDust(source, { strength: state.dustRemoval.strength });
        state.dustRemoval.mask = mask;
        state.dustRemoval.particleCount = particleCount;
        state.dustRemoval._state = _state;

        if (particleCount > 0) {
          const inpainted = inpaintMasked(source, mask, 3);
          state.dustRemoval.inpaintedImageData = inpainted;
          const tmpl = getLocalizedText('dustStatusDone', 'Detected {count} dust particles');
          updateDustStatusUI(tmpl.replace('{count}', String(particleCount)));
        } else {
          state.dustRemoval.inpaintedImageData = null;
          updateDustStatusUI(getLocalizedText('dustStatusNone', 'No dust detected'));
        }
      } catch (err) {
        console.error('Dust detection failed:', err);
        state.dustRemoval.mask = null;
        state.dustRemoval.inpaintedImageData = null;
        updateDustStatusUI('Error: ' + (err.message || err));
      } finally {
        state.dustRemoval.processing = false;
      }

      // Refresh display to show inpainted result
      cancelFullUpdate();
      applyDustResultToState();
      updatePreview();
    }

    function applyDustResultToState() {
      if (!state.dustRemoval.enabled) return;
      const nextImage = state.dustRemoval.inpaintedImageData || state.dustRemoval.cleanSource;
      if (!nextImage) return;
      applyProcessedImageToState(nextImage);
    }

    function scheduleDustDetection() {
      if (dustDetectionTimer) clearTimeout(dustDetectionTimer);
      dustDetectionTimer = setTimeout(() => {
        dustDetectionTimer = null;
        void runDustDetection();
      }, 300);
    }

    function clearDustState() {
      state.dustRemoval.mask = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.particleCount = 0;
      state.dustRemoval._state = null;
      state.dustRemoval.cleanSource = null;
      updateDustStatusUI(getLocalizedText('dustStatusIdle', 'Ready'));
    }

    function renderDustMaskOverlay() {
      if (!state.dustRemoval.showMask || !state.dustRemoval.mask || !state.processedImageData) return;

      const { width, height } = state.processedImageData;
      const mask = state.dustRemoval.mask;

      // Draw red semi-transparent overlay on the canvas for masked areas
      const overlayData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const scaleX = width / canvas.width;
      const scaleY = height / canvas.height;

      for (let cy = 0; cy < canvas.height; cy++) {
        for (let cx = 0; cx < canvas.width; cx++) {
          const mx = Math.min(width - 1, Math.round(cx * scaleX));
          const my = Math.min(height - 1, Math.round(cy * scaleY));
          if (mask[my * width + mx] > 0) {
            const idx = (cy * canvas.width + cx) * 4;
            // Red overlay at 50% opacity
            overlayData.data[idx] = Math.min(255, overlayData.data[idx] * 0.5 + 255 * 0.5) | 0;
            overlayData.data[idx + 1] = (overlayData.data[idx + 1] * 0.5) | 0;
            overlayData.data[idx + 2] = (overlayData.data[idx + 2] * 0.5) | 0;
          }
        }
      }
      ctx.putImageData(overlayData, 0, 0);
    }

    // ── Dust Removal UI Event Handlers ───────────────────────────────────────

    document.getElementById('dustRemovalEnabled')?.addEventListener('change', function () {
      pushUndo('dustToggle');
      state.dustRemoval.enabled = this.checked;
      updateDustControlsVisibility();

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
        undoStack.push(dustStrengthPreSnapshot);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        dustStrengthPreSnapshot = null;
        updateUndoRedoButtons();
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
      updateDustControlsVisibility();
      updateCanvasVisibility();
      if (state.dustRemoval.showMask) {
        updatePreview();           // render image on 2D canvas first
        requestAnimationFrame(() => renderDustMaskOverlay());
      } else {
        updatePreview();           // restore normal render path (may switch back to WebGL)
      }
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
      clearDustState();
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

    function createBrushMask(points, brushRadius, width, height) {
      const mask = new Uint8Array(width * height);
      const r = brushRadius;

      for (const pt of points) {
        const cx = pt.x, cy = pt.y;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              mask[ny * width + nx] = 255;
            }
          }
        }
      }

      // Also fill lines between consecutive points
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1], p1 = points[i];
        const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
        const steps = Math.max(1, Math.ceil(dist));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const ix = Math.round(p0.x + (p1.x - p0.x) * t);
          const iy = Math.round(p0.y + (p1.y - p0.y) * t);
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy > r * r) continue;
              const nx = ix + dx, ny = iy + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                mask[ny * width + nx] = 255;
              }
            }
          }
        }
      }

      return mask;
    }

    let dustBrushPoints = [];

    function onDustBrushStart(e) {
      if (!state.dustRemoval.enabled || !state.dustRemoval.showMask) return;
      if (!state.dustRemoval.mask || !state.processedImageData) return;
      if (state.samplingMode || state.cropping) return;

      e.preventDefault();
      dustDrawing = true;
      dustBrushPoints = [];

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
        renderDustMaskOverlay();
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

    function onDustBrushEnd(e) {
      if (!dustDrawing) return;
      dustDrawing = false;

      if (dustBrushPoints.length === 0 || !state.processedImageData || !state.dustRemoval.mask) return;
      pushUndo('dustBrushStroke');

      const source = getDustSource();
      if (!source) return;

      const { width, height } = source;
      const brushMask = createBrushMask(dustBrushPoints, state.dustRemoval.brushSize, width, height);

      let newMask;
      if (dustBrushMode === 'intelligent') {
        newMask = refineMaskIntelligent(source, state.dustRemoval.mask, brushMask);
      } else if (dustBrushMode === 'direct') {
        newMask = refineMaskDirect(state.dustRemoval.mask, brushMask);
      } else {
        newMask = refineMaskRemove(state.dustRemoval.mask, brushMask);
      }

      state.dustRemoval.mask = newMask;

      // Re-inpaint with updated mask
      // We need the original pre-inpaint source.
      // Re-convert to get clean source, then re-inpaint
      const cleanSource = state.conversionSourceImageData || state.croppedImageData || state.originalImageData;
      if (cleanSource) {
        convertFromCurrentSource(state, { preview: false }).then(processed => {
          if (!processed) return;
          const inpainted = inpaintMasked(processed, newMask, 3);
          state.dustRemoval.inpaintedImageData = inpainted;

          // Count particles
          const c = window.cv;
          if (c && c.Mat) {
            try {
              const maskMat = new c.Mat(height, width, c.CV_8UC1);
              maskMat.data.set(newMask);
              const contours = new c.MatVector();
              const hierarchy = new c.Mat();
              c.findContours(maskMat, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
              state.dustRemoval.particleCount = contours.size();
              maskMat.delete();
              contours.delete();
              hierarchy.delete();
            } catch (_e) { /* ignore */ }
          }

          const tmpl = getLocalizedText('dustStatusDone', 'Detected {count} dust particles');
          updateDustStatusUI(tmpl.replace('{count}', String(state.dustRemoval.particleCount)));

          applyProcessedImageToState(inpainted);
          updatePreview();
          if (state.dustRemoval.showMask) {
            // Need to re-render after updatePreview finishes
            requestAnimationFrame(() => renderDustMaskOverlay());
          }
        });
      }

      dustBrushPoints = [];
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
    function adjustCanvasDisplay(w, h) {
      const container = document.getElementById('canvasContainer');
      const maxWidth = container.clientWidth - 20;
      const maxHeight = container.clientHeight - 20;
      const scale = Math.min(maxWidth / w, maxHeight / h, 1);
      const cssW = (w * scale) + 'px';
      const cssH = (h * scale) + 'px';
      canvas.style.width = cssW;
      canvas.style.height = cssH;
      glCanvas.style.width = cssW;
      glCanvas.style.height = cssH;
      canvasTransformWrapper.style.width = cssW;
      canvasTransformWrapper.style.height = cssH;
      if (isWebGLActive()) resizeWebGLCanvas();
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
      canvasTransformWrapper.style.transform = `matrix(${z}, 0, 0, ${z}, ${state.panX}, ${state.panY})`;
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
      const wrapperW = parseFloat(canvasTransformWrapper.style.width) || canvasTransformWrapper.offsetWidth || 0;
      const wrapperH = parseFloat(canvasTransformWrapper.style.height) || canvasTransformWrapper.offsetHeight || 0;
      const containerW = canvasContainer.clientWidth;
      const containerH = canvasContainer.clientHeight;
      const baseX = (containerW - wrapperW) / 2;
      const baseY = (containerH - wrapperH) / 2;
      const scaledW = wrapperW * zoom;
      const scaledH = wrapperH * zoom;

      const centeredPanX = ((containerW - scaledW) / 2) - baseX;
      const centeredPanY = ((containerH - scaledH) / 2) - baseY;

      const minPanX = scaledW <= containerW ? centeredPanX : containerW - baseX - scaledW;
      const maxPanX = scaledW <= containerW ? centeredPanX : -baseX;
      const minPanY = scaledH <= containerH ? centeredPanY : containerH - baseY - scaledH;
      const maxPanY = scaledH <= containerH ? centeredPanY : -baseY;

      return {
        wrapperW,
        wrapperH,
        containerW,
        containerH,
        baseX,
        baseY,
        scaledW,
        scaledH,
        minPanX,
        maxPanX,
        minPanY,
        maxPanY
      };
    }

    function clampPan() {
      const z = state.zoomLevel;
      if (z <= ZOOM_MIN) {
        state.panX = 0;
        state.panY = 0;
        return;
      }

      const geometry = getZoomGeometry(z);
      state.panX = Math.max(geometry.minPanX, Math.min(geometry.maxPanX, state.panX));
      state.panY = Math.max(geometry.minPanY, Math.min(geometry.maxPanY, state.panY));
    }

    function resetZoomPan() {
      state.zoomLevel = 1;
      state.panX = 0;
      state.panY = 0;
      state.isPanning = false;
      canvasTransformWrapper.style.transform = '';
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
    }

    function canPan() {
      return state.zoomLevel > 1 && !state.cropping && !state.samplingMode;
    }

    function displayNegative(imageData) {
      resetZoomPan();
      renderAdjustedImageDataToMainCanvas(imageData, imageData);
      syncTransformCanvasFromMainCanvas();
      updateSprocketControlsUI();
    }

    // ===========================================
    // File Loading
    // ===========================================
    async function loadFile(file) {
      const placeholder = document.getElementById('uploadPlaceholder');
      placeholder.innerHTML = `<p>${i18n[currentLang].processing}</p>`;
      const fileName = file.name.toLowerCase();
      const isRawLikeFile = isRawLikeFileName(fileName);
      closeFrontierGuidePopup();

      const overlay = getLoadingOverlay();
      const lang = i18n[currentLang];

      try {
        if (isRawLikeFile) {
          await overlay.show({ title: lang.loadingLoading });
          overlay.updateProgress(10, lang.loadingLoading);
        }

        let imageData;
        let extractedRawMeta = null;

        if (isRawLikeFile) {
          const arrayBuffer = await file.arrayBuffer();
          const isHeavy = arrayBuffer.byteLength > 100 * 1024 * 1024;

          if (isHeavy) {
            // Two-stage loading: show fast half-size preview immediately,
            // then decode full resolution in the background.
            overlay.updateProgress(20, lang.loadingProcessing);
            imageData = await loadRawImageDataPreview(arrayBuffer, fileName, {
              onMetadata(meta) {
                extractedRawMeta = meta;
              }
            });
            overlay.updateProgress(60, lang.loadingProcessing);

            // Schedule full-res decode. Store buffer so it stays alive.
            state._pendingFullResBuffer = arrayBuffer;
            state._pendingFullResFileName = fileName;
          } else {
            overlay.updateProgress(30, lang.loadingProcessing);
            imageData = await loadRawImageData(arrayBuffer, fileName, {
              onMetadata(meta) {
                extractedRawMeta = meta;
              }
            });
            overlay.updateProgress(90, lang.loadingProcessing);
          }
        } else if (file.type === 'image/png') {
          const arrayBuffer = await file.arrayBuffer();
          imageData = await loadPngImageData(arrayBuffer);
        } else {
          imageData = await loadStandardImage(file);
        }

        if (imageData) {
          state.loadedBaseImageData = imageData;
          state.originalImageData = imageData;
          state.croppedImageData = null;
          state.cropRegion = null;
          state.rotationAngle = 0;
          state.processedImageData = null;
          state.displayImageData = null;
          clearFullResolutionRenderState();
          invalidateSilverCoreCache();
          state.conversionSourceImageData = null;
          state.conversionPreviewImageData = null;
          state.previewSourceImageData = null;
          state.histogramSourceImageData = null;
          state.webglSourceImageData = null;
          // Mirror 16-bit handle from loader. Falls back to upscaling the 8-bit copy
          // when the loader did not attach __image16 (defensive — should not happen).
          state.original16 = imageData.__image16
            || (imageData instanceof ImageData ? fromImageData8(imageData) : null);
          state.cropped16 = null;
          state.processed16 = null;
          state.lastRenderQuality = 'full';
          state.filmBaseSet = false;
          state.grayPointSampled = false;
          resetFrontierGuideImageState();
          state.autoFrame.lastDiagnostics = null;
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
          displayNegative(imageData);
          showImageUI();
          goToStep(1);
          clearUndoHistory();
          updateAutoFrameDiagnosticsUI();
          syncBatchUIState({ reason: 'loadFile' });
          updateAutoFrameButtons();
          updateSamplingModeUI();
        }
        if (isRawLikeFile) {
          overlay.updateProgress(100, lang.loadingComplete);
          await new Promise(r => setTimeout(r, 200));
          overlay.hide();
          // Schedule background full-resolution decode if we used fast preview
          if (state._pendingFullResBuffer) {
            scheduleBackgroundFullResDecode();
          }
        }
      } catch (err) {
        overlay.hide();
        console.error('Error loading file:', err);
        const text = String(err?.message || err || '');
        const isRawSupportIssue = isRawLikeFile && /module worker|worker|webassembly|wasm/i.test(text);
        const isGarbled = err?.code === 'RAW_DECODE_GARBLED';
        const isTimeout = err?.code === 'RAW_DECODE_TIMEOUT';
        const message = isTimeout
          ? (i18n[currentLang].rawDecodeTimeout || 'This RAW file took too long to decode. Try converting to DNG or TIFF first.')
          : isGarbled
            ? (i18n[currentLang].rawDecodeGarbled || 'Could not decode this RAW file. Try Lossless Compressed mode or convert to DNG.')
            : isRawSupportIssue
              ? (i18n[currentLang].rawUnsupported || 'RAW decode is not supported in this Safari version. Update Safari or convert to TIFF/JPEG first.')
              : (i18n[currentLang].loadError || 'Error loading file');
        placeholder.innerHTML = `<p style="color: var(--danger);">${message}</p>`;
      }
    }

    async function scheduleBackgroundFullResDecode() {
      const buf = state._pendingFullResBuffer;
      const name = state._pendingFullResFileName;
      if (!buf || !name) return;
      state._pendingFullResBuffer = null;
      state._pendingFullResFileName = null;

      console.info('[RAW] starting background full-res decode for', name, (buf.byteLength / 1024 / 1024).toFixed(0) + 'MB');

      try {
        const fullImageData = await loadRawImageData(buf, name, {
          onMetadata(meta) {
            if (meta && !state.rawMetadata) {
              state.rawMetadata = meta;
              applyLensMetadataPrefill(meta);
            }
          }
        });
        if (!fullImageData) return;

        // Replace the preview with the full-res image.
        const wasCropped = !!state.croppedImageData;
        state.originalImageData = fullImageData;
        state.loadedBaseImageData = fullImageData;
        state.original16 = fullImageData.__image16 || fromImageData8(fullImageData);
        if (!wasCropped) {
          state.croppedImageData = null;
          state.cropRegion = null;
        }
        invalidateSilverCoreCache();
        displayNegative(fullImageData);
        updateCanvasVisibility();
        console.info('[RAW] background full-res decode complete');
      } catch (err) {
        console.warn('[RAW] background full-res decode failed, keeping preview', err.message);
        // Keep the preview — it's still usable.
      }
    }

    function showImageUI() {
      document.getElementById('uploadPlaceholder').style.display = 'none';
      document.getElementById('previewToolbar').style.display = 'flex';
      document.getElementById('histogramContainer').style.display = 'block';
      document.getElementById('controlsPanel').style.display = 'flex';
      document.getElementById('appFooter').style.display = 'flex';

      // Show zoom controls and update i18n titles
      zoomControls.style.display = 'flex';
      const lang = i18n[currentLang] || i18n.en;
      document.getElementById('zoomInBtn').title = lang.zoomIn || 'Zoom In';
      document.getElementById('zoomOutBtn').title = lang.zoomOut || 'Zoom Out';
      document.getElementById('zoomResetBtn').title = lang.zoomReset || 'Reset Zoom';

      redrawHistogramIfPossible();
      updateCanvasVisibility();
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
      const suggestionBuffer = state.step2Mode === 'noBorder'
        ? state.coreBorderBufferBorderValue
        : state.coreBorderBuffer;
      const sample = autoDetectFilmBase(sourceData, suggestionBuffer);
      const orangeBias = (sample.r - sample.b) + ((sample.r - sample.g) * 0.5);
      return orangeBias > 10 ? 'border' : 'noBorder';
    }

    function setStep2Mode(mode) {
      const nextMode = mode === 'noBorder' ? 'noBorder' : 'border';
      if (requiresFilmBase()) {
        if (nextMode === 'noBorder') {
          if (state.step2Mode !== 'noBorder') {
            state.coreBorderBufferBorderValue = sanitizeNumeric(state.coreBorderBuffer, 10, 0, 30);
          } else {
            state.coreBorderBufferBorderValue = sanitizeNumeric(state.coreBorderBufferBorderValue, 10, 0, 30);
          }
          state.coreBorderBuffer = 0;
        } else {
          const restoredBuffer = sanitizeNumeric(state.coreBorderBufferBorderValue, 10, 0, 30);
          state.coreBorderBufferBorderValue = restoredBuffer;
          state.coreBorderBuffer = restoredBuffer;
        }
      }

      state.step2Mode = nextMode;
      const borderBtn = document.getElementById('step2ModeBorderBtn');
      const noBorderBtn = document.getElementById('step2ModeNoBorderBtn');
      if (borderBtn) borderBtn.classList.toggle('active', state.step2Mode === 'border');
      if (noBorderBtn) noBorderBtn.classList.toggle('active', state.step2Mode === 'noBorder');
      syncSliderFromState('coreBorderBuffer');
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
      updateStep2GuideCard();
      markCurrentFileDirty();
      return true;
    }

    function buildNoviceGuideViewModel() {
      const filmType = sanitizePresetType(state.filmType || 'color');
      const inBatch = Boolean(state.batchSessionActive);
      const model = {
        phaseKey: 'noviceGuidePhaseStep1',
        primaryKey: 'noviceGuidePrimaryStep1',
        checklistKeys: ['noviceGuideChecklistStep1Crop', 'noviceGuideChecklistStep1Next'],
        statusKey: '',
        warningKey: '',
        recommendedActionIds: []
      };

      if (state.currentStep <= 1) {
        model.recommendedActionIds = state.cropRegion
          ? ['convertBtn']
          : ['autoFrameBtn', 'cropBtn'];
        return model;
      }

      if (state.currentStep === 2) {
        model.phaseKey = 'noviceGuidePhaseStep2';
        if (filmType === 'color') {
          const isNoBorder = state.step2Mode === 'noBorder';
          const hasReference = hasRollReference();
          if (isNoBorder) {
            model.primaryKey = 'noviceGuidePrimaryStep2ColorNoBorder';
            model.checklistKeys = [
              'noviceGuideChecklistStep2ColorNoBorderAuto',
              'noviceGuideChecklistStep2ColorNoBorderReference'
            ];
            model.recommendedActionIds = hasReference
              ? ['useReferenceBtn', 'autoDetectBtn']
              : ['autoDetectBtn'];
            if (!state.filmBaseSet && !hasReference) {
              model.warningKey = 'noviceGuideWarningReferenceMissing';
            }
          } else {
            model.primaryKey = 'noviceGuidePrimaryStep2ColorBorder';
            model.checklistKeys = [
              'noviceGuideChecklistStep2ColorBorderSample',
              'noviceGuideChecklistStep2ColorBorderFallback'
            ];
            model.recommendedActionIds = ['sampleBaseBtn', 'autoDetectBtn'];
            if (!state.filmBaseSet) {
              model.warningKey = 'noviceGuideWarningMaskUnset';
            }
          }

          if (state.filmBaseSet) {
            model.statusKey = 'noviceGuideStatusAutoToStep3Ready';
            model.recommendedActionIds = ['applyConvertBtn'];
          } else {
            model.statusKey = 'noviceGuideStatusAutoToStep3';
          }
          return model;
        }

        if (filmType === 'bw') {
          model.primaryKey = 'noviceGuidePrimaryStep2Bw';
          model.checklistKeys = [
            'noviceGuideChecklistStep2BwSelect',
            'noviceGuideChecklistStep2BwAuto'
          ];
          model.statusKey = 'noviceGuideStatusAutoToStep3';
          model.recommendedActionIds = ['applyConvertBtn'];
          return model;
        }

        model.primaryKey = 'noviceGuidePrimaryStep2Positive';
        model.checklistKeys = ['noviceGuideChecklistStep2PositiveConvert'];
        model.statusKey = 'noviceGuideStatusManualConvert';
        model.recommendedActionIds = ['applyConvertBtn'];
        return model;
      }

      model.phaseKey = 'noviceGuidePhaseStep3';
      model.primaryKey = inBatch
        ? 'noviceGuidePrimaryStep3Batch'
        : 'noviceGuidePrimaryStep3Single';
      const desktopBatchExport = isTauriDesktop();
      model.checklistKeys = inBatch
        ? [
            'noviceGuideChecklistStep3BatchSave',
            'noviceGuideChecklistStep3BatchApply',
            desktopBatchExport
              ? 'noviceGuideChecklistStep3BatchExportDesktop'
              : 'noviceGuideChecklistStep3BatchExport'
          ]
        : [
            'noviceGuideChecklistStep3SampleGray',
            desktopBatchExport
              ? 'noviceGuideChecklistStep3ExportDesktop'
              : 'noviceGuideChecklistStep3Export'
          ];
      model.statusKey = step3GuideCollapsedOnce ? 'noviceGuideStatusStep3Collapsed' : '';
      model.recommendedActionIds = inBatch
        ? ['saveSettingsBtn', 'applyToSelectedBtn', 'exportBtn']
        : ['headerGrayPointBtn', 'exportBtn'];
      return model;
    }

    function renderNoviceGuide(options = {}) {
      const { applyStep3Collapse = false } = options;
      const card = document.getElementById('noviceGuideCard');
      const phaseEl = document.getElementById('noviceGuidePhase');
      const primaryEl = document.getElementById('noviceGuidePrimary');
      const checklistEl = document.getElementById('noviceGuideChecklist');
      const statusEl = document.getElementById('noviceGuideStatus');
      const warningEl = document.getElementById('noviceGuideWarning');
      if (!card || !phaseEl || !primaryEl || !checklistEl || !statusEl || !warningEl) return;

      if (!guideModeEnabled) {
        card.style.display = 'none';
        clearRecommendedActions();
        return;
      }
      card.style.display = 'flex';

      if (applyStep3Collapse) {
        collapseStep3SectionsForGuideIfNeeded();
      }

      const model = buildNoviceGuideViewModel();
      phaseEl.textContent = getLocalizedText(model.phaseKey, '');
      primaryEl.textContent = getLocalizedText(model.primaryKey, '');

      checklistEl.innerHTML = '';
      model.checklistKeys.forEach(key => {
        const text = getLocalizedText(key, '');
        if (!text) return;
        const item = document.createElement('li');
        item.textContent = text;
        checklistEl.appendChild(item);
      });

      const statusText = model.statusKey ? getLocalizedText(model.statusKey, '') : '';
      statusEl.textContent = statusText;
      statusEl.style.display = statusText ? 'block' : 'none';

      const warningText = model.warningKey ? getLocalizedText(model.warningKey, '') : '';
      warningEl.textContent = warningText;
      warningEl.style.display = warningText ? 'block' : 'none';

      setRecommendedActions(model.recommendedActionIds);
    }

    function updateStep2GuideCard() {
      renderNoviceGuide({ applyStep3Collapse: false });
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
        updateStep2GuideCard();
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
      updateStep2GuideCard();
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
      pushUndo('autoDetectBase');
      state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
      state.filmBaseSet = true;
      updateFilmBasePreview();
      updateStep2GuideCard();
      markCurrentFileDirty();
      scheduleSilverSourceRefresh({ immediate: true });
    });

    document.getElementById('useReferenceBtn').addEventListener('click', () => {
      if (!hasRollReference()) {
        alert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      if (applyRollReferenceToCurrentForStep2()) {
        updateStep2GuideCard();
        scheduleSilverSourceRefresh({ immediate: true });
        alert(i18n[currentLang].rollReferenceAppliedCurrent || 'Roll reference applied to current image.');
      }
    });

    document.getElementById('applyConvertBtn').addEventListener('click', () => {
      if (requiresFilmBase() && !state.filmBaseSet) {
        const usedReference = state.step2Mode === 'noBorder' ? applyRollReferenceToCurrentForStep2() : false;
        if (!usedReference) {
          // Auto detect if not set
          const sourceData = state.croppedImageData || state.originalImageData;
          state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
          state.filmBaseSet = true;
          updateFilmBasePreview();
          updateStep2GuideCard();
          markCurrentFileDirty();
          if (state.step2Mode === 'border') {
            alert(getLocalizedText('guideAutoDetectFallback', 'Mask was not sampled manually, so auto-detect was applied.'));
          } else if (!hasRollReference()) {
            alert(getLocalizedText('guideReferenceSuggestion', 'If auto-detect is unstable, set one frame as roll reference first.'));
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
        sourceData = state.croppedImageData || state.originalImageData;
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
        updateStep2GuideCard();
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

      const applyValue = (rawValue, commitFull = false) => {
        const value = normalize(rawValue);
        state[stateKey] = value;
        syncUI(value);
        markCurrentFileDirty();
        if (onInput) {
          onInput(value);
        } else {
          schedulePreviewUpdate();
        }
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
          undoStack.push(preDragSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
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
        if (onInput) onInput(value);
        else schedulePreviewUpdate();
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

      const binding = { id, stateKey, slider, valueInput, normalize, format };
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

      select.addEventListener('input', () => {
        state[stateKey] = select.value;
        markCurrentFileDirty();
        if (onChange) onChange(select.value);
        else schedulePreviewUpdate();
      });

      select.addEventListener('change', () => {
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

    const coreReprocessHandlers = {
      // Dragging: fast pixel-level adjustments only (no SilverCore reconversion).
      onInput: () => schedulePreviewUpdate(),
      // Release: re-run SilverCore on preview for accurate tone mapping.
      onCommit: () => scheduleCoreReprocess({ full: false })
    };

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

    setupSlider('coreProfileStrength', 'coreProfileStrength', coreReprocessHandlers);
    setupSlider('corePreSaturation', 'corePreSaturation', coreReprocessHandlers);
    setupSlider('coreBorderBuffer', 'coreBorderBuffer', coreBorderBufferHandlers);
    setupSlider('coreBrightness', 'coreBrightness', coreReprocessHandlers);
    setupSlider('coreExposure', 'coreExposure', coreReprocessHandlers);
    setupSlider('coreContrast', 'coreContrast', coreReprocessHandlers);
    setupSlider('coreHighlights', 'coreHighlights', coreReprocessHandlers);
    setupSlider('coreShadows', 'coreShadows', coreReprocessHandlers);
    setupSlider('coreWhites', 'coreWhites', coreReprocessHandlers);
    setupSlider('coreBlacks', 'coreBlacks', coreReprocessHandlers);
    setupSlider('coreTemperature', 'coreTemperature', coreReprocessHandlers);
    setupSlider('coreTint', 'coreTint', coreReprocessHandlers);
    setupSlider('coreSaturation', 'coreSaturation', coreReprocessHandlers);
    setupSlider('coreGlow', 'coreGlow', coreReprocessHandlers);
    setupSlider('coreFade', 'coreFade', coreReprocessHandlers);
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

    setupSlider('wbR', 'wbR', { decimals: 2 });
    setupSlider('wbG', 'wbG', { decimals: 2 });
    setupSlider('wbB', 'wbB', { decimals: 2 });
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
    function normalizeAngleDegrees(angle) {
      let normalized = Number.isFinite(angle) ? angle : 0;
      while (normalized > 180) normalized -= 360;
      while (normalized <= -180) normalized += 360;
      return normalized;
    }

    function copyRotatedRgbaBuffer(source, width, height, angle) {
      const normalized = normalizeAngleDegrees(angle);
      const rightAngle = Math.round(normalized / 90) * 90;
      const dstWidth = Math.abs(rightAngle) === 90 ? height : width;
      const dstHeight = Math.abs(rightAngle) === 90 ? width : height;
      const output = source instanceof Uint16Array
        ? new Uint16Array(source.length)
        : new Uint8ClampedArray(source.length);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let dstX;
          let dstY;
          if (rightAngle === 90) {
            dstX = height - 1 - y;
            dstY = x;
          } else if (rightAngle === -90) {
            dstX = y;
            dstY = width - 1 - x;
          } else {
            dstX = width - 1 - x;
            dstY = height - 1 - y;
          }

          const srcIdx = (y * width + x) * 4;
          const dstIdx = (dstY * dstWidth + dstX) * 4;
          output[dstIdx] = source[srcIdx];
          output[dstIdx + 1] = source[srcIdx + 1];
          output[dstIdx + 2] = source[srcIdx + 2];
          output[dstIdx + 3] = source[srcIdx + 3];
        }
      }

      return { width: dstWidth, height: dstHeight, data: output };
    }

    function copyMirroredRgbaBuffer(source, width, height) {
      const output = source instanceof Uint16Array
        ? new Uint16Array(source.length)
        : new Uint8ClampedArray(source.length);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = (y * width + x) * 4;
          const dstIdx = (y * width + (width - 1 - x)) * 4;
          output[dstIdx] = source[srcIdx];
          output[dstIdx + 1] = source[srcIdx + 1];
          output[dstIdx + 2] = source[srcIdx + 2];
          output[dstIdx + 3] = source[srcIdx + 3];
        }
      }

      return { width, height, data: output };
    }

    function attachTransformedImage16(target, sourceImageData, transform) {
      const source16 = sourceImageData?.__image16;
      if (!source16 || !(source16.data instanceof Uint16Array)) return target;
      target.__image16 = transform(source16.data, source16.width, source16.height);
      return target;
    }

    function rotateImageDataRightAngle(imageData, angle) {
      const rotated = copyRotatedRgbaBuffer(imageData.data, imageData.width, imageData.height, angle);
      const result = new ImageData(rotated.data, rotated.width, rotated.height);
      return attachTransformedImage16(result, imageData, (data, width, height) => {
        const image16 = copyRotatedRgbaBuffer(data, width, height, angle);
        return { width: image16.width, height: image16.height, data: image16.data };
      });
    }

    function mirrorImageDataHorizontal(imageData) {
      const mirrored = copyMirroredRgbaBuffer(imageData.data, imageData.width, imageData.height);
      const result = new ImageData(mirrored.data, mirrored.width, mirrored.height);
      return attachTransformedImage16(result, imageData, (data, width, height) => {
        const image16 = copyMirroredRgbaBuffer(data, width, height);
        return { width: image16.width, height: image16.height, data: image16.data };
      });
    }

    function applyRotationToImageData(imageData, angle) {
      if (!imageData) return null;
      const normalized = normalizeAngleDegrees(Number(angle) || 0);
      if (Math.abs(normalized) < 0.001) return imageData;
      const rightAngle = Math.round(normalized / 90) * 90;
      if (Math.abs(normalized - rightAngle) < 0.001 && Math.abs(rightAngle) % 90 === 0) {
        return rotateImageDataRightAngle(imageData, rightAngle);
      }

      const rad = normalized * Math.PI / 180;
      const w = imageData.width;
      const h = imageData.height;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const newW = Math.max(1, Math.ceil(w * cos + h * sin));
      const newH = Math.max(1, Math.ceil(w * sin + h * cos));

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = w;
      srcCanvas.height = h;
      const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
      srcCtx.putImageData(imageData, 0, 0);

      const dstCanvas = document.createElement('canvas');
      dstCanvas.width = newW;
      dstCanvas.height = newH;
      const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
      dstCtx.translate(newW / 2, newH / 2);
      dstCtx.rotate(rad);
      dstCtx.drawImage(srcCanvas, -w / 2, -h / 2);

      return dstCtx.getImageData(0, 0, newW, newH);
    }

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

    async function detectFrameAndRotation(imageData) {
      if (!imageData) return null;
      const ready = await ensureOpenCvReady();
      if (!ready) return null;

      const { detectFrameAndRotation: analyzeFrameAndRotation } = await getAutoFrameAnalyzer();
      return analyzeFrameAndRotation(imageData, {
        settings: {
          ...state.autoFrame,
          filmType: state.filmType
        },
        maxSide: AUTO_FRAME_MAX_SIDE,
        formatRatios: AUTO_FRAME_FORMAT_RATIOS,
        default120Formats: AUTO_FRAME_DEFAULT_120_FORMATS,
        scoreWeights: AUTO_FRAME_SCORE_WEIGHTS,
        rotateImageData: applyRotationToImageData,
        sanitizeCropRegion: sanitizeCropRegionForImage
      });
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

    function applyAutoFrameResult(result) {
      if (!result || !state.originalImageData) return false;

      state.rotationAngle = normalizeAngleDegrees(result.angle || 0);
      state.croppedImageData = null;
      state.cropRegion = null;
      state.originalImageData = result.rotatedImageData
        || (Math.abs(state.rotationAngle) < 0.001
          ? state.originalImageData
          : applyRotationToImageData(state.originalImageData, state.rotationAngle));
      applyCropRegionToLoadedImage(result.cropRegion, { refreshDisplay: true });
      state.autoFrame.lastDiagnostics = {
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: false,
        appliedMode: 'crop',
        lowConfidenceApplied: (result.confidenceLevel || inferConfidenceLevel(result.confidence || 0)) === 'low'
      };
      updateAutoFrameDiagnosticsUI();
      setStep2Mode(suggestStep2Mode());
      return true;
    }

    function applyAutoFrameRotationOnly(result) {
      if (!result || !state.originalImageData) return false;
      state.rotationAngle = normalizeAngleDegrees(result.angle || 0);
      state.cropRegion = null;
      state.croppedImageData = null;
      state.originalImageData = result.rotatedImageData
        || (Math.abs(state.rotationAngle) < 0.001
          ? state.originalImageData
          : applyRotationToImageData(state.originalImageData, state.rotationAngle));
      displayNegative(state.originalImageData);
      state.autoFrame.lastDiagnostics = {
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: true,
        appliedMode: 'rotateOnly',
        lowConfidenceApplied: false
      };
      updateAutoFrameDiagnosticsUI();
      setStep2Mode(suggestStep2Mode());
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
      if (coreReprocessTimer) {
        clearTimeout(coreReprocessTimer);
        coreReprocessTimer = null;
      }
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }
    }

    function applyRotation(angle) {
      if (!state.originalImageData || !Number.isFinite(angle) || angle === 0) return;

      const normalizedAngle = normalizeAngleDegrees(Number(angle) || 0);
      if (Math.abs(normalizedAngle) < 0.001) return;

      if (state.cropping && rotateCropDraftBy(normalizedAngle)) return;

      pushUndo('rotation');
      const sourceOriginal = state.originalImageData;
      const sourceCrop = state.cropRegion ? { ...state.cropRegion } : null;
      const shouldPreserveCrop = Boolean(sourceCrop);

      const rotatedData = applyRotationToImageData(sourceOriginal, normalizedAngle);
      if (!rotatedData) return;

      state.originalImageData = rotatedData;

      if (shouldPreserveCrop) {
        const mappedCrop = mapCropRegionAfterRotation(
          sourceCrop,
          sourceOriginal.width,
          sourceOriginal.height,
          rotatedData.width,
          rotatedData.height,
          normalizedAngle
        );
        state.cropRegion = mappedCrop;
        state.croppedImageData = mappedCrop ? cropImageData(state.originalImageData, mappedCrop) : null;
      } else {
        state.croppedImageData = null;
        state.cropRegion = null;
      }

      state.rotationAngle = normalizeAngleDegrees((state.rotationAngle || 0) + normalizedAngle);
      invalidateProcessedPipelineState();
      resetZoomPan();

      if (state.currentStep >= 3) {
        void processNegative();
      } else {
        displayNegative(state.croppedImageData || rotatedData);
        updateCanvasVisibility();
      }
      setStep2Mode(suggestStep2Mode());
      markCurrentFileDirty();
    }

    function applyMirror() {
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return;

      pushUndo('mirror');
      const newImageData = mirrorImageDataHorizontal(sourceData);
      if (state.croppedImageData) {
        state.croppedImageData = newImageData;
      } else {
        state.originalImageData = newImageData;
      }

      invalidateProcessedPipelineState();
      resetZoomPan();
      if (state.currentStep >= 3) {
        void processNegative();
      } else {
        displayNegative(newImageData);
        updateCanvasVisibility();
        renderHistogram(newImageData);
      }
      markCurrentFileDirty();
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
        const ready = await ensureOpenCvReady();
        if (!ready) {
          alert(i18n[currentLang].autoFrameCvLoadError || 'OpenCV failed to load. Auto frame is unavailable.');
          return;
        }

        const result = await detectFrameAndRotation(source);
        if (!result) {
          alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          return;
        }

        const detail = formatAutoFrameDetail(result);
        state.originalImageData = source;
        const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
        let applied = false;

        if (result.confidenceLevel === 'low') {
          if (lowBehavior === 'rotateOnly') {
            if (Math.abs(result.angle) > 0.05) {
              applied = applyAutoFrameRotationOnly(result);
              if (applied) {
                const template = i18n[currentLang].autoFrameRotateOnlyApplied
                  || 'Low confidence: applied rotation only ({angle}°).';
                alert(template.replace('{angle}', String(result.angle)));
              }
            } else {
              alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
            }
          } else if (lowBehavior === 'ignore') {
            alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          } else {
            applied = applyAutoFrameResult(result);
            if (applied) {
              const template = i18n[currentLang].autoFrameLowConfidenceApplied
                || 'Low confidence: crop applied. Please verify the result (confidence {confidence}).';
              const confidenceText = Number.isFinite(result.confidence) ? result.confidence.toFixed(2) : '0.00';
              alert(template.replace('{confidence}', confidenceText));
            }
          }
        } else if (result.confidenceLevel === 'high' && state.autoFrame.autoApplyHighConfidence) {
          applied = applyAutoFrameResult(result);
        } else {
          const title = i18n[currentLang].autoFramePreviewTitle || 'Reliable frame detected. Apply auto rotation and crop?';
          if (window.confirm(`${title}\n${detail}`)) {
            applied = applyAutoFrameResult(result);
          }
        }

        if (applied) {
          markCurrentFileDirty();
        } else {
          state.autoFrame.lastDiagnostics = {
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

      const ready = await ensureOpenCvReady();
      if (!ready) {
        alert(i18n[currentLang].autoFrameCvLoadError || 'OpenCV failed to load. Auto frame is unavailable.');
        return;
      }

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
            const imageData = await loadFileToImageData(item.file);
            const result = await detectFrameAndRotation(imageData);
            if (!result) {
              failCount++;
              continue;
            }

            const existing = item.settings ? cloneSettings(item.settings) : createDefaultSettings(imageData);
            const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
            let appliedMode = 'none';
            if (result.confidenceLevel === 'low') {
              if (lowBehavior === 'rotateOnly' && Math.abs(result.angle) > 0.05) {
                existing.rotationAngle = result.angle;
                existing.cropRegion = null;
                rotateOnlyCount++;
                appliedMode = 'rotateOnly';
              } else if (lowBehavior === 'suggest') {
                existing.rotationAngle = result.angle;
                existing.cropRegion = result.cropRegion ? { ...result.cropRegion } : null;
                successCount++;
                lowAppliedCount++;
                appliedMode = 'crop';
              } else {
                failCount++;
                continue;
              }
            } else {
              existing.rotationAngle = result.angle;
              existing.cropRegion = result.cropRegion ? { ...result.cropRegion } : null;
              successCount++;
              appliedMode = 'crop';
            }

            existing.autoFrameMeta = {
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
      alert(template
        .replace('{success}', String(successCount))
        .replace('{lowApplied}', String(lowAppliedCount))
        .replace('{rotated}', String(rotateOnlyCount))
        .replace('{failed}', String(failCount)));
    }

    document.getElementById('autoFrameBtn').addEventListener('click', () => {
      applyAutoFrameToCurrent();
    });

    document.getElementById('autoFrameSelectedBtn').addEventListener('click', () => {
      applyAutoFrameToSelected();
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
      if (isEditableTarget(event.target)) return;
      if (state.cropping || state.samplingMode) return;
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
      if (isEditableTarget(event.target)) return;

      const frontierGuidePopupOverlay = document.getElementById('frontierGuidePopupOverlay');
      if (frontierGuidePopupOverlay?.classList.contains('visible')) {
        event.preventDefault();
        closeFrontierGuidePopup();
        return;
      }
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

    cropBtn.addEventListener('click', () => {
      beginCropMode();
    });

    function showCropModeHint(options = {}) {
      if (!cropModeHint || !cropModeHintTitle || !cropModeHintBody) return;
      const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 4200;

      cropModeHintTitle.textContent = getLocalizedText('cropHintTitle', 'Crop and straighten');
      cropModeHintBody.textContent = getLocalizedText(
        'cropHintBody',
        'Drag inside the box to move it, or drag edges/corners to resize. Hold Command/Ctrl and draw a line to straighten.'
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

    function formatCropAngleValue(value) {
      const rounded = Math.round((Number(value) || 0) * 10) / 10;
      return rounded.toFixed(1).replace(/\.0$/, '');
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
      const previewSourceImageData = buildCropPreviewSourceImageData(sourceImageData);
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
      updateSprocketControlsUI();
    }

    function beginCropMode() {
      const sourceImageData = state.originalImageData;
      if (!sourceImageData) return;

      exitBeforeAfter();
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
      state.cropDraft = createCropDraft(sourceImageData);
      if (!state.cropDraft) {
        state.cropping = false;
        return;
      }

      setCropActionUi(true);
      renderCropDraftPreview({ preserveRect: false });
      showCropModeHint();
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

      if (mode === 'draw') {
        draft.rect = sanitizeDraftCropRect({
          left: position.x,
          top: position.y,
          width: 1,
          height: 1
        }, draft.rotatedImageData);
      }

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
        const left = Math.min(interaction.start.x, position.x);
        const top = Math.min(interaction.start.y, position.y);
        draft.rect = sanitizeDraftCropRect({
          left,
          top,
          width: Math.abs(position.x - interaction.start.x),
          height: Math.abs(position.y - interaction.start.y)
        }, imageData);
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
      if (state.cropping || state.samplingMode) return;
      e.preventDefault();
      const deltaUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvasContainer.clientHeight : 1;
      const deltaY = e.deltaY * deltaUnit;
      const sensitivity = e.ctrlKey ? ZOOM_PINCH_WHEEL_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
      const factor = Math.max(0.72, Math.min(1.38, Math.exp(-deltaY * sensitivity)));
      zoomAtPoint(state.zoomLevel * factor, e.clientX, e.clientY);
    }, { passive: false });

    // Double-click: toggle zoom
    canvasContainer.addEventListener('dblclick', (e) => {
      if (state.cropping || state.samplingMode) return;
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
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.hypot(dx, dy);
        pinchStartZoom = state.zoomLevel;
      }
    }, { passive: false });

    canvasContainer.addEventListener('touchmove', (e) => {
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

    applyCropBtn.addEventListener('click', () => {
      const draft = state.cropDraft;
      if (!draft || !draft.sourceImageData) return;

      const angle = getCropDraftTotalAngle();
      const previewRotatedImageData = draft.rotatedImageData;
      const rotatedImageData = Math.abs(angle) < 0.001
        ? draft.sourceImageData
        : applyRotationToImageData(draft.sourceImageData, angle);
      if (!rotatedImageData || !previewRotatedImageData) return;

      const cropRegion = sanitizeCropRegionForImage(scaleCropRect(
        draft.rect,
        rotatedImageData.width / previewRotatedImageData.width,
        rotatedImageData.height / previewRotatedImageData.height
      ), rotatedImageData);
      if (!cropRegion) return;

      pushUndo('crop');
      state.originalImageData = rotatedImageData;
      state.rotationAngle = normalizeAngleDegrees((state.rotationAngle || 0) + angle);
      state.cropRegion = cropRegion;
      state.croppedImageData = cropImageData(rotatedImageData, cropRegion);
      invalidateProcessedPipelineState();
      resetZoomPan();
      setStep2Mode(suggestStep2Mode());
      markCurrentFileDirty();
      exitCropMode({ restore: false });

      if (state.currentStep >= 3) {
        void processNegative();
      } else {
        const sourceImageData = state.croppedImageData || state.originalImageData;
        displayNegative(sourceImageData);
        updateCanvasVisibility();
        renderHistogram(sourceImageData);
      }
    });

    // Convert button (skip to step 2)
    document.getElementById('convertBtn').addEventListener('click', () => {
      goToStep(2);
    });

    // Convert positive button (skip to step 2 with positive mode selected)
    document.getElementById('convertPositiveBtn').addEventListener('click', () => {
      state.filmType = 'positive';
      setFilmTypeButtons(state.filmType);
      updateFilmModeUI();
      markCurrentFileDirty();
      goToStep(2);
    });

    // ===========================================
    // Reset & Start Over
    // ===========================================
    document.getElementById('resetBtn').addEventListener('click', () => {
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
    });

    document.getElementById('startOverBtn').addEventListener('click', () => {
      if (isDesktopBatchExportLocked()) return;
      clearUndoHistory();
      closeFrontierGuidePopup();
      exitBeforeAfter();
      resetZoomPan();
      if (state.loadedBaseImageData || state.originalImageData) {
        state.originalImageData = state.loadedBaseImageData || state.originalImageData;
        state.rotationAngle = 0;
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
        state.sprocketPreviewEnabled = false;
        resetFrontierGuideImageState();
        state.lastRenderQuality = 'full';
        if (webglState.gl) {
          webglState.sourceDirty = true;
          webglState.sourceSize = { w: 0, h: 0 };
        }
        if (fullUpdateTimer) {
          clearTimeout(fullUpdateTimer);
          fullUpdateTimer = null;
        }
        if (coreReprocessTimer) {
          clearTimeout(coreReprocessTimer);
          coreReprocessTimer = null;
        }
        if (step2AutoConvertTimer) {
          clearTimeout(step2AutoConvertTimer);
          step2AutoConvertTimer = null;
        }
        displayNegative(state.originalImageData);
        updateAutoFrameButtons();
        goToStep(1);
        document.getElementById('resetBtn').click();
        markCurrentFileDirty();
      }
    });

    document.getElementById('newImageBtn').addEventListener('click', () => {
      if (isDesktopBatchExportLocked()) return;
      clearUndoHistory();
      closeFrontierGuidePopup();
      exitBeforeAfter();
      resetZoomPan();
      zoomControls.style.display = 'none';
      // Reset all state
      state.loadedBaseImageData = null;
      state.originalImageData = null;
      state.croppedImageData = null;
      state.cropRegion = null;
      state.rotationAngle = 0;
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
      state.sprocketPreviewEnabled = false;
      state.rawMetadata = null;
      state.currentStep = 1;
      state.lastRenderQuality = 'full';
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.batchSessionActive = false;
      state.batchMode = false;
      state.lensCorrection = createInitialLensCorrectionState();
      resetFrontierGuideImageState();
      resetRollReferenceState();
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
      if (coreReprocessTimer) {
        clearTimeout(coreReprocessTimer);
        coreReprocessTimer = null;
      }
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }

      // Reset UI
      canvas.style.display = 'none';
      glCanvas.style.display = 'none';
      document.getElementById('uploadPlaceholder').style.display = 'flex';
      document.getElementById('previewToolbar').style.display = 'none';
      document.getElementById('histogramContainer').style.display = 'none';
      document.getElementById('controlsPanel').style.display = 'none';
      document.getElementById('appFooter').style.display = 'none';
      updateBeforeAfterButtonState();
      updateSprocketControlsUI();

      // Reset adjustments
      document.getElementById('resetBtn').click();
      syncBatchUIState({ reason: 'newImageBtn' });

      // Trigger file selection
      fileInput.value = '';
      fileInput.click();
    });

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
      toggleExportDropdownForMode(false, e);
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

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const commaIndex = result.indexOf(',');
          if (commaIndex < 0) {
            reject(new Error('Invalid export payload encoding.'));
            return;
          }
          resolve(result.slice(commaIndex + 1));
        };
        reader.onerror = () => {
          reject(reader.error || new Error('Failed to encode export payload.'));
        };
        reader.readAsDataURL(blob);
      });
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

    async function writeBlobToDesktopPath(blob, targetPath, mimeType = 'application/octet-stream') {
      if (!isTauriDesktop()) {
        throw new Error('Desktop path writes require the Tauri runtime.');
      }

      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      const bytesBase64 = await blobToBase64(normalizedBlob);
      const result = await window.__TAURI__.core.invoke('write_export_file_to_path', {
        path: targetPath,
        bytesBase64
      });
      return normalizeSaveResult(result);
    }

    async function writeBlobToDesktopDirectory(blob, directory, fileName, mimeType = 'application/octet-stream') {
      if (!isTauriDesktop()) {
        throw new Error('Desktop directory writes require the Tauri runtime.');
      }

      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      const bytesBase64 = await blobToBase64(normalizedBlob);
      const result = await window.__TAURI__.core.invoke('write_export_file_to_directory', {
        directory,
        suggestedName: fileName,
        bytesBase64
      });
      return normalizeSaveResult(result);
    }

    async function saveBlob(blob, fileName, mimeType = 'application/octet-stream') {
      const normalizedBlob = normalizeExportBlob(blob, mimeType);
      if (isTauriDesktop()) {
        const bytesBase64 = await blobToBase64(normalizedBlob);
        const result = await window.__TAURI__.core.invoke('save_export_file', {
          suggestedName: fileName,
          bytesBase64
        });
        return normalizeSaveResult(result);
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

    let jsZipCtorPromise = null;

    async function getJSZipCtor() {
      if (!jsZipCtorPromise) {
        jsZipCtorPromise = import('jszip')
          .then((mod) => (typeof mod.default === 'function' ? mod.default : mod))
          .catch((err) => {
            jsZipCtorPromise = null;
            throw err;
          });
      }
      return jsZipCtorPromise;
    }

    function getEffectiveExportBitDepth(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      if (format === 'jpeg') return 8;
      return Number(requestedBitDepth) === 16 ? 16 : 8;
    }

    function getExportInfo(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      const normalizedFormat = format === 'jpeg' || format === 'tiff' ? format : 'png';
      const bitDepth = getEffectiveExportBitDepth(normalizedFormat, requestedBitDepth);
      if (normalizedFormat === 'jpeg') {
        return { format: normalizedFormat, bitDepth, extension: '.jpg', mimeType: 'image/jpeg' };
      }
      if (normalizedFormat === 'tiff') {
        return { format: normalizedFormat, bitDepth, extension: '.tiff', mimeType: 'image/tiff' };
      }
      return { format: 'png', bitDepth, extension: '.png', mimeType: 'image/png' };
    }

    function buildExportFileName(sourceName, exportInfo, options = {}) {
      const withConverted = sourceName
        ? sourceName.replace(/\.[^.]+$/, '_converted')
        : 'converted_negative';
      const sprocketSuffix = options.sprocket ? '_sprocket' : '';
      const depthSuffix = exportInfo.bitDepth === 16 && exportInfo.format !== 'jpeg' ? '_16bit' : '';
      return `${withConverted}${sprocketSuffix}${depthSuffix}${exportInfo.extension}`;
    }

    function buildActiveExportFileName(sourceName, exportInfo) {
      return buildExportFileName(sourceName, exportInfo, {
        sprocket: state.exportSprocketHolesEnabled
      });
    }

    function applySprocketFrameForExport(imageData, exportInfo) {
      if (!state.exportSprocketHolesEnabled) return imageData;
      return composeSprocketFrame(imageData, getSprocketFrameComposeOptions());
    }

    async function getCurrentExportImageData() {
      await ensureFullResolutionReadyForExport();
      if (state.currentStep >= 3 && isDisplayImageDataFullResolution()) {
        return state.displayImageData;
      }
      if (state.processedImageData && state.currentStep >= 3) {
        return await applyAdjustmentsWithSettings(state.processedImageData, state);
      }
      if (state.sprocketPreviewEnabled || state.exportSprocketHolesEnabled) {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (sourceData) return sourceData;
      }
      if (canvas.width > 0 && canvas.height > 0) {
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      }
      return null;
    }

    async function renderCurrentImageDataForExport() {
      await ensureFullResolutionReadyForExport();
      ensureFullRender();
      const imageData = await getCurrentExportImageData();
      if (!imageData) throw new Error('No image available for export.');
      return imageData;
    }

    function notifyExportError(err) {
      console.error('Export failed:', err);
      const message = err && err.message ? err.message : String(err || 'Unknown error');
      alert(`Export failed: ${message}`);
    }

    async function exportSingle() {
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const exportInfo = getExportInfo();
      let fileName = buildActiveExportFileName(null, exportInfo);
      let blob;

      await overlay.show({ title: lang.loadingExporting });
      try {
        overlay.updateProgress(5, lang.loadingAdjusting);

        const currentItem = getCurrentQueueItem();
        if (state.currentStep >= 3 && state.processedImageData) {
          persistCurrentFileSettings({ silent: true, force: true });
          const imageData = await renderCurrentImageDataForExport();
          const outputImageData = applySprocketFrameForExport(imageData, exportInfo);
          overlay.updateProgress(60, lang.loadingEncoding);
          blob = await imageDataToBlob(outputImageData, exportInfo.format, state.jpegQuality, exportInfo.bitDepth, (pct) => {
            overlay.updateProgress(60 + pct * 0.35, lang.loadingEncoding);
          });
          if (currentItem?.file?.name) {
            fileName = buildActiveExportFileName(currentItem.file.name, exportInfo);
          }
        } else {
          overlay.updateProgress(50, lang.loadingEncoding);
          const imageData = await renderCurrentImageDataForExport();
          const outputImageData = applySprocketFrameForExport(imageData, exportInfo);
          blob = await imageDataToBlob(outputImageData, exportInfo.format, state.jpegQuality, exportInfo.bitDepth, (pct) => {
            overlay.updateProgress(50 + pct * 0.45, lang.loadingEncoding);
          });
        }

        overlay.updateProgress(100, lang.loadingComplete);
        await new Promise(r => setTimeout(r, 300));
      } finally {
        overlay.hide();
      }

      return await saveBlob(blob, fileName, exportInfo.mimeType);
    }

    document.getElementById('exportSingleBtn').addEventListener('click', async () => {
      try {
        const result = await exportSingle();
        handleSaveResult(result, {
          cancelledKey: 'exportSaveCancelled',
          cancelledFallback: 'Save cancelled. No file was written.'
        });
      } catch (err) {
        notifyExportError(err);
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
      if (isJpeg) state.exportBitDepth = 8;
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
      const exportKey = isJpeg ? 'exportJpeg' : (format === 'tiff' ? 'exportTiff' : 'exportPng');
      exportBtn.textContent = i18n[currentLang][exportKey];
      exportBtn.setAttribute('data-i18n', exportKey);

      const exportSprocketBtn = document.getElementById('exportSprocketBtn');
      if (exportSprocketBtn) {
        const sprocketKey = isJpeg ? 'exportSprocketJpeg' : (format === 'tiff' ? 'exportSprocketTiff' : 'exportSprocketPng');
        exportSprocketBtn.textContent = i18n[currentLang][sprocketKey];
        exportSprocketBtn.setAttribute('data-i18n', sprocketKey);
      }

      // Update export current button text
      const exportSingleBtn = document.getElementById('exportSingleBtn');
      const exportSingleKey = isJpeg ? 'exportCurrentJpeg' : (format === 'tiff' ? 'exportCurrentTiff' : 'exportCurrent');
      exportSingleBtn.textContent = i18n[currentLang][exportSingleKey];
      exportSingleBtn.setAttribute('data-i18n', exportSingleKey);

      const bitDepthButtons = document.querySelectorAll('.bitdepth-btn');
      bitDepthButtons.forEach((btn) => {
        const depth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        btn.textContent = depth === 16 ? '16-bit' : '8-bit';
      });
      updateSprocketControlsUI();
    }

    updateExportUI();

    // ===========================================
    // Batch Processing
    // ===========================================
    function extractCurrentSettings() {
      const safe = sanitizeSettings(state, { fallbackSettings: state });
      return {
        cropRegion: safe.cropRegion ? { ...safe.cropRegion } : null,
        rotationAngle: safe.rotationAngle || 0,
        autoFrameMeta: state.autoFrame.lastDiagnostics ? { ...state.autoFrame.lastDiagnostics } : null,
        filmType: safe.filmType,
        filmBase: { ...safe.filmBase },
        lensCorrection: {
          enabled: Boolean(safe.lensCorrection.enabled),
          selectedLens: safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null,
          params: { ...safe.lensCorrection.params },
          modes: { ...safe.lensCorrection.modes },
          lastError: safe.lensCorrection.lastError || ''
        },
        coreFilmPreset: safe.coreFilmPreset,
        coreColorModel: safe.coreColorModel,
        coreEnhancedProfile: safe.coreEnhancedProfile,
        coreProfileStrength: safe.coreProfileStrength,
        corePreSaturation: safe.corePreSaturation,
        coreBorderBuffer: safe.coreBorderBuffer,
        coreBorderBufferBorderValue: safe.coreBorderBufferBorderValue,
        coreBrightness: safe.coreBrightness,
        coreExposure: safe.coreExposure,
        coreContrast: safe.coreContrast,
        coreHighlights: safe.coreHighlights,
        coreShadows: safe.coreShadows,
        coreWhites: safe.coreWhites,
        coreBlacks: safe.coreBlacks,
        coreWbMode: safe.coreWbMode,
        coreTemperature: safe.coreTemperature,
        coreTint: safe.coreTint,
        coreSaturation: safe.coreSaturation,
        coreGlow: safe.coreGlow,
        coreFade: safe.coreFade,
        coreCurvePrecision: safe.coreCurvePrecision,
        coreUseWebGL: safe.coreUseWebGL,
        exposure: safe.exposure,
        contrast: safe.contrast,
        highlights: safe.highlights,
        shadows: safe.shadows,
        temperature: safe.temperature,
        tint: safe.tint,
        vibrance: safe.vibrance,
        saturation: safe.saturation,
        cyan: safe.cyan,
        magenta: safe.magenta,
        yellow: safe.yellow,
        wbR: safe.wbR,
        wbG: safe.wbG,
        wbB: safe.wbB,
        grayPointSampled: Boolean(safe.grayPointSampled),
        curvePoints: {
          r: safe.curvePoints.r.map(p => ({ ...p })),
          g: safe.curvePoints.g.map(p => ({ ...p })),
          b: safe.curvePoints.b.map(p => ({ ...p }))
        },
        curves: {
          r: new Uint8Array(safe.curves.r),
          g: new Uint8Array(safe.curves.g),
          b: new Uint8Array(safe.curves.b)
        }
      };
    }

    function cloneSettings(settings) {
      if (!settings) return null;
      const safe = sanitizeSettings(settings, { fallbackSettings: state });
      return {
        cropRegion: safe.cropRegion ? { ...safe.cropRegion } : null,
        rotationAngle: safe.rotationAngle,
        autoFrameMeta: safe.autoFrameMeta ? { ...safe.autoFrameMeta } : null,
        filmType: safe.filmType,
        filmBase: { ...safe.filmBase },
        lensCorrection: {
          enabled: Boolean(safe.lensCorrection.enabled),
          selectedLens: safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null,
          params: { ...safe.lensCorrection.params },
          modes: { ...safe.lensCorrection.modes },
          lastError: safe.lensCorrection.lastError || ''
        },
        coreFilmPreset: safe.coreFilmPreset,
        coreColorModel: safe.coreColorModel,
        coreEnhancedProfile: safe.coreEnhancedProfile,
        coreProfileStrength: safe.coreProfileStrength,
        corePreSaturation: safe.corePreSaturation,
        coreBorderBuffer: safe.coreBorderBuffer,
        coreBorderBufferBorderValue: safe.coreBorderBufferBorderValue,
        coreBrightness: safe.coreBrightness,
        coreExposure: safe.coreExposure,
        coreContrast: safe.coreContrast,
        coreHighlights: safe.coreHighlights,
        coreShadows: safe.coreShadows,
        coreWhites: safe.coreWhites,
        coreBlacks: safe.coreBlacks,
        coreWbMode: safe.coreWbMode,
        coreTemperature: safe.coreTemperature,
        coreTint: safe.coreTint,
        coreSaturation: safe.coreSaturation,
        coreGlow: safe.coreGlow,
        coreFade: safe.coreFade,
        coreCurvePrecision: safe.coreCurvePrecision,
        coreUseWebGL: safe.coreUseWebGL,
        exposure: safe.exposure,
        contrast: safe.contrast,
        highlights: safe.highlights,
        shadows: safe.shadows,
        temperature: safe.temperature,
        tint: safe.tint,
        vibrance: safe.vibrance,
        saturation: safe.saturation,
        cyan: safe.cyan,
        magenta: safe.magenta,
        yellow: safe.yellow,
        wbR: safe.wbR,
        wbG: safe.wbG,
        wbB: safe.wbB,
        grayPointSampled: Boolean(safe.grayPointSampled),
        curvePoints: {
          r: safe.curvePoints.r.map(p => ({ ...p })),
          g: safe.curvePoints.g.map(p => ({ ...p })),
          b: safe.curvePoints.b.map(p => ({ ...p }))
        },
        curves: {
          r: new Uint8Array(safe.curves.r),
          g: new Uint8Array(safe.curves.g),
          b: new Uint8Array(safe.curves.b)
        }
      };
    }

    function markCurrentFileDirty() {
      const item = getCurrentQueueItem();
      if (!item) return;
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
      if (!state.originalImageData) return false;
      if (!force && !item.isDirty && item.settings) return false;

      item.settings = extractCurrentSettings();
      item.isDirty = false;
      updateFileListUI();

      if (!silent) {
        alert(i18n[currentLang].settingsSaved || 'Settings saved for current image');
      }
      return true;
    }

    function applySettingsToItems(baseSettings, items, options = {}) {
      const includeCrop = Boolean(options.includeCrop);
      const copied = cloneSettings(baseSettings);
      if (!copied) return 0;

      let count = 0;
      items.forEach(item => {
        const next = cloneSettings(copied);
        if (!includeCrop) {
          const existingCrop = item.settings && item.settings.cropRegion ? { ...item.settings.cropRegion } : null;
          const existingRotation = item.settings && Number.isFinite(item.settings.rotationAngle)
            ? item.settings.rotationAngle
            : 0;
          next.cropRegion = existingCrop;
          next.rotationAngle = existingRotation;
        }
        item.settings = next;
        item.isDirty = false;
        count++;
      });
      return count;
    }

    function applyCurrentSettingsToSelected() {
      if (state.currentStep < 3 || !state.processedImageData) {
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }

      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) {
        alert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
        return;
      }

      const baseSettings = extractCurrentSettings();
      applySettingsToItems(baseSettings, selectedItems, { includeCrop: false });

      updateFileListUI();
      const template = i18n[currentLang].appliedToSelected || 'Applied current settings to {count} image(s).';
      alert(template.replace('{count}', String(selectedItems.length)));
    }

    function setRollReferenceFromCurrent() {
      if (state.currentStep < 3 || !state.processedImageData) {
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }
      const currentItem = getCurrentQueueItem();
      state.rollReference.enabled = true;
      state.rollReference.sourceFileId = currentItem ? currentItem.id : null;
      state.rollReference.settingsSnapshot = extractCurrentSettings();
      persistCurrentFileSettings({ silent: true, force: true });
      updateRollReferenceUI();
      updateStep2GuideCard({ skipFirstHint: true });
      alert(i18n[currentLang].rollReferenceSet || 'Current image has been set as the roll reference.');
    }

    function applyRollReferenceToSelected() {
      if (!hasRollReference()) {
        alert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) {
        alert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
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
      alert(template.replace('{count}', String(applied)));
    }

    function clearRollReference() {
      resetRollReferenceState();
      updateRollReferenceUI();
      updateStep2GuideCard({ skipFirstHint: true });
      alert(i18n[currentLang].rollReferenceCleared || 'Roll reference cleared.');
    }

    function getSettingsForExport(index, item) {
      if (!item) return null;
      if (index === state.currentFileIndex && (item.isDirty || !item.settings)) {
        persistCurrentFileSettings({ silent: true, force: true });
      }
      return item.settings || null;
    }

    async function applyAdjustmentsWithSettings(imageData, settings) {
      const adjustmentSettings = buildAdjustmentSettings(settings);

      // Try Worker for large images (>1MP)
      if (imageData.width * imageData.height > 1_000_000 && isWorkerAvailable()) {
        const result = await workerApplyAdjustments(imageData, adjustmentSettings, 'full');
        if (result) return result;
      }

      // Fallback to main thread
      const output = new ImageData(new Uint8ClampedArray(imageData.data.length), imageData.width, imageData.height);
      applyPreparedAdjustmentsToBuffer(imageData, adjustmentSettings, output, {
        quality: 'full',
        lutScratch: adjustmentLutScratch
      });
      return output;
    }

    function sanitizeCropRegionForImage(cropRegion, imageData) {
      if (!cropRegion || !imageData) return null;
      const imageWidth = imageData.width | 0;
      const imageHeight = imageData.height | 0;
      if (imageWidth < 1 || imageHeight < 1) return null;

      const leftRaw = Number(cropRegion.left);
      const topRaw = Number(cropRegion.top);
      const widthRaw = Number(cropRegion.width);
      const heightRaw = Number(cropRegion.height);
      if (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw) || !Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) {
        return null;
      }

      const left = clampBetween(Math.floor(leftRaw), 0, imageWidth - 1);
      const top = clampBetween(Math.floor(topRaw), 0, imageHeight - 1);
      const maxWidth = imageWidth - left;
      const maxHeight = imageHeight - top;
      if (maxWidth < 1 || maxHeight < 1) return null;

      const width = clampBetween(Math.floor(widthRaw), 1, maxWidth);
      const height = clampBetween(Math.floor(heightRaw), 1, maxHeight);
      if (width < 1 || height < 1) return null;

      return { left, top, width, height };
    }

    function applyCropRegionToLoadedImage(cropRegion, options = {}) {
      const { refreshDisplay = false } = options;
      if (!state.originalImageData) {
        state.cropRegion = null;
        state.croppedImageData = null;
        return false;
      }

      const sanitized = sanitizeCropRegionForImage(cropRegion, state.originalImageData);
      state.cropRegion = sanitized;
      state.croppedImageData = sanitized ? cropImageData(state.originalImageData, sanitized) : null;

      if (refreshDisplay) {
        displayNegative(state.croppedImageData || state.originalImageData);
      }
      return Boolean(sanitized);
    }

    function cropImageData(imageData, cropRegion) {
      const sanitized = sanitizeCropRegionForImage(cropRegion, imageData);
      if (!sanitized) return imageData;
      return cropImageDataRegion(imageData, sanitized);
    }

    async function loadFileToImageData(file) {
      const fileName = file.name.toLowerCase();

      if (isRawLikeFileName(fileName)) {
        const arrayBuffer = await file.arrayBuffer();
        return await loadRawImageData(arrayBuffer, fileName);
      } else if (file.type === 'image/png') {
        const arrayBuffer = await file.arrayBuffer();
        return await loadPngImageData(arrayBuffer);
      } else {
        return await loadStandardImage(file);
      }
    }

    async function imageDataToBlob(imageData, format = null, quality = null, bitDepth = null, onProgress = null) {
      const exportInfo = getExportInfo(format || state.exportFormat, bitDepth ?? state.exportBitDepth);
      const jpegQuality = quality !== null ? quality : state.jpegQuality;
      const trace = createPerfTrace('imageDataToBlob', {
        format: exportInfo.format,
        bitDepth: exportInfo.bitDepth,
        pixels: getImageDataPixelCount(imageData)
      });
      let blob = null;

      if (exportInfo.format === 'tiff') {
        // Try Worker first for TIFF encoding
        if (isWorkerAvailable()) {
          blob = await workerEncodeTiff(imageData, exportInfo.bitDepth, onProgress);
          if (blob) {
            trace.end({ bytes: blob.size || 0, worker: true });
            return blob;
          }
        }
        const { encodeTiffBlob } = await getExportImageEncoders();
        blob = encodeTiffBlob(imageData, exportInfo.bitDepth);
        trace.end({ bytes: blob.size || 0, worker: false });
        return blob;
      }
      if (exportInfo.format === 'png' && exportInfo.bitDepth === 16) {
        // Try Worker first for 16-bit PNG encoding
        if (isWorkerAvailable()) {
          blob = await workerEncodePng16(imageData, onProgress);
          if (blob) {
            trace.end({ bytes: blob.size || 0, worker: true });
            return blob;
          }
        }
        const { encodePng16Blob } = await getExportImageEncoders();
        blob = encodePng16Blob(imageData);
        trace.end({ bytes: blob.size || 0, worker: false });
        return blob;
      }

      if (exportInfo.format === 'jpeg') {
        blob = await imageDataToCanvasBlob(imageData, 'image/jpeg', jpegQuality / 100);
        trace.end({ bytes: blob.size || 0, worker: false });
        return blob;
      }
      blob = await imageDataToCanvasBlob(imageData, 'image/png');
      trace.end({ bytes: blob.size || 0, worker: false });
      return blob;
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
    async function processOneFile(file, settings) {
      const safeSettings = sanitizeSettings(settings, { fallbackSettings: state });
      const imageData = await loadFileToImageData(file);

      let workingData = imageData;
      const rotationAngle = Number.isFinite(safeSettings.rotationAngle) ? safeSettings.rotationAngle : 0;
      if (Math.abs(rotationAngle) > 0.001) {
        workingData = applyRotationToImageData(workingData, rotationAngle);
      }
      if (safeSettings.cropRegion) {
        const cropRegion = sanitizeCropRegionForImage(safeSettings.cropRegion, workingData);
        if (cropRegion) {
          workingData = cropImageData(workingData, cropRegion);
        }
      }
      workingData = await applyLensCorrectionWithSettings(workingData, safeSettings, { updateUi: false });

      const processed = await convertFrameWithRouter({
        imageData: workingData,
        settings: buildRouterSettings(safeSettings)
      });

      return applyAdjustmentsWithSettings(processed, safeSettings);
    }

    // Get selected files for batch processing
    function getSelectedFiles() {
      return state.fileQueue
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.selected);
    }

    // Create default settings with auto-detected film base
    function createDefaultSettings(imageData) {
      const filmBase = autoDetectFilmBase(imageData, 10);
      return {
        cropRegion: null,
        rotationAngle: 0,
        autoFrameMeta: null,
        filmType: 'color',
        filmBase: filmBase,
        lensCorrection: createDefaultLensCorrectionSettings(),
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

    // Process a file with its own settings or auto-detect
    async function processFileWithSettings(file, savedSettings, options = {}) {
      const trace = createPerfTrace('processFileWithSettings', {
        file: file?.name || '',
        bytes: file?.size || 0
      });
      // Load the image
      const imageData = await loadFileToImageData(file);
      trace.mark('load', {
        pixels: getImageDataPixelCount(imageData)
      });

      // Use saved settings or create default with auto-detect
      const settings = sanitizeSettings(savedSettings || createDefaultSettings(imageData), {
        fallbackSettings: state
      });

      // Apply crop if set
      let workingData = imageData;
      const rotationAngle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
      if (Math.abs(rotationAngle) > 0.001) {
        workingData = applyRotationToImageData(workingData, rotationAngle);
      }
      if (settings.cropRegion) {
        const cropRegion = sanitizeCropRegionForImage(settings.cropRegion, workingData);
        if (cropRegion) {
          workingData = cropImageData(workingData, cropRegion);
        }
      }
      workingData = await applyLensCorrectionWithSettings(workingData, settings, { updateUi: false });
      trace.mark('transform', {
        pixels: getImageDataPixelCount(workingData)
      });

      // Convert negative/positive via unified conversion router.
      let processed = await convertFrameWithRouter({
        imageData: workingData,
        settings: buildRouterSettings(settings)
      });
      trace.mark('convert', {
        pixels: getImageDataPixelCount(processed)
      });

      // Apply dust removal if enabled (full resolution for export)
      const dustRemoval = options.dustRemoval || state.dustRemoval;
      if (dustRemoval && dustRemoval.enabled && processed) {
        await ensureOpenCvReady();
        const strength = Number.isFinite(dustRemoval.strength) ? dustRemoval.strength : state.dustRemoval.strength;
        const { mask } = detectDust(processed, { strength });
        processed = inpaintMasked(processed, mask, 3);
        trace.mark('dustRemoval', {
          pixels: getImageDataPixelCount(processed)
        });
      }

      // Apply adjustments
      const adjusted = await applyAdjustmentsWithSettings(processed, settings);
      trace.mark('adjustments', {
        pixels: getImageDataPixelCount(adjusted)
      });
      trace.end({
        outputPixels: getImageDataPixelCount(adjusted)
      });
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

    async function exportBatchAsZipDesktop(selectedFiles, zipFileName) {
      const JSZipCtor = await getJSZipCtor();
      if (typeof JSZipCtor !== 'function') {
        throw new Error('JSZip module is unavailable');
      }

      let desktopZipTargetPath = null;
      if (isTauriDesktop()) {
        // Pick the destination before the long-running batch starts so macOS can
        // surface the save panel immediately instead of after processing finishes.
        desktopZipTargetPath = await pickDesktopSavePath(zipFileName);
        if (!desktopZipTargetPath) {
          handleSaveResult({ saved: false, path: null }, {
            cancelledKey: 'zipSaveCancelled',
            cancelledFallback: 'ZIP save cancelled. No file was written.'
          });
          return;
        }
      }

      const zip = new JSZipCtor();
      const exportInfo = getExportInfo();
      let processedCount = 0;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const total = selectedFiles.length;

      await overlay.show({ title: lang.loadingExporting });

      try {
        for (const { item, index } of selectedFiles) {
          item.status = 'processing';
          updateFileListUI();
          processedCount++;
          const fileProgress = ((processedCount - 1) / total) * 90;
          const fileSlice = 90 / total;
          overlay.updateProgress(fileProgress, lang.loadingBatchFile.replace('{current}', processedCount).replace('{total}', total));

          try {
            const settingsForFile = getSettingsForExport(index, item);
            const adjusted = await processFileWithSettings(item.file, settingsForFile);
            const outputImageData = applySprocketFrameForExport(adjusted, exportInfo);
            overlay.updateProgress(fileProgress + fileSlice * 0.6, lang.loadingEncoding);
            const blob = await imageDataToBlob(
              outputImageData,
              exportInfo.format,
              state.jpegQuality,
              exportInfo.bitDepth
            );

            const name = buildActiveExportFileName(item.file.name, exportInfo);
            zip.file(name, blob);
            item.status = 'done';
          } catch (err) {
            console.error(`Error processing ${item.file.name}:`, err);
            item.status = 'error';
            item.error = err.message;
          }

          overlay.updateProgress(fileProgress + fileSlice, lang.loadingBatchFile.replace('{current}', processedCount).replace('{total}', total));
          updateFileListUI();
          await new Promise(r => setTimeout(r, 10));
        }

        overlay.updateProgress(92, lang.loadingBatchZip);
        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        const result = desktopZipTargetPath
          ? await writeBlobToDesktopPath(zipBlob, desktopZipTargetPath, 'application/zip')
          : await saveBlob(zipBlob, zipFileName, 'application/zip');
        handleSaveResult(result, {
          cancelledKey: 'zipSaveCancelled',
          cancelledFallback: 'ZIP save cancelled. No file was written.',
          savedPathKey: 'zipSavedTo',
          savedPathFallback: 'ZIP saved to:\n{path}',
          browserSuccessKey: 'zipDownloadStarted',
          browserSuccessFallback: 'ZIP download started. Check your Downloads folder.'
        });
      } finally {
        overlay.hide();
      }
    }

    async function exportBatchAsZipBrowser(selectedFiles, zipFileName) {
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
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const total = selectedFiles.length;
      let successCount = 0;
      let failCount = 0;
      let zipWriter = null;

      await overlay.show({ title: lang.loadingExporting });

      try {
        zipWriter = new ZipStoreWriter(streamTarget.writable);

        for (let i = 0; i < selectedFiles.length; i++) {
          const { item, index } = selectedFiles[i];
          const fileProgress = (i / total) * 95;
          const fileSlice = 95 / total;
          let adjusted = null;
          let blob = null;
          let name = '';

          item.status = 'processing';
          item.error = null;
          updateFileListUI();
          overlay.updateProgress(
            fileProgress,
            lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', total)
          );

          try {
            const settingsForFile = getSettingsForExport(index, item);
            adjusted = await processFileWithSettings(item.file, settingsForFile);
            const outputImageData = applySprocketFrameForExport(adjusted, exportInfo);
            overlay.updateProgress(fileProgress + fileSlice * 0.55, lang.loadingEncoding);
            blob = await imageDataToBlob(
              outputImageData,
              exportInfo.format,
              state.jpegQuality,
              exportInfo.bitDepth,
              (pct) => {
                overlay.updateProgress(
                  fileProgress + fileSlice * (0.55 + pct * 0.25),
                  lang.loadingEncoding
                );
              }
            );
            name = buildActiveExportFileName(item.file.name, exportInfo);
          } catch (err) {
            console.error(`Error processing ${item.file.name}:`, err);
            item.status = 'error';
            item.error = err && err.message ? err.message : String(err || 'Unknown error');
            failCount++;
            updateFileListUI();
            overlay.updateProgress(
              fileProgress + fileSlice,
              lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', total)
            );
            adjusted = null;
            blob = null;
            await waitForNextFrame();
            continue;
          }

          try {
            overlay.updateProgress(fileProgress + fileSlice * 0.86, lang.loadingBatchZip);
            await zipWriter.addBlob(name, blob);
            item.status = 'done';
            item.error = null;
            successCount++;
          } finally {
            adjusted = null;
            blob = null;
          }

          updateFileListUI();
          overlay.updateProgress(
            fileProgress + fileSlice,
            lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', total)
          );
          await waitForNextFrame();
        }

        overlay.updateProgress(98, lang.loadingBatchZip);
        await zipWriter.close();
        zipWriter = null;
        overlay.updateProgress(100, lang.loadingComplete);
        showBrowserZipStreamSummary({
          zipFileName: streamTarget.fileName || zipFileName,
          successCount,
          failCount,
          total
        });
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
        overlay.hide();
      }
    }

    async function exportBatchAsZip() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      const zipFileName = 'converted_negatives.zip';
      if (isTauriDesktop()) {
        await exportBatchAsZipDesktop(selectedFiles, zipFileName);
        return;
      }

      await exportBatchAsZipBrowser(selectedFiles, zipFileName);
    }

    function createBatchExportJobs(selectedFiles, exportInfo) {
      return selectedFiles.map(({ item, index }) => ({
        item,
        index,
        file: item.file,
        outputName: buildActiveExportFileName(item.file.name, exportInfo),
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
      const total = jobs.length;
      const jpegQuality = state.jpegQuality;
      const dustRemoval = {
        enabled: Boolean(state.dustRemoval.enabled),
        strength: state.dustRemoval.strength
      };
      let successCount = 0;
      let failCount = 0;

      resetBatchExportStatuses(jobs);
      setDesktopBatchExportState({
        active: true,
        current: 0,
        total,
        percent: 0,
        fileName: '',
        targetDirectory
      });
      await waitForNextFrame();

      try {
        for (let i = 0; i < jobs.length; i++) {
          const { item, file, outputName, settings } = jobs[i];
          const fileBaseProgress = (i / total) * 100;
          const fileSlice = 100 / total;

          item.status = 'processing';
          item.error = null;
          updateFileListUI();
          setDesktopBatchExportState({
            active: true,
            current: i + 1,
            total,
            percent: fileBaseProgress + fileSlice * 0.05,
            fileName: file.name,
            targetDirectory
          });
          await waitForNextFrame();

          try {
            const adjusted = await processFileWithSettings(file, settings, { dustRemoval });
            const outputImageData = applySprocketFrameForExport(adjusted, exportInfo);
            setDesktopBatchExportState({
              active: true,
              current: i + 1,
              total,
              percent: fileBaseProgress + fileSlice * 0.62,
              fileName: file.name,
              targetDirectory
            });

            const blob = await imageDataToBlob(
              outputImageData,
              exportInfo.format,
              jpegQuality,
              exportInfo.bitDepth,
              (pct) => {
                setDesktopBatchExportState({
                  active: true,
                  current: i + 1,
                  total,
                  percent: fileBaseProgress + fileSlice * (0.62 + pct * 0.3),
                  fileName: file.name,
                  targetDirectory
                });
              }
            );

            await writeBlobToDesktopDirectory(blob, targetDirectory, outputName, exportInfo.mimeType);
            item.status = 'done';
            item.error = null;
            successCount++;
          } catch (err) {
            console.error(`Error processing ${file.name}:`, err);
            item.status = 'error';
            item.error = err && err.message ? err.message : String(err || 'Unknown error');
            failCount++;
          }

          updateFileListUI();
          setDesktopBatchExportState({
            active: true,
            current: i + 1,
            total,
            percent: fileBaseProgress + fileSlice,
            fileName: file.name,
            targetDirectory
          });
          await waitForNextFrame();
        }
      } finally {
        resetDesktopBatchExportState();
      }

      showDesktopBatchExportSummary({ successCount, failCount, total, targetDirectory });
    }

    // Streaming individual download: process → download → free → next
    async function exportBatchIndividuallyBrowser() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      const exportInfo = getExportInfo();
      let cancelledByUser = false;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const total = selectedFiles.length;

      await overlay.show({ title: lang.loadingExporting });

      try {
        for (let i = 0; i < selectedFiles.length; i++) {
          const { item, index } = selectedFiles[i];
          const fileProgress = (i / total) * 100;
          const fileSlice = 100 / total;
          let adjusted = null;
          let blob = null;
          let name = '';

          item.status = 'processing';
          item.error = null;
          updateFileListUI();
          overlay.updateProgress(fileProgress, lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', total));

          try {
            const settingsForFile = getSettingsForExport(index, item);
            adjusted = await processFileWithSettings(item.file, settingsForFile);
            const outputImageData = applySprocketFrameForExport(adjusted, exportInfo);
            overlay.updateProgress(fileProgress + fileSlice * 0.6, lang.loadingEncoding);
            blob = await imageDataToBlob(
              outputImageData,
              exportInfo.format,
              state.jpegQuality,
              exportInfo.bitDepth,
              (pct) => {
                overlay.updateProgress(
                  fileProgress + fileSlice * (0.6 + pct * 0.3),
                  lang.loadingEncoding
                );
              }
            );

            name = buildActiveExportFileName(item.file.name, exportInfo);
            overlay.hide(); // Hide overlay before save dialog
            const result = await saveBlob(blob, name, exportInfo.mimeType);
            if (!result.saved) {
              cancelledByUser = true;
              item.status = 'pending';
              item.error = null;
              updateFileListUI();
              break;
            }
            // Re-show overlay for next file
            if (i + 1 < total) {
              await overlay.show({ title: lang.loadingExporting });
            }

            item.status = 'done';
            item.error = null;
          } catch (err) {
            console.error(`Error processing ${item.file.name}:`, err);
            item.status = 'error';
            item.error = err && err.message ? err.message : String(err || 'Unknown error');
          } finally {
            adjusted = null;
            blob = null;
            name = '';
          }

          updateFileListUI();
          overlay.updateProgress(fileProgress + fileSlice, lang.loadingBatchFile.replace('{current}', i + 1).replace('{total}', total));
          await waitForNextFrame();
        }
        if (cancelledByUser) {
          console.info('Batch individual export cancelled by user.');
          showToast(
            getLocalizedText(
              'batchDownloadCancelled',
              'Batch export cancelled. Files already saved were kept.'
            ),
            3500
          );
        }
      } finally {
        overlay.hide();
      }
    }

    async function exportBatchIndividually() {
      if (isTauriDesktop()) {
        await exportBatchIndividuallyDesktop();
        return;
      }
      await exportBatchIndividuallyBrowser();
    }

    // ===========================================
    // File List UI
    // ===========================================
    function updateFileListUI() {
      const container = document.getElementById('fileListItems');
      const countEl = document.getElementById('fileListCount');
      renderFileList({
        container,
        countEl,
        items: state.fileQueue,
        currentFileIndex: state.currentFileIndex,
        labels: {
          configured: i18n[currentLang].configured || 'configured',
          customSettings: i18n[currentLang].customSettings || 'Custom',
          unsaved: i18n[currentLang].unsaved || 'Unsaved',
          statusText: (status) => i18n[currentLang][status === 'processing' ? 'processingStatus' : status] || status
        },
        onToggleSelected: (index, selected) => {
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
    }

    async function switchToFile(index) {
      if (index < 0 || index >= state.fileQueue.length) return;
      if (index === state.currentFileIndex) return;

      clearUndoHistory();
      resetZoomPan();
      persistCurrentFileSettings({ silent: true });
      state.currentFileIndex = index;
      const fileItem = state.fileQueue[index];

      // Load the file
      await loadFile(fileItem.file);

      // If this file has saved settings, restore them
      if (fileItem.settings) {
        restoreSettings(fileItem.settings);
        fileItem.isDirty = false;
      }

      updateFileListUI();
    }

    // Save current settings to the current file's queue entry
    function saveCurrentFileSettings() {
      persistCurrentFileSettings({ silent: false, force: true });
    }

    // Restore settings from a saved settings object
    function restoreSettings(settings) {
      if (!settings) return;
      const safe = sanitizeSettings(settings, { fallbackSettings: state });

      state.rotationAngle = Number.isFinite(safe.rotationAngle) ? normalizeAngleDegrees(safe.rotationAngle) : 0;

      if (state.loadedBaseImageData) {
        state.originalImageData = state.loadedBaseImageData;
      }

      if (state.originalImageData && Math.abs(state.rotationAngle) > 0.001) {
        state.originalImageData = applyRotationToImageData(state.originalImageData, state.rotationAngle);
      }

      // Restore crop region after rotation
      applyCropRegionToLoadedImage(safe.cropRegion, { refreshDisplay: true });
      if (state.originalImageData) {
        safe.rotationAngle = state.rotationAngle;
        safe.cropRegion = state.cropRegion ? { ...state.cropRegion } : null;
      }

      if (safe.autoFrameMeta) {
        const restoredMode = safe.autoFrameMeta.appliedMode
          || (Boolean(safe.autoFrameMeta.rotateOnly) ? 'rotateOnly' : 'none');
        state.autoFrame.lastDiagnostics = {
          confidence: safe.autoFrameMeta.confidence,
          detectedFormat: safe.autoFrameMeta.detectedFormat || 'unknown',
          method: safe.autoFrameMeta.method || 'unknown',
          confidenceLevel: safe.autoFrameMeta.confidenceLevel || inferConfidenceLevel(safe.autoFrameMeta.confidence || 0),
          rotateOnly: restoredMode === 'rotateOnly',
          appliedMode: restoredMode,
          lowConfidenceApplied: Boolean(safe.autoFrameMeta.lowConfidenceApplied)
        };
      } else {
        state.autoFrame.lastDiagnostics = null;
      }
      updateAutoFrameDiagnosticsUI();

      // Restore film settings
      state.filmType = sanitizePresetType(safe.filmType || 'color');
      state.filmBase = { ...safe.filmBase };
      state.filmBaseSet = true;
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
      state.grayPointSampled = Boolean(
        safe.grayPointSampled
        || Math.abs(safe.wbR - 1) > 0.01
        || Math.abs(safe.wbB - 1) > 0.01
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
    }

    function updateExportButtons() {
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      const exportLocked = isDesktopBatchExportLocked();
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
      updateAutoFrameButtons();
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
      const option645 = document.getElementById('autoFrame120_645');
      const option66 = document.getElementById('autoFrame120_66');
      const option67 = document.getElementById('autoFrame120_67');
      const option69 = document.getElementById('autoFrame120_69');
      const optionsContainer = document.getElementById('autoFrame120Options');
      if (!enabledInput || !autoApplyInput || !formatSelect || !lowSelect) return;

      normalizeAutoFrame120Options();
      enabledInput.checked = Boolean(state.autoFrame.enabled);
      autoApplyInput.checked = Boolean(state.autoFrame.autoApplyHighConfidence);
      formatSelect.value = state.autoFrame.formatPreference || 'auto';
      lowSelect.value = state.autoFrame.lowConfidenceBehavior || 'suggest';
      if (option645) option645.checked = state.autoFrame.allowed120Formats['6x4.5'] !== false;
      if (option66) option66.checked = state.autoFrame.allowed120Formats['6x6'] !== false;
      if (option67) option67.checked = state.autoFrame.allowed120Formats['6x7'] !== false;
      if (option69) option69.checked = state.autoFrame.allowed120Formats['6x9'] !== false;
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
    }

    function applyAutoFrameConfigFromUI() {
      const enabledInput = document.getElementById('autoFrameEnabledInput');
      const autoApplyInput = document.getElementById('autoFrameAutoApplyInput');
      const formatSelect = document.getElementById('autoFrameFormatSelect');
      const lowSelect = document.getElementById('autoFrameLowConfidenceSelect');
      const option645 = document.getElementById('autoFrame120_645');
      const option66 = document.getElementById('autoFrame120_66');
      const option67 = document.getElementById('autoFrame120_67');
      const option69 = document.getElementById('autoFrame120_69');

      if (enabledInput) state.autoFrame.enabled = Boolean(enabledInput.checked);
      if (autoApplyInput) state.autoFrame.autoApplyHighConfidence = Boolean(autoApplyInput.checked);
      if (formatSelect) state.autoFrame.formatPreference = formatSelect.value === '135' || formatSelect.value === '120' ? formatSelect.value : 'auto';
      if (lowSelect) {
        const value = lowSelect.value;
        state.autoFrame.lowConfidenceBehavior = (value === 'rotateOnly' || value === 'ignore') ? value : 'suggest';
      }

      state.autoFrame.allowed120Formats = {
        '6x4.5': option645 ? Boolean(option645.checked) : true,
        '6x6': option66 ? Boolean(option66.checked) : true,
        '6x7': option67 ? Boolean(option67.checked) : true,
        '6x9': option69 ? Boolean(option69.checked) : true
      };
      normalizeAutoFrame120Options();
      updateAutoFrameConfigUI();
      updateAutoFrameButtons();
    }

    function updateAutoFrameButtons() {
      const currentBtn = document.getElementById('autoFrameBtn');
      const selectedBtn = document.getElementById('autoFrameSelectedBtn');
      if (!currentBtn || !selectedBtn) return;

      const stepReady = state.currentStep === 1;
      currentBtn.disabled = !state.originalImageData || !state.autoFrame.enabled || !stepReady;
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      selectedBtn.disabled = !state.autoFrame.enabled || selectedCount < 1 || !stepReady;
      updateAutoFrameConfigUI();
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
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
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

    ['autoFrameEnabledInput', 'autoFrameAutoApplyInput', 'autoFrameFormatSelect', 'autoFrameLowConfidenceSelect',
      'autoFrame120_645', 'autoFrame120_66', 'autoFrame120_67', 'autoFrame120_69']
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
      state.fileQueue = [];
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
      const supportedExtensions = ['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.dng', '.raf', '.raw', '.rw2', '.pef', '.srw', '.3fr', '.mef', '.orf', '.rwl', '.iiq', '.x3f', '.mrw', '.kdc', '.dcr', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      const validFiles = files.filter(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return supportedExtensions.includes(ext) || file.type.startsWith('image/');
      });

      if (validFiles.length === 0) return;

      // Add files to queue
      for (const file of validFiles) {
        // Avoid duplicates
        const id = createQueueItemId(file);
        if (!state.fileQueue.some(f => f.id === id)) {
          const newItem = {
            id,
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
        }
      }

      if (state.fileQueue.length > 1) {
        state.batchSessionActive = true;
      }
      syncBatchUIState({ reason: 'addFilesToQueue' });

      updateFileListUI();
      updateExportButtons();
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

    [uploadBtn, uploadFolderBtn].forEach(label => {
      if (!label) return;
      label.addEventListener('keydown', handleUploadLabelKeydown);
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

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'fileInput_change_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    folderInput.addEventListener('change', (e) => {
      if (isDesktopBatchExportLocked()) return;
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'folderInput_change_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

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

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'drop_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    // ===========================================
    // Window Resize
    // ===========================================
    window.addEventListener('resize', () => {
      if (canvas.width > 0 && canvas.height > 0) {
        adjustCanvasDisplay(canvas.width, canvas.height);
      }
      if (state.cropping) updateCropOverlayFromDraft();
      const histogramResized = resizeHistogramCanvas();
      if (histogramResized) redrawHistogramIfPossible();
    });
