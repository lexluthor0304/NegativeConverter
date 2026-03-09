#!/usr/bin/env node
/**
 * decode-nlp-lut.mjs — Decode NLP 3.1.1 XMP-embedded 3D LUT to binary
 *
 * Algorithm ported from michelerenzullo/XMPconverter (XMPconverter.cpp)
 * Encoding: Adobe DNG SDK ASCII85 + zlib
 *
 * Usage:
 *   node scripts/decode-nlp-lut.mjs <input.xmp> <output.bin>
 *   node scripts/decode-nlp-lut.mjs --all   # decode all 4 profiles
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- ASCII85 decode table (Adobe DNG SDK custom alphabet) ---
// Index = charCode - 32
const kDecodeTable = new Uint8Array([
  0xFF,0x44,0xFF,0x54,0x53,0x52,0xFF,0x49,0x4B,0x4C,0x46,0x41,0xFF,0x3F,0x3E,0x45,
  0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x40,0xFF,0xFF,0x42,0xFF,0x47,
  0x51,0x24,0x25,0x26,0x27,0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,0x30,0x31,0x32,
  0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x4D,0xFF,0x4E,0x43,0xFF,
  0x48,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,
  0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,0x20,0x21,0x22,0x23,0x4F,0x4A,0x50,0xFF,0xFF,
]);

/**
 * Decode Adobe DNG SDK ASCII85 string to Uint8Array.
 * Little-endian base-85: first char = least significant digit.
 * 5 encoded chars → 4 raw bytes (LE byte extraction)
 */
function ascii85Decode(str) {
  const out = [];
  const digits = [];

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch < 32 || ch > 127) continue;
    const val = kDecodeTable[ch - 32];
    if (val === 0xFF) continue;
    digits.push(val);

    if (digits.length === 5) {
      // LE base85: digit[0]=85^0, digit[4]=85^4
      let accum = digits[4];
      accum = accum * 85 + digits[3];
      accum = accum * 85 + digits[2];
      accum = accum * 85 + digits[1];
      accum = accum * 85 + digits[0];

      out.push(accum & 0xFF);
      out.push((accum >>> 8) & 0xFF);
      out.push((accum >>> 16) & 0xFF);
      out.push((accum >>> 24) & 0xFF);
      digits.length = 0;
    }
  }

  // Handle partial last group (2-4 chars → 1-3 bytes)
  if (digits.length > 1) {
    const numBytes = digits.length - 1;
    while (digits.length < 5) digits.push(0);
    let accum = digits[4];
    accum = accum * 85 + digits[3];
    accum = accum * 85 + digits[2];
    accum = accum * 85 + digits[1];
    accum = accum * 85 + digits[0];
    for (let j = 0; j < numBytes; j++) {
      out.push((accum >>> (j * 8)) & 0xFF);
    }
  }

  return new Uint8Array(out);
}

/**
 * Extract encoded LUT string from XMP content
 */
function extractLutFromXMP(xmpContent) {
  // Find the RGBTable hash
  const hashMatch = xmpContent.match(/crs:RGBTable="([A-F0-9]+)"/);
  if (!hashMatch) throw new Error('No crs:RGBTable hash found in XMP');
  const hash = hashMatch[1];
  console.log(`  RGBTable hash: ${hash}`);

  // Find the Table data using the hash
  const tableRegex = new RegExp(`crs:Table_${hash}="([^"]+)"`);
  const tableMatch = xmpContent.match(tableRegex);
  if (!tableMatch) throw new Error(`No crs:Table_${hash} data found in XMP`);

  return tableMatch[1];
}

/**
 * Decode XMP LUT data to raw binary LUT
 * Returns { header, lutData, footer }
 */
function decodeLUT(encodedStr) {
  // Step 1: ASCII85 decode
  const rawBytes = ascii85Decode(encodedStr);
  console.log(`  ASCII85 decoded: ${rawBytes.length} bytes`);

  // Step 2: Extract uncompressedSize (first 4 bytes, uint32 LE)
  const uncompressedSize =
    (rawBytes[0] | (rawBytes[1] << 8) | (rawBytes[2] << 16) | (rawBytes[3] << 24)) >>> 0;
  console.log(`  Uncompressed size: ${uncompressedSize} bytes`);

  // Step 3: zlib decompress remaining bytes
  const compressed = rawBytes.slice(4);
  const decompressed = inflateSync(compressed);
  console.log(`  Decompressed: ${decompressed.length} bytes (expected ${uncompressedSize})`);

  if (decompressed.length !== uncompressedSize) {
    console.warn(`  WARNING: decompressed size mismatch!`);
  }

  // Step 4: Parse header - 4 × uint32 LE
  const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
  const h0 = view.getUint32(0, true);  // should be 1
  const h1 = view.getUint32(4, true);  // should be 1
  const h2 = view.getUint32(8, true);  // should be 3 (channels)
  const divisions = view.getUint32(12, true);
  console.log(`  Header: [${h0}, ${h1}, ${h2}, divisions=${divisions}]`);

  const N = divisions;
  const lutDataSize = N * N * N * 3 * 2; // int16 values = 2 bytes each
  const headerSize = 16;

  // Step 5: Parse footer
  const footerOffset = headerSize + lutDataSize;
  const primaries = view.getUint32(footerOffset, true);
  const gamma = view.getUint32(footerOffset + 4, true);
  const gamut = view.getUint32(footerOffset + 8, true);
  const rangeMin = view.getFloat64(footerOffset + 12, true);
  const rangeMax = view.getFloat64(footerOffset + 20, true);

  const primariesNames = ['sRGB', 'AdobeRGB', 'ProPhoto', 'P3', 'Rec2020'];
  const gammaNames = ['Linear', 'sRGB', 'gamma1.8', 'gamma2.2', 'Rec2020'];

  console.log(`  Footer: primaries=${primariesNames[primaries] || primaries}, gamma=${gammaNames[gamma] || gamma}, gamut=${gamut}`);
  console.log(`  Range: [${rangeMin}, ${rangeMax}]`);

  // Step 6: Extract LUT data as Int16Array
  const lutInt16 = new Int16Array(N * N * N * 3);
  for (let i = 0; i < lutInt16.length; i++) {
    lutInt16[i] = view.getInt16(headerSize + i * 2, true);
  }

  return { divisions: N, primaries, gamma, gamut, rangeMin, rangeMax, lutInt16 };
}

/**
 * Compute identity (nop) value for a given coordinate index
 * nopValue[i] = (i * 65535 + (N >> 1)) / (N - 1)
 */
function nopValue(i, N) {
  // C++ integer division: floor, not round
  return Math.floor((i * 65535 + (N >> 1)) / (N - 1));
}

/**
 * Convert decoded NLP LUT to our project's bin format.
 *
 * NLP binary layout (R-inner): idx = (rIndex + gIndex*N + bIndex*N²) * 3
 *   stored[idx+0] delta for channel that maps to B-axis
 *   stored[idx+1] delta for channel that maps to G-axis
 *   stored[idx+2] delta for channel that maps to R-axis
 *
 * Our project layout (R-outer): idx = ((rIdx * N + gIdx) * N + bIdx) * 3
 *   data[idx+0] = R, data[idx+1] = G, data[idx+2] = B
 *
 * Delta decode: actual_uint16 = (uint16)(stored_int16 + nopValue[coord])
 */
function convertToProjectBin(decoded, targetSize) {
  const { divisions: N, lutInt16 } = decoded;

  // First: decode deltas to absolute uint16 values in NLP layout
  // NLP layout: idx_nlp = (rIdx + gIdx*N + bIdx*N*N) * 3
  // Channel mapping per the plan:
  //   stored[idx+0] + nopValue[bIdx] → R output
  //   stored[idx+1] + nopValue[gIdx] → G output
  //   stored[idx+2] + nopValue[rIdx] → B output

  // Build full NLP LUT (N³×3 uint16)
  const nlpLut = new Uint16Array(N * N * N * 3);

  for (let bIdx = 0; bIdx < N; bIdx++) {
    for (let gIdx = 0; gIdx < N; gIdx++) {
      for (let rIdx = 0; rIdx < N; rIdx++) {
        const srcOff = (rIdx + gIdx * N + bIdx * N * N) * 3;
        // NLP binary: stored[0]=B delta, stored[1]=G delta, stored[2]=R delta
        const b16 = (lutInt16[srcOff + 0] + nopValue(bIdx, N)) & 0xFFFF;
        const g16 = (lutInt16[srcOff + 1] + nopValue(gIdx, N)) & 0xFFFF;
        const r16 = (lutInt16[srcOff + 2] + nopValue(rIdx, N)) & 0xFFFF;

        // Store in our project layout: R-outer
        const dstOff = ((rIdx * N + gIdx) * N + bIdx) * 3;
        nlpLut[dstOff + 0] = r16;
        nlpLut[dstOff + 1] = g16;
        nlpLut[dstOff + 2] = b16;
      }
    }
  }

  // If same size, return directly
  if (N === targetSize) {
    return nlpLut;
  }

  // Resample via trilinear interpolation if dimensions differ
  console.log(`  Resampling from ${N}³ to ${targetSize}³...`);
  return resampleLut(nlpLut, N, targetSize);
}

/**
 * Trilinear interpolation resample from srcSize³ to dstSize³
 */
function resampleLut(srcData, srcSize, dstSize) {
  const dst = new Uint16Array(dstSize * dstSize * dstSize * 3);
  const srcMax = srcSize - 1;

  for (let ri = 0; ri < dstSize; ri++) {
    for (let gi = 0; gi < dstSize; gi++) {
      for (let bi = 0; bi < dstSize; bi++) {
        // Map destination coord to source coord
        const rs = (ri / (dstSize - 1)) * srcMax;
        const gs = (gi / (dstSize - 1)) * srcMax;
        const bs = (bi / (dstSize - 1)) * srcMax;

        const r0 = Math.min(Math.floor(rs), srcMax - 1);
        const g0 = Math.min(Math.floor(gs), srcMax - 1);
        const b0 = Math.min(Math.floor(bs), srcMax - 1);

        const rf = rs - r0;
        const gf = gs - g0;
        const bf = bs - b0;

        const idx = (r, g, b) => ((r * srcSize + g) * srcSize + b) * 3;

        const dstOff = ((ri * dstSize + gi) * dstSize + bi) * 3;

        for (let c = 0; c < 3; c++) {
          const c000 = srcData[idx(r0, g0, b0) + c];
          const c001 = srcData[idx(r0, g0, b0 + 1) + c];
          const c010 = srcData[idx(r0, g0 + 1, b0) + c];
          const c011 = srcData[idx(r0, g0 + 1, b0 + 1) + c];
          const c100 = srcData[idx(r0 + 1, g0, b0) + c];
          const c101 = srcData[idx(r0 + 1, g0, b0 + 1) + c];
          const c110 = srcData[idx(r0 + 1, g0 + 1, b0) + c];
          const c111 = srcData[idx(r0 + 1, g0 + 1, b0 + 1) + c];

          const c00 = c000 * (1 - bf) + c001 * bf;
          const c01 = c010 * (1 - bf) + c011 * bf;
          const c10 = c100 * (1 - bf) + c101 * bf;
          const c11 = c110 * (1 - bf) + c111 * bf;

          const c_0 = c00 * (1 - gf) + c01 * gf;
          const c_1 = c10 * (1 - gf) + c11 * gf;

          dst[dstOff + c] = Math.round(c_0 * (1 - rf) + c_1 * rf);
        }
      }
    }
  }

  return dst;
}

/**
 * Validate LUT: check diagonal produces near-gray output
 */
function validateLut(data, size) {
  console.log('  Diagonal validation (R=G=B input → output):');
  const steps = [0, Math.floor(size / 4), Math.floor(size / 2), Math.floor(3 * size / 4), size - 1];
  for (const i of steps) {
    const off = ((i * size + i) * size + i) * 3;
    const r = data[off] / 65535;
    const g = data[off + 1] / 65535;
    const b = data[off + 2] / 65535;
    const input = i / (size - 1);
    console.log(`    in=${input.toFixed(3)} → R=${r.toFixed(4)} G=${g.toFixed(4)} B=${b.toFixed(4)}`);
  }
}

// --- Main ---

const TARGET_LUT_SIZE = 32;

const XMP_DIR = '/Users/lex/MAC-NEGATIVE-LAB-PRO-v3.1.1/analysis/nlp-3.1.1-unpacked/components/' +
  'NegativeLabPro_Plugin/root/Library/Application Support/Adobe/CameraRaw/Settings/NLP Enhanced Settings';

const BIN_DIR = resolve(__dirname, '../negative2positive/src/silvercore/resources/profiles');

const PROFILES = {
  frontier: 'Negative Lab - Frontier.xmp',
  crystal:  'Negative Lab - Crystal.xmp',
  natural:  'Negative Lab - Natural.xmp',
  pakon:    'Negative Lab - Pakon.xmp',
};

function decodeProfile(name, xmpFile, binFile) {
  console.log(`\n=== Decoding ${name} ===`);
  console.log(`  Input:  ${xmpFile}`);
  console.log(`  Output: ${binFile}`);

  const xmpContent = readFileSync(xmpFile, 'utf-8');
  const encodedStr = extractLutFromXMP(xmpContent);
  console.log(`  Encoded string length: ${encodedStr.length} chars`);

  const decoded = decodeLUT(encodedStr);
  const projectLut = convertToProjectBin(decoded, TARGET_LUT_SIZE);

  validateLut(projectLut, TARGET_LUT_SIZE);

  // Write binary
  const buf = Buffer.from(projectLut.buffer, projectLut.byteOffset, projectLut.byteLength);
  writeFileSync(binFile, buf);
  console.log(`  Written: ${buf.length} bytes (expected ${TARGET_LUT_SIZE ** 3 * 3 * 2})`);

  return decoded;
}

// CLI
const args = process.argv.slice(2);

if (args[0] === '--all') {
  for (const [name, xmpName] of Object.entries(PROFILES)) {
    decodeProfile(name, resolve(XMP_DIR, xmpName), resolve(BIN_DIR, `${name}.bin`));
  }
} else if (args.length === 2) {
  decodeProfile('custom', resolve(args[0]), resolve(args[1]));
} else {
  console.log('Usage:');
  console.log('  node scripts/decode-nlp-lut.mjs --all');
  console.log('  node scripts/decode-nlp-lut.mjs <input.xmp> <output.bin>');
  process.exit(1);
}
