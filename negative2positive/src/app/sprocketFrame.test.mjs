// Standalone Node test for sprocketFrame.js - run with:
// node negative2positive/src/app/sprocketFrame.test.mjs

import assert from 'node:assert/strict';
import {
  DEFAULT_SPROCKET_EDGE_MARKINGS,
  THIRTY_FIVE_MM_SPROCKET_SPEC,
  buildDxEdgeCodeBlocks,
  composeSprocketFrame,
  composeSprocketFrameBackground,
  areSprocketFrameFontsReady,
  ensureSprocketFrameFonts,
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
// Parity counts set bits, not the numeric sum: 2 = 0b10 has one set bit (odd)
// although the value itself is even, so the parity bar must be present.
const dxParityBlocks = buildDxEdgeCodeBlocks({ dx1: 2, dx2: 0, frameNumber: 0, aFlag: false });
assert.ok(dxParityBlocks.some((block) => block.column === 26 && block.row === 1), 'DX parity follows the set-bit count');
// 3 = 0b11 has two set bits (even) although the value is odd: no parity bar.
const dxEvenBlocks = buildDxEdgeCodeBlocks({ dx1: 3, dx2: 0, frameNumber: 0, aFlag: false });
assert.ok(!dxEvenBlocks.some((block) => block.column === 26 && block.row === 1), 'even set-bit count clears the parity bar');

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

// Native glyphs load before export and keep their designed 12px grid.
const originalOffscreenCanvas = globalThis.OffscreenCanvas;
const originalFontFace = globalThis.FontFace;
const originalDocument = globalThis.document;
const canvasLabels = [];
const canvasSizes = [];
globalThis.document = { fonts: { add() {} } };
globalThis.FontFace = class { async load() { return this; } };
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    canvasSizes.push([width, height]);
  }
  getContext() {
    return {
      measureText: () => ({ width: 12, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 1 }),
      clearRect() {},
      scale() { assert.fail('Native pixel outlines must not be fitted or resampled'); },
      fillText(text, x, y) {
        canvasLabels.push(text);
        assert.ok(Number.isInteger(x) && Number.isInteger(y), 'Use integer origins');
        if (Array.from(text).length === 1 && text !== '𠮷') assert.match(this.font, /^400 12px "NC Film Edge /);
      },
      getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) })
    };
  }
};
try {
  const loadingOptions = { edgeMarkings: { textEnabled: true, text: '中文' } };
  assert.equal(areSprocketFrameFontsReady(loadingOptions), false);
  composeSprocketFrame(source, loadingOptions);
  assert.equal(canvasLabels.length, 0, 'Do not sample a system fallback while the native font loads');
  await ensureSprocketFrameFonts(loadingOptions);
  assert.equal(areSprocketFrameFontsReady(loadingOptions), true);
  composeSprocketFrame(source, loadingOptions);
  assert.ok(canvasLabels.includes('中'), 'Loading completion replaces the temporary blank');

  for (const compose of [composeSprocketFrame, composeSprocketFrameBackground]) {
    const fontLocale = compose === composeSprocketFrame ? 'ja' : 'ko';
    for (const text of ['中文胶片', '日本語フィルム', '한국어 필름', 'Portra 400 東京・京都', '𠮷野家']) {
      canvasLabels.length = 0;
      canvasSizes.length = 0;
      const options = { edgeMarkings: { textEnabled: true, text, fontLocale } };
      await ensureSprocketFrameFonts(options);
      compose(source, options);
      assert.ok(canvasLabels.length > 0, `Unicode bitmap required for ${text}`);
      assert.ok(canvasLabels.every((label) => Array.from(text).includes(label)), 'Sample the original Unicode code points');
      assert.ok(canvasSizes.every(([w, h]) => w === h && (w === 12 || (text.includes('𠮷') && w === 16))), 'CJK uses its native 12px grid; only missing glyphs fall back');
      canvasLabels.length = 0;
      compose(naturalSource, options);
      assert.equal(canvasLabels.length, 0, 'Reuse the same bitmap at larger output sizes');
    }
    canvasLabels.length = 0;
    compose(source, { edgeMarkings: { textEnabled: true, text: 'Kodak Portra 160' } });
    assert.equal(canvasLabels.length, 0, 'Supported Latin labels retain the original bitmap style');
    compose(source, { edgeMarkings: { textEnabled: true, text: 'Kodak', fontStyle: 'serif' } });
    assert.ok(canvasLabels.includes('Kodak'), 'Explicit canvas font selections still apply');
  }
} finally {
  if (originalOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
  else globalThis.OffscreenCanvas = originalOffscreenCanvas;
  if (originalFontFace === undefined) delete globalThis.FontFace;
  else globalThis.FontFace = originalFontFace;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
assert.equal(
  normalizeSprocketEdgeMarkings({ text: '中'.repeat(47) + '𠮷尾' }).text,
  '中'.repeat(47) + '𠮷',
  'The text limit must not split supplementary CJK characters'
);

// The frame is composed in steps (rows, holes, markings) so that an export can
// pause between them. What the steps draw is pinned to what the single pass
// drew before them (FNV-1a of the frame and of its background, taken at
// 4f09b4c7), and the sliced composer returns the same frame.
{
  const { composeSprocketFrameAsync } = await import('./sprocketFrame.js');
  const fnv = (data) => { let h = 2166136261; for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
  const frameOf = (w, h) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = (x * 7 + y * 3) & 255; d[i + 1] = (x * 5 + y * 11) & 255; d[i + 2] = (x ^ y) & 255; d[i + 3] = 255; }
    return new ImageData(d, w, h);
  };
  const E = DEFAULT_SPROCKET_EDGE_MARKINGS;
  const optionSets = {
    plain: {},
    markings: { edgeMarkings: { ...E, textEnabled: true, text: 'NEO ANALOG LAB 400', frameNumberEnabled: true, dxEnabled: true } },
    glow: { edgeMarkings: { ...E, overexposedSprockets: true, overexposureStrength: 1.4 } },
    all: { edgeMarkings: { ...E, textEnabled: true, frameNumberEnabled: true, frameNumber: 7, dxEnabled: true, dx1: 108, dx2: 10, overexposedSprockets: true, firstHoleOffsetMm: 1.3, halfFrameMarksEnabled: true } },
    holes: { transparentHoles: true, filmColor: [20, 12, 9, 255], edgeMarkings: { ...E, dxEnabled: true, holeColor: '#112233' } }
  };
  const pinned = {
    '640x427 plain': '676x623:44480184 bg:f0f7f404',
    '640x427 all': '676x623:f3ababec bg:d87b9c6c',
    '1203x801 markings': '1269x1167:996506d9 bg:c8239adb',
    '1203x801 glow': '1269x1167:1c279644 bg:06d96046',
    '427x640 all': '623x676:e6ac3c5c bg:a297cb88',
    '960x320 all': '986x466:c7d2f772 bg:4eabf172',
    '97x61 holes': '113x133:21da6b98 bg:eb4a5b2d'
};
  for (const [key, expected] of Object.entries(pinned)) {
    const [size, name] = key.split(' '), [w, h] = size.split('x').map(Number);
    const image = frameOf(w, h), options = optionSets[name];
    const whole = composeSprocketFrame(image, options), background = composeSprocketFrameBackground(image, options);
    assert.equal(`${whole.width}x${whole.height}:${fnv(whole.data)} bg:${fnv(background.data)}`, expected, `${key}: the frame is the one the single pass drew`);
    // Every step ends a slice, and two frames are composed at once: the
    // sliced frames are the same bytes, and neither sees the other's markings.
    let pauses = 0;
    const pause = () => { pauses++; return Promise.resolve(); };
    const [sliced, other] = await Promise.all([
      composeSprocketFrameAsync(image, options, { budgetMs: 0, pause }),
      composeSprocketFrameAsync(frameOf(h + 40, w), optionSets.all, { budgetMs: 0, pause })
    ]);
    assert.equal(fnv(sliced.data), fnv(whole.data), `${key}: sliced and whole agree`);
    assert.equal(fnv(other.data), fnv(composeSprocketFrame(frameOf(h + 40, w), optionSets.all).data), `${key}: a frame composed alongside is its own`);
    assert.ok(pauses > 10, `${key}: the composer paused between steps (${pauses})`);
    const sliceBackground = await composeSprocketFrameAsync(image, options, { budgetMs: 0, pause, includePhoto: false });
    assert.equal(fnv(sliceBackground.data), fnv(background.data));
  }
  // With a budget the composer pauses only when a slice has run its time.
  let pauses = 0;
  await composeSprocketFrameAsync(frameOf(640, 427), optionSets.all, { budgetMs: 1e9, pause: () => { pauses++; return Promise.resolve(); } });
  assert.equal(pauses, 0, 'no pause inside the budget');
}

// Brand styles (edgeMarkingStyles.js). A setting without a style, or with an
// unknown one, is custom: byte for byte the frame drawn before styles existed.
// Each style's frame is pinned, keeps the photo's pixels, and is the same
// composed in slices.
{
  const { composeSprocketFrameAsync, styledFrameSlots } = await import('./sprocketFrame.js');
  const { applyEdgeMarkingStyle, edgeMarkingStyle } = await import('./edgeMarkingStyles.js');
  const fnv = (data) => { let h = 2166136261; for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
  const frameOf = (w, h) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = (x * 7 + y * 3) & 255; d[i + 1] = (x * 5 + y * 11) & 255; d[i + 2] = (x ^ y) & 255; d[i + 3] = 255; }
    return new ImageData(d, w, h);
  };
  const E = DEFAULT_SPROCKET_EDGE_MARKINGS;
  const legacy = { ...E, textEnabled: true, text: 'NEO ANALOG LAB 400', frameNumberEnabled: true, dxEnabled: true };
  delete legacy.style;
  const image = frameOf(1203, 801);
  const legacyHash = fnv(composeSprocketFrame(image, { edgeMarkings: legacy }).data);
  assert.equal(legacyHash, '996506d9', 'a setting saved before styles draws the pinned frame');
  assert.equal(fnv(composeSprocketFrame(image, { edgeMarkings: { ...legacy, style: 'custom' } }).data), legacyHash);
  assert.equal(fnv(composeSprocketFrame(image, { edgeMarkings: { ...legacy, style: 'agfa' } }).data), legacyHash, 'an unknown id is custom');
  assert.equal(normalizeSprocketEdgeMarkings({}).style, 'custom');
  assert.equal(normalizeSprocketEdgeMarkings({ style: 'fujiSlide' }).style, 'fujiSlide');

  const styled = (id, extra = {}) => ({ edgeMarkings: { ...applyEdgeMarkingStyle(E, id), frameNumber: 31, ...extra } });
  const pinnedStyles = {
    kodakColor: '1269x1167:eced2f14',
    ilford: '1269x1167:53220b65',
    kodakBw: '1269x1167:1fa8557e',
    kodakSlide: '1269x1167:03dc8ccb',
    fujiColor: '1269x1167:7b6dcda6',
    fujiSlide: '1269x1167:a84686b5',
    fomapan: '1269x1167:49ad92ee',
    agfaApx: '1269x1167:3be2e54d',
    plain: '1269x1167:01d5229c'
  };
  const plainFrame = composeSprocketFrame(image, { edgeMarkings: { ...E } });
  for (const [id, expected] of Object.entries(pinnedStyles)) {
    const options = styled(id);
    const whole = composeSprocketFrame(image, options);
    const metricsOf = getSprocketFrameMetrics(image.width, image.height, options);
    assert.equal(`${whole.width}x${whole.height}:${fnv(whole.data)}`, expected, `${id}: pinned frame`);
    assertPhotoRegionMatchesSource(whole, metricsOf, image);
    // The markings are on the film: the border differs from a bare one.
    assert.notEqual(fnv(whole.data), fnv(plainFrame.data), `${id}: markings drawn`);
    let pauses = 0;
    const sliced = await composeSprocketFrameAsync(image, options, { budgetMs: 0, pause: () => { pauses++; return Promise.resolve(); } });
    assert.equal(fnv(sliced.data), fnv(whole.data), `${id}: sliced and whole agree`);
    assert.ok(pauses > 10);
    // Switching every marking off leaves the bare border.
    const off = composeSprocketFrame(image, styled(id, { textEnabled: false, frameNumberEnabled: false, dxEnabled: false }));
    assert.equal(fnv(off.data), fnv(composeSprocketFrame(image, { edgeMarkings: { ...E, textEnabled: false } }).data), `${id}: nothing when all switches are off`);
  }
  // A portrait photo keeps its pixels too.
  const portrait = frameOf(401, 601);
  const portraitFrame = composeSprocketFrame(portrait, styled('kodakColor'));
  assert.equal(portraitFrame.width, getSprocketFrameMetrics(601, 401, styled('kodakColor')).outputHeight);

  // The frames a style numbers: eight perforations apart, numbered on from
  // the photo's own number, the main number at the film's phase to the holes.
  const m = getSprocketFrameMetrics(1203, 801, styled('kodakColor'));
  const slots = styledFrameSlots(m, { frameNumber: 31 }, edgeMarkingStyle('kodakColor'));
  const own = slots.find((slot) => slot.number === 31);
  assert.ok(Math.abs(own.x - (m.frameStartX + 1.5 * m.pitch)) < 1e-9);
  assert.ok(slots.every((slot, i) => i === 0 || Math.abs(slot.x - slots[i - 1].x - 8 * m.pitch) < 1e-9));
  // Fomapan numbers every four perforations, counting on by one; its name,
  // speed and batch number come once every 24 numbers, from the number that
  // leaves 3 (51, 75): frame 51 shows the name, frame 63 none of the group.
  const foma = edgeMarkingStyle('fomapan');
  const fm = getSprocketFrameMetrics(1203, 801, styled('fomapan'));
  const fomaSlots = styledFrameSlots(fm, { frameNumber: 51 }, foma);
  assert.ok(fomaSlots.every((slot, i) => i === 0 || (Math.abs(slot.x - fomaSlots[i - 1].x - 4 * fm.pitch) < 1e-9 && slot.count === fomaSlots[i - 1].count + 1)));
  assert.ok(Math.abs(fomaSlots.find((slot) => slot.number === 51).x - (fm.frameStartX + 1.7 * fm.pitch)) < 1e-9);
  // The slots reach back far enough for the batch number 26 perforations after its number.
  assert.ok(fomaSlots[0].x < -26 * fm.pitch);
  const topRail = (frame) => fnv(frame.data.subarray(0, fm.topY * frame.width * 4));
  const fomaFrame = (number, extra = {}) => composeSprocketFrame(image, styled('fomapan', { frameNumber: number, ...extra }));
  assert.notEqual(topRail(fomaFrame(51)), topRail(fomaFrame(51, { textEnabled: false })), 'the name is printed after 51');
  assert.equal(topRail(fomaFrame(63)), topRail(fomaFrame(63, { textEnabled: false })), 'nothing of the group is near 63');
  assert.notEqual(topRail(fomaFrame(53)), topRail(fomaFrame(53, { textEnabled: false })), 'the speed is printed after 54');

  // Letters the style has no shape for fall back to the pixel font.
  const cjk = composeSprocketFrame(image, styled('kodakColor', { text: 'KODAK 中文' }));
  assertPhotoRegionMatchesSource(cjk, getSprocketFrameMetrics(1203, 801, styled('kodakColor')), image);
}

// Film strips (contact sheets): several pictures on one continuous film.
{
  const { composeFilmStrip, composeFilmStripAsync, filmStripGeometry, fitPictureInWindow } = await import('./sprocketFrame.js');
  const { applyEdgeMarkingStyle } = await import('./edgeMarkingStyles.js');
  const fnv = (data) => { let h = 2166136261; for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
  const E = DEFAULT_SPROCKET_EDGE_MARKINGS;
  const windowHeight = 120;
  const geometry = filmStripGeometry(6, { windowHeight });
  const picture = (seed, w = geometry.windowWidth, h = geometry.windowHeight) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = (i * 7 + seed * 31) & 255; d[i * 4 + 1] = (i * 3 + seed * 17) & 255; d[i * 4 + 2] = (seed * 50) & 255; d[i * 4 + 3] = 255; }
    return new ImageData(d, w, h);
  };
  const pictures = [1, 2, 3, 4, 5, 6].map((n) => ({ imageData: picture(n), number: n + 9 }));
  const kodak = { edgeMarkings: { ...applyEdgeMarkingStyle(E, 'kodakColor') }, windowHeight };
  const strip = composeFilmStrip(pictures, kodak);
  // Frames eight perforations apart, 2 mm of film between pictures.
  assert.equal(geometry.framePitch, 8 * geometry.pitch);
  assert.equal(strip.windows.length, 6);
  for (let i = 1; i < 6; i++) assert.equal(strip.windows[i].x - strip.windows[i - 1].x, geometry.framePitch);
  assert.ok(Math.abs((geometry.framePitch - geometry.windowWidth) / geometry.pxPerMm - 2) < 0.5, 'a 2 mm gap between frames (the pitch is a whole number of pixels)');
  assert.equal(strip.width, 6 * geometry.framePitch, 'the cuts fall half-way between frames');
  // Each window holds its picture's pixels unchanged.
  strip.windows.forEach((window, i) => {
    const source = pictures[i].imageData;
    for (const [x, y] of [[0, 0], [source.width - 1, 0], [17, 33], [source.width - 1, source.height - 1]]) {
      const a = (y * source.width + x) * 4, b = ((window.y + y) * strip.width + window.x + x) * 4;
      assert.deepEqual(Array.from(strip.data.slice(b, b + 4)), Array.from(source.data.slice(a, a + 4)), `picture ${i} pixel ${x},${y}`);
    }
  });
  // The perforations run on through the gaps: one pitch apart from end to end.
  const holeRow = Math.round(geometry.pxPerMm * 3.4), lefts = [];
  for (let x = 1; x < strip.width; x++) {
    const i = (holeRow * strip.width + x) * 4, j = i - 4;
    if (strip.data[i] > 200 && strip.data[j] <= 200) lefts.push(x);
  }
  assert.ok(lefts.length >= 6 * 8 - 1, `holes along the strip (${lefts.length})`);
  for (let i = 1; i < lefts.length; i++) assert.ok(Math.abs(lefts[i] - lefts[i - 1] - geometry.pitch) <= 1, `hole ${i} keeps the 4.75 mm pitch across frame boundaries`);
  // Each frame carries its own number: changing one frame's number changes the film.
  const renumbered = composeFilmStrip(pictures.map((p, i) => (i === 3 ? { ...p, number: 40 } : p)), kodak);
  assert.notEqual(fnv(renumbered.data), fnv(strip.data));
  // Custom markings number per frame too.
  const custom = { edgeMarkings: { ...E, textEnabled: true, frameNumberEnabled: true, dxEnabled: true }, windowHeight };
  assert.notEqual(fnv(composeFilmStrip(pictures, custom).data), fnv(composeFilmStrip(pictures.map((p, i) => (i === 2 ? { ...p, number: 50 } : p)), custom).data));
  // Pinned, and the same composed in slices.
  const pinnedStrips = {
    kodakStrip: '2e39f3c4',
    customStrip: '05e05db1',
    halfStrip: 'cf909192'
  };
  const half = { ...kodak, halfFrame: true };
  const halfGeometry = filmStripGeometry(5, { windowHeight, halfFrame: true });
  const halfPictures = [1, 2, 3, 4, 5].map((n) => ({ imageData: picture(n, halfGeometry.windowWidth, windowHeight), number: Math.ceil(n / 2) + 9 }));
  const halfStrip = composeFilmStrip(halfPictures, half);
  assert.equal(halfGeometry.framePitch, 4 * halfGeometry.pitch, 'half-frames four perforations apart');
  assert.equal(halfStrip.width, 5 * halfGeometry.framePitch);
  assert.equal(fnv(strip.data), pinnedStrips.kodakStrip, 'kodak strip pinned');
  assert.equal(fnv(composeFilmStrip(pictures, custom).data), pinnedStrips.customStrip, 'custom strip pinned');
  assert.equal(fnv(halfStrip.data), pinnedStrips.halfStrip, 'half-frame strip pinned');
  let pauses = 0;
  const sliced = await composeFilmStripAsync(pictures, kodak, { budgetMs: 0, pause: () => { pauses++; return Promise.resolve(); } });
  assert.equal(fnv(sliced.data), fnv(strip.data), 'sliced and whole agree');
  assert.ok(pauses > 10);
  // Fomapan numbers every four perforations: along a strip the numbers count
  // on along the film from the first picture (two per full frame, one per
  // half-frame), whatever the later pictures' own numbers, and its name,
  // speed and batch number come where the film prints them (every 24 numbers).
  const foma = { edgeMarkings: { ...applyEdgeMarkingStyle(E, 'fomapan') }, windowHeight };
  const fomaPictures = [1, 2, 3, 4, 5, 6].map((n) => ({ imageData: picture(n), number: 2 * n + 22 }));
  const fomaStrip = composeFilmStrip(fomaPictures, foma);
  assert.equal(fnv(composeFilmStrip(fomaPictures.map((p, i) => (i === 3 ? { ...p, number: 7 } : p)), foma).data), fnv(fomaStrip.data), 'the film counts on from the first picture');
  assert.notEqual(fnv(composeFilmStrip(fomaPictures.map((p, i) => (i === 0 ? { ...p, number: 25 } : p)), foma).data), fnv(fomaStrip.data));
  const fomaOff = composeFilmStrip(fomaPictures, { ...foma, edgeMarkings: { ...foma.edgeMarkings, textEnabled: false } });
  assert.notEqual(fnv(fomaOff.data), fnv(fomaStrip.data), 'the strip from 24 carries the group after 27');
  assert.equal(fnv(fomaStrip.data), '971113c5', 'fomapan strip pinned');
  const fomaHalf = composeFilmStrip([1, 2, 3, 4, 5].map((n) => ({ imageData: picture(n, halfGeometry.windowWidth, windowHeight), number: n + 47 })), { ...foma, halfFrame: true });
  assert.equal(fnv(fomaHalf.data), '79a361b8', 'fomapan half-frame strip pinned');
  // AgfaPhoto APX prints its name after odd numbers and its emulsion code
  // after even ones: along a strip each frame by its own number.
  const apx = { edgeMarkings: { ...applyEdgeMarkingStyle(E, 'agfaApx') }, windowHeight };
  const apxStrip = composeFilmStrip(pictures, apx);
  assert.notEqual(fnv(composeFilmStrip(pictures.map((p) => ({ ...p, number: p.number + 1 })), apx).data), fnv(apxStrip.data), 'name and code change places with the numbers');
  assert.equal(fnv(apxStrip.data), '5068ea7e', 'APX strip pinned');
  // A short last strip; a portrait picture turned a quarter clockwise into
  // its window; a square one fitted inside, never stretched.
  assert.deepEqual(fitPictureInWindow(400, 600, 180, 120), { rotate: true, x: 0, y: 0, width: 180, height: 120 });
  assert.deepEqual(fitPictureInWindow(500, 500, 180, 120), { rotate: false, x: 30, y: 0, width: 120, height: 120 });
  assert.deepEqual(fitPictureInWindow(600, 400, 90, 120), { rotate: true, x: 5, y: 0, width: 80, height: 120 }, 'a landscape picture turns into a half-frame window');
  const short = composeFilmStrip([{ imageData: picture(1, 400, 600), number: 36 }, { imageData: null, number: 37 }], kodak);
  assert.equal(short.width, 2 * geometry.framePitch);
  assert.equal(short.windows.length, 1, 'a frame that failed leaves film in its window');
  // A portrait picture's top row becomes its right-hand column (clockwise).
  const portrait = picture(9, 40, 60);
  const turned = composeFilmStrip([{ imageData: portrait, number: 1 }], { ...kodak, windowHeight: 40 });
  assert.equal(turned.windows[0].width, 60);
  const topLeft = Array.from(portrait.data.slice(0, 4));
  const w0 = turned.windows[0], at = ((w0.y) * turned.width + w0.x + w0.width - 1) * 4;
  assert.deepEqual(Array.from(turned.data.slice(at, at + 4)), topLeft, 'turned clockwise');
}

console.log('sprocketFrame.test.mjs passed');
