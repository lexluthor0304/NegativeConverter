// The auto-frame detector's input (#251): the preview it works on, the
// preview rotations of its fallback angle passes, and the planes its line
// search reads.
//
// A 2D canvas resamples with engine-specific filters (and in a WebKit worker
// probably through the GPU process), so the web app and the desktop app fed
// the detector different pixels. The resizer and the rotation below use
// integer arithmetic only (every intermediate is an exact integer below
// 2^53, every division is by a power of two or rounds a quotient far from a
// tie), so V8 and JavaScriptCore produce the same bytes. They are the
// flagged part 2 of #251 and run only when `settings.deterministicPreview`
// is on.
import { rotatedDimensions } from './imageGeometry.js';
import { LINE_SEARCH_CHANNELS } from './imageWindowLines.js';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function previewSize(width, height, maxSide) {
  const scale = maxSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Source spans of each output cell along one axis, as integer coverage in
// units of 1/target of a source pixel: output i covers [i * source,
// (i + 1) * source), source pixel s covers [s * target, (s + 1) * target).
function coverageSpans(source, target) {
  const first = new Int32Array(target);
  const last = new Int32Array(target);
  const firstWeight = new Int32Array(target);
  const lastWeight = new Int32Array(target);
  for (let i = 0; i < target; i++) {
    const start = i * source;
    const end = start + source;
    const s0 = Math.floor(start / target);
    const s1 = Math.ceil(end / target) - 1;
    first[i] = s0;
    last[i] = s1;
    firstWeight[i] = Math.min(end, (s0 + 1) * target) - start;
    lastWeight[i] = s1 > s0 ? end - s1 * target : firstWeight[i];
  }
  return { first, last, firstWeight, lastWeight };
}

// One source row reduced to `width` columns: channel sums weighted by
// horizontal coverage (each at most 255 W). Whole columns inside a cell
// share the weight `width`; with a 32-bit view they are summed two channels
// per add (R|B and G|A in 16-bit lanes, safe for up to 257 pixels).
function reduceRow(src, words, rowStart, cols, width, out) {
  const { first, last, firstWeight, lastWeight } = cols;
  for (let x = 0, k = 0; x < width; x++, k += 3) {
    const s0 = first[x];
    const s1 = last[x];
    const wf = firstWeight[x];
    let r, g, b;
    if (words) {
      const p = words[rowStart + s0];
      r = (p & 0xFF) * wf; g = ((p >> 8) & 0xFF) * wf; b = ((p >> 16) & 0xFF) * wf;
    } else {
      const i = (rowStart + s0) * 4;
      r = src[i] * wf; g = src[i + 1] * wf; b = src[i + 2] * wf;
    }
    if (s1 > s0) {
      if (words && s1 - s0 <= 258) {
        let rb = 0, ga = 0;
        for (let s = rowStart + s0 + 1, end = rowStart + s1; s < end; s++) {
          const q = words[s];
          rb += q & 0x00FF00FF;
          ga += (q >> 8) & 0x00FF00FF;
        }
        r += (rb & 0xFFFF) * width; b += (rb >>> 16) * width; g += (ga & 0xFFFF) * width;
      } else {
        let sr = 0, sg = 0, sb = 0;
        for (let i = (rowStart + s0 + 1) * 4, end = (rowStart + s1) * 4; i < end; i += 4) {
          sr += src[i]; sg += src[i + 1]; sb += src[i + 2];
        }
        r += sr * width; g += sg * width; b += sb * width;
      }
      const wl = lastWeight[x];
      if (words) {
        const q = words[rowStart + s1];
        r += (q & 0xFF) * wl; g += ((q >> 8) & 0xFF) * wl; b += ((q >> 16) & 0xFF) * wl;
      } else {
        const i = (rowStart + s1) * 4;
        r += src[i] * wl; g += src[i + 1] * wl; b += src[i + 2] * wl;
      }
    }
    out[k] = r; out[k + 1] = g; out[k + 2] = b;
  }
}

// Adds the rows strictly inside a cell (weight `height` each) to `cell`.
// With a 32-bit view they are summed down the columns two channels per add
// (R|B and G|A in 16-bit lanes, two rows per pass), then across each output
// column; `lanes` says whether a cell's interior fits the lanes.
function addInteriorRows(src, words, W, t0, t1, cols, width, height, cell, lanes, row, sums) {
  const n = t1 - t0 - 1;
  if (n < 1) return;
  if (!lanes) {
    for (let t = t0 + 1; t < t1; t++) {
      reduceRow(src, words, t * W, cols, width, row);
      for (let k = 0; k < cell.length; k++) cell[k] += row[k] * height;
    }
    return;
  }
  let t = t0 + 1;
  if (n & 1) {
    for (let s = 0, j = 0, i = t * W; s < W; s++, j += 2, i++) {
      const q = words[i];
      sums[j] = q & 0x00FF00FF;
      sums[j + 1] = (q >> 8) & 0x00FF00FF;
    }
    t++;
  } else {
    sums.fill(0);
  }
  for (; t < t1; t += 2) {
    for (let s = 0, j = 0, i = t * W; s < W; s++, j += 2, i++) {
      const q = words[i];
      const p = words[i + W];
      sums[j] += (q & 0x00FF00FF) + (p & 0x00FF00FF);
      sums[j + 1] += ((q >> 8) & 0x00FF00FF) + ((p >> 8) & 0x00FF00FF);
    }
  }
  const { first, last, firstWeight, lastWeight } = cols;
  for (let x = 0, k = 0; x < width; x++, k += 3) {
    const s0 = first[x];
    const s1 = last[x];
    const wf = firstWeight[x];
    let r = (sums[2 * s0] & 0xFFFF) * wf;
    let b = (sums[2 * s0] >>> 16) * wf;
    let g = (sums[2 * s0 + 1] & 0xFFFF) * wf;
    if (s1 > s0) {
      let rb = 0, ga = 0;
      for (let j = 2 * s0 + 2, end = 2 * s1; j < end; j += 2) { rb += sums[j]; ga += sums[j + 1]; }
      r += (rb & 0xFFFF) * width; b += (rb >>> 16) * width; g += (ga & 0xFFFF) * width;
      const wl = lastWeight[x];
      r += (sums[2 * s1] & 0xFFFF) * wl; b += (sums[2 * s1] >>> 16) * wl; g += (sums[2 * s1 + 1] & 0xFFFF) * wl;
    }
    cell[k] += r * height; cell[k + 1] += g * height; cell[k + 2] += b * height;
  }
}

/**
 * Area average of an 8-bit RGBA image to width x height (at most the source
 * size): every output pixel is the exact coverage-weighted mean of the source
 * pixels under it, rounded half up. Alpha is opaque.
 */
export function areaResampleImageData(imageData, width, height) {
  const W = imageData.width;
  const H = imageData.height;
  const src = imageData.data;
  const out = new Uint8ClampedArray(width * height * 4);
  const cols = coverageSpans(W, width);
  const rows = coverageSpans(H, height);
  // Int32 words: a Uint32 load above 2^31 (any opaque pixel) would leave
  // the integer fast path. Signed shifts give the same masked lanes.
  const words = LITTLE_ENDIAN && src.byteOffset % 4 === 0
    ? new Int32Array(src.buffer, src.byteOffset, W * H) : null;
  // Column sums of a cell's interior rows, R|B and G|A per source column.
  const sums = words ? new Int32Array(W * 2) : null;
  let widestInterior = 0;
  for (let x = 0; x < width; x++) widestInterior = Math.max(widestInterior, cols.last[x] - cols.first[x] - 1);
  // Sums are exact integers: at most 255 W per reduced row and 255 W H per
  // cell (< 2^53); the weights of a cell total W H. Rounded half up.
  const row = new Float64Array(width * 3);
  const cell = new Float64Array(width * 3);
  const total = W * H;
  const twiceTotal = 2 * total;
  let reduced = -1;
  for (let y = 0; y < height; y++) {
    cell.fill(0);
    const t0 = rows.first[y];
    const t1 = rows.last[y];
    // The two border rows, weighted by coverage; a row shared by two cells
    // is reduced once.
    for (const [t, weight] of t1 > t0 ? [[t0, rows.firstWeight[y]], [t1, rows.lastWeight[y]]] : [[t0, rows.firstWeight[y]]]) {
      if (t !== reduced) {
        reduceRow(src, words, t * W, cols, width, row);
        reduced = t;
      }
      for (let k = 0; k < cell.length; k++) cell[k] += row[k] * weight;
    }
    // A lane holds up to 65535: n rows of one column, then up to
    // `widestInterior` columns of those, at 255 each (n <= 128 also keeps a
    // column's word sum below 2^31).
    const n = t1 - t0 - 1;
    const lanes = Boolean(words) && n <= 128 && n * Math.max(1, widestInterior) * 255 <= 0xFFFF;
    addInteriorRows(src, words, W, t0, t1, cols, width, height, cell, lanes, row, sums);
    if (n > 0 && !lanes) reduced = t1 - 1;
    for (let x = 0, k = 0, o = y * width * 4; x < width; x++, k += 3, o += 4) {
      out[o] = Math.floor((2 * cell[k] + total) / twiceTotal);
      out[o + 1] = Math.floor((2 * cell[k + 1] + total) / twiceTotal);
      out[o + 2] = Math.floor((2 * cell[k + 2] + total) / twiceTotal);
      out[o + 3] = 255;
    }
  }
  return new ImageData(out, width, height);
}

/**
 * The detector's preview: the frame itself when its long side is at most
 * `maxSide`, else its area average at the size the canvas resizer used.
 */
export function areaResizeToMaxSide(imageData, maxSide) {
  if (!imageData) return null;
  if (Math.max(imageData.width, imageData.height) <= maxSide) return imageData;
  const { width, height } = previewSize(imageData.width, imageData.height, maxSide);
  return areaResampleImageData(imageData, width, height);
}

const FRACTION_BITS = 16;
const ONE = 1 << FRACTION_BITS;
// Source coordinates are kept doubled in units of 2^-16 (2^17 per pixel), so
// a position is an integer and its pixel is floor(position / 2^17).
const POSITION_SHIFT = FRACTION_BITS + 1;
const POSITION_ONE = 1 << POSITION_SHIFT;
const ROUND_BIAS = 2 ** (2 * POSITION_SHIFT - 1);
const ROUND_SCALE = 2 ** (2 * POSITION_SHIFT);

/**
 * 8-bit bilinear rotation of a preview, on the inverse map of the 16-bit
 * core (imageGeometry renderBilinearRows): the frame grows to
 * rotatedDimensions, pixels outside the source stay transparent. cos and
 * sin are quantised to 2^-16 once per call, because ECMAScript leaves the
 * precision of Math.cos / Math.sin to the engine.
 */
export function rotatePreviewImageData(imageData, angle) {
  const w = imageData.width;
  const h = imageData.height;
  const frame = rotatedDimensions(w, h, angle);
  const out = new Uint8ClampedArray(frame.width * frame.height * 4);
  const rad = (Number(angle) || 0) * Math.PI / 180;
  const C = Math.round(Math.cos(rad) * ONE);
  const S = Math.round(Math.sin(rad) * ONE);
  const src = imageData.data;
  const maxX = POSITION_ONE / 2 * (2 * w - 1);
  const maxY = POSITION_ONE / 2 * (2 * h - 1);
  const minPosition = -POSITION_ONE / 2;
  const originX = ONE * (w - 1);
  const originY = ONE * (h - 1);
  for (let y = 0, o = 0; y < frame.height; y++) {
    // v and u doubled: 2 (y + 0.5) - frameHeight.
    const v2 = 2 * y + 1 - frame.height;
    const baseX = originX + v2 * S;
    const baseY = originY + v2 * C;
    for (let x = 0; x < frame.width; x++, o += 4) {
      const u2 = 2 * x + 1 - frame.width;
      const sx = baseX + u2 * C;
      const sy = baseY - u2 * S;
      if (sx < minPosition || sy < minPosition || sx > maxX || sy > maxY) continue;
      let x0 = Math.floor(sx / POSITION_ONE);
      let y0 = Math.floor(sy / POSITION_ONE);
      x0 = x0 < 0 ? 0 : (x0 > w - 1 ? w - 1 : x0);
      y0 = y0 < 0 ? 0 : (y0 > h - 1 ? h - 1 : y0);
      const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
      const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
      let fx = sx - x0 * POSITION_ONE;
      let fy = sy - y0 * POSITION_ONE;
      fx = fx < 0 ? 0 : (fx > POSITION_ONE ? POSITION_ONE : fx);
      fy = fy < 0 ? 0 : (fy > POSITION_ONE ? POSITION_ONE : fy);
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const upper = src[i00 + c] * (POSITION_ONE - fx) + src[i10 + c] * fx;
        const lower = src[i01 + c] * (POSITION_ONE - fx) + src[i11 + c] * fx;
        out[o + c] = Math.floor((upper * (POSITION_ONE - fy) + lower * fy + ROUND_BIAS) / ROUND_SCALE);
      }
      out[o + 3] = 255;
    }
  }
  return new ImageData(out, frame.width, frame.height);
}

const BW_FILM_TYPES = new Set(['bw', 'blackWhite', 'bwNegative', 'bwPositive']);
const CHROMA_BLOCK = 4;
const NEUTRAL_CHROMA_P95 = 10;

/**
 * 95th percentile over the preview's full 4 x 4 blocks of the block-mean
 * chroma (max - min of the mean R, G, B; no gain normalisation), or null
 * when the preview holds no full block. Exact: sums are integers, the
 * percentile comes from a histogram of 16 x chroma.
 */
export function blockChromaP95(imageData) {
  const { width, height, data } = imageData;
  const bw = Math.floor(width / CHROMA_BLOCK);
  const bh = Math.floor(height / CHROMA_BLOCK);
  if (bw < 1 || bh < 1) return null;
  const histogram = new Uint32Array(255 * CHROMA_BLOCK * CHROMA_BLOCK + 1);
  const sums = new Int32Array(bw * 3);
  for (let by = 0; by < bh; by++) {
    sums.fill(0);
    for (let y = by * CHROMA_BLOCK; y < (by + 1) * CHROMA_BLOCK; y++) {
      let i = y * width * 4;
      for (let k = 0; k < sums.length; k += 3) {
        for (let x = 0; x < CHROMA_BLOCK; x++, i += 4) {
          sums[k] += data[i];
          sums[k + 1] += data[i + 1];
          sums[k + 2] += data[i + 2];
        }
      }
    }
    for (let k = 0; k < sums.length; k += 3) {
      const r = sums[k], g = sums[k + 1], b = sums[k + 2];
      histogram[Math.max(r, g, b) - Math.min(r, g, b)]++;
    }
  }
  const rank = Math.floor((bw * bh - 1) * 0.95);
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen > rank) return value / (CHROMA_BLOCK * CHROMA_BLOCK);
  }
  return null;
}

/**
 * The line search's planes for one frame (#251 part 4b, flagged): grey only
 * when the frame's own film type is black-and-white or its preview is
 * neutral (block chroma p95 < 10; an orange-mask negative sits near 90),
 * else grey, R, G and B. `enabled: false` (the kill switch) keeps all four.
 * The verdict is recorded as `diagnostics.lineSearch`.
 */
export function planLineSearch(preview, { enabled = false, filmType = null } = {}) {
  if (!enabled) return { channels: LINE_SEARCH_CHANNELS, record: { channels: 'rgb', reason: 'off', chromaP95: null } };
  if (BW_FILM_TYPES.has(filmType)) return { channels: [-1], record: { channels: 'grey', reason: 'bw-film', chromaP95: null } };
  const chromaP95 = preview ? blockChromaP95(preview) : null;
  if (chromaP95 !== null && chromaP95 < NEUTRAL_CHROMA_P95) {
    return { channels: [-1], record: { channels: 'grey', reason: 'neutral', chromaP95 } };
  }
  return { channels: LINE_SEARCH_CHANNELS, record: { channels: 'rgb', reason: 'colour', chromaP95 } };
}
