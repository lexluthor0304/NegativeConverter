import LibRaw from 'libraw-wasm';
import UTIFImport from 'utif';

import {
  fromImageData8,
  packRGBToImage16,
  toImageData8
} from '../silvercore/util/image16.js';
import { looksLikeBayerSnow } from '../silvercore/util/garbledCheck.js';
import { suppressSensorDefectsInWorker } from './sensorDefectsClient.js';
import { tryNefJpegPreview, extractNefPreviewJpeg, decodeNefPreviewJpeg } from './nefJpegPreview.js';
import { sniffImageKind, loadStandardImage, loadPngImageData } from './imageFileLoaders.js';

const UTIF = (UTIFImport && typeof UTIFImport.decode === 'function')
  ? UTIFImport
  : (UTIFImport && UTIFImport.default && typeof UTIFImport.default.decode === 'function'
    ? UTIFImport.default
    : UTIFImport);

const RAW_SIZE_HEAVY = 100 * 1024 * 1024;
// The LibRaw worker starts with a 256 MB WASM heap and grows while it holds the
// packed sensor data plus the demosaiced output.
const RAW_WASM_BASE_BYTES = 256 * 1024 * 1024;
const RAW_WASM_BYTES_PER_PIXEL = 8;
// rgb16 (6 B/px) + the packed RGBA16 plane (8 B/px) + the 8-bit mirror (4 B/px).
const RAW_JS_BYTES_PER_PIXEL = 18;
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
 * Peak bytes a full-resolution RAW decode needs across the WASM heap and the
 * JS copies it produces. Pure, so it can be checked before anything is
 * allocated.
 */
export function estimateRawDecodeBytes(width, height) {
  const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  return RAW_WASM_BASE_BYTES
    + pixels * RAW_WASM_BYTES_PER_PIXEL
    + pixels * RAW_JS_BYTES_PER_PIXEL;
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

// TIFF PhotometricInterpretation values we can promote losslessly.
const TIFF_PHOTOMETRIC_BLACK_IS_ZERO = 1;
const TIFF_PHOTOMETRIC_RGB = 2;
// Everything UTIF.toRGBA8 knows how to render: WhiteIsZero, BlackIsZero, RGB,
// palette and CMYK. For anything else it logs and returns an all-zero buffer,
// i.e. a black frame presented as a successful decode.
const TIFF_PHOTOMETRIC_RENDERABLE = new Set([0, 1, 2, 3, 5]);

/**
 * Build a true 16-bit sample view over a decoded UTIF IFD.
 *
 * `UTIF.toRGBA8` keeps only the high byte of every 16-bit sample, so a 48-bit
 * scanner TIFF — the standard output of Epson Scan / VueScan / SilverFast —
 * would lose exactly the precision the 16-bit pipeline exists for. UTIF has
 * already byte-swapped big-endian samples to little-endian in decodeImage, so
 * the decoded bytes can be reinterpreted directly.
 *
 * @returns {{ rgb16: Uint16Array, channels: number, width: number, height: number } | null}
 *          null when the IFD is not a plain 16-bit grey/RGB image, in which
 *          case the caller must fall back to UTIF.toRGBA8.
 */
export function tiffIfdToRgb16(ifd) {
  if (!ifd || !ifd.data) return null;
  const width = ifd.width | 0;
  const height = ifd.height | 0;
  if (width <= 0 || height <= 0) return null;

  const bitsPerSample = Array.isArray(ifd.t258) ? ifd.t258 : null;
  if (!bitsPerSample || !bitsPerSample.length) return null;
  if (!bitsPerSample.every((bits) => bits === 16)) return null;

  // PlanarConfiguration 2 stores channels in separate planes; UTIF does not
  // even decode it (it only logs), so never claim it here.
  if (Array.isArray(ifd.t284) && ifd.t284[0] === 2) return null;

  const photometric = Array.isArray(ifd.t262) ? ifd.t262[0] : TIFF_PHOTOMETRIC_RGB;
  const channels = Array.isArray(ifd.t277) ? ifd.t277[0] : bitsPerSample.length;

  const supported = (photometric === TIFF_PHOTOMETRIC_RGB && (channels === 3 || channels === 4))
    || (photometric === TIFF_PHOTOMETRIC_BLACK_IS_ZERO && channels === 1);
  if (!supported) return null;

  const sampleCount = width * height * channels;
  const data = ifd.data;
  if (!ArrayBuffer.isView(data) || data.byteLength < sampleCount * 2) return null;

  const rgb16 = (data.byteOffset % 2 === 0)
    ? new Uint16Array(data.buffer, data.byteOffset, sampleCount)
    : new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + sampleCount * 2));

  return { rgb16, channels, width, height };
}

/**
 * Normalise whatever `LibRaw.imageData()` returned into 16-bit samples.
 *
 * The shape depends on the requested `outputBps`: 8 gives a Uint8Array of
 * width*height*colors bytes, 16 gives a Uint16Array of the same sample count.
 * Reading an 8-bit result as little-endian byte pairs (the old fallback) fuses
 * neighbouring samples into nonsense and runs off the end of the buffer.
 *
 * @returns {{ rgb16: Uint16Array, channels: number }}
 */
export function rawResultToRgb16(result) {
  const width = result?.width | 0;
  const height = result?.height | 0;
  const data = result?.data;
  const pixelCount = width * height;
  if (pixelCount <= 0 || !data || typeof data.length !== 'number') {
    const err = new Error('RAW decode returned no pixels');
    err.code = 'RAW_DECODE_GARBLED';
    throw err;
  }

  const bytesPerPixel = data.length / pixelCount;
  let sixteenBit;
  if (data instanceof Uint16Array) sixteenBit = true;
  else if (result.bits === 16) sixteenBit = true;
  else if (result.bits === 8) sixteenBit = false;
  // 8-bit output is 1/3/4 bytes per pixel, 16-bit output 2/6/8 — no overlap.
  else sixteenBit = bytesPerPixel === 2 || bytesPerPixel === 6 || bytesPerPixel === 8;

  const totalSamples = data instanceof Uint16Array
    ? data.length
    : Math.floor(data.length / (sixteenBit ? 2 : 1));

  let channels = Number.isInteger(result.colors) ? result.colors : 0;
  if (channels * pixelCount !== totalSamples) channels = Math.round(totalSamples / pixelCount);
  if ((channels !== 1 && channels !== 3 && channels !== 4) || channels * pixelCount > totalSamples) {
    const err = new Error(`Unexpected RAW sample layout: ${data.length} values for ${width}x${height}`);
    err.code = 'RAW_DECODE_GARBLED';
    throw err;
  }

  const sampleCount = pixelCount * channels;
  let rgb16;
  if (data instanceof Uint16Array) {
    rgb16 = data.length === sampleCount ? data : data.subarray(0, sampleCount);
  } else if (sixteenBit) {
    rgb16 = (data.byteOffset % 2 === 0 && data.buffer)
      ? new Uint16Array(data.buffer, data.byteOffset, sampleCount)
      : Uint16Array.from({ length: sampleCount }, (_, i) => data[i * 2] | (data[i * 2 + 1] << 8));
  } else {
    rgb16 = new Uint16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) rgb16[i] = data[i] * 257;
  }

  // packRGBToImage16 wraps a 4-channel plane without copying; make sure that
  // plane is ours and not a view into the (soon disposed) WASM heap.
  if (channels === 4 && rgb16.buffer !== undefined && !(rgb16.buffer instanceof ArrayBuffer)) {
    rgb16 = new Uint16Array(rgb16);
  }

  return { rgb16, channels };
}

/**
 * Decode a TIFF-family container through UTIF.
 *
 * Bit-depth contract: `__image16` is attached ONLY when the file genuinely
 * carries 16 bits per sample. A truly 8-bit TIFF returns plain ImageData with
 * no 16-bit mirror, so nothing downstream can mistake ×257 padding for real
 * precision (silverAdapter promotes on demand for those).
 */
function decodeTiffBuffer(buffer) {
  const ifds = UTIF.decode(buffer);
  const ifd = ifds[0];
  UTIF.decodeImage(buffer, ifd, ifds);

  const wide = tiffIfdToRgb16(ifd);
  if (wide) {
    try {
      const image16 = packRGBToImage16(wide.width, wide.height, wide.rgb16, wide.channels);
      const imageData = toImageData8(image16);
      imageData.__image16 = image16;
      return imageData;
    } catch (err) {
      throw asDecodeMemoryError(err, wide.width, wide.height);
    }
  }

  const photometric = Array.isArray(ifd.t262) ? ifd.t262[0] : TIFF_PHOTOMETRIC_RGB;
  if (!TIFF_PHOTOMETRIC_RENDERABLE.has(photometric)) {
    // Raw CFA / LinearRaw payloads (32803 / 34892, e.g. iPhone ProRAW) end up
    // here. Fail instead of returning UTIF's all-zero buffer, so the DNG path
    // falls through to LibRaw rather than showing a black frame.
    const err = new Error(`Unsupported TIFF PhotometricInterpretation: ${photometric}`);
    err.code = 'TIFF_UNSUPPORTED_PHOTOMETRIC';
    throw err;
  }

  const rgba = UTIF.toRGBA8(ifd);
  // toRGBA8 already allocates a fresh Uint8Array; wrap it instead of copying.
  return new ImageData(
    new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    ifd.width,
    ifd.height
  );
}

export async function loadRawFile(buffer, fileName, options = {}) {
  const normalizedFileName = String(fileName || '').toLowerCase();
  const onMetadata = typeof options.onMetadata === 'function' ? options.onMetadata : null;
  const fastPreview = options.preview === true;

  if (normalizedFileName.endsWith('.tif') || normalizedFileName.endsWith('.tiff')) {
    // A .tif name is not proof of a TIFF container: files renamed by scanning
    // software land here as JPEG or PNG and would only produce a UTIF error.
    const sniffed = sniffImageKind(buffer);
    if (sniffed && sniffed.kind !== 'tiff') {
      console.warn(`[TIFF] ${fileName} is actually ${sniffed.kind}; decoding it as such`);
      if (onMetadata) onMetadata(null);
      if (sniffed.kind === 'png') return await loadPngImageData(buffer);
      return await loadStandardImage(new Blob([buffer]));
    }
    try {
      const imageData = decodeTiffBuffer(buffer);
      if (onMetadata) onMetadata(null);
      return imageData;
    } catch (err) {
      console.error('UTIF.js failed for TIFF:', err);
      throw err;
    }
  }

  if (normalizedFileName.endsWith('.dng')) {
    const textSnippet = new TextDecoder().decode(buffer.slice(0, 1000));
    if (textSnippet.includes('iPhone')) {
      try {
        const imageData = decodeTiffBuffer(buffer);
        if (onMetadata) onMetadata(null);
        return imageData;
      } catch (err) {
        console.error('UTIF.js failed:', err);
      }
    }
  }

  const bufBytes = buffer.byteLength;
  const isIIQ = normalizedFileName.endsWith('.iiq');
  if (isIIQ && bufBytes > RAW_SIZE_HEAVY) {
    console.info('[RAW] heavy IIQ detected, taking embedded preview shortcut');
    const previewImageData = await tryNefJpegPreview(buffer);
    if (previewImageData) {
      console.warn('[RAW] embedded preview decoded — precision is downgraded to 8-bit for this file.');
      previewImageData.__image16 = fromImageData8(previewImageData);
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

  // LibRaw transfers the container ArrayBuffer to its worker on open(), which
  // DETACHES `buffer` on this thread (byteLength drops to 0). Anything the
  // fallback paths need must therefore be copied out first — extracting after
  // open() silently finds nothing, which is exactly how the Zf/Z8/Z9
  // high-efficiency fallback regressed. The copy is the JPEG tail only, and
  // it is short-lived (function scope).
  let stashedPreview = null;
  try {
    const extracted = extractNefPreviewJpeg(buffer);
    if (extracted) {
      const jpegCopy = new Uint8Array(extracted.jpegBytes.byteLength);
      jpegCopy.set(extracted.jpegBytes);
      stashedPreview = { jpegBytes: jpegCopy, width: extracted.width, height: extracted.height };
    }
  } catch {}

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

  const handleTimeoutFallback = async () => {
    killWorker();
    const previewImageData = await decodeNefPreviewJpeg(stashedPreview);
    if (previewImageData) {
      console.warn('[RAW] LibRaw could not decode this file — using embedded preview (8-bit precision).');
      previewImageData.__image16 = fromImageData8(previewImageData);
      if (onMetadata) onMetadata(null);
      return previewImageData;
    }
    const err = new Error('RAW decode timed out and no usable embedded preview was found');
    err.code = 'RAW_DECODE_TIMEOUT';
    throw err;
  };

  try {
    return await decodeWithLibRaw();
  } finally {
    // Every exit — success, timeout fallback, error — releases the worker.
    disposeRaw();
  }

  async function decodeWithLibRaw() {
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
      if (err?.code === 'RAW_DECODE_TIMEOUT') {
        console.warn('[RAW] raw.open timed out');
        return await handleTimeoutFallback();
      }
      throw err;
    }

    let rawMetadata = null;
    try {
      rawMetadata = await raw.metadata(true);
    } catch (err) {
      rawMetadata = null;
    }
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
      if (err?.code === 'RAW_DECODE_TIMEOUT') {
        console.warn('[RAW] raw.imageData timed out');
        return await handleTimeoutFallback();
      }
      throw err;
    }
    if (!result || !result.data) {
      console.error('[RAW] imageData returned empty result', result);
      return await handleTimeoutFallback();
    }
    const { width, height } = result;

    let image16;
    try {
      const { rgb16, channels } = rawResultToRgb16(result);
      image16 = packRGBToImage16(width, height, rgb16, channels);
    } catch (err) {
      throw asDecodeMemoryError(err, width, height);
    }

    if (looksLikeBayerSnow(image16)) {
      console.warn('[RAW] decoded output looks un-demosaiced; trying embedded JPEG preview fallback');
      const previewImageData = await decodeNefPreviewJpeg(stashedPreview);
      if (previewImageData) {
        console.warn('[RAW] embedded preview decoded — precision is downgraded to 8-bit for this file.');
        previewImageData.__image16 = fromImageData8(previewImageData);
        return previewImageData;
      }
      const garbledErr = new Error('RAW decode produced garbled output and no usable embedded preview was found');
      garbledErr.code = 'RAW_DECODE_GARBLED';
      throw garbledErr;
    }

    // LibRaw does no hot/dead pixel mapping. A stuck photosite is harmless in a
    // normal photo but turns into a saturated single-colour dot once the
    // negative is inverted (dead red photosite → red dot in every shadow).
    try {
      const defects = options.suppressSensorDefects === false
        ? { repaired: 0 }
        : await suppressSensorDefectsInWorker(image16);
      if (defects.repaired > 0) {
        console.info(`[RAW] suppressed ${defects.repaired} isolated sensor defect(s) (R ${defects.perChannel[0]}, G ${defects.perChannel[1]}, B ${defects.perChannel[2]}; dead ${defects.dead}, hot ${defects.hot})`);
      }
    } catch (err) {
      // Only reachable if the worker died after taking the pixels; recover the
      // way a decode timeout does rather than failing the whole load.
      console.warn('[RAW] sensor defect suppression lost the decode, falling back to embedded preview:', err?.message || err);
      return await handleTimeoutFallback();
    }

    try {
      const imageData = toImageData8(image16);
      imageData.__image16 = image16;
      return imageData;
    } catch (err) {
      throw asDecodeMemoryError(err, width, height);
    }
  }
}
