// Standalone Node test for filmStatsCache.js - run with:
// node negative2positive/src/app/filmStatsCache.test.mjs
import assert from 'node:assert/strict';
import { autoDetectFilmBase } from './filmBaseDetection.js';
import { detectFilmType } from './filmTypeDetection.js';
import {
  cachedAutoDetectFilmBase,
  cachedDetectFilmType,
  primeFilmStats,
  forgetFilmStats,
  hasCachedFilmBase,
  filmStatsCounters
} from './filmStatsCache.js';

function makeNegative(width, height, sixteen) {
  const data = new Uint8ClampedArray(width * height * 4);
  const data16 = sixteen ? new Uint16Array(width * height * 4) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const edge = x < width * 0.08 || x >= width * 0.92 || y < height * 0.08 || y >= height * 0.92;
      const rgb = edge ? [228, 150, 88] : [120 + (x + y) % 60, 70 + (x % 30), 40 + (y % 20)];
      for (let c = 0; c < 3; c++) {
        data[i + c] = rgb[c];
        if (data16) data16[i + c] = rgb[c] * 257 + ((x * 7 + y * 3 + c) % 200);
      }
      data[i + 3] = 255;
      if (data16) data16[i + 3] = 65535;
    }
  }
  const image = { width, height, data };
  if (data16) image.__image16 = { width, height, data: data16 };
  return image;
}

// --- memoised values equal the direct computation, as fresh copies ---------
for (const sixteen of [false, true]) {
  const image = makeNegative(180, 120, sixteen);
  assert.equal(hasCachedFilmBase(image, 10), false);
  const first = cachedAutoDetectFilmBase(image, 10);
  assert.deepEqual(first, autoDetectFilmBase(image, 10));
  assert.equal(hasCachedFilmBase(image, 10), true, 'the first call fills the cache');
  const second = cachedAutoDetectFilmBase(image, 10);
  assert.deepEqual(second, first);
  assert.notEqual(second, first, 'each caller gets its own copy');
  second.r = 1;
  assert.deepEqual(cachedAutoDetectFilmBase(image, 10), first, 'a caller mutating its copy cannot poison the cache');

  // The key is the buffer the detector actually uses.
  assert.equal(hasCachedFilmBase(image, NaN), true, 'NaN falls back to 10');
  assert.equal(hasCachedFilmBase(image, '10'), true);
  assert.equal(hasCachedFilmBase(image, 12), false);
  assert.deepEqual(cachedAutoDetectFilmBase(image, 45), autoDetectFilmBase(image, 30), 'clamped like the detector');
  assert.equal(hasCachedFilmBase(image, 30), true);
  for (const buffer of [0, 0.3, 5, 30]) assert.deepEqual(cachedAutoDetectFilmBase(image, buffer), autoDetectFilmBase(image, buffer));

  const type = cachedDetectFilmType(image);
  assert.deepEqual(type, detectFilmType(image));
  assert.notEqual(cachedDetectFilmType(image), type);
}

// --- another plane on the same object misses --------------------------------
{
  const image = makeNegative(120, 90, true);
  cachedAutoDetectFilmBase(image, 10);
  image.__image16 = makeNegative(120, 90, true).__image16;
  image.__image16.data.fill(30000);
  assert.equal(hasCachedFilmBase(image, 10), false, 're-attached 16-bit plane invalidates the entry');
  assert.deepEqual(cachedAutoDetectFilmBase(image, 10), autoDetectFilmBase(image, 10));
  forgetFilmStats(image);
  assert.equal(hasCachedFilmBase(image, 10), false);
}

// --- primed statistics are used only on an exact key match -------------------
{
  const image = makeNegative(100, 80, true);
  const workerBase = { ...autoDetectFilmBase(image, 10), method: 'from-worker' };
  const workerType = { filmType: 'bw', confidence: 'medium', reason: 'from-worker' };
  primeFilmStats(image, { borderBufferPct: 10, filmBase: workerBase, filmType: workerType });
  assert.equal(cachedAutoDetectFilmBase(image, 10).method, 'from-worker');
  assert.equal(cachedDetectFilmType(image).reason, 'from-worker');
  assert.notEqual(cachedAutoDetectFilmBase(image, 20).method, 'from-worker', 'another buffer computes afresh');
  const other = makeNegative(100, 80, true);
  assert.notEqual(cachedDetectFilmType(other).reason, 'from-worker', 'another ImageData never sees them');
}

// --- import defaults then the Step-2 suggestion: one detection, not two -------
{
  const image = makeNegative(200, 150, true);
  const before = { ...filmStatsCounters };
  cachedDetectFilmType(image);                 // createDefaultSettings: film type
  cachedAutoDetectFilmBase(image, 10);         // createDefaultSettings: film base
  cachedAutoDetectFilmBase(image, 10);         // suggestStep2Mode on the same uncropped plane
  assert.equal(filmStatsCounters.filmBaseComputed - before.filmBaseComputed, 1);
  assert.equal(filmStatsCounters.filmBaseHits - before.filmBaseHits, 1);
  assert.equal(filmStatsCounters.filmTypeComputed - before.filmTypeComputed, 1);

  // A RAW decode whose worker primed the statistics computes nothing here.
  const primed = makeNegative(200, 150, true);
  primeFilmStats(primed, { borderBufferPct: 10, filmBase: autoDetectFilmBase(primed, 10), filmType: detectFilmType(primed) });
  const mark = { ...filmStatsCounters };
  cachedDetectFilmType(primed);
  cachedAutoDetectFilmBase(primed, 10);
  cachedAutoDetectFilmBase(primed, 10);
  assert.equal(filmStatsCounters.filmBaseComputed, mark.filmBaseComputed);
  assert.equal(filmStatsCounters.filmTypeComputed, mark.filmTypeComputed);
}

// --- non-objects pass straight through -------------------------------------
assert.deepEqual(cachedAutoDetectFilmBase(null, 10), autoDetectFilmBase(null, 10));
assert.deepEqual(cachedDetectFilmType(null), detectFilmType(null));

console.log('filmStatsCache.test.mjs passed');
