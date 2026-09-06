// Standalone Node test for aiInpaint.js (tiling, feathering, blending) - run with:
// node negative2positive/src/app/aiInpaint.test.mjs

import assert from 'node:assert/strict';
import { maskBoundingBoxes, tilesForBox, uniqueTiles, extractTile, featherWeights, inpaintWithModel, maskBounds } from './aiInpaint.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
}

function image(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const [r, g, b] = fill(x, y);
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  const img = new ImageData(data, width, height);
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) plane[i] = data[i] * 257;
  img.__image16 = { width, height, data: plane };
  return img;
}
const disc = (mask, width, cx, cy, r) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (Math.hypot(x - cx, y - cy) <= r) mask[y * width + x] = 255; };

// Boxes: two far-apart specks get two boxes with context; touching cells merge.
{
  const W = 2000; const H = 1500;
  const mask = new Uint8Array(W * H);
  disc(mask, W, 300, 300, 6);
  disc(mask, W, 1700, 1200, 10);
  disc(mask, W, 1760, 1210, 4);
  const boxes = maskBoundingBoxes(mask, W, H);
  assert.equal(boxes.length, 2, 'two clusters');
  assert.ok(boxes[0].x <= 300 - 64 - 6 + 64 && boxes[0].x + boxes[0].width >= 306, 'box covers the speck with context');
  assert.deepEqual(maskBounds(mask, W, H), { x: 294, y: 294, width: 1764 - 294 + 1, height: 1214 - 294 + 1 });
  assert.equal(maskBoundingBoxes(new Uint8Array(W * H), W, H).length, 0);
}

// Tiles: a box inside a large image gets 512-px windows that stay inside the image.
{
  const W = 3000; const H = 2000;
  const tiles = tilesForBox({ x: 2900, y: 1900, width: 80, height: 80 }, W, H);
  assert.equal(tiles.length, 1);
  assert.deepEqual(tiles[0], { x: W - 512, y: H - 512, size: 512 });
  const wide = tilesForBox({ x: 100, y: 100, width: 1200, height: 300 }, W, H);
  assert.ok(wide.length >= 3, `a 1200-px box needs several tiles (${wide.length})`);
  for (const t of wide) { assert.ok(t.x >= 0 && t.x + 512 <= W && t.y >= 0 && t.y + 512 <= H); }
  const last = wide.at(-1);
  assert.ok(last.x + 512 >= 1300 + 32 || last.x === W - 512, 'tiles cover the box and its overlap');
  // Small images: one window at the origin, padded by extractTile.
  assert.deepEqual(tilesForBox({ x: 10, y: 10, width: 50, height: 50 }, 300, 200), [{ x: 0, y: 0, size: 512 }]);
  assert.equal(uniqueTiles([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }]).length, 2);
}

// extractTile pads with edge pixels and carries the mask; featherWeights fades out over 4 px.
{
  const img = image(300, 200, (x, y) => [x % 256, y % 256, 128]);
  const mask = new Uint8Array(300 * 200);
  disc(mask, 300, 150, 100, 5);
  const tile = { x: 0, y: 0, size: 512 };
  const { image: nchw, mask: maskTile } = extractTile(img, mask, tile);
  assert.equal(nchw.length, 3 * 512 * 512);
  assert.ok(Math.abs(nchw[10 * 512 + 20] - 20 / 255) < 1e-6, 'R channel at (20,10)');
  assert.ok(Math.abs(nchw[512 * 512 + 10 * 512 + 20] - 10 / 255) < 1e-6, 'G channel at (20,10)');
  assert.ok(Math.abs(nchw[400 * 512 + 400] - (299 % 256) / 255) < 1e-6, 'outside the image: edge pixel replicated');
  assert.equal(maskTile[100 * 512 + 150], 1);
  assert.equal(maskTile[400 * 512 + 400], 0, 'padding is never masked');
  const weights = featherWeights(maskTile, 512, 4);
  assert.equal(weights[100 * 512 + 150], 1);
  const ring1 = weights[100 * 512 + 156]; const ring3 = weights[100 * 512 + 158]; const far = weights[100 * 512 + 165];
  assert.ok(ring1 > ring3 && ring3 > 0 && far === 0, `feather fades: ${ring1} > ${ring3} > 0, far ${far}`);
}

// A fake model that paints the whole tile grey: only the mask (plus its
// feather) may change, in 8 and 16 bits; everything else keeps the original.
{
  const W = 900; const H = 700;
  const img = image(W, H, (x, y) => [(x * 3) % 256, (y * 2) % 256, 90]);
  const mask = new Uint8Array(W * H);
  disc(mask, W, 120, 120, 8);
  disc(mask, W, 800, 600, 12);
  const calls = [];
  const run = async (input, maskTile, size) => {
    calls.push(size);
    return new Float32Array(input.length).fill(0.6);
  };
  const { imageData: result, tiles } = await inpaintWithModel(img, mask, run);
  assert.equal(tiles, calls.length);
  assert.ok(tiles >= 2 && tiles <= 4, `two specks need a couple of tiles (${tiles})`);
  const at = (x, y) => { const o = (y * W + x) * 4; return [result.data[o], result.data[o + 1], result.data[o + 2]]; };
  assert.deepEqual(at(120, 120), [153, 153, 153], 'mask centre takes the model fill');
  assert.deepEqual(at(800, 600), [153, 153, 153]);
  assert.deepEqual(at(400, 300), [(400 * 3) % 256, (300 * 2) % 256, 90], 'unmasked pixels are untouched');
  assert.deepEqual(at(120, 140), [(120 * 3) % 256, (140 * 2) % 256, 90], 'beyond the feather nothing changes');
  const [rEdge] = at(129, 120); // 1 px outside the disc: blended
  assert.ok(rEdge > (129 * 3) % 256 && rEdge < 153, `feathered pixel is a blend (${rEdge})`);
  assert.equal(result.__image16.data[(120 * W + 120) * 4], Math.round(0.6 * 65535), '16-bit plane follows');
  assert.equal(img.data[(120 * W + 120) * 4], (120 * 3) % 256, 'the input is not modified');
  // A 0..255-scale model output is detected and handled the same way.
  const run255 = async (input, maskTile, size) => { const out = await run(input, maskTile, size); for (let i = 0; i < out.length; i++) out[i] *= 255; return out; };
  const { imageData: result255 } = await inpaintWithModel(img, mask, run255);
  assert.deepEqual([result255.data[(120 * W + 120) * 4]], [153]);
  // Progress reports every tile.
  const progress = [];
  await inpaintWithModel(img, mask, run, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
}

console.log('aiInpaint.test.mjs passed');
