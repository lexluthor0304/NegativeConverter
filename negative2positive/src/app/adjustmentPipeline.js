import {
  applyAdjustmentsToPixels,
  computeAdjustmentParams,
  isIdentityAdjustmentParams
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

/**
 * True when the Step-3 adjustment stage would leave the RGB channels untouched.
 *
 * @param {object} adjustmentSettings - Output of main.js buildAdjustmentSettings
 */
export function areAdjustmentsIdentity(adjustmentSettings) {
  if (!adjustmentSettings || !adjustmentSettings.curves) return false;
  return isIdentityAdjustmentParams(computeAdjustmentParams(adjustmentSettings));
}

/**
 * The engine hands the pipeline a genuine 16-bit RGBA plane as `__image16`; the
 * Step-3 adjustment stage below is 8-bit only. Carry the plane onto the output
 * when the adjustments are a no-op (the 16-bit data still describes the result
 * exactly, so exports can be truly 16-bit) and clear it otherwise — `output` is
 * a reused buffer, so a stale plane would silently export the wrong pixels.
 */
function syncImage16(imageData, output, identity) {
  if (!output || typeof output !== 'object') return;
  const plane = identity ? imageData && imageData.__image16 : null;
  if (
    plane
    && plane.data instanceof Uint16Array
    && plane.width === output.width
    && plane.height === output.height
  ) {
    output.__image16 = plane;
  } else if (output.__image16) {
    output.__image16 = null;
  }
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

  syncImage16(imageData, output, isIdentityAdjustmentParams(params));
}
