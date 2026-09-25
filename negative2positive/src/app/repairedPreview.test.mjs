import assert from 'node:assert/strict';
import { poolRepairMask } from './repairedPreview.js';
import { resizeDisplayPreview } from './displayPreview.js';

globalThis.ImageData ||= class {
  constructor(data, width, height) {
    if (typeof data === 'number') [data, width, height] = [new Uint8ClampedArray(data * width * 4), data, width];
    Object.assign(this, { data, width, height });
  }
};

// Every target pixel whose bilinear resample reads a set source pixel must be
// marked: resample a one-pixel "speck" image and check that each target pixel
// it reaches is covered by the pooled mask.
function reached(width, height, targetWidth, targetHeight, x, y) {
  const image = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  image.data[(y * width + x) * 4] = 255;
  const small = resizeDisplayPreview(image, { width: targetWidth, height: targetHeight });
  const hits = [];
  for (let i = 0; i < targetWidth * targetHeight; i++) if (small.data[i * 4]) hits.push(i);
  return hits;
}

for (const [width, height, targetWidth, targetHeight] of [[97, 61, 23, 15], [640, 480, 181, 136], [50, 40, 50, 40], [30, 20, 29, 19]]) {
  for (const [x, y] of [[0, 0], [width - 1, height - 1], [Math.floor(width / 3), Math.floor(height / 2)], [7, 11]]) {
    const mask = new Uint8Array(width * height);
    mask[y * width + x] = 255;
    const out = new Uint8Array(targetWidth * targetHeight);
    assert.equal(poolRepairMask(mask, width, height, out, targetWidth, targetHeight), true);
    for (const hit of reached(width, height, targetWidth, targetHeight, x, y)) {
      assert.equal(out[hit], 255, `target ${hit} reads speck ${x},${y} of ${width}x${height} -> ${targetWidth}x${targetHeight}`);
    }
    // Local: nothing further than one target cell from the speck.
    const cx = Math.floor((x + 0.5) * targetWidth / width), cy = Math.floor((y + 0.5) * targetHeight / height);
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      const tx = i % targetWidth, ty = Math.floor(i / targetWidth);
      assert.ok(Math.abs(tx - cx) <= 1 && Math.abs(ty - cy) <= 1, 'marks stay next to the speck');
    }
  }
}

// Bounds limit the scan; the word scan and the byte scan agree; an empty
// mask marks nothing; masks accumulate into one raster.
{
  const width = 403, height = 211, targetWidth = 97, targetHeight = 51;
  const mask = new Uint8Array(width * height);
  for (const [x, y] of [[3, 4], [400, 200], [201, 100], [202, 100], [17, 190]]) mask[y * width + x] = 255;
  const words = new Uint8Array(targetWidth * targetHeight);
  const bytes = new Uint8Array(targetWidth * targetHeight);
  poolRepairMask(mask, width, height, words, targetWidth, targetHeight);
  poolRepairMask(mask, width, height, bytes, targetWidth, targetHeight, { x: 0, y: 0, width, height });
  assert.deepEqual(words, bytes);
  const inside = new Uint8Array(targetWidth * targetHeight);
  poolRepairMask(mask, width, height, inside, targetWidth, targetHeight, { x: 190, y: 90, width: 20, height: 20 });
  const expected = new Uint8Array(targetWidth * targetHeight);
  const only = new Uint8Array(width * height);
  only[100 * width + 201] = only[100 * width + 202] = 255;
  poolRepairMask(only, width, height, expected, targetWidth, targetHeight);
  assert.deepEqual(inside, expected, 'bounds keep the scan to their rectangle');
  const empty = new Uint8Array(targetWidth * targetHeight);
  assert.equal(poolRepairMask(new Uint8Array(width * height), width, height, empty, targetWidth, targetHeight), false);
  assert.ok(empty.every(value => value === 0));
  // An unaligned view takes the byte scan.
  const padded = new Uint8Array(width * height + 1);
  padded.set(mask, 1);
  const shifted = new Uint8Array(targetWidth * targetHeight);
  poolRepairMask(padded.subarray(1), width, height, shifted, targetWidth, targetHeight);
  assert.deepEqual(shifted, words);
}

console.log('repairedPreview: pooled repair masks cover every resampled speck, stay local, honour bounds and agree across scans');
