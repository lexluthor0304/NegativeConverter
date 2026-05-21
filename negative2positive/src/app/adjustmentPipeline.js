import {
  applyAdjustmentsToPixels,
  computeAdjustmentParams
} from '../workers/pixelAdjustments.js';

export function createAdjustmentLutScratch() {
  return {
    lutR: new Uint8Array(256),
    lutG: new Uint8Array(256),
    lutB: new Uint8Array(256)
  };
}

export function stripLegacyToneSettingsForSilverCore(settings) {
  return {
    ...settings,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    saturation: 0
  };
}

export function applyPreparedAdjustmentsToBuffer(imageData, adjustmentSettings, output, options = {}) {
  const {
    quality = 'full',
    lutScratch = null,
    onProgress = null,
    chunkSize = 500000
  } = options;
  const params = computeAdjustmentParams(adjustmentSettings);

  applyAdjustmentsToPixels(
    imageData.data,
    output.data,
    imageData.width * imageData.height,
    params,
    quality,
    onProgress,
    chunkSize,
    lutScratch
  );
}
