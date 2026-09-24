// Standalone Node test: a conversion's returned 16-bit plane belongs to the
// caller (#240). A batch export hands that plane to the export worker without
// a copy (the gain-map pass transfers it), which detaches its buffer. The
// adapter's main-thread slots must therefore keep no reference to it: the
// next conversion of the same source, cached or not, has to give the same
// pixels after the previous result was detached. Run with:
// node negative2positive/src/pipeline/planeOwnership.test.mjs
import assert from 'node:assert/strict';
import {
  convertBwWithSilverCore,
  convertColorWithSilverCore,
  convertPositiveWithSilverCore,
  invalidateSilverCoreCache
} from './silverAdapter.js';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const W = 48;
const H = 36;
function negative() {
  const data = Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 255 : 60 + ((i * 53 + (i >>> 5)) % 150)));
  const image = new ImageData(data, W, H);
  // A genuine 16-bit source as the RAW and 16-bit PNG loaders provide.
  image.__image16 = { width: W, height: H, data: Uint16Array.from(data, (v, i) => (i % 4 === 3 ? 65535 : v * 257 + (i % 199))) };
  return image;
}

function detach(result, label) {
  const plane = result.__image16;
  assert.ok(plane && plane.data instanceof Uint16Array && plane.data.length === W * H * 4, `${label}: a 16-bit plane`);
  structuredClone(plane.data.buffer, { transfer: [plane.data.buffer] });
  assert.equal(plane.data.byteLength, 0, `${label}: detached, as a transfer to the worker leaves it`);
}

const cases = [
  ['colour with film-base compensation', convertColorWithSilverCore, { filmBase: { r: 210, g: 140, b: 90 }, colorModel: 'standard' }],
  ['colour without film base', convertColorWithSilverCore, { colorModel: 'standard' }],
  ['black and white', convertBwWithSilverCore, { filmBase: { r: 200, g: 200, b: 200 } }],
  ['positive', convertPositiveWithSilverCore, {}]
];

for (const [label, convert, settings] of cases) {
  for (const withReference of [false, true]) {
    invalidateSilverCoreCache();
    const source = negative();
    // The batch passes an analysis sample next to the frame.
    const options = withReference ? { analysisImageData: negative().__image16 } : {};
    const name = `${label}${withReference ? ' (analysis sample)' : ''}`;
    const first = await convert(source, settings, { ...options, forceFullProcess: true });
    const expected = first.__image16.data.slice();
    detach(first, name);
    assert.equal(source.__image16.data.length, W * H * 4, `${name}: the source plane is not the returned one`);
    assert.ok(!options.analysisImageData || options.analysisImageData.data.length === W * H * 4, `${name}: nor is the analysis sample`);
    // Batch conversions always force a full process; the interactive path
    // reuses the cached analysis and pristine buffer.
    const again = await convert(source, settings, { ...options, forceFullProcess: true });
    assert.deepEqual(again.__image16.data, expected, `${name}: a full reprocess is unaffected`);
    detach(again, name);
    const cached = await convert(source, settings, options);
    assert.deepEqual(cached.__image16.data, expected, `${name}: the cached path is unaffected`);
  }
}

console.log('planeOwnership.test.mjs passed: conversion slots keep no reference to a returned plane');
