/**
 * Pure image encoding functions extracted from main.js for use in Web Workers.
 * No DOM dependencies — this module is imported by both the export Worker
 * (workers/exportWorker.js) and the main-thread fallback
 * (app/exportImageEncoders.js), so it must stay free of DOM APIs other than
 * Blob, which exists in both scopes.
 */

import { buildTiffParts, shortEntry, longEntry, TIFF_TAGS } from './tiffWriter.js';
import { exifIfd0Entries, exifSubIfdEntries } from './exifWriter.js';

/** Largest value a 16-bit sample can hold. */
export const SAMPLE16_MAX = 65535;

// Annotated pure so bundlers can tree-shake the encoders out of chunks that
// only import selectExportSamples (the main bundle imports it via workerBridge).
const pngCrcTable = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32OfBytes(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = pngCrcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function createPngChunk(type, data) {
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunk = new Uint8Array(12 + dataBytes.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, dataBytes.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(dataBytes, 8);
  const crc = crc32OfBytes(chunk.subarray(4, 8 + dataBytes.length));
  view.setUint32(8 + dataBytes.length, crc, false);
  return chunk;
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
 * Encode a 16-bit PNG (colour type 6, RGBA, bit depth 16).
 *
 * @param {Uint16Array|Uint8ClampedArray|Uint8Array} pixelData - RGBA samples.
 *   A `Uint16Array` carries genuine 16-bit samples and is written verbatim.
 *   An 8-bit array is the documented fallback: every byte is replicated
 *   (`v * 257`, so 0xAB -> 0xABAB) which keeps 0 -> 0 and 255 -> 65535 but adds
 *   no real precision.
 * @param {number} width
 * @param {number} height
 * @param {function} deflate - pako.deflate or equivalent
 * @returns {Blob}
 */
export function encodePng16Blob(pixelData, width, height, deflate) {
  const is16 = pixelData instanceof Uint16Array;
  const rowBytes = width * 4 * 2;
  const raw = new Uint8Array((rowBytes + 1) * height);
  const samplesPerRow = width * 4;
  let srcIndex = 0;
  let rawIndex = 0;
  for (let y = 0; y < height; y++) {
    raw[rawIndex++] = 0; // filter type: None
    for (let x = 0; x < samplesPerRow; x++) {
      // The app never carries real transparency (the 8-bit adjustment stage
      // forces alpha to 255), so keep 16-bit exports fully opaque rather than
      // trusting whatever alpha the engine plane happens to hold.
      const u16 = is16
        ? ((x & 3) === 3 ? SAMPLE16_MAX : pixelData[srcIndex])
        : pixelData[srcIndex] * 257;
      srcIndex++;
      raw[rawIndex++] = (u16 >>> 8) & 0xFF;
      raw[rawIndex++] = u16 & 0xFF;
    }
  }

  const compressed = deflate(raw, { level: 6 });
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createPngChunk('IHDR', ihdr);
  const idatChunk = createPngChunk('IDAT', compressed);
  const iendChunk = createPngChunk('IEND', new Uint8Array(0));

  // Blob accepts an array of parts — concatenating into one buffer first would
  // duplicate the whole file (hundreds of MB for a large scan) for nothing.
  return new Blob([signature, ihdrChunk, idatChunk, iendChunk], { type: 'image/png' });
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
  const channels = 4;
  const wants16 = bitDepth === 16;
  const source16 = pixels instanceof Uint16Array;
  const bytesPerSample = wants16 ? 2 : 1;
  const sampleCount = width * height * channels;
  const stripByteCount = sampleCount * bytesPerSample;
  // The strip is the only large buffer; the IFDs are a few hundred bytes and
  // the Blob concatenates the parts without copying the strip again.
  const strip = new Uint8Array(stripByteCount);
  let p = 0;
  if (wants16) {
    for (let i = 0; i < sampleCount; i++) {
      // Alpha is forced opaque; see the note in encodePng16Blob.
      const value = source16
        ? ((i & 3) === 3 ? SAMPLE16_MAX : pixels[i])
        : pixels[i] * 257;
      strip[p++] = value & 0xFF;
      strip[p++] = (value >>> 8) & 0xFF;
    }
  } else if (source16) {
    for (let i = 0; i < sampleCount; i++) {
      strip[p++] = (i & 3) === 3 ? 255 : (pixels[i] >>> 8);
    }
  } else {
    strip.set(pixels.subarray(0, sampleCount));
  }

  const sampleBit = wants16 ? 16 : 8;
  const entries = [
    longEntry(TIFF_TAGS.ImageWidth, width),
    longEntry(TIFF_TAGS.ImageLength, height),
    shortEntry(TIFF_TAGS.BitsPerSample, [sampleBit, sampleBit, sampleBit, sampleBit]),
    shortEntry(TIFF_TAGS.Compression, 1),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, 2),
    shortEntry(TIFF_TAGS.SamplesPerPixel, channels),
    longEntry(TIFF_TAGS.RowsPerStrip, height),
    longEntry(TIFF_TAGS.StripByteCounts, stripByteCount),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1),
    shortEntry(TIFF_TAGS.ExtraSamples, 1),
    shortEntry(TIFF_TAGS.SampleFormat, [1, 1, 1, 1]),
    ...(metadata ? exifIfd0Entries(metadata.exif || {}, { xmp: metadata.xmp || null }) : [])
  ];
  const parts = buildTiffParts({
    entries,
    exif: metadata && metadata.exif ? exifSubIfdEntries(metadata.exif) : null,
    blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: strip }]
  });
  return new Blob(parts, { type: 'image/tiff' });
}
