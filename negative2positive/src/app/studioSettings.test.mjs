import assert from 'node:assert/strict';
import { pickStudioColors, mergeStudioColors, createStudioThumbnail } from './studioSettings.js';

const source = { coreExposure: 42, coreTemperature: 18, coreColorModel: 'warm',
  cropRegion: { left: 20 }, rotationAngle: 90, mirrored: true,
  filmBase: { r: 200, g: 120, b: 80 }, wbR: 1.2, lensCorrection: { enabled: true },
  dustRemoval: { enabled: true }, curvePoints: { r: [{ x: 0, y: 2 }] } };
const target = { coreExposure: 0, cropRegion: { left: 70 }, rotationAngle: 180,
  mirrored: false, filmBase: { r: 180, g: 100, b: 60 }, wbR: 0.9,
  lensCorrection: { enabled: false }, dustRemoval: { enabled: false } };
const merged = mergeStudioColors(target, source);
assert.equal(merged.coreExposure, 42, '色調整をコピーする');
assert.equal(merged.coreTemperature, 18);
for (const key of ['cropRegion', 'rotationAngle', 'mirrored', 'filmBase', 'wbR', 'lensCorrection', 'dustRemoval']) {
  assert.deepEqual(merged[key], target[key], `${key} は受信先の設定を保持する`);
}
merged.curvePoints.r[0].y = 99;
assert.equal(source.curvePoints.r[0].y, 2, '曲線は参照を共有しない');
assert.equal(target.coreExposure, 0);
assert.equal(pickStudioColors(source).filmBase, undefined);
assert.deepEqual(mergeStudioColors(target, {}), target);
for (const [width, height] of [[600, 400], [400, 600], [1, 1], [3000, 2000]]) {
  const data = new Uint8ClampedArray(width * height * 4).fill(127);
  const thumb = createStudioThumbnail({ width, height, data });
  assert.ok(thumb.width <= 144 && thumb.height <= 144);
  assert.ok(Math.abs(thumb.width / thumb.height - width / height) < .02);
  assert.equal(thumb.data.length, thumb.width * thumb.height * 4);
  assert.ok(thumb.data.every(value => value === 127));
}
console.log('studioSettings: 色同期の分離・深いコピー・縦横比のテストに成功');
