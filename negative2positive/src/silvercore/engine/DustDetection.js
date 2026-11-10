/**
 * DustDetection.js - finds dust, hairs and scratches on a converted frame
 *
 * Dust sits on the film, so on the frame it is a small blob (or a thin line)
 * that stands alone on a locally calm background. The detector looks for
 * exactly that, at several scales, and measures every candidate against its
 * own surroundings instead of against the frame as a whole:
 *
 *   1. A pyramid of the grey frame (1, 1/2, 1/4, ...) and a top-hat at each
 *      level. A soft speck a dozen pixels across responds below the grain at
 *      full size and well above it two levels down.
 *   2. The response is read in units of the local grain (the block median of
 *      the response). Seeds stand well above it and are grown down to a lower
 *      level; blocks whose surroundings respond densely are texture.
 *   3. Each candidate must stand on a flat background: its response is
 *      compared with the spread of the response in the ring around it, and
 *      that ring may hold only a few pixels that differ from its median by
 *      as much as the blob does (in either direction: texture is two-sided).
 *   4. A kept blob's footprint is taken at full size, down to a share of its
 *      own contrast, and the size rule reads its half-maximum core. Past the
 *      size cap only a hair passes: thin and long, and past twice the cap
 *      bent. A hair, and any thin elongated speck (a short line), must also
 *      be as sharp as the film is and end where it ends: a line with soft
 *      shoulders, or one that goes on past what was found of it, is a line
 *      of the picture (a seam, a wire, an edge).
 *   5. Dust lands anywhere; highlights in foliage or sparkle on water come in
 *      crowds. A neighbourhood holding more blobs than a cap is texture.
 *
 * Polarity: what blocks light on a negative comes out bright on the frame, so
 * negatives look for bright blobs and positives (slides) for dark ones.
 *
 * Every plane is an integer: level l holds the sum of 2^l x 2^l grey values,
 * so the two OpenCV builds (scalar and SIMD) give the same masks.
 * See docs/dust-removal.md.
 */

import { LITTLE_ENDIAN } from '../util/image16.js';

function cv() {
  return globalThis.window?.cv || globalThis.cv;
}

// ─── Grey ────────────────────────────────────────────────────────────────────

// OpenCV's COLOR_RGBA2GRAY on 8-bit samples is (R·9798 + G·19235 + B·3735 +
// 2^14) >> 15, its 15-bit weights; alpha takes no part. Both shipped builds,
// the package's scalar module and the SIMD one (#292), give exactly these
// bytes on all 2^24 RGB triples.
const GRAY_R = 9798;
const GRAY_G = 19235;
const GRAY_B = 3735;
const GRAY_HALF = 1 << 14;
const GRAY_SHIFT = 15;

/** cv.cvtColor(COLOR_RGBA2GRAY) of `pixelCount` RGBA pixels into `gray`. */
export function rgbaToGrayInto(rgba, gray, pixelCount) {
  if (LITTLE_ENDIAN && rgba.byteOffset % 4 === 0) {
    // One load per pixel: R is the low byte of the little-endian word.
    const words = new Uint32Array(rgba.buffer, rgba.byteOffset, pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      const v = words[p];
      gray[p] = ((v & 255) * GRAY_R + ((v >>> 8) & 255) * GRAY_G + ((v >>> 16) & 255) * GRAY_B + GRAY_HALF) >> GRAY_SHIFT;
    }
    return gray;
  }
  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    gray[p] = (rgba[i] * GRAY_R + rgba[i + 1] * GRAY_G + rgba[i + 2] * GRAY_B + GRAY_HALF) >> GRAY_SHIFT;
  }
  return gray;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HAT_KERNEL = 9;          // structuring element diameter at every level (px of the level)
const MAX_LEVELS = 5;          // level 4 sums 256 grey values: 65280 at most, the last that fits 16 bits
const MIN_LEVEL_SIDE = 48;     // a level smaller than this holds no neighbourhoods
const BLOCK_SHIFT = 5;
const BLOCK = 1 << BLOCK_SHIFT; // the grain is measured per block of the level
const GROW = 3.2;              // a blob is grown down to this many grains
const CLUTTER_BLOCKS = 2;      // the surroundings of a block: 5 x 5 blocks without the block itself
const CLUTTER_MAX = 0.14;      // share of the surroundings above GROW that marks dense texture
const GRAIN_FLOOR = 0.35;      // grey levels: a flat or clipped area must not divide by nothing
const MIN_CONTRAST = 2.5;      // grey levels a blob must stand above its ring
const RING_NEAR = 2;           // px around the blob that belong to neither blob nor ring
const RING_PAD_MIN = 6;
const RING_PAD_MAX = 48;
const RING_MIN_SAMPLES = 24;
const RING_SAMPLES = 400;      // about what a box ring is read at (larger windows are subsampled)
const RING_MAX_SAMPLES = 16384; // what a band along a hair is read at, at most
const RING_COMPACT = 32;       // blobs up to this long read a square ring, longer ones a band
const RING_BAND_THICKNESSES = 4; // a long blob's band, in its own thicknesses
const RING_BAND_MAX = 16;
const RING_BOX_FILL = 4;       // a long blob whose grown box is at most this many times its area reads the box's surroundings
const RING_DEVIATION = 0.6;    // a ring pixel deviates when it is off the median by this share of the blob's contrast
const RING_MAX_SHARE = 0.12;   // share of deviating ring pixels above which the background is not flat
const SPREAD_FROM_P90 = 1.2816; // a normal distribution's 90th percentile, in standard deviations
const FOOTPRINT = 0.3;         // the mask reaches down to this share of the blob's contrast
const FOOTPRINT_REACH = 2;     // px a footprint may reach past the blob the level found, besides one px of the level
const FOOTPRINT_SKIRT = 3;     // px a line's footprint is wider than its half-maximum core
const COMPONENT_MAX = 16384;   // px of a level: anything larger is a structure, not a defect
const HAIR_MAX_SHARE = 0.6;     // a hair may cross this share of the short side
const HAIR_THICKNESS_SHARE = 0.004; // how thick a hair's core may be, as a share of the short side (about 100 um on 35 mm film)
const HAIR_ASPECT = 10;        // a hair is at least this many times as long as it is thick
const HAIR_BOW = 0.035;        // a bent line's sagitta over its chord, at least
const HAIR_SKIRT = 3;          // px a hair's footprint may be thicker than its core: dust on the film is in focus...
const HAIR_SKIRT_SHARE = 0.001; // ...or this share of the short side on a larger frame (about 25 um on 35 mm film)
const HAIR_CONTINUES = 0.4;    // a ridge this share of the line's contrast past an end: the line goes on
const CONTINUE_GAP = 3;        // px past an end's tip the strip starts, besides half the line's width
const CONTINUE_SHARE = 0.35;   // the strip's reach, as a share of the line's length...
const CONTINUE_MIN = 12;       // ...in px, at least
const CONTINUE_MAX = 40;       // ...and at most
const CONTINUE_TAIL = 0.25;    // an end is this share of the line's length
const CONTINUE_SAMPLES = 6;    // pixels the strip and its flanks need to say anything
const HAIR_STRAIGHT_LENGTHS = 2; // a hair up to this many size caps long may be straight; a longer one bends
const SPECK_LINE_ASPECT = 3;   // a speck this many times as long as it is thick...
const SPECK_LINE_THICKNESS_SHARE = 0.003; // ...and at most this share of the short side thick (about 70 um on 35 mm film) is a short line
const JOINED_LENGTHS = 1.3;    // a blob this many times longer than its longest piece is pieces of one line
const EDGE_BAND = 0.02;        // a long line inside this share of the short side from the frame edge is the frame's border
const CROWD_CELLS = 12;        // the short side in crowd cells
const DILATE_SHARE = 0.0015;   // the final dilation, as a share of the frame height

const DUST_DEFAULT_MAX_SIZE_RATIO = 0.016; // default particle cap as a share of the short edge

/** Default cap on a dust blob's long side, in px, for a given frame size. */
export function defaultMaxParticleSize(width, height) {
  return Math.max(8, Math.round(Math.min(width, height) * DUST_DEFAULT_MAX_SIZE_RATIO));
}

// The UI's sensitivity, 1-10, as the three thresholds it moves. Every one
// relaxes as the sensitivity rises, so what a detection keeps at one
// sensitivity contains what it keeps at any lower one.
const STRENGTH_KNOTS = [1, 3, 5, 8, 10];
const SEED_AT = [7.5, 5.6, 4.9, 4.3, 3.8];       // grains a seed stands above the local grain
const RING_Z_AT = [10.0, 6.5, 5.5, 4.5, 3.8];    // spreads of the ring's response a blob's peak stands above it
const CROWD_AT = [5.0, 9.0, 14.0, 24.0, 60.0];   // blobs per 1 % of the frame a neighbourhood may hold

function interpolate(s, values) {
  for (let k = 1; k < STRENGTH_KNOTS.length; k++) {
    if (s <= STRENGTH_KNOTS[k]) {
      const a = STRENGTH_KNOTS[k - 1], b = STRENGTH_KNOTS[k];
      return values[k - 1] + (s - a) / (b - a) * (values[k] - values[k - 1]);
    }
  }
  return values[values.length - 1];
}

/** { seed, ringZ, crowd } for a sensitivity; the highest one keeps crowds too. */
export function dustThresholds(strength) {
  const s = Math.min(10, Math.max(1, Number.isFinite(strength) ? strength : 3));
  return {
    seed: interpolate(s, SEED_AT),
    ringZ: interpolate(s, RING_Z_AT),
    crowd: s >= 10 ? Infinity : interpolate(s, CROWD_AT),
  };
}

/** Pyramid levels that cover blobs up to `maxSize` px on a w × h frame. */
export function dustPyramidLevels(maxSize, width, height) {
  let levels = 1;
  while (levels < MAX_LEVELS && HAT_KERNEL * 2 ** (levels - 1) < maxSize * 1.5
    && Math.min(width >> levels, height >> levels) >= MIN_LEVEL_SIDE) levels++;
  return levels;
}

// ─── Small numeric helpers ───────────────────────────────────────────────────

/** The k-th smallest of values[0..n) (0-based); reorders that range. */
function selectKth(values, n, k) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) { const t = values[i]; values[i] = values[j]; values[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return values[k];
  }
  return values[k];
}

/** Sums of the 2 × 2 blocks of a plane (a trailing odd row or column is dropped). */
function halvePlane(src, sw, sh) {
  const dw = sw >> 1, dh = sh >> 1;
  const dst = new Uint16Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    let a = 2 * y * sw, b = a + sw, d = y * dw;
    for (let x = 0; x < dw; x++, a += 2, b += 2, d++) dst[d] = src[a] + src[a + 1] + src[b] + src[b + 1];
  }
  return dst;
}

class GrowableInt32 {
  constructor(capacity = 1024) { this.data = new Int32Array(capacity); this.length = 0; }
  reserve(extra) {
    if (this.length + extra <= this.data.length) return;
    const next = new Int32Array(Math.max(this.data.length * 2, this.length + extra));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(value) { if (this.length === this.data.length) this.reserve(1); this.data[this.length++] = value; }
  trimmed() { return this.data.slice(0, this.length); }
}

// ─── One level ───────────────────────────────────────────────────────────────

// Several samples in one 32-bit word (four 8-bit or two 16-bit ones), so a
// run of samples below a gate costs one load and one branch per word. With
// `low` the samples' bits below their top bit and `add` = low minus the
// gate's own low bits in every sample, (word & low) + add carries into a
// sample's top bit exactly when its low bits exceed the gate's. A gate below
// half the range is also exceeded by every sample whose top bit is set (OR);
// a gate from half the range up only by those (AND).
function wordLayout(samples) {
  if (!LITTLE_ENDIAN || (samples.byteOffset & 3) !== 0) return null;
  if (samples instanceof Uint8Array) return { per: 4, indexShift: 2, low: 0x7f7f7f7f, top: 0x80808080, ones: 0x01010101, half: 128, limit: 255 };
  if (samples instanceof Uint16Array) return { per: 2, indexShift: 1, low: 0x7fff7fff, top: 0x80008000, ones: 0x00010001, half: 32768, limit: 65535 };
  return null;
}

/** White top-hat (bright blobs) or black-hat (dark blobs) of a level, as an OpenCV Mat. */
function hatMat(plane, w, h, sign) {
  const c = cv();
  const sixteen = plane instanceof Uint16Array;
  const src = new c.Mat(h, w, sixteen ? c.CV_16UC1 : c.CV_8UC1);
  let kernel = null, dst = null;
  try {
    (sixteen ? src.data16U : src.data).set(plane);
    kernel = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(HAT_KERNEL, HAT_KERNEL));
    dst = new c.Mat();
    c.morphologyEx(src, dst, sign > 0 ? c.MORPH_TOPHAT : c.MORPH_BLACKHAT, kernel);
    return dst;
  } catch (error) {
    if (dst && !dst.isDeleted()) dst.delete();
    throw error;
  } finally {
    src.delete();
    if (kernel) kernel.delete();
  }
}

// Response histograms hold bins of at most 1/16 grey level: the coarse
// levels, whose samples are sums of up to 256 grey values, shift them down.
const HISTOGRAM_BINS = 4096;
function histogramShift(unit) {
  let shift = 0;
  while (((255 * unit) >> shift) >= HISTOGRAM_BINS) shift++;
  return shift;
}

/**
 * Per block, from one histogram of the response read on every second row and
 * column: the grain (the median, never below the floor), how many of those
 * samples stand above the grow level, and how many samples there were.
 */
function blockStatistics(resp, w, h, unit, shift) {
  const wb = Math.ceil(w / BLOCK), hb = Math.ceil(h / BLOCK);
  const grain = new Float32Array(wb * hb);
  const above = new Uint32Array(wb * hb);
  const sampled = new Uint32Array(wb * hb);
  const hist = new Uint32Array(HISTOGRAM_BINS);
  const floor = GRAIN_FLOOR * unit;
  for (let by = 0; by < hb; by++) {
    const y0 = by * BLOCK, y1 = Math.min(h, y0 + BLOCK);
    for (let bx = 0; bx < wb; bx++) {
      const x0 = bx * BLOCK, x1 = Math.min(w, x0 + BLOCK);
      let count = 0, top = 0;
      for (let y = y0; y < y1; y += 2) {
        const row = y * w;
        for (let x = x0; x < x1; x += 2) {
          const bin = resp[row + x] >> shift;
          hist[bin]++;
          if (bin > top) top = bin;
          count++;
        }
      }
      const half = (count + 1) >> 1;
      let cumulative = 0, bin = 0;
      for (; bin <= top; bin++) {
        cumulative += hist[bin];
        if (cumulative >= half) break;
      }
      const median = bin << shift;
      const g = median > floor ? median : floor;
      // Samples above GROW grains: the bins past that level.
      const growBin = Math.floor(GROW * g) >> shift;
      let over = 0;
      for (let k = growBin + 1; k <= top; k++) over += hist[k];
      hist.fill(0, 0, top + 1);
      const b = by * wb + bx;
      grain[b] = g;
      above[b] = over;
      sampled[b] = count;
    }
  }
  return { grain, above, sampled, wb, hb };
}

/**
 * Everything one level contributes: seeds grown into components, each
 * verified against its ring; the verified ones are handed to `accept`.
 */
function scanLevel(level, lum, resp, w, h, sign, thresholds, scratch, accept) {
  const unit = 4 ** level;
  const shift = histogramShift(unit);
  const { grain, above, sampled, wb, hb } = blockStatistics(resp, w, h, unit, shift);
  const blocks = wb * hb;
  const invBlock = 1 / BLOCK;
  const minContrast = MIN_CONTRAST * unit;

  // The grain at a pixel: the block medians, bilinear between block centres.
  const grainAt = (x, y) => {
    let fx = (x + 0.5) * invBlock - 0.5, fy = (y + 0.5) * invBlock - 0.5;
    let bx = Math.floor(fx), by = Math.floor(fy);
    let tx = fx - bx, ty = fy - by;
    if (bx < 0) { bx = 0; tx = 0; } else if (bx >= wb - 1) { bx = wb - 1; tx = 0; }
    if (by < 0) { by = 0; ty = 0; } else if (by >= hb - 1) { by = hb - 1; ty = 0; }
    const i = by * wb + bx;
    const right = tx > 0 ? 1 : 0, down = ty > 0 ? wb : 0;
    const top = grain[i] + (grain[i + right] - grain[i]) * tx;
    const bottom = grain[i + down] + (grain[i + down + right] - grain[i + down]) * tx;
    return top + (bottom - top) * ty;
  };

  // Dense texture: a large share of the blocks around a block responds.
  const quiet = new Uint8Array(blocks);
  for (let by = 0; by < hb; by++) for (let bx = 0; bx < wb; bx++) {
    let sum = 0, samples = 0;
    for (let ny = Math.max(0, by - CLUTTER_BLOCKS); ny <= Math.min(hb - 1, by + CLUTTER_BLOCKS); ny++) {
      for (let nx = Math.max(0, bx - CLUTTER_BLOCKS); nx <= Math.min(wb - 1, bx + CLUTTER_BLOCKS); nx++) {
        if (nx === bx && ny === by) continue;
        sum += above[ny * wb + nx];
        samples += sampled[ny * wb + nx];
      }
    }
    quiet[by * wb + bx] = samples === 0 || sum < CLUTTER_MAX * samples ? 1 : 0;
  }

  // The grain is bilinear between block centres, so over a quadrant of a
  // block it is lowest at one of the quadrant's corners: the block centre,
  // two edge midpoints, the block corner. That bounds what a pixel must
  // exceed, cheaply: the seed level for the pixels of quiet blocks that may
  // be seeds, the grow level for the pixels a blob may grow into. The exact
  // tests against the interpolated grain follow below.
  //
  // The scan reads several samples per 32-bit word (see wordLayout): a word
  // with nothing above the block's lowest seed level costs one branch.
  const seeds = scratch.seeds;
  seeds.length = 0;
  const layout = wordLayout(resp);
  const words = layout ? new Uint32Array(resp.buffer, resp.byteOffset, resp.byteLength >>> 2) : null;
  const per = layout ? layout.per : 1, indexShift = layout ? layout.indexShift : 0;
  const lowBits = layout ? layout.low : 0, topBits = layout ? layout.top : 0, halfRange = layout ? layout.half : 0;
  const sampleBits = 32 / per;
  const growGate = new Float32Array(blocks);
  const seedGate = new Float64Array(4);
  const middle = BLOCK >> 1;
  for (let by = 0; by < hb; by++) {
    const y0 = by * BLOCK, y1 = Math.min(h, y0 + BLOCK), ym = y0 + middle;
    const up = by > 0 ? -wb : 0, down = by < hb - 1 ? wb : 0;
    for (let bx = 0; bx < wb; bx++) {
      const b = by * wb + bx;
      const x0 = bx * BLOCK, x1 = Math.min(w, x0 + BLOCK), xm = x0 + middle;
      const left = bx > 0 ? -1 : 0, right = bx < wb - 1 ? 1 : 0;
      const g = grain[b];
      let lowestOfBlock = g;
      for (let q = 0; q < 4; q++) {
        const dx = q & 1 ? right : left, dy = q & 2 ? down : up;
        const lowest = Math.min(g, (g + grain[b + dx]) / 2, (g + grain[b + dy]) / 2,
          (g + grain[b + dx] + grain[b + dy] + grain[b + dx + dy]) / 4);
        if (lowest < lowestOfBlock) lowestOfBlock = lowest;
        seedGate[q] = Math.floor(Math.max(thresholds.seed * lowest, minContrast));
      }
      if (!quiet[b]) { growGate[b] = Infinity; continue; }
      growGate[b] = Math.floor(Math.max(GROW * lowestOfBlock, minContrast * 0.5));
      // Integer samples: v > t is v > floor(t).
      const gate = Math.min(seedGate[0], seedGate[1], seedGate[2], seedGate[3]);
      if (!words) {
        for (let y = y0; y < y1; y++) {
          const row = y * w, lower = y >= ym ? 2 : 0;
          for (let x = x0; x < x1; x++) {
            if (resp[row + x] > seedGate[lower | (x >= xm ? 1 : 0)]) seeds.push(row + x);
          }
        }
        continue;
      }
      if (gate >= layout.limit) continue;
      const high = gate >= halfRange;
      const add = lowBits - (high ? gate - halfRange : gate) * layout.ones;
      for (let y = y0; y < y1; y++) {
        const row = y * w, lower = y >= ym ? 2 : 0, end = row + x1, split = row + xm;
        let i = row + x0;
        for (; i < end && (i & (per - 1)); i++) {
          if (resp[i] > seedGate[lower | (i >= split ? 1 : 0)]) seeds.push(i);
        }
        for (; i + per <= end; i += per) {
          const word = words[i >>> indexShift];
          const sum = (word & lowBits) + add;
          const hit = (high ? sum & word : sum | word) & topBits;
          if (hit === 0) continue;
          for (let k = 0; k < per; k++) {
            if (!((hit >>> (k * sampleBits + sampleBits - 1)) & 1)) continue;
            const j = i + k;
            if (resp[j] > seedGate[lower | (j >= split ? 1 : 0)]) seeds.push(j);
          }
        }
        for (; i < end; i++) {
          if (resp[i] > seedGate[lower | (i >= split ? 1 : 0)]) seeds.push(i);
        }
      }
    }
  }

  const visited = new Uint32Array((w * h + 31) >>> 5);
  const comp = scratch.component;
  const stack = scratch.stack;
  const seedData = seeds.data;
  for (let s = 0; s < seeds.length; s++) {
    const start = seedData[s];
    if (visited[start >>> 5] & (1 << (start & 31))) continue;
    const sx = start % w, sy = (start - sx) / w;
    const startRatio = resp[start] / grainAt(sx, sy);
    if (startRatio <= thresholds.seed) continue;

    // Grow the seed down to GROW grains (8-connected), inside quiet blocks.
    // The component is the same whichever of its seeds starts it, so a
    // detection at one sensitivity finds the components of every lower one.
    comp.length = 0;
    stack.length = 0;
    stack.push(start);
    visited[start >>> 5] |= 1 << (start & 31);
    let minX = sx, maxX = sx, minY = sy, maxY = sy, peak = 0, maxRatio = startRatio, oversize = false;
    while (stack.length) {
      const p = stack.data[--stack.length];
      const px = p % w, py = (p - px) / w;
      // A structure, not a defect: the rest of it is still visited, so no
      // other seed takes a piece of it for a blob.
      if (comp.length >= COMPONENT_MAX) oversize = true;
      if (!oversize) {
        comp.push(p);
        const value = resp[p];
        if (value > peak) peak = value;
        if (px < minX) minX = px; else if (px > maxX) maxX = px;
        if (py < minY) minY = py; else if (py > maxY) maxY = py;
      }
      const yLow = py > 0 ? py - 1 : 0, yHigh = py < h - 1 ? py + 1 : h - 1;
      const xLow = px > 0 ? px - 1 : 0, xHigh = px < w - 1 ? px + 1 : w - 1;
      for (let ny = yLow; ny <= yHigh; ny++) {
        const blockRow = (ny >> BLOCK_SHIFT) * wb;
        for (let nx = xLow; nx <= xHigh; nx++) {
          const q = ny * w + nx;
          if (visited[q >>> 5] & (1 << (q & 31))) continue;
          const vq = resp[q];
          if (vq <= growGate[blockRow + (nx >> BLOCK_SHIFT)]) continue;
          const ratio = vq / grainAt(nx, ny);
          if (ratio <= GROW) continue;
          visited[q >>> 5] |= 1 << (q & 31);
          stack.push(q);
          if (ratio > maxRatio) maxRatio = ratio;
        }
      }
    }
    if (oversize) continue;

    const verdict = verifyBlob(lum, resp, w, h, unit, shift, sign, comp, minX, minY, maxX, maxY, peak, thresholds.ringZ, scratch);
    if (verdict) accept(level, comp, minX, minY, maxX, maxY, verdict.median, verdict.contrast, verdict.z, maxRatio);
  }
}

/**
 * Stage 3: does the component stand on a flat background? Returns the ring's
 * median, the blob's contrast and its z, or null.
 *
 * Most candidates are grain and fail the first test, so that one is cheap: a
 * histogram of the ring's response. The ring's grey values are only read for
 * the few that pass it.
 */
function verifyBlob(lum, resp, w, h, unit, shift, sign, comp, minX, minY, maxX, maxY, peak, ringZ, scratch) {
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const longSide = bw > bh ? bw : bh;
  const count = comp.length, pixels = comp.data;
  // A small blob is read against a ring as wide as itself; a long one (a
  // hair) against a band a few of its own thicknesses wide. Where the blob
  // fills its own box (small blobs, straight lines along an axis) the ring is
  // simply the box's surroundings; a slanted or curved hair needs the band
  // traced along it.
  const small = longSide <= RING_COMPACT;
  const pad = small ? Math.min(RING_PAD_MAX, Math.max(RING_PAD_MIN, longSide))
    : Math.min(RING_BAND_MAX, Math.max(RING_PAD_MIN, Math.round(RING_BAND_THICKNESSES * count / longSide)));
  const compact = small || (bw + 2 * RING_NEAR) * (bh + 2 * RING_NEAR) <= RING_BOX_FILL * count;
  const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w, maxX + 1 + pad), y1 = Math.min(h, maxY + 1 + pad);
  const hist = scratch.hist;
  let samples = 0, top = 0;
  // Compact blobs: the ring is the window without the blob's box grown by RING_NEAR.
  let nx0 = 0, nx1 = 0, ny0 = 0, ny1 = 0, step = 1;
  // Long blobs: the band along them, by distance, and how it is subsampled.
  let distance = null, ww = 0, stride = 1;
  const queue = scratch.queue;

  if (compact) {
    nx0 = Math.max(x0, minX - RING_NEAR); nx1 = Math.min(x1 - 1, maxX + RING_NEAR);
    ny0 = Math.max(y0, minY - RING_NEAR); ny1 = Math.min(y1 - 1, maxY + RING_NEAR);
    // A few hundred samples tell a ring's median and spread: a larger window
    // is read on a coarser grid.
    step = Math.max(1, Math.round(Math.sqrt((x1 - x0) * (y1 - y0) / RING_SAMPLES)));
    if (step > 1) {
      for (let y = y0; y < y1; y += step) {
        const row = y * w, inside = y >= ny0 && y <= ny1;
        for (let x = x0; x < x1; x += step) {
          if (inside && x >= nx0 && x <= nx1) continue;
          const bin = resp[row + x] >> shift;
          hist[bin]++;
          if (bin > top) top = bin;
          samples++;
        }
      }
    } else {
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        if (y < ny0 || y > ny1) {
          for (let i = row + x0, end = row + x1; i < end; i++) {
            const bin = resp[i] >> shift;
            hist[bin]++;
            if (bin > top) top = bin;
          }
          continue;
        }
        for (let i = row + x0, end = row + nx0; i < end; i++) {
          const bin = resp[i] >> shift;
          hist[bin]++;
          if (bin > top) top = bin;
        }
        for (let i = row + nx1 + 1, end = row + x1; i < end; i++) {
          const bin = resp[i] >> shift;
          hist[bin]++;
          if (bin > top) top = bin;
        }
      }
      samples = (x1 - x0) * (y1 - y0) - (nx1 - nx0 + 1) * (ny1 - ny0 + 1);
    }
  } else {
    // A hair's own box is mostly somewhere else: read the band along it.
    ww = x1 - x0;
    const wh = y1 - y0;
    distance = scratch.local(ww * wh);
    distance.fill(255, 0, ww * wh);
    queue.length = 0;
    for (let k = 0; k < count; k++) {
      const p = pixels[k];
      const px = p % w, py = (p - px) / w;
      const local = (py - y0) * ww + (px - x0);
      distance[local] = 0;
      queue.push(local);
    }
    // Breadth first over the 8-neighbourhood: Chebyshev distance to the blob.
    let ringPixels = 0;
    for (let head = 0; head < queue.length; head++) {
      const local = queue.data[head];
      const d = distance[local];
      if (d > RING_NEAR) ringPixels++;
      if (d >= pad) continue;
      const lx = local % ww, ly = (local - lx) / ww;
      for (let ny = ly > 0 ? ly - 1 : 0, nyEnd = ly < wh - 1 ? ly + 1 : wh - 1; ny <= nyEnd; ny++) {
        for (let nx = lx > 0 ? lx - 1 : 0, nxEnd = lx < ww - 1 ? lx + 1 : ww - 1; nx <= nxEnd; nx++) {
          const q = ny * ww + nx;
          if (distance[q] !== 255) continue;
          distance[q] = d + 1;
          queue.push(q);
        }
      }
    }
    // An even subsample when the band holds more than the buffers take.
    stride = Math.max(1, Math.ceil(ringPixels / RING_MAX_SAMPLES));
    let seen = 0;
    for (let head = count; head < queue.length; head++) {
      const local = queue.data[head];
      if (distance[local] <= RING_NEAR || seen++ % stride) continue;
      const lx = local % ww;
      const bin = resp[(y0 + (local - lx) / ww) * w + x0 + lx] >> shift;
      hist[bin]++;
      if (bin > top) top = bin;
      samples++;
    }
  }

  // Significance, read in the response: shading does not respond, texture
  // does. The spread is taken at the ring's 90th percentile, so texture that
  // fills a tenth of the ring counts and a few other specks do not.
  const k50 = (samples - 1) >> 1, k90 = Math.floor((samples - 1) * 0.9);
  let cumulative = 0, medianBin = -1, p90Bin = top;
  for (let bin = 0; bin <= top; bin++) {
    cumulative += hist[bin];
    if (medianBin < 0 && cumulative > k50) medianBin = bin;
    if (cumulative > k90) { p90Bin = bin; break; }
  }
  hist.fill(0, 0, top + 1);
  if (samples < RING_MIN_SAMPLES) return null;
  const responseMedian = medianBin << shift;
  const spread = Math.max(((p90Bin << shift) - responseMedian) / SPREAD_FROM_P90, GRAIN_FLOOR * unit);
  const z = (peak - responseMedian) / spread;
  if (z < ringZ) return null;

  // The same ring, now for its grey values.
  const ringLum = scratch.ringLum;
  let m = 0;
  if (compact) {
    for (let y = y0; y < y1; y += step) {
      const row = y * w, inside = y >= ny0 && y <= ny1;
      for (let x = x0; x < x1; x += step) {
        if (inside && x >= nx0 && x <= nx1) continue;
        ringLum[m++] = lum[row + x];
      }
    }
  } else {
    let seen = 0;
    for (let head = count; head < queue.length; head++) {
      const local = queue.data[head];
      if (distance[local] <= RING_NEAR || seen++ % stride) continue;
      const lx = local % ww;
      ringLum[m++] = lum[(y0 + (local - lx) / ww) * w + x0 + lx];
    }
  }
  // The flatness pass below reads ringLum in any order, so selecting in place is fine.
  const median = selectKth(ringLum, m, (m - 1) >> 1);
  // The blob's contrast: the mean of its upper half above the ring's median.
  const values = scratch.values(count);
  for (let k = 0; k < count; k++) values[k] = (lum[pixels[k]] - median) * sign;
  const half = count >> 1;
  if (half > 0) selectKth(values, count, half);
  let sum = 0;
  for (let k = half; k < count; k++) sum += values[k];
  const contrast = sum / (count - half);
  if (contrast < MIN_CONTRAST * unit) return null;

  const limit = RING_DEVIATION * contrast;
  let deviating = 0;
  for (let k = 0; k < m; k++) {
    const d = ringLum[k] - median;
    if (d > limit || -d > limit) deviating++;
  }
  if (deviating > RING_MAX_SHARE * m) return null;
  return { median, contrast, z };
}

// ─── Detection ───────────────────────────────────────────────────────────────

function createScratch() {
  let local = new Uint8Array(4096);
  let values = new Float64Array(1024);
  return {
    seeds: new GrowableInt32(4096),
    component: new GrowableInt32(1024),
    stack: new GrowableInt32(1024),
    queue: new GrowableInt32(4096),
    hist: new Uint32Array(HISTOGRAM_BINS),
    ringLum: new Uint16Array(RING_MAX_SAMPLES + 1),
    local(size) { if (local.length < size) local = new Uint8Array(size * 2); return local; },
    values(size) { if (values.length < size) values = new Float64Array(size * 2); return values; },
    deviation: new Float32Array(4096),
    label: new Uint8Array(4096),
  };
}

// Binomial 5 x 5 blur of the grey frame at one pixel, times 256 (edges replicate).
function blurAt(grey, w, h, x, y) {
  const xa = x > 1 ? x - 2 : 0, xb = x > 0 ? x - 1 : 0, xd = x < w - 1 ? x + 1 : w - 1, xe = x < w - 2 ? x + 2 : w - 1;
  let sum = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy;
    const row = (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w;
    const weight = dy === 0 ? 6 : (dy === 1 || dy === -1) ? 4 : 1;
    sum += weight * (grey[row + xa] + 4 * grey[row + xb] + 6 * grey[row + x] + 4 * grey[row + xd] + grey[row + xe]);
  }
  return sum;
}

/**
 * Detect dust and scratches.
 *
 * @param {ImageData} imageData - The converted RGBA frame
 * @param {{ strength?: number, maxParticleSize?: number, polarity?: 'bright'|'dark'|'both' }} [options] -
 *   strength 1-10 (higher finds more); maxParticleSize caps a blob's long
 *   side in px (defaults to defaultMaxParticleSize of the frame); polarity is
 *   'bright' for a negative's frame, 'dark' for a positive's
 * @returns {{ mask: Uint8Array, particleCount: number, _state: Object|null }}
 */
export function detectDust(imageData, { strength = 3, maxParticleSize, polarity = 'bright' } = {}) {
  const { width: w, height: h } = imageData;
  const c = cv();
  if (!c || !c.Mat) {
    console.warn('DustRemoval: OpenCV.js not available');
    return { mask: new Uint8Array(w * h), particleCount: 0, _state: null };
  }
  const maxSize = Number.isFinite(maxParticleSize) && maxParticleSize > 0 ? maxParticleSize : defaultMaxParticleSize(w, h);
  const state = analyseDust(imageData, strength, maxSize, polarity === 'dark' || polarity === 'both' ? polarity : 'bright');
  const { mask, particleCount } = selectDust(state, strength, maxSize);
  return { mask, particleCount, _state: state };
}

/**
 * Another sensitivity or size cap from a detection's state: the candidates a
 * detection keeps answer every sensitivity up to its own, so a lower one only
 * selects among them. A higher one, more levels or another polarity detect
 * again.
 */
export function updateDustStrength(imageData, existingState, newStrength, maxParticleSize, polarity) {
  const { width: w, height: h } = imageData;
  const maxSize = Number.isFinite(maxParticleSize) && maxParticleSize > 0 ? maxParticleSize : defaultMaxParticleSize(w, h);
  const wanted = polarity === 'dark' || polarity === 'both' || polarity === 'bright' ? polarity : existingState?.polarity || 'bright';
  const c = cv();
  if (!c || !c.Mat || !existingState?.records
    || existingState.width !== w || existingState.height !== h
    || existingState.polarity !== wanted
    || !(newStrength <= existingState.strength)
    || dustPyramidLevels(maxSize, w, h) > existingState.levels) {
    return detectDust(imageData, { strength: newStrength, maxParticleSize, polarity: wanted });
  }
  const { mask, particleCount } = selectDust(existingState, newStrength, maxSize);
  return { mask, particleCount, _state: existingState };
}

// Fields of a candidate record (a row of Float64 values).
const R_LEVEL = 0, R_RATIO = 1, R_Z = 2, R_CORE_LONG = 3, R_LENGTH = 4, R_THICKNESS = 5, R_BOW = 6;
const R_SKIRT = 7, R_CONTINUES = 8;
const R_CORE_X0 = 9, R_CORE_Y0 = 10, R_CORE_X1 = 11, R_CORE_Y1 = 12, R_RUN_START = 13, R_RUN_END = 14;
const RECORD = 15;

/** Stages 1-4 at `strength`: every candidate that stands on a flat background, with its footprint. */
function analyseDust(imageData, strength, maxSize, polarity) {
  const { width: w, height: h, data } = imageData;
  const levels = dustPyramidLevels(maxSize, w, h);
  const thresholds = dustThresholds(strength);
  const grey = new Uint8Array(w * h);
  rgbaToGrayInto(data, grey, w * h);
  const scratch = createScratch();
  const records = [];
  const runs = new GrowableInt32(4096); // y, x0, x1 (inclusive) triples
  const footprintMoments = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
  const signs = polarity === 'both' ? [1, -1] : [polarity === 'dark' ? -1 : 1];

  // Stage 4: the footprint at full size, down to a share of the blob's
  // contrast, within reach of the component its level found: a faint blob's
  // threshold lies inside the background's own variation, and without the
  // bound its footprint runs off into the background it sits on.
  const accept = (level, comp, minX, minY, maxX, maxY, median, contrast, z, ratio, sign) => {
    const scale = 1 << level, unit = 4 ** level;
    const reach = scale + FOOTPRINT_REACH;
    const x0 = Math.max(0, minX * scale - reach), y0 = Math.max(0, minY * scale - reach);
    const x1 = Math.min(w, (maxX + 1) * scale + reach), y1 = Math.min(h, (maxY + 1) * scale + reach);
    const ww = x1 - x0, wh = y1 - y0, area = ww * wh;
    if (scratch.deviation.length < area) { scratch.deviation = new Float32Array(area * 2); scratch.label = new Uint8Array(area * 2); }
    const deviation = scratch.deviation, label = scratch.label;
    deviation.fill(NaN, 0, area);
    // 0: out of reach; 2: within reach of the component; 1: in the footprint.
    label.fill(0, 0, area);
    const pixels = comp.data, lw = w >> level;
    for (let k = 0; k < comp.length; k++) {
      const p = pixels[k];
      const px = p % lw, py = (p - px) / lw;
      const rx0 = Math.max(x0, px * scale - reach) - x0, rx1 = Math.min(x1, (px + 1) * scale + reach) - x0;
      for (let fy = Math.max(y0, py * scale - reach), fyEnd = Math.min(y1, (py + 1) * scale + reach); fy < fyEnd; fy++) {
        const row = (fy - y0) * ww;
        label.fill(2, row + rx0, row + rx1);
      }
    }
    // Grey levels x 256, as blurAt returns them.
    const base = median / unit * 256, threshold = FOOTPRINT * contrast / unit * 256;
    const deviationAt = (local) => {
      let d = deviation[local];
      if (d !== d) {
        const lx = local % ww;
        d = (blurAt(grey, w, h, x0 + lx, y0 + (local - lx) / ww) - base) * sign;
        deviation[local] = d;
      }
      return d;
    };
    const stack = scratch.stack;
    stack.length = 0;
    for (let k = 0; k < comp.length; k++) {
      const p = pixels[k];
      const px = p % lw, py = (p - px) / lw;
      const fx1 = Math.min(x1, (px + 1) * scale), fy1 = Math.min(y1, (py + 1) * scale);
      for (let fy = Math.max(y0, py * scale); fy < fy1; fy++) {
        for (let fx = Math.max(x0, px * scale); fx < fx1; fx++) {
          const local = (fy - y0) * ww + (fx - x0);
          if (label[local] === 2 && deviationAt(local) > threshold) { label[local] = 1; stack.push(local); }
        }
      }
    }
    if (!stack.length) return;
    const members = scratch.queue;
    members.length = 0;
    let top = 0;
    while (stack.length) {
      const local = stack.data[--stack.length];
      members.push(local);
      const d = deviation[local];
      if (d > top) top = d;
      const lx = local % ww, ly = (local - lx) / ww;
      for (let ny = ly > 0 ? ly - 1 : 0, nyEnd = ly < wh - 1 ? ly + 1 : wh - 1; ny <= nyEnd; ny++) {
        for (let nx = lx > 0 ? lx - 1 : 0, nxEnd = lx < ww - 1 ? lx + 1 : ww - 1; nx <= nxEnd; nx++) {
          const q = ny * ww + nx;
          if (label[q] !== 2 || !(deviationAt(q) > threshold)) continue;
          label[q] = 1;
          stack.push(q);
        }
      }
    }
    // The half-maximum core is what the size rule reads: its box, its area,
    // and, from its second moments, its length along its main axis and its
    // spread across it.
    const coreLevel = 0.5 * top;
    let coreArea = 0, coreSum = 0, cx0 = ww, cy0 = wh, cx1 = -1, cy1 = -1, fx0 = ww, fy0 = wh, fx1 = -1, fy1 = -1;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const footprint = footprintMoments;
    footprint.n = members.length;
    footprint.sx = footprint.sy = footprint.sxx = footprint.syy = footprint.sxy = 0;
    for (let k = 0; k < members.length; k++) {
      const local = members.data[k];
      const lx = local % ww, ly = (local - lx) / ww;
      if (lx < fx0) fx0 = lx; if (lx > fx1) fx1 = lx; if (ly < fy0) fy0 = ly; if (ly > fy1) fy1 = ly;
      footprint.sx += lx; footprint.sy += ly; footprint.sxx += lx * lx; footprint.syy += ly * ly; footprint.sxy += lx * ly;
      const d = deviation[local];
      if (d > coreLevel) {
        coreArea++;
        coreSum += d;
        if (lx < cx0) cx0 = lx; if (lx > cx1) cx1 = lx; if (ly < cy0) cy0 = ly; if (ly > cy1) cy1 = ly;
        sx += lx; sy += ly; sxx += lx * lx; syy += ly * ly; sxy += lx * ly;
      }
    }
    if (coreArea === 0) return;
    const { length, thickness, bow } = lineShape(coreArea, sx, sy, sxx, syy, sxy);
    // How sharp its edges are: how much thicker its footprint is than its
    // core (each its own area over its own length, so a line whose contrast
    // varies along it is read fairly). A line of the picture with soft
    // shoulders spreads most where it was found at a coarse level, against
    // that level's own, lower contrast. And whether it goes on past its ends.
    // Together they tell a hair on the film from a line of the picture.
    const spread = lineShape(footprint.n, footprint.sx, footprint.sy, footprint.sxx, footprint.syy, footprint.sxy).thickness;
    const skirt = spread - thickness;
    const continues = continuation(grey, w, h, members, ww, wh, x0, y0, label, footprint, spread, length,
      coreSum / coreArea / 256, sign);
    const runStart = runs.length;
    for (let ly = fy0; ly <= fy1; ly++) {
      const row = ly * ww;
      for (let lx = fx0; lx <= fx1; lx++) {
        if (label[row + lx] !== 1) continue;
        let end = lx;
        while (end < fx1 && label[row + end + 1] === 1) end++;
        runs.reserve(3);
        runs.data[runs.length++] = y0 + ly;
        runs.data[runs.length++] = x0 + lx;
        runs.data[runs.length++] = x0 + end;
        lx = end;
      }
    }
    records.push(level, ratio, z, Math.max(cx1 - cx0, cy1 - cy0) + 1, length, thickness, bow,
      skirt, continues, x0 + cx0, y0 + cy0, x0 + cx1, y0 + cy1, runStart, runs.length);
  };

  for (const sign of signs) {
    let lum = grey, lw = w, lh = h;
    for (let level = 0; level < levels; level++) {
      if (level) { lum = halvePlane(lum, lw, lh); lw >>= 1; lh >>= 1; }
      const hat = hatMat(lum, lw, lh, sign);
      try {
        // No OpenCV call runs while this view of the heap is read.
        const resp = level ? hat.data16U : hat.data;
        scanLevel(level, lum, resp, lw, lh, sign, thresholds, scratch,
          (lvl, comp, minX, minY, maxX, maxY, median, contrast, z, ratio) =>
            accept(lvl, comp, minX, minY, maxX, maxY, median, contrast, z, ratio, sign));
      } finally {
        hat.delete();
      }
    }
  }
  return {
    width: w, height: h, polarity, strength, levels,
    records: Float64Array.from(records), runs: runs.trimmed(),
  };
}

/** Row half-widths of OpenCV's elliptical structuring element of diameter `size`. */
function ellipseRows(size) {
  const r = size >> 1;
  const rows = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    const dy = i - r;
    rows[i] = r === 0 ? 0 : Math.round(r * Math.sqrt(Math.max(0, 1 - (dy * dy) / (r * r))));
  }
  return rows;
}

// A straight line t wide and L long has the variances (L^2 - 1) / 12 along
// itself and (t^2 - 1) / 12 across. From a shape's second moments: its length
// along its main axis, its area over that length (its thickness), and its
// bow: how far it spreads across the axis beyond its own thickness, over its
// length. For a bent line that is about its sagitta over its chord; a
// straight one, a speck or a bar has none.
function lineShape(count, sx, sy, sxx, syy, sxy) {
  const mx = sx / count, my = sy / count;
  const vxx = sxx / count - mx * mx, vyy = syy / count - my * my, vxy = sxy / count - mx * my;
  const mean = (vxx + vyy) / 2, swing = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy * vxy);
  const length = Math.sqrt(12 * (mean + swing) + 1);
  const thickness = count / length;
  const across = Math.sqrt(12 * Math.max(0, mean - swing) + 1);
  return { length, thickness, bow: Math.sqrt(Math.max(0, across * across - thickness * thickness)) / length };
}

// How far a line goes on past its ends: from each end, along that end's own
// direction, a strip as wide as the line against the flanks beside it, a few
// px past the footprint. A hair ends where it ends; a seam, a wire or the edge
// of a roof goes on, and the detector found only the piece of it that stood
// on a calm background. Returns the larger of the two ends' ridges in the
// line's own contrast (grey levels), or -Infinity where no end can be read.
function continuation(grey, w, h, members, ww, wh, x0, y0, label, moments, spread, length, contrast, sign) {
  const n = moments.n, data = members.data;
  if (n < 3 || !(contrast > 0)) return -Infinity;
  const mx = moments.sx / n, my = moments.sy / n;
  const vxx = moments.sxx / n - mx * mx, vyy = moments.syy / n - my * my, vxy = moments.sxy / n - mx * my;
  const axis = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  const ux = Math.cos(axis), uy = Math.sin(axis);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const local = data[k], lx = local % ww, ly = (local - lx) / ww;
    const t = (lx - mx) * ux + (ly - my) * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const tail = Math.max(3, CONTINUE_TAIL * (hi - lo));
  const half = Math.max(1, spread / 2);
  const near = half + 2, far = Math.floor(near + Math.max(2, 2 * half));
  const start = CONTINUE_GAP + half;
  const reach = Math.min(CONTINUE_MAX, Math.max(CONTINUE_MIN, CONTINUE_SHARE * length));
  let result = -Infinity;
  for (let end = -1; end <= 1; end += 2) {
    const edge = end > 0 ? hi : lo;
    // The end: its centre and its own direction (a bent hair's end points
    // away from the main axis).
    let tn = 0, tsx = 0, tsy = 0, tsxx = 0, tsyy = 0, tsxy = 0;
    for (let k = 0; k < n; k++) {
      const local = data[k], lx = local % ww, ly = (local - lx) / ww;
      if ((edge - ((lx - mx) * ux + (ly - my) * uy)) * end > tail) continue;
      tn++; tsx += lx; tsy += ly; tsxx += lx * lx; tsyy += ly * ly; tsxy += lx * ly;
    }
    const tmx = tsx / tn, tmy = tsy / tn;
    let dx = ux * end, dy = uy * end;
    if (tn >= 3) {
      const a = tsxx / tn - tmx * tmx, b = tsyy / tn - tmy * tmy, c = tsxy / tn - tmx * tmy;
      const direction = 0.5 * Math.atan2(2 * c, a - b);
      let ex = Math.cos(direction), ey = Math.sin(direction);
      if (ex * dx + ey * dy < 0) { ex = -ex; ey = -ey; }
      dx = ex; dy = ey;
    }
    // Its tip: the pixel of the end furthest along that direction.
    let tipX = tmx, tipY = tmy, furthest = -Infinity;
    for (let k = 0; k < n; k++) {
      const local = data[k], lx = local % ww, ly = (local - lx) / ww;
      if ((edge - ((lx - mx) * ux + (ly - my) * uy)) * end > tail) continue;
      const along = (lx - tmx) * dx + (ly - tmy) * dy;
      if (along > furthest) { furthest = along; tipX = lx; tipY = ly; }
    }
    const nx = -dy, ny = dx;
    let ridge = 0, ridgeCount = 0, flank = 0, flankCount = 0;
    for (let s = start; s < start + reach; s++) {
      for (let o = -far; o <= far; o++) {
        const across = o < 0 ? -o : o;
        if (across > half && across < near) continue;
        const lx = Math.round(tipX + dx * s + nx * o), ly = Math.round(tipY + dy * s + ny * o);
        const gx = x0 + lx, gy = y0 + ly;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        if (lx >= 0 && ly >= 0 && lx < ww && ly < wh && label[ly * ww + lx] === 1) continue;
        if (across <= half) { ridge += grey[gy * w + gx]; ridgeCount++; } else { flank += grey[gy * w + gx]; flankCount++; }
      }
    }
    if (ridgeCount < CONTINUE_SAMPLES || flankCount < CONTINUE_SAMPLES) continue;
    const share = (ridge / ridgeCount - flank / flankCount) * sign / contrast;
    if (share > result) result = share;
  }
  return result;
}

// What lies on the film is in focus as the film is, and a hair or a fibre
// ends where it ends. A line with soft shoulders, or one that goes on past
// what was found of it, is a line of the picture: a seam, a crease, a wire.
function inFocusAndEnds(skirt, continues, shortSide) {
  return skirt <= Math.max(HAIR_SKIRT, shortSide * HAIR_SKIRT_SHARE) && continues < HAIR_CONTINUES;
}

// Past the size cap a shape is taken only when it looks like a hair or a
// fibre on the film: thin and long, in focus and ending, and, past twice the
// cap, bent. A thick shape or a long straight one is image content: a lamp,
// a stripe, a seam, a wire, an edge.
function looksLikeHair(length, thickness, bow, skirt, continues, maxSize, shortSide) {
  if (thickness > Math.max(3, shortSide * HAIR_THICKNESS_SHARE) || length < HAIR_ASPECT * thickness) return false;
  if (!inFocusAndEnds(skirt, continues, shortSide)) return false;
  return length <= maxSize * HAIR_STRAIGHT_LENGTHS || (bow >= HAIR_BOW && length <= shortSide * HAIR_MAX_SHARE);
}

/** Stage 5 and the mask: the records a sensitivity keeps, without the crowds, dilated. */
function selectDust(state, strength, maxSize) {
  const { width: w, height: h, records, runs } = state;
  const mask = new Uint8Array(w * h);
  const { seed, ringZ, crowd } = dustThresholds(strength);
  const levels = dustPyramidLevels(maxSize, w, h);
  const shortSide = Math.min(w, h);
  const band = Math.max(8, Math.round(shortSide * EDGE_BAND));
  // A straight line hugging the frame edge is the frame's own border (a hair
  // that runs off the frame is bent).
  const atEdge = (bx0, by0, bx1, by1) => by1 < band || by0 >= h - band || bx1 < band || bx0 >= w - band;

  // Paint the kept footprints: 1 (and 3, below) mark pixels no blob has claimed yet, 2 claimed ones.
  // Each level's record of an object is read on its own, and one that passes
  // is enough: a coarse level reads even a sharp fibre a little soft.
  const kept = [];
  for (let r = 0; r < records.length; r += RECORD) {
    if (records[r + R_LEVEL] >= levels || records[r + R_RATIO] <= seed || records[r + R_Z] < ringZ) continue;
    if (records[r + R_CORE_LONG] > maxSize) {
      if (!looksLikeHair(records[r + R_LENGTH], records[r + R_THICKNESS], records[r + R_BOW], records[r + R_SKIRT],
        records[r + R_CONTINUES], maxSize, shortSide)
        || (records[r + R_BOW] < HAIR_BOW
          && atEdge(records[r + R_CORE_X0], records[r + R_CORE_Y0], records[r + R_CORE_X1], records[r + R_CORE_Y1]))) continue;
    } else if (records[r + R_LENGTH] >= SPECK_LINE_ASPECT * records[r + R_THICKNESS]
      && records[r + R_THICKNESS] <= Math.max(3, shortSide * SPECK_LINE_THICKNESS_SHARE)
      && !inFocusAndEnds(records[r + R_SKIRT], records[r + R_CONTINUES], shortSide)) {
      // A thin elongated speck is a short line: it passes a line's own tests.
      // A thick one is a clump, perhaps out of focus, and stays a speck.
      continue;
    }
    kept.push(r);
    for (let k = records[r + R_RUN_START], end = records[r + R_RUN_END]; k < end; k += 3) {
      mask.fill(1, runs[k] * w + runs[k + 1], runs[k] * w + runs[k + 2] + 1);
    }
  }
  if (!kept.length) return { mask, particleCount: 0 };
  // The first pixel of every kept footprint (3), with the longest core that
  // starts there: a blob learns from them how long its longest piece is.
  const longestAt = new Map();
  for (const r of kept) {
    const k = records[r + R_RUN_START];
    const first = runs[k] * w + runs[k + 1];
    mask[first] = 3;
    longestAt.set(first, Math.max(longestAt.get(first) || 0, records[r + R_CORE_LONG]));
  }

  // Footprints of one speck found at several levels overlap, and the pieces
  // a long line was found in join up: blobs are the connected pieces of the
  // union. A blob much longer than its longest piece is read by the size rule
  // again, as one shape.
  const blobPixels = new GrowableInt32(4096);
  const blobStart = [0];
  const blobX = [], blobY = [], structure = [];
  const stack = new GrowableInt32(1024);
  for (const r of kept) {
    const k = records[r + R_RUN_START];
    const first = runs[k] * w + runs[k + 1];
    if (mask[first] === 2) continue;
    mask[first] = 2;
    stack.length = 0;
    stack.push(first);
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    let longestPiece = longestAt.get(first);
    const begin = blobPixels.length;
    while (stack.length) {
      const p = stack.data[--stack.length];
      blobPixels.push(p);
      const px = p % w, py = (p - px) / w;
      sx += px; sy += py; sxx += px * px; syy += py * py; sxy += px * py;
      if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py;
      for (let ny = py > 0 ? py - 1 : 0, nyEnd = py < h - 1 ? py + 1 : h - 1; ny <= nyEnd; ny++) {
        for (let nx = px > 0 ? px - 1 : 0, nxEnd = px < w - 1 ? px + 1 : w - 1; nx <= nxEnd; nx++) {
          const q = ny * w + nx, state = mask[q];
          if (state !== 1 && state !== 3) continue;
          if (state === 3) { const piece = longestAt.get(q); if (piece > longestPiece) longestPiece = piece; }
          mask[q] = 2;
          stack.push(q);
        }
      }
    }
    const size = blobPixels.length - begin;
    blobStart.push(blobPixels.length);
    blobX.push(sx / size);
    blobY.push(sy / size);
    let isStructure = false;
    const longSide = Math.max(bx1 - bx0, by1 - by0) + 1;
    if (longSide > maxSize && longSide > JOINED_LENGTHS * longestPiece + 2 * FOOTPRINT_SKIRT) {
      // A footprint is wider than its half-maximum core by its skirt; each
      // piece was read for its sharpness and for going on.
      const shape = lineShape(size, sx, sy, sxx, syy, sxy);
      isStructure = !looksLikeHair(shape.length, shape.thickness - FOOTPRINT_SKIRT, shape.bow, 0, -Infinity, maxSize, shortSide)
        || (shape.bow < HAIR_BOW && atEdge(bx0, by0, bx1, by1));
    }
    structure.push(isStructure);
  }
  const blobCount = blobX.length;

  // Crowds: a cap on the blobs a neighbourhood (3 x 3 cells) may hold, as a
  // density per share of the frame, so it means the same film area at any size.
  const cell = Math.max(16, Math.floor(shortSide / CROWD_CELLS));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Uint32Array(gw * gh);
  const cellOf = new Int32Array(blobCount);
  for (let b = 0; b < blobCount; b++) {
    cellOf[b] = Math.min(gh - 1, Math.floor(blobY[b] / cell)) * gw + Math.min(gw - 1, Math.floor(blobX[b] / cell));
    if (!structure[b]) grid[cellOf[b]]++;
  }
  const limit = crowd * (9 * cell * cell) / (w * h) * 100;
  const pixels = blobPixels.data;
  const dilate = Math.max(3, Math.round(h * DILATE_SHARE)) | 1;
  const rows = ellipseRows(dilate), reach = dilate >> 1;
  let particleCount = 0;
  const crowded = new Uint8Array(blobCount);
  for (let b = 0; b < blobCount; b++) {
    const gx = cellOf[b] % gw, gy = (cellOf[b] - gx) / gw;
    let around = 0;
    for (let ny = Math.max(0, gy - 1); ny <= Math.min(gh - 1, gy + 1); ny++) {
      for (let nx = Math.max(0, gx - 1); nx <= Math.min(gw - 1, gx + 1); nx++) around += grid[ny * gw + nx];
    }
    crowded[b] = structure[b] || around >= limit ? 1 : 0;
    if (!crowded[b]) particleCount++;
  }
  // Crowds and structures go first, so a kept blob's dilation is never erased with them.
  for (let b = 0; b < blobCount; b++) {
    if (!crowded[b]) continue;
    for (let k = blobStart[b]; k < blobStart[b + 1]; k++) mask[pixels[k]] = 0;
  }
  for (let b = 0; b < blobCount; b++) {
    if (crowded[b]) continue;
    for (let k = blobStart[b]; k < blobStart[b + 1]; k++) {
      const p = pixels[k];
      const px = p % w, py = (p - px) / w;
      for (let i = 0; i < dilate; i++) {
        const y = py + i - reach;
        if (y < 0 || y >= h) continue;
        const x0 = Math.max(0, px - rows[i]), x1 = Math.min(w - 1, px + rows[i]);
        mask.fill(255, y * w + x0, y * w + x1 + 1);
      }
    }
  }
  return { mask, particleCount };
}
