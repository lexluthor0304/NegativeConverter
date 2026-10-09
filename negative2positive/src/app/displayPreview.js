import { allocPlane16, isSharedPlane, sharedPlanesAvailable } from './crossOriginIsolation.js';

// 表示領域の物理ピクセルに合わせる。解析用の縮小画像とは独立させる。
export function displayPreviewSize(width, height, {
  viewportWidth = 1280, viewportHeight = 900, dpr = 1, zoom = 1,
  maxPixels = 4_000_000, maxDimension = 8192
} = {}) {
  const fit = Math.min(1, Math.max(1, viewportWidth) / width, Math.max(1, viewportHeight) / height);
  const scale = Math.min(1, fit * Math.max(1, dpr) * Math.max(1, zoom),
    Math.sqrt(maxPixels / (width * height)), maxDimension / width, maxDimension / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

// Which filter made a display image (#248): 'bilinear' (resizeDisplayPreview,
// HEAD's 2x2 taps) or 'area' (filterDisplayImage: a k x k box level, then a
// bilinear or area resample). A region update must use the same footprint.
const displayFilters = new WeakMap();

export function noteDisplayFilter(image, filter) {
  if (image && typeof image === 'object' && filter) displayFilters.set(image, filter);
  return image;
}

export function displayFilterOf(image) {
  return displayFilters.get(image) || { kind: 'bilinear' };
}

// ---------------------------------------------------------------------------
// The exact kernel (part 2): HEAD's 2x2 bilinear with the same expressions in
// the same order, from per-column and per-row tables, so both planes stay
// byte-identical to it.
// ---------------------------------------------------------------------------

// Canvas の 8bit 変換を通さず、RAW の 16bit 値を保ったまま補間する。
export function resizeDisplayPreview(image, { width, height }) {
  if (width >= image.width && height >= image.height) return image;
  const output = new ImageData(width, height);
  if (image.__image16?.data) output.__image16 = { width, height, data: new Uint16Array(width * height * 4) };
  resamplePreview(image, output, 0, width, 0, height);
  displayFilters.set(output, { kind: 'bilinear' });
  return output;
}

/**
 * resizeDisplayPreview in row bands of about `budgetMs` each, awaiting
 * `pause()` between them, so a whole-frame resample on the main thread never
 * makes a long task. Resolves null when `isCurrent()` turns false in between.
 */
export async function resizeDisplayPreviewInBands(image, { width, height }, { budgetMs = 12, pause = defaultPause, isCurrent = () => true } = {}) {
  if (width >= image.width && height >= image.height) return image;
  const output = new ImageData(width, height);
  if (image.__image16?.data) output.__image16 = { width, height, data: new Uint16Array(width * height * 4) };
  const done = await runInBands(height, (y0, y1) => resamplePreview(image, output, 0, width, y0, y1), { budgetMs, pause, isCurrent });
  if (!done) return null;
  displayFilters.set(output, { kind: 'bilinear' });
  return output;
}

// Two bilinear taps per axis. Preview pixel x reads source columns x0 and x1.
function previewTap(x, scale) {
  return Math.max(0, (x + 0.5) * scale - 0.5);
}

// Math.round(v / 257) for every 16-bit v: the 8-bit plane of a 16-bit value,
// read from a table instead of a division per channel (#270). Built once.
let eightBitOf = null;
function eightBitTable() {
  if (!eightBitOf) {
    eightBitOf = new Uint8Array(65536);
    for (let v = 0; v < 65536; v++) eightBitOf[v] = Math.round(v / 257);
  }
  return eightBitOf;
}

// A pixel's channels stored as one or two 32-bit words (#270) put the same
// bytes in memory as four stores, on a little-endian platform (every one the
// app runs on). A view of a plane that does not start on a 4-byte boundary
// takes the per-channel stores.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function wordsOf(plane) {
  if (!LITTLE_ENDIAN || plane.byteOffset % 4 || plane.byteLength % 4) return null;
  return new Uint32Array(plane.buffer, plane.byteOffset, plane.byteLength >> 2);
}

function resamplePreview(image, output, px0, px1, py0, py1) {
  const { width } = output;
  const sourceWidth = image.width;
  const source16 = image.__image16?.data;
  const source = source16 || image.data;
  const data = source16 ? output.__image16.data : output.data;
  const data8 = output.data;
  const sx = sourceWidth / width;
  const sy = image.height / output.height;
  const span = px1 - px0;
  // Byte offsets of the two taps of each preview column, and their weight.
  const left = new Int32Array(span), right = new Int32Array(span), weight = new Float64Array(span);
  for (let i = 0; i < span; i++) {
    const fx = previewTap(px0 + i, sx);
    const x0 = Math.floor(fx);
    left[i] = x0 * 4;
    right[i] = Math.min(sourceWidth - 1, x0 + 1) * 4;
    weight[i] = fx - x0;
  }
  const rowStride = sourceWidth * 4;
  const to8 = source16 ? eightBitTable() : null;
  const words16 = source16 ? wordsOf(data) : null;
  const words8 = source16 ? wordsOf(data8) : null;
  for (let y = py0; y < py1; y++) {
    const fy = previewTap(y, sy);
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const dy = fy - y0;
    const row0 = y0 * rowStride;
    const row1 = y1 * rowStride;
    let dest = (y * width + px0) * 4;
    if (source16 && words16 && words8) {
      // Each tap is read once into a local (a store to another typed array
      // would make the engine read it again). The 8-bit value comes from the
      // table: v is an integer in [0, 65535], a convex mix of 16-bit samples.
      // Alpha with four equal taps (an opaque frame) is that value exactly:
      // a + (a - a) * dx is a, and so is the row mix and its rounding. Both
      // planes are written a pixel at a time, as words.
      let pixel = y * width + px0;
      for (let i = 0; i < span; i++, pixel++) {
        const dx = weight[i];
        const a = row0 + left[i], b = row0 + right[i], c = row1 + left[i], d = row1 + right[i];
        let p = source[a], q = source[b], r = source[c], s = source[d];
        let top = p + (q - p) * dx;
        let bottom = r + (s - r) * dx;
        const v0 = Math.round(top + (bottom - top) * dy);
        p = source[a + 1]; q = source[b + 1]; r = source[c + 1]; s = source[d + 1];
        top = p + (q - p) * dx;
        bottom = r + (s - r) * dx;
        const v1 = Math.round(top + (bottom - top) * dy);
        p = source[a + 2]; q = source[b + 2]; r = source[c + 2]; s = source[d + 2];
        top = p + (q - p) * dx;
        bottom = r + (s - r) * dx;
        const v2 = Math.round(top + (bottom - top) * dy);
        p = source[a + 3]; q = source[b + 3]; r = source[c + 3]; s = source[d + 3];
        let v3 = p;
        if (p !== q || p !== r || p !== s) {
          top = p + (q - p) * dx;
          bottom = r + (s - r) * dx;
          v3 = Math.round(top + (bottom - top) * dy);
        }
        words16[pixel * 2] = v0 | (v1 << 16);
        words16[pixel * 2 + 1] = v2 | (v3 << 16);
        words8[pixel] = to8[v0] | (to8[v1] << 8) | (to8[v2] << 16) | (to8[v3] << 24);
      }
    } else if (source16) {
      for (let i = 0; i < span; i++, dest += 4) {
        const dx = weight[i];
        const a = row0 + left[i], b = row0 + right[i], c = row1 + left[i], d = row1 + right[i];
        let p = source[a], q = source[b], r = source[c], s = source[d];
        let top = p + (q - p) * dx;
        let bottom = r + (s - r) * dx;
        let v = Math.round(top + (bottom - top) * dy);
        data[dest] = v;
        data8[dest] = to8[v];
        p = source[a + 1]; q = source[b + 1]; r = source[c + 1]; s = source[d + 1];
        top = p + (q - p) * dx;
        bottom = r + (s - r) * dx;
        v = Math.round(top + (bottom - top) * dy);
        data[dest + 1] = v;
        data8[dest + 1] = to8[v];
        p = source[a + 2]; q = source[b + 2]; r = source[c + 2]; s = source[d + 2];
        top = p + (q - p) * dx;
        bottom = r + (s - r) * dx;
        v = Math.round(top + (bottom - top) * dy);
        data[dest + 2] = v;
        data8[dest + 2] = to8[v];
        p = source[a + 3]; q = source[b + 3]; r = source[c + 3]; s = source[d + 3];
        if (p === q && p === r && p === s) v = p;
        else {
          top = p + (q - p) * dx;
          bottom = r + (s - r) * dx;
          v = Math.round(top + (bottom - top) * dy);
        }
        data[dest + 3] = v;
        data8[dest + 3] = to8[v];
      }
    } else {
      for (let i = 0; i < span; i++, dest += 4) {
        const dx = weight[i];
        const a = row0 + left[i], b = row0 + right[i], c = row1 + left[i], d = row1 + right[i];
        let top = source[a] + (source[b] - source[a]) * dx;
        let bottom = source[c] + (source[d] - source[c]) * dx;
        data[dest] = Math.round(top + (bottom - top) * dy);
        top = source[a + 1] + (source[b + 1] - source[a + 1]) * dx;
        bottom = source[c + 1] + (source[d + 1] - source[c + 1]) * dx;
        data[dest + 1] = Math.round(top + (bottom - top) * dy);
        top = source[a + 2] + (source[b + 2] - source[a + 2]) * dx;
        bottom = source[c + 2] + (source[d + 2] - source[c + 2]) * dx;
        data[dest + 2] = Math.round(top + (bottom - top) * dy);
        top = source[a + 3] + (source[b + 3] - source[a + 3]) * dx;
        bottom = source[c + 3] + (source[d + 3] - source[c + 3]) * dx;
        data[dest + 3] = Math.round(top + (bottom - top) * dy);
      }
    }
  }
}

// Preview indices [first, last + 1) whose two taps reach source span [start, end).
function previewSpan(start, end, scale, count, limit) {
  let first = -1, last = -1;
  for (let i = 0; i < count; i++) {
    const x0 = Math.floor(previewTap(i, scale));
    const x1 = Math.min(limit - 1, x0 + 1);
    if (x1 < start || x0 >= end) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last + 1];
}

/**
 * After `image` changed inside `rect`, recomputes only the pixels of
 * `preview` (made from it by resizeDisplayPreview or filterDisplayImage) whose
 * filter footprint falls in the rect, with the same arithmetic, so the result
 * equals a full rebuild with that filter. The dust brush and AI repair results
 * use this to avoid rebuilding a display preview per stroke.
 * Returns the preview rect it rewrote, or null.
 */
export function updateDisplayPreviewRect(image, preview, rect) {
  if (preview === image) return { ...rect };
  const filter = displayFilterOf(preview);
  if (filter.kind === 'area') return updateFilteredRect(image, preview, rect, filter.k);
  const columns = previewSpan(rect.x, rect.x + rect.width, image.width / preview.width, preview.width, image.width);
  const rows = previewSpan(rect.y, rect.y + rect.height, image.height / preview.height, preview.height, image.height);
  if (!columns || !rows) return null;
  resamplePreview(image, preview, columns[0], columns[1], rows[0], rows[1]);
  return { x: columns[0], y: rows[0], width: columns[1] - columns[0], height: rows[1] - rows[0] };
}

// ---------------------------------------------------------------------------
// The retained level and the area-filtered display resample (part 3).
//
// A level is an integer k x k box average of a conversion source, kept once per
// source, with k chosen so the level is never smaller than the 4 MP display cap.
// A display image is resampled from it with the source's own geometry (a level
// pixel covers source pixels [i*k, i*k + k)): bilinear for reductions of up to 2x
// over the level, an exact area average above. Nearly every source pixel then
// contributes to the display, where 2x2 bilinear taps read 4 of about 25.
// ---------------------------------------------------------------------------

export const DISPLAY_LEVEL_MAX_PIXELS = 4_000_000;
export const DISPLAY_LEVEL_MAX_DIMENSION = 8192;

/** The level's box size for a source of this size: max(1, floor(min(W / capW, H / capH))). */
export function displayLevelFactor(width, height, { maxPixels = DISPLAY_LEVEL_MAX_PIXELS, maxDimension = DISPLAY_LEVEL_MAX_DIMENSION } = {}) {
  if (!(width > 0) || !(height > 0)) return 1;
  const cap = displayPreviewSize(width, height, { viewportWidth: width, viewportHeight: height, dpr: 1, zoom: 1, maxPixels, maxDimension });
  return Math.max(1, Math.floor(Math.min(width / cap.width, height / cap.height)));
}

// A built level's source geometry, for levels made here (k > 1).
const displayLevels = new WeakMap();

/**
 * { sourceWidth, sourceHeight, k } of a level. A source that serves as its own
 * level (k = 1) has no entry and is its own geometry.
 */
export function displayLevelGeometry(level) {
  return displayLevels.get(level) || { sourceWidth: level.width, sourceHeight: level.height, k: 1 };
}

function levelShape(image, k) {
  const width = Math.floor(image.width / k);
  const height = Math.floor(image.height / k);
  // The level of a shared frame is shared too (#264): the preview conversion
  // then posts it without a copy. It is built here, before anything reads it.
  const data = allocPlane16(width * height * 4, { shared: isSharedPlane(image.__image16?.data) && sharedPlanesAvailable() });
  const level = { width, height, __image16: { width, height, data } };
  displayLevels.set(level, { sourceWidth: image.width, sourceHeight: image.height, k });
  return level;
}

// Level rows [ly0, ly1) and columns [lx0, lx1) of `image` into `out` (whose
// width is `outWidth`, starting at column lx0 and row ly0 of the level).
function boxLevelRows(image, k, lx0, lx1, ly0, ly1, out, outWidth) {
  const source16 = plane16(image);
  const source = source16 || image.data;
  const scale = source16 ? 1 : 257;
  const area = k * k;
  const stride = image.width * 4;
  const span = lx1 - lx0;
  const acc = new Float64Array(span * 4);
  for (let ly = ly0; ly < ly1; ly++) {
    acc.fill(0);
    for (let dy = 0; dy < k; dy++) {
      let s = (ly * k + dy) * stride + lx0 * k * 4;
      for (let i = 0, o = 0; i < span; i++, o += 4) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dx = 0; dx < k; dx++, s += 4) {
          r += source[s]; g += source[s + 1]; b += source[s + 2]; a += source[s + 3];
        }
        acc[o] += r; acc[o + 1] += g; acc[o + 2] += b; acc[o + 3] += a;
      }
    }
    let d = ((ly - ly0) * outWidth) * 4;
    for (let o = 0; o < span * 4; o++, d++) out[d] = Math.round((acc[o] * scale) / area);
  }
}

/**
 * The level rows of a band of a frame whose first row is a multiple of k
 * (#248: the geometry pool builds them with the band): rows [0, floor(height /
 * k)) of the band's level, `levelWidth` wide.
 */
export function displayLevelRows(image, k, levelWidth = Math.floor(image.width / k)) {
  const rows = Math.floor(image.height / k);
  const out = new Uint16Array(levelWidth * rows * 4);
  boxLevelRows(image, k, 0, levelWidth, 0, rows, out, levelWidth);
  return out;
}

/** A level assembled elsewhere (the geometry pool), with its source geometry. */
export function adoptDisplayLevel(data, width, height, geometry) {
  const level = { width, height, __image16: { width, height, data } };
  displayLevels.set(level, { sourceWidth: geometry.sourceWidth, sourceHeight: geometry.sourceHeight, k: geometry.k });
  return level;
}

/** The whole level of `image` at once; `image` itself when k is 1. */
export function buildDisplayLevel(image, k = displayLevelFactor(image.width, image.height)) {
  if (k <= 1) return image;
  const level = levelShape(image, k);
  boxLevelRows(image, k, 0, level.width, 0, level.height, level.__image16.data, level.width);
  return level;
}

/**
 * buildDisplayLevel in row bands of about `budgetMs` (the first version builds
 * it on the main thread, #248 part 3). Resolves null when `isCurrent()` turned
 * false between bands.
 */
export async function buildDisplayLevelInBands(image, k = displayLevelFactor(image.width, image.height), { budgetMs = 12, pause = defaultPause, isCurrent = () => true } = {}) {
  if (k <= 1) return image;
  const level = levelShape(image, k);
  const data = level.__image16.data;
  const done = await runInBands(level.height, (y0, y1) => {
    boxLevelRows(image, k, 0, level.width, y0, y1, data.subarray(y0 * level.width * 4), level.width);
  }, { budgetMs, pause, isCurrent });
  return done ? level : null;
}

/** 'bilinear' for reductions of up to 2x over the level, 'area' above. */
export function displayResampleMode({ sourceWidth, sourceHeight, k }, target) {
  const ratio = Math.max(sourceWidth / target.width, sourceHeight / target.height) / k;
  return ratio > 2 ? 'area' : 'bilinear';
}

// Taps of target indices [t0, t1) along one axis, in level indices.
function axisTaps(mode, targetCount, sourceCount, k, levelCount, t0, t1) {
  const n = t1 - t0;
  const s = sourceCount / targetCount;
  if (mode === 'bilinear') {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), w = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const t = t0 + j;
      // k = 1 is resizeDisplayPreview's own tap.
      const f = k === 1 ? Math.max(0, (t + 0.5) * s - 0.5)
        : Math.min(levelCount - 1, Math.max(0, ((t + 0.5) * s) / k - 0.5));
      const a = Math.floor(f);
      i0[j] = a;
      i1[j] = Math.min(levelCount - 1, a + 1);
      w[j] = f - a;
    }
    return { mode, n, i0, i1, w };
  }
  // Area: target t covers source [t*s, (t+1)*s), level [t*s/k, (t+1)*s/k).
  const start = new Int32Array(n + 1);
  const index = [];
  const weight = [];
  for (let j = 0; j < n; j++) {
    const t = t0 + j;
    const a = Math.max(0, Math.min(levelCount, (t * s) / k));
    const b = Math.max(a, Math.min(levelCount, ((t + 1) * s) / k));
    start[j] = index.length;
    const first = Math.floor(a);
    const last = Math.min(levelCount - 1, Math.ceil(b) - 1);
    const total = b - a;
    if (!(total > 0)) {
      index.push(Math.min(levelCount - 1, first));
      weight.push(1);
      continue;
    }
    for (let i = first; i <= last; i++) {
      const cover = Math.min(b, i + 1) - Math.max(a, i);
      if (cover > 0) {
        index.push(i);
        weight.push(cover / total);
      }
    }
  }
  start[n] = index.length;
  return { mode, n, start, index: Int32Array.from(index), weight: Float64Array.from(weight) };
}

// The level indices [lo, hi) the taps of each target index read.
function tapRange(taps, j) {
  if (taps.mode === 'bilinear') return [taps.i0[j], taps.i1[j] + 1];
  return [taps.index[taps.start[j]], taps.index[taps.start[j + 1] - 1] + 1];
}

// Resamples target rows/columns (the taps' spans) from a block of the level:
// `src` holds level columns [offX, offX + blockWidth) of rows starting at offY.
// Writes `out` (16-bit when `src` is, else 8-bit) and, for 16-bit, `out8`.
function resampleTaps(src, blockWidth, offX, offY, colTaps, rowTaps, tx0, ty0, out, out8, outWidth) {
  const cols = colTaps.n;
  const rows = rowTaps.n;
  const wide = src instanceof Uint16Array;
  if (colTaps.mode === 'bilinear') {
    const left = new Int32Array(cols), right = new Int32Array(cols);
    for (let j = 0; j < cols; j++) {
      left[j] = (colTaps.i0[j] - offX) * 4;
      right[j] = (colTaps.i1[j] - offX) * 4;
    }
    const w = colTaps.w;
    // As resamplePreview (#270): the same expressions per channel, unrolled,
    // each tap read once, alpha of four equal taps taken as it is, and a
    // 16-bit pixel written as two words (an 8-bit one, from the table, as one).
    const to8 = wide && out8 ? eightBitTable() : null;
    const words = wide ? wordsOf(out) : null;
    const words8 = to8 ? wordsOf(out8) : null;
    for (let r = 0; r < rows; r++) {
      const row0 = (rowTaps.i0[r] - offY) * blockWidth * 4;
      const row1 = (rowTaps.i1[r] - offY) * blockWidth * 4;
      const dy = rowTaps.w[r];
      let dest = ((ty0 + r) * outWidth + tx0) * 4;
      for (let j = 0; j < cols; j++, dest += 4) {
        const dx = w[j];
        const a = row0 + left[j], b = row0 + right[j], c = row1 + left[j], d = row1 + right[j];
        let p = src[a], q = src[b], u = src[c], v = src[d];
        let top = p + (q - p) * dx;
        let bottom = u + (v - u) * dx;
        const v0 = Math.round(top + (bottom - top) * dy);
        p = src[a + 1]; q = src[b + 1]; u = src[c + 1]; v = src[d + 1];
        top = p + (q - p) * dx;
        bottom = u + (v - u) * dx;
        const v1 = Math.round(top + (bottom - top) * dy);
        p = src[a + 2]; q = src[b + 2]; u = src[c + 2]; v = src[d + 2];
        top = p + (q - p) * dx;
        bottom = u + (v - u) * dx;
        const v2 = Math.round(top + (bottom - top) * dy);
        p = src[a + 3]; q = src[b + 3]; u = src[c + 3]; v = src[d + 3];
        let v3 = p;
        if (p !== q || p !== u || p !== v) {
          top = p + (q - p) * dx;
          bottom = u + (v - u) * dx;
          v3 = Math.round(top + (bottom - top) * dy);
        }
        if (words) {
          words[dest >> 1] = v0 | (v1 << 16);
          words[(dest >> 1) + 1] = v2 | (v3 << 16);
        } else {
          out[dest] = v0; out[dest + 1] = v1; out[dest + 2] = v2; out[dest + 3] = v3;
        }
        if (words8) words8[dest >> 2] = to8[v0] | (to8[v1] << 8) | (to8[v2] << 16) | (to8[v3] << 24);
        else if (to8) {
          out8[dest] = to8[v0]; out8[dest + 1] = to8[v1]; out8[dest + 2] = to8[v2]; out8[dest + 3] = to8[v3];
        }
      }
    }
    return;
  }
  const acc = new Float64Array(cols * 4);
  const { start, index, weight } = colTaps;
  const offsets = new Int32Array(index.length);
  for (let i = 0; i < index.length; i++) offsets[i] = (index[i] - offX) * 4;
  for (let r = 0; r < rows; r++) {
    acc.fill(0);
    for (let q = rowTaps.start[r]; q < rowTaps.start[r + 1]; q++) {
      const wy = rowTaps.weight[q];
      const base = (rowTaps.index[q] - offY) * blockWidth * 4;
      for (let j = 0, o = 0; j < cols; j++, o += 4) {
        let cr = 0, cg = 0, cb = 0, ca = 0;
        for (let p = start[j]; p < start[j + 1]; p++) {
          const wx = weight[p];
          const s = base + offsets[p];
          cr += wx * src[s]; cg += wx * src[s + 1]; cb += wx * src[s + 2]; ca += wx * src[s + 3];
        }
        acc[o] += wy * cr; acc[o + 1] += wy * cg; acc[o + 2] += wy * cb; acc[o + 3] += wy * ca;
      }
    }
    let dest = ((ty0 + r) * outWidth + tx0) * 4;
    for (let o = 0; o < cols * 4; o++, dest++) {
      const v = Math.round(acc[o]);
      out[dest] = v;
      if (wide && out8) out8[dest] = Math.round(v / 257);
    }
  }
}

// The 16-bit samples of an ImageData with __image16, or of an Image16
// ({ width, height, data: Uint16Array }); null for 8-bit images.
function plane16(image) {
  return image.__image16?.data || (image.data instanceof Uint16Array ? image.data : null);
}

function levelPlane(level) {
  return plane16(level) || level.data;
}

/**
 * The display negative (or positive) of `target` size from a level with its
 * source geometry: { width, height, data } in the level's bit depth, 16-bit for
 * every built level. `out` may be passed to fill an existing plane.
 */
export function resampleDisplayLevel(level, geometry, target, out = null) {
  const { width, height } = target;
  const src = levelPlane(level);
  const plane = out || (src instanceof Uint16Array ? new Uint16Array(width * height * 4) : new Uint8ClampedArray(width * height * 4));
  const mode = displayResampleMode(geometry, target);
  const cols = axisTaps(mode, width, geometry.sourceWidth, geometry.k, level.width, 0, width);
  const rows = axisTaps(mode, height, geometry.sourceHeight, geometry.k, level.height, 0, height);
  resampleTaps(src, level.width, 0, 0, cols, rows, 0, 0, plane, null, width);
  return { width, height, data: plane };
}

/**
 * Rows [lo, hi) of a level of `levelHeight` rows that the target rows [ty0,
 * ty1) of resampleDisplayLevel read (#270: a band of a detail region gets only
 * these rows).
 */
export function displayResampleRows(geometry, target, levelHeight, ty0, ty1) {
  const mode = displayResampleMode(geometry, target);
  const rows = axisTaps(mode, target.height, geometry.sourceHeight, geometry.k, levelHeight, ty0, ty1);
  let lo = levelHeight, hi = 0;
  for (let j = 0; j < rows.n; j++) {
    const [a, b] = tapRange(rows, j);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return lo < hi ? [lo, hi] : [0, 0];
}

/**
 * Target rows [ty0, ty1) of resampleDisplayLevel(level, geometry, target), the
 * same values, from `block`: rows [offY, offY + block rows) of a level of
 * levelWidth x levelHeight (an Image16 or a plane). 16-bit planes only.
 */
export function resampleDisplayLevelRows(block, offY, levelWidth, levelHeight, geometry, target, ty0, ty1) {
  const src = block instanceof Uint16Array ? block : levelPlane(block);
  if (!(src instanceof Uint16Array)) throw new TypeError('A 16-bit level block is needed');
  const mode = displayResampleMode(geometry, target);
  const cols = axisTaps(mode, target.width, geometry.sourceWidth, geometry.k, levelWidth, 0, target.width);
  const rows = axisTaps(mode, target.height, geometry.sourceHeight, geometry.k, levelHeight, ty0, ty1);
  const plane = new Uint16Array(target.width * (ty1 - ty0) * 4);
  resampleTaps(src, levelWidth, 0, offY, cols, rows, 0, 0, plane, null, target.width);
  return { width: target.width, height: ty1 - ty0, data: plane };
}

/**
 * The part-3 display filter of a whole image (a full-resolution positive, #248
 * part 4): its level, then the resample, with both planes. 8-bit images keep
 * an 8-bit result only. Returns `image` itself when it is not larger than the
 * target.
 */
export function filterDisplayImage(image, target, { k = displayLevelFactor(image.width, image.height) } = {}) {
  if (target.width >= image.width && target.height >= image.height) return image;
  const level = buildDisplayLevel(image, k);
  const geometry = { sourceWidth: image.width, sourceHeight: image.height, k };
  const output = new ImageData(target.width, target.height);
  const src = levelPlane(level);
  const wide = Boolean(plane16(image));
  const mode = displayResampleMode(geometry, target);
  const cols = axisTaps(mode, target.width, image.width, k, level.width, 0, target.width);
  const rows = axisTaps(mode, target.height, image.height, k, level.height, 0, target.height);
  if (src instanceof Uint16Array) {
    const plane = new Uint16Array(target.width * target.height * 4);
    resampleTaps(src, level.width, 0, 0, cols, rows, 0, 0, plane, output.data, target.width);
    if (wide) output.__image16 = { width: target.width, height: target.height, data: plane };
  } else {
    resampleTaps(src, level.width, 0, 0, cols, rows, 0, 0, output.data, null, target.width);
  }
  displayFilters.set(output, { kind: 'area', k });
  return output;
}

// Target indices [first, last + 1) whose footprint (level indices, each
// covering source [i*k, i*k + k)) meets source span [start, end).
function footprintSpan(taps, start, end, k, levelCount) {
  const lo = Math.floor(start / k);
  const hi = Math.min(levelCount, Math.ceil(end / k));
  if (lo >= hi) return null;
  let first = -1, last = -1;
  for (let j = 0; j < taps.n; j++) {
    const [a, b] = tapRange(taps, j);
    if (b <= lo || a >= hi) continue;
    if (first < 0) first = j;
    last = j;
  }
  return first < 0 ? null : [first, last + 1];
}

function sliceTaps(taps, first, last) {
  if (taps.mode === 'bilinear') {
    return { mode: 'bilinear', n: last - first, i0: taps.i0.subarray(first, last), i1: taps.i1.subarray(first, last), w: taps.w.subarray(first, last) };
  }
  const base = taps.start[first];
  const start = new Int32Array(last - first + 1);
  for (let j = first; j <= last; j++) start[j - first] = taps.start[j] - base;
  return { mode: 'area', n: last - first, start, index: taps.index.subarray(base, taps.start[last]), weight: taps.weight.subarray(base, taps.start[last]) };
}

// The display pixels of filterDisplayImage(frame, target, { k }) whose
// footprint meets source rect `rect`: their taps, their target spans and the
// level block [minX, maxX) x [minY, maxY) the taps read. Null when none.
function filterFootprint(frame, target, k, rect) {
  const levelWidth = Math.floor(frame.width / k);
  const levelHeight = Math.floor(frame.height / k);
  const geometry = { sourceWidth: frame.width, sourceHeight: frame.height, k };
  const mode = displayResampleMode(geometry, target);
  const allCols = axisTaps(mode, target.width, frame.width, k, levelWidth, 0, target.width);
  const allRows = axisTaps(mode, target.height, frame.height, k, levelHeight, 0, target.height);
  const columns = footprintSpan(allCols, rect.x, rect.x + rect.width, k, levelWidth);
  const rows = footprintSpan(allRows, rect.y, rect.y + rect.height, k, levelHeight);
  if (!columns || !rows) return null;
  // The level block those taps read (taps are monotonic, but take the extremes anyway).
  let minX = Infinity, maxX = 0, minY = Infinity, maxY = 0;
  for (let j = columns[0]; j < columns[1]; j++) { const [a, b] = tapRange(allCols, j); minX = Math.min(minX, a); maxX = Math.max(maxX, b); }
  for (let j = rows[0]; j < rows[1]; j++) { const [a, b] = tapRange(allRows, j); minY = Math.min(minY, a); maxY = Math.max(maxY, b); }
  return {
    cols: sliceTaps(allCols, columns[0], columns[1]), rowTaps: sliceTaps(allRows, rows[0], rows[1]),
    columns, rows, minX, maxX, minY, maxY,
  };
}

/**
 * Where a change of a frame inside source rect `rect` shows in its display
 * image filterDisplayImage(frame, target, { k }) (#254 follow-up): `display`,
 * the display pixels whose footprint meets the rect, and `source`, the frame
 * pixels those display pixels read (whole level boxes, inside the frame).
 * Null when the rect reaches no display pixel. filterDisplayRegion makes the
 * pixels of `display` from the frame's pixels inside `source` alone.
 */
export function displayFootprint(frame, target, k, rect) {
  const footprint = filterFootprint(frame, target, k, rect);
  if (!footprint) return null;
  const { columns, rows, minX, maxX, minY, maxY } = footprint;
  return {
    display: { x: columns[0], y: rows[0], width: columns[1] - columns[0], height: rows[1] - rows[0] },
    source: { x: minX * k, y: minY * k, width: (maxX - minX) * k, height: (maxY - minY) * k },
  };
}

/**
 * The pixels filterDisplayImage(frame, target, { k }) gives over `display` (a
 * displayFootprint result's), made from `plane`: the frame's 16-bit RGBA
 * pixels inside `source` ({ width, height, data } of the source rect's size).
 * Returns { width, height, data, image16 }: the 8-bit and 16-bit values the
 * whole-frame filter gives there.
 */
export function filterDisplayRegion(plane, source, frame, target, k, display) {
  if (!(plane?.data instanceof Uint16Array) || plane.width !== source.width || plane.height !== source.height) {
    throw new TypeError('A 16-bit plane of the source region is needed');
  }
  if (source.x % k || source.y % k || source.width % k || source.height % k) throw new RangeError('The source region must hold whole level boxes');
  const levelWidth = Math.floor(frame.width / k);
  const levelHeight = Math.floor(frame.height / k);
  const mode = displayResampleMode({ sourceWidth: frame.width, sourceHeight: frame.height, k }, target);
  const cols = axisTaps(mode, target.width, frame.width, k, levelWidth, display.x, display.x + display.width);
  const rows = axisTaps(mode, target.height, frame.height, k, levelHeight, display.y, display.y + display.height);
  let block = plane.data;
  let blockWidth = source.width;
  if (k > 1) {
    blockWidth = source.width / k;
    block = new Uint16Array(blockWidth * (source.height / k) * 4);
    boxLevelRows(plane, k, 0, blockWidth, 0, source.height / k, block, blockWidth);
  }
  const image16 = new Uint16Array(display.width * display.height * 4);
  const data = new Uint8ClampedArray(image16.length);
  resampleTaps(block, blockWidth, source.x / k, source.y / k, cols, rows, 0, 0, image16, data, display.width);
  return { width: display.width, height: display.height, data, image16 };
}

function updateFilteredRect(image, preview, rect, k) {
  const footprint = filterFootprint(image, preview, k, rect);
  if (!footprint) return null;
  const { cols, rowTaps, columns, rows, minX, maxX, minY, maxY } = footprint;
  let block;
  let blockWidth;
  let offX = minX;
  let offY = minY;
  if (k === 1) {
    block = levelPlane(image);
    blockWidth = image.width;
    offX = 0;
    offY = 0;
  } else {
    blockWidth = maxX - minX;
    block = new Uint16Array(blockWidth * (maxY - minY) * 4);
    boxLevelRows(image, k, minX, maxX, minY, maxY, block, blockWidth);
  }
  const wide = block instanceof Uint16Array;
  if (wide && preview.__image16?.data) {
    resampleTaps(block, blockWidth, offX, offY, cols, rowTaps, columns[0], rows[0], preview.__image16.data, preview.data, preview.width);
  } else if (wide) {
    // A 16-bit source whose preview kept 8 bits only: resample into a scratch plane.
    const scratch = new Uint16Array(cols.n * rowTaps.n * 4);
    const eight = new Uint8ClampedArray(scratch.length);
    resampleTaps(block, blockWidth, offX, offY, cols, rowTaps, 0, 0, scratch, eight, cols.n);
    for (let r = 0; r < rowTaps.n; r++) {
      preview.data.set(eight.subarray(r * cols.n * 4, (r + 1) * cols.n * 4), ((rows[0] + r) * preview.width + columns[0]) * 4);
    }
  } else {
    resampleTaps(block, blockWidth, offX, offY, cols, rowTaps, columns[0], rows[0], preview.data, null, preview.width);
  }
  return { x: columns[0], y: rows[0], width: columns[1] - columns[0], height: rows[1] - rows[0] };
}

// ---------------------------------------------------------------------------
// Display targets (#248 part 3): the conversion preview is not a resampled
// image on the main thread any more, but a size and the level the preview
// worker resamples it from. One object per (level, size), so identity checks
// (the GPU preview's tags, history, the worker's caches) stay stable. The
// reduced preview tier (#263) has objects of its own: main.js marks every one
// it converts as unsettled, and a normal-tier target of the same size (a later
// window) must never carry that mark (#229 review R1-089).
// ---------------------------------------------------------------------------

const displayTargets = new WeakMap();

export function displayTargetFor(level, { width, height }, tier = 'normal') {
  let byLevel = displayTargets.get(level);
  if (!byLevel) displayTargets.set(level, (byLevel = new Map()));
  const key = tier === 'reduced' ? `${width}x${height} reduced` : `${width}x${height}`;
  let target = byLevel.get(key);
  if (!target) byLevel.set(key, (target = { width, height, __displayOf: level }));
  return target;
}

export function isDisplayTarget(image) {
  return Boolean(image && image.__displayOf);
}

// Hysteresis (#248 part 2): a display image of `current` size keeps serving a
// new `target` while it is at most 15 % larger or about 5 % smaller in both
// dimensions. A larger one only costs conversion time; a smaller one softens
// the settled view. Estimates to tune.
export const DISPLAY_SIZE_MAX_LARGER = 1.15;
export const DISPLAY_SIZE_MAX_SMALLER = 0.95;

export function displaySizeServes(current, target) {
  if (!current || !target) return false;
  if (current.width === target.width && current.height === target.height) return true;
  return current.width <= target.width * DISPLAY_SIZE_MAX_LARGER && current.height <= target.height * DISPLAY_SIZE_MAX_LARGER
    && current.width >= target.width * DISPLAY_SIZE_MAX_SMALLER && current.height >= target.height * DISPLAY_SIZE_MAX_SMALLER;
}

// ---------------------------------------------------------------------------
// Row bands
// ---------------------------------------------------------------------------

function defaultPause() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Runs `runRows(y0, y1)` over [0, total) in bands sized to take about
 * `budgetMs` each (measured as it goes), awaiting `pause()` between bands.
 * Resolves false as soon as `isCurrent()` is false after a pause.
 */
export async function runInBands(total, runRows, { budgetMs = 12, pause = defaultPause, isCurrent = () => true } = {}) {
  let rows = 8;
  let y = 0;
  while (y < total) {
    const end = Math.min(total, y + rows);
    const started = now();
    runRows(y, end);
    const spent = Math.max(0.01, now() - started);
    const band = end - y;
    y = end;
    // Aim at the budget, and never grow a band more than 4x at once.
    rows = Math.max(1, Math.min(band * 4, Math.floor((band * budgetMs) / spent)));
    if (y >= total) break;
    await pause();
    if (!isCurrent()) return false;
  }
  return true;
}
