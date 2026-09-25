/**
 * Engine.js - Main processing orchestrator
 * Coordinates image analysis, curve generation, and LUT application.
 */

import { analyzePositive, applyPositiveAnalysis, identityPositiveChannels } from './PositiveProcessing.js'
import { analyzeImage, applyLUT, applyLUTInto, applyFoldedLUT, adjustSaturation, applyHSLAdjustments } from './ImageProcessor.js'
import { generateCurves } from './CurveEngine.js'
import { computeAutoColor } from './WhiteBalance.js'
import { colorModelToToneProfile, colorModels, toneProfiles, filmWBPresets } from './Presets.js'
import { loadProfile, applyLut3D } from './EnhancedProfiles.js'
import { applyUnsharpMask } from './Sharpening.js'
import { buildPaperLuts, applyPaperLuts } from './PaperProfiles.js'
import { applyExposureStopsToImage16, exposureStopsCover } from '../util/localExposure.js'

// A 65536 × 1 RGBA16 grey ramp (R = G = B = v). Stages that only map a pixel's own
// value can be evaluated once over it instead of over every pixel of a grey image.
let greyRamp = null
function greyRampSource() {
  if (!greyRamp) {
    greyRamp = new Uint16Array(65536 * 4)
    for (let v = 0; v < 65536; v++) {
      greyRamp[v * 4] = greyRamp[v * 4 + 1] = greyRamp[v * 4 + 2] = v
      greyRamp[v * 4 + 3] = 65535
    }
  }
  return greyRamp
}

function freshGreyRamp() {
  return { width: 65536, height: 1, data: new Uint16Array(greyRampSource()) }
}

// The ramp refilled into a plane the caller keeps (the GPU preview's ticks, #239).
function refilledGreyRamp(plane) {
  const target = plane || { width: 65536, height: 1, data: new Uint16Array(65536 * 4) }
  target.data.set(greyRampSource())
  return target
}

let preSaturationRampCache = null
let saturationRampCache = null
let saturationRampScratch = null

// S[v] = adjustSaturation of the grey pixel (v, v, v), computed by the unchanged
// adjustSaturation (its truncation drift included).
function greySaturationRamp(amount) {
  const ramp = saturationRampScratch = refilledGreyRamp(saturationRampScratch)
  adjustSaturation(ramp, amount)
  const table = new Uint16Array(65536)
  for (let v = 0; v < 65536; v++) table[v] = ramp.data[v * 4]
  return table
}

// Whether every stage after the curves maps a pixel from its own value alone.
// Sharpening reads neighbours; any future spatial stage belongs here too.
function tailIsPointwise(settings) {
  return !(settings && settings.sharpenAmount > 0)
}

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
    this.lastLuts = null
    this.enhancedLut = null
  }

  /**
   * Load an enhanced profile 3D LUT.
   * @param {string} name - Profile name; see PROFILES in EnhancedProfiles.js
   */
  async setEnhancedProfile(name) {
    if (name === 'none') {
      this.enhancedLut = null
      return
    }
    this.enhancedLut = await loadProfile(name)
  }

  /**
   * Adopt an analysis made elsewhere (the preview worker's `analyze` reply, #239):
   * what analyze() leaves behind, without the pixels.
   */
  seedAnalysis({ channelData, autoColor, positiveAnalysis }) {
    this.channelData = channelData.map((channel) => ({ ...channel }))
    this.autoColor = autoColor ? { ...autoColor } : null
    this.positiveAnalysis = positiveAnalysis ? { gain: positiveAnalysis.gain, wb: [...positiveAnalysis.wb] } : null
    this.lastLuts = null
  }

  /**
   * The slider-dependent tables and factors of one tick (#239): what applyTail()
   * builds before its pixel passes, with the same settings and LUT bookkeeping, for
   * the GPU preview and its CPU histogram. `grey` adds the B&W grey → RGB table
   * (buildGreyTable). `pointwise` is false when a stage reads neighbours; the GPU
   * preview then does not draw.
   */
  previewPlan(params, { grey = false } = {}) {
    const settings = this.buildSettings(params)
    this.lastSettings = settings
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts
    const pointwise = tailIsPointwise(settings)
    const paper = settings.paper && settings.paper !== 'none' ? this._paperLuts(settings) : null
    return {
      settings,
      luts,
      pointwise,
      hsl: settings.hslAdjustments,
      lutStrength: this.enhancedLut ? (params.profileStrength ?? 100) : 0,
      saturation: params.saturation ?? 100,
      preSaturation: params.preSaturation ?? 100,
      paper,
      paperKey: paper ? this._paperCache.key : null,
      greyTable: grey && pointwise ? this._previewGreyTable(luts, params) : null,
    }
  }

  // _greyTable() into buffers this engine keeps: the same _applyLuts over the same
  // ramp, without allocating 900 KB per tick. The tables are overwritten next tick.
  _previewGreyTable(luts, params) {
    const scratch = this._previewGrey || (this._previewGrey = {
      ramp: null, r: new Uint16Array(65536), g: new Uint16Array(65536), b: new Uint16Array(65536),
    })
    scratch.ramp = refilledGreyRamp(scratch.ramp)
    const ramp = this._applyLuts(scratch.ramp, luts, params).data
    const { r, g, b } = scratch
    for (let v = 0; v < 65536; v++) {
      r[v] = ramp[v * 4]
      g[v] = ramp[v * 4 + 1]
      b[v] = ramp[v * 4 + 2]
    }
    return { r, g, b }
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
    // 5. Apply LUTs + 3D LUT + HSL + saturation (all CPU 16-bit for precision).
    return this._positiveExposureAndLuts(imageData, luts, params)
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
    // A detail region (#248) takes its base's positive analysis as it is.
    this.positiveAnalysis = params.imageType !== 'positive' ? null : params.positiveAnalysisOverride
      ? { gain: params.positiveAnalysisOverride.gain, wb: [...params.positiveAnalysisOverride.wb] }
      : analyzePositive(imageData, params)
    this.channelData = params.imageType === 'positive' ? identityPositiveChannels() : isChannelDataOverride(params.analysisOverride)
      ? params.analysisOverride.map((channel) => ({ ...channel }))
      : analyzeImage(imageData, params)

    // 2. Compute auto color correction
    this.autoColor = params.imageType === 'positive' ? null : computeAutoColor(this.channelData)

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

    return this._positiveExposureAndLuts(imageData, luts, params)
  }

  // 同一設定で標本と出力画像を連続処理するときだけ使う。曲線を二重生成しない。
  // 入力は未処理の独立バッファ。preSaturation をそれぞれ一度だけ適用する。
  applyCurrentCurves(imageData, params) {
    if (!this.lastLuts) return this.reprocess(imageData, params)
    this._applyPreSaturation(imageData, params)
    return this._positiveExposureAndLuts(imageData, this.lastLuts, params)
  }

  /**
   * The curves and everything after them, on a prepared plane: `src` already holds
   * the pre-saturation, the positive gain/WB and the dodge-and-burn stops. The first
   * pass reads `src` and writes `dst` (alpha copied), the rest run on `dst`, so the
   * cached plane is never modified. Same settings/LUT bookkeeping as reprocess().
   */
  applyTail(src, dst, params) {
    const settings = this.buildSettings(params)
    this.lastSettings = settings
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts
    return this._applyLuts(src, luts, params, dst)
  }

  // applyCurrentCurves() for a prepared plane: reuses the analysis sample's LUTs.
  applyCurrentTail(src, dst, params) {
    if (!this.lastLuts) return this.applyTail(src, dst, params)
    return this._applyLuts(src, this.lastLuts, params, dst)
  }

  // The positive gain/WB, the stops and the curves, in the engine's order. With gain
  // exactly 1 the positive stage is Math.round(v * wb[c]) per channel on pixels with
  // alpha ≠ 0, so when no stops sit between it and the curves it folds into the
  // curve LUT: one pass less, identical pixels.
  _positiveExposureAndLuts(imageData, luts, params) {
    const fold = this._positiveFold(luts, params, imageData.width, imageData.height)
    if (fold) return this._applyLuts(imageData, luts, params, null, fold)
    this._applyPositiveAnalysis(imageData)
    this._applyLocalExposure(imageData, params)
    return this._applyLuts(imageData, luts, params)
  }

  _applyPositiveAnalysis(imageData) {
    applyPositiveAnalysis(imageData, this.positiveAnalysis)
  }

  // Whether the positive stage has any effect (applyPositiveAnalysis's own test).
  positiveAnalysisIsIdentity() {
    const analysis = this.positiveAnalysis
    return !analysis || (analysis.gain === 1 && analysis.wb.every(value => value === 1))
  }

  _positiveFold(luts, params, width, height) {
    const analysis = this.positiveAnalysis
    if (this.positiveAnalysisIsIdentity() || analysis.gain !== 1) return null
    // A non-finite factor makes the per-pixel scale NaN, which zeroes all three
    // channels together: no per-channel table reproduces that.
    if (!analysis.wb.every(Number.isFinite)) return null
    const stops = params.localExposureStops
    if (stops && exposureStopsCover(stops, width, height)) return null
    const rounded = new Uint16Array(65536)
    const fold = []
    for (let c = 0; c < 3; c++) {
      const w = analysis.wb[c]
      // Stored through a Uint16Array exactly as applyPositiveAnalysis stores it.
      for (let v = 0; v < 65536; v++) rounded[v] = Math.round(v * w)
      const lut = c === 0 ? luts.r : c === 1 ? luts.g : luts.b
      const folded = new Uint16Array(65536)
      for (let v = 0; v < 65536; v++) folded[v] = lut[rounded[v]]
      fold.push(folded)
    }
    return fold
  }

  // A 65536-entry table S with S[v] = pre-saturation of the grey pixel (v, v, v),
  // computed by the unchanged adjustSaturation (its truncation drift included), or
  // null at 100. On grey input the stage is a function of the grey value alone.
  preSaturationRamp(params) {
    const preSaturation = params.preSaturation ?? 100
    if (preSaturation === 100) return null
    if (!preSaturationRampCache || preSaturationRampCache.amount !== preSaturation) {
      preSaturationRampCache = { amount: preSaturation, table: greySaturationRamp(preSaturation) }
    }
    return preSaturationRampCache.table
  }

  // The same ramp for the saturation stage after the curves (the GPU preview reads
  // exact greys from it, #239), or null at 100.
  saturationRamp(params) {
    const saturation = params.saturation ?? 100
    if (saturation === 100) return null
    if (!saturationRampCache || saturationRampCache.amount !== saturation) {
      saturationRampCache = { amount: saturation, table: greySaturationRamp(saturation) }
    }
    return saturationRampCache.table
  }

  // B&W analysis from a grey plane: analyze() without the pixel stages, which the
  // caller has already baked into the plane. `measure` returns the channel levels of
  // the pre-saturated grey values and is not called when an override is set.
  analyzeGrey(measure, params) {
    this.positiveAnalysis = null
    this.channelData = isChannelDataOverride(params.analysisOverride)
      ? params.analysisOverride.map((channel) => ({ ...channel }))
      : measure()
    this.autoColor = computeAutoColor(this.channelData)
    this.lastLuts = null
  }

  greyTableAvailable(params) {
    return tailIsPointwise(this.buildSettings(params))
  }

  /**
   * Everything reprocess() does after the stops, evaluated once per grey level: the
   * unchanged _applyLuts over the 65536-entry grey ramp. Returns the RGB result per
   * grey value (16-bit, and packed for 32-bit stores), or null when a stage is not
   * pointwise; the caller then runs the generic RGBA path.
   */
  buildGreyTable(params) {
    const settings = this.buildSettings(params)
    if (!tailIsPointwise(settings)) return null
    this.lastSettings = settings
    const luts = generateCurves(this.channelData, settings)
    this.lastLuts = luts
    return this._greyTable(luts, params)
  }

  // buildGreyTable() with the analysis sample's LUTs, as applyCurrentCurves().
  buildCurrentGreyTable(params) {
    if (!this.lastLuts) return this.buildGreyTable(params)
    if (!tailIsPointwise(this.lastSettings)) return null
    return this._greyTable(this.lastLuts, params)
  }

  _greyTable(luts, params) {
    const ramp = this._applyLuts(freshGreyRamp(), luts, params).data
    const r = new Uint16Array(65536), g = new Uint16Array(65536), b = new Uint16Array(65536)
    for (let v = 0; v < 65536; v++) {
      r[v] = ramp[v * 4]
      g[v] = ramp[v * 4 + 1]
      b[v] = ramp[v * 4 + 2]
    }
    return { r, g, b }
  }

  // The stops are a dense map or, for a full-resolution frame, a tiled one
  // (#254): only its allocated tiles are visited.
  _applyLocalExposure(imageData, params) {
    const stops = params.localExposureStops
    if (!exposureStopsCover(stops, imageData.width, imageData.height)) return
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
   * Apply 1D LUTs, optional 3D LUT, and saturation — full CPU 16-bit. This is the
   * reference and the only producer of settled and exported pixels; the interactive
   * GPU preview (render/previewShader.js) runs the same stages on display pixels.
   * With `dst`, the first pass reads `src` and writes `dst`; with `fold` (see
   * _positiveFold) it maps pixels with alpha ≠ 0 through the folded tables.
   */
  _applyLuts(src, luts, params, dst = null, fold = null) {
    const lutStrength = this.enhancedLut ? (params.profileStrength ?? 100) : 0
    const saturation = params.saturation ?? 100
    const hslAdj = this.lastSettings ? this.lastSettings.hslAdjustments : null

    // The first pass may read a cached plane and write the caller's buffer; every
    // later pass runs in place on the result.
    const imageData = dst || src
    if (fold) applyFoldedLUT(src, imageData, fold, luts)
    else if (dst) applyLUTInto(src, dst, luts.r, luts.g, luts.b)
    else applyLUT(imageData, luts.r, luts.g, luts.b)
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
