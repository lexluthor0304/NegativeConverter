// MurmurHash3 x86_128 (Austin Appleby, public domain) over the bytes of a
// typed array, as 32 hex digits in the reference byte order. It identifies
// content that is not adversarial: AI-repair tile inputs and dust masks. A
// 128-bit key makes an accidental collision negligible (about 2^-113 for a few
// hundred entries), at 1-3 ms per MB in plain JS.

const C1 = 0x239b961b, C2 = 0xab0e9789, C3 = 0x38b34ae5, C4 = 0xa1e38b93;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const rotl = (x, r) => (x << r) | (x >>> (32 - r));
function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}
function hex(h) {
  // Reference output order: each 32-bit word little-endian.
  let out = '';
  for (let shift = 0; shift < 32; shift += 8) out += ((h >>> shift) & 0xff).toString(16).padStart(2, '0');
  return out;
}

export function murmurHash3x86_128(view, seed = 0) {
  const bytes = view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const length = bytes.length;
  const blocks = length >>> 4;
  let h1 = seed | 0, h2 = seed | 0, h3 = seed | 0, h4 = seed | 0;
  const words = LITTLE_ENDIAN && bytes.byteOffset % 4 === 0
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, blocks * 4) : null;
  const word = (i) => words ? words[i]
    : bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
  for (let block = 0; block < blocks; block++) {
    const i = block * 4;
    let k1 = words ? words[i] : word(i), k2 = words ? words[i + 1] : word(i + 1);
    let k3 = words ? words[i + 2] : word(i + 2), k4 = words ? words[i + 3] : word(i + 3);
    k1 = Math.imul(k1, C1); k1 = rotl(k1, 15); k1 = Math.imul(k1, C2); h1 ^= k1;
    h1 = rotl(h1, 19); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(k2, C2); k2 = rotl(k2, 16); k2 = Math.imul(k2, C3); h2 ^= k2;
    h2 = rotl(h2, 17); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(k3, C3); k3 = rotl(k3, 17); k3 = Math.imul(k3, C4); h3 ^= k3;
    h3 = rotl(h3, 15); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(k4, C4); k4 = rotl(k4, 18); k4 = Math.imul(k4, C1); h4 ^= k4;
    h4 = rotl(h4, 13); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
  }
  const tail = blocks * 16, rest = length & 15;
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
  /* eslint-disable no-fallthrough */
  switch (rest) {
    case 15: k4 ^= bytes[tail + 14] << 16;
    case 14: k4 ^= bytes[tail + 13] << 8;
    case 13: k4 ^= bytes[tail + 12];
      k4 = Math.imul(k4, C4); k4 = rotl(k4, 18); k4 = Math.imul(k4, C1); h4 ^= k4;
    case 12: k3 ^= bytes[tail + 11] << 24;
    case 11: k3 ^= bytes[tail + 10] << 16;
    case 10: k3 ^= bytes[tail + 9] << 8;
    case 9: k3 ^= bytes[tail + 8];
      k3 = Math.imul(k3, C3); k3 = rotl(k3, 17); k3 = Math.imul(k3, C4); h3 ^= k3;
    case 8: k2 ^= bytes[tail + 7] << 24;
    case 7: k2 ^= bytes[tail + 6] << 16;
    case 6: k2 ^= bytes[tail + 5] << 8;
    case 5: k2 ^= bytes[tail + 4];
      k2 = Math.imul(k2, C2); k2 = rotl(k2, 16); k2 = Math.imul(k2, C3); h2 ^= k2;
    case 4: k1 ^= bytes[tail + 3] << 24;
    case 3: k1 ^= bytes[tail + 2] << 16;
    case 2: k1 ^= bytes[tail + 1] << 8;
    case 1: k1 ^= bytes[tail];
      k1 = Math.imul(k1, C1); k1 = rotl(k1, 15); k1 = Math.imul(k1, C2); h1 ^= k1;
  }
  /* eslint-enable no-fallthrough */
  h1 ^= length; h2 ^= length; h3 ^= length; h4 ^= length;
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  h1 = fmix(h1); h2 = fmix(h2); h3 = fmix(h3); h4 = fmix(h4);
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}
