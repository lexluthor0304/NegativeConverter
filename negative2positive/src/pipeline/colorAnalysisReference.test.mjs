import assert from 'node:assert/strict';
import { sampleAnalysisArea } from '../app/analysisRegion.js';
import { estimateAutoWhiteBalance } from '../app/autoWhiteBalance.js';
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const { convertColorWithSilverCore, convertBwWithSilverCore } = await import('./silverAdapter.js');

const width = 120, height = 100;
const data = new Uint16Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const inside = x >= 20 && x < 100 && y >= 20 && y < 80;
  const v = 4000 + (x * 173 + y * 719) % 24000;
  data.set(inside ? [v * 1.8, v, v * .6, 65535] : [65535, x % 5 ? 0 : 65535, 0, 65535], (y * width + x) * 4);
}
const base = { width, height, data: Uint8ClampedArray.from(data, v => v >>> 8), __image16: { width, height, data } };
const reference = sampleAnalysisArea(base, [{ x: 1/6, y: .2 }, { x: 5/6, y: .2 }, { x: 5/6, y: .8 }, { x: 1/6, y: .8 }]);
const original = new Uint16Array(reference.data);
for (const convert of [convertColorWithSilverCore, convertBwWithSilverCore]) {
  for (const colorModel of ['standard', 'frontier', 'noritsu']) {
    const settings = { colorModel, preSaturation: 115, borderBuffer: 10, filmBase: { r: 210, g: 120, b: 70 } };
    const full = await convert(base, settings, { analysisImageData: reference, preview: true });
    const crop = await convert(reference, settings, { analysisImageData: reference, preview: false });
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
      const i = ((y + 20) * width + x + 20) * 4, j = (y * 80 + x) * 4;
      assert.deepEqual(full.__image16.data.slice(i, i + 4), crop.__image16.data.slice(j, j + 4));
    }
    assert.deepEqual(estimateAutoWhiteBalance(full.__analysisPreview), estimateAutoWhiteBalance(crop.__analysisPreview));
    assert.deepEqual(reference.data, original);
    // 外部標本を外した後、以前の解析をキャッシュから流用しない。
    const noReference = await convert(base, settings, { preview: true });
    assert.equal(noReference.__analysisPreview, undefined);
    assert.notDeepEqual(noReference.data, full.data);
  }
}
console.log('colorAnalysisReference: 枠あり・なしの画素一致、WB 一致、標本所有権、キャッシュ切替を検証');
