/**
 * Main-thread fallback entry point for the PNG16/TIFF encoders.
 *
 * main.js tries the export Worker first (workers/workerBridge.js) and lazily
 * imports this module only when the Worker is unavailable or failed. The actual
 * encoding lives in workers/imageEncoders.js — this file exists purely to adapt
 * the ImageData-shaped call sites and to supply the PNG16 deflater on the
 * main thread, so there is one implementation of the binary formats.
 */
import {
  encodePng16Blob as encodePng16Samples,
  encodeTiffBlob as encodeTiffSamples,
  selectExportSamples
} from '../workers/imageEncoders.js';
import { loadPng16Zlib, png16DeflateVariant, runWithPng16Fallback } from '../workers/pngDeflateWasm.js';

export { selectExportSamples, png16DeflateVariant };

// The workers' deflater (#301), loaded once with this module, so a fallback
// export writes the bytes the export worker would and encodePng16Blob stays
// synchronous. pako where the module cannot run here.
const png16Zlib = await loadPng16Zlib();

/**
 * @param {ImageData & {__image16?: {width:number,height:number,data:Uint16Array}}} imageData
 * @param {{level?: number, strategy?: number}} [options]
 * @returns {Blob}
 */
export function encodePng16Blob(imageData, options = {}) {
  const { samples } = selectExportSamples(imageData, 16);
  return runWithPng16Fallback(png16Zlib, (zlib) => encodePng16Samples(samples, imageData.width, imageData.height, zlib, options));
}

/**
 * @param {ImageData & {__image16?: {width:number,height:number,data:Uint16Array}}} imageData
 * @param {number} [bitDepth] - 8 or 16
 * @returns {Blob}
 */
export function encodeTiffBlob(imageData, bitDepth = 8, metadata = null) {
  const { samples } = selectExportSamples(imageData, bitDepth);
  return encodeTiffSamples(samples, imageData.width, imageData.height, bitDepth, metadata);
}
