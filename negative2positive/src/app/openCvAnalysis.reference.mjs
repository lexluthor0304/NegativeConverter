// Frozen copies of the page's OpenCV analyses as they were before #245 split
// them between the page and the auto-frame worker (integration tip 084cc1f,
// which is 1703835 plus #244's `preview` option). Parity tests run these
// against the split halves; nothing else imports this file.

import { detectImageWindow, boundaryEvidence } from './imageWindowDetector.js';
import { downsampleImageDataForMaxPixels, cropImageDataRegion } from './imageDataOps.js';
import { isSameAnalysisFrame } from './cropColorAnalysis.js';
import { resolveExpiredBounds, resolveExpiredSamplePlane } from '../pipeline/expiredRescue.js';

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

// `preview`, when given, must be downsampleImageDataForMaxPixels(image,
// 1000000); `image` then only supplies the frame's size (#244).
export function detectCropImageArea(image, crop, targets, { preview: sample = null } = {}) {
  const preview = sample || downsampleImageDataForMaxPixels(image, 1000000);
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

function getCv() {
  const cv = globalThis.cv;
  if (!cv || !cv.Mat) throw new Error('OpenCV is not loaded');
  return cv;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function odd(value) {
  const n = Math.max(3, Math.round(value));
  return n % 2 ? n : n + 1;
}

// Area-averaged RGBA copy of `bounds` at `width` pixels wide.
function downsampleBounds(image, plane, bounds, width) {
  const scale = width / bounds.width;
  const height = Math.max(8, Math.round(bounds.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const lum = new Float32Array(width * height);
  const { data } = plane;
  const toByte = plane.bits === 16 ? 1 / 257 : 1;
  for (let y = 0; y < height; y++) {
    const sy0 = bounds.top + Math.floor((y / height) * bounds.height);
    const sy1 = Math.max(sy0 + 1, bounds.top + Math.floor(((y + 1) / height) * bounds.height));
    for (let x = 0; x < width; x++) {
      const sx0 = bounds.left + Math.floor((x / width) * bounds.width);
      const sx1 = Math.max(sx0 + 1, bounds.left + Math.floor(((x + 1) / width) * bounds.width));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * image.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          if (!data[i + 3]) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * width + x) * 4;
      if (n) {
        rgba[o] = (r / n) * toByte;
        rgba[o + 1] = (g / n) * toByte;
        rgba[o + 2] = (b / n) * toByte;
      }
      rgba[o + 3] = 255;
      lum[y * width + x] = (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
    }
  }
  return { rgba, lum, width, height };
}

/**
 * Low-resolution maps of the analysis region: per-channel local dark floor
 * (`low`, three grids), local luminance mean (`mean`), the grid size and the
 * region's placement in the frame (`fraction`, normalised).
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint16Array,__image16?:object}} image
 * @param {{region?:object, borderBuffer?:number, placement?:object, workingWidth?:number, gridWidth?:number}} [options]
 */
export function measureExpiredSpatialMaps(image, options = {}) {
  const cv = getCv();
  const plane = resolveExpiredSamplePlane(image);
  if (!plane) return null;
  const bounds = resolveExpiredBounds(image, options);
  if (bounds.width < 8 || bounds.height < 8) return null;
  const workingWidth = clamp(Math.round(options.workingWidth || 160), 32, 512);
  const small = downsampleBounds(image, plane, bounds, workingWidth);
  const gridWidth = clamp(Math.round(options.gridWidth || 32), 4, 64);
  const gridHeight = Math.max(3, Math.round(gridWidth * small.height / small.width));
  const placement = options.placement && typeof options.placement === 'object' ? options.placement : { left: 0, top: 0, width: 1, height: 1 };
  const fraction = {
    left: placement.left + (bounds.left / image.width) * placement.width,
    top: placement.top + (bounds.top / image.height) * placement.height,
    width: (bounds.width / image.width) * placement.width,
    height: (bounds.height / image.height) * placement.height
  };

  const mats = [];
  const track = (mat) => { mats.push(mat); return mat; };
  try {
    const src = track(cv.matFromArray(small.height, small.width, cv.CV_8UC4, small.rgba));
    const rgb = track(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const f32 = track(new cv.Mat());
    rgb.convertTo(f32, cv.CV_32FC3, 1 / 255);
    const channels = new cv.MatVector();
    cv.split(f32, channels);
    const kernelSize = odd(small.width * 0.22);
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize)));
    const gridSize = new cv.Size(gridWidth, gridHeight);
    const low = [];
    try {
      for (let c = 0; c < 3; c++) {
        const channel = track(channels.get(c));
        const eroded = track(new cv.Mat());
        cv.erode(channel, eroded, kernel);
        // A light blur only (anti-aliasing before the resize): a wide one would
        // leak a bright region's high floor into its neighbours. The quadratic
        // fit in pipeline/expiredRescue.js is what smooths the surface.
        const blurred = track(new cv.Mat());
        cv.GaussianBlur(eroded, blurred, new cv.Size(0, 0), small.width * 0.04, 0, cv.BORDER_REPLICATE);
        const grid = track(new cv.Mat());
        cv.resize(blurred, grid, gridSize, 0, 0, cv.INTER_AREA);
        low.push(Float32Array.from(grid.data32F));
      }
    } finally {
      channels.delete();
    }
    const lum = track(cv.matFromArray(small.height, small.width, cv.CV_32FC1, small.lum));
    const lumBlur = track(new cv.Mat());
    cv.GaussianBlur(lum, lumBlur, new cv.Size(0, 0), small.width * 0.05, 0, cv.BORDER_REPLICATE);
    const meanGrid = track(new cv.Mat());
    cv.resize(lumBlur, meanGrid, gridSize, 0, 0, cv.INTER_AREA);
    const mean = Float32Array.from(meanGrid.data32F);
    return { gridWidth, gridHeight, low, mean, fraction, working: { width: small.width, height: small.height } };
  } finally {
    for (const mat of mats) {
      try { mat.delete(); } catch { /* already released */ }
    }
  }
}
