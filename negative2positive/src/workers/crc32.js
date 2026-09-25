/**
 * CRC-32 (IEEE 802.3, the polynomial of PNG chunks and ZIP entries) with
 * slice-by-8 tables: eight bytes per step instead of one. Same polynomial,
 * initial value and final XOR as the byte-wise loop, so every value is
 * identical; it is only faster. Shared by the PNG IDAT chunks
 * (imageEncoders.js, png16Bands.js) and the ZIP writer (app/zipStoreWriter.js).
 */

// Annotated pure so bundlers can drop the tables from chunks that never
// compute a CRC.
const TABLES = /* @__PURE__ */ (() => {
  const tables = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tables[n] = c >>> 0;
  }
  // tables[k][n]: the CRC register after byte n followed by k zero bytes.
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let k = 1; k < 8; k++) {
      c = tables[c & 0xFF] ^ (c >>> 8);
      tables[k * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();

const T0 = /* @__PURE__ */ TABLES.subarray(0, 256);
const T1 = /* @__PURE__ */ TABLES.subarray(256, 512);
const T2 = /* @__PURE__ */ TABLES.subarray(512, 768);
const T3 = /* @__PURE__ */ TABLES.subarray(768, 1024);
const T4 = /* @__PURE__ */ TABLES.subarray(1024, 1280);
const T5 = /* @__PURE__ */ TABLES.subarray(1280, 1536);
const T6 = /* @__PURE__ */ TABLES.subarray(1536, 1792);
const T7 = /* @__PURE__ */ TABLES.subarray(1792, 2048);

/** The byte-wise table (the 256 entries every CRC-32 implementation shares). */
export const CRC32_TABLE = T0;

/**
 * Advance a running CRC register over `bytes`. The register starts at
 * 0xFFFFFFFF and the final CRC is `(register ^ 0xFFFFFFFF) >>> 0`.
 * @param {number} crc register
 * @param {Uint8Array} bytes
 * @returns {number} register (unsigned)
 */
export function updateCrc32(crc, bytes) {
  let c = crc | 0;
  const length = bytes.length;
  const end8 = length - (length & 7);
  let i = 0;
  for (; i < end8; i += 8) {
    const low = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    c = T7[low & 0xFF] ^ T6[(low >>> 8) & 0xFF] ^ T5[(low >>> 16) & 0xFF] ^ T4[low >>> 24]
      ^ T3[bytes[i + 4]] ^ T2[bytes[i + 5]] ^ T1[bytes[i + 6]] ^ T0[bytes[i + 7]];
  }
  for (; i < length; i++) c = T0[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return c >>> 0;
}

/** CRC-32 of `bytes`. */
export function crc32(bytes) {
  return (updateCrc32(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;
}
