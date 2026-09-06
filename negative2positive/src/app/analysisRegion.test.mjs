import assert from 'node:assert/strict';
import { imageAreaFromDetection, resolveAnalysisRegion, analysisPixelBounds, imageAreaFromWorkingRect, sampleAnalysisArea } from './analysisRegion.js';
import { isSameAnalysisFrame } from './cropColorAnalysis.js';
import { analyzeImage } from '../silvercore/engine/ImageProcessor.js';
import { projectWindowCrop } from './imageWindowDetector.js';

const source = { width: 100, height: 80 };
const result = { angle: 0, cropRegion: { left: 20, top: 10, width: 60, height: 60 } };
const imageArea = imageAreaFromDetection(result, source);
const settings = { rotationAngle: 0, mirrored: false, cropRegion: null, autoFrameMeta: { imageArea } };
assert.deepEqual(resolveAnalysisRegion(settings, source), { left: .2, top: .125, width: .6, height: .75 });
assert.deepEqual(resolveAnalysisRegion({ ...settings, cropRegion: result.cropRegion }, source), { left: 0, top: 0, width: 1, height: 1 });
assert.deepEqual(resolveAnalysisRegion({ ...settings, mirrored: true }, source), resolveAnalysisRegion(settings, source));
assert.equal(resolveAnalysisRegion({}, source), null);
assert.equal(resolveAnalysisRegion({ autoFrameMeta: { imageArea: [{ x: NaN, y: 1 }] } }, source), null);

// 白い齿孔と暗いホルダーを含めても、撮影窓内の解析は切り抜き済み画像と一致する。
const full = { ...source, data: new Uint16Array(100 * 80 * 4) };
const cropped = { width: 60, height: 60, data: new Uint16Array(60 * 60 * 4) };
for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
  const inside = x >= 20 && x < 80 && y >= 10 && y < 70;
  const value = inside ? 10000 + ((x + y * 3) % 64) * 600 : (x % 10 < 5 ? 65535 : 0);
  full.data.set([value, value, value, 65535], (y * 100 + x) * 4);
  if (inside) cropped.data.set([value, value, value, 65535], ((y - 10) * 60 + x - 20) * 4);
}
const baseline = analyzeImage(cropped, { borderBuffer: 0 });
const roi = resolveAnalysisRegion(settings, source);
assert.deepEqual(analyzeImage(full, { borderBuffer: 0, analysisRegion: roi }), baseline);
assert.notDeepEqual(analyzeImage(full, { borderBuffer: 0 }), baseline);
assert.deepEqual(analysisPixelBounds(100, 80, roi), result.cropRegion);
assert.equal(full.width, 100);
assert.deepEqual(projectWindowCrop({ angle: 0, points: [{ x: 20, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 70 }, { x: 20, y: 70 }] }, source, source, source), { left: 21, top: 11, width: 58, height: 58 });
console.log('analysisRegion: 領域座標変換と齿孔を除外した 16-bit ヒストグラムを検証');

// 直角回転でも浮動小数の ceil によって一画素ずれない。
assert.deepEqual(imageAreaFromWorkingRect({ left: 0, top: 0, width: 80, height: 100 }, { rotationAngle: 90 }, source), [{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
const rgba8 = { ...source, data: Uint8ClampedArray.from(full.data, v => v >>> 8), __image16: full };
const sample = sampleAnalysisArea(rgba8, imageArea);
assert.deepEqual(sample.data, cropped.data);
assert.deepEqual(sampleAnalysisArea(rgba8, imageArea).data, sample.data);
assert.ok(sampleAnalysisArea(rgba8, imageArea, 100).data.length <= 400);
assert.equal(sampleAnalysisArea(rgba8, null), null);
assert.ok(isSameAnalysisFrame(imageArea, imageAreaFromWorkingRect({ left: 18, top: 8, width: 64, height: 64 }, {}, source)));
assert.ok(!isSameAnalysisFrame(imageArea, imageArea.map(p => ({ ...p, x: p.x + .6 }))));
console.log('analysisRegion: 解析標本の独立性・16-bit 保持・直角座標・隣接コマの拒否を検証');
