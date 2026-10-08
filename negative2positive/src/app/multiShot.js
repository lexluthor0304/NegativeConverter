// Multi-shot merge for camera scanning: several shots of the same negative,
// already aligned into one frame (imageAlignment.js), combined in linear
// light. "average" reduces sensor noise (and drops a moving speck when three
// or more frames disagree), "hdr" weights each frame by how well its pixels
// are exposed so bracketed shots recover the dense highlights of a thick
// negative. Frames carry alpha 0 where the warp left no data; those pixels
// are skipped. Pure functions on 16-bit RGBA planes; the merge worker
// (workers/multiShotWorkerProcessor.js) runs them off the main thread.

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

// Well-exposedness weight of a raw (display-encoded, 0..1) value: highest in
// the mid-tones, zero at the clipping ends.
function hatWeight(value) {
  const d = Math.abs(value - 0.5) / 0.5;
  const w = 1 - d * d * d;
  return w < 0.02 ? 0 : w;
}

// Every 16-bit sample's linear value and HDR weight, precomputed. The tables
// hold doubles, so a lookup returns exactly the number the per-sample
// interpolation gave; a Float32 table would round it once more and change
// the merged output.
export const LIN = new Float64Array(65536);
export const HAT = new Float64Array(65536);
// The weight as the merge stores it (a float).
const HAT32 = new Float32Array(65536);
for (let v = 0; v < 65536; v++) {
  LIN[v] = toLinear(v);
  HAT[v] = hatWeight(v / 65535) + 1e-4;
  HAT32[v] = HAT[v];
}

// Exposure of `frame` relative to `reference` (frame ≈ reference * ratio) from
// the median luminance ratio over pixels both frames expose well.
export function estimateExposureRatio(reference, frame, { step = 4 } = {}) {
  if (!reference || !frame || reference.width !== frame.width || reference.height !== frame.height) return 1;
  const n = reference.width * reference.height;
  const stride = Math.max(1, Math.round(step));
  const ref = reference.data; const cur = frame.data;
  // The ratios are finite and positive, so the typed (numeric) sort orders
  // them exactly as the comparator sort of a plain array did.
  const ratios = new Float64Array(Math.ceil(n / stride));
  let count = 0;
  for (let p = 0; p < n; p += stride) {
    const o = p * 4;
    if (ref[o + 3] === 0 || cur[o + 3] === 0) continue;
    const lr = 0.2126 * LIN[ref[o]] + 0.7152 * LIN[ref[o + 1]] + 0.0722 * LIN[ref[o + 2]];
    const lf = 0.2126 * LIN[cur[o]] + 0.7152 * LIN[cur[o + 1]] + 0.0722 * LIN[cur[o + 2]];
    if (lr < 0.03 || lr > 0.85 || lf < 0.03 || lf > 0.85) continue;
    ratios[count++] = lf / lr;
  }
  if (count < 50) return 1;
  return ratios.subarray(0, count).sort()[count >> 1];
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
  const planes = frames.map((f) => f.image16.data);
  const n = planes.length;
  for (let y = 0; y < height; y++) {
    let a = y * width * 4 + 3;
    let covered = 0;
    for (let x = 0; x < width; x++, a += 4) {
      let all = true;
      for (let i = 0; i < n; i++) if (planes[i][a] === 0) { all = false; break; }
      if (all) { colCount[x]++; covered++; }
    }
    rowCount[y] = covered;
  }
  let left = 0; while (left < width && colCount[left] < minCoverage * height) left++;
  let right = width - 1; while (right > left && colCount[right] < minCoverage * height) right--;
  let top = 0; while (top < height && rowCount[top] < minCoverage * width) top++;
  let bottom = height - 1; while (bottom > top && rowCount[bottom] < minCoverage * width) bottom--;
  if (right - left < 16 || bottom - top < 16) return full;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// The merge's output exposure: the darkest bracket's ratio (at most 1).
export function mergeScale(frames) {
  let scale = 1;
  for (const f of frames) scale = Math.min(scale, f.ratio > 0 ? f.ratio : 1);
  return scale;
}

// Merges rows [y0, y1) of `rect` (reference pixels) into `out`, the RGBA
// plane of the whole rect. Rows are independent, so merging a rect in bands
// gives the same samples as merging it at once. `scale` must be
// mergeScale(frames) over all frames, whatever the band.
export function mergeRows(frames, rect, y0, y1, out, { mode = 'average', scale = mergeScale(frames), opaque = false } = {}) {
  const n = frames.length;
  const width = frames[0].image16.width;
  const outWidth = rect.width;
  const planes = frames.map((f) => f.image16.data);
  const divisors = frames.map((f) => f.ratio || 1);
  const hdr = mode === 'hdr';
  const rejectOutlier = mode === 'average';
  // Per-channel values, rounded to float where the old per-pixel Float32
  // scratch rounded them: channel ch of frame i is values[ch * n + i].
  const values = new Float32Array(3 * n);
  const alive = new Uint8Array(n);
  const present = new Float64Array(n);
  for (let y = y0; y < y1; y++) {
    let o = ((y + rect.top) * width + rect.left) * 4;
    let d = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++, o += 4, d += 4) {
      let count = 0;
      if (hdr) {
        // Each channel accumulates over the covered frames in frame order;
        // an uncovered frame's weight is 0 and adds exactly nothing.
        let s0 = 0; let s1 = 0; let s2 = 0; let w0 = 0; let w1 = 0; let w2 = 0;
        for (let i = 0; i < n; i++) {
          const data = planes[i];
          if (data[o + 3] === 0) continue;
          const divisor = divisors[i];
          const v0 = data[o]; const v1 = data[o + 1]; const v2 = data[o + 2];
          const a0 = HAT32[v0]; const a1 = HAT32[v1]; const a2 = HAT32[v2];
          s0 += Math.fround(LIN[v0] / divisor) * a0; w0 += a0;
          s1 += Math.fround(LIN[v1] / divisor) * a1; w1 += a1;
          s2 += Math.fround(LIN[v2] / divisor) * a2; w2 += a2;
          count++;
        }
        out[d] = count && w0 > 0 ? encode((s0 / w0) * scale) : 0;
        out[d + 1] = count && w1 > 0 ? encode((s1 / w1) * scale) : 0;
        out[d + 2] = count && w2 > 0 ? encode((s2 / w2) * scale) : 0;
        out[d + 3] = opaque || count ? 65535 : 0;
        continue;
      }
      for (let i = 0; i < n; i++) {
        const data = planes[i];
        if (data[o + 3] === 0) { alive[i] = 0; continue; }
        alive[i] = 1;
        const divisor = divisors[i];
        values[i] = LIN[data[o]] / divisor;
        values[n + i] = LIN[data[o + 1]] / divisor;
        values[2 * n + i] = LIN[data[o + 2]] / divisor;
        count++;
      }
      // Alpha: covered by at least one frame.
      out[d + 3] = opaque || count ? 65535 : 0;
      for (let ch = 0, base = 0; ch < 3; ch++, base += n) {
        if (!count) { out[d + ch] = 0; continue; }
        let rejected = -1;
        if (rejectOutlier && count >= 3) {
          // Reject the one sample farthest from the median when it is far off
          // (dust or a speck that moved between shots). Insertion sort of the
          // few present values: the same order as sorting them numerically.
          let m = 0;
          for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            const v = values[base + i];
            let j = m++;
            while (j > 0 && present[j - 1] > v) { present[j] = present[j - 1]; j--; }
            present[j] = v;
          }
          const median = present[m >> 1];
          let worstDiff = 0;
          for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            const diff = Math.abs(values[base + i] - median);
            if (diff > worstDiff) { worstDiff = diff; rejected = i; }
          }
          if (!(worstDiff > 0.25 * Math.max(median, 0.02))) rejected = -1;
        }
        // Equal weights: the kept values summed in frame order (a dropped or
        // uncovered sample's weight 0 adds exactly nothing).
        let sum = 0; let kept = 0;
        for (let i = 0; i < n; i++) {
          if (!alive[i] || i === rejected) continue;
          sum += values[base + i];
          kept++;
        }
        out[d + ch] = kept > 0 ? encode((sum / kept) * scale) : 0;
      }
    }
  }
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
  const rect = region || { left: 0, top: 0, width, height };
  const out = new Uint16Array(rect.width * rect.height * 4);
  mergeRows(frames, rect, 0, rect.height, out, { mode, scale: mergeScale(frames), opaque });
  return { width: rect.width, height: rect.height, data: out };
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
