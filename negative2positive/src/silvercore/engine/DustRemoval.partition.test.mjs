// Partition equivalence (#259): inpaintMasked repairs each dust cluster in its
// own crop. It must equal one full-frame OpenCV TELEA in RGB8, the 16-bit
// plane (masked RGB = 8-bit × 257, everything else from the source) and alpha.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dustInpaintPad, dustMaskClusters, inpaintMasked } from './DustRemoval.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    assert.ok(data instanceof Uint8ClampedArray);
    assert.equal(data.length, width * height * 4);
    this.data = data; this.width = width; this.height = height;
  }
};
const require = createRequire(import.meta.url);
const module = require('@techstark/opencv-js');
const cv = typeof module.then === 'function' ? await module : module;
globalThis.cv = cv;

// The oracle: one cv.inpaint over the whole frame, as HEAD did where it fit.
function fullFrameReference(source, mask, radius) {
  const src = cv.matFromImageData(source);
  const rgb = new cv.Mat(), maskMat = new cv.Mat(source.height, source.width, cv.CV_8UC1);
  const dst = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    maskMat.data.set(mask);
    cv.inpaint(rgb, maskMat, dst, radius, cv.INPAINT_TELEA);
    const data = new Uint8ClampedArray(source.data);
    const plane = source.__image16 ? new Uint16Array(source.__image16.data) : null;
    const out = dst.data;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      for (let c = 0; c < 3; c++) {
        data[p * 4 + c] = out[p * 3 + c];
        if (plane) plane[p * 4 + c] = out[p * 3 + c] * 257;
      }
    }
    return { data, plane };
  } finally {
    src.delete(); rgb.delete(); maskMat.delete(); dst.delete();
  }
}

let seed = 20260923;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (n) => Math.floor(random() * n);

// Smooth ramps plus noise, so TELEA's gradients and every sample matter.
const noise = Uint16Array.from({ length: 65536 }, () => int(65536));
function makeImage(width, height, { plane = true, alpha = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const wide = plane ? new Uint16Array(width * height * 4) : null;
  let n = int(65536);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      n = noise[(n + i + c) & 0xffff];
      const value = (((x * (c + 1) + y * (3 - c)) / 7) + (n & 47)) % 256;
      data[i + c] = value;
      if (wide) wide[i + c] = Math.min(65535, Math.round(value * 257 + (n >>> 8)));
    }
    n = noise[(n + i + 3) & 0xffff];
    data[i + 3] = alpha ? n & 255 : 255;
    if (wide) wide[i + 3] = alpha ? n : 65535;
  }
  const image = new ImageData(data, width, height);
  if (wide) image.__image16 = { width, height, data: wide };
  return image;
}

function disc(mask, width, height, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * width + x] = 255;
  }
}

// Scattered specks up to 15 px, some hugging edges and corners, a few
// scratches, and optionally a dense patch whose specks merge.
function makeMask(width, height, specks, { dense = false } = {}) {
  const mask = new Uint8Array(width * height);
  for (let k = 0; k < specks; k++) {
    const r = int(8);
    const edge = int(6);
    const cx = edge === 0 ? int(3) : edge === 1 ? width - 1 - int(3) : int(width);
    const cy = edge === 2 ? int(3) : edge === 3 ? height - 1 - int(3) : int(height);
    disc(mask, width, height, cx, cy, r);
  }
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) disc(mask, width, height, x, y, 2);
  for (let s = 0; s < 3; s++) {
    let x = int(width), y = int(height);
    const dx = random() * 2 - 1, dy = random() * 2 - 1;
    for (let t = 0; t < Math.min(width, height) / 3; t++) {
      const px = Math.round(x + dx * t), py = Math.round(y + dy * t);
      if (px >= 0 && py >= 0 && px < width && py < height) mask[py * width + px] = 255;
    }
  }
  if (dense) {
    const x0 = int(width / 2), y0 = int(height / 2);
    for (let k = 0; k < 60; k++) disc(mask, width, height, x0 + int(width / 4), y0 + int(height / 4), 1 + int(3));
  }
  return mask;
}

function assertEquivalent(source, mask, radius, label) {
  const before8 = source.data.slice();
  const before16 = source.__image16?.data.slice();
  const expected = fullFrameReference(source, mask, radius);
  const actual = inpaintMasked(source, mask, radius);
  assert.ok(Buffer.from(actual.data.buffer).equals(Buffer.from(expected.data.buffer)), `${label}: RGB8 and alpha`);
  if (expected.plane) {
    assert.ok(Buffer.from(actual.__image16.data.buffer).equals(Buffer.from(expected.plane.buffer)), `${label}: 16-bit plane`);
  } else assert.equal(actual.__image16, undefined, `${label}: no 16-bit plane invented`);
  for (let i = 3; i < before8.length; i += 4) {
    if (actual.data[i] !== before8[i] || (before16 && actual.__image16.data[i] !== before16[i])) assert.fail(`${label}: alpha`);
  }
  assert.ok(Buffer.from(source.data.buffer).equals(Buffer.from(before8.buffer)), `${label}: source untouched`);
  if (before16) assert.ok(Buffer.from(source.__image16.data.buffer).equals(Buffer.from(before16.buffer)), `${label}: source 16-bit untouched`);
}

let cases = 0;
for (const radius of [1, 3, 8]) {
  for (const [width, height, specks, options] of [
    [97, 61, 50, { plane: true, alpha: true }],
    [256, 192, 120, { plane: false, alpha: false, dense: true }],
    [331, 257, 400, { plane: true, alpha: true, dense: true }],
    [1200, 900, 800, { plane: true, alpha: false }],
  ]) {
    const source = makeImage(width, height, options);
    const mask = makeMask(width, height, specks, options);
    assertEquivalent(source, mask, radius, `${width}x${height} radius ${radius}`);
    cases++;
  }
}

// Many specks on a 12 MP frame, 8-bit only and with the 16-bit plane.
{
  const width = 4000, height = 3000;
  const source = makeImage(width, height, { plane: true, alpha: true });
  assertEquivalent(source, makeMask(width, height, 2000, { dense: true }), 3, '12 MP, 2000 specks');
  delete source.__image16;
  assertEquivalent(source, makeMask(width, height, 50), 8, '12 MP, 50 specks, 8-bit');
  cases += 2;
}

// Everything masked, nothing masked, and a mask whose byte offset is unaligned.
{
  const source = makeImage(40, 30, { plane: true, alpha: true });
  assertEquivalent(source, new Uint8Array(40 * 30).fill(255), 3, 'fully masked');
  const empty = inpaintMasked(source, new Uint8Array(40 * 30));
  assert.deepEqual(empty.data, source.data);
  assert.notEqual(empty.data, source.data);
  const backing = new Uint8Array(40 * 30 + 1);
  const shifted = backing.subarray(1);
  disc(shifted, 40, 30, 20, 15, 3);
  assertEquivalent(source, shifted, 3, 'unaligned mask');
  cases += 3;
}

// Clusters never put two pixels closer than 2 × pad into different groups.
{
  const width = 300, height = 200, pad = dustInpaintPad(3);
  const mask = makeMask(width, height, 300, { dense: true });
  const { clusters, labels, grid, cell } = dustMaskClusters(mask, width, height, pad);
  const labelOf = (x, y) => labels[((y / cell) | 0) * grid.columns + ((x / cell) | 0)];
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) pixels.push([x, y, labelOf(x, y)]);
  for (let i = 0; i < pixels.length; i += 7) for (let j = i + 1; j < pixels.length; j += 3) {
    const [ax, ay, la] = pixels[i], [bx, by, lb] = pixels[j];
    if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 2 * pad) assert.equal(la, lb, 'close pixels share a cluster');
  }
  for (const [x, y, label] of pixels) {
    const box = clusters[label - 1];
    assert.ok(x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height, 'cluster box holds its pixels');
  }
}

// An OpenCV error is an error: no stand-in runs, and every Mat is freed.
{
  const source = makeImage(64, 48, { plane: true });
  const mask = new Uint8Array(64 * 48);
  disc(mask, 64, 48, 30, 20, 3);
  const allocated = [];
  globalThis.cv = new Proxy(cv, {
    get(target, key) {
      if (key === 'inpaint') return (...args) => { allocated.push(args[0], args[1], args[2]); throw new Error('intended inpaint failure'); };
      return target[key];
    },
  });
  assert.throws(() => inpaintMasked(source, mask), /intended inpaint failure/);
  assert.ok(allocated.length === 3 && allocated.every(mat => mat.isDeleted()));

  // OpenCV.js throws C++ exceptions as pointers; they come back as messages.
  globalThis.cv = new Proxy(cv, {
    get(target, key) {
      if (key === 'inpaint') return () => { new target.Mat(200000, 200000, target.CV_8UC3); };
      return target[key];
    },
  });
  assert.throws(() => inpaintMasked(source, mask), /Insufficient memory/);

  // Only a cluster too big for the heap is split into windows, with a warning.
  const width = 2600, height = 400;
  const long = makeImage(width, height, { plane: true });
  const scratch = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) for (let y = 199; y <= 201; y++) scratch[y * width + x] = 255;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const crops = [];
  globalThis.cv = new Proxy(cv, {
    get(target, key) {
      if (key === 'inpaint') return (src, maskMat, dst, radius, flags) => {
        crops.push(src.cols * src.rows);
        if (src.cols > 2400) throw new Error('Insufficient memory: Failed to allocate (test)');
        return target.inpaint(src, maskMat, dst, radius, flags);
      };
      return target[key];
    },
  });
  try {
    const repaired = inpaintMasked(long, scratch, 3);
    assert.equal(warnings.length, 1, 'one warning for the split');
    assert.equal(crops.length, 3, `retried in two windows: ${crops}`);
    const reference = fullFrameReference(long, scratch, 3);
    let differ = 0;
    for (let p = 0; p < scratch.length; p++) if (scratch[p] && repaired.data[p * 4] !== reference.data[p * 4]) differ++;
    assert.ok(differ < 200, `windows stay close to one call (${differ} samples differ)`);
    for (let p = 0; p < scratch.length; p++) {
      if (scratch[p]) assert.equal(repaired.__image16.data[p * 4], repaired.data[p * 4] * 257);
      else assert.equal(repaired.data[p * 4], long.data[p * 4]);
    }
    // A small cluster that fails to allocate means the heap is exhausted: report it.
    globalThis.cv = new Proxy(cv, {
      get(target, key) {
        if (key === 'inpaint') return () => { throw new Error('Insufficient memory: Failed to allocate (test)'); };
        return target[key];
      },
    });
    assert.throws(() => inpaintMasked(source, mask), /Insufficient memory/, 'small crops are not split');
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
    globalThis.cv = cv;
  }
}

console.log(`DustRemoval partition equivalence passed (${cases} frames bit-identical to full-frame TELEA)`);
