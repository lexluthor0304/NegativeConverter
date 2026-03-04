/**
 * Engine.js - Main processing orchestrator
 * Coordinates image analysis, curve generation, and LUT application.
 */

import { analyzeImage, applyLUT, adjustSaturation } from './ImageProcessor.js';
import { generateCurves } from './CurveEngine.js';
import { computeAutoColor } from './WhiteBalance.js';
import { colorModelToToneProfile } from './Presets.js';
import { WebGLRenderer } from './WebGLRenderer.js';

export class Engine {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.channelData = null;
    this.autoColor = null;
    this.glRenderer = null;
    this.lastLuts = null;
  }

  /**
   * Initialize WebGL renderer (call after canvas is ready).
   */
  initWebGL(canvas) {
    try {
      this.glRenderer = new WebGLRenderer(canvas);
      if (!this.glRenderer.available) this.glRenderer = null;
    } catch {
      this.glRenderer = null;
    }
  }

  /**
   * Full processing pipeline: negative -> positive
   * @param {ImageData} imageData - Input negative image
   * @param {Object} params - All UI parameters
   * @returns {ImageData} Processed positive image
   */
  process(imageData, params) {
    // 1. Analyze the negative (histogram-based black/white/mean points)
    this.channelData = analyzeImage(imageData, params);

    // 2. Compute auto color correction
    this.autoColor = computeAutoColor(this.channelData);

    // 3. Build engine settings from UI params
    const settings = this.buildSettings(params);

    // 4. Generate tone curve LUTs
    const luts = generateCurves(this.channelData, settings);
    this.lastLuts = luts;

    // 5. Apply LUTs (WebGL path or CPU path)
    const useWebGL = params.useWebGL !== false && this.glRenderer;

    if (useWebGL) {
      const result = this.glRenderer.render(imageData, luts.r, luts.g, luts.b, params.saturation ?? 100);
      if (result) return result;
    }

    // CPU fallback
    applyLUT(imageData, luts.r, luts.g, luts.b);
    if ((params.saturation ?? 100) !== 100) {
      adjustSaturation(imageData, params.saturation);
    }
    return imageData;
  }

  /**
   * Re-apply LUTs without re-analyzing (for slider changes).
   */
  reprocess(imageData, params) {
    if (!this.channelData) return this.process(imageData, params);

    const settings = this.buildSettings(params);
    const luts = generateCurves(this.channelData, settings);
    this.lastLuts = luts;

    const useWebGL = params.useWebGL !== false && this.glRenderer;
    if (useWebGL) {
      const result = this.glRenderer.render(imageData, luts.r, luts.g, luts.b, params.saturation ?? 100);
      if (result) return result;
    }

    applyLUT(imageData, luts.r, luts.g, luts.b);
    if ((params.saturation ?? 100) !== 100) {
      adjustSaturation(imageData, params.saturation);
    }
    return imageData;
  }

  /**
   * Map UI params to engine settings format.
   */
  buildSettings(params) {
    const toneProfile = colorModelToToneProfile[params.colorModel] || 'standard';
    const autoColor = this.autoColor || { tempCorrection: 0, tintCorrection: 0, cyanCorrection: 0 };
    const tempVal = (params.temperature || 0) + autoColor.tempCorrection;
    const tintVal = (params.tint || 0) + autoColor.tintCorrection;

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
      cyan: autoColor.cyanCorrection || 0,
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
      shadowCyan: 0,
      shadowTint: 0,
      shadowTemp: 0,
      highlightCyan: 0,
      highlightTint: 0,
      highlightTemp: 0,
      curvePrecision: params.curvePrecision || 'auto',
      borderBuffer: params.borderBuffer || 10,
      colorModel: params.colorModel || 'standard',
      preSaturation: params.preSaturation || 100,
      saturation: params.saturation || 100,
    };
  }
}
