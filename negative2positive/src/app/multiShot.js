// Multi-shot merge for camera scanning: several shots of the same negative,
// already aligned into one frame (imageAlignment.js), combined in linear
// light. "average" reduces sensor noise (and drops a moving speck when three
// or more frames disagree), "hdr" weights each frame by how well its pixels
// are exposed so bracketed shots recover the dense highlights of a thick
// negative. Frames carry alpha 0 where the warp left no data; those pixels
// are skipped. Pure functions on 16-bit RGBA planes.

const STEPS = 4096;
const LINEAR = new Float32Array(STEPS + 1);
for (let i = 0; i <= STEPS; i++) LINEAR[i] = Math.pow(i / STEPS, 2.2);

function toLinear(value16) {
  const idx = (value16 / 65535) * STEPS;
  const i0 = Math.floor(idx); const f = idx - i0;
  return LINEAR[i0] * (1 - f) + LINEAR[Math.min(STEPS, i0 + 1)] * f;
}

function encode(linear) {
  return Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 65535);
}

// Exposure of `frame` relative to `reference` (frame ≈ reference * ratio) from
// the median luminance ratio over pixels both frames expose well.
export function estimateExposureRatio(reference, frame, { step = 4 } = {}) {
  if (!reference || !frame || reference.width !== frame.width || reference.height !== frame.height) return 1;
  const ratios = [];
  const n = reference.width * reference.height;
  const stride = Math.max(1, Math.round(step));
  for (let p = 0; p < n; p += stride) {
    const o = p * 4;
    if (reference.data[o + 3] === 0 || frame.data[o + 3] === 0) continue;
    const lr = 0.2126 * toLinear(reference.data[o]) + 0.7152 * toLinear(reference.data[o + 1]) + 0.0722 * toLinear(reference.data[o + 2]);
    const lf = 0.2126 * toLinear(frame.data[o]) + 0.7152 * toLinear(frame.data[o + 1]) + 0.0722 * toLinear(frame.data[o + 2]);
    if (lr < 0.03 || lr > 0.85 || lf < 0.03 || lf > 0.85) continue;
    ratios.push(lf / lr);
  }
  if (ratios.length < 50) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

// Well-exposedness weight of a raw (display-encoded, 0..1) value: highest in
// the mid-tones, zero at the clipping ends.
function hatWeight(value) {
  const d = Math.abs(value - 0.5) / 0.5;
  const w = 1 - d * d * d;
  return w < 0.02 ? 0 : w;
}

// 16-bit view of a decoded image: the loader's plane when the file carried
// 16 bits, otherwise the 8-bit samples widened.
export function toImage16(imageData) {
  if (imageData.__image16 && imageData.__image16.data instanceof Uint16Array) return imageData.__image16;
  const { width, height, data } = imageData;
  const out = new Uint16Array(width * height * 4);
  for (let i = 0; i < out.length; i++) out[i] = data[i] * 257;
  return { width, height, data: out };
}

// The rectangle (in reference pixels) covered by every frame: the columns and
// rows where at least `minCoverage` of the pixels carry data in all frames, so
// the wedges a warp leaves along the edges are trimmed away.
export function coverageRect(frames, { minCoverage = 0.98 } = {}) {
  const { width, height } = frames[0].image16;
  const full = { left: 0, top: 0, width, height };
  if (frames.length < 2) return full;
  const colCount = new Uint32Array(width);
  const rowCount = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (y * width + x) * 4 + 3;
      let covered = true;
      for (let i = 0; i < frames.length; i++) if (frames[i].image16.data[a] === 0) { covered = false; break; }
      if (covered) { colCount[x]++; rowCount[y]++; }
    }
  }
  let left = 0; while (left < width && colCount[left] < minCoverage * height) left++;
  let right = width - 1; while (right > left && colCount[right] < minCoverage * height) right--;
  let top = 0; while (top < height && rowCount[top] < minCoverage * width) top++;
  let bottom = height - 1; while (bottom > top && rowCount[bottom] < minCoverage * width) bottom--;
  if (right - left < 16 || bottom - top < 16) return full;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// Merges aligned frames. `frames` = [{ image16, ratio }] with the same size;
// `ratio` is each frame's exposure relative to frame 0. The result is
// expressed at the darkest bracket's exposure, so anything a frame captured
// without clipping stays unclipped in the 16-bit output (the conversion's
// film-base analysis normalises brightness afterwards). `region` crops the
// output to a rectangle of the reference; `opaque` forces full alpha.
export function mergeFrames(frames, { mode = 'average', region = null, opaque = false } = {}) {
  if (!Array.isArray(frames) || !frames.length) return null;
  const { width, height } = frames[0].image16;
  for (const f of frames) if (f.image16.width !== width || f.image16.height !== height) return null;
  let scale = 1;
  for (const f of frames) scale = Math.min(scale, f.ratio > 0 ? f.ratio : 1);
  const rect = region || { left: 0, top: 0, width, height };
  const outWidth = rect.width; const outHeight = rect.height;
  const out = new Uint16Array(outWidth * outHeight * 4);
  const n = frames.length;
  const values = new Float32Array(n);
  const weights = new Float32Array(n);
  const pixels = outWidth * outHeight;
  for (let p = 0; p < pixels; p++) {
    const x = p % outWidth; const y = (p - x) / outWidth;
    const o = ((y + rect.top) * width + (x + rect.left)) * 4;
    const d = p * 4;
    for (let ch = 0; ch < 3; ch++) {
      let count = 0;
      for (let i = 0; i < n; i++) {
        const data = frames[i].image16.data;
        if (data[o + 3] === 0) { weights[i] = 0; values[i] = 0; continue; }
        const raw = data[o + ch] / 65535;
        const linear = toLinear(data[o + ch]) / (frames[i].ratio || 1);
        values[i] = linear;
        if (mode === 'hdr') {
          weights[i] = hatWeight(raw) + 1e-4;
        } else {
          weights[i] = 1;
        }
        count++;
      }
      if (!count) { out[d + ch] = 0; continue; }
      if (mode === 'average' && count >= 3) {
        // Reject the one sample farthest from the median when it is far off
        // (dust or a speck that moved between shots).
        const present = [];
        for (let i = 0; i < n; i++) if (weights[i] > 0) present.push(values[i]);
        present.sort((a, b) => a - b);
        const median = present[present.length >> 1];
        let worst = -1; let worstDiff = 0;
        for (let i = 0; i < n; i++) {
          if (weights[i] === 0) continue;
          const diff = Math.abs(values[i] - median);
          if (diff > worstDiff) { worstDiff = diff; worst = i; }
        }
        if (worst >= 0 && worstDiff > 0.25 * Math.max(median, 0.02)) weights[worst] = 0;
      }
      let sum = 0; let wsum = 0;
      for (let i = 0; i < n; i++) { sum += values[i] * weights[i]; wsum += weights[i]; }
      out[d + ch] = wsum > 0 ? encode((sum / wsum) * scale) : 0;
    }
    // Alpha: covered by at least one frame.
    let covered = false;
    for (let i = 0; i < n; i++) if (frames[i].image16.data[o + 3] !== 0) { covered = true; break; }
    out[d + 3] = opaque || covered ? 65535 : 0;
  }
  return { width: outWidth, height: outHeight, data: out };
}

// Convenience: 8-bit view of a 16-bit plane for display and thumbnails.
export function image16ToImageData(image16) {
  const { width, height, data } = image16;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) out[i] = data[i] >> 8;
  const image = new ImageData(out, width, height);
  image.__image16 = image16;
  return image;
}
