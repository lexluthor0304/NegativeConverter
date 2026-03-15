/**
 * Pure image encoding functions extracted from main.js for use in Web Workers.
 * No DOM dependencies.
 */

const pngCrcTable = (() => {
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
 * Encode 16-bit PNG from pixel data.
 * @param {Uint8ClampedArray} pixelData - RGBA 8-bit data (upscaled to 16-bit internally)
 * @param {number} width
 * @param {number} height
 * @param {function} deflate - pako.deflate or equivalent
 * @returns {Blob}
 */
export function encodePng16Blob(pixelData, width, height, deflate) {
  const rowBytes = width * 4 * 2;
  const raw = new Uint8Array((rowBytes + 1) * height);
  let srcIndex = 0;
  let rawIndex = 0;
  for (let y = 0; y < height; y++) {
    raw[rawIndex++] = 0; // filter type: None
    for (let x = 0; x < width * 4; x++) {
      const u16 = pixelData[srcIndex++] * 257;
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

  const totalLength = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(totalLength);
  let offset = 0;
  png.set(signature, offset); offset += signature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);

  return new Blob([png], { type: 'image/png' });
}

/**
 * Encode TIFF from pixel data.
 * @param {Uint8ClampedArray} pixels - RGBA 8-bit data
 * @param {number} width
 * @param {number} height
 * @param {number} bitDepth - 8 or 16
 * @returns {Blob}
 */
export function encodeTiffBlob(pixels, width, height, bitDepth = 8) {
  const channels = 4;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stripByteCount = width * height * channels * bytesPerSample;
  const pixelData = new Uint8Array(stripByteCount);

  if (bitDepth === 16) {
    let p = 0;
    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i] * 257;
      pixelData[p++] = value & 0xFF;
      pixelData[p++] = (value >>> 8) & 0xFF;
    }
  } else {
    pixelData.set(pixels);
  }

  const headerSize = 8;
  const pixelOffset = headerSize;
  const ifdOffset = pixelOffset + pixelData.length;
  const entryCount = 12;
  const ifdSize = 2 + (entryCount * 12) + 4;
  const bitsArrayOffset = ifdOffset + ifdSize;
  const sampleFormatOffset = bitsArrayOffset + 8;
  const totalSize = sampleFormatOffset + 8;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  const writeU16 = (off, val) => view.setUint16(off, val, true);
  const writeU32 = (off, val) => view.setUint32(off, val, true);

  // Header
  out[0] = 0x49; out[1] = 0x49; // little-endian
  writeU16(2, 42);
  writeU32(4, ifdOffset);
  out.set(pixelData, pixelOffset);

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
  const sampleBit = bitDepth === 16 ? 16 : 8;
  for (let i = 0; i < 4; i++) {
    writeU16(bitsArrayOffset + (i * 2), sampleBit);
    writeU16(sampleFormatOffset + (i * 2), 1); // unsigned integer
  }

  return new Blob([out], { type: 'image/tiff' });
}
