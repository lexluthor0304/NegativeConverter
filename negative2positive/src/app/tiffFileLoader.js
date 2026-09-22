import UTIFImport from 'utif';
import { packRGBToImage16, toImageData8 } from '../silvercore/util/image16.js';

const UTIF = typeof UTIFImport?.decode === 'function' ? UTIFImport : UTIFImport.default;
const RENDERABLE_PHOTOMETRIC = new Set([0, 1, 2, 3, 5]);

// UTIF has already byte-swapped 16-bit samples to little-endian. Reuse that
// plane when possible instead of losing the low bytes through toRGBA8().
export function tiffIfdToRgb16(ifd) {
  if (!ifd?.data) return null;
  const width = ifd.width | 0, height = ifd.height | 0;
  if (width <= 0 || height <= 0) return null;
  const bits = Array.isArray(ifd.t258) ? ifd.t258 : null;
  if (!bits?.length || !bits.every(value => value === 16)) return null;
  if (Array.isArray(ifd.t284) && ifd.t284[0] === 2) return null;
  const photometric = Array.isArray(ifd.t262) ? ifd.t262[0] : 2;
  const channels = Array.isArray(ifd.t277) ? ifd.t277[0] : bits.length;
  if (!((photometric === 2 && (channels === 3 || channels === 4)) || (photometric === 1 && channels === 1))) return null;
  const sampleCount = width * height * channels;
  const data = ifd.data;
  if (!ArrayBuffer.isView(data) || data.byteLength < sampleCount * 2) return null;
  const rgb16 = data.byteOffset % 2 === 0
    ? new Uint16Array(data.buffer, data.byteOffset, sampleCount)
    : new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + sampleCount * 2));
  return { rgb16, channels, width, height };
}

export function decodeTiffBuffer(buffer) {
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
    } catch (error) {
      if (error instanceof RangeError || /allocation|out of memory|Array buffer/i.test(error?.message || '')) {
        throw Object.assign(new Error(`Not enough memory on this device to decode ${wide.width}x${wide.height}`), { code: 'DEVICE_MEMORY_LIMIT' });
      }
      throw error;
    }
  }
  const photometric = Array.isArray(ifd.t262) ? ifd.t262[0] : 2;
  if (!RENDERABLE_PHOTOMETRIC.has(photometric)) {
    throw Object.assign(new Error(`Unsupported TIFF PhotometricInterpretation: ${photometric}`), { code: 'TIFF_UNSUPPORTED_PHOTOMETRIC' });
  }
  const rgba = UTIF.toRGBA8(ifd);
  return new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), ifd.width, ifd.height);
}
