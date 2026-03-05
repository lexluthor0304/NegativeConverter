/**
 * Engine.js - Main processing orchestrator
 * Coordinates image analysis, curve generation, and LUT application.
 */

import { analyzeImage, applyLUT, adjustSaturation, applyHSLAdjustments } from './ImageProcessor.js'
import { generateCurves } from './CurveEngine.js'
import { computeAutoColor } from './WhiteBalance.js'
import { colorModelToToneProfile, colorModels } from './Presets.js'
import { WebGLRenderer } from './WebGLRenderer.js'
import { loadProfile, applyLut3D } from './EnhancedProfiles.js'

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
   * @param {string} name - Profile name ('none', 'frontier', 'crystal', 'natural', 'pakon')
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
   * @param {ImageData} imageData - Input negative image
   * @param {Object} params - All UI parameters
   * @returns {ImageData} Processed positive image
   */
  process(imageData, params) {
    // 1. Analyze the negative (histogram-based black/white/mean points)
    this.channelData = analyzeImage(imageData, params)

    // 2. Compute auto color correction
    this.autoColor = computeAutoColor(this.channelData)

    // 3. Build engine settings from UI params
    const settings = this.buildSettings(params)
    this.lastSettings = settings

    // 4. Generate tone curve LUTs
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts

    // 5. Apply LUTs + 3D LUT + HSL + saturation
    return this._applyLuts(imageData, luts, params)
  }

  /**
   * Re-apply LUTs without re-analyzing (for slider changes).
   */
  reprocess(imageData, params) {
    if (!this.channelData) return this.process(imageData, params)

    const settings = this.buildSettings(params)
    this.lastSettings = settings
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts

    return this._applyLuts(imageData, luts, params)
  }

  /**
   * Apply 1D LUTs, optional 3D LUT, and saturation.
   */
  _applyLuts(imageData, luts, params) {
    const useWebGL = params.useWebGL !== false && this.glRenderer
    const lutStrength = this.enhancedLut ? (params.profileStrength ?? 100) : 0
    const saturation = params.saturation ?? 100
    const hslAdj = this.lastSettings ? this.lastSettings.hslAdjustments : null

    if (useWebGL) {
      const webgl2 = this.glRenderer.isWebGL2
      // WebGL2: shader handles 1D LUT + 3D LUT + saturation
      // WebGL1: shader handles 1D LUT only when 3D LUT is needed
      const needs3DCPU = this.enhancedLut && lutStrength > 0 && !webgl2
      // When HSL or 3D CPU is needed, disable shader saturation (apply after)
      const needsPostProcess = needs3DCPU || hslAdj
      const shaderSat = needsPostProcess ? 100 : saturation
      const shaderLutStr = webgl2 ? lutStrength : 0

      const result = this.glRenderer.render(
        imageData, luts.r, luts.g, luts.b,
        shaderSat, shaderLutStr
      )
      if (result) {
        applyHSLAdjustments(result, hslAdj)
        if (needs3DCPU) {
          applyLut3D(result, this.enhancedLut, lutStrength)
        }
        if (needsPostProcess && saturation !== 100) {
          adjustSaturation(result, saturation)
        }
        return result
      }
    }

    // Full CPU fallback
    applyLUT(imageData, luts.r, luts.g, luts.b)
    applyHSLAdjustments(imageData, hslAdj)
    if (this.enhancedLut && lutStrength > 0) {
      applyLut3D(imageData, this.enhancedLut, lutStrength)
    }
    if (saturation !== 100) {
      adjustSaturation(imageData, saturation)
    }
    return imageData
  }

  /**
   * Map UI params to engine settings format.
   */
  buildSettings(params) {
    const toneProfile = colorModelToToneProfile[params.colorModel] || 'standard'
    const autoColor = this.autoColor || { tempCorrection: 0, tintCorrection: 0, cyanCorrection: 0 }

    // Color model defaults, scaled by profile strength
    const model = colorModels[params.colorModel] || colorModels.basic
    const pStr = (params.profileStrength ?? 100) / 100

    const tempVal = (params.temperature || 0) + autoColor.tempCorrection + (model.defaultTemp || 0) * pStr
    const tintVal = (params.tint || 0) + autoColor.tintCorrection + (model.defaultTint || 0) * pStr

    return {
      toneProfile,
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
      cyan: (autoColor.cyanCorrection || 0) + (model.defaultCyan || 0) * pStr,
      wbTemp: tempVal,
      wbTint: tintVal,
      wbMethod: params.wbMode || 'linearFixed',
      layerOrder: 'colorFirst',
      softHigh: 0,
      softLow: 0,
      softHighlights: false,
      softShadows: false,
      shadowRange: 5,
      highlightRange: 5,
      shadowCyan: (model.defaultShadowsCyan || 0) * pStr,
      shadowTint: (model.defaultShadowsTint || 0) * pStr,
      shadowTemp: (model.defaultShadowsTemp || 0) * pStr,
      highlightCyan: (model.defaultHighlightsCyan || 0) * pStr,
      highlightTint: (model.defaultHighlightsTint || 0) * pStr,
      highlightTemp: (model.defaultHighlightsTemp || 0) * pStr,
      curvePrecision: params.curvePrecision || 'auto',
      borderBuffer: params.borderBuffer || 10,
      colorModel: params.colorModel || 'standard',
      preSaturation: params.preSaturation || 100,
      saturation: params.saturation || 100,
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
