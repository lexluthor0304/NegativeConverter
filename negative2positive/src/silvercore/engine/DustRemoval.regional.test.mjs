import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { inpaintMasked, refineMaskIntelligent, refineMaskDirect, refineMaskRemove } from './DustRemoval.js';

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

// 最適化を経由しないOpenCV全画面処理を比較基準にする。
function fullFrameReference(source, mask, radius) {
  const src = cv.matFromImageData(source);
  const rgb = new cv.Mat(), maskMat = new cv.Mat(source.height, source.width, cv.CV_8UC1);
  const dst = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    maskMat.data.set(mask);
    cv.inpaint(rgb, maskMat, dst, radius, cv.INPAINT_TELEA);
    const expected = new Uint8ClampedArray(source.data);
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      for (let c = 0; c < 3; c++) expected[p * 4 + c] = dst.data[p * 3 + c];
    }
    return expected;
  } finally {
    src.delete(); rgb.delete(); maskMat.delete(); dst.delete();
  }
}

let seed = 123456;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const width = 83, height = 67;
const data = new Uint8ClampedArray(width * height * 4);
for (let i = 0; i < data.length; i++) data[i] = random() >>> 24;
const source = new ImageData(data, width, height);
function rectangle(mask, x, y, w, h) {
  for (let row = y; row < Math.min(height, y + h); row++) {
    for (let col = x; col < Math.min(width, x + w); col++) mask[row * width + col] = 255;
  }
}

// 中央、画像端、隅、線、離れた複数粒子、密なマスクを含む。
const masks = [];
for (const [x, y, w, h] of [
  [40, 30, 5, 7], [0, 0, 3, 3], [80, 64, 3, 3], [0, 30, 5, 5],
  [40, 0, 5, 5], [80, 30, 3, 5], [40, 64, 5, 3], [25, 25, 1, 17],
  [25, 25, 17, 1], [1, 1, 81, 65],
]) {
  const mask = new Uint8Array(width * height);
  rectangle(mask, x, y, w, h);
  masks.push(mask);
}
for (let n = 0; n < 20; n++) {
  const mask = new Uint8Array(width * height);
  for (let spot = 0; spot <= n % 5; spot++) {
    rectangle(mask, random() % width, random() % height, 1 + random() % 5, 1 + random() % 5);
  }
  masks.push(mask);
}
for (const radius of [1, 3, 8]) for (let i = 0; i < masks.length; i++) {
  assert.deepEqual(inpaintMasked(source, masks[i], radius).data,
    fullFrameReference(source, masks[i], radius), `全画面との一致: radius=${radius}, case=${i}`);
}

// マスクの追加・部分削除・全削除の結果は常に元画像から再構成される。
const mask = masks[0];
const brush = new Uint8Array(mask.length);
rectangle(brush, 42, 32, 5, 5);
const added = refineMaskDirect(mask, brush);
const removed = refineMaskRemove(added, brush);
for (const current of [added, removed]) {
  assert.deepEqual(inpaintMasked(source, current).data, fullFrameReference(source, current, 3));
}
const empty = refineMaskRemove(added, added);
assert.deepEqual(inpaintMasked(source, empty).data, source.data);
assert.notEqual(inpaintMasked(source, empty).data, source.data);

// OpenCVへ渡す画像寸法で、局所処理と空マスクの早期終了を確認する。
const calls = [];
globalThis.cv = new Proxy(cv, {
  get(target, key) {
    if (key === 'matFromImageData') return image => {
      calls.push([image.width, image.height]);
      return cv.matFromImageData(image);
    };
    return target[key];
  },
});
inpaintMasked(source, mask);
assert.ok(calls.every(([w, h]) => w < width && h < height));
calls.length = 0;
inpaintMasked(source, empty);
assert.equal(calls.length, 0);
refineMaskIntelligent(source, empty, brush);
assert.deepEqual(calls, [[5, 5]]);
calls.length = 0;
assert.equal(refineMaskIntelligent(source, mask, empty), mask);
assert.equal(calls.length, 0);

// 最適化前の全画面グレースケール＋輪郭抽出で記録したマスク。
globalThis.cv = cv;
for (const [rects, hash] of [
  [[[20, 20, 9, 9]], 'bcc70d9818e7ea5b7e528e1d763acd7ccfbaa5acdea0c547130a85ee002c8cf4'],
  [[[0, 0, 7, 7]], '0077ac04a4261ad850a646efa7ad9f423a6d5740b403881557830dd6be49372c'],
  [[[78, 62, 5, 5]], '1c1c45b82054b103ed458526371c0429990696cfd82efee1c6bf9ff6e6f61f5c'],
  [[[10, 10, 5, 5], [30, 30, 7, 7]], '6a7ba4a84d06775b26406a16fa855ae0247eb09cc45250bb535344c15d39a4de'],
  [[[20, 20, 1, 9]], '7b82df0f82c4e7c2d79c0379f4751698428ae21c6cb1cc337e55941470de85d4'],
  [[[20, 20, 9, 1]], 'ffedc6da0daf0ddf936e9687936015e663687d120230e42ac09ad89a135c2864'],
]) {
  const stroke = new Uint8Array(width * height);
  for (const rect of rects) rectangle(stroke, ...rect);
  const existing = new Uint8Array(stroke.length);
  existing[4] = 255;
  const result = refineMaskIntelligent(source, existing, stroke);
  assert.equal(createHash('sha256').update(result).digest('hex'), hash);
}

console.log('DustRemoval regional tests passed');
