// Standalone Node test for aiInpaint.js (tiling, feathering, blending) - run with:
// node negative2positive/src/app/aiInpaint.test.mjs

import assert from 'node:assert/strict';
import { maskBoundingBoxes, tilesForBox, uniqueTiles, extractTile, featherWeights, inpaintWithModel, maskBounds, planInpaint, MOSAIC_CONTEXT } from './aiInpaint.js';

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
  assert.equal(tiles, 1, 'two small specks share one input');
  const tiled = await inpaintWithModel(img, mask, run, { mosaic: false });
  assert.ok(tiled.tiles >= 2 && tiled.tiles <= 4, `on tiles alone they need a couple (${tiled.tiles})`);
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

// Mosaics: small clusters share one input, each in a window of its own with
// picture around it; only a cluster too large for a window keeps its tiles.
{
  const W = 3000; const H = 2000;
  const specks = [];
  for (let i = 0; i < 21; i++) specks.push({ x: 150 + (i % 7) * 400, y: 200 + ((i / 7) | 0) * 700, r: 3 + (i % 5) * 4 });
  const maskOf = (list) => { const mask = new Uint8Array(W * H); for (const { x, y, r } of list) disc(mask, W, x, y, r); return mask; };
  const covers = (windows) => {
    const seen = new Uint8Array(512 * 512);
    for (const win of windows) {
      assert.ok(win.x >= 0 && win.y >= 0 && win.x + win.size <= W && win.y + win.size <= H, 'a window lies inside the frame');
      for (let y = 0; y < win.size; y++) for (let x = 0; x < win.size; x++) seen[(win.at.y + y) * 512 + win.at.x + x]++;
    }
    return seen.every((count) => count === 1);
  };
  // Sixteen small specks: one input of sixteen 128 px windows.
  let plan = planInpaint(maskOf(specks.slice(0, 16)), W, H);
  assert.deepEqual([plan.canvases.length, plan.tiles.length], [1, 0]);
  assert.equal(plan.canvases[0].length, 16);
  assert.ok(plan.canvases[0].every((win) => win.size === 128 && win.blend) && covers(plan.canvases[0]), 'the windows fill the input');
  assert.deepEqual(plan.canvases[0].map((win) => win.cluster).sort((a, b) => a - b), [...Array(16).keys()], 'one window per cluster');
  specks.slice(0, 16).forEach(({ x, y, r }) => {
    const win = plan.canvases[0].find((w) => x >= w.x && x < w.x + w.size && y >= w.y && y < w.y + w.size);
    assert.ok(win && x - r - win.x >= MOSAIC_CONTEXT && win.x + win.size - (x + r + 1) >= MOSAIC_CONTEXT
      && y - r - win.y >= MOSAIC_CONTEXT && win.y + win.size - (y + r + 1) >= MOSAIC_CONTEXT, 'picture on every side of a speck');
  });
  // A seventeenth has an input to itself and takes all of it; twenty-one fill a second input with five.
  plan = planInpaint(maskOf(specks.slice(0, 17)), W, H);
  assert.deepEqual(plan.canvases.map((windows) => windows.map((win) => win.size)), [Array(16).fill(128), [512]]);
  plan = planInpaint(maskOf(specks), W, H);
  assert.equal(plan.canvases.length, 2);
  assert.ok(covers(plan.canvases[1]));
  assert.deepEqual(plan.canvases[1].filter((win) => win.blend).map((win) => win.size), [128, 128, 128, 128, 256],
    'four share a quadrant, the fifth takes one');
  assert.ok(plan.canvases[1].filter((win) => !win.blend).length > 0, 'spare room shows windows again, without writing them');
  // Up to four take a quadrant each; the same mask gives the same plan.
  plan = planInpaint(maskOf(specks.slice(0, 3)), W, H);
  assert.deepEqual(plan.canvases[0].map((win) => [win.size, win.blend]), [[256, true], [256, true], [256, true], [256, false]]);
  assert.deepEqual(planInpaint(maskOf(specks.slice(0, 3)), W, H).canvases, plan.canvases);
  // A blob up to 192 px takes a 256 px window; a longer line keeps its tiles.
  const mixed = maskOf(specks.slice(0, 2));
  for (let x = 1000; x < 1150; x++) disc(mixed, W, x, 1000, 2);
  for (let x = 1500; x < 2300; x++) disc(mixed, W, x, 1500 + Math.round((x - 1500) / 8), 2);
  plan = planInpaint(mixed, W, H);
  assert.equal(plan.canvases.length, 1);
  assert.deepEqual(plan.canvases[0].filter((win) => win.blend).map((win) => win.size), [256, 256, 256]);
  assert.equal(plan.tiled.reduce((sum, flag) => sum + flag, 0), 1, 'the long line alone is tiled');
  assert.ok(plan.tiles.length >= 2);
  // A frame smaller than the input, or mosaic: false, is all tiles.
  assert.equal(planInpaint(maskOf(specks.slice(0, 3)), W, H, { mosaic: false }).canvases.length, 0);
  const tiny = new Uint8Array(400 * 300); disc(tiny, 400, 100, 100, 5);
  plan = planInpaint(tiny, 400, 300);
  assert.deepEqual([plan.canvases.length, plan.tiles.length], [0, 1]);

  // The repair: a model that paints grey and passes the rest through. Every
  // masked pixel takes the fill exactly once, nothing else moves, and a window
  // holding another cluster's pixels masks them for the model without writing them.
  const img = image(W, H, (x, y) => [(x * 3) % 256, (y * 2) % 256, 90]);
  const near = [...specks.slice(0, 5), { x: 150 + 140, y: 200, r: 4 }]; // an empty grid cell from the first speck: a cluster of its own
  const nearMask = maskOf(near);
  for (let x = 1500; x < 2300; x++) disc(nearMask, W, x, 1500 + Math.round((x - 1500) / 8), 2);
  let inputs = 0, maskedInInput = 0;
  const run = async (input, maskTile, size) => {
    inputs++;
    const out = new Float32Array(input);
    const plane = size * size;
    for (let i = 0; i < plane; i++) if (maskTile[i]) { maskedInInput++; out[i] = out[plane + i] = out[2 * plane + i] = 0.6; }
    return out;
  };
  const expected = planInpaint(nearMask, W, H);
  assert.equal(expected.grid.clusters.length, 7);
  const { imageData: result, tiles } = await inpaintWithModel(img, nearMask, run);
  assert.equal(tiles, expected.canvases.length + expected.tiles.length);
  assert.ok(inputs <= tiles && inputs < 7, `fewer inputs than clusters (${inputs})`);
  let wrong = 0;
  for (let p = 0; p < W * H; p++) {
    const x = p % W, y = (p - x) / W, o = p * 4;
    const original = [(x * 3) % 256, (y * 2) % 256, 90];
    for (let c = 0; c < 3; c++) if (result.data[o + c] !== (nearMask[p] ? 153 : original[c])) wrong++;
  }
  // The model passes unmasked pixels through, so the feather blends a pixel with itself.
  assert.equal(wrong, 0, 'masked pixels take the fill, every other pixel keeps its value');
  assert.equal(result.__image16.data[(200 * W + 150) * 4], Math.round(0.6 * 65535));
  // Two clusters inside each other's 256 px windows: each window masks both
  // for the model (four windows, two of them spare) and writes its own.
  const pair = maskOf([{ x: 180, y: 400, r: 3 }, { x: 262, y: 400, r: 3 }]);
  const pairPlan = planInpaint(pair, W, H);
  assert.equal(pairPlan.grid.clusters.length, 2);
  assert.deepEqual(pairPlan.canvases.map((windows) => windows.map((win) => win.size)), [[256, 256, 256, 256]]);
  inputs = maskedInInput = 0;
  const pairResult = await inpaintWithModel(img, pair, run);
  assert.equal(inputs, 1);
  assert.equal(maskedInInput, 4 * pair.reduce((sum, value) => sum + (value ? 1 : 0), 0), 'every window masks both specks');
  for (const x of [180, 262]) assert.equal(pairResult.imageData.data[(400 * W + x) * 4], 153);
}

console.log('aiInpaint.test.mjs passed');
