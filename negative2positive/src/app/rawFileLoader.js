import LibRaw from 'libraw-wasm';
import { decodeTiffBuffer } from './tiffFileLoader.js';
import { decodeScanInWorker } from './scanDecodeClient.js';
export { tiffIfdToRgb16 } from './tiffFileLoader.js';

import { fromImageData8 } from '../silvercore/util/image16.js';
import { startRawPostDecode } from './rawPostDecodeClient.js';
import { primeFilmStats } from './filmStatsCache.js';
import { tryNefJpegPreview, createEmbeddedPreviewSource, decodeNefPreviewJpeg } from './nefJpegPreview.js';
import { sniffImageKind, loadStandardImage, loadPngImageData } from './imageFileLoaders.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
export { estimateRawDecodeBytes };
export { rawResultToRgb16 } from './rawResultToRgb16.js';

const RAW_SIZE_HEAVY = 100 * 1024 * 1024;
// Only devices that actually report a small budget are gated, and only at a
// generous fraction of it — a false rejection is worse than a slow decode.
const RAW_LOW_MEMORY_GB = 4;
const RAW_MEMORY_BUDGET_RATIO = 0.35;
const RAW_SIZE_HUGE = 200 * 1024 * 1024;
const RAW_OPEN_TIMEOUT_MS = 30_000;
const RAW_OPEN_TIMEOUT_MS_HUGE = 60_000;
const RAW_DECODE_TIMEOUT_MS = 90_000;
const RAW_DECODE_TIMEOUT_MS_HUGE = 180_000;

function parseMetadataNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (!text) return NaN;

  const ratio = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (ratio) {
    const num = Number(ratio[1]);
    const den = Number(ratio[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  }

  const direct = text.match(/-?\d+(?:\.\d+)?/);
  if (!direct) return NaN;
  const parsed = Number(direct[0]);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeMetadataKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findMetadataValue(metadata, candidateKeys) {
  if (!metadata || typeof metadata !== 'object') return null;
  const target = new Set(candidateKeys.map(normalizeMetadataKey));
  const queue = [metadata];
  const visited = new Set();
  let depth = 0;

  while (queue.length && depth < 3000) {
    const node = queue.shift();
    depth++;
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    for (const [rawKey, rawValue] of Object.entries(node)) {
      const normalizedKey = normalizeMetadataKey(rawKey);
      if (target.has(normalizedKey) && rawValue !== null && rawValue !== undefined && rawValue !== '') {
        return rawValue;
      }
      if (rawValue && typeof rawValue === 'object') queue.push(rawValue);
    }
  }
  return null;
}

function extractRawLensMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const lensModelRaw = findMetadataValue(metadata, ['lensModel', 'lens', 'lensName', 'lensDescription', 'lensInfo']);
  const lensMakerRaw = findMetadataValue(metadata, ['lensMaker', 'lensMake']);
  const cameraModelRaw = findMetadataValue(metadata, ['cameraModel', 'model', 'camera']);
  const cameraMakerRaw = findMetadataValue(metadata, ['cameraMaker', 'make', 'cameraMake']);
  const focalRaw = findMetadataValue(metadata, ['focalLength', 'focalLen', 'focal', 'focalMm']);
  const apertureRaw = findMetadataValue(metadata, ['aperture', 'fNumber', 'fstop', 'fStop']);

  const focal = parseMetadataNumber(focalRaw);
  const aperture = parseMetadataNumber(apertureRaw);

  return {
    lensModel: lensModelRaw ? String(lensModelRaw).trim() : '',
    lensMaker: lensMakerRaw ? String(lensMakerRaw).trim() : '',
    cameraModel: cameraModelRaw ? String(cameraModelRaw).trim() : '',
    cameraMaker: cameraMakerRaw ? String(cameraMakerRaw).trim() : '',
    focal: Number.isFinite(focal) ? focal : NaN,
    aperture: Number.isFinite(aperture) ? aperture : NaN
  };
}

// A superseded load (#243) rejects with an AbortError, never with a decode
// error: the caller drops it silently, and no fallback may turn it into an
// 8-bit embedded preview.
function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('RAW decode was aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      const err = new Error(`Operation timed out after ${ms}ms`);
      err.code = 'RAW_DECODE_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/**
 * Decide whether a decode of this size fits the device.
 *
 * Only `navigator.deviceMemory` is trusted (undefined on Safari/Firefox, 8 on
 * desktop Chrome), and only when it reports 4 GB or less — no UA or
 * pointer-coarse sniffing, so desktop behaviour is unchanged.
 */
export function checkRawDecodeBudget(width, height, deviceMemoryGb) {
  const estimatedBytes = estimateRawDecodeBytes(width, height);
  if (!Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0 || deviceMemoryGb > RAW_LOW_MEMORY_GB) {
    return { ok: true, estimatedBytes, budgetBytes: Infinity };
  }
  const budgetBytes = deviceMemoryGb * 1024 * 1024 * 1024 * RAW_MEMORY_BUDGET_RATIO;
  return { ok: estimatedBytes <= budgetBytes, estimatedBytes, budgetBytes };
}

function readDeviceMemoryGb() {
  const value = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  return Number.isFinite(value) ? value : NaN;
}

function deviceMemoryError(width, height, estimatedBytes) {
  const mb = Math.round(estimatedBytes / (1024 * 1024));
  const err = new Error(`Not enough memory on this device to decode ${width}x${height} (needs about ${mb} MB)`);
  err.code = 'DEVICE_MEMORY_LIMIT';
  return err;
}

function isAllocationFailure(err) {
  return err instanceof RangeError || /allocation|out of memory|Array buffer/i.test(String(err?.message || ''));
}

function asDecodeMemoryError(err, width, height) {
  if (!isAllocationFailure(err)) return err;
  const wrapped = deviceMemoryError(width, height, estimateRawDecodeBytes(width, height));
  wrapped.cause = err;
  return wrapped;
}

/**
 * Decode a TIFF-family container through UTIF.
 *
 * Bit-depth contract: `__image16` is attached ONLY when the file genuinely
 * carries 16 bits per sample. A truly 8-bit TIFF returns plain ImageData with
 * no 16-bit mirror, so nothing downstream can mistake ×257 padding for real
 * precision (silverAdapter promotes on demand for those).
 */
async function loadTiffBuffer(buffer, signal = null) {
  const decoded = await decodeScanInWorker(buffer, 'tiff', { signal });
  if (decoded) return decoded;
  throwIfAborted(signal);
  return decodeTiffBuffer(buffer);
}

/**
 * `options.signal` (#243): aborting it disposes the LibRaw worker (an open,
 * metadata or imageData call rejects at once) and terminates the post-decode
 * worker, and the load rejects with an AbortError. The stages after LibRaw
 * are skipped once the signal is aborted, and no fallback runs for it.
 */
export async function loadRawFile(buffer, fileName, options = {}) {
  const normalizedFileName = String(fileName || '').toLowerCase();
  const onMetadata = typeof options.onMetadata === 'function' ? options.onMetadata : null;
  const fastPreview = options.preview === true;
  const signal = options.signal || null;
  throwIfAborted(signal);

  if (normalizedFileName.endsWith('.tif') || normalizedFileName.endsWith('.tiff')) {
    // A .tif name is not proof of a TIFF container: files renamed by scanning
    // software land here as JPEG or PNG and would only produce a UTIF error.
    const sniffed = sniffImageKind(buffer);
    if (sniffed && sniffed.kind !== 'tiff') {
      console.warn(`[TIFF] ${fileName} is actually ${sniffed.kind}; decoding it as such`);
      if (onMetadata) onMetadata(null);
      if (sniffed.kind === 'png') return await loadPngImageData(buffer, { signal });
      const image = await loadStandardImage(new Blob([buffer]));
      throwIfAborted(signal);
      return image;
    }
    try {
      const imageData = await loadTiffBuffer(buffer, signal);
      if (onMetadata) onMetadata(null);
      return imageData;
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      console.error('UTIF.js failed for TIFF:', err);
      throw err;
    }
  }

  if (normalizedFileName.endsWith('.dng')) {
    const textSnippet = new TextDecoder().decode(buffer.slice(0, 1000));
    if (textSnippet.includes('iPhone')) {
      try {
        // Preserve the original container for LibRaw if this is a CFA DNG
        // rather than a scanner-style TIFF that UTIF can actually render.
        const imageData = await loadTiffBuffer(buffer.slice(0), signal);
        if (onMetadata) onMetadata(null);
        return imageData;
      } catch (err) {
        if (signal?.aborted) throw abortError(signal);
        console.error('UTIF.js failed:', err);
      }
    }
  }

  const bufBytes = buffer.byteLength;
  const isIIQ = normalizedFileName.endsWith('.iiq');
  if (isIIQ && bufBytes > RAW_SIZE_HEAVY) {
    console.info('[RAW] heavy IIQ detected, taking embedded preview shortcut');
    const previewImageData = await tryNefJpegPreview(buffer);
    throwIfAborted(signal);
    if (previewImageData) {
      console.warn('[RAW] embedded preview decoded — precision is downgraded to 8-bit for this file.');
      previewImageData.__image16 ||= fromImageData8(previewImageData);
      if (onMetadata) onMetadata(null);
      return previewImageData;
    }
    console.warn('[RAW] heavy IIQ has no usable embedded preview, falling through to LibRaw');
  }

  // Fast preview: use half-size for ~4x speedup on large files
  const useHalfSize = fastPreview && bufBytes > RAW_SIZE_HEAVY;
  const use8Bit = fastPreview;

  const openTimeoutMs = fastPreview
    ? Math.min(bufBytes > RAW_SIZE_HUGE ? RAW_OPEN_TIMEOUT_MS_HUGE : RAW_OPEN_TIMEOUT_MS, 15_000)
    : (bufBytes > RAW_SIZE_HUGE ? RAW_OPEN_TIMEOUT_MS_HUGE : RAW_OPEN_TIMEOUT_MS);
  const decodeTimeoutMs = fastPreview
    ? Math.min(bufBytes > RAW_SIZE_HUGE ? RAW_DECODE_TIMEOUT_MS_HUGE : RAW_DECODE_TIMEOUT_MS, 30_000)
    : (bufBytes > RAW_SIZE_HUGE ? RAW_DECODE_TIMEOUT_MS_HUGE : RAW_DECODE_TIMEOUT_MS);

  let raw;
  try {
    raw = new LibRaw();
  } catch (err) {
    throw new Error(`module worker not supported: ${err?.message || err}`);
  }

  // Everything after LibRaw's result runs in a worker owned by this decode
  // (rawPostDecodeClient.js). Spawn it now so its start-up overlaps the decode.
  const postDecode = startRawPostDecode();

  // The embedded preview the fallbacks decode. With the source File/Blob it is
  // read lazily, only if a fallback needs it; without one it has to be copied
  // out now, because LibRaw detaches `buffer` on open().
  const previewSource = createEmbeddedPreviewSource(buffer, options.sourceBlob || null);

  const filmStatsRequest = options.filmStats && typeof options.filmStats === 'object'
    ? { borderBufferPct: options.filmStats.borderBufferPct }
    : null;

  // LibRaw keeps a dedicated worker with a 256 MB+ shared WASM heap alive until
  // it is disposed. Leaking one per load pins hundreds of MB per frame, which
  // a batch export of a whole roll turns into gigabytes.
  let rawDisposed = false;
  const disposeRaw = () => {
    if (rawDisposed) return;
    rawDisposed = true;
    try {
      if (typeof raw.dispose === 'function') raw.dispose();
      else raw.worker?.terminate?.();
    } catch {}
  };
  const killWorker = disposeRaw;
  // Abort: both workers (and LibRaw's heap) go within this task. A pending
  // open/metadata/imageData rejects with "LibRaw disposed", a pending
  // post-decode run with RAW_POST_DECODE_LOST; both are reported as aborts.
  const abortDecode = () => {
    disposeRaw();
    postDecode.terminate();
  };
  signal?.addEventListener?.('abort', abortDecode, { once: true });

  const decodeEmbeddedPreview = async () => decodeNefPreviewJpeg(await previewSource.read());

  const handleTimeoutFallback = async () => {
    // Every caller checks the signal first; this is the last line.
    throwIfAborted(signal);
    killWorker();
    postDecode.terminate();
    const previewImageData = await decodeEmbeddedPreview();
    if (previewImageData) {
      console.warn('[RAW] LibRaw could not decode this file — using embedded preview (8-bit precision).');
      previewImageData.__image16 ||= fromImageData8(previewImageData);
      if (onMetadata) onMetadata(null);
      return previewImageData;
    }
    const err = new Error('RAW decode timed out and no usable embedded preview was found');
    err.code = 'RAW_DECODE_TIMEOUT';
    throw err;
  };

  try {
    return await decodeWithLibRaw();
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    throw err;
  } finally {
    // Every exit — success, timeout fallback, error, abort — releases both workers.
    signal?.removeEventListener?.('abort', abortDecode);
    disposeRaw();
    postDecode.terminate();
  }

  async function decodeWithLibRaw() {
    // After the embedded-preview stash (the eager scan without a Blob).
    throwIfAborted(signal);
    try {
      const libRawInput = new Uint8Array(buffer);
      await withTimeout(
        raw.open(libRawInput, {
          noInterpolation: false,
          useAutoWb: true,
          useCameraWb: true,
          useCameraMatrix: 3,
          outputColor: 1,
          outputBps: use8Bit ? 8 : 16,
          halfSize: useHalfSize
        }),
        openTimeoutMs,
        killWorker,
      );
    } catch (err) {
      throwIfAborted(signal);
      if (err?.code === 'RAW_DECODE_TIMEOUT') {
        console.warn('[RAW] raw.open timed out');
        return await handleTimeoutFallback();
      }
      throw err;
    }
    // metadata() rejections are swallowed below, so check here.
    throwIfAborted(signal);

    let rawMetadata = null;
    try {
      rawMetadata = await raw.metadata(true);
    } catch (err) {
      rawMetadata = null;
    }
    throwIfAborted(signal);
    if (rawMetadata) {
      console.info('[RAW]', {
        make: rawMetadata.make,
        model: rawMetadata.model,
        compression: rawMetadata.compression,
        tiff_bps: rawMetadata.tiff_bps,
        width: rawMetadata.width,
        height: rawMetadata.height,
      });
    }
    if (onMetadata) {
      onMetadata(extractRawLensMetadata(rawMetadata));
    }

    // Refuse the decode with a translatable message instead of letting the tab
    // be killed mid-allocation on a memory-constrained device.
    const metaWidth = Number(rawMetadata?.width) || 0;
    const metaHeight = Number(rawMetadata?.height) || 0;
    if (metaWidth > 0 && metaHeight > 0) {
      const scale = useHalfSize ? 0.5 : 1;
      const budget = checkRawDecodeBudget(metaWidth * scale, metaHeight * scale, readDeviceMemoryGb());
      if (!budget.ok) {
        console.warn('[RAW] decode would exceed this device\'s memory budget', budget);
        throw deviceMemoryError(metaWidth, metaHeight, budget.estimatedBytes);
      }
    }

    let result;
    try {
      result = await withTimeout(raw.imageData(), decodeTimeoutMs, killWorker);
    } catch (err) {
      throwIfAborted(signal);
      if (err?.code === 'RAW_DECODE_TIMEOUT') {
        console.warn('[RAW] raw.imageData timed out');
        return await handleTimeoutFallback();
      }
      throw err;
    }
    throwIfAborted(signal);
    if (!result || !result.data) {
      console.error('[RAW] imageData returned empty result', result);
      return await handleTimeoutFallback();
    }
    // imageData() has returned an owned copy. The demosaicer's WASM heap is
    // no longer needed while the planes are built and defects repaired.
    disposeRaw();
    const { width, height } = result;
    // Before packing and the defect pass: a superseded decode never posts them.
    throwIfAborted(signal);

    // Packing, the garbled check, the defect pass (unless the caller opted
    // out), the 8-bit mirror and the requested film statistics all run in the
    // post-decode worker. The result's buffer moves there; drop our reference
    // so nothing here keeps the RGB16 plane alive.
    let outcome;
    try {
      const running = postDecode.run(result, {
        suppressSensorDefects: options.suppressSensorDefects !== false,
        filmStats: filmStatsRequest
      }, { signal });
      result = null;
      outcome = await running;
    } catch (err) {
      throwIfAborted(signal);
      if (err?.code === 'RAW_POST_DECODE_LOST') {
        // The worker died after taking the pixels; recover the way a decode
        // timeout does rather than failing the whole load.
        console.warn('[RAW] post-decode worker lost the decode, falling back to embedded preview:', err?.message || err);
        return await handleTimeoutFallback();
      }
      throw asDecodeMemoryError(err, width, height);
    } finally {
      postDecode.terminate();
    }
    // After the defect pass and the 8-bit mirror (both in the worker).
    throwIfAborted(signal);

    if (outcome.garbled) {
      console.warn('[RAW] decoded output looks un-demosaiced; trying embedded JPEG preview fallback');
      const previewImageData = await decodeEmbeddedPreview();
      if (previewImageData) {
        console.warn('[RAW] embedded preview decoded — precision is downgraded to 8-bit for this file.');
        previewImageData.__image16 ||= fromImageData8(previewImageData);
        return previewImageData;
      }
      const garbledErr = new Error('RAW decode produced garbled output and no usable embedded preview was found');
      garbledErr.code = 'RAW_DECODE_GARBLED';
      throw garbledErr;
    }

    // LibRaw does no hot/dead pixel mapping. A stuck photosite is harmless in a
    // normal photo but turns into a saturated single-colour dot once the
    // negative is inverted (dead red photosite → red dot in every shadow).
    const defects = outcome.defects;
    if (defects?.repaired > 0) {
      console.info(`[RAW] suppressed ${defects.repaired} isolated sensor defect(s) (R ${defects.perChannel[0]}, G ${defects.perChannel[1]}, B ${defects.perChannel[2]}; dead ${defects.dead}, hot ${defects.hot})`);
    }

    // Both planes arrive as the worker built them; wrap, do not copy.
    let imageData;
    try {
      imageData = new ImageData(outcome.rgba8, outcome.width, outcome.height);
    } catch (err) {
      throw asDecodeMemoryError(err, width, height);
    }
    imageData.__image16 = { width: outcome.width, height: outcome.height, data: outcome.rgba16 };
    if (outcome.filmStats) primeFilmStats(imageData, outcome.filmStats);
    return imageData;
  }
}
