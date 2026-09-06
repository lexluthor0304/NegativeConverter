// Standalone Node test for sprocketFrame.js - run with:
// node negative2positive/src/app/sprocketFrame.test.mjs

import assert from 'node:assert/strict';
import {
  DEFAULT_SPROCKET_EDGE_MARKINGS,
  THIRTY_FIVE_MM_SPROCKET_SPEC,
  buildDxEdgeCodeBlocks,
  composeSprocketFrame,
  composeSprocketFrameBackground,
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
for (let y = 0; y < 6; y++) {
  for (let x = 0; x < 10; x++) {
    const i = (y * 10 + x) * 4;
    sourcePixels[i] = 20 + x * 7 + y * 3;
    sourcePixels[i + 1] = 80 + x * 5 + y * 11;
    sourcePixels[i + 2] = 140 + x * 4 + y * 3;
    sourcePixels[i + 3] = 255;
  }
}

function assertPhotoRegionMatchesSource(framedImageData, frameMetrics, sourceImageData) {
  for (let y = 0; y < sourceImageData.height; y++) {
    for (let x = 0; x < sourceImageData.width; x++) {
      const srcIndex = (y * sourceImageData.width + x) * 4;
      const dstIndex = ((y + frameMetrics.bandHeight) * framedImageData.width + frameMetrics.sideMargin + x) * 4;
      assert.deepEqual(
        Array.from(framedImageData.data.slice(dstIndex, dstIndex + 4)),
        Array.from(sourceImageData.data.slice(srcIndex, srcIndex + 4))
      );
    }
  }
}

const source = new ImageData(sourcePixels, 10, 6);
const metrics = getSprocketFrameMetrics(source.width, source.height);
const framed = composeSprocketFrame(source);

assert.equal(framed.width, metrics.outputWidth);
assert.equal(framed.height, metrics.outputHeight);

const firstPhotoPixel = ((metrics.bandHeight * framed.width) + metrics.sideMargin) * 4;
assert.deepEqual(Array.from(framed.data.slice(firstPhotoPixel, firstPhotoPixel + 4)), [20, 80, 140, 255]);
assertPhotoRegionMatchesSource(framed, metrics, source);

const frameBackground = composeSprocketFrameBackground(source);
assert.equal(frameBackground.width, metrics.outputWidth);
assert.equal(frameBackground.height, metrics.outputHeight);
assert.deepEqual(Array.from(frameBackground.data.slice(firstPhotoPixel, firstPhotoPixel + 4)), [0, 0, 0, 0]);
assert.notDeepEqual(Array.from(frameBackground.data.slice(0, 4)), [0, 0, 0, 0]);

const filmPixel = 0;
const filmPixelRgba = Array.from(framed.data.slice(filmPixel, filmPixel + 4));
assert.equal(filmPixelRgba[3], 255);
assert.ok(filmPixelRgba[0] >= 6 && filmPixelRgba[0] <= 32);
assert.ok(filmPixelRgba[1] >= 6 && filmPixelRgba[1] <= 28);
assert.ok(filmPixelRgba[2] >= 4 && filmPixelRgba[2] <= 24);
assert.ok(filmPixelRgba[0] >= filmPixelRgba[1]);
assert.ok(filmPixelRgba[1] >= filmPixelRgba[2]);
assert.notDeepEqual(filmPixelRgba, [6, 6, 6, 255]);
assert.deepEqual(
  Array.from(composeSprocketFrame(source).data.slice(filmPixel, filmPixel + 4)),
  filmPixelRgba
);

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
    letteringColor: '#ed9c00',
    overexposureColor: '#ed9c00'
  }
};
const markedMetrics = getSprocketFrameMetrics(source.width, source.height, markedOptions);
const marked = composeSprocketFrame(source, markedOptions);
assert.equal(marked.width, markedMetrics.outputWidth);
assert.equal(marked.height, markedMetrics.outputHeight);
assert.ok(marked.height > framed.height);
assertPhotoRegionMatchesSource(marked, markedMetrics, source);

const assertEdgeLayoutUsesFilmLanes = (layoutMetrics) => {
  const topTextBottom = layoutMetrics.topMarkingY + layoutMetrics.edgeTextHeight;
  const bottomHoleBottom = layoutMetrics.bottomY + layoutMetrics.holeHeight;
  const bottomDxBottom = layoutMetrics.bottomDxY + layoutMetrics.dxCodeHeight;
  const bottomFrameBottom = layoutMetrics.bottomMarkingY + layoutMetrics.edgeTextHeight;
  assert.ok(topTextBottom + layoutMetrics.edgeGap <= layoutMetrics.topY);
  assert.ok(layoutMetrics.bottomDxY < bottomHoleBottom, 'DX は孔の外端とわずかに重なる');
  assert.ok(layoutMetrics.bottomDxY > layoutMetrics.bottomY + layoutMetrics.holeHeight / 2);
  assert.ok(layoutMetrics.bottomMarkingY >= bottomHoleBottom);
  assert.ok(Math.abs(bottomDxBottom - layoutMetrics.outputHeight) < 0.001);
  assert.ok(bottomFrameBottom < layoutMetrics.outputHeight);
};

assertEdgeLayoutUsesFilmLanes(markedMetrics);
assertEdgeLayoutUsesFilmLanes(getSprocketFrameMetrics(360, 240, {
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
assert.equal(thirtyFiveMetrics.perforationsPerFrame, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationsPerStillFrame);
assert.ok(thirtyFiveMetrics.holeCount > THIRTY_FIVE_MM_SPROCKET_SPEC.perforationsPerStillFrame);
assert.ok(thirtyFiveMetrics.startX < 0);
assert.ok(thirtyFiveMetrics.startX + thirtyFiveMetrics.holeWidth <= 0);
assert.ok(thirtyFiveMetrics.startX + (thirtyFiveMetrics.holeCount - 1) * thirtyFiveMetrics.pitch >= thirtyFiveMetrics.outputWidth);
approxEqual(thirtyFiveMetrics.pitch / thirtyFiveMetrics.imagePxPerMmX, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationPitchMm, 0.08, '35mm perforation pitch');
approxEqual(thirtyFiveMetrics.holeWidth / thirtyFiveMetrics.imagePxPerMmX, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationWidthMm, 0.08, '35mm perforation width');
approxEqual(thirtyFiveMetrics.holeHeight / thirtyFiveMetrics.filmEdgePxPerMmY, THIRTY_FIVE_MM_SPROCKET_SPEC.perforationHeightMm, 0.08, '35mm perforation height');
assert.equal(thirtyFiveMetrics.dxCodeHeight, thirtyFiveMetrics.dxBarHeight * 2 + thirtyFiveMetrics.dxRowGap);
assert.ok(thirtyFiveMetrics.dxCodeHeight >= Math.round(thirtyFiveMetrics.filmEdgePxPerMmY * 1.5));

const hasMarkingColor = (() => {
  for (let i = 0; i < marked.data.length; i += 4) {
    if (marked.data[i] >= 235 && marked.data[i + 1] >= 165 && marked.data[i + 2] <= 80) {
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
  halfFrameMarksEnabled: false,
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
assert.equal(normalized.halfFrameMarksEnabled, false);
assert.equal(normalized.overexposureStrength, 2);
assert.equal(normalized.fontStyle, DEFAULT_SPROCKET_EDGE_MARKINGS.fontStyle);
assert.equal(normalized.fontFamily.length, 80);
assert.deepEqual(normalized.holeColor, [18, 52, 86, 255]);
assert.deepEqual(normalized.letteringColor, [170, 187, 204, 255]);

const dxBlocks = buildDxEdgeCodeBlocks({ dx1: 82, dx2: 3, frameNumber: 18 });
assert.ok(dxBlocks.some((block) => block.column === 26 && block.row === 1));
assert.ok(dxBlocks.some((block) => block.column === 29 && block.row === 0));
assert.ok(dxBlocks.some((block) => block.column === 30 && block.row === 1));
const dxABlocks = buildDxEdgeCodeBlocks({ dx1: 82, dx2: 3, frameNumber: 18, aFlag: true });
assert.ok(dxABlocks.some((block) => block.column === 24 && block.row === 1));

assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: true }), true);
assert.equal(hasSprocketFrameEnabled({ sprocketHolesEnabled: false }), false);
assert.equal(hasSprocketFrameEnabled(null), false);

// 走査風の柔辺・露光は追加した縁だけに限定し、通常/背景経路を一致させる。
const naturalSource = new ImageData(new Uint8ClampedArray(360 * 240 * 4).fill(90), 360, 240);
for (let i = 3; i < naturalSource.data.length; i += 4) naturalSource.data[i] = 255;
for (const overexposedSprockets of [false, true]) {
  const options = { edgeMarkings: { ...markedOptions.edgeMarkings, overexposedSprockets } };
  const layout = getSprocketFrameMetrics(360, 240, options);
  const composed = composeSprocketFrame(naturalSource, options);
  const background = composeSprocketFrameBackground(naturalSource, options);
  assertPhotoRegionMatchesSource(composed, layout, naturalSource);
  assert.deepEqual(composeSprocketFrame(naturalSource, options).data, composed.data, '再描画で粒状感がちらつかない');
  for (let y = 0; y < composed.height; y++) for (let x = 0; x < composed.width; x++) {
    const inPhoto = y >= layout.bandHeight && y < layout.bottomBandTop && x >= layout.sideMargin && x < layout.sideMargin + 360;
    const i = (y * composed.width + x) * 4;
    if (!inPhoto) assert.deepEqual(background.data.subarray(i, i + 4), composed.data.subarray(i, i + 4));
    else assert.equal(background.data[i + 3], 0);
  }
}

const softLayout = getSprocketFrameMetrics(360, 240);
const cutout = composeSprocketFrame(naturalSource, { transparentHoles: true });
let softPixels = 0;
for (let i = 0; i < cutout.data.length; i += 4) {
  if (cutout.data[i + 3] > 0 && cutout.data[i + 3] < 255) softPixels++;
}
assert.ok(softPixels > 100, '齿孔の輪郭に連続した部分被覆を含む');
assertPhotoRegionMatchesSource(cutout, softLayout, naturalSource);

const quietOptions = { edgeMarkings: { textEnabled: true, text: 'HARMAN PHOENIX II 200', dxEnabled: true, frameNumberEnabled: true, letteringColor: '#c47a00' } };
const quietLayout = getSprocketFrameMetrics(360, 240, quietOptions);
const quiet = composeSprocketFrame(naturalSource, quietOptions);
let inkPixels = 0;
for (let y = 0; y < quietLayout.topY - 2; y++) for (let x = 0; x < quiet.width; x++) {
  const i = (y * quiet.width + x) * 4;
  if (quiet.data[i] > 40) {
    inkPixels++;
    assert.ok(quiet.data[i] <= 196 && quiet.data[i + 1] <= 122, '連結部も加算発光せず設定色の範囲内');
  }
}
assert.ok(inkPixels > 100);
for (let n = 0; n < quietLayout.holeCount; n++) {
  const x = Math.round(quietLayout.startX + n * quietLayout.pitch + quietLayout.holeWidth / 2);
  if (x < 0 || x >= quiet.width) continue;
  const y = Math.floor(quietLayout.bottomY + quietLayout.holeHeight - 2);
  const i = (y * quiet.width + x) * 4;
  assert.deepEqual(Array.from(quiet.data.subarray(i, i + 4)), [255, 255, 255, 255], 'DX は打ち抜き部分に残らない');
}
const panoramicLayout = getSprocketFrameMetrics(720, 240, quietOptions);
assert.equal(panoramicLayout.holeWidth, quietLayout.holeWidth);
assert.equal(panoramicLayout.holeHeight, quietLayout.holeHeight);
assert.equal(panoramicLayout.pitch, quietLayout.pitch);
assert.ok(panoramicLayout.holeCount > quietLayout.holeCount, '横長では齿孔を引き伸ばさず個数を増やす');

const portraitSource = new ImageData(new Uint8ClampedArray(240 * 360 * 4).fill(90), 240, 360);
for (let i = 3; i < portraitSource.data.length; i += 4) portraitSource.data[i] = 255;
const portraitFrame = composeSprocketFrame(portraitSource, quietOptions);
assert.equal(portraitFrame.width, quiet.height);
assert.equal(portraitFrame.height, quiet.width);
for (let y = 0; y < 360; y++) for (let x = 0; x < 240; x++) {
  const i = ((y + quietLayout.sideMargin) * portraitFrame.width + x + quietLayout.bandHeight) * 4;
  assert.deepEqual(Array.from(portraitFrame.data.subarray(i, i + 4)), [90, 90, 90, 255]);
}

console.log('sprocketFrame.test.mjs passed');
