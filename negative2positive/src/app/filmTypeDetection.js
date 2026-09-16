// Pixel evidence is advisory: without a rebate/DX code, polarity is not
// uniquely recoverable (a grayscale positive and negative are both gray).
// Keep this bounded and independent of file names, camera metadata and format.
export function detectFilmType(image, { fallback = 'positive', filmEdge = null } = {}) {
  if (filmEdge?.found && ['color', 'bw', 'positive'].includes(filmEdge.filmKind)
      && !(filmEdge.polarity === 'light' && filmEdge.filmKind !== 'positive')) {
    return { filmType: filmEdge.filmKind, confidence: 'high', reason: 'dx' };
  }
  const source = image?.__image16 || image;
  if (!source?.data || !source.width || !source.height) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const { width, height, data } = source;
  const maximum = data instanceof Uint16Array ? 65535 : 255;
  const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 24000)));
  const all = [], inner = [], edge = [], sides = [[], [], [], []];
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    const i = (y * width + x) * 4;
    if (!data[i + 3]) continue;
    const r = data[i] / maximum, g = data[i + 1] / maximum, b = data[i + 2] / maximum;
    const peak = Math.max(r, g, b), low = Math.min(r, g, b);
    if (peak < .02) continue;
    const pixel = { r, g, b, luma: .2126 * r + .7152 * g + .0722 * b,
      gray: peak - low < .035,
      maskRed: r > g * 1.15 && r > b * 1.15,
      orange: r > g * 1.18 && g > b * 1.18 && r - b > .16 };
    if (x < width * .015) sides[0].push(pixel);
    if (x >= width * .985) sides[1].push(pixel);
    if (y < height * .015) sides[2].push(pixel);
    if (y >= height * .985) sides[3].push(pixel);
    // Clipped clear film helps polarity, but must not dilute orange-mask
    // statistics used by the existing colour-negative classifier.
    if (low > .98) continue;
    all.push(pixel);
    if (x < width * .05 || x >= width * .95 || y < height * .05 || y >= height * .95) edge.push(pixel);
    else inner.push(pixel);
  }
  if (all.length < 64) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const fraction = (pixels, key) => pixels.filter(p => p[key]).length / Math.max(1, pixels.length);
  const quantile = (pixels, key, q) => {
    const values = pixels.map(p => p[key]).sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * q)] ?? 0;
  };
  const edgeRange = quantile(edge, 'luma', .9) - quantile(edge, 'luma', .1);
  const edgeLuma = quantile(edge, 'luma', .5), innerLuma = quantile(inner, 'luma', .5);
  const orangeFraction = fraction(all, 'orange');
  // A uniform orange rebate substantially brighter than the image is stronger
  // evidence than a warm scene. Cropped scans still use whole-image mask evidence.
  if (edge.length >= 32 && fraction(edge, 'orange') > .85 && edgeRange < .14
      && edgeLuma > innerLuma + .07 && orangeFraction > .35) {
    return { filmType: 'color', confidence: 'high', reason: 'orangeRebate' };
  }
  // Subject colours can make a masked negative magenta instead of orange
  // (B >= G), even though the red mask remains over the entire frame. Require
  // both majority orange and near-global red dominance for this second path;
  // a warm subject beside neutral shadows or blue sky is not enough.
  const coherentMask = orangeFraction > .5 && fraction(all, 'maskRed') > .95;
  if ((orangeFraction > .72 || coherentMask)
      && quantile(all, 'r', .1) > quantile(all, 'b', .9) * .9) {
    return { filmType: 'color', confidence: 'medium', reason: 'orangeMask' };
  }
  // Camera white balance and the film base can tint a monochrome scan.
  // Require nearly all pixels to follow the same RGB ratios after a bounded
  // gain correction; low saturation alone also describes many colour scenes.
  const medians = ['r', 'g', 'b'].map(key => quantile(all, key, .5));
  const balance = Math.max(...medians) / Math.max(.02, Math.min(...medians));
  const coherentGray = balance < 1.6 && all.filter(p => {
    const channels = [p.r, p.g, p.b].map((v, i) => v / Math.max(.02, medians[i]));
    return Math.max(...channels) - Math.min(...channels) < .055;
  }).length / all.length > .96;
  if (fraction(all, 'gray') > .96 || coherentGray) {
    // Two opposing thin rebates survive a tight crop, perforations and an
    // incomplete outer border. Include clipped clear film in this evidence.
    const clearSides = sides.map(pixels => pixels.length >= 16
      && quantile(pixels, 'luma', .8) - quantile(pixels, 'luma', .2) < .08
      && quantile(pixels, 'luma', .5) > .55
      && quantile(pixels, 'luma', .5) > innerLuma + .22);
    if ((clearSides[0] && clearSides[1]) || (clearSides[2] && clearSides[3])) {
      return { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' };
    }
    // A borderless grayscale positive and negative cannot be distinguished
    // reliably from colour statistics. Keep the uncertainty explicit.
    return { filmType: fallback, confidence: 'low', reason: 'monochrome' };
  }
  if (orangeFraction > .35) return { filmType: fallback, confidence: 'low', reason: 'warmScene' };
  return { filmType: 'positive', confidence: 'medium', reason: 'noMask' };
}

export function detectedImportSettings(image, { automatic = true, filmType = 'color', positiveMode = 'correct' } = {}) {
  if (!automatic) return { filmType, positiveMode, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null };
  const detection = detectFilmType(image);
  return { filmType: detection.filmType, positiveMode, filmTypeSource: 'auto', filmTypeConfidence: detection.confidence, filmTypeReason: detection.reason };
}
