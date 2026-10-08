// The deterministic auto-frame preview (#251 part 2) and the line-search
// plane choice (part 4b).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { areaResampleImageData, areaResizeToMaxSide, rotatePreviewImageData, blockChromaP95, planLineSearch } = await import('./autoFramePreview.js');
const { rotatedDimensions } = await import('./imageGeometry.js');
const { GOLDEN_PREVIEW_CASES, GOLDEN_PREVIEW_SHA256, goldenPreviewSource } = await import('../../test-fixtures/autoFramePreviewGolden.mjs');

let seed = 5;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randomImage = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : Math.floor(random() * 256);
  return new ImageData(data, width, height);
};

// Golden bytes: the same SHA-256 in every engine (the smoke suite checks
// Chrome against these constants).
GOLDEN_PREVIEW_CASES.forEach((golden, index) => {
  const preview = areaResizeToMaxSide(goldenPreviewSource(golden), golden.maxSide);
  const sha = createHash('sha256').update(preview.data).digest('hex');
  assert.equal(sha, GOLDEN_PREVIEW_SHA256[index], `golden preview ${golden.width}x${golden.height}`);
});

// The size of the canvas resizer it replaces, and a frame already small
// enough is returned as it is.
for (const [w, h] of [[9504, 6320], [6336, 9504], [4000, 2672], [1601, 1600], [3, 1700]]) {
  const scale = 1600 / Math.max(w, h);
  const expected = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  const tiny = { width: w, height: h, data: null };
  if (w * h <= 4_000_000) {
    const out = areaResizeToMaxSide({ ...randomImage(w, h) }, 1600);
    assert.deepEqual({ width: out.width, height: out.height }, expected, `${w}x${h}`);
  }
  assert.ok(tiny);
}
const small = randomImage(40, 30);
assert.equal(areaResizeToMaxSide(small, 40), small);

// Exact area average: against rational coverage sums (BigInt), rounded half up.
function areaReference(image, width, height) {
  const { width: W, height: H, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  const overlap = (a0, a1, b0, b1) => BigInt(Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sums = [0n, 0n, 0n];
    for (let t = 0; t < H; t++) {
      const wy = overlap(y * H, (y + 1) * H, t * height, (t + 1) * height);
      if (!wy) continue;
      for (let s = 0; s < W; s++) {
        const wx = overlap(x * W, (x + 1) * W, s * width, (s + 1) * width);
        if (!wx) continue;
        for (let c = 0; c < 3; c++) sums[c] += wx * wy * BigInt(data[(t * W + s) * 4 + c]);
      }
    }
    const total = BigInt(W * H);
    for (let c = 0; c < 3; c++) out[(y * width + x) * 4 + c] = Number((2n * sums[c] + total) / (2n * total));
    out[(y * width + x) * 4 + 3] = 255;
  }
  return out;
}
// The last two exceed the 16-bit lanes (a cell's interior is summed per row).
for (const [W, H, w, h] of [[17, 13, 5, 4], [40, 30, 40, 30], [37, 23, 36, 22], [64, 48, 7, 5], [9, 50, 2, 11], [101, 3, 13, 1], [300, 300, 3, 3], [520, 300, 2, 1]]) {
  const image = randomImage(W, H);
  assert.deepEqual(areaResampleImageData(image, w, h).data, areaReference(image, w, h), `area ${W}x${H} -> ${w}x${h}`);
}
// The word reader and the byte reader agree (an unaligned view has no words).
{
  const image = randomImage(33, 21);
  const shifted = new Uint8ClampedArray(image.data.length + 1).subarray(1);
  shifted.set(image.data);
  assert.deepEqual(areaResampleImageData(new ImageData(shifted, 33, 21), 10, 7).data, areaResampleImageData(image, 10, 7).data);
}

// Preview rotation: the size rule of every rotation, identity at 0, and the
// 16-bit core's inverse map (float bilinear on 8-bit samples) to within the
// 2^-16 quantisation of cos / sin.
function rotationReference(image, angle) {
  const w = image.width, h = image.height, frame = rotatedDimensions(w, h, angle);
  const rad = angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const out = new Float64Array(frame.width * frame.height * 4).fill(-1);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const u = x + 0.5 - frame.width / 2, v = y + 0.5 - frame.height / 2;
    const sx = w / 2 + u * cos + v * sin - 0.5, sy = h / 2 - u * sin + v * cos - 0.5;
    const o = (y * frame.width + x) * 4;
    if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) { out[o + 3] = 0; continue; }
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
    for (let c = 0; c < 3; c++) {
      const at = (xx, yy) => image.data[(yy * w + xx) * 4 + c];
      const upper = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
      const lower = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
      out[o + c] = upper + (lower - upper) * fy;
    }
    out[o + 3] = 255;
  }
  return { frame, out };
}
{
  const image = randomImage(61, 43);
  const same = rotatePreviewImageData(image, 0);
  assert.deepEqual(same.data, image.data.map((v, i) => ((i & 3) === 3 ? 255 : v)), 'angle 0 is the identity');
  let worst = 0, edgeSamples = 0;
  for (const angle of [0.15, -0.37, 1.3, -2, 5, -12.5, 30, 44.9, -45]) {
    const rotated = rotatePreviewImageData(image, angle);
    const { frame, out } = rotationReference(image, angle);
    assert.deepEqual({ width: rotated.width, height: rotated.height }, frame, `size at ${angle}`);
    for (let i = 0; i < out.length; i += 4) {
      // Pixels on the image border (the transparency test) may flip only
      // where the float position sits within 2^-16 of the boundary.
      if ((out[i + 3] === 0) !== (rotated.data[i + 3] === 0)) { edgeSamples++; continue; }
      if (out[i + 3] === 0) { assert.equal(rotated.data[i] | rotated.data[i + 1] | rotated.data[i + 2], 0); continue; }
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rotated.data[i + c] - out[i + c]));
    }
  }
  assert.ok(worst <= 1, `rotation within one level of the float map (${worst})`);
  assert.ok(edgeSamples <= 4, `border decisions agree (${edgeSamples} differ)`);
}

// Block chroma p95: against a sort of every full block's chroma.
function chromaReference(image) {
  const values = [];
  for (let by = 0; by + 4 <= image.height; by += 4) for (let bx = 0; bx + 4 <= image.width; bx += 4) {
    const sums = [0, 0, 0];
    for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) for (let c = 0; c < 3; c++) sums[c] += image.data[(y * image.width + x) * 4 + c];
    values.push((Math.max(...sums) - Math.min(...sums)) / 16);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) * 0.95)];
}
for (const [w, h] of [[50, 37], [8, 8], [3, 40], [129, 67]]) {
  const image = randomImage(w, h);
  assert.equal(blockChromaP95(image), chromaReference(image), `chroma ${w}x${h}`);
}

// The plane choice.
const neutral = (() => {
  const image = randomImage(160, 120);
  for (let i = 0; i < image.data.length; i += 4) {
    const grey = image.data[i];
    image.data[i + 1] = Math.min(255, grey + Math.floor(random() * 5));
    image.data[i + 2] = Math.max(0, grey - Math.floor(random() * 5));
  }
  return image;
})();
const orangeMask = (() => {
  const image = randomImage(160, 120);
  for (let i = 0; i < image.data.length; i += 4) {
    const t = image.data[i] / 255;
    image.data[i] = 150 + 90 * t; image.data[i + 1] = 90 + 60 * t; image.data[i + 2] = 50 + 40 * t;
  }
  return image;
})();
assert.deepEqual(planLineSearch(orangeMask, { enabled: false }).record, { channels: 'rgb', reason: 'off', chromaP95: null });
assert.deepEqual(planLineSearch(orangeMask, { enabled: false }).channels, [-1, 0, 1, 2], 'the kill switch keeps four channels');
assert.deepEqual(planLineSearch(orangeMask, { enabled: true, filmType: 'color' }).channels, [-1, 0, 1, 2]);
assert.equal(planLineSearch(orangeMask, { enabled: true, filmType: 'color' }).record.reason, 'colour');
assert.ok(planLineSearch(orangeMask, { enabled: true }).record.chromaP95 > 40, 'an orange mask is far from neutral');
for (const filmType of ['bw', 'blackWhite', 'bwNegative', 'bwPositive']) {
  assert.deepEqual(planLineSearch(orangeMask, { enabled: true, filmType }), { channels: [-1], record: { channels: 'grey', reason: 'bw-film', chromaP95: null } });
}
const neutralPlan = planLineSearch(neutral, { enabled: true, filmType: 'positive' });
assert.deepEqual(neutralPlan.channels, [-1]);
assert.equal(neutralPlan.record.reason, 'neutral');
assert.ok(neutralPlan.record.chromaP95 < 10);
assert.equal(planLineSearch(randomImage(3, 3), { enabled: true }).record.reason, 'colour', 'no full block: four channels');

console.log('autoFramePreview: golden preview bytes, exact area average, preview rotation map, block chroma and line-search planes');
