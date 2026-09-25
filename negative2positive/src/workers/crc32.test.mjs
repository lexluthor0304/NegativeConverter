// Standalone Node test for crc32.js - run with:
// node negative2positive/src/workers/crc32.test.mjs
//
// The slice-by-8 CRC must equal the byte-wise CRC it replaced, for every
// length that exercises the 8-byte loop and its tail, at unaligned offsets,
// and over a large buffer; Node's zlib.crc32 is an independent third opinion.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, updateCrc32, CRC32_TABLE } from './crc32.js';

// The byte-wise loop the ZIP writer and the PNG encoder used before.
const reference = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return {
    table,
    update(crc, bytes) {
      for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      return crc;
    },
    crc(bytes) {
      return (this.update(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;
    }
  };
})();

let seed = 0x9E3779B9;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const randomBytes = (length) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = random() >>> 24;
  return bytes;
};

assert.deepEqual(Array.from(CRC32_TABLE), Array.from(reference.table));
assert.equal(crc32(new Uint8Array(0)), 0);
assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'the CRC-32 check value');

// Every length 0..64 at random (unaligned) offsets into a shared buffer.
const pool = randomBytes(4096);
for (let length = 0; length <= 64; length++) {
  for (let trial = 0; trial < 16; trial++) {
    const offset = random() % (pool.length - length);
    const view = pool.subarray(offset, offset + length);
    const expected = reference.crc(view);
    assert.equal(crc32(view), expected, `length ${length} at offset ${offset}`);
    assert.equal(crc32(view), zlib.crc32(view) >>> 0);
  }
}

// A running register split at random points equals one pass.
for (let trial = 0; trial < 64; trial++) {
  const bytes = randomBytes(1 + (random() % 3000));
  let register = 0xFFFFFFFF;
  let at = 0;
  while (at < bytes.length) {
    const next = Math.min(bytes.length, at + (random() % 97));
    register = updateCrc32(register, bytes.subarray(at, next));
    at = next;
  }
  assert.equal((register ^ 0xFFFFFFFF) >>> 0, reference.crc(bytes));
}

// 64 MiB, in the 256 KiB chunks the ZIP writer reads.
{
  const bytes = randomBytes(64 << 20);
  let expected = 0xFFFFFFFF;
  let actual = 0xFFFFFFFF;
  for (let offset = 0; offset < bytes.length; offset += 256 << 10) {
    const chunk = bytes.subarray(offset, offset + (256 << 10));
    expected = reference.update(expected, chunk);
    actual = updateCrc32(actual, chunk);
  }
  assert.equal(actual, expected >>> 0);
  assert.equal(crc32(bytes), (expected ^ 0xFFFFFFFF) >>> 0);
  assert.equal(crc32(bytes), zlib.crc32(bytes) >>> 0);
}

console.log('crc32.test.mjs passed');
