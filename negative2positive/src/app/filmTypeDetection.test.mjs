import assert from 'node:assert/strict';
import { detectFilmType, detectedImportSettings } from './filmTypeDetection.js';
function fixture(pixel, sixteen = false) {
  const width = 160, height = 120;
  const data = sixteen ? new Uint16Array(width * height * 4) : new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = pixel(x, y, x < 8 || x >= 152 || y < 6 || y >= 114);
    data.set([...rgb, 255].map(value => value * (sixteen ? 257 : 1)), (y * width + x) * 4);
  }
  return { width, height, data };
}
const orange = (x, y) => { const t = (x + y) % 70; return [130 + t, 60 + t * .6, 25 + t * .25]; };
const croppedNegative = fixture(orange);
assert.equal(detectFilmType(croppedNegative).filmType, 'color', 'orange-mask scan needs no border');
assert.equal(detectFilmType(croppedNegative).confidence, 'medium', 'warm scenes can resemble mask; do not claim certainty');
// Borderless negative with magenta subject regions, as in the L1009967 DNG:
// the orange-only threshold misses it, but the mask covers every region.
for (const sixteen of [false, true]) {
  for (const orangeWidth of [88, 104, 112]) {
    const mixedMask = fixture((x, y) => {
      const t = (x + y) % 40;
      return x < orangeWidth ? [180 + t, 90 + t * .6, 45 + t * .5] : [150 + t, 70 + t * .4, 105 + t * .3];
    }, sixteen);
    assert.deepEqual(detectFilmType(mixedMask), { filmType: 'color', confidence: 'medium', reason: 'orangeMask' });
    assert.equal(detectedImportSettings(mixedMask, { automatic: false, filmType: 'positive' }).filmType, 'positive');
  }
}
const warmSubject = fixture((x, y) => x < 108 ? orange(x, y) : [55, 115, 170]);
assert.equal(detectFilmType(warmSubject).filmType, 'positive', 'orange subject with blue sky has no global mask');
const warmWithNeutrals = fixture((x, y) => x < 108 ? orange(x, y) : [100, 102, 99]);
assert.equal(detectFilmType(warmWithNeutrals).filmType, 'positive', 'neutral regions contradict a global orange mask');
const negative = fixture((x, y, edge) => edge ? [230, 160, 85] : orange(x, y));
assert.equal(detectFilmType(negative).filmType, 'color');
assert.equal(detectFilmType(negative).confidence, 'high');
const positive = fixture((x, y) => x < 60 ? [70, 130, 190] : y < 70 ? [40, 150, 50] : [160, 100, 60]);
assert.equal(detectFilmType(positive).filmType, 'positive', 'ordinary borderless colour image remains positive');
const mono = fixture((x, y) => { const v = 40 + (x + y) % 160; return [v, v, v]; });
assert.equal(detectFilmType(mono).reason, 'monochrome');
assert.equal(detectFilmType(mono).confidence, 'low', 'cropped grayscale has no reliable polarity evidence');
const bw = fixture((x, y, edge) => { const v = edge ? 230 : 30 + (x + y) % 100; return [v, v, v]; });
assert.equal(detectFilmType(bw).filmType, 'bw');
const white = fixture(() => [255, 255, 255]);
assert.equal(detectFilmType(white).confidence, 'low');
const black = fixture(() => [0, 0, 0]);
assert.equal(detectFilmType(black).confidence, 'low');
const transparent = fixture(orange); transparent.data.fill(0);
assert.equal(detectFilmType(transparent).confidence, 'low');
assert.equal(detectFilmType(fixture(orange, true)).filmType, 'color', '16-bit decode follows the same classifier');
assert.equal(detectFilmType(positive, { filmEdge: { found: true, filmKind: 'bw', polarity: 'dark' } }).filmType, 'bw');
assert.notEqual(detectFilmType(positive, { filmEdge: { found: true, filmKind: 'color', polarity: 'light' } }).filmType, 'color', 'contradictory DX evidence is rejected');
assert.equal(detectedImportSettings(positive, { automatic: false, filmType: 'bw' }).filmType, 'bw', 'manual import setting wins');
assert.equal(detectedImportSettings(positive, { filmType: 'color' }).filmType, 'positive', 'mixed imports do not inherit preceding negative type');
assert.equal(detectedImportSettings(croppedNegative, { filmType: 'positive' }).filmType, 'color');
console.log('filmTypeDetection: borderless/bordered scans, ambiguity, DX, precision and manual import passed');

for (const sixteen of [false, true]) {
  for (const base of [230, 255]) {
    const scan = fixture((x, y) => {
      const v = x < 3 || x >= 157 ? base : 30 + (x + y) % 100;
      return [v, v * .91, v * .84];
    }, sixteen);
    assert.deepEqual(detectFilmType(scan), { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' }, 'tinted black-and-white with only two thin rebates');
  }
  const clipped = fixture((x, y, edge) => { const v = edge ? 255 : 30 + (x + y) % 100; return [v, v, v]; }, sixteen);
  assert.equal(detectFilmType(clipped).filmType, 'bw', 'clipped clear film must not discard rebate evidence');
  const tinted = fixture((x, y) => { const v = 40 + (x + y) % 160; return [v, v * .91, v * .84]; }, sixteen);
  assert.equal(detectFilmType(tinted).reason, 'monochrome', 'borderless tinted monochrome keeps uncertain polarity');
  assert.equal(detectFilmType(tinted).confidence, 'low');
}
const mutedColor = fixture((x, y) => x < 80 ? [110, 115, 120] : [120, 115, 110]);
assert.notEqual(detectFilmType(mutedColor).filmType, 'bw', 'muted colour alone is not negative evidence');

const clippedColorBorder = fixture((x, y) => x < 30 || x >= 130 ? [255, 255, 255] : orange(x, y));
assert.equal(detectFilmType(clippedColorBorder).filmType, 'color', 'clipped margins must not dilute existing orange-mask evidence');
