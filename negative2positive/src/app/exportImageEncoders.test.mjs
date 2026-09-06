// Standalone Node test for the PNG16/TIFF encoders.
//
// Covers BOTH entry points — app/exportImageEncoders.js (main-thread fallback)
// and workers/imageEncoders.js (what the export Worker, i.e. the path every
// normal browser export takes, actually runs) — and decodes the produced bytes
// so a regression back to "8-bit data x257 labelled 16-bit" fails the suite.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as pako from 'pako';

import { encodePng16Blob, encodeTiffBlob } from './exportImageEncoders.js';
import {
  encodePng16Blob as workerEncodePng16Samples,
  encodeTiffBlob as workerEncodeTiffSamples,
  selectExportSamples
} from '../workers/imageEncoders.js';

const require = createRequire(import.meta.url);
const UPNG = require('upng-js');

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// ---------------------------------------------------------------- PNG helpers

function decodePng(bytes) {
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), 'IHDR');
  assert.equal(bytes[24], 16, 'IHDR bit depth must be 16');
  assert.equal(bytes[25], 6, 'IHDR colour type must be 6 (RGBA)');
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(decoded.depth, 16);
  assert.equal(decoded.ctype, 6);
  // UPNG hands back the raw post-defilter bytes; 16-bit samples are big-endian.
  const samples = new Uint16Array(decoded.width * decoded.height * 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (decoded.data[i * 2] << 8) | decoded.data[i * 2 + 1];
  }
  return { width: decoded.width, height: decoded.height, samples };
}

// --------------------------------------------------------------- TIFF helpers

function decodeTiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes[0], 0x49);
  assert.equal(bytes[1], 0x49);
  assert.equal(view.getUint16(2, true), 42);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  const tags = new Map();
  for (let i = 0; i < entryCount; i++) {
    const off = ifdOffset + 2 + i * 12;
    tags.set(view.getUint16(off, true), {
      type: view.getUint16(off + 2, true),
      count: view.getUint32(off + 4, true),
      value: view.getUint32(off + 8, true)
    });
  }
  const bitsEntry = tags.get(258);
  const bitsPerSample = bitsEntry.count <= 2
    ? [bitsEntry.value & 0xFFFF]
    : Array.from({ length: bitsEntry.count }, (_, i) => view.getUint16(bitsEntry.value + i * 2, true));
  const stripOffset = tags.get(273).value;
  const stripByteCount = tags.get(279).value;
  const depth = bitsPerSample[0];
  const sampleCount = stripByteCount / (depth === 16 ? 2 : 1);
  const samples = depth === 16 ? new Uint16Array(sampleCount) : new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = depth === 16
      ? view.getUint16(stripOffset + i * 2, true)
      : bytes[stripOffset + i];
  }
  return {
    width: tags.get(256).value,
    height: tags.get(257).value,
    samplesPerPixel: tags.get(277).value & 0xFFFF,
    bitsPerSample,
    samples
  };
}

// ------------------------------------------------------------------- fixtures

const WIDTH = 2;
const HEIGHT = 1;

function make8BitImageData() {
  return new ImageData(
    new Uint8ClampedArray([
      0, 64, 128, 255,
      255, 128, 64, 255
    ]),
    WIDTH,
    HEIGHT
  );
}

// Deliberately NOT multiples of 257: if these survive the round trip the export
// really is 16-bit; if they come back as byte*257 the precision was destroyed.
const TRUE16 = new Uint16Array([
  0x1234, 0x0001, 0xFFFE, 0xFFFF,
  0xABCD, 0x8000, 0x0100, 0xFFFF
]);

function make16BitImageData() {
  const imageData = make8BitImageData();
  imageData.__image16 = { width: WIDTH, height: HEIGHT, data: TRUE16 };
  return imageData;
}

// ------------------------------------------------ selectExportSamples routing

{
  const plain = make8BitImageData();
  assert.equal(selectExportSamples(plain, 16).sampleBits, 8);
  assert.equal(selectExportSamples(plain, 16).samples, plain.data);

  const rich = make16BitImageData();
  assert.equal(selectExportSamples(rich, 16).sampleBits, 16);
  assert.equal(selectExportSamples(rich, 16).samples, TRUE16);
  // An 8-bit request must never pull the 16-bit plane.
  assert.equal(selectExportSamples(rich, 8).sampleBits, 8);

  // Dimension mismatch must be rejected rather than exported as garbage.
  const mismatched = make8BitImageData();
  mismatched.__image16 = { width: 4, height: 4, data: new Uint16Array(64) };
  assert.equal(selectExportSamples(mismatched, 16).sampleBits, 8);
}

// -------------------------------------------- PNG: 8-bit fallback (x257 path)

{
  const imageData = make8BitImageData();
  const png = await bytesOf(encodePng16Blob(imageData));
  const { width, height, samples } = decodePng(png);
  assert.equal(width, WIDTH);
  assert.equal(height, HEIGHT);
  // Documented fallback: each byte replicated, so 64 -> 0x4040.
  assert.deepEqual(Array.from(samples), Array.from(imageData.data).map((v) => v * 257));
}

// ------------------------------------------------ PNG: genuine 16-bit samples

{
  const imageData = make16BitImageData();
  const png = await bytesOf(encodePng16Blob(imageData));
  const { samples } = decodePng(png);
  const expected = Array.from(TRUE16);
  expected[3] = 65535;
  expected[7] = 65535; // alpha is forced opaque
  assert.deepEqual(Array.from(samples), expected);
  // Regression guard: none of the colour samples may be an 8-bit value x257.
  assert.ok(samples[0] % 257 !== 0, 'sample 0x1234 must survive as 16-bit');
  assert.equal(samples[0], 0x1234);
  assert.equal(samples[4], 0xABCD);
}

// ------------------------------------------- TIFF: 8-bit fallback and 16-bit

{
  const imageData = make8BitImageData();
  const tiff = decodeTiff(await bytesOf(encodeTiffBlob(imageData, 16)));
  assert.deepEqual(tiff.bitsPerSample, [16, 16, 16, 16]);
  assert.equal(tiff.samplesPerPixel, 4);
  assert.deepEqual(Array.from(tiff.samples), Array.from(imageData.data).map((v) => v * 257));
}

{
  const imageData = make16BitImageData();
  const tiff = decodeTiff(await bytesOf(encodeTiffBlob(imageData, 16)));
  assert.deepEqual(tiff.bitsPerSample, [16, 16, 16, 16]);
  const expected = Array.from(TRUE16);
  expected[3] = 65535;
  expected[7] = 65535;
  assert.deepEqual(Array.from(tiff.samples), expected);
  assert.equal(tiff.samples[0], 0x1234);
}

{
  // 8-bit TIFF requested while a 16-bit plane exists: reduce, never upscale.
  const imageData = make16BitImageData();
  const tiff = decodeTiff(await bytesOf(encodeTiffBlob(imageData, 8)));
  assert.deepEqual(tiff.bitsPerSample, [8, 8, 8, 8]);
  assert.deepEqual(Array.from(tiff.samples), Array.from(imageData.data));
}

// ------------------------------- worker entry point produces identical output

for (const imageData of [make8BitImageData(), make16BitImageData()]) {
  const { samples } = selectExportSamples(imageData, 16);

  const appPng = await bytesOf(encodePng16Blob(imageData));
  const workerPng = await bytesOf(
    workerEncodePng16Samples(samples, imageData.width, imageData.height, pako.deflate)
  );
  assert.deepEqual(Array.from(workerPng), Array.from(appPng), 'PNG entry points must agree');

  const appTiff = await bytesOf(encodeTiffBlob(imageData, 16));
  const workerTiff = await bytesOf(
    workerEncodeTiffSamples(samples, imageData.width, imageData.height, 16)
  );
  assert.deepEqual(Array.from(workerTiff), Array.from(appTiff), 'TIFF entry points must agree');
}

console.log('exportImageEncoders tests passed');
