import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  inpaintMasked, refineMaskDirect, refineMaskRemove, refineMaskIntelligent,
  detectDust, updateDustStrength,
} from './DustRemoval.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    assert.ok(data instanceof Uint8ClampedArray);
    assert.equal(data.length, width * height * 4);
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

function fixture() {
  const width = 32, height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    data.set([100, 120, 140, 128], i);
    plane.set([25601, 30723, 35845, 32769], i);
  }
  const mask = new Uint8Array(width * height);
  const dust = 16 * width + 16;
  mask[dust] = 255;
  data.set([255, 255, 255, 128], dust * 4);
  plane.set([65535, 65535, 65535, 32769], dust * 4);
  const source = new ImageData(data, width, height);
  source.__image16 = { width, height, data: plane };
  return { source, mask, dust };
}

function verifyInpaint() {
  const { source, mask, dust } = fixture();
  const before8 = source.data.slice();
  const before16 = source.__image16.data.slice();
  const result = inpaintMasked(source, mask);
  assert.ok(result.data[dust * 4] < 150, '白い塵が周辺色で修復される');
  assert.notEqual(result.__image16.data, source.__image16.data);
  for (let i = 0; i < result.data.length; i++) {
    if (Math.floor(i / 4) !== dust || i % 4 === 3) {
      assert.equal(result.data[i], before8[i], '非対象画素とアルファを保持する');
      assert.equal(result.__image16.data[i], before16[i], '非対象画素の16ビット精度を保持する');
    } else {
      assert.equal(result.__image16.data[i], result.data[i] * 257);
    }
  }
  assert.deepEqual(source.data, before8, '入力画像を変更しない');
  assert.deepEqual(source.__image16.data, before16);
  assert.deepEqual(inpaintMasked(source, new Uint8Array(mask.length)).__image16.data, before16);
}

// OpenCVなしのフォールバックと入力検証。
verifyInpaint();
{
  const { source, mask } = fixture();
  const short = mask.subarray(1);
  assert.throws(() => inpaintMasked(source, short), RangeError);
  assert.throws(() => inpaintMasked(source, new Float32Array(mask.length)), RangeError);
  assert.throws(() => inpaintMasked(source, mask, Infinity), RangeError);
  assert.throws(() => refineMaskIntelligent(source, mask, short), RangeError);
  assert.throws(() => refineMaskDirect(mask, short), RangeError);
  assert.throws(() => refineMaskRemove(mask, short), RangeError);
  const added = refineMaskDirect(new Uint8Array(mask.length), mask);
  assert.deepEqual(added, mask);
  assert.deepEqual(refineMaskRemove(added, mask), new Uint8Array(mask.length));
}

// 実際のWASM実装でも画素・精度・マスクの契約を検証する。
const require = createRequire(import.meta.url);
const module = require('@techstark/opencv-js');
const cv = typeof module.then === 'function' ? await module : module;
globalThis.cv = cv;
verifyInpaint();

// 色変換段階で例外が出ても確保済みMatを解放してフォールバックする。
const allocated = [];
globalThis.cv = new Proxy(cv, {
  get(target, key) {
    if (key === 'cvtColor') return (src, dst) => {
      allocated.push(src, dst);
      throw new Error('意図した色変換エラー');
    };
    return target[key];
  },
});
verifyInpaint();
assert.ok(allocated.length > 0);
assert.ok(allocated.every(mat => mat.isDeleted()));
globalThis.cv = cv;

// 合成画像の独立した小粒子を検出し、強度更新後も同じ寸法を維持する。
{
  const width = 256, height = 256;
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const centers = [[40, 40], [110, 50], [190, 70], [70, 180], [190, 190]];
  for (const [x, y] of centers) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * width + x + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 250;
    }
  }
  const source = new ImageData(data, width, height);
  const detected = detectDust(source, { strength: 10 });
  assert.equal(detected.particleCount, centers.length);
  for (const [x, y] of centers) assert.equal(detected.mask[y * width + x], 255);
  assert.ok(detected.mask.filter(Boolean).length < width * height * 0.01);
  const updated = updateDustStrength(source, detected._state, 9);
  assert.equal(updated._state, detected._state);
  assert.equal(updated.mask.length, width * height);
  const brush = new Uint8Array(width * height);
  brush[40 * width + 40] = 255;
  assert.equal(refineMaskIntelligent(source, detected.mask, brush).length, width * height);
}
console.log('DustRemoval inpaint tests passed');
