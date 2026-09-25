// 調色だけを同期する。片基・レンズ・切り抜き・修復は各写真に残す。
// 期限切れフィルムの救済は強度のみ同期し、解析結果は写真ごとに測り直す。
export const STUDIO_COLOR_KEYS = [
  'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
  'corePreSaturation', 'coreBrightness', 'coreExposure', 'coreContrast',
  'coreHighlights', 'coreShadows', 'coreWhites', 'coreBlacks', 'coreWbMode',
  'coreTemperature', 'coreTint', 'coreCyan', 'coreSaturation', 'coreGlow', 'coreFade',
  'corePaper', 'corePaperToning', 'corePaperToningStrength', 'look',
  'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
  'vibrance', 'saturation', 'cyan', 'magenta', 'yellow', 'curvePoints', 'curves',
  'expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover',
  'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast'
];

export function pickStudioColors(settings) {
  return Object.fromEntries(STUDIO_COLOR_KEYS
    .filter(key => settings[key] !== undefined)
    .map(key => [key, structuredClone(settings[key])]));
}

export function mergeStudioColors(target, source) {
  return { ...structuredClone(target), ...pickStudioColors(source) };
}

// Nearest-neighbour sampling for tiles and presentation proxies. 8-bit RGBA
// copies whole pixels as 32-bit words through a precomputed column map (the
// same index expressions as the per-pixel loop below, so byte-identical);
// other element types and unaligned views keep the per-pixel loop.
export function createStudioThumbnail(imageData, maxSize = 144) {
  const scale = Math.min(1, maxSize / Math.max(imageData.width, imageData.height));
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const source = imageData.data;
  if ((source instanceof Uint8ClampedArray || source instanceof Uint8Array)
    && source.byteOffset % 4 === 0 && source.length >= imageData.width * imageData.height * 4) {
    const from = new Uint32Array(source.buffer, source.byteOffset, source.length >> 2);
    const to = new Uint32Array(data.buffer);
    const columns = new Int32Array(width);
    for (let x = 0; x < width; x++) columns[x] = Math.min(imageData.width - 1, Math.floor(x / scale));
    for (let y = 0; y < height; y++) {
      const row = Math.min(imageData.height - 1, Math.floor(y / scale)) * imageData.width;
      const out = y * width;
      for (let x = 0; x < width; x++) to[out + x] = from[row + columns[x]];
    }
    return { data, width, height };
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.min(imageData.height - 1, Math.floor(y / scale)) * imageData.width
        + Math.min(imageData.width - 1, Math.floor(x / scale))) * 4;
      data.set(imageData.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
