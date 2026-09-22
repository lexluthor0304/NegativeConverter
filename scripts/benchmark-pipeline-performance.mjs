// Run from either checkout to compare identical fixtures, e.g.:
// node /path/to/new/checkout/scripts/benchmark-pipeline-performance.mjs --root /path/to/old/checkout
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const rootIndex = process.argv.indexOf('--root');
const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : '.');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { applyUnsharpMask } = await load('negative2positive/src/silvercore/engine/Sharpening.js');
const { Histogram } = await load('negative2positive/src/silvercore/ui/Histogram.js');
const { Engine } = await load('negative2positive/src/silvercore/engine/Engine.js');
const { convertColorWithSilverCore, invalidateSilverCoreCache } = await load('negative2positive/src/pipeline/silverAdapter.js');
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const results = { root, node: process.version };
const width = 6000, height = 4000;
const pixels = new Uint16Array(width * height * 4);
for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 571 + (i >>> 4)) % 65536;
const nativeFloat32 = globalThis.Float32Array;
let allocated = 0;
globalThis.Float32Array = class extends nativeFloat32 { constructor(...args) { super(...args); allocated += this.byteLength; } };
let start = performance.now();
try { applyUnsharpMask({ width, height, data: pixels }, { amount: 75, radius: 1, threshold: 0 }); }
finally { globalThis.Float32Array = nativeFloat32; }
results.sharpen24MP = { ms: performance.now() - start, temporaryFloat32Bytes: allocated };
const bytes = new Uint8ClampedArray(pixels.length);
for (let i = 0; i < bytes.length; i++) bytes[i] = pixels[i] >>> 8;
const image = new ImageData(bytes, width, height);
const histogram = new Histogram({ width: 300, height: 150, getContext: () => new Proxy({}, { get: () => () => {} }) });
start = performance.now(); histogram.draw(image);
results.histogram24MP = { ms: performance.now() - start };
invalidateSilverCoreCache();
const small = new ImageData(image.data.subarray(0, 500 * 500 * 4), 500, 500);
const processFrame = Engine.prototype.process;
let analyses = 0;
Engine.prototype.process = function (...args) { analyses++; return processFrame.apply(this, args); };
start = performance.now();
try { for (let i = 0; i < 3; i++) await convertColorWithSilverCore(small, { contrast: i * 5, filmBase: { r: 210, g: 140, b: 90 } }, { preview: true }); }
finally { Engine.prototype.process = processFrame; }
results.same8BitSourceThreeRenders = { ms: performance.now() - start, analyses };
const local = {
  localExposure: { strokes: Array.from({ length: 20 }, (_, s) => ({ stops: .25, size: .12, feather: .5, points: Array.from({ length: 30 }, (_, i) => ({ x: .1 + i * .025, y: .2 + (s % 5) * .12 + Math.sin(i) * .03, p: 1 })) })) },
  localExposureGeometry: { baseWidth: 6000, baseHeight: 4000, rotatedWidth: 6000, rotatedHeight: 4000, rotationAngle: 0, mirrored: false },
};
const preview = new ImageData(image.data.subarray(0, 1500 * 1000 * 4), 1500, 1000);
await convertColorWithSilverCore(preview, local, { preview: true });
start = performance.now();
await convertColorWithSilverCore(preview, { ...structuredClone(local), contrast: 10 }, { preview: true });
results.unchangedExposureStrokesSecondRender1_5MP = { ms: performance.now() - start };
console.log(JSON.stringify(results, null, 2));
