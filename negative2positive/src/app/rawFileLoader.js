import LibRaw from 'libraw-wasm';
import UTIFImport from 'utif';

import {
  fromImageData8,
  packRGBToImage16,
  toImageData8
} from '../silvercore/util/image16.js';
import { looksLikeBayerSnow } from '../silvercore/util/garbledCheck.js';
import { tryNefJpegPreview } from './nefJpegPreview.js';

const UTIF = (UTIFImport && typeof UTIFImport.decode === 'function')
  ? UTIFImport
  : (UTIFImport && UTIFImport.default && typeof UTIFImport.default.decode === 'function'
    ? UTIFImport.default
    : UTIFImport);

const RAW_SIZE_HEAVY = 100 * 1024 * 1024;
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

export async function loadRawFile(buffer, fileName, options = {}) {
  const normalizedFileName = String(fileName || '').toLowerCase();
  const onMetadata = typeof options.onMetadata === 'function' ? options.onMetadata : null;

  if (normalizedFileName.endsWith('.tif') || normalizedFileName.endsWith('.tiff')) {
    try {
      const ifds = UTIF.decode(buffer);
      UTIF.decodeImage(buffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      if (onMetadata) onMetadata(null);
      const imageData = new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height);
      imageData.__image16 = fromImageData8(imageData);
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
        const ifds = UTIF.decode(buffer);
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        if (onMetadata) onMetadata(null);
        const imageData = new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height);
        imageData.__image16 = fromImageData8(imageData);
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

  const openTimeoutMs = bufBytes > RAW_SIZE_HUGE ? RAW_OPEN_TIMEOUT_MS_HUGE : RAW_OPEN_TIMEOUT_MS;
  const decodeTimeoutMs = bufBytes > RAW_SIZE_HUGE ? RAW_DECODE_TIMEOUT_MS_HUGE : RAW_DECODE_TIMEOUT_MS;

  let raw;
  try {
    raw = new LibRaw();
  } catch (err) {
    throw new Error(`module worker not supported: ${err?.message || err}`);
  }

  const killWorker = () => {
    try { raw.worker?.terminate?.(); } catch {}
  };

  const handleTimeoutFallback = async () => {
    killWorker();
    const previewImageData = await tryNefJpegPreview(buffer);
    if (previewImageData) {
      console.warn('[RAW] LibRaw timed out — using embedded preview (8-bit precision).');
      previewImageData.__image16 = fromImageData8(previewImageData);
      if (onMetadata) onMetadata(null);
      return previewImageData;
    }
    const err = new Error('RAW decode timed out and no usable embedded preview was found');
    err.code = 'RAW_DECODE_TIMEOUT';
    throw err;
  };

  try {
    const libRawInput = new Uint8Array(buffer.slice(0));
    await withTimeout(
      raw.open(libRawInput, {
        noInterpolation: false,
        useAutoWb: true,
        useCameraWb: true,
        useCameraMatrix: 3,
        outputColor: 1,
        outputBps: 16
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
  const { width, height, data: rgbData } = result;

  const pixelCount = width * height;
  let rgb16;
  if (rgbData instanceof Uint16Array) {
    rgb16 = rgbData;
  } else if (rgbData?.buffer instanceof ArrayBuffer && rgbData.length === pixelCount * 6) {
    rgb16 = new Uint16Array(rgbData.buffer, rgbData.byteOffset, pixelCount * 3);
  } else {
    rgb16 = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount * 3; i++) {
      rgb16[i] = rgbData[i * 2] | (rgbData[i * 2 + 1] << 8);
    }
  }

  const image16 = packRGBToImage16(width, height, rgb16, 3);

  if (looksLikeBayerSnow(image16)) {
    console.warn('[RAW] decoded output looks un-demosaiced; trying embedded JPEG preview fallback');
    const previewImageData = await tryNefJpegPreview(buffer);
    if (previewImageData) {
      console.warn('[RAW] embedded preview decoded — precision is downgraded to 8-bit for this file.');
      previewImageData.__image16 = fromImageData8(previewImageData);
      return previewImageData;
    }
    const garbledErr = new Error('RAW decode produced garbled output and no usable embedded preview was found');
    garbledErr.code = 'RAW_DECODE_GARBLED';
    throw garbledErr;
  }

  const imageData = toImageData8(image16);
  imageData.__image16 = image16;
  return imageData;
}
