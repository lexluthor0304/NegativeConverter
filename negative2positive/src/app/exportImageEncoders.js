/**
 * Main-thread fallback entry point for the PNG16/TIFF encoders.
 *
 * main.js tries the export Worker first (workers/workerBridge.js) and lazily
 * imports this module only when the Worker is unavailable or failed. The actual
 * encoding lives in workers/imageEncoders.js — this file exists purely to adapt
 * the ImageData-shaped call sites and to supply pako on the main thread, so
 * there is one implementation of the binary formats.
 */
// pako 3.x dropped the default export — use named imports.
import * as pako from 'pako';
import {
  encodePng16Blob as encodePng16Samples,
  encodeTiffBlob as encodeTiffSamples,
  selectExportSamples
} from '../workers/imageEncoders.js';

export { selectExportSamples };

/**
 * @param {ImageData & {__image16?: {width:number,height:number,data:Uint16Array}}} imageData
 * @returns {Blob}
 */
export function encodePng16Blob(imageData) {
  const { samples } = selectExportSamples(imageData, 16);
  return encodePng16Samples(samples, imageData.width, imageData.height, pako.deflate);
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
