import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectImageWindow, boundaryEvidence, projectWindowCrop } from './imageWindowDetector.js';
import { detectFrameAndRotation } from './autoFrameAnalyzer.js';
import { AUTO_FRAME_FORMAT_RATIOS, canAutoApplyImportFrame } from './autoFrameFormats.js';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const targets = Object.entries(AUTO_FRAME_FORMAT_RATIOS).map(([key, ratio]) => ({ key, ratio }));
const make = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...pixel(x, y), 255], (y * width + x) * 4);
  return new ImageData(data, width, height);
};
const quad = (l, t, r, b) => [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
const base = [238, 160, 100], dark = [95, 55, 30];

// 全規格・両方向の傾き。幅は観測値を維持し、標準比率への強制変形をしない。
for (const [key, ratio] of Object.entries(AUTO_FRAME_FORMAT_RATIOS)) {
  const angle = key.includes('6x') ? -4 : 5, rad = angle * Math.PI / 180;
  const w = Math.round(160 * ratio), h = 160, width = w + 160, height = h + 160;
  const image = make(width, height, (x, y) => {
    const dx = x - width / 2, dy = y - height / 2;
    const u = dx * Math.cos(rad) + dy * Math.sin(rad), v = -dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(u) < w / 2 && Math.abs(v) < h / 2 ? dark.map(c => c + (Math.floor(u + v) & 15)) : base;
  });
  const result = detectImageWindow(image, [{ key, ratio }]);
  assert.ok(result?.points, `${key}: 四辺が見える画像を検出`);
  assert.equal(result.detectedFormat, key);
  assert.ok(Math.abs(result.angle + angle) < .6, `${key}: 傾きの符号と精度 (${result.angle})`);
  const crop = projectWindowCrop(result, image, image, { width: width + 30, height: height + 30 });
  assert.ok(Math.abs(crop.width - w) < 8 && Math.abs(crop.height - h) < 8, `${key}: 実際の四辺の内側`);
}

// 完全な輪郭がなくても、独立線と全長支持で窓を取得する。
// Otsu / Canny の contour だけに戻すと失敗するよう、輪郭取得を空にする。
const findContours = cv.findContours;
try {
  cv.findContours = () => {};
  const image = make(800, 540, (x, y) => {
    if (y < 80 || y > 460) return [245, 245, 245];
    if ((y > 105 && y < 133 || y > 409 && y < 437) && x % 48 < 18) return [245, 245, 245];
    if (y >= 150 && y <= 390 && (x >= 215 && x <= 575 || x < 195 || x > 595)) return dark.map(c => c + ((x * 13 + y * 7) % 35));
    if ((x - 12) ** 2 / 120 ** 2 + (y - 270) ** 2 / 250 ** 2 < 1 || (x - 788) ** 2 / 100 ** 2 + (y - 270) ** 2 / 250 ** 2 < 1) return [10, 10, 10];
    return base;
  });
  const result = detectImageWindow(image, targets);
  assert.equal(result?.method, 'opencv-line-window', '輪郭がなくても四辺から検出');
  const crop = projectWindowCrop(result, image, image, image);
  assert.ok(Math.abs(crop.left - 215) < 6 && Math.abs(crop.top - 150) < 6);
  assert.ok(Math.abs(crop.width - 360) < 10 && Math.abs(crop.height - 240) < 10, '隣接コマ・穴を含めない');
  assert.ok(result.confidence >= .72);
} finally { cv.findContours = findContours; }

// 外側の中央値だけでは検知できない、隣のコマ・異なる片基への接続を拒否。
const adjacent = make(600, 420, (x, y) => y >= 90 && y <= 330 && (x < 95 || x >= 120 && x <= 480) ? dark : base);
assert.ok(boundaryEvidence(adjacent, quad(120, 90, 480, 330), false, { consistentBase: true }));
assert.equal(boundaryEvidence(adjacent, quad(95, 90, 480, 330), false, { consistentBase: true }), null, '隣接画格の反対側の辺を採用しない');
const withLightbox = make(600, 420, (x, y) => y > 370 ? [245, 245, 245] : x >= 120 && x <= 480 && y >= 90 && y <= 330 ? dark : base);
assert.equal(boundaryEvidence(withLightbox, quad(120, 90, 480, 370), false, { consistentBase: true }), null, '片基とライトボックスを混ぜない');
const internalGap = make(600, 420, (x, y) => x >= 100 && x <= 500 && y >= 90 && y <= 330 && (x < 280 || x > 320) ? dark : base);
assert.equal(boundaryEvidence(internalGap, quad(100, 90, 500, 330), false, { consistentBase: true }), null, '二つの画格を一つにしない');

// ホルダーの反射縁だけが外側サンプルに入る場合は、一段外で黒を確認する。
const holder = make(800, 540, (x, y) => {
  if (x >= 200 && x <= 600 && y >= 130 && y <= 410) return [80, 120, 180];
  if (x >= 195 && x <= 198 && y >= 130 && y <= 410) return [5, 15, 80];
  return [3, 3, 3];
});
const holderPoints = quad(200, 130, 600, 410);
assert.equal(boundaryEvidence(holder, holderPoints, false, { consistentBase: true }), null);
assert.ok(boundaryEvidence(holder, holderPoints, false, { consistentBase: true, gapRatio: .012, darkHolder: true }));
assert.equal(boundaryEvidence(adjacent, quad(95, 90, 480, 330), false, { consistentBase: true, gapRatio: .012, darkHolder: true }), null, '黒ホルダー専用経路で隣接コマを誤採用しない');

// 両端が写っていない画格は、比率テンプレートへ戻らず、確認必須を返す。
const partial = make(640, 480, (x, y) => x >= 160 && x <= 480 ? dark.map(c => c + ((x + y) % 25)) : base);
const partialResult = detectFrameAndRotation(partial, {
  maxSide: 800, settings: { highConfidence: 0 },
  rotateImageData: () => assert.fail('不完全な画格を勝手に回転しない')
});
assert.equal(partialResult?.requiresReview, true);
assert.equal(partialResult.diagnostics.incomplete, true);
assert.equal(partialResult.cropRegion, null);
assert.equal(partialResult.detectedFormat, 'unknown');
assert.equal(canAutoApplyImportFrame(partialResult, { highConfidence: 0 }), false);
assert.equal(partialResult.rotatedImageData, partial);

// 空白・二コマ同等の候補・規格不一致を高信頼で採用しない。
assert.equal(detectImageWindow(make(480, 320, () => base), targets), null);
const twoFrames = make(1000, 400, (x, y) => y > 80 && y < 320 && (x > 90 && x < 450 || x > 550 && x < 910) ? dark : base);
const ambiguous = detectImageWindow(twoFrames, targets);
assert.ok(!ambiguous || ambiguous.requiresReview, '重複候補が同等の別画格を隠さない');
const square = make(500, 400, (x, y) => x > 130 && x < 370 && y > 80 && y < 320 ? dark : base);
assert.ok(!detectImageWindow(square, [{ key: '135', ratio: 1.5 }])?.points, '許可した規格を尊重');
console.log('imageWindowDetector: 全画幅・独立四辺・隣接コマ・穴・未完の画格・曖昧候補を検証');
