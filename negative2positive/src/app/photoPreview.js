import {
  applyPreparedAdjustmentsToBuffer,
  createAdjustmentLutScratch
} from './adjustmentPipeline.js';
import { createStudioThumbnail } from './studioSettings.js';

// All work is synchronous, so successive previews can reuse these small LUTs.
const lutScratch = createAdjustmentLutScratch();

/**
 * Build a small, final-colour preview independently of the display renderer.
 *
 * `source` must already contain core conversion, geometry and repairs, but NOT
 * the final adjustment stage. Pass the result of buildAdjustmentSettings as
 * `adjustmentSettings`: core-baked legacy tone controls must not run again.
 * Never use displayImageData here; CPU display pixels are already adjusted,
 * while a GPU display need not materialize its final pixels on the CPU at all.
 *
 * This is an 8-bit presentation image, not an export source. Sample the same
 * 8-bit plane consumed by the display adjustment stage, without copying or
 * retaining the original 16-bit plane. Nearest-neighbour sampling needs no
 * intermediate resampling precision, and preserves existing thumbnail framing.
 * Allocation and adjustment work are both bounded by the thumbnail dimensions.
 */
export function createAdjustedPhotoPreview(source, adjustmentSettings, { maxSize = 144 } = {}) {
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError('Photo preview maxSize must be a positive integer');
  }
  if (!source || !Number.isSafeInteger(source.width) || source.width < 1
    || !Number.isSafeInteger(source.height) || source.height < 1
    || !Number.isSafeInteger(source.width * source.height * 4)
    || !source.data || typeof source.data.subarray !== 'function'
    || source.data.length < source.width * source.height * 4) {
    throw new TypeError('Photo preview requires a valid RGBA presentation source');
  }

  const thumbnail = createStudioThumbnail(source, maxSize);
  const { width, height } = thumbnail;
  const output = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  applyPreparedAdjustmentsToBuffer(thumbnail, adjustmentSettings, output, {
    quality: 'preview',
    lutScratch
  });

  return typeof ImageData === 'function'
    ? new ImageData(output.data, width, height)
    : output;
}
