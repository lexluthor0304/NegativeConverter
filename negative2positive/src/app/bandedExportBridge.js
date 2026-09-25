// Step 3 of an export on the conversion band pool (#256 Part 5).
//
// The export's adjustment stage is one per-pixel pass over the frame; on the
// band pool it runs in row bands on several workers, with the frame's size
// and each band's start row, bit-identical to the export worker. This wraps
// an export bridge (a per-export bridge or a batch's pool) and takes over its
// adjustment requests for frames large enough to split; encodes, and
// everything else, go to the bridge as before:
//
// - workerApplyAdjustments16 / workerApplyAdjustments: the 16-bit pass (with
//   its 8-bit mirror unless plane-only) and the 8-bit pass on bands;
// - workerAdjust16AndEncode: the 16-bit pass on bands, then the bridge's
//   TIFF or PNG16 encode of the adjusted plane (the same encoder and settings
//   as the fused request, so the same bytes);
// - workerEncodeImage with a JPEG gain map from the unadjusted plane: that
//   plane's 16-bit pass on bands, then the encode with the adjusted plane,
//   so the SDR frame and the map's plane come from identical parameters.
//
// A frame converted with `keepResident` has its bands in the pool already:
// `resident(plane)` names them, and the pass runs there without slicing. A
// pool that fails before the frame's plane was given up falls back to the
// bridge (the single worker, the same pixels); once a plane this export owns
// was released, the failure is an ExportInputLostError and the frame renders
// again, as with a lost transferred plane.
import { markOwnedPlanes, mayTransferBuffer, isLiveMutableBuffer } from './planeRelease.js';
import { computeAdjustmentParams, isIdentityAdjustmentParams } from '../workers/pixelAdjustments.js';
import { isAbortError, inputLostError } from '../workers/workerBridge.js';
import { isConversionInputLost, WORKER_ABORTED, BAND_POOL_MIN_PIXELS } from './conversionWorkerClient.js';

function serializeSettings(settings) {
  const copy = { ...settings };
  if (copy.curves) {
    copy.curves = { r: new Uint8Array(copy.curves.r), g: new Uint8Array(copy.curves.g), b: new Uint8Array(copy.curves.b) };
  }
  return copy;
}

function isPlaneOf(plane, width, height) {
  return Boolean(plane) && plane.data instanceof Uint16Array && plane.width === width && plane.height === height
    && plane.data.length === width * height * 4;
}

function wholeOwned(view) {
  return view.byteOffset === 0 && view.buffer instanceof ArrayBuffer && view.byteLength === view.buffer.byteLength
    && mayTransferBuffer(view.buffer);
}

function asAbort(err) {
  if (err?.code !== WORKER_ABORTED) return err;
  const abort = new Error(err.message || 'Worker request aborted');
  abort.name = 'AbortError';
  return abort;
}

/**
 * @param {object} bridge an export bridge or export pool
 * @param {object} pool createConversionBandPool
 * @param {object} [options]
 * @param {() => number} [options.bands] bands for the next frame (planBandCount)
 * @param {number} [options.minPixels]
 * @param {(plane: Uint16Array) => object|null} [options.resident] the resident bands of a converted plane
 * @param {object} [options.stats]
 */
export function createBandedExportBridge(bridge, pool, { bands = () => pool.size, minPixels = BAND_POOL_MIN_PIXELS, resident = null, stats = null } = {}) {
  const wrapped = Object.create(bridge);
  const count = (name) => { if (stats) stats[name] = (stats[name] || 0) + 1; };
  const usable = (width, height, quality) => pool.available && (quality === undefined || quality === 'full')
    && width * height >= minPixels;

  // The 16-bit pass on bands: resolves the adjusted { data16, data8 } or null
  // (the caller uses the bridge). `release` lets the pool give the plane up
  // once sliced.
  async function adjust16(plane, settings, { mirror8, release, signal }) {
    const handle = resident ? resident(plane.data) : null;
    if (handle && handle.resident) {
      count('residentAdjusts');
      return handle.adjust(serializeSettings(settings), { bits16: true, mirror8, signal });
    }
    // The CPU display buffer is rewritten in place: one copy, in one task.
    const data16 = isLiveMutableBuffer(plane.data.buffer) ? new Uint16Array(plane.data) : plane.data;
    count('bandAdjusts');
    return pool.adjust({ width: plane.width, height: plane.height, data16 }, serializeSettings(settings), {
      bits16: true, mirror8, bands: bands(), signal, releaseSource: release ? { data: plane.data } : null
    });
  }

  wrapped.workerApplyAdjustments16 = async function workerApplyAdjustments16(imageData, settings, quality = 'full', onProgressOrOptions = null) {
    const opts = typeof onProgressOrOptions === 'function' ? { onProgress: onProgressOrOptions } : (onProgressOrOptions || {});
    const plane = imageData && imageData.__image16;
    if (!isPlaneOf(plane, imageData?.width, imageData?.height) || !usable(plane.width, plane.height, quality)) {
      return bridge.workerApplyAdjustments16(imageData, settings, quality, onProgressOrOptions);
    }
    const planeOnly = Boolean(opts.planeOnly);
    const release = Boolean(opts.transferPlane) && wholeOwned(plane.data);
    let result;
    try {
      result = await adjust16(plane, settings, { mirror8: !planeOnly, release, signal: opts.signal || null });
    } catch (err) {
      if (isAbortError(asAbort(err))) throw asAbort(err);
      // Lost resident bands leave this thread's plane intact: the bridge
      // adjusts it. A plane the pool released is gone.
      if (plane.data.byteLength === 0 || (isConversionInputLost(err) && release)) throw inputLostError('16-bit plane', err);
      count('fallbacks');
      return bridge.workerApplyAdjustments16(imageData, settings, quality, onProgressOrOptions);
    }
    const { width, height } = plane;
    const plane16 = { width, height, data: result.data16 };
    markOwnedPlanes(result.data16);
    if (planeOnly) return { width, height, __image16: plane16 };
    const output = new ImageData(result.data8, width, height);
    output.__image16 = plane16;
    markOwnedPlanes(output.data);
    return output;
  };

  wrapped.workerApplyAdjustments = async function workerApplyAdjustments(imageData, settings, quality = 'full', onProgressOrOptions = null) {
    const opts = typeof onProgressOrOptions === 'function' ? { onProgress: onProgressOrOptions } : (onProgressOrOptions || {});
    const { width, height } = imageData || {};
    if (!imageData || !(imageData.data instanceof Uint8ClampedArray) || imageData.data.length !== width * height * 4
      || !usable(width, height, quality)) {
      return bridge.workerApplyAdjustments(imageData, settings, quality, onProgressOrOptions);
    }
    const release = Boolean(opts.transferPlane) && wholeOwned(imageData.data);
    const handle = resident ? resident(imageData.data) : null;
    let result;
    try {
      if (handle && handle.resident) {
        count('residentAdjusts');
        result = await handle.adjust(serializeSettings(settings), { bits8: true, signal: opts.signal || null });
      } else {
        // The CPU display buffer is rewritten in place: one copy, in one task.
        const data8 = isLiveMutableBuffer(imageData.data.buffer) ? new Uint8ClampedArray(imageData.data) : imageData.data;
        count('bandAdjusts');
        result = await pool.adjust({ width, height, data8 }, serializeSettings(settings), {
          bits8: true, bands: bands(), signal: opts.signal || null, releaseSource: release ? { data: imageData.data } : null
        });
      }
    } catch (err) {
      if (isAbortError(asAbort(err))) throw asAbort(err);
      if ((isConversionInputLost(err) && !handle) || imageData.data.byteLength === 0) throw inputLostError('8-bit frame', err);
      count('fallbacks');
      return bridge.workerApplyAdjustments(imageData, settings, quality, onProgressOrOptions);
    }
    const output = new ImageData(result.data8, width, height);
    markOwnedPlanes(output.data);
    // As the bridge: an identity pass keeps the engine's 16-bit plane.
    if (imageData.__image16 && settings && settings.curves && isIdentityAdjustmentParams(computeAdjustmentParams(settings))) {
      output.__image16 = imageData.__image16;
    }
    return output;
  };

  wrapped.workerAdjust16AndEncode = async function workerAdjust16AndEncode(source, settings, options = {}) {
    const plane = source && source.__image16;
    const format = options.format;
    if ((format !== 'tiff' && format !== 'png') || !isPlaneOf(plane, source.width, source.height)
      || !usable(plane.width, plane.height)) {
      return bridge.workerAdjust16AndEncode(source, settings, options);
    }
    const released = () => plane.data.byteLength === 0;
    const adjusted = await wrapped.workerApplyAdjustments16(source, settings, 'full', {
      planeOnly: true, transferPlane: options.transferPlane, signal: options.signal
    });
    if (!adjusted || !adjusted.__image16) {
      if (released()) throw inputLostError('16-bit plane', new Error('the adjusted plane is missing'));
      return null;
    }
    const encodeOptions = { transferPlane: true, signal: options.signal, onProgress: options.onProgress };
    const blob = format === 'tiff'
      ? await bridge.workerEncodeTiff(adjusted, 16, encodeOptions, options.metadata || null)
      : await bridge.workerEncodePng16(adjusted, { ...encodeOptions, level: options.level, strategy: options.strategy, bandBytes: options.bandBytes });
    // The source may be gone (handed over): the caller's own path would read it.
    if (!blob && released()) throw inputLostError('16-bit plane', new Error('the encode of the adjusted plane failed'));
    return blob || null;
  };

  wrapped.workerEncodeImage = async function workerEncodeImage(imageData, options = {}) {
    const gain = options.mimeType === 'image/jpeg' && options.gainMap ? options.gainMap : null;
    const source = gain && gain.source && gain.settings ? gain.source : null;
    const plane = source ? source.__image16 : null;
    if (!source || !isPlaneOf(plane, imageData?.width, imageData?.height) || !usable(plane.width, plane.height)) {
      return bridge.workerEncodeImage(imageData, options);
    }
    // The unadjusted plane stays intact: a canvas fallback computes the map
    // from it again.
    let adjusted = null;
    try {
      const result = await adjust16(plane, gain.settings, { mirror8: false, release: false, signal: options.signal || null });
      adjusted = { width: plane.width, height: plane.height, data: markOwnedPlanes(result.data16) };
    } catch (err) {
      if (isAbortError(asAbort(err))) throw asAbort(err);
      count('fallbacks');
      return bridge.workerEncodeImage(imageData, options);
    }
    return bridge.workerEncodeImage(imageData, { ...options, gainMap: { plane16: adjusted, settings: null, transferPlane: true } });
  };

  return wrapped;
}
