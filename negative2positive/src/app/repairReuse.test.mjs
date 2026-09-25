import assert from 'node:assert/strict';
import {
  repairRecipesMatch, createRepairStamps, sameRepairStrokes, captureDustPass, dustPassMatches, restoreDustPass
} from './repairReuse.js';

globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

// Recipes compare identities; an empty dust mask accepts either inpainter.
{
  const recipe = { source: {}, token: 1, dustEnabled: true, dustMask: new Uint8Array(1), strokes: [],
    lensMapping: null, revision: 3, dustUsedAi: true };
  assert.ok(repairRecipesMatch(recipe, { ...recipe }));
  for (const [key, value] of [['source', {}], ['token', 2], ['strokes', []], ['lensMapping', {}],
    ['revision', 4], ['dustEnabled', false], ['dustMask', new Uint8Array(1)], ['dustUsedAi', false]]) {
    assert.equal(repairRecipesMatch(recipe, { ...recipe, [key]: value }), false, key);
  }
  assert.ok(repairRecipesMatch({ ...recipe, dustUsedAi: null }, { ...recipe, dustUsedAi: false }));
  const off = { ...recipe, dustEnabled: false, dustMask: null };
  assert.ok(repairRecipesMatch(off, { ...off, dustMask: new Uint8Array(1), dustUsedAi: false }), 'dust off ignores the unused mask');
  const stamps = createRepairStamps();
  const result = {};
  assert.equal(stamps.matches(result, recipe), false, 'an unstamped result never matches');
  stamps.stamp(result, recipe);
  assert.equal(stamps.recipeOf(result), recipe);
  assert.ok(stamps.matches(result, { ...recipe }));
}

// Stroke lists compare by what they select.
{
  const strokes = [{ size: 0.02, points: [{ x: 0.1, y: 0.2, p: 1 }, { x: 0.3, y: 0.2, p: 0.5 }] }];
  assert.ok(sameRepairStrokes(strokes, structuredClone(strokes)));
  assert.ok(sameRepairStrokes([{ size: 0.02, points: [{ x: 0.1, y: 0.2 }] }], [{ size: 0.02, points: [{ x: 0.1, y: 0.2, p: 1 }] }]));
  assert.equal(sameRepairStrokes(strokes, [{ ...strokes[0], size: 0.03 }]), false);
  assert.equal(sameRepairStrokes(strokes, [{ ...strokes[0], points: strokes[0].points.slice(1) }]), false);
  assert.equal(sameRepairStrokes(strokes, [...strokes, ...strokes]), false);
  assert.equal(sameRepairStrokes(strokes, null), false);
}

// Dust-pass blocks: capture, match and restore, 8 and 16 bits, edge blocks.
{
  const width = 130, height = 70;
  const source = new ImageData(Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i & 255), width, height);
  source.__image16 = { width, height, data: Uint16Array.from({ length: width * height * 4 }, (_, i) => (i * 31) & 0xffff) };
  const result = new ImageData(new Uint8ClampedArray(source.data), width, height);
  result.__image16 = { width, height, data: new Uint16Array(source.__image16.data) };
  for (const [x, y] of [[3, 4], [129, 69], [70, 10]]) {
    result.data[(y * width + x) * 4 + 1] = 7;
    result.__image16.data[(y * width + x) * 4 + 2] = 9;
  }
  const blocks = { size: 64, columns: 3, keys: [0, 5, 1] };
  const key = { source, maskHash: 'h', usedAi: true, revision: 2 };
  const entry = captureDustPass(result, { ...key, blocks });
  assert.equal(entry.blocks.length, 3);
  assert.deepEqual(entry.blocks.map(({ x, y, w, h }) => [x, y, w, h]), [[0, 0, 64, 64], [128, 64, 2, 6], [64, 0, 64, 64]]);
  assert.ok(dustPassMatches(entry, key));
  for (const change of [{ source: {} }, { maskHash: 'g' }, { maskHash: undefined }, { usedAi: false }, { revision: 3 }]) {
    assert.equal(dustPassMatches(entry, { ...key, ...change }), false, JSON.stringify(Object.keys(change)));
  }
  const restored = await restoreDustPass(entry, source, { chunkBytes: 1000 });
  assert.deepEqual(restored.data, result.data);
  assert.deepEqual(restored.__image16.data, result.__image16.data);
  const eightBit = new ImageData(new Uint8ClampedArray(source.data), width, height);
  assert.equal(await restoreDustPass(entry, eightBit), null, 'a source without the 16-bit plane cannot be rebuilt');
  assert.equal(captureDustPass(result, { ...key, blocks, maxBytes: 64 * 64 * 12 * 2 }), null, 'over the cap nothing is kept');
  assert.equal(captureDustPass(result, { ...key, blocks: null }), null);
  assert.equal(captureDustPass(result, { ...key, maskHash: null, blocks }), null);
}

console.log('repairReuse: recipes, stroke comparison and dust-pass blocks');
