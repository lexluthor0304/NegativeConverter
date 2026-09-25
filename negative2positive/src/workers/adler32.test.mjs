// Standalone Node test for adler32.js - run with:
// node negative2positive/src/workers/adler32.test.mjs
//
// The combined checksum of random pieces must equal the Adler-32 that pako
// itself writes into a zlib trailer for the whole buffer; a wrong combine
// would still be accepted by lenient PNG decoders, so it is checked here.
import assert from 'node:assert/strict';
import * as pako from 'pako';
import { adler32, adler32Combine } from './adler32.js';

let seed = 20260925;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const randomBytes = (length, { runs = false } = {}) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = runs && (random() & 3) ? bytes[i - 1] || 0 : random() >>> 24;
  return bytes;
};
const trailerOf = (bytes) => {
  const z = pako.deflate(bytes, { level: 1 });
  return ((z[z.length - 4] << 24) | (z[z.length - 3] << 16) | (z[z.length - 2] << 8) | z[z.length - 1]) >>> 0;
};

// Known values.
assert.equal(adler32(new Uint8Array(0)), 1);
assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11E60398);
// Every byte 0xFF over more than one block exercises the reduction.
assert.equal(adler32(new Uint8Array(100_000).fill(255)), trailerOf(new Uint8Array(100_000).fill(255)));

for (let trial = 0; trial < 40; trial++) {
  const length = trial < 5 ? trial : 1 + (random() % 200_000);
  const bytes = randomBytes(length, { runs: trial % 2 === 1 });
  const expected = trailerOf(bytes);
  assert.equal(adler32(bytes), expected, `one pass, ${length} bytes`);

  // Random split points, including empty pieces.
  const cuts = Array.from({ length: random() % 8 }, () => random() % (length + 1)).sort((a, b) => a - b);
  let combined = 1;
  let previous = 0;
  for (const cut of [...cuts, length]) {
    const piece = bytes.subarray(previous, cut);
    combined = adler32Combine(combined, adler32(piece), piece.length);
    previous = cut;
  }
  assert.equal(combined, expected, `combined over ${cuts.length + 1} pieces of ${length} bytes`);

  // Continuing a running checksum equals one pass too.
  let running = 1;
  previous = 0;
  for (const cut of [...cuts, length]) {
    running = adler32(bytes.subarray(previous, cut), running);
    previous = cut;
  }
  assert.equal(running, expected);
}

// Lengths that are multiples of the modulus and far above it.
for (const len2 of [0, 65521, 65522, 16 << 20, 2 ** 40 + 7]) {
  const a = adler32(randomBytes(1000));
  const b = adler32(randomBytes(1000));
  const value = adler32Combine(a, b, len2);
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF);
  assert.ok((value & 0xFFFF) < 65521 && (value >>> 16) < 65521);
}
assert.equal(adler32Combine(1, 0x12345678 % 65521, 99), 0x12345678 % 65521);

console.log('adler32.test.mjs passed');
