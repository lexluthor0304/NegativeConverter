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
