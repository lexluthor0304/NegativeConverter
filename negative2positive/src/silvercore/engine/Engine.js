/**
 * Engine.js - Main processing orchestrator
 * Coordinates image analysis, curve generation, and LUT application.
 */

import { analyzeImage, applyLUT, adjustSaturation, applyHSLAdjustments } from './ImageProcessor.js'
import { generateCurves } from './CurveEngine.js'
import { computeAutoColor } from './WhiteBalance.js'
import { colorModelToToneProfile, colorModels, toneProfiles, filmWBPresets } from './Presets.js'
import { WebGLRenderer } from './WebGLRenderer.js'
import { loadProfile, applyLut3D } from './EnhancedProfiles.js'
import { applyUnsharpMask } from './Sharpening.js'
import { buildPaperLuts, applyPaperLuts } from './PaperProfiles.js'
import { applyExposureStopsToImage16 } from '../util/localExposure.js'

function isChannelDataOverride(value) {
  return Array.isArray(value) && value.length === 3 && value.every((channel) => channel
    && Number.isFinite(channel.whitePointOrigin)
    && Number.isFinite(channel.blackPointOrigin)
    && Number.isFinite(channel.meanPoint))
}

export class Engine {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.channelData = null
    this.autoColor = null
    this.glRenderer = null
    this.lastLuts = null
    this.enhancedLut = null
  }

  /**
   * Initialize WebGL renderer (call after canvas is ready).
   */
  initWebGL(canvas) {
    try {
      this.glRenderer = new WebGLRenderer(canvas)
      if (!this.glRenderer.available) this.glRenderer = null
    } catch {
      this.glRenderer = null
    }
  }

  /**
   * Load an enhanced profile 3D LUT.
   * @param {string} name - Profile name; see PROFILES in EnhancedProfiles.js
   */
  async setEnhancedProfile(name) {
    if (name === 'none') {
      this.enhancedLut = null
      if (this.glRenderer) this.glRenderer.uploadLut3D(null)
      return
    }
    this.enhancedLut = await loadProfile(name)
    if (this.glRenderer) this.glRenderer.uploadLut3D(this.enhancedLut)
  }

  /**
   * Full processing pipeline: negative -> positive
   * @param {Image16} imageData - Input negative image (16-bit RGBA)
   * @param {Object} params - All UI parameters
   * @returns {Image16} Processed positive image (16-bit RGBA)
   */
  process(imageData, params) {
    this.analyze(imageData, params)

    // 3. Build engine settings from UI params
    const settings = this.buildSettings(params)
    this.lastSettings = settings

    // 4. Generate tone curve LUTs (Uint16Array 65536-entry per channel)
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts

    // 4b. Dodge and burn: local exposure on the negative, after the histogram
    //     analysis (the base exposure is decided before dodging) and before
    //     the curves, like light held back or added under the enlarger.
    this._applyLocalExposure(imageData, params)

    // 5. Apply LUTs + 3D LUT + HSL + saturation (all CPU 16-bit for precision).
    return this._applyLuts(imageData, luts, params)
  }

  // 撮影窓の統計だけを更新する。WB 用の正像標本が不要な調色では描画しない。
  analyze(imageData, params) {
    // 0. Pre-tone saturation, applied to the incoming negative before anything reads
    //    it, so the histogram (and with it the auto white balance and the clip points)
    //    sees the same pixels the curves will shape. Callers hand in a fresh working
    //    buffer every time, so this never compounds across renders.
    this._applyPreSaturation(imageData, params)

    // 1. Analyze the negative (histogram-based black/white/mean points). A roll
    //    analysis hands in shared channelData instead so every frame of the roll
    //    gets the same curves; this frame's own histogram is then not consulted.
    this.channelData = isChannelDataOverride(params.analysisOverride)
      ? params.analysisOverride.map((channel) => ({ ...channel }))
      : analyzeImage(imageData, params)

    // 2. Compute auto color correction
    this.autoColor = computeAutoColor(this.channelData)

    this.lastLuts = null
  }

  /**
   * Re-apply LUTs without re-analyzing (for slider changes).
   */
  reprocess(imageData, params) {
    if (!this.channelData) return this.process(imageData, params)

    this._applyPreSaturation(imageData, params)

    const settings = this.buildSettings(params)
    this.lastSettings = settings
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts

    this._applyLocalExposure(imageData, params)
    return this._applyLuts(imageData, luts, params)
  }

  // 同一設定で標本と出力画像を連続処理するときだけ使う。曲線を二重生成しない。
  // 入力は未処理の独立バッファ。preSaturation をそれぞれ一度だけ適用する。
  applyCurrentCurves(imageData, params) {
    if (!this.lastLuts) return this.reprocess(imageData, params)
    this._applyPreSaturation(imageData, params)
    this._applyLocalExposure(imageData, params)
    return this._applyLuts(imageData, this.lastLuts, params)
  }

  _applyLocalExposure(imageData, params) {
    const stops = params.localExposureStops
    if (!stops || stops.length !== imageData.width * imageData.height) return
    applyExposureStopsToImage16(imageData, stops)
  }

  // Paper LUTs are rebuilt only when the paper, toning or strength change.
  _paperLuts(settings) {
    const key = `${settings.paper}|${settings.paperToning}|${settings.paperToningStrength}`
    if (!this._paperCache || this._paperCache.key !== key) {
      this._paperCache = {
        key,
        luts: buildPaperLuts(settings.paper, {
          toning: settings.paperToning,
          toningStrength: settings.paperToningStrength / 100,
        }),
      }
    }
    return this._paperCache.luts
  }

  /**
   * Pre-tone saturation (0-200, 100 = unchanged) on the input buffer. Because the
   * negative is a linear inversion of the positive, scaling chroma around luma here is
   * equivalent to scaling it on the positive — but it happens before the tone curves
   * rather than after, so the curves and the histogram analysis both see it.
   * The adapter treats preSaturation as an analysis input, so changing it re-runs
   * process() rather than reprocess().
   */
  _applyPreSaturation(imageData, params) {
    const preSaturation = params.preSaturation ?? 100
    if (preSaturation === 100) return
    adjustSaturation(imageData, preSaturation)
  }

  /**
   * Apply 1D LUTs, optional 3D LUT, and saturation — full CPU 16-bit.
   * WebGL path is currently disabled in the 16-bit pipeline (shaders + LUT textures
   * are 8-bit; preserving full precision requires GPU upgrade work that is out of
   * scope for this stage).
   */
  _applyLuts(imageData, luts, params) {
    void params
    const lutStrength = this.enhancedLut ? (params.profileStrength ?? 100) : 0
    const saturation = params.saturation ?? 100
    const hslAdj = this.lastSettings ? this.lastSettings.hslAdjustments : null

    applyLUT(imageData, luts.r, luts.g, luts.b)
    applyHSLAdjustments(imageData, hslAdj)
    if (this.enhancedLut && lutStrength > 0) {
      applyLut3D(imageData, this.enhancedLut, lutStrength)
    }
    if (saturation !== 100) {
      adjustSaturation(imageData, saturation)
    }
    // Paper emulation: the print's characteristic curve, density limits, base
    // tint and toning, after every colour decision and before sharpening.
    if (this.lastSettings && this.lastSettings.paper && this.lastSettings.paper !== 'none') {
      applyPaperLuts(imageData, this._paperLuts(this.lastSettings))
    }
    if (this.lastSettings && this.lastSettings.sharpenAmount > 0) {
      applyUnsharpMask(imageData, {
        amount: this.lastSettings.sharpenAmount,
        radius: this.lastSettings.sharpenRadius,
        threshold: this.lastSettings.sharpenThreshold,
      })
    }
    return imageData
  }

  /**
   * Map UI params to engine settings format.
   */
  buildSettings(params) {
    // A film preset can name the tone profile outright (all 37 do). Without this the
    // profile came from the colour model alone, so every preset ran on 'standard' —
    // auto-tone on, contrast +10 — and none of the base_*/filmic_* designs applied.
    const toneProfile = (params.toneProfile && toneProfiles[params.toneProfile])
      ? params.toneProfile
      : (colorModelToToneProfile[params.colorModel] || 'standard')
    const profileData = toneProfiles[toneProfile] || toneProfiles.standard
    const autoColor = this.autoColor || { tempCorrection: 0, tintCorrection: 0, cyanCorrection: 0 }

    // Color model defaults, scaled by profile strength
    const model = colorModels[params.colorModel] || colorModels.basic
    const pStr = (params.profileStrength ?? 100) / 100

    // Auto level scaling (Phase 7)
    const autoToneLevel = (params.autoToneLevel ?? 100) / 100
    const autoColorLevel = (params.autoColorLevel ?? 100) / 100

    // Film WB base offsets (Phase 6)
    const filmWB = filmWBPresets[params.filmWB] || filmWBPresets.none || { temp: 0, tint: 0, cyan: 0 }

    const tempVal = (params.temperature || 0) + autoColor.tempCorrection * autoColorLevel + (model.defaultTemp || 0) * pStr + filmWB.temp
    const tintVal = (params.tint || 0) + autoColor.tintCorrection * autoColorLevel + (model.defaultTint || 0) * pStr + filmWB.tint
    // colorCyan is the user's cyan/red control (the enlarger's C filtration);
    // it joins the automatic and model corrections like temperature and tint.
    const cyanVal = (params.colorCyan || 0) + autoColor.cyanCorrection * autoColorLevel + (model.defaultCyan || 0) * pStr + filmWB.cyan

    const imageType = params.imageType || 'negative'

    return {
      toneProfile,
      imageType,
      brightness: params.brightness || 0,
      exposure: params.exposure || 0,
      contrast: params.contrast || 0,
      highlights: params.highlights || 0,
      shadows: params.shadows || 0,
      whites: params.whites || 0,
      blacks: params.blacks || 0,
      glow: params.glow || 0,
      fade: params.fade || 0,
      temp: tempVal,
      tint: tintVal,
      temperature: params.temperature || 0,
      cyan: cyanVal,
      wbCyan: cyanVal,
      wbTemp: tempVal,
      wbTint: tintVal,
      wbTonality: params.wbTonality || 'addDensity',
      wbMethod: params.wbMode || 'linearFixed',
      layerOrder: params.layerOrder || 'colorFirst',
      softHigh: 0,
      softLow: 0,
      softHighlights: profileData.softHighlights ?? false,
      softShadows: profileData.softShadows ?? false,
      shadowRange: params.shadowRange ?? 5,
      highlightRange: params.highlightRange ?? 5,
      shadowCyan: (params.shadowCyan || 0) + (model.defaultShadowsCyan || 0) * pStr,
      shadowTint: (params.shadowTint || 0) + (model.defaultShadowsTint || 0) * pStr,
      shadowTemp: (params.shadowTemp || 0) + (model.defaultShadowsTemp || 0) * pStr,
      highlightCyan: (params.highlightCyan || 0) + (model.defaultHighlightsCyan || 0) * pStr,
      highlightTint: (params.highlightTint || 0) + (model.defaultHighlightsTint || 0) * pStr,
      highlightTemp: (params.highlightTemp || 0) + (model.defaultHighlightsTemp || 0) * pStr,
      midCyan: params.midCyan || 0,
      midTint: params.midTint || 0,
      midTemp: params.midTemp || 0,
      curvePrecision: params.curvePrecision || 'auto',
      // `?? 10`, not `|| 10`: 0 is a legal Border Buffer (analyse the whole frame).
      borderBuffer: params.borderBuffer ?? 10,
      analysisRegion: params.analysisRegion || null,
      colorModel: params.colorModel || 'standard',
      preSaturation: params.preSaturation ?? 100,
      saturation: params.saturation || 100,
      autoToneLevel,
      autoColorLevel,
      sharpenAmount: params.sharpenAmount || 0,
      sharpenRadius: params.sharpenRadius ?? 1.0,
      sharpenThreshold: params.sharpenThreshold ?? 0,
      paper: params.paper || 'none',
      paperToning: params.paperToning || 'none',
      paperToningStrength: params.paperToningStrength ?? 100,
      hslAdjustments: model.hslAdjustments ? {
        redHue: (model.hslAdjustments.redHue || 0) * pStr,
        redSaturation: (model.hslAdjustments.redSaturation || 0) * pStr,
        greenHue: (model.hslAdjustments.greenHue || 0) * pStr,
        greenSaturation: (model.hslAdjustments.greenSaturation || 0) * pStr,
        blueHue: (model.hslAdjustments.blueHue || 0) * pStr,
        blueSaturation: (model.hslAdjustments.blueSaturation || 0) * pStr,
      } : null,
    }
  }
}
