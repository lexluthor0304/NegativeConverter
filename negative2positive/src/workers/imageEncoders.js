import { SRGB_PROFILE } from '../app/srgbProfile.js';
/**
 * Pure image encoding functions extracted from main.js for use in Web Workers.
 * No DOM dependencies — this module is imported by both the export Worker
 * (workers/exportWorker.js) and the main-thread fallback
 * (app/exportImageEncoders.js), so it must stay free of DOM APIs other than
 * Blob, which exists in both scopes.
 */

import { buildTiffParts, shortEntry, longEntry, bytesEntry, TIFF_TAGS } from './tiffWriter.js';
import { exifIfd0Entries, exifSubIfdEntries } from './exifWriter.js';
import { crc32 } from './crc32.js';
import { encodePng16BandsSerially, pngChunk } from './png16Bands.js';

/** Largest value a 16-bit sample can hold. */
export const SAMPLE16_MAX = 65535;

export function crc32OfBytes(bytes) {
  return crc32(bytes);
}

/** One PNG chunk (length, type, data, CRC-32 over type and data) as bytes. */
export function createPngChunk(type, data) {
  return pngChunk(type, data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** Signature plus IHDR: the metadata chunks are inserted right after it. */
export const PNG_HEADER_LENGTH = 33;

/** eXIf chunk carrying a TIFF-structured EXIF payload (PNG 1.5 extension). */
export function pngExifChunk(exifPayload) {
  return createPngChunk('eXIf', exifPayload);
}

/** iTXt chunk with the XMP packet under the standard "XML:com.adobe.xmp" keyword. */
export function pngXmpChunk(xml) {
  const keyword = new TextEncoder().encode('XML:com.adobe.xmp');
  const text = new TextEncoder().encode(xml);
  // keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
  const data = new Uint8Array(keyword.length + 1 + 1 + 1 + 1 + 1 + text.length);
  data.set(keyword, 0);
  let p = keyword.length;
  data[p++] = 0; data[p++] = 0; data[p++] = 0; data[p++] = 0; data[p++] = 0;
  data.set(text, p);
  return createPngChunk('iTXt', data);
}

/**
 * Decide which sample plane an export should encode from.
 *
 * The conversion engine produces a genuine 16-bit RGBA plane and the pipeline
 * attaches it to the ImageData as `__image16` (see silvercore/util/image16.js).
 * Whenever that plane is present, matches the ImageData dimensions and the user
 * asked for a 16-bit file, it is the honest source. Otherwise the 8-bit
 * `ImageData.data` is used and the encoders replicate each byte (`v * 257`),
 * which produces a structurally valid 16-bit file carrying only 8 bits of real
 * precision.
 *
 * Callers can use the returned `sampleBits` to tell the user what they are
 * actually going to get.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray,__image16?:{width:number,height:number,data:Uint16Array}}} imageData
 * @param {number} [bitDepth] - Requested output bit depth (8 or 16).
 * @returns {{samples: Uint16Array|Uint8ClampedArray, sampleBits: 8|16}}
 */
export function selectExportSamples(imageData, bitDepth = 8) {
  const plane = imageData && imageData.__image16;
  if (
    bitDepth === 16
    && plane
    && plane.data instanceof Uint16Array
    && plane.width === imageData.width
    && plane.height === imageData.height
    && plane.data.length === imageData.width * imageData.height * 4
  ) {
    return { samples: plane.data, sampleBits: 16 };
  }
  return { samples: imageData.data, sampleBits: 8 };
}

/**
 * Encode a 16-bit PNG (RGB for opaque images, RGBA for real transparency).
 *
 * The rows are Sub-filtered and deflated in fixed bands (png16Bands.js), one
 * after another on this thread; the band pool runs the same bands across
 * workers and produces the same bytes.
 *
 * @param {Uint16Array|Uint8ClampedArray|Uint8Array} pixelData - RGBA samples.
 *   A `Uint16Array` carries genuine 16-bit samples and is written verbatim.
 *   An 8-bit array is the documented fallback: every byte is replicated
 *   (`v * 257`, so 0xAB -> 0xABAB) which keeps 0 -> 0 and 255 -> 65535 but adds
 *   no real precision.
 * @param {number} width
 * @param {number} height
 * @param {{Deflate: Function}} zlib - pako (its streaming `Deflate` is used)
 * @param {{level?: number, strategy?: number}} [options]
 * @returns {Blob}
 */
export function encodePng16Blob(pixelData, width, height, zlib, options = {}) {
  return encodePng16BandsSerially(pixelData, width, height, exportChannelCount(pixelData), zlib, options);
}

/**
 * Channels a 16-bit PNG or TIFF of these samples carries: 3 for a 16-bit
 * plane (alpha is written opaque) or opaque 8-bit data, 4 when 8-bit data
 * has real transparency. Decided once for the whole frame.
 */
export function exportChannelCount(pixels) {
  // The existing 16-bit export contract makes alpha opaque. Eight-bit
  // callers may supply transparency, which must continue to round-trip.
  if (pixels instanceof Uint16Array) return 3;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return 4;
  return 3;
}

/**
 * Encode an uncompressed baseline TIFF (RGBA, little-endian).
 *
 * @param {Uint16Array|Uint8ClampedArray|Uint8Array} pixels - RGBA samples.
 *   A `Uint16Array` carries genuine 16-bit samples; at `bitDepth` 16 they are
 *   written verbatim and at `bitDepth` 8 they are reduced with `>>> 8`.
 *   An 8-bit array is the documented fallback: at `bitDepth` 16 each byte is
 *   replicated (`v * 257`), adding no real precision.
 * @param {number} width
 * @param {number} height
 * @param {number} bitDepth - 8 or 16
 * @param {{exif?: object, xmp?: string}|null} [metadata] - analog metadata:
 *   descriptive EXIF fields go into IFD0 and an Exif sub-IFD, the XMP packet
 *   into tag 700.
 * @returns {Blob}
 */
export function encodeTiffBlob(pixels, width, height, bitDepth = 8, metadata = null) {
  const channels = exportChannelCount(pixels);
  const wants16 = bitDepth === 16;
  const source16 = pixels instanceof Uint16Array;
  const bytesPerSample = wants16 ? 2 : 1;
  const sampleCount = width * height * channels;
  const stripByteCount = sampleCount * bytesPerSample;
  // The strip is the only large buffer; the IFDs are a few hundred bytes and
  // the Blob concatenates the parts without copying the strip again.
  const strip = new Uint8Array(stripByteCount);
  let p = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = pixels[i + channel];
      if (wants16) {
        const value = source16 ? sample : sample * 257;
        strip[p++] = value & 0xFF;
        strip[p++] = value >>> 8;
      } else {
        strip[p++] = source16 ? sample >>> 8 : sample;
      }
    }
  }

  const sampleBit = wants16 ? 16 : 8;
  const entries = [
    bytesEntry(34675, SRGB_PROFILE),
    longEntry(TIFF_TAGS.ImageWidth, width),
    longEntry(TIFF_TAGS.ImageLength, height),
    shortEntry(TIFF_TAGS.BitsPerSample, Array(channels).fill(sampleBit)),
    shortEntry(TIFF_TAGS.Compression, 1),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, 2),
    shortEntry(TIFF_TAGS.SamplesPerPixel, channels),
    longEntry(TIFF_TAGS.RowsPerStrip, height),
    longEntry(TIFF_TAGS.StripByteCounts, stripByteCount),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1),
    ...(channels === 4 ? [shortEntry(TIFF_TAGS.ExtraSamples, 1)] : []),
    shortEntry(TIFF_TAGS.SampleFormat, Array(channels).fill(1)),
    ...(metadata ? exifIfd0Entries(metadata.exif || {}, { xmp: metadata.xmp || null }) : [])
  ];
  const parts = buildTiffParts({
    entries,
    exif: metadata && metadata.exif ? exifSubIfdEntries(metadata.exif) : null,
    blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: strip }]
  });
  return new Blob(parts, { type: 'image/tiff' });
}
