// Standalone Node test for sprocketFrame.js - run with:
// node negative2positive/src/app/sprocketFrame.test.mjs

import assert from 'node:assert/strict';
import {
  DEFAULT_SPROCKET_EDGE_MARKINGS,
  THIRTY_FIVE_MM_SPROCKET_SPEC,
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

let visibleHoleLeft = metrics.startX;
for (let i = 0; i < metrics.holeCount && visibleHoleLeft + metrics.holeWidth <= 0; i++) {
  visibleHoleLeft += metrics.pitch;
}
const topHoleCenter = ((metrics.topY + Math.floor(metrics.holeHeight / 2)) * framed.width
  + visibleHoleLeft + Math.floor(metrics.holeWidth / 2)) * 4;
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

const assertEdgeLayoutDoesNotOverlapHoles = (layoutMetrics) => {
  const topTextBottom = layoutMetrics.topMarkingY + layoutMetrics.edgeTextHeight;
  const bottomHoleBottom = layoutMetrics.bottomY + layoutMetrics.holeHeight;
  const bottomDxBottom = layoutMetrics.bottomDxY + layoutMetrics.dxCodeHeight;
  const bottomFrameBottom = layoutMetrics.bottomMarkingY + layoutMetrics.edgeTextHeight;
  const bottomGap = layoutMetrics.bottomOuterHeight >= layoutMetrics.edgeTextHeight + layoutMetrics.edgeGap * 2
    ? layoutMetrics.edgeGap
    : 0;

  assert.ok(topTextBottom + layoutMetrics.edgeGap <= layoutMetrics.topY);
  assert.ok(bottomHoleBottom + layoutMetrics.edgeGap <= layoutMetrics.bottomDxY);
  assert.ok(bottomHoleBottom + bottomGap <= layoutMetrics.bottomMarkingY);
  assert.ok(bottomDxBottom <= layoutMetrics.outputHeight);
  assert.ok(bottomFrameBottom + layoutMetrics.edgeGap <= layoutMetrics.outputHeight);
};

assertEdgeLayoutDoesNotOverlapHoles(markedMetrics);
assertEdgeLayoutDoesNotOverlapHoles(getSprocketFrameMetrics(360, 240, {
  edgeMarkings: {
    textEnabled: true,
    text: 'KODAK PORTRA 400',
    frameNumberEnabled: true,
    frameNumber: 18,
    frameNumberHole: 2,
    dxEnabled: true,
    dx1: 82,
    dx2: 3
  }
}));

const thirtyFiveMetrics = getSprocketFrameMetrics(360, 240, {
  edgeMarkings: {
    textEnabled: true,
    frameNumberEnabled: true,
    frameNumber: 18,
    frameNumberHole: 2,
    dxEnabled: true
  }
});
const approxEqual = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
};
approxEqual(
  thirtyFiveMetrics.bandHeight / 240,
  ((THIRTY_FIVE_MM_SPROCKET_SPEC.filmWidthMm - THIRTY_FIVE_MM_SPROCKET_SPEC.stillFrameHeightMm) / 2)
    / THIRTY_FIVE_MM_SPROCKET_SPEC.stillFrameHeightMm,
  0.01,
  '35mm edge band ratio'
);
assert.equal(thirtyFiveMetrics.holeCount, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationsPerStillFrame);
approxEqual(thirtyFiveMetrics.pitch / thirtyFiveMetrics.imagePxPerMmX, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationPitchMm, 0.08, '35mm perforation pitch');
approxEqual(thirtyFiveMetrics.holeWidth / thirtyFiveMetrics.imagePxPerMmX, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationWidthMm, 0.08, '35mm perforation width');
approxEqual(thirtyFiveMetrics.holeHeight / thirtyFiveMetrics.filmEdgePxPerMmY, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationHeightMm, 0.08, '35mm perforation height');

const hasMarkingColor = (() => {
  for (let i = 0; i < marked.data.length; i += 4) {
    if (marked.data[i] === 242 && marked.data[i + 1] === 194 && marked.data[i + 2] === 82) {
      return true;
    }
  }
  return false;
})();
assert.equal(hasMarkingColor, true);

const shiftedBaseMetrics = getSprocketFrameMetrics(360, 240);
const shiftedMetrics = getSprocketFrameMetrics(360, 240, {
  edgeMarkings: { firstHoleOffsetMm: 1 }
});
assert.notEqual(shiftedMetrics.startX, shiftedBaseMetrics.startX);

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
