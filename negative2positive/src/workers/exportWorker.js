/**
 * Export Worker — handles pixel adjustments and image encoding off the main thread.
 * ES module worker (Vite supports `new Worker(url, { type: 'module' })`).
 */
// pako 3.x dropped the default export — use named imports.
import * as pako from 'pako';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';
import { applyAdjustmentsToPixels16 } from './pixelAdjustments16.js';
import { encodePng16Blob, encodeTiffBlob } from './imageEncoders.js';

const adjustmentLutScratch = {
  lutR: new Uint8Array(256),
  lutG: new Uint8Array(256),
  lutB: new Uint8Array(256)
};
const adjustmentLutScratch16 = {
  lutR: new Uint16Array(65536),
  lutG: new Uint16Array(65536),
  lutB: new Uint16Array(65536)
};

self.onmessage = function (e) {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'applyAdjustments':
        handleApplyAdjustments(msg);
        break;
      case 'applyAdjustments16':
        handleApplyAdjustments16(msg);
        break;
      case 'encodePng16':
        handleEncodePng16(msg);
        break;
      case 'encodeTiff':
        handleEncodeTiff(msg);
        break;
      default:
        self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};

function handleApplyAdjustments(msg) {
  const { id, inputBuffer, width, height, settings, quality } = msg;

  // Ensure curves are Uint8Array (structured clone preserves type, but guard defensively)
  if (settings.curves) {
    const c = settings.curves;
    if (!(c.r instanceof Uint8Array)) c.r = new Uint8Array(c.r);
    if (!(c.g instanceof Uint8Array)) c.g = new Uint8Array(c.g);
    if (!(c.b instanceof Uint8Array)) c.b = new Uint8Array(c.b);
  }

  const params = computeAdjustmentParams(settings);
  const input = new Uint8ClampedArray(inputBuffer);
  const output = new Uint8ClampedArray(input.length);
  const pixelCount = width * height;

  applyAdjustmentsToPixels(input, output, pixelCount, params, quality || 'full', (percent) => {
    self.postMessage({ type: 'progress', id, phase: 'adjustments', percent });
  }, 500000, adjustmentLutScratch);

  // Transfer output buffer back (zero-copy)
  self.postMessage(
    { type: 'result', id, data: output.buffer, width, height },
    [output.buffer]
  );
}

// 16-bit variant: the engine's plane in, the adjusted plane out.
function handleApplyAdjustments16(msg) {
  const { id, inputBuffer, width, height, settings, quality } = msg;
  if (settings.curves) {
    const c = settings.curves;
    if (!(c.r instanceof Uint8Array)) c.r = new Uint8Array(c.r);
    if (!(c.g instanceof Uint8Array)) c.g = new Uint8Array(c.g);
    if (!(c.b instanceof Uint8Array)) c.b = new Uint8Array(c.b);
  }
  const params = computeAdjustmentParams(settings);
  const input = new Uint16Array(inputBuffer);
  const output = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, output, width * height, params, quality || 'full', (percent) => {
    self.postMessage({ type: 'progress', id, phase: 'adjustments', percent });
  }, 500000, adjustmentLutScratch16);
  self.postMessage(
    { type: 'result', id, data: output.buffer, width, height, bits: 16 },
    [output.buffer]
  );
}

/**
 * The bridge transfers either the 8-bit RGBA buffer or, when the conversion
 * engine produced one, the genuine 16-bit RGBA plane. `sourceBits` says which.
 */
function viewSamples(buffer, sourceBits) {
  return sourceBits === 16 ? new Uint16Array(buffer) : new Uint8ClampedArray(buffer);
}

function handleEncodePng16(msg) {
  const { id, pixelData, width, height, sourceBits } = msg;
  const data = viewSamples(pixelData, sourceBits);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodePng16Blob(data, width, height, pako.deflate);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}

function handleEncodeTiff(msg) {
  const { id, pixelData, width, height, bitDepth, sourceBits, metadata } = msg;
  const data = viewSamples(pixelData, sourceBits);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodeTiffBlob(data, width, height, bitDepth || 8, metadata || null);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}
