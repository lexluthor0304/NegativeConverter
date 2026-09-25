// Stroke equivalence (#259 Part 3): a regional stroke (brush raster in its own
// box, in-place refine, cluster-closed rect, TELEA from the clean source,
// incremental contour count) must reproduce HEAD's full-frame path after
// every stroke: createBrushMask + refineMask* over the whole frame, full-frame
// TELEA of the new mask from the clean source, and a full-frame findContours.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  inpaintMasked, refineMaskIntelligent, refineMaskDirect, refineMaskRemove,
} from './DustRemoval.js';
import {
  applyDustStroke, rasterizeBrushStroke, copyMaskRect, pasteMaskRect, countMaskParticles,
} from './DustBrush.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const require = createRequire(import.meta.url);
const module = require('@techstark/opencv-js');
const cv = typeof module.then === 'function' ? await module : module;
globalThis.cv = cv;

// HEAD's main-thread raster (main.js createBrushMask at 1703835), kept as the reference.
function createBrushMask(points, brushRadius, width, height) {
  const mask = new Uint8Array(width * height);
  const r = brushRadius;
  for (const pt of points) {
    const cx = pt.x, cy = pt.y;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) mask[ny * width + nx] = 255;
      }
    }
  }
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const steps = Math.max(1, Math.ceil(dist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ix = Math.round(p0.x + (p1.x - p0.x) * t);
      const iy = Math.round(p0.y + (p1.y - p0.y) * t);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = ix + dx, ny = iy + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) mask[ny * width + nx] = 255;
        }
      }
    }
  }
  return mask;
}

// The full-frame oracle (one cv.inpaint over the frame), 8-bit and 16-bit.
function fullFrameReference(source, mask, radius = 3) {
  const src = cv.matFromImageData(source);
  const rgb = new cv.Mat(), maskMat = new cv.Mat(source.height, source.width, cv.CV_8UC1), dst = new cv.Mat();
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
    return { data, __image16: plane ? { data: plane } : null };
  } finally { src.delete(); rgb.delete(); maskMat.delete(); dst.delete(); }
}

let seed = 259;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (n) => Math.floor(random() * n);

function makeSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(width * height * 4);
  let n = 7;
  for (let i = 0; i < data.length; i += 4) {
    const p = i >> 2, x = p % width, y = (p - x) / width;
    for (let c = 0; c < 3; c++) {
      n = (Math.imul(n, 1103515245) + 12345) >>> 0;
      const value = (40 + ((x * (c + 2) + y * (4 - c)) >> 3) + (n >>> 28)) & 255;
      data[i + c] = value;
      plane[i + c] = value * 257 + ((n >>> 20) & 255);
    }
    data[i + 3] = 200 + (p % 56);
    plane[i + 3] = data[i + 3] * 257 + 3;
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}

function disc(mask, width, height, cx, cy, r, value = 255) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < width && y < height && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * width + x] = value;
  }
}

// Bright specks painted into the source and a dilated detection-like mask,
// some on edges and corners, plus a ring whose hole holds its own speck.
function makeDust(source, specks) {
  const { width, height, data } = source;
  const mask = new Uint8Array(width * height);
  const paint = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 245;
      source.__image16.data[i] = source.__image16.data[i + 1] = source.__image16.data[i + 2] = 62965;
    }
    disc(mask, width, height, cx, cy, r + 2);
  };
  for (let k = 0; k < specks; k++) {
    const side = int(8);
    const cx = side === 0 ? int(4) : side === 1 ? width - 1 - int(4) : int(width);
    const cy = side === 2 ? int(4) : side === 3 ? height - 1 - int(4) : int(height);
    paint(cx, cy, int(6));
  }
  const rx = Math.floor(width / 2), ry = Math.floor(height / 2), rr = Math.min(60, Math.floor(Math.min(width, height) / 3));
  for (let a = 0; a < 720; a++) {
    const x = Math.round(rx + rr * Math.cos(a * Math.PI / 360)), y = Math.round(ry + rr * Math.sin(a * Math.PI / 360));
    disc(mask, width, height, x, y, 1);
  }
  paint(rx, ry, 2);
  return mask;
}

function randomStroke(width, height, near) {
  const mode = ['intelligent', 'direct', 'remove'][int(3)];
  const brushRadius = random() < 0.1 ? 20 + int(31) : 1 + int(12);
  const kind = int(10);
  let x, y;
  if (kind === 0) { x = -int(30); y = -int(30); }                       // off the top-left corner
  else if (kind === 1) { x = width - 1 + int(30); y = int(height); }     // past the right edge
  else if (kind === 2) { x = int(width); y = height - 1 + int(10); }     // past the bottom edge
  else if (kind <= 5 && near) { [x, y] = near(); }                       // on a speck
  else { x = int(width); y = int(height); }
  const points = [{ x, y }];
  for (let s = int(5); s > 0; s--) {
    x += int(41) - 20; y += int(41) - 20;
    points.push({ x, y });
  }
  return { points, brushRadius, mode };
}

let strokes = 0, emptyStrokes = 0, recounts = 0;
async function run(width, height, specks, count, { exactOracle }) {
  const source = makeSource(width, height);
  const initial = makeDust(source, specks);
  const specksAt = [];
  for (let p = 0; p < initial.length; p += 97) if (initial[p]) specksAt.push(p);
  const near = () => { const p = specksAt[int(specksAt.length)] ?? int(width * height); return [p % width, Math.floor(p / width)]; };
  // Main thread: its own mask and repaired buffer, as the worker never shares them.
  const mask = initial.slice();
  const buffer = inpaintMasked(source, mask, 3);
  // Worker: clean source, its mask and the contour count (unknown at first).
  const worker = { source, mask: initial.slice(), particleCount: null };
  let fullCountCalls = 0;
  for (let n = 0; n < count; n++) {
    const stroke = randomStroke(width, height, near);
    const expectedMask = (() => {
      const brush = createBrushMask(stroke.points, stroke.brushRadius, width, height);
      return stroke.mode === 'intelligent' ? refineMaskIntelligent(source, mask, brush)
        : stroke.mode === 'direct' ? refineMaskDirect(mask, brush) : refineMaskRemove(mask, brush);
    })();
    const before = worker.particleCount;
    const patch = applyDustStroke(worker, stroke);
    strokes++;
    if (!patch) {
      emptyStrokes++;
      assert.deepEqual(expectedMask, mask, 'a stroke that sets no pixel changes nothing');
      continue;
    }
    if (before !== null && patch.countBefore !== before) assert.fail('count baseline carried over');
    // Apply the patch the way the main thread does.
    const { rect } = patch;
    for (let row = 0; row < rect.height; row++) {
      const start = ((rect.y + row) * width + rect.x) * 4;
      buffer.data.set(patch.rgba8.subarray(row * rect.width * 4, (row + 1) * rect.width * 4), start);
      buffer.__image16.data.set(patch.rgba16.subarray(row * rect.width * 4, (row + 1) * rect.width * 4), start);
    }
    assert.deepEqual(patch.maskBefore, copyMaskRect(mask, width, patch.maskRect));
    pasteMaskRect(mask, width, patch.maskRect, patch.maskBytes);

    assert.ok(Buffer.from(mask.buffer).equals(Buffer.from(expectedMask.buffer)), `mask after stroke ${n} (${stroke.mode})`);
    assert.ok(Buffer.from(worker.mask.buffer).equals(Buffer.from(mask.buffer)), 'worker mask in step');
    const expected = exactOracle ? fullFrameReference(source, mask) : inpaintMasked(source, mask, 3);
    assert.ok(Buffer.from(buffer.data.buffer).equals(Buffer.from(expected.data.buffer)), `8-bit/alpha after stroke ${n} (${stroke.mode}, r=${stroke.brushRadius})`);
    assert.ok(Buffer.from(buffer.__image16.data.buffer).equals(Buffer.from(expected.__image16.data.buffer)), `16-bit after stroke ${n}`);
    const full = countMaskParticles(mask, width, height);
    fullCountCalls++;
    assert.equal(patch.particleCount, full, `particle count after stroke ${n}`);
  }
  return fullCountCalls;
}

await run(160, 120, 50, 120, { exactOracle: true });
await run(480, 320, 200, 70, { exactOracle: true });
await run(1500, 1000, 600, 12, { exactOracle: true });
// 12 MP: the oracle is inpaintMasked, itself equal to full-frame TELEA
// (DustRemoval.partition.test.mjs), which keeps this run fast.
await run(4000, 3000, 2000, 3, { exactOracle: false });
assert.ok(strokes >= 200, `${strokes} strokes`);
assert.ok(emptyStrokes < strokes / 4);

// Nested dust: a stroke inside the hole of a ring that stays outside R must
// not count the inner speck as external. Only the frame-wide recount knows.
{
  const width = 300, height = 300;
  const source = makeSource(width, height);
  const mask = new Uint8Array(width * height);
  for (let a = 0; a < 1440; a++) {
    disc(mask, width, height, Math.round(150 + 120 * Math.cos(a * Math.PI / 720)), Math.round(150 + 120 * Math.sin(a * Math.PI / 720)), 1);
  }
  const worker = { source, mask: mask.slice(), particleCount: null };
  const patch = applyDustStroke(worker, { points: [{ x: 150, y: 150 }], brushRadius: 3, mode: 'direct' });
  assert.ok(patch.rect.width < 60, 'the ring is not pulled into R');
  assert.equal(patch.countBefore, 1);
  assert.equal(patch.particleCount, 1, 'a speck inside the ring is not an external contour');
  assert.equal(countMaskParticles(worker.mask, width, height), 1);
  recounts++;
}

// The raster: box-local, tight, identical to the full-frame rule.
{
  const width = 50, height = 40;
  for (const points of [[{ x: -100, y: -100 }], [{ x: -3, y: -3 }], [{ x: 49, y: 39 }, { x: 80, y: 60 }], [{ x: 10, y: 5 }, { x: 30, y: 20 }, { x: 31, y: 21 }]]) {
    for (const radius of [0, 1, 4, 50]) {
      const full = createBrushMask(points, radius, width, height);
      const raster = rasterizeBrushStroke(points, radius, width, height);
      if (!full.some(Boolean)) { assert.equal(raster, null); continue; }
      const back = new Uint8Array(width * height);
      pasteMaskRect(back, width, raster.rect, raster.brush);
      assert.deepEqual(back, full);
      assert.equal(raster.brush[0] | raster.brush.at(-1) | 1, 1 | raster.brush[0] | raster.brush.at(-1));
    }
  }
}

console.log(`Dust brush strokes equal the full-frame path (${strokes} strokes, ${emptyStrokes} empty, ${recounts} enclosed recount)`);
