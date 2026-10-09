// #259 Part 1 acceptance: an `inpaint` request through createDustWorkerProcessor
// on a Leica M11-sized frame (9504×6320) with 400 scattered bright specks up to
// 15 px on a darker background, in a fresh OpenCV instance (no detection has
// grown the heap first). Too heavy for `npm test`; run it alone.
//   node scripts/bench-dust-inpaint-60mp.mjs [width] [height] [specks]
// Checks: no "cv.inpaint failed" / fallback log, no speck pixel keeps its bright
// source value, OpenCV's WASM memory stays below 512 MB after the call, and the
// call takes at most 400 ms (V8).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createDustWorkerProcessor } from '../negative2positive/src/workers/dustWorkerProcessor.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');
const cv = globalThis.cv;

const width = Number(process.argv[2]) || 9504;
const height = Number(process.argv[3]) || 6320;
const specks = Number(process.argv[4]) || 400;
const logs = [];
for (const level of ['warn', 'error', 'log']) {
  const original = console[level];
  console[level] = (...args) => { logs.push(args.join(' ')); original(...args); };
}

let seed = 9504;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const rgba = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  rgba[i] = 60 + (x % 23); rgba[i + 1] = 70 + (y % 17); rgba[i + 2] = 80 + ((x + y) % 13); rgba[i + 3] = 255;
}
const mask = new Uint8Array(width * height);
const speckPixels = [];
for (let k = 0; k < specks; k++) {
  const size = 1 + Math.floor(random() * 15);
  const x0 = Math.floor(random() * (width - size)), y0 = Math.floor(random() * (height - size));
  const r = size / 2, cx = x0 + r, cy = y0 + r;
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) {
    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
    const i = (y * width + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 250;
    speckPixels.push(y * width + x);
  }
  // Detection dilates each speck: a 9 px ellipse at 6320 px height.
  const grow = Math.max(3, Math.round(height * 0.0015)) >> 1;
  for (let y = Math.max(0, y0 - grow); y < Math.min(height, y0 + size + grow); y++) {
    for (let x = Math.max(0, x0 - grow); x < Math.min(width, x0 + size + grow); x++) {
      const dx = (x + 0.5 - cx) / (r + grow), dy = (y + 0.5 - cy) / (r + grow);
      if (dx * dx + dy * dy <= 1) mask[y * width + x] = 255;
    }
  }
}
// A plain loop: `Uint16Array.from(rgba, mapFn)` builds a JS array of every mapped
// value first, which at 9504×6320×4 exceeds V8's array-length limit.
const image16 = new Uint16Array(rgba.length);
for (let i = 0; i < rgba.length; i++) image16[i] = rgba[i] * 257;

const processor = createDustWorkerProcessor();
await processor({ type: 'plane', id: 1, kind: 'rgba', width, height, offset: 0, total: rgba.length, chunk: rgba, done: true });
await processor({ type: 'plane', id: 2, kind: 'image16', width, height, offset: 0, total: image16.length, chunk: image16, done: true });
const started = performance.now();
const { payload } = await processor({ type: 'inpaint', id: 3, width, height, reuseSource: true, mask, radius: 3 });
const elapsedMs = performance.now() - started;
const probe = new cv.Mat(1, 1, cv.CV_8UC1);
const heapBytes = probe.data.buffer.byteLength;
probe.delete();

let unrepaired = 0;
for (const p of speckPixels) if (payload.image.data[p * 4] === 250) unrepaired++;
const report = { width, height, specks, speckPixels: speckPixels.length, elapsedMs: Math.round(elapsedMs),
  heapMiB: Math.round(heapBytes / 1048576), unrepaired };
console.log(JSON.stringify(report));
assert.ok(!logs.some((line) => /cv\.inpaint failed|fallback/i.test(line)), 'no inpaint failure or fallback');
assert.equal(unrepaired, 0, 'every speck pixel is repaired');
assert.ok(heapBytes < 512 * 1024 * 1024, 'OpenCV heap stays below 512 MB');
if (width * height >= 50e6) assert.ok(elapsedMs <= 400, `inpaint takes at most 400 ms (${Math.round(elapsedMs)} ms)`);
