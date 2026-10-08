import { selectKth } from './orderStatistics.js';

// One set of sampled pixels as struct-of-arrays. On an 8/16-bit plane the
// channels are kept as the raw integer samples: dividing by the (positive)
// maximum is monotone, so the k-th smallest raw value divided by the maximum
// is exactly the k-th smallest of the old per-pixel `data[i] / maximum`. A
// channel column is sorted at most once, lazily; a luma quantile is read by
// selection. Either way each quantile is the same order statistic the
// comparator sort over per-pixel objects produced.
class PixelSet {
  constructor(capacity, integer, maximum) {
    this.length = 0;
    this.integer = integer;
    this.maximum = maximum;
    const Channel = integer ? Uint16Array : Float64Array;
    this.r = new Channel(capacity);
    this.g = new Channel(capacity);
    this.b = new Channel(capacity);
    this.luma = new Float64Array(capacity);
    this.gray = 0;
    this.maskRed = 0;
    this.orange = 0;
    this.sorted = {};
  }

  grow() {
    for (const key of ['r', 'g', 'b', 'luma']) {
      const next = new this[key].constructor(this[key].length * 2);
      next.set(this[key]);
      this[key] = next;
    }
  }

  // r, g, b: raw samples on an integer plane, else already divided.
  add(r, g, b, luma, gray, maskRed, orange) {
    if (this.length === this.r.length) this.grow();
    const n = this.length++;
    this.r[n] = r; this.g[n] = g; this.b[n] = b; this.luma[n] = luma;
    if (gray) this.gray++;
    if (maskRed) this.maskRed++;
    if (orange) this.orange++;
  }

  // Channel value of sample n on the 0..1 scale, as the old code computed it.
  channel(key, n) {
    return this.integer ? this[key][n] / this.maximum : this[key][n];
  }

  fraction(key) {
    return this[key] / Math.max(1, this.length);
  }

  quantile(key, q) {
    const n = this.length;
    if (n === 0) return 0;
    const k = Math.floor((n - 1) * q);
    // Selection reorders the luma column; nothing reads it by index.
    if (key === 'luma' && this.integer) return selectKth(this.luma, k, n);
    let values = this.sorted[key];
    if (!values) values = this.sorted[key] = this[key].slice(0, n).sort();
    const value = values[k] ?? 0;
    return this.integer && key !== 'luma' ? value / this.maximum : value;
  }
}

// Pixel evidence is advisory: without a rebate/DX code, polarity is not
// uniquely recoverable (a grayscale positive and negative are both gray).
// Keep this bounded and independent of file names, camera metadata and format.
// A 60 MP camera scan resolves film grain, which demosaicing turns into a few
// percent of per-pixel false colour. Each sample is therefore the mean of the
// opaque pixels in a small box, about one box side per 800 px of the short
// side: 1 px on previews and small scans up to about 1200 px, 5 px at 24 MP,
// 8 px at 6336 px (4 px left L1000619 of the 60 MP B&W roll a positive), never
// more than 8 px unless a caller forces `blockSize`.
export function detectionBlockSize(width, height, blockSize = null) {
  const forced = Number(blockSize);
  if (blockSize != null && Number.isFinite(forced)) return Math.max(1, Math.min(16, Math.round(forced)));
  return Math.max(1, Math.min(8, Math.round(Math.min(width, height) / 800)));
}

export function detectFilmType(image, { fallback = 'positive', filmEdge = null, blockSize = null } = {}) {
  if (filmEdge?.found && ['color', 'bw', 'positive'].includes(filmEdge.filmKind)
      && !(filmEdge.polarity === 'light' && filmEdge.filmKind !== 'positive')) {
    return { filmType: filmEdge.filmKind, confidence: 'high', reason: 'dx' };
  }
  const source = image?.__image16 || image;
  if (!source?.data || !source.width || !source.height) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const { width, height, data } = source;
  const maximum = data instanceof Uint16Array ? 65535 : 255;
  const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 24000)));
  const block = detectionBlockSize(width, height, blockSize), before = (block - 1) >> 1;
  // Integer planes (the only ones the app produces) hold no NaN, so their
  // luma can be read by selection; anything else keeps plain sorts. A 1 px
  // box is the sampled pixel itself, so its raw samples stay integers; a
  // block mean is fractional and is kept divided.
  const integer = block === 1
    && (data instanceof Uint16Array || data instanceof Uint8ClampedArray || data instanceof Uint8Array);
  const samples = Math.ceil(width / stride) * Math.ceil(height / stride);
  const makeSet = (capacity) => new PixelSet(capacity, integer, maximum);
  const all = makeSet(samples), inner = makeSet(samples), edge = makeSet(256);
  const sides = [makeSet(64), makeSet(64), makeSet(64), makeSet(64)];
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    // Box clamped to the image; a 1 px box is exactly the sampled pixel.
    const x0 = Math.max(0, x - before), x1 = Math.min(width, x - before + block);
    const y0 = Math.max(0, y - before), y1 = Math.min(height, y - before + block);
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let yy = y0; yy < y1; yy++) {
      for (let j = (yy * width + x0) * 4, end = (yy * width + x1) * 4; j < end; j += 4) {
        if (!data[j + 3]) continue;
        sumR += data[j]; sumG += data[j + 1]; sumB += data[j + 2]; count++;
      }
    }
    if (!count) continue;
    const scale = count * maximum;
    const r = sumR / scale, g = sumG / scale, b = sumB / scale;
    const peak = Math.max(r, g, b), low = Math.min(r, g, b);
    if (peak < .02) continue;
    const luma = .2126 * r + .7152 * g + .0722 * b;
    const gray = peak - low < .035;
    const maskRed = r > g * 1.15 && r > b * 1.15;
    const orange = r > g * 1.18 && g > b * 1.18 && r - b > .16;
    // With a 1 px box the sums are the raw samples.
    const cr = integer ? sumR : r, cg = integer ? sumG : g, cb = integer ? sumB : b;
    if (x < width * .015) sides[0].add(cr, cg, cb, luma, gray, maskRed, orange);
    if (x >= width * .985) sides[1].add(cr, cg, cb, luma, gray, maskRed, orange);
    if (y < height * .015) sides[2].add(cr, cg, cb, luma, gray, maskRed, orange);
    if (y >= height * .985) sides[3].add(cr, cg, cb, luma, gray, maskRed, orange);
    // Clipped clear film helps polarity, but must not dilute orange-mask
    // statistics used by the existing colour-negative classifier.
    if (low > .98) continue;
    all.add(cr, cg, cb, luma, gray, maskRed, orange);
    if (x < width * .05 || x >= width * .95 || y < height * .05 || y >= height * .95) edge.add(cr, cg, cb, luma, gray, maskRed, orange);
    else inner.add(cr, cg, cb, luma, gray, maskRed, orange);
  }
  if (all.length < 64) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const edgeRange = edge.quantile('luma', .9) - edge.quantile('luma', .1);
  const edgeLuma = edge.quantile('luma', .5), innerLuma = inner.quantile('luma', .5);
  const orangeFraction = all.fraction('orange');
  // A uniform orange rebate substantially brighter than the image is stronger
  // evidence than a warm scene. Cropped scans still use whole-image mask evidence.
  if (edge.length >= 32 && edge.fraction('orange') > .85 && edgeRange < .14
      && edgeLuma > innerLuma + .07 && orangeFraction > .35) {
    return { filmType: 'color', confidence: 'high', reason: 'orangeRebate' };
  }
  // Subject colours can make a masked negative magenta instead of orange
  // (B >= G), even though the red mask remains over the entire frame. Require
  // both majority orange and near-global red dominance for this second path;
  // a warm subject beside neutral shadows or blue sky is not enough.
  const coherentMask = orangeFraction > .5 && all.fraction('maskRed') > .95;
  if ((orangeFraction > .72 || coherentMask)
      && all.quantile('r', .1) > all.quantile('b', .9) * .9) {
    return { filmType: 'color', confidence: 'medium', reason: 'orangeMask' };
  }
  // Camera white balance and the film base can tint a monochrome scan.
  // Require nearly all pixels to follow the same RGB ratios after a bounded
  // gain correction; low saturation alone also describes many colour scenes.
  const medians = ['r', 'g', 'b'].map(key => all.quantile(key, .5));
  const balance = Math.max(...medians) / Math.max(.02, Math.min(...medians));
  let coherentGray = false;
  if (balance < 1.6) {
    const mr = Math.max(.02, medians[0]), mg = Math.max(.02, medians[1]), mb = Math.max(.02, medians[2]);
    let coherent = 0;
    for (let n = 0; n < all.length; n++) {
      const cr = all.channel('r', n) / mr, cg = all.channel('g', n) / mg, cb = all.channel('b', n) / mb;
      if (Math.max(cr, cg, cb) - Math.min(cr, cg, cb) < .055) coherent++;
    }
    coherentGray = coherent / all.length > .96;
  }
  if (all.fraction('gray') > .96 || coherentGray) {
    // Two opposing thin rebates survive a tight crop, perforations and an
    // incomplete outer border. Include clipped clear film in this evidence.
    const clearSides = sides.map(pixels => pixels.length >= 16
      && pixels.quantile('luma', .8) - pixels.quantile('luma', .2) < .08
      && pixels.quantile('luma', .5) > .55
      && pixels.quantile('luma', .5) > innerLuma + .22);
    if ((clearSides[0] && clearSides[1]) || (clearSides[2] && clearSides[3])) {
      return { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' };
    }
    // A borderless grayscale positive and negative cannot be distinguished
    // reliably from colour statistics. Film scans are far more common here
    // than monochrome prints or digital images, so invert by default and keep
    // the uncertainty explicit (low confidence: review flag and a prompt).
    return { filmType: 'bw', confidence: 'low', reason: 'monochrome' };
  }
  if (orangeFraction > .35) return { filmType: fallback, confidence: 'low', reason: 'warmScene' };
  return { filmType: 'positive', confidence: 'medium', reason: 'noMask' };
}

// `detect` lets a caller supply a memoised detectFilmType(image) (same default options).
export function detectedImportSettings(image, { automatic = true, filmType = 'color', positiveMode = 'correct', detect = detectFilmType } = {}) {
  if (!automatic) return { filmType, positiveMode, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null };
  const detection = detect(image);
  return { filmType: detection.filmType, positiveMode, filmTypeSource: 'auto', filmTypeConfidence: detection.confidence, filmTypeReason: detection.reason };
}
