/**
 * The 16-bit PNG encoder, split into row bands that compress independently.
 *
 * After the Sub filter every row depends only on itself, so a band of whole
 * rows can be filtered and deflated on its own: each band is a raw deflate
 * stream that ends with a sync flush (an empty stored block on a byte
 * boundary) and the last one ends the stream, so the bands concatenate into
 * one valid zlib stream (the pigz method). Band 0 carries the zlib header;
 * the Adler-32 trailer is the in-order fold of the band checksums and goes
 * into an IDAT of its own. PNG decoders concatenate IDAT data, so each band
 * is its own IDAT chunk.
 *
 * The band layout depends only on width, height and channel count, so the
 * file bytes are the same however many workers encode the bands (the band
 * pool in workerBridge.js, one export worker serially, or the main thread).
 * Decoded samples are those of the previous one-shot encoder; only the
 * compressed bytes differ (#257).
 *
 * Pure apart from Blob; the zlib implementation (pako's `Deflate`) is passed
 * in, so modules that only plan bands stay free of it.
 */

import { updateCrc32 } from './crc32.js';
import { adler32, adler32Combine } from './adler32.js';

/** Filtered bytes per band (whole rows, at least one). */
export const PNG16_BAND_TARGET_BYTES = 16 << 20;
/** Filtered bytes Sub-filtered and pushed into the deflater at a time. */
export const PNG16_SCRATCH_BYTES = 4 << 20;
export const PNG16_DEFLATE_LEVEL = 6;
export const Z_DEFAULT_STRATEGY = 0;
/** Run-length strategy: lossless, about +4 % size, several times faster. Off by default. */
export const Z_RLE = 3;

const Z_NO_FLUSH = 0;
const Z_SYNC_FLUSH = 2;
const Z_FINISH = 4;
const Z_HUFFMAN_ONLY = 2;
const DEFLATE_CHUNK_BYTES = 1 << 20;
const IDAT_TYPE = new Uint8Array([73, 68, 65, 84]);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`Invalid PNG ${label}: ${value}`);
}

/**
 * Bands of whole rows of about PNG16_BAND_TARGET_BYTES filtered bytes.
 * `bandBytes` exists for tests that need many bands on a small frame; every
 * export uses the default, so the layout is fixed per width, height and
 * channel count.
 * @returns {{filteredRowBytes:number, rowsPerBand:number, bands:{index:number,y:number,rows:number}[]}}
 */
export function planPng16Bands(width, height, channels, { bandBytes = PNG16_BAND_TARGET_BYTES } = {}) {
  assertDimension(width, 'width');
  assertDimension(height, 'height');
  if (channels !== 3 && channels !== 4) throw new RangeError(`Invalid PNG channel count: ${channels}`);
  const filteredRowBytes = width * channels * 2 + 1;
  const target = Number.isFinite(bandBytes) && bandBytes > 0 ? bandBytes : PNG16_BAND_TARGET_BYTES;
  const rowsPerBand = Math.max(1, Math.floor(target / filteredRowBytes));
  const bands = [];
  for (let y = 0; y < height; y += rowsPerBand) {
    bands.push({ index: bands.length, y, rows: Math.min(rowsPerBand, height - y) });
  }
  return { filteredRowBytes, rowsPerBand, bands };
}

/**
 * The two-byte zlib header zlib writes for `level` and `strategy` with a
 * 32 KiB window and no preset dictionary (0x78 0x9C at level 6).
 */
export function zlibHeader(level = PNG16_DEFLATE_LEVEL, strategy = Z_DEFAULT_STRATEGY) {
  const effective = level === -1 ? 6 : level;
  let levelFlags;
  if (strategy >= Z_HUFFMAN_ONLY || effective < 2) levelFlags = 0;
  else if (effective < 6) levelFlags = 1;
  else if (effective === 6) levelFlags = 2;
  else levelFlags = 3;
  let header = ((8 + ((15 - 8) << 4)) << 8) | (levelFlags << 6);
  header += 31 - (header % 31);
  return new Uint8Array([header >>> 8, header & 0xFF]);
}

/**
 * Sub-filter `rowCount` rows starting at `firstRow` of an RGBA sample array
 * into `out`, as 16-bit big-endian samples with `channels` channels (3 drops
 * alpha). An 8-bit source is the documented fallback (`v * 257`): both bytes
 * of a sample are then `v`, so both filtered bytes are `v - left`.
 * @returns {number} bytes written
 */
function subFilterRows(samples, firstRow, rowCount, width, channels, is16, out) {
  let o = 0;
  const rowSamples = width * 4;
  for (let r = 0; r < rowCount; r++) {
    let s = (firstRow + r) * rowSamples;
    const end = s + rowSamples;
    out[o++] = 1; // Sub: subtract the byte in the previous pixel.
    if (is16) {
      let lr = 0, lg = 0, lb = 0, la = 0;
      for (; s < end; s += 4) {
        const r16 = samples[s], g16 = samples[s + 1], b16 = samples[s + 2];
        out[o] = (r16 >>> 8) - (lr >>> 8);
        out[o + 1] = (r16 & 0xFF) - (lr & 0xFF);
        out[o + 2] = (g16 >>> 8) - (lg >>> 8);
        out[o + 3] = (g16 & 0xFF) - (lg & 0xFF);
        out[o + 4] = (b16 >>> 8) - (lb >>> 8);
        out[o + 5] = (b16 & 0xFF) - (lb & 0xFF);
        lr = r16; lg = g16; lb = b16;
        if (channels === 4) {
          const a16 = samples[s + 3];
          out[o + 6] = (a16 >>> 8) - (la >>> 8);
          out[o + 7] = (a16 & 0xFF) - (la & 0xFF);
          la = a16;
          o += 8;
        } else {
          o += 6;
        }
      }
    } else {
      let lr = 0, lg = 0, lb = 0, la = 0;
      for (; s < end; s += 4) {
        const r8 = samples[s], g8 = samples[s + 1], b8 = samples[s + 2];
        out[o] = out[o + 1] = r8 - lr;
        out[o + 2] = out[o + 3] = g8 - lg;
        out[o + 4] = out[o + 5] = b8 - lb;
        lr = r8; lg = g8; lb = b8;
        if (channels === 4) {
          const a8 = samples[s + 3];
          out[o + 6] = out[o + 7] = a8 - la;
          la = a8;
          o += 8;
        } else {
          o += 6;
        }
      }
    }
  }
  return o;
}

function resolveDeflate(zlib) {
  const Deflate = zlib && typeof zlib.Deflate === 'function' ? zlib.Deflate : zlib;
  if (typeof Deflate !== 'function' || !Deflate.prototype || typeof Deflate.prototype.push !== 'function') {
    throw new TypeError('The PNG16 encoder needs a streaming Deflate (pako.Deflate)');
  }
  return Deflate;
}

/**
 * Encode one band: Sub filter, running Adler-32 and a raw deflate stream,
 * wrapped in its own IDAT chunk.
 *
 * @param {object} band
 * @param {Uint16Array|Uint8ClampedArray|Uint8Array} band.samples RGBA samples of this band's rows only
 * @param {number} band.width
 * @param {number} band.rows
 * @param {3|4} band.channels decided once for the whole frame
 * @param {number} band.index 0 carries the zlib header
 * @param {boolean} band.isLast ends the deflate stream
 * @param {number} [band.level]
 * @param {number} [band.strategy]
 * @param {{Deflate: Function}|Function} zlib pako (or pako.Deflate)
 * @returns {{parts: Uint8Array[], adler: number, length: number}} IDAT chunk
 *   parts, the Adler-32 of the band's filtered bytes and their count
 */
export function encodePng16Band({ samples, width, rows, channels, index, isLast, level = PNG16_DEFLATE_LEVEL, strategy = Z_DEFAULT_STRATEGY }, zlib) {
  assertDimension(width, 'width');
  assertDimension(rows, 'band height');
  if (channels !== 3 && channels !== 4) throw new RangeError(`Invalid PNG channel count: ${channels}`);
  if (!samples || samples.length !== width * rows * 4) {
    throw new RangeError(`PNG band has ${samples && samples.length} samples for ${width}x${rows}`);
  }
  const Deflate = resolveDeflate(zlib);
  const is16 = samples instanceof Uint16Array;
  const filteredRowBytes = width * channels * 2 + 1;
  const rowsPerStep = Math.max(1, Math.floor(PNG16_SCRATCH_BYTES / filteredRowBytes));
  const scratch = new Uint8Array(Math.min(rows, rowsPerStep) * filteredRowBytes);

  const data = [];
  let dataLength = 0;
  let crc = updateCrc32(0xFFFFFFFF, IDAT_TYPE);
  const emit = (chunk) => {
    data.push(chunk);
    dataLength += chunk.length;
    crc = updateCrc32(crc, chunk);
  };
  if (index === 0) emit(zlibHeader(level, strategy));

  const deflater = new Deflate({ raw: true, level, strategy, chunkSize: DEFLATE_CHUNK_BYTES });
  // Keep the output chunks here instead of pako's list, which it would
  // flatten into one more copy of the band at the end.
  deflater.onData = emit;

  let adler = 1;
  for (let y = 0; y < rows; y += rowsPerStep) {
    const count = Math.min(rowsPerStep, rows - y);
    const filtered = scratch.subarray(0, subFilterRows(samples, y, count, width, channels, is16, scratch));
    adler = adler32(filtered, adler);
    const lastStep = y + count >= rows;
    // pako copies the input into its window before push() returns, so the
    // scratch buffer can be refilled for the next rows.
    deflater.push(filtered, lastStep ? (isLast ? Z_FINISH : Z_SYNC_FLUSH) : Z_NO_FLUSH);
    if (deflater.err) throw new Error(`PNG deflate failed: ${deflater.msg || deflater.err}`);
  }

  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, dataLength, false);
  header.set(IDAT_TYPE, 4);
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, (crc ^ 0xFFFFFFFF) >>> 0, false);
  return { parts: [header, ...data, trailer], adler, length: rows * filteredRowBytes };
}

/** One PNG chunk (length, type, data, CRC-32 over type and data) as bytes. */
export function pngChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, (updateCrc32(0xFFFFFFFF, chunk.subarray(4, 8 + data.length)) ^ 0xFFFFFFFF) >>> 0, false);
  return chunk;
}

/**
 * Fold band checksums in order: the Adler-32 of the whole filtered stream.
 * @param {{adler:number,length:number}[]} bands
 */
export function combineBandAdlers(bands) {
  let adler = 1;
  for (const band of bands) adler = adler32Combine(adler, band.adler, band.length);
  return adler;
}

/**
 * The file: signature, IHDR, one IDAT per band, the Adler-32 in an IDAT of
 * its own, IEND. Blob references only; nothing is copied here.
 * @param {{width:number,height:number,channels:3|4,idats:(Blob|Uint8Array)[],adler:number}} parts
 */
export function assemblePng16Blob({ width, height, channels, idats, adler }) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 16; // bit depth
  ihdr[9] = channels === 3 ? 2 : 6;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler >>> 0, false);
  return new Blob([
    new Uint8Array(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    ...idats,
    pngChunk('IDAT', trailer),
    pngChunk('IEND', new Uint8Array(0))
  ], { type: 'image/png' });
}

/**
 * Every band of a frame, one after another on this thread: what the export
 * worker runs for a lane that has no band pool, and the main-thread fallback.
 * Same layout as the pool, so the same bytes.
 */
export function encodePng16BandsSerially(samples, width, height, channels, zlib, { level = PNG16_DEFLATE_LEVEL, strategy = Z_DEFAULT_STRATEGY, bandBytes } = {}) {
  const { bands } = planPng16Bands(width, height, channels, { bandBytes });
  if (!samples || samples.length !== width * height * 4) {
    throw new RangeError(`PNG has ${samples && samples.length} samples for ${width}x${height}`);
  }
  const results = [];
  const idats = [];
  for (const band of bands) {
    const view = samples.subarray(band.y * width * 4, (band.y + band.rows) * width * 4);
    const result = encodePng16Band({
      samples: view, width, rows: band.rows, channels, index: band.index,
      isLast: band.index === bands.length - 1, level, strategy
    }, zlib);
    // A Blob per band lets the compressed chunks go as soon as it is built.
    idats.push(new Blob(result.parts));
    results.push({ adler: result.adler, length: result.length });
  }
  return assemblePng16Blob({ width, height, channels, idats, adler: combineBandAdlers(results) });
}
