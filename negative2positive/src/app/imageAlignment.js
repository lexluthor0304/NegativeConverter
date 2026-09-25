// Feature-based image alignment on OpenCV.js (ORB + brute-force Hamming
// matching + RANSAC homography). Shared by "match a lab scan" (align the
// lab's JPEG to our conversion) and the multi-shot merge (align brackets to
// the first frame). The grey sampling needs no OpenCV, so the page can sample
// and a worker can match; everything else requires `globalThis.cv` to be
// loaded, and every function releases its Mats.

function getCv() {
  const cv = globalThis.cv;
  if (!cv || !cv.Mat) throw new Error('OpenCV is not loaded');
  return cv;
}

// The common longer side two images are sampled at for matching.
export function alignmentSide(reference, moving, maxSide = 1000) {
  return Math.min(maxSide, Math.max(reference.width, reference.height, moving.width, moving.height));
}

// Grey 8-bit samples of an ImageData resampled so its longer side is `side`
// (nearest neighbour, up or down), plus the scale used.
export function sampleAlignmentGray(imageData, side) {
  const scale = side / Math.max(imageData.width, imageData.height);
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const gray = new Uint8Array(width * height);
  const data = imageData.data;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(imageData.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(imageData.width - 1, Math.floor(x / scale));
      const i = (sy * imageData.width + sx) * 4;
      gray[y * width + x] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
  }
  return { gray, scale, width, height };
}

function grayMat(cv, sample) {
  const mat = new cv.Mat(sample.height, sample.width, cv.CV_8UC1);
  mat.data.set(sample.gray);
  return mat;
}

// Estimates the homography that maps `moving` pixels into `reference` pixels
// (both in full-resolution coordinates) from two grey samples taken at the
// same side by sampleAlignmentGray. Returns null when the match is too weak;
// the caller then falls back to unaligned statistics.
export function matchAlignment(reference, moving, { features = 2000, minInliers = 12, ransacThreshold = 4 } = {}) {
  const cv = getCv();
  const refGray = grayMat(cv, reference);
  const movGray = grayMat(cv, moving);
  const orb = new cv.ORB(features);
  const kpRef = new cv.KeyPointVector(); const kpMov = new cv.KeyPointVector();
  const descRef = new cv.Mat(); const descMov = new cv.Mat();
  const noMask = new cv.Mat();
  const matches = new cv.DMatchVector();
  let matcher = null; let srcPoints = null; let dstPoints = null; let mask = null; let homography = null;
  try {
    orb.detectAndCompute(refGray, noMask, kpRef, descRef);
    orb.detectAndCompute(movGray, noMask, kpMov, descMov);
    if (descRef.rows < 8 || descMov.rows < 8) return null;
    matcher = new cv.BFMatcher(cv.NORM_HAMMING, true);
    matcher.match(descMov, descRef, matches);
    const good = [];
    for (let i = 0; i < matches.size(); i++) good.push(matches.get(i));
    good.sort((a, b) => a.distance - b.distance);
    const kept = good.slice(0, Math.max(minInliers, Math.floor(good.length * 0.8)));
    if (kept.length < minInliers) return null;
    const src = []; const dst = [];
    for (const m of kept) {
      const p = kpMov.get(m.queryIdx).pt; const q = kpRef.get(m.trainIdx).pt;
      src.push(p.x / moving.scale, p.y / moving.scale);
      dst.push(q.x / reference.scale, q.y / reference.scale);
    }
    srcPoints = cv.matFromArray(kept.length, 1, cv.CV_32FC2, src);
    dstPoints = cv.matFromArray(kept.length, 1, cv.CV_32FC2, dst);
    mask = new cv.Mat();
    homography = cv.findHomography(srcPoints, dstPoints, cv.RANSAC, ransacThreshold / Math.min(reference.scale, moving.scale), mask);
    if (!homography || homography.empty()) return null;
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
    if (inliers < minInliers) return null;
    const h = Array.from(homography.data64F);
    // Reject wild transforms (the top-left 2x2 must stay near a similarity).
    const scaleX = Math.hypot(h[0], h[3]); const scaleY = Math.hypot(h[1], h[4]);
    if (scaleX < 0.25 || scaleX > 4 || scaleY < 0.25 || scaleY > 4 || Math.abs(h[6]) > 1e-3 || Math.abs(h[7]) > 1e-3) return null;
    return { homography: h, inliers, matches: kept.length, keypoints: [kpRef.size(), kpMov.size()] };
  } finally {
    for (const m of [refGray, movGray, descRef, descMov, noMask, srcPoints, dstPoints, mask, homography]) m?.delete?.();
    kpRef.delete(); kpMov.delete(); matches.delete(); orb.delete(); matcher?.delete?.();
  }
}

// Both images are brought to the same longer side (the smaller one is
// upscaled): a lab JPEG is usually far smaller than our conversion, and ORB
// matches far better when the two frames sit at the same scale.
export function estimateAlignment(reference, moving, { maxSide = 1000, ...options } = {}) {
  getCv();
  const side = alignmentSide(reference, moving, maxSide);
  return matchAlignment(sampleAlignmentGray(reference, side), sampleAlignmentGray(moving, side), options);
}

// Maps a point through a 3x3 homography (row-major, 9 numbers).
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// Warps a 16-bit RGBA plane ({ width, height, data: Uint16Array }) into the
// reference frame of `width` x `height` pixels. Only the two 16-bit Mats live
// on the OpenCV heap (16 bytes per pixel), and the source Mat is freed before
// the result is copied out. `onCopied` runs once the source samples are on the
// heap, so the caller can drop its own copy before the output is allocated.
export function warpPlane16(plane, homography, width, height, { onCopied = null } = {}) {
  const cv = getCv();
  const H = cv.matFromArray(3, 3, cv.CV_64F, homography);
  let src16 = null; let dst16 = null;
  try {
    src16 = new cv.Mat(plane.height, plane.width, cv.CV_16UC4);
    src16.data16U.set(plane.data);
    onCopied?.();
    dst16 = new cv.Mat();
    cv.warpPerspective(src16, dst16, H, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    src16.delete(); src16 = null;
    return { width, height, data: new Uint16Array(dst16.data16U) };
  } finally {
    H.delete(); src16?.delete(); dst16?.delete();
  }
}

// Warps `moving` into the reference frame of `width` x `height` pixels.
// Untouched areas get alpha 0 so later statistics can skip them. A 16-bit
// plane is warped alongside when present. With `planeOnly` and a 16-bit
// plane, only the plane is warped (warpPlane16) and the result is
// `{ width, height, __image16 }` without 8-bit samples; the merge needs no
// more, and it keeps the 8-bit Mats off a heap a 60 MP plane nearly fills.
export function warpImageData(moving, homography, width, height, { planeOnly = false } = {}) {
  if (planeOnly && moving.__image16 && moving.__image16.data instanceof Uint16Array) {
    const source = { width: moving.width, height: moving.height, data: moving.__image16.data };
    return { width, height, __image16: warpPlane16(source, homography, width, height) };
  }
  const cv = getCv();
  const H = cv.matFromArray(3, 3, cv.CV_64F, homography);
  const size = new cv.Size(width, height);
  const src8 = cv.matFromImageData(moving);
  const dst8 = new cv.Mat();
  let src16 = null; let dst16 = null;
  try {
    cv.warpPerspective(src8, dst8, H, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    const data = new Uint8ClampedArray(dst8.data);
    const result = new ImageData(data, width, height);
    if (moving.__image16 && moving.__image16.data instanceof Uint16Array) {
      src16 = new cv.Mat(moving.height, moving.width, cv.CV_16UC4);
      src16.data16U.set(moving.__image16.data);
      dst16 = new cv.Mat();
      cv.warpPerspective(src16, dst16, H, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      result.__image16 = { width, height, data: new Uint16Array(dst16.data16U) };
    }
    return result;
  } finally {
    H.delete(); src8.delete(); dst8.delete(); src16?.delete(); dst16?.delete();
  }
}
