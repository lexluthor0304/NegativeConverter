// Standalone Node test for imageAlignment.js - run with:
// node negative2positive/src/app/imageAlignment.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};
const { estimateAlignment, applyHomography, warpImageData, warpPlane16, sampleAlignmentGray, matchAlignment, alignmentSide } = await import('./imageAlignment.js');
const head = await import('./multiShot.reference.mjs');

// A textured synthetic photo: soft blobs plus a fine grid, enough ORB corners.
const W = 480; const H = 320;
function texture(x, y) {
  let v = 128 + 60 * Math.sin(x / 23) * Math.cos(y / 17) + 40 * Math.sin((x + y) / 9);
  for (const [cx, cy, r] of [[120, 90, 40], [330, 210, 55], [400, 70, 25], [80, 250, 30]]) {
    if (Math.hypot(x - cx, y - cy) < r) v = 40 + (cx + cy) % 90;
  }
  if (x % 40 < 3 || y % 40 < 3) v = 230;
  return v;
}
function make(pixel) {
  const data = new Uint8ClampedArray(W * H * 4);
  const plane = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b, a] = pixel(x, y);
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    plane[i] = r * 257; plane[i + 1] = g * 257; plane[i + 2] = b * 257; plane[i + 3] = a * 257;
  }
  const image = new ImageData(data, W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}
const reference = make((x, y) => { const v = texture(x, y); return [v, v * 0.9, v * 0.8, 255]; });

// The moving image is the reference shifted by (18, -11) px and rotated 3 degrees
// about the centre, with a colour shift so the aligner must ignore colour.
const angle = 3 * Math.PI / 180;
const shift = { x: 18, y: -11 };
function movingFromReference(x, y) {
  // Inverse mapping: where does moving pixel (x, y) come from in the reference?
  const cx = x - W / 2 - shift.x; const cy = y - H / 2 - shift.y;
  const sx = cx * Math.cos(-angle) - cy * Math.sin(-angle) + W / 2;
  const sy = cx * Math.sin(-angle) + cy * Math.cos(-angle) + H / 2;
  return [sx, sy];
}
const moving = make((x, y) => {
  const [sx, sy] = movingFromReference(x, y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return [0, 0, 0, 0];
  const v = texture(Math.round(sx), Math.round(sy));
  return [v * 0.8, v * 0.95, Math.min(255, v * 1.1), 255];
});

{
  const result = estimateAlignment(reference, moving, { maxSide: 480 });
  assert.ok(result, 'alignment found');
  assert.ok(result.inliers >= 12, `inliers ${result.inliers}`);
  // The homography maps moving pixels onto the reference: check three points.
  let worst = 0;
  for (const [x, y] of [[100, 100], [300, 200], [420, 60]]) {
    const [sx, sy] = movingFromReference(x, y);
    const mapped = applyHomography(result.homography, x, y);
    worst = Math.max(worst, Math.hypot(mapped.x - sx, mapped.y - sy));
  }
  assert.ok(worst < 1.5, `homography error ${worst.toFixed(2)} px`);

  // Warping the moving image into the reference frame reproduces the reference texture.
  const warped = warpImageData(moving, result.homography, W, H);
  assert.equal(warped.width, W);
  assert.ok(warped.__image16 && warped.__image16.data.length === W * H * 4, '16-bit plane warped too');
  let diff = 0; let n = 0; let transparent = 0;
  for (let y = 20; y < H - 20; y += 4) for (let x = 20; x < W - 20; x += 4) {
    const i = (y * W + x) * 4;
    if (warped.data[i + 3] === 0) { transparent++; continue; }
    // Compare luminance shapes: the moving image had a colour shift, so compare
    // the green channel scaled back.
    diff += Math.abs(warped.data[i + 1] / 0.95 - reference.data[i + 1] / 0.9);
    n++;
  }
  assert.ok(n > 1000 && diff / n < 12, `warped texture differs by ${(diff / n).toFixed(1)} over ${n} samples`);
  assert.ok(transparent > 0, 'areas outside the moving frame stay transparent');
}

// A moving image at half size (a small lab JPEG) still aligns: both frames are
// brought to a common scale before matching, and the homography carries the
// 2x scale back to full-resolution coordinates.
{
  const half = new ImageData(new Uint8ClampedArray((W / 2) * (H / 2) * 4), W / 2, H / 2);
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
    const si = ((y * 2) * W + x * 2) * 4; const di = (y * (W / 2) + x) * 4;
    half.data[di] = moving.data[si]; half.data[di + 1] = moving.data[si + 1]; half.data[di + 2] = moving.data[si + 2]; half.data[di + 3] = moving.data[si + 3];
  }
  const result = estimateAlignment(reference, half, { maxSide: 480 });
  assert.ok(result, 'half-size image aligned');
  assert.ok(result.inliers >= 12, `half-size inliers ${result.inliers}`);
  let worst = 0;
  for (const [x, y] of [[40, 40], [200, 60], [100, 240], [420, 280]]) {
    const [sx, sy] = movingFromReference(x, y);
    const mapped = applyHomography(result.homography, x / 2, y / 2);
    worst = Math.max(worst, Math.hypot(mapped.x - sx, mapped.y - sy));
  }
  assert.ok(worst < 3, `half-size homography error ${worst.toFixed(2)} px`);
}

// Unrelated content yields no alignment rather than a wild one.
{
  const noise = make((x, y) => { const v = ((x * 1103515245 + y * 12345) >>> 8) & 255; return [v, v, v, 255]; });
  const result = estimateAlignment(reference, noise, { maxSide: 480 });
  assert.ok(result === null || result.inliers < 40, 'noise does not align confidently');
}

// ---- #260: split sampling, planeOnly warp, parity with 1703835 ----
const sameArray = (a, b, label) => {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${label}: element ${i} is ${a[i]}, expected ${b[i]}`);
};
{
  // Sampling on the page and matching elsewhere gives the very homography
  // estimateAlignment (and the 1703835 implementation) returns.
  for (const [ref, mov, maxSide] of [[reference, moving, 480], [reference, moving, 300], [moving, reference, 1200]]) {
    const side = alignmentSide(ref, mov, maxSide);
    const split = matchAlignment(sampleAlignmentGray(ref, side), sampleAlignmentGray(mov, side));
    const whole = estimateAlignment(ref, mov, { maxSide });
    const before = head.estimateAlignment(ref, mov, { maxSide });
    assert.ok(split && whole && before, `aligned at side ${side}`);
    assert.deepEqual(split, whole, `split == estimateAlignment at side ${side}`);
    assert.deepEqual(whole, before, `estimateAlignment == 1703835 at side ${side}`);
  }
  const sample = sampleAlignmentGray(moving, 240);
  assert.equal(sample.width, 240); assert.equal(sample.height, 160); assert.equal(sample.scale, 0.5);
  assert.ok(sample.gray instanceof Uint8Array && sample.gray.length === 240 * 160);

  // A 16-bit source with detail below the 8-bit samples, and a perspective
  // homography, so the plane warp is not a copy of the widened 8-bit warp.
  const detailed = make((x, y) => { const v = texture(x, y); return [v, v * 0.9, v * 0.8, 255]; });
  for (let i = 0; i < detailed.__image16.data.length; i++) if (i % 4 !== 3) detailed.__image16.data[i] += (i * 7919) % 257;
  const perspective = [0.98, 0.04, 9.5, -0.03, 1.01, -6.25, 2e-5, -1.5e-5, 1];
  const full = warpImageData(detailed, perspective, W, H);
  const expected = head.warpImageData(detailed, perspective, W, H);
  sameArray(full.data, expected.data, 'default warp 8-bit == 1703835');
  sameArray(full.__image16.data, expected.__image16.data, 'default warp 16-bit == 1703835');
  const planeOnly = warpImageData(detailed, perspective, W, H, { planeOnly: true });
  assert.equal(planeOnly.data, undefined, 'planeOnly returns no 8-bit samples');
  assert.equal(planeOnly.__image16.width, W);
  sameArray(planeOnly.__image16.data, full.__image16.data, 'planeOnly == warpImageData().__image16');
  const consumed = { width: W, height: H, data: detailed.__image16.data.slice() };
  const direct = warpPlane16(consumed, perspective, W, H, { consume: true });
  assert.equal(consumed.data, null, 'consume drops the source samples');
  sameArray(direct.data, full.__image16.data, 'warpPlane16 == warpImageData().__image16');

  // With matFromImageData unusable the plane warp still succeeds: it never
  // creates the 8-bit Mats. An 8-bit-only source keeps the 8-bit warp.
  const original = cv.matFromImageData;
  cv.matFromImageData = () => { throw new Error('8-bit Mat created'); };
  try {
    const guarded = warpImageData(detailed, perspective, W, H, { planeOnly: true });
    sameArray(guarded.__image16.data, full.__image16.data, 'planeOnly without 8-bit Mats');
    const eight = new ImageData(detailed.data.slice(), W, H);
    assert.throws(() => warpImageData(eight, perspective, W, H, { planeOnly: true }), /8-bit Mat created/, '8-bit sources keep the 8-bit warp');
  } finally { cv.matFromImageData = original; }
  const eight = new ImageData(detailed.data.slice(), W, H);
  sameArray(warpImageData(eight, perspective, W, H, { planeOnly: true }).data, head.warpImageData(eight, perspective, W, H).data, '8-bit source, planeOnly == 1703835');
}

console.log('imageAlignment.test.mjs passed');
