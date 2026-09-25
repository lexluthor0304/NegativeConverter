import assert from 'node:assert/strict';
import { murmurHash3x86_128 } from './contentHash.js';

// Reference vectors: MurmurHash3_x86_128 as computed by the mmh3 package
// (hash128(..., x64arch=False) as little-endian bytes).
const text = (value) => new TextEncoder().encode(value);
assert.equal(murmurHash3x86_128(text(''), 0), '00000000000000000000000000000000');
assert.equal(murmurHash3x86_128(text('hello'), 0), 'a044242bf7de91dbb631db9ab631db9a');
assert.equal(murmurHash3x86_128(text('The quick brown fox jumps over the lazy dog'), 0), 'c383152f672ceeec6cf67b5d2c1de9e5');
const ramp = Uint8Array.from({ length: 37 }, (_, i) => i);
assert.equal(murmurHash3x86_128(ramp, 512), 'c8306ced8542a46eba06bdfe9be0a5fe');
assert.equal(murmurHash3x86_128(Uint8Array.from({ length: 768 }, (_, i) => i % 256), 7), '53ba14842af1074a88fb6118cadfc24d');
// Unaligned views, other typed arrays and every tail length hash their bytes.
const padded = new Uint8Array(40); padded.set(ramp, 1);
assert.equal(murmurHash3x86_128(padded.subarray(1, 38), 512), 'c8306ced8542a46eba06bdfe9be0a5fe');
const words = Uint16Array.from({ length: 20 }, (_, i) => i * 4099);
assert.equal(murmurHash3x86_128(words, 3), murmurHash3x86_128(new Uint8Array(words.buffer), 3));
const seen = new Set();
for (let length = 0; length <= 33; length++) seen.add(murmurHash3x86_128(ramp.subarray(0, length), 1));
assert.equal(seen.size, 34, 'every prefix length hashes differently');
console.log('contentHash: MurmurHash3 x86_128 matches the reference vectors');
