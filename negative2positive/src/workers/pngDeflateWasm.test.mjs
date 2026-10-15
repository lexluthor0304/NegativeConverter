// Standalone Node test for pngDeflateWasm.js - run with:
// node negative2positive/src/workers/pngDeflateWasm.test.mjs
//
// The PNG16 deflate module (#301): the committed modules are the ones the
// build info names; the scalar and the SIMD module write identical bytes;
// every stream inflates back whatever the flushes and chunk sizes; streams
// free their memory; a failing module falls back to pako. png16Bands.test.mjs
// checks the PNG16 files it writes (samples, CRCs, Adler-32).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import * as pako from 'pako';
import {
  createWasmZlib, instantiatePngDeflate, loadPng16Zlib, png16DeflateVariant, runWithPng16Fallback,
  PNG_DEFLATE_MODULE_URLS
} from './pngDeflateWasm.js';
import { encodePng16BandsSerially, Z_RLE } from './png16Bands.js';

const Z_NO_FLUSH = 0;
const Z_SYNC_FLUSH = 2;
const Z_FINISH = 4;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const concat = (chunks) => Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
// Byte equality without deepEqual's diff of megabyte buffers.
function assertSameBytes(actual, expected, message) {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (a.equals(b)) return;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  assert.fail(`${message}: ${a.length} vs ${b.length} bytes, first difference at ${at}`);
}

let seed = 11;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
// Compressible but not trivial: a ramp with seeded noise in the low bits.
const sample = (length) => Uint8Array.from({ length }, (_, i) => ((i * 7) >>> 3) + (random() >>> 29));

// ---------------------------------------------- the committed modules

{
  const info = readFileSync(new URL('./png-deflate-build-info.txt', import.meta.url), 'utf8');
  for (const [variant, url] of Object.entries(PNG_DEFLATE_MODULE_URLS)) {
    const name = url.pathname.split('/').pop();
    const line = info.split('\n').find((l) => l.startsWith(name + ' '));
    assert.ok(line, `build info lists ${name}`);
    const [, hash, size] = line.trim().split(/\s+/);
    const bytes = readFileSync(url);
    assert.equal(sha256(bytes), hash, `${name} is the module the build info names`);
    assert.equal(bytes.length, Number(size), `${name} size`);
    const module = new WebAssembly.Module(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), [], `${name} imports nothing`);
    const exports = WebAssembly.Module.exports(module).map((e) => e.name);
    for (const name of ['memory', 'pd_alloc', 'pd_free', 'pd_new', 'pd_deflate', 'pd_consumed', 'pd_produced', 'pd_end']) {
      assert.ok(exports.includes(name), `${variant} exports ${name}`);
    }
  }
  assert.match(info, /zlib-rs:\s+0\.6\.8/);
}

const scalar = await instantiatePngDeflate({ simd: false });
const simd = await instantiatePngDeflate({ simd: true });
assert.equal(scalar.variant, 'scalar');
assert.equal(simd.variant, 'simd');

// ------------------------------------------------- streaming semantics

function deflateAll(zlibImpl, pieces, options) {
  const deflater = new zlibImpl.Deflate({ raw: true, level: 6, ...options });
  const out = [];
  deflater.onData = (chunk) => out.push(chunk);
  for (const [bytes, mode] of pieces) {
    assert.equal(deflater.push(bytes, mode), true);
    assert.equal(deflater.err, 0);
  }
  if (typeof deflater.dispose === 'function') deflater.dispose();
  return concat(out);
}

{
  // Several pushes, a sync flush in the middle, a finish: one raw stream.
  const a = sample(3_000_000), b = sample(700_001), c = sample(5);
  const pieces = [[a.subarray(0, 1_000_000), Z_NO_FLUSH], [a.subarray(1_000_000), Z_NO_FLUSH], [b, Z_SYNC_FLUSH], [c, Z_FINISH]];
  const expected = concat([a, b, c]);
  for (const impl of [scalar, simd]) {
    const stream = deflateAll(impl, pieces, { chunkSize: 1 << 20 });
    assertSameBytes(zlib.inflateRawSync(stream), expected, `${impl.variant} round trip`);
    assertSameBytes(deflateAll(impl, pieces, { chunkSize: 1 << 20 }), stream, `${impl.variant} is deterministic`);
    // As in zlib (and pako), a flush whose output does not fit the chunk is
    // finished by the next call with one more empty block, so the bytes
    // depend on the chunk size; the encoder's is fixed (png16Bands.js).
    // Every chunk size still gives a valid stream.
    assertSameBytes(zlib.inflateRawSync(deflateAll(impl, pieces, { chunkSize: 1 })), expected, `${impl.variant} small chunks`);
  }
  // Same bytes from both modules, at every level and strategy the encoder may use.
  for (const level of [0, 1, 6, 9]) {
    for (const strategy of [0, Z_RLE]) {
      const one = deflateAll(scalar, pieces, { level, strategy });
      assertSameBytes(deflateAll(simd, pieces, { level, strategy }), one, `level ${level}, strategy ${strategy}`);
      assertSameBytes(zlib.inflateRawSync(one), expected, `level ${level}, strategy ${strategy} round trip`);
    }
  }
  // A sync flush ends on a byte boundary with an empty stored block, so a
  // stream ended there continues as another stream (the PNG16 bands).
  const first = deflateAll(scalar, [[a, Z_SYNC_FLUSH]]);
  assert.deepEqual(Array.from(first.subarray(-4)), [0, 0, 0xFF, 0xFF]);
  const second = deflateAll(scalar, [[b, Z_FINISH]]);
  assertSameBytes(zlib.inflateRawSync(Buffer.concat([first, second])), concat([a, b]), 'two streams');
}

{
  // pako's interface: chunks and `result` without onData, booleans as flush
  // modes, no pushes after the end, the empty push.
  const input = sample(200_000);
  const deflater = new simd.Deflate({ raw: true, level: 6 });
  assert.equal(deflater.push(new Uint8Array(0), false), true);
  assert.equal(deflater.push(input.buffer.slice(0), true), true);
  assert.equal(deflater.ended, true);
  assert.equal(deflater.err, 0);
  assertSameBytes(zlib.inflateRawSync(deflater.result), input, 'result');
  assert.equal(deflater.push(input, Z_FINISH), false, 'a finished stream takes nothing');
  deflater.dispose(); // twice is harmless
  // An empty stream.
  const empty = new scalar.Deflate({ raw: true });
  empty.push(new Uint8Array(0), Z_FINISH);
  assert.deepEqual(zlib.inflateRawSync(empty.result ?? Buffer.alloc(0)), Buffer.alloc(0));
}

// What the module rejects, it rejects before allocating anything.
assert.throws(() => new scalar.Deflate({ raw: false }), RangeError);
assert.throws(() => new scalar.Deflate({ raw: true, level: 10 }), RangeError);
assert.throws(() => new scalar.Deflate({ raw: true, strategy: 5 }), RangeError);
assert.throws(() => new scalar.Deflate({ raw: true }).push('text'), TypeError);
assert.throws(() => createWasmZlib({ memory: {} }), TypeError);

// --------------------------------------------- streams free their memory

{
  // A band but the last ends on a sync flush and is disposed, never
  // finished (png16Bands.js): 300 of them leave the memory where one did.
  const zlibImpl = await instantiatePngDeflate({ simd: false });
  const band = sample(1 << 20);
  const run = () => {
    const deflater = new zlibImpl.Deflate({ raw: true, level: 6, chunkSize: 1 << 20 });
    deflater.onData = () => {};
    deflater.push(band, Z_SYNC_FLUSH);
    deflater.dispose();
  };
  run();
  const memory = instanceMemoryBytes(zlibImpl);
  for (let i = 0; i < 300; i++) run();
  assert.equal(instanceMemoryBytes(zlibImpl), memory, 'no memory growth from disposed streams');
}

function instanceMemoryBytes(zlibImpl) {
  // The probe stream's own allocation lands in freed space.
  const probe = new zlibImpl.Deflate({ raw: true });
  probe.dispose();
  return zlibImpl.memoryBytes();
}

// ------------------------------- the PNG16 encoder: same bytes either module

{
  const width = 613, height = 401;
  const pixels = new Uint16Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 65535 : (Math.round((i % (width * 4)) / (width * 4) * 50000) + (random() >>> 22)) & 0xFFFF;
  for (const strategy of [0, Z_RLE]) {
    const a = await bytesOf(encodePng16BandsSerially(pixels, width, height, 3, scalar, { bandBytes: 60000, strategy }));
    const b = await bytesOf(encodePng16BandsSerially(pixels, width, height, 3, simd, { bandBytes: 60000, strategy }));
    assertSameBytes(a, b, `scalar and SIMD PNG16 bytes, strategy ${strategy}`);
    const p = await bytesOf(encodePng16BandsSerially(pixels, width, height, 3, pako, { bandBytes: 60000, strategy }));
    assert.ok(Math.abs(a.length - p.length) / p.length < 0.01, `size ${a.length} vs pako ${p.length}`);
  }
}

// ------------------------------------------------ loading and fallback

{
  assert.equal(png16DeflateVariant(), null, 'nothing loaded yet');
  const loaded = await loadPng16Zlib();
  assert.equal(loaded.variant, 'simd', 'Node validates WASM SIMD');
  assert.equal(await loadPng16Zlib(), loaded, 'one instance per realm');
  assert.equal(png16DeflateVariant(), 'simd');

  // An error of the encoder itself (a bad frame) is not the module's: it
  // propagates and the realm keeps the module.
  assert.throws(() => runWithPng16Fallback(loaded, (deflater) => encodePng16BandsSerially(new Uint16Array(8), 2, 2, 3, deflater)), RangeError);
  assert.equal(png16DeflateVariant(), 'simd');
  assert.equal(loaded.failed(), false);

  // A module that throws while encoding: the frame is encoded again with
  // pako, and the realm stays on pako.
  const width = 37, height = 29;
  const pixels = Uint16Array.from({ length: width * height * 4 }, (_, i) => (i * 7919) & 0xFFFF);
  const broken = { Deflate: class { constructor() { this.err = 0; } push() { throw new WebAssembly.RuntimeError('unreachable'); } } };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let blob;
  try {
    blob = runWithPng16Fallback(broken, (deflater) => encodePng16BandsSerially(pixels, width, height, 3, deflater, { bandBytes: 500 }));
  } finally {
    console.warn = warn;
  }
  assertSameBytes(await bytesOf(blob), await bytesOf(encodePng16BandsSerially(pixels, width, height, 3, pako, { bandBytes: 500 })), 'pako fallback');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WebAssembly deflate encode failed, using pako/);
  assert.equal(png16DeflateVariant(), 'pako');
  assert.equal(await loadPng16Zlib(), pako);
}

console.log('pngDeflateWasm.test.mjs passed');
