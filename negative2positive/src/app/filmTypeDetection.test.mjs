import assert from 'node:assert/strict';
import { detectFilmType, detectedImportSettings, detectionBlockSize } from './filmTypeDetection.js';
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
assert.equal(detectFilmType(mono).filmType, 'bw', 'rebate-less monochrome defaults to an inverted B&W negative');
assert.equal(detectFilmType(mono, { fallback: 'color' }).filmType, 'bw', 'the monochrome verdict ignores the fallback');
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
  assert.equal(detectFilmType(tinted).filmType, 'bw');
}
const mutedColor = fixture((x, y) => x < 80 ? [110, 115, 120] : [120, 115, 110]);
assert.notEqual(detectFilmType(mutedColor).filmType, 'bw', 'muted colour alone is not negative evidence');

const clippedColorBorder = fixture((x, y) => x < 30 || x >= 130 ? [255, 255, 255] : orange(x, y));
assert.equal(detectFilmType(clippedColorBorder).filmType, 'color', 'clipped margins must not dilute existing orange-mask evidence');

// Block size follows the short side: 4 at 60 MP (6336 px), 3 at 24 MP, and
// unchanged single pixels on preview planes and the fixtures above.
assert.equal(detectionBlockSize(9536, 6336), 4);
assert.equal(detectionBlockSize(6000, 4000), 3);
assert.equal(detectionBlockSize(2448, 1630), 1);
assert.equal(detectionBlockSize(1803, 1202), 1);
assert.equal(detectionBlockSize(160, 120), 1);
assert.equal(detectionBlockSize(20000, 15000), 8, 'automatic size is capped');
assert.equal(detectionBlockSize(160, 120, 4), 4, 'tests and callers can force the size');
assert.equal(detectionBlockSize(160, 120, 0), 1);

// Seeded grain: ±3 % of full scale, independent per channel, as demosaiced
// grain of a neutral negative. Single pixels fail the grey tests; block means
// recover the neutral frame without making a colour image grey.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noisy(pixel, { width = 160, height = 120, sixteen = false, seed = 231 } = {}) {
  const random = seeded(seed), maximum = sixteen ? 65535 : 255;
  const data = sixteen ? new Uint16Array(width * height * 4) : new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = pixel(x, y).map(v => Math.round(Math.max(0, Math.min(maximum, v / 255 * maximum + (random() * 2 - 1) * .03 * maximum))));
    data.set([...rgb, maximum], (y * width + x) * 4);
  }
  return { width, height, data };
}
const neutralRamp = (x, y) => { const v = 40 + (x + y) % 160; return [v, v, v]; };
const colourScene = (x, y) => x < 60 ? [70, 130, 190] : y < 70 ? [40, 150, 50] : [160, 100, 60];
for (const sixteen of [false, true]) {
  const grain = noisy(neutralRamp, { sixteen });
  assert.notEqual(detectFilmType(grain).reason, 'monochrome', 'single noisy pixels hide the neutral frame (the #231 failure)');
  assert.deepEqual(detectFilmType(grain, { blockSize: 4 }), { filmType: 'bw', confidence: 'low', reason: 'monochrome' });
  assert.notEqual(detectFilmType(noisy(colourScene, { sixteen }), { blockSize: 4 }).filmType, 'bw', 'noisy colour positive is not monochrome');
  // Larger than 24 k samples: the stride exceeds one and each box is sparse.
  const large = noisy(neutralRamp, { width: 640, height: 480, sixteen, seed: 7 });
  assert.deepEqual(detectFilmType(large, { blockSize: 4 }), { filmType: 'bw', confidence: 'low', reason: 'monochrome' });
  assert.notEqual(detectFilmType(noisy(colourScene, { width: 640, height: 480, sixteen, seed: 7 }), { blockSize: 4 }).filmType, 'bw');
}
for (const [name, image] of Object.entries({ mutedColor, warmSubject, warmWithNeutrals, positive, croppedNegative })) {
  for (const blockSize of [4, 8]) {
    const verdict = detectFilmType(image, { blockSize });
    if (name === 'croppedNegative') assert.equal(verdict.filmType, 'color', `${name} at ${blockSize} px`);
    else assert.notEqual(verdict.filmType, 'bw', `${name} stays non-B&W at ${blockSize} px blocks`);
  }
}
// Transparent pixels never enter a block mean.
const holed = fixture(orange);
for (let i = 0; i < holed.data.length; i += 8) holed.data[i + 3] = 0;
assert.equal(detectFilmType(holed, { blockSize: 4 }).filmType, 'color');

// Parity: with 1 px blocks the classifier matches HEAD's single-pixel
// detector on every fixture; the only intended difference is the monochrome
// verdict, which HEAD returned with the positive fallback.
function referenceDetectFilmType(image, { fallback = 'positive', filmEdge = null } = {}) {
  if (filmEdge?.found && ['color', 'bw', 'positive'].includes(filmEdge.filmKind)
      && !(filmEdge.polarity === 'light' && filmEdge.filmKind !== 'positive')) {
    return { filmType: filmEdge.filmKind, confidence: 'high', reason: 'dx' };
  }
  const source = image?.__image16 || image;
  if (!source?.data || !source.width || !source.height) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const { width, height, data } = source;
  const maximum = data instanceof Uint16Array ? 65535 : 255;
  const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 24000)));
  const all = [], inner = [], edge = [], sides = [[], [], [], []];
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    const i = (y * width + x) * 4;
    if (!data[i + 3]) continue;
    const r = data[i] / maximum, g = data[i + 1] / maximum, b = data[i + 2] / maximum;
    const peak = Math.max(r, g, b), low = Math.min(r, g, b);
    if (peak < .02) continue;
    const pixel = { r, g, b, luma: .2126 * r + .7152 * g + .0722 * b,
      gray: peak - low < .035,
      maskRed: r > g * 1.15 && r > b * 1.15,
      orange: r > g * 1.18 && g > b * 1.18 && r - b > .16 };
    if (x < width * .015) sides[0].push(pixel);
    if (x >= width * .985) sides[1].push(pixel);
    if (y < height * .015) sides[2].push(pixel);
    if (y >= height * .985) sides[3].push(pixel);
    if (low > .98) continue;
    all.push(pixel);
    if (x < width * .05 || x >= width * .95 || y < height * .05 || y >= height * .95) edge.push(pixel);
    else inner.push(pixel);
  }
  if (all.length < 64) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const fraction = (pixels, key) => pixels.filter(p => p[key]).length / Math.max(1, pixels.length);
  const quantile = (pixels, key, q) => {
    const values = pixels.map(p => p[key]).sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * q)] ?? 0;
  };
  const edgeRange = quantile(edge, 'luma', .9) - quantile(edge, 'luma', .1);
  const edgeLuma = quantile(edge, 'luma', .5), innerLuma = quantile(inner, 'luma', .5);
  const orangeFraction = fraction(all, 'orange');
  if (edge.length >= 32 && fraction(edge, 'orange') > .85 && edgeRange < .14
      && edgeLuma > innerLuma + .07 && orangeFraction > .35) {
    return { filmType: 'color', confidence: 'high', reason: 'orangeRebate' };
  }
  const coherentMask = orangeFraction > .5 && fraction(all, 'maskRed') > .95;
  if ((orangeFraction > .72 || coherentMask)
      && quantile(all, 'r', .1) > quantile(all, 'b', .9) * .9) {
    return { filmType: 'color', confidence: 'medium', reason: 'orangeMask' };
  }
  const medians = ['r', 'g', 'b'].map(key => quantile(all, key, .5));
  const balance = Math.max(...medians) / Math.max(.02, Math.min(...medians));
  const coherentGray = balance < 1.6 && all.filter(p => {
    const channels = [p.r, p.g, p.b].map((v, i) => v / Math.max(.02, medians[i]));
    return Math.max(...channels) - Math.min(...channels) < .055;
  }).length / all.length > .96;
  if (fraction(all, 'gray') > .96 || coherentGray) {
    const clearSides = sides.map(pixels => pixels.length >= 16
      && quantile(pixels, 'luma', .8) - quantile(pixels, 'luma', .2) < .08
      && quantile(pixels, 'luma', .5) > .55
      && quantile(pixels, 'luma', .5) > innerLuma + .22);
    if ((clearSides[0] && clearSides[1]) || (clearSides[2] && clearSides[3])) {
      return { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' };
    }
    return { filmType: fallback, confidence: 'low', reason: 'monochrome' };
  }
  if (orangeFraction > .35) return { filmType: fallback, confidence: 'low', reason: 'warmScene' };
  return { filmType: 'positive', confidence: 'medium', reason: 'noMask' };
}
const parityImages = [croppedNegative, warmSubject, warmWithNeutrals, negative, positive, mono, bw, white, black, transparent,
  mutedColor, clippedColorBorder, holed, fixture(orange, true), noisy(neutralRamp), noisy(colourScene), noisy(neutralRamp, { width: 640, height: 480, sixteen: true }),
  noisy((x, y) => x < 3 || x >= 157 ? [240, 240, 240] : neutralRamp(x, y)), noisy(orange, { width: 700, height: 500, seed: 3 })];
let monochromeChanges = 0;
for (const image of parityImages) {
  for (const fallback of ['positive', 'color']) {
    const reference = referenceDetectFilmType(image, { fallback });
    const actual = detectFilmType(image, { fallback, blockSize: 1 });
    if (reference.reason === 'monochrome') { monochromeChanges++; assert.deepEqual(actual, { ...reference, filmType: 'bw' }); }
    else assert.deepEqual(actual, reference);
  }
}
assert.ok(monochromeChanges > 0, 'parity set includes the flagged monochrome change');
console.log('filmTypeDetection: block means, noisy neutral/colour fixtures and single-pixel parity passed');
