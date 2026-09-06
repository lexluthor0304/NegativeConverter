// 3000×2000の固定入力で、疎なマスクと小さな筆跡の処理時間を比較する。
// node scripts/bench-dust.mjs [比較対象のDustRemovalモジュールのパス]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data; this.width = width; this.height = height;
  }
};
const require = createRequire(import.meta.url);
const cvModule = require('@techstark/opencv-js');
globalThis.cv = typeof cvModule.then === 'function' ? await cvModule : cvModule;
const url = process.argv[2] ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../negative2positive/src/silvercore/engine/DustRemoval.js', import.meta.url);
const { inpaintMasked, refineMaskIntelligent } = await import(url.href);
const width = 3000, height = 2000;
const data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  data[i] = (x * 7 + y) % 256;
  data[i + 1] = (x + y * 3) % 256;
  data[i + 2] = (x * 2 + y * 5) % 256;
  data[i + 3] = 255;
}
const source = new ImageData(data, width, height);
const mask = new Uint8Array(width * height);
const brush = new Uint8Array(mask.length);
for (let y = 980; y <= 1020; y++) for (let x = 1480; x <= 1520; x++) {
  if ((x - 1500) ** 2 + (y - 1000) ** 2 <= 400) brush[y * width + x] = 255;
  if (Math.abs(x - 1500) <= 2 && Math.abs(y - 1000) <= 2) mask[y * width + x] = 255;
}
for (const [name, operation] of [
  ['疎なマスクの修復', () => inpaintMasked(source, mask)],
  ['空マスクの修復', () => inpaintMasked(source, new Uint8Array(mask.length))],
  ['スマートブラシ', () => refineMaskIntelligent(source, mask, brush)],
]) {
  operation();
  const times = [];
  let result;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    result = operation();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const hash = createHash('sha256').update(result.data || result).digest('hex');
  console.log(JSON.stringify({ name, width, height, medianMs: +times[2].toFixed(2), hash }));
}
