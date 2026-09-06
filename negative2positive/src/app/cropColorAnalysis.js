import { detectImageWindow, boundaryEvidence } from './imageWindowDetector.js';
import { downsampleImageDataForMaxPixels, cropImageDataRegion } from './imageDataOps.js';
import { imageAreaFromWorkingRect, validImageArea } from './analysisRegion.js';

// 暗い RAW の特定チャンネルだけで輪郭を失わないよう、検出用画像のみ正規化する。
function normalizeDetectionImage(image) {
  const output = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < image.data.length; i += 4) hist[image.data[i]]++;
    const count = image.width * image.height;
    let lo = 0, hi = 255, sum = 0;
    for (let i = 0; i < 256; i++) { sum += hist[i]; if (sum >= count * .01) { lo = i; break; } }
    sum = 0;
    for (let i = 255; i >= 0; i--) { sum += hist[i]; if (sum >= count * .01) { hi = i; break; } }
    if (hi - lo < 8) continue;
    for (let i = c; i < output.data.length; i += 4) output.data[i] = (image.data[i] - lo) * 255 / (hi - lo);
  }
  return output;
}

export function workingPointsToBase(points, settings, base) {
  return points.map(p => imageAreaFromWorkingRect({ left: p.x, top: p.y, width: 0, height: 0 }, settings, base)[0]);
}

export function isSameAnalysisFrame(area, cropArea) {
  if (!validImageArea(area) || !validImageArea(cropArea)) return false;
  const bounds = points => ({ l: Math.min(...points.map(p => p.x)), r: Math.max(...points.map(p => p.x)), t: Math.min(...points.map(p => p.y)), b: Math.max(...points.map(p => p.y)) });
  const a = bounds(area), b = bounds(cropArea);
  const intersection = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const minArea = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
  return minArea > 0 && intersection / minArea > .85
    && Math.abs((a.l + a.r - b.l - b.r) / 2) < (a.r - a.l) * .45
    && Math.abs((a.t + a.b - b.t - b.b) / 2) < (a.b - a.t) * .45;
}

export function detectCropImageArea(image, crop, targets) {
  const preview = downsampleImageDataForMaxPixels(image, 1000000);
  const sx = preview.width / image.width, sy = preview.height / image.height;
  // 裁切の少し外側も見る。端をきっちり切った場合でも四辺を検出できる。
  const left = Math.max(0, Math.floor((crop.left - crop.width * .12) * sx));
  const top = Math.max(0, Math.floor((crop.top - crop.height * .12) * sy));
  const right = Math.min(preview.width, Math.ceil((crop.left + crop.width * 1.12) * sx));
  const bottom = Math.min(preview.height, Math.ceil((crop.top + crop.height * 1.12) * sy));
  const region = cropImageDataRegion(preview, { left, top, width: right - left, height: bottom - top });
  const normalized = normalizeDetectionImage(region);
  const expected = { left: crop.left * sx - left, top: crop.top * sy - top, width: crop.width * sx, height: crop.height * sy };
  const window = detectImageWindow(normalized, targets, { targeted: true }) || detectImageWindow(region, targets, { targeted: true }) || detectTargetedEdges(normalized, expected, targets);
  if (!window) return null;
  // approxPolyDP の始点・巻き方向に依存しない四隅の順序。
  const sorted = [...window.points].sort((a, b) => a.y - b.y);
  const upper = sorted.slice(0, 2).sort((a, b) => a.x - b.x), lower = sorted.slice(2).sort((a, b) => a.x - b.x);
  const points = [upper[0], upper[1], lower[1], lower[0]].map(p => ({ x: (p.x + left) / sx, y: (p.y + top) / sy }));
  const cropPoints = [{ x: crop.left, y: crop.top }, { x: crop.left + crop.width, y: crop.top }, { x: crop.left + crop.width, y: crop.top + crop.height }, { x: crop.left, y: crop.top + crop.height }];
  if (!isSameAnalysisFrame(points, cropPoints)) return null;
  // 輪郭そのものは解析に含めず、薄い境界や端文字のにじみを除外する。
  const center = points.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
  return points.map(p => ({ x: center.x + (p.x - center.x) * .98, y: center.y + (p.y - center.y) * .98 }));
}

// 模様が輪郭につながって閉じた contour にならない場合は、指定枠の四辺付近で
// 長く連続するエッジを探す。四辺の支持・比率・外側の均一性が揃う場合だけ採用。
function detectTargetedEdges(image, expected, targets) {
  const cv = globalThis.cv;
  if (!cv?.Sobel) return null;
  const src = cv.matFromImageData(image), gray = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
    const find = (vertical, position, spanStart, spanLength, radius) => {
      const limit = vertical ? image.width : image.height;
      const data = vertical ? gx.data32F : gy.data32F;
      let best = null;
      for (let p = Math.max(4, Math.floor(position - radius)); p <= Math.min(limit - 5, position + radius); p++) {
        const values = [];
        for (let j = 0; j < 51; j++) {
          const q = Math.round(spanStart + spanLength * (.1 + .8 * j / 50));
          const index = vertical ? q * image.width + p : p * image.width + q;
          values.push(Math.abs(data[index] || 0));
        }
        values.sort((a, b) => a - b);
        const score = values[25];
        if (score >= 35 && (!best || score > best.score)) best = { p, score };
      }
      return best?.p;
    };
    const l = find(true, expected.left, expected.top, expected.height, expected.width * .10);
    const r = find(true, expected.left + expected.width, expected.top, expected.height, expected.width * .10);
    const t = find(false, expected.top, expected.left, expected.width, expected.height * .10);
    const b = find(false, expected.top + expected.height, expected.left, expected.width, expected.height * .10);
    if ([l, r, t, b].some(v => v === undefined) || r <= l || b <= t) return null;
    const ratio = Math.max(r - l, b - t) / Math.min(r - l, b - t);
    if (!targets.some(v => Math.abs(ratio / v.ratio - 1) < .09)) return null;
    const points = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
    return boundaryEvidence(image, points, true) ? { points } : null;
  } finally { src.delete(); gray.delete(); gx.delete(); gy.delete(); }
}
