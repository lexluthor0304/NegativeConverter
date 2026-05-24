// Standalone Node test for sprocketFrame.js - run with:
// node negative2positive/src/app/sprocketFrame.test.mjs

import assert from 'node:assert/strict';
import {
  composeSprocketFrame,
  getSprocketFrameMetrics,
  hasSprocketFrameEnabled
} from './sprocketFrame.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const sourcePixels = new Uint8ClampedArray(10 * 6 * 4);
for (let i = 0; i < sourcePixels.length; i += 4) {
  sourcePixels[i] = 20;
  sourcePixels[i + 1] = 80;
  sourcePixels[i + 2] = 140;
  sourcePixels[i + 3] = 255;
}

const source = new ImageData(sourcePixels, 10, 6);
const metrics = getSprocketFrameMetrics(source.width, source.height);
const framed = composeSprocketFrame(source);

assert.equal(framed.width, metrics.outputWidth);
assert.equal(framed.height, metrics.outputHeight);

const firstPhotoPixel = ((metrics.bandHeight * framed.width) + metrics.sideMargin) * 4;
assert.deepEqual(Array.from(framed.data.slice(firstPhotoPixel, firstPhotoPixel + 4)), [20, 80, 140, 255]);

const filmPixel = 0;
assert.deepEqual(Array.from(framed.data.slice(filmPixel, filmPixel + 4)), [6, 6, 6, 255]);

const topHoleCenter = ((metrics.topY + Math.floor(metrics.holeHeight / 2)) * framed.width
  + metrics.startX + Math.floor(metrics.holeWidth / 2)) * 4;
assert.deepEqual(Array.from(framed.data.slice(topHoleCenter, topHoleCenter + 4)), [255, 255, 255, 255]);

const opaqueHoles = composeSprocketFrame(source, { transparentHoles: false, holeColor: [240, 230, 210, 255] });
assert.deepEqual(Array.from(opaqueHoles.data.slice(topHoleCenter, topHoleCenter + 4)), [240, 230, 210, 255]);

const transparentHoles = composeSprocketFrame(source, { transparentHoles: true });
assert.equal(transparentHoles.data[topHoleCenter + 3], 0);

assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: true }), true);
assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: false }), false);
assert.equal(hasSprocketFrameEnabled(null), false);

console.log('sprocketFrame.test.mjs passed');
