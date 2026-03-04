/**
 * Presets.js - Film presets, tone profiles, color models
 * Film presets, tone profiles, color models
 */

export const defaultSettings = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  softHigh: 0,
  softLow: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  glow: 0,
  fade: 0,
  toneProfile: 'standard',
  temp: 0,
  tint: 0,
  cyan: 0,
  highlightTemp: 0,
  highlightTint: 0,
  highlightCyan: 0,
  shadowTemp: 0,
  shadowTint: 0,
  shadowCyan: 0,
  colorModel: 'basic',
  saturation: 3,
  filmBorder: 5,
  previewBuffer: false,
  source: 'cameraScan',
  filmHue: 0,
  hueStrength: 0,
  softHighlights: false,
  softShadows: false,
  wb: 'warm',
  wbTemp: 0,
  wbTint: 0,
  shadowRange: 5,
  highlightRange: 5,
  curveResolution: 7,
  curveResolutionType: 'auto_curve_pts',
  layerOrder: 'colorFirst',
  wbTonality: 'addDensity',
  wbMethod: 'linearFixed',
};

export const toneProfiles = {
  autotone: {
    defaultBrightness: 0, defaultBlacks: 5, defaultWhites: -1,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 10,
    defaultSoftHigh: 0, defaultSoftLow: 0,
    autoTone: true,
  },
  standard: {
    defaultBrightness: 0, defaultBlacks: 2, defaultWhites: -2,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 10,
    defaultSoftHigh: 0, defaultSoftLow: 0,
    autoTone: true,
  },
  base: {
    defaultBrightness: 0, defaultBlacks: 0, defaultWhites: 0,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: -3, defaultSoftLow: -3,
    autoTone: false,
  },
  base_gamma: {
    defaultBrightness: 0, defaultBlacks: 0, defaultWhites: 0,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 0.66, defaultContrast: 0,
    defaultSoftHigh: -3, defaultSoftLow: -3,
    autoTone: false,
  },
  base_flat: {
    defaultBrightness: 0, defaultBlacks: 0, defaultWhites: 0,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: -15, defaultSoftLow: -10,
    autoTone: false,
  },
  base_deep: {
    defaultBrightness: 0, defaultBlacks: 0, defaultWhites: 0,
    defaultShadows: -12, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: -3, defaultSoftLow: -3,
    autoTone: false,
  },
  filmic: {
    defaultBrightness: 0, defaultBlacks: -10, defaultWhites: 0,
    defaultShadows: -10, defaultHighlights: -25,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: -3, defaultSoftLow: -3,
    autoTone: false,
  },
  filmic_rich: {
    defaultBrightness: 0, defaultBlacks: -20, defaultWhites: 0,
    defaultShadows: -10, defaultHighlights: -25,
    defaultGamma: 1, defaultContrast: 5,
    defaultSoftHigh: -3, defaultSoftLow: -3,
    autoTone: false,
  },
  filmic_flat: {
    defaultBrightness: 0, defaultBlacks: -10, defaultWhites: 0,
    defaultShadows: -10, defaultHighlights: -25,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: -9, defaultSoftLow: -6,
    autoTone: false,
  },
  all_hard: {
    defaultBrightness: 0, defaultBlacks: 2, defaultWhites: -2,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 25,
    defaultSoftHigh: 0, defaultSoftLow: 0,
    autoTone: true,
  },
  all_soft: {
    defaultBrightness: 0, defaultBlacks: 10, defaultWhites: -10,
    defaultShadows: 0, defaultHighlights: 0,
    defaultGamma: 1, defaultContrast: 0,
    defaultSoftHigh: 0, defaultSoftLow: 0,
    autoTone: true,
  },
};

// Map UI color model names to tone profile keys
export const colorModelToToneProfile = {
  noritsu: 'standard',
  frontier: 'standard',
  standard: 'standard',
  warm: 'standard',
  mono: 'standard',
  'cine-log': 'filmic',
  'cine-rich': 'filmic_rich',
  'cine-flat': 'filmic_flat',
  neutral: 'base',
};

// Color model settings (negativeLabSettings)
export const colorModels = {
  none: {
    defaultTemp: 0, defaultTint: 0, defaultCyan: 0,
    defaultShadowsTemp: 0, defaultShadowsTint: 0, defaultShadowsCyan: 0,
    defaultHighlightsTemp: 0, defaultHighlightsTint: 0, defaultHighlightsCyan: 0,
    blackThreshold: 0.001, whiteThreshold: 0.001,
  },
  basic: {
    defaultTemp: 0, defaultTint: 0, defaultCyan: 0,
    defaultShadowsTemp: 0, defaultShadowsTint: 0, defaultShadowsCyan: 0,
    defaultHighlightsTemp: 0, defaultHighlightsTint: 0, defaultHighlightsCyan: 0,
    blackThreshold: 0.002, whiteThreshold: 0.001,
  },
  frontier: {
    defaultTemp: 1, defaultTint: 0, defaultCyan: -1,
    defaultShadowsTemp: 3, defaultShadowsTint: 0, defaultShadowsCyan: 0,
    defaultHighlightsTemp: 0, defaultHighlightsTint: 0, defaultHighlightsCyan: 0,
    blackThreshold: 0.002, whiteThreshold: 0.002,
  },
  noritsu: {
    defaultTemp: 0, defaultTint: 0, defaultCyan: 0,
    defaultShadowsTemp: 0, defaultShadowsTint: 0, defaultShadowsCyan: 0,
    defaultHighlightsTemp: 0, defaultHighlightsTint: 0, defaultHighlightsCyan: 0,
    blackThreshold: 0.002, whiteThreshold: 0.002,
  },
  mono: {
    defaultTemp: 0, defaultTint: 0, defaultCyan: 0,
    defaultShadowsTemp: 0, defaultShadowsTint: 0, defaultShadowsCyan: 0,
    defaultHighlightsTemp: 0, defaultHighlightsTint: 0, defaultHighlightsCyan: 0,
    blackThreshold: 0.002, whiteThreshold: 0.002,
  },
};

// Film character (hue) presets
export const filmCharacter = {
  none:     { filmHue: 0,  hueStrength: 0 },
  warm:     { filmHue: 35, hueStrength: 10 },
  cool:     { filmHue: 45, hueStrength: 10 },
  standard: { filmHue: 25, hueStrength: 10 },
};
