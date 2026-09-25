/**
 * Export Worker — handles pixel adjustments and image encoding off the main thread.
 * ES module worker (Vite supports `new Worker(url, { type: 'module' })`).
 */
// pako 3.x dropped the default export — use named imports.
import * as pako from 'pako';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';
import { applyAdjustmentsToPixels16, downconvertPlane16 } from './pixelAdjustments16.js';
import { encodePng16Blob, encodeTiffBlob } from './imageEncoders.js';
import { encodePng16Band } from './png16Bands.js';
import { computeGainMap } from './gainMap.js';

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
      case 'gainMap16':
        handleGainMap16(msg);
        break;
      case 'encodePng16':
        handleEncodePng16(msg);
        break;
      case 'encodePng16Band':
        handleEncodePng16Band(msg);
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
  normalizeCurves(settings);

  const params = computeAdjustmentParams(settings, { width, height });
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

function normalizeCurves(settings) {
  // Structured clone preserves Uint8Array, but guard defensively.
  if (settings.curves) {
    const c = settings.curves;
    if (!(c.r instanceof Uint8Array)) c.r = new Uint8Array(c.r);
    if (!(c.g instanceof Uint8Array)) c.g = new Uint8Array(c.g);
    if (!(c.b instanceof Uint8Array)) c.b = new Uint8Array(c.b);
  }
}

// The Step-3 stage on a 16-bit plane: the same function and params for the
// export pass and the gain-map pass.
function adjustPlane16(id, inputBuffer, width, height, settings, quality) {
  normalizeCurves(settings);
  const params = computeAdjustmentParams(settings, { width, height });
  const input = new Uint16Array(inputBuffer);
  const output = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, output, width * height, params, quality || 'full', (percent) => {
    self.postMessage({ type: 'progress', id, phase: 'adjustments', percent });
  }, 500000, adjustmentLutScratch16);
  return output;
}

// 16-bit variant: the engine's plane in, the adjusted plane out, plus its
// 8-bit mirror (the high bytes, built by the same function as the main-thread
// path) unless the caller reads only the plane.
function handleApplyAdjustments16(msg) {
  const { id, inputBuffer, width, height, settings, quality, planeOnly } = msg;
  const output = adjustPlane16(id, inputBuffer, width, height, settings, quality);
  if (planeOnly) {
    self.postMessage(
      { type: 'result', id, data: output.buffer, width, height, bits: 16 },
      [output.buffer]
    );
    return;
  }
  const data8 = downconvertPlane16(output, new Uint8ClampedArray(output.length));
  self.postMessage(
    { type: 'result', id, data: output.buffer, data8: data8.buffer, width, height, bits: 16 },
    [output.buffer, data8.buffer]
  );
}

// The JPEG gain map: the 16-bit pass on the unadjusted plane, then the map
// against the SDR frame's bytes. Only the map (1/16 of the pixels) goes back;
// the adjusted plane never leaves the worker. On failure the input buffers go
// back with the error, so a caller that transferred its plane can keep it.
function handleGainMap16(msg) {
  const { id, inputBuffer, sdrBuffer, width, height, settings, quality } = msg;
  try {
    const out16 = adjustPlane16(id, inputBuffer, width, height, settings, quality);
    const sdr = { width, height, data: new Uint8ClampedArray(sdrBuffer) };
    const map = computeGainMap(sdr, { width, height, data: out16 });
    if (!map) throw new Error('Gain map inputs do not match');
    self.postMessage(
      { type: 'gainMapResult', id, data: map.data.buffer, width: map.width, height: map.height, gainMax: map.gainMax, gainMin: map.gainMin },
      [map.data.buffer]
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const returned = { plane: inputBuffer, sdr: sdrBuffer };
    const transfers = [inputBuffer, sdrBuffer].filter((buffer) => buffer instanceof ArrayBuffer);
    try {
      self.postMessage({ type: 'error', id, message, returned }, transfers);
    } catch {
      self.postMessage({ type: 'error', id, message });
    }
  }
}

/**
 * The bridge transfers either the 8-bit RGBA buffer or, when the conversion
 * engine produced one, the genuine 16-bit RGBA plane. `sourceBits` says which.
 */
function viewSamples(buffer, sourceBits) {
  return sourceBits === 16 ? new Uint16Array(buffer) : new Uint8ClampedArray(buffer);
}

// The whole frame in this worker, band after band: a batch lane without a
// band pool, or the fallback when the pool cannot start. Same bytes as the pool.
function handleEncodePng16(msg) {
  const { id, pixelData, width, height, sourceBits, level, strategy, bandBytes } = msg;
  const data = viewSamples(pixelData, sourceBits);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodePng16Blob(data, width, height, pako, { level, strategy, bandBytes });

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}

// One band of the PNG16 band pool: its RGBA rows in, its IDAT chunk out as a
// Blob built here, so the compressed bytes leave this heap at once and the
// main thread only assembles Blob references.
function handleEncodePng16Band(msg) {
  const { id, pixelData, width, rows, channels, sourceBits, index, isLast, level, strategy } = msg;
  const band = encodePng16Band({
    samples: viewSamples(pixelData, sourceBits), width, rows, channels, index, isLast, level, strategy
  }, pako);
  self.postMessage({ type: 'bandResult', id, blob: new Blob(band.parts), adler: band.adler, length: band.length });
}

function handleEncodeTiff(msg) {
  const { id, pixelData, width, height, bitDepth, sourceBits, metadata } = msg;
  const data = viewSamples(pixelData, sourceBits);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });

  const blob = encodeTiffBlob(data, width, height, bitDepth || 8, metadata || null);

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}
