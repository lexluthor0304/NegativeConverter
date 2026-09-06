// Standalone Node test for exportWorker.js — the message handler that every
// normal browser export actually runs (the main-thread encoders in
// app/exportImageEncoders.js are only the fallback).
//
// Drives real messages through the worker's onmessage and decodes the Blobs it
// posts back, so a regression to "8-bit data x257 labelled 16-bit" fails here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UPNG = require('upng-js');

const posted = [];
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers) {
    posted.push({ message, transfers });
  }
};

await import('./exportWorker.js');
assert.equal(typeof self.onmessage, 'function', 'exportWorker must install an onmessage handler');

function send(message) {
  posted.length = 0;
  self.onmessage({ data: message });
  return posted.map((p) => p.message);
}

async function blobOf(messages) {
  const result = messages.find((m) => m.type === 'blobResult');
  assert.ok(result, `expected a blobResult, got ${messages.map((m) => m.type).join(', ')}`);
  return new Uint8Array(await result.blob.arrayBuffer());
}

function png16Samples(bytes) {
  assert.equal(bytes[24], 16, 'IHDR bit depth');
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(decoded.depth, 16);
  const samples = new Uint16Array(decoded.width * decoded.height * 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (decoded.data[i * 2] << 8) | decoded.data[i * 2 + 1];
  }
  return samples;
}

function tiff16Samples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  let stripOffset = 0;
  let stripByteCount = 0;
  let bitsOffset = 0;
  for (let i = 0; i < entryCount; i++) {
    const off = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(off, true);
    const value = view.getUint32(off + 8, true);
    if (tag === 273) stripOffset = value;
    if (tag === 279) stripByteCount = value;
    if (tag === 258) bitsOffset = value;
  }
  assert.equal(view.getUint16(bitsOffset, true), 16, 'BitsPerSample must be 16');
  const samples = new Uint16Array(stripByteCount / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getUint16(stripOffset + i * 2, true);
  return samples;
}

const WIDTH = 2;
const HEIGHT = 1;
const EIGHT_BIT = new Uint8ClampedArray([0, 64, 128, 255, 255, 128, 64, 255]);
// Deliberately not multiples of 257.
const SIXTEEN_BIT = new Uint16Array([0x1234, 0x0001, 0xFFFE, 0xFFFF, 0xABCD, 0x8000, 0x0100, 0xFFFF]);

const copyOf = (view) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

// ------------------------------------------- PNG16: 8-bit fallback vs 16-bit

{
  const samples = png16Samples(await blobOf(send({
    type: 'encodePng16', id: 1, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT
  })));
  assert.deepEqual(Array.from(samples), Array.from(EIGHT_BIT).map((v) => v * 257));
}

{
  const samples = png16Samples(await blobOf(send({
    type: 'encodePng16', id: 2, pixelData: copyOf(SIXTEEN_BIT), sourceBits: 16, width: WIDTH, height: HEIGHT
  })));
  assert.equal(samples[0], 0x1234, 'the worker must write genuine 16-bit samples');
  assert.equal(samples[4], 0xABCD);
  assert.equal(samples[1], 0x0001);
  assert.equal(samples[3], 65535, 'alpha forced opaque');
  assert.ok(samples[0] % 257 !== 0, 'a x257 regression must fail here');
}

// -------------------------------------------------------------------- TIFF16

{
  const samples = tiff16Samples(await blobOf(send({
    type: 'encodeTiff', id: 3, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT, bitDepth: 16
  })));
  assert.deepEqual(Array.from(samples), Array.from(EIGHT_BIT).map((v) => v * 257));
}

{
  const samples = tiff16Samples(await blobOf(send({
    type: 'encodeTiff', id: 4, pixelData: copyOf(SIXTEEN_BIT), sourceBits: 16, width: WIDTH, height: HEIGHT, bitDepth: 16
  })));
  assert.equal(samples[0], 0x1234);
  assert.equal(samples[4], 0xABCD);
}

// ------------------------------------------- progress + applyAdjustments path

{
  const messages = send({
    type: 'encodePng16', id: 5, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: WIDTH, height: HEIGHT
  });
  assert.deepEqual(
    messages.filter((m) => m.type === 'progress').map((m) => m.percent),
    [10, 100]
  );
}

{
  const identity = new Uint8Array(256);
  for (let i = 0; i < 256; i++) identity[i] = i;
  const messages = send({
    type: 'applyAdjustments',
    id: 6,
    inputBuffer: copyOf(EIGHT_BIT),
    width: WIDTH,
    height: HEIGHT,
    settings: { curves: { r: identity, g: identity, b: identity }, exposure: 1 },
    quality: 'full'
  });
  const result = messages.find((m) => m.type === 'result');
  assert.ok(result);
  assert.equal(result.width, WIDTH);
  assert.deepEqual(Array.from(new Uint8ClampedArray(result.data)), [0, 128, 255, 255, 255, 255, 128, 255]);
  const transferred = posted.find((p) => p.message.type === 'result').transfers;
  assert.deepEqual(transferred, [result.data], 'the result buffer must be transferred, not cloned');
}

// ------------------------------------------------------------ error handling

{
  const messages = send({ type: 'nonsense', id: 7 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'error');
  assert.match(messages[0].message, /Unknown message type/);
}

{
  // A throwing handler must report back rather than strand the request.
  const messages = send({ type: 'encodePng16', id: 8, pixelData: copyOf(EIGHT_BIT), sourceBits: 8, width: -1, height: 1 });
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(messages.at(-1).id, 8);
}

console.log('exportWorker.test.mjs passed');
