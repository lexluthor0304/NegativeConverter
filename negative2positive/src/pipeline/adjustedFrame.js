import { convertFrameWithRouter } from './conversionRouter.js';
import { applyPreparedAdjustmentsToBuffer, createAdjustmentLutScratch } from '../app/adjustmentPipeline.js';

/**
 * A live-loupe frame: the router's conversion, then the Step-3 adjustment
 * stage with already prepared settings (main.js buildAdjustmentSettings), at
 * preview quality. The conversion worker and the main-thread fallback both run
 * this, so the two paths give the same pixels. Returns an 8-bit
 * { width, height, data } frame, or null when the router returns nothing.
 */
export async function convertAdjustedFrame({ imageData, settings, adjust, options = {}, lutScratch = createAdjustmentLutScratch() }) {
  const converted = await convertFrameWithRouter({ imageData, settings, options });
  if (!converted) return null;
  const output = {
    width: converted.width,
    height: converted.height,
    data: new Uint8ClampedArray(converted.width * converted.height * 4)
  };
  applyPreparedAdjustmentsToBuffer(converted, adjust, output, { quality: 'preview', lutScratch });
  return output;
}
