// Multi-shot kernel micro-benchmark (#260): the table-driven kernels in
// multiShot.js against the 1703835 kernels (multiShot.reference.mjs) on the
// same synthetic 16-bit frames, in the same run so machine load cancels out.
// Outputs are compared byte for byte.
//
//   node scripts/benchmark-multishot-kernels.mjs            # 3 frames at 24 MP
//   node scripts/benchmark-multishot-kernels.mjs --mp 6     # smaller frames
//   node scripts/benchmark-multishot-kernels.mjs --assert   # fail under the #260 targets
//
// Memory: about 30 bytes per pixel per frame (24 MP x 3 frames: ~2.2 GB).
import { performance } from 'node:perf_hooks';
import * as current from '../negative2positive/src/app/multiShot.js';
import * as head from '../negative2positive/src/app/multiShot.reference.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const megapixels = arg('--mp', 24);
const frameCount = arg('--frames', 3);
const width = Math.round(Math.sqrt(megapixels * 1e6 * 1.5));
const height = Math.round(width / 1.5);

let seed = 12345;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const encode = (linear) => Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 65535);
const gamma = new Uint16Array(4097);
for (let i = 0; i <= 4096; i++) gamma[i] = encode(i / 4096);

// A frame of a smooth scene with a clipped patch and per-frame noise, at
// `gain` exposure, with the transparent wedge a warp leaves at one corner.
function makeFrame(gain, wedge) {
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const bright = x > width * 0.7 && y < height * 0.2;
      const base = (bright ? 1.4 : 0.03 + 0.6 * (x / width) * (y / height)) * gain;
      for (let ch = 0; ch < 3; ch++) {
        const linear = Math.min(1, Math.max(0, base * (1 + 0.2 * (random() - 0.5))));
        data[o + ch] = gamma[Math.round(linear * 4096)];
      }
      data[o + 3] = x + y < wedge ? 0 : 65535;
    }
  }
  return { width, height, data };
}

function time(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}
function same(a, b, label) {
  if (a.data.length !== b.data.length) throw new Error(`${label}: sizes differ`);
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) throw new Error(`${label}: sample ${i} differs`);
}

console.log(`multi-shot kernels: ${frameCount} frames of ${width}x${height} (${(width * height / 1e6).toFixed(1)} MP), node ${process.version}`);
const gains = [1, 0.5, 0.25, 0.7, 1.3];
const images = Array.from({ length: frameCount }, (_, i) => makeFrame(gains[i % gains.length], i * 40));

const ratio = { head: 0, current: 0 };
const ratios = [1];
for (let i = 1; i < frameCount; i++) {
  const before = time(() => head.estimateExposureRatio(images[0], images[i]));
  const after = time(() => current.estimateExposureRatio(images[0], images[i]));
  if (before.value !== after.value) throw new Error(`ratio ${i}: ${after.value} !== ${before.value}`);
  ratio.head += before.ms; ratio.current += after.ms;
  ratios.push(after.value);
}
const frames = images.map((image16, i) => ({ image16, ratio: ratios[i] }));
const region = current.coverageRect(frames);
const results = {};
for (const mode of ['average', 'hdr']) {
  const before = time(() => head.mergeFrames(frames, { mode, region, opaque: true }));
  const after = time(() => current.mergeFrames(frames, { mode, region, opaque: true }));
  same(after.value, before.value, mode);
  results[mode] = { head: before.ms, current: after.ms };
}
const perFrame = (ms) => ms / Math.max(1, frameCount - 1);
const rows = [
  ['average', results.average.head, results.average.current, 2],
  ['hdr', results.hdr.head, results.hdr.current, 1.25],
  ['ratio / frame', perFrame(ratio.head), perFrame(ratio.current), 3]
];
let short = false;
for (const [label, before, after, target] of rows) {
  const speedup = before / after;
  if (speedup < target) short = true;
  console.log(`${label.padEnd(14)} HEAD ${before.toFixed(0).padStart(7)} ms  now ${after.toFixed(0).padStart(7)} ms  ${speedup.toFixed(2)}x (target ${target}x)`);
}
console.log('outputs and ratios identical to 1703835');
if (process.argv.includes('--assert') && short) {
  console.error('FAIL: a kernel is below its #260 speed-up target');
  process.exit(1);
}
