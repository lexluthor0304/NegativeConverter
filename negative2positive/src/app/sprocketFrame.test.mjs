// Standalone Node test for sprocketFrame.js - run with:
// node negative2positive/src/app/sprocketFrame.test.mjs

import assert from 'node:assert/strict';
import {
  DEFAULT_SPROCKET_EDGE_MARKINGS,
  buildDxEdgeCodeBlocks,
  composeSprocketFrame,
  getSprocketFrameMetrics,
  hasSprocketFrameEnabled,
  normalizeSprocketEdgeMarkings
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

const edgeHoleColor = composeSprocketFrame(source, { edgeMarkings: { holeColor: '#112233' } });
assert.deepEqual(Array.from(edgeHoleColor.data.slice(topHoleCenter, topHoleCenter + 4)), [17, 34, 51, 255]);

const transparentHoles = composeSprocketFrame(source, { transparentHoles: true });
assert.equal(transparentHoles.data[topHoleCenter + 3], 0);

const markedOptions = {
  edgeMarkings: {
    textEnabled: true,
    text: DEFAULT_SPROCKET_EDGE_MARKINGS.text,
    frameNumberEnabled: true,
    frameNumber: 18,
    frameNumberHole: 1,
    dxEnabled: true,
    dx1: 82,
    dx2: 3,
    overexposedSprockets: true,
    letteringColor: '#f2c252',
    overexposureColor: '#ed9c00'
  }
};
const markedMetrics = getSprocketFrameMetrics(source.width, source.height, markedOptions);
const marked = composeSprocketFrame(source, markedOptions);
assert.equal(marked.width, markedMetrics.outputWidth);
assert.equal(marked.height, markedMetrics.outputHeight);
assert.ok(marked.height > framed.height);

const hasMarkingColor = (() => {
  for (let i = 0; i < marked.data.length; i += 4) {
    if (marked.data[i] === 242 && marked.data[i + 1] === 194 && marked.data[i + 2] === 82) {
      return true;
    }
  }
  return false;
})();
assert.equal(hasMarkingColor, true);

const shiftedMetrics = getSprocketFrameMetrics(source.width, source.height, {
  edgeMarkings: { firstHoleOffsetMm: 1 }
});
assert.notEqual(shiftedMetrics.startX, metrics.startX);

const normalized = normalizeSprocketEdgeMarkings({
  frameNumber: 999,
  frameNumberHole: 99,
  firstHoleOffsetMm: -9,
  dx1: 999,
  dx2: -5,
  overexposureStrength: 99,
  fontStyle: 'bad-style',
  fontFamily: 'A'.repeat(120),
  holeColor: '#123456',
  letteringColor: '#abc'
});
assert.equal(normalized.frameNumber, 99);
assert.equal(normalized.frameNumberHole, 8);
assert.equal(normalized.firstHoleOffsetMm, -2.5);
assert.equal(normalized.dx1, 126);
assert.equal(normalized.dx2, 0);
assert.equal(normalized.overexposureStrength, 2);
assert.equal(normalized.fontStyle, DEFAULT_SPROCKET_EDGE_MARKINGS.fontStyle);
assert.equal(normalized.fontFamily.length, 80);
assert.deepEqual(normalized.holeColor, [18, 52, 86, 255]);
assert.deepEqual(normalized.letteringColor, [170, 187, 204, 255]);

const dxBlocks = buildDxEdgeCodeBlocks({ dx1: 82, dx2: 3, frameNumber: 18 });
assert.ok(dxBlocks.some((block) => block.column === 26 && block.row === 1));
assert.ok(dxBlocks.some((block) => block.column === 29 && block.row === 0));
assert.ok(dxBlocks.some((block) => block.column === 30 && block.row === 1));

assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: true }), true);
assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: false }), false);
assert.equal(hasSprocketFrameEnabled(null), false);

console.log('sprocketFrame.test.mjs passed');
