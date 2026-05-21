import assert from 'node:assert/strict';

import { encodePng16Blob, encodeTiffBlob } from './exportImageEncoders.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const imageData = new ImageData(
  new Uint8ClampedArray([
    0, 64, 128, 255,
    255, 128, 64, 255
  ]),
  2,
  1
);

const png = new Uint8Array(await encodePng16Blob(imageData).arrayBuffer());
assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(new TextDecoder().decode(png.slice(12, 16)), 'IHDR');
assert.equal(png[24], 16);

const tiff = new Uint8Array(await encodeTiffBlob(imageData, 16).arrayBuffer());
assert.equal(tiff[0], 0x49);
assert.equal(tiff[1], 0x49);
assert.equal(new DataView(tiff.buffer).getUint16(2, true), 42);

console.log('exportImageEncoders tests passed');
