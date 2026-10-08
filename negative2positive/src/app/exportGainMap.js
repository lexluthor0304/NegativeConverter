// The HDR gain map of a JPEG export, computed next to the SDR encode instead
// of after it. The export worker runs the 16-bit adjustment pass and the
// exact table map (`workerGainMap16`); when it cannot, the same pass and the
// same `computeGainMap` run on the main thread. Either way the map is the one
// the main thread computed before (#240): same plane, same tables, same order.
import { computeGainMap } from '../workers/gainMap.js';
import { releaseOwnedPlanes } from './planeRelease.js';

function abortError() {
  const err = new Error('Gain map request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * True when `processed` carries a 16-bit plane of its own size and `sdr` is a
 * frame of that size. Anything else produced no map before either: the
 * 16-bit pass fell back to the 8-bit stage (no plane), or `computeGainMap`
 * rejected the sizes.
 */
export function gainMapInputsMatch(processed, sdr) {
  const plane = processed && processed.__image16;
  if (!plane || !(plane.data instanceof Uint16Array) || !sdr || !sdr.data) return false;
  const { width, height } = processed;
  const samples = width * height * 4;
  return plane.width === width && plane.height === height && plane.data.length === samples
    && sdr.width === width && sdr.height === height && sdr.data.length === samples;
}

/**
 * Start the gain map for `sdr`. The returned promise settles to the map or
 * null (no map), and rejects only with an AbortError (the export's signal,
 * or its bridge disposed) or the bridge's ExportInputLostError. It always
 * carries a rejection handler, so a caller that never awaits it (an export
 * that failed before encoding) does not produce an unhandled rejection;
 * awaiting it still sees the rejection.
 *
 * @param {object} request
 * @param {ImageData} request.processed - the conversion result carrying `__image16`
 * @param {ImageData} request.sdr - the 8-bit frame being encoded
 * @param {object} request.adjustmentSettings - buildAdjustmentSettings(...), captured now
 * @param {object} [request.workers] - bridge or pool with workerGainMap16 / isWorkerAvailable
 *   (and `disposed`, true once its export is over)
 * @param {boolean} [request.transferPlane] - hand the plane to the worker without a copy
 * @param {AbortSignal} [request.signal] - the export's Cancel; a cancelled
 *   export starts no fallback pass
 * @param {(adjustmentSettings: object) => Promise<{__image16?: object}|null>} request.adjustPlane16
 *   the plane-only 16-bit pass for the fallback
 */
export function requestExportGainMap({
  processed,
  sdr,
  adjustmentSettings,
  workers = null,
  transferPlane = false,
  signal = null,
  adjustPlane16
}) {
  const run = async () => {
    if (!gainMapInputsMatch(processed, sdr)) return null;
    if (workers && typeof workers.workerGainMap16 === 'function' && workers.isWorkerAvailable()) {
      const map = await workers.workerGainMap16(processed, sdr, adjustmentSettings, { transferPlane, signal });
      if (map) return map;
    }
    // Nobody reads the map of a cancelled export, or of one whose bridge was
    // disposed of: no second pass for it.
    if ((signal && signal.aborted) || (workers && workers.disposed)) throw abortError();
    const high = await adjustPlane16(adjustmentSettings);
    const map = high && high.__image16 ? computeGainMap(sdr, high.__image16) : null;
    // The fallback's adjusted plane exists only for the map (#250): free it
    // now rather than at the next major GC (only if this export owns it).
    releaseOwnedPlanes(high);
    return map;
  };
  const pending = run();
  pending.catch(() => {});
  return pending;
}
