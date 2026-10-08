/**
 * Adler-32 (RFC 1950), the checksum that ends a zlib stream, and
 * `adler32Combine`, which joins the checksums of two consecutive pieces
 * without reading their bytes again (zlib's adler32_combine). The PNG16 band
 * encoder (png16Bands.js) deflates row bands independently as raw streams,
 * so pako computes no checksum; each band sums its own filtered bytes and
 * the file's trailer is the in-order fold of the band checksums.
 */

const BASE = 65521;
// Bytes per reduction: keeps `b` below 2^31 (255·n(n+1)/2 + (n+1)(BASE−1)),
// so the inner loop stays in 32-bit integer arithmetic.
const BLOCK = 3800;

/**
 * Continue an Adler-32 over `bytes` (start with 1, the checksum of nothing).
 * @param {Uint8Array} bytes
 * @param {number} [adler]
 * @returns {number} unsigned 32-bit checksum
 */
export function adler32(bytes, adler = 1) {
  let a = adler & 0xFFFF;
  let b = (adler >>> 16) & 0xFFFF;
  const length = bytes.length;
  let i = 0;
  while (i < length) {
    const end = Math.min(length, i + BLOCK);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= BASE;
    b %= BASE;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The Adler-32 of A followed by B, from `adler1` (of A), `adler2` (of B) and
 * the byte length of B. `adler32Combine(1, adler2, len2) === adler2`, so a
 * fold over pieces can start from 1.
 * @param {number} adler1
 * @param {number} adler2
 * @param {number} len2 non-negative safe integer
 * @returns {number}
 */
export function adler32Combine(adler1, adler2, len2) {
  const rem = len2 % BASE;
  let sum1 = adler1 & 0xFFFF;
  let sum2 = (rem * sum1) % BASE;
  sum1 += (adler2 & 0xFFFF) + BASE - 1;
  sum2 += ((adler1 >>> 16) & 0xFFFF) + ((adler2 >>> 16) & 0xFFFF) + BASE - rem;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum2 >= BASE * 2) sum2 -= BASE * 2;
  if (sum2 >= BASE) sum2 -= BASE;
  return (sum1 + sum2 * 65536) >>> 0;
}
