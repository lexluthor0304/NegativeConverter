// Feature-based image alignment on OpenCV.js (ORB + brute-force Hamming
// matching + RANSAC homography). Shared by "match a lab scan" (align the
// lab's JPEG to our conversion) and the multi-shot merge (align brackets to
// the first frame). Requires `globalThis.cv` to be loaded; every function
// releases its Mats.

function getCv() {
  const cv = globalThis.cv;
  if (!cv || !cv.Mat) throw new Error('OpenCV is not loaded');
  return cv;
}

// Grey 8-bit Mat of an ImageData downscaled to `maxSide`, plus the scale used.
function toGray(cv, imageData, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const gray = new cv.Mat(height, width, cv.CV_8UC1);
  const data = imageData.data;
  const out = gray.data;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(imageData.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(imageData.width - 1, Math.floor(x / scale));
      const i = (sy * imageData.width + sx) * 4;
      out[y * width + x] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
  }
  return { gray, scale, width, height };
}

// Estimates the homography that maps `moving` pixels into `reference` pixels
// (both in full-resolution coordinates). Returns null when the match is too
// weak; the caller then falls back to unaligned statistics.
export function estimateAlignment(reference, moving, { maxSide = 1000, features = 2000, minInliers = 12, ransacThreshold = 4 } = {}) {
  const cv = getCv();
  const ref = toGray(cv, reference, maxSide);
  const mov = toGray(cv, moving, maxSide);
  const orb = new cv.ORB(features);
  const kpRef = new cv.KeyPointVector(); const kpMov = new cv.KeyPointVector();
  const descRef = new cv.Mat(); const descMov = new cv.Mat();
  const noMask = new cv.Mat();
  const matches = new cv.DMatchVector();
  let matcher = null; let srcPoints = null; let dstPoints = null; let mask = null; let homography = null;
  try {
    orb.detectAndCompute(ref.gray, noMask, kpRef, descRef);
    orb.detectAndCompute(mov.gray, noMask, kpMov, descMov);
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
      src.push(p.x / mov.scale, p.y / mov.scale);
      dst.push(q.x / ref.scale, q.y / ref.scale);
    }
    srcPoints = cv.matFromArray(kept.length, 1, cv.CV_32FC2, src);
    dstPoints = cv.matFromArray(kept.length, 1, cv.CV_32FC2, dst);
    mask = new cv.Mat();
    homography = cv.findHomography(srcPoints, dstPoints, cv.RANSAC, ransacThreshold / Math.min(ref.scale, mov.scale), mask);
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
    for (const m of [ref.gray, mov.gray, descRef, descMov, noMask, srcPoints, dstPoints, mask, homography]) m?.delete?.();
    kpRef.delete(); kpMov.delete(); matches.delete(); orb.delete(); matcher?.delete?.();
  }
}

// Maps a point through a 3x3 homography (row-major, 9 numbers).
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// Warps `moving` into the reference frame of `width` x `height` pixels.
// Untouched areas get alpha 0 so later statistics can skip them. A 16-bit
// plane is warped alongside when present.
export function warpImageData(moving, homography, width, height) {
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
