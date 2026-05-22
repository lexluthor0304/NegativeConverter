// Standalone Node test for imageDataOps.js - run with:
// node negative2positive/src/app/imageDataOps.test.mjs

import assert from 'node:assert/strict';
import {
  cropImageDataRegion,
  downsampleImageDataForMaxDim,
  downsampleImageDataForMaxPixels
} from './imageDataOps.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function makeImageData(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = x + y;
      data[i + 3] = 128;
      data16[i] = x * 257;
      data16[i + 1] = y * 257;
      data16[i + 2] = (x + y) * 257;
      data16[i + 3] = 65535;
    }
  }

  const imageData = new ImageData(data, width, height);
  imageData.__image16 = { width, height, data: data16 };
  return imageData;
}

const source = makeImageData(6, 4);

const byPixels = downsampleImageDataForMaxPixels(source, 6);
assert.equal(byPixels.width, 3);
assert.equal(byPixels.height, 2);
assert.deepEqual(Array.from(byPixels.data.slice(0, 8)), [0, 0, 0, 255, 2, 0, 2, 255]);
assert.ok(byPixels.__image16);
assert.equal(byPixels.__image16.width, 3);
assert.equal(byPixels.__image16.height, 2);
assert.deepEqual(Array.from(byPixels.__image16.data.slice(0, 8)), [0, 0, 0, 65535, 514, 0, 514, 65535]);

const byDim = downsampleImageDataForMaxDim(source, 3);
assert.equal(byDim.width, 3);
assert.equal(byDim.height, 2);
assert.deepEqual(Array.from(byDim.data.slice(8, 16)), [4, 0, 4, 255, 0, 2, 2, 255]);
assert.ok(byDim.__image16);
assert.deepEqual(Array.from(byDim.__image16.data.slice(8, 16)), [1028, 0, 1028, 65535, 0, 514, 514, 65535]);

const cropped = cropImageDataRegion(source, { left: 1, top: 1, width: 3, height: 2 });
assert.equal(cropped.width, 3);
assert.equal(cropped.height, 2);
assert.deepEqual(Array.from(cropped.data.slice(0, 12)), [1, 1, 2, 255, 2, 1, 3, 255, 3, 1, 4, 255]);
assert.ok(cropped.__image16);
assert.deepEqual(Array.from(cropped.__image16.data.slice(0, 8)), [257, 257, 514, 65535, 514, 257, 771, 65535]);

console.log('imageDataOps.test.mjs passed');
