/**
 * Export Worker — handles pixel adjustments and image encoding off the main thread.
 * ES module worker (Vite supports `new Worker(url, { type: 'module' })`).
 *
 * Every input buffer is private to this worker: the bridge either copied it
 * or transferred a plane the export owns (#250). So the adjustment passes run
 * in place and hand the same buffer back, and the TIFF encoder compacts a
 * 16-bit plane in place. When a request fails before its input was written,
 * the input goes back with the error (`returned`), so a caller that
 * transferred its plane keeps its pixels; after a write it cannot, and the
 * bridge reports the plane as lost.
 */
// pako 3.x dropped the default export — use named imports.
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
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
      case 'adjust16AndEncode':
        handleAdjust16AndEncode(msg);
        break;
      case 'encodeImage':
        // Asynchronous (convertToBlob): it reports its own errors, because
        // this switch has returned by the time the promise settles.
        handleEncodeImage(msg);
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

// Post an error; `returned` names the input buffers that are still unwritten
// and go back to the caller. If the transfer itself fails, the error still
// gets through without them.
function postError(id, err, returned = null, code = null) {
  const message = err && err.message ? err.message : String(err);
  const payload = { type: 'error', id, message };
  if (code) payload.code = code;
  const transfers = [];
  if (returned) {
    const kept = {};
    for (const [key, buffer] of Object.entries(returned)) {
      if (buffer instanceof ArrayBuffer && buffer.byteLength > 0 && !transfers.includes(buffer)) {
        kept[key] = buffer;
        transfers.push(buffer);
      }
    }
    if (transfers.length) payload.returned = kept;
  }
  try {
    self.postMessage(payload, transfers);
  } catch {
    self.postMessage({ type: 'error', id, message, ...(code ? { code } : {}) });
  }
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

function progressReporter(id) {
  return (percent) => {
    self.postMessage({ type: 'progress', id, phase: 'adjustments', percent });
  };
}

// The 8-bit Step-3 pass, in place: the kernel reads a pixel's samples before
// it writes that pixel, so input and output may be the same array.
function handleApplyAdjustments(msg) {
  const { id, inputBuffer, width, height, settings, quality } = msg;
  let pixels;
  let params;
  try {
    normalizeCurves(settings);
    params = computeAdjustmentParams(settings, { width, height });
    pixels = new Uint8ClampedArray(inputBuffer);
    if (pixels.length !== width * height * 4) throw new Error(`Adjustment input holds ${pixels.length} samples for ${width}x${height}`);
  } catch (err) {
    postError(id, err, { input: inputBuffer });
    return;
  }
  applyAdjustmentsToPixels(pixels, pixels, width * height, params, quality || 'full', progressReporter(id), 500000, adjustmentLutScratch);
  // The same buffer goes back (zero-copy).
  self.postMessage(
    { type: 'result', id, data: pixels.buffer, width, height },
    [pixels.buffer]
  );
}

// The Step-3 stage on a 16-bit plane, in place: the same function and params
// for the export pass, the fused encode and the gain-map pass. `prepared`
// (params computed, plane viewed) is split from the write so a caller can
// tell an error before the write from one after it.
function prepareAdjustPlane16(inputBuffer, width, height, settings) {
  normalizeCurves(settings);
  const params = computeAdjustmentParams(settings, { width, height });
  const plane = new Uint16Array(inputBuffer);
  if (plane.length !== width * height * 4) throw new Error(`16-bit input holds ${plane.length} samples for ${width}x${height}`);
  return { params, plane };
}

function runAdjustPlane16(id, prepared, width, height, quality) {
  const { params, plane } = prepared;
  applyAdjustmentsToPixels16(plane, plane, width * height, params, quality || 'full', progressReporter(id), 500000, adjustmentLutScratch16);
  return plane;
}

// 16-bit variant: the engine's plane in, the adjusted plane out (the same
// buffer), plus its 8-bit mirror (the high bytes, built by the same function
// as the main-thread path) unless the caller reads only the plane.
function handleApplyAdjustments16(msg) {
  const { id, inputBuffer, width, height, settings, quality, planeOnly } = msg;
  let prepared;
  try {
    prepared = prepareAdjustPlane16(inputBuffer, width, height, settings);
  } catch (err) {
    postError(id, err, { input: inputBuffer });
    return;
  }
  const output = runAdjustPlane16(id, prepared, width, height, quality);
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
// the adjusted plane never leaves the worker. The SDR bytes are never written,
// so they always go back with an error; the plane only until the pass writes it.
function handleGainMap16(msg) {
  const { id, inputBuffer, sdrBuffer, width, height, settings, quality } = msg;
  let written = false;
  try {
    const prepared = prepareAdjustPlane16(inputBuffer, width, height, settings);
    written = true;
    const out16 = runAdjustPlane16(id, prepared, width, height, quality);
    const sdr = { width, height, data: new Uint8ClampedArray(sdrBuffer) };
    const map = computeGainMap(sdr, { width, height, data: out16 });
    if (!map) throw new Error('Gain map inputs do not match');
    self.postMessage(
      { type: 'gainMapResult', id, data: map.data.buffer, width: map.width, height: map.height, gainMax: map.gainMax, gainMin: map.gainMin },
      [map.data.buffer]
    );
  } catch (err) {
    postError(id, err, written ? { sdr: sdrBuffer } : { plane: inputBuffer, sdr: sdrBuffer });
  }
}

// One request per 16-bit file (#250 Part 2): adjust the unadjusted plane in
// place and encode it. Only the Blob goes back; the adjusted plane never
// exists on the main thread. PNG metadata is attached there, at Blob level.
function handleAdjust16AndEncode(msg) {
  const { id, inputBuffer, width, height, settings, quality, format, metadata, level, strategy, bandBytes } = msg;
  let prepared;
  try {
    if (format !== 'tiff' && format !== 'png') throw new Error(`Unsupported fused format: ${format}`);
    prepared = prepareAdjustPlane16(inputBuffer, width, height, settings);
  } catch (err) {
    postError(id, err, { input: inputBuffer });
    return;
  }
  const plane = runAdjustPlane16(id, prepared, width, height, quality);
  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 10 });
  const blob = format === 'tiff'
    ? encodeTiffBlob(plane, width, height, 16, metadata || null, { ownedPlane: true })
    : encodePng16Blob(plane, width, height, pako, { level, strategy, bandBytes });
  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}

// --------------------------------------------------------- PNG8 and JPEG

// Detected once per worker: OffscreenCanvas, convertToBlob on its prototype
// and a 2D context. WebKit before Safari 16.4 has none of it in workers.
let offscreenSupport = null;

export function offscreenEncodeSupported() {
  if (offscreenSupport !== null) return offscreenSupport;
  try {
    offscreenSupport = typeof OffscreenCanvas === 'function'
      && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
      && Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
  } catch {
    offscreenSupport = false;
  }
  return offscreenSupport;
}

function isOpaque(pixels) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
  return true;
}

// `willReadFrequently` asks for a CPU-backed canvas, which keeps a 60 MP
// backing store out of the GPU process. The backing store is released as soon
// as convertToBlob has the bytes.
async function encodeWithOffscreenCanvas(pixels, width, height, type, quality) {
  const canvas = new OffscreenCanvas(width, height);
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to render export image.');
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    const options = { type };
    if (quality !== undefined && quality !== null) options.quality = quality;
    return await canvas.convertToBlob(options);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * PNG8 / JPEG through OffscreenCanvas (#250 Part 3), plus the JPEG gain map in
 * the same request: once the SDR blob is done its bytes are still here, so the
 * 16-bit pass runs in place on the plane, then the table map, then a second
 * JPEG encode for the map. Replies `imageResult` with `{ blob, gain }`.
 * `code: 'unsupported'` (no OffscreenCanvas encode in this engine) and
 * `'unsupported-alpha'` (a non-opaque frame, whose encoder input differs
 * between WebKit's two encoders) send the caller back to the canvas path with
 * its pixels.
 */
export async function handleEncodeImage(msg) {
  const { id, pixelData, width, height, mimeType, quality, gainMap } = msg;
  const planeBuffer = gainMap ? gainMap.plane : null;
  let planeWritten = false;
  try {
    if (!offscreenEncodeSupported()) {
      postError(id, new Error('OffscreenCanvas encoding is unavailable in this worker'), { pixels: pixelData, plane: planeBuffer }, 'unsupported');
      return;
    }
    const pixels = new Uint8ClampedArray(pixelData);
    if (pixels.length !== width * height * 4) throw new Error(`Encode input holds ${pixels.length} samples for ${width}x${height}`);
    if (!isOpaque(pixels)) {
      postError(id, new Error('Non-opaque frames are encoded on the main thread'), { pixels: pixelData, plane: planeBuffer }, 'unsupported-alpha');
      return;
    }
    const blob = await encodeWithOffscreenCanvas(pixels, width, height, mimeType, quality);
    let gain = null;
    if (gainMap && mimeType === 'image/jpeg') {
      let plane;
      if (gainMap.settings) {
        const prepared = prepareAdjustPlane16(planeBuffer, width, height, gainMap.settings);
        planeWritten = true;
        plane = runAdjustPlane16(id, prepared, width, height, 'full');
      } else {
        // The plane is already adjusted (a caller that attached it directly).
        plane = new Uint16Array(planeBuffer);
      }
      const map = computeGainMap({ width, height, data: pixels }, { width, height, data: plane });
      if (map) {
        const gainBlob = await encodeWithOffscreenCanvas(map.data, map.width, map.height, 'image/jpeg', 0.85);
        gain = { blob: gainBlob, gainMax: map.gainMax, gainMin: map.gainMin };
      }
    }
    self.postMessage({ type: 'imageResult', id, blob, gain });
  } catch (err) {
    postError(id, err, planeWritten ? { pixels: pixelData } : { pixels: pixelData, plane: planeBuffer });
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

  // The samples are this worker's own copy (or a transferred export plane),
  // so a 16-bit plane may be compacted into the strip in place.
  const blob = encodeTiffBlob(data, width, height, bitDepth || 8, metadata || null, { ownedPlane: true });

  self.postMessage({ type: 'progress', id, phase: 'encoding', percent: 100 });
  self.postMessage({ type: 'blobResult', id, blob });
}
