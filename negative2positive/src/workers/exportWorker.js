/**
 * Export Worker — handles pixel adjustments and image encoding off the main thread.
 * ES module worker (Vite supports `new Worker(url, { type: 'module' })`).
 */
import pako from 'pako';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';
import { encodePng16Blob, encodeTiffBlob } from './imageEncoders.js';

self.onmessage = function (e) {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'applyAdjustments':
        handleApplyAdjustments(msg);
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

  // Reconstruct curves as Uint8Array if transferred as plain arrays
  if (settings.curves) {
    if (!(settings.curves.r instanceof Uint8Array)) settings.curves.r = new Uint8Array(settings.curves.r);
    if (!(settings.curves.g instanceof Uint8Array)) settings.curves.g = new Uint8Array(settings.curves.g);
    if (!(settings.curves.b instanceof Uint8Array)) settings.curves.b = new Uint8Array(settings.curves.b);
  }

  const params = computeAdjustmentParams(settings);
  const input = new Uint8ClampedArray(inputBuffer);
  const output = new Uint8ClampedArray(input.length);
  const pixelCount = width * height;

  applyAdjustmentsToPixels(input, output, pixelCount, params, quality || 'full', (percent) => {
    self.postMessage({ type: 'progress', id, phase: 'adjustments', percent });
  });

  // Transfer output buffer back (zero-copy)
  self.postMessage(
    { type: 'result', id, data: output.buffer, width, height },
    [output.buffer]
  );
}

function handleEncodePng16(msg) {
  const { id, pixelData, width, height } = msg;
  const data = new Uint8ClampedArray(pixelData);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodePng16Blob(data, width, height, pako.deflate);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}

function handleEncodeTiff(msg) {
  const { id, pixelData, width, height, bitDepth } = msg;
  const data = new Uint8ClampedArray(pixelData);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodeTiffBlob(data, width, height, bitDepth || 8);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}
