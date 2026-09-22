import assert from 'node:assert/strict';
import { composeSprocketFrame } from './sprocketFrame.js';
import { createSprocketFrameCache } from './sprocketFrameCache.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const compose = createSprocketFrameCache();
for (const [width, height] of [[72, 48], [48, 72], [50, 50]]) {
  const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 37) % 256);
  const source = new ImageData(data, width, height);
  for (const options of [{}, { transparentHoles: true }, { filmColor: '#abcdef', edgeMarkings: { dxEnabled: true, dx1: 24, dx2: 3, frameNumberEnabled: true, frameNumber: 7 } },
    { edgeMarkings: { overexposedSprockets: true } }]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const expected = composeSprocketFrame(source, options);
      const actual = compose(source, options);
      assert.deepEqual(actual, expected, 'cached landscape/portrait preserves every border/photo/alpha pixel');
      actual.data.fill(0); // A previous output must not mutate cached border strips.
      source.data[0] ^= 127; // Same source identity, updated photo content.
    }
  }
}
assert.ok(compose.bytes < 128 * 1024 * 1024);
compose.clear(); assert.equal(compose.bytes, 0);
const uncached = createSprocketFrameCache(1);
const source = new ImageData(new Uint8ClampedArray(24), 3, 2);
assert.deepEqual(uncached(source), composeSprocketFrame(source));
assert.equal(uncached.bytes, 0);
console.log('Sprocket display cache: exact landscape/portrait/alpha pixels, invalidation, ownership and byte cap passed');
