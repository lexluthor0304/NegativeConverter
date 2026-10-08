// Standalone Node test for thumbnailSources.js (#247) - run with:
// node negative2positive/src/app/thumbnailSources.test.mjs
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const {
  createThumbnailSourceCache, TILE_ANALYSIS_REFERENCE_PIXELS, TILE_SOURCE_MAX_ENTRY_BYTES, TILE_SOURCE_MAX_BYTES
} = await import('./thumbnailSources.js');

function working16(width, height, { seed = 1, transparentCorner = false } = {}) {
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(data16.length);
  let s = seed;
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data16[i + c] = s % 65536; data8[i + c] = data16[i + c] >>> 8; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  if (transparentCorner) for (const p of [0, 1, width]) { data16.fill(0, p * 4, p * 4 + 4); data8[p * 4 + 3] = 255; }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}
function reference(pixels, seed = 9) {
  const width = 128, height = Math.floor(pixels / 128);
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * seed * 2654435761) % 65536;
  for (let i = 3; i < data.length; i += 4) data[i] = i % 17 === 0 ? 0 : 65535;
  return { width, height, data };
}
const keyFor = geometryKey => () => geometryKey;

// Round trip: planes come back exactly, never shared with the stored copy.
{
  const cache = createThumbnailSourceCache();
  const working = working16(288, 192, { transparentCorner: true });
  const ref = reference(TILE_ANALYSIS_REFERENCE_PIXELS);
  assert.equal(cache.put('a', { working, reference: ref, baseSize: { width: 9504, height: 6320 }, geometryKey: 'g1' }), true);
  const bytes = cache.bytes;
  assert.ok(bytes <= TILE_SOURCE_MAX_ENTRY_BYTES, `a 3:2 entry with a reference takes ${bytes} bytes`);
  assert.ok(bytes < 440_000, 'RGB samples and an opacity mask, not RGBA');
  let seen = null;
  const got = cache.lookup('a', size => { seen = size; return 'g1'; });
  assert.deepEqual(seen, { width: 9504, height: 6320 }, 'the key is computed for the stored base size');
  assert.deepEqual(got.baseSize, { width: 9504, height: 6320 });
  assert.deepEqual(got.working.__image16.data, working.__image16.data, '16-bit working plane round-trips, alpha included');
  assert.deepEqual(Array.from(got.working.data.slice(0, 8)), Array.from(working.__image16.data.slice(0, 8), v => v >>> 8));
  assert.deepEqual(got.reference.data, ref.data);
  assert.notEqual(got.working.__image16.data.buffer, working.__image16.data.buffer);
  got.working.__image16.data.fill(7);
  assert.deepEqual(cache.lookup('a', keyFor('g1')).working.__image16.data, working.__image16.data, 'a reader cannot change the entry');
  working.__image16.data.fill(3);
  assert.notEqual(cache.lookup('a', keyFor('g1')).working.__image16.data[0], 3, 'the writer cannot either');
}

// 8-bit frames are kept as they are; odd alpha keeps the plane whole.
{
  const cache = createThumbnailSourceCache();
  const data = Uint8ClampedArray.from({ length: 20 * 10 * 4 }, (_, i) => i % 251);
  cache.put('png', { working: new ImageData(data, 20, 10), baseSize: { width: 200, height: 100 }, geometryKey: 'k' });
  const back = cache.lookup('png', keyFor('k'));
  assert.equal(back.working.__image16, undefined);
  assert.deepEqual(back.working.data, data);
  assert.equal(back.reference, null);
  const odd = working16(4, 4);
  odd.__image16.data[3] = 1234;
  cache.put('odd', { working: odd, baseSize: { width: 8, height: 8 }, geometryKey: 'k' });
  assert.deepEqual(cache.lookup('odd', keyFor('k')).working.__image16.data, odd.__image16.data);
}

// A moved geometry drops the entry: the next decode refills it.
{
  const cache = createThumbnailSourceCache();
  cache.put('a', { working: working16(10, 10), baseSize: { width: 100, height: 100 }, geometryKey: 'before' });
  assert.equal(cache.lookup('a', keyFor('after')), null);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.bytes, 0);
}

// Budget: per entry and in total, least recently used out first.
{
  const square = working16(288, 288);
  const cache = createThumbnailSourceCache();
  assert.equal(cache.put('square', { working: square, reference: reference(TILE_ANALYSIS_REFERENCE_PIXELS), baseSize: { width: 6000, height: 6000 }, geometryKey: 'k' }), true,
    'a 288 px square with its reference fits the 0.6 MB entry budget');
  assert.equal(cache.put('big', { working: working16(400, 300), baseSize: { width: 1, height: 1 }, geometryKey: 'k' }), false, 'larger entries are refused');
  assert.equal(cache.has('big'), false);

  const small = createThumbnailSourceCache({ maxBytes: 3 * 6 * 100 * 100 });
  for (const key of ['a', 'b', 'c']) small.put(key, { working: working16(100, 100), baseSize: { width: 1000, height: 1000 }, geometryKey: 'k' });
  assert.equal(small.size, 3);
  small.lookup('a', keyFor('k'));
  small.put('d', { working: working16(100, 100), baseSize: { width: 1000, height: 1000 }, geometryKey: 'k' });
  assert.deepEqual(['a', 'b', 'c', 'd'].map(key => small.has(key)), [true, false, true, true], 'the least recently used entry goes');
  assert.equal(small.bytes, 3 * 6 * 100 * 100);
  small.retainKeys(['c']);
  assert.deepEqual(['a', 'c', 'd'].map(key => small.has(key)), [false, true, false]);
  assert.equal(small.buffers().length, 1);
  small.clear();
  assert.equal(small.bytes, 0);

  // 151 frames of a 60 MP roll stay inside the total budget.
  const roll = createThumbnailSourceCache();
  const frame = working16(288, 192);
  const ref = reference(TILE_ANALYSIS_REFERENCE_PIXELS);
  for (let i = 0; i < 151; i++) roll.put(i, { working: frame, reference: ref, baseSize: { width: 9504, height: 6320 }, geometryKey: 'k' });
  assert.equal(roll.size, 151);
  assert.ok(roll.bytes <= TILE_SOURCE_MAX_BYTES && roll.bytes / 151 <= TILE_SOURCE_MAX_ENTRY_BYTES, `${roll.bytes} bytes for 151 frames`);
  console.log(`thumbnailSources: ${(roll.bytes / 151 / 1e6).toFixed(3)} MB per 3:2 frame, ${(roll.bytes / 1e6).toFixed(1)} MB for 151`);
}

console.log('thumbnailSources tests passed');
