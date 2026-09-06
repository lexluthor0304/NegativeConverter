// 調色だけを同期する。片基・レンズ・切り抜き・修復は各写真に残す。
export const STUDIO_COLOR_KEYS = [
  'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
  'corePreSaturation', 'coreBrightness', 'coreExposure', 'coreContrast',
  'coreHighlights', 'coreShadows', 'coreWhites', 'coreBlacks', 'coreWbMode',
  'coreTemperature', 'coreTint', 'coreCyan', 'coreSaturation', 'coreGlow', 'coreFade',
  'corePaper', 'corePaperToning', 'corePaperToningStrength', 'look',
  'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
  'vibrance', 'saturation', 'cyan', 'magenta', 'yellow', 'curvePoints', 'curves'
];

export function pickStudioColors(settings) {
  return Object.fromEntries(STUDIO_COLOR_KEYS
    .filter(key => settings[key] !== undefined)
    .map(key => [key, structuredClone(settings[key])]));
}

export function mergeStudioColors(target, source) {
  return { ...structuredClone(target), ...pickStudioColors(source) };
}

export function createStudioThumbnail(imageData, maxSize = 144) {
  const scale = Math.min(1, maxSize / Math.max(imageData.width, imageData.height));
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.min(imageData.height - 1, Math.floor(y / scale)) * imageData.width
        + Math.min(imageData.width - 1, Math.floor(x / scale))) * 4;
      data.set(imageData.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
