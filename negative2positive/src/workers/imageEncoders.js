/**
 * Pure image encoding functions extracted from main.js for use in Web Workers.
 * No DOM dependencies — this module is imported by both the export Worker
 * (workers/exportWorker.js) and the main-thread fallback
 * (app/exportImageEncoders.js), so it must stay free of DOM APIs other than
 * Blob, which exists in both scopes.
 */

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
 * @returns {Blob}
 */
export function encodeTiffBlob(pixels, width, height, bitDepth = 8) {
  const channels = 4;
  const wants16 = bitDepth === 16;
  const source16 = pixels instanceof Uint16Array;
  const bytesPerSample = wants16 ? 2 : 1;
  const sampleCount = width * height * channels;
  const stripByteCount = sampleCount * bytesPerSample;

  const headerSize = 8;
  const pixelOffset = headerSize;
  const ifdOffset = pixelOffset + stripByteCount;
  const entryCount = 12;
  const ifdSize = 2 + (entryCount * 12) + 4;
  const bitsArrayOffset = ifdOffset + ifdSize;
  const sampleFormatOffset = bitsArrayOffset + 8;
  const totalSize = sampleFormatOffset + 8;
  // Write the strip straight into the output buffer — a separate scratch buffer
  // would double peak memory for large exports.
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let p = pixelOffset;
  if (wants16) {
    for (let i = 0; i < sampleCount; i++) {
      // Alpha is forced opaque; see the note in encodePng16Blob.
      const value = source16
        ? ((i & 3) === 3 ? SAMPLE16_MAX : pixels[i])
        : pixels[i] * 257;
      out[p++] = value & 0xFF;
      out[p++] = (value >>> 8) & 0xFF;
    }
  } else if (source16) {
    for (let i = 0; i < sampleCount; i++) {
      out[p++] = (i & 3) === 3 ? 255 : (pixels[i] >>> 8);
    }
  } else {
    out.set(pixels.subarray(0, sampleCount), pixelOffset);
  }

  const writeU16 = (off, val) => view.setUint16(off, val, true);
  const writeU32 = (off, val) => view.setUint32(off, val, true);

  // Header
  out[0] = 0x49; out[1] = 0x49; // little-endian
  writeU16(2, 42);
  writeU32(4, ifdOffset);

  // IFD
  writeU16(ifdOffset, entryCount);
  let entryOffset = ifdOffset + 2;
  const writeEntry = (tag, type, count, valueOrOffset) => {
    writeU16(entryOffset, tag);
    writeU16(entryOffset + 2, type);
    writeU32(entryOffset + 4, count);
    writeU32(entryOffset + 8, valueOrOffset);
    entryOffset += 12;
  };
  const shortInline = (value) => value & 0xFFFF;

  writeEntry(256, 4, 1, width);                 // ImageWidth
  writeEntry(257, 4, 1, height);                // ImageLength
  writeEntry(258, 3, 4, bitsArrayOffset);       // BitsPerSample
  writeEntry(259, 3, 1, shortInline(1));        // Compression = none
  writeEntry(262, 3, 1, shortInline(2));        // Photometric = RGB
  writeEntry(273, 4, 1, pixelOffset);           // StripOffsets
  writeEntry(277, 3, 1, shortInline(channels)); // SamplesPerPixel
  writeEntry(278, 4, 1, height);                // RowsPerStrip
  writeEntry(279, 4, 1, stripByteCount);        // StripByteCounts
  writeEntry(284, 3, 1, shortInline(1));        // PlanarConfiguration
  writeEntry(338, 3, 1, shortInline(1));        // ExtraSamples (associated alpha)
  writeEntry(339, 3, 4, sampleFormatOffset);    // SampleFormat

  writeU32(entryOffset, 0); // next IFD offset

  // Extra value arrays
  const sampleBit = wants16 ? 16 : 8;
  for (let i = 0; i < 4; i++) {
    writeU16(bitsArrayOffset + (i * 2), sampleBit);
    writeU16(sampleFormatOffset + (i * 2), 1); // unsigned integer
  }

  return new Blob([out], { type: 'image/tiff' });
}
