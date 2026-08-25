// Deep-copies a sanitized settings object into an independent snapshot.
// Shared by extractCurrentSettings (live state -> per-file settings) and
// cloneSettings (per-file settings -> another file) in main.js, which used
// to duplicate this field-by-field copy.
//
// `safe` must already be the output of sanitizeSettings() — this function
// only copies, it does not validate.

export function deepCopySanitizedSettings(safe, { autoFrameMeta = safe.autoFrameMeta } = {}) {
  return {
    cropRegion: safe.cropRegion ? { ...safe.cropRegion } : null,
    rotationAngle: safe.rotationAngle || 0,
    autoFrameMeta: autoFrameMeta ? { ...autoFrameMeta } : null,
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
    wbAutoConfidence: safe.wbAutoConfidence ?? null,
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
